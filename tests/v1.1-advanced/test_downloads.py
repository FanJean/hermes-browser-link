"""任务下载登记、领取与 daemon 线路的离线测试；只使用临时目录中的合成文件。"""
from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "native-bridge"
sys.path.insert(0, str(BRIDGE))
try:
    spec = importlib.util.spec_from_file_location("v11_download_daemon", BRIDGE / "daemon.py")
    daemon_module = importlib.util.module_from_spec(spec)
    sys.modules["v11_download_daemon"] = daemon_module
    spec.loader.exec_module(daemon_module)
    downloads = sys.modules["downloads"]
finally:
    sys.path.remove(str(BRIDGE))

KEY = "0123456789abcdef"


class DownloadFlowTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".hermes/cache/scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.staging = self.root / "Downloads" / "hermes-tasks" / KEY
        self.staging.mkdir(parents=True)
        self.daemon = daemon_module.BridgeDaemon(self.root / "home")
        now = time.time()
        self.task = {"id": "task-d", "owner": "owner-d", "title": "downloads", "instanceId": "inst-d",
                     "browser": "chrome", "state": "ready", "generation": 3, "downloadKey": KEY,
                     "allowedOrigins": ["https://site.test"],
                     "tabIds": [5], "agentTabIds": [5], "requestHistory": [], "createdAt": now,
                     "updatedAt": now, "isolation": "shared-profile"}
        self.daemon.tasks["task-d"] = self.task
        self.daemon.task_locks["task-d"] = threading.RLock()
        self.daemon.dedupe["task-d"] = {}
        self.daemon.tab_leases[("inst-d", 5)] = "task-d"
        self.daemon.extensions["inst-d"] = {"instanceId": "inst-d"}
        self.daemon._persist_tasks = lambda: None
        self.calls = []

        def extension_call(extension, method, params, timeout=15.0):
            self.calls.append((method, params))
            return {"cancelled": True, "state": "cancelled"}

        self.daemon._extension_call = extension_call

    def event(self, **params):
        return self.daemon._dispatch_extension("inst-d", "extension.download_event",
                                               {"taskId": "task-d", "generation": 3, "tabId": 5, **params})

    def client(self, method, **params):
        return self.daemon._dispatch_client(method, {"owner": "owner-d", "taskId": "task-d", **params})

    def complete(self, ref=1, data=b"report-bytes", name="report.csv"):
        attributed = self.event(event="attributed", downloadRef=ref, url="https://site.test/r",
                                filename=name, mimeType="text/csv", totalBytes=len(data))
        path = self.staging / name
        path.write_bytes(data)
        self.event(event="complete", downloadRef=ref, path=str(path), bytesReceived=len(data),
                   totalBytes=len(data), fileSize=len(data), danger="safe", exists=True)
        return attributed["downloadId"], path

    def test_claim_moves_verified_bytes_and_hides_paths_until_claim(self):
        download_id, staged = self.complete()
        listed = self.client("shared.downloads")
        self.assertEqual([row["state"] for row in listed["downloads"]], ["complete"])
        self.assertNotIn("path", listed["downloads"][0])
        self.assertNotIn("downloads", self.daemon._public_task(self.task))
        claimed = self.client("shared.download_claim", downloadId=download_id)
        self.assertEqual(claimed["sha256"], hashlib.sha256(b"report-bytes").hexdigest())
        self.assertEqual(Path(claimed["localPath"]).read_bytes(), b"report-bytes")
        self.assertFalse(staged.exists())
        self.assertEqual(oct(os.stat(claimed["localPath"]).st_mode & 0o777), "0o600")
        # 中文注释：再次领取返回同一文件，不重复移动。
        self.assertEqual(self.client("shared.download_claim", downloadId=download_id)["localPath"], claimed["localPath"])

    def test_interrupted_changed_or_escaped_files_cannot_be_claimed(self):
        attributed = self.event(event="attributed", downloadRef=2, url="https://site.test/x", filename="x.bin")
        self.event(event="interrupted", downloadRef=2, error="NETWORK_FAILED")
        with self.assertRaises(daemon_module.ProtocolError) as caught:
            self.client("shared.download_claim", downloadId=attributed["downloadId"])
        self.assertEqual(caught.exception.code, "download_not_complete")
        download_id, staged = self.complete(ref=3, name="y.bin")
        staged.write_bytes(b"tampered-longer")
        with self.assertRaises(daemon_module.ProtocolError) as caught:
            self.client("shared.download_claim", downloadId=download_id)
        self.assertEqual(caught.exception.code, "download_changed")
        outside = self.root / "elsewhere.txt"
        outside.write_bytes(b"user")
        escaped = self.event(event="attributed", downloadRef=4, url="https://site.test/z", filename="z")
        self.event(event="complete", downloadRef=4, path=str(outside), bytesReceived=4, fileSize=4,
                   danger="safe", exists=True)
        row = next(r for r in self.client("shared.downloads")["downloads"] if r["id"] == escaped["downloadId"])
        self.assertEqual(row["state"], "interrupted")
        self.assertTrue(outside.exists(), "a file outside the task staging folder is never touched")

    def test_symlinked_staging_file_is_refused(self):
        target = self.root / "private.txt"
        target.write_bytes(b"secret")
        attributed = self.event(event="attributed", downloadRef=6, url="https://site.test/s", filename="s.txt")
        link = self.staging / "s.txt"
        link.symlink_to(target)
        self.event(event="complete", downloadRef=6, path=str(link), bytesReceived=6, fileSize=6,
                   danger="safe", exists=True)
        with self.assertRaises(daemon_module.ProtocolError):
            self.client("shared.download_claim", downloadId=attributed["downloadId"])
        self.assertEqual(target.read_bytes(), b"secret")

    def test_events_require_task_tab_generation_and_origin(self):
        with self.assertRaises(daemon_module.ProtocolError):
            self.daemon._dispatch_extension("inst-d", "extension.download_event", {
                "taskId": "task-d", "generation": 2, "tabId": 5, "event": "attributed", "downloadRef": 9,
                "url": "https://site.test/a"})
        with self.assertRaises(daemon_module.ProtocolError):
            self.event(event="attributed", downloadRef=9, url="https://site.test/a", tabId=77)
        with self.assertRaises(daemon_module.ProtocolError):
            self.event(event="attributed", downloadRef=9, url="https://other.test/a")
        with self.assertRaises(daemon_module.ProtocolError):
            self.daemon._dispatch_extension("other-instance", "extension.download_event", {
                "taskId": "task-d", "generation": 3, "tabId": 5, "event": "attributed", "downloadRef": 9,
                "url": "https://site.test/a"})
        self.event(event="ambiguous", url="https://site.test/a")
        self.assertEqual(self.client("shared.downloads")["unattributed"], 1)
        with self.assertRaises(daemon_module.ProtocolError):
            self.daemon._dispatch_client("shared.downloads", {"owner": "intruder", "taskId": "task-d"})

    def test_cancel_only_forwards_in_progress_task_downloads(self):
        attributed = self.event(event="attributed", downloadRef=12, url="https://site.test/c", filename="c")
        result = self.client("shared.download_cancel", downloadId=attributed["downloadId"])
        self.assertEqual(result["state"], "cancelled")
        self.assertEqual(self.calls, [("browser.download_cancel", {"taskId": "task-d", "generation": 3,
                                                                     "downloadRef": 12})])
        # 中文注释：已结束的下载不再派发取消。
        self.client("shared.download_cancel", downloadId=attributed["downloadId"])
        self.assertEqual(len(self.calls), 1)

    def test_unclaimed_staging_expires_after_24_hours_but_claimed_files_stay(self):
        kept_id, _ = self.complete(ref=20, name="kept.txt")
        claimed = self.client("shared.download_claim", downloadId=kept_id)
        _, stale = self.complete(ref=21, name="stale.txt")
        registry = self.daemon.download_registry
        registry.clock = lambda: time.time() + downloads.STAGING_TTL_SECONDS + 5
        states = {row["filename"]: row["state"] for row in self.client("shared.downloads")["downloads"]}
        self.assertEqual(states, {"kept.txt": "claimed", "stale.txt": "expired"})
        self.assertFalse(stale.exists())
        self.assertTrue(Path(claimed["localPath"]).exists())

    def test_task_download_count_is_bounded(self):
        for ref in range(downloads.MAX_TASK_DOWNLOADS):
            self.event(event="attributed", downloadRef=100 + ref, url="https://site.test/n", filename=f"n{ref}")
        with self.assertRaises(daemon_module.ProtocolError) as caught:
            self.event(event="attributed", downloadRef=999, url="https://site.test/n", filename="over")
        self.assertEqual(caught.exception.code, "download_limit")

    def test_expired_missing_file_still_persists_the_state_transition(self):
        # 中文注释：浏览器暂存文件已被用户删除时，过期状态仍必须写盘，不能重启后重新显示可领取。
        _, staged = self.complete()
        staged.unlink()
        persisted = []
        self.daemon._persist_tasks = lambda: persisted.append(True)
        self.daemon.download_registry.clock = lambda: time.time() + downloads.STAGING_TTL_SECONDS + 5
        self.assertEqual(self.client('shared.downloads')['downloads'][0]['state'], 'expired')
        self.assertEqual(persisted, [True])

    def test_lost_tracking_is_unknown_without_cancelling_or_claiming_files(self):
        # 中文注释：撤权、断线、重启或新代次都会丢失扩展下载跟踪；不能持续声称下载仍在进行。
        for state, generation in (('cancelled', 3), ('needs_sync', 3), ('ready', 4)):
            with self.subTest(state=state, generation=generation):
                self.task['downloads'] = []
                self.task.update(state='ready', generation=3)
                receipt = self.event(event='attributed', downloadRef=90, url='https://site.test/lost', filename='lost.txt')
                self.task.update(state=state, generation=generation)
                listed = self.client('shared.downloads')['downloads'][0]
                self.assertEqual(listed['state'], 'unknown')
                self.assertEqual(listed['reason'], 'tracking_lost')
                with self.assertRaises(daemon_module.ProtocolError):
                    self.client('shared.download_claim', downloadId=receipt['downloadId'])
                self.assertEqual(self.calls, [])

    def test_late_completion_can_clarify_unknown_tracking_of_the_same_generation(self):
        # 中文注释：结果未知不代表文件已取消；同代次迟到的可信回执可以恢复可领取状态。
        self.event(event='attributed', downloadRef=91, url='https://site.test/late', filename='late.txt')
        self.task['state'] = 'cancelled'
        self.assertEqual(self.client('shared.downloads')['downloads'][0]['state'], 'unknown')
        staged = self.staging / 'late.txt'
        staged.write_bytes(b'late')
        self.event(event='complete', downloadRef=91, path=str(staged), bytesReceived=4, fileSize=4, danger='safe')
        row = self.client('shared.downloads')['downloads'][0]
        self.assertEqual(row['state'], 'complete')
        self.assertNotIn('reason', row)


if __name__ == "__main__":
    unittest.main()
