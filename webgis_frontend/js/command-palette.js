/* 命令面板（Ctrl+K）逻辑 v20261127cmd
 * 顶栏搜索栏改为触发器；弹出面板内做流域候选过滤。
 * 候选来自 /api/basin/data 的 BasinName，sessionStorage 缓存；地名走自由输入。
 * 确认后写回原 #place-search，并复用各页面原有搜索逻辑，不另造一套定位。
 */
(function () {
  'use strict';
  var VERSION = '20261127cmd';
  var CACHE_KEY = 'qtp_cmd_basins_v1';
  var MAX_ITEMS = 100;

  var input = document.getElementById('place-search');
  var btn = document.getElementById('search-btn');
  var bar = input ? input.closest('.searchbar') : null;
  if (!input || !bar) return;

  /* ---------- 顶栏触发器 ---------- */
  bar.classList.add('cmd-mode');
  input.setAttribute('readonly', 'readonly');
  input.setAttribute('aria-haspopup', 'dialog');
  input.setAttribute('aria-expanded', 'false');
  if (btn) btn.setAttribute('tabindex', '-1');

  var icon = document.createElement('span');
  icon.className = 'cmd-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';
  var kbd = document.createElement('kbd');
  kbd.className = 'cmd-kbd';
  kbd.textContent = 'Ctrl K';
  bar.insertBefore(icon, input);
  input.parentNode.insertBefore(kbd, input.nextSibling);

  /* ---------- 面板 DOM ---------- */
  var overlay = document.createElement('div');
  overlay.className = 'cmd-overlay';
  overlay.setAttribute('role', 'presentation');
  overlay.innerHTML =
    '<div class="cmd-dialog" role="dialog" aria-modal="true" aria-label="搜索地点或流域">' +
      '<div class="cmd-input-row">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>' +
        '<input class="cmd-input" type="text" autocomplete="off" spellcheck="false" placeholder="搜索流域，或输入地名后回车…" />' +
        '<button class="cmd-close" type="button" aria-label="关闭搜索面板" title="关闭">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="cmd-list"></div>' +
      '<div class="cmd-footer"><span>↑↓ 选择流域</span><span>↵ 定位</span><span>Esc 关闭</span></div>' +
    '</div>';
  document.body.appendChild(overlay);

  var paletteInput = overlay.querySelector('.cmd-input');
  var list = overlay.querySelector('.cmd-list');
  var closeBtn = overlay.querySelector('.cmd-close');

  /* ---------- 流域候选数据 ---------- */
  var basins = null;
  function normalizeBasins(j) {
    var seen = Object.create(null);
    var out = [];
    (j && j.features ? j.features : []).forEach(function (f) {
      var raw = (f.properties || {}).BasinName;
      if (typeof raw !== 'string' || !raw.trim()) return;
      var name = raw.replace(/\s+/g, '');
      if (!name || seen[name]) return;
      seen[name] = 1;
      out.push({ name: name, raw: raw.trim() });
    });
    return out;
  }
  function loadBasins() {
    if (basins) return Promise.resolve(basins);
    try {
      var cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) {
        basins = normalizeBasins({ features: JSON.parse(cached) });
        return Promise.resolve(basins);
      }
    } catch (e) { /* sessionStorage 不可用时忽略 */ }
    return fetch('/api/basin/data')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        basins = normalizeBasins(j);
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify(basins.map(function (b) { return { properties: { BasinName: b.raw } }; })));
        } catch (e) { /* 忽略 */ }
        return basins;
      })
      .catch(function () { basins = []; return basins; });
  }

  /* ---------- 渲染与状态 ---------- */
  var isOpen = false;
  var active = -1;
  var filtered = [];

  function render(q) {
    filtered = [];
    list.textContent = '';
    if (!basins) basins = [];

    var needle = (q || '').trim().replace(/\s+/g, '').toLowerCase();
    basins.forEach(function (b) {
      if (filtered.length >= MAX_ITEMS) return;
      if (!needle || b.name.toLowerCase().indexOf(needle) !== -1) filtered.push(b);
    });

    if (filtered.length) {
      var group = document.createElement('div');
      group.className = 'cmd-group';
      group.textContent = needle ? '流域 · 匹配 ' + filtered.length + ' 项' : '流域';
      list.appendChild(group);

      filtered.forEach(function (b, i) {
        var row = document.createElement('div');
        row.className = 'cmd-item' + (i === active ? ' active' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('data-i', String(i));
        row.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 8c4 0 4 4 8 4s4-4 8-4 4 4 4 4"/><path d="M2 16c4 0 4 4 8 4s4-4 8-4 4 4 4 4"/></svg>';
        var name = document.createElement('span');
        name.className = 'cmd-name';
        name.textContent = b.name;
        var tag = document.createElement('span');
        tag.className = 'cmd-tag';
        tag.textContent = '流域';
        row.appendChild(name);
        row.appendChild(tag);
        list.appendChild(row);
      });
    } else if (needle) {
      var hint = document.createElement('div');
      hint.className = 'cmd-hint';
      hint.appendChild(document.createTextNode('没有匹配的流域。按 Enter 搜索 '));
      var strong = document.createElement('b');
      strong.textContent = '“' + q.trim() + '”';
      hint.appendChild(strong);
      hint.appendChild(document.createTextNode('（按地名处理）'));
      list.appendChild(hint);
    } else {
      var empty = document.createElement('div');
      empty.className = 'cmd-hint';
      empty.textContent = '流域列表加载失败，可直接输入地名后回车。';
      list.appendChild(empty);
    }
  }

  function openPanel() {
    if (isOpen) { paletteInput.focus(); return; }
    isOpen = true;
    active = -1;
    overlay.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    paletteInput.value = '';
    list.textContent = '';
    var hint = document.createElement('div');
    hint.className = 'cmd-hint';
    hint.textContent = '正在加载流域列表…';
    list.appendChild(hint);
    paletteInput.focus();
    loadBasins().then(function () { if (isOpen) render(paletteInput.value); });
  }

  function closePanel() {
    if (!isOpen) return;
    isOpen = false;
    overlay.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    bar.focus();
  }

  function choose(value) {
    if (!value) return;
    closePanel();
    input.value = value;

    // 复用各页面原有搜索逻辑：首页 handleSearch、三维页 searchHint 都监听
    // #place-search 的 Enter；派发一次即可。其余页本就没有搜索绑定，保持原状。
    var ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
  }

  function chooseActiveOrTyped() {
    if (active >= 0 && filtered[active]) {
      choose(filtered[active].name);
      return;
    }
    var typed = paletteInput.value.trim();
    if (typed) choose(typed);
  }

  function move(delta) {
    if (!filtered.length) return;
    active = (active + delta + filtered.length) % filtered.length;
    render(paletteInput.value);
    var el = list.querySelector('.cmd-item.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- 事件 ---------- */
  bar.addEventListener('click', function (e) {
    e.preventDefault();
    openPanel();
  });

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key || '').toLowerCase() === 'k') {
      e.preventDefault();
      if (isOpen) closePanel(); else openPanel();
      return;
    }
    if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      closePanel();
    }
  });

  paletteInput.addEventListener('input', function () {
    active = -1;
    render(paletteInput.value);
  });

  paletteInput.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); chooseActiveOrTyped(); }
  });

  list.addEventListener('mousedown', function (e) {
    var row = e.target.closest ? e.target.closest('.cmd-item') : null;
    if (!row) return;
    e.preventDefault();
    var i = Number(row.getAttribute('data-i'));
    if (filtered[i]) choose(filtered[i].name);
  });

  overlay.addEventListener('mousedown', function (e) {
    if (e.target === overlay) closePanel();
  });

  closeBtn.addEventListener('click', function (e) {
    e.preventDefault();
    closePanel();
  });

  // 供 CDP 验收与调试
  window.__cmdPalette = {
    version: VERSION,
    open: openPanel,
    close: closePanel,
    state: function () {
      return {
        open: isOpen,
        count: filtered.length,
        active: active,
        basins: basins ? basins.length : 0,
        value: input.value
      };
    }
  };
})();
