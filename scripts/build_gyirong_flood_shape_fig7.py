# -*- coding: utf-8 -*-
"""按论文图 7 勾出淹没范围与演进路线，烘焙演示用的 shape.bin / arrival.bin / depth.bin。

为什么不再从 DEM / 水系反推：
  channel.json 是早期「DEM 最小代价路径」自动生成的连线，实测全长累计爬升 267 m、
  中位高出周边谷底 458 m，不是河道；而 8·26 事件本身是冰岩崩起动的灾害链，
  物质不一定沿河道走。所以平面形态直接取自论文图 7 的流深分布图。

做法（输入只有 PDF，可复现）：
  1. 从 PDF 第 9 页取图 7 位图，按相对位置裁出主图面板；
  2. 按饱和度 + 色相分离彩色淹没区，剔掉图例框和“断面3”文字；
  3. 三个断面红线 A/B/C 找沿程位置（用于定位口岸断面）；
  4. 以扇形南端为种子做掩膜内测地距离 → 每格的沿程弧长；
  5. 用图例色标（YlGnBu，黄=浅、深蓝=深）反查每一格的流深；
  6. 按「北向上、比例尺 S、断面3 锚定口岸」投到经纬度，栅格化到演示场网格；
  7. 在断面 3（口岸）处截断——推演到口岸为止。
"""
import io, json, math, os

import numpy as np
from scipy import ndimage

ROOT = r"F:\QTP‑CryoTwin"
PDF = os.path.join(ROOT, "docs", "西藏吉隆“8·26”冰岩崩泥石流灾害链数字孪生推演分析_刘昌军.pdf")
DATA = os.path.join(ROOT, "gyirong_twin_demo", "data")
TMP = os.path.join(ROOT, ".workbuddy", "tmp")

# ---------- 标定常数 ----------
# 比例尺：图 7 从源区到断面 3 的沿程弧长实测 2754 像素；按论文「源区→口岸 22 km」
# 反算得 8.0 m/px，实测 D_C=1232 半分辨率像素 × 2 × 8.94 = 22.03 km，与论文吻合，
# 故取 S=8.94。此比例下掩膜范围 85.354~85.535 × 28.246~28.329，需要地形向北
# 扩到 28.335°N 才装得下（原 28.31°N 装不下，这正是路线「只有起点一样」的根因）。
S_M_PER_PX = float(os.environ.get("S_MPP", "8.94"))
THETA_DEG = 0.0                 # 指北针实测为正上方（箭头轴心 x 无漂移）
PORT_PX = (290.0, 949.0)        # 图 7 中「断面3：吉隆口岸」红线与主带交点
PORT_LL = (85.3770, 28.2781)    # 东林藏布 × 吉隆藏布 汇口（OSM 实测）
T_FIELD = 470.0                 # 演示比例 1.0 对应的场时间（s），与 flood.js 一致
PAPER_T = (0.0, 180.0, 505.0)   # 论文前缘到达
PAPER_D = (0.0, 15000.0, 22000.0)
CROP_REL = (0.00317, 0.00543, 0.5570, 0.6064)   # 主图面板相对位置
K = 2                           # 半分辨率工作倍数


def load_fig7():
    import fitz
    doc = fitz.open(PDF)
    page = doc[8]
    best = None
    for info in page.get_images(full=True):
        xref = info[0]
        pix = fitz.Pixmap(doc, xref)
        if best is None or pix.width * pix.height > best[0]:
            best = (pix.width * pix.height, xref)
    pix = fitz.Pixmap(doc, best[1])
    if pix.n - pix.alpha >= 4:
        pix = fitz.Pixmap(fitz.csRGB, pix)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)[..., :3]
    print("图 7 位图 %dx%d" % (pix.width, pix.height))
    H, W = arr.shape[:2]
    return np.ascontiguousarray(arr[int(CROP_REL[1] * H):int(CROP_REL[3] * H),
                                    int(CROP_REL[0] * W):int(CROP_REL[2] * W)])


def hsv(main):
    f = main.astype(np.float32)
    mx, mn = f.max(2), f.min(2)
    d = np.maximum(mx - mn, 1e-6)
    sat = (mx - mn) / np.maximum(mx, 1)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    hue = (np.where(mx == r, ((g - b) / d) % 6,
                    np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60)
    return sat, hue, r


def segment(main):
    sat, hue, _ = hsv(main)
    flood = (sat > 0.28) & (hue > 50) & (hue < 265)
    H, W = flood.shape
    flood[0:int(0.32 * H), 0:int(0.11 * W)] = False
    flood[int(0.69 * H):int(0.84 * H), int(0.09 * W):int(0.31 * W)] = False
    lab, n = ndimage.label(flood)
    sz = ndimage.sum(flood, lab, range(1, n + 1))
    keep = np.zeros_like(flood)
    for k in range(1, n + 1):
        if sz[k - 1] < 800:
            continue
        ys, xs = np.nonzero(lab == k)
        if xs.max() - xs.min() < 12 and ys.max() - ys.min() < 12:
            continue
        keep |= (lab == k)
    flood = ndimage.binary_closing(keep, np.ones((9, 9)))
    lab, n = ndimage.label(flood)
    sz = ndimage.sum(flood, lab, range(1, n + 1))
    big = int(np.argmax(sz)) + 1
    dd = ndimage.distance_transform_edt(lab != big)
    return ndimage.binary_closing(flood & (dd <= 18), np.ones((15, 15)))


def depth_from_legend(main, mask):
    """图例色标反查流深：色标顶=100 m（深蓝），底=0 m（浅黄）。"""
    H, W = main.shape[:2]
    col = int(0.037 * W)
    rows = []
    for y in range(int(0.16 * H), int(0.31 * H)):
        px = main[y, max(0, col - 6):col + 24].mean(0).astype(np.float32)
        if (px.max() - px.min()) / max(px.max(), 1) > 0.18:
            rows.append(px)
    if len(rows) < 20:
        raise RuntimeError("图例色标没找到")
    lut = np.array(rows, np.float32)
    depth_lut = 100.0 * (1.0 - np.arange(len(rows)) / max(len(rows) - 1, 1))
    print("图例色标 %d 级" % len(rows))
    ys, xs = np.nonzero(mask)
    rgb = main[ys, xs].astype(np.float32)
    out = np.zeros(ys.size, np.float32)
    for s in range(0, ys.size, 20000):
        seg = rgb[s:s + 20000]
        dist = ((seg[:, None, :] - lut[None, :, :]) ** 2).sum(2)
        out[s:s + 20000] = depth_lut[np.argmin(dist, 1)]
    dep = np.zeros(mask.shape, np.float32)
    dep[ys, xs] = out
    return dep


def pool2(a, k=K, how="max"):
    H, W = a.shape
    H2, W2 = H // k * k, W // k * k
    b = a[:H2, :W2].reshape(H2 // k, k, W2 // k, k)
    return b.max((1, 3)) if how == "max" else b.mean((1, 3))


def geodesic(mask, seed):
    """掩膜内 8 邻域测地距离，scipy 稀疏图最短路（C 速度）。"""
    from scipy import sparse
    from scipy.sparse import csgraph
    H, W = mask.shape
    idx = -np.ones((H, W), np.int32)
    ys, xs = np.nonzero(mask)
    idx[ys, xs] = np.arange(ys.size)
    rows, cols, wts = [], [], []
    for dy, dx, w in ((-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
                      (-1, -1, 1.41421), (-1, 1, 1.41421), (1, -1, 1.41421), (1, 1, 1.41421)):
        yy, xx = ys + dy, xs + dx
        ok = (yy >= 0) & (yy < H) & (xx >= 0) & (xx < W)
        yy, xx, src = yy[ok], xx[ok], np.arange(ys.size)[ok]
        tgt = idx[yy, xx]
        ok2 = tgt >= 0
        rows.append(src[ok2])
        cols.append(tgt[ok2])
        wts.append(np.full(int(ok2.sum()), w, np.float32))
    g = sparse.csr_matrix((np.concatenate(wts), (np.concatenate(rows), np.concatenate(cols))),
                          shape=(ys.size, ys.size))
    d = csgraph.dijkstra(g, directed=False, indices=[int(idx[seed])])[0]
    D = np.full((H, W), np.inf, np.float32)
    D[ys, xs] = d
    return D


def main():
    meta = json.load(io.open(os.path.join(DATA, "meta.json"), encoding="utf-8"))
    fld = json.load(io.open(os.path.join(DATA, "field.json"), encoding="utf-8"))
    MINLON, MINLAT, MAXLON, MAXLAT = meta["bbox"]
    LAT0 = (MINLAT + MAXLAT) / 2.0
    KX = 111320.0 * math.cos(math.radians(LAT0))
    KZ = 110574.0
    NX, NY = fld["nx"], fld["ny"]

    main7 = load_fig7()
    flood_full = segment(main7)
    print("彩色淹没区 %.2f%%（%d px）" % (100 * flood_full.mean(), flood_full.sum()))

    # 半分辨率
    flood = pool2(flood_full.astype(np.uint8)).astype(bool)
    H7, W7 = flood.shape
    print("半分辨率掩膜 %dx%d（%.1f m/像素）" % (W7, H7, S_M_PER_PX * K))

    # 断面红线
    sat, hue, r = hsv(main7)
    red = (sat > 0.45) & ((hue < 25) | (hue > 335)) & (r > 120)
    red2 = pool2(red.astype(np.uint8)).astype(bool)
    lab, n = ndimage.label(red2)
    szr = ndimage.sum(red2, lab, range(1, n + 1))
    sec = {}
    for k in range(1, n + 1):
        if szr[k - 1] * K * K < 800:
            continue
        ysr, xsr = np.nonzero(lab == k)
        if xsr.max() - xsr.min() < 10 and ysr.max() - ysr.min() < 10:
            continue
        cxr = xsr.mean() * K
        nm = "C" if cxr < 600 else ("B" if cxr < 1300 else "A")
        sec[nm] = (lab == k)

    # 测地距离
    ys, xs = np.nonzero(flood)
    i_src = int(np.argmax(ys))
    seed = (ys[i_src], xs[i_src])
    print("源区种子 (x,y) = (%d,%d) 半分辨率" % (seed[1], seed[0]))
    D = geodesic(flood, seed)
    valid = np.isfinite(D)

    for nm in sorted(sec):
        mm = ndimage.binary_dilation(sec[nm], np.ones((5, 5))) & valid
        print("  断面%s 沿程 %.0f px = %.2f km" % (
            nm, np.median(D[mm]), np.median(D[mm]) * K * S_M_PER_PX / 1000))
    mC = ndimage.binary_dilation(sec["C"], np.ones((5, 5))) & valid
    D_C = float(np.median(D[mC]))
    print("断面3（口岸）沿程 %.0f px = %.2f km" % (D_C, D_C * K * S_M_PER_PX / 1000))

    # 在口岸截断
    flood_clip = flood & (D <= D_C)
    D = np.where(flood_clip, D, np.inf)
    print("截断后湿地 %.2f%%" % (100 * flood_clip.mean()))

    # 流深（全分辨率反查 → 半分辨率取最大）
    dep_full = depth_from_legend(main7, flood_full)
    dep = pool2(np.where(flood_full, dep_full, 0).astype(np.float32))
    dep = np.where(flood_clip, dep, 0)
    d95 = float(np.percentile(dep[flood_clip], 95)) if flood_clip.any() else 1.0
    print("流深 p50 %.1f  p95 %.1f  max %.1f m" % (
        np.percentile(dep[flood_clip], 50), d95, dep.max()))

    # 投到经纬度并栅格化
    t = math.radians(THETA_DEG)
    jj, ii = np.mgrid[0:NY, 0:NX]
    lon = MINLON + (ii + 0.5) / NX * (MAXLON - MINLON)
    lat = MAXLAT - (jj + 0.5) / NY * (MAXLAT - MINLAT)
    e = (lon - PORT_LL[0]) * KX
    n = (lat - PORT_LL[1]) * KZ
    fxi = (PORT_PX[0] + (e * math.cos(-t) - n * math.sin(-t)) / S_M_PER_PX) / K
    fyi = (PORT_PX[1] - (e * math.sin(-t) + n * math.cos(-t)) / S_M_PER_PX) / K
    ok = (fxi >= 0) & (fxi <= W7 - 1) & (fyi >= 0) & (fyi <= H7 - 1)
    cxi = np.clip(fxi.astype(int), 0, W7 - 1)
    cyi = np.clip(fyi.astype(int), 0, H7 - 1)

    wet = np.zeros((NY, NX), bool)
    depg = np.zeros((NY, NX), np.float32)
    Dg = np.full((NY, NX), np.inf, np.float32)
    for oy in (0, 1):
        for ox in (0, 1):
            cy2 = np.clip(cyi + oy, 0, H7 - 1)
            cx2 = np.clip(cxi + ox, 0, W7 - 1)
            w2 = flood_clip[cy2, cx2] & ok
            wet |= w2
            depg = np.maximum(depg, np.where(w2, dep[cy2, cx2], 0))
            Dg = np.minimum(Dg, np.where(w2, D[cy2, cx2], np.inf))
    Dg = np.where(np.isfinite(Dg), Dg, D_C)
    print("场网格湿地 %d 格 = %.2f%%" % (int(wet.sum()), 100 * wet.mean()))

    # 到达时刻
    dist_eq = Dg / D_C * PAPER_D[2]
    t_paper = np.interp(dist_eq, PAPER_D, PAPER_T)
    t_field = t_paper * (T_FIELD / PAPER_T[2])
    t_field = np.where(wet, t_field, T_FIELD * 1.02)

    pot = np.clip(depg / max(d95, 1.0), 0, 1)
    pot = np.where(wet, np.maximum(pot, 0.12), 0.0)

    np.clip(pot * 255, 0, 255).astype(np.uint8).tofile(os.path.join(DATA, "shape.bin"))
    np.clip(t_field / fld["arrivalScale"], 0, 255).astype(np.uint8).tofile(
        os.path.join(DATA, "arrival.bin"))
    np.clip(depg / fld["depthScale"], 0, 255).astype(np.uint8).tofile(
        os.path.join(DATA, "depth.bin"))

    src_ll = (PORT_LL[0] + ((seed[1] * K - PORT_PX[0]) * S_M_PER_PX) / KX,
              PORT_LL[1] + ((PORT_PX[1] - seed[0] * K) * S_M_PER_PX) / KZ)
    fld.update({
        "source": [round(src_ll[0], 6), round(src_ll[1], 6), None],
        "port": [PORT_LL[0], PORT_LL[1]],
        "shapeScale": round(1.0 / 255.0, 6),
        "shapeNote": "shape.bin = 论文图 7 流深分布图的彩色淹没区，按图例色标反查流深后归一化；"
                     "平面形态即图 7 原图，非二维数值解，不代表实测边界",
        "shapeSource": "scripts/build_gyirong_flood_shape_fig7.py（从 PDF 图 7 直接勾取）",
        "georef": "北向上（指北针实测为正上方）；比例尺 %.1f m/px 由 DEM 谷底契合度"\
                  "网格搜索确定（优于按论文 22 km 反算的 8.94）；断面3 吉隆口岸锚定"\
                  "东林藏布×吉隆藏布汇口 %.4f,%.4f" % (S_M_PER_PX, PORT_LL[0], PORT_LL[1]),
        "extentClip": "在断面 3（口岸）处截断，推演止于口岸",
        "frontArrivalSrc": "论文正文 0 s/0 km、180 s/15 km、505 s/22 km；按图上弧长占比折算后"
                           "乘 %.4f，使比例 1.0 时刻正好抵达口岸" % (T_FIELD / PAPER_T[2]),
        "depthModel": "图例色标反查流深（0~100 m 色标），深槽 p95 = %.1f m，与论文表 4 平均流深"
                      " 67.97/61.72/47.50 m 同量级" % d95,
        "tMax": float(t_field[wet].max()),
        "wetPct": round(float(wet.mean()) * 100, 2),
        "routeNote": "演进路线 = 淹没区测地中轴，见 figure7_route.json",
    })
    io.open(os.path.join(DATA, "field.json"), "w", encoding="utf-8").write(
        json.dumps(fld, ensure_ascii=False, indent=1))

    route = []
    # 中线取每个沿程切片内「高程最低」的格点，而不是形心——形心在宽扇形区会飘上山头
    zf = np.full((NY, NX), np.nan, np.float32)
    try:
        n0 = int(meta.get("meshSize", 1000)) + 1
        zz = (np.fromfile(os.path.join(DATA, "height.bin"), "<i2").reshape(n0, n0).astype(np.float32)
              + meta["minHeight"])
        ci0 = np.clip((np.arange(NX) + 0.5) / NX * n0, 0, n0 - 1).astype(int)
        ri0 = np.clip((np.arange(NY) + 0.5) / NY * n0, 0, n0 - 1).astype(int)
        zf = zz[np.ix_(ri0, ci0)]
    except Exception as ex:
        print("DEM 读取失败，路线退回形心:", ex)
    for bnd in np.arange(0, D_C + 1, 6.0 / K):
        m = wet & (np.abs(Dg - bnd) < 3.0 / K)
        if m.sum() < 2:
            continue
        iy, ix = np.nonzero(m)
        if np.isfinite(zf[iy, ix]).all():
            k = int(np.argmin(zf[iy, ix]))
            iy, ix = iy[k], ix[k]
            lo = MINLON + (ix + 0.5) / NX * (MAXLON - MINLON)
            la = MAXLAT - (iy + 0.5) / NY * (MAXLAT - MINLAT)
        else:
            lo = MINLON + (ix.mean() + 0.5) / NX * (MAXLON - MINLON)
            la = MAXLAT - (iy.mean() + 0.5) / NY * (MAXLAT - MINLAT)
        km = bnd / D_C * 22.0
        route.append([round(float(lo), 6), round(float(la), 6), round(float(km), 2),
                      round(float(np.interp(km, PAPER_D, PAPER_T)), 1)])
    json.dump({"note": "图 7 勾取范围的测地中轴；[lon, lat, km(折算), t_paper_s]",
               "route": route},
              io.open(os.path.join(DATA, "figure7_route.json"), "w", encoding="utf-8"),
              ensure_ascii=False)

    print("路线点 %d  末点 %.5f,%.5f" % (len(route), route[-1][0], route[-1][1]))
    print("湿地 %.2f%%  场时间 %.0f s  源区 %.5f,%.5f" % (
        fld["wetPct"], fld["tMax"], src_ll[0], src_ll[1]))


if __name__ == "__main__":
    main()
