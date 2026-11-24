#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""stitch_at.py — 按横向偏移拼接多条截图（G89 横向可滚动面板拍成整表一张）

用法: python stitch_at.py <out.png> [--bottom-crop=N] <x1:in1.png> [<x2:in2.png> ...]
第 i 条贴在 x=x_i 处（x_i=截图时面板的 scrollLeft，以内容左缘为 0）；重叠部分内容相同，后贴覆盖先贴。
--bottom-crop=N：裁掉每条底部 N 像素（面板自身的横向滚动条带，拼接后会重复出现）。
输入条与 out 同目录（给文件名即可）。输出宽=max(x_i+条宽)，高=各条高的最大值；输出后删除输入条。
"""
import os
import sys

from PIL import Image


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: stitch_at.py <out.png> [--bottom-crop=N] <x1:in1.png> [<x2:in2.png> ...]")
    out_path = os.path.abspath(sys.argv[1])
    d = os.path.dirname(out_path)
    strips = []
    crop = 0
    for spec in sys.argv[2:]:
        if spec.startswith("--bottom-crop="):
            crop = max(0, int(float(spec.split("=", 1)[1])))
            continue
        xs, name = spec.split(":", 1)
        path = name if os.path.isabs(name) else os.path.join(d, name)
        im = Image.open(path).convert("RGB")
        if crop and im.size[1] > crop:
            im = im.crop((0, 0, im.size[0], im.size[1] - crop))
        strips.append((int(float(xs)), path, im))
    if not strips:
        sys.exit("no strips given")
    w = max(x + im.size[0] for x, _p, im in strips)
    h = max(im.size[1] for _x, _p, im in strips)
    canvas = Image.new("RGB", (w, h), (255, 255, 255))
    for x, _p, im in sorted(strips, key=lambda s: s[0]):
        canvas.paste(im, (x, 0))
    canvas.save(out_path)
    for _x, p, _im in strips:
        try:
            os.remove(p)
        except OSError:
            pass
    print(f"stitched {len(strips)} -> {out_path} {w}x{h}")


if __name__ == "__main__":
    main()
