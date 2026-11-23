import sqlite3
import tempfile
import unittest
from pathlib import Path
from agent.local import connection, record
from agent.maintenance import maintain


class Maintenance(unittest.TestCase):
    def test_daily_backup_restores_queue_and_retains_last_seven_snapshots(self):
        from agent.eat_import import ingest
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / 'eat-inbox.sqlite'
            with connection(source) as db:
                ingest(db, [dict(source='eat', procedure='1', lot='1',
                                 title='Выгрузка вагонов', url='original')])
            db.close()
            for n in range(1, 10):
                self.assertEqual(len(maintain(base, day=f'2026-11-{n:02}')), 1)
            self.assertEqual(maintain(base, day='2026-11-09'), [])
            copies = sorted((base / 'backups').glob('*.sqlite'))
            self.assertEqual(len(copies), 7)
            with sqlite3.connect(copies[-1]) as restored:
                self.assertEqual(restored.execute('SELECT title FROM publication_queue').fetchone()[0],
                                 'Выгрузка вагонов')
                self.assertEqual(restored.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(copies[-1].stat().st_mode & 0o777, 0o600)
            self.assertTrue(source.exists())

    def test_failed_backup_keeps_existing_copies_and_log_is_bounded(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with connection(base / 'inbox.sqlite') as db:
                pass
            db.close()
            maintain(base, day='2026-11-01')
            with patch('agent.maintenance.backup', side_effect=OSError('disk full')):
                with self.assertRaises(OSError):
                    maintain(base, day='2026-11-02')
            self.assertEqual(len(list((base / 'backups').glob('*.sqlite'))), 1)
            log = base / 'agent-error.log'
            log.write_bytes(b'old line\n' * 600_000 + b'latest line\n')
            inode = log.stat().st_ino
            maintain(base, day='2026-11-01')
            self.assertEqual(log.stat().st_ino, inode)
            self.assertLessEqual(log.stat().st_size, 1_000_000)
            self.assertTrue(log.read_bytes().endswith(b'latest line\n'))
