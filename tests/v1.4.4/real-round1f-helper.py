"""中文注释：只在 real-session 建立的临时目录中调用实际 open/script，不访问个人配置。"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('round1f_real_fixture', ROOT / 'tests/native-v2/real-helper.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
work = Path(sys.argv[1]).resolve()
if not work.is_relative_to(Path('/tmp').resolve()):
    raise RuntimeError('拒绝非临时夹具目录')
paths = fixture.paths(work)
if not paths['plugin'].resolve().is_relative_to(work) or not paths['hermes'].resolve().is_relative_to(work) or not (paths['plugin'] / 'native_tools.py').is_file():
    raise RuntimeError('夹具插件不存在')
os.environ['HERMES_HOME'] = str(paths['hermes'])
os.environ.pop('HERMES_BROWSER_BRIDGE_HOME', None)
tools = fixture.load(paths['plugin'] / 'native_tools.py', 'round1f_real_tools')
runtime = tools.runtime_module()
profile = runtime.NativeProfileRuntime(paths['hermes'], paths['plugin'])
counts = {}
original = profile.call


def counted(method, params):
    # 中文注释：只记动作名和次数，不记录 URL、选择器、脚本或页面内容。
    if method == 'shared.run':
        action = params['action']
        counts[action] = counts.get(action, 0) + 1
    return original(method, params)


profile.call = counted
bridge_module = runtime.load_module(paths['plugin'] / 'script_lane/host_bridge.py', 'round1f_real_bridge')
bridge = bridge_module.HostBridge(profile, paths['plugin'])
session, action, payload = sys.argv[2:5]
try:
    if action == 'open':
        module = runtime.load_module(paths['plugin'] / 'open_tool.py', 'round1f_real_open')
        args = json.loads(payload)
        profile.authority.lease_tools(('browser_shared_open',))
        decision = profile.authority.pre_tool_call('browser_shared_open', args, session_id=session, tool_call_id=uuid.uuid4().hex)
        if decision.get('action') != 'modify':
            raise RuntimeError('缺少可信身份')
        result = json.loads(module.make_handler(profile, bridge, lease_error=runtime.OwnerLeaseError)({**args, **decision['args']}, session_id=session))
    elif action == 'script':
        task_id, code = json.loads(payload)
        tool = runtime.load_module(paths['plugin'] / 'script_lane/tool.py', 'round1f_real_script')
        owner = profile.authority.owner_for_session(session)
        bridge.bind(session, owner=owner, task_id=task_id)
        result = tool.run_script(bridge, session_id=session, tool_call_id=uuid.uuid4().hex,
                    workspace=tool.workspace_for(paths['hermes'], owner), code=code, timeout_s=90)
    else:
        raise RuntimeError('只允许 open/script')
    print(json.dumps({'result': result, 'action_counts': counts}, ensure_ascii=False))
finally:
    bridge.close()
    profile.close()
