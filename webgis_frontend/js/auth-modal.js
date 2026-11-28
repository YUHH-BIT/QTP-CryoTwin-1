/**
 * 登录弹窗（2026-11-28 21:30）
 *
 * 形态与「账号设置」弹窗一致：不跳页，直接浮在当前系统页面之上。
 * 两步：选账号 → 输密码；仍提交 POST /api/auth/login（账号密码，不是 OAuth）。
 * 登录成功后就地刷新当前页（身份区随之变成头像），不强制跳系统管理。
 *
 * 依赖：js/ui-components.js（UI.modal / UI.toast）
 * 用法：
 *   AuthModal.open({ returnUrl: 'index.html' })     业务页顶栏「登录」
 *   AuthModal.open()                                后台页 401 兜底
 * 若 UI 组件缺失，回退为跳转 login.html。
 */
(function () {
  'use strict';

  // 与后端 seed 的三个账号一一对应；密码不写在前端
  var ACCOUNTS = [
    { username: 'admin',    name: '系统管理员', color: '#3b82f6' },
    { username: 'operator', name: '运维人员',   color: '#14b8a6' },
    { username: 'viewer',   name: '访客',       color: '#64748b' }
  ];

  var CSS = [
    '.am-lead{margin:0 0 12px;font-size:12.5px;color:#8fa3bd;line-height:1.6}',
    '.am-list{display:flex;flex-direction:column;gap:8px}',
    '.am-row{display:flex;align-items:center;gap:12px;width:100%;padding:9px 12px;',
    '  border:1px solid #2a3b55;border-radius:10px;background:rgba(255,255,255,.035);',
    '  font-family:inherit;text-align:left;cursor:pointer;color:inherit;',
    '  transition:background-color .15s ease,border-color .15s ease}',
    '.am-row:hover{background:rgba(255,255,255,.075);border-color:#3a4a66}',
    '.am-row:focus-visible{outline:2px solid rgba(59,130,246,.8);outline-offset:1px}',
    '.am-avatar{width:36px;height:36px;flex:0 0 auto;border-radius:50%;display:inline-flex;',
    '  align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:500;',
    '  box-shadow:inset 0 0 0 1px rgba(255,255,255,.16)}',
    '.am-avatar.ghost{background:#101c2f;color:#7dd3fc;border:1px dashed #3a4a66;box-shadow:none}',
    '.am-text{min-width:0;flex:1}',
    '.am-name{display:block;font-size:14px;font-weight:500;color:#e8f1ff;',
    '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.am-meta{display:block;margin-top:2px;font-size:12px;color:#7f92ad;',
    '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.am-arrow{flex:0 0 auto;color:#5b6f8e;display:flex;align-items:center;transition:color .15s ease,transform .15s ease}',
    '.am-row:hover .am-arrow{color:#7dd3fc;transform:translateX(2px)}',
    '.am-sep{height:1px;background:#22314a;margin:4px 0}',
    '.am-current{display:flex;align-items:center;gap:12px;padding:9px 12px;margin-bottom:14px;',
    '  border:1px solid #2a3b55;border-radius:10px;background:rgba(255,255,255,.035);min-width:0}',
    '.am-field{margin-bottom:12px}',
    '.am-input{width:100%;height:42px;padding:0 12px;border:1px solid #334563;border-radius:8px;',
    '  background:#101c2f;font-family:inherit;font-size:14px;color:#dbe7f6;outline:none;',
    '  transition:border-color .15s ease,box-shadow .15s ease,background-color .15s ease}',
    '.am-input::placeholder{color:#7d90aa}',
    // 输错后会用 select() 选中内容，默认的浅色选区在深色输入框上非常刺眼
    '.am-input::selection{background:rgba(59,130,246,.38);color:#eef5ff}',
    '.am-input:focus{border-color:#3b82f6;background:#0e1929;box-shadow:0 0 0 3px rgba(59,130,246,.18)}',
    '.am-show{display:inline-flex;align-items:center;gap:7px;margin-bottom:4px;font-size:12.5px;',
    '  color:#8fa3bd;cursor:pointer;user-select:none}',
    '.am-show input{appearance:none;-webkit-appearance:none;position:relative;width:15px;height:15px;',
    '  margin:0;border:1px solid #3a4a66;border-radius:4px;background:#101c2f;cursor:pointer;',
    '  transition:background-color .15s ease,border-color .15s ease}',
    '.am-show input:checked{border-color:#3b82f6;background:#3b82f6}',
    '.am-show input:checked::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;',
    '  border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}',
    '.am-error{margin-top:10px;padding:8px 11px;border:1px solid rgba(239,68,68,.35);border-radius:8px;',
    '  background:rgba(239,68,68,.12);color:#fca5a5;font-size:12.5px;line-height:1.5}',
    '.am-link{margin-right:auto;border:none;background:none;padding:8px 2px;font-family:inherit;',
    '  font-size:12.5px;color:#7dd3fc;cursor:pointer}',
    '.am-link:hover{text-decoration:underline}',
    '.am-btn{height:38px;padding:0 20px;border:none;border-radius:8px;font-family:inherit;font-size:14px;',
    '  font-weight:500;cursor:pointer;transition:filter .15s ease,box-shadow .15s ease}',
    '.am-btn.ghost{background:rgba(255,255,255,.06);color:#c3d3e8;border:1px solid #334563}',
    '.am-btn.ghost:hover{background:rgba(255,255,255,.1)}',
    '.am-btn.primary{background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);color:#fff;',
    '  box-shadow:0 6px 18px rgba(59,130,246,.30)}',
    '.am-btn.primary:hover{filter:brightness(1.08);box-shadow:0 8px 22px rgba(59,130,246,.40)}',
    '.am-btn:disabled{opacity:.6;cursor:not-allowed;box-shadow:none}'
  ].join('\n');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureStyle() {
    if (document.getElementById('auth-modal-style')) return;
    var s = document.createElement('style');
    s.id = 'auth-modal-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function avatarHTML(name, color, size) {
    var initial = String(name || '?').trim().charAt(0);
    return '<span class="am-avatar" style="background:' + esc(color || '#64748b') +
      (size ? ';width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size / 2.6) + 'px' : '') +
      '">' + esc(initial) + '</span>';
  }

  var chevron =
    '<span class="am-arrow"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg></span>';

  // 弹窗是否已打开（401 可能连发多次，避免叠出多个登录框）
  function isOpen() {
    return !!document.querySelector('.ui-modal-overlay.am-open');
  }

  function open(opts) {
    opts = opts || {};
    if (isOpen()) return null;

    if (!window.UI || !UI.modal) {
      // UI 组件缺失时的兜底：退回独立登录页
      window.location.href = 'login.html?return_url=' +
        encodeURIComponent(opts.returnUrl || 'index.html');
      return null;
    }

    ensureStyle();

    var state = { user: '', name: '', color: '', manual: false };

    var overlay = UI.modal({ title: '登录', icon: 'fa-sign-in', closeable: true });
    overlay.classList.add('am-open');
    var modal = overlay.querySelector('.ui-modal');
    var titleEl = overlay.querySelector('.ui-modal-title span');
    var bodyEl = overlay.querySelector('.ui-modal-body');
    var footer = document.createElement('div');
    footer.className = 'ui-modal-footer';
    modal.appendChild(footer);

    /* ---------------- 第一步：账号列表 ---------------- */
    function renderAccounts() {
      titleEl.textContent = '登录';
      bodyEl.innerHTML =
        '<p class="am-lead">选择一个账号继续，或使用其他账号手动登录。</p>' +
        '<div class="am-list">' +
          ACCOUNTS.map(function (acc) {
            return '<button class="am-row" type="button" data-user="' + esc(acc.username) + '">' +
              avatarHTML(acc.name, acc.color) +
              '<span class="am-text">' +
                '<span class="am-name">' + esc(acc.name) + '</span>' +
                '<span class="am-meta">' + esc(acc.username) + '</span>' +
              '</span>' + chevron + '</button>';
          }).join('') +
          '<div class="am-sep"></div>' +
          '<button class="am-row" type="button" data-manual="1">' +
            '<span class="am-avatar ghost"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
              '<path fill="currentColor" d="M12 5v14M5 12h14" stroke="currentColor" ' +
              'stroke-width="2" stroke-linecap="round"/></svg></span>' +
            '<span class="am-text"><span class="am-name">使用其他账号</span></span>' +
          '</button>' +
        '</div>';

      footer.innerHTML = '';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'am-btn ghost';
      cancel.textContent = '取消';
      cancel.addEventListener('click', close);
      footer.appendChild(cancel);

      bodyEl.querySelectorAll('.am-row').forEach(function (row) {
        row.addEventListener('click', function () {
          var u = row.getAttribute('data-user');
          if (u) {
            var acc = ACCOUNTS.filter(function (a) { return a.username === u; })[0];
            state.user = acc.username;
            state.name = acc.name;
            state.color = acc.color;
            state.manual = false;
          } else {
            state.user = '';
            state.name = '';
            state.color = '';
            state.manual = true;
          }
          renderPassword();
        });
      });
    }

    /* ---------------- 第二步：密码 ---------------- */
    function renderPassword() {
      titleEl.textContent = '登录';
      bodyEl.innerHTML =
        (state.manual
          ? '<div class="am-field"><input class="am-input" id="am-user" type="text" ' +
            'placeholder="用户名" autocomplete="username" /></div>'
          : '<div class="am-current">' + avatarHTML(state.name, state.color) +
            '<span class="am-text">' +
              '<span class="am-name">' + esc(state.name) + '</span>' +
              '<span class="am-meta">' + esc(state.user) + '</span>' +
            '</span></div>') +
        '<div class="am-field"><input class="am-input" id="am-pw" type="password" ' +
          'placeholder="输入密码" autocomplete="current-password" /></div>' +
        '<label class="am-show"><input type="checkbox" id="am-showpw" /> 显示密码</label>' +
        '<div class="am-error" id="am-err" hidden></div>';

      footer.innerHTML = '';
      var back = document.createElement('button');
      back.type = 'button';
      back.className = 'am-link';
      back.textContent = state.manual ? '返回账号列表' : '使用其他账号';
      back.addEventListener('click', function () {
        if (state.manual) renderAccounts();
        else { state.manual = true; state.user = ''; state.name = ''; renderPassword(); }
      });

      var submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.className = 'am-btn primary';
      submitBtn.textContent = '登录';
      submitBtn.addEventListener('click', submit);

      footer.appendChild(back);
      footer.appendChild(submitBtn);

      var pw = document.getElementById('am-pw');
      var showPw = document.getElementById('am-showpw');
      showPw.addEventListener('change', function () {
        pw.type = showPw.checked ? 'text' : 'password';
        pw.focus();
      });
      pw.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      var userInput = document.getElementById('am-user');
      if (userInput) {
        userInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); pw.focus(); }
        });
      }
      setTimeout(function () {
        (userInput || pw).focus();
      }, 60);

      function submit() {
        var user = state.manual
          ? (document.getElementById('am-user').value || '').trim()
          : state.user;
        var password = pw.value || '';
        var err = document.getElementById('am-err');

        function fail(msg) {
          err.textContent = msg;
          err.hidden = false;
          pw.select();
        }

        if (!user) { fail('请输入用户名'); return; }
        if (!password) { fail('请输入密码'); pw.focus(); return; }

        submitBtn.disabled = true;
        submitBtn.textContent = '登录中…';
        err.hidden = true;

        fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, password: password })
        })
          .then(function (resp) {
            return resp.json().catch(function () { return {}; }).then(function (d) {
              return { ok: resp.ok, data: d };
            });
          })
          .then(function (r) {
            if (r.ok && r.data && r.data.success) {
              overlay.classList.remove('am-open');
              if (typeof opts.onSuccess === 'function') {
                opts.onSuccess(r.data);
                return;
              }
              // 只重渲染顶栏身份区，不整页刷新：地图、图层与播放状态都不打断。
              // 后台页需要重新拉数据，自己传 onSuccess 做 reload。
              if (window.UserMenu && typeof window.UserMenu.refresh === 'function') {
                close();
                window.UserMenu.refresh();
                return;
              }
              window.location.reload();
              return;
            }
            fail((r.data && r.data.message) || '用户名或密码错误');
            submitBtn.disabled = false;
            submitBtn.textContent = '登录';
          })
          .catch(function () {
            fail('网络错误，请稍后重试');
            submitBtn.disabled = false;
            submitBtn.textContent = '登录';
          });
      }
    }

    function close() {
      overlay.classList.remove('am-open');
      var btn = overlay.querySelector('.ui-modal-close');
      if (btn) btn.click();
    }

    renderAccounts();
    return overlay;
  }

  window.AuthModal = { open: open };
})();
