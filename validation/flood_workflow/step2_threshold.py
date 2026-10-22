# -*- coding: utf-8 -*-
"""步骤 2：阈值栅格生成。

输入：多年逐日径流 tif（runoff 目录，建议覆盖多年以代表历史径流特征）
输出：grid_threshold_{p}p.tif（逐像元分位数，float32，与 runoff 同网格）

阈值 = 每个像元在所选历史时段内径流值的分位数（如 99p = 第 99 百分位）。
后续 step3_hazard.py 用 runoff >= 阈值 判定淹没，因此阈值与 runoff 同量纲、
同网格、同覆盖范围。

用法（时间必填，自己选择用于计算阈值的历史年份）：
    python step2_threshold.py --start 2004-01-01 --end 2023-12-31
    python step2_threshold.py --start 2004-01-01 --end 2023-12-31 --quantiles 10,50,90,95,99

实现说明：为避免把多年径流一次性堆叠进内存，采用"行块流式"处理——
每个行块累积全部日期的径流值后逐像元算分位数，内存占用约
   天数 × 行块大小 × 列数 × 4 字节。
默认行块 20 行、约 2 GB 内存（8000 天 × 5 百万像元量级），
大区域或内存紧张时可用 --rows_per_block 调小。
"""
import argparse
import glob
import os
import time
import warnings

import numpy as np
import rasterio
from rasterio.windows import Window

import config


def main():
    ap = argparse.ArgumentParser(description="阈值栅格生成：多年 runoff -> 逐像元分位数")
    ap.add_argument("--runoff_dir", default=str(config.RUNOFF_DIR))
    ap.add_argument("--out_dir", default=str(config.THRESHOLD_DIR))
    ap.add_argument("--start", required=True, help="用于计算阈值的历史时段起，必填，如 2004-01-01")
    ap.add_argument("--end", required=True, help="用于计算阈值的历史时段止，必填，如 2023-12-31")
    ap.add_argument("--quantiles", default="10,50,90,95,99",
                    help="分位数列表（逗号分隔），默认 10,50,90,95,99")
    ap.add_argument("--rows_per_block", type=int, default=20,
                    help="行块大小（内存/速度权衡，默认 20）")
    args = ap.parse_args()

    quantiles = sorted({float(q) for q in args.quantiles.split(",") if q.strip()})
    os.makedirs(args.out_dir, exist_ok=True)

    # ---- 时段内 runoff 文件 ----
    files = sorted(glob.glob(os.path.join(args.runoff_dir, "*_runoff.tif")))
    files = [f for f in files if args.start <= os.path.basename(f)[:10] <= args.end]
    if not files:
        raise SystemExit(f"runoff 目录 {args.runoff_dir} 中 "
                         f"没有 {args.start}~{args.end} 的径流文件")
    print(f"参与阈值计算的径流文件: {len(files)} 天")

    # ---- 参考网格（第一个文件）----
    with rasterio.open(files[0]) as ref:
        H, W = ref.height, ref.width
        transform, crs = ref.transform, ref.crs
        profile = ref.profile
    profile.update(count=len(quantiles), dtype=rasterio.float32,
                   compress="lzw", nodata=np.nan)

    # ---- 打开全部文件句柄（复用，避免每块重复打开）；剔除网格不一致的文件 ----
    srcs = []
    skipped = 0
    for f in files:
        src = rasterio.open(f)
        if src.shape != (H, W) or src.transform != transform:
            src.close()
            skipped += 1
            continue
        srcs.append(src)
    if skipped:
        print(f"注意: {skipped} 个 runoff 文件网格与参考不一致已跳过，请先统一网格再算阈值")
    if not srcs:
        raise SystemExit("没有网格一致的 runoff 文件，无法计算阈值")
    n_days = len(srcs)
    print(f"参与阈值计算的径流文件: {n_days} 天")

    # ---- 行块流式分位数 ----
    t0 = time.time()
    results = {q: np.full((H, W), np.nan, dtype=np.float32) for q in quantiles}
    n_block = 0
    for r0 in range(0, H, args.rows_per_block):
        r1 = min(r0 + args.rows_per_block, H)
        n_block += 1
        acc = np.full((n_days, r1 - r0, W), np.nan, dtype=np.float32)
        for t, src in enumerate(srcs):
            acc[t] = src.read(1, window=Window(0, r0, W, r1 - r0)).astype(np.float32)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            for q in quantiles:
                results[q][r0:r1, :] = np.nanpercentile(acc, q, axis=0)
        if n_block % 20 == 0 or r1 >= H:
            print(f"  行 {r1}/{H}（{n_block} 块），耗时 {time.time()-t0:.0f} s")
    for s in srcs:
        s.close()

    # ---- 输出（每分位一个单波段 tif）----
    for q in quantiles:
        p_int = int(round(q))
        out_path = os.path.join(args.out_dir, f"grid_threshold_{p_int}p.tif")
        with rasterio.open(out_path, "w", **profile) as dst:
            dst.write(results[q], 1)
        print(f"输出: {out_path}")
    print(f"完成，共 {len(quantiles)} 个分位，耗时 {time.time()-t0:.0f} s")


if __name__ == "__main__":
    main()
