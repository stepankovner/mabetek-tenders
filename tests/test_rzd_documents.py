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
