#!/usr/bin/env bash
# 中文注释：代理基准只使用本地站；每个任务单独清空并保存站点日志。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="${1:?用法: bash bench/agent/run.sh <label> [port]}"
PORT="${2:-8765}"
# 中文注释：基准使用显式 profile；默认 profile 的数据库位于 Hermes 根目录。
export HERMES_BENCH_PROFILE="${HERMES_BENCH_PROFILE:-default}"
if [[ ! "$LABEL" =~ ^[A-Za-z0-9_.-]+$ || ! "$PORT" =~ ^[0-9]+$ ]]; then echo 'label 或 port 格式错误' >&2; exit 2; fi
RUN_DIR="$ROOT/bench/results/agent-$LABEL-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RUN_DIR"
printf '{"label":"%s","port":%s,"tasks":[]}' "$LABEL" "$PORT" > "$RUN_DIR/manifest.json"
for ITEM in 01-directory 02-table 03-spa 04-overlay 05-login 06-catalog 07-two-sites; do
  NAME="${ITEM#??-}"
  TITLE="基准·$NAME·$LABEL"
  QUERY="$RUN_DIR/$ITEM.query.md"
  OUTPUT="$RUN_DIR/$ITEM.output"
  # 中文注释：模板只替换端口和绝对路径，不修改仓库任务单。
  python3 - "$ROOT" "$PORT" "$OUTPUT" "$ITEM" "$QUERY" <<'PY'
from pathlib import Path
import sys
root, port, output, item, query = sys.argv[1:]
text = (Path(root) / 'bench/agent/tasks' / (item + '.md')).read_text()
Path(query).write_text(text.replace('{{ROOT}}', root).replace('{{PORT}}', port).replace('{{OUTPUT}}', output))
PY
  curl --silent --show-error --fail --noproxy '*' -X POST "http://127.0.0.1:$PORT/__bench/reset" >/dev/null
  START="$(date +%s)"
  set +e
  hermes -p "$HERMES_BENCH_PROFILE" chat -c "$TITLE" --create-if-missing --query-file "$QUERY" -Q > "$RUN_DIR/$ITEM.hermes.txt" 2>&1
  EXIT_CODE=$?
  set -e
  END="$(date +%s)"
  # 中文注释：只读复制结束时的任务状态，避免评分时读取到下一项任务的状态。
  if [[ -f "$HOME/.hermes/plugin-data/browser-link-native/tasks.json" ]]; then
    cp "$HOME/.hermes/plugin-data/browser-link-native/tasks.json" "$RUN_DIR/$ITEM.tasks.json"
  fi
  curl --silent --show-error --fail --noproxy '*' "http://127.0.0.1:$PORT/__bench/log" > "$RUN_DIR/$ITEM.log.json"
  # 中文注释：会话标题由本轮唯一 label 固定，按标题查只读 state.db 取得 session id。
  python3 - "$RUN_DIR/manifest.json" "$TITLE" "$ITEM" "$OUTPUT" "$EXIT_CODE" "$START" "$END" <<'PY'
import json, os, sqlite3, sys
from pathlib import Path
manifest, title, item, output, exit_code, start, end = sys.argv[1:]
home = Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes'))).expanduser()
profile = os.environ['HERMES_BENCH_PROFILE']
db = (home if profile == 'default' else home / 'profiles' / profile) / 'state.db'
conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
row = conn.execute('select id from sessions where title=? order by started_at desc limit 1', (title,)).fetchone()
conn.close()
data = json.loads(Path(manifest).read_text())
data['tasks'].append({'name': item, 'title': title, 'sessionId': row[0] if row else None, 'output': output, 'exitCode': int(exit_code), 'startedAt': int(start), 'endedAt': int(end)})
Path(manifest).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
PY
  printf '%s: exit=%s\n' "$ITEM" "$EXIT_CODE"
done
printf '%s\n' "$RUN_DIR" > "$ROOT/bench/results/agent-$LABEL-latest.txt"
printf '运行目录：%s\n' "$RUN_DIR"
printf '评分命令：python3 bench/agent/score.py "$(cat bench/results/agent-%s-latest.txt)"\n' "$LABEL"
