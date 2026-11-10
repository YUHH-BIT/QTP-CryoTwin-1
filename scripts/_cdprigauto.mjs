// 自动跟拍验收：node scripts/_cdprigauto.mjs <baseUrl> <prefix> <waitSec> <port> t1,t2,t3...
// 用 ?t=&follow=1 进入真正的 autoFly 跟拍，读 __cam().rig 反馈并截图。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const base = process.argv[2] || 'http://127.0.0.1:8765/';
const prefix = process.argv[3] || path.join(os.tmpdir(), 'ra_');
const waitSec = Number(process.argv[4] || 40);
const PORT = Number(process.argv[5] || 9371);
const times = (process.argv[6] || '120,300,430').split(',').map(Number);
const viewMode = process.argv[7] || 'follow';   // follow=跟拍 / static=全景 / tactical=战术俯视
const W = 1600, H = 900;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-ra-'));
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
    const ms = method === 'Page.captureScreenshot' ? 75000 : 120000;
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, ms);
  });
}

try {
  const ws = new WebSocket(await getWs());
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws open failed')));
  });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  const errs = [];
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push((d.exception || {}).description || d.text);
    }
  });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  const rows = [];
  for (const t of times) {
    const suffix = viewMode === 'static' ? ''
                 : viewMode === 'tactical' ? '&view=tactical' : '&follow=1';
    // tint 复用 follow 机位，只在截图前把水面染洋红
    await send('Page.navigate', { url: `${base}?t=${t}${suffix}` });
    let ready = false;
    for (let k = 0; k < 300; k++) {
      try {
        const r = await send('Runtime.evaluate', { expression: 'window.__ready===true', returnByValue: true });
        if (r.result && r.result.value === true) { ready = true; break; }
      } catch (e) { }
      await sleep(500);
    }
    if (!ready) throw new Error('not ready t=' + t + ' errs=' + errs.slice(-2).join('|'));
    await sleep(waitSec * 1000);
    // tint：只在无头浏览器内存里把水面片元染成洋红，用来确认「画面里哪块是水」。
    // 不改源码、不写文件；跑完浏览器即销毁。
    if (viewMode === 'tint') {
      const tint = await send('Runtime.evaluate', {
        expression: `(function(){try{
          const m=window.__flood.waterMat;
          const src='gl_FragColor = vec4(col, alpha);';
          if(!m.fragmentShader.includes(src)) return 'NO_MATCH';
          m.fragmentShader=m.fragmentShader.replace(src,'gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);');
          m.needsUpdate=true;
          return 'TINTED';
        }catch(e){return 'ERR '+String(e);}})()`, returnByValue: true,
      });
      console.log('TINT ' + (tint.result && tint.result.value));
      await sleep(6000);
    }
    const r = await send('Runtime.evaluate', {
      expression: `(function(){const c=window.__cam(); const d=window.__flood?window.__flood.diagnose():null; c.muddy=d?d.muddy:null; c.gamma=d?d.visualWidenGamma:null; return JSON.stringify(c);})()`, returnByValue: true,
    });
    const c = JSON.parse(r.result.value);
    rows.push({ t, rig: c.rig, pos: c.pos, target: c.target, dist: c.dist,
                clearance: c.clearance, autoFly: c.autoFly, flight: c.flight,
                waterHead: c.waterHead, headInView: c.waterHeadInView,
                camToHead: c.camToWaterHead, frontGap: c.frontGap });
    // 诊断先落控制台：SwiftShader 大区域截图会偶发 75 s 超时，
    // 不能让截图失败把已经量到的机位数据一起吞掉。
    console.log(`t=${t} view=${viewMode} tactical=${c.tacticalCam} rig=${JSON.stringify(c.rig)} clear=${c.clearance} headInView=${c.waterHeadInView} camToHead=${c.camToWaterHead} frontGap=${c.frontGap} muddy=${c.muddy}`);
    let shot = null;
    for (let a = 0; a < 3 && !shot; a++) {
      try { shot = await send('Page.captureScreenshot', { format: 'png' }); }
      catch (e) { console.log(`t=${t} shot retry ${a + 1}`); if (a < 2) await sleep(8000); }
    }
    if (shot) {
      const file = `${prefix}${t}.png`;
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`SHOT t=${t} -> ${file}`);
    } else {
      console.log(`SHOT t=${t} FAILED (数值仍有效)`);
    }
  }
  console.log('EXCEPTIONS ' + errs.length + (errs.length ? ' :: ' + errs.slice(0, 3).join(' | ') : ''));
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
