// 中文注释：仅在回环地址使用随机夹具登录态；值不出日志、回执或磁盘。
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
export function createCookieFixture(){
 const login=randomBytes(24).toString('hex'),plain=randomBytes(16).toString('hex'),partition=randomBytes(16).toString('hex');
 const server=createServer((req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');
  if(req.url==='/login'){
   res.setHeader('Set-Cookie',[
    `fixture_login=${login}; Path=/; HttpOnly; SameSite=Lax`,
    `fixture_plain=${plain}; Path=/; Max-Age=86400; SameSite=Lax`,
    `__Host-fixture_partition=${partition}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`,
   ]);res.end('<h1>夹具已登录</h1>');return;
  }
  if(req.url==='/protected'){
   const parsed=new Map((req.headers.cookie||'').split(';').map(part=>{const at=part.indexOf('=');return [part.slice(0,at).trim(),part.slice(at+1)];}));
   const authenticated=parsed.get('fixture_login')===login&&parsed.get('fixture_plain')===plain;
   const partitioned=parsed.get('__Host-fixture_partition')===partition;
   res.statusCode=authenticated?200:401;res.end(`<h1 id="auth" data-authenticated="${authenticated}" data-partitioned="${partitioned}">${authenticated?'已登录':'未登录'}</h1>`);return;
  }
  res.end('<h1>Cookie 镜像本机夹具</h1><a href="/login">登录</a><a href="/protected">受保护页</a>');
 });
 // 中文注释：仅供验收脚本做泄漏扫描；不打印、不落盘。
 Object.defineProperty(server,'fixtureSecrets',{value:Object.freeze([login,plain,partition])});
 return server;
}
