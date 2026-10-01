"""Negative-control tests for the static official-browser inventory gate."""
from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRATCH_ROOT = pathlib.Path.home() / ".hermes" / "cache" / "scratch"
SCRIPT = ROOT / "scripts" / "inventory-official-browser.py"
_SPEC = importlib.util.spec_from_file_location("inventory_official_browser", SCRIPT)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"cannot load inventory script: {SCRIPT}")
_INVENTORY = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_INVENTORY)


class InventoryFixture(unittest.TestCase):
    def setUp(self):
        SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="official-browser-inventory-", dir=str(SCRATCH_ROOT))
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.hermes = self.root / "hermes"
        self.tools = self.hermes / "tools"
        self.tools.mkdir(parents=True)
        (self.hermes / "pyproject.toml").write_text(
            '[project]\nname = "hermes-agent"\nversion = "9.8.7"\n', encoding="utf-8"
        )
        (self.tools / "registry.py").write_text("# static fixture only\n", encoding="utf-8")
        (self.tools / "browser_tool.py").write_text(
            '''CLICK_SCHEMA = {
    "name": "browser_click",
    "description": "Click a stable page reference.",
    "parameters": {"type": "object", "properties": {"ref": {"type": "string"}}, "required": ["ref"]},
}
registry.register(name="browser_click", toolset="browser", schema=CLICK_SCHEMA,
                  handler=click, check_fn=check_click)
''', encoding="utf-8"
        )
        (self.tools / "browser_use_cli.py").write_text(
            '''DEFAULT_TIMEOUT = 30
_HELPERS_DIGEST = "new_tab(url) and goto_url(url)"
BROWSER_EXEC_SCHEMA = {
    "name": "browser_exec",
    "description": "Run browser Python.",
    "parameters": {"type": "object", "properties": {
        "code": {"type": "string"},
        "timeout_s": {"type": "integer", "default": DEFAULT_TIMEOUT},
    }, "required": ["code"]},
}
def _run_cli_killing_process_group(cmd, code, env, timeout):
    proc = subprocess.Popen(cmd)
    return proc.communicate()
def browser_exec(code):
    return _run_cli_killing_process_group([], code, {}, 30)
def _dynamic_schema_overrides():
    if real_profile_consented():
        return {"parameters": {"properties": {"local": {"type": "boolean"}}}}
    return {}
registry.register(name="browser_exec", toolset="browser-use", schema=BROWSER_EXEC_SCHEMA,
                  handler=browser_exec, check_fn=is_browser_use_cli_mode,
                  dynamic_schema_overrides=_dynamic_schema_overrides)
''', encoding="utf-8"
        )
        (self.hermes / "model_tools.py").write_text(
            '''def _rewrite_browser_exec(td, available):
    if "terminal" not in available:
        return None
    return td
_DYNAMIC_SCHEMA_REWRITERS = {"browser_exec": _rewrite_browser_exec}
''', encoding="utf-8"
        )
        (self.hermes / "tools" / "browser_extension_router.py").write_text(
            "def route_browser_tool(action, args):\n    return action, args\n", encoding="utf-8"
        )
        self.cli = self.root / "site-packages"
        package = self.cli / "browser_harness"
        package.mkdir(parents=True)
        browser_use = self.cli / "browser_use"
        browser_use.mkdir()
        (browser_use / "cli.py").write_text(
            '''def _run_browser_harness():
    from browser_harness import run
    run.main()
def main():
    return _run_browser_harness()
''', encoding="utf-8"
        )
        dist = self.cli / "browser_use-1.2.3.dist-info"
        dist.mkdir()
        (dist / "METADATA").write_text(
            "Metadata-Version: 2.1\nName: browser-use\nVersion: 1.2.3\n", encoding="utf-8"
        )
        (dist / "entry_points.txt").write_text(
            "[console_scripts]\nbrowser-use = browser_use.cli:main\n", encoding="utf-8"
        )
        harness_dist = self.cli / "browser_harness-0.1.8.dist-info"
        harness_dist.mkdir()
        (harness_dist / "METADATA").write_text(
            "Metadata-Version: 2.1\nName: browser-harness\nVersion: 0.1.8\n", encoding="utf-8"
        )
        # Importing the source would fail deliberately; AST inventory must never execute it.
        (package / "helpers.py").write_text(
            '''raise RuntimeError("CLI helper source was executed")
def new_tab(url="about:blank"):
    pass
def goto_url(url):
    pass
def page_info():
    pass
def fill_input(selector, text, clear_first=True, timeout=0.0):
    pass
def http_get(url):
    pass
def _private_helper():
    pass
''', encoding="utf-8"
        )
        (package / "run.py").write_text(
            '''from .helpers import *
import importlib.util
def _load_agent_helpers():
    p = AGENT_WORKSPACE / "agent_helpers.py"
    spec = importlib.util.spec_from_file_location("agent_helpers", p)
    if spec and spec.loader:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
''', encoding="utf-8"
        )
        (package / "paths.py").write_text("def workspace_dir():\n    return None\n", encoding="utf-8")
        (package / "__init__.py").write_text("__version__ = '1.2.3'\n", encoding="utf-8")

    def inventory(self):
        return _INVENTORY.collect_inventory(self.hermes, self.cli)

    def test_registered_tools_helpers_and_dynamic_schemas_are_static(self):
        inventory = self.inventory()
        tools = {item["name"]: item for item in inventory["official_tools"]}
        self.assertIn("browser_click", tools)
        self.assertEqual(tools["browser_click"]["status"], "缺失")
        self.assertEqual(tools["browser_click"]["schema"]["parameters"]["required"], ["ref"])
        self.assertEqual(tools["browser_exec"]["schema"]["parameters"]["properties"]["timeout_s"]["default"], 30)
        helpers = {item["name"] for item in inventory["official_helpers"]}
        self.assertEqual(helpers, {"new_tab", "goto_url", "page_info", "fill_input", "http_get"})
        helper_rows = {item["name"]: item for item in inventory["official_helpers"]}
        self.assertEqual(helper_rows["new_tab"]["status"], "部分")
        self.assertEqual(helper_rows["goto_url"]["status"], "部分")
        self.assertEqual(helper_rows["http_get"]["status"], "缺失")
        self.assertEqual(helper_rows["page_info"]["status"], "部分")
        self.assertEqual(helper_rows["fill_input"]["status"], "部分")
        dynamic = [item for item in inventory["dynamic_schemas"] if item.get("tool") == "browser_exec"]
        self.assertTrue(dynamic)
        self.assertTrue(any("real_profile_consented" in condition
                            for item in dynamic for condition in item.get("conditions", [])))
        self.assertTrue(any(item["name"] == "browser_exec" for item in inventory["model_schema_rewriters"]))
        execution = inventory["cli_execution_contract"]
        self.assertEqual(execution["helper_description_claims"], ["goto_url", "new_tab"])
        self.assertTrue(execution["cli_delegates_to_harness"])
        self.assertTrue(execution["harness_imports_helper_exports"])
        self.assertTrue(execution["workspace_helpers"]["loaded_from_workspace"])
        self.assertTrue(execution["fresh_python_process_per_browser_exec_call"])
        browser_exec_rewriter = next(item for item in inventory["model_schema_rewriters"] if item["name"] == "browser_exec")
        self.assertTrue(any("terminal" in condition for condition in browser_exec_rewriter["conditions"]))

    def test_removing_a_registered_tool_is_reported_as_drift(self):
        baseline = self.inventory()
        source = self.tools / "browser_tool.py"
        source.write_text("# registration deliberately omitted\n", encoding="utf-8")
        current = self.inventory()
        changes = _INVENTORY.compare_inventories(baseline, current)
        self.assertTrue(any("browser_click" in change and "removed" in change.lower() for change in changes), changes)

    def test_changing_a_tool_parameter_schema_is_reported_as_drift(self):
        baseline = self.inventory()
        source = self.tools / "browser_tool.py"
        text = source.read_text(encoding="utf-8").replace('"type": "string"', '"type": "integer"', 1)
        source.write_text(text, encoding="utf-8")
        current = self.inventory()
        changes = _INVENTORY.compare_inventories(baseline, current)
        self.assertTrue(any("browser_click" in change and "changed" in change.lower() for change in changes), changes)

    def test_adding_a_cli_helper_is_reported_as_drift(self):
        baseline = self.inventory()
        source = self.cli / "browser_harness" / "helpers.py"
        source.write_text(source.read_text(encoding="utf-8") + "\ndef press_key(key):\n    pass\n", encoding="utf-8")
        current = self.inventory()
        changes = _INVENTORY.compare_inventories(baseline, current)
        self.assertTrue(any("press_key" in change and "added" in change.lower() for change in changes), changes)

    def test_removing_a_cli_helper_is_reported_as_drift(self):
        baseline = self.inventory()
        source = self.cli / "browser_harness" / "helpers.py"
        source.write_text("def new_tab(url='about:blank'):\n    pass\n", encoding="utf-8")
        current = self.inventory()
        changes = _INVENTORY.compare_inventories(baseline, current)
        self.assertTrue(any("goto_url" in change and "removed" in change.lower() for change in changes), changes)

    def test_changing_dynamic_schema_result_is_reported_as_drift(self):
        baseline = self.inventory()
        source = self.tools / "browser_use_cli.py"
        text = source.read_text(encoding="utf-8").replace('"type": "boolean"', '"type": "string"', 1)
        source.write_text(text, encoding="utf-8")
        current = self.inventory()
        changes = _INVENTORY.compare_inventories(baseline, current)
        self.assertTrue(any("dynamic schema changed" in change.lower() for change in changes), changes)

    def test_dynamic_browser_registration_fails_closed_instead_of_disappearing(self):
        source = self.tools / "browser_tool.py"
        source.write_text(
            'registry.register(name=dynamic_browser_name, toolset="browser", schema=CLICK_SCHEMA, handler=click)\n',
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "unresolved browser tool registration"):
            self.inventory()

    def test_check_command_exits_nonzero_after_negative_control_drift(self):
        baseline = self.inventory()
        baseline_path = self.root / "baseline.json"
        output_path = self.root / "current.json"
        baseline_path.write_text(json.dumps(baseline, indent=2), encoding="utf-8")
        source = self.tools / "browser_tool.py"
        source.write_text(source.read_text(encoding="utf-8").replace('"browser_click"', '"browser_tap"', 1), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--hermes-root", str(self.hermes), "--cli-root", str(self.cli),
             "--output", str(output_path), "--baseline", str(baseline_path), "--check"],
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(output_path.is_file())
        report = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertTrue(report["drift"], report)


if __name__ == "__main__":
    unittest.main()
