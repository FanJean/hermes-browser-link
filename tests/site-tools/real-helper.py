"""中文注释：临时安装包网站工具入口验收；复用正式租约、脚本通道和桥接服务。"""
import importlib.util
import json
from pathlib import Path
import sys
import types
import uuid

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('site_real_base', root / 'tests/native-v2/real-helper.py')
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
value = base.paths(Path(sys.argv[1]))
plugin = value['plugin']
native = base.load(plugin / 'native_runtime.py', 'site_real_native')
profile = native.NativeProfileRuntime(value['hermes'], plugin)
bridge_module = native.load_module(plugin / 'script_lane/host_bridge.py', 'site_real_bridge_')
bridge = bridge_module.HostBridge(profile, plugin)
handlers = {}
try:
    session, task, name, args = sys.argv[2], sys.argv[3], sys.argv[4], json.loads(sys.argv[5])
    # 中文注释：测试专用网关入口，只连接本次临时任务，不注册为产品工具。
    if name == 'fixture_gateway':
        print(json.dumps(profile.call('shared.cdp_gateway', {'owner': profile.authority.owner_for_session(session), 'taskId': task})))
        raise SystemExit(0)
    ctx = types.SimpleNamespace(register_tool=lambda **kw: handlers.update({kw['name']: kw['handler']}))
    sites = native.load_module(plugin / 'site_tools/tools.py', 'site_real_tools_')
    sites.register(ctx, bridge, profile, value['hermes'], lease_error=native.OwnerLeaseError, bridge_denied=bridge_module.BridgeDenied)
    reference = native.load_module(plugin / 'reference.py', 'site_real_reference_')
    reference.register(ctx, profile, value['hermes'], lease_error=native.OwnerLeaseError)
    if name in {'browser_site_manage', 'browser_site_run'} and (name == 'browser_site_run' or args.get('action') == 'try'):
        try:
            bridge.bind(session, owner=profile.authority.owner_for_session(session), task_id=task)
        except bridge_module.BridgeDenied:
            print(json.dumps({'ok': False, 'code': 'binding_missing'}))
            raise SystemExit(0)
    hook = profile.authority.pre_tool_call(name, args, session_id=session, tool_call_id=uuid.uuid4().hex)
    print(handlers[name]({**args, **hook['args']}, session_id=session))
finally:
    bridge.close(); profile.close()
