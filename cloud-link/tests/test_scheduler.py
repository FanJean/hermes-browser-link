"""并发与回收回归：使用可控阻塞检查顺序，不依赖个人浏览器。"""
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime.client import Journal
from runtime.scheduler import Scheduler


def command(id, session='session-a', task='task-a', tab=1, tool='run'):
    args = {'task_id': task}
    if tool == 'run':
        args.update(action='snapshot', tab_id=tab)
    return {'id': id, 'session_id': session, 'device_id': 'device', 'tool': tool,
            'args': args, 'expires_at': time.time()+30}


class ControlledExecutor:
    def __init__(self):
        self.started = {}
        self.gates = {}
        self.order = []
        self.guard = threading.Lock()
    def prepare(self, *ids):
        for id in ids:
            self.started[id] = threading.Event()
            self.gates[id] = threading.Event()
    def execute(self, cmd):
        with self.guard:
            self.order.append(cmd['id'])
        self.started[cmd['id']].set()
        if cmd['tool'] == 'cancel':
            for gate in self.gates.values(): gate.set()
        self.gates[cmd['id']].wait(3)
        return {'id':cmd['args']['task_id'], 'state':'closed' if cmd['tool']=='close' else 'ready'}
    def close(self, *, sessions=()):
        for gate in self.gates.values(): gate.set()
        return list(sessions)


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.journal = Journal(Path(self.tmp.name)/'journal.sqlite', check_same_thread=False)
        self.addCleanup(self.journal.close)
        self.executor = ControlledExecutor()
        self.scheduler = Scheduler(self.journal,self.executor,workers=2)
        self.addCleanup(self.scheduler.stop)
    def wait_started(self,id):
        self.assertTrue(self.executor.started[id].wait(2), id)
    def drain(self):
        deadline=time.monotonic()+3
        while self.scheduler.busy_sessions() and time.monotonic()<deadline:
            self.scheduler.pump();time.sleep(.005)
        self.assertFalse(self.scheduler.busy_sessions())
    def test_other_session_and_other_page_do_not_wait_for_approval(self):
        # 中文注释：两个会话即使用同 task/tab 数字，也不能进入同一个调度通道。
        self.executor.prepare('a','b')
        self.scheduler.add([command('a'),command('b',session='session-b')])
        self.wait_started('a');self.wait_started('b')
        for gate in self.executor.gates.values():gate.set()
        self.drain()
        self.executor.prepare('c','d')
        self.scheduler.add([command('c',tab=1),command('d',tab=2)])
        self.wait_started('c');self.wait_started('d')
    def test_same_page_fifo_and_close_waits_for_all_prior_pages(self):
        self.executor.prepare('a','b','c','close','after')
        self.scheduler.add([command('a'),command('b'),command('c',tab=2),command('close',tool='close'),command('after',tab=2)])
        self.wait_started('a');self.wait_started('c')
        self.assertFalse(self.executor.started['b'].is_set())
        self.assertFalse(self.executor.started['close'].is_set())
        self.executor.gates['a'].set();self.executor.gates['c'].set()
        deadline=time.monotonic()+2
        while not self.executor.started['b'].is_set() and time.monotonic()<deadline:
            self.scheduler.pump();time.sleep(.005)
        self.wait_started('b');self.assertFalse(self.executor.started['close'].is_set())
        self.executor.gates['b'].set()
        deadline=time.monotonic()+2
        while not self.executor.started['close'].is_set() and time.monotonic()<deadline:
            self.scheduler.pump();time.sleep(.005)
        self.wait_started('close');self.assertFalse(self.executor.started['after'].is_set())
        self.executor.gates['close'].set();self.executor.gates['after'].set();self.drain()
        self.assertLess(self.executor.order.index('close'),self.executor.order.index('after'))
    def test_cancel_and_status_have_reserved_capacity_when_pages_block(self):
        self.executor.prepare('a','b','get','cancel')
        self.scheduler.add([command('a'),command('b',tab=2),command('get',tool='get'),command('cancel',tool='cancel')])
        for id in ('a','b','get','cancel'):self.wait_started(id)
        self.drain()
    def test_duplicate_claim_and_parallel_journal_do_not_repeat_action(self):
        self.executor.prepare('a');self.executor.gates['a'].set()
        cmd=command('a')
        self.scheduler.add([cmd]);self.drain()
        self.scheduler.add([cmd]);self.drain()
        self.assertEqual(self.executor.order,['a'])
        self.assertEqual(len(self.journal.pending()),1)
    def test_full_page_backlog_preserves_cancel_intake(self):
        # 中文注释：二十条页面请求占满普通队列时，本机仍有四个控制接收位置。
        ids=[f'page-{i}' for i in range(20)];self.executor.prepare(*ids,'cancel')
        self.scheduler.add([command(id,session=f's-{i}',tab=i) for i,id in enumerate(ids)])
        self.scheduler.add([command('cancel',tool='cancel')]);self.wait_started('cancel');self.drain()

    def test_idle_gc_excludes_running_sessions_and_syncs_only_closed_routes(self):
        cmd=command('a');self.journal.reserve(cmd)
        self.journal.db.execute('UPDATE sessions SET last_used=0');self.journal.db.commit()
        self.assertEqual(self.journal.idle({'session-a'}),[])
        self.assertEqual(self.journal.idle(set()),['session-a'])
        self.journal.mark_closed('session-a');self.assertEqual(self.journal.closed_sessions(),['session-a'])
        self.journal.mark_synced(['session-a']);self.assertEqual(self.journal.closed_sessions(),[])

if __name__=='__main__':unittest.main()
