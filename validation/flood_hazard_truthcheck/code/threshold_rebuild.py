# -*- coding: utf-8 -*-
"""按留出方案重建逐像元分位阈值（1980-01-01 ~ 2023-12-31）。

与 step2_threshold.py 语义一致：阈值 = 每个像元在指定历史时段内径流值的分位数。
实现差异：行块流式 + 文件句柄常驻，避免把 44 年径流一次性读入内存；分位数用
就地 partition 的最近秩定义（第 ceil(q/100*n) 小的值），并单独修正少数
“部分日期缺测”的像元。

输出：
    {out_dir}/grid_threshold_{q}p.tif   （float32，nodata=nan，与 runoff 同网格）
    {out_dir}/threshold_rebuild_report.md

用法：
    python threshold_rebuild.py --runoff_dir <dir> --out_dir <dir> \
        --start 1980-01-01 --end 2023-12-31 --quantiles 10,50,90,95,99
"""
import argparse
import glob
import os
import time

import numpy as np
import rasterio
from rasterio.windows import Window


def main():
    ap = argparse.ArgumentParser(description="留出期逐像元分位阈值重建")
    ap.add_argument("--runoff_dir", required=True)
    ap.add_argument("--out_dir", required=True)
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--quantiles", default="10,50,90,95,99")
    ap.add_argument("--rows_per_block", type=int, default=100)
    args = ap.parse_args()

    quantiles = [int(q) for q in args.quantiles.split(",") if q.strip()]
    os.makedirs(args.out_dir, exist_ok=True)

    files = sorted(glob.glob(os.path.join(args.runoff_dir, "*_runoff.tif")))
    files = [f for f in files if args.start <= os.path.basename(f)[:10] <= args.end]
    if not files:
        raise SystemExit("时段内没有 runoff 文件")

    with rasterio.open(files[0]) as ref:
        H, W = ref.height, ref.width
        transform, crs, profile = ref.transform, ref.crs, ref.profile

    # 只保留与参考网格一致的文件（1980-2023 应全部一致，不一致则明确剔除）
    srcs, skipped = [], []
    for f in files:
        s = rasterio.open(f)
        if (s.height, s.width) != (H, W) or s.transform != transform:
            skipped.append(os.path.basename(f))
            s.close()
            continue
        srcs.append(s)
    n = len(srcs)
    print("参考网格 %dx%d；参与阈值计算 %d 天；网格不一致剔除 %d 个" %
          (W, H, n, len(skipped)))
    if not srcs:
        raise SystemExit("没有网格一致的 runoff 文件")

    # 逐分位的最近秩（第 k 小，0 基）
    ranks = {q: int(np.ceil(q / 100.0 * n)) - 1 for q in quantiles}
    print("像元天数 n=%d，秩=%s" % (n, ranks))

    result = {q: np.full((H, W), np.nan, dtype=np.float32) for q in quantiles}
    n_partial_total = 0

    t0 = time.time()
    for r0 in range(0, H, args.rows_per_block):
        r1 = min(r0 + args.rows_per_block, H)
        rows = r1 - r0
        # 先按 (天, 行, 列) 连续写入（I/O 友好），再转成 (行, 列, 天)，
        # 使每个像元的时间序列在内存中连续，partition 沿末轴快 3~4 倍。
        stack = np.empty((n, rows, W), dtype=np.float32)
        valid_count = np.zeros((rows, W), dtype=np.uint16)
        for t, s in enumerate(srcs):
            a = s.read(1, window=Window(0, r0, W, rows)).astype(np.float32)
            fin = np.isfinite(a)
            valid_count += fin
            a[~fin] = np.inf
            stack[t] = a
        block = np.ascontiguousarray(np.moveaxis(stack, 0, -1))  # (rows, W, n)
        del stack
        for q in quantiles:
            block.partition(ranks[q], axis=-1)
            result[q][r0:r1] = block[:, :, ranks[q]]

        # 部分缺测像元：按各自有效值重算（通常极少）
        partial = (valid_count > 0) & (valid_count < n)
        npix = int(partial.sum())
        n_partial_total += npix
        if npix:
            rr, cc = np.nonzero(partial)
            for r, c in zip(rr, cc):
                v = block[r, c, :]
                v = v[np.isfinite(v)]
                for q in quantiles:
                    result[q][r0 + r, c] = np.percentile(v, q)
        # 全缺测像元保持 NaN
        zero = valid_count == 0
        if zero.any():
            for q in quantiles:
                result[q][r0:r1][zero] = np.nan

        print("  行 %d/%d（%.0f%%），耗时 %.0f s，部分缺测像元累计 %d" %
              (r1, H, 100.0 * r1 / H, time.time() - t0, n_partial_total))

    for s in srcs:
        s.close()

    out_profile = profile.copy()
    out_profile.update(count=1, dtype="float32", nodata=np.nan, compress="lzw")
    lines = ["# 留出期阈值重建报告", "",
             "- 时段：`%s ~ %s`" % (args.start, args.end),
             "- 参与径流文件：%d 天" % n,
             "- 网格：%d×%d，CRS `%s`" % (H, W, crs),
             "- 网格不一致剔除：%d 个%s" % (
                 len(skipped), ("（" + ", ".join(skipped[:5]) + "…）") if skipped else ""),
             "- 分位定义：逐像元最近秩（第 ceil(q/100×n) 小）",
             "- 部分缺测像元：%d 个（按各自有效值重算）" % n_partial_total,
             "", "| 分位 | 文件 | 有效像元 | min | p50 | max |",
             "|---:|---|---:|---:|---:|---:|"]
    for q in quantiles:
        a = result[q]
        fin = np.isfinite(a)
        path = os.path.join(args.out_dir, "grid_threshold_%dp.tif" % q)
        with rasterio.open(path, "w", **out_profile) as dst:
            dst.write(a, 1)
        lines.append("| %dp | `%s` | %d | %.4f | %.4f | %.4f |" % (
            q, os.path.basename(path), int(fin.sum()),
            float(np.nanmin(a)), float(np.nanmedian(a)), float(np.nanmax(a))))
        print("输出 %s" % path)
    report = os.path.join(args.out_dir, "threshold_rebuild_report.md")
    with open(report, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("报告 %s；总耗时 %.1f 分钟" % (report, (time.time() - t0) / 60))


if __name__ == "__main__":
    main()
