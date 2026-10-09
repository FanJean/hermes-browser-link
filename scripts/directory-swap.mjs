// 中文注释：暂存与旧目录都放在扫描目录之外，避免被 Hermes 识别为重复插件。
import {cp,lstat,mkdir,readdir,readlink,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// 中文注释：先检查原始路径的每一段，再做词法规范化，避免 link/.. 隐藏祖先链接。
export async function rejectPathLinks(value){
 const raw=path.isAbsolute(value)?value:`${process.cwd()}${path.sep}${value}`;
 let current=path.parse(raw).root;
 for(const segment of raw.slice(current.length).split(path.sep)){
  if(!segment||segment==='.')continue;
  current=path.join(current,segment);
  let info;
  try{info=await lstat(current);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(info.isSymbolicLink())throw Error(`Installation path contains a link: ${current}`);
 }
}

// 中文注释：profile-shaped HERMES_HOME 与正式安装一致，但不能先 realpath 隐藏链接。
export async function installationHome(value){
 await rejectPathLinks(value);
 const home=path.resolve(value);
 return path.basename(path.dirname(home))==='profiles'?path.dirname(path.dirname(home)):home;
}

export async function swapInstalledDirectory(target,source,transactionRoot){
 await rejectPathLinks(target);
 await rejectPathLinks(transactionRoot);
 const info=await lstat(target);
 if(!info.isDirectory()||info.isSymbolicLink())throw Error('Installation target must be a regular directory');
 const registry=path.resolve(path.dirname(target)),root=path.resolve(transactionRoot);
 const relative=path.relative(registry,root);
 if(!relative||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('Transaction directory must be outside the plugin registry');
 await mkdir(root,{recursive:true,mode:0o700});
 const token=randomUUID(),stage=path.join(root,`stage-${token}`),old=path.join(root,`previous-${token}`);
 await cp(source,stage,{recursive:true,errorOnExist:true,force:false});
 try{
  await rename(target,old);
  try{await rename(stage,target);}catch(error){await rename(old,target);throw error;}
 }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
 return {target,old};
}

export async function rollbackDirectorySwaps(swaps){
 for(const {target,old} of [...swaps].reverse()){
  const failed=path.join(path.dirname(old),`failed-${randomUUID()}`);
  await rename(target,failed);
  try{await rename(old,target);}catch(error){await rename(failed,target);throw error;}
  await rm(failed,{recursive:true,force:true});
 }
}

// 中文注释：只更新共享根；profile 必须已经是直接引用，开发同步不迁移或启用。
export async function installedPluginTargets(home){
 await rejectPathLinks(home);
 const targets=[path.join(home,'plugins','browser-link')];
 await rejectPathLinks(targets[0]);
 if(!(await lstat(targets[0])).isDirectory())throw Error('Root installation must be a regular directory');
 const profiles=path.join(home,'profiles');
 if(!(await readdir(home)).includes('profiles'))return targets;
 const info=await lstat(profiles);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Profiles must be a regular directory');
 for(const entry of await readdir(profiles,{withFileTypes:true})){
  if(entry.isSymbolicLink())throw Error('Profile ancestor must not be a link');
  if(!entry.isDirectory())continue;
  const plugins=path.join(profiles,entry.name,'plugins');
  if(!(await readdir(path.dirname(plugins))).includes('plugins'))continue;
  const registry=await lstat(plugins);if(!registry.isDirectory()||registry.isSymbolicLink())throw Error('Plugin registry must be a regular directory');
  if((await readdir(plugins)).includes('browser-link')){
   const target=path.join(plugins,'browser-link'),installed=await lstat(target);
   // 中文注释：已指向根插件的 profile 链接随根目录同步，无需替换；未知链接仍拒绝。
   if(installed.isSymbolicLink()){
    const destination=await readlink(target);
    const raw=path.isAbsolute(destination)?destination:`${path.dirname(target)}${path.sep}${destination}`;
    await rejectPathLinks(raw);
    if(path.resolve(raw)!==targets[0])throw Error('Plugin link must point directly to the root installation');
   }else throw Error('旧 profile 插件副本尚未迁移；请先运行 ./install.sh --upgrade');
  }
 }
 return targets;
}
