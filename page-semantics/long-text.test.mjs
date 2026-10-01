import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from './index.js';

function fixture(html, limits = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {url: 'https://example.test/'});
  const {document} = dom.window;
  dom.window.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  const semantics = createPageSemantics({document, taskId:'task',documentId:'doc',leaseId:'lease', ...limits});
  return {document, semantics, close: () => {semantics.revoke();dom.window.close();}};
}

function pages(semantics, options = {}) {
  const result = [];
  let cursor = null;
  for (let i=0; i<100; i++) {
    const page = semantics.snapshot({...options, cursor});
    result.push(page);
    if (!page.nextCursor) return result;
    cursor = page.nextCursor;
  }
  throw Error('pagination did not terminate');
}

test('long content is recoverable through existing cursor and bounded fragments', () => {
  const text = `Beginning ${'αβ'.repeat(1600)} Ending`;
  const f = fixture(`<p>${text}</p>`);
  try {
    const result = pages(f.semantics, {mode:'content', budget:750});
    const pieces = result.flatMap(p=>p.items);
    assert.ok(result.length>1);
    assert.equal(pieces.map(x=>x.name).join(''), text);
    assert.ok(pieces.every(x=>x.fragment && x.fragment.field==='name'));
    assert.ok(pieces.every(x=>x.name.length<=400));
    assert.ok(result.every(x=>Math.ceil(JSON.stringify(x).length/4)<=750));
    assert.ok(result.every(x=>x.coverage.complete===false));
    assert.equal(result.at(-1).nextCursor, null);
  } finally { f.close(); }
});

test('secret spanning a fragment boundary is redacted before splitting', () => {
  const secret = 'password=NEVER_EXPOSE_THIS_VALUE';
  const f = fixture(`<p>${'a'.repeat(390)} ${secret} ${'z'.repeat(850)}</p>`, {maxText:400});
  try {
    const result = pages(f.semantics, {mode:'content',budget:900});
    const all=JSON.stringify(result);
    assert.ok(!all.includes('NEVER_EXPOSE_THIS_VALUE'));
    assert.ok(!all.includes(secret));
    assert.ok(result.flatMap(x=>x.items).map(x=>x.name).join('').includes('password=[redacted]'));
  } finally {f.close();}
});

test('a mutation invalidates a long-text continuation instead of appending stale fragments', () => {
  const f=fixture(`<p>${'A'.repeat(1100)}</p>`,{maxItems:1});
  try {
    const a=f.semantics.snapshot({mode:'content'});
    assert.ok(a.nextCursor);
    f.document.querySelector('p').textContent='B'.repeat(1100);
    const b=f.semantics.snapshot({mode:'content',cursor:a.nextCursor});
    assert.equal(b.resync.reason,'cursor_invalidated');
    assert.equal(b.items[0].fragment.start,0);
    assert.ok(b.items[0].name.startsWith('B'));
  } finally {f.close();}
});

test('too-small budget never emits a cursor that cannot advance', () => {
  const f=fixture(`<p>${'Q'.repeat(6000)}</p>`,{maxText:2000});
  try {
    const a=f.semantics.snapshot({mode:'content',budget:512});
    assert.equal(a.items.length,0);
    assert.equal(a.nextCursor,null);
    assert.equal(a.coverage.complete,false);
  } finally {f.close();}
});

test('interactive text remains clipped and action ref still resolves exact element', () => {
  const f=fixture(`<button id="a">${'Q'.repeat(1000)}</button><button id="b">Save</button>`);
  try {
    const a=f.semantics.snapshot();
    assert.equal(a.items[0].name.length,400);
    assert.equal(a.items[0].fragment,undefined);
    assert.equal(a.items[0].truncated,true);
    assert.equal(f.semantics.resolve({...a.binding,snapshotId:a.snapshotId,ref:a.items[1].ref}).id,'b');
  } finally {f.close();}
});

test('fragment ref resolves the same node and rejects a changed text value', () => {
  const f=fixture(`<p id="target">${'R'.repeat(1000)}</p>`);
  try {
    const a=f.semantics.snapshot({mode:'content'});
    const token={...a.binding,snapshotId:a.snapshotId,ref:a.items[0].ref};
    assert.equal(f.semantics.resolve(token).id,'target');
    f.document.querySelector('p').textContent='Changed';
    assert.throws(()=>f.semantics.resolve(token));
  } finally {f.close();}
});

test('long table cells are paginated with explicit field and cell index', () => {
  const cell='C'.repeat(1050);
  const f=fixture(`<table><tr><td>Short</td><td>${cell}</td></tr></table>`);
  try {
    const result=pages(f.semantics,{mode:'table',budget:900});
    const parts=result.flatMap(p=>p.items);
    assert.equal(parts.filter(p=>p.fragment.field==='cells'&&p.fragment.index===1).map(p=>p.cellText).join(''),cell);
    assert.equal(parts.filter(p=>p.fragment.field==='cells'&&p.fragment.index===0).map(p=>p.cellText).join(''),'Short');
    assert.equal(parts.filter(p=>p.fragment.field==='name').map(p=>p.name).join(''),`Short ${cell}`);
    assert.ok(result.every(p=>Math.ceil(JSON.stringify(p).length/4)<=900));
  } finally {f.close();}
});

test('single UTF-16-unit limit still advances across emoji without splitting surrogates', () => {
  const f=fixture('<p>😀😀</p>',{maxText:1});
  try {
    const result=pages(f.semantics,{mode:'content'});
    assert.equal(result.flatMap(x=>x.items).map(x=>x.name).join(''),'😀😀');
  } finally {f.close();}
});

test('long item followed by a short item is paginated without repeats or skips', () => {
  const f=fixture(`<p>${'A'.repeat(900)}</p><p>Tail</p>`);
  try {
    const result=pages(f.semantics,{mode:'content',budget:850});
    const all=result.flatMap(x=>x.items);
    assert.equal(all.filter(x=>x.fragment?.field==='name').map(x=>x.name).join(''),'A'.repeat(900));
    assert.deepEqual(all.filter(x=>!x.fragment).map(x=>x.name),['Tail']);
    assert.equal(new Set(all.filter(x=>x.fragment).map(x=>x.ref)).size,1);
  } finally {f.close();}
});

test('inner text-node scan limit is reported as unrecoverable truncation', () => {
  const f=fixture('<p></p>',{maxScan:2});
  try {
    const p=f.document.querySelector('p');
    for(const word of ['A','B','C'])p.append(f.document.createTextNode(word));
    const a=f.semantics.snapshot({mode:'content'});
    assert.equal(a.coverage.truncated,1);
    assert.equal(a.coverage.complete,false);
    assert.equal(a.nextCursor,null);
  } finally {f.close();}
});

test('text-node scan cap discloses unrecoverable coverage', () => {
  const f=fixture('<p><span>A</span><span>B</span><span>C</span></p>',{maxScan:3});
  try {
    const a=f.semantics.snapshot({mode:'content'});
    assert.equal(a.coverage.traversalComplete,false);
    assert.equal(a.coverage.complete,false);
  } finally {f.close();}
});

test('3200 characters pack bounded fragments within a few pages without repeats', () => {
  const text='A'.repeat(3200);
  const f=fixture(`<p>${text}</p>`);
  try {
    const result=pages(f.semantics,{mode:'content',budget:6000});
    const items=result.flatMap(page=>page.items);
    assert.ok(result.length<=2, `expected at most 2 pages, got ${result.length}`);
    assert.equal(items.map(item=>item.name).join(''),text);
    assert.deepEqual(items.map(item=>item.fragment.start),[0,400,800,1200,1600,2000,2400,2800]);
    assert.equal(new Set(items.map(item=>item.ref)).size,1);
    assert.ok(result.every(page=>page.coverage.omitted>=0));
    assert.ok(result.every(page=>Math.ceil(JSON.stringify(page).length/4)<=6000));
  } finally {f.close();}
});

test('delta identifies each fragment separately and reconstructs one changed slice', () => {
  const text='A'.repeat(3200);
  const f=fixture(`<p>${text}</p>`);
  try {
    const options={mode:'content',budget:6000};
    const first=f.semantics.snapshot(options);
    assert.equal(first.items.length,8);
    const target=f.document.querySelector('p');
    target.textContent=`${text.slice(0,450)}B${text.slice(451)}`;
    const delta=f.semantics.snapshot({...options,baselineId:first.snapshotId});
    assert.equal(delta.kind,'delta');
    assert.equal(delta.items.length,1);
    assert.equal(delta.items[0].fragment.start,400);
    assert.equal(new Set(delta.order).size,8);
    assert.deepEqual(delta.removed,[]);
    const key=item=>JSON.stringify([item.ref,item.fragment.field,item.fragment.index??null,item.fragment.start]);
    const entries=new Map(first.items.map(item=>[key(item),item]));
    for(const id of delta.removed)entries.delete(id);
    for(const item of delta.items)entries.set(key(item),item);
    assert.equal(delta.order.map(id=>entries.get(id).name).join(''),target.textContent);
  } finally {f.close();}
});

test('full read cap reports irreversible truncation and hides secret crossing cap', () => {
  const secret='password=NEVER_EXPOSE_THIS_SECRET';
  const text=`${'A'.repeat(16370)} ${secret} ${'Z'.repeat(20000)}`;
  const f=fixture(`<p>${text}</p>`);
  try {
    const result=pages(f.semantics,{mode:'content',budget:6000});
    const emitted=result.flatMap(page=>page.items).map(item=>item.name).join('');
    assert.ok(emitted.length<=16384);
    assert.ok(!JSON.stringify(result).includes('NEVER_EXPOSE_THIS_SECRET'));
    assert.ok(result.some(page=>page.coverage.truncated===1));
    assert.ok(result.every(page=>page.coverage.complete===false));
  } finally {f.close();}
});

test('raw full-text reads share one bound across redacted row name and cells', () => {
  const f=fixture(`<table><tr><td>${`token=${'X'.repeat(1000)} `.repeat(60)}</td></tr></table>`);
  const Text=f.document.defaultView.Text;
  const original=Text.prototype.substringData;
  let requested=0;
  Text.prototype.substringData=function(start,count){const s=original.call(this,start,count);requested+=s.length;return s;};
  try {
    const page=f.semantics.snapshot({mode:'table',budget:6000});
    assert.ok(page.coverage.truncated>0);
    assert.ok(requested<=16384, `read ${requested} raw characters`);
  } finally {Text.prototype.substringData=original;f.close();}
});
