"""中文注释：真实套接字诊断、无副作用检查、能力裁剪与文档漂移。"""
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
def load(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
reference = load(ROOT / 'executor-plugin/reference.py')
doctor = load(ROOT / 'native-bridge/doctor.py')

class ReferenceTests(unittest.TestCase):
    def test_generated_document_matches_actual_helper_exports(self):
        self.assertEqual((ROOT / 'docs/browser-api-reference.md').read_text(), reference.render())
        names = {h['name'] for h in reference.helper_catalog()}
        self.assertTrue({'network_start', 'network_detail', 'page_request'} <= names)
        self.assertNotIn('_call', names)
    def test_disconnected_or_old_extension_never_advertises_new_helpers(self):
        self.assertEqual(reference.project([], 'missing')['helpers'], [])
        old = reference.project([{'instanceId': 'a', 'connected': True, 'features': ['browser_core_v1']}], 'a')
        self.assertNotIn('network_start', [h['name'] for h in old['helpers']])
        new = reference.project([{'instanceId': 'a', 'connected': True, 'features': ['network_evidence_v1']}], 'a')
        self.assertIn('network_start', [h['name'] for h in new['helpers']])

class DoctorTests(unittest.TestCase):
    def test_single_probe_timeout_is_unconfirmed_with_next_action(self):
        # 中文注释：守护进程可能忙于其他请求；一次连接超时不构成进程退出证据。
        with tempfile.TemporaryDirectory() as d:
            data = Path(d) / 'plugin-data/browser-link-native'; data.mkdir(parents=True)
            (data / 'token').write_text('synthetic'); (data / 'token').chmod(0o600)
            with patch.object(doctor.socket, 'socket', side_effect=socket.timeout()):
                self.assertEqual(doctor.probe(Path(d))['code'], 'host_unconfirmed')
            result = doctor.diagnose(Path(d), Path(d), lambda _: {'ok': False, 'code': 'host_unconfirmed'})
            self.assertEqual(next(row for row in result['checks'] if row['component'] == 'host')['code'], 'host_unconfirmed')
            self.assertTrue(any('browser_shared_health' in line for line in result['advice']))
    def test_missing_install_does_not_create_or_start_anything(self):
        with tempfile.TemporaryDirectory() as d:
            result = doctor.diagnose(Path(d) / 'hermes', Path(d) / 'user')
            self.assertFalse(result['ok']); self.assertTrue(result['read_only'])
            self.assertEqual(list(Path(d).iterdir()), [])
    def test_manifest_checks_launcher_and_separates_access_from_connection(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d) / 'h'; user = Path(d) / 'u'
            plugin = home / 'plugins/browser-link/plugin.yaml'; plugin.parent.mkdir(parents=True); plugin.write_text('name: browser-link')
            launcher = Path(d) / 'host'; launcher.write_text('# fixture'); launcher.chmod(0o700)
            manifest = user / 'Library/Application Support/Google/Chrome/NativeMessagingHosts' / (doctor.HOST + '.json')
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({'name': doctor.HOST, 'type': 'stdio', 'path': str(launcher), 'allowed_origins': ['chrome-extension://' + 'a' * 32 + '/']}))
            result = doctor.diagnose(home, user, lambda _: {'ok': True, 'browsers': [{'connected': True, 'consentStatus': 'disabled'}]})
            self.assertTrue(result['ok']); self.assertTrue(any('浏览器访问' in s for s in result['advice']))
            launcher.chmod(0o600)
            self.assertFalse(doctor.diagnose(home, user, lambda _: {'ok': True, 'browsers': [{'connected': True}]})['ok'])
    def test_authenticated_probe_uses_existing_socket_only(self):
        # 中文注释：保留真实 HOME；测试数据和套接字全部位于短临时目录。
        with tempfile.TemporaryDirectory(dir='/tmp') as d:
            data = Path(d) / 'plugin-data/browser-link-native'; data.mkdir(parents=True)
            (data / 'token').write_text('synthetic'); (data / 'token').chmod(0o600)
            server = socket.socket(socket.AF_UNIX); server.bind(str(data / 'bridge.sock')); server.listen()
            seen = []
            def serve():
                with server.accept()[0] as conn, conn.makefile('rb') as reader:
                    seen.append(json.loads(reader.readline()))
                    for result in ({'ok': True, 'protocolVersion': 1}, [{'connected': True}]):
                        request = json.loads(reader.readline()); seen.append(request['method'])
                        conn.sendall((json.dumps({'id': request['id'], 'result': result}) + '\n').encode())
            worker = threading.Thread(target=serve); worker.start()
            try:
                result = doctor.probe(Path(d)); worker.join(2)
                self.assertTrue(result['ok']); self.assertEqual(seen[1:], ['health', 'browser.list'])
                self.assertNotIn('synthetic', json.dumps(result))
            finally:
                server.close()

if __name__ == '__main__':
    unittest.main()
