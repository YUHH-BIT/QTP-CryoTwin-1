# -*- coding: utf-8 -*-
"""解压并清点 @toytown/models（CC0）的内容。"""
import io, os, json, tarfile

ROOT = os.getcwd()
TGZ = os.path.join(os.environ.get("TEMP", "/tmp"), "toytown", "toytown-models-0.2.0.tgz")
DST = os.path.join(ROOT, ".workbuddy", "tmp", "toytown_x")
lines = []

if not os.path.isdir(DST):
    os.makedirs(DST, exist_ok=True)
    with tarfile.open(TGZ, "r:gz") as t:
        t.extractall(DST)

# 找 manifest 和 glb
glbs, mans = [], []
for dp, dn, fn in os.walk(DST):
    for f in fn:
        p = os.path.join(dp, f)
        if f.endswith(".glb"):
            glbs.append((p, os.path.getsize(p)))
        if f == "manifest.json":
            mans.append(p)

lines.append("glb count: %d" % len(glbs))
lines.append("manifest: %s" % [os.path.relpath(m, DST) for m in mans])
glbs.sort(key=lambda x: -x[1])
lines.append("--- 最大的 20 个 model")
for p, s in glbs[:20]:
    lines.append("   %6.1f KB  %s" % (s / 1024.0, os.path.relpath(p, DST)))

for m in mans[:3]:
    js = json.load(io.open(m, encoding="utf-8"))
    models = js.get("models", {})
    lines.append("--- manifest %s : %d models" % (os.path.relpath(m, DST), len(models)))
    for k, v in list(models.items())[:20]:
        lines.append("   %-16s %-34s footprint=%s h=%s" % (
            k, v.get("file"), v.get("footprint_m"), v.get("height_m")))

io.open(os.path.join(ROOT, ".workbuddy", "tmp", "toytown.txt"), "w",
        encoding="utf-8").write("\n".join(lines) + "\n")
print("ok")
