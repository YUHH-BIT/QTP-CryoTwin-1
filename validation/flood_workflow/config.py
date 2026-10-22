# -*- coding: utf-8 -*-
"""洪水危险性评估通用流程 —— 统一配置。

本文件已配置为本项目（E:/QTP‑CryoTwin）的实际目录与命名；
发给他人时，只需把下面各路径改到对方机器上的对应位置即可。

四个步骤各自独立运行（见 README.md）：

    python step1_runoff.py            # 1) 径流生成（可选，已有径流数据可跳过）
    python step2_threshold.py         # 2) 阈值栅格生成（历史径流分位数）
    python step3_hazard.py            # 3) 危险性生成
    python step4_validation.py        # 4) 危险性验证

命令行参数可覆盖这里的默认值（时间 --start/--end 为必填，必须每次运行时指定）。
"""
from pathlib import Path

# =====================================================================
# 1) 径流生成（step1_runoff.py）
# =====================================================================
# 气象驱动目录：每个变量一个子目录；
# 文件命名按本项目实际格式 {变量名}_{YYYY-MM-DD}.tif（如 temperature_2m_2024-01-01.tif）
METEOR_DIR = Path(r"F:\QTP‑CryoTwin\data\raw\TibetanPlateau")
VARIABLES = [
    "temperature_2m",
    "temperature_2m_max",
    "total_precipitation_max",
    "total_precipitation_sum",
]
# LSTM 模型文件（训练脚本见 Training/input/train.py 对应结构）
LSTM_MODEL = Path(r"F:\QTP‑CryoTwin\data\raw\models\lstm_runoff_model.pt")
# 径流输出目录（step1 写盘 / step2、step3 读取）
RUNOFF_DIR = Path(r"F:\QTP‑CryoTwin\data\webgis\outputs\runoff_results")
# 是否翻转数值方向（本项目 predict.py 采用 max-(x-min) 修正；常规模型请设 False）
FLIP_DIRECTION = True

# =====================================================================
# 2) 阈值栅格生成（step2_threshold.py）
# =====================================================================
# 阈值输出目录（也是 step3 的阈值输入目录）
THRESHOLD_DIR = Path(r"F:\QTP‑CryoTwin\data\raw\thresholds")
THRESHOLD_QUANTILES = "10,50,90,95,99"   # 要生成的分位数（逗号分隔）

# =====================================================================
# 3) 危险性生成（step3_hazard.py）
# =====================================================================
THRESHOLD_P = 99                     # 使用的阈值分位（10/50/90/95/99）
# 危险性输出目录
HAZARD_OUT_DIR = Path(r"F:\QTP‑CryoTwin\data\webgis\outputs\risk_results")
# 研究区边界（可选；None 则不做边界裁剪）
REGION_BOUNDARY = Path(r"F:\QTP‑CryoTwin\data\raw\geo\boundary\TP_China.geojson")
BASIN_NAME = "all"                   # 输出文件名中的流域标识

# =====================================================================
# 4) 危险性验证（step4_validation.py）
# =====================================================================
# 历史洪水点位：支持 SHP（用几何坐标）或 CSV（需要 lon/lat 两列）
POINTS_FILE = Path(r"F:\QTP‑CryoTwin\docs\历史洪水点位数据集\2004_2025\2004_2025.shp")
POINTS_SOURCE_CRS = "EPSG:4326"      # 点位的原始坐标系
RADIUS_KM = 1.0                      # 位置容差（km；0=精确像元）
RESULT_DIR = Path(r"F:\QTP‑CryoTwin\validation\flood_hazard_truthcheck\outputs")

# =====================================================================
# 时间范围 —— 参考示例值
# 注意：运行时时间必须由命令行 --start/--end 显式指定（必填），
# 下面的值只是文档示例，不会作为默认值使用。
# =====================================================================
START_DATE = "2024-01-01"
END_DATE = "2024-12-31"
