// CDP 诊断：抓页面异常与控制台错误（用于定位 boot 失败）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_ = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const WAIT = Number(process.argv[3] || 16);
const PORT = 9345;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));
const child = spawn(EDGE, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--window-size=1280,800',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 60; i++) {
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
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push('EXC ' + (d.exception && (d.exception.description || d.exception.value) || d.text) +
              ' @' + (d.url || '') + ':' + d.lineNumber);
  }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    logs.push('CONSOLE ' + m.params.type + ' ' + m.params.args.map(a => a.value || a.description || '').join(' '));
  }
  if (m.method === 'Log.entryAdded') logs.push('LOG ' + m.params.entry.level + ' ' + m.params.entry.text);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 60000);
});
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: URL_ + (URL_.includes('?') ? '&' : '?') + 'diag=1' });
await sleep(WAIT * 1000);
const ev = async (expr) => {
  try { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.value; }
  catch (e) { return 'EVALFAIL ' + e.message; }
};
console.log('ready=' + await ev('!!window.__ready') + ' err=' + await ev('window.__err||""'));
console.log('haz=' + JSON.stringify(await ev('window.__hazCenter?window.__hazCenter():null')));
console.log('logs:');
for (const l of logs.slice(0, 25)) console.log('  ' + l.slice(0, 400));
try { child.kill(); } catch (e) { }
await sleep(200);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
process.exit(0);
