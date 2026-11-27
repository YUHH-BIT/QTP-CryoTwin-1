// 验收：首页 GDP 图层勾选后，是否真的把点画在当前视野内
// 用法: node scripts/_cdpgdp.mjs [url] [outPng]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_ = process.argv[2] || 'http://127.0.0.1:5000/index.html';
const OUT = process.argv[3] || '';
const PORT = 9357;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));
const child = spawn(EDGE, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--window-size=1440,900',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 240000);
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: URL_ });

// 等地图对象与图层面板就绪
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  try {
    if (await evaluate("!!(window.map && window.map.getView && document.getElementById('layer-economy'))")) { ready = true; break; }
  } catch (e) { }
}
console.log('map_ready=' + ready);
await sleep(4000);

const before = await evaluate(`(() => {
  const l = window.map.getLayers().getArray().find(x => x.get('type') === 'economy-layer');
  return { exists: !!l, checked: document.getElementById('layer-economy').checked };
})()`);
console.log('before=' + JSON.stringify(before));

// 模拟用户点击：勾选 + 触发 change
await evaluate(`(() => {
  const cb = document.getElementById('layer-economy');
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
// 页面初始化会同时加载 20+ 图层，主线程忙，等待放宽到 25s
for (let i = 0; i < 10; i++) {
  await sleep(2500);
  const ok = await evaluate("!!window.map.getLayers().getArray().find(x => x.get('type') === 'economy-layer')");
  if (ok) { console.log('layer_appeared_after=' + ((i + 1) * 2.5) + 's'); break; }
}

const after = await evaluate(`(() => {
  const l = window.map.getLayers().getArray().find(x => x.get('type') === 'economy-layer');
  if (!l) return { exists: false };
  const src = l.getSource();
  const feats = src.getFeatures();
  const v = window.map.getView();
  const ve = v.calculateExtent(window.map.getSize());
  const le = src.getExtent();
  const cs = feats.map(f => f.getGeometry().getCoordinates());
  const inView = cs.filter(c => c[0] >= ve[0] && c[0] <= ve[2] && c[1] >= ve[1] && c[1] <= ve[3]).length;
  const sample = cs.slice(0, 5);
  // 渲染层面：文字/圆点是否真的产生了 style
  const styled = feats.slice(0, 20).map(f => { const s = f.getStyle ? f.getStyle() : null; return !!s; }).filter(Boolean).length;
  return {
    exists: true, visible: l.getVisible(), nFeatures: feats.length,
    layerExtent: le.map(Math.round), viewExtent: ve.map(Math.round),
    intersect: !(le[0] > ve[2] || le[2] < ve[0] || le[1] > ve[3] || le[3] < ve[1]),
    inView, styled, sample: sample.map(c => c.map(Math.round)),
    zIndex: l.getZIndex()
  };
})()`);
console.log('after=' + JSON.stringify(after));

if (OUT) {
  await sleep(3000);
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('shot ' + OUT);
  } catch (e) { console.log('shot FAIL ' + e.message); }
}
try { child.kill(); } catch (e) { }
await sleep(200);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
process.exit(0);
