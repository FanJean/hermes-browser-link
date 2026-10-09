// 中文注释：同步已安装程序和界面；身份、任务与全部目标预检必须先于写入。
import {swapInstalledDirectory,rollbackDirectorySwaps,installedPluginTargets,installationHome,rejectPathLinks} from './directory-swap.mjs';
import {runDevelopmentGuard,assertDevelopmentIdle,runMaintenanceStep,waitForTasks,hermesControl} from './dev-sync-daemon.mjs';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';

const repo=path.resolve(import.meta.dirname,'..');
const home=await installationHome(process.env.HERMES_HOME||path.join(homedir(),'.hermes'));
const configFile=path.join(repo,'.dev-sync.local.json');
const pluginTarget=path.join(home,'plugins','browser-link');
const pluginTargets=await installedPluginTargets(home);
const desktopTarget=path.join(home,'desktop-plugins','browser-link');
const tasksFile=path.join(home,'plugin-data','browser-link-native','tasks.json');
const daemonPidFile=path.join(home,'plugin-data','browser-link-native','daemon.pid');
function digest(bytes){return createHash('sha256').update(bytes).digest('hex');}
function reloadGateway(){
 const python=path.join(home,'hermes-agent','venv','bin','python');
 const code="import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from gateway.control_socket import reload_gateway_plugins; result=reload_gateway_plugins(Path(sys.argv[2])); print('reloaded' if isinstance(result,dict) and result.get('reloaded') else 'unavailable')";
 const result=spawnSync(python,['-c',code,path.join(home,'hermes-agent'),home],{encoding:'utf8',timeout:30000});
 return result.status===0&&result.stdout.trim()==='reloaded';
}
async function regularDirectory(value,label){
 await rejectPathLinks(value);
 const info=await lstat(value);
 if(!info.isDirectory()||info.isSymbolicLink())throw Error(`${label} 不是普通目录：${value}`);
}
async function verifyTree(root,manifest,prefix){
 for(const [relative,expected] of Object.entries(manifest)){
  if(!relative.startsWith(prefix))continue;
  const file=path.join(root,relative.slice(prefix.length));
  if(digest(await readFile(file))!==expected)throw Error(`同步后校验失败：${relative}`);
 }
}
const config=JSON.parse(await readFile(configFile,'utf8'));
if(typeof config.extensionDir==='string')await rejectPathLinks(config.extensionDir);
const extensionTarget=typeof config.extensionDir==='string'?path.resolve(config.extensionDir):'';
if(!extensionTarget||!path.isAbsolute(config.extensionDir)||
   !extensionTarget.startsWith(path.join(home,'browser-link-releases')+path.sep)){
 throw Error('本机配置的扩展目录必须是 ~/.hermes/browser-link-releases 下的绝对路径');
}
const desktopEntry=path.join(desktopTarget,'plugin.js');
const desktopMarkerPath=path.join(desktopTarget,'.hermes-package.json');
await Promise.all([tasksFile,daemonPidFile,path.join(home,'plugin-backups'),desktopEntry,desktopMarkerPath,path.join(extensionTarget,'manifest.json')].map(rejectPathLinks));
await Promise.all([
 ...pluginTargets.map(target=>regularDirectory(target,'Hermes 插件')),
 regularDirectory(desktopTarget,'桌面插件副本'),
 regularDirectory(extensionTarget,'浏览器扩展'),
]);
// 中文注释：根程序、扩展、桌面入口及身份全部核实后才允许首次目标写入。
for(const file of [desktopEntry,desktopMarkerPath]){
 if(!(await lstat(file)).isFile())throw Error(`安装入口不是普通文件：${file}`);
}
const desktopMarker=JSON.parse(await readFile(desktopMarkerPath,'utf8'));
// 中文注释：共享安装后 Desktop 可能记录某个命名 profile 的链接路径；只要真实路径就是根程序的 desktop 目录即视为同一来源。
const sameDesktopSource=async source=>{
 if(typeof source!=='string'||!path.isAbsolute(source))return false;
 if(source===path.join(pluginTarget,'desktop'))return true;
 try{return await realpath(source)===await realpath(path.join(pluginTarget,'desktop'));}catch{return false;}
};
if(desktopMarker.package!=='browser-link'||!await sameDesktopSource(desktopMarker.source))throw Error('桌面插件来源不匹配');
const installedManifest=JSON.parse(await readFile(path.join(extensionTarget,'manifest.json'),'utf8'));
const sourceManifest=JSON.parse(await readFile(path.join(repo,'native-extension','manifest.json'),'utf8'));
// 中文注释：--allow-upgrade 只放行同名扩展的版本升级（源码版本更高），不允许降级或换扩展。
const semver=value=>String(value).split('.').map(Number);
const newer=(a,b)=>{const x=semver(a),y=semver(b);for(let i=0;i<Math.max(x.length,y.length);i++){if((x[i]||0)!==(y[i]||0))return (x[i]||0)>(y[i]||0);}return false;};
const upgrade=process.argv.includes('--allow-upgrade')&&newer(sourceManifest.version,installedManifest.version);
if(installedManifest.name!==sourceManifest.name||installedManifest.version!==sourceManifest.version&&!upgrade)
 throw Error('安装扩展身份或版本与源码不一致，拒绝覆盖（版本升级请加 --allow-upgrade）');
if(process.env.BROWSER_LINK_DEV_GUARDED!=='1'){
 // 中文注释：一条命令完成部署：暂停 Hermes 新工作、等任务收尾、写维护标记、停止已核实的 daemon，
 // 在正式守卫内同步，最后删除标记并恢复原暂停状态。任何一步失败都不结束任务、不给未知进程发信号。
 const option=name=>{const index=process.argv.indexOf(name);return index>0?process.argv[index+1]:undefined;};
 const waitSeconds=Number(option('--wait-seconds')??process.env.BROWSER_LINK_DEV_SYNC_WAIT_SECONDS??300);
 if(!Number.isFinite(waitSeconds)||waitSeconds<0||waitSeconds>3600)throw Error('--wait-seconds 必须是 0 到 3600 之间的秒数');
 const hermes=hermesControl();
 let token=null,paused=false,cleaned=false;
 const cleanup=()=>{
  if(cleaned)return [];cleaned=true;
  const errors=[];
  if(token){try{runMaintenanceStep(home,repo,'leave',[token]);}catch(error){errors.push(error.message);}}
  if(paused){try{hermes.resume();}catch(error){errors.push(error.message);}}
  return errors;
 };
 for(const name of ['SIGINT','SIGTERM','SIGHUP'])process.on(name,()=>{
  const errors=cleanup();
  console.error(['同步已中断；维护标记已删除，Hermes 暂停状态已还原。',...errors].join('\n'));
  process.exit(130);
 });
 let output,daemonStopped=false,failure=null;
 try{
  hermes.pause('browser-link dev:sync');paused=true;
  await waitForTasks(tasksFile,{timeoutMs:waitSeconds*1000});
  token=runMaintenanceStep(home,repo,'enter',['browser-link dev:sync',process.pid]);
  daemonStopped=runMaintenanceStep(home,repo,'stop',[30]);
  runMaintenanceStep(home,repo,'cloud',[30]);
  assertDevelopmentIdle(home,repo);
  const result=runDevelopmentGuard(home,repo,[process.execPath,import.meta.filename,...process.argv.slice(2)]);
  if(result.status!==0)throw Error(result.stderr||'同步保护进程未完成');
  output=JSON.parse(result.stdout);
 }catch(error){failure=error;}
 const errors=cleanup();
 if(failure){
  if(errors.length)failure.message+=`\n收尾问题：${errors.join('；')}`;
  throw failure;
 }
 if(errors.length)throw Error(`同步已完成，但收尾未完成：${errors.join('；')}`);
 output.daemonStopped=daemonStopped;
 output.hermesPausedBefore=hermes.wasPaused;
 output.gatewayReloaded=reloadGateway();
 console.log(JSON.stringify(output,null,2));
 process.exit(0);
}
assertDevelopmentIdle(home,repo);

const scratch=await mkdtemp(path.join(tmpdir(),'hermes-browser-dev-sync-'));
const output=path.join(scratch,'package');
const built=spawnSync(process.execPath,[path.join(repo,'scripts','package-executor.mjs'),'--output',output],
 {cwd:repo,encoding:'utf8',timeout:120000});
if(built.status!==0){await rm(scratch,{recursive:true,force:true});throw Error(`打包失败：${built.stderr||built.stdout}`);}
const packageHashes=JSON.parse(await readFile(path.join(output,'SHA256SUMS.json'),'utf8'));
const token=`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`;
const backup=path.join(home,'plugin-backups',`.browser-link-dev-tmp-${token}`);
const swaps=[];
const installStatePath=path.join(home,'plugin-data/browser-link-native/install-state.json');
let installStateBytes;
try{
 assertDevelopmentIdle(home,repo);
 installStateBytes=await readFile(installStatePath);
 await mkdir(backup,{recursive:true});
 // 中文注释：先完整备份三个已安装目录，任何校验失败都保留原始副本。
 for(const [index,target] of pluginTargets.entries())await cp(target,path.join(backup,`plugin-${index}`),{recursive:true});
 await cp(extensionTarget,path.join(backup,'extension'),{recursive:true});
 await cp(desktopTarget,path.join(backup,'desktop'),{recursive:true});
 // 中文注释：开发同步只替换共享根一次，命名 profile 引用保持原 readlink。
 for(const target of pluginTargets)swaps.push(await swapInstalledDirectory(target,path.join(output,'browser-link'),path.join(backup,'swaps')));
 swaps.push(await swapInstalledDirectory(extensionTarget,path.join(output,'native-extension'),path.join(backup,'swaps')));
 for(const target of pluginTargets)await verifyTree(target,packageHashes,'browser-link/');
 await verifyTree(extensionTarget,packageHashes,'native-extension/');
 // 中文注释：Hermes 桌面只监视 materialized 副本，更新入口文件会触发热重载。
 const desktopSource=path.join(pluginTarget,'desktop','plugin.js');
 const entry=desktopEntry;
 const markerPath=desktopMarkerPath;
 const marker=desktopMarker;
 const temporary=`${entry}.dev-${token}`;
 await cp(desktopSource,temporary);
 await rename(temporary,entry);
 marker.source=path.join(pluginTarget,'desktop');
 marker.sourceMtimeMs=(await stat(desktopSource)).mtimeMs;
 await writeFile(`${markerPath}.dev-${token}`,JSON.stringify(marker,null,2)+'\n');
 await rename(`${markerPath}.dev-${token}`,markerPath);
 if(digest(await readFile(entry))!==digest(await readFile(desktopSource)))throw Error('桌面插件副本校验失败');
 const installState=JSON.parse(installStateBytes);
 installState.cloudFence={version:1,hostSha256:packageHashes['browser-link/cloud_link/native_host.py'],
  installerSha256:packageHashes['browser-link/maintenance/install-cli.py']};
 if(!installState.cloudFence.hostSha256||!installState.cloudFence.installerSha256)throw Error('同步包缺少云端升级保护');
 await writeFile(`${installStatePath}.dev-${token}`,JSON.stringify(installState)+'\n',{mode:0o600});
 await rename(`${installStatePath}.dev-${token}`,installStatePath);
}catch(error){
 // 中文注释：同步失败时恢复插件、扩展和桌面入口，备份目录仍保留供人工核对。
 if(swaps.length)await rollbackDirectorySwaps(swaps);
 if(swaps.length){
  await writeFile(installStatePath,installStateBytes,{mode:0o600});
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
console.log(JSON.stringify({status:'synced',version:sourceManifest.version,pluginCopies:pluginTargets.length,temporaryBackupRemoved:true,desktopHotReload:true,
 browserAction:'扩展在下次连接本地桥时（约 30 秒内）检测到新构建并自动重新加载一次',
 backendNote:'dashboard/plugin_api.py 改动需要重启 Hermes 桌面应用'},null,2));
