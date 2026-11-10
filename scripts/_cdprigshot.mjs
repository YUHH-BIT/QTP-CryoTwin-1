// 定点机位截图：node scripts/_cdprigshot.mjs <baseUrl> <t> <outPrefix> <waitSec> "back,lat,H,ahead" ...
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const base = process.argv[2] || 'http://127.0.0.1:8765/';
const t = Number(process.argv[3] || 300);
const prefix = process.argv[4] || path.join(os.tmpdir(), 'rig_');
const waitSec = Number(process.argv[5] || 30);
const rest = process.argv.slice(6);
const portAtEnd = rest.length > 1 && /^\d{4,5}$/.test(rest[rest.length - 1]);
const PORT = portAtEnd ? Number(rest.pop()) : 9362;
const specs = rest;
const W = 1600, H = 900;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-shot-'));
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
    const ms = method === 'Page.captureScreenshot' ? 75000 : 120000;
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, ms);
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

  for (let i = 0; i < specs.length; i++) {
    const url = `${base}?t=${t}&rig=${encodeURIComponent(specs[i])}`;
    await send('Page.navigate', { url });
    let ready = false;
    for (let k = 0; k < 300; k++) {
      try {
        const r = await send('Runtime.evaluate', { expression: 'window.__ready===true', returnByValue: true });
        if (r.result && r.result.value === true) { ready = true; break; }
      } catch (e) { }
      await sleep(500);
    }
    if (!ready) throw new Error('not ready: ' + url + ' errs=' + errs.slice(-2).join('|'));
    await sleep(waitSec * 1000);
    const info = await send('Runtime.evaluate', {
      expression: `JSON.stringify({rig:window.__rigPlaceInfo?window.__rigPlaceInfo():null,cam:window.__cam(),hydro:window.__flood?window.__flood.diagnose().hydro:null,gamma:window.__flood?window.__flood.diagnose().visualWidenGamma:null})`, returnByValue: true,
    });
    // SwiftShader 大区域截图偶发 60~75 s 超时，重试而不是直接失败
    let shot = null;
    for (let a = 0; a < 3 && !shot; a++) {
      try { shot = await send('Page.captureScreenshot', { format: 'png' }); }
      catch (e) { if (a === 2) throw e; console.log(`SHOT ${i} retry ${a + 1}: ${e.message}`); await sleep(5000); }
    }
    const file = `${prefix}${i}.png`;
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`SHOT ${i} rig=${specs[i]} -> ${file}`);
    console.log('INFO ' + info.result.value);
  }
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
