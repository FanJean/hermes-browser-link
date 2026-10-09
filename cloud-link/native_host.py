#!/usr/bin/env python3
"""独立 Native Messaging 云端端口；不重启或替换本地浏览器桥。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import signal
import sys
import threading
import uuid

from runtime.capabilities import NATIVE_BRIDGE, native_tools
from runtime.service import CloudService

# 中文注释：复用原生帧解析与写入，不引入第二套浏览器执行器。
sys.path.insert(0, str(NATIVE_BRIDGE))
framing = native_tools._runtime.load_module(NATIVE_BRIDGE / 'host.py', 'browser_cloud_framing_')
sys.path.remove(str(NATIVE_BRIDGE))


def main():
    home = Path(os.environ.get('HERMES_HOME', Path.home() / '.hermes'))
    if len(sys.argv) < 2 or sys.argv[1] not in framing._load_allowed_origins(home / 'plugin-data/browser-link-native'):
        return 3
    write_lock = threading.Lock()
    pending = {}
    pending_lock = threading.Lock()
    service = None
    # 中文注释：云端进程单独停止时交还自己的任务，不能留下仍可使用的旧授权。
    def stop(_signal, _frame):
        raise EOFError
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def send(value):
        framing.write_native_message(sys.stdout.buffer, value, write_lock)

    def request_browser(method, params):
        request_id = uuid.uuid4().hex
        entry = {'event': threading.Event(), 'response': None}
        with pending_lock:
            pending[request_id] = entry
        try:
            send({'id': request_id, 'method': method, 'params': params})
            if not entry['event'].wait(15) or not isinstance(entry['response'], dict) or 'error' in entry['response']:
                raise ValueError('cloud_browser_unavailable')
            return entry['response'].get('result', {})
        finally:
            with pending_lock:
                pending.pop(request_id, None)

    def handle(message):
        nonlocal service
        request_id = message.get('id')
        try:
            method, params = message.get('method'), message.get('params', {})
            if not isinstance(params, dict):
                raise ValueError('invalid_params')
            if method == 'hello':
                if service or set(params) != {'instance_id', 'browser'} or not re.fullmatch(r'[a-f0-9-]{36}', params.get('instance_id', '')) or params.get('browser') not in ('Chrome', 'Edge'):
                    raise ValueError('invalid_identity')
                service = CloudService(home, params['instance_id'], params['browser'], request_browser,
                    notify=lambda value: send({'method': 'cloud.status_changed', 'params': value}))
                result = service.view()
            elif service is None:
                raise ValueError('cloud_not_initialized')
            elif method == 'status' and not params:
                result = service.view()
            elif method == 'connect' and set(params) <= {'replace'} and type(params.get('replace', False)) is bool:
                result = service.start_pairing(params.get('replace', False))
            elif method == 'disconnect' and not params:
                result = service.disconnect()
            else:
                raise ValueError('invalid_method')
            send({'id': request_id, 'result': result})
        except Exception:
            # 中文注释：界面只接收固定错误，凭据、网页内容和网络异常不会经 stdout 输出。
            send({'id': request_id, 'error': '云端操作未确认，请检查连接状态后重试。'})

    try:
        while True:
            message = framing.read_native_message(sys.stdin.buffer)
            with pending_lock:
                entry = pending.get(message.get('id')) if 'method' not in message else None
            if entry:
                entry['response'] = message
                entry['event'].set()
            elif message.get('method') == 'hello':
                handle(message)
            else:
                threading.Thread(target=handle, args=(message,), daemon=True).start()
    except (EOFError, OSError, ValueError, json.JSONDecodeError):
        return 0
    finally:
        # 中文注释：浏览器断线时立即结束反向请求等待，不让失效授权继续等待回执。
        with pending_lock:
            for entry in pending.values():
                entry['response'] = {'error': 'cloud_disconnected'}
                entry['event'].set()
        if service:
            service.close()


if __name__ == '__main__':
    os.umask(0o077)
    raise SystemExit(main())
