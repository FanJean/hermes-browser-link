#!/usr/bin/env python3
"""Stage Native Messaging host files into an explicitly isolated macOS HOME."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys
from typing import Iterable

HOST_NAME = "com.hermes.browser_link"
_ORIGIN_RE = re.compile(r"^chrome-extension://[a-p]{32}/$")
_BROWSER_DIRS = (
    Path("Library/Application Support/Google/Chrome/NativeMessagingHosts"),
    Path("Library/Application Support/Microsoft Edge/NativeMessagingHosts"),
)


def _write_private_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(encoded)
    os.chmod(path, 0o600)


def stage(home: Path, extension_origins: Iterable[str]) -> dict:
    target_home = home.expanduser().resolve()
    if target_home == Path.home().resolve():
        raise ValueError("refusing to stage into the active user HOME")
    origins = list(dict.fromkeys(extension_origins))
    if not origins or any(not _ORIGIN_RE.fullmatch(origin) for origin in origins):
        raise ValueError("extension origins must be exact chrome-extension://<32 a-p chars>/ values")

    # 中文注释：固定身份不允许通过安装参数放行其他扩展。
    if origins != ['chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/']:
        raise ValueError("扩展来源必须匹配 manifest key 固定 ID")

    source_dir = Path(__file__).resolve().parent
    projection_candidates = (
        source_dir / "task_diagnostics.py",
        source_dir.parent / "task_diagnostics.py",
        source_dir.parent / "executor-plugin" / "task_diagnostics.py",
    )
    projection_source = next((path for path in projection_candidates if path.is_file()), None)
    if projection_source is None:
        raise ValueError("task_diagnostics.py is required to stage the native diagnostics projection")

    # Verify the complete host closure before creating anything under the
    # destination HOME, so a missing module never leaves a partial host.
    diagnostics_source = source_dir / "browser_diagnostics"
    if not diagnostics_source.is_dir():
        diagnostics_source = source_dir.parent / "browser-diagnostics" / "python" / "browser_diagnostics"
    # 中文注释：同一清单用于预检及复制，避免安装文件与防链接检查范围不一致。
    native_files = ("cookie_mirror.py", "host.py", "client.py", "daemon.py", "api_client.py", "artifacts.py", "downloads.py", "cdp_gateway.py", "vault_private.py", "vault_client.py")
    diagnostic_files = ("__init__.py", "schema.py", "runtime.py", "sink.py")
    required = [source_dir / name for name in native_files]
    required += [diagnostics_source / name for name in diagnostic_files]
    missing = [str(path.relative_to(source_dir.parent)) for path in required if not path.is_file()]
    if missing:
        raise ValueError("native host runtime is incomplete; missing: " + ", ".join(missing))

    hermes_home = target_home / ".hermes"
    data_dir = hermes_home / "plugin-data" / "browser-link-native"
    host_bin = data_dir / "host-bin"
    # 中文注释：隔离 HOME 内的任何目标或祖先链接都可能越界，必须在第一次写入前统一拒绝。
    targets = [host_bin / name for name in (*native_files, "task_diagnostics.py", HOST_NAME)]
    targets += [host_bin / "browser_diagnostics" / name for name in diagnostic_files]
    targets += [data_dir / "host-config.json"]
    targets += [target_home / directory / f"{HOST_NAME}.json" for directory in _BROWSER_DIRS]
    for target in targets:
        if any(path.is_symlink() for path in (target, *target.parents)):
            raise ValueError("refusing symbolic link in staged host target")
    host_bin.mkdir(parents=True, exist_ok=True)
    os.chmod(data_dir, 0o700)
    os.chmod(host_bin, 0o700)

    # 中文注释：文件登记模块与 daemon 一起固定复制，避免源码和安装版校验规则分叉。
    # 中文注释：私有 Vault 服务和客户端随 daemon 一起安装，避免运行时落回普通 RPC。
    for filename in native_files:
        destination = host_bin / filename
        shutil.copyfile(source_dir / filename, destination)
        os.chmod(destination, 0o600)

    # Packaged runtime uses an adjacent package; checkout staging uses canonical source
    # (resolved in the preflight above).
    diagnostics_target = host_bin / "browser_diagnostics"
    diagnostics_target.mkdir(mode=0o700, exist_ok=True)
    os.chmod(diagnostics_target, 0o700)
    for filename in diagnostic_files:
        destination = diagnostics_target / filename
        shutil.copyfile(diagnostics_source / filename, destination)
        os.chmod(destination, 0o600)

    # The standalone host has no plugin-root import path. Stage the projection
    # beside daemon.py; its browser_diagnostics imports are supplied by the
    # complete package copied above.
    projection_target = host_bin / "task_diagnostics.py"
    shutil.copyfile(projection_source, projection_target)
    os.chmod(projection_target, 0o600)

    launcher = host_bin / "com.hermes.browser_link"
    launcher_text = (
        f"#!{sys.executable}\n"
        "import os, runpy\n"
        f"os.environ['HERMES_HOME'] = {str(hermes_home)!r}\n"
        f"runpy.run_path({str(host_bin / 'host.py')!r}, run_name='__main__')\n"
    )
    launcher.write_text(launcher_text, encoding="utf-8")
    os.chmod(launcher, 0o700)

    _write_private_json(data_dir / "host-config.json", {"allowedOrigins": origins})
    manifest = {
        "name": HOST_NAME,
        "description": "Hermes Browser Link native bridge",
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": origins,
    }
    manifests = []
    for relative_dir in _BROWSER_DIRS:
        manifest_path = target_home / relative_dir / f"{HOST_NAME}.json"
        _write_private_json(manifest_path, manifest)
        manifests.append(str(manifest_path))
    return {"home": str(target_home), "host": str(launcher), "manifests": manifests}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    stage_parser = subparsers.add_parser("stage")
    stage_parser.add_argument("--home", required=True, type=Path)
    stage_parser.add_argument("--extension-origin", action="append", required=True)
    args = parser.parse_args()
    try:
        result = stage(args.home, args.extension_origin)
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
