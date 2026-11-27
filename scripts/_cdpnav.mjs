// 导航栏几何审计 + 顶部裁剪截图
// 用法: node scripts/_cdpnav.mjs <url> <outPng> [w=1670] [h=900] [waitSec=12]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const out = process.argv[3];
const W = Number(process.argv[4] || 1670);
const H = Number(process.argv[5] || 900);
const waitSec = Number(process.argv[6] || 12);
const PORT = 9333 + Math.floor(Math.random() * 200);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgenav-'));
const child = spawn(EDGE, [
  '--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars',
  '--no-first-run', '--disable-extensions',
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
    } catch (e) { /* not ready */ }
    await sleep(400);
  }
  throw new Error('CDP not ready');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 60000);
  });
}

const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  const tb = q('.topbar');
  const logo = q('.topbar .logo');
  const nav = q('.topbar .nav-links');
  const sb = q('.topbar .searchbar');
  const inp = q('.topbar input[type="search"]');
  const items = [...document.querySelectorAll('.topbar .nav-links a, .topbar .nav-links .dropdown-toggle')]
    .map(a => ({ t: a.textContent.trim().slice(0, 8), ...box(a) }));
  const cs = tb ? getComputedStyle(tb) : null;
  return JSON.stringify({
    vw: innerWidth, vh: innerHeight,
    topbar: box(tb), navHeightVar: cs ? cs.height : null,
    logo: box(logo), nav: box(nav), searchbar: box(sb), input: box(inp), items,
    mapTop: (q('#map') ? Math.round(q('#map').getBoundingClientRect().top) : null),
    rows: { r1: box(q('.topbar-row1')), r2: box(q('.topbar-row2')) },
  }, null, 1);
})()`;

try {
  const wsUrl = await getWs();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws error')));
  });
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(waitSec * 1000);

  const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  const json = (r.result && r.result.value) || '{}';
  console.log(json);

  // 仅为截图可视：隐藏加载遮罩（fixed 全屏，不影响 topbar 布局）
  await send('Runtime.evaluate', {
    expression: `(()=>{const o=document.getElementById('loading-overlay');if(o)o.style.setProperty('display','none','important');})()`,
  });
  await sleep(400);

  // 可选：NAVCLICK=<索引> 展开第 n 个下拉（0=灾害数据库 …），用于验证菜单定位
  if (process.env.NAVCLICK !== undefined) {
    await send('Runtime.evaluate', {
      expression: `(()=>{const t=document.querySelectorAll('.dropdown-toggle')[${Number(process.env.NAVCLICK)}];if(t)t.click();})()`,
    });
    await sleep(500);
  }

  // 可选：NAVHOVER=<序号> 把鼠标移到第 n 个展开的菜单项上（验证 hover 态）
  if (process.env.NAVHOVER !== undefined) {
    const r = await send('Runtime.evaluate', {
      expression: `(()=>{const e=document.querySelectorAll('.dropdown-menu.active .dropdown-item')[${Number(process.env.NAVHOVER)}];if(!e)return '';const b=e.getBoundingClientRect();return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2});})()`,
      returnByValue: true,
    });
    if (r.result.value) {
      const p = JSON.parse(r.result.value);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await sleep(350);
    }
  }

  // 可选：NAVIMG=<本地图片路径> 把所有 .logo-img 的 src 换成本地图（后端未重启 /img 路由未生效时预览用）
  if (process.env.NAVIMG) {
    const buf = fs.readFileSync(process.env.NAVIMG);
    const mime = process.env.NAVIMG.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    await send('Runtime.evaluate', {
      expression: `(()=>{document.querySelectorAll('.logo-img').forEach(i=>{i.src=${JSON.stringify(dataUrl)};});})()`,
    });
    await sleep(300);
  }

  // 第 7 个参数：裁剪高度（默认 80 只截导航栏；传 0 截整屏）；第 8 个：缩放倍率；
  // 第 9/10 个：裁剪区左上角 x/y（默认 0），用于放大看局部（如下拉菜单）
  const clipH = process.argv[7] === undefined ? 80 : Number(process.argv[7]);
  const scale = Number(process.argv[8] || (clipH && clipH <= 200 ? 2 : 1));
  const clipX = Number(process.argv[9] || 0);
  const clipY = Number(process.argv[10] || 0);
  const clipW = Number(process.argv[11] || 0) || Math.min(W - clipX, W);
  const clip = clipH > 0
    ? { x: clipX, y: clipY, width: Math.min(clipW, W - clipX), height: clipH, scale }
    : { x: 0, y: 0, width: W, height: H, scale };
  const shot = await send('Page.captureScreenshot', { format: 'png', clip });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('OK ' + out);
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
