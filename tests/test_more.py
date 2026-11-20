import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
import pymupdf
from agent.evaluate import metrics
from agent.pipeline import extract,quote
from agent.local import ROOT

class More(unittest.TestCase):
    def test_xlsx_zip(self):
        with tempfile.TemporaryDirectory() as td:
            doc=Path(td)/"units.xlsx"
            with zipfile.ZipFile(doc,"w") as z:
                z.writestr("xl/_rels/workbook.xml.rels",'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
                z.writestr("xl/workbook.xml",'<workbook xmlns:r="urn:r"><sheets><sheet name="ПРР" r:id="r1"/></sheets></workbook>')
                z.writestr("xl/worksheets/sheet1.xml",'<worksheet><sheetData><row><c r="B2" t="inlineStr"><is><t>вагон-сутки</t></is></c></row></sheetData></worksheet>')
            archive=Path(td)/"docs.zip"
            with zipfile.ZipFile(archive,"w") as z:z.write(doc,doc.name)
            row=extract(archive)[0]
            self.assertEqual((row["location"],row["text"]),("ПРР!B2","вагон-сутки"))

    def test_pdf_page(self):
        with tempfile.TemporaryDirectory() as td:
            file=Path(td)/"read.pdf"
            with pymupdf.open() as d:
                d.new_page().insert_text((10,20),"350 RUB")
                d.save(file)
            row=extract(file)[0]
            self.assertEqual((row["location"],row["text"],row["ocr"]),("страница 1","350 RUB",False))

    def test_missed_in_denominator(self):
        gold={"one":{"label":"рассмотреть"},"two":{"label":"нужно уточнение"},"three":{"label":"отклонить"}}
        report=metrics(gold,{"one":{"shown":True,"urgent":True},"three":{"shown":True,"urgent":True}})
        self.assertEqual(report["recall"],[1,2])
        self.assertEqual(report["urgent_precision"],[1,2])
        self.assertEqual(report["omitted_from_collection"],["two"])

    def test_no_guessed_rates(self):
        base=json.loads((ROOT/"examples/terms-demo.json").read_text())
        base.update(customer="Пример",lot="1",confirmed=True)
        for changes in (dict(stale=True),dict(unable=True),dict(currency="USD"),dict(confirmed=False)):
            with self.assertRaises(ValueError):quote(dict(base,**changes))
        for rate in ("NaN","1e3","-1","0","0.0001",""):
            with self.assertRaises(ValueError):quote(dict(base,items=[dict(base["items"][0],rate=rate)]))
