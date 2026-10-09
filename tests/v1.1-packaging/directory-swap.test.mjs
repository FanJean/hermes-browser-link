import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {chmod,cp,mkdtemp,mkdir,writeFile,readFile,readdir,readlink,rename,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {swapInstalledDirectory,rollbackDirectorySwaps,installedPluginTargets} from '../../scripts/directory-swap.mjs';

async function developmentFixture(t,selectedHome){
 const base=await mkdtemp(path.join(tmpdir(),'bridge-development-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const repo=path.join(base,'repo'),home=selectedHome||path.join(base,'home'),root=path.join(home,'plugins','browser-link');
 await mkdir(path.join(repo,'scripts'),{recursive:true});
 for(const file of ['directory-swap.mjs','dev-sync-local.mjs','dev-watch-desktop.mjs','dev-sync-daemon.mjs','install-cli.py','install-executor.py'])
  await cp(path.resolve(import.meta.dirname,'../../scripts',file),path.join(repo,'scripts',file));
 const source=path.join(repo,'executor-plugin','desktop','plugin.js'),installed=path.join(root,'desktop','plugin.js'),desktop=path.join(home,'desktop-plugins','browser-link','plugin.js');
 for(const file of [source,installed,desktop]){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,file===source?'globalThis.preview = "new";':'globalThis.preview = "old";');}
 const marker=path.join(path.dirname(desktop),'.hermes-package.json');
 await writeFile(marker,JSON.stringify({package:'browser-link',source:path.dirname(installed)}));
 const profile=path.join(home,'profiles','named'),link=path.join(profile,'plugins','browser-link');
 await mkdir(path.dirname(link),{recursive:true});await symlink(root,link);
 const run=(script,selectedHome=home)=>spawnSync(process.execPath,[path.join(repo,'scripts',script)],{encoding:'utf8',env:{...process.env,HERMES_HOME:selectedHome},timeout:1500,killSignal:'SIGINT'});
 return {base,repo,home,root,source,installed,desktop,marker,profile,link,run};
}

test('dev watch normalizes a profile home and only updates the shared and application entries',async t=>{
 const f=await developmentFixture(t),linkBefore=await readlink(f.link);
 const profileDesktop=path.join(f.profile,'desktop-plugins','browser-link');await mkdir(profileDesktop,{recursive:true});
 await writeFile(path.join(profileDesktop,'plugin.js'),'profile-ui-sentinel');
 const config=path.join(f.profile,'config.yaml');await writeFile(config,'disabled-sentinel');
 const result=f.run('dev-watch-desktop.mjs',f.profile);
 assert.match(result.stdout,/已同步 Hermes 桌面插件/);
 assert.equal(await readFile(f.installed,'utf8'),await readFile(f.source,'utf8'));
 assert.equal(await readFile(f.desktop,'utf8'),await readFile(f.source,'utf8'));
 assert.equal(await readlink(f.link),linkBefore);
 assert.equal(await readFile(path.join(profileDesktop,'plugin.js'),'utf8'),'profile-ui-sentinel');
 assert.equal(await readFile(config,'utf8'),'disabled-sentinel');
 assert.equal(JSON.parse(await readFile(f.marker,'utf8')).source,path.dirname(f.installed));
});

test('dev watch refuses legacy copies and linked application ancestors before writing',async t=>{
 for(const kind of ['legacy','desktop-ancestor','marker-link','installed-ancestor']){
  await t.test(kind,async t=>{
   const f=await developmentFixture(t),before=await readFile(f.installed,'utf8'),desktopBefore=await readFile(f.desktop,'utf8');
   if(kind==='legacy'){await rm(f.link);await mkdir(f.link);}
   else {
    const target={'desktop-ancestor':path.dirname(f.desktop),'marker-link':f.marker,'installed-ancestor':path.dirname(f.installed)}[kind];
    const saved=path.join(f.base,'saved');await rename(target,saved);await symlink(saved,target);
   }
   const result=f.run('dev-watch-desktop.mjs');
   assert.notEqual(result.status,0);assert.match(result.stderr,kind==='legacy'?/\.\/install\.sh --upgrade/:/link/i);
   assert.equal(await readFile(f.installed,'utf8'),before);assert.equal(await readFile(f.desktop,'utf8'),desktopBefore);
  });
 }
});

async function syncConfiguration(f){
 const extension=path.join(f.home,'browser-link-releases','dev'),data=path.join(f.home,'plugin-data','browser-link-native');
 await mkdir(extension,{recursive:true});await mkdir(data,{recursive:true});
 const manifest={name:'Test extension',version:'1.0.0'};
 await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
 await mkdir(path.join(f.repo,'native-extension'),{recursive:true});await writeFile(path.join(f.repo,'native-extension','manifest.json'),JSON.stringify(manifest));
 await writeFile(path.join(f.repo,'.dev-sync.local.json'),JSON.stringify({extensionDir:extension}));
 await writeFile(path.join(data,'tasks.json'),'[]');await writeFile(path.join(data,'daemon.pid'),'123',{mode:0o600});
 return {extension,data};
}

test('dev sync rejects data and write-target links before packaging or installed writes',async t=>{
 for(const kind of ['data','task','pid','backups','desktop','marker','extension','extension-manifest']){
  await t.test(kind,async t=>{
   const f=await developmentFixture(t),{extension,data}=await syncConfiguration(f);
   const backup=path.join(f.home,'plugin-backups');await mkdir(backup);
   const target={data,task:path.join(data,'tasks.json'),pid:path.join(data,'daemon.pid'),backups:backup,desktop:path.dirname(f.desktop),marker:f.marker,extension,'extension-manifest':path.join(extension,'manifest.json')}[kind];
   const saved=path.join(f.base,'saved');await rename(target,saved);await symlink(saved,target);
   const files=[f.installed,f.desktop,f.marker,path.join(extension,'manifest.json')];
   const before=await Promise.all(files.map(file=>readFile(file,'utf8'))),result=f.run('dev-sync-local.mjs');
   assert.notEqual(result.status,0);assert.match(result.stderr,/contains a link/i);
   assert.deepEqual(await Promise.all(files.map(file=>readFile(file,'utf8'))),before);assert.deepEqual(await readdir(backup),[]);
  });
 }
});

test('dev sync validates every Desktop entry and marker before any installed target write',async t=>{
 for(const kind of ['wrong-package','wrong-source','missing-entry','missing-marker','entry-directory']){
  await t.test(kind,async t=>{
   const f=await developmentFixture(t),{extension}=await syncConfiguration(f);
   if(kind==='wrong-package'||kind==='wrong-source')await writeFile(f.marker,JSON.stringify({package:kind==='wrong-package'?'unknown':'browser-link',source:kind==='wrong-source'?f.base:path.dirname(f.installed)}));
   if(kind==='missing-entry'||kind==='entry-directory'){await rm(f.desktop);if(kind==='entry-directory')await mkdir(f.desktop);}
   if(kind==='missing-marker')await rm(f.marker);
   const rootBefore=await readFile(f.installed,'utf8'),extensionBefore=await readFile(path.join(extension,'manifest.json'),'utf8');
   const result=f.run('dev-sync-local.mjs');
   assert.notEqual(result.status,0);assert.match(result.stderr,/桌面插件|安装入口|ENOENT/);assert.doesNotMatch(result.stderr,/打包失败/);
   assert.equal(await readFile(f.installed,'utf8'),rootBefore);assert.equal(await readFile(path.join(extension,'manifest.json'),'utf8'),extensionBefore);
   assert.ok(!(await readdir(f.home)).includes('plugin-backups'));
  });
 }
});

test('dev sync preserves all installed bytes when task guard or raw home links reject',async t=>{
 for(const kind of ['active','unverifiable','profile-home-link','hidden-home-link']){
  await t.test(kind,async t=>{
   const f=await developmentFixture(t),{extension,data}=await syncConfiguration(f);
   let selectedHome=f.profile;
   if(kind==='active')await writeFile(path.join(data,'tasks.json'),JSON.stringify({tasks:[{state:'running'}]}));
   if(kind==='unverifiable')await writeFile(path.join(data,'tasks.json'),JSON.stringify({tasks:'unknown'}));
   if(kind==='profile-home-link'){selectedHome=path.join(f.home,'profiles','alias');await symlink(f.profile,selectedHome);}
   if(kind==='hidden-home-link'){
    await symlink(f.home,path.join(f.home,'alias'));
    selectedHome=`${f.home}/alias/../profiles/named`;
   }
   const files=[f.installed,f.desktop,f.marker,path.join(extension,'manifest.json')],before=await Promise.all(files.map(file=>readFile(file,'utf8')));
   const result=f.run('dev-sync-local.mjs',selectedHome);
   assert.notEqual(result.status,0);assert.match(result.stderr,kind==='active'?/活动任务/:kind==='unverifiable'?/无法核实/:/contains a link/);
   assert.deepEqual(await Promise.all(files.map(file=>readFile(file,'utf8'))),before);assert.ok(!(await readdir(f.home)).includes('plugin-backups'));
  });
 }
});

test('dev sync uses the shared root to refuse a legacy copy before configuration or writes',async t=>{
 const f=await developmentFixture(t);await rm(f.link);await mkdir(f.link);
 const before=await readFile(f.installed,'utf8'),result=f.run('dev-sync-local.mjs',f.profile);
 assert.notEqual(result.status,0);assert.match(result.stderr,/\.\/install\.sh --upgrade/);
 assert.equal(await readFile(f.installed,'utf8'),before);
 assert.ok(!(await readdir(f.home)).includes('plugin-backups'));
});

test('real dev sync packages and swaps the shared root once while preserving profile links',async t=>{
 const home=path.join(tmpdir(),`d${randomUUID().slice(0,3)}`);await mkdir(home,{mode:0o700});
 let daemon;
 t.after(async()=>{
  if(daemon&&daemon.exitCode===null&&daemon.signalCode===null){daemon.kill('SIGKILL');await once(daemon,'exit');}
  await rm(home,{recursive:true,force:true});
 });
 const f=await developmentFixture(t,home),{extension,data}=await syncConfiguration(f);
 const sourceRepo=path.resolve(import.meta.dirname,'../..');
 const inputs=['scripts','package.json','package-lock.json','executor-plugin','native-bridge','native-extension','cloud-link','browser-workspaces','browser-diagnostics','page-semantics','browser-interactions','approval-policy','CHANGELOG.md','docs','install.sh','LICENSE'];
 const skip=new Set(['node_modules','.git','__pycache__','dist-native','evidence']);
 for(const input of inputs)await cp(path.join(sourceRepo,input),path.join(f.repo,input),{recursive:true,filter:file=>!skip.has(path.basename(file))});
 await cp(path.join(f.repo,'native-extension','manifest.json'),path.join(extension,'manifest.json'));
 await cp(path.join(f.repo,'native-bridge'),path.join(f.root,'native_bridge'),{recursive:true});
 const daemonScript=path.join(f.root,'native_bridge','daemon.py'),pidFile=path.join(data,'daemon.pid');
 await rm(pidFile);await writeFile(path.join(data,'tasks.json'),JSON.stringify({version:1,tasks:[]}),{mode:0o600});
 await chmod(path.join(data,'tasks.json'),0o600);
 assert.ok(Buffer.byteLength(path.join(data,'bridge.sock'))<=103,'隔离 daemon socket 路径超过 macOS 上限');
 let daemonError='';
 daemon=spawn(process.env.BROWSER_LINK_TEST_PYTHON||'python3',[daemonScript,'--home',home],{stdio:['ignore','ignore','pipe']});
 daemon.stderr.on('data',bytes=>{daemonError+=bytes;});
 let ready=false;
 for(let attempt=0;attempt<100;attempt++){
  try{ready=(await readFile(pidFile,'utf8')).trim()===String(daemon.pid);}catch{}
  if(ready)break;await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.ok(ready,`隔离 daemon 未启动：${daemonError}`);
 const originalLink=await readlink(f.link),config=path.join(f.profile,'config.yaml');await writeFile(config,'disabled-sentinel');
 const run=()=>spawnSync(process.execPath,[path.join(f.repo,'scripts','dev-sync-local.mjs')],{encoding:'utf8',env:{...process.env,HOME:f.base,HERMES_HOME:f.profile},timeout:120000});
 const refused=run();assert.notEqual(refused.status,0);assert.equal(daemon.exitCode,null);
 assert.equal(await readFile(f.installed,'utf8'),'globalThis.preview = "old";');
 // 中文注释：测试仅结束自己启动的进程，正向同步验证从已退出的服务开始。
 daemon.kill('SIGTERM');await once(daemon,'exit');
 await mkdir(path.join(f.root,'cloud_link'),{recursive:true});
 await cp(path.join(f.repo,'cloud-link/native_host.py'),path.join(f.root,'cloud_link/native_host.py'),{recursive:true});
 await mkdir(path.join(f.root,'maintenance'),{recursive:true});
 await cp(path.join(f.repo,'scripts/install-cli.py'),path.join(f.root,'maintenance/install-cli.py'));
 const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
 await writeFile(path.join(data,'install-state.json'),JSON.stringify({profiles:['default','named'],cloudFence:{version:1,
  hostSha256:await hash(path.join(f.root,'cloud_link/native_host.py')),installerSha256:await hash(path.join(f.root,'maintenance/install-cli.py'))}}),{mode:0o600});
 const registration=spawnSync(process.env.BROWSER_LINK_TEST_PYTHON||'python3',['-c',`
import json,runpy,sys
from pathlib import Path
home,user_home=map(Path,sys.argv[2:])
launcher,text,manifests=runpy.run_path(sys.argv[1])['registration'](home/'plugins/browser-link/cloud_link',user_home,home,['chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/'],sys.executable)
launcher.parent.mkdir(parents=True,mode=0o700)
launcher.write_text(text);launcher.chmod(0o700)
for file,value in manifests:
 file.parent.mkdir(parents=True,exist_ok=True);file.write_text(json.dumps(value));file.chmod(0o600)
 `,path.resolve(import.meta.dirname,'../../cloud-link/registration.py'),home,f.base],{encoding:'utf8'});
 assert.equal(registration.status,0,registration.stderr);
 // 中文注释：共享安装后 Desktop 可能记录命名 profile 的链接路径；真实路径相同应放行，同步后统一写回根路径。
 const marker=JSON.parse(await readFile(f.marker,'utf8'));
 await writeFile(f.marker,JSON.stringify({...marker,source:path.join(f.link,'desktop')}));
 const result=run();
 assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout);
 assert.equal(JSON.parse(await readFile(f.marker,'utf8')).source,path.join(f.root,'desktop'));
 assert.equal(output.pluginCopies,1);assert.equal(output.daemonStopped,false);t.diagnostic(JSON.stringify(output));
 const repeated=run();assert.equal(repeated.status,0,repeated.stderr);
 assert.equal(await readlink(f.link),originalLink);assert.equal(await readFile(config,'utf8'),'disabled-sentinel');
 assert.deepEqual(await readdir(path.join(home,'plugins')),['browser-link']);
 assert.deepEqual(await readdir(path.join(home,'plugin-backups')),[]);
 assert.equal(await readFile(f.installed,'utf8'),await readFile(path.join(f.repo,'executor-plugin','desktop','plugin.js'),'utf8'));
 assert.equal(await readFile(f.desktop,'utf8'),await readFile(f.installed,'utf8'));
});

// 中文注释：验证真实目录切换时扫描根始终只有一个插件，且可以恢复原文件。
test('directory swap keeps backup outside discovery and rollback restores original',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'bridge-swap-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const registry=path.join(root,'plugins'),target=path.join(registry,'browser-link'),source=path.join(root,'source');
 await mkdir(target,{recursive:true});await mkdir(source);await writeFile(path.join(target,'plugin.js'),'old');await writeFile(path.join(source,'plugin.js'),'new');
 const swap=await swapInstalledDirectory(target,source,path.join(root,'backups'));
 assert.deepEqual(await readdir(registry),['browser-link']);assert.equal(await readFile(path.join(target,'plugin.js'),'utf8'),'new');
 assert.equal(await readFile(path.join(swap.old,'plugin.js'),'utf8'),'old');
 await rollbackDirectorySwaps([swap]);assert.equal(await readFile(path.join(target,'plugin.js'),'utf8'),'old');assert.deepEqual(await readdir(registry),['browser-link']);
});

test('transaction directories inside the registry are rejected before replacement',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'bridge-swap-reject-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=path.join(root,'plugins','bridge');await mkdir(target,{recursive:true});await writeFile(path.join(target,'plugin.js'),'old');
 await assert.rejects(swapInstalledDirectory(target,target,path.join(root,'plugins','.backup')),/outside the plugin registry/);
 assert.equal(await readFile(path.join(target,'plugin.js'),'utf8'),'old');
 assert.deepEqual(await readdir(path.dirname(target)),['bridge']);
});

test('directory swap refuses target and transaction ancestor links without writes',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'bridge-swap-links-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=path.join(root,'plugins','browser-link'),source=path.join(root,'source');
 await mkdir(target,{recursive:true});await mkdir(source);await writeFile(path.join(target,'plugin.js'),'old');
 await symlink(root,path.join(root,'alias'));
 await assert.rejects(swapInstalledDirectory(path.join(root,'alias','plugins','browser-link'),source,path.join(root,'backups')),/link/i);
 await assert.rejects(swapInstalledDirectory(target,source,path.join(root,'alias','backups')),/link/i);
 assert.equal(await readFile(path.join(target,'plugin.js'),'utf8'),'old');
 assert.deepEqual(await readdir(path.dirname(target)),['browser-link']);
 assert.ok(!(await readdir(root)).includes('backups'));
});

// 中文注释：旧副本必须由正式升级迁移，开发同步不能自行复制或启用。
test('legacy profile copy is refused with the formal upgrade command',async t=>{
 const home=await mkdtemp(path.join(tmpdir(),'bridge-targets-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const root=path.join(home,'plugins','browser-link'),named=path.join(home,'profiles','named','plugins','browser-link');
 await mkdir(root,{recursive:true});assert.deepEqual(await installedPluginTargets(home),[root]);
 await mkdir(named,{recursive:true});
 await assert.rejects(installedPluginTargets(home),/\.\/install\.sh --upgrade/);
 assert.deepEqual(await readdir(path.dirname(root)),['browser-link']);
 assert.deepEqual(await readdir(named),[]);
});

test('discovery rejects linked roots and linked profile ancestors before returning targets',async t=>{
 for(const kind of ['home','root','registry','profile','profiles','profile-registry','missing-root']){
  await t.test(kind,async t=>{
   const base=await mkdtemp(path.join(tmpdir(),'bridge-ancestors-'));t.after(()=>rm(base,{recursive:true,force:true}));
   let home=path.join(base,'home');const root=path.join(home,'plugins','browser-link');
   await mkdir(root,{recursive:true});
   const named=path.join(home,'profiles','named');await mkdir(path.join(named,'plugins'),{recursive:true});
   await symlink(root,path.join(named,'plugins','browser-link'));
   if(kind==='missing-root')await rm(root,{recursive:true});
   else if(kind==='home'){await symlink(home,path.join(base,'alias'));home=path.join(base,'alias');}
   else {
    const target={root,registry:path.dirname(root),profile:named,profiles:path.dirname(named),'profile-registry':path.join(named,'plugins')}[kind];
    const saved=path.join(base,'saved');await rename(target,saved);await symlink(saved,target);
   }
   await assert.rejects(installedPluginTargets(home),/link|directory|ENOENT/i);
  });
 }
});

test('profile references must be direct links to the exact shared root',async t=>{
 const home=await mkdtemp(path.join(tmpdir(),'bridge-links-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const root=path.join(home,'plugins','browser-link'),registry=path.join(home,'profiles','named','plugins'),target=path.join(registry,'browser-link');
 await mkdir(root,{recursive:true});await mkdir(registry,{recursive:true});
 for(const destination of [root,path.relative(registry,root)]){
  await symlink(destination,target);assert.deepEqual(await installedPluginTargets(home),[root]);
  assert.equal(await readlink(target),destination);await rm(target);
 }
 await symlink(root,path.join(home,'indirect'));
 await symlink(home,path.join(home,'ancestor'));
 const other=path.join(home,'other','plugins','browser-link');await mkdir(other,{recursive:true});
 for(const destination of [path.join(home,'indirect'),path.join(home,'ancestor','plugins','browser-link'),other,path.join(home,'missing')]){
  await symlink(destination,target);
  await assert.rejects(installedPluginTargets(home),/link|链接/i);
  assert.equal(await readlink(target),destination);await rm(target);
 }
});
