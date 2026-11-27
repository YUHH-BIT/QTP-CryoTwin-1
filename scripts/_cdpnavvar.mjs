// 导航风格变体对比截图：A=扁平+填充胶囊(已落地) / B=下划线 tab / C=玻璃胶囊条
// 用法: node scripts/_cdpnavvar.mjs <url> <outPrefix> [w=1670] [h=900] [waitSec=12]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const prefix = process.argv[3];
const W = Number(process.argv[4] || 1670);
const H = Number(process.argv[5] || 900);
const waitSec = Number(process.argv[6] || 12);
const PORT = 9600 + Math.floor(Math.random() * 200);

const VARIANTS = {
  A: '',
  B: `
    .topbar .nav-links a.active { background: none; border-color: transparent; color: #e8f1fb; }
    .topbar .nav-links a.active::after {
      content: ''; position: absolute; left: 10px; right: 10px; bottom: 2px; height: 2px;
      border-radius: 2px; background: linear-gradient(90deg, #7dd3fc, #3b82f6);
      box-shadow: 0 0 8px rgba(125,211,252,.55);
    }
    .topbar .nav-links a:hover:not(.active) { background: none; color: #e8f1fb; }
  `,
  C: `
    .topbar .nav-links {
      background: rgba(30, 41, 59, 0.55);
      border: 1px solid rgba(148, 163, 184, 0.14);
      border-radius: 11px; padding: 4px; gap: 2px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
    }
    .topbar .nav-links a { border-color: transparent; }
    .topbar .nav-links a.active {
      background: linear-gradient(180deg, rgba(59,130,246,.38), rgba(37,99,235,.26));
      border-color: rgba(125,211,252,.32); color: #eaf6ff;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.10), 0 2px 10px rgba(37,99,235,.22);
    }
  `,
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgevar-'));
const child = spawn(EDGE, [
  '--headless=new', '--hide-scrollbars', '--no-first-run', '--disable-extensions',
  `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* not ready */ }
    await sleep(400);
  }
  throw new Error('CDP not ready');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 60000);
  });
}

try {
  const wsUrl = await getWs();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws error'))); });
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(waitSec * 1000);

  await send('Runtime.evaluate', {
    expression: `(()=>{const o=document.getElementById('loading-overlay');if(o)o.style.setProperty('display','none','important');})()`,
  });

  const names = { A: 'A_flat_pill', B: 'B_underline_tab', C: 'C_glass_bar' };
  for (const [key, css] of Object.entries(VARIANTS)) {
    await send('Runtime.evaluate', {
      expression: `(()=>{let s=document.getElementById('navvar');if(!s){s=document.createElement('style');s.id='navvar';document.head.appendChild(s);}s.textContent=${JSON.stringify(css)};})()`,
    });
    await sleep(350);
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: W, height: 72, scale: 2 },
    });
    const out = `${prefix}_${names[key]}.png`;
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('OK ' + out);
  }
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
