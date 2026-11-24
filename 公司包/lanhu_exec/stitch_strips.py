#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""stitch_strips.py — 竖切多条无缝拼接成一张（G85 图示截图高出视口时）

用法: python stitch_strips.py <out.png> <in1.png> [<in2.png> ...]
按给定顺序自上而下拼接（各条取最小等宽），输出 out.png 并删除输入条。
与 stitch_pairs.py（左右两拍）互补：本脚本只管竖向。
"""
import os
import sys

from PIL import Image


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: stitch_strips.py <out.png> <in1.png> [<in2.png> ...]")
    out_path, inputs = sys.argv[1], sys.argv[2:]
    ims = [Image.open(p).convert("RGB") for p in inputs]
    w = min(i.size[0] for i in ims)
    h = sum(i.size[1] for i in ims)
    canvas = Image.new("RGB", (w, h), (255, 255, 255))
    y = 0
    for im in ims:
        canvas.paste(im.crop((0, 0, w, im.size[1])), (0, y))
        y += im.size[1]
    canvas.save(out_path)
    for p in inputs:
        try:
            os.remove(p)
        except OSError:
            pass
    print(f"stitched {len(inputs)} -> {out_path} {w}x{h}")


if __name__ == "__main__":
    main()
