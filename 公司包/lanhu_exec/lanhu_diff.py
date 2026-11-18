#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lanhu_diff.py - 蓝湖需求「更新识别」（无需重开浏览器）

对比两次采集缓存（或任意两份 _diag.json），按小节比对，输出：
  - REMOVED   旧有、新无的小节（如被删的「按sku实件维护」）
  - ADDED     新有、旧无的小节（如新增的「3）计费」）
  - CHANGED   标题相同但内容签名变化的小节
      └ 对 CHANGED 小节逐 leaf 比对（按 x,y 对齐）：
          + added   新出现文本
          + removed 旧有、新消失文本
          + modified 同位置文本/删除线/颜色变化（捕获删除线、置灰等视觉更新）

用法:
  python lanhu_diff.py <旧缓存目录或_diag.json> <新缓存目录或_diag.json> [--verbose]
  例:
  python lanhu_diff.py out/collect_cache/配送价格_10._20261012_xxx out/visual_out_ps
  python lanhu_diff.py out/visual_out_gcal/_diag.json out/visual_out_gcal2/_diag.json
"""
import json, os, sys, re, hashlib, argparse


def load_diag(p):
    if os.path.isdir(p):
        cand = os.path.join(p, '_diag.json')
        if not os.path.exists(cand):
            raise SystemExit(f'目录内无 _diag.json: {p}')
        p = cand
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def is_heading(l):
    t = (l.get('text') or '').strip()
    if not t:
        return False
    if re.match(r'^[\s]*[一二三四五六七八九十百零\d]+[、.．:]', t):
        return True
    if re.match(r'^\(\d+\)', t):
        return True
    if re.match(r'^\d+[）)]\s', t):
        return True
    if l.get('fs', 0) >= 17:
        return True
    return False


def compute_sections(diag):
    leaves = sorted(diag.get('leaves', []), key=lambda l: (l['y'], l['x']))
    heads = [{'y': l['y'], 'title': (l.get('text') or '').strip()[:40]} for l in leaves if is_heading(l)]
    if not heads:
        heads = [{'y': 0, 'title': '全文'}]
    docH = diag.get('docH', 0)
    docW = diag.get('docW', 0)
    secs = []
    for k, h in enumerate(heads):
        y0 = h['y']
        y1 = heads[k + 1]['y'] if k + 1 < len(heads) else docH
        band = [l for l in leaves if y0 <= l['y'] < y1]
        sig_src = '\n'.join(f"{l.get('text','')}" for l in band)
        sig = hashlib.md5(sig_src.encode('utf-8')).hexdigest()[:12]
        secs.append({'title': h['title'], 'y0': y0, 'y1': y1, 'sig': sig, 'band': band})
    return secs, docW, docH


def leaf_key(l):
    return (round(l['x'] / 5) * 5, round(l['y'] / 5) * 5)


def norm_style(v):
    """把 deco/color/gray 归一为 ''（无样式）或具体样式串，消除 None/''/'none'/'transparent'/false 等差异。
    仅当两侧归一后不同（即真出现删除线/置灰）才视为样式变更，避免旧缓存无字段导致的误报。"""
    if v is None or v is False:
        return ''
    if isinstance(v, bool):
        return 'gray' if v else ''
    s = str(v).strip().lower()
    if s in ('', 'none', 'normal', 'false', 'transparent', 'initial', 'inherit',
             'rgba(0, 0, 0, 0)', 'rgba(0,0,0,0)', 'rgb(0,0,0)', 'rgb(0, 0, 0)'):
        return ''
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('old')
    ap.add_argument('new')
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()

    old = load_diag(a.old)
    new = load_diag(a.new)
    old_secs, _, _ = compute_sections(old)
    new_secs, _, _ = compute_sections(new)

    old_by_title = {s['title']: s for s in old_secs}
    new_by_title = {s['title']: s for s in new_secs}
    old_titles = set(old_by_title)
    new_titles = set(new_by_title)

    print('=' * 60)
    print(f'更新识别: {a.old}  →  {a.new}')
    print('=' * 60)

    removed = sorted(old_titles - new_titles)
    added = sorted(new_titles - old_titles)
    common = sorted(old_titles & new_titles)
    changed = [t for t in common if old_by_title[t]['sig'] != new_by_title[t]['sig']]

    print(f'\n[小节总数] 旧={len(old_secs)}  新={len(new_secs)}')
    print(f'[REMOVED 删除] {len(removed)} 个:')
    for t in removed:
        print(f'   - {t}')
    print(f'\n[ADDED 新增] {len(added)} 个:')
    for t in added:
        print(f'   + {t}')
    print(f'\n[CHANGED 变更] {len(changed)} 个:')
    if not changed and not removed and not added:
        print('   （无变化）')

    for t in changed:
        ob = {leaf_key(l): l for l in old_by_title[t]['band']}
        nb = {leaf_key(l): l for l in new_by_title[t]['band']}
        adds = [nb[k] for k in nb if k not in ob]
        removes = [ob[k] for k in ob if k not in nb]
        mods = []
        for k in nb:
            if k in ob:
                o, n = ob[k], nb[k]
                diffs = []
                if o.get('text') != n.get('text'):
                    diffs.append('文本')
                if norm_style(o.get('deco')) != norm_style(n.get('deco')):
                    diffs.append('删除线')
                if norm_style(o.get('color')) != norm_style(n.get('color')):
                    diffs.append('颜色/置灰')
                if norm_style(o.get('gray')) != norm_style(n.get('gray')):
                    diffs.append('置灰')
                if diffs:
                    mods.append((o, n, diffs))
        print(f'\n  ▼ {t}')
        print(f'      added={len(adds)} removed={len(removes)} modified={len(mods)}')
        if a.verbose or len(adds) + len(removes) + len(mods) <= 12:
            for l in adds:
                print(f'      + [新] {l.get("text","")[:70]}')
            for l in removes:
                print(f'      - [删] {l.get("text","")[:70]}')
            for o, n, d in mods:
                print(f'      ~ [改:{"/".join(d)}] {o.get("text","")[:50]}  →  {n.get("text","")[:50]}')

    print('\n' + '=' * 60)
    print(f'结论: 删除 {len(removed)} / 新增 {len(added)} / 变更 {len(changed)} 个小节')
    print('=' * 60)


if __name__ == '__main__':
    main()
