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

    def test_specific_address_preserves_subject_and_region_decisions(self):
        from agent.daemon import analysis_message
        for title, city, verdict in [
            ('Ремонт системы видеонаблюдения', 'Хабаровск', 'отклонить'),
            ('Выгрузка вагонов', 'Владивосток', 'отклонить'),
            ('Оказание услуг', 'Хабаровск', 'недостаточно исходных данных'),
        ]:
            with self.subTest(title=title, city=city):
                card = {'title': title, 'url': 'https://example.org/lot'}
                evidence = f'ТЗ.doc, строка 42: Место выполнения работ г. {city}, ул. Ленина, 8.'
                result = analysis_message(card, evidence)
                self.assertIn('Оценка: ' + verdict, result)
                self.assertNotIn('выездную бригаду', result)

    def test_missing_document_is_unknown(self):
        from agent.daemon import analysis_message
        card={'title':'Погрузка','place':'См. приложение','url':'https://rzd.rts-tender.ru/'}
        text=analysis_message(card,'Оригинал с приложениями недоступен.')
        self.assertIn('допускается ли площадка исполнителя',text.lower())
        self.assertNotIn('точное место установлено',text.lower())

class CustomerForms(unittest.TestCase):
    def test_requirements_have_source_and_location(self):
        from agent.rzd_documents import form_evidence
        rows=[dict(file='Извещение.doc',location='строка '+str(i),text=t) for i,t in enumerate([
            'Форма технического предложения участника;', 'Форма технического предложения участника;',
            'Техническое предложение оформляется отдельно по каждому лоту в формате MS Word',
            '2. Применяемая ставка НДС составляет ____ процентов.',
            'Иванов Иван, персональные сведения'])]
        result=form_evidence(rows)
        self.assertEqual(result.count('Форма технического предложения'),1)
        self.assertIn('строка 2',result)
        self.assertIn('строка 3',result)
        self.assertNotIn('Иванов',result)

class CachedAttachment(unittest.TestCase):
    def test_source_identity_integrity_and_ambiguous_versions(self):
        import hashlib
        import json
        import tempfile
        from pathlib import Path
        from agent.rzd_documents import cached_attachment

        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            name = 'ТЗ.doc'
            def save(data):
                digest = hashlib.sha256(data).hexdigest()
                path = cache / (digest + '.doc')
                path.write_bytes(data)
                path.with_suffix('.json').write_text(json.dumps(dict(name=name, url=URL, sha256=digest)))
                return path

            first = save(b'original')
            self.assertEqual(cached_attachment(cache, name, URL), b'original')
            self.assertIsNone(cached_attachment(cache, name, URL + '1'))
            self.assertIsNone(cached_attachment(cache, 'Другой.doc', URL))
            save(b'revised')
            self.assertIsNone(cached_attachment(cache, name, URL))
            first.write_bytes(b'corrupt')
            self.assertEqual(cached_attachment(cache, name, URL), b'revised')

class VerifiedBerkakitAddress(unittest.TestCase):
    def test_address_requires_same_document(self):
        from agent.daemon import analysis_message
        address = 'Республика Саха (Якутия), станция Беркакит, ул. Железнодорожная, д. 1.'
        header = dict(file='Техническое задание.doc', location='строка 123', text='Место оказания услуг')
        row = dict(file=header['file'], location='строка 124', text=address)
        text = summarize([header, row])
        self.assertIn('строка 124', text)
        self.assertIn('Оценка: отклонить', analysis_message(dict(title='Погрузочно-разгрузочные работы',url=URL),text))
        self.assertNotIn(address,summarize([header,dict(row,file='Иное приложение.doc')]))
