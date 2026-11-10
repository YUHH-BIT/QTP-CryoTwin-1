// 一次性诊断：为什么 .pane-tab 的 transform 不生效
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9338;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp5-'));
const child = spawn(EDGE, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--no-first-run', '--window-size=1600,900',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const l = await r.json(); const p = l.find(t => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch (e) { }
    await sleep(400);
  }
  throw new Error('no cdp');
}
let id = 0; const pend = new Map();
function send(ws) {
  return (method, params = {}) => new Promise((res, rej) => {
    const my = ++id; pend.set(my, { res, rej });
    ws.send(JSON.stringify({ id: my, method, params }));
    setTimeout(() => { if (pend.has(my)) { pend.delete(my); rej(new Error('timeout ' + method)); } }, 30000);
  });
}
const PROBE = `(function(){
  const tab = document.getElementById('btn-toggle-left');
  document.body.classList.add('hide-left');
  const out = {};
  out.matches = tab.matches('body.hide-left .pane.left .pane-tab');
  out.before = tab.getBoundingClientRect().left;
  out.computed = getComputedStyle(tab).transform;
  out.inlineTest = (function(){ tab.style.transform='translateX(-272px)'; const v=getComputedStyle(tab).transform; const l=tab.getBoundingClientRect().left; tab.style.transform=''; return [v,l]; })();
  // 找所有命中该元素的 transform 声明
  const hit = [];
  for (const ss of document.styleSheets) {
    let rules; try { rules = ss.cssRules; } catch(e) { continue; }
    for (const r of rules) {
      if (r.type !== 1) continue;
      if (r.style && r.style.transform) hit.push([r.selectorText, r.style.transform]);
    }
  }
  out.transformRules = hit;
  out.vars = getComputedStyle(tab).getPropertyValue('--pane-l');
  const cs = getComputedStyle(tab);
  out.display = cs.display;
  out.position = cs.position;
  out.transition = cs.transitionProperty + ' / ' + cs.transitionDuration;
  out.anims = tab.getAnimations().map(a => ({ n: a.transitionProperty || a.animationName, st: a.playState, t: a.currentTime }));
  const panel = document.querySelector('.pane.left .panel');
  out.panelAnims = panel.getAnimations().map(a => ({ n: a.transitionProperty, st: a.playState, t: a.currentTime }));
  return JSON.stringify(out);
})()`;
try {
  const ws = new WebSocket(await wsUrl());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  });
  const s = send(ws);
  await s('Page.enable'); await s('Runtime.enable');
  await s('Page.navigate', { url: 'http://127.0.0.1:8765/?t=200' });
  await sleep(12000);
  const r = await s('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  console.log(r.result.value);
} catch (e) {
  console.error('FAIL ' + e.message);
} finally {
  try { child.kill(); } catch (e) { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  process.exit(0);
}
