// 出图：等系统加载遮罩消失后，放大到 zoom 6.5 截 GDP 气泡图层
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_ = 'http://127.0.0.1:5000/index.html';
const OUT = process.argv[2] || 'F:/QTP‑CryoTwin/scripts/_out_gdp_shot.png';
const PORT = 9369;
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
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 300000);
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 300) };
  return r.result.value;
};
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: URL_ });
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  try { if (await evaluate("!!(window.map && document.getElementById('layer-economy'))")) break; } catch (e) { }
}
await evaluate(`(() => { const cb=document.getElementById('layer-economy'); cb.checked=true; cb.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);

// 等图层出现
let appeared = -1;
for (let i = 0; i < 24; i++) {
  await sleep(2500);
  if (await evaluate("!!window.map.getLayers().getArray().find(x=>x.get('type')==='economy-layer')")) { appeared = (i + 1) * 2.5; break; }
}
console.log('layer_appeared_after=' + appeared + 's');

// 等初始化遮罩消失（最多 150s）
let overlayOff = false;
for (let i = 0; i < 60; i++) {
  overlayOff = await evaluate("(() => { const o=document.getElementById('loading-overlay'); return !o || !o.classList.contains('active'); })()");
  if (overlayOff) break;
  await sleep(2500);
}
console.log('overlay_off=' + overlayOff);

// 放大到 6.5 级看气泡
await evaluate("(() => { window.map.getView().setZoom(6.5); window.map.renderSync(); return 1; })()");
await sleep(9000);
const stat = await evaluate(`(() => {
  const l = window.map.getLayers().getArray().find(x=>x.get('type')==='economy-layer');
  const v = window.map.getView(); const ve = v.calculateExtent(window.map.getSize());
  const cs = l.getSource().getFeatures().map(f=>f.getGeometry().getCoordinates());
  return { visible: l.getVisible(), n: cs.length, inView: cs.filter(c=>c[0]>=ve[0]&&c[0]<=ve[2]&&c[1]>=ve[1]&&c[1]<=ve[3]).length, z: v.getZoom() };
})()`);
console.log('stat=' + JSON.stringify(stat));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('shot ' + OUT);
try { child.kill(); } catch (e) { }
await sleep(200);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
process.exit(0);
