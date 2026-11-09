# -*- coding: utf-8 -*-
"""吉隆「8·26」二维浅水数值场求解器 —— 原型，尚未接入页面。

状态（2026-11-09）：**链路已跑通，物理结果未率定，不可用于演示或工程判断**。
  - 已验证：ANUGA 4.1.0 在独立 venv 可安装（需跳过 pymetis，Windows 无 C 编译器）；
    真实 height.bin 解码；源区经纬度 → 局部米坐标的南北方向校准；
    建域 / 设置高程与摩擦 / 绑定边界 / evolve / 逐帧读流深。
  - 未解决：60×34 网格（每三角形约 360 m）分辨不出 22 km 沟谷；
    一次性溃决水体不是论文表 4 的流量过程线；四周 Reflective 边界让水出不去；
    结果 maxH 从初始 13.85 m 涨到 118 m、湿格几乎不扩散，说明水困在洼地里震荡。
  - 下一步（TODO）：网格加密到 ~400×220 或沿沟道局部加密；改用 Inflow_operator
    给表 4 流量过程；边界改 Transmissive/open；按 505 s 到达口岸校准 Manning n；
    再插值成 512×289 时序 float32 场，才能考虑替换页面里的「视觉外推」。

口径边界：ANUGA 解的是**清水 Saint-Venant 浅水方程**，不是泥石流两相流 /
宾汉流体；初始水体是演示用溃决水体，不是率定过的工程模型。即使数值稳定，
也不能直接称作「8·26 泥石流实测/预测结果」。

运行（独立 venv，不污染全局 Python）：
  python -m venv <venv>
  <venv>/Scripts/python.exe -m pip install --no-deps anuga==4.1.0
  <venv>/Scripts/python.exe -m pip install --only-binary=:all: "numpy>=2" \
      "scipy>=1.11" dill matplotlib netCDF4 meshpy
  <venv>/Scripts/python.exe tools/anuga_field.py
"""
import os
import sys
import json
import time
import traceback

import numpy as np
from scipy.interpolate import RegularGridInterpolator

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "tools", "output")

# 可调参数：下一步迭代主要动这几个
NX, NY = 60, 34              # ANUGA 三角网密度（当前太粗，TODO 加密）
FINAL_TIME = 60.0            # s（页面基准总历时 505 s，TODO 对齐）
YIELD_STEP = 10.0            # s
MANNING_N = 0.035
LAKE_RADIUS = 620.0          # m，演示用溃决水体半径
LAKE_DEPTH = 14.0            # m


def dem_and_interp():
    with open(os.path.join(DATA, "meta.json"), "r", encoding="utf-8") as f:
        meta = json.load(f)
    n = meta["meshSize"] + 1
    raw = np.fromfile(os.path.join(DATA, "height.bin"), dtype="<i2")
    if raw.size != n * n:
        raise ValueError("height.bin 长度不符：%d != %d" % (raw.size, n * n))
    dem = raw.reshape(n, n).astype(np.float64) + float(meta["minHeight"])
    lx, ly = meta["sizeMeters"]["x"], meta["sizeMeters"]["z"]
    xs = np.linspace(-lx / 2, lx / 2, n)
    # DEM 行 0 = 北，故 y 轴取「y 增大向南」；已用 field.json 源区高程 5197 m 校准：
    # 正确方向采样 5203.9 m（差 7 m），反向采样 6184 m（明显错误）。
    ys = np.linspace(-ly / 2, ly / 2, n)
    interp = RegularGridInterpolator((ys, xs), dem, bounds_error=False,
                                     fill_value=float(meta["minHeight"]))
    return meta, lx, ly, dem, interp


def source_xy(field, meta, lx, ly, interp):
    b = meta["bbox"]
    lon, lat, paper_h = field["source"][0], field["source"][1], field["source"][2]
    x = (lon - b[0]) / (b[2] - b[0]) * lx - lx / 2
    y = ly / 2 - (lat - b[1]) / (b[3] - b[1]) * ly
    return x, y, float(interp((y, x))), paper_h


def main():
    import anuga
    # ANUGA 默认把 domain.sww 写在当前工作目录，会污染仓库根目录；
    # 这里把工作目录切到 tools/output/（ROOT/DATA 都是绝对路径，不受影响）。
    os.makedirs(OUT, exist_ok=True)
    os.chdir(OUT)
    meta, lx, ly, dem, interp = dem_and_interp()
    with open(os.path.join(DATA, "field.json"), "r", encoding="utf-8") as f:
        field = json.load(f)
    sx, sy, src_elev, paper_h = source_xy(field, meta, lx, ly, interp)
    print("ANUGA %s | DEM %s %.1f~%.1f m" %
          (anuga.__version__, dem.shape, dem.min(), dem.max()))
    print("源区 x=%.1f y=%.1f DEM=%.1f m（论文 %s m，差 %.1f m）" %
          (sx, sy, src_elev, paper_h, src_elev - paper_h))

    domain = anuga.rectangular_cross_domain(NX, NY, len1=lx, len2=ly,
                                            origin=(-lx / 2, -ly / 2))
    print("三角网 %d 个三角形" % len(domain))

    def elevation_at(x, y):
        pts = np.column_stack([np.asarray(y, dtype=float).ravel(),
                               np.asarray(x, dtype=float).ravel()])
        return interp(pts).reshape(np.asarray(x).shape)

    domain.set_quantity("elevation", elevation_at)
    domain.set_quantity("friction", MANNING_N)
    domain.set_quantity("stage", elevation_at)

    # 关键坑：stage 的基底必须取 ANUGA 自己离散化后的 elevation 质心值，
    # 不能另外插值一次。陡峭地形下两套离散高程相差几百米，
    # 相减会凭空造出几百米假水深（2026-11-09 实测踩过）。
    cen = domain.centroid_coordinates
    elev_c = domain.quantities["elevation"].get_values(location="centroids")
    lake = LAKE_DEPTH * np.exp(
        -((cen[:, 0] - sx) ** 2 + (cen[:, 1] - sy) ** 2) / (2 * LAKE_RADIUS ** 2))
    domain.quantities["stage"].set_values(elev_c + lake, location="centroids")
    h0 = domain.quantities["stage"].get_values(location="centroids") - elev_c
    print("初始水体 maxH=%.2f m meanH=%.3f m（演示用溃决水体，未率定）" %
          (h0.max(), h0.mean()))

    # ANUGA 要求 evolve 前把边界标签绑定到边界对象，否则直接 AssertionError
    br = anuga.Reflective_boundary(domain)   # TODO 改 Transmissive/open
    domain.set_boundary({"left": br, "right": br, "top": br, "bottom": br})

    os.makedirs(OUT, exist_ok=True)
    frames = []
    t0 = time.time()
    for t in domain.evolve(yieldstep=YIELD_STEP, finaltime=FINAL_TIME):
        # ANUGA 4.1.0 没有独立的 depth 量，用 stage - elevation 求
        stage = domain.quantities["stage"].get_values(location="centroids")
        depth = np.maximum(stage - elev_c, 0.0)
        wet = int((depth > 0.05).sum())
        rec = {"t": round(float(t), 1), "wet": wet,
               "maxH": round(float(depth.max()), 2)}
        frames.append(rec)
        print("t=%6.1f wet=%5d maxH=%7.2f (%.1fs)" %
              (t, wet, depth.max(), time.time() - t0))

    out = {
        "solver": "anuga 4.1.0 / rectangular_cross_domain / shallow water",
        "status": "PROTOTYPE - NOT CALIBRATED, DO NOT USE FOR DISPLAY",
        "caveat": "清水浅水方程，非泥石流两相流；一次性溃决水体，非论文流量过程线；"
                  "网格过粗且四壁封闭，结果不可用作淹没范围或工程判断",
        "params": {"NX": NX, "NY": NY, "finalTime": FINAL_TIME,
                   "yieldStep": YIELD_STEP, "manningN": MANNING_N,
                   "lakeRadius": LAKE_RADIUS, "lakeDepth": LAKE_DEPTH},
        "frames": frames,
    }
    p = os.path.join(OUT, "anuga_proto_frames.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("写出 %s" % p)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
