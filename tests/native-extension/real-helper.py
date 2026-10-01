"""Package-first Native Messaging and real Hermes hook helper for browser E2E."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "native-bridge"))
from tests.support import stop_fixture_daemon  # noqa: E402


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def locations(work: Path) -> dict[str, Path]:
    work = work.expanduser().resolve()
    home = work / "home"
    hermes_home = home / ".hermes"
    package = work / "package"
    installed = hermes_home / "plugins" / "browser-link"
    return {"work": work, "home": home, "hermes_home": hermes_home, "package": package, "installed": installed}


def extension_root(package: Path) -> Path:
    """Resolve only explicit packaged layouts; never consult the source checkout."""
    flat = package / "native-extension"
    legacy = flat / "dist-native"
    if (flat / "manifest.json").is_file():
        return flat
    if (legacy / "manifest.json").is_file():
        return legacy
    raise ValueError("candidate missing extension manifest in flat or legacy dist-native layout")


def prepare(work: Path, archive: Path) -> dict:
    paths = locations(work)
    package = paths["package"]
    archive = archive.expanduser().resolve()
    if package.exists():
        raise FileExistsError(f"package extraction already exists: {package}")
    package.mkdir(parents=True)
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)):
            raise ValueError("candidate zip contains duplicate paths")
        for entry in entries:
            relative = Path(entry.filename)
            if relative.is_absolute() or ".." in relative.parts or not relative.parts:
                raise ValueError(f"unsafe candidate path: {entry.filename}")
            unix_mode = entry.external_attr >> 16
            if stat.S_ISLNK(unix_mode):
                raise ValueError(f"candidate zip contains symlink: {entry.filename}")
        if "SHA256SUMS.json" not in names:
            raise ValueError("candidate zip has no SHA256SUMS.json")
        manifest = json.loads(bundle.read("SHA256SUMS.json"))
        if not isinstance(manifest, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in manifest.items()):
            raise ValueError("invalid package hash manifest")
        actual = set(names) - {"SHA256SUMS.json"}
        if actual != set(manifest):
            raise ValueError("candidate file set does not match SHA256SUMS.json")
        for name, digest in manifest.items():
            if hashlib.sha256(bundle.read(name)).hexdigest() != digest:
                raise ValueError(f"candidate hash mismatch: {name}")
        bundle.extractall(package)
    extension = extension_root(package)
    plugin = package / "browser-link"
    for required in (
        extension / "manifest.json",
        extension / "background.mjs",
        plugin / "plugin.yaml",
        plugin / "native_bridge" / "host.py",
        package / "install-executor.py",
    ):
        if not required.is_file():
            raise ValueError(f"candidate missing required file: {required.relative_to(package)}")
    return {
        "archive": str(archive),
        "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "packageRoot": str(package),
        "extensionRoot": str(extension),
        "extensionLayout": "legacy-dist-native" if extension.name == "dist-native" else "flat",
        "pluginSource": str(plugin),
        "hashedFiles": len(manifest),
        "manifestExact": True,
    }


def install(work: Path, origins: list[str]) -> dict:
    paths = locations(work)
    paths["home"].mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        str(paths["package"] / "install-executor.py"),
        "--package",
        str(paths["package"]),
        "--user-home",
        str(paths["home"]),
        "--hermes-home",
        str(paths["hermes_home"]),
    ]
    for origin in origins:
        command.extend(["--extension-origin", origin])
    result = subprocess.run(command + ["--apply"], check=True, text=True, capture_output=True)
    json_start = result.stdout.rfind("\n{")
    payload = json.loads(result.stdout[json_start + 1:] if json_start >= 0 else result.stdout)
    launcher = paths["hermes_home"] / "plugin-data" / "browser-link-native" / "com.hermes.browser_link"
    launcher_text = launcher.read_text(encoding="utf-8")
    if str(paths["installed"] / "native_bridge" / "host.py") not in launcher_text:
        raise RuntimeError("installed launcher does not reference installed host")
    if str(paths["package"]) in launcher_text:
        raise RuntimeError("installed launcher still references extracted package")
    manifests = {}
    for browser in ("Google/Chrome", "Microsoft Edge"):
        manifest_path = paths["home"] / "Library/Application Support" / browser / "NativeMessagingHosts/com.hermes.browser_link.json"
        manifests[browser] = str(manifest_path)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("path") != str(launcher) or manifest.get("allowed_origins") != list(dict.fromkeys(origins)):
            raise RuntimeError("installed native manifest mismatch")
    return {
        **payload,
        "home": str(paths["home"]),
        "hermesHome": str(paths["hermes_home"]),
        "installedPlugin": str(paths["installed"]),
        "extensionRoot": str(extension_root(paths["package"])),
        "launcher": str(launcher),
        "manifests": manifests,
        "origins": list(dict.fromkeys(origins)),
        "sourceIndependent": True,
    }


def cleanup(work: Path) -> dict:
    paths = locations(work)
    pidfile = paths["hermes_home"] / "plugin-data" / "browser-link-native" / "daemon.pid"
    if pidfile.exists():
        pid = int(pidfile.read_text())
        command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True)
        expected = str(paths["hermes_home"])
        installed_daemon = str(paths["installed"] / "native_bridge" / "daemon.py")
        if command.returncode == 0 and installed_daemon in command.stdout and expected in command.stdout:
            stop_fixture_daemon(paths["hermes_home"])
        else:
            raise RuntimeError("refusing to stop non-fixture PID")
    return {}


def inspect_install(work: Path) -> dict:
    paths = locations(work)
    launcher = paths["hermes_home"] / "plugin-data" / "browser-link-native" / "com.hermes.browser_link"
    pidfile = paths["hermes_home"] / "plugin-data" / "browser-link-native" / "daemon.pid"
    if not pidfile.is_file():
        raise RuntimeError("installed daemon is not running")
    pid = int(pidfile.read_text())
    process = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, check=True)
    daemon_path = paths["installed"] / "native_bridge" / "daemon.py"
    if str(daemon_path) not in process.stdout or str(paths["hermes_home"]) not in process.stdout:
        raise RuntimeError("daemon process is not using installed package code")
    launcher_text = launcher.read_text(encoding="utf-8")
    if str(paths["installed"] / "native_bridge" / "host.py") not in launcher_text:
        raise RuntimeError("launcher is not using installed host code")
    return {
        "daemonPid": pid,
        "daemonCommand": process.stdout.strip(),
        "daemonPath": str(daemon_path),
        "hostPath": str(paths["installed"] / "native_bridge" / "host.py"),
        "pluginPath": str(paths["installed"]),
        "launcher": str(launcher),
        "extensionPath": str(extension_root(paths["package"])),
    }


def rpc(work: Path, session: str, suffix: str, args: dict) -> str:
    paths = locations(work)
    os.environ["HOME"] = str(paths["home"])
    os.environ["HERMES_HOME"] = str(paths["hermes_home"])
    hermes = Path(os.environ.get("HERMES_SOURCE", str(Path.home() / ".hermes/hermes-agent"))).resolve()
    sys.path.insert(0, str(hermes))
    from hermes_cli import plugins

    tools = load(paths["installed"] / "native_tools.py", "native_e2e_tools_" + uuid.uuid4().hex)
    profile = tools.runtime_module().NativeProfileRuntime(paths["hermes_home"], paths["installed"])
    original_call = profile.call

    def diagnostic_call(method, params):
        try:
            return original_call(method, params)
        except Exception as exc:
            print(
                json.dumps(
                    {
                        "rpc": method,
                        "action": params.get("action"),
                        "requestId": params.get("requestId"),
                        "exception": type(exc).__name__,
                        "code": getattr(exc, "code", None),
                        "message": str(exc),
                    }
                ),
                file=sys.stderr,
            )
            raise

    profile.call = diagnostic_call
    manager = plugins.PluginManager()
    manager._hooks.setdefault("pre_tool_call", []).append(profile.authority.pre_tool_call)
    name = "browser_shared_" + suffix
    try:
        with patch.object(plugins, "_delivery_manager", return_value=manager):
            block, bounded = plugins._dispatch_pre_tool_call_hooks(
                name, args, session_id=session, tool_call_id="browser-e2e-" + uuid.uuid4().hex
            )
            if block:
                raise RuntimeError(str(block))
            return tools.make_tool_handler(name, profile)(bounded, session_id=session)
    finally:
        profile.close()


def main() -> None:
    mode = sys.argv[1]
    work = Path(sys.argv[2])
    if mode == "prepare":
        value = prepare(work, Path(sys.argv[3]))
    elif mode == "install":
        value = install(work, json.loads(sys.argv[3]))
    elif mode == "cleanup":
        value = cleanup(work)
    elif mode == "inspect":
        value = inspect_install(work)
    elif mode == "rpc":
        value = json.loads(rpc(work, sys.argv[3], sys.argv[4], json.loads(sys.argv[5])))
    else:
        raise ValueError(f"unknown helper mode: {mode}")
    print(json.dumps(value, ensure_ascii=False))


if __name__ == "__main__":
    main()
