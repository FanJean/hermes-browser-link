import {spawnSync} from 'node:child_process';
import {lstat,readFile} from 'node:fs/promises';
import net from 'node:net';
import readline from 'node:readline';
import path from 'node:path';

async function privateFile(file){
 const info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077)!==0)
  throw Error(`身份文件不安全：${file}`);
 return readFile(file,'utf8');
}

async function authenticatedHealth(dataDir){
 const token=(await privateFile(path.join(dataDir,'token'))).trim();
 if(!token)throw Error('守护进程令牌为空');
 const socket=net.createConnection(path.join(dataDir,'bridge.sock'));
 socket.on('error',()=>{});
 socket.setTimeout(1000,()=>socket.destroy(Error('守护进程身份查询超时')));
 try{
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  const lines=readline.createInterface({input:socket,crlfDelay:Infinity})[Symbol.asyncIterator]();
  socket.write(JSON.stringify({role:'client',token})+'\n');
  socket.write(JSON.stringify({id:'dev-sync-health',method:'health',params:{}})+'\n');
  const line=await lines.next();
  if(line.done||JSON.stringify(JSON.parse(line.value))!==JSON.stringify({id:'dev-sync-health',result:{ok:true,protocolVersion:1}}))
   throw Error('守护进程认证响应无效');
 }finally{
  socket.destroy();
 }
}

export async function stopOldDaemon(daemonPidFile,home,daemonCandidates=null){
 const raw=(await privateFile(daemonPidFile)).trim();
 const pid=Number(raw);
 if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(pid))throw Error('守护进程 PID 无效，请人工核对');
 const dataDir=path.dirname(daemonPidFile);
 try{
  await authenticatedHealth(dataDir);
  // 中文注释：旧 PID 文件只含数字；必须同时核对认证套接字、可执行脚本路径和 home 参数。
  const command=spawnSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8',timeout:1000});
  // 中文注释：迁移调用者可传入已核实的旧安装脚本路径，认证检查保持不变。
  const candidates=daemonCandidates??[path.join(home,'plugins/browser-link/native_bridge/daemon.py'),
   path.join(dataDir,'host-bin/daemon.py')];
  const expected=candidates.some(candidate=>command.stdout?.trim().endsWith(` ${candidate} --home ${path.resolve(home)}`));
  if(command.status!==0||!expected)throw Error('PID 对应进程不是本项目当前 home 的 daemon');
  if((await privateFile(daemonPidFile)).trim()!==raw)throw Error('PID 文件在核对期间发生变化');
 }catch(error){
  throw Error(`无法核对旧桥接进程身份，未发信号；请手动重启：${error.message}`);
 }
 process.kill(pid,'SIGTERM');
 for(let i=0;i<60;i++){
  await new Promise(resolve=>setTimeout(resolve,50));
  try{
   if((await readFile(daemonPidFile,'utf8')).trim()!==raw)return true;
  }catch(error){if(error.code==='ENOENT')return true;throw error;}
 }
 throw Error('旧桥接进程未在 3 秒内退出，请人工核对');
}
