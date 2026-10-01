"""Independent native-host diagnostics staging closure regression (no browser)."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRATCH = Path.home() / ".hermes" / "cache" / "scratch"
EXTENSION_ORIGIN = "chrome-extension://" + "a" * 32 + "/"

_STAGED_DAEMON_CHECK = r'''
import hashlib
from pathlib import Path
import sys

host_bin = Path(sys.argv[1]).resolve()
hermes_home = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(host_bin))

import browser_diagnostics
import daemon
import task_diagnostics

for module in (browser_diagnostics, daemon, task_diagnostics):
    Path(module.__file__).resolve().relative_to(host_bin)
assert daemon.TaskDiagnosticProjection is task_diagnostics.TaskDiagnosticProjection

from daemon import BridgeDaemon, ProtocolError

owner = "owner-diagnostics-A"
task_id = "task-diagnostics-A"
request_id = "synthetic-request"
request_hash = hashlib.sha256(request_id.encode("utf-8")).hexdigest()


def install_task(instance, task_owner=owner):
    task = {
        "id": task_id,
        "owner": task_owner,
        "state": "ready",
        "cleanupState": "succeeded",
        "requestHistory": [{"requestIdHash": request_hash, "payloadHash": "f" * 64}],
    }
    instance.tasks[task_id] = task
    return task


bridge = BridgeDaemon(hermes_home)
bridge._prepare_data_dir()
task = install_task(bridge)
sink, projection = bridge._diagnostic_writer()
assert sink is not None and projection is not None
projection.record(
    {**task}, owner, task_id,
    component="native_bridge", event_type="request_state", status="succeeded",
    request_id=request_hash, request_id_hash=request_hash,
    connection_id="synthetic-connection", generation="1", duration_ms=1.0,
)
result = bridge._dispatch_client("shared.diagnostics", {
    "owner": owner, "taskId": task_id, "limit": 50, "cursor": 0,
})
assert len(result["events"]) == 1 and result["events"][0]["status"] == "succeeded", result
assert request_id not in repr(result)

try:
    bridge._dispatch_client("shared.diagnostics", {
        "owner": "different-owner", "taskId": task_id, "limit": 50, "cursor": 0,
    })
except ProtocolError as exc:
    assert exc.code == "forbidden", exc.code
else:
    raise AssertionError("foreign task owner was not rejected")

missing = BridgeDaemon(hermes_home / "missing-logs")
missing._prepare_data_dir()
install_task(missing)
try:
    missing._dispatch_client("shared.diagnostics", {
        "owner": owner, "taskId": task_id, "limit": 50, "cursor": 0,
    })
except ProtocolError as exc:
    assert exc.code == "diagnostics_unavailable" and "not provided" in exc.message, (exc.code, exc.message)
else:
    raise AssertionError("missing diagnostic history was not reported as not provided")

empty = BridgeDaemon(hermes_home / "empty-logs")
empty._prepare_data_dir()
install_task(empty)
empty_root = empty.data_dir / "diagnostics"
empty_root.mkdir(mode=0o700)
(empty_root / "events.jsonl").write_bytes(b"")
(empty_root / "events.jsonl").chmod(0o600)
try:
    empty._dispatch_client("shared.diagnostics", {
        "owner": owner, "taskId": task_id, "limit": 50, "cursor": 0,
    })
except ProtocolError as exc:
    assert exc.code == "diagnostics_unavailable" and "not provided" in exc.message, (exc.code, exc.message)
else:
    raise AssertionError("empty diagnostic history was not reported as not provided")

nonprivate = BridgeDaemon(hermes_home / "nonprivate-logs")
nonprivate._prepare_data_dir()
install_task(nonprivate)
root = nonprivate.data_dir / "diagnostics"
root.mkdir(mode=0o700)
(root / "events.jsonl").write_bytes(b"{}\n")
(root / "events.jsonl").chmod(0o600)
root.chmod(0o750)
try:
    nonprivate._dispatch_client("shared.diagnostics", {
        "owner": owner, "taskId": task_id, "limit": 50, "cursor": 0,
    })
except ProtocolError as exc:
    assert exc.code == "diagnostics_unavailable", exc.code
else:
    raise AssertionError("non-private diagnostics directory was accepted")

print("staged diagnostics closure, real dispatcher read, and refusal checks passed")
'''


def load_installer(path: Path | None = None):
    path = path or ROOT / "native-bridge" / "install.py"
    spec = importlib.util.spec_from_file_location("native_host_installer_under_test", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("native host installer could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StagedDiagnosticsClosureTests(unittest.TestCase):
    def test_staged_host_imports_and_dispatches_diagnostics_outside_checkout(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="v1.1-diagnostics-install-", dir=SCRATCH) as temp:
            scratch_root = Path(temp).resolve()
            isolated_home = scratch_root / "isolated-home"
            isolated_home.mkdir(mode=0o700)

            staged = load_installer().stage(isolated_home, [EXTENSION_ORIGIN])
            host_bin = Path(staged["host"]).parent.resolve()
            self.assertEqual(host_bin, isolated_home / ".hermes/plugin-data/browser-link-native/host-bin")

            child_env = {
                "HOME": str(isolated_home),
                "TMPDIR": str(SCRATCH),
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            }
            self.assertNotIn("PYTHONPATH", child_env)
            run = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    "-c",
                    _STAGED_DAEMON_CHECK,
                    str(host_bin),
                    str(isolated_home / ".hermes"),
                ],
                cwd=scratch_root,
                env=child_env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertIn("staged diagnostics closure", run.stdout)

    def test_missing_host_runtime_module_is_rejected_before_scratch_writes(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="v1.1-host-missing-", dir=SCRATCH) as temp:
            scratch_root = Path(temp).resolve()
            source_root = scratch_root / "source"
            bridge_source = source_root / "native-bridge"
            bridge_source.mkdir(parents=True)
            for name in ("install.py", "host.py", "client.py", "daemon.py", "api_client.py"):
                shutil.copyfile(ROOT / "native-bridge" / name, bridge_source / name)
            diagnostics_source = source_root / "browser-diagnostics/python/browser_diagnostics"
            shutil.copytree(ROOT / "browser-diagnostics/python/browser_diagnostics", diagnostics_source)
            projection_source = source_root / "executor-plugin/task_diagnostics.py"
            projection_source.parent.mkdir(parents=True)
            shutil.copyfile(ROOT / "executor-plugin/task_diagnostics.py", projection_source)

            (bridge_source / "api_client.py").unlink()
            installer = load_installer(bridge_source / "install.py")
            isolated_home = scratch_root / "synthetic-home"
            with self.assertRaisesRegex(ValueError, "api_client.py"):
                installer.stage(isolated_home, [EXTENSION_ORIGIN])
            self.assertFalse(isolated_home.exists(), "missing host closure must fail before creating the destination HOME")

    def test_stage_refuses_symlinked_targets_before_writing_outside_the_home(self):
        # 中文注释：合成目标里的链接不能让隔离安装覆盖外部目录或已有用户文件。
        installer = load_installer(ROOT / 'native-bridge/install.py')
        for relative, directory in (('.hermes', True),
                ('.hermes/plugin-data/browser-link-native/host-bin/host.py', False),
                ('Library/Application Support/Google/Chrome/NativeMessagingHosts/com.hermes.browser_link.json', False)):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory(dir='/tmp') as work:
                root = Path(work).resolve()
                isolated = root / 'home'
                outside = root / 'outside'
                outside.mkdir()
                kept = outside / 'keep.txt'
                kept.write_text('must remain unchanged')
                target = isolated / relative
                target.parent.mkdir(parents=True)
                target.symlink_to(outside if directory else kept)
                with self.assertRaisesRegex(ValueError, 'symbolic'):
                    installer.stage(isolated, [EXTENSION_ORIGIN])
                self.assertEqual(kept.read_text(), 'must remain unchanged')
                self.assertEqual(list(outside.iterdir()), [kept])
                self.assertFalse((isolated / '.hermes/plugin-data/browser-link-native/host-bin/daemon.py').exists())


if __name__ == "__main__":
    unittest.main()
