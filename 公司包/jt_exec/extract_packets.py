# -*- coding: utf-8 -*-
"""extract_packets.py — 横排册MD→复核包jsonl（两账册横排五行表专用）
表结构：| 前置条件 | 操作步骤 | 预期结果 | 判断依据 | 测试方法 | + 一行数据
输出：review_{tag}/review_{GRP}.jsonl（GRP=TC第二段前缀），字段与竖版生成器同构
"""
import sys, io, os, re, json, collections
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

tag, md_path, norm_path = sys.argv[1], sys.argv[2], sys.argv[3]
outdir = f'review_{tag}'
os.makedirs(outdir, exist_ok=True)

# 1) 册原文横排提取
md = io.open(md_path, encoding='utf-8').read()
cases = {}
hdr = re.compile(r'^\|\s*前置条件\s*\|\s*操作步骤\s*\|\s*预期结果\s*\|', re.M)
for m in re.finditer(r'####\s+(TC-[A-Za-z0-9\-_]+)[^\n]*\n(.*?)(?=\n####\s+TC-|\n###\s|\Z)', md, re.S):
    tc, body = m.group(1), m.group(2)
    title = m.group(0).split('\n')[0][len(tc) + 5:].strip()
    if '~~' in title.split('（')[0]:
        title = title  # 失效条照收
    hm = hdr.search(body)
    if not hm:
        continue
    # 数据行=表头行之后的第一个非分隔行
    dm = re.search(r'^\|(?![-\s|]*\|)[^\n]*$', body[hm.end():], re.M)
    if not dm:
        continue
    cols = [c.strip() for c in dm.group(0).strip().strip('|').split('|')]
    cases[tc] = {'tc': tc, 'title': title[:100],
                 'pre': (cols[0] if len(cols) > 0 else '')[:600],
                 'step': (cols[1] if len(cols) > 1 else '')[:400],
                 'exp': (cols[2] if len(cols) > 2 else '')[:400],
                 'basis': (cols[3] if len(cols) > 3 else '')[:200]}

# 2) 账本末次判定
final = {}
for line in io.open(norm_path, encoding='utf-8'):
    if line.strip():
        d = json.loads(line)
        final[d['tc']] = d

# 3) 组包（按前缀分组落盘）
pkt = collections.defaultdict(list)
no_md = []
for tc, v in final.items():
    c = cases.get(tc)
    if not c:
        no_md.append(tc)
        c = {'tc': tc, 'title': '', 'pre': '', 'step': '', 'exp': '', 'basis': ''}
    pkt[tc.split('-')[1] if '-' in tc else 'misc'].append({**c,
        'spec': {}, 'verdict': v.get('判定'), '摘要': str(v.get('实际摘要', ''))[:400],
        '备注': str(v.get('备注', ''))[:200], 'ts': v.get('ts', ''), 'evid_exists': False})

stat = {}
for k, rows in sorted(pkt.items()):
    with io.open(os.path.join(outdir, f'review_{k}.jsonl'), 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    stat[k] = dict(collections.Counter(r['verdict'] for r in rows))

# 4) 对账输出
bad_hdr = sum(1 for k2 in ('pre', 'step', 'exp') for c in cases.values()
              if c[k2] and ('操作步骤' in c[k2][:30] or '预期结果' in c[k2][:30]))
print(f'{tag}: TC总数(账本)={len(final)} 册提取={len(cases)} 无册文={len(no_md)} 字段仍为表头样={bad_hdr}')
print(json.dumps(stat, ensure_ascii=False))
if no_md[:8]:
    print('no_md样例:', no_md[:8])
