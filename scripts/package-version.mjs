import {readFile} from 'node:fs/promises';
import path from 'node:path';

// 中文注释：构建、打包共用版本闭包，禁止桌面元数据或锁文件与插件、扩展分叉。
export async function verifyPackageVersions(source){
 const json=async file=>JSON.parse(await readFile(path.join(source,file),'utf8'));
 const [pkg,lock,desktop,extension,cloud,cloudLock,plugin,background]=await Promise.all([
  json('package.json'),json('package-lock.json'),json('executor-plugin/dashboard/manifest.json'),json('native-extension/manifest.json'),json('cloud-link/site/package.json'),json('cloud-link/site/package-lock.json'),
  readFile(path.join(source,'executor-plugin/plugin.yaml'),'utf8'),readFile(path.join(source,'native-extension/background.mjs'),'utf8'),
 ]);
 const version=pkg.version,handshakes=[...background.matchAll(/\bversion:\s*['"]([^'"]+)['"]/g)].map(match=>match[1]);
 const versions=[lock.version,lock.packages?.['']?.version,desktop.version,extension.version,cloud.version,cloudLock.version,cloudLock.packages?.['']?.version,/^version:\s*(\S+)/m.exec(plugin)?.[1],...handshakes];
 if(!/^\d+\.\d+\.\d+$/.test(version)||handshakes.length!==2||versions.some(value=>value!==version))throw Error('Package versions must match');
 return version;
}
