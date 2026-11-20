import subprocess
import unittest
import urllib.error
from unittest.mock import patch
from agent import deployment_check as check


class SourceHealth(unittest.TestCase):
    @patch.object(check.subprocess, 'run')
    @patch.object(check, 'settings', return_value={})
    @patch.object(check, 'request', side_effect=urllib.error.HTTPError('https://example.org', 404, 'not found', {}, None))
    def test_probe_404_preserves_cloud_status(self, _, __, run):
        run.return_value = subprocess.CompletedProcess([], 0, '[{"success":true,"results":[{"id":"eis","last_error":"HTTP 503"}]}]')
        status, method = check.source_status()
        self.assertEqual(status['sources'][0]['last_error'], 'HTTP 503')
        self.assertIn('базы', method)
        self.assertIn(check.SOURCE_QUERY, run.call_args.args[0])
