"""Offline gate's negative controls; no browser, install, or evidence write."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/verify-v1.1-offline.py'
spec = importlib.util.spec_from_file_location('offline_gate', SCRIPT)
gate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)


class GateNegativeControls(unittest.TestCase):
    # 中文注释：审计报告是生成输出，不能把写报告误判为运行源码漂移；真实源码仍须校验。
    def test_audit_reports_are_outputs_not_runtime_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'native-extension').mkdir()
            source = root / 'native-extension/core.mjs'
            source.write_text('export const value=1;')
            for name in ('CODEX-AUDIT-REPORT.md', 'CODEX-STREAM-REPORT.md'):
                (root / name).write_text('初次报告')
            before = gate.inventory(root)
            self.assertEqual(set(before), {'native-extension/core.mjs'})
            (root / 'CODEX-AUDIT-REPORT.md').write_text('更新检查结果')
            self.assertEqual(gate.inventory(root), before)
            source.write_text('export const value=2;')
            self.assertNotEqual(gate.inventory(root), before)


    def test_save_json_writes_valid_output_and_updates_the_named_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'latest.json'
            gate.save_json(path, {'run': 1})
            self.assertEqual(json.loads(path.read_text()), {'run': 1})
            gate.save_json(path, {'run': 2})
            self.assertEqual(json.loads(path.read_text()), {'run': 2})

    def test_snapshot_preserves_nested_release_and_dist_fixtures(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, destination = root / 'source', root / 'snapshot'
            paths = (
                'release/generated.zip',
                'dist/generated.js',
                'tests/fixtures/release/manifest.json',
                'tests/fixtures/dist/manifest.json',
            )
            for relative in paths:
                target = source / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(relative)

            hashes = gate.snapshot(source, destination)

            self.assertNotIn('release/generated.zip', hashes)
            self.assertNotIn('dist/generated.js', hashes)
            # Repository-root release/ holds only generated payloads; nothing there is source.
            self.assertFalse(any(name.startswith('release/') for name in hashes))
            self.assertIn('tests/fixtures/release/manifest.json', hashes)
            self.assertIn('tests/fixtures/dist/manifest.json', hashes)
            self.assertEqual(
                (destination / 'tests/fixtures/release/manifest.json').read_text(),
                'tests/fixtures/release/manifest.json',
            )
            self.assertEqual(
                (destination / 'tests/fixtures/dist/manifest.json').read_text(),
                'tests/fixtures/dist/manifest.json',
            )

    def test_known_failing_script_not_green(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bad = root / 'bad.py'
            bad.write_text('import sys\nsys.exit(7)\n')
            result = gate.run_steps(root, root / 'results', [('known-fail', ['python3', 'bad.py'], 'plain')], {})
            self.assertFalse(result['passed'])
            self.assertEqual(result['steps'][0]['exit_code'], 7)
            self.assertEqual(result['steps'][0]['status'], 'failed')

    def test_save_json_refuses_symlink_temporary_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / 'outside.json'
            target.write_text('keep')
            (root / 'result.tmp').symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, 'unsafe temporary JSON output'):
                gate.save_json(root / 'result.json', {'unsafe': True})
            self.assertEqual(target.read_text(), 'keep')

    def test_save_json_refuses_to_replace_a_stale_regular_temporary_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            temporary = root / 'result.tmp'
            temporary.write_text('prior temporary evidence')
            with self.assertRaisesRegex(RuntimeError, 'unsafe temporary JSON output'):
                gate.save_json(root / 'result.json', {'unsafe': True})
            self.assertEqual(temporary.read_text(), 'prior temporary evidence')
            self.assertFalse((root / 'result.json').exists())

    def test_save_json_rejects_symlinked_parent_ancestor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outside = root / 'outside'
            outside.mkdir()
            linked = root / 'linked'
            linked.symlink_to(outside, target_is_directory=True)
            output = linked / 'nested/result.json'
            with self.assertRaisesRegex(RuntimeError, 'symlink path component'):
                gate.save_json(output, {'unsafe': True})
            self.assertFalse((outside / 'nested/result.json').exists())

    def test_scratch_path_validation_rejects_symlinked_ancestor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outside = root / 'outside'
            outside.mkdir()
            linked = root / 'linked'
            linked.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, 'symlink path component'):
                gate.ensure_no_symlink_components(linked / 'scratch')

    def test_gate_output_preflight_rejects_symlinked_scratch_and_result_parents(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output_root = root / 'verification'
            output_root.mkdir()
            outside = root / 'outside'
            outside.mkdir()
            linked = root / 'linked'
            linked.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, 'symlink path component'):
                gate.validate_gate_paths(output_root / 'latest.json', linked / 'scratch', output_root)
            with self.assertRaisesRegex(RuntimeError, 'symlink path component'):
                gate.validate_gate_paths(linked / 'latest.json', root / 'scratch', output_root)

    def test_copy_log_refuses_symlink_destination(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source.log'
            source.write_text('new log')
            target = root / 'outside.log'
            target.write_text('keep')
            destination = root / 'logs.log'
            destination.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, 'symlink log output'):
                gate.copy_log_file(source, destination)
            self.assertEqual(target.read_text(), 'keep')

    def test_copy_log_never_overwrites_an_existing_run_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source.log'
            source.write_text('new log')
            destination = root / 'logs.log'
            destination.write_text('prior run')
            with self.assertRaisesRegex(RuntimeError, 'existing log output'):
                gate.copy_log_file(source, destination)
            self.assertEqual(destination.read_text(), 'prior run')

    def test_runner_log_refuses_symlink_to_outside_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result_dir = root / 'results'
            result_dir.mkdir()
            outside = root / 'outside.log'
            outside.write_text('keep')
            (result_dir / '00-step.log').symlink_to(outside)
            with self.assertRaisesRegex(RuntimeError, 'symlink log output'):
                gate.run_steps(root, result_dir, [('step', [sys.executable, '-c', "print('new')"], 'plain')], {})
            self.assertEqual(outside.read_text(), 'keep')

    def test_log_runs_get_distinct_directories_and_preserve_prior_logs(self):
        with tempfile.TemporaryDirectory() as tmp:
            logs = Path(tmp) / 'logs'
            previous = logs / 'previous-run'
            previous.mkdir(parents=True)
            old_log = previous / 'root-build.log'
            old_log.write_text('prior evidence')
            first = gate.create_run_log_dir(logs)
            second = gate.create_run_log_dir(logs)
            self.assertNotEqual(first, second)
            self.assertTrue(first.is_dir())
            self.assertTrue(second.is_dir())
            self.assertEqual(old_log.read_text(), 'prior evidence')

    def test_timeout_kills_descendant_process_before_it_can_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            marker = root / 'orphan-wrote-after-timeout'
            child = f"import pathlib,time; time.sleep(.4); pathlib.Path({str(marker)!r}).write_text('orphan')"
            parent = f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{child!r}]); time.sleep(5)"
            command = [sys.executable, '-c', parent]
            result = gate.run_steps(root, root / 'results', [('timeout-child', command, 'plain')], {}, timeout=0.1)
            self.assertEqual(result['steps'][0]['exit_code'], 124)
            time.sleep(0.55)
            self.assertFalse(marker.exists(), 'timeout must terminate the whole runner process group')

    def test_timeout_escalates_to_kill_for_a_descendant_ignoring_term(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ready = root / 'child-ready'
            marker = root / 'term-ignored-child-wrote'
            child = (
                f"import pathlib,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                f"pathlib.Path({str(ready)!r}).write_text('ready'); time.sleep(1.4); "
                f"pathlib.Path({str(marker)!r}).write_text('survived')"
            )
            parent = (
                f"import pathlib,subprocess,sys,time\n"
                f"subprocess.Popen([sys.executable,'-c',{child!r}])\n"
                f"ready=pathlib.Path({str(ready)!r})\n"
                "while not ready.exists():\n    time.sleep(.01)\ntime.sleep(5)\n"
            )
            result = gate.run_steps(root, root / 'results', [('timeout-escalation', [sys.executable, '-c', parent], 'plain')], {}, timeout=0.5)
            self.assertEqual(result['steps'][0]['exit_code'], 124)
            self.assertTrue(ready.exists(), 'the child must install its TERM handler before timeout')
            time.sleep(0.9)
            self.assertFalse(marker.exists(), 'the TERM-ignoring child must be killed after the grace period')

    def test_timeout_kills_term_ignoring_descendant_after_parent_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ready = root / 'detached-child-ready'
            marker = root / 'detached-child-survived-timeout'
            child = (
                f"import pathlib,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                f"pathlib.Path({str(ready)!r}).write_text('ready'); time.sleep(1.2); "
                f"pathlib.Path({str(marker)!r}).write_text('survived')"
            )
            parent = (
                f"import pathlib,subprocess,sys,time\n"
                f"subprocess.Popen([sys.executable,'-c',{child!r}], "
                "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n"
                f"ready=pathlib.Path({str(ready)!r})\n"
                "while not ready.exists():\n    time.sleep(.01)\ntime.sleep(5)\n"
            )
            result = gate.run_steps(
                root, root / 'results',
                [('timeout-detached-child', [sys.executable, '-c', parent], 'plain')],
                {}, timeout=0.5,
            )
            self.assertEqual(result['steps'][0]['exit_code'], 124)
            self.assertTrue(ready.exists(), 'the child must install its TERM handler before timeout')
            time.sleep(1.0)
            self.assertFalse(marker.exists(), 'a child with detached output must not survive the runner timeout')

    def test_uv_cache_is_private_to_the_current_scratch_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = root / 'run'
            tree = work / 'source'
            tree.mkdir(parents=True)
            home = work / 'home'
            scratch = root / 'scratch'
            scratch.mkdir()
            gate.prepare_scratch_home(home)
            env = gate.build_run_environment(
                work, tree, home, scratch, '/scratch/python', '/readonly/hermes',
                '/readonly/browser-use/bin/browser-use', '/readonly/browser-use/site-packages',
            )
            cache = Path(env['UV_CACHE_DIR'])
            self.assertEqual(cache, work / 'uv-cache')
            self.assertTrue(cache.is_dir())
            self.assertNotEqual(cache, Path.home() / '.cache/uv')

    def test_node_modules_boundary_is_an_independent_scratch_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'live/node_modules'
            package = source / 'sample/lib'
            package.mkdir(parents=True)
            original = package / 'entry.js'
            original.write_text('export const value = 1;')
            bin_dir = source / '.bin'
            bin_dir.mkdir()
            (bin_dir / 'sample').symlink_to('../sample/lib/entry.js')
            destination = root / 'snapshot/node_modules'
            gate.copy_node_modules(source, destination)
            self.assertTrue(destination.is_dir())
            self.assertFalse(destination.is_symlink())
            self.assertTrue((destination / '.bin/sample').is_symlink())
            self.assertEqual((destination / '.bin/sample').read_text(), 'export const value = 1;')
            (destination / 'sample/lib/entry.js').write_text('mutated in scratch')
            self.assertEqual(original.read_text(), 'export const value = 1;')

    def test_node_modules_boundary_rejects_source_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            real = root / 'real-modules'
            real.mkdir()
            source = root / 'node_modules'
            source.symlink_to(real, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, 'node_modules source symlink'):
                gate.copy_node_modules(source, root / 'snapshot/node_modules')

    def test_node_modules_boundary_rejects_nested_symlink_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'node_modules'
            source.mkdir()
            outside = root / 'outside'
            outside.mkdir()
            (source / 'escape').symlink_to(Path('../outside'), target_is_directory=True)
            destination = root / 'snapshot/node_modules'
            with self.assertRaisesRegex(RuntimeError, 'symlink outside source tree'):
                gate.copy_node_modules(source, destination)
            self.assertFalse(destination.exists())

    def test_node_modules_boundary_rejects_absolute_link_back_to_live_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'node_modules'
            package = source / 'sample'
            package.mkdir(parents=True)
            (package / 'entry.js').write_text('live dependency')
            (source / 'absolute-entry.js').symlink_to(package / 'entry.js')
            with self.assertRaisesRegex(RuntimeError, 'absolute node_modules symlink'):
                gate.copy_node_modules(source, root / 'snapshot/node_modules')

    def test_missing_runner_is_blocked_not_passed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = gate.run_steps(root, root / 'results', [('absent', ['python3', 'absent.py'], 'unittest')], {})
            self.assertFalse(result['passed'])
            self.assertNotEqual(result['steps'][0]['exit_code'], 0)
            self.assertEqual(result['steps'][0]['status'], 'failed')

    def test_zero_tests_is_not_green(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'empty.py').write_text('print("Ran 0 tests")\n')
            result = gate.run_steps(root, root / 'results', [('empty', ['python3', 'empty.py'], 'unittest')], {})
            self.assertFalse(result['passed'])
            self.assertEqual(result['steps'][0]['status'], 'failed')

    def test_skipped_case_is_not_a_green_acceptance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'skip.py').write_text('print("Ran 1 test in 0.001s\\nOK (skipped=1)")\n')
            result = gate.run_steps(root, root / 'results', [('skip', ['python3', 'skip.py'], 'unittest')], {})
            self.assertFalse(result['passed'])
            self.assertEqual(result['steps'][0]['skip_count'], 1)

    def test_todo_case_is_not_a_green_acceptance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'todo.py').write_text('print("# tests 1\\n# pass 0\\n# todo 1")\n')
            result = gate.run_steps(root, root / 'results', [('todo', ['python3', 'todo.py'], 'tap')], {})
            self.assertFalse(result['passed'])
            self.assertEqual(result['steps'][0]['todo_count'], 1)

    def test_inventory_diff_catches_added_removed_and_modified_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'source'
            root.mkdir()
            (root / 'keep.txt').write_text('before')
            (root / 'remove.txt').write_text('remove')
            before = gate.inventory(root)
            (root / 'keep.txt').write_text('after')
            (root / 'remove.txt').unlink()
            (root / 'added.txt').write_text('added')
            after = gate.inventory(root)
            self.assertEqual(gate.compare_inventories(before, after), {
                'added': ['added.txt'], 'removed': ['remove.txt'], 'modified': ['keep.txt'],
            })

    def test_manifest_hash_is_order_independent_and_failure_names_are_extracted(self):
        left = {'b': '2', 'a': '1'}
        right = {'a': '1', 'b': '2'}
        self.assertEqual(gate.manifest_sha256(left), gate.manifest_sha256(right))
        self.assertEqual(gate.parse_failures('test_bad (suite.Case) ... FAIL\n', 'unittest'),
                         ['test_bad (suite.Case) ... FAIL'])
        self.assertEqual(gate.parse_failures('FAILED tests/x.py::test_bad - assertion\n', 'pytest'),
                         ['FAILED tests/x.py::test_bad - assertion'])

    def test_baseline_and_supplemental_step_counts_are_separate(self):
        # 中文注释：当前显式矩阵已纳入新增基准与版本回归，保持实际审阅后的数量。
        # 中文注释：Cookie 镜像 Python runner 新增一个基准步骤，原有步骤全部保留。
        self.assertEqual(len(gate.matrix(Path('/scratch/source'), '/scratch/python')), 40)
        self.assertEqual(len(gate.supplemental_matrix(Path('/scratch/source'), '/scratch/python')), 2)

    def test_browser_use_cli_source_is_discovered_from_cli_without_executing_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tool_root = root / 'uv/tools/browser-use'
            cli = tool_root / 'bin/browser-use'
            cli.parent.mkdir(parents=True)
            cli.write_text('#!/bin/sh\n')
            source = tool_root / 'lib/python3.12/site-packages'
            harness = source / 'browser_harness/run.py'
            harness.parent.mkdir(parents=True)
            harness.write_text('# read-only source fixture\n')

            self.assertEqual(gate.resolve_browser_use_cli_source(cli), source.resolve())
            override = root / 'configured-site-packages'
            self.assertEqual(
                gate.resolve_browser_use_cli_source(cli, override),
                override.resolve(),
            )

    def test_coverage_inventory_lists_unrun_files_without_marking_them_green(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / 'tests/v1.1-example'
            folder.mkdir(parents=True)
            (folder / 'test_included.py').write_text('')
            (folder / 'unrun.test.mjs').write_text('')
            (folder / 'fixture_child.py').write_text('')
            report = gate.v11_coverage(root, {'tests/v1.1-example/test_included.py'})
            self.assertEqual(report['runner_file_count'], 2)
            self.assertEqual(report['included_runner_file_count'], 1)
            self.assertEqual(report['not_run_runner_file_count'], 1)
            self.assertEqual(report['rows'][0]['status'], 'partial')
            self.assertEqual(report['rows'][0]['not_run'], ['tests/v1.1-example/unrun.test.mjs'])

    def test_reviewed_matrix_is_explicit_and_matches_the_retained_audit_rows(self):
        steps = gate.reviewed_matrix(Path('/scratch/source'), '/scratch/python')
        latest_delta = {
            'tests/v1.1-diagnostics-install/test_stage_diagnostics.py',
            'tests/v1.1-highlight-wiring/wiring.test.mjs',
            'tests/v1.1-redaction-lint/redaction-lint.test.mjs',
            'tests/v1.1-runtime-performance/test_runtime_connection_budget.py',
        }
        current_delta = {
            'tests/v1.1-highlight-review/review.test.mjs',
            'tests/v1.1-lint-scope/lint-scope.test.mjs',
            'tests/v1.1-single-tools/test_override_registration.py',
        }
        final_delta = {
            'tests/v1.1-diagnostics/test_doctor_protocol.py',
            'tests/v1.1-interactions/navigation.test.mjs',
            'tests/v1.1-runtime-performance/test_journal_recovery.py',
        }
        # 中文注释：V1.3 新增受审阅的脚本 runner，保留显式清单与数量校验。
        self.assertEqual(len(steps), 49)
        self.assertEqual(len(gate.REVIEWED_RUNNER_PATHS), 49)
        self.assertEqual(len(set(gate.REVIEWED_RUNNER_PATHS)), 49)
        self.assertTrue(latest_delta.issubset(set(gate.REVIEWED_RUNNER_PATHS)))
        self.assertTrue(current_delta.issubset(set(gate.REVIEWED_RUNNER_PATHS)))
        # 中文注释：最终合并新增的三个 runner 必须明确登记且实际执行。
        self.assertTrue(final_delta.issubset(set(gate.REVIEWED_RUNNER_PATHS)))
        # 中文注释：dev-sync 的 PID 身份回归与首次网站读取确认回归都登记在离线执行清单。
        # 中文注释：镜像 Node/Python 两个离线文件也纳入发现与固定清单核对。
        self.assertEqual(len(gate.known_v11_runner_paths()), 89)
        # 中文注释：1.5.1 桌面 API 与交互均登记，真实浏览器脚本不进入离线门禁。
        # 中文注释：后台审批 runner 登记后显式清单增加一项。
        # 中文注释：1.5.2 临时安装、升级回滚和卸载 runner 进入显式门禁。
        # 中文注释：1.5.3 浮层孤儿回归计入基准 Node 清单，真实浏览器仍是手动门禁。
        self.assertIn('tests/v1.5.3/overlay-orphan.test.mjs', gate.NODE_TESTS)
        # 中文注释：新版本的两个离线 runner 必须同时登记。
        self.assertIn('tests/v1.6.0/work-window.test.mjs', gate.NODE_TESTS)
        self.assertIn('tests/v1.6.0/test_lifecycle.py', gate.known_v11_runner_paths())
        self.assertIn('tests/v1.5.2/test_install_flow.py', gate.known_v11_runner_paths())
        # 中文注释：缺钩子的完整插件加载测试也进入离线固定清单。
        self.assertIn('tests/v1.5.2/test_hook_compatibility.py', gate.known_v11_runner_paths())
        self.assertIn('tests/v1.5.1/approval-background.test.mjs', gate.known_v11_runner_paths())
        self.assertIn('tests/native-extension/background-access-request.test.mjs', gate.NODE_TESTS)
        self.assertIn('tests/v1.5.1/test_desktop_cookie_mirror.py', gate.known_v11_runner_paths())
        self.assertIn('executor-plugin/desktop/cookie-mirror.test.mjs', gate.NODE_TESTS)
        self.assertIn('tests/v1.5.0/cookie-mirror.test.mjs', gate.known_v11_runner_paths())
        self.assertIn('tests/v1.5.0/test_cookie_mirror.py', gate.known_v11_runner_paths())
        # 中文注释：1.3.6 同任务并发开页用例显式登记。
        self.assertIn('tests/v1.3.6/test_concurrent_tabs.py', gate.known_v11_runner_paths())
        self.assertIn('tests/native-extension/redirect-ready.test.mjs', gate.NODE_TESTS)
        self.assertIn('tests/v1.1-packaging/dev-sync-daemon.test.mjs', gate.known_v11_runner_paths())
        self.assertIn('tests/v1.1-approval-notify/test_site_read.py', gate.known_v11_runner_paths())
        self.assertIn('tests/v1.1-ui/page-settle.test.mjs', gate.known_v11_runner_paths())
        self.assertIn('tests/v1.1-highlight-deadline/deadline.test.mjs', gate.known_v11_runner_paths())
        self.assertEqual(set(gate.REVIEWED_RUNNER_CLASSIFICATIONS),
                         set(gate.REVIEWED_RUNNER_PATHS))
        matrix_text = (SCRIPT.parents[1] / 'tests/v1.1-verification/coverage-matrix.md').read_text()
        self.assertTrue(all(path in matrix_text for path in gate.REVIEWED_RUNNER_PATHS))
        # 中文注释：这些目录仅含离线回归；其余目录仍必须使用原有固定文件清单。
        safe_discovery = {'bench', 'bench/agent', 'tests/v1.4', 'tests/v1.4.1',
                          'tests/v1.4.2', 'tests/v1.4.3', 'tests/v1.4.4', 'tests/v1.3.6'}
        self.assertEqual(set(gate.PYTHON_SUITES),
                         set(gate.PYTHON_GROUPED_FILES) | set(gate.PYTHON_FILES) | safe_discovery)
        for _name, command, _kind in gate.matrix(Path('/scratch/source'), '/scratch/python'):
            if '-s' in command and '-p' in command:
                folder = command[command.index('-s') + 1]
                if folder.startswith('tests/v1.1'):
                    pattern = command[command.index('-p') + 1]
                    self.assertFalse(any(char in pattern for char in '*?[]'))
        self.assertEqual(
            {path for path in gate.REVIEWED_RUNNER_PATHS},
            {path for _name, command, _kind in steps
             for path in gate.explicit_runner_paths(command, _kind)},
        )
        for _name, command, _kind in steps:
            self.assertFalse(any(any(char in token for char in '*?[]') for token in command))
            self.assertEqual(len(gate.explicit_runner_paths(command, _kind)), 1)

    def test_discovery_never_globs_a_new_runner_into_the_command_matrix(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = 'tests/v1.1-example/test_future.py'
            target = root / path
            target.parent.mkdir(parents=True)
            target.write_text('')
            steps = (gate.matrix(root, '/scratch/python')
                     + gate.supplemental_matrix(root, '/scratch/python')
                     + gate.reviewed_matrix(root, '/scratch/python'))
            selected = gate.selected_runner_paths(root, steps)
            report = gate.v11_coverage(root, selected)
            self.assertNotIn(path, selected)
            self.assertEqual(report['discovery_check']['unreviewed'], [path])
            self.assertFalse(report['discovery_check']['passed'])

    def test_coverage_discovery_blocks_a_new_unreviewed_runner_even_if_selected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / 'tests/v1.1-example'
            folder.mkdir(parents=True)
            path = 'tests/v1.1-example/test_added.py'
            (root / path).parent.mkdir(parents=True, exist_ok=True)
            (root / path).write_text('')
            self.assertNotIn(path, gate.known_v11_runner_paths())
            report = gate.v11_coverage(root, {path})
            self.assertFalse(report['discovery_check']['passed'])
            self.assertEqual(report['discovery_check']['unreviewed'],
                             [path])
            self.assertIn(path, report['rows'][0]['included'],
                          'selecting an undispositioned runner must not auto-approve it')

    def test_scratch_home_uses_private_scratch_dir_without_live_source_link(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'home'
            gate.prepare_scratch_home(home)
            local_scratch = home / '.hermes/cache/scratch'
            self.assertTrue(local_scratch.is_dir())
            self.assertFalse(local_scratch.is_symlink())
            self.assertFalse((home / '.hermes/hermes-agent').exists())

    def test_suite_count_parses_only_runner_summary(self):
        self.assertEqual(gate.parse_count('Ran 11 tests in 0.05s\nOK', 'unittest'), 11)
        self.assertEqual(gate.parse_count('# tests 19\n# pass 19', 'tap'), 19)
        self.assertIsNone(gate.parse_count('hello', 'tap'))


if __name__ == '__main__':
    unittest.main()
