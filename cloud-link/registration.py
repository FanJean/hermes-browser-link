"""独立云端 host 注册描述，由原安装事务和手动安装共用。"""
from pathlib import Path

HOST = 'com.hermes.browser_link.cloud'


def registration(root, user_home, hermes_home, origins, python):
    root, user_home, hermes_home = Path(root), Path(user_home), Path(hermes_home)
    launcher = hermes_home / 'plugin-data/browser-link-cloud' / HOST
    # 中文注释：只注册新的云端入口，原本地 host 的路径、配置和权限不变。
    text = (f'#!{python}\n# 中文注释：独立云端 Native 入口，不启动本地 daemon。\n'
            'import os,runpy,sys\n'
            f"os.environ['HERMES_HOME']={str(hermes_home)!r}\n"
            f'sys.path.insert(0,{str(root)!r})\n'
            f"runpy.run_path({str(root / 'native_host.py')!r},run_name='__main__')\n")
    value = {'name': HOST, 'description': 'Hermes 浏览器独立云端连接',
             'path': str(launcher), 'type': 'stdio', 'allowed_origins': origins}
    manifests = [(user_home / 'Library/Application Support' / browser / 'NativeMessagingHosts' / (HOST + '.json'), value)
                 for browser in ('Google/Chrome', 'Microsoft Edge')]
    return launcher, text, manifests
