"""中文注释：网站工具版本冲突、失效验证、真实子进程与租约边界测试。"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

store_module = load('executor-plugin/site_tools/store.py', 'site_store_test')
script_test = load('tests/v1.1-script-lane/test_script_tool.py', 'site_script_fixture')
tools = load('executor-plugin/site_tools/tools.py', 'site_tools_test')

def definition():
    return {'site': 'example', 'name': 'read', 'description': '读取示例标题', 'access': 'read', 'origins': ['https://example.com'],
            'args_schema': {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query']},
            'result_schema': {'type': 'object', 'properties': {'title': {'type': 'string'}}, 'required': ['title']},
            'code': "def run(args):\n    # 中文注释：通过已有 helper 读取，不直接访问浏览器。\n    return {'title': read_page()['items'][0]['name']}"}

class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = store_module.Store(Path(self.tmp.name))
        self.draft = self.store.define(definition())['draft_id']
    def trial(self, **kw):
        return self.store.trial(self.draft, {'query': 'x'}, [{'path': 'title', 'equals': 'Next'}], kw.get('execute', lambda *_: {'title': 'Next'}))
    def test_draft_hidden_then_verified_activation_and_search(self):
        self.assertEqual(self.store.search()['tools'], [])
        with self.assertRaisesRegex(store_module.ToolError, 'draft_not_verified'):
            self.store.activate(self.draft)
        self.assertTrue(self.trial()['verification']['passed'])
        self.store.activate(self.draft)
        rows = self.store.search('示例')['tools']
        self.assertEqual(len(rows), 1)
        self.assertNotIn('code', rows[0])
        self.assertIn('args_schema', rows[0])
        self.assertEqual(self.store.search('missing')['tools'], [])
    def test_failed_or_exception_trial_invalidates_previous_pass(self):
        for executor in (lambda *_: {'title': 'wrong'}, lambda *_: (_ for _ in ()).throw(RuntimeError('execution failed'))):
            self.trial()
            try:
                self.trial(execute=executor)
            except RuntimeError:
                pass
            with self.assertRaisesRegex(store_module.ToolError, 'draft_not_verified'):
                self.store.activate(self.draft)
    def test_changed_draft_and_concurrent_active_update_rejected(self):
        self.trial()
        record = self.store.draft(self.draft)
        record['definition']['description'] = 'changed'
        self.store.write('draft-' + self.draft, record)
        with self.assertRaisesRegex(store_module.ToolError, 'draft_changed'):
            self.store.activate(self.draft)
        second = self.store.define(definition())['draft_id']
        self.store.trial(second, {'query': 'x'}, [{'path': 'title'}], lambda *_: {'title': 'Next'})
        self.store.activate(second)
        self.trial()
        with self.assertRaisesRegex(store_module.ToolError, 'draft_conflict'):
            self.store.activate(self.draft)
    def test_empty_results_null_missing_and_nested_contracts(self):
        self.assertTrue(store_module.check_result({'rows': []}, [{'path': 'rows', 'equals': []}])['passed'])
        self.assertTrue(store_module.check_result({'v': None}, [{'path': 'v', 'equals': None}])['passed'])
        self.assertFalse(store_module.check_result({}, [{'path': 'v', 'equals': None}])['passed'])
        schema = {'type': 'array', 'items': {'type': 'object', 'properties': {'n': {'type': 'integer', 'minimum': 1}}, 'required': ['n']}}
        store_module.validate_schema(schema)
        store_module.validate_value([{'n': 1}], schema)
        for value in [[{'n': True}], [{'n': 0}], [{'n': 1, 'extra': 2}]]:
            with self.assertRaises(store_module.ToolError):
                store_module.validate_value(value, schema)
    def test_invalid_checks_never_execute(self):
        for checks in ([], [{'path': 'title', 'min_items': -1}], [{'equals': True}]):
            with self.assertRaises(store_module.ToolError):
                self.store.trial(self.draft, {'query': 'x'}, checks, lambda *_: self.fail('must not execute'))
    def test_store_lock_discard_tamper_and_no_sample_persistence(self):
        with self.store.locked():
            with self.assertRaisesRegex(store_module.ToolError, 'store_busy'):
                self.store.activate(self.draft)
        self.store.trial(self.draft, {'query': 'PRIVATE-SAMPLE'}, [{'path': 'title'}], lambda *_: {'title': 'PRIVATE-RESULT'})
        text = (Path(self.tmp.name) / ('draft-' + self.draft + '.json')).read_text()
        self.assertNotIn('PRIVATE-SAMPLE', text)
        self.assertNotIn('PRIVATE-RESULT', text)
        self.store.discard(self.draft)
        with self.assertRaisesRegex(store_module.ToolError, 'unknown_draft'):
            self.store.activate(self.draft)
    def test_invalid_code_and_names(self):
        for code in ['print(1)\ndef run(args): return 1', 'def run(args=open("x")): return 1', '@something\ndef run(args): return 1']:
            d = definition(); d['code'] = code
            with self.assertRaises(store_module.ToolError):
                self.store.define(d)
        with self.assertRaises(store_module.ToolError):
            self.store.get('../bad', 'name')

class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.runtime = script_test.FakeRuntime(self.home / 'authority')
        original = self.runtime.call
        def call(method, params):
            result = original(method, params)
            if method == 'shared.get':
                result['allowedOrigins'] = ['https://example.com']
            return result
        self.runtime.call = call
        self.bridge = script_test.host_bridge.HostBridge(self.runtime, ROOT / 'executor-plugin')
        self.addCleanup(self.bridge.close)
        self.handlers = {}
        ctx = types.SimpleNamespace(register_tool=lambda **kw: self.handlers.update({kw['name']: kw['handler']}))
        tools.register(ctx, self.bridge, self.runtime, self.home, lease_error=script_test.native_runtime.OwnerLeaseError, bridge_denied=script_test.host_bridge.BridgeDenied)
        self.seq = 0
        owner = self.runtime.authority.owner_for_session('s')
        self.bridge.bind('s', owner=owner, task_id='t')
        self.runtime.tab_ids = [7]
    def invoke(self, name, args, identity=True):
        self.seq += 1
        if identity:
            hook = self.runtime.authority.pre_tool_call(name, args, session_id='s', tool_call_id=str(self.seq))
            args = {**args, **hook['args']}
        return json.loads(self.handlers[name](args, session_id='s'))
    def test_full_lifecycle_real_child_and_bound_action(self):
        draft = self.invoke('browser_site_manage', {'action': 'define', 'definition': definition()})['draft_id']
        tried = self.invoke('browser_site_manage', {'action': 'try', 'draft_id': draft, 'args': {'query': 'x'}, 'checks': [{'path': 'title', 'equals': 'Next'}]})
        self.assertTrue(tried['verification']['passed'], tried)
        self.assertTrue(self.invoke('browser_site_manage', {'action': 'activate', 'draft_id': draft})['ok'])
        result = self.invoke('browser_site_run', {'site': 'example', 'name': 'read', 'args': {'query': 'x'}})
        self.assertEqual(result['result'], {'title': 'Next'})
        self.assertEqual([p['action'] for p in self.runtime.runs], ['semantic_snapshot', 'semantic_snapshot'])
        self.assertTrue(all(p['tabId'] == 7 and p['owner'] == self.runtime.authority.owner_for_session('s') for p in self.runtime.runs))
    def test_identity_and_origin_rejected_before_child(self):
        self.assertEqual(self.invoke('browser_site_search', {}, False)['code'], 'session_identity_required')
        d = definition(); d['origins'] = ['https://other.test']
        draft = self.invoke('browser_site_manage', {'action': 'define', 'definition': d})['draft_id']
        result = self.invoke('browser_site_manage', {'action': 'try', 'draft_id': draft, 'args': {'query': 'x'}, 'checks': [{'path': 'title'}]})
        self.assertEqual(result['code'], 'binding_or_origin_denied')
        self.assertEqual(self.runtime.runs, [])
    def test_unknown_write_not_replayed_or_activated(self):
        self.runtime.uncertain_once.add('click')
        d = definition(); d['access'] = 'write'; d['code'] = "def run(args):\n    # 中文注释：只派发一次。\n    click('#save')\n    return {'title': 'Next'}"
        draft = self.invoke('browser_site_manage', {'action': 'define', 'definition': d})['draft_id']
        result = self.invoke('browser_site_manage', {'action': 'try', 'draft_id': draft, 'args': {'query': 'x'}, 'checks': [{'path': 'title'}]})
        self.assertEqual(result['code'], 'outcome_unknown', result)
        self.assertEqual(len(self.runtime.runs), 1)
        self.assertEqual(self.invoke('browser_site_manage', {'action': 'activate', 'draft_id': draft})['code'], 'draft_not_verified')

    def test_caught_pending_and_unknown_actions_cannot_be_verified(self):
        for status, setting, action in [('unknown', 'uncertain_once', "click('#save')"),
                                        ('awaiting_approval', 'approval_for', "click('#save')"),
                                        ('awaiting_human', 'manual_for', "fill('#private', 'fixture')")]:
            with self.subTest(status=status):
                self.bridge.unbind('s')
                self.bridge.bind('s', owner=self.runtime.authority.owner_for_session('s'), task_id='t')
                self.runtime.uncertain_once.clear(); self.runtime.approval_for.clear(); self.runtime.manual_for.clear()
                getattr(self.runtime, setting).add('fill' if setting == 'manual_for' else 'click')
                d = definition(); d['access'] = 'write'
                # 中文注释：真实子进程捕获异常且返回满足断言的 JSON，也必须以宿主账本为准。
                d['code'] = "def run(args):\n    try:\n        " + action + "\n    except BrowserError:\n        pass\n    return {'title': 'Next'}"
                draft = self.invoke('browser_site_manage', {'action': 'define', 'definition': d})['draft_id']
                result = self.invoke('browser_site_manage', {'action': 'try', 'draft_id': draft, 'args': {'query': 'x'}, 'checks': [{'path': 'title', 'equals': 'Next'}]})
                self.assertFalse(result['ok'], result)
                self.assertEqual(result['code'], 'outcome_unknown' if status == 'unknown' else 'operation_incomplete')
                self.assertEqual(list(self.runtime.ledger.values())[-1], status)
                self.assertEqual(self.invoke('browser_site_manage', {'action': 'activate', 'draft_id': draft})['code'], 'draft_not_verified')

    def test_waiting_for_original_approval_allows_verification_without_replay(self):
        self.runtime.approval_for.add('click')
        d = definition(); d['access'] = 'write'
        d['code'] = "def run(args):\n    try:\n        click('#save')\n    except ApprovalRequired:\n        wait_pending()\n    return {'title': 'Next'}"
        draft = self.invoke('browser_site_manage', {'action': 'define', 'definition': d})['draft_id']
        result = self.invoke('browser_site_manage', {'action': 'try', 'draft_id': draft, 'args': {'query': 'x'}, 'checks': [{'path': 'title', 'equals': 'Next'}]})
        self.assertTrue(result['verification']['passed'], result)
        self.assertEqual(len(self.runtime.runs), 2)
        self.assertEqual(self.runtime.runs[0]['requestId'], self.runtime.runs[1]['requestId'])

if __name__ == '__main__':
    unittest.main()
