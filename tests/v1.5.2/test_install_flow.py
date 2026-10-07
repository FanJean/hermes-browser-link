"""中文注释：只操作临时 HOME 和打包快照，命令替身不访问真实 Hermes 或浏览器。"""
import hashlib
import argparse
import io
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
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
    def auto_update(self, *, busy=None, corrupt=False, fail=False):
        # 中文注释：以真实打包产物走完整下载校验及事务升级，网络和进程查询用替身。
        self.invoke()
        # 中文注释：写入标记，后台再调用 open/pbcopy 会覆盖它们，测试可以直接发现。
        (self.root / 'opened.json').write_text('browser-handoff-preserved')
        (self.root / 'clipboard').write_text('clipboard-preserved')
        module_spec = importlib.util.spec_from_file_location('flow_updater', ROOT / 'executor-plugin/maintenance/update.py')
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
        with mock.patch.dict(os.environ, {**self.env, 'TEST_ACTIVATE_FAIL': '1' if fail else '0'}), \
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

    def test_auto_update_defers_if_browser_reopens_during_download(self):
        self.auto_update(busy=[False, True])
        self.assertNotIn('version: 9.0.0', (self.plugin / 'plugin.yaml').read_text())
        self.assertEqual(json.loads((self.data / 'update-status.json').read_text())['status'], 'deferred')
        self.assertFalse((self.hermes / 'plugin-backups').exists())

    def test_auto_update_rejects_corrupt_inner_manifest_before_installing(self):
        with self.assertRaisesRegex(ValueError, '哈希不匹配'):
            self.auto_update(corrupt=True)
        self.assertNotIn('version: 9.0.0', (self.plugin / 'plugin.yaml').read_text())
        self.assertFalse((self.hermes / 'plugin-backups').exists())

    def test_auto_update_activation_failure_restores_previous_installation(self):
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
            path.write_text('synthetic task-private value')
            path.chmod(0o600)
        return {path.name: path.read_bytes() for path in self.data.iterdir() if path.name in ('tasks.json', 'private.txt', 'token')}

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

    def assert_private_kept(self, private):
        for name, contents in private.items():
            self.assertEqual((self.data / name).read_bytes(), contents)
            self.assertEqual((self.data / name).stat().st_mode & 0o777, 0o600)

    def inventory(self):
        # 中文注释：记录内容与权限，dry-run 不得生成临时输出、日志、剪贴板文件或缓存。
        return {str(path.relative_to(self.root)): (path.stat().st_mode, path.read_bytes() if path.is_file() else None)
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

    def test_repeat_install_directs_upgrade_without_changing_files(self):
        self.invoke()
        before = self.inventory()
        result = self.invoke(ok=False)
        self.assertIn('./install.sh --upgrade', result.stderr)
        self.assertEqual(self.inventory(), before)

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
        result = self.invoke('--upgrade', ok=False, env={'TEST_CORRUPT': '1'})
        self.assertIn('rolled back', result.stderr)
        self.assertEqual((self.plugin / 'runtime.py').read_bytes(), old_plugin)
        self.assertEqual((self.extension / 'manifest.json').read_bytes(), old_extension)
        self.assertEqual((self.data / 'host-config.json').read_bytes(), old_config)
        self.assertEqual(profile_config.read_text(), 'original profile settings\n')
        self.assert_private_kept(private)

    def test_upgrade_activation_failure_rolls_back(self):
        self.old_install()
        result = self.invoke('--upgrade', ok=False, env={'TEST_ACTIVATE_FAIL': '1'})
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
        self.invoke(env={'HERMES_HOME': str(named)})
        self.assertTrue((self.plugin / 'plugin.yaml').is_file())
        self.assertFalse((named / 'plugins/browser-link').exists())
        self.assertEqual(json.loads((self.root / 'commands.jsonl').read_text())[1], 'default')

    def test_missing_python_message(self):
        (self.bin / 'python3').unlink()
        result = self.invoke(ok=False)
        self.assertIn('python3 missing', result.stderr)
        self.assertIn('3.11+', result.stderr)
        self.assertFalse(self.plugin.exists())

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

    def test_multiple_profiles_are_installed_enabled_upgraded_and_uninstalled(self):
        (self.hermes / 'profiles/work').mkdir(parents=True)
        self.invoke('--profile', 'default', '--profile', 'work', '--profile', 'work')
        named = self.hermes / 'profiles/work/plugins/browser-link'
        self.assertTrue((named / 'plugin.yaml').is_file())
        calls = [json.loads(line) for line in (self.root / 'commands.jsonl').read_text().splitlines()]
        self.assertEqual([args[1] for args in calls], ['default', 'work'])
        self.invoke('--upgrade')
        self.assertTrue((named / 'plugin.yaml').is_file())
        self.invoke('--uninstall', '--yes')
        self.assertFalse(named.exists())

    def test_missing_profile_is_rejected_before_writes(self):
        before = self.inventory()
        result = self.invoke('--profile', 'work', ok=False)
        self.assertIn('Missing profile', result.stderr)
        self.assertEqual(self.inventory(), before)

    def test_connection_wait_detects_doctor_and_desktop_is_reported(self):
        result = self.invoke('--wait-seconds', '3', env={'TEST_CONNECT_AT': '1', 'TEST_DESKTOP_RUNNING': '0'})
        self.assertIn('✅ 扩展已连接 / Extension connected', result.stdout)
        self.assertIn('Desktop is running', result.stdout)
        self.assertEqual((self.root / 'doctor-count').read_text(), '1')

    def test_connection_timeout_leaves_install_complete(self):
        result = self.invoke('--wait-seconds', '1')
        self.assertIn('No connection detected', result.stdout)
        self.assertTrue((self.plugin / 'plugin.yaml').is_file())

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
        # 中文注释：跳过等待后仍说明默认智能审批，无需操作开关切换为全部访问。
        self.assertIn('Keep the default smart-approval mode', remaining)
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
