// 诊断 rig.fill：node scripts/_cdpfilldiag.mjs <baseUrl> <t> <port> [waitSec]
// 打开 ?t=&follow=1，输出 __rigFillDiag(40/90/160) 与当前相机状态。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const base = process.argv[2] || 'http://127.0.0.1:8765/';
const t = Number(process.argv[3] || 300);
const PORT = Number(process.argv[4] || 9390);
const waitSec = Number(process.argv[5] || 40);
const W = 1600, H = 900;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-fd-'));
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
  await send('Page.navigate', { url: `${base}?t=${t}&follow=1` });
  let ready = false;
  for (let k = 0; k < 300; k++) {
    try {
      const r = await send('Runtime.evaluate', { expression: 'window.__ready===true', returnByValue: true });
      if (r.result && r.result.value === true) { ready = true; break; }
    } catch (e) { }
    await sleep(500);
  }
  if (!ready) throw new Error('not ready; errs=' + errs.slice(-2).join('|'));
  await sleep(waitSec * 1000);
  const expr = `(function(){try{
    const c=window.__cam();
    return JSON.stringify({cam:c, diag40:window.__rigFillDiag(40), diag90:window.__rigFillDiag(90), diag160:window.__rigFillDiag(160)});
  }catch(e){return JSON.stringify({err:String(e&&e.stack||e)});}})()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(r.result.value);
  console.log('EXCEPTIONS ' + errs.length + (errs.length ? ' :: ' + errs.slice(0, 3).join(' | ') : ''));
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
