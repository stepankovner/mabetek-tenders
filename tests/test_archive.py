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
