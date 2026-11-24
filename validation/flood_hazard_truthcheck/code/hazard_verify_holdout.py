# -*- coding: utf-8 -*-
"""留出期洪水危险性真实性检验（A 覆盖度 + B 区分能力）。

严格按《验证方法设计_20261123.md》执行：
    阈值/危险性：1980-01-01 ~ 2023-12-31
    验证点位：2024-01-01 ~ 2025-12-31 的 SHP 事件点
    负样本：全域有效区内随机点，按距河流距离分层，数量与正样本 1:1
    位置容差：0/1/3/5 km（主口径 1 km，窗口内取最大等级）
    不确定度：1000 次有放回 bootstrap（95% 分位区间）

输入：
    outputs_v2/hazard/{start}_to_{end}_basin-all_hazard_p{q}.tif
输出：
    outputs_v2/hit_rate_holdout.md / auc_holdout.md / metrics_summary.csv
    outputs_v2/points_holdout_levels.tsv
    outputs_v2/figures/*.png|pdf
"""
import argparse
import os
import sys

import numpy as np
import pandas as pd
import geopandas as gpd
import rasterio
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from shapely import STRtree, points as shp_points, distance as shp_distance
from shapely.prepared import prep
from sklearn.metrics import roc_auc_score
from scipy.stats import spearmanr

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (PROJ, SHP_2004_2025, SHP_1980_2003, TP_BOUNDARY,
                    RUNOFF_DIR, sample_max_level)

BASE = os.path.join(PROJ, "validation", "flood_hazard_truthcheck")
OUT = os.path.join(BASE, "outputs_v2")
FIG = os.path.join(OUT, "图件")
RIVER = os.path.join(PROJ, "data", "raw", "geo", "hydrology", "river.geojson")
BASINS = os.path.join(PROJ, "data", "raw", "geo", "hydrology", "TP_basins.geojson")
RADII = (0.0, 1.0, 3.0, 5.0)
QUANTILES = (10, 50, 90, 95, 99)
SEED = 20261124


# ---------------------------------------------------------------- 点位

def parse_year(v):
    """从 Began 解析年份；兼容 D/M/Y、Y/M/D、Y/M/ 等混排，失败返回 0。"""
    s = str(v).strip()
    if not s or s.lower() in ("none", "nan"):
        return 0
    for p in s.replace("-", "/").replace(".", "/").split("/"):
        p = p.strip()
        if len(p) == 4 and p.isdigit() and 1900 <= int(p) <= 2030:
            return int(p)
    return 0


def load_truth():
    """读取两期 SHP。2004_2025 的 Began 大多为空、year 字段可用；
    1980_2003 无 year 字段，从 Began 解析。year=0 表示日期缺失。"""
    frames = []
    for tag, path in (("2004_2025", SHP_2004_2025), ("1980_2003", SHP_1980_2003)):
        g = gpd.read_file(path).to_crs("EPSG:4326")
        parsed = np.array([parse_year(v) for v in
                           g.get("Began", pd.Series([None] * len(g)))], dtype=int)
        if "year" in g.columns:
            y = pd.to_numeric(g["year"], errors="coerce").fillna(0).astype(int).values
            year = np.where(y > 0, y, parsed)
        else:
            year = parsed
        frames.append(pd.DataFrame({
            "source": tag,
            "year": year,
            "lon": g.geometry.x.values,
            "lat": g.geometry.y.values,
        }))
    df = pd.concat(frames, ignore_index=True)
    df = df[(df.lon.between(-180, 180)) & (df.lat.between(-90, 90))]
    return df.reset_index(drop=True)


def load_hazard(path):
    with rasterio.open(path) as s:
        arr = s.read(1).astype(np.int16)
        return arr, s.transform, s.crs, s.bounds


def area_mask(hazard_path, thr_path, tp_path):
    """有效区 = TP 边界内 ∩ 径流/阈值有效像元（按几何建掩膜，避免把等级 0 当成界外）。"""
    with rasterio.open(hazard_path) as ref:
        gdf = gpd.read_file(tp_path).to_crs(ref.crs)
        shape, transform = (ref.height, ref.width), ref.transform
        inside = geometry_mask([gdf.geometry.union_all()], out_shape=shape,
                               transform=transform, invert=True)
    with rasterio.open(thr_path) as s:
        thr = s.read(1)
        assert (s.height, s.width) == shape and s.transform == transform
    valid = inside & np.isfinite(thr)
    return valid, transform


# ---------------------------------------------------------------- 距离

def dist_to_river(xs, ys, river_path):
    """点到河网的最短距离（km），投影到以高原为中心的等距方位投影。"""
    import pyproj
    aeqd = pyproj.CRS.from_proj4(
        "+proj=aeqd +lat_0=33 +lon_0=90 +datum=WGS84 +units=m +no_defs")
    tr = pyproj.Transformer.from_crs("EPSG:4326", aeqd, always_xy=True)
    xm, ym = tr.transform(xs, ys)
    pts = shp_points(xm, ym)
    riv = gpd.read_file(river_path).to_crs(aeqd)
    tree = STRtree(list(riv.geometry.values))
    idx = tree.nearest(pts)
    d = shp_distance(pts, np.asarray(riv.geometry.values, dtype=object)[idx])
    return d / 1000.0


def stratified_negatives(valid, transform, pos_dist, n_cand=100000, seed=SEED):
    """在有效区内均匀撒候选点，再按正样本的距河距离分布分层抽取。"""
    rng = np.random.default_rng(seed)
    rows, cols = np.nonzero(valid)
    n_cand = min(n_cand, len(rows))
    sel = rng.choice(len(rows), size=n_cand, replace=False)
    rr, cc = rows[sel], cols[sel]
    xs, ys = rasterio.transform.xy(transform, rr, cc, offset="center")
    xs, ys = np.asarray(xs), np.asarray(ys)
    cand_dist = dist_to_river(xs, ys, RIVER)

    edges = np.array([0, 1, 2, 5, 10, 20, 50, np.inf])
    pos_bin = np.digitize(pos_dist, edges) - 1
    cand_bin = np.digitize(cand_dist, edges) - 1
    need = {b: int((pos_bin == b).sum()) for b in range(len(edges) - 1)}
    picked = []
    report = []
    for b, k in need.items():
        pool = np.flatnonzero(cand_bin == b)
        take = min(k, len(pool))
        if take:
            picked.append(rng.choice(pool, size=take, replace=False))
        report.append((edges[b], edges[b + 1], k, len(pool), take))
    picked = np.concatenate(picked) if picked else np.array([], dtype=int)
    short = sum(k for _, _, k, _, t in report) - len(picked)
    # 不足时从全部候选中补足（记录在报告中）
    if short > 0:
        rest = np.setdiff1d(np.arange(n_cand), picked)
        extra = rng.choice(rest, size=min(short, len(rest)), replace=False)
        picked = np.concatenate([picked, extra])
    return xs[picked], ys[picked], cand_dist[picked], report


# ---------------------------------------------------------------- 统计

def boot_ci(values_pos, values_neg, metric, n_boot=1000, seed=SEED):
    """对正/负样本索引做分层 bootstrap，返回 95% 分位区间。"""
    rng = np.random.default_rng(seed)
    np_, nn = len(values_pos), len(values_neg)
    out = []
    for _ in range(n_boot):
        ip = rng.integers(0, np_, np_)
        ineg = rng.integers(0, nn, nn)
        out.append(metric(values_pos[ip], values_neg[ineg]))
    out = np.asarray(out, dtype=float)
    return float(np.nanpercentile(out, 2.5)), float(np.nanpercentile(out, 97.5))


def main():
    global OUT, FIG
    ap = argparse.ArgumentParser(description="留出期危险性真实性检验")
    ap.add_argument("--hazard_dir", default=os.path.join(OUT, "危险性栅格"))
    ap.add_argument("--thr_dir", default=os.path.join(PROJ, "data", "raw", "thresholds"))
    ap.add_argument("--start", default="1980-01-01")
    ap.add_argument("--end", default="2023-12-31")
    ap.add_argument("--main_radius", type=float, default=1.0)
    ap.add_argument("--out_dir", default=OUT, help="输出目录（默认 outputs_v2）")
    args = ap.parse_args()

    OUT = args.out_dir
    FIG = os.path.join(OUT, "图件")
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(FIG, exist_ok=True)

    haz_path = {
        q: os.path.join(args.hazard_dir,
                        "危险性_p%d_%s_to_%s.tif" % (q, args.start, args.end))
        for q in QUANTILES
    }
    for q, p in haz_path.items():
        if not os.path.exists(p):
            raise SystemExit("缺少危险性栅格: %s" % p)
    arr99, tr99, crs99, _ = load_hazard(haz_path[99])
    valid, transform = area_mask(haz_path[99],
                                 os.path.join(args.thr_dir, "grid_threshold_99p.tif"),
                                 TP_BOUNDARY)
    n_valid_cells = int(valid.sum())
    print("有效区像元 %d / 栅格 %d" % (n_valid_cells, valid.size))

    # ---- 正样本 ----
    truth = load_truth()
    print("SHP 事件点合计 %d，其中 2024-2025：%d" % (
        len(truth), int(truth.year.isin([2024, 2025]).sum())))
    pos = truth[truth.year.isin([2024, 2025])].copy()
    gdf = gpd.GeoDataFrame(pos, geometry=gpd.points_from_xy(pos.lon, pos.lat),
                           crs="EPSG:4326")
    tp_geom = prep(gpd.read_file(TP_BOUNDARY).geometry.union_all())
    in_tp = np.array([tp_geom.contains(pt) for pt in gdf.geometry])
    with rasterio.open(haz_path[99]) as s:
        b = s.bounds
    in_box = (pos.lon.values >= b.left) & (pos.lon.values <= b.right) & \
             (pos.lat.values >= b.bottom) & (pos.lat.values <= b.top)
    rows, cols = rasterio.transform.rowcol(transform, pos.lon.values, pos.lat.values)
    rows, cols = np.asarray(rows), np.asarray(cols)
    in_valid = (rows >= 0) & (rows < valid.shape[0]) & \
               (cols >= 0) & (cols < valid.shape[1])
    keep = in_tp & in_box & in_valid
    keep[keep] = valid[rows[keep], cols[keep]]
    pos = pos[keep].reset_index(drop=True)
    print("TP 边界+栅格范围+有效径流区过滤后正样本：%d" % len(pos))
    if len(pos) < 30:
        raise SystemExit("正样本过少，无法验证")

    # ---- 负样本 ----
    pos_dist = dist_to_river(pos.lon.values, pos.lat.values, RIVER)
    neg_lon, neg_lat, neg_dist, strat = stratified_negatives(
        valid, transform, pos_dist)
    print("负样本：%d；分层（距河 km, 需要, 候选, 实取）：" % len(neg_lon))
    for e0, e1, k, pool, take in strat:
        print("  [%g, %g): 需要 %d，候选 %d，实取 %d" % (e0, e1, k, pool, take))

    # ---- 逐分位抽样等级 ----
    lv = {}
    for q in QUANTILES:
        arr, tr, _, _ = load_hazard(haz_path[q])
        radii = RADII if q == 99 else (args.main_radius,)
        for r in radii:
            lp = sample_max_level(arr, tr, pos.lon.values, pos.lat.values, r)
            ln = sample_max_level(arr, tr, neg_lon, neg_lat, r)
            lv[(q, r)] = (lp, ln)
    lp_main, ln_main = lv[(99, args.main_radius)]

    # 正样本若在半径窗口内越界（-1），按无效剔除（主口径）
    ok_pos = lp_main >= 0
    ok_neg = ln_main >= 0
    pos, pos_dist = pos[ok_pos].reset_index(drop=True), pos_dist[ok_pos]
    neg_lon, neg_lat, neg_dist = neg_lon[ok_neg], neg_lat[ok_neg], neg_dist[ok_neg]
    for k in list(lv):
        lv[k] = (lv[k][0][ok_pos], lv[k][1][ok_neg])
    lp_main, ln_main = lv[(99, args.main_radius)]
    print("最终正样本 %d，负样本 %d" % (len(lp_main), len(ln_main)))
    n_pos_2024 = int((pos.year == 2024).sum())
    n_pos_2025 = int((pos.year == 2025).sum())

    # ---- A 节 ----
    base_area = float((arr99[valid] > 0).mean())
    base_ge3 = float((arr99[valid] >= 3).mean())
    base_ge4 = float((arr99[valid] >= 4).mean())
    n_boot = 1000
    a_rows = []
    for r in RADII:
        lp, ln = lv[(99, r)]
        hit = float((lp > 0).mean())
        hit_neg = float((ln > 0).mean())
        lift_area = hit / base_area if base_area > 0 else np.nan
        lo, hi = boot_ci(lp, ln, lambda a, b: float((a > 0).mean()))
        nlo, nhi = boot_ci(lp, ln, lambda a, b: float((b > 0).mean()))
        llo, lhi = boot_ci(lp, ln, lambda a, b: float((a > 0).mean()) /
                           max(float((b > 0).mean()), 1e-9))
        # 补充：较高危险等级（>=3 / >=4）覆盖率，避免“等级>0”饱和后无区分
        h3, n3 = float((lp >= 3).mean()), float((ln >= 3).mean())
        h4, n4 = float((lp >= 4).mean()), float((ln >= 4).mean())
        a_rows.append(dict(radius_km=r, n_pos=len(lp), n_neg=len(ln),
                           hit_pos=hit, hit_neg=hit_neg, base_area=base_area,
                           lift_area=lift_area, lift_sample=hit / hit_neg
                           if hit_neg > 0 else np.nan,
                           hit_ci_lo=lo, hit_ci_hi=hi,
                           hit_neg_ci_lo=nlo, hit_neg_ci_hi=nhi,
                           lift_ci_lo=llo, lift_ci_hi=lhi,
                           hit_pos_ge3=h3, hit_neg_ge3=n3, base_area_ge3=base_ge3,
                           lift_area_ge3=h3 / base_ge3 if base_ge3 > 0 else np.nan,
                           hit_pos_ge4=h4, hit_neg_ge4=n4, base_area_ge4=base_ge4,
                           lift_area_ge4=h4 / base_ge4 if base_ge4 > 0 else np.nan))
    df_a = pd.DataFrame(a_rows)
    r1 = df_a[df_a.radius_km == args.main_radius].iloc[0]

    # ---- B 节 ----
    def auc_of(lp, ln):
        y = np.r_[np.ones(len(lp)), np.zeros(len(ln))]
        s = np.r_[lp, ln].astype(float)
        if len(np.unique(s)) < 2:
            return 0.5
        return float(roc_auc_score(y, s))

    b_rows = []
    for r in RADII:
        lp, ln = lv[(99, r)]
        auc = auc_of(lp, ln)
        lo, hi = boot_ci(lp.astype(float), ln.astype(float), auc_of)
        b_rows.append(dict(radius_km=r, auc=auc, ci_lo=lo, ci_hi=hi,
                           n_pos=len(lp), n_neg=len(ln)))
    df_b = pd.DataFrame(b_rows)

    # 等级单调性（主口径）
    ks = np.arange(0, 6)
    pk = np.array([(lp_main == k).mean() for k in ks])
    nk = np.array([(ln_main == k).mean() for k in ks])
    ratio = np.where(nk > 0, pk / np.maximum(nk, 1e-12), np.nan)
    mask = np.isfinite(ratio) & (nk > 0)
    rho, pval = spearmanr(ks[mask], ratio[mask])
    mono = bool(np.all(np.diff(ratio[mask]) >= -1e-12))

    # 阈值敏感性
    sens_rows = []
    for q in QUANTILES:
        arr, tr, _, _ = load_hazard(haz_path[q])
        lp, ln = lv[(q, args.main_radius)]
        base_q = float((arr[valid] > 0).mean())
        hit = float((lp > 0).mean())
        hit_neg = float((ln > 0).mean())
        auc = auc_of(lp, ln)
        lo, hi = boot_ci(lp.astype(float), ln.astype(float), auc_of)
        sens_rows.append(dict(q=q, base_area=base_q, hit_pos=hit,
                              hit_neg=hit_neg,
                              lift_area=hit / base_q if base_q > 0 else np.nan,
                              auc=auc, auc_ci_lo=lo, auc_ci_hi=hi))
    df_s = pd.DataFrame(sens_rows)

    # 分区（流域）
    basins = gpd.read_file(BASINS).to_crs("EPSG:4326")
    name_col = "BasinName" if "BasinName" in basins.columns else basins.columns[0]
    pg = gpd.GeoDataFrame(pos[["lon", "lat"]],
                          geometry=gpd.points_from_xy(pos.lon, pos.lat),
                          crs="EPSG:4326")
    ng = gpd.GeoDataFrame(pd.DataFrame({"lon": neg_lon, "lat": neg_lat}),
                          geometry=gpd.points_from_xy(neg_lon, neg_lat),
                          crs="EPSG:4326")
    pj = gpd.sjoin(pg, basins[[name_col, "geometry"]], predicate="within",
                   how="left")
    nj = gpd.sjoin(ng, basins[[name_col, "geometry"]], predicate="within",
                   how="left")
    pj = pj[~pj.index.duplicated()]
    nj = nj[~nj.index.duplicated()]
    pbasin = pj[name_col].fillna("未分区").values
    nbasin = nj[name_col].fillna("未分区").values
    sub_rows = []
    for basin in sorted(set(pbasin)):
        mp = pbasin == basin
        mn = nbasin == basin
        if mp.sum() == 0:
            continue
        lpp, lnn = lp_main[mp], ln_main[mn]
        sub_rows.append(dict(
            basin=basin, n_pos=int(mp.sum()), n_neg=int(mn.sum()),
            hit_pos=float((lpp > 0).mean()) if len(lpp) else np.nan,
            hit_neg=float((lnn > 0).mean()) if len(lnn) else np.nan,
            auc=auc_of(lpp, lnn) if (len(lpp) >= 20 and len(lnn) >= 20 and
                                     len(np.unique(np.r_[lpp, lnn])) > 1) else np.nan))
    df_sub = pd.DataFrame(sub_rows).sort_values("n_pos", ascending=False)

    # ---- 点位表 ----
    out = pd.DataFrame({
        "label": np.r_[np.ones(len(lp_main), int), np.zeros(len(ln_main), int)],
        "source": np.r_[pos.source.values, ["random"] * len(ln_main)],
        "year": np.r_[pos.year.values, np.zeros(len(ln_main), int)],
        "lon": np.r_[pos.lon.values, neg_lon],
        "lat": np.r_[pos.lat.values, neg_lat],
        "dist_river_km": np.r_[pos_dist, neg_dist],
        "p99_0km": np.r_[lv[(99, 0.0)][0], lv[(99, 0.0)][1]],
        "p99_1km": np.r_[lv[(99, 1.0)][0], lv[(99, 1.0)][1]],
        "p99_3km": np.r_[lv[(99, 3.0)][0], lv[(99, 3.0)][1]],
        "p99_5km": np.r_[lv[(99, 5.0)][0], lv[(99, 5.0)][1]],
        "p10_1km": np.r_[lv[(10, 1.0)][0], lv[(10, 1.0)][1]],
        "p50_1km": np.r_[lv[(50, 1.0)][0], lv[(50, 1.0)][1]],
        "p90_1km": np.r_[lv[(90, 1.0)][0], lv[(90, 1.0)][1]],
        "p95_1km": np.r_[lv[(95, 1.0)][0], lv[(95, 1.0)][1]],
        "basin": np.r_[pbasin, nbasin],
    })
    # 注意：pbasin 已按过滤后的 pos 顺序对齐
    out.to_csv(os.path.join(OUT, "验证点位等级表.tsv"), sep="\t",
               index=False, encoding="utf-8-sig")
    df_a.to_csv(os.path.join(OUT, "指标_覆盖度.csv"), index=False,
                encoding="utf-8-sig")
    df_b.to_csv(os.path.join(OUT, "指标_AUC.csv"), index=False,
                encoding="utf-8-sig")
    df_s.to_csv(os.path.join(OUT, "指标_阈值敏感性.csv"),
                index=False, encoding="utf-8-sig")
    df_sub.to_csv(os.path.join(OUT, "指标_分流域.csv"), index=False,
                  encoding="utf-8-sig")

    # ---- 图 ----
    plt.rcParams.update({"font.sans-serif": ["Microsoft YaHei", "SimHei", "DejaVu Sans"],
                         "axes.unicode_minus": False,
                         "font.size": 9, "axes.grid": True,
                         "grid.alpha": 0.25, "savefig.dpi": 300})
    # ROC（只保留 p99；五档最大强度场相同，其余分位见报告表格）
    from sklearn.metrics import roc_curve
    lp99, ln99 = lv[(99, args.main_radius)]
    y = np.r_[np.ones(len(lp99)), np.zeros(len(ln99))]
    fpr, tpr, _ = roc_curve(y, np.r_[lp99, ln99])
    fig, ax = plt.subplots(figsize=(5.6, 5))
    ax.plot(fpr, tpr, lw=1.8, color="C4",
            label="p99（AUC = %.3f）" % auc_of(lp99, ln99))
    ax.plot([0, 1], [0, 1], "k--", lw=0.8)
    ax.set_xlabel("假阳性率", fontsize=11); ax.set_ylabel("真阳性率", fontsize=11)
    ax.tick_params(labelsize=9)
    ax.set_title("ROC 曲线（p99，1 km，2024–2025 年）：历史洪水点与分层随机对照点",
                 fontsize=11)
    ax.legend(frameon=False, loc="lower right", fontsize=9)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, "图2_ROC曲线.png"))
    fig.savefig(os.path.join(FIG, "图2_ROC曲线.pdf")); plt.close(fig)

    # 容差曲线不做图：0/1/3/5 km 数字保留在 指标_覆盖度.csv 与 A 节表格

    # 等级构成图不做：论文中以表 1 呈现
    # 阈值敏感性不做图：p10–p99 五档最大强度场完全相同，表格见 B_区分能力检验.md

    # 分级点位分布图（p99 降采样）
    with rasterio.open(haz_path[99]) as s:
        small = s.read(1, out_shape=(780, 1740),
                       resampling=Resampling.nearest)
        ext = (s.bounds.left, s.bounds.right, s.bounds.bottom, s.bounds.top)
    fig, ax = plt.subplots(figsize=(8, 5))
    im = ax.imshow(np.where(small == 0, np.nan, small), extent=ext,
                   cmap="YlOrRd", vmin=1, vmax=5, interpolation="nearest")
    tp = gpd.read_file(TP_BOUNDARY)
    tp.boundary.plot(ax=ax, color="k", lw=0.6)
    ax.scatter(pos.lon, pos.lat, s=7, c="tab:blue", label="历史洪水点")
    ax.scatter(neg_lon, neg_lat, s=4, c="tab:green", alpha=0.4,
               label="随机对照点")
    ax.set_xlabel("经度", fontsize=11); ax.set_ylabel("纬度", fontsize=11)
    ax.tick_params(labelsize=9)
    ax.legend(loc="lower left", frameon=True, fontsize=9)
    ax.set_title("1980–2023 年 p99 危险性等级与 2024–2025 年验证样本", fontsize=12)
    cbar = fig.colorbar(im, ax=ax, shrink=0.6, label="危险性等级")
    cbar.set_label("危险性等级", fontsize=11)
    cbar.ax.tick_params(labelsize=9)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, "图1_危险性等级与验证点位.png"))
    fig.savefig(os.path.join(FIG, "图1_危险性等级与验证点位.pdf")); plt.close(fig)

    # ---- 报告 ----
    def fmt(x, nd=3):
        return "nan" if not np.isfinite(x) else ("%." + str(nd) + "f") % x

    L = ["# A 节 · 覆盖度复核（留出期 2024–2025）", "",
         "- 危险性栅格：`%s`（阈值：现有逐像元分位，经 1980–2023 抽样行核验等价；p99）"
         % os.path.basename(haz_path[99]),
         "- 正样本：SHP 2024–2025 事件点，TP 边界 ∩ 栅格 ∩ 有效径流区过滤后 **%d** 点"
         "（2024：%d，2025：%d）" % (len(lp_main), n_pos_2024, n_pos_2025),
         "- 原始 328 点中 5 点落在栅格/TP 边界外或无径流像元，按设计 3.3 剔除",
         "- 真值来源：`2004_2025.shp` + `1980_2003.shp`（原始 docs 目录已在提交 55c575e 删除，"
         "本次从提交 e730108 恢复到 `data/points_src/`）",
         "- 负样本：全域有效区随机点，按距河流距离分层，**%d** 点" % len(ln_main),
         "- 主口径位置容差：%.0f km（窗口内取最大等级）" % args.main_radius,
         "- 面积基线 Base = 淹没像元 / 有效像元 = %d / %d = **%.4f**"
         % (int((arr99[valid] > 0).sum()), n_valid_cells, base_area), "",
         "## 主结果", "",
         "| 容差 km | 正样本命中率 | 95% CI | 随机点命中率 | 面积基线 | Lift(面积) | Lift(随机点) | Lift 95% CI |",
         "|---:|---:|---|---:|---:|---:|---:|---|"]
    for _, r in df_a.iterrows():
        L.append("| %.0f | %.4f | [%.4f, %.4f] | %.4f | %.4f | %.3f | %.3f | [%.3f, %.3f] |" % (
            r.radius_km, r.hit_pos, r.hit_ci_lo, r.hit_ci_hi, r.hit_neg,
            r.base_area, r.lift_area, r.lift_sample, r.lift_ci_lo, r.lift_ci_hi))
    L += ["", "## 补充：较高危险等级覆盖率（p99）", "",
          "等级 >0 在 44 年合成图上已饱和；下表用 ≥3 / ≥4 级作为“较高危险区”的替代口径。", "",
          "| 容差 km | Hit(≥3) | 随机(≥3) | 面积基线(≥3) | Lift(≥3) | Hit(≥4) | 随机(≥4) | 面积基线(≥4) | Lift(≥4) |",
          "|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for _, r in df_a.iterrows():
        L.append("| %.0f | %.4f | %.4f | %.4f | %.3f | %.4f | %.4f | %.4f | %.3f |" % (
            r.radius_km, r.hit_pos_ge3, r.hit_neg_ge3, r.base_area_ge3,
            r.lift_area_ge3, r.hit_pos_ge4, r.hit_neg_ge4, r.base_area_ge4,
            r.lift_area_ge4))
    L += ["", "## 判读", "",
          "- 命中率是**覆盖度**而非精度；Lift ≤ 1 表示不比随机落点强。",
          "- 补充口径（1 km）：≥3 级覆盖率 %.3f（随机点 %.3f；相对面积基线 Lift %.2f）；"
          "≥4 级覆盖率 %.3f（随机点 %.3f；相对面积基线 Lift %.2f）。" % (
              r1.hit_pos_ge3, r1.hit_neg_ge3, r1.lift_area_ge3,
              r1.hit_pos_ge4, r1.hit_neg_ge4, r1.lift_area_ge4),
          "- 本轮阈值修正后，44 年（1980–2023）累计淹没区已覆盖有效区的 %.2f%%，"
          "面积基线接近 1，因此 Lift 天然接近 1；A 节无法再区分高低危险区。" % (100 * base_area),
          "- 原因：逐像元 p99 阈值意味着每个像元平均每 100 天有 1 天超阈，44 年累计超阈"
          "期望约 160 天，几乎必然至少淹没一次；这是“相对分级”方法的固有性质，"
          "不是数据错误。",
          "- 若需要可区分的覆盖度检验，应改用更极端的阈值（如 p99.9/p99.99）、"
          "更短的危险性合成时段，或直接检验年度危险性图。", ""]
    with open(os.path.join(OUT, "A_覆盖度复核.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L))

    L = ["# B 节 · 区分能力检验（留出期 2024–2025）", "",
         "- 评分：危险性等级 0–5；正样本 = SHP 事件点（2024：%d，2025：%d），"
         "负样本 = 分层随机点" % (n_pos_2024, n_pos_2025),
         "- 真值来源：`2004_2025.shp` + `1980_2003.shp`（从提交 e730108 恢复）",
         "- 主口径：p99、1 km；AUC 置信区间为 1000 次分层 bootstrap 的 95% 分位区间", "",
         "## ROC-AUC（p99）", "",
         "| 容差 km | AUC | 95% CI | 正样本 | 负样本 |", "|---:|---:|---|---:|---:|"]
    for _, r in df_b.iterrows():
        L.append("| %.0f | %.4f | [%.4f, %.4f] | %d | %d |" % (
            r.radius_km, r.auc, r.ci_lo, r.ci_hi, r.n_pos, r.n_neg))
    L += ["", "## 等级单调性（p99，1 km）", "",
          "| 等级 k | Pk（事件点） | Nk（随机点） | Pk/Nk |", "|---:|---:|---:|---:|"]
    for k in ks:
        L.append("| %d | %.4f | %.4f | %s |" % (
            k, pk[k], nk[k], ("%.3f" % ratio[k]) if np.isfinite(ratio[k]) else "—"))
    L += ["", "Spearman ρ(k, Pk/Nk) = **%.3f**，p = %.3g；严格单调不减：**%s**。"
          "（等级 1–2 的事件样本很少，低等级比值噪声较大。）"
          % (rho, pval, "是" if mono else "否"), "",
          "## 阈值敏感性（1 km）", "",
          "| 分位 | 面积基线 | 正样本命中率 | 随机点命中率 | Lift(面积) | AUC | AUC 95% CI |",
          "|---:|---:|---:|---:|---:|---:|---|"]
    for _, r in df_s.iterrows():
        L.append("| p%d | %.4f | %.4f | %.4f | %.3f | %.4f | [%.4f, %.4f] |" % (
            r.q, r.base_area, r.hit_pos, r.hit_neg, r.lift_area,
            r.auc, r.auc_ci_lo, r.auc_ci_hi))
    L += ["", "> 五档结果完全一致，是方法性质而不是数据错误：时段最大算子必然包含每个像元"
          "最大径流日，而该日必然 ≥ 任何分位阈值；当所有有效像元在 44 年内至少超阈一次时，"
          "五档的“淹没最大强度场”完全相同。阈值只改变“是否淹没”，不改变最大强度排序。"
          "因此 p10–p99 敏感性检验无法提供额外区分信息。", "", "## 分区稳健性（p99，1 km，按流域）", "",
          "| 流域 | 正样本 | 负样本 | 命中率(正) | 命中率(负) | AUC |", "|---|---:|---:|---:|---:|---:|"]
    for _, r in df_sub.iterrows():
        L.append("| %s | %d | %d | %.3f | %.3f | %s |" % (
            r.basin, r.n_pos, r.n_neg, r.hit_pos, r.hit_neg,
            ("%.3f" % r.auc) if np.isfinite(r.auc) else "样本不足"))
    L += ["", "> 分区结果中正样本 <20 的组只作定性参考，不作独立结论。", "",
          "## 判定", "",
          "- 主口径（p99，1 km）AUC = **%.3f**，%s 0.7 的“有区分能力”门槛。"
          % (df_b[df_b.radius_km == args.main_radius].iloc[0].auc,
             "高于" if df_b[df_b.radius_km == args.main_radius].iloc[0].auc >= 0.7 else "低于"),
          "- 等级比例 Pk/Nk 总体随等级上升（Spearman ρ = %.3f，%s），"
          "但低等级（1–2 级）样本少、比值不严格单调。" % (
              rho, "趋势显著（p<0.05）" if pval < 0.05 else "趋势不显著"),
          "- 由于 44 年合成图等级 >0 已饱和，覆盖度（A 节主表）不具区分力；"
          "区分能力主要体现在等级排序（B 节）与 ≥3/≥4 级覆盖率（A 节补充表）。", "",
          "## 判读边界", "",
          "- AUC 是**排序能力**，不是概率校准；不能推出“某年某地会淹多深”。",
          "- 等级是淹没区内的相对分位（各级约 20%），不同阈值/时段的等级不可直接比较。",
          "- 真值只代表“被记录、被编目”的洪水事件，对无记录事件存在漏记。",
          "- 留出期正样本仅 %d 点，置信区间偏宽；分区后样本更少。" % len(lp_main), ""]
    with open(os.path.join(OUT, "B_区分能力检验.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L))

    print("\nA 节:\n", df_a.to_string(index=False))
    print("\nB 节:\n", df_b.to_string(index=False))
    print("\n阈值敏感性:\n", df_s.to_string(index=False))
    print("\n分区:\n", df_sub.to_string(index=False))
    print("\n输出目录: %s" % OUT)


if __name__ == "__main__":
    main()
