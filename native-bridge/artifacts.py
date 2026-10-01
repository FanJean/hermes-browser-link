"""用户选取文件的任务级私有登记；普通工具结果不包含本地路径。"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid


MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_TASK_FILES = 10
_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_TYPES = frozenset({"text/plain", "application/json", "application/pdf", "image/png", "application/octet-stream"})
# 中文注释：用户在对话中给出的本地路径登记为本任务“不限来源”的文件，上传时由扩展按当前任务页来源核对。
LOCAL_PATH_ORIGIN = "*"
_SUFFIX_TYPES = {".txt": "text/plain", ".csv": "text/plain", ".md": "text/plain", ".json": "application/json",
                 ".pdf": "application/pdf", ".png": "image/png"}


class ArtifactError(ValueError):
    """固定错误码，调用方不得返回底层路径或文件内容。"""


def _private_dir(path: Path) -> Path:
    # 中文注释：任何一级私有目录都不能是符号链接，避免重定向到用户的其他文件。
    parents = list(reversed((path, *path.parents)))
    for item in parents:
        if item.exists() and item.is_symlink():
            raise ArtifactError("STORAGE_UNAVAILABLE")
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ArtifactError("STORAGE_UNAVAILABLE")
    os.chmod(path, 0o700)
    return path


def _name(value: str) -> str:
    if not isinstance(value, str):
        raise ArtifactError("INVALID_FILENAME")
    name = value.replace("\\", "/").split("/")[-1].strip()
    if name in {"", ".", ".."} or len(name.encode("utf-8")) > 240 or any(ord(char) < 32 for char in name):
        raise ArtifactError("INVALID_FILENAME")
    return name


def _task_scope(task: dict, owner: str) -> tuple[str, int]:
    task_id, generation = task.get("id"), task.get("generation")
    if (not isinstance(task_id, str) or not _ID.fullmatch(task_id)
            or type(generation) is not int or generation < 1
            or task.get("state") != "ready" or not isinstance(owner, str) or not owner):
        raise ArtifactError("ARTIFACT_SCOPE_DENIED")
    return task_id, generation


def _scope(task: dict, owner: str, origin: str) -> tuple[str, int]:
    task_id, generation = _task_scope(task, owner)
    if not isinstance(origin, str) or origin not in task.get("allowedOrigins", ()):
        raise ArtifactError("ARTIFACT_SCOPE_DENIED")
    return task_id, generation


def _safe_record(value: dict) -> dict:
    return {key: value[key] for key in ("id", "filename", "mimeType", "size", "sha256", "origin")}


def _open_regular(path: Path) -> int:
    try:
        # 中文注释：先非阻塞打开再检查类型，FIFO 不能在检查前挂住上传或清单读取。
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ArtifactError("ARTIFACT_CHANGED")
        return fd
    except BaseException:
        if "fd" in locals():
            os.close(fd)
        raise ArtifactError("ARTIFACT_CHANGED") from None


def _read_manifest(path: Path) -> dict:
    fd = _open_regular(path)
    with os.fdopen(fd, "rb") as stream:
        data = stream.read(4097)
    if len(data) > 4096:
        raise ArtifactError("ARTIFACT_CHANGED")
    try:
        record = json.loads(data)
    except (UnicodeError, ValueError):
        raise ArtifactError("ARTIFACT_CHANGED") from None
    if not isinstance(record, dict) or set(record) != {
            "id", "owner", "taskId", "generation", "filename", "mimeType", "size", "sha256", "origin"}:
        raise ArtifactError("ARTIFACT_CHANGED")
    return record


class ArtifactStore:
    def __init__(self, home: Path):
        self.root = Path(home).resolve() / "plugin-data" / "browser-link-native" / "artifacts"

    def _directory(self, task_id: str, generation: int) -> Path:
        return self.root / task_id / str(generation)

    async def register(self, *, task: dict, owner: str, origin: str, file) -> dict:
        task_id, generation = _scope(task, owner, origin)
        filename = _name(file.filename)
        mime = file.content_type or "application/octet-stream"
        if mime not in _TYPES:
            raise ArtifactError("TYPE_DENIED")
        directory = _private_dir(self._directory(task_id, generation))
        if len(list(directory.glob("*.json"))) >= MAX_TASK_FILES:
            raise ArtifactError("ARTIFACT_LIMIT")
        artifact_id = str(uuid.uuid4())
        # 中文注释：每个文件独占 UUID 私有目录，末段保留原文件名供网页 file input 使用。
        blob_dir = _private_dir(directory / artifact_id)
        blob = blob_dir / filename
        manifest = directory / f"{artifact_id}.json"
        digest = hashlib.sha256()
        size = 0
        try:
            fd = os.open(blob, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "wb") as output:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_FILE_BYTES:
                        raise ArtifactError("SIZE_LIMIT")
                    digest.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            # 中文注释：用户文件只在完整写入后登记，失败的半文件不能成为可用凭据。
            with blob.open("rb") as source:
                prefix = source.read(8)
            if mime == "application/pdf" and not prefix.startswith(b"%PDF-"):
                raise ArtifactError("TYPE_MISMATCH")
            if mime == "image/png" and prefix != b"\x89PNG\r\n\x1a\n":
                raise ArtifactError("TYPE_MISMATCH")
            record = {"id": artifact_id, "owner": owner, "taskId": task_id,
                      "generation": generation, "filename": filename, "mimeType": mime,
                      "size": size, "sha256": digest.hexdigest(), "origin": origin}
            fd = os.open(manifest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "wb") as output:
                output.write(json.dumps(record, ensure_ascii=False).encode())
                output.flush()
                os.fsync(output.fileno())
            return _safe_record(record)
        except BaseException:
            blob.unlink(missing_ok=True)
            manifest.unlink(missing_ok=True)
            blob_dir.rmdir()
            raise

    def register_path(self, *, task: dict, owner: str, path: str) -> dict:
        """复制用户指定的本地文件到任务私有区；同名同摘要的文件复用已有登记。"""
        task_id, generation = _task_scope(task, owner)
        if not isinstance(path, str) or not path.startswith("/") or len(path) > 4096:
            raise ArtifactError("PATH_DENIED")
        try:
            source = Path(path).resolve(strict=True)
            # 中文注释：本地路径可能指向管道；普通文件不受非阻塞标志影响。
            fd = os.open(source, os.O_RDONLY | os.O_NONBLOCK)
        except OSError:
            raise ArtifactError("PATH_UNAVAILABLE") from None
        # 中文注释：先按打开后的文件描述符核对类型；目录等路径只返回固定错误码。
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise ArtifactError("PATH_DENIED")
        try:
            directory = _private_dir(self._directory(task_id, generation))
        except BaseException:
            os.close(fd)
            raise
        artifact_id = str(uuid.uuid4())
        # 中文注释：复制到 UUID 隔离目录并保留文件名，浏览器向网站提供的名称才与用户指定文件一致。
        try:
            filename = _name(source.name)
            blob_dir = _private_dir(directory / artifact_id)
        except BaseException:
            os.close(fd)
            raise
        blob = blob_dir / filename
        manifest = directory / f"{artifact_id}.json"
        try:
            with os.fdopen(fd, "rb") as reader:
                info = os.fstat(reader.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise ArtifactError("PATH_DENIED")
                if info.st_size > MAX_FILE_BYTES:
                    raise ArtifactError("SIZE_LIMIT")
                mime = _SUFFIX_TYPES.get(source.suffix.lower(), "application/octet-stream")
                digest, size = hashlib.sha256(), 0
                out = os.open(blob, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                with os.fdopen(out, "wb") as output:
                    while chunk := reader.read(1024 * 1024):
                        size += len(chunk)
                        if size > MAX_FILE_BYTES:
                            raise ArtifactError("SIZE_LIMIT")
                        digest.update(chunk)
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
            sha256 = digest.hexdigest()
            for existing in self.list(task=task, owner=owner):
                if (existing["origin"] == LOCAL_PATH_ORIGIN and existing["sha256"] == sha256
                        and existing["filename"] == filename):
                    blob.unlink(missing_ok=True)
                    blob_dir.rmdir()
                    return existing
            if len(list(directory.glob("*.json"))) >= MAX_TASK_FILES:
                raise ArtifactError("ARTIFACT_LIMIT")
            record = {"id": artifact_id, "owner": owner, "taskId": task_id, "generation": generation,
                      "filename": filename, "mimeType": mime, "size": size, "sha256": sha256,
                      "origin": LOCAL_PATH_ORIGIN}
            out = os.open(manifest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(out, "wb") as output:
                output.write(json.dumps(record, ensure_ascii=False).encode())
                output.flush()
                os.fsync(output.fileno())
            return _safe_record(record)
        except BaseException:
            blob.unlink(missing_ok=True)
            manifest.unlink(missing_ok=True)
            blob_dir.rmdir()
            raise

    def list(self, *, task: dict, owner: str) -> list[dict]:
        task_id, generation = _task_scope(task, owner)
        directory = self._directory(task_id, generation)
        if not directory.exists():
            return []
        if directory.is_symlink() or not directory.is_dir():
            raise ArtifactError("STORAGE_UNAVAILABLE")
        result = []
        for path in sorted(directory.glob("*.json"))[:MAX_TASK_FILES + 1]:
            record = _read_manifest(path)
            if record.get("owner") != owner or record.get("taskId") != task_id or record.get("generation") != generation:
                raise ArtifactError("ARTIFACT_SCOPE_DENIED")
            result.append(_safe_record(record))
        if len(result) > MAX_TASK_FILES:
            raise ArtifactError("ARTIFACT_LIMIT")
        return result

    def resolve(self, *, task: dict, owner: str, origin: str, artifact_id: str) -> tuple[dict, Path]:
        task_id, generation = (_task_scope(task, owner) if origin == LOCAL_PATH_ORIGIN else _scope(task, owner, origin))
        if not isinstance(artifact_id, str) or not _UUID.fullmatch(artifact_id):
            raise ArtifactError("INVALID_ARTIFACT")
        directory = self._directory(task_id, generation)
        if directory.is_symlink() or not directory.is_dir():
            raise ArtifactError("STORAGE_UNAVAILABLE")
        record = _read_manifest(directory / f"{artifact_id}.json")
        if (record.get("id") != artifact_id or record.get("owner") != owner
                or record.get("taskId") != task_id or record.get("generation") != generation
                or record.get("origin") != origin or record.get("mimeType") not in _TYPES
                or record.get("filename") != _name(record.get("filename"))
                or type(record.get("size")) is not int or not 0 <= record["size"] <= MAX_FILE_BYTES
                or not isinstance(record.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", record["sha256"])):
            raise ArtifactError("ARTIFACT_SCOPE_DENIED")
        blob_dir = directory / artifact_id
        if blob_dir.is_symlink() or not blob_dir.is_dir():
            raise ArtifactError("ARTIFACT_CHANGED")
        blob = blob_dir / record["filename"]
        fd = _open_regular(blob)
        with os.fdopen(fd, "rb") as source:
            digest = hashlib.sha256()
            size = 0
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise ArtifactError("ARTIFACT_CHANGED")
                digest.update(chunk)
        if size != record["size"] or digest.hexdigest() != record["sha256"]:
            raise ArtifactError("ARTIFACT_CHANGED")
        return _safe_record(record), blob
