// CDP 截图：真实时间等待（Cesium 依赖真实时钟推进瓦片加载，virtual-time 会失效）
// 用法: node scripts/_cdpshot.mjs <url> <outPng> [waitSec=18] [w=1280] [h=800]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const out = process.argv[3];
const waitSec = Number(process.argv[4] || 18);
const W = Number(process.argv[5] || 1280);
const H = Number(process.argv[6] || 800);
const PORT = 9333;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));
const child = spawn(EDGE, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions',
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
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws error')));
  });
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url });
  await sleep(waitSec * 1000);

  let info = '';
  try {
    const r = await send('Runtime.evaluate', {
      expression: `JSON.stringify({hint: (document.getElementById('hint')||{}).innerText||'',
        ready: !!window.__cesiumReady, err: window.__cesiumError||''})`,
      returnByValue: true,
    });
    info = r.result && r.result.value ? r.result.value : '';
  } catch (e) { info = 'eval-fail'; }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  fs.writeFileSync(out + '.json', info || '');
  console.log('OK ' + out + ' ' + info.slice(0, 300));
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
