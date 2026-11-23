import subprocess
import unittest
from unittest.mock import patch
from agent.sources import fetch_catalogue, poll_fallback

class SourceFallback(unittest.TestCase):
    def test_local_delivery_health_and_replay_survive_another_broken_source(self):
        import tempfile
        from pathlib import Path
        from agent import daemon
        from agent.local import connection
        from agent.eat_import import ingest
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            for name in ('eat-inbox.sqlite', 'comita-inbox.sqlite'):
                db = connection(base / name)
                try:
                    ingest(db, [dict(source='eat', procedure=name, lot='1', title='Выгрузка вагонов', url=name)])
                finally:
                    db.close()
            calls = []
            def network(conf, endpoint, payload):
                calls.append(endpoint)
                if endpoint == 'eat-candidate':
                    raise OSError('Network unavailable')
                return {'status':'accepted'}
            with (patch.object(daemon, 'CONFIG', base / 'agent.json'),
                  patch.object(daemon, 'request', side_effect=network)):
                self.assertEqual(daemon.local_health()['pending'], 2)
                daemon.replay_publications({})
                self.assertEqual(daemon.local_health()['pending'], 1)
                self.assertEqual(daemon.local_health()['unreadable'], 0)
            self.assertEqual(calls, ['eat-candidate', 'comita-candidate'])

    def test_local_catalogues_keep_running_when_worker_disappears_after_resume(self):
        from agent import daemon
        for state, expected in ((False, 1), (True, 0), (None, 0)):
            with (self.subTest(last_known_pause=state),
                    patch.object(daemon, '_collectors_paused', state),
                    patch.object(daemon, 'request', side_effect=OSError('Network down')),
                    patch.object(daemon, 'schedule_maintenance'),
                    patch.object(daemon, 'schedule_catalogues') as schedule,
                    patch.object(daemon.shutil, 'disk_usage')):
                with self.assertRaises(OSError):
                    daemon.tick({})
                self.assertEqual(schedule.call_count, expected)

    @patch('agent.sources.fetch_catalogue', return_value='<html>catalogue</html>')
    def test_due_sources_rotate_and_do_not_fetch_unknown_urls(self, fetch):
        saved, schedule = [], {}
        for tick in range(3):
            poll_fallback(['tektorg','gpb','zakazrf','other'], schedule, 100+tick, saved.append)
        self.assertEqual([row['source'] for row in saved], ['tektorg','gpb','zakazrf'])
        self.assertEqual(fetch.call_count, 3)

    @patch('agent.sources.subprocess.run')
    def test_zakazrf_requires_successful_html(self, run):
        for metadata in (b'307 text/html', b'200 application/json', b'200 text/html-invalid'):
            with self.subTest(metadata=metadata):
                run.return_value = subprocess.CompletedProcess([], 0, b'body\n' + metadata)
                with self.assertRaises(ValueError):
                    fetch_catalogue('zakazrf')
        run.return_value = subprocess.CompletedProcess([], 0, b'<table/>\n200 text/html; charset=utf-8')
        self.assertEqual(fetch_catalogue('zakazrf'), '<table/>')

    @patch('agent.sources.fetch_html', return_value='страница')
    def test_rosneft_requests_only_the_public_catalogue_page(self, fetch):
        saved = []
        poll_fallback(['rosneft'], {}, 10, saved.append, 3)
        fetch.assert_called_once_with('https://www.tektorg.ru/rosneft/procedures?page=3')
        self.assertEqual(saved, [{'source': 'rosneft', 'html': 'страница'}])
        with self.assertRaises(ValueError):
            fetch_catalogue('rosneft', -2)
