# -*- coding: utf-8 -*-
"""
全局配置。
安全约定：
- 所有 API 密钥/管理员密码一律通过环境变量或 .env 文件注入，严禁硬编码真实密钥。
- .env 已被 .gitignore 忽略，不会进入版本库。
"""
import os

BASE_DIR = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))

# 灾害类型 -> (GeoJSON 文件名, 中文名)
# 模块级常量（而非 Config 类属性）：disaster.py（图层加载）与 expert_kb.py（知识库 RAG）
# 均需在**导入期**读取它，此时 Flask app 尚未创建、拿不到 current_app.config。
# 单一数据源，新增灾害类型只改这一处，避免两处不同步。
DISASTER_TYPES = [
    ('rainfall_floods', 'PFs_HMA.geojson', '降雨型洪水(PFs)'),
    ('snowmelt_floods', 'SFs_HMA.geojson', '融雪型洪水(SFs)'),
    ('glacial_lake_floods', 'GLOFs_HMA.geojson', '冰湖溃决型洪水(GLOFs)'),
    ('landslide_dam_floods', 'LLOFs_HMA.geojson', '滑坡堰塞湖溃决型洪水(LLOFs)'),
    ('glacier_surging', 'surging_glacier_inventory_gamdam_v2.geojson', '冰川跃动'),
    ('rts_qtp', 'RTS-QTP.geojson', '热融滑塌(RTS)'),
    ('avalanche_hazard', '雪崩危害范围.geojson', '雪崩灾害'),
    ('blizzard_hazard', '风吹雪危害范围.geojson', '风吹雪灾害'),
]


def _load_env_file(env_path):
    """轻量 .env 解析：优先使用 python-dotenv；未安装时用内置解析兜底。"""
    try:
        from dotenv import load_dotenv
        load_dotenv(env_path)
        return
    except ImportError:
        pass
    if not os.path.isfile(env_path):
        return
    with open(env_path, 'r', encoding='utf-8-sig') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, value = line.partition('=')
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


# 加载项目根目录下的 .env（密钥/配置统一从环境变量读取）
_load_env_file(os.path.join(BASE_DIR, '.env'))


class Config:
    BASE_DIR = BASE_DIR

    DEBUG = False
    # 生产环境务必通过环境变量 SECRET_KEY 注入强随机密钥（用于 Flask session 签名）
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-insecure-secret-change-me')

    # ---- WebGIS 子系统数据区 ----
    # 统一收口在项目级数据区 data/webgis/，不再散落在后端代码目录内。
    # 按语义分三层（与 data/raw、data/processed 同级）：
    #   content/  业务内容数据（决策知识库 / 专家名录 JSON）—— 交付物，入库
    #   uploads/  用户上传数据（社会经济 Excel）—— 入库
    #   outputs/  系统运行产物（径流 / 淹没 / 风险栅格）—— 可再生，不入库
    WEBGIS_DATA_DIR = os.path.join(BASE_DIR, 'data', 'webgis')
    CONTENT_DIR = os.path.join(WEBGIS_DATA_DIR, 'content')
    UPLOADS_DIR = os.path.join(WEBGIS_DATA_DIR, 'uploads')
    OUTPUTS_DIR = os.path.join(WEBGIS_DATA_DIR, 'outputs')

    # ---- 三维示范区数据区（Cesium quantized-mesh 地形 / 简化矢量 / 区域注册表）----
    # 由 scripts/build_3d_tiles.py 生成；接口契约见 modules/scene3d.py。
    #   regions.json          全域注册表（区域唯一入口，新增区域只加记录不改代码）
    #   dem_filled.tif        DEM 空洞全域确定性填充产物
    #   <region>/terrain/     地形瓦片 + layer.json
    #   <region>/vectors/     裁剪+简化矢量
    SCENE3D_DIR = os.path.join(BASE_DIR, 'data', 'processed', '3d')
    SCENE3D_MANIFEST = os.path.join(SCENE3D_DIR, 'regions.json')

    # 已废弃别名：STATIC_BACKEND_DIR 原指向 webgis_backend/static，
    # 现等价于 OUTPUTS_DIR。仅为兼容存量脚本保留，新代码一律用 OUTPUTS_DIR。
    STATIC_BACKEND_DIR = OUTPUTS_DIR

    # 品牌资源（桌面快捷方式图标 / favicon 同源，见 assets/branding/README.md）
    BRANDING_DIR = os.path.join(BASE_DIR, 'assets', 'branding')
    APP_ICON = os.path.join(BRANDING_DIR, 'app-icon.ico')

    # 数据库配置
    DATABASE_PATH = os.environ.get(
        'DATABASE_PATH',
        os.path.join(BASE_DIR, 'data', 'processed', 'db', 'TibetanPlateau_index.db')
    )

    # 高德 API（只从环境变量读取；未配置时相关功能返回明确错误）
    AMAP_KEY = os.environ.get('AMAP_KEY', '')

    # DeepSeek API（决策支持智能体专用，只从环境变量读取）
    DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY', '')
    DEEPSEEK_MODEL = os.environ.get('DEEPSEEK_MODEL', 'deepseek-v4-flash')
    DEEPSEEK_API_URL = os.environ.get(
        'DEEPSEEK_API_URL', 'https://api.deepseek.com/chat/completions')

    # 系统账号（登录认证用；生产环境务必通过环境变量覆盖默认密码）
    ADMIN_USERNAME = os.environ.get('ADMIN_USERNAME', 'admin')
    ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')
    OPERATOR_USERNAME = os.environ.get('OPERATOR_USERNAME', 'operator')
    OPERATOR_PASSWORD = os.environ.get('OPERATOR_PASSWORD', 'operator123')
    VIEWER_USERNAME = os.environ.get('VIEWER_USERNAME', 'viewer')
    VIEWER_PASSWORD = os.environ.get('VIEWER_PASSWORD', 'viewer123')

    # 上传文件大小限制
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB

    # 模型 / 阈值 / DEM 目录
    MODELS_DIR = os.path.join(BASE_DIR, 'data', 'raw', 'models')
    THRESHOLDS_DIR = os.path.join(BASE_DIR, 'data', 'raw', 'thresholds')
    # 待确认：当前 data/raw/dem/wholeYarkant.tif 不存在，且全项目无任何代码引用 DEM_FILE。
    # 磁盘上实际存在的是 data/processed/dem/web_dem.tif。
    # 因该路径属数据口径，未擅自改动，保留原值并标注。
    DEM_FILE = os.path.join(BASE_DIR, 'data', 'raw', 'dem', 'wholeYarkant.tif')

    # 输出目录（运行产物，落在 data/webgis/outputs/ 下）
    RUNOFF_OUTPUT_DIR = os.path.join(OUTPUTS_DIR, 'runoff_results')
    FLOOD_INUNDATION_DIR = os.path.join(OUTPUTS_DIR, 'flood_inundation')
    RISK_RESULTS_DIR = os.path.join(OUTPUTS_DIR, 'risk_results')
    MASKS_DIR = os.path.join(OUTPUTS_DIR, 'masks')
    PNGS_DIR = os.path.join(OUTPUTS_DIR, 'pngs')
    ANIMATIONS_DIR = os.path.join(OUTPUTS_DIR, 'animations')

    # ERA5 / GeoTIFF 数据目录
    ERA5_DATA_DIR = os.path.join(BASE_DIR, 'data', 'raw', 'TibetanPlateau')
    TIF_ROOT_DIR = os.path.join(BASE_DIR, 'data', 'raw', 'TibetanPlateau')

    # GLDAS 融雪数据目录（原 snowmelt_flood.py 中硬编码，统一收口到配置）
    GLDAS_SNOWMELT_DIR = os.path.join(BASE_DIR, 'data', 'raw', 'GLDAS025_Snowmelt')
    GLDAS_SNOWMELT_MAX_DIR = os.path.join(BASE_DIR, 'data', 'processed', 'GLDAS_snowmelt_max')

    # 流域边界 / 河流 / 行政区划 GeoJSON
    # 注意：TibetanPlateau.geojson 实际是 106 个气象站点（Point），不是边界，
    # 仅历史遗留被当作 SHAPEFILE_PATH 使用，勿当作研究区范围。
    # 注：data/raw/geo/ 自 2026-09-07 起按语义分 8 个子目录：
    #   disaster / boundary / hydrology / cryosphere /
    #   infrastructure / settlement / station / socioeconomic
    SHAPEFILE_PATH = os.path.join(
        BASE_DIR, 'data', 'raw', 'geo', 'station', 'TibetanPlateau.geojson')
    RIVER_PATH = os.path.join(
        BASE_DIR, 'data', 'raw', 'geo', 'hydrology', 'river.geojson')
    # 注：原 CMA_PATH（data/raw/geo/cma.geojson）已移除 —— 该文件不存在，
    # 且 basin.get_cma_geojson() 实际读取的是 TP_Stations.geojson，从未使用过该配置。

    # 研究区总边界：青藏高原中国境内（与前端地图默认常显的 TP_China 图层同源）。
    # 它是所有栅格模拟的默认上界 —— 未选流域时按它裁剪，选了流域时取 流域 ∩ 它。
    # 驱动栅格覆盖 68.02~104.69°E（整个青藏高原，含境外），
    # 而本边界为 73.45~104.69°E，两者相差 591,992 个像元。
    REGION_BOUNDARY_PATH = os.path.join(
        BASE_DIR, 'data', 'raw', 'geo', 'boundary', 'TP_China.geojson')

    # 气象变量列表
    VARIABLES = [
        "temperature_2m",
        "temperature_2m_max",
        "total_precipitation_max",
        "total_precipitation_sum"
    ]

    @classmethod
    def ensure_dirs(cls):
        """确保输出目录存在（在 create_app 时调用，避免 import 副作用）。"""
        for d in (cls.RUNOFF_OUTPUT_DIR, cls.FLOOD_INUNDATION_DIR,
                  cls.RISK_RESULTS_DIR, cls.MASKS_DIR, cls.PNGS_DIR,
                  cls.ANIMATIONS_DIR, cls.MODELS_DIR, cls.THRESHOLDS_DIR,
                  cls.CONTENT_DIR, cls.GLDAS_SNOWMELT_MAX_DIR, cls.UPLOADS_DIR,
                  cls.SCENE3D_DIR):
            os.makedirs(d, exist_ok=True)


class DevelopmentConfig(Config):
    DEBUG = True


class ProductionConfig(Config):
    pass


config = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig
}