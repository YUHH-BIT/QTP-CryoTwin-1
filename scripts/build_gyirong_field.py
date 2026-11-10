# -*- coding: utf-8 -*-
"""吉隆走廊：把一维模型铺成二维"到达时间 + 最大流深"场。

思路借用 Don Watch（唐河洪水数字孪生）的做法：
  - 不画"一条带子"，而是给每个格点算"泥流什么时候到、最深多深"，
    运行时按 t 与到达时间比较，决定该格点的流深（着色器里做位移）；
  - 横向从沟道向外衰减，远离沟道的高地永远不出现水体。
PyDebFlow（开源两相流）给出的断面关系用于估深度：Q = A·v，A = 宽 × 深。

输出（与走廊地形同 bbox，nx × ny）：
  arrival.bin  uint8  t/6s 映射 0~255（>255 视为不到达）
  depth.bin    uint8  深度/0.25m 映射 0~255
  field.json   元数据（bbox、尺寸、缩放、源点）
"""
import os, io, json, math
import numpy as np

ROOT = os.getcwd()
CORR = os.path.join(ROOT, "webgis_frontend", "terrain3d", "gyirong_corridor")
GY = os.path.join(ROOT, "webgis_frontend", "terrain3d", "gyirong")
NX = 512
LAT_K = 110574.0
V_LATERAL = 6.0        # 横向漫流速度 m/s（泥流比纵向慢得多）
HALF_W = 55.0          # 沟道半宽 m
MAX_REACH = 340.0      # 离沟道超过这个距离就不给流深


def main():
    meta = json.load(io.open(os.path.join(CORR, "meta.json"), encoding="utf-8"))
    bbox = meta["bbox"]
    ch = json.load(io.open(os.path.join(GY, "channel.json"), encoding="utf-8"))
    md = json.load(io.open(os.path.join(GY, "model.json"), encoding="utf-8"))
    prof = md["profile"]                     # [s, h, slope, v, t, Q]

    pts = ch["points"]                       # [lon, lat, h, s]
    clon = np.array([p[0] for p in pts])
    clat = np.array([p[1] for p in pts])
    cs = np.array([p[3] for p in pts])

    ps = np.array([p[0] for p in prof])
    pt = np.array([p[4] for p in prof])
    pv = np.array([p[3] for p in prof])
    pq = np.array([p[5] for p in prof])

    # 沟道点 -> 到达时刻 / 断面深度
    t_arr = np.interp(cs, ps, pt)
    v_at = np.interp(cs, ps, pv)
    q_at = np.interp(cs, ps, pq)
    dmax = np.clip(q_at / np.maximum(v_at, 1.0) / (HALF_W * 2.0), 2.0, 48.0)

    lon0, lat0, lon1, lat1 = bbox
    kx = 111320.0 * math.cos((lat0 + lat1) / 2 * math.pi / 180)
    ny = int(round(NX * (lat1 - lat0) * LAT_K / ((lon1 - lon0) * kx)))
    ny = max(64, ny)
    print(f'grid {NX} x {ny}')

    lonv = np.linspace(lon0, lon1, NX)
    latv = np.linspace(lat1, lat0, ny)
    LON, LAT = np.meshgrid(lonv, latv)
    gx = ((LON - lon0) * kx).ravel()
    gy = ((lat1 - LAT) * LAT_K).ravel()
    cx = (clon - lon0) * kx
    cy = (lat1 - clat) * LAT_K
    print(f'格点 {gx.size}  沟道点 {cx.size}')

    best_d = np.full(gx.size, 1e18)
    best_i = np.zeros(gx.size, dtype=np.int32)
    for i in range(cx.size):
        d = np.hypot(gx - cx[i], gy - cy[i])
        m = d < best_d
        best_d[m] = d[m]
        best_i[m] = i

    T = t_arr[best_i] + best_d / V_LATERAL
    D = dmax[best_i] * np.exp(-np.square(best_d / HALF_W))
    D[best_d > MAX_REACH] = 0.0

    # 口岸核心区至少保留一定积水（拥堵回水，官方明确提到）
    port = ch["port"]
    px = (port[0] - lon0) * kx
    py = (lat1 - port[1]) * LAT_K
    dport = np.hypot(gx - px, gy - py)
    nearp = dport < 420
    T[nearp] = np.minimum(T[nearp], 390 + dport[nearp] / 12.0)
    D[nearp] = np.maximum(D[nearp], np.clip(8.0 * (1 - dport[nearp] / 420), 1.0, 8.0))

    arr = np.clip(T / 6.0, 0, 255).astype(np.uint8).reshape(ny, NX)
    dep = np.clip(D / 0.25, 0, 255).astype(np.uint8).reshape(ny, NX)

    io.open(os.path.join(CORR, "arrival.bin"), "wb").write(arr.tobytes())
    io.open(os.path.join(CORR, "depth.bin"), "wb").write(dep.tobytes())

    out = {
        "nx": NX, "ny": ny, "bbox": bbox,
        "arrivalScale": 6.0, "depthScale": 0.25,
        "tMax": float(arr.max()) * 6.0,
        "depthMax": float(dep.max()) * 0.25,
        "source": [float(pts[0][0]), float(pts[0][1]), float(pts[0][2])],
        "port": port,
        "note": "到达时间/流深由一维沿程模型按横向衰减铺成，非二维数值解",
    }
    with io.open(os.path.join(CORR, "field.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    lines = [f'到达时间 max {out["tMax"]:.0f}s  流深 max {out["depthMax"]:.1f}m',
             f'源点 {out["source"]}', f'口径 {NX}x{ny}']
    io.open(os.path.join(ROOT, ".workbuddy", "tmp", "gy_field.txt"), "w",
            encoding="utf-8").write("\n".join(lines))
    print("ok")


if __name__ == "__main__":
    main()
