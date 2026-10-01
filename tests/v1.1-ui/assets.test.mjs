import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const path=new URL('../../native-extension/',import.meta.url);
test('panel is a self-contained extension page with no inline approval authority',async()=>{
 const html=await readFile(new URL('approval-panel.html',path),'utf8');
 const css=await readFile(new URL('approval-panel.css',path),'utf8');
 assert.match(html,/<script type="module" src="approval-panel.mjs"><\/script>/);
 assert.match(html,/id="app"/);assert.doesNotMatch(html,/onclick=|<iframe|https?:\/\//);
 assert.match(css,/max-width:\s*420px/);assert.match(css,/:focus-visible/);
});
test('manifest keeps approval page private and overlay injection disabled',async()=>{
 const manifest=JSON.parse(await readFile(new URL('manifest.json',path),'utf8'));
 assert(manifest.permissions.includes('tabs'));
 assert(!manifest.permissions.includes('scripting'));
 assert(!manifest.web_accessible_resources?.some(group=>group.resources?.includes('approval-panel.html')));
});
