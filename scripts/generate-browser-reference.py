"""中文注释：生成或检查接口参考；--check 用于 CI 检测文档漂移。"""
import importlib.util
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('browser_reference', root / 'executor-plugin/reference.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
expected = module.render()
target = root / 'docs/browser-api-reference.md'
if '--check' in sys.argv:
    if not target.is_file() or target.read_text() != expected:
        raise SystemExit('接口文档已漂移，请运行 python3 scripts/generate-browser-reference.py')
else:
    target.write_text(expected)
print('Browser API reference OK')
