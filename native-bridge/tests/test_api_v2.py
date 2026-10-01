"""Synthetic-only v2 API tests. Never inspect user credentials."""
import importlib.util
import json
import secrets
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import daemon


class ApiTests(unittest.TestCase):
    def test_page_request_uses_smart_approval_or_full_and_clears_private_memory(self):
        import tempfile
        with tempfile.TemporaryDirectory(dir=Path.home() / '.hermes/cache/scratch') as home:
            d = daemon.BridgeDaemon(Path(home))
            d._prepare_data_dir()
            d.extensions['fixture'] = {'browser': 'chrome'}
            d._notify_tasks_changed = lambda _: None
            t = d._create_task({'owner': 'trusted', 'title': 'fixture', 'instanceId': 'fixture', 'allowedOrigins': ['https://example.com']})
            d._dispatch_extension('fixture', 'extension.approve', {'taskId': t['id'], 'tabIds': [1], 'allowedOrigins': t['allowedOrigins']})
            p = {'owner': 'trusted', 'taskId': t['id'], 'requestId': 'first', 'action': 'api_request', 'tabId': 1, 'url': 'https://example.com/api', 'fields': ['count']}
            self.assertEqual(d._run_task(p)['status'], 'approval_required')
            # 中文注释：切到全部访问后同源页面请求直接执行，不要求另一个 API 开关。
            d._dispatch_extension('fixture', 'extension.mode', {'taskId': t['id'], 'generation': t['generation'], 'modeGeneration': t['modeGeneration'], 'mode': 'full'})
            private = secrets.token_hex(24)
            d._extension_call = lambda *a, **kw: {'cookies': [{'name': 'sid', 'value': private}]}
            class Local:
                def request(self, url, method, fields, cookies, valid, track):
                    assert cookies[0]['value'] == private
                    assert valid()
                    assert d.api_credentials
                    return {'status': 200, 'data': {'count': 3}}
            d.api_client = Local()
            p['requestId'] = 'second'
            self.assertEqual(d._run_task(p), {'status': 200, 'data': {'count': 3}})
            self.assertFalse(d.api_credentials)
            # 中文注释：任务快照按短窗口异步落盘；显式刷新后再检查文件中没有凭据。
            d._flush_tasks()
            self.assertNotIn(private, d.tasks_path.read_text())
            d._revoke_task_locked(d.tasks[t['id']], 'cancelled')
            self.assertNotIn('apiBridgeApproved', d.tasks[t['id']])
            d._flush_tasks()

    def test_legacy_api_authorization_fields_are_rejected(self):
        import tempfile
        with tempfile.TemporaryDirectory(dir=Path.home() / '.hermes/cache/scratch') as home:
            d = daemon.BridgeDaemon(Path(home)); d._prepare_data_dir()
            d.extensions['fixture'] = {'browser': 'chrome'}
            d._notify_tasks_changed = lambda _: None
            with self.assertRaises(daemon.ProtocolError):
                d._create_task({'owner': 'a', 'title': 'fixture', 'instanceId': 'fixture', 'allowedOrigins': ['https://example.com'], 'apiUrls': ['https://example.com/api']})
            t = d._create_task({'owner': 'a', 'title': 'fixture', 'instanceId': 'fixture', 'allowedOrigins': ['https://example.com']})
            p = {'taskId': t['id'], 'tabIds': [1], 'allowedOrigins': t['allowedOrigins'], 'apiBridgeApproved': True, 'generation': 0}
            with self.assertRaises(daemon.ProtocolError): d._dispatch_extension('fixture', 'extension.approve', p)
            p['generation'] = t['generation']
            with self.assertRaises(daemon.ProtocolError): d._dispatch_extension('fixture', 'extension.approve', p)
            p.pop('apiBridgeApproved'); p['allowedOrigins'] = ['https://other.example']
            with self.assertRaises(daemon.ProtocolError): d._dispatch_extension('fixture', 'extension.approve', p)
            # 中文注释：离开临时目录前完成异步任务快照，避免后台线程写入已删除路径。
            d._flush_tasks()

    def test_absolute_deadline_interrupts_slow_response_headers(self):
        import time
        from api_client import ApiClient, ApiDenied
        class Slow(BaseHTTPRequestHandler):
            def log_message(self, format, *args): pass
            def do_GET(self):
                try:
                    for byte in b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}':
                        self.connection.sendall(bytes([byte])); time.sleep(.15)
                except OSError: pass
        site = ThreadingHTTPServer(('127.0.0.1', 0), Slow)
        threading.Thread(target=site.serve_forever, daemon=True).start()
        self.addCleanup(site.server_close); self.addCleanup(site.shutdown)
        origin = f'http://127.0.0.1:{site.server_port}'
        prefix = '/__hermes_api_fixture__/' + secrets.token_hex(16) + '/'
        start = time.monotonic()
        with self.assertRaises(ApiDenied):
            ApiClient(fixture=(origin, prefix)).request(origin + prefix + 'slow', 'GET', ['count'], [], lambda: True, lambda c: None)
        self.assertLess(time.monotonic() - start, 6.5, 'response headers escaped total deadline')

    def test_cancellation_interrupts_detached_response_socket(self):
        import time
        from concurrent.futures import ThreadPoolExecutor
        from api_client import ApiClient, ApiDenied
        started = threading.Event()
        finish = threading.Event()
        class Slow(BaseHTTPRequestHandler):
            def log_message(self, format, *args): pass
            def do_GET(self):
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                started.set(); finish.wait(10)
        site = ThreadingHTTPServer(('127.0.0.1', 0), Slow)
        threading.Thread(target=site.serve_forever, daemon=True).start()
        self.addCleanup(site.server_close); self.addCleanup(site.shutdown); self.addCleanup(finish.set)
        origin = f'http://127.0.0.1:{site.server_port}'
        prefix = '/__hermes_api_fixture__/' + secrets.token_hex(16) + '/'
        tracked = []
        revoked = threading.Event()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(ApiClient(fixture=(origin, prefix)).request, origin + prefix + 'slow', 'GET', ['count'], [], lambda: not revoked.is_set(), tracked.append)
            self.assertTrue(started.wait(2)); time.sleep(.05)
            # Same cleanup operation as the daemon task revocation boundary.
            start = time.monotonic()
            handle = tracked[0]
            abort = getattr(handle, '_api_abort', handle.close)
            revoked.set(); abort()
            with self.assertRaises(ApiDenied): future.result(timeout=1)
            self.assertLess(time.monotonic() - start, 1)

    def test_revoked_transport_never_reconnects_implicitly(self):
        from api_client import ApiClient, ApiDenied
        hits = []
        class Site(BaseHTTPRequestHandler):
            def log_message(self, format, *args): pass
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(b'{"count": 3}')
        site = ThreadingHTTPServer(('127.0.0.1', 0), Site)
        threading.Thread(target=site.serve_forever, daemon=True).start()
        self.addCleanup(site.server_close); self.addCleanup(site.shutdown)
        origin = f'http://127.0.0.1:{site.server_port}'
        prefix = '/__hermes_api_fixture__/' + secrets.token_hex(16) + '/'
        handles, checks = [], []
        def valid():
            checks.append(True)
            if len(checks) == 2: handles[0].close()
            return True
        with self.assertRaises(ApiDenied):
            ApiClient(fixture=(origin, prefix)).request(origin + prefix + 'api', 'GET', ['count'], [], valid, handles.append)
        self.assertEqual(hits, [])

    def test_dns_rejects_any_private_address_and_fixture_is_exact(self):
        from unittest.mock import patch
        from api_client import ApiClient, ApiDenied
        import socket
        for address in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1', '0.0.0.0']:
            answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443)), (socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443))]
            with patch('api_client.socket.getaddrinfo', return_value=answers), self.assertRaises(ApiDenied):
                ApiClient().target('https://example.com/api')
        with self.assertRaises(ValueError): ApiClient(fixture=('http://127.0.0.1:1234', '/'))
        with self.assertRaises(ValueError): ApiClient(fixture=('http://10.0.0.1:1234', '/__hermes_api_fixture__/' + 'a'*32 + '/'))

    def test_body_cap_no_retry_and_memory_cleanup_on_cancel_race(self):
        from api_client import ApiClient, ApiDenied
        hits = []
        class Huge(BaseHTTPRequestHandler):
            def log_message(self, format, *args): pass
            def do_GET(self):
                hits.append(1)
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                try: self.wfile.write(b'{"value":"' + b'x'*70000 + b'"}')
                except OSError: pass
        site = ThreadingHTTPServer(('127.0.0.1', 0), Huge)
        threading.Thread(target=site.serve_forever, daemon=True).start()
        self.addCleanup(site.server_close); self.addCleanup(site.shutdown)
        origin = f'http://127.0.0.1:{site.server_port}'
        prefix = '/__hermes_api_fixture__/' + secrets.token_hex(16) + '/'
        with self.assertRaises(ApiDenied): ApiClient(fixture=(origin, prefix)).request(origin+prefix+'big', 'GET', ['value'], [], lambda: True, lambda c: None)
        self.assertEqual(hits, [1])
        import tempfile
        with tempfile.TemporaryDirectory(dir=Path.home() / '.hermes/cache/scratch') as home:
            d = daemon.BridgeDaemon(Path(home)); d._prepare_data_dir()
            extension = {'browser': 'chrome'}; d.extensions['fixture'] = extension; d._notify_tasks_changed = lambda _: None
            t = d._create_task({'owner': 'a', 'title': 'fixture', 'instanceId': 'fixture', 'allowedOrigins': ['https://example.com']})
            d._dispatch_extension('fixture', 'extension.approve', {'taskId': t['id'], 'tabIds': [1], 'allowedOrigins': t['allowedOrigins']})
            d._dispatch_extension('fixture', 'extension.mode', {'taskId': t['id'], 'generation': t['generation'], 'modeGeneration': t['modeGeneration'], 'mode': 'full'})
            called = []
            class Never:
                def request(self, *args): called.append(1); raise AssertionError('revoked credentials used')
            d.api_client = Never()
            private = secrets.token_hex(24)
            def late_credentials(*args):
                d._revoke_task_locked(d.tasks[t['id']], 'cancelled')
                return {'cookies': [{'name': 'sid', 'value': private}]}
            d._extension_call = late_credentials
            with self.assertRaises(daemon.ProtocolError):
                d._run_task({'owner': 'a', 'taskId': t['id'], 'requestId': 'race', 'action': 'api_request', 'tabId': 1, 'url': 'https://example.com/api', 'fields': ['count']})
            self.assertEqual(called, [])
            self.assertFalse(d.api_credentials)
            # 中文注释：等待快照写入完成后验证磁盘文件不包含延迟到达的凭据。
            d._flush_tasks()
            self.assertNotIn(private, d.tasks_path.read_text())

    def test_local_client_filters_without_redirect_or_cookie_jar(self):
        self.assertTrue(hasattr(daemon, 'ApiClient'), 'v2 local API client not implemented')
        from api_client import ApiClient, ApiDenied
        value = secrets.token_hex(24)
        hits = []
        class Site(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                hits.append((self.path, self.headers.get('Cookie')))
                if self.path.endswith('/redirect'):
                    self.send_response(302); self.send_header('Location', '/escaped'); self.end_headers(); return
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Set-Cookie', 'never=stored')
                self.end_headers()
                self.wfile.write(json.dumps({'count': 3, 'private': 'hidden', 'echo': value, 'access_token': 'sensitive', 'nested': {'x': 1}}).encode())
        site = ThreadingHTTPServer(('127.0.0.1', 0), Site)
        threading.Thread(target=site.serve_forever, daemon=True).start()
        self.addCleanup(site.server_close); self.addCleanup(site.shutdown)
        origin = f'http://127.0.0.1:{site.server_port}'
        prefix = '/__hermes_api_fixture__/' + secrets.token_hex(16) + '/'
        client = ApiClient(fixture=(origin, prefix))
        result = client.request(origin + prefix + 'data', 'GET', ['count', 'echo', 'access_token', 'nested'], [{'name': 'sid', 'value': value}], lambda: True, lambda c: None)
        self.assertEqual(result, {'status': 200, 'data': {'count': 3, 'echo': '[REDACTED]', 'access_token': '[REDACTED]'}})
        self.assertEqual(hits[0][1], 'sid=' + value)
        with self.assertRaises(ApiDenied):
            client.request(origin + prefix + 'redirect', 'GET', ['count'], [], lambda: True, lambda c: None)
        self.assertEqual(len(hits), 2)
        with self.assertRaises(ApiDenied):
            client.request(origin + '/escaped', 'GET', ['count'], [], lambda: True, lambda c: None)
        with self.assertRaises(ApiDenied):
            ApiClient().request(origin + prefix + 'data', 'GET', ['count'], [], lambda: True, lambda c: None)

if __name__ == '__main__': unittest.main()
