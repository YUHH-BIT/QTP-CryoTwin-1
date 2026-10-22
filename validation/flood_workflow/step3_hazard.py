# -*- coding: utf-8 -*-
"""步骤 2：危险性生成。

输入：逐日径流 tif（runoff 目录）+ 阈值栅格（grid_threshold_{p}p.tif）
输出：时段危险性 tif（{start}_to_{end}_basin-{basin}_hazard.tif）

流程（与本项目 webgis 官方口径一致）：
    1) 逐日淹没：runoff >= 阈值（阈值栅格重投影到径流网格）-> 保留 runoff 值，否则 0
    2) 时段最大：逐像元取时段内淹没最大值（hazard 强度场）
    3) 归一化：淹没区内 min-max 归一化到 [0,1]
    4) 分级：淹没区内 20/40/60/80 分位数 -> 1~5 级（每级各占淹没区约 20%），未淹没=0
    5) 写 tif（uint8, nodata=0）

用法：
    python step2_hazard.py
    python step2_hazard.py --start 2024-07-01 --end 2024-08-31 --p 95
    python step2_hazard.py --runoff_dir D:/runoff --threshold_dir D:/thr --out_dir D:/out
"""
import argparse
import glob
import os
import time
from datetime import datetime

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import reproject

import config


def load_grid_nan(path):
    """读单波段 tif，nodata 转 nan。"""
    with rasterio.open(path) as src:
        arr = src.read(1).astype(np.float32)
        if src.nodata is not None:
            arr = np.where(arr == src.nodata, np.nan, arr)
        return arr, src.profile, src.transform, src.crs


def align_to_reference(data, src_transform, src_crs, ref_shape, ref_transform, ref_crs):
    """把栅格重投影到参考网格（默认双线性），返回与参考同 shape 的数组。"""
    if data.shape == ref_shape and src_transform == ref_transform:
        return data
    out = np.full(ref_shape, np.nan, dtype=np.float32)
    reproject(
        source=data, src_transform=src_transform, src_crs=src_crs,
        destination=out, dst_transform=ref_transform, dst_crs=ref_crs,
        src_nodata=np.nan, dst_nodata=np.nan,
        resampling=Resampling.bilinear)
    return out


def main():
    ap = argparse.ArgumentParser(description="危险性生成：runoff + 阈值 -> 时段危险性 1-5 级")
    ap.add_argument("--runoff_dir", default=str(config.RUNOFF_DIR))
    ap.add_argument("--threshold_dir", default=str(config.THRESHOLD_DIR))
    ap.add_argument("--p", type=int, default=config.THRESHOLD_P)
    ap.add_argument("--out_dir", default=str(config.HAZARD_OUT_DIR))
    ap.add_argument("--boundary", default=str(config.REGION_BOUNDARY))
    ap.add_argument("--basin", default=config.BASIN_NAME)
    ap.add_argument("--start", required=True, help="起止日期，必填，如 2024-01-01")
    ap.add_argument("--end", required=True, help="结束日期，必填，如 2024-12-31")
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    # ---- 径流文件列表（时段内）----
    pattern = os.path.join(args.runoff_dir, "*_runoff.tif")
    files = sorted(glob.glob(pattern))
    files = [f for f in files if args.start <= os.path.basename(f)[:10] <= args.end]
    if not files:
        raise SystemExit(f"runoff 目录 {args.runoff_dir} 中没有 {args.start}~{args.end} 的径流文件")
    print(f"时段内径流文件: {len(files)} 天")

    # ---- 参考网格（第一个径流文件）----
    with rasterio.open(files[0]) as ref:
        ref_shape, ref_transform, ref_crs = (ref.height, ref.width), ref.transform, ref.crs
        profile = ref.profile
    profile.update(count=1, dtype=rasterio.uint8, compress="lzw", nodata=0)

    # ---- 阈值栅格并对齐到径流网格 ----
    thr_path = os.path.join(args.threshold_dir, f"grid_threshold_{args.p}p.tif")
    if not os.path.exists(thr_path):
        raise SystemExit(f"阈值文件不存在: {thr_path}")
    thr, _, thr_t, thr_crs = load_grid_nan(thr_path)
    thr = align_to_reference(thr, thr_t, thr_crs, ref_shape, ref_transform, ref_crs)
    print(f"阈值网格已对齐（{args.p}p）")

    # ---- 时段淹没最大场 ----
    t0 = time.time()
    hazard = None
    for f in files:
        arr, _, arr_t, arr_crs = load_grid_nan(f)
        # 逐日 runoff 网格可能与参考网格不一致（混存两套网格时），自动对齐
        if arr.shape != ref_shape or arr_t != ref_transform:
            arr = align_to_reference(arr, arr_t, arr_crs,
                                     ref_shape, ref_transform, ref_crs)
        valid = np.isfinite(arr) & np.isfinite(thr)
        inm = np.zeros(arr.shape, dtype=np.float32)
        inm[valid & (arr >= thr)] = arr[valid & (arr >= thr)]
        hazard = inm if hazard is None else np.maximum(hazard, inm)
    print(f"时段最大淹没强度场完成，耗时 {time.time()-t0:.1f} s")

    # ---- 研究区边界裁剪（可选）----
    if args.boundary and os.path.exists(args.boundary):
        import geopandas as gpd
        from rasterio.mask import mask as rio_mask
        gdf = gpd.read_file(args.boundary).to_crs(ref_crs)
        geom = [gdf.geometry.union_all()]
        with rasterio.open(files[0]) as ref:
            out_img, out_tf = rio_mask(
                ref, geom, crop=False, nodata=0,
                filled=True, invert=False)
        # 直接把边界外置 0
        if out_img.shape[1:] == hazard.shape:
            boundary_mask = out_img[0] > 0
            hazard = np.where(boundary_mask, hazard, 0.0).astype(np.float32)
            profile.update(transform=ref_transform)
        print("研究区边界裁剪完成")
    else:
        print("未使用研究区边界（--boundary 未提供或文件不存在）")

    # ---- 归一化 + 分位数分级（与官方口径一致）----
    valid_mask = hazard > 0
    vals = hazard[valid_mask]
    if vals.size == 0:
        raise SystemExit("时段内没有淹没像元，请检查阈值分位与 runoff 数值范围")
    vmin, vmax = float(np.min(vals)), float(np.max(vals))
    norm = np.zeros(hazard.shape, dtype=np.float32)
    if vmax <= vmin:
        norm[valid_mask] = 1.0 if vmax > 0 else 0.0
    else:
        norm[valid_mask] = (hazard[valid_mask] - vmin) / (vmax - vmin)

    level = np.zeros(hazard.shape, dtype=np.uint8)
    q20, q40, q60, q80 = np.percentile(norm[valid_mask], [20, 40, 60, 80])
    m = valid_mask & (norm > 0)
    level[m & (norm < q20)] = 1
    level[m & (norm >= q20) & (norm < q40)] = 2
    level[m & (norm >= q40) & (norm < q60)] = 3
    level[m & (norm >= q60) & (norm < q80)] = 4
    level[m & (norm >= q80)] = 5
    print(f"淹没像元 {int(np.sum(valid_mask)):,}；1-5 级像元 "
          f"{[int(np.sum(level == k)) for k in range(1, 6)]}")

    # ---- 输出 ----
    stamp = f"{args.start}_to_{args.end}_basin-{args.basin}"
    out_path = os.path.join(args.out_dir, f"{stamp}_hazard.tif")
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(level, 1)
    print(f"输出: {out_path}")


if __name__ == "__main__":
    main()
