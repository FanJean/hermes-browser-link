"""Real Hermes dispatcher and native UDS smoke; no personal profile activation."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from test_native_tools import ROOT, load
sys.path.insert(0, str(ROOT.parent / 'native-bridge'))
from tests.support import stop_fixture_daemon  # noqa: E402


def _is_fixture_daemon(command, home):
    try:
        arguments = shlex.split(command)
        daemon_home = Path(arguments[arguments.index('--home') + 1]).resolve()
    except (IndexError, ValueError):
        return False
    return any(Path(argument).name == 'daemon.py' for argument in arguments) and daemon_home == Path(home).resolve()


class NativeIntegrationTests(unittest.TestCase):
    def test_real_hermes_bounded_hook_to_real_client(self):
        hermes_root = Path(os.environ.get('HERMES_SOURCE', str(Path.home() / '.hermes/hermes-agent')))
        if not (hermes_root / 'hermes_cli/plugins.py').exists():
            self.skipTest('Hermes source unavailable; set HERMES_SOURCE')
        client_path = ROOT.parent / 'native-bridge/client.py'
        if not client_path.exists():
            self.skipTest('native bridge backend not yet available')
        # macOS /private/var TMPDIR paths can exceed AF_UNIX's 104-byte limit.
        scratch = Path.home() / '.hermes/cache/scratch'
        scratch.mkdir(parents=True, exist_ok=True)
        # A gate HOME nests deeply; its TMPDIR keeps the daemon socket path short.
        if os.environ.get('TMPDIR') and Path(os.environ['TMPDIR']).is_dir():
            scratch = min((scratch.resolve(), Path(os.environ['TMPDIR']).resolve()), key=lambda path: len(str(path)))
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            env = {'HERMES_HOME': tmp, 'HOME': tmp}
            with patch.dict(os.environ, env):
                sys.path.insert(0, str(hermes_root))
                try:
                    from hermes_cli import plugins
                except ImportError as exc:
                    self.skipTest('Run with Hermes interpreter: ' + str(exc))
                finally:
                    sys.path.remove(str(hermes_root))
                tools = load('native_tools')
                runtime = tools.runtime_module()
                profile = runtime.NativeProfileRuntime(Path(tmp), ROOT)
                manager = plugins.PluginManager()
                threads = []
                def hook(**kwargs):
                    threads.append(threading.get_ident())
                    return profile.authority.pre_tool_call(**kwargs)
                manager._hooks.setdefault('pre_tool_call', []).append(hook)
                processes = []
                real_popen = subprocess.Popen
                def tracked_popen(*args, **kwargs):
                    proc = real_popen(*args, **kwargs)
                    processes.append(proc)
                    return proc
                try:
                    with patch.object(plugins, '_delivery_manager', return_value=manager), patch('subprocess.Popen', side_effect=tracked_popen):
                        name = 'browser_shared_health'
                        block, args = plugins._dispatch_pre_tool_call_hooks(name, {}, session_id='fixture-session', tool_call_id='fixture-call')
                        self.assertIsNone(block)
                        self.assertIsInstance(args, dict)
                        result = json.loads(tools.make_tool_handler(name, profile)(args, session_id='fixture-session'))
                        self.assertEqual(result, {'ok': True, 'protocolVersion': 1})
                        pid_path = Path(tmp) / 'plugin-data/browser-link-native/daemon.pid'
                        self.assertTrue(pid_path.is_file(), 'Real daemon must publish its process identity')
                        daemon_pid = int(pid_path.read_text())
                        command = subprocess.check_output(['ps', '-p', str(daemon_pid), '-o', 'command='], text=True)
                        self.assertIn('daemon.py', command)
                        self.assertTrue(_is_fixture_daemon(command, tmp), command)
                        self.assertTrue((pid_path.parent / 'bridge.sock').is_socket())
                        self.assertNotEqual(threads[0], threading.get_ident())
                        # Another session cannot consume this hook-issued lease.
                        block, args = plugins._dispatch_pre_tool_call_hooks('browser_shared_browsers', {}, session_id='fixture-session', tool_call_id='fixture-call-2')
                        result = json.loads(tools.make_tool_handler('browser_shared_browsers', profile)(args, session_id='foreign-session'))
                        self.assertEqual(result['code'], 'owner_denied')
                        block, args = plugins._dispatch_pre_tool_call_hooks('browser_shared_browsers', {}, session_id='fixture-session', tool_call_id='fixture-call-3')
                        result = json.loads(tools.make_tool_handler('browser_shared_browsers', profile)(args, session_id='fixture-session'))
                        self.assertEqual(result, [])
                finally:
                    if profile._client is not None:
                        profile._client.close()
                    profile.close()
                    # Reap the exact daemon in this isolated home, regardless of launcher implementation.
                    pid_path = Path(tmp) / 'plugin-data/browser-link-native/daemon.pid'
                    if pid_path.is_file():
                        pid = int(pid_path.read_text())
                        check = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True)
                        if check.returncode == 0 and _is_fixture_daemon(check.stdout, tmp):
                            stop_fixture_daemon(Path(tmp))
                            self.assertFalse(pid_path.exists(), 'fixture daemon did not shut down')
                        else:
                            raise RuntimeError('refusing to stop non-fixture PID')
                    # Only processes launched by THIS isolated fixture are reaped.
                    for proc in processes:
                        proc.terminate()
                        try:
                            proc.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
