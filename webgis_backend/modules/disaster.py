from flask import Blueprint, jsonify, current_app
import os
import json
import logging
from config import DISASTER_TYPES
from modules.utils import get_project_root, load_json_cached

# 设置日志
logger = logging.getLogger(__name__)

# 创建蓝图
disaster_bp = Blueprint('disaster', __name__)

def load_disaster_data(disaster_type):
    """加载灾害数据的公共函数"""
    try:
        # 支持的灾害类型（单一数据源见 config.DISASTER_TYPES）
        valid_types = {key: filename for key, filename, _ in DISASTER_TYPES}

        if disaster_type not in valid_types:
            logger.error(f"无效的灾害类型: {disaster_type}")
            return None
        
        filename = valid_types[disaster_type]
        project_root = get_project_root()
        # DISASTER_TYPES 中列出的 8 类灾害 GeoJSON 均位于 geo/disaster/
        geojson_path = os.path.join(project_root, 'data', 'raw', 'geo',
                                    'disaster', filename)
        
        logger.info(f"尝试加载灾害数据文件: {geojson_path}")
        
        # 检查文件是否存在
        if not os.path.exists(geojson_path):
            logger.error(f"灾害数据文件不存在: {geojson_path}")
            return None
        
        # 检查文件大小，确保文件不为空
        if os.path.getsize(geojson_path) == 0:
            logger.warning(f"灾害数据文件为空: {geojson_path}")
            return None
        
        # 读取文件（带缓存）
        data = load_json_cached(geojson_path)
        
        # 验证数据格式
        if 'features' not in data:
            logger.warning(f"灾害数据格式不正确，缺少features字段")
            return None
        
        logger.info(f"成功加载灾害数据，共{len(data.get('features', []))}个要素")
        return data
        
    except json.JSONDecodeError as e:
        logger.error(f"解析灾害数据JSON失败: {str(e)}")
        return None
    except Exception as e:
        logger.error(f"加载灾害数据时出错: {str(e)}")
        return None

@disaster_bp.route('/api/disaster/<disaster_type>')
def get_disaster_data(disaster_type):
    """获取冰冻圈灾害数据"""
    try:
        logger.info(f"获取灾害数据请求: {disaster_type}")
        
        # 加载灾害数据
        disaster_data = load_disaster_data(disaster_type)
        
        if disaster_data is None:
            logger.error(f"无法加载灾害数据: {disaster_type}")
            return jsonify({
                'error': '灾害数据文件不存在或格式错误',
                'disaster_type': disaster_type
            }), 404
        
        if 'features' not in disaster_data:
            logger.error(f"灾害数据缺少features字段: {disaster_type}")
            return jsonify({
                'error': '灾害数据格式不正确',
                'disaster_type': disaster_type
            }), 500
        
        feature_count = len(disaster_data['features'])
        logger.info(f"成功返回 {feature_count} 个灾害数据要素")
        
        # 确保返回正确的JSON格式，避免坐标被转换为字符串
        response = current_app.response_class(
            response=json.dumps(disaster_data, ensure_ascii=False),
            status=200,
            mimetype='application/json'
        )
        return response
        
    except Exception as e:
        logger.error(f"获取灾害数据时出错: {str(e)}")
        return jsonify({
            'error': '获取灾害数据失败',
            'disaster_type': disaster_type
        }), 500

@disaster_bp.route('/api/disaster/types')
def get_disaster_types():
    """获取所有灾害类型信息（数量从数据文件动态统计，缺失文件计数为 0）"""
    meta = {
        'rainfall_floods': ('降雨型洪水（PFs）', '由强降雨引发的洪水事件'),
        'snowmelt_floods': ('融雪型洪水（SFs）', '由积雪融化引发的洪水事件'),
        'glacial_lake_floods': ('冰湖溃决型洪水（GLOFs）', '由冰川湖溃决引发的洪水事件'),
        'landslide_dam_floods': ('滑坡堰塞湖溃决型洪水（LLOFs）', '由滑坡形成的堰塞湖溃决引发的洪水事件'),
        'glacier_surging': ('冰川跃动（Surging）', '冰川周期性快速前进引发的灾害事件'),
        'rts_qtp': ('热融滑塌（RTS）', '青藏高原热融滑塌/热喀斯特灾害'),
        'blizzard_hazard': ('风吹雪危害', '风吹雪导致的积雪与能见度灾害'),
        'avalanche_hazard': ('雪崩危害', '山区雪崩灾害事件'),
    }
    types = []
    for tid, (name, desc) in meta.items():
        data = load_disaster_data(tid)
        count = len(data.get('features', [])) if data else 0
        types.append({'id': tid, 'name': name, 'count': count, 'description': desc})
    return jsonify(types)