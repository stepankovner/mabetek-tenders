import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent.eat_import import collect_local


class ScheduledImport(unittest.TestCase):
    def test_two_collections_of_public_catalogue_are_idempotent(self):
        pages = []
        for page, size in ((1, 10), (2, 8)):
            rows = [{'number': f'{page*100 + index:018d}',
                     'url': f'https://agregatoreat.ru/purchases/announcement/12345678-1234-1234-1234-{page*100 + index:012d}/',
                     'title': 'Проверка импорта каталога'} for index in range(size)]
            pages.append(dict(page=page, cards=size + 2, restricted=1, inactive=1, rows=rows))
        output = subprocess.CompletedProcess([], 0, stdout=json.dumps(pages))
        with tempfile.TemporaryDirectory() as folder, patch('agent.eat_import.subprocess.run', return_value=output) as run:
            db = Path(folder) / 'inbox.sqlite'
            first = collect_local('node', folder, db)
            second = collect_local('node', folder, db)
            self.assertEqual(first['inserted'], 18)
            self.assertEqual(second, dict(unique=18, inserted=0, differences=[]))
            self.assertEqual(run.call_args.kwargs['timeout'], 150)

    def test_unacknowledged_active_card_is_retried(self):
        import sqlite3
        from agent.eat_import import publish_candidates
        card = dict(title='Выгрузка вагонов', url='original', procedure='1')
        attempts = []
        def publish(row):
            attempts.append(row)
            return {} if len(attempts) == 1 else {'status':'accepted'}
        db = sqlite3.connect(':memory:')
        try:
            with self.assertRaises(ValueError):
                publish_candidates(db,[card],publish)
            publish_candidates(db,[card],publish)
            publish_candidates(db,[card],publish)
            self.assertEqual(len(attempts),2)
        finally:
            db.close()

    def test_rts_uses_only_positions_of_the_current_lot(self):
        from agent.eat_import import connection, ingest, publish_candidates
        title = 'Оказание услуг по договору'
        cards = [dict(source='rts-rzd-search', title=title, procedure='123', lot=lot,
                      url='https://223.rts-tender.ru/supplier/auction/Trade/View.aspx?Id=123#'+lot,
                      positions=[position]) for lot, position in
                 [('1','Ремонт легковых автомобилей'),('2','Выгрузка вагонов')]]
        sent = []
        def accepted(row):
            sent.append(row)
            return {'status':'accepted'}
        with tempfile.TemporaryDirectory() as folder:
            db = connection(Path(folder)/'lots.sqlite')
            try:
                self.assertEqual(ingest(db,cards)['inserted'],2)
                self.assertEqual(db.execute("SELECT status FROM lots WHERE lot_no='2'").fetchone()[0], 'нужно уточнение')
                publish_candidates(db,cards,accepted)
                publish_candidates(db,cards,accepted)
                self.assertEqual(sent,[dict(title='Выгрузка вагонов', procedure='123', url=cards[1]['url'])])
            finally:
                db.close()
