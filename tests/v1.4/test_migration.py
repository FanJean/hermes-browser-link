"""中文注释：所有迁移调用只使用临时 HOME 和浏览器目录，不调用 CLI --apply。"""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('migration', ROOT / 'scripts/migrate-to-browser-link.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='link-migrate-', dir='/tmp')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.package = Path(cls.temp.name).resolve() / 'package'
        subprocess.run(['node', 'scripts/package-executor.mjs', '--output', str(cls.package)], cwd=ROOT, check=True, capture_output=True)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='link-test-', dir='/tmp')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve() / 'hermes'
        self.browsers = Path(self.temp.name).resolve() / 'browsers'
        self.old = self.home / 'plugin-data' / migration.LEGACY['native']
        self.old.mkdir(parents=True, mode=0o700)
        (self.old / 'vault-token').write_text('synthetic-token')
        (self.old / 'vault-token').chmod(0o600)
        # 中文注释：任务授权、owner、诊断与插件数据必须逐字节迁移，不能只保存令牌。
        self.persistent = {
            'tasks.json': b'{"tasks":[{"id":"synthetic","owner":"owner-a","allowedOrigins":["https://example.test"]}]}',
            'owner': b'owner-a', 'diagnostics/events.jsonl': b'{"event":"synthetic"}\n',
        }
        for name, value in self.persistent.items():
            file = self.old / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(value)
            file.chmod(0o600)
        plugin_data = self.home / 'plugin-data' / migration.LEGACY['plugin']
        plugin_data.mkdir(mode=0o700)
        (plugin_data / 'records.json').write_text('{}')
        self.config = self.home / 'config.yaml'
        self.raw = ('# 保留注释\r\nplugins:\r\n  enabled: [other, "' + migration.LEGACY['plugin'] + '"] # unchanged\r\n  entries:\r\n    ' + migration.LEGACY['plugin'] + ':\r\n      enabled: true\r\nother: "keep"\r\n').encode()
        self.config.write_bytes(self.raw)
        self.config.chmod(0o640)
        profile = self.home / 'profiles/work/config.yaml'
        profile.parent.mkdir(parents=True)
        profile.write_bytes(self.raw)
        for browser in migration.BROWSERS:
            host = self.browsers / browser / 'NativeMessagingHosts' / (migration.LEGACY['host'] + '.json')
            host.parent.mkdir(parents=True)
            host.write_text('{}')

    def run_migration(self, apply=False):
        with patch.dict(os.environ, {'HERMES_HOME': str(self.home)}):
            return migration.migrate(self.package, self.home, self.browsers, apply=apply)

    def test_dry_run_changes_nothing(self):
        before = sorted(str(p) for p in Path(self.temp.name).rglob('*'))
        with patch.object(migration, 'stop_daemon', side_effect=AssertionError('must not stop')):
            self.assertEqual(self.run_migration()['status'], 'dry_run')
        self.assertEqual(before, sorted(str(p) for p in Path(self.temp.name).rglob('*')))
        self.assertEqual(self.config.read_bytes(), self.raw)

    def test_migrate_permissions_profiles_and_idempotence(self):
        result = self.run_migration(True)
        self.assertEqual(result['status'], 'migrated')
        self.assertFalse(self.old.exists())
        token = self.home / 'plugin-data/browser-link-native/vault-token'
        self.assertEqual(token.read_text(), 'synthetic-token')
        self.assertEqual(token.stat().st_mode & 0o777, 0o600)
        for name, value in self.persistent.items():
            copied = token.parent / name
            self.assertEqual(copied.read_bytes(), value)
            self.assertEqual(copied.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.home / 'plugin-data/browser-link/records.json').read_text(), '{}')
        self.assertEqual(token.parent.stat().st_mode & 0o777, 0o700)
        expected = self.raw.replace(migration.LEGACY['plugin'].encode(), b'browser-link')
        self.assertEqual(self.config.read_bytes(), expected)
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o640)
        self.assertEqual((self.home / 'profiles/work/config.yaml').read_bytes(), expected)
        self.assertTrue((Path(result['backup']) / 'restore-map.json').exists())
        self.assertEqual(self.run_migration(True)['status'], 'already_migrated')

    def test_profile_plugin_symlink_moves_and_reports_gateway_restart(self):
        # 中文注释：只迁移精确指向旧插件的链接，其他 profile 链接保持原样。
        plugins = self.home / 'profiles/work/plugins'
        plugins.mkdir()
        legacy = plugins / migration.LEGACY['plugin']
        legacy.symlink_to(self.home / 'plugins' / migration.LEGACY['plugin'])
        other = plugins / 'other'
        other.symlink_to(self.home / 'plugins/other')
        preview = self.run_migration()
        self.assertTrue(preview['gatewayRestartRequired'])
        self.assertEqual(len(preview['profileLinks']), 1)
        result = self.run_migration(True)
        self.assertEqual(result['status'], 'migrated')
        self.assertFalse(legacy.is_symlink())
        self.assertEqual((plugins / 'browser-link').resolve(), self.home / 'plugins/browser-link')
        self.assertTrue(other.is_symlink())

    def test_already_migrated_install_repairs_old_profile_link(self):
        self.run_migration(True)
        plugins = self.home / 'profiles/work/plugins'
        plugins.mkdir()
        old = plugins / migration.LEGACY['plugin']
        old.symlink_to(self.home / 'plugins' / migration.LEGACY['plugin'])
        self.assertEqual(self.run_migration()['status'], 'profile_links_pending')
        result = self.run_migration(True)
        self.assertEqual(result['status'], 'profile_links_repaired')
        self.assertTrue(result['gatewayRestartRequired'])
        self.assertFalse(old.is_symlink())
        self.assertTrue((plugins / 'browser-link').is_symlink())

    def test_verification_failure_restores_files(self):
        with patch.object(migration, 'verify', side_effect=ValueError('injected')):
            with self.assertRaisesRegex(RuntimeError, '已回滚'):
                self.run_migration(True)
        self.assertEqual(self.config.read_bytes(), self.raw)
        self.assertTrue((self.old / 'vault-token').exists())
        self.assertFalse((self.home / 'plugins/browser-link').exists())
        self.assertFalse((self.home / 'browser-link-releases').exists())
        self.assertEqual(self.run_migration(True)['status'], 'migrated')

    def test_stop_failure_leaves_old_installation(self):
        with patch.object(migration, 'stop_daemon', side_effect=ValueError('identity refused')):
            with self.assertRaisesRegex(RuntimeError, 'identity refused'):
                self.run_migration(True)
        self.assertEqual(self.config.read_bytes(), self.raw)
        self.assertTrue(self.old.exists())

    def test_existing_target_and_symlink_rejected(self):
        target = self.home / 'plugins/browser-link'
        target.parent.mkdir()
        target.symlink_to(self.old, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, '符号链接'):
            self.run_migration(True)
        self.assertTrue((self.old / 'vault-token').exists())

    def test_socket_not_copied(self):
        # 中文注释：只在沙箱允许绑定 Unix socket 时验证真实套接字跳过。
        sock = socket.socket(socket.AF_UNIX)
        self.addCleanup(sock.close)
        try:
            sock.bind(str(self.old / 'test.sock'))
        except PermissionError:
            self.skipTest('sandbox cannot bind Unix socket')
        result = self.run_migration(True)
        self.assertFalse((self.home / 'plugin-data/browser-link-native/test.sock').exists())
        self.assertFalse(any(p.name == 'test.sock' for p in Path(result['backup']).rglob('*')))

    def test_config_only_plugin_keys_and_values(self):
        old = migration.LEGACY['plugin']
        raw = f'# {old}\nplugins:\n  enabled:\n    - \'{old}\' # {old}\n  entries:\n    "{old}": {{}}\ntext: {old}\n'.encode()
        expected = f'# {old}\nplugins:\n  enabled:\n    - \'browser-link\' # {old}\n  entries:\n    "browser-link": {{}}\ntext: {old}\n'.encode()
        self.assertEqual(migration.rewrite_config(raw), expected)

    def test_failure_after_config_and_first_retirement_rolls_back(self):
        # 中文注释：在归档中途注入失败，验证已经改写的配置和已移走目录均恢复。
        original = Path.rename
        retired_count = 0
        def fail_second(path, destination):
            nonlocal retired_count
            if destination.parent.name == 'retired':
                retired_count += 1
                if retired_count == 2:
                    raise OSError('retirement failed')
            return original(path, destination)
        with patch.object(Path, 'rename', fail_second):
            with self.assertRaisesRegex(RuntimeError, '已回滚'):
                self.run_migration(True)
        self.assertEqual(self.config.read_bytes(), self.raw)
        self.assertTrue((self.old / 'vault-token').exists())
        self.assertFalse((self.home / 'plugins/browser-link').exists())
        self.assertEqual(self.run_migration(True)['status'], 'migrated')

    def test_config_indentless_list_and_conflict(self):
        old = migration.LEGACY['plugin']
        raw = f'plugins:\n  enabled:\n  - {old}\nother: unchanged\n'.encode()
        self.assertEqual(migration.rewrite_config(raw), raw.replace(old.encode(), b'browser-link'))
        with self.assertRaisesRegex(ValueError, '冲突'):
            migration.rewrite_config(f'# comment\nplugins:\n  entries:\n    {old}: {{}}\n    browser-link: {{}}\n'.encode())

    def test_fixed_origin_rejects_other_extension(self):
        with self.assertRaisesRegex(ValueError, '固定 ID'):
            migration.installer.install(self.package, self.browsers, self.home, ['chrome-extension://' + 'a' * 32 + '/'])


if __name__ == '__main__':
    unittest.main()
