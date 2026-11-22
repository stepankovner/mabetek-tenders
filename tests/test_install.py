import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from agent.install import LABEL, RegistrationError, install_configuration, install_letterhead, main, register_agent


class Installation(unittest.TestCase):
    def test_upgrade_failure_restores_previous_agent_configuration(self):
        import json
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            conf = base / 'agent.json'
            old = '{"worker":"https://worker.example.test","eat_modules":"/old-release"}'
            conf.write_text(old)
            seen = []
            def reject(*args):
                seen.append(json.loads(conf.read_text()))
                raise RegistrationError('bootstrap failed')
            with (patch('agent.install.settings', return_value=json.loads(old)),
                  patch('agent.install.verify_connection'),
                  patch('agent.install.register_agent', side_effect=reject)):
                with self.assertRaises(RegistrationError):
                    install_configuration(base, base / 'new', base / 'letterhead.pdf',
                                          'gui/501', base / 'agent.plist', {})
            self.assertEqual(seen[0]['worker'], 'https://worker.example.test')
            self.assertEqual(seen[0]['eat_modules'], str(base / 'new'))
            self.assertEqual(conf.read_text(), old)
    def test_letterhead_skips_identical_copy_and_preserves_old_file_on_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source.pdf'
            brand = Path(folder) / 'letterhead.pdf'
            source.write_bytes(b'first')
            install_letterhead(source, brand)
            with patch('agent.install.shutil.copyfile', side_effect=OSError('copy failed')):
                install_letterhead(source, brand)
                source.write_bytes(b'second')
                with self.assertRaises(OSError):
                    install_letterhead(source, brand)
            self.assertEqual(brand.read_bytes(), b'first')
            install_letterhead(source, brand)
            self.assertEqual(brand.read_bytes(), b'second')

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
    def test_unwritable_login_configuration_keeps_old_service_running(self):
        data = {'WorkingDirectory': '/test/releases/new', 'Label': 'ru.mabetek.tenders.agent'}
        with tempfile.TemporaryDirectory() as folder:
            plist = Path(folder)/'agent.plist'
            plist.write_bytes(plistlib.dumps(dict(data, WorkingDirectory='/test/releases/old')))
            with patch('agent.install.subprocess.run') as launch, patch.object(Path, 'replace', side_effect=PermissionError):
                with self.assertRaises(PermissionError):
                    register_agent('gui/501', plist, data)
            self.assertFalse(any(c.args[0][1] == 'bootout' for c in launch.call_args_list))
            self.assertEqual(list(Path(folder).iterdir()), [plist])
            self.assertEqual(plistlib.loads(plist.read_bytes())['WorkingDirectory'], '/test/releases/old')

    def test_upgrade_existing_plist_reaches_registration(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder).resolve()
            base = home / 'Library/Application Support/mabetek-tenders'
            base.mkdir(parents=True)
            (base / 'letterhead.pdf').touch()
            plist = home / 'Library/LaunchAgents' / (LABEL + '.plist')
            plist.parent.mkdir(parents=True)
            releases = base / 'releases'
            plist.write_bytes(plistlib.dumps(dict(Label=LABEL, WorkingDirectory=str(releases / 'old'))))
            with (patch.object(Path, 'home', return_value=home),
                  patch('agent.install.__file__', str(home / 'project/agent/install.py')),
                  patch('agent.install.os.umask'),
                  patch('agent.install.stage_release', return_value=releases / 'new') as stage,
                  patch('agent.install.settings', return_value={}),
                  patch('agent.install.request'),
                  patch('agent.install.register_agent') as register):
                main()
            stage.assert_called_once_with(home / 'project', releases)
            register.assert_called_once()
            self.assertEqual(register.call_args.args[1], plist)
            self.assertEqual(register.call_args.args[2]['WorkingDirectory'], str(releases / 'new'))
