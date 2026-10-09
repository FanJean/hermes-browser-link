#!/usr/bin/env python3
"""中文注释：通用安装入口；复用包校验和安装器，所有写入受事务保护。"""
from __future__ import annotations

import argparse
import ast
import base64
from contextlib import contextmanager
import fcntl
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time

HOST = 'com.hermes.browser_link'
EXTENSION_ID = 'dhioigkigkkhceflkkkmoljhdaefjohb'
ORIGIN = f'chrome-extension://{EXTENSION_ID}/'
TESTED_HERMES = (0, 21, 4)
MIN_NODE = (22, 12, 0)
CLOUD_FENCE_HOST_SHA256 = '884b6ba448cc7bd09c333533696ffc24dd642b68b630de71edd37709e15ff985'
ROOT = Path(__file__).resolve().parent
if ROOT.name == 'scripts':
    ROOT = ROOT.parent


class InstallError(Exception):
    # 中文注释：错误只给原因和处理方法，不输出外部命令日志里的秘密。
    def __init__(self, reason, fix):
        super().__init__(reason)
        self.fix = fix


class CloudGateError(InstallError):
    pass


def cloud_refusal():
    return CloudGateError('云端仍活动或状态无法确认 / Cloud state is active or unknown.',
                          '退出 Chrome、Edge 和 Hermes 后重试；旧入口须显式 --upgrade --maintenance，不会结束任务。')


def assert_cloud_journal_idle(path):
    # 中文注释：immutable 不能看到 WAL；任何 sidecar 先拒绝，绝不实例化会恢复写入的 Journal。
    if any(os.path.lexists(str(path) + suffix) for suffix in ('-wal', '-shm', '-journal')):
        raise cloud_refusal()
    expected = {
        'commands': [('id', 'TEXT', 0, None, 1), ('digest', 'TEXT', 1, None, 0),
                     ('result', 'TEXT', 0, None, 0), ('delivered', 'INTEGER', 1, '0', 0)],
        'sessions': [('id', 'TEXT', 0, None, 1), ('task_id', 'TEXT', 0, None, 0),
                     ('last_used', 'REAL', 1, None, 0), ('closed', 'INTEGER', 1, '0', 0),
                     ('synced', 'INTEGER', 1, '0', 0)]}
    try:
        database = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)
        try:
            if (database.execute('PRAGMA user_version').fetchone() != (0,)
                    or database.execute('PRAGMA quick_check').fetchall() != [('ok',)]
                    or sorted(database.execute("SELECT type,name,tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall())
                    != [('table', 'commands', 'commands'), ('table', 'sessions', 'sessions')]):
                raise cloud_refusal()
            for table, columns in expected.items():
                if [tuple(row[1:]) for row in database.execute('PRAGMA table_info(' + table + ')')] != columns:
                    raise cloud_refusal()
            command_bad = database.execute("SELECT count(*) FROM commands WHERE typeof(id)!='text' OR length(id)=0 OR typeof(digest)!='text' OR length(digest)=0 OR typeof(result)!='text' OR typeof(delivered)!='integer' OR delivered!=1").fetchone()[0]
            session_bad = database.execute("SELECT count(*) FROM sessions WHERE typeof(id)!='text' OR length(id)=0 OR (task_id IS NOT NULL AND typeof(task_id)!='text') OR typeof(last_used) NOT IN ('real','integer') OR typeof(closed)!='integer' OR closed!=1 OR typeof(synced)!='integer' OR synced!=1").fetchone()[0]
            if command_bad or session_bad:
                raise cloud_refusal()
        finally:
            database.close()
    except sqlite3.Error as error:
        raise cloud_refusal() from error


@contextmanager
def idle_cloud(home):
    descriptors = []
    try:
        try:
            inspect_cloud(home, descriptors)
        except (OSError, ValueError, TypeError) as error:
            raise cloud_refusal() from error
        yield
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def inspect_cloud(home, descriptors):
    base = home / 'plugin-data/browser-link-cloud'
    EXECUTOR.reject_target_symlinks([base])
    if not os.path.lexists(base):
        return
    if not stat.S_ISDIR(base.lstat().st_mode):
        raise cloud_refusal()
    # 中文注释：仅 lstat 私有配对/服务节点；不读取其内容，也不创建缺失的实例锁。
    for path in [base, *base.rglob('*')]:
        info = path.lstat()
        if (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077
                or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))):
            raise cloud_refusal()
        if path.name.endswith(('-wal', '-shm', '-journal')):
            raise cloud_refusal()
        if path.name == 'native.lock':
            if not stat.S_ISREG(info.st_mode):
                raise cloud_refusal()
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            descriptors.append(descriptor)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise cloud_refusal() from error
    instances = base / 'instances'
    if instances.exists():
        if not instances.is_dir():
            raise cloud_refusal()
        for instance in instances.iterdir():
            if (not instance.is_dir() or not re.fullmatch(r'[a-f0-9-]{36}', instance.name)
                    or not (instance / 'requests.sqlite').is_file()):
                raise cloud_refusal()
            assert_cloud_journal_idle(instance / 'requests.sqlite')
    if (base / 'requests.sqlite').exists():
        assert_cloud_journal_idle(base / 'requests.sqlite')


def cloud_fence_metadata(home):
    host = home / 'plugins/browser-link/cloud_link/native_host.py'
    installer = home / 'plugins/browser-link/maintenance/install-cli.py'
    if not host.is_file() or not installer.is_file():
        return None
    source, installer_source = host.read_bytes(), installer.read_bytes()
    # 中文注释：支持声明来自实际已安装且经包校验的安装器，不按版本号或任意 native 标记猜测。
    declarations = [node.value.value for node in ast.parse(installer_source).body
                    if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                    and any(isinstance(target, ast.Name) and target.id == 'CLOUD_FENCE_HOST_SHA256'
                            for target in node.targets)]
    digest = hashlib.sha256(source).hexdigest()
    if declarations != [digest]:
        return None
    return {'version': 1, 'hostSha256': digest, 'installerSha256': hashlib.sha256(installer_source).hexdigest()}


def assert_cloud_fenced(home):
    state = home / 'plugin-data/browser-link-native/install-state.json'
    try:
        EXECUTOR.reject_target_symlinks([state, home / 'plugins/browser-link/cloud_link/native_host.py',
                                        home / 'plugins/browser-link/maintenance/install-cli.py'])
        info = state.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise cloud_refusal()
        metadata = cloud_fence_metadata(home)
        if metadata is None or json.loads(state.read_text()).get('cloudFence') != metadata:
            raise cloud_refusal()
    except (OSError, ValueError, TypeError, SyntaxError) as error:
        raise cloud_refusal() from error


def maintenance_processes_stopped(env, *, include_hosts):
    result = command(['/bin/ps', '-axo', 'command='], env)
    if result.returncode:
        raise cloud_refusal()
    apps = re.compile(r'(?:Google Chrome|Microsoft Edge|[Hh]ermes[^/]*)\.app/Contents/|'
                      r'(?:^|/|\s)hermes(?:\s|$)|hermes_cli/|hermes-agent/(?:cli|hermes)\.py')
    for line in result.stdout.splitlines():
        if apps.search(line) or (include_hosts and ('native_host.py' in line or HOST + '.cloud' in line)):
            raise cloud_refusal()


def validated_cloud_launcher(home, user_home):
    try:
        return check_cloud_launcher(home, user_home)
    except (OSError, ValueError, TypeError) as error:
        raise cloud_refusal() from error


def check_cloud_launcher(home, user_home):
    launcher = home / 'plugin-data/browser-link-cloud' / (HOST + '.cloud')
    manifests = registrations(user_home, HOST + '.cloud')
    EXECUTOR.reject_target_symlinks([launcher, *manifests])
    directory_info = launcher.parent.lstat()
    if (not stat.S_ISDIR(directory_info.st_mode) or directory_info.st_uid != os.getuid()
            or stat.S_IMODE(directory_info.st_mode) & 0o077):
        raise cloud_refusal()
    info = launcher.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077 or not info.st_mode & 0o100):
        raise cloud_refusal()
    source = launcher.read_text()
    python = source.partition('\n')[0].removeprefix('#!')
    if not Path(python).is_absolute() or not os.access(python, os.X_OK):
        raise cloud_refusal()
    root = home / 'plugins/browser-link/cloud_link'
    expected = (f'#!{python}\n# 中文注释：独立云端 Native 入口，不启动本地 daemon。\n'
                'import os,runpy,sys\n'
                f"os.environ['HERMES_HOME']={str(home)!r}\n"
                f'sys.path.insert(0,{str(root)!r})\n'
                f"runpy.run_path({str(root / 'native_host.py')!r},run_name='__main__')\n")
    if source != expected or not (root / 'native_host.py').is_file():
        raise cloud_refusal()
    found = False
    for manifest in manifests:
        if not manifest.exists():
            continue
        info = manifest.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
            raise cloud_refusal()
        value = json.loads(manifest.read_text())
        if (value.get('name') != HOST + '.cloud' or value.get('path') != str(launcher)
                or value.get('type') != 'stdio' or value.get('allowed_origins') != [ORIGIN]):
            raise cloud_refusal()
        found = True
    if not found:
        raise cloud_refusal()
    return launcher


@contextmanager
def paused_cloud_launcher(home, user_home, env):
    launcher = validated_cloud_launcher(home, user_home)
    maintenance_processes_stopped(env, include_hosts=False)
    # 中文注释：显式维护唯一的前置写入；原节点 rename 保存，暂停后才检查已加载的旧宿主。
    descriptor, name = tempfile.mkstemp(prefix='.maintenance-original-', dir=launcher.parent)
    os.close(descriptor)
    original = Path(name)
    paused = False
    success = False
    try:
        os.replace(launcher, original)
        paused = True
        descriptor, name = tempfile.mkstemp(prefix='.maintenance-paused-', dir=launcher.parent)
        stub = Path(name)
        try:
            with os.fdopen(descriptor, 'w') as output:
                output.write('#!/bin/sh\nexit 4\n')
            stub.chmod(0o700)
            os.replace(stub, launcher)
        finally:
            stub.unlink(missing_ok=True)
        maintenance_processes_stopped(env, include_hosts=True)
        yield original
        success = True
    finally:
        if paused and not success:
            try:
                os.replace(original, launcher)
            except OSError as error:
                raise InstallError('启动器恢复失败 / Launcher restoration failed: ' + str(launcher),
                                   '原入口备份仍在 / Original launcher backup: ' + str(original)) from error
        else:
            original.unlink(missing_ok=True)


@contextmanager
def cloud_gate(home, *, installed, user_home=None, env=None, maintenance=False):
    if maintenance:
        with paused_cloud_launcher(home, user_home, env) as original, idle_cloud(home):
            yield original
        return
    if installed:
        assert_cloud_fenced(home)
        if user_home is not None:
            validated_cloud_launcher(home, user_home)
    with idle_cloud(home):
        yield None


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def command(argv, env, *, timeout=30):
    # 中文注释：关闭命令 stdin，安装不代替用户授予可选 tools.override 权限。
    try:
        return subprocess.run(argv, env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        name = Path(argv[0]).name
        # 中文注释：Hermes 首次在新目录运行会先安装依赖，耗时可达数分钟；给出可操作的提示而不是笼统失败。
        hint = ('先单独运行一次 hermes --version 等它准备完成，再重试 / Run hermes --version once and let it finish preparing, then retry.'
                if name == 'hermes' else '检查该命令可运行后重试 / Check the command and retry.')
        raise InstallError(f'{name} 超时 / {name} timed out ({timeout}s).', hint) from error
    except OSError as error:
        raise InstallError('命令未完成 / Command did not complete: ' + Path(argv[0]).name,
                           '检查该命令可运行后重试 / Check the command and retry.') from error


def version_of(executable, env, minimum=None):
    result = command([executable, '--version'], env)
    # 中文注释：只解析首行版本标题，不能把后续 Python 版本或括号里的发布日期当成 Hermes 版本。
    match = re.match(r'^(?:Hermes(?: Agent)?\s+)?v?(\d+)\.(\d+)\.(\d+)\b',
                     result.stdout.partition('\n')[0], re.I)
    # 中文注释：Hermes 版本只用于提示；无法识别时也交给实际启用命令判断。
    if minimum is None:
        return tuple(map(int, match.groups())) if result.returncode == 0 and match else None
    if result.returncode or not match or tuple(map(int, match.groups())) < minimum:
        required = '.'.join(map(str, minimum))
        raise InstallError(f'{Path(executable).name} 版本无效或过低 / Invalid or old version.',
                           f'安装 {Path(executable).name} {required}+ 后重试 / Install {required}+ and retry.')


def browsers_at(user_home):
    # 中文注释：测试 HOME 使用独立 Applications；真实用户也支持个人应用目录。
    return [name for name in ('Google Chrome', 'Microsoft Edge')
            if any((base / f'{name}.app').is_dir()
                   for base in (user_home / 'Applications', Path('/Applications')))]


def profile_names(args, data):
    names = args.profile
    state = data / 'install-state.json'
    if names is None:
        if (args.upgrade or args.uninstall) and state.is_file():
            names = json.loads(state.read_text())['profiles']
        else:
            names = ['default']
    if not isinstance(names, list) or not names:
        raise InstallError('profile 清单无效 / Invalid profile list.', '使用 --profile default 重试。')
    result = []
    for name in names:
        # 中文注释：遵循 Hermes 的小写名称；禁止 profile 路径穿越。
        if not isinstance(name, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', name):
            raise InstallError('profile 名称无效 / Invalid profile name.', '使用小写字母、数字、短横线或下划线。')
        if name not in result:
            result.append(name)
    return result


def profile_home(home, name):
    return home if name == 'default' else home / 'profiles' / name


def remove(path):
    # 中文注释：删除目录不跟随内部链接；目标祖先由安装器提前检查。
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def installed_profiles(home):
    # 中文注释：安装记录不是启用授权；扫描未登记及停用的程序入口。
    root = home / 'profiles'
    EXECUTOR.reject_target_symlinks([root])
    names = []
    if (home / 'plugins/browser-link').exists():
        names.append('default')
    if root.is_dir():
        for profile in sorted(root.iterdir()):
            EXECUTOR.reject_target_symlinks([profile, profile / 'plugins'])
            target = profile / 'plugins/browser-link'
            desktop = profile / 'desktop-plugins/browser-link'
            if target.exists() or target.is_symlink() or desktop.exists() or desktop.is_symlink():
                names.append(profile.name)
    return names


def check_program_path(path, home):
    EXECUTOR.reject_target_symlinks([path.parent])
    if path.is_symlink():
        root = home / 'plugins/browser-link'
        raw_destination = path.parent / os.readlink(path)
        EXECUTOR.reject_target_symlinks([raw_destination])
        destination = Path(os.path.abspath(raw_destination))
        if (path == root or destination != root or root.is_symlink() or not root.is_dir() or not path.is_dir()):
            raise InstallError('插件引用不是直接共享根链接 / Unsafe plugin reference.',
                               '核对引用；只允许直接指向根 plugins/browser-link。')
        return
    EXECUTOR.reject_target_symlinks([path])
    assert_regular_tree(path)
    if path.exists():
        if not path.is_dir() or not re.search(r'^name:\s*browser-link\s*$',
                                            (path / 'plugin.yaml').read_text(), re.M):
            raise InstallError('旧插件身份无效 / Invalid installed plugin.', '核对 plugin.yaml 后重试。')
        installed_version(path)


def probe_references(home, profiles):
    # 中文注释：在目标文件系统的已有目录探测；失败不提权、不回退复制。
    for name in profiles:
        if name == 'default':
            continue
        target = profile_home(home, name) / 'plugins/browser-link'
        parent = target.parent
        while not parent.exists():
            parent = parent.parent
        try:
            with tempfile.TemporaryDirectory(prefix='.browser-link-probe-', dir=parent) as scratch:
                link = Path(scratch) / 'reference'
                link.symlink_to(home / 'plugins/browser-link', target_is_directory=True)
                if os.readlink(link) != str(home / 'plugins/browser-link'):
                    raise OSError('unexpected reference')
                link.unlink()
        except OSError as error:
            raise InstallError('无法创建共享程序引用 / Symlink unavailable.',
                               '检查目录链接能力和权限；不会提权或改为复制。') from error


def assert_regular_tree(path):
    if path.is_dir():
        for directory, dirs, files in os.walk(path, followlinks=False):
            for name in dirs + files:
                entry = Path(directory) / name
                if entry.is_symlink() or not (entry.is_file() or entry.is_dir()):
                    raise InstallError('程序目录含链接或特殊文件 / Unsafe program tree.',
                                       '核对安装目录；不要使用链接目录。')


def installed_version(plugin):
    match = re.search(r'^version:\s*(\d+\.\d+\.\d+)\s*$',
                      (plugin / 'plugin.yaml').read_text(), re.M)
    if not match:
        raise InstallError('旧插件版本无效 / Invalid installed version.', '核对 plugin.yaml 后重试。')
    return match[1]


def verify_extension(path):
    # 中文注释：公钥固定 ID，不接受修改身份后重新计算的清单。
    manifest = json.loads((path / 'manifest.json').read_text())
    digest = hashlib.sha256(base64.b64decode(manifest['key'], validate=True)).hexdigest()[:32]
    identity = ''.join(chr(97 + int(char, 16)) for char in digest)
    if identity != EXTENSION_ID:
        raise InstallError('扩展文件校验失败 / Extension validation failed.', '重新下载完整 Release ZIP 后重试。')


def verify_extension_tree(path, manifest):
    # 中文注释：扩展与插件都核对完整文件集合和目录布局。
    converted = {'browser-link/' + name.removeprefix('native-extension/'): digest
                 for name, digest in manifest.items() if name.startswith('native-extension/')}
    EXECUTOR.verify_installed(path, converted)
    verify_extension(path)


def registrations(user_home, host=HOST):
    return [user_home / 'Library/Application Support' / browser / 'NativeMessagingHosts' / f'{host}.json'
            for browser in ('Google/Chrome', 'Microsoft Edge')]


def managed_paths(home, user_home, profiles):
    data = home / 'plugin-data/browser-link-native'
    # 中文注释：原生宿主共用根目录；每个选中 profile 保留自己的插件启停配置。
    programs = [home / 'plugins/browser-link', home / 'browser-link-releases/native-extension']
    programs += [profile_home(home, name) / 'plugins/browser-link' for name in profiles if name != 'default']
    for name in dict.fromkeys(['default', *profiles]):
        desktop = profile_home(home, name) / 'desktop-plugins/browser-link'
        if desktop.exists():
            marker = desktop / '.hermes-package.json'
            if not marker.is_file() or json.loads(marker.read_text()).get('package') != 'browser-link':
                raise InstallError('桌面插件副本来源不明 / Unknown desktop plugin copy.',
                                   '核对 .hermes-package.json 后重试。')
        programs.append(desktop)
    files = [data / HOST, data / 'host-config.json', data / 'install-state.json', *registrations(user_home)]
    # 中文注释：云端程序注册随升级备份、回滚和卸载；配对与日志目录仍是本地私有数据。
    files += [home / 'plugin-data/browser-link-cloud' / (HOST + '.cloud'), *registrations(user_home, HOST + '.cloud')]
    return programs, files


def activate(hermes, home, profiles, action, env):
    for name in profiles:
        result = command([hermes, '--profile', name, 'plugins', action, 'browser-link'],
                         {**env, 'HERMES_HOME': str(home)}, timeout=300)
        if result.returncode:
            raise InstallError(f'插件{action}失败 / Plugin {action} failed (profile: {name}).',
                               f'运行 hermes --profile {name} plugins {action} browser-link 检查原因。')


def assert_tasks_idle(home):
    data = home / 'plugin-data/browser-link-native'
    tasks, journal = data / 'tasks.json', data / 'requests.jsonl'
    EXECUTOR.reject_target_symlinks([tasks, journal])
    try:
        for path in (tasks, journal):
            if path.exists():
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
                    raise ValueError('unsafe persistence')
        # 中文注释：未合并派发日志无法证明空闲；不加载 daemon 以免恢复/改写任务。
        if journal.exists() and journal.stat().st_size:
            raise ValueError('unmerged request journal')
        value = json.loads(tasks.read_bytes()) if tasks.exists() else {'version': 1, 'tasks': []}
        if not isinstance(value, dict) or value.get('version') != 1 or not isinstance(value.get('tasks'), list):
            raise ValueError('unknown persistence')
        for task in value['tasks']:
            if (not isinstance(task, dict) or not isinstance(task.get('id'), str)
                    or not isinstance(task.get('owner'), str) or task.get('state') not in {'closed', 'cancelled', 'failed'}
                    or task.get('cleanupState') != 'succeeded' or task.get('idlePendingHuman')
                    or task.get('idleRecoveryState') in {'paused', 'pending_approval'}
                    or 'vaultPermit' in task or 'gatewayPermit' in task
                    or not isinstance(task.get('currentOperation', {'state': 'succeeded'}), dict)
                    or task.get('currentOperation', {'state': 'succeeded'}).get('state') not in {'succeeded', 'failed'}):
                raise ValueError('active or unknown task')
            for field, settled in (('requestHistory', {'confirmed', 'rejected'}),
                                   ('operationTimeline', {'succeeded', 'failed'})):
                rows = task.get(field, [] if field == 'operationTimeline' else None)
                if not isinstance(rows, list) or any(not isinstance(row, dict) or row.get('state') not in settled for row in rows):
                    raise ValueError('unsettled operation')
    except (OSError, ValueError, TypeError) as error:
        raise CloudGateError('活动任务或状态无法核实 / Task state is active or unknown.',
                           '先结束任务并退出浏览器和 Hermes，再重试；安装不会停止任务。') from error


def assert_daemon_stopped(home, env):
    try:
        return check_daemon_stopped(home, env)
    except InstallError as error:
        raise CloudGateError(str(error), error.fix) from error


def check_daemon_stopped(home, env):
    # 中文注释：现有协议不能原子确认活 daemon 空闲；任何存活桥接都拒绝，不发信号。
    data = home / 'plugin-data/browser-link-native'
    pid_path = data / 'daemon.pid'
    if not pid_path.exists():
        if (data / 'bridge.sock').exists():
            raise InstallError('无法确认桥接进程身份 / Cannot verify bridge process.',
                               '核对无 PID 的桥接套接字后重试；不会停止未知进程。')
        return
    info = pid_path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise InstallError('桥接 PID 文件不安全 / Unsafe bridge PID file.', '退出浏览器和 Hermes，核对后重试。')
    raw = pid_path.read_text().strip()
    if not re.fullmatch(r'[1-9]\d*', raw):
        raise InstallError('桥接 PID 无效 / Invalid bridge PID.', '退出浏览器和 Hermes，核对后重试。')
    process = command(['ps', '-p', raw, '-o', 'command='], env)
    if process.returncode == 1 and not process.stdout.strip():
        if (data / 'bridge.sock').exists():
            raise InstallError('无法确认桥接进程身份 / Cannot verify bridge process.',
                               '核对过期 PID 的桥接套接字后重试；不会停止未知进程。')
        # 中文注释：已退出进程的旧记录不发送信号，保留到下一次桥接启动处理。
        return
    candidates = [home / 'plugins/browser-link/native_bridge/daemon.py', data / 'host-bin/daemon.py']
    if process.returncode or not any(process.stdout.strip().endswith(f' {path} --home {home}') for path in candidates):
        raise InstallError('无法确认桥接进程身份 / Cannot verify bridge process.',
                           '退出浏览器和 Hermes，手动核对桥接进程后重试；未发送信号。')
    raise InstallError('桥接仍在运行 / Bridge is running.',
                       '退出浏览器和 Hermes，并确认桥接退出后重试；不会自动停止任务。')


def acquire_bridge_lock(descriptor):
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise CloudGateError('无法确认桥接空闲 / Bridge activity cannot be verified.',
                           '退出浏览器和 Hermes，确认桥接已退出后重试。') from error


@contextmanager
def idle_bridge(home, env, *, profiles=()):
    # 中文注释：复用 daemon 自身的启动锁，持锁期间不能新启动；活服务从不自动结束。
    data = home / 'plugin-data/browser-link-native'
    lock = data / 'daemon.lock'
    EXECUTOR.reject_target_symlinks([lock, data / 'daemon.pid', data / 'bridge.sock'])
    assert_daemon_stopped(home, env)
    assert_tasks_idle(home)
    if not data.is_dir():
        probe_references(home, profiles)
        yield None
        return
    descriptor = None
    if lock.exists():
        info = lock.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise InstallError('桥接启动锁不安全 / Unsafe bridge lock.', '核对私有桥接目录后重试。')
        # 中文注释：既有生命周期锁只读打开；被持有时拒绝，不能先探测建链或写打开锁。
        descriptor = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        if descriptor is not None:
            acquire_bridge_lock(descriptor)
            assert_daemon_stopped(home, env)
            assert_tasks_idle(home)
        # 中文注释：空闲门禁在探测前；缺失锁延后创建，建链失败不会遗留 daemon.lock。
        probe_references(home, profiles)
        if descriptor is None:
            descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            acquire_bridge_lock(descriptor)
        assert_daemon_stopped(home, env)
        assert_tasks_idle(home)
        yield descriptor
    finally:
        if descriptor is not None:
            os.close(descriptor)


def snapshot(paths, backup):
    backup.mkdir(parents=True, mode=0o700)
    saved = []
    records = []
    for index, path in enumerate(paths):
        dest = backup / str(index)
        exists = path.exists() or path.is_symlink()
        kind, readlink = 'missing', None
        if exists:
            if path.is_symlink():
                kind, readlink = 'symlink', os.readlink(path)
                dest.symlink_to(readlink, target_is_directory=True)
            elif path.is_dir():
                kind = 'directory'
                shutil.copytree(path, dest)
            else:
                kind = 'file'
                shutil.copy2(path, dest)
        saved.append((path, dest if exists else None))
        records.append({'path': str(path), 'backup': str(dest) if exists else None,
                        'kind': kind, 'readlink': readlink})
    # 中文注释：备份索引仅在用户私有目录保存，用于人工恢复。
    (backup / 'paths.json').write_text(json.dumps(records, indent=2))
    return saved


def rollback(saved):
    # 中文注释：恢复程序、注册和被 CLI 改动的配置，任务数据从未搬移或恢复授权。
    for path, dest in reversed(saved):
        remove(path)
        if dest is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            if dest.is_symlink():
                path.symlink_to(os.readlink(dest), target_is_directory=True)
            elif dest.is_dir():
                shutil.copytree(dest, path)
            else:
                shutil.copy2(dest, path)


def wait_for_extension(home, user_home, seconds):
    doctor = home / 'plugins/browser-link/native_bridge/doctor.py'
    print(f'等待扩展连接 / Waiting for extension ({seconds}s; Ctrl+C 跳过 / skip)…', flush=True)
    deadline = time.monotonic() + seconds
    try:
        while time.monotonic() < deadline:
            # 中文注释：doctor 是只读探测；每次进程有超时，整个等待不超过期限。
            try:
                result = subprocess.run([sys.executable, str(doctor), '--hermes-home', str(home),
                                         '--user-home', str(user_home)], capture_output=True, text=True,
                                        timeout=min(15, max(.01, deadline - time.monotonic())))
                status = json.loads(result.stdout)
                if result.returncode == 0 and status.get('ok') is True:
                    print('✅ 扩展已连接 / Extension connected.')
                    return True
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
            time.sleep(min(2, max(0, deadline - time.monotonic())))
    except KeyboardInterrupt:
        print('已跳过等待 / Wait skipped; 安装已完成 / Installation complete.')
        return False
    print('尚未检测到连接 / No connection detected. 加载扩展后运行 doctor（见安装文档）。')
    return False


def next_steps(home, user_home, browsers, env, seconds, upgrade, verbose):
    extension = home / 'browser-link-releases/native-extension'
    print('扩展目录 / Extension directory: ' + str(extension))
    # 中文注释：复制路径和打开应用只辅助加载，不能替用户操作浏览器安全界面。
    clipboard = shutil.which('pbcopy', path=env.get('PATH'))
    if clipboard:
        result = subprocess.run([clipboard], input=str(extension), text=True, env=env, capture_output=True)
        if result.returncode == 0 and verbose:
            print('路径已复制 / Path copied to clipboard.')
    opener = shutil.which('open', path=env.get('PATH'))
    if opener:
        result = command([opener, '-a', browsers[0]], env)
        if result.returncode:
            print('请手动打开浏览器 / Open the browser manually.')
    if upgrade:
        print('重载扩展 / Reload extension；旧安装若使用其他目录，请重新加载上面的稳定目录。')
    print('打开 chrome://extensions 或 edge://extensions → 开发者模式 / Developer mode → 加载已解压的扩展程序 / Load unpacked → 粘贴路径 / Paste path。')
    connected = wait_for_extension(home, user_home, seconds) if seconds else False
    if not connected:
        # 中文注释：检查必须使用实际共享根和用户目录，不能依赖当前 profile 的 HERMES_HOME。
        check = shlex.join([sys.executable, str(home / 'plugins/browser-link/native_bridge/doctor.py'),
                            '--hermes-home', str(home), '--user-home', str(user_home)])
        print('浏览器连接尚未确认 / Browser connection not yet verified. 检查 / Check: ' + check)
    # 中文注释：安装完成不代表浏览器已授权；连接后普通任务直接执行，不再切换模式。
    print('未连接时在扩展弹窗确认浏览器连接授权（全部访问） / Confirm browser connection authorization (full access) in the popup if disconnected；重启 Hermes / Restart Hermes Desktop。')
    running = shutil.which('pgrep', path=env.get('PATH'))
    if running and command([running, '-if', r'hermes[^/]*\.app/Contents/'], env).returncode == 0:
        print('检测到 Hermes 桌面端运行中，请退出后重新打开 / Hermes Desktop is running; quit and reopen it.')


def install_references(home, profiles, retained):
    for name in profiles:
        if name == 'default':
            continue
        target = profile_home(home, name) / 'plugins/browser-link'
        if target in retained:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(home / 'plugins/browser-link', target_is_directory=True)


def verify_shared_install(home, profiles, manifest):
    root = home / 'plugins/browser-link'
    check_program_path(root, home)
    EXECUTOR.verify_installed(root, manifest)
    for name in profiles:
        if name == 'default':
            continue
        target = profile_home(home, name) / 'plugins/browser-link'
        if not target.is_symlink():
            raise InstallError('共享引用被替换 / Shared reference was replaced.',
                               '核对 Hermes 插件启用操作后重试。')
        check_program_path(target, home)


def apply_package(package, home, user_home, profiles, enable_profiles, programs, files, manifest, env, hermes, upgrade, verbose, original_launcher=None):
    data = home / 'plugin-data/browser-link-native'
    extension = home / 'browser-link-releases/native-extension'
    configs = [profile_home(home, name) / 'config.yaml' for name in profiles]
    EXECUTOR.reject_target_symlinks(configs)
    old_config = (data / 'host-config.json').read_bytes() if upgrade and (data / 'host-config.json').exists() else None
    # 中文注释：首次安装事务备份放临时目录；升级备份永久放 plugins 之外。
    with tempfile.TemporaryDirectory(prefix='browser-link-transaction-') as scratch:
        backup = (home / 'plugin-backups' / f'browser-link-{installed_version(home / "plugins/browser-link")}-{datetime.now():%Y%m%d-%H%M%S-%f}'
                  if upgrade else Path(scratch).resolve() / 'backup')
        EXECUTOR.reject_target_symlinks([backup])
        saved = snapshot([*programs, *files, *configs], backup)
        if original_launcher is not None:
            launcher = home / 'plugin-data/browser-link-cloud' / (HOST + '.cloud')
            destination = next(dest for path, dest in saved if path == launcher)
            # 中文注释：长期备份/事务回滚必须是原入口，不能把暂停 stub 当作旧安装。
            shutil.copy2(original_launcher, destination)
        try:
            retained = [path for path in programs if path.is_symlink()]
            for path in [*programs, *files]:
                if path in retained:
                    continue
                remove(path)
            EXECUTOR.install(package, user_home, home, [ORIGIN], apply=True)
            extension.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(package / 'native-extension', extension)
            verify_extension_tree(extension, manifest)
            if old_config is not None:
                (data / 'host-config.json').write_bytes(old_config)
            install_references(home, profiles, retained)
            activate(hermes, home, enable_profiles, 'enable', env)
            (data / 'install-state.json').write_text(json.dumps({'profiles': profiles, 'version': installed_version(home / 'plugins/browser-link'),
                                                               'cloudFence': cloud_fence_metadata(home)}))
            (data / 'install-state.json').chmod(0o600)
            # 中文注释：CLI 激活也可能更新程序；校验节点类型，不能悄悄生成全副本。
            verify_shared_install(home, profiles, manifest)
            verify_extension_tree(extension, manifest)
        except BaseException:
            rollback(saved)
            if upgrade:
                print('已回滚程序和配置 / Program and configuration rolled back. 备份 / Backup: ' + str(backup), file=sys.stderr)
            raise
        if upgrade and verbose:
            print('备份 / Backup: ' + str(backup))


def uninstall_package(home, user_home, profiles, deletions, hermes, env, installed):
    with cloud_gate(home, installed=installed, user_home=user_home), idle_bridge(home, env):
        if installed:
            activate(hermes, home, profiles, 'disable', env)
        # 中文注释：停用失败不删除既有自动更新设置。
        updater_path = home / 'plugins/browser-link/maintenance/update.py'
        if updater_path.is_file():
            updater = load_module('browser_link_uninstall_updater', updater_path)
            updater.configure_schedule('off', home, user_home, argparse.Namespace(EXECUTOR=EXECUTOR))
        for path in deletions:
            remove(path)


def print_plan(home, profiles, upgrade, verbose):
    # 中文注释：默认只显示操作；内部目录只在详细输出时列出。
    print('升级 / Upgrade' if upgrade else '安装 / Install')
    if verbose:
        print('Hermes: ' + str(home) + '; profiles: ' + ', '.join(profiles))
        print('插件 / Plugin: ' + str(home / 'plugins/browser-link'))
        print('扩展 / Extension: ' + str(home / 'browser-link-releases/native-extension'))


def run(args):
    if getattr(args, 'maintenance', False) and (not args.upgrade or getattr(args, 'background_update', False)):
        raise InstallError('维护迁移只允许显式 --upgrade --maintenance。', '后台更新不会自动迁移旧入口。')
    # 中文注释：手动升级/卸载与自动更新使用同一锁；后台调用已持锁，预览不写锁文件。
    if args.dry_run or not (args.upgrade or args.uninstall):
        return _run(args)
    home = args.hermes_home.expanduser()
    if home.is_symlink():
        raise InstallError('安装根目录不能是链接。', '使用实际目录路径后重试。')
    home = home.resolve()
    if home.parent.name == 'profiles':
        home = home.parent.parent
    data = home / 'plugin-data/browser-link-native'
    EXECUTOR.reject_target_symlinks([data])
    # 中文注释：root fence 持至检查、事务及回滚结束；云目录被 purge 也不会丢失锁锚。
    with root_fence(home):
        if not data.is_dir() or getattr(args, 'background_update', False):
            return _run(args)
        with install_lock(data):
            return _run(args)


@contextmanager
def root_fence(home):
    manager = install_lock(home)
    try:
        descriptor = manager.__enter__()
    except InstallError as error:
        raise cloud_refusal() from error
    try:
        yield descriptor
    finally:
        manager.__exit__(None, None, None)


@contextmanager
def development_sync_guard(home, env):
    # 中文注释：开发同步复用正式升级的全部门禁，锁覆盖打包、首写、校验及回滚。
    data = home / 'plugin-data/browser-link-native'
    EXECUTOR.reject_target_symlinks([data])
    with root_fence(home) as root_lock, install_lock(data) as data_lock, \
            cloud_gate(home, installed=True, user_home=Path(env['HOME'])), idle_bridge(home, env) as bridge_lock:
        yield (root_lock, data_lock, bridge_lock)


@contextmanager
def install_lock(data):
    # 中文注释：锁定稳定私有目录，不创建锁文件，拒绝升级和取消卸载时保持零文件变更。
    descriptor = os.open(data, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise InstallError('已有安装或更新操作运行中。', '等待该操作结束后重试。') from error
        yield descriptor
    finally:
        os.close(descriptor)


def _run(args):
    # 中文注释：解析 macOS 系统临时目录别名，所有计划和写入使用同一绝对根目录；根本身不能是链接。
    roots = [args.user_home.expanduser(), args.hermes_home.expanduser()]
    if any(path.is_symlink() for path in roots):
        raise InstallError('安装根目录不能是链接 / Installation home is a symlink.', '使用实际目录路径后重试。')
    user_home, home = [path.resolve() for path in roots]
    # 中文注释：与 Hermes 显式 --profile 的解析一致，profile-shaped HERMES_HOME 指向共享根目录。
    if home.parent.name == 'profiles':
        home = home.parent.parent
    env = {**os.environ, 'HOME': str(user_home), 'HERMES_HOME': str(home), 'PYTHONDONTWRITEBYTECODE': '1'}
    hermes = shutil.which('hermes', path=env.get('PATH'))
    if not hermes:
        raise InstallError('缺少 hermes 命令 / hermes missing.', '安装 Hermes，确保 hermes 在 PATH 中。')

    browsers = browsers_at(user_home)
    if not args.uninstall and not browsers:
        raise InstallError('未找到 Chrome / Edge / Browser missing.', '安装 Google Chrome 或 Microsoft Edge 后重试。')
    data = home / 'plugin-data/browser-link-native'
    EXECUTOR.reject_target_symlinks([data / 'install-state.json'])
    if args.upgrade:
        EXECUTOR.reject_target_symlinks([home / 'plugin-backups'])
    profiles = profile_names(args, data)
    enable_profiles = profiles if not args.upgrade or args.profile is not None else []
    # 中文注释：升级/卸载包含之前启用的 profile，避免遗留旧程序；新增 profile 也能一起更新。
    if (args.upgrade or args.uninstall) and (data / 'install-state.json').is_file():
        previous = profile_names(argparse.Namespace(profile=None, upgrade=True, uninstall=False), data)
        profiles = list(dict.fromkeys([*previous, *profiles]))
    profiles = list(dict.fromkeys([*profiles, *installed_profiles(home)]))
    profiles = profile_names(argparse.Namespace(profile=profiles), data)
    for name in profiles:
        if name != 'default' and not profile_home(home, name).is_dir():
            raise InstallError(f'profile 不存在 / Missing profile: {name}.', '先用 hermes profile create 创建该 profile。')
    EXECUTOR.reject_target_symlinks([profile_home(home, name) / relative for name in profiles
                                    for relative in ('config.yaml', 'plugin-data/browser-link',
                                                     'plugin-data/browser-link-native')])
    programs, files = managed_paths(home, user_home, profiles)
    references = {profile_home(home, name) / 'plugins/browser-link' for name in profiles if name != 'default'}
    EXECUTOR.reject_target_symlinks([*[path for path in programs if path not in references], *files, data])
    for path in programs:
        if path in references or path == home / 'plugins/browser-link':
            check_program_path(path, home)
        else:
            assert_regular_tree(path)
    for path in files:
        if path.exists() and not path.is_file():
            raise InstallError('配置或注册不是普通文件 / Invalid configuration file.', '核对安装路径后重试。')
    installed = (home / 'plugins/browser-link/plugin.yaml').is_file()
    if args.upgrade and not installed:
        raise InstallError('尚未安装 / Not installed.', '首次安装运行 ./install.sh（不要加 --upgrade）。')
    if not args.upgrade and not args.uninstall and any(path.exists() for path in [*programs, *files]):
        raise InstallError('已有安装 / Already installed.', '升级运行 ./install.sh --upgrade。')
    if args.uninstall:
        deletions = [*programs, *files]
        if args.purge:
            deletions = [*programs, *registrations(user_home), *registrations(user_home,HOST+'.cloud'), data, home/'plugin-data/browser-link-cloud']
        print('将停用 / Disable profiles: ' + ', '.join(profiles))
        print('删除插件、扩展和浏览器连接程序 / Delete plugin, extension and browser connection programs.')
        if args.verbose:
            print('将删除 / Delete:\n' + '\n'.join(str(path) for path in deletions))
        print('删除任务私有数据 / Purge task data.' if args.purge else '保留任务私有数据 / Keep task-private data.')
        if args.dry_run:
            return
        if not args.yes:
            try:
                answer = input('确认删除？/ Confirm deletion? [y/N] ')
            except (EOFError, KeyboardInterrupt):
                answer = ''
            if answer.strip().lower() != 'y':
                print('已取消 / Cancelled.')
                return
        uninstall_package(home, user_home, profiles, deletions, hermes, env, installed)
        print('✅ 已卸载 / Uninstalled. 请在浏览器扩展管理页移除扩展，重启 Hermes。')
        return
    is_source = (ROOT / 'scripts/package-executor.mjs').is_file()
    if is_source:
        node = shutil.which('node', path=env.get('PATH'))
        if not node:
            raise InstallError('源码打包需要 Node.js / Source needs Node.js.',
                               '使用 GitHub Release 打好的 ZIP 包，或安装 Node.js 22.12+。')
        version_of(node, env, MIN_NODE)
    if args.dry_run:
        if not is_source:
            manifest = EXECUTOR.verify_package(ROOT)
            verify_extension(ROOT / 'native-extension')
            if not args.upgrade:
                EXECUTOR._install_verified(ROOT, user_home, home, [ORIGIN], manifest, apply=False)
        print_plan(home, profiles, args.upgrade, args.verbose)
        print('预览完成；运行时去掉 --dry-run / Preview complete; remove --dry-run to install.')
        return
    with tempfile.TemporaryDirectory(prefix='browser-link-package-') as scratch:
        package = ROOT
        if is_source:
            package = Path(scratch).resolve() / 'release'
            result = command([node, str(ROOT / 'scripts/package-executor.mjs'), '--output', str(package)], env, timeout=120)
            if result.returncode:
                raise InstallError('源码打包失败 / Packaging failed.', '检查源码文件和 Node.js；或改用 GitHub Release ZIP。')
        # 中文注释：快照隔离安装期间的源码变化；包摘要校验在修改目标之前完成。
        staged = Path(scratch).resolve() / 'verified'
        shutil.copytree(package, staged, symlinks=True)
        manifest = EXECUTOR.verify_package(staged)
        verify_extension(staged / 'native-extension')
        if args.upgrade:
            existing_extension = home / 'browser-link-releases/native-extension'
            if existing_extension.exists():
                verify_extension(existing_extension)
            # 中文注释：既有白名单可以更严格；不允许借升级扩大或更换扩展来源。
            for path in registrations(user_home):
                if path.exists():
                    origins = json.loads(path.read_text()).get('allowed_origins')
                    if origins != [ORIGIN]:
                        raise InstallError('旧宿主白名单不匹配 / Host allowlist mismatch.', '核对原生宿主注册后重试；升级不会放宽来源。')
        else:
            EXECUTOR.install(staged, user_home, home, [ORIGIN], apply=False)
        if args.verbose:
            print_plan(home, profiles, args.upgrade, True)
        with cloud_gate(home, installed=installed, user_home=user_home, env=env,
                        maintenance=getattr(args, 'maintenance', False)) as original_launcher, idle_bridge(home, env, profiles=profiles):
            # 中文注释：Hermes --version 可能写缓存，必须晚于路径、建链与空闲拒绝。
            version = version_of(hermes, env)
            if version is not None and version < TESTED_HERMES:
                print('提示 / Note: 已测试 Hermes 0.21.4；当前版本较早，继续安装 / Tested with Hermes 0.21.4; continuing on an older version.')
            apply_package(staged, home, user_home, profiles, enable_profiles, programs, files, manifest, env, hermes, args.upgrade, args.verbose, original_launcher)
    if args.upgrade:
        activation = '; enabled: ' + ', '.join(enable_profiles) if enable_profiles else '; profile settings preserved'
        print('✅ 程序升级完成 / Program upgraded. profiles: ' + ', '.join(profiles) + activation)
    else:
        print('✅ 程序安装并启用完成 / Program installed and enabled. profiles: ' + ', '.join(profiles))
    # 中文注释：后台更新不打开浏览器、不写剪贴板，也不等待扩展；用户下次启动后重载。
    if not getattr(args, 'background_update', False):
        next_steps(home, user_home, browsers, env, args.wait_seconds, args.upgrade, args.verbose)


def main():
    parser = argparse.ArgumentParser(
        description='Browser Link 安装 / install, --upgrade, --uninstall',
        epilog='Release ZIP 无需 Node.js / Release ZIP: no Node.js. 源码 / Source: Node.js 22.12+.')
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--upgrade', action='store_true')
    action.add_argument('--uninstall', action='store_true')
    action.add_argument('--update', action='store_true', help='从 GitHub 正式 Release 更新')
    action.add_argument('--check-update', action='store_true', help='检查正式 Release 新版本')
    action.add_argument('--auto-update', choices=('off', 'check', 'install'), help='关闭、每小时检查或空闲安装')
    parser.add_argument('--purge', action='store_true')
    parser.add_argument('--maintenance', action='store_true', help='显式一次性旧云入口迁移；仅 --upgrade，先退出 Chrome/Edge/Hermes')
    parser.add_argument('--yes', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--verbose', action='store_true', help='显示安装目录 / show installation directories')
    parser.add_argument('--profile', action='append',
                        help='首次默认 default；多 profile 重复添加 / first install: default; repeat for multiple profiles')
    parser.add_argument('--user-home', type=Path, default=Path.home())
    parser.add_argument('--hermes-home', type=Path, default=Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes'))))
    parser.add_argument('--wait-seconds', type=int, default=180,
                        help='默认等 180 秒；0 跳过，不卸载 / waits 180s; 0 skips, does not uninstall')
    args = parser.parse_args()
    if args.maintenance and not args.upgrade:
        parser.error('--maintenance requires --upgrade')
    if args.update or args.check_update or args.auto_update:
        # 中文注释：更新入口复用维护模块，源码与发行包不另建下载实现。
        if args.dry_run or args.profile or args.purge or args.yes:
            parser.error('update actions do not accept --dry-run, --profile, --purge or --yes')
        updater_path = ROOT / ('executor-plugin/maintenance/update.py' if (ROOT / 'scripts').is_dir()
                               else 'browser-link/maintenance/update.py')
        updater = load_module('browser_link_cli_updater', updater_path)
        return updater.main_with_args(args)
    if args.purge and not args.uninstall:
        parser.error('--purge requires --uninstall')
    if not 0 <= args.wait_seconds <= 180:
        parser.error('--wait-seconds must be 0..180')
    global EXECUTOR
    try:
        EXECUTOR = load_module('browser_link_installer', ROOT / ('scripts/install-executor.py' if (ROOT / 'scripts/install-executor.py').is_file() else 'install-executor.py'))
        run(args)
    except KeyboardInterrupt:
        print('错误 / Error: 安装已中断 / Installation interrupted.\n处理 / Fix: 检查安装状态后重新运行 / Check installation state and retry.', file=sys.stderr)
        return 1
    except InstallError as error:
        print('错误 / Error: ' + str(error) + '\n处理 / Fix: ' + error.fix, file=sys.stderr)
        return 1
    except ValueError as error:
        # 中文注释：校验错误只显示首行文件/格式原因；不读取文件内容来补充错误。
        reason = str(error).splitlines()[0][:200]
        print('错误 / Error: ' + reason + '\n处理 / Fix: 重新下载完整包，核对安装路径；升级失败已尝试回滚。', file=sys.stderr)
        return 1
    except (OSError, KeyError, TypeError) as error:
        # 中文注释：不打印任意文件内容或外部异常值，避免任务私有数据进入终端。
        print(f'错误 / Error: 安装文件校验或写入失败 / Validation or write failed ({type(error).__name__}).\n处理 / Fix: 重新下载完整包，检查目标目录权限；升级失败已尝试回滚。', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
