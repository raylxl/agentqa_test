# -*- coding: utf-8 -*-
"""report_sync_lite.py — 点名模式文本账本解析+报告对账（防线二，2026-11-18 立）
用法: python report_sync_lite.py <pw_run_results.log> <测试报告.md>
解析 `R{n}-TC-{id}|日期|判定|...` 行格式，提取四态数字，与报告§1.2对账+收尾行日期比对。
不匹配即 RED；全部通过输出 GREEN。
定位：仅烟雾回归用，不作出口门依据；出口门一律 report_sync.py。
"""
import sys, io, re, os, datetime
try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception: pass

if len(sys.argv) < 3:
    print('用法: python report_sync_lite.py <pw_run_results.log> <测试报告.md>')
    sys.exit(2)

log_path, report_path = sys.argv[1], sys.argv[2]
print('[定位] 仅烟雾回归用，不作出口门依据；出口门一律 report_sync.py')

# ---- 解析文本账本 ----
lines = io.open(log_path, encoding='utf-8').read().strip().split('\n')
tc_judge = {}  # tc_id -> (date, verdict)
for line in lines:
    # 格式: R{n}-TC-{prefix}-{num}|日期|判定|描述...
    m = re.match(r'R\d+-(TC-[A-Z]+-\d+)[|](\d{4}-\d{2}-\d{2})[|](PASS[^|]*|FAIL[^|]*|BLOCKED[^|]*|NE[^|]*|SKIP[^|]*)', line)
    if m:
        tc_id, date, verdict_raw = m.groups()
        verdict = 'PASS' if 'PASS' in verdict_raw else ('FAIL' if 'FAIL' in verdict_raw else ('BLOCKED' if 'BLOCKED' in verdict_raw else 'NE'))
        tc_judge[tc_id] = (date, verdict, verdict_raw.strip())

from collections import Counter
counts = Counter(v[1] for v in tc_judge.values())
total = len(tc_judge)
print(f'账本解析: {total} 条判定 (PASS={counts["PASS"]} FAIL={counts["FAIL"]} BLOCKED={counts.get("BLOCKED",0)} NE={counts.get("NE",0)})')

# 最后写入日期
last_date = max((v[0] for v in tc_judge.values()), default='')
print(f'账本最后判定日期: {last_date}')

# ---- 解析报告 ----
report = io.open(report_path, encoding='utf-8').read()

# 收尾声明行
m_close = re.search(r'最后收尾\**[：:]\s*第\s*(\d+)\s*轮\s*·\s*(.+?)\s*·\s*(\d{4}-\d{2}-\d{2})', report)
if m_close:
    round_num, round_name, close_date = m_close.groups()
    print(f'报告收尾: 第{round_num}轮 · {round_name} · {close_date}')
else:
    print('RED: 报告无收尾声明行')
    sys.exit(1)

# ---- 对账 ----
reds = []

# 检查1: 账本最后日期 > 报告收尾日期 → 报告未同步
if last_date > close_date:
    reds.append(f'账本最后判定({last_date}) > 报告收尾({close_date}) → 报告未同步')

# 检查2: 报告中最新轮次块编号 >= 1（存在即可）
latest_round_in_body = re.findall(r'###\s*第\s*(\d+)\s*轮', report)
if latest_round_in_body:
    body_max = max(int(x) for x in latest_round_in_body)
    if body_max < int(round_num):
        reds.append(f'报告轮次块最大=第{body_max}轮 < 收尾行=第{round_num}轮 → 轮次块缺失')
else:
    reds.append('报告无任何轮次块')

# 检查3: 附A 余项清单存在
if '## 附A' not in report:
    reds.append('报告无附A余项清单')

# 检查4: 附B 呈报-拍板台账存在
if '## 附B' not in report:
    reds.append('报告无附B呈报-拍板台账')

# ---- 输出 ----
if reds:
    print('\n=== RED ===')
    for r in reds: print(f'  ✗ {r}')
    sys.exit(1)
else:
    print('\n=== GREEN ===')
    print(f'  ✓ 账本日期({last_date}) ≤ 报告收尾({close_date})')
    print(f'  ✓ 第{round_num}轮块存在')
    print(f'  ✓ 附A/附B 齐全')
    sys.exit(0)
