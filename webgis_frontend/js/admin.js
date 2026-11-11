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
      window.location.href = 'login.html?return_url=admin.html';
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
    currentCat: 'user',

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
        badge.textContent = (me.display_name || me.user) + (me.role_code ? ' · ' + (me.role_code === 'admin' ? '系统管理员' : me.role_code) : '');
      }
      this.bindHeader();
      // 打开面板：URL 指定分类则打开该分类，否则默认用户管理
      const cat = new URLSearchParams(window.location.search).get('cat');
      this.openCategory(cat || 'user');
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
      const valid = ['user', 'role', 'permission', 'log', 'data', 'agent', 'setting', 'status'];
      if (valid.indexOf(cat) < 0) cat = 'user';
      this.currentCat = cat;
      overlayEl().style.display = 'flex';
      document.querySelectorAll('.admin-nav-item').forEach(n => {
        n.classList.toggle('active', n.getAttribute('data-cat') === cat);
      });
      // 同步顶栏「系统管理」下拉的选中态：左栏与下拉是同一套分类，
      // 只亮左栏会让"从下拉进来的当前页"在导航里看不出来。
      document.querySelectorAll('#admin-dropdown .dropdown-item').forEach(i => {
        i.classList.toggle('active', i.dataset.category === cat);
      });
      setContent('<div class="admin-empty">加载中…</div>');
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
          '<h3>用户管理</h3>' +
          '<input class="admin-search" id="user-search" placeholder="搜索用户名/显示名（回车查询）" value="' + esc(keyword) + '" />' +
          '<button class="admin-btn" data-action="add-user">＋ 新增用户</button>' +
          '<button class="admin-btn admin-btn-sm admin-btn-green" data-action="batch-enable">批量启用</button>' +
          '<button class="admin-btn admin-btn-sm" data-action="batch-disable">批量禁用</button>' +
          '<button class="admin-btn admin-btn-sm admin-btn-danger" data-action="batch-delete">批量删除</button>' +
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
        '<button class="admin-btn admin-btn-sm" style="background:#eef1f5;color:#33475b;" data-cancel="1">取消</button>' +
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
        '<button class="admin-btn admin-btn-sm" style="background:#eef1f5;color:#33475b;" data-cancel="1">取消</button>' +
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
      const rRes = await api('/api/admin/roles');
      const roles = rRes.data || [];
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
          '<button class="admin-btn admin-btn-sm" data-action="perm-role" data-id="' + r.id + '">权限配置</button> ' +
          '<button class="admin-btn admin-btn-sm admin-btn-danger" data-action="del-role" data-id="' + r.id + '">删除</button>' +
        '</td></tr>'
      ).join('');
      const html =
        '<div class="admin-toolbar">' +
          '<h3>角色管理</h3>' +
          '<button class="admin-btn" data-action="add-role">＋ 新增角色</button>' +
        '</div>' +
        '<table class="admin-table">' +
          '<thead><tr><th>ID</th><th>名称</th><th>编码</th><th>描述</th><th>用户数</th><th>权限数</th><th>操作</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="7" class="admin-empty">暂无角色</td></tr>') + '</tbody>' +
        '</table>';
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

    // ---------------- 权限管理 ----------------
    async renderPermission() {
      const pRes = await api('/api/admin/permissions');
      const perms = pRes.data || [];
      const rows = perms.map(p =>
        '<tr><td>' + p.id + '</td><td>' + esc(p.name) + '</td><td><code>' + esc(p.code) + '</code></td><td>' + esc(p.description || '') + '</td></tr>'
      ).join('');
      const html =
        '<div class="admin-toolbar"><h3>权限管理</h3><span style="color:#8a99a8;font-size:12px;">权限点由系统定义，通过在角色管理中勾选分配给角色</span></div>' +
        '<table class="admin-table">' +
          '<thead><tr><th>ID</th><th>模块</th><th>权限编码</th><th>说明</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="4" class="admin-empty">暂无权限</td></tr>') + '</tbody>' +
        '</table>';
      setContent(html);
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
          '<h3>系统日志</h3>' +
          '<input class="admin-search" id="log-user" placeholder="用户" value="' + esc(f.user || '') + '" style="width:110px;" />' +
          '<input class="admin-search" id="log-action" placeholder="动作" value="' + esc(f.action || '') + '" style="width:110px;" />' +
          '<input class="admin-search" id="log-keyword" placeholder="关键词" value="' + esc(f.keyword || '') + '" style="width:130px;" />' +
          '<button class="admin-btn admin-btn-sm" id="log-query">查询</button>' +
          '<select class="admin-search" id="log-limit" style="width:90px;">' +
            '<option value="50"' + (limit === 50 ? ' selected' : '') + '>50条</option>' +
            '<option value="100"' + (limit === 100 ? ' selected' : '') + '>100条</option>' +
            '<option value="200"' + (limit === 200 ? ' selected' : '') + '>200条</option>' +
          '</select>' +
          '<button class="admin-btn admin-btn-sm admin-btn-danger" data-action="clear-log">清空日志</button>' +
        '</div>' +
        '<div class="admin-charts">' +
          '<div class="admin-chart-box"><h4>近 7 天操作趋势</h4><div class="chart" id="chart-trend"></div></div>' +
          '<div class="admin-chart-box"><h4>操作类型分布</h4><div class="chart" id="chart-action"></div></div>' +
          '<div class="admin-chart-box"><h4>用户操作排行</h4><div class="chart" id="chart-user"></div></div>' +
        '</div>' +
        '<table class="admin-table">' +
          '<thead><tr><th>时间</th><th>用户</th><th>动作</th><th>详情</th><th>IP</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="5" class="admin-empty">暂无日志</td></tr>') + '</tbody>' +
        '</table>';
      setContent(html);
      this.renderCharts(stats);
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
    },

    renderCharts(stats) {
      if (!window.echarts) {
        const box = document.getElementById('chart-trend');
        if (box) box.innerHTML = '<div class="admin-empty">图表组件未加载（需要联网加载 ECharts CDN）</div>';
        return;
      }
      const trendEl = document.getElementById('chart-trend');
      const actionEl = document.getElementById('chart-action');
      const userEl = document.getElementById('chart-user');
      if (!trendEl || !actionEl || !userEl) return;
      const trend = echarts.init(trendEl);
      const action = echarts.init(actionEl);
      const user = echarts.init(userEl);
      this._chartInstances = [trend, action, user];
      const daily = stats.daily || [];
      trend.setOption({
        tooltip: { trigger: 'axis' },
        grid: { left: 40, right: 20, top: 30, bottom: 30 },
        xAxis: { type: 'category', data: daily.map(d => d.date), axisLabel: { fontSize: 11 } },
        yAxis: { type: 'value', minInterval: 1 },
        series: [{ name: '操作次数', type: 'line', smooth: true, data: daily.map(d => d.count), areaStyle: { opacity: 0.15 }, itemStyle: { color: '#2c7bb6' } }]
      });
      const acts = stats.by_action || [];
      action.setOption({
        tooltip: { trigger: 'item' },
        legend: { bottom: 0, type: 'scroll' },
        series: [{ name: '操作类型', type: 'pie', radius: ['38%', '62%'], data: acts.map(a => ({ name: a.action, value: a.count })), label: { fontSize: 11 } }]
      });
      const users = stats.by_user || [];
      user.setOption({
        tooltip: { trigger: 'axis' },
        grid: { left: 70, right: 20, top: 20, bottom: 30 },
        xAxis: { type: 'value', minInterval: 1 },
        yAxis: { type: 'category', data: users.map(u => u.username).reverse(), axisLabel: { fontSize: 11 } },
        series: [{ name: '操作次数', type: 'bar', data: users.map(u => u.count).reverse(), itemStyle: { color: '#2e9e5b' } }]
      });
    },

    // ---------------- 系统设置 ----------------
    async renderSetting() {
      const meRes = await api('/api/auth/me');
      const me = meRes;
      const roleCode = me.role_code || '';
      const roleName = roleCode === 'admin' ? '系统管理员' : (roleCode === 'operator' ? '运维人员' : (roleCode === 'viewer' ? '访客' : roleCode));
      const html =
        '<div class="admin-toolbar"><h3>系统设置</h3></div>' +
        '<div class="admin-stats" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr));margin-bottom:18px;">' +
          '<div class="admin-stat"><div class="v">' + esc(me.user || '') + '</div><div class="k">当前登录账号</div></div>' +
          '<div class="admin-stat"><div class="v">' + esc(me.display_name || '—') + '</div><div class="k">显示名称</div></div>' +
          '<div class="admin-stat"><div class="v">' + esc(roleName) + '</div><div class="k">所属角色</div></div>' +
        '</div>' +
        '<div class="admin-form-row"><label>修改当前账号密码</label></div>' +
        '<div class="admin-form-row"><label>原密码</label><input id="s-old" type="password" /></div>' +
        '<div class="admin-form-row"><label>新密码（至少6位）</label><input id="s-new" type="password" /></div>' +
        '<div class="admin-form-row"><label>确认新密码</label><input id="s-confirm" type="password" /></div>' +
        '<button class="admin-btn" id="s-save">保存修改</button>' +
        '<p style="color:#8a99a8;font-size:12px;margin-top:14px;">修改成功后需重新登录。其他系统配置请通过服务器端 .env 文件调整。</p>';
      setContent(html);
      const btn = document.getElementById('s-save');
      if (btn) btn.addEventListener('click', async () => {
        const p1 = document.getElementById('s-new').value;
        const p2 = document.getElementById('s-confirm').value;
        if (p1 !== p2) { toast('两次输入的新密码不一致', 'error'); return; }
        try {
          await api('/api/admin/change-password', {
            method: 'POST',
            body: JSON.stringify({
              old_password: document.getElementById('s-old').value,
              new_password: p1
            })
          });
          toast('密码已修改，请重新登录', 'success');
          setTimeout(() => { window.location.href = 'login.html'; }, 1200);
        } catch (err) { toast(err.message, 'error'); }
      });

    },

    // ---------------- 智能体设置 ----------------
    async renderAgent() {
      let roleCode = '';
      try {
        const meRes = await api('/api/auth/me');
        roleCode = (meRes && meRes.role_code) || '';
      } catch (e) { /* ignore */ }
      const canEdit = roleCode !== 'viewer';
      const html =
        '<div class="admin-toolbar"><h3>智能体设置</h3></div>' +
        '<p style="color:#8a99a8;font-size:12px;margin-bottom:10px;line-height:1.7;">以下内容作为「冰冻圈灾害决策智能体」（decision.html）的系统提示词，定义它的身份、职责、回答规则与能力边界。保存后立即生效。</p>' +
        '<textarea id="agent-prompt" rows="16" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #d4dbe6;border-radius:8px;font-family:inherit;font-size:13px;line-height:1.6;"' + (canEdit ? '' : ' readonly') + '></textarea>' +
        '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;">' +
          (canEdit
            ? '<button class="admin-btn" id="agent-save">保存</button>' +
              '<button class="admin-btn" id="agent-reset" style="background:#eef1f5;color:#33475b;">恢复默认</button>'
            : '') +
        '</div>';
      setContent(html);

      try {
        const cfg = await api('/api/admin/agent-config');
        const d = cfg.data || {};
        const ta = document.getElementById('agent-prompt');
        if (ta) ta.value = d.system_prompt || '';
      } catch (e) {
        toast('智能体配置读取失败：' + (e && e.message ? e.message : '接口不可用'), 'error');
      }

      const saveBtn = document.getElementById('agent-save');
      if (saveBtn) saveBtn.addEventListener('click', async () => {
        const ta = document.getElementById('agent-prompt');
        const val = (ta ? ta.value : '').trim();
        if (!val) { toast('系统提示词不能为空', 'error'); return; }
        saveBtn.disabled = true;
        const btnText = saveBtn.textContent;
        saveBtn.textContent = '保存中…';
        try {
          await api('/api/admin/agent-config', { method: 'PUT', body: JSON.stringify({ system_prompt: val }) });
          toast('已保存，立即生效', 'success');
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
          this.openCategory('agent');
        } catch (err) { toast(err.message, 'error'); }
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
      const [stRes, sysRes, treeRes] = await Promise.all([
        api('/api/admin/stats'),
        api('/api/system/status'),
        api('/api/admin/data-tree')
      ]);
      const s = stRes.data || {};
      const sys = sysRes || {};
      const roots = (treeRes.data && treeRes.data.roots) || [];
      let dataFiles = 0, dataBytes = 0;
      roots.forEach(function (r) {
        (r.children || []).forEach(function (c) {
          dataFiles += (c.file_count || 0);
          dataBytes += (c.size_bytes || 0);
        });
      });
      const ok = '<span style="color:#2e9e5b;font-weight:600;">正常</span>';
      const bad = '<span style="color:#d7191c;font-weight:600;">异常</span>';
      const html =
        '<div class="admin-toolbar"><h3>系统状态</h3>' +
          '<span class="admin-search" style="border:none;background:transparent;color:#64748b;font-size:12px;">实时运行指标 · 示例 / 仅供参考</span>' +
          '<button class="admin-btn admin-btn-sm" id="status-refresh">刷新</button>' +
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
        this.statSection('数据资产', [
          { v: (sys.model_count || 0), k: '模型文件 (.tif)' },
          { v: (sys.threshold_count || 0), k: '阈值文件 (.tif)' },
          { v: (sys.runoff_files || 0), k: '径流输出文件' },
          { v: (sys.flood_inundation_files || 0), k: '淹没输出文件' },
          { v: fmtSize(dataBytes) + ' · ' + dataFiles + ' 个', k: '数据目录总量' }
        ]) +
        this.statSection('服务健康', [
          { v: sys.db_exists ? ok : bad,  k: '数据库' },
          { v: s.logs_today != null ? s.logs_today : '—', k: '今日日志' },
          { v: sys.online_users != null ? sys.online_users : '—', k: '近24h活跃用户' },
          { v: fmtSize((sys.storage_usage_mb || 0) * 1024 * 1024), k: '后端程序目录占用' }
        ]);
      setContent(html);
      const refresh = document.getElementById('status-refresh');
      if (refresh) refresh.addEventListener('click', function () { AdminPanel.openCategory('status'); });
    },

    // ---------------- 数据管理（真实 data/ 目录浏览器） ----------------
    async renderData() {
      const self = this;
      const path = this._dataPath || '';

      if (!path) {
        // 顶层：展示真实目录树（data/ 与 uploads）
        let data;
        try { data = await api('/api/admin/data-tree'); } catch (e) { data = { data: { roots: [] } }; }
        const roots = (data.data && data.data.roots) || [];
        let cards = '';
        roots.forEach(function (r) {
          const kids = r.children || [];
          if (kids.length) {
            kids.forEach(function (c) {
              cards += '<div class="data-folder-card" data-path="' + esc(c.path) + '">' +
                '<div class="data-folder-icon"><i class="fa fa-folder"></i></div>' +
                '<div class="data-folder-name">' + esc(c.name) + '</div>' +
                '<div class="data-folder-meta">' + (c.file_count || 0) + ' 个文件 · ' + esc(c.size_text || '—') + '</div>' +
                '</div>';
            });
          }
          else {
            cards += '<div class="data-folder-card" data-path="' + esc(r.path) + '">' +
              '<div class="data-folder-icon"><i class="fa fa-folder"></i></div>' +
              '<div class="data-folder-name">' + esc(r.name) + '</div>' +
              '<div class="data-folder-meta">点击查看</div></div>';
          }
        });
        const html =
          '<div class="admin-toolbar"><h3>数据管理</h3>' +
            '<span class="admin-search" style="font-size:12px;color:#64748b;border:none;box-shadow:none;background:transparent;">真实目录：data/raw、data/processed 与 data/webgis/uploads</span>' +
          '</div>' +
          '<div class="data-folder-grid">' + (cards || '<div class="admin-empty">暂无数据目录</div>') + '</div>';
        setContent(html);
        document.querySelectorAll('#admin-content .data-folder-card').forEach(function (card) {
          card.addEventListener('click', function () {
            self._dataPath = card.getAttribute('data-path');
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
          '<td>' + (f.is_dir ? '<i class="fa fa-folder" style="color:#eab308;"></i> ' : '') + esc(f.name) + '</td>' +
          '<td>' + esc(f.size_text || '') + '</td>' +
          '<td>' + esc(f.mtime) + '</td>' +
          '<td>' + (f.is_dir ? '<span style="color:#8a99a8;">—</span>' : '<button class="admin-btn admin-btn-sm admin-btn-danger" data-action="del-data" data-file="' + esc(f.name) + '">删除</button>') + '</td>' +
        '</tr>';
      }).join('');
      const totalPages = info.total_pages || 1;
      const html =
        '<div class="admin-toolbar"><h3>数据管理</h3>' +
          '<button class="admin-btn admin-btn-sm admin-btn-ghost" id="data-back">&laquo; 返回目录</button>' +
          '<span class="admin-search" style="font-size:12px;color:#64748b;border:none;box-shadow:none;background:transparent;">路径：' + esc(info.directory || '') + '</span>' +
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
      if (back) back.addEventListener('click', function () { self._dataPath = ''; self._dataPage = 1; self.openCategory('data'); });

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
    } else if (action === 'perm-role') {
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