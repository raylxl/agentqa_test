#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""stitch_pairs.py — 左右两拍无缝拼接成一张（G73 终案）
用法: python stitch_pairs.py <imgDir>
对每个 X.png 若存在 X_右.png：右图视口起点=scrollLeft≈左图宽-60（60px 重叠），
拼为 宽=左W+右W-60 的一张，存回 X.png，删除 X_右.png。
"""
import sys, os
from PIL import Image

OVERLAP = 60

def stitch(d, base):
    right = base[:-4] + '_右.png'
    p1, p2 = os.path.join(d, base), os.path.join(d, right)
    if not (os.path.exists(p1) and os.path.exists(p2)):
        return False
    a, b = Image.open(p1).convert('RGB'), Image.open(p2).convert('RGB')
    w = a.size[0] + b.size[0] - OVERLAP
    h = max(a.size[1], b.size[1])  # 高差=空白边裁剪先后的残差，顶对齐拼接
    out = Image.new('RGB', (w, h), (255, 255, 255))
    out.paste(a, (0, 0))
    out.paste(b, (a.size[0] - OVERLAP, 0))
    out.save(p1)
    os.remove(p2)
    print('STITCH', base, f'{w}x{a.size[1]}')
    return True

if __name__ == '__main__':
    d = sys.argv[1]
    for f in sorted(os.listdir(d)):
        if f.endswith('_右.png'):
            stitch(d, f[:-6] + '.png')
