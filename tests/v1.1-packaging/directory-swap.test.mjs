import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {swapInstalledDirectory,rollbackDirectorySwaps,installedPluginTargets} from '../../scripts/directory-swap.mjs';

// 中文注释：验证真实目录切换时扫描根始终只有一个插件，且可以恢复原文件。
test('directory swap keeps backup outside discovery and rollback restores original',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'bridge-swap-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const registry=path.join(root,'plugins'),target=path.join(registry,'browser-link'),source=path.join(root,'source');
 await mkdir(target,{recursive:true});await mkdir(source);await writeFile(path.join(target,'plugin.js'),'old');await writeFile(path.join(source,'plugin.js'),'new');
 const swap=await swapInstalledDirectory(target,source,path.join(root,'backups'));
 assert.deepEqual(await readdir(registry),['browser-link']);assert.equal(await readFile(path.join(target,'plugin.js'),'utf8'),'new');
 assert.equal(await readFile(path.join(swap.old,'plugin.js'),'utf8'),'old');
 await rollbackDirectorySwaps([swap]);assert.equal(await readFile(path.join(target,'plugin.js'),'utf8'),'old');assert.deepEqual(await readdir(registry),['browser-link']);
});

test('transaction directories inside the registry are rejected before replacement',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'bridge-swap-reject-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=path.join(root,'plugins','bridge');await mkdir(target,{recursive:true});await writeFile(path.join(target,'plugin.js'),'old');
 await assert.rejects(swapInstalledDirectory(target,target,path.join(root,'plugins','.backup')),/outside the plugin registry/);
 assert.equal(await readFile(path.join(target,'plugin.js'),'utf8'),'old');
});

// 中文注释：枚举只返回实际安装目录，未安装和符号链接 profile 均不会被同步。
test('同步枚举覆盖根插件和已安装 profile，拒绝链接注册目录',async t=>{
 const home=await mkdtemp(path.join(tmpdir(),'bridge-targets-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const root=path.join(home,'plugins','browser-link'),named=path.join(home,'profiles','named','plugins','browser-link');
 await mkdir(root,{recursive:true});assert.deepEqual(await installedPluginTargets(home),[root]);
 await mkdir(named,{recursive:true});await mkdir(path.join(home,'profiles','empty'));
 await mkdir(path.join(home,'profiles','alias','plugins'),{recursive:true});
 await symlink(root,path.join(home,'profiles','alias','plugins','browser-link'));
 await symlink(path.join(home,'profiles','named'),path.join(home,'profiles','linked'));
 assert.deepEqual(await installedPluginTargets(home),[root,named]);
 await mkdir(path.join(home,'profiles','bad'));await symlink(path.join(home,'plugins'),path.join(home,'profiles','bad','plugins'));
 await assert.rejects(installedPluginTargets(home),/Plugin registry must be a regular directory/);
});
