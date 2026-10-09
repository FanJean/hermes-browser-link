"""中文注释：只操作临时 HOME 和打包快照，命令替身不访问真实 Hermes 或浏览器。"""
import hashlib
import argparse
import fcntl
import io
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import shlex
import socket
import sqlite3
import select
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
ORIGIN = 'chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/'
HOST = 'com.hermes.browser_link'


def rehash(package):
    # 中文注释：每次合成夹具变更都重新生成完整清单，不绕过安装校验。
    (package / 'SHA256SUMS.json').write_text(json.dumps({
        path.relative_to(package).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in package.rglob('*') if path.is_file() and path.name != 'SHA256SUMS.json'
    }))


class InstallFlowTests(unittest.TestCase):
    def auto_update(self, *, busy=None, corrupt=False, fail=False, profiles=('default',)):
        # 中文注释：以真实打包产物走完整下载校验及事务升级，网络和进程查询用替身。
        for name in profiles:
            if name != 'default':
                (self.hermes / 'profiles' / name).mkdir(parents=True)
        self.invoke(*[arg for name in profiles for arg in ('--profile', name)])
        self.auto_configs = {}
        for name in profiles:
            profile = self.hermes if name == 'default' else self.hermes / 'profiles' / name
            config = profile / 'config.yaml'
            config.write_bytes(b'plugins:\n  browser-link: false\ncapabilities: [tools.override]\n')
            self.auto_configs[config] = config.read_bytes()
        # 中文注释：写入标记，后台再调用 open/pbcopy 会覆盖它们，测试可以直接发现。
        (self.root / 'opened.json').write_text('browser-handoff-preserved')
        (self.root / 'clipboard').write_text('clipboard-preserved')
        module_spec = importlib.util.spec_from_file_location('flow_updater', self.plugin / 'maintenance/update.py')
        updater = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(updater)
        version = '9.0.0'
        plugin = self.package / 'browser-link/plugin.yaml'
        import re
        plugin.write_text(re.sub(r'^version:.*$', 'version: ' + version, plugin.read_text(), flags=re.M))
        extension = self.package / 'native-extension/manifest.json'
        manifest = json.loads(extension.read_text())
        manifest['version'] = version
        extension.write_text(json.dumps(manifest))
        (self.package / 'RELEASE-STATUS.txt').write_text(f'RELEASE V{version}: formal release built from commit ' + 'a' * 40 + '. Verified fixture.\n')
        rehash(self.package)
        if corrupt:
            (self.package / 'browser-link/runtime.py').write_text('# 中文注释：模拟摘要校验后的内容损坏\n')
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            for path in self.package.rglob('*'):
                if path.is_file():
                    archive.write(path, f'hermes-browser-link-{version}/' + path.relative_to(self.package).as_posix())
        payload = buffer.getvalue()
        release = {'version': version, 'url': 'fixed-test-url', 'size': len(payload),
                   'digest': hashlib.sha256(payload).hexdigest()}
        args = argparse.Namespace(hermes_home=self.hermes, user_home=self.home, check=False, automatic=True, schedule=None)
        original_copy = shutil.copytree
        failed = False
        def copy_with_failure(source, destination, *args, **kwargs):
            nonlocal failed
            result = original_copy(source, destination, *args, **kwargs)
            if fail and not failed and Path(destination) == self.plugin:
                failed = True
                raise OSError('injected root installation failure')
            return result
        with mock.patch.dict(os.environ, self.env), \
                mock.patch.object(shutil, 'copytree', side_effect=copy_with_failure), \
                mock.patch.object(updater, 'latest_release', return_value=release), \
                mock.patch.object(updater, 'fetch', return_value=payload), \
                mock.patch.object(updater, 'applications_running', side_effect=busy or [False, False]):
            return updater.run(args)

    def test_auto_update_installs_verified_release_without_opening_browser(self):
        self.auto_update()
        self.assertIn('version: 9.0.0', (self.plugin / 'plugin.yaml').read_text())
        status = json.loads((self.data / 'update-status.json').read_text())
        self.assertEqual(status['status'], 'updated')
        self.assertTrue(status['reloadRequired'])
        # 中文注释：后台升级不得覆盖首次安装之后的浏览器和剪贴板标记。
        self.assertEqual((self.root / 'opened.json').read_text(), 'browser-handoff-preserved')
        self.assertEqual((self.root / 'clipboard').read_text(), 'clipboard-preserved')
        self.assertTrue(list((self.hermes / 'plugin-backups').iterdir()))

    def test_auto_update_installed_cli_keeps_shared_links_and_disabled_configs(self):
        names = ('default', 'work', 'disabled', 'unregistered')
        self.auto_update(profiles=names)
        for config, contents in self.auto_configs.items():
            self.assertEqual(config.read_bytes(), contents)
        for name in names[1:]:
            reference = self.hermes / 'profiles' / name / 'plugins/browser-link'
            self.assertTrue(reference.is_symlink())
            self.assertEqual(reference.resolve(), self.plugin)
            self.assertIn('version: 9.0.0', (reference / 'plugin.yaml').read_text())
        self.assertEqual(len((self.root / 'commands.jsonl').read_text().splitlines()), len(names))

    def test_auto_update_defers_if_browser_reopens_during_download(self):
        self.auto_update(busy=[False, True])
        self.assertNotIn('version: 9.0.0', (self.plugin / 'plugin.yaml').read_text())
        self.assertFalse((self.data / 'update-status.json').exists())
        self.assertFalse((self.hermes / 'plugin-backups').exists())

    def test_auto_update_rejects_corrupt_inner_manifest_before_installing(self):
        with self.assertRaisesRegex(ValueError, '哈希不匹配'):
            self.auto_update(corrupt=True)
        self.assertNotIn('version: 9.0.0', (self.plugin / 'plugin.yaml').read_text())
        self.assertFalse((self.hermes / 'plugin-backups').exists())

    def test_auto_update_installation_failure_restores_previous_installation(self):
        with self.assertRaises(Exception):
            self.auto_update(fail=True)
        self.assertNotIn('version: 9.0.0', (self.plugin / 'plugin.yaml').read_text())
        self.assertNotEqual(json.loads((self.extension / 'manifest.json').read_text())['version'], '9.0.0')
        self.assertEqual(json.loads((self.data / 'update-status.json').read_text())['status'], 'failed')

    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix='bl-install-suite-')
        cls.base = Path(cls.scratch.name).resolve()
        cls.release = cls.base / 'release'
        result = subprocess.run(['node', str(ROOT / 'scripts/package-executor.mjs'), '--output', str(cls.release)],
                                capture_output=True, text=True, timeout=120)
        if result.returncode:
            cls.scratch.cleanup()
            raise RuntimeError(result.stderr)
        # 中文注释：只替换 doctor 为离线连接响应，发行包其余程序使用真实打包产物。
        (cls.release / 'browser-link/native_bridge/doctor.py').write_text('''import json, os, pathlib, sys
count = pathlib.Path(os.environ['TEST_DOCTOR_COUNT'])
number = int(count.read_text()) + 1 if count.exists() else 1
count.write_text(str(number))
ok = number >= int(os.environ.get('TEST_CONNECT_AT', '999'))
print(json.dumps({'ok': ok}))
sys.exit(0 if ok else 1)
''')
        rehash(cls.release)

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=self.base, prefix='case-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'user'
        self.hermes = self.root / 'hermes'
        self.home.mkdir()
        self.hermes.mkdir()
        (self.home / 'Applications/Google Chrome.app').mkdir(parents=True)
        self.package = self.root / 'package'
        shutil.copytree(self.release, self.package)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.stub('uname', '#!/bin/sh\nprintf "%s\\n" "${TEST_OS:-Darwin}"\n')
        # 中文注释：包装调用保留解释器原位置，不将 standalone Python 当作可重定位二进制。
        self.stub('python3', '#!/bin/sh\nexec ' + __import__('shlex').quote(sys.executable) + ' "$@"\n')
        (self.bin / 'bash').symlink_to('/bin/bash')
        self.stub('hermes', f'#!{sys.executable}\n' + '''import json, os, pathlib, sys
if sys.argv[1:] == ['--version']:
    if os.environ.get('TEST_VERSION_WRITES') == '1':
        pathlib.Path(os.environ['HERMES_HOME']).joinpath('version-cache').write_text('cached')
    print(os.environ.get('TEST_HERMES_VERSION', 'hermes 0.21.4'))
    sys.exit(0)
args = sys.argv[1:]
assert args[:1] == ['--profile'] and args[2:3] == ['plugins'] and args[4:] == ['browser-link'], args
root = pathlib.Path(os.environ['HERMES_HOME'])
profile = root if args[1] == 'default' else root / 'profiles' / args[1]
config = profile / 'config.yaml'
config.parent.mkdir(parents=True, exist_ok=True)
config.write_text('plugin: ' + args[3] + '\\n')
with open(os.environ['TEST_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if os.environ.get('TEST_CORRUPT') == '1':
    (profile / 'plugins/browser-link/runtime.py').write_text('# injected corruption\\n')
if os.environ.get('TEST_REPLACE_REFERENCE') == '1':
    import shutil
    reference = profile / 'plugins/browser-link'
    reference.unlink()
    shutil.copytree(root / 'plugins/browser-link', reference)
if os.environ.get('TEST_ACTIVATE_FAIL') == '1':
    sys.exit(7)
''')
        self.stub('pbcopy', f'#!{sys.executable}\nimport os,pathlib,sys\npathlib.Path(os.environ["TEST_CLIPBOARD"]).write_text(sys.stdin.read())\n')
        self.stub('open', f'#!{sys.executable}\nimport os,pathlib,json,sys\npathlib.Path(os.environ["TEST_OPEN"]).write_text(json.dumps(sys.argv[1:]))\n')
        self.stub('pgrep', '#!/bin/sh\nexit "${TEST_DESKTOP_RUNNING:-1}"\n')
        self.stub('ps', '#!/bin/sh\nexit 1\n')
        self.env = {**os.environ, 'HOME': str(self.home), 'HERMES_HOME': str(self.hermes),
                    'PATH': str(self.bin), 'PYTHONDONTWRITEBYTECODE': '1',
                    'TEST_LOG': str(self.root / 'commands.jsonl'),
                    'TEST_OPEN': str(self.root / 'opened.json'),
                    'TEST_CLIPBOARD': str(self.root / 'clipboard'),
                    'TEST_DOCTOR_COUNT': str(self.root / 'doctor-count')}
        self.plugin = self.hermes / 'plugins/browser-link'
        self.data = self.hermes / 'plugin-data/browser-link-native'
        self.extension = self.hermes / 'browser-link-releases/native-extension'
        self.manifests = [self.home / 'Library/Application Support' / browser / 'NativeMessagingHosts' / f'{HOST}.json'
                          for browser in ('Google/Chrome', 'Microsoft Edge')]

    def stub(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def invoke(self, *args, ok=True, source=False, stdin='', env=None):
        script = ROOT / 'install.sh' if source else self.package / 'install.sh'
        # 中文注释：从非 Git 的临时工作目录启动，PATH 中也没有 rg 或 git。
        result = subprocess.run([str(script), '--wait-seconds', '0', *args],
                                env={**self.env, **(env or {})}, input=stdin, capture_output=True,
                                text=True, cwd=self.root, timeout=150)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def seed_private_data(self):
        self.data.mkdir(parents=True, exist_ok=True)
        for name in ('tasks.json', 'private.txt', 'token'):
            path = self.data / name
            path.write_text(json.dumps({'version': 1, 'tasks': [{'id': 'kept', 'owner': 'synthetic',
                            'state': 'closed', 'cleanupState': 'succeeded', 'workspaceState': 'closed', 'requestHistory': []}]})
                            if name == 'tasks.json' else 'synthetic task-private value')
            path.chmod(0o600)
        return {path.name: path.read_bytes() for path in self.data.iterdir() if path.name in ('tasks.json', 'private.txt', 'token')}

    def invoke_fault(self, patch_code, *args):
        # 中文注释：在子进程中注入文件系统故障，仍运行真实打包 CLI 的 main。
        script = ('import sys, runpy, pathlib, shutil, os\nfrom unittest import mock\n' + patch_code +
                  '\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name="__main__")\n')
        result = subprocess.run([sys.executable, '-c', script, str(self.package / 'install-cli.py'),
                                 '--wait-seconds', '0', *args], env=self.env, capture_output=True,
                                text=True, cwd=self.root, timeout=150)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def old_install(self):
        # 中文注释：模拟旧安装的版本面，扩展公钥与来源不变。
        for path in (self.package / 'browser-link/plugin.yaml', self.package / 'native-extension/manifest.json'):
            path.write_text(path.read_text().replace(VERSION, '1.5.1'))
        rehash(self.package)
        self.invoke()
        config = self.data / 'host-config.json'
        config.write_text(json.dumps({'allowedOrigins': [ORIGIN], 'synthetic_setting': True}))
        private = self.seed_private_data()
        shutil.rmtree(self.package)
        shutil.copytree(self.release, self.package)
        return private

    def cloud_journal(self, *, legacy=False, pending=False):
        base = self.hermes / 'plugin-data/browser-link-cloud'
        directory = base if legacy else base / 'instances/11111111-1111-4111-8111-111111111111'
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = directory / 'requests.sqlite'
        with sqlite3.connect(path) as database:
            database.execute('CREATE TABLE commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT, delivered INTEGER NOT NULL DEFAULT 0)')
            database.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id TEXT, last_used REAL NOT NULL, closed INTEGER NOT NULL DEFAULT 0, synced INTEGER NOT NULL DEFAULT 0)')
            database.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', ('offline', 'task', 1., 1, 0 if pending else 1))
        path.chmod(0o600)
        return path

    def test_cloud_pending_legacy_and_other_instance_refuse_before_named_probe(self):
        self.old_install()
        self.named_shared_reference()
        for legacy in (False, True):
            path = self.cloud_journal(legacy=legacy, pending=True)
            for args in (('--upgrade',), ('--uninstall', '--yes')):
                self.assert_named_refusal_has_no_writes('Cloud state is active or unknown', *args)
            path.unlink()

    def test_cloud_native_lock_refuses_before_named_probe(self):
        self.old_install()
        self.named_shared_reference()
        path = self.cloud_journal()
        lock = path.parent / 'native.lock'
        lock.touch(mode=0o600)
        with lock.open('r') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_named_refusal_has_no_writes('Cloud state is active or unknown', '--upgrade')

    def test_cloud_unknown_schema_and_sidecar_refuse_without_writes(self):
        self.old_install(); self.named_shared_reference()
        path = self.cloud_journal()
        sidecar = Path(str(path) + '-wal')
        sidecar.touch(mode=0o600)
        self.assert_named_refusal_has_no_writes('Cloud state is active or unknown', '--upgrade')
        sidecar.unlink()
        with sqlite3.connect(path) as database:
            database.execute('ALTER TABLE sessions ADD COLUMN future INTEGER')
        self.assert_named_refusal_has_no_writes('Cloud state is active or unknown', '--upgrade')

    def test_unsupported_cloud_install_refuses_normal_upgrade_without_writes(self):
        self.old_install()
        self.named_shared_reference()
        state = self.data / 'install-state.json'
        value = json.loads(state.read_text())
        value.pop('cloudFence', None)
        state.write_text(json.dumps(value))
        self.assert_named_refusal_has_no_writes('--maintenance', '--upgrade')

    def real_head_cloud_install(self):
        # 中文注释：固定 HEAD 旧源码，不把 old_install 的版本字符串夹具冒充旧宿主。
        private = self.old_install()
        target = self.plugin / 'cloud_link'
        for path in target.rglob('*.py'):
            relative = path.relative_to(target).as_posix()
            content = subprocess.check_output(['git', 'show',
                'f2b0371b289552d1431332ee9dbe502cc8671c0a:cloud-link/' + relative],
                cwd=os.environ.get('BROWSER_LINK_RELEASE_HISTORY', ROOT))
            path.write_bytes(content)
        state = self.data / 'install-state.json'
        value = json.loads(state.read_text()); value.pop('cloudFence', None)
        state.write_text(json.dumps(value))
        return private

    def maintenance_invoke(self, *, fail=False, paused_probe=False, running_app=False, ok=True):
        # 中文注释：进程表仅保留本隔离夹具的真实宿主；不把用户正在使用的应用当测试对象。
        script = '''import os,sys,subprocess,runpy,pathlib
from unittest import mock
original=subprocess.run
def run(argv,*args,**kwargs):
    result=original(argv,*args,**kwargs)
    if argv==['/bin/ps','-axo','command=']:
        root=os.environ['HERMES_HOME']
        result.stdout='\\n'.join(line for line in result.stdout.splitlines() if
            root+'/plugins/browser-link/cloud_link/native_host.py' in line or
            root+'/plugin-data/browser-link-cloud/com.hermes.browser_link.cloud' in line)
        if os.environ.get('TEST_MAINTENANCE_APP')=='1':
            result.stdout+='\\n/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    return result
mock.patch.object(subprocess,'run',side_effect=run).start()
'''
        if paused_probe:
            script += '''original_open=os.open
def open_node(path,*args,**kwargs):
    if str(path).endswith('/native.lock'):
        launcher=pathlib.Path(os.environ['HERMES_HOME'])/'plugin-data/browser-link-cloud/com.hermes.browser_link.cloud'
        result=original([str(launcher),'chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/'],input=b'',capture_output=True,timeout=5)
        assert result.returncode==4,result
        pathlib.Path(os.environ['TEST_OPEN']).with_name('paused-launch-proof').write_text('paused-launch-blocked')
    return original_open(path,*args,**kwargs)
mock.patch.object(os,'open',side_effect=open_node).start()
'''
        script += "sys.argv=sys.argv[1:]\nrunpy.run_path(sys.argv[0],run_name='__main__')\n"
        result = subprocess.run([sys.executable, '-c', script, str(self.package / 'install-cli.py'),
            '--upgrade', '--maintenance', '--wait-seconds', '0', *(['--profile', 'default'] if fail else [])],
            env={**self.env, 'TEST_MAINTENANCE_APP': '1' if running_app else '0',
                 **({'TEST_ACTIVATE_FAIL': '1'} if fail else {})},
            capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0 if ok else 1, result.stdout + result.stderr)
        return result

    def start_real_old_host(self, *, hello=False):
        host = self.plugin / 'cloud_link/native_host.py'
        child = subprocess.Popen([sys.executable, str(host), ORIGIN], env=self.env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert child.stdin is not None and child.stdout is not None and child.stderr is not None
        payload = json.dumps({'id': 'loaded', 'method': 'hello' if hello else 'status',
            'params': {'instance_id': '11111111-1111-4111-8111-111111111111', 'browser': 'Chrome'} if hello else {}}).encode()
        child.stdin.write(struct.pack('<I', len(payload)) + payload); child.stdin.flush()
        self.assertTrue(select.select([child.stdout], [], [], 5)[0])
        size = struct.unpack('<I', child.stdout.read(4))[0]
        reply = json.loads(child.stdout.read(size))
        self.assertIn('result' if hello else 'error', reply)
        return child

    def stop_fixture_host(self, child):
        child.stdin.close(); child.wait(timeout=10)
        self.assertEqual(child.returncode, 0, child.stderr.read().decode())
        child.stdout.close(); child.stderr.close()

    def test_real_head_prehello_host_maintenance_refuses_and_restores_launcher(self):
        self.real_head_cloud_install()
        launcher = self.hermes / 'plugin-data/browser-link-cloud' / (HOST + '.cloud')
        before = (launcher.read_bytes(), launcher.stat().st_mode, launcher.stat().st_ino)
        child = self.start_real_old_host()
        try:
            result = self.maintenance_invoke(ok=False)
            self.assertIn('Cloud state is active or unknown', result.stderr)
            self.assertEqual((launcher.read_bytes(), launcher.stat().st_mode, launcher.stat().st_ino), before)
            self.assertIsNone(child.poll())
            self.assertFalse((self.hermes / 'plugin-backups').exists())
        finally:
            self.stop_fixture_host(child)

    def test_maintenance_requires_apps_closed_before_launcher_pause(self):
        self.real_head_cloud_install()
        before = self.inventory()
        self.maintenance_invoke(running_app=True, ok=False)
        self.assertEqual(self.inventory(), before)

    def test_real_head_offline_idle_first_maintenance_migration_blocks_launch(self):
        private = self.real_head_cloud_install()
        child = self.start_real_old_host(hello=True); self.stop_fixture_host(child)
        base = self.hermes / 'plugin-data/browser-link-cloud'
        pairing = base / 'instances/11111111-1111-4111-8111-111111111111/pairing.json'
        pairing.write_bytes(b'opaque synthetic private bytes'); pairing.chmod(0o600)
        original = pairing.read_bytes()
        launcher = base / (HOST + '.cloud'); original_launcher = launcher.read_bytes()
        self.maintenance_invoke(paused_probe=True)
        self.assertEqual((self.root / 'paused-launch-proof').read_text(), 'paused-launch-blocked')
        self.assertEqual(pairing.read_bytes(), original); self.assert_private_kept(private)
        self.assertIn('cloudFence', json.loads((self.data / 'install-state.json').read_text()))
        backup = next((self.hermes / 'plugin-backups').iterdir())
        index = json.loads((backup / 'paths.json').read_text())
        saved = next(Path(row['backup']) for row in index if row['path'] == str(launcher))
        self.assertEqual(saved.read_bytes(), original_launcher)
        self.assertNotIn(b'exit(4)', launcher.read_bytes())
        self.invoke('--upgrade'); self.invoke('--uninstall', '--yes')

    def test_real_head_maintenance_transaction_failure_restores_original_launcher_and_private(self):
        private = self.real_head_cloud_install()
        child = self.start_real_old_host(hello=True); self.stop_fixture_host(child)
        launcher = self.hermes / 'plugin-data/browser-link-cloud' / (HOST + '.cloud')
        before = launcher.read_bytes(), launcher.stat().st_mode
        original = (self.plugin / 'cloud_link/native_host.py').read_bytes()
        self.maintenance_invoke(fail=True, ok=False)
        self.assertEqual((launcher.read_bytes(), launcher.stat().st_mode), before)
        self.assertEqual((self.plugin / 'cloud_link/native_host.py').read_bytes(), original)
        self.assert_private_kept(private)

    def assert_private_kept(self, private):
        for name, contents in private.items():
            self.assertEqual((self.data / name).read_bytes(), contents)
            self.assertEqual((self.data / name).stat().st_mode & 0o777, 0o600)

    def inventory(self):
        # 中文注释：记录内容与权限，dry-run 不得生成临时输出、日志、剪贴板文件或缓存。
        return {str(path.relative_to(self.root)): (path.lstat().st_mode, os.readlink(path) if path.is_symlink()
                                                  else path.read_bytes() if path.is_file() else None)
                for path in self.root.rglob('*')}

    def test_first_install_release_needs_no_node_and_copies_absolute_extension_path(self):
        result = self.invoke()
        self.assertTrue((self.plugin / 'plugin.yaml').is_file())
        self.assertTrue((self.extension / 'manifest.json').is_file())
        self.assertEqual((self.root / 'clipboard').read_text(), str(self.extension))
        self.assertEqual(json.loads((self.root / 'opened.json').read_text()), ['-a', 'Google Chrome'])
        for path in self.manifests:
            self.assertEqual(json.loads(path.read_text())['allowed_origins'], [ORIGIN])
        self.assertEqual(json.loads((self.root / 'commands.jsonl').read_text()), ['--profile', 'default', 'plugins', 'enable', 'browser-link'])
        self.assertIn('Program installed and enabled', result.stdout)
        self.assertNotIn('Extension connected.', result.stdout)
        self.assertIn('Confirm browser connection authorization', result.stdout)
        self.assertNotIn('smart-approval', result.stdout)
        description = json.loads((self.plugin / 'dashboard/manifest.json').read_text())['description']
        self.assertIn('连接授权', description)
        self.assertNotIn('访问模式', description)

    def test_bash_install_filename_from_release_directory(self):
        # 中文注释：新用户常用 bash install.sh；文件名没有斜线时仍要定位当前安装包。
        result = subprocess.run(['bash', 'install.sh', '--wait-seconds', '0'],
                                env=self.env, capture_output=True, text=True,
                                cwd=self.package, timeout=150)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.plugin / 'plugin.yaml').is_file())

    def test_repeat_install_directs_upgrade_without_changing_files(self):
        self.invoke()
        before = self.inventory()
        result = self.invoke(ok=False)
        self.assertIn('./install.sh --upgrade', result.stderr)
        self.assertEqual(self.inventory(), before)

    def test_skipped_connection_wait_prints_runnable_check_for_shared_root(self):
        # 中文注释：profile 环境与含空格目录都必须得到可直接执行、指向共享根的检查命令。
        self.hermes = self.root / 'hermes with spaces'
        named = self.hermes / 'profiles/work'
        named.mkdir(parents=True)
        result = self.invoke('--profile', 'work', env={'HERMES_HOME': str(named)})
        self.assertIn('Browser connection not yet verified', result.stdout)
        check = next(line.split('Check: ', 1)[1] for line in result.stdout.splitlines()
                     if 'Check: ' in line)
        argv = shlex.split(check)
        self.assertEqual(argv[0], sys.executable)
        self.assertEqual(argv[1], str(self.hermes / 'plugins/browser-link/native_bridge/doctor.py'))
        self.assertEqual(argv[2:], ['--hermes-home', str(self.hermes), '--user-home', str(self.home)])
        checked = subprocess.run(argv, env={**self.env, 'TEST_CONNECT_AT': '1'},
                                 capture_output=True, text=True, timeout=15)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertIs(json.loads(checked.stdout)['ok'], True)

    def test_upgrade_preserves_private_data_id_allowlist_and_stable_path(self):
        private = self.old_install()
        old_extension = json.loads((self.extension / 'manifest.json').read_text())
        config = (self.data / 'host-config.json').read_bytes()
        self.invoke('--upgrade')
        self.assertIn(f'version: {VERSION}', (self.plugin / 'plugin.yaml').read_text())
        extension = json.loads((self.extension / 'manifest.json').read_text())
        self.assertEqual(extension['key'], old_extension['key'])
        self.assertEqual(extension['version'], VERSION)
        self.assertEqual((self.data / 'host-config.json').read_bytes(), config)
        self.assert_private_kept(private)
        backups = list((self.hermes / 'plugin-backups').glob('browser-link-1.5.1-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o700)
        self.assertFalse(any(path.name.startswith('browser-link-') for path in (self.hermes / 'plugins').iterdir()))
        index = json.loads((backups[0] / 'paths.json').read_text())
        plugin_backup = next(Path(row['backup']) for row in index if row['path'] == str(self.plugin))
        self.assertIn('version: 1.5.1', (plugin_backup / 'plugin.yaml').read_text())

    def test_upgrade_validation_failure_rolls_back_code_extension_config_and_data(self):
        private = self.old_install()
        old_plugin = (self.plugin / 'runtime.py').read_bytes()
        old_extension = (self.extension / 'manifest.json').read_bytes()
        old_config = (self.data / 'host-config.json').read_bytes()
        profile_config = self.hermes / 'config.yaml'
        profile_config.write_text('original profile settings\n')
        (self.hermes / 'profiles/new').mkdir(parents=True)
        result = self.invoke('--upgrade', '--profile', 'new', ok=False, env={'TEST_CORRUPT': '1'})
        self.assertIn('rolled back', result.stderr)
        self.assertEqual((self.plugin / 'runtime.py').read_bytes(), old_plugin)
        self.assertEqual((self.extension / 'manifest.json').read_bytes(), old_extension)
        self.assertEqual((self.data / 'host-config.json').read_bytes(), old_config)
        self.assertEqual(profile_config.read_text(), 'original profile settings\n')
        self.assert_private_kept(private)

    def test_upgrade_activation_failure_rolls_back(self):
        self.old_install()
        (self.hermes / 'profiles/new').mkdir(parents=True)
        result = self.invoke('--upgrade', '--profile', 'new', ok=False, env={'TEST_ACTIVATE_FAIL': '1'})
        self.assertIn('rolled back', result.stderr)
        self.assertIn('version: 1.5.1', (self.plugin / 'plugin.yaml').read_text())

    def test_corrupt_package_is_rejected_before_upgrade_writes(self):
        self.old_install()
        (self.package / 'browser-link/runtime.py').write_text('# unlisted modification\n')
        before = self.inventory()
        self.invoke('--upgrade', ok=False)
        self.assertEqual(self.inventory(), before)

    def test_rehashed_wrong_extension_id_is_rejected_before_writes(self):
        path = self.package / 'native-extension/manifest.json'
        value = json.loads(path.read_text())
        value['key'] = 'd3Jvbmc='
        path.write_text(json.dumps(value))
        rehash(self.package)
        before = self.inventory()
        result = self.invoke(ok=False)
        self.assertIn('Extension validation failed', result.stderr)
        self.assertEqual(self.inventory(), before)

    def test_upgrade_wrong_host_allowlist_is_rejected_without_widening(self):
        self.old_install()
        self.manifests[0].write_text(json.dumps({'allowed_origins': ['chrome-extension://' + 'a' * 32 + '/']}))
        before = self.inventory()
        result = self.invoke('--upgrade', ok=False)
        self.assertIn('Host allowlist mismatch', result.stderr)
        self.assertEqual(self.inventory(), before)

    def test_uninstall_keeps_task_private_data_and_disables_plugin(self):
        self.invoke()
        private = self.seed_private_data()
        self.invoke('--uninstall', '--yes')
        self.assertFalse(self.plugin.exists())
        self.assertFalse(self.extension.exists())
        self.assertFalse((self.data / HOST).exists())
        self.assertFalse((self.data / 'host-config.json').exists())
        self.assertFalse(any(path.exists() for path in self.manifests))
        self.assert_private_kept(private)
        self.assertEqual(json.loads((self.root / 'commands.jsonl').read_text().splitlines()[-1])[3], 'disable')

    def test_purge_removes_private_data_but_retains_program_backup(self):
        self.old_install()
        self.invoke('--upgrade')
        self.invoke('--uninstall', '--purge', '--yes')
        self.assertFalse(self.data.exists())
        self.assertTrue((self.hermes / 'plugin-backups').is_dir())

    def test_uninstall_requires_y_and_verbose_lists_paths_before_confirmation(self):
        self.invoke()
        before = self.inventory()
        result = self.invoke('--uninstall', '--verbose', stdin='n\n')
        self.assertIn(str(self.plugin), result.stdout)
        self.assertIn('Confirm deletion?', result.stdout)
        self.assertIn('Cancelled', result.stdout)
        self.assertEqual(self.inventory(), before)
        self.invoke('--uninstall', stdin='y\n')
        self.assertFalse(self.plugin.exists())

    def test_dry_run_first_install_writes_nothing(self):
        before = self.inventory()
        self.invoke('--dry-run', env={'TEST_VERSION_WRITES': '1'})
        self.assertEqual(self.inventory(), before)

    def test_dry_run_upgrade_and_uninstall_write_nothing(self):
        self.old_install()
        for args in (('--upgrade',), ('--uninstall', '--purge')):
            with self.subTest(args=args):
                before = self.inventory()
                self.invoke(*args, '--dry-run')
                self.assertEqual(self.inventory(), before)

    def test_explicit_home_options_override_environment(self):
        self.invoke('--user-home', str(self.home), '--hermes-home', str(self.hermes),
                    env={'HOME': str(self.root / 'unused-home'), 'HERMES_HOME': str(self.root / 'unused-hermes')})
        self.assertTrue(self.plugin.exists())
        self.assertFalse((self.root / 'unused-hermes').exists())
        self.assertFalse((self.root / 'unused-home').exists())

    def test_profile_shaped_hermes_home_matches_actual_cli_root_resolution(self):
        # 中文注释：当前 profile 环境不能让显式 default 启用和安装目标指向不同根目录。
        named = self.hermes / 'profiles/work'
        named.mkdir(parents=True)
        result = self.invoke(env={'HERMES_HOME': str(named)})
        self.assertTrue((self.plugin / 'plugin.yaml').is_file())
        self.assertFalse((named / 'plugins/browser-link').exists())
        self.assertEqual(json.loads((self.root / 'commands.jsonl').read_text())[1], 'default')
        self.assertIn('profiles: default', result.stdout)

    def test_missing_python_message(self):
        (self.bin / 'python3').unlink()
        result = self.invoke(ok=False)
        self.assertIn('python3 missing', result.stderr)
        self.assertIn('3.11+', result.stderr)
        self.assertFalse(self.plugin.exists())

    def test_help_explains_first_install_defaults_without_writes(self):
        before = self.inventory()
        result = self.invoke('--help')
        help_text = ' '.join(result.stdout.split())
        self.assertIn('Release ZIP: no Node.js', help_text)
        self.assertIn('default', help_text)
        self.assertIn('repeat for multiple profiles', help_text)
        self.assertIn('does not uninstall', help_text)
        self.assertEqual(self.inventory(), before)

    def test_old_python_message(self):
        (self.bin / 'python3').unlink()
        self.stub('python3', '#!/bin/sh\nexit 1\n')
        result = self.invoke(ok=False)
        self.assertIn('Python too old', result.stderr)
        self.assertFalse(self.plugin.exists())

    def test_missing_hermes_message(self):
        (self.bin / 'hermes').unlink()
        result = self.invoke(ok=False)
        self.assertIn('hermes missing', result.stderr)
        self.assertIn('安装 Hermes', result.stderr)

    def test_old_hermes_installs_with_one_advisory_and_short_output(self):
        # 中文注释：低版本提示不拦安装；PATH 中无 rg/git，启用动作仍真实经过安装入口。
        result = self.invoke('--wait-seconds', '1', env={'TEST_HERMES_VERSION': 'hermes 0.21.3',
                             'TEST_CONNECT_AT': '1', 'TEST_DESKTOP_RUNNING': '0'})
        self.assertTrue((self.plugin / 'plugin.yaml').is_file())
        self.assertNotIn('requires_hermes:', (self.plugin / 'plugin.yaml').read_text())
        self.assertEqual(sum('提示 / Note:' in line for line in result.stdout.splitlines()), 1)
        self.assertIn('Program installed and enabled', result.stdout)
        self.assertLessEqual(len(result.stdout.splitlines()), 10)
        self.assertNotIn(str(self.plugin), result.stdout)
        self.assertNotIn('fixed ID', result.stdout)

    def test_verbose_prints_internal_directories(self):
        # 中文注释：用户加载扩展所需路径始终保留；其余内部目录按需显示。
        result = self.invoke('--verbose')
        self.assertIn(str(self.plugin), result.stdout)
        self.assertIn(str(self.hermes), result.stdout)

    def test_upgrade_success_output_stays_within_ten_lines(self):
        self.old_install()
        self.stub('open', '#!/bin/sh\nexit 1\n')
        result = self.invoke('--upgrade', '--wait-seconds', '1', env={
            'TEST_HERMES_VERSION': 'hermes 0.21.3', 'TEST_CONNECT_AT': '1', 'TEST_DESKTOP_RUNNING': '0'})
        self.assertLessEqual(len(result.stdout.splitlines()), 10)
        self.assertNotIn(str(self.hermes / 'plugin-backups'), result.stdout)

    def test_unknown_hermes_does_not_use_release_date_or_python_version(self):
        # 中文注释：未知版本不阻止启用，也不能把日期或 Python 版本误当 Hermes 版本提示。
        result = self.invoke(env={'TEST_HERMES_VERSION': 'Hermes Agent vunknown (2026.9.24)\nPython: 3.14.6'})
        self.assertTrue(self.plugin.exists())
        self.assertNotIn('提示 / Note:', result.stdout)
        self.assertIn('Program installed and enabled', result.stdout)

    def test_missing_browser_message(self):
        # 中文注释：屏蔽机器的 /Applications，只读错误测试不依赖真实已安装浏览器。
        spec = importlib.util.spec_from_file_location('test_install_cli', ROOT / 'scripts/install-cli.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        installer_spec = importlib.util.spec_from_file_location('test_install_executor', ROOT / 'scripts/install-executor.py')
        module.EXECUTOR = importlib.util.module_from_spec(installer_spec)
        installer_spec.loader.exec_module(module.EXECUTOR)
        # 中文注释：直接调用安装入口的夹具明确声明动作，遵守命令行解析后的完整契约。
        args = type('Args', (), {'user_home': self.home, 'hermes_home': self.hermes, 'upgrade': False, 'uninstall': False, 'dry_run': False})()
        with mock.patch.dict(os.environ, self.env), mock.patch.object(module, 'browsers_at', return_value=[]):
            with self.assertRaisesRegex(module.InstallError, 'Browser missing') as caught:
                module.run(args)
        self.assertIn('Chrome', caught.exception.fix)

    def test_non_macos_message(self):
        result = self.invoke(ok=False, env={'TEST_OS': 'Linux'})
        self.assertIn('macOS required', result.stderr)

    def test_source_missing_node_suggests_release(self):
        result = self.invoke('--dry-run', source=True, ok=False)
        self.assertIn('Node.js', result.stderr)
        self.assertIn('GitHub Release', result.stderr)
        self.assertFalse(self.plugin.exists())

    def test_source_dry_run_does_not_build(self):
        (self.bin / 'node').symlink_to(shutil.which('node'))
        before = self.inventory()
        self.invoke('--dry-run', source=True)
        self.assertEqual(self.inventory(), before)

    def test_source_automatically_packages_without_git_or_npm(self):
        (self.bin / 'node').symlink_to(shutil.which('node'))
        self.invoke(source=True)
        self.assertTrue((self.plugin / 'plugin.yaml').is_file())
        self.assertEqual((self.plugin / 'plugin.yaml').read_bytes(), (ROOT / 'executor-plugin/plugin.yaml').read_bytes())

    def test_fresh_four_profiles_share_one_regular_program_directory(self):
        names = ['default', 'work', 'disabled', 'unregistered']
        for name in names[1:]:
            (self.hermes / 'profiles' / name).mkdir(parents=True)
        self.invoke(*[arg for name in names for arg in ('--profile', name)])
        self.assertFalse(self.plugin.is_symlink())
        for name in names[1:]:
            reference = self.hermes / 'profiles' / name / 'plugins/browser-link'
            self.assertTrue(reference.is_symlink())
            self.assertEqual(os.readlink(reference), str(self.plugin))
            self.assertEqual(reference.resolve(), self.plugin)
        self.assertEqual((self.package / 'install-cli.py').read_bytes(),
                         (self.plugin / 'maintenance/install-cli.py').read_bytes())

    def test_mixed_unregistered_disabled_profiles_migrate_without_enabling_them(self):
        self.old_install()
        original = {}
        for name in ('default', 'copied', 'linked', 'disabled'):
            profile = self.hermes if name == 'default' else self.hermes / 'profiles' / name
            profile.mkdir(parents=True, exist_ok=True)
            config = profile / 'config.yaml'
            config.write_bytes(b'plugins:\n  browser-link: false\ncapabilities: [tools.override]\n')
            private = profile / 'plugin-data/profile-private'
            private.mkdir(parents=True)
            (private / 'keep').write_bytes(name.encode())
            original[config] = config.read_bytes()
            original[private / 'keep'] = (private / 'keep').read_bytes()
            if name == 'default':
                continue
            reference = profile / 'plugins/browser-link'
            reference.parent.mkdir()
            if name == 'linked':
                reference.symlink_to('../../../plugins/browser-link')
            else:
                shutil.copytree(self.plugin, reference)
        linked = self.hermes / 'profiles/linked/plugins/browser-link'
        readlink = os.readlink(linked)
        inode = linked.lstat().st_ino
        (self.hermes / 'profiles/new').mkdir()
        result = self.invoke('--upgrade', '--profile', 'new')
        self.assertIn('Program upgraded', result.stdout)
        self.assertIn('enabled: new', result.stdout)
        for path, contents in original.items():
            self.assertEqual(path.read_bytes(), contents)
        for name in ('copied', 'linked', 'disabled', 'new'):
            reference = self.hermes / 'profiles' / name / 'plugins/browser-link'
            self.assertTrue(reference.is_symlink())
            self.assertEqual(reference.resolve(), self.plugin)
        self.assertEqual(os.readlink(linked), readlink)
        self.assertEqual(linked.lstat().st_ino, inode)
        calls = [json.loads(line) for line in (self.root / 'commands.jsonl').read_text().splitlines()]
        self.assertEqual([args[1] for args in calls], ['default', 'new'])
        references = {name: (self.hermes / 'profiles' / name / 'plugins/browser-link').lstat().st_ino
                      for name in ('copied', 'linked', 'disabled', 'new')}
        self.invoke('--upgrade')
        for name, previous_inode in references.items():
            self.assertEqual((self.hermes / 'profiles' / name / 'plugins/browser-link').lstat().st_ino, previous_inode)
        self.assertEqual(len((self.root / 'commands.jsonl').read_text().splitlines()), 2)
        state = json.loads((self.data / 'install-state.json').read_text())
        self.assertEqual(set(state['profiles']), {'default', 'copied', 'linked', 'disabled', 'new'})
        self.invoke('--uninstall', '--yes')
        for name in references:
            self.assertFalse((self.hermes / 'profiles' / name / 'plugins/browser-link').is_symlink())

    def test_multiple_profiles_are_installed_enabled_upgraded_and_uninstalled(self):
        (self.hermes / 'profiles/work').mkdir(parents=True)
        result = self.invoke('--profile', 'default', '--profile', 'work', '--profile', 'work')
        self.assertIn('profiles: default, work', result.stdout)
        named = self.hermes / 'profiles/work/plugins/browser-link'
        self.assertTrue((named / 'plugin.yaml').is_file())
        calls = [json.loads(line) for line in (self.root / 'commands.jsonl').read_text().splitlines()]
        self.assertEqual([args[1] for args in calls], ['default', 'work'])
        self.invoke('--upgrade')
        self.assertTrue((named / 'plugin.yaml').is_file())
        self.invoke('--uninstall', '--yes')
        self.assertFalse(named.exists())

    def migration_fixture(self):
        private = self.old_install()
        copied = self.hermes / 'profiles/copied/plugins/browser-link'
        copied.parent.mkdir(parents=True)
        shutil.copytree(self.plugin, copied)
        linked = self.hermes / 'profiles/linked/plugins/browser-link'
        linked.parent.mkdir(parents=True)
        linked.symlink_to('../../../plugins/browser-link')
        (self.hermes / 'profiles/new').mkdir()
        configs = []
        for name in ('default', 'copied', 'linked', 'new'):
            profile = self.hermes if name == 'default' else self.hermes / 'profiles' / name
            config = profile / 'config.yaml'
            config.write_bytes(b'original capability and disabled settings\n')
            configs.append(config)
        return private, copied, linked, configs

    def assert_migration_restored(self, fixture):
        private, copied, linked, configs = fixture
        self.assertTrue(linked.is_symlink())
        self.assertEqual(os.readlink(linked), '../../../plugins/browser-link')
        self.assertTrue(copied.is_dir())
        self.assertFalse(copied.is_symlink())
        self.assertIn('version: 1.5.1', (copied / 'plugin.yaml').read_text())
        self.assertFalse((self.hermes / 'profiles/new/plugins/browser-link').exists())
        for config in configs:
            self.assertEqual(config.read_bytes(), b'original capability and disabled settings\n')
        self.assert_private_kept(private)
        backup = sorted((self.hermes / 'plugin-backups').iterdir())[-1]
        index = json.loads((backup / 'paths.json').read_text())
        row = next(row for row in index if row['path'] == str(linked))
        self.assertEqual(row.get('kind'), 'symlink')
        self.assertEqual(row.get('readlink'), '../../../plugins/browser-link')
        saved = Path(row['backup'])
        self.assertTrue(saved.is_symlink())
        self.assertEqual(os.readlink(saved), '../../../plugins/browser-link')

    def test_migration_activation_rollback_keeps_link_text_and_node_kind(self):
        fixture = self.migration_fixture()
        self.invoke('--upgrade', '--profile', 'new', ok=False, env={'TEST_ACTIVATE_FAIL': '1'})
        self.assert_migration_restored(fixture)

    def test_activation_cannot_replace_shared_reference_with_program_copy(self):
        fixture = self.migration_fixture()
        self.invoke('--upgrade', '--profile', 'new', ok=False, env={'TEST_REPLACE_REFERENCE': '1'})
        self.assert_migration_restored(fixture)

    def test_migration_filesystem_failure_points_restore_original_nodes(self):
        fixture = self.migration_fixture()
        stages = [('root install', 'shutil', 'copytree', str(self.plugin)),
                  ('extension install', 'shutil', 'copytree', str(self.extension)),
                  ('link creation', 'pathlib.Path', 'symlink_to', str(self.hermes / 'profiles/new/plugins/browser-link')),
                  ('state write', 'pathlib.Path', 'write_text', str(self.data / 'install-state.json'))]
        for stage, owner, method, destination in stages:
            with self.subTest(stage=stage):
                patch_code = f'''original = {owner}.{method}
failed = False
def fail_once(*args, **kwargs):
    global failed
    result = original(*args, **kwargs)
    target = args[1] if {method!r} == 'copytree' else args[0]
    if not failed and str(target) == {destination!r}:
        failed = True
        raise OSError('injected filesystem failure')
    return result
mock.patch.object({owner}, {method!r}, new=fail_once).start()'''
                result = self.invoke_fault(patch_code, '--upgrade', '--profile', 'new')
                self.assertIn('rolled back', result.stderr)
                self.assert_migration_restored(fixture)
        self.invoke('--upgrade', '--profile', 'new', ok=False, env={'TEST_CORRUPT': '1'})
        self.assert_migration_restored(fixture)

    def test_missing_profile_is_rejected_before_writes(self):
        before = self.inventory()
        result = self.invoke('--profile', 'work', ok=False)
        self.assertIn('Missing profile', result.stderr)
        self.assertEqual(self.inventory(), before)

    def test_symlink_capability_failure_has_no_target_changes_or_copy_fallback(self):
        (self.hermes / 'profiles/work').mkdir(parents=True)
        before = self.inventory()
        result = self.invoke_fault('mock.patch.object(pathlib.Path, "symlink_to", side_effect=OSError("unavailable")).start()',
                                   '--profile', 'work')
        self.assertIn('Symlink unavailable', result.stderr)
        self.assertEqual(self.inventory(), before)
        self.invoke('--profile', 'default', '--profile', 'work')
        before = self.inventory()
        result = self.invoke_fault('mock.patch.object(pathlib.Path, "symlink_to", side_effect=OSError("unavailable")).start()',
                                   '--upgrade')
        self.assertIn('Symlink unavailable', result.stderr)
        self.assertEqual(self.inventory(), before)

    def test_connection_wait_detects_doctor_and_desktop_is_reported(self):
        result = self.invoke('--wait-seconds', '3', env={'TEST_CONNECT_AT': '1', 'TEST_DESKTOP_RUNNING': '0'})
        self.assertIn('✅ 扩展已连接 / Extension connected', result.stdout)
        self.assertIn('Desktop is running', result.stdout)
        self.assertEqual((self.root / 'doctor-count').read_text(), '1')

    def test_connection_timeout_leaves_install_complete(self):
        result = self.invoke('--wait-seconds', '1')
        self.assertIn('No connection detected', result.stdout)
        self.assertIn('Browser connection not yet verified', result.stdout)
        self.assertIn('Check: ', result.stdout)
        self.assertTrue((self.plugin / 'plugin.yaml').is_file())

    def test_active_or_unknown_persisted_state_refuses_upgrade_and_uninstall_without_changes(self):
        self.old_install()
        cases = [json.dumps({'version': 1, 'tasks': [{'id': 'task', 'owner': 'synthetic', 'state': state}]})
                 for state in ('ready', 'paused', 'pending_approval', 'needs_sync', 'unrecognized')]
        cases += ['invalid json', json.dumps({'version': 2, 'tasks': []}),
                  json.dumps({'version': 1, 'tasks': [{'state': 'closed'}]}),
                  json.dumps({'version': 1, 'tasks': [{'id': 'task', 'owner': 'synthetic', 'state': 'closed',
                                                      'currentOperation': {'state': 'running'}}]})]
        cases += [json.dumps({'version': 1, 'tasks': [{'id': 'task', 'owner': 'synthetic', 'state': 'closed',
                                                      'cleanupState': state}]}) for state in ('pending', 'unknown', 'failed')]
        cases += [json.dumps({'version': 1, 'tasks': [{'id': 'task', 'owner': 'synthetic', 'state': 'closed',
                                                      'cleanupState': 'succeeded', 'currentOperation': {'state': state}}]})
                  for state in ('pending', 'unrecognized')]
        for payload in cases:
            (self.data / 'tasks.json').write_text(payload)
            for args in (('--upgrade',), ('--uninstall', '--yes')):
                with self.subTest(payload=payload, args=args):
                    before = self.inventory()
                    result = self.invoke(*args, ok=False)
                    self.assertIn('Task state is active or unknown', result.stderr)
                    self.assertEqual(self.inventory(), before)

    def test_orphan_bridge_socket_refuses_upgrade_without_changes(self):
        self.old_install()
        socket = self.data / 'bridge.sock'
        socket.write_bytes(b'unknown socket marker')
        socket.chmod(0o600)
        before = self.inventory()
        result = self.invoke('--upgrade', ok=False)
        self.assertIn('Cannot verify bridge process', result.stderr)
        self.assertEqual(self.inventory(), before)

    def test_daemon_lifecycle_lock_refuses_upgrade_before_any_changes(self):
        self.old_install()
        lock = self.data / 'daemon.lock'
        lock.touch(mode=0o600)
        with lock.open('r+') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = self.inventory()
            result = self.invoke('--upgrade', ok=False)
            self.assertIn('Bridge activity cannot be verified', result.stderr)
            self.assertEqual(self.inventory(), before)

    def test_stale_pid_with_live_unknown_socket_refuses_changes_without_signalling(self):
        self.old_install()
        pid = self.data / 'daemon.pid'
        pid.write_text('12345')
        pid.chmod(0o600)
        endpoint = str((self.data / 'bridge.sock').relative_to(self.root))
        previous_cwd = Path.cwd()
        try:
            # 中文注释：使用相对地址避开 macOS AF_UNIX 路径长度限制，仅在私有夹具中监听。
            os.chdir(self.root)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.settimeout(0.2)
                listener.bind(endpoint)
                listener.listen(1)
                (self.data / 'bridge.sock').chmod(0o600)
                for args in (('--upgrade',), ('--uninstall', '--yes')):
                    with self.subTest(args=args):
                        before = self.inventory()
                        result = self.invoke(*args, ok=False, env={'TEST_VERSION_WRITES': '1'})
                        self.assertIn('Cannot verify bridge process', result.stderr)
                        self.assertEqual(self.inventory(), before)
                        self.assertFalse((self.data / 'daemon.lock').exists())
                        guarded = self.invoke_fault(
                            'import socket\n'
                            'mock.patch.object(os, "kill", side_effect=AssertionError("must not signal")).start()\n'
                            'mock.patch.object(os, "killpg", side_effect=AssertionError("must not signal")).start()\n'
                            'mock.patch.object(socket.socket, "connect", side_effect=AssertionError("must not connect")).start()',
                            *args)
                        self.assertIn('Cannot verify bridge process', guarded.stderr)
                        self.assertNotIn('must not signal', guarded.stderr)
                        self.assertNotIn('must not connect', guarded.stderr)
                        self.assertEqual(self.inventory(), before)
                        with self.assertRaises(socket.timeout):
                            listener.accept()
                        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                            client.settimeout(1)
                            client.connect(endpoint)
                            connection, _ = listener.accept()
                            with connection:
                                connection.settimeout(1)
                                client.sendall(b'alive')
                                self.assertEqual(connection.recv(5), b'alive')
        finally:
            os.chdir(previous_cwd)

    def assert_named_refusal_has_no_writes(self, expected, *args):
        # 中文注释：审计真实写调用，不能用最终目录清单掩盖瞬时建链探测。
        before = self.inventory()
        parent = self.hermes / 'profiles/work/plugins'
        mtime = parent.stat().st_mtime_ns
        self.env['TEST_VERSION_WRITES'] = '1'
        result = self.invoke_fault('''import atexit, json, socket
changes = []
roots = (os.environ['HERMES_HOME'], os.environ['HOME'])
def target(value):
    return isinstance(value, (str, bytes)) and any(
        os.fsdecode(value) == root or os.fsdecode(value).startswith(root + '/') for root in roots)
def audit(event, args):
    if event in {'os.mkdir', 'os.symlink', 'os.remove', 'os.rmdir', 'os.rename', 'os.chmod'}:
        if any(target(value) for value in args):
            changes.append([event, [str(value) for value in args]])
    if event == 'open' and target(args[0]):
        if args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            changes.append([event, [str(value) for value in args]])
sys.addaudithook(audit)
atexit.register(lambda: print('AUDIT=' + json.dumps(changes), file=sys.stderr))
mock.patch.object(os, 'kill', side_effect=AssertionError('must not signal')).start()
mock.patch.object(os, 'killpg', side_effect=AssertionError('must not signal')).start()
mock.patch.object(socket.socket, 'connect', side_effect=AssertionError('must not connect')).start()
mock.patch.object(socket.socket, 'connect_ex', side_effect=AssertionError('must not connect')).start()
''', *args)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(expected, result.stderr)
        self.assertNotIn('must not signal', result.stderr)
        self.assertNotIn('must not connect', result.stderr)
        self.assertEqual(self.inventory(), before)
        self.assertFalse((self.hermes / 'version-cache').exists())
        self.assertFalse((self.hermes / 'plugin-backups').exists())
        events = json.loads(next(line[6:] for line in result.stderr.splitlines() if line.startswith('AUDIT=')))
        self.assertEqual(events, [], result.stderr)
        self.assertEqual(parent.stat().st_mtime_ns, mtime)

    def named_shared_reference(self):
        reference = self.hermes / 'profiles/work/plugins/browser-link'
        reference.parent.mkdir(parents=True)
        reference.symlink_to('../../../plugins/browser-link')

    def test_named_stale_pid_live_socket_refuses_before_probe_writes(self):
        self.old_install()
        self.named_shared_reference()
        pid = self.data / 'daemon.pid'
        pid.write_text('12345')
        pid.chmod(0o600)
        endpoint = str((self.data / 'bridge.sock').relative_to(self.root))
        previous_cwd = Path.cwd()
        try:
            # 中文注释：仅私有夹具监听，短相对路径保留 macOS 的安全长度边界。
            os.chdir(self.root)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(endpoint)
                listener.listen(1)
                listener.settimeout(0.1)
                (self.data / 'bridge.sock').chmod(0o600)
                inode = (self.data / 'bridge.sock').lstat().st_ino
                for args in (('--upgrade',), ('--uninstall', '--yes')):
                    with self.subTest(args=args):
                        self.assert_named_refusal_has_no_writes('Cannot verify bridge process', *args)
                        self.assertFalse((self.data / 'daemon.lock').exists())
                        self.assertEqual((self.data / 'bridge.sock').lstat().st_ino, inode)
                        with self.assertRaises(socket.timeout):
                            listener.accept()
                        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                            client.settimeout(1)
                            client.connect(endpoint)
                            connection, _ = listener.accept()
                            with connection:
                                client.sendall(b'alive')
                                connection.settimeout(1)
                                self.assertEqual(connection.recv(5), b'alive')
        finally:
            os.chdir(previous_cwd)

    def test_named_native_activity_refuses_before_probe_writes(self):
        self.old_install()
        self.named_shared_reference()
        tasks = self.data / 'tasks.json'
        original = tasks.read_bytes()
        cases = ['invalid json', json.dumps({'version': 2, 'tasks': []}),
                 json.dumps({'version': 1, 'tasks': [{'id': 'task', 'owner': 'synthetic', 'state': 'ready'}]})]
        for payload in cases:
            tasks.write_text(payload)
            for args in (('--upgrade',), ('--uninstall', '--yes')):
                with self.subTest(payload=payload, args=args):
                    self.assert_named_refusal_has_no_writes('Task state is active or unknown', *args)
                    self.assertFalse((self.data / 'daemon.lock').exists())
        tasks.write_bytes(original)
        pid = self.data / 'daemon.pid'
        pid.write_text('12345')
        pid.chmod(0o600)
        for process, expected in [('unrelated-process', 'Cannot verify bridge process'),
                                  (f'{sys.executable} {self.plugin}/native_bridge/daemon.py --home {self.hermes}',
                                   'Bridge is running')]:
            self.stub('ps', '#!/bin/sh\nprintf "%s\\n" ' + shlex.quote(process) + '\n')
            for args in (('--upgrade',), ('--uninstall', '--yes')):
                with self.subTest(process=process, args=args):
                    self.assert_named_refusal_has_no_writes(expected, *args)
                    self.assertFalse((self.data / 'daemon.lock').exists())
        pid.unlink()
        self.stub('ps', '#!/bin/sh\nexit 1\n')
        lock = self.data / 'daemon.lock'
        lock.touch(mode=0o600)
        with lock.open('r+') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for args in (('--upgrade',), ('--uninstall', '--yes')):
                with self.subTest(args=args, held_lock=True):
                    self.assert_named_refusal_has_no_writes('Bridge activity cannot be verified', *args)

    def test_stale_pid_without_socket_allows_upgrade(self):
        private = self.old_install()
        pid = self.data / 'daemon.pid'
        pid.write_text('12345')
        pid.chmod(0o600)
        self.assertFalse((self.data / 'bridge.sock').exists())
        self.invoke('--upgrade')
        self.assertIn(f'version: {VERSION}', (self.plugin / 'plugin.yaml').read_text())
        self.assertEqual(pid.read_text(), '12345')
        self.assertEqual(pid.stat().st_mode & 0o777, 0o600)
        self.assert_private_kept(private)

    def test_verified_live_daemon_refused_without_signalling_or_task_stop(self):
        self.old_install()
        pid = self.data / 'daemon.pid'
        pid.write_text('12345')
        pid.chmod(0o600)
        doctor = self.plugin / 'native_bridge/doctor.py'
        doctor.write_text('def probe(home): return {"ok": True}\n')
        self.stub('ps', '#!/bin/sh\nprintf "%s\\n" ' + shlex.quote(
                  f'{sys.executable} {self.plugin}/native_bridge/daemon.py --home {self.hermes}') + '\n')
        before = self.inventory()
        result = self.invoke_fault('mock.patch.object(os, "kill", side_effect=AssertionError("must not signal")).start()',
                                   '--upgrade')
        self.assertIn('Bridge is running', result.stderr)
        self.assertNotIn('must not signal', result.stderr)
        self.assertEqual(self.inventory(), before)

    def test_unknown_live_daemon_is_not_signalled_or_overwritten(self):
        self.old_install()
        pid = self.data / 'daemon.pid'
        pid.write_text('12345')
        pid.chmod(0o600)
        self.stub('ps', '#!/bin/sh\nprintf "unrelated-process\\n"\n')
        before = self.inventory()
        result = self.invoke('--upgrade', ok=False)
        self.assertIn('Cannot verify bridge process', result.stderr)
        self.assertEqual(self.inventory(), before)

    def test_unknown_reference_links_are_rejected_before_upgrade_or_uninstall(self):
        self.old_install()
        reference = self.hermes / 'profiles/unregistered/plugins/browser-link'
        reference.parent.mkdir(parents=True)
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_bytes(b'untouched')
        alias = self.root / 'chain'
        alias.symlink_to(self.plugin)
        for destination in (outside, self.root / 'missing', alias, self.root / 'other-hermes/plugins/browser-link',
                            self.hermes / 'missing/../plugins/browser-link'):
            reference.symlink_to(destination)
            for args in (('--upgrade',), ('--uninstall', '--yes')):
                with self.subTest(destination=destination, args=args):
                    before = self.inventory()
                    self.invoke(*args, ok=False)
                    self.assertEqual(self.inventory(), before)
            reference.unlink()

    def test_unregistered_desktop_only_copy_is_archived_without_enabling_profile(self):
        self.old_install()
        profile = self.hermes / 'profiles/desktop-only'
        desktop = profile / 'desktop-plugins/browser-link'
        desktop.mkdir(parents=True)
        (desktop / '.hermes-package.json').write_text(json.dumps({'package': 'browser-link'}))
        (desktop / 'plugin.js').write_bytes(b'old interface copy')
        config = profile / 'config.yaml'
        config.write_bytes(b'disabled profile capability settings')
        self.invoke('--upgrade')
        self.assertFalse(desktop.exists())
        self.assertEqual(config.read_bytes(), b'disabled profile capability settings')
        reference = profile / 'plugins/browser-link'
        self.assertTrue(reference.is_symlink())
        self.assertEqual(reference.resolve(), self.plugin)
        backup = next((self.hermes / 'plugin-backups').iterdir())
        index = json.loads((backup / 'paths.json').read_text())
        saved = next(Path(row['backup']) for row in index if row['path'] == str(desktop))
        self.assertEqual((saved / 'plugin.js').read_bytes(), b'old interface copy')
        self.assertEqual(len((self.root / 'commands.jsonl').read_text().splitlines()), 1)

    def test_root_and_profile_ancestor_links_are_rejected_before_changes(self):
        self.old_install()
        replacements = [(self.plugin, self.root / 'saved-root'),
                        (self.data, self.root / 'saved-data')]
        for path, saved in replacements:
            path.rename(saved)
            path.symlink_to(saved)
            for args in (('--upgrade',), ('--uninstall', '--yes')):
                with self.subTest(path=path, args=args):
                    before = self.inventory()
                    self.invoke(*args, ok=False)
                    self.assertEqual(self.inventory(), before)
            path.unlink()
            saved.rename(path)
        named = self.hermes / 'profiles/unregistered'
        named.mkdir(parents=True)
        (named / 'plugins').symlink_to(self.plugin.parent)
        for args in (('--upgrade',), ('--uninstall', '--yes')):
            before = self.inventory()
            self.invoke(*args, ok=False)
            self.assertEqual(self.inventory(), before)

    def test_unmerged_request_journal_refuses_upgrade_without_rewriting_private_data(self):
        self.old_install()
        journal = self.data / 'requests.jsonl'
        journal.write_bytes(b'{"incomplete": true}\n')
        journal.chmod(0o600)
        before = self.inventory()
        result = self.invoke('--upgrade', ok=False)
        self.assertIn('Task state is active or unknown', result.stderr)
        self.assertEqual(self.inventory(), before)

    def test_fresh_install_detects_unselected_unregistered_program_copy(self):
        copied = self.hermes / 'profiles/unregistered/plugins/browser-link'
        copied.parent.mkdir(parents=True)
        shutil.copytree(self.package / 'browser-link', copied)
        before = self.inventory()
        result = self.invoke(ok=False)
        self.assertIn('Already installed', result.stderr)
        self.assertEqual(self.inventory(), before)

    def test_backup_ancestor_link_refused_before_version_or_runtime_writes(self):
        self.old_install()
        outside = self.root / 'foreign-backups'
        outside.mkdir()
        (self.hermes / 'plugin-backups').symlink_to(outside)
        before = self.inventory()
        self.invoke('--upgrade', ok=False, env={'TEST_VERSION_WRITES': '1'})
        self.assertEqual(self.inventory(), before)

    def test_profile_config_link_is_rejected_before_uninstall_activation(self):
        self.invoke()
        config = self.hermes / 'config.yaml'
        config.unlink()
        outside = self.root / 'foreign-config'
        outside.write_bytes(b'foreign capabilities')
        config.symlink_to(outside)
        before = self.inventory()
        self.invoke('--uninstall', '--yes', ok=False)
        self.assertEqual(self.inventory(), before)

    def test_profile_private_data_link_is_rejected_before_upgrade(self):
        self.old_install()
        profile = self.hermes / 'profiles/work'
        profile.mkdir(parents=True)
        outside = self.root / 'foreign-data'
        outside.mkdir()
        (profile / 'plugin-data').symlink_to(outside)
        before = self.inventory()
        self.invoke('--upgrade', '--profile', 'work', ok=False)
        self.assertEqual(self.inventory(), before)

    def test_symlink_target_is_rejected_before_deletion(self):
        self.invoke()
        shutil.rmtree(self.extension)
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('keep')
        self.extension.symlink_to(outside)
        self.invoke('--uninstall', '--yes', ok=False)
        self.assertEqual((outside / 'keep').read_text(), 'keep')
        self.assertTrue(self.plugin.exists())

    def test_ctrl_c_skips_only_connection_wait(self):
        # 中文注释：真实向安装脚本发 SIGINT，确保只跳过轮询并仍打印授权操作提示。
        # 中文注释：终端 Ctrl+C 发给整个前台进程组；用独立会话模拟，避免轮询子进程在清理临时目录时仍在运行。
        process = subprocess.Popen([str(self.package / 'install.sh')], env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=self.root,
                                   start_new_session=True)
        def stop_group():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.addCleanup(stop_group)
        output = ''
        while True:
            line = process.stdout.readline()
            self.assertTrue(line, 'installer exited before the wait prompt')
            output += line
            if 'Waiting for extension' in line:
                break
        os.killpg(process.pid, signal.SIGINT)
        remaining, error = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 0, output + remaining + error)
        self.assertIn('Wait skipped', remaining)
        self.assertIn('Browser connection not yet verified', remaining)
        self.assertIn('Check: ', remaining)
        # 中文注释：跳过等待不等于连接成功，仍说明连接授权，不再要求切换访问模式。
        self.assertIn('Confirm browser connection authorization', remaining)
        self.assertNotIn('smart-approval', remaining)
        self.assertTrue((self.plugin / 'plugin.yaml').is_file())

    def test_first_activation_failure_restores_existing_profile_and_private_data(self):
        private = self.seed_private_data()
        profile = self.hermes / 'config.yaml'
        profile.write_text('original settings\n')
        self.invoke(ok=False, env={'TEST_ACTIVATE_FAIL': '1'})
        self.assertFalse(self.plugin.exists())
        self.assertFalse(self.extension.exists())
        self.assertFalse(any(path.exists() for path in self.manifests))
        self.assertEqual(profile.read_text(), 'original settings\n')
        self.assert_private_kept(private)

    def test_system_temporary_directory_aliases_use_canonical_target(self):
        # 中文注释：macOS 的 /tmp 和 /var 可为系统链接；隔离安装应解析到实际路径。
        alias = self.root / 'temp-alias'
        alias.symlink_to(self.root)
        self.invoke('--user-home', str(alias / 'user'), '--hermes-home', str(alias / 'hermes'))
        self.assertEqual((self.root / 'clipboard').read_text(), str(self.extension))
        self.assertTrue((self.plugin / 'plugin.yaml').is_file())

    def test_purge_requires_uninstall(self):
        result = self.invoke('--purge', ok=False)
        self.assertIn('--purge requires --uninstall', result.stderr)


if __name__ == '__main__':
    unittest.main()
