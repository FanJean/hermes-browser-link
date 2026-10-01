"""中文注释：只读安装和连接诊断；不启动 daemon、不修复文件、不恢复授权。"""
import argparse
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys

HOST = 'com.hermes.browser_link'


def probe(home):
    # 中文注释：直接连接已有套接字，不能调用会自动启动服务的 BridgeClient。
    data = Path(home) / 'plugin-data/browser-link-native'
    try:
        token_path = data / 'token'
        info = token_path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            return {'ok': False, 'code': 'token_permissions'}
        token = token_path.read_text().strip()
        if not token or len(token) > 4096:
            return {'ok': False, 'code': 'token_invalid'}
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(12)
            connection.connect(str(data / 'bridge.sock'))
            with connection.makefile('rb') as reader:
                connection.sendall((json.dumps({'role': 'client', 'token': token}) + '\n').encode())
                result = {}
                for number, method in enumerate(('health', 'browser.list')):
                    connection.sendall((json.dumps({'id': str(number), 'method': method, 'params': {}}) + '\n').encode())
                    line = reader.readline(65537)
                    if len(line) > 65536:
                        return {'ok': False, 'code': 'invalid_response'}
                    reply = json.loads(line)
                    if reply.get('id') != str(number) or 'error' in reply:
                        return {'ok': False, 'code': 'authentication_or_protocol'}
                    result[method] = reply.get('result')
                # 中文注释：连接成功不代表协议有效，损坏列表不能被当成空列表或让诊断崩溃。
                if (not isinstance(result['health'], dict) or not isinstance(result['browser.list'], list)
                        or any(not isinstance(row, dict) for row in result['browser.list'])):
                    return {'ok': False, 'code': 'invalid_response'}
                return {'ok': result['health'].get('ok') is True, 'protocol': result['health'].get('protocolVersion'), 'browsers': result['browser.list']}
    except (socket.timeout, TimeoutError):
        # 中文注释：一次探测超时只表示本次未确认，不能据此判定守护进程已退出。
        return {'ok': False, 'code': 'host_unconfirmed'}
    except (ConnectionRefusedError, FileNotFoundError):
        return {'ok': False, 'code': 'host_unavailable'}
    except (OSError, ValueError, AttributeError):
        return {'ok': False, 'code': 'host_unconfirmed'}


def diagnose(home, user_home=None, probe_fn=probe):
    home = Path(home).expanduser().resolve()
    user_home = Path(user_home or Path.home()).expanduser().resolve()
    checks, advice = [], []
    plugin = home / 'plugins/browser-link/plugin.yaml'
    checks.append({'component': 'plugin', 'ok': plugin.is_file(), 'code': 'installed' if plugin.is_file() else 'plugin_missing'})
    if not plugin.is_file():
        advice.append('按安装文档安装插件；源码目录存在不代表 Hermes 已加载插件。')
    for browser, directory in [('chrome', 'Google/Chrome'), ('edge', 'Microsoft Edge')]:
        path = user_home / 'Library/Application Support' / directory / 'NativeMessagingHosts' / (HOST + '.json')
        valid, code = False, 'manifest_missing'
        if path.exists():
            try:
                manifest = json.loads(path.read_text())
                launcher = Path(manifest['path'])
                origins = manifest.get('allowed_origins', [])
                valid = manifest.get('name') == HOST and manifest.get('type') == 'stdio' and launcher.is_absolute() and launcher.is_file() and os.access(launcher, os.X_OK) and bool(origins) and all(isinstance(v, str) and re.fullmatch(r'chrome-extension://[a-p]{32}/', v) for v in origins)
                code = 'registered' if valid else 'manifest_invalid'
            except (OSError, ValueError, KeyError, TypeError):
                code = 'manifest_invalid'
        checks.append({'component': browser, 'ok': valid, 'code': code})
    if not any(c['ok'] for c in checks[1:]):
        advice.append('核对 Native Messaging manifest、扩展 ID 与启动文件路径；运行安装预览查看差异。')
    live = probe_fn(home)
    browsers = live.get('browsers', []) if live.get('ok') else []
    checks.append({'component': 'host', 'ok': live.get('ok') is True, 'code': 'connected' if live.get('ok') else live.get('code', 'host_unconfirmed')})
    connected = [b for b in browsers if isinstance(b, dict) and b.get('connected') is True]
    checks.append({'component': 'extension', 'ok': bool(connected), 'code': 'connected' if connected else 'extension_disconnected'})
    if not live.get('ok'):
        advice.append('本次未确认守护进程连接；先运行 browser_shared_health 和 browser_shared_browsers，再查看 daemon.pid 与 bridge.sock。doctor 不会启动服务。')
    elif not connected:
        advice.append('重新加载目标浏览器的扩展，确认弹窗显示已连接。')
    for browser in connected:
        if browser.get('consentStatus') != 'enabled':
            advice.append('在目标浏览器扩展中打开浏览器访问；连接成功不代表任务已获授权。')
    return {'ok': checks[0]['ok'] and any(c['ok'] for c in checks[1:3]) and bool(connected) and live.get('ok') is True,
            'checks': checks, 'browsers': connected, 'advice': list(dict.fromkeys(advice)), 'read_only': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--hermes-home', default=os.environ.get('HERMES_HOME', str(Path.home() / '.hermes')))
    parser.add_argument('--user-home')
    args = parser.parse_args()
    result = diagnose(args.hermes_home, args.user_home)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result['ok'] else 1)
