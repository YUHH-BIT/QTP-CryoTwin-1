/**
 * 顶栏身份区 / 登录页 端到端自检（2026-11-28）
 *
 * 走真实后端会话：
 *   1. login.html → 点「系统管理员」→ 截第二步 → 输密码登录
 *   2. 校验登录后直接落到 admin.html?cat=user（管理面板已打开）
 *   3. index.html → 量顶栏几何（模块条中线、右侧区、无溢出）+ 截身份区
 *   4. 从管理面板「退出」→ 未登录态顶栏出现「登录」按钮
 *   5. 1280 窄屏不挤压
 *
 * 用法：node scripts/_logincheck.mjs   （需 5000 端口已起服务）
 * 密码取环境变量 QTP_ADMIN_PW，默认 123456。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const BASE = 'http://127.0.0.1:5000';
const OUT = 'F:/QTP‑CryoTwin/.runtime/shots';
const PASSWORD = process.env.QTP_ADMIN_PW || '123456';

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'cdp-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1600,900', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      const p = list.find(t => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

const target = await pageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    console.log('PAGE ERROR:', (d.exception && d.exception.description) || d.text);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    console.log('CONSOLE ERROR:', JSON.stringify(msg.params.args.map(a => a.value || a.description)));
  }
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + expression.slice(0, 80));
  return r.result.value;
}

async function shot(name, height = 320) {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1600, height, scale: 1 },
    captureBeyondViewport: true
  });
  writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('shot:', name);
}

/** 局部放大截图，用于核对细节（如右上角身份区） */
async function shotRegion(name, x, y, w, h, scale = 2) {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width: w, height: h, scale },
    captureBeyondViewport: true
  });
  writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('shot:', name);
}

async function goto(url, wait = 2000) {
  await send('Page.navigate', { url });
  await sleep(wait);
}

/** 轮询等待选择器出现（后端单线程，地图瓦片会把 /api/auth/me 挤到队尾） */
async function waitFor(selector, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ok = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false);
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

async function waitPath(part, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const p = await evaluate('location.pathname + location.search').catch(() => '');
    if (p.indexOf(part) >= 0) return p;
    await sleep(300);
  }
  return null;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

try {
  /* ---------- 0. 从首页进登录 → 「返回上一页」应回首页 ---------- */
  await goto(`${BASE}/index.html`);
  await waitFor('#tu-login');
  await evaluate(`document.getElementById('tu-login').click(); true`);
  await waitPath('login.html');
  await evaluate(`document.getElementById('page-back').click(); true`);
  console.log('返回上一页落点:', (await waitPath('index.html')) || '（未回退）');

  /* ---------- 1. 登录页第一步 ---------- */
  await goto(`${BASE}/login.html`);
  await sleep(800);
  console.log('登录页页脚是否还有说明文字:',
    await evaluate(`!!document.querySelector('.login-foot')`));
  await shot('01_login_step1.png', 760);

  /* ---------- 2. 选账号 → 第二步 ---------- */
  await evaluate(`document.querySelectorAll('.acct-row')[0].click(); true`);
  await sleep(400);
  await shot('02_login_step2.png', 760);

  /* ---------- 3. 输密码登录 → 应直接进管理页 ---------- */
  await evaluate(`
    (() => {
      document.getElementById('password').value = ${JSON.stringify(PASSWORD)};
      document.getElementById('login-btn').click();
      return true;
    })()
  `);
  const landed = await waitPath('admin.html');
  console.log('登录后落点:', landed || '（未跳转）');
  const tOpen = Date.now();
  let openMs = null;
  for (let i = 0; i < 100; i++) {
    const d = await evaluate(`(() => { const o = document.getElementById('admin-overlay');
      return o ? getComputedStyle(o).display : 'no-overlay'; })()`).catch(() => '');
    if (d === 'flex') { openMs = Date.now() - tOpen; break; }
    await sleep(200);
  }
  console.log('管理面板打开耗时(ms):', openMs === null ? '超时未打开' : openMs);

  let badgeText = '';
  for (let i = 0; i < 60; i++) {
    badgeText = await evaluate(`(() => { const b = document.getElementById('admin-current-user');
      return b ? b.textContent : ''; })()`).catch(() => '');
    if (badgeText) break;
    await sleep(300);
  }
  console.log('面板标题栏用户徽标:', JSON.stringify(badgeText));
  console.log('me 状态:', await evaluate(`fetch('/api/auth/me').then(r => r.status).catch(e => 'ERR')`));
  await sleep(1500);
  await shot('03_admin_after_login.png', 900);

  /* ---------- 4. 首页顶栏（管理员身份区 = 直达入口） ---------- */
  await goto(`${BASE}/index.html`);
  console.log('身份区出现:', await waitFor('#tu-enter'));
  await evaluate(`(()=>{const o=document.getElementById('loading-overlay');if(o)o.classList.remove('active');return true})()`);
  await sleep(500);

  const geo = await evaluate(`
    (() => {
      const box = el => { if (!el) return null; const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), w: Math.round(b.width), right: Math.round(b.right) }; };
      const nav = document.querySelector('.nav-links');
      const right = document.querySelector('.topbar-right');
      const enter = document.getElementById('tu-enter');
      const nb = nav.getBoundingClientRect(), rb = right.getBoundingClientRect();
      return {
        vw: innerWidth,
        navItems: [...document.querySelectorAll('.nav-links > a, .nav-links > .dropdown-container > .dropdown-toggle')].map(e => e.textContent.trim()),
        navCenter: Math.round(nb.left + nb.width / 2), vwCenter: Math.round(innerWidth / 2),
        right: box(right), userEntry: box(enter),
        searchBtn: box(document.getElementById('search-btn')),
        searchInput: box(document.getElementById('place-search')),
        entryHref: enter ? enter.getAttribute('href') : null,
        entryText: enter ? enter.textContent.trim() : null,
        hasMenu: !!document.getElementById('tu-menu'),
        overlap: rb.left < nb.right,
        overflowX: document.documentElement.scrollWidth > innerWidth
      };
    })()
  `);
  console.log('顶栏几何:', JSON.stringify(geo));
  await shot('04_topbar_admin.png', 300);
  await shotRegion('04b_topbar_right_zoom.png', 1240, 0, 340, 62, 2);

  /* ---------- 5. 点身份区 → 进管理页 ---------- */
  await evaluate(`document.getElementById('tu-enter').click(); true`);
  const entered = await waitPath('admin.html');
  console.log('点身份区落点:', entered || '（未跳转）');

  /* ---------- 6. 退出登录 → 未登录态 ---------- */
  // 等面板头部绑定完成（徽标有内容），否则点击会落在未绑定监听器的按钮上
  for (let i = 0; i < 60; i++) {
    const t = await evaluate(`(() => { const b = document.getElementById('admin-current-user');
      return b ? b.textContent : ''; })()`).catch(() => '');
    if (t) break;
    await sleep(300);
  }
  await evaluate(`document.getElementById('admin-logout-btn').click(); true`);
  const backToLogin = await waitPath('login.html');
  console.log('退出后路径:', backToLogin || '（未跳登录页）');

  await goto(`${BASE}/index.html`);
  console.log('未登录身份区出现:', await waitFor('#tu-login'));
  await evaluate(`(()=>{const o=document.getElementById('loading-overlay');if(o)o.classList.remove('active');return true})()`);
  await sleep(500);
  console.log('未登录态:', await evaluate(`
    (() => { const b = document.getElementById('tu-login');
      const r = b ? b.getBoundingClientRect() : null;
      return { text: b ? b.textContent.trim() : null, x: r ? Math.round(r.x) : null, w: r ? Math.round(r.width) : null }; })()
  `));
  await shot('05_topbar_guest.png', 300);

  /* ---------- 7. 窄屏 1280 ---------- */
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  console.log('窄屏 1280:', await evaluate(`
    (() => {
      const nav = document.querySelector('.nav-links').getBoundingClientRect();
      const right = document.querySelector('.topbar-right').getBoundingClientRect();
      return { navCenter: Math.round(nav.left + nav.width / 2), vwCenter: Math.round(innerWidth / 2),
        gap: Math.round(right.left - nav.right), overflowX: document.documentElement.scrollWidth > innerWidth };
    })()
  `));
  await shot('06_topbar_1280.png', 300);
} finally {
  try { ws.close(); } catch (e) {}
  chrome.kill();
}
