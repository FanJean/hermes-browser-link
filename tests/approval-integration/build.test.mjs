import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'../..');
test('native build is offline closed over the approval policy',async()=>{
 const folder=await mkdtemp(path.join(homedir(),'.hermes/cache/scratch/approval-closure-'));
 try{
  execFileSync(process.execPath,[path.join(root,'native-extension/build.mjs'),folder]);
  const deps=JSON.parse(await readFile(path.join(folder,'BUILD-DEPS.json'),'utf8'));
  assert.equal(deps.dependencies['vendor/approval-policy.mjs'].source,'approval-policy/policy.mjs');
  for(const [file,meta] of Object.entries(deps.dependencies)){
   assert.equal(createHash('sha256').update(await readFile(path.join(folder,file))).digest('hex'),meta.sha256);
  }
  const imported=await import(pathToFileURL(path.join(folder,'core.mjs')));
  assert.equal(typeof imported.Executor,'function');
  const core=await readFile(path.join(folder,'core.mjs'),'utf8');assert.ok(!core.includes("from '../"));
 }finally{await rm(folder,{recursive:true,force:true});}
});
