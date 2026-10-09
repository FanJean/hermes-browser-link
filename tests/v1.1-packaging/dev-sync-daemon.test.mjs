import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {cp,mkdtemp,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {assertDevelopmentIdle,runDevelopmentGuard} from '../../scripts/dev-sync-daemon.mjs';

// 中文注释：保留指定 TMPDIR 的隔离范围；短目录名让 profile scratch 下的 macOS 套接字仍不超限。
async function daemonHome(){
 for(let attempt=0;attempt<100;attempt++){
  const home=path.join(tmpdir(),`d${randomUUID().slice(0,3)}`);
  try{await mkdir(home,{mode:0o700});return home;}
  catch(error){if(error.code!=='EEXIST')throw error;}
 }
 throw Error('无法分配临时 daemon 目录');
}

test('dev-sync 不向 PID 文件指向的无关进程发送 SIGTERM',async t=>{
 const home=await mkdtemp(path.join(tmpdir(),'dev-sync-pid-'));
 const dataDir=path.join(home,'plugin-data','browser-link-native');
 await mkdir(dataDir,{recursive:true});
 const child=spawn(process.execPath,['-e','process.stdout.write("ready\\n");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']});
 t.after(async()=>{
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}
  await rm(home,{recursive:true,force:true});
 });
 await once(child.stdout,'data');
 const pidFile=path.join(dataDir,'daemon.pid');
 await writeFile(pidFile,String(child.pid),{mode:0o600});
 // 中文注释：无关子进程模拟复用后的 PID；拒绝身份核对时不得发信号。
 assert.throws(()=>assertDevelopmentIdle(home,path.resolve(import.meta.dirname,'../..')),/身份|核对|手动/);
 assert.equal(child.exitCode,null);
 assert.equal(child.signalCode,null);
});

test('dev-sync 拒绝真实活 daemon 且不发送信号',async t=>{
 const home=await daemonHome();
 let daemon;
 t.after(async()=>{
  if(daemon&&daemon.exitCode===null&&daemon.signalCode===null){daemon.kill('SIGKILL');await once(daemon,'exit');}
  await rm(home,{recursive:true,force:true});
 });
 const pidFile=path.join(home,'plugin-data','browser-link-native','daemon.pid');
 // 中文注释：macOS 的 AF_UNIX 路径最多 103 字节；启动前核对最终路径的 UTF-8 长度。
 const socketPath=path.join(path.dirname(pidFile),'bridge.sock');
 assert.ok(Buffer.byteLength(socketPath,'utf8')<=103,'临时 daemon 的 socket 路径超过 103 字节');
 const daemonScript=path.join(home,'plugins/browser-link/native_bridge/daemon.py');
 await mkdir(path.dirname(daemonScript),{recursive:true});
 await cp(path.resolve('native-bridge'),path.dirname(daemonScript),{recursive:true});
 daemon=spawn(process.env.BROWSER_LINK_TEST_PYTHON||'python3',[daemonScript,'--home',home],{stdio:'ignore'});
 let ready=false;
 for(let i=0;i<100;i++){
  try{ready=(await readFile(pidFile,'utf8')).trim()===String(daemon.pid);}catch{}
  if(ready)break;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.ok(ready,'临时 daemon 未启动');
 const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 t.after(async()=>{if(unrelated.exitCode===null&&unrelated.signalCode===null){unrelated.kill('SIGKILL');await once(unrelated,'exit');}});
 await writeFile(pidFile,String(unrelated.pid),{mode:0o600});
 // 中文注释：真实套接字仍在线时，伪造 PID 也不能使脚本停止无关子进程。
 assert.throws(()=>assertDevelopmentIdle(home,path.resolve(import.meta.dirname,'../..')),/身份|核对/);
 assert.equal(unrelated.exitCode,null);
 assert.equal(daemon.exitCode,null);
 await writeFile(pidFile,String(daemon.pid),{mode:0o600});
 assert.throws(()=>assertDevelopmentIdle(home,path.resolve(import.meta.dirname,'../..')),/仍在运行|退出/);
 assert.equal(daemon.exitCode,null);
 assert.equal(daemon.signalCode,null);
});

async function syncFixture(t){
 const base=await mkdtemp(path.join(tmpdir(),'sync-guard-'));
 t.after(()=>rm(base,{recursive:true,force:true}));
 const repo=path.join(base,'repo'),home=path.join(base,'home');
 await mkdir(path.join(repo,'scripts'),{recursive:true});
 for(const file of ['directory-swap.mjs','dev-sync-local.mjs','dev-sync-daemon.mjs','install-cli.py','install-executor.py'])
  await cp(path.resolve(import.meta.dirname,'../../scripts',file),path.join(repo,'scripts',file));
 const installed=path.join(home,'plugins/browser-link/desktop/plugin.js');
 const desktop=path.join(home,'desktop-plugins/browser-link/plugin.js');
 const extension=path.join(home,'browser-link-releases/dev');
 const data=path.join(home,'plugin-data/browser-link-native');
 for(const directory of [path.dirname(installed),path.dirname(desktop),extension,data,path.join(repo,'native-extension')])
  await mkdir(directory,{recursive:true});
 await writeFile(installed,'installed-sentinel');await writeFile(desktop,'desktop-sentinel');
 const manifest=JSON.stringify({name:'Test extension',version:'1.0.0'});
 await writeFile(path.join(extension,'manifest.json'),manifest);
 await writeFile(path.join(repo,'native-extension/manifest.json'),manifest);
 await writeFile(path.join(path.dirname(desktop),'.hermes-package.json'),JSON.stringify({package:'browser-link',source:path.dirname(installed)}));
 await writeFile(path.join(repo,'.dev-sync.local.json'),JSON.stringify({extensionDir:extension}));
 await mkdir(path.join(home,'plugins/browser-link/cloud_link'),{recursive:true});
 await mkdir(path.join(home,'plugins/browser-link/maintenance'),{recursive:true});
 const cloudHost=path.join(home,'plugins/browser-link/cloud_link/native_host.py');
 const cli=path.join(home,'plugins/browser-link/maintenance/install-cli.py');
 await cp(path.resolve(import.meta.dirname,'../../cloud-link/native_host.py'),cloudHost);
 await cp(path.join(repo,'scripts/install-cli.py'),cli);
 const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
 await writeFile(path.join(data,'install-state.json'),JSON.stringify({cloudFence:{version:1,hostSha256:await hash(cloudHost),installerSha256:await hash(cli)}}),{mode:0o600});
 await writeFile(path.join(repo,'scripts/package-executor.mjs'),"console.error('PACKAGING_REACHED');process.exit(42);");
 const registration=spawnSync(process.env.BROWSER_LINK_TEST_PYTHON||'python3',['-c',`
import json,runpy,sys
from pathlib import Path
home,user_home=map(Path,sys.argv[2:])
launcher,text,manifests=runpy.run_path(sys.argv[1])['registration'](home/'plugins/browser-link/cloud_link',user_home,home,['chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/'],sys.executable)
launcher.parent.mkdir(parents=True,mode=0o700)
launcher.write_text(text);launcher.chmod(0o700)
for file,value in manifests:
 file.parent.mkdir(parents=True,exist_ok=True);file.write_text(json.dumps(value));file.chmod(0o600)
 `,path.resolve(import.meta.dirname,'../../cloud-link/registration.py'),home,base],{encoding:'utf8'});
 assert.equal(registration.status,0,registration.stderr);
 const run=()=>spawnSync(process.execPath,[path.join(repo,'scripts/dev-sync-local.mjs')],{encoding:'utf8',env:{...process.env,HOME:base,HERMES_HOME:home},timeout:5000});
 return {base,repo,home,data,installed,desktop,run};
}

test('dev-sync 未知任务合同在打包及首次写入前拒绝',async t=>{
 const terminal={id:'test-task',owner:'test-owner',state:'closed',cleanupState:'succeeded',requestHistory:[]};
 for(const record of [[],null,{}, {version:1,tasks:[null]},...['future_state','needs_sync','running'].map(state=>({version:1,tasks:[{...terminal,state}]})),{version:1,tasks:[{...terminal,cleanupState:'failed'}]}, {version:1,tasks:[{...terminal,requestHistory:[{state:'dispatched'}]}]}, {version:1,tasks:[{...terminal,operationTimeline:[{state:'unknown'}]}]}, {version:1,tasks:[{...terminal,vaultPermit:{}}]}, ...[null,{}, {state:'unknown'},{state:'pending'},{state:'running'}].map(currentOperation=>({version:1,tasks:[{...terminal,currentOperation}]}))])
  await t.test(JSON.stringify(record),async t=>{
   const f=await syncFixture(t);
   await writeFile(path.join(f.data,'tasks.json'),JSON.stringify(record),{mode:0o600});
   const before=await stat(f.installed),result=f.run();
   assert.notEqual(result.status,0);assert.doesNotMatch(result.stderr,/PACKAGING_REACHED/);
   assert.equal(await readFile(f.installed,'utf8'),'installed-sentinel');
   assert.equal((await stat(f.installed)).mtimeMs,before.mtimeMs);
  });
});

test('dev-sync 打包期间新增活动必须拒绝且目标字节和 mtime 不变',async t=>{
 const f=await syncFixture(t);
 await writeFile(path.join(f.data,'tasks.json'),JSON.stringify({version:1,tasks:[]}),{mode:0o600});
 // 中文注释：只控制外部打包 transport；执行真实 dev-sync，不替换锁或任务检查方法。
 await writeFile(path.join(f.repo,'scripts/package-executor.mjs'),`
 import {mkdir,writeFile} from 'node:fs/promises';
 import {createHash} from 'node:crypto';
 import path from 'node:path';
 await writeFile(${JSON.stringify(path.join(f.data,'tasks.json'))},JSON.stringify({version:1,tasks:[{state:'running'}]}));
 const output=process.argv[process.argv.indexOf('--output')+1];
 const files={'browser-link/desktop/plugin.js':'new-desktop','native-extension/manifest.json':JSON.stringify({name:'Test extension',version:'1.0.0'})};
 const hashes={};
 for(const [name,content] of Object.entries(files)){
  await mkdir(path.dirname(path.join(output,name)),{recursive:true});await writeFile(path.join(output,name),content);
  hashes[name]=createHash('sha256').update(content).digest('hex');
 }
 await writeFile(path.join(output,'SHA256SUMS.json'),JSON.stringify(hashes));
 `);
 const files=[f.installed,f.desktop],bytes=await Promise.all(files.map(file=>readFile(file,'utf8')));
 const mtimes=await Promise.all(files.map(async file=>(await stat(file)).mtimeMs));
 const result=f.run();
 t.diagnostic(JSON.stringify({exit:result.status,output:result.stdout,bytesBefore:bytes,bytesAfter:await Promise.all(files.map(file=>readFile(file,'utf8'))),mtimesBefore:mtimes,mtimesAfter:await Promise.all(files.map(async file=>(await stat(file)).mtimeMs))}));
 assert.notEqual(result.status,0,'活动任务在打包期间出现仍被同步');
 assert.match(result.stderr,/活动任务|无法核实/);
 assert.deepEqual(await Promise.all(files.map(file=>readFile(file,'utf8'))),bytes);
 assert.deepEqual(await Promise.all(files.map(async file=>(await stat(file)).mtimeMs)),mtimes);
});

test('dev-sync 正式守卫覆盖整个子进程并阻止真实 daemon 启动',async t=>{
 const f=await syncFixture(t);
 await writeFile(path.join(f.data,'tasks.json'),JSON.stringify({version:1,tasks:[]}),{mode:0o600});
 const bridge=path.join(f.home,'plugins/browser-link/native_bridge');
 await cp(path.resolve(import.meta.dirname,'../../native-bridge'),bridge,{recursive:true});
 const result=runDevelopmentGuard(f.home,f.repo,[process.execPath,'--input-type=module','-e',`
  import {spawnSync} from 'node:child_process';
  import {existsSync} from 'node:fs';
  const result=spawnSync(${JSON.stringify(process.env.BROWSER_LINK_TEST_PYTHON||'python3')},[${JSON.stringify(path.join(bridge,'daemon.py'))},'--home',${JSON.stringify(f.home)}],{encoding:'utf8'});
  if(result.status!==0||existsSync(${JSON.stringify(path.join(f.data,'daemon.pid'))}))process.exit(1);
  const lock=spawnSync(${JSON.stringify(process.env.BROWSER_LINK_TEST_PYTHON||'python3')},['-c',
   'import fcntl,os,sys;fd=os.open(sys.argv[1],os.O_RDONLY);fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)',${JSON.stringify(f.home)}]);
  if(lock.status===0)process.exit(2);
 `],{...process.env,HOME:f.base});
 assert.equal(result.status,0,result.stderr);
 assert.equal(await readFile(f.installed,'utf8'),'installed-sentinel');
});
