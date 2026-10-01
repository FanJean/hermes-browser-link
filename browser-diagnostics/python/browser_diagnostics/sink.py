from __future__ import annotations

import errno
import fcntl
import json
import os
import re
import stat
import threading
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Mapping, Union

from .schema import SCHEMA_VERSION, UnsafeDiagnosticField, make_event, validate_event

PathLike = Union[str, os.PathLike]
_ACTIVE_NAME = "events.jsonl"
_LOCK_NAME = ".browser-diagnostics.lock"
_ROTATED_RE = re.compile(r"^events\.(\d{6})\.jsonl$")
_CORRUPT_RE = re.compile(r"^corrupt\.(\d{6})\.jsonl$")
_EXPORT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.zip$")
_THREAD_LOCKS: Dict[str, threading.RLock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()


class UnsafeLogPath(ValueError):
    """Raised when a diagnostics path can escape or follow a symlink."""


def _thread_lock_for(path: Path) -> threading.RLock:
    key = os.path.abspath(os.fspath(path))
    with _THREAD_LOCKS_GUARD:
        lock = _THREAD_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _THREAD_LOCKS[key] = lock
        return lock


def _is_regular_no_symlink(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)


class JsonlDiagnosticSink:
    """Private, bounded, process-safe JSONL storage for allowlisted events."""

    def __init__(self, root: PathLike, *, max_bytes: int = 1_048_576, max_files: int = 5):
        if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 512:
            raise ValueError("max_bytes must be an integer of at least 512")
        if isinstance(max_files, bool) or not isinstance(max_files, int) or not 1 <= max_files <= 100:
            raise ValueError("max_files must be between 1 and 100")
        self.root = Path(root)
        self.max_bytes = max_bytes
        self.max_files = max_files
        self._thread_lock = _thread_lock_for(self.root)
        self._ensure_private_directory(self.root)
        self._ensure_owned_regular_file(self.root / _LOCK_NAME)
        with self._locked():
            self._assert_owned_paths_safe_locked()
            if self._recover_corrupt_active_locked():
                self._record_recovery_locked()
            self._enforce_retention_locked()

    @staticmethod
    def _ensure_private_directory(path: Path) -> None:
        try:
            parent_info = path.parent.lstat()
        except FileNotFoundError:
            cursor = path.parent
            while True:
                try:
                    parent_info = cursor.lstat()
                    break
                except FileNotFoundError:
                    if cursor == cursor.parent:
                        raise UnsafeLogPath("no safe existing parent for diagnostics directory")
                    cursor = cursor.parent
        if stat.S_ISLNK(parent_info.st_mode) or not stat.S_ISDIR(parent_info.st_mode):
            raise UnsafeLogPath("diagnostics parent must be a real directory")
        try:
            info = path.lstat()
        except FileNotFoundError:
            try:
                path.mkdir(mode=0o700, parents=True)
            except FileExistsError:
                pass
            info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise UnsafeLogPath("diagnostics root must be a real directory")
        os.chmod(path, 0o700, follow_symlinks=False)

    @staticmethod
    def _open_owned_file(path: Path, flags: int) -> int:
        nofollow = getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(path, flags | os.O_CREAT | nofollow, 0o600)
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.EMLINK):
                raise UnsafeLogPath(f"refusing symlink path: {path.name}") from exc
            raise
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise UnsafeLogPath(f"owned path is not a regular file: {path.name}")
            os.fchmod(fd, 0o600)
            return fd
        except BaseException:
            os.close(fd)
            raise

    def _ensure_owned_regular_file(self, path: Path) -> None:
        fd = self._open_owned_file(path, os.O_RDWR)
        os.close(fd)

    @contextmanager
    def _locked(self) -> Iterator[None]:
        with self._thread_lock:
            fd = self._open_owned_file(self.root / _LOCK_NAME, os.O_RDWR)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)

    @staticmethod
    def _owned_data_name(name: str) -> bool:
        return name == _ACTIVE_NAME or bool(_ROTATED_RE.fullmatch(name)) or bool(_CORRUPT_RE.fullmatch(name))

    def _assert_owned_paths_safe_locked(self) -> None:
        for entry in self.root.iterdir():
            if entry.name == _LOCK_NAME or self._owned_data_name(entry.name):
                if not _is_regular_no_symlink(entry):
                    raise UnsafeLogPath(f"owned diagnostics path is not a regular file: {entry.name}")
                os.chmod(entry, 0o600, follow_symlinks=False)

    def _next_serial_locked(self) -> int:
        highest = 0
        for entry in self.root.iterdir():
            match = _ROTATED_RE.fullmatch(entry.name) or _CORRUPT_RE.fullmatch(entry.name)
            if match:
                highest = max(highest, int(match.group(1)))
        return highest + 1

    def _active_is_valid_locked(self, active: Path) -> bool:
        if not active.exists():
            return True
        if not _is_regular_no_symlink(active):
            raise UnsafeLogPath("active log is not a regular file")
        with active.open("rb") as stream:
            for raw_line in stream:
                if not raw_line.endswith(b"\n"):
                    return False
                try:
                    value = json.loads(raw_line.decode("utf-8"))
                    validate_event(value)
                except (UnicodeDecodeError, json.JSONDecodeError, UnsafeDiagnosticField):
                    return False
        return True

    def _recover_corrupt_active_locked(self) -> bool:
        recovered = False
        active = self.root / _ACTIVE_NAME
        if not self._active_is_valid_locked(active):
            active.unlink()
            recovered = True
        for entry in list(self.root.iterdir()):
            if _CORRUPT_RE.fullmatch(entry.name):
                if not _is_regular_no_symlink(entry):
                    raise UnsafeLogPath(f"refusing unsafe corrupt path: {entry.name}")
                entry.unlink()
                recovered = True
        return recovered

    @staticmethod
    def _serialize_event(event: Mapping[str, Any]) -> bytes:
        validated = validate_event(event)
        return json.dumps(validated, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii") + b"\n"

    def _append_line_locked(self, line: bytes) -> None:
        self._rotate_if_needed_locked(len(line))
        fd = self._open_owned_file(self.root / _ACTIVE_NAME, os.O_WRONLY | os.O_APPEND)
        try:
            written = os.write(fd, line)
            if written != len(line):
                raise OSError("short diagnostic log write")
            os.fsync(fd)
        finally:
            os.close(fd)

    def _record_recovery_locked(self) -> None:
        event = make_event(
            component="diagnostics",
            event_type="sink_state",
            task_id=None,
            request_id=None,
            connection_id=None,
            generation=None,
            status="recovered",
            duration_ms=None,
            error_code=None,
        )
        self._append_line_locked(self._serialize_event(event))

    def _owned_data_files_locked(self) -> List[Path]:
        files = []
        for entry in self.root.iterdir():
            if self._owned_data_name(entry.name):
                if not _is_regular_no_symlink(entry):
                    raise UnsafeLogPath(f"refusing unsafe owned path: {entry.name}")
                files.append(entry)
        return files

    def _enforce_retention_locked(self) -> None:
        files = self._owned_data_files_locked()
        inactive = [path for path in files if path.name != _ACTIVE_NAME]
        inactive.sort(key=lambda path: (path.stat().st_mtime_ns, path.name))
        while len(files) > self.max_files and inactive:
            victim = inactive.pop(0)
            victim.unlink()
            files.remove(victim)

    def _rotate_if_needed_locked(self, line_size: int) -> None:
        if line_size > self.max_bytes:
            raise ValueError("one diagnostic event exceeds max_bytes")
        active = self.root / _ACTIVE_NAME
        if not active.exists() or active.stat().st_size == 0:
            return
        if active.stat().st_size + line_size <= self.max_bytes:
            return
        serial = self._next_serial_locked()
        rotated = self.root / f"events.{serial:06d}.jsonl"
        os.replace(active, rotated)
        os.chmod(rotated, 0o600, follow_symlinks=False)

    def write(self, event: Mapping[str, Any]) -> None:
        line = self._serialize_event(event)
        with self._locked():
            self._assert_owned_paths_safe_locked()
            if self._recover_corrupt_active_locked():
                self._record_recovery_locked()
            self._append_line_locked(line)
            self._enforce_retention_locked()

    def _ordered_event_logs_locked(self) -> List[Path]:
        rotated = []
        active = None
        for entry in self._owned_data_files_locked():
            match = _ROTATED_RE.fullmatch(entry.name)
            if match:
                rotated.append((int(match.group(1)), entry))
            elif entry.name == _ACTIVE_NAME:
                active = entry
        rotated.sort(key=lambda pair: pair[0])
        paths = [entry for _, entry in rotated]
        if active is not None:
            paths.append(active)
        return paths

    def read_validated_events(self) -> List[Dict[str, Any]]:
        with self._locked():
            self._assert_owned_paths_safe_locked()
            if self._recover_corrupt_active_locked():
                self._record_recovery_locked()
            records: List[Dict[str, Any]] = []
            for path in self._ordered_event_logs_locked():
                with path.open("rb") as stream:
                    for raw_line in stream:
                        try:
                            decoded = json.loads(raw_line.decode("utf-8"))
                            records.append(validate_event(decoded))
                        except (UnicodeDecodeError, json.JSONDecodeError, UnsafeDiagnosticField):
                            continue
            return records

    def export_bundle(self, output_dir: PathLike, bundle_name: str = "browser-diagnostics-export.zip") -> Path:
        if not isinstance(bundle_name, str) or not _EXPORT_RE.fullmatch(bundle_name):
            raise UnsafeLogPath("bundle_name must be a plain safe .zip filename")
        destination_dir = Path(output_dir)
        self._ensure_private_directory(destination_dir)
        destination = destination_dir / bundle_name
        if destination.exists() or destination.is_symlink():
            raise UnsafeLogPath("refusing to overwrite export bundle")
        events = self.read_validated_events()
        jsonl = b"".join(
            json.dumps(event, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii") + b"\n"
            for event in events
        )
        manifest = json.dumps(
            {
                "schema_version": SCHEMA_VERSION,
                "bundle_format": "browser.diagnostics.export/v1",
                "event_count": len(events),
                "redaction": "strict_allowlist",
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
        nofollow = getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(destination, os.O_RDWR | os.O_CREAT | os.O_EXCL | nofollow, 0o600)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w+b", closefd=False) as stream:
                with zipfile.ZipFile(stream, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
                    archive.writestr("events.jsonl", jsonl)
                    archive.writestr("manifest.json", manifest)
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            try:
                destination.unlink()
            except FileNotFoundError:
                pass
            raise
        finally:
            os.close(fd)
        return destination

    def cleanup(self) -> List[str]:
        removed: List[str] = []
        with self._locked():
            self._assert_owned_paths_safe_locked()
            for path in self._owned_data_files_locked():
                path.unlink()
                removed.append(path.name)
        return sorted(removed)
