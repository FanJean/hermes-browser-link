"""中文注释：短命测试进程调用实际插件钩子；只允许使用 real-session 创建的临时 HOME。"""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('autoclose_real_fixture', ROOT / 'tests/native-v2/real-helper.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
work = Path(sys.argv[1]).resolve()
value = fixture.paths(work)
if not work.is_relative_to(Path('/tmp').resolve()) or not value['plugin'].is_relative_to(work) or not (value['plugin'] / 'native_tools.py').is_file():
    raise RuntimeError('拒绝非临时验收目录')
os.environ['HERMES_HOME'] = str(value['hermes'])
os.environ.pop('HERMES_BROWSER_BRIDGE_HOME', None)
tools = fixture.load(value['plugin'] / 'native_tools.py', 'autoclose_real_tools')
profile = tools.runtime_module().NativeProfileRuntime(value['hermes'], value['plugin'])


class Context:
    # 中文注释：注册实际钩子，不能用直接 shared.close 替代被测生命周期。
    hooks = {}
    def register_hook(self, name, callback):
        self.hooks[name] = callback
    def register_tool(self, **_):
        pass
    def on_unload(self, callback):
        pass


try:
    ctx = Context()
    tools.register_native_context(ctx, profile)
    session, event = sys.argv[2:4]
    if event == 'stop':
        key = 'agent:fixture:' + session
        # 中文注释：该 SQLite 仅在隔离 HOME，提供 Hermes 当前路由格式的真实 key -> ID 载荷。
        with sqlite3.connect(value['hermes'] / 'state.db') as db:
            db.execute('CREATE TABLE IF NOT EXISTS gateway_routing (scope TEXT, session_key TEXT, entry_json TEXT, PRIMARY KEY(scope, session_key))')
            db.execute('INSERT OR REPLACE INTO gateway_routing VALUES (?, ?, ?)', (
                str((value['hermes'] / 'sessions').resolve()), key, json.dumps({'session_key': key, 'session_id': session})))
        ctx.hooks['agent_loop_stopped'](session_key=key)
    elif event in {'completed', 'failed', 'interrupted'}:
        ctx.hooks['on_session_end'](session_id=session, **{event: True})
        if event == 'completed':
            # 中文注释：模拟 hermes chat -Q 完成后的进程 finalize，不能绕过 daemon 宽限。
            ctx.hooks['on_session_finalize'](session_id=session)
    else:
        raise ValueError('未知钩子事件')
    print(json.dumps({'event': event, 'delivered': True}))
finally:
    profile.close()
