import unittest
from agent.rzd_documents import attachment_links, summarize

URL = 'https://223.rts-tender.ru/files/FileDownloadHandler.ashx?FileGuid=a0baf54c-54f6-4737-aa23-181401411320'

class Attachments(unittest.TestCase):
    def test_visible_attachment_and_untrusted_link(self):
        def row(url):
            return '<tr><td>Приложение.docx</td><td><a href="'+url+'"><img></a></td></tr>'
        self.assertEqual(attachment_links(row(URL)+row(URL)+row(URL.replace('223.rts-tender.ru','other.test'))),[('Приложение.docx',URL)])
    def test_place_requires_document_evidence(self):
        rows=[dict(file='ТЗ.docx',location='абзац 8',text='Место выполнения работ: станция Ванино.')]
        self.assertIn('Ванино',summarize(rows))
        self.assertIn('абзац 8',summarize(rows))
        self.assertEqual(summarize([]),'')

class Analysis(unittest.TestCase):
    def test_specific_site_prompts_for_offsite_team(self):
        from agent.daemon import analysis_message
        card={'title':'Выгрузка вагонов','place':'См. ТЗ','url':'https://rzd.rts-tender.ru/'}
        place='ТЗ.doc, строка 117: Место оказания услуг Хабаровский край, г. Хабаровск, 3-й Путевой пер. 8.'
        text=analysis_message(card,place)
        self.assertIn('выезд',text.lower())
        self.assertIn('строка 117',text)
        self.assertNotIn('допускается ли площадка исполнителя',text.lower())

    def test_missing_document_is_unknown(self):
        from agent.daemon import analysis_message
        card={'title':'Погрузка','place':'См. приложение','url':'https://rzd.rts-tender.ru/'}
        text=analysis_message(card,'Оригинал с приложениями недоступен.')
        self.assertIn('допускается ли площадка исполнителя',text.lower())
        self.assertNotIn('точное место установлено',text.lower())
