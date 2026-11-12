// 机位取景验收：一次启动，按 JSON 批次逐条摆机位 → 截图 + 读诊断
// 用法: node scripts/_cdpcam.mjs <url> <waitSec> <shotsJsonPath>
// shotsJson = [{ "name": "a", "expr": "window.__fly(...)", "wait": 3000, "keep": true }]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const waitSec = Number(process.argv[3] || 30);
const shots = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const outDir = process.argv[5] || '.workbuddy/tmp';
const W = Number(process.env.CDP_W || 1440), H = Number(process.env.CDP_H || 900), PORT = 9338;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp5-'));
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
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 90000);
  });
}

try {
  const ws = new WebSocket(await getWs());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable');
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

  for (const s of shots) {
    if (s.expr) {
      const r = await ev(s.expr);
      console.log(s.name + ' expr -> ' + JSON.stringify(r));
      if (String(r).startsWith('EXC')) console.log(s.name + ' ' + r);
    }
    await sleep(s.wait || 3000);
    const probe = await ev("JSON.stringify({cam: window.__cam && window.__cam(), dbg: window.__dbg && window.__dbg()})");
    fs.writeFileSync(path.join(outDir, s.name + '.json'), probe || '');
    const img = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(outDir, s.name + '.png'), Buffer.from(img.data, 'base64'));
    console.log(s.name + ' -> ' + (probe || '').slice(0, 700));
  }
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
