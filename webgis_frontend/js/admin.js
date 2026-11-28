/**
 * 系统管理面板（真实数据 CRUD）
 * ============================
 * 依赖后端接口：
 *   /api/auth/me  /api/auth/logout
 *   /api/admin/stats  /api/admin/users  /api/admin/roles
 *   /api/admin/permissions  /api/admin/logs  /api/admin/change-password
 * 说明：所有列表/新增/编辑/删除均调用真实后端；权限不足时后端返回 403 并提示。
 */
(function () {
  'use strict';

  const contentEl = () => document.getElementById('admin-content');
  const overlayEl = () => document.getElementById('admin-overlay');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg,  type) {
    if (window.UI && window.UI.toast) window.UI.toast(msg, type || 'info');
    else window.alert(msg);
  }

  function fmtSize(n) {
    if (!n || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
  }

  async function api(path, options) {
    const resp = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, options || {}));
    if (resp.status === 401) {
      // 后台页同样走系统内登录弹窗，不跳页；组件缺失时回退独立登录页
      if (window.AuthModal && window.AuthModal.open) {
        // 后台页要重新拉全部数据，登录成功后整页重载
        window.AuthModal.open({ returnUrl: 'admin.html', onSuccess: () => window.location.reload() });
      } else {
        window.location.href = 'login.html?return_url=admin.html';
      }
      throw new Error('未登录');
    }
    let data = null;
    try { data = await resp.json(); } catch (e) { /* ignore */ }
    if (!resp.ok) {
      throw new Error((data && data.message) || ('请求失败(' + resp.status + ')'));
    }
    return data;
  }

  function openModal(title, bodyHTML, footHTML) {
    const overlay = document.createElement('div');
    overlay.className = 'admin-modal-overlay';
    overlay.innerHTML =
      '<div class="admin-modal">' +
        '<div class="admin-modal-head"><span>' + esc(title) + '</span><button type="button" data-close="1">&times;</button></div>' +
        '<div class="admin-modal-body">' + bodyHTML + '</div>' +
        (footHTML ? '<div class="admin-modal-foot">' + footHTML + '</div>' : '') +
      '</div>';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || (e.target.getAttribute && e.target.getAttribute('data-close'))) {
        overlay.remove();
      }
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function setContent(html) {
    contentEl().innerHTML = html;
  }

  const AdminPanel = {
    // 默认落地页 = 系统状态（概览优先，2026-11-28 用户定序）
    currentCat: 'status',

    async init() {
      // 登录校验
      let me = null;
      try {
        const r = await api('/api/auth/me');
        me = r;
      } catch (e) {
        return; // 未登录已跳转
      }
      const badge = document.getElementById('admin-current-user');
      if (badge) {
        // 统一显示「账号 · 角色」：display_name 常常就等于角色名（admin 的显示名就是
        // 「系统管理员」），直接拼会出现「系统管理员 · 系统管理员」。
        const ROLE_LABEL = { admin: '系统管理员', operator: '运维人员', viewer: '访客' };
        const roleLabel = ROLE_LABEL[me.role_code] || me.role_code || '';
        badge.textContent = roleLabel ? (me.user + ' · ' + roleLabel) : (me.display_name || me.user);
      }
      this.bindHeader();
      // 打开面板：URL 指定分类则打开该分类，否则落在系统状态（概览）
      const cat = new URLSearchParams(window.location.search).get('cat');
      this.openCategory(cat || 'status');
      // 供 main.js 下拉菜单调用
      window.applyNavCategory = (c) => this.openCategory(c);
    },

    bindHeader() {
      const logoutBtn = document.getElementById('admin-logout-btn');
      if (logoutBtn) logoutBtn.addEventListener('click', async () => {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
        window.location.href = 'login.html';
      });
      const closeBtn = document.getElementById('admin-close-btn');
      if (closeBtn) closeBtn.addEventListener('click', () => { overlayEl().style.display = 'none'; });
      const refreshBtn = document.getElementById('admin-refresh-btn');
      if (refreshBtn) refreshBtn.addEventListener('click', () => this.openCategory(this.currentCat));
      // 左侧导航
      document.querySelectorAll('.admin-nav-item').forEach(item => {
        item.addEventListener('click', () => this.openCategory(item.getAttribute('data-cat')));
      });
    },

    async openCategory(cat) {
      // 2026-11-28 调整：原「知识库管理」与「设置」合并为「大模型管理」。
      // 旧链接 ?cat=kb / ?cat=setting 仍可用，统一映射到 llm。
      const ALIAS = { kb: 'llm', setting: 'llm' };
      if (ALIAS[cat]) cat = ALIAS[cat];
      const valid = ['status', 'data', 'user', 'role', 'log', 'llm'];
      if (valid.indexOf(cat) < 0) cat = 'status';
      this.currentCat = cat;
      overlayEl().style.display = 'flex';
      document.querySelectorAll('.admin-nav-item').forEach(n => {
        n.classList.toggle('active', n.getAttribute('data-cat') === cat);
      });
      // 与系统其他页同款加载动效：双层转轮 + 呼吸文字（样式在 admin.html 的 .admin-loading）
      setContent(
        '<div class="admin-loading">' +
          '<div class="loading-content">' +
            '<div class="loading-spinner"></div>' +
            '<p class="loading-text">系统正在加载中，请稍候...</p>' +
          '</div>' +
        '</div>'
      );
      try {
        await this['render' + cat.charAt(0).toUpperCase() + cat.slice(1)]();
      } catch (e) {
        setContent('<div class="admin-empty">加载失败：' + esc(e.message) + '</div>');
      }
    },

    // ---------------- 用户管理 ----------------
    async renderUser() {
      const page = this._userPage || 1;
      const pageSize = 10;
      const keyword = this._userKeyword || '';
      let qs = 'page=' + page + '&page_size=' + pageSize;
      if (keyword) qs += '&keyword=' + encodeURIComponent(keyword);
      const [uRes, rRes] = await Promise.all([api('/api/admin/users?' + qs), api('/api/admin/roles')]);
      const data = uRes.data || {};
      const items = data.items || [];
      const roles = rRes.data || [];
      const sel = this._userSelected || {};
      const rows = items.map(u => {
        const roleBadge = u.role_name
          ? '<span class="badge badge-blue">' + esc(u.role_name) + '</span>'
          : '<span class="badge badge-gray">未分配</span>';
        const statusBadge = u.status === 1
          ? '<span class="badge badge-ok">正常</span>'
          : '<span class="badge badge-off">禁用</span>';
        return '<tr>' +
          '<td><input type="checkbox" class="user-cb" data-id="' + u.id + '"' + (sel[u.id] ? ' checked' : '') + ' /></td>' +
          '<td>' + u.id + '</td>' +
          '<td>' + esc(u.username) + '</td>' +
          '<td>' + esc(u.display_name || '') + '</td>' +
          '<td>' + roleBadge + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td>' + esc(u.created_at || '') + '</td>' +
          '<td>' + esc(u.last_login || '—') + '</td>' +
          '<td>' +
            '<button class="admin-btn admin-btn-sm" data-action="edit-user" data-id="' + u.id + '">编辑</button> ' +
            '<button class="admin-btn admin-btn-sm" data-action="reset-pwd" data-id="' + u.id + '">重置密码</button> ' +
            '<button class="admin-btn admin-btn-sm admin-btn-danger" data-action="del-user" data-id="' + u.id + '">删除</button>' +
          '</td></tr>';
      }).join('');
      const selCount = Object.keys(sel).length;
      const total = data.total || 0;
      const totalPages = data.total_pages || 1;
      const html =
        '<div class="admin-toolbar">' +
          '<span class="admin-toolbar-gap"></span>' +
          '<input class="admin-search" id="user-search" placeholder="搜索用户名/显示名（回车查询）" value="' + esc(keyword) + '" />' +
          '<button class="admin-btn" data-action="add-user">＋ 新增用户</button>' +
          '<details class="admin-batch"><summary class="admin-btn admin-btn-sm admin-btn-ghost">批量操作 ▾</summary>' +
            '<div class="admin-batch-menu">' +
              '<button data-action="batch-enable">启用</button>' +
              '<button data-action="batch-disable">禁用</button>' +
              '<button class="danger" data-action="batch-delete">删除</button>' +
            '</div></details>' +
          '<span id="user-sel-count" class="badge badge-blue" style="' + (selCount ? '' : 'display:none') + '">已选 ' + selCount + ' 个</span>' +
        '</div>' +
        '<table class="admin-table">' +
          '<thead><tr><th><input type="checkbox" id="user-cb-all" title="全选本页" /></th><th>ID</th><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>创建时间</th><th>最近登录</th><th>操作</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="9" class="admin-empty">暂无用户</td></tr>') + '</tbody>' +
        '</table>' +
        '<div class="admin-pager">' +
          '<span>共 ' + total + ' 条 · 第 ' + page + '/' + totalPages + ' 页</span>' +
          '<button data-action="page-prev" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
          '<button data-action="page-next" data-page="' + (page + 1) + '"' + (page >= totalPages ? ' disabled' : '') + '>下一页</button>' +
        '</div>';
      setContent(html);
      const search = document.getElementById('user-search');
      if (search) {
        search.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            this._userKeyword = search.value.trim();
            this._userPage = 1;
            this.openCategory('user');
          }
        });
      }
      const cbAll = document.getElementById('user-cb-all');
      if (cbAll) {
        cbAll.addEventListener('change', () => {
          document.querySelectorAll('.user-cb').forEach(cb => {
            cb.checked = cbAll.checked;
            if (cb.checked) this._userSelected[cb.getAttribute('data-id')] = true;
            else delete this._userSelected[cb.getAttribute('data-id')];
          });
          this.updateSelBadge();
        });
      }
      document.querySelectorAll('.user-cb').forEach(cb => {
        cb.addEventListener('change', () => {
          const id = cb.getAttribute('data-id');
          if (cb.checked) this._userSelected[id] = true;
          else delete this._userSelected[id];
          this.updateSelBadge();
        });
      });
    },

    updateSelBadge() {
      const n = Object.keys(this._userSelected || {}).length;
      const el = document.getElementById('user-sel-count');
      if (el) {
        el.textContent = '已选 ' + n + ' 个';
        el.style.display = n ? '' : 'none';
      }
    },

    async openUserForm(user) {
      const rRes = await api('/api/admin/roles');
      const roles = rRes.data || [];
      const roleOpts = roles.map(r =>
        '<option value="' + r.id + '"' + (user && user.role_id === r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>'
      ).join('');
      const isEdit = !!user;
      const body =
        (isEdit ? '' :
          '<div class="admin-form-row"><label>用户名</label><input id="f-username" type="text" value="' + esc(user ? user.username : '') + '" ' + (isEdit ? 'disabled' : '') + ' /></div>') +
        (isEdit ? '' :
          '<div class="admin-form-row"><label>初始密码（至少6位）</label><input id="f-password" type="password" /></div>') +
        '<div class="admin-form-row"><label>显示名称</label><input id="f-display" type="text" value="' + esc(user ? (user.display_name || '') : '') + '" /></div>' +
        '<div class="admin-form-row"><label>角色</label><select id="f-role">' + roleOpts + '</select></div>' +
        '<div class="admin-form-row"><label>状态</label><select id="f-status">' +
          '<option value="1"' + (user && user.status === 1 ? ' selected' : '') + '>正常</option>' +
          '<option value="0"' + (user && user.status === 0 ? ' selected' : '') + '>禁用</option>' +
        '</select></div>';
      const overlay = openModal(isEdit ? '编辑用户 - ' + esc(user.username) : '新增用户', body,
        '<button class="admin-btn admin-btn-sm admin-btn-cancel" data-cancel="1">取消</button>' +
        '<button class="admin-btn admin-btn-sm" id="f-save">保存</button>');
      overlay.addEventListener('click', async (e) => {
        if (e.target.getAttribute && e.target.getAttribute('data-cancel')) { overlay.remove(); return; }
        if (e.target.id === 'f-save') {
          try {
            if (isEdit) {
              await api('/api/admin/users/' + user.id, {
                method: 'PUT',
                body: JSON.stringify({
                  display_name: document.getElementById('f-display').value.trim(),
                  role_id: parseInt(document.getElementById('f-role').value, 10),
                  status: parseInt(document.getElementById('f-status').value, 10)
                })
              });
            } else {
              await api('/api/admin/users', {
                method: 'POST',
                body: JSON.stringify({
                  username: document.getElementById('f-username').value.trim(),
                  password: document.getElementById('f-password').value,
                  display_name: document.getElementById('f-display').value.trim(),
                  role_id: parseInt(document.getElementById('f-role').value, 10),
                  status: parseInt(document.getElementById('f-status').value, 10)
                })
              });
            }
            overlay.remove();
            toast('保存成功', 'success');
            this.openCategory('user');
          } catch (err) { toast(err.message, 'error'); }
        }
      });
    },

    async openResetPwd(userId) {
      const overlay = openModal('重置密码',
        '<div class="admin-form-row"><label>新密码（至少6位）</label><input id="p-new" type="password" /></div>' +
        '<div class="admin-form-row"><label>确认新密码</label><input id="p-confirm" type="password" /></div>',
        '<button class="admin-btn admin-btn-sm admin-btn-cancel" data-cancel="1">取消</button>' +
        '<button class="admin-btn admin-btn-sm" id="p-save">确认重置</button>');
      overlay.addEventListener('click', async (e) => {
        if (e.target.getAttribute && e.target.getAttribute('data-cancel')) { overlay.remove(); return; }
        if (e.target.id === 'p-save') {
          const p1 = document.getElementById('p-new').value;
          const p2 = document.getElementById('p-confirm').value;
          if (p1 !== p2) { toast('两次输入的密码不一致', 'error'); return; }
          try {
            await api('/api/admin/users/' + userId + '/reset-password', {
              method: 'POST',
              body: JSON.stringify({ password: p1 })
            });
            overlay.remove();
            toast('密码已重置', 'success');
          } catch (err) { toast(err.message, 'error'); }
        }
      });
    },

    // ---------------- 角色管理 ----------------
    async renderRole() {
      const [rRes, pRes] = await Promise.all([api('/api/admin/roles'), api('/api/admin/permissions')]);
      const roles = rRes.data || [];
      const perms = pRes.data || [];
      const rows = roles.map(r =>
        '<tr>' +
        '<td>' + r.id + '</td>' +
        '<td>' + esc(r.name) + '</td>' +
        '<td><code>' + esc(r.code) + '</code></td>' +
        '<td>' + esc(r.description || '') + '</td>' +
        '<td>' + (r.user_count || 0) + '</td>' +
        '<td>' + (r.permissions ? r.permissions.length : 0) + '</td>' +
        '<td>' +
          '<button class="admin-btn admin-btn-sm" data-action="edit-role" data-id="' + r.id + '">编辑</button> ' +
          '<button class="admin-btn admin-btn-sm admin-btn-danger" data-action="del-role" data-id="' + r.id + '">删除</button>' +
        '</td></tr>'
      ).join('');
      const permRows = perms.map(p =>
        '<tr><td>' + p.id + '</td><td>' + esc(p.name) + '</td><td><code>' + esc(p.code) + '</code></td><td>' + esc(p.description || '') + '</td></tr>'
      ).join('');
      const html =
        '<div class="admin-toolbar">' +
          '<span class="admin-toolbar-gap"></span>' +
          '<button class="admin-btn" data-action="add-role">＋ 新增角色</button>' +
        '</div>' +
        '<table class="admin-table">' +
          '<thead><tr><th>ID</th><th>名称</th><th>编码</th><th>描述</th><th>用户数</th><th>权限数</th><th>操作</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="7" class="admin-empty">暂无角色</td></tr>') + '</tbody>' +
        '</table>' +
        '<details class="admin-role-perm" style="margin-top:18px;">' +
          '<summary class="admin-role-perm-head"><span>权限点清单 <span class="admin-badge-code">共 ' + perms.length + ' 项</span></span></summary>' +
          '<table class="admin-table">' +
            '<thead><tr><th>ID</th><th>模块</th><th>权限编码</th><th>说明</th></tr></thead>' +
            '<tbody>' + (permRows || '<tr><td colspan="4" class="admin-empty">暂无权限</td></tr>') + '</tbody>' +
          '</table>' +
        '</details>';
      setContent(html);
    },

    async openRoleForm(role) {
      const pRes = await api('/api/admin/permissions');
      const perms = pRes.data || [];
      const groups = {};
      perms.forEach(p => {
        if (!groups[p.name]) groups[p.name] = [];
        groups[p.name].push(p);
      });
      let permHtml = '';
      Object.keys(groups).forEach(g => {
        permHtml += '<div class="admin-perm-group-title">' + esc(g) + '</div><div class="admin-perm-grid">';
        groups[g].forEach(p => {
          permHtml += '<label><input type="checkbox" class="perm-cb" value="' + esc(p.code) + '"' + (role && role.permissions && role.permissions.indexOf(p.code) >= 0 ? ' checked' : '') + ' /> ' + esc(p.description) + '</label>';
        });
        permHtml += '</div>';
      });
      const isEdit = !!role;
      const body =
        '<div class="admin-form-row"><label>角色名称</label><input id="r-name" type="text" value="' + esc(role ? role.name : '') + '" /></div>' +
        '<div class="admin-form-row"><label>角色编码（英文，唯一）</label><input id="r-code" type="text" value="' + esc(role ? role.code : '') + '" ' + (isEdit ? 'disabled' : '') + ' /></div>' +
        '<div class="admin-form-row"><label>描述</label><textarea id="r-desc" rows="2">' + esc(role ? (role.description || '') : '') + '</textarea></div>' +
        '<div class="admin-form-row"><label>权限配置</label>' + permHtml + '</div>';
      const overlay = openModal(isEdit ? '编辑角色 - ' + esc(role.name) : '新增角色', body,
        '<button class="admin-btn admin-btn-sm admin-btn-cancel" data-cancel="1">取消</button>' +
        '<button class="admin-btn admin-btn-sm" id="r-save">保存</button>');
      overlay.addEventListener('click', async (e) => {
        if (e.target.getAttribute && e.target.getAttribute('data-cancel')) { overlay.remove(); return; }
        if (e.target.id === 'r-save') {
          const codes = Array.prototype.map.call(overlay.querySelectorAll('.perm-cb:checked'), c => c.value);
          try {
            if (isEdit) {
              await api('/api/admin/roles/' + role.id, {
                method: 'PUT',
                body: JSON.stringify({ name: document.getElementById('r-name').value.trim(), description: document.getElementById('r-desc').value.trim() })
              });
              await api('/api/admin/roles/' + role.id + '/permissions', {
                method: 'PUT',
                body: JSON.stringify({ permissions: codes })
              });
            } else {
              await api('/api/admin/roles', {
                method: 'POST',
                body: JSON.stringify({
                  name: document.getElementById('r-name').value.trim(),
                  code: document.getElementById('r-code').value.trim(),
                  description: document.getElementById('r-desc').value.trim(),
                  permissions: codes
                })
              });
            }
            overlay.remove();
            toast('保存成功', 'success');
            this.openCategory('role');
          } catch (err) { toast(err.message, 'error'); }
        }
      });
    },

    // ---------------- 系统日志 ----------------
    async renderLog() {
      const limit = this._logLimit || 100;
      const f = this._logFilter || {};
      let qs = 'limit=' + limit;
      if (f.user) qs += '&user=' + encodeURIComponent(f.user);
      if (f.action) qs += '&action=' + encodeURIComponent(f.action);
      if (f.keyword) qs += '&keyword=' + encodeURIComponent(f.keyword);
      const [lRes, stRes] = await Promise.all([
        api('/api/admin/logs?' + qs),
        api('/api/admin/logs/stats?days=7')
      ]);
      const logs = lRes.data || [];
      const stats = stRes.data || {};
      (this._chartInstances || []).forEach(ch => { try { ch.dispose(); } catch (e) { /* ignore */ } });
      this._chartInstances = [];
      const rows = logs.map(l =>
        '<tr><td>' + esc(l.created_at || '') + '</td><td>' + esc(l.username || '') + '</td><td>' + esc(l.action || '') + '</td><td>' + esc(l.detail || '') + '</td><td>' + esc(l.ip || '') + '</td></tr>'
      ).join('');
      const html =
        '<div class="admin-toolbar">' +
          '<span class="admin-toolbar-gap"></span>' +
          '<input class="admin-search" id="log-user" placeholder="用户" value="' + esc(f.user || '') + '" style="width:110px;" />' +
          '<input class="admin-search" id="log-action" placeholder="动作" value="' + esc(f.action || '') + '" style="width:110px;" />' +
          '<input class="admin-search" id="log-keyword" placeholder="关键词" value="' + esc(f.keyword || '') + '" style="width:130px;" />' +
          '<button class="admin-btn admin-btn-sm" id="log-query">查询</button>' +
          '<select class="admin-search" id="log-limit" style="width:90px;">' +
            '<option value="50"' + (limit === 50 ? ' selected' : '') + '>50条</option>' +
            '<option value="100"' + (limit === 100 ? ' selected' : '') + '>100条</option>' +
            '<option value="200"' + (limit === 200 ? ' selected' : '') + '>200条</option>' +
          '</select>' +
          '<button class="admin-btn admin-btn-sm admin-btn-ghost" id="log-charts-toggle">图表</button>' +
          '<button class="admin-btn admin-btn-sm admin-btn-ghost" id="log-export">导出 CSV</button>' +
          '<button class="admin-btn admin-btn-sm admin-btn-danger" data-action="clear-log">清空日志</button>' +
        '</div>' +
        '<div class="admin-charts" id="admin-charts"' + (this._logChartsOpen ? '' : ' style="display:none;"') + '>' +
          '<div class="admin-chart-box"><h4>近 7 天操作趋势</h4><div class="chart" id="chart-trend"></div></div>' +
          '<div class="admin-chart-box"><h4>操作类型分布</h4><div class="chart" id="chart-action"></div></div>' +
          '<div class="admin-chart-box"><h4>用户操作排行</h4><div class="chart" id="chart-user"></div></div>' +
        '</div>' +
        '<table class="admin-table">' +
          '<thead><tr><th>时间</th><th>用户</th><th>动作</th><th>详情</th><th>IP</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="5" class="admin-empty">暂无日志</td></tr>') + '</tbody>' +
        '</table>';
      setContent(html);
      this._logStats = stats;
      if (this._logChartsOpen) this.renderCharts(stats);
      const sel = document.getElementById('log-limit');
      if (sel) sel.addEventListener('change', () => { this._logLimit = parseInt(sel.value, 10); this.openCategory('log'); });
      const qbtn = document.getElementById('log-query');
      if (qbtn) qbtn.addEventListener('click', () => {
        this._logFilter = {
          user: document.getElementById('log-user').value.trim(),
          action: document.getElementById('log-action').value.trim(),
          keyword: document.getElementById('log-keyword').value.trim()
        };
        this.openCategory('log');
      });
      const chartToggle = document.getElementById('log-charts-toggle');
      if (chartToggle) chartToggle.addEventListener('click', () => {
        this._logChartsOpen = !this._logChartsOpen;
        const box = document.getElementById('admin-charts');
        if (box) box.style.display = this._logChartsOpen ? '' : 'none';
        if (this._logChartsOpen && !this._chartInstances.length) this.renderCharts(this._logStats || {});
      });
      const exportBtn = document.getElementById('log-export');
      if (exportBtn) exportBtn.addEventListener('click', () => {
        const csvRows = [['时间', '用户', '动作', '详情', 'IP']].concat(
          (logs || []).map(l => [l.created_at || '', l.username || '', l.action || '', l.detail || '', l.ip || ''])
        );
        const csv = '\ufeff' + csvRows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = '系统日志.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      });
    },

    renderCharts(stats) {
      if (!window.echarts) {
        const box = document.getElementById('chart-trend');
        if (box) box.innerHTML = '<div class="admin-empty">图表组件未加载</div>';
        return;
      }
      const trendEl = document.getElementById('chart-trend');
      const actionEl = document.getElementById('chart-action');
      const userEl = document.getElementById('chart-user');
      if (!trendEl || !actionEl || !userEl) return;
      // 后台内容区为深色主题：ECharts 默认深色文字在深底上看不清，统一注入浅色配置
      const DARK = {
        textStyle: { color: '#a9bad2' },
        tooltip: { backgroundColor: '#16233a', borderColor: '#3b82f6', textStyle: { color: '#e8f1ff' } },
        axisLine: { lineStyle: { color: '#3a4a66' } },
        axisLabel: { color: '#8fa3bd' },
        splitLine: { lineStyle: { color: '#243450' } }
      };
      const trend = echarts.init(trendEl);
      const action = echarts.init(actionEl);
      const user = echarts.init(userEl);
      this._chartInstances = [trend, action, user];
      const daily = stats.daily || [];
      trend.setOption({
        tooltip: { trigger: 'axis' },
        grid: { left: 40, right: 20, top: 30, bottom: 30 },
        textStyle: DARK.textStyle, tooltip: DARK.tooltip,
        xAxis: { type: 'category', data: daily.map(d => d.date), axisLabel: { fontSize: 11, color: DARK.axisLabel.color }, axisLine: DARK.axisLine },
        yAxis: { type: 'value', minInterval: 1, axisLabel: DARK.axisLabel, axisLine: DARK.axisLine, splitLine: DARK.splitLine },
        series: [{ name: '操作次数', type: 'line', smooth: true, data: daily.map(d => d.count), areaStyle: { opacity: 0.15 }, itemStyle: { color: '#3b82f6' } }]
      });
      const acts = stats.by_action || [];
      action.setOption({
        tooltip: { trigger: 'item' },
        textStyle: DARK.textStyle, tooltip: DARK.tooltip,
        legend: { bottom: 0, type: 'scroll', textStyle: { color: '#a9bad2' } },
        series: [{ name: '操作类型', type: 'pie', radius: ['38%', '62%'], data: acts.map(a => ({ name: a.action, value: a.count })), label: { fontSize: 11 } }]
      });
      const users = stats.by_user || [];
      user.setOption({
        tooltip: { trigger: 'axis' },
        grid: { left: 70, right: 20, top: 20, bottom: 30 },
        textStyle: DARK.textStyle, tooltip: DARK.tooltip,
        xAxis: { type: 'value', minInterval: 1, axisLabel: DARK.axisLabel, axisLine: DARK.axisLine, splitLine: DARK.splitLine },
        yAxis: { type: 'category', data: users.map(u => u.username).reverse(), axisLabel: { fontSize: 11, color: DARK.axisLabel.color }, axisLine: DARK.axisLine },
        series: [{ name: '操作次数', type: 'bar', data: users.map(u => u.count).reverse(), itemStyle: { color: '#34d399' } }]
      });
    },

    // 2026-11-28：知识库已并入「大模型管理」（renderLlm），此处不再单独成页。
    async renderKb() {
      return this.renderLlm();
    },

    // ---------------- 大模型管理（模型配置 + 系统提示词 + RAG 知识库） ----------------
    // 2026-11-28 合并：原独立的「知识库管理」「设置」两页并到这里。
    // 账号信息与修改密码在右上角头像菜单；高德 Key 与配置备份移到「系统状态」。
    async renderLlm() {
      let roleCode = '';
      try {
        const meRes = await api('/api/auth/me');
        roleCode = (meRes && meRes.role_code) || '';
      } catch (e) { /* ignore */ }
      const canEdit = roleCode !== 'viewer';

      let cfg = {};
      let kb = {};
      const [cfgRes, kbRes] = await Promise.all([
        api('/api/admin/agent-config').catch(function (e) {
          toast('大模型配置读取失败：' + (e && e.message ? e.message : '接口不可用'), 'error');
          return {};
        }),
        api('/api/admin/kb-status').catch(function (e) {
          toast('知识库状态读取失败：' + (e && e.message ? e.message : '接口不可用'), 'error');
          return {};
        })
      ]);
      cfg = (cfgRes && cfgRes.data) || {};
      kb = (kbRes && kbRes.data) || {};

      const model = cfg.model || '—';
      const hasApiStatus = Object.prototype.hasOwnProperty.call(cfg, 'api_configured');
      const apiReady = !!cfg.api_configured;
      const isDefault = cfg.is_default !== false;
      const prompt = cfg.system_prompt || '';
      const updatedAt = cfg.updated_at || '—';

      // 知识库（RAG 检索源，原「知识库管理」页）
      const kbCounts = kb.counts || {};
      const kbSources = kb.sources || [];
      const KB_LABELS = [
        ['kb_disaster_cases', '灾害事件案例'],
        ['kb_stations', '气象站点'],
        ['kb_counties', '县域社会经济'],
        ['kb_infra', '基础设施'],
        ['kb_geo_overview', '冰冻圈地理概览'],
        ['kb_era5_stats', 'ERA5 气象索引'],
        ['kb_methods', '风险评估方法学']
      ];
      const kbStatCards = KB_LABELS.map(function (p) {
        return '<div class="admin-stat"><div class="v">' +
          (kbCounts[p[0]] != null ? kbCounts[p[0]] : '—') + '</div><div class="k">' + p[1] + '</div></div>';
      }).join('');
      const kbRows = kbSources.map(function (s) {
        return '<tr>' +
          '<td>' + esc(s.name) + '</td>' +
          '<td>' + esc(s.description) + '</td>' +
          '<td>' + (s.size_bytes ? fmtSize(s.size_bytes) : '—') + '</td>' +
          '<td>' + esc(s.updated_at || '—') + '</td>' +
          '<td>' + (s.exists ? '<span class="badge badge-ok">就绪</span>' : '<span class="badge badge-off">缺失</span>') + '</td>' +
        '</tr>';
      }).join('');

      const html =
        '<div class="setting-intro">' +
          '<div class="setting-intro-icon"><i class="fa fa-comments"></i></div>' +
          '<div class="setting-intro-text">' +
            '<div class="setting-intro-title">冰冻圈灾害大模型</div>' +
            '<div class="setting-intro-desc">用于灾害机理解读、风险分级说明与应急对策问答。这里统一管理它的底层密钥、角色提示词与检索用知识库。</div>' +
          '</div>' +
        '</div>' +
        '<div class="admin-stat-section">' +
          '<div class="admin-stat-section-title">运行状态</div>' +
          '<div class="admin-stats">' +
            '<div class="admin-stat"><div class="v" style="font-size:15px;">' + esc(model) + '</div><div class="k">底层模型</div></div>' +
            '<div class="admin-stat"><div class="v">' + (!hasApiStatus ? '<span class="badge badge-gray">未知</span>' : (apiReady ? '<span class="badge badge-ok">已配置</span>' : '<span class="badge badge-off">未配置</span>')) + '</div><div class="k">DeepSeek 接口密钥</div></div>' +
            '<div class="admin-stat"><div class="v" id="setting-prompt-source">' + (isDefault ? '内置默认' : '自定义') + '</div><div class="k">提示词来源</div></div>' +
            '<div class="admin-stat"><div class="v" id="setting-updated-at">' + esc(updatedAt) + '</div><div class="k">最近修改</div></div>' +
          '</div>' +
          (hasApiStatus && !apiReady
            ? '<div class="setting-warning"><i class="fa fa-exclamation-triangle"></i> 后端尚未配置 DeepSeek API 密钥，模型对话暂不可用；提示词仍可编辑。</div>'
            : '') +
        '</div>' +
        // 知识库排在系统提示词之前（2026-11-28 用户定序）：先看数据、再改角色设定
        '<div class="admin-stat-section">' +
          '<div class="admin-toolbar">' +
            '<div class="admin-stat-section-title" style="margin:0;">知识库 · 检索源</div>' +
            '<span class="admin-toolbar-gap"></span>' +
            (canEdit ? '<button class="admin-btn" id="kb-rebuild"><i class="fa fa-refresh"></i> 重建知识库</button>' : '<span class="setting-prompt-hint">当前角色只读</span>') +
          '</div>' +
          '<div class="setting-prompt-wrap">' +
            (kb.built
              ? '<div class="admin-stats" style="margin-top:12px;">' + kbStatCards + '</div>' +
                '<table class="admin-table" style="margin-top:12px;">' +
                  '<thead><tr><th>数据源</th><th>说明</th><th>大小</th><th>构建时间</th><th>状态</th></tr></thead>' +
                  '<tbody>' + (kbRows || '<tr><td colspan="5" class="admin-empty">暂无数据源</td></tr>') + '</tbody>' +
                '</table>' +
                '<div class="setting-footnote">重建会重新读取项目目录中的 GeoJSON / CSV / SQLite 索引，使知识库与数据现状一致；过程中请勿关闭页面。</div>'
              : '<div class="admin-empty" style="margin-top:12px;">知识库尚未构建，点击右上角「重建知识库」生成。</div>') +
          '</div>' +
        '</div>' +
        '<div class="admin-stat-section">' +
          '<div class="admin-stat-section-title">系统提示词</div>' +
          '<div class="setting-prompt-wrap">' +
            '<div class="admin-form-row">' +
              '<label>角色设定与输出边界 <span class="setting-prompt-meta" id="setting-prompt-count">' + prompt.length + ' 字</span></label>' +
              '<textarea id="agent-prompt" class="setting-prompt" rows="14"' + (canEdit ? '' : ' readonly') + '>' + esc(prompt) + '</textarea>' +
            '</div>' +
            (canEdit
              ? '<div class="setting-prompt-actions">' +
                  '<button class="admin-btn" id="agent-save">保存</button>' +
                  '<button class="admin-btn admin-btn-cancel" id="agent-reset">恢复默认</button>' +
                '</div>'
              : '<div class="setting-prompt-actions"><span class="setting-prompt-hint">当前角色只读，无法修改配置</span></div>') +
          '</div>' +
        '</div>';
      setContent(html);

      const ta = document.getElementById('agent-prompt');
      const counter = document.getElementById('setting-prompt-count');
      if (ta && counter) ta.addEventListener('input', function () { counter.textContent = ta.value.length + ' 字'; });

      const saveBtn = document.getElementById('agent-save');
      if (saveBtn) saveBtn.addEventListener('click', async () => {
        const val = (ta ? ta.value : '').trim();
        if (!val) { toast('系统提示词不能为空', 'error'); return; }
        saveBtn.disabled = true;
        const btnText = saveBtn.textContent;
        saveBtn.textContent = '保存中…';
        try {
          await api('/api/admin/agent-config', { method: 'PUT', body: JSON.stringify({ system_prompt: val }) });
          toast('已保存，立即生效', 'success');
          const src = document.getElementById('setting-prompt-source');
          if (src) src.textContent = '自定义';
          const at = document.getElementById('setting-updated-at');
          if (at) at.textContent = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
        } catch (err) { toast(err.message, 'error'); }
        finally {
          saveBtn.disabled = false;
          saveBtn.textContent = btnText;
        }
      });
      const resetBtn = document.getElementById('agent-reset');
      if (resetBtn) resetBtn.addEventListener('click', async () => {
        let ok = false;
        if (window.UI && window.UI.confirm) ok = await UI.confirm({ title: '恢复默认', message: '确定恢复为内置默认提示词吗？', danger: true });
        else ok = window.confirm('确定恢复为内置默认提示词吗？');
        if (!ok) return;
        try {
          await api('/api/admin/agent-config', { method: 'DELETE' });
          toast('已恢复默认', 'success');
          this.openCategory('llm');
        } catch (err) { toast(err.message, 'error'); }
      });

      // 知识库重建（原「知识库管理」页的操作，合并到这里）
      const kbBtn = document.getElementById('kb-rebuild');
      if (kbBtn) kbBtn.addEventListener('click', async () => {
        let ok = false;
        if (window.UI && window.UI.confirm) {
          ok = await UI.confirm({ title: '重建知识库', message: '将从项目真实数据重建全部知识库表，过程中请勿关闭页面。确定继续吗？', danger: true });
        } else {
          ok = window.confirm('确定重建知识库吗？');
        }
        if (!ok) return;
        kbBtn.disabled = true;
        const old = kbBtn.innerHTML;
        kbBtn.textContent = '重建中…';
        try {
          await api('/api/admin/kb-rebuild', { method: 'POST' });
          toast('知识库已重建', 'success');
          this.openCategory('llm');
        } catch (err) {
          toast(err.message, 'error');
          kbBtn.disabled = false;
          kbBtn.innerHTML = old;
        }
      });
    },

    // ---------------- 系统状态 ----------------
    statSection(title, items) {
      const cards = items.map(function (it) {
        return '<div class="admin-stat"><div class="v">' + it.v + '</div><div class="k">' + esc(it.k) + '</div></div>';
      }).join('');
      return '<div class="admin-stat-section"><div class="admin-stat-section-title">' + esc(title) + '</div><div class="admin-stats">' + cards + '</div></div>';
    },

    async renderStatus() {
      // 数据相关指标已收归「数据管理」页；这里只呈现系统运行指标，
      // 不再触发 /api/admin/data-tree 的几十 GB 递归统计。
      // 2026-11-28：原「设置」页里的外部服务（高德 Key）与配置备份移到这里（运维视角）。
      const [stRes, sysRes, cfgRes, meRes] = await Promise.all([
        api('/api/admin/stats'),
        api('/api/system/status'),
        api('/api/admin/agent-config').catch(function () { return {}; }),
        api('/api/auth/me').catch(function () { return {}; })
      ]);
      const s = stRes.data || {};
      const sys = sysRes || {};
      const cfg = (cfgRes && cfgRes.data) || {};
      const canEdit = ((meRes && meRes.role_code) || '') !== 'viewer';
      const hasAmapStatus = Object.prototype.hasOwnProperty.call(cfg, 'amap_configured');
      const amapReady = !!cfg.amap_configured;
      const hasApiStatus = Object.prototype.hasOwnProperty.call(cfg, 'api_configured');
      const apiReady = !!cfg.api_configured;
      const llmModel = cfg.model || '—';
      const ok = '<span style="color:#4ade80;font-weight:600;">正常</span>';
      const bad = '<span style="color:#f87171;font-weight:600;">异常</span>';
      const html =
        '<div class="admin-toolbar">' +
          '<span class="admin-toolbar-gap"></span>' +
          '<button class="admin-btn admin-btn-sm admin-btn-ghost" id="status-clear-cache"><i class="fa fa-refresh"></i> 清除缓存</button>' +
        '</div>' +
        this.statSection('运行概况', [
          { v: esc(sys.system || '—'), k: '系统名称' },
          { v: esc(sys.version || '—'), k: '系统版本' },
          { v: sys.status === 'ok' ? ok : bad, k: '运行状态' },
          { v: esc(sys.uptime_text || '—'), k: '运行时长' },
          { v: esc(sys.server_time || '—'), k: '服务器时间' }
        ]) +
        this.statSection('平台账户', [
          { v: s.users != null ? s.users : '—', k: '用户总数' },
          { v: s.active_users != null ? s.active_users : '—', k: '启用用户' },
          { v: s.roles != null ? s.roles : '—', k: '角色数' },
          { v: s.permissions != null ? s.permissions : '—', k: '权限点' }
        ]) +
        this.statSection('运行环境', [
          { v: esc(sys.python || '—'), k: 'Python' },
          { v: esc(sys.flask_version || '—'), k: 'Flask' },
          { v: esc(sys.torch_version || '—'), k: 'PyTorch' },
          { v: esc(sys.platform || '—'), k: '操作系统' },
          { v: sys.debug ? '调试模式' : '生产模式', k: '运行模式' }
        ]) +
        this.statSection('服务健康', [
          { v: sys.db_exists ? ok : bad,  k: '数据库' },
          { v: s.logs_today != null ? s.logs_today : '—', k: '今日日志' },
          { v: sys.online_users != null ? sys.online_users : '—', k: '近24h活跃用户' },
          { v: sys.storage_usage_mb == null ? '<span style="color:#8496b0;">统计中…</span>' : fmtSize(sys.storage_usage_mb * 1024 * 1024), k: '后端程序目录占用' }
        ]) +
        // 外部服务：两个后端外部依赖（高德 Key / DeepSeek 接口），只读状态
        '<div class="admin-stat-section">' +
          '<div class="admin-stat-section-title">外部服务</div>' +
          '<div class="admin-stats" style="grid-template-columns:repeat(auto-fill,minmax(200px,240px));">' +
            '<div class="admin-stat"><div class="v">' +
              (!hasAmapStatus ? '<span class="badge badge-gray">未知</span>' : (amapReady ? '<span class="badge badge-ok">已配置</span>' : '<span class="badge badge-off">未配置</span>')) +
            '</div><div class="k">高德地图 Key</div></div>' +
            '<div class="admin-stat"><div class="v">' +
              (!hasApiStatus ? '<span class="badge badge-gray">未知</span>' : (apiReady ? '<span class="badge badge-ok">已配置</span>' : '<span class="badge badge-off">未配置</span>')) +
            '</div><div class="k">DeepSeek 接口 · ' + esc(llmModel) + '</div></div>' +
          '</div>' +
          (hasAmapStatus && !amapReady
            ? '<div class="setting-warning"><i class="fa fa-exclamation-triangle"></i> 后端尚未配置高德地图 Key，地名搜索将不可用。</div>'
            : '') +
          (hasApiStatus && !apiReady
            ? '<div class="setting-warning"><i class="fa fa-exclamation-triangle"></i> 后端尚未配置 DeepSeek API 密钥，大模型问答暂不可用。</div>'
            : '') +
        '</div>' +
        // 配置维护：admin.db 备份 / 恢复
        '<div class="admin-stat-section">' +
          '<div class="admin-stat-section-title">配置维护</div>' +
          '<div class="setting-prompt-wrap">' +
            '<div class="setting-prompt-actions">' +
              (canEdit
                ? '<a class="admin-btn" style="text-decoration:none;display:inline-block;" href="/api/admin/config-backup" download><i class="fa fa-download"></i> 下载备份</a>' +
                  '<input type="file" id="config-restore-file" accept=".db" style="padding:6px;margin-left:6px;" />' +
                  '<button class="admin-btn admin-btn-danger" id="config-restore-btn">恢复配置</button>'
                : '<span class="setting-prompt-hint">当前角色只读</span>') +
            '</div>' +
          '</div>' +
        '</div>';
      setContent(html);

      const clearBtn = document.getElementById('status-clear-cache');
      if (clearBtn) clearBtn.addEventListener('click', async () => {
        clearBtn.disabled = true;
        const old = clearBtn.innerHTML;
        clearBtn.textContent = '清除中…';
        try {
          const res = await api('/api/admin/cache-clear', { method: 'POST' });
          const list = ((res && res.data && res.data.cleared) || []).join('、');
          toast('已清除：' + list, 'success');
        } catch (err) { toast(err.message, 'error'); }
        finally { clearBtn.disabled = false; clearBtn.innerHTML = old; }
      });

      const restoreBtn = document.getElementById('config-restore-btn');
      if (restoreBtn) restoreBtn.addEventListener('click', async () => {
        const input = document.getElementById('config-restore-file');
        const file = input && input.files && input.files[0];
        if (!file) { toast('请先选择备份文件', 'error'); return; }
        let okRestore = false;
        if (window.UI && window.UI.confirm) {
          okRestore = await UI.confirm({ title: '恢复配置', message: '将用上传的备份覆盖当前配置（当前配置会自动留一份 .bak）。确定继续吗？', danger: true });
        } else {
          okRestore = window.confirm('确定恢复配置吗？');
        }
        if (!okRestore) return;
        const fd = new FormData();
        fd.append('file', file);
        restoreBtn.disabled = true;
        const oldText = restoreBtn.textContent;
        restoreBtn.textContent = '恢复中…';
        try {
          const resp = await fetch('/api/admin/config-restore', { method: 'POST', body: fd });
          const data = await resp.json();
          if (!resp.ok) throw new Error((data && data.message) || '恢复失败');
          toast('配置已恢复，请重新登录', 'success');
          setTimeout(() => { window.location.reload(); }, 1200);
        } catch (err) {
          toast(err.message, 'error');
          restoreBtn.disabled = false;
          restoreBtn.textContent = oldText;
        }
      });
    },

    // ---------------- 数据管理（真实 data/ 目录浏览器） ----------------
    async renderData() {
      const self = this;
      const path = this._dataPath || '';

      if (!path) {
        // 第一屏：数据资产中心。按业务语义分组，量级按项目目录核对，
        // 不递归统计（GLDAS 5 万文件 + ERA5 67GB 会让首屏卡十几秒）。
        let data;
        try { data = await api('/api/admin/data-assets'); } catch (e) { data = { data: { groups: [] } }; }
        const groups = (data.data && data.data.groups) || [];
        const total = (data.data && data.data.total) || 0;
        const present = (data.data && data.data.present) || 0;

        let groupsHTML = '';
        groups.forEach(function (g) {
          const cards = (g.items || []).map(function (it) {
            const missing = !it.exists;
            return '<div class="asset-card tone-' + esc(it.tone || 'blue') + (missing ? ' is-missing' : '') + '"' +
              ' data-path="' + esc(it.path) + '"' + (missing ? ' title="目录不存在"' : '') + '>' +
              '<div class="asset-card-top">' +
                '<span class="asset-icon"><i class="fa ' + esc(it.icon || 'fa-folder') + '"></i></span>' +
                '<span class="asset-name">' + esc(it.name) + '</span>' +
                (missing ? '<span class="asset-status">缺失</span>' : '') +
              '</div>' +
              '<div class="asset-scale">' + esc(it.scale || '') + '</div>' +
              '<div class="asset-usage">' + esc(it.usage || '') + '</div>' +
              '<div class="asset-enter">查看文件 <i class="fa fa-angle-right"></i></div>' +
            '</div>';
          }).join('');
          groupsHTML +=
            '<section class="asset-group">' +
              '<div class="asset-group-head">' +
                '<div class="asset-group-title"><i class="fa ' + esc(g.icon || 'fa-folder') + '"></i> ' + esc(g.name) + '</div>' +
                '<div class="asset-group-desc">' + esc(g.desc || '') + '</div>' +
              '</div>' +
              '<div class="asset-grid">' + cards + '</div>' +
            '</section>';
        });

        const html =
          '<div class="asset-overview">' +
            '<div class="asset-overview-num">' + present + ' <span>/ ' + total + '</span></div>' +
            '<div class="asset-overview-label">数据资产已就绪</div>' +
            '<div class="asset-overview-note">按业务语义分组 · 规模按项目目录核对，点开卡片查看实际文件</div>' +
          '</div>' +
          (groupsHTML || '<div class="admin-empty">未能加载数据资产目录</div>');
        setContent(html);

        document.querySelectorAll('#admin-content .asset-card:not(.is-missing)').forEach(function (card) {
          card.addEventListener('click', function () {
            self._dataPath = card.getAttribute('data-path');
            self._dataLabel = card.querySelector('.asset-name').textContent;
            self._dataPage = 1;
            self.openCategory('data');
          });
        });
        return;
      }

      // 二级：列出当前目录文件（分页）
      const page = this._dataPage || 1;
      let info = {};
      try { info = (await api('/api/admin/data-files?path=' + encodeURIComponent(path) + '&page=' + page)).data || {}; } catch (e) { info = {}; }
      const files = info.files || [];
      const rows = files.map(function (f) {
        return '<tr>' +
          '<td>' + (f.is_dir
            ? '<a class="data-dir-link" data-subdir="' + esc(f.name) + '"><i class="fa fa-folder" style="color:#fbbf24;"></i> ' + esc(f.name) + '</a>'
            : esc(f.name)) + '</td>' +
          '<td>' + esc(f.size_text || '') + '</td>' +
          '<td>' + esc(f.mtime) + '</td>' +
          '<td>' + (f.is_dir ? '<span style="color:#7d90ac;">—</span>' : '<button class="admin-btn admin-btn-sm admin-btn-danger" data-action="del-data" data-file="' + esc(f.name) + '">删除</button>') + '</td>' +
        '</tr>';
      }).join('');
      const totalPages = info.total_pages || 1;
      const html =
        '<div class="admin-toolbar">' +
          '<button class="admin-btn admin-btn-sm admin-btn-ghost" id="data-back"><i class="fa fa-angle-left"></i> 数据资产</button>' +
          '<span class="data-crumb">' + esc(this._dataLabel || path) + '</span>' +
          '<span class="admin-toolbar-gap"></span>' +
          '<span class="admin-path">' + esc(info.directory || '') + '</span>' +
        '</div>' +
        '<div class="admin-form-row" style="max-width:760px;">' +
          '<label>上传文件到当前目录：</label>' +
          '<input type="file" id="data-file-input" style="padding:6px;" /> ' +
          '<button class="admin-btn" id="data-upload-btn">上传</button>' +
        '</div>' +
        '<table class="admin-table">' +
          '<thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th>操作</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="4" class="admin-empty">该目录暂无文件</td></tr>') + '</tbody>' +
        '</table>' +
        '<div class="admin-pager">' +
          '<button id="data-prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
          '<span>第 ' + (info.page || 1) + ' / ' + totalPages + ' 页（共 ' + (info.total || 0) + ' 项）</span>' +
          '<button id="data-next"' + (page >= totalPages ? ' disabled' : '') + '>下一页</button>' +
        '</div>';
      setContent(html);

      const back = document.getElementById('data-back');
      if (back) back.addEventListener('click', function () { self._dataPath = ''; self._dataLabel = ''; self._dataPage = 1; self.openCategory('data'); });

      // 子目录可继续下钻（如 raw/TibetanPlateau 下按气象变量分目录）
      document.querySelectorAll('#admin-content [data-subdir]').forEach(function (link) {
        link.addEventListener('click', function () {
          const sub = link.getAttribute('data-subdir');
          self._dataPath = (path.replace(/\/$/, '') + '/' + sub).replace(/^\//, '');
          self._dataLabel = sub;
          self._dataPage = 1;
          self.openCategory('data');
        });
      });

      const upBtn = document.getElementById('data-upload-btn');
      if (upBtn) {
        upBtn.addEventListener('click', async function () {
          const input = document.getElementById('data-file-input');
          if (!input || !input.files.length) { toast('请先选择文件', 'warning'); return; }
          const fd = new FormData();
          fd.append('path', path);
          fd.append('file', input.files[0]);
          upBtn.disabled = true;
          try {
            const resp = await fetch('/api/admin/data-files/upload', { method: 'POST', body: fd });
            const d = await resp.json().catch(function () { return {}; });
            if (!resp.ok) throw new Error(d.message || '上传失败(' + resp.status + ')');
            toast(d.message || '上传成功', 'success');
            self.openCategory('data');
          } catch (e) { toast(e.message, 'error'); }
          finally { upBtn.disabled = false; }
        });
      }
      document.querySelectorAll('#admin-content [data-action="del-data"]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          const fn = btn.getAttribute('data-file');
          let ok = false;
          if (window.UI && window.UI.confirm) {
            ok = await UI.confirm({ title: '删除文件', message: '确认删除 ' + fn + ' ？', danger: true });
          } else {
            ok = window.confirm('确认删除 ' + fn + ' ？');
          }
          if (!ok) return;
          try {
            await api('/api/admin/data-files?path=' + encodeURIComponent(path) + '&filename=' + encodeURIComponent(fn), { method: 'DELETE' });
            toast('已删除', 'success');
            self.openCategory('data');
          } catch (e) { toast(e.message, 'error'); }
        });
      });
      const prev = document.getElementById('data-prev');
      const next = document.getElementById('data-next');
      if (prev) prev.addEventListener('click', function () { if (self._dataPage > 1) { self._dataPage--; self.openCategory('data'); } });
      if (next) next.addEventListener('click', function () { if (self._dataPage < totalPages) { self._dataPage++; self.openCategory('data'); } });
    },


    // ---------------- 事件委托（列表操作按钮） ----------------
    bindListActions() {
      // 在 setContent 后由各 render 显式调用，或统一在 content 上委托
    }
  };

  // 统一事件委托：处理 data-action 按钮
  document.addEventListener('click', function (e) {
    const btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    const batchMenu = btn.closest('.admin-batch');
    if (batchMenu) batchMenu.open = false;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');

    if (action === 'add-user') {
      AdminPanel.openUserForm(null);
    } else if (action === 'edit-user') {
      (async () => {
        const uRes = await api('/api/admin/users?all=1');
        const user = (uRes.data || []).find(u => String(u.id) === String(id));
        if (user) AdminPanel.openUserForm(user); else toast('用户不存在', 'error');
      })().catch(e => toast(e.message, 'error'));
    } else if (action === 'reset-pwd') {
      AdminPanel.openResetPwd(id);
    } else if (action === 'del-user') {
      if (window.UI && window.UI.confirm) {
        window.UI.confirm({ title: '确认删除', message: '确定要删除该用户吗？此操作不可恢复。' }).then(ok => {
          if (!ok) return;
          api('/api/admin/users/' + id, { method: 'DELETE' })
            .then(() => { toast('已删除', 'success'); AdminPanel.openCategory('user'); })
            .catch(err => toast(err.message, 'error'));
        });
      } else {
        if (!window.confirm('确定要删除该用户吗？')) return;
        api('/api/admin/users/' + id, { method: 'DELETE' })
          .then(() => { toast('已删除', 'success'); AdminPanel.openCategory('user'); })
          .catch(err => toast(err.message, 'error'));
      }
    } else if (action === 'add-role') {
      AdminPanel.openRoleForm(null);
    } else if (action === 'edit-role') {
      (async () => {
        const rRes = await api('/api/admin/roles');
        const role = (rRes.data || []).find(r => String(r.id) === String(id));
        if (role) AdminPanel.openRoleForm(role); else toast('角色不存在', 'error');
      })().catch(e => toast(e.message, 'error'));
    } else if (action === 'del-role') {
      if (window.UI && window.UI.confirm) {
        window.UI.confirm({ title: '确认删除', message: '确定要删除该角色吗？' }).then(ok => {
          if (!ok) return;
          api('/api/admin/roles/' + id, { method: 'DELETE' })
            .then(() => { toast('已删除', 'success'); AdminPanel.openCategory('role'); })
            .catch(err => toast(err.message, 'error'));
        });
      } else {
        if (!window.confirm('确定要删除该角色吗？')) return;
        api('/api/admin/roles/' + id, { method: 'DELETE' })
          .then(() => { toast('已删除', 'success'); AdminPanel.openCategory('role'); })
          .catch(err => toast(err.message, 'error'));
      }
    } else if (action === 'page-prev' || action === 'page-next') {
      const pg = parseInt(btn.getAttribute('data-page'), 10);
      if (pg >= 1) { AdminPanel._userPage = pg; AdminPanel.openCategory('user'); }
    } else if (action === 'batch-delete') {
      const ids = Object.keys(AdminPanel._userSelected || {});
      if (!ids.length) { toast('请先勾选用户', 'warning'); return; }
      const doDel = function () {
        api('/api/admin/users/batch-delete', { method: 'POST', body: JSON.stringify({ ids: ids.map(Number) }) })
          .then(function () { toast('批量删除成功', 'success'); AdminPanel._userSelected = {}; AdminPanel.openCategory('user'); })
          .catch(function (err) { toast(err.message, 'error'); });
      };
      if (window.UI && window.UI.confirm) {
        window.UI.confirm({ title: '批量删除', message: '确定删除选中的 ' + ids.length + ' 个用户吗？' }).then(function (ok) { if (ok) doDel(); });
      } else if (window.confirm('确定删除选中的 ' + ids.length + ' 个用户吗？')) { doDel(); }
    } else if (action === 'batch-enable' || action === 'batch-disable') {
      const bid = Object.keys(AdminPanel._userSelected || {});
      if (!bid.length) { toast('请先勾选用户', 'warning'); return; }
      const bst = action === 'batch-enable' ? 1 : 0;
      api('/api/admin/users/batch-status', { method: 'POST', body: JSON.stringify({ ids: bid.map(Number), status: bst }) })
        .then(function () { toast(action === 'batch-enable' ? '已批量启用' : '已批量禁用', 'success'); AdminPanel._userSelected = {}; AdminPanel.openCategory('user'); })
        .catch(function (err) { toast(err.message, 'error'); });
    } else if (action === 'clear-log') {
      if (window.UI && window.UI.confirm) {
        window.UI.confirm({ title: '清空日志', message: '确定要清空全部系统日志吗？' }).then(ok => {
          if (!ok) return;
          api('/api/admin/logs', { method: 'DELETE' })
            .then(() => { toast('日志已清空', 'success'); AdminPanel.openCategory('log'); })
            .catch(err => toast(err.message, 'error'));
        });
      } else {
        if (!window.confirm('确定要清空全部系统日志吗？')) return;
        api('/api/admin/logs', { method: 'DELETE' })
          .then(() => { toast('日志已清空', 'success'); AdminPanel.openCategory('log'); })
          .catch(err => toast(err.message, 'error'));
      }
    }
  });

  // 页面加载完成初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AdminPanel.init());
  } else {
    AdminPanel.init();
  }
})();