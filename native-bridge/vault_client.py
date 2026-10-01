"""受信宿主使用的独立 Vault 客户端；请求失败后不自动重放。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import stat
import uuid


MAX_FRAME = 384 * 1024


def call(home: Path, operation: str, params: dict) -> dict:
    if operation not in {"inspect", "fill", "revoke"} or not isinstance(params, dict):
        raise RuntimeError("Vault operation unavailable")
    data_dir = Path(home).expanduser().resolve() / "plugin-data" / "browser-link-native"
    token_path = data_dir / "vault.token"
    try:
        fd = os.open(token_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        raise RuntimeError("Vault private authentication unavailable") from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError("Vault private authentication unavailable")
        with os.fdopen(fd, "r", encoding="ascii") as handle:
            fd = -1
            token = handle.read(4097).strip()
        if not token or len(token) > 4096:
            raise RuntimeError("Vault private authentication unavailable")
    finally:
        if fd >= 0:
            os.close(fd)
    request_id = uuid.uuid4().hex
    request = {"id": request_id, "op": operation, "params": params}
    payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(payload) > MAX_FRAME:
        raise RuntimeError("Vault private payload too large")
    # 中文注释：单次连接只发送一条请求；写入后超时或断线均按结果未知处理。
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(20)
        conn.connect(str(data_dir / "vault.sock"))
        with conn.makefile("rb") as reader:
            conn.sendall(json.dumps({"role": "vault-client", "token": token}, separators=(",", ":")).encode("ascii") + b"\n")
            conn.sendall(payload)
            line = reader.readline(MAX_FRAME + 1)
    if not line or len(line) > MAX_FRAME or not line.endswith(b"\n"):
        raise RuntimeError("Vault private outcome unknown")
    response = json.loads(line)
    if not isinstance(response, dict) or response.get("id") != request_id or set(response) - {"id", "result", "error"}:
        raise RuntimeError("Vault private outcome unknown")
    if "error" in response:
        raise RuntimeError("Vault private operation denied")
    if not isinstance(response.get("result"), dict):
        raise RuntimeError("Vault private outcome unknown")
    return response["result"]
