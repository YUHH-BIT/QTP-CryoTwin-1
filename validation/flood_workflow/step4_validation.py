# -*- coding: utf-8 -*-
"""步骤 3：危险性验证。

输入：危险性 tif（step2 输出或任意同构分级栅格）+ 历史洪水点位（SHP / CSV）
输出：
    results_validation.txt    文本结果（命中率等）
    figures/validation_map.png/.pdf   空间分布图（分级底图 + 点位）

命中定义：点位落入危险性区（等级 > 0，不分级）。
同时输出按等级 >=k 的对照命中率，便于参考。

点位格式：
    SHP：自动使用几何坐标（属性列 lon/lat 为 0 时也能正确读取）
    CSV：需要 lon / lat 两列（度）

用法：
    python step3_validation.py
    python step3_validation.py --hazard E:/out/..._hazard.tif --points D:/pts.shp --radius 1
    python step3_validation.py --csv pts.csv --lon_col lon --lat_col lat
"""
import argparse
import os
import time

import numpy as np
import pandas as pd
import rasterio
from rasterio.transform import rowcol

import config

# 中文字体（自动选择系统中可用的中文字体）
from matplotlib import font_manager
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap
from matplotlib.patches import Patch
from matplotlib.lines import Line2D

for _f in font_manager.fontManager.ttflist:
    if "YaHei" in _f.name or "Noto Sans CJK" in _f.name or "SimHei" in _f.name:
        plt.rcParams["font.family"] = _f.name
        break
plt.rcParams["axes.unicode_minus"] = False

LVL_COLORS = ["#f7f7f7", "#2c7bb6", "#abd9e9", "#ffffbf", "#fdae61", "#d7191c"]


def load_points(path, crs_src, csv_lon=None, csv_lat=None, year=None):
    """返回 (lon, lat) 数组（EPSG:4326）。SHP 用几何坐标，CSV 用指定列。

    year 不为 None 时，对 SHP 自动识别日期列并筛选该年份；
    CSV 若存在 date/年份列也会尝试筛选，否则视为已按年份准备。
    """
    if str(path).lower().endswith((".shp", ".geojson", ".gpkg")):
        import geopandas as gpd
        gdf = gpd.read_file(path)
        if gdf.crs is None:
            gdf.set_crs(crs_src, inplace=True)
        gdf = gdf.to_crs("EPSG:4326")
        if year:
            gdf = filter_year(gdf, year)
        lon = gdf.geometry.x.values
        lat = gdf.geometry.y.values
        return lon, lat
    df = pd.read_csv(path)
    lon_col = csv_lon or ("lon" if "lon" in df.columns else "longitude")
    lat_col = csv_lat or ("lat" if "lat" in df.columns else "latitude")
    if year:
        df = filter_year(df, year)
    return df[lon_col].values.astype(float), df[lat_col].values.astype(float)


_DATE_COLS = ["date", "Date", "began", "Began", "start_date", "start", "year", "Year"]


def filter_year(frame, year):
    """按年份筛选：识别常见日期/年份列；识别不到则原样返回并提示。"""
    for c in _DATE_COLS:
        if c not in frame.columns:
            continue
        vals = frame[c].astype(str)
        # 取前 4 位数字作为年份（兼容 2024/7/15、2024-07-01、2024 等格式）
        ys = vals.str.extract(r"(\d{4})")[0]
        hit = ys == str(year)
        if hit.any():
            n_before = len(frame)
            out = frame[hit].copy()
            print(f"按 {c} 列筛选 {year} 年: {n_before} -> {len(out)} 条")
            return out
    print(f"警告: 未找到可用的日期/年份列（现有列: {list(frame.columns)[:10]}），"
          f"按全部点位计算（{len(frame)} 条）")
    return frame


def radius_to_deg(radius_km):
    return radius_km / 111.0


def sample_levels(arr, transform, lon, lat, radius_km):
    """逐点取危险性等级；radius_km>0 时取窗口内最大值。越界返回 -1（不计入分母）。"""
    out = np.full(len(lon), -1, dtype=int)
    if radius_km <= 0:
        rows, cols = rowcol(transform, lon, lat)
        rows, cols = np.asarray(rows), np.asarray(cols)
        ok = (rows >= 0) & (rows < arr.shape[0]) & (cols >= 0) & (cols < arr.shape[1])
        out[ok] = arr[rows[ok], cols[ok]].astype(int)
        return out
    d = radius_to_deg(radius_km)
    h, w = arr.shape
    for i, (x, y) in enumerate(zip(lon, lat)):
        from rasterio.windows import from_bounds
        win = from_bounds(x - d, y - d, x + d, y + d, transform)
        r0 = max(int(np.floor(win.row_off)), 0)
        c0 = max(int(np.floor(win.col_off)), 0)
        r1 = min(int(np.ceil(win.row_off + win.height)), h)
        c1 = min(int(np.ceil(win.col_off + win.width)), w)
        if r1 <= r0 or c1 <= c0:
            continue
        out[i] = int(arr[r0:r1, c0:c1].max())
    return out


def filter_by_boundary(lon, lat, boundary_path, crs_src):
    """只保留落在研究区边界内的点位（与栅格覆盖范围口径一致）。"""
    import geopandas as gpd
    from shapely.geometry import Point
    gdf = gpd.read_file(boundary_path)
    if gdf.crs is None:
        gdf.set_crs(crs_src, inplace=True)
    poly = gdf.to_crs("EPSG:4326").geometry.union_all()
    inside = gpd.GeoSeries([Point(x, y) for x, y in zip(lon, lat)],
                           crs="EPSG:4326").within(poly).values
    print(f"研究区边界过滤: {len(lon)} -> {int(np.sum(inside))} 条")
    return lon[inside], lat[inside]


def make_map(arr, transform, lon, lat, levels, out_dir, title):
    """分级底图 + 命中/未命中点位空间分布图。"""
    hit = levels > 0
    miss = levels == 0
    fig, ax = plt.subplots(figsize=(7.2, 4.4))
    ax.imshow(arr, cmap=ListedColormap(LVL_COLORS), vmin=0, vmax=5,
              interpolation="nearest",
              extent=(transform.c, transform.c + transform.a * arr.shape[1],
                      transform.f + transform.e * arr.shape[0], transform.f))
    ax.scatter(lon[miss], lat[miss], s=18, marker="^", facecolor="none",
               edgecolor="#333333", linewidth=0.6, zorder=3)
    ax.scatter(lon[hit], lat[hit], s=20, marker="^", facecolor="#00a65a",
               edgecolor="white", linewidth=0.4, zorder=4)
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
    ax.set_xlabel("经度 (°E)")
    ax.set_ylabel("纬度 (°N)")
    # 自动取栅格覆盖范围（含 5% 边距）
    x0, x1 = transform.c, transform.c + transform.a * arr.shape[1]
    y1, y0 = transform.f, transform.f + transform.e * arr.shape[0]
    ax.set_xlim(x0 - 0.5, x1 + 0.5)
    ax.set_ylim(y0 - 0.5, y1 + 0.5)
    ax.set_aspect(1 / np.cos(np.radians((y0 + y1) / 2)))
    ax.set_title(title, fontsize=12)
    os.makedirs(out_dir, exist_ok=True)
    fig.savefig(os.path.join(out_dir, "validation_map.png"), dpi=300)
    fig.savefig(os.path.join(out_dir, "validation_map.pdf"))
    print(f"图件输出: {os.path.join(out_dir, 'validation_map.png/.pdf')}")


def main():
    ap = argparse.ArgumentParser(description="危险性验证：历史洪水点位 -> 命中率 + 空间图")
    ap.add_argument("--hazard", default="", help="危险性 tif（默认取 config 或 step2 输出）")
    ap.add_argument("--points", default=str(config.POINTS_FILE))
    ap.add_argument("--csv", default="", help="改用 CSV 点位（同时给 --lon_col/--lat_col）")
    ap.add_argument("--lon_col", default="lon")
    ap.add_argument("--lat_col", default="lat")
    ap.add_argument("--crs", default=config.POINTS_SOURCE_CRS)
    ap.add_argument("--radius", type=float, default=config.RADIUS_KM)
    ap.add_argument("--year", type=int, default=0, help="只检验该年份的点位（0=全部）")
    ap.add_argument("--boundary", default="", help="研究区边界（可选；只保留边界内的点位）")
    ap.add_argument("--out_dir", default=str(config.RESULT_DIR))
    ap.add_argument("--start", required=True, help="起止日期，必填，如 2024-01-01")
    ap.add_argument("--end", required=True, help="结束日期，必填，如 2024-12-31")
    args = ap.parse_args()

    # ---- 定位危险性 tif ----
    hazard_path = args.hazard
    if not hazard_path:
        cand = os.path.join(config.HAZARD_OUT_DIR,
                            f"{args.start}_to_{args.end}_basin-{config.BASIN_NAME}_hazard.tif")
        if os.path.exists(cand):
            hazard_path = cand
        else:
            raise SystemExit("未找到危险性 tif，请用 --hazard 指定，或先运行 step2_hazard.py")
    with rasterio.open(hazard_path) as src:
        arr = src.read(1).astype(np.int16)
        transform = src.transform
    print(f"危险性 tif: {hazard_path}  {arr.shape}  等级 0-{int(arr.max())}")

    # ---- 点位 ----
    year = args.year or None
    if args.csv:
        lon, lat = load_points(args.csv, args.crs,
                               csv_lon=args.lon_col, csv_lat=args.lat_col, year=year)
    else:
        lon, lat = load_points(args.points, args.crs, year=year)
    if args.boundary and os.path.exists(args.boundary):
        lon, lat = filter_by_boundary(lon, lat, args.boundary, args.crs)
    print(f"点位总数: {len(lon)}")

    # ---- 抽样 ----
    t0 = time.time()
    levels = sample_levels(arr, transform, lon, lat, args.radius)
    ok = levels >= 0
    n_valid = int(np.sum(ok))
    n_hit = int(np.sum(levels[ok] > 0))
    n_miss = n_valid - n_hit
    rate = n_hit / n_valid if n_valid else 0.0
    print(f"抽样完成（容差 {args.radius} km），耗时 {time.time()-t0:.1f} s")

    # 对照：各级别命中
    cnt = {k: int(np.sum(levels[ok] == k)) for k in range(1, 6)}

    # ---- 文本结果 ----
    os.makedirs(args.out_dir, exist_ok=True)
    txt = os.path.join(args.out_dir, "results_validation.txt")
    with open(txt, "w", encoding="utf-8") as f:
        f.write("洪水危险性验证结果\n")
        f.write(f"危险性栅格 : {hazard_path}\n")
        f.write(f"点位数据   : {args.csv or args.points}\n")
        f.write(f"位置容差   : {args.radius} km\n")
        f.write(f"时间段     : {args.start} ~ {args.end}\n")
        f.write("-" * 44 + "\n")
        f.write(f"参与检验点位 : {n_valid}\n")
        f.write(f"落入危险性区(>0) : {n_hit}\n")
        f.write(f"未落入      : {n_miss}\n")
        f.write(f"命中率      : {rate:.2%}\n")
        f.write("-" * 44 + "\n")
        f.write("按等级分布（落入点位的等级构成）:\n")
        for k in range(1, 6):
            f.write(f"  {k} 级 : {cnt[k]} 个\n")
        f.write("-" * 44 + "\n")
        f.write("对照口径（如需）:\n")
        for k in range(2, 6):
            rk = int(np.sum(levels[ok] >= k)) / n_valid if n_valid else 0.0
            f.write(f"  >= {k} 级 : {rk:.2%}  ({int(np.sum(levels[ok] >= k))}/{n_valid})\n")
    print(f"文本结果: {txt}")

    # ---- 空间图 ----
    title = f"{args.start[:4]} 年洪水危险性等级与历史洪水点位分布"
    make_map(arr, transform, lon[ok], lat[ok], levels[ok], args.out_dir, title)


if __name__ == "__main__":
    main()
