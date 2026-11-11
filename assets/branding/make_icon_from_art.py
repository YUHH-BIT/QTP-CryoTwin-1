# -*- coding: utf-8 -*-
"""从设计母图生成系统图标（favicon / 桌面快捷方式 / 文档配图）。

母图要求：正方形，主体（含圆角方框线）居中，四角为纯色底。
脚本会按实测方框边界裁切，再生成两版：

  rounded  圆角透明版——方框线外侧抠透明，作为默认 app-icon.ico
  square   方形版——保留深蓝底，作为备选 app-icon-square.ico

用法（项目内嵌运行时）：
    .runtime\\python\\python.exe assets\\branding\\make_icon_from_art.py
    .runtime\\python\\python.exe assets\\branding\\make_icon_from_art.py --src assets\\branding\\图标.jpg

产物：
    app-icon.ico            16/24/32/48/64/128/256 多尺寸（默认圆角透明版）
    app-icon.png            512px 透明主图（文档 / 汇报封面）
    app-icon-1024.png       1024px 透明原图
    app-icon-square.ico     方形备选版（预留，未接线）
"""
import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

# 母图实测：方框 x 196..822 / y 196..818，圆角半径约 94px（边长 626）
BOX_CENTER_XY = (509.0, 507.0)
BOX_SIDE = 626
CORNER_RATIO = 0.157          # 98 / 626，贴合方框线外沿
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
SS = 4                        # 圆角蒙版超采样倍数


def crop_square(im, center, side, out=1024):
    cx, cy = center
    box = (round(cx - side / 2), round(cy - side / 2),
           round(cx + side / 2), round(cy + side / 2))
    return im.crop(box).resize((out, out), Image.LANCZOS)


def rounded_alpha(size, ratio):
    """抗锯齿圆角蒙版：4x 超采样 + 0.6px 羽化。"""
    m = Image.new("L", (size * SS, size * SS), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size * SS - 1, size * SS - 1],
                        radius=int(size * SS * ratio), fill=255)
    return m.resize((size, size), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.6))


def render(img, px):
    """缩放到目标尺寸；小尺寸补锐化，抵消线框缩小后发灰。"""
    s = img.resize((px, px), Image.LANCZOS)
    percent = 130 if px <= 32 else 90
    return s.filter(ImageFilter.UnsharpMask(radius=0.8, percent=percent, threshold=2))


def build(src, outdir):
    im = Image.open(src).convert("RGB")
    if im.width != im.height:
        raise SystemExit("母图必须是正方形，当前 %dx%d" % im.size)

    square = crop_square(im, BOX_CENTER_XY, BOX_SIDE)

    rounded = square.convert("RGBA")
    rounded.putalpha(rounded_alpha(rounded.width, CORNER_RATIO))

    products = {
        "app-icon.png": render(rounded, 512),
        "app-icon-1024.png": rounded,
    }
    for name, img in products.items():
        img.save(os.path.join(outdir, name))
        print("  %-22s %dpx" % (name, img.width))

    for name, base in (("app-icon.ico", rounded), ("app-icon-square.ico", square)):
        frames = [render(base, px) for px in ICO_SIZES]
        frames[-1].save(os.path.join(outdir, name), format="ICO",
                        sizes=[(px, px) for px in ICO_SIZES],
                        append_images=frames[:-1])
        print("  %-22s %s" % (name, "/".join(str(s) for s in ICO_SIZES)))
    return rounded


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="从设计母图生成图标资源")
    ap.add_argument("--src", default=os.path.join(here, "图标.jpg"),
                    help="设计母图路径（默认同目录 图标.jpg）")
    ap.add_argument("--outdir", default=here, help="输出目录（默认本目录）")
    args = ap.parse_args()

    if not os.path.isfile(args.src):
        raise SystemExit("找不到母图：%s" % args.src)

    print("母图：%s" % args.src)
    os.makedirs(args.outdir, exist_ok=True)
    build(args.src, args.outdir)
    print("完成，输出目录：%s" % args.outdir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
