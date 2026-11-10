// 跟拍机位构图体检（带就绪轮询版）
// node scripts/_rigprobe.mjs <baseUrl> <waitSec> <tag> <url1> [url2 ...]
//   url 里的 {tag} 会被替换成 tag；每个 url 单独导航、轮询到 __frameProbe 可用再读。
// 结果写 <tmp>/rigprobe_<tag>.json，供后续比对，不受终端截断影响。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const base = process.argv[2];
const waitSec = Number(process.argv[3] || 34);
const tag = process.argv[4] || 'x';
const urls = process.argv.slice(5);
const W = 1600, H = 900, PORT = 9341;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-rig-'));
const child = spawn(EDGE, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions',
  `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 80; i++) {
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
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 120000);
  });
}

// 一次性取回所有需要的量；缺哪个就在 missing 里显式列出，不再静默 undefined
const PROBE = `(function(){
  if (typeof window.__cam !== 'function') return JSON.stringify({ missing: 'no __cam' });
  const c = window.__cam();
  const out = { t: c.t, rig: c.rig, dist: c.dist, clearance: c.clearance,
                pos: c.pos, target: c.target };
  if (typeof window.__frameProbe !== 'function') { out.missing = 'no __frameProbe'; return JSON.stringify(out); }
  const p = window.__frameProbe();
  Object.keys(p).forEach(k => { out[k] = p[k]; });
  if (window.__flood && window.__flood.frontS != null) out.frontS = +window.__flood.frontS.toFixed(1);
  return JSON.stringify(out);
})()`;

const rows = [];
try {
  const ws = new WebSocket(await getWs());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  const errs = [];
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push((d.exception && d.exception.description) || d.text || 'exception');
    }
  });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  for (const raw of urls) {
    const url = base + raw.replace('{tag}', tag);
    const t0 = Date.now();
    await send('Page.navigate', { url });
    // 先等一个固定的冷启动时间（DEM/影像/echarts 都要拉），再轮询到探针可读
    await sleep(waitSec * 1000);
    let val = null, lastErr = '';
    for (let i = 0; i < 40; i++) {
      const r = await send('Runtime.evaluate', {
        expression: PROBE, returnByValue: true, awaitPromise: false,
      }).catch(e => ({ __e: e.message }));
      if (r && r.__e) { lastErr = r.__e; }
      else if (r && r.exceptionDetails) { lastErr = (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text; }
      else if (r && r.result && typeof r.result.value === 'string') {
        try { val = JSON.parse(r.result.value); } catch (e) { lastErr = 'JSON ' + e.message; }
      }
      // 没有水体采样点 = 这一帧洪水还没铺开/还没就绪，继续等
      if (val && val.rig && (val.waterN || 0) > 0) break;
      await sleep(1500);
    }
    rows.push({ url: raw, ms: Date.now() - t0, probe: val, lastErr });
  }
  const outFile = path.join(os.tmpdir(), `rigprobe_${tag}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ rows, exceptions: errs }, null, 1));
  console.log('OUT ' + outFile);
  // 终端只打一行摘要，避免长输出被截断
  for (const r of rows) {
    const p = r.probe || {};
    const rg = p.rig || {};
    console.log([r.url,
      'elev=' + rg.elev, 'dist=' + rg.dist, 'pitch=' + p.pitch,
      'head=' + JSON.stringify(p.headNdc), 'blk=' + p.headBlocked,
      'wH=' + p.waterScreenH, 'wNdc=' + JSON.stringify(p.waterNdc),
      'flow=' + p.flowAngle, 'clr=' + p.clearance,
      r.probe ? '' : 'NOPROBE ' + r.lastErr].join(' | '));
  }
  if (errs.length) console.log('EXC ' + errs.slice(0, 6).join(' ;; '));
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
