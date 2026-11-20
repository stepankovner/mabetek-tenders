import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from agent.local import ROOT, connection, record

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
            target=sqlite3.connect(Path(td)/"backup.db");db.backup(target);db.close()
            self.assertEqual(target.execute("SELECT state FROM offers").fetchone()[0],"устарело")
            self.assertEqual(target.execute("SELECT value FROM answers WHERE revision=1").fetchone()[0],"уточнить")
            self.assertEqual(target.execute("PRAGMA integrity_check").fetchone()[0],"ok")
            target.close()
