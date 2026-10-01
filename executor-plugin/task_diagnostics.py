"""Owner-scoped, read-only projection over the canonical diagnostics v1 sink.

Only persisted, schema-validated events are projected; no log history is
fabricated or backfilled by this module.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import stat
import threading
from typing import Any, Generator, Mapping, Optional

from browser_diagnostics import UnsafeDiagnosticField, make_event, validate_event

_HASH_RE = re.compile(r"^[a-f0-9]{64}$")
_OPAQUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_EVENT_FIELDS = ("timestamp", "component", "event_type", "status", "duration_ms", "error_code", "action")
_ACTIVE_NAME = "events.jsonl"
_LOCK_NAME = ".browser-diagnostics.lock"
_ROTATED_RE = re.compile(r"^events\.(\d{6})\.jsonl$")
_MAX_STORE_BYTES = 100 * 1024 * 1024
_MAX_EVENT_LINE_BYTES = 64 * 1024
# 中文注释：接管中的 paused 是有效任务状态。
_EXECUTION_STATES = frozenset({
    "pending_approval", "running", "ready", "paused", "cancelled", "closed", "failed", "needs_sync"
})
_CLEANUP_STATES = frozenset({"succeeded", "pending", "unknown", "failed"})


class DiagnosticTaskNotFound(PermissionError):
    """The task is missing or is not owned by the supplied trusted owner."""


class DiagnosticCapacityError(ValueError):
    """A configured diagnostics capacity or page limit has been reached."""


class DiagnosticStorageError(OSError):
    """The canonical event files could not be read without mutation."""


class TaskDiagnosticProjection:
    """Bind opaque request correlations and expose redacted task diagnostics."""

    def __init__(self, sink: Any, *, max_bindings: int = 2048, max_page_size: int = 100):
        if isinstance(max_bindings, bool) or not isinstance(max_bindings, int) or not 1 <= max_bindings <= 100_000:
            raise ValueError("max_bindings must be between 1 and 100000")
        if isinstance(max_page_size, bool) or not isinstance(max_page_size, int) or not 1 <= max_page_size <= 100:
            raise ValueError("max_page_size must be between 1 and 100")
        sink_max_bytes = getattr(sink, "max_bytes", None)
        sink_max_files = getattr(sink, "max_files", None)
        if (isinstance(sink_max_bytes, bool) or not isinstance(sink_max_bytes, int) or sink_max_bytes < 512
                or isinstance(sink_max_files, bool) or not isinstance(sink_max_files, int)
                or not 1 <= sink_max_files <= 100 or sink_max_bytes * sink_max_files > _MAX_STORE_BYTES):
            raise ValueError("diagnostics sink limits exceed the bounded projection capacity")
        self.sink = sink
        self._store_max_bytes = sink_max_bytes * sink_max_files
        self._max_file_bytes = sink_max_bytes
        self.max_bindings = max_bindings
        self.max_page_size = max_page_size
        self._bindings = {}
        self._lock = threading.RLock()

    @staticmethod
    def _opaque(value: Any) -> bool:
        return isinstance(value, str) and bool(_OPAQUE_RE.fullmatch(value))

    @staticmethod
    def _task(tasks: Any, task_id: str) -> Optional[Mapping[str, Any]]:
        if isinstance(tasks, Mapping):
            if tasks.get("id") == task_id:
                return tasks
            candidate = tasks.get(task_id)
            if isinstance(candidate, Mapping) and candidate.get("id") == task_id:
                return candidate
            for candidate in tasks.values():
                if isinstance(candidate, Mapping) and candidate.get("id") == task_id:
                    return candidate
        elif isinstance(tasks, (list, tuple)):
            for candidate in tasks:
                if isinstance(candidate, Mapping) and candidate.get("id") == task_id:
                    return candidate
        return None

    @classmethod
    def _owned_task(cls, tasks: Any, owner: str, task_id: str) -> Mapping[str, Any]:
        task = cls._task(tasks, task_id) if cls._opaque(owner) and cls._opaque(task_id) else None
        if task is None or task.get("owner") != owner:
            raise DiagnosticTaskNotFound("task diagnostics unavailable")
        return task

    @staticmethod
    def _request_hashes(task: Mapping[str, Any]) -> set[str]:
        history = task.get("requestHistory")
        if not isinstance(history, list):
            return set()
        return {
            item["requestIdHash"] for item in history
            if isinstance(item, Mapping)
            and isinstance(item.get("requestIdHash"), str)
            and _HASH_RE.fullmatch(item["requestIdHash"])
        }

    def bind(
        self,
        tasks: Any,
        owner: str,
        task_id: str,
        request_id: str,
        *,
        request_id_hash: Optional[str] = None,
    ) -> None:
        task = self._owned_task(tasks, owner, task_id)
        if not self._opaque(request_id):
            raise ValueError("request correlation must be opaque")
        if request_id_hash is not None:
            if not isinstance(request_id_hash, str) or not _HASH_RE.fullmatch(request_id_hash):
                raise ValueError("request_id_hash must be a SHA-256 digest")
            if request_id_hash not in self._request_hashes(task):
                raise DiagnosticTaskNotFound("task diagnostics unavailable")
        key = (owner, task_id, request_id)
        with self._lock:
            existing = self._bindings.get(key, request_id_hash)
            if existing != request_id_hash:
                raise ValueError("request correlation is already bound")
            if key not in self._bindings and len(self._bindings) >= self.max_bindings:
                raise DiagnosticCapacityError("diagnostic correlation capacity reached")
            self._bindings[key] = request_id_hash

    def record(
        self,
        tasks: Any,
        owner: str,
        task_id: str,
        *,
        component: str,
        event_type: str,
        status: str,
        request_id: Optional[str] = None,
        request_id_hash: Optional[str] = None,
        connection_id: Optional[str] = None,
        generation: Optional[str] = None,
        duration_ms: Optional[float] = None,
        error_code: Optional[str] = None,
        action: Optional[str] = None,
    ) -> dict[str, Any]:
        """Validate, persist, and bind one strict-schema event for an owned task."""
        task = self._owned_task(tasks, owner, task_id)
        if request_id is not None and not self._opaque(request_id):
            raise UnsafeDiagnosticField("request_id must be an opaque identifier")
        if request_id_hash is not None:
            if request_id is None or not isinstance(request_id_hash, str) or not _HASH_RE.fullmatch(request_id_hash):
                raise UnsafeDiagnosticField("request correlation requires a SHA-256 digest and opaque id")
            if request_id_hash not in self._request_hashes(task):
                raise DiagnosticTaskNotFound("task diagnostics unavailable")
        event_request_id = request_id_hash if request_id_hash is not None else request_id
        event = make_event(
            component=component,
            event_type=event_type,
            task_id=task_id,
            request_id=event_request_id,
            connection_id=connection_id,
            generation=generation,
            status=status,
            duration_ms=duration_ms,
            error_code=error_code,
            action=action,
        )
        with self._lock:
            self.sink.write(event)
        return event

    @staticmethod
    def _error_code(error: BaseException) -> str:
        """Map exception types only; never inspect args, str(), or repr()."""
        if isinstance(error, TimeoutError):
            return "TIMEOUT"
        if isinstance(error, PermissionError):
            return "PERMISSION_DENIED"
        if isinstance(error, ConnectionError):
            return "DISCONNECTED"
        if isinstance(error, ValueError):
            return "VALIDATION_ERROR"
        if isinstance(error, OSError):
            return "TRANSPORT_ERROR"
        return "UNCLASSIFIED_ERROR"

    def record_exception(
        self,
        tasks: Any,
        owner: str,
        task_id: str,
        *,
        component: str,
        event_type: str,
        error: BaseException,
        request_id: Optional[str] = None,
        request_id_hash: Optional[str] = None,
        connection_id: Optional[str] = None,
        generation: Optional[str] = None,
        duration_ms: Optional[float] = None,
        status: str = "failed",
    ) -> dict[str, Any]:
        """Persist only a fixed error code, never exception text or arguments."""
        return self.record(
            tasks,
            owner,
            task_id,
            component=component,
            event_type=event_type,
            status=status,
            request_id=request_id,
            request_id_hash=request_id_hash,
            connection_id=connection_id,
            generation=generation,
            duration_ms=duration_ms,
            error_code=self._error_code(error),
        )

    def _read_events_readonly(self) -> Generator[dict[str, Any], None, None]:
        """Read a lock-coordinated snapshot without sink recovery or file writes."""
        thread_lock = getattr(self.sink, "_thread_lock", None)
        if thread_lock is None:
            raise DiagnosticStorageError("diagnostics sink has no coordinated lock")
        root_fd = -1
        lock_fd = -1
        nofollow = getattr(os, "O_NOFOLLOW", 0)
        root_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | nofollow
        try:
            with thread_lock:
                root_fd = os.open(os.fspath(self.sink.root), root_flags)
                root_info = os.fstat(root_fd)
                if not stat.S_ISDIR(root_info.st_mode) or stat.S_IMODE(root_info.st_mode) & 0o077:
                    raise DiagnosticStorageError("diagnostics root is not private")
                lock_fd = os.open(_LOCK_NAME, os.O_RDONLY | nofollow, dir_fd=root_fd)
                lock_info = os.fstat(lock_fd)
                if not stat.S_ISREG(lock_info.st_mode) or stat.S_IMODE(lock_info.st_mode) & 0o077:
                    raise DiagnosticStorageError("diagnostics lock is not private")
                fcntl.flock(lock_fd, fcntl.LOCK_SH)
                rotated = []
                active = False
                for name in os.listdir(root_fd):
                    match = _ROTATED_RE.fullmatch(name)
                    if match:
                        rotated.append((int(match.group(1)), name))
                    elif name == _ACTIVE_NAME:
                        active = True
                names = [name for _, name in sorted(rotated)]
                if active:
                    names.append(_ACTIVE_NAME)
                bytes_read = 0
                for name in names:
                    event_fd = os.open(name, os.O_RDONLY | nofollow, dir_fd=root_fd)
                    try:
                        event_info = os.fstat(event_fd)
                        if not stat.S_ISREG(event_info.st_mode) or stat.S_IMODE(event_info.st_mode) & 0o077:
                            raise DiagnosticStorageError("diagnostics event file is not private")
                        file_bytes = 0
                        with os.fdopen(event_fd, "rb", closefd=False) as stream:
                            while True:
                                raw_line = stream.readline(min(self._max_file_bytes, _MAX_EVENT_LINE_BYTES) + 1)
                                if not raw_line:
                                    break
                                file_bytes += len(raw_line)
                                bytes_read += len(raw_line)
                                if file_bytes > self._max_file_bytes or bytes_read > self._store_max_bytes:
                                    raise DiagnosticStorageError("diagnostics store exceeds its configured bound")
                                if len(raw_line) > _MAX_EVENT_LINE_BYTES:
                                    raise DiagnosticStorageError("diagnostic event line exceeds its hard bound")
                                if not raw_line.endswith(b"\n"):
                                    continue
                                try:
                                    decoded = json.loads(raw_line.decode("utf-8"))
                                    validated = validate_event(decoded)
                                except (UnicodeDecodeError, json.JSONDecodeError, UnsafeDiagnosticField, TypeError):
                                    continue
                                yield validated
                    finally:
                        os.close(event_fd)
                return
        except DiagnosticStorageError:
            raise
        except OSError as exc:
            raise DiagnosticStorageError("diagnostics store is unavailable") from exc
        finally:
            if lock_fd >= 0:
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                finally:
                    os.close(lock_fd)
            if root_fd >= 0:
                os.close(root_fd)

    def query(
        self,
        tasks: Any,
        owner: str,
        task_id: str,
        request_id_hash: Optional[str] = None,
        *,
        limit: int = 50,
        cursor: int = 0,
    ) -> dict[str, Any]:
        task = self._owned_task(tasks, owner, task_id)
        if request_id_hash is not None:
            if not isinstance(request_id_hash, str) or not _HASH_RE.fullmatch(request_id_hash):
                raise ValueError("request_id_hash must be a SHA-256 digest")
            if request_id_hash not in self._request_hashes(task):
                raise DiagnosticTaskNotFound("task diagnostics unavailable")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= self.max_page_size:
            raise DiagnosticCapacityError("diagnostic page limit is outside the allowed range")
        if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 0:
            raise ValueError("diagnostic cursor must be a non-negative integer")
        with self._lock:
            bindings = {
                request_id: bound_hash
                for (bound_owner, bound_task, request_id), bound_hash in self._bindings.items()
                if bound_owner == owner and bound_task == task_id
            }
        page = []
        matched_count = 0
        has_more = False
        reader = self._read_events_readonly()
        try:
            for event in reader:
                request_id = event["request_id"]
                task_match = event["task_id"] == task_id or (
                    event["task_id"] is None and request_id in bindings
                )
                if not task_match:
                    continue
                if request_id_hash is not None and request_id != request_id_hash:
                    if bindings.get(request_id) != request_id_hash:
                        continue
                if matched_count < cursor:
                    matched_count += 1
                    continue
                if len(page) >= limit:
                    has_more = True
                    break
                page.append({name: event[name] for name in _EVENT_FIELDS})
                matched_count += 1
        finally:
            reader.close()
        next_cursor = cursor + len(page) if has_more else None
        execution_state = task.get("state")
        cleanup_state = task.get("cleanupState")
        return {
            "events": page,
            "execution_state": execution_state if isinstance(execution_state, str) and execution_state in _EXECUTION_STATES else "unknown",
            "cleanup_state": cleanup_state if isinstance(cleanup_state, str) and cleanup_state in _CLEANUP_STATES else "unknown",
            "has_more": next_cursor is not None,
            "next_cursor": next_cursor,
        }
