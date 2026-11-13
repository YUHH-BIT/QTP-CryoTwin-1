// 航拍机位扫参：一次启动比多组参数（审计 + 截图）
// 用法: node scripts/_cdpsweep.mjs <url> <waitSec> <outPrefix>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const waitSec = Number(process.argv[3] || 40);
const pref = process.argv[4] || '.workbuddy/tmp/sweep';
const W = Number(process.env.CDP_W || 900), H = Number(process.env.CDP_H || 560), PORT = 9344;

const CASES = [
  { name: 'F_final', back: 220, lat: 120, alt: 300, ahead: 100 },
];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdpa-'));
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
  // 进航拍 + 跳到第 6 阶段（中段，水头已推进，画面里一定有水）
  await ev("document.getElementById('btn-flood').click()");
  await sleep(2500);
  console.log('stage ' + await ev(`(() => {
    const it = document.querySelectorAll('.stage-item');
    if (it[5]) { it[5].click(); return 'jumped ' + it[5].textContent.trim(); }
    return 'no stage';
  })()`));
  await sleep(5000);

  const all = [];
  for (const c of CASES) {
    const r1 = await ev(`JSON.stringify(window.__rigTune(${JSON.stringify(c)}))`);
    await sleep(4500);
    const audit = await ev("JSON.stringify(window.__rigAudit('cine'))");
    let a = null;
    try { a = JSON.parse(audit); } catch (e) { }
    const cam = await ev("JSON.stringify(window.__cam())");
    fs.writeFileSync(`${pref}_${c.name}.json`, JSON.stringify({ case: c, tune: r1, audit: a, cam }, null, 1));
    const img = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${pref}_${c.name}.png`, Buffer.from(img.data, 'base64'));
    const brief = a ? `pitch ${a.pitchMin}~${a.pitchMax} (${a.pitchMean}) dist ${a.rows.map(r => r.dist).slice(0, 6).join('/')} view ${a.inViewPct}% blocked ${a.blocked}/${a.nodesTot} curve ${a.curveMean}/${a.curveMax}` : audit;
    console.log(c.name + ' -> ' + brief);
    all.push({ name: c.name, brief });
  }
  console.log('DONE');
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
