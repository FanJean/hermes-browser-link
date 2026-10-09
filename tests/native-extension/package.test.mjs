// 中文注释：权限清单包含审批提醒，通知点击不授予浏览器访问。
import test from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {mkdtemp,readFile,rm} from 'node:fs/promises';import path from 'node:path';
import {buildCurrentPackageArchive} from './current-package.mjs';
import {cdpMethodAllowed} from '../../native-extension/cdp-policy.mjs';
const exec=promisify(execFile);const root=new URL('../../native-extension/',import.meta.url);const repo=path.resolve(import.meta.dirname,'../..');const scratch=process.env.TMPDIR||path.join(process.env.HOME,'.hermes/cache/scratch');
test('independent MV3 has no content script and popup preserves task protections without smart consent controls',async()=>{
 const m=JSON.parse(await readFile(new URL('manifest.json',root)));
 assert.equal(m.background.type,'module');
 assert.deepEqual(m.permissions.sort(),['notifications','cookies','alarms','debugger','downloads','nativeMessaging','scripting','storage','tabGroups','tabs'].sort());
 assert.deepEqual(m.host_permissions,['<all_urls>']);assert.equal(m.content_scripts,undefined);assert.equal(m.externally_connectable,undefined);
 assert.doesNotMatch(m.description,/智能审批|smart[- ]approval/i);assert.match(m.description,/连接授权后直接执行/);
 const ui=await readFile(new URL('popup.html',root),'utf8');
 assert.match(ui,/连接状态/);assert.match(ui,/任务页访问/);assert.match(ui,/id="version-label"/);
 assert.match(ui,/id="takeover"[^>]*>接管/);assert.match(ui,/id="stop-task"[^>]*>停止/);assert.match(ui,/凭据保护/);
 assert.match(ui,/Cookie 镜像和弹出页接入另行确认/);assert.match(ui,/id="filter-toggle"[^>]*role="switch"/);
 assert.doesNotMatch(ui,/id="(?:cookie-mirror|cursor-toggle|shield-settings|consent-toggle|browser-full-consent|access-toggle)"/);
 assert.doesNotMatch(ui,/智能审批|浏览器权限|日志|id="tasks"/);assert.match(ui,/popup.mjs/);
 const bg=await readFile(new URL('background.mjs',root),'utf8');assert.match(bg,/com.hermes.browser_link/);
});

test('current architecture describes the allowed persistent CDP script boundary',async()=>{
 assert.equal(cdpMethodAllowed('Page.addScriptToEvaluateOnNewDocument').allowed,true);
 const architecture=await readFile(path.join(repo,'docs/architecture.md'),'utf8');
 assert.doesNotMatch(architecture,/`Page\.addScriptToEvaluateOnNewDocument` 已禁用/);
 assert.match(architecture,/`Page\.addScriptToEvaluateOnNewDocument`[^\n]*持续执行[^\n]*未授权来源/);
});

test('legacy packaged dist-native is explicit and missing package never falls back to source',async()=>{const work=await mkdtemp(path.join(scratch,'native-layout-'));try{const python=process.env.HERMES_PYTHON||path.join(process.env.HOME,'.hermes/hermes-agent/venv/bin/python');await exec(python,['-c',`import importlib.util,pathlib,sys,json,hashlib,zipfile
spec=importlib.util.spec_from_file_location('helper',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
w=pathlib.Path(sys.argv[2])
for layout in ('legacy','missing','incomplete-flat'):
 files={'browser-link/plugin.yaml':b'name: fixture','browser-link/native_bridge/host.py':b'# fixture','install-executor.py':b'# fixture'}
 if layout!='missing':
  files.update({'native-extension/dist-native/manifest.json':b'{}','native-extension/dist-native/background.mjs':b'// fixture'})
 if layout=='incomplete-flat': files['native-extension/manifest.json']=b'{}'
 archive=w/(layout+'.zip')
 with zipfile.ZipFile(archive,'w') as z:
  for name,data in files.items(): z.writestr(name,data)
  z.writestr('SHA256SUMS.json',json.dumps({n:hashlib.sha256(d).hexdigest() for n,d in files.items()}))
 if layout=='legacy':
  result=m.prepare(w/layout,archive);assert result['extensionLayout']=='legacy-dist-native';assert result['extensionRoot']==str(w/layout/'package/native-extension/dist-native')
 else:
  try: m.prepare(w/layout,archive)
  except ValueError: pass
  else: raise AssertionError('invalid package silently accepted')
`,path.join(import.meta.dirname,'real-helper.py'),work],{cwd:repo});}finally{await rm(work,{recursive:true,force:true});}});

test('real helper extracts and verifies the current package before native E2E',async()=>{const work=await mkdtemp(path.join(scratch,'native-package-'));try{const python=process.env.HERMES_PYTHON||path.join(process.env.HOME,'.hermes/hermes-agent/venv/bin/python');const zip=process.env.BROWSER_EXECUTOR_PACKAGE?path.resolve(process.env.BROWSER_EXECUTOR_PACKAGE):await buildCurrentPackageArchive(repo,work,python);const {stdout}=await exec(python,[path.join(import.meta.dirname,'real-helper.py'),'prepare',work,zip],{cwd:repo,timeout:30000});const result=JSON.parse(stdout);assert.equal(result.manifestExact,true);assert.ok(Number.isInteger(result.hashedFiles)&&result.hashedFiles>0);assert.equal(result.packageRoot,path.join(work,'package'));assert.equal(result.extensionRoot,path.join(work,'package','native-extension'));assert.equal(result.extensionLayout,'flat');assert.match(result.pluginSource,/package\/browser-link$/);
 const installation=await readFile(path.join(result.packageRoot,'INSTALL.txt'),'utf8');
 assert.doesNotMatch(installation,/smart[- ]approval|智能审批/i);
 assert.match(installation,/confirm connection authorization/);assert.match(installation,/ordinary task-page actions run directly/);
 const manifest=JSON.parse(await readFile(path.join(result.extensionRoot,'manifest.json'),'utf8'));
 assert.doesNotMatch(manifest.description,/智能审批|smart[- ]approval/i);
 for(const relative of ['docs/usage.md','browser-link/skills/troubleshoot/SKILL.md']){
  const guidance=await readFile(path.join(result.packageRoot,relative),'utf8');
  assert.match(guidance,/popup_adopt[^\n]*never resend/i,relative);
  assert.match(guidance,/wait_pending[^\n]*read-only/i,relative);
  assert.match(guidance,/browser_shared_get[^\n]*generation[^\n]*adoptedPopupTabIds/,relative);
  assert.match(guidance,/known candidate[^\n]*re-read/i,relative);
 }
}finally{await rm(work,{recursive:true,force:true});}});
