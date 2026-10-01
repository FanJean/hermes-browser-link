#!/usr/bin/env python3
"""Chromium Native Messaging host forwarding framed JSON to the local UDS."""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import struct
import sys
import threading
from typing import Any, Dict

from client import ensure_service

_MAX_MESSAGE = 1024 * 1024


def _read_exact(stream, size: int) -> bytes:
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_native_message(stream) -> Dict[str, Any]:
    size = struct.unpack("<I", _read_exact(stream, 4))[0]
    if size > _MAX_MESSAGE:
        raise ValueError("native message exceeds limit")
    value = json.loads(_read_exact(stream, size))
    if not isinstance(value, dict):
        raise ValueError("native message must be an object")
    return value


def write_native_message(stream, value: Dict[str, Any], lock: threading.Lock) -> None:
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > _MAX_MESSAGE:
        raise ValueError("native message exceeds limit")
    with lock:
        stream.write(struct.pack("<I", len(payload)))
        stream.write(payload)
        stream.flush()


def _read_json_line(reader) -> Dict[str, Any]:
    line = reader.readline(_MAX_MESSAGE + 1)
    if not line:
        raise EOFError
    if len(line) > _MAX_MESSAGE or not line.endswith(b"\n"):
        raise ValueError("invalid bridge frame")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("bridge frame must be an object")
    return value


def _write_json_line(sock: socket.socket, value: Dict[str, Any], lock: threading.Lock) -> None:
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > _MAX_MESSAGE:
        raise ValueError("bridge frame exceeds limit")
    with lock:
        sock.sendall(payload + b"\n")


def _load_allowed_origins(data_dir: Path) -> set[str]:
    config_path = data_dir / "host-config.json"
    try:
        value = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return set()
    origins = value.get("allowedOrigins", []) if isinstance(value, dict) else []
    return {origin for origin in origins if isinstance(origin, str)}


def main() -> int:
    if len(sys.argv) < 2:
        return 2
    origin = sys.argv[1]
    home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).expanduser()
    data_dir = home / "plugin-data" / "browser-link-native"
    if origin not in _load_allowed_origins(data_dir):
        return 3

    ensure_service(home)
    token = (data_dir / "token").read_text(encoding="ascii").strip()
    bridge = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    bridge.connect(str(data_dir / "bridge.sock"))
    bridge_reader = bridge.makefile("rb")
    socket_write_lock = threading.Lock()
    native_write_lock = threading.Lock()
    _write_json_line(bridge, {"role": "extension", "token": token, "origin": origin}, socket_write_lock)

    stopped = threading.Event()

    def native_to_bridge() -> None:
        try:
            while not stopped.is_set():
                _write_json_line(bridge, read_native_message(sys.stdin.buffer), socket_write_lock)
        except (EOFError, OSError, ValueError, json.JSONDecodeError):
            pass
        finally:
            stopped.set()
            try:
                bridge.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def bridge_to_native() -> None:
        try:
            while not stopped.is_set():
                write_native_message(sys.stdout.buffer, _read_json_line(bridge_reader), native_write_lock)
        except (EOFError, OSError, ValueError, json.JSONDecodeError):
            pass
        finally:
            stopped.set()

    input_thread = threading.Thread(target=native_to_bridge, daemon=True)
    output_thread = threading.Thread(target=bridge_to_native, daemon=True)
    input_thread.start()
    output_thread.start()
    while not stopped.wait(0.1):
        pass
    bridge_reader.close()
    bridge.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
