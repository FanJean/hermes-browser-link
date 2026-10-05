"""中文注释：更新测试只用合成发布信息、内存 ZIP、临时 HOME 和命令替身。"""
import argparse
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('test_browser_link_updater', ROOT / 'executor-plugin/maintenance/update.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


def release_info(version='2.0.0'):
    # 中文注释：数据结构与 GitHub 正式发布 API 一致，不查询真实网络。
    return {'draft': False, 'prerelease': False, 'tag_name': f'v{version}', 'assets': [{
        'name': f'hermes-browser-link-{version}.zip', 'state': 'uploaded', 'size': 100,
        'digest': 'sha256:' + 'a' * 64,
        'browser_download_url': f'https://github.com/{updater.REPOSITORY}/releases/download/v{version}/hermes-browser-link-{version}.zip'}]}


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.cli = updater.installer_modules()
        self.home, self.user_home = self.root / 'hermes', self.root / 'user'
        plugin = self.home / 'plugins/browser-link'
        plugin.mkdir(parents=True)
        (plugin / 'plugin.yaml').write_text('version: 1.6.1\n')
        self.args = argparse.Namespace(hermes_home=self.home, user_home=self.user_home,
                                     check=False, automatic=False, schedule=None)

    def test_version_comparison_is_numeric_and_rejects_unstable_versions(self):
        self.assertGreater(updater.version_tuple('1.10.0'), updater.version_tuple('1.9.9'))
        for value in ('01.2.3', '1.2', '1.2.3-beta', 'v1.2.3', None):
            with self.assertRaises(ValueError):
                updater.version_tuple(value)

    def test_only_valid_stable_release_and_fixed_asset_are_accepted(self):
        document = release_info()
        with mock.patch.object(updater, 'fetch', return_value=json.dumps(document).encode()):
            self.assertEqual(updater.latest_release()['version'], '2.0.0')
        invalid = []
        for field, value in [('prerelease', True), ('draft', True), ('tag_name', 'v2.0.0-beta'), ('assets', [])]:
            invalid.append({**document, field: value})
        for field, value in [('digest', None), ('browser_download_url', 'https://evil.test/file.zip'),
                             ('size', updater.MAX_ARCHIVE + 1), ('size', True), ('state', 'new')]:
            invalid.append({**document, 'assets': [{**document['assets'][0], field: value}]})
        invalid.append({**document, 'assets': document['assets'] * 2})
        for value in invalid:
            with self.subTest(value=value), mock.patch.object(updater, 'fetch', return_value=json.dumps(value).encode()):
                with self.assertRaises(ValueError):
                    updater.latest_release()

    def test_no_stable_release_is_normal_but_rate_limit_is_error(self):
        for code in (404, 403):
            error = urllib.error.HTTPError(updater.API, code, '', {}, io.BytesIO())
            self.addCleanup(error.close)
            with mock.patch.object(updater, 'fetch', side_effect=error):
                if code == 404:
                    self.assertIsNone(updater.latest_release())
                else:
                    with self.assertRaises(urllib.error.HTTPError):
                        updater.latest_release()

    def archive(self, entries):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            for name, content in entries:
                archive.writestr(name, content)
        payload = stream.getvalue()
        return payload, {'version': '2.0.0', 'size': len(payload), 'digest': hashlib.sha256(payload).hexdigest()}

    def test_archive_integrity_and_valid_extraction(self):
        payload, release = self.archive([('hermes-browser-link-2.0.0/file.txt', 'valid')])
        target = updater.extract_archive(payload, release, self.root, self.cli.EXECUTOR)
        self.assertEqual((target / 'file.txt').read_text(), 'valid')
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            updater.extract_archive(payload + b'x', release, self.root, self.cli.EXECUTOR)

    def test_unsafe_archives_are_rejected(self):
        link = zipfile.ZipInfo('hermes-browser-link-2.0.0/link')
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        entries = [
            [('hermes-browser-link-2.0.0/../escape', 'bad')], [('/absolute', 'bad')],
            [('other-root/file', 'bad')], [('hermes-browser-link-2.0.0/a\\b', 'bad')],
            [(link, '../bad')], [('hermes-browser-link-2.0.0/A', '1'), ('hermes-browser-link-2.0.0/a', '2')],
        ]
        for index, values in enumerate(entries):
            folder = self.root / str(index)
            folder.mkdir()
            payload, release = self.archive(values)
            with self.subTest(index=index), self.assertRaises(ValueError):
                updater.extract_archive(payload, release, folder, self.cli.EXECUTOR)

    def test_check_only_same_version_and_older_release_never_install(self):
        for version, check, expected in [('2.0.0', True, 'available'), ('1.6.1', False, 'up_to_date'), ('1.0.0', False, 'up_to_date')]:
            self.args.check = check
            with mock.patch.object(updater, 'latest_release', return_value={'version': version}), \
                    mock.patch.object(updater, 'applications_running') as busy, mock.patch.object(self.cli, 'run') as install:
                self.assertEqual(updater.update(self.args, self.cli)['status'], expected)
                busy.assert_not_called()
                install.assert_not_called()

    def test_running_apps_defer_download_and_install(self):
        with mock.patch.object(updater, 'latest_release', return_value={'version': '2.0.0'}), \
                mock.patch.object(updater, 'applications_running', return_value=True), mock.patch.object(updater, 'fetch') as fetch:
            self.assertEqual(updater.update(self.args, self.cli)['status'], 'deferred')
            fetch.assert_not_called()

    def test_process_detection_includes_browser_helpers_desktop_and_cli(self):
        for line in ('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                     '/Applications/Microsoft Edge.app/Contents/Frameworks/Helper',
                     '/Applications/Hermes Desktop.app/Contents/MacOS/Hermes',
                     'python /repo/hermes_cli/main.py', '/bin/hermes chat'):
            with self.subTest(line=line), mock.patch.object(updater.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, line)):
                self.assertTrue(updater.applications_running())
        with mock.patch.object(updater.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '/bin/python /repo/hermes-browser-link/update.py')):
            self.assertFalse(updater.applications_running())
        with mock.patch.object(updater.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '')):
            with self.assertRaises(ValueError):
                updater.applications_running()

    def test_redirects_reject_http_credentials_and_other_hosts(self):
        handler = updater.GithubRedirect()
        request = urllib.request.Request('https://github.com/file')
        # 中文注释：合成 userinfo 分开构造，保留凭据 URL 负对照，不在公开源码里形成邮箱字面量。
        credential_url = 'https://' + 'user' + '@github.com/file'
        for target in ('http://github.com/file', 'https://evil.test/file', credential_url, 'https://github.com:8080/file'):
            with self.assertRaises(ValueError):
                handler.redirect_request(request, None, 302, '', {}, target)

    def test_schedule_uses_stable_path_hourly_and_captured_environment(self):
        path = self.home / 'plugins/browser-link/maintenance/update.py'
        path.parent.mkdir()
        path.write_text('# 中文注释：合成维护入口\n')
        with mock.patch.object(updater.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], 1), subprocess.CompletedProcess([], 0)]):
            updater.configure_schedule('install', self.home, self.user_home, self.cli)
        agent = updater.agent_path(self.home, self.user_home)
        document = plistlib.loads(agent.read_bytes())
        self.assertEqual(document['StartInterval'], 3600)
        self.assertIn(str(path), document['ProgramArguments'])
        self.assertNotIn('--check', document['ProgramArguments'])
        self.assertEqual(document['EnvironmentVariables']['PATH'], os.environ['PATH'])
        self.assertEqual(stat.S_IMODE(agent.stat().st_mode), 0o600)
        with mock.patch.object(updater.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0)]):
            updater.configure_schedule('off', self.home, self.user_home, self.cli)
        self.assertFalse(agent.exists())

    def test_failed_schedule_switch_restores_previous_job(self):
        path = self.home / 'plugins/browser-link/maintenance/update.py'
        path.parent.mkdir()
        path.touch()
        agent = updater.agent_path(self.home, self.user_home)
        agent.parent.mkdir(parents=True)
        agent.write_bytes(b'previous')
        with mock.patch.object(updater.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], 0),
                subprocess.CompletedProcess([], 0), subprocess.CalledProcessError(1, 'launchctl'), subprocess.CompletedProcess([], 0)]):
            with self.assertRaises(subprocess.CalledProcessError):
                updater.configure_schedule('check', self.home, self.user_home, self.cli)
        self.assertEqual(agent.read_bytes(), b'previous')

    def test_failed_check_persists_private_fixed_status(self):
        with mock.patch.object(updater, 'latest_release', side_effect=ValueError('private external content')):
            with self.assertRaises(ValueError):
                updater.run(self.args)
        path = self.home / 'plugin-data/browser-link-native/update-status.json'
        self.assertEqual(json.loads(path.read_text()), {'status': 'failed'})
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_concurrent_update_is_rejected_before_network_or_status_changes(self):
        # 中文注释：占用真实内核锁，验证更新和手动安装使用同一目录锁。
        data = self.home / 'plugin-data/browser-link-native'
        data.mkdir(parents=True)
        descriptor = os.open(data, os.O_RDONLY)
        self.addCleanup(os.close, descriptor)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with mock.patch.object(updater, 'latest_release') as latest, \
                mock.patch.object(updater, 'installer_modules', return_value=self.cli):
            with self.assertRaises(self.cli.InstallError):
                updater.run(self.args)
        latest.assert_not_called()
        self.assertEqual(list(data.iterdir()), [])

    def test_check_schedule_and_off_never_query_releases(self):
        entry = self.home / 'plugins/browser-link/maintenance/update.py'
        entry.parent.mkdir()
        entry.touch()
        self.args.schedule = 'check'
        with mock.patch.object(updater, 'latest_release') as latest, \
                mock.patch.object(updater.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], 1), subprocess.CompletedProcess([], 0)]):
            updater.run(self.args)
            latest.assert_not_called()
        document = plistlib.loads(updater.agent_path(self.home, self.user_home).read_bytes())
        self.assertIn('--check', document['ProgramArguments'])

    def test_symbolic_link_status_cannot_redirect_writes(self):
        data = self.home / 'plugin-data/browser-link-native'
        data.mkdir(parents=True)
        outside = self.root / 'outside'
        outside.write_text('preserved')
        (data / 'update-status.json').symlink_to(outside)
        with mock.patch.object(updater, 'latest_release') as latest:
            with self.assertRaisesRegex(ValueError, '符号链接'):
                updater.run(self.args)
        latest.assert_not_called()
        self.assertEqual(outside.read_text(), 'preserved')


if __name__ == '__main__':
    unittest.main()
