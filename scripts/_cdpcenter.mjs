// CDP 探针：核对「居中中轴线 + 前锋口径 + 跟拍构图」
// 用法: node scripts/_cdpcenter.mjs [baseUrl] [t1,t2,...] [outDir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const TS = (process.argv[3] || '180,300,420').split(',').map(Number);
const OUT = process.argv[4] || 'F:/QTP‑CryoTwin/.workbuddy/tmp/';
const W = 1280, H = 800, PORT = 9341;

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
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { }
    await sleep(400);
  }
  throw new Error('CDP not ready');
}
function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id; pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 240000);
  });
}

const REPORT = `JSON.stringify({
  ready: !!window.__ready, err: window.__err || '',
  haz: (window.__hazCenter ? window.__hazCenter() : null),
  cam: (window.__cam ? window.__cam() : null),
  frontS: (window.__flood ? Math.round(window.__flood.frontS) : null),
  pathPct: (window.__flood && window.__flood.channel ? +(100*window.__flood.frontS/window.__flood.channel.lengthM).toFixed(1) : null),
  tComp: (window.__flood ? +window.__flood.tComp.toFixed(4) : null),
  sOff: (window.__flood ? window.__flood.sOff : null),
  profTEnd: (window.__flood ? window.__flood.profT[window.__flood.profT.length-1] : null)
})`;

const rows = [];
try {
  const ws = new WebSocket(await getWs());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  for (const t of TS) {
    const sep = BASE.includes('?') ? '&' : '?';
    const url = `${BASE}${sep}t=${t}&follow=1&codeNew=${Date.now()}`;
    await send('Page.navigate', { url });
    await sleep(48000);   // SwiftShader 下首屏要 35~45 s（8K 影像 + 1001² DEM）
    let info = '';
    try {
      const r = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true });
      info = r.result && r.result.value ? r.result.value : '';
    } catch (e) { info = '{"eval":"fail"}'; }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const png = path.join(OUT, `center_t${t}.png`);
    fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
    try { rows.push(JSON.parse(info)); } catch (e) { rows.push({ raw: info }); }
    console.log(`t=${t} -> ${png}`);
    console.log('  ' + info.slice(0, 600));
  }
  fs.writeFileSync(path.join(OUT, 'center_report.json'), JSON.stringify(rows, null, 1));
} catch (e) {
  console.error('FAIL ' + (e && e.message));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
