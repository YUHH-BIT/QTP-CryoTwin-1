// 布局审计：在页面里按几何关系检查重叠 / 越界 / 文字截断，输出 JSON
// 用法: node scripts/_cdplayout.mjs <url> [w] [h] [waitSec] [clickSelectors]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const W = Number(process.argv[3] || 1600);
const H = Number(process.argv[4] || 900);
const waitSec = Number(process.argv[5] || 55);
const clicks = (process.argv[6] || '').split(',').filter(Boolean);
const PORT = 9337;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp4-'));
const child = spawn(EDGE, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions',
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
    } catch (e) { }
    await sleep(400);
  }
  throw new Error('CDP not ready');
}
function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id; pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 60000);
  });
}

const AUDIT = `(function(){
  // headless 下 CSS 过渡时间线可能不推进（currentTime 恒为 0），
  // 测量前先把所有过渡/动画强制打到终态，否则量到的是过渡起始帧。
  document.getAnimations().forEach(a => { try { a.finish(); } catch (e) {} });
  const out = { view: [innerWidth, innerHeight], problems: [], info: {} };
  const R = el => { const r = el.getBoundingClientRect(); return {l:r.left, t:r.top, r:r.right, b:r.bottom, w:r.width, h:r.height}; };
  const hit = (a, b) => !(a.r <= b.l + 1 || b.r <= a.l + 1 || a.b <= b.t + 1 || b.b <= a.t + 1);
  const q = s => document.querySelector(s);
  const qa = s => Array.from(document.querySelectorAll(s));

  const legend = q('.stage-legend'), tl = q('.timeline'), hud = q('.stage-hud'), tools = q('.stage-tools');
  if (legend && tl) {
    const g = R(tl).t - R(legend).b;
    out.info.legendTimelineGap = +g.toFixed(1);
    if (g < 4) out.problems.push('图例与时间轴间距仅 ' + g.toFixed(1) + 'px');
  }
  if (hud && tools && hit(R(hud), R(tools))) out.problems.push('HUD 与右上工具条重叠');
  if (legend && hud && hit(R(legend), R(hud))) out.problems.push('图例与 HUD 重叠');

  // 卡片内元素越界
  qa('.card').forEach((card, i) => {
    const cr = R(card), pad = 1.5;
    qa('.card')[i].querySelectorAll('*').forEach(el => {
      if (!el.offsetParent) return;
      const er = R(el);
      if (er.w === 0 && er.h === 0) return;
      if (er.r > cr.r + pad || er.b > cr.b + pad || er.l < cr.l - pad) {
        out.problems.push('卡片#' + i + ' 内越界: ' + (el.className || el.tagName) + ' ' + JSON.stringify(er) + ' vs ' + JSON.stringify(cr));
      }
    });
  });

  // 文字截断（溢出容器）+ 面板滚动
  const trunc = [];
  qa('.kpi, .sk, .stage-item, .tl-top, .hud-head, .layer-item, .sect-table th, .sect-table td, .focus-head, .card h2').forEach(el => {
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) trunc.push((el.className||el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth + ' "' + (el.textContent||'').trim().slice(0,16) + '"');
  });
  if (trunc.length) out.problems.push('文字被截断: ' + trunc.join(' | '));

  const pl = q('.pane.left .panel'), pr = q('.pane.right .panel');
  out.info.panelOverflow = {
    left: pl ? pl.scrollHeight - pl.clientHeight : null,
    right: pr ? pr.scrollHeight - pr.clientHeight : null,
  };

  // 时间轴：读数是否压在控件上
  const tlc = q('.tl-controls'), tlt = q('.tl-top');
  if (tlc && tlt) {
    const g = R(tlt).l - R(tlc).r;
    out.info.timeGap = +g.toFixed(1);
    if (g < 0) out.problems.push('时间读数与播放控件重叠 ' + g.toFixed(1) + 'px');
  }

  // 火花线：点是否在图内、文字是否互压
  const svg = q('#spark svg');
  if (svg) {
    const vb = svg.viewBox.baseVal;
    const bad = [];
    svg.querySelectorAll('polyline').forEach(pl => {
      const nums = pl.getAttribute('points').trim().split(/\\s+/).map(p => p.split(',').map(Number));
      nums.forEach(([x, y]) => { if (x < -1 || x > vb.width + 1 || y < -1 || y > vb.height + 1) bad.push([x, y]); });
    });
    if (bad.length) out.problems.push('趋势线越出视图: ' + JSON.stringify(bad.slice(0, 3)));
    const txt = Array.from(svg.querySelectorAll('text')).map(t => ({ t: t.textContent, ...R(t) }));
    for (let i = 0; i < txt.length; i++) for (let j = i + 1; j < txt.length; j++) {
      if (hit(txt[i], txt[j])) out.problems.push('趋势线标签重叠: ' + txt[i].t + ' / ' + txt[j].t);
    }
    out.info.sparkTexts = txt.map(x => x.t);
  }

  const st = q('.stage-top');
  out.info.rects = {
    top: st ? R(st) : null,
    hud: hud ? R(hud) : null,
    tools: tools ? R(tools) : null,
    legend: legend ? R(legend) : null,
    timeline: tl ? R(tl) : null,
    tabL: q('#btn-toggle-left') ? R(q('#btn-toggle-left')) : null,
    tabR: q('#btn-toggle-right') ? R(q('#btn-toggle-right')) : null,
  };
  const tl2 = q('#btn-toggle-left');
  out.info.tabStyle = tl2 ? {
    transform: getComputedStyle(tl2).transform,
    paneL: getComputedStyle(document.documentElement).getPropertyValue('--pane-l'),
    bodyCls: document.body.className,
    parentCls: tl2.parentElement.className,
  } : null;
  out.info.legendItems = qa('.stage-legend span').length;
  out.info.hudText = (q('#hud-idx')||{}).textContent + ' ' + (q('#hud-stage')||{}).textContent;
  out.info.tabsVisible = qa('.pane-tab').every(t => t.getBoundingClientRect().width > 0);
  return JSON.stringify(out);
})()`;

try {
  const ws = new WebSocket(await getWs());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(waitSec * 1000);
  if (clicks.length) {
    await send('Runtime.evaluate', {
      expression: clicks.map(s => `(function(){var e=document.querySelector(${JSON.stringify(s)});if(e)e.click();})()`).join(';'),
    });
    await sleep(6000);
  }
  const r = await send('Runtime.evaluate', { expression: AUDIT, returnByValue: true });
  const val = r.result && r.result.value;
  const o = JSON.parse(val);
  console.log(JSON.stringify(o, null, 1));
} catch (e) {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(process.exitCode || 0);
}
