"""截图导出根与名称匹配回归。"""
import importlib.util
import base64
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


child = module('browser_child_142', 'executor-plugin/script_lane/child.py')
script = module('browser_script_142', 'executor-plugin/script_lane/tool.py')


class PathsAndNames(unittest.TestCase):
    def test_export_root_and_escape_rules(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            workspace, exports, outside = (base / 'workspace', base / 'exports', base / 'outside')
            for directory in (workspace, exports, outside):
                directory.mkdir()
            (exports / 'escape').symlink_to(outside, target_is_directory=True)
            old = Path.cwd()
            try:
                os.chdir(workspace)
                png = base64.b64encode(b'PNG fixture').decode()
                with patch.dict(os.environ, {'HERMES_BROWSER_EXPORT_ROOTS': str(exports)}), \
                        patch.object(child, '_call', return_value={'data': png}) as call:
                    saved = child.screenshot(str(exports / 'proof.png'))
                    self.assertEqual(saved, str(exports / 'proof.png'))
                    self.assertEqual((exports / 'proof.png').read_bytes(), b'PNG fixture')
                    self.assertEqual(call.call_args.args[1][1]['format'], 'png')
                    for denied in (exports / 'proof.png', exports / '..' / 'outside' / 'bad.png',
                                   exports / 'escape' / 'bad.png'):
                        with self.assertRaises(child.BrowserError) as caught:
                            child.screenshot(str(denied))
                        self.assertEqual(caught.exception.code, 'invalid_params')
                with patch.dict(os.environ, {'HERMES_BROWSER_EXPORT_ROOTS': ''}):
                    with self.assertRaises(child.BrowserError) as caught:
                        child.screenshot(str(exports / 'unconfigured.png'))
                    self.assertIn(str(workspace), str(caught.exception))
            finally:
                os.chdir(old)

    def test_screenshot_target_passes_latest_reference_or_selector(self):
        # 中文注释：对准元素只增加定位参数，不派发点击。
        with tempfile.TemporaryDirectory() as temp:
            old = Path.cwd()
            try:
                os.chdir(temp)
                found = {'snapshot': {'binding': {'taskId': 't'}, 'snapshotId': 's'}, 'ref': 'r'}
                with patch.dict(os.environ, {'HERMES_BROWSER_EXPORT_ROOTS': ''}), \
                        patch.object(child, 'wait_for_element', return_value=found), \
                        patch.object(child, '_call', return_value={'data': base64.b64encode(b'png').decode()}) as call:
                    self.assertEqual(child.screenshot('named.png', name='Submit'), str(Path(temp).resolve() / 'named.png'))
                    self.assertEqual(call.call_args.args, ('run', ['screenshot',
                        {'format': 'png', 'binding': {'taskId': 't'}, 'snapshotId': 's', 'ref': 'r'}]))
                    child.screenshot('selected.jpg', selector='#result')
                    self.assertEqual(call.call_args.args, ('run', ['screenshot', {'format': 'jpeg', 'selector': '#result'}]))
            finally:
                os.chdir(old)

    def test_suffixes_only_at_edges(self):
        # 中文注释：中间的 Optional 是名称正文，不应被删除。
        for label in ('Tool Description (optional)', 'Tool Description（可选）',
                      'Tool Description（选填）', 'Tool Description optional',
                      'Tool Description required', '* Tool Description：',
                      'Tool Description (required)', 'Tool Description *'):
            self.assertEqual(child._normalized_accessible_name(label), 'tool description')
        self.assertEqual(child._normalized_accessible_name('Optional Add-ons'), 'optional add-ons')

    def test_editable_candidate_wins_and_readonly_is_specific(self):
        page = {'kind': 'full', 'binding': {'taskId': 't'}, 'snapshotId': 's', 'coverage': {'complete': True},
                'items': [{'ref': 'old', 'role': 'textbox', 'name': 'Description', 'readonly': True},
                          {'ref': 'new', 'role': 'textbox', 'name': 'Description'}]}
        with patch.object(child, 'semantic_snapshot', return_value=page):
            self.assertEqual(child.wait_for_element('Description', action='fill')['ref'], 'new')
            page['items'].pop()
            with self.assertRaises(child.BrowserError) as caught:
                child.wait_for_element('Description', action='fill', timeout=0)
            self.assertEqual(caught.exception.code, 'target_readonly')

    def test_button_and_submit_input_with_same_name_are_ambiguous(self):
        # 中文注释：两个可点击按钮同名时仍要求更窄范围。
        page = {'kind': 'full', 'binding': {'taskId': 't'}, 'snapshotId': 's', 'coverage': {'complete': True},
                'items': [{'ref': 'button', 'role': 'button', 'name': 'Submit'},
                          {'ref': 'input', 'role': 'button', 'name': 'Submit'}]}
        with patch.object(child, 'semantic_snapshot', return_value=page):
            with self.assertRaises(child.BrowserError) as caught:
                child.wait_for_element('Submit', role='button', action='click', timeout=0)
            self.assertEqual(caught.exception.code, 'ambiguous_target')

    def test_shared_home_env_for_other_profile(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            (home / '.env').write_text('HERMES_BROWSER_EXPORT_ROOTS=/tmp/export-a:/tmp/export-b\n')
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(script._export_roots(home), '/tmp/export-a:/tmp/export-b')


if __name__ == '__main__':
    unittest.main()
