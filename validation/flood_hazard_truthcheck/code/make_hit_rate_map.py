# -*- coding: utf-8 -*-
"""空间图：SHP 洪水点位与危险性等级分布（分级底图版）。

底图分级 1–5 级；SHP 点位：命中 = 落入危险性区（等级 > 0，任意分区）；
标题标注命中率；图例为分级色块 + 点位符号（两列）。
输出：outputs/figures/hit_rate_map.png（300 dpi）/.pdf
"""
import argparse
import numpy as np
import pandas as pd
import geopandas as gpd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.colors import ListedColormap
from matplotlib.patches import Patch
from matplotlib.lines import Line2D
import rasterio

from common import OUT_DIR, HAZARD_TIF, TP_BOUNDARY

FIG_DIR = OUT_DIR / "figures"
FIG_DIR.mkdir(exist_ok=True)

# 中文字体（Microsoft YaHei）
for f in font_manager.fontManager.ttflist:
    if "YaHei" in f.name:
        plt.rcParams["font.family"] = f.name
        break
plt.rcParams["axes.unicode_minus"] = False

# 等级配色：0 未淹没白 / 1 蓝 / 2 浅蓝 / 3 黄 / 4 橙 / 5 红
LVL_COLORS = ["#f7f7f7", "#2c7bb6", "#abd9e9", "#ffffbf", "#fdae61", "#d7191c"]

# 0) 参数（默认 = 2024 年主口径；全时段检验用 --hazard/--points/--out 覆盖）
ap = argparse.ArgumentParser(description="洪水点位命中率空间分布图")
ap.add_argument("--hazard", default=str(HAZARD_TIF), help="危险性栅格 tif")
ap.add_argument("--points", default=str(OUT_DIR / "points_2024_tp_levels.csv"),
                help="点位等级表 csv（含 source / lon / lat / level_*km）")
ap.add_argument("--out", default="hit_rate_map", help="输出文件名（不含扩展名）")
ap.add_argument("--title", default="2024 年洪水危险性等级与历史洪水点位分布")
ap.add_argument("--radius", type=float, default=1.0, help="主口径位置容差 km")
ap.add_argument("--source", default="shp_combined", help="参与统计的点位来源")
args = ap.parse_args()
lvl_col = f"level_{int(args.radius)}km" if args.radius == int(args.radius) \
    else f"level_{str(args.radius).replace('.', '_')}km"

# 1) 读危险性栅格（分级 0–5）与 TP 边界
with rasterio.open(args.hazard) as src:
    arr = src.read(1).astype(np.int16)
    transform, crs = src.transform, src.crs
bnd = gpd.read_file(TP_BOUNDARY).to_crs(crs)

# 2) 读 SHP 点位，命中 = level > 0
df = pd.read_csv(args.points, encoding="utf-8-sig")
shp = df[df.source == args.source]
hit = shp[shp[lvl_col] > 0]
miss = shp[shp[lvl_col] <= 0]
rate = len(hit) / len(shp)

# 3) 绘图
fig, ax = plt.subplots(figsize=(7.2, 4.4))
ax.imshow(arr, cmap=ListedColormap(LVL_COLORS), vmin=0, vmax=5,
          interpolation="nearest",
          extent=(transform.c, transform.c + transform.a * arr.shape[1],
                  transform.f + transform.e * arr.shape[0], transform.f))
bnd.boundary.plot(ax=ax, color="#4d4d4d", linewidth=0.6)
ax.scatter(miss.lon, miss.lat, s=18, marker="^", facecolor="none",
           edgecolor="#333333", linewidth=0.6, zorder=3, label="_nolegend_")
ax.scatter(hit.lon, hit.lat, s=20, marker="^", facecolor="#00a65a",
           edgecolor="white", linewidth=0.4, zorder=4, label="_nolegend_")

handles = [Patch(facecolor=LVL_COLORS[k], edgecolor="#666666", linewidth=0.4,
                 label=f"{k} 级") for k in range(1, 6)]
handles += [Patch(facecolor="#f7f7f7", edgecolor="#666666", linewidth=0.4,
                  label="未淹没"),
            Line2D([], [], marker="^", linestyle="none", markersize=6,
                   markerfacecolor="#00a65a", markeredgecolor="white",
                   label="洪水点位（落入危险性区）"),
            Line2D([], [], marker="^", linestyle="none", markersize=6,
                   markerfacecolor="none", markeredgecolor="#333333",
                   label="洪水点位（未落入）")]
ax.legend(handles=handles, loc="lower left", ncol=2, frameon=False,
          handlelength=1.2, handletextpad=0.5, columnspacing=1.0)
ax.set_xlabel("经度 (°E)"); ax.set_ylabel("纬度 (°N)")
ax.set_xlim(73, 105); ax.set_ylim(25, 40)
ax.set_aspect(1 / np.cos(np.radians(35)))
ax.set_title(args.title, fontsize=12)
fig.savefig(FIG_DIR / f"{args.out}.png", dpi=300)
fig.savefig(FIG_DIR / f"{args.out}.pdf")
print(f"命中率 {rate:.1%}（{len(hit)}/{len(shp)}）")
print(f"输出 outputs/figures/{args.out}.png/.pdf")
