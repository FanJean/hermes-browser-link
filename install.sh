#!/usr/bin/env bash
# 中文注释：Release 与源码共用入口；先检查运行环境，再交给标准库安装流程。
set -euo pipefail
fail() { printf '%s\n%s\n' "$1" "$2" >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || fail '错误 / Error: 仅支持 macOS / macOS required.' '处理 / Fix: 请在 macOS 的 Chrome 或 Edge 上安装。'
command -v python3 >/dev/null 2>&1 || fail '错误 / Error: 缺少 python3 / python3 missing.' '处理 / Fix: 安装 Python 3.11+，确保 python3 在 PATH 中。'
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || fail '错误 / Error: Python 版本过低 / Python too old.' '处理 / Fix: 使用 Python 3.11+ 后重试。'
root="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd -P)"
# 中文注释：禁止导入生成字节码，确保 dry-run 不写缓存。
export PYTHONDONTWRITEBYTECODE=1
if [[ -f "$root/install-cli.py" ]]; then
  exec python3 "$root/install-cli.py" "$@"
fi
[[ -f "$root/scripts/install-cli.py" ]] || fail '错误 / Error: 安装包不完整 / Incomplete installation package.' '处理 / Fix: 重新下载完整 Release ZIP 或源码。'
exec python3 "$root/scripts/install-cli.py" "$@"
