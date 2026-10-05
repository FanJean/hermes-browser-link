"""Complete synthetic package/source fixtures for negative install controls."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path


def _write_tree(root: Path, files: dict[str, bytes]) -> None:
    for relative, data in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def write_installer_package(root: Path, *, include_api_client: bool = True) -> Path:
    """Create the installer's real required layout and exact SHA256SUMS."""
    # 使用当前桥接候选包布局构造离线安装夹具。
    files: dict[str, bytes] = {
        "browser-link/plugin.yaml": b"name: browser-link\nversion: 1.3.0\n",
        "browser-link/__init__.py": b"\"\"\"Fixture plugin.\"\"\"\n",
        "browser-link/runtime.py": b"# runtime fixture\n",
        "browser-link/native_tools.py": b"# tools fixture\n",
        # 中文注释：合成包必须包含自动更新的维护闭包。
        "browser-link/maintenance/update.py": b"# updater fixture\n",
        "browser-link/maintenance/install-cli.py": b"# install fixture\n",
        "browser-link/maintenance/install-executor.py": b"# verifier fixture\n",
        "browser-link/open_tool.py": b"# open tool fixture\n",
        "browser-link/skills/use-my-browser/SKILL.md": b"# browser skill fixture\n",
        "browser-link/task_diagnostics.py": b"# diagnostics projection fixture\n",
        "browser-link/script_lane/host_bridge.py": b"# host bridge fixture\n",
        "browser-link/script_lane/action_session.py": b"# action session fixture\n",
        "browser-link/script_lane/child.py": b"# script child fixture\n",
        "browser-link/script_lane/tool.py": b"# script tool fixture\n",
        "browser-link/native_bridge/host.py": b"# host fixture\n",
        "browser-link/native_bridge/client.py": b"# client fixture\n",
        "browser-link/native_bridge/daemon.py": b"# daemon fixture\n",
        "browser-link/native_bridge/browser_diagnostics/__init__.py": b"# diagnostics fixture\n",
        "browser-link/native_bridge/browser_diagnostics/schema.py": b"# schema fixture\n",
        "browser-link/native_bridge/browser_diagnostics/runtime.py": b"# runtime fixture\n",
        "browser-link/native_bridge/browser_diagnostics/sink.py": b"# sink fixture\n",
        "native-extension/manifest.json": json.dumps({
            "manifest_version": 3,
            "background": {"service_worker": "background.mjs"},
        }).encode() + b"\n",
        "native-extension/background.mjs": b"// background fixture\n",
        "docs/python-scripting.md": b"# python scripting fixture\n",
        "docs/CHANGELOG.md": b"# changelog fixture\n",
        "LICENSE": b"fixture license\n",
        "README.md": b"# fixture\n",
        "INSTALL.txt": b"fixture install instructions\n",
        "RELEASE-STATUS.txt": b"NOT FROZEN; not a formal release.\n",
        "install-executor.py": b"# fixture installer\n",
        "install-cli.py": b"# install entry\n",
        "install.sh": b"#!/bin/bash\n",
    }
    if include_api_client:
        files["browser-link/native_bridge/api_client.py"] = b"# api client fixture\n"
    _write_tree(root, files)
    manifest = {
        name: hashlib.sha256(data).hexdigest()
        for name, data in sorted(files.items())
    }
    (root / "SHA256SUMS.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return root


def write_packager_source(root: Path, *, include_api_client: bool = False) -> Path:
    """Create all packager preflight inputs, leaving only the requested omission."""
    files = {
        "package.json": b'{"version":"1.3.0"}\n',
        "native-bridge/client.py": b"# client\n",
        "native-bridge/daemon.py": b"# daemon\n",
        "native-bridge/host.py": b"# host\n",
        "native-extension/manifest.json": b'{"manifest_version":3,"version":"1.3.0"}\n',
        "native-extension/build.mjs": b"// build entry fixture\n",
        "executor-plugin/plugin.yaml": b"name: browser-link\nversion: 1.3.0\n",
        "executor-plugin/__init__.py": b"\"\"\"Plugin fixture.\"\"\"\n",
        "executor-plugin/open_tool.py": b"# open tool\n",
        "executor-plugin/skills/use-my-browser/SKILL.md": b"# browser skill\n",
        "executor-plugin/script_lane/host_bridge.py": b"# host bridge\n",
        "executor-plugin/script_lane/action_session.py": b"# action session\n",
        "executor-plugin/script_lane/child.py": b"# script child\n",
        "executor-plugin/script_lane/tool.py": b"# script tool\n",
        "executor-plugin/single_tool_adapter/integration.py": b"# overrides\n",
        "executor-plugin/single_tool_adapter/adapter.py": b"# adapter\n",
        "LICENSE": b"fixture license\n",
        "page-semantics/index.js": b"// semantics\n",
        "browser-files/index.mjs": b"// browser files\n",
        "browser-files/adapters.mjs": b"// adapters\n",
        "browser-interactions/index.mjs": b"// interactions\n",
        "approval-policy/policy.mjs": b"// policy\n",
        "browser-workspaces/index.mjs": b"// workspaces\n",
        "browser-diagnostics/js/diagnostics.mjs": b"// diagnostics js\n",
        "browser-diagnostics/python/browser_diagnostics/__init__.py": b"# package\n",
        "browser-diagnostics/python/browser_diagnostics/schema.py": b"# schema\n",
        "browser-diagnostics/python/browser_diagnostics/runtime.py": b"# runtime\n",
        "browser-diagnostics/python/browser_diagnostics/sink.py": b"# sink\n",
        "CHANGELOG.md": b"# Changelog\n",
        "docs/python-scripting.md": b"# Python scripting\n",
        "docs/installation.md": b"# Installation\n",
    }
    if include_api_client:
        files["native-bridge/api_client.py"] = b"# api client\n"
    _write_tree(root, files)
    return root
