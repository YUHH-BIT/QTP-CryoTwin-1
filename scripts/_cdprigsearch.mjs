// 沿沟机位构图搜索：node scripts/_cdprigsearch.mjs <baseUrl> <t> <outFile> [optsJson]
// 页面里 __rigSearch 用真实水面点投影量占画高/遮挡；本脚本负责禁缓存 + 就绪轮询。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const base = process.argv[2] || 'http://127.0.0.1:8765/';
const t = Number(process.argv[3] || 300);
const outFile = process.argv[4] || path.join(os.tmpdir(), 'rigsearch.json');
const opts = process.argv[5] || '{}';
const PORT = Number(process.argv[6] || 9351);
const W = 1600, H = 900;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-rs-'));
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
  await send('Page.navigate', { url: `${base}?t=${t}` });

  let ready = false;
  for (let i = 0; i < 300; i++) {
    try {
      const r = await send('Runtime.evaluate', { expression: 'window.__ready===true', returnByValue: true });
      if (r.result && r.result.value === true) { ready = true; break; }
    } catch (e) { }
    await sleep(500);
  }
  if (!ready) throw new Error('page not ready; exceptions=' + errs.slice(0, 3).join(' | '));
  await sleep(2200);   // 让洪水层跑几帧，frontS / tField 稳定

  const expr = `(function(){try{return JSON.stringify({ok:true,data:window.__rigSearch(${opts}),cam:window.__cam()});}catch(e){return JSON.stringify({ok:false,err:String(e&&e.stack||e)});}})()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const payload = JSON.parse(r.result.value);
  payload.t = t; payload.opts = opts; payload.exceptions = errs;
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 1));
  console.log(`WROTE ${outFile} rows=${payload.data && payload.data.rows ? payload.data.rows.length : 0} err=${payload.err || '-'} exceptions=${errs.length}`);
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
