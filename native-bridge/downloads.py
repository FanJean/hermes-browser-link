"""任务下载登记与领取；本地路径只留在 daemon 私有状态，普通结果只含元信息。"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time
import uuid


MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
MAX_TASK_DOWNLOADS = 50
STAGING_TTL_SECONDS = 24 * 3600
_KEY = re.compile(r"^[0-9a-f]{16}$")
_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_STATES = frozenset({"in_progress", "unknown", "complete", "interrupted", "cancelled", "rejected_size",
                     "rejected_limit", "claimed", "expired", "missing"})
_PUBLIC = ("id", "filename", "state", "mimeType", "bytesReceived", "totalBytes", "origin",
           "startedAt", "completedAt", "claimedAt", "sha256", "size", "reason")


class DownloadError(ValueError):
    """固定错误码；不回传底层路径或文件内容。"""


def new_download_key() -> str:
    return secrets.token_hex(8)


def safe_name(value) -> str:
    raw = str(value or "").replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f\x7f<>:\"|?*]", "_", raw).lstrip(". ").strip()
    return (name or "download")[:180]


def public_record(record: dict) -> dict:
    return {key: record[key] for key in _PUBLIC if key in record}


def _origin(url) -> str | None:
    from urllib.parse import urlsplit
    if not isinstance(url, str):
        return None
    target = url[5:] if url.startswith("blob:") else url
    parts = urlsplit(target)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}"


def _int(value, default=-1):
    return value if type(value) is int and value >= -1 else default


def _staged_path(path, key: str) -> Path:
    """浏览器写入的暂存文件必须恰好位于 hermes-tasks/<任务下载键>/ 下，且为本用户的普通文件。"""
    if not isinstance(path, str) or not path.startswith("/") or len(path) > 4096 or "\x00" in path:
        raise DownloadError("DOWNLOAD_PATH_DENIED")
    candidate = Path(path)
    if candidate.parent.name != key or candidate.parent.parent.name != "hermes-tasks":
        raise DownloadError("DOWNLOAD_PATH_DENIED")
    for item in (candidate.parent.parent, candidate.parent):
        if item.is_symlink() or not item.is_dir():
            raise DownloadError("DOWNLOAD_PATH_DENIED")
    return candidate


def _open_staged(path: Path) -> int:
    try:
        # 中文注释：暂存文件被换成 FIFO 时立即按类型拒绝，不等待写端并占住任务锁。
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        raise DownloadError("DOWNLOAD_MISSING") from None
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        os.close(fd)
        raise DownloadError("DOWNLOAD_CHANGED")
    return fd


class DownloadRegistry:
    """每个任务的下载元信息保存在任务记录的私有字段 ``downloads``。"""

    def __init__(self, home: Path, clock=time.time):
        self.root = Path(home).resolve() / "plugin-data" / "browser-link-native" / "downloads"
        self.clock = clock

    @staticmethod
    def rows(task: dict) -> list:
        rows = task.setdefault("downloads", [])
        return rows if isinstance(rows, list) else []

    def find(self, task: dict, *, download_id=None, ref=None) -> dict | None:
        for row in self.rows(task):
            if download_id is not None and row.get("id") == download_id:
                return row
            if ref is not None and row.get("ref") == ref and row.get("generation") == task.get("generation"):
                return row
        return None

    def event(self, task: dict, params: dict) -> dict | None:
        """应用扩展报告的一次下载事件；返回受影响的记录（无效事件抛出固定错误码）。"""
        event = params.get("event")
        key = task.get("downloadKey")
        if not isinstance(key, str) or not _KEY.fullmatch(key):
            raise DownloadError("DOWNLOAD_SCOPE_DENIED")
        now = self.clock()
        if event == "ambiguous":
            # 中文注释：歧义下载不认领，只留下任务可见的“归属未知”计数。
            task["downloadsUnattributed"] = min(int(task.get("downloadsUnattributed", 0)) + 1, 1000)
            return None
        ref = params.get("downloadRef")
        if type(ref) is not int or ref < 0:
            raise DownloadError("DOWNLOAD_INVALID")
        row = self.find(task, ref=ref)
        if event == "attributed":
            if row is not None:
                return row
            if len(self.rows(task)) >= MAX_TASK_DOWNLOADS:
                raise DownloadError("DOWNLOAD_LIMIT")
            origin = _origin(params.get("url"))
            if origin is None or origin not in task.get("allowedOrigins", ()):
                # 中文注释：来源不在授权范围的下载不登记为任务文件。
                raise DownloadError("DOWNLOAD_SCOPE_DENIED")
            row = {"id": str(uuid.uuid4()), "ref": ref, "generation": task["generation"], "key": key,
                   "tabId": params.get("tabId"), "filename": safe_name(params.get("filename")),
                   "mimeType": str(params.get("mimeType") or "")[:128], "origin": origin,
                   "state": "in_progress", "bytesReceived": 0,
                   "totalBytes": _int(params.get("totalBytes")), "startedAt": now}
            self.rows(task).append(row)
            return row
        # 中文注释：同代次可信的迟到完成回执仍可澄清未知状态，未知不等于浏览器已取消。
        if row is None or row.get("state") not in {"in_progress", "unknown"}:
            return row
        if event == "progress":
            row["bytesReceived"] = max(0, _int(params.get("bytesReceived"), 0))
            row["totalBytes"] = _int(params.get("totalBytes"), row.get("totalBytes", -1))
            return row
        if event == "complete":
            size = params.get("fileSize") if type(params.get("fileSize")) is int else params.get("bytesReceived")
            danger = params.get("danger")
            try:
                path = _staged_path(params.get("path"), key)
            except DownloadError:
                row.update(state="interrupted", reason="path_denied", completedAt=now)
                return row
            if type(size) is not int or size < 0 or size > MAX_DOWNLOAD_BYTES:
                row.update(state="rejected_size", completedAt=now)
                return row
            if danger not in {"safe", "accepted"}:
                row.update(state="interrupted", reason="danger", completedAt=now)
                return row
            row.update(state="complete", path=str(path), filename=safe_name(path.name), bytesReceived=size,
                       totalBytes=size, completedAt=now)
            row.pop("reason", None)
            return row
        if event in {"interrupted", "cancelled", "rejected_size", "rejected_limit"}:
            row.update(state=event, completedAt=now)
            if event == "interrupted":
                row["reason"] = str(params.get("error") or "unknown")[:64]
            return row
        raise DownloadError("DOWNLOAD_INVALID")

    def _claim_dir(self, task: dict, row: dict) -> Path:
        path = self.root / task["id"] / str(row["generation"]) / row["id"]
        for parent in reversed((path, *path.parents)):
            if parent.exists() and parent.is_symlink():
                raise DownloadError("STORAGE_UNAVAILABLE")
        path.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(path, 0o700)
        return path

    def claim(self, task: dict, download_id) -> tuple[dict, str]:
        """把完整下载移入私有领取目录并校验大小、摘要；中断或变化的文件不能领取。"""
        if not isinstance(download_id, str) or not _ID.fullmatch(download_id):
            raise DownloadError("DOWNLOAD_INVALID")
        row = self.find(task, download_id=download_id)
        if row is None:
            raise DownloadError("DOWNLOAD_NOT_FOUND")
        if row.get("state") == "claimed":
            return public_record(row), row["claimedPath"]
        if row.get("state") != "complete":
            raise DownloadError("DOWNLOAD_NOT_COMPLETE")
        source = _staged_path(row.get("path"), row.get("key", ""))
        # 中文注释：源句柄先交给上下文管理，目录或目标文件创建失败也会关闭；只删除本次创建的目标。
        digest = hashlib.sha256()
        size = 0
        with os.fdopen(_open_staged(source), "rb") as reader:
            destination = self._claim_dir(task, row) / row["filename"]
            out = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                with os.fdopen(out, "wb") as writer:
                    while chunk := reader.read(1024 * 1024):
                        size += len(chunk)
                        if size > MAX_DOWNLOAD_BYTES:
                            raise DownloadError("DOWNLOAD_CHANGED")
                        digest.update(chunk)
                        writer.write(chunk)
                    writer.flush()
                    os.fsync(writer.fileno())
                if size != row.get("bytesReceived"):
                    raise DownloadError("DOWNLOAD_CHANGED")
            except BaseException:
                destination.unlink(missing_ok=True)
                raise
        # 中文注释：复制并校验成功后才删除暂存副本；领取后的文件由用户保留，任务停止不删除。
        try:
            source.unlink()
        except OSError:
            pass
        row.update(state="claimed", claimedAt=self.clock(), sha256=digest.hexdigest(), size=size,
                   claimedPath=str(destination))
        row.pop("path", None)
        return public_record(row), str(destination)

    def expire(self, task: dict) -> int:
        """标记失效跟踪并清理超过 24 小时的完整暂存副本；已领取文件不动。"""
        # 中文注释：返回状态变化数；即使文件已不存在，调用方也必须持久化状态。
        changed = 0
        now = self.clock()
        for row in self.rows(task):
            # 中文注释：扩展已失去任务或代次时不猜测下载结果，也不取消或删除用户仍在进行的下载。
            if row.get("state") == "in_progress" and (
                    task.get("state") not in {"ready", "running", "paused"}
                    or row.get("generation") != task.get("generation")):
                row.update(state="unknown", reason="tracking_lost")
                changed += 1
            if row.get("state") != "complete" or now - float(row.get("completedAt", now)) < STAGING_TTL_SECONDS:
                continue
            try:
                source = _staged_path(row.get("path"), row.get("key", ""))
                fd = _open_staged(source)
                size = os.fstat(fd).st_size
                os.close(fd)
                if size == row.get("bytesReceived"):
                    source.unlink()
            except (DownloadError, OSError):
                pass
            row.update(state="expired")
            row.pop("path", None)
            changed += 1
        return changed


def dumps_public(rows) -> str:
    return json.dumps([public_record(row) for row in rows], ensure_ascii=False)
