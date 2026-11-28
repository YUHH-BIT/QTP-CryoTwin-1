/**
 * 首帧渲染自检（2026-11-28）
 *
 * 目的：验证「脚本还没跑时」顶栏是否已是最终形态，即刷新不再闪旧样式。
 * 做法：Emulation.setScriptExecutionDisabled(true) 关闭 JS 后加载页面，
 *       量 .searchbar / 导航 active / 身份区——这正是浏览器首帧能看到的样子。
 *       再开 JS 重载一次，确认没有重复图标、位置不跳。
 *
 * 用法：node scripts/_firstpaint.mjs   （需 5000 端口已起服务）
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const BASE = 'http://127.0.0.1:5000';
const OUT = 'F:/QTP‑CryoTwin/.runtime/shots';

const PAGES = [
  ['index.html', 'index'],
  ['query.html', 'query'],
  ['simulate.html', 'simulate'],
  ['alert.html', 'alert'],
  ['decision.html', 'decision'],
  ['terrain3d.html', 'terrain3d'],
  ['admin.html', 'admin'],
];

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'cdp-fp-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1600,900', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      const p = list.find(t => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p;
    } catch (e) { /* waiting */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

const target = await pageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

const MEASURE = `(() => {
  const bar = document.querySelector('.searchbar');
  const input = document.getElementById('place-search');
  const user = document.getElementById('topbar-user');
  const act = document.querySelector('.nav-links a.active');
  const cs = bar ? getComputedStyle(bar) : null;
  const ir = input ? input.getBoundingClientRect() : null;
  const er = bar ? bar.getBoundingClientRect() : null;
  return {
    barClass: bar ? bar.className : null,
    iconCount: bar ? bar.querySelectorAll('.cmd-icon').length : 0,
    barBg: cs ? cs.backgroundColor : null,
    barRadius: cs ? cs.borderRadius : null,
    barH: cs ? cs.height : null,
    inputW: ir ? Math.round(ir.width) : null,
    searchRight: er ? Math.round(er.right) : null,
    searchLeft: er ? Math.round(er.left) : null,
    navActive: act ? (act.textContent || '').trim() : null,
    userW: user ? Math.round(user.getBoundingClientRect().width) : null,
    overflowX: document.documentElement.scrollWidth > window.innerWidth
  };
})()`;

async function settle() {
  for (let i = 0; i < 40; i++) {
    const s = await evaluate('document.readyState').catch(() => null);
    if (s === 'complete') break;
    await sleep(200);
  }
  await sleep(700);
}

async function shotRegion(name, x, y, w, h, scale = 2) {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width: w, height: h, scale },
    captureBeyondViewport: true
  });
  writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

const report = [];

for (const [file, name] of PAGES) {
  const url = `${BASE}/${file}`;
  // ---- 1) JS 关闭：等于浏览器首帧能看到的状态 ----
  await send('Emulation.setScriptExecutionDisabled', { value: true });
  await send('Page.navigate', { url });
  await settle();
  const noJS = await evaluate(MEASURE);
  if (name === 'index') await shotRegion('firstpaint_nojs_index.png', 0, 0, 1600, 90);

  // ---- 2) JS 开启：最终稳定态 ----
  await send('Emulation.setScriptExecutionDisabled', { value: false });
  await send('Page.navigate', { url });
  await settle();
  const withJS = await evaluate(MEASURE);

  report.push({ page: file, noJS, withJS });
  console.log(`=== ${file}`);
  console.log(`  noJS  : icon=${noJS.iconCount} barClass="${noJS.barClass}" bg=${noJS.barBg} r=${noJS.barRadius} h=${noJS.barH} inputW=${noJS.inputW} left=${noJS.searchLeft} navActive=${noJS.navActive} userW=${noJS.userW}`);
  console.log(`  withJS: icon=${withJS.iconCount} barClass="${withJS.barClass}" bg=${withJS.barBg} r=${withJS.barRadius} h=${withJS.barH} inputW=${withJS.inputW} left=${withJS.searchLeft} navActive=${withJS.navActive} userW=${withJS.userW}`);
  console.log(`  delta left=${withJS.searchLeft - noJS.searchLeft}px  overflowX=${withJS.overflowX}`);
}

writeFileSync(path.join(OUT, 'firstpaint.json'), JSON.stringify(report, null, 2));
console.log('\nwritten:', path.join(OUT, 'firstpaint.json'));
ws.close();
chrome.kill();
