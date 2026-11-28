/**
 * 顶栏身份区（2026-11-28）
 *
 * 背景：「系统管理」原为顶栏一级导航项，和「数据查询 / 过程模拟 / 风险评估 / 决策支持」
 * 四个业务模块并列，层级不对等，且 8 个子项的下拉是顶栏唯一会溢出滚动的菜单。
 * 现撤销该导航项，改由右上角（搜索框右侧）的身份区承载：
 *
 *   未登录 → 「登录」按钮，跳 login.html 并带回跳地址
 *   已登录 → 头像 + 显示名称，下拉为「系统管理（仅 admin）/ 退出登录」
 *
 * 用法：页面顶栏放 <div class="topbar-user" id="topbar-user"></div> 并引入本脚本。
 * 数据来自 /api/auth/me（401 视为未登录，不报错、不打扰业务页）。
 */
(function () {
  'use strict';

  var mount = document.getElementById('topbar-user');
  if (!mount) return;

  // 只允许在这几个页面之间回跳，避免开放重定向（与 login.js 的白名单保持一致）
  var ALLOWED_RETURN = [
    'index.html', 'query.html', 'simulate.html', 'alert.html',
    'decision.html', 'terrain3d.html', 'admin.html'
  ];

  var ROLE_LABEL = {
    admin: '系统管理员',
    operator: '运维人员',
    viewer: '访客'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function currentPage() {
    var name = window.location.pathname.split('/').pop() || 'index.html';
    return ALLOWED_RETURN.indexOf(name) >= 0 ? name : 'index.html';
  }

  /* ---------------- 未登录 ---------------- */
  function renderGuest() {
    mount.classList.remove('open');
    mount.innerHTML =
      '<button type="button" class="tu-btn" id="tu-login" title="登录">' +
        '<i class="fa fa-user"></i><span>登录</span>' +
      '</button>';
    document.getElementById('tu-login').addEventListener('click', function () {
      window.location.href = 'login.html?return_url=' + encodeURIComponent(currentPage());
    });
  }

  /* ---------------- 已登录 ----------------
     管理员：不再展开下拉，点身份区直接进系统管理（退出登录在管理面板右上角）；
     非管理员：无后台可进，保留一个只含「退出登录」的小菜单。 */
  function renderUser(me) {
    var name = me.display_name || me.user || '用户';
    var roleCode = me.role_code || '';
    var roleText = ROLE_LABEL[roleCode] || roleCode || '用户';
    // 头像取显示名首字（admin → 「系」），未登录以外的身份提示仍在 title 里
    var initial = String(name).trim().charAt(0) || '用';
    var avatarHTML = '<span class="tu-avatar">' + esc(initial) + '</span>';
    var isAdmin = roleCode === 'admin';
    // 显示名称与角色名相同时（如 admin 的「系统管理员」）不再重复，只留账号
    var metaText = (String(name) === roleText)
      ? (me.user || '')
      : (roleText + ' · ' + (me.user || ''));

    // 身份区只留圆形头像（姓名进 title 提示），给顶栏省出横向空间
    var titleText = name + '（' + (me.user || '') + (roleText ? ' · ' + roleText : '') + '）';

    if (isAdmin) {
      mount.innerHTML =
        '<a class="tu-btn tu-btn-avatar" id="tu-enter" href="admin.html?cat=user" ' +
          'title="' + esc(titleText) + ' · 进入系统管理" aria-label="进入系统管理">' +
          avatarHTML +
        '</a>';
      return;
    }

    mount.innerHTML =
      '<button type="button" class="tu-btn tu-btn-avatar" id="tu-toggle" ' +
        'aria-haspopup="true" aria-expanded="false" title="' + esc(titleText) + '">' +
        avatarHTML +
      '</button>' +
      '<div class="tu-menu" id="tu-menu" role="menu">' +
        '<div class="tu-menu-meta">' +
          '<span class="n">' + esc(name) + '</span>' +
          '<span class="r">' + esc(metaText) + '</span>' +
        '</div>' +
        '<button type="button" id="tu-logout" class="tu-danger" role="menuitem"><i class="fa fa-sign-out"></i>退出登录</button>' +
      '</div>';

    var toggle = document.getElementById('tu-toggle');
    var logout = document.getElementById('tu-logout');

    function close() {
      mount.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = mount.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    document.addEventListener('click', function (e) {
      if (!mount.contains(e.target)) close();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mount.classList.contains('open')) {
        close();
        toggle.focus();
      }
    });

    logout.addEventListener('click', function () {
      logout.disabled = true;
      // 服务端单线程，地图瓦片多时登出请求可能排队；最多等 3s，超时也照样跳登录页，
      // 避免按钮点了像死掉（登录接口本身会 session.clear，不会残留旧身份）
      var done = false;
      function go() {
        if (done) return;
        done = true;
        window.location.href = 'login.html';
      }
      setTimeout(go, 3000);
      fetch('/api/auth/logout', { method: 'POST' })
        .catch(function () { /* 会话已失效也继续跳转 */ })
        .then(go);
    });
  }

  /* ---------------- 初始化 ---------------- */
  fetch('/api/auth/me', { headers: { 'Accept': 'application/json' } })
    .then(function (resp) {
      if (!resp.ok) return null;          // 401 → 未登录
      return resp.json().catch(function () { return null; });
    })
    .then(function (me) {
      if (me && me.success) renderUser(me);
      else renderGuest();
    })
    .catch(function () {
      // 后端不可达时不阻断页面，退化为「登录」按钮
      renderGuest();
    });
})();
