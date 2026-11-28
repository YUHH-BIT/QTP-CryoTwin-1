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
import threading
import time
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


# ---------------- 账号设置：修改当前用户密码 ----------------
# 只改 session 自己的账号且校验原密码，属于自助操作，不要求 setting:edit；
# 否则头像菜单里的「账号设置」对 operator/viewer 会 403。
@admin_bp.route('/change-password', methods=['POST'])
@login_required
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


_DIR_STATS_CACHE = {}   # 目录路径 -> (统计时刻, 文件数, 总字节)
_DIR_STATS_LOCKS = {}   # 目录路径 -> Lock，避免预热线程和请求线程同时遍历同一个盘
_DIR_STATS_GUARD = threading.Lock()
_DIR_STATS_TTL = 300    # 秒；文件系统冷缓存下 os.walk 极慢，5 分钟内复用结果


def _dir_stats_lock(path):
    with _DIR_STATS_GUARD:
        lk = _DIR_STATS_LOCKS.get(path)
        if lk is None:
            lk = threading.Lock()
            _DIR_STATS_LOCKS[path] = lk
        return lk


def _dir_stats(path):
    """递归统计目录内文件数与总字节数（带 TTL 缓存，首次调用可能很慢）。

    data/ 目录有几十 GB、两万多个文件，冷缓存下 os.walk 一次要 30 秒量级，
    而「系统状态」「数据管理」都要用。这里做三件事：
      1) 结果缓存 5 分钟；
      2) 同一目录加锁，预热线程与请求线程不会同时重复遍历；
      3) app 启动时由 app.py 起线程预热一次，正常使用不会撞上冷启动。
    """
    now = time.time()
    hit = _DIR_STATS_CACHE.get(path)
    if hit and (now - hit[0]) < _DIR_STATS_TTL:
        return hit[1], hit[2]

    with _dir_stats_lock(path):
        # 拿到锁后重查一次：可能预热线程刚算完
        hit = _DIR_STATS_CACHE.get(path)
        now = time.time()
        if hit and (now - hit[0]) < _DIR_STATS_TTL:
            return hit[1], hit[2]

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
        _DIR_STATS_CACHE[path] = (now, count, size)
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


# ---------------- 数据资产目录（按业务语义分组，2026-11-28） ----------------
# 说明：这里刻意不返回递归统计的数字。data/raw/GLDAS025_Snowmelt 有 5 万个文件，
# data/raw/TibetanPlateau 有 67GB，递归 os.walk 一次要 10~30 秒（见 _dir_stats）。
# 数据管理第一屏只需要回答「有哪些数据、是干什么的」，量级用项目 README 里
# 已经确认过的口径写死；精确文件数在点开数据集、走分页接口时再按需给出。
DATA_ASSET_GROUPS = [
    {
        'key': 'hazard', 'name': '灾害数据', 'icon': 'fa-exclamation-triangle',
        'desc': '灾害事件、历史灾情、致灾环境与判识阈值，对应灾害数据库与风险评估',
        'items': [
            {'id': 'disaster-events', 'name': '八类灾害事件库', 'path': 'raw/geo/disaster',
             'scale': '8 份 GeoJSON · 约 29 MB（GLOFs / LLOFs / PFs / SFs / RTS / 冰川跃动 / 雪崩 / 风吹雪）',
             'usage': '灾害数据库 · 点/面图层',
             'icon': 'fa-exclamation-triangle', 'tone': 'coral'},
            {'id': 'floodhist', 'name': '历史洪水点位', 'path': 'raw/历史洪水点位数据集',
             'scale': '1980–2025 · 2 份汇总 CSV + 2 个时段目录 · 约 15 MB',
             'usage': '灾害数据库 · 历史灾情校验',
             'icon': 'fa-history', 'tone': 'amber'},
            {'id': 'threshold', 'name': '灾害判识阈值', 'path': 'raw/thresholds',
             'scale': '5 个百分位栅格（10/50/90/95/99）· 约 13 MB',
             'usage': '风险评估 · 阈值判识',
             'icon': 'fa-sliders', 'tone': 'purple'},
            {'id': 'cryosphere', 'name': '冰冻圈致灾背景', 'path': 'raw/geo/cryosphere',
             'scale': '冰川 / 冻土 2 份 GeoJSON · 约 279 MB',
             'usage': '灾害数据库 · 致灾环境底图',
             'icon': 'fa-snowflake-o', 'tone': 'ice'},
        ],
    },
    {
        'key': 'raw', 'name': '原始输入', 'icon': 'fa-download',
        'desc': '气象、水文、地形、社会经济与模型权重，是过程模拟与风险评估的输入',
        'items': [
            {'id': 'era5', 'name': 'ERA5 气象强迫', 'path': 'raw/TibetanPlateau',
             'scale': '4 变量 · 逐日 GeoTIFF · 约 67 GB', 'usage': '过程模拟 · 气象驱动',
             'icon': 'fa-cloud', 'tone': 'blue'},
            {'id': 'gldas', 'name': 'GLDAS 逐日融雪', 'path': 'raw/GLDAS025_Snowmelt',
             'scale': '逐日 GeoTIFF · 约 6.3 GB / 5 万景', 'usage': '融雪径流 · 洪水模拟',
             'icon': 'fa-snowflake-o', 'tone': 'ice'},
            {'id': 'socio', 'name': '社会经济原始资料', 'path': 'raw/socioeconomy',
             'scale': '10 类县域与设施数据 · 约 3 GB', 'usage': '脆弱性 · 暴露度分析',
             'icon': 'fa-building', 'tone': 'amber'},
            {'id': 'risk-socio', 'name': '风险评估社会经济表', 'path': 'uploads',
             'scale': '3 份 Excel（县域 GDP / 土地面积 / 农业）· 约 103 KB',
             'usage': '风险评估 · 暴露度与脆弱性输入',
             'icon': 'fa-bar-chart', 'tone': 'green'},
            {'id': 'dem', 'name': '原始高程 DEM', 'path': 'raw/dem',
             'scale': '1 景 · 约 2.4 GB', 'usage': '地形底图 · 流域提取',
             'icon': 'fa-mountain', 'tone': 'green'},
            {'id': 'model', 'name': '模型权重', 'path': 'raw/models',
             'scale': 'LSTM 径流模型 + 冻土分布', 'usage': '过程模拟 · 推理权重',
             'icon': 'fa-cogs', 'tone': 'purple'},
            {'id': 'vector', 'name': '矢量底图', 'path': 'raw/geo',
             'scale': '8 类语义目录（边界/水文/冰冻圈/设施等）', 'usage': '全站图层 · 空间查询',
             'icon': 'fa-map', 'tone': 'blue'},
        ],
    },
    {
        'key': 'processed', 'name': '中间成果', 'icon': 'fa-cube',
        'desc': '由原始数据处理派生、直接供前端各模块消费的成果数据',
        'items': [
            {'id': 'economy', 'name': '县域经济派生数据', 'path': 'processed/economy',
             'scale': '5 份 CSV（人口/耕地/粮食/牲畜）', 'usage': '决策支持 · 情景分析',
             'icon': 'fa-bar-chart', 'tone': 'amber'},
            {'id': 'db', 'name': '系统数据库', 'path': 'processed/db',
             'scale': '3 个 SQLite（管理/知识库/空间索引）', 'usage': '系统管理 · 检索',
             'icon': 'fa-database', 'tone': 'purple'},
            {'id': 'demcog', 'name': '派生 DEM / COG', 'path': 'processed/dem',
             'scale': '5 景 · 约 2 GB', 'usage': '首页地形 · 瓦片金字塔',
             'icon': 'fa-mountain', 'tone': 'green'},
            {'id': 'geocog', 'name': '简化矢量', 'path': 'processed/geo',
             'scale': '8 份 GeoJSON · 约 16 MB', 'usage': '前端矢量叠加',
             'icon': 'fa-map', 'tone': 'blue'},
            {'id': 'gldasmax', 'name': 'GLDAS 融雪月最大', 'path': 'processed/GLDAS_snowmelt_max',
             'scale': '2425 景 · 约 465 MB', 'usage': '风险评估 · 情景输入',
             'icon': 'fa-snowflake-o', 'tone': 'ice'},
            {'id': '3d', 'name': '三维示范区数据', 'path': 'processed/3d',
             'scale': '约 486 MB（地形瓦片 + 矢量）', 'usage': '三维孪生页',
             'icon': 'fa-cube', 'tone': 'purple'},
        ],
    },
    {
        'key': 'webgis', 'name': '系统数据', 'icon': 'fa-server',
        'desc': 'WebGIS 子系统的业务内容配置与运行产物',
        'items': [
            {'id': 'content', 'name': '业务内容配置', 'path': 'webgis/content',
             'scale': '2 份 JSON（决策知识 / 专家名录）', 'usage': '决策支持 · 内容配置',
             'icon': 'fa-file-code-o', 'tone': 'blue'},
            {'id': 'outputs', 'name': '运行产物', 'path': 'webgis/outputs',
             'scale': '7 类结果目录（径流/淹没/风险/动图等）', 'usage': '推演输出 · 可再生成',
             'icon': 'fa-folder-open', 'tone': 'amber'},
        ],
    },
]


@admin_bp.route('/data-assets', methods=['GET'])
@login_required
@permission_required('data:manage')
def api_data_assets():
    """按业务语义返回数据资产分组（不递归统计，只做目录存在性检查）。

    量级说明按项目目录实测与 README 已确认口径填写；精确文件数由 /data-files 在展开时给出。
    """
    groups = []
    total = 0
    present = 0
    for g in DATA_ASSET_GROUPS:
        items = []
        for it in g['items']:
            directory = _resolve_data_dir(it['path'])
            exists = bool(directory and os.path.isdir(directory))
            total += 1
            present += 1 if exists else 0
            row = dict(it)
            row['exists'] = exists
            items.append(row)
        groups.append({
            'key': g['key'], 'name': g['name'], 'icon': g['icon'],
            'desc': g['desc'], 'items': items,
        })
    return _ok({'groups': groups, 'total': total, 'present': present})


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
    conn = admin_db.connect(_base())
    try:
        row = conn.execute(
            'SELECT value, updated_at FROM settings WHERE key=?', (AGENT_PROMPT_KEY,)
        ).fetchone()
    finally:
        conn.close()
    current = row['value'] if row else None
    return _ok({
        'system_prompt': current if current else SYSTEM_PROMPT,
        'is_default': not current,
        'updated_at': (row['updated_at'] if row else None),
        'model': current_app.config.get('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
        'api_configured': bool(current_app.config.get('DEEPSEEK_API_KEY')),
        'amap_configured': bool(current_app.config.get('AMAP_KEY')),
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


# ---------------- 大模型知识库（RAG 真实数据）----------------
@admin_bp.route('/kb-status', methods=['GET'])
@login_required
def api_kb_status():
    """读取知识库各数据表条数与数据源明细（只读，不触发构建）。"""
    import sqlite3
    try:
        from modules import expert_kb
        status = expert_kb.get_kb_status()
        if not status.get('built'):
            return _ok({'built': False, 'counts': {}, 'sources': []})
        con = sqlite3.connect(expert_kb.KB_DB_PATH)
        try:
            con.row_factory = sqlite3.Row
            rows = con.execute(
                'SELECT name, description, exists_flag, size_bytes, updated_at '
                'FROM kb_sources ORDER BY id'
            ).fetchall()
        finally:
            con.close()
        sources = [{
            'name': r['name'],
            'description': r['description'] or '',
            'exists': bool(r['exists_flag']),
            'size_bytes': r['size_bytes'] or 0,
            'updated_at': r['updated_at'] or '',
        } for r in rows]
        return _ok({
            'built': True,
            'counts': status.get('counts') or {},
            'sources': sources,
            'db_path': status.get('db') or '',
        })
    except Exception as e:
        return _err('知识库状态读取失败: ' + str(e))


@admin_bp.route('/kb-rebuild', methods=['POST'])
@login_required
@permission_required('setting:edit')
def api_kb_rebuild():
    """从项目真实数据重建知识库（expert_kb.build_kb 幂等，force 重建全表）。"""
    try:
        from modules import expert_kb
        result = expert_kb.build_kb(force=True)
        _log('重建知识库', '重建冰冻圈灾害大模型 RAG 知识库')
        return _ok({'result': result, 'status': expert_kb.get_kb_status()})
    except Exception as e:
        return _err('知识库重建失败: ' + str(e))


# ---------------- 缓存刷新 ----------------
@admin_bp.route('/cache-clear', methods=['POST'])
@login_required
@permission_required('setting:edit')
def api_cache_clear():
    """清除进程内只读缓存，让数据改动立即反映到统计与模型加载。"""
    cleared = []
    _DIR_STATS_CACHE.clear()
    cleared.append('目录统计')
    for module_name, cache_name, label in (
        ('modules.simulate', '_MODEL_CACHE', '模型'),
        ('modules.economy', '_ECON_CACHE', '经济数据'),
        ('modules.alert', '_sv_cache', '易损性图层'),
        ('modules.alert', '_pop_cache', '县域人口'),
    ):
        try:
            mod = __import__(module_name, fromlist=[cache_name])
            cache = getattr(mod, cache_name)
            if isinstance(cache, dict):
                cache.clear()
                cleared.append(label)
        except Exception:
            pass
    _log('清除缓存', '、'.join(cleared))
    return _ok({'cleared': cleared})


# ---------------- 配置备份与恢复 ----------------
@admin_bp.route('/config-backup', methods=['GET'])
@login_required
@permission_required('setting:edit')
def api_config_backup():
    """下载当前 admin.db（用户/角色/权限/日志/提示词配置）。"""
    from flask import send_file
    from datetime import datetime
    dbp = admin_db.db_path(_base())
    if not os.path.isfile(dbp):
        return _err('配置文件不存在')
    name = 'admin-backup-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.db'
    _log('备份配置', name)
    return send_file(dbp, as_attachment=True, download_name=name)


@admin_bp.route('/config-restore', methods=['POST'])
@login_required
@permission_required('setting:edit')
def api_config_restore():
    """上传 SQLite 备份恢复配置；恢复前自动留存当前副本为 .bak。"""
    file = request.files.get('file')
    if not file or not file.filename:
        return _err('请选择备份文件')
    head = file.stream.read(16)
    if not head.startswith(b'SQLite format 3'):
        return _err('不是有效的 SQLite 备份文件')
    file.stream.seek(0)
    target = admin_db.db_path(_base())
    try:
        if os.path.isfile(target):
            shutil.copy2(target, target + '.bak')
        file.save(target)
        _log('恢复配置', '从上传的 SQLite 备份恢复 admin.db')
        return _ok(message='配置已恢复，请重新登录以刷新会话')
    except Exception as e:
        return _err('恢复失败: ' + str(e))
