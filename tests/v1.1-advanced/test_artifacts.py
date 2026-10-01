"""任务级文件登记的真实磁盘边界测试；只使用临时合成字节。"""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("v11_artifacts", ROOT / "native-bridge" / "artifacts.py")
artifacts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(artifacts)


class SelectedFile:
    def __init__(self, data, filename="user.txt", content_type="text/plain"):
        self.data, self.filename, self.content_type = data, filename, content_type
        self.offset = 0

    async def read(self, limit):
        chunk = self.data[self.offset:self.offset + limit]
        self.offset += len(chunk)
        return chunk


class ArtifactStoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        scratch = Path.home() / ".hermes/cache/scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.store = artifacts.ArtifactStore(Path(self.temp.name))
        self.task = {"id": "task-1", "generation": 3, "state": "ready",
                     "allowedOrigins": ["https://example.test"]}

    async def test_selection_is_bound_to_task_generation_origin_and_digest(self):
        data = b"selected-by-person"
        record = await self.store.register(task=self.task, owner="trusted-owner",
                                           origin="https://example.test", file=SelectedFile(data))
        self.assertEqual(record["sha256"], hashlib.sha256(data).hexdigest())
        self.assertNotIn("path", record)
        self.assertEqual(self.store.list(task=self.task, owner="trusted-owner"), [record])
        resolved, path = self.store.resolve(task=self.task, owner="trusted-owner",
                                            origin="https://example.test", artifact_id=record["id"])
        self.assertEqual(resolved, record)
        self.assertEqual(path.read_bytes(), data)
        # 中文注释：旧代次、其他来源或其他 owner 都不能领取已有私有字节。
        for task, owner, origin in (({**self.task, "generation": 4}, "trusted-owner", "https://example.test"),
                                     ({**self.task, "id": "task-2"}, "trusted-owner", "https://example.test"),
                                     (self.task, "foreign", "https://example.test"),
                                     (self.task, "trusted-owner", "https://other.test")):
            with self.subTest(task=task, owner=owner, origin=origin), self.assertRaises(artifacts.ArtifactError):
                self.store.resolve(task=task, owner=owner, origin=origin, artifact_id=record["id"])

    async def test_mutated_file_or_manifest_is_not_usable(self):
        record = await self.store.register(task=self.task, owner="trusted-owner",
                                           origin="https://example.test", file=SelectedFile(b"original"))
        _, selected = self.store.resolve(task=self.task, owner="trusted-owner",
                                         origin="https://example.test", artifact_id=record["id"])
        selected.write_bytes(b"changed")
        with self.assertRaises(artifacts.ArtifactError):
            self.store.resolve(task=self.task, owner="trusted-owner",
                               origin="https://example.test", artifact_id=record["id"])

    async def test_filename_path_and_wrong_type_are_rejected(self):
        record = await self.store.register(task=self.task, owner="trusted-owner",
                                           origin="https://example.test",
                                           file=SelectedFile(b"content", "C:\\folder\\entry.txt"))
        self.assertEqual(record["filename"], "entry.txt")
        with self.assertRaises(artifacts.ArtifactError):
            await self.store.register(task=self.task, owner="trusted-owner",
                                      origin="https://example.test",
            file=SelectedFile(b"not-a-pdf", "entry.pdf", "application/pdf"))
        self.assertEqual(len(self.store.list(task=self.task, owner="trusted-owner")), 1)

    async def test_local_path_is_copied_and_bound_to_task_generation(self):
        # 中文注释：对话路径只用于首次复制；后续使用任务私有副本，重复请求复用同一登记。
        source = Path(self.temp.name) / "conversation.txt"
        source.write_bytes(b"from-conversation")
        record = self.store.register_path(task=self.task, owner="trusted-owner", path=str(source))
        self.assertEqual(record["origin"], artifacts.LOCAL_PATH_ORIGIN)
        self.assertEqual(record["sha256"], hashlib.sha256(b"from-conversation").hexdigest())
        self.assertEqual(self.store.register_path(task=self.task, owner="trusted-owner", path=str(source)), record)
        source.write_bytes(b"changed-source")
        _, copied = self.store.resolve(task=self.task, owner="trusted-owner",
                                       origin=artifacts.LOCAL_PATH_ORIGIN, artifact_id=record["id"])
        self.assertEqual(copied.read_bytes(), b"from-conversation")
        self.assertEqual(copied.name, "conversation.txt")
        for task, owner in (({**self.task, "generation": 4}, "trusted-owner"),
                            ({**self.task, "id": "task-2"}, "trusted-owner"), (self.task, "foreign")):
            with self.subTest(task=task, owner=owner), self.assertRaises(artifacts.ArtifactError):
                self.store.resolve(task=task, owner=owner, origin=artifacts.LOCAL_PATH_ORIGIN,
                                   artifact_id=record["id"])

    async def test_local_path_rejects_missing_and_non_file(self):
        # 中文注释：不存在的路径和目录均不能登记为待上传文件。
        for path in (str(Path(self.temp.name) / "missing.txt"), self.temp.name, "relative.txt"):
            with self.subTest(path=path), self.assertRaises(artifacts.ArtifactError):
                self.store.register_path(task=self.task, owner="trusted-owner", path=path)


class ArtifactApiTests(unittest.TestCase):
    def test_only_trusted_desktop_upload_creates_task_scoped_artifact(self):
        scratch = Path.home() / ".hermes/cache/scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as temporary:
            api_path = ROOT / "executor-plugin" / "dashboard" / "plugin_api.py"
            spec = importlib.util.spec_from_file_location("v11_artifact_api", api_path)
            api = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = api
            try:
                spec.loader.exec_module(api)
                task = {"id": "task-api", "generation": 2, "state": "ready", "activeMode": "full",
                        "allowedOrigins": ["https://example.test"]}

                class Authority:
                    @staticmethod
                    def known_owners():
                        return ["trusted-owner"]

                class Runtime:
                    hermes_home = Path(temporary)
                    authority = Authority()

                    @staticmethod
                    def call(method, params):
                        if method == "shared.list" and params == {"owner": "trusted-owner"}:
                            return [task]
                        if method == "shared.get" and params == {"owner": "trusted-owner", "taskId": "task-api"}:
                            return task
                        raise AssertionError((method, params))

                app = FastAPI()
                app.include_router(api.router, prefix="/api/plugins/browser-link")
                with patch.object(api, "_native_profile_runtime", return_value=Runtime()), TestClient(app) as client:
                    url = "/api/plugins/browser-link/shared/tasks/task-api/artifacts"
                    # 中文注释：HTTP 只携带用户选择的文件字节和明确来源，不接收任何本地路径。
                    uploaded = client.post(url, params={"origin": "https://example.test"},
                                           files={"file": ("chosen.txt", b"selected", "text/plain")})
                    self.assertEqual(uploaded.status_code, 200, uploaded.text)
                    self.assertEqual(uploaded.json()["sha256"], hashlib.sha256(b"selected").hexdigest())
                    self.assertNotIn("path", uploaded.text)
                    listed = client.get(url)
                    self.assertEqual(listed.status_code, 200, listed.text)
                    self.assertEqual(listed.json(), [uploaded.json()])
                    denied = client.post(url, params={"origin": "https://other.test"},
                                         files={"file": ("chosen.txt", b"foreign", "text/plain")})
                    self.assertEqual(denied.status_code, 422)
                    self.assertNotIn("foreign", denied.text)
                    self.assertEqual(len(artifacts.ArtifactStore(Path(temporary)).list(
                        task=task, owner="trusted-owner")), 1)
                runtime_path = ROOT / "executor-plugin" / "runtime.py"
                runtime_spec = importlib.util.spec_from_file_location("v11_artifact_projection", runtime_path)
                runtime = importlib.util.module_from_spec(runtime_spec)
                sys.modules[runtime_spec.name] = runtime
                try:
                    runtime_spec.loader.exec_module(runtime)
                    projected = runtime._project_tool_result("browser_shared_artifacts", {"task_id": "task-api"},
                        [{**uploaded.json(), "path": "/private/secret"}])
                    self.assertEqual(projected, [uploaded.json()])
                    self.assertNotIn("/private/secret", str(projected))
                finally:
                    sys.modules.pop(runtime_spec.name, None)
            finally:
                sys.modules.pop(spec.name, None)


if __name__ == "__main__":
    unittest.main()
