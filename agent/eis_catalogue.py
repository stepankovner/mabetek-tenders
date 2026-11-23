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


def collect(registry, path, publish=None, *, targeted=False):
    first = read_page(registry)
    rejected = []
    cards = parse(first, registry, rejected=rejected)
    with closing(connection(path)) as db:
        db.execute("CREATE TABLE IF NOT EXISTS eis_cursor(registry TEXT PRIMARY KEY, next_page INTEGER NOT NULL)")
        result = ingest(db, cards)
        if publish is not None:
            try_publish(db, cards, publish, result, sample_nonmatches=True)
        cursor = db.execute("SELECT next_page FROM eis_cursor WHERE registry=?", (registry,)).fetchone()
        number = cursor[0] if cursor else 2
        next_page = 2
        rejected_extra = []
        if 'data-pagenumber="2"' in first:
            # Persist page one before fetching the continuation. Failed pages are retried next cycle.
            try:
                page = read_page(registry, number)
                marker = re.search(r'id="pageNumber"[^>]+value="(\d+)"', page)
                if not marker or int(marker[1]) != number:
                    raise ValueError("ЕИС не подтвердила номер страницы")
                extra = parse(page, registry, rejected=rejected_extra)
            except (OSError, ValueError) as error:
                result["reason"] = ("eis_pagination_404" if isinstance(error, HTTPError)
                                    and error.code == 404 else "eis_pagination_unavailable")
                if isinstance(error, HTTPError) and error.code == 429:
                    result["retry_after"] = retry_after(error.headers)
                return finish_collection(registry, path, publish, result, targeted)
            second = ingest(db, extra)
            if publish is not None:
                try_publish(db, extra, publish, result, sample_nonmatches=True)
            result["unique"] = len({card["procedure"] for card in cards + extra})
            result["inserted"] += second["inserted"]
            result["differences"].extend(second["differences"])
            if rejected_extra:
                next_page = number
            elif f'data-pagenumber="{number+1}"' in page:
                next_page = number + 1
        if rejected or rejected_extra:
            result["reason"] = "eis_unrecognized_rows"
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
    # Use a separate continuation for each query so a busy term cannot hide
    # rarer procurements behind the first 50 results of another query.
    if terms is None:
        terms = SEARCH_TERMS + (("7708503727",) if registry == "orders" else ())
    result = dict(unique=0, inserted=0, differences=[])
    cards = {}
    with closing(connection(path)) as db:
        db.execute("""CREATE TABLE IF NOT EXISTS eis_search_cursor(
            term TEXT PRIMARY KEY, next_page INTEGER NOT NULL)""")
        for term in terms:
            cursor_key = "publication:" + term
            row = db.execute("SELECT next_page FROM eis_search_cursor WHERE term=?", (cursor_key,)).fetchone()
            number = row[0] if row else 2
            for page_number in (1, number):
                try:
                    page = read_page(registry, page_number, term=term)
                    rejected = []
                    batch = parse(page, registry, rejected=rejected)
                except (OSError, ValueError) as error:
                    result["reason"] = "eis_search_incomplete"
                    if isinstance(error, HTTPError) and error.code == 429:
                        result["retry_after"] = retry_after(error.headers)
                    break
                new_cards = [card for card in batch if card["procedure"] not in cards]
                cards.update((card["procedure"], card) for card in new_cards)
                observed = ingest(db, new_cards)
                result["inserted"] += observed["inserted"]
                result["differences"].extend(observed["differences"])
                if rejected:
                    result["reason"] = "eis_search_incomplete"
                if page_number == 1 and number > 2 and f'data-pagenumber="{number}"' not in page:
                    # The first page only exposes nearby pages and the last
                    # page. Reset only if the total visibly shrank below us.
                    advertised = [int(n) for n in re.findall(r'data-pagenumber="(\d+)"', page)]
                    if max(advertised, default=1) < number:
                        with db:
                            db.execute("DELETE FROM eis_search_cursor WHERE term=?", (cursor_key,))
                        break
                if page_number == 1 and number == 2 and 'data-pagenumber="2"' not in page:
                    break
                if page_number == number and not rejected:
                    following = number + 1 if f'data-pagenumber="{number+1}"' in page else 2
                    with db:
                        db.execute("INSERT OR REPLACE INTO eis_search_cursor VALUES(?,?)", (cursor_key, following))
            if "retry_after" in result:
                break
        result["unique"] = len(cards)
        if publish is not None:
            try_publish(db, list(cards.values()), publish, result)
    return result
