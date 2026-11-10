# -*- coding: utf-8 -*-
"""为吉隆 22 km 走廊重新取高分辨率卫星影像（z16 ≈ 2.4 m/px），并重建瓦片金字塔。

背景：原 corridor/texture.jpg 是从 z13 瓦片放大来的（19 m/px 源），
      实际只有 5.4 m/px 的"假清晰度"，Cesium 拉近后成片模糊。
      这里只重取影像，不动 height.bin / channel.json，避免影响沟道与建筑位置。
"""
import os, io, sys, json, math

sys.path.insert(0, os.path.join(os.getcwd(), "scripts"))
import build_terrain_page as B
from PIL import Image
import numpy as np

Image.MAX_IMAGE_PIXELS = None
CORR = os.path.join(os.getcwd(), "webgis_frontend", "terrain3d", "gyirong_corridor")
LOGP = os.path.join(os.getcwd(), ".workbuddy", "tmp", "hires.txt")
ZOOM = 16
TEXW = 8192


def main():
    meta = json.load(io.open(os.path.join(CORR, "meta.json"), encoding="utf-8"))
    b = meta["bbox"]
    lines = ["bbox=%s zoom=%d" % (b, ZOOM)]
    print("downloading z%d tiles ..." % ZOOM)
    sat_m, sx0, sy0 = B.build_mosaic(b, ZOOM, "imagery", 12, "rgb")
    lines.append("mosaic %s start=(%.1f,%.1f)" % (sat_m.shape, sx0, sy0))

    px0, py0 = B.lonlat_to_tile_xy(b[0], b[3], ZOOM)
    px1, py1 = B.lonlat_to_tile_xy(b[2], b[1], ZOOM)
    cx0 = int(round((px0 - sx0) * B.TILE))
    cy0 = int(round((py0 - sy0) * B.TILE))
    cx1 = int(round((px1 - sx0) * B.TILE))
    cy1 = int(round((py1 - sy0) * B.TILE))
    lines.append("crop px=(%d,%d)-(%d,%d)" % (cx0, cy0, cx1, cy1))
    crop = sat_m[max(0, cy0):cy1, max(0, cx0):cx1]

    lat_c = (b[1] + b[3]) / 2.0
    size_x = (b[2] - b[0]) * 111320.0 * math.cos(math.radians(lat_c))
    size_z = (b[3] - b[1]) * 110540.0
    th = max(256, int(round(TEXW * size_z / size_x)))
    img = Image.fromarray(crop.astype(np.uint8), "RGB").resize((TEXW, th), Image.LANCZOS)
    dst = os.path.join(CORR, "texture.jpg")
    img.save(dst, quality=90, optimize=True, progressive=True)
    lines.append("texture %dx%d  %.1f MB  m/px=%.2f" %
                 (TEXW, th, os.path.getsize(dst) / 1e6, size_x / TEXW))
    io.open(LOGP, "w", encoding="utf-8").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
