# -*- coding: utf-8 -*-
"""吉隆 8·26 灾害链：源头→口岸沟道剖面提取。

方法：DEM 上的受限最小代价路径（8 邻域 Dijkstra）
  - 边代价 = 水平距离 + UP_PEN × 上坡高度；单步爬升 > MAX_UP 的边直接禁止。
  - 严格限制爬升，路径只能贴着谷底连续下降走，遇小洼地（冰碛垄）才允许小幅上翻，
    这样既不会绕山走"最省力高原线"，也不会像纯 D8 那样在 33m 网格的深切峡谷里断流。
DEM：AWS Terrarium（全球覆盖，含尼泊尔侧），z12 ≈ 33.7 m。
"""
import os, sys, io, json, math, heapq
import numpy as np

sys.path.insert(0, os.path.join(os.getcwd(), "scripts"))
from build_terrain_page import build_mosaic, log  # noqa: E402

TILE = 256
SRC = (85.5244, 28.2544)      # 蓝塘里壤峰
PORT = (85.3777, 28.27954)    # 吉隆口岸（热索村）
BBOX = (85.350, 28.200, 85.580, 28.340)
Z = 13
OFFICIAL_LEN = 22000.0


def lonlat_to_px(lon, lat, x0, y0, z):
    n = float(2 ** z)
    tx = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    ty = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return (tx - x0) * TILE, (ty - y0) * TILE


def px_to_lonlat(cols, rows, x0, y0, z):
    n = float(2 ** z)
    tx = x0 + np.asarray(cols, dtype=np.float64) / TILE
    ty = y0 + np.asarray(rows, dtype=np.float64) / TILE
    lon = tx / n * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * ty / n))))
    return lon, lat


def dijkstra(flat, H, W, s, t, res_m, up_pen, max_up):
    N = flat.size
    dist = np.full(N, np.inf, dtype=np.float64)
    prev = np.full(N, -1, dtype=np.int64)
    NB = [(-1, -1, 1.4142), (-1, 0, 1.0), (-1, 1, 1.4142),
          (0, -1, 1.0), (0, 1, 1.0),
          (1, -1, 1.4142), (1, 0, 1.0), (1, 1, 1.4142)]
    dist[s] = 0.0
    pq = [(0.0, s)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]:
            continue
        if u == t:
            break
        r, c = divmod(u, W)
        hu = flat[u]
        for dr, dc, st in NB:
            nr, nc = r + dr, c + dc
            if nr < 0 or nr >= H or nc < 0 or nc >= W:
                continue
            v = nr * W + nc
            dh = float(flat[v]) - hu
            if dh > max_up:
                continue
            nd = d + st * res_m + up_pen * max(0.0, dh)
            if nd < dist[v]:
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    if prev[t] < 0:
        return None
    path = []
    cur = t
    while cur != -1:
        path.append(cur)
        if cur == s:
            break
        cur = int(prev[cur])
    path.reverse()
    return path


def main():
    dem, x0, y0 = build_mosaic(BBOX, Z, 'elev', 8, 'elev')
    H, W = dem.shape
    res_m = 156543.03392 * math.cos(math.radians(28.27)) / (2 ** Z)
    flat = dem.ravel()
    log(f'DEM {W}x{H} 分辨率 {res_m:.1f} m')

    # 起点：蓝塘里壤峰附近，海拔最接近 5200 m 的像素（官方冰崩点）
    sc0, sr0 = lonlat_to_px(SRC[0], SRC[1], x0, y0, Z)
    sc0, sr0 = int(round(sc0)), int(round(sr0))
    best, bd = None, 1e18
    for dr in range(-25, 26):
        for dc in range(-25, 26):
            r, c = sr0 + dr, sc0 + dc
            if 0 <= r < H and 0 <= c < W:
                d = abs(float(dem[r, c]) - 5200.0)
                if d < bd:
                    bd, best = d, (c, r)
    sc, sr = best
    s = sr * W + sc
    log(f'起点 ({sc},{sr}) h={dem[sr, sc]:.0f} m（目标 5200，偏差 {bd:.0f}）')

    # 终点：口岸 500 m 邻域内高程最低的像素（口岸点本身常落在坡面上）
    pc, pr = lonlat_to_px(PORT[0], PORT[1], x0, y0, Z)
    pc, pr = int(round(pc)), int(round(pr))
    R = 15
    t, th = None, 1e18
    for dr in range(-R, R + 1):
        for dc in range(-R, R + 1):
            r, c = pr + dr, pc + dc
            if 0 <= r < H and 0 <= c < W and dem[r, c] < th:
                th, t = float(dem[r, c]), r * W + c
    log(f'终点 idx={t} h={th:.0f} m（口岸邻域最低）')

    path = None
    for up_pen, max_up in ((30.0, 40.0), (120.0, 20.0), (600.0, 12.0)):
        log(f'尝试 up_pen={up_pen} max_up={max_up}')
        path = dijkstra(flat, H, W, s, t, res_m, up_pen, max_up)
        if path:
            log(f'  成功，{len(path)} 节点')
            break
    if not path:
        log('未找到路径，退出'); return

    rows = np.array([p // W for p in path])
    cols = np.array([p % W for p in path])
    lons, lats = px_to_lonlat(cols, rows, x0, y0, Z)
    hs = flat[path].astype(float)

    # 官方冰崩点在海拔约 5200 m；DEM 最高段（5578~5822 m）属冰川积累区，裁掉。
    i0 = int(np.argmax(hs <= 5200.0))
    if i0 > 0:
        log(f'裁掉 5200 m 以上冰川段 {i0} 节点（{hs[0]:.0f} -> {hs[i0]:.0f} m）')
        lons, lats, hs = lons[i0:], lats[i0:], hs[i0:]

    KX = 111.32 * math.cos(math.radians(float(lats.mean())))
    KY = 110.574
    dd = np.hypot(np.diff(lons) * KX, np.diff(lats) * KY) * 1000.0
    cum = np.concatenate([[0.0], np.cumsum(dd)])
    scale = OFFICIAL_LEN / max(float(cum[-1]), 1.0)
    dist_off = cum * scale
    log(f'实测谷底线 {cum[-1] / 1000:.2f} km -> 官方 22 km，拉伸系数 {scale:.3f}')

    keep = [0]
    for i in range(1, len(dist_off)):
        if dist_off[i] - dist_off[keep[-1]] >= 50 or i == len(dist_off) - 1:
            keep.append(i)
    keep = np.array(keep)
    pts = [[round(float(lons[k]), 6), round(float(lats[k]), 6),
            round(float(hs[k]), 1), round(float(dist_off[k]), 1)] for k in keep]

    drop = float(hs[0] - hs[-1])
    slope = np.degrees(np.arctan2(-np.diff(hs[keep]), np.maximum(np.diff(cum[keep]), 1e-6)))
    out = {
        "source": [SRC[0], SRC[1]], "port": [PORT[0], PORT[1]],
        "demZoom": Z, "resM": round(res_m, 2),
        "method": "DEM 受限最小代价路径（严格限制爬升，沿谷底单调下降）",
        "lengthM": round(OFFICIAL_LEN, 1),
        "rawLengthM": round(float(cum[-1]), 1),
        "lengthNote": "DEM 33m 谷底线实测 %.1f km，按官方通报 22 km 拉伸校准" % (cum[-1] / 1000.0),
        "dropM": round(drop, 1),
        "startH": round(float(hs[0]), 1), "endH": round(float(hs[-1]), 1),
        "meanSlopeDeg": round(math.degrees(math.atan2(drop, float(cum[-1]))), 2),
        "maxSlopeDeg": round(float(np.percentile(slope, 95)), 2),
        "points": pts,
    }
    dst = os.path.join(os.getcwd(), "webgis_frontend", "terrain3d", "gyirong")
    os.makedirs(dst, exist_ok=True)
    with io.open(os.path.join(dst, "channel.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    lines = ['总长 %.2f km（实测 %.2f km）落差 %.0f m 平均坡 %.2f° 95%%坡 %.2f°' % (
                 out["lengthM"] / 1000, out["rawLengthM"] / 1000, drop,
                 out["meanSlopeDeg"], out["maxSlopeDeg"]),
             '起 %.0f m -> 终 %.0f m  %d 点' % (out["startH"], out["endH"], len(pts))]
    for i in range(0, len(pts), max(1, len(pts) // 22)):
        q = pts[i]
        lines.append('  %6.2f km  h=%7.1f m  (%.4f,%.4f)' % (q[3] / 1000, q[2], q[0], q[1]))
    io.open(os.path.join(os.getcwd(), ".workbuddy", "tmp", "gy_chan.txt"), "w",
            encoding="utf-8").write("\n".join(lines))
    log('channel.json 写出')


if __name__ == '__main__':
    main()
