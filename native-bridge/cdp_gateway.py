"""任务级 CDP 网关：为 browser_exec 的 Browser Use CLI 提供只含本任务页面的 CDP WebSocket。

只监听 127.0.0.1，URL 含一次性随机令牌；连接随任务结束、断线或浏览器访问撤销而关闭。
浏览器级 Target 方法由网关按任务范围模拟，页面会话方法逐项转给扩展按冻结矩阵核实后执行。
这是 V1.1 为 browser_exec 兼容明确开放的本机回环端口例外，不接受其他来源或浏览器会话直通。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import struct
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME = 64 * 1024 * 1024
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_CONNECTIONS_PER_GRANT = 2


class GatewayDenied(Exception):
    def __init__(self, message: str, code: int = -32000):
        super().__init__(message)
        self.code = code
        self.message = message


def _accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()


def _recv_exact(sock: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise EOFError
        data.extend(chunk)
    return bytes(data)


def read_frame(sock: socket.socket) -> tuple[int, bytes, bool]:
    head = _recv_exact(sock, 2)
    fin, opcode = bool(head[0] & 0x80), head[0] & 0x0F
    masked, length = bool(head[1] & 0x80), head[1] & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv_exact(sock, 8))[0]
    if length > MAX_FRAME:
        raise ValueError("frame too large")
    if not masked:
        # 中文注释：客户端帧必须带掩码（RFC 6455）；否则视为非 WebSocket 客户端。
        raise ValueError("unmasked client frame")
    mask = _recv_exact(sock, 4)
    payload = bytearray(_recv_exact(sock, length))
    for index in range(length):
        payload[index] ^= mask[index % 4]
    return opcode, bytes(payload), fin


def encode_frame(opcode: int, payload: bytes) -> bytes:
    head = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        head.append(length)
    elif length < 65536:
        head.append(126)
        head.extend(struct.pack(">H", length))
    else:
        head.append(127)
        head.extend(struct.pack(">Q", length))
    return bytes(head) + payload


class _Connection:
    def __init__(self, gateway: "CdpGateway", sock: socket.socket, grant: dict):
        self.gateway = gateway
        self.sock = sock
        self.grant = grant
        self.send_lock = threading.Lock()
        self.sessions: Dict[str, dict] = {}
        self.targets: Dict[str, dict] = {}
        self.closed = threading.Event()
        self.pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="hermes-cdp")

    def send_json(self, value: dict) -> None:
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        with self.send_lock:
            if self.closed.is_set():
                return
            try:
                self.sock.sendall(encode_frame(0x1, data))
            except OSError:
                # 中文注释：先退出发送临界区，再统一回收连接和订阅。
                pass
            else:
                return
        self.close()

    def close(self) -> None:
        # 中文注释：会话增删与关闭共用订阅锁，避免关闭时遗漏刚附加的会话。
        with self.gateway._subscription_lock:
            if self.closed.is_set():
                return
            self.closed.set()
            sessions = list(self.sessions.values())
            self.sessions.clear()
        # 中文注释：撤权和断线直接 shutdown，不能等待可能被慢客户端阻塞的 sendall 或关闭帧。
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()
        for session in sessions:
            self.gateway.unsubscribe(self, session)
        self.pool.shutdown(wait=False, cancel_futures=True)

    def serve(self) -> None:
        fragments = bytearray()
        try:
            while not self.closed.is_set():
                opcode, payload, fin = read_frame(self.sock)
                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    with self.send_lock:
                        self.sock.sendall(encode_frame(0xA, payload))
                    continue
                if opcode in (0x1, 0x2, 0x0):
                    fragments.extend(payload)
                    if len(fragments) > MAX_FRAME:
                        raise ValueError("message too large")
                    if not fin:
                        continue
                    message, fragments = bytes(fragments), bytearray()
                    try:
                        request = json.loads(message)
                    except ValueError:
                        continue
                    if not isinstance(request, dict) or not isinstance(request.get("id"), int):
                        continue
                    self.pool.submit(self.handle, request)
        except (EOFError, OSError, ValueError, RuntimeError):
            pass
        finally:
            self.close()

    def handle(self, request: dict) -> None:
        request_id = request["id"]
        response: Dict[str, Any] = {"id": request_id}
        if "sessionId" in request:
            response["sessionId"] = request["sessionId"]
        try:
            result = self.gateway.dispatch(self, request)
            response["result"] = result if isinstance(result, dict) else {}
        except GatewayDenied as exc:
            response["error"] = {"code": exc.code, "message": exc.message}
        except Exception:
            response["error"] = {"code": -32000, "message": "Hermes task gateway error"}
        self.send_json(response)


class CdpGateway:
    """单个 daemon 内的网关；每个令牌绑定 owner/任务/既有访问代次与工作目录。"""

    def __init__(self, call: Callable[[dict, str, dict], Any], validate: Callable[[dict], dict],
                 create_tab: Callable[[dict, str], dict]):
        # call(grant, extension_method, params) 转发到扩展；validate(grant) 重新核实任务与既有浏览器访问；
        # create_tab(grant, url) 经 daemon 任务账本新建任务工作页。
        self._call = call
        self._validate = validate
        self._create_tab = create_tab
        self._lock = threading.RLock()
        # 中文注释：同一任务页面可有多个网关会话，最后一个离开才关闭扩展推送。
        self._subscription_lock = threading.RLock()
        self._subscriptions = {}
        self._grants: Dict[str, dict] = {}
        self._connections: Dict[str, list] = {}
        self._server: socket.socket | None = None
        self._port: int | None = None
        self._stop = threading.Event()

    def _ensure_server(self) -> int:
        with self._lock:
            if self._server is not None:
                return self._port
            server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", 0))
            server.listen(16)
            self._server, self._port = server, server.getsockname()[1]
            threading.Thread(target=self._accept_loop, name="hermes-cdp-gateway", daemon=True).start()
            return self._port

    def open(self, *, owner: str, task_id: str, generation: int, mode_generation: int,
             workspace: str | None, smart_authorized: bool = False) -> dict:
        port = self._ensure_server()
        root = None
        if workspace is not None:
            candidate = Path(workspace).expanduser()
            if not candidate.is_absolute() or not candidate.is_dir() or candidate.is_symlink():
                raise GatewayDenied("invalid workspace")
            root = str(candidate.resolve())
        token = secrets.token_urlsafe(32)
        # 中文注释：智能审批网关只由已批准的 browser_exec 调用签发。
        grant = {"token": token, "owner": owner, "taskId": task_id, "generation": generation,
                 "modeGeneration": mode_generation, "revoked": False,
                 "workspace": root, "smartAuthorized": smart_authorized}
        with self._lock:
            # 中文注释：同一任务同一授权代次只保留一个有效令牌，旧令牌与连接随之关闭。
            for old in [t for t, g in self._grants.items() if g["taskId"] == task_id]:
                self._drop_locked(old)
            self._grants[token] = grant
        return {"wsUrl": f"ws://127.0.0.1:{port}/devtools/browser/{token}"}

    def revoke(self, task_id: str) -> None:
        with self._lock:
            for token in [t for t, g in self._grants.items() if g["taskId"] == task_id]:
                self._drop_locked(token)

    def _drop_locked(self, token: str) -> None:
        grant = self._grants.pop(token, None)
        # 中文注释：排队线程仍持有同一字典；撤销标记阻止其在重新回到授权网站后继续派发。
        if grant is not None:
            grant['revoked'] = True
        for connection in self._connections.pop(token, []):
            threading.Thread(target=connection.close, daemon=True).start()

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            for token in list(self._grants):
                self._drop_locked(token)
            if self._server is not None:
                try:
                    self._server.close()
                except OSError:
                    pass
                self._server = None

    def _accept_loop(self) -> None:
        while not self._stop.is_set():
            try:
                sock, address = self._server.accept()
            except OSError:
                return
            if address[0] != "127.0.0.1":
                sock.close()
                continue
            threading.Thread(target=self._handshake, args=(sock,), daemon=True).start()

    def _handshake(self, sock: socket.socket) -> None:
        sock.settimeout(10)
        connection = None
        try:
            data = bytearray()
            while b"\r\n\r\n" not in data:
                chunk = sock.recv(4096)
                if not chunk or len(data) > 16384:
                    raise EOFError
                data.extend(chunk)
            head = data.split(b"\r\n\r\n", 1)[0].decode("latin-1").split("\r\n")
            parts = head[0].split(" ")
            headers = {line.split(":", 1)[0].strip().lower(): line.split(":", 1)[1].strip()
                       for line in head[1:] if ":" in line}
            path = parts[1] if len(parts) >= 2 else ""
            token = path.rsplit("/", 1)[-1] if path.startswith("/devtools/browser/") else ""
            with self._lock:
                grant = self._grants.get(token)
                live = len(self._connections.get(token, []))
            if (parts[0] != "GET" or grant is None or headers.get("upgrade", "").lower() != "websocket"
                    or not headers.get("sec-websocket-key") or live >= MAX_CONNECTIONS_PER_GRANT):
                sock.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                sock.close()
                return
            # 中文注释：拒绝浏览器网页发起的跨站 WebSocket（带 Origin 的请求不是本机 CLI）。
            if headers.get("origin"):
                sock.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                sock.close()
                return
            accept = _accept_key(headers["sec-websocket-key"])
            sock.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                          f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
            sock.settimeout(None)
            connection = _Connection(self, sock, grant)
            with self._lock:
                if token not in self._grants:
                    connection.close()
                    return
                self._connections.setdefault(token, []).append(connection)
            connection.serve()
        except (OSError, EOFError, ValueError, IndexError):
            try:
                sock.close()
            except OSError:
                pass
        finally:
            # 中文注释：配额统计仅保留存活连接；断线后移除记录，允许同一任务重新连接。
            if connection is not None:
                with self._lock:
                    rows = self._connections.get(token, [])
                    if connection in rows:
                        rows.remove(connection)
                    if not rows:
                        self._connections.pop(token, None)

    # ---- CDP routing ----
    def _base(self, grant: dict) -> dict:
        self._validate(grant)
        return {"taskId": grant["taskId"], "generation": grant["generation"],
                "modeGeneration": grant["modeGeneration"]}

    def _refresh_targets(self, connection: _Connection) -> list:
        rows = self._call(connection.grant, "browser.cdp_targets", self._base(connection.grant))
        targets = rows.get("targets") if isinstance(rows, dict) else None
        if not isinstance(targets, list):
            raise GatewayDenied("target listing unavailable")
        connection.targets = {row["targetId"]: row for row in targets
                              if isinstance(row, dict) and isinstance(row.get("targetId"), str)}
        return targets

    @staticmethod
    def _target_info(row: dict) -> dict:
        return {"targetId": row["targetId"], "type": row.get("type", "page"), "title": row.get("title", ""),
                "url": row.get("url", ""), "attached": True, "canAccessOpener": False,
                "browserContextId": "hermes-task"}

    def dispatch(self, connection: _Connection, request: dict) -> dict:
        method = request.get("method")
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        grant = connection.grant
        if not isinstance(method, str):
            raise GatewayDenied("invalid method", -32600)
        session_id = request.get("sessionId")
        if session_id is not None:
            session = connection.sessions.get(session_id)
            if session is None:
                raise GatewayDenied(f"Session with given id not found.", -32001)
            if method.startswith("Target."):
                raise GatewayDenied("Target methods are browser-level in the Hermes task gateway", -32601)
            call = {**self._base(grant), "tabId": session["tabId"], "method": method, "params": params}
            if session.get("childSessionId"):
                call["childSessionId"] = session["childSessionId"]
            if method == "DOM.setFileInputFiles":
                call["params"] = {**params, "files": self._verified_files(grant, params.get("files"))}
                call["filesVerified"] = True
            result = self._call(grant, "browser.cdp", call)
            return result if isinstance(result, dict) else {}
        if method == "Browser.getVersion":
            return self._call(grant, "browser.cdp_version", self._base(grant))
        if method in {"Target.setDiscoverTargets", "Target.setAutoAttach", "Target.setRemoteLocations"}:
            if method == "Target.setDiscoverTargets" and params.get("discover") is True:
                for row in self._refresh_targets(connection):
                    connection.send_json({"method": "Target.targetCreated",
                                          "params": {"targetInfo": self._target_info(row)}})
            return {}
        if method == "Target.getTargets":
            return {"targetInfos": [self._target_info(row) for row in self._refresh_targets(connection)]}
        if method == "Target.getTargetInfo":
            target_id = params.get("targetId")
            if target_id is None:
                return {"targetInfo": {"targetId": "hermes-browser", "type": "browser", "title": "",
                                       "url": "", "attached": True, "canAccessOpener": False}}
            row = connection.targets.get(target_id)
            if row is None:
                self._refresh_targets(connection)
                row = connection.targets.get(target_id)
            if row is None:
                raise GatewayDenied("No target with given id found", -32602)
            return {"targetInfo": self._target_info(row)}
        if method == "Target.attachToTarget":
            if params.get("flatten") is not True:
                raise GatewayDenied("Hermes task gateway supports flatten sessions only", -32602)
            row = connection.targets.get(params.get("targetId"))
            if row is None:
                self._refresh_targets(connection)
                row = connection.targets.get(params.get("targetId"))
            if row is None:
                raise GatewayDenied("No target with given id found", -32602)
            sid = secrets.token_hex(16).upper()
            session = {"sessionId": sid, "tabId": row["tabId"], "childSessionId": row.get("childSessionId"),
                       "targetId": row["targetId"]}
            with self._subscription_lock:
                if connection.closed.is_set():
                    raise GatewayDenied("connection closed")
                key = (grant['token'], row['tabId'], row.get('childSessionId'))
                if not self._subscriptions.get(key):
                    self._call(grant, "browser.cdp_subscribe", {**self._base(grant), "tabId": row["tabId"],
                                                                "childSessionId": row.get("childSessionId"), "subscribe": True})
                self._subscriptions[key] = self._subscriptions.get(key, 0) + 1
                connection.sessions[sid] = session
            connection.send_json({"method": "Target.attachedToTarget",
                                  "params": {"sessionId": sid, "targetInfo": self._target_info(row),
                                             "waitingForDebugger": False}})
            return {"sessionId": sid}
        if method == "Target.detachFromTarget":
            with self._subscription_lock:
                session = connection.sessions.pop(params.get("sessionId"), None)
            if session is None:
                raise GatewayDenied("No session with given id", -32602)
            self.unsubscribe(connection, session)
            connection.send_json({"method": "Target.detachedFromTarget",
                                  "params": {"sessionId": session["sessionId"], "targetId": session["targetId"]}})
            return {}
        if method == "Target.createTarget":
            url = params.get("url", "about:blank")
            if not isinstance(url, str):
                raise GatewayDenied("invalid url", -32602)
            self._validate(grant)
            created = self._create_tab(grant, url)
            self._refresh_targets(connection)
            target_id = created.get("targetId") if isinstance(created, dict) else None
            if not target_id:
                match = [row for row in connection.targets.values()
                         if row.get("tabId") == created.get("tabId") and row.get("type") == "page"]
                target_id = match[0]["targetId"] if match else None
            if not target_id:
                raise GatewayDenied("created tab has no target")
            row = connection.targets.get(target_id)
            if row is not None:
                connection.send_json({"method": "Target.targetCreated",
                                      "params": {"targetInfo": self._target_info(row)}})
            return {"targetId": target_id}
        if method == "Target.closeTarget":
            self._call(grant, "browser.cdp_close", {**self._base(grant), "targetId": params.get("targetId")})
            return {"success": True}
        if method == "Target.activateTarget":
            self._call(grant, "browser.cdp_activate", {**self._base(grant), "targetId": params.get("targetId")})
            return {}
        raise GatewayDenied(f"'{method}' is not available in the Hermes task gateway", -32601)

    def _verified_files(self, grant: dict, files: Any) -> list:
        # 中文注释：按产品决定，用户可让脚本上传任意本地普通文件；只核对数量、类型与大小，页面来源仍由任务授权限定。
        if not isinstance(files, list) or not 1 <= len(files) <= 10:
            raise GatewayDenied("select between 1 and 10 files")
        verified = []
        for item in files:
            if not isinstance(item, str) or not item:
                raise GatewayDenied("invalid file path")
            resolved = Path(item).expanduser().resolve()
            if not resolved.is_file():
                raise GatewayDenied("file is missing or not a regular file")
            if resolved.stat().st_size > MAX_UPLOAD_BYTES:
                raise GatewayDenied("file is larger than the upload limit")
            verified.append(str(resolved))
        return verified

    def unsubscribe(self, connection: _Connection, session: dict) -> None:
        with self._subscription_lock:
            key = (connection.grant['token'], session['tabId'], session.get('childSessionId'))
            count = self._subscriptions.get(key, 0)
            if count > 1:
                self._subscriptions[key] = count - 1
                return
            if not count:
                return
            self._subscriptions.pop(key)
            try:
                self._call(connection.grant, "browser.cdp_subscribe", {
                    **self._base(connection.grant), "tabId": session["tabId"],
                    "childSessionId": session.get("childSessionId"), "subscribe": False})
            except Exception:
                pass

    def deliver(self, task_id: str, generation: int, events: list, dropped: int) -> None:
        """把扩展推来的事件按任务、标签页与子会话路由到已附加的网关会话。"""
        with self._lock:
            connections = [c for token, cs in self._connections.items() for c in cs
                           if self._grants.get(token, {}).get("taskId") == task_id
                           and self._grants.get(token, {}).get("generation") == generation]
        for connection in connections:
            for event in events:
                if not isinstance(event, dict):
                    continue
                for session in list(connection.sessions.values()):
                    if session["tabId"] == event.get("tabId") and (session.get("childSessionId") or None) == (event.get("childSessionId") or None):
                        connection.send_json({"method": event.get("method"), "params": event.get("params") or {},
                                              "sessionId": session["sessionId"]})
            if dropped:
                connection.send_json({"method": "Hermes.eventsDropped", "params": {"count": int(dropped)}})
