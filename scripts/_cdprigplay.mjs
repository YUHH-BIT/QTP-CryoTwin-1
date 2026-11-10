// 播放态跟拍平顺性：node scripts/_cdprigplay.mjs <baseUrl> <startT> <port> [samples] [gapSec]
// 真正点播放，连续采 __cam().rig，看机位是否有跳变、水头是否始终在视锥内。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const base = process.argv[2] || 'http://127.0.0.1:8765/';
const startT = Number(process.argv[3] || 280);
const PORT = Number(process.argv[4] || 9375);
const N = Number(process.argv[5] || 8);
const GAP = Number(process.argv[6] || 8) * 1000;
const W = 1600, H = 900;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-play-'));
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
      const p = list.find(x => x.type === 'page');
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
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 120000);
  });
}

try {
  const ws = new WebSocket(await getWs());
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws open failed')));
  });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  const errs = [];
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push((d.exception || {}).description || d.text);
    }
  });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: `${base}?t=${startT}` });
  let ready = false;
  for (let k = 0; k < 300; k++) {
    try {
      const r = await send('Runtime.evaluate', { expression: 'window.__ready===true', returnByValue: true });
      if (r.result && r.result.value === true) { ready = true; break; }
    } catch (e) { }
    await sleep(500);
  }
  if (!ready) throw new Error('not ready');
  await send('Runtime.evaluate', { expression: `document.getElementById('btn-play').click()` });
  console.log('PLAY clicked from t=' + startT);

  const rows = [];
  for (let i = 0; i < N; i++) {
    await sleep(GAP);
    const r = await send('Runtime.evaluate', {
      expression: `JSON.stringify(window.__cam())`, returnByValue: true,
    });
    const c = JSON.parse(r.result.value);
    rows.push({ i, t: c.t, pos: c.pos, rig: c.rig, autoFly: c.autoFly,
                flight: c.flight, clear: c.clearance, headInView: c.waterHeadInView,
                camToHead: c.camToWaterHead });
    console.log(`#${i} t=${c.t} s=${c.rig ? c.rig.s : '-'} back=${c.rig ? c.rig.back : '-'} fill=${c.rig ? c.rig.fill : '-'} clear=${c.clearance} headInView=${c.waterHeadInView} camToHead=${c.camToWaterHead} flight=${c.flight}`);
  }
  // 轨迹判据：相邻采样的机位位移（SwiftShader 低帧率下数值会偏大，只看有无突跳）
  let worst = 0, worstAt = -1;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].pos, b = rows[i].pos;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d > worst) { worst = d; worstAt = i; }
    console.log(`move #${i - 1}->#${i}: ${Math.round(d)} m`);
  }
  console.log(`WORST_MOVE ${Math.round(worst)} m at #${worstAt}`);
  console.log(`HEAD_IN_VIEW ${rows.filter(r => r.headInView).length}/${rows.length}`);
  console.log(`FLIGHT_ANY ${rows.some(r => r.flight)}`);
  console.log('EXCEPTIONS ' + errs.length + (errs.length ? ' :: ' + errs.slice(0, 2).join(' | ') : ''));
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
