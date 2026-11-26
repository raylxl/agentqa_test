# -*- coding: utf-8 -*-
"""report_sync.py — 执行账本 → 测试报告自动汇总/校验脚本（交付物规范 v1.17 §20.2/§20.3/§20.10 落地工具）
用法: python report_sync.py <账本.json> <报告.md> [轮次名]
自动生成/校验：1.2 四态数字、模块表、环比辅助（按账本 ts 日期分桶）；结构校验（三段式四关键节+轮次块12字段）。
硬校验：①文件时间戳 ②收尾声明行 ④回写台账 ⑤批次行配对（细则§十五） ⑥失败用例专项报告存在性+逐条对账（交付物§20.10，2026-11-17 立）⑦质疑门节存在性（执行质疑标准 v1.3，2026-11-18 立：双账本节或降级声明，生效后新轮适用）。
⑧PASS 即沉淀（分层执行模式·细则§十四，2026-11-09 拍板；2026-11-26 第三次违反后立机检）：账本每个终态 PASS 的 TC 须有 spec，或在报告「沉淀清单」的不沉淀表里逐条写明原因；生效后新轮适用。
复测行（细则§十七）：同 TC id 末次覆盖=终态对账不双计；retest 标记条目额外披露 PASS(复测)/挂起待复验数。
每轮测试收尾必跑本脚本（usecase-executor §6.9 收尾工序）；数字不一致或结构缺节均禁止收尾。
"""
import json, sys, io, re, os, datetime
from collections import Counter
try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception: pass

if len(sys.argv) < 3:
    print('用法: python report_sync.py <账本.json> <报告.md> [轮次名]')
    sys.exit(2)

ledger = sys.argv[1]
report = sys.argv[2]
round_name = sys.argv[3] if len(sys.argv) > 3 else '本轮'


def _load_ledger(p):
    """账本两种格式都认：JSON 数组（pw_runner/回归器产出）与 JSONL（一行一条；手写轮、AI 首跑轮常见）。
    2026-11-26 实证：快运税务信息维护的账本是 JSONL，此前本脚本一跑即崩（Extra data），等于该需求收尾校验从未真正运行——
    账本格式不应成为绕过收尾校验的理由。字段名也做归一：id/tc、status/verdict。"""
    txt = io.open(p, encoding='utf-8-sig').read()
    try:
        r0 = json.loads(txt)
        return r0 if isinstance(r0, list) else [r0]
    except ValueError:
        rows = []
        for ln in txt.split('\n'):
            ln = ln.strip()
            if not ln:
                continue
            try:
                o = json.loads(ln)
            except ValueError:
                continue   # 批次行（run_start/run_end）或坏行：不是用例行
            if isinstance(o, dict):
                rows.append(o)
        if not rows:
            raise ValueError('账本既不是 JSON 数组也解析不出 JSONL 用例行：' + os.path.basename(p))
        return rows


def _norm_row(x):
    """字段名归一（不改原值）：tc→id、verdict→status（"PASS（放行）"这类带括注的取首词）"""
    if 'id' not in x and 'tc' in x:
        x['id'] = str(x['tc'])
    if 'status' not in x and 'verdict' in x:
        v = str(x['verdict'])
        x['status'] = v.split('（')[0].split('(')[0].strip()
    return x


r = [_norm_row(x) for x in _load_ledger(ledger)]
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

# 复测行披露（细则§十七，2026-11-17 立：同 id 末次覆盖；retest 标记条目单列，不计新四态）
_rt_pass = [x for x in seen.values() if x.get('retest') and x.get('status') == 'PASS']
_rt_pend = [x for x in seen.values() if x.get('retest') and x.get('status') == 'SUSPEND']
if _rt_pass or _rt_pend:
    print(f'（复测轮披露：PASS(复测) {len(_rt_pass)} 条／挂起·待复验 {len(_rt_pend)} 条——判定标准§5.1，两轮证据见失败用例报告）')

# 账本最新落账日期（用于收尾声明校验）
max_ts = max((x.get('ts') or '') for x in seen.values()) if seen else ''
# 账本行不带时间戳时不能默认“生效前”（空串比任何生效时刻都小＝⑥⑦⑧全部被豁免，静默放行）——
# 2026-11-26 实证：快运税务信息维护账本行无 ts 字段。改用账本文件修改时间兜底（北京时间），并如实标明依据。
_TS_SRC = '账本行 ts'
if not max_ts:
    max_ts = datetime.datetime.fromtimestamp(os.path.getmtime(ledger)).strftime('%Y-%m-%dT%H:%M:%S')
    _TS_SRC = '账本文件修改时间（账本行无 ts 字段）'
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
    if tid.startswith('TC-'):
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


def _runner_root():
    """回归器（pw_layered）运行位：优先公司配置 paths.接口执行根，其次 paths.执行工具 下的 pw_layered，
    最后才退回「本脚本旁边的 pw_layered」。2026-11-26 实证：公司包/jt_exec/pw_layered 是 11-16 搬迁留下的旧副本
    （无 ledger、无 specs），按「旁边」找会让硬⑤在本机永远走「未找到，软跳过」——检查形同虚设。"""
    cands = []
    try:
        cfg = None
        env = os.environ.get('AGENT_COMPANY_JSON')
        if env and os.path.isfile(env):
            cfg = io.open(env, encoding='utf-8').read()
        if cfg is None:
            here = os.path.dirname(os.path.abspath(__file__))            # …/公司包/jt_exec
            for p in (os.path.join(here, 'agent-company.json'),           # …/公司包/jt_exec/
                      os.path.join(os.path.dirname(here), 'agent-company.json')):   # …/公司包/
                if os.path.isfile(p):
                    cfg = io.open(p, encoding='utf-8').read()
                    break
        if cfg:
            paths = (json.loads(cfg).get('paths') or {})
            if paths.get('接口执行根'):
                cands.append(paths['接口执行根'])
            if paths.get('执行工具'):
                cands.append(os.path.join(paths['执行工具'], 'pw_layered'))
    except Exception:
        pass
    cands.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pw_layered'))
    for c in cands:
        if c and os.path.isfile(os.path.join(c, 'ledger.jsonl')):
            return c
    return cands[-1]


_RUNNER_ROOT = _runner_root()
_runner_ledger = os.path.join(_RUNNER_ROOT, 'ledger.jsonl')
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

# ===== 硬校验⑥：失败用例专项报告（交付物 §20.10，2026-11-17 立）=====
# 生效时刻后收尾的轮次且账本含终态 FAIL → 失败用例报告必须存在（报告路径中缀替换派生），
# 且账本每个终态 FAIL 的 TC 编号须在报告中有对应卡片；无 FAIL／生效前历史轮＝豁免（历史不补录）。
print('\n=== 失败用例报告校验（硬⑥ · 交付物§20.10）===')
fr_ok = True
RULE6_TS = '2026-11-17 20:00'   # 硬⑥生效时刻（本节落码时点，北京时间）
_norm_max = (max_ts or '')[:16].replace('T', ' ')
if not tot['FAIL']:
    print('  ✓ 本轮无终态 FAIL——失败用例报告不适用（无失败条不出，§20.10 第2条）')
elif _norm_max < RULE6_TS:
    print(f'  ⚠ 生效前历史轮（账本最新落账 {_norm_max} < {RULE6_TS}；依据＝{_TS_SRC}）→ 豁免不追溯（历史不补录）')
elif '_测试报告_' not in os.path.basename(report):
    print('  ⚠ 报告命名不含「_测试报告_」中缀，失败报告路径不可派生 → 软跳过（人工核对§20.10）')
    fr_ok = True
else:
    fr_path = report.replace('_测试报告_', '_失败用例报告_')
    if not os.path.exists(fr_path):
        fr_ok = False
        print(f'  ✗ 缺失败用例报告：{os.path.basename(fr_path)}（本轮终态 FAIL {tot["FAIL"]} 条，§20.10 要求生成，禁收尾）')
    else:
        fr_md = io.open(fr_path, encoding='utf-8').read()
        _missing = []
        for x in seen.values():
            if x['status'] != 'FAIL':
                continue
            if not re.search(re.escape(str(x['id'])) + r'(?!\d)', fr_md):   # TC 编号完整词匹配，防前缀误中
                _missing.append(str(x['id']))
        if _missing:
            fr_ok = False
            shown = ', '.join(_missing[:5]) + ('…' if len(_missing) > 5 else '')
            print(f'  ✗ 失败用例报告缺 {len(_missing)}/{tot["FAIL"]} 个终态 FAIL 条目卡片：{shown}')
        else:
            print(f'  ✓ {os.path.basename(fr_path)} 存在，账本终态 FAIL {tot["FAIL"]} 条逐条对上（§20.10）')

# ===== 硬校验⑦：质疑门节存在性（执行质疑标准 v1.3 · executor §6.95，2026-11-18 用户拍板"要"）=====
# 生效时刻后收尾的轮次：报告必须含「双账本/质疑门」结论节（execution-challenger 输出），
# 或含「质疑门降级」声明（§6.95 纯复测单条增量轮豁免口径）；两者皆无 = 没过判定质疑门 = 禁收尾。
# 生效前历史轮豁免不追溯（老报告无此节=合规）；本查只验节存在性，节内容质量由 qc/质疑方人工补位（机检是下限）。
print('\n=== 质疑门节校验（硬⑦ · 执行质疑标准 v1.3）===')
gate_ok = True
RULE7_TS = '2026-11-18 02:00'   # 硬⑦生效时刻（本节落码时点，北京时间）
if _norm_max < RULE7_TS:
    print(f'  ⚠ 生效前历史轮（账本最新落账 {_norm_max} < {RULE7_TS}；依据＝{_TS_SRC}）→ 豁免不追溯（历史不补录）')
elif re.search(r'双账本|质疑门', md):
    _ptr = '质疑门' in (m3.group(0) if m3 else '') or '双账本' in (m3.group(0) if m3 else '')
    print(f'  ✓ 报告含质疑门/双账本结论节（判定口径以双账本为准，禁只报执行面原始过/败数）' + ('' if _ptr else '；建议「最后收尾」声明行附节指针'))
elif re.search(r'质疑门降级', md):
    print('  ✓ 含「质疑门降级」声明（§6.95 纯复测单条增量轮豁免口径）——降级轮仍须抽验+机检记录在案')
else:
    gate_ok = False
    print('  ✗ 报告缺质疑门/双账本结论节，也无「质疑门降级」声明——判定质疑门未过（executor §6.95：无指针=未收官，禁收尾）')

# ===== 硬⑦v2：轮次级覆盖校验（2026-11-20 立 · 质疑门补账整改②）=====
# 报告级存在性只防"从未有过"；本查防"出过一次就永久绿"（对客 R21 后 R22~R34 漏门实证）：
# 生效时刻（2026-11-18 02:00）后收尾的每个轮次块，须满足其一：
#   a) 轮次块内含质疑门/双账本标记；
#   b) 轮次块内含「质疑门降级」且同块含「抽验」——降级口收紧：自报降级必须附抽验记录（整轮降级须用户拍板字样）；
#   c) 报告存在「质疑门覆盖：」声明行（补账复核节声明覆盖的历史轮次，如 R1~R3）覆盖该轮号。
if _norm_max >= RULE7_TS:
    print('\n=== 质疑门轮次级覆盖校验（硬⑦v2 · 2026-11-20）===')
    _blocks = re.split(r'(?m)^###\s+', md)
    _cov_txt = ' '.join(re.findall(r'质疑门覆盖[：:][^\n]{0,120}', md))
    _cov_nums = set(int(x) for x in re.findall(r'第\s*(\d+)\s*轮', _cov_txt))
    for _a, _b in re.findall(r'(\d+)\s*[~～]\s*(\d+)', _cov_txt):
        _cov_nums.update(range(int(_a), int(_b) + 1))
    _uncovered = []
    for _blk in _blocks:
        _hm = re.match(r'第\s*(\d+)\s*轮[^\n]*?（[^）]*?(\d{4}-\d{2}-\d{2})', _blk)
        if not _hm:
            continue
        _rn, _rd = int(_hm.group(1)), _hm.group(2)
        if _rd < '2026-11-18' or _rn in _cov_nums:
            continue
        if re.search(r'双账本|质疑门', _blk):
            continue
        if '质疑门降级' in _blk and '抽验' in _blk:
            continue
        _uncovered.append(f'第{_rn}轮({_rd})')
    if _uncovered:
        gate_ok = False
        print('  ✗ 生效后轮次未过质疑门且无覆盖声明/合规降级：' + '、'.join(_uncovered) + '——禁收尾（补账=写质疑门覆盖声明行或逐轮出双账本节）')
    else:
        print('  ✓ 生效后全部轮次均有质疑门覆盖（块内标记/覆盖声明/附抽验降级三者其一）')

# ===== 硬⑦v3：质疑门内容质量机检（gate_quality · 2026-11-20 立·整改②延伸）=====
# 机检三查=计数自洽（分项和==合计==账本数）/逐条表对量（复核结果文件在案且 TC 行数≥分项和，抽查冒充全量=红）
# /改判对账（声明改判数==账本复评改判行数）。质量下限机器拦；上限仍靠 qc/独立复核抽位。
if _norm_max >= RULE7_TS and re.search(r'双账本|质疑门', md):
    import subprocess as _sp
    _gq = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gate_quality.py')
    if os.path.exists(_gq):
        _rc = _sp.run([sys.executable, _gq, ledger, report]).returncode
        if _rc != 0:
            gate_ok = False
            print('  ✗ ⑦v3 gate_quality 红——质疑门内容质量不达下限（详见上方 gate_quality 输出）')

# ===== 硬⑧：PASS 即沉淀（分层执行模式 · 执行操作细则§十四，2026-11-09 用户拍板；2026-11-26 第三次违反后立机检）=====
# 规则原文：「PASS 即沉淀……AI 跑通的新条目收尾时同步沉淀 spec」。此前只有技能文案、无机器检查——
# 2026-11-11（仓内 B/C/D 轮）、2026-11-26（快运税务信息维护 45 条）均靠用户发现。本查：账本每个终态 PASS 的 TC，
# 须满足其一：a) 脚本池有以它为 id 的 spec；b) 报告「沉淀清单」的不沉淀表里列了它并写了原因（禁入清单/人工步骤/不可稳定复现等）。
# 生效时刻后收尾的轮次适用；生效前历史轮不追溯。找不到脚本池（非本机运行位）＝黄提示不拦。
print('\n=== 沉淀校验（硬⑧ · 分层执行模式 PASS 即沉淀）===')
dep_ok = True
RULE8_TS = '2026-11-27 00:00'   # 硬⑧生效时刻（本节落码时点，北京时间）
if _norm_max < RULE8_TS:
    print(f'  ⚠ 生效前历史轮（账本最新落账 {_norm_max} < {RULE8_TS}；依据＝{_TS_SRC}）→ 豁免不追溯')
else:
    _spec_dir = os.path.join(_RUNNER_ROOT, 'specs')
    _api_dir = os.path.join(_RUNNER_ROOT, 'api_specs')
    _have = set()
    _scanned = False
    if os.path.isdir(_spec_dir):
        _scanned = True
        _probe = "const fs=require('fs');const d=process.argv[1];const out=[];for(const f of fs.readdirSync(d)){if(!/^spec_.*\\.js$/.test(f))continue;try{const s=require(require('path').join(d,f));if(s&&s.id)out.push(String(s.id))}catch(_){}}console.log(JSON.stringify(out))"
        try:
            import subprocess as _sp2
            _ro = _sp2.run(['node', '-e', _probe, _spec_dir], capture_output=True, timeout=120)
            _have.update(json.loads(_ro.stdout.decode('utf-8', 'replace').strip() or '[]'))
        except Exception as _e:
            print(f'  ⚠ 脚本池扫描失败（{_e.__class__.__name__}）→ 按未沉淀处理')
    if os.path.isdir(_api_dir):
        _scanned = True
        for _root, _dirs, _files in os.walk(_api_dir):
            for _f in _files:
                if _f.endswith('.api.spec.js'):
                    _m = re.match(r'^(TC-[A-Za-z0-9\-_]+?)(?:\.api\.spec)?\.api\.spec\.js$', _f)
                    if _m:
                        _have.add(_m.group(1))
                    else:
                        try:
                            _txt = io.open(os.path.join(_root, _f), encoding='utf-8').read()
                            _m2 = re.search(r"id\s*:\s*['\"](TC-[A-Za-z0-9\-_]+)['\"]", _txt)
                            if _m2:
                                _have.add(_m2.group(1))
                        except Exception:
                            pass
    if not _scanned:
        print('  ⚠ 未找到脚本池（pw_layered/specs、api_specs）——非本机运行位，软跳过（人工核对沉淀清单）')
    else:
        # 报告里的不沉淀表：交付物规范 A3 沉淀清单。行格式「| TC-X | 不沉淀 | 原因 |」，或含「不沉淀」的表格行里带 TC 编号
        _nd_txt = '\n'.join(l for l in md.split('\n') if '不沉淀' in l and l.strip().startswith('|'))
        _nd = {}
        for _l in _nd_txt.split('\n'):
            for _t in re.findall(r'TC-[A-Za-z0-9\-_]+', _l):
                _cells = [c.strip() for c in _l.strip().strip('|').split('|')]
                _why = next((c for c in _cells if c and not c.startswith('TC-') and c not in ('不沉淀', '---', ':---', '不沉淀（AI 通道）')), '')
                _nd[_t] = _why
        _passed = sorted(str(x['id']) for x in seen.values() if x['status'] == 'PASS')
        _no_spec = [t for t in _passed if t not in _have]
        _undoc = [t for t in _no_spec if not _nd.get(t)]
        _doc_bad = [t for t in _no_spec if t in _nd and not _nd[t]]
        if _doc_bad:
            dep_ok = False
            print(f'  ✗ {len(_doc_bad)} 条列入了不沉淀表但没写原因：{", ".join(_doc_bad[:8])}')
        if _undoc:
            dep_ok = False
            shown = ', '.join(_undoc[:8]) + ('…' if len(_undoc) > 8 else '')
            print(f'  ✗ {len(_undoc)}/{len(_passed)} 条 PASS 未沉淀、也不在不沉淀表：{shown}——禁收尾（细则§十四：PASS 即沉淀；不沉淀须在 A3 沉淀清单逐条写明原因）')
        if dep_ok:
            print(f'  ✓ PASS {len(_passed)} 条：已沉淀 {len(_passed) - len(_no_spec)} 条、不沉淀并写明原因 {len(_no_spec)} 条')

print(f'''
=== 判定 ===
数字 {"✓ 一致" if ok_all else "✗ 不一致，禁收尾"} ／ 结构 {"✓ 合规" if struct_ok else "✗ 缺节/缺字段，禁收尾"} ／ 收尾状态 {"✓ 已同步" if close_ok else "✗ 报告落后，禁开新轮"} ／ 回写台账 {"✓ 清零" if not wb_pending_n else "✗ 残留，禁收尾"} ／ 批次行 {"✓ 配对齐" if batch_ok else "✗ 漏配对/漏记，禁收尾"} ／ 失败报告 {"✓ 对上/不适用" if fr_ok else "✗ 缺失/缺卡片，禁收尾"} ／ 质疑门 {"✓ 在案/豁免" if gate_ok else "✗ 缺结论节，禁收尾"} ／ 沉淀 {"✓ 齐/豁免" if dep_ok else "✗ PASS 未沉淀，禁收尾"}

=== 收尾三件事检查（usecase-executor §6.9；开工第 0 步=先跑本脚本验上轮）===
1. 账本落定 ✓（{N} 条）
2. 报告三段式更新 → 1.1~1.4 总进度（每轮必更）＋新增轮次块 12 字段（只增）＋头部「最后收尾」声明行＋附A 余项清单（每轮必更）＋失败用例专项报告（有 FAIL 时，§20.10）＋质疑门/双账本结论节（生效后新轮，硬⑦）＋A3 沉淀清单（不沉淀的逐条写原因，硬⑧）→ 更新后重跑本脚本须全绿
3. memory 更新（关键拍板/新教训）
''')
if not (ok_all and struct_ok and close_ok and batch_ok and fr_ok and gate_ok and dep_ok): sys.exit(1)
if wb_pending_n: sys.exit(1)
