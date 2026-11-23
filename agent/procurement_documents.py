"""Verified originals, content fingerprints, citations and customer form inventory."""
import hashlib
import io
import json
import re
import tempfile
import time
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urljoin

from . import eis_catalogue, eis_documents, rzd_documents
from .customer_forms import FORM_NAME, inspect_package
from .pipeline import extract
from .sources import fetch_lot_card

MAX_ATTACHMENTS = 12
TOTAL_BYTES = 40 * 1024 * 1024


class OriginalLinks(HTMLParser):
    def __init__(self, url):
        super().__init__()
        self.url = url
        self.documents = set()

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            # Some official links contain an unescaped "&noticeGuid", which
            # HTMLParser otherwise treats as the named entity "&not".
            raw = re.search(r'''\bhref\s*=\s*(["'])(.*?)\1''', self.get_starttag_text(), re.I | re.S)
            href = urljoin(self.url, raw[2].replace("&amp;", "&") if raw else "")
            if eis_documents.documents_url(href, self.url):
                self.documents.add(href)


def original(url):
    if eis_catalogue.original_number(url, "orders"):
        html, resolved = eis_catalogue.read_order(url)
        links = OriginalLinks(resolved)
        links.feed(html)
        if len(links.documents) != 1:
            return html, resolved, [], None
        try:
            files = eis_documents.list_documents({"url": resolved, "documentsPage": next(iter(links.documents))})
        except (OSError, ValueError):
            return html, resolved, [], None
        return html, resolved, files, eis_documents.fetch_attachment
    if re.fullmatch(r"https://rzd\.rts-tender\.ru/TenderInterests/LogViewAndRedirect\?tenderId=\d{1,16}&tenderStatus=RTS_Notification", url):
        html = rzd_documents.fetch(url, 3_000_000).decode("utf-8")
        try:
            links = rzd_documents.attachment_links(html, strict=True)
        except ValueError:
            return html, url, [], None
        return html, url, links, rzd_documents.fetch
    return fetch_lot_card(url), url, [], None


def fingerprint(rows):
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def inspect(url, *, parse=True, selected=None, values=None):
    """Hash every listed file within one explicit budget; parsing is advisory."""
    started = time.monotonic()
    html, resolved, links, fetch = original(url)
    report = dict(html=html, url=resolved, files=[], places=[], services=[], forms=[], notes=[],
                  complete=bool(fetch), parsed=False)
    if fetch is None:
        report["notes"].append("Оригинал получен, но вкладку с приложениями не удалось подтвердить.")
    if len(links) > MAX_ATTACHMENTS:
        report["complete"] = False
        report["notes"].append(f"Проверены не все приложения: лимит {MAX_ATTACHMENTS} из {len(links)}.")
    remaining = TOTAL_BYTES
    output = None
    with tempfile.TemporaryDirectory() as directory:
        for name, link in sorted(links, key=lambda item: (item[1], item[0]))[:MAX_ATTACHMENTS]:
            name = Path(name.replace("\\", "/")).name[:220]
            suffix = Path(name).suffix.lower()
            row = dict(name=name, url=link, sha256=None)
            report["files"].append(row)
            if remaining <= 0 or time.monotonic() - started >= 120:
                report["complete"] = False
                report["notes"].append("Исчерпан бюджет проверки приложений.")
                break
            try:
                data = fetch(link, min(remaining, rzd_documents.MAX_BYTES))
            except (OSError, ValueError):
                report["complete"] = False
                report["notes"].append(f"{name}: файл не удалось получить целиком.")
                continue
            remaining -= len(data)
            row["sha256"] = hashlib.sha256(data).hexdigest()
            if not rzd_documents.EXT.search(name):
                if parse:
                    report["notes"].append(f"{name}: формат для разбора пока не поддерживается.")
                    if FORM_NAME.search(name):
                        report["forms"].append(dict(name=name, url=link, sha256=row["sha256"], fields=[]))
                continue
            if not parse and selected != link:
                continue
            if suffix in (".docx", ".xlsx") and (parse or selected == link):
                try:
                    fields, filled = inspect_package(data, suffix, values if selected == link else None)
                    if fields or FORM_NAME.search(name):
                        report["forms"].append(dict(name=name, url=link, sha256=row["sha256"], fields=fields))
                    if selected == link and filled:
                        output = (name, filled)
                except Exception:
                    if selected == link:
                        report["notes"].append(f"{name}: структуру бланка не удалось безопасно заполнить.")
            if not parse:
                continue
            target = Path(directory) / ("document" + suffix)
            target.write_bytes(data)
            try:
                extracted = extract(target)
            except Exception:
                report["notes"].append(f"{name}: текст не удалось прочитать.")
                continue
            report["parsed"] = True
            rows = []
            for fragment in extracted:
                for line in fragment["text"].splitlines():
                    line = " ".join(line.split())
                    if line:
                        rows.append({**fragment, "file": name, "text": line})
            # Record quotations with original file and location. A location of
            # the customer and generic contact details never count as worksite.
            for line in rzd_documents.summarize(rows).splitlines():
                if len(report["places"]) < 16:
                    report["places"].append(dict(file=name, quote=line[:360]))
            for fragment in rows:
                line = fragment["text"]
                if (not fragment.get("ocr") and re.match(
                        r"^(?:[\d.]+\s*)?(?:предмет (?:договора|закупки)|наименование (?:работ|услуг)|"
                        r"перечень (?:работ|услуг)|исполнитель (?:обязуется|должен)|оказание услуг по)\b", line, re.I)
                        and len(report["services"]) < 20):
                    report["services"].append(dict(file=name, quote=line[:300],
                                                   location=fragment["location"]))
            hints = rzd_documents.form_evidence(rows)
            if hints:
                report["notes"].append(hints[:1200])
            requirements = [f'{name}, {fragment["location"]}: {fragment["text"][:210]}' for fragment in rows
                            if re.search(r"обязательн\w* (?:пол[еяй]|к заполнению)|"
                                         r"(?:участник|поставщик) (?:обязан указать|должен заполнить)|"
                                         r"поля,? отмеченные", fragment["text"], re.I)]
            if requirements:
                report["notes"].extend(dict.fromkeys(requirements[:3]))
    report["forms"] = report["forms"][:10]
    report["notes"] = list(dict.fromkeys(report["notes"]))[:12]
    report["digest"] = fingerprint([list(row.values()) for row in report["files"]]) if report["complete"] else None
    return report, output
