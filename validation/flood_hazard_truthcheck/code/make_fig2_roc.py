# -*- coding: utf-8 -*-
"""重出图 2：单张 ROC 曲线（沿用 hazard_verify_holdout.py 的数据与样式），
图内不标标题、不标工作点，图例只写“危险性等级（AUC = 0.781）”。

数据来自 outputs_v2/验证点位等级表.tsv（p99，1 km 主口径）。

输出：outputs_v2/图件/图2_ROC曲线.png|pdf（5.6×5 in，300 dpi，1680×1500）
"""
import os
import sys

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score, roc_curve

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PROJ

BASE = os.path.join(str(PROJ), "validation", "flood_hazard_truthcheck", "outputs_v2")
FIG = os.path.join(BASE, "图件")
PTS = os.path.join(BASE, "验证点位等级表.tsv")

# 不标注工作点：曲线本身已给出各等级对应的 (FPR, TPR)


def main():
    d = pd.read_csv(PTS, sep="\t")
    lp = d.loc[d.label == 1, "p99_1km"].astype(int).values
    ln = d.loc[d.label == 0, "p99_1km"].astype(int).values
    y = np.r_[np.ones(len(lp)), np.zeros(len(ln))]
    score = np.r_[lp, ln].astype(float)
    auc = float(roc_auc_score(y, score))
    fpr, tpr, _ = roc_curve(y, score)

    plt.rcParams.update({"font.sans-serif": ["Microsoft YaHei", "SimHei", "DejaVu Sans"],
                         "axes.unicode_minus": False,
                         "font.size": 9, "axes.grid": True,
                         "grid.alpha": 0.25, "savefig.dpi": 300})
    fig, ax = plt.subplots(figsize=(5.6, 5))
    ax.plot(fpr, tpr, lw=1.8, color="C4", label="危险性等级（AUC = %.3f）" % auc)
    ax.plot([0, 1], [0, 1], "k--", lw=0.8)

    ax.set_xlabel("假阳性率", fontsize=11)
    ax.set_ylabel("真阳性率", fontsize=11)
    ax.tick_params(labelsize=9)
    ax.set_xlim(-0.02, 1.02); ax.set_ylim(-0.02, 1.02)
    ax.legend(frameon=False, loc="lower right", fontsize=9)
    fig.tight_layout()
    for ext in ("png", "pdf"):
        fig.savefig(os.path.join(FIG, "图2_ROC曲线." + ext))
    plt.close(fig)
    print("AUC = %.4f；已保存 %s" % (auc, os.path.join(FIG, "图2_ROC曲线.png")))


if __name__ == "__main__":
    main()
