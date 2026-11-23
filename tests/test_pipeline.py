import importlib
import io
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]

class Contracts(unittest.TestCase):
    def feature(self, name):
        try:
            module = importlib.import_module("agent.pipeline")
        except ModuleNotFoundError:
            module = None
        fn = getattr(module, name, None)
        self.assertTrue(callable(fn), f"Отсутствует операция {name}")
        return fn

    def test_filter(self):
        classify = self.feature("classify")
        for title, place, expected in [
            ("Аренда ж/д тупика","г. Хабаровск","рассмотреть"),
            ("Приём полувагонов на площадке исполнителя","Хабаровск","рассмотреть"),
            ("Погрузочно-разгрузочные работы","Хабаровск","рассмотреть"),
            ("Услуги по разгрузке вагонов","","нужно уточнение"),
            ("Поставка погрузочно-разгрузочного оборудования","Хабаровск","недостаточно исходных данных"),
            ("Перевозка мебели без учета погрузочно-разгрузочных работ","Хабаровск","недостаточно исходных данных"),
            ("Аренда тупика без погрузочно-разгрузочных работ","Хабаровск","рассмотреть"),
            ("Ремонт путей","Хабаровск","отклонить"),
            ("Закупка вагонов","Хабаровск","отклонить"),
            ("Постановка вагонов","Ванино","отклонить"),
            ("Постановка вагонов","","нужно уточнение"),
            ("Приёмка с железнодорожного транспорта и перевозка топлива","Хабаровск","нужно уточнение"),
            ("Комплекс услуг","","недостаточно исходных данных"),
        ]:
            with self.subTest(title=title,place=place):
                self.assertEqual(classify(title,place)[0],expected)

    def test_quote(self):
        quote = self.feature("quote")
        data = dict(customer="Получатель", lot="42/1", vat="без НДС", terms="Оплата после акта",
                    dates="1 декабря", validity="до 25 ноября", confirmed=True,
                    items=[dict(service="Выгрузка",qty="1.5",unit="т",rate="3.33")])
        self.assertEqual(quote(data)["total"], "5.00")
        for field in ("vat","customer","confirmed","items"):
            with self.subTest(field=field), self.assertRaises(ValueError):
                quote({k:v for k,v in data.items() if k != field})
        with self.assertRaises(ValueError):
            quote(dict(data,items=[{"service":"Аренда","qty":"2","unit":"ч","initial_price":"10"}]))

    def test_document(self):
        extract=self.feature("extract")
        with tempfile.TemporaryDirectory() as td:
            doc=Path(td)/"test.docx"
            with zipfile.ZipFile(doc,"w") as z:
                z.writestr("word/document.xml",'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Место исполнения: Хабаровск</w:t></w:r></w:p></w:document>')
            rows=extract(doc)
            self.assertIn("Хабаровск",rows[0]["text"])
            self.assertEqual(rows[0]["location"],"абзац 1")
            bad=Path(td)/"bad.zip"
            with zipfile.ZipFile(bad,"w") as z: z.writestr("../bad","123")
            with self.assertRaises(ValueError): extract(bad)

    def test_schema(self):
        db=sqlite3.connect(":memory:")
        for file in sorted((ROOT/"migrations").glob("*.sql")): db.executescript(file.read_text())
        tables={x[0] for x in db.execute("select name from sqlite_master where type='table'")}
        self.assertFalse({"sources","lots","versions","answers","jobs","outbox","sessions","updates","profile","evidence","documents","offers","links"}-tables)

    def test_pdf(self):
        import pymupdf
        render=self.feature("render")
        with tempfile.TemporaryDirectory() as td:
            out=Path(td)/"offer.pdf"
            render(dict(customer="Пример",lot="42/1",vat="без НДС",terms="После акта",dates="1 декабря",validity="До 25 ноября",confirmed=True,items=[dict(service="Выгрузка",qty="2",unit="т",rate="3.33")]),out,demo=True)
            with pymupdf.open(out) as d:
                text=" ".join(p.get_text() for p in d)
                self.assertIn("6.66",text)
                self.assertIn("ДЕМОНСТРАЦИОН",text.upper())
                self.assertTrue(d[0].get_pixmap().width>100)

if __name__=="__main__": unittest.main()
