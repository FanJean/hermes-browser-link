import test from 'node:test';
import assert from 'node:assert/strict';
import {mountApprovalPanel} from '../../native-extension/approval-panel.mjs';

class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.textContent='';this.disabled=false;this.dataset={};}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];}
 addEventListener(type,fn){this.listeners[type]=fn;}
 focus(){this.focused=true;}
 async fire(type,evt){return this.listeners[type]?.(evt);}
}
function setup(view){const root=new Element('main');const doc={location:{href:'chrome-extension://ext-123/approval-panel.html'},createElement:t=>new Element(t),getElementById:id=>id==='app'?root:null,addEventListener(){}};
 const sent=[];const chrome={runtime:{getURL:p=>`chrome-extension://ext-123/${p}`,sendMessage:async m=>{sent.push(m);return m.type==='approval_panel_view'?{result:view}:{result:{decision:m.decision,requestId:m.requestId}};}}};
 return {root,doc,chrome,sent};}
const view={id:'request-1',taskTitle:'整理 <script>资料',origin:'https://example.test',action:'点击页面',scope:'本次操作',expiresAt:Date.now()+60_000};
function buttons(root){return root.children.filter(x=>x.tagName==='button');}

test('extension page shows brief scope with text nodes and only trusted actions',async()=>{
 const {root,doc,chrome,sent}=setup(view);await mountApprovalPanel({document:doc,chrome});
 assert.equal(root.children[0].textContent,'等待批准');
 assert(root.children.some(x=>x.textContent.includes('整理 <script>资料')));
 assert.deepEqual(buttons(root).map(x=>x.textContent),['批准本次','拒绝','稍后']);
 await buttons(root)[0].fire('click',{isTrusted:false});assert.equal(sent.length,1);
 await buttons(root)[0].fire('click',{isTrusted:true});assert.deepEqual(sent[1],{type:'approval_panel_decision',requestId:'request-1',decision:'approve'});
 await buttons(root)[0].fire('click',{isTrusted:true});assert.equal(sent.length,2);
});

test('untrusted document origin or malformed view never exposes approval controls',async()=>{
 const f=setup(view);f.doc.location.href='https://example.test/approval-panel.html';
 await assert.rejects(mountApprovalPanel({document:f.doc,chrome:f.chrome}),/extension origin/);
 const g=setup({...view,origin:'https://example.test/path'});await mountApprovalPanel({document:g.doc,chrome:g.chrome});
 assert.equal(buttons(g.root).length,0);
});
