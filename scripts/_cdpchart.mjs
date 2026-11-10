// 情景卡片两张 ECharts 图的落地检查：node scripts/_cdpchart.mjs <url> [waitSec]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const waitSec = Number(process.argv[3] || 55);
const W = 1600, H = 900, PORT = 9337;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-chart-'));
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
      const p = list.find(t => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch (e) { }
    await sleep(400);
  }
  throw new Error('CDP not ready');
}
function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id; pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 60000);
  });
}

const PROBE = `(function(){
  const out = { echarts: typeof window.echarts, errs: [] };
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  [['arrival','#spark-arrival'],['flow','#spark-q']].forEach(([k,sel]) => {
    const host = document.querySelector(sel);
    const cv = host ? host.querySelector('canvas') : null;
    out[k] = { host: box(host), canvas: box(cv),
               canvasPx: cv ? [cv.width, cv.height] : null,
               inst: host ? host.getAttribute('_echarts_instance_') : null,
               kids: host ? host.children.length : -1,
               html: host ? host.innerHTML.slice(0, 160) : null };
  });
  out.row = box(document.querySelector('.spark-row'));
  // 画布是否真的有内容：抽样若干像素，统计非背景色点
  const cv = document.querySelector('#spark-ararival canvas') || document.querySelector('#spark-arrival canvas');
  if (cv) {
    const ctx = cv.getContext('2d');
    if (ctx) {
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let painted = 0;
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i + 3] > 8) painted++;
      out.paintedSamples = painted;
    }
  }
  out.legendText = [...document.querySelectorAll('.stage-legend span')].map(e => e.textContent.trim());
  out.hasSrcBtn = !!document.getElementById('btn-src');
  out.hasLog = !!document.getElementById('tl-log');
  out.hasCineTip = !!document.getElementById('cine-tip');
  out.titles = [...document.querySelectorAll('[title]')].map(e => e.tagName + ':' + e.getAttribute('title'));
  out.tools = [...document.querySelectorAll('.stage-tools button')].map(b => b.textContent.trim());
  out.legendItems = document.querySelectorAll('.stage-legend span').length;
  return JSON.stringify(out);
})()`;

try {
  const ws = new WebSocket(await getWs());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  const errs = [];
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
  });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url });
  await sleep(waitSec * 1000);
  const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  const obj = JSON.parse(r.result.value);
  obj.exceptions = errs;
  console.log(JSON.stringify(obj, null, 2));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(os.tmpdir(), 'chart_shot.png'), Buffer.from(shot.data, 'base64'));
  // 只截图表区域：小区域渲染快，不容易被软件渲染拖到超时
  const r0 = obj.row;
  if (r0) {
    const clipShot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: r0.l - 4, y: r0.t - 4, width: r0.w + 8, height: r0.h + 8, scale: 3 },
    });
    fs.writeFileSync(path.join(os.tmpdir(), 'chart_clip.png'), Buffer.from(clipShot.data, 'base64'));
    console.log('CLIP ' + path.join(os.tmpdir(), 'chart_clip.png'));
  }
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
