import unittest
from agent.archive import split_lots

class ArchiveTest(unittest.TestCase):
    def test_related_procedures_stay_together_and_unknown_lots_do_not_get_numbers(self):
        cards=[dict(id='1',url='a',published='2026-03-01',title='Хранение груза'),dict(id='2',url='b',published='2026-10-01',title='Хранение груза'),dict(id='3',url='c',published='2026-01-01',title='Иной предмет')]
        lots=[dict(url=k,state='verified',lots=[dict(lot='1',subject='Хранение',price=None)]) for k in ['a','b']]
        lots.append(dict(url='c',state='no-lot-table',lots=[]))
        dev,held,missing=split_lots(cards,lots,[{'id':i,'organizer':'Компания'} for i in ['1','2','3']])
        self.assertFalse(dev)
        self.assertEqual(len(held),2)
        self.assertEqual(missing[0]['procedure'],'3')

class FrozenArchive(unittest.TestCase):
    def test_direct_and_related_rows_of_an_inspected_procedure_stay_in_development(self):
        import json,tempfile
        from pathlib import Path
        from agent.archive_v3 import snapshot
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            known=dict(id='roseltorg/123/1',subject='Хранение груза',customer='Организатор',published='2026-11-01',place=None,url='https://www.roseltorg.ru/procedure/123/1')
            (root/'v2-held-out.jsonl').write_text(json.dumps(known)+'\n')
            (root/'v2-development.jsonl').write_text('')
            new=[dict(known,id='roseltorg/124/1'),dict(known,id='roseltorg/125/1',subject='Другая услуга')]
            (root/'roseltorg-originals-v3.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in new))
            snapshot(root)
            self.assertEqual(json.loads((root/'v3-held-out.jsonl').read_text())['id'],'roseltorg/125/1')


class RadNoticeFiles(unittest.TestCase):
    def test_only_current_notice_and_public_small_purchase_files(self):
        from agent.rad_documents import NoticeFiles
        parser = NoticeFiles()
        def link(key):
            return f'<a href="/etp/downloadppf?uuid=dbfile{key}" value="{key}.docx">{key}</a>'
        def row(title, revision, key):
            return f'<tr><td>{title}</td><td>{revision}</td><td>{link(key)}</td></tr>'
        parser.feed(row('Извещение о закупке', '№2 (действующая)', 'new') +
                    row('Извещение о закупке', '№1 (архивная)', 'old') +
                    row('Итоговый протокол', '№1 (действующая)', 'protocol') +
                    '<tr><td id="fileNameColumnCell_2">' + link('small') +
                    '<a href="https://example.org/other" value="extra.docx">extra</a></td></tr>')
        self.assertEqual(set(parser.files.values()), {'new.docx', 'small.docx'})


class IndependentReview(unittest.TestCase):
    def test_short_ids_are_scoped_to_the_submitted_batch(self):
        import json
        import tempfile
        from pathlib import Path
        from agent.review_results import compare

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cards = [dict(id=f'rad/{i}', url=f'https://example.org/{i}') for i in (1, 2)]
            def write_rows(path, rows):
                path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            write_rows(root / 'v4-held-out.jsonl', cards)
            write_rows(root / 'v4-title-results.jsonl', [dict(r, title_match=False) for r in cards])
            review = root / 'v4-review'
            review.mkdir()
            write_rows(review / 'prompt-01.txt', [dict(cards[0], review_id='V4-001')])
            (review / 'response-01.txt').write_text(
                'V4-002 | отклонить | чужая карточка\nV4-001 | нужно уточнение | город неизвестен\n')
            compare(root, 'v4')
            rows = [json.loads(line) for line in (root / 'v4-comparison-audited.jsonl').read_text().splitlines()]
            self.assertEqual([row['independent'] for row in rows], ['нужно уточнение', None])

            # An unrelated URL outside the manifest also contradicts the supplied ID.
            (review / 'response-01.txt').write_text('V4-001 | отклонить | https://example.org/9\n')
            compare(root, 'v4')
            output = root / 'v4-comparison-audited.jsonl'
            row = json.loads(output.read_text().splitlines()[0])
            self.assertIsNone(row['independent'])
            self.assertEqual(row['citations'][0]['status'], 'other_url')
            (review / 'response-01.txt').write_text('V4-001 | отклонить | https://example.org/1\n')
            compare(root, 'v4')
            self.assertEqual(json.loads(output.read_text().splitlines()[0])['linked_label'], 'отклонить')
