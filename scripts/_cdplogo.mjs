// 品牌区（系统名）样式对比：A 整串纯白 / B 整串渐变 / C 图标块+整串 / D 主副双行
// 用法: node scripts/_cdplogo.mjs <url> <outPrefix> [w=1670] [h=900] [waitSec=12]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const prefix = process.argv[3];
const W = Number(process.argv[4] || 1670);
const H = Number(process.argv[5] || 900);
const waitSec = Number(process.argv[6] || 12);
const PORT = 9900 + Math.floor(Math.random() * 90);

const PEAK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 19h19"/><path d="M4 19l5.2-9.5 3 5 2.3-3.4L20 19"/><path d="M8.2 11.2l1 -.9 1.1.9"/></svg>`;

const VARIANTS = {
  A_flat_white: {
    html: `<span class="lg-name">青藏高原冰冻圈灾害数字孪生系统</span>`,
    css: `
      .topbar .logo-name, .topbar .logo-region { display: none; }
      .lg-name { font-size: 17px; font-weight: 700; letter-spacing: .8px; color: #eef4fc; white-space: nowrap; }
    `,
  },
  B_gradient: {
    html: `<span class="lg-name">青藏高原冰冻圈灾害数字孪生系统</span>`,
    css: `
      .topbar .logo-name, .topbar .logo-region { display: none; }
      .lg-name {
        font-size: 17px; font-weight: 700; letter-spacing: .8px; white-space: nowrap;
        background: linear-gradient(100deg, #ffffff 0%, #dbeafe 55%, #9fd4f5 100%);
        -webkit-background-clip: text; background-clip: text;
        -webkit-text-fill-color: transparent; color: #eaf5ff;
      }
    `,
  },
  C_mark: {
    html: `<span class="lg-mark">${PEAK_SVG}</span><span class="lg-name">青藏高原冰冻圈灾害数字孪生系统</span>`,
    css: `
      .topbar .logo-name, .topbar .logo-region { display: none; }
      .topbar .logo::before { display: none; }
      .lg-mark {
        width: 32px; height: 32px; flex: none; margin-right: 10px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 9px; color: #7dd3fc;
        background: linear-gradient(180deg, rgba(59,130,246,.28), rgba(37,99,235,.16));
        border: 1px solid rgba(125,211,252,.3);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
      }
      .lg-mark svg { width: 18px; height: 18px; }
      .lg-name { font-size: 17px; font-weight: 700; letter-spacing: .8px; color: #eef4fc; white-space: nowrap; }
    `,
  },
  D_stack: {
    html: `<span class="lg-stack"><span class="lg-sname">青藏高原冰冻圈灾害数字孪生系统</span><span class="lg-sub">CRYOSPHERE DISASTER DIGITAL TWIN</span></span>`,
    css: `
      .topbar .logo-name, .topbar .logo-region { display: none; }
      .lg-stack { display: flex; flex-direction: column; justify-content: center; }
      .lg-sname { font-size: 15.5px; font-weight: 700; letter-spacing: .6px; color: #eef4fc; white-space: nowrap; line-height: 1.15; }
      .lg-sub {
        display: block; margin-top: 3px;
        font-size: 8px; font-weight: 500; letter-spacing: 1.7px;
        color: #6f87a6; white-space: nowrap; line-height: 1;
      }
    `,
  },
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelogo-'));
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
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(waitSec * 1000);
  await send('Runtime.evaluate', {
    expression: `(()=>{const o=document.getElementById('loading-overlay');if(o)o.style.setProperty('display','none','important');})()`,
  });

  for (const [key, v] of Object.entries(VARIANTS)) {
    await send('Runtime.evaluate', {
      expression: `(()=>{
        const logo=document.querySelector('.topbar .logo');
        logo.innerHTML=${JSON.stringify(v.html)};
        let s=document.getElementById('logovar');
        if(!s){s=document.createElement('style');s.id='logovar';document.head.appendChild(s);}
        s.textContent=${JSON.stringify(v.css)};
      })()`,
    });
    await sleep(300);
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 470, height: 64, scale: 5 },
    });
    const out = `${prefix}_${key}.png`;
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('OK ' + out);
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
