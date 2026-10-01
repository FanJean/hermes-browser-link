"""新增状态动作进入扩展前的 daemon 参数边界。"""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'native-bridge'))
from daemon import BridgeDaemon, ProtocolError  # noqa: E402


class ControlsValidationTests(unittest.TestCase):
    def setUp(self):
        self.base = {'owner': 'owner', 'taskId': 'task', 'requestId': 'request', 'tabId': 7,
                     'binding': {'taskId': 'task', 'documentId': 'document', 'leaseId': 'lease'},
                     'snapshotId': 'snapshot', 'ref': 'ref'}

    def test_checked_rejects_non_boolean_before_browser_dispatch(self):
        # 中文注释：数字 1 不能伪装成 true，避免调用方误触页面控件。
        for checked in (1, 'true', None):
            with self.subTest(checked=checked), self.assertRaises(ProtocolError) as caught:
                BridgeDaemon._validate_run_params('ref_set_checked', {**self.base, 'action': 'ref_set_checked',
                                                                      'checked': checked})
            self.assertEqual(caught.exception.code, 'invalid_params')
        BridgeDaemon._validate_run_params('ref_set_checked', {**self.base, 'action': 'ref_set_checked',
                                                               'checked': False})

    def test_select_rejects_ambiguous_request_shape(self):
        good={**self.base, 'action': 'ref_select_option', 'by': 'label', 'values': ['甲', '乙']}
        BridgeDaemon._validate_run_params('ref_select_option', good)
        for patch in ({'by': []}, {'values': ['甲', '甲']}, {'values': '甲'}, {'values': ['x'*1001]}):
            with self.subTest(patch=patch), self.assertRaises(ProtocolError) as caught:
                BridgeDaemon._validate_run_params('ref_select_option', {**good, **patch})
            self.assertEqual(caught.exception.code, 'invalid_params')


if __name__ == '__main__':
    unittest.main()
