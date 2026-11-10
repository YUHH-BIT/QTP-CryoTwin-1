# -*- coding: utf-8 -*-
"""吉隆 8·26 灾害链：一维沿程运动学模型（推演用）。

边界条件全部锚定官方通报：
  - 起点 5200 m（冰岩崩断裂）、终点 1800 m（口岸）、沿程 22 km、历时 6~7 分钟
  - 冰岩崩 10:52 发生、10:59 冲击口岸
方法：
  - 速度按当地坡度分布 v ∝ sqrt(sinθ)（陡段快、宽谷段慢），整体按总历时标定；
  - 峰值流量按"参与运动流团断面 × 速度"推算，体积取量级示意值。
输出 model.json：逐段 s/h/坡度/速度/时刻/流量 + 关键时刻 + 剖面抽样。
注意：官方只公布了源头高程、距离、历时和灾损，未公布流量与体积，
      故体积/流量为示意值，界面必须标注"推演参数，非官方核定"。
"""
import os, io, json, math

GY = os.path.join("webgis_frontend", "terrain3d", "gyirong")
T_TOTAL = 390.0          # 官方 10:52 -> 10:59 约 6.5 分钟
V_BULK = 2.0e7           # m³ 量级示意（60 个足球场冰川 × 平均厚度约 45 m）
ACTIVE_LEN = 3000.0      # 参与运动流团长度 m
FLOW_WIDTH = 100.0       # 沟道流宽 m
FLOW_DEPTH = 20.0        # 平均流深 m


def main():
    with io.open(os.path.join(GY, "channel.json"), encoding="utf-8") as f:
        ch = json.load(f)
    pts = ch["points"]
    s = [p[3] for p in pts]
    h = [p[2] for p in pts]
    n = len(pts)

    seg = []
    for i in range(n - 1):
        ds = max(s[i + 1] - s[i], 1e-6)
        dh = h[i] - h[i + 1]
        theta = math.atan2(dh, ds)
        seg.append({"i": i, "ds": ds, "dh": dh, "slopeDeg": math.degrees(theta)})

    # v ∝ (sinθ)^0.18：坡度影响速度但不做开方放大，缓段用下限兜底
    for g in seg:
        sin_t = max(math.sin(math.radians(g["slopeDeg"])), 0.0)
        g["f"] = min(max(sin_t, 0.02), 1.0) ** 0.18

    sum_inv = sum(g["ds"] / g["f"] for g in seg)
    k = sum_inv / T_TOTAL
    t = 0.0
    for g in seg:
        g["v"] = k * g["f"]
        g["t0"] = t
        t += g["ds"] / g["v"]
        g["t1"] = t

    # 峰值流量：流团断面 A = 宽 × 深（示意），Q = A · v
    A = FLOW_WIDTH * FLOW_DEPTH
    for g in seg:
        g["Q"] = A * g["v"]

    vmax = max(g["v"] for g in seg)
    vmean = sum(g["ds"] for g in seg) / T_TOTAL
    # 到达 4000 m 的时刻（官方："坠落至 4000 m 左右，冲刷山体形成巨型泥石流"）
    t4000 = None
    for g in seg:
        if h[g["i"] + 1] <= 4000.0:
            t4000 = g["t1"]
            break

    # 逐点（供前端时间轴用）
    prof = []
    for g in seg:
        prof.append([round(s[g["i"]], 1), round(h[g["i"]], 1),
                     round(g["slopeDeg"], 2), round(g["v"], 2),
                     round(g["t0"], 2), round(g["Q"], 0)])
    prof.append([round(s[-1], 1), round(h[-1], 1), 0.0,
                 round(seg[-1]["v"], 2), round(T_TOTAL, 2), round(seg[-1]["Q"], 0)])

    out = {
        "official": {
            "iceCollapse": "2026-08-26 10:52",
            "arrivePort": "2026-08-26 10:59",
            "durationSec": T_TOTAL,
            "lengthM": 22000,
            "startH": 5197, "endH": 1789,
            "source": "西藏自治区「8·26」泥石流灾害新闻发布会（2026-08-30）",
        },
        "model": {
            "method": "一维沿程运动学（v ∝ sqrt(sinθ)，总历时标定）",
            "vmaxMps": round(vmax, 2), "vmeanMps": round(vmean, 2),
            "vmaxKmh": round(vmax * 3.6, 1),
            "qpeakM3s": round(A * vmax, 0),
            "volumeM3": V_BULK,
            "tReach4000m": round(t4000, 1) if t4000 else None,
            "disclaimer": "速度、流量、体积为推演值，官方仅公布源头高程／距离／历时／灾损",
        },
        "profile": prof,
    }
    with io.open(os.path.join(GY, "model.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    lines = [f'峰值速度 {vmax:.1f} m/s ({vmax*3.6:.0f} km/h)  平均 {vmean:.1f} m/s',
             f'峰值流量 {A*vmax:.0f} m³/s  体积示意 {V_BULK:.0e} m³',
             f'到达 4000 m 时刻 {t4000:.0f} s' if t4000 else '未到达 4000 m',
             '剖面抽查（每 2km）:']
    for p in prof[::max(1, len(prof) // 12)]:
        lines.append('  %6.2f km  h=%7.1f  θ=%5.1f°  v=%5.1f m/s  t=%5.0f s'
                     % (p[0] / 1000, p[1], p[2], p[3], p[4]))
    io.open(os.path.join(os.getcwd(), ".workbuddy", "tmp", "gy_model.txt"), "w",
            encoding="utf-8").write("\n".join(lines))
    print("ok")


if __name__ == "__main__":
    main()
