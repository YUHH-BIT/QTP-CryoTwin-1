// 验证跨文档 View Transition：真实点击导航 → 跳转 → 连拍过渡中间帧
// 用法: node scripts/_cdpvt.mjs [w=1670] [h=900]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const W = Number(process.argv[2] || 1670);
const H = Number(process.argv[3] || 900);
const PORT = 9800 + Math.floor(Math.random() * 150);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgevt-'));
const child = spawn(EDGE, [
  '--headless=new', '--hide-scrollbars', '--no-first-run', '--disable-extensions',
  `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

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

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
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

try {
  const ws = new WebSocket(await getWs());
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('ws'))); });
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:5000/index.html' });
  await sleep(11000);

  // 隐藏加载遮罩，否则全屏遮罩盖住过渡画面看不出淡入
  await send('Runtime.evaluate', {
    expression: `(()=>{const o=document.getElementById('loading-overlay');if(o)o.style.setProperty('display','none','important');})()`,
  });

  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };

  const rect = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(()=>{const e=${expr};if(!e)return null;const b=e.getBoundingClientRect();return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2});})()`, returnByValue: true });
    return r.result.value ? JSON.parse(r.result.value) : null;
  };

  // 1) 点开「灾害数据库」
  const tg = await rect(`document.querySelector('.dropdown-toggle[data-page="query"]')`);
  if (!tg) throw new Error('no toggle');
  await click(tg.x, tg.y);
  await sleep(400);

  // 2) 点第一个二级项（跳 query.html）
  const item = await rect(`document.querySelector('.dropdown-menu.active .dropdown-item')`);
  if (!item) throw new Error('no item');
  console.log('item ' + JSON.stringify(item));

  await click(item.x, item.y);

  // 3) 连拍过渡中间帧
  const frames = [70, 70, 90, 140];
  let i = 0;
  for (const gap of frames) {
    await sleep(gap);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: 420, scale: 1 } });
    const f = `F:/QTP‑CryoTwin/tmp_vt_${++i}.png`;
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    console.log('OK ' + f);
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
