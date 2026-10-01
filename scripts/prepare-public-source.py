#!/usr/bin/env python3
"""中文注释：从一个已提交版本导出已审阅的公开源码，不携带 Git 历史或本机文件。"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess


def export_source(source, revision, output):
    source = Path(source).resolve()
    output = Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError('Output must not exist')
    commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', '--verify', revision + '^{commit}'], text=True).strip()
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Invalid source commit')
    entries = subprocess.check_output(['git', '-C', str(source), 'ls-tree', '-rz', '--full-tree', commit]).split(b'\0')
    manifest = {}
    output.mkdir(parents=True)
    process = subprocess.Popen(['git', '-C', str(source), 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        for entry in entries:
            if not entry:
                continue
            header, raw_name = entry.split(b'\t', 1)
            mode, kind, oid = header.decode().split()
            name = raw_name.decode('utf-8')
            parts = Path(name).parts
            if (kind != 'blob' or mode not in {'100644', '100755'} or '..' in parts or name.startswith('/')
                    or any(part in {'.git', '.ci', 'node_modules', 'artifacts', 'evidence', 'logs', 'profiles', '__pycache__'} for part in parts)
                    or any(part.startswith('.env') for part in parts)
                    or name == '.dev-sync.local.json'
                    or Path(name).suffix.lower() in {'.pem', '.key', '.db', '.sqlite', '.sqlite3', '.har', '.zip'}):
                raise ValueError('Unreviewed public path: ' + name)
            process.stdin.write((oid + '\n').encode())
            process.stdin.flush()
            found = process.stdout.readline().decode().split()
            if len(found) != 3 or found[1] != 'blob':
                raise ValueError('Cannot read tracked blob: ' + name)
            data = process.stdout.read(int(found[2]))
            process.stdout.read(1)
            # 中文注释：仅保留基准站已审阅的两张合成 PNG；其他二进制仍须人工审阅。
            fixture_image = name in {'bench/site/assets/logo.png', 'bench/site/assets/screenshot.png'}
            if b'\0' in data and not fixture_image:
                raise ValueError('Binary content requires review: ' + name)
            if not fixture_image:
                data.decode('utf-8')
            target = output / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if mode == '100755' else 0o644)
            manifest[name] = hashlib.sha256(data).hexdigest()
    except BaseException:
        shutil.rmtree(output)
        raise
    finally:
        process.stdin.close()
        process.stdout.close()
        process.wait()
    return {'sourceCommit': commit, 'files': len(manifest), 'gitHistoryIncluded': False,
            'contentSha256': hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--ref', default='HEAD')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(export_source(args.source, args.ref, args.output), indent=2))
