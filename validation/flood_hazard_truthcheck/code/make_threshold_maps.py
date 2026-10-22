# -*- coding: utf-8 -*-
"""多阈值危险性空间对比图（2×3 面板，共用分级图例）。

用法：
    python make_threshold_maps.py --hazard_dir <dir> --start 2024-01-01 \
        --end 2024-12-31 --quantiles 10,50,90,95,99 --tag 2024
"""
import argparse
from pathlib import Path

import numpy as np
import geopandas as gpd
import rasterio
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.colors import ListedColormap
from matplotlib.patches import Patch

from common import OUT_DIR, TP_BOUNDARY

for _f in font_manager.fontManager.ttflist:
    if "YaHei" in _f.name:
        plt.rcParams["font.family"] = _f.name
        break
plt.rcParams["axes.unicode_minus"] = False

FIG_DIR = OUT_DIR / "figures"
FIG_DIR.mkdir(exist_ok=True)
LVL_COLORS = ["#f7f7f7", "#2c7bb6", "#abd9e9", "#ffffbf", "#fdae61", "#d7191c"]


def main():
    ap = argparse.ArgumentParser(description="多阈值危险性空间对比")
    ap.add_argument("--hazard_dir", required=True)
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--basin", default="all")
    ap.add_argument("--quantiles", default="10,50,90,95,99")
    ap.add_argument("--tag", required=True)
    args = ap.parse_args()

    stamp = "%s_to_%s_basin-%s" % (args.start, args.end, args.basin)
    quantiles = [int(q) for q in args.quantiles.split(",") if q.strip()]

    # 淹没面积占比以「边界内有效像元」为分母（与 threshold_summary_*.csv 一致），
    # 避免用整幅栅格（含研究区外）导致比例被稀释
    frac_map = {}
    summ = Path(args.hazard_dir) / ("threshold_summary_%s.csv" % stamp)
    if summ.exists():
        import pandas as pd
        sdf = pd.read_csv(summ, encoding="utf-8-sig")
        frac_map = dict(zip(sdf["quantile"].astype(int),
                            sdf["inundated_frac"].astype(float)))

    panels = []
    for q in quantiles:
        p = Path(args.hazard_dir) / ("%s_hazard_p%d.tif" % (stamp, q))
        if not p.exists():
            print("缺文件，跳过: %s" % p.name)
            continue
        with rasterio.open(p) as s:
            arr = s.read(1).astype(np.int16)
            tr, crs = s.transform, s.crs
        frac = frac_map.get(q, float("nan"))
        panels.append((q, arr, tr, frac))
    if not panels:
        raise SystemExit("没有可用的危险性栅格")

    tp = gpd.read_file(TP_BOUNDARY).to_crs(crs)

    ncol, nrow = 3, 2
    fig, axes = plt.subplots(nrow, ncol, figsize=(4.1 * ncol, 3.3 * nrow))
    axes = np.atleast_1d(axes).ravel()
    for ax, (q, arr, tr, frac) in zip(axes, panels):
        ax.imshow(arr, cmap=ListedColormap(LVL_COLORS), vmin=0, vmax=5,
                  interpolation="nearest",
                  extent=(tr.c, tr.c + tr.a * arr.shape[1],
                          tr.f + tr.e * arr.shape[0], tr.f))
        tp.boundary.plot(ax=ax, color="#4d4d4d", linewidth=0.4)
        ax.set_title("%dp 阈值（淹没 %.1f%%）" % (q, 100 * frac), fontsize=10)
        ax.set_xlim(73, 105); ax.set_ylim(25, 40)
        ax.set_aspect(1 / np.cos(np.radians(35)))
        ax.set_xticks([]); ax.set_yticks([])
    for ax in axes[len(panels):]:
        ax.axis("off")

    handles = [Patch(facecolor=LVL_COLORS[k], edgecolor="#666666", linewidth=0.4,
                     label="%d 级" % k) for k in range(1, 6)]
    handles.append(Patch(facecolor="#f7f7f7", edgecolor="#666666", linewidth=0.4,
                         label="未淹没"))
    axes[-1].legend(handles=handles, loc="center", frameon=False, fontsize=9,
                    ncol=2)
    fig.suptitle("%s 洪水危险性等级：不同阈值分位对比" % (
        args.start[:4] if args.start[:4] == args.end[:4]
        else "%s–%s 年" % (args.start[:4], args.end[:4])), fontsize=13)
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    fig.savefig(FIG_DIR / ("hazard_by_threshold_%s.png" % args.tag), dpi=300)
    fig.savefig(FIG_DIR / ("hazard_by_threshold_%s.pdf" % args.tag))
    print("图: %s" % (FIG_DIR / ("hazard_by_threshold_%s.png" % args.tag)))


if __name__ == "__main__":
    main()
