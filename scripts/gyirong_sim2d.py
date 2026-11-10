# -*- coding: utf-8 -*-
"""吉隆“8·26”冰岩崩泥石流 —— 二维扩散波+Voellmy 摩擦运动学模拟（自研，可复现）。

控制方程（二维，有限体积，donor-cell 守恒格式）：
    ∂h/∂t + ∂q_x/∂x + ∂q_y/∂y = 0
    q = −h·v·sign(∇η) ,  η = z_fill + h          ← 用**自由水面**梯度驱动
    v = min( sqrt( ξ·h·(|∇η| − μ) ), Vmax )
关键点：驱动量必须用自由水面 η 而不是地形坡度——否则深水柱不会向四周摊开，
会永远堆在源区（本项目实测：一度堆到 3.3 万米深）。
η 的负反馈天然实现"深水向低处铺开、薄层遇缓坡停积"。

参数标定目标（刘昌军等，水利学报 2026）：
  源区 5150 m → 口岸 1800 m、22 km、8 min 20 s；口岸洪峰 18.83 万 m³/s、
  平均流深 47.5 m、平均流速 25.13 m/s；物源 1.8×10⁸ m³。
"""
import os, io, json, math
import numpy as np
from PIL import Image

ROOT = os.getcwd()
CORR = os.path.join(ROOT, "webgis_frontend", "terrain3d", "gyirong_corridor")
GY = os.path.join(ROOT, "webgis_frontend", "terrain3d", "gyirong")
OUT_DIR = os.path.join(ROOT, "webgis_frontend", "tiles", "flow")

DX = 40.0
MU = 0.045         # 基底摩擦（等效摩擦角 ~2.6°）
XI = 520.0         # Voellmy 湍流系数
VMAX = 42.0
VOLUME = 1.8e8
T_END = 540.0
DT_OUT = 9.0


def fill_sinks(z, eps=0.05, iters=900):
    f = z.copy()
    for _ in range(iters):
        nb = np.full(f.shape, np.inf)
        nb[1:, :] = np.minimum(nb[1:, :], f[:-1, :])
        nb[:-1, :] = np.minimum(nb[:-1, :], f[1:, :])
        nb[:, 1:] = np.minimum(nb[:, 1:], f[:, :-1])
        nb[:, :-1] = np.minimum(nb[:, :-1], f[:, 1:])
        new = np.maximum(f, nb + eps)
        done = np.allclose(new, f, atol=1e-4)
        f = new
        if done:
            break
    return f


def main():
    meta = json.load(io.open(os.path.join(CORR, "meta.json"), encoding="utf-8"))
    b = meta["bbox"]
    n = meta["meshSize"]
    H = np.frombuffer(io.open(os.path.join(CORR, "height.bin"), "rb").read(),
                      dtype=np.int16).reshape(n + 1, n + 1).astype(np.float32) + meta["minHeight"]

    nx = max(16, int(round((b[2] - b[0]) * 111320.0 * math.cos(math.radians((b[1] + b[3]) / 2)) / DX)))
    ny = max(16, int(round((b[3] - b[1]) * 110574.0 / DX)))
    ri = np.linspace(0, n, ny).astype(np.int32)
    ci = np.linspace(0, n, nx).astype(np.int32)
    z = H[np.ix_(ri, ci)].astype(np.float64)
    print(f"grid {nx}x{ny}  z {z.min():.0f}~{z.max():.0f}")
    zf = fill_sinks(z)
    print(f"填洼：抬高 {int((zf > z + 1e-3).sum())} 格点，最大 {float((zf - z).max()):.1f} m")

    ch = json.load(io.open(os.path.join(GY, "channel.json"), encoding="utf-8"))
    yy, xx = np.mgrid[0:ny, 0:nx]
    dmin = np.full((ny, nx), 1e18)
    for p in [q for q in ch["points"] if q[3] <= 1600.0]:
        py = (b[3] - p[1]) / (b[3] - b[1]) * (ny - 1)
        px = (p[0] - b[0]) / (b[2] - b[0]) * (nx - 1)
        dmin = np.minimum(dmin, np.hypot((yy - py) * DX, (xx - px) * DX))
    src = dmin <= 380.0
    h = np.zeros((ny, nx))
    h[src] = VOLUME / max(src.sum() * DX * DX, 1.0)
    print(f"源区 {int(src.sum())} 格点，初始深 {float(h[src][0]):.1f} m，体积 {float(h.sum()*DX*DX):.3e}")

    port_r = int((b[3] - ch["port"][1]) / (b[3] - b[1]) * (ny - 1))
    port_c = int((ch["port"][0] - b[0]) / (b[2] - b[0]) * (nx - 1))

    frames, t, step, next_out = [], 0.0, 0, 0.0
    arrive_t, peak_q, hmax_log = None, 0.0, []
    # 界面速度记忆：泥石流靠惯性冲过局部缓段，否则一到缓坡就停（纯扩散波的通病）
    TAU = 55.0
    veMem = np.zeros((ny, nx - 1))
    vnMem = np.zeros((ny - 1, nx))

    while t < T_END:
        eta = zf + h
        # ---- 东界面（严格 donor-cell：通量只取上游格点水深，保证守恒）----
        de = (eta[:, 1:] - eta[:, :-1]) / DX          # >0 → 东侧高 → 向西流
        hL = h[:, :-1]
        hR = h[:, 1:]
        s_e = np.maximum(np.abs(de) - MU, 0.0)
        vL = np.minimum(np.sqrt(XI * hL * s_e), VMAX)
        vR = np.minimum(np.sqrt(XI * hR * s_e), VMAX)
        decay = math.exp(-0.12 / TAU)
        veMem = np.maximum(np.maximum(vL, vR), veMem * decay)
        qe = np.where(de > 0, -hR * veMem, hL * veMem)

        # ---- 北界面（行号增大 = 向南）----
        dn = (eta[1:, :] - eta[:-1, :]) / DX
        hN = h[:-1, :]
        hS = h[1:, :]
        s_n = np.maximum(np.abs(dn) - MU, 0.0)
        vN = np.minimum(np.sqrt(XI * hN * s_n), VMAX)
        vS = np.minimum(np.sqrt(XI * hS * s_n), VMAX)
        vnMem = np.maximum(np.maximum(vN, vS), vnMem * decay)
        qn = np.where(dn > 0, -hS * vnMem, hN * vnMem)

        vmax = float(max(veMem.max() if veMem.size else 0.0, vnMem.max() if vnMem.size else 0.0, 1e-6))
        dt = min(0.5, 0.12 * DX / vmax)
        if t + dt > T_END:
            dt = T_END - t

        div = np.zeros_like(h)
        div[:, 1:-1] = (qe[:, 1:] - qe[:, :-1]) / DX
        div[1:-1, :] += (qn[1:, :] - qn[:-1, :]) / DX
        h_new = h - dt * div
        # 数值保护：负深裁零；异常峰值限幅后按质量回补，保证严格守恒
        neg = h_new < 0
        lost = float(-h_new[neg].sum()) if neg.any() else 0.0
        h_new[neg] = 0.0
        over = h_new > 400.0
        if over.any():
            lost += float((h_new[over] - 400.0).sum())
            h_new[over] = 400.0
        if lost > 0:
            tot = float(h_new.sum())
            if tot > 0:
                h_new *= (tot + lost) / tot
        h = h_new
        t += dt
        step += 1

        if arrive_t is None and h[port_r, port_c] > 2.0:
            arrive_t = t
        peak_q = max(peak_q, float(np.sqrt(max(XI * h[port_r, port_c] * 0.04, 0.0))
                                   * h[port_r, port_c] * DX))

        if t >= next_out:
            frames.append(np.minimum(h, 90.0).astype(np.float32))
            next_out += DT_OUT
            if step % 400 < 40:
                hmax_log.append((round(t, 1), round(float(h.max()), 2), int((h > 0.3).sum())))
        if step % 400 == 0:
            print(f"  t={t:6.1f}s mass={float(h.sum()*DX*DX):.3e} hmax={float(h.max()):7.2f} "
                  f"cells={int((h>0.3).sum())} dt={dt:.3f}")

    print(f"步数 {step}  到达口岸 {arrive_t} s  口岸流深 {float(h[port_r, port_c]):.1f} m")
    print("抽查(t,hmax,cells):", hmax_log[:8])

    if os.path.isdir(OUT_DIR):
        for f in os.listdir(OUT_DIR):
            if f.endswith(".png"):
                os.remove(os.path.join(OUT_DIR, f))
    os.makedirs(OUT_DIR, exist_ok=True)
    PW, PH = 1080, int(round(1080 * ny / nx))
    for i, fr in enumerate(frames):
        d = np.clip(fr / 55.0, 0, 1)
        alpha = np.clip(np.power(d, 0.55) * 1.15, 0, 1)
        rgba = np.zeros((ny, nx, 4), np.uint8)
        rgba[:, :, 0] = (104 + 122 * d).astype(np.uint8)
        rgba[:, :, 1] = (62 + 86 * d).astype(np.uint8)
        rgba[:, :, 2] = (28 + 48 * d).astype(np.uint8)
        rgba[:, :, 3] = (alpha * 255).astype(np.uint8)
        Image.fromarray(rgba, "RGBA").resize((PW, PH), Image.BILINEAR).save(
            os.path.join(OUT_DIR, "frame_%04d.png" % i), "PNG")

    io.open(os.path.join(OUT_DIR, "sim_meta.json"), "w", encoding="utf-8").write(json.dumps({
        "bbox": b, "nx": nx, "ny": ny, "dx": DX, "frames": len(frames),
        "dtOut": DT_OUT, "tEnd": T_END, "arriveSec": None if arrive_t is None else round(arrive_t, 1),
        "volumeM3": VOLUME, "mu": MU, "xi": XI, "pngWidth": PW, "pngHeight": PH,
        "method": "二维扩散波 + Voellmy 摩擦（自由水面梯度驱动，donor-cell 守恒）",
        "note": "自研求解器；参数按论文口岸断面值标定，非 SKY-SWES 两相流",
    }, ensure_ascii=False, indent=2))
    print("frames:", len(frames))


if __name__ == "__main__":
    main()
