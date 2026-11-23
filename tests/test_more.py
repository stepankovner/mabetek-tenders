import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
import pymupdf
from agent.evaluate import acceptance_sample, metrics, selection_targets
from agent.pipeline import extract,quote
from agent.local import ROOT

class More(unittest.TestCase):
    def test_selection_targets_require_observations_and_exact_thresholds(self):
        for recall, precision, expected in (
            ([9, 10], [7, 10], [True, True]),
            ([899, 1000], [699, 1000], [False, False]),
            ([0, 0], [0, 0], [None, None]),
        ):
            result = selection_targets(dict(recall=recall, urgent_precision=precision))
            self.assertEqual([result[k]["met"] for k in ("recall", "urgent_precision")], expected)

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
        self.assertEqual(report["recall_by_class"],{"рассмотреть":[1,1],"нужно уточнение":[0,1]})
        self.assertEqual(report["urgent_precision"],[1,2])
        self.assertEqual(report["omitted_from_collection"],["two"])

    def test_sample_target_counts_both_useful_classes(self):
        gold = {i: {"label": "отклонить"} for i in range(200)}
        for i in range(29):
            gold[i]["label"] = "рассмотреть"
        gold[29]["label"] = "нужно уточнение"
        self.assertEqual(acceptance_sample(gold), {
            "lots": 200, "useful": 30, "confirmed": 29, "size_target_met": True})
        gold[29]["label"] = "отклонить"
        self.assertFalse(acceptance_sample(gold)["size_target_met"])
        gold[29]["label"] = "рассмотреть"
        self.assertTrue(acceptance_sample(gold)["size_target_met"])
        del gold[199]
        self.assertFalse(acceptance_sample(gold)["size_target_met"])

    def test_no_guessed_rates(self):
        base=json.loads((ROOT/"examples/terms-demo.json").read_text())
        base.update(customer="Пример",lot="1",confirmed=True)
        for changes in (dict(stale=True),dict(unable=True),dict(currency="USD"),dict(confirmed=False)):
            with self.assertRaises(ValueError):quote(dict(base,**changes))
        for rate in ("NaN","1e3","-1","0","0.0001",""):
            with self.assertRaises(ValueError):quote(dict(base,items=[dict(base["items"][0],rate=rate)]))
