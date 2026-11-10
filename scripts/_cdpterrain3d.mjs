// 验证系统「三维示范区」替换页：node scripts/_cdpterrain3d.mjs <baseUrl> <port> <waitSec> <outPng>
// 检查导航区、iframe 内演示页 __ready、WebGL 绘制量、异常；截图。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const base = process.argv[2] || 'http://127.0.0.1:5001/';
const PORT = Number(process.argv[3] || 9420);
const waitSec = Number(process.argv[4] || 40);
const outPng = process.argv[5] || path.join(os.tmpdir(), 'terrain3d_new.png');
const W = 1600, H = 900;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-t3d-'));
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
  let id = 0; const pending = new Map(); const errs = [];
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push((d.exception || {}).description || d.text);
    }
  });
  return {
    send: (method, params = {}) => new Promise((res, rej) => {
      const myId = ++id; pending.set(myId, { res, rej });
      ws.send(JSON.stringify({ id: myId, method, params }));
      const ms = method === 'Page.captureScreenshot' ? 75000 : 120000;
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, ms);
    }),
    errs,
  };
}

try {
  const ws = new WebSocket(await getWs());
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws open failed')));
  });
  const { send, errs } = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: base + 'terrain3d.html' });
  await sleep(waitSec * 1000);

  const expr = `(function(){
    try {
      var f = document.getElementById('demo-frame');
      var w = f && f.contentWindow;
      var d = w && w.document;
      var nav = document.querySelector('.topbar');
      var navLinks = document.querySelectorAll('.nav-links a').length;
      var r = nav ? nav.getBoundingClientRect() : null;
      var fr = f ? f.getBoundingClientRect() : null;
      var out = {
        topbar: !!nav, navLinks: navLinks,
        navRect: r ? [r.x, r.y, r.width, r.height].map(function(v){return Math.round(v);}) : null,
        iframe: !!f,
        iframeRect: fr ? [fr.x, fr.y, fr.width, fr.height].map(function(v){return Math.round(v);}) : null,
        iframeSrc: f ? f.src : null,
        embeddedBody: d && d.body ? d.body.classList.contains('embedded') : null,
        demoReady: w ? w.__ready === true : null,
        demoTitle: d ? d.title : null,
        demoErr: w && w.__err ? String(w.__err) : null,
        demoCanvas: d ? !!d.getElementById('scene') : null,
        demoDbg: w && w.__dbg ? w.__dbg() : null,
        statusHidden: !!document.getElementById('status'),
        errorBox: (document.getElementById('demo-error')||{}).style ? document.getElementById('demo-error').style.display : null,
      };
      return JSON.stringify(out);
    } catch(e) { return JSON.stringify({probeError: String(e && e.stack || e)}); }
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('PROBE ' + r.result.value);
  console.log('EXCEPTIONS ' + errs.length + (errs.length ? ' :: ' + errs.slice(0, 4).join(' | ') : ''));

  let shot = null;
  for (let a = 0; a < 3 && !shot; a++) {
    try { shot = await send('Page.captureScreenshot', { format: 'png' }); }
    catch (e) { console.log('shot retry ' + (a + 1)); if (a < 2) await sleep(8000); }
  }
  if (shot) {
    fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
    console.log('SHOT ' + outPng);
  } else console.log('SHOT FAILED (probe still valid)');
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
