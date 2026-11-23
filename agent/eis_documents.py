"""Read attachments linked from a verified public EIS 223-FZ document tab."""

import re
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urljoin, urlsplit

from .eis_catalogue import HOST, original_number, public_session, read_html
from .rzd_documents import review_attachments

GUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", re.I)
FILE = re.compile(
    r"https://zakupki\.gov\.ru/223/filestore/public/1\.0/download/fz223/file\.html\?uid=[A-Fa-f0-9]{32}"
)
NUMBER = re.compile(
    r'<div class="registry-entry__header-mid__number">\s*<a\b[^>]*>\s*№\s*(\d{11})\s*</a>',
    re.S,
)


class AttachmentLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = {}
        self.current = None

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        values = dict(attrs)
        url = urljoin(HOST, values.get("href") or "")
        self.current = (url, values.get("data-tooltip") or "", []) if FILE.fullmatch(url) else None

    def handle_data(self, data):
        if self.current is not None:
            self.current[2].append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.current is not None:
            url, tooltip, fragments = self.current
            # Some displayed labels omit the extension. The tooltip carries
            # the actual filename, without requiring a speculative download.
            name = re.sub("<[^>]*>", "", tooltip).strip() or " ".join("".join(fragments).split())
            if name:
                self.links.setdefault(url, name)
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


def review(card, cache):
    procedure = original_number(card["url"], "orders")
    url = card.get("documentsPage") or ""
    parts = urlsplit(url)
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    fields = dict(pairs)
    if (not procedure or len(procedure) != 11 or parts.scheme != "https"
            or parts.netloc != "zakupki.gov.ru" or parts.fragment
            or parts.path != "/epz/order/notice/notice223/documents.html"
            or len(pairs) != 2 or fields.get("purchaseNoticeNumber") != procedure
            or not GUID.fullmatch(fields.get("noticeGuid", ""))):
        return "Вкладку с приложениями этого извещения не удалось подтвердить."
    page, final = read_html(url)
    if final != url or set(NUMBER.findall(page)) != {procedure}:
        raise ValueError("ЕИС вернула документы другого извещения")
    links = AttachmentLinks()
    links.feed(page)
    attachments = [(name, link) for link, name in links.links.items()]
    return review_attachments(attachments, cache / ("eis-" + procedure), fetch_attachment, limit=4)
