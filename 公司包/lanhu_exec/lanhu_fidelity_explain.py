# -*- coding: utf-8 -*-
"""
lanhu_fidelity_explain.py — 文字忠实闸红项排障（只读）：对一份文档跑 lanhu_fidelity.py，取每个红项，
逐步解释它卡在判定 的哪一步（整体是否等于页面原样的一行/连续几行；按 <br> 切开的各视觉行各自能否溯源；行距是否成立）。

用法：
  python lanhu_fidelity_explain.py --doc "<文档.md>" --menu "<树内菜单名>"      # 源取 collect_cache 里该菜单最新一次
  python lanhu_fidelity_explain.py --doc "<文档.md>" --src "<leaves_text.txt>"
忠实闸判红的处置顺序（别急着改判据）：
  ① "溯源不到"——把红项逐段对回页面原文：是文档真不对应页面（如页面上下两行被并成一行、正文被吞进表格）→ 修文档/采集器；
  ② "与上一行间距…没有"等位置类原因——多为文档把不相干的两行拼进了一格；
  ③ 确认是判据太窄才改判据，且改完必跑 selftest/selftest_fidelity.py（标准 R14a）。"""
import argparse, glob, importlib.util, io, os, re, subprocess, sys
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('lf', os.path.join(HERE, 'lanhu_fidelity.py'))
lf = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(lf)

ap = argparse.ArgumentParser(description='文字忠实闸红项逐步解释')
ap.add_argument('--doc', required=True)
g = ap.add_mutually_exclusive_group(required=True)
g.add_argument('--menu', help='树内菜单名（在 out/collect_cache 下取最新一次的页面原文）')
g.add_argument('--src', help='直接给 leaves_text.txt 路径')
a = ap.parse_args()

if a.src:
    src = a.src
else:
    d = os.path.join(HERE, 'out', 'collect_cache', re.sub(r'[\\/:*?"<>|]', '_', a.menu)[:40])
    cands = sorted(glob.glob(os.path.join(d, '*', 'leaves_text.txt')))
    if not cands:
        sys.exit('缓存里没有这个菜单的页面原文：%s' % d)
    src = cands[-1]

proc = subprocess.run([sys.executable, os.path.join(HERE, 'lanhu_fidelity.py'), '--doc', a.doc, '--src', src],
                      capture_output=True, text=True, encoding='utf-8', errors='replace')
reds = [l for l in proc.stdout.splitlines() if '[①疑似改写' in l]
print(proc.stdout.strip().splitlines()[0] if proc.stdout.strip() else '')
if not reds:
    print('忠实闸没有"疑似改写/自撰"红项（退出码 %d）' % proc.returncode)
    sys.exit(0)

rows = []
for ln in io.open(src, encoding='utf-8').read().splitlines():
    p = ln.split('|', 5)
    if len(p) >= 6 and p[5].strip():
        rows.append((p[0], p[1], p[5].strip()))
blocks, cells, _ = lf.load_doc_blocks(Path(a.doc))
_, explain = lf.build_sourcer(Path(src), [lf.norm(x) for x in lf.load_source(Path(src))])
strip = lambda s: re.sub(r'<br\s*/?>', '', s)
seen = set()
for l in reds:
    m = re.match(r'\s*\[①疑似改写/自撰\] L(\d+) sim=[\d.]+ (.*)', l)
    no = int(m.group(1))
    key = lf.norm(strip(m.group(2)))[:14]
    cand = [c for (n, c) in cells if n == no and lf.norm(strip(c))[:14] == key]
    cand += [b for (n, b) in blocks if n == no and lf.norm(strip(b))[:14] == key]
    if not cand:
        continue
    txt = cand[0]
    if (no, txt[:40]) in seen:
        continue
    seen.add((no, txt[:40]))
    is_cell = any(c is txt for (n, c) in cells)
    print('\n--- L%d（%s）  %r' % (no, '表格单元格' if is_cell else '正文', txt[:120]))
    for stage, ok, why in explain(txt, is_cell)['steps']:
        print('     [%s] %-22s %s' % ('✓' if ok else '✗', stage, why))
    first = re.split(r'<br\s*/?>|\s+', txt.strip())[0]
    hit = [(y, x) for (y, x, t) in rows if lf.norm(first) and lf.norm(first) in lf.norm(t)]
    print('     首段「%s」在页面上的位置（y, x）：%s' % (first[:16], hit[:5] if hit else '找不到含它的页面原文行'))
