# -*- coding: utf-8 -*-
"""build_routes.py — 复核包jsonl→路由markdown（判定面全字段/BLOCKED轻核瘦身）"""
import sys, io, os, json, glob, re
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

tag = sys.argv[1]                      # yz / cc
src = f'review_{tag}'
outdir = f'routes_{tag}'
os.makedirs(outdir, exist_ok=True)

rows = []
for p in sorted(glob.glob(os.path.join(src, 'review_*.jsonl'))):
    grp = re.search(r'review_(\w+)\.jsonl', p).group(1)
    for line in io.open(p, encoding='utf-8'):
        if line.strip():
            d = json.loads(line)
            d['_grp'] = grp
            rows.append(d)

judged = [r for r in rows if r.get('verdict') in ('PASS', 'FAIL')]
blocked = [r for r in rows if r.get('verdict') not in ('PASS', 'FAIL')]

def esc(s): return str(s).replace('\n', ' ').replace('|', '\\|')[:600]

def write_route(name, items, slim):
    path = os.path.join(outdir, name + '.md')
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(f'# 复核路由 {name}（{len(items)} 条）\n\n')
        for r in items:
            f.write(f"## {r['tc']} ｜判定={r.get('verdict')} ｜章={r.get('_grp')}\n")
            f.write(f"- 标题: {esc(r.get('title',''))[:120]}\n")
            f.write(f"- 前置: {esc(r.get('pre',''))[:350]}\n")
            if not slim:
                f.write(f"- 步骤: {esc(r.get('step',''))[:300]}\n")
                f.write(f"- 预期: {esc(r.get('exp',''))[:300]}\n")
                f.write(f"- 判断依据: {esc(r.get('basis',''))[:200]}\n")
            f.write(f"- 执行摘要: {esc(r.get('摘要',''))}\n")
            f.write(f"- 备注: {esc(r.get('备注',''))}\n\n")
    return name, len(items), path

routes = []
# 判定面：≤58/路
CH = 58
for i in range(0, len(judged), CH):
    routes.append(write_route(f'{tag}_F{i//CH+1}', judged[i:i+CH], slim=False))
# BLOCKED 轻核：≤110/路
CH = 110
for i in range(0, len(blocked), CH):
    routes.append(write_route(f'{tag}_B{i//CH+1}', blocked[i:i+CH], slim=True))

print(f'{tag}: judged={len(judged)} blocked={len(blocked)}')
for n, c, p in routes:
    print(f'  {n}: {c} 条 -> {p}')
