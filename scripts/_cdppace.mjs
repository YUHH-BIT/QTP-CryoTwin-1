// 节奏验收：跳转到末段后播放，采样 t / path / 前缘，确认提速后仍同步、无报错
// 用法: node scripts/_cdppace.mjs <url> [samples]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_ = process.argv[2];
const N = Number(process.argv[3] || 24);
const PORT = 9361;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));
const child = spawn(EDGE, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--window-size=1000,600',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch (e) { }
    await sleep(400);
  }
  throw new Error('no cdp');
}
const ws = new WebSocket(await getWs());
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let id = 0; const pending = new Map(); const errs = [];
ws.addEventListener('message', ev => {
  let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
  if (m.method === 'Runtime.exceptionThrown') errs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('ERR ' + JSON.stringify(m.params.args.map(a => a.value || a.description)));
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 240000);
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { evalError: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
};
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: URL_ });
let ready = false;
for (let i = 0; i < 90; i++) { await sleep(1000); if (await evalJs('!!window.__ready')) { ready = true; break; } }
console.log('ready=' + ready);
await sleep(6000);
console.log('init ' + JSON.stringify(await evalJs('(()=>{const d=__dbg();return {t:d.t,path:d.path,clock:d.clock};})()')));
await evalJs("document.getElementById('btn-play').click()");
const rows = [];
for (let i = 0; i < N; i++) {
  await sleep(900);
  rows.push(await evalJs('(()=>{const d=__dbg();return {t:d.t,path:d.path};})()'));
}
for (const r of rows) console.log(JSON.stringify(r));
console.log('errs=' + JSON.stringify(errs.slice(0, 6)));
try { child.kill(); } catch (e) { }
await sleep(200);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
process.exit(0);
