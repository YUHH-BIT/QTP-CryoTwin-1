# -*- coding: utf-8 -*-
"""径流模拟（单文件版，可独立运行，无需启动整个系统）
================================================================
用法：直接修改下面「参数配置区」的日期和流域，然后运行本文件即可。
依赖：numpy、torch、rasterio（项目内嵌 .runtime 已自带）。
输出：同目录 output/ 下，逐日 {YYYY-MM-DD}_runoff.tif。
算法：与在线系统 webgis_backend/modules/runoff_engine.py 完全一致。
================================================================
"""
import datetime
import json
import logging
import os
import sqlite3
import sys
import tempfile
import time

# 抑制 Windows 上 torch(libomp) 与 NumPy/MKL(libiomp5md) 的 OMP Error #15
os.environ.setdefault('KMP_DUPLICATE_LIB_OK', 'TRUE')

import numpy as np
import rasterio
import torch
import torch.nn as nn
from rasterio.features import geometry_mask
from rasterio.windows import Window

# =====================================================================
# ==========================  参数配置区（手动改这里） ==========================
# =====================================================================
START_DATE = '2025-01-01'        # 开始日期 YYYY-MM-DD（含当天）
END_DATE   = '2025-12-31'        # 结束日期 YYYY-MM-DD（含当天）

# 计算范围：
#   None              → 全研究区（青藏高原中国境内 TP_China 边界，默认）
#   数字 0~14         → 指定流域索引（运行后日志会打印 15 个流域索引/名称）
#   '河西走廊诸河'     → 也可直接写流域中文名
BASIN_ID = None

WARMUP_DAYS = 0                 # 向前多读 N 天驱动预热（不写盘）
ENABLE_CROSS_DAY_MEMORY = False # 跨日记忆：默认关（与在线系统一致，可防崩溃）

# 输出目录：None = 本文件所在目录下的 output/
OUTPUT_DIR = r'E:\YHH\runoff'
# =====================================================================


# =====================================================================
# ==========================  以下一般不需要修改  ==========================
# =====================================================================
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(HERE, '..'))

MODEL_PATH = os.path.join(PROJECT_ROOT, 'data', 'raw', 'models', 'lstm_runoff_model.pt')
DB_PATH = os.path.join(PROJECT_ROOT, 'data', 'processed', 'db', 'TibetanPlateau_index.db')
TIF_ROOT = os.path.join(PROJECT_ROOT, 'data', 'raw', 'TibetanPlateau')
REGION_PATH = os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo', 'boundary', 'TP_China.geojson')
BASINS_PATH = os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo', 'hydrology', 'TP_Basins_China.geojson')

VARIABLES = [
    'temperature_2m',
    'temperature_2m_max',
    'total_precipitation_max',
    'total_precipitation_sum',
]

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger('径流模拟')

# ---------------- 模型与引擎常量（与在线系统一致，勿改） ----------------
_F32_SENTINEL = -3.4028234663852886e+38
DEFAULT_BATCH_PIXELS = 16384
DEFAULT_STATE_BUDGET_BYTES = 2 * 1024 ** 3


class RunoffLSTM(nn.Module):
    """两层 LSTM + FC + ReLU，与训练脚本结构一致，可直接加载 lstm_runoff_model.pt。"""

    def __init__(self, input_size=4, hidden_size=100, num_layers=2, dropout=0.0):
        super().__init__()
        self.lstm = nn.LSTM(input_size=input_size, hidden_size=hidden_size,
                            num_layers=num_layers, batch_first=True,
                            dropout=dropout if num_layers > 1 else 0.0)
        self.fc = nn.Linear(hidden_size, 1)
        self.relu = nn.ReLU()

    def forward(self, x, state=None):
        out, state = self.lstm(x, state)
        return self.relu(self.fc(out).squeeze(-1)), state


def detect_memory_bytes():
    """探测（总内存, 可用内存）字节数；失败返回 (None, None)。"""
    try:
        if os.name == 'nt':
            import ctypes
            import ctypes.wintypes as wintypes

            class _MemStatus(ctypes.Structure):
                _fields_ = [
                    ('dwLength', wintypes.DWORD),
                    ('dwMemoryLoad', wintypes.DWORD),
                    ('ullTotalPhys', ctypes.c_ulonglong),
                    ('ullAvailPhys', ctypes.c_ulonglong),
                    ('ullTotalPageFile', ctypes.c_ulonglong),
                    ('ullAvailPageFile', ctypes.c_ulonglong),
                    ('ullTotalVirtual', ctypes.c_ulonglong),
                    ('ullAvailVirtual', ctypes.c_ulonglong),
                    ('ullAvailExtendedVirtual', ctypes.c_ulonglong),
                ]

            st = _MemStatus()
            st.dwLength = ctypes.sizeof(_MemStatus)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                return int(st.ullTotalPhys), min(int(st.ullAvailPhys),
                                                 int(st.ullAvailPageFile))
            return None, None
        page = os.sysconf('SC_PAGE_SIZE')
        return (page * os.sysconf('SC_PHYS_PAGES'),
                page * os.sysconf('SC_AVPHYS_PAGES'))
    except Exception:
        return None, None


def auto_state_budget_bytes():
    """状态内存预算：min(总内存×40%, 可用×60%, 8GB)，下限 2GB；探测失败用 2GB。"""
    total_b, avail_b = detect_memory_bytes()
    if not total_b or not avail_b:
        return DEFAULT_STATE_BUDGET_BYTES
    return max(min(int(total_b * 0.4), int(avail_b * 0.6), 8 * 1024 ** 3),
               DEFAULT_STATE_BUDGET_BYTES)


def _windows_intersect(transform, height, width, geom, margin=1):
    """由几何外包络算栅格窗口 (r0, c0, r1, c1)。"""
    from rasterio.transform import rowcol

    if geom.get('type') in ('MultiPolygon', 'GeometryCollection'):
        geoms = geom.get('geometries') if geom.get('type') == 'GeometryCollection' else None
        if geoms is not None:
            coords = []
            for g in geoms:
                for poly in g.get('coordinates', []):
                    for ring in poly:
                        coords.extend(ring)
        else:
            coords = []
            for poly in geom.get('coordinates', []):
                for ring in poly:
                    coords.extend(ring)
    elif geom.get('type') == 'Polygon':
        coords = [pt for ring in geom.get('coordinates', []) for pt in ring]
    else:
        coords = list(geom.get('coordinates', []))

    if not coords:
        raise ValueError('几何为空')
    xs = np.array([c[0] for c in coords], dtype='float64')
    ys = np.array([c[1] for c in coords], dtype='float64')
    rows, cols = rowcol(transform, xs, ys)
    r0 = max(0, int(np.floor(rows.min())) - margin)
    r1 = min(height, int(np.ceil(rows.max())) + 1 + margin)
    c0 = max(0, int(np.floor(cols.min())) - margin)
    c1 = min(width, int(np.ceil(cols.max())) + 1 + margin)
    if r0 >= r1 or c0 >= c1:
        raise ValueError('几何与研究区栅格无交集')
    return r0, c0, r1, c1


def _read_day_vars(day_files, date, variables, window, rl, cl, exp_shape):
    """读取某天所有变量在有效像元上的取值，返回 (X[V,P], bad[V,P])。"""
    V, P = len(variables), rl.shape[0]
    X = np.empty((V, P), dtype=np.float32)
    bad = np.zeros((V, P), dtype=bool)
    for vi, var in enumerate(variables):
        path = day_files.get(date, {}).get(var)
        if not path or not os.path.isfile(path):
            X[vi] = np.nan
            bad[vi] = True
            continue
        with rasterio.open(path) as src:
            if src.height != exp_shape[0] or src.width != exp_shape[1]:
                raise ValueError(
                    f'栅格网格不一致：{os.path.basename(path)} 为 '
                    f'{src.height}×{src.width}，参考文件为 {exp_shape[0]}×{exp_shape[1]}')
            band = src.read(1, window=window)
            nod = src.nodata
        v = band[rl, cl].astype(np.float32, copy=False)
        b = ~np.isfinite(v)
        if nod is not None:
            b |= (v == nod)
        b |= (v <= _F32_SENTINEL * 0.99)
        X[vi], bad[vi] = v, b
    return X, bad


def _valid_mask_of(path, window):
    """窗口内哪些像元有真实值（兼容 NaN 与 -3.4e38 两代 nodata 编码）。"""
    with rasterio.open(path) as src:
        band = src.read(1, window=window)
        nod = src.nodata
    bad = ~np.isfinite(band)
    if nod is not None:
        bad |= (band == nod)
    bad |= (band <= _F32_SENTINEL * 0.99)
    return ~bad, (int(band.shape[0]), int(band.shape[1]))


def build_pixel_index(ref_path, basin_geometry=None, region_geometry=None):
    """确定计算窗口与几何掩膜。"""
    with rasterio.open(ref_path) as ref:
        height, width = ref.height, ref.width
        transform, crs = ref.transform, ref.crs
        profile = ref.meta.copy()

    scope_geom = basin_geometry if basin_geometry is not None else region_geometry
    if scope_geom is not None:
        r0, c0, r1, c1 = _windows_intersect(transform, height, width, scope_geom)
        win = Window(c0, r0, c1 - c0, r1 - r0)
    else:
        win = Window(0, 0, width, height)

    if basin_geometry is not None:
        scope = 'basin'
    elif region_geometry is not None:
        scope = 'region'
    else:
        scope = 'full'

    local_transform = rasterio.windows.transform(win, transform)
    win_h, win_w = int(win.height), int(win.width)

    keep = np.ones((win_h, win_w), dtype=bool)
    if region_geometry is not None:
        keep &= geometry_mask([region_geometry], out_shape=(win_h, win_w),
                              transform=local_transform, invert=True)
    if basin_geometry is not None:
        keep &= geometry_mask([basin_geometry], out_shape=(win_h, win_w),
                              transform=local_transform, invert=True)
    return {
        'height': height, 'width': width, 'transform': transform, 'crs': crs,
        'profile': profile, 'window': win, 'row_off': int(win.row_off),
        'col_off': int(win.col_off), 'win_shape': (win_h, win_w),
        'keep': keep, 'scope': scope,
    }


def load_geometry(path):
    """读取 GeoJSON 边界：单要素取其 geometry，多要素包成 GeometryCollection。"""
    if not path or not os.path.isfile(path):
        logger.warning('边界文件不存在，不做裁剪: %s', path)
        return None
    with open(path, 'r', encoding='utf-8') as f:
        gj = json.load(f)
    feats = gj.get('features', [])
    if not feats:
        return None
    if len(feats) == 1:
        return feats[0].get('geometry')
    return {'type': 'GeometryCollection',
            'geometries': [f.get('geometry') for f in feats if f.get('geometry')]}


def build_valid_mask(grid, day_files, all_dates, variables, n_samples=4):
    """跨日期采样求有效像元并集掩膜。"""
    win = grid['window']
    win_shape = grid['win_shape']
    sample_dates = all_dates
    if len(all_dates) > n_samples:
        step = len(all_dates) / float(n_samples)
        sample_dates = [all_dates[min(len(all_dates) - 1, int(i * step))]
                        for i in range(n_samples)]
        if all_dates[-1] not in sample_dates:
            sample_dates[-1] = all_dates[-1]

    union = np.zeros(win_shape, dtype=bool)
    n_used = 0
    for date in sample_dates:
        path = day_files.get(date, {}).get(variables[0])
        if not path or not os.path.isfile(path):
            continue
        with rasterio.open(path) as src:
            if src.height != grid['height'] or src.width != grid['width']:
                raise ValueError(
                    f'栅格网格不一致：{os.path.basename(path)} 为 '
                    f'{src.height}×{src.width}，参考文件为 '
                    f'{grid["height"]}×{grid["width"]}')
        m, _ = _valid_mask_of(path, win)
        union |= m
        n_used += 1
    if n_used == 0:
        raise ValueError('无法从驱动数据确定有效像元掩膜')

    keep = grid['keep'] & union
    logger.info('有效掩膜采样 %d 天（共 %d 天），与几何相交后 %s 像元',
                n_used, len(all_dates), format(int(keep.sum()), ','))
    return keep


def write_geotiff_atomic(out_path, array, profile, retries=5):
    """原子写 GeoTIFF：临时文件 + os.replace，规避 Windows 文件锁。"""
    directory = os.path.dirname(os.path.abspath(out_path)) or '.'
    os.makedirs(directory, exist_ok=True)
    base = os.path.basename(out_path)
    fd, tmp_path = tempfile.mkstemp(suffix='.tif', prefix=f'.tmp_{base}.', dir=directory)
    os.close(fd)
    try:
        with rasterio.open(tmp_path, 'w', **profile) as dst:
            dst.write(array, 1)
        for attempt in range(retries):
            try:
                os.replace(tmp_path, out_path)
                return out_path
            except OSError:
                if attempt == retries - 1:
                    raise
                time.sleep(0.15 * (attempt + 1))
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        raise


def _is_oom_error(e):
    msg = str(e).lower()
    return any(k in msg for k in ('not enough memory', 'out of memory',
                                  'cannot allocate memory', 'unable to allocate',
                                  'alloc_cpu', 'defaultcpuallocator'))


def simulate_runoff(model, device, variables, day_files, all_dates, out_dates,
                    ref_path, output_dir, basin_geometry=None,
                    region_geometry=None, batch_pixels=DEFAULT_BATCH_PIXELS,
                    state_budget_bytes=0):
    """径流模拟主流程，返回统计 dict。"""
    t_start = time.perf_counter()
    out_dates = set(out_dates)

    grid = build_pixel_index(ref_path, basin_geometry, region_geometry)
    height, width = grid['height'], grid['width']
    win = grid['window']
    win_h, win_w = grid['win_shape']

    keep = build_valid_mask(grid, day_files, all_dates, variables)
    idx = np.flatnonzero(keep.ravel())
    P = int(idx.size)
    if P == 0:
        raise ValueError('计算区域内没有有效像元，请检查流域范围与驱动数据')
    rl = (idx // win_w).astype(np.intp)
    cl = (idx % win_w).astype(np.intp)

    # 跨日记忆受状态内存预算约束
    n_layers = model.lstm.num_layers
    hidden = model.lstm.hidden_size
    state_per_pixel = 2 * n_layers * hidden * 4
    need_state = len(all_dates) > 1
    state_bytes = P * state_per_pixel
    use_state = need_state and state_bytes <= state_budget_bytes
    fallback_reason = None
    if need_state and not use_state:
        fallback_reason = (
            f'有效像元 {P:,} 的 LSTM 状态需 {state_bytes/1024**3:.2f} GB，'
            f'超出预算 {state_budget_bytes/1024**3:.2f} GB，退化为逐日独立推理')
        logger.warning(fallback_reason)
    logger.info('计算范围 %s：窗口 %d×%d，有效像元 %s，跨日记忆 %s，batch %d，总天数 %d',
                grid['scope'], win_h, win_w, format(P, ','),
                '开' if use_state else '关', batch_pixels, len(all_dates))

    local_transform = rasterio.windows.transform(win, grid['transform'])
    profile = grid['profile'].copy()
    profile.update(driver='GTiff', dtype='float32', count=1,
                   compress='lzw', nodata=np.nan,
                   height=win_h, width=win_w, transform=local_transform)
    os.makedirs(output_dir, exist_ok=True)

    def _run_days(batch_cur, state_cur):
        state_h = state_c = None
        last_good = None
        out_buffer = np.full((win_h, win_w), np.nan, dtype=np.float32)
        written = []
        n_nodata_filled = 0
        t0 = time.perf_counter()

        with torch.no_grad():
            for di, date in enumerate(all_dates):
                X, bad = _read_day_vars(day_files, date, variables, win, rl, cl,
                                        (height, width))
                n_bad = int(bad.sum())
                # 缺失值前向填充，保持序列连续
                if last_good is None:
                    for vi in range(len(variables)):
                        b = bad[vi]
                        if not b.any():
                            continue
                        good = X[vi][~b]
                        X[vi][b] = np.float32(np.median(good)) if good.size else np.float32(0.0)
                else:
                    X = np.where(bad, last_good, X)
                last_good = X.copy()
                if n_bad:
                    n_nodata_filled += n_bad

                # (V, P) -> (P, 1, V)：像元是 batch，时间是长度 1 的序列
                Xt = np.ascontiguousarray(X.T)[:, None, :]

                if state_cur and state_h is None:
                    state_h = torch.zeros(n_layers, P, hidden, dtype=torch.float32)
                    state_c = torch.zeros(n_layers, P, hidden, dtype=torch.float32)

                y_all = np.empty(P, dtype=np.float32)
                for s in range(0, P, batch_cur):
                    e = min(s + batch_cur, P)
                    xb = torch.from_numpy(Xt[s:e]).to(device)
                    if state_cur:
                        y, (h, c) = model(xb, (state_h[:, s:e], state_c[:, s:e]))
                        state_h[:, s:e] = h
                        state_c[:, s:e] = c
                    else:
                        y, _ = model(xb, None)
                    y_all[s:e] = y[:, -1].cpu().numpy()

                if date in out_dates:
                    out_buffer[:] = np.nan
                    out_buffer.ravel()[idx] = y_all
                    out_path = os.path.join(output_dir, f'{date}_runoff.tif')
                    write_geotiff_atomic(out_path, out_buffer, profile)
                    written.append(out_path)

                if (di + 1) % 5 == 0 or di + 1 == len(all_dates):
                    used = time.perf_counter() - t0
                    remain = used / (di + 1) * (len(all_dates) - di - 1)
                    logger.info('[径流模拟] 进度 %d/%d 天（%s） | 已用 %.0fs | 预计剩余 %.0fs',
                                di + 1, len(all_dates), date, used, remain)
        return written, n_nodata_filled, state_h is not None

    # OOM 自适应降档：batch 减半 → 关跨日记忆 → 报错
    attempt_batch, attempt_state = batch_pixels, use_state
    while True:
        try:
            written, n_nodata_filled, state_used = _run_days(attempt_batch, attempt_state)
            break
        except (RuntimeError, MemoryError) as e:
            if not _is_oom_error(e):
                raise
            import gc
            gc.collect()
            if attempt_batch > 4096:
                attempt_batch = max(attempt_batch // 2, 4096)
                logger.warning('内存不足，batch 自动降为 %s 后重试', format(attempt_batch, ','))
                continue
            if attempt_state:
                attempt_state = False
                logger.warning('内存不足，已关闭跨日记忆并降小 batch 后重试')
                continue
            raise ValueError('本机内存不足以完成该模拟：请缩小时间范围或只选单个流域') from e

    elapsed = time.perf_counter() - t_start
    logger.info('=' * 20 + ' 径流模拟完成 ' + '=' * 20)
    logger.info('输出 %d 天，有效像元 %s，耗时 %.1fs，缺失值填充 %s 个，目录: %s',
                len(written), format(P, ','), elapsed,
                format(n_nodata_filled, ','), output_dir)
    return {
        'files': written, 'n_pixels': P,
        'n_days_total': len(all_dates), 'n_days_output': len(written),
        'scope': grid['scope'], 'cross_day_memory': bool(state_used),
        'fallback_reason': None if state_used else fallback_reason,
        'batch_pixels': int(attempt_batch),
        'nodata_values_filled': n_nodata_filled,
        'elapsed_seconds': round(elapsed, 2),
    }


# ----------------------------- 数据装配 -----------------------------
def resolve_index_path(file_path):
    """索引库相对路径 -> 本机绝对路径。"""
    p = file_path.replace('/', os.sep).replace('\\', os.sep)
    if os.path.isabs(p) or (len(p) > 1 and p[1] == ':'):
        return p
    return os.path.join(TIF_ROOT, p)


def build_day_files(warmup_start):
    """优先查 SQLite 索引库；库不存在/无数据则按目录命名直扫。"""
    day_files = {}
    if os.path.isfile(DB_PATH):
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute('SELECT variable, date, file_path FROM TibetanPlateau_index '
                        'WHERE date BETWEEN ? AND ? ORDER BY date, variable',
                        (warmup_start, END_DATE))
            for row in cur.fetchall():
                day_files.setdefault(row['date'], {})[row['variable']] = \
                    resolve_index_path(row['file_path'])
        finally:
            if conn is not None:
                conn.close()
        if day_files:
            logger.info('驱动来源：索引库 %s', DB_PATH)
            return day_files

    # 目录直扫：{TIF_ROOT}/{变量}/{变量}_{日期}.tif
    logger.info('索引库无数据，改为目录直扫：%s', TIF_ROOT)
    d0 = datetime.datetime.strptime(warmup_start, '%Y-%m-%d')
    d1 = datetime.datetime.strptime(END_DATE, '%Y-%m-%d')
    cur_d = d0
    while cur_d <= d1:
        date = cur_d.strftime('%Y-%m-%d')
        per_day = {}
        for var in VARIABLES:
            p = os.path.join(TIF_ROOT, var, f'{var}_{date}.tif')
            if os.path.isfile(p):
                per_day[var] = p
        if per_day.get(VARIABLES[0]):
            day_files[date] = per_day
        cur_d += datetime.timedelta(days=1)
    return day_files


def load_basin_geometry(basin_key):
    """按索引（数字）或名称加载流域几何；找不到返回 None。"""
    if basin_key is None or basin_key == '':
        return None
    with open(BASINS_PATH, 'r', encoding='utf-8') as f:
        features = json.load(f).get('features', [])

    key = str(basin_key).strip()
    if key.isdigit():
        idx = int(key)
        if 0 <= idx < len(features):
            return features[idx].get('geometry')
        raise ValueError(f'流域索引超出范围：{idx}（共 {len(features)} 个，索引 0~{len(features)-1}）')

    candidates = ['NAME', 'BASIN_NAME', 'BAS_NM', 'name', 'BASIN', 'PN',
                  'BAS_NAME', 'BasinName']
    name_field = next((fld for fld in candidates
                       if features and features[0].get('properties', {}).get(fld)), None)
    for feature in features:
        props = feature.get('properties', {})
        if name_field and props.get(name_field) == key:
            return feature.get('geometry')
    raise ValueError(f'未找到流域：{key}')


def list_basins():
    """打印 15 个流域的索引与名称。"""
    with open(BASINS_PATH, 'r', encoding='utf-8') as f:
        features = json.load(f).get('features', [])
    candidates = ['NAME', 'BASIN_NAME', 'BAS_NM', 'name', 'BASIN', 'PN',
                  'BAS_NAME', 'BasinName']
    name_field = next((fld for fld in candidates
                       if features and features[0].get('properties', {}).get(fld)), None)
    print(f'共 {len(features)} 个流域（BASIN_ID 填索引或名称）：')
    for i, feature in enumerate(features):
        name = feature.get('properties', {}).get(name_field) if name_field else None
        print(f'  [{i:>2}] {name or "(未命名)"}')


def main():
    # 日期校验
    start_dt = datetime.datetime.strptime(START_DATE, '%Y-%m-%d')
    end_dt = datetime.datetime.strptime(END_DATE, '%Y-%m-%d')
    if start_dt > end_dt:
        raise SystemExit('开始日期不能晚于结束日期')
    warmup_start = (start_dt - datetime.timedelta(days=max(0, int(WARMUP_DAYS)))) \
        .strftime('%Y-%m-%d')

    out_dir = OUTPUT_DIR or os.path.join(HERE, 'output')

    # 逐日驱动文件
    day_files = build_day_files(warmup_start)
    all_dates = sorted(day_files)
    out_dates = [d for d in all_dates if d >= START_DATE]
    if not out_dates:
        raise SystemExit(f'指定日期范围内没有气象数据：{START_DATE} ~ {END_DATE}')

    # 参考栅格（决定输出网格）
    ref_path = None
    for d in all_dates:
        for v in VARIABLES:
            p = day_files[d].get(v)
            if p and os.path.isfile(p):
                ref_path = p
                break
        if ref_path:
            break
    if ref_path is None:
        raise SystemExit('没有找到有效的气象驱动文件')

    # 模型
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    torch.set_num_threads(min(os.cpu_count() or 4, 64))
    model = RunoffLSTM(input_size=len(VARIABLES)).to(device)
    try:
        state = torch.load(MODEL_PATH, map_location=device, weights_only=True)
    except TypeError:
        state = torch.load(MODEL_PATH, map_location=device)
    except Exception:
        state = torch.load(MODEL_PATH, map_location=device)
    if isinstance(state, dict) and 'state_dict' in state:
        state = state['state_dict']
    model.load_state_dict(state)
    model.eval()

    # 研究区边界 + 流域
    region_geometry = load_geometry(REGION_PATH)
    basin_geometry = load_basin_geometry(BASIN_ID)

    # 在线系统两条固化约束：batch 锁 16384；跨日记忆默认关（预算 0）
    state_budget = auto_state_budget_bytes() if ENABLE_CROSS_DAY_MEMORY else 0

    logger.info('=' * 20 + ' 径流模拟任务开始 ' + '=' * 20)
    logger.info('模型: %s', MODEL_PATH)
    logger.info('时间: %s ~ %s（含预热共 %d 天，输出 %d 天）',
                START_DATE, END_DATE, len(all_dates), len(out_dates))
    logger.info('范围: %s | 设备: %s | batch: %d | 跨日记忆: %s',
                BASIN_ID if BASIN_ID is not None else '全研究区',
                device, DEFAULT_BATCH_PIXELS,
                '开' if state_budget else '关')
    logger.info('输出目录: %s', out_dir)

    stats = simulate_runoff(
        model=model, device=device, variables=VARIABLES,
        day_files=day_files, all_dates=all_dates, out_dates=out_dates,
        ref_path=ref_path, output_dir=out_dir,
        basin_geometry=basin_geometry, region_geometry=region_geometry,
        batch_pixels=DEFAULT_BATCH_PIXELS, state_budget_bytes=state_budget)

    print('\n生成文件：')
    for p in stats['files']:
        print('  ', p)
    print(f"\n完成：{stats['n_days_output']} 天，有效像元 {stats['n_pixels']:,} 个，"
          f"耗时 {stats['elapsed_seconds']} 秒")


if __name__ == '__main__':
    # 想看流域索引/名称时，把下面一行注释解开后运行：
    # list_basins()
    main()
