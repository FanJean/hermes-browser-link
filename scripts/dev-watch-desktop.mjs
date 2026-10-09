// 中文注释：开发监视只刷新共享根入口和应用级界面副本，不迁移或启用 profile。
import {installationHome,installedPluginTargets,rejectPathLinks} from './directory-swap.mjs';
import {spawnSync} from 'node:child_process';
import {watch} from 'node:fs';
import {lstat, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import path from 'node:path';

const repo=path.resolve(import.meta.dirname,'..');
const source=path.join(repo,'executor-plugin','desktop','plugin.js');
const home=await installationHome(process.env.HERMES_HOME||path.join(homedir(),'.hermes'));
const installed=path.join(home,'plugins','browser-link','desktop','plugin.js');
const desktop=path.join(home,'desktop-plugins','browser-link','plugin.js');
const markerPath=path.join(path.dirname(desktop),'.hermes-package.json');
let pending=Promise.resolve(),timer=null;

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function atomicWrite(target,bytes){
 const temporary=`${target}.dev-${randomUUID()}`;
 await writeFile(temporary,bytes);
 await rename(temporary,target);
}
async function sync(){
 await installedPluginTargets(home);
 for(const file of [installed,desktop,markerPath]){
  await rejectPathLinks(file);
  const info=await lstat(file);
  if(!info.isFile())throw Error(`安装入口不是普通文件：${file}`);
 }
 const checked=spawnSync(process.execPath,['--check',source],{encoding:'utf8',timeout:10000});
 if(checked.status!==0)throw Error(`源码语法检查失败：${checked.stderr}`);
 const bytes=await readFile(source);
 if(hash(bytes)===hash(await readFile(installed))&&hash(bytes)===hash(await readFile(desktop)))return;
 // 中文注释：写入两个已安装入口前先校验身份，单文件原子替换供 Hermes 热重载。
 const marker=JSON.parse(await readFile(markerPath,'utf8'));
 if(marker.package!=='browser-link'||marker.source!==path.dirname(installed))throw Error('桌面插件来源不匹配');
 await atomicWrite(installed,bytes);
 await atomicWrite(desktop,bytes);
 marker.sourceMtimeMs=(await stat(installed)).mtimeMs;
 await atomicWrite(markerPath,JSON.stringify(marker,null,2)+'\n');
 console.log(`已同步 Hermes 桌面插件：${new Date().toLocaleTimeString('zh-CN')}`);
}
await sync();
console.log('正在监视 executor-plugin/desktop/plugin.js；按 Ctrl+C 停止。浏览器扩展仍用 npm run dev:sync 后点击重新加载。');
const watcher=watch(path.dirname(source),(_event,filename)=>{
 if(filename&&String(filename)!=='plugin.js')return;
 if(timer)clearTimeout(timer);
 timer=setTimeout(()=>{pending=pending.then(sync).catch(error=>console.error(error.message));},200);
});
process.on('SIGINT',()=>{watcher.close();process.exit(0);});
