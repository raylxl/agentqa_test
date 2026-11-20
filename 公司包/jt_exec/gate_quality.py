# -*- coding: utf-8 -*-
"""gate_quality.py — 质疑门内容质量机检（硬⑦v3 · 2026-11-20 立）
机检三查（质量下限，上限仍靠 qc/独立复核抽位）：
  Q1 计数自洽：双账本表分项之和==合计行==账本唯一TC数（全量复核模式）；
     确认+改判+无效 ≤ 账本判定面数（防把跳过条算进判定面）；
  Q2 逐条表对量：质疑节引用的复核结果文件必须存在，且 |TC-| 行总数 ≥ 分项和
     （每个被分类的 TC 必须在质疑方逐条表里有一行——抽查冒充全量=红）；
  Q3 改判对账：声明改判条数 == 账本"复评改判"行数（口头改判没落账=红）。
轮次级/部分覆盖的质疑节（分项和≠账本总数）走软模式：只验引用文件存在+含表。
用法：python gate_quality.py <账本(.json/.jsonl)> <报告.md>   exit 0=过；1=红
"""
import io, json, os, re, sys, glob
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ledger_p, report_p = sys.argv[1], sys.argv[2]


def load_ledger(p):
    ids = {}
    txt = io.open(p, encoding='utf-8').read()
    if p.endswith('.jsonl'):
        for line in txt.splitlines():
            if not line.strip(): continue
            d = json.loads(line)
            if d.get('tc') or d.get('id'):
                k = d.get('tc') or d.get('id')
                ids[k] = d
    else:
        d = json.loads(txt)
        rows = d.values() if isinstance(d, dict) else d
        for r in rows:
            ids[r.get('id') or r.get('tc')] = r
    return ids


led = load_ledger(ledger_p)
N = len(led)
judged = sum(1 for r in led.values() if r.get('status') in ('PASS', 'FAIL'))
rejudge_rows = sum(1 for r in led.values() if '复评改判' in json.dumps(r, ensure_ascii=False))

md = io.open(report_p, encoding='utf-8').read()
# 定位质疑门节：标题行含"双账本"的 ###/## 节，取其正文到下一个标题
hm = re.search(r'(?m)^#{2,3} [^\n]*双账本[^\n]*$', md)
if not hm:
    print('✗ Q0 未找到质疑门/双账本结论节'); sys.exit(1)
start = hm.end()
nm = re.search(r'(?m)^#{1,3} ', md[start:])
sec = md[start:start + nm.start()] if nm else md[start:]

# Q1 解析分项（标签按"包含"匹配：兼容"跳过不成立·待补测"等前缀变体）
labels = ['确认', '改判通过', '改判失败', '无效待重跑', '存疑', '合法跳过', '待补测']
nums = {}
for line in sec.splitlines():
    c = [x.strip() for x in line.strip().strip('|').split('|')] if line.startswith('|') else []
    if len(c) < 2: continue
    for lb in labels:
        if lb in c[0].replace(' ', '') and re.fullmatch(r'\d+', c[1] or ''):
            nums[lb] = int(c[1]); break
tot = re.search(r'^\|\s*(?:\*\*)?合计(?:\*\*)?\s*\|\s*(?:\*\*)?(\d+)', sec, re.M)

print(f'=== 硬⑦v3 质疑门内容质量机检（gate_quality）===')
print(f'  账本：{N} 条（判定面 {judged}）；双账本分项：{nums}')
red = 0
s = sum(nums.values())
full_mode = bool(tot and int(tot.group(1)) == N)
if full_mode:
    if s != N:
        print(f'  ✗ Q1 分项和 {s} ≠ 账本 {N}（或合计行）——计数不自洽'); red += 1
    else:
        print(f'  ✓ Q1 计数自洽：分项和==合计==账本 {N}（全量复核模式）')
    face = nums.get('确认', 0) + nums.get('改判通过', 0) + nums.get('改判失败', 0) + nums.get('无效待重跑', 0)
    if face > judged:
        print(f'  ✗ Q1 判定面分项 {face} > 账本判定面 {judged}——跳过条混入判定面'); red += 1
else:
    print(f'  ⚠ 软模式（分项和 {s} ≠ 账本 {N}，轮次级/部分覆盖）——只验引用与改判对账')

# Q2 引用文件存在+逐条行数（支持绝对/相对/通配写法；解析不出时按账本标签落 jt_chrome 全局找）
tags = re.findall(r'final_([a-z]+)\.json', os.path.basename(ledger_p), re.I)
tag = tags[0] if tags else None
cands = re.findall(r'[^\s`，。；）)=]*复核结果[^\s`，。；）)]*\.md', sec)
roots = [os.path.dirname(os.path.abspath(report_p)), r'D:\ZCodetest\jt_chrome', r'D:\ZCodetest\jt_chrome\bill2_exec']
refs = set()
for c0 in cands:
    c = c0.split('=')[-1]
    base = c if re.match(r'^[A-Za-z]:', c) else None
    tries = [base] if base else [os.path.join(r, c) for r in roots]
    for t in tries:
        if '*' in t:
            hits = glob.glob(t, recursive=True)
            if hits: refs.update(hits); break
        elif os.path.exists(t):
            refs.add(t); break
if not refs and tag:
    hits = glob.glob(rf'D:\ZCodetest\jt_chrome\**\复核结果_{tag}_*.md', recursive=True)
    refs.update(h for h in hits if 'headerdamaged' not in h and '_bad' not in h)
refs = sorted(refs)
rows = 0
for p in refs:
    if not os.path.exists(p):
        print(f'  ✗ Q2 引用的复核结果文件不存在：{p}'); red += 1
    else:
        rows += sum(1 for l in io.open(p, encoding='utf-8') if re.match(r'^\|.*\bTC-[A-Za-z0-9]', l))
if not refs:
    print('  ✗ Q2 质疑节未引用任何复核结果文件（独立性凭据缺失）'); red += 1
elif full_mode and rows < s:
    print(f'  ✗ Q2 逐条表行数 {rows} < 分项和 {s}——有 TC 被分类但无逐条行（抽查冒充全量嫌疑）'); red += 1
else:
    print(f'  ✓ Q2 引用文件 {len(refs)} 份在案，逐条行 {rows} 条' + ('' if not full_mode else f' ≥ 分项和 {s}'))

# Q3 改判对账
declared = nums.get('改判通过', 0) + nums.get('改判失败', 0)
if declared != rejudge_rows:
    print(f'  ✗ Q3 声明改判 {declared} 条 ≠ 账本复评改判行 {rejudge_rows} 条——口头改判未落账'); red += 1
elif declared or rejudge_rows:
    print(f'  ✓ Q3 改判对账：声明 {declared} == 账本复评行 {rejudge_rows}')
else:
    print('  ✓ Q3 无改判声明，账本亦无复评行（一致）')

if red:
    print(f'=== ⑦v3 判定：✗ {red} 红——质疑门内容质量不达下限 ==='); sys.exit(1)
print('=== ⑦v3 判定：✓ 内容质量下限过（上限靠 qc/独立复核抽位） ===')
