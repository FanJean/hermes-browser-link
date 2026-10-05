#!/usr/bin/env python3
"""将旧安装迁移到 browser-link；默认仅预览，--apply 才写入。"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
from datetime import datetime
import uuid

ROOT = Path(__file__).resolve().parents[1]
# 中文注释：旧标识仅集中在迁移映射中，其他代码从映射读取。
LEGACY = {
    'plugin': 'browser-executor', 'native': 'browser-native',
    'host': 'com.hermes.browser_executor', 'label': 'Hermes 本地浏览器桥',
}
HOST = 'com.hermes.browser_link'
ORIGIN = 'chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/'
BROWSERS = ('Google/Chrome', 'Microsoft Edge')
spec = importlib.util.spec_from_file_location('link_installer', ROOT / 'scripts/install-executor.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def copy_path(source, target):
    """中文注释：保留权限、链接本体和元数据；套接字不能复制到备份或新安装。"""
    if source.is_symlink():
        target.symlink_to(os.readlink(source))
    elif source.is_dir():
        shutil.copytree(source, target, symlinks=True, ignore=lambda directory, names: [
            name for name in names if stat.S_ISSOCK((Path(directory) / name).lstat().st_mode)])
    else:
        shutil.copy2(source, target)


def rewrite_config(raw):
    """中文注释：仅替换 plugins.enabled 列表元素与 plugins.entries 键，保留字节布局。"""
    text = raw.decode('utf-8')
    lines = text.splitlines(keepends=True)
    stack = []
    old = re.escape(LEGACY['plugin'])
    identities = {"enabled": [], "entries": []}
    for index, line in enumerate(lines):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        indent = len(line) - len(line.lstrip(' '))
        while stack and indent <= stack[-1][0]:
            # 中文注释：YAML 允许列表短横线与 enabled 键同级缩进。
            if indent == stack[-1][0] and stack[-1][1] == 'enabled' and line.lstrip().startswith('- '):
                break
            stack.pop()
        parents = [item[1] for item in stack]
        key = re.match(r'''\s*(['"]?)([\w-]+)\1\s*:''', line)
        # 中文注释：流式对象与 YAML 别名不作猜测性重写，要求使用明确的块式插件配置。
        relevant_container = key and (not parents and key[2] == 'plugins' or parents == ['plugins'] and key[2] == 'entries')
        if relevant_container and line[key.end():].split('#', 1)[0].strip() not in ('', '{}'):
            raise ValueError('迁移需要块式 plugins/entries 配置，请先展开流式对象或别名')
        if parents == ['plugins'] and key and key[2] == 'enabled':
            value = line[key.end():].split('#', 1)[0].strip()
            if value and not (value.startswith('[') and value.endswith(']')):
                raise ValueError('plugins.enabled 必须是显式列表，不支持别名或标量')
        if parents == ['plugins', 'entries'] and key:
            identities['entries'].append(key[2])
        if parents == ['plugins', 'entries'] and key and key[2] == LEGACY['plugin']:
            lines[index] = line[:key.start(2)] + 'browser-link' + line[key.end(2):]
        elif parents == ['plugins'] and key and key[2] == 'enabled':
            # 中文注释：流式列表只处理完整元素，注释与其他字符串不参与替换。
            start, end = line.find('['), line.rfind(']')
            if start >= 0 and end > start:
                body = line[start + 1:end]
                identities['enabled'].extend(part.strip().strip("\"'") for part in body.split(','))
                body = re.sub(rf'''(^|,)\s*(['"]?){old}\2\s*(?=,|$)''',
                              lambda m: m[0].replace(LEGACY['plugin'], 'browser-link'), body)
                lines[index] = line[:start + 1] + body + line[end:]
        elif parents == ['plugins', 'enabled']:
            item = re.match(r'''\s*-\s*(['"]?)([\w-]+)\1(?=\s*(?:#|$))''', line)
            if item:
                identities['enabled'].append(item[2])
            lines[index] = re.sub(rf'''^(\s*-\s*)(['"]?){old}\2(?=\s*(?:#|$))''',
                                  lambda m: m[0].replace(LEGACY['plugin'], 'browser-link'), line)
        if key:
            stack.append((indent, key[2]))
    result = ''.join(lines)
    # 中文注释：拒绝同时存在新旧插件项，避免重名键及重复启用。
    if any(LEGACY['plugin'] in values and 'browser-link' in values for values in identities.values()):
        raise ValueError('配置已含新插件项，请先消除新旧配置冲突')
    return result.encode('utf-8')


def stop_daemon(home):
    """中文注释：复用认证套接字、PID 私有权限及命令行身份核对后再发送 SIGTERM。"""
    data = home / 'plugin-data' / LEGACY['native']
    pid = data / 'daemon.pid'
    if not pid.exists():
        if (data / 'bridge.sock').exists():
            raise ValueError('旧套接字存在但缺少 PID，请先退出旧守护进程')
        return
    candidates = [str(home / 'plugins' / LEGACY['plugin'] / 'native_bridge/daemon.py'),
                  str(data / 'host-bin/daemon.py')]
    code = "import {stopOldDaemon} from " + json.dumps((ROOT / 'scripts/dev-sync-daemon.mjs').as_uri()) + "; await stopOldDaemon(...JSON.parse(process.argv[1]));"
    subprocess.run(['node', '--input-type=module', '-e', code,
                    json.dumps([str(pid), str(home), candidates])], check=True, timeout=10)


def remove(path):
    # 中文注释：清理仅用于本次新建目标或恢复前的已备份配置，不跟随链接。
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def profile_plugin_links(home):
    """中文注释：仅识别解析后恰好指向旧安装目录的 profile 插件链接。"""
    old_target = home / 'plugins' / LEGACY['plugin']
    result = []
    for plugins in sorted((home / 'profiles').glob('*/plugins')):
        if not plugins.is_dir() or plugins.is_symlink():
            continue
        for link in plugins.iterdir():
            if link.is_symlink() and (link.parent / os.readlink(link)).resolve() == old_target:
                replacement = plugins / 'browser-link'
                if replacement.exists() or replacement.is_symlink():
                    raise ValueError('profile 已有 browser-link 插件入口: ' + str(replacement))
                result.append((link, replacement))
    return result


def verify(home, browser_root, package, hashes):
    """中文注释：删除旧注册前验证插件、桌面副本、扩展哈希与两浏览器精确来源。"""
    plugin = home / 'plugins/browser-link'
    installer.verify_installed(plugin, hashes)
    extension = home / 'browser-link-releases/current/native-extension'
    for name, digest in hashes.items():
        if name.startswith('native-extension/'):
            if installer.hashlib.sha256((extension / name.split('/', 1)[1]).read_bytes()).hexdigest() != digest:
                raise ValueError('扩展哈希不一致: ' + name)
    desktop = home / 'desktop-plugins/browser-link'
    for source in (plugin / 'desktop').rglob('*'):
        if source.is_file() and (desktop / source.relative_to(plugin / 'desktop')).read_bytes() != source.read_bytes():
            raise ValueError('桌面插件副本不一致')
    for browser in BROWSERS:
        manifest = json.loads((browser_root / browser / 'NativeMessagingHosts' / (HOST + '.json')).read_text())
        launcher = home / 'plugin-data/browser-link-native' / HOST
        if manifest != {'name': HOST, 'description': 'Hermes Browser Link native bridge',
                        'path': str(launcher), 'type': 'stdio', 'allowed_origins': [ORIGIN]}:
            raise ValueError('宿主注册校验失败')
        if not os.access(launcher, os.X_OK):
            raise ValueError('宿主启动器不可执行')
    if json.loads((home / 'plugin-data/browser-link-native/host-config.json').read_text()) != {'allowedOrigins': [ORIGIN]}:
        raise ValueError('宿主来源配置校验失败')


def migrate(package, home, browser_root, *, apply=False):
    package, home, browser_root = [Path(os.path.abspath(Path(p).expanduser())) for p in (package, home, browser_root)]
    installer.reject_package_symlinks(package)
    hashes = installer.verify_package(package)
    extension = json.loads((package / 'native-extension/manifest.json').read_text())
    import base64
    # 中文注释：1.5.3 沿用固定身份，保留已支持的迁移版本并核对扩展身份。
    digest = installer.hashlib.sha256(base64.b64decode(extension['key'], validate=True)).hexdigest()[:32]
    identity = ''.join(chr(97 + int(c, 16)) for c in digest)
    if extension['version'] not in {'1.4.0', '1.4.1', '1.4.2', '1.4.3', '1.4.4', '1.4.5', '1.5.0', '1.5.1', '1.5.2', '1.5.3', '1.6.0', '1.6.1', '1.7.0', '1.7.1'} or ORIGIN != f'chrome-extension://{identity}/':
        raise ValueError('需要身份匹配的 1.4.x 安装包')
    configs = [p for p in [home / 'config.yaml', *sorted((home / 'profiles').glob('*/config.yaml'))] if p.exists()]
    rewrites = {p: rewrite_config(p.read_bytes()) for p in configs}
    profile_links = profile_plugin_links(home)
    old_dirs = [home / 'plugins' / LEGACY['plugin'], home / 'desktop-plugins' / LEGACY['plugin'],
                home / (LEGACY['plugin'] + '-releases'), home / (LEGACY['plugin'] + '-release-management'),
                home / 'plugin-data' / LEGACY['plugin'], home / 'plugin-data' / LEGACY['native'],
                *sorted((home / 'plugin-backups').glob(LEGACY['plugin'] + '-*'))]
    old_hosts = [browser_root / b / 'NativeMessagingHosts' / (LEGACY['host'] + '.json') for b in BROWSERS]
    old = [p for p in old_dirs + old_hosts if p.exists() or p.is_symlink()]
    targets = [home / 'plugins/browser-link', home / 'desktop-plugins/browser-link',
               home / 'browser-link-releases', home / 'plugin-data/browser-link',
               home / 'plugin-data/browser-link-native',
               *[browser_root / b / 'NativeMessagingHosts' / (HOST + '.json') for b in BROWSERS],
               home / 'browser-link-release-management']
    marker = home / 'browser-link-releases/migration-complete.json'
    installer.reject_target_symlinks([home / 'plugin-backups', *configs, *old, *targets])
    if marker.exists() and not old:
        if profile_links:
            if not (home / 'plugins/browser-link/plugin.yaml').is_file():
                raise ValueError('新插件不存在，不能修复 profile 链接')
        else:
            verify(home, browser_root, package, hashes)
        if any(p.read_bytes() != value for p, value in rewrites.items()):
            raise ValueError('迁移完成后配置又出现旧启用项，请人工核对')
        if not profile_links:
            return {'status': 'already_migrated', 'gatewayRestartRequired': False}
        repair = {'status': 'profile_links_pending', 'profileLinks':
                  [{'old': str(source), 'new': str(target)} for source, target in profile_links],
                  'gatewayRestartRequired': True}
        if not apply:
            return repair
        changed = []
        try:
            for source, target in profile_links:
                original = os.readlink(source)
                target.symlink_to(home / 'plugins/browser-link')
                changed.append((source, target, original))
                source.unlink()
        except BaseException:
            for source, target, original in reversed(changed):
                target.unlink(missing_ok=True)
                if not source.is_symlink():
                    source.symlink_to(original)
            raise
        return {**repair, 'status': 'profile_links_repaired'}
    for p in targets:
        if p.exists():
            raise ValueError('新目标已存在，拒绝合并覆盖: ' + str(p))
    plan = {'status': 'dry_run', 'backup': str(home / 'plugin-backups/browser-link-migration-<时间戳>'),
            'old': list(map(str, old)), 'create': list(map(str, targets)),
            'configs': [str(p) for p, value in rewrites.items() if p.read_bytes() != value],
            'profileLinks': [{'old': str(source), 'new': str(target)} for source, target in profile_links],
            'gatewayRestartRequired': True,
            'steps': ['备份旧目录及配置', '认证并停止旧守护进程', '复制数据（跳过套接字）',
                      '安装并校验插件、桌面副本、扩展与宿主', '更新配置及 profile 插件链接', '旧目录移入备份',
                      '重启 Hermes 网关以重新加载各 profile 插件']}
    if not apply:
        return plan
    backup = home / 'plugin-backups' / ('browser-link-migration-' + datetime.now().strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8])
    backup.mkdir(parents=True, mode=0o700)
    snapshots = []
    moved = []
    created_parents = []
    mutated = False
    try:
        # 中文注释：所有旧目录与配置先备份；备份失败时尚未修改安装。
        for index, p in enumerate([*old, *configs, *(source for source, _ in profile_links)]):
            destination = backup / 'snapshot' / str(index)
            destination.parent.mkdir(exist_ok=True, mode=0o700)
            copy_path(p, destination)
            snapshots.append((p, destination))
        (backup / 'restore-map.json').write_text(json.dumps([
            {'target': str(p), 'snapshot': str(s.relative_to(backup))} for p, s in snapshots], indent=2))
        stop_daemon(home)
        # 中文注释：停止后重做数据快照，避免守护进程退出时落盘造成备份与迁移数据不同。
        for p, saved in snapshots:
            if p.parent == home / 'plugin-data':
                remove(saved)
                copy_path(p, saved)
        mutated = True
        for target in targets:
            installer.make_directories(target.parent, created_parents)
        shutil.copytree(package / 'browser-link', targets[0])
        shutil.copytree(targets[0] / 'desktop', targets[1])
        (targets[1] / '.hermes-package.json').write_text(json.dumps({
            'package': 'browser-link', 'source': str(targets[0] / 'desktop'),
            'sourceMtimeMs': (targets[0] / 'desktop/plugin.js').stat().st_mtime * 1000}))
        shutil.copytree(package / 'native-extension', targets[2] / 'current/native-extension')
        for old_name, target in [(LEGACY['plugin'], targets[3]), (LEGACY['native'], targets[4])]:
            source = home / 'plugin-data' / old_name
            if source.exists():
                copy_path(source, target)
            else:
                target.mkdir(mode=0o700)
        management = home / (LEGACY['plugin'] + '-release-management')
        if management.exists():
            copy_path(management, targets[7])
        data = targets[4]
        # 中文注释：旧启动器、进程标识和代码不属于持久用户数据。
        for name in (LEGACY['host'], 'host-bin', 'daemon.pid', 'daemon.lock'):
            remove(data / name)
        launcher = data / HOST
        native = targets[0] / 'native_bridge'
        import sys
        launcher.write_text(f'#!{sys.executable}\n# 中文注释：固定安装目录与 Hermes 数据目录。\nimport os,runpy,sys\nsys.path.insert(0,{str(native)!r})\nos.environ["HERMES_HOME"]={str(home)!r}\nrunpy.run_path({str(native / "host.py")!r},run_name="__main__")\n')
        launcher.chmod(0o700)
        native_manifest = {'name': HOST, 'description': 'Hermes Browser Link native bridge',
                           'path': str(launcher), 'type': 'stdio', 'allowed_origins': [ORIGIN]}
        for p, value in [(data / 'host-config.json', {'allowedOrigins': [ORIGIN]}),
                         *[(p, native_manifest) for p in targets[5:7]]]:
            # 中文注释：覆盖前拒绝迁入数据内部的符号链接，避免越界写入。
            installer.reject_target_symlinks([p])
            p.write_text(json.dumps(value, indent=2) + '\n')
            p.chmod(0o600)
        verify(home, browser_root, package, hashes)
        for p, value in rewrites.items():
            p.write_bytes(value)
            if p.read_bytes() != value:
                raise ValueError('配置写入校验失败: ' + str(p))
        for source, target in profile_links:
            # 中文注释：新链接只指向本次安装的新插件，先建后移除旧链接，失败时用快照回滚。
            target.symlink_to(home / 'plugins/browser-link')
            source.unlink()
        for index, p in enumerate(old):
            # 中文注释：旧进程已停止；归档目录也排除失效套接字，不能把 IPC 节点搬入备份。
            if p.is_dir():
                for directory, _, files in os.walk(p, followlinks=False):
                    for name in files:
                        entry = Path(directory) / name
                        if stat.S_ISSOCK(entry.lstat().st_mode):
                            entry.unlink()
            destination = backup / 'retired' / str(index)
            destination.parent.mkdir(exist_ok=True, mode=0o700)
            p.rename(destination)
            moved.append((p, destination))
        marker.write_text(json.dumps({'version': extension['version'], 'backup': str(backup)}))
        return {**plan, 'status': 'migrated', 'backup': str(backup)}
    except BaseException as error:
        # 中文注释：移走的旧目录先还原，再撤销新目标和配置；保留备份供复查。
        for p, destination in reversed(moved):
            destination.rename(p)
        if mutated:
            for source, target in profile_links:
                target.unlink(missing_ok=True)
                saved = next((saved for original, saved in snapshots if original == source), None)
                if saved is not None and not source.is_symlink():
                    copy_path(saved, source)
            for p in reversed(targets):
                remove(p)
            for p, saved in snapshots:
                if p in configs:
                    shutil.copy2(saved, p)
            for directory in reversed(created_parents):
                directory.rmdir()
        raise RuntimeError(f'迁移失败，文件已回滚；备份 {backup}。旧守护进程如已停止需重启 Hermes：{error}') from error


def main():
    # 中文注释：命令行默认只输出计划；测试通过函数使用临时目录，不调用 --apply。
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--hermes-home', type=Path, default=Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes'))))
    parser.add_argument('--browser-root', type=Path, default=Path.home() / 'Library/Application Support')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(migrate(args.package, args.hermes_home, args.browser_root, apply=args.apply), ensure_ascii=False, indent=2))
    print('退出 Hermes 后迁移。随后打开 chrome://extensions / edge://extensions，开启开发者模式，加载已解压的扩展程序：')
    print(args.hermes_home / 'browser-link-releases/current/native-extension')
    print('移除旧扩展“' + LEGACY['label'] + '”，打开 Hermes Browser Link 并重新授权；重启 Hermes。')


if __name__ == '__main__':
    main()
