# -*- coding: utf-8 -*-
"""aggregate_challenger.py v2 — 聚合质疑逐条表→双账本（自适应列位+处置列+过期判定集显式化）"""
import sys, io, os, re, json, glob
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
from collections import Counter

TCRE = re.compile(r'^(TC-[A-Za-z0-9\-_]+)$')
CONCL_KWS = ['跳过不成立', '合法跳过', '待补测', '改判失败', '改判通过', '无效待重跑', '无效', '存疑', '证据不足', '需补证', '确认', '维持']

def parse_reports(pattern):
    out = {}
    for p in sorted(glob.glob(pattern)):
        for line in io.open(p, encoding='utf-8'):
            if not line.startswith('|'): continue
            cols = [c.strip() for c in line.strip().strip('|').split('|')]
            ti = next((i for i, c in enumerate(cols) if TCRE.match(c)), None)
            if ti is None: continue
            tc = cols[ti]
            rest = cols[ti + 1:]
            concl = next((c for c in rest if any(k in c for k in CONCL_KWS)), '')
            sugg = ''
            if concl and concl in rest:
                for c in rest[rest.index(concl) + 1:]:
                    if c and any(k in c for k in ('改判', '维持', '需补证', '补测')):
                        sugg = c
                        break
            out[tc] = {'file': os.path.basename(p), 'concl': concl, 'sugg': sugg, 'raw': line.strip()[:260]}
    return out

def bucket(info):
    c = (info['sugg'] + ' ' + info['concl']).replace(' ', '')
    if '改判通过' in c: return '改判通过'
    if '改判失败' in c: return '改判失败'
    if '合法跳过' in c: return '合法跳过'
    if '跳过不成立' in c or '待补测' in c: return '待补测'
    if '无效' in c or '待重跑' in c: return '无效待重跑'
    if '存疑' in c or '证据不足' in c or '需补证' in c: return '存疑'
    if '确认' in c or '维持' in c: return '确认'
    return '其他'

for tag, ledger, patt in [
    ('yz', 'ledger_yz.jsonl', 'challenger_yz/复核结果_*.md'),
    ('cc', 'ledger_cc.jsonl', 'challenger_cc/复核结果_*.md')]:
    tc_last, any_last = {}, {}
    for l in io.open(ledger, encoding='utf-8'):
        if not l.strip(): continue
        r = json.loads(l)
        if not r.get('tc'): continue
        any_last[r['tc']] = r.get('status')
        if r.get('kind') == 'tc':
            tc_last[r['tc']] = r.get('status')
    stale = {t for t in any_last if tc_last.get(t) != any_last.get(t)}
    rep = parse_reports(patt)
    cnt, stale_hit = Counter(), {}
    for tc, info in sorted(rep.items()):
        b = bucket(info)
        cnt[b] += 1
        if tc in stale:
            stale_hit[tc] = (b, tc_last.get(tc), any_last.get(tc))
    missing = [t for t in any_last if t not in rep]
    print(f'=== {tag}: 覆盖 {len(rep)}/{len(any_last)}，缺 {len(missing)}，过期复核条 {len(stale_hit)}')
    print(' ', dict(cnt))
    if missing[:6]: print('  缺(前6):', missing[:6])
    for t, (b, old, new) in sorted(stale_hit.items()):
        print(f'  过期: {t} 质疑结论={b} (按旧{old}复核, 现行末次={new})')
