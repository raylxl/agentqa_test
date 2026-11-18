#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
assemble_visual_md_v2.py - 蓝湖需求视觉还原 MD 组装 v2

相对 v1 的修正（依据 2026-09-30 用户反馈）：
  1. 图片没获取全  → UI 区域改用「带边框的大容器」(border w>300 && h>100) 精确定位，
     不再用 img+小字聚类（旧法漏掉 input/select 构成的查询条件行）。
  2. 适用报价弹窗位置不对 → 描述文本改为「逐行叶子」粒度（不再合并成大块），
     与 UI 区域统一按 y 交错排序，弹窗自然落在“②按重量计费…”之后。
  3. 数据权限格式 → 行内加粗 span 还原为 **加粗**；“登录机构非总部”灰底说明行
     还原为 Markdown 引用块（>），与蓝湖高亮框对应。
"""
import json, base64, io, sys, os
from PIL import Image

import argparse

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'visual_out')
MD_PATH = ''
MENU_NAME = ''


def load_items():
    with open(os.path.join(OUT_DIR, '_diag.json'), encoding='utf-8') as f:
        d = json.load(f)
    # 1) UI 面板 = 带边框大容器
    panels = [b for b in d['borders'] if b['w'] > 300 and b['h'] > 100]
    panels.sort(key=lambda r: (r['y'], r['x']))
    # 2) 行分组：面板外的文本叶子
    def overlap_panel(l):
        for p in panels:
            if not (l['x'] + l['w'] < p['x'] or p['x'] + p['w'] < l['x'] or
                    l['y'] + l['h'] < p['y'] or p['y'] + p['h'] < l['y']):
                return True
        return False

    def in_panel_band(l):
        """面板 y 行带内、且起始于面板左缘之后的叶子 = 面板内容（含被裁剪溢出的表格列），丢弃"""
        cy = l['y'] + l['h'] / 2
        for p in panels:
            if (p['y'] - 10) <= cy <= (p['y'] + p['h'] + 10) and l['x'] >= p['x'] - 10:
                return True
        return False

    leaves = [l for l in d['leaves']
              if not overlap_panel(l) and not in_panel_band(l) and l['text'].strip()]
    leaves.sort(key=lambda r: (r['y'], r['x']))
    lines = []
    for l in leaves:
        placed = False
        for ln in lines:
            # 同一行：y 带重叠且高度相近
            if abs(ln['y'] - l['y']) <= max(ln['h'], l['h']) * 0.6:
                ln['parts'].append(l)
                ln['y'] = min(ln['y'], l['y'])
                ln['h'] = max(ln['h'], l['h'])
                placed = True
                break
        if not placed:
            lines.append({'y': l['y'], 'h': l['h'], 'x': l['x'], 'fs': l['fs'], 'parts': [l]})
    for ln in lines:
        ln['parts'].sort(key=lambda r: r['x'])
    lines.sort(key=lambda r: r['y'])
    return panels, lines, d


def render_line(ln):
    """一行叶子 → MD 文本，加粗 span 包 **；删除线叶子（deco=line-through）包 ~~（v3.1）"""
    groups = []  # ((bold, deco), text)
    for l in ln['parts']:
        t = l['text']
        b = l.get('fw', 400) >= 600
        d = l.get('deco', '') == 'line-through'
        key = (b, d)
        if groups and groups[-1][0] == key:
            groups[-1][1] += t
        else:
            groups.append([key, t])
    # 合并相邻同 flag 后拼装
    out = ''
    for (b, d), t in groups:
        t = t.strip()
        if not t:
            continue
        if d:
            t = f'~~{t}~~'
        if b:
            t = f'**{t}**'
        out += t
    return out.strip()


def main():
    global OUT_DIR, MD_PATH, MENU_NAME
    ap = argparse.ArgumentParser()
    ap.add_argument('--menu', required=True)
    ap.add_argument('--outfile', required=True)
    ap.add_argument('--outdir', default=OUT_DIR)
    args = ap.parse_args()
    OUT_DIR = args.outdir
    MD_PATH = args.outfile
    MENU_NAME = args.menu

    panels, lines, diag = load_items()
    full = Image.open(os.path.join(OUT_DIR, '_frame_full.png'))

    items = []  # (y, kind, payload)
    for i, p in enumerate(panels, 1):
        pad = 2
        box = (max(0, p['x'] - pad), max(0, p['y'] - pad),
               min(full.width, p['x'] + p['w'] + pad), min(full.height, p['y'] + p['h'] + pad))
        crop = full.crop(box)
        name = f'{MENU_NAME} 界面{i}'
        items.append((p['y'], 'img', (name, crop)))

    prev_y = None
    for ln in lines:
        text = render_line(ln)
        if not text:
            continue
        gap = (ln['y'] - prev_y) if prev_y is not None else 999
        prev_y = ln['y']
        items.append((ln['y'], 'text', (text, gap, ln['fs'])))

    items.sort(key=lambda it: (it[0], 0 if it[1] == 'text' else 1))

    md = []
    md.append(f'# 蓝湖需求（视觉还原版）— {MENU_NAME}')
    md.append('')
    import datetime
    md.append('> 提取时间: %s | UI 模型=带边框容器整块截图(base64)，'
              '示例值只在截图中；描述按蓝湖逐行还原(含加粗)，顺序=视觉位置。'
              % datetime.datetime.now().strftime('%Y/%m/%d %H:%M'))
    md.append('')
    last_kind = None
    for y, kind, payload in items:
        if kind == 'img':
            name, crop = payload
            if md and md[-1] != '':
                md.append('')
            buf = io.BytesIO()
            crop.save(buf, format='PNG', optimize=True)
            b64 = base64.b64encode(buf.getvalue()).decode()
            # 用标准 MD ![]() 内联 base64：单文件自包含、无外部文件；VSCode/Typora/GitHub/
            # Obsidian 等标准预览器都能渲染成图片，点击是图片预览而非编码。
            # （之前用 <img> 会被用户的预览器当纯文本显示，故改回 ![]()）
            md.append(f'![{name}](data:image/png;base64,{b64})')
            md.append('')
            last_kind = 'img'
        else:
            text, gap, fs = payload
            if fs >= 17:
                if md and md[-1] != '':
                    md.append('')
                plain = text.replace('**', '').strip()
                md.append(f'## {plain}')
                md.append('')
            else:
                if last_kind is not None and gap > 28 and md and md[-1] != '':
                    md.append('')
                md.append(text)
            last_kind = 'text'
    # 压缩连续空行
    out, blank = [], False
    for l in md:
        if l == '':
            if not blank:
                out.append('')
            blank = True
        else:
            out.append(l)
            blank = False
    md_text = '\n'.join(out).strip() + '\n'
    with open(MD_PATH, 'w', encoding='utf-8') as f:
        f.write(md_text)
    n_img = sum(1 for _, k, _ in items if k == 'img')
    print(f'written bytes={len(md_text.encode("utf-8"))} panels={n_img} lines={len(lines)} -> {MD_PATH}')
    # 结构预览
    for i, l in enumerate(md_text.split('\n'), 1):
        if l.startswith('#') or l.startswith('!['):
            print(f'{i:5d} {l[:60]}')


if __name__ == '__main__':
    main()
