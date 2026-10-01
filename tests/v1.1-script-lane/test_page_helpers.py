"""页面效率 helper：验证唯一定位、动态等待、范围覆盖及不重放写动作。"""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('page_helpers', Path(__file__).resolve().parents[2] /
                                            'executor-plugin/script_lane/child.py')
child = importlib.util.module_from_spec(spec)
spec.loader.exec_module(child)


def snapshot(items, complete=True):
    return {'kind': 'full', 'binding': {'taskId': 'owned'}, 'snapshotId': 'fresh',
            'items': items, 'coverage': {'complete': complete}}


def button(ref='one', **values):
    return {'ref': ref, 'role': 'button', 'name': '继续', **values}


class PageHelpersTests(unittest.TestCase):
    def test_error_code_is_visible_without_exposing_extra_data(self):
        # 中文注释：回溯首行包含可信错误码，未知结果仍由独立标志判断。
        error = child.BrowserError('未执行，可重新读取页面后重试。', code='tab_out_of_scope', outcome_unknown=False)
        self.assertEqual(str(error), 'BrowserError[tab_out_of_scope]: 未执行，可重新读取页面后重试。 当前来源：unavailable；同站用 goto_url，新站用 browser_shared_open。')
        self.assertFalse(error.outcome_unknown)
        self.assertEqual(str(child.BrowserError('plain')), 'plain')

    def test_wait_for_load_polls_target_unavailable(self):
        unavailable = child.BrowserError('未执行', code='target_unavailable', outcome_unknown=False)
        with patch.object(child, '_call', side_effect=[unavailable, {'readyState': 'interactive'},
                                                       {'readyState': 'complete'}]) as call, \
                patch.object(child.time, 'sleep'):
            self.assertEqual(child.wait_for_load(), 'interactive')
            self.assertEqual(call.call_count, 2)

    def test_wait_for_load_complete_waits_past_interactive(self):
        with patch.object(child, '_call', side_effect=[{'readyState': 'interactive'}, {'readyState': 'complete'}]) as call, \
                patch.object(child.time, 'sleep'):
            self.assertEqual(child.wait_for_load(until='complete'), 'complete')
            self.assertEqual(call.call_count, 2)
        with self.assertRaises(child.BrowserError):
            child.wait_for_load(until='loaded')

    def test_wait_for_load_polls_through_document_replacement(self):
        replaced = child.BrowserError('changed', code='document_changed', outcome_unknown=False)
        with patch.object(child, '_call', side_effect=[replaced, {'readyState': 'loading'}, {'readyState': 'complete'}]) as call, \
                patch.object(child.time, 'sleep'):
            self.assertEqual(child.wait_for_load(), 'complete')
            self.assertEqual(call.call_count, 3)

    def test_wait_for_load_does_not_swallow_real_failures(self):
        denied = child.BrowserError('denied', code='permission_denied', outcome_unknown=False)
        with patch.object(child, '_call', side_effect=[denied]), patch.object(child.time, 'sleep'):
            with self.assertRaises(child.BrowserError):
                child.wait_for_load()

    def test_click_resolves_fresh_ref_and_dispatches_once(self):
        with patch.object(child, '_call', side_effect=[snapshot([button()]), {'clicked': True}]) as call:
            self.assertEqual(child.click_element('继续', role='button'), {'clicked': True})
            self.assertEqual(call.call_count, 2)
            self.assertEqual(call.call_args.args, ('run', ['ref_click', {
                'binding': {'taskId': 'owned'}, 'snapshotId': 'fresh', 'ref': 'one'}]))

    def test_duplicate_disabled_match_uses_enabled_target(self):
        # 中文注释：不可点击的同名项不再阻止唯一可点击项。
        with patch.object(child, '_call', side_effect=[snapshot([button(), button('two', disabled=True)]), {'clicked': True}]) as call:
            self.assertTrue(child.click_element('继续')['clicked'])
            self.assertEqual(call.call_count, 2)

    def test_incomplete_scope_never_implies_uniqueness(self):
        with patch.object(child, '_call', return_value=snapshot([button()], False)) as call:
            with self.assertRaises(child.BrowserError) as caught:
                child.click_element('继续')
            self.assertEqual(caught.exception.code, 'incomplete_target_scope')
            self.assertEqual(call.call_count, 1)

    def test_dynamic_element_waits_only_on_reads(self):
        with patch.object(child, '_call', side_effect=[snapshot([]), snapshot([button(disabled=True)]),
                                                      snapshot([button(busy=True)]), snapshot([button()])]) as call, patch.object(child.time, 'sleep'):
            target = child.wait_for_element('继续', root='#dialog', role='button')
            self.assertEqual(target['ref'], 'one')
            self.assertTrue(all(c.args[1][0] == 'semantic_snapshot' for c in call.call_args_list))
            self.assertEqual(call.call_args.args[1][1]['options']['root'], '#dialog')

    def test_uncertain_or_approval_write_is_not_retried(self):
        for error in (child.BrowserError('unknown'), child.ApprovalRequired('approval')):
            with self.subTest(error=type(error)), patch.object(child, '_call', side_effect=[snapshot([button()]), error]) as call:
                with self.assertRaises(type(error)):
                    child.click_element('继续')
                self.assertEqual(call.call_count, 2)

    def test_timeout_and_invalid_input_do_not_write(self):
        with patch.object(child, '_call', return_value=snapshot([])) as call:
            with self.assertRaises(child.BrowserError) as caught:
                child.wait_for_element('继续', timeout=0)
            self.assertEqual(caught.exception.code, 'element_timeout')
            self.assertEqual(call.call_count, 2)
        for timeout in (float('nan'), float('inf'), -1, True, 61):
            with patch.object(child, '_call') as call:
                with self.assertRaises(child.BrowserError):
                    child.wait_for_element('继续', timeout=timeout)
                call.assert_not_called()

    def test_fill_read_and_scroll_reuse_fixed_actions(self):
        with patch.object(child, '_call', side_effect=[snapshot([button(role='textbox')]), {'filled': True}]) as call:
            child.fill_element('继续', '示例', role='textbox')
            self.assertEqual(call.call_args.args[1][0], 'ref_fill')
        with patch.object(child, '_call', return_value={'coverage': {'complete': False}}) as call:
            self.assertFalse(child.read_page(mode='table', root='#orders')['coverage']['complete'])
            self.assertEqual(call.call_args.args[1][1]['options']['mode'], 'table')
            child.scroll('down')
            self.assertEqual(call.call_args.args, ('run', ['scroll', {'direction': 'down'}]))

    def test_required_suffix_and_whitespace_use_exact_normalized_name(self):
        # 中文注释：必填标记只在末尾去除；原始引用仍交给 ref_fill。
        for suffix in (' *', '（必填）', ' (required)'):
            with self.subTest(suffix=suffix), patch.object(child, '_call', side_effect=[
                    snapshot([{'ref': 'field', 'role': 'textbox', 'name': ' 产品   名称 ' + suffix}]), {'filled': True}]) as call:
                self.assertTrue(child.fill_element('产品 名称', '示例', role='textbox')['filled'])
                self.assertEqual(call.call_args.args[1][1]['ref'], 'field')

    def test_missing_name_returns_nearest_three_without_field_value(self):
        items = [{'ref': str(index), 'role': 'textbox', 'name': name} for index, name in enumerate(
            ('产品标题 *', '产品分类', '产品型号', '售价'))]
        with patch.object(child, '_call', return_value=snapshot(items)):
            with self.assertRaises(child.BrowserError) as caught:
                child.wait_for_element('产品名称', timeout=0)
        self.assertEqual(caught.exception.code, 'element_timeout')
        self.assertEqual(len(caught.exception.candidates), 3)
        self.assertNotIn('示例输入', str(caught.exception))

    def test_set_checked_passes_only_boolean_to_same_ref(self):
        with patch.object(child, '_call', return_value={'checked': True, 'changed': True, 'verified': True}) as call:
            receipt = child.ref_set_checked(snapshot([button()]), 'one', True)
            self.assertTrue(receipt['verified'])
            self.assertEqual(call.call_args.args, ('run', ['ref_set_checked', {
                'binding': {'taskId': 'owned'}, 'snapshotId': 'fresh', 'ref': 'one', 'checked': True}]))
        with patch.object(child, '_call') as call:
            with self.assertRaises(child.BrowserError):
                child.ref_set_checked(snapshot([button()]), 'one', 1)
            call.assert_not_called()

    def test_ref_press_binds_child_frame_and_rejects_unknown_key_before_rpc(self):
        target = {**snapshot([button()]), 'frameToken': 'approved-child'}
        with patch.object(child, '_call', return_value={'pressed': True}) as call:
            child.ref_press(target, 'one', 'ArrowDown')
            # 中文注释：脚本传入的是已取得的子文档 token，不能另选任务或标签页。
            self.assertEqual(call.call_args.args, ('run', ['ref_press', {
                'binding': {'taskId': 'owned'}, 'snapshotId': 'fresh', 'ref': 'one',
                'key': 'ArrowDown', 'frameToken': 'approved-child'}]))
        with patch.object(child, '_call') as call:
            with self.assertRaises(child.BrowserError):
                child.ref_press(target, 'one', 'Delete')
            call.assert_not_called()

    def test_select_option_requires_bounded_unique_values(self):
        with patch.object(child, '_call', return_value={'selectedCount': 2, 'verified': True}) as call:
            receipt = child.ref_select_option(snapshot([button()]), 'one', ['甲', '乙'], by='label')
            self.assertEqual(receipt['selectedCount'], 2)
            self.assertEqual(call.call_args.args[1][0], 'ref_select_option')
            self.assertEqual(call.call_args.args[1][1]['values'], ['甲', '乙'])
        with patch.object(child, '_call') as call:
            with self.assertRaises(child.BrowserError):
                child.ref_select_option(snapshot([button()]), 'one', ['甲', '甲'])
            call.assert_not_called()
        with patch.object(child, '_call', return_value={'selectedCount': 2}) as call:
            # 中文注释：零基 index 经脚本 helper 原样传到绑定任务，不转换为字符串。
            child.ref_select_option(snapshot([button()]), 'one', [0, 2], by='index')
            self.assertEqual(call.call_args.args[1][1]['values'], [0, 2])
        with patch.object(child, '_call') as call:
            with self.assertRaises(child.BrowserError):
                child.ref_select_option(snapshot([button()]), 'one', [True], by='index')
            call.assert_not_called()

    def test_upload_files_accepts_registered_ids_or_local_paths(self):
        file_id = '12345678-1234-1234-1234-123456789abc'
        with patch.object(child, '_call', return_value={'selectionState': 'applied'}) as call:
            child.upload_files('#upload-input', [file_id])
            # 中文注释：旧的登记 ID 入口继续可用，目标任务与标签页由宿主绑定。
            self.assertEqual(call.call_args.args, ('run', ['files.upload', {
                'selector': '#upload-input', 'artifactIds': [file_id]}]))
            child.upload_files('#upload-input', paths=['~/Downloads/user.txt'])
            self.assertEqual(call.call_args.args, ('run', ['files.upload', {
                'selector': '#upload-input', 'paths': [str(Path.home() / 'Downloads/user.txt')]}]))
        with patch.object(child, '_call') as call:
            for ids in ([file_id, file_id], ['/Users/private.txt'], [['nested']]):
                with self.subTest(ids=ids), self.assertRaises(child.BrowserError):
                    child.upload_files('#upload-input', ids)
            for paths in ([], ['a.txt', 'a.txt'], [42], ['x'] * 11):
                with self.subTest(paths=paths), self.assertRaises(child.BrowserError):
                    child.upload_files('#upload-input', paths=paths)
            with self.assertRaises(child.BrowserError):
                child.upload_files('#upload-input', [file_id], paths=['~/Downloads/user.txt'])
            call.assert_not_called()

    def test_download_helpers_copy_claims_into_workspace_only(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as workspace, tempfile.TemporaryDirectory() as private:
            claimed = Path(private) / 'report.csv'
            claimed.write_bytes(b'a,b')
            previous = os.getcwd()
            os.chdir(workspace)
            try:
                with patch.object(child, '_call', return_value={'id': 'd1', 'filename': '../report.csv',
                                                               'localPath': str(claimed), 'sha256': 'x'}) as call:
                    info = child.claim_download('d1')
                    self.assertEqual(call.call_args.args, ('download_claim', ['d1']))
                self.assertEqual(info['path'], 'downloads/report.csv')
                self.assertNotIn('localPath', info)
                self.assertEqual((Path(workspace) / 'downloads/report.csv').read_bytes(), b'a,b')
                with patch.object(child, '_call', return_value={'filename': 'x', 'localPath': str(claimed)}):
                    with self.assertRaises(child.BrowserError):
                        child.claim_download('d1', dest='../../escape.csv')
                rows = [{'id': 'old', 'state': 'complete'}, {'id': 'new', 'state': 'in_progress'}]
                done = [{'id': 'old', 'state': 'complete'}, {'id': 'new', 'state': 'complete'}]
                with patch.object(child, '_call', side_effect=[{'downloads': rows}, {'downloads': done}]), \
                        patch.object(child.time, 'sleep'):
                    self.assertEqual(child.wait_for_download(5, ignore=['old'])['id'], 'new')
            finally:
                os.chdir(previous)

    def test_operation_status_is_a_separate_read_without_replaying_action(self):
        with patch.object(child, '_call', return_value={'state': 'unknown', 'dispatched': True}) as call:
            self.assertEqual(child.operation_status('request-1')['state'], 'unknown')
            self.assertEqual(call.call_args.args, ('operation_status', ['request-1']))
        with patch.object(child, '_call') as call:
            with self.assertRaises(child.BrowserError):
                child.operation_status('')
            call.assert_not_called()

    def test_reconnect_polls_only_read_only_task_state(self):
        with patch.object(child, '_call', side_effect=[{'state': 'disconnected'},
                                                       {'state': 'ready', 'requiresReconciliation': True}]) as call, \
                patch.object(child.time, 'sleep'):
            result = child.reconnect(timeout_s=2)
            self.assertTrue(result['requiresReconciliation'])
            self.assertEqual([item.args for item in call.call_args_list],
                             [('reconnect', []), ('reconnect', [])])


if __name__ == '__main__':
    unittest.main()
