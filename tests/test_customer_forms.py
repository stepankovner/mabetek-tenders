import io
import unittest
import zipfile
from unittest.mock import patch

from agent.customer_forms import inspect_package, approved_values, W, X
from agent.procurement_documents import inspect
from agent.eis_documents import AttachmentLinks


def package(entries):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return out.getvalue()


def read(data, name):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return archive.read(name)


def word(rows):
    def cell(text):
        return f'<w:tc><w:tcPr/><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:tc>'
    content = "".join(f"<w:tr>{cell(label)}{cell(value)}</w:tr>" for label, value in rows)
    return f'<w:document xmlns:w="{W}"><w:body><w:tbl>{content}</w:tbl></w:body></w:document>'


class BuyerForms(unittest.TestCase):
    def test_known_rzd_draft_checks_original_before_requesting_worker_render(self):
        from agent.daemon import send_form
        terms = {"items":[{"service":"Погрузка","qty":"1","unit":"вагон","rate":"10"}], "lot":"100/3",
                 "terms":"По акту","dates":"5 декабря","validity":"4 декабря","vat":"НДС 20%"}
        job = {"id":2,"lease":"fixture"}
        conf = {"worker":"https://example.test","key":"fixture"}
        with patch("agent.daemon.verify_release", return_value=(False, {}, None)), \
                patch("agent.daemon.urllib.request.build_opener") as opener:
            send_form(conf, job, {"legacy":"rzd-word","terms":terms})
            opener.assert_not_called()
        with patch("agent.daemon.verify_release", return_value=(True, {}, None)), \
                patch("agent.daemon.urllib.request.build_opener") as opener:
            send_form(conf, job, {"legacy":"rzd-word","terms":terms})
            upload = opener.return_value.open.call_args.args[0]
            self.assertEqual(upload.full_url, "https://example.test/agent/form")
            self.assertNotIn(b'filename=', upload.data)
            self.assertIn(b'name="notes"', upload.data)

    def test_word_preserves_package_and_never_changes_existing_or_ambiguous_values(self):
        name = "word/document.xml"
        original = package({name: word([("Номер лота", "___"), ("Количество", ""), ("Количество", ""),
                                        ("Цена за единицу", "100"), ("Подпись", "___")]),
                            "word/styles.xml": b"<styles/>"})
        inventory, draft = inspect_package(original, ".docx", {"lot": "42", "qty": "8", "rate": "200", "manual": "Иван"})
        fields = [f["field"] for f in inventory if f["fillable"]]
        self.assertEqual(fields, ["lot"])
        self.assertIn(b">42</w:t>", read(draft, name))
        self.assertIn(b">100</w:t>", read(draft, name))
        self.assertNotIn(b">8</w:t>", read(draft, name))
        self.assertEqual(read(draft, "word/styles.xml"), b"<styles/>")
        self.assertEqual(read(original, name).count(b"_"), 6)

    def test_excel_keeps_style_formula_and_treats_values_as_text(self):
        name = "xl/worksheets/sheet1.xml"
        sheet = f'''<worksheet xmlns="{X}"><sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>Наименование услуги</t></is></c><c r="B1" s="6"/></row>
        <row r="2"><c r="A2" t="inlineStr"><is><t>Количество</t></is></c><c r="B2"><f>2+2</f><v>4</v></c></row>
        <row r="3"><c r="A3" t="inlineStr"><is><t>Цена за единицу</t></is></c><c r="C3"/></row>
        </sheetData></worksheet>'''
        inventory, output = inspect_package(package({name: sheet}), ".xlsx",
                                            {"service": "=2+5", "qty": "8", "rate": "600"})
        self.assertEqual([x["field"] for x in inventory if x["fillable"]], ["service"])
        xml = read(output, name)
        self.assertIn(b'r="B1" s="6" t="inlineStr"', xml)
        self.assertIn(b"<t>=2+5</t>", xml)
        self.assertIn(b"<f>2+2</f>", xml)
        self.assertNotIn(b"600", xml)

    def test_tax_exemption_does_not_become_numeric_vat(self):
        terms = dict(items=[dict(service="Погрузка",qty="1",unit="т",rate="300")], lot="123/4",
                     terms="По акту",dates="10 декабря",validity="1 декабря",vat="Без НДС")
        self.assertFalse(approved_values(terms)["vat_percent"])
        self.assertEqual(approved_values(dict(terms,vat="НДС 20%"))["vat_percent"],"20")

    def test_archive_with_macro_is_not_returned_as_draft(self):
        with self.assertRaises(ValueError):
            inspect_package(package({"word/document.xml": word([]), "word/vbaProject.bin": b"macro"}), ".docx")

    def test_eis_44_link_uses_official_scope_and_title(self):
        url = "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=" + "A" * 32
        parser = AttachmentLinks()
        parser.feed(f'<a title="Техническая часть.docx" href="{url}">Техническая часть</a>'
                    f'<a href="{url.replace("zakupki.gov.ru","example.test")}">Бланк.docx</a>')
        self.assertEqual(parser.links, {url:"Техническая часть.docx"})

    def test_manifest_changes_when_bytes_change_at_same_link_and_marks_unsupported_archive(self):
        links = [("Бланк.docx","https://example.test/p"),("Требования.7z","https://example.test/archive")]
        first = package({"word/document.xml":word([("Номер лота","")])})
        def file(url, limit):
            return first if url.endswith("/p") else b"version A"
        with patch("agent.procurement_documents.original",return_value=("html","url",links,file)):
            report,_=inspect("url")
        self.assertTrue(report["complete"])
        self.assertTrue(any("формат" in n for n in report["notes"]))
        self.assertEqual(report["forms"][0]["fields"][0]["field"],"lot")
        def revised(url, limit):
            return first if url.endswith("/p") else b"version B"
        with patch("agent.procurement_documents.original",return_value=("html","url",links,revised)):
            fresh,_=inspect("url",parse=False)
        self.assertNotEqual(report["digest"],fresh["digest"])
