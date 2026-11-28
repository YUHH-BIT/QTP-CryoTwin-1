# -*- coding: utf-8 -*-
"""
系统状态模块：为系统管理页提供真实的状态数据（替代前端随机 mock）。
"""
import os
import time
import platform
import threading
from flask import Blueprint, jsonify, current_app

# 版本信息（真实环境探测，异常时为空字符串）
try:
    import flask as _flask
    FLASK_VERSION = getattr(_flask, '__version__', '')
except Exception:
    FLASK_VERSION = ''
try:
    import torch as _torch
    TORCH_VERSION = getattr(_torch, '__version__', '')
except Exception:
    TORCH_VERSION = ''

system_bp = Blueprint('system', __name__, url_prefix='/api/system')

# 进程启动时间（用于计算运行时长）
_START_TIME = time.time()

# 存储使用量缓存（避免每次请求都遍历静态输出目录）
# 2026-11-28：outputs 实测约 115 GB / 24 万文件，os.walk 冷跑约 8 秒，
# 原先 60 秒过期的同步扫描会让「系统管理 → 系统状态」首屏卡 8 秒。
# 现改为：命中缓存直接返回，未命中返回 None 并在后台线程刷新（前端显示「统计中…」）。
_STORAGE_CACHE = {'ts': 0, 'mb': None, 'busy': False}
_STORAGE_TTL = 1800  # 30 分钟


def _dir_size_mb(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total / (1024 * 1024)


def _recent_active_users():
    """统计最近 24 小时内活跃（登录/操作）的去重用户数，来自 admin_logs。"""
    try:
        import sqlite3
        from modules import admin_db
        db_file = admin_db.db_path(current_app.config['BASE_DIR'])
        if not os.path.isfile(db_file):
            return 0
        conn = sqlite3.connect(db_file)
        try:
            row = conn.execute(
                "SELECT COUNT(DISTINCT username) AS c FROM admin_logs "
                "WHERE created_at >= datetime('now', 'localtime', '-1 day')"
            ).fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()
    except Exception:
        return 0


def _storage_usage_mb(path):
    """返回静态输出目录占用（MB）。有缓存立即返回，否则 None + 后台线程刷新。"""
    now = time.time()
    if _STORAGE_CACHE['mb'] is not None and now - _STORAGE_CACHE['ts'] < _STORAGE_TTL:
        return _STORAGE_CACHE['mb']
    if not _STORAGE_CACHE['busy'] and path and os.path.isdir(path):
        _STORAGE_CACHE['busy'] = True

        def _work():
            try:
                _STORAGE_CACHE['mb'] = _dir_size_mb(path)
                _STORAGE_CACHE['ts'] = time.time()
            except Exception:
                pass
            finally:
                _STORAGE_CACHE['busy'] = False

        threading.Thread(target=_work, name='storage-usage', daemon=True).start()
    return _STORAGE_CACHE['mb']


@system_bp.route('/status', methods=['GET'])
def status():
    """返回系统运行状态（公开接口，不含敏感信息）。"""
    db_path = current_app.config.get('DATABASE_PATH', '')
    models_dir = current_app.config.get('MODELS_DIR', '')
    thresholds_dir = current_app.config.get('THRESHOLDS_DIR', '')

    def _count_tif(d):
        if not d or not os.path.isdir(d):
            return 0
        try:
            return len([f for f in os.listdir(d) if f.lower().endswith('.tif')])
        except OSError:
            return 0

    uptime_sec = int(time.time() - _START_TIME)
    storage_mb = _storage_usage_mb(current_app.config.get('OUTPUTS_DIR', ''))
    days, rem = divmod(uptime_sec, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60

    return jsonify({
        'status': 'ok',
        'system': '青藏高原冰冻圈灾害数字孪生系统',
        'version': '1.0.0',
        'python': platform.python_version(),
        'flask_version': FLASK_VERSION,
        'torch_version': TORCH_VERSION,
        'platform': platform.platform(),
        'uptime_seconds': uptime_sec,
        'uptime_text': f'{days}天{hours}时{minutes}分',
        'debug': bool(current_app.config.get('DEBUG')),
        'db_exists': bool(db_path and os.path.isfile(db_path)),
        'model_count': _count_tif(models_dir),
        'threshold_count': _count_tif(thresholds_dir),
        'runoff_files': _count_tif(current_app.config.get('RUNOFF_OUTPUT_DIR', '')),
        'flood_inundation_files': _count_tif(current_app.config.get('FLOOD_INUNDATION_DIR', '')),
        'online_users': _recent_active_users(),   # 最近24小时活跃用户数（来自日志）
        'storage_usage_mb': round(storage_mb, 1) if storage_mb is not None else None,
        'server_time': time.strftime('%Y-%m-%d %H:%M:%S'),
    })