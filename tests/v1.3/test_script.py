"""中文注释：V1.3 脚本有界输出与页面辅助函数的行为验收。"""
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]

def load(name):
    spec = importlib.util.spec_from_file_location('v13_' + name, ROOT / 'executor-plugin/script_lane' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class ScriptTests(unittest.TestCase):
    def test_large_dual_stream_output_is_drained_but_retained_prefix_is_bounded(self):
        tool = load('tool')
        process = subprocess.Popen([sys.executable, '-u', '-c', "import sys;sys.stdin.read();sys.stdout.write('中'*1000000);sys.stderr.write('x'*1000000)"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        out, err, timed, clipped, counts = tool._collect_output(process, 'pass', 10)
        self.assertFalse(timed)
        self.assertEqual(len(out), 20000)
        self.assertEqual(len(err), 20000)
        self.assertTrue(all(clipped.values()))
        self.assertEqual(counts['stdout'], 3000000)
        self.assertEqual(counts['stderr'], 1000000)

    def test_function_arguments_are_sent_as_data(self):
        child = load('child')
        value = {'text': "引号 '\n中文"}
        with patch.object(child, '_call', return_value={'value': value}) as call:
            self.assertEqual(child.evaluate('(x)=>x', value), value)
            payload = call.call_args.args[1][1]
            self.assertEqual(payload['expression'], '(x)=>x')
            self.assertEqual(payload['arguments'], value)

    def test_wait_uses_reads_only_and_does_not_accept_partial_absence(self):
        child = load('child')
        # 中文注释：新版先做轻量观察，截止时完整解析；不完整范围不能证明不存在。
        with patch.object(child, '_call', return_value={'count': 0, 'text': [], 'complete': False}), patch.object(child, 'extract', return_value={'records': [], 'coverage': {'complete': False}}):
            result = child.wait_for('.missing', state='absent', timeout=0.01, interval=0.05)
            self.assertFalse(result['satisfied'])
        with patch.object(child, '_call', return_value={'count': 0, 'text': [], 'complete': True}), patch.object(child, 'extract', return_value={'records': [], 'coverage': {'complete': True}}):
            self.assertTrue(child.wait_for('.missing', state='absent')['satisfied'])

    def test_response_listener_precedes_action_and_reports_ambiguous_receipts(self):
        child = load('child')
        events = [{'method': 'Network.responseReceived', 'params': {'requestId': str(i), 'response': {'url': 'https://example.test/result', 'status': 200}}} for i in range(2)]
        with patch.object(child, 'cdp') as enable, patch.object(child, 'cdp_events', side_effect=[{'events': []}, {'events': events}]):
            with self.assertRaises(child.BrowserError) as caught:
                # 中文注释：等待器创建后仍使用显式页，不受当前页指针影响。
                with child.expect_response('https://example.test/result', tab=7):
                    enable.assert_called_once_with('Network.enable', tab=7)
            self.assertEqual(caught.exception.code, 'ambiguous_event')
            self.assertTrue(caught.exception.outcome_unknown)

    def test_navigation_observes_same_document_spa_changes(self):
        child = load('child')
        event = {'method': 'Page.navigatedWithinDocument', 'params': {'frameId': 'main', 'url': 'https://example.test/new'}}
        with patch.object(child, 'cdp', side_effect=[{}, {'frameTree': {'frame': {'id': 'main'}}}]), patch.object(child, 'cdp_events', side_effect=[{'events': []}, {'events': [event]}]):
            with child.expect_navigation('https://example.test/new') as receipt:
                pass
            self.assertTrue(receipt.result['same_document'])

class ProjectionTests(unittest.TestCase):
    def test_result_is_owner_and_generation_scoped_and_operation_ids_are_private(self):
        import tempfile
        sys.path.insert(0, str(ROOT / 'native-bridge'))
        from daemon import BridgeDaemon, ProtocolError
        with tempfile.TemporaryDirectory() as directory:
            daemon = BridgeDaemon(Path(directory))
            task = {'id': 't', 'owner': 'a', 'generation': 1, 'state': 'ready',
                    'currentOperation': {'action': 'page.parse', 'state': 'running', 'requestIdHash': 'PRIVATE'},
                    'operationTimeline': [{'action': 'snapshot', 'state': 'succeeded', 'requestIdHash': 'PRIVATE'}]}
            daemon.tasks['t'] = task
            daemon.page_results['t'] = {'generation': 1, 'result': {'records': []}, 'receivedAt': 1}
            self.assertTrue(daemon._dispatch_client('shared.result', {'taskId': 't', 'owner': 'a'})['available'])
            with self.assertRaises(ProtocolError):
                daemon._dispatch_client('shared.result', {'taskId': 't', 'owner': 'other'})
            task['generation'] = 2
            self.assertFalse(daemon._dispatch_client('shared.result', {'taskId': 't', 'owner': 'a'})['available'])
            import time
            daemon.action_approvals[('t', 'PRIVATE')] = {'generation': 2, 'status': 'user_input_required', 'expiresAt': time.time() + 30, 'params': {'secret': 'HIDDEN'}}
            public = daemon._public_task(task)
            self.assertEqual(public['pendingInteraction'], {'kind': 'manual_input', 'count': 1})
            self.assertNotIn('HIDDEN', str(public))
            self.assertNotIn('PRIVATE', str(public))
            self.assertEqual(public['currentOperation']['action'], 'page.parse')

    def test_result_eviction_preserves_replay_tombstone(self):
        import tempfile
        sys.path.insert(0, str(ROOT / 'native-bridge'))
        from daemon import BridgeDaemon
        with tempfile.TemporaryDirectory() as directory:
            daemon = BridgeDaemon(Path(directory))
            task = {'id': 't', 'generation': 1, 'requestHistory': []}
            daemon.tasks['t'] = task
            daemon.dedupe['t'] = {}
            for index in range(12):
                daemon._record_request_locked(task, str(index), 'payload', {'data': 'x' * 1000000}, 'result')
            self.assertLessEqual(daemon.result_cache_bytes, 8 * 1024 * 1024)
            self.assertEqual(daemon.dedupe['t']['0'], ('payload', None, None))
            self.assertEqual(len(task['requestHistory']), 12)

if __name__ == '__main__':
    unittest.main()
