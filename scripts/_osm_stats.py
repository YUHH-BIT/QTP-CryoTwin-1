# -*- coding: utf-8 -*-
"""分析 OSM 建筑相对口岸的分布与体量，判断能否替换"随机布设"。"""
import io, os, json, math

GY = os.path.join(os.getcwd(), "webgis_frontend", "terrain3d", "gyirong")
PORT = (85.3777, 28.27954)
KX = 111320 * math.cos(math.radians(28.28))
KY = 110574


def centroid(ring):
    xs = [p[0] for p in ring[:-1]]
    ys = [p[1] for p in ring[:-1]]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def area_m2(ring):
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0] * KX, ring[i][1] * KY
        x2, y2 = ring[i + 1][0] * KX, ring[i + 1][1] * KY
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


gj = json.load(io.open(os.path.join(GY, "osm_buildings.geojson"), encoding="utf-8"))
rows = []
for f in gj["features"]:
    ring = f["geometry"]["coordinates"][0]
    c = centroid(ring)
    d = math.hypot((c[0] - PORT[0]) * KX, (c[1] - PORT[1]) * KY)
    rows.append((d, area_m2(ring), f["properties"]["osm_id"], f["properties"]["building"],
                 c[0], c[1]))

lines = []
bands = [(0, 200), (200, 400), (400, 700), (700, 1200), (1200, 2500), (2500, 99999)]
for lo, hi in bands:
    sel = [r for r in rows if lo <= r[0] < hi]
    if sel:
        ar = sorted(x[1] for x in sel)
        lines.append("%4d–%-5d m : %3d 栋  面积 min=%.0f med=%.0f max=%.0f m2" % (
            lo, hi, len(sel), ar[0], ar[len(ar) // 2], ar[-1]))
    else:
        lines.append("%4d–%-5d m : 0 栋" % (lo, hi))

lines.append("总计 %d 栋；口岸 700 m 内 %d 栋" % (
    len(rows), len([r for r in rows if r[0] < 700])))

# 输出 700 m 内的清单（按面积排序）
near = sorted([r for r in rows if r[0] < 700], key=lambda x: -x[1])
lines.append("--- 口岸 700 m 内，按面积排序（前 40）")
for r in near[:40]:
    lines.append("   d=%4.0fm  %.0fm2  id=%s  %s  (%.5f,%.5f)" % (
        r[0], r[1], r[2], r[3], r[4], r[5]))

io.open(os.path.join(os.getcwd(), ".workbuddy", "tmp", "osm3.txt"), "w",
        encoding="utf-8").write("\n".join(lines) + "\n")
print("ok")
