#!/usr/bin/env bash
# 中文注释：检查跟踪文件和未忽略的新源码的工作区内容；不输出匹配值，也不扫描私有历史。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
python3 - <<'PY'
import os
from pathlib import Path
import re
import subprocess
import sys

# 中文注释：额外关键词按行传入并按字面匹配，避免用户名或邮箱写入仓库。
keywords = [word.strip() for word in os.environ.get('PUBLIC_RELEASE_EXTRA_KEYWORDS', '').splitlines() if word.strip()]
patterns = {
    'personal-path': re.compile(r'(?:/Users/|/home/)(?!example(?:/|\b)|x(?:/|\b)|private\.txt\b)[\w.-]+|[A-Za-z]:\\Users\\(?!example\b|x\b)[\w.-]+'),
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----'),
    'provider-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{35}|[sr]k_live_[A-Za-z0-9]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}|xox[baprs]-[A-Za-z0-9-]{20,})\b'),
    'credential-assignment': re.compile(r'''(?i)["']?\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token|password|client[_-]?secret|API_SERVER_KEY|HERMES_API_TOKEN)["']?\s*[:=]\s*["']([A-Za-z0-9_+/.=-]{20,})["']'''),
    'email': re.compile(r'\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b'),
    # 中文注释：检查工作目录与内部派单格式；个人名字、邮箱和项目名由环境变量传入。
    'internal-marker': re.compile(r'(?i)run[0-9]{2,}\b|Desktop[/]works|(?:Codex|Hermes)\s*派单'),
}
# 中文注释：只允许保留的合成邮件域；其他邮箱必须人工清理，不显示地址。
example_domains = {'example.org', 'example.com', 'example.net'}
synthetic_credentials = {
    'tests/native-v2/real-helper.py': {'synthetic-vault-password-2026'},
    'tests/v1.1-advanced/real-official.mjs': {'synthetic-vault-password-2026'},
    'tests/v1.1-redaction-fix/redaction.test.mjs': {'QUALITY_SENTINEL_SECRET'},
}
paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).decode().split('\0')
errors = []
checked = 0
for name in filter(None, paths):
    path = Path(name)
    # 中文注释：已在工作区删除的跟踪文件不属于将要发布的当前源码。
    if not path.exists():
        continue
    if path.is_symlink():
        errors.append(f'{name}: tracked symlink')
        continue
    checked += 1
    parts = path.parts
    if (any(part in {'artifacts', 'evidence', 'runs', 'logs', '__pycache__', 'node_modules'} for part in parts)
            or name.startswith(('bench/results/', 'out/', 'release/', 'dist/', 'native-extension/dist-native/'))
            or path.name.startswith(('.env', '.dev-sync.local.json'))
            or path.name in {'replay-results.json', 'validation.md'}
            or path.name.startswith('fix-notes-')
            or path.suffix.lower() in {'.log', '.pyc', '.db', '.sqlite', '.sqlite3', '.har', '.pem', '.key'}):
        errors.append(f'{name}: tracked generated/private file')
    if path.stat().st_size > 1024 * 1024:
        errors.append(f'{name}: exceeds 1 MiB')
    data = path.read_bytes()
    if b'\0' in data:
        continue
    try:
        content = data.decode('utf-8')
    except UnicodeDecodeError:
        errors.append(f'{name}: non-UTF-8 content requires review')
        continue
    for line_no, line in enumerate(content.splitlines(), 1):
        for label, pattern in patterns.items():
            for match in pattern.finditer(line):
                if label == 'credential-assignment' and match.group(1) in synthetic_credentials.get(name, set()):
                    continue
                if label == 'email':
                    domain = match.group(1).lower()
                    if domain in example_domains or domain.endswith(('.invalid', '.test', '.example')):
                        continue
                errors.append(f'{name}:{line_no}: {label}')
                break
        if any(word.casefold() in line.casefold() for word in keywords):
            errors.append(f'{name}:{line_no}: extra private marker')
if errors:
    print('\n'.join(errors), file=sys.stderr)
    raise SystemExit(1)
print(f'Public release scan OK ({checked} source files; {len(keywords)} extra markers)')
PY
