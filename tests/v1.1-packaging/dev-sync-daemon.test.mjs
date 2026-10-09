import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {cp,lstat,mkdtemp,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
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
 // 中文注释：目录名保持很短，verify 的 scratch 下真实 daemon socket 路径仍需不超过 103 字节。
 const base=await mkdtemp(path.join(tmpdir(),'sg-'));
 t.after(()=>rm(base,{recursive:true,force:true}));
 const repo=path.join(base,'repo'),home=path.join(base,'h');
 await mkdir(path.join(repo,'scripts'),{recursive:true});
 for(const file of ['directory-swap.mjs','dev-sync-local.mjs','dev-sync-daemon.mjs','install-cli.py','install-executor.py'])
  await cp(path.resolve(import.meta.dirname,'../../scripts',file),path.join(repo,'scripts',file));
 const installed=path.join(home,'plugins/browser-link/desktop/plugin.js');
 const desktop=path.join(home,'desktop-plugins/browser-link/plugin.js');
 const extension=path.join(home,'browser-link-releases/dev');
 const data=path.join(home,'plugin-data/browser-link-native');
 for(const directory of [path.dirname(installed),path.dirname(desktop),extension,path.join(repo,'native-extension')])
  await mkdir(directory,{recursive:true});
 // 中文注释：与真实 daemon 一致，私有数据目录为 0700，维护标记才允许写入。
 await mkdir(data,{recursive:true,mode:0o700});
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
 // 中文注释：替身 hermes 只记录调用并读写临时 ESTOP，绝不调用用户真实的 Hermes。
 const hermesLog=path.join(base,'hermes.log'),hermes=path.join(base,'fake-hermes');
 await writeFile(hermes,`#!/bin/sh\necho "$*" >> ${JSON.stringify(hermesLog)}\ncase "$1" in pause) : > "$HERMES_HOME/ESTOP";; resume) rm -f "$HERMES_HOME/ESTOP";; esac\n`,{mode:0o700});
 const run=(args=[],extra={})=>spawnSync(process.execPath,[path.join(repo,'scripts/dev-sync-local.mjs'),...args],{encoding:'utf8',
  env:{...process.env,HOME:base,HERMES_HOME:home,BROWSER_LINK_HERMES:hermes,BROWSER_LINK_DEV_SYNC_WAIT_SECONDS:'1',...extra},timeout:20000});
 const hermesCalls=async()=>{try{return (await readFile(hermesLog,'utf8')).trim().split('\n').filter(Boolean);}catch{return [];}};
 return {base,repo,home,data,installed,desktop,run,hermesCalls};
}

test('dev-sync 未知任务合同在打包及首次写入前拒绝',async t=>{
 const terminal={id:'test-task',owner:'test-owner',state:'closed',cleanupState:'succeeded',requestHistory:[]};
 for(const record of [[],null,{}, {version:1,tasks:[null]},...['future_state','needs_sync','running'].map(state=>({version:1,tasks:[{...terminal,state}]})),{version:1,tasks:[{...terminal,cleanupState:'failed'}]}, {version:1,tasks:[{...terminal,vaultPermit:{}}]}, ...[null,{}, {state:'unknown'},{state:'pending'},{state:'running'}].map(currentOperation=>({version:1,tasks:[{...terminal,currentOperation}]}))])
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

const PYTHON=process.env.BROWSER_LINK_TEST_PYTHON||'python3';
const REPO=path.resolve(import.meta.dirname,'../..');
const exists=async file=>{try{await lstat(file);return true;}catch{return false;}};

// 中文注释：从已安装路径启动真实 daemon，命令行与正式身份核对一致。
async function startInstalledDaemon(t,home){
 const data=path.join(home,'plugin-data','browser-link-native');
 const socketPath=path.join(data,'bridge.sock');
 assert.ok(Buffer.byteLength(socketPath,'utf8')<=103,'临时 daemon 的 socket 路径超过 103 字节');
 const script=path.join(home,'plugins/browser-link/native_bridge/daemon.py');
 await mkdir(path.dirname(script),{recursive:true});
 await cp(path.join(REPO,'native-bridge'),path.dirname(script),{recursive:true});
 const daemon=spawn(PYTHON,[script,'--home',home],{stdio:'ignore'});
 t.after(async()=>{if(daemon.exitCode===null&&daemon.signalCode===null){daemon.kill('SIGKILL');await once(daemon,'exit');}});
 for(let i=0;i<200;i++){
  try{if((await readFile(path.join(data,'daemon.pid'),'utf8')).trim()===String(daemon.pid))return daemon;}catch{}
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw Error('临时 daemon 未启动');
}

// 中文注释：替身打包器生成同步所需的最小产物与哈希清单，其余流程走真实 dev-sync。
async function fakePackager(f){
 const cloudHost=await readFile(path.join(f.home,'plugins/browser-link/cloud_link/native_host.py'),'utf8');
 const cli=await readFile(path.join(f.home,'plugins/browser-link/maintenance/install-cli.py'),'utf8');
 await writeFile(path.join(f.repo,'scripts/package-executor.mjs'),`
 import {mkdir,writeFile} from 'node:fs/promises';
 import {createHash} from 'node:crypto';
 import path from 'node:path';
 const output=process.argv[process.argv.indexOf('--output')+1];
 const files=${JSON.stringify({'browser-link/desktop/plugin.js':'new-desktop','browser-link/cloud_link/native_host.py':cloudHost,
  'browser-link/maintenance/install-cli.py':cli,'native-extension/manifest.json':JSON.stringify({name:'Test extension',version:'1.0.0'})})};
 const hashes={};
 for(const [name,content] of Object.entries(files)){
  await mkdir(path.dirname(path.join(output,name)),{recursive:true});await writeFile(path.join(output,name),content);
  hashes[name]=createHash('sha256').update(content).digest('hex');
 }
 await writeFile(path.join(output,'SHA256SUMS.json'),JSON.stringify(hashes));
 `);
}

test('dev-sync 一条命令：暂停 Hermes、写维护标记、停止已核实 daemon、同步后删除标记并恢复',async t=>{
 const f=await syncFixture(t);
 await writeFile(path.join(f.data,'tasks.json'),JSON.stringify({version:1,tasks:[]}),{mode:0o600});
 await fakePackager(f);
 const daemon=await startInstalledDaemon(t,f.home);
 const exited=once(daemon,'exit');
 const result=f.run();
 assert.equal(result.status,0,result.stderr);
 const output=JSON.parse(result.stdout);
 assert.equal(output.status,'synced');
 assert.equal(output.daemonStopped,true);
 assert.equal(output.hermesPausedBefore,false);
 // 中文注释：daemon 收到 SIGTERM 后自行收尾，退出码为 0 而不是被强杀。
 const [code,signal]=await exited;
 assert.equal(code,0);assert.equal(signal,null);
 assert.equal(await readFile(f.installed,'utf8'),'new-desktop');
 assert.equal(await exists(path.join(f.data,'maintenance.json')),false,'同步结束必须删除维护标记');
 assert.deepEqual(await f.hermesCalls(),['pause --reason browser-link dev:sync','resume']);
 assert.equal(await exists(path.join(f.home,'ESTOP')),false);
});

test('dev-sync 等待任务超时列出 id 与标题，不停止任何进程并恢复 Hermes',async t=>{
 const f=await syncFixture(t);
 const task={id:'task-still-running',owner:'owner',title:'整理订单表',state:'running',cleanupState:'pending'};
 await writeFile(path.join(f.data,'tasks.json'),JSON.stringify({version:1,tasks:[task]}),{mode:0o600});
 const daemon=await startInstalledDaemon(t,f.home);
 const started=Date.now(),result=f.run(['--wait-seconds','1']);
 assert.notEqual(result.status,0);
 assert.ok(Date.now()-started>=1000,'必须等待配置的时长');
 assert.match(result.stderr,/超时/);
 assert.match(result.stderr,/task-still-running/);
 assert.match(result.stderr,/整理订单表/);
 assert.doesNotMatch(result.stderr,/PACKAGING_REACHED/);
 assert.equal(daemon.exitCode,null);assert.equal(daemon.signalCode,null);
 assert.equal(await exists(path.join(f.data,'maintenance.json')),false);
 assert.equal(await readFile(f.installed,'utf8'),'installed-sentinel');
 assert.deepEqual(await f.hermesCalls(),['pause --reason browser-link dev:sync','resume']);
});

test('dev-sync 开始前已暂停则不暂停也不恢复，结束后保持暂停',async t=>{
 const f=await syncFixture(t);
 await writeFile(path.join(f.home,'ESTOP'),'operator pause');
 await writeFile(path.join(f.data,'tasks.json'),JSON.stringify({version:1,tasks:[{id:'t',owner:'o',title:'x',state:'ready'}]}),{mode:0o600});
 const result=f.run(['--wait-seconds','0']);
 assert.notEqual(result.status,0);
 assert.deepEqual(await f.hermesCalls(),[]);
 assert.equal(await readFile(path.join(f.home,'ESTOP'),'utf8'),'operator pause');
});

test('dev-sync 已关闭但清理未知的任务立即列出并提示 tasks:ack，不等待',async t=>{
 const f=await syncFixture(t);
 await writeFile(path.join(f.data,'tasks.json'),JSON.stringify({version:1,tasks:[{id:'edge-old',owner:'o',title:'旧 Edge 任务',state:'closed',cleanupState:'unknown'}]}),{mode:0o600});
 const result=f.run(['--wait-seconds','30']);
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/edge-old/);assert.match(result.stderr,/tasks:ack/);
 assert.deepEqual(await f.hermesCalls(),['pause --reason browser-link dev:sync','resume']);
});

test('daemon 已停止时已关闭且清理成功任务的残留历史不再阻塞守卫',async t=>{
 const terminal={id:'test-task',owner:'test-owner',state:'closed',cleanupState:'succeeded',requestHistory:[]};
 for(const record of [{version:1,tasks:[{...terminal,requestHistory:[{state:'dispatched'}]}]},{version:1,tasks:[{...terminal,operationTimeline:[{state:'unknown'}]}]},
  {version:1,tasks:[{...terminal,currentOperation:{state:'unknown'},userVerified:{reason:'checked'}}]}])
  await t.test(JSON.stringify(record),async t=>{
   const f=await syncFixture(t);
   await writeFile(path.join(f.data,'tasks.json'),JSON.stringify(record),{mode:0o600});
   const result=f.run();
   // 中文注释：通过全部门禁后才会到达替身打包器。
   assert.match(result.stderr,/PACKAGING_REACHED/);
  });
 // 中文注释：未经用户核实的当前操作残留仍然拒绝。
 const f=await syncFixture(t);
 await writeFile(path.join(f.data,'tasks.json'),JSON.stringify({version:1,tasks:[{...terminal,currentOperation:{state:'unknown'}}]}),{mode:0o600});
 assert.doesNotMatch(f.run().stderr,/PACKAGING_REACHED/);
});

test('daemon 仍在运行时残留历史继续拒绝',async t=>{
 const f=await syncFixture(t);
 await writeFile(path.join(f.data,'tasks.json'),JSON.stringify({version:1,tasks:[]}),{mode:0o600});
 await startInstalledDaemon(t,f.home);
 const code=`
import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('cli',sys.argv[1]);cli=importlib.util.module_from_spec(spec);spec.loader.exec_module(cli)
cli.EXECUTOR=cli.load_module('ex',sys.argv[2])
home=Path(sys.argv[3]);(home/'plugin-data/browser-link-native/tasks.json').write_text('{"version":1,"tasks":[{"id":"a","owner":"o","state":"closed","cleanupState":"succeeded","requestHistory":[{"state":"dispatched"}]}]}')
try:
    cli.assert_tasks_idle(home)
except cli.CloudGateError:
    sys.exit(3)
`;
 const result=spawnSync(PYTHON,['-c',code,path.join(REPO,'scripts/install-cli.py'),path.join(REPO,'scripts/install-executor.py'),f.home],{encoding:'utf8'});
 assert.equal(result.status,3,result.stderr);
});

// 中文注释：tasks:ack 的拒绝条件与备份。
async function ackFixture(t,tasks){
 const home=await daemonHome();
 t.after(()=>rm(home,{recursive:true,force:true}));
 const data=path.join(home,'plugin-data','browser-link-native');
 await mkdir(data,{recursive:true,mode:0o700});
 const bytes=JSON.stringify({version:1,tasks});
 await writeFile(path.join(data,'tasks.json'),bytes,{mode:0o600});
 const ack=(...args)=>spawnSync(PYTHON,[path.join(REPO,'scripts/tasks-ack.py'),...args],{encoding:'utf8',env:{...process.env,HERMES_HOME:home,PYTHONDONTWRITEBYTECODE:'1'},timeout:60000});
 const backups=async()=>(await readdir(data)).filter(name=>name.startsWith('tasks.json.ack-'));
 return {home,data,bytes,ack,backups};
}

test('tasks:ack 备份原文件并把已关闭任务标为用户已核实',async t=>{
 const task={id:'edge-old',owner:'o',title:'旧 Edge 任务',state:'closed',cleanupState:'unknown',cleanupReason:'browser_offline',requestHistory:[]};
 const f=await ackFixture(t,[task]);
 const result=f.ack('edge-old','--reason','已在 Edge 中核对无残留');
 assert.equal(result.status,0,result.stderr);
 const [backup]=await f.backups();
 assert.ok(backup,'必须生成备份');
 assert.equal(await readFile(path.join(f.data,backup),'utf8'),f.bytes);
 assert.equal((await stat(path.join(f.data,backup))).mode&0o777,0o600);
 assert.equal((await stat(path.join(f.data,'tasks.json'))).mode&0o777,0o600);
 const [updated]=JSON.parse(await readFile(path.join(f.data,'tasks.json'),'utf8')).tasks;
 assert.equal(updated.cleanupState,'succeeded');assert.equal(updated.cleanupReason,'verified_complete');
 assert.equal(updated.userVerified.reason,'已在 Edge 中核对无残留');
 assert.equal(updated.userVerified.previousCleanupState,'unknown');
});

test('tasks:ack 拒绝未关闭、不存在、带授权、未合并日志和 daemon 运行中的情况且不写文件',async t=>{
 const cases=[
  ['running',[{id:'a',owner:'o',state:'running'}],'a'],
  ['missing',[{id:'a',owner:'o',state:'closed',cleanupState:'unknown'}],'b'],
  ['permit',[{id:'a',owner:'o',state:'closed',cleanupState:'unknown',vaultPermit:{}}],'a'],
 ];
 for(const [name,tasks,id] of cases)await t.test(name,async t=>{
  const f=await ackFixture(t,tasks);
  const result=f.ack(id);
  assert.notEqual(result.status,0);
  assert.deepEqual(await f.backups(),[]);
  assert.equal(await readFile(path.join(f.data,'tasks.json'),'utf8'),f.bytes);
 });
 await t.test('journal',async t=>{
  const f=await ackFixture(t,[{id:'a',owner:'o',state:'closed',cleanupState:'unknown'}]);
  await writeFile(path.join(f.data,'requests.jsonl'),'{}\n',{mode:0o600});
  assert.notEqual(f.ack('a').status,0);
  assert.deepEqual(await f.backups(),[]);
 });
 await t.test('daemon',async t=>{
  const f=await ackFixture(t,[{id:'a',owner:'o',state:'closed',cleanupState:'unknown',requestHistory:[]}]);
  const daemon=await startInstalledDaemon(t,f.home);
  const result=f.ack('a');
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/仍在运行|--stop-daemon/);
  assert.equal(daemon.exitCode,null);
  assert.deepEqual(await f.backups(),[]);
  // 中文注释：显式 --stop-daemon 才进入维护模式停止已核实 daemon，结束后删除标记。
  const exited=once(daemon,'exit');
  const stopped=f.ack('a','--stop-daemon');
  assert.equal(stopped.status,0,stopped.stderr);
  assert.deepEqual(await exited,[0,null]);
  assert.equal((await f.backups()).length,1);
  assert.equal(await exists(path.join(f.data,'maintenance.json')),false);
 });
});
