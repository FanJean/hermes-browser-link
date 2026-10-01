// 中文注释：真实页面验收共享启动器；只使用本轮临时 profile，保持真实 HOME，不读取个人浏览器数据。
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {CdpClient,waitFor,fetchJson} from '../native-v2/cdp-client.mjs';
export async function openPageBrowser(url,{browser='chrome',headed=false}={}){
 const binary=browser==='edge'?'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const work=await mkdtemp('/private/tmp/hermes-audit-'),profile=path.join(work,'profile'),temp=path.join(work,'tmp');await mkdir(temp);
 const browserEnv={HOME:process.env.HOME,HERMES_HOME:path.join(work,'hermes'),TMPDIR:temp,PATH:process.env.PATH||'/usr/bin:/bin:/usr/sbin:/sbin',LANG:process.env.LANG||'en_US.UTF-8'};
 const proc=spawn(binary,[...(headed?[]:['--headless=new']),'--use-mock-keychain','--password-store=basic',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--site-per-process','--no-first-run','--no-default-browser-check','--no-proxy-server',url],{env:browserEnv,stdio:'ignore',detached:true});
 let client;
 const close=async()=>{client?.close();if(proc.exitCode===null){proc.kill('SIGTERM');await new Promise(resolve=>setTimeout(resolve,300));if(proc.exitCode===null)proc.kill('SIGKILL');}await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:200});};
 try{
  const port=await waitFor(async()=>(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0],15000);
  const base=`http://127.0.0.1:${port}`,target=await waitFor(async()=>(await fetchJson(base+'/json/list')).find(row=>row.url===url));
  client=new CdpClient(target.webSocketDebuggerUrl);await client.connect();
  return {client,base,work,close,version:await fetchJson(base+'/json/version')};
 }catch(error){await close();throw error;}
}
