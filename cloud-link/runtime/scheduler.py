"""云端有界调度：会话隔离、页面顺序、任务关闭屏障和取消通道。"""
from concurrent.futures import ThreadPoolExecutor
import threading


class Scheduler:
    def __init__(self, journal, executor, *, workers=6, capacity=24):
        self.journal, self.executor = journal, executor
        self.workers, self.capacity = workers, capacity
        self.pool = ThreadPoolExecutor(max_workers=workers + 2, thread_name_prefix='cloud-task')
        self.pending = []
        self.running = {}
        self.stopping = False
        self.guard = threading.RLock()

    @staticmethod
    def lane(command):
        # 中文注释：任务控制和建页是屏障，具体页面动作只排在同一页面之前的动作后。
        args = command['args']
        session = command['session_id']
        task = args.get('task_id')
        tab = args.get('tab_id') if command['tool'] == 'run' else None
        return session, task, tab

    @classmethod
    def conflicts(cls, left, right):
        if left['tool'] in ('get','list') or right['tool'] in ('get','list'):
            return False
        ls, lt, lp = cls.lane(left)
        rs, rt, rp = cls.lane(right)
        if ls != rs:
            return False
        if lt is None or rt is None:
            return True
        return lt == rt and (lp is None or rp is None or lp == rp)

    def available(self):
        with self.guard:
            return 0 if self.stopping else self.capacity - len(self.pending) - len(self.running)

    def add(self, commands):
        with self.guard:
            if len(commands) > self.available():
                raise ValueError('cloud_scheduler_full')
            for command in commands:
                # 中文注释：入本机账本后才能调度，崩溃后的未执行领取也不会自动重放。
                if self.journal.reserve(command):
                    self.pending.append(command)
            self.pump()

    def pump(self):
        with self.guard:
            if self.stopping:
                return
            blocked = []
            control_tools = ('cancel','get','list')
            actions = sum(c['tool'] not in control_tools for c in self.running.values())
            cancels = sum(c['tool'] == 'cancel' for c in self.running.values())
            queries = len(self.running) - actions - cancels
            for command in list(self.pending):
                cancel = command['tool'] == 'cancel'
                control = command['tool'] in control_tools
                # 中文注释：取消使用预留工作线程，可中断等待审批；关闭保持任务内先后顺序。
                # 中文注释：状态查询不能占满取消线程，各保留一个席位。
                full = cancels >= 1 if cancel else (queries >= 1 if control else actions >= self.workers)
                predecessors = list(self.running.values()) + blocked
                if full or (not cancel and any(self.conflicts(command, old) for old in predecessors)):
                    blocked.append(command)
                    continue
                self.pending.remove(command)
                future = self.pool.submit(self.journal.execute, command, self.executor, reserved=True)
                self.running[future] = command
                if cancel:
                    cancels += 1
                elif control:
                    queries += 1
                else:
                    actions += 1
                future.add_done_callback(self._finished)

    def _finished(self, future):
        with self.guard:
            self.running.pop(future, None)

    def busy_sessions(self):
        with self.guard:
            return {c['session_id'] for c in self.pending + list(self.running.values())}

    def stop(self):
        with self.guard:
            self.stopping = True
            for command in self.pending:
                self.journal.abandon(command['id'])
            self.pending.clear()
        # 中文注释：先撤销本机任务释放审批，再等待线程退出，最后关闭通信与数据库资源。
        for session in self.executor.close(sessions=self.journal.active_sessions()):
            self.journal.mark_closed(session)
        self.pool.shutdown(wait=True, cancel_futures=False)
