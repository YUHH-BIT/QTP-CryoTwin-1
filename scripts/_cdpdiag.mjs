// CDP 诊断：导航后等待，读取页面诊断状态 + 截图
// 用法: node scripts/_cdpdiag.mjs <url> <outPng> [waitSec] [w] [h]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const out = process.argv[3];
const waitSec = Number(process.argv[4] || 20);
const W = Number(process.argv[5] || 1280);
const H = Number(process.argv[6] || 800);
const PORT = 9334;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp2-'));
const gpuFlags = process.env.GPU === '1'
  ? ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11']
  : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'];
const child = spawn(EDGE, [
  '--headless=new', ...gpuFlags,
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
    } catch (e) { }
    await sleep(400);
  }
  throw new Error('CDP not ready');
}

function mk(ws) {
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

const logs = [];
try {
  const wsUrl = await getWs();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = mk(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  try { await send('Network.enable'); } catch (e) { }
  const badUrls = [];
  const goodUrls = [];
  let netOk = 0;
  const zCount = {};
  let flowReq = 0;
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map(a => a.value || a.description || '').join(' ');
      logs.push('[console] ' + t.slice(0, 300));
    }
    if (m.method === 'Log.entryAdded') {
      logs.push('[log:' + m.params.entry.level + '] ' + String(m.params.entry.text).slice(0, 300));
    }
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r.status === 200 || r.status === 304) {
        netOk++;
        if (goodUrls.length < 40) goodUrls.push(r.url.replace(/^http:\/\/127\.0\.0\.1:5000/, '').slice(0, 80));
      }
      else if (badUrls.length < 12) badUrls.push(r.status + ' ' + r.url.slice(0, 120));
      const mt = r.url.match(/\/tiles\/imagery\/(\d+)\//);
      if (mt) zCount[mt[1]] = (zCount[mt[1]] || 0) + 1;
      const mf = r.url.match(/\/tiles\/flow\/frame_(\d+)/);
      if (mf) flowReq++;
    }
  });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(waitSec * 1000);

  let info = '';
  try {
    const r = await send('Runtime.evaluate', {
      expression: `window.__dbg ? JSON.stringify(window.__dbg()) : JSON.stringify({ready: !!window.__ready, err: window.__err || 'no-dbg'})`,
      returnByValue: true,
    });
    info = (r.result && r.result.value) || '';
  } catch (e) { info = 'eval-fail ' + e.message; }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('STATE ' + info);
  console.log('NET ok=' + netOk + ' bad=' + badUrls.length + ' flowFrames=' + flowReq);
  console.log('IMAGERY ' + JSON.stringify(zCount));
  for (const u of goodUrls) console.log('OK ' + u);
  for (const u of badUrls) console.log('BAD ' + u);
  const uniq = [...new Set(logs.map(l => l.slice(0, 90)))];
  for (const l of uniq.slice(-14)) console.log(l);
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
