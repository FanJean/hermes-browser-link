"""独立云端执行器；使用已有本机桥和结果投影，不注册或覆盖 Hermes 工具。"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import threading
import time

from .capabilities import CLOUD_ACTIONS, NATIVE_BRIDGE, PLUGIN, TOOL_SUFFIXES, native_tools
from .bridge_pool import BridgePool


class CloudDenied(ValueError):
    pass


class CloudExecutor:
    def __init__(self, home, data_dir, device_id, instance_id, allowed_origins, *, client=None, bind_task=None, full_access=False):
        self.device_id = device_id
        self.instance_id = instance_id
        self.allowed_origins = frozenset(allowed_origins)
        if client is None and bind_task is None:
            raise CloudDenied('cloud_native_authorization_required')
        self.full_access = full_access
        self.bind_task = bind_task
        runtime_module = native_tools._runtime
        client_module = runtime_module.load_module(NATIVE_BRIDGE / 'client.py', 'cloud_bridge_client_')
        self._bridge_errors = (client_module.BridgeError,OSError,RuntimeError)
        # 中文注释：云端只连接已运行的桥；不启动、重启或卸载现有本地服务。
        self.client = client or BridgePool(home)
        self.cleanup_client = client or client_module.BridgeClient(home, timeout=35, autostart=False)
        self.runtime = runtime_module.NativeProfileRuntime(Path(data_dir) / 'profile', PLUGIN, bridge_client=self.client)
        self._close_lock = threading.Lock()
        self._closed = False
        self._active = 0
        self._condition = threading.Condition()
        # 中文注释：快照只包含启动时已有云端身份，旧执行器不能回收新配对后来建立的任务。
        self._owners = set(self.runtime.authority.known_owners())

    def execute(self, command):
        with self._condition:
            if self._closed:
                raise CloudDenied('cloud_disabled')
            self._active += 1
        try:
            return self._execute(command)
        finally:
            with self._condition:
                self._active -= 1
                self._condition.notify_all()

    def _execute(self, command):
        if self._closed:
            raise CloudDenied('cloud_disabled')
        # 中文注释：设备和会话来自认证队列，模型参数不能指定 owner 或本机实例。
        if command.get('device_id') != self.device_id or command.get('tool') not in TOOL_SUFFIXES:
            raise CloudDenied('cloud_scope_denied')
        session = command.get('session_id')
        request_id = command.get('id')
        args = command.get('args')
        if not isinstance(session, str) or not session or not isinstance(request_id, str) or not request_id:
            raise CloudDenied('cloud_identity_required')
        if not isinstance(args, dict) or any(key in args for key in ('owner', 'session_id', 'instance_id',
                                                                 native_tools._runtime.OWNER_LEASE_ARG, 'request_id')):
            raise CloudDenied('cloud_identity_denied')
        if time.time() >= command['expires_at']:
            raise CloudDenied('cloud_command_expired')
        args = dict(args)
        tool = command['tool']
        if tool == 'create':
            origins = args.get('allowed_origins')
            if not isinstance(origins, list) or not origins or (self.allowed_origins and not self.full_access and not set(origins) <= self.allowed_origins):
                raise CloudDenied('cloud_origin_denied')
            args['instance_id'] = self.instance_id
            args['title'] = '[云端] ' + str(args.get('title', ''))[:195]
        if tool == 'run':
            if args.get('action') not in CLOUD_ACTIONS:
                raise CloudDenied('cloud_action_denied')
            args['request_id'] = request_id
        if tool == 'get' and ('until' in args or 'timeout_s' in args):
            raise CloudDenied('cloud_action_denied')
        trusted_session = hashlib.sha256((self.device_id + '\0' + session).encode()).hexdigest()
        owner = self.runtime.authority.owner_for_session(trusted_session)
        with self._condition:
            self._owners.add(owner)
        if tool not in ('create', 'list'):
            # 中文注释：先回读任务归属，禁止云端使用本地任务或同 owner 的其他浏览器实例。
            task = self.runtime.call('shared.get', {'owner': owner, 'taskId': args.get('task_id')})
            if task.get('instanceId') != self.instance_id or (self.allowed_origins and not self.full_access and not set(task.get('allowedOrigins', [])) <= self.allowed_origins):
                raise CloudDenied('cloud_task_denied')
            if tool == 'run' and self.bind_task:
                # 中文注释：每次动作前重验独立权限，防止服务重启或撤权后沿用旧的 full 租约。
                self.bind_task(task, self.full_access)
                observed = self.runtime.call('shared.get', {'owner': owner, 'taskId': args['task_id']})
                if observed.get('activeMode') != ('full' if self.full_access else 'smart'):
                    raise CloudDenied('cloud_policy_not_confirmed')
        tool_name = 'browser_shared_' + tool
        handler = native_tools.make_tool_handler(tool_name, self.runtime)
        def invoke():
            # 中文注释：每次读取原请求回执都使用新的一次性身份租约，浏览器 requestId 保持不变。
            lease = self.runtime.authority.pre_tool_call(tool_name, args, session_id=trusted_session, tool_call_id=request_id)
            if not lease or lease.get('action') != 'modify':
                raise CloudDenied('cloud_identity_denied')
            return json.loads(handler({**args, **lease['args']}, session_id=trusted_session))
        value = invoke()
        if tool in ('create', 'resume') and self.bind_task and isinstance(value, dict) and value.get('id'):
            # 中文注释：在回传任务前，由独立 Native 通道把云端任务绑定到独立授权模式。
            try:
                self.bind_task(value, self.full_access)
                # 中文注释：授权读回也复用本地闭合结果投影，不能把 Native 原始字段发给云端。
                observed = self.runtime.call('shared.get', {'owner': owner, 'taskId': value['id']})
                value = native_tools._public(native_tools._runtime._base._project_tool_result(tool_name, args, observed))
            except Exception:
                self.cleanup_client.call('shared.handoff', {'owner': owner, 'taskId': value['id'], 'keepTabs': True})
                raise CloudDenied('cloud_authorization_unavailable') from None
        if tool == 'run':
            # 中文注释：审批回调在 daemon 内执行；这里只查询同一请求的缓存回执，不创建新动作。
            while isinstance(value, dict) and value.get('status') in ('approval_required', 'user_input_required'):
                if self._closed or time.time() >= command['expires_at']:
                    self.cleanup_client.call('shared.handoff', {'owner': owner, 'taskId': args['task_id'], 'keepTabs': True})
                    return {'code': 'cloud_approval_expired', 'outcome_unknown': True}
                time.sleep(0.5)
                status = self.runtime.call('shared.operation_status', {'owner': owner, 'taskId': args['task_id'], 'requestId': request_id})
                if status.get('state') == 'unknown':
                    return {'code': 'outcome_unknown', 'outcome_unknown': True}
                # 中文注释：审批后动作由 daemon 执行，派发中只查账本；终态再读取同一请求的缓存回执。
                if status.get('state') in ('confirmed', 'rejected'):
                    value = invoke()
        if tool == 'list':
            value = [task for task in value if task.get('instanceId') == self.instance_id] if isinstance(value, list) else value
        if isinstance(value, dict) and value.get('state') in ('closed','cancelled'):
            with self._condition:
                self._owners.discard(owner)
            if value.get('cleanupState') == 'succeeded':
                self._forget_owner(owner)
        return value

    def handoff_session(self, session):
        # 中文注释：只交还当前云端会话的任务；不同会话使用不同 owner，不能串收资源。
        trusted = hashlib.sha256((self.device_id + '\0' + session).encode()).hexdigest()
        owner = self.runtime.authority.owner_for_session(trusted)
        return self._handoff_owner(owner)

    def _handoff_owner(self, owner):
        complete = True
        for task in self.cleanup_client.call('shared.list', {'owner': owner}):
            if task.get('instanceId') != self.instance_id:
                complete = False
                continue
            if task.get('state') not in ('closed', 'cancelled', 'failed'):
                task = self.cleanup_client.call('shared.handoff', {'owner': owner, 'taskId': task['id'], 'keepTabs': True})
            if task.get('state') in ('closed','cancelled') and task.get('cleanupState') != 'succeeded':
                # 中文注释：先读取原清理证明；自动回收只核实移交，不删除已交还用户的页面。
                task = self.cleanup_client.call('shared.cleanup_status', {'owner': owner, 'taskId': task['id']})
            complete = complete and task.get('cleanupState') == 'succeeded'
        with self._condition:
            if complete and not self._closed:
                self._owners.discard(owner)
                self._forget_owner(owner)
        return complete

    def _forget_owner(self, owner):
        # 中文注释：仅释放云端私有 profile 内的已结束身份，HMAC 密钥不变，原本地身份表不触碰。
        authority = self.runtime.authority
        with authority._lock, authority._registry_thread_lock:
            fd = authority._acquire_registry_file_lock()
            try:
                authority._known_owners = authority._load_known_owners()
                authority._known_owners.discard(owner)
                authority._save_known_owners_locked()
            finally:
                authority._release_registry_file_lock(fd)

    def _owner_snapshot(self):
        with self._condition:
            return tuple(self._owners)

    def close(self, *, sessions=()):
        # 中文注释：停用只交还云端私有身份的任务，不清理本地 owner，不终止共享 daemon。
        with self._close_lock:
            if self._closed:
                return []
            self._closed = True
        session_owners = {session:self.runtime.authority.owner_for_session(
            hashlib.sha256((self.device_id+'\0'+session).encode()).hexdigest()) for session in sessions}
        with self._condition:
            self._owners.update(session_owners.values())
        confirmed = set()
        def reclaim(owner):
            # 中文注释：单个任务的未知清理不能阻断其他会话收尾，也不能被当作已清理。
            try:
                return self._handoff_owner(owner)
            except self._bridge_errors:
                return False
        try:
            for owner in self._owner_snapshot():
                reclaim(owner)
            # 中文注释：在途建页或创建可能晚于首轮扫描，等工作线程收尾后再扫一次防止孤儿任务。
            with self._condition:
                self._condition.wait_for(lambda: self._active == 0)
            for owner in self._owner_snapshot():
                if reclaim(owner):
                    self._forget_owner(owner)
                    confirmed.add(owner)
        finally:
            self.runtime.close()
            self.client.close()
            self.cleanup_client.close()
        return [session for session,owner in session_owners.items() if owner in confirmed]
