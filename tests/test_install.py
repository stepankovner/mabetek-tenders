import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from agent.install import register_agent


class Installation(unittest.TestCase):
    def test_bootstrap_retries_and_identical_running_release_is_left_in_place(self):
        data={'WorkingDirectory':'/test/releases/abc','Label':'ru.mabetek.tenders.agent'}
        calls=[]
        def launch(argv,**opts):
            calls.append(argv[1])
            if argv[1]=='bootstrap':
                return subprocess.CompletedProcess(argv,5 if calls.count('bootstrap')==1 else 0,'','')
            active=calls.count('bootstrap')>=2
            return subprocess.CompletedProcess(argv,0 if active else 113,'working directory = /test/releases/abc\n' if active else '','')
        with tempfile.TemporaryDirectory() as folder,patch('agent.install.time.sleep'),patch('agent.install.subprocess.run',side_effect=launch):
            plist=Path(folder)/'agent.plist'
            register_agent('gui/501',plist,data)
            register_agent('gui/501',plist,data)
            self.assertEqual(plistlib.loads(plist.read_bytes()),data)
            self.assertEqual(calls.count('bootstrap'),2)
            self.assertNotIn('bootout',calls)
