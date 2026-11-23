import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from agent.eis_documents import review

BASE = "https://zakupki.gov.ru"
NUMBER = "32616611269"
CARD = {"url": BASE + "/epz/order/notice/notice223/common-info.html?regNumber=" + NUMBER,
        "documentsPage": BASE + "/epz/order/notice/notice223/documents.html?noticeGuid="
        "065fb6a1-f124-4aad-8251-e85321fad545&purchaseNoticeNumber=" + NUMBER}
FILE = BASE + "/223/filestore/public/1.0/download/fz223/file.html?uid=" + "A" * 32
PAGE = f'<div class="registry-entry__header-mid__number"><a>№ {NUMBER}</a></div>'


class EisDocumentReview(unittest.TestCase):
    def test_review_quotes_local_docx_and_ignores_wrong_domains(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as docx:
            docx.writestr("word/document.xml", b'<w:document xmlns:w="urn:test"><w:p><w:t>'
                          + "Место выполнения работ: Хабаровск, улица Ленина, 8.".encode()
                          + b'</w:t></w:p></w:document>')
        attachment = (f'<a href="{FILE}" data-tooltip=\'<span>Техническое задание.docx</span>\'>'
                      'Техническое задание</a>')
        page = PAGE + attachment + attachment.replace("zakupki.gov.ru", "example.test")
        with tempfile.TemporaryDirectory() as folder, \
                patch("agent.eis_documents.read_html", return_value=(page, CARD["documentsPage"])), \
                patch("agent.eis_documents.fetch_attachment", return_value=buffer.getvalue()) as download:
            result = review(CARD, Path(folder))
            self.assertIn("Техническое задание.docx, абзац 1", result)
            self.assertIn("Хабаровск", result)
            self.assertEqual(download.call_count, 1)
            self.assertEqual(download.call_args.args[0], FILE)
            self.assertEqual(len(list(Path(folder).rglob("*.json"))), 1)

    def test_wrong_notice_stops_before_file_fetch(self):
        with patch("agent.eis_documents.read_html", return_value=(PAGE.replace(NUMBER, "32616611268"),
                   CARD["documentsPage"])), patch("agent.eis_documents.fetch_attachment") as download:
            with self.assertRaises(ValueError):
                review(CARD, Path("."))
            self.assertIn("подтвердить", review(dict(CARD, documentsPage=CARD["documentsPage"].replace(
                NUMBER, "32616611268")), Path(".")))
            download.assert_not_called()
