// 抖动量化验收：连续采样相机位姿，看位移序列的变异系数与方向翻转次数。
// 用法: node scripts/_cdpjitter.mjs <url> <waitSec> <mode:cine|follow> <outJson>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const waitSec = Number(process.argv[3] || 40);
const mode = process.argv[4] || 'cine';
const outJson = process.argv[5] || '.workbuddy/tmp/jitter.json';
const W = Number(process.env.CDP_W || 900), H = Number(process.env.CDP_H || 560), PORT = 9341;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp9-'));
const child = spawn(EDGE, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions',
  `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
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
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 180000);
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

  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result ? r.result.value : null;
  };
  console.log('chan ' + await ev('JSON.stringify(window.__chan ? window.__chan() : null)'));
  if (mode === 'cine') console.log('start ' + await ev("document.getElementById('btn-flood').click(), document.getElementById('btn-play').click(), 'cine+play'"));
  if (mode === 'follow') console.log('start ' + await ev("document.getElementById('btn-play').click(), 'play'"));
  // 提速到 4x：14 s 采样才能覆盖足够长的里程（否则水头只走 500 m，位移量淹没噪声）
  console.log('speed ' + await ev(`(() => {
    const b = [...document.querySelectorAll('button,[data-speed]')].find(e => /4x|4×/.test(e.textContent || ''));
    if (b) { b.click(); return '4x ' + b.textContent.trim(); }
    return 'no 4x button';
  })()`));
  await sleep(6000);

  const raw = await ev(`(async () => {
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 14000) {
      const c = window.__cam && window.__cam();
      if (c) out.push({ t: +(performance.now() - t0).toFixed(0), p: c.pos, q: c.target, s: c.rig ? c.rig.s : null });
      await new Promise(r => setTimeout(r, 60));
    }
    return JSON.stringify(out);
  })()`);
  if (typeof raw !== 'string' || raw.startsWith('EXC')) throw new Error('probe failed: ' + raw);
  const arr = JSON.parse(raw);
  console.log('samples ' + arr.length);

  const D = [], DT = [];
  for (let i = 1; i < arr.length; i++) {
    const a = arr[i - 1].p, b = arr[i].p;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (d < 1e-6) continue;                     // 同一帧重复采样
    D.push(d); DT.push(arr[i].t - arr[i - 1].t);
  }
  const mean = D.reduce((a, b) => a + b, 0) / Math.max(D.length, 1);
  const sd = Math.sqrt(D.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(D.length, 1));
  // 方向翻转：连续两段位移向量夹角 > 90°
  let flips = 0;
  for (let i = 2; i < arr.length; i++) {
    const a = arr[i - 2].p, b = arr[i - 1].p, c = arr[i].p;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const nu = Math.hypot(...u), nv = Math.hypot(...v);
    if (nu < 1e-6 || nv < 1e-6) continue;
    if ((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv) < 0) flips++;
  }
  // 高度二阶差分（抖动量纲：m/frame²）
  let y2 = 0, n2 = 0;
  for (let i = 2; i < arr.length; i++) {
    const a = arr[i - 2].p[1], b = arr[i - 1].p[1], c = arr[i].p[1];
    if (Math.abs(a - b) < 1e-6 && Math.abs(b - c) < 1e-6) continue;
    y2 += Math.abs(c - 2 * b + a); n2++;
  }
  const res = {
    mode, samples: arr.length, moving: D.length,
    meanStep: +mean.toFixed(2), sdStep: +sd.toFixed(2),
    cv: +(sd / Math.max(mean, 1e-6)).toFixed(3),
    flips, flipRate: +(flips / Math.max(D.length, 1)).toFixed(3),
    yAccMean: +(y2 / Math.max(n2, 1)).toFixed(2),
    first: arr[0] ? { p: arr[0].p, s: arr[0].s } : null,
    last: arr[arr.length - 1] ? { p: arr[arr.length - 1].p, s: arr[arr.length - 1].s } : null,
    rig: await ev('JSON.stringify(window.__rigdbg ? window.__rigdbg() : null)'),
  };
  fs.writeFileSync(outJson, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
  const img = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outJson.replace(/\.json$/, '.png'), Buffer.from(img.data, 'base64'));
  console.log('OK');
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
