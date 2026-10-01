import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from '../../page-semantics/index.js';

function fixture(html, limits = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {url:'https://example.test/'});
  const {document} = dom.window;
  dom.window.HTMLElement.prototype.getClientRects = function () {return [this.getBoundingClientRect()];};
  const semantics = createPageSemantics({document,taskId:'t',documentId:'d',leaseId:'l',...limits});
  return {document,semantics,close(){semantics.revoke();dom.window.close();}};
}
const token = (page,item) => ({...page.binding,snapshotId:page.snapshotId,ref:item.ref});

test('removes nonprinting C0/C1 noise before redaction without discarding multilingual graphemes', () => {
  const good='👩‍💻 हिन्दी café العربية 中文';
  const f=fixture(`<p>Start \u0000\u0001\u001b\u007f\u0085 ${good} token=SE\u0002CRET End</p>`);
  try {
    const page=f.semantics.snapshot({mode:'content'});
    assert.equal(page.items[0].name,`Start ${good} token=[redacted]`);
    assert.equal(page.items[0].name.includes(' End'),false,'unquoted credential tails are ambiguous, not separators');
    assert.equal(page.coverage.complete,true);
    assert.equal(f.semantics.resolve(token(page,page.items[0])).localName,'p');
  } finally {f.close();}
});

test('redaction preserves suffix text only after a complete quoted credential and separator', () => {
  const f=fixture('<p>token="private value | still private" | safe suffix</p><p>token=private value | ambiguous tail</p><p>token="unterminated private suffix</p>');
  try {
    const page=f.semantics.snapshot({mode:'content'});
    assert.deepEqual(page.items.map(item=>item.name),[
      'token=[redacted] | safe suffix',
      'token=[redacted]',
      'token=[redacted]',
    ]);
  } finally {f.close();}
});

test('opt-in composed view finds open shadow controls and resolves exact duplicate names', () => {
  const f=fixture('<button id="light">Save</button><div id="host"></div>');
  try {
    const host=f.document.querySelector('#host');
    const shadow=host.attachShadow({mode:'open'});
    shadow.innerHTML='<button id="shadow">Save</button><button aria-label="token=HIDDEN">Other</button>';
    assert.equal(f.semantics.snapshot().items.length,1,'legacy light-DOM default');
    const page=f.semantics.snapshot({composed:true});
    assert.equal(page.items.length,3);
    assert.notEqual(page.items[0].ref,page.items[1].ref);
    assert.equal(page.items[0].name,'Save');
    assert.equal(page.items[1].name,'Save');
    assert.equal(f.semantics.resolve(token(page,page.items[1])),shadow.querySelector('#shadow'));
    assert.equal(page.items[2].name,'token=[redacted]');
    assert.match(page.coverage.scope,/open-shadow/);
  } finally {f.close();}
});

test('shadow labels stay inside their root and a private or hidden host suppresses descendants', () => {
  const f=fixture('<span id="title">Wrong</span><div id="host"></div><div data-private id="private"></div>');
  try {
    const a=f.document.querySelector('#host').attachShadow({mode:'open'});
    a.innerHTML='<span id="title">Correct</span><button aria-labelledby="title">Other</button>';
    const b=f.document.querySelector('#private').attachShadow({mode:'open'});
    b.innerHTML='<button>SECRET_HOST</button>';
    const first=f.semantics.snapshot({composed:true});
    assert.deepEqual(first.items.map(x=>x.name),['Correct']);
    f.document.querySelector('#host').hidden=true;
    const second=f.semantics.snapshot({composed:true});
    assert.equal(second.items.length,0);
  } finally {f.close();}
});

test('opt-in composed view scans a same-origin frame and binds its exact ref', () => {
  const f=fixture('<button id="outer">Save</button><iframe id="child" src="about:blank"></iframe>');
  try {
    const frame=f.document.querySelector('#child');
    const fd=frame.contentDocument;
    fd.body.innerHTML='<button id="inner">Save</button><p>合法正文</p>';
    fd.defaultView.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
    assert.deepEqual(f.semantics.snapshot().items.map(x=>x.name),['Save']);
    const page=f.semantics.snapshot({composed:true});
    assert.deepEqual(page.items.map(x=>x.name),['Save','Save']);
    assert.equal(f.semantics.resolve(token(page,page.items[1])),fd.querySelector('#inner'));
    assert.match(page.coverage.scope,/same-origin-frame/);
    assert.equal(f.semantics.snapshot({composed:true,mode:'content'}).items[0].name,'合法正文');
  } finally {f.close();}
});

test('same-turn shadow mutation and frame replacement invalidate old action refs and cursors', () => {
  const f=fixture('<div id="host"></div><iframe id="child" src="about:blank"></iframe>');
  try {
    const shadow=f.document.querySelector('#host').attachShadow({mode:'open'});
    shadow.innerHTML='<button>Shadow</button><button>Again</button>';
    const frame=f.document.querySelector('#child');
    const fd=frame.contentDocument;
    fd.body.innerHTML='<button>Frame</button>';
    fd.defaultView.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
    const s=createPageSemantics({document:f.document,taskId:'t',documentId:'d',leaseId:'l',maxItems:1});
    try {
      const a=s.snapshot({composed:true});
      assert.ok(a.nextCursor);
      shadow.querySelector('button').textContent='Changed';
      assert.throws(()=>s.resolve(token(a,a.items[0])),/REF_TARGET_MISSING/);
      const b=s.snapshot({composed:true,cursor:a.nextCursor});
      assert.equal(b.resync,null);
      const framePage=s.snapshot({composed:true,query:'Frame'});
      assert.equal(framePage.items[0].name,'Frame');
      fd.open();fd.write('<html><body><button>Replacement</button></body></html>');fd.close();
      assert.throws(()=>s.resolve(token(framePage,framePage.items[0])),/DOCUMENT_REPLACED/);
    } finally {s.revoke();}
  } finally {f.close();}
});

test('opt-in pagination and delta preserve refs, coverage and estimated serialized budget', () => {
  const f=fixture('<div id="host"></div><button>Tail</button>',{maxItems:1});
  try {
    const shadow=f.document.querySelector('#host').attachShadow({mode:'open'});
    shadow.innerHTML='<button>Save</button><button>Save</button>';
    const options={composed:true,budget:850};
    const all=[];
    let page=f.semantics.snapshot(options);
    while(true){
      assert.ok(Math.ceil(JSON.stringify(page).length/4)<=850);
      all.push(...page.items);
      if(!page.nextCursor)break;
      page=f.semantics.snapshot({...options,cursor:page.nextCursor});
      assert.ok(all.length<4,'cursor advances');
    }
    assert.deepEqual(all.map(x=>x.name),['Save','Save','Tail']);
    assert.equal(new Set(all.map(x=>x.ref)).size,3);
    const first=f.semantics.snapshot(options);
    const delta=f.semantics.snapshot({...options,baselineId:first.snapshotId});
    assert.equal(delta.kind,'delta');
    assert.equal(delta.items.length,0);
    assert.equal(delta.order.length,1);
    const switched=f.semantics.snapshot({budget:850,baselineId:delta.snapshotId});
    assert.equal(switched.resync.reason,'parameters_changed');
  } finally {f.close();}
});

test('composed view does not leak text under a CSS-hidden ancestor', () => {
  const f=fixture('<div id="host"></div>');
  try {
    const root=f.document.querySelector('#host').attachShadow({mode:'open'});
    root.innerHTML='<div style="display:none"><button>HIDDEN_CSS</button></div><button>Visible</button>';
    const page=f.semantics.snapshot({composed:true});
    assert.deepEqual(page.items.map(x=>x.name),['Visible']);
  } finally {f.close();}
});

test('inaccessible frames are excluded and incomplete coverage is explicit', () => {
  const f=fixture('<iframe id="child"></iframe><button>Visible</button>');
  try {
    Object.defineProperty(f.document.querySelector('#child'),'contentDocument',{get(){return null;}});
    const page=f.semantics.snapshot({composed:true});
    assert.deepEqual(page.items.map(x=>x.name),['Visible']);
    assert.equal(page.coverage.skippedFrames,1);
    assert.equal(page.coverage.complete,false);
  } finally {f.close();}
});

test('interactive clipping does not emit half a surrogate pair', () => {
  const f=fixture('<button>😀继续</button>',{maxText:1});
  try {
    const page=f.semantics.snapshot();
    assert.equal(page.items[0].name,'');
    assert.equal(page.items[0].truncated,true);
    assert.equal(page.coverage.complete,false);
  } finally {f.close();}
});

test('visible descendants of visibility-hidden containers remain available', () => {
  const f=fixture('<div style="visibility:hidden"><button style="visibility:visible">Keep me</button></div>');
  try {
    const page=f.semantics.snapshot();
    assert.deepEqual(page.items.map(x=>x.name),['Keep me']);
  } finally {f.close();}
});
