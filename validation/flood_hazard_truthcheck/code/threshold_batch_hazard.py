# -*- coding: utf-8 -*-
"""多阈值危险性批量生成（一次遍历径流，同时产出多个分位阈值的结果）。

算法与 flood_workflow/step3_hazard.py 完全一致（逐日淹没 → 时段最大 → 淹没区
min-max 归一化 → 20/40/60/80 分位分 1–5 级），区别只在于：
    对 N 个阈值栅格共享同一次 runoff 读取与边界掩膜，I/O 只花一遍。

输出：
    {start}_to_{end}_basin-{basin}_hazard_p{q}.tif   （uint8，0 未淹没，1–5 级）
    threshold_summary.csv                             （各阈值的淹没面积与等级构成）

用法：
    python threshold_batch_hazard.py --start 2024-01-01 --end 2024-12-31
    python threshold_batch_hazard.py --start 1980-01-01 --end 2025-12-31 \
        --quantiles 10,50,90,95,99
"""
import argparse
import glob
import os
import time

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import reproject


def load_grid_nan(path):
    with rasterio.open(path) as src:
        arr = src.read(1).astype(np.float32)
        if src.nodata is not None:
            arr = np.where(arr == src.nodata, np.nan, arr)
        return arr, src.transform, src.crs


def align_to_reference(data, src_transform, src_crs, ref_shape, ref_transform, ref_crs):
    if data.shape == ref_shape and src_transform == ref_transform:
        return data
    out = np.full(ref_shape, np.nan, dtype=np.float32)
    reproject(source=data, src_transform=src_transform, src_crs=src_crs,
              destination=out, dst_transform=ref_transform, dst_crs=ref_crs,
              src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.bilinear)
    return out


def main():
    ap = argparse.ArgumentParser(description="多阈值危险性批量生成")
    ap.add_argument("--runoff_dir", required=True)
    ap.add_argument("--threshold_dir", required=True)
    ap.add_argument("--out_dir", required=True)
    ap.add_argument("--boundary", default="")
    ap.add_argument("--basin", default="all")
    ap.add_argument("--quantiles", default="10,50,90,95,99")
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    args = ap.parse_args()

    quantiles = [int(q) for q in args.quantiles.split(",") if q.strip()]
    os.makedirs(args.out_dir, exist_ok=True)

    files = sorted(glob.glob(os.path.join(args.runoff_dir, "*_runoff.tif")))
    files = [f for f in files if args.start <= os.path.basename(f)[:10] <= args.end]
    if not files:
        raise SystemExit("时段内没有 runoff 文件: %s ~ %s" % (args.start, args.end))
    print("时段内径流文件: %d 天" % len(files))

    with rasterio.open(files[0]) as ref:
        ref_shape, ref_transform, ref_crs = (ref.height, ref.width), ref.transform, ref.crs
        profile = ref.profile
    profile.update(count=1, dtype=rasterio.uint8, compress="lzw", nodata=0)
    print("参考网格: %s" % str(ref_shape))

    # ---- 阈值（逐分位对齐到参考网格）----
    thrs = []
    for q in quantiles:
        p = os.path.join(args.threshold_dir, f"grid_threshold_{q}p.tif")
        if not os.path.exists(p):
            raise SystemExit("阈值文件不存在: %s" % p)
        a, t, c = load_grid_nan(p)
        thrs.append(align_to_reference(a, t, c, ref_shape, ref_transform, ref_crs))
    print("阈值已对齐: %s" % quantiles)

    # ---- 边界掩膜（只算一次）----
    bmask = None
    if args.boundary and os.path.exists(args.boundary):
        import geopandas as gpd
        from rasterio.mask import mask as rio_mask
        gdf = gpd.read_file(args.boundary).to_crs(ref_crs)
        with rasterio.open(files[0]) as ref:
            out_img, _ = rio_mask(ref, [gdf.geometry.union_all()], crop=False,
                                  nodata=0, filled=True, invert=False)
        bmask = out_img[0] > 0
        print("研究区边界掩膜完成，边界内像元 %d" % int(bmask.sum()))

    # ---- 一次遍历，累积 N 个阈值的淹没最大场 ----
    haz = [np.zeros(ref_shape, dtype=np.float32) for _ in quantiles]
    buf = np.zeros(ref_shape, dtype=np.float32)
    t0 = time.time()
    n_mis = 0
    for i, f in enumerate(files, 1):
        arr, t, c = load_grid_nan(f)
        if arr.shape != ref_shape or t != ref_transform:
            arr = align_to_reference(arr, t, c, ref_shape, ref_transform, ref_crs)
        for k, thr in enumerate(thrs):
            buf[:] = 0.0
            np.copyto(buf, arr, where=(arr >= thr))
            np.maximum(haz[k], buf, out=haz[k])
        if i % 2000 == 0:
            print("  %d/%d 天，耗时 %.0f s" % (i, len(files), time.time() - t0))
    n_mis = len(files)
    print("淹没最大场完成（%d 天），耗时 %.1f 分钟" % (n_mis, (time.time() - t0) / 60))

    # ---- 逐阈值：边界裁剪 + 归一化分级 + 写出 ----
    stamp = "%s_to_%s_basin-%s" % (args.start, args.end, args.basin)
    rows = ["quantile,threshold_file,hazard_file,inundated_px,valid_px,"
            "inundated_frac,px_l1,px_l2,px_l3,px_l4,px_l5"]
    for k, q in enumerate(quantiles):
        field = haz[k]
        if bmask is not None:
            field = np.where(bmask, field, 0.0).astype(np.float32)
        valid_mask = field > 0
        vals = field[valid_mask]
        if vals.size == 0:
            print("警告: %dp 无淹没像元，跳过" % q)
            continue
        vmin, vmax = float(vals.min()), float(vals.max())
        norm = np.zeros(field.shape, dtype=np.float32)
        if vmax > vmin:
            norm[valid_mask] = (field[valid_mask] - vmin) / (vmax - vmin)
        else:
            norm[valid_mask] = 1.0
        q20, q40, q60, q80 = np.percentile(norm[valid_mask], [20, 40, 60, 80])
        level = np.zeros(field.shape, dtype=np.uint8)
        m = valid_mask & (norm > 0)
        level[m & (norm < q20)] = 1
        level[m & (norm >= q20) & (norm < q40)] = 2
        level[m & (norm >= q40) & (norm < q60)] = 3
        level[m & (norm >= q60) & (norm < q80)] = 4
        level[m & (norm >= q80)] = 5

        n_inun = int(valid_mask.sum())
        n_valid = int(bmask.sum()) if bmask is not None else int(np.isfinite(field).sum())
        counts = [int((level == k2).sum()) for k2 in range(1, 6)]
        out_path = os.path.join(args.out_dir, "%s_hazard_p%d.tif" % (stamp, q))
        with rasterio.open(out_path, "w", **profile) as dst:
            dst.write(level, 1)
        print("  %dp: 淹没 %d/%d = %.2f%%，等级 %s → %s" % (
            q, n_inun, n_valid, 100.0 * n_inun / n_valid, counts,
            os.path.basename(out_path)))
        rows.append("%d,grid_threshold_%dp.tif,%s,%d,%d,%.6f,%d,%d,%d,%d,%d" % (
            q, q, os.path.basename(out_path), n_inun, n_valid,
            n_inun / n_valid, *counts))

    with open(os.path.join(args.out_dir, "threshold_summary_%s.csv" % stamp),
              "w", encoding="utf-8-sig") as f:
        f.write("\n".join(rows) + "\n")
    print("汇总: %s" % os.path.join(args.out_dir, "threshold_summary_%s.csv" % stamp))


if __name__ == "__main__":
    main()
