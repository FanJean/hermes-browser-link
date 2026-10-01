import test from 'node:test';
import assert from 'node:assert/strict';
import {pageAction,inspectPage,semanticWorldDeclaration} from '../../native-extension/core.mjs';

// 中文注释：通过真实页面注入入口验证普通字段与敏感字段使用相同规则。
const field=(props={})=>({tagName:'INPUT',type:'text',name:'',id:'',autocomplete:'',placeholder:'',className:'',attributes:[],labels:[],value:'',readOnly:false,disabled:false,isConnected:true,
 getAttribute(name){return props[name]??null;},closest(selector){return selector==='label'?props.outerLabel||null:null;},...props});
function assess(e){globalThis.location={origin:'https://example.test'};globalThis.document={querySelector:()=>e,getElementById:()=>null};return pageAction('assess_fill','#field',null,null,['https://example.test']);}
for(const [name,props] of [
 ['card 类名姓名框',{name:'full_name',className:'card input'}],
 ['data-token 普通框',{name:'company',attributes:[{name:'data-token',value:'abc'}]}],
 ['外层长标签公司框',{name:'company',outerLabel:{textContent:'Company verification email is sent later'}}],
 ['email verification 提示',{name:'company',labels:[{textContent:'Email verification notice'}]}],
 ['cardboard 普通框',{name:'cardboard'}],
 ['footprint 普通框',{name:'footprint'}],
 ['tokenizer 普通框',{name:'tokenizer_mode'}],
])test(`普通字段：${name}`,()=>assert.equal(assess(field(props)).targetAssessment,'ordinary'));
for(const [name,props,kind] of [
 ['密码 type',{type:'password'},'password'],['密码 name',{name:'password'},'password'],['令牌 name',{name:'auth_token'},'password'],
 ['信用卡 autocomplete',{autocomplete:'cc-number'},'payment'],['持卡人 autocomplete',{autocomplete:'cc-name'},'payment'],['安全码 autocomplete',{autocomplete:'cc-csc'},'payment'],
 ['卡号 label',{labels:[{textContent:'Card number'}]},'payment'],['CVV name',{name:'cvv'},'payment'],
 ['验证码 autocomplete',{autocomplete:'one-time-code'},'otp'],['OTP name',{name:'otp'},'otp'],
 ['验证码 label',{labels:[{textContent:'验证码'}]},'otp'],
 ['连写密码 name',{name:'newpassword'},'password'],['驼峰密码 name',{name:'userPassword'},'password'],
 ['CVV2 name',{name:'cvv2'},'payment'],['分格 OTP name',{name:'otp1'},'otp'],['银行卡号 label',{labels:[{textContent:'银行卡号'}]},'payment'],
])test(`敏感字段：${name}`,()=>assert.deepEqual(assess(field(props)),{targetAssessment:'sensitive',fieldKind:kind}));
test('快照和语义注入共用敏感判定',()=>{
 const e=field({name:'full_name',className:'card'});
 globalThis.location={origin:'https://example.test',href:'https://example.test/'};
 globalThis.document={title:'form',querySelectorAll:()=>[e],getElementById:()=>null};
 assert.equal(inspectPage(['https://example.test']).hasSensitiveValue,false);
 assert.equal(pageAction('snapshot',null,null,null,['https://example.test']).elements[0].sensitive,false);
 assert.match(semanticWorldDeclaration,/classifySensitiveField/);
});
