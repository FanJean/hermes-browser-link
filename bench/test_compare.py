"""中文注释：对比测试覆盖退步方向与零基线。"""
import unittest
from compare import compare, markdown


class CompareTests(unittest.TestCase):
    def test_mechanical(self):
        before = {'kind': 'mechanical', 'metrics': {'open': {'p50Ms': 100, 'successRate': 1}}}
        after = {'kind': 'mechanical', 'metrics': {'open': {'p50Ms': 120, 'successRate': .8}}}
        rows = compare(before, after)
        self.assertTrue(all(row['regression'] for row in rows))
        self.assertIn('20.0%', markdown(rows))

    def test_agent_and_zero(self):
        before = {'kind': 'agent', 'tasks': [{'name': 'x', 'correctness': {'score': 0}, 'efficiency': {'modelCalls': 0}}]}
        after = {'kind': 'agent', 'tasks': [{'name': 'x', 'correctness': {'score': 1}, 'efficiency': {'modelCalls': 2}}]}
        rows = compare(before, after)
        self.assertEqual(rows[0]['percent'], '基线为 0')
        self.assertFalse(rows[0]['regression'])
        self.assertTrue(rows[1]['regression'])
        with self.assertRaises(ValueError):
            compare(before, {'kind': 'mechanical', 'metrics': {}})

    def test_lifecycle_missing_remains_visible(self):
        # 中文注释：生命周期指标即使只有一轮有值，也保留在对比表中。
        before = {'kind': 'agent', 'tasks': [{'name': 'x', 'correctness': {}, 'efficiency': {'openCalls': 3, 'remainingTabs': '未拿到'}}]}
        after = {'kind': 'agent', 'tasks': [{'name': 'x', 'correctness': {}, 'efficiency': {'openCalls': 2, 'remainingTabs': 1}}]}
        rows = {row['metric']: row for row in compare(before, after)}
        self.assertEqual(rows['x.openCalls']['delta'], -1)
        self.assertEqual(rows['x.remainingTabs']['delta'], '未拿到')


if __name__ == '__main__':
    unittest.main()
