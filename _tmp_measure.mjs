// 临时：CDP 测量顶栏三段布局是否居中
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const URL_ = process.argv[2] || 'http://127.0.0.1:5000/index.html';
const WIDTH = Number(process.argv[3] || 1600);
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const child = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},900`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no ws');
}

const ws = new WebSocket(await getWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL_ });
await sleep(9000);

const expr = `(() => {
  const q = (s) => document.querySelector(s);
  const r = (el) => el ? (({x,y,width,height}) => ({x:Math.round(x),y:Math.round(y),w:Math.round(width),h:Math.round(height),cx:Math.round(x+width/2)}))(el.getBoundingClientRect()) : null;
  const tb = q('.topbar');
  const cs = tb ? getComputedStyle(tb) : null;
  return {
    innerWidth: window.innerWidth,
    dpr: window.devicePixelRatio,
    topbar: r(tb),
    topbarDisplay: cs && cs.display,
    cols: cs && cs.gridTemplateColumns,
    gap: cs && cs.columnGap,
    row1: r(q('.topbar-row1')),
    logo: r(q('.topbar .logo')),
    nav: r(q('.topbar .nav-links')),
    right: r(q('.topbar .topbar-right')),
    searchbar: r(q('.topbar .searchbar')),
    user: r(q('.topbar-user')),
    navRect: q('.topbar .nav-links') ? q('.topbar .nav-links').getClientRects().length : 0,
  };
})()`;

const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(JSON.stringify(out.result.value, null, 2));

const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: WIDTH, height: 90, scale: 1 } });
const { writeFileSync } = await import('node:fs');
writeFileSync('F:/QTP‑CryoTwin/_tmp_topbar.png', Buffer.from(shot.data, 'base64'));

ws.close();
child.kill();
await sleep(600);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
