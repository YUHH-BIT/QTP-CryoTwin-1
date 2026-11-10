# -*- coding: utf-8 -*-
"""拉取吉隆口岸 OSM 建筑（含 damage 标签），导出 GeoJSON + 统计。

用途：把"随机布设 19 栋示意建筑"换成 OSM 实测轮廓/位置。
"""
import io, os, json, math
import requests

TMP = os.path.join(os.getcwd(), ".workbuddy", "tmp")
OUT_GJ = os.path.join(os.getcwd(), "webgis_frontend", "terrain3d", "gyirong", "osm_buildings.geojson")
BBOX = (28.240, 85.340, 28.315, 85.420)   # south, west, north, east
lines = []


def overpass(q):
    r = requests.post("https://overpass-api.de/api/interpreter",
                      data={"data": q}, timeout=180,
                      headers={"User-Agent": "QTP-CryoTwin/1.0"})
    r.raise_for_status()
    return r.json().get("elements", [])


def main():
    s, w, n, e = BBOX
    q = ('[out:json][timeout:150];'
         '(way["building"](%f,%f,%f,%f);'
         'relation["building"](%f,%f,%f,%f););'
         'out geom tags;' % (s, w, n, e, s, w, n, e))
    els = overpass(q)
    lines.append("ways+relations with building: %d" % len(els))

    feats = []
    dmg = 0
    tagstat = {}
    for el in els:
        t = el.get("tags", {})
        geom = el.get("geometry")
        if el["type"] == "relation":
            continue
        if not geom or len(geom) < 4:
            continue
        ring = [[p["lon"], p["lat"]] for p in geom]
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        has_dmg = any(k.startswith("damage") for k in t)
        if has_dmg:
            dmg += 1
        for k in ("building", "building:levels", "height", "damage:event", "amenity", "shop"):
            if k in t:
                tagstat[k + "=" + str(t[k])[:28]] = tagstat.get(k + "=" + str(t[k])[:28], 0) + 1
        feats.append({
            "type": "Feature",
            "properties": {
                "osm_id": el["id"],
                "building": t.get("building"),
                "levels": t.get("building:levels"),
                "height": t.get("height"),
                "damage": t.get("damage:event") or t.get("damage"),
                "name": t.get("name"),
                "amenity": t.get("amenity"),
                "shop": t.get("shop"),
                "all_tags": t if has_dmg else None,
            },
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })

    lines.append("polygons: %d, with damage tag: %d" % (len(feats), dmg))
    lines.append("--- 标签统计")
    for k, v in sorted(tagstat.items(), key=lambda x: -x[1])[:20]:
        lines.append("   %s  x%d" % (k, v))
    lines.append("--- 带 damage 的要素")
    for f in feats:
        if f["properties"]["damage"]:
            c = f["geometry"]["coordinates"][0]
            lines.append("   id=%s dmg=%s tags=%s" % (
                f["properties"]["osm_id"], f["properties"]["damage"],
                json.dumps(f["properties"]["all_tags"], ensure_ascii=False)[:220]))
            lines.append("      ring pts=%d  first=(%.5f,%.5f)" % (len(c), c[0][0], c[0][1]))

    gj = {"type": "FeatureCollection", "features": feats}
    io.open(OUT_GJ, "w", encoding="utf-8").write(json.dumps(gj, ensure_ascii=False))
    lines.append("-> %s  (%.1f KB)" % (OUT_GJ, os.path.getsize(OUT_GJ) / 1024.0))

    # 面积统计（判断是建筑还是轮廓大块）
    def area_m2(ring):
        lat0 = sum(p[1] for p in ring) / len(ring)
        kx = 111320 * math.cos(math.radians(lat0))
        ky = 110574
        a = 0.0
        for i in range(len(ring) - 1):
            x1, y1 = ring[i][0] * kx, ring[i][1] * ky
            x2, y2 = ring[i + 1][0] * kx, ring[i + 1][1] * ky
            a += x1 * y2 - x2 * y1
        return abs(a) / 2.0

    areas = sorted(area_m2(f["geometry"]["coordinates"][0]) for f in feats)
    if areas:
        lines.append("面积 m2: min=%.0f median=%.0f p90=%.0f max=%.0f" % (
            areas[0], areas[len(areas) // 2], areas[int(len(areas) * 0.9)], areas[-1]))

    io.open(os.path.join(TMP, "osm2.txt"), "w", encoding="utf-8").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
