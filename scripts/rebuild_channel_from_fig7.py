# -*- coding: utf-8 -*-
"""用图 7 勾出的演进路线重写 channel.json（跟拍镜头、节点、前锋提示共用这份数据）。

原 channel.json 是「DEM 最小代价路径」：全长累计爬升 267 m、中位高出周边谷底 458 m，
不是河道（见 .workbuddy/memory 2026-11-12）。这里换成图 7 淹没区的测地中轴，
高程从新 DEM 采样，里程 s 沿用 0~22 km（与论文一致）。
"""
import io, json, math, os
import numpy as np
from scipy import ndimage

ROOT = r"F:\QTP‑CryoTwin"
DATA = os.path.join(ROOT, "gyirong_twin_demo", "data")
TMP = os.path.join(ROOT, ".workbuddy", "tmp")

meta = json.load(io.open(os.path.join(DATA, "meta.json"), encoding="utf-8"))
fld = json.load(io.open(os.path.join(DATA, "field.json"), encoding="utf-8"))
MINLON, MINLAT, MAXLON, MAXLAT = meta["bbox"]
N = 1001
z = (np.fromfile(os.path.join(DATA, "height.bin"), "<i2").reshape(N, N).astype(np.float32)
     + meta["minHeight"])

route = json.load(io.open(os.path.join(DATA, "figure7_route.json"), encoding="utf-8"))["route"]
pts = []
for lon, lat, km, t in route:
    c = (lon - MINLON) / (MAXLON - MINLON) * (N - 1)
    r = (MAXLAT - lat) / (MAXLAT - MINLAT) * (N - 1)
    i0, j0 = int(min(N - 6, max(2, r))), int(min(N - 6, max(2, c)))
    # 取 5×5 窗口最低值：中轴会在谷内左右摆，单点采样会把台阶/陡壁采进来
    h = float(z[i0 - 2:i0 + 3, j0 - 2:j0 + 3].min())
    pts.append([round(lon, 6), round(lat, 6), round(h, 1), round(km * 1000.0, 1)])

# 中线在扇形区左右摆，先平滑经纬度再算长度，否则折线长度虚高 25%
lo = ndimage.uniform_filter1d(np.array([p[0] for p in pts], np.float64), 7)
la = ndimage.uniform_filter1d(np.array([p[1] for p in pts], np.float64), 7)
for i, p in enumerate(pts):
    p[0] = round(float(lo[i]), 6)
    p[1] = round(float(la[i]), 6)

# 纵剖面：平滑 → 强制单调下降（泥石流不会往上爬）
hh = np.array([p[2] for p in pts], np.float32)
hh = ndimage.median_filter(hh, 15)
hh = ndimage.uniform_filter1d(hh, 9)
hh = np.minimum.accumulate(hh)
hh = ndimage.uniform_filter1d(hh, 5)
hh = np.minimum.accumulate(hh)
for i, p in enumerate(pts):
    p[2] = round(float(hh[i]), 1)


def dseg(a, b):
    return math.hypot((b[0] - a[0]) * 111320 * math.cos(math.radians((b[1] + a[1]) / 2)),
                      (b[1] - a[1]) * 110574)


raw = sum(dseg(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
rise = sum(max(0.0, pts[i + 1][2] - pts[i][2]) for i in range(len(pts) - 1))
slopes = []
for i in range(len(pts) - 1):
    d = max(dseg(pts[i], pts[i + 1]), 1e-6)
    slopes.append(math.degrees(math.atan2(pts[i][2] - pts[i + 1][2], d)))

out = {
    "source": [pts[0][0], pts[0][1]],
    "port": [pts[-1][0], pts[-1][1]],
    "demZoom": 14,
    "resM": 21.6,
    "method": "论文图 7 淹没区测地中轴（scripts/build_gyirong_flood_shape_fig7.py）",
    "lengthM": pts[-1][3],
    "rawLengthM": round(raw, 1),
    "lengthNote": "图 7 勾取的实测沿线弧长 %.2f km；里程按论文 22 km 口径归一" % (raw / 1000.0),
    "dropM": round(pts[0][2] - pts[-1][2], 1),
    "startH": pts[0][2], "endH": pts[-1][2],
    "meanSlopeDeg": round(math.degrees(math.atan2(pts[0][2] - pts[-1][2], raw)), 2),
    "maxSlopeDeg": round(max(slopes), 2),
    "cumRiseM": round(rise, 1),
    "note": "原 DEM 最小代价路径累计爬升 267 m、不贴合河道，已废弃；本线取自论文图 7",
    "points": pts,
}
io.open(os.path.join(DATA, "channel.json"), "w", encoding="utf-8").write(
    json.dumps(out, ensure_ascii=False, indent=1))
print("points %d  raw %.2f km  里程 %.2f km  起 %.0f m 末 %.0f m  累计爬升 %.0f m  最陡 %.1f°" % (
    len(pts), raw / 1000, out["lengthM"] / 1000, out["startH"], out["endH"], rise, out["maxSlopeDeg"]))
