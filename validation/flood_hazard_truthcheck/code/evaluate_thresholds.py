# -*- coding: utf-8 -*-
"""多阈值危险性评估：对每个分位阈值生成的危险性栅格算命中率并横向对比。

流程：
    1) 对每个 {start}_to_{end}_basin-{basin}_hazard_p{q}.tif 调 hazard_verify_full.py
       得到点位等级表与命中率（默认主口径 1 km）
    2) 从 threshold_summary_{stamp}.csv 读各阈值的淹没面积占比
    3) 输出对比报告 md + 敏感性图（命中率 vs 淹没面积占比）

输出：
    outputs/thresholds_report_{tag}.md
    outputs/thresholds_report_{tag}.csv
    outputs/figures/threshold_sensitivity_{tag}.png/.pdf

用法：
    python evaluate_thresholds.py --start 2024-01-01 --end 2024-12-31 --tag 2024 --year 2024
    python evaluate_thresholds.py --start 1980-01-01 --end 2025-12-31 --tag full
"""
import argparse
import subprocess
import sys
from pathlib import Path

import pandas as pd

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

from common import OUT_DIR

for _f in font_manager.fontManager.ttflist:
    if "YaHei" in _f.name:
        plt.rcParams["font.family"] = _f.name
        break
plt.rcParams["axes.unicode_minus"] = False

FIG_DIR = OUT_DIR / "figures"
FIG_DIR.mkdir(exist_ok=True)
HERE = Path(__file__).resolve().parent
MAIN_COL = "level_1km"


def eval_one(haz_path, tag, year, radius):
    cmd = [sys.executable, "hazard_verify_full.py", "--hazard", str(haz_path),
           "--tag", tag, "--main_radius", str(radius)]
    if year:
        cmd += ["--year", str(year)]
    p = subprocess.run(cmd, cwd=str(HERE), capture_output=True)
    if p.returncode != 0:
        print("  失败: %s\n%s" % (haz_path.name, p.stderr.decode("utf-8", "replace")))
        return None
    df = pd.read_csv(OUT_DIR / ("points_%s_tp_levels.csv" % tag), encoding="utf-8-sig")

    def stat(sub):
        v = sub[MAIN_COL].values
        v = v[v >= 0]
        return len(v), int((v > 0).sum()), (float((v > 0).mean()) if len(v) else 0.0)

    n_all, h_all, r_all = stat(df)
    shp = df[df.source == "shp_combined"]
    cs = df[df.source == "groundsource_csv"]
    n_s, h_s, r_s = stat(shp)
    n_c, h_c, r_c = stat(cs)
    lv = df[MAIN_COL].values
    return dict(tag=tag, n_all=n_all, hit_all=h_all, rate_all=r_all,
                n_shp=n_s, hit_shp=h_s, rate_shp=r_s,
                n_csv=n_c, hit_csv=h_c, rate_csv=r_c,
                ge3=float((lv[lv >= 0] >= 3).mean()) if n_all else 0.0,
                ge5=float((lv[lv >= 0] >= 5).mean()) if n_all else 0.0)


def main():
    ap = argparse.ArgumentParser(description="多阈值危险性评估")
    ap.add_argument("--hazard_dir", required=True)
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--basin", default="all")
    ap.add_argument("--quantiles", default="10,50,90,95,99")
    ap.add_argument("--tag", required=True, help="输出标识（通常同年份/时段）")
    ap.add_argument("--year", type=int, default=0, help="点位限定年份（0=全部）")
    ap.add_argument("--radius", type=float, default=1.0)
    args = ap.parse_args()

    stamp = "%s_to_%s_basin-%s" % (args.start, args.end, args.basin)
    quantiles = [int(q) for q in args.quantiles.split(",") if q.strip()]

    # 淹没面积占比（来自批量生成脚本的汇总表）
    area = {}
    summ = Path(args.hazard_dir) / ("threshold_summary_%s.csv" % stamp)
    if summ.exists():
        sdf = pd.read_csv(summ, encoding="utf-8-sig")
        area = dict(zip(sdf["quantile"].astype(int), sdf["inundated_frac"].astype(float)))

    rows = []
    for q in quantiles:
        haz = Path(args.hazard_dir) / ("%s_hazard_p%d.tif" % (stamp, q))
        if not haz.exists():
            print("跳过（缺文件）: %s" % haz.name)
            continue
        print("评估 %dp ..." % q)
        r = eval_one(haz, "p%d_%s" % (q, args.tag), args.year, args.radius)
        if r is None:
            continue
        r["quantile"] = q
        r["inundated_frac"] = area.get(q, float("nan"))
        r["hazard_file"] = haz.name
        rows.append(r)

    if not rows:
        raise SystemExit("没有可评估的结果")

    out = pd.DataFrame(rows)[["quantile", "hazard_file", "inundated_frac",
                              "n_all", "hit_all", "rate_all",
                              "n_shp", "hit_shp", "rate_shp",
                              "n_csv", "hit_csv", "rate_csv", "ge3", "ge5"]]
    csv_path = OUT_DIR / ("thresholds_report_%s.csv" % args.tag)
    out.to_csv(csv_path, index=False, encoding="utf-8-sig")

    md = ["# 多阈值危险性评估（%s，点位口径：%s）" % (
        args.tag, ("全部年份" if not args.year else "%d 年" % args.year)), "",
        f"- 危险性栅格：`{stamp}_hazard_p{{q}}.tif`（位置容差 {args.radius} km）",
        "- 说明：各阈值独立做淹没区 min-max 归一化 + 20/40/60/80 分位分级，"
        "故不同阈值的「3 级」不代表同一绝对强度", "",
        "| 阈值分位 | 淹没面积占比 | 总点数 | 总命中率 | shp 点数 | shp 命中率 | "
        "csv 点数 | csv 命中率 | ≥3 级占比 | ≥5 级占比 |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in rows:
        md.append("| %dp | %.2f%% | %d | %.1f%% | %d | %.1f%% | %d | %.1f%% | %.1f%% | %.1f%% |" % (
            r["quantile"], 100 * r["inundated_frac"], r["n_all"], 100 * r["rate_all"],
            r["n_shp"], 100 * r["rate_shp"], r["n_csv"], 100 * r["rate_csv"],
            100 * r["ge3"], 100 * r["ge5"]))
    md += ["", "> 命中率基线＝淹没面积占比：命中率高于该值才说明「点位比随机落点更易命中」。", ""]
    (OUT_DIR / ("thresholds_report_%s.md" % args.tag)).write_text("\n".join(md),
                                                                  encoding="utf-8")
    print("报告: %s" % (OUT_DIR / ("thresholds_report_%s.md" % args.tag)))

    # ---- 敏感性图 ----
    qs = [r["quantile"] for r in rows]
    fr = [100 * r["inundated_frac"] for r in rows]
    r_all = [100 * r["rate_all"] for r in rows]
    r_shp = [100 * r["rate_shp"] for r in rows]
    r_csv = [100 * r["rate_csv"] for r in rows]

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2))
    ax = axes[0]
    ax.plot(qs, r_shp, "o-", color="#d7191c", label="SHP 点位命中率")
    ax.plot(qs, r_all, "s-", color="#2c7bb6", label="全部点位命中率")
    ax.plot(qs, r_csv, "^-", color="#6a51a3", label="CSV 点位命中率")
    ax.plot(qs, fr, "k--", marker="x", label="淹没面积占比（随机基线）")
    for x, y in zip(qs, r_shp):
        ax.annotate("%.1f%%" % y, (x, y), textcoords="offset points", xytext=(0, 6),
                    ha="center", fontsize=8)
    ax.set_xlabel("阈值分位"); ax.set_ylabel("比例 (%)")
    ax.set_title("命中率与淹没面积占比随阈值分位变化", fontsize=11)
    ax.set_xticks(qs); ax.grid(alpha=0.3); ax.legend(fontsize=8, frameon=False)

    ax = axes[1]
    width = 0.35
    xs = range(len(qs))
    ax.bar([i - width / 2 for i in xs], r_shp, width, color="#d7191c",
           label="SHP 命中率")
    ax.bar([i + width / 2 for i in xs], fr, width, color="#bdbdbd",
           label="淹没面积占比")
    ax.set_xticks(list(xs)); ax.set_xticklabels(["%dp" % q for q in qs])
    ax.set_ylabel("比例 (%)"); ax.set_title("命中率 vs 随机基线（差值越大越有判别力）",
                                            fontsize=11)
    ax.grid(alpha=0.3, axis="y"); ax.legend(fontsize=8, frameon=False)
    fig.tight_layout()
    fig.savefig(FIG_DIR / ("threshold_sensitivity_%s.png" % args.tag), dpi=300)
    fig.savefig(FIG_DIR / ("threshold_sensitivity_%s.pdf" % args.tag))
    print("图: %s" % (FIG_DIR / ("threshold_sensitivity_%s.png" % args.tag)))


if __name__ == "__main__":
    main()
