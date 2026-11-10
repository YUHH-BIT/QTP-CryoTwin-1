# -*- coding: utf-8 -*-
"""把走廊单张卫星影切成 Web Mercator XYZ 瓦片金字塔（离线，供 Cesium 用）。

输入：webgis_frontend/terrain3d/gyirong_corridor/texture.jpg + meta.json bbox
输出：webgis_frontend/tiles/imagery/{z}/{x}/{y}.jpg
"""
import os, io, json, math
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = os.getcwd()
CORR = os.path.join(ROOT, "webgis_frontend", "terrain3d", "gyirong_corridor")
OUT = os.path.join(ROOT, "webgis_frontend", "tiles", "imagery")
ZMIN, ZMAX = 11, 16
TILE = 256


def lonlat_to_tile(lon, lat, z):
    n = float(2 ** z)
    x = (lon + 180.0) / 360.0 * n
    r = math.radians(lat)
    y = (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n
    return x, y


def tile_to_lonlat(tx, ty, z):
    n = float(2 ** z)
    lon = tx / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * ty / n))))
    return lon, lat


def main():
    meta = json.load(io.open(os.path.join(CORR, "meta.json"), encoding="utf-8"))
    b = meta["bbox"]
    src = Image.open(os.path.join(CORR, "texture.jpg")).convert("RGB")
    W, H = src.size
    log = ["src %dx%d bbox=%s" % (W, H, b)]
    total = 0

    for z in range(ZMIN, ZMAX + 1):
        x0, y0 = lonlat_to_tile(b[0], b[3], z)
        x1, y1 = lonlat_to_tile(b[2], b[1], z)
        tx0, tx1 = int(math.floor(x0)), int(math.floor(x1))
        ty0, ty1 = int(math.floor(y0)), int(math.floor(y1))
        n = 0
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                lon_l, lat_t = tile_to_lonlat(tx, ty, z)
                lon_r, lat_b = tile_to_lonlat(tx + 1, ty + 1, z)
                # 该瓦片在原图（线性经纬度）中的像素范围
                px0 = (lon_l - b[0]) / (b[2] - b[0]) * W
                px1 = (lon_r - b[0]) / (b[2] - b[0]) * W
                py0 = (b[3] - lat_t) / (b[3] - b[1]) * H
                py1 = (b[3] - lat_b) / (b[3] - b[1]) * H
                cx0, cx1 = max(0, int(px0)), min(W, int(px1))
                cy0, cy1 = max(0, int(py0)), min(H, int(py1))
                d = os.path.join(OUT, str(z), str(tx))
                os.makedirs(d, exist_ok=True)
                dst = os.path.join(d, "%d.jpg" % ty)
                if cx1 - cx0 < 4 or cy1 - cy0 < 4:
                    continue
                crop = src.crop((cx0, cy0, cx1, cy1)).resize((TILE, TILE), Image.LANCZOS)
                crop.save(dst, "JPEG", quality=88)
                n += 1
        total += n
        log.append("z%d: %d tiles" % (z, n))

    log.append("total %d tiles" % total)
    io.open(os.path.join(ROOT, ".workbuddy", "tmp", "tiles.txt"), "w",
            encoding="utf-8").write("\n".join(log))
    print("ok")


if __name__ == "__main__":
    main()
