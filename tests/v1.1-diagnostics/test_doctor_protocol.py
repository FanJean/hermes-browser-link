"""中文注释：只读 doctor 通过真实套接字拒绝损坏响应，不启动或修复任何服务。"""
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('audit_doctor', ROOT / 'native-bridge/doctor.py')
doctor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(doctor)


class DoctorProtocolTests(unittest.TestCase):
    def test_malformed_browser_list_is_reported_as_protocol_failure(self):
        for browsers in (None, {}, 'invalid', [None]):
            with self.subTest(browsers=browsers), tempfile.TemporaryDirectory(dir='/tmp') as work:
                home = Path(work)
                data = home / 'plugin-data/browser-link-native'
                data.mkdir(parents=True)
                (data / 'token').write_text('synthetic-token')
                (data / 'token').chmod(0o600)
                server = socket.socket(socket.AF_UNIX)
                server.bind(str(data / 'bridge.sock'))
                server.listen()
                server.settimeout(2)

                def serve():
                    with server.accept()[0] as conn, conn.makefile('rb') as reader:
                        reader.readline()
                        for result in ({'ok': True, 'protocolVersion': 1}, browsers):
                            request = json.loads(reader.readline())
                            conn.sendall((json.dumps({'id': request['id'], 'result': result}) + '\n').encode())

                worker = threading.Thread(target=serve)
                worker.start()
                try:
                    result = doctor.diagnose(home, home / 'user')
                    self.assertFalse(result['ok'])
                    self.assertEqual(next(row['code'] for row in result['checks'] if row['component'] == 'host'),
                                     'invalid_response')
                    self.assertNotIn('synthetic-token', json.dumps(result))
                    self.assertEqual(set(data.iterdir()), {data / 'token', data / 'bridge.sock'})
                finally:
                    worker.join(3)
                    server.close()

    def test_non_object_manifest_is_invalid_instead_of_crashing(self):
        with tempfile.TemporaryDirectory() as work:
            home = Path(work)
            manifest = home / 'Library/Application Support/Google/Chrome/NativeMessagingHosts' / (doctor.HOST + '.json')
            manifest.parent.mkdir(parents=True)
            for value in ([], None, 1):
                manifest.write_text(json.dumps(value))
                result = doctor.diagnose(home / 'hermes', home)
                self.assertFalse(result['ok'])
                self.assertEqual(next(row['code'] for row in result['checks'] if row['component'] == 'chrome'),
                                 'manifest_invalid')


if __name__ == '__main__':
    unittest.main()
