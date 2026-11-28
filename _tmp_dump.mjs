// 诊断：dump topbar 各 item 的 computed margin / flex 及实际位置
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const URL_ = process.argv[2] || 'http://127.0.0.1:5000/index.html';
const WIDTH = Number(process.argv[3] || 1920);
const profile = mkdtempSync(join(tmpdir(), 'cdp2-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},900`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWs() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const l = await r.json(); const p = l.find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error('no ws');
}
const ws = new WebSocket(await getWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL_ });
await sleep(4500);

const expr = `(() => {
  const tb = document.querySelector('.topbar');
  const items = [...tb.children].map(el => {
    if (!el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { cls: el.className, x: Math.round(r.x), w: Math.round(r.width), display: cs.display,
             ml: cs.marginLeft, mr: cs.marginRight, flex: cs.flex,
             gapL: r.left };
  });
  const kids = [];
  tb.querySelectorAll(':scope > *, .nav-links, .topbar-right, .searchbar, .topbar-user').forEach(el => {
    const r = el.getBoundingClientRect();
    kids.push({ cls: el.className || el.tagName, x: Math.round(r.x), r: Math.round(r.right), w: Math.round(r.width) });
  });
  const cs = getComputedStyle(tb);
  return { display: cs.display, gap: cs.columnGap, padding: cs.paddingLeft + '/' + cs.paddingRight, items, kids };
})()`;
const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
writeFileSync('F:/QTP‑CryoTwin/_tmp_dump.json', JSON.stringify(out.result.value, null, 2), 'utf8');
console.log(JSON.stringify(out.result.value.items, null, 1));
console.log(JSON.stringify(out.result.value.kids, null, 1));
ws.close(); child.kill(); await sleep(500);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
