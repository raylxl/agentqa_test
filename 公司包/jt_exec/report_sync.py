# -*- coding: utf-8 -*-
"""report_sync.py — 执行账本 → 测试报告自动汇总/校验脚本（交付物规范 v1.16 §20.2/§20.3 落地工具）
用法: python report_sync.py <账本.json> <报告.md> [轮次名]
自动生成/校验：1.2 四态数字、模块表、环比辅助（按账本 ts 日期分桶）；结构校验（三段式四关键节+轮次块12字段）。
每轮测试收尾必跑本脚本（usecase-executor §6.9 收尾工序）；数字不一致或结构缺节均禁止收尾。
"""
import json, sys, io, re, os, datetime
from collections import Counter
try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception: pass

ledger = sys.argv[1]
report = sys.argv[2]
round_name = sys.argv[3] if len(sys.argv) > 3 else '本轮'

r = json.load(io.open(ledger, encoding='utf-8'))
seen = {}
for x in r: seen[x['id']] = x
# R 后缀复验证据条归并：仅当 R 条与基条**双 PASS**（纯复验确认，无四态信息损失）才不计数
# （TC-ADD-34R 复验载体=归并；TC-ADD-175R 探针=OBSERVE 正式四态条目，保留计数）
base_ids = set(seen.keys())
merged = []
for k in list(seen.keys()):
    m = re.match(r'^(TC-[A-Z]+-\d+)R$', k)
    if m and m.group(1) in base_ids and seen[k].get('status') == 'PASS' and seen[m.group(1)].get('status') == 'PASS':
        merged.append(k); seen.pop(k)
if merged: print(f'（归并复验证据条 {len(merged)} 条不计数: {", ".join(sorted(merged))}）')
tot = Counter(x['status'] for x in seen.values())
N = len(seen)

# 账本最新落账日期（用于收尾声明校验）
max_ts = max((x.get('ts') or '') for x in seen.values()) if seen else ''
max_day = max_ts[:10]

print(f'=== 账本汇总（{ledger} · {round_name}）===')
print(f'总计 {N} 条')
for k in ['PASS', 'FAIL', 'BLOCKED', 'SUSPEND', 'OBSERVE']:
    if tot.get(k): print(f'  {k}: {tot[k]} ({tot[k]/N*100:.1f}%)')
pct = tot['PASS'] / N * 100
print(f'实质通过率 {pct:.1f}%')
can_test = N - tot['OBSERVE'] - tot['SUSPEND']
print(f'可测条 {can_test}（剔除失效 {tot["OBSERVE"]}+挂起 {tot["SUSPEND"]}）→ 可测通过率 {tot["PASS"]/can_test*100:.1f}%' if can_test else '无可测条')

# 分模块
ch = {}
for tid, x in seen.items():
    ch.setdefault(tid.split('-')[1], Counter())[x['status']] += 1
print('\n=== 分模块 ===')
for c in sorted(ch):
    d = ch[c]
    print(f'  {c:6s} {sum(d.values()):3d}条 P{d["PASS"]:3d} F{d.get("FAIL",0)} B{d.get("BLOCKED",0)} S{d.get("SUSPEND",0)} O{d.get("OBSERVE",0)}')

# 环比辅助：按账本 ts 日期分桶（供人工填 1.2 环比行与轮次块"环比"字段，禁手编造）
if any(x.get('ts') for x in seen.values()):
    day = {}
    for x in seen.values():
        d = (x.get('ts') or '')[:10]
        if d: day.setdefault(d, Counter())[x['status']] += 1
    print('\n=== 环比辅助（按账本 ts 日期分桶 · 供填 1.2 环比行/轮次块环比字段）===')
    cum = 0
    for d in sorted(day):
        dd = day[d]
        cum += dd['PASS']
        print(f'  {d}: 落账 P{dd["PASS"]} F{dd.get("FAIL",0)} O{dd.get("OBSERVE",0)} S{dd.get("SUSPEND",0)} （累计PASS≈{cum}，注=同条多轮以末次落账日计）')

md = io.open(report, encoding='utf-8').read()

# ===== 硬校验①：文件时间戳（客观信号，无法绕过）=====
# 账本 mtime 晚于报告 mtime = 执行后报告未同步 → 本轮收尾未完成
print('\n=== 收尾状态校验（硬）===')
close_ok = True
lt = os.path.getmtime(ledger); rt = os.path.getmtime(report)
lag_min = (lt - rt) / 60
if lt > rt:
    close_ok = False
    print(f'  ✗ 账本更新时间晚于报告 {lag_min:.0f} 分钟——本轮执行后报告未同步，收尾未完成！')
else:
    print(f'  ✓ 报告不落后于账本（报告较账本新 {(rt-lt)/60:.0f} 分钟）')

# ===== 硬校验②：收尾声明行 vs 账本最新落账日 =====
# 报告头部声明行「> 最后收尾：第 N 轮 · {轮次名} · {YYYY-MM-DD}」（§20.2 每轮必更）
# 声明日期 < 账本最新落账日期 = 有执行未收尾（即使数字碰巧一致也拦）
m3 = re.search(r'> \*\*最后收尾\*\*：第 (\d+) 轮 · (.+?) · (\d{4}-\d{2}-\d{2})', md)
if m3:
    decl_day = m3.group(3)
    if max_day and decl_day < max_day:
        close_ok = False
        print(f'  ✗ 收尾声明日期{decl_day}（第{m3.group(1)}轮）早于账本最新落账{max_day}——存在未收尾执行轮（若格式含全角括号等修饰导致解析异常，先核对声明行原文）')
    else:
        print(f'  ✓ 收尾声明=第{m3.group(1)}轮 {decl_day} ≥ 账本最新落账 {max_day}')
else:
    close_ok = False
    print('  ✗ 报告头部缺「> **最后收尾**：第 N 轮 · 轮次名 · 日期」声明行（§20.2 每轮必更）')

# 报告数字校验：1.2 四态表与本汇总比对（PASS/OBSERVE/SUSPEND 三态+合计，2026-11-13 质检 R3 扩）
print(f'\n=== 报告数字校验 ===')
ok_all = True
def _row(pat, label, actual):
    global ok_all
    m = re.search(pat, md)
    if not m:
        print(f'{label} 未找到数字行'); ok_all = False; return
    v = int(m.group(1)); ok = (v == actual); ok_all &= ok
    print(f'{label}={v}，账本={actual} → {"✓ 一致" if ok else "✗ 不一致！必须更新报告"}')
# 2026-11-14 兼容历史版式（某册报告§1.1曾为「PASS 系 N 条（x%）」两列指标表）：PASS 允许「系」尾注+数字后非*字符；OBSERVE/SUSPEND 行缺失=软跳过（该态计0仅提示），避免历史报告误红
# 2026-11-14 二补：数字校验限定在§一（总进度节，至§二执行轮次前），防误抓他节同名行；合计行区域缺失=软跳过
_sec = re.split(r'^## 二、执行轮次', md, flags=re.M)[0]
_sec = (_sec.split('## 一、总进度') or [''])[-1] if '## 一、总进度' in _sec else _sec
md_num = _sec if _sec else md
m_p = re.search(r'\| \*\*PASS(?:\s*系)?\*\* \| \*\*(\d+)', md_num)
if m_p:
    ok = int(m_p.group(1)) == tot['PASS']; ok_all &= ok
    print(f"1.2/1.1 PASS={m_p.group(1)}，账本={tot['PASS']} → {'✓ 一致' if ok else '✗ 不一致！必须更新报告'}")
else:
    print('1.2 四态表 PASS 未找到数字行'); ok_all = False
for pat, label, actual in [(r'\|\s*OBSERVE \| (\d+) \|', '1.2 四态表 OBSERVE', tot['OBSERVE']), (r'\|\s*SUSPEND \| (\d+) \|', '1.2 四态表 SUSPEND', tot['SUSPEND'])]:
    mm = re.search(pat, md_num)
    if mm:
        ok2 = int(mm.group(1)) == actual; ok_all &= ok2
        print(f'{label}={mm.group(1)}，账本={actual} → {"✓ 一致" if ok2 else "✗ 不一致！"}')
    else:
        print(f'{label} 行未找到（历史版式无该态行）→ 跳过（账本该态 {actual} 条）')
m2 = re.search(r'\| \*\*合计\*\* \| \*\*(\d+)\*\*', md_num)
if m2:
    ok = int(m2.group(1)) == N
    ok_all &= ok
    print(f'1.2 合计={m2.group(1)}，账本={N} → {"✓ 一致" if ok else "✗ 不一致！"}')

# 结构校验（三段式冻结模板 v1.16 §20.2）：四关键节 + 轮次块 12 字段
print('\n=== 结构校验（三段式冻结模板）===')
struct_ok = True
for sec, pat in [('一、总进度', r'^## 一、总进度'), ('二、执行轮次', r'^## 二、执行轮次'),
                 ('附、支撑数据', r'^## 附、支撑数据'), ('附A 余项清单', r'^## 附A、'),
                 ('附B 拍板台账', r'^## 附B、')]:
    hit = re.search(pat, md, re.M)
    if not hit: struct_ok = False
    print(f'  {"✓" if hit else "✗ 缺失！"} {sec}')
blocks = re.findall(r'^### 第 .* 轮.*$', md, re.M)
FIELDS = ['做了什么', '做了多久', '环比', '解决了什么', '有什么问题', '缺陷单变化',
          '需求变更', '系统实现', '用例问题', '拍板记录', '剩什么问题', '为何只做这些']
print(f'  轮次块数={len(blocks)}')
# 轮次顺序单调递增检查（2026-11-14 质检Y5：移位/重复漏网盲区；R5修复=取行首"第 N 轮"数字组）
seq = [int(x) for x in re.findall(r'^### 第 (\d+) 轮', md, flags=re.M)]
if seq != sorted(seq) or len(set(seq)) != len(seq):
    print(f'  ✗ 轮次顺序异常：{seq}（须单调递增且不重复）')
    struct_ok = False
else:
    print(f'  ✓ 轮次顺序单调递增：{seq}')
# 逐块校验 12 字段
parts = re.split(r'^### 第 .* 轮.*$', md, flags=re.M)[1:]
for i, part in enumerate(parts, 1):
    nxt = re.split(r'^### 第 .* 轮.*$|^## ', part, flags=re.M)[0]
    missing = [f for f in FIELDS if not re.search(r'^\| ' + f, nxt, re.M)]
    if missing:
        struct_ok = False
        print(f'  ✗ 第{i}块缺字段: {"、".join(missing)}')
print(f'  {"✓ 全部轮次块 12 字段齐" if struct_ok else "✗ 存在缺字段轮次块"}')

# ===== 硬校验④：回写台账 pending 残留（2026-11-13 立，跨需求质检 17 红根治）=====
# 拍板产生回写义务必须登记 writeback_pending.jsonl；残留 pending = 有拍板未落地 = 禁收尾。
# 台账位置：账本同目录（缺省）或正本同名分章目录；两处都无文件时视为该册尚未启用台账（黄提示不拦）。
print('\n=== 回写台账校验（硬④）===')
wb_pending_n = 0
wb_candidates = [os.path.join(os.path.dirname(ledger), 'writeback_pending.jsonl'),
                 os.path.join(os.path.splitext(report)[0].rsplit('_测试报告', 1)[0] + '分章', 'writeback_pending.jsonl')]
wb_found = next((p for p in wb_candidates if os.path.exists(p)), None)
if wb_found is None:
    print('  ⚠ 未找到 writeback_pending.jsonl（本册台账未建档——新册首轮回填建档，老册下次拍板前必须建档）')
else:
    wbl = []
    for line in io.open(wb_found, encoding='utf-8'):
        line = line.strip()
        if line:
            try: wbl.append(json.loads(line))
            except Exception: print(f'  ✗ 台账行解析失败: {line[:50]}'); wb_pending_n += 1
    # 2026-11-14：与 writeback_check 统一豁免口径——pending=有意挂账（拍板/等回写通知/XMind重出），降黄不红；
    # 红=行解析失败（done 锚点细验在 writeback_check）
    pend = [x for x in wbl if x.get('status') == 'pending']
    if wb_pending_n:
        print(f'  ✗ 回写台账解析失败 {wb_pending_n} 行——禁收尾！')
    elif pend:
        print(f'  ⚠ {wb_found}：done {sum(1 for x in wbl if x.get("status")=="done")} 条 / pending {len(pend)} 条挂账（拍板豁免待回写通知，非禁收尾；细验锚点请跑 writeback_check.py）')
    else:
        print(f'  ✓ {wb_found}：done {sum(1 for x in wbl if x.get("status")=="done")} 条 / pending 0（细验锚点请跑 writeback_check.py）')

# ===== 硬校验⑤：执行批次行配对（执行细则 §十五 v1.11，2026-11-16 拍板"每轮计时"）=====
# pw_runner 每轮必落 run_start/run_end 批次行（含中途终止轮）；起而不终/终而无起/生效后新轮无批次行 = 红。
# 生效时刻之后的历史轮豁免（此前无批次行=合规，报告标"未计时"即可，禁编造）。
print('\n=== 批次行配对校验（硬⑤ · 细则§十五 v1.11）===')
batch_ok = True
_runner_ledger = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pw_layered', 'ledger.jsonl')
RULE_TS = '2026-11-16 12:00'   # 批次行纪律生效时刻（本节落地时点，北京时间）
if not os.path.exists(_runner_ledger):
    print(f'  ⚠ 未找到 {_runner_ledger}（非正本运行位？软跳过）')
else:
    starts, ends, item_dt = {}, {}, {}
    for line in io.open(_runner_ledger, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if row.get('type') == 'run_start':
            starts[row['runId']] = row
        elif row.get('type') == 'run_end':
            ends[row['runId']] = row
        elif row.get('runId') and row.get('ts'):
            try:   # 逐条 ts=UTC ISO → 北京时刻（与批次行同口径）
                dt = datetime.datetime.fromisoformat(str(row['ts']).replace('Z', '+00:00'))
                bj = (dt + datetime.timedelta(hours=8)).strftime('%Y-%m-%d %H:%M')
                item_dt.setdefault(row['runId'], bj)
            except ValueError:
                pass
    no_end = [k for k in starts if k not in ends]
    orphan_end = [k for k in ends if k not in starts]
    no_batch = {k: d for k, d in item_dt.items() if k not in starts and d >= RULE_TS}
    if no_end:
        batch_ok = False
        shown = ', '.join(sorted(no_end)[:5]) + ('…' if len(no_end) > 5 else '')
        print(f'  ✗ {len(no_end)} 个 run_start 无配对 run_end（中途终止也必须落）：{shown}')
    if orphan_end:
        batch_ok = False
        print(f'  ✗ 孤儿 run_end（无 run_start 配对）：{", ".join(sorted(orphan_end)[:5])}')
    if no_batch:
        batch_ok = False
        shown = ', '.join(sorted(no_batch)[:5]) + ('…' if len(no_batch) > 5 else '')
        print(f'  ✗ {len(no_batch)} 个生效后新轮（≥{RULE_TS}）无 run_start 批次行（漏记=执行工序违规）：{shown}')
    if batch_ok:
        _n_other = len(ends) - sum(1 for r in ends.values() if r.get('endKind') == 'normal')
        print(f'  ✓ {len(starts)} 对批次行全配对（endKind normal {len(ends)-_n_other}/其他 {_n_other}）；'
              f'生效前历史轮组 {sum(1 for d in item_dt.values() if d < RULE_TS)}（无批次行=合规，报告标"未计时"）')

print(f'''
=== 判定 ===
数字 {"✓ 一致" if ok_all else "✗ 不一致，禁收尾"} ／ 结构 {"✓ 合规" if struct_ok else "✗ 缺节/缺字段，禁收尾"} ／ 收尾状态 {"✓ 已同步" if close_ok else "✗ 报告落后，禁开新轮"} ／ 回写台账 {"✓ 清零" if not wb_pending_n else "✗ 残留，禁收尾"} ／ 批次行 {"✓ 配对齐" if batch_ok else "✗ 漏配对/漏记，禁收尾"}

=== 收尾三件事检查（usecase-executor §6.9；开工第 0 步=先跑本脚本验上轮）===
1. 账本落定 ✓（{N} 条）
2. 报告三段式更新 → 1.1~1.4 总进度（每轮必更）＋新增轮次块 12 字段（只增）＋头部「最后收尾」声明行＋附A 余项清单（每轮必更）→ 更新后重跑本脚本须全绿
3. memory 更新（关键拍板/新教训）
''')
if not (ok_all and struct_ok and close_ok and batch_ok): sys.exit(1)
if wb_pending_n: sys.exit(1)
