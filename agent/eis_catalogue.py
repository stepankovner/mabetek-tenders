"""Read the two public EIS registries with a trust context restricted to the EIS host."""
import html
import re
import ssl
import urllib.request
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin

from .eat_import import ingest, publish_candidates
from .local import connection
from .sources import NoRedirect, retry_after

HOST = "https://zakupki.gov.ru"
REGISTRIES = {
    "orders": "/epz/order/extendedsearch/results.html",
    "price_requests": "/epz/pricereq/search/results.html",
}
NOTICE = re.compile(r"https://zakupki\.gov\.ru/(?:(?:epz/order/notice/[a-z0-9]+/(?:view/)?common-info\.html|223/purchase/public/purchase/info/common-info\.html)\?regNumber=(\d{11}|\d{19})|epz/pricereq/card/common-info\.html\?reestrNumber=(\d{19}))")
ACTIVE = {"подача заявок", "подача предложений", "подача заявок на участие"}
BLOCK = re.compile(r'<div\s+class="search-registry-entry-block\b[^"]*">')
LIMIT = 4_000_000


def text(fragment):
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


def parse(page, registry, *, rejected=None):
    parts = BLOCK.split(page)[1:]
    if not parts:
        raise ValueError("ЕИС не вернула распознаваемые карточки")
    cards = []
    seen = set()
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
        if card["status"].casefold() in ACTIVE:
            cards.append(card)
    if not seen:
        raise ValueError("ЕИС не вернула ни одной распознанной карточки")
    return cards


def read_html(url, procedure=None):
    # The trust context and any redirect stay on the EIS host.
    tls = ssl.create_default_context(cafile=str(Path(__file__).with_name("eis-root.pem")))
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=tls))
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


def read_page(registry, number=1):
    url = HOST + REGISTRIES[registry]
    if number > 1:
        url += "?pageNumber=" + str(number)
    return read_html(url)[0]


def read_order(url):
    procedure = original_number(url, "orders")
    if not procedure:
        raise ValueError("Требуется ссылка на извещение ЕИС")
    page, target = read_html(url, procedure)
    if len(page) > 3_000_000:
        raise ValueError("Оригинал ЕИС превышает лимит передачи")
    return page, target


def collect(registry, path, publish=None):
    first = read_page(registry)
    rejected = []
    cards = parse(first, registry, rejected=rejected)
    with closing(connection(path)) as db:
        db.execute("CREATE TABLE IF NOT EXISTS eis_cursor(registry TEXT PRIMARY KEY, next_page INTEGER NOT NULL)")
        result = ingest(db, cards)
        if publish is not None:
            publish_candidates(db, cards, publish, sample_nonmatches=True)
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
                return result
            second = ingest(db, extra)
            if publish is not None:
                publish_candidates(db, extra, publish, sample_nonmatches=True)
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
    return result
