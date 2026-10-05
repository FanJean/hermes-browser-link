#!/usr/bin/env python3
"""安装独立的云端 Native host，原本地 host 和 daemon 保持原样。"""
import argparse
import json
import os
from pathlib import Path
import re
import sys

from runtime.client import private_directory, save_config
from registration import registration

HOST = 'com.hermes.browser_link.cloud'
BROWSERS = ('Library/Application Support/Google/Chrome/NativeMessagingHosts',
            'Library/Application Support/Microsoft Edge/NativeMessagingHosts')


def install(user_home, hermes_home):
    user_home, hermes_home = Path(user_home), Path(hermes_home)
    root = Path(__file__).resolve().parent
    settings = json.loads((hermes_home / 'plugin-data/browser-link-native/host-config.json').read_text())
    origins = settings.get('allowedOrigins')
    if not isinstance(origins, list) or not origins or any(not re.fullmatch(r'chrome-extension://[a-p]{32}/', x) for x in origins):
        raise ValueError('缺少原扩展的有效 Native host 许可')
    directory = hermes_home / 'plugin-data/browser-link-cloud'
    private_directory(directory)
    launcher, text, descriptions = registration(root, user_home, hermes_home, origins, sys.executable)
    fd = os.open(launcher, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o700)
    with os.fdopen(fd, 'w') as output:
        output.write(text)
    os.chmod(launcher, 0o700)
    manifests = []
    for path, description in descriptions:
        destination = path.parent
        destination.mkdir(parents=True, exist_ok=True)
        if path.is_symlink():
            raise ValueError('拒绝写入链接目标')
        save_config(path, description)
        manifests.append(str(path))
    return {'host': str(launcher), 'manifests': manifests}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--user-home', type=Path, default=Path.home())
    parser.add_argument('--hermes-home', type=Path, default=Path.home() / '.hermes')
    args = parser.parse_args()
    print(json.dumps(install(args.user_home, args.hermes_home), ensure_ascii=False))
