#!/usr/bin/env python3
"""中文注释：把用户核实过的已关闭任务标记为清理完成，替代手工修改 tasks.json。

只在 daemon 已停止并持有其启动锁时写入；写入前自动备份原文件。
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CLI = load_module('tasks_ack_installer', ROOT / 'scripts/install-cli.py')
CLI.EXECUTOR = CLI.load_module('tasks_ack_executor', ROOT / 'scripts/install-executor.py')
InstallError = CLI.InstallError


def shared_home(value):
    home = Path(value).expanduser()
    if home.is_symlink():
        raise InstallError('Hermes 目录不能是链接。', '使用实际目录路径后重试。')
    home = home.resolve()
    return home.parent.parent if home.parent.name == 'profiles' else home


def write_private(path, payload):
    # 中文注释：新文件独占创建、不跟随链接，权限 0600。
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def hold_daemon_lock(data):
    # 中文注释：持有 daemon 自身的启动锁，写入期间任何入口都无法启动新 daemon。
    lock = data / 'daemon.lock'
    CLI.EXECUTOR.reject_target_symlinks([lock])
    descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        os.close(descriptor)
        raise InstallError('桥接启动锁不安全 / Unsafe bridge lock.', '核对私有桥接目录后重试。')
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        os.close(descriptor)
        raise InstallError('桥接仍在运行 / Bridge is running.',
                           '加 --stop-daemon 让本命令进入维护模式并停止已核实的 daemon，或等它空闲退出后重试。') from error
    return descriptor


def acknowledge(home, task_id, reason, env, *, stop_daemon=False):
    data = home / 'plugin-data/browser-link-native'
    CLI.EXECUTOR.reject_target_symlinks([data])
    if not data.is_dir():
        raise InstallError('找不到桥接数据目录。', '核对 HERMES_HOME 后重试。')
    with CLI.install_lock(data):
        token = None
        try:
            if stop_daemon:
                token = CLI.enter_maintenance(home, 'tasks:ack', os.getpid())
                CLI.stop_daemon(home, env)
            if CLI.verified_daemon_pid(home, env) is not None:
                raise InstallError('桥接仍在运行 / Bridge is running.',
                                   '加 --stop-daemon 让本命令进入维护模式并停止已核实的 daemon 后重试。')
            descriptor = hold_daemon_lock(data)
            try:
                CLI.check_daemon_stopped(home, env)
                return update_task(data, home, task_id, reason)
            finally:
                os.close(descriptor)
        finally:
            if token:
                CLI.leave_maintenance(home, token)


def update_task(data, home, task_id, reason):
    tasks_path = data / 'tasks.json'
    try:
        value = CLI.load_task_records(home)
    except (OSError, ValueError, TypeError) as error:
        raise InstallError('任务记录无法安全读取 / Task records cannot be read safely.',
                           '确认没有未合并的派发日志且文件权限为 0600 后重试。') from error
    matches = [task for task in value['tasks'] if isinstance(task, dict) and task.get('id') == task_id]
    if len(matches) != 1:
        raise InstallError('找不到该任务 / Task not found: ' + task_id, '用 dev:sync 输出里的任务 id 重试。')
    task = matches[0]
    if task.get('state') not in CLI.TERMINAL_TASK_STATES:
        raise InstallError('任务尚未关闭 / Task is not closed: ' + task_id, '先在 Hermes 中结束任务；本命令只标记已关闭任务。')
    if ('vaultPermit' in task or 'gatewayPermit' in task or task.get('idlePendingHuman')
            or task.get('idleRecoveryState') in {'paused', 'pending_approval'}):
        raise InstallError('任务仍带有授权或待人工处理状态 / Task still holds permits or pending input.',
                           '在 Hermes 中处理完毕后重试；不会清除授权。')
    stamp = datetime.now().astimezone()
    backup = data / ('tasks.json.ack-' + stamp.strftime('%Y%m%dT%H%M%S') + '-'
                     + base64.b32encode(os.urandom(5)).decode('ascii').lower() + '.bak')
    original = tasks_path.read_bytes()
    write_private(backup, original)
    task['userVerified'] = {'reason': reason, 'at': stamp.isoformat(timespec='seconds'),
                            'previousCleanupState': task.get('cleanupState'),
                            'previousCleanupReason': task.get('cleanupReason')}
    task['cleanupState'] = 'succeeded'
    task['cleanupReason'] = 'verified_complete'
    temporary = data / ('.tasks.json.ack-' + base64.b32encode(os.urandom(5)).decode('ascii').lower())
    try:
        write_private(temporary, json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        os.replace(temporary, tasks_path)
    finally:
        temporary.unlink(missing_ok=True)
    return {'status': 'acknowledged', 'taskId': task_id, 'backup': str(backup)}


def main(argv=None):
    parser = argparse.ArgumentParser(description='标记用户已核实的已关闭任务 / Acknowledge a verified closed task')
    parser.add_argument('task_id')
    parser.add_argument('--reason', default='用户已核实浏览器中没有残留标签页或操作')
    parser.add_argument('--stop-daemon', action='store_true',
                        help='进入维护模式并停止已核实的 daemon；完成后删除维护标记')
    parser.add_argument('--hermes-home', default=os.environ.get('HERMES_HOME', str(Path.home() / '.hermes')))
    args = parser.parse_args(argv)
    if not args.reason.strip() or len(args.reason) > 500:
        parser.error('--reason 不能为空且不超过 500 字')
    try:
        result = acknowledge(shared_home(args.hermes_home), args.task_id, args.reason.strip(), os.environ,
                             stop_daemon=args.stop_daemon)
    except InstallError as error:
        print('错误 / Error: ' + str(error) + '\n处理 / Fix: ' + error.fix, file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print('错误 / Error: ' + type(error).__name__ + ': ' + str(error).splitlines()[0][:200], file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
