"""中文注释：完整加载插件时仅替换宿主能力表和临时目录，不依赖 Hermes、rg 或 git。"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

PLUGIN = Path(__file__).resolve().parents[2] / 'executor-plugin'
HOOKS = {'pre_tool_call', 'on_session_finalize', 'subagent_stop', 'on_session_end', 'agent_loop_stopped'}


class Context:
    def __init__(self, supported):
        self.supported = supported
        self.hooks = {}
        self.tools = {}
        self.skills = set()
        self.sections = set()
        self.unload = []

    def get_config(self, key, default=None):
        return default

    def has_capability(self, capability):
        return False

    def register_hook(self, name, callback):
        # 中文注释：不支持的钩子若被注册就失败，防止测试只检查表面工具清单。
        if name not in self.supported:
            raise AssertionError('unsupported hook: ' + name)
        self.hooks[name] = callback

    def register_tool(self, *, name, handler, override=False, **_):
        assert not override
        self.tools[name] = handler

    def register_skill(self, name, path, **_):
        assert Path(path).is_file()
        self.skills.add(name)

    def register_system_prompt_section(self, id, content):
        self.sections.add(id)

    def on_unload(self, callback):
        self.unload.append(callback)


class HookCompatibilityTests(unittest.TestCase):
    def test_plugin_loads_all_tools_with_missing_hooks_without_warnings(self):
        for supported in (HOOKS, HOOKS - {'on_session_end'}, HOOKS - {'agent_loop_stopped'},
                          HOOKS - {'on_session_end', 'agent_loop_stopped'}, {'pre_tool_call'}, set()):
            with self.subTest(hooks=sorted(supported)), tempfile.TemporaryDirectory() as scratch:
                constants = types.ModuleType('hermes_constants')
                constants.get_hermes_home = lambda: Path(scratch)
                host = types.ModuleType('hermes_cli.plugins')
                host.VALID_HOOKS = supported
                name = 'browser_link_hook_test'
                spec = importlib.util.spec_from_file_location(name, PLUGIN / '__init__.py',
                                                              submodule_search_locations=[str(PLUGIN)])
                plugin = importlib.util.module_from_spec(spec)
                # 中文注释：常量和能力仅对该次加载生效，避免真实用户目录或其他测试受影响。
                with mock.patch.dict(sys.modules, {name: plugin, 'hermes_constants': constants,
                                                   'hermes_cli.plugins': host}):
                    spec.loader.exec_module(plugin)
                    ctx = Context(supported)
                    with self.assertNoLogs('browser-link', level='WARNING'):
                        plugin.register(ctx)
                    native = plugin._load_native_tools()
                    self.assertEqual(set(ctx.tools), {*native.TOOL_NAMES, 'browser_shared_script', 'browser_shared_open',
                                                     'browser_shared_use_tab', 'browser_shared_reference', 'browser_shared_doctor',
                                                     'browser_site_search', 'browser_site_manage', 'browser_site_run'})
                    self.assertEqual(set(ctx.hooks), supported)
                    self.assertTrue(all(callable(handler) for handler in ctx.tools.values()))
                    # 中文注释：缺少预调用钩子也不能绕过授权；无租约调用在本地直接拒绝。
                    result = json.loads(ctx.tools['browser_shared_get']({'task_id': 'fixture'}, session_id='unbound'))
                    self.assertIn('error', result)
                    self.assertEqual(ctx.skills, {'use-my-browser', 'batch-scrape', 'troubleshoot'})
                    self.assertEqual(ctx.sections, {'browser-link.guide'})
                    self.assertEqual(len(ctx.unload), 2)
                    for cleanup in ctx.unload:
                        cleanup()


if __name__ == '__main__':
    unittest.main()
