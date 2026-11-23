# -*- coding: utf-8 -*-
"""gate_scan.py — 质疑门开工巡检闸（2026-11-20 立 · 质疑门补账整改③）
原则：任何会话开工（executor 开批/orchestrator 调度/手写轮动账本前）先跑本脚本——
扫全部在途册的报告，凡生效时刻（2026-11-18 02:00）后收尾的轮次缺质疑门覆盖即红，
红=先补账再开工，禁带病开新轮。只认机器事实（报告轮次块/覆盖声明/降级声明），零依赖自觉。
用法：python gate_scan.py   （exit 0=全绿可开工；exit 1=有漏门轮，先补账）
"""
import io, os, re, sys, json, glob
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# 2026-11-23 Mac 真机修正：BASE 优先取 公司包/agent-company.json 的 paths.用例文件（跨机），
# 取不到回落原 Windows 硬编码（发起机行为不变）；BOOKS 仅作兜底登记，实际扫目录内全部 *_测试报告_*.md
# （根治"登记名失效"反复红：报告升版改名后登记表滞后）。
_BASE_DEFAULT = r'D:\ZCodetest\需求用例库\用例文件'
try:
    _cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'agent-company.json')
    _cfg = json.load(io.open(_cfg_path, encoding='utf-8'))
    BASE = _cfg.get('paths', {}).get('用例文件') or _BASE_DEFAULT
except Exception:
    BASE = _BASE_DEFAULT
BASE = os.path.normpath(BASE) if BASE != _BASE_DEFAULT else BASE
_BOOKS_DEFAULT = [
    '财务需求2026_云仓_云仓账单_11.30_测试报告_v2.md',
    '财务需求2026_云仓_存储账单_11.30_测试报告_v2.md',
    '财务需求2026_云仓_通用计费规则调整_11.30_测试报告_v2.md',
    '财务需求2026_云仓_平台价格_11.30_测试报告_v4.md',
    '财务需求2026_云仓_对客报价_11.30_测试报告_v2.md',
    '财务需求2026_云仓_仓内作业价格_11.30_测试报告_v3.md',
    '财务需求2026_云仓_客户特定结算规则配置_11.30_测试报告_v2.md',
    '财务需求2026_云仓_配送价格_11.30_测试报告_v2.md',
]
_discovered = sorted(os.path.basename(p) for p in glob.glob(os.path.join(BASE, '*_测试报告_v*.md')))
if _discovered:
    BOOKS = _discovered          # 目录实际在途册为准（含升版改名），登记表滞后不再误红
    print(f'[i] 扫描目录：{BASE}（自动发现 {len(BOOKS)} 份报告）')
else:
    BOOKS = _BOOKS_DEFAULT        # 目录无报告（或路径不可达）→ 按原登记表报缺
    print(f'[i] 扫描目录：{BASE}（未发现报告，按登记表 {len(BOOKS)} 项核对）')
RULE_TS = '2026-11-18'

bad = 0
for name in BOOKS:
    p = os.path.join(BASE, name)
    if not os.path.exists(p):
        print(f'⚠ 缺报告文件：{name}（登记名失效，修 BOOKS）'); bad += 1; continue
    md = io.open(p, encoding='utf-8').read()
    # 报告级⑦：须有质疑门/双账本节
    has_gate = bool(re.search(r'双账本|质疑门', md))
    blocks = re.split(r'(?m)^###\s+', md)
    cov = ' '.join(re.findall(r'质疑门覆盖[：:][^\n]{0,120}', md))
    cov_nums = set(int(x) for x in re.findall(r'第\s*(\d+)\s*轮', cov))
    for a, b in re.findall(r'(\d+)\s*[~～]\s*(\d+)', cov):
        cov_nums.update(range(int(a), int(b) + 1))
    uncovered, bad_dg, nodate = [], [], []
    for blk in blocks:
        hm = re.match(r'第\s*(\d+)\s*轮[^\n]*?（[^）]*?(\d{4}-\d{2}-\d{2})', blk)
        if not hm:
            hm2 = re.match(r'第\s*(\d+)\s*轮', blk)
            if hm2:
                nodate.append(f'第{hm2.group(1)}轮')
            continue
        rn, rd = int(hm.group(1)), hm.group(2)
        if rd < RULE_TS or rn in cov_nums:
            continue
        if re.search(r'双账本|质疑门', blk):
            if '质疑门降级' in blk and '抽验' not in blk:
                bad_dg.append(f'第{rn}轮(降级无抽验)')
            continue
        if '质疑门降级' in blk and '抽验' in blk:
            continue
        uncovered.append(f'第{rn}轮({rd})')
    if nodate:
        print(f'  ⚠ 无日期轮次（人工核对生效期）：{"、".join(nodate[:8])}')
    prob = (not has_gate) or uncovered or bad_dg
    tag = '✗' if prob else '✓'
    print(f'{tag} {name}' + ('' if not prob else '：'))
    if not has_gate:
        print('    报告无质疑门/双账本结论节'); bad += 1
    if uncovered:
        print('    漏门轮次：' + '、'.join(uncovered) + '——先补账（质疑门覆盖声明/逐轮双账本）再开工'); bad += len(uncovered)
    if bad_dg:
        print('    降级不合规：' + '、'.join(bad_dg) + '——降级须同块附抽验记录'); bad += len(bad_dg)

print('\n=== 在途锁状态（book_lock · 并发互踩防护）===')
import subprocess
try:
    subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'book_lock.py'), 'status'])
except Exception as e:
    print('  ⚠ 锁状态读取失败：', e)

print('\n=== 巡检判定 ===')
if bad:
    print(f'✗ {bad} 处漏门/不合规——禁开新轮，先补账（executor §0.8 开工第 0 步）')
    sys.exit(1)
print('✓ 全部在途册生效后轮次质疑门覆盖在案——可开工（锁状态见上：🟢在途册勿动）')
