"""中文注释：从固定 GitHub 正式发布源更新，复用已安装的事务安装器。"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = 'FanJean/hermes-browser-link'
API = f'https://api.github.com/repos/{REPOSITORY}/releases/latest'
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
VERSION = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')
HERE = Path(__file__).resolve().parent


def load_module(name, path):
    # 中文注释：只加载本地已安装代码；下载包先通过当前安装器校验。
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def installer_modules():
    source = HERE.parents[1] / 'scripts'
    directory = source if (source / 'install-cli.py').is_file() else HERE
    cli = load_module('browser_link_update_installer', directory / 'install-cli.py')
    cli.EXECUTOR = load_module('browser_link_update_verifier', directory / 'install-executor.py')
    return cli


def version_tuple(value):
    if not isinstance(value, str) or not VERSION.fullmatch(value):
        raise ValueError('版本号无效')
    return tuple(map(int, value.split('.')))


class GithubRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        # 中文注释：GitHub 附件跳转只接受其 HTTPS 下载域，不访问任意重定向地址。
        url = urllib.parse.urlsplit(newurl)
        if (url.scheme != 'https' or url.hostname not in {'github.com', 'release-assets.githubusercontent.com',
                'objects.githubusercontent.com'} or url.username or url.password or url.port not in (None, 443)):
            raise ValueError('更新下载重定向地址无效')
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def fetch(url, limit):
    request = urllib.request.Request(url, headers={'User-Agent': 'hermes-browser-link-updater',
        'Accept': 'application/vnd.github+json' if url == API else 'application/octet-stream'})
    # 中文注释：无依赖网络请求有超时和体积限制，错误不改写安装文件。
    with urllib.request.build_opener(GithubRedirect()).open(request, timeout=30) as response:
        payload = response.read(limit + 1)
    if len(payload) > limit:
        raise ValueError('更新下载文件过大')
    return payload


def latest_release():
    try:
        release = json.loads(fetch(API, 1024 * 1024))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    if (not isinstance(release, dict) or release.get('draft') is not False
            or release.get('prerelease') is not False):
        raise ValueError('更新源未返回正式发布')
    tag = release.get('tag_name')
    if not isinstance(tag, str) or not tag.startswith('v'):
        raise ValueError('发布标签无效')
    version = tag[1:]
    version_tuple(version)
    name = f'hermes-browser-link-{version}.zip'
    assets = release.get('assets')
    if not isinstance(assets, list):
        raise ValueError('发布附件清单无效')
    matches = [asset for asset in assets if isinstance(asset, dict) and asset.get('name') == name]
    if len(matches) != 1:
        raise ValueError('正式发布缺少唯一的安装 ZIP')
    asset = matches[0]
    url = f'https://github.com/{REPOSITORY}/releases/download/{tag}/{name}'
    if (asset.get('browser_download_url') != url or asset.get('state') != 'uploaded'
            or type(asset.get('size')) is not int or not 0 < asset['size'] <= MAX_ARCHIVE
            or not isinstance(asset.get('digest'), str)
            or not re.fullmatch(r'sha256:[0-9a-f]{64}', asset['digest'])):
        raise ValueError('发布附件地址、大小或 SHA256 摘要无效')
    return {'version': version, 'url': url, 'digest': asset['digest'][7:], 'size': asset['size']}


def extract_archive(payload, release, destination, verifier):
    # 中文注释：先验证 GitHub 附件摘要，再解压；禁止路径穿越、链接、重复名称和解压炸弹。
    if len(payload) != release['size'] or hashlib.sha256(payload).hexdigest() != release['digest']:
        raise ValueError('更新 ZIP 大小或 SHA256 校验失败')
    archive = destination / 'release.zip'
    archive.write_bytes(payload)
    root = f'hermes-browser-link-{release["version"]}'
    with zipfile.ZipFile(archive) as zipped:
        entries = zipped.infolist()
        if len(entries) > 10000 or sum(entry.file_size for entry in entries) > MAX_EXPANDED:
            raise ValueError('更新 ZIP 解压规模过大')
        names = [entry.filename.rstrip('/') for entry in entries]
        if len(names) != len(set(names)):
            raise ValueError('更新 ZIP 包含重复文件')
        verifier.reject_normalized_collisions(names)
        for entry, name in zip(entries, names):
            parts = name.split('/')
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if (not name or parts[0] != root or '\\' in name
                    or any(part in ('', '.', '..') for part in parts)
                    or kind not in (0, stat.S_IFDIR, stat.S_IFREG)
                    or entry.flag_bits & 1):
                raise ValueError('更新 ZIP 包含不安全文件')
        zipped.extractall(destination)
    return destination / root


def applications_running():
    # 中文注释：不退出用户应用；无法读取进程表也不能认定空闲。
    result = subprocess.run(['/bin/ps', '-axo', 'command='], capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise ValueError('无法确认浏览器和 Hermes 是否退出')
    pattern = re.compile(r'(?:Google Chrome|Microsoft Edge|[Hh]ermes[^/]*)\.app/Contents/|'
                         r'(?:^|/|\s)hermes(?:\s|$)|hermes_cli/|hermes-agent/(?:cli|hermes)\.py')
    return any(pattern.search(line) for line in result.stdout.splitlines())


def agent_path(home, user_home):
    # 中文注释：不同 Hermes 根目录使用不同调度标识，避免互相覆盖。
    suffix = hashlib.sha256(str(home).encode()).hexdigest()[:12]
    return user_home / 'Library/LaunchAgents' / f'com.hermes.browser-link.update.{suffix}.plist'


def configure_schedule(mode, home, user_home, cli):
    path = agent_path(home, user_home)
    updater = home / 'plugins/browser-link/maintenance/update.py'
    cli.EXECUTOR.reject_target_symlinks([path, updater])
    if mode != 'off' and not updater.is_file():
        raise ValueError('先运行 ./install.sh --upgrade 安装自动更新组件')
    previous = path.read_bytes() if path.is_file() else None
    if mode == 'off' and previous is None:
        return
    domain = f'gui/{os.getuid()}'
    label = path.stem
    # 中文注释：只卸载当前插件、当前 HOME 的任务，未注册时不执行 bootout。
    present = subprocess.run(['/bin/launchctl', 'print', f'{domain}/{label}'], capture_output=True, timeout=10)
    if present.returncode == 0:
        subprocess.run(['/bin/launchctl', 'bootout', f'{domain}/{label}'], check=True, capture_output=True, timeout=10)
    if mode == 'off':
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {'Label': label, 'ProgramArguments': [sys.executable, str(updater),
        '--hermes-home', str(home), '--user-home', str(user_home), '--automatic',
        *(['--check'] if mode == 'check' else [])], 'StartInterval': 3600,
        'EnvironmentVariables': {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'PYTHONDONTWRITEBYTECODE': '1'}}
    try:
        path.write_bytes(plistlib.dumps(document))
        path.chmod(0o600)
        subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(path)], check=True, capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        path.unlink(missing_ok=True)
        # 中文注释：切换调度失败时恢复原文件和已加载任务，不误报启用成功。
        if previous is not None:
            path.write_bytes(previous)
            path.chmod(0o600)
            if present.returncode == 0:
                subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(path)], check=True, capture_output=True, timeout=10)
        raise


def save_status(path, value):
    # 中文注释：只保存版本与结果，不持久化外部异常、账号或下载响应。
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf8') as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output, ensure_ascii=False)
    temporary.replace(path)


def update(args, cli):
    home, user_home = args.hermes_home, args.user_home
    current = cli.installed_version(home / 'plugins/browser-link')
    version_tuple(current)
    release = latest_release()
    status = {'currentVersion': current, 'status': 'no_stable_release' if release is None else 'up_to_date'}
    if release:
        status['latestVersion'] = release['version']
    newer = release is not None and version_tuple(release['version']) > version_tuple(current)
    if newer:
        status['status'] = 'available'
    if newer and not args.check:
        if applications_running():
            status['status'] = 'deferred'
        else:
            with tempfile.TemporaryDirectory(prefix='browser-link-update-') as scratch:
                package = extract_archive(fetch(release['url'], MAX_ARCHIVE), release, Path(scratch), cli.EXECUTOR)
                cli.EXECUTOR.verify_package(package)
                if (cli.EXECUTOR.release_status(package) != f'RELEASE V{release["version"]}'
                        or cli.installed_version(package / 'browser-link') != release['version']
                        or json.loads((package / 'native-extension/manifest.json').read_text())['version'] != release['version']):
                    raise ValueError('安装包版本与正式发布标签不一致')
                # 中文注释：下载期间可能重新打开应用，写入前再次确认；安装器沿用备份和回滚。
                if applications_running():
                    status['status'] = 'deferred'
                else:
                    cli.ROOT = package
                    install_args = argparse.Namespace(user_home=user_home, hermes_home=home,
                        upgrade=True, uninstall=False, profile=None, dry_run=False, verbose=False,
                        wait_seconds=0, background_update=True)
                    cli.run(install_args)
                    status.update(status='updated', currentVersion=release['version'], reloadRequired=True)
    return status


def run(args):
    cli = installer_modules()
    roots = [args.hermes_home.expanduser(), args.user_home.expanduser()]
    if any(root.is_symlink() for root in roots):
        raise ValueError('更新根目录不能是链接')
    args.hermes_home, args.user_home = [root.resolve() for root in roots]
    if args.hermes_home.parent.name == 'profiles':
        args.hermes_home = args.hermes_home.parent.parent
    home = args.hermes_home
    data = home / 'plugin-data/browser-link-native'
    status_path = data / 'update-status.json'
    cli.EXECUTOR.reject_target_symlinks([data, status_path, status_path.with_suffix('.tmp'),
                                      home / 'plugins/browser-link'])
    if not (home / 'plugins/browser-link/plugin.yaml').is_file():
        raise ValueError('尚未安装 Browser Link')
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    # 中文注释：内核锁在异常退出后自动释放，手动更新与后台任务不会并发安装。
    with cli.install_lock(data):
        if args.schedule:
            configure_schedule(args.schedule, home, args.user_home, cli)
            print({'off': '自动更新已关闭。', 'check': '已开启每小时检查更新。',
                   'install': '已开启每小时检查，浏览器和 Hermes 退出后安装更新。'}[args.schedule])
            return 0
        try:
            status = update(args, cli)
        except Exception:
            save_status(status_path, {'status': 'failed'})
            raise
        save_status(status_path, status)
        labels = {'no_stable_release': '暂无正式发布版本。', 'up_to_date': '当前已是最新版本。',
            'available': '发现新版本；运行 ./install.sh --update 安装。',
            'deferred': ('发现新版本；请退出 Chrome、Edge 和 Hermes，下一次自动检查会重试。'
                         if args.automatic else '发现新版本；请退出 Chrome、Edge 和 Hermes 后重新运行 --update。'),
            'updated': '更新完成；下次打开浏览器后重载扩展并启动 Hermes。'}
        print(labels[status['status']])
        print(json.dumps(status, ensure_ascii=False))
        return 0


def main():
    parser = argparse.ArgumentParser(description='Browser Link 自动更新')
    parser.add_argument('--hermes-home', type=Path, default=Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes'))))
    parser.add_argument('--user-home', type=Path, default=Path.home())
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--automatic', action='store_true')
    parser.add_argument('--schedule', choices=('off', 'check', 'install'))
    args = parser.parse_args()
    return report_run(args)


def main_with_args(args):
    # 中文注释：安装入口只传固定动作及可信根目录，不允许指定更新 URL 或预发布通道。
    return report_run(argparse.Namespace(hermes_home=args.hermes_home, user_home=args.user_home,
        check=args.check_update, automatic=False, schedule=args.auto_update))


def report_run(args):
    try:
        return run(args)
    except Exception as error:
        # 中文注释：终端只输出固定处理方法，不泄漏网络响应或用户私有路径。
        print(f'自动更新失败（{type(error).__name__}）；检查网络、Release 附件和安装目录。', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
