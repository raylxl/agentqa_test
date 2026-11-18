#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""trim_margin.py — CDP 整宽截图裁右侧/底部空白边（G73f）
用法: python trim_margin.py <imgDir> <file1> [file2 ...]
判据：从右往左/从下往上找第一个"非均匀列/行"（与紧邻内侧列/行存在像素差），保留 10px 边距。
"""
import sys, os
from PIL import Image, ImageChops

def trim(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    def col_diff(x1, x2):
        a = im.crop((x1, 0, x1 + 1, h)).tobytes()
        b = im.crop((x2, 0, x2 + 1, h)).tobytes()
        return a != b
    def row_diff(y1, y2):
        a = im.crop((0, y1, w, y1 + 1)).tobytes()
        b = im.crop((0, y2, w, y2 + 1)).tobytes()
        return a != b
    right, bottom = w, h
    step = 3
    while right - step > 40 and not col_diff(right - 1, right - 6):
        right -= step
    while bottom - step > 40 and not row_diff(bottom - 1, bottom - 6):
        bottom -= step
    if right < w or bottom < h:
        im.crop((0, 0, min(w, right + 10), min(h, bottom + 10))).save(path)
        return (w, h, min(w, right + 10), min(h, bottom + 10))
    return None

if __name__ == '__main__':
    d, files = sys.argv[1], sys.argv[2:]
    for f in files:
        p = os.path.join(d, f)
        if os.path.exists(p):
            r = trim(p)
            if r:
                print('TRIM', f, f'{r[0]}x{r[1]} -> {r[2]}x{r[3]}')
