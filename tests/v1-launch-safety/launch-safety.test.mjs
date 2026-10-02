// Static only: parse source as data; never import or execute a browser runner.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const {parse} = createRequire(import.meta.url)('acorn');
const root = new URL('../', import.meta.url);
const runners = [
  // 中文注释：Cookie 双浏览器夹具复用隔离启动器，同样受启动安全约束。
  'v1.5.0/real-cookie-mirror.mjs',
  'v1.5.1/real-desktop-cookie-mirror.mjs',
  'native-extension/real-bridge.mjs',
  'native-extension/api-v2-real.mjs',
  'native-v2/real-native-v2.mjs',
  'approval-integration/real-approval.mjs',
  'approval-integration/real-api.mjs',
  // 中文注释：自动收组验收必须复用临时 profile 启动器，禁止个人 profile。
  'v1.4.3/real-autoclose.mjs',
  'v1.4.4/real-round1f.mjs',
];
const sourceFor = file => readFileSync(new URL(file, root), 'utf8');
function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...Object.values(node).flatMap(value => Array.isArray(value) ? value.flatMap(nodes) : nodes(value))];
}
function verify(source) {
  // 中文注释：复用隔离启动器的验收脚本须检查被导入的唯一启动点，而不是要求每个脚本复制启动代码。
  if(source.includes("import '../approval-integration/real-api.mjs';"))return verify(sourceFor('approval-integration/real-api.mjs'));
  if(source.includes("from '../native-v2/real-session.mjs'"))return verifyAdditional(sourceFor('native-v2/real-session.mjs'));
  const ast = parse(source, {ecmaVersion: 'latest', sourceType: 'module'});
  const all = nodes(ast);
  const text = node => source.slice(node.start, node.end).replace(/\s+/g, '');
  const calls = all.filter(n => n.type === 'CallExpression');
  const declarations = all.filter(n => n.type === 'VariableDeclarator');
  const scratch = declarations.find(n => n.id.name === 'scratch');
  assert.equal(text(scratch.init), "path.resolve(process.env.HOME,'.hermes/cache/scratch')", 'absolute scratch only');
  const launches = calls.filter(n => n.callee.name === 'spawn' && ['binary', 'choices[browser]'].includes(text(n.arguments[0])));
  assert.equal(launches.length, 1, 'exactly one recognized browser launch');
  const launch = launches[0];
  assert.equal(launch.arguments.length, 3);
  assert.equal(launch.arguments[1].type, 'ArrayExpression');
  const args = launch.arguments[1].elements;
  for (const flag of ['--use-mock-keychain', '--password-store=basic']) {
    assert.equal(args.filter(n => n.type === 'Literal' && n.value === flag).length, 1, `explicit argv ${flag}`);
  }
  const profileSwitch = '--user-' + 'data-dir=';
  const profiles = args.filter(n => n.type === 'TemplateLiteral' && n.quasis[0].value.cooked === profileSwitch);
  assert.equal(profiles.length, 1, 'one owned profile argument');
  assert.equal(profiles[0].expressions.length, 1);
  assert.equal(profiles[0].expressions[0].name, 'profile');
  const profile = declarations.find(n => n.id.name === 'profile');
  assert.ok(["path.join(work,'profile')", 'path.join(install.work,`profile-${browser}`)'].includes(text(profile.init)), 'profile must descend from owned work');
  const work = declarations.find(n => n.id.name === 'work');
  if (work) {
    assert.equal(work.init.type, 'AwaitExpression');
    assert.match(text(work.init), /^awaitmkdtemp\(path.join\(scratch,/u, 'fresh work, never a reusable PID directory');
  } else {
    const installs = all.filter(n => n.type === 'NewExpression' && n.callee.name === 'PackageInstall');
    assert.equal(installs.length, 2, 'serial and concurrent package launch');
    for (const install of installs) assert.match(text(install.arguments[0]), /^awaitmkdtemp\(path.join\(scratch,/u);
  }
  // HOME must stay the real user HOME: macOS resolves the default keychain from it, and a scratch
  // HOME makes Edge show a "keychain not found" dialog. Only HERMES_HOME/TMPDIR move into fresh work.
  assert.equal(launch.arguments[2].type, 'ObjectExpression');
  const options = launch.arguments[2].properties;
  assert.ok(options.every(p => p.type === 'Property' && ['stdio', 'detached', 'cwd', 'env'].includes(p.key.name)), 'unknown browser options');
  const env = options.find(p => p.key.name === 'env');
  if (env) {
    assert.equal(text(env.value), 'browserEnv', 'only reviewed browser environment');
    const declaration = declarations.find(n => n.id.name === 'browserEnv');
    assert.equal(declaration.init.type, 'ObjectExpression');
    const fields = declaration.init.properties;
    assert.ok(fields.every(p => p.type === 'Property'), 'no environment spreads');
    assert.deepEqual(fields.map(p => p.key.name).sort(), ['HERMES_HOME','HOME','LANG','PATH','TMPDIR']);
    const value = key => text(fields.find(p => p.key.name === key).value);
    assert.equal(value('HOME'), 'process.env.HOME', 'browser keeps real HOME for the macOS keychain');
    assert.equal(value('HERMES_HOME'), "path.join(scratchHome,'.hermes')");
    assert.equal(value('TMPDIR'), 'temp');
    assert.ok(["path.join(work,'h')", "path.join(work,'home')"].includes(text(declarations.find(n => n.id.name === 'scratchHome').init)));
    assert.equal(text(declarations.find(n => n.id.name === 'temp').init), "path.join(work,'tmp')");
    assert.equal(value('PATH'), "process.env.PATH||'/usr/bin:/bin:/usr/sbin:/sbin'");
    assert.equal(value('LANG'), "process.env.LANG||'en_US.UTF-8'");
  }
  for (const n of all) {
    if (['AssignmentExpression', 'UpdateExpression'].includes(n.type)) {
      const target = text(n.left || n.argument);
      assert.ok(!/process\.env(?:\.HOME|\[['"]HOME['"]\])|^process\.env$/u.test(target), 'must preserve HOME');
    }
    if (n.type === 'Literal' && typeof n.value === 'string') {
      assert.doesNotMatch(n.value, /Library\/(?:Keychains|Application Support\/(?:Microsoft Edge|Google\/Chrome))|(?:^|[\\/])(?:Login Data|Cookies)$|\/Users\//u, 'no personal browser/keychain paths');
    }
  }
}
for (const file of runners) test(`temporary-profile launch policy: ${file}`, () => verify(sourceFor(file)));
// These are mitigation checks, not a macOS keychain sandbox or incident diagnosis.
test('negative fixtures reject flags in comments, personal profile, HOME override and reused work', () => {
  const source = sourceFor('approval-integration/real-approval.mjs');
  verify(source);
  for (const flag of ['--use-mock-keychain', '--password-store=basic']) {
    assert.throws(() => verify(source.replace(`'${flag}',`, '') + `\n// ${flag}\n`));
  }
  assert.throws(() => verify(source.replace("path.join(work, 'profile')", "path.join(process.env.HOME,'Library/Application Support/Microsoft Edge')")));
  assert.throws(() => verify(source.replace('env: browserEnv', 'env:{...process.env,HOME:work}')));
  assert.throws(() => verify(source + '\nprocess.env.HOME = work;\n'));
  const isolated = source;
  verify(isolated);
  for (const [from, to] of [
    ['HOME: process.env.HOME', 'HOME:scratchHome'],
    ["path.join(work, 'h')", 'process.env.HOME'],
    ['TMPDIR: temp', 'TMPDIR:process.env.TMPDIR'],
    ['HOME: process.env.HOME', '{...process.env,HOME:process.env.HOME'],
    ["path.join(work, 'tmp')", 'process.env.TMPDIR'],
  ]) {
    assert.notEqual(isolated.replace(from, to), isolated);
    assert.throws(() => verify(isolated.replace(from, to)));
  }
  assert.throws(() => verify(source.replace('await mkdtemp(path.join(scratch, `n${browser[0]}-`))', "path.join(scratch,'reused')")));
});

// 中文注释：补充未纳入原五个脚手架的启动器，浏览器 HOME 必须保留，profile 必须来自 mkdtemp。
function verifyAdditional(source){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),all=nodes(ast);
 const raw=node=>source.slice(node.start,node.end).replace(/\s+/g,'');
 const declarations=all.filter(node=>node.type==='VariableDeclarator');
 const resolve=node=>node?.type==='Identifier'?declarations.find(row=>row.id.name===node.name)?.init:node;
 const launch=all.find(node=>node.type==='CallExpression'&&(node.callee.name==='spawn'||node.callee.property?.name==='launchPersistentContext'||node.callee.property?.name==='launch'));
 assert.ok(launch,'必须有明确的浏览器启动调用');
 const options=resolve(launch.arguments.at(-1));
 const fields=options.properties;
 const environment=resolve(fields.find(field=>field.key.name==='env')?.value);
 assert.equal(environment?.type,'ObjectExpression','必须显式隔离浏览器环境');
 assert.ok(environment.properties.every(field=>field.type==='Property'));
 assert.equal(raw(environment.properties.find(field=>field.key.name==='HOME')?.value),'process.env.HOME');
 const args=launch.callee.name==='spawn'?launch.arguments[1]:fields.find(field=>field.key.name==='args')?.value;
 for(const flag of ['--use-mock-keychain','--password-store=basic'])assert.ok(args?.elements.some(node=>node.type==='Literal'&&node.value===flag));
 const profile=declarations.find(node=>node.id.name==='profile');assert.equal(raw(profile.init),"path.join(work,'profile')");
 const work=declarations.find(node=>node.id.name==='work');assert.match(raw(work.init),/^awaitmkdtemp\(/);
 if(launch.callee.name!=='spawn')assert.equal(launch.callee.property.name,'launchPersistentContext');
}
for(const file of ['native-extension/core-press-cdp.test.mjs','v1-headed/popup-width.test.mjs','v1.1-overlay/real-overlay.mjs'])test(`补充启动安全检查：${file}`,()=>verifyAdditional(sourceFor(file)));

// 中文注释：拒绝的是个人数据库路径，不能把拒绝读取 Cookie 的 CDP 方法名误判为文件。
test('启动检查区分 Cookie 文件与方法名',()=>{
 const source=sourceFor('approval-integration/real-approval.mjs');
 verify(source+"\nconst method='Network.getAllCookies';\n");
 for(const value of ['Cookies','Login Data','/private/Cookies'])assert.throws(()=>verify(source+`\nconst forbidden=${JSON.stringify(value)};\n`));
});
