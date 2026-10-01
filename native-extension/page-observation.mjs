// 中文注释：等待只扫描有界主文档，复用语义上下文的可见性、脱敏、修订及身份，不创建操作引用。
export function observePage(context,options){
 const {doc,binding,scan,visible,read,revision}=context;
 const selector=options?.selector;
 if(typeof selector!=='string'||!selector||selector.length>512)throw Error('INVALID_PARSE_OPTIONS');
 // 中文注释：先验证 CSS 语法；只返回固定错误，不返回选择器或页面异常原文。
 try{doc.createElement('div').matches(selector);}catch{throw Error('INVALID_PARSE_OPTIONS');}
 if(!doc.body)throw Error('PAGE_NOT_READY');
 const epoch=revision(),coverage={scanned:0,skippedFrames:0,traversalComplete:true},text=[];
 let complete=true,totalChars=0;
 for(const node of scan(doc.body,false,coverage)){
  if(coverage.scanned>=20000){complete=false;break;}
  coverage.scanned++;
  if(!node.matches(selector)||!visible(node,false))continue;
  if(text.length>=1000){complete=false;break;}
  // 中文注释：与 extract 文本字段一致，不读取表单输入值；每个匹配的文本上限沿用 4096。
  if(node.matches('input,textarea,select,[contenteditable="true"]'))text.push(null);
  else{const value=read(node);totalChars+=value.text.length;if(totalChars>12000){complete=false;break;}text.push(value.truncated||value.text.includes('[redacted]')||!value.text.trim()?null:value.text);}
 }
 if(revision()!==epoch)throw Error('DOCUMENT_CHANGED');
 return {count:text.length,text,complete,binding};
}
