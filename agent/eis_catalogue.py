"""Read the two public EIS registries with a trust context restricted to the EIS host."""
import html
import http.cookiejar
import re
import ssl
import urllib.request
import threading
from contextlib import closing
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from itertools import chain
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin

from .eat_import import ingest, try_publish
from .local import connection
from .sources import NoRedirect, retry_after

HOST = "https://zakupki.gov.ru"
REGISTRIES = {
    "orders": "/epz/order/extendedsearch/results.html",
    "price_requests": "/epz/pricereq/search/results.html",
}
SEARCH_TERMS = ("выгрузка вагонов", "железнодорожный тупик", "перевалка",
                "ответственное хранение", "погрузочно-разгрузочные работы")
NOTICE = re.compile(r"https://zakupki\.gov\.ru/(?:(?:epz/order/notice/[a-z0-9]+/(?:view/)?common-info\.html|223/purchase/public/purchase/info/common-info\.html)\?regNumber=(\d{11}|\d{19})|epz/pricereq/card/common-info\.html\?reestrNumber=(\d{19}))")
ACTIVE = {"подача заявок", "подача предложений", "подача заявок на участие"}
BLOCK = re.compile(r'<div\s+class="search-registry-entry-block\b[^"]*">')
LIMIT = 4_000_000
_session = threading.local()
# The public EIS frontend serves pagination to browser-compatible sessions.
# Keep cookies in memory, separately for each collector thread, on this host only.
BROWSER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'


def public_session():
    if not hasattr(_session, 'opener'):
        tls = ssl.create_default_context(cafile=str(Path(__file__).with_name('eis-root.pem')))
        _session.opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
            urllib.request.HTTPSHandler(context=tls))
        _session.opener.addheaders = [('User-Agent', BROWSER_AGENT), ('Accept', 'text/html')]
    return _session.opener


def text(fragment):
    # EIS highlights word stems, so these inline tags may sit inside a word.
    fragment = re.sub(r"<\s*/?\s*span\b[^>]*>", "", fragment, flags=re.I)
    return " ".join(html.unescape(re.sub("<[^>]+>", " ", fragment)).split())


def field(block, class_name):
    match = re.search(r'<(div|span)\b[^>]*class="' + re.escape(class_name) +
                      r'(?:\s[^"]*)?"[^>]*>(.*?)</\1>', block, re.S)
    if not match:
        raise ValueError("Изменилась разметка ЕИС: " + class_name)
    return text(match[2])


def original_number(url, registry):
    match = NOTICE.fullmatch(url)
    return match[1 if registry == "orders" else 2] if match else None


def read_card(block, registry):
    number = field(block, "registry-entry__header-mid__number").removeprefix("№").strip()
    link = re.search(r'class="registry-entry__header-mid__number"[^>]*>\s*<a\b[^>]*href="([^"]+)"', block)
    url = urljoin(HOST, html.unescape(link[1])) if link else ""
    if original_number(url, registry) != number:
        raise ValueError("Номер оригинала ЕИС не совпал с выдачей")
    status = field(block, "registry-entry__header-mid__title")
    if status.casefold() == "определение поставщика завершено":
        # EIS may omit the subject of a completed procedure. Its original
        # number still counts as a recognized row, so pagination can advance.
        return dict(procedure=number, status=status)
    title = field(block, "registry-entry__body-value")
    if not status or not title:
        raise ValueError("Нет предмета или статуса закупки ЕИС")
    return dict(source="eis-" + registry, procedure=number, lot="процедура",
                url=url, title=title, status=status)


def past_catalogue_deadline(block, registry, day):
    label = "Окончание подачи заявок" if registry == "orders" else "Предоставление ценовой информации"
    match = re.search(r'<div class="data-block__title(?:\s[^"]*)?">\s*' + label +
                      r'\s*</div>\s*<div class="data-block__value(?:\s[^"]*)?">(.*?)</div>', block, re.S)
    if not match:
        return False
    dates = re.findall(r'\b\d{2}\.\d{2}\.\d{4}\b', text(match[1]))
    expected = 1 if registry == "orders" else 2
    if len(dates) != expected:
        return False
    try:
        return datetime.strptime(dates[-1], "%d.%m.%Y").date() < day
    except ValueError:
        return False


def parse(page, registry, *, rejected=None, today=None):
    parts = BLOCK.split(page)[1:]
    if not parts:
        if re.search(r'<p class="noRecords">\s*Поиск не дал результатов\s*</p>', page):
            return []
        raise ValueError("ЕИС не вернула распознаваемые карточки")
    cards = []
    seen = set()
    if today is None:
        # Dates in the catalogue have no zone. Use a conservative cutoff so
        # a date that's still current in the customer's zone is never dropped.
        today = (datetime.now(timezone.utc) - timedelta(hours=12)).date()
    for block in parts:
        try:
            card = read_card(block, registry)
            if card["procedure"] in seen:
                raise ValueError("Номер оригинала ЕИС повторился")
        except ValueError as error:
            if rejected is None:
                raise
            rejected.append(str(error))
            continue
        seen.add(card["procedure"])
        if card["status"].casefold() in ACTIVE and not past_catalogue_deadline(block, registry, today):
            cards.append(card)
    if not seen:
        raise ValueError("ЕИС не вернула ни одной распознанной карточки")
    return cards


def read_html(url, procedure=None):
    # The trust context and any redirect stay on the EIS host.
    from urllib.parse import urlsplit
    if urlsplit(url).scheme != 'https' or urlsplit(url).netloc != 'zakupki.gov.ru':
        raise ValueError('Требуется официальный HTTPS-адрес ЕИС')
    opener = public_session()
    try:
        response = opener.open(url, timeout=22)
    except HTTPError as error:
        location = error.headers.get("Location", "") if error.headers else ""
        target = urljoin(url, location) if location else ""
        if (procedure is None or error.code not in (301, 302, 307, 308)
                or target == url or original_number(target, "orders") != procedure):
            raise
        error.close()
        response = opener.open(target, timeout=22)
    with response:
        raw = response.read(LIMIT + 1)
        if len(raw) > LIMIT or response.headers.get_content_type() != "text/html":
            raise ValueError("Некорректная страница реестра ЕИС")
    return raw.decode("utf-8"), response.url


def read_page(registry, number=1, *, term=None):
    url = HOST + REGISTRIES[registry]
    if term is not None:
        params = dict(searchString=term, pageNumber=number, recordsPerPage="_50", morphology="on",
                      sortBy="PUBLISH_DATE", sortDirection="false")
        if registry == "orders":
            params["af"] = "on"
        url += "?" + urlencode(params)
    elif number > 1:
        url += "?pageNumber=" + str(number)
    page = read_html(url)[0]
    if term is not None:
        class SearchForm(HTMLParser):
            def __init__(self):
                super().__init__()
                self.values = {}

            def handle_starttag(self, tag, attrs):
                if tag == "input":
                    fields = dict(attrs)
                    if fields.get("id") in ("searchString", "pageNumber"):
                        self.values[fields["id"]] = fields.get("value")

        form = SearchForm()
        form.feed(page)
        if form.values != {"searchString": term, "pageNumber": str(number)}:
            raise ValueError("ЕИС не подтвердила запрос или страницу")
    return page


def read_order(url):
    procedure = original_number(url, "orders")
    if not procedure:
        raise ValueError("Требуется ссылка на извещение ЕИС")
    page, target = read_html(url, procedure)
    if len(page) > 3_000_000:
        raise ValueError("Оригинал ЕИС превышает лимит передачи")
    return page, target


def advertised_pages(page):
    return {int(number) for number in re.findall(r'data-pagenumber="(\d+)"', page)}


def continuation_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS eis_page_gaps (
        stream TEXT NOT NULL, page INTEGER NOT NULL, due INTEGER NOT NULL,
        PRIMARY KEY(stream,page))""")


def continuation(db, stream, cursor, first, *, start=2):
    last = max(advertised_pages(first), default=1)
    # The first page includes a link to the last page where EIS paginates.
    with db:
        db.execute("DELETE FROM eis_page_gaps WHERE stream=? AND page>?", (stream, last))
    if last < start:
        return None, last, False
    cursor = cursor if start <= cursor <= last else start
    retry = db.execute("""SELECT page FROM eis_page_gaps WHERE stream=? AND page>=?
        AND due<=unixepoch() ORDER BY due,page LIMIT 1""", (stream, start)).fetchone()
    if retry:
        return retry[0], last, False
    blocked = {row[0] for row in db.execute("SELECT page FROM eis_page_gaps WHERE stream=?", (stream,))}
    for number in chain(range(cursor, last + 1), range(start, cursor)):
        if number not in blocked:
            return number, last, True
    return None, last, False


def record_page(db, stream, number, failed):
    with db:
        if failed:
            db.execute("""INSERT INTO eis_page_gaps VALUES(?,?,unixepoch()+3600)
                ON CONFLICT(stream,page) DO UPDATE SET due=excluded.due""", (stream, number))
        else:
            db.execute("DELETE FROM eis_page_gaps WHERE stream=? AND page=?", (stream, number))


def fetch_continuation(registry, number, *, term=None):
    page = read_page(registry, number) if term is None else read_page(registry, number, term=term)
    if term is None:
        marker = re.search(r'id="pageNumber"[^>]+value="(\d+)"', page)
        if not marker or int(marker[1]) != number:
            raise ValueError("ЕИС не подтвердила номер страницы")
    rejected = []
    cards = parse(page, registry, rejected=rejected)
    return cards, bool(rejected)


def collect(registry, path, publish=None, *, targeted=False):
    rejected = []
    try:
        first = read_page(registry)
        cards = parse(first, registry, rejected=rejected)
    except (OSError, ValueError) as error:
        if not targeted or isinstance(error, HTTPError) and error.code == 429:
            raise
        result = dict(unique=0, inserted=0, differences=[], reason="eis_first_page_unavailable")
        return finish_collection(registry, path, publish, result, targeted)
    with closing(connection(path)) as db:
        continuation_schema(db)
        db.execute("CREATE TABLE IF NOT EXISTS eis_cursor(registry TEXT PRIMARY KEY, next_page INTEGER NOT NULL)")
        result = ingest(db, cards)
        if publish is not None:
            try_publish(db, cards, publish, result, sample_nonmatches=True)
        cursor = db.execute("SELECT next_page FROM eis_cursor WHERE registry=?", (registry,)).fetchone()
        position = cursor[0] if cursor else 3
        number, last, advance = continuation(db, registry, position, first, start=3)
        next_page = position if 3 <= position <= last else 3
        pages = ([2] if last >= 2 else []) + ([number] if number is not None else [])
        known = {card["procedure"] for card in cards}
        for current in pages:
            try:
                extra, partial = fetch_continuation(registry, current)
            except (OSError, ValueError) as error:
                result["reason"] = ("eis_pagination_404" if isinstance(error, HTTPError)
                                    and error.code == 404 else "eis_pagination_unavailable")
                if isinstance(error, HTTPError) and error.code == 429:
                    result["retry_after"] = retry_after(error.headers)
                    break
                partial = True
            else:
                fresh = [card for card in extra if card["procedure"] not in known]
                known.update(card["procedure"] for card in fresh)
                observed = ingest(db, fresh)
                if publish is not None:
                    try_publish(db, fresh, publish, result, sample_nonmatches=True)
                result["inserted"] += observed["inserted"]
                result["differences"].extend(observed["differences"])
                if partial:
                    result.setdefault("reason", "eis_unrecognized_rows")
            record_page(db, registry, current, partial)
            if current == number and (advance or current == next_page):
                next_page = current + 1 if current < last else 3
        result["unique"] = len(known)
        if rejected:
            result.setdefault("reason", "eis_unrecognized_rows")
        if db.execute("SELECT 1 FROM eis_page_gaps WHERE stream=? LIMIT 1", (registry,)).fetchone():
            result.setdefault("reason", "eis_pagination_gaps")
        with db:
            db.execute("INSERT OR REPLACE INTO eis_cursor VALUES(?,?)", (registry, next_page))
    return finish_collection(registry, path, publish, result, targeted)


def finish_collection(registry, path, publish, result, targeted):
    if targeted and "retry_after" not in result:
        search = collect_search(registry, path, publish)
        result["search_unique"] = search["unique"]
        result["inserted"] += search["inserted"]
        result["differences"].extend(search["differences"])
        for key in ("reason", "retry_after", "publication_pending"):
            if key in search and key not in result:
                result[key] = search[key]
    return result


def collect_search(registry, path, publish=None, *, terms=None):
    # A failed continuation is retried separately from the forward cursor.
    if terms is None:
        terms = SEARCH_TERMS + (("7708503727",) if registry == "orders" else ())
    result = dict(unique=0, inserted=0, differences=[])
    cards = {}
    with closing(connection(path)) as db:
        continuation_schema(db)
        db.execute("""CREATE TABLE IF NOT EXISTS eis_search_cursor(
            term TEXT PRIMARY KEY, next_page INTEGER NOT NULL)""")
        for term in terms:
            cursor_key = "publication:" + term
            stream = registry + "/" + cursor_key
            row = db.execute("SELECT next_page FROM eis_search_cursor WHERE term=?", (cursor_key,)).fetchone()
            cursor = row[0] if row else 2
            number = 1
            while number is not None:
                rejected = []
                try:
                    page = read_page(registry, number, term=term)
                    batch = parse(page, registry, rejected=rejected)
                except (OSError, ValueError) as error:
                    result["reason"] = "eis_search_incomplete"
                    if isinstance(error, HTTPError) and error.code == 429:
                        result["retry_after"] = retry_after(error.headers)
                    elif number > 1:
                        record_page(db, stream, number, True)
                        if advance or cursor == number:
                            cursor = number + 1 if number < last else 2
                    break
                new_cards = [card for card in batch if card["procedure"] not in cards]
                cards.update((card["procedure"], card) for card in new_cards)
                observed = ingest(db, new_cards)
                result["inserted"] += observed["inserted"]
                result["differences"].extend(observed["differences"])
                if rejected:
                    result["reason"] = "eis_search_incomplete"
                if number == 1:
                    number, last, advance = continuation(db, stream, cursor, page)
                    if cursor > last:
                        cursor = 2
                else:
                    record_page(db, stream, number, bool(rejected))
                    if advance or cursor == number:
                        cursor = number + 1 if number < last else 2
                    break
            with db:
                db.execute("INSERT OR REPLACE INTO eis_search_cursor VALUES(?,?)", (cursor_key, cursor))
            if db.execute("SELECT 1 FROM eis_page_gaps WHERE stream=? LIMIT 1", (stream,)).fetchone():
                result.setdefault("reason", "eis_pagination_gaps")
            if "retry_after" in result:
                break
        result["unique"] = len(cards)
        if publish is not None:
            try_publish(db, list(cards.values()), publish, result)
    return result
