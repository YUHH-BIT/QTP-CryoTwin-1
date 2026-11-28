/**
 * 系统管理导航调整自检（2026-11-28）
 *
 * 目标：原「知识库管理」+「设置」合并为「大模型管理」；高德 Key 与配置备份移到「系统状态」。
 *   1. 登录 → admin.html?cat=llm：导航项、三大区块、知识库是否同页
 *   2. admin.html?cat=status：外部服务（高德 Key）+ 配置维护（备份/恢复）是否在
 *   3. 旧链接兼容：?cat=setting / ?cat=kb 落到「大模型管理」
 *   4. 截图存到 .runtime/shots/
 *
 * 用法：node scripts/_adminnavcheck.mjs （需 5000 端口已起服务）
 * 密码取环境变量 QTP_ADMIN_PW，默认 123456。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
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

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('shot:', name);
}

async function goto(url, wait = 2500) {
  await send('Page.navigate', { url });
  await sleep(wait);
}

async function waitFor(selector, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ok = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false);
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

async function waitPath(part, timeout = 25000) {
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
  /* ---------- 登录 ---------- */
  await goto(`${BASE}/login.html`, 1200);
  await evaluate(`document.querySelectorAll('.acct-row')[0].click(); true`);
  await sleep(400);
  await evaluate(`
    (() => {
      document.getElementById('password').value = ${JSON.stringify(PASSWORD)};
      document.getElementById('login-btn').click();
      return true;
    })()
  `);
  console.log('登录落点:', (await waitPath('admin.html')) || '（未跳转）');

  /* ---------- 1. 大模型管理 ---------- */
  await goto(`${BASE}/admin.html?cat=llm`, 2000);
  await waitFor('.admin-nav-item');
  await waitFor('#agent-prompt');
  const nav = await evaluate(`Array.from(document.querySelectorAll('.admin-nav-item')).map(n => n.textContent.trim())`);
  console.log('导航项:', JSON.stringify(nav));
  const active = await evaluate(`(document.querySelector('.admin-nav-item.active')||{}).textContent || ''`);
  console.log('当前高亮:', active.trim());
  const llmInfo = await evaluate(`
    (() => {
      const c = document.getElementById('admin-content');
      const secs = Array.from(c.querySelectorAll('.admin-stat-section-title')).map(e => e.textContent.trim());
      return {
        sections: secs,
        hasPrompt: !!document.getElementById('agent-prompt'),
        hasKbTable: !!c.querySelector('.admin-table'),
        hasKbBtn: !!document.getElementById('kb-rebuild'),
        hasAmap: c.textContent.indexOf('高德') >= 0,
        hasBackup: c.textContent.indexOf('下载备份') >= 0,
        kbStatCount: c.querySelectorAll('.admin-stats .admin-stat').length
      };
    })()
  `);
  console.log('大模型管理:', JSON.stringify(llmInfo));
  await shot('admin_llm.png');
  // 向下滚动看知识库
  await evaluate(`document.getElementById('admin-content').scrollTop = 99999; true`);
  await sleep(600);
  await shot('admin_llm_bottom.png');

  /* ---------- 2. 系统状态 ---------- */
  await goto(`${BASE}/admin.html?cat=status`, 2200);
  await waitFor('#config-restore-btn');
  const stInfo = await evaluate(`
    (() => {
      const c = document.getElementById('admin-content');
      return {
        sections: Array.from(c.querySelectorAll('.admin-stat-section-title')).map(e => e.textContent.trim()),
        hasAmap: c.textContent.indexOf('高德地图 Key') >= 0,
        deepseekCard: (Array.from(c.querySelectorAll('.admin-stat .k')).map(e => e.textContent.trim()).filter(t => t.indexOf('DeepSeek') >= 0)[0]) || '',
        gotoLlm: !!c.querySelector('[data-goto="llm"]'),
        hasBackupDl: !!c.querySelector('a[href="/api/admin/config-backup"]'),
        hasRestore: !!document.getElementById('config-restore-btn')
      };
    })()
  `);
  console.log('系统状态:', JSON.stringify(stInfo));
  await evaluate(`document.getElementById('admin-content').scrollTop = 99999; true`);
  await sleep(600);
  await shot('admin_status_bottom.png');

  /* ---------- 3. 旧链接兼容 ---------- */
  for (const legacy of ['setting', 'kb']) {
    await goto(`${BASE}/admin.html?cat=${legacy}`, 2000);
    await waitFor('#agent-prompt');
    const t = await evaluate(`(document.querySelector('.admin-nav-item.active')||{}).textContent || ''`);
    console.log(`?cat=${legacy} → 高亮:`, t.trim());
  }
} finally {
  try { ws.close(); } catch (e) { /* ignore */ }
  chrome.kill();
}
