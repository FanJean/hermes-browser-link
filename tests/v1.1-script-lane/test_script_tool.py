"""browser_shared_script end to end: real child interpreter, synthetic bridge.

No browser, daemon or Hermes source is used. The fake runtime stands in for the
native daemon's shared.get/browser.list/shared.run answers.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "executor-plugin"
sys.path.insert(0, str(PLUGIN))
import native_runtime  # noqa: E402

host_bridge = native_runtime.load_module(PLUGIN / "script_lane" / "host_bridge.py", "script_host_bridge_under_test_")
tool = native_runtime.load_module(PLUGIN / "script_lane" / "tool.py", "script_tool_under_test_")
PNG = base64.b64encode(b"\x89PNG\r\n\x1a\nsynthetic").decode()


class Uncertain(Exception):
    code = 'extension_timeout'
    data = {'outcomeUnknown': True}


class FakeRuntime:
    def __init__(self, authority_dir, *, approval_for=(), manual_for=(), uncertain_once=()):
        self.authority = native_runtime.NativeOwnerAuthority(authority_dir)
        self.runs = []
        self.approval_for = set(approval_for)
        self.manual_for = set(manual_for)
        self.uncertain_once = set(uncertain_once)
        self.approved = set()
        self.tab_ids = []
        self.ledger = {}

    def call(self, method, params):
        if method == "shared.get":
            return {"id": params["taskId"], "state": "ready", "instanceId": "edge-1", "generation": 1,
                    "tabIds": self.tab_ids, "workTabs": [{"tabId": tab} for tab in self.tab_ids]}
        if method == "browser.list":
            return [{"instanceId": "edge-1", "connected": True}]
        if method == "shared.operation_status":
            request_id = params['requestId']
            state = self.ledger[request_id]
            return {"requestIdHash": hashlib.sha256(request_id.encode()).hexdigest(),
                    "state": state, "dispatched": state in {'confirmed', 'unknown'}, "generation": 1}
        assert method == "shared.run", method
        self.runs.append(dict(params))
        action = params["action"]
        # 中文注释：合成 daemon 同步登记新建工作页，显式选页读取真实租约。
        if action == "new_tab" and 7 not in self.tab_ids:
            self.tab_ids.append(7)
        if action in self.uncertain_once:
            self.uncertain_once.discard(action)
            self.ledger[params['requestId']] = 'unknown'
            raise Uncertain()
        if action in self.manual_for:
            if params["requestId"] not in self.approved:
                self.approved.add(params["requestId"])
                self.ledger[params['requestId']] = 'awaiting_human'
                return {"status": "user_input_required", "requestId": params["requestId"], "fieldKind": "password"}
            self.ledger[params['requestId']] = 'confirmed'
            return {"status": "completed_by_user", "filledBy": "user", "fieldKind": "password"}
        if action in self.approval_for and params["requestId"] not in self.approved:
            self.approved.add(params["requestId"])
            self.ledger[params['requestId']] = 'awaiting_approval'
            return {"status": "approval_required", "requestId": params["requestId"]}
        self.ledger[params['requestId']] = 'confirmed'
        return {
            "new_tab": {"tabId": 7},
            "navigate": {"tabId": 7, "url": params.get("url")},
            "official.ready_state": {"readyState": "complete"},
            # 中文注释：效率 helper 使用完整范围的真实快照契约，不以单条结果猜测唯一性。
            "semantic_snapshot": {"binding": {"taskId": "t"}, "snapshotId": "s1", "kind": "full",
                                  "coverage": {"complete": True},
                                  "items": [{"ref": "e1", "role": "button", "name": "Next"}]},
            "ref_click": {"clicked": True},
            "scroll": {"scrolled": True},
            "click": {"clicked": True},
            "screenshot": {"data": PNG},
            "snapshot": {"text": "page after the uncertain click"},
            "fill": {"ok": True, "filled": True},
        }[action]


class ScriptToolTests(unittest.TestCase):
    def test_complex_ui_receipts_and_errors_reach_child(self):
        # 中文注释：真实脚本子进程穿过宿主 RPC，读取覆盖率和重定位标记。
        self.bind()
        original = self.runtime.call
        def call(method, params):
            if method == 'shared.run' and params['action'] == 'semantic_snapshot':
                return {'binding': {'taskId': 'task-1'}, 'snapshotId': 's1', 'kind': 'full',
                        'coverage': {'complete': True, 'unsupportedCanvas': 1},
                        'items': [{'ref': 'e1', 'role': 'button', 'name': 'Next', 'inferred': True}]}
            if method == 'shared.run' and params['action'] == 'ref_click':
                return {'clicked': True, 'relocated': True}
            return original(method, params)
        self.runtime.call = call
        result = self.run_script("new_tab('https://example.com/')\n"
                                 "page=read_page()\n"
                                 "print(page['coverage']['unsupportedCanvas'], page['items'][0]['inferred'])\n"
                                 "print(click_element('Next', role='button')['relocated'])\n")
        self.assertEqual(result['exit_code'], 0, result)
        self.assertEqual(result['stdout'].strip().splitlines(), ['1 True', 'True'])

    def test_complex_ui_error_summary_crosses_script_host_and_child(self):
        # 中文注释：脚本异常保留固定码与脱敏摘要，页面异常原文不能进入子进程。
        from script_lane.action_session import ActionRejected
        binding = {'taskId': 't', 'documentId': 'd', 'leaseId': 'l'}
        cases = {
            'reference_target_missing': {'candidates': [{'role': 'button', 'name': '保存', 'value': 'SECRET_CANARY'}]},
            'reference_target_ambiguous': {'candidates': [{'role': 'button', 'name': '保存', 'value': 'SECRET_CANARY'}]},
            'target_occluded': {'obstruction': {'role': 'dialog', 'name': '遮挡层', 'value': 'SECRET_CANARY',
                'closeButton': {'binding': binding, 'snapshotId': 's', 'ref': 'r', 'name': '关闭', 'value': 'SECRET_CANARY'}}},
            **{code: {} for code in ('target_disabled', 'target_hidden', 'target_zero_size',
                                    'target_out_of_viewport', 'closed_shadow_unavailable',
                                    'cross_origin_frame_unavailable')},
        }
        class Actions:
            _task_id = 'task'
            _rpc_lock = threading.RLock()
            tab_id = None
            _pending = None
            def run(self, *_):
                raise self.error
        actions = Actions()
        state = {'guard': threading.RLock(), 'current': actions,
                 'revocations': {'task': threading.Event()}, 'roots': {'task': actions}}
        for code, data in cases.items():
            with self.subTest(code=code):
                actions.error = ActionRejected(code, data=data)
                reply = host_bridge.HostBridge._helper_reply({'op': 'run', 'args': ['ref_click', {}]},
                    actions, threading.Event(), threading.Event(), frozenset(), None, state, lambda _: None)
                self.assertEqual(reply['code'], code)
                self.assertNotIn('SECRET_CANARY', json.dumps(reply))
                if code.startswith('reference_'):
                    self.assertEqual(reply['candidates'], [{'role': 'button', 'name': '保存'}])
                if code == 'target_occluded':
                    self.assertEqual(reply['obstruction']['closeButton']['binding'], binding)

    def test_complex_ui_rejection_is_available_in_script_child(self):
        # 中文注释：异常摘要经过 action session、宿主和子进程后可作为字段读取。
        self.bind()
        original = self.runtime.call
        def call(method, params):
            if method == 'shared.run' and params['action'] == 'ref_click':
                error = RuntimeError('SECRET_CANARY')
                error.code = 'reference_target_missing'
                error.data = {'outcomeUnknown': False,
                              'candidates': [{'role': 'button', 'name': '保存', 'value': 'SECRET_CANARY'}]}
                raise error
            return original(method, params)
        self.runtime.call = call
        result = self.run_script("new_tab('https://example.com/')\n"
                                 "try:\n    click_element('Next', role='button')\n"
                                 "except BrowserError as e:\n    print(e.code, e.candidates[0]['name'])\n")
        self.assertEqual(result['exit_code'], 0, result)
        self.assertEqual(result['stdout'].strip(), 'reference_target_missing 保存')
        self.assertNotIn('SECRET_CANARY', json.dumps(result))

    def test_fixed_error_wording_and_allowlisted_code(self):
        # 中文注释：宿主只回可信码与固定文案，不泄露异常原文。
        from script_lane.action_session import ActionRejected, OutcomeUnknown

        class Actions:
            _task_id = 'task'
            _rpc_lock = threading.RLock()
            tab_id = None
            _pending = None

            def run(self, *_):
                raise self.error

        actions = Actions()
        state = {'guard': threading.RLock(), 'current': actions,
                 'revocations': {'task': threading.Event()}, 'roots': {'task': actions}}
        request = {'op': 'run', 'args': ['snapshot', {}]}
        for error, expected_unknown in ((ActionRejected('tab_out_of_scope'), False),
                                        (ActionRejected('capture_sensitive_blocked'), False),
                                        (ActionRejected('capture_frame_uninspectable'), False),
                                        (OutcomeUnknown('secret page value', code='execution_denied'), True)):
            actions.error = error
            reply = host_bridge.HostBridge._helper_reply(request, actions, threading.Event(),
                threading.Event(), frozenset(), None, state, lambda _: None)
            self.assertEqual(reply['code'], error.code)
            self.assertEqual(reply['outcomeUnknown'], expected_unknown)
            self.assertIn('不要自动重放' if expected_unknown else '未执行，可重新读取页面后重试', reply['error'])
            self.assertNotIn('secret page value', reply['error'])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        self.make(())

    def make(self, approval_for, **options):
        self.runtime = FakeRuntime(Path(self.temp.name) / "authority", approval_for=approval_for, **options)
        self.runtime.authority.lease_tools((tool.TOOL_NAME,))
        self.bridge = host_bridge.HostBridge(self.runtime, PLUGIN)
        self.addCleanup(self.bridge.close)
        self.handler = tool.make_handler(self.bridge, self.runtime.authority, self.home,
                                         lease_error=native_runtime.OwnerLeaseError,
                                         bridge_denied=host_bridge.BridgeDenied)

    def bind(self, session="session-a"):
        owner = self.runtime.authority.owner_for_session(session)
        self.bridge.bind(session, owner=owner, task_id="task-1")

    # 中文注释：已绑定任务暂停后，脚本入口明确拒绝且不启动子进程。
    def test_paused_task_is_explicit_and_never_runs_script(self):
        self.bind()
        call = self.runtime.call
        def paused(method, params):
            value = call(method, params)
            return {**value, "state": "paused"} if method == "shared.get" else value
        self.runtime.call = paused
        result = self.run_script("print('不应执行')")
        self.assertEqual(result["code"], "task_paused")
        self.assertIn("已暂停", result["error"])
        self.assertEqual(self.runtime.runs, [])

    def test_semantic_helpers_batch_through_real_child_and_host(self):
        # 中文注释：真实子进程与可信租约路径，验证新增 helper 没有旁路执行。
        self.bind()
        result = self.run_script("new_tab('https://example.com/')\n"
                                 "click_element('Next', role='button')\n"
                                 "scroll('down')\n"
                                 "print(read_page()['coverage']['complete'])\n")
        self.assertEqual(result['exit_code'], 0, result)
        self.assertEqual(result['stdout'].strip(), 'True')
        self.assertEqual(result['last_operation']['state'], 'confirmed')
        self.assertTrue(result['last_operation']['requestId'])
        self.assertEqual([row['action'] for row in self.runtime.runs],
                         ['new_tab', 'semantic_snapshot', 'ref_click', 'scroll', 'semantic_snapshot'])
        self.assertTrue(all(row.get('tabId') == 7 for row in self.runtime.runs[1:]))

    def test_script_reuses_only_unique_owned_tab_without_opening_another(self):
        # 中文注释：browser_shared_open 已打开唯一页时，脚本无需再开第二个页。
        self.bind()
        self.runtime.tab_ids = [7]
        result = self.run_script("click_element('Next', role='button')")
        self.assertEqual(result['exit_code'], 0, result)
        self.assertEqual([row['action'] for row in self.runtime.runs], ['semantic_snapshot', 'ref_click'])
        self.assertTrue(all(row['tabId'] == 7 for row in self.runtime.runs))

    def test_script_does_not_guess_between_owned_tabs(self):
        self.bind()
        self.runtime.tab_ids = [7, 8]
        result = self.run_script("read_page()")
        self.assertNotEqual(result['exit_code'], 0, result)
        self.assertEqual(self.runtime.runs, [])

    def run_script(self, code, *, session="session-a", call="call-1", timeout_s=30, resume_checkpoint=None):
        args = {"code": code, "timeout_s": timeout_s}
        if resume_checkpoint is not None:
            args['resume_checkpoint'] = resume_checkpoint
        hook = self.runtime.authority.pre_tool_call(tool.TOOL_NAME, args, session_id=session, tool_call_id=call)
        self.assertEqual(hook["action"], "modify", hook)
        return json.loads(self.handler({**args, **hook["args"]}, session_id=session))

    def test_explicit_checkpoint_reaches_only_the_new_child_and_reconnect_is_read_only(self):
        self.bind()
        self.runtime.tab_ids = [7]
        first = self.run_script("print(load_checkpoint()['cursor'], reconnect()['state'])",
                                resume_checkpoint={'cursor': 3})
        self.assertEqual(first['exit_code'], 0, first)
        self.assertEqual(first['stdout'].strip(), '3 ready')
        second = self.run_script("print(load_checkpoint())", call='call-2')
        self.assertEqual(second['stdout'].strip(), 'None')
        self.assertEqual(self.runtime.runs, [])

    def test_new_python_process_uses_hermes_checkpoint_and_prior_operation_receipt(self):
        self.bind()
        first = self.run_script("new_tab('https://example.com/')\nprint('phase one')", call='phase-1')
        self.assertEqual(first['exit_code'], 0, first)
        request_id = first['last_operation']['requestId']
        # 中文注释：第二次代码和业务检查点由 Hermes 明确提供，插件只查询旧操作，不重放打开标签页。
        second = self.run_script("point=load_checkpoint()\n"
                                 "state=operation_status(point['requestId'])\n"
                                 "print(point['step'], state['state'], state['dispatched'])",
                                 call='phase-2', resume_checkpoint={'step': 2, 'requestId': request_id})
        self.assertEqual(second['exit_code'], 0, second)
        self.assertEqual(second['stdout'].strip(), '2 confirmed True')
        self.assertEqual([row['action'] for row in self.runtime.runs], ['new_tab'])

    def test_helpers_reach_the_bound_task_and_workspace_persists(self):
        self.bind()
        first = self.run_script(
            "tab = new_tab('https://example.com/')\n"
            "wait_for_load()\n"
            "snap = semantic_snapshot(mode='interactive')\n"
            "ref_click(snap, snap['items'][0]['ref'])\n"
            "open('checkpoint.json', 'w').write('{\"page\": 1}')\n"
            "print('tab', tab, 'items', len(snap['items']))\n")
        self.assertEqual(first["exit_code"], 0, first)
        self.assertEqual(first["stdout"].strip(), "tab 7 items 1")
        self.assertIs(first["outcome_unknown"], False)
        actions = [run["action"] for run in self.runtime.runs]
        self.assertEqual(actions, ["new_tab", "official.ready_state", "semantic_snapshot", "ref_click"])
        self.assertTrue(all(run["taskId"] == "task-1" and "owner" in run for run in self.runtime.runs))
        self.assertTrue(all(run.get("tabId") == 7 for run in self.runtime.runs[1:]))

        second = self.run_script("print(open('checkpoint.json').read())", call="call-2")
        self.assertEqual(json.loads(second["stdout"]), {"page": 1})

    def test_approval_waits_on_the_same_request_without_replay(self):
        self.make({"click"})
        self.bind()
        result = self.run_script(
            "new_tab('https://example.com/')\n"
            "try:\n"
            "    click('#buy')\n"
            "except ApprovalRequired:\n"
            "    print('waiting', wait_pending(timeout_s=5))\n")
        self.assertEqual(result["exit_code"], 0, result)
        clicks = [run for run in self.runtime.runs if run["action"] == "click"]
        self.assertEqual(len(clicks), 2)
        self.assertEqual(clicks[0]["requestId"], clicks[1]["requestId"], "resume must reuse the request id")
        self.assertIn("waiting {'clicked': True}", result["stdout"])

    def test_uncertain_write_freezes_until_reconcile_reads_the_page(self):
        self.make((), uncertain_once={"click"})
        self.bind()
        result = self.run_script(
            "new_tab('https://example.com/')\n"
            "try:\n"
            "    click('#buy')\n"
            "except BrowserError as exc:\n"
            "    print('uncertain', exc.outcome_unknown)\n"
            "try:\n"
            "    click('#next')\n"
            "except BrowserError:\n"
            "    print('frozen')\n"
            "print(reconcile()['text'])\n"
            "print(click('#next'))\n")
        self.assertEqual(result["exit_code"], 0, result)
        lines = result["stdout"].splitlines()
        self.assertEqual(lines[:3], ["uncertain True", "frozen", "page after the uncertain click"])
        self.assertTrue(result["execution_complete"], "显式核对现场并完成后允许结束")
        clicks = [run for run in self.runtime.runs if run["action"] == "click"]
        self.assertEqual(len(clicks), 2, "the uncertain click is never resent; only the new one runs")
        self.assertNotEqual(clicks[0]["requestId"], clicks[1]["requestId"])

    def test_normal_process_exit_cannot_hide_unknown_or_pending_operations(self):
        for option, status in [('uncertain_once', 'unknown'), ('approval_for', 'awaiting_approval'), ('manual_for', 'awaiting_human')]:
            with self.subTest(status=status):
                self.make({'click'} if option == 'approval_for' else (), **({option: {'click'}} if option != 'approval_for' else {}))
                self.bind()
                result = self.run_script("new_tab('https://example.com/')\ntry:\n    click('#save')\nexcept BrowserError:\n    pass\nprint('done')")
                self.assertEqual(result['exit_code'], 0)
                self.assertFalse(result['execution_complete'])
                self.assertEqual(result['last_operation']['state'], status)
                self.assertEqual(result['outcome_unknown'], status == 'unknown')

    def test_sensitive_field_waits_for_the_person_without_typing(self):
        self.make((), manual_for={"fill"})
        self.bind()
        result = self.run_script(
            "new_tab('https://example.com/login')\n"
            "try:\n"
            "    fill('#password', 'guess')\n"
            "except UserInputRequired:\n"
            "    print(wait_pending(timeout_s=5)['filledBy'])\n")
        self.assertEqual(result["exit_code"], 0, result)
        self.assertEqual(result["stdout"].strip(), "user")

    def test_unbound_session_is_refused_before_any_process_starts(self):
        result = self.run_script("print('should not run')")
        self.assertEqual(result["code"], "binding_missing")
        self.assertEqual(self.runtime.runs, [])

    def test_child_environment_is_scrubbed(self):
        self.bind()
        os.environ["BROWSER_EXECUTOR_TEST_SECRET"] = "must-not-leak"
        self.addCleanup(os.environ.pop, "BROWSER_EXECUTOR_TEST_SECRET", None)
        result = self.run_script("import os, json; print(json.dumps(sorted(os.environ)))")
        keys = set(json.loads(result["stdout"]))
        self.assertNotIn("BROWSER_EXECUTOR_TEST_SECRET", keys)
        self.assertLessEqual(keys, {"PATH", "HOME", "TMPDIR", "LANG", "PYTHONIOENCODING",
                                    "PYTHONDONTWRITEBYTECODE", "HERMES_BROWSER_FD", "HERMES_BROWSER_EXPORT_ROOTS", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"})

    def test_timeout_kills_the_script_and_marks_outcome_unknown(self):
        self.bind()
        result = self.run_script("import time\nprint('start', flush=True)\ntime.sleep(30)", timeout_s=1)
        self.assertTrue(result["timed_out"])
        self.assertIs(result["outcome_unknown"], True)

    def test_closed_output_streams_do_not_bypass_timeout_or_leave_child_alive(self):
        # 中文注释：真实子进程主动关闭三个标准流，宿主仍须遵守执行期限并回收进程。
        import signal
        from unittest.mock import patch
        self.bind()
        started = []
        popen = tool.subprocess.Popen
        def launch(*args, **kwargs):
            process = popen(*args, **kwargs)
            started.append(process)
            return process
        try:
            with patch.object(tool.subprocess, 'Popen', side_effect=launch):
                result = self.run_script("import os,time\nfor fd in (0,1,2): os.close(fd)\ntime.sleep(30)", timeout_s=1)
            self.assertTrue(result['timed_out'], result)
            self.assertTrue(result['outcome_unknown'])
            self.assertFalse(result['execution_complete'])
            self.assertIsNotNone(started[0].poll())
        finally:
            for process in started:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()

    def test_normal_exit_reaps_background_processes_in_script_group(self):
        # 中文注释：子孙进程关闭输出后不能越过脚本结束时间继续产生副作用。
        import signal
        import time
        self.bind()
        result = self.run_script("import subprocess,sys\np=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nprint(p.pid)")
        pid = int(result['stdout'])
        def alive():
            try:
                os.kill(pid, 0)
                return True
            except ProcessLookupError:
                return False
        try:
            deadline = time.monotonic() + 1
            while alive() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertFalse(alive(), '脚本退出后后台子进程仍在运行')
        finally:
            if alive():
                os.kill(pid, signal.SIGKILL)

    def test_screenshot_stays_inside_the_workspace(self):
        self.bind()
        result = self.run_script(
            "new_tab('https://example.com/')\n"
            "print(screenshot('shots/a.png'))\n"
            "try:\n"
            "    screenshot('../escape.png')\n"
            "except BrowserError as exc:\n"
            "    print('refused', exc.code)\n")
        self.assertEqual(result["exit_code"], 0, result)
        workspace = next((self.home / "plugin-data" / "browser-link-native" / "scripts").iterdir())
        self.assertEqual(result["stdout"].split(), [str((workspace / "shots" / "a.png").resolve()), "refused", "invalid_params"])
        self.assertTrue((workspace / "shots" / "a.png").is_file())
        self.assertFalse((workspace.parent / "escape.png").exists())

    def test_script_selects_tabs_across_bound_tasks_without_unbinding(self):
        original = self.runtime.call
        def call(method, params):
            if method == 'shared.get':
                tabs = [7] if params['taskId'] == 'task-1' else [8]
                return {'id': params['taskId'], 'state': 'ready', 'instanceId': 'edge-1', 'generation': 1,
                        'tabIds': tabs, 'workTabs': [{'tabId': tab} for tab in tabs]}
            return original(method, params)
        self.runtime.call = call
        self.bind()
        owner = self.runtime.authority.owner_for_session('session-a')
        self.bridge.bind('session-a', owner=owner, task_id='task-2')
        result = self.run_script("use_tab(7)\npage_text()\npage_text(tab=8)\nprint(current_tab())")
        self.assertEqual(result['exit_code'], 0, result)
        self.assertEqual(result['stdout'].strip(), '7')
        runs = [row for row in self.runtime.runs if row['action'] == 'snapshot']
        self.assertEqual([(row['taskId'], row['tabId']) for row in runs], [('task-1', 7), ('task-2', 8)])
        self.bridge.unbind('session-a', task_id='task-1')
        self.assertIn('task-2', self.bridge._task_bindings['session-a'])

    def test_parallel_unknown_write_is_aggregated_without_replay(self):
        self.runtime.tab_ids = [7, 8]
        self.bind()
        original = self.runtime.call
        def call(method, params):
            if method == 'shared.run' and params['action'] == 'click' and params['tabId'] == 8:
                self.runtime.runs.append(dict(params))
                self.runtime.ledger[params['requestId']] = 'unknown'
                raise Uncertain()
            return original(method, params)
        self.runtime.call = call
        result = self.run_script("try:\n parallel(lambda tab: click('#save', tab=tab), [7,8])\nexcept BrowserError as error:\n print(len(error.errors), error.errors[0]['tab_id'], len(error.results))")
        self.assertEqual(result['exit_code'], 0, result)
        self.assertEqual(result['stdout'].strip(), '1 8 2')
        self.assertEqual(len(self.runtime.runs), 2)
        self.assertTrue(result['outcome_unknown'])
        self.assertFalse(result['execution_complete'])

    def test_one_script_process_per_session_across_task_bindings(self):
        self.bind()
        owner = self.runtime.authority.owner_for_session('session-a')
        self.bridge.bind('session-a', owner=owner, task_id='task-2')
        launch = self.bridge.prepare(session_id='session-a', tool_call_id='script-first', workspace=Path(self.temp.name), code='')
        try:
            # 中文注释：模拟可信宿主切换到已绑定的另一任务，仍不能启动第二个脚本。
            self.bridge._bindings['session-a'] = self.bridge._task_bindings['session-a']['task-2']
            with self.assertRaises(host_bridge.BridgeDenied):
                self.bridge.prepare(session_id='session-a', tool_call_id='script-second', workspace=Path(self.temp.name), code='')
        finally:
            launch.close()
        second = self.bridge.prepare(session_id='session-a', tool_call_id='script-third', workspace=Path(self.temp.name), code='')
        second.close()

    def test_parallel_tabs_overlap_keep_order_and_do_not_change_current(self):
        # 中文注释：屏障只有两页同时进入才会释放，串行实现会超时失败。
        import threading
        self.runtime.tab_ids = [7, 8]
        self.bind()
        barrier = threading.Barrier(2)
        original = self.runtime.call
        def call(method, params):
            if method == 'shared.run' and params['action'] == 'snapshot':
                barrier.wait(timeout=3)
                original(method, params)
                return {'text': str(params['tabId'])}
            return original(method, params)
        self.runtime.call = call
        result = self.run_script("use_tab(7)\nprint(parallel(lambda tab: page_text(tab=tab), [8, 7]))\nprint(current_tab())")
        self.assertEqual(result['exit_code'], 0, result)
        self.assertIn("'8'", result['stdout'])
        self.assertTrue(result['stdout'].strip().endswith('7'))
        self.assertTrue(result['execution_complete'])

    def test_invalid_arguments_are_rejected(self):
        self.bind()
        result = self.run_script("print(1)", timeout_s=10_000)
        self.assertEqual(result["code"], "invalid_fields")
        self.assertEqual(result["fields"], ["timeout_s"])


if __name__ == "__main__":
    unittest.main()
