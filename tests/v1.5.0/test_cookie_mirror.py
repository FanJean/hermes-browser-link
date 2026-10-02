"""中文注释：无 socket 的 daemon 回归，仅使用临时目录和合成凭据。"""
import contextlib
import importlib.util
import io
import json
import logging
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'native-bridge'))
from cookie_mirror import OneUseRelay, CookieMirrorService, MirrorDenied, selection
from daemon import BridgeDaemon, ProtocolError, _safe_error_data
from client import BridgeError
SECRET = '_'.join(('SECRET', 'COOKIE', 'VALUE', 'xyz'))


def wait_for(predicate):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.005)
    raise AssertionError('state did not settle')


class CookieMirrorTests(unittest.TestCase):
    def test_private_extension_error_never_exposes_browser_text_or_code(self):
        # 中文注释：直接覆盖 daemon 的真实私有 RPC 错误路径，不依赖 socket 或浏览器。
        with tempfile.TemporaryDirectory() as home:
            daemon = BridgeDaemon(Path(home))
            extension = {'pending': {}, 'pendingLock': threading.RLock()}
            def send(ext, request):
                daemon._accept_extension_response(ext, {'id': request['id'], 'error': {
                    'code': SECRET, 'message': SECRET, 'data': {'success': 1, 'cookie': SECRET,
                        'candidates': [{'role': SECRET, 'name': SECRET}]}}})
            daemon._send_extension = send
            with self.assertRaises(ProtocolError) as caught:
                daemon._extension_call(extension, 'browser.cookie_mirror.finish', {'transferId': 'a' * 32})
            self.assertEqual(caught.exception.code, 'cookie_mirror_denied')
            self.assertEqual(caught.exception.data, {'success': 1})
            self.assertNotIn(SECRET, str(caught.exception))
            self.assertFalse(extension['pending'])

    def test_counts_and_categories_cross_daemon_client_and_tool_errors(self):
        # 中文注释：走完整错误白名单；计数和类别保留，Cookie、诊断原文及恶意字段删除。
        raw = {'success': 2, 'failed': 1, 'matched': 1, 'missing': 1, 'cookie': SECRET,
               'reasons': {'write_failed': 1, SECRET: 9}, 'error': SECRET,
               'sites': [{'site': 'example.com', 'success': 2, 'failed': 1, 'matched': 1,
                          'missing': 1, 'cleared': 3, 'clearFailed': 0, 'cookie': SECRET,
                          'reasons': {'write_failed': 1, SECRET: 9}}],
               'currentOrigin': 'https://example.com', 'stage': 'overlay', 'reasonCode': 'initialization_exception'}
        safe = _safe_error_data(raw)
        protocol_error = ProtocolError('cookie_mirror_denied', SECRET, {**raw,
            'candidates': [{'role': SECRET, 'name': SECRET}]})
        self.assertNotIn(SECRET, str(protocol_error))
        self.assertNotIn('candidates', protocol_error.data)
        error = BridgeError(protocol_error.code, SECRET, protocol_error.data)
        self.assertNotIn(SECRET, str(error))
        self.assertEqual(error.data['sites'][0]['cleared'], 3)
        self.assertEqual(error.data['reasons'], {'write_failed': 1})
        self.assertNotIn('currentOrigin', error.data)
        self.assertNotIn('stage', error.data)
        spec = importlib.util.spec_from_file_location('mirror_native_tools', ROOT / 'executor-plugin/native_tools.py')
        tools = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tools)
        from types import SimpleNamespace
        profile = SimpleNamespace(authority=SimpleNamespace(consume=lambda *a, **k:
            SimpleNamespace(owner='owner', tool_call_id='call')), call=lambda *a: (_ for _ in ()).throw(error))
        result = json.loads(tools.make_tool_handler('browser_shared_cookie_mirror', profile)(
            {'action': 'status', 'transfer_id': 'a' * 32}))
        self.assertEqual((result['success'], result['failed'], result['matched'], result['missing']), (2, 1, 1, 1))
        self.assertEqual(result['sites'][0]['reasons'], {'write_failed': 1})
        self.assertEqual(result['code'], 'cookie_mirror_denied')
        self.assertFalse(result['retryable'])
        self.assertTrue(result['outcome_unknown'])
        self.assertNotIn(SECRET, json.dumps([safe, error.data, result]))

    def test_mirror_action_validation_reports_only_field_names(self):
        # 中文注释：Cookie 新工具沿用 main 的按动作必填字段契约，禁止回显传入值。
        spec = importlib.util.spec_from_file_location('mirror_validation_tools', ROOT / 'executor-plugin/native_tools.py')
        tools = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tools)
        for args, code, fields in [({'action': 'request_mirror', 'source': 's'}, 'missing_fields', ['sites', 'target']),
                ({'action': 'list_sites', 'source': 's', 'target': SECRET}, 'invalid_fields', ['target']),
                ({'action': 'status', 'transfer_id': 'a' * 32, 'source': SECRET}, 'invalid_fields', ['source'])]:
            with self.subTest(action=args['action']), self.assertRaises(tools.ArgumentFieldsError) as caught:
                tools._validate('browser_shared_cookie_mirror', args)
            self.assertEqual(caught.exception.code, code)
            self.assertEqual(caught.exception.fields, fields)
            self.assertNotIn(SECRET, str(caught.exception))

    def make_daemon(self, home, fail=None):
        daemon = BridgeDaemon(Path(home))
        daemon._prepare_data_dir()
        daemon.extensions = {key: {'instanceId': key, 'browser': browser, 'features': ['cookie_mirror_v1']}
                             for key, browser in [('s', 'chrome'), ('t', 'edge')]}
        source = [{'name': 'login', 'value': SECRET, 'domain': 'example.com', 'path': '/', 'httpOnly': True}]
        approved = set()
        target = {}
        calls = []
        def call(ext, method, p, timeout):
            action = method.rsplit('.', 1)[-1]
            calls.append((ext['instanceId'], action))
            if fail == (ext['instanceId'], action):
                raise RuntimeError(SECRET)
            if action == 'list_sites':
                return {'sites': [{'site': 'example.com', 'count': 1, 'cookie': SECRET}], 'value': SECRET}
            if action == 'prepare':
                return {'sites': [{'site': 'example.com', 'count': 1}], 'count': 1, 'chunks': 1, 'cookie': SECRET}
            if action == 'take':
                if p['transferId'] not in approved:
                    raise RuntimeError(SECRET)
                return {'index': p['index'], 'cookies': list(source)}
            if action == 'begin':
                target[p['transferId']] = []
                return {'ready': True}
            if action == 'stage':
                target[p['transferId']].extend(p['cookies'])
                return {'accepted': True}
            if action == 'finish':
                return {'sites': [{'site': 'example.com', 'success': 1, 'failed': 0, 'matched': 1,
                                  'missing': 0, 'cleared': 0, 'clearFailed': 0, 'reasons': {}, 'cookie': SECRET}], 'value': SECRET}
            if action == 'destroy':
                target.pop(p['transferId'], None)
                return {'destroyed': True}
            raise AssertionError('unexpected private method')
        daemon._extension_call = call
        return daemon, approved, target, calls

    def request(self, daemon):
        result = daemon._dispatch_client('browser.cookie_mirror', {'owner': 'owner', 'action': 'request_mirror',
            'source': 's', 'target': 't', 'sites': ['example.com'], 'options': {}})
        wait_for(lambda: daemon.cookie_mirror.status(result['transferId'], owner='owner')['status'] != 'preparing')
        return result['transferId']

    def test_relay_take_once_expiration_and_cancel(self):
        clock = [100.0]
        relay = OneUseRelay(lambda: clock[0])
        relay.put('x', 0, [SECRET], 160)
        self.assertEqual(relay.take('x', 0), [SECRET])
        with self.assertRaises(MirrorDenied):
            relay.take('x', 0)
        with self.assertRaises(MirrorDenied):
            relay.put('x', 0, [SECRET], 160)
        relay.put('x', 1, [SECRET], 160)
        clock[0] = 160
        relay.expire()
        self.assertFalse(relay.chunks)
        with self.assertRaises(MirrorDenied):
            relay.take('x', 1)
        relay.put('y', 0, [SECRET], 220)
        relay.destroy('y')
        self.assertFalse(relay.chunks)

    def test_confirmation_scope_owner_and_single_use(self):
        with tempfile.TemporaryDirectory() as home:
            daemon, approved, target, calls = self.make_daemon(home)
            transfer = self.request(daemon)
            self.assertNotIn(('s', 'take'), calls)
            with self.assertRaises(MirrorDenied):
                daemon.cookie_mirror.status(transfer, owner='other')
            with self.assertRaises(MirrorDenied):
                daemon.cookie_mirror.decide('t', {'transferId': transfer, 'approve': True})
            with self.assertRaises(ProtocolError):
                daemon._dispatch_client('extension.cookie_mirror.decide', {'transferId': transfer, 'approve': True})
            approved.add(transfer)
            daemon._cookie_mirror_extension('s', 'extension.cookie_mirror.decide', {'transferId': transfer, 'approve': True})
            wait_for(lambda: daemon.cookie_mirror.status(transfer, owner='owner')['status'] == 'completed')
            wait_for(lambda: not target)
            result = daemon._dispatch_client('browser.cookie_mirror', {'action': 'status', 'owner': 'owner', 'transferId': transfer})
            self.assertEqual((result['success'], result['matched'], result['missing']), (1, 1, 0))
            self.assertNotIn(SECRET, json.dumps(result))
            self.assertFalse(daemon.cookie_mirror.relay.chunks)
            with self.assertRaises(MirrorDenied):
                daemon.cookie_mirror.decide('s', {'transferId': transfer, 'approve': True})
            self.assertEqual(calls.count(('s', 'take')), 1)

    def test_any_endpoint_failure_destroys_both_sides_and_fixed_error(self):
        for fail in [('s', 'prepare'), ('s', 'take'), ('t', 'stage'), ('t', 'finish')]:
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as home:
                daemon, approved, target, calls = self.make_daemon(home, fail)
                transfer = self.request(daemon)
                if fail[1] != 'prepare':
                    approved.add(transfer)
                    daemon.cookie_mirror.decide('s', {'transferId': transfer, 'approve': True})
                wait_for(lambda: daemon.cookie_mirror.status(transfer, owner='owner')['status'] == 'failed')
                wait_for(lambda: ('s', 'destroy') in calls and ('t', 'destroy') in calls and not target)
                self.assertFalse(daemon.cookie_mirror.relay.chunks)
                self.assertNotIn(SECRET, json.dumps(daemon.cookie_mirror.status(transfer, owner='owner')))

    def test_rejection_expiry_and_disconnect(self):
        for scenario in ['denied', 'expired', 'disconnected']:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as home:
                daemon, approved, target, calls = self.make_daemon(home)
                transfer = self.request(daemon)
                if scenario == 'denied':
                    result = daemon.cookie_mirror.decide('s', {'transferId': transfer, 'approve': False})
                    self.assertEqual(result['status'], 'denied')
                elif scenario == 'expired':
                    daemon.cookie_mirror.expire(transfer)
                    with self.assertRaises(MirrorDenied):
                        daemon.cookie_mirror.status(transfer, owner='owner')
                else:
                    daemon.cookie_mirror.relay.put(transfer, 0, [SECRET], time.monotonic() + 60)
                    daemon.cookie_mirror.disconnected('t')
                    self.assertEqual(daemon.cookie_mirror.status(transfer, owner='owner')['reason'], 'disconnected')
                wait_for(lambda: ('s', 'destroy') in calls and ('t', 'destroy') in calls)
                self.assertNotIn(('s', 'take'), calls)
                self.assertFalse(daemon.cookie_mirror.relay.chunks)

    def test_values_absent_from_outputs_logs_diagnostics_ledger_and_disk(self):
        with tempfile.TemporaryDirectory() as home:
            daemon, approved, target, calls = self.make_daemon(home)
            # 中文注释：先启用真实诊断落盘，再验证镜像不会新增诊断或泄露 Cookie 值。
            daemon._diagnostic('connection_state', 'connected')
            self.assertIsNotNone(daemon.diagnostics)
            diagnostics_before = {p: p.read_bytes() for p in (daemon.data_dir / 'diagnostics').rglob('*') if p.is_file()}
            stream = io.StringIO()
            log = logging.StreamHandler(stream)
            logging.getLogger().addHandler(log)
            try:
                with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
                    listed = daemon._dispatch_client('browser.cookie_mirror', {'owner': 'owner', 'action': 'list_sites', 'source': 's'})
                    transfer = self.request(daemon)
                    approved.add(transfer)
                    daemon.cookie_mirror.decide('s', {'transferId': transfer, 'approve': True})
                    wait_for(lambda: daemon.cookie_mirror.status(transfer, owner='owner')['status'] == 'completed')
                    wait_for(lambda: not target)
                    result = daemon.cookie_mirror.status(transfer, owner='owner')
                    daemon._persist_tasks()
                    daemon._flush_tasks()
                public = json.dumps([listed, result, daemon.tasks, daemon.pending_journal, daemon.inflight_requests,
                                     list(daemon.result_cache.items()), daemon.action_approvals, stream.getvalue()])
                self.assertNotIn(SECRET, public)
                self.assertEqual(diagnostics_before,
                    {p: p.read_bytes() for p in (daemon.data_dir / 'diagnostics').rglob('*') if p.is_file()})
                for file in Path(home).rglob('*'):
                    if file.is_file():
                        self.assertNotIn(SECRET.encode(), file.read_bytes(), str(file.relative_to(home)))
                # 中文注释：全仓源文件也不落入标记值；夹具通过分段字符串在内存构造。
                scan = __import__('subprocess').run(['rg', '--files', '-g', '!node_modules/**', '-g', '!.git/**'], cwd=ROOT, capture_output=True, text=True, check=True)
                for relative in scan.stdout.splitlines():
                    path = ROOT / relative
                    if path.is_file():
                        self.assertNotIn(SECRET.encode(), path.read_bytes(), relative)
            finally:
                logging.getLogger().removeHandler(log)

    def test_disconnect_during_prepare_does_not_restore_approval(self):
        with tempfile.TemporaryDirectory() as home:
            daemon, approved, target, calls = self.make_daemon(home)
            original = daemon._extension_call
            def disconnect(ext, method, params, timeout):
                if method.endswith('.prepare'):
                    daemon.cookie_mirror.disconnected('t')
                return original(ext, method, params, timeout)
            daemon._extension_call = disconnect
            transfer = self.request(daemon)
            wait_for(lambda: ('t', 'destroy') in calls)
            self.assertEqual(daemon.cookie_mirror.status(transfer, owner='owner')['status'], 'failed')
            self.assertNotIn(('s', 'take'), calls)

    def test_closed_result_projection_rejects_arbitrary_reason_and_count(self):
        op = {'sites': ['example.com'], 'count': 1}
        raw = {'sites': [{'site': 'example.com', 'success': 1, 'failed': 0, 'matched': 1, 'missing': 0,
                         'cleared': 0, 'clearFailed': 0, 'reasons': {SECRET: 1}}]}
        with self.assertRaises(MirrorDenied):
            CookieMirrorService.result_view(raw, op)
        raw['sites'][0]['reasons'] = {}
        raw['sites'][0]['success'] = SECRET
        with self.assertRaises(MirrorDenied):
            CookieMirrorService.result_view(raw, op)
        with self.assertRaises(MirrorDenied):
            selection(['example.com'], {'approved': True})


if __name__ == '__main__':
    unittest.main()
