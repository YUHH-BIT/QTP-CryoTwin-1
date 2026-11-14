// 单次探针：打开页面 → 等就绪 → 打印指定表达式结果（可选截图）
// 用法: node scripts/_cdpeval.mjs <url> <waitSec> "<expr>" [outPng]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_ = process.argv[2];
const WAIT = Number(process.argv[3] || 50);
const EXPR = process.argv[4] || '1';
const OUT = process.argv[5] || '';
const PORT = 9351;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));
const child = spawn(EDGE, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--window-size=1280,800',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch (e) { }
    await sleep(400);
  }
  throw new Error('no cdp');
}
const ws = new WebSocket(await getWs());
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 240000);
});
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: URL_ });
// 轮询就绪，最多 WAIT 秒
let ready = false;
for (let i = 0; i < WAIT; i++) {
  await sleep(1000);
  try {
    const r = await send('Runtime.evaluate', { expression: '!!window.__ready', returnByValue: true });
    if (r.result && r.result.value) { ready = true; break; }
  } catch (e) { }
}
await sleep(12000);   // 等摇臂切入动画（intro）走完再量
let out = '';
try {
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
  out = typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value);
} catch (e) { out = 'EVALFAIL ' + e.message; }
console.log('ready=' + ready);
console.log(out);
if (OUT) {
  await sleep(7000);   // 等一帧渲染（SwiftShader 可能只有 0.25 fps）
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('shot ' + OUT);
  } catch (e) { console.log('shot FAIL ' + e.message); }
}
try { child.kill(); } catch (e) { }
await sleep(200);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
process.exit(0);
