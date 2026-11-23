import unittest
from agent.check_qwen import verified_lines
from agent.model import grounded_quotes, select_fragments

class ModelOutput(unittest.TestCase):
    def test_only_verbatim_from_referenced_fragment(self):
        rows=[{'file':'ТЗ','location':'абзац 2','text':'Погрузка на площадке заказчика.'}]
        self.assertEqual(grounded_quotes('{"quotes":[{"fragment":0,"quote":"площадке заказчика"}]}',rows),['ТЗ, абзац 2: площадке заказчика'])
        self.assertEqual(grounded_quotes('{"quotes":[{"fragment":0,"quote":"Ставка 5000"},{"fragment":1,"quote":"Ставка 5000"}]}',rows),[])
    def test_invalid_model_output_is_not_evidence(self):
        self.assertEqual(grounded_quotes('цена 5000',[]),[])

    def test_address_after_first_twelve_candidates(self):
        rows = [dict(text="Место указано в приложении", location=str(i)) for i in range(24)]
        address = dict(text="Место оказания услуг: Хабаровск, Путевой пер. 8.", location="строка 390")
        self.assertEqual(select_fragments(rows + [address])[0], address)

    def test_every_citation_matches_the_numbered_original_line(self):
        lines = ["Заголовок", " Адрес: Хабаровск ", "Цена неизвестна"]
        address = "ТЗ.doc, строка 2: Адрес: Хабаровск"
        self.assertEqual(verified_lines(address, "ТЗ.doc", lines), [2])
        self.assertEqual(verified_lines("ТЗ.doc, строка 2: Хабаровск", "ТЗ.doc", lines), [2])
        for invalid in (address.replace("2:", "1:"), address.replace("Хабаровск", "Владивосток"),
                        address.replace("ТЗ.doc", "Иное.doc"), address + "\nлишнее"):
            self.assertEqual(verified_lines(invalid, "ТЗ.doc", lines), [])
