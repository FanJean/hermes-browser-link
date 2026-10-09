"""任务凭据的独立本机通道；普通 bridge RPC 不接收秘密。"""

from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import threading
import time
from typing import Any


MAX_FRAME = 384 * 1024
TOKENS = frozenset({"current-password", "one-time-code"})


def _frame(value: dict) -> bytes:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_FRAME:
        raise ValueError("private frame too large")
    return payload + b"\n"


def _read(reader) -> dict:
    payload = reader.readline(MAX_FRAME + 1)
    if not payload or len(payload) > MAX_FRAME or not payload.endswith(b"\n"):
        raise ValueError("invalid private frame")
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ValueError("invalid private object")
    return value


def remove_stale_socket(path, refusal: str) -> None:
    """仅在调用方持有 daemon 独占锁时使用：删除崩溃遗留、无人监听的同用户 Unix 套接字。"""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError(refusal)
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.2)
    try:
        probe.connect(str(path))
    except (ConnectionRefusedError, FileNotFoundError):
        pass
    except OSError:
        raise RuntimeError(refusal) from None
    else:
        raise RuntimeError(refusal)
    finally:
        probe.close()
    os.unlink(path)


class VaultPrivateService:
    """只接受固定 inspect/fill 指令，返回值不包含秘密或原始异常。"""

    def __init__(self, daemon):
        self.daemon = daemon
        self.socket_path = daemon.data_dir / "vault.sock"
        self.token_path = daemon.data_dir / "vault.token"
        self.server: socket.socket | None = None
        self._seen: dict[str, float] = {}
        self._nonces: dict[tuple[str, str, int], dict] = {}
        self._lock = threading.RLock()

    def start(self):
        # 中文注释：私有令牌和套接字与普通桥接分开，路径必须是本用户持有的真实文件。
        # 中文注释：daemon 已持有独占锁，崩溃遗留的本用户套接字可清理；其他情况仍拒绝。
        remove_stale_socket(self.socket_path, "refusing existing private Vault socket")
        try:
            fd = os.open(self.token_path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
        except FileNotFoundError:
            fd = os.open(self.token_path, os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            os.close(fd)
            raise RuntimeError("private Vault token is not a same-owner 0600 file")
        with os.fdopen(fd, "r+", encoding="ascii") as handle:
            token = handle.read(4097).strip()
            if not token:
                token = secrets.token_urlsafe(32)
                handle.seek(0)
                handle.write(token + "\n")
                handle.truncate()
                handle.flush()
                os.fsync(handle.fileno())
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server.bind(str(self.socket_path))
        except OSError:
            server.close()
            raise
        os.chmod(self.socket_path, stat.S_IRUSR | stat.S_IWUSR)
        server.listen(16)
        server.settimeout(0.2)
        self.server = server
        threading.Thread(target=self._accept, args=(server, token), name="browser-link-native-vault", daemon=True).start()

    def close(self):
        if self.server:
            self.server.close()
            self.server = None
        try:
            self.socket_path.unlink()
        except FileNotFoundError:
            pass
        with self._lock:
            self._seen.clear()
            self._nonces.clear()

    def _accept(self, server: socket.socket, token: str):
        while not self.daemon.stop_event.is_set():
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn, token), daemon=True).start()

    def _serve(self, conn: socket.socket, token: str):
        reader = None
        try:
            conn.settimeout(20)
            reader = conn.makefile("rb")
            hello = _read(reader)
            if (set(hello) != {"role", "token"} or hello["role"] != "vault-client"
                    or not isinstance(hello["token"], str)
                    or not secrets.compare_digest(hello["token"], token)):
                return
            request = _read(reader)
            request_id = request.get("id")
            if (set(request) != {"id", "op", "params"} or not isinstance(request_id, str)
                    or not re.fullmatch(r"[a-f0-9]{32}", request_id)
                    or request["op"] not in {"inspect", "fill", "revoke"} or not isinstance(request["params"], dict)):
                return
            with self._lock:
                now = time.monotonic()
                self._seen = {key: age for key, age in self._seen.items() if now - age < 600}
                if request_id in self._seen or len(self._seen) >= 4096:
                    conn.sendall(_frame({"id": request_id, "error": {"code": "vault_denied"}}))
                    return
                self._seen[request_id] = now
            try:
                result = self._dispatch(request["op"], request["params"])
                response = {"id": request_id, "result": result}
            except Exception:
                # 中文注释：扩展、网页和后端的异常可能含秘密，私有端口统一返回固定错误。
                response = {"id": request_id, "error": {"code": "vault_denied"}}
            conn.sendall(_frame(response))
        except (EOFError, OSError, ValueError, json.JSONDecodeError):
            pass
        finally:
            if reader is not None:
                reader.close()
            conn.close()

    def _scope(self, scope: Any):
        keys = {"sessionId", "owner", "taskId", "instanceId", "generation", "modeGeneration", "tabId", "allowedOrigins"}
        if not isinstance(scope, dict) or set(scope) != keys:
            raise ValueError("invalid Vault scope")
        if any(not isinstance(scope[key], str) or not scope[key] or len(scope[key]) > 256
               for key in ("sessionId", "owner", "taskId", "instanceId")):
            raise ValueError("invalid Vault identity")
        if (any(type(scope[key]) is not int or scope[key] < 0 for key in ("generation", "modeGeneration", "tabId"))
                or not isinstance(scope["allowedOrigins"], list)):
            raise ValueError("invalid Vault generation")
        daemon = self.daemon
        with daemon.state_lock:
            task = daemon.tasks.get(scope["taskId"])
            if (not task or task["owner"] != scope["owner"] or task["instanceId"] != scope["instanceId"]
                    or task["generation"] != scope["generation"] or task["modeGeneration"] != scope["modeGeneration"]
                    or task["allowedOrigins"] != scope["allowedOrigins"] or task["state"] != "ready"
                    or (scope["tabId"] not in task.get("agentTabIds", []) and scope["tabId"] not in task.get('adoptedPopupTabIds', []))
                    or daemon.tab_leases.get((scope["instanceId"], scope["tabId"])) != task["id"]):
                raise ValueError("Vault task changed")
            if scope["tabId"] in task.get("scriptedTabs", []):
                raise ValueError("Vault script execution conflict")
            extension = daemon.extensions.get(scope["instanceId"])
            if extension is None:
                raise ValueError("Vault extension disconnected")
            return task, extension

    def _dispatch(self, operation: str, params: dict) -> dict:
        if operation == "revoke":
            if set(params) != {"sessionId", "owner", "taskId"} or any(
                    not isinstance(params[key], str) or not params[key] or len(params[key]) > 256 for key in params):
                raise ValueError("invalid Vault revocation")
            with self._lock:
                for key, record in list(self._nonces.items()):
                    if key[0] == params["sessionId"] and key[1] == params["taskId"] and record["scope"]["owner"] == params["owner"]:
                        self._nonces.pop(key, None)
            return {"revoked": True}
        if operation == "inspect" and set(params) != {"scope"}:
            raise ValueError("invalid inspect")
        if operation == "fill" and (not {"scope", "nonce", "expectedOrigin", "documentGeneration", "kind", "fills"} <= set(params)
                                    or set(params) - {"scope", "nonce", "expectedOrigin", "documentGeneration", "kind", "fills", "approval"}):
            raise ValueError("invalid fill")
        scope = params["scope"]
        task, extension = self._scope(scope)
        # 中文注释：与普通页面动作共用任务锁，防止页面脚本与填写并发越过互斥检查。
        with self.daemon.task_locks[task["id"]]:
            task, extension = self._scope(scope)
            if operation == "inspect":
                return self._inspect(scope, extension)
            return self._fill(scope, params, task, extension)

    def _inspect(self, scope: dict, extension: dict) -> dict:
        nonce = secrets.token_hex(24)
        result = self.daemon._extension_call(extension, "browser.vault_inspect", {
            "taskId": scope["taskId"], "instanceId": scope["instanceId"], "generation": scope["generation"],
            "modeGeneration": scope["modeGeneration"], "tabId": scope["tabId"], "nonce": nonce}, timeout=15)
        if (not isinstance(result, dict) or set(result) != {"origin", "controls", "documentGeneration"}
                or result["origin"] not in scope["allowedOrigins"] or not isinstance(result["controls"], list)
                or len(result["controls"]) > 200
                or type(result["documentGeneration"]) is not int or result["documentGeneration"] < 0):
            raise ValueError("invalid Vault inspection")
        allowed = {"index", "type", "name", "label", "autocomplete", "maxLength", "formIndex"}
        indices = set()
        for row in result["controls"]:
            if (not isinstance(row, dict) or set(row) - allowed or type(row.get("index")) is not int
                    or row["index"] < 0 or row["index"] in indices
                    or any(not isinstance(row.get(key), str) or len(row[key]) > 500
                           for key in ("type", "name", "label", "autocomplete"))):
                raise ValueError("invalid Vault control metadata")
            indices.add(row["index"])
        self._scope(scope)
        key = (scope["sessionId"], scope["taskId"], scope["tabId"])
        with self._lock:
            self._nonces[key] = {"nonce": nonce, "origin": result["origin"],
                                 "documentGeneration": result["documentGeneration"],
                                 "scope": dict(scope), "expiresAt": time.monotonic() + 120}
        return {"taskId": scope["taskId"], "instanceId": scope["instanceId"],
                "generation": scope["generation"], "modeGeneration": scope["modeGeneration"],
                "tabId": scope["tabId"], "nonce": nonce, **result}

    def _fill(self, scope: dict, params: dict, task: dict, extension: dict) -> dict:
        fills = params["fills"]
        if (params["kind"] not in {"login", "otp"} or not isinstance(fills, list) or not 1 <= len(fills) <= 8
                or not isinstance(params["nonce"], str) or not re.fullmatch(r"[a-f0-9]{48}", params["nonce"])
                or params["expectedOrigin"] not in scope["allowedOrigins"]
                or type(params["documentGeneration"]) is not int or params["documentGeneration"] < 0):
            raise ValueError("invalid Vault fill")
        if any(not isinstance(row, dict) or set(row) != {"index", "token", "value"}
               or type(row["index"]) is not int or row["index"] < 0 or row["token"] not in TOKENS
               or not isinstance(row["value"], str) or not 1 <= len(row["value"]) <= 4096 for row in fills):
            raise ValueError("invalid Vault fields")
        if (len({row["index"] for row in fills}) != len(fills)
                or {row["token"] for row in fills} != ({"one-time-code"} if params["kind"] == "otp" else {"current-password"})):
            raise ValueError("invalid Vault field kind")
        key = (scope["sessionId"], scope["taskId"], scope["tabId"])
        with self._lock:
            record = self._nonces.pop(key, None)
        if (record is None or record["scope"] != scope or record["nonce"] != params["nonce"]
                or record["origin"] != params["expectedOrigin"]
                or record["documentGeneration"] != params["documentGeneration"]
                or record["expiresAt"] <= time.monotonic()):
            raise ValueError("Vault inspection expired")
        with self.daemon.state_lock:
            self._scope(scope)
            if task.get('activeMode') == 'smart':
                approval = params.get('approval')
                permit = task.get('vaultPermit')
                # 中文注释：智能审批凭证绑定任务代次、工作页、操作和句柄摘要，填充前一次性消费。
                if (not isinstance(approval, dict) or set(approval) != {'requestId', 'handleDigest', 'vaultAction'}
                        or not isinstance(approval['requestId'], str)
                        or not isinstance(approval['handleDigest'], str)
                        or permit is None or permit.get('requestIdHash') != hashlib.sha256(approval['requestId'].encode()).hexdigest()
                        or permit.get('handleDigest') != approval['handleDigest']
                        or permit.get('vaultAction') != approval['vaultAction']
                        or permit.get('tabId') != scope['tabId']
                        or permit.get('modeGeneration') != task['modeGeneration']
                        or permit.get('expiresAt', 0) <= time.time()):
                    raise ValueError('Vault approval missing or stale')
                task.pop('vaultPermit', None)
            tabs = task.setdefault("credentialTabs", [])
            if scope["tabId"] not in tabs:
                tabs.append(scope["tabId"])
            self.daemon._persist_tasks()
        try:
            result = self.daemon._extension_call(extension, "browser.vault_fill", {
                "taskId": scope["taskId"], "instanceId": scope["instanceId"], "generation": scope["generation"],
                "modeGeneration": scope["modeGeneration"], "tabId": scope["tabId"], "nonce": params["nonce"],
                "expectedOrigin": params["expectedOrigin"], "documentGeneration": params["documentGeneration"],
                "kind": params["kind"], "fills": fills}, timeout=15)
            if (not isinstance(result, dict) or set(result) - {"filled", "refused"}
                    or type(result.get("filled")) is not int or not 0 <= result["filled"] <= len(fills)
                    or result.get("refused") not in {None, "origin_changed", "inspection_stale"}):
                raise ValueError("invalid Vault fill receipt")
            return result
        finally:
            for row in fills:
                row["value"] = ""
