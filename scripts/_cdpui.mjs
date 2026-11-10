// 界面验收：捕获 JS 异常 / console.error，可选点击若干选择器后再截图
// 用法: node scripts/_cdpui.mjs <url> <outPng> [waitSec] [w] [h] [clickSelectors]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const out = process.argv[3];
const waitSec = Number(process.argv[4] || 45);
const W = Number(process.argv[5] || 1600);
const H = Number(process.argv[6] || 900);
const clicks = (process.argv[7] || '').split(',').filter(Boolean);
const PORT = 9336;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp3-'));
const child = spawn(EDGE, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
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
function cdp(ws, onEvent) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method) onEvent(msg);
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id; pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 60000);
  });
}

const problems = [];
try {
  const ws = new WebSocket(await getWs());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = cdp(ws, (m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      problems.push('EXCEPTION: ' + (d.exception && d.exception.description || d.text));
    } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      problems.push(m.params.type.toUpperCase() + ': ' + m.params.args.map(a => a.value || a.description || '').join(' '));
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      problems.push('LOG: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    }
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(waitSec * 1000);

  if (clicks.length) {
    const expr = clicks.map(s => `(function(){var e=document.querySelector(${JSON.stringify(s)});if(e)e.click();return !!e;})()`).join('&&');
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log('clicked: ' + JSON.stringify(r.result && r.result.value));
    await sleep(2500);
  }

  const probe = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      boot: !!window.__cam,
      hud: (document.getElementById('hud-stage')||{}).textContent,
      kpi: (document.getElementById('kpi-grid')||{}).children.length,
      rows: (document.getElementById('sect-body')||{}).children.length,
      sk: (document.getElementById('scenario-kpi')||{}).children.length,
      spark: !!(document.getElementById('spark')||{}).firstChild,
      layers: (document.getElementById('layer-list')||{}).querySelectorAll('input').length,
      tlrows: (document.getElementById('tl-log')||{}).children.length,
      leftHidden: document.body.classList.contains('hide-left'),
      rightHidden: document.body.classList.contains('hide-right'),
      scroll: { l: (document.querySelector('.pane.left .panel')||{}).scrollHeight, lh: (document.querySelector('.pane.left .panel')||{}).clientHeight,
                r: (document.querySelector('.pane.right .panel')||{}).scrollHeight, rh: (document.querySelector('.pane.right .panel')||{}).clientHeight },
      fatal: document.getElementById('fatal').className,
    })`,
    returnByValue: true,
  });
  console.log('state: ' + (probe.result && probe.result.value));

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('OK ' + out);
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  if (problems.length) console.log('--- issues ---\n' + problems.join('\n'));
  else console.log('--- no js errors ---');
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
