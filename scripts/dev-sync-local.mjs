import {swapInstalledDirectory,rollbackDirectorySwaps,installedPluginTargets} from './directory-swap.mjs';
import {stopOldDaemon} from './dev-sync-daemon.mjs';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {cp, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';

const repo=path.resolve(import.meta.dirname,'..');
const home=path.resolve(process.env.HERMES_HOME||path.join(homedir(),'.hermes'));
const configFile=path.join(repo,'.dev-sync.local.json');
const pluginTarget=path.join(home,'plugins','browser-link');
const pluginTargets=await installedPluginTargets(home);
const desktopTarget=path.join(home,'desktop-plugins','browser-link');
const tasksFile=path.join(home,'plugin-data','browser-link-native','tasks.json');
const daemonPidFile=path.join(home,'plugin-data','browser-link-native','daemon.pid');
const activeStates=new Set(['pending_approval','authorizing','ready','running','paused']);

function digest(bytes){return createHash('sha256').update(bytes).digest('hex');}
function reloadGateway(){
 const python=path.join(home,'hermes-agent','venv','bin','python');
 const code="import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from gateway.control_socket import reload_gateway_plugins; result=reload_gateway_plugins(Path(sys.argv[2])); print('reloaded' if isinstance(result,dict) and result.get('reloaded') else 'unavailable')";
 const result=spawnSync(python,['-c',code,path.join(home,'hermes-agent'),home],{encoding:'utf8',timeout:30000});
 return result.status===0&&result.stdout.trim()==='reloaded';
}
async function regularDirectory(value,label){
 const info=await lstat(value);
 if(!info.isDirectory()||info.isSymbolicLink())throw Error(`${label} 不是普通目录：${value}`);
}
async function taskGuard(){
 const raw=JSON.parse(await readFile(tasksFile,'utf8'));
 const tasks=Array.isArray(raw)?raw:raw.tasks;
 if(!Array.isArray(tasks))throw Error('本机任务记录格式无法核实');
 const active=tasks.filter(task=>activeStates.has(task?.state));
 if(active.length)throw Error(`仍有 ${active.length} 个活动任务；请结束后再同步本机预览`);
}
async function verifyTree(root,manifest,prefix){
 for(const [relative,expected] of Object.entries(manifest)){
  if(!relative.startsWith(prefix))continue;
  const file=path.join(root,relative.slice(prefix.length));
  if(digest(await readFile(file))!==expected)throw Error(`同步后校验失败：${relative}`);
 }
}
const config=JSON.parse(await readFile(configFile,'utf8'));
const extensionTarget=typeof config.extensionDir==='string'?path.resolve(config.extensionDir):'';
if(!extensionTarget||!path.isAbsolute(config.extensionDir)||
   !extensionTarget.startsWith(path.join(home,'browser-link-releases')+path.sep)){
 throw Error('本机配置的扩展目录必须是 ~/.hermes/browser-link-releases 下的绝对路径');
}
await Promise.all([
 ...pluginTargets.map(target=>regularDirectory(target,'Hermes 插件')),
 regularDirectory(desktopTarget,'桌面插件副本'),
 regularDirectory(extensionTarget,'浏览器扩展'),
 taskGuard(),
]);
const installedManifest=JSON.parse(await readFile(path.join(extensionTarget,'manifest.json'),'utf8'));
const sourceManifest=JSON.parse(await readFile(path.join(repo,'native-extension','manifest.json'),'utf8'));
// 中文注释：--allow-upgrade 只放行同名扩展的版本升级（源码版本更高），不允许降级或换扩展。
const semver=value=>String(value).split('.').map(Number);
const newer=(a,b)=>{const x=semver(a),y=semver(b);for(let i=0;i<Math.max(x.length,y.length);i++){if((x[i]||0)!==(y[i]||0))return (x[i]||0)>(y[i]||0);}return false;};
const upgrade=process.argv.includes('--allow-upgrade')&&newer(sourceManifest.version,installedManifest.version);
if(installedManifest.name!==sourceManifest.name||installedManifest.version!==sourceManifest.version&&!upgrade)
 throw Error('安装扩展身份或版本与源码不一致，拒绝覆盖（版本升级请加 --allow-upgrade）');

const scratch=await mkdtemp(path.join(tmpdir(),'hermes-browser-dev-sync-'));
const output=path.join(scratch,'package');
const built=spawnSync(process.execPath,[path.join(repo,'scripts','package-executor.mjs'),'--output',output],
 {cwd:repo,encoding:'utf8',timeout:120000});
if(built.status!==0){await rm(scratch,{recursive:true,force:true});throw Error(`打包失败：${built.stderr||built.stdout}`);}
const packageHashes=JSON.parse(await readFile(path.join(output,'SHA256SUMS.json'),'utf8'));
const token=`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`;
const backup=path.join(home,'plugin-backups',`.browser-link-dev-tmp-${token}`);
const swaps=[];
let daemonStopped=false;
let gatewayReloaded=false;
try{
 await mkdir(backup,{recursive:true});
 // 中文注释：先完整备份三个已安装目录，任何校验失败都保留原始副本。
 for(const [index,target] of pluginTargets.entries())await cp(target,path.join(backup,`plugin-${index}`),{recursive:true});
 await cp(extensionTarget,path.join(backup,'extension'),{recursive:true});
 await cp(desktopTarget,path.join(backup,'desktop'),{recursive:true});
 // 中文注释：根插件和已安装 profile 副本使用同一个校验过的包，并共同参与回滚。
 for(const target of pluginTargets)swaps.push(await swapInstalledDirectory(target,path.join(output,'browser-link'),path.join(backup,'swaps')));
 swaps.push(await swapInstalledDirectory(extensionTarget,path.join(output,'native-extension'),path.join(backup,'swaps')));
 for(const target of pluginTargets)await verifyTree(target,packageHashes,'browser-link/');
 await verifyTree(extensionTarget,packageHashes,'native-extension/');
 // 中文注释：Hermes 桌面只监视 materialized 副本，更新入口文件会触发热重载。
 const desktopSource=path.join(pluginTarget,'desktop','plugin.js');
 const entry=path.join(desktopTarget,'plugin.js');
 const markerPath=path.join(desktopTarget,'.hermes-package.json');
 const marker=JSON.parse(await readFile(markerPath,'utf8'));
 if(marker.package!=='browser-link')throw Error('桌面插件副本标记不匹配');
 const temporary=`${entry}.dev-${token}`;
 await cp(desktopSource,temporary);
 await rename(temporary,entry);
 marker.source=path.join(pluginTarget,'desktop');
 marker.sourceMtimeMs=(await stat(desktopSource)).mtimeMs;
 await writeFile(`${markerPath}.dev-${token}`,JSON.stringify(marker,null,2)+'\n');
 await rename(`${markerPath}.dev-${token}`,markerPath);
 if(digest(await readFile(entry))!==digest(await readFile(desktopSource)))throw Error('桌面插件副本校验失败');
 daemonStopped=await stopOldDaemon(daemonPidFile,home);
 gatewayReloaded=reloadGateway();
}catch(error){
 // 中文注释：同步失败时恢复插件、扩展和桌面入口，备份目录仍保留供人工核对。
 if(swaps.length)await rollbackDirectorySwaps(swaps);
 if(swaps.length){
  await cp(path.join(backup,'desktop','plugin.js'),path.join(desktopTarget,'plugin.js'),{force:true});
  await cp(path.join(backup,'desktop','.hermes-package.json'),path.join(desktopTarget,'.hermes-package.json'),{force:true});
 }
 throw error;
}finally{
 await rm(scratch,{recursive:true,force:true});
}
for(const {old} of swaps)await rm(old,{recursive:true,force:true});
// 中文注释：本机预览只需要事务期间的备份；成功后清除，失败时保留供恢复。
await rm(backup,{recursive:true,force:true});
console.log(JSON.stringify({status:'synced',version:sourceManifest.version,pluginCopies:pluginTargets.length,temporaryBackupRemoved:true,daemonStopped,gatewayReloaded,desktopHotReload:true,
 browserAction:'在 Chrome 与 Edge 的扩展管理页分别点击 Hermes Browser Link的重新加载',
 backendNote:'dashboard/plugin_api.py 改动需要重启 Hermes 桌面应用'},null,2));
