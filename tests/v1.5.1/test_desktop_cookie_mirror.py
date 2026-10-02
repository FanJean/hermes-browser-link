"""中文注释：桌面 HTTP → 真实 runtime/daemon 的合成镜像测试，不启动浏览器或 socket。"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'native-bridge'))
from daemon import BridgeDaemon

SOURCE, TARGET = 'a' * 32, 'b' * 32
SECRET = '_'.join(('SECRET', 'COOKIE', 'VALUE'))
PREFIX = '/api/plugins/browser-link/shared'


def wait_for(predicate):
    until = time.monotonic() + 3
    while time.monotonic() < until:
        if predicate():
            return
        time.sleep(.005)
    raise AssertionError('镜像状态未完成流转')


class DesktopCookieMirrorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        spec = importlib.util.spec_from_file_location('desktop_cookie_api', ROOT / 'executor-plugin/dashboard/plugin_api.py')
        self.api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.api)
        self.daemon = BridgeDaemon(Path(self.tmp.name))
        self.daemon.extensions = {key: {'instanceId': key, 'browser': 'chrome', 'features': ['cookie_mirror_v1']}
                                  for key in (SOURCE, TARGET)}
        self.calls, self.private, self.approved = [], [], set()
        self.executing = threading.Event()
        self.finish = threading.Event()
        self.finish.set()
        self.fail_prepare = False
        self.override = None
        self.daemon._extension_call = self.extension_call

        class Bridge:
            def call(_, method, params):
                self.calls.append((method, dict(params)))
                if self.override is not None:
                    return self.override
                return self.daemon._dispatch_client(method, params)

        runtime_module = self.api._native_tools().runtime_module()
        self.runtime = runtime_module.NativeProfileRuntime(Path(self.tmp.name), ROOT / 'executor-plugin', bridge_client=Bridge())
        self.addCleanup(self.runtime.close)
        self.api._native_profile_runtime = lambda: self.runtime
        self.api._runtime_profile_selector_matches = lambda selector: selector == 'test-profile'
        app = FastAPI()
        app.include_router(self.api.router, prefix='/api/plugins/browser-link')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.addCleanup(self.finish.set)

    def extension_call(self, ext, method, params, timeout):
        # 中文注释：只有模拟源扩展批准后才允许读出合成值，HTTP 没有批准通路。
        action = method.rsplit('.', 1)[-1]
        self.private.append((ext['instanceId'], action))
        if action == 'list_sites':
            return {'sites': [{'site': 'example.com', 'count': 1, 'httpOnly': True, 'session': True,
                               'value': SECRET}], 'cookies': [SECRET]}
        if action == 'prepare':
            if self.fail_prepare:
                raise RuntimeError(SECRET)
            return {'sites': [{'site': 'example.com', 'count': 1}], 'count': 1, 'chunks': 1, 'value': SECRET}
        if action == 'begin':
            self.executing.set()
            self.finish.wait(3)
            return {'ready': True}
        if action == 'take':
            if params['transferId'] not in self.approved:
                raise RuntimeError(SECRET)
            return {'index': 0, 'cookies': [{'domain': 'example.com', 'name': 'auth', 'value': SECRET}]}
        if action == 'stage':
            return {'accepted': True}
        if action == 'finish':
            return {'sites': [{'site': 'example.com', 'success': 1, 'failed': 0, 'matched': 1, 'missing': 0,
                              'cleared': 0, 'clearFailed': 0, 'reasons': {}, 'value': SECRET}], 'value': SECRET}
        if action == 'destroy':
            return {'destroyed': True}
        raise AssertionError('unexpected mirror action')

    def response(self, method, path, **kwargs):
        response = getattr(self.client, method)(PREFIX + path, **kwargs)
        self.assertNotIn(SECRET, response.text)
        return response

    def request(self):
        response = self.response('post', '/cookie-mirror', json={
            'source': SOURCE, 'target': TARGET, 'sites': ['example.com'], 'options': {}})
        self.assertEqual(response.status_code, 200, response.text)
        transfer = response.json()['transferId']
        wait_for(lambda: self.daemon.cookie_mirror.status(transfer)['status'] != 'preparing')
        return transfer

    def status(self, transfer):
        return self.response('get', '/cookie-mirror/' + transfer)

    def test_inventory_only_site_count_flags_and_no_values(self):
        response = self.response('get', f'/browsers/{SOURCE}/cookie-sites')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'sites': [{'site': 'example.com', 'count': 1, 'httpOnly': True, 'session': True}]})
        self.assertEqual(self.calls[-1][1]['owner'], self.runtime.authority.ui_owner())
        self.override = {'sites': [{'site': 'example.com', 'count': SECRET}]}
        self.assertEqual(self.response('get', f'/browsers/{SOURCE}/cookie-sites').status_code, 503)
        self.override = {'sites': [{'site': 'example.com', 'count': 1, 'httpOnly': SECRET}]}
        self.assertEqual(self.response('get', f'/browsers/{SOURCE}/cookie-sites').status_code, 503)

    def test_request_waits_for_source_extension_then_executing_completed_counts(self):
        transfer = self.request()
        self.assertEqual(self.status(transfer).json()['status'], 'approval_required')
        self.assertNotIn((SOURCE, 'take'), self.private)
        self.assertEqual(self.calls[0][1]['owner'], self.runtime.authority.ui_owner())
        self.finish.clear()
        self.approved.add(transfer)
        self.daemon._cookie_mirror_extension(SOURCE, 'extension.cookie_mirror.decide', {'transferId': transfer, 'approve': True})
        self.assertTrue(self.executing.wait(3))
        self.assertEqual(self.status(transfer).json()['status'], 'executing')
        self.finish.set()
        wait_for(lambda: self.daemon.cookie_mirror.status(transfer)['status'] == 'completed')
        result = self.status(transfer).json()
        self.assertEqual((result['success'], result['failed'], result['matched'], result['missing']), (1, 0, 1, 0))
        self.assertFalse(self.daemon.cookie_mirror.relay.chunks)
        self.assertEqual(sum(params['action'] == 'request_mirror' for _, params in self.calls), 1)

    def test_rejected_expired_prepare_failure_and_disconnect(self):
        transfer = self.request()
        self.daemon._cookie_mirror_extension(SOURCE, 'extension.cookie_mirror.decide', {'transferId': transfer, 'approve': False})
        self.assertEqual(self.status(transfer).json()['status'], 'denied')
        self.daemon.cookie_mirror.expire(transfer)
        self.assertEqual(self.status(transfer).status_code, 503)
        self.fail_prepare = True
        failed = self.request()
        self.assertEqual(self.status(failed).json()['reason'], 'transfer_failed')
        self.fail_prepare = False
        disconnected = self.request()
        self.daemon.cookie_mirror.disconnected(TARGET)
        self.assertEqual(self.status(disconnected).json()['reason'], 'disconnected')
        self.assertNotIn((SOURCE, 'take'), self.private)

    def test_http_cannot_supply_identity_approval_or_cookie_payload_including_validation_errors(self):
        good = {'source': SOURCE, 'target': TARGET, 'sites': ['example.com']}
        for body in [{**good, key: SECRET} for key in ('owner', 'approve', 'cookies', 'action', 'transferId', 'profile')] + [
            {**good, 'target': SOURCE}, {**good, 'sites': [SECRET]},
            {**good, 'sites': ['example.com'] * 2}, {**good, 'options': {'persistDays': SECRET}},
            {**good, 'options': {'clearTarget': SECRET}}, {**good, 'options': {'persistDays': 0}},
            {**good, 'options': {'persistDays': 366}}, {**good, 'options': {'approve': SECRET}},
            {**good, 'source': {'value': SECRET}}, {**good, 'sites': []}]:
            with self.subTest(fields=list(body)):
                self.assertEqual(self.response('post', '/cookie-mirror', json=body).status_code, 422)
        self.assertEqual(self.response('post', '/cookie-mirror', content=SECRET).status_code, 422)
        for path in [f'/browsers/{SOURCE}/cookie-sites', '/cookie-mirror', '/cookie-mirror/' + 'c' * 32]:
            method = 'post' if path == '/cookie-mirror' else 'get'
            for query in ('?owner=' + SECRET, '?profile=other', '?profile=test-profile&profile=test-profile'):
                self.assertEqual(self.response(method, path + query, **({'json': good} if method == 'post' else {})).status_code, 422)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.response('get', '/cookie-mirror/' + SECRET).status_code, 422)
        self.assertEqual(self.response('get', f'/browsers/{SOURCE}/cookie-sites?profile=test-profile').status_code, 200)

    def test_foreign_owner_status_is_inaccessible_and_status_projection_drops_unlisted_fields(self):
        transfer = self.request()
        op = self.daemon.cookie_mirror.operations[transfer]
        op['owner'] = 'foreign-owner'
        self.assertEqual(self.status(transfer).status_code, 503)
        self.override = {'transferId': transfer, 'source': SOURCE, 'target': TARGET, 'status': 'completed',
                         'expiresAt': time.time() + 60, 'success': 1, 'failed': 1, 'matched': 1, 'missing': 0,
                         'value': SECRET, 'owner': SECRET, 'error': SECRET,
                         'sites': [{'site': 'example.com', 'success': 1, 'value': SECRET,
                                    'reasons': {'write_failed': 1, SECRET: 3}}]}
        result = self.status(transfer).json()
        self.assertEqual(result['sites'][0]['reasons'], {'write_failed': 1})
        self.assertNotIn('owner', result)
        for key in ('success', 'status', 'expiresAt', 'source'):
            valid = self.override[key]
            self.override[key] = SECRET
            self.assertEqual(self.status(transfer).status_code, 503)
            self.override[key] = valid


if __name__ == '__main__':
    unittest.main()
