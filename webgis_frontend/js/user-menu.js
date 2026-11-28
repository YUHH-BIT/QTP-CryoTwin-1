/**
 * 顶栏身份区（2026-11-28）
 *
 * 背景：「系统管理」原为顶栏一级导航项，和「数据查询 / 过程模拟 / 风险评估 / 决策支持」
 * 四个业务模块并列，层级不对等，且 8 个子项的下拉是顶栏唯一会溢出滚动的菜单。
 * 现撤销该导航项，改由右上角（搜索框右侧）的身份区承载：
 *
 *   未登录 → 「登录」按钮，点开系统内登录弹窗（js/auth-modal.js），不跳页
 *   已登录 → 头像，下拉为「进入系统管理（仅 admin）/ 账号设置 / 退出登录」
 *            「账号设置」承载当前账号信息与修改密码，后台侧栏不再单列「系统设置」
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
      // 登录做成系统内弹窗（与「账号设置」同一形态），不跳页；组件缺失时退回独立登录页
      if (window.AuthModal && window.AuthModal.open) {
        window.AuthModal.open({ returnUrl: currentPage() });
        return;
      }
      window.location.href = 'login.html?return_url=' + encodeURIComponent(currentPage());
    });
  }

  /* ---------------- 账号设置弹窗 ----------------
     原「系统设置」页只有当前账号信息和改密码，已收进头像菜单。 */
  function openAccountModal(me, roleText) {
    if (!window.UI || !UI.modal) {
      window.alert('账号设置组件未加载');
      return;
    }
    var card = function (label, value) {
      return '<div style="background:#16233a;border:1px solid #2a3b55;border-radius:8px;padding:9px 10px;">' +
        '<div style="font-size:11px;color:#8fa3bd;">' + label + '</div>' +
        '<div style="font-size:14px;color:#e8f1ff;font-weight:600;margin-top:3px;overflow-wrap:anywhere;">' + esc(value) + '</div>' +
      '</div>';
    };
    var inputStyle = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #334563;border-radius:8px;' +
      'background:#101c2f;color:#dbe7f6;font-family:inherit;font-size:13px;';
    var labelStyle = 'display:block;font-size:12px;color:#a9bad2;margin:10px 0 4px;';
    // admin 的 display_name 本身就是「系统管理员」，与所属角色同名，
    // 三张卡并排会把同一句话写两遍；同名时省掉「显示名称」，按实际张数分配列宽
    var nameText = String(me.display_name || '').trim();
    var roleLabel = String(roleText || '').trim();
    var cards = [card('当前登录账号', me.user || '—')];
    if (nameText && nameText !== roleLabel) cards.push(card('显示名称', nameText));
    cards.push(card('所属角色', roleLabel || '—'));
    var bodyHTML =
      '<div style="display:grid;grid-template-columns:repeat(' + cards.length + ',minmax(0,1fr));gap:8px;">' +
        cards.join('') +
      '</div>' +
      '<label style="' + labelStyle + '">原密码</label>' +
      '<input id="tu-old" type="password" style="' + inputStyle + '" autocomplete="current-password" />' +
      '<label style="' + labelStyle + '">新密码（至少 6 位）</label>' +
      '<input id="tu-new" type="password" style="' + inputStyle + '" autocomplete="new-password" />' +
      '<label style="' + labelStyle + '">确认新密码</label>' +
      '<input id="tu-confirm" type="password" style="' + inputStyle + '" autocomplete="new-password" />';

    var overlay = UI.modal({
      title: '账号设置',
      icon: 'fa-user-circle',
      message: '',
      actions: [
        { text: '取消', type: 'ui-btn-ghost' },
        { text: '保存修改', type: 'ui-btn-primary', onClick: save }
      ]
    });
    var body = overlay.querySelector('.ui-modal-body');
    if (body) body.innerHTML = bodyHTML;

    function save() {
      var oldPwd = (document.getElementById('tu-old') || {}).value || '';
      var newPwd = (document.getElementById('tu-new') || {}).value || '';
      var confirmPwd = (document.getElementById('tu-confirm') || {}).value || '';
      if (newPwd !== confirmPwd) {
        UI.toast('两次输入的新密码不一致', 'warning');
        return;
      }
      if (newPwd.length < 6) {
        UI.toast('新密码至少需要 6 位', 'warning');
        return;
      }
      fetch('/api/admin/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password: oldPwd, new_password: newPwd })
      })
        .then(function (resp) { return resp.json().catch(function () { return {}; }).then(function (d) { return { ok: resp.ok, data: d }; }); })
        .then(function (r) {
          if (!r.ok) throw new Error((r.data && r.data.message) || '修改失败');
          // 后端改密码不销毁会话，不需要把人踢去登录页（那也是「独立登录界面」的残留），
          // 提一句「下次登录用新密码」即可，页面留在原处
          UI.toast('密码已修改，下次登录请使用新密码', 'success');
        })
        .catch(function (err) { UI.toast(err.message || '修改失败', 'error'); });
    }
  }

  /* ---------------- 已登录 ----------------
     管理员下拉：进入系统管理 / 账号设置 / 退出登录；
     非管理员下拉：账号设置 / 退出登录。 */
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

    // 身份区只留圆形头像（姓名进 title 提示），给顶栏省出横向空间；
    // 后台入口与退出登录都收在这一个菜单里（后台页的头部栏已删，不再放操作按钮）
    var titleText = name + '（' + (me.user || '') + (roleText ? ' · ' + roleText : '') + '）';

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
        (isAdmin
          ? '<a href="admin.html" role="menuitem"><i class="fa fa-cogs"></i>进入系统管理</a>'
          : '') +
        '<button type="button" id="tu-account" role="menuitem"><i class="fa fa-user-circle"></i>账号设置</button>' +
        '<div class="tu-menu-sep"></div>' +
        '<button type="button" id="tu-logout" class="tu-danger" role="menuitem"><i class="fa fa-sign-out"></i>退出登录</button>' +
      '</div>';

    var toggle = document.getElementById('tu-toggle');
    var account = document.getElementById('tu-account');
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

    account.addEventListener('click', function () {
      close();
      openAccountModal(me, roleText);
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
      // 服务端单线程，地图瓦片多时登出请求可能排队；最多等 3s，超时也照样处理，
      // 避免按钮点了像死掉（登出接口本身会 session.clear，不会残留旧身份）
      var done = false;
      function go() {
        if (done) return;
        done = true;
        // 后台页退出 = 离开后台，回首页（后台页未登录没有内容可看，留在原地只会盖个登录框）；
        // 业务页退出 = 原地刷新成「未登录」形态，地图状态也不用丢；
        // 没有登录弹窗组件时才回退独立登录页
        if (currentPage() === 'admin.html') {
          window.location.href = 'index.html';
        } else if (window.AuthModal) {
          window.location.reload();
        } else {
          window.location.href = 'login.html';
        }
      }
      setTimeout(go, 3000);
      fetch('/api/auth/logout', { method: 'POST' })
        .catch(function () { /* 会话已失效也继续处理 */ })
        .then(go);
    });
  }

  /* ---------------- 初始化 ----------------
     暴露 UserMenu.refresh()：登录弹窗登录成功后只重渲染身份区，
     不整页刷新（避免地图、图层、播放状态被打断）。 */
  function init() {
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
  }

  window.UserMenu = { refresh: init };
  init();
})();
