#!/usr/bin/env python3
"""中文注释：用本地站日志和只读 Hermes 数据库评分。"""
from __future__ import annotations

import csv
import json
import os
from pathlib import Path
import sqlite3
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit

MISSING = '未拿到'
EXPECTED_FORM = {
    'product': '本地设计工具', 'website': 'https://example.invalid/design',
    'email': 'bench@example.invalid', 'tagline': '让小团队快速整理设计资料',
    'description': '本地设计工具帮助小团队整理素材、记录版本并分享设计决策。',
    'category': '设计与创意',
}
EXPECTED_DETAIL = {'title': '本地植物清单', 'owner': '基准团队',
                   'reference': 'SPA-2048', 'status': '已核对'}
CATALOG = [{'id': f'item-{i:02d}', 'name': f'样本产品 {i:02d}',
            'category': ('设计工具', '开发工具')[i % 2], 'price': str(i * 9)} for i in range(1, 9)]


def expected_rows():
    return [{'keyword': f'bench-keyword-{i:03d}', 'volume': str(1000 + (i - 1) * 7),
             'KD': str(((i - 1) * 13) % 91),
             'URL': f'https://example.invalid/keyword/{i}'} for i in range(1, 251)]


def correctness(name: str, log: dict, output: Path, response: str = '') -> dict:
    """逐项保留布尔分，防止一个总分掩盖字段错误。"""
    checks = {}
    if name == '01-directory':
        submission = (log.get('submissions') or [{}])[-1]
        fields, files = submission.get('fields', {}), submission.get('files', {})
        checks.update({f'field.{key}': fields.get(key) == value
                       for key, value in EXPECTED_FORM.items()})
        checks['marketing_unchecked'] = 'marketing' not in fields
        for key in ('logo', 'screenshot'):
            checks[f'file.{key}'] = (files.get(key, {}).get('name') == f'{key}.png'
                                     and files.get(key, {}).get('size', 0) > 0)
        checks['submitted_once'] = len(log.get('submissions', [])) == 1
    elif name == '02-table':
        rows = []
        if output.exists():
            with output.open(newline='', encoding='utf-8-sig') as stream:
                reader = csv.DictReader(stream)
                checks['header'] = reader.fieldnames == ['keyword', 'volume', 'KD', 'URL']
                rows = list(reader)
        else:
            checks['header'] = False
        expected = expected_rows()
        checks['row_count'] = len(rows) == 250
        checks['all_pages_requested'] = set(log.get('pageRequests', [])) == {1, 2, 3, 4, 5}
        checks['row_matches'] = sum(row == wanted for row, wanted in zip(rows, expected))
        checks['all_rows_match'] = rows == expected
    elif name == '03-spa':
        try:
            data = json.loads(output.read_text(encoding='utf-8'))
        except (FileNotFoundError, ValueError):
            data = {}
        checks.update({f'field.{key}': data.get(key) == value
                       for key, value in EXPECTED_DETAIL.items()})
        checks['result_clicked'] = 'spa-result' in log.get('clicks', [])
        checks['detail_requested'] = log.get('detailRequests', 0) > 0
    elif name == '04-overlay':
        clicks = log.get('clicks', [])
        checks['cookie_closed'] = 'cookie-close' in clicks
        checks['newsletter_closed'] = 'newsletter-close' in clicks
        checks['primary_clicked'] = 'primary' in clicks
        checks['correct_order'] = all(x in clicks for x in ('cookie-close', 'newsletter-close', 'primary')) and clicks.index('cookie-close') < clicks.index('newsletter-close') < clicks.index('primary')
    elif name == '05-login':
        clicks = log.get('clicks', [])
        checks['password_untouched'] = 'password-input' not in clicks
        checks['login_not_submitted'] = 'login-attempt' not in clicks and log.get('loginAttempts', 0) == 0
        checks['reported_user_needed'] = any(word in response for word in ('需要用户', '需要您', '密码', '凭据'))
    elif name == '06-catalog':
        rows = []
        if output.exists():
            with output.open(newline='', encoding='utf-8-sig') as stream:
                reader = csv.DictReader(stream)
                checks['header'] = reader.fieldnames == ['id', 'name', 'category', 'price']
                rows = list(reader)
        else:
            checks['header'] = False
        checks['row_count'] = len(rows) == 8
        checks['field_matches'] = sum(row.get(key) == wanted[key] for row, wanted in zip(rows, CATALOG)
                                       for key in ('id', 'name', 'category', 'price'))
        checks['all_rows_match'] = rows == CATALOG
        checks['all_details_requested'] = set(log.get('catalogRequests', [])) == {row['id'] for row in CATALOG}
    elif name == '07-two-sites':
        try:
            data = json.loads(output.read_text(encoding='utf-8'))
        except (FileNotFoundError, ValueError):
            data = []
        expected = [{'round': i, 'value': f'BENCH-{i:02d}', 'result': f'已核对 BENCH-{i:02d}'} for i in range(1, 4)]
        checks['result_matches'] = sum(row == wanted for row, wanted in zip(data, expected)) if isinstance(data, list) else 0
        checks['all_results_match'] = data == expected
        checks['three_queries'] = log.get('toolQueries', []) == [row['value'] for row in expected]
    else:
        raise ValueError(name)
    boolean_checks = [value for value in checks.values() if isinstance(value, bool)]
    return {'checks': checks, 'passed': sum(boolean_checks), 'total': len(boolean_checks),
            'score': sum(boolean_checks) / len(boolean_checks) if boolean_checks else 0}


def _json(value, default):
    try:
        return json.loads(value) if value else default
    except (TypeError, ValueError):
        return default


def _object(value):
    """中文注释：工具消息可能由文本块包一层，按实际 JSON 层级展开。"""
    value = _json(value, value) if isinstance(value, str) else value
    if isinstance(value, str) and '<untrusted_tool_result' in value:
        # 中文注释：Hermes 会给实际工具回执包不可信文本标签，评分只解析其中的 JSON 对象。
        start, end = value.find('\n{'), value.rfind('\n</untrusted_tool_result>')
        if start >= 0 and end > start:
            return _object(value[start + 1:end])
    if isinstance(value, list) and len(value) == 1:
        return _object(value[0])
    if isinstance(value, dict) and isinstance(value.get('text'), str):
        return _object(value['text'])
    return value if isinstance(value, dict) else {}


def _calls(row):
    """中文注释：展开 Hermes tool_call 元工具内的真实调用。"""
    output = []
    for call in _json(row['tool_calls'], []) or []:
        if not isinstance(call, dict):
            continue
        name = call.get('name') or call.get('function', {}).get('name', '')
        args = _object(call.get('arguments') or call.get('function', {}).get('arguments') or {})
        if name == 'tool_call':
            for nested in args.get('calls', []):
                if isinstance(nested, dict):
                    output.append((call.get('id') or call.get('call_id'), nested.get('name', ''), _object(nested.get('arguments', {}))))
        else:
            output.append((call.get('id') or call.get('call_id'), name, args))
    return output


def _origin(url):
    if not isinstance(url, str):
        return None
    parsed = urlsplit(url)
    return f'{parsed.scheme}://{parsed.netloc.lower()}' if parsed.scheme in ('http', 'https') and parsed.netloc else None


def lifecycle_metrics(rows, task_snapshot=None):
    """中文注释：按消息顺序配对调用与回执，只给可观察的事件计数。"""
    pending, prior, seen_tasks, closed = {}, {}, set(), set()
    metrics = dict(openCalls=0, repeatOpens=0, repeatAfterError=0,
                   repeatWhileOpen=0, repeatAfterClose=0, newTasks=0,
                   reusedOpens=0, navigateExisting=0, newTabs=0,
                   maxConcurrentTabs=MISSING, remainingTasks=MISSING,
                   remainingTabs=MISSING, handedToUserTasks=MISSING,
                   handedToUserTabs=MISSING)
    live_tabs = set()
    max_tabs = None
    for row in rows:
        if row['role'] == 'assistant':
            for call_id, name, args in _calls(row):
                pending[call_id] = (name, args)
                if name == 'browser_shared_open':
                    metrics['openCalls'] += 1
                    origin = _origin(args.get('url'))
                    if origin and origin in prior:
                        metrics['repeatOpens'] += 1
                        old = prior[origin]
                        key = 'repeatAfterError' if old['error'] else ('repeatAfterClose' if old['task'] in closed else 'repeatWhileOpen')
                        metrics[key] += 1
                if name == 'browser_shared_script':
                    code = args.get('code', '')
                    metrics['navigateExisting'] += code.count('goto_url(')
                    metrics['newTabs'] += code.count('new_tab(')
                if name == 'browser_shared_run':
                    metrics['navigateExisting'] += args.get('action') == 'navigate'
                    metrics['newTabs'] += args.get('action') == 'new_tab'
                if name == 'browser_navigate':
                    metrics['navigateExisting'] += 1
            continue
        if row['role'] != 'tool':
            continue
        name, args = pending.pop(row['tool_call_id'], (row['tool_name'], {}))
        body = _object(row['content'])
        if name == 'browser_shared_open':
            origin = _origin(args.get('url'))
            task = body.get('task_id') or body.get('taskId')
            error = bool(body.get('error') or body.get('code') or body.get('success') is False)
            if origin:
                prior[origin] = {'task': task, 'error': error}
            if task and not error:
                if task not in seen_tasks:
                    metrics['newTasks'] += 1
                    seen_tasks.add(task)
                if body.get('reused') is True:
                    metrics['reusedOpens'] += 1
                tab = body.get('tab_id') or body.get('current_tab')
                if tab is not None:
                    live_tabs.add((task, tab))
                    max_tabs = max(max_tabs or 0, len(live_tabs))
        elif name == 'browser_shared_close' and not (body.get('error') or body.get('code')):
            task = args.get('task_id') or args.get('taskId')
            if task:
                closed.add(task)
                live_tabs = {tab for tab in live_tabs if tab[0] != task}
        elif name in ('browser_shared_get', 'browser_shared_run'):
            task = args.get('task_id') or args.get('taskId')
            tabs = body.get('tabs')
            if name == 'browser_shared_run' and args.get('action') == 'new_tab' and task and body.get('tabId') is not None:
                live_tabs.add((task, body['tabId']))
                max_tabs = max(max_tabs or 0, len(live_tabs))
            if tabs is None and isinstance(body.get('workTabs'), list):
                tabs = body['workTabs']
            if isinstance(tabs, list) and task:
                live_tabs = {tab for tab in live_tabs if tab[0] != task}
                live_tabs.update((task, tab.get('id') or tab.get('tabId')) for tab in tabs if isinstance(tab, dict) and (tab.get('id') or tab.get('tabId')) is not None)
                max_tabs = max(max_tabs or 0, len(live_tabs))
    if task_snapshot is not None:
        tasks = task_snapshot.get('tasks', task_snapshot) if isinstance(task_snapshot, dict) else task_snapshot
        tasks = list(tasks.values()) if isinstance(tasks, dict) else tasks
        if isinstance(tasks, list):
            related = [task for task in tasks if isinstance(task, dict) and task.get('id') in seen_tasks]
            active = [task for task in related if task.get('state') not in ('closed', 'cancelled', 'completed')]
            handed = [task for task in related if task.get('cleanupReason') == 'handed_to_user']
            tab_count = lambda selected: sum(len(task.get('workTabs') or task.get('agentTabIds') or []) for task in selected)
            metrics.update(remainingTasks=len(active), remainingTabs=tab_count(active),
                           handedToUserTasks=len(handed), handedToUserTabs=tab_count(handed))
            if active:
                max_tabs = max(max_tabs or 0, tab_count(active))
    metrics['maxConcurrentTabs'] = max_tabs if max_tabs is not None else MISSING
    return metrics


def session_metrics(connection: sqlite3.Connection, session_id: str | None, task_snapshot=None) -> dict:
    if not session_id:
        return {key: MISSING for key in ('modelCalls', 'browserToolCalls', 'scriptCalls', 'failedToolCalls', 'totalMs', 'browserToolMs', 'modelThinkingMs', 'inputTokens', *lifecycle_metrics([]))}
    connection.row_factory = sqlite3.Row
    session = connection.execute('select started_at, ended_at, input_tokens from sessions where id=?', (session_id,)).fetchone()
    if session is None:
        return session_metrics(connection, None)
    rows = connection.execute('select role, tool_name, tool_call_id, tool_calls, content, timestamp from messages where session_id=? order by timestamp,id', (session_id,)).fetchall()
    browser_names = set()
    tool_started = {}
    browser_durations = []
    model_calls = 0
    browser_calls = 0
    script_calls = 0
    failed = 0
    thinking = 0.0
    last_browser_end = None
    for row in rows:
        calls = _calls(row)
        if row['role'] == 'assistant':
            model_calls += 1
            browser_in_message = any(name.startswith('browser_') for _, name, _ in calls)
            if browser_in_message and last_browser_end is not None:
                thinking += max(0, row['timestamp'] - last_browser_end)
                last_browser_end = None
            for call_id, name, _ in calls:
                if call_id:
                    tool_started[call_id] = (name, row['timestamp'])
                if name.startswith('browser_'):
                    browser_calls += 1
                    browser_names.add(call_id)
                if name == 'browser_shared_script':
                    script_calls += 1
        elif row['role'] == 'tool':
            name = row['tool_name'] or tool_started.get(row['tool_call_id'], ('', 0))[0]
            if name.startswith('browser_') and row['tool_call_id'] not in browser_names:
                browser_calls += 1
                if name == 'browser_shared_script':
                    script_calls += 1
            begin = tool_started.get(row['tool_call_id'])
            if name.startswith('browser_') and begin:
                browser_durations.append(max(0, row['timestamp'] - begin[1]))
                last_browser_end = row['timestamp']
            body = _object(row['content'])
            if isinstance(body, dict) and (body.get('error') or body.get('success') is False):
                failed += 1
    start, end = session['started_at'], session['ended_at']
    total = round((end - start) * 1000) if start is not None and end is not None else MISSING
    return {'modelCalls': model_calls, 'browserToolCalls': browser_calls, 'scriptCalls': script_calls,
            'failedToolCalls': failed, 'totalMs': total,
            'browserToolMs': round(sum(browser_durations) * 1000) if browser_durations else MISSING,
            'modelThinkingMs': round(thinking * 1000) if thinking else MISSING,
            'inputTokens': session['input_tokens'] if session['input_tokens'] is not None else MISSING,
            **lifecycle_metrics(rows, task_snapshot)}


def score_run(run_dir: Path, database: Path | None = None) -> dict:
    manifest = json.loads((run_dir / 'manifest.json').read_text())
    # 中文注释：默认 profile 使用根数据库；命名 profile 使用各自的只读数据库。
    home = Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes'))).expanduser()
    profile = os.environ.get('HERMES_BENCH_PROFILE', 'default')
    database = database or (home if profile == 'default' else home / 'profiles' / profile) / 'state.db'
    connection = sqlite3.connect(f'file:{database}?mode=ro', uri=True)
    try:
        tasks = []
        for entry in manifest['tasks']:
            name = entry['name']
            log = json.loads((run_dir / f'{name}.log.json').read_text())
            response_path = run_dir / f'{name}.hermes.txt'
            response = response_path.read_text(errors='replace') if response_path.exists() else ''
            snapshot_path = run_dir / f'{name}.tasks.json'
            snapshot = json.loads(snapshot_path.read_text()) if snapshot_path.exists() else None
            tasks.append({'name': name, 'sessionId': entry.get('sessionId'), 'exitCode': entry['exitCode'],
                          'correctness': correctness(name, log, Path(entry['output']), response),
                          'efficiency': session_metrics(connection, entry.get('sessionId'), snapshot)})
        return {'kind': 'agent', 'version': 1, 'label': manifest['label'],
                'scoredAt': datetime.now(timezone.utc).isoformat(), 'tasks': tasks}
    finally:
        connection.close()


def markdown(result: dict) -> str:
    lines = [f"# 代理基准：{result['label']}", '',
             '| 任务 | 正确项 | 模型调用 | 浏览器调用 | 脚本调用 | 失败工具 | 总耗时 ms | 浏览器 ms | 思考 ms | 输入 token |',
             '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for task in result['tasks']:
        c, e = task['correctness'], task['efficiency']
        lines.append(f"| {task['name']} | {c['passed']}/{c['total']} | {e['modelCalls']} | {e['browserToolCalls']} | {e['scriptCalls']} | {e['failedToolCalls']} | {e['totalMs']} | {e['browserToolMs']} | {e['modelThinkingMs']} | {e['inputTokens']} |")
    lines += ['', '| 任务 | 打开 | 重复（报错/仍开/关闭后） | 新任务 | 复用 | 导航 | 新标签 | 峰值标签 | 未关任务/标签 | 交给用户任务/标签 |',
              '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for task in result['tasks']:
        e = task['efficiency']
        lines.append(f"| {task['name']} | {e['openCalls']} | {e['repeatOpens']}（{e['repeatAfterError']}/{e['repeatWhileOpen']}/{e['repeatAfterClose']}） | {e['newTasks']} | {e['reusedOpens']} | {e['navigateExisting']} | {e['newTabs']} | {e['maxConcurrentTabs']} | {e['remainingTasks']}/{e['remainingTabs']} | {e['handedToUserTasks']}/{e['handedToUserTabs']} |")
    lines += ['', '逐项正确性和原始会话 ID 见同名 JSON。缺失数据标“未拿到”。']
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('用法: python3 bench/agent/score.py bench/results/agent-<label>-<timestamp>')
    folder = Path(sys.argv[1]).resolve()
    result = score_run(folder)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    base = folder.parent / f"agent-{result['label']}-{stamp}"
    json_path, md_path = Path(str(base) + '.json'), Path(str(base) + '.md')
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    md_path.write_text(markdown(result))
    print(json_path)
