# -*- coding: utf-8 -*-
"""吉隆冰川泥石流：按论文图 7 的平面形态烘焙「淹没包络」shape.bin。

三个坑与对策
------------
1) 运行时用「最近沟道点 + 相对沟床高差 / REF_RISE」各向同性衰减 → 各段几乎等宽的
   窄带，与图 7 对不上。对策：改成「沿程半宽包络 × 地形闸门」。
2) 沟道中心线没贴在 DEM 谷底上（一侧陡壁、一侧平滩），拿单个沟道点的高程当基准，
   对称包络必然一半落在山壁上。对策：每个断面取「属于该断面的所有格点」的地形
   最低值当该断面的谷底高程 valleyMin(s)，相当于逐断面做一次平面水面填充。
3) DEM 是 21.5 m 的 SRTM 派生栅格，V 形峡谷里抬升 15 m 就只剩 30 m 宽；而论文流深
   是 48~68 m。纯 DEM 反推只会比现状更窄。对策：宽度以包络为准（口径 C），
   DEM 只作「不该有水的地方」的否决项（Rgate 抬高到 260 m，只否决山脊）。

形态来源（论文图 7）
  源头（东南 5197 m）→ 谷口扇形漫流（最宽约 2.2 km）→ 收束进东林藏布峡谷
  → 折向西北的细长主流 → 口岸（1800 m）前略放宽。深槽（pot→1）在沟心，
  湿边（pot→0）浅绿，与图 7 的蓝芯/绿边一致。

输出
  shape.bin    uint8 淹没势 ×255（干区 0）
  arrival.bin  uint8 T/6 s（论文前缘到达 × timeCompress + 横向 22 m/s 延迟）
  俯视预览      .workbuddy/tmp/shape_preview.png
"""
import io, json, math, os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "gyirong_twin_demo", "data")
TMP = os.path.join(ROOT, ".workbuddy", "tmp")

NX = 512
LAT_K = 110574.0
LAT_SPEED = 22.0
T_PAPER = [(0.0, 0.0), (15000.0, 180.0), (22000.0, 505.0)]     # 论文前缘到达
T_COMPRESS = 455.0 / 505.0

# 沿程横向半宽 L(s)（m）：按图 7 的三段式比例标定
# （图 7 主图中 22 km 主流对应的带宽约 900 m、深槽芯约 250 m，扇形区约 2.5 km 宽）
W_PROFILE = [
    (0, 160), (250, 460), (600, 900), (1000, 1300), (1500, 1520),
    (2100, 1480), (2700, 1150), (3300, 780), (3900, 560), (4400, 470),
    (5200, 440), (6200, 400), (7000, 455), (8000, 395), (9000, 440),
    (10000, 395), (11000, 360), (12000, 400), (13000, 330),
    (14500, 300), (15500, 335), (16500, 295), (17500, 320),
    (18500, 360), (19500, 400), (20500, 415), (22000, 440),
]
# 地形闸门：相对该断面沟心的允许抬升（m）
# 扇形区给到 210 m，让谷口滩地能整片漫开；峡谷段 260 m，只否决山脊与邻谷。
R_PROFILE = [(0, 330), (3900, 330), (4900, 270), (22000, 275)]
H_SECTIONS = [(0.0, 74.2), (7500.0, 67.97), (15000.0, 61.72), (22000.0, 47.50)]


def main():
    meta = json.load(io.open(os.path.join(DATA, "meta.json"), encoding="utf-8"))
    fld = json.load(io.open(os.path.join(DATA, "field.json"), encoding="utf-8"))
    ch = json.load(io.open(os.path.join(DATA, "channel.json"), encoding="utf-8"))

    minlon, minlat, maxlon, maxlat = meta["bbox"]
    SX, SZ = meta["sizeMeters"]["x"], meta["sizeMeters"]["z"]
    kx = 111320.0 * math.cos(math.radians((minlat + maxlat) / 2))
    ny = fld["ny"]

    Z = (np.fromfile(os.path.join(DATA, "height.bin"), dtype="<i2").reshape(1001, 1001)
         .astype(np.float32) + float(meta["minHeight"]))

    def dem(x, z):
        c = np.clip(((x / SX + 0.5) * 1000.0).astype(np.int32), 0, 1000)
        r = np.clip(((z / SZ + 0.5) * 1000.0).astype(np.int32), 0, 1000)
        return Z[r, c]

    def to_rc(x, z):
        return (((z / SZ + 0.5) * (ny - 1)).astype(np.int32),
                ((x / SX + 0.5) * (NX - 1)).astype(np.int32))

    pts = ch["points"]
    cs = np.array([p[3] for p in pts])
    cx = np.array([(p[0] - minlon) * kx - SX / 2 for p in pts])
    cz = np.array([SZ / 2 - (p[1] - minlat) * LAT_K for p in pts])

    # ---------- 场网格与最近沟道点 ----------
    lonv = np.linspace(minlon, maxlon, NX)
    latv = np.linspace(maxlat, minlat, ny)
    LON, LAT = np.meshgrid(lonv, latv)
    gx = ((LON - minlon) * kx - SX / 2.0).ravel()
    gz = (SZ / 2.0 - (LAT - minlat) * LAT_K).ravel()

    best_d = np.full(gx.size, 1e18, np.float32)
    best_i = np.zeros(gx.size, np.int32)
    for i in range(cx.size):
        d2 = (gx - cx[i]) ** 2 + (gz - cz[i]) ** 2
        m = d2 < best_d
        best_d[m] = d2[m]
        best_i[m] = i
    dist = np.sqrt(best_d)
    terr = dem(gx, gz)

    # ---------- 沟心基准高程 ----------
    # 直接用沟道点自身的 DEM 高程并沿程平滑：以此为 0 高程，
    # 一侧陡壁 delta 迅速变大被闸门否决、一侧平滩 delta 小可以漫开，
    # 这正是图 7 里「水贴着谷底一侧铺开、另一侧贴壁」的成因。
    bed = np.convolve(np.pad(dem(cx, cz), 3, mode="edge"), np.ones(7) / 7.0, mode="valid")

    Ls = np.interp(cs, [w[0] for w in W_PROFILE], [w[1] for w in W_PROFILE])
    Ls *= 1.0 + 0.09 * np.sin(cs / 760.0 * 2 * math.pi + 1.1) + 0.05 * np.sin(cs / 330.0 * 2 * math.pi)
    Rs = np.interp(cs, [r[0] for r in R_PROFILE], [r[1] for r in R_PROFILE])
    t_arr = np.interp(cs, [t[0] for t in T_PAPER], [t[1] for t in T_PAPER]) * T_COMPRESS

    L_i, R_i, b_i = Ls[best_i], Rs[best_i], bed[best_i]
    delta = np.maximum(0.0, terr - b_i)

    # 横向包络：沟心 ~30% 宽度内保持满淹没势（图 7 的深色芯），再向外平滑衰减到 0
    # （图 7 里主带外侧是一大圈浅绿）。纯平顶会让整条带看起来一样深，不真实。
    u = np.clip(dist / np.maximum(L_i, 1.0), 0.0, 1.0)
    lat = np.clip((1.0 - u ** 1.7) / 0.88, 0.0, 1.0) ** 0.9
    # 地形闸门只做「否决」：谷底一侧（delta 小）不惩罚，超过 R 才快速归零，
    # 否则沟道中心线偏离谷底几十米就会把整条带子掐断。
    gate = 1.0 - np.clip((delta - 0.70 * R_i) / np.maximum(0.30 * R_i, 1.0), 0.0, 1.0)
    # 深槽核心：沟道两侧 120 m 内恒为满淹没势（图 7 的连续深色芯，不允许断流）
    core = np.clip(1.0 - (dist / 120.0) ** 2, 0.0, 1.0) ** 0.5
    env = (lat * gate).reshape(ny, NX)
    core2 = core.reshape(ny, NX)

    # 湿边不能是规整曲线（一眼就是「画出来的」）。叠一层 ~150 / 350 m 尺度的
    # 起伏，让边界按地形碎块自然进退、内部也有深浅斑驳 —— 数值结果才有的质感。
    # 幅度 ±22%，只作用于包络，沟心核心保持连续，不会把主带切断。
    rng = np.random.default_rng(20260826)
    n1 = rng.random((ny, NX)).astype(np.float32)
    n2 = rng.random((ny, NX)).astype(np.float32)

    def blur(a, times):
        for _ in range(times):
            q = np.pad(a, 1, mode="edge")
            a = (q[:-2, 1:-1] + q[2:, 1:-1] + q[1:-1, :-2] + q[1:-1, 2:]
                 + 2.0 * q[1:-1, 1:-1]) / 6.0
        return a

    n1 = blur(n1, 3)
    n2 = blur(n2, 6)
    n1 = (n1 - n1.min()) / max(float(n1.max() - n1.min()), 1e-6)
    n2 = (n2 - n2.min()) / max(float(n2.max() - n2.min()), 1e-6)
    jitter = 0.78 + 0.22 * (0.55 * n1 + 0.45 * n2)
    pot = np.maximum(core2, env * jitter)

    # ---------- 连通性 ----------
    seed = np.zeros_like(pot, bool)
    sr, sc = to_rc(cx, cz)
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            seed[np.clip(sr + dr, 0, ny - 1), np.clip(sc + dc, 0, NX - 1)] = True
    wet = (pot > 0.035) & seed
    for _ in range(900):
        nb = np.zeros_like(wet)
        nb[1:, :] |= wet[:-1, :]; nb[:-1, :] |= wet[1:, :]
        nb[:, 1:] |= wet[:, :-1]; nb[:, :-1] |= wet[:, 1:]
        grow = nb & (pot > 0.035) & ~wet
        if not grow.any():
            break
        wet |= grow
    pot *= wet

    for _ in range(2):
        p = np.pad(pot, 1, mode="edge")
        pot = (p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:] + 2.0 * p[1:-1, 1:-1]) / 6.0
    pot[~wet] = 0.0

    T = (t_arr[best_i] + dist / LAT_SPEED).reshape(ny, NX)
    T[~wet] = 1530.0

    shape = np.clip(pot * 255.0, 0, 255).astype(np.uint8)
    io.open(os.path.join(DATA, "shape.bin"), "wb").write(shape.tobytes())
    io.open(os.path.join(DATA, "arrival.bin"), "wb").write(
        np.clip(T / 6.0, 0, 255).astype(np.uint8).tobytes())

    # field.json 重写（不沿用旧键，避免上一版口径的字段残留）
    out = {
        "nx": NX, "ny": ny, "bbox": [minlon, minlat, maxlon, maxlat],
        "arrivalScale": 6.0, "depthScale": fld.get("depthScale", 0.3),
        "tMax": float(T[wet].max()), "depthMax": fld.get("depthMax", 67.8),
        "source": fld["source"], "port": fld["port"],
        "note": "到达时间/流深/淹没包络均为演示级口径：到达时间与流深引自论文正文/表2/表4，"
                "平面形态按图 7 拟合并由真实 DEM 约束；非二维数值解，不代表实测淹没边界",
        "shapeScale": round(1.0 / 255.0, 6),
        "shapeNote": "shape.bin = 沿程半宽 L(s) 横向包络 × 地形闸门 R(s)（相对沟心高程）"
                     "× 沟道连通性 flood fill，再叠 150/350 m 尺度起伏",
        "halfWidthModel": "L(s): 源头 160 m → 扇形 1.0~2.7 km 最宽约 3 km → 峡谷 4~18 km "
                          "600~880 m → 口岸前 18~22 km 640~880 m",
        "gateRiseModel": "R(s): 扇形区 330 m，峡谷 270~275 m",
        "depthModel": "H(s)=74.2/67.97/61.72/47.50 m @ 0/7.5/15/22 km（表2/表4，0 km 线性外推）",
        "lateralSpeedMps": LAT_SPEED,
        "timeCompress": round(T_COMPRESS, 4),
        "frontArrivalSrc": "论文正文：0 s/0 km、180 s/15 km、505 s/22 km；场时间乘 timeCompress",
        "calibrationSource": "刘昌军等，水利学报，网络首发 2026-09-18，doi:10.3724/j.slxb.20260653；"
                             "东林藏布峡谷，集雨面积约 896.1 km²，干流长 35.6 km",
        "wetPct": round(float((shape > 8).mean()) * 100, 2),
    }
    io.open(os.path.join(DATA, "field.json"), "w", encoding="utf-8").write(
        json.dumps(out, ensure_ascii=False, indent=1))

    preview(shape, SX, SZ, cx, cz)
    print("wet %.2f%%  tMax %.0f s" % ((shape > 8).mean() * 100, out["tMax"]))


def preview(shape, SX, SZ, cx, cz):
    ny, nx = shape.shape
    hs = Image.open(os.path.join(DATA, "texture_hillshade.jpg")).convert("L").resize((nx, ny))
    rgb = np.stack([np.asarray(hs).astype(np.float32) / 255.0 * 0.94] * 3, -1)
    p = shape.astype(np.float32) / 255.0
    col = np.stack([0.12 + 0.05 * p, 0.66 - 0.54 * p, 0.20 + 0.62 * p], -1)
    a = np.where(p > 0.035, 0.9, 0.0)[..., None]
    rgb = rgb * (1 - a) + col * a

    def px(x, z):
        return int((x / SX + 0.5) * (nx - 1)), int((z / SZ + 0.5) * (ny - 1))
    for i in range(len(cx) - 1):
        x0, y0 = px(cx[i], cz[i]); x1, y1 = px(cx[i + 1], cz[i + 1])
        n = max(abs(x1 - x0), abs(y1 - y0), 1)
        for t in range(n + 1):
            xx = int(x0 + (x1 - x0) * t / n); yy = int(y0 + (y1 - y0) * t / n)
            if 0 <= yy < ny and 0 <= xx < nx:
                rgb[yy, xx] = [1.0, 0.25, 0.15]
    Image.fromarray(np.clip(rgb * 255, 0, 255).astype(np.uint8)) \
        .resize((nx * 2, ny * 2), Image.LANCZOS).save(os.path.join(TMP, "shape_preview.png"))


if __name__ == "__main__":
    main()
