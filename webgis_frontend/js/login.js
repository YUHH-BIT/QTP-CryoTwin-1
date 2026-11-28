/**
 * 登录页脚本（2026-11-28 两步流程；21:20 视觉改为深蓝夜空口径）
 *
 * 第一步 选账号 → 第二步 输密码。选中的账号只是「预填用户名」，
 * 密码必须手输，最终仍提交到 POST /api/auth/login（用户名 + 密码）。
 * 视觉与「账号设置」弹窗同源（#16233a 卡 / #2a3b55 描边 / #101c2f 输入底），不是 OAuth。
 *
 * return 参数仅允许白名单页面，避免开放重定向。
 */
(function () {
  'use strict';

  var ALLOWED_RETURN = [
    'index.html', 'query.html', 'simulate.html', 'alert.html',
    'decision.html', 'terrain3d.html', 'admin.html'
  ];

  /* 演示账号列表：与后端 admin_db 初始化的三个账号一一对应
     （admin / operator / viewer），仅用于渲染账号选择器。
     密码不写在前端，避免随仓库泄露；演示密码见项目根目录 .env。 */
  var ACCOUNTS = [
    { username: 'admin',    name: '系统管理员', role: '系统管理员', color: '#3b82f6' },
    { username: 'operator', name: '运维人员',   role: '运维人员',   color: '#14b8a6' },
    { username: 'viewer',   name: '访客',       role: '访客',       color: '#64748b' }
  ];

  var params = new URLSearchParams(window.location.search);
  var ret = params.get('return_url') || params.get('return');
  var returnUrl = ALLOWED_RETURN.indexOf(ret) >= 0 ? ret : 'index.html';

  var stepAccounts = document.getElementById('step-accounts');
  var stepLogin = document.getElementById('step-login');
  var acctList = document.getElementById('acct-list');
  var acctOther = document.getElementById('acct-other');
  var acctCurrent = document.getElementById('acct-current');
  var fieldUsername = document.getElementById('field-username');
  var usernameInput = document.getElementById('username');
  var passwordInput = document.getElementById('password');
  var showPw = document.getElementById('show-pw');
  var errBox = document.getElementById('login-error');
  var form = document.getElementById('login-form');
  var btn = document.getElementById('login-btn');
  var backLink = document.getElementById('back-link');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function avatarHTML(acc, size) {
    // 头像取显示名首字（系统管理员 → 「系」、运维人员 → 「运」、访客 → 「访」）
    var initial = (acc.name || acc.username || '?').trim().charAt(0);
    return '<span class="acct-avatar" style="background:' + esc(acc.color || '#8b98a8') +
      (size ? ';width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size / 2.6) + 'px' : '') +
      '">' + esc(initial) + '</span>';
  }

  var chevron =
    '<span class="acct-arrow">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
        '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>' +
    '</span>';

  /* ---------------- 第一步：账号列表 ---------------- */
  function renderAccounts() {
    acctList.innerHTML = ACCOUNTS.map(function (acc, i) {
      return '<button class="acct-row" type="button" data-idx="' + i + '">' +
        avatarHTML(acc) +
        '<span class="acct-text">' +
          '<span class="acct-name">' + esc(acc.name) + '</span>' +
          '<span class="acct-meta">' + esc(acc.username) + '</span>' +
        '</span>' + chevron +
      '</button>';
    }).join('');

    acctList.querySelectorAll('.acct-row').forEach(function (row) {
      row.addEventListener('click', function () {
        chooseAccount(ACCOUNTS[Number(row.getAttribute('data-idx'))]);
      });
    });
  }

  /* ---------------- 第二步 ---------------- */
  function showLogin() {
    stepAccounts.hidden = true;
    stepLogin.hidden = false;
    errBox.hidden = true;
    passwordInput.value = '';
    passwordInput.type = 'password';
    showPw.checked = false;
    setTimeout(function () { passwordInput.focus(); }, 30);
  }

  function chooseAccount(acc) {
    usernameInput.value = acc.username;
    fieldUsername.hidden = true;
    acctCurrent.hidden = false;
    acctCurrent.innerHTML = avatarHTML(acc, 36) +
      '<span class="acct-text">' +
        '<span class="acct-name">' + esc(acc.name) + '</span>' +
        '<span class="acct-meta">' + esc(acc.username) + '</span>' +
      '</span>';
    backLink.textContent = '使用其他账号';
    showLogin();
  }

  function chooseManual() {
    usernameInput.value = '';
    fieldUsername.hidden = false;
    acctCurrent.hidden = true;
    acctCurrent.innerHTML = '';
    backLink.textContent = '返回账号列表';
    showLogin();
    setTimeout(function () { usernameInput.focus(); }, 30);
  }

  function backToAccounts() {
    stepLogin.hidden = true;
    stepAccounts.hidden = false;
    errBox.hidden = true;
    passwordInput.value = '';
    usernameInput.value = '';
    fieldUsername.hidden = true;
  }

  /* ---------------- 显示密码 ---------------- */
  if (showPw) {
    showPw.addEventListener('change', function () {
      passwordInput.type = showPw.checked ? 'text' : 'password';
      passwordInput.focus();
    });
  }

  /* ---------------- 提交 ---------------- */
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      errBox.hidden = true;

      var username = (usernameInput.value || '').trim();
      if (!username) {
        errBox.textContent = '请先选择账号或输入用户名';
        errBox.hidden = false;
        return;
      }
      if (!passwordInput.value) {
        errBox.textContent = '请输入密码';
        errBox.hidden = false;
        passwordInput.focus();
        return;
      }

      btn.disabled = true;
      btn.textContent = '登录中…';

      fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: passwordInput.value })
      })
        .then(function (resp) {
          return resp.json().catch(function () { return {}; }).then(function (data) {
            return { ok: resp.ok, data: data };
          });
        })
        .then(function (r) {
          if (r.ok && r.data && r.data.success) {
            // 管理员登录后直接进系统管理（不带 cat，落在默认的「系统状态」概览页）；
            // 其他角色回来源页（无后台可进）
            var target = (r.data.role_code === 'admin') ? 'admin.html' : returnUrl;
            window.location.href = target;
            return;
          }
          errBox.textContent = (r.data && r.data.message) || '用户名或密码错误';
          errBox.hidden = false;
          passwordInput.select();
        })
        .catch(function () {
          errBox.textContent = '网络错误，请稍后重试';
          errBox.hidden = false;
        })
        .then(function () {
          btn.disabled = false;
          btn.textContent = '下一步';
        });
    });
  }

  /* ---------------- 演示提示（?hint=1 才显示） ---------------- */
  var hintBox = document.getElementById('login-hint');
  if (hintBox && params.get('hint') === '1') {
    hintBox.innerHTML =
      '演示账号：<code>admin</code> / <code>operator</code> / <code>viewer</code>，' +
      '密码见项目根目录 <code>.env</code> 的 ADMIN_PASSWORD / OPERATOR_PASSWORD / VIEWER_PASSWORD。';
    hintBox.hidden = false;
  }

  /* ---------------- 返回上一页 ----------------
     有历史记录就 history.back()（从哪个页面点进登录就回哪里，不硬回首页）；
     直接打开登录页（无历史）时才由 href 兜底回首页。 */
  var pageBack = document.getElementById('page-back');
  if (pageBack) {
    pageBack.addEventListener('click', function (e) {
      // 从后台/登录页弹回来的（退出登录、会话过期）不再回退，否则会
      // admin.html → 登录页 来回弹；这种情况交回 href 兜底的首页
      var ref = document.referrer || '';
      var bounced = ref.indexOf('admin.html') >= 0 || ref.indexOf('login.html') >= 0;
      if (window.history.length > 1 && !bounced) {
        e.preventDefault();
        window.history.back();
      }
    });
  }

  /* ---------------- 绑定 ---------------- */
  renderAccounts();
  if (acctOther) acctOther.addEventListener('click', chooseManual);
  if (backLink) backLink.addEventListener('click', backToAccounts);
})();
