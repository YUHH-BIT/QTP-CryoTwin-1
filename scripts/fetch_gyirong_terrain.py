# -*- coding: utf-8 -*-
"""重取吉隆沟地形与影像（可指定 bbox）。

为什么需要它：论文图 7 的演进路线在 28.33°N 有一条向北的拱起（东林藏布上游），
原 bbox 只到 28.31°N，装不下，导致同一条路线只能斜切、形状必然对不上。

数据源：
  DEM  — AWS Open Data / Terrarium（SRTM 派生，全球已填洞），公开瓦片
  影像 — Esri World Imagery（按其条款署名）

约定（与原数据一致）：
  height.bin  int16 小端，行 0 = 北，值 = 相对 meta.minHeight 的增量
  texture.jpg 行 0 = 北（THREE 默认 flipY 处理）
"""
import io, json, math, os, sys
import urllib.request
import numpy as np
from PIL import Image

ROOT = r"F:\QTP‑CryoTwin"
DATA = os.path.join(ROOT, "gyirong_twin_demo", "data")
TMP = os.path.join(ROOT, ".workbuddy", "tmp")
CACHE = os.path.join(TMP, "tilecache")
os.makedirs(CACHE, exist_ok=True)

UA = {"User-Agent": "QTP-CryoTwin/1.0 (research demo)"}


def fetch(url):
    key = url.replace("https://", "").replace("/", "_").replace(":", "_")
    p = os.path.join(CACHE, key)
    if os.path.exists(p) and os.path.getsize(p) > 100:
        return p
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=45) as r, open(p + ".part", "wb") as f:
        f.write(r.read())
    os.replace(p + ".part", p)
    return p


def fetch_many(urls, workers=16):
    """并发下载（单线程每块约 4 s，800 块会到 50 分钟）。"""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    ok, fail = 0, 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(fetch, u) for u in urls]
        for i, fu in enumerate(as_completed(futs), 1):
            try:
                fu.result()
                ok += 1
            except Exception:
                fail += 1
            if i % 100 == 0:
                print("  下载 %d/%d（失败 %d）" % (i, len(urls), fail), flush=True)
    print("  下载完成 %d 块，失败 %d" % (ok, fail), flush=True)


def deg2num(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    la = math.radians(lat)
    y = (1.0 - math.log(math.tan(la) + 1 / math.cos(la)) / math.pi) / 2.0 * n
    return x, y


def num2deg(x, y, z):
    n = 2 ** z
    lon = x / n * 360.0 - 180.0
    la = math.atan(math.sinh(math.pi * (1 - 2 * y / n)))
    return lon, math.degrees(la)


def mosaic(bbox, z, kind):
    """按 bbox 拼瓦片，返回 (rgb 数组, 该数组覆盖的 bbox)。"""
    minlon, minlat, maxlon, maxlat = bbox
    x0, y1 = deg2num(minlon, minlat, z)
    x1, y0 = deg2num(maxlon, maxlat, z)
    tx0, tx1 = int(math.floor(x0)), int(math.floor(x1))
    ty0, ty1 = int(math.floor(y0)), int(math.floor(y1))
    W = (tx1 - tx0 + 1) * 256
    H = (ty1 - ty0 + 1) * 256
    out = np.zeros((H, W, 3), np.uint8)
    jobs = []
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            if kind == "dem":
                url = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png" % (z, tx, ty)
            else:
                url = ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/"
                       "MapServer/tile/%d/%d/%d" % (z, ty, tx))
            jobs.append((tx, ty, url))
    print("  %s：%d 块，z=%d" % (kind, len(jobs), z), flush=True)
    fetch_many([j[2] for j in jobs])
    for tx, ty, url in jobs:
        try:
            im = Image.open(fetch(url)).convert("RGB")
        except Exception as e:
            print("  瓦片失败 %s %s" % (url, e))
            continue
        out[(ty - ty0) * 256:(ty - ty0) * 256 + 256,
            (tx - tx0) * 256:(tx - tx0) * 256 + 256] = np.asarray(im)[..., :3]
    lon0, lat1 = num2deg(tx0, ty0, z)
    lon1, lat0 = num2deg(tx1 + 1, ty1 + 1, z)
    return out, (lon0, lat0, lon1, lat1)


def sample_grid(img, img_bbox, bbox, nx, ny):
    """把拼接结果重采样到 nx×ny（行 0 = 北）。"""
    minlon, minlat, maxlon, maxlat = bbox
    jj, ii = np.mgrid[0:ny, 0:nx]
    lon = minlon + (ii + 0.5) / nx * (maxlon - minlon)
    lat = maxlat - (jj + 0.5) / ny * (maxlat - minlat)
    g0, g1, g2, g3 = img_bbox
    c = (lon - g0) / (g2 - g0) * (img.shape[1] - 1)
    r = (g3 - lat) / (g3 - g1) * (img.shape[0] - 1)
    c = np.clip(c, 0, img.shape[1] - 1)
    r = np.clip(r, 0, img.shape[0] - 1)
    out = np.zeros((ny, nx, 3), np.float32)
    for k in range(3):
        out[..., k] = img[r.astype(int), c.astype(int), k]
    return out


def main():
    bbox = [float(v) for v in sys.argv[1:5]] if len(sys.argv) >= 5 else [85.34, 28.20, 85.56, 28.335]
    N = int(sys.argv[5]) if len(sys.argv) > 5 else 1001
    TW = int(sys.argv[6]) if len(sys.argv) > 6 else 8192
    print("bbox", bbox, "网格", N, "影像宽", TW)

    # ---- DEM ----
    dem_raw, dem_bb = mosaic(bbox, 14, "dem")
    f = dem_raw.astype(np.float64)
    elev = f[..., 0] * 256.0 + f[..., 1] + f[..., 2] / 256.0 - 32768.0
    elev = np.dstack([elev] * 3)
    dem = sample_grid(elev, dem_bb, bbox, N, N)[..., 0]
    # 填掉异常（海域/缺测编码）
    dem = np.where((dem < -100) | (dem > 9000), np.nan, dem)
    if np.isnan(dem).any():
        from scipy import ndimage
        idx = ndimage.distance_transform_edt(np.isnan(dem), return_distances=False,
                                            return_indices=True)
        dem = dem[tuple(idx)]
    print("DEM %.0f~%.0f m" % (dem.min(), dem.max()))

    # 与原数据核对行序与一致性
    try:
        old = np.fromfile(os.path.join(TMP, "bak_terrain", "height.bin"), "<i2").reshape(1001, 1001)
        meta0 = json.load(io.open(os.path.join(TMP, "bak_terrain", "meta.json"), encoding="utf-8"))
        old = old.astype(np.float32) + meta0["minHeight"]
        ob = meta0["bbox"]
        jj, ii = np.mgrid[0:N, 0:N]
        lon = bbox[0] + (ii + 0.5) / N * (bbox[2] - bbox[0])
        lat = bbox[3] - (jj + 0.5) / N * (bbox[3] - bbox[1])
        c = np.clip((lon - ob[0]) / (ob[2] - ob[0]) * 1000, 0, 999).astype(int)
        r = np.clip((ob[3] - lat) / (ob[3] - ob[1]) * 1000, 0, 999).astype(int)
        ov = (lon > ob[0] + 0.01) & (lon < ob[2] - 0.01) & (lat > ob[1] + 0.01) & (lat < ob[3] - 0.01)
        d = dem - old[r, c]
        print("与原 DEM 重叠区差：mean %+.1f m  p95 |%.1f| m（行序一致则应在几米内）" % (
            np.nanmean(d[ov]), np.nanpercentile(np.abs(d[ov]), 95)))
    except Exception as e:
        print("核对跳过:", e)

    mn = float(dem.min())
    hi = np.clip(np.round(dem - mn), 0, 65535).astype("<i2")
    hi.tofile(os.path.join(DATA, "height.bin"))
    print("height.bin 写出 %d×%d  minHeight %.1f" % (hi.shape[1], hi.shape[0], mn))

    # ---- 影像 ----
    img_raw, img_bb = mosaic(bbox, 16, "img")
    print("影像拼接 %s" % (img_raw.shape,))
    lat0 = (bbox[1] + bbox[3]) / 2
    width_m = (bbox[2] - bbox[0]) * 111320.0 * math.cos(math.radians(lat0))
    height_m = (bbox[3] - bbox[1]) * 110574.0
    TH = int(round(TW * height_m / width_m))
    tex = sample_grid(img_raw, img_bb, bbox, TW, TH).astype(np.uint8)
    Image.fromarray(tex).save(os.path.join(DATA, "texture.jpg"), quality=86)
    print("texture.jpg %d×%d" % (TW, TH))

    # ---- 晕渲 ----
    from scipy import ndimage
    gy, gx = np.gradient(ndimage.gaussian_filter(dem, 1.2), width_m / N)
    az, alt = math.radians(315), math.radians(45)
    sl = np.pi / 2 - np.arctan(np.hypot(gx, gy))
    asp = np.arctan2(-gx, gy)
    hs = np.sin(alt) * np.sin(sl) + np.cos(alt) * np.cos(sl) * np.cos(az - asp)
    hs = (np.clip(hs, 0, 1) ** 0.9 * 235 + 15).astype(np.uint8)
    Image.fromarray(np.dstack([hs] * 3)).resize((TW, TH), Image.LANCZOS).save(
        os.path.join(DATA, "texture_hillshade.jpg"), quality=88)
    print("texture_hillshade.jpg %d×%d" % (TW, TH))

    meta = {
        "region": "custom",
        "name": "自定义区域 %.2f,%.2f,%.2f,%.3f" % tuple(bbox),
        "bbox": bbox, "zoom": 13, "meshSize": N - 1,
        "minHeight": round(mn, 1), "maxHeight": round(float(dem.max()), 1),
        "sizeMeters": {"x": round(width_m, 1), "z": round(height_m, 1)},
        "textures": {"satellite": "texture.jpg", "hillshade": "texture_hillshade.jpg"},
        "heights": "height.bin", "mask": None, "basin": None, "peaks": [],
        "sources": {"dem": "AWS Open Data / Terrarium（SRTM 派生，全球已填洞）",
                    "imagery": "Esri World Imagery（在线，需按其条款署名）"},
        "note": "2026-11-12 向北扩到 28.335°N：论文图 7 的演进路线在 28.33°N 有拱起，原 28.31°N 装不下",
        "generated": "2026-11-12",
    }
    io.open(os.path.join(DATA, "meta.json"), "w", encoding="utf-8").write(
        json.dumps(meta, ensure_ascii=False, indent=1))
    print("meta.json: %.1f × %.1f km" % (width_m / 1000, height_m / 1000))


if __name__ == "__main__":
    main()
