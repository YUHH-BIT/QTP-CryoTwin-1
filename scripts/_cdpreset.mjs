// 「重置视角」行为验收：在洪水航拍中点击重置，检查相机是否真的回全景且不被拉回。
// node scripts/_cdpreset.mjs "<url>"
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const W = 1600, H = 900, PORT = 9341;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-reset-'));
const child = spawn(EDGE, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions',
  `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const p = list.find(t => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch (e) { }
    await sleep(400);
  }
  throw new Error('CDP not ready');
}
function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id; pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 90000);
  });
}

try {
  const ws = new WebSocket(await getWs());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url });
  await sleep(75000);

  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
  const cam = async () => JSON.parse(await ev('JSON.stringify(window.__cam && window.__cam())'));

  if (process.argv[3] === 'play') {
    await ev(`document.getElementById('btn-play').click()`);
    await sleep(4000);
    const p0 = await cam();
    console.log('PLAYING', JSON.stringify({ autoFly: p0.autoFly, t: p0.t, dist: p0.dist }));
  }
  const before = await cam();
  console.log('BEFORE(航拍)', JSON.stringify({ pos: before.pos, dist: before.dist, cineCam: before.cineCam, autoFly: before.autoFly }));

  await ev(`document.getElementById('btn-reset').click()`);
  await sleep(1200);
  const mid = await cam();
  await sleep(2500);
  const a1 = await cam();
  await sleep(2500);
  const a2 = await cam();

  await sleep(4000);
  const a3 = await cam();
  console.log('AFTER 10s  ', JSON.stringify({ dist: a3.dist, clearance: a3.clearance, autoFly: a3.autoFly }));
  // 飞行本身要几秒（软件渲染更慢），所以静止判据用最后两帧比
  const drift = Math.hypot(a3.pos[0] - a2.pos[0], a3.pos[1] - a2.pos[1], a3.pos[2] - a2.pos[2]);
  console.log('AFTER 1.2s ', JSON.stringify({ dist: mid.dist, cineCam: mid.cineCam, autoFly: mid.autoFly, flight: mid.flight }));
  console.log('AFTER 3.7s ', JSON.stringify({ dist: a1.dist, clearance: a1.clearance }));
  console.log('AFTER 6.2s ', JSON.stringify({ dist: a2.dist, clearance: a2.clearance }));
  console.log('DRIFT(3.7→6.2s) =', drift.toFixed(1), 'm  (静止应 < 5 m)');
  const ok = !a3.cineCam && !a3.autoFly && drift < 5 && a3.dist > 12000;
  console.log(ok ? 'PASS 重置视角回到全景且不再被抢回' : 'FAIL');
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
