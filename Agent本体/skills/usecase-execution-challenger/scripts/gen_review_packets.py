# -*- coding: utf-8 -*-
"""gen_review_packets.py — 执行复核包生成器（usecase-execution-challenger 配套·通用版）
输入：账本jsonl（同TC取末次判定）+ 机器规格json + 证据件目录 + 用例册MD（#### TC- 块·竖排五行·L3通用形态）
输出：按 --group 分路的复核包 jsonl（每行：tc/title/pre/step/exp/spec/verdict/摘要/备注/evid_exists）
用法：python gen_review_packets.py --ledger X.jsonl --specs X.json --evid DIR --md 册.md --out DIR [--group tab|prefix|flat]
"""
import sys, io, os, re, json, argparse, collections
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ap = argparse.ArgumentParser()
ap.add_argument('--ledger', required=True)
ap.add_argument('--specs', default=None)
ap.add_argument('--evid', required=True)
ap.add_argument('--md', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--group', default='tab', choices=['tab', 'prefix', 'flat'])
ap.add_argument('--title-cut', type=int, default=1200, help='册原文每字段截断长度')
A = ap.parse_args()
os.makedirs(A.out, exist_ok=True)

# 1) 账本末次判定
final = {}
for line in io.open(A.ledger, encoding='utf-8'):
    if not line.strip(): continue
    try: d = json.loads(line)
    except Exception: continue
    if d.get('TC') or d.get('tc'):
        tc = d.get('TC') or d.get('tc')
        final[tc] = d

# 2) 规格
specs = {}
if A.specs and os.path.exists(A.specs):
    for s in json.load(io.open(A.specs, encoding='utf-8')):
        specs[s.get('tc') or s.get('TC')] = s

# 3) 册原文（#### TC- 块 + 竖排五行）
def g(block, row):
    m = re.search(r'\|\s*' + row + r'\s*\|\s*([^\n]*)', block)
    return m.group(1).strip() if m else ''
s = io.open(A.md, encoding='utf-8').read()
cases = {}
for m in re.finditer(r'####\s+(TC-[A-Za-z0-9\-_]+)[^\n]*\n(.*?)(?=\n####\s+TC-|\n###\s|\Z)', s, re.S):
    tc, body = m.group(1), m.group(2)
    if '~~' in m.group(0).split('\n')[0]:   # 失效标识条照收（复核失效合理性）
        pass
    cases[tc] = {'tc': tc,
                 'title': m.group(0).split('\n')[0][len(tc) + 5:].strip(' （(P012)）')[:80],
                 'pre': g(body, '前置条件')[:A.title_cut],
                 'step': g(body, '操作步骤')[:600],
                 'exp': g(body, '预期结果')[:600]}

# 4) 组包
def group_of(tc, spec):
    if A.group == 'tab' and spec and spec.get('tab'): return str(spec['tab'])
    if A.group == 'prefix': return tc.split('-')[1] if '-' in tc else 'misc'
    return 'all'

pkt = collections.defaultdict(list)
no_md, no_verdict = [], []
seen = set()
for tc, v in final.items():
    if tc in seen: continue
    seen.add(tc)
    spec = specs.get(tc, {})
    md = cases.get(tc)
    if not md:
        md = {'tc': tc, 'title': spec.get('title', ''), 'pre': '', 'step': '', 'exp': ''}
        no_md.append(tc)
    ep = os.path.join(A.evid, tc + '.json')
    pkt[group_of(tc, spec)].append({**md,
        'spec': {k: spec.get(k) for k in ('quotes', 'quote', 'pushes', 'push', 'expects', 'expect_costs', 'skip_reason', 'note', 'tab')},
        'verdict': v.get('判定', '(未落账)'), '摘要': str(v.get('实际摘要', ''))[:400],
        '备注': str(v.get('备注', ''))[:200], 'ts': v.get('ts', ''), 'evid_exists': os.path.exists(ep)})
stat = {}
for k, rows in sorted(pkt.items()):
    p = os.path.join(A.out, f'review_{k}.jsonl')
    with io.open(p, 'w', encoding='utf-8') as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + '\n')
    stat[k] = dict(collections.Counter(r['verdict'] for r in rows))
print('复核包就绪:', json.dumps(stat, ensure_ascii=False))
if no_md: print('⚠册中未找到(仍入包,原文空):', no_md[:10], '...共', len(no_md)) if len(no_md) > 10 else print('⚠册中未找到:', no_md)
