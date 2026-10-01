"""中文注释：任务首次读取网站的 daemon 审批、来源绑定与模式代次回归。"""
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'native-bridge'))
from daemon import BridgeDaemon, ProtocolError

SITE_A = 'https://site-a.test'
SITE_B = 'https://site-b.test'


class SiteReadApprovalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.daemon = BridgeDaemon(Path(self.temp.name))
        self.daemon._prepare_data_dir()
        self.addCleanup(self.daemon._flush_tasks)
        self.daemon.extensions['browser'] = {'browser': 'chrome'}
        self.daemon._notify_tasks_changed = lambda _: None
        created = self.daemon._dispatch_client('shared.create', {
            'owner': 'owner', 'title': '站点读取测试', 'instanceId': 'browser',
            'allowedOrigins': [SITE_A, SITE_B]})
        self.task = self.daemon._dispatch_extension('browser', 'extension.approve', {
            'taskId': created['id'], 'tabIds': [7], 'allowedOrigins': created['allowedOrigins']})
        self.origins = {7: SITE_A, 8: SITE_B}
        self.executed = []

        def extension_call(_extension, method, params, **_kwargs):
            if method == 'browser.read_origin':
                return {'origin': self.origins[params['tabId']]}
            if method == 'browser.execute':
                self.executed.append((params['action'], params.get('approvedReadOrigin')))
                if params['action'] == 'new_tab':
                    return {'tabId': 8, 'url': SITE_B + '/new', 'ready': True, 'groupId': 3, 'windowId': 4}
                if params['action'] == 'tabs':
                    return [{'id': 7}]
                return {'site': self.origins.get(params.get('tabId'), SITE_B)}
            if method == 'browser.release':
                return {'released': True, 'cleanupState': 'succeeded', 'remainingTabIds': [],
                        'preservedTabIds': [], 'unknownTabIds': []}
            raise AssertionError(method)

        self.daemon._extension_call = extension_call

    def run_action(self, action='snapshot', tab_id=7, request_id='read-1', **extra):
        return self.daemon._dispatch_client('shared.run', {
            'owner': 'owner', 'taskId': self.task['id'], 'requestId': request_id,
            'action': action, **({} if tab_id is None else {'tabId': tab_id}), **extra})

    def decide(self, approve=True):
        approval = self.daemon._dispatch_extension('browser', 'extension.approvals', {})[0]
        self.daemon._dispatch_extension('browser', 'extension.decide', {
            'taskId': self.task['id'], 'nonce': approval['nonce'],
            'digest': approval['digest'], 'approve': approve})
        if approve:
            deadline = time.time() + 2
            while time.time() < deadline:
                status = self.daemon._dispatch_client('shared.operation_status', {
                    'owner': 'owner', 'taskId': self.task['id'],
                    'requestId': approval['request']['requestId']})
                if status.get('state') in {'confirmed', 'rejected', 'unknown'}:
                    break
                time.sleep(.01)
        return approval

    def test_first_read_then_same_site_direct_and_new_site_rejected(self):
        self.assertEqual(self.run_action('tabs', tab_id=None, request_id='tabs'), [{'id': 7}])
        self.assertEqual(self.daemon.tasks[self.task['id']]['readOrigins'], [])
        first = self.run_action()
        self.assertEqual(first['status'], 'approval_required')
        self.assertEqual(self.executed, [('tabs', None)])
        approval = self.daemon._dispatch_extension('browser', 'extension.approvals', {})[0]
        self.assertEqual(approval['readOrigin'], SITE_A)
        self.assertEqual(approval['request']['action'], 'snapshot')
        self.decide()
        self.assertEqual(self.run_action(), {'site': SITE_A})
        self.assertEqual(self.run_action(request_id='read-2'), {'site': SITE_A})
        self.assertEqual(self.daemon._dispatch_extension('browser', 'extension.approvals', {}), [])
        self.origins[7] = SITE_B
        self.assertEqual(self.run_action(request_id='new-site')['status'], 'approval_required')
        self.assertEqual(self.daemon._dispatch_extension('browser', 'extension.approvals', {})[0]['readOrigin'], SITE_B)
        self.decide(False)
        with self.assertRaises(ProtocolError) as denied:
            self.run_action(request_id='new-site')
        self.assertEqual(denied.exception.code, 'approval_denied')
        self.assertEqual(self.executed.count(('snapshot', SITE_B)), 0)
        self.assertEqual(self.run_action(request_id='new-site-approved')['status'], 'approval_required')
        self.decide()
        self.assertEqual(self.run_action(request_id='new-site-approved'), {'site': SITE_B})
        self.assertEqual(self.run_action(request_id='new-site-next'), {'site': SITE_B})

    def test_navigation_grants_target_read_and_writes_remain_per_action(self):
        # 中文注释：新建页批准同时说明目标站点可读，后续读取无需第二个弹窗。
        waiting = self.run_action('new_tab', tab_id=None, request_id='open-b', url=SITE_B + '/new')
        self.assertEqual(waiting['status'], 'approval_required')
        self.assertEqual(self.daemon._dispatch_extension('browser', 'extension.approvals', {})[0]['readOrigin'], SITE_B)
        self.decide()
        self.assertEqual(self.run_action('new_tab', tab_id=None, request_id='open-b', url=SITE_B + '/new')['tabId'], 8)
        self.assertEqual(self.run_action(tab_id=8, request_id='read-b'), {'site': SITE_B})
        self.assertEqual(self.run_action('click', tab_id=8, request_id='write-1', selector='#save')['status'], 'approval_required')
        self.decide()
        self.assertEqual(self.run_action('click', tab_id=8, request_id='write-1', selector='#save'), {'site': SITE_B})
        self.assertEqual(self.run_action('click', tab_id=8, request_id='write-2', selector='#save')['status'], 'approval_required')

    def test_navigation_approval_can_grant_destination_read(self):
        # 中文注释：从已打开页面导航到新来源时，批准导航可同时批准目标站点读取。
        waiting = self.run_action('navigate', request_id='navigate-b', url=SITE_B + '/inbox')
        self.assertEqual(waiting['status'], 'approval_required')
        self.assertEqual(self.daemon._dispatch_extension('browser', 'extension.approvals', {})[0]['readOrigin'], SITE_B)
        self.decide()
        self.origins[7] = SITE_B
        self.assertEqual(self.run_action(request_id='destination-read'), {'site': SITE_B})

    def test_mode_change_and_task_end_clear_site_read_grants(self):
        self.assertEqual(self.run_action()['status'], 'approval_required')
        self.decide()
        self.assertEqual(self.run_action(request_id='same-site'), {'site': SITE_A})
        task = self.daemon.tasks[self.task['id']]
        for mode in ('full', 'smart'):
            self.daemon._dispatch_extension('browser', 'extension.mode', {
                'taskId': task['id'], 'generation': task['generation'],
                'modeGeneration': task['modeGeneration'], 'mode': mode})
        self.assertEqual(task['readOrigins'], [])
        with self.assertRaises(ProtocolError) as stale:
            self.run_action(request_id='same-site')
        self.assertEqual(stale.exception.code, 'approval_revoked')
        self.assertEqual(self.run_action(request_id='again')['status'], 'approval_required')
        self.daemon._dispatch_client('shared.cancel', {'owner': 'owner', 'taskId': task['id']})
        self.assertEqual(task['readOrigins'], [])
        with self.assertRaises(ProtocolError):
            self.run_action(request_id='after-stop')

    def test_site_change_while_approval_is_open_never_returns_new_site_content(self):
        # 中文注释：批准旧来源的弹窗不能读取已经跳转到的新网站。
        self.assertEqual(self.run_action(request_id='moving')['status'], 'approval_required')
        self.origins[7] = SITE_B
        self.decide()
        with self.assertRaises(ProtocolError) as changed:
            self.run_action(request_id='moving')
        self.assertEqual(changed.exception.code, 'approval_revoked')
        self.assertEqual(self.executed, [])
        self.assertEqual(self.daemon.tasks[self.task['id']]['readOrigins'], [])

    def test_task_owned_blank_page_needs_no_site_read_grant(self):
        # 中文注释：空白工作页没有网站来源，不生成网站读取批准。
        self.origins[7] = 'about:blank'
        self.assertEqual(self.run_action('official.ready_state', request_id='blank'), {'site': 'about:blank'})
        self.assertEqual(self.daemon._dispatch_extension('browser', 'extension.approvals', {}), [])


if __name__ == '__main__':
    unittest.main()
