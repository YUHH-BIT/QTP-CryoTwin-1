# -*- coding: utf-8 -*-
"""探测 OSM 在吉隆口岸一带是否有建筑轮廓 / 道路。

如果有，就能用真实位置（而不是随机布设）拉出体块。
"""
import io, os, json
import requests

OUT = os.path.join(os.getcwd(), ".workbuddy", "tmp", "osm_probe.txt")
BBOX = (28.250, 85.350, 28.305, 85.410)   # south, west, north, east
lines = []


def run(name, q):
    try:
        r = requests.post("https://overpass-api.de/api/interpreter",
                          data={"data": q}, timeout=120,
                          headers={"User-Agent": "QTP-CryoTwin/1.0"})
        r.raise_for_status()
        js = r.json()
        elems = js.get("elements", [])
        lines.append("%s: %d elements (status %d)" % (name, len(elems), r.status_code))
        tags = {}
        for e in elems:
            t = e.get("tags", {})
            for k in ("building", "highway", "landuse", "natural", "amenity"):
                if k in t:
                    tags.setdefault(k + "=" + str(t[k]), 0)
                    tags[k + "=" + str(t[k])] += 1
        for k, v in sorted(tags.items(), key=lambda x: -x[1])[:12]:
            lines.append("   %s  x%d" % (k, v))
        return elems
    except Exception as e:
        lines.append("%s: ERROR %s" % (name, e))
        return []


s, w, n, e = BBOX
q1 = '[out:json][timeout:90];way["building"](%f,%f,%f,%f);out geom;' % (s, w, n, e)
b = run("building 5.5x6.5km", q1)

q2 = '[out:json][timeout:90];way["highway"](%f,%f,%f,%f);out geom;' % (s, w, n, e)
h = run("highway", q2)

if b:
    lines.append("--- 前 5 个建筑样例：")
    for el in b[:5]:
        g = el.get("geometry", [])
        if len(g) >= 3:
            lons = [p["lon"] for p in g]
            lats = [p["lat"] for p in g]
            lines.append("   id=%s tags=%s pts=%d bbox=[%.5f,%.5f,%.5f,%.5f]" % (
                el["id"], el.get("tags"), len(g), min(lons), min(lats), max(lons), max(lats)))
    # 存下来
    with io.open(os.path.join(os.getcwd(), ".workbuddy", "tmp", "osm_buildings.json"), "w",
                 encoding="utf-8") as f:
        json.dump(b, f, ensure_ascii=False)

io.open(OUT, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("done")
