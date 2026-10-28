# -*- coding: utf-8 -*-
"""三维示范区（Cesium quantized-mesh 地形）回归测试。

覆盖（对应 docs/01_技术思路/07_三维示范区建设方案.md 的验收项）：
  1. 瓦片网格与 Cesium GeographicTilingScheme / TMS global-geodetic 一致
     （2^(z+1) x 2^z、纬度线性划分、y 从南数）—— 防止与 OSM slippy 网格混用
  2. quantized-mesh 编解码往返（参考解码器的 Python 移植，即"消费端验证"）：
     首元素绝对值 / (u,v) 网格集合 / 高度量化 / 三角形索引 / 边索引 / 法线扩展
  3. 相邻瓦片接缝连续性（共享边高程差 < 1m）
  4. layer.json 契约（format/scheme/tiles/maxzoom/available）
  5. Flask 路由与路径安全（区域白名单、越界瓦片 404、矢量后缀/穿越防护、
     /cesium/ 静态路由可用）
  6. DISASTER_TYPES 单一数据源（生成脚本与 config 一致）

运行：pytest tests/test_scene3d.py   或   python tests/test_scene3d.py
（数据未生成时，涉及已生成瓦片的用例自动跳过。）
"""
import importlib.util
import json
import os
import struct
import sys
import tempfile

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, 'webgis_backend')
SCRIPTS = os.path.join(ROOT, 'scripts')
for _p in (BACKEND, ROOT, SCRIPTS):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# ---- 加载生成脚本（scripts/ 无 __init__.py，用 importlib 按路径加载）----
_spec = importlib.util.spec_from_file_location(
    'build_3d_tiles', os.path.join(SCRIPTS, 'build_3d_tiles.py'))
build_3d_tiles = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_3d_tiles)

from config import DISASTER_TYPES  # noqa: E402

SCENE3D_DIR = os.path.join(ROOT, 'data', 'processed', '3d')
PREFILL_DEM = os.path.join(SCENE3D_DIR, 'dem_filled.tif')
RAW_DEM = os.path.join(ROOT, 'data', 'processed', 'dem', 'TP_China_dem_cog.tif')
MANIFEST = os.path.join(SCENE3D_DIR, 'regions.json')

# 测试用瓦片：拉萨周边（z8，地理网格 nx=512 ny=256），数据完整无空洞
TZ, TXA, TXB, TY, N = 8, 385, 386, 170, 32

PASS, FAIL = [], []


def check(name, ok, detail=''):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f'  {detail}' if detail else ''))
    return ok


def _prefill_complete():
    """prefill 是否已跑完（以日志里的完成信号为准，避免读到半成品文件）。"""
    log = os.path.join(SCENE3D_DIR, 'prefill.log')
    if not os.path.isfile(PREFILL_DEM) or not os.path.isfile(log):
        return False
    try:
        with open(log, encoding='utf-8', errors='ignore') as f:
            return 'prefill done' in f.read()
    except OSError:
        return False


def pick_dem():
    """优先用 prefill 产物（必须已跑完）；否则退回原始 DEM
    （测试瓦片位于拉萨周边完整数据区，结论不受影响）。"""
    if _prefill_complete():
        return PREFILL_DEM
    return RAW_DEM


# ================================================================ 参考解码器
# 逻辑移植自 @here/quantized-mesh-decoder（MIT），与 Cesium 解码算法一致。
def _zzdec(v):
    return (v >> 1) ^ (-(v & 1))


_HDR = [('centerX', 'd'), ('centerY', 'd'), ('centerZ', 'd'),
        ('minHeight', 'f'), ('maxHeight', 'f'),
        ('bsX', 'd'), ('bsY', 'd'), ('bsZ', 'd'), ('bsR', 'd'),
        ('hopX', 'd'), ('hopY', 'd'), ('hopZ', 'd')]


def decode_terrain(data):
    off = 0
    header = {}
    for name, code in _HDR:
        header[name] = struct.unpack_from('<' + code, data, off)[0]
        off += struct.calcsize('<' + code)
    assert off == 88, f'header size {off} != 88'
    (vcount,) = struct.unpack_from('<I', data, off)
    off += 4
    ua = np.frombuffer(data, dtype='<u2', count=vcount, offset=off); off += 2 * vcount
    va = np.frombuffer(data, dtype='<u2', count=vcount, offset=off); off += 2 * vcount
    ha = np.frombuffer(data, dtype='<u2', count=vcount, offset=off); off += 2 * vcount

    def cum(arr):
        out = np.empty(len(arr), dtype=np.int64)
        acc = 0
        for i, v in enumerate(arr):
            acc += _zzdec(int(v))
            out[i] = acc
        return out

    isize = 4 if vcount > 65536 else 2
    idtype = '<u4' if vcount > 65536 else '<u2'
    while off % isize:
        off += 1
    (tcount,) = struct.unpack_from('<I', data, off)
    off += 4
    tris = np.frombuffer(data, dtype=idtype, count=tcount * 3, offset=off)
    off += tcount * 3 * isize
    # high-water-mark 解码
    idxs = np.empty(len(tris), dtype=np.int64)
    highest = 0
    for i, code in enumerate(tris):
        idxs[i] = highest - int(code)
        if code == 0:
            highest += 1
    edges = {}
    for name in ('west', 'south', 'east', 'north'):
        (cnt,) = struct.unpack_from('<I', data, off)
        off += 4
        edges[name] = np.frombuffer(data, dtype=idtype, count=cnt, offset=off)
        off += cnt * isize
    normals = None
    while off < len(data):
        (eid,) = struct.unpack_from('<B', data, off); off += 1
        (elen,) = struct.unpack_from('<I', data, off); off += 4
        if eid == 1:
            normals = np.frombuffer(data, dtype=np.uint8, count=elen, offset=off)
        off += elen
    return dict(header=header, vcount=vcount, u=cum(ua), v=cum(va), h=cum(ha),
                tris=idxs, edges=edges, normals=normals)


def gen_tile(z, x, y, grid_n=N, dem=None):
    return build_3d_tiles.encode_tile(z, x, y, grid_n, dem or pick_dem(), 462.0)


# ================================================================ 用例
def test_tile_grid_matches_cesium_geographic_scheme():
    print('\n1. 瓦片网格契约（Cesium GeographicTilingScheme / TMS global-geodetic）')
    check('z0 网格为 2x1', build_3d_tiles.tile_grid(0) == (2, 1))
    check('z10 网格为 2048x1024', build_3d_tiles.tile_grid(10) == (2048, 1024))
    # 纬度线性划分：z1 的 y=0 覆盖 -90..0，y=1 覆盖 0..90
    b0 = build_3d_tiles.tile_bounds_tms(1, 0, 0)
    check('z1 (0,0) 覆盖 (-180,-90)-(-90,0)', b0 == (-180.0, -90.0, -90.0, 0.0), str(b0))
    b1 = build_3d_tiles.tile_bounds_tms(1, 3, 1)
    check('z1 (3,1) 覆盖 (90,0)-(180,90)', b1 == (90.0, 0.0, 180.0, 90.0), str(b1))
    # 珠峰所在瓦片（z10）：经度 86.93E -> x=1518；纬度 27.99N -> y_tms=671
    # （osm slippy 网格会给出 x=759/y=594，正是要防的错）
    nx, ny = build_3d_tiles.tile_grid(10)
    ex = int((86.925 + 180) / 360 * nx)
    ey_tms = ny - 1 - int((90 - 27.988) / 180 * ny)
    check('珠峰 z10 瓦片为 (1518, 671)，非 slippy 的 (759, 594)',
          (ex, ey_tms) == (1518, 671), f'({ex},{ey_tms})')


def test_encode_decode_roundtrip():
    print('\n2. quantized-mesh 编解码往返（参考解码器）')
    data = gen_tile(TZ, TXA, TY)
    check('瓦片字节生成成功', data is not None and len(data) > 1000,
          f'{len(data) if data else 0} bytes')
    if data is None:
        return
    d = decode_terrain(data)
    n = d['vcount']
    check('顶点数 = 33x33 = 1089', n == 1089, str(n))
    check('header 高程合理', 0 < d['header']['minHeight'] < 9000
          and 0 < d['header']['maxHeight'] < 9000,
          f"{d['header']['minHeight']:.0f}~{d['header']['maxHeight']:.0f}")
    check('高度量化值在 [0,32767]', d['h'].min() >= 0 and d['h'].max() <= 32767,
          f"{d['h'].min()}~{d['h'].max()}")
    # (u,v) 集合必须恰好等于预期网格（抓顶点重排类 bug）
    uv = sorted(int(a) * 100000 + int(b) for a, b in zip(d['u'], d['v']))
    expected = sorted(round(i / N * 32767) * 100000 + round(j / N * 32767)
                      for j in range(N + 1) for i in range(N + 1))
    check('解码 (u,v) 集合 == 预期网格', uv == expected)
    check('三角形数量 = 32x32x2 = 2048', len(d['tris']) == 2048 * 3)
    check('三角形索引均 < 顶点数', d['tris'].max() < n, f"max={d['tris'].max()}")
    for side in ('west', 'south', 'east', 'north'):
        check(f'{side} 边索引数 = 33', len(d['edges'][side]) == 33,
              str(len(d['edges'][side])))
    check('oct 法线扩展存在且长度 = 2x顶点数',
          d['normals'] is not None and len(d['normals']) == 2 * n,
          str(len(d['normals']) if d['normals'] is not None else None))


def test_seam_continuity():
    print('\n3. 相邻瓦片接缝连续性')
    a = gen_tile(TZ, TXA, TY)
    b = gen_tile(TZ, TXB, TY)
    if a is None or b is None:
        check('两个相邻瓦片均生成成功', False)
        return
    da, db = decode_terrain(a), decode_terrain(b)
    ea = da['edges']['east']
    eb = db['edges']['west']
    check('东西边索引数量一致', len(ea) == len(eb), f'{len(ea)} vs {len(eb)}')
    ha, hb = da['header'], db['header']
    elev_a = ha['minHeight'] + (ha['maxHeight'] - ha['minHeight']) * da['h'][ea] / 32767.0
    elev_b = hb['minHeight'] + (hb['maxHeight'] - hb['minHeight']) * db['h'][eb] / 32767.0
    maxdiff = float(np.abs(elev_a - elev_b).max())
    check('共享边高程差 < 1m', maxdiff < 1.0, f'maxDiff={maxdiff:.3f}m')


def test_z0_root_tiles():
    print('\n2b. z0 根瓦片（Cesium 根节点两块均可用）')
    a = gen_tile(0, 0, 0)   # 西半球：无 DEM 数据 -> 应生成平坦瓦片而非跳过
    b = gen_tile(0, 1, 0)   # 东半球：含 DEM
    check('z0 (0,0) 平坦瓦片生成', a is not None and len(a) > 1000,
          f'{len(a) if a else 0} bytes')
    check('z0 (1,0) 数据瓦片生成', b is not None and len(b) > 1000,
          f'{len(b) if b else 0} bytes')
    if a:
        da = decode_terrain(a)
        check('z0 (0,0) 顶点数 1089', da['vcount'] == 1089)
        check('z0 (0,0) 为平坦瓦片（max-min < 1m）',
              da['header']['maxHeight'] - da['header']['minHeight'] < 1.0,
              f"{da['header']['minHeight']:.0f}~{da['header']['maxHeight']:.0f}")
    if b:
        db = decode_terrain(b)
        check('z0 (1,0) 顶点数 1089', db['vcount'] == 1089)
        check('z0 (1,0) 高程范围合理',
              0 < db['header']['minHeight'] < 9000
              and 0 < db['header']['maxHeight'] < 9000,
              f"{db['header']['minHeight']:.0f}~{db['header']['maxHeight']:.0f}")


def test_layer_json_contract():
    print('\n4. layer.json 契约')
    path = os.path.join(SCENE3D_DIR, 'tp_full', 'terrain', 'layer.json')
    if not os.path.isfile(path):
        print('  [SKIP] tp_full 地形未生成')
        return
    with open(path, encoding='utf-8') as f:
        layer = json.load(f)
    check('format = quantized-mesh-1.0', layer.get('format') == 'quantized-mesh-1.0')
    check('scheme = tms（Cesium 地形只认 tms）', layer.get('scheme') == 'tms')
    check('tiles 模板含 {z}/{x}/{y}.terrain',
          layer.get('tiles') == ['{z}/{x}/{y}.terrain'])
    check('maxzoom 为整数', isinstance(layer.get('maxzoom'), int))
    check('available 按层级给出矩形',
          isinstance(layer.get('available'), list)
          and all(isinstance(lv, list) for lv in layer['available']))
    check('z0 根瓦片可用（available[0] 非空）',
          len(layer['available'][0]) > 0 if layer['available'] else False)
    # available 中的瓦片必须真实存在（抽样）
    terrain_dir = os.path.join(SCENE3D_DIR, 'tp_full', 'terrain')
    ok = True
    for zi, rects in enumerate(layer['available']):
        for r in rects[:2]:
            p = os.path.join(terrain_dir, str(zi), str(r['startX']),
                             f"{r['startY']}.terrain")
            if not os.path.isfile(p):
                ok = False
    check('抽样 available 瓦片文件存在', ok)


def test_routes_and_security():
    print('\n5. Flask 路由与路径安全')
    import werkzeug  # noqa: F401
    from app import create_app
    app = create_app('default')
    app.config['TESTING'] = True
    client = app.test_client()

    rules = {str(r.rule) for r in app.url_map.iter_rules()}
    check('已注册 /api/3d/regions', '/api/3d/regions' in rules)
    check('已注册 /tiles3d/<region>/terrain/layer.json',
          '/tiles3d/<region_id>/terrain/layer.json' in rules)
    check('已注册 /cesium/<path:filename>', '/cesium/<path:filename>' in rules)

    r = client.get('/api/3d/regions')
    check('GET /api/3d/regions -> 200', r.status_code == 200)
    body = r.get_json() or {}
    check('regions 返回 success + regions 数组',
          body.get('success') is True and isinstance(body.get('regions'), list))

    r = client.get('/api/3d/regions/no_such_region')
    check('未注册区域 -> 404', r.status_code == 404)
    r = client.get('/tiles3d/no_such_region/terrain/layer.json')
    check('未注册区域瓦片 -> 404', r.status_code == 404)

    # 越界瓦片坐标 -> 404（而非 500 或穿越）
    r = client.get('/tiles3d/tp_full/terrain/10/99999/99999.terrain')
    check('越界瓦片坐标 -> 404', r.status_code == 404)
    r = client.get('/tiles3d/tp_full/terrain/0/5/0.terrain')
    check('z0 越界 x -> 404', r.status_code == 404)

    # 矢量：后缀白名单 + 路径穿越防护
    r = client.get('/tiles3d/tp_full/vectors/..%2F..%2Fetc.geojson')
    check('矢量路径穿越 -> 404', r.status_code == 404)
    r = client.get('/tiles3d/tp_full/vectors/glaciers.tif')
    check('非 geojson 后缀 -> 404', r.status_code == 404)

    # Cesium 静态资源（自托管引擎）
    r = client.get('/cesium/Cesium.js')
    check('GET /cesium/Cesium.js -> 200', r.status_code == 200)
    r = client.get('/cesium/Workers/createVerticesFromQuantizedTerrainMesh.js')
    check('GET cesium Worker -> 200', r.status_code == 200)

    # 若数据已生成：真实瓦片可访问且 MIME 正确
    tile = os.path.join(SCENE3D_DIR, 'tp_full', 'terrain', '10', '1518', '670.terrain')
    if os.path.isfile(tile):
        r = client.get('/tiles3d/tp_full/terrain/10/1518/670.terrain')
        check('真实地形瓦片 -> 200 且 MIME 正确',
              r.status_code == 200
              and 'quantized-mesh' in (r.headers.get('Content-Type') or ''),
              r.headers.get('Content-Type') or '')
    else:
        print('  [SKIP] tp_full 瓦片未生成，跳过真实瓦片访问断言')


def test_disaster_types_single_source():
    print('\n6. DISASTER_TYPES 单一数据源')
    check('生成脚本与 config 的 DISASTER_TYPES 一致',
          build_3d_tiles.DISASTER_TYPES == DISASTER_TYPES,
          f'{len(DISASTER_TYPES)} 类')


def _run_standalone():
    tests = [(k, v) for k, v in sorted(globals().items())
             if k.startswith('test_') and callable(v)]
    for _, fn in tests:
        try:
            fn()
        except Exception as e:
            import traceback
            traceback.print_exc()
            FAIL.append(f'{fn.__name__} 异常: {e}')
    print(f'\n===== {len(PASS)} passed, {len(FAIL)} failed =====')
    for f in FAIL:
        print(f'  FAIL: {f}')
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(_run_standalone())
