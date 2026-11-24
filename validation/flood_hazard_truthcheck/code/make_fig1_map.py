# -*- coding: utf-8 -*-
"""重出图 1：危险性等级与验证点位分布（样式沿用 hazard_verify_holdout.py），
仅去掉图内标题，标题只保留在正文图注。

数据：outputs_v2/危险性栅格/危险性_p99_1980-01-01_to_2023-12-31.tif、
      outputs_v2/验证点位等级表.tsv（label=1 历史洪水点、0 随机对照点）。
输出：outputs_v2/图件/图1_危险性等级与验证点位.png|pdf（8×5 in，300 dpi）
"""
import os
import sys

import numpy as np
import pandas as pd
import geopandas as gpd
import rasterio
from rasterio.enums import Resampling

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PROJ, TP_BOUNDARY

BASE = os.path.join(str(PROJ), "validation", "flood_hazard_truthcheck", "outputs_v2")
FIG = os.path.join(BASE, "图件")
HAZ = os.path.join(BASE, "危险性栅格", "危险性_p99_1980-01-01_to_2023-12-31.tif")
PTS = os.path.join(BASE, "验证点位等级表.tsv")


def main():
    with rasterio.open(HAZ) as s:
        small = s.read(1, out_shape=(780, 1740), resampling=Resampling.nearest)
        ext = (s.bounds.left, s.bounds.right, s.bounds.bottom, s.bounds.top)

    d = pd.read_csv(PTS, sep="\t")
    pos = d[d.label == 1]
    neg = d[d.label == 0]

    plt.rcParams.update({"font.sans-serif": ["Microsoft YaHei", "SimHei", "DejaVu Sans"],
                         "axes.unicode_minus": False,
                         "font.size": 9, "axes.grid": True,
                         "grid.alpha": 0.25, "savefig.dpi": 300})
    fig, ax = plt.subplots(figsize=(8, 5))
    im = ax.imshow(np.where(small == 0, np.nan, small), extent=ext,
                   cmap="YlOrRd", vmin=1, vmax=5, interpolation="nearest")
    tp = gpd.read_file(TP_BOUNDARY)
    tp.boundary.plot(ax=ax, color="k", lw=0.6)
    ax.scatter(pos.lon, pos.lat, s=7, c="tab:blue", label="历史洪水点")
    ax.scatter(neg.lon, neg.lat, s=4, c="tab:green", alpha=0.4,
               label="随机对照点")
    ax.set_xlabel("经度", fontsize=11); ax.set_ylabel("纬度", fontsize=11)
    ax.tick_params(labelsize=9)
    ax.legend(loc="lower left", frameon=True, fontsize=9)

    cbar = fig.colorbar(im, ax=ax, shrink=0.6, label="危险性等级")
    cbar.set_label("危险性等级", fontsize=11)
    cbar.set_ticks([1, 2, 3, 4, 5])
    cbar.ax.tick_params(labelsize=9)
    fig.tight_layout()
    for ext_name in ("png", "pdf"):
        fig.savefig(os.path.join(FIG, "图1_危险性等级与验证点位." + ext_name))
    plt.close(fig)
    print("已保存", os.path.join(FIG, "图1_危险性等级与验证点位.png"))


if __name__ == "__main__":
    main()
