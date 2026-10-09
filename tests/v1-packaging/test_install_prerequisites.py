"""Installer preflight in scratch only; never touch a personal installation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRATCH = Path.home() / '.hermes/cache/scratch'
ORIGIN = 'chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/'

spec = importlib.util.spec_from_file_location('release_installer_prerequisites', ROOT / 'scripts/install-executor.py')
assert spec is not None and spec.loader is not None
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallPrerequisitesTests(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='installer-prereq-', dir=SCRATCH)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # Keep the installer's temporary snapshot inside scratch as well.
        tempdir_patch = mock.patch.object(tempfile, 'tempdir', str(SCRATCH))
        tempdir_patch.start()
        self.addCleanup(tempdir_patch.stop)
        self.package = self.root / 'package'
        self.home = self.root / 'home'
        self.hermes = self.root / 'hermes'
        files = {
            # 当前桥接插件的必需文件由安装器逐一验证。
            'browser-link/plugin.yaml': 'name: browser-link\n',
            'browser-link/__init__.py': '# 插件入口\n',
            'browser-link/runtime.py': '# 租约与结果投影\n',
            'browser-link/native_tools.py': '# 原生工具\n',
            # 中文注释：安装事务执行真实注册描述；它只依赖 pathlib，不启动云端服务。
            'browser-link/cloud_link/registration.py': (ROOT / 'cloud-link/registration.py').read_text(encoding='utf8'),
            # 中文注释：夹具保留新增维护组件的完整运行闭包。
            'browser-link/maintenance/update.py': '# 更新入口\n',
            'browser-link/maintenance/install-cli.py': '# 安装入口\n',
            'browser-link/maintenance/install-executor.py': '# 安装校验器\n',
            'browser-link/open_tool.py': '# 打开工具\n',
            'browser-link/skills/use-my-browser/SKILL.md': '# Browser\n',
            'browser-link/script_lane/host_bridge.py': '# 桥接\n',
            'browser-link/script_lane/action_session.py': '# 会话\n',
            'browser-link/script_lane/child.py': '# 子进程\n',
            'browser-link/script_lane/tool.py': '# 工具\n',
            'browser-link/native_bridge/host.py': '# host\n',
            'browser-link/native_bridge/client.py': '# client\n',
            # 中文注释：当前包必须携带独立 Cookie 内存通道，夹具不省略运行模块。
            'browser-link/native_bridge/cookie_mirror.py': '# cookie channel\n',
            'browser-link/native_bridge/daemon.py': '# daemon\n',
            'browser-link/native_bridge/api_client.py': '# api\n',
            'browser-link/native_bridge/vault_client.py': '# vault client\n',
            'browser-link/native_bridge/vault_private.py': '# vault private\n',
            'browser-link/vault_adapter/__init__.py': '# vault\n',
            'browser-link/vault_adapter/adapter.py': '# vault adapter\n',
            'browser-link/vault_adapter/integration.py': '# vault integration\n',
            'browser-link/vault_adapter/official_source.py': '# vault source\n',
            'browser-link/native_bridge/browser_diagnostics/__init__.py': '# init\n',
            'browser-link/native_bridge/browser_diagnostics/schema.py': '# schema\n',
            'browser-link/native_bridge/browser_diagnostics/runtime.py': '# runtime\n',
            'browser-link/native_bridge/browser_diagnostics/sink.py': '# sink\n',
            'native-extension/manifest.json': json.dumps({'manifest_version': 3, 'background': {'service_worker': 'background.mjs'}}),
            'native-extension/background.mjs': '// background\n',
            'docs/python-scripting.md': '# Python scripting\n',
            'docs/CHANGELOG.md': '# Changelog\n',
            'LICENSE': 'fixture\n',
            'README.md': '# Installation\n',
            'INSTALL.txt': 'install\n',
            'RELEASE-STATUS.txt': 'NOT FROZEN: not a formal release\n',
            'install-executor.py': '# 安装器\n',
            'install-cli.py': '# 通用安装入口\n',
            'install.sh': '#!/bin/bash\n',
        }
        for name, text in files.items():
            path = self.package / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.rehash()

    def rehash(self):
        hashes = {p.relative_to(self.package).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in self.package.rglob('*') if p.is_file() and p.name != 'SHA256SUMS.json'}
        (self.package / 'SHA256SUMS.json').write_text(json.dumps(hashes))

    def install(self, apply=True):
        return installer.install(self.package, self.home, self.hermes, [ORIGIN],
                                 apply=apply)

    def assert_rejected_without_target_writes(self, expected):
        with self.assertRaisesRegex(ValueError, expected):
            self.install()
        self.assertFalse(self.home.exists(), 'installer wrote to user home before preflight')
        self.assertFalse(self.hermes.exists(), 'installer wrote to Hermes home before preflight')

    def test_corrupt_payload_rejected_before_writes(self):
        (self.package / 'browser-link/native_bridge/host.py').write_text('# corrupted after hashing\n')
        self.assert_rejected_without_target_writes('哈希不匹配.*host.py')

    def test_manifest_missing_listed_file_rejected_before_writes(self):
        (self.package / 'INSTALL.txt').unlink()
        self.assert_rejected_without_target_writes('SHA256SUMS.json')

    def test_malformed_manifest_rejected_before_writes(self):
        (self.package / 'SHA256SUMS.json').write_text('{bad json')
        self.assert_rejected_without_target_writes('SHA256SUMS.json')

    def test_manifest_traversal_rejected_before_writes(self):
        manifest = json.loads((self.package / 'SHA256SUMS.json').read_text())
        manifest['../outside'] = '0' * 64
        (self.package / 'SHA256SUMS.json').write_text(json.dumps(manifest))
        self.assert_rejected_without_target_writes('SHA256SUMS.json')

    def test_package_symlink_rejected_before_writes(self):
        (self.package / 'browser-link/other.py').symlink_to('runtime.py')
        self.rehash()
        self.assert_rejected_without_target_writes('符号链接')

    def test_missing_package_rejected_before_writes(self):
        self.package.rename(self.root / 'removed-package')
        self.assert_rejected_without_target_writes('plugin.yaml')

    def test_valid_package_plan_and_isolated_apply(self):
        plan = self.install(apply=False)
        self.assertEqual(plan['status'], 'plan')
        self.assertFalse(self.home.exists())
        self.assertFalse(self.hermes.exists())
        result = self.install(apply=True)
        self.assertEqual(result['status'], 'installed_disabled')
        installed = self.hermes / 'plugins/browser-link'
        self.assertEqual((installed / 'native_bridge/browser_diagnostics/sink.py').read_bytes(),
                         (self.package / 'browser-link/native_bridge/browser_diagnostics/sink.py').read_bytes())
        self.assertIn(str(installed / 'native_bridge/host.py'), Path(result['host']).read_text())
        for path in result['manifests']:
            self.assertEqual(json.loads(Path(path).read_text())['allowed_origins'], [ORIGIN])
        with self.assertRaises(FileExistsError):
            self.install(apply=True)

    def test_symlinked_plugins_ancestor_cannot_redirect_install_outside_hermes(self):
        foreign = self.root / 'foreign'
        foreign.mkdir()
        self.hermes.mkdir()
        (self.hermes / 'plugins').symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, '符号链接'):
            self.install()
        self.assertEqual(list(foreign.iterdir()), [])
        self.assertFalse((self.hermes / 'plugin-data').exists())
        self.assertFalse(self.home.exists())

    def test_symlinked_user_home_is_rejected_before_writes(self):
        foreign = self.root / 'foreign-user'
        foreign.mkdir()
        self.home.symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, '符号链接'):
            self.install()
        self.assertEqual(list(foreign.iterdir()), [])
        self.assertFalse(self.hermes.exists())

    def test_symlinked_hermes_home_is_rejected_before_writes(self):
        foreign = self.root / 'foreign-hermes'
        foreign.mkdir()
        self.hermes.symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, '符号链接'):
            self.install()
        self.assertEqual(list(foreign.iterdir()), [])
        self.assertFalse(self.home.exists())

    def test_existing_data_directory_mode_survives_late_failure(self):
        data = self.hermes / 'plugin-data/browser-link-native'
        data.mkdir(parents=True)
        data.chmod(0o755)
        self.addCleanup(data.chmod, 0o700)
        real_dump = installer.json.dump

        def fail_config_write(value, stream, *args, **kwargs):
            if value == {'allowedOrigins': [ORIGIN]}:
                raise OSError('injected config failure')
            return real_dump(value, stream, *args, **kwargs)

        with mock.patch.object(installer.json, 'dump', side_effect=fail_config_write):
            with self.assertRaisesRegex(OSError, 'injected config failure'):
                self.install()
        self.assertEqual(stat.S_IMODE(data.stat().st_mode), 0o755)
        self.assertEqual(list(data.iterdir()), [])
        self.assertFalse((self.hermes / 'plugins/browser-link').exists())
        self.assertFalse(self.home.exists())

    def test_source_change_after_verification_does_not_change_installed_bytes(self):
        host = self.package / 'browser-link/native_bridge/host.py'
        expected = host.read_bytes()
        original_verify = installer.verify_package

        def mutate_after_verify(package):
            result = original_verify(package)
            host.write_bytes(b'# tampered after verification\n')
            return result

        with mock.patch.object(installer, 'verify_package', side_effect=mutate_after_verify):
            self.install()
        installed = self.hermes / 'plugins/browser-link/native_bridge/host.py'
        self.assertEqual(installed.read_bytes(), expected)
        self.assertNotEqual(host.read_bytes(), expected)

    def test_partial_install_copy_failure_removes_target(self):
        target = self.hermes / 'plugins/browser-link'
        real_copytree = installer.shutil.copytree

        def fail_after_partial_copy(src, dst, *args, **kwargs):
            if Path(dst) == target:
                dst.mkdir(parents=True, exist_ok=True)
                (dst / 'partial.txt').write_text('partial')
                raise OSError('injected copy failure')
            return real_copytree(src, dst, *args, **kwargs)

        with mock.patch.object(installer.shutil, 'copytree', side_effect=fail_after_partial_copy):
            with self.assertRaisesRegex(OSError, 'injected copy failure'):
                self.install()
        self.assertFalse(target.exists())
        self.assertFalse((self.hermes / 'plugin-data').exists())
        self.assertFalse(self.hermes.exists(), 'failure left installer-created directories')
        self.assertFalse(self.home.exists())

    def test_corrupt_target_after_copy_is_detected_and_removed(self):
        target = self.hermes / 'plugins/browser-link'
        real_copytree = installer.shutil.copytree

        def corrupt_target(src, dst, *args, **kwargs):
            result = real_copytree(src, dst, *args, **kwargs)
            if Path(dst) == target:
                (target / 'native_bridge/host.py').write_bytes(b'# corrupted during copy\n')
            return result

        with mock.patch.object(installer.shutil, 'copytree', side_effect=corrupt_target):
            with self.assertRaisesRegex(ValueError, '哈希不匹配.*host.py'):
                self.install()
        self.assertFalse(target.exists())
        self.assertFalse((self.hermes / 'plugin-data').exists())
        self.assertFalse(self.home.exists())

    def test_partial_config_write_failure_removes_created_artifacts(self):
        real_dump = installer.json.dump

        def fail_config_write(value, stream, *args, **kwargs):
            if value == {'allowedOrigins': [ORIGIN]}:
                stream.write('{')
                raise OSError('injected config failure')
            return real_dump(value, stream, *args, **kwargs)

        with mock.patch.object(installer.json, 'dump', side_effect=fail_config_write):
            with self.assertRaisesRegex(OSError, 'injected config failure'):
                self.install()
        self.assertFalse((self.hermes / 'plugins/browser-link').exists())
        self.assertFalse((self.hermes / 'plugin-data/browser-link-native/host-config.json').exists())
        self.assertFalse((self.hermes / 'plugin-data/browser-link-native' / installer.HOST).exists())
        self.assertFalse(self.home.exists())

    def test_casefold_colliding_manifest_names_rejected_before_writes(self):
        manifest_path = self.package / 'SHA256SUMS.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['browser-link/PLUGIN.yaml'] = manifest['browser-link/plugin.yaml']
        manifest_path.write_text(json.dumps(manifest))
        self.assert_rejected_without_target_writes('归一化冲突')

    def test_unicode_colliding_manifest_names_rejected_before_writes(self):
        payload = self.package / 'browser-link/café.py'
        payload.write_text('# unicode\n')
        self.rehash()
        manifest_path = self.package / 'SHA256SUMS.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['browser-link/cafe\u0301.py'] = manifest['browser-link/café.py']
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False))
        self.assert_rejected_without_target_writes('归一化冲突')

    def test_duplicate_manifest_keys_rejected_before_writes(self):
        manifest = json.loads((self.package / 'SHA256SUMS.json').read_text())
        name = 'browser-link/plugin.yaml'
        (self.package / 'SHA256SUMS.json').write_text(
            '{' + json.dumps(name) + ':' + json.dumps(manifest[name]) + ','
            + json.dumps(manifest)[1:])
        self.assert_rejected_without_target_writes('SHA256SUMS.json')

    def test_unlisted_payload_rejected_before_writes(self):
        (self.package / 'browser-link/extra.py').write_text('# unlisted\n')
        self.assert_rejected_without_target_writes('SHA256SUMS.json')

    def test_native_extension_manifest_missing_rejected_before_writes(self):
        (self.package / 'native-extension/manifest.json').unlink()
        self.rehash()
        self.assert_rejected_without_target_writes('native-extension/manifest.json')

    def test_native_extension_entry_traversal_rejected_before_writes(self):
        path = self.package / 'native-extension/manifest.json'
        path.write_text(json.dumps({'background': {'service_worker': '../INSTALL.txt'}}))
        self.rehash()
        self.assert_rejected_without_target_writes('native-extension 入口')

    def test_missing_native_extension_entry_rejected_before_writes(self):
        (self.package / 'native-extension/background.mjs').unlink()
        self.rehash()
        self.assert_rejected_without_target_writes('background.mjs')

    def test_missing_checksum_manifest_rejected_before_writes(self):
        (self.package / 'SHA256SUMS.json').unlink()
        self.assert_rejected_without_target_writes('SHA256SUMS.json')

    def test_missing_diagnostics_dependency_rejected_before_writes(self):
        (self.package / 'browser-link/native_bridge/browser_diagnostics/sink.py').unlink()
        self.rehash()
        self.assert_rejected_without_target_writes('sink.py')


if __name__ == '__main__':
    unittest.main()


class ReleaseStatusTests(unittest.TestCase):
    """中文注释：安装器只接受开发候选声明，或打包器 --release 写出的含提交正式发布声明。"""

    def status(self, text):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as folder:
            (Path(folder) / 'RELEASE-STATUS.txt').write_text(text, encoding='utf8')
            return installer.release_status(Path(folder))

    def test_candidate_and_formal_release_statuses(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.assertEqual(self.status('NOT FROZEN: V1.1 remains a development candidate, not a formal release.\n'),
                         'NOT FROZEN candidate only')
        self.assertEqual(self.status('RELEASE V1.1.0: formal release built from commit ' + 'a' * 40 + '. See notes.\n'),
                         'RELEASE V1.1.0')

    def test_unmarked_or_malformed_release_rejected(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        for text in ('V1.1 release\n', 'RELEASE V1.1.0: formal release built from commit abc. \n',
                     # 中文注释：正式版本不再锁定 1.x；负例使用非法的前导零版本号。
                     'RELEASE V02.0.0: formal release built from commit ' + 'a' * 40 + '. \n'):
            with self.assertRaisesRegex(ValueError, '状态声明'):
                self.status(text)
