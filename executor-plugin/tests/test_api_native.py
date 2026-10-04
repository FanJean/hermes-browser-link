"""Native API: trusted profile owner registry, never HTTP-selected identity."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
import importlib.util
import sys

API_PATH = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"


def load_api():
    name = "browser_link_api_under_test"
    sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(name, API_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("api module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

PREFIX = '/api/plugins/browser-link/shared'

class Bridge:
    def __init__(self):
        self.calls = []
        self.tasks = {}
    def call(self, method, params):
        self.calls.append((method, dict(params)))
        if method == 'browser.list':
            return [{'instanceId': 'connected', 'browser': 'edge', 'connected': True},
                    {'instanceId': 'offline', 'browser': 'chrome', 'connected': False}]
        if method == 'shared.list':
            return [dict(t) for t in self.tasks.values() if t['owner'] == params['owner']]
        if method == 'shared.create':
            task = dict(params, id='created', state='pending_approval', isolation='shared-profile')
            self.tasks[task['id']] = task
            return task
        task = self.tasks[params['taskId']]
        assert params['owner'] == task['owner'], 'API used the wrong owner'
        if method != 'shared.get':
            task['state'] = {'shared.cancel': 'cancelled', 'shared.resume': 'pending_approval', 'shared.close': 'closed'}[method]
        return dict(task)

class NativeApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.api = load_api()
        self.bridge = Bridge()
        # Use real authority and hook to seed trusted owner, not an HTTP identifier.
        import importlib.util
        path = Path(__file__).resolve().parents[1] / 'native_tools.py'
        spec = importlib.util.spec_from_file_location('native_api_test_tools', path)
        assert spec is not None and spec.loader is not None
        tools = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tools)
        self.runtime = tools.runtime_module().NativeProfileRuntime(Path(self.tmp.name), path.parent, bridge_client=self.bridge)
        self.runtime.authority.pre_tool_call('browser_shared_list', {}, session_id='trusted-session', tool_call_id='call-1')
        self.owner = self.runtime.authority.owner_for_session('trusted-session')
        self.bridge.tasks = {'tool-task': {'id': 'tool-task', 'owner': self.owner, 'state': 'ready'},
                             'foreign': {'id': 'foreign', 'owner': 'unregistered-owner', 'state': 'ready'}}
        self.api._native_profile_runtime = lambda: self.runtime
        app = FastAPI()
        app.include_router(self.api.router, prefix='/api/plugins/browser-link')
        self.client = TestClient(app)

    def test_list_and_controls_resolve_only_registered_native_owners(self):
        response = self.client.get(PREFIX + '/tasks')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([t['id'] for t in response.json()], ['tool-task'])
        self.assertNotIn('owner', response.text)
        self.assertEqual(self.client.get(PREFIX + '/tasks/tool-task').status_code, 200)
        for action, state in [('cancel', 'cancelled'), ('resume', 'pending_approval'), ('close', 'closed')]:
            response = self.client.post(PREFIX + '/tasks/tool-task/' + action, json={})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()['state'], state)
        self.assertEqual(self.client.get(PREFIX + '/tasks/foreign').status_code, 404)
        self.assertTrue(all(p.get('owner') in self.runtime.authority.known_owners() for _, p in self.bridge.calls))

    def test_cleanup_status_reconciles_without_releasing_and_get_preserves_counts(self):
        self.bridge.tasks['tool-task'].update(state='closed', cleanupState='unknown')
        original = self.bridge.call
        def call(method, params):
            if method == 'shared.cleanup_status':
                self.bridge.calls.append((method, dict(params)))
                self.assertEqual(params['owner'], self.owner)
                self.bridge.tasks['tool-task'].update(cleanupState='pending', cleanupRemainingCount=2,
                                                     cleanupPreservedCount=1, cleanupUnknownCount=0)
                return dict(self.bridge.tasks['tool-task'])
            return original(method, params)
        self.bridge.call = call
        response = self.client.get(PREFIX + '/tasks/tool-task/cleanup-status')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['cleanupRemainingCount'], 2)
        self.assertEqual(self.client.get(PREFIX + '/tasks/tool-task').json()['cleanupPreservedCount'], 1)
        self.assertNotIn('owner', response.json())
        self.assertFalse(any(m in ('shared.close', 'shared.cancel', 'shared.cleanup_retry') for m, _ in self.bridge.calls))
        self.assertEqual(self.client.get(PREFIX + '/tasks/foreign/cleanup-status').status_code, 404)
        self.bridge.calls.clear()
        self.assertEqual(self.client.get(PREFIX + '/tasks/tool-task/cleanup-status?owner=forged').status_code, 422)
        self.assertEqual(self.bridge.calls, [])

    def test_create_requires_connected_instance_and_exact_origins(self):
        self.assertEqual(self.client.get(PREFIX + '/browsers').status_code, 200)
        payload = {'title': '共享任务', 'instanceId': 'connected', 'allowedOrigins': ['https://example.org']}
        response = self.client.post(PREFIX + '/tasks', json=payload)
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()['state'], 'pending_approval')
        self.assertIn('扩展', response.json()['message'])
        self.assertEqual(self.bridge.tasks['created']['owner'], self.runtime.authority.ui_owner())
        for bad in [{'instanceId': 'offline'}, {'instanceId': ''}, {'allowedOrigins': ['https://example.org/path']},
                    {'allowedOrigins': ['https://user:pass@example.org']}, {'owner': 'forged'}, {'session_id': 'forged'}, {'approved': True}]:
            response = self.client.post(PREFIX + '/tasks', json=payload | bad)
            self.assertEqual(response.status_code, 422, response.text)

    def test_http_identity_and_approval_inputs_rejected_without_rpc(self):
        for path, method, kwargs in [('/tasks?owner=forged', 'get', {}), ('/tasks/tool-task?session_id=x', 'get', {}),
                                     ('/tasks/tool-task/cancel', 'post', {'json': {'owner': self.owner}}),
                                     ('/tasks/tool-task/resume?session=x', 'post', {}),
                                     ('/browsers?owner=x', 'get', {})]:
            self.bridge.calls.clear()
            response = getattr(self.client, method)(PREFIX + path, **kwargs)
            self.assertEqual(response.status_code, 422, response.text)
            self.assertEqual(self.bridge.calls, [])
        self.assertEqual(self.client.post(PREFIX + '/tasks/tool-task/approve').status_code, 404)

    def test_profile_query_matches_only_the_runtime_profile_across_shared_routes(self):
        # 中文注释：只在本测试导入期加入明确指定的真实源码，随后恢复完整路径顺序。
        hermes_root = Path(os.environ['HERMES_SOURCE']).resolve()
        original_path = sys.path[:]
        sys.path.insert(0, str(hermes_root))
        try:
            import hermes_constants
        finally:
            sys.path[:] = original_path
        self.assertEqual(sys.path, original_path)
        self.assertEqual(Path(hermes_constants.__file__).resolve(), hermes_root / 'hermes_constants.py')

        root = Path(self.tmp.name) / '.hermes'
        work_home = root / 'profiles' / 'work'
        original_call = self.bridge.call
        diagnostics = {
            'events': [], 'execution_state': 'ready', 'cleanup_state': 'unknown',
            'has_more': False, 'next_cursor': None,
        }

        def call(method, params):
            if method == 'shared.cleanup_status':
                self.bridge.calls.append((method, dict(params)))
                return dict(self.bridge.tasks[params['taskId']])
            if method == 'shared.diagnostics':
                self.bridge.calls.append((method, dict(params)))
                return diagnostics
            return original_call(method, params)

        self.bridge.call = call
        with patch.object(hermes_constants, 'get_default_hermes_root', return_value=root):
            with patch.object(hermes_constants, 'get_hermes_home', return_value=work_home):
                valid_requests = [
                    ('get', '/browsers?profile=work', {}),
                    ('get', '/tasks?profile=work', {}),
                    ('get', '/tasks/tool-task?profile=work', {}),
                    ('get', '/tasks/tool-task/cleanup-status?profile=work', {}),
                    ('get', '/tasks/tool-task/diagnostics?profile=work&limit=1', {}),
                    ('post', '/tasks/tool-task/cancel?profile=work', {'json': {}}),
                    ('post', '/tasks/tool-task/resume?profile=work', {'json': {}}),
                    ('post', '/tasks/tool-task/close?profile=work', {'json': {}}),
                ]
                for method, path, kwargs in valid_requests:
                    with self.subTest(method=method, path=path):
                        response = getattr(self.client, method)(PREFIX + path, **kwargs)
                        self.assertEqual(response.status_code, 200, response.text)

                invalid_requests = [
                    ('get', '/browsers?profile=default', {}),
                    ('get', '/tasks?profile=other', {}),
                    ('get', '/tasks/tool-task?profile=other', {}),
                    ('get', '/tasks/tool-task/diagnostics?profile=other&limit=1', {}),
                    ('post', '/tasks/tool-task/cancel?profile=other', {'json': {}}),
                    ('get', '/tasks?profile=work&profile=work', {}),
                    ('get', '/browsers?unexpected=1', {}),
                    ('get', '/tasks?owner=forged', {}),
                    ('get', '/tasks?session_id=forged', {}),
                    ('get', '/tasks/tool-task/diagnostics?profile=work&owner=forged', {}),
                ]
                for method, path, kwargs in invalid_requests:
                    with self.subTest(method=method, path=path):
                        self.bridge.calls.clear()
                        response = getattr(self.client, method)(PREFIX + path, **kwargs)
                        self.assertEqual(response.status_code, 422, response.text)
                        self.assertEqual(self.bridge.calls, [])

            with patch.object(hermes_constants, 'get_hermes_home', return_value=root):
                default_response = self.client.get(PREFIX + '/browsers?profile=default')
                self.assertEqual(default_response.status_code, 200, default_response.text)

            with patch.object(hermes_constants, 'get_hermes_home', return_value=Path(self.tmp.name) / 'unrelated'):
                self.bridge.calls.clear()
                external_home_response = self.client.get(PREFIX + '/browsers?profile=work')
                self.assertEqual(external_home_response.status_code, 422, external_home_response.text)
                self.assertEqual(self.bridge.calls, [])

    def test_browser_consent_projection_and_access_request_route(self):
        original = self.bridge.call
        self.bridge.call = lambda method, params: (
            self.bridge.calls.append((method, dict(params))) or
            ([{'instanceId': 'connected', 'browser': 'edge', 'connected': True,
              'consentStatus': 'unknown', 'accessRequestSupported': True},
              {'instanceId': 'legacy', 'browser': 'chrome', 'connected': True}]
             if method == 'browser.list' else
             {'requestId': 'request-1', 'status': 'confirmation_requested'}
             if method == 'browser.access_request' else original(method, params)))

        listed = self.client.get(PREFIX + '/browsers')
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.json()[0]['consentStatus'], 'unknown')
        self.assertTrue(listed.json()[0]['accessRequestSupported'])
        self.assertEqual(listed.json()[1]['consentStatus'], 'unknown')
        self.assertFalse(listed.json()[1]['accessRequestSupported'])

        response = self.client.post(PREFIX + '/browsers/connected/access-request')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {'requestId': 'request-1', 'status': 'confirmation_requested'})
        self.assertNotIn('enabled', response.json())
        self.assertEqual(self.bridge.calls[-1], ('browser.access_request', {'instanceId': 'connected'}))

        self.assertEqual(self.client.post(PREFIX + '/browsers/connected/access-request', json={}).status_code, 200)
        self.bridge.calls.clear()
        for kwargs in ({'json': {'enabled': True}}, {'json': {'consent': True}}):
            bad = self.client.post(PREFIX + '/browsers/connected/access-request', **kwargs)
            self.assertEqual(bad.status_code, 422, bad.text)
        self.assertEqual(self.client.post(PREFIX + '/browsers/connected/access-request?owner=forged').status_code, 422)
        self.assertEqual(self.bridge.calls, [])

    def test_missing_bridge_is_explicit_sanitized_503(self):
        def missing(*args):
            raise RuntimeError('private owner token and path')
        self.runtime.call = missing
        response = self.client.get(PREFIX + '/browsers')
        self.assertEqual(response.status_code, 503)
        self.assertIn('桥接服务', response.json()['detail'])
        self.assertNotIn('private', response.text)

if __name__ == '__main__':
    unittest.main()
