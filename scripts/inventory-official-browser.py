#!/usr/bin/env python3
"""Inventory Hermes browser calls and Browser Use CLI helpers without importing either.

The scanner only reads Python as text and parses it with ``ast``. It never imports
Hermes, Browser Use, Browser Harness, starts a CLI, or contacts a browser. The
checked-in baseline is intentionally updated only with ``--update-baseline``.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1
BROWSER_TOOLSETS = {"browser", "browser-use", "browser-cdp", "browser_vault"}
VALID_STATUSES = {"支持", "部分", "缺失"}
_DYNAMIC_RE = re.compile(r"\$dynamic\((.*)\)$", re.DOTALL)
_HELPER_CALL_RE = re.compile(r"(?<![\w.])([A-Za-z_]\w*)\s*\(")

# These are deliberate, evidence-based connector assessments. Presence in an
# upstream registry is never enough for support: the positive rows name the
# production adapter contract and its synthetic entry/dispatcher tests. New
# upstream calls remain conservatively marked missing until reviewed here.
_TOOL_ASSESSMENTS = {
    "browser_exec": {
        "status": "部分",
        "reason": (
            "The original registered handler and Browser Use CLI cross the host-FD, daemon, and Executor "
            "path for a limited helper subset. Raw CDP/JS and most helpers remain unsupported; the exercised "
            "tests are synthetic and do not establish installed or real-browser compatibility."
        ),
        "evidence": [
            "tests/v1.1-official-actions/test_official_entry.py",
            "tests/v1.1-official-actions/test_full_vertical.py",
            "tests/v1.1-official-actions/test_official_route.py",
        ],
    },
}
_HELPER_ASSESSMENTS = {
    "new_tab": {
        "status": "部分",
        "reason": (
            "A connected task-owned work tab returns the real CDP targetId through the official helper path; "
            "blank-tab reuse and unrestricted target selection are intentionally not equivalent."
        ),
        "evidence": [
            "tests/v1.1-official-actions/test_official_entry.py",
            "tests/v1.1-official-actions/test_official_route.py",
        ],
    },
    "goto_url": {
        "status": "部分",
        "reason": (
            "The bound work tab returns a constrained Page.navigate receipt; allowed-origin checks and the "
            "absence of the optional domain-skills result prevent claiming the full CLI contract."
        ),
        "evidence": [
            "tests/v1.1-official-actions/test_official_entry.py",
            "tests/v1.1-official-actions/test_official_route.py",
        ],
    },
    "wait_for_load": {
        "status": "部分",
        "reason": (
            "The original helper polls document.readyState through the connected action lane, but only the "
            "synthetic path is exercised and other readiness/network-idle helpers are not wired."
        ),
        "evidence": [
            "tests/v1.1-official-actions/test_official_entry.py",
            "tests/v1.1-official-actions/test_official_route.py",
        ],
    },
    "capture_screenshot": {
        "status": "部分",
        "reason": (
            "The bridge writes viewport PNG bytes to the original CLI path contract and its synthetic Python "
            "handler test verifies screenshot attachment. Full-page capture is explicitly unsupported; no real-browser "
            "screenshot behavior is established."
        ),
        "evidence": [
            "executor-plugin/script_lane/action_session.py",
            "tests/v1.1-python/test_official_bridge.py",
            "tests/v1.1-python/official_smoke_child.py",
        ],
    },
    "http_get": {
        "status": "缺失",
        "reason": (
            "This upstream helper performs direct HTTP rather than an action on the selected browser; the "
            "connector has no equivalent bridge implementation. It is outside the connector's browser-operation scope."
        ),
        "evidence": [
            "docs/python-scripting.md",
            "executor-plugin/script_lane/host_bridge.py",
        ],
    },
    "page_info": {
        "status": "部分",
        "reason": (
            "An opt-in host capability routes and validates the official page_info result shape in the synthetic "
            "CLI/host path. It is disabled by default and has not been verified against a real browser."
        ),
        "evidence": [
            "executor-plugin/script_lane/host_bridge.py",
            "executor-plugin/script_lane/action_session.py",
            "tests/v1.1-python/test_official_bridge.py",
        ],
    },
    "fill_input": {
        "status": "部分",
        "reason": (
            "An opt-in host capability requires a key-event delivery receipt and is covered by synthetic bridge "
            "tests. It is disabled by default; real page event delivery and browser versions remain unverified."
        ),
        "evidence": [
            "executor-plugin/script_lane/host_bridge.py",
            "executor-plugin/script_lane/action_session.py",
            "tests/v1.1-python/test_official_bridge.py",
        ],
    },
}


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _canonical_hash(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return _sha256(raw)


def _node_text(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except (AttributeError, ValueError):  # pragma: no cover - Python 3.8 compatibility
        return ast.dump(node, include_attributes=False)


def _dynamic(node: ast.AST) -> str:
    return f"$dynamic({_node_text(node)})"


def _eval_static(node: ast.AST, constants: dict[str, ast.AST], seen: tuple[str, ...] = ()) -> Any:
    """Evaluate JSON-like literals and constant references, never arbitrary code."""
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in {"True", "False", "None"}:
            return {"True": True, "False": False, "None": None}[node.id]
        if node.id in constants and node.id not in seen:
            return _eval_static(constants[node.id], constants, seen + (node.id,))
        return _dynamic(node)
    if isinstance(node, ast.Dict):
        result: dict[Any, Any] = {}
        for key_node, value_node in zip(node.keys, node.values):
            key = _eval_static(key_node, constants, seen) if key_node is not None else _dynamic(node)
            value = _eval_static(value_node, constants, seen)
            if isinstance(key, str) or isinstance(key, (int, float, bool)) or key is None:
                result[key] = value
            else:
                return _dynamic(node)
        return result
    if isinstance(node, ast.List):
        return [_eval_static(value, constants, seen) for value in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_eval_static(value, constants, seen) for value in node.elts)
    if isinstance(node, ast.Set):
        return sorted((_eval_static(value, constants, seen) for value in node.elts), key=repr)
    if isinstance(node, ast.JoinedStr):
        pieces = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                pieces.append(value.value)
            elif isinstance(value, ast.FormattedValue):
                formatted = _eval_static(value.value, constants, seen)
                if isinstance(formatted, str):
                    pieces.append(formatted)
                elif isinstance(formatted, (int, float, bool)) or formatted is None:
                    pieces.append(str(formatted))
                else:
                    return _dynamic(node)
            else:
                return _dynamic(node)
        return "".join(pieces)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _eval_static(node.left, constants, seen)
        right = _eval_static(node.right, constants, seen)
        if type(left) is type(right) and isinstance(left, (str, int, float, list, tuple)):
            try:
                return left + right
            except TypeError:
                pass
        return _dynamic(node)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        value = _eval_static(node.operand, constants, seen)
        if isinstance(value, (int, float)):
            return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, ast.Subscript):
        value = _eval_static(node.value, constants, seen)
        index = _eval_static(node.slice, constants, seen)
        try:
            return value[index]
        except (KeyError, IndexError, TypeError):
            return _dynamic(node)
    if isinstance(node, ast.Slice):
        return slice(
            _eval_static(node.lower, constants, seen) if node.lower else None,
            _eval_static(node.upper, constants, seen) if node.upper else None,
            _eval_static(node.step, constants, seen) if node.step else None,
        )
    if isinstance(node, ast.IfExp):
        # Keep branches explicit; evaluating a condition could call arbitrary code.
        return _dynamic(node)
    return _dynamic(node)


def _module_constants(tree: ast.Module) -> dict[str, ast.AST]:
    constants: dict[str, ast.AST] = {}
    for statement in tree.body:
        if isinstance(statement, ast.Assign):
            for target in statement.targets:
                if isinstance(target, ast.Name):
                    constants[target.id] = statement.value
        elif isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name) and statement.value is not None:
            constants[statement.target.id] = statement.value
    return constants


def _parse_source(path: Path) -> ast.Module:
    try:
        return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, UnicodeError, SyntaxError) as exc:
        raise ValueError(f"cannot statically parse {path.name}: {exc}") from exc


def _function_map(tree: ast.Module) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    return {
        item.name: item for item in tree.body
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    rendered = _node_text(node).splitlines()[0].strip()
    return rendered[:-1] if rendered.endswith(":") else rendered


def _function_details(tree: ast.Module, function_name: str) -> dict[str, Any]:
    function = _function_map(tree).get(function_name)
    if function is None:
        return {"function": function_name, "unresolved": True, "conditions": [], "calls": [], "writes": [], "returns": []}
    conditions = sorted({
        _node_text(item.test) for item in ast.walk(function) if isinstance(item, ast.If)
    })
    calls = sorted({
        _node_text(item.func) for item in ast.walk(function) if isinstance(item, ast.Call)
    })
    writes = sorted({
        _node_text(target)
        for item in ast.walk(function)
        if isinstance(item, (ast.Assign, ast.AnnAssign, ast.AugAssign))
        for target in (item.targets if isinstance(item, ast.Assign) else [item.target])
        if isinstance(target, (ast.Subscript, ast.Attribute))
    })
    returns = sorted({
        _node_text(item.value) if item.value is not None else "None"
        for item in _iter_module_nodes(function.body)
        if isinstance(item, ast.Return)
    })
    return {
        "function": function_name,
        "unresolved": False,
        "signature": _signature(function),
        "conditions": conditions,
        "calls": calls,
        "writes": writes,
        "returns": returns,
        "line": function.lineno,
    }


def _iter_module_nodes(nodes: Iterable[ast.stmt]) -> Iterable[ast.AST]:
    """Walk module-level control flow, excluding nested functions and classes."""
    for node in nodes:
        yield node
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        for field in ("body", "orelse", "finalbody"):
            value = getattr(node, field, None)
            if isinstance(value, list):
                yield from _iter_module_nodes(value)
        for handler in getattr(node, "handlers", ()):
            yield from _iter_module_nodes(handler.body)


def _is_register_call(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    return (
        isinstance(func, ast.Attribute) and func.attr == "register"
        and isinstance(func.value, ast.Name) and func.value.id == "registry"
    )


def _keyword_nodes(call: ast.Call) -> dict[str, ast.AST]:
    return {item.arg: item.value for item in call.keywords if item.arg is not None}


def _bind_target(target: ast.AST, value: Any, bound: dict[str, Any]) -> None:
    if isinstance(target, ast.Name):
        bound[target.id] = value
    elif isinstance(target, (ast.Tuple, ast.List)) and isinstance(value, (tuple, list)):
        values = list(value)
        starred = next((i for i, child in enumerate(target.elts) if isinstance(child, ast.Starred)), None)
        if starred is None:
            for child, item in zip(target.elts, values):
                _bind_target(child, item, bound)
        else:
            fixed_after = len(target.elts) - starred - 1
            prefix = values[:starred]
            middle = values[starred:len(values) - fixed_after if fixed_after else None]
            suffix = values[len(values) - fixed_after:] if fixed_after else []
            for child, item in zip(target.elts[:starred], prefix):
                _bind_target(child, item, bound)
            star_item = target.elts[starred]
            if isinstance(star_item, ast.Starred):
                _bind_target(star_item.value, tuple(middle), bound)
            for child, item in zip(target.elts[starred + 1:], suffix):
                _bind_target(child, item, bound)


def _schema_values(tree: ast.Module, constants: dict[str, ast.AST]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, expression in constants.items():
        value = _eval_static(expression, constants)
        candidates = value if isinstance(value, (list, tuple)) else (value,)
        for candidate in candidates:
            if isinstance(candidate, dict) and isinstance(candidate.get("name"), str):
                result[candidate["name"]] = candidate
    return result


def _call_registration(
    call: ast.Call,
    *,
    constants: dict[str, ast.AST],
    schema_by_name: dict[str, Any],
    source_rel: str,
    local_values: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    env = dict(constants)
    static_locals = local_values or {}
    keywords = _keyword_nodes(call)

    def value_of(node: ast.AST | None) -> Any:
        if node is None:
            return None
        if isinstance(node, ast.Name) and node.id in static_locals:
            return static_locals[node.id]
        return _eval_static(node, env)

    name = value_of(keywords.get("name"))
    toolset = value_of(keywords.get("toolset"))
    if not isinstance(name, str) or name.startswith("$dynamic("):
        # A browser tool using an unresolved dynamic name must fail inventory rather
        # than disappearing from the official-call list.
        if isinstance(toolset, str) and toolset.startswith("browser"):
            raise ValueError(f"unresolved browser tool registration in {source_rel}:{call.lineno}")
        return None
    if not (name.startswith("browser_") or (isinstance(toolset, str) and toolset.startswith("browser"))):
        return None
    schema_node = keywords.get("schema")
    schema = value_of(schema_node)
    if isinstance(schema_node, ast.Subscript):
        schema_key = value_of(schema_node.slice)
        if isinstance(schema_key, str):
            schema = schema_by_name.get(schema_key, schema)
    if isinstance(schema_node, ast.Name) and not isinstance(schema, dict):
        schema = schema_by_name.get(name, schema)
    if isinstance(schema, dict) and isinstance(schema.get("name"), str):
        schema = dict(schema)
    elif name in schema_by_name:
        schema = schema_by_name[name]
    else:
        schema = {"$unresolved_schema": _node_text(schema_node) if schema_node else None}
    check_node = keywords.get("check_fn")
    check_fn = None if check_node is None else _node_text(check_node)
    if isinstance(check_node, ast.Name) and local_values and check_node.id in local_values:
        gate_value = local_values[check_node.id]
        if gate_value is None:
            check_fn = f"_routed_check_fn({name!r})"
        elif isinstance(gate_value, str) and gate_value.startswith("$dynamic("):
            check_fn = gate_value[len("$dynamic("):-1]
        else:
            check_fn = str(gate_value)
    dynamic_node = keywords.get("dynamic_schema_overrides")
    dynamic = _node_text(dynamic_node) if dynamic_node is not None else None
    defaults = local_values.get("_defaults") if local_values else None
    handler_node = keywords.get("handler")
    return {
        "name": name,
        "toolset": toolset if isinstance(toolset, str) else None,
        "schema": schema,
        "schema_sha256": _canonical_hash(schema),
        "availability": {
            "check_fn": check_fn,
            "conditional": check_fn is not None and check_fn != "None",
        },
        "dynamic_schema_overrides": dynamic,
        "handler_expression": _node_text(handler_node) if handler_node is not None else None,
        "handler_defaults": defaults,
        "registration_source": source_rel,
        "registration_line": call.lineno,
    }


def _tool_registrations(tools_dir: Path) -> tuple[list[dict[str, Any]], set[str]]:
    candidates = sorted(set(tools_dir.glob("*.py")) | set(tools_dir.glob("*/tool.py")))
    found: list[dict[str, Any]] = []
    source_files: set[str] = set()
    for path in candidates:
        tree = _parse_source(path)
        constants = _module_constants(tree)
        schema_by_name = _schema_values(tree, constants)
        rel = path.relative_to(tools_dir.parent).as_posix()
        parents = {
            child: parent
            for parent in ast.walk(tree)
            for child in ast.iter_child_nodes(parent)
        }
        grouped: dict[ast.AST, list[ast.Call]] = {}
        direct: list[ast.Call] = []
        for node in ast.walk(tree):
            if not _is_register_call(node):
                continue
            if not isinstance(node, ast.Call):
                continue
            ancestor = node
            nearest_loop = None
            module_scope = True
            while ancestor in parents:
                ancestor = parents[ancestor]
                if isinstance(ancestor, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                    module_scope = False
                    break
                if nearest_loop is None and isinstance(ancestor, (ast.For, ast.AsyncFor)):
                    nearest_loop = ancestor
            if not module_scope:
                continue
            if nearest_loop is None:
                direct.append(node)
            else:
                grouped.setdefault(nearest_loop, []).append(node)

        for loop, calls in grouped.items():
            if not isinstance(loop, (ast.For, ast.AsyncFor)):
                continue
            values = _eval_static(loop.iter, constants)
            if not isinstance(values, (list, tuple)):
                continue
            for row in values:
                bound: dict[str, Any] = {}
                _bind_target(loop.target, row, bound)
                for call in calls:
                    item = _call_registration(
                        call, constants=constants, schema_by_name=schema_by_name,
                        source_rel=rel, local_values=bound,
                    )
                    if item is not None:
                        found.append(item)
                        source_files.add(rel)
        for call in direct:
            item = _call_registration(
                call, constants=constants, schema_by_name=schema_by_name, source_rel=rel,
            )
            if item is not None:
                found.append(item)
                source_files.add(rel)
    found.sort(key=lambda item: (item["name"], item.get("toolset") or "", item["registration_source"], item["registration_line"]))
    return found, source_files


def _git_revision(root: Path) -> str | None:
    marker = root / ".git"
    try:
        if marker.is_file():
            first = marker.read_text(encoding="utf-8").strip()
            if first.startswith("gitdir:"):
                git_dir = (root / first.split(":", 1)[1].strip()).resolve()
            else:
                return None
        elif marker.is_dir():
            git_dir = marker
        else:
            return None
        head = (git_dir / "HEAD").read_text(encoding="utf-8").strip()
        if not head.startswith("ref: "):
            return head
        ref = head[5:]
        loose = git_dir / ref
        if loose.is_file():
            return loose.read_text(encoding="utf-8").strip()
        packed = git_dir / "packed-refs"
        if packed.is_file():
            for line in packed.read_text(encoding="utf-8").splitlines():
                if line and not line.startswith(("#", "^")):
                    commit, name = line.split(" ", 1)
                    if name == ref:
                        return commit
    except (OSError, ValueError):
        return None
    return None


def _hermes_version(root: Path) -> str | None:
    pyproject = root / "pyproject.toml"
    if not pyproject.is_file():
        return None
    in_project = False
    for line in pyproject.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_project = stripped == "[project]"
        elif in_project:
            match = re.match(r"version\s*=\s*['\"]([^'\"]+)['\"]", stripped)
            if match:
                return match.group(1)
    return None


def _metadata_fields(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    if not path.is_file():
        return result
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            if key in {"Name", "Version"}:
                result[key.lower()] = value.strip()
    return result


def _entrypoint(site_root: Path, dist: Path) -> tuple[str | None, Path | None]:
    path = dist / "entry_points.txt"
    if not path.is_file():
        return None, None
    in_scripts = False
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_scripts = stripped == "[console_scripts]"
            continue
        if in_scripts and "=" in stripped:
            name, target = (part.strip() for part in stripped.split("=", 1))
            if name.split("[", 1)[0].strip() == "browser-use":
                return target, path
    return None, path


def _cli_source_inventory(cli_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    cli_root = cli_root.resolve()
    site_root = cli_root.parent if cli_root.name == "browser_harness" else cli_root
    harness = cli_root if cli_root.name == "browser_harness" else site_root / "browser_harness"
    browser_use = site_root / "browser_use"
    if not (harness / "helpers.py").is_file() or not (harness / "run.py").is_file():
        raise ValueError(f"{cli_root} must contain browser_harness/helpers.py and browser_harness/run.py")
    browser_dist = sorted(site_root.glob("browser_use-*.dist-info"))
    harness_dist = sorted(site_root.glob("browser_harness-*.dist-info"))
    if not browser_dist or not harness_dist:
        raise ValueError("CLI source root must include browser-use and browser-harness dist-info metadata")
    browser_meta_path = browser_dist[0] / "METADATA"
    harness_meta_path = harness_dist[0] / "METADATA"
    browser_meta = _metadata_fields(browser_meta_path)
    harness_meta = _metadata_fields(harness_meta_path)
    entrypoint, entrypoint_path = _entrypoint(site_root, browser_dist[0])

    helper_path = harness / "helpers.py"
    helper_tree = _parse_source(helper_path)
    helper_funcs = _function_map(helper_tree)
    helper_records: list[dict[str, Any]] = []
    helper_sources: dict[str, tuple[Path, ast.Module]] = {"browser_harness/helpers.py": (helper_path, helper_tree)}
    for name, function in helper_funcs.items():
        if name.startswith("_"):
            continue
        helper_records.append({
            "name": name,
            "signature": _signature(function),
            "source": "browser_harness/helpers.py",
            "line": function.lineno,
            "summary": (ast.get_docstring(function) or "").splitlines()[0] if ast.get_docstring(function) else "",
        })
    # Public callable imports are also exposed by ``from .helpers import *``.
    for node in helper_tree.body:
        if not isinstance(node, ast.ImportFrom):
            continue
        if node.level == 1 and node.module == "recorder":
            recorder_path = harness / "recorder.py"
            if recorder_path.is_file():
                recorder_tree = _parse_source(recorder_path)
                helper_sources["browser_harness/recorder.py"] = (recorder_path, recorder_tree)
                recorder_functions = _function_map(recorder_tree)
            else:
                recorder_functions = {}
            for alias in node.names:
                name = alias.asname or alias.name
                function = recorder_functions.get(alias.name)
                if name.startswith("_") or function is None:
                    continue
                helper_records.append({
                    "name": name,
                    "signature": _signature(function),
                    "source": "browser_harness/recorder.py",
                    "line": function.lineno,
                    "summary": (ast.get_docstring(function) or "").splitlines()[0] if ast.get_docstring(function) else "",
                    "exported_via": "browser_harness.helpers",
                })

    run_path = harness / "run.py"
    run_tree = _parse_source(run_path)
    cli_path = browser_use / "cli.py"
    if not cli_path.is_file():
        raise ValueError("Browser Use CLI source root is missing browser_use/cli.py")
    cli_tree = _parse_source(cli_path)
    cli_functions = _function_map(cli_tree)
    run_functions = _function_map(run_tree)
    helper_imports = any(
        isinstance(node, ast.ImportFrom) and node.level == 1 and node.module == "helpers"
        and any(alias.name == "*" for alias in node.names)
        for node in run_tree.body
    )
    delegate_function = cli_functions.get("_run_browser_harness")
    delegates_to_harness = bool(delegate_function and any(
        isinstance(node, ast.ImportFrom) and node.module == "browser_harness"
        and any(alias.name == "run" for alias in node.names)
        for node in ast.walk(delegate_function)
    ) and any(
        isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name) and node.func.value.id == "run" and node.func.attr == "main"
        for node in ast.walk(delegate_function)
    ))
    workspace_loader = run_functions.get("_load_agent_helpers") or _function_map(helper_tree).get("_load_agent_helpers")
    workspace_source = helper_path if workspace_loader and workspace_loader in helper_funcs.values() else run_path
    workspace_tree = helper_tree if workspace_source == helper_path else run_tree
    workspace_text = workspace_source.read_text(encoding="utf-8", errors="replace")
    workspace_loads_agent_helpers = (
        workspace_loader is not None and "agent_helpers.py" in workspace_text
        and "spec_from_file_location" in workspace_text and "exec_module" in workspace_text
    )
    public_imported_helpers = sorted({item["name"] for item in helper_records})
    helper_records.sort(key=lambda item: (item["name"], item["source"]))

    browser_meta_rel = browser_meta_path.relative_to(site_root).as_posix()
    harness_meta_rel = harness_meta_path.relative_to(site_root).as_posix()
    entrypoint_rel = entrypoint_path.relative_to(site_root).as_posix() if entrypoint_path else None
    source_paths = set(harness.rglob("*.py")) | set(browser_use.rglob("*.py"))
    source_paths.update({browser_meta_path, harness_meta_path})
    if entrypoint_path:
        source_paths.add(entrypoint_path)
    sources = []
    for path in sorted(set(source_paths)):
        if not path.is_file():
            if path in {helper_path, run_path, cli_path, browser_meta_path, harness_meta_path}:
                raise ValueError(f"required CLI inventory source missing: {path.name}")
            continue
        sources.append({"path": path.relative_to(site_root).as_posix(), "sha256": _sha256(path.read_bytes())})

    return (
        {
            "distribution": browser_meta.get("name", "browser-use"),
            "version": browser_meta.get("version"),
            "entry_point": {"command": "browser-use", "target": entrypoint},
            "harness_distribution": harness_meta.get("name", "browser-harness"),
            "harness_version": harness_meta.get("version"),
            "cli_delegates_to_harness": delegates_to_harness,
            "harness_imports_helper_exports": helper_imports,
            "workspace_helpers": {
                "path": "agent_helpers.py",
                "loaded_from_workspace": workspace_loads_agent_helpers,
                "loader_source": "browser_harness/helpers.py" if workspace_source == helper_path else "browser_harness/run.py",
                "callable_names_runtime_defined": True,
                "status": "部分" if workspace_loads_agent_helpers else "缺失",
                "reason": (
                    "The original CLI dynamically loads public workspace functions, but bridge calls from those "
                    "functions still inherit the limited supported-helper subset."
                    if workspace_loads_agent_helpers else "No static workspace helper loader was found."
                ),
                "evidence": ["tests/v1.1-python/test_distributed_helper.py", "docs/python-scripting.md"],
            },
            "fresh_python_process_per_browser_exec_call": True,
            "helper_description_claims": [],
            "helper_exports": public_imported_helpers,
        },
        helper_records,
        sources,
    )


def _browser_description_claims(browser_cli_path: Path) -> list[str]:
    tree = _parse_source(browser_cli_path)
    constants = _module_constants(tree)
    value = None
    for name in ("_HELPERS_DIGEST",):
        if name in constants:
            value = _eval_static(constants[name], constants)
            break
    if not isinstance(value, str):
        return []
    non_api_words = {"navigates", "value"}
    return sorted({
        name for name in _HELPER_CALL_RE.findall(value)
        if re.fullmatch(r"[a-z][a-z0-9_]*", name) and name not in non_api_words
    })


def _expression_function_details(tree: ast.Module, expression: ast.AST) -> dict[str, Any]:
    functions = _function_map(tree)
    names = sorted({
        node.id for node in ast.walk(expression)
        if isinstance(node, ast.Name) and node.id in functions
    })
    details = [_function_details(tree, name) for name in names]
    return {
        "function": _node_text(expression),
        "component_functions": names,
        "unresolved": not bool(details),
        "conditions": sorted({condition for item in details for condition in item.get("conditions", [])}),
        "calls": sorted({call for item in details for call in item.get("calls", [])}),
        "writes": sorted({write for item in details for write in item.get("writes", [])}),
        "returns": sorted({value for item in details for value in item.get("returns", [])}),
    }


def _browser_exec_process_contract(hermes_root: Path) -> bool:
    path = hermes_root / "tools" / "browser_use_cli.py"
    if not path.is_file():
        return False
    tree = _parse_source(path)
    functions = _function_map(tree)
    browser_exec = functions.get("browser_exec")
    runner = functions.get("_run_cli_killing_process_group")
    if browser_exec is None or runner is None:
        return False
    calls_runner = any(
        isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        and node.func.id == "_run_cli_killing_process_group"
        for node in ast.walk(browser_exec)
    )
    starts_process = any(
        isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        and node.func.attr == "Popen"
        for node in ast.walk(runner)
    )
    communicates = any(
        isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        and node.func.attr == "communicate"
        for node in ast.walk(runner)
    )
    return calls_runner and starts_process and communicates


def _model_schema_rewriters(hermes_root: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    path = hermes_root / "model_tools.py"
    if not path.is_file():
        return [], []
    tree = _parse_source(path)
    constants = _module_constants(tree)
    expression = constants.get("_DYNAMIC_SCHEMA_REWRITERS")
    if not isinstance(expression, ast.Dict):
        return [], []
    functions = _function_map(tree)
    records: list[dict[str, Any]] = []
    dynamic: list[dict[str, Any]] = []
    for key_node, value_node in zip(expression.keys, expression.values):
        key = _eval_static(key_node, constants) if key_node else None
        if not isinstance(key, str) or not key.startswith("browser_"):
            continue
        details = _expression_function_details(tree, value_node)
        assessment = {
            "status": "部分" if key == "browser_exec" else "缺失",
            "reason": (
                "Hermes conditionally filters or rewrites this schema, but the connector has not verified "
                "every live tool-definition variant through the registered model-facing entry."
            ),
            "evidence": ["docs/V1.1-OFFICIAL-COMPATIBILITY-PLAN.md", "tests/v1.1-official-actions/test_official_entry.py"],
        }
        record = {"name": key, "transform": _node_text(value_node), **details, **assessment}
        records.append(record)
        dynamic.append({
            "tool": key,
            "kind": "model_tool_definition_rewriter",
            "source": "model_tools.py",
            "transform": _node_text(value_node),
            "conditions": details.get("conditions", []),
            "returns": details.get("returns", []),
            **assessment,
        })
    records.sort(key=lambda item: item["name"])
    dynamic.sort(key=lambda item: (item["tool"], item["kind"]))
    return records, dynamic


def _registry_dynamic_schemas(hermes_root: Path, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    by_module: dict[str, ast.Module] = {}
    for tool in tools:
        expression = tool.get("dynamic_schema_overrides")
        if not expression:
            continue
        path = hermes_root / tool["registration_source"]
        tree = by_module.setdefault(tool["registration_source"], _parse_source(path))
        function_name = expression if re.match(r"^[A-Za-z_]\w*$", expression) else None
        details = _function_details(tree, function_name) if function_name else {
            "function": expression, "unresolved": True, "conditions": [], "calls": [], "writes": [], "returns": []
        }
        assessment = {
            "status": "部分" if tool["name"] == "browser_exec" else "缺失",
            "reason": (
                "A source-level conditional schema path is present; its runtime-config variants have not all "
                "been exercised through the plugin's public model-tool registration."
            ),
            "evidence": ["docs/V1.1-OFFICIAL-COMPATIBILITY-PLAN.md", "tests/v1.1-official-actions/test_official_entry.py"],
        }
        rows.append({
            "tool": tool["name"],
            "kind": "registry_dynamic_schema_overrides",
            "source": tool["registration_source"],
            **details,
            **assessment,
        })
    rows.sort(key=lambda item: (item["tool"], item["source"]))
    return rows


def _assessment(surface: str, item: dict[str, Any]) -> dict[str, Any]:
    name = item.get("name", "")
    if surface == "tool":
        selected = _TOOL_ASSESSMENTS.get(name)
        default_reason = (
            "Hermes registers this official call, but the connector has no exact public adapter plus "
            "contract-level execution evidence for it. Similar browser_shared actions do not count as "
            "the same tool or return contract."
        )
        evidence = [
            "executor-plugin/script_lane/action_session.py",
            "tests/v1.1-official-actions/test_official_route.py",
        ]
    else:
        selected = _HELPER_ASSESSMENTS.get(name)
        default_reason = (
            "The helper is callable in the upstream CLI, but no equivalent connector implementation and "
            "contract-level test were found; API-name presence is not compatibility."
        )
        evidence = [
            "executor-plugin/script_lane/action_session.py",
            "tests/v1.1-official-actions/test_official_route.py",
        ]
    result = dict(selected or {"status": "缺失", "reason": default_reason, "evidence": evidence})
    if result.get("status") not in VALID_STATUSES:
        raise ValueError(f"invalid compatibility status for {surface} {name}: {result.get('status')}")
    return result


def _read_sources(paths: Iterable[Path], root: Path, required: set[str] | None = None) -> list[dict[str, str]]:
    result = []
    required = required or set()
    for path in sorted(set(paths)):
        rel = path.relative_to(root).as_posix()
        if not path.is_file():
            if rel in required:
                raise ValueError(f"required Hermes inventory source missing: {rel}")
            continue
        result.append({"path": rel, "sha256": _sha256(path.read_bytes())})
    return result


def collect_inventory(hermes_root: Path, cli_root: Path) -> dict[str, Any]:
    """Read official source trees into a deterministic, JSON-safe inventory."""
    hermes_root = Path(hermes_root).resolve()
    cli_root = Path(cli_root).resolve()
    tools_dir = hermes_root / "tools"
    if not tools_dir.is_dir():
        raise ValueError(f"Hermes source root must contain tools/: {hermes_root}")
    tools, registration_sources = _tool_registrations(tools_dir)
    for item in tools:
        item.update(_assessment("tool", item))
    model_rewriters, model_dynamic = _model_schema_rewriters(hermes_root)
    registry_dynamic = _registry_dynamic_schemas(hermes_root, tools)
    cli, helpers, cli_sources = _cli_source_inventory(cli_root)
    helper_digest_source = hermes_root / "tools" / "browser_use_cli.py"
    cli["helper_description_claims"] = _browser_description_claims(helper_digest_source) if helper_digest_source.is_file() else []
    cli["fresh_python_process_per_browser_exec_call"] = _browser_exec_process_contract(hermes_root)
    actual_helpers = {item["name"] for item in helpers}
    cli["helper_description_diff"] = {
        "described_but_not_exported": sorted(set(cli["helper_description_claims"]) - actual_helpers),
        "exported_but_not_described": sorted(actual_helpers - set(cli["helper_description_claims"])),
    }
    for item in helpers:
        item.update(_assessment("helper", item))

    hermes_required = {
        "model_tools.py",
        "tools/registry.py",
        "tools/browser_use_cli.py",
        "tools/browser_extension_router.py",
    }
    hermes_paths = [hermes_root / name for name in hermes_required]
    hermes_paths.extend(hermes_root / source for source in registration_sources)
    if (hermes_root / "pyproject.toml").is_file():
        hermes_paths.append(hermes_root / "pyproject.toml")
    hermes_sources = _read_sources(hermes_paths, hermes_root, hermes_required)
    return {
        "schema_version": SCHEMA_VERSION,
        "inventory_scope": {
            "hermes_registry_scan": "tools/*.py and tools/*/tool.py; only static registry.register declarations are counted",
            "cli_helper_surface": "public functions declared by browser_harness.helpers plus its explicit public recorder imports",
            "runtime_not_imported": True,
            "browser_launched": False,
            "compatibility_rule": "A registered name or similarly named project action is not evidence of semantic compatibility.",
        },
        "versions": {
            "hermes": {
                "version": _hermes_version(hermes_root),
                "git_revision": _git_revision(hermes_root),
            },
            "browser_use_cli": {
                "distribution": cli["distribution"],
                "version": cli["version"],
                "entry_point": cli["entry_point"],
                "harness_distribution": cli["harness_distribution"],
                "harness_version": cli["harness_version"],
            },
        },
        "official_tools": tools,
        "official_helpers": helpers,
        "cli_execution_contract": {
            key: cli[key] for key in (
                "entry_point", "cli_delegates_to_harness", "harness_imports_helper_exports",
                "workspace_helpers", "fresh_python_process_per_browser_exec_call",
                "helper_description_claims", "helper_description_diff", "helper_exports",
            )
        },
        "dynamic_schemas": sorted(registry_dynamic + model_dynamic, key=lambda item: (item["tool"], item["kind"])),
        "model_schema_rewriters": model_rewriters,
        "source_hashes": {
            "hermes": hermes_sources,
            "browser_use_cli": cli_sources,
        },
    }


def _indexed(items: list[dict[str, Any]], identity: tuple[str, ...]) -> dict[tuple[str, ...], dict[str, Any]]:
    return {tuple(str(item.get(field, "")) for field in identity): item for item in items}


def compare_inventories(baseline: dict[str, Any], current: dict[str, Any]) -> list[str]:
    """Return actionable added/removed/changed API and source-fingerprint drift."""
    changes: list[str] = []
    if baseline.get("versions") != current.get("versions"):
        changes.append("source versions/revision changed")
    for collection, identity, label, compare_keys in (
        ("official_tools", ("name", "toolset", "registration_source"), "tool", ("schema", "availability", "dynamic_schema_overrides", "handler_defaults")),
        ("official_helpers", ("name", "source"), "helper", ("signature",)),
        ("dynamic_schemas", ("tool", "kind", "source"), "dynamic schema", ("function", "transform", "conditions", "calls", "writes", "returns")),
        ("model_schema_rewriters", ("name",), "model schema rewriter", ("transform", "conditions", "calls", "writes", "returns")),
    ):
        before = _indexed(baseline.get(collection, []), identity)
        after = _indexed(current.get(collection, []), identity)
        for key in sorted(after.keys() - before.keys()):
            changes.append(f"{label} added: {'/'.join(key)}")
        for key in sorted(before.keys() - after.keys()):
            changes.append(f"{label} removed: {'/'.join(key)}")
        for key in sorted(before.keys() & after.keys()):
            first, second = before[key], after[key]
            for field in compare_keys:
                if first.get(field) != second.get(field):
                    changes.append(f"{label} changed {field}: {'/'.join(key)}")
                    break
            if first.get("status") != second.get("status"):
                changes.append(f"{label} changed compatibility assessment: {'/'.join(key)}")
    for group in ("hermes", "browser_use_cli"):
        before = {item["path"]: item["sha256"] for item in baseline.get("source_hashes", {}).get(group, [])}
        after = {item["path"]: item["sha256"] for item in current.get("source_hashes", {}).get(group, [])}
        for path in sorted(after.keys() - before.keys()):
            changes.append(f"{group} source added: {path}")
        for path in sorted(before.keys() - after.keys()):
            changes.append(f"{group} source removed: {path}")
        for path in sorted(before.keys() & after.keys()):
            if before[path] != after[path]:
                changes.append(f"{group} source hash changed: {path}")
    if baseline.get("cli_execution_contract") != current.get("cli_execution_contract"):
        changes.append("CLI execution/helper-loading contract changed")
    if baseline.get("inventory_scope") != current.get("inventory_scope"):
        changes.append("inventory scan scope changed")
    return sorted(set(changes))


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    default_dir = Path(__file__).resolve().parents[1] / "tests" / "v1.1-compatibility"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-root", type=Path, default=os.environ.get("HERMES_SOURCE"), help="Hermes source checkout (or HERMES_SOURCE)")
    parser.add_argument("--cli-root", type=Path, default=os.environ.get("BROWSER_USE_CLI_SOURCE"), help="Browser Use site-packages root (or BROWSER_USE_CLI_SOURCE)")
    parser.add_argument("--output", type=Path, default=default_dir / "inventory.generated.json")
    parser.add_argument("--baseline", type=Path, default=default_dir / "inventory.baseline.json")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="exit 1 when inventory differs from baseline")
    mode.add_argument("--update-baseline", action="store_true", help="explicitly replace baseline with current static inventory")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if not args.hermes_root or not args.cli_root:
        print("error: set --hermes-root/--cli-root or HERMES_SOURCE/BROWSER_USE_CLI_SOURCE", file=sys.stderr)
        return 2
    try:
        inventory = collect_inventory(args.hermes_root, args.cli_root)
        drift: list[str] = []
        if args.check:
            if not args.baseline.is_file():
                print(f"error: baseline missing: {args.baseline}", file=sys.stderr)
                return 2
            baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
            drift = compare_inventories(baseline, inventory)
        report = dict(inventory)
        report["drift"] = drift
        _write_json(args.output, report)
        if args.update_baseline:
            _write_json(args.baseline, inventory)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if drift:
        print("official browser inventory drift detected:")
        for item in drift:
            print(f"- {item}")
        print(f"generated report: {args.output}")
        return 1
    tool_count = len(inventory["official_tools"])
    helper_count = len(inventory["official_helpers"])
    dynamic_count = len(inventory["dynamic_schemas"])
    print(f"inventory generated: {tool_count} official tools, {helper_count} CLI helpers, {dynamic_count} dynamic schema paths")
    print(f"report: {args.output}")
    if args.update_baseline:
        print(f"baseline updated: {args.baseline}")
    elif args.check:
        print(f"baseline matched: {args.baseline}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
