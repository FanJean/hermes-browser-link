"""浏览器专属云端连接：Native 端只保存本地配对、独立权限和传输去重。"""
from __future__ import annotations

from functools import wraps
import fcntl
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import threading
import time
from urllib.error import HTTPError, URLError

from .capabilities import TOOL_SUFFIXES
from .client import Journal, Relay, load_config, private_directory, save_config
from .executor import CloudExecutor
from .scheduler import Scheduler

CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'


def connection_code():
    # 中文注释：十二位易读连接码，只在本机显示；云端保存摘要，五分钟后失效。
    raw = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(12))
    return raw[:6] + '-' + raw[6:]


def serialized(method):
    # 中文注释：本机权限和配对变更串行，旧任务回收完成前不能创建新执行器。
    @wraps(method)
    def call(self, *args, **kwargs):
        with self.controls:
            return method(self, *args, **kwargs)
    return call


class CloudService:
    def __init__(self, home, instance_id, browser, request_browser, *, notify=lambda value: None):
        self.home = Path(home)
        self.instance_id = instance_id
        self.browser = browser
        self.request_browser = request_browser
        self.notify = notify
        self.published = None
        self.base = self.home / 'plugin-data/browser-link-cloud'
        self.directory = self.base / 'instances' / instance_id
        private_directory(self.directory)
        self.lock_fd = os.open(self.directory / 'native.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.path = self.directory / 'pairing.json'
        self.migration_path = self.directory / 'legacy-pairing.json'
        # 中文注释：实例迁移/撤权标记永久阻止旧配置再次导入，其他实例和原身份账本不受影响。
        old = self.base / 'pairing.json'
        if not self.path.exists() and not self.migration_path.exists() and old.exists():
            previous = load_config(old)
            if previous.get('instance_id') == instance_id:
                save_config(self.path, previous)
                # 中文注释：保留原配对的本地身份和去重记录，旧会话不会因界面升级换 owner。
                profile = self.base / 'profile'
                if profile.is_dir() and not (self.directory / 'profile').exists():
                    if any(path.is_symlink() for path in profile.rglob('*')):
                        raise ValueError('cloud_profile_invalid')
                    shutil.copytree(profile, self.directory / 'profile')
                journal = self.base / 'requests.sqlite'
                if journal.is_file() and not (self.directory / 'requests.sqlite').exists():
                    shutil.copyfile(journal, self.directory / 'requests.sqlite')
                    os.chmod(self.directory / 'requests.sqlite', 0o600)
                save_config(self.migration_path, {'imported': True})
        migration = load_config(self.migration_path) if self.migration_path.exists() else {}
        self.config = load_config(self.path) if self.path.exists() and migration.get('revoked') is not True else None
        # 中文注释：已确认配对就是任务页授权；升级只迁移模式，不更换身份或扩大个人页范围。
        if self.config and self.config.get('paired') is True and self.config.get('full_access') is not True:
            self.config['full_access'] = True
            save_config(self.path, self.config)
        self.status = 'connecting' if self.config else 'unpaired'
        self.online = False
        self.broker_connected = False
        self.error = None
        self.closed = threading.Event()
        self.generation = 0
        self.guard = threading.RLock()
        self.executor = None
        self.scheduler = None
        self.transitioning = False
        self.controls = threading.RLock()
        self.last_reap = 0.0
        self.last_heartbeat = 0.0
        # 中文注释：只有工作线程读写该连接，主线程在工作线程结束后关闭它。
        self.journal = Journal(self.directory / 'requests.sqlite', check_same_thread=False)
        self.worker = threading.Thread(target=self._loop, name='browser-cloud-relay', daemon=True)
        self.worker.start()

    def view(self):
        with self.guard:
            config = self.config or {}
            expiry = config.get('code_expires_at', 0)
            code = config.get('connection_code') if self.status == 'pending_pairing' and expiry > time.time() else None
            return {'state': self.status, 'online': self.online and self.broker_connected,
                    'browser': self.browser, 'instanceId': self.instance_id, 'authorizationGeneration': self.generation,
                    'site': config.get('site'), 'paired': config.get('paired') is True,
                    'fullAccess': config.get('paired') is True and self.status == 'active',
                    'allowedOrigins': config.get('allowed_origins', []), 'code': code,
                    'expiresAt': expiry * 1000, 'error': self.error}

    @serialized
    def start_pairing(self, replace=False):
        with self.guard:
            if self.config and self.status in ('active', 'connecting', 'offline') and not replace:
                return self.view()
            if self.config and self.status == 'pending_pairing' and self.config.get('code_expires_at', 0) > time.time():
                return self.view()
        if replace and self.config:
            self.disconnect()
        service = load_config(self.base / 'service.json')
        code = connection_code()
        config = {'site': service['site'], 'sites_access_token': service['sites_access_token'],
                  'instance_id': self.instance_id, 'allowed_origins': [], 'full_access': True,
                  'device_secret': secrets.token_urlsafe(32), 'connection_code': code,
                  'code_expires_at': time.time() + 300}
        reply = Relay(config).call('/device/pair', {'code': code, 'label': self.browser + ' 浏览器',
                 'browser': self.browser.lower(), 'instance_id': self.instance_id, 'allowed_origins': [], 'access_scope': 'task_pages'})
        config['device_id'] = reply['device_id']
        with self.guard:
            self.generation += 1
            self.config = config
            save_config(self.path, config)
            save_config(self.migration_path, {'imported': True})
            self.status = 'pending_pairing'
            self.error = None
        return self.view()

    @serialized
    def disconnect(self):
        with self.guard:
            config = self.config
            # 中文注释：先持久撤权再删配对，即使远端离线或随后崩溃也不会重新导入旧设备。
            save_config(self.migration_path, {'revoked': True})
            self.generation += 1
            scheduler, self.scheduler = self.scheduler, None
            self.executor = None
            self.transitioning = True
            self.config = None
            self.path.unlink(missing_ok=True)
            self.status = 'unpaired'
            self.online = self.broker_connected = False
            self.error = '本机已断开；云端撤销未确认，请在云端检查并撤销设备。' if config else None
        try:
            if scheduler:
                scheduler.stop()
        finally:
            with self.guard:
                self.transitioning = False
        # 中文注释：网络可能离线或阻塞；本机先撤权并回收，远端只有明确回执才能视为已撤销。
        if config:
            try:
                response = Relay(config).call('/device/revoke', {})
            except (OSError, URLError, TimeoutError, ValueError):
                pass
            else:
                if response.get('revoked') is True:
                    with self.guard:
                        self.error = None
        return self.view()

    def _browser_status(self):
        reply = self.request_browser('cloud.browser_status', {})
        self.broker_connected = reply.get('connected') is True and reply.get('instanceId') == self.instance_id
        return self.broker_connected

    def _authorize(self, revision=None):
        with self.guard:
            if ((revision is not None and revision != self.generation) or not self.config
                    or self.config.get('paired') is not True or self.status != 'active'
                    or self.transitioning or self.closed.is_set()):
                raise ValueError('cloud_pairing_required')
            return self.generation

    def _bind(self, task, *, revision=None):
        revision = self._authorize(revision)
        reply = self.request_browser('cloud.bind_task', {'taskId': task['id'], 'generation': task['generation'],
                 'instanceId': self.instance_id, 'mode': 'full'})
        # 中文注释：Native 回执可能晚于本机撤权；旧代次的成功回执不能继续派发动作。
        self._authorize(revision)
        if reply.get('verified') is not True:
            raise ValueError('cloud_policy_not_confirmed')

    @staticmethod
    def _valid_command(command, device_id):
        # 中文注释：在账本消费和整批入队之前验 Store 信封，不能依赖执行线程稍后拒绝。
        if not isinstance(command, dict):
            return False
        if any(not isinstance(command.get(key), str) or not command[key] for key in ('id', 'session_id', 'tool')):
            return False
        expiry = command.get('expires_at')
        return (command.get('device_id') == device_id and command['tool'] in TOOL_SUFFIXES
                and isinstance(command.get('args'), dict)
                and (type(expiry) is int or (isinstance(expiry, float) and math.isfinite(expiry))))

    def _exchange(self, relay, config, connected, limit):
        # 中文注释：每轮合并心跳、回执交付和批量领取，一次 HTTP 不等待浏览器动作。
        results = []
        size = 0
        for command_id, payload in self.journal.pending():
            size += len(payload.encode()) + 256
            if results and size > 480 * 1024:
                break
            results.append({'command_id': command_id, 'result': json.loads(payload)})
            if len(results) >= 8:
                break
        sessions = self.journal.closed_sessions()
        response = relay.call('/device/exchange', {'browser_connected': connected,
            'full_access': config.get('paired') is True and self.status == 'active', 'limit': limit,
            'results': results, 'closed_sessions': sessions})
        # 中文注释：先校验完整成功合同，再确认设备、处理回执；错误与成功字段混合必须拒绝。
        if not isinstance(response, dict) or set(response) - {'device_id', 'status', 'commands', 'receipts', 'closed_sessions'}:
            raise ValueError('cloud_pairing_unconfirmed')
        if response.get('device_id') != config['device_id']:
            raise ValueError('cloud_device_mismatch')
        status = response.get('status', 'active')
        if status not in ('pending_pairing', 'active'):
            raise ValueError('cloud_pairing_unconfirmed')
        for key in ('commands', 'receipts', 'closed_sessions'):
            values = response.get(key, [] if status == 'pending_pairing' else None)
            if not isinstance(values, list) or (status == 'pending_pairing' and values):
                raise ValueError('cloud_pairing_unconfirmed')
            if key == 'closed_sessions':
                valid = all(isinstance(value, str) for value in values)
            elif key == 'commands':
                valid = all(self._valid_command(value, config['device_id']) for value in values)
            else:
                valid = all(isinstance(value, dict) and isinstance(value.get('command_id'), str) for value in values)
            if not valid:
                raise ValueError('cloud_pairing_unconfirmed')
        # 中文注释：真实 Store 的活跃交换没有 status，只在完整无错误合同通过后归一化。
        response = {**response, 'status': status}
        for receipt in response.get('receipts', []):
            if receipt.get('received') is True or receipt.get('code') in ('receipt_expired', 'receipt_conflict', 'command_denied'):
                self.journal.delivered(receipt['command_id'])
        self.journal.mark_synced(response.get('closed_sessions', []))
        return response

    def _publish(self):
        public = self.view()
        if public != self.published:
            self.published = public
            try:
                self.notify(public)
            except (OSError, ValueError):
                self.closed.set()

    def _fence(self, revision, status, error):
        with self.guard:
            if revision != self.generation:
                return
            self.generation += 1
            fenced_revision = self.generation
            self.status, self.error, self.online = status, error, False
            scheduler, self.scheduler = self.scheduler, None
            self.executor = None
            self.transitioning = True
        # 中文注释：先通知扩展撤权，再等在途回收；旧代次和排队请求都不能在重连后重放。
        self._publish()
        try:
            if scheduler:
                scheduler.stop()
        finally:
            with self.guard:
                if self.generation == fenced_revision:
                    self.transitioning = False

    def _loop(self):
        delay = 0.25
        while not self.closed.wait(delay):
            with self.guard:
                config = dict(self.config) if self.config else None
                revision = self.generation
                transitioning = self.transitioning
                scheduler = self.scheduler
            if not config or transitioning:
                delay = 1
                continue
            try:
                relay = Relay(config)
                connected = self._browser_status()
                if not connected:
                    raise RuntimeError('cloud_browser_unavailable')
                # 中文注释：每轮先完成认证交换，不能在离线、未知协议或首次 connecting 时先 pump。
                response = self._exchange(relay, config, connected, min(8, scheduler.available()) if scheduler else 0)
                if response['status'] != 'active':
                    self._fence(revision, response['status'], None)
                    delay = 1
                    continue
                with self.guard:
                    if revision != self.generation or not self.config or self.transitioning or self.closed.is_set():
                        continue
                    self.status, self.online, self.error = 'active', connected, None
                    if self.config.get('paired') is not True:
                        self.config['paired'] = True
                        self.config['full_access'] = True
                        self.config.pop('connection_code', None)
                        self.config.pop('code_expires_at', None)
                        save_config(self.path, self.config)
                    # 中文注释：扩展先收到认证 active，再接受新代次绑定；端口 hello 的 connecting 不授予执行。
                    self._publish()
                    if self.scheduler is None:
                        executor = CloudExecutor(self.home, self.directory, config['device_id'], self.instance_id,
                            bind_task=lambda task, revision=revision: self._bind(task, revision=revision),
                            authorize=lambda revision=revision: self._authorize(revision))
                        try:
                            for session in self.journal.active_sessions():
                                if executor.handoff_session(session):
                                    self.journal.mark_closed(session)
                        except (OSError, RuntimeError, ValueError):
                            executor.close()
                            raise
                        self.executor = executor
                        self.scheduler = Scheduler(self.journal, self.executor)
                    scheduler = self.scheduler
                    # 中文注释：派发与本机撤权共用短锁，已捕获的 scheduler 不能在撤权后继续 pump。
                    if response.get('commands'):
                        scheduler.add(response['commands'])
                    else:
                        scheduler.pump()
                busy = scheduler.busy_sessions()
                delay = 0.25 if response.get('commands') else (0.5 if busy else min(3, delay * 1.5))
                if time.monotonic() - self.last_reap >= 30:
                    for session in self.journal.idle(busy):
                        if scheduler.executor.handoff_session(session, keep_tabs=False):
                            self.journal.mark_closed(session)
                    self.last_reap = time.monotonic()
            except HTTPError as error:
                status = ('expired' if self.status == 'pending_pairing' else 'revoked') if error.code in (401, 403, 410) else 'offline'
                message = '配对已失效，请重新生成连接码。' if status != 'offline' else '云端暂时不可用，请稍后重试。'
                self._fence(revision, status, message)
                delay = 3
            except (OSError, URLError, TimeoutError, ValueError, RuntimeError):
                self._fence(revision, 'offline', '连接暂时中断，正在重新连接。')
                delay = 3
            finally:
                self._publish()

    @serialized
    def close(self):
        self.closed.set()
        with self.guard:
            scheduler, self.scheduler = self.scheduler, None
            self.executor = None
            self.transitioning = True
        if scheduler:
            scheduler.stop()
        # 中文注释：必须等轮询退出后再关闭 SQLite 和实例锁，不能让旧进程继续占资源。
        self.worker.join()
        self.journal.close()
        os.close(self.lock_fd)
