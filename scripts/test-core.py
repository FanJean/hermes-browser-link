"""核心离线测试入口；不启动浏览器、不安装个人插件。"""
import importlib.util
from contextlib import nullcontext
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('offline_gate', ROOT / 'scripts/verify-v1.1-offline.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

# 中文注释：指定 TMPDIR 时直接使用该根，避免嵌套目录超出 Unix socket 路径上限。
with (nullcontext(os.environ['TMPDIR']) if 'TMPDIR' in os.environ else tempfile.TemporaryDirectory(prefix='hbc-', dir='/tmp')) as scratch:
    # 中文注释：复用已审阅的显式用例清单，避免通配符启动真实浏览器测试。
    env = {**os.environ, 'TMPDIR': str(Path(scratch).resolve()), 'PYTHONDONTWRITEBYTECODE': '1'}
    commands = [
        ['node', '--test', '--test-concurrency=1', *gate.NODE_TESTS],
        # 中文注释：首次网站读取确认覆盖 daemon 审批与浏览器来源回读的离线往返。
        [sys.executable, 'tests/v1.1-approval-notify/test_site_read.py'],
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/v1.1-script-lane', '-v'],
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/v1.3', '-v'],
        # 中文注释：新增并行、身份隔离、传输恢复与诊断回归均为离线合成测试。
        # tests/v1.5.1 依赖 FastAPI，与其他桌面 API 用例一样只在 npm run verify（Hermes 解释器）里运行。
        *[[sys.executable, '-m', 'unittest', 'discover', '-s', suite, '-v'] for suite in (
            'tests/v1.6.0', 'tests/v1.5.2', 'tests/v1.5.0', 'tests/v1.4', 'tests/v1.4.1', 'tests/v1.4.2', 'tests/v1.4.3', 'tests/v1.4.4', 'tests/v1.3.6', 'tests/v1.1-runtime-performance', 'tests/v1.1-single-tools',
            'tests/v1.1-concurrency', 'browser-diagnostics/tests')],
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/site-tools', '-v'],
        [sys.executable, 'scripts/generate-browser-reference.py', '--check'],
    ]
    for command in commands:
        result = subprocess.run(command, cwd=ROOT, env=env, timeout=240)
        if result.returncode:
            raise SystemExit(result.returncode)
