"""Isolated v2 fixture helper; optional package-first installation."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get('HERMES_SOURCE', str(Path.home() / '.hermes/hermes-agent')))
mode, work = sys.argv[1], Path(sys.argv[2]).resolve()
assert work.is_relative_to(Path.home() / '.hermes/cache/scratch')
home = work / 'home'
hh = home / '.hermes'
installed = hh / 'plugins/browser-link'
packaged = os.environ.get('API_V2_PACKAGE')
bridge = installed / 'native_bridge' if packaged else ROOT / 'native-bridge'
plugin = installed if packaged else ROOT / 'executor-plugin'
sys.path.insert(0, str(bridge))

def load(path):
    spec = importlib.util.spec_from_file_location('api_fixture_' + uuid.uuid4().hex, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

if mode == 'prepare':
    helper = load(Path(__file__).with_name('real-helper.py'))
    print(json.dumps(helper.prepare(work, Path(packaged))))
elif mode == 'daemon':
    from daemon import BridgeDaemon
    from api_client import ApiClient
    assert Path(sys.modules['daemon'].__file__).resolve() == bridge / 'daemon.py'
    assert Path(sys.modules['api_client'].__file__).resolve() == bridge / 'api_client.py'
    d = BridgeDaemon(hh)
    d.api_client = ApiClient(fixture=(sys.argv[3], sys.argv[4]))
    signal.signal(signal.SIGTERM, d.stop)
    d.run()
    assert not d.api_credentials and not d.api_connections
elif mode == 'stage':
    extension = sys.argv[3]
    if packaged:
        helper = load(Path(__file__).with_name('real-helper.py'))
        result = helper.install(work, [f'chrome-extension://{extension}/'])
        manifest = Path(result['manifests']['Google/Chrome'])
        target = work / 'profile/NativeMessagingHosts/com.hermes.browser_link.json'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(manifest.read_bytes())
        print(json.dumps(result))
        sys.exit(0)
    data = hh / 'plugin-data/browser-link-native'
    data.mkdir(parents=True, exist_ok=True)
    launcher = data / 'fixture-host'
    launcher.write_text(f'#!{sys.executable}\nimport os,sys,runpy\nos.environ["HERMES_HOME"]={str(hh)!r}\nsys.path.insert(0,{str(ROOT / "native-bridge")!r})\nrunpy.run_path({str(ROOT / "native-bridge/host.py")!r},run_name="__main__")\n')
    launcher.chmod(0o700)
    (data / 'host-config.json').write_text(json.dumps({'allowedOrigins': [f'chrome-extension://{extension}/']}))
    target = work / 'profile/NativeMessagingHosts/com.hermes.browser_link.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({'name': 'com.hermes.browser_link', 'description': 'isolated API fixture', 'path': str(launcher), 'type': 'stdio', 'allowed_origins': [f'chrome-extension://{extension}/']}))
    print('{}')
elif mode == 'rpc':
    os.environ['HOME'] = str(home)
    os.environ['HERMES_HOME'] = str(hh)
    sys.path.insert(0, str(SOURCE))
    from hermes_cli import plugins
    tools = load(plugin / 'native_tools.py')
    runtime = tools.runtime_module().NativeProfileRuntime(hh, plugin)
    manager = plugins.PluginManager()
    manager._hooks.setdefault('pre_tool_call', []).append(runtime.authority.pre_tool_call)
    session, suffix, args = sys.argv[3], sys.argv[4], json.loads(sys.argv[5])
    name = 'browser_shared_' + suffix
    with patch.object(plugins, '_delivery_manager', return_value=manager):
        block, bounded = plugins._dispatch_pre_tool_call_hooks(name, args, session_id=session, tool_call_id=uuid.uuid4().hex)
        if block: print(json.dumps({'code': 'owner_denied'}))
        else: print(tools.make_tool_handler(name, runtime)(bounded, session_id=session))
    runtime.close()
