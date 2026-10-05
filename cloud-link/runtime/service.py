"""浏览器专属云端连接：Native 端只保存本地配对、独立权限和传输去重。"""
from __future__ import annotations

from functools import wraps
import fcntl
import json
import os
from pathlib import Path
import secrets
import shutil
import threading
import time
from urllib.error import HTTPError, URLError

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
        # 中文注释：保留已经配对的浏览器；只迁入匹配本实例的旧配置，不复制设备到其他实例。
        old = self.base / 'pairing.json'
        if not self.path.exists() and old.exists():
            previous = load_config(old)
            if previous.get('instance_id') == instance_id:
                previous['full_access'] = False
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
        self.config = load_config(self.path) if self.path.exists() else None
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
                    'browser': self.browser, 'instanceId': self.instance_id,
                    'site': config.get('site'), 'paired': config.get('paired') is True or self.status == 'active',
                    'fullAccess': config.get('full_access') is True,
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
                  'instance_id': self.instance_id, 'allowed_origins': [], 'full_access': False,
                  'device_secret': secrets.token_urlsafe(32), 'connection_code': code,
                  'code_expires_at': time.time() + 300}
        reply = Relay(config).call('/device/pair', {'code': code, 'label': self.browser + ' 浏览器',
                 'browser': self.browser.lower(), 'instance_id': self.instance_id, 'allowed_origins': [], 'access_scope': 'task_pages'})
        config['device_id'] = reply['device_id']
        with self.guard:
            self.generation += 1
            self.config = config
            save_config(self.path, config)
            self.status = 'pending_pairing'
            self.error = None
        return self.view()

    @serialized
    def set_full_access(self, enabled):
        if type(enabled) is not bool:
            raise ValueError('cloud_policy_invalid')
        with self.guard:
            if not self.config or self.status != 'active':
                raise ValueError('cloud_pairing_required')
            self.generation += 1
            self.config['full_access'] = enabled
            save_config(self.path, self.config)
            scheduler, self.scheduler = self.scheduler, None
            self.executor = None
            self.transitioning = True
        # 中文注释：切换只交还该设备的云端任务，保留页面；不改本地全局授权或本地 owner。
        try:
            if scheduler:
                scheduler.stop()
        finally:
            with self.guard:
                self.transitioning = False
        return self.view()

    @serialized
    def disconnect(self):
        with self.guard:
            config = self.config
        if config:
            try:
                Relay(config).call('/device/revoke', {})
            except HTTPError as error:
                if error.code not in (401, 410):
                    raise
        with self.guard:
            self.generation += 1
            scheduler, self.scheduler = self.scheduler, None
            self.executor = None
            self.transitioning = True
            self.config = None
            self.path.unlink(missing_ok=True)
            self.status = 'unpaired'
            self.online = False
        try:
            if scheduler:
                scheduler.stop()
        finally:
            with self.guard:
                self.transitioning = False
        return self.view()

    def _browser_status(self):
        reply = self.request_browser('cloud.browser_status', {})
        self.broker_connected = reply.get('connected') is True and reply.get('instanceId') == self.instance_id
        return self.broker_connected

    def _bind(self, task, full_access):
        reply = self.request_browser('cloud.bind_task', {'taskId': task['id'], 'generation': task['generation'],
                 'instanceId': self.instance_id, 'mode': 'full' if full_access else 'smart'})
        if reply.get('verified') is not True:
            raise ValueError('cloud_policy_not_confirmed')

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
            'full_access': config.get('full_access') is True, 'limit': limit,
            'results': results, 'closed_sessions': sessions})
        if response.get('device_id') != config['device_id']:
            raise ValueError('cloud_device_mismatch')
        for receipt in response.get('receipts', []):
            if receipt.get('received') is True or receipt.get('code') in ('receipt_expired', 'receipt_conflict', 'command_denied'):
                self.journal.delivered(receipt['command_id'])
        self.journal.mark_synced(response.get('closed_sessions', []))
        return response

    def _loop(self):
        delay = 0.25
        while not self.closed.wait(delay):
            with self.guard:
                config = dict(self.config) if self.config else None
                revision = self.generation
                transitioning = self.transitioning
            if not config or transitioning:
                delay = 1
                continue
            try:
                relay = Relay(config)
                connected = self._browser_status()
                with self.guard:
                    if revision != self.generation or self.transitioning:
                        continue
                    if connected and config.get('paired') is True and self.scheduler is None:
                        executor = CloudExecutor(self.home, self.directory, config['device_id'], self.instance_id,
                            config['allowed_origins'], bind_task=self._bind, full_access=config.get('full_access') is True)
                        # 中文注释：重连后先核实上次会话回收，确认关闭的路由随下一轮交换同步，旧命令不复活。
                        try:
                            for session in self.journal.active_sessions():
                                if executor.handoff_session(session):
                                    self.journal.mark_closed(session)
                        except (OSError,RuntimeError,ValueError):
                            executor.close()
                            raise
                        self.executor = executor
                        self.scheduler = Scheduler(self.journal, self.executor)
                    scheduler = self.scheduler
                if scheduler:
                    scheduler.pump()
                response = self._exchange(relay, config, connected, min(8, scheduler.available()) if scheduler else 0)
                with self.guard:
                    if revision != self.generation or self.transitioning:
                        continue
                    self.status = 'pending_pairing' if response.get('status') == 'pending_pairing' else 'active'
                    self.online, self.error = connected, None
                    if self.status == 'active' and self.config.get('paired') is not True:
                        self.config['paired'] = True
                        self.config.pop('connection_code', None)
                        self.config.pop('code_expires_at', None)
                        save_config(self.path, self.config)
                    if scheduler and response.get('commands'):
                        scheduler.add(response['commands'])
                # 中文注释：活跃时及时调度，空闲时降低网络请求；执行和审批不会阻塞心跳。
                busy = scheduler.busy_sessions() if scheduler else set()
                delay = 0.25 if response.get('commands') else (0.5 if busy else min(3, delay * 1.5))
                if scheduler and time.monotonic() - self.last_reap >= 30:
                    for session in self.journal.idle(busy):
                        # 中文注释：无在途操作的闲置任务关闭自建页；人工等待仍由 daemon 的移交规则保护。
                        if scheduler.executor.handoff_session(session, keep_tabs=False):
                            self.journal.mark_closed(session)
                    self.last_reap = time.monotonic()
            except HTTPError as error:
                with self.guard:
                    if revision != self.generation:
                        continue
                    self.online = False
                    if error.code in (401, 403, 410):
                        self.status = 'expired' if self.status == 'pending_pairing' else 'revoked'
                        self.error = '配对已失效，请重新生成连接码。'
                        scheduler, self.scheduler = self.scheduler, None
                        self.executor = None
                    else:
                        self.status, self.error = 'offline', '云端暂时不可用，请稍后重试。'
                        scheduler = None
                if scheduler:
                    scheduler.stop()
                delay = 3
            except (OSError, URLError, TimeoutError, ValueError, RuntimeError):
                with self.guard:
                    if revision == self.generation:
                        self.online = False
                        self.error = '连接暂时中断，正在重新连接。'
                delay = 3
            finally:
                public = self.view()
                if public != self.published:
                    self.published = public
                    try:
                        self.notify(public)
                    except (OSError, ValueError):
                        self.closed.set()

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
