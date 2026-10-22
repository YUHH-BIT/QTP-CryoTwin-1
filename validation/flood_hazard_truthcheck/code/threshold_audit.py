# -*- coding: utf-8 -*-
"""阈值栅格体检：检验 grid_threshold_*.tif 是否符合「逐像元分位数」语义。

判据（逐日 runoff >= 阈值 的像元比例，按年统计）：
    若阈值 = 某像元历史序列的 q 分位数，则任一年该像元超阈天数占比应约为 (100−q)%，
    因此「单日超阈像元比例」的年均值也应约为 (100−q)%：
        10p→~90%、50p→~50%、90p→~10%、95p→~5%、99p→~1%
    若实测明显偏离，说明阈值与当前径流不同源（口径/网格/数值方向不一致）。

另附：阈值栅格与该年径流最大值/均值的逐像元相关性（空间格局是否自洽）。

用法：
    python threshold_audit.py --runoff_dir <dir> --threshold_dir <dir> \
        --quantiles 10,50,90,95,99 --years 2024,2010
"""
import argparse
import glob
import os
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import reproject

from common import OUT_DIR


def load_thr(path, ref_shape=None, ref_transform=None, ref_crs=None):
    with rasterio.open(path) as s:
        a = s.read(1).astype(np.float32)
        if ref_shape is None or (a.shape == ref_shape and s.transform == ref_transform):
            return a, (s.height, s.width)
        out = np.full(ref_shape, np.nan, dtype=np.float32)
        reproject(source=a, src_transform=s.transform, src_crs=s.crs,
                  destination=out, dst_transform=ref_transform, dst_crs=ref_crs,
                  src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.bilinear)
        return out, ref_shape


def main():
    ap = argparse.ArgumentParser(description="阈值栅格分位语义体检")
    ap.add_argument("--runoff_dir", required=True)
    ap.add_argument("--threshold_dir", required=True)
    ap.add_argument("--quantiles", default="10,50,90,95,99")
    ap.add_argument("--years", default="2024", help="检验年份，逗号分隔")
    args = ap.parse_args()

    quantiles = [int(q) for q in args.quantiles.split(",") if q.strip()]
    years = [int(y) for y in args.years.split(",") if y.strip()]
    lines = ["# 阈值栅格分位语义体检", "",
             f"- 阈值目录：`{args.threshold_dir}`",
             f"- 径流目录：`{args.runoff_dir}`", ""]

    for year in years:
        files = sorted(glob.glob(os.path.join(args.runoff_dir, "%d-*_runoff.tif" % year)))
        if not files:
            lines.append(f"## {year} 年：无径流文件，跳过\n")
            continue
        with rasterio.open(files[0]) as s:
            ref_shape, ref_transform, ref_crs = (s.height, s.width), s.transform, s.crs
        thrs = {}
        for q in quantiles:
            p = os.path.join(args.threshold_dir, f"grid_threshold_{q}p.tif")
            thrs[q], tshape = load_thr(p, ref_shape, ref_transform, ref_crs)
        lines += [f"## {year} 年（{len(files)} 天，栅格 {tshape[1]}×{tshape[0]}）", "",
                  "| 阈值分位 | 超阈比例应为 | 实测年均超阈比例 | 日最小 | 日最大 | 判定 |",
                  "|---:|---:|---:|---:|---:|---|"]
        daily = {q: [] for q in quantiles}
        mean_acc = np.zeros(ref_shape, dtype=np.float64)
        max_acc = np.full(ref_shape, -np.inf, dtype=np.float32)
        n_use = 0
        for f in files:
            with rasterio.open(f) as s:
                a = s.read(1).astype(np.float32)
            if a.shape != ref_shape:
                continue
            n_use += 1
            mean_acc += np.nan_to_num(a, nan=0.0)
            np.fmax(max_acc, a, out=max_acc)
            for q in quantiles:
                m = np.isfinite(a) & np.isfinite(thrs[q])
                v = m.sum()
                daily[q].append(float((a[m] >= thrs[q][m]).mean()) if v else np.nan)
        mean_acc /= max(n_use, 1)
        for q in quantiles:
            arr = np.array(daily[q])
            obs = float(np.nanmean(arr))
            exp = (100 - q) / 100.0
            verdict = "符合" if abs(obs - exp) <= max(0.02, 0.25 * exp) else \
                ("偏高 %.1f 倍" % (obs / exp) if obs > exp else "偏低")
            lines.append("| %dp | ~%d%% | %.2f%% | %.2f%% | %.2f%% | %s |" % (
                q, 100 - q, 100 * obs, 100 * np.nanmin(arr), 100 * np.nanmax(arr), verdict))
        lines.append("")

        # 空间格局自洽性：阈值 vs 该年径流均值/最大值
        lines += ["**阈值栅格与该年径流统计量的空间相关性（逐像元）**", "",
                  "| 阈值分位 | 该年径流均值 | 该年径流最大值 |", "|---:|---:|---:|"]
        for q in quantiles:
            m = np.isfinite(thrs[q]) & np.isfinite(mean_acc.astype(np.float32)) & \
                np.isfinite(max_acc)
            if m.sum() < 10:
                lines.append("| %dp | - | - |" % q)
                continue
            c1 = np.corrcoef(thrs[q][m], mean_acc.astype(np.float32)[m])[0, 1]
            c2 = np.corrcoef(thrs[q][m], max_acc[m])[0, 1]
            lines.append("| %dp | %.3f | %.3f |" % (q, c1, c2))
        lines += ["", "> 若阈值确为该像元历史分位数，应与该年径流统计量明显正相关（>0.8）。",
                  "> 出现负相关＝阈值与径流空间格局相反，说明二者不同源。", ""]

    out = OUT_DIR / ("threshold_audit_%s.md" % "_".join(str(y) for y in years))
    out.write_text("\n".join(lines), encoding="utf-8")
    print("报告: %s" % out)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
