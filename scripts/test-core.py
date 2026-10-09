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

# 中文注释：只有足够短的 TMPDIR 才直接使用；macOS 默认 /var/folders/... 或会话临时目录过长，
# 嵌套后 Unix socket 会超过 103 字节上限，此时退回 /tmp 下的短目录。
_explicit_tmp = os.environ.get('TMPDIR')
_use_explicit = bool(_explicit_tmp) and len(str(Path(_explicit_tmp).resolve())) <= 24
with (nullcontext(_explicit_tmp) if _use_explicit else tempfile.TemporaryDirectory(prefix='hbc-', dir='/tmp')) as scratch:
    # 中文注释：复用已审阅的显式用例清单，避免通配符启动真实浏览器测试。
    env = {**os.environ, 'TMPDIR': str(Path(scratch).resolve()), 'PYTHONDONTWRITEBYTECODE': '1'}
    # 中文注释：显式指定优先；其次用 Hermes 自带 venv（夹具会导入 hermes_cli，其依赖只装在 venv 里）；最后才用当前解释器。
    _hermes_venv = Path.home() / '.hermes/hermes-agent/venv/bin/python'
    env.setdefault('HERMES_PYTHON', str(_hermes_venv) if _hermes_venv.is_file() else sys.executable)
    commands = [
        # 中文注释：先核对运行元数据、当前发布文档和下载链接，再执行离线用例。
        ['node', 'scripts/package-version.mjs'],
        ['node', '--test', '--test-concurrency=1', *gate.NODE_TESTS],
        # 中文注释：首次网站读取确认覆盖 daemon 审批与浏览器来源回读的离线往返。
        [sys.executable, 'tests/v1.1-approval-notify/test_site_read.py'],
        # 中文注释：OAuth popup 的进程内 daemon 与工具/Vault 回归仅运行两个已审阅文件；不扩大发现范围。
        *[[sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/native-v2', '-p', name, '-v']
          for name in ('test_oauth_popup.py', 'test_oauth_popup_executor.py')],
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/v1.1-script-lane', '-v'],
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/v1.3', '-v'],
        # 中文注释：新增并行、身份隔离、传输恢复与诊断回归均为离线合成测试。
        # tests/v1.5.1 依赖 FastAPI，与其他桌面 API 用例一样只在 npm run verify（Hermes 解释器）里运行。
        *[[sys.executable, '-m', 'unittest', 'discover', '-s', suite, '-v'] for suite in (
            # 中文注释：自动更新只运行合成 Release 和临时安装目录的离线用例。
            'tests/auto-update',
            'tests/v1.6.0', 'tests/v1.5.2', 'tests/v1.5.0', 'tests/v1.4', 'tests/v1.4.1', 'tests/v1.4.2', 'tests/v1.4.3', 'tests/v1.4.4', 'tests/v1.3.6', 'tests/v1.1-runtime-performance', 'tests/v1.1-single-tools',
            'tests/v1.1-concurrency', 'browser-diagnostics/tests')],
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/site-tools', '-v'],
        # 中文注释：真实管道的退出回归只使用临时 UDS，不连接或注册个人浏览器。
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'native-bridge/tests', '-p', 'test_host_shutdown.py', '-v'],
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'native-bridge/tests', '-p', 'test_cleanup_contract.py', '-v'],
        # 中文注释：独立云端入口的身份、Native 帧和本地任务隔离纳入离线门禁。
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'cloud-link/tests', '-v'],
        [sys.executable, 'scripts/generate-browser-reference.py', '--check'],
    ]
    for command in commands:
        result = subprocess.run(command, cwd=ROOT, env=env, timeout=240)
        if result.returncode:
            raise SystemExit(result.returncode)
