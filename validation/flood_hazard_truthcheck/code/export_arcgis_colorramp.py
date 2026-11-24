# -*- coding: utf-8 -*-
"""把图 1（危险性等级 p99）的配色导出为 ArcGIS 可直接使用的色带文件。

配色与 hazard_verify_holdout.py 图 1 一致：0 级未淹没透明（NODATA），
1—5 级为 matplotlib YlOrRd 在 vmin=1, vmax=5 下的 5 个等分取色。

输出（outputs_v2/图1_源文件/）：
  危险性等级_YlOrRd.clr            ArcGIS 色表（value R G B，1—5 级，0 交由 NoData 透明）
  危险性等级_YlOrRd_含NODATA透明.clr 同上并显式写入 0 级 alpha=0
  危险性等级_p99_1980-2023_色表.tif  已内嵌色表的栅格（Pro/ArcMap 打开即按图 1 配色）
"""
import os
import shutil

import numpy as np
import rasterio
from matplotlib import colormaps

SRC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "outputs_v2", "图1_源文件")
SRC_TIF = os.path.join(SRC_DIR, "危险性等级_p99_1980-2023.tif")

# 与图 1 的 imshow(cmap="YlOrRd", vmin=1, vmax=5) 一一对应的 5 个等级色
CLASS_RGB = np.round(
    np.array([colormaps["YlOrRd"](v) for v in np.linspace(0, 1, 5)])[:, :3] * 255
).astype(int)


def write_clr(path, with_nodata):
    lines = []
    if with_nodata:
        lines.append("0 255 255 255 0")
    for lv, (r, g, b) in enumerate(CLASS_RGB, start=1):
        if with_nodata:
            lines.append(f"{lv} {r} {g} {b} 255")
        else:
            lines.append(f"{lv} {r} {g} {b}")
    with open(path, "w", encoding="ascii", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


def write_colored_tif(dst):
    with rasterio.open(SRC_TIF) as s:
        profile = s.profile.copy()
        data = s.read(1)
    profile.update(nodata=0, compress="lzw", tiled=False)
    with rasterio.open(dst, "w", **profile) as d:
        d.write(data, 1)
        cmap = {i: (0, 0, 0, 0) for i in range(256)}
        cmap[0] = (255, 255, 255, 0)  # 未淹没：完全透明
        for lv, rgb in enumerate(CLASS_RGB, start=1):
            cmap[lv] = (int(rgb[0]), int(rgb[1]), int(rgb[2]), 255)
        d.write_colormap(1, cmap)


def main():
    write_clr(os.path.join(SRC_DIR, "危险性等级_YlOrRd.clr"), with_nodata=False)
    write_clr(os.path.join(SRC_DIR, "危险性等级_YlOrRd_含NODATA透明.clr"), with_nodata=True)
    write_colored_tif(os.path.join(SRC_DIR, "危险性等级_p99_1980-2023_色表.tif"))

    print("YlOrRd（vmin=1, vmax=5）等级色：", end="")
    for lv, rgb in enumerate(CLASS_RGB, start=1):
        print(" %d=#%02x%02x%02x" % (lv, rgb[0], rgb[1], rgb[2]), end="")
    print()


if __name__ == "__main__":
    main()
