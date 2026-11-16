# -*- coding: utf-8 -*-
"""
系统管理 API：用户 / 角色 / 权限 / 日志 / 修改密码 / 统计。

- 所有接口需登录（login_required）。
- 写操作按权限点校验（permission_required）。
- 关键操作写入 admin_logs。
"""
import functools
import os
import shutil
from datetime import datetime
from flask import Blueprint, request, jsonify, session, current_app
from werkzeug.utils import secure_filename
from modules.auth import login_required
from modules import admin_db

admin_bp = Blueprint('admin', __name__, url_prefix='/api/admin')


def _base():
    return current_app.config['BASE_DIR']


def permission_required(code):
    """权限点校验装饰器：当前用户角色缺少权限时返回 403。"""
    def deco(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            user_id = session.get('user_id')
            perms = admin_db.get_user_permission_codes(_base(), user_id) if user_id else []
            if code not in perms:
                return jsonify({'success': False, 'message': '无权限执行该操作'}), 403
            return f(*args, **kwargs)
        return wrapper
    return deco


def _log(action, detail=''):
    admin_db.add_log(_base(), session.get('user', ''), action, detail,
                     request.remote_addr or '')


def _ok(data=None, message='ok'):
    return jsonify({'success': True, 'message': message, 'data': data})


def _err(message, status=400):
    return jsonify({'success': False, 'message': message}), status


# ---------------- 统计 / 概览 ----------------
@admin_bp.route('/stats', methods=['GET'])
@login_required
@permission_required('system:view')
def api_stats():
    return _ok(admin_db.stats(_base()))


# ---------------- 用户管理 ----------------
@admin_bp.route('/users', methods=['GET'])
@login_required
@permission_required('user:view')
def api_list_users():
    # 兼容：?all=1 返回全量数组（供编辑弹窗等内部使用）
    if request.args.get('all') == '1':
        return _ok(admin_db.list_users(_base()))
    try:
        page = max(1, int(request.args.get('page', 1)))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = max(1, min(int(request.args.get('page_size', 10)), 100))
    except (TypeError, ValueError):
        page_size = 10
    keyword = request.args.get('keyword') or None
    return _ok(admin_db.search_users(_base(), page, page_size, keyword))


@admin_bp.route('/users', methods=['POST'])
@login_required
@permission_required('user:create')
def api_create_user():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    display_name = (data.get('display_name') or '').strip()
    role_id = data.get('role_id')
    status = 1 if data.get('status', 1) else 0

    if not username or not password:
        return _err('用户名和密码不能为空')
    if len(password) < 6:
        return _err('密码长度至少 6 位')
    if role_id is None:
        return _err('请选择角色')

    ok, msg = admin_db.create_user(_base(), username, password, display_name, role_id, status)
    if not ok:
        return _err(msg)
    _log('新增用户', f'创建用户 {username}')
    return _ok(message=msg)


@admin_bp.route('/users/<int:user_id>', methods=['PUT'])
@login_required
@permission_required('user:update')
def api_update_user(user_id):
    data = request.get_json(silent=True) or {}
    ok, msg = admin_db.update_user(
        _base(), user_id,
        display_name=data.get('display_name'),
        role_id=data.get('role_id'),
        status=data.get('status'))
    if not ok:
        return _err(msg)
    _log('编辑用户', f'更新用户 id={user_id}')
    return _ok(message=msg)


@admin_bp.route('/users/<int:user_id>', methods=['DELETE'])
@login_required
@permission_required('user:delete')
def api_delete_user(user_id):
    if user_id == session.get('user_id'):
        return _err('不能删除当前登录账号')
    row = None
    from modules import admin_db as _db
    # 查询目标用户名用于日志
    for u in _db.list_users(_base()):
        if u['id'] == user_id:
            row = u
            break
    if row is None:
        return _err('用户不存在')
    # 禁止删除最后一个启用的管理员
    if row.get('role_code') == 'admin':
        admins = [u for u in _db.list_users(_base())
                  if u.get('role_code') == 'admin' and u['status'] == 1]
        if len(admins) <= 1:
            return _err('系统至少需要保留一个启用的管理员账号')
    ok, msg = admin_db.delete_user(_base(), user_id)
    if not ok:
        return _err(msg)
    _log('删除用户', f'删除用户 {row["username"]}')
    return _ok(message=msg)


@admin_bp.route('/users/<int:user_id>/reset-password', methods=['POST'])
@login_required
@permission_required('user:update')
def api_reset_password(user_id):
    data = request.get_json(silent=True) or {}
    password = data.get('password') or ''
    if len(password) < 6:
        return _err('密码长度至少 6 位')
    ok, msg = admin_db.reset_password(_base(), user_id, password)
    if not ok:
        return _err(msg)
    _log('重置密码', f'重置用户 id={user_id} 的密码')
    return _ok(message=msg)


@admin_bp.route('/users/batch-delete', methods=['POST'])
@login_required
@permission_required('user:delete')
def api_batch_delete_users():
    data = request.get_json(silent=True) or {}
    ids = [int(x) for x in (data.get('ids') or []) if str(x).isdigit()]
    if not ids:
        return _err('请选择要删除的用户')
    me = session.get('user_id')
    if me in ids:
        return _err('不能删除当前登录账号')
    users = admin_db.list_users(_base())
    deleted = 0
    for uid in ids:
        target = next((u for u in users if u['id'] == uid), None)
        if target is None:
            continue
        if target.get('role_code') == 'admin' and target['status'] == 1:
            admins = [u for u in users if u.get('role_code') == 'admin' and u['status'] == 1]
            if len(admins) <= 1:
                return _err('系统至少需要保留一个启用的管理员账号')
        ok, _ = admin_db.delete_user(_base(), uid)
        if ok:
            deleted += 1
    _log('批量删除用户', '删除 %d 个用户' % deleted)
    return _ok(message='已删除 %d 个用户' % deleted)


@admin_bp.route('/users/batch-status', methods=['POST'])
@login_required
@permission_required('user:update')
def api_batch_status_users():
    data = request.get_json(silent=True) or {}
    ids = [int(x) for x in (data.get('ids') or []) if str(x).isdigit()]
    status = 1 if data.get('status') else 0
    if not ids:
        return _err('请选择用户')
    if status == 0:
        users = admin_db.list_users(_base())
        admins = [u for u in users if u.get('role_code') == 'admin' and u['status'] == 1]
        affected = [u for u in users if u['id'] in ids and u.get('role_code') == 'admin' and u['status'] == 1]
        if affected and len(admins) <= len(affected):
            return _err('系统至少需要保留一个启用的管理员账号')
    updated = 0
    for uid in ids:
        ok, _ = admin_db.update_user(_base(), uid, status=status)
        if ok:
            updated += 1
    verb = '启用' if status else '禁用'
    _log('批量%s' % verb, '%d 个用户' % updated)
    return _ok(message='已%s %d 个用户' % (verb, updated))

# ---------------- 角色管理 ----------------
@admin_bp.route('/roles', methods=['GET'])
@login_required
@permission_required('role:view')
def api_list_roles():
    return _ok(admin_db.list_roles(_base()))


@admin_bp.route('/roles', methods=['POST'])
@login_required
@permission_required('role:create')
def api_create_role():
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    code = (data.get('code') or '').strip()
    description = (data.get('description') or '').strip()
    if not name or not code:
        return _err('角色名称和编码不能为空')
    rid, msg = admin_db.create_role(_base(), name, code, description)
    if rid is None:
        return _err(msg)
    # 可选：同时设置权限
    codes = data.get('permissions') or []
    if codes:
        admin_db.set_role_permissions(_base(), rid, codes)
    _log('新增角色', f'创建角色 {name}({code})')
    return _ok(message=msg)


@admin_bp.route('/roles/<int:role_id>', methods=['PUT'])
@login_required
@permission_required('role:update')
def api_update_role(role_id):
    data = request.get_json(silent=True) or {}
    ok, msg = admin_db.update_role(
        _base(), role_id,
        name=(data.get('name') or '').strip() or None,
        description=(data.get('description') or '').strip() or None)
    if not ok:
        return _err(msg)
    _log('编辑角色', f'更新角色 id={role_id}')
    return _ok(message=msg)


@admin_bp.route('/roles/<int:role_id>', methods=['DELETE'])
@login_required
@permission_required('role:delete')
def api_delete_role(role_id):
    ok, msg = admin_db.delete_role(_base(), role_id)
    if not ok:
        return _err(msg)
    _log('删除角色', f'删除角色 id={role_id}')
    return _ok(message=msg)


# ---------------- 权限管理 ----------------
@admin_bp.route('/permissions', methods=['GET'])
@login_required
@permission_required('permission:view')
def api_list_permissions():
    return _ok(admin_db.list_permissions(_base()))


@admin_bp.route('/roles/<int:role_id>/permissions', methods=['GET'])
@login_required
@permission_required('role:view')
def api_get_role_permissions(role_id):
    return _ok(admin_db.get_role_permission_codes(_base(), role_id))


@admin_bp.route('/roles/<int:role_id>/permissions', methods=['PUT'])
@login_required
@permission_required('permission:assign')
def api_set_role_permissions(role_id):
    data = request.get_json(silent=True) or {}
    codes = data.get('permissions') or []
    admin_db.set_role_permissions(_base(), role_id, codes)
    _log('配置权限', f'为角色 id={role_id} 配置 {len(codes)} 项权限')
    return _ok(message='权限已更新')


# ---------------- 系统日志 ----------------
@admin_bp.route('/logs/stats', methods=['GET'])
@login_required
@permission_required('log:view')
def api_log_stats():
    days = request.args.get('days', 7)
    try:
        days = max(1, min(int(days), 30))
    except (TypeError, ValueError):
        days = 7
    return _ok(admin_db.log_stats(_base(), days))

@admin_bp.route('/logs', methods=['GET'])
@login_required
@permission_required('log:view')
def api_list_logs():
    limit = request.args.get('limit', 100)
    try:
        limit = max(1, min(int(limit), 500))
    except (TypeError, ValueError):
        limit = 100
    user = request.args.get('user') or None
    action = request.args.get('action') or None
    keyword = request.args.get('keyword') or None
    return _ok(admin_db.list_logs(_base(), limit, user, action, keyword))


@admin_bp.route('/logs', methods=['DELETE'])
@login_required
@permission_required('log:view')
def api_clear_logs():
    admin_db.clear_logs(_base())
    _log('清空日志', '清空全部系统日志')
    return _ok(message='日志已清空')


# ---------------- 系统设置：修改当前用户密码 ----------------
@admin_bp.route('/change-password', methods=['POST'])
@login_required
@permission_required('setting:edit')
def api_change_password():
    data = request.get_json(silent=True) or {}
    old_password = data.get('old_password') or ''
    new_password = data.get('new_password') or ''
    if len(new_password) < 6:
        return _err('新密码长度至少 6 位')
    ok, msg = admin_db.change_password(
        _base(), session.get('user_id'), old_password, new_password)
    if not ok:
        return _err(msg)
    _log('修改密码', '修改当前账号密码')
    return _ok(message='密码已修改，请重新登录')

# ---------------- 数据管理（目录浏览器：覆盖真实 data/ 与 uploads） ----------------
# 真实数据根：项目 data/ 目录（raw / processed）以及 uploads 目录。
# 注意：uploads 物理上位于 data/webgis/uploads/，但作为独立根挂载（下方 roots），
# 因此遍历 data/ 时要跳过 webgis/，否则两者会重复且把可再生产物混进数据树。
DATA_PAGE_SIZE = 50
# 遍历 data/ 根时隐藏的子目录（WebGIS 子系统数据区）
DATA_TREE_HIDDEN = frozenset({'webgis'})


def _resolve_data_dir(relpath):
    """将相对路径解析到 data/ 或 uploads/ 内部，防路径穿越。

    uploads 映射到 config.UPLOADS_DIR（data/webgis/uploads），
    其余相对路径映射到项目 data/ 根。
    """
    if relpath is None:
        relpath = ''
    relpath = relpath.strip().replace('\\', '/')
    if relpath == 'uploads' or relpath.startswith('uploads/'):
        base = os.path.realpath(current_app.config['UPLOADS_DIR'])
        sub = relpath[len('uploads'):].lstrip('/')
    else:
        base = os.path.realpath(os.path.join(current_app.config['BASE_DIR'], 'data'))
        sub = relpath.strip('/')
    if sub in ('', '.', '/'):
        full = base
    else:
        full = os.path.realpath(os.path.join(base, sub))
    base_real = os.path.realpath(base)
    try:
        if os.path.commonpath([base_real, full]) != base_real:
            return None
    except ValueError:
        return None
    return full


def _dir_stats(path):
    """递归统计目录内文件数与总字节数。"""
    count = 0
    size = 0
    try:
        for _root, _dirs, files in os.walk(path):
            for f in files:
                fp = os.path.join(_root, f)
                try:
                    size += os.path.getsize(fp)
                    count += 1
                except OSError:
                    pass
    except OSError:
        pass
    return count, size





def _resolve_data_file(directory, filename):
    """校验文件名并解析到指定目录内（防路径穿越）。"""
    if not filename or not isinstance(filename, str):
        return None
    if os.path.basename(filename) != filename:
        return None
    if '..' in filename or '/' in filename or '\\' in filename:
        return None
    base = os.path.realpath(directory)
    full = os.path.realpath(os.path.join(base, filename))
    try:
        if os.path.commonpath([base, full]) != base:
            return None
    except ValueError:
        return None
    return full


def _fmt_size(n):
    n = float(n or 0)
    if n < 1024:
        return f'{int(n)} B'
    if n < 1024 * 1024:
        return f'{n / 1024:.1f} KB'
    if n < 1024 * 1024 * 1024:
        return f'{n / 1024 / 1024:.1f} MB'
    return f'{n / 1024 / 1024 / 1024:.2f} GB'


@admin_bp.route('/data-tree', methods=['GET'])
@login_required
@permission_required('data:manage')
def api_data_tree():
    """返回 data/ 与 uploads 的目录树（仅文件夹，含递归文件数/大小）。

    data/ 根下会跳过 webgis/（见 DATA_TREE_HIDDEN），避免 uploads 重复挂载、
    以及 2.7GB 可再生运行产物出现在数据管理树里。
    """
    roots = []
    for label, base, base_rel in (
        ('data', os.path.join(current_app.config['BASE_DIR'], 'data'), ''),
        ('uploads', current_app.config['UPLOADS_DIR'], 'uploads'),
    ):
        base_real = os.path.realpath(base)
        children = []
        try:
            for name in sorted(os.listdir(base_real)):
                if name in DATA_TREE_HIDDEN:
                    continue
                p = os.path.join(base_real, name)
                if os.path.isdir(p):
                    c, s = _dir_stats(p)
                    children.append({
                        'name': name,
                        'path': (base_rel + '/' + name) if base_rel else name,
                        'file_count': c,
                        'size_bytes': s,
                        'size_text': _fmt_size(s),
                    })
        except OSError:
            pass
        roots.append({'name': label, 'path': base_rel, 'children': children})
    return _ok({'roots': roots})


@admin_bp.route('/data-files', methods=['GET'])
@login_required
@permission_required('data:manage')
def api_data_files():
    """列出某目录下的文件（分页），目录为空时自动创建。"""
    relpath = request.args.get('path', '')
    directory = _resolve_data_dir(relpath)
    if directory is None:
        return _err('无效路径')
    os.makedirs(directory, exist_ok=True)
    try:
        page = max(1, int(request.args.get('page', 1) or 1))
    except (ValueError, TypeError):
        page = 1

    try:
        entries = []
        for fn in os.listdir(directory):
            full = os.path.join(directory, fn)
            try:
                st = os.stat(full)
                is_dir = os.path.isdir(full)
                entries.append({
                    'name': fn,
                    'is_dir': is_dir,
                    'size': st.st_size if not is_dir else 0,
                    'size_text': _fmt_size(st.st_size) if not is_dir else '',
                    'mtime': datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S'),
                })
            except OSError:
                pass
        entries.sort(key=lambda x: (not x['is_dir'], x['name'].lower()))
        total = len(entries)
        total_pages = max(1, (total + DATA_PAGE_SIZE - 1) // DATA_PAGE_SIZE)
        start = (page - 1) * DATA_PAGE_SIZE
        page_items = entries[start:start + DATA_PAGE_SIZE]
        return _ok({
            'path': relpath, 'directory': directory, 'files': page_items,
            'total': total, 'page': page, 'page_size': DATA_PAGE_SIZE, 'total_pages': total_pages,
        })
    except OSError as e:
        return _err(f'读取目录失败: {e}')


@admin_bp.route('/data-files/upload', methods=['POST'])
@login_required
@permission_required('data:manage')
def api_upload_data_file():
    """上传文件到指定目录（path 相对 data/ 或 uploads/）。"""
    relpath = request.form.get('path', '')
    directory = _resolve_data_dir(relpath)
    if directory is None or not os.path.isdir(directory):
        return _err('无效路径')
    f = request.files.get('file')
    if f is None or not f.filename:
        return _err('未选择文件')
    original = secure_filename(f.filename)
    if not original:
        return _err('文件名非法')
    os.makedirs(directory, exist_ok=True)
    dest = os.path.join(directory, original)
    if os.path.exists(dest):
        base, e = os.path.splitext(original)
        i = 1
        while os.path.exists(dest):
            dest = os.path.join(directory, f'{base}_{i}{e}')
            i += 1
    try:
        f.save(dest)
    except OSError as e:
        return _err(f'保存失败: {e}')
    _log('上传数据文件', f'{relpath}/{os.path.basename(dest)}')
    return _ok(message='上传成功: ' + os.path.basename(dest))


@admin_bp.route('/data-files', methods=['DELETE'])
@login_required
@permission_required('data:manage')
def api_delete_data_file():
    """删除指定目录下的文件或子目录。"""
    relpath = request.args.get('path', '')
    filename = request.args.get('filename', '')
    directory = _resolve_data_dir(relpath)
    if directory is None:
        return _err('无效路径')
    full = _resolve_data_file(directory, filename)
    if full is None or not os.path.exists(full):
        return _err('文件不存在')
    try:
        if os.path.isdir(full):
            shutil.rmtree(full)
            _log('删除数据目录', f'{relpath}/{filename}')
        else:
            os.remove(full)
            _log('删除数据文件', f'{relpath}/{filename}')
    except OSError as e:
        return _err(f'删除失败: {e}')
    return _ok(message='已删除')

# ---------------- 大模型配置（冰冻圈灾害大模型系统提示词） ----------------
AGENT_PROMPT_KEY = 'agent_system_prompt'


@admin_bp.route('/agent-config', methods=['GET'])
@login_required
def api_get_agent_config():
    from modules.llm import SYSTEM_PROMPT
    current = admin_db.get_setting(_base(), AGENT_PROMPT_KEY)
    return _ok({
        'system_prompt': current if current else SYSTEM_PROMPT,
        'is_default': not current,
    })


@admin_bp.route('/agent-config', methods=['PUT'])
@login_required
@permission_required('setting:edit')
def api_update_agent_config():
    data = request.get_json(silent=True) or {}
    prompt = (data.get('system_prompt') or '').strip()
    if not prompt:
        return _err('系统提示词不能为空')
    admin_db.set_setting(_base(), AGENT_PROMPT_KEY, prompt)
    _log('修改大模型配置', '更新冰冻圈灾害大模型系统提示词')
    return _ok(message='已保存')


@admin_bp.route('/agent-config', methods=['DELETE'])
@login_required
@permission_required('setting:edit')
def api_reset_agent_config():
    admin_db.delete_setting(_base(), AGENT_PROMPT_KEY)
    _log('修改大模型配置', '恢复默认系统提示词')
    return _ok(message='已恢复默认')
