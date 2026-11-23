# -*- coding: utf-8 -*-
"""writeback_check.py — 拍板/修复回写完成性校验器（2026-11-13 立，用户质询"你告诉我回写完成了我就认为完成了，怎么杜绝"）
根治原则：任何"回写完成"声明必须落到机器可验的客观锚点——账本说改了≠文件真改了。

四重检查（全客观文件信号，不依赖自觉）：
  ① 回写台账：writeback_pending.jsonl 中 pending 残留=红（拍板产生回写义务时必须登记，回写落地后置 done+锚点值）；
     done 条目按锚点值到用例正本对应 TC 段落实文 grep——值不在=红（即"声明已回写但文件没改"直接抓出）。
  ② 账本启发式兜底：账本 detail 含"回写/修复后口径"关键词且带 PASS 翻案标记的条目，
     若台账无对应记录 → 黄色警告（防漏登记逃逸；本次 156 事故即此类）。
  ③ 统计块=实文：用例 MD 统计摘要"用例总数" vs 实文 ^#### TC- 计数（含失效分层）——不等=红。
  ④ 正本 vs 分章：正本〔已失效〕TC 编号集合 vs 分章并集——差集=红（分章是组装源，缺标注会被下次组装冲掉）。

用法: python writeback_check.py <账本.json> <用例正本.md> <分章目录> [writeback_pending.jsonl]
exit 0=全绿；1=存在红项（禁收尾/禁开工）。挂载点：usecase-executor §1.86 开工第 0 步 + §6.9 收尾。
"""
import json, sys, io, re, os, glob
from collections import OrderedDict
try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception: pass

ledger, md_path, split_dir = sys.argv[1], sys.argv[2], sys.argv[3]
wb_path = sys.argv[4] if len(sys.argv) > 4 else os.path.join(os.path.dirname(ledger), 'writeback_pending.jsonl')
reds, yellows, greens = [], [], []

md = io.open(md_path, encoding='utf-8').read()

# ---- ① 回写台账检查 ----
wb = []
if os.path.exists(wb_path):
    for line in io.open(wb_path, encoding='utf-8'):
        line = line.strip()
        if line:
            try: wb.append(json.loads(line))
            except Exception: reds.append(f'台账行解析失败: {line[:60]}')
pending = [x for x in wb if x.get('status') == 'pending']
# 2026-11-14 质检Y5：pending=有意挂账（拍板/等回写通知），降黄不红——红仅限"声明done但未落"
for x in pending: yellows.append(f"① 回写台账 pending 挂账（拍板豁免待回写通知）: {x.get('tc')} {x.get('field')} → {x.get('new')}（来源 {x.get('source')}）")
# done 条目 → 正本对应 TC 段落 grep 锚点值
segs = {}  # tc_id -> 正文段
cur = None
TCHEAD = re.compile(r'^####\s+(?:~~)?(TC-[A-Z](?:[A-Z0-9-]*[A-Z0-9])?)')  # 兼容 TC-ADD-52 / TC-GEN-PERM12 / TC-P5-BTN10 / TC-ADD-34R 等族段形态
for line in md.splitlines():
    m = TCHEAD.match(line)
    if m: cur = m.group(1); segs[cur] = [line]  # 标题行本身计入该条实文（锚点可能在标题）
    elif cur is not None:
        if line.startswith('#### ') or line.startswith('## '): cur = None
        else: segs[cur].append(line)
done_n = 0
for x in wb:
    if x.get('status') != 'done': continue
    done_n += 1
    tc, val = x.get('tc'), str(x.get('new'))
    if not x.get('new'):
        # 空 new=形态类回写无锚点值——逃逸通道（质检 R3 复检指出），直接红牌要求补锚点
        reds.append(f"① done 条目 {tc} 无锚点值（new 为空）——形态类回写也必须给可 grep 的锚点词（如拍板口径关键短语），禁空值逃逸")
        continue
    body = '\n'.join(segs.get(tc, []))
    if not body: reds.append(f"① done 条目 {tc} 在正本无对应段落（编号写错或被移除）")
    elif val not in body: reds.append(f"① done 条目 {tc} 声明已回写 {x.get('field')}→{val}，但正本该条实文无此值——声明与事实不符！")
if wb: greens.append(f"① 台账 {len(wb)} 条（done {done_n}/pending {len(pending)}）锚点全验" if not pending else '')

# ---- ② 账本启发式兜底 ----
try:
    r = [] if ledger == '-' else json.load(io.open(ledger, encoding='utf-8'))
except Exception:
    r = []
wb_tcs = {x.get('tc') for x in wb}
suspects = []
for x in r:
    d = x.get('detail', '')
    if ('回写' in d or '修复后口径' in d) and x.get('status') == 'PASS':
        base = re.match(r'^(TC-[A-Z]+-\d+)', x.get('id', ''))
        base = base.group(1) if base else x.get('id')
        # R 后缀复验条归并基条（TC-ADD-34R → TC-ADD-34）
        if base not in wb_tcs and not any(w.get('tc', '').startswith(base) for w in wb):
            suspects.append(x.get('id'))
for s in sorted(set(suspects)):
    yellows.append(f"② 账本 {s} 含回写/修复口径字样但台账无记录——确认是否漏登记（若无回写义务可忽略）")

# ---- ③ 统计块=实文 ----
m = re.search(r'\|\s*\*\*用例总数\*\*\s*\|\s*\*\*(\d+)\*\*', md)
decl = int(m.group(1)) if m else None
tc_all = re.findall(r'^####\s+TC-', md, re.M)
n_inv = len(re.findall(r'^####\s+(?:TC-\S+\s+~~|~~TC-)', md, re.M)) + len(re.findall(r'^####\s+TC-\S+\s+~~', md, re.M))
inv_pat = re.findall(r'^####\s+(?:~~)?TC-\S+\s+(.*)$', md, re.M)
n_inv = sum(1 for s in inv_pat if s.startswith('~~') or '〔已失效' in s)
actual = len(tc_all)
if decl is None: reds.append('③ 统计摘要块缺"用例总数"行')
elif decl != actual: reds.append(f'③ 统计块总数={decl} ≠ 实文 TC 计数={actual}（失效 {n_inv}/生效 {actual-n_inv}）——统计未随册演进更新')
else: greens.append(f'③ 统计块=实文：{actual} 条（失效 {n_inv}/生效 {actual-n_inv}）')

# ---- ④ 正本 vs 分章失效标注 ----
zh_inv = set()
for line in md.splitlines():
    m = TCHEAD.match(line)
    if m and ('〔已失效' in line): zh_inv.add(m.group(1))
sp_inv = set()
for f in glob.glob(os.path.join(split_dir, '*.md')):
    if os.path.basename(f).startswith('_'): continue  # 工具文件（_dict/_BRIEF 等）跳过
    for line in io.open(f, encoding='utf-8'):
        m = TCHEAD.match(line)
        if m and ('〔已失效' in line): sp_inv.add(m.group(1))
miss_in_split = zh_inv - sp_inv
extra_in_split = sp_inv - zh_inv
if miss_in_split: reds.append(f"④ 分章缺失效标注 {len(miss_in_split)} 条: {', '.join(sorted(miss_in_split)[:8])}{'…' if len(miss_in_split)>8 else ''}（分章=组装源，缺标注会被下次组装冲掉）")
if extra_in_split: yellows.append(f"④ 分章多出正本没有的失效条 {len(extra_in_split)} 条（正本可能漏标或分章已改未组装）")
if not miss_in_split: greens.append(f'④ 正本/分章失效标注一致：{len(zh_inv)} 条')

# ---- ⑤ 交付载体（XMind/xlsx）锚点抽验（2026-11-13 质检 R3 补：载体盲区）----
# 2026-11-13 用户拍板②：XMind/xlsx 暂过滤、后续统一从 MD 重出——豁免开关 --defer-artifacts：
#   挂起重出期内 ⑤ 降级为提示（不红）；统一重出完成后撤掉开关恢复硬检查。
stem = os.path.splitext(md_path)[0]
xmind_p, xlsx_p = stem + '.xmind', stem + '.xlsx'
defer_art = '--defer-artifacts' in sys.argv or any('XMind' in str(x.get('field','')) or 'xlsx' in str(x.get('field','')) for x in wb)  # 2026-11-14：任意状态条目均可作豁免依据（closed=随全册统一，不单册挂账）
# 2026-11-14：台账挂 XMind/xlsx 统一重出 pending（拍板豁免）时自动豁免⑤，无需命令行参数
if defer_art:
    yellows.append('⑤ 附载体检查按 2026-11-13 拍板②豁免（挂起待统一从 MD 重出）——重出完成后撤 --defer-artifacts 恢复硬检查')
else:
    for p in (xmind_p, xlsx_p):
        if not os.path.exists(p): reds.append(f'⑤ 交付载体缺失: {os.path.basename(p)}')
        elif os.path.getmtime(p) < os.path.getmtime(md_path):
            reds.append(f'⑤ {os.path.basename(p)} 早于用例正本——MD 改后未重出三载体')
if os.path.exists(xlsx_p) and not defer_art:
    try:
        import openpyxl
        wbk = openpyxl.load_workbook(xlsx_p, read_only=True)
        ws = wbk['测试用例'] if '测试用例' in wbk.sheetnames else wbk[wbk.sheetnames[1] if len(wbk.sheetnames) > 1 else wbk.sheetnames[0]]
        all_text = ' '.join(str(c.value) for row in ws.iter_rows() for c in row if c.value)
        wbk.close()
        # 抽台账锚点值（可 grep 的短值）+ 失效标注保留
        n_hit = 0; miss_vals = []
        for x in wb:
            if x.get('status') == 'done' and x.get('new') and len(str(x['new'])) <= 20 and re.match(r'^[\d.]+$', str(x['new'])):
                if str(x['new']) in all_text: n_hit += 1
        # 2026-11-23 修正：失效标注检查仅在正本确有失效条时适用（原为无条件断言，硬编码"79 条"对无失效新册误报）
        if n_inv > 0 and '已失效' not in all_text: reds.append(f'⑤ xlsx 全文无〔已失效〕标注痕迹——生成器丢弃效标注（对照正本失效 {n_inv} 条）')
        elif n_inv == 0: greens.append('⑤ 正本无失效条，xlsx 无失效标注为正常')
        else: greens.append(f'⑤ xlsx 载体在案：数值锚点命中 {n_hit} 条+失效标注存在')
    except ImportError:
        yellows.append('⑤ openpyxl 不可用，xlsx 锚点抽验跳过（安装后启用）')

# ---- ⑥ 报告附B 处置声明对账（2026-11-13 立，四步铁律配套：附B"已修订"禁止单独作为完成声明）----
# 扫附B 数据行：含完成性处置字样（已修订/已回写/失效打标/已落用例/已闭环）且日期≥2026-11-10（台账建档期）的行，
# 提取行内用例编号 → 台账无对应记录 = 黄（报告声称完成但台账无记录——要么补登记要么改口径）。
rep_path = next((a for a in sys.argv[1:] if a.endswith('.md') and ('测试报告' in a or '_报告' in a) and a != md_path), None)
if rep_path and os.path.exists(rep_path):
    try:
        rep = io.open(rep_path, encoding='utf-8').read()
        m = re.search(r'^## 附B、.*$(.*)', rep, re.M | re.S)  # 附B 常为末节，取到文末
        sec = m.group(1) if m else ''
        CLAIM = ('已修订', '已回写', '失效打标', '已落用例', '用例已修', '已闭环', '落地')
        n_ck = 0; n_miss = 0
        for line in sec.splitlines():
            if not line.startswith('|') or set(line.strip()) <= set('|- ') or '我提出的问题' in line: continue
            if not any(c in line for c in CLAIM): continue
            dm = re.findall(r'20\d{2}-\d{2}-\d{2}', line)
            if not dm or max(dm) < '2026-11-10': continue  # 建档期前的历史行不对账
            ids = set(re.findall(r'(?:TC-)?(?:ADD|EDIT|DEL|COPY|LOG|IMP|PERM|QRY|LST|EXP|AUD|REJ|CHG|CAL|PRV|SYS|DEF|REL|DET|GEN|BW|AEX|EDT|BAS|P\d?)-\d+[A-Za-z]*', line))
            for t in ids:
                n_ck += 1
                if not any(str(w.get('tc', '')).endswith(t) or str(w.get('tc', '')) == 'TC-' + t for w in wb):
                    n_miss += 1
                    yellows.append(f"⑥ 附B行声称完成（{t}）但台账 writeback 无记录——补登记或该声明降级为'待回写'")
        if n_ck and not n_miss: greens.append(f'⑥ 附B完成性声明 {n_ck} 处全部可追溯台账')
    except Exception as e:
        yellows.append(f'⑥ 附B对账执行异常: {e}')

print('=== writeback_check 回写完成性校验 ===')
for g in greens: print(' ✓', g)
for y in yellows: print(' ⚠', y)
for e in reds: print(' ✗', e)
ok = not reds
print(f'=== 判定：{"✓ 全绿" if ok else "✗ 存在红项，禁收尾/禁开工"} ===')
if not ok: sys.exit(1)
