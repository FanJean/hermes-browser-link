"""API v2 deployment dependency regression gates (no personal install)."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRATCH = Path.home() / '.hermes/cache/scratch'
FIXTURE_DIR = ROOT / 'tests/fixtures'

def load_fixtures():
    spec = importlib.util.spec_from_file_location('diagnostics_package_fixtures', FIXTURE_DIR / 'package_fixtures.py')
    if spec is None or spec.loader is None:
        raise RuntimeError('package fixtures could not be loaded')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def load(path):
    spec = importlib.util.spec_from_file_location('installer_under_test', path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class ApiPackagingTests(unittest.TestCase):
    def test_isolated_stage_imports_api_dependency_without_checkout(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            result = load(ROOT / 'native-bridge/install.py').stage(Path(temp), ['chrome-extension://' + 'a'*32 + '/'])
            host_bin = Path(result['host']).parent
            self.assertTrue((host_bin / 'api_client.py').is_file(), 'stage omitted api_client.py')
            self.assertTrue((host_bin / 'task_diagnostics.py').is_file(), 'stage omitted task_diagnostics.py')
            run = subprocess.run([sys.executable, '-I', '-c', 'import sys; sys.path.insert(0,sys.argv[1]); import daemon,api_client,task_diagnostics; print(api_client.__file__, task_diagnostics.__file__); assert daemon.TaskDiagnosticProjection is task_diagnostics.TaskDiagnosticProjection', str(host_bin)], cwd=temp, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn(str(host_bin), run.stdout)

    def test_release_installer_rejects_missing_api_dependency_before_writes(self):
        # 缺少桥接客户端时，安装器必须在写入用户目录前拒绝候选包。
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            temp = Path(temp)
            package = load_fixtures().write_installer_package(temp / 'package', include_api_client=False)
            with self.assertRaisesRegex(ValueError, 'api_client.py'):
                load(ROOT / 'scripts/install-executor.py').install(package, temp/'home', temp/'hh', ['chrome-extension://'+'a'*32+'/'], apply=True)
            self.assertFalse((temp/'hh').exists())

    def test_packager_rejects_missing_api_dependency_before_output(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            temp = Path(temp)
            source = load_fixtures().write_packager_source(temp)
            output = temp / 'output'
            run = subprocess.run(['node', str(ROOT/'scripts/package-executor.mjs'), '--source', str(source), '--output', str(output)], capture_output=True, text=True)
            self.assertNotEqual(run.returncode, 0)
            self.assertIn('api_client.py', run.stderr)
            self.assertIn('native-bridge/api_client.py', run.stderr)
            self.assertFalse(output.exists())

if __name__ == '__main__': unittest.main()
