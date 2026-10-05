"""云端能力边界：复用本地工具，不向云端开放本机文件或原始调试通道。"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
# 中文注释：安装包中组件同级；源码中复用 executor-plugin，只有这两种已有布局。
PLUGIN = ROOT if (ROOT / 'native_tools.py').is_file() else ROOT / 'executor-plugin'
# 中文注释：复用源码与安装包各自已有的 native bridge，不另建本地浏览器服务。
NATIVE_BRIDGE = PLUGIN / 'native_bridge' if PLUGIN == ROOT else ROOT / 'native-bridge'
spec = importlib.util.spec_from_file_location('browser_link_cloud_native_tools', PLUGIN / 'native_tools.py')
native_tools = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = native_tools
spec.loader.exec_module(native_tools)

# 中文注释：身份、审批、Cookie、文件路径和任意脚本不能成为云端参数。
TOOL_SUFFIXES = ('create', 'list', 'get', 'run', 'cancel', 'resume', 'close')
CLOUD_ACTIONS = native_tools.PUBLIC_ACTIONS - {
    'files.upload', 'api_request', 'js.evaluate', 'cdp.send', 'cdp.events', 'console',
}


def schemas():
    # 中文注释：复制已有契约，避免修改本地工具的共享 schema 对象。
    result = json.loads(json.dumps({suffix: native_tools.TOOL_SCHEMAS['browser_shared_' + suffix]['parameters']
                                   for suffix in TOOL_SUFFIXES}))
    create = result['create']
    del create['properties']['instance_id']
    create['required'].remove('instance_id')
    run = result['run']
    run['properties']['action']['enum'] = sorted(CLOUD_ACTIONS)
    for field in ('paths', 'artifact_ids', 'fields', 'http_method', 'expression', 'arguments', 'world',
                  'await_promise', 'timeout_ms', 'method', 'cdp_params', 'target_id', 'max', 'clear', 'request_id'):
        run['properties'].pop(field, None)
    run['allOf'][0]['if']['properties']['action']['enum'] = sorted(CLOUD_ACTIONS - {'tabs', 'new_tab'})
    for field in ('until', 'timeout_s'):
        result['get']['properties'].pop(field, None)
    return result


if __name__ == '__main__':
    # 中文注释：只导出机器契约；正文说明保留人工编写。
    print(json.dumps(schemas(), ensure_ascii=False, indent=2))
