#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键生成 Three.js 单页三维地形（Terrarium 高程 + Esri 影像 / 本地晕渲）。

思路（参考 geo-3d-terrain-skill 的做法，适配本项目：EPSG:4326 输入、纯静态页面）：
  1. 高程：AWS 公开的 Terrarium 瓦片（全球覆盖、服务端已填洞、无需密钥）
  2. 影像：Esri World Imagery 瓦片（公开、无需密钥，使用时需按 Esri 要求署名）
     同时由高程再生成一张灰阶晕渲图，页面可离线切换
  3. 输出：height.bin（int16 高度场）+ texture.jpg（卫星）+ texture_hillshade.jpg
     + meta.json，由 webgis_frontend/terrain3d.html 渲染（three.js 单页）

用法：
  python scripts/build_terrain_page.py --place himalaya
  python scripts/build_terrain_page.py --bbox 85.5,27.2,88.5,29.2 --zoom 11 --mesh 600

为什么不走 Cesium/quantized-mesh：
  单块地形不需要瓦片体系与 LOD，Three.js 一块网格 + 一张贴图即可，
  没有瓦片金字塔、没有相机/LOD 配置、没有接缝问题，数据量也只有几 MB。
"""
import argparse
import io
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..'))

TERRARIUM_URL = ('https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
                 '/{z}/{x}/{y}.png')
ESRI_URL = ('https://server.arcgisonline.com/ArcGIS/rest/services/'
            'World_Imagery/MapServer/tile/{z}/{y}/{x}')

TILE = 256
CACHE_DIR = os.path.join(PROJECT_ROOT, 'data', 'processed', '3d', 'tile_cache')
OUT_ROOT = os.path.join(PROJECT_ROOT, 'webgis_frontend', 'terrain3d')
BASIN_PATH = os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo', 'hydrology',
                          'TP_basins.geojson')

# 预设区域（不加 --bbox 时用）
PLACES = {
    'himalaya': {
        'name': '喜马拉雅 · 珠峰段',
        'bbox': (85.5, 27.2, 88.5, 29.2),
    },
    'everest': {
        'name': '珠穆朗玛峰周边',
        'bbox': (86.3, 27.4, 87.7, 28.6),
    },
}

# 地标（用于页面上打点标注）
PEAKS = [
    ('珠穆朗玛峰', 86.9250, 27.9881, 8848.9),
    ('洛子峰', 86.9330, 27.9617, 8516.0),
    ('马卡鲁峰', 87.0889, 27.8897, 8485.0),
    ('卓奥友峰', 86.6608, 28.0942, 8188.0),
    ('希夏邦马峰', 85.7792, 28.3525, 8027.0),
    ('卓木拉日', 89.0, 27.83, 7314.0),
]


def log(msg):
    print(f'[build_terrain_page] {msg}', flush=True)


# ---------------------------------------------------------------- 墨卡托换算
def lonlat_to_tile_xy(lon, lat, z):
    """经纬度 -> 连续瓦片坐标（Web Mercator XYZ）"""
    n = float(2 ** z)
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) \
        / 2.0 * n
    return x, y


def tile_span(bbox, z):
    """返回覆盖 bbox 的整瓦片范围 (x0, y0, x1, y1)"""
    x0f, y0f = lonlat_to_tile_xy(bbox[0], bbox[3], z)   # 西北角
    x1f, y1f = lonlat_to_tile_xy(bbox[2], bbox[1], z)   # 东南角
    return int(math.floor(x0f)), int(math.floor(y0f)), \
        int(math.floor(x1f)), int(math.floor(y1f))


# ---------------------------------------------------------------- 瓦片下载
def _cache_path(kind, z, x, y):
    ext = 'png'
    return os.path.join(CACHE_DIR, kind, str(z), str(x), f'{y}.{ext}')


def fetch_tile(kind, z, x, y, retries=3, timeout=25):
    """下载并缓存单块瓦片；返回原始字节（失败返回 None）。"""
    path = _cache_path(kind, z, x, y)
    if os.path.isfile(path) and os.path.getsize(path) > 200:
        with open(path, 'rb') as f:
            return f.read()
    url = (TERRARIUM_URL if kind == 'elev' else ESRI_URL).format(z=z, x=x, y=y)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
            if len(data) < 200:
                raise ValueError(f'tile too small ({len(data)}B)')
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + f'.{os.getpid()}.tmp'
            with open(tmp, 'wb') as f:
                f.write(data)
            os.replace(tmp, path)
            return data
        except Exception as e:
            if attempt == retries - 1:
                log(f'  WARN {kind} {z}/{x}/{y} 下载失败: {e}')
                return None
            time.sleep(1.0 + attempt)


def build_mosaic(bbox, z, kind, jobs=8, decode='elev'):
    """把覆盖 bbox 的瓦片拼成一张大图，返回 (数组, x0, y0)。"""
    x0, y0, x1, y1 = tile_span(bbox, z)
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    log(f'{kind}: 瓦片范围 x {x0}-{x1} ({nx}), y {y0}-{y1} ({ny}) '
        f'共 {nx * ny} 块')
    tasks = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]

    if decode == 'elev':
        mosaic = np.zeros((ny * TILE, nx * TILE), dtype=np.float32)
    else:
        mosaic = np.zeros((ny * TILE, nx * TILE, 3), dtype=np.uint8)

    from PIL import Image
    done = 0
    failed = 0
    t0 = time.time()

    def work(task):
        x, y = task
        return x, y, fetch_tile(kind, z, x, y)

    with ThreadPoolExecutor(max_workers=jobs) as ex:
        for x, y, data in ex.map(work, tasks):
            done += 1
            if data is None:
                failed += 1
                continue
            img = Image.open(io.BytesIO(data)).convert(
                'RGB' if decode == 'rgb' else 'RGB')
            arr = np.asarray(img)
            if decode == 'elev':
                # Terrarium 编码：elev = R*256 + G + B/256 - 32768
                sub = (arr[:, :, 0].astype(np.float32) * 256.0
                       + arr[:, :, 1].astype(np.float32)
                       + arr[:, :, 2].astype(np.float32) / 256.0 - 32768.0)
                mosaic[(y - y0) * TILE:(y - y0 + 1) * TILE,
                       (x - x0) * TILE:(x - x0 + 1) * TILE] = sub
            else:
                mosaic[(y - y0) * TILE:(y - y0 + 1) * TILE,
                       (x - x0) * TILE:(x - x0 + 1) * TILE] = arr
            if done % 100 == 0:
                log(f'  {done}/{len(tasks)} ({time.time() - t0:.0f}s)')
    log(f'{kind} 完成：{done - failed}/{len(tasks)} 块，'
        f'{(time.time() - t0):.0f}s')
    return mosaic, x0, y0


# ---------------------------------------------------------------- 流域
def load_basin(keyword):
    """从项目流域数据里按名称关键字取一个流域，返回 (几何, 名称, 面积km²)。"""
    import geopandas as gpd
    from shapely.ops import unary_union

    g = gpd.read_file(BASIN_PATH)
    names = g['BasinName'].astype(str)
    hit = g[names.str.contains(keyword, na=False)]
    if hit.empty:
        avail = sorted(set(names.dropna()))
        raise SystemExit(f'流域数据里没有匹配「{keyword}」的流域；可选：{avail}')
    geom = unary_union(list(hit.geometry))
    name = str(hit.iloc[0]['BasinName'])
    lat_c = (geom.bounds[1] + geom.bounds[3]) / 2
    # 面积优先级：源数据 BasinArea 字段 > WGS84 测地线精确计算 > 经纬粗算。
    # 旧的「度² × 111.32² × cos(中心纬度)」粗算对跨 4 个纬度的流域会偏高约 0.5%
    # （雅鲁藏布江：粗算 34.91 万 vs 测地线 34.75 万 km²），故仅作兜底。
    area_km2 = None
    if 'BasinArea' in hit.columns:
        try:
            v = float(hit.iloc[0]['BasinArea'])
            if v and v > 0:
                area_km2 = v
        except (TypeError, ValueError):
            area_km2 = None
    if area_km2 is None:
        try:
            from pyproj import Geod
            area_km2 = abs(Geod(ellps='WGS84').geometry_area_perimeter(geom)[0]) / 1e6
        except Exception:
            area_km2 = geom.area * (111.32 ** 2) * math.cos(math.radians(lat_c))
    return geom, name, area_km2


def rasterize_mask(geom, bbox, n):
    """把流域多边形栅格化到 n×n 的"四边格中心"网格上，返回 Uint8 掩膜（行序北->南）。"""
    from rasterio.features import rasterize
    from rasterio.transform import from_origin

    lon0, lat0, lon1, lat1 = bbox
    dx = (lon1 - lon0) / n
    dy = (lat1 - lat0) / n
    transform = from_origin(lon0, lat1, dx, dy)
    mask = rasterize([(geom, 1)], out_shape=(n, n), transform=transform,
                     fill=0, all_touched=True, dtype='uint8')
    return mask


def simplify_boundary(geom, tol=0.005):
    """流域边界简化成经纬度折线（供前端画轮廓线）。"""
    from shapely.geometry import MultiPolygon, Polygon

    s = geom.simplify(tol, preserve_topology=True)
    rings = []
    if isinstance(s, Polygon):
        rings.append(s.exterior)
    elif isinstance(s, MultiPolygon):
        # 取面积最大的几块轮廓（小碎片略去）
        parts = sorted(s.geoms, key=lambda p: p.area, reverse=True)
        rings.extend(p.exterior for p in parts[:4])
    out = []
    for ring in rings:
        pts = [[round(x, 5), round(y, 5)] for x, y in ring.coords]
        if len(pts) >= 4:
            out.append(pts)
    return out


# ---------------------------------------------------------------- 业务图层
# 三维示范区叠加的业务矢量（全部走项目 data/raw/geo，与二维地图同源）
BUSINESS_GEO = {
    'glacier': os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo', 'cryosphere',
                            'TP_China_glaciers.geojson'),
    'lake': os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo', 'hydrology',
                         'TP_China_Lake.geojson'),
    # 河网：HydroRIVERS（含斯特拉勒级别 ORD_STRA、年均流量 DIS_AV_CMS）
    'river': os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo', 'hydrology',
                          'river.geojson'),
    'glof': os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo', 'disaster',
                       'GLOFs_HMA.geojson'),
    'llof': os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo', 'disaster',
                        'LLOFs_HMA.geojson'),
    'pf': os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo', 'disaster',
                       'PFs_HMA.geojson'),
    'sf': os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo', 'disaster',
                       'SFs_HMA.geojson'),
}

# 灾害点类型 -> （英文代码, 中文名）
DISASTER_TYPES = {
    'glof': ('GLOF', '冰湖溃决洪水'),
    'llof': ('LLOF', '滑坡堰塞湖溃决洪水'),
    'pf': ('PF', '降雨型洪水'),
    'sf': ('SF', '融雪洪水'),
}

# 河流名称来源：国家级 1:400 万水系（含 NAME 中文名），用于给主干河段补名称
RIVER_NAMES_GEO = os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo', 'hydrology',
                               'TP_China_rivers.geojson')
# 名称匹配的最大距离（度，约 2 km）：只有主干河段（斯特拉勒级别 >= 6）参与匹配
RIVER_NAME_MAXDIST = 0.02

# 冻土分布栅格：青藏高原冻土图（Albers 等积投影 ESRI:102025，937.49 m 像元）
# gridcode 语义（经高程与面积双重校验）：
#   0 = 季节性冻土  （全高原 138.2 万 km²，高程中位 4747 m）
#   1 = 多年冻土  （全高原 105.5 万 km²，高程中位 5256 m；文献值 1.06×10⁶ km²）
#   2 = 非冻土    （全高原   2.9 万 km²，高程中位 2038 m，藏南低海拔谷地）
# 只导出 0/1 两类；2 属非冻土，不纳入冻土要素。栅格 nodata 记为 255。
PERMAFROST_TIF = os.path.join(PROJECT_ROOT, 'data', 'raw', 'models',
                              'Perma_Distr_map21', 'Perma_Distr_map21.tif')
PERMAFROST_CLASSES = {0: '季节性冻土', 1: '多年冻土'}

# 危害范围多边形 -> （文件名, 中文名）。均为 data/raw/geo/disaster 下
# 冰川跃动 surging_glacier 体积过大（24MB 要素过多），示范区暂不纳入
HAZARD_POLYS = {
    'avalanche': ('雪崩危害范围.geojson', '雪崩危害'),
    'blizzard': ('风吹雪危害范围.geojson', '风吹雪危害'),
    'rts': ('RTS-QTP.geojson', '热融滑塌'),
}


def _read_gdf(path):
    import geopandas as gpd
    return gpd.read_file(path)


def _bbox_polygon(bbox):
    from shapely.geometry import Polygon
    return Polygon([(bbox[0], bbox[1]), (bbox[2], bbox[1]),
                    (bbox[2], bbox[3]), (bbox[0], bbox[3]),
                    (bbox[0], bbox[1])])


def build_business(out_dir, bbox, n, basin_geom, basin_mask_path=None,
                   basin_name=None):
    """生成业务图层数据（与地形同 bbox / 同分辨率），返回写入 meta 的 business 段。
    任何一层数据缺失都跳过该层（不报错），保证页面降级可用。
    """
    from shapely.geometry import Point, shape
    from rasterio.features import rasterize
    from rasterio.transform import from_origin
    from collections import Counter

    lon0, lat0, lon1, lat1 = bbox
    dx = (lon1 - lon0) / n
    dy = (lat1 - lat0) / n
    transform = from_origin(lon0, lat1, dx, dy)

    clip = basin_geom if basin_geom is not None else _bbox_polygon(bbox)

    # 流域掩膜用于 AND，避免把流域外冰川画进来
    basin_mask = None
    if basin_mask_path and os.path.isfile(basin_mask_path):
        try:
            basin_mask = np.fromfile(basin_mask_path, dtype=np.uint8).reshape(n, n)
        except Exception as e:
            log(f'  读取流域掩膜失败（忽略）：{e}')

    business = {}
    stats = {}

    # ---- 冰川：栅格化（n×n，与地形同分辨率），流域内才画 ----
    gpath = BUSINESS_GEO['glacier']
    if os.path.isfile(gpath):
        gdf = _read_gdf(gpath)
        gdf = gdf[gdf.geometry.intersects(clip.buffer(0))]
        geoms = [(g, 1) for g in gdf.geometry
                 if g is not None and not g.is_empty]
        if geoms:
            gmask = rasterize(geoms, out_shape=(n, n), transform=transform,
                              fill=0, all_touched=True, dtype='uint8')
            if basin_mask is not None:
                gmask = gmask & basin_mask
            gmask.tofile(os.path.join(out_dir, 'glacier.bin'))
            business['glacier'] = 'glacier.bin'
            area_km2 = float(gdf['area_km2'].sum()) if 'area_km2' in gdf else None
            stats['glacier'] = {
                'cells': int(gmask.sum()),
                'count': int(len(gdf)),
                'areaKm2': round(area_km2, 1) if area_km2 is not None else None,
            }
            # 冰川质心索引（点击就近查具体冰川）
            try:
                cen = gdf.copy()
                cen['clon'] = cen.geometry.centroid.x
                cen['clat'] = cen.geometry.centroid.y
                cen = cen[clip.buffer(0).contains(cen.geometry.centroid)]
                centroids = [{
                    'n': (row.get('glac_name') or ''),
                    'a': round(float(row.get('area_km2') or 0), 3),
                    'lo': round(float(row['clon']), 5),
                    'la': round(float(row['clat']), 5),
                    'z0': round(float(row.get('zmin_m') or 0), 0),
                    'z1': round(float(row.get('zmax_m') or 0), 0),
                } for _, row in cen.iterrows()
                    if float(row.get('area_km2') or 0) >= 0.1]
                with open(os.path.join(out_dir, 'glaciers.json'), 'w',
                          encoding='utf-8') as f:
                    json.dump(centroids, f, ensure_ascii=False, separators=(',', ':'))
                business['glaciers'] = 'glaciers.json'
                stats['glacier']['indexed'] = len(centroids)
            except Exception as e:
                log(f'  冰川质心索引跳过：{e}')
            log(f'冰川：{stats["glacier"]["count"]} 个，'
                f'流域内栅格单元 {stats["glacier"]["cells"]}'
                + (f'，索引 {stats["glacier"]["indexed"]} 个' if 'indexed' in stats['glacier'] else ''))

    # ---- 冰湖/湖泊：矢量多边形（裁剪到流域），运行时贴地渲染 ----
    lpath = BUSINESS_GEO['lake']
    if os.path.isfile(lpath):
        ldf = _read_gdf(lpath)
        ldf = ldf[ldf.geometry.intersects(clip.buffer(0))]
        lakes = []
        for _, row in ldf.iterrows():
            g = row.geometry
            if g is None or g.is_empty:
                continue
            g = g.intersection(clip.buffer(0))
            if g.is_empty:
                continue
            polys = g.geoms if g.geom_type == 'MultiPolygon' else [g]
            rings = []
            for p in polys:
                ext = [[round(x, 5), round(y, 5)] for x, y in p.exterior.coords]
                holes = [[[round(x, 5), round(y, 5)] for x, y in h.coords]
                         for h in p.interiors]
                rings.append({'outer': ext, 'holes': holes})
            if rings:
                lakes.append({
                    'id': int(row.get('OBJECTID') or 0),
                    'area': round(float(row.get('Area') or 0), 2),
                    'rings': rings,
                })
        if lakes:
            with open(os.path.join(out_dir, 'lakes.json'), 'w',
                      encoding='utf-8') as f:
                json.dump(lakes, f, ensure_ascii=False, separators=(',', ':'))
            business['lakes'] = 'lakes.json'
            stats['lake'] = {'count': len(lakes)}
            log(f'冰湖/湖泊：{len(lakes)} 个（流域内）')

    # ---- 河流：HydroRIVERS 线要素（裁剪到流域），运行时贴地渲染 ----
    rpath = BUSINESS_GEO['river']
    if os.path.isfile(rpath):
        rdf = _read_gdf(rpath)
        rdf = rdf[rdf.geometry.intersects(clip.buffer(0))]
        # 名称来源：国家级 1:400 万水系（含中文名），只给主干河段补名
        named = []
        if os.path.isfile(RIVER_NAMES_GEO):
            try:
                ndf = _read_gdf(RIVER_NAMES_GEO)
                ndf = ndf[ndf.geometry.intersects(clip.buffer(0))]
                names = ndf['NAME'] if 'NAME' in ndf.columns else None
                if names is not None:
                    for g, nm in zip(ndf.geometry, names):
                        if g is None or g.is_empty or not nm:
                            continue
                        nm = str(nm).strip()
                        if nm and nm.lower() != 'nan':
                            named.append((g, nm))
            except Exception as e:
                log(f'  河流名称索引跳过：{e}')

        rivers = []
        for _, row in rdf.iterrows():
            g = row.geometry
            if g is None or g.is_empty:
                continue
            g = g.intersection(clip.buffer(0))
            if g.is_empty:
                continue
            lines = (g.geoms if g.geom_type == 'MultiLineString'
                     else ([g] if g.geom_type == 'LineString' else []))
            try:
                o = int(row.get('ORD_STRA') or 0)
            except (TypeError, ValueError):
                o = 0
            # 主干河段（级别 >= 6）就近取名称
            name = None
            if o >= 6 and named:
                try:
                    mid = g.centroid
                    best, bd = None, None
                    for ng, nm in named:
                        d = mid.distance(ng)
                        if bd is None or d < bd:
                            best, bd = nm, d
                    if best and bd is not None and bd <= RIVER_NAME_MAXDIST:
                        name = best
                except Exception:
                    name = None
            for ln in lines:
                coords = [[round(x, 5), round(y, 5)] for x, y in ln.coords]
                if len(coords) < 2:
                    continue
                rivers.append({
                    'o': o,
                    'len': round(float(row.get('LENGTH_KM') or 0), 2),
                    'q': round(float(row.get('DIS_AV_CMS') or 0), 1),
                    'n': name,
                    'c': coords,
                })
        if rivers:
            with open(os.path.join(out_dir, 'rivers.json'), 'w',
                      encoding='utf-8') as f:
                json.dump(rivers, f, ensure_ascii=False, separators=(',', ':'))
            business['rivers'] = 'rivers.json'
            stats['river'] = {
                'count': len(rivers),
                'lengthKm': round(sum(r['len'] for r in rivers), 1),
                'named': sum(1 for r in rivers if r['n']),
            }
            log(f'河流：{len(rivers)} 段（流域内），总长 '
                f'{stats["river"]["lengthKm"]} km，'
                f'命名 {stats["river"]["named"]} 段')

    # ---- 冻土分布：冻土图栅格重投影到地形网格（与冰川同网格），流域内才画 ----
    ppath = PERMAFROST_TIF
    if os.path.isfile(ppath):
        try:
            import rasterio
            from rasterio.warp import reproject as _reproj, Resampling
            with rasterio.open(ppath) as psrc:
                sarr = psrc.read(1)
                a = np.where(sarr == psrc.nodata, 255, sarr)
                a = np.where((a < 0) | (a > 2), 255, a).astype('uint8')
                parr = np.full((n, n), 255, dtype='uint8')
                _reproj(source=a, destination=parr,
                        src_transform=psrc.transform, src_crs=psrc.crs,
                        dst_transform=transform, dst_crs='EPSG:4326',
                        resampling=Resampling.nearest,
                        src_nodata=255, dst_nodata=255)
            if basin_mask is not None:
                parr = np.where(basin_mask > 0, parr, 255).astype('uint8')
            # 像元面积（km²）：随纬度收敛
            lats = lat1 - (np.arange(n) + 0.5) * dy
            cell_km2 = ((dx * 111320.0) * (dy * 110540.0)
                        * np.cos(np.radians(lats)) / 1e6)
            area2d = np.repeat(cell_km2[:, None], n, axis=1)
            pstat = {}
            for v, nm in PERMAFROST_CLASSES.items():
                m = (parr == v)
                km2 = float(area2d[m].sum())
                pstat[nm] = {'cells': int(m.sum()),
                             'areaKm2': round(km2, 0),
                             'areaWan': round(km2 / 1e4, 2)}
            parr.tofile(os.path.join(out_dir, 'permafrost.bin'))
            business['permafrost'] = 'permafrost.bin'
            stats['permafrost'] = pstat
            log('冻土：' + '、'.join('%s %.2f 万km²' % (nm, v['areaWan'])
                                 for nm, v in pstat.items()) + '（流域内）')
        except Exception as e:
            log(f'  冻土图层跳过：{e}')

    # ---- 灾害点：GLOF / PF / SF ----
    import pandas as pd

    def _clean(v):
        if v is None:
            return None
        try:
            if pd.isna(v):
                return None
        except (TypeError, ValueError):
            pass
        if isinstance(v, (np.integer,)):
            return int(v)
        if isinstance(v, (np.floating,)):
            return float(v)
        if hasattr(v, 'isoformat'):            # pandas Timestamp
            return v.isoformat()
        return str(v)

    disasters = []
    for key, (code, label) in DISASTER_TYPES.items():
        dpath = BUSINESS_GEO[key]
        if not os.path.isfile(dpath):
            continue
        ddf = _read_gdf(dpath)
        for _, row in ddf.iterrows():
            g = row.geometry
            if g is None or g.is_empty or g.geom_type != 'Point':
                continue
            lon, lat = g.x, g.y
            if not (lon0 <= lon <= lon1 and lat0 <= lat <= lat1):
                continue
            if not clip.contains(Point(lon, lat)):
                continue
            props = {}
            for col in ('Country', 'Elevation', 'Time', 'Maincause',
                        'Began_time', 'Ended_time', 'MainCause', 'Dealth',
                        'Dead', 'Displaced', 'F5', 'F11', 'Reference',
                        'Regions', 'Severity'):
                v = _clean(row.get(col))
                if v not in (None, '', 'nan', 'None'):
                    props[col] = v
            disasters.append({'type': code, 'label': label,
                             'lon': round(lon, 5), 'lat': round(lat, 5),
                             'props': props})
    if disasters:
        with open(os.path.join(out_dir, 'disasters.json'), 'w',
                  encoding='utf-8') as f:
            json.dump(disasters, f, ensure_ascii=False, separators=(',', ':'))
        business['disasters'] = 'disasters.json'
        c = Counter(d['type'] for d in disasters)
        stats['disaster'] = {
            'total': len(disasters),
            'byType': {DISASTER_TYPES[k][1]: c.get(DISASTER_TYPES[k][0], 0)
                       for k in DISASTER_TYPES},
        }
        log(f'灾害点：{len(disasters)} 个'
            f'（GLOF {c.get("GLOF", 0)}，LLOF {c.get("LLOF", 0)}，'
            f'PF {c.get("PF", 0)}，SF {c.get("SF", 0)}）')

    # ---- 危害范围多边形：雪崩 / 风吹雪 / 热融滑塌（裁剪到流域） ----
    hazards = {}
    for key, (fname, hlabel) in HAZARD_POLYS.items():
        hpath = os.path.join(PROJECT_ROOT, 'data', 'raw', 'geo', 'disaster', fname)
        if not os.path.isfile(hpath):
            continue
        hdf = _read_gdf(hpath)
        hdf = hdf[hdf.geometry.intersects(clip.buffer(0))]
        feats = []
        for _, row in hdf.iterrows():
            g = row.geometry
            if g is None or g.is_empty:
                continue
            g = g.intersection(clip.buffer(0))
            if g.is_empty:
                continue
            polys = g.geoms if g.geom_type == 'MultiPolygon' else [g]
            rings = []
            for p in polys:
                if p.geom_type != 'Polygon':
                    continue
                ext = [[round(x, 5), round(y, 5)] for x, y in p.exterior.coords]
                holes = [[[round(x, 5), round(y, 5)] for x, y in h.coords]
                         for h in p.interiors]
                if len(ext) >= 4:
                    rings.append({'outer': ext, 'holes': holes})
            if rings:
                feats.append({'label': hlabel, 'rings': rings})
        if feats:
            with open(os.path.join(out_dir, key + '.json'), 'w',
                      encoding='utf-8') as f:
                json.dump(feats, f, ensure_ascii=False, separators=(',', ':'))
            hazards[key] = key + '.json'
            stats.setdefault('hazard', {})[key] = {'label': hlabel,
                                                  'count': len(feats)}
            log(f'{hlabel}：{len(feats)} 个（流域内）')

    if hazards:
        business['hazards'] = hazards

    if business:
        business['stats'] = stats
        _core = {'glacier.bin', 'glaciers.json', 'lakes.json', 'rivers.json',
                 'permafrost.bin', 'disasters.json'}
        _core |= set(hazards.values())
        total = sum(os.path.getsize(os.path.join(out_dir, fn))
                    for fn in os.listdir(out_dir) if fn in _core)
        business['sizeMb'] = round(total / 1e6, 2)
        log(f'业务图层产物 {business["sizeMb"]}MB -> {out_dir}')
    else:
        log('未生成任何业务图层（数据缺失）')
    return business


# ---------------------------------------------------------------- 采样
def sample_bilinear(mosaic, x0, y0, z, lons, lats):
    """在瓦片拼图上按经纬度双线性采样（lons/lats 为同形状数组）。"""
    n = float(2 ** z)
    fx = (lons + 180.0) / 360.0 * n
    lat_r = np.radians(lats)
    fy = (1.0 - np.log(np.tan(lat_r) + 1.0 / np.cos(lat_r)) / np.pi) / 2.0 * n
    px = (fx - x0) * TILE - 0.5
    py = (fy - y0) * TILE - 0.5
    h, w = mosaic.shape[:2]
    px = np.clip(px, 0, w - 1.001)
    py = np.clip(py, 0, h - 1.001)
    ix, iy = np.floor(px).astype(np.int64), np.floor(py).astype(np.int64)
    dx, dy = px - ix, py - iy
    if mosaic.ndim == 2:
        v00 = mosaic[iy, ix]
        v01 = mosaic[iy, ix + 1]
        v10 = mosaic[iy + 1, ix]
        v11 = mosaic[iy + 1, ix + 1]
        return ((v00 * (1 - dx) + v01 * dx) * (1 - dy)
                + (v10 * (1 - dx) + v11 * dx) * dy)
    out = np.zeros(px.shape + (3,), dtype=np.float32)
    for c in range(3):
        v00 = mosaic[iy, ix, c].astype(np.float32)
        v01 = mosaic[iy, ix + 1, c].astype(np.float32)
        v10 = mosaic[iy + 1, ix, c].astype(np.float32)
        v11 = mosaic[iy + 1, ix + 1, c].astype(np.float32)
        out[:, :, c] = ((v00 * (1 - dx) + v01 * dx) * (1 - dy)
                        + (v10 * (1 - dx) + v11 * dx) * dy)
    return out


def hillshade_rgb(elev, res_x_m, res_y_m, azimuth=315.0, altitude=45.0,
                  z_factor=1.6):
    """由高程生成灰阶晕渲（RGB 三通道相同），供"晕渲灰阶"贴图用。"""
    dz_row, dz_col = np.gradient(elev, res_y_m, res_x_m)
    dz_north = -dz_row
    dz_east = dz_col
    slope = np.arctan(z_factor * np.hypot(dz_east, dz_north))
    aspect = np.arctan2(-dz_east, -dz_north)
    zen = np.radians(90.0 - altitude)
    az = np.radians(azimuth)
    hs = np.cos(zen) * np.cos(slope) + np.sin(zen) * np.sin(slope) * np.cos(az - aspect)
    hs = np.clip(hs, 0.0, 1.0)
    g = (42.0 + hs * 190.0).astype(np.uint8)
    return np.dstack([g, g, g])


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--place', default='himalaya', choices=sorted(PLACES),
                    help='预设区域（无 --bbox/--basin 时生效）')
    ap.add_argument('--bbox', default=None,
                    help='west,south,east,north（优先于 --place）')
    ap.add_argument('--basin', default=None,
                    help='按项目流域数据做，如「雅鲁藏布江」；自动取边界、范围与名称')
    ap.add_argument('--region-id', default=None,
                    help='输出目录/URL 用的英文 id（默认按 basin 或 place 生成）')
    ap.add_argument('--no-clip', action='store_true',
                    help='配合 --basin：不按流域边界裁剪地形（默认裁剪）')
    ap.add_argument('--zoom', type=int, default=11, help='瓦片层级（默认 11≈77m）')
    ap.add_argument('--mesh', type=int, default=600,
                    help='网格分段数（顶点数 = mesh+1 的平方）')
    ap.add_argument('--texture', type=int, default=4096, help='贴图长边像素')
    ap.add_argument('--jobs', type=int, default=8, help='并发下载数')
    ap.add_argument('--out', default=None, help='输出目录（默认 terrain3d/<place>）')
    ap.add_argument('--no-imagery', action='store_true',
                    help='不下载卫星影像，仅生成晕渲贴图（完全离线）')
    ap.add_argument('--no-business', action='store_true',
                    help='不生成业务图层（冰川/冰湖/灾害点）')
    ap.add_argument('--business-only', action='store_true',
                    help='跳过地形/贴图，仅基于已有 meta.json+mask.bin 补生成业务图层')
    args = ap.parse_args()

    # ---- 仅补业务图层：复用已生成的地形与流域掩膜 ----
    if args.business_only:
        out_dir = args.out or os.path.join(OUT_ROOT, args.region_id or 'yarlung')
        meta_path = os.path.join(out_dir, 'meta.json')
        if not os.path.isfile(meta_path):
            raise SystemExit(f'找不到 {meta_path}，无法 --business-only；'
                             '请先正常生成一次。')
        with open(meta_path, encoding='utf-8') as f:
            meta = json.load(f)
        bbox = tuple(meta['bbox'])
        n = meta['meshSize']
        bname = (meta.get('basin') or {}).get('name')
        bgeom = load_basin(bname)[0] if bname else None
        mask_path = os.path.join(out_dir, 'mask.bin') if meta.get('mask') else None
        biz = build_business(out_dir, bbox, n, bgeom, mask_path, bname)
        meta['business'] = biz
        with open(meta_path, 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        log('业务图层补生成完成。')
        return

    basin_geom = None
    basin_meta = None
    if args.basin:
        basin_geom, bname, barea = load_basin(args.basin)
        bbox = tuple(basin_geom.bounds)
        place_id = args.region_id or 'basin'
        place_name = f'{bname}流域'
        log(f'流域：{bname}，面积约 {barea / 1e4:.1f} 万 km²，'
            f'bbox=({bbox[0]:.2f},{bbox[1]:.2f})-({bbox[2]:.2f},{bbox[3]:.2f})')
        basin_meta = {'name': bname, 'areaKm2': round(barea)}
    elif args.bbox:
        bbox = tuple(float(v) for v in args.bbox.split(','))
        place_id = 'custom'
        place_name = f'自定义区域 {bbox[0]:.2f},{bbox[1]:.2f},{bbox[2]:.2f},{bbox[3]:.2f}'
    else:
        preset = PLACES[args.place]
        bbox = preset['bbox']
        place_id = args.place
        place_name = preset['name']

    out_dir = args.out or os.path.join(OUT_ROOT, place_id)
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(CACHE_DIR, exist_ok=True)
    log(f'区域：{place_name} bbox={bbox} zoom={args.zoom} mesh={args.mesh}')

    # 1) 高程
    elev_m, ex0, ey0 = build_mosaic(bbox, args.zoom, 'elev', args.jobs, 'elev')

    # 2) 卫星影像（可选）
    sat = None
    if not args.no_imagery:
        sat_m, sx0, sy0 = build_mosaic(bbox, args.zoom, 'imagery', args.jobs, 'rgb')
        sat = (sat_m, sx0, sy0)

    from PIL import Image

    # 3) 网格采样（行 0 = 北）
    n = args.mesh
    lons_1d = np.linspace(bbox[0], bbox[2], n + 1)
    lats_1d = np.linspace(bbox[3], bbox[1], n + 1)     # 北 -> 南
    LON, LAT = np.meshgrid(lons_1d, lats_1d)
    heights = sample_bilinear(elev_m, ex0, ey0, args.zoom, LON, LAT)

    lat_c = (bbox[1] + bbox[3]) / 2.0
    size_x = (bbox[2] - bbox[0]) * 111320.0 * math.cos(math.radians(lat_c))
    size_z = (bbox[3] - bbox[1]) * 110540.0
    min_h, max_h = float(heights.min()), float(heights.max())
    log(f'网格 {n + 1}x{n + 1}，高程 {min_h:.0f}~{max_h:.0f} m，'
        f'范围 {size_x / 1000:.0f}km x {size_z / 1000:.0f}km')

    # 4) 高度场（int16 相对最小高程，前端加回 minHeight）
    hq = np.round(heights - min_h).astype(np.int16)
    with open(os.path.join(out_dir, 'height.bin'), 'wb') as f:
        f.write(hq.tobytes())

    # 4b) 流域掩膜 + 边界（按流域裁剪时，前端只画掩膜内的四边形）
    mask_meta = None
    if basin_geom is not None and not args.no_clip:
        m = rasterize_mask(basin_geom, bbox, n)
        with open(os.path.join(out_dir, 'mask.bin'), 'wb') as f:
            f.write(m.astype(np.uint8).tobytes())
        inside = float(m.mean())
        log(f'流域掩膜 {n}×{n}：内部占 {inside * 100:.1f}%，-> mask.bin')
        rings = simplify_boundary(basin_geom, tol=0.01)
        basin_meta['boundary'] = rings
        basin_meta['insideRatio'] = round(inside, 4)
        mask_meta = 'mask.bin'
    elif basin_geom is not None:
        rings = simplify_boundary(basin_geom, tol=0.01)
        basin_meta['boundary'] = rings

    # 5) 贴图（保持与网格相同的长宽比，避免拉伸）
    tw = args.texture
    th = max(256, int(round(tw * size_z / size_x)))
    tex_meta = {}

    if sat is not None:
        sat_m, sx0, sy0 = sat
        # 把 bbox 在拼图里的范围裁出来
        px0, py0 = lonlat_to_tile_xy(bbox[0], bbox[3], args.zoom)
        px1, py1 = lonlat_to_tile_xy(bbox[2], bbox[1], args.zoom)
        cx0 = int(round((px0 - sx0) * TILE))
        cy0 = int(round((py0 - sy0) * TILE))
        cx1 = int(round((px1 - sx0) * TILE))
        cy1 = int(round((py1 - sy0) * TILE))
        crop = sat_m[max(0, cy0):cy1, max(0, cx0):cx1]
        img = Image.fromarray(crop.astype(np.uint8), 'RGB').resize(
            (tw, th), Image.LANCZOS)
        img.save(os.path.join(out_dir, 'texture.jpg'), quality=88,
                 optimize=True, progressive=True)
        tex_meta['satellite'] = 'texture.jpg'
        log(f'卫星贴图 {img.size} -> texture.jpg')

    # 6) 晕渲贴图（始终生成，可离线用）
    hs = hillshade_rgb(heights, size_x / n, size_z / n)
    img_hs = Image.fromarray(hs, 'RGB').resize((tw, th), Image.LANCZOS)
    img_hs.save(os.path.join(out_dir, 'texture_hillshade.jpg'), quality=90,
                optimize=True, progressive=True)
    tex_meta['hillshade'] = 'texture_hillshade.jpg'
    log(f'晕渲贴图 {img_hs.size} -> texture_hillshade.jpg')

    # 7) 地标（有流域多边形时按多边形过滤，否则按 bbox）
    from shapely.geometry import Point
    peaks = []
    for name, lon, lat, elev in PEAKS:
        inside = (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3])
        if inside and basin_geom is not None:
            inside = basin_geom.buffer(0.02).contains(Point(lon, lat))
        if inside:
            peaks.append({
                'name': name, 'lon': lon, 'lat': lat, 'elev': elev,
                'x': (lon - (bbox[0] + bbox[2]) / 2) * 111320.0
                     * math.cos(math.radians(lat_c)),
                'z': -((lat - (bbox[1] + bbox[3]) / 2) * 110540.0),
            })

    meta = {
        'region': place_id,
        'name': place_name,
        'bbox': list(bbox),
        'zoom': args.zoom,
        'meshSize': n,
        'minHeight': round(min_h, 1),
        'maxHeight': round(max_h, 1),
        'sizeMeters': {'x': round(size_x, 1), 'z': round(size_z, 1)},
        'textures': tex_meta,
        'heights': 'height.bin',
        'mask': mask_meta,
        'basin': basin_meta,
        'peaks': peaks,
        'sources': {
            'dem': 'AWS Open Data / Terrarium（SRTM 派生，全球已填洞）',
            'imagery': 'Esri World Imagery（在线，需按其条款署名）'
                       if 'satellite' in tex_meta else '无（仅本地晕渲）',
        },
        'generated': time.strftime('%Y-%m-%d %H:%M'),
    }

    # 8) 业务图层（冰川/冰湖/灾害点）：与地形同源、同 bbox
    if not args.no_business:
        mask_path = os.path.join(out_dir, mask_meta) if mask_meta else None
        try:
            meta['business'] = build_business(out_dir, bbox, n, basin_geom,
                                             mask_path,
                                             basin_meta['name'] if basin_meta else None)
        except Exception as e:
            log(f'业务图层生成失败（跳过，不影响地形）：{e}')

    with open(os.path.join(out_dir, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    total = sum(os.path.getsize(os.path.join(out_dir, fn))
                for fn in os.listdir(out_dir))
    log(f'输出：{out_dir}（{total / 1e6:.1f}MB）')
    log(f'打开：/terrain3d.html?region={place_id}')


if __name__ == '__main__':
    main()
