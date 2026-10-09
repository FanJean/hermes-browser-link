#!/usr/bin/env python3
"""校验开发候选或正式发布包；仅在 --apply 下安装，且不自动启用 Hermes。"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import stat
import sys
import tempfile
import unicodedata

HOST='com.hermes.browser_link'


def reject_normalized_collisions(paths):
    seen={}
    for name in paths:
        parts=name.split('/')
        for index in range(1,len(parts)+1):
            path='/'.join(parts[:index])
            normalized=unicodedata.normalize('NFC',path).casefold()
            previous=seen.setdefault(normalized,path)
            if previous!=path:
                raise ValueError('安装包文件名归一化冲突: '+previous+' / '+path)


def expected_directories(files):
    result=set()
    for name in files:
        parent=Path(name).parent
        while str(parent)!='.':
            result.add(parent.as_posix())
            parent=parent.parent
    return result


def verify_package_layout(package, files):
    directories=expected_directories(files)
    actual_directories=set()
    for directory, dirs, _ in os.walk(package,followlinks=False):
        for name in dirs:
            actual_directories.add((Path(directory)/name).relative_to(package).as_posix())
    if actual_directories!=directories:
        raise ValueError('安装包目录布局与文件清单不一致')
    roots={name.split('/')[0] for name in files}
    expected_roots={'browser-link','native-extension','docs','LICENSE',
                    'README.md','INSTALL.txt','RELEASE-STATUS.txt','install-executor.py',
                    'SHA256SUMS.json','install-cli.py','install.sh'}
    if roots!=expected_roots:
        raise ValueError('安装包顶层布局无效')
    required={
        'browser-link/plugin.yaml',
        'browser-link/__init__.py',
        'browser-link/runtime.py',
        'browser-link/native_tools.py',
        # 中文注释：维护入口及其当前安装器属于运行闭包，不能发布缺少校验器的自动更新组件。
        'browser-link/maintenance/update.py',
        'browser-link/maintenance/install-cli.py',
        'browser-link/maintenance/install-executor.py',
        'browser-link/open_tool.py',
        'browser-link/skills/use-my-browser/SKILL.md',
        'browser-link/script_lane/host_bridge.py',
        'browser-link/script_lane/action_session.py',
        'browser-link/script_lane/child.py',
        'browser-link/script_lane/tool.py',
        'browser-link/native_bridge/host.py',
        'browser-link/native_bridge/client.py',
        # 中文注释：宿主启动依赖独立 Cookie 内存通道。
        'browser-link/native_bridge/cookie_mirror.py',
        'browser-link/native_bridge/daemon.py',
        'browser-link/native_bridge/api_client.py',
        # 中文注释：安装前核实私有凭据通道两个模块齐全。
        'browser-link/native_bridge/vault_private.py',
        'browser-link/native_bridge/vault_client.py',
        # 中文注释：官方 Vault 适配器四个模块必须与私有通道一起安装。
        'browser-link/vault_adapter/__init__.py',
        'browser-link/vault_adapter/adapter.py',
        'browser-link/vault_adapter/integration.py',
        'browser-link/vault_adapter/official_source.py',
        'browser-link/native_bridge/browser_diagnostics/__init__.py',
        'browser-link/native_bridge/browser_diagnostics/schema.py',
        'browser-link/native_bridge/browser_diagnostics/runtime.py',
        'browser-link/native_bridge/browser_diagnostics/sink.py',
        'native-extension/manifest.json',
        'docs/python-scripting.md',
        'docs/CHANGELOG.md',
        'LICENSE','README.md','INSTALL.txt','RELEASE-STATUS.txt',
        # 中文注释：通用入口与底层安装器同属校验清单。
        'install-executor.py','install-cli.py','install.sh','SHA256SUMS.json',
    }
    missing=required-set(files)
    if missing:
        raise ValueError('安装包布局缺少必需文件: '+', '.join(sorted(missing)))
    release_status(package)


RELEASE_LINE=re.compile(r'^RELEASE V(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*): formal release built from commit [0-9a-f]{40}\. ')
# 中文注释：独立前缀使旧自动更新器在调用旧 CLI 前拒绝共享包；对外仍返回既有正式状态。
SHARED_RELEASE_LINE=re.compile(r'SHARED RELEASE V((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)): formal release built from commit [0-9a-f]{40}\. See docs/CHANGELOG\.md for the verified scope and stated limits\.\n')


def release_status(package):
    """只接受明确的开发候选声明，或由打包器 --release 写出的正式发布声明（含提交）。"""
    status=(package/'RELEASE-STATUS.txt').read_text(encoding='utf8')
    if 'NOT FROZEN' in status and 'not a formal release' in status:
        return 'NOT FROZEN candidate only'
    shared=SHARED_RELEASE_LINE.fullmatch(status)
    if shared:
        return 'RELEASE V'+shared.group(1)
    if RELEASE_LINE.match(status):
        return status.split(':',1)[0]
    raise ValueError('拒绝缺少候选或正式发布状态声明的安装包')


def verify_package(package):
    manifest_path=package/'SHA256SUMS.json'
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError('安装包缺少或无效 SHA256SUMS.json')
    def unique_keys(pairs):
        result={}
        for name,value in pairs:
            if name in result: raise ValueError('重复 SHA256SUMS.json 条目: '+name)
            result[name]=value
        return result
    try:
        manifest=json.loads(manifest_path.read_text(encoding='utf8'),object_pairs_hook=unique_keys)
    except (ValueError, UnicodeError) as error:
        raise ValueError('无效 SHA256SUMS.json') from error
    if not isinstance(manifest,dict) or not manifest:
        raise ValueError('无效 SHA256SUMS.json')
    for name,digest in manifest.items():
        if (not isinstance(name,str) or not name or name.startswith('/') or '\\' in name
                or any(part in ('','.','..') for part in name.split('/'))
                or name=='SHA256SUMS.json' or not isinstance(digest,str)
                or not re.fullmatch(r'[0-9a-f]{64}',digest)):
            raise ValueError('无效 SHA256SUMS.json 条目: '+str(name))
    reject_normalized_collisions([*manifest,'SHA256SUMS.json'])
    actual=set()
    entries=[]
    for directory, dirs, files in os.walk(package,followlinks=False):
        for name in dirs+files:
            path=Path(directory)/name
            if path.is_symlink(): raise ValueError('安装包不允许符号链接: '+str(path))
            entries.append(path.relative_to(package).as_posix())
            if name in files:
                if not path.is_file(): raise ValueError('安装包不是普通文件: '+str(path))
                actual.add(path.relative_to(package).as_posix())
    reject_normalized_collisions(entries)
    if actual != set(manifest)|{'SHA256SUMS.json'}:
        raise ValueError('SHA256SUMS.json 与安装包文件不一致')
    for name,digest in manifest.items():
        sha=hashlib.sha256()
        with (package/name).open('rb') as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''):
                sha.update(chunk)
        if sha.hexdigest()!=digest: raise ValueError('SHA256SUMS.json 哈希不匹配: '+name)
    verify_package_layout(package,actual)
    return manifest


def verify_installed(target,manifest):
    prefix='browser-link/'
    expected={name[len(prefix):]:digest for name,digest in manifest.items() if name.startswith(prefix)}
    actual=set()
    actual_dirs=set()
    for directory,dirs,files in os.walk(target,followlinks=False):
        for name in dirs+files:
            path=Path(directory)/name
            if path.is_symlink(): raise ValueError('安装包不允许符号链接: '+str(path))
            relative=path.relative_to(target).as_posix()
            if name in dirs:
                actual_dirs.add(relative)
            else:
                if not path.is_file(): raise ValueError('安装包不是普通文件: '+str(path))
                actual.add(relative)
    if actual!=set(expected): raise ValueError('SHA256SUMS.json 与安装文件不一致')
    if actual_dirs!=expected_directories(expected): raise ValueError('安装目录布局与 SHA256SUMS.json 不一致')
    for name,digest in expected.items():
        sha=hashlib.sha256()
        with (target/name).open('rb') as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''):
                sha.update(chunk)
        if sha.hexdigest()!=digest: raise ValueError('SHA256SUMS.json 哈希不匹配: '+name)


def make_directories(path,created,mode=0o777):
    pending=[]
    cursor=path
    while not cursor.exists():
        pending.append(cursor)
        cursor=cursor.parent
    for directory in reversed(pending):
        try:
            directory.mkdir(mode=mode)
        except FileExistsError:
            continue
        created.append(directory)


def reject_target_symlinks(paths):
    for path in paths:
        for part in (path,*path.parents):
            if part.is_symlink():
                raise ValueError('安装目标路径不允许符号链接: '+str(part))


def reject_package_symlinks(package):
    for part in (package,*package.parents):
        if part.is_symlink(): raise ValueError('安装包路径不允许符号链接: '+str(part))


def install(package, user_home, hermes_home, origins, *, apply=False):
    package=Path(os.path.abspath(Path(package).expanduser()))
    user_home=Path(os.path.abspath(Path(user_home).expanduser()))
    hermes_home=Path(os.path.abspath(Path(hermes_home).expanduser()))
    reject_package_symlinks(package)
    # 安装前先确认候选包存在，避免复制阶段抛出缺少上下文的文件错误。
    if not (package/'browser-link/plugin.yaml').is_file():
        raise ValueError('安装包缺少 browser-link/plugin.yaml')
    origins=list(dict.fromkeys(origins))
    if not origins or any(not re.fullmatch(r'chrome-extension://[a-p]{32}/',o) for o in origins):
        raise ValueError('必须提供浏览器扩展实际的精确 origin，不允许通配符')
    # 中文注释：固定身份不允许通过安装参数放行其他扩展。
    if origins != ['chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/']:
        raise ValueError("扩展来源必须匹配 manifest key 固定 ID")

    with tempfile.TemporaryDirectory(prefix='browser-link-stage-') as scratch:
        staged=Path(scratch)/'release'
        # Preserve symlinks so validation rejects them instead of following them.
        shutil.copytree(package,staged,symlinks=True)
        manifest=verify_package(staged)
        return _install_verified(staged,user_home,hermes_home,origins,manifest,apply=apply)


def _install_verified(package,user_home,hermes_home,origins,manifest,*,apply):
    source=package/'browser-link'
    extension_manifest=package/'native-extension/manifest.json'
    if not extension_manifest.is_file(): raise ValueError('安装包缺少 native-extension/manifest.json')
    try:
        extension=json.loads(extension_manifest.read_text(encoding='utf8'))
        worker=extension['background']['service_worker']
    except (ValueError, UnicodeError, KeyError, TypeError) as error:
        raise ValueError('无效 native-extension/manifest.json background.service_worker') from error
    if (not isinstance(worker,str) or not worker or worker.startswith('/') or '\\' in worker
            or any(part in ('','.','..') for part in worker.split('/'))
            or not (package/'native-extension'/worker).is_file()):
        raise ValueError('安装包缺少 native-extension 入口: '+str(worker))
    target=hermes_home/'plugins/browser-link'
    data=hermes_home/'plugin-data/browser-link-native'
    launcher=data/HOST
    manifests=[user_home/'Library/Application Support'/browser/'NativeMessagingHosts'/f'{HOST}.json' for browser in ['Google/Chrome','Microsoft Edge']]
    # 中文注释：新云端注册纳入同一安装事务，不覆盖原本地注册，也不重启原服务。
    cloud_registration=runpy.run_path(str(source/'cloud_link/registration.py'))['registration']
    cloud_launcher,cloud_text,cloud_manifests=cloud_registration(target/'cloud_link',user_home,hermes_home,origins,sys.executable)
    config=data/'host-config.json'
    targets=[target,launcher,config,*manifests,cloud_launcher,*[p for p,_ in cloud_manifests]]
    reject_target_symlinks(targets)
    for p in targets:
        if p.exists() or p.is_symlink(): raise FileExistsError('拒绝覆盖已有安装: '+str(p))
    result={'status':'plan','plugin':str(target),'host':str(launcher),'manifests':[str(p) for p in manifests],
            'dependencies':'none (standard library only)',
            'activation':'not enabled; no process restarted','releaseStatus':release_status(package)}
    if not apply: return result
    created=[]
    created_dirs=[]
    try:
        make_directories(target.parent,created_dirs)
        target.mkdir()
        created.append(target)
        shutil.copytree(source,target,symlinks=False,dirs_exist_ok=True)
        verify_installed(target,manifest)
        reject_target_symlinks(targets)
        make_directories(data,created_dirs,mode=0o700)
        if data in created_dirs: os.chmod(data,0o700)
        native_dir=target/'native_bridge'
        text=(f'#!{sys.executable}\nimport os,runpy,sys\n'
              f'sys.path.insert(0,{str(native_dir)!r})\n'
              f'os.environ["HERMES_HOME"]={str(hermes_home)!r}\n'
              f'runpy.run_path({str(native_dir/"host.py")!r},run_name="__main__")\n')
        with launcher.open('x',encoding='utf8') as f:
            created.append(launcher)
            f.write(text)
        os.chmod(launcher,0o700)
        config_value={'allowedOrigins':origins}
        native_manifest={'name':HOST,'description':'Hermes Browser Link native bridge','path':str(launcher),'type':'stdio','allowed_origins':origins}
        for p,value in [(config,config_value),*((p,native_manifest) for p in manifests)]:
            make_directories(p.parent,created_dirs)
            fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            created.append(p)
            with os.fdopen(fd,'w') as f:json.dump(value,f,ensure_ascii=False,indent=2)
        for p in manifests:
            assert json.loads(p.read_text())==native_manifest
        make_directories(cloud_launcher.parent,created_dirs,mode=0o700)
        with cloud_launcher.open('x',encoding='utf8') as f:
            created.append(cloud_launcher)
            f.write(cloud_text)
        os.chmod(cloud_launcher,0o700)
        for p,value in cloud_manifests:
            make_directories(p.parent,created_dirs)
            fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            created.append(p)
            with os.fdopen(fd,'w') as f:json.dump(value,f,ensure_ascii=False,indent=2)
        result['status']='installed_disabled'
        return result
    except BaseException:
        def remove_read_only(func,path,_error):
            failed=Path(path)
            if failed!=target and not failed.is_relative_to(target):
                raise OSError('清理路径超出安装目标: '+str(failed))
            parent=failed.parent
            if parent.is_relative_to(target) and not parent.is_symlink():
                os.chmod(parent,stat.S_IMODE(parent.stat().st_mode)|stat.S_IWUSR|stat.S_IXUSR)
            if not failed.is_symlink() and failed.exists():
                os.chmod(failed,stat.S_IMODE(failed.stat().st_mode)|stat.S_IWUSR|stat.S_IXUSR)
            func(path)
        for p in reversed(created):
            if p.is_dir() and not p.is_symlink():shutil.rmtree(p,onerror=remove_read_only)
            else:p.unlink(missing_ok=True)
        for directory in reversed(created_dirs):
            try:directory.rmdir()
            except OSError:pass
        raise


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--package',type=Path,default=Path(__file__).resolve().parent)
    p.add_argument('--user-home',type=Path,default=Path.home())
    p.add_argument('--hermes-home',type=Path,default=Path(os.environ.get('HERMES_HOME',str(Path.home()/'.hermes'))))
    p.add_argument('--extension-origin',action='append',required=True)
    p.add_argument('--apply',action='store_true')
    args=p.parse_args()
    if sys.platform!='darwin':p.error('此安装器当前仅针对已验收的 macOS Chrome/Edge')
    print(json.dumps(install(args.package,args.user_home,args.hermes_home,args.extension_origin,
                             apply=args.apply),
                     ensure_ascii=False,indent=2))
if __name__=='__main__':main()
