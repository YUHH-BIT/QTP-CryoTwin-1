// 水层开/关 A/B 像素差：一次会话内截两张图（关掉 UI 浮层），供 Python 求差集
// 用法: node scripts/_cdpwater_ab.mjs <url> <prefix> [waitSec] [ratio]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const prefix = process.argv[3];
const waitSec = Number(process.argv[4] || 24);
const ratio = Number(process.argv[5] || 0.985);
const W = 1280, H = 760, PORT = 9337;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp5-'));
const child = spawn(EDGE, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions',
  `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const l = await r.json();
      const p = l.find(t => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch (e) { }
    await sleep(400);
  }
  throw new Error('CDP not ready');
}
function cdp(ws) {
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 90000);
  });
}

try {
  const ws = new WebSocket(await getWs());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(waitSec * 1000);
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;

  // 跳到指定时刻；关掉自动运镜（浮层不隐藏，Python 侧按画布区域裁剪）
  await ev(`(() => {
    const t = document.getElementById('tl-track');
    if (t) { const r = t.getBoundingClientRect();
      t.dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width*${ratio}, clientY: r.top + r.height/2, bubbles: true })); }
    if (window.__flood) window.__flood.setLayers({ flood: true, debris: true, spray: true });
  })()`);
  await sleep(7000);

  const a = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(prefix + '_on.png', Buffer.from(a.data, 'base64'));

  await ev(`window.__flood.setLayers({ flood: false, debris: false, spray: false })`);
  await sleep(2500);
  const b = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(prefix + '_off.png', Buffer.from(b.data, 'base64'));

  console.log('OK ' + (await ev('JSON.stringify(window.__flood.probeHydrology())')));
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
