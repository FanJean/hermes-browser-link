// 中文注释：已安装目录被开发同步替换后，磁盘上的 BUILD-DEPS.json 与本次加载的构建哈希不一致；
// 连接本地桥前比对一次，不一致就重载扩展。同一已安装哈希只重载一次，避免文件不完整时循环重载。
const BUILD_PATTERN=/^[a-f0-9]{64}$/;
export const RELOAD_KEY='reloadedForBuild';

export async function reloadForInstalledBuild({chrome,fetch,loadedBuildId}){
 if(!BUILD_PATTERN.test(loadedBuildId||''))return false;
 let installed;
 try{
  const response=await fetch(chrome.runtime.getURL('BUILD-DEPS.json'),{cache:'no-store'});
  if(!response.ok)return false;
  installed=(await response.json())?.buildId;
 }catch{return false;}
 if(typeof installed!=='string'||!BUILD_PATTERN.test(installed)||installed===loadedBuildId)return false;
 const stored=await chrome.storage.local.get(RELOAD_KEY);
 if(stored?.[RELOAD_KEY]===installed)return false;
 await chrome.storage.local.set({[RELOAD_KEY]:installed});
 chrome.runtime.reload();
 return true;
}
