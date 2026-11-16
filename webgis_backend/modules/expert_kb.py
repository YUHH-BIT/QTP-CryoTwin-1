# -*- coding: utf-8 -*-
"""
冰冻圈灾害大模型真实数据知识库 —— 构建与检索（RAG 数据层）
====================================================
基于本系统**真实数据资产**构建结构化知识库（SQLite: data/processed/db/expert_kb.db），
供冰冻圈灾害大模型（llm.py /api/llm/chat）在回答时检索真实数据并溯源引用。

数据源（全部为本项目真实数据）：
1. 灾害事件库  data/raw/geo/disaster/*.geojson（8 类冰冻圈灾害事件）
2. 气象站点    data/raw/geo/station/weather_station.geojson
3. 县域数据    data/raw/geo/socioeconomic/economy_counties.geojson + data/raw/economy/GDP_data.csv
               + data/processed/economy/county_population_latest.csv
4. 基础设施    data/raw/geo/infrastructure/GDW_reservoirs.geojson / GDW_barriers.geojson / powerplant.geojson
5. 流域概览    data/raw/geo/cryosphere/TP_China_glaciers.geojson / TP_China_Lake.geojson / river.geojson
               / TP_China_permafrost.geojson / XianCh_point.geojson / roa_4m.geojson / rai_4m.geojson
6. ERA5 气象索引 data/processed/db/era5_index.db / TibetanPlateau_index.db（数据现状统计）
7. 风险评估方法学（摘自《洪水灾害风险评估技术文档.md》）

科研规范：
- 所有入库记录保留来源（source_file / reference），大模型回答引用时标注 [数据源: 类型#编号]
- 构建幂等（可重复执行），每次重建更新 kb_sources 的构建时间与条数
"""
import json
import os
import re
import sqlite3
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
GEO_DIR = os.path.join(BASE_DIR, 'data', 'raw', 'geo')
ECON_DIR = os.path.join(BASE_DIR, 'data', 'raw', 'economy')
PROCESSED_DIR = os.path.join(BASE_DIR, 'data', 'processed')
DB_DIR = os.path.join(PROCESSED_DIR, 'db')
KB_DB_PATH = os.path.join(DB_DIR, 'expert_kb.db')

# 灾害类型 -> (文件名, 中文名)
# 单一数据源已收口至 config.DISASTER_TYPES，此处直接复用，避免两处不同步。
# 注意：本文件依赖 config，故 CLI 构建需在 webgis_backend 目录下执行
#   cd webgis_backend && python -m modules.expert_kb [--force]
# （原先可从任意目录 `python webgis_backend/modules/expert_kb.py` 是因为本文件不 import 任何项目模块）
from config import DISASTER_TYPES

# 方法学文本（摘自《洪水灾害风险评估技术文档.md》）
METHODS_TEXT = [
    {
        'title': '风险评估理论框架 R = H × E × V',
        'content': ('本系统采用栅格像元级洪水风险评估模型：风险(R) = 危险性(H) × 暴露度(E) × 脆弱性(V)。'
                    '危险性表征洪水事件发生的概率与强度；暴露度表征承灾体（人口、GDP、基础设施等）处于危险范围内的程度；'
                    '脆弱性表征承灾体受损的敏感程度。三者均为归一化栅格场，逐像元相乘得到风险值。'),
        'source': '《洪水灾害风险评估技术文档.md》§3.1',
    },
    {
        'title': '风险五级分级标准',
        'content': ('风险结果采用五级分级：极低风险、低风险、中风险、高风险、极高风险。'
                    '分级阈值基于风险值分布与流域尺度约束确定，输出 5 级分级 GeoTIFF。'),
        'source': '《洪水灾害风险评估技术文档.md》§3.5',
    },
    {
        'title': '洪水阈值场（百分位阈值）',
        'content': ('系统提供 grid_threshold_10p/50p/90p/95p/99p 五档洪水阈值栅格'
                    '（data/raw/thresholds/），分别对应指标的 10%、50%、90%、95%、99% 分位数阈值，'
                    '用于判定洪水事件的极端程度与危险性等级。'),
        'source': 'data/raw/thresholds/grid_threshold_*.tif',
    },
    {
        'title': 'LSTM 径流模拟',
        'content': ('系统训练 LSTM 径流模拟模型（lstm_runoff_model.pt），'
                    '以气象序列为输入模拟径流过程，支撑洪水过程模拟与淹没分析。'),
        'source': 'Training/output/lstm_runoff_model.pt',
    },
    {
        'title': '流域尺度约束',
        'content': ('风险评估在流域尺度内进行约束：仅对流域边界内的像元计算风险，'
                    '保证结果的物理一致性与管理可用性。'),
        'source': '《洪水灾害风险评估技术文档.md》§3.6',
    },
]

STREAM_COUNT_THRESHOLD = 50 * 1024 * 1024


# --------------------------------------------------------------------------
# 工具函数
# --------------------------------------------------------------------------
def _ensure_db_dir():
    os.makedirs(DB_DIR, exist_ok=True)


def _read_geojson(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.warning('读取 GeoJSON 失败 %s: %s', path, e)
        return None


def _count_features_stream(path):
    count = 0
    try:
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            pattern = re.compile(r'"type"\s*:\s*"Feature"')
            prev_tail = ''
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                text = prev_tail + chunk
                count += len(pattern.findall(text))
                prev_tail = text[-20:]
    except Exception as e:
        logger.warning('流式统计失败 %s: %s', path, e)
        return 0
    return count


def _safe_float(v):
    try:
        if v is None or v == '' or str(v).lower() in ('none', 'null', 'nan'):
            return None
        return float(v)
    except (ValueError, TypeError):
        return None


def _safe_int(v):
    try:
        if v is None or v == '' or str(v).lower() in ('none', 'null', 'nan'):
            return None
        return int(float(v))
    except (ValueError, TypeError):
        return None


def _clean_date(v):
    if not v or str(v).lower() in ('none', 'null'):
        return None
    s = str(v).strip()
    m = re.search(r'(\d{4})[-/](\d{1,2})[-/](\d{1,2})', s)
    if m:
        return '%s-%02d-%02d' % (m.group(1), int(m.group(2)), int(m.group(3)))
    m = re.search(r'(\d{4})[-/](\d{1,2})', s)
    if m:
        return '%s-%02d' % (m.group(1), int(m.group(2)))
    m = re.search(r'(\d{4})', s)
    if m:
        return m.group(1)
    return s[:40]


def _geom_centroid(feature):
    geom = feature.get('geometry') or {}
    gtype = geom.get('type')
    coords = geom.get('coordinates')
    if gtype == 'Point' and coords:
        return _safe_float(coords[0]), _safe_float(coords[1])
    if gtype == 'MultiPoint' and coords:
        c = coords[0]
        return _safe_float(c[0]), _safe_float(c[1])
    if gtype in ('Polygon', 'MultiPolygon') and coords:
        try:
            rings = coords[0] if gtype == 'Polygon' else coords[0][0]
            xs = [p[0] for p in rings]
            ys = [p[1] for p in rings]
            return sum(xs) / len(xs), sum(ys) / len(ys)
        except Exception:
            return None, None
    return None, None


def _geom_area_approx(feature):
    geom = feature.get('geometry') or {}
    coords = geom.get('coordinates')
    if not coords:
        return None
    try:
        if geom.get('type') == 'Polygon':
            rings = coords[0]
        elif geom.get('type') == 'MultiPolygon':
            rings = coords[0][0]
        else:
            return None
        xs = [p[0] for p in rings]
        ys = [p[1] for p in rings]
        return (max(xs) - min(xs)) * (max(ys) - min(ys))
    except Exception:
        return None


# --------------------------------------------------------------------------
# 各数据源构建
# --------------------------------------------------------------------------
def _build_disaster_cases(cur):
    cur.execute('DELETE FROM kb_disaster_cases')
    total = 0
    for dtype, filename, cname in DISASTER_TYPES:
        # 8 类灾害 GeoJSON 全部归入 geo/disaster/
        path = os.path.join(GEO_DIR, 'disaster', filename)
        if not os.path.exists(path):
            logger.warning('灾害数据缺失: %s', path)
            continue
        data = _read_geojson(path)
        feats = (data or {}).get('features', [])
        for feat in feats:
            p = feat.get('properties') or {}
            lon, lat = _geom_centroid(feat)
            rec = {
                'type': dtype, 'type_name': cname,
                'country': str(p.get('Country') or '').strip() or None,
                'region': None, 'lon': lon, 'lat': lat,
                'began': None, 'ended': None, 'main_cause': None,
                'deaths': None, 'displaced': None, 'affected_area': None,
                'rainfall_mm': None, 'severity': None, 'elevation': None,
                'blocking_duration': None, 'glacier_info': None,
                'area_approx': None, 'reference': None, 'source_file': filename,
            }
            if dtype == 'rainfall_floods':
                rec['region'] = str(p.get('Regions') or '').strip() or None
                rec['began'] = _clean_date(p.get('Began_time'))
                rec['ended'] = _clean_date(p.get('Ended_time'))
                rec['main_cause'] = str(p.get('MainCause') or '').strip() or None
                rec['deaths'] = _safe_int(p.get('Dealth'))
                rec['displaced'] = _safe_int(p.get('Displaced'))
                rec['affected_area'] = _safe_float(p.get('Affected_a'))
                rec['rainfall_mm'] = _safe_float(p.get('Rainfall_m'))
                rec['reference'] = str(p.get('Reference') or '').strip() or None
            elif dtype == 'snowmelt_floods':
                rec['region'] = str(p.get('F5') or '').strip() or None
                lon, lat = _safe_float(p.get('long')), _safe_float(p.get('lat'))
                rec['lon'], rec['lat'] = lon, lat
                rec['began'] = _clean_date(p.get('Began'))
                rec['ended'] = _clean_date(p.get('Ended'))
                rec['main_cause'] = str(p.get('MainCause') or '').strip() or None
                rec['deaths'] = _safe_int(p.get('Dead'))
                rec['displaced'] = _safe_int(p.get('Displaced'))
                rec['affected_area'] = _safe_float(p.get('losses'))
                rec['severity'] = str(p.get('Severity') or '').strip() or None
            elif dtype == 'glacial_lake_floods':
                rec['elevation'] = _safe_float(p.get('Elevation'))
                rec['began'] = _clean_date(p.get('Time'))
                rec['main_cause'] = str(p.get('Maincause') or '').strip() or None
            elif dtype == 'landslide_dam_floods':
                rec['began'] = _clean_date(p.get('Time'))
                rec['main_cause'] = str(p.get('Maincause') or '').strip() or None
                rec['blocking_duration'] = str(p.get('Blocking_d') or '').strip() or None
            elif dtype == 'glacier_surging':
                rec['glacier_info'] = json.dumps({
                    'glacier_id': str(p.get('Glac_ID') or ''),
                    'area_km2': _safe_float(p.get('Area')),
                    'zmax': _safe_float(p.get('Zmax')),
                    'slope_deg': _safe_float(p.get('Slope')),
                    'max_length_m': _safe_float(p.get('MaxL')),
                    'surge_class_2020s': str(p.get('surge_20') or ''),
                    'hima_region': str(p.get('Himap_regi') or ''),
                }, ensure_ascii=False)
                rec['area_approx'] = _geom_area_approx(feat)
            elif dtype == 'rts_qtp':
                rec['affected_area'] = _safe_float(p.get('area'))
                rec['severity'] = str(p.get('Type') or '').strip() or None
                rec['area_approx'] = _geom_area_approx(feat)
            elif dtype in ('avalanche_hazard', 'blizzard_hazard'):
                rec['area_approx'] = _geom_area_approx(feat)
            cur.execute('''
                INSERT INTO kb_disaster_cases
                (type, type_name, country, region, lon, lat, began, ended, main_cause,
                 deaths, displaced, affected_area, rainfall_mm, severity, elevation,
                 blocking_duration, glacier_info, area_approx, reference, source_file)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ''', tuple(rec[k] for k in (
                'type', 'type_name', 'country', 'region', 'lon', 'lat', 'began', 'ended',
                'main_cause', 'deaths', 'displaced', 'affected_area', 'rainfall_mm',
                'severity', 'elevation', 'blocking_duration', 'glacier_info',
                'area_approx', 'reference', 'source_file')))
            total += 1
    logger.info('灾害案例入库 %d 条', total)
    return total


def _build_stations(cur):
    cur.execute('DELETE FROM kb_stations')
    path = os.path.join(GEO_DIR, 'station', 'weather_station.geojson')
    data = _read_geojson(path)
    feats = (data or {}).get('features', [])
    n = 0
    for feat in feats:
        p = feat.get('properties') or {}
        lon, lat = _geom_centroid(feat)
        name = str(p.get('站名') or p.get('台站名') or '').strip()
        cur.execute('INSERT INTO kb_stations (station_id, name, province, lon, lat, elevation) VALUES (?,?,?,?,?,?)',
                    (str(p.get('区站号') or '').strip(), name,
                     str(p.get('省份') or p.get('省') or '').strip(),
                     lon, lat, _safe_float(p.get('海拔') or p.get('F7'))))
        n += 1
    return n


def _load_gdp():
    gdp = {}
    path = os.path.join(ECON_DIR, 'GDP_data.csv')
    if not os.path.exists(path):
        return gdp
    with open(path, 'r', encoding='utf-8-sig') as f:
        lines = f.read().splitlines()
    if not lines:
        return gdp
    years = lines[0].split(',')[1:]
    for line in lines[1:]:
        parts = line.split(',')
        if len(parts) < 2:
            continue
        county = parts[0].strip()
        vals = {}
        for i, y in enumerate(years):
            v = parts[i + 1].strip() if i + 1 < len(parts) else ''
            if v:
                try:
                    vals[int(y.strip())] = float(v)
                except ValueError:
                    pass
        if vals:
            gdp[county] = vals
    return gdp


def _load_population():
    pop = {}
    path = os.path.join(PROCESSED_DIR, 'economy', 'county_population_latest.csv')
    if not os.path.exists(path):
        return pop
    with open(path, 'r', encoding='utf-8-sig') as f:
        lines = f.read().splitlines()
    for line in lines[1:]:
        parts = line.split(',')
        if len(parts) >= 2:
            county = parts[0].strip()
            try:
                pop[county] = float(parts[1].strip())
            except ValueError:
                pass
    return pop


def _build_counties(cur):
    cur.execute('DELETE FROM kb_counties')
    gdp = _load_gdp()
    pop = _load_population()
    path = os.path.join(GEO_DIR, 'socioeconomic', 'economy_counties.geojson')
    data = _read_geojson(path)
    feats = (data or {}).get('features', [])
    n = 0
    for feat in feats:
        p = feat.get('properties') or {}
        lon, lat = _geom_centroid(feat)
        name = str(p.get('NAME_DECODED') or p.get('NAME') or '').strip()
        gdp_vals = gdp.get(name, {})
        gdp_latest = gdp_vals.get(max(gdp_vals)) if gdp_vals else None
        gdp_2015 = gdp_vals.get(2015) if gdp_vals else None
        cur.execute('''INSERT INTO kb_counties
            (name, adcode, lon, lat, pop_latest, gdp_latest_year, gdp_latest, gdp_2015, has_economy)
            VALUES (?,?,?,?,?,?,?,?,?)''',
            (name, str(p.get('ADCODE93') or '').strip(), lon, lat,
             pop.get(name), max(gdp_vals) if gdp_vals else None,
             gdp_latest, gdp_2015, 1 if (gdp_vals or name in pop) else 0))
        n += 1
    return n


def _build_infra(cur):
    cur.execute('DELETE FROM kb_infra')
    # 元组第 2 项为 data/raw/geo/ 下的分层子目录（2026-09-07 起 geo 按语义分层）
    specs = [
        ('reservoir', 'infrastructure', 'GDW_reservoirs.geojson', '水库'),
        ('dam', 'infrastructure', 'GDW_barriers.geojson', '水坝'),
        ('powerplant', 'infrastructure', 'powerplant.geojson', '能源站点'),
    ]
    n = 0
    for kind, subdir, filename, cname in specs:
        path = os.path.join(GEO_DIR, subdir, filename)
        data = _read_geojson(path)
        feats = (data or {}).get('features', [])
        for feat in feats:
            p = feat.get('properties') or {}
            lon, lat = _geom_centroid(feat)
            name = None
            for k in ('NAME', 'name', 'Name', 'RES_NAME', 'Dam_Name', 'dam_name',
                      'plant_name', 'Plant', 'FULL_NAME'):
                if p.get(k):
                    name = str(p[k]).strip()
                    break
            extra = {str(k): str(v)[:60] for k, v in list(p.items())[:8]}
            cur.execute('INSERT INTO kb_infra (kind, kind_name, name, lon, lat, extra_json) VALUES (?,?,?,?,?,?)',
                        (kind, cname, name, lon, lat, json.dumps(extra, ensure_ascii=False)[:2000]))
            n += 1
    return n


def _build_geo_overview(cur):
    cur.execute('DELETE FROM kb_geo_overview')
    # 元组第 2 项为 data/raw/geo/ 下的分层子目录
    overviews = [
        ('glacier', 'cryosphere', 'TP_China_glaciers.geojson', '冰川'),
        ('lake', 'hydrology', 'TP_China_Lake.geojson', '湖泊'),
        ('river', 'hydrology', 'river.geojson', '河流'),
        ('permafrost', 'cryosphere', 'TP_China_permafrost.geojson', '多年冻土'),
        ('settlement', 'settlement', 'XianCh_point.geojson', '居民地'),
        ('road', 'infrastructure', 'roa_4m.geojson', '道路'),
        ('railway', 'infrastructure', 'rai_4m.geojson', '铁路'),
    ]
    n = 0
    for kind, subdir, filename, cname in overviews:
        path = os.path.join(GEO_DIR, subdir, filename)
        if not os.path.exists(path):
            continue
        size = os.path.getsize(path)
        if size > STREAM_COUNT_THRESHOLD:
            count = _count_features_stream(path)
            method = 'stream'
        else:
            data = _read_geojson(path)
            count = len((data or {}).get('features', []))
            method = 'full'
        stats = {'file_size_mb': round(size / 1024 / 1024, 2), 'count_method': method}
        cur.execute('INSERT INTO kb_geo_overview (kind, kind_name, count, note, stats_json) VALUES (?,?,?,?,?)',
                    (kind, cname, count,
                     '青藏高原%s要素数量（来源 %s）' % (cname, filename),
                     json.dumps(stats, ensure_ascii=False)))
        n += 1
    return n


def _build_era5_stats(cur):
    cur.execute('DELETE FROM kb_era5_stats')
    # 仅保留仍在维护的 TibetanPlateau_index 库（2024 年近期栅格）。
    # era5_index / flood_mask_index / flood_png_index 三张表指向的历史栅格
    # （1956-2023 _clipped.tif、F:\data\flood_*）在本机已不存在，2026-09-07 已删除。
    specs = [
        ('TibetanPlateau_index.db', 'TibetanPlateau_index', '青藏高原气象栅格(近期)'),
    ]
    n = 0
    for dbfile, table, cname in specs:
        path = os.path.join(DB_DIR, dbfile)
        if not os.path.exists(path):
            continue
        try:
            con = sqlite3.connect(path)
            cur2 = con.cursor()
            cnt = cur2.execute('SELECT COUNT(*) FROM [%s]' % table).fetchone()[0]
            row = cur2.execute('SELECT MIN(date), MAX(date) FROM [%s]' % table).fetchone()
            vars_ = None
            if 'variable' in [r[1] for r in cur2.execute('PRAGMA table_info([%s])' % table).fetchall()]:
                vars_ = [r[0] for r in cur2.execute(
                    'SELECT variable, COUNT(*) FROM [%s] GROUP BY variable ORDER BY 2 DESC' % table).fetchall()]
            con.close()
        except Exception as e:
            logger.warning('ERA5 统计失败 %s/%s: %s', dbfile, table, e)
            continue
        cur.execute('INSERT INTO kb_era5_stats (db_file, table_name, name, count, min_date, max_date, variables_json) '
                    'VALUES (?,?,?,?,?,?,?)',
                    (dbfile, table, cname, cnt, row[0] if row else None, row[1] if row else None,
                     json.dumps(vars_ or [], ensure_ascii=False)))
        n += 1
    return n


def _build_methods(cur):
    cur.execute('DELETE FROM kb_methods')
    for m in METHODS_TEXT:
        cur.execute('INSERT INTO kb_methods (title, content, source) VALUES (?,?,?)',
                    (m['title'], m['content'], m['source']))
    return len(METHODS_TEXT)


def _build_sources(cur):
    cur.execute('DELETE FROM kb_sources')
    srcs = [
        ('灾害事件库', os.path.join(GEO_DIR, 'disaster'), '8 类冰冻圈灾害事件 GeoJSON（PFs/SFs/GLOFs/LLOFs/冰川跃动/RTS/雪崩/风吹雪）'),
        ('气象站点', os.path.join(GEO_DIR, 'station', 'weather_station.geojson'), '青藏高原气象站'),
        ('县域社会经济', os.path.join(ECON_DIR, 'GDP_data.csv'), '县域 GDP（2000-2015，万元）'),
        ('县域人口', os.path.join(PROCESSED_DIR, 'economy', 'county_population_latest.csv'), '县域人口'),
        ('水库', os.path.join(GEO_DIR, 'infrastructure', 'GDW_reservoirs.geojson'), '全球大坝水库数据（裁剪）'),
        ('水坝', os.path.join(GEO_DIR, 'infrastructure', 'GDW_barriers.geojson'), '全球大坝数据（裁剪）'),
        ('能源站点', os.path.join(GEO_DIR, 'powerplant.geojson'), '全球电站数据库（裁剪）'),
        ('冰川分布', os.path.join(GEO_DIR, 'TP_China_glaciers.geojson'), '中国冰川分布'),
        ('湖泊分布', os.path.join(GEO_DIR, 'TP_China_Lake.geojson'), '青藏高原湖泊'),
        ('河网水系', os.path.join(GEO_DIR, 'river.geojson'), '河网水系'),
        ('多年冻土', os.path.join(GEO_DIR, 'TP_China_permafrost.geojson'), '多年冻土分布'),
        ('ERA5 气象索引', os.path.join(DB_DIR, 'era5_index.db'), 'ERA5 再分析栅格索引（10万+）'),
        ('青藏高原气象索引', os.path.join(DB_DIR, 'TibetanPlateau_index.db'), '青藏高原气象栅格索引'),
        ('风险评估方法学', os.path.join(BASE_DIR, '洪水灾害风险评估技术文档.md'), 'R=H×E×V 方法与分级标准'),
        ('LSTM 径流模型', os.path.join(BASE_DIR, 'data', 'raw', 'models', 'lstm_runoff_model.pt'), '径流模拟模型'),
        ('洪水阈值场', os.path.join(BASE_DIR, 'data', 'raw', 'thresholds'), '10p-99p 百分位阈值栅格'),
    ]
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    for name, path, desc in srcs:
        exists = os.path.exists(path)
        size = os.path.getsize(path) if exists else 0
        cur.execute('INSERT INTO kb_sources (name, path, description, exists_flag, size_bytes, updated_at) '
                    'VALUES (?,?,?,?,?,?)',
                    (name, path, desc, 1 if exists else 0, size, now))
    return len(srcs)


# --------------------------------------------------------------------------
# 构建入口
# --------------------------------------------------------------------------
_SCHEMA = '''
CREATE TABLE IF NOT EXISTS kb_disaster_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT, type_name TEXT, country TEXT, region TEXT,
    lon REAL, lat REAL, began TEXT, ended TEXT, main_cause TEXT,
    deaths INTEGER, displaced INTEGER, affected_area REAL, rainfall_mm REAL,
    severity TEXT, elevation REAL, blocking_duration TEXT,
    glacier_info TEXT, area_approx REAL, reference TEXT, source_file TEXT
);
CREATE TABLE IF NOT EXISTS kb_stations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT, name TEXT, province TEXT, lon REAL, lat REAL, elevation REAL
);
CREATE TABLE IF NOT EXISTS kb_counties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, adcode TEXT, lon REAL, lat REAL,
    pop_latest REAL, gdp_latest_year INTEGER, gdp_latest REAL, gdp_2015 REAL,
    has_economy INTEGER
);
CREATE TABLE IF NOT EXISTS kb_infra (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT, kind_name TEXT, name TEXT, lon REAL, lat REAL, extra_json TEXT
);
CREATE TABLE IF NOT EXISTS kb_geo_overview (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT, kind_name TEXT, count INTEGER, note TEXT, stats_json TEXT
);
CREATE TABLE IF NOT EXISTS kb_era5_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    db_file TEXT, table_name TEXT, name TEXT,
    count INTEGER, min_date TEXT, max_date TEXT, variables_json TEXT
);
CREATE TABLE IF NOT EXISTS kb_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, content TEXT, source TEXT
);
CREATE TABLE IF NOT EXISTS kb_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, path TEXT, description TEXT,
    exists_flag INTEGER, size_bytes INTEGER, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cases_type ON kb_disaster_cases(type);
CREATE INDEX IF NOT EXISTS idx_cases_region ON kb_disaster_cases(region);
CREATE INDEX IF NOT EXISTS idx_cases_country ON kb_disaster_cases(country);
CREATE INDEX IF NOT EXISTS idx_counties_name ON kb_counties(name);
'''


def build_kb(force=False):
    """构建（幂等）。force=True 时重建全部表。"""
    _ensure_db_dir()
    con = sqlite3.connect(KB_DB_PATH)
    try:
        cur = con.cursor()
        cur.executescript(_SCHEMA)
        cnt = cur.execute('SELECT COUNT(*) FROM kb_sources').fetchone()[0]
        if cnt > 0 and not force:
            logger.info('知识库已存在（%d 个数据源），跳过构建。如需重建请调用 build_kb(force=True)', cnt)
            return {'rebuilt': False, 'sources': cnt}
        for fn in (_build_disaster_cases, _build_stations, _build_counties,
                   _build_infra, _build_geo_overview, _build_era5_stats,
                   _build_methods, _build_sources):
            fn(cur)
        con.commit()
        return {'rebuilt': True, 'sources': cnt}
    finally:
        con.close()


def get_kb_status():
    if not os.path.exists(KB_DB_PATH):
        return {'built': False}
    con = sqlite3.connect(KB_DB_PATH)
    try:
        cur = con.cursor()
        counts = {}
        for table in ('kb_disaster_cases', 'kb_stations', 'kb_counties', 'kb_infra',
                      'kb_geo_overview', 'kb_era5_stats', 'kb_methods', 'kb_sources'):
            counts[table] = cur.execute('SELECT COUNT(*) FROM [%s]' % table).fetchone()[0]
        return {'built': True, 'db': KB_DB_PATH, 'counts': counts}
    finally:
        con.close()


# --------------------------------------------------------------------------
# 检索（供 llm.py /api/llm/chat 使用）
# --------------------------------------------------------------------------
TYPE_KEYWORDS = {
    'rainfall_floods': ['降雨', '暴雨', '降水', 'PFs', '雨洪'],
    'snowmelt_floods': ['融雪', '雪融', 'SFs', '积雪融水'],
    'glacial_lake_floods': ['冰湖', '溃决', 'GLOF', '冰川湖'],
    'landslide_dam_floods': ['滑坡', '堰塞湖', 'LLOF', '堵江'],
    'glacier_surging': ['跃动', '冰川前进', 'surge'],
    'rts_qtp': ['热融', '滑塌', '热喀斯特', 'RTS', '冻土退化'],
    'avalanche_hazard': ['雪崩'],
    'blizzard_hazard': ['风吹雪', '白毛风', '暴风雪'],
}
GENERIC_TYPE_KEYWORDS = {'洪水': 'rainfall_floods', '洪灾': 'rainfall_floods'}
REGION_KEYWORDS = ['西藏', '青海', '新疆', '四川', '云南', '甘肃', '那曲', '阿里', '日喀则',
                   '拉萨', '昌都', '林芝', '山南', '玉树', '果洛', '海西', '格尔木', '西宁',
                   '喀什', '和田', '克孜勒苏', '阿克苏', '塔什库尔干', '帕米尔', '喜马拉雅',
                   '昆仑', '唐古拉', '冈底斯', '横断山', '祁连山', '念青唐古拉', '雅鲁藏布',
                   '印度', '尼泊尔', '不丹', '巴基斯坦', '塔吉克', '吉尔吉斯', '阿富汗']


def _detect_type(question):
    q = question.lower()
    hits = []
    for dtype, kws in TYPE_KEYWORDS.items():
        for kw in kws:
            if kw.lower() in q:
                hits.append(dtype)
                break
    if not hits:
        for kw, dtype in GENERIC_TYPE_KEYWORDS.items():
            if kw.lower() in q:
                hits.append(dtype)
                break
    return hits


def _detect_region(question):
    hits = []
    for kw in REGION_KEYWORDS:
        if kw in question:
            hits.append(kw)
    return hits


def _detect_year(question):
    m = re.search(r'(19|20)\d{2}', question)
    return int(m.group(0)) if m else None


def search_cases(types=None, regions=None, year=None, keyword=None, limit=10):
    if not os.path.exists(KB_DB_PATH):
        return []
    con = sqlite3.connect(KB_DB_PATH)
    try:
        cur = con.cursor()
        sql = 'SELECT id, type, type_name, country, region, lon, lat, began, ended, ' \
              'main_cause, deaths, displaced, affected_area, rainfall_mm, severity, ' \
              'elevation, blocking_duration, glacier_info, reference, source_file ' \
              'FROM kb_disaster_cases WHERE 1=1'
        params = []
        if types:
            sql += ' AND type IN (%s)' % ','.join('?' * len(types))
            params.extend(types)
        if regions:
            conds = []
            for r in regions:
                conds.append('(country LIKE ? OR region LIKE ?)')
                params.extend(['%' + r + '%'] * 2)
            sql += ' AND (' + ' OR '.join(conds) + ')'
        if year:
            sql += ' AND (began LIKE ? OR ended LIKE ?)'
            params.extend(['%' + str(year) + '%'] * 2)
        if keyword:
            sql += ' AND (region LIKE ? OR main_cause LIKE ? OR country LIKE ? OR type_name LIKE ?)'
            params.extend(['%' + keyword + '%'] * 4)
        sql += ' ORDER BY id LIMIT %d' % limit
        rows = cur.execute(sql, params).fetchall()
        cols = ['id', 'type', 'type_name', 'country', 'region', 'lon', 'lat', 'began', 'ended',
                'main_cause', 'deaths', 'displaced', 'affected_area', 'rainfall_mm', 'severity',
                'elevation', 'blocking_duration', 'glacier_info', 'reference', 'source_file']
        return [dict(zip(cols, r)) for r in rows]
    finally:
        con.close()


def get_disaster_stats():
    if not os.path.exists(KB_DB_PATH):
        return []
    con = sqlite3.connect(KB_DB_PATH)
    try:
        cur = con.cursor()
        rows = cur.execute(
            'SELECT type, type_name, COUNT(*) FROM kb_disaster_cases GROUP BY type ORDER BY 3 DESC').fetchall()
        return [{'type': r[0], 'type_name': r[1], 'count': r[2]} for r in rows]
    finally:
        con.close()


def get_exposure(region_keyword=None, limit=10):
    if not os.path.exists(KB_DB_PATH):
        return []
    con = sqlite3.connect(KB_DB_PATH)
    try:
        cur = con.cursor()
        sql = ('SELECT id, name, lon, lat, pop_latest, gdp_latest_year, gdp_latest, gdp_2015 '
               'FROM kb_counties WHERE has_economy=1')
        params = []
        if region_keyword:
            sql += ' AND name LIKE ?'
            params.append('%' + region_keyword + '%')
        sql += ' ORDER BY COALESCE(pop_latest, gdp_latest, 0) DESC LIMIT %d' % limit
        rows = cur.execute(sql, params).fetchall()
        cols = ['id', 'name', 'lon', 'lat', 'pop_latest', 'gdp_latest_year', 'gdp_latest', 'gdp_2015']
        return [dict(zip(cols, r)) for r in rows]
    finally:
        con.close()


def get_exposure_top(limit=10):
    return get_exposure(None, limit)


def get_geo_overview():
    if not os.path.exists(KB_DB_PATH):
        return []
    con = sqlite3.connect(KB_DB_PATH)
    try:
        cur = con.cursor()
        rows = cur.execute('SELECT kind, kind_name, count, note, stats_json FROM kb_geo_overview').fetchall()
        return [{'kind': r[0], 'kind_name': r[1], 'count': r[2], 'note': r[3], 'stats': r[4]} for r in rows]
    finally:
        con.close()


def get_era5_stats():
    if not os.path.exists(KB_DB_PATH):
        return []
    con = sqlite3.connect(KB_DB_PATH)
    try:
        cur = con.cursor()
        rows = cur.execute('SELECT name, count, min_date, max_date, variables_json FROM kb_era5_stats').fetchall()
        return [{'name': r[0], 'count': r[1], 'min_date': r[2], 'max_date': r[3], 'variables': r[4]} for r in rows]
    finally:
        con.close()


def get_methods():
    if not os.path.exists(KB_DB_PATH):
        return []
    con = sqlite3.connect(KB_DB_PATH)
    try:
        cur = con.cursor()
        rows = cur.execute('SELECT title, content, source FROM kb_methods').fetchall()
        return [{'title': r[0], 'content': r[1], 'source': r[2]} for r in rows]
    finally:
        con.close()


def build_context(question, max_cases=6):
    """核心：解析问题 -> 检索真实数据 -> 组装上下文（结构化文本 + 引用清单）。

    返回 dict:
      - text: 注入 prompt 的真实数据文本
      - citations: [{label, type, summary}] 溯源引用清单
    """
    types = _detect_type(question)
    regions = _detect_region(question)
    year = _detect_year(question)
    citations = []

    cases = search_cases(types=types or None, regions=regions or None,
                         year=year, limit=max_cases)
    if not cases and types:
        cases = search_cases(types=types, limit=max_cases)
    if not cases and regions:
        cases = search_cases(regions=regions, limit=max_cases)
    if not cases:
        cases = search_cases(limit=max_cases)

    case_text_lines = []
    for c in cases:
        label = '灾害案例#%d' % c['id']
        parts = ['%s (%s)' % (c['type_name'], label)]
        loc = ' / '.join(x for x in (c.get('region'), c.get('country')) if x)
        if loc:
            parts.append('位置:' + loc)
        if c.get('began'):
            parts.append('时间:' + str(c['began']))
        if c.get('lon') is not None:
            parts.append('坐标:(%.3f,%.3f)' % (c['lon'], c['lat']))
        if c.get('main_cause') and c['main_cause'] not in ('None', 'none'):
            parts.append('主因:' + str(c['main_cause']))
        if c.get('deaths') is not None:
            parts.append('死亡:%d人' % c['deaths'])
        if c.get('displaced') is not None:
            parts.append('转移:%d人' % c['displaced'])
        if c.get('affected_area') is not None:
            parts.append('影响面积:%.1f' % c['affected_area'])
        if c.get('rainfall_mm') is not None:
            parts.append('过程降雨:%.1fmm' % c['rainfall_mm'])
        if c.get('severity') and c['severity'] not in ('None', 'none'):
            parts.append('严重度:' + str(c['severity']))
        if c.get('elevation') is not None:
            parts.append('海拔:%.0fm' % c['elevation'])
        if c.get('blocking_duration'):
            parts.append('堵江:' + str(c['blocking_duration']))
        if c.get('glacier_info'):
            try:
                gi = json.loads(c['glacier_info'])
                gparts = ['冰川%s' % gi.get('glacier_id', '')]
                if gi.get('area_km2'):
                    gparts.append('面积%.1fkm²' % gi['area_km2'])
                if gi.get('zmax'):
                    gparts.append('最高海拔%.0fm' % gi['zmax'])
                if gi.get('slope_deg'):
                    gparts.append('坡度%.1f°' % gi['slope_deg'])
                if gi.get('surge_class_2020s'):
                    gparts.append('2020s跃动类型:%s' % gi['surge_class_2020s'])
                parts.append(';'.join(gparts))
            except Exception:
                pass
        if c.get('reference'):
            parts.append('文献来源:' + str(c['reference'])[:80])
        case_text_lines.append(' | '.join(parts))
        citations.append({'label': label, 'type': '灾害案例',
                          'summary': '%s %s %s' % (c['type_name'], loc or '位置未知', c.get('began') or '')})

    # 区域暴露度（有区域则优先匹配区域，无区域给总览）
    exposure = []
    exposure_note = '（未检索到与问题区域直接匹配的县域社会经济数据）'
    if regions:
        exposure = get_exposure(regions[0], 6)
        if not exposure:
            exposure_note = '（未检索到与「%s」直接匹配的县域社会经济数据）' % regions[0]
    else:
        exposure = get_exposure_top(5)
        if exposure:
            exposure_note = '（问题未指定区域，以下为系统县域人口/GDP 前列数据）'
    exposure_lines = []
    for e in exposure:
        label = '县域#%d' % e['id']
        parts = ['%s (%s)' % (e['name'], label)]
        if e.get('pop_latest'):
            parts.append('人口%.0f人' % e['pop_latest'])
        gdp_strs = []
        if e.get('gdp_latest') is not None:
            gdp_year = e.get('gdp_latest_year') or 0
            if gdp_year == 2015:
                gdp_strs.append('2015年GDP %.0f万元' % e['gdp_latest'])
            else:
                gdp_strs.append('%d年GDP %.0f万元' % (gdp_year, e['gdp_latest']))
                if e.get('gdp_2015') is not None:
                    gdp_strs.append('2015年GDP %.0f万元' % e['gdp_2015'])
        if gdp_strs:
            parts.append('；'.join(gdp_strs))
        exposure_lines.append(' | '.join(parts))
        citations.append({'label': label, 'type': '县域社会经济', 'summary': e['name']})

    overview = get_geo_overview()
    geo_lines = ['%s: %d 个要素' % (o['kind_name'], o['count']) for o in overview]

    era5 = get_era5_stats()
    era5_lines = []
    for s in era5:
        vars_str = ''
        if s.get('variables') and s['variables'] != '[]':
            try:
                vars_str = '（变量:' + ','.join(json.loads(s['variables'])) + '）'
            except Exception:
                pass
        era5_lines.append('%s: %d 个栅格 %s~%s%s' % (
            s['name'], s['count'], s.get('min_date') or '?', s.get('max_date') or '?', vars_str))

    methods = get_methods()

    text = []
    text.append('【一、真实灾害事件案例】（%d 条）' % len(cases))
    text.append('\n'.join(case_text_lines) if case_text_lines else '（未检索到与问题直接匹配的案例，以下为系统灾害库总览）')
    stats = get_disaster_stats()
    text.append('系统灾害库总览: ' + '; '.join('%s %d例' % (s['type_name'], s['count']) for s in stats))

    text.append('\n【二、区域承灾体暴露度（县域人口/GDP，真实数据）】')
    if exposure_lines:
        text.append('\n'.join(exposure_lines))
    else:
        text.append(exposure_note)

    text.append('\n【三、流域与地理要素概览（真实数据统计）】')
    text.append('\n'.join(geo_lines) if geo_lines else '（无概览数据）')

    text.append('\n【四、气象数据现状（ERA5 索引，真实清单）】')
    text.append('\n'.join(era5_lines) if era5_lines else '（无气象索引数据）')

    text.append('\n【五、本系统风险评估方法学（来源见引用）】')
    for m in methods:
        text.append('- %s：%s' % (m['title'], m['content']))
        citations.append({'label': '方法学#%s' % m['title'][:10], 'type': '方法学',
                          'summary': m['title'] + '（' + m['source'] + '）'})

    return {'text': '\n'.join(text), 'citations': citations}


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    import sys
    force = '--force' in sys.argv
    result = build_kb(force=force)
    print('构建结果:', result)
    print('知识库状态:', get_kb_status())
