"""Deterministic startup-gate regressions for the native bridge client."""

from __future__ import annotations

import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest


BRIDGE_DIR = Path(__file__).resolve().parents[1]
SCRATCH = Path.home() / ".hermes" / "cache" / "scratch"
sys.path.insert(0, str(BRIDGE_DIR))

from client import BridgeError, ensure_service  # noqa: E402

WORKER_SOURCE = '''from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, os.environ["BRIDGE_DIR"])
import client

client.__file__ = str(Path(os.environ["WRAPPER_DIR"]) / "client.py")
ready = Path(os.environ["READY_FILE"])
start = Path(os.environ["START_FILE"])
home = Path(os.environ["SERVICE_HOME"])


def append_line(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, (value + "\\n").encode("ascii"))
    finally:
        os.close(fd)


def run(index):
    append_line(ready, f"{os.getpid()}:{index}")
    deadline = time.monotonic() + 10
    while not start.exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("start barrier timed out")
        time.sleep(0.005)
    client.ensure_service(home, timeout=10)


with ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(run, range(4)))
'''

WRAPPER_SOURCE = '''import os
from pathlib import Path
import sys
import time

log = Path(os.environ["SPAWN_LOG"])
release = Path(os.environ["RELEASE_FILE"])
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
try:
    os.write(fd, (str(os.getpid()) + "\\n").encode("ascii"))
finally:
    os.close(fd)
deadline = time.monotonic() + 10
while not release.exists():
    if time.monotonic() >= deadline:
        raise SystemExit(91)
    time.sleep(0.005)
real_daemon = os.environ["REAL_DAEMON"]
os.execv(sys.executable, [sys.executable, real_daemon, *sys.argv[1:]])
'''


class StartupGateRegressionTests(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="sr-", dir=SCRATCH)
        self.root = Path(self.temp.name)
        self.home = self.root / "h"
        self.wrapper_dir = self.root / "w"
        self.wrapper_dir.mkdir()
        self.worker_path = self.root / "worker.py"
        self.wrapper_path = self.wrapper_dir / "daemon.py"
        self.worker_path.write_text(WORKER_SOURCE, encoding="utf-8")
        self.wrapper_path.write_text(WRAPPER_SOURCE, encoding="utf-8")
        self.ready_file = self.root / "ready"
        self.start_file = self.root / "start"
        self.release_file = self.root / "release"
        self.spawn_log = self.root / "spawns"
        self.workers: list[subprocess.Popen[str]] = []
        self.spawn_pids: list[int] = []

    def tearDown(self):
        self.release_file.touch(exist_ok=True)
        for process in self.workers:
            if process.poll() is None:
                process.terminate()
        for process in self.workers:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        self.spawn_pids = sorted(set(self.spawn_pids + self._read_int_lines(self.spawn_log)))
        self._stop_exact_pids(self.spawn_pids)
        self.temp.cleanup()

    @staticmethod
    def _read_lines(path: Path) -> list[str]:
        try:
            return [line for line in path.read_text(encoding="ascii").splitlines() if line]
        except FileNotFoundError:
            return []

    @classmethod
    def _read_int_lines(cls, path: Path) -> list[int]:
        return [int(line) for line in cls._read_lines(path)]

    @staticmethod
    def _process_states(pids: list[int]) -> dict[int, str]:
        if not pids:
            return {}
        completed = subprocess.run(
            ["ps", "-o", "pid=,stat=", "-p", ",".join(str(pid) for pid in pids)],
            check=False,
            capture_output=True,
            text=True,
        )
        states = {}
        for line in completed.stdout.splitlines():
            fields = line.split()
            if len(fields) >= 2:
                states[int(fields[0])] = fields[1]
        return states

    @classmethod
    def _live_pids(cls, pids: list[int]) -> list[int]:
        return sorted(pid for pid, state in cls._process_states(pids).items() if not state.startswith("Z"))

    @classmethod
    def _stop_exact_pids(cls, pids: list[int]) -> None:
        for pid in cls._live_pids(pids):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and cls._live_pids(pids):
            time.sleep(0.02)
        for pid in cls._live_pids(pids):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def _wait_for(self, predicate, message: str, timeout: float = 10) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        self.fail(message)

    def test_threads_in_two_processes_spawn_exactly_one_daemon(self):
        env = dict(
            os.environ,
            HOME=str(self.home),
            HERMES_HOME=str(self.home),
            BRIDGE_DIR=str(BRIDGE_DIR),
            WRAPPER_DIR=str(self.wrapper_dir),
            READY_FILE=str(self.ready_file),
            START_FILE=str(self.start_file),
            RELEASE_FILE=str(self.release_file),
            SPAWN_LOG=str(self.spawn_log),
            SERVICE_HOME=str(self.home),
            REAL_DAEMON=str(BRIDGE_DIR / "daemon.py"),
        )
        self.workers = [
            subprocess.Popen(
                [sys.executable, str(self.worker_path)],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for _ in range(2)
        ]
        ready_deadline = time.monotonic() + 10
        while time.monotonic() < ready_deadline and len(self._read_lines(self.ready_file)) != 8:
            exited = [process for process in self.workers if process.poll() is not None]
            if exited:
                details = []
                for process in exited:
                    stdout, stderr = process.communicate()
                    details.append({"returncode": process.returncode, "stdout": stdout, "stderr": stderr})
                self.fail(f"startup worker exited before the barrier: {details}")
            time.sleep(0.01)
        self.assertEqual(len(self._read_lines(self.ready_file)), 8, "all eight startup callers did not reach the barrier")
        self.start_file.touch()
        self._wait_for(lambda: len(self._read_int_lines(self.spawn_log)) >= 1, "no daemon spawn was attempted")
        time.sleep(1.0)
        spawn_pids = self._read_int_lines(self.spawn_log)
        self.spawn_pids = spawn_pids
        self.release_file.touch()

        worker_results = []
        for process in self.workers:
            stdout, stderr = process.communicate(timeout=15)
            worker_results.append({"returncode": process.returncode, "stdout": stdout, "stderr": stderr})
        self.assertTrue(all(item["returncode"] == 0 for item in worker_results), worker_results)

        data_dir = self.home / "plugin-data" / "browser-link-native"
        pid_path = data_dir / "daemon.pid"
        self._wait_for(pid_path.exists, "daemon pid file was not published")
        daemon_pid = int(pid_path.read_text(encoding="ascii"))
        self._wait_for(
            lambda: self._live_pids(spawn_pids) == [daemon_pid],
            f"competing daemon processes did not settle to the lock holder: {spawn_pids}",
        )
        lock_path = data_dir / "client-startup.lock"
        evidence = {
            "spawnAttempts": spawn_pids,
            "survivingDaemon": daemon_pid,
            "survivorsAfterSettle": self._live_pids(spawn_pids),
            "workerResults": worker_results,
        }
        self.assertEqual(len(spawn_pids), 1, evidence)
        lock_info = lock_path.stat()
        self.assertTrue(stat.S_ISREG(lock_info.st_mode), evidence)
        self.assertEqual(lock_info.st_uid, os.getuid(), evidence)
        self.assertEqual(stat.S_IMODE(lock_info.st_mode), 0o600, evidence)

    def test_startup_lock_symlink_is_rejected_without_touching_target(self):
        data_dir = self.home / "plugin-data" / "browser-link-native"
        data_dir.mkdir(parents=True, mode=0o700)
        target = self.root / "do-not-touch"
        target.write_text("sentinel", encoding="ascii")
        os.chmod(target, 0o644)
        (data_dir / "client-startup.lock").symlink_to(target)

        with self.assertRaises(BridgeError) as caught:
            ensure_service(self.home, timeout=0.1)

        self.assertEqual(caught.exception.code, "insecure_startup_lock")
        self.assertEqual(target.read_text(encoding="ascii"), "sentinel")
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)


if __name__ == "__main__":
    unittest.main()
