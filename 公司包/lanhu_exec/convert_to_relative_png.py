#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把「蓝湖视觉还原」MD 里的内嵌 base64 图（<img ... src="data:image/png;base64,...">）
导出为真实 PNG 文件，并把 MD 引用改写为相对路径 ![]()。

输出结构（与"缺陷分析"目录的图片引用方式完全一致，Typora / 各类 Markdown 预览器可正常显示）：
  <md目录>/<md名(去扩展名)>_images/界面1.png
  <md目录>/<md名(去扩展名)>_images/界面2.png
  ...
MD 内引用改为： ![alt](<md名>_images/界面N.png)

用法:
  python convert_to_relative_png.py <md文件1> [<md文件2> ...]
必须显式传入 md 文件（产物在哪个目录就传哪个，无默认值——旧版默认文件清单属原工作区残留）。
"""
import re
import os
import sys
import base64
from PIL import Image

TAG_RE = re.compile(r'<img\b[^>]*>')
SRC_RE = re.compile(r'src="data:image/png;base64,([A-Za-z0-9+/=]+)"')
ALT_RE = re.compile(r'alt="([^"]*)"')
# 也兼容已经是 ![]() 内联 base64 的情况（历史文件）
MD_DATA_RE = re.compile(r'!\[([^\]]*)\]\((data:image/png;base64,([A-Za-z0-9+/=]+))\)')


def convert_file(md_path):
    base = os.path.dirname(md_path) or '.'
    stem = os.path.splitext(os.path.basename(md_path))[0]
    imgdir = os.path.join(base, stem + '_images')
    os.makedirs(imgdir, exist_ok=True)

    t = open(md_path, encoding='utf-8').read()
    counter = [0]

    def save_and_ref(raw, alt):
        counter[0] += 1
        fn = '界面%d.png' % counter[0]
        with open(os.path.join(imgdir, fn), 'wb') as fh:
            fh.write(raw)
        return '![' + alt + '](' + stem + '_images/' + fn + ')'

    def repl_tag(m):
        tag = m.group(0)
        am = ALT_RE.search(tag)
        alt = am.group(1) if am else ('界面%d' % counter[0])
        sm = SRC_RE.search(tag)
        if not sm:
            return m.group(0)
        raw = base64.b64decode(sm.group(1))
        return save_and_ref(raw, alt)

    def repl_md(m):
        alt = m.group(1)
        b64 = m.group(3)
        raw = base64.b64decode(b64)
        return save_and_ref(raw, alt)

    t2 = TAG_RE.sub(repl_tag, t)
    t2 = MD_DATA_RE.sub(repl_md, t2)
    open(md_path, 'w', encoding='utf-8').write(t2)
    print('%s -> 导出图片 %d 张到 %s' % (md_path, counter[0], stem + '_images/'))


if __name__ == '__main__':
    files = sys.argv[1:]
    if not files:
        sys.exit('用法: python convert_to_relative_png.py <md文件1> [<md文件2> ...]（必须显式传入）')
    for f in files:
        if not os.path.isfile(f):
            print('跳过(不存在):', f)
            continue
        convert_file(f)
