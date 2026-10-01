#!/usr/bin/env python3
"""中文注释：默认只读账本，apply 通过已连接的 daemon 按创建证据清理，不直接操作浏览器。"""
import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import time


def activity_at(task):
    # 中文注释：旧任务没有 lastActivityAt 时使用原更新时间，不能按脚本启动时间重置空闲。
    return task.get('lastActivityAt', task.get('updatedAt', task['createdAt']))


def candidates(tasks, now, idle_seconds, task_ids=()):
    # 中文注释：只选 ready 空闲任务和带工作页记录的终态 unknown；暂停、needs_sync 和正在运行的任务不选。
    return [task for task in tasks if (not task_ids or task['id'] in task_ids) and (
        task['state'] == 'ready' and activity_at(task) + idle_seconds <= now or
        task['state'] in {'closed', 'cancelled'} and task.get('cleanupState') == 'unknown' and task.get('workTabs'))]


def apply_task(client, task, idle_seconds):
    params = {'owner': task['owner'], 'taskId': task['id']}
    # 中文注释：ready 清理携带快照身份和时间；终态只请求收组，未知归属绝不升级为删页授权。
    if task['state'] == 'ready':
        return client.call('shared.sweep_close', {**params, 'generation': task['generation'],
                           'lastActivityAt': activity_at(task), 'idleSeconds': idle_seconds})
    return client.call('shared.sweep_ungroup', {**params, 'generation': task['generation']})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--apply', action='store_true')
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('HERMES_BROWSER_BRIDGE_HOME', '~/.hermes')).expanduser())
    parser.add_argument('--idle-seconds', type=float, default=600)
    parser.add_argument('--task-id', action='append', default=[])
    args = parser.parse_args(argv)
    if not math.isfinite(args.idle_seconds) or args.idle_seconds < 0:
        parser.error('--idle-seconds 必须为非负有限秒数')
    home = args.home.expanduser().resolve()
    tasks = json.loads((home / 'plugin-data/browser-link-native/tasks.json').read_text())['tasks']
    selected = candidates(tasks, time.time(), args.idle_seconds, args.task_id)
    for task in selected:
        print(json.dumps({'id': task['id'], 'title': task['title'], 'state': task['state'],
                         'action': 'handoff' if task['state'] == 'ready' else 'ungroup_only',
                         'cleanupReason': task.get('cleanupReason'), 'workTabCount': len(task.get('workTabs', [])),
                         'idleSeconds': round(time.time() - activity_at(task))}, ensure_ascii=False))
    print(f'候选 {len(selected)} 条；终态是否可收组须由扩展私有日志复核。')
    if not args.apply or not selected:
        return 0
    # 中文注释：脚本不能拉起 daemon，否则 dry-run/apply 之间可能触发额外启动扫描；须先更新并连接 1.4.3。
    spec = importlib.util.spec_from_file_location('sweep_bridge_client', Path(__file__).resolve().parents[1] / 'native-bridge/client.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    client = module.BridgeClient(home, timeout=40, autostart=False)
    failed = 0
    try:
        for task in selected:
            try:
                result = apply_task(client, task, args.idle_seconds)
                print(json.dumps({'id': task['id'], 'state': result['state'],
                                  'cleanupState': result.get('cleanupState'), 'cleanupReason': result.get('cleanupReason')}, ensure_ascii=False))
                # 中文注释：未确认的清理不能以退出码 0 冒充完成；输出后停止自动重试，交由用户核对。
                if result.get('cleanupState') != 'succeeded':
                    failed += 1
            except Exception as exc:
                failed += 1
                print(json.dumps({'id': task['id'], 'errorCode': getattr(exc, 'code', 'cleanup_unconfirmed')}, ensure_ascii=False))
    finally:
        client.close()
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
