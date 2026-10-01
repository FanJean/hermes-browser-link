"""Offline package closure; no browser, credentials, or user installation."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRATCH = Path(os.environ.get('TMPDIR', str(Path.home() / '.hermes/cache/scratch')))
DIAG = Path('browser-diagnostics/python/browser_diagnostics')
FILES = ('__init__.py', 'schema.py', 'runtime.py', 'sink.py')
# 中文注释：版本预检也读取仓库根清单，负向夹具必须先满足正常打包输入。
INPUTS = ('package.json', 'executor-plugin', 'native-bridge', 'native-extension',
          'page-semantics', 'browser-interactions', 'approval-policy',
          'browser-workspaces', 'browser-diagnostics', 'scripts/install-executor.py',
          'docs/installation.md', 'docs/python-scripting.md',
          'CHANGELOG.md', 'LICENSE')
PROBE = r'''
import json, pathlib, stat, sys
# macOS 的 /tmp 可能是符号链接；先归一化路径再比较模块来源。
root, home = (pathlib.Path(value).resolve() for value in sys.argv[1:])
sys.path.insert(0, str(root)) # Only extracted package/isolated host-bin, never checkout.
import daemon, browser_diagnostics
from browser_diagnostics.schema import ALLOWED_EVENT_KEYS, UnsafeDiagnosticField
assert daemon.JsonlDiagnosticSink is not None, 'logger fallback is not acceptable'
for name, module in list(sys.modules.items()):
    if name == 'daemon' or name == 'api_client' or name.startswith('browser_diagnostics'):
        assert pathlib.Path(module.__file__).resolve().is_relative_to(root)
bridge = daemon.BridgeDaemon(home)
bridge._diagnostic('request_state', 'succeeded', request_id='packaging-probe', duration_ms=1)
assert bridge.diagnostics is not None
records = bridge.diagnostics.read_validated_events()
assert len(records) == 1 and records[0]['request_id'] == 'packaging-probe'
assert set(records[0]) == ALLOWED_EVENT_KEYS
try:
    bridge.diagnostics.write(dict(records[0], page_text='NONSECRET_PAGE_CONTENT_CANARY'))
except UnsafeDiagnosticField:
    pass
else:
    raise AssertionError('unknown diagnostic payload accepted')
assert bridge.diagnostics.read_validated_events() == records
log = bridge.data_dir / 'diagnostics/events.jsonl'
assert 'NONSECRET_PAGE_CONTENT_CANARY' not in log.read_text()
assert stat.S_IMODE(log.stat().st_mode) == 0o600
assert stat.S_IMODE(log.parent.stat().st_mode) == 0o700
assert json.loads(log.read_text()) == records[0]
print(json.dumps({'events': len(records), 'logger': browser_diagnostics.__file__}))
'''


class DiagnosticsClosureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='v1-packaging-', dir=SCRATCH)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / 'package'

    def package(self, source=ROOT):
        return subprocess.run(['node', str(ROOT / 'scripts/package-executor.mjs'),
                               '--source', str(source), '--output', str(self.output)],
                              capture_output=True, text=True, timeout=90)

    def build(self):
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        return self.output / 'browser-link/native_bridge'

    def probe(self, runtime, label):
        # 中文注释：只隔离 Hermes 数据，测试子进程保留用户 HOME。
        env = dict(os.environ, HERMES_HOME=str(self.root / 'hermes'))
        env.pop('PYTHONPATH', None)
        result = subprocess.run([sys.executable, '-I', '-B', '-c', PROBE,
                                 str(runtime), str(self.root / label)], cwd=self.root,
                                env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['events'], 1)

    def fixture(self):
        # 夹具只复制当前打包器读取的源文件，避免已删除引擎影响并发修改测试。
        source = self.root / 'source'
        for name in INPUTS:
            original, target = ROOT / name, source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if original.is_dir():
                shutil.copytree(original, target, ignore=shutil.ignore_patterns(
                    'node_modules', 'tests', 'test', 'evidence', '__pycache__', 'dist-native', '.git'))
            else:
                shutil.copyfile(original, target)
        return source

    def test_new_build_deps_cover_exact_vendor_and_hashes(self):
        self.build()
        sums = json.loads((self.output / 'SHA256SUMS.json').read_text())
        deps = json.loads((self.output / 'native-extension/BUILD-DEPS.json').read_text())['dependencies']
        expected = {'vendor/browser-workspaces.mjs', 'vendor/browser-diagnostics.mjs',
                    'vendor/approval-policy.mjs', 'vendor/page-semantics.mjs', 'vendor/page-parser.mjs',
                    'vendor/browser-interactions.mjs'}
        self.assertEqual(set(deps), expected)
        self.assertEqual({'vendor/' + p.name for p in (self.output / 'native-extension/vendor').iterdir()}, expected)
        for name, record in deps.items():
            digest = hashlib.sha256((self.output / 'native-extension' / name).read_bytes()).hexdigest()
            self.assertEqual(record['sha256'], digest)
            self.assertEqual(sums['native-extension/' + name], digest)
            self.assertEqual(hashlib.sha256((ROOT / record['source']).read_bytes()).hexdigest(), digest)
            self.assertEqual(sums.get('browser-link/' + record['source']), digest)
        for name, digest in sums.items():
            self.assertEqual(hashlib.sha256((self.output / name).read_bytes()).hexdigest(), digest, name)
        runtime = 'browser-link/native_bridge/browser_diagnostics/'
        for name in FILES:
            self.assertEqual(sums[runtime + name], hashlib.sha256((ROOT / DIAG / name).read_bytes()).hexdigest())

    def check_drift(self, changed):
        source = self.fixture()
        build = source / 'native-extension/build.mjs'
        with build.open('a') as stream:
            stream.write('\nawait writeFile(path.join(repo,' + json.dumps(changed) + '), ' + json.dumps('// concurrent edit\n') + ');\n')
        result = self.package(source)
        self.assertNotEqual(result.returncode, 0, 'mixed-generation package was published')
        self.assertIn('Source changed during packaging', result.stderr)
        self.assertFalse((self.output / 'SHA256SUMS.json').exists())

    def test_existing_browser_files_source_drift_rejected(self):
        self.check_drift('browser-interactions/index.mjs')

    def test_existing_approval_source_drift_rejected(self):
        self.check_drift('approval-policy/policy.mjs')

    def test_privacy_allowlist_and_output_overwrite_guard(self):
        source = self.fixture()
        private_names = ('.env.local', 'credentials.json', 'cookies.json', 'storage-state.json',
                         'session.json', 'capture.har', 'screenshot.png', 'test-output.log',
                         'evidence.json', 'test.mjs')
        for name in private_names:
            (source / 'browser-interactions' / name).write_text('NONSECRET_PRIVACY_CANARY')
            (source / DIAG / name).write_text('NONSECRET_PRIVACY_CANARY')
        (source / DIAG / 'real-browser-probe.py').write_text('# not runtime code')
        result = self.package(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest_path = self.output / 'SHA256SUMS.json'
        before = manifest_path.read_bytes()
        sums = json.loads(before)
        for name in private_names:
            self.assertNotIn('browser-link/browser-interactions/' + name, sums)
            self.assertNotIn('browser-link/native_bridge/browser_diagnostics/' + name, sums)
        self.assertEqual({p.name for p in (self.output / 'browser-link/native_bridge/browser_diagnostics').iterdir()}, set(FILES))
        result = self.package(source)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(manifest_path.read_bytes(), before)

    def test_missing_logger_member_rejected_before_output(self):
        source = self.fixture()
        (source / DIAG / 'sink.py').unlink()
        result = self.package(source)
        self.assertNotEqual(result.returncode, 0, 'incomplete logger package accepted')
        self.assertIn('sink.py', result.stderr)
        self.assertFalse(self.output.exists())

    def test_workspace_source_drift_rejected(self):
        self.check_drift('browser-workspaces/index.mjs')

    def test_diagnostics_js_source_drift_rejected(self):
        self.check_drift('browser-diagnostics/js/diagnostics.mjs')

    def test_diagnostics_python_source_drift_rejected(self):
        self.check_drift('browser-diagnostics/python/browser_diagnostics/sink.py')

    def test_packaged_daemon_writes_private_allowlisted_log_without_checkout(self):
        runtime = self.build()
        for name in FILES:
            self.assertTrue((runtime / 'browser_diagnostics' / name).is_file(), f'missing packaged logger: {name}')
        self.probe(runtime, 'plugin-log-home')

    def test_staged_daemon_writes_private_allowlisted_log_without_checkout(self):
        runtime = self.build()
        result = subprocess.run([sys.executable, '-I', '-B', str(runtime / 'install.py'),
                                 'stage', '--home', str(self.root / 'staged-home'),
                                 '--extension-origin', 'chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/'],
                                cwd=self.root, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        host_bin = Path(json.loads(result.stdout)['host']).parent
        for name in FILES:
            self.assertTrue((host_bin / 'browser_diagnostics' / name).is_file(), f'missing staged logger: {name}')
            self.assertEqual((host_bin / 'browser_diagnostics' / name).read_bytes(), (ROOT / DIAG / name).read_bytes())
        self.probe(host_bin, 'staged-log-home')


if __name__ == '__main__':
    unittest.main()
