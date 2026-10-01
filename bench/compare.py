#!/usr/bin/env python3
"""中文注释：对同类基准结果输出绝对变化和相对变化。"""
from __future__ import annotations

import json
from pathlib import Path
import sys


def _metrics(data: dict) -> dict[str, tuple[float, bool]]:
    values = {}
    if data['kind'] == 'mechanical':
        for name, row in data['metrics'].items():
            for key, lower in [('p50Ms', True), ('p90Ms', True), ('maxMs', True), ('successRate', False)]:
                if isinstance(row.get(key), (int, float)):
                    values[f'{name}.{key}'] = (row[key], lower)
        occupancy = data.get('promptOccupancy', {})
        for key in ('totalCharacters', 'estimatedTokens'):
            if isinstance(occupancy.get(key), (int, float)):
                values[f'prompt.{key}'] = (occupancy[key], True)
    elif data['kind'] == 'agent':
        for task in data['tasks']:
            prefix = task['name']
            score = task['correctness'].get('score')
            if isinstance(score, (int, float)):
                values[f'{prefix}.correctness'] = (score, False)
            for key, value in task['efficiency'].items():
                if isinstance(value, (int, float)) or value == '未拿到':
                    # 中文注释：复用越多越好；导航与峰值标签只陈列变化，不单独判退步。
                    direction = False if key == 'reusedOpens' else (None if key in ('navigateExisting', 'newTabs', 'maxConcurrentTabs', 'handedToUserTasks', 'handedToUserTabs') else True)
                    values[f'{prefix}.{key}'] = (value, direction)
    else:
        raise ValueError('unknown result kind')
    return values


def compare(before: dict, after: dict) -> list[dict]:
    if before.get('kind') != after.get('kind'):
        raise ValueError('result kinds differ')
    old, new = _metrics(before), _metrics(after)
    rows = []
    for key in sorted(old.keys() | new.keys()):
        if key not in old or key not in new:
            rows.append({'metric': key, 'before': old.get(key, ('未拿到',))[0],
                         'after': new.get(key, ('未拿到',))[0], 'delta': '未拿到',
                         'percent': '未拿到', 'regression': False})
            continue
        first, lower = old[key]
        last = new[key][0]
        if not isinstance(first, (int, float)) or not isinstance(last, (int, float)):
            rows.append({'metric': key, 'before': first, 'after': last, 'delta': '未拿到',
                         'percent': '未拿到', 'regression': False})
            continue
        delta = round(last - first, 4)
        percent = round(delta / first * 100, 2) if first else ('0' if last == 0 else '基线为 0')
        rows.append({'metric': key, 'before': first, 'after': last, 'delta': delta,
                     'percent': percent, 'regression': delta > 0 if lower is True else (delta < 0 if lower is False else False)})
    return rows


def markdown(rows: list[dict]) -> str:
    lines = ['| 指标 | 改前 | 改后 | 变化量 | 变化百分比 | 结果 |',
             '|---|---:|---:|---:|---:|---|']
    for row in rows:
        percent = f"{row['percent']}%" if isinstance(row['percent'], (int, float)) else row['percent']
        lines.append(f"| {row['metric']} | {row['before']} | {row['after']} | {row['delta']} | {percent} | {'退步' if row['regression'] else ''} |")
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('用法: python3 bench/compare.py <before.json> <after.json>')
    before, after = (json.loads(Path(name).read_text()) for name in sys.argv[1:])
    print(markdown(compare(before, after)), end='')
