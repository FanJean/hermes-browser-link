import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {swapInstalledDirectory,rollbackDirectorySwaps} from '../../scripts/directory-swap.mjs';

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
