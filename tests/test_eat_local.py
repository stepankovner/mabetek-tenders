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
            self.assertEqual(db.execute('SELECT attempts FROM publication_queue').fetchone()[0], 1)
            publish_candidates(db,[card],publish)
            self.assertEqual(len(attempts), 1)  # Respect retry backoff.
            db.execute('UPDATE publication_queue SET next_at=0')
            db.commit()
            publish_candidates(db,[card],publish)
            publish_candidates(db,[card],publish)
            self.assertEqual(len(attempts),2)
        finally:
            db.close()

    def test_offline_find_survives_restart_and_disappearing_catalogue_page(self):
        from agent.eat_import import connection, ingest, publish_candidates
        card = dict(source='eat', procedure='1', lot='1', title='Выгрузка вагонов', url='original')
        sent = []
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'inbox.sqlite'
            db = connection(path)
            ingest(db, [card])
            db.close()  # The process stops before even trying the first upload.
            db = connection(path)
            try:
                publish_candidates(db, [], lambda payload: sent.append(payload) or {'status':'accepted'})
                publish_candidates(db, [], lambda payload: self.fail('duplicate'))
                self.assertEqual(sent, [dict(procedure='1', title=card['title'], url='original')])
                self.assertEqual(db.execute('SELECT count(*) FROM publication_queue').fetchone()[0], 0)
            finally:
                db.close()

    def test_changed_candidate_is_not_deleted_by_ack_of_previous_payload(self):
        import sqlite3
        from agent.eat_import import enqueue_candidates, drain_candidates
        db = sqlite3.connect(':memory:')
        old = dict(procedure='1', title='Выгрузка вагонов', url='original')
        new = dict(old, title='Выгрузка вагонов и хранение')
        try:
            enqueue_candidates(db, [old])
            def updated_during_upload(payload):
                enqueue_candidates(db, [new])
                return {'status':'accepted'}
            drain_candidates(db, updated_during_upload, limit=1)
            self.assertEqual(db.execute('SELECT title FROM publication_queue').fetchone()[0], new['title'])
            delivered = []
            drain_candidates(db, lambda payload: delivered.append(payload) or {'status':'accepted'})
            self.assertEqual(delivered[0]['title'], new['title'])
        finally:
            db.close()

    def test_eis_sampling_follows_lexical_matches_and_uses_separate_receipts(self):
        import sqlite3
        from agent.eat_import import publish_candidates
        cards = [dict(source='eis-orders', title=title, url='https://example.org/'+n, procedure=n)
                 for n, title in [('1','Поставка мебели'),('2','Выгрузка вагонов'),('3','Поставка компьютеров')]]
        delivered = []
        def publish(row):
            delivered.append(row)
            return {'status':'filtered' if row.get('review') else 'accepted'}
        db = sqlite3.connect(':memory:')
        try:
            publish_candidates(db, cards, publish, sample_nonmatches=True)
            self.assertEqual([row.get('review', False) for row in delivered], [False, True])
            self.assertEqual(delivered[0]['procedure'], '2')
            self.assertEqual(db.execute('SELECT count(*) FROM eat_receipts').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT count(*) FROM review_receipts').fetchone()[0], 1)
            publish_candidates(db, cards, publish, sample_nonmatches=True)
            self.assertTrue(delivered[-1]['review'])
            self.assertNotEqual(delivered[-1]['procedure'], delivered[-2]['procedure'])
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


class OtcMarket(unittest.TestCase):
    def test_remembers_catalogue_cursor_and_enqueues_confirmed_section(self):
        import json
        import tempfile
        from pathlib import Path
        from types import SimpleNamespace
        from unittest.mock import patch
        from agent.eat_import import collect_otc_market
        partial = dict(section='commercial', next=3, gaps=[2], totalPages=5, complete=False,
                       cards=[dict(url='https://etp.otc.ru/tender/123', title='Выгрузка вагонов в Хабаровске')])
        complete = dict(partial, next=2, gaps=[], cards=[], complete=True)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'otc.sqlite'
            with patch('agent.eat_import.subprocess.run', side_effect=[
                SimpleNamespace(stdout=json.dumps(partial)), SimpleNamespace(stdout=json.dumps(complete)),
            ]) as run:
                received = []
                def publish(item):
                    received.append(item)
                    return {'status':'accepted'}
                first = collect_otc_market('node',folder,path,'commercial',publish)
                second = collect_otc_market('node',folder,path,'commercial',publish)
                self.assertEqual(first['reason'],'otc_pagination_incomplete')
                self.assertNotIn('reason',second)
                self.assertEqual(run.call_args.args[0][-3:],['commercial','3','[2]'])
                self.assertEqual([item['section'] for item in received],['commercial'])
