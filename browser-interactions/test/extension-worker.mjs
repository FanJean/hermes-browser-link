import {Interactions,createChromeDebuggerAdapter} from './index.mjs';
let adapter,bridge;
globalThis.testCreate=async({url,scope,dpr})=>{
 const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url===url);if(!tab)throw Error('Fixture tab not found');
 await chrome.debugger.attach({tabId:tab.id},'1.3');
 adapter=createChromeDebuggerAdapter(chrome.debugger,{tabId:tab.id});
 await adapter.send('Emulation.setDeviceMetricsOverride',{width:800,height:600,deviceScaleFactor:dpr,mobile:false});
 bridge=new Interactions(adapter,scope);
 return {tabId:tab.id};
};
globalThis.testCall=async({method,arg})=>{
 try {return {value:await bridge[method](arg)};}catch(e){return {error:e.code||e.message};}
};
globalThis.testRecreate=options=>{bridge=new Interactions(adapter,options);};
