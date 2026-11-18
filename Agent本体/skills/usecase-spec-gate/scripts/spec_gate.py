# -*- coding: utf-8 -*-
"""spec_gate.py — 规格保真门·组包+机检 lint（usecase-spec-gate 配套）
输入：机器规格 json + 用例册 MD（#### TC- 块竖排五行·L3 通用形态）
输出：分路复核包 jsonl（含 lint 命中清单）+ 终端汇总
七检（L1~L7，溯源=2026-11-18 仓内计费 R2 五根因 E1~E5）：
L1 预期金额核对（exp"金额=N" vs expects）/ L2 多报价计数 / L3 多订单计数 /
L4 最低最高落位 / L5 编码-名称错配 / L6 同码劫持嫌疑 / L7 段值存在性
用法：python spec_gate.py --specs X.json --md 册.md --out DIR [--group tab|prefix|flat]
"""
import sys, io, os, re, json, argparse, collections
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

NUM = r'(\d+(?:\.\d+)?)'
ap = argparse.ArgumentParser()
ap.add_argument('--specs', required=True)
ap.add_argument('--md', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--group', default='tab', choices=['tab', 'prefix', 'flat'])
A = ap.parse_args()
os.makedirs(A.out, exist_ok=True)

def g(block, row):
    m = re.search(r'\|\s*' + row + r'\s*\|\s*([^\n]*)', block)
    return m.group(1).strip() if m else ''

s = io.open(A.md, encoding='utf-8').read()
cases = {}
for m in re.finditer(r'####\s+(TC-[A-Za-z0-9\-_]+)[^\n]*\n(.*?)(?=\n####\s+TC-|\n###\s|\Z)', s, re.S):
    cases[m.group(1)] = {'pre': g(m.group(2), '前置条件'), 'step': g(m.group(2), '操作步骤'), 'exp': g(m.group(2), '预期结果')}

def fnum(x):
    try: return round(float(x), 4)
    except Exception: return None

def lint(tc, md, spec):
    hits = []
    pre, step, exp = md.get('pre', ''), md.get('step', ''), md.get('exp', '')
    quotes = spec.get('quotes') or ([spec['quote']] if spec.get('quote') else [])
    pushes = spec.get('pushes') or ([spec['push']] if spec.get('push') else [])
    expects = spec.get('expects') or []
    details = [d for q in quotes for d in (q.get('details') or [])]
    # L1 预期金额核对
    for m in re.finditer(r'金额[^0-9=＝]{0,6}[=＝]\s*' + NUM, exp):
        v = fnum(m.group(1))
        if v is not None and not any(fnum(e.get('amount')) == v or abs((fnum(e.get('amount')) or -9e9) - v) < 0.005 for e in expects):
            hits.append(f'L1 预期金额{v}未见于expects')
    # L2 多报价计数
    mq = re.search(r'已存在\s*(两|[2-9])\s*条[^。；]*报价', pre)
    want_q = 2 if mq and mq.group(1) == '两' else (int(mq.group(1)) if mq else None)
    eq = len(re.findall(r'报价[AB]"', pre)) or len(re.findall(r'报价[AB][\u201c\u201d]', pre))
    if eq >= 2: want_q = max(want_q or 0, eq)
    if want_q and len(quotes) not in (want_q, want_q + 1):   # +1 容错：兜底报价
        hits.append(f'L2 原文{want_q}条报价 vs 规格{len(quotes)}条')
    # L3 多订单计数
    if ('订单甲' in step and '订单乙' in step and len(pushes) < 2):
        hits.append('L3 原文订单甲乙双单 vs pushes<' + str(len(pushes)))
    mo = re.search(r'(\d+)\s*张', pre + step)
    if mo and int(mo.group(1)) >= 2 and len(pushes) < int(mo.group(1)) and 'reuse' not in json.dumps(pushes):
        hits.append(f'L3 原文{mo.group(1)}张订单 vs pushes{len(pushes)}')
    # L4 最低/最高落位
    for label, key in (('最低', 'minPrice'), ('最高', 'maxPrice')):
        for m in re.finditer(label + r'(?:收费)?\s*' + NUM, pre):
            v = fnum(m.group(1))
            if v and not any(fnum(d.get(key)) == v for d in details):
                hits.append(f'L4 原文{label}{v}未落位{key}')
    # L5 编码-名称错配
    for d in details:
        for k in ('materialCode', 'skuCode', 'itemCode'):
            if d.get(k) and re.search(r'[一-龥]', str(d[k])):
                hits.append(f'L5 {k}含中文（填名非码）:{str(d[k])[:20]}')
                break
    # L6 同码劫持嫌疑
    for p in pushes:
        org = p.get('org') if isinstance(p.get('org'), dict) else {}
        if org.get('bizCode') and org.get('bizCode') == org.get('opCode') and not re.search(r'同一个仓|单仓|同一仓', pre + step):
            hits.append('L6 bizCode==opCode（EXEMPT劫持嫌疑，原文非单仓）')
            break
    for q in quotes:
        dm = q.get('dims') or {}
        if dm.get('biz') and dm.get('biz') == dm.get('op') and not re.search(r'同一个仓|单仓|同一仓', pre):
            hits.append('L6 报价biz==op（同码嫌疑，原文非单仓）')
            break
    # L7 段值存在性（单价/基础数量/续价）
    for label, keys in (('单价', ('unitPrice', 'basicPrice')), ('基础数量', ('basicValue',)), ('续价', ('renewalPrice',))):
        for m in re.finditer(label + r'(?:费)?\s*[=＝]?\s*' + NUM, pre):
            v = fnum(m.group(1))
            if v and not any(fnum(d.get(k)) == v for d in details for k in keys):
                hits.append(f'L7 原文{label}{v}未见于明细')
    return hits

pkt = collections.defaultdict(list)
n_hit = collections.Counter()
for spec in json.load(io.open(A.specs, encoding='utf-8')):
    tc = spec.get('tc') or spec.get('TC')
    md = cases.get(tc, {})
    hits = [] if spec.get('skip_reason') else lint(tc, md, spec)
    for h in hits: n_hit[h.split(' ')[0]] += 1
    grp = (spec.get('tab') if A.group == 'tab' and spec.get('tab') else (tc.split('-')[1] if A.group == 'prefix' and '-' in tc else 'all'))
    pkt[grp].append({'tc': tc, 'title': spec.get('title', ''), 'pre': md.get('pre', '')[:1200], 'step': md.get('step', '')[:600],
                     'exp': md.get('exp', '')[:600], 'spec': {k: spec.get(k) for k in ('quotes', 'pushes', 'expects', 'skip_reason', 'note', 'tab')},
                     'lint': hits})
stat = {}
for k, rows in sorted(pkt.items()):
    with io.open(os.path.join(A.out, f'specgate_{k}.jsonl'), 'w', encoding='utf-8') as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + '\n')
    stat[k] = {'n': len(rows), 'lint命中': sum(1 for r in rows if r['lint'])}
print('保真门组包+机检完成:', json.dumps(stat, ensure_ascii=False))
print('lint 命中分布:', dict(n_hit) or '零命中')
print('下一步：分路派独立子代理六保真维度深查（见 SKILL.md 模板）——机检绿≠保真')
