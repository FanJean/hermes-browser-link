#!/usr/bin/env python3
"""Read-only heuristic launcher inventory. Never imports tests or launches browsers.

Default: JSON inventory, exit 0. --strict: exit 1 when a direct launcher lacks
an explicit mock-keychain flag. Not a security proof or a JavaScript parser.
"""
import argparse
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP = {'.git', 'node_modules', 'release', 'dist', 'isolated', 'tmp', '.tmp',
        'results', 'evidence', '__pycache__'}
LAUNCH = re.compile(r'launchPersistentContext|chromium\.launch\(|--user-data-dir')


def dependency_flags(source):
    for parent in source.parents:
        if parent != ROOT and ROOT not in parent.parents:
            break
        dependency = parent / 'node_modules/playwright-core'
        package = dependency / 'package.json'
        if not package.is_file():
            continue
        candidates = [dependency / 'lib/server/chromium/chromiumSwitches.js',
                      dependency / 'lib/coreBundle.js']
        text = '\n'.join(p.read_text(errors='replace') for p in candidates if p.is_file())
        return {'version': json.loads(package.read_text())['version'],
                'mock_flag_present': '--use-mock-keychain' in text,
                'basic_flag_present': '--password-store=basic' in text}
    return None


def inventory():
    rows = []
    for directory, dirs, files in os.walk(ROOT, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP and
                         not d.startswith(('.profile-', '.extension-')) and
                         not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            p = Path(directory) / name
            if p.is_symlink() or p.suffix not in {'.mjs', '.js', '.py', '.sh', '.ts'} or p == Path(__file__).resolve():
                continue
            text = p.read_text(errors='replace')
            lines = [i for i, line in enumerate(text.splitlines(), 1) if LAUNCH.search(line)]
            if not lines:
                continue
            playwright = bool(re.search(r'launchPersistentContext|chromium\.launch\(', text))
            rows.append({'file': str(p.relative_to(ROOT)), 'lines': lines,
                         'kind': 'playwright' if playwright else 'direct',
                         'explicit_mock': '--use-mock-keychain' in text,
                         'explicit_basic': '--password-store=basic' in text,
                         'explicit_user_data_dir': '--user-data-dir' in text,
                         'home_token_present': bool(re.search(r'\bHOME\b', text)),
                         'dependency': dependency_flags(p) if playwright else None})
    return sorted(rows, key=lambda r: r['file'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--strict', action='store_true')
    args = parser.parse_args()
    rows = inventory()
    missing = [r['file'] for r in rows if r['kind'] == 'direct' and not r['explicit_mock']]
    print(json.dumps({'scope': 'source launch sites; generated copies excluded',
                      'limitations': 'file-level literal scan, not argument/env dataflow validation',
                      'files': len(rows), 'direct_missing_mock': len(missing),
                      'launchers': rows}, indent=2))
    return int(args.strict and bool(missing))


if __name__ == '__main__':
    raise SystemExit(main())
