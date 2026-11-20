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
