#!/usr/bin/env python3
"""显式启用的云端连接客户端；凭据留在本机，不改变原有本地启动链路。"""
from __future__ import annotations

import argparse
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import sqlite3
import stat
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, ProxyHandler, Request

from .capabilities import NATIVE_BRIDGE, PLUGIN, native_tools
from .executor import CloudExecutor, CloudDenied

MAX_BODY = 512 * 1024


class NoRedirect(HTTPRedirectHandler):
    # 中文注释：重定向可能把设备或 Sites 凭据发到其他站点，直接拒绝。
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def origin(value):
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise ValueError('只接受没有路径和账号密码的 HTTPS 来源')
    parsed.port
    return f'https://{parsed.netloc.lower()}'


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError('云端数据目录必须是当前用户的真实目录')
    os.chmod(path, 0o700)


def save_config(path, value):
    # 中文注释：原子替换且拒绝软链接，避免设备凭据写入仓库或其他用户文件。
    temporary = path.with_name(path.name + '.' + secrets.token_hex(8))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_config(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as handle:
        info = os.fstat(handle.fileno())
        if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('配对配置必须属于当前用户且权限为 0600')
        return json.load(handle)


class Relay:
    def __init__(self, config):
        self.config = config
        self.site = origin(config['site'])
        self.opener = build_opener(NoRedirect(), ProxyHandler({}))

    def call(self, path, body):
        encoded = json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode()
        if len(encoded) > MAX_BODY:
            raise ValueError('cloud_payload_too_large')
        # 中文注释：Sites 服务凭据只穿过平台门禁，设备密钥仍须通过应用层配对校验。
        headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.config['device_secret'],
                   'OAI-Sites-Authorization': 'Bearer ' + self.config['sites_access_token']}
        request = Request(self.site + path, data=encoded, headers=headers, method='POST')
        with self.opener.open(request, timeout=15) as response:
            data = response.read(MAX_BODY + 1)
        if len(data) > MAX_BODY:
            raise ValueError('cloud_payload_too_large')
        return json.loads(data)


class Journal:
    def __init__(self, path, *, check_same_thread=True):
        # 中文注释：并发线程只在短事务内持锁，执行浏览器动作时不持有 SQLite 锁。
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(fd)
        os.close(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('cloud_journal_denied')
        self.guard = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=check_same_thread)
        self.db.execute('CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT, delivered INTEGER NOT NULL DEFAULT 0)')
        self.db.execute("UPDATE commands SET result=? WHERE result IS NULL", (json.dumps({'code': 'outcome_unknown', 'outcome_unknown': True}),))
        # 中文注释：会话表仅保存本机任务路由和回收状态，不上传本地执行日志。
        self.db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task_id TEXT, last_used REAL NOT NULL, closed INTEGER NOT NULL DEFAULT 0, synced INTEGER NOT NULL DEFAULT 0)")
        self.db.commit()

    def reserve(self, command):
        digest = hashlib.sha256(json.dumps(command, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        with self.guard:
            row = self.db.execute('SELECT digest FROM commands WHERE id=?', (command['id'],)).fetchone()
            if row:
                if row[0] != digest:
                    raise ValueError('cloud_request_conflict')
                return False
            self.db.execute('INSERT INTO commands(id,digest) VALUES (?,?)', (command['id'], digest))
            self.db.execute('INSERT INTO sessions(id,last_used) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET last_used=excluded.last_used',
                            (command['session_id'], time.time()))
            self.db.commit()
            return True

    def execute(self, command, executor, *, reserved=False):
        if not reserved and not self.reserve(command):
            with self.guard:
                row = self.db.execute('SELECT result FROM commands WHERE id=?', (command['id'],)).fetchone()
            return json.loads(row[0]) if row[0] else {'code': 'outcome_unknown', 'outcome_unknown': True}
        try:
            result = executor.execute(command)
        except CloudDenied as exc:
            result = {'code': str(exc), 'outcome_unknown': False}
        except Exception:
            # 中文注释：异常发生在动作登记之后，不能猜测未派发或将异常原文上传。
            result = {'code': 'outcome_unknown', 'outcome_unknown': True}
        encoded = json.dumps(result, ensure_ascii=False)
        if len(encoded.encode()) > MAX_BODY - 4096:
            result = {'code': 'cloud_result_too_large', 'outcome_unknown': True}
            encoded = json.dumps(result)
        with self.guard:
            self.db.execute('UPDATE commands SET result=? WHERE id=?', (encoded, command['id']))
            task_id = result.get('id') if isinstance(result, dict) else None
            terminal = isinstance(result, dict) and result.get('state') == 'closed'
            self.db.execute('UPDATE sessions SET task_id=COALESCE(?,task_id),last_used=?,closed=MAX(closed,?) WHERE id=?',
                            (task_id if isinstance(task_id, str) else None, time.time(), int(terminal), command['session_id']))
            self.db.commit()
        return result

    def abandon(self, command_id):
        with self.guard:
            self.db.execute('UPDATE commands SET result=? WHERE id=? AND result IS NULL',
                            (json.dumps({'code': 'cloud_disabled', 'outcome_unknown': False}), command_id))
            self.db.commit()

    def pending(self):
        with self.guard:
            return self.db.execute('SELECT id,result FROM commands WHERE delivered=0 AND result IS NOT NULL').fetchall()

    def delivered(self, request_id):
        with self.guard:
            # 中文注释：确认云端收到后删除页面结果，只留去重摘要。
            self.db.execute('UPDATE commands SET delivered=1,result=? WHERE id=?',
                            (json.dumps({'code': 'cloud_receipt_delivered', 'outcome_unknown': False}), request_id))
            self.db.commit()

    def idle(self, busy, seconds=3600):
        with self.guard:
            rows = self.db.execute('SELECT id FROM sessions WHERE closed=0 AND last_used<?', (time.time()-seconds,)).fetchall()
        return [row[0] for row in rows if row[0] not in busy]

    def closed_sessions(self):
        with self.guard:
            return [row[0] for row in self.db.execute('SELECT id FROM sessions WHERE closed=1 AND synced=0 LIMIT 32')]

    def active_sessions(self):
        with self.guard:
            return [row[0] for row in self.db.execute('SELECT id FROM sessions WHERE closed=0')]

    def mark_closed(self, session):
        with self.guard:
            self.db.execute('UPDATE sessions SET closed=1 WHERE id=?', (session,))
            self.db.commit()

    def mark_synced(self, sessions):
        with self.guard:
            self.db.executemany('UPDATE sessions SET synced=1 WHERE id=? AND closed=1', [(s,) for s in sessions])
            self.db.commit()

    def close(self):
        with self.guard:
            self.db.close()


def main():
    parser = argparse.ArgumentParser(description='独立云端浏览器连接；默认不运行、不安装后台服务。')
    parser.add_argument('--home', type=Path, default=Path.home() / '.hermes')
    parser.add_argument('--data-dir', type=Path)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('browsers')
    configure = sub.add_parser('configure')
    configure.add_argument('--site', required=True)
    args = parser.parse_args()
    if args.command == 'browsers':
        # 中文注释：仅列出现有桥的在线实例，不启动浏览器，不发起云端连接。
        bridge = native_tools._runtime.load_module(NATIVE_BRIDGE / 'client.py', 'cloud_list_bridge_')
        local = bridge.BridgeClient(args.home, autostart=False)
        try:
            rows = local.call('browser.list', {})
            print(json.dumps([{'instance_id': row['instanceId'], 'browser': row['browser'], 'connected': row['connected']}
                              for row in rows], ensure_ascii=False, indent=2))
        finally:
            local.close()
        return
    directory = args.data_dir or args.home / 'plugin-data/browser-link-cloud'
    private_directory(directory)
    config_path = directory / 'pairing.json'
    if args.command == 'configure':
        # 中文注释：服务访问配置与设备配对分开，不因保存配置而授予浏览器访问。
        path = directory / 'service.json'
        if path.exists():
            raise ValueError('已有站点配置，拒绝覆盖')
        token = getpass.getpass('Sites 服务访问凭据（隐藏输入）：')
        if not token:
            raise ValueError('缺少 Sites 服务访问凭据')
        save_config(path, {'site': origin(args.site), 'sites_access_token': token})
        print('站点连接配置已保存；浏览器尚未配对。')



if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except (ValueError, OSError, HTTPError, URLError):
        raise SystemExit('云端连接未完成；请核对配对、浏览器连接、服务凭据和网络。') from None
