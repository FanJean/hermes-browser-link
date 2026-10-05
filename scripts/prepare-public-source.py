#!/usr/bin/env python3
"""中文注释：从一个已提交版本导出已审阅的公开源码，不携带 Git 历史或本机文件。"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

# 中文注释：品牌图片已核对并与公开 v1.6.1 字节一致；仅允许这些路径的固定摘要，不能替换成任意图片。
REVIEWED_BRANDING = {
    'docs/assets/readme-banner.png': 'da846881754337cfa977515c69beccce5b01c115184382e9eadb6e2e32ce8316',
    'native-extension/icon-128.png': 'd5abeb3fc32b6a7068824758c004b8c1edd549e791c96fc9fda79ddb090a886f',
    'native-extension/icon-16.png': 'd5e915490af560d3ad07739c4c99c57d1d707d2812d4b5f1c58a3fe21fb62095',
    'native-extension/icon-32.png': 'f6015f7e5d7a49e400aeb0909b32b86e7b3af95975b313a10c1d061e26e58301',
    'native-extension/icon-48.png': '87f83f93a71da6a7cdd2de9581c21a2a0c7d08de7a668fdd0f1ea729ef7d55da',
}

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
            # 中文注释：品牌路径的内容必须匹配固定摘要，未知或被替换的二进制继续拒绝。
            fixture_image = name in {'bench/site/assets/logo.png', 'bench/site/assets/screenshot.png'}
            branding_image = name in REVIEWED_BRANDING
            if branding_image and hashlib.sha256(data).hexdigest() != REVIEWED_BRANDING[name]:
                raise ValueError('Reviewed branding digest changed: ' + name)
            if b'\0' in data and not (fixture_image or branding_image):
                raise ValueError('Binary content requires review: ' + name)
            if not (fixture_image or branding_image):
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
