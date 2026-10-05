#!/usr/bin/env python3
"""中文注释：通用安装入口；复用包校验和安装器，所有写入受事务保护。"""
from __future__ import annotations

import argparse
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
import signal
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
ROOT = Path(__file__).resolve().parent
if ROOT.name == 'scripts':
    ROOT = ROOT.parent


class InstallError(Exception):
    # 中文注释：错误只给原因和处理方法，不输出外部命令日志里的秘密。
    def __init__(self, reason, fix):
        super().__init__(reason)
        self.fix = fix


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


def registrations(user_home):
    return [user_home / 'Library/Application Support' / browser / 'NativeMessagingHosts' / f'{HOST}.json'
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
    return programs, files


def activate(hermes, home, profiles, action, env):
    for name in profiles:
        result = command([hermes, '--profile', name, 'plugins', action, 'browser-link'],
                         {**env, 'HERMES_HOME': str(home)}, timeout=300)
        if result.returncode:
            raise InstallError(f'插件{action}失败 / Plugin {action} failed (profile: {name}).',
                               f'运行 hermes --profile {name} plugins {action} browser-link 检查原因。')


def stop_daemon(home, env):
    # 中文注释：复用开发同步的身份核对原则；只停止已认证、路径与 home 完全匹配的进程。
    data = home / 'plugin-data/browser-link-native'
    pid_path = data / 'daemon.pid'
    if not pid_path.exists():
        return
    info = pid_path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise InstallError('桥接 PID 文件不安全 / Unsafe bridge PID file.', '退出浏览器和 Hermes，核对后重试。')
    raw = pid_path.read_text().strip()
    if not re.fullmatch(r'[1-9]\d*', raw):
        raise InstallError('桥接 PID 无效 / Invalid bridge PID.', '退出浏览器和 Hermes，核对后重试。')
    process = command(['ps', '-p', raw, '-o', 'command='], env)
    if process.returncode == 1 and not process.stdout.strip():
        # 中文注释：已退出进程的旧记录不发送信号，保留到下一次桥接启动处理。
        return
    candidates = [home / 'plugins/browser-link/native_bridge/daemon.py', data / 'host-bin/daemon.py']
    if process.returncode or not any(process.stdout.strip().endswith(f' {path} --home {home}') for path in candidates):
        raise InstallError('无法确认桥接进程身份 / Cannot verify bridge process.',
                           '退出浏览器和 Hermes，手动核对桥接进程后重试；未发送信号。')
    doctor = load_module('install_stop_doctor', home / 'plugins/browser-link/native_bridge/doctor.py')
    if doctor.probe(home).get('ok') is not True or pid_path.read_text().strip() != raw:
        raise InstallError('无法确认桥接进程身份 / Cannot verify bridge process.',
                           '退出浏览器和 Hermes，手动核对桥接进程后重试；未发送信号。')
    os.kill(int(raw), signal.SIGTERM)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not pid_path.exists() or pid_path.read_text().strip() != raw:
            return
        time.sleep(.1)
    raise InstallError('桥接尚未退出 / Bridge did not stop.', '退出浏览器和 Hermes 后重试。')


def snapshot(paths, backup):
    backup.mkdir(parents=True, mode=0o700)
    saved = []
    for index, path in enumerate(paths):
        dest = backup / str(index)
        exists = path.exists()
        if exists:
            if path.is_dir():
                shutil.copytree(path, dest)
            else:
                shutil.copy2(path, dest)
        saved.append((path, dest if exists else None))
    # 中文注释：备份索引仅在用户私有目录保存，用于人工恢复。
    (backup / 'paths.json').write_text(json.dumps([{'path': str(path), 'backup': str(dest) if dest else None}
                                                 for path, dest in saved], indent=2))
    return saved


def rollback(saved):
    # 中文注释：恢复程序、注册和被 CLI 改动的配置，任务数据从未搬移或恢复授权。
    for path, dest in reversed(saved):
        remove(path)
        if dest is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            if dest.is_dir():
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
    if seconds:
        wait_for_extension(home, user_home, seconds)
    # 中文注释：智能审批是默认模式，首次使用不需要点击开关切到全部访问。
    print('保留默认智能审批 / Keep the default smart-approval mode；重启 Hermes / Restart Hermes Desktop。')
    running = shutil.which('pgrep', path=env.get('PATH'))
    if running and command([running, '-if', r'hermes[^/]*\.app/Contents/'], env).returncode == 0:
        print('检测到 Hermes 桌面端运行中，请退出后重新打开 / Hermes Desktop is running; quit and reopen it.')


def apply_package(package, home, user_home, profiles, programs, files, manifest, env, hermes, upgrade, verbose):
    data = home / 'plugin-data/browser-link-native'
    extension = home / 'browser-link-releases/native-extension'
    configs = [profile_home(home, name) / 'config.yaml' for name in profiles]
    EXECUTOR.reject_target_symlinks(configs)
    old_config = (data / 'host-config.json').read_bytes() if upgrade and (data / 'host-config.json').exists() else None
    if upgrade:
        stop_daemon(home, env)
    # 中文注释：首次安装事务备份放临时目录；升级备份永久放 plugins 之外。
    with tempfile.TemporaryDirectory(prefix='browser-link-transaction-') as scratch:
        backup = (home / 'plugin-backups' / f'browser-link-{installed_version(home / "plugins/browser-link")}-{datetime.now():%Y%m%d-%H%M%S-%f}'
                  if upgrade else Path(scratch).resolve() / 'backup')
        EXECUTOR.reject_target_symlinks([backup])
        saved = snapshot([*programs, *files, *configs], backup)
        try:
            for path in [*programs, *files]:
                remove(path)
            EXECUTOR.install(package, user_home, home, [ORIGIN], apply=True)
            extension.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(package / 'native-extension', extension)
            verify_extension_tree(extension, manifest)
            if old_config is not None:
                (data / 'host-config.json').write_bytes(old_config)
            for name in profiles:
                if name != 'default':
                    target = profile_home(home, name) / 'plugins/browser-link'
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copytree(package / 'browser-link', target)
                    EXECUTOR.verify_installed(target, manifest)
            activate(hermes, home, profiles, 'enable', env)
            (data / 'install-state.json').write_text(json.dumps({'profiles': profiles, 'version': installed_version(home / 'plugins/browser-link')}))
            (data / 'install-state.json').chmod(0o600)
            # 中文注释：CLI 激活也可能更新程序，事务结束前再次验证所有安装副本。
            for name in dict.fromkeys(['default', *profiles]):
                EXECUTOR.verify_installed(profile_home(home, name) / 'plugins/browser-link', manifest)
            verify_extension_tree(extension, manifest)
        except BaseException:
            rollback(saved)
            if upgrade:
                print('已回滚程序和配置 / Program and configuration rolled back. 备份 / Backup: ' + str(backup), file=sys.stderr)
            raise
        if upgrade and verbose:
            print('备份 / Backup: ' + str(backup))


def print_plan(home, profiles, upgrade, verbose):
    # 中文注释：默认只显示操作；内部目录只在详细输出时列出。
    print('升级 / Upgrade' if upgrade else '安装 / Install')
    if verbose:
        print('Hermes: ' + str(home) + '; profiles: ' + ', '.join(profiles))
        print('插件 / Plugin: ' + str(home / 'plugins/browser-link'))
        print('扩展 / Extension: ' + str(home / 'browser-link-releases/native-extension'))


def run(args):
    # 中文注释：手动升级/卸载与自动更新使用同一锁；后台调用已持锁，预览不写锁文件。
    if args.dry_run or getattr(args, 'background_update', False) or not (args.upgrade or args.uninstall):
        return _run(args)
    home = args.hermes_home.expanduser()
    if home.is_symlink():
        raise InstallError('安装根目录不能是链接。', '使用实际目录路径后重试。')
    home = home.resolve()
    if home.parent.name == 'profiles':
        home = home.parent.parent
    data = home / 'plugin-data/browser-link-native'
    EXECUTOR.reject_target_symlinks([data])
    if not data.is_dir():
        return _run(args)
    with install_lock(data):
        return _run(args)


@contextmanager
def install_lock(data):
    # 中文注释：锁定稳定私有目录，不创建锁文件，拒绝升级和取消卸载时保持零文件变更。
    descriptor = os.open(data, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise InstallError('已有安装或更新操作运行中。', '等待该操作结束后重试。') from error
        yield
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
    # 中文注释：Hermes --version 会写更新缓存；dry-run 只核对命令路径，正式执行才检查版本。
    if not args.dry_run:
        version = version_of(hermes, env)
        if version is not None and version < TESTED_HERMES:
            print('提示 / Note: 已测试 Hermes 0.21.4；当前版本较早，继续安装 / Tested with Hermes 0.21.4; continuing on an older version.')
    browsers = browsers_at(user_home)
    if not args.uninstall and not browsers:
        raise InstallError('未找到 Chrome / Edge / Browser missing.', '安装 Google Chrome 或 Microsoft Edge 后重试。')
    data = home / 'plugin-data/browser-link-native'
    EXECUTOR.reject_target_symlinks([data / 'install-state.json'])
    profiles = profile_names(args, data)
    # 中文注释：升级/卸载包含之前启用的 profile，避免遗留旧程序；新增 profile 也能一起更新。
    if (args.upgrade or args.uninstall) and (data / 'install-state.json').is_file():
        previous = profile_names(argparse.Namespace(profile=None, upgrade=True, uninstall=False), data)
        profiles = list(dict.fromkeys([*previous, *profiles]))
    for name in profiles:
        if name != 'default' and not profile_home(home, name).is_dir():
            raise InstallError(f'profile 不存在 / Missing profile: {name}.', '先用 hermes profile create 创建该 profile。')
    programs, files = managed_paths(home, user_home, profiles)
    EXECUTOR.reject_target_symlinks([*programs, *files, data])
    for path in programs:
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
            deletions = [*programs, *registrations(user_home), data]
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
        if installed:
            activate(hermes, home, profiles, 'disable', env)
            stop_daemon(home, env)
        # 中文注释：插件和桥接停用成功后清理调度；停用失败不删除既有自动更新设置。
        updater_path = home / 'plugins/browser-link/maintenance/update.py'
        if updater_path.is_file():
            updater = load_module('browser_link_uninstall_updater', updater_path)
            updater.configure_schedule('off', home, user_home, argparse.Namespace(EXECUTOR=EXECUTOR))
        for path in deletions:
            remove(path)
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
        apply_package(staged, home, user_home, profiles, programs, files, manifest, env, hermes, args.upgrade, args.verbose)
    print('✅ 程序安装并启用完成 / Program installed and enabled.')
    # 中文注释：后台更新不打开浏览器、不写剪贴板，也不等待扩展；用户下次启动后重载。
    if not getattr(args, 'background_update', False):
        next_steps(home, user_home, browsers, env, args.wait_seconds, args.upgrade, args.verbose)


def main():
    parser = argparse.ArgumentParser(description='Browser Link 安装 / install, --upgrade, --uninstall')
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--upgrade', action='store_true')
    action.add_argument('--uninstall', action='store_true')
    action.add_argument('--update', action='store_true', help='从 GitHub 正式 Release 更新')
    action.add_argument('--check-update', action='store_true', help='检查正式 Release 新版本')
    action.add_argument('--auto-update', choices=('off', 'check', 'install'), help='关闭、每小时检查或空闲安装')
    parser.add_argument('--purge', action='store_true')
    parser.add_argument('--yes', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--verbose', action='store_true', help='显示安装目录 / show installation directories')
    parser.add_argument('--profile', action='append')
    parser.add_argument('--user-home', type=Path, default=Path.home())
    parser.add_argument('--hermes-home', type=Path, default=Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes'))))
    parser.add_argument('--wait-seconds', type=int, default=180, help='连接等待秒数；0 跳过 / connection wait, 0 skips')
    args = parser.parse_args()
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
