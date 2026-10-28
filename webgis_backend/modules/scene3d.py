# -*- coding: utf-8 -*-
"""
三维示范区（Cesium 场景）后端接口。

路由契约：
  GET /api/3d/regions                     区域注册表（manifest 全量，前端区域下拉驱动）
  GET /api/3d/regions/<region_id>         单区域详情（bbox/zoom/layers/camera）
  GET /tiles3d/<region_id>/terrain/layer.json
                                          地形元数据。CesiumTerrainProvider.fromUrl
                                          必须先读到它（缺 format/tiles 会直接抛错）
  GET /tiles3d/<region_id>/terrain/<z>/<x>/<y>.terrain
                                          quantized-mesh 1.0 瓦片（TMS，y 从南数；
                                          网格为 2^(z+1) x 2^z，纬度线性划分）
  GET /tiles3d/<region_id>/vectors/<name>.geojson
                                          裁剪+简化后的矢量图层

安全约定（与 basin.py / app.py 现有静态路由一致）：
  - region_id 白名单正则校验 + 必须在 manifest 中注册（双重防目录穿越）
  - 矢量仅放行 .geojson 后缀，且用 resolve_within 校验真实路径在 vectors/ 内
  - 瓦片坐标做上界校验，越界直接 404

数据布局（data/processed/3d/，路径常量见 config.py）：
  regions.json                全域注册表（由 scripts/build_3d_tiles.py terrain 生成/更新）
  dem_filled.tif              DEM 空洞全域确定性填充产物
  <region>/terrain/           地形瓦片 + layer.json
  <region>/vectors/           简化矢量
"""
import os
import re

from flask import Blueprint, jsonify, current_app, send_file, abort

from modules.utils import load_json_cached, resolve_within

scene3d_bp = Blueprint('scene3d', __name__, url_prefix='/api/3d')
tiles3d_bp = Blueprint('tiles3d', __name__, url_prefix='/tiles3d')

# region_id 仅允许安全字符（防目录穿越第一道闸）
_REGION_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')

TERRAIN_MIME = 'application/vnd.quantized-mesh'


def _scene3d_dir():
    return current_app.config['SCENE3D_DIR']


def _load_manifest():
    """读取 regions.json；文件不存在时返回空注册表（系统未生成三维数据时不报错）。"""
    path = current_app.config['SCENE3D_MANIFEST']
    if not os.path.isfile(path):
        return {'version': 1, 'regions': []}
    return load_json_cached(path)


def _get_region(region_id):
    """按 id 取区域；未注册或 id 不合法返回 None。"""
    if not region_id or not _REGION_RE.match(region_id):
        return None
    manifest = _load_manifest()
    for region in manifest.get('regions', []):
        if region.get('id') == region_id:
            return region
    return None


# ---------------- 区域注册表 ----------------
@scene3d_bp.route('/regions', methods=['GET'])
def list_regions():
    manifest = _load_manifest()
    regions = manifest.get('regions', [])
    return jsonify({'success': True, 'count': len(regions), 'regions': regions})


@scene3d_bp.route('/regions/<region_id>', methods=['GET'])
def get_region(region_id):
    region = _get_region(region_id)
    if region is None:
        return jsonify({'success': False, 'message': '区域不存在'}), 404
    return jsonify({'success': True, 'region': region})


# ---------------- 地形瓦片 ----------------
@tiles3d_bp.route('/<region_id>/terrain/layer.json', methods=['GET'])
def terrain_layer_json(region_id):
    if _get_region(region_id) is None:
        abort(404)
    path = os.path.join(_scene3d_dir(), region_id, 'terrain', 'layer.json')
    if not os.path.isfile(path):
        abort(404)
    return send_file(path, mimetype='application/json')


@tiles3d_bp.route('/<region_id>/terrain/<int:z>/<int:x>/<int:y>.terrain',
                  methods=['GET'])
def terrain_tile(region_id, z, x, y):
    if _get_region(region_id) is None:
        abort(404)
    # GeographicTilingScheme：nx=2^(z+1), ny=2^z
    if z < 0 or z > 25 or x < 0 or y < 0 or x >= 2 * (2 ** z) or y >= 2 ** z:
        abort(404)
    path = os.path.join(_scene3d_dir(), region_id, 'terrain',
                        str(z), str(x), f'{y}.terrain')
    if not os.path.isfile(path):
        abort(404)
    return send_file(path, mimetype=TERRAIN_MIME, max_age=86400)


# ---------------- 影像瓦片（本地晕渲） ----------------
@tiles3d_bp.route('/<region_id>/imagery/<int:z>/<int:x>/<int:y>.png',
                  methods=['GET'])
def imagery_tile(region_id, z, x, y):
    if _get_region(region_id) is None:
        abort(404)
    # Web Mercator XYZ：nx = ny = 2^z
    n = 2 ** z
    if z < 0 or z > 22 or x < 0 or y < 0 or x >= n or y >= n:
        abort(404)
    path = os.path.join(_scene3d_dir(), region_id, 'imagery',
                        str(z), str(x), f'{y}.png')
    if not os.path.isfile(path):
        abort(404)
    return send_file(path, mimetype='image/png', max_age=86400)


# ---------------- 矢量图层 ----------------
@tiles3d_bp.route('/<region_id>/vectors/<name>.geojson', methods=['GET'])
def vector_layer(region_id, name):
    if _get_region(region_id) is None:
        abort(404)
    if not name or '/' in name or '\\' in name or '..' in name:
        abort(404)
    vec_dir = os.path.join(_scene3d_dir(), region_id, 'vectors')
    path = resolve_within(vec_dir, f'{name}.geojson')
    if path is None or not os.path.isfile(path):
        abort(404)
    return send_file(path, mimetype='application/geo+json', max_age=86400)
