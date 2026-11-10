// 多时刻截图：node scripts/_rigshot.mjs <baseUrl> <waitSec> <outPrefix> <url1> [url2 ...]
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const base = process.argv[2], wait = Number(process.argv[3] || 34), out = process.argv[4];
const urls = process.argv.slice(5);
const W = 1600, H = 900, PORT = 9346;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-shot-'));
const child = spawn(EDGE, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions', `--window-size=${W},${H}`,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const l = await r.json();
    const p = l.find(t => t.type === 'page'); if (p && p.webSocketDebuggerUrl) { ws = p.webSocketDebuggerUrl; break; }
  } catch (e) { }
  await sleep(400);
}
const sock = new WebSocket(ws); await new Promise(r => sock.addEventListener('open', r));
let id = 0; const pend = new Map();
sock.addEventListener('message', ev => {
  let m; try { m = JSON.parse(ev.data) } catch (e) { return }
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); sock.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + m)) } }, 180000) });
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
for (const raw of urls) {
  const name = raw.replace(/[^0-9a-z]/gi, '_').replace(/^_+/, '');
  await send('Page.navigate', { url: base + raw });
  await sleep(wait * 1000);
  // 等到相机真的就位（跟拍模式下探针可读）再截
  for (let i = 0; i < 30; i++) {
    const r = await send('Runtime.evaluate', { expression: '!!(window.__cam && window.__cam().rig && window.__frameProbe && (window.__frameProbe().waterN>0))', returnByValue: true });
    if (r && r.result && r.result.value) break;
    await sleep(1500);
  }
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const f = out + name + '.png';
  fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
  console.log('SHOT ' + f);
}
child.kill(); await sleep(300);
try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) { }
process.exit(0);
