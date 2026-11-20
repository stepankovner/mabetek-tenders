import unittest
from unittest.mock import patch
from agent.sources import poll_fallback

class SourceFallback(unittest.TestCase):
    @patch('agent.sources.fetch_catalogue', return_value='<html>catalogue</html>')
    def test_due_sources_rotate_and_do_not_fetch_unknown_urls(self, fetch):
        saved, schedule = [], {}
        for tick in range(3):
            poll_fallback(['tektorg','gpb','other'], schedule, 100+tick, saved.append)
        self.assertEqual([row['source'] for row in saved], ['tektorg','gpb'])
        self.assertEqual(fetch.call_count, 2)
