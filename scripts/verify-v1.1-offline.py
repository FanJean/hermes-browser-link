#!/usr/bin/env python3
"""Audited V1.1 source-only offline gate. Never start a browser or install.

Run from any cwd: python3 scripts/verify-v1.1-offline.py
All executed suites and builds run in a fresh scratch snapshot. A failing, absent,
zero-test, or timed-out step is red. Results live in tests/v1.1-verification/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
import uuid

ROOT = Path(__file__).resolve().parents[1]
# 中文注释：允许会话将验证暂存区放在独立临时目录，不写用户 Hermes 目录。
SCRATCH = Path(os.environ.get('HERMES_BROWSER_VERIFY_SCRATCH', str(Path.home() / '.hermes/cache/scratch')))
OUT = ROOT / 'tests/v1.1-verification'
SKIP_DIR = {'.git', 'node_modules', 'evidence', 'artifacts',
            'isolated', 'native-app', '.tmp', 'tmp', '__pycache__', '.pytest_cache',
            'coverage', 'results', 'logs', '.venv'}
# Only repository-root release/build outputs are generated payloads. Nested
# fixtures named release or dist are source inputs and must remain in snapshots.
SKIP_ROOT_DIR = {'release', 'dist', '.ci'}
# 中文注释：本地审计报告是验证后的生成输出，不参与运行源码快照；真实源码漂移仍须失败。
SKIP_FILES = {'CODEX-AUDIT-REPORT.md', 'CODEX-STREAM-REPORT.md', '.DS_Store', 'build-info.json', '.env', '.env.local',
              'token.json', 'credentials.json', 'latest.json', 'steps.json'}
# 当前共享浏览器桥接不再包含独立执行器依赖边界。
NODE_BOUNDARIES = ('.', 'cloud-link/site')
# Explicit runner inventory: no glob expands into browser, install, or evidence suites.
NODE_TESTS = (
    # 中文注释：云端授权与 SQLite/MCP 测试使用合成配对和设备，不连接个人浏览器。
    'tests/native-extension/cloud-link.test.mjs',
    'cloud-link/site/tests/cloud.test.mjs',
    # 中文注释：诊断三契约对照只导入源码并校验合成值，纳入显式离线清单。
    'browser-diagnostics/tests/diagnostics.test.mjs',
    # 中文注释：独立工作窗口和效果观察只用合成 API/DOM。
    'tests/v1.6.0/work-window.test.mjs',
    # 中文注释：浮层断连与本地放开回归只使用离线 DOM，不自动运行真实浏览器。
    'tests/v1.5.3/overlay-orphan.test.mjs',
    # 中文注释：Cookie 镜像只运行合成 API；真实双浏览器脚本不进入门禁。
    'tests/v1.5.0/cookie-mirror.test.mjs',
    # 中文注释：后台审批、权限提醒、弹窗与图标只运行离线合成 API。
    'tests/v1.5.1/approval-background.test.mjs',
    'tests/native-extension/background-access-request.test.mjs',
    # 中文注释：基准站离线测试覆盖目录、第二主机及原页面，直接调用处理器而不绑定端口。
    'bench/site/server.test.mjs',
    'bench/mechanical-metrics.test.mjs',
    'bench/mechanical-runner.test.mjs',
    'browser-workspaces/workspaces.test.mjs',
    'tests/v1-launch-safety/launch-safety.test.mjs',
    'tests/v1.1-advanced/frame-catalog.test.mjs',
    'tests/v1.1-highlight-wiring/wiring.test.mjs',
    'tests/v1.1-concurrency/tab-barrier.test.mjs',
    'tests/v1.1-runtime-performance/cdp-budget.test.mjs',
    'tests/network-evidence/network.test.mjs',
    'tests/network-evidence/page-request.test.mjs',
    'tests/v1.1-packaging/directory-swap.test.mjs',
    'tests/v1.1-packaging/dev-sync-daemon.test.mjs',
    'tests/v1.3/parser.test.mjs',
    'tests/v1.3/ledger.test.mjs',
    'tests/v1.1-interactions/test_inflight_guard.mjs',
    'tests/v1.1-semantics/enhancement.test.mjs',
    'tests/v1.1-overlay/background.test.mjs',
    'tests/v1.1-overlay/integration.test.mjs',
    'tests/v1.1-overlay/fail-closed.test.mjs',
    'tests/v1.1-ui/assets.test.mjs',
    'tests/v1.1-ui/background-integration.test.mjs',
    'tests/v1.1-ui/bridge-errors.test.mjs',
    'tests/v1.1-ui/notifier.test.mjs',
    'tests/v1.1-ui/overlay.test.mjs', 'tests/v1.1-ui/page-settle.test.mjs',
    'tests/v1.1-ui/panel.test.mjs',
    'tests/v1.1-docs/check-bridge-docs.test.mjs',
    'executor-plugin/desktop/plugin.test.mjs',
    'executor-plugin/desktop/render.test.mjs',
    # 中文注释：桌面镜像交互通过真实 React/Query 离线验收。
    'executor-plugin/desktop/cookie-mirror.test.mjs',
    # 中文注释：1.3.5 后台滚动短期限与任务租约回归在固定离线清单中运行。
    'tests/native-v2/native_core.test.mjs',
    'tests/native-extension/site-read-origin.test.mjs',
    'tests/native-extension/redirect-ready.test.mjs',
    'tests/popup-integration/popup.test.mjs',
    # 中文注释：内容过滤必须覆盖缓存重放和真实阻塞信息保留。
    'tests/popup-integration/content-filter.test.mjs',
    # 中文注释：受信 UI 配置和持续事件出口复用真实后台消息路由。
    'tests/popup-integration/native-routing.test.mjs',
    'page-semantics/long-text.test.mjs',
    'page-semantics/controls.test.mjs',
    'page-semantics/interaction-contract.test.mjs',
    'tests/complex-ui/semantics.test.mjs',
    'tests/complex-ui/actions.test.mjs',
    # 中文注释：局部无障碍查询验证真实引用、隐私、上限和句柄释放，不启动浏览器。
    'tests/complex-ui/accessibility.test.mjs',
    'tests/native-extension/sensitive-fields.test.mjs',
    'tests/native-extension/bridge-cdp-errors.test.mjs',
    'tests/native-extension/file-upload-visual.test.mjs',
    # 中文注释：1.3.6 同站并发、慢页、标签回收与选择器居中进入固定离线清单。
    'tests/v1.3.6/efficiency.test.mjs',
    # 中文注释：1.4.2 表单控件与截图敏感区域形态。
    'tests/v1.4.2/forms.test.mjs',
    # 中文注释：1.4.3 自动收组只运行离线模拟 API，不启动真实浏览器。
    'tests/v1.4.3/autoclose.test.mjs',
    # 中文注释：1f 只运行合成等待、脱敏和文档验收，不启动真实浏览器。
    'tests/v1.4.4/round1f.test.mjs',
)
PYTHON_SUITES = (
    # 中文注释：云端调度、原生帧及收尾测试仅使用临时 HOME 和可控网络替身。
    'cloud-link/tests',
    # 中文注释：自动更新的网络与调度调用均由测试替换，不触碰真实安装。
    'tests/auto-update',
    'browser-diagnostics/tests',
    # 中文注释：基准对比和评分测试含生命周期三类重复打开、tasks.json 快照与新增任务正确性。
    'bench', 'bench/agent',
    # 中文注释：同任务并发建页跨真实 daemon 与扩展逻辑。
    # 中文注释：改名迁移只使用临时 HOME 与浏览器配置目录。
    'tests/v1.6.0', 'tests/v1.5.2', 'tests/v1.5.1', 'tests/v1.5.0', 'tests/v1.4', 'tests/v1.4.1', 'tests/v1.4.2', 'tests/v1.4.3', 'tests/v1.4.4', 'tests/v1.3.6',
    'tests/v1.1-script-lane',
    'tests/v1.1-interactions', 'tests/v1.1-approval-notify',
    'tests/v1.1-verification', 'tests/native-v2',
    'executor-plugin/tests', 'native-bridge/tests',
)
# Some directories contain explicitly unsafe runners: select files by fixed name.
PYTHON_FILES = {
    'cloud-link/tests': ('test_cloud.py', 'test_native.py', 'test_scheduler.py', 'test_service.py'),
    'tests/auto-update': ('test_update.py',),
    # 中文注释：诊断用例只使用合成事件和临时日志目录，按名称限定运行范围。
    'browser-diagnostics/tests': ('test_schema.py', 'test_runtime.py', 'test_sink.py'),
    # 中文注释：1.6.0 生命周期 runner 按名称登记，真实浏览器脚本不进入离线门禁。
    'tests/v1.6.0': ('test_lifecycle.py',),
    # 中文注释：镜像中转与跨层隐私测试按文件登记，新增 runner 必须重新审阅。
    # 中文注释：安装流程仅使用临时 HOME、非 Git 包快照与命令替身。
    'tests/v1.5.2': ('test_install_flow.py', 'test_hook_compatibility.py'),
    'tests/v1.5.1': ('test_desktop_cookie_mirror.py',),
    'tests/v1.5.0': ('test_cookie_mirror.py',),
    'tests/v1.1-interactions': ('test_interaction_wire.py',),
    # 中文注释：1.3.6 同任务并发开页用例显式登记，避免清单检查把它当作未审阅文件。
    'tests/v1.3.6': ('test_concurrent_tabs.py',),
    'tests/native-v2': ('test_wire_contract.py', 'test_daemon_wire.py', 'test_click_mode.py'),
    'executor-plugin/tests': ('test_native_tools.py', 'test_api_native.py',
                              'test_native_integration.py', 'test_plugin.py', 'test_open_tool.py',
                              # 中文注释：结果隐私用例包含 1.3.3 复杂界面的跨层字段与错误摘要。
                              'test_result_privacy.py'),
    'native-bridge/tests': ('test_tasks.py', 'test_fd_lifecycle.py', 'test_cleanup_contract.py',
                            'test_cancel_routing.py', 'test_browser_consent.py', 'test_manual_input.py'),
}
# Keep one baseline step per suite, but import only these exact V1.1 files.
# This replaces unittest's broad test_*.py discovery in V1.1 directories.
PYTHON_GROUPED_FILES = {
    # 中文注释：脚本工具用例覆盖复杂界面回执经过宿主与子进程。
    'tests/v1.1-script-lane': ('test_action_session.py', 'test_script_tool.py', 'test_page_helpers.py'),
    'tests/v1.1-approval-notify': ('test_approval_notify.py',),
    'tests/v1.1-verification': ('test_gate.py',),
}
UNITTEST_FILES_RUNNER = '''\
import importlib.util, sys, unittest
paths = sys.argv[1:]
loader = unittest.TestLoader()
suite = unittest.TestSuite()
for index, path in enumerate(paths):
    spec = importlib.util.spec_from_file_location(f"gate_runner_{index}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    suite.addTests(loader.loadTestsFromModule(module))
result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if result.wasSuccessful() and result.testsRun else 1)
'''

# Individually reviewed runners from prior omissions plus the latest discovery
# delta. Every entry is an exact path; no entry expands a glob.
REVIEWED_RUNNER_PATHS = (
    'tests/v1.1-approval-notify/test_site_read.py',
    'tests/site-tools/test_sites.py',
    'tests/site-tools/test_reference_doctor.py',
    'tests/v1.3/test_script.py',
    'tests/v1.1-advanced/test_controls_validation.py',
    'tests/v1.1-advanced/pointer.test.mjs',
    'tests/v1.1-advanced/frame-catalog.test.mjs',
    'tests/v1.1-advanced/test_artifacts.py',
    'tests/v1.1-advanced/downloads.test.mjs',
    'tests/v1.1-advanced/test_downloads.py',
    # 中文注释：1.3.5 JavaScript 语法及运行异常分类用例。
    'tests/v1.1-advanced/advanced.test.mjs',
    'tests/v1.1-advanced/test_advanced.py',
    'tests/v1.1-advanced/test_browser_exec.py',
    'tests/v1.1-advanced/test_vault_private.py',
    'tests/v1.1-advanced/vault.test.mjs',
    'tests/v1.1-advanced/test_vault_adapter.py',
    'tests/v1.1-build-closure/build-closure.test.mjs',
    'tests/v1.1-compatibility/test_inventory_official_browser.py',
    'tests/v1.1-concurrency/test_production_concurrency.py',
    'tests/v1.1-diagnostics/test_doctor_protocol.py',
    'tests/v1.1-diagnostics/test_task_diagnostics.py',
    'tests/v1.1-diagnostics-api/test_diagnostics_api.py',
    'tests/v1.1-diagnostics-daemon/test_diagnostics_daemon.py',
    'tests/v1.1-diagnostics-install/test_stage_diagnostics.py',
    'tests/v1.1-highlight/highlight.test.mjs',
    'tests/v1.1-highlight-integration/test_highlight_integration.mjs',
    'tests/v1.1-highlight-wiring/wiring.test.mjs',
    'tests/v1.1-integration-check/checker.test.mjs',
    'tests/v1.1-interactions/navigation.test.mjs',
    'tests/v1.1-packaging/test_release_closure.py',
    'tests/v1.1-redaction-lint/redaction-lint.test.mjs',
    'tests/v1.1-security-audit/approval-origin.test.mjs',
    'tests/v1.1-security-audit/test_security_boundary.py',
    'tests/v1.1-semantics-quality/semantics-quality.test.mjs',
    'tests/v1.1-single-tools/test_adapter.py',
    'tests/v1.1-single-tools/test_override_registration.py',
    'tests/v1.1-runtime-performance/test_runtime_connection_budget.py',
    'tests/v1.1-runtime-performance/test_journal_recovery.py',
    'tests/v1.1-ui-acceptance/approval-panel.test.mjs',
    'tests/v1.1-ui-acceptance/desktop.test.mjs',
    'tests/v1.1-ui-fixes/desktop-connection-state.test.mjs',
    'tests/v1.1-ui-fixes/desktop-initial-loading.test.mjs',
    'tests/v1.1-workspace-fix/cleanup-state.test.mjs',
    'tests/v1.1-workspace-recovery/recovery.test.mjs',
    'tests/v1.1-workspace-transient/workspace-transient.test.mjs',
    'tests/v1.1-highlight-review/review.test.mjs',
    'tests/v1.1-lint-scope/lint-scope.test.mjs',
    'tests/v1.1-access-review/test_access_request_timeout.py',
    'tests/v1.1-highlight-deadline/deadline.test.mjs',
)
REVIEWED_RUNNER_CLASSIFICATIONS = {
    'tests/v1.1-approval-notify/test_site_read.py': 'pure-offline; in-process daemon and synthetic extension site-read approvals',
    'tests/site-tools/test_sites.py': 'pure-offline; draft validation and trusted script execution',
    'tests/site-tools/test_reference_doctor.py': 'pure-offline; reference drift and read-only socket diagnosis',
    'tests/v1.3/test_script.py': 'pure-offline; bounded child output and synthetic script protocol',
    'tests/v1.1-advanced/test_controls_validation.py': 'pure-offline; daemon parameter validator with no daemon or browser startup',
    'tests/v1.1-advanced/pointer.test.mjs': 'pure-offline; in-memory pointer adapter without browser startup',
    'tests/v1.1-advanced/frame-catalog.test.mjs': 'pure-offline; synthetic child CDP session and task origin scope',
    'tests/v1.1-advanced/test_artifacts.py': 'pure-offline; private task file and in-process HTTP upload fixtures',
    'tests/v1.1-advanced/downloads.test.mjs': 'pure-offline; synthetic debugger events and downloads API without browser startup',
    'tests/v1.1-advanced/test_downloads.py': 'pure-offline; in-process daemon and synthetic staged files under scratch',
    'tests/v1.1-advanced/advanced.test.mjs': 'pure-offline; synthetic debugger session for advanced JS/CDP policy',
    'tests/v1.1-advanced/test_advanced.py': 'pure-offline; in-process daemon and loopback CDP gateway with synthetic extension',
    'tests/v1.1-advanced/test_browser_exec.py': 'pure-offline; synthetic registry and runner, no CLI or browser',
    'tests/v1.1-advanced/test_vault_private.py': 'pure-offline; isolated local Vault socket and synthetic task/extension',
    'tests/v1.1-advanced/vault.test.mjs': 'pure-offline; synthetic visible form controls in jsdom',
    'tests/v1.1-advanced/test_vault_adapter.py': 'pure-offline; synthetic official Vault source and private typed-fill port',
    'tests/v1.1-build-closure/build-closure.test.mjs': 'pure-offline; build output in scratch',
    'tests/v1.1-compatibility/test_inventory_official_browser.py': 'pure-offline; synthetic inputs',
    'tests/v1.1-concurrency/test_production_concurrency.py': 'pure-offline; synthetic peer and scratch daemon',
    'tests/v1.1-diagnostics/test_doctor_protocol.py': 'pure-offline; synthetic daemon protocol diagnostics and scratch home',
    'tests/v1.1-diagnostics/test_task_diagnostics.py': 'pure-offline; temporary diagnostics sink',
    'tests/v1.1-diagnostics-api/test_diagnostics_api.py': 'pure-offline; in-process API fixture',
    'tests/v1.1-diagnostics-daemon/test_diagnostics_daemon.py': 'pure-offline; in-process daemon fixture',
    'tests/v1.1-diagnostics-install/test_stage_diagnostics.py': 'scratch-only host staging and in-process dispatcher; isolated HOME, no real profile registration',
    'tests/v1.1-highlight/highlight.test.mjs': 'pure-offline; jsdom fixture',
    'tests/v1.1-highlight-integration/test_highlight_integration.mjs': 'pure-offline; jsdom fixture',
    'tests/v1.1-highlight-wiring/wiring.test.mjs': 'pure-offline; jsdom fixture and native build output under TMPDIR scratch',
    'tests/v1.1-integration-check/checker.test.mjs': 'pure-offline; temporary repository fixture',
    'tests/v1.1-interactions/navigation.test.mjs': 'pure-offline; synthetic navigation and page state fixtures',
    'tests/v1.1-packaging/test_release_closure.py': 'scratch-only synthetic package/install; no registration',
    'tests/v1.1-redaction-lint/redaction-lint.test.mjs': 'pure-offline; jsdom and read-only ESLint invocation against the scratch snapshot',
    'tests/v1.1-security-audit/approval-origin.test.mjs': 'pure-offline; synthetic extension and sender',
    'tests/v1.1-security-audit/test_security_boundary.py': 'pure-offline; real plugin registration, script-lane FD and in-process daemon; synthetic extension',
    'tests/v1.1-semantics-quality/semantics-quality.test.mjs': 'pure-offline; evidence confined to scratch snapshot',
    'tests/v1.1-single-tools/test_adapter.py': 'pure-offline; fake adapter/runtime',
    'tests/v1.1-single-tools/test_override_registration.py': 'pure-offline; synthetic registry/context and URL policy; no Hermes source imported or patched',
    'tests/v1.1-runtime-performance/test_runtime_connection_budget.py': 'scratch-only synthetic UDS peers and native daemon; verified exact PID/home before SIGTERM',
    'tests/v1.1-runtime-performance/test_journal_recovery.py': 'scratch-only request journal recovery with synthetic extension and isolated daemon',
    'tests/v1.1-ui-acceptance/approval-panel.test.mjs': 'pure-offline; jsdom fixture',
    'tests/v1.1-ui-acceptance/desktop.test.mjs': 'pure-offline; jsdom fixture',
    'tests/v1.1-ui-fixes/desktop-connection-state.test.mjs': 'pure-offline; jsdom fixture',
    'tests/v1.1-ui-fixes/desktop-initial-loading.test.mjs': 'pure-offline; jsdom fixture',
    'tests/v1.1-workspace-fix/cleanup-state.test.mjs': 'pure-offline; synthetic workspace state',
    'tests/v1.1-workspace-recovery/recovery.test.mjs': 'pure-offline; synthetic peer and scratch daemon home',
    'tests/v1.1-workspace-transient/workspace-transient.test.mjs': 'pure-offline; synthetic workspace state',
    'tests/v1.1-highlight-review/review.test.mjs': 'pure-offline; jsdom and synthetic debugger API; no browser or external writes',
    'tests/v1.1-lint-scope/lint-scope.test.mjs': 'pure-offline; ESLint API reads exact source and lintText negative control; no cache/fix',
    'tests/v1.1-access-review/test_access_request_timeout.py': 'pure-offline; in-process daemon with synthetic extension record; temporary directory under scratch',
    'tests/v1.1-highlight-deadline/deadline.test.mjs': 'pure-offline; jsdom and synthetic debugger API; no browser, subprocess or network',
}
SUPPLEMENTAL_RUNNER_PATHS = (
    'tests/v1.1-ui-acceptance/popup.test.mjs',
    'tests/v1.1-redaction-fix/redaction.test.mjs',
)


def digest(file: Path) -> str:
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def ensure_no_symlink_components(path: Path) -> Path:
    """Return a lexical absolute path after rejecting symlink traversal."""
    path = Path(path).expanduser()
    if '..' in path.parts:
        raise RuntimeError(f'refusing parent traversal in output path: {path}')
    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        current = current / component
        if current.is_symlink():
            raise RuntimeError(f'refusing symlink path component: {current}')
    return absolute


def validate_gate_paths(out_path: Path, scratch_path: Path,
                        output_root: Path) -> tuple[Path, Path, Path]:
    """Validate scratch and report destinations without following symlinks."""
    out = ensure_no_symlink_components(out_path)
    scratch = ensure_no_symlink_components(scratch_path)
    output_root = ensure_no_symlink_components(output_root)
    logs_dir = ensure_no_symlink_components(output_root / 'logs')
    if scratch.exists() and not scratch.is_dir():
        raise RuntimeError(f'scratch path is not a directory: {scratch}')
    if logs_dir.exists() and not logs_dir.is_dir():
        raise RuntimeError(f'verification log path is not a directory: {logs_dir}')
    if output_root not in out.parents and scratch not in out.parents:
        raise RuntimeError('result must stay in repository-owned verification dir or user scratch')
    default_out = output_root / 'latest.json'
    if out.exists() and (out != default_out or not out.is_file()):
        raise RuntimeError(f'result already exists; choose a fresh --out: {out}')
    temporary_out = out.with_suffix('.tmp')
    if temporary_out.is_symlink() or (temporary_out.exists() and not temporary_out.is_file()):
        raise RuntimeError(f'result temporary path is not a plain file: {temporary_out}')
    ensure_no_symlink_components(temporary_out)
    return out, scratch, logs_dir


def source_paths(source: Path) -> list[tuple[Path, Path]]:
    """List the exact source inputs included by snapshot(), with symlink guards."""
    found: list[tuple[Path, Path]] = []
    for base, dirs, files in os.walk(source, followlinks=False):
        relative = Path(base).relative_to(source)
        for d in dirs:
            if d not in SKIP_DIR and (Path(base) / d).is_symlink():
                raise RuntimeError(f'unexpected source symlink: {Path(base) / d}')
        if relative == Path('.'):
            dirs[:] = [d for d in dirs if d not in SKIP_ROOT_DIR]
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIR)
        for name in sorted(files):
            path = Path(base) / name
            if name in SKIP_FILES:
                continue
            if path.is_symlink():
                raise RuntimeError(f'unexpected source symlink: {path}')
            if path.is_file():
                found.append((relative / name, path))
    return sorted(found, key=lambda row: row[0].as_posix())


def inventory(source: Path) -> dict[str, str]:
    return {relative.as_posix(): digest(path) for relative, path in source_paths(source)}


def manifest_sha256(hashes: dict[str, str]) -> str:
    payload = ''.join(f'{relative}\0{sha}\n' for relative, sha in sorted(hashes.items()))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def compare_inventories(before: dict[str, str], after: dict[str, str]) -> dict[str, list[str]]:
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    modified = sorted(relative for relative in set(before) & set(after)
                      if before[relative] != after[relative])
    return {'added': added, 'removed': removed, 'modified': modified}


def parse_count(text: str, kind: str) -> int | None:
    pattern = {'tap': r'^\s*#\s*tests\s+(\d+)\s*$',
               'unittest': r'^Ran (\d+) tests? in [0-9.]+s\s*$',
               'pytest': r'\b(\d+) passed(?:,| in |\s*$)'}.get(kind)
    if not pattern:
        return None
    found = re.findall(pattern, text, re.MULTILINE)
    return int(found[-1]) if found else None


def parse_skips(text: str, kind: str) -> int:
    pattern = {'tap': r'^# skipped (\d+)\s*$',
               'unittest': r'\bskipped=(\d+)\b',
               'pytest': r'\b(\d+) skipped\b'}.get(kind)
    return sum(map(int, re.findall(pattern, text, re.MULTILINE))) if pattern else 0


def parse_todos(text: str, kind: str) -> int:
    pattern = {'tap': r'^# todo (\d+)\s*$'}.get(kind)
    return sum(map(int, re.findall(pattern, text, re.MULTILINE))) if pattern else 0


def parse_failures(text: str, kind: str) -> list[str]:
    if kind == 'tap':
        return re.findall(r'^not ok \d+ - .+$', text, re.MULTILINE)
    if kind == 'unittest':
        return re.findall(r'^(\S+\s+\([^)]*\) \.\.\. (?:FAIL|ERROR))\s*$', text, re.MULTILINE)
    if kind == 'pytest':
        return re.findall(r'^(?:FAILED|ERROR)\s+\S+.*$', text, re.MULTILINE)
    return []


def save_json(path: Path, data: dict) -> None:
    if path.parent.is_symlink() or path.is_symlink():
        raise RuntimeError(f'refusing symlink JSON output: {path}')
    path = ensure_no_symlink_components(path)
    if path.exists() and not path.is_file():
        raise RuntimeError(f'refusing non-file JSON output: {path}')
    tmp = path.with_suffix('.tmp')
    if tmp.is_symlink() or tmp.exists():
        raise RuntimeError(f'refusing unsafe temporary JSON output: {tmp}')
    ensure_no_symlink_components(tmp)
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    try:
        fd = os.open(tmp, flags, 0o600)
    except FileExistsError as exc:
        raise RuntimeError(f'refusing unsafe temporary JSON output: {tmp}') from exc
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + '\n')
        tmp.replace(path)
    finally:
        if tmp.exists():
            tmp.unlink()


def copy_log_file(source: Path, destination: Path) -> None:
    if destination.parent.is_symlink() or destination.is_symlink():
        raise RuntimeError(f'refusing symlink log output: {destination}')
    destination = ensure_no_symlink_components(destination)
    if destination.exists():
        raise RuntimeError(f'refusing existing log output: {destination}')
    if destination.parent.exists() and not destination.parent.is_dir():
        raise RuntimeError(f'refusing non-directory log parent: {destination.parent}')
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f'.{destination.name}.', suffix='.tmp',
                                          dir=destination.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        shutil.copy2(source, temporary)
        try:
            os.link(temporary, destination)
        except FileExistsError as exc:
            raise RuntimeError(f'refusing existing log output: {destination}') from exc
    finally:
        if temporary.exists():
            temporary.unlink()


def create_run_log_dir(logs_root: Path) -> Path:
    """Create an invocation-unique directory so evidence is never replaced."""
    logs_root = ensure_no_symlink_components(logs_root)
    if logs_root.exists() and not logs_root.is_dir():
        raise RuntimeError(f'refusing non-directory log root: {logs_root}')
    logs_root.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ') + '-' + uuid.uuid4().hex
    run_dir = ensure_no_symlink_components(logs_root / run_id)
    run_dir.mkdir(exist_ok=False)
    return run_dir


def write_new_log_file(destination: Path, text: str) -> None:
    if destination.parent.is_symlink() or destination.is_symlink():
        raise RuntimeError(f'refusing symlink log output: {destination}')
    destination = ensure_no_symlink_components(destination)
    if destination.exists():
        raise RuntimeError(f'refusing existing log output: {destination}')
    if destination.parent.exists() and not destination.parent.is_dir():
        raise RuntimeError(f'refusing non-directory log parent: {destination.parent}')
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f'.{destination.name}.', suffix='.tmp',
                                          dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(text.encode('utf-8'))
        try:
            os.link(temporary, destination)
        except FileExistsError as exc:
            raise RuntimeError(f'refusing existing log output: {destination}') from exc
    finally:
        if temporary.exists():
            temporary.unlink()


def run_steps(root: Path, result_dir: Path, steps: list[tuple[str, list[str], str]],
              env: dict[str, str], *, timeout: int = 150) -> dict:
    result_dir = ensure_no_symlink_components(result_dir)
    if result_dir.exists() and not result_dir.is_dir():
        raise RuntimeError(f'refusing non-directory step log root: {result_dir}')
    result_dir.mkdir(parents=True, exist_ok=True)
    result: dict = {'passed': False, 'steps': []}
    for index, (name, command, kind) in enumerate(steps):
        logfile = result_dir / f'{index:02d}-{name}.log'
        process = None
        try:
            process = subprocess.Popen(command, cwd=root, env={**os.environ, **env},
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, errors='replace',
                                        start_new_session=(os.name == 'posix'))
            output, _ = process.communicate(timeout=timeout)
            code = process.returncode
        except subprocess.TimeoutExpired:
            if process is not None:
                if os.name == 'posix':
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    grace_deadline = time.monotonic() + 0.5
                    try:
                        process.communicate(timeout=0.5)
                    except subprocess.TimeoutExpired:
                        pass
                    remaining_grace = grace_deadline - time.monotonic()
                    if remaining_grace > 0:
                        time.sleep(remaining_grace)
                    try:
                        # The group may outlive its leader after closing inherited
                        # pipes; escalate even when communicate() already returned.
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    process.terminate()
                    try:
                        process.communicate(timeout=0.5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                output, _ = process.communicate()
            else:
                output = ''
            code = 124
            output += f'\nGATE TIMEOUT after {timeout}s\n'
        except OSError as exc:
            code, output = 127, f'{type(exc).__name__}: {exc}\n'
        write_new_log_file(logfile, output)
        count = parse_count(output, kind)
        skips = parse_skips(output, kind)
        todos = parse_todos(output, kind)
        status = 'passed' if code == 0 and skips == 0 and todos == 0 and (kind == 'plain' or count is not None and count > 0) else 'failed'
        row = {'name': name, 'command': command, 'exit_code': code, 'status': status,
               'test_kind': kind, 'test_count': count, 'test_file_count': 0,
               'skip_count': skips, 'todo_count': todos, 'failed_cases': parse_failures(output, kind),
               'log': str(logfile)}
        result['steps'].append(row)
        result['passed'] = all(step['status'] == 'passed' for step in result['steps'])
        save_json(result_dir / 'steps.json', result)
        print(f'{name}: exit={code} cases={count if count is not None else "n/a"} {status}', flush=True)
    return result


def snapshot(source: Path, dest: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for rel, path in source_paths(source):
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        hashes[rel.as_posix()] = digest(target)
    return dict(sorted(hashes.items()))


def copy_node_modules(source: Path, destination: Path) -> None:
    """Copy an existing dependency boundary into scratch; never link live modules."""
    if source.is_symlink():
        raise RuntimeError(f'refusing node_modules source symlink: {source}')
    source = ensure_no_symlink_components(source)
    if not source.is_dir():
        raise RuntimeError(f'node_modules source is not a directory: {source}')
    if destination.is_symlink() or destination.exists():
        raise RuntimeError(f'refusing existing or symlink node_modules snapshot: {destination}')
    destination = ensure_no_symlink_components(destination)
    source_root = source.resolve()
    for path in source.rglob('*'):
        if not path.is_symlink():
            continue
        if path.readlink().is_absolute():
            raise RuntimeError(f'refusing absolute node_modules symlink: {path}')
        try:
            target = path.resolve(strict=True)
            target.relative_to(source_root)
        except (OSError, RuntimeError, ValueError) as exc:
            raise RuntimeError(f'refusing node_modules symlink outside source tree: {path}') from exc
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination, symlinks=True, copy_function=shutil.copy2)


def prepare_scratch_home(home: Path) -> Path:
    """Create a private Hermes cache tree without linking the live install."""
    for directory in (home, home / '.hermes', home / '.hermes/cache',
                      home / '.hermes/cache/scratch'):
        ensure_no_symlink_components(directory)
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise RuntimeError(f'refusing unsafe scratch home path: {directory}')
        directory.mkdir(parents=True, exist_ok=True)
    live_source_link = home / '.hermes/hermes-agent'
    if live_source_link.is_symlink() or live_source_link.exists():
        raise RuntimeError(f'refusing live Hermes source path inside scratch home: {live_source_link}')
    return home


def build_run_environment(work_path: Path, tree: Path, home: Path, scratch: Path,
                          py: str, hermes_source: str, browser_use_cli: str,
                          browser_use_cli_source: Path) -> dict[str, str]:
    """Keep caches and HOME state private to this scratch gate invocation."""
    uv_cache = work_path / 'uv-cache'
    ensure_no_symlink_components(uv_cache)
    if uv_cache.is_symlink() or (uv_cache.exists() and not uv_cache.is_dir()):
        raise RuntimeError(f'refusing unsafe uv cache path: {uv_cache}')
    uv_cache.mkdir(parents=True, exist_ok=True)
    return {
        'HOME': str(home),
        'HERMES_HOME': str(work_path / 'hermes'),
        'TMPDIR': str(scratch),
        'PYTHONDONTWRITEBYTECODE': '1',
        'UV_CACHE_DIR': str(uv_cache),
        # 中文注释：通用导入路径只含桥接与 scratch 依赖；源码由需要的测试局部引入。
        'PYTHONPATH': os.pathsep.join((str(tree / 'native-bridge'), str(work_path / 'pytest-deps'))),
        'HERMES_SOURCE': hermes_source,
        'HERMES_PYTHON': py,
        'BROWSER_USE_CLI': browser_use_cli,
        'BROWSER_USE_CLI_SOURCE': str(browser_use_cli_source),
    }


def resolve_browser_use_cli_source(cli: str | Path,
                                   override: str | Path | None = None) -> Path:
    """Resolve the installed Browser Use source tree without executing its CLI."""
    if override is not None and str(override).strip():
        return Path(override).expanduser().resolve()
    tool_root = Path(cli).expanduser().resolve().parent.parent
    library = tool_root / 'lib'
    candidates = sorted(
        path.resolve() for path in library.glob('python*/site-packages')
        if (path / 'browser_harness' / 'run.py').is_file()
    )
    if len(candidates) > 1:
        raise RuntimeError(
            'multiple Browser Use source trees found; set BROWSER_USE_CLI_SOURCE explicitly'
        )
    if candidates:
        return candidates[0]
    # Preserve the runner's documented fallback; it fails its prerequisite check
    # rather than installing or invoking a CLI when the source tree is absent.
    return library / 'python3.12' / 'site-packages'


def matrix(root: Path, py: str) -> list[tuple[str, list[str], str]]:
    steps = [('node-v11-and-offline-modules', ['node', '--test', '--test-concurrency=1',
                                               '--test-reporter=tap', *NODE_TESTS], 'tap')]
    for folder in PYTHON_SUITES:
        if folder in PYTHON_GROUPED_FILES:
            files = [str((root / folder / name).resolve())
                     for name in PYTHON_GROUPED_FILES[folder]]
            steps.append((('py-' + folder + '-explicit').replace('/', '-'),
                          [py, '-c', UNITTEST_FILES_RUNNER, *files], 'unittest'))
            continue
        for name in PYTHON_FILES.get(folder, ('test_*.py',)):
            steps.append((('py-' + folder + '-' + name).replace('/', '-').replace('*', 'all'),
                          [py, '-m', 'unittest', 'discover', '-s', folder, '-p', name, '-v'], 'unittest'))
    steps += [
        ('root-check-js', ['npm', 'run', 'check:js'], 'plain'),
        ('root-check-manifest', ['npm', 'run', 'check:manifest'], 'plain'),
        ('bridge-docs', ['node', 'scripts/check-bridge-docs.mjs', '--root', str(root)], 'plain'),
        ('root-lint', ['npm', 'run', 'lint'], 'plain'),
        ('root-build', ['npm', 'run', 'build'], 'plain'),
        ('native-build', ['node', 'native-extension/build.mjs', str(root.parent / 'native-built')], 'plain'),
        ('candidate-package', ['node', 'scripts/package-executor.mjs', '--source', str(root),
                               '--output', str(root.parent / 'candidate')], 'plain'),
    ]
    return steps


def supplemental_matrix(root: Path, py: str) -> list[tuple[str, list[str], str]]:
    """Three statically audited V1.1 runners; all use synthetic fixtures."""
    return [
        ('supplemental-popup-contract',
         ['node', '--test', '--test-concurrency=1', '--test-reporter=tap',
          'tests/v1.1-ui-acceptance/popup.test.mjs'], 'tap'),
        ('supplemental-redaction-contract',
         ['node', '--test', '--test-concurrency=1', '--test-reporter=tap',
          'tests/v1.1-redaction-fix/redaction.test.mjs'], 'tap'),
    ]


def reviewed_matrix(root: Path, py: str) -> list[tuple[str, list[str], str]]:
    """Run every reviewed omission and discovery addition by exact runner path."""
    steps = []
    for runner in REVIEWED_RUNNER_PATHS:
        path = Path(runner)
        name = ('reviewed-' + path.as_posix().replace('/', '-').replace('.', '-'))
        if path.suffix in {'.mjs', '.js'}:
            command = ['node', '--test', '--test-concurrency=1',
                       '--test-reporter=tap', runner]
            kind = 'tap'
        else:
            command = [py, '-m', 'unittest', 'discover', '-s', path.parent.as_posix(),
                       '-p', path.name, '-v']
            if runner == 'tests/v1.1-concurrency/test_production_concurrency.py':
                # Its macOS AF_UNIX path is derived from Path.home(); override
                # HOME only for this runner so its temp dir stays short and scratch-only.
                command = ['/usr/bin/env', f'HOME={Path.home()}', *command]
            kind = 'unittest'
        steps.append((name, command, kind))
    return steps


def explicit_runner_paths(command: list[str], kind: str,
                          root: Path | None = None) -> set[str]:
    """Extract only literal runner paths from a single gate command."""
    paths: set[str] = set()

    def normalized(token: str) -> str | None:
        candidate = Path(token)
        if candidate.suffix not in {'.py', '.mjs', '.js'}:
            return None
        if root is not None and candidate.is_absolute():
            try:
                return candidate.resolve().relative_to(root.resolve()).as_posix()
            except ValueError:
                return None
        return candidate.as_posix()

    if kind == 'tap':
        for token in command:
            path = normalized(token)
            if path and not any(char in token for char in '*?[]'):
                paths.add(path)
    elif kind == 'unittest':
        if '-s' in command and '-p' in command:
            folder = command[command.index('-s') + 1]
            pattern = command[command.index('-p') + 1]
            if not any(char in pattern for char in '*?[]'):
                paths.add((Path(folder) / pattern).as_posix())
        elif len(command) >= 3 and command[1] == '-c' and command[2] == UNITTEST_FILES_RUNNER:
            for token in command[3:]:
                path = normalized(token)
                if path:
                    paths.add(path)
        else:
            for token in command[1:]:
                path = normalized(token)
                if path and not any(char in token for char in '*?[]'):
                    paths.add(path)
    return paths


def selected_runner_paths(root: Path,
                          steps: list[tuple[str, list[str], str]]) -> set[str]:
    selected: set[str] = set()
    root = root.resolve()
    for _name, command, kind in steps:
        for relative in explicit_runner_paths(command, kind, root):
            candidate = root / relative
            if candidate.is_file():
                selected.add(relative)
        if kind == 'pytest' and command:
            candidate = Path(command[-1])
            if not candidate.is_absolute():
                candidate = root / candidate
            if candidate.is_file():
                selected.add(candidate.resolve().relative_to(root).as_posix())
    return selected


def known_v11_runner_paths() -> set[str]:
    """Static allowlist used to fail closed when runner discovery changes."""
    known = {path for path in NODE_TESTS if path.startswith(('tests/v1.1', 'tests/v1.3', 'tests/v1.5', 'tests/v1.6', 'tests/site-tools', 'tests/network-evidence'))}
    for folder, names in PYTHON_GROUPED_FILES.items():
        known.update((Path(folder) / name).as_posix() for name in names)
    for folder, names in PYTHON_FILES.items():
        # 中文注释：自动更新按固定文件登记，也纳入新增/遗漏 runner 的发现检查。
        if folder.startswith(('tests/v1.1', 'tests/v1.3', 'tests/v1.5', 'tests/v1.6', 'tests/site-tools', 'tests/network-evidence', 'tests/auto-update')):
            known.update((Path(folder) / name).as_posix() for name in names)
    known.update(SUPPLEMENTAL_RUNNER_PATHS)
    known.update(REVIEWED_RUNNER_PATHS)
    return known


def v11_coverage(root: Path, selected: set[str]) -> dict:
    """Inventory named V1.1 test runners; omitted files are never implied green."""
    tests = root / 'tests'
    rows = []
    runner_suffixes = {'.py', '.mjs', '.js'}
    for folder in sorted(path for path in tests.iterdir()
                         if path.is_dir() and path.name.startswith(('v1.1', 'v1.3', 'v1.5', 'v1.6', 'site-tools', 'network-evidence', 'auto-update'))):
        candidates = sorted(
            path.relative_to(root).as_posix()
            for path in folder.rglob('*')
            if path.is_file() and path.suffix in runner_suffixes
            and (path.name.startswith('test_') or path.name.endswith(('.test.mjs', '.test.js')))
        )
        included = [path for path in candidates if path in selected]
        omitted = [path for path in candidates if path not in selected]
        status = ('covered' if candidates and not omitted else
                  'partial' if included else 'not-run')
        rows.append({'directory': folder.relative_to(root).as_posix(), 'status': status,
                     'runner_files': candidates, 'included': included, 'not_run': omitted})
    discovered = sorted(path for row in rows for path in row['runner_files'])
    known = known_v11_runner_paths()
    unreviewed = sorted(set(discovered) - known)
    missing_expected = sorted(known - set(discovered))
    discovery_check = {
        'passed': not unreviewed and not missing_expected,
        'expected_runner_file_count': len(known),
        'discovered_runner_file_count': len(discovered),
        'unreviewed': unreviewed,
        'missing_expected': missing_expected,
    }
    return {
        'discovery_rule': 'tests/{v1.1*,v1.3*,v1.5*,v1.6*,site-tools,network-evidence,auto-update}/**/{test_*.py,test_*.js,test_*.mjs,*.test.js,*.test.mjs}',
        'runner_file_count': sum(len(row['runner_files']) for row in rows),
        'included_runner_file_count': sum(len(row['included']) for row in rows),
        'not_run_runner_file_count': sum(len(row['not_run']) for row in rows),
        'rows': rows,
        'reviewed_runner_dispositions': [
            {'path': path, 'disposition': 'included',
             'classification': REVIEWED_RUNNER_CLASSIFICATIONS[path]}
            for path in REVIEWED_RUNNER_PATHS
        ],
        'discovery_check': discovery_check,
        'case_count_note': 'Only executed-runner summaries are reported; no repository-wide case total is asserted.',
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=OUT / 'latest.json')
    args = parser.parse_args()
    try:
        out, scratch, logs_dir = validate_gate_paths(args.out, SCRATCH, OUT)
    except RuntimeError as exc:
        parser.error(str(exc))
    scratch.mkdir(parents=True, exist_ok=True)
    run_log_dir = create_run_log_dir(logs_dir)
    with tempfile.TemporaryDirectory(prefix='v11-offline-', dir=scratch) as work:
        work_path = Path(work)
        tree = work_path / 'source'
        tree.mkdir()
        snapshot_started = datetime.now(timezone.utc).isoformat()
        hashes = snapshot(ROOT, tree)
        snapshot_completed = datetime.now(timezone.utc).isoformat()
        if not hashes:
            raise RuntimeError('empty snapshot')
        snapshot_hash = manifest_sha256(hashes)
        bindings = {}
        for boundary in NODE_BOUNDARIES:
            existing = ROOT / boundary / 'node_modules'
            if existing.is_symlink():
                raise RuntimeError(f'refusing node_modules source symlink: {existing}')
            if existing.exists() and not existing.is_dir():
                raise RuntimeError(f'node_modules source is not a directory: {existing}')
            if existing.is_dir():
                target = tree / boundary / 'node_modules'
                copy_node_modules(existing, target)
                bindings[boundary] = {
                    'source': str(existing.resolve()),
                    'scratch_copy': str(target),
                    'mode': 'copy',
                }
            else:
                bindings[boundary] = 'MISSING'
        home = work_path / 'home'
        prepare_scratch_home(home)
        py = os.environ.get('HERMES_PYTHON', str(Path.home() / '.hermes/hermes-agent/venv/bin/python'))
        hermes_source = os.environ.get('HERMES_SOURCE', str(Path.home() / '.hermes/hermes-agent'))
        browser_use_cli = Path(os.environ.get(
            'BROWSER_USE_CLI', str(Path.home() / '.local/share/uv/tools/browser-use/bin/browser-use')
        )).expanduser().resolve()
        browser_use_cli_source = resolve_browser_use_cli_source(
            browser_use_cli, os.environ.get('BROWSER_USE_CLI_SOURCE')
        )
        env = build_run_environment(work_path, tree, home, scratch, py, hermes_source,
                                    str(browser_use_cli), browser_use_cli_source)
        baseline_steps = matrix(tree, py)
        supplemental_steps = supplemental_matrix(tree, py)
        reviewed_steps = reviewed_matrix(tree, py)
        executable_steps = baseline_steps + supplemental_steps + reviewed_steps
        run = run_steps(tree, work_path / 'logs', executable_steps, env)
        selected = selected_runner_paths(tree, executable_steps)
        for row in run['steps']:
            row['log'] = str(Path(row['log']).relative_to(work_path))
            command = row['command']
            if row['name'] == 'node-v11-and-offline-modules':
                row['test_file_count'] = len(NODE_TESTS)
            elif row['test_kind'] == 'tap':
                row['test_file_count'] = sum(1 for token in command
                                             if token.endswith(('.mjs', '.js')))
            elif len(command) >= 3 and command[1] == '-c' and command[2] == UNITTEST_FILES_RUNNER:
                row['test_file_count'] = len(command[3:])
            elif '-m' in command and 'unittest' in command and '-s' in command and '-p' in command:
                pattern = command[command.index('-p') + 1]
                row['test_file_count'] = int(not any(char in pattern for char in '*?[]'))
            log = (work_path / row['log']).read_text(errors='replace')
            row['failed_cases'] = parse_failures(log, row['test_kind'])
            if row['name'] == 'node-v11-and-offline-modules':
                row['tap_summary'] = {key: int(value) for key, value in
                                      re.findall(r'^# (pass|fail|skipped|todo) (\d+)\s*$', log, re.MULTILINE)}
            row['log_tail'] = log[-2400:]
            destination = run_log_dir / (row['name'] + '.log')
            copy_log_file(work_path / row['log'], destination)
            row['log'] = str(destination.relative_to(ROOT))
        current_hashes = inventory(ROOT)
        drift_detail = compare_inventories(hashes, current_hashes)
        drift = sorted(set().union(*drift_detail.values()))
        missing_dependencies = [p for p, binding in bindings.items() if binding == 'MISSING']
        coverage = v11_coverage(tree, selected)
        report = {'schema': 1, 'timestamp_utc': datetime.now(timezone.utc).isoformat(),
                  'snapshot_started_utc': snapshot_started, 'snapshot_completed_utc': snapshot_completed,
                  'snapshot_kind': 'single working-tree copy used by all runners; excludes historical release/evidence/generated paths',
                  'source_root': str(ROOT), 'source_sha256': hashes, 'source_file_count': len(hashes),
                  'snapshot_manifest_sha256': snapshot_hash,
                  'source_drift_during_run': drift,
                  'source_drift_detail': drift_detail,
                  'node_module_boundaries': bindings,
                  'baseline_gate_step_count': len(baseline_steps),
                  'supplemental_step_count': len(supplemental_steps),
                  'reviewed_step_count': len(reviewed_steps),
                  'log_run_id': run_log_dir.name,
                  'total_step_count': len(run['steps']),
                  'v1_1_coverage': coverage,
                  'candidate_manifest_sha256': (digest(work_path / 'candidate/SHA256SUMS.json')
                      if (work_path / 'candidate/SHA256SUMS.json').is_file() else None),
                  'missing_dependencies': missing_dependencies, 'hermes_python': py,
                  'hermes_source': env['HERMES_SOURCE'], 'browser_use_cli': env['BROWSER_USE_CLI'],
                  'browser_use_cli_source': env['BROWSER_USE_CLI_SOURCE'],
                  'steps': run['steps'], 'passed': run['passed'] and not drift
                      and not missing_dependencies and coverage['discovery_check']['passed'],
                  'skipped_by_design': ['real browsers/keychain', 'personal install/registration',
                                        'historical evidence writers', 'official single-tool/model-driven acceptance']}
        save_json(out, report)
        print(f'result={out} passed={report["passed"]} source_files={len(hashes)} snapshot_sha256={snapshot_hash} drift={len(drift)}', flush=True)
        return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
