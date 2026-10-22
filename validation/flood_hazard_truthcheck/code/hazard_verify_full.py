# -*- coding: utf-8 -*-
"""全时段（1980–2025）危险性真实性检验：点位准备 + 等级抽样 + 命中率报告。

替代原先缺失的 points_prepare.py / hazard_verify.py，口径按 2024 年基线反演复原：
    1) 点位来源：2004_2025.shp + 1980_2003.shp（source=shp_combined）
                 QinghaiTibet_Floods_2004_2025_Full.csv（source=groundsource_csv）
    2) 空间过滤：落在 TP 边界内 **且** 落在危险性栅格覆盖范围内
       （栅格南界 25.8086°N，2024 年基线因此比纯 TP 裁剪少 1 个点，已核对复现）
    3) 命中定义：level_1km > 0（位置容差 1 km 窗口内取最大等级）
    4) 同时给出 0/1/3/5 km 四档容差，便于对照

输出：
    outputs/points_{tag}_tp_levels.csv   点位 + 四档等级
    outputs/hit_rate_{tag}.md            命中率报告（总体 / 分来源 / 分等级 / 逐年）

用法：
    python hazard_verify_full.py                       # 默认全时段 + 全部年份点位
    python hazard_verify_full.py --year 2024 --tag 2024
    python hazard_verify_full.py --hazard <其它 hazard.tif> --tag flood
"""
import argparse
import hashlib
from pathlib import Path

import numpy as np
import pandas as pd
import geopandas as gpd
import rasterio
from shapely.prepared import prep

from common import (OUT_DIR, CSV_2004_2025, SHP_2004_2025, SHP_1980_2003,
                    TP_BOUNDARY, HAZARD_TIF_FULL, RADII_KM, sample_max_level)

COLUMNS = ["uuid", "source", "date", "month", "day", "lon", "lat",
           "level_0km", "level_1km", "level_3km", "level_5km"]


def _mk_uuid(source, lon, lat, date):
    raw = f"{source}|{lon:.6f}|{lat:.6f}|{date}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def _parse_began(v):
    """解析 1980_2003.shp 的 Began 列（混有 D/M/Y、Y/M/D、Y/M/、None）。"""
    s = str(v).strip()
    if not s or s.lower() in ("none", "nan"):
        return 0, 0, 0
    parts = [p for p in s.replace("-", "/").split("/") if p != ""]
    try:
        if len(parts) >= 1 and len(parts[0]) == 4:        # Y/M/D
            y = int(parts[0])
            m = int(parts[1]) if len(parts) > 1 else 0
            d = int(parts[2]) if len(parts) > 2 else 0
        else:                                             # D/M/Y
            d = int(parts[0])
            m = int(parts[1]) if len(parts) > 1 else 0
            y = int(parts[2]) if len(parts) > 2 else 0
    except ValueError:
        return 0, 0, 0
    return y, m, d


def load_points():
    """返回 DataFrame[uuid, source, year, month, day, lon, lat]，已按坐标系 EPSG:4326。"""
    frames = []

    # --- 2004_2025.shp（year/month/day 列可用；少量 year=0 表示日期缺失）---
    g1 = gpd.read_file(SHP_2004_2025).to_crs("EPSG:4326")
    d1 = pd.DataFrame({
        "source": "shp_combined",
        "year": pd.to_numeric(g1.get("year"), errors="coerce").fillna(0).astype(int),
        "month": pd.to_numeric(g1.get("month"), errors="coerce").fillna(0).astype(int),
        "day": pd.to_numeric(g1.get("day"), errors="coerce").fillna(0).astype(int),
        "lon": g1.geometry.x.values,
        "lat": g1.geometry.y.values,
    })
    frames.append(d1)

    # --- 1980_2003.shp（无 year 列，从 Began 解析）---
    g2 = gpd.read_file(SHP_1980_2003).to_crs("EPSG:4326")
    parsed = [_parse_began(v) for v in g2.get("Began", pd.Series([None] * len(g2)))]
    d2 = pd.DataFrame({
        "source": "shp_combined",
        "year": [p[0] for p in parsed],
        "month": [p[1] for p in parsed],
        "day": [p[2] for p in parsed],
        "lon": g2.geometry.x.values,
        "lat": g2.geometry.y.values,
    })
    frames.append(d2)

    # --- 全球洪水事件 CSV（已含 year/month/day）---
    big = pd.read_csv(CSV_2004_2025, low_memory=False)
    d3 = pd.DataFrame({
        "source": "groundsource_csv",
        "year": pd.to_numeric(big.get("year"), errors="coerce").fillna(0).astype(int),
        "month": pd.to_numeric(big.get("month"), errors="coerce").fillna(0).astype(int),
        "day": pd.to_numeric(big.get("day"), errors="coerce").fillna(0).astype(int),
        "lon": big["longitude"].astype(float).values,
        "lat": big["latitude"].astype(float).values,
    })
    frames.append(d3)

    df = pd.concat(frames, ignore_index=True)
    df = df[(df.lon.between(-180, 180)) & (df.lat.between(-90, 90))]
    df["date"] = df.apply(
        lambda r: f"{int(r.year):04d}-{int(r.month):02d}-{int(r.day):02d}"
        if r.year > 0 else "", axis=1)
    df["uuid"] = [_mk_uuid(s, x, y, d) for s, x, y, d in
                  zip(df.source, df.lon, df.lat, df.date)]
    return df.reset_index(drop=True)


def main():
    ap = argparse.ArgumentParser(description="全时段洪水危险性真实性检验")
    ap.add_argument("--hazard", default=str(HAZARD_TIF_FULL), help="危险性栅格 tif")
    ap.add_argument("--tag", default="full", help="输出文件名标识（默认 full）")
    ap.add_argument("--year", type=int, default=0, help="只检验该年份点位（0=全部）")
    ap.add_argument("--main_radius", type=float, default=1.0, help="主口径位置容差 km")
    args = ap.parse_args()

    with rasterio.open(args.hazard) as src:
        arr = src.read(1).astype(np.int16)
        transform = src.transform
        bnd = src.bounds
    print(f"危险性栅格: {args.hazard}\n  shape={arr.shape} 等级 0-{int(arr.max())}")
    print(f"  范围 W/E/S/N = {bnd.left:.4f}/{bnd.right:.4f}/"
          f"{bnd.bottom:.4f}/{bnd.top:.4f}")

    # ---- 点位准备 ----
    df = load_points()
    print(f"原始点位: {len(df)}（shp_combined + groundsource_csv）")

    if args.year:
        df = df[df.year == args.year].reset_index(drop=True)
        print(f"按年份 {args.year} 筛选后: {len(df)}")

    # 1) TP 边界过滤
    tp = gpd.read_file(TP_BOUNDARY)
    prepared = prep(tp.geometry.union_all())
    keep_tp = np.array([prepared.contains(pt) for pt in
                        gpd.points_from_xy(df.lon.values, df.lat.values)])
    print(f"TP 边界过滤: {len(df)} -> {int(keep_tp.sum())}")

    # 2) 栅格覆盖范围过滤（与 2024 年基线口径一致）
    keep_box = ((df.lon.values >= bnd.left) & (df.lon.values <= bnd.right) &
                (df.lat.values >= bnd.bottom) & (df.lat.values <= bnd.top))
    keep = keep_tp & keep_box
    df = df[keep].reset_index(drop=True)
    print(f"栅格覆盖范围过滤后: {len(df)}")

    if df.empty:
        raise SystemExit("过滤后无点位，请检查边界/栅格范围")

    # ---- 等级抽样 ----
    xs, ys = df.lon.values, df.lat.values
    for r in RADII_KM:
        col = f"level_{str(r).replace('.', '_')}km" if r != int(r) else f"level_{int(r)}km"
        df[col] = sample_max_level(arr, transform, xs, ys, r)
    df = df[COLUMNS]

    csv_path = OUT_DIR / f"points_{args.tag}_tp_levels.csv"
    df.to_csv(csv_path, index=False, encoding="utf-8-sig")
    print(f"点位等级表: {csv_path}（{len(df)} 行）")

    # ---- 命中率 ----
    main_col = f"level_{int(args.main_radius)}km" if args.main_radius == int(args.main_radius) \
        else f"level_{str(args.main_radius).replace('.', '_')}km"
    lv = df[main_col].values
    valid = lv >= 0
    n_valid = int(valid.sum())
    n_hit = int((lv[valid] > 0).sum())
    rate = n_hit / n_valid if n_valid else 0.0

    md = OUT_DIR / f"hit_rate_{args.tag}.md"
    lines = [f"# 洪水点位落入危险性区的命中率（{args.tag}）", "",
             f"- 危险性栅格：`{Path(args.hazard).name}`",
             f"- 位置容差：{args.main_radius} km（窗口内取最大等级）",
             f"- 年份口径：{'全部' if not args.year else args.year}", "",
             f"- 点位总数：{n_valid} 个",
             f"- 落入危险性区（等级 >0）：{n_hit} 个",
             f"- 未落入：{n_valid - n_hit} 个",
             f"- **命中率 = {rate:.1%}**", ""]

    lines.append("## 分来源")
    lines.append("")
    lines.append("| 来源 | 点数 | 命中 | 命中率 |")
    lines.append("|---|---:|---:|---:|")
    for src_name, sub in df.groupby("source"):
        v = sub[main_col].values
        v = v[v >= 0]
        lines.append(f"| {src_name} | {len(v)} | {int((v > 0).sum())} | "
                     f"{(v > 0).mean():.1%} |")
    lines.append("")

    lines.append("## 命中点位的等级构成")
    lines.append("")
    lines.append("| 等级 | 点数 |")
    lines.append("|---|---:|")
    for k in range(1, 6):
        lines.append(f"| {k} 级 | {int((lv[valid] == k).sum())} |")
    lines.append("")

    lines.append("## 对照口径（≥k 级）")
    lines.append("")
    for k in range(2, 6):
        lines.append(f"- ≥{k} 级：{int((lv[valid] >= k).sum())}/{n_valid} = "
                     f"{(lv[valid] >= k).mean():.1%}")
    lines.append("")

    if not args.year:
        lines.append("## 逐年命中率")
        lines.append("")
        lines.append("| 年份 | 点数 | 命中 | 命中率 |")
        lines.append("|---|---:|---:|---:|")
        for y, sub in df.groupby(_year_of(df)):
            v = sub[main_col].values
            v = v[v >= 0]
            label = f"{y}" if y > 0 else "年份缺失"
            lines.append(f"| {label} | {len(v)} | {int((v > 0).sum())} | "
                         f"{(v > 0).mean() if len(v) else 0:.1%} |")
        lines.append("")

    md.write_text("\n".join(lines), encoding="utf-8")
    print(f"命中率报告: {md}")
    print(f"命中率 {rate:.1%}（{n_hit}/{n_valid}）")


def _year_of(df):
    """从 date 列还原年份（无日期归 0）。"""
    return df["date"].str.slice(0, 4).replace("", "0").astype(int)


if __name__ == "__main__":
    main()
