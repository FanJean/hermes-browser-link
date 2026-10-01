import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {cp,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {stopOldDaemon} from '../../scripts/dev-sync-daemon.mjs';

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
 await assert.rejects(stopOldDaemon(pidFile,home),/身份|核对|手动/);
 assert.equal(child.exitCode,null);
 assert.equal(child.signalCode,null);
});

test('dev-sync 只停止认证套接字及启动命令均匹配的 daemon',async t=>{
 const home=await mkdtemp(path.join(tmpdir(),'dev-sync-live-'));
 const pidFile=path.join(home,'plugin-data','browser-link-native','daemon.pid');
 const daemonScript=path.join(home,'plugins/browser-link/native_bridge/daemon.py');
 await mkdir(path.dirname(daemonScript),{recursive:true});
 await cp(path.resolve('native-bridge'),path.dirname(daemonScript),{recursive:true});
 const daemon=spawn('python3',[daemonScript,'--home',home],{stdio:'ignore'});
 t.after(async()=>{
  if(daemon.exitCode===null&&daemon.signalCode===null){daemon.kill('SIGKILL');await once(daemon,'exit');}
  await rm(home,{recursive:true,force:true});
 });
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
 await assert.rejects(stopOldDaemon(pidFile,home),/不是本项目当前 home 的 daemon/);
 assert.equal(unrelated.exitCode,null);
 assert.equal(daemon.exitCode,null);
 await writeFile(pidFile,String(daemon.pid),{mode:0o600});
 assert.equal(await stopOldDaemon(pidFile,home),true);
 if(daemon.exitCode===null&&daemon.signalCode===null)await once(daemon,'exit');
});
