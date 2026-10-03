"""Synthetic JSONL harness around the production BridgeDaemon dispatcher.

This process never starts a daemon socket or browser. A Node test supplies the
production extension Executor over JSONL when the daemon dispatches an extension
call; all browser APIs are in-memory fixtures.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import threading
import uuid

sys.path.insert(0, os.environ["BRIDGE_DIR"])
from daemon import BridgeDaemon, ProtocolError  # noqa: E402  # type: ignore[reportMissingImports]


def send(value: dict) -> None:
    with output_lock:
        sys.stdout.write(json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n")
        sys.stdout.flush()


output_lock = threading.Lock()
pending_lock = threading.Lock()
pending: dict[str, dict] = {}
bridge = BridgeDaemon(Path(os.environ["BRIDGE_TEST_HOME"]))
# 中文注释：原有恢复夹具固定 current 模式；独立窗口另有专门验收。
bridge.work_window_mode = "current"
# 中文注释：真实派发账本需要私有目录，普通快照仍用无副作用桩。
bridge._prepare_data_dir()
bridge._persist_tasks = lambda: None
bridge._notify_tasks_changed = lambda *_args: None
bridge._diagnostic = lambda *_args, **_kwargs: None
instance_id = "synthetic-instance"
extension = {
    "instanceId": instance_id,
    "browser": "chrome",
    "version": "synthetic-test",
    "origin": "chrome-extension://synthetic/",
    "socket": None,
    "sendLock": threading.RLock(),
    "pendingLock": threading.Lock(),
    "pending": {},
}
bridge.extensions[instance_id] = extension


def extension_call(_extension, method, params, timeout=5.0):
    request_id = uuid.uuid4().hex
    entry = {"event": threading.Event(), "response": None}
    with pending_lock:
        pending[request_id] = entry
    send({"type": "extension_call", "id": request_id, "method": method, "params": params})
    if not entry["event"].wait(timeout):
        with pending_lock:
            pending.pop(request_id, None)
        raise ProtocolError("extension_timeout", "synthetic extension response timed out")
    with pending_lock:
        pending.pop(request_id, None)
    response = entry["response"]
    if not isinstance(response, dict):
        raise ProtocolError("extension_disconnected", "synthetic extension disconnected")
    if "error" in response:
        error = response["error"] if isinstance(response["error"], dict) else {}
        raise ProtocolError(
            str(error.get("code", "extension_error")),
            str(error.get("message", "synthetic extension error")),
            error.get("data"),
        )
    return response.get("result")


bridge._extension_call = extension_call


def dispatch(message: dict) -> dict:
    try:
        if message.get("type") == "client":
            result = bridge._dispatch_client(message.get("method"), message.get("params"))
        elif message.get("type") == "extension":
            result = bridge._dispatch_extension(instance_id, message.get("method"), message.get("params"))
        else:
            raise ValueError("unknown synthetic command")
        return {"type": "result", "id": message.get("id"), "result": result}
    except ProtocolError as exc:
        return {
            "type": "result",
            "id": message.get("id"),
            "error": {"code": exc.code, "message": exc.message, "data": exc.data},
        }
    except Exception as exc:  # Make harness failures visible; never invent a protocol result.
        return {
            "type": "result",
            "id": message.get("id"),
            "error": {"code": "HARNESS_ERROR", "message": f"{type(exc).__name__}: {exc}"},
        }


def run_command(message: dict) -> None:
    send(dispatch(message))


send({"type": "ready"})
for raw_line in sys.stdin:
    try:
        message = json.loads(raw_line)
    except json.JSONDecodeError:
        send({"type": "protocol_error", "message": "invalid JSON input"})
        continue
    if not isinstance(message, dict):
        send({"type": "protocol_error", "message": "input must be an object"})
        continue
    if message.get("type") == "extension_response":
        request_id = message.get("id")
        if isinstance(request_id, str):
            with pending_lock:
                entry = pending.get(request_id)
                if entry is not None:
                    entry["response"] = message
                    entry["event"].set()
        continue
    if message.get("type") in {"client", "extension"}:
        threading.Thread(target=run_command, args=(message,), daemon=True).start()
    else:
        send({"type": "protocol_error", "message": "unknown input type"})
