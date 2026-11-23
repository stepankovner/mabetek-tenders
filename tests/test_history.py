import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from agent.local import ROOT, backup, connection, record

class History(unittest.TestCase):
    def test_revision_backup_restore(self):
        with tempfile.TemporaryDirectory() as td:
            db=connection(Path(td)/"local.db")
            card=json.loads((ROOT/"examples/rzd-control.json").read_text())
            lot,rev=record(db,card,[])
            self.assertEqual(record(db,card,[]),(lot,rev))
            with db:
                db.execute("INSERT INTO answers VALUES('42',?,1,'даты','уточнить')",(lot,))
                db.execute("INSERT INTO offers(lot,revision,state) VALUES(?,1,'готово')",(lot,))
            self.assertEqual(record(db,dict(card,title="Исправление"),[]),(lot,2))
            self.assertNotEqual(record(db,dict(card,lot="2"),[])[0],lot)
            source, saved = Path(td)/"local.db", Path(td)/"backup.db"
            subprocess.run([sys.executable, "-m", "agent.local", "--db", str(source), "backup", str(saved)], check=True)
            with self.assertRaises(FileExistsError):
                backup(source, saved)
            db.close()
            self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
            target=sqlite3.connect(saved)
            self.assertEqual(target.execute("SELECT state FROM offers").fetchone()[0],"устарело")
            self.assertEqual(target.execute("SELECT value FROM answers WHERE revision=1").fetchone()[0],"уточнить")
            self.assertEqual(target.execute("PRAGMA integrity_check").fetchone()[0],"ok")
            target.close()

    def test_backup_of_missing_source_creates_neither_database_nor_backup(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(sqlite3.OperationalError):
                backup(Path(td)/'missing.sqlite',Path(td)/'copy.sqlite')
            self.assertEqual(list(Path(td).iterdir()), [])

    def test_catalogue_observations_preserve_original_and_survive_reversion(self):
        with tempfile.TemporaryDirectory() as folder:
            db = connection(Path(folder)/'cards.sqlite')
            try:
                card = dict(source='rts-rzd-search', procedure='123', lot='1', title='Услуги', url='https://example.test/1')
                lot, revision = record(db, dict(card, customer='Из оригинала'), [])
                record(db, card, [], catalogue=True)
                updated = dict(card, positions=['Выгрузка вагонов'], catalogue_price_rub='123.45')
                record(db, updated, [], catalogue=True)
                record(db, updated, [], catalogue=True)
                record(db, card, [], catalogue=True)
                history = db.execute('SELECT sequence,payload FROM catalogue_observations WHERE lot=? ORDER BY sequence',(lot,)).fetchall()
                self.assertEqual([json.loads(row['payload']) for row in history], [card,updated,card])
                self.assertEqual([row['sequence'] for row in history], [1,2,3])
                self.assertEqual(db.execute('SELECT revision FROM lots').fetchone()[0], revision)
                self.assertEqual(json.loads(db.execute('SELECT payload FROM versions').fetchone()[0])['customer'],'Из оригинала')
            finally:
                db.close()
