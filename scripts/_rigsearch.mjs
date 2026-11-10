// 构图参数搜索：node scripts/_rigsearch.mjs <baseUrl> <waitSec> <t> <outJson> [mode]
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const base = process.argv[2], wait = Number(process.argv[3] || 34);
const t = process.argv[4] || '300';
const outFile = process.argv[5] || path.join(os.tmpdir(), 'rigsearch.json');
const mode = process.argv[6] || 'follow';
// 第 7 个参数：over 的 JSON（例如 {"fixed":[[24,0,260,660],...]} 或 {"elevs":[...]}）
const overArg = process.argv[7] || '{}';
const W = 1600, H = 900, PORT = 9348;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-rs-'));
const child = spawn(EDGE, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions', `--window-size=${W},${H}`,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const l = await r.json();
    const p = l.find(x => x.type === 'page'); if (p && p.webSocketDebuggerUrl) { ws = p.webSocketDebuggerUrl; break; }
  } catch (e) { }
  await sleep(400);
}
const sock = new WebSocket(ws); await new Promise(r => sock.addEventListener('open', r));
let id = 0; const pend = new Map();
sock.addEventListener('message', ev => {
  let m; try { m = JSON.parse(ev.data) } catch (e) { return }
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); sock.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + m)) } }, 300000) });
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: `${base}?t=${t}&follow=1` });
await sleep(wait * 1000);
let res = null;
for (let i = 0; i < 40; i++) {
  const r = await send('Runtime.evaluate', {
    expression: `(window.__rigSearch ? JSON.stringify(window.__rigSearch(${JSON.stringify(mode)}, ${overArg})) : 'null')`,
    returnByValue: true,
  });
  if (r.result && typeof r.result.value === 'string' && r.result.value !== 'null') {
    res = JSON.parse(r.result.value);
    if (res && res.rows && res.rows.length) break;
  }
  if (r.exceptionDetails) {
    console.log('EXC ' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
    break;
  }
  await sleep(2000);
}
if (!res || !res.rows) { console.log('NODATA ' + JSON.stringify(res && res.err)); }
else {
  fs.writeFileSync(outFile, JSON.stringify(res, null, 0));
  console.log(`OK t=${t} rows=${res.rows.length} sFront=${res.sFront} s0=${res.s0} wet=${res.wetPts} -> ${outFile}`);
}
child.kill(); await sleep(300);
try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) { }
process.exit(0);
