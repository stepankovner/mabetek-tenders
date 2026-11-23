"""Read attachments linked from a verified public EIS 223-FZ document tab."""

import re
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urljoin, urlsplit

from .eis_catalogue import HOST, original_number, public_session, read_html
from .rzd_documents import review_attachments

GUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", re.I)
FILE = re.compile(
    r"https://zakupki\.gov\.ru/(?:223/filestore/public/1\.0/download/fz223|44fz/filestore/public/1\.0/download/priz)"
    r"/file\.html\?uid=[A-Fa-f0-9]{32}"
)
NUMBER = re.compile(
    r'<div class="registry-entry__header-mid__number">\s*<a\b[^>]*>\s*№\s*(\d{11})\s*</a>',
    re.S,
)
NUMBER44 = re.compile(
    r'<span\b[^>]*class="cardMainInfo__purchaseLink(?:\s[^"]*)?"[^>]*>\s*(?:<a\b[^>]*>\s*)?№\s*(\d{19})\s*(?:</a>\s*)?</span>',
    re.S,
)


def documents_url(url, original_url):
    procedure = original_number(original_url, "orders")
    if not procedure:
        return False
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.netloc != "zakupki.gov.ru" or parts.fragment:
        return False
    fields = dict(parse_qsl(parts.query, keep_blank_values=True))
    if len(procedure) == 19:
        return (parts.path == urlsplit(original_url).path.replace("common-info.html", "documents.html")
                and parts.query == "regNumber=" + procedure)
    return (parts.path == "/epz/order/notice/notice223/documents.html"
            and len(parse_qsl(parts.query, keep_blank_values=True)) == 2
            and fields.get("purchaseNoticeNumber") == procedure
            and bool(GUID.fullmatch(fields.get("noticeGuid", ""))))


class AttachmentLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = {}
        self.current = None
        self.unrecognized_download = False

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        values = dict(attrs)
        url = urljoin(HOST, values.get("href") or "")
        if (urlsplit(url).netloc == "zakupki.gov.ru" and not FILE.fullmatch(url)
                and ("/filestore/" in url or "download" in values)):
            self.unrecognized_download = True
        self.current = (url, values.get("title") or values.get("data-tooltip") or "", []) if FILE.fullmatch(url) else None

    def handle_data(self, data):
        if self.current is not None:
            self.current[2].append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.current is not None:
            url, tooltip, fragments = self.current
            # Some displayed labels omit the extension. The tooltip carries
            # the actual filename, without requiring a speculative download.
            name = re.sub("<[^>]*>", "", tooltip).strip() or " ".join("".join(fragments).split())
            self.links.setdefault(url, name or "Вложение без названия")
            self.current = None


def fetch_attachment(url, limit):
    if not FILE.fullmatch(url):
        raise ValueError("Недопустимый адрес файла ЕИС")
    with public_session().open(url, timeout=8) as response:
        if response.headers.get_content_type() == "text/html":
            raise ValueError("ЕИС вернула страницу вместо файла")
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Лимит размера документа")
    return data


def list_documents(card):
    procedure = original_number(card["url"], "orders")
    url = card.get("documentsPage") or ""
    if not documents_url(url, card["url"]):
        raise ValueError("Вкладку с приложениями этого извещения не удалось подтвердить.")
    page, final = read_html(url)
    number = NUMBER44 if len(procedure) == 19 else NUMBER
    if final != url or set(number.findall(page)) != {procedure}:
        raise ValueError("ЕИС вернула документы другого извещения")
    links = AttachmentLinks()
    links.feed(page)
    if links.unrecognized_download:
        raise ValueError("ЕИС вернула неподдерживаемый адрес файла")
    return [(name, link) for link, name in links.links.items()]


def review(card, cache):
    if not documents_url(card.get("documentsPage") or "", card["url"]):
        return "Вкладку с приложениями этого извещения не удалось подтвердить."
    procedure = original_number(card["url"], "orders")
    attachments = list_documents(card)
    return review_attachments(attachments, cache / ("eis-" + procedure), fetch_attachment, limit=4)
