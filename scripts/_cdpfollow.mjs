// 「全链条推演」跟拍机位的构图体检：
// node scripts/_cdpfollow.mjs <baseUrl> [waitSec] [t1,t2,t3...]
// 逐个时刻打开页面（?t=&follow=1），读取相机/水头，并把水头与沟道若干点投影到屏幕，
// 输出：水头在画面中的归一化坐标、俯角、镜头到水头距离、水体在画面里的高度占比。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const base = process.argv[2];
const waitSec = Number(process.argv[3] || 62);
const times = (process.argv[4] || '60,180,300,420').split(',').map(Number);
const W = 1600, H = 900, PORT = 9338;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-follow-'));
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

// 在页面里做几何计算：投影、俯角、水体屏幕包围盒
const PROBE = `(function(){
  const c = window.__cam();
  const F = window.__flood;
  const cam = window.__camera;   // 若未暴露则只用 __cam 的数值
  const out = { t: c.t, pos: c.pos, target: c.target, dist: c.dist,
                head: c.waterHead, headInView: c.waterHeadInView,
                camToHead: c.camToWaterHead, clearance: c.clearance };
  if (!window.__frameProbe) return JSON.stringify(out);
  return JSON.stringify(Object.assign(out, window.__frameProbe()));
})()`;

try {
  const ws = new WebSocket(await getWs());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  const errs = [];
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
  });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  const rows = [];
  for (const t of times) {
    await send('Page.navigate', { url: `${base}?t=${t}&follow=1` });
    await sleep(waitSec * 1000);
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    rows.push(JSON.parse(r.result.value));
    // 只在中间时刻截图，避免软件渲染拖太久
  }
  console.log(JSON.stringify({ rows, exceptions: errs }, null, 1));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(os.tmpdir(), 'follow_shot.png'), Buffer.from(shot.data, 'base64'));
  console.log('SHOT ' + path.join(os.tmpdir(), 'follow_shot.png'));
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
