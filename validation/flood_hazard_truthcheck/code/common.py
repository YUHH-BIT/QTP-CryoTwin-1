# -*- coding: utf-8 -*-
"""洪水危险性真实性检验 —— 公共常量与栅格抽样工具。

三个脚本共用：points_prepare.py / hazard_verify.py / threshold_sensitivity.py
"""
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds

PROJ = Path(__file__).resolve().parents[3]          # E:\QTP-CryoTwin
BASE = PROJ / "validation" / "flood_hazard_truthcheck"
DATA_DIR = BASE / "data"
OUT_DIR = BASE / "outputs"

# ---- 输入数据（只引用，不复制） ----
POINTS_SRC = PROJ / "docs" / "历史洪水点位数据集"
CSV_2004_2025 = POINTS_SRC / "QinghaiTibet_Floods_2004_2025_Full.csv"
SHP_2004_2025 = POINTS_SRC / "2004_2025" / "2004_2025.shp"
SHP_1980_2003 = POINTS_SRC / "1980_2003" / "1980_2003.shp"

HAZARD_TIF = (PROJ / "data/webgis/outputs/risk_results"
              / "2024-01-01_to_2024-12-31_basin-all_hazard.tif")
# 汛期对照结果（保留 7-8 月被检验版本）
HAZARD_TIF_FLOOD = (PROJ / "data/webgis/outputs/risk_results"
                    / "2024-07-01_to_2024-08-31_basin-all_hazard.tif")
# 全时段合成结果（1980-2025 全部径流取时段最大，2026-09-28 用更新后的径流重算）
HAZARD_TIF_FULL = (PROJ / "data/webgis/outputs/risk_results"
                   / "1980-01-01_to_2025-12-31_basin-all_hazard.tif")
RUNOFF_DIR = PROJ / "data/webgis/outputs/runoff_results"
THRESHOLD_DIR = PROJ / "data/raw/thresholds"
TP_BOUNDARY = PROJ / "data/raw/geo/boundary" / "TP_China.geojson"

POINT_FILE = DATA_DIR / "points_2024_tp.geojson"

# ---- 检验口径 ----
YEAR = 2024
WINDOW = ("2024-01-01", "2024-12-31")      # 全年主口径（与被检验全年危险性结果同期）
WINDOW_FLOOD = ("2024-07-01", "2024-08-31")  # 汛期对照口径
RADII_KM = (0.0, 1.0, 3.0, 5.0)            # 位置容差
CUTOFF_MAIN, CUTOFF_ALT = 3, 4             # 中—高 / 较高—高
SAMPLE_RADIUS_KM = 1.0                     # 敏感性分析的统一容差
KM_PER_DEG = 111.0

# 2024 年径流/淹没栅格存在两套网格：7-8 月为 B（runoff 原生网格），危险性结果落在 A
GRID_A = (1560, 3479)
GRID_B = (1557, 3478)


def radius_to_deg(radius_km):
    return radius_km / KM_PER_DEG


def sample_max_level(arr, transform, xs, ys, radius_km):
    """每个点在 (arr, transform) 上的等级；radius_km=0 取像元本身，否则取窗口内最大值。

    窗口越界或完全落在栅格外时返回 -1（未覆盖，不计入分母）。
    """
    out = np.full(len(xs), -1, dtype=int)
    if radius_km <= 0:
        rows, cols = rasterio.transform.rowcol(transform, xs, ys)
        rows, cols = np.asarray(rows), np.asarray(cols)
        ok = (rows >= 0) & (rows < arr.shape[0]) & (cols >= 0) & (cols < arr.shape[1])
        out[ok] = arr[rows[ok], cols[ok]].astype(int)
        return out

    d = radius_to_deg(radius_km)
    h, w = arr.shape
    for i, (x, y) in enumerate(zip(xs, ys)):
        win = from_bounds(x - d, y - d, x + d, y + d, transform)
        r0 = max(int(np.floor(win.row_off)), 0)
        c0 = max(int(np.floor(win.col_off)), 0)
        r1 = min(int(np.ceil(win.row_off + win.height)), h)
        c1 = min(int(np.ceil(win.col_off + win.width)), w)
        if r1 <= r0 or c1 <= c0:
            continue
        out[i] = int(arr[r0:r1, c0:c1].max())
    return out


def sample_values(arr, transform, xs, ys):
    """按坐标取像元值；越界或非有限值返回 nan。"""
    rows, cols = rasterio.transform.rowcol(transform, xs, ys)
    rows, cols = np.asarray(rows), np.asarray(cols)
    out = np.full(len(xs), np.nan)
    ok = (rows >= 0) & (rows < arr.shape[0]) & (cols >= 0) & (cols < arr.shape[1])
    vals = arr[rows[ok], cols[ok]].astype(float)
    out[ok] = np.where(np.isfinite(vals), vals, np.nan)
    return out
