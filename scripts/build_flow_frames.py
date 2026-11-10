# -*- coding: utf-8 -*-
"""吉隆“8·26”泥石流：逐帧流深场（带前锋白浪 / 边缘泡沫 / 流动条纹 / 碎屑）。

方法：
  一维沿程水动力（论文三断面标定：h=68.0/61.7/47.5 m，v=42.68/34.39/25.13 m/s，
  历时 8 min 20 s）+ 沟道距离二维展布 → 每帧一张 RGBA 贴图。

断面标定（刘昌军等，2026）：
  错坚河  s≈0      h=68.0 m  v=42.68 m/s  Q=52.60 万 m³/s
  色琼    s≈12000  h=61.7 m  v=34.39 m/s  Q=31.35 万 m³/s
  吉隆口岸 s≈22000  h=47.5 m  v=25.13 m/s  Q=18.83 万 m³/s
"""
import os, io, json, math
import numpy as np
from PIL import Image

ROOT = os.getcwd()
GY = os.path.join(ROOT, "webgis_frontend", "terrain3d", "gyirong")
OUT = os.path.join(ROOT, "webgis_frontend", "tiles", "flow")

# 纹理必须是 2 的幂：1080×608 这类尺寸在软件渲染（swiftshader）下
# 生成 mipmap 会报 glCopySubTextureCHROMIUM 错误，刷屏后整个 WebGL 上下文失效。
NX, NY = 1024, 512
T_TOTAL = 500.0
FRAME_DT = 8.0
LAT_K = 110574.0
V_LAT = 5.0                 # 横向漫流速度 m/s
SIGMA_W = 105.0             # 横向衰减尺度 m（沟谷宽度量级）
W_CUT = 420.0               # 展布半宽上限

S_KN = [0.0, 12000.0, 22000.0]
H_KN = [68.0, 61.7, 47.5]
V_KN = [42.68, 34.39, 25.13]
Q_KN = [5.260e5, 3.135e5, 1.883e5]


def main():
    ch = json.load(io.open(os.path.join(GY, "channel.json"), encoding="utf-8"))
    lons = [p[0] for p in ch["points"]]
    lats = [p[1] for p in ch["points"]]
    pad = 0.012
    bb = [min(lons) - pad, min(lats) - pad, max(lons) + pad, max(lats) + pad]
    print("bbox", [round(v, 4) for v in bb])

    pts = ch["points"]
    s_arr = np.array([p[3] for p in pts])
    s_end = float(s_arr[-1])
    scale = 22000.0 / s_end
    s_arr = s_arr * scale

    h_ch = np.interp(s_arr, S_KN, H_KN)
    v_ch = np.interp(s_arr, S_KN, V_KN)
    q_ch = np.interp(s_arr, S_KN, Q_KN)

    cum = np.concatenate([[0.0], np.cumsum(np.diff(s_arr) / np.maximum(v_ch[1:], 1e-3))])
    t_arr = cum / cum[-1] * T_TOTAL
    print("沟道 %d 点  末点 s=%.1f km  历时 %.0f s" % (len(pts), s_arr[-1] / 1000, t_arr[-1]))

    lon0, lat0, lon1, lat1 = bb
    kx = 111320.0 * math.cos(math.radians((lat0 + lat1) / 2))
    lonv = np.linspace(lon0, lon1, NX)
    latv = np.linspace(lat1, lat0, NY)
    LON, LAT = np.meshgrid(lonv, latv)
    gx = ((LON - lon0) * kx).ravel()
    gy = ((lat1 - LAT) * LAT_K).ravel()

    cx = np.array([(p[0] - lon0) * kx for p in pts])
    cy = np.array([(lat1 - p[1]) * LAT_K for p in pts])

    best_d = np.full(gx.size, 1e18)
    best_i = np.zeros(gx.size, np.int32)
    for i in range(cx.size):
        d = np.hypot(gx - cx[i], gy - cy[i])
        m = d < best_d
        best_d[m] = d[m]
        best_i[m] = i
    print("最近沟道点匹配完成")

    # 沿沟宽度变化（谷宽起伏），口岸段扩成堆积扇
    sig = SIGMA_W * (0.80 + 0.38 * np.sin(s_arr * 0.00072 + 0.6))
    sig[s_arr > 20000] *= 1.55
    sig[s_arr > 21400] *= 1.75

    T_field = t_arr[best_i] + np.minimum(best_d / V_LAT, 60.0)
    H_field = h_ch[best_i] * np.exp(-np.square(best_d / sig[best_i]))
    H_field[best_d > W_CUT * 1.8] = 0.0
    T_field[H_field <= 0] = 1e9

    # 沿沟坐标（km），用于流纹相位
    S_field = s_arr[best_i] / 1000.0
    on_any = H_field > 0.5
    print("有效格点 %d / %d" % (int(on_any.sum()), on_any.size))

    n_frame = int(T_TOTAL // FRAME_DT) + 1
    if os.path.isdir(OUT):
        for f in os.listdir(OUT):
            if f.endswith(".png"):
                os.remove(os.path.join(OUT, f))
    os.makedirs(OUT, exist_ok=True)

    rng = np.random.RandomState(20260826)
    grain = rng.rand(NY, NX).astype(np.float32)
    grain2 = rng.rand(NY, NX).astype(np.float32)
    # 碎屑斑点（稀疏亮/暗点，模拟石块与浮木）
    deb = (rng.rand(NY, NX) < 0.011).astype(np.float32)
    deb_v = rng.rand(NY, NX).astype(np.float32)

    for k in range(n_frame):
        t = k * FRAME_DT
        on = (T_field <= t) & (H_field > 0.5)
        k_ramp = np.clip((t - T_field) / 22.0, 0, 1)      # 22 s 内涨到满
        h = (H_field * k_ramp * on).reshape(NY, NX)
        d = np.clip(h / 70.0, 0, 1)

        # ---- 基础泥浆色：浅水偏黄褐、深水偏暗褐 ----
        core = np.clip(d * 2.2, 0, 1)
        r = 182 - 124 * np.power(core, 0.75)
        g = 142 - 108 * np.power(core, 0.75)
        b = 92 - 72 * np.power(core, 0.75)

        # ---- 流动条纹（沿沟方向 + 时间推进，两个尺度叠加）----
        ph = S_field.reshape(NY, NX) * 2.6 - t * 0.55 + grain * 3.0
        ph2 = S_field.reshape(NY, NX) * 7.9 - t * 1.35 + grain2 * 2.2
        streak = (0.5 + 0.5 * np.sin(ph)) ** 1.5 * 0.65 + (0.5 + 0.5 * np.sin(ph2)) * 0.35
        streak = (streak - 0.45) * np.clip(d * 2.6, 0, 1)
        r = r + 34 * streak - 7 * grain
        g = g + 28 * streak - 6 * grain
        b = b + 20 * streak - 5 * grain

        # ---- 前沿白浪：到达后 0~20 s 最亮，随后并入主体 ----
        age = t - T_field.reshape(NY, NX)
        surge = np.exp(-np.square((age - 7.0) / 8.5)) * on.reshape(NY, NX)
        surge = surge * (0.50 + 0.50 * grain2)
        r = r * (1 - 0.85 * surge) + 236 * 0.85 * surge
        g = g * (1 - 0.85 * surge) + 232 * 0.85 * surge
        b = b * (1 - 0.85 * surge) + 224 * 0.85 * surge

        # ---- 边缘浪花线：断续、细窄（不要变成描边）----
        edge = np.clip((0.030 - d) / 0.030, 0, 1) ** 1.6
        edge = edge * (grain2 > 0.38) * (0.30 + 0.55 * grain) * (d > 0.002)
        r = r * (1 - 0.55 * edge) + 232 * 0.55 * edge
        g = g * (1 - 0.55 * edge) + 229 * 0.55 * edge
        b = b * (1 - 0.55 * edge) + 220 * 0.55 * edge

        # ---- 漂浮碎屑 ----
        r = r + deb * deb_v * 46 - deb * (1 - deb_v) * 26
        g = g + deb * deb_v * 40 - deb * (1 - deb_v) * 24
        b = b + deb * deb_v * 30 - deb * (1 - deb_v) * 20

        # ---- 透明度：中心厚实、边缘羽化 ----
        alpha = np.clip(np.power(d, 0.34) * 1.02, 0, 0.95)
        alpha = np.maximum(alpha, edge * 0.42)

        rgba = np.zeros((NY, NX, 4), np.uint8)
        rgba[:, :, 0] = np.clip(r, 0, 255).astype(np.uint8)
        rgba[:, :, 1] = np.clip(g, 0, 255).astype(np.uint8)
        rgba[:, :, 2] = np.clip(b, 0, 255).astype(np.uint8)
        rgba[:, :, 3] = (alpha * 255).astype(np.uint8)
        Image.fromarray(rgba, "RGBA").save(os.path.join(OUT, "frame_%03d.png" % k), "PNG")

    meta = {
        "bbox": bb, "nx": NX, "ny": NY, "frames": n_frame, "frameDt": FRAME_DT,
        "tTotal": T_TOTAL, "arriveSec": T_TOTAL,
        "sections": {"kunjian": {"s": 0, "h": 68.0, "v": 42.68},
                     "seqiong": {"s": 12000, "h": 61.7, "v": 34.39},
                     "port": {"s": 22000, "h": 47.5, "v": 25.13}},
        "method": "一维沿程水动力（论文三断面标定）+ 沟道距离二维展布",
    }
    io.open(os.path.join(OUT, "sim_meta.json"), "w", encoding="utf-8").write(
        json.dumps(meta, ensure_ascii=False, indent=2))
    print("frames", n_frame)


if __name__ == "__main__":
    main()
