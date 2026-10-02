"""Isolated source-package helper for shared native v2 real-browser acceptance."""
from __future__ import annotations

import importlib.util
import asyncio
import base64
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from tests.support import stop_fixture_daemon  # noqa: E402
from client import _probe  # noqa: E402


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
    installed = home / ".hermes" / "plugins" / "browser-link"
    return {
        "work": work,
        "home": home,
        "hermes": home / ".hermes",
        "plugin": installed if installed.is_dir() else work / "plugin" / "browser-link",
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


def stage_package(work: Path, package: Path, origins: list[str]):
    """在隔离 HOME 中安装候选包，并以安装后的文件运行所有后续工具调用。"""
    value = paths(work)
    package = package.expanduser().resolve()
    # 中文注释：以正式 CLI 调用安装脚本；模块导入会在待验包内写入 __pycache__，破坏摘要清单。
    command = [sys.executable, str(package / "install-executor.py"),
               "--package", str(package), "--user-home", str(value["home"]),
               "--hermes-home", str(value["hermes"]), "--apply"]
    for origin in origins:
        command.extend(("--extension-origin", origin))
    installed = json.loads(subprocess.run(command, check=True, capture_output=True, text=True).stdout)
    if installed.get("status") != "installed_disabled":
        raise RuntimeError("package-first installation was not confirmed")
    return {
        "plugin": installed["plugin"],
        "extension": str(package / "native-extension"),
        "home": str(value["home"]),
        "hermesHome": str(value["hermes"]),
        "host": installed["host"],
        "manifests": installed["manifests"],
        "origins": origins,
        "package": str(package),
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
    # 中文注释：源码阶段使用隔离 host-bin；正式包阶段必须核实 daemon 来自包内已安装的插件。
    installed_daemon = value["plugin"] / "native_bridge/daemon.py"
    host_daemon = value["hermes"] / "plugin-data/browser-link-native/host-bin/daemon.py"
    # 中文注释：源码阶段 daemon 可由隔离 host-bin 或临时安装的插件拉起，二者都必须在本次临时目录内。
    candidates = [path for path in (installed_daemon, host_daemon) if path.is_file() and path.is_relative_to(value["work"])]
    expected = next((path for path in candidates if str(path) in command), None)
    if expected is None or str(value["hermes"]) not in command:
        raise RuntimeError("daemon is not using staged bridge code")
    return {
        "daemonPid": pid,
        "daemonCommand": command,
        "daemonPath": str(expected),
        "pluginPath": str(value["plugin"]),
        "clientPath": str(value["plugin"] / "native_bridge/client.py"),
        "extensionPath": str(value["extension"]),
    }


def register_fixture_artifact(work: Path, session: str, task_id: str, origin: str,
                              filename: str, encoded: str):
    value = paths(work)
    tools = load(value["plugin"] / "native_tools.py", "native_v2_artifact_tools_" + uuid.uuid4().hex)
    profile = tools.runtime_module().NativeProfileRuntime(value["hermes"], value["plugin"])
    try:
        owner = profile.authority.owner_for_session(session)
        task = profile.call("shared.get", {"owner": owner, "taskId": task_id})
        data = base64.b64decode(encoded, validate=True)
        module = load(value["plugin"] / "native_bridge/artifacts.py", "native_v2_artifacts_" + uuid.uuid4().hex)

        class SelectedFile:
            content_type = "text/plain"

            def __init__(self):
                self.filename, self.offset = filename, 0

            async def read(self, size):
                chunk = data[self.offset:self.offset + size]
                self.offset += len(chunk)
                return chunk

        # 中文注释：只向临时任务登记合成文件，测试不读取个人文件路径。
        return asyncio.run(module.ArtifactStore(value["hermes"]).register(
            task=task, owner=owner, origin=origin, file=SelectedFile()))
    finally:
        profile.close()


def seed_fixture_vault(work: Path, origin: str):
    """在临时 Hermes Vault 内建立合成登录项，只把不透明句柄交给测试进程。"""
    value = paths(work)
    os.environ["HOME"] = str(value["home"])
    os.environ["HERMES_HOME"] = str(value["hermes"])
    source = Path(os.environ["HERMES_SOURCE"]).resolve()
    sys.path.insert(0, str(source))
    try:
        from agent.vault_store import get_vault_store
        # 中文注释：Fernet 文件仅落在本次隔离 HERMES_HOME；合成密码不经过 argv 或普通 RPC。
        item = get_vault_store().add_item("login", "Synthetic fixture",
                                          {"identifier_type": "username", "identifier": "fixture-user",
                                           "password": "synthetic-vault-password-2026"}, origin=origin)
        return {"handle": item.id, "origin": origin}
    finally:
        sys.path.remove(str(source))


def fill_fixture_vault(work: Path, session: str, task_id: str, tab_id: int, handle: str):
    """经真实 Hermes 插件注册、可信 hook 和官方 Vault 工具填写临时条目。"""
    value = paths(work)
    os.environ["HOME"] = str(value["home"])
    os.environ["HERMES_HOME"] = str(value["hermes"])
    source = Path(os.environ["HERMES_SOURCE"]).resolve()
    sys.path.insert(0, str(source))
    installed = value["hermes"] / "plugins" / "browser-link"
    installed.parent.mkdir(parents=True, exist_ok=True)
    if value["plugin"] != installed:
        shutil.copytree(value["plugin"], installed, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    # 中文注释：仅临时 Hermes 配置启用覆盖权限与 Vault；不改个人配置或外部密码管理器。
    (value["hermes"] / "config.yaml").write_text(
        "plugins:\n  enabled: [browser-link]\n  entries:\n    browser-link:\n"
        "      allow_tool_override: true\n      settings:\n        vault_tools:\n          enabled: true\n",
        encoding="utf-8",
    )
    try:
        from hermes_cli import plugins
        from tools.registry import registry
        # 中文注释：使用 Hermes 自己的全局插件管理器；另建管理器会在视觉路径导入 model_tools 时重复加载插件。
        manager = plugins.get_plugin_manager()
        manager.discover_and_load()
        try:
            loaded = manager._plugins.get("browser-link")
            if loaded is None or loaded.error or not loaded.enabled:
                raise RuntimeError("official Vault plugin registration failed")

            def invoke(name, args):
                # 中文注释：真实 pre_tool_call 生成一次性 owner lease，模型参数不含 owner 或密码。
                block, bounded = plugins._dispatch_pre_tool_call_hooks(
                    name, args, session_id=session, tool_call_id="vault-fixture-" + uuid.uuid4().hex)
                if block:
                    raise RuntimeError("official Vault hook denied")
                entry = registry.get_entry(name, scope=manager.scope_key)
                if entry is None or entry.toolset != "browser-link":
                    raise RuntimeError("official Vault override is unavailable")
                return json.loads(entry.handler(bounded, session_id=session))

            with patch.object(plugins, "_delivery_manager", return_value=manager):
                bound = invoke("browser_shared_get", {"task_id": task_id})
                if (bound.get("sessionBinding") != "ready" or bound.get("activeMode") != "full"
                        or tab_id not in bound.get("tabIds", [])):
                    raise RuntimeError("official Vault session binding unavailable")
                listed = invoke("browser_vault_list", {})
                if handle not in {item.get("handle") for item in listed.get("items", [])}:
                    raise RuntimeError("temporary Hermes Vault item not listed")
                return invoke("browser_vault_fill", {"handle": handle})
        finally:
            manager.unload()
    finally:
        sys.path.remove(str(source))


def official_calls(work: Path, session: str, task_id: str, calls: str, options: str):
    """经真实插件注册、可信 hook 与官方工具覆盖依次调用官方 browser_* 工具；结果逐项返回。

    options 可含 seed（临时 Vault 合成条目）与 prompts（登记到 Hermes 公开的遮盖输入回调位，代替人工输入）。
    """
    value = paths(work)
    os.environ["HOME"] = str(value["home"])
    os.environ["HERMES_HOME"] = str(value["hermes"])
    source = Path(os.environ["HERMES_SOURCE"]).resolve()
    sys.path.insert(0, str(source))
    installed = value["hermes"] / "plugins" / "browser-link"
    installed.parent.mkdir(parents=True, exist_ok=True)
    if value["plugin"] != installed and not installed.exists():
        shutil.copytree(value["plugin"], installed, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    (value["hermes"] / "config.yaml").write_text(
        "plugins:\n  enabled: [browser-link]\n  entries:\n    browser-link:\n"
        "      allow_tool_override: true\n      settings:\n        vault_tools:\n          enabled: true\n",
        encoding="utf-8",
    )
    opts = json.loads(options) if options else {}
    try:
        from hermes_cli import plugins
        from tools.registry import registry
        from agent.vault_store import get_vault_store
        from agent.vault_backends import unlock
        seeded = {}
        for key, item in (opts.get("seed") or {}).items():
            secret = {"identifier_type": "username", "identifier": item.get("identifier", "fixture-user"),
                      "password": item["password"]}
            if item.get("otp_secret"):
                secret["otp_secret"] = item["otp_secret"]
            seeded[key] = get_vault_store().add_item("login", item.get("label", key), secret, origin=item["origin"]).id
        prompts = opts.get("prompts") or {}
        if prompts:
            # 中文注释：测试只替换 Hermes 公开的遮盖输入回调位，插件与 Vault 链路保持真实。
            unlock.set_unlock_prompt_callback(lambda *args, **kwargs: None)
            if "login" in prompts:
                unlock.set_save_login_prompt_callback(lambda origin, site: dict(prompts["login"]))
            if "code" in prompts:
                unlock.set_code_prompt_callback(lambda site, hint: prompts["code"])
        # 中文注释：使用 Hermes 自己的全局插件管理器；另建管理器会在视觉路径导入 model_tools 时重复加载插件。
        manager = plugins.get_plugin_manager()
        manager.discover_and_load()
        results = []
        try:
            loaded = manager._plugins.get("browser-link")
            if loaded is None or loaded.error or not loaded.enabled:
                raise RuntimeError("official plugin registration failed")

            def invoke(name, args):
                block, bounded = plugins._dispatch_pre_tool_call_hooks(
                    name, args, session_id=session, tool_call_id="official-" + uuid.uuid4().hex)
                if block:
                    return {"hookBlocked": str(block)[:200]}
                entry = registry.get_entry(name, scope=manager.scope_key)
                # 中文注释：官方覆盖保留原 toolset；只要求注册表条目来自本插件模块。
                if entry is None or "browser" not in getattr(entry.handler, "__module__", "") + getattr(entry.handler, "__qualname__", ""):
                    return {"notRouted": name}
                raw = entry.handler(bounded, session_id=session)
                return json.loads(raw) if isinstance(raw, str) else {"multimodal": True, "meta": raw.get("meta", {})}

            with patch.object(plugins, "_delivery_manager", return_value=manager):
                results.append(invoke("browser_shared_get", {"task_id": task_id}))
                last_snapshot = ""

                def resolve(value):
                    # 中文注释：$seed: 取合成条目句柄；$ref: 按名称从同一批次最近一次快照文本找 @eN。
                    if isinstance(value, str) and value.startswith("$seed:"):
                        return seeded.get(value[6:], value)
                    if isinstance(value, str) and value.startswith("$ref:"):
                        for line in last_snapshot.splitlines():
                            if value[5:] in line and "[@e" in line:
                                return line.rsplit("[", 1)[1].rstrip("]")
                    return value

                for name, args in json.loads(calls):
                    result = invoke(name, {key: resolve(value) for key, value in args.items()})
                    if isinstance(result.get("snapshot"), str):
                        last_snapshot = result["snapshot"]
                    results.append(result)
            return {"results": results, "seeded": sorted(seeded)}
        finally:
            manager.unload()
    finally:
        sys.path.remove(str(source))


def official_blank_probe(work: Path, session: str, task_id: str):
    """在隔离任务中单测官方空白页动作，返回固定错误码而不重放未知写入。"""
    value = paths(work)
    os.environ["HOME"] = str(value["home"])
    os.environ["HERMES_HOME"] = str(value["hermes"])
    tools = load(value["plugin"] / "native_tools.py", "native_v2_blank_tools_" + uuid.uuid4().hex)
    profile = tools.runtime_module().NativeProfileRuntime(value["hermes"], value["plugin"])
    try:
        owner = profile.authority.owner_for_session(session)
        return profile.call("shared.run", {"owner": owner, "taskId": task_id,
                                           "requestId": "blank-probe-" + uuid.uuid4().hex,
                                           "action": "official.new_tab", "url": "about:blank"})
    except Exception as error:
        return {"errorCode": str(getattr(error, "code", "unclassified")),
                "outcomeUnknown": (getattr(error, "data", None) or {}).get("outcomeUnknown")}
    finally:
        profile.close()


def _real_cli():
    import pwd
    import shutil
    home = pwd.getpwuid(os.getuid()).pw_dir
    # 中文注释：优先使用已安装的 uv 工具副本，避免验收时 uvx 临时下载。
    installed = Path(home) / ".local/share/uv/tools/browser-use/bin/browser-use"
    if installed.is_file() and os.access(installed, os.X_OK):
        return [str(installed)]
    for probe in (str(Path(home) / ".hermes" / "bin"), str(Path(home) / ".local" / "bin"), None):
        found = shutil.which("browser-use", path=probe)
        if found:
            return [found]
    raise RuntimeError("browser-use CLI is required for browser_exec acceptance")


def browser_exec_run(work: Path, session: str, task_id: str, code: str, label: str):
    import threading
    value = paths(work)
    cli = _real_cli()
    os.environ["HOME"] = str(value["home"])
    os.environ["HERMES_HOME"] = str(value["hermes"])
    # 中文注释：临时目录很深，harness 的 Unix socket 路径会超过 macOS 104 字节上限；改用短运行目录。
    os.environ["BH_RUNTIME_DIR"] = str(value["work"] / "r")
    tools = load(value["plugin"] / "native_tools.py", "native_v2_exec_tools_" + uuid.uuid4().hex)
    profile = tools.runtime_module().NativeProfileRuntime(value["hermes"], value["plugin"])
    try:
        owner = profile.authority.owner_for_session(session)
        module = load(value["plugin"] / "single_tool_adapter" / "browser_exec.py", "native_v2_exec_" + uuid.uuid4().hex)

        class Bridge:
            _guard = threading.RLock()
            _bindings = {session: (owner, task_id, None, None, None, threading.Event())}

        # 中文注释：真实 Browser Use CLI 经插件适配器连接任务网关；HOME 指向临时目录，守护进程文件不落在用户目录。
        adapter = module.BrowserExecAdapter(profile, Bridge(), value["hermes"], cli_finder=lambda: cli)
        return json.loads(adapter.run({"code": code, "timeout_s": 180}, owner=owner, native_task=task_id,
                                      hermes_task=label))
    finally:
        profile.close()


def script_run(work: Path, session: str, task_id: str, code: str, checkpoint: str):
    """经真实脚本通道运行一段 Python；每次调用都是新的 Hermes 工具进程，用于验收协作式续跑。"""
    value = paths(work)
    os.environ["HOME"] = str(value["home"])
    os.environ["HERMES_HOME"] = str(value["hermes"])
    tools = load(value["plugin"] / "native_tools.py", "native_v2_script_tools_" + uuid.uuid4().hex)
    runtime = tools.runtime_module()
    profile = runtime.NativeProfileRuntime(value["hermes"], value["plugin"])
    try:
        bridge_module = runtime.load_module(value["plugin"] / "script_lane" / "host_bridge.py", "native_v2_script_bridge_")
        tool = runtime.load_module(value["plugin"] / "script_lane" / "tool.py", "native_v2_script_tool_")
        bridge = bridge_module.HostBridge(profile, value["plugin"])
        owner = profile.authority.owner_for_session(session)
        bridge.bind(session, owner=owner, task_id=task_id)
        try:
            return tool.run_script(bridge, session_id=session, tool_call_id="script-" + uuid.uuid4().hex,
                                   workspace=tool.workspace_for(value["hermes"], owner), code=code, timeout_s=180,
                                   resume_checkpoint=json.loads(checkpoint) if checkpoint else None,
                                   export_roots=os.environ.get("HERMES_BROWSER_EXPORT_ROOTS", ""))
        finally:
            bridge.close()
    finally:
        profile.close()


def shared_run(work: Path, session: str, params: str):
    """以可信会话身份直接调用 shared.run，用于验收只由官方适配器使用的内部参数（如截图标注）。"""
    value = paths(work)
    os.environ["HOME"] = str(value["home"])
    os.environ["HERMES_HOME"] = str(value["hermes"])
    tools = load(value["plugin"] / "native_tools.py", "native_v2_shared_tools_" + uuid.uuid4().hex)
    profile = tools.runtime_module().NativeProfileRuntime(value["hermes"], value["plugin"])
    try:
        return profile.call("shared.run", {"owner": profile.authority.owner_for_session(session), **json.loads(params)})
    except Exception as error:
        return {"errorCode": str(getattr(error, "code", "unclassified"))}
    finally:
        profile.close()


def harness_stop(work: Path, name: str):
    value = paths(work)
    env = {**os.environ, "HOME": str(value["home"]), "BU_NAME": name, "BH_RUNTIME_DIR": str(value["work"] / "r"),
           "ANONYMIZED_TELEMETRY": "false", "BH_TELEMETRY": "0"}
    result = subprocess.run([*_real_cli(), "--reload"], env=env, capture_output=True, text=True, timeout=60)
    return {"returncode": result.returncode}


def cleanup(work: Path):
    value = paths(work)
    pid_path = value["hermes"] / "plugin-data/browser-link-native/daemon.pid"
    if not pid_path.is_file():
        return {}
    pid = int(pid_path.read_text())
    command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True)
    # 中文注释：daemon 可能由 Native host（host-bin）或插件客户端（插件内 native_bridge）拉起，二者都在本次临时目录内。
    candidates = (value["plugin"] / "native_bridge/daemon.py", value["hermes"] / "plugin-data/browser-link-native/host-bin/daemon.py")
    expected = [str(path) for path in candidates if path.is_relative_to(value["work"])]
    if command.returncode == 0 and any(path in command.stdout for path in expected) and str(value["hermes"]) in command.stdout:
        # 中文注释：daemon 被测试终止后可能由临时插件目录内的客户端重新拉起，该路径也在本次临时目录内。
        stop_fixture_daemon(value["hermes"], extra_daemons=[path for path in expected])
    else:
        raise RuntimeError("refusing to stop non-fixture process")
    return {}


def kill_fixture_daemon(work: Path):
    value = paths(work)
    identity = inspect(work)
    pid_path = value["hermes"] / "plugin-data/browser-link-native/daemon.pid"
    pid = identity["daemonPid"]
    # 中文注释：崩溃恢复验收需要 SIGKILL；先核对临时 daemon 的命令、认证套接字和未变的 PID 文件。
    if not _probe(value["hermes"]) or int(pid_path.read_text()) != pid:
        raise RuntimeError("refusing to kill unverified fixture daemon")
    os.kill(pid, signal.SIGKILL)
    return {"pid": pid}


def main():
    mode = sys.argv[1]
    work = Path(sys.argv[2])
    if mode == "stage":
        result = stage(work, json.loads(sys.argv[3]))
    elif mode == "stage_package":
        result = stage_package(work, Path(sys.argv[3]), json.loads(sys.argv[4]))
    elif mode == "rpc":
        result = rpc(work, sys.argv[3], sys.argv[4], json.loads(sys.argv[5]))
    elif mode == "batch":
        result = batch(work, sys.argv[3], sys.argv[4], json.loads(sys.argv[5]))
    elif mode == "inspect":
        result = inspect(work)
    elif mode == "artifact":
        result = register_fixture_artifact(work, sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7])
    elif mode == "vault":
        result = fill_fixture_vault(work, sys.argv[3], sys.argv[4], int(sys.argv[5]), sys.argv[6])
    elif mode == "vault_seed":
        result = seed_fixture_vault(work, sys.argv[3])
    elif mode == "official_blank_probe":
        result = official_blank_probe(work, sys.argv[3], sys.argv[4])
    elif mode == "browser_exec":
        result = browser_exec_run(work, sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6])
    elif mode == "official_calls":
        result = official_calls(work, sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6] if len(sys.argv) > 6 else "")
    elif mode == "shared_run":
        result = shared_run(work, sys.argv[3], sys.argv[4])
    elif mode == "script":
        result = script_run(work, sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6] if len(sys.argv) > 6 else "")
    elif mode == "harness_stop":
        result = harness_stop(work, sys.argv[3])
    elif mode == "cleanup":
        result = cleanup(work)
    elif mode == "kill_daemon":
        result = kill_fixture_daemon(work)
    else:
        raise ValueError("unknown mode")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
