"""中文注释：1f 契约、等待、摘要和脱敏来源的离线行为验收。"""
import importlib.util
import json
import os
import tempfile
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'native-bridge'))
from client import BridgeError
from daemon import BridgeDaemon, ProtocolError


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


TOOLS = load('round1f_tools', 'executor-plugin/native_tools.py')
OPEN = load('round1f_open', 'executor-plugin/open_tool.py')
CHILD = load('round1f_child', 'executor-plugin/script_lane/child.py')
SCRIPT = load('round1f_script_tool', 'executor-plugin/script_lane/tool.py')
REFERENCE = load('round1f_reference', 'executor-plugin/reference.py')
BINDING = {'taskId': 't', 'documentId': 'd', 'leaseId': 'l'}


class Runtime:
    # 中文注释：合成已授权实例和导航回执，不连接任何浏览器。
    def __init__(self, ready='complete', summary=None):
        self.authority = types.SimpleNamespace(consume=lambda *a, **k: types.SimpleNamespace(owner='o', tool_call_id='call'))
        self.calls, self.ready, self.summary = [], ready, summary
    def call(self, method, params):
        self.calls.append((method, params))
        if method == 'browser.list':
            return [{'instanceId': 'i', 'browser': 'chrome', 'connected': True, 'consentStatus': 'enabled'}]
        if method == 'shared.list':
            return [{'id': 't', 'state': 'ready', 'instanceId': 'i', 'allowedOrigins': ['https://fixture.test']}]
        if method == 'shared.run' and params['action'] == 'new_tab':
            return {'tabId': 7, 'ready': self.ready, 'url': 'https://fixture.test/'}
        if method == 'shared.run' and params['action'] == 'semantic_snapshot':
            if isinstance(self.summary, Exception):
                raise self.summary
            return self.summary
        raise AssertionError(method)


class Round1fTests(unittest.TestCase):
    def test_run_fields_are_fixed_and_values_are_not_echoed(self):
        runtime = Runtime()
        handler = TOOLS.make_tool_handler('browser_shared_run', runtime)
        result = json.loads(handler({'task_id': 'PRIVATE', 'action': 'semantic_snapshot'}))
        self.assertEqual((result['code'], result['fields']), ('missing_fields', ['tab_id']))
        self.assertNotIn('PRIVATE', str(result))
        for args, fields in [({'tab_id': 'PRIVATE'}, ['tab_id']), ({'tab_id': 7, 'text': 'PRIVATE'}, ['text'])]:
            result = json.loads(handler({'task_id': 't', 'action': 'snapshot', **args}))
            self.assertEqual((result['code'], result['fields']), ('invalid_fields', fields))
            self.assertNotIn('PRIVATE', str(result))
        self.assertEqual(runtime.calls, [])
        schema = TOOLS.TOOL_SCHEMAS['browser_shared_run']['parameters']['allOf'][0]
        self.assertNotIn('new_tab', schema['if']['properties']['action']['enum'])
        self.assertEqual(schema['then']['required'], ['tab_id'])

    def test_wait_reduces_full_parse_and_preserves_hit_and_deadline(self):
        # 中文注释：虚拟单调时钟与旧 0.25 秒轮询使用同一命中时间，测试不靠真实 sleep。
        for hit, state in [(2, 'present'), (None, 'present'), (0, 'stable'), (0, 'text'), (0, 'count'), (None, 'absent')]:
            clock, calls = [0.0], []
            def call(op, args):
                self.assertEqual((op, args[0]), ('run', 'page.observe'))
                calls.append(clock[0])
                present = hit is not None and clock[0] >= hit
                return {'count': int(present), 'text': ['ready'] if present else [], 'complete': True, 'binding': BINDING}
            def extract(*a, **k):
                present = hit is not None and clock[0] >= hit
                return {'binding': BINDING, 'records': [{'fields': {'text': 'ready'}}] if present else [], 'coverage': {'complete': True}}
            with patch.object(CHILD.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(CHILD.time, 'sleep', side_effect=lambda duration: clock.__setitem__(0, clock[0]+duration)), patch.object(CHILD, '_call', side_effect=call), patch.object(CHILD, 'extract', side_effect=extract) as parse:
                result = CHILD.wait_for('#result', state=state, timeout=3, text='ready', count=1)
            self.assertEqual(parse.call_count, 1)
            expected = hit is not None or state == 'absent'
            self.assertEqual(result['satisfied'], expected)
            if hit == 2:
                self.assertEqual(clock[0], 2)  # 中文注释：与旧轮询命中时间相同。
                self.assertGreaterEqual(1 - parse.call_count / len(calls), .70)
            if hit is None and state == 'present':
                self.assertEqual(clock[0], 3)
                self.assertTrue(result['timed_out'])
                self.assertGreaterEqual(1 - parse.call_count / len(calls), .70)

    def test_wait_partial_or_document_change_cannot_satisfy(self):
        observation = {'count': 1, 'text': ['ready'], 'complete': True, 'binding': BINDING}
        for page in [ {'binding': BINDING, 'records': [], 'coverage': {'complete': False}},
                     {'binding': {**BINDING, 'documentId': 'new'}, 'records': [{'fields': {'text': 'ready'}}], 'coverage': {'complete': True}} ]:
            with patch.object(CHILD, '_call', return_value=observation), patch.object(CHILD, 'extract', return_value=page):
                result = CHILD.wait_for('#result')
                self.assertFalse(result['satisfied'])
                self.assertFalse(result['timed_out'])
                self.assertEqual(result['reason'], 'condition_changed')

    def test_wait_timeout_limits_are_explicit_and_safe(self):
        for timeout in [65, 90, 120, float('nan'), 0, True]:
            with self.assertRaises(CHILD.BrowserError) as caught:
                CHILD.wait_for('#PRIVATE', timeout=timeout)
            self.assertEqual(caught.exception.code, 'invalid_fields')
            self.assertIn('timeout_must_be_in_0_60_seconds', str(caught.exception))
            self.assertNotIn('PRIVATE', str(caught.exception))

    def test_wait_selector_errors_and_authority_denials_are_not_retried(self):
        for code in ['invalid_params', 'task_paused', 'browser_access_revoked', 'tab_out_of_scope']:
            with patch.object(CHILD, '_call', side_effect=CHILD.BrowserError('PRIVATE', code=code, outcome_unknown=False)) as call:
                with self.assertRaises(CHILD.BrowserError) as caught:
                    CHILD.wait_for('#PRIVATE')
                self.assertEqual(call.call_count, 1)
                self.assertEqual(caught.exception.code, 'invalid_fields' if code == 'invalid_params' else code)
                if code == 'invalid_params':
                    self.assertNotIn('PRIVATE', str(caught.exception))

    def test_open_loading_and_single_intent_summary(self):
        bridge = types.SimpleNamespace(_bindings={}, bind=lambda *a, **k: None)
        runtime = Runtime('loading')
        result = json.loads(OPEN.make_handler(runtime, bridge, lease_error=RuntimeError)({'url': 'https://fixture.test/', 'read_intent': 'content'}, session_id='s'))
        self.assertEqual(result['summary_missing']['reason'], 'page_loading')
        self.assertIn('原 tab', result['read_hint'])
        self.assertFalse(any(params.get('action') == 'semantic_snapshot' for _, params in runtime.calls))
        for mode in ['content', 'interactive']:
            runtime = Runtime(summary={'binding': BINDING, 'snapshotId': 's', 'coverage': {'complete': True}, 'items': [{'ref': 'r', 'role': 'heading', 'name': 'hello'}]})
            result = json.loads(OPEN.make_handler(runtime, bridge, lease_error=RuntimeError)({'url': 'https://fixture.test/', 'read_intent': mode, 'root': '#main'}, session_id='s'))
            reads = [params for _, params in runtime.calls if params.get('action') == 'semantic_snapshot']
            self.assertEqual(len(reads), 1)
            self.assertEqual(reads[0]['options']['mode'], mode)
            self.assertEqual(reads[0]['options']['root'], '#main')
            self.assertEqual(result['summary']['binding'], BINDING)
            self.assertTrue(result['summary']['coverage']['complete'])

    def test_summary_failure_and_clipping_are_explicit(self):
        for page, reason in [(None, 'summary_return_type'), (BridgeError('overlay_injection_failed','PRIVATE'), 'overlay_injection_failed')]:
            runtime = Runtime(summary=page)
            bridge = types.SimpleNamespace(_bindings={}, bind=lambda *a, **k: None)
            result = json.loads(OPEN.make_handler(runtime, bridge, lease_error=RuntimeError)({'url': 'https://fixture.test/'}, session_id='s'))
            self.assertEqual(result['summary_missing']['reason'], reason)
            self.assertNotIn('PRIVATE', str(result))
        runtime = Runtime(summary={'binding': BINDING, 'snapshotId': 's', 'coverage': {'complete': False}, 'nextCursor': 'cursor', 'items': [{'ref': 'r', 'name': 'x'*2000}]})
        summary = OPEN._summary(runtime, 'o', 't', 7, 'c', 'https://fixture.test/')
        self.assertIn('summary_items', summary['truncation'])
        self.assertIn('snapshot_coverage', summary['truncation'])
        self.assertEqual(summary['nextCursor'], 'cursor')
        self.assertIn('续读', summary['read_hint'])

    def test_origin_and_fixed_stage_metadata_survive_client_and_tool(self):
        for code in ['origin_denied', 'tab_out_of_scope']:
            error = BridgeError(code, 'PRIVATE', {'currentOrigin': 'https://fixture.test/private?q=SECRET', 'outcomeUnknown': False})
            self.assertEqual(error.data['currentOrigin'], 'https://fixture.test')
            runtime = Runtime()
            runtime.call = lambda *a, **k: (_ for _ in ()).throw(error)
            result = json.loads(TOOLS.make_tool_handler('browser_shared_run', runtime)({'task_id': 't', 'action': 'snapshot', 'tab_id': 7}))
            self.assertEqual(result['currentOrigin'], 'https://fixture.test')
            self.assertIn('goto_url', result['scopeHint'])
            self.assertNotIn('PRIVATE', str(result))
            self.assertNotIn('SECRET', str(result))
        for reason in ['initialization_exception', 'return_type_invalid']:
            self.assertEqual(BridgeError('overlay_injection_failed', 'PRIVATE', {'stage': 'overlay', 'reasonCode': reason}).data['reasonCode'], reason)
        self.assertNotIn('stage', BridgeError('execution_denied','PRIVATE',{'stage':'PRIVATE','reasonCode':'SECRET'}).data)

    def test_observer_wire_is_bounded_and_uses_read_approval(self):
        BridgeDaemon._validate_run_params('page.observe', {'owner': 'o', 'taskId':'t', 'requestId':'r', 'action':'page.observe', 'tabId':7, 'options': {'selector': '#result'}})
        with self.assertRaises(ProtocolError):
            BridgeDaemon._validate_run_params('page.observe', {'owner':'o', 'taskId':'t', 'requestId':'r', 'action':'page.observe', 'tabId':7, 'options': {'selector':'#result','maxScan':1000000}})
        from daemon import SITE_READ_ACTIONS, SCRIPT_ACTIONS
        self.assertIn('page.observe', SITE_READ_ACTIONS)
        self.assertNotIn('page.observe', SCRIPT_ACTIONS)

    def test_script_output_clip_reports_category_and_workspace_continuation(self):
        class Launch:
            # 中文注释：脚本只打印合成数据，继承空设备 fd，不接触浏览器或用户配置。
            def __init__(self):
                self.fd = os.open(os.devnull, os.O_RDONLY)
            def close(self):
                os.close(self.fd)
                self.receipt = {'last_operation': None, 'execution_complete': True, 'outcome_unknown': False}
        bridge = types.SimpleNamespace(prepare=lambda **kwargs: Launch())
        with tempfile.TemporaryDirectory(prefix='bf-', dir='/tmp') as directory:
            workspace = Path(directory)
            (workspace / 'tmp').mkdir()
            result = SCRIPT.run_script(bridge, session_id='synthetic', tool_call_id='r', workspace=workspace,
                      code="print('x'*25000)", timeout_s=5)
        self.assertEqual(result['exit_code'], 0)
        self.assertTrue(result['stdout_truncated'])
        self.assertEqual(len(result['stdout']), 20000)
        self.assertEqual(result['truncation'][0]['category'], 'stdout_prefix')
        self.assertIn('工作区', result['truncation'][0]['continuation'])
        self.assertTrue(result['execution_complete'])

    def test_open_and_script_missing_and_invalid_fields_do_not_echo_values(self):
        runtime = Runtime()
        bridge = types.SimpleNamespace(_bindings={}, bind=lambda *a, **k: None)
        open_handler = OPEN.make_handler(runtime, bridge, lease_error=RuntimeError)
        for args, code, fields in [({}, 'missing_fields', ['url']), ({'url':'https://fixture.test/', 'read_intent':'PRIVATE'}, 'invalid_fields', ['read_intent'])]:
            result = json.loads(open_handler(args))
            self.assertEqual((result['code'],result['fields']), (code,fields))
            self.assertNotIn('PRIVATE', str(result))
        script_handler = SCRIPT.make_handler(bridge, runtime.authority, Path('/tmp'), lease_error=RuntimeError, bridge_denied=RuntimeError)
        for args, code, fields in [({}, 'missing_fields', ['code']), ({'code':'PRIVATE', 'timeout_s':0}, 'invalid_fields', ['timeout_s'])]:
            result = json.loads(script_handler(args))
            self.assertEqual((result['code'],result['fields']), (code,fields))
            self.assertNotIn('PRIVATE', str(result))

    def test_reference_comes_from_real_helper_docs(self):
        catalog = {row['name']: row for row in REFERENCE.helper_catalog()}
        for name in ['page_text', 'read_page', 'semantic_snapshot', 'wait_for']:
            self.assertIn('dict', catalog[name]['description'])
        self.assertIn('60', catalog['wait_for']['description'])
        self.assertIn('arguments', catalog['evaluate']['description'])


if __name__ == '__main__':
    unittest.main()
