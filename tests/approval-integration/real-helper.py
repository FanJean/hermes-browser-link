"""Isolated source-package helper for shared native v2 real-browser acceptance."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from tests.support import stop_fixture_daemon  # noqa: E402


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def paths(work: Path):
    work = work.expanduser().resolve()
    # Keep AF_UNIX bridge.sock below macOS' short path limit.
    home = work / "h"
    return {
        "work": work,
        "home": home,
        "hermes": home / ".hermes",
        "plugin": work / "plugin" / "browser-link",
        "extension": work / "dist-native",
    }


def stage(work: Path, origins: list[str]):
    value = paths(work)
    if value["plugin"].exists():
        raise FileExistsError("fixture plugin already exists")
    value["plugin"].parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / "executor-plugin", value["plugin"], ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copytree(ROOT / "native-bridge", value["plugin"] / "native_bridge", ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "tests"))
    installer = load(ROOT / "native-bridge/install.py", "native_v2_installer_" + uuid.uuid4().hex)
    staged = installer.stage(value["home"], origins)
    return {
        "plugin": str(value["plugin"]),
        "extension": str(value["extension"]),
        "home": str(value["home"]),
        "hermesHome": str(value["hermes"]),
        "host": staged["host"],
        "manifests": staged["manifests"],
        "origins": origins,
    }


def rpc(work: Path, session: str, suffix: str, args: dict):
    value = paths(work)
    os.environ["HOME"] = str(value["home"])
    os.environ["HERMES_HOME"] = str(value["hermes"])
    hermes_source = Path(os.environ.get("HERMES_SOURCE", str(Path.home() / ".hermes/hermes-agent"))).resolve()
    sys.path.insert(0, str(hermes_source))
    try:
        from hermes_cli import plugins
    finally:
        sys.path.remove(str(hermes_source))
    tools = load(value["plugin"] / "native_tools.py", "native_v2_tools_" + uuid.uuid4().hex)
    profile = tools.runtime_module().NativeProfileRuntime(value["hermes"], value["plugin"])
    diagnostic = {}
    original_call = profile.call

    def recorded_call(method, params):
        try:
            return original_call(method, params)
        except Exception as exc:
            diagnostic.update({"method": method, "code": getattr(exc, "code", None), "message": str(exc)})
            raise

    profile.call = recorded_call
    manager = plugins.PluginManager()
    manager._hooks.setdefault("pre_tool_call", []).append(profile.authority.pre_tool_call)
    name = "browser_shared_" + suffix
    try:
        with patch.object(plugins, "_delivery_manager", return_value=manager):
            result = _invoke(plugins, tools, profile, name, args, session)
            if diagnostic and result.get("error"):
                result["_diagnostic"] = diagnostic
            return result
    finally:
        profile.close()


def _invoke(plugins, tools, profile, name: str, args: dict, session: str):
    block, bounded = plugins._dispatch_pre_tool_call_hooks(
        name, args, session_id=session, tool_call_id="native-v2-" + uuid.uuid4().hex
    )
    if block:
        raise RuntimeError(str(block))
    return json.loads(tools.make_tool_handler(name, profile)(bounded, session_id=session))


def batch(work: Path, session: str, kind: str, args: dict):
    value = paths(work)
    os.environ["HOME"] = str(value["home"])
    os.environ["HERMES_HOME"] = str(value["hermes"])
    hermes_source = Path(os.environ.get("HERMES_SOURCE", str(Path.home() / ".hermes/hermes-agent"))).resolve()
    sys.path.insert(0, str(hermes_source))
    try:
        from hermes_cli import plugins
    finally:
        sys.path.remove(str(hermes_source))
    tools = load(value["plugin"] / "native_tools.py", "native_v2_batch_tools_" + uuid.uuid4().hex)
    profile = tools.runtime_module().NativeProfileRuntime(value["hermes"], value["plugin"])
    diagnostic = {}
    original_call = profile.call

    def recorded_call(method, params):
        try:
            return original_call(method, params)
        except Exception as exc:
            diagnostic.clear()
            diagnostic.update({"method": method, "code": getattr(exc, "code", None), "message": str(exc)})
            raise

    profile.call = recorded_call
    manager = plugins.PluginManager()
    manager._hooks.setdefault("pre_tool_call", []).append(profile.authority.pre_tool_call)
    sequence = 0

    def run(action: str, **extra):
        nonlocal sequence
        sequence += 1
        payload = {
            "task_id": args["task_id"], "request_id": f"{args['request_prefix']}-{sequence}",
            "action": action, "tab_id": args["tab_id"], **extra,
        }
        result = _invoke(plugins, tools, profile, "browser_shared_run", payload, session)
        if result.get("error"):
            raise RuntimeError(json.dumps({**result, "diagnostic": diagnostic}, ensure_ascii=False))
        return result

    try:
        with patch.object(plugins, "_delivery_manager", return_value=manager):
            if kind == "click":
                shot = run("interaction.capture")
                bounds = run("interaction.bounds", screenshot_id=shot["id"], selector=args["selector"])
                clicked = run("interaction.click", screenshot_id=shot["id"], point=bounds["imageCenter"], expected_ref=bounds["ref"])
                replay = _invoke(plugins, tools, profile, "browser_shared_run", {
                    "task_id": args["task_id"], "request_id": f"{args['request_prefix']}-replay",
                    "action": "interaction.click", "tab_id": args["tab_id"],
                    "screenshot_id": shot["id"], "point": bounds["imageCenter"], "expected_ref": bounds["ref"],
                }, session)
                return {"shot": shot, "bounds": bounds, "result": clicked, "replay": replay}
            if kind == "drag_elements":
                shot = run("interaction.capture")
                result = run("interaction.drag_elements", screenshot_id=shot["id"], source=args["source"],
                             target=args["target"], mode=args.get("mode", "pointer"))
                return {"shot": shot, "result": result}
            if kind == "drag_coordinates":
                shot = run("interaction.capture")
                source = run("interaction.bounds", screenshot_id=shot["id"], selector=args["source"])
                target = run("interaction.bounds", screenshot_id=shot["id"], selector=args["target"])
                result = run("interaction.drag_coordinates", screenshot_id=shot["id"],
                             **{"from": {"point": source["imageCenter"], "expectedRef": source["ref"]},
                                "to": {"point": target["imageCenter"], "expectedRef": target["ref"]},
                                "mode": "pointer", "steps": args.get("steps", 8)})
                return {"shot": shot, "source": source, "target": target, "result": result}
            raise ValueError("unknown batch kind")
    finally:
        profile.close()


def inspect(work: Path):
    value = paths(work)
    pid_path = value["hermes"] / "plugin-data/browser-link-native/daemon.pid"
    if not pid_path.is_file():
        raise RuntimeError("fixture daemon is not running")
    pid = int(pid_path.read_text())
    command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], check=True, capture_output=True, text=True).stdout.strip()
    expected = value["hermes"] / "plugin-data/browser-link-native/host-bin/daemon.py"
    alternate = value["plugin"] / "native_bridge/daemon.py"
    if str(alternate) in command:
        import hashlib
        assert hashlib.sha256(alternate.read_bytes()).digest() == hashlib.sha256(expected.read_bytes()).digest()
        expected = alternate
    if str(expected) not in command or str(value["hermes"]) not in command:
        raise RuntimeError("daemon is not using staged bridge code")
    return {
        "daemonPid": pid,
        "daemonCommand": command,
        "daemonPath": str(expected),
        "pluginPath": str(value["plugin"]),
        "clientPath": str(value["plugin"] / "native_bridge/client.py"),
        "extensionPath": str(value["extension"]),
    }


def cleanup(work: Path):
    value = paths(work)
    pid_path = value["hermes"] / "plugin-data/browser-link-native/daemon.pid"
    if not pid_path.is_file():
        return {}
    pid = int(pid_path.read_text())
    command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True)
    expected = str(value["hermes"] / "plugin-data/browser-link-native/host-bin/daemon.py")
    alternate = str(value["plugin"] / "native_bridge/daemon.py")
    if command.returncode == 0 and (expected in command.stdout or alternate in command.stdout) and str(value["hermes"]) in command.stdout:
        stop_fixture_daemon(value["hermes"])
    else:
        raise RuntimeError("refusing to stop non-fixture process")
    return {}


def main():
    mode = sys.argv[1]
    work = Path(sys.argv[2])
    if mode == "stage":
        result = stage(work, json.loads(sys.argv[3]))
    elif mode == "rpc":
        result = rpc(work, sys.argv[3], sys.argv[4], json.loads(sys.argv[5]))
    elif mode == "batch":
        result = batch(work, sys.argv[3], sys.argv[4], json.loads(sys.argv[5]))
    elif mode == "inspect":
        result = inspect(work)
    elif mode == "cleanup":
        result = cleanup(work)
    else:
        raise ValueError("unknown mode")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
