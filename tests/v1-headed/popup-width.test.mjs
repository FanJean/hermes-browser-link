import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';

// 复用浏览器交互模块的测试依赖，不再读取已删除的独立执行器。
const require = createRequire(new URL('../../browser-interactions/package.json', import.meta.url));
const {chromium} = require('playwright-core');
const css = await readFile(new URL('../../native-extension/popup.css', import.meta.url), 'utf8');

// 中文注释：Edge 初始宽度较窄，弹窗仍应保持 360px 的可读宽度。
test('production popup retains readable width at initial narrow viewport', async () => {
  // 中文注释：宽度验收同样只用新 profile，并保留真实 HOME。
  const work=await mkdtemp('/tmp/hermes-popup-'),profile=path.join(work,'profile'),temp=path.join(work,'tmp');
  await mkdir(temp);
  let browser;
  try{
  browser = await chromium.launchPersistentContext(profile,{
    executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    headless: true,args:['--use-mock-keychain','--password-store=basic'],
    env:{HOME:process.env.HOME,HERMES_HOME:path.join(work,'hermes'),TMPDIR:temp,PATH:process.env.PATH||'/usr/bin:/bin',LANG:process.env.LANG||'en_US.UTF-8'}
  });
    const page = await browser.newPage();await page.setViewportSize({width:138,height:600});
    await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main class="popup"><header class="header"><div class="brand">Hermes 浏览器</div></header><section class="connection-card"><h1>已连接</h1></section></main>`);
    const actual = await page.evaluate(() => document.body.getBoundingClientRect().width);
    assert.ok(actual >= 360, `action popup collapsed to ${actual}px`);
  } finally {
    await browser?.close();await rm(work,{recursive:true,force:true});
  }
});
