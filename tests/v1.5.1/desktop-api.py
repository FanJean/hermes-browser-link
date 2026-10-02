"""中文注释：手动验收的桌面 HTTP 夹具；只绑定传入的临时 Hermes home，不启动真实桌面宿主。"""
import importlib.util
import json
from pathlib import Path
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient


def call(home, method, route, body):
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location('real_desktop_cookie_api', root / 'executor-plugin/dashboard/plugin_api.py')
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    runtime = api._native_tools().runtime_module().NativeProfileRuntime(Path(home), root / 'executor-plugin')
    # 中文注释：生产宿主负责身份认证；此隔离夹具绑定临时 profile 的 UI owner，不能传入 owner。
    api._native_profile_runtime = lambda: runtime
    app = FastAPI()
    app.include_router(api.router, prefix='/api/plugins/browser-link')
    try:
        with TestClient(app) as client:
            response = client.request(method, '/api/plugins/browser-link' + route, **({'json': body} if body is not None else {}))
            return {'status': response.status_code, 'body': response.json()}
    finally:
        runtime.close()


if __name__ == '__main__':
    try:
        home, method, route, raw = sys.argv[1:]
        print(json.dumps(call(home, method, route, json.loads(raw)), ensure_ascii=False))
    except Exception:
        # 中文注释：不打印运行时原始异常，避免私有浏览器响应进入验收日志。
        print(json.dumps({'status': 503, 'body': {'detail': '桌面 API 验收夹具不可用'}}))
        raise SystemExit(1)
