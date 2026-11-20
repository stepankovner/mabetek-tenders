import unittest
from agent.model import grounded_quotes

class ModelOutput(unittest.TestCase):
    def test_only_verbatim_from_referenced_fragment(self):
        rows=[{'file':'ТЗ','location':'абзац 2','text':'Погрузка на площадке заказчика.'}]
        self.assertEqual(grounded_quotes('{"quotes":[{"fragment":0,"quote":"площадке заказчика"}]}',rows),['ТЗ, абзац 2: площадке заказчика'])
        self.assertEqual(grounded_quotes('{"quotes":[{"fragment":0,"quote":"Ставка 5000"},{"fragment":1,"quote":"Ставка 5000"}]}',rows),[])
    def test_invalid_model_output_is_not_evidence(self):
        self.assertEqual(grounded_quotes('цена 5000',[]),[])
