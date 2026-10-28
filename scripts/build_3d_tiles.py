#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三维瓦片生成工具（Cesium quantized-mesh 地形 + 矢量简化 + 影像缓存）。

子命令：
  prefill        全域 DEM nodata 确定性填充（带状最近邻，搜索距离可配）
  terrain        生成 quantized-mesh 地形瓦片（多进程、断点续跑、自动写 layer.json）
  vectors        矢量简化（冰川/湖泊/冻土/河网/8 类灾害合并/边界）
  cache-imagery  高德卫星瓦片本地缓存（可选，离线演示用；默认在线模式不需要）

用法示例：
  python scripts/build_3d_tiles.py prefill
  python scripts/build_3d_tiles.py terrain --region tp_full --zoom 0-12 --jobs 8
  python scripts/build_3d_tiles.py vectors --region tp_full
  python scripts/build_3d_tiles.py cache-imagery --bbox 85,27.5,86.5,29 --zoom 8-14

技术要点（均经过 spike 验证，详见 docs/01_技术思路/07_三维示范区建设方案.md）：
  - 瓦片网格：Cesium GeographicTilingScheme / TMS global-geodetic，
    即 nx=2^(z+1)、ny=2^z、纬度线性划分、y 从南数（TMS）。
    （注意与 OSM slippy 网格 2^z x 2^z + 墨卡托纬度不同，勿混用。）
  - 瓦片格式：quantized-mesh 1.0。header 88 字节（无 tileX/Y/Z）；顶点 planar 布局
    + zigzag 增量（首元素为绝对值）；三角形索引 high-water-mark 编码（顶点按首次
    出现顺序重排，保证 code 恒非负，不依赖 uint16 回绕）；边索引不编码；
    扩展 id=1 为 oct 编码法线。
  - 接缝连续性：按精确经纬度在 DEM 全图像素坐标系下双线性采样（相邻瓦片在共享
    边界做完全相同的插值）；窗口按像素分数坐标自算并留 1px 余量（rasterio 的
    from_bounds 会切掉跨界像素，导致边界插值取错邻域）。
  - nodata 策略（两级，全部确定性，跨瓦片/跨 LOD 一致）：
      1) prefill：距离有效数据 <= max-dist(默认400px≈36km) 的空洞用最近邻填充，
         形成掩膜边界的平滑外推 shelf；
      2) 瓦片级：剩余 nodata（掩膜外远场）用全域最低高程常量填充 —— 常量天然无缝；
      3) 全 nodata 瓦片跳过（layer.json 的 available 不含它，Cesium 不会请求）；
         z0 两个根瓦片始终生成，保证 Cesium 根节点可用。
"""
import argparse
import gc
import json
import math
import os
import struct
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from multiprocessing import Pool

import numpy as np

# ---------------------------------------------------------------- 项目根定位
# 与 scripts/ 下其他脚本一致：用 __file__ 回退定位项目根，可在任意工作目录运行
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..'))

DEM_DEFAULT = os.path.join(PROJECT_ROOT, 'data', 'processed', 'dem', 'TP_China_dem_cog.tif')
SCENE3D_DIR = os.path.join(PROJECT_ROOT, 'data', 'processed', '3d')
PREFILL_DEFAULT = os.path.join(SCENE3D_DIR, 'dem_filled.tif')
MANIFEST_PATH = os.path.join(SCENE3D_DIR, 'regions.json')
GEO_RAW_DIR = os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo')

# 与 webgis_backend/config.py 的 DISASTER_TYPES 保持单一数据源：
# 直接 import 避免两处漂移（config.py 导入期仅加载 .env，无副作用）
sys.path.insert(0, os.path.join(PROJECT_ROOT, 'webgis_backend'))
try:
    from config import DISASTER_TYPES
except Exception:  # pragma: no cover - 独立环境兜底
    DISASTER_TYPES = [
        ('rainfall_floods', 'PFs_HMA.geojson', '降雨型洪水(PFs)'),
        ('snowmelt_floods', 'SFs_HMA.geojson', '融雪型洪水(SFs)'),
        ('glacial_lake_floods', 'GLOFs_HMA.geojson', '冰湖溃决型洪水(GLOFs)'),
        ('landslide_dam_floods', 'LLOFs_HMA.geojson', '滑坡堰塞湖溃决型洪水(LLOFs)'),
        ('glacier_surging', 'surging_glacier_inventory_gamdam_v2.geojson', '冰川跃动'),
        ('rts_qtp', 'RTS-QTP.geojson', '多年冻土热融滑塌(RTS)'),
        ('avalanche_hazard', '雪崩危害范围.geojson', '雪崩灾害'),
        ('blizzard_hazard', '风吹雪危害范围.geojson', '风吹雪灾害'),
    ]

# ---------------------------------------------------------------- 常量
WGS84_A = 6378137.0
WGS84_B = 6356752.3142451793
WGS84_E2 = 1.0 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A)
RADII = np.array([WGS84_A, WGS84_A, WGS84_B])

AMAP_TILE_URL = ('https://webst0{s}.is.autonavi.com/appmaptile'
                 '?style={style}&x={x}&y={y}&z={z}')


def log(msg):
    print(f'[build_3d_tiles] {msg}', flush=True)


# ================================================================ 瓦片网格
def tile_grid(z):
    """Cesium GeographicTilingScheme / TMS global-geodetic：
     level 0 为 2×1 块瓦片；纬度线性划分（equirectangular）；y 从南数（TMS）。"""
    return 2 * (2 ** z), 2 ** z


def tile_bounds_tms(z, x, y_tms):
    nx, ny = tile_grid(z)
    lon_w = -180.0 + 360.0 * x / nx
    lon_e = -180.0 + 360.0 * (x + 1) / nx
    lat_s = -90.0 + 180.0 * y_tms / ny
    lat_n = -90.0 + 180.0 * (y_tms + 1) / ny
    return lon_w, lat_s, lon_e, lat_n


def tiles_for_bbox(bbox, zmin, zmax, full_level_zero=True):
    """返回覆盖 bbox 的 (z, x, y_tms) 列表。
    full_level_zero=True 时额外生成两个 z0 根瓦片（保证 Cesium 根节点可用）。"""
    west, south, east, north = bbox
    tasks = []
    for z in range(zmin, zmax + 1):
        nx, ny = tile_grid(z)
        x0 = max(0, int((west + 180.0) / 360.0 * nx))
        x1 = min(nx - 1, int((east + 180.0) / 360.0 * nx))
        y0 = max(0, int((south + 90.0) / 180.0 * ny))
        y1 = min(ny - 1, int((north + 90.0) / 180.0 * ny))
        if z == 0 and full_level_zero:
            x0, x1, y0, y1 = 0, 1, 0, 0
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                tasks.append((z, x, y))
    return tasks


# ================================================================ 几何工具
def geodetic_to_ecef(lon_deg, lat_deg, h):
    lon = np.radians(lon_deg)
    lat = np.radians(lat_deg)
    sin_lat = np.sin(lat)
    cos_lat = np.cos(lat)
    N = WGS84_A / np.sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat)
    X = (N + h) * cos_lat * np.cos(lon)
    Y = (N + h) * cos_lat * np.sin(lon)
    Z = (N * (1.0 - WGS84_E2) + h) * sin_lat
    return np.stack([X, Y, Z], axis=-1)


def oct_encode_normals(nx, ny, nz):
    """Cesium AttributeCompression.octEncode：单位法线 → 2×uint8。"""
    l1 = np.abs(nx) + np.abs(ny) + np.abs(nz)
    l1 = np.where(l1 == 0, 1.0, l1)
    x = nx / l1
    y = ny / l1
    neg = nz < 0
    abs_x = np.abs(x)
    abs_y = np.abs(y)
    sign_x = np.where(x >= 0, 1.0, -1.0)
    sign_y = np.where(y >= 0, 1.0, -1.0)
    x2 = np.where(neg, (1.0 - abs_y) * sign_x, x)
    y2 = np.where(neg, (1.0 - abs_x) * sign_y, y)
    xb = np.clip(np.round(x2 * 127.5 + 127.5), 0, 255).astype(np.uint8)
    yb = np.clip(np.round(y2 * 127.5 + 127.5), 0, 255).astype(np.uint8)
    out = np.empty((len(nx), 2), dtype=np.uint8)
    out[:, 0] = xb
    out[:, 1] = yb
    return out


def horizon_occlusion_point(positions):
    """Cesium EllipsoidalOccluder.computeHorizonCullingPoint 的 Python 实现。
    返回椭球缩放空间中的遮挡点；若该点在地平线以下则整个瓦片不可见（用于剔除）。"""
    center = positions.mean(axis=0)
    d = center / RADII
    d = d / np.linalg.norm(d)
    s = positions / RADII
    mag2 = np.sum(s * s, axis=1)
    mag = np.maximum(np.sqrt(mag2), 1e-12)
    direction = s / mag[:, None]
    mag2c = np.maximum(mag2, 1.0)
    magc = np.maximum(mag, 1.0)
    cos_alpha = direction @ d
    sin_alpha = np.linalg.norm(np.cross(direction, d), axis=1)
    cos_beta = 1.0 / magc
    sin_beta = np.sqrt(np.maximum(mag2c - 1.0, 0.0)) * cos_beta
    denom = cos_alpha * cos_beta - sin_alpha * sin_beta
    t = 1.0 / np.where(np.abs(denom) < 1e-12, 1e-12, denom)
    return d * float(np.max(t))


def zigzag(d):
    d = d.astype(np.int64)
    return np.where(d >= 0, d * 2, -d * 2 - 1)


# ================================================================ 编码器
# 单瓦片 DEM 读取窗口的像素上限：超过则按"层级统一"的系数降采样读取。
# 系数按层级的标称瓦片尺寸计算（同层所有瓦片一致），因此相邻瓦片在共享边界
# 仍做完全相同的插值，接缝无缝；同时避免 z0-z6 的超大瓦片把整个 DEM 读进内存。
TARGET_WINDOW_PX = 2_000_000


def encode_tile(z, x, y_tms, grid_n, dem_path, global_min_elev):
    """生成单个 quantized-mesh 瓦片字节；无数据瓦片返回 None。

    dem_path        : 预处理后的 DEM（prefill 产物）
    global_min_elev : 剩余 nodata（掩膜外远场）的常量填充高程
    """
    import rasterio

    lon_w, lat_s, lon_e, lat_n = tile_bounds_tms(z, x, y_tms)
    N = grid_n
    lons = lon_w + (lon_e - lon_w) * (np.arange(N + 1) / N)
    lats = lat_s + (lat_n - lat_s) * (np.arange(N + 1) / N)
    LON, LAT = np.meshgrid(lons, lats)

    with rasterio.open(dem_path) as ds:
        tr = ds.transform
        left, top = tr.c, tr.f
        px_w, px_h = tr.a, -tr.e
        width, height = ds.width, ds.height
        nodata = ds.nodata

        # 按层级统一的降采样系数（同层一致 -> 跨瓦片一致）
        nx, ny = tile_grid(z)
        nominal_px = ((360.0 / nx) / px_w) * ((180.0 / ny) / px_h)
        scale = max(1, int(np.ceil(np.sqrt(nominal_px / TARGET_WINDOW_PX))))
        spx_w, spx_h = px_w * scale, px_h * scale

        # 降采样坐标系下的窗口，四边各留 1px 余量（保证边界插值有邻域）。
        # （不能直接用 rasterio.windows.from_bounds：它会切掉跨界像素所在的半个像素，
        #   导致边界插值取错邻域 —— spike 实测造成 330m 采样偏差。）
        c0 = int(np.floor((lon_w - left) / spx_w)) - 1
        c1 = int(np.ceil((lon_e - left) / spx_w)) + 1
        r0 = int(np.floor((top - lat_n) / spx_h)) - 1
        r1 = int(np.ceil((top - lat_s) / spx_h)) + 1
        w_cells = int(np.ceil(width / scale))
        h_cells = int(np.ceil(height / scale))
        c0 = max(0, c0)
        r0 = max(0, r0)
        c1 = min(w_cells, c1)
        r1 = min(h_cells, r1)

        if c1 <= c0 or r1 <= r0:
            if z != 0:
                return None
            # z0 无数据半球：生成全常量平坦瓦片，保证 Cesium 根节点两块均可用
            HGT = np.full((N + 1, N + 1), global_min_elev, dtype=np.float64)
            min_h = max_h = float(global_min_elev)
            flat = True
        else:
            flat = False
            oc0, oc1 = c0 * scale, min(width, c1 * scale)
            or0, or1 = r0 * scale, min(height, r1 * scale)
            h_arr = ds.read(1, window=((or0, or1), (oc0, oc1)),
                            out_shape=(r1 - r0, c1 - c0))
            if nodata is not None:
                h_arr = np.where(h_arr == nodata, np.nan, h_arr).astype(np.float64)
            else:
                h_arr = h_arr.astype(np.float64)
            nan_mask = np.isnan(h_arr)
            if nan_mask.all():
                return None
            if nan_mask.any():
                # 剩余 nodata（prefill 未覆盖的掩膜外远场）：全域最低高程常量填充。
                # 常量填充跨瓦片天然一致，接缝严格无缝。
                h_arr = np.where(nan_mask, global_min_elev, h_arr)

            # 精确经纬度双线性采样：相邻瓦片在共享边界用完全相同的分数像素坐标，
            # 因此高程严格一致（接缝无缝）。
            col_f = (LON - left) / spx_w - c0
            row_f = (top - LAT) / spx_h - r0
            H, W = h_arr.shape
            cf0 = np.clip(np.floor(col_f).astype(int), 0, W - 1)
            cf1 = np.clip(cf0 + 1, 0, W - 1)
            rf0 = np.clip(np.floor(row_f).astype(int), 0, H - 1)
            rf1 = np.clip(rf0 + 1, 0, H - 1)
            fw = col_f - np.floor(col_f)
            fh = row_f - np.floor(row_f)
            HGT = (h_arr[rf0, cf0] * (1 - fh) * (1 - fw)
                   + h_arr[rf0, cf1] * (1 - fh) * fw
                   + h_arr[rf1, cf0] * fh * (1 - fw)
                   + h_arr[rf1, cf1] * fh * fw)
            min_h = float(np.nanmin(h_arr))
            max_h = float(np.nanmax(h_arr))

    h_range = max_h - min_h
    if h_range < 1e-6:
        h_range = 1.0

    positions = geodetic_to_ecef(LON.ravel(), LAT.ravel(), HGT.ravel())

    u_q = np.round(np.arange(N + 1) / N * 32767).astype(np.int64)
    v_q = np.round(np.arange(N + 1) / N * 32767).astype(np.int64)
    U = np.tile(u_q, (N + 1, 1))            # [j, i]，i 向西→东
    V = np.tile(v_q[:, None], (1, N + 1))   # [j, i]，j 向南→北
    Hq = np.round((HGT - min_h) / h_range * 32767).astype(np.int64)

    idx = np.arange((N + 1) * (N + 1)).reshape(N + 1, N + 1)
    i = np.arange(N)
    j = np.arange(N)
    II, JJ = np.meshgrid(i, j)
    a = idx[JJ, II]
    b = idx[JJ, II + 1]
    c = idx[JJ + 1, II + 1]
    d = idx[JJ + 1, II]
    # CCW（从椭球外部看）
    tris = np.stack([a, b, c, a, c, d], axis=-1).ravel()

    # ---- 顶点按首次出现顺序重排，使 high-water-mark 编码的 code 恒非负 ----
    # relabel: 原索引 -> 新索引；inv = argsort(relabel): 新顺序 -> 原索引
    uniq, first_idx = np.unique(tris, return_index=True)
    relabel = np.empty(len(positions), dtype=np.int64)
    relabel[uniq[np.argsort(first_idx)]] = np.arange(len(uniq))
    inv = np.argsort(relabel)
    tris_r = relabel[tris]

    # ---- high-water-mark 编码（全向量化）----
    is_first = np.zeros(len(tris_r), dtype=np.int64)
    is_first[np.unique(tris_r, return_index=True)[1]] = 1
    highest = np.concatenate([[0], np.cumsum(is_first)[:-1]])
    codes = highest - tris_r          # 恒 >= 0
    assert codes.min() >= 0

    edge_west = relabel[idx[:, 0]]
    edge_south = relabel[idx[0, :]]
    edge_east = relabel[idx[:, N]]
    edge_north = relabel[idx[N, :]]

    # ---- 顶点法线（由高程梯度计算 ENU 法线后 oct 编码），按重排后顺序存放 ----
    de = (lon_e - lon_w) * np.cos(np.radians((lat_s + lat_n) / 2)) * 111320.0 / N
    dn = (lat_n - lat_s) * 110540.0 / N
    dhde = np.zeros_like(HGT)
    dhdn = np.zeros_like(HGT)
    dhde[:, 1:-1] = (HGT[:, 2:] - HGT[:, :-2]) / (2 * de)
    dhde[:, 0] = (HGT[:, 1] - HGT[:, 0]) / de
    dhde[:, -1] = (HGT[:, -1] - HGT[:, -2]) / de
    dhdn[1:-1, :] = (HGT[2:, :] - HGT[:-2, :]) / (2 * dn)
    dhdn[0, :] = (HGT[1, :] - HGT[0, :]) / dn
    dhdn[-1, :] = (HGT[-1, :] - HGT[-2, :]) / dn
    normals = oct_encode_normals((-dhde).ravel(), (-dhdn).ravel(),
                                 np.ones(HGT.size))

    # 顶点重排：新顺序数组[j] = 原顺序数组[inv[j]]
    u_flat = U.ravel()[inv]
    v_flat = V.ravel()[inv]
    h_flat = Hq.ravel()[inv]
    normals = normals[inv]

    center = positions.mean(axis=0)
    bs_center = (positions.min(axis=0) + positions.max(axis=0)) / 2.0
    bs_radius = float(np.max(np.linalg.norm(positions - bs_center, axis=1)))
    hop = horizon_occlusion_point(positions)

    use32 = len(positions) > 65536
    buf = bytearray()
    buf += struct.pack('<3d', *center)
    buf += struct.pack('<2f', min_h, max_h)
    buf += struct.pack('<3d', *bs_center)
    buf += struct.pack('<d', bs_radius)
    buf += struct.pack('<3d', *hop)
    buf += struct.pack('<I', len(positions))
    # 首元素为绝对值（增量序列 prepend=0），后续为 zigzag 增量
    buf += zigzag(np.diff(u_flat, prepend=0)).astype('<u2').tobytes()
    buf += zigzag(np.diff(v_flat, prepend=0)).astype('<u2').tobytes()
    buf += zigzag(np.diff(h_flat, prepend=0)).astype('<u2').tobytes()
    align = 4 if use32 else 2
    while len(buf) % align != 0:
        buf += b'\x00'
    buf += struct.pack('<I', len(codes) // 3)
    buf += codes.astype('<u4' if use32 else '<u2').tobytes()
    for edge in (edge_west, edge_south, edge_east, edge_north):
        arr = edge.astype('<u4' if use32 else '<u2')
        buf += struct.pack('<I', len(arr))
        buf += arr.tobytes()
    nb = normals.tobytes()
    buf += struct.pack('<BI', 1, len(nb))
    buf += nb
    return bytes(buf)


# ---- multiprocessing worker ----
_W = {}


def _worker_init(dem_path, global_min_elev, grid_n, out_dir):
    _W['dem_path'] = dem_path
    _W['global_min_elev'] = global_min_elev
    _W['grid_n'] = grid_n
    _W['out_dir'] = out_dir


def _worker(task):
    z, x, y = task
    path = os.path.join(_W['out_dir'], str(z), str(x), f'{y}.terrain')
    if os.path.exists(path):
        return None
    try:
        data = encode_tile(z, x, y, _W['grid_n'], _W['dem_path'],
                           _W['global_min_elev'])
    except Exception as e:  # 单瓦片失败不中断整批
        return ('error', z, x, y, repr(e))
    if data is None:
        return None
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)
    return ('ok', z, x, y, len(data))


# ================================================================ layer.json
def build_available(out_dir, zmin, zmax, max_rects=1500):
    """扫描已生成瓦片，按层级生成 TileJSON availability 矩形（超出上限则粗粒度合并）。"""
    available = []
    for z in range(zmin, zmax + 1):
        zdir = os.path.join(out_dir, str(z))
        if not os.path.isdir(zdir):
            available.append([])
            continue
        tiles = set()
        for xname in os.listdir(zdir):
            xd = os.path.join(zdir, xname)
            if not os.path.isdir(xd):
                continue
            for fn in os.listdir(xd):
                if fn.endswith('.terrain'):
                    tiles.add((int(xname), int(fn[:-len('.terrain')])))
        if not tiles:
            available.append([])
            continue
        rects = []
        by_y = {}
        for (x, y) in tiles:
            by_y.setdefault(y, []).append(x)
        for y, xs in sorted(by_y.items()):
            xs.sort()
            start = prev = xs[0]
            for x in xs[1:]:
                if x == prev + 1:
                    prev = x
                    continue
                rects.append({'startX': start, 'startY': y, 'endX': prev, 'endY': y})
                start = prev = x
            rects.append({'startX': start, 'startY': y, 'endX': prev, 'endY': y})
        merged = _merge_rects(rects)
        while len(merged) > max_rects:
            merged = _coarsen_rects(merged)
        available.append(merged)
    return available


def _merge_rects(rects):
    """把 startX/endX 相同且 startY/endY 相邻的矩形合并。"""
    rects = sorted(rects, key=lambda r: (r['startX'], r['endX'], r['startY']))
    out = []
    for r in rects:
        if out:
            last = out[-1]
            if (last['startX'] == r['startX'] and last['endX'] == r['endX']
                    and r['startY'] == last['endY'] + 1):
                last['endY'] = r['endY']
                continue
        out.append(dict(r))
    return out


def _coarsen_rects(rects):
    """2x2 粗粒度合并（允许略微超报可用性，Cesium 对缺失瓦片按父级兜底）。"""
    seen = {}
    for r in rects:
        key = (r['startX'] // 2, r['endX'] // 2, r['startY'] // 2, r['endY'] // 2)
        if key in seen:
            s = seen[key]
            s['startX'] = min(s['startX'], r['startX'])
            s['endX'] = max(s['endX'], r['endX'])
            s['startY'] = min(s['startY'], r['startY'])
            s['endY'] = max(s['endY'], r['endY'])
        else:
            seen[key] = dict(r)
    return _merge_rects(list(seen.values()))


def write_layer_json(out_dir, region, zmin, zmax, bounds, max_rects=1500):
    available = build_available(out_dir, zmin, zmax, max_rects=max_rects)
    layer = {
        'name': f'{region} terrain',
        'format': 'quantized-mesh-1.0',
        'version': '1.0.0',
        'scheme': 'tms',
        'projection': 'EPSG:4326',
        'tiles': ['{z}/{x}/{y}.terrain'],
        'bounds': [round(b, 6) for b in bounds],
        'minzoom': zmin,
        'maxzoom': zmax,
        'available': available,
        'extensions': ['octvertexnormals'],
        'attribution': 'DEM: 项目数据区 TP_China_dem_cog.tif（约90m，SRT 源，含空洞回填痕迹）',
    }
    path = os.path.join(out_dir, 'layer.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(layer, f, ensure_ascii=False)
    total = sum(len(a) for a in available)
    log(f'layer.json written: {path} (available rects total={total})')
    return path


def update_manifest(region_id, name, bounds, zmin, zmax, layers,
                    imagery=None, camera=None, exclusive=False, mask=None):
    os.makedirs(SCENE3D_DIR, exist_ok=True)
    manifest = {'version': 1, 'regions': []}
    if os.path.isfile(MANIFEST_PATH):
        with open(MANIFEST_PATH, encoding='utf-8') as f:
            manifest = json.load(f)
    if imagery is None:
        imagery = {
            'type': 'amap-satellite-online',
            'url': 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
            'subdomains': ['1', '2', '3', '4'],
            'maxZoom': 16,
        }
    if camera is None:
        camera = {'height': 1000000, 'pitch': -40, 'heading': 0}
    entry = {
        'id': region_id,
        'name': name,
        'bbox': [round(b, 6) for b in bounds],
        'center': [round((bounds[0] + bounds[2]) / 2, 6),
                   round((bounds[1] + bounds[3]) / 2, 6)],
        'minZoom': zmin,
        'maxZoom': zmax,
        'terrain': {
            'type': 'quantized-mesh',
            'url': f'/tiles3d/{region_id}/terrain',
            'layerJson': f'/tiles3d/{region_id}/terrain/layer.json',
        },
        'imagery': imagery,
        'layers': layers,
        'camera': camera,
        # mask=True 时前端用研究区边界把区域外遮成深色底（适合全域型区域）；
        # 子区域（数据本身已裁剪）设为 False，避免遮罩孔与实际范围不符
        'mask': (True if mask is None else bool(mask)),
    }
    if exclusive:
        regions = [entry]
    else:
        regions = [r for r in manifest.get('regions', []) if r.get('id') != region_id]
        regions.append(entry)
    manifest['regions'] = regions
    with open(MANIFEST_PATH, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    log(f'manifest updated: {MANIFEST_PATH} (region={region_id}, '
        f'exclusive={exclusive})')


DEFAULT_LAYERS = [
    # 注 1：冰川层暂不启用——全域 5.5 万条冰川即使简化到 0.002° 仍有 58MB，
    #       浏览器端解析会造成明显卡顿。原始简化产物保留在 vectors/glaciers.geojson，
    #       需要时在 regions.json 的 layers 里加回一条（或改这里后重跑 layer-json）即可。
    # 注 2：多年冻土 12534 个多边形贴地形分类渲染开销大（集显机器明显掉帧），
    #       默认关闭，侧栏可随时勾选打开。
    {'name': 'permafrost', 'title': '多年冻土（较重）', 'kind': 'fill',
     'defaultOn': False, 'color': '#d8b56d'},
    {'name': 'rivers', 'title': '河网水系', 'kind': 'line', 'defaultOn': True,
     'color': '#4aa3ff'},
    {'name': 'lakes', 'title': '湖泊', 'kind': 'fill', 'defaultOn': True,
     'color': '#3b82c4'},
    {'name': 'disasters', 'title': '灾害事件', 'kind': 'point', 'defaultOn': True,
     'color': '#ff6b6b'},
    {'name': 'boundary', 'title': '研究区边界', 'kind': 'line', 'defaultOn': True,
     'color': '#ffd166'},
]


# ================================================================ 晕渲影像瓦片
def mercator_tile_bounds(z, x, y):
    """Web Mercator XYZ 瓦片地理范围（y 自北向南，与 Cesium 影像默认 tiling scheme 一致）。"""
    n = 2.0 ** z
    lon_w = x / n * 360.0 - 180.0
    lon_e = (x + 1) / n * 360.0 - 180.0
    lat_n = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_s = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return lon_w, lat_s, lon_e, lat_n


def hillshade_array(elev, res_x_m, res_y_m, azimuth=315.0, altitude=45.0,
                    z_factor=1.2, lo=40, hi=235):
    """标准晕渲（ESRI 公式）：elev 行序为北→南，返回 uint8 灰阶。

    输出拉伸到 [lo, hi] 而非满幅 0-255：三维场景里还会叠加一层日照光照，
    留出余量避免整体压暗。
    """
    dz_row, dz_col = np.gradient(elev, res_y_m, res_x_m)
    dz_north = -dz_row          # 行号增大向南，故北向分量为负
    dz_east = dz_col
    slope = np.arctan(z_factor * np.hypot(dz_east, dz_north))
    aspect = np.arctan2(-dz_east, -dz_north)   # 最陡下降方向（自北顺时针）
    zen = np.radians(90.0 - altitude)
    az = np.radians(azimuth)
    hs = (np.cos(zen) * np.cos(slope)
          + np.sin(zen) * np.sin(slope) * np.cos(az - aspect))
    hs = np.clip(hs, 0.0, 1.0)
    return (lo + hs * (hi - lo)).astype(np.uint8)


def cmd_hillshade(args):
    """由 DEM 生成灰阶晕渲瓦片（Web Mercator XYZ），作为三维场景影像底图。

    不依赖任何在线影像服务：光照由 DEM 高程直接计算，
    方位 315° / 高度角 45° / 垂直夸张 z-factor 可调。

    关键处理：原 DEM 无数据处（prefill 用最近邻填过）在晕渲里会呈现出
    放射状"楔形"势力范围伪影，故对这些像元先做高斯平滑再算梯度。
    """
    import rasterio
    import scipy.ndimage as ndi
    from PIL import Image

    west, south, east, north = args.bbox
    zmin, zmax = args.zoom
    out_dir = os.path.join(SCENE3D_DIR, args.region, 'imagery')
    os.makedirs(out_dir, exist_ok=True)
    size = args.size

    tasks = []
    for z in range(zmin, zmax + 1):
        n = 2 ** z
        x0 = int((west + 180.0) / 360.0 * n)
        x1 = int((east + 180.0) / 360.0 * n)
        lat_n = math.radians(north)
        lat_s = math.radians(south)
        y0 = int((1.0 - math.log(math.tan(lat_n) + 1.0 / math.cos(lat_n))
                  / math.pi) / 2.0 * n)
        y1 = int((1.0 - math.log(math.tan(lat_s) + 1.0 / math.cos(lat_s))
                  / math.pi) / 2.0 * n)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                tasks.append((z, x, y))
    log(f'hillshade: bbox={args.bbox} zoom={zmin}-{zmax} '
        f'tiles={len(tasks)} size={size} -> {out_dir}')

    t0 = time.time()
    made = 0
    raw_ok = os.path.isfile(args.dem_raw)
    ds_raw = rasterio.open(args.dem_raw) if raw_ok else None
    try:
        with rasterio.open(args.dem) as ds:
            tr = ds.transform
            left, top = tr.c, tr.f
            px_w, px_h = tr.a, -tr.e
            nodata = ds.nodata
            for k, (z, x, y) in enumerate(tasks):
                lon_w, lat_s_, lon_e, lat_n_ = mercator_tile_bounds(z, x, y)
                # 四边各多取 1 源像素，算完梯度后裁掉，避免边缘亮度断裂
                c0 = int(np.floor((lon_w - left) / px_w)) - 1
                c1 = int(np.ceil((lon_e - left) / px_w)) + 1
                r0 = int(np.floor((top - lat_n_) / px_h)) - 1
                r1 = int(np.ceil((top - lat_s_) / px_h)) + 1
                c0 = max(0, c0)
                r0 = max(0, r0)
                c1 = min(ds.width, c1)
                r1 = min(ds.height, r1)
                if c1 <= c0 or r1 <= r0:
                    continue
                n2 = size + 2
                win = ((r0, r1), (c0, c1))
                arr = ds.read(1, window=win,
                              out_shape=(n2, n2)).astype(np.float64)
                if nodata is not None:
                    arr = np.where(arr == nodata, np.nan, arr)
                if np.isnan(arr).all():
                    continue
                if np.isnan(arr).any():
                    arr = np.where(np.isnan(arr), np.nanmean(arr), arr)
                # 原始 DEM 无数据处 = prefill 填出来的，平滑掉楔形伪影
                if ds_raw is not None and ds_raw.nodata is not None:
                    raw = ds_raw.read(1, window=win, out_shape=(n2, n2))
                    filled = (raw == ds_raw.nodata)
                    if filled.any():
                        arr = np.where(filled, ndi.gaussian_filter(arr, 4.0), arr)
                res_x = ((lon_e - lon_w) / size * 111320.0
                         * math.cos(math.radians((lat_s_ + lat_n_) / 2)))
                res_y = (lat_n_ - lat_s_) / size * 110540.0
                hs = hillshade_array(arr, res_x, res_y,
                                     args.azimuth, args.altitude, args.z_factor)
                img = hs[1:-1, 1:-1]
                path = os.path.join(out_dir, str(z), str(x), f'{y}.png')
                os.makedirs(os.path.dirname(path), exist_ok=True)
                Image.fromarray(img, mode='L').save(path, optimize=True)
                made += 1
                if made % 200 == 0:
                    log(f'  {made}/{len(tasks)} ({time.time() - t0:.0f}s)')
    finally:
        if ds_raw is not None:
            ds_raw.close()
    log(f'hillshade done: {made} tiles in {time.time() - t0:.0f}s')


# ================================================================ 子命令
def cmd_prefill(args):
    import rasterio
    from scipy.ndimage import distance_transform_edt

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with rasterio.open(args.dem) as ds:
        nodata = ds.nodata
        H, W = ds.height, ds.width
        profile = dict(ds.profile)
        profile.update(tiled=True, blockxsize=256, blockysize=256,
                       compress='deflate')
        log(f'prefill: {args.dem} -> {args.out} '
            f'({W}x{H}, nodata={nodata}, max_dist={args.max_dist}px, '
            f'band={args.band}, margin={args.margin})')
        t0 = time.time()
        filled_total = 0
        with rasterio.open(args.out, 'w', **profile) as dst:
            r = 0
            while r < H:
                r1 = min(H, r + args.band)
                rr0 = max(0, r - args.margin)
                rr1 = min(H, r1 + args.margin)
                arr = ds.read(1, window=((rr0, rr1), (0, W)))
                mask = (arr == nodata) if nodata is not None else np.zeros(arr.shape, bool)
                if mask.any():
                    dist, ind = distance_transform_edt(
                        mask, return_distances=True, return_indices=True)
                    ok = (dist <= args.max_dist) & mask
                    filled_total += int(ok.sum())
                    arr = np.where(ok, arr[tuple(ind)], arr)
                dst.write(arr[r - rr0:r1 - rr0, :], 1,
                          window=((r, r1), (0, W)))
                r = r1
                log(f'  rows {r}/{H}  filled={filled_total}  '
                    f'elapsed={time.time() - t0:.0f}s')
                del arr, mask
                gc.collect()
    log(f'prefill done: filled {filled_total} px in {time.time() - t0:.0f}s')


def cmd_terrain(args):
    import rasterio

    zmin, zmax = args.zoom
    with rasterio.open(args.dem) as ds:
        if args.bbox:
            bounds = list(args.bbox)
        else:
            bounds = [ds.bounds.left, ds.bounds.bottom,
                      ds.bounds.right, ds.bounds.top]
        nodata = ds.nodata
        sub = ds.read(1, out_shape=(ds.height // 20 + 1, ds.width // 20 + 1))
        valid = sub[sub != nodata] if nodata is not None else sub
        global_min_elev = float(valid.min())
        del sub, valid
        gc.collect()

    region_dir = os.path.join(SCENE3D_DIR, args.region)
    out_dir = os.path.join(region_dir, 'terrain')
    os.makedirs(out_dir, exist_ok=True)

    tasks = tiles_for_bbox(bounds, zmin, zmax)
    log(f'terrain: region={args.region} zoom={zmin}-{zmax} grid={args.grid} '
        f'jobs={args.jobs} tasks={len(tasks)} dem={args.dem} '
        f'global_min_elev={global_min_elev:.0f}')
    t0 = time.time()
    done = ok = skipped = 0
    errors = []
    with Pool(processes=args.jobs, initializer=_worker_init,
              initargs=(args.dem, global_min_elev, args.grid, out_dir)) as pool:
        for res in pool.imap_unordered(_worker, tasks, chunksize=8):
            done += 1
            if res is None:
                skipped += 1
            elif res[0] == 'ok':
                ok += 1
            else:
                errors.append(res)
            if done % 5000 == 0:
                rate = done / (time.time() - t0)
                log(f'  {done}/{len(tasks)} ok={ok} skip={skipped} '
                    f'err={len(errors)} {rate:.0f} tiles/s')
    dt = time.time() - t0
    log(f'terrain done: ok={ok} skipped(nodata/existing)={skipped} '
        f'errors={len(errors)} in {dt:.0f}s ({done / dt:.0f} tiles/s)')
    if errors:
        for e in errors[:10]:
            log(f'  ERROR {e}')
        if len(errors) > 10:
            log(f'  ... and {len(errors) - 10} more')
    write_layer_json(out_dir, args.region, zmin, zmax, bounds)
    update_manifest(args.region, args.name, bounds, zmin, zmax, DEFAULT_LAYERS)


def cmd_vectors(args):
    import geopandas as gpd
    import pandas as pd
    from shapely import set_precision

    out_dir = os.path.join(SCENE3D_DIR, args.region, 'vectors')
    os.makedirs(out_dir, exist_ok=True)
    src = args.src

    def simplify_write(gdf, name, tol, precision=1e-5):
        t0 = time.time()
        gdf = gdf.copy()
        if args.bbox:
            from shapely.geometry import box as _box
            gdf = gdf.clip(_box(*args.bbox))
        if tol > 0:
            gdf['geometry'] = gdf.geometry.simplify(tol, preserve_topology=True)
        if precision > 0:
            gdf['geometry'] = gdf.geometry.apply(
                lambda g: set_precision(g, precision) if g is not None else g)
        out = os.path.join(out_dir, f'{name}.geojson')
        # 先写唯一临时文件再 os.replace 覆盖：OGR 覆盖写会先删除旧文件，
        # 本机沙箱的安全删除钩子对含特殊字符（U+2011）的路径会失败，
        # 故改用原子替换（与地形瓦片写入同一策略）。
        tmp = os.path.join(out_dir, f'.{name}.{os.getpid()}.tmp.geojson')
        if os.path.exists(tmp):
            os.replace(tmp, os.path.join(out_dir, f'.{name}.{os.getpid()}.stale'))
        gdf.to_file(tmp, driver='GeoJSON')
        os.replace(tmp, out)
        sz = os.path.getsize(out) / 1e6
        log(f'  {name}: {len(gdf)} features -> {sz:.1f}MB ({time.time() - t0:.0f}s)')

    log(f'vectors: src={src} -> {out_dir}')

    gdf = gpd.read_file(os.path.join(src, 'cryosphere', 'TP_China_glaciers.geojson'))
    simplify_write(gdf, 'glaciers', args.glacier_tol,
                   precision=args.glacier_precision)

    gdf = gpd.read_file(os.path.join(src, 'hydrology', 'TP_China_Lake.geojson'))
    simplify_write(gdf, 'lakes', args.lake_tol)

    gdf = gpd.read_file(os.path.join(src, 'cryosphere', 'TP_China_permafrost.geojson'))
    simplify_write(gdf, 'permafrost', args.default_tol)

    gdf = gpd.read_file(os.path.join(src, 'hydrology', 'TP_rivers.geojson'))
    simplify_write(gdf, 'rivers', args.river_tol)

    gdf = gpd.read_file(os.path.join(src, 'boundary', 'TP_China.geojson'))
    simplify_write(gdf, 'boundary', 0)

    # 8 类灾害合并为一个图层（保留 type/type_name 供前端过滤与配色）
    parts = []
    for key, fname, cname in DISASTER_TYPES:
        p = os.path.join(src, 'disaster', fname)
        if not os.path.isfile(p):
            log(f'  WARN disaster file missing: {fname}')
            continue
        g = gpd.read_file(p)
        g['type'] = key
        g['type_name'] = cname
        parts.append(g)
    if parts:
        disasters = gpd.GeoDataFrame(
            pd.concat(parts, ignore_index=True), crs=parts[0].crs)
        simplify_write(disasters, 'disasters', args.default_tol)


def cmd_cache_imagery(args):
    west, south, east, north = args.bbox
    zmin, zmax = args.zoom
    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)
    style = args.style
    tasks = []
    for z in range(zmin, zmax + 1):
        nx, ny = tile_grid(z)
        x0 = max(0, int((west + 180) / 360 * nx))
        x1 = min(nx - 1, int((east + 180) / 360 * nx))
        y0 = max(0, int((south + 90) / 180 * ny))
        y1 = min(ny - 1, int((north + 90) / 180 * ny))
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                tasks.append((z, x, y))
    log(f'cache-imagery: bbox={args.bbox} zoom={zmin}-{zmax} '
        f'tiles={len(tasks)} -> {out_dir}')

    def fetch(t):
        z, x, y = t
        path = os.path.join(out_dir, str(z), str(x), f'{y}.png')
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return None
        for attempt in range(3):
            sub = str((x + y + attempt) % 4 + 1)
            url = AMAP_TILE_URL.format(s=sub, style=style, x=x, y=y, z=z)
            try:
                req = urllib.request.Request(
                    url, headers={'User-Agent': 'Mozilla/5.0'})
                with urllib.request.urlopen(req, timeout=15) as r:
                    data = r.read()
                if len(data) < 100:
                    raise ValueError(f'suspicious tile size {len(data)}')
                os.makedirs(os.path.dirname(path), exist_ok=True)
                tmp = path + '.tmp'
                with open(tmp, 'wb') as f:
                    f.write(data)
                os.replace(tmp, path)
                return ('ok', len(data))
            except Exception as e:
                if attempt == 2:
                    return ('fail', z, x, y, repr(e))
        return None

    t0 = time.time()
    done = ok = fail = 0
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for res in ex.map(fetch, tasks):
            done += 1
            if res and res[0] == 'ok':
                ok += 1
            elif res:
                fail += 1
                if fail <= 5:
                    log(f'  FAIL {res}')
            if done % 2000 == 0:
                log(f'  {done}/{len(tasks)} ok={ok} fail={fail} '
                    f'{done / (time.time() - t0):.0f} tiles/s')
    log(f'cache-imagery done: ok={ok} fail={fail} in {time.time() - t0:.0f}s')


def cmd_layer_json(args):
    """仅根据已生成的瓦片写 layer.json 与区域注册表（不生成任何瓦片）。

    用于：地形生成中断后收尾、切换影像来源、或手工调整图层清单后刷新元数据。
    """
    import rasterio

    out_dir = os.path.join(SCENE3D_DIR, args.region, 'terrain')
    if not os.path.isdir(out_dir):
        raise SystemExit(f'地形目录不存在：{out_dir}（请先运行 terrain 子命令）')
    levels = sorted(int(d) for d in os.listdir(out_dir) if d.isdigit())
    if not levels:
        raise SystemExit(f'未找到任何地形瓦片：{out_dir}')
    zmin, zmax = levels[0], levels[-1]
    with rasterio.open(args.dem) as ds:
        if args.bbox:
            bounds = list(args.bbox)
        else:
            bounds = [ds.bounds.left, ds.bounds.bottom,
                      ds.bounds.right, ds.bounds.top]
    write_layer_json(out_dir, args.region, zmin, zmax, bounds,
                     max_rects=args.max_rects)

    imagery = None
    if args.imagery == 'hillshade':
        im_dir = os.path.join(SCENE3D_DIR, args.region, 'imagery')
        im_levels = (sorted(int(d) for d in os.listdir(im_dir) if d.isdigit())
                     if os.path.isdir(im_dir) else [])
        im_max = args.imagery_maxzoom or (im_levels[-1] if im_levels else zmax)
        imagery = {
            'type': 'local-hillshade',
            'url': f'/tiles3d/{args.region}/imagery/{{z}}/{{x}}/{{y}}.png',
            'maxZoom': im_max,
        }
    camera = {'height': args.camera_height, 'pitch': args.camera_pitch,
              'heading': 0}
    update_manifest(args.region, args.name, bounds, zmin, zmax, DEFAULT_LAYERS,
                    imagery=imagery, camera=camera, exclusive=args.exclusive,
                    mask=(args.bbox is None))


# ================================================================ CLI
def parse_zoom(s):
    a, b = s.split('-')
    return int(a), int(b)


def parse_bbox(s):
    """'84,26,90,30' -> [84.0, 26.0, 90.0, 30.0]（west, south, east, north）"""
    parts = [float(v) for v in s.split(',')]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError('bbox 需为 west,south,east,north 四个数')
    return parts


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('prefill', help='全域 DEM nodata 确定性填充')
    p.add_argument('--dem', default=DEM_DEFAULT)
    p.add_argument('--out', default=PREFILL_DEFAULT)
    p.add_argument('--max-dist', type=int, default=400,
                   help='最大搜索距离（像素，90m DEM 下 400px≈36km）')
    p.add_argument('--band', type=int, default=1500, help='每带行数')
    p.add_argument('--margin', type=int, default=450,
                   help='带间重叠行数（须 >= max-dist 保证跨带一致）')
    p.set_defaults(func=cmd_prefill)

    p = sub.add_parser('terrain', help='生成 quantized-mesh 地形瓦片')
    p.add_argument('--region', default='tp_full')
    p.add_argument('--name', default='青藏高原全域三维地形')
    p.add_argument('--dem', default=PREFILL_DEFAULT)
    p.add_argument('--bbox', type=parse_bbox, default=None,
                   help='区域范围 west,south,east,north；缺省用 DEM 全幅')
    p.add_argument('--zoom', type=parse_zoom, default='0-12')
    p.add_argument('--grid', type=int, default=32, help='每瓦片网格数（33x33 顶点）')
    p.add_argument('--jobs', type=int, default=8)
    p.set_defaults(func=cmd_terrain)

    p = sub.add_parser('hillshade', help='由 DEM 生成灰阶晕渲影像瓦片（本地、离线）')
    p.add_argument('--region', required=True)
    p.add_argument('--bbox', type=parse_bbox, required=True)
    p.add_argument('--zoom', type=parse_zoom, default='7-11')
    p.add_argument('--dem', default=PREFILL_DEFAULT)
    p.add_argument('--dem-raw', default=DEM_DEFAULT,
                   help='原始 DEM（用于识别填充区并平滑，消除楔形伪影）')
    p.add_argument('--size', type=int, default=256, help='瓦片像素（256 为标准）')
    p.add_argument('--azimuth', type=float, default=315.0, help='光照方位角（度）')
    p.add_argument('--altitude', type=float, default=45.0, help='光照高度角（度）')
    p.add_argument('--z-factor', type=float, default=1.2, help='垂直夸张（晕渲对比）')
    p.set_defaults(func=cmd_hillshade)

    p = sub.add_parser('layer-json', help='仅根据已生成瓦片刷新 layer.json 与区域注册表')
    p.add_argument('--region', default='tp_full')
    p.add_argument('--name', default='青藏高原全域三维地形')
    p.add_argument('--dem', default=PREFILL_DEFAULT)
    p.add_argument('--bbox', type=parse_bbox, default=None)
    p.add_argument('--imagery', choices=['amap', 'hillshade'], default='amap',
                   help='影像底图：amap=高德在线，hillshade=本地晕渲瓦片')
    p.add_argument('--imagery-maxzoom', type=int, default=0)
    p.add_argument('--camera-height', type=float, default=1000000)
    p.add_argument('--camera-pitch', type=float, default=-40)
    p.add_argument('--exclusive', action='store_true',
                   help='注册表只保留本区域（其余区域从清单移除，数据文件不动）')
    p.add_argument('--max-rects', type=int, default=1500,
                   help='每层 availability 矩形上限（超出则粗粒度合并，可能略微超报）')
    p.set_defaults(func=cmd_layer_json)

    p = sub.add_parser('vectors', help='矢量简化')
    p.add_argument('--region', default='tp_full')
    p.add_argument('--src', default=GEO_RAW_DIR)
    p.add_argument('--glacier-tol', type=float, default=0.002,
                   help='冰川简化容差（度）；全域视角下 0.002≈220m 足够，'
                        '且远低于地形瓦片精度（z12≈2km）')
    p.add_argument('--glacier-precision', type=float, default=1e-4,
                   help='冰川坐标量化精度（度）；1e-4≈11m，显著压缩体积')
    p.add_argument('--lake-tol', type=float, default=0.0005)
    p.add_argument('--river-tol', type=float, default=0.0002)
    p.add_argument('--default-tol', type=float, default=0.001)
    p.set_defaults(func=cmd_vectors)

    p = sub.add_parser('cache-imagery', help='高德卫星瓦片本地缓存（可选）')
    p.add_argument('--bbox', default='85,27.5,86.5,29')
    p.add_argument('--zoom', type=parse_zoom, default='8-14')
    p.add_argument('--out', default=os.path.join(SCENE3D_DIR, 'imagery_cache'))
    p.add_argument('--style', type=int, default=6, help='高德 style：6=卫星')
    p.add_argument('--jobs', type=int, default=4)
    p.set_defaults(func=cmd_cache_imagery)

    args = ap.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
