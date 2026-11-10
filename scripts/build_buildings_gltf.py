# -*- coding: utf-8 -*-
"""程序化生成吉隆口岸建筑 glTF 模型（.glb，单文件二进制）。

为什么不用 Blender：
  只要"模型看起来是房子"——墙体、玻璃带、女儿墙、坡屋顶、门廊、卷帘门，
  用几十个 box 拼出来就够，导出 glTF 交给 Cesium 的 PBR 管线渲染。

关键性能约束（踩过）：
  每个 box 一个材质 → 每个模型 5~7 个 primitive → 19 栋建筑 130+ draw call，
  软件渲染下帧率掉到 0.2 fps，Cesium 的瓦片调度完全停摆（影像糊成一片）。
  所以这里**所有几何合并成一个 primitive，颜色走顶点色 COLOR_0**，
  整栋楼 1 次 draw call。

坐标约定：y 向上，地面 y=0，x 为长边、z 为进深。单位：米。
Cesium 的 Model 默认按 y-up 载入，正好对齐。
"""
import os, io, json, math, struct

OUT = os.path.join(os.getcwd(), "webgis_frontend", "models")

# 配色（口岸实景是白灰墙 + 深色檐口/屋面；对卫星影像要拉开对比，
# 否则白墙会和浅色谷底糊成一片）
MATS = {
    "wall": (0.780, 0.790, 0.795),
    "wall2": (0.600, 0.615, 0.630),
    "trim": (0.150, 0.160, 0.180),
    "glass": (0.075, 0.130, 0.185),
    "roof": (0.430, 0.215, 0.170),
    "roof2": (0.215, 0.225, 0.240),
    "door": (0.330, 0.335, 0.330),
    "concrete": (0.560, 0.565, 0.560),
}


class Mesh2(object):
    """所有盒子合并进一个顶点/索引缓冲，颜色写顶点色。"""

    def __init__(self):
        self.pos, self.nrm, self.col, self.idx = [], [], [], []

    def box(self, c, s, mat, rz=0.0, rx=0.0):
        col = MATS[mat]
        hx, hy, hz = s[0] / 2.0, s[1] / 2.0, s[2] / 2.0
        faces = [
            ((1, 0, 0), [(hx, -hy, -hz), (hx, -hy, hz), (hx, hy, hz), (hx, hy, -hz)]),
            ((-1, 0, 0), [(-hx, -hy, hz), (-hx, -hy, -hz), (-hx, hy, -hz), (-hx, hy, hz)]),
            ((0, 1, 0), [(-hx, hy, -hz), (hx, hy, -hz), (hx, hy, hz), (-hx, hy, hz)]),
            ((0, -1, 0), [(-hx, -hy, hz), (hx, -hy, hz), (hx, -hy, -hz), (-hx, -hy, -hz)]),
            ((0, 0, 1), [(-hx, -hy, hz), (-hx, hy, hz), (hx, hy, hz), (hx, -hy, hz)]),
            ((0, 0, -1), [(hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz), (-hx, -hy, -hz)]),
        ]
        base = len(self.pos) // 3
        fi = 0
        for n, quad in faces:
            for v in quad:
                p = list(v)
                if rx:
                    cc, ss = math.cos(rx), math.sin(rx)
                    p = [p[0], cc * p[1] - ss * p[2], ss * p[1] + cc * p[2]]
                if rz:
                    cc, ss = math.cos(rz), math.sin(rz)
                    p = [cc * p[0] - ss * p[1], ss * p[0] + cc * p[1], p[2]]
                self.pos.extend([p[0] + c[0], p[1] + c[1], p[2] + c[2]])
                self.col.extend([col[0], col[1], col[2], 1.0])
            nn = list(n)
            if rx:
                cc, ss = math.cos(rx), math.sin(rx)
                nn = [nn[0], cc * nn[1] - ss * nn[2], ss * nn[1] + cc * nn[2]]
            for _ in range(4):
                self.nrm.extend(nn)
            # 每个面单独出 6 个索引（原先写在 faces 循环外，导致每个盒子
            # 只画了一个面 → Cesium 里模型塌成一根细条）
            for o in (0, 1, 2, 0, 2, 3):
                self.idx.append(base + fi + o)
            fi += 4


def add_office(m):
    """联检 / 办公综合楼：三层，玻璃带，门廊雨棚，屋顶设备。"""
    L, H, W = 42.0, 13.2, 17.0
    fl = H / 3.0
    m.box((0, H / 2, 0), (L, H, W), "wall")
    m.box((0, 0.6, 0), (L + 0.5, 1.2, W + 0.5), "trim")
    for k in range(3):
        y = fl * k + 5.0
        m.box((0, y, W / 2 + 0.06), (L - 1.6, 2.15, 0.14), "glass")
        m.box((0, y, -W / 2 - 0.06), (L - 1.6, 2.15, 0.14), "glass")
        m.box((L / 2 + 0.06, y, 0), (0.14, 2.15, W - 3.0), "glass")
        m.box((-L / 2 - 0.06, y, 0), (0.14, 2.15, W - 3.0), "glass")
    for k in range(1, 3):
        m.box((0, fl * k, 0), (L + 0.35, 0.5, W + 0.35), "trim")
    m.box((0, H + 0.45, 0), (L + 1.8, 0.9, W + 1.8), "trim")
    m.box((0, H + 1.4, 0), (L + 0.5, 0.9, W + 0.5), "wall2")
    m.box((0, 4.3, W / 2 + 2.6), (15.0, 0.55, 5.4), "concrete")
    for dx in (-6.6, -2.2, 2.2, 6.6):
        m.box((dx, 2.15, W / 2 + 4.6), (0.55, 4.3, 0.55), "concrete")
    m.box((0, 2.4, W / 2 + 0.08), (6.4, 4.8, 0.16), "glass")
    for dx, dz in ((-12, 3), (2, -4), (13, 2)):
        m.box((dx, H + 2.4, dz), (3.4, 2.0, 2.6), "concrete")
    m.box((-L / 2 + 3.2, H + 1.9, -W / 2 + 2.4), (4.6, 3.6, 4.2), "wall2")


def add_shop(m):
    """商铺 / 边贸民居：两层，平顶女儿墙，藏式檐口。"""
    L, H, W = 13.0, 8.4, 10.0
    m.box((0, H / 2, 0), (L, H, W), "wall")
    m.box((0, 0.55, 0), (L + 0.45, 1.1, W + 0.45), "trim")
    m.box((0, 2.0, W / 2 + 0.07), (L - 2.2, 3.2, 0.15), "glass")
    m.box((0, 4.05, W / 2 + 0.10), (L - 1.6, 0.5, 0.22), "trim")
    for dx in (-3.2, 3.2):
        m.box((dx, 6.4, W / 2 + 0.07), (2.5, 2.0, 0.15), "glass")
        m.box((dx, 6.4, W / 2 + 0.09), (2.7, 2.2, 0.12), "trim")
    m.box((0, H - 0.55, 0), (L + 0.9, 0.7, W + 0.9), "trim")
    m.box((0, H - 0.12, 0), (L + 1.25, 0.34, W + 1.25), "roof")
    t, hh = 0.34, 0.85
    m.box((0, H + hh / 2, W / 2 - t / 2), (L, hh, t), "wall2")
    m.box((0, H + hh / 2, -W / 2 + t / 2), (L, hh, t), "wall2")
    m.box((L / 2 - t / 2, H + hh / 2, 0), (t, hh, W), "wall2")
    m.box((-L / 2 + t / 2, H + hh / 2, 0), (t, hh, W), "wall2")
    m.box((0, H + 0.06, 0), (L - 0.7, 0.12, W - 0.7), "roof2")
    m.box((L / 2 - 2.4, H + 1.5, -W / 2 + 2.0), (1.5, 2.6, 1.5), "concrete")


def add_warehouse(m):
    """货检仓库：大跨彩钢坡屋顶 + 卷帘门。"""
    L, H, W = 32.0, 8.6, 16.0
    m.box((0, H / 2, 0), (L, H, W), "wall2")
    m.box((0, 0.5, 0), (L + 0.4, 1.0, W + 0.4), "concrete")
    ridge, eave = H + 3.1, H + 0.25
    half = W / 2.0 + 0.9
    ang = math.atan2(ridge - eave, half)
    slen = math.hypot(ridge - eave, half)
    for sgn in (1, -1):
        cy = (ridge + eave) / 2.0
        cz = sgn * half / 2.0
        m.box((0, cy, cz), (L + 1.4, 0.42, slen), "roof", rx=sgn * ang)
    m.box((0, ridge + 0.1, 0), (L + 1.5, 0.32, 0.7), "trim")
    for dx in (-9.5, 0, 9.5):
        m.box((dx, 3.1, W / 2 + 0.09), (6.2, 5.4, 0.18), "door")
        m.box((dx, 6.0, W / 2 + 0.12), (6.5, 0.5, 0.24), "trim")
    for dx in (-11, -3.6, 3.6, 11):
        m.box((dx, 6.4, -W / 2 - 0.07), (2.8, 1.2, 0.14), "glass")


def add_shed(m):
    """附属简易房：单层，平屋顶挑檐。"""
    L, H, W = 9.0, 4.2, 7.0
    m.box((0, H / 2, 0), (L, H, W), "wall2")
    m.box((0, 0.4, 0), (L + 0.3, 0.8, W + 0.3), "concrete")
    m.box((0, H + 0.22, 0), (L + 1.3, 0.44, W + 1.3), "roof2")
    m.box((1.8, 1.6, W / 2 + 0.08), (1.5, 3.0, 0.14), "door")
    m.box((-2.6, 2.7, W / 2 + 0.07), (2.0, 1.2, 0.13), "glass")


def write_glb(mesh, path):
    buf = bytearray()
    views, accessors = [], []

    def push(data, target=None):
        while len(buf) % 4:
            buf.append(0)
        off = len(buf)
        buf.extend(data)
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        views.append(v)
        return len(views) - 1

    pos = mesh.pos
    n = len(pos) // 3
    bv = push(struct.pack("<%df" % len(pos), *pos), 34962)
    xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
    accessors.append({"bufferView": bv, "componentType": 5126, "count": n, "type": "VEC3",
                      "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]})

    bv = push(struct.pack("<%df" % len(mesh.nrm), *mesh.nrm), 34962)
    accessors.append({"bufferView": bv, "componentType": 5126, "count": n, "type": "VEC3"})

    bv = push(struct.pack("<%df" % len(mesh.col), *mesh.col), 34962)
    accessors.append({"bufferView": bv, "componentType": 5126, "count": n, "type": "VEC4"})

    bv = push(struct.pack("<%dH" % len(mesh.idx), *mesh.idx), 34963)
    accessors.append({"bufferView": bv, "componentType": 5123, "count": len(mesh.idx),
                      "type": "SCALAR"})

    while len(buf) % 4:
        buf.append(0)

    gltf = {
        "asset": {"version": "2.0", "generator": "QTP-CryoTwin building generator"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": os.path.basename(path)}],
        "meshes": [{"primitives": [{
            "attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2},
            "indices": 3, "material": 0, "mode": 4}]}],
        "materials": [{
            "name": "building",
            "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.80, 0.80, 0.78, 1.0],
                "metallicFactor": 0.02,
                "roughnessFactor": 0.85,
            },
        }],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(buf)}],
    }
    j = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    while len(j) % 4:
        j += b" "
    total = 12 + 8 + len(j) + 8 + len(buf)
    with io.open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(j), 0x4E4F534A))
        f.write(j)
        f.write(struct.pack("<II", len(buf), 0x004E4942))
        f.write(bytes(buf))
    return total, len(mesh.idx) // 3


def main():
    os.makedirs(OUT, exist_ok=True)
    specs = [
        ("bld_office", add_office),
        ("bld_shop", add_shop),
        ("bld_warehouse", add_warehouse),
        ("bld_shed", add_shed),
    ]
    lines = []
    for name, fn in specs:
        m = Mesh2()
        fn(m)
        p = os.path.join(OUT, name + ".glb")
        size, tris = write_glb(m, p)
        lines.append("%-16s %7.1f KB  tris=%d" % (name, size / 1024.0, tris))
    io.open(os.path.join(os.getcwd(), ".workbuddy", "tmp", "bld.txt"), "w",
            encoding="utf-8").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
