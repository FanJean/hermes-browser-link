import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

BRIDGE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_DIR))

from client import BridgeClient, BridgeError, _read_token  # noqa: E402
from daemon import BridgeDaemon, ProtocolError  # noqa: E402
from tests.support import ExtensionPeer, stop_fixture_daemon  # noqa: E402


class HardeningTests(unittest.TestCase):
    def setUp(self):
        # Use the canonical short path for both daemon bind and peer connect.
        scratch = (Path.home() / ".hermes" / "cache" / "scratch").resolve()
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="bn-hardening-", dir=scratch)
        self.home = Path(self.temp.name) / "h"
        self.clients = []
        self.peers = []
        self.direct_daemons = []

    def tearDown(self):
        # 中文注释：直接实例的异步快照必须在临时目录删除前完成。
        for daemon in self.direct_daemons:
            daemon._flush_tasks()
        for peer in self.peers:
            peer.close()
        for client in self.clients:
            client.close()
        stop_fixture_daemon(self.home)
        self.temp.cleanup()

    def client(self, timeout=15.0):
        client = BridgeClient(self.home, timeout=timeout)
        self.clients.append(client)
        return client

    def extension(self, *args, **kwargs):
        peer = ExtensionPeer(self.home, *args, **kwargs)
        self.peers.append(peer)
        return peer

    def direct_daemon(self, request_history_limit=4096):
        daemon = BridgeDaemon(self.home, request_history_limit=request_history_limit)
        daemon.data_dir.mkdir(parents=True, mode=0o700)
        os.chmod(daemon.data_dir, 0o700)
        now = time.time()
        task = {
            "id": "task-1",
            "owner": "owner-1",
            "title": "hardening",
            "instanceId": "instance-1",
            "browser": "chrome",
            "state": "ready",
            "generation": 1,
            "allowedOrigins": ["https://example.com"],
            "tabIds": [7],
            "agentTabIds": [],
            "createdAt": now,
            "updatedAt": now,
            "isolation": "shared-profile",
            "requestHistory": [],
        }
        daemon.tasks[task["id"]] = task
        daemon.task_locks[task["id"]] = threading.RLock()
        daemon.dedupe[task["id"]] = {}
        daemon.tab_leases[(task["instanceId"], 7)] = task["id"]
        daemon.extensions[task["instanceId"]] = {"instanceId": task["instanceId"]}
        self.direct_daemons.append(daemon)
        return daemon, task

    def test_fixture_socket_path_is_canonical_and_fits_macos_uds(self):
        socket_path = self.home / "plugin-data" / "browser-link-native" / "bridge.sock"
        self.assertEqual(socket_path, socket_path.resolve())
        self.assertLessEqual(len(os.fsencode(socket_path)), 103)

    def test_request_history_is_bounded_and_survives_restart_without_results(self):
        daemon, task = self.direct_daemon(request_history_limit=2)
        daemon._extension_call = lambda _extension, _method, params: {
            "secretPageText": "must-not-persist",
            "requestId": params["requestId"],
        }
        base = {
            "owner": "owner-1",
            "taskId": "task-1",
            "action": "snapshot",
            "tabId": 7,
        }
        first = dict(base, requestId="request-1")
        second = dict(base, requestId="request-2")
        self.assertEqual(daemon._run_task(first)["requestId"], "request-1")
        self.assertEqual(daemon._run_task(second)["requestId"], "request-2")
        with self.assertRaises(ProtocolError) as full:
            daemon._run_task(dict(base, requestId="request-3"))
        self.assertEqual(full.exception.code, "request_history_full")
        self.assertEqual(len(task["requestHistory"]), 2)
        # 中文注释：任务快照按批次刷新；此处验收正常重启，先完成持久化屏障。
        daemon._flush_tasks()
        persisted_text = daemon.tasks_path.read_text(encoding="utf-8")
        self.assertNotIn("must-not-persist", persisted_text)
        self.assertNotIn("request-1", persisted_text)

        restored = BridgeDaemon(self.home, request_history_limit=2)
        restored._load_tasks()
        restored.extensions["instance-1"] = {"instanceId": "instance-1"}
        restored._notify_tasks_changed = lambda _instance_id: None
        resumed = restored._resume_task({"owner": "owner-1", "taskId": "task-1"})
        self.assertEqual(resumed["state"], "pending_approval")
        restored._dispatch_extension(
            "instance-1",
            "extension.approve",
            {
                "taskId": "task-1",
                "tabIds": [7],
                "allowedOrigins": ["https://example.com"],
            },
        )
        restored._extension_call = lambda *_args, **_kwargs: self.fail("replayed request reached extension")
        with self.assertRaises(ProtocolError) as replay:
            restored._run_task(first)
        self.assertEqual(replay.exception.code, "request_outcome_unavailable")
        # 中文注释：临时目录删除前结束恢复实例的异步快照，避免测试后台线程越过清理。
        restored._flush_tasks()

    def test_extension_timeout_revokes_authority_instead_of_returning_ready(self):
        daemon, task = self.direct_daemon()
        calls = []

        def extension_call(_extension, method, params, timeout=15.0):
            calls.append((method, params))
            if method == "browser.execute":
                raise ProtocolError("extension_timeout", "timed out")
            return {"released": True}

        daemon._extension_call = extension_call
        with self.assertRaises(ProtocolError) as timed_out:
            daemon._run_task(
                {
                    "owner": "owner-1",
                    "taskId": "task-1",
                    "requestId": "timeout-1",
                    "action": "snapshot",
                    "tabId": 7,
                }
            )
        self.assertEqual(timed_out.exception.code, "extension_timeout")
        self.assertEqual(task["state"], "needs_sync")
        self.assertEqual(task["tabIds"], [])
        self.assertNotIn(("instance-1", 7), daemon.tab_leases)
        self.assertEqual([method for method, _params in calls], ["browser.execute", "browser.release"])
        self.assertFalse(calls[-1][1]["closeAgentTabs"])

    def test_extension_error_is_deduplicated_without_reexecution(self):
        daemon, _task = self.direct_daemon()
        calls = 0

        def extension_call(_extension, _method, _params, timeout=15.0):
            nonlocal calls
            calls += 1
            raise ProtocolError("browser_action_failed", "known failure")

        daemon._extension_call = extension_call
        params = {
            "owner": "owner-1",
            "taskId": "task-1",
            "requestId": "known-error-1",
            "action": "snapshot",
            "tabId": 7,
        }
        for _attempt in range(2):
            with self.assertRaises(ProtocolError) as failed:
                daemon._run_task(params)
            self.assertEqual(failed.exception.code, "browser_action_failed")
        self.assertEqual(calls, 1)

    def test_late_server_response_is_consumed_after_pending_cleanup(self):
        daemon = BridgeDaemon(self.home)
        extension = {"pendingLock": threading.Lock(), "pending": {}}
        self.assertTrue(
            daemon._accept_extension_response(
                extension,
                {"id": "srv:late-response", "result": {"tabId": 99}},
            )
        )

    def test_cancelled_task_can_resume_only_through_fresh_approval(self):
        extension = self.extension("resume-cancelled", "chrome")
        client = self.client()
        origins = ["https://example.com"]
        task = client.call(
            "shared.create",
            {
                "owner": "owner-c",
                "title": "cancel then resume",
                "instanceId": "resume-cancelled",
                "allowedOrigins": origins,
            },
        )
        extension.request(
            "extension.approve",
            {"taskId": task["id"], "tabIds": [31], "allowedOrigins": origins},
        )
        with ThreadPoolExecutor(max_workers=1) as pool:
            cancelling = pool.submit(
                client.call,
                "shared.cancel",
                {"owner": "owner-c", "taskId": task["id"]},
            )
            release = extension.receive_request("browser.release")
            extension.respond(release, {"released": True})
            self.assertEqual(cancelling.result(timeout=2)["state"], "cancelled")

        resumed = client.call(
            "shared.resume", {"owner": "owner-c", "taskId": task["id"]}
        )
        self.assertEqual(resumed["state"], "pending_approval")
        self.assertEqual(resumed["generation"], 2)
        self.assertEqual(resumed["tabIds"], [])
        with self.assertRaises(BridgeError) as not_approved:
            client.call(
                "shared.run",
                {
                    "owner": "owner-c",
                    "taskId": task["id"],
                    "requestId": "before-reapproval",
                    "action": "snapshot",
                    "tabId": 31,
                },
            )
        # 中文注释：重新批准前属于可确认未派发的授权准备状态。
        self.assertEqual(not_approved.exception.code, "task_preparing")
        approved = extension.request(
            "extension.approve",
            {"taskId": task["id"], "tabIds": [31], "allowedOrigins": origins},
        )
        self.assertEqual(approved["state"], "ready")
        self.assertEqual(approved["generation"], 2)

    def test_unauthorized_navigation_releases_every_task_lease(self):
        extension = self.extension("navigation-revoke", "chrome")
        client = self.client()
        origins = ["https://example.com"]
        first = client.call(
            "shared.create",
            {
                "owner": "owner-nav-a",
                "title": "navigation revoke",
                "instanceId": "navigation-revoke",
                "allowedOrigins": origins,
            },
        )
        extension.request(
            "extension.approve",
            {"taskId": first["id"], "tabIds": [41, 42], "allowedOrigins": origins},
        )
        denied = extension.request(
            "extension.tab_event",
            {
                "taskId": first["id"],
                "tabId": 41,
                # 中文注释：导航通知沿用任务的授权代次。
                "generation": first["generation"],
                "event": "navigated",
                "documentGeneration": 2,
                "url": "https://not-approved.example/path",
            },
        )
        self.assertEqual(denied["error"]["code"], "origin_denied")
        revoked = client.call(
            "shared.get", {"owner": "owner-nav-a", "taskId": first["id"]}
        )
        self.assertEqual(revoked["state"], "needs_sync")
        self.assertEqual(revoked["tabIds"], [])

        second = client.call(
            "shared.create",
            {
                "owner": "owner-nav-b",
                "title": "reclaim released tab",
                "instanceId": "navigation-revoke",
                "allowedOrigins": origins,
            },
        )
        reclaimed = extension.request(
            "extension.approve",
            {"taskId": second["id"], "tabIds": [42], "allowedOrigins": origins},
        )
        self.assertEqual(reclaimed["state"], "ready")

    def test_token_symlink_is_rejected_without_touching_target(self):
        data_dir = self.home / "plugin-data" / "browser-link-native"
        data_dir.mkdir(parents=True, mode=0o700)
        target = Path(self.temp.name) / "victim-token"
        target.write_text("do-not-read-or-chmod", encoding="ascii")
        os.chmod(target, 0o644)
        (data_dir / "token").symlink_to(target)

        daemon = BridgeDaemon(self.home)
        with self.assertRaises(RuntimeError):
            daemon._ensure_token()
        with self.assertRaises(BridgeError) as client_error:
            _read_token(self.home)
        self.assertEqual(client_error.exception.code, "insecure_token")
        self.assertEqual(target.read_text(encoding="ascii"), "do-not-read-or-chmod")
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)

    def test_daemon_refuses_non_socket_collision_without_deleting_it(self):
        data_dir = self.home / "plugin-data" / "browser-link-native"
        data_dir.mkdir(parents=True, mode=0o700)
        collision = data_dir / "bridge.sock"
        collision.write_text("unrelated-file", encoding="ascii")
        process = subprocess.Popen(
            [sys.executable, str(BRIDGE_DIR / "daemon.py"), "--home", str(self.home)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            stdout, stderr = process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate(timeout=2)
            self.fail(f"daemon kept running despite socket collision: {stderr.decode(errors='replace')}")
        # Preserve the original safe rejection rather than accepting any crash
        # (e.g. an import failure) as evidence of collision protection.
        sys.stderr.write(stderr.decode(errors="replace"))
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(stdout, b"")
        self.assertIn(b"RuntimeError: refusing to replace a non-socket bridge path", stderr)
        self.assertTrue(collision.is_file())
        self.assertEqual(collision.read_text(encoding="ascii"), "unrelated-file")


    def test_daemon_restarts_after_crash_leaves_stale_sockets(self):
        # 中文注释：旧 daemon 被 SIGKILL 后遗留套接字；新 daemon 持锁后应清理无人监听的套接字并重新服务。
        first = subprocess.Popen([sys.executable, str(BRIDGE_DIR / "daemon.py"), "--home", str(self.home)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        data_dir = self.home / "plugin-data" / "browser-link-native"
        deadline = time.monotonic() + 5
        while not (data_dir / "daemon.pid").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        first.kill()
        first.wait(timeout=5)
        self.assertTrue((data_dir / "bridge.sock").exists())
        second = subprocess.Popen([sys.executable, str(BRIDGE_DIR / "daemon.py"), "--home", str(self.home)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                pid = (data_dir / "daemon.pid").read_text(encoding="ascii") if (data_dir / "daemon.pid").exists() else ""
                if pid == str(second.pid):
                    break
                self.assertIsNone(second.poll(), second.stderr.read().decode(errors="replace") if second.poll() is not None else "")
                time.sleep(0.05)
            self.assertEqual((data_dir / "daemon.pid").read_text(encoding="ascii"), str(second.pid))
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                probe.connect(str(data_dir / "bridge.sock"))
            finally:
                probe.close()
        finally:
            second.terminate()
            second.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
