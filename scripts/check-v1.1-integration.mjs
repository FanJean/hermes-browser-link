#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const CHECKER_INPUTS = Object.freeze([
  'executor-plugin/native_tools.py', 'executor-plugin/native_runtime.py',
  'executor-plugin/plugin.yaml',
  'native-bridge/daemon.py', 'native-bridge/artifacts.py', 'native-bridge/install.py', 'native-extension/core.mjs',
  'native-extension/background.mjs', 'native-extension/bridge.mjs',
  'native-extension/oauth-popups.mjs',
  'native-extension/manifest.json', 'native-extension/build.mjs',
  'browser-interactions/index.mjs', 'page-semantics/index.js',
  'scripts/package-executor.mjs',
]);

// Parse Python declarations and call structure with the stdlib AST. This avoids
// treating action-name mentions in comments/docs as execution evidence.
const PYTHON_ANALYZER = String.raw`
import ast, json, sys
src = json.load(sys.stdin)
def tree(name): return ast.parse(src.get(name, ''), filename=name)
def value(n):
    if isinstance(n, ast.Constant): return n.value
    if isinstance(n, (ast.List, ast.Tuple, ast.Set)):
        vals = [value(x) for x in n.elts]
        return set(vals) if isinstance(n, ast.Set) else vals
    if isinstance(n, ast.Dict): return {value(k): value(v) for k,v in zip(n.keys,n.values)}
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in ('set','frozenset','tuple','list'):
        if not n.args: return set() if n.func.id in ('set','frozenset') else []
        return value(n.args[0])
    raise ValueError('not a literal: '+type(n).__name__)
def assigns(t,name):
    out=[]
    for n in t.body:
        targets=n.targets if isinstance(n,ast.Assign) else [n.target] if isinstance(n,ast.AnnAssign) else []
        if any(isinstance(x,ast.Name) and x.id==name for x in targets): out.append(n.value)
    return out
def fn(t,name): return next((n for n in ast.walk(t) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==name),None)
def call_name(n,name): return any(isinstance(x,ast.Call) and isinstance(x.func,ast.Name) and x.func.id==name for x in ast.walk(n))
def call_attr(n,attr,receiver=None):
    return any(isinstance(x,ast.Call) and isinstance(x.func,ast.Attribute) and x.func.attr==attr and
      (receiver is None or isinstance(x.func.value,ast.Name) and x.func.value.id==receiver) for x in ast.walk(n))
def item(d,key):
    if not isinstance(d,ast.Dict): return None
    return next((v for k,v in zip(d.keys,d.values) if isinstance(k,ast.Constant) and k.value==key),None)
def tool_props(t):
    all_tools=assigns(t,'TOOL_SCHEMAS')
    tool=item(all_tools[0],'browser_shared_run') if all_tools and isinstance(all_tools[0],ast.Dict) else None
    params=item(tool,'parameters') if tool else None
    return params.args[0] if isinstance(params,ast.Call) and params.args and isinstance(params.args[0],ast.Dict) else None
def public_enum(t):
    props=tool_props(t); action=item(props,'action') if props else None; enum=item(action,'enum') if isinstance(action,ast.Dict) else None
    result=[value(x) for x in enum.elts] if isinstance(enum,(ast.List,ast.Tuple)) else []
    # 中文注释：当前工具会在声明后以公开动作集合覆盖 schema 枚举。
    for node in ast.walk(t):
        if isinstance(node,ast.Assign) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id=='sorted':
            if len(node.value.args)==1 and isinstance(node.value.args[0],ast.Name) and node.value.args[0].id=='PUBLIC_ACTIONS':
                if any(isinstance(target,ast.Subscript) and ast.unparse(target)=="_run_schema['properties']['action']['enum']" for target in node.targets):
                    try: return sorted(value(assigns(t,'PUBLIC_ACTIONS')[0]))
                    except Exception: return []
    return result
def local_keys(t,function,variable):
    f=fn(t,function)
    if f:
        for n in ast.walk(f):
            if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id==variable for x in n.targets):
                candidate=n.value.value if isinstance(n.value,ast.Subscript) else n.value
                if isinstance(candidate,ast.Dict): return [value(k) for k in candidate.keys]
    return []
def tool_names(t):
    vals=assigns(t,'TOOL_NAMES')
    if not vals or not isinstance(vals[0],ast.Call) or not vals[0].args: return []
    gen=vals[0].args[0]
    if not isinstance(gen,ast.GeneratorExp) or not isinstance(gen.elt,ast.BinOp) or not isinstance(gen.elt.left,ast.Constant): return []
    try: return [gen.elt.left.value+x for x in value(gen.generators[0].iter)]
    except Exception: return []
def run_method(t,names):
    vals=assigns(t,'_METHODS')
    if not vals or not isinstance(vals[0],ast.Call) or not vals[0].args: return None
    z=vals[0].args[0]
    if not isinstance(z,ast.Call) or not isinstance(z.func,ast.Name) or z.func.id!='zip' or len(z.args)<2: return None
    if not isinstance(z.args[0],ast.Name) or z.args[0].id!='TOOL_NAMES': return None
    try: methods=value(z.args[1])
    except Exception: return None
    i=names.index('browser_shared_run') if 'browser_shared_run' in names else -1
    return methods[i] if 0<=i<len(methods) else None
def native_info():
    t=tree('executor-plugin/native_tools.py'); rt=tree('executor-plugin/native_runtime.py')
    try: public=sorted(value(assigns(t,'PUBLIC_ACTIONS')[0]))
    except Exception: public=[]
    enum=public_enum(t); fields=local_keys(t,'_validate','fields'); names=tool_names(rt); method=run_method(t,names)
    register=fn(t,'register_native_context')
    registered=bool(register and any(isinstance(x,ast.For) and isinstance(x.iter,ast.Name) and x.iter.id=='TOOL_NAMES' for x in ast.walk(register))
      and call_attr(register,'register_tool','ctx') and 'make_tool_handler' in ast.unparse(register))
    factory=fn(t,'make_tool_handler'); handler=next((x for x in factory.body if isinstance(x,ast.FunctionDef) and x.name=='handler'),None) if factory else None
    handler_ok=bool(handler and call_name(handler,'_validate') and call_attr(handler,'call','profile_runtime')
      and any(isinstance(x,ast.Subscript) and isinstance(x.value,ast.Name) and x.value.id=='_METHODS' for x in ast.walk(handler)))
    mapping={}
    if handler:
        for n in ast.walk(handler):
            if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='mapping' for x in n.targets):
                try: mapping=value(n.value)
                except Exception: pass
    schema=sorted(set(public)&set(enum)&set(fields)) if registered and handler_ok and method=='shared.run' and 'browser_shared_run' in names and mapping.get('action')=='action' else []
    # 中文注释：已删除旧版动作契约，候选动作只来自当前公开工具。
    deferred=[]
    return {'public':public,'schema':schema,'deferred':deferred,'tools':names,'runMethod':method,'toolRegistration':registered and handler_ok,
      'debug':{'enumCount':len(enum),'fieldKeys':sorted(fields),'runToolIndex':names.index('browser_shared_run') if 'browser_shared_run' in names else -1,'mappedAction':mapping.get('action')}}
def daemon_info():
    t=tree('native-bridge/daemon.py')
    try: allowed=sorted(value(assigns(t,'V1_ACTIONS')[0]))
    except Exception: allowed=[]
    required=local_keys(t,'_validate_run_params','required'); validator=fn(t,'_validate_run_params')
    validator_ok=bool(validator and any(isinstance(x,ast.Compare) and isinstance(x.left,ast.Name) and x.left.id=='action'
      and any(isinstance(op,ast.NotIn) for op in x.ops) and any(isinstance(c,ast.Name) and c.id=='V1_ACTIONS' for c in x.comparators)
      for x in ast.walk(validator)))
    run=fn(t,'_run_task_impl'); validates=bool(run and any(isinstance(x,ast.Call) and isinstance(x.func,ast.Attribute) and x.func.attr=='_validate_run_params' for x in ast.walk(run)))
    dispatch=api=False
    if run:
      for x in ast.walk(run):
        if not isinstance(x,ast.If) or not isinstance(x.test,ast.Compare) or not isinstance(x.test.left,ast.Name) or x.test.left.id!='action': continue
        if not any(isinstance(c,ast.Constant) and c.value=='api_request' for c in x.test.comparators): continue
        body=ast.Module(body=x.body,type_ignores=[])
        if not call_attr(body,'_api_request'): continue
        api=True
        tail=ast.Module(body=x.orelse,type_ignores=[])
        dispatch=call_attr(tail,'_extension_call') and 'browser.execute' in ast.unparse(tail)
        break
    # 中文注释：公开入口先经持久化包装，再进入实现函数；两段调用都必须存在。
    client=fn(t,'_dispatch_client'); implementation=fn(t,'_dispatch_client_impl')
    entry=bool(client and implementation and call_attr(client,'_dispatch_client_impl') and 'shared.run' in ast.unparse(implementation) and call_attr(implementation,'_run_task'))
    return {'allowlist':allowed,'required':sorted(required),'validator':validator_ok and validates,'dispatch':dispatch and api and entry,
      'debug':{'validatorGuard':validator_ok,'runValidationCall':validates,'apiRoute':api,'extensionDispatch':dispatch,'publicEntry':entry}}
print(json.dumps({'native':native_info(),'daemon':daemon_info()}))
`;

const rootDefault = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (root, relative) => { try { return readFileSync(join(root, relative), 'utf8'); } catch { return ''; } };
const hasFile = (root, relative) => existsSync(join(root, relative));
function pythonAnalysis(root) {
  const files=Object.fromEntries(CHECKER_INPUTS.filter(x=>x.endsWith('.py')).map(x=>[x,read(root,x)]));
  const run=spawnSync(process.env.PYTHON||'python3',['-c',PYTHON_ANALYZER],{input:JSON.stringify(files),encoding:'utf8',timeout:10000});
  if(run.status!==0) return {error:(run.stderr||run.error?.message||'Python AST analysis failed').trim()};
  try { return JSON.parse(run.stdout); } catch { return {error:'Python AST analysis returned invalid data'}; }
}
function balancedEnd(source,start,openChar,closeChar) {
  if(start<0||source[start]!==openChar)return -1;
  let depth=0,quote='',line=false,block=false,escape=false;
  for(let i=start;i<source.length;i++){
    const c=source[i],next=source[i+1];
    if(line){if(c==='\n')line=false;continue;}
    if(block){if(c==='*'&&next==='/'){block=false;i++;}continue;}
    if(quote){if(escape){escape=false;continue;}if(c==='\\'){escape=true;continue;}if(c===quote)quote='';continue;}
    if(c==='/'&&next==='/'){line=true;i++;continue;} if(c==='/'&&next==='*'){block=true;i++;continue;}
    if(c==="'"||c==='"'||c==='`'){quote=c;continue;}
    if(c===openChar)depth++; else if(c===closeChar&&--depth===0)return i;
  }
  return -1;
}
function arrayLiteral(source,marker) {
  const at=source.indexOf(marker);if(at<0)return [];
  const start=source.indexOf('[',at),end=balancedEnd(source,start,'[',']');if(end<0)return [];
  const body=source.slice(start+1,end),matches=[...body.matchAll(/(['"])(.*?)\1/g)];
  let rest=body.replace(/(['"])(.*?)\1/g,'').replace(/[\s,]/g,'').replace(/\.\.\.[A-Za-z_$][\w$]*/g,'');
  return rest?[]:matches.map(x=>x[2]);
}
function methodBody(source,name) {
  const re=new RegExp(`(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`),m=re.exec(source);if(!m)return '';
  const start=source.indexOf('{',m.index+m[0].length-1),end=balancedEnd(source,start,'{','}');return end<0?'':source.slice(start+1,end);
}
function objectBody(source,marker) {
  const at=source.indexOf(marker);if(at<0)return '';
  const start=source.indexOf('{',at+marker.length),end=balancedEnd(source,start,'{','}');return end<0?'':source.slice(start+1,end);
}
function escapeRegExp(text){return text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function extensionInfo(root) {
  const core=read(root,'native-extension/core.mjs'),background=read(root,'native-extension/background.mjs'),bridge=read(root,'native-extension/bridge.mjs');
  let manifest={};try{manifest=JSON.parse(read(root,'native-extension/manifest.json'));}catch{}
  const actions=arrayLiteral(core,'export const V1_ACTIONS = Object.freeze(');
  const execute=methodBody(core,'executeAction'),performEntry=methodBody(core,'perform'),
    // 中文注释：仅将被审批入口实际调用的工作窗口内动作分支纳入静态路由核对。
    perform=performEntry+(/this\.performAuthorized\(t,p,guard,get,modeGeneration\)/.test(performEntry)?methodBody(core,'performAuthorized'):''),page=methodBody(core,'pageAction'),world=methodBody(core,'callWorld');
  const bg=/import\s*\{\s*Executor\s*,[^}]*\}\s*from\s*['"]\.\/core\.mjs['"]/.test(background)
    &&/new\s+Executor\s*\(chrome\b/.test(background)&&/new\s+Bridge\s*\(port\s*,\s*executor\b/.test(background)
    &&manifest.background?.service_worker==='background.mjs';
  const execOk=/assertV1Action\s*\(\s*p\.action\s*\)/.test(execute)&&/this\.perform\s*\(\s*t\s*,\s*p\s*\)/.test(execute)
    &&/assertV1Action\s*\(\s*p\.action\s*\)/.test(perform);
  const bridgeOk=/m\.method\s*===\s*['"]browser\.execute['"]\s*\)\s*result\s*=\s*await\s*this\.executor\.execute\s*\(\s*m\.params\s*\)/.test(bridge);
  const credentials=/m\.method\s*===\s*['"]browser\.credentials['"]/.test(bridge)&&/this\.executor\.credentials\s*\(\s*m\.params\s*\)/.test(bridge)&&/async\s+credentials\s*\(p\)/.test(core);
  const interactionImport=/import\s*\{\s*Interactions\s*,[^}]*\}\s*from\s*['"]\.\.\/browser-interactions\/index\.mjs['"]/.test(core)&&/new\s+Interactions\s*\(/.test(methodBody(core,'interactionsFor'));
  const semanticsImport=/import\s*\{\s*createPageSemantics\s*\}\s*from\s*['"]\.\.\/page-semantics\/index\.js['"]/.test(core)&&/callSemanticWorld\s*\(/.test(perform);
  // 中文注释：有界观察加入语义分支首项后，仍从当前执行分支取动作并逐项核对页面函数。
  const semanticActions=arrayLiteral(perform,"else if(['page.observe'");
  const generic=/this\.callWorld\s*\([^;]*p\.action/.test(perform)&&/const\s+fn\s*=\s*action\s*===\s*['"]inspect['"]\s*\?\s*inspectPage\s*:\s*pageAction/.test(world);
  const route=action=>{
    if(!bg||!execOk||!bridgeOk)return false;
    // 中文注释：popup 元数据动作在页面执行前独立分流，必须实际接到审批与候选模块。
    if(action==='popup_catalog')return /p\.action==='popup_catalog'/.test(execute)&&/this\.popups\.catalog\(/.test(execute)&&/class OAuthPopups/.test(read(root,'native-extension/oauth-popups.mjs'));
    if(action==='popup_adopt')return /p\.action==='popup_adopt'/.test(execute)&&/this\.adoptPopup\(t,p\)/.test(execute)&&/this\.actionGrants\.get/.test(methodBody(core,'adoptPopup'))&&/this\.popups\.inspect/.test(methodBody(core,'adoptPopup'));
    if(action==='api_request')return credentials;
    if(action==='files.upload')return /p\.action===['"]files\.upload['"]/.test(perform)
      &&/DOM\.setFileInputFiles/.test(perform)&&/p\.artifactOrigin/.test(perform)
      &&/p\.filePaths/.test(perform)&&/this\.withInteractionHighlight\(/.test(perform);
    if(!actions.includes(action))return false;
    if(action.startsWith('interaction.')){
      const forms={
        'interaction.capture':[/p\.action\s*===\s*['"]interaction\.capture['"]/,/interactions\.capture\s*\(/],
        'interaction.bounds':[/p\.action\s*===\s*['"]interaction\.bounds['"]/,/interactions\.bounds\s*\(/],
        'interaction.click':[/p\.action\s*===\s*['"]interaction\.click['"]/,/interactions\.clickCoordinates\s*\(/],
        'interaction.drag_coordinates':[/p\.action\s*===\s*['"]interaction\.drag_coordinates['"]/,/interactions\.dragCoordinates\s*\(/],
        'interaction.drag_elements':[/p\.action\s*===\s*['"]interaction\.drag_elements['"]/,/interactions\.dragElements\s*\(/],
      }[action];return Boolean(forms&&forms.every(re=>re.test(perform))&&/p\.action\.startsWith\(['"]interaction\.['"]\)/.test(perform)&&interactionImport);
    }
    // 中文注释：语义按键由扩展的受限 CDP 键盘分支派发，不走页面函数同名动作。
    if(action==='ref_press')return semanticsImport&&/p\.action===['"]ref_press['"]/.test(perform)
      &&/focus_ref_press/.test(core)&&/press_check_ref/.test(core)&&/Input\.dispatchKeyEvent/.test(perform);
    // 中文注释：语义点击与自定义状态控件走 CDP 输入；原生 select 检查选项校验、选中和冒泡事件路径。
    if(action==='ref_click')return semanticsImport&&interactionImport&&/p\.action===['"]ref_click['"]/.test(perform)
      &&/pointer_target/.test(core)&&/interactions\.clickBoundTarget\(/.test(perform);
    if(action==='ref_set_checked')return semanticsImport&&interactionImport&&/plan_ref_set_checked/.test(core)
      &&/read_ref_set_checked/.test(core)&&/interactions\.clickBoundTarget\(/.test(perform);
    if(action==='ref_select_option')return semanticsImport&&interactionImport&&/plan_ref_select_option/.test(core)
      &&/read_ref_select_option/.test(core)&&/apply_native_ref_select_option/.test(core)
      &&/interactions\.clickBoundTarget\(/.test(perform)&&/new Event\('input'/.test(core)&&/new Event\('change'/.test(core);
    if(['semantic_snapshot','page.parse'].includes(action))return semanticsImport&&semanticActions.includes(action)&&core.includes("op==='semantic_snapshot'||op==='page.parse'");
    if(semanticActions.includes(action))return semanticsImport&&new RegExp(`if\\(op===['"]${escapeRegExp(action)}['"]\\)`).test(core);
    if(action==='tabs')return /p\.action\s*===\s*['"]tabs['"]/.test(perform)&&/Promise\.all\(\[\.\.\.t\.tabIds\]/.test(perform);
    if(action==='frame_catalog')return /p\.action\s*===\s*['"]frame_catalog['"]/.test(perform)&&/this\.frameCatalog\s*\(/.test(perform);
    if(action==='new_tab')return /p\.action\s*===\s*['"]new_tab['"]/.test(perform)&&/this\.openOwnedTab\s*\(/.test(perform);
    if(action==='navigate')return /p\.action\s*===\s*['"]navigate['"]/.test(perform)&&/this\.api\.tabs\.update\s*\(/.test(perform);
    if(action==='screenshot')return /p\.action\s*===\s*['"]screenshot['"]/.test(perform)&&/Page\.captureScreenshot/.test(perform);
    if(action==='scroll')return /p\.action\s*===\s*['"]scroll['"]/.test(perform)&&/scrolled\s*:\s*true/.test(perform);
    if(action==='back')return /p\.action\s*===\s*['"]back['"]/.test(perform)&&/\.goBack\s*\(/.test(perform);
    // 中文注释：页面执行、控制台、对话框与图片动作各自必须落到明确的执行器委托。
    const delegated={
      'js.evaluate':/this\.pageRuntime\.evaluate\(t,p,guard\)/,'cdp.send':/this\.pageRuntime\.send\(t,p,guard\)/,
      'cdp.events':/this\.pageRuntime\.drain\(t,p,/,'console':/this\.observers\.console\(t,p,target,guard\)/,
      'dialog':/this\.observers\.handle\(t,p,target,guard\)/,'images':/functionDeclaration:listImages\.toString\(\)/}[action];
    if(delegated)return new RegExp(`p\\.action===['"]${escapeRegExp(action)}['"]`).test(perform)&&delegated.test(perform);
    if(['snapshot','click','fill','press'].includes(action))return generic&&new RegExp(`(?:action\\s*===\\s*['"]${escapeRegExp(action)}['"]|['"]${escapeRegExp(action)}['"]\\s*,)`).test(page);
    return false;
  };
  return {actions,bg,execOk,bridgeOk,route,debug:{credentials,interactionImport,semanticsImport,generic}};
}
function packageInfo(root) {
  const pack=read(root,'scripts/package-executor.mjs'),build=read(root,'native-extension/build.mjs'),core=read(root,'native-extension/core.mjs'),install=read(root,'native-bridge/install.py');
  let manifest={};try{manifest=JSON.parse(read(root,'native-extension/manifest.json'));}catch{}
  const modules=arrayLiteral(pack,'const modules ='),inputs=arrayLiteral(pack,'const inputs ='),depBody=objectBody(build,'const dependencies ='),buildFiles=arrayLiteral(build,'for (const file of [');
  const hasDep=(target,source)=>new RegExp(`['"]${escapeRegExp(target)}['"]\\s*:\\s*path\\.join\\(repo,\\s*['"]${escapeRegExp(source)}['"]\\)`).test(depBody);
  // 中文注释：当前桥接候选包不包含独立 Node 引擎或其依赖锁文件。
  const plugin=read(root,'executor-plugin/plugin.yaml');
  const pluginOk=/python_dependencies:\s*\[\s*\]/.test(plugin)&&/copyTree\(path\.join\(source,'executor-plugin'\),path\.join\(output,'browser-link'\)\)/.test(pack);
  const base=inputs.includes('executor-plugin')&&inputs.includes('native-bridge')&&inputs.includes('native-extension')&&inputs.includes('browser-workspaces')
    &&/copyTree\(path\.join\(source,'native-bridge'\),path\.join\(output,'browser-link','native_bridge'\)\)/.test(pack)
    &&/path\.join\(source,'native-extension\/build\.mjs'\)/.test(pack)&&pluginOk;
  const ext=manifest.background?.service_worker==='background.mjs'&&buildFiles.includes('manifest.json')&&buildFiles.includes('background.mjs')&&buildFiles.includes('bridge.mjs')
    &&/writeFile\(path\.join\(dest, 'core\.mjs'\)/.test(build)&&/path\.join\(source,'native-extension\/build\.mjs'\)/.test(pack);
  const semantics=modules.includes('page-semantics')&&hasDep('vendor/page-semantics.mjs','page-semantics/index.js')&&core.includes("from '../page-semantics/index.js'")&&build.includes("from '../page-semantics/index.js'");
  const interactions=modules.includes('browser-interactions')&&hasDep('vendor/browser-interactions.mjs','browser-interactions/index.mjs')&&core.includes("from '../browser-interactions/index.mjs'")&&build.includes("from '../browser-interactions/index.mjs'");
  // 中文注释：原生文件上传由私有登记模块提供，不依赖已删除的 Node 实验模块。
  const files=pack.includes('native-bridge/artifacts.py')&&install.includes('"artifacts.py"')
    &&read(root,'native-bridge/artifacts.py').includes('class ArtifactStore');
  const workspace=hasDep('vendor/browser-workspaces.mjs','browser-workspaces/index.mjs')&&inputs.includes('browser-workspaces')&&build.includes("from '../browser-workspaces/index.mjs'");
  const api=pack.includes('native-bridge/api_client.py')&&/copyTree\(path\.join\(source,'native-bridge'\),path\.join\(output,'browser-link','native_bridge'\)\)/.test(pack);
  const actionDependency=action=>action==='files.upload'?base&&ext&&files:action.startsWith('files.')?false:action.startsWith('interaction.')?base&&ext&&interactions:
    ['ref_click','ref_set_checked','ref_select_option'].includes(action)?base&&ext&&semantics&&interactions:
    ['semantic_snapshot','ref_fill','ref_press'].includes(action)?base&&ext&&semantics:action==='api_request'?base&&ext&&api:base&&ext&&workspace;
  return {base,ext,semantics,interactions,files,workspace,api,modules,inputs,actionDependency,
    debug:{buildFiles,copyModuleLoop:/for\(const module of modules\)/.test(pack),coreWritten:/writeFile\(path\.join\(dest, 'core\.mjs'\)/.test(build)}};
}

export function analyzeRepository(root=rootDefault) {
  root=resolve(root);
  const missing=CHECKER_INPUTS.filter(x=>!hasFile(root,x));
  const parsed=pythonAnalysis(root), native=parsed.native||{}, daemonInfo=parsed.daemon||{};
  const extension=extensionInfo(root), packaged=packageInfo(root);
  const candidates=[...new Set([...(native.public||[]),...(native.deferred||[])])].sort();
  const actions=candidates.map(action=>{
    const publicAction=(native.public||[]).includes(action), deferred=(native.deferred||[]).includes(action);
    const schema=publicAction&&(native.schema||[]).includes(action);
    const daemon=(daemonInfo.allowlist||[]).includes(action)&&(daemonInfo.required||[]).includes(action)&&daemonInfo.validator===true&&daemonInfo.dispatch===true;
    const ext=extension.route(action), pkg=packaged.actionDependency(action);
    const layers={declaration:publicAction||deferred,schema,daemon,extension:ext,package:pkg};
    const gaps=[], add=(code,layer,detail)=>gaps.push({code,layer,detail});
    if(!publicAction)add('not_in_public_tool','schema','Only the deferred action-schema table declares this action; no active public tool schema exposes it.');
    if(!schema)add('missing_public_schema','schema','The registered browser_shared_run action enum or its parameter validator does not expose this action.');
    if(!daemon)add('missing_daemon_allowlist','daemon','The daemon allowlist, per-action required-field validation, or shared.run dispatch omits this action.');
    if(!ext)add('missing_extension_route','extension','The extension Bridge/Executor dispatch path does not implement this action.');
    if(!pkg)add('missing_package_dependency','package','The release packager does not stage this action runtime and its required local/dependency closure.');
    const supported=Object.values(layers).every(Boolean);
    return {action,declaredBy:[...(publicAction?['browser_shared_run']:[]),...(deferred?['deferred_action_schema']:[])],layers,supported,
      classification:supported?'integrated':pkg&&!schema?'module_only_or_deferred':'incomplete',gaps};
  });
  const gaps=actions.flatMap(row=>row.gaps.map(gap=>({action:row.action,...gap})));
  if(parsed.error)gaps.push({action:null,code:'python_static_analysis_failed',layer:'checker',detail:parsed.error});
  for(const file of missing)gaps.push({action:null,code:'missing_checker_input',layer:'checker',detail:file});
  const integrated=actions.filter(x=>x.supported).length;
  const parentChecklist=[];
  for(const gap of gaps){const key=`${gap.layer}:${gap.code}`;let row=parentChecklist.find(x=>x.key===key);if(!row){row={key,layer:gap.layer,code:gap.code,actions:[]};parentChecklist.push(row);}if(gap.action&&!row.actions.includes(gap.action))row.actions.push(gap.action);}
  parentChecklist.forEach(x=>x.actions.sort());
  return {schemaVersion:'v1.1.integration-check/v1',checker:'scripts/check-v1.1-integration.mjs',status:gaps.length?'fail':'pass',
    summary:{declaredActions:actions.length,integratedActions:integrated,unsupportedActions:actions.length-integrated,gapCount:gaps.length},
    sourceAnalysis:{pythonAst:!parsed.error,extensionDispatch:extension.bg&&extension.execOk&&extension.bridgeOk,
      packageClosure:packaged.base&&packaged.ext,missingInputs:missing,
      declarations:{publicActionCount:(native.public||[]).length,activeSchemaActionCount:(native.schema||[]).length,
        deferredActionCount:(native.deferred||[]).length,toolRegistration:native.toolRegistration===true,details:native.debug},
      daemon:{allowlistActionCount:(daemonInfo.allowlist||[]).length,requiredActionCount:(daemonInfo.required||[]).length,
        validator:daemonInfo.validator===true,dispatch:daemonInfo.dispatch===true,details:daemonInfo.debug},
      extension:{background:extension.bg,execute:extension.execOk,bridge:extension.bridgeOk,details:extension.debug},
      package:{base:packaged.base,extension:packaged.ext,moduleCount:packaged.modules.length,
        inputCount:packaged.inputs.length,
        pageSemantics:packaged.semantics,browserInteractions:packaged.interactions,
        browserFiles:packaged.files,workspaces:packaged.workspace,apiClient:packaged.api,details:packaged.debug}},actions,gaps,parentChecklist};
}

function main(argv){
  let root=rootDefault,output=null;
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--root'&&argv[i+1])root=resolve(argv[++i]);
    else if(argv[i]==='--output'&&argv[i+1])output=resolve(argv[++i]);
    else if(argv[i]==='--help'){console.log('Usage: node scripts/check-v1.1-integration.mjs [--root DIR] [--output FILE]');return 0;}
    else{console.error('Usage: node scripts/check-v1.1-integration.mjs [--root DIR] [--output FILE]');return 2;}
  }
  const report=analyzeRepository(root),json=JSON.stringify(report,null,2)+'\n';
  if(output)writeFileSync(output,json);else process.stdout.write(json);
  return report.status==='pass'?0:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main(process.argv.slice(2));
