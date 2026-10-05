// 中文注释：暂存与旧目录都放在扫描目录之外，避免被 Hermes 识别为重复插件。
import {cp,lstat,mkdir,readdir,realpath,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export async function swapInstalledDirectory(target,source,transactionRoot){
 const info=await lstat(target);
 if(!info.isDirectory()||info.isSymbolicLink())throw Error('Installation target must be a regular directory');
 await mkdir(transactionRoot,{recursive:true,mode:0o700});
 const registry=await realpath(path.dirname(target)),root=await realpath(transactionRoot);
 const relative=path.relative(registry,root);
 if(!relative||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('Transaction directory must be outside the plugin registry');
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

// 中文注释：只同步已经安装的命名 profile 副本，不为未安装插件的 profile 创建目录。
export async function installedPluginTargets(home){
 const targets=[path.join(home,'plugins','browser-link')];
 const profiles=path.join(home,'profiles');
 if(!(await readdir(home)).includes('profiles'))return targets;
 const info=await lstat(profiles);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Profiles must be a regular directory');
 for(const entry of await readdir(profiles,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink())continue;
  const plugins=path.join(profiles,entry.name,'plugins');
  if(!(await readdir(path.dirname(plugins))).includes('plugins'))continue;
  const registry=await lstat(plugins);if(!registry.isDirectory()||registry.isSymbolicLink())throw Error('Plugin registry must be a regular directory');
  if((await readdir(plugins)).includes('browser-link')){
   const target=path.join(plugins,'browser-link'),installed=await lstat(target);
   // 中文注释：已指向根插件的 profile 链接随根目录同步，无需替换；未知链接仍拒绝。
   if(installed.isSymbolicLink()){
    if(await realpath(target)!==await realpath(targets[0]))throw Error('Plugin link must point to the root installation');
   }else targets.push(target);
  }
 }
 return targets;
}
