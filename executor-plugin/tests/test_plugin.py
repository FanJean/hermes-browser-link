from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

import yaml


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
TOOLS = {
    # 中文注释：网站工具固定入口也必须由插件清单声明。
    'browser_site_search', 'browser_site_manage', 'browser_site_run',
    *('browser_shared_' + name for name in (
        # 中文注释：用户登记的任务文件只公开元信息列表，不公开本地路径。
        'health', 'browsers', 'create', 'list', 'get', 'artifacts', 'run', 'cancel', 'resume', 'close', 'script', 'open', 'use_tab',
        'downloads', 'cookie_mirror', 'reference', 'doctor',
    )),
}


class _Context:
    def __init__(self):
        self.tools = set()
        self.hooks = set()
        self.skills = {}
        self.sections = {}
        self.unload = []

    def get_config(self, key, default=None):
        return default

    def has_capability(self, capability):
        # Not granted: official browser_* tools must stay Hermes' own.
        return False

    def register_tool(self, *, name, override=False, **kwargs):
        assert not override, 'no override without a tools.override grant'
        self.tools.add(name)

    def register_hook(self, name, callback):
        self.hooks.add(name)

    def register_skill(self, name, path, description=""):
        assert Path(path).is_file(), path
        self.skills[name] = Path(path)

    def register_system_prompt_section(self, id, content):
        self.sections[id] = content

    def on_unload(self, callback):
        self.unload.append(callback)


class PluginManifestTests(unittest.TestCase):
    def test_manifest_and_runtime_registration_are_exactly_aligned(self):
        manifest = yaml.safe_load((PLUGIN_ROOT / "plugin.yaml").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "browser-link")
        self.assertEqual(manifest["manifest_version"], 2)
        self.assertEqual(manifest["requires_hermes"], ">=0.21.4")
        self.assertEqual(set(manifest["provides_tools"]), TOOLS)
        # 中文注释：声明与实际五个钩子一致，完成宽限和中断清理均被覆盖。
        hooks = ['pre_tool_call', 'on_session_finalize', 'subagent_stop', 'on_session_end', 'agent_loop_stopped']
        self.assertEqual(manifest["hooks"], hooks)
        self.assertEqual(manifest["provides_hooks"], hooks)
        self.assertEqual(manifest["python_dependencies"], [])
        self.assertEqual(manifest["capabilities"], ["tools.override"])
        # 中文注释：Vault 接管单独默认关闭；旧式浏览器后端开关仍不应返回。
        self.assertEqual(set(manifest["config_schema"]), {"vault_tools.enabled"})
        self.assertIs(manifest["config_schema"]["vault_tools.enabled"]["default"], False)
        self.assertEqual(
            {entry["name"] for entry in manifest["external_dependencies"]},
            set(),
        )

        with tempfile.TemporaryDirectory() as tmp:
            fake_constants = types.ModuleType("hermes_constants")
            fake_constants.get_hermes_home = lambda: Path(tmp)
            previous = sys.modules.get("hermes_constants")
            sys.modules["hermes_constants"] = fake_constants
            name = "browser_link_plugin_under_test"
            spec = importlib.util.spec_from_file_location(
                name,
                PLUGIN_ROOT / "__init__.py",
                submodule_search_locations=[str(PLUGIN_ROOT)],
            )
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            try:
                spec.loader.exec_module(module)
                def reject_isolated_runtime():
                    raise AssertionError("connector registration must not initialize isolated runtime")
                setattr(module, "_runtime_module", reject_isolated_runtime)
                ctx = _Context()
                module.register(ctx)
                self.assertEqual(ctx.tools, TOOLS)
                native_spec = importlib.util.spec_from_file_location('native_schema_under_test', PLUGIN_ROOT / 'native_tools.py')
                native_module = importlib.util.module_from_spec(native_spec)
                native_spec.loader.exec_module(native_module)
                self.assertIn('同一会话', native_module.TOOL_SCHEMAS['browser_shared_get']['description'])
                self.assertEqual(ctx.hooks, set(hooks))
                self.assertEqual(set(ctx.skills), {"use-my-browser", "batch-scrape", "troubleshoot"})
                for name, path in ctx.skills.items():
                    self.assertIn(f"name: {name}", path.read_text(encoding="utf-8"))
                import re
                self.assertEqual(list(ctx.sections), ["browser-link.guide"])
                self.assertTrue(re.fullmatch(r"[a-z0-9._-]{1,128}", "browser-link.guide"))
                self.assertIn("browser-link:use-my-browser", ctx.sections["browser-link.guide"])
                self.assertEqual(len(ctx.unload), 2)
                for cleanup in ctx.unload:
                    cleanup()
            finally:
                sys.modules.pop(name, None)
                if previous is None:
                    sys.modules.pop("hermes_constants", None)
                else:
                    sys.modules["hermes_constants"] = previous

    def test_dashboard_manifest_is_hidden_api_host_not_standalone_ui(self):
        manifest = json.loads((PLUGIN_ROOT / "dashboard" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "browser-link")
        self.assertEqual(manifest["api"], "plugin_api.py")
        self.assertTrue(manifest["tab"]["hidden"])
        self.assertEqual(manifest["entry"], "noop.js")
        self.assertTrue((PLUGIN_ROOT / "dashboard" / "noop.js").is_file())


if __name__ == "__main__":
    unittest.main()
