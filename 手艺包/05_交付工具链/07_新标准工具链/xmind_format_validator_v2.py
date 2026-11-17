# -*- coding: utf-8 -*-
"""
XMind 格式验证器 v2（§5.5 新标 · 2026-10-27）
配套 xmind_unified_generator_v2.py；自动识别新标/旧 WorkBuddy 两种结构。

用法: python xmind_format_validator_v2.py <xmind路径> [md路径]
  - 传 md 路径时额外做源对账：L1 精确匹配、L2 计数、L3 总数、TC 编号集合相等、L3 标题原文一致
  - 只验结构与格式；数据完整性用 compare_md_xmind_v2.py（差异=0 才交付）

判据（新标 §5.5）：
  L1 = 文件名主干+总条数直拼 | L2 = 章-节合并「…（N条）-节…」（全角计数，每节一节点）
  L3 = 「TC-XX-nn 标题（P0）」原文 | L4 = 恰 4 个子节点 前缀 优先级/前置条件/操作步骤/预期结果
  固定 4 层不超；无 TC 的空 L2 = 错误（附录/代入表类应不进 XMind）
XMind 8 兼容：必须 content.xml + META-INF/manifest.xml（meta.xml/metadata.xml 二选一）；
出现 content.json = 错误（XMind Zen 格式，XMind 8 打不开）。
"""
import io
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NOTE_TAIL = r'(?:【[^】]*】|〔[^〕]*〕|『[^』]*』)*'  # 2026-11-03 与生成器同步放宽（〔〕『』尾注也认）
PRIORITY_RX = r'P[0-3]'
NEW_CASE_RX = re.compile(r'^(TC-[A-Z0-9][A-Z0-9-]*)\s+.+?（' + PRIORITY_RX + r'）[\s~]*' + NOTE_TAIL + r'$')
OLD_CASE_RX = re.compile(r'^(TC_\d+)｜.+\s*\[' + PRIORITY_RX + r'\]')
NEW_L2_RX = re.compile(r'^.+（(\d+)条）')          # 全角计数（合并节点或纯章节点）
OLD_L2_RX = re.compile(r'^.+\((\d+)条\)$')          # 半角计数（旧格式模块节点）
NEW_L4_PREFIXES = ["优先级：", "前置条件：", "操作步骤：", "预期结果："]
VALID_PRIORITIES = frozenset({'P0', 'P1', 'P2', 'P3'})
OLD_L4_PREFIXES = ["优先级：", "前置条件：", "测试步骤：", "预期结果："]

results = []
def record(ok, level, msg):
    results.append((ok, level, msg))


def ln(tag):  # 命名空间无关：'{urn:…}topic' → 'topic'（v1 教训：裸字符串比较必误报）
    return tag.rsplit('}', 1)[-1] if '}' in tag else tag


def titles(topic):
    return [c.text or '' for c in topic if ln(c.tag) == 'title']


def attached(topic):
    for c in topic:
        if ln(c.tag) == 'children':
            for t in c:
                if ln(t.tag) == 'topics' and t.get('type') == 'attached':
                    return [x for x in t if ln(x.tag) == 'topic']
    return []


def parse_xmind(path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        record('content.json' not in names, 'error', 'zip 内出现 content.json（XMind Zen JSON，XMind 8 打不开）')
        record('content.xml' in names, 'error', '缺少 content.xml')
        record('META-INF/manifest.xml' in names, 'error', '缺少 META-INF/manifest.xml')
        meta_name = 'meta.xml' if 'meta.xml' in names else ('metadata.xml' if 'metadata.xml' in names else None)
        record(meta_name is not None, 'warn', '无 meta.xml/metadata.xml 成员（XMind 可打开，元信息缺失）')
        if 'content.xml' not in names:
            return None
        root = ET.fromstring(z.read('content.xml'))
    record(ln(root.tag) == 'xmap-content', 'error', 'content.xml 根元素非 xmap-content（XMind Zen 格式 XMind 8 打不开）')
    sheet = next((c for c in root if ln(c.tag) == 'sheet'), None)
    record(sheet is not None, 'error', '缺少 sheet 元素')
    if sheet is None:
        return None
    root_topic = next((c for c in sheet if ln(c.tag) == 'topic'), None)
    record(root_topic is not None, 'error', 'sheet 下缺少根 topic')
    return root_topic


def detect_mode(l3_titles):
    for t in l3_titles:
        if NEW_CASE_RX.match(t):
            return 'new'
        if OLD_CASE_RX.match(t):
            return 'old'
    return None


def parse_md_cases(md_path):
    """轻量解析：id → L3 标题原文，供对账。"""
    from xmind_unified_generator_v2 import NEW_CASE_RX as MD_NEW, OLD_CASE_RX as MD_OLD
    cases = {}
    for l in io.open(md_path, encoding='utf-8-sig').read().split('\n'):
        if l.startswith('#### '):
            m = MD_NEW.match(l) or MD_OLD.match(l)
            if m:
                cases[m.group(1)] = l[5:].strip()
    return cases


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    xp = sys.argv[1]
    mdp = sys.argv[2] if len(sys.argv) > 2 else None

    root_topic = parse_xmind(xp)
    if root_topic is None:
        for ok, level, msg in results:
            if not ok:
                print('[%s] %s' % (level.upper(), msg))
        sys.exit(1)

    l1 = (titles(root_topic) or [''])[0]
    l2_list = attached(root_topic)
    l3_all, empty_l2, l5_found = [], [], False
    for l2 in l2_list:
        l3s = attached(l2)
        if not l3s:
            empty_l2.append((titles(l2) or [''])[0])
        for l3 in l3s:
            l3_all.append((titles(l3) or [''])[0])
            for l4 in attached(l3):
                if attached(l4):
                    l5_found = True
    record(len(l1) > 0, 'error', 'L1 根标题为空')
    record(not l5_found, 'error', '存在第 5 层节点（固定 4 层不超，§5.5）')

    mode = detect_mode(l3_all)
    l4pfx = NEW_L4_PREFIXES if mode == 'new' else OLD_L4_PREFIXES
    record(mode is not None, 'error', '未能从 L3 识别出 TC 编号样式（TC-…（P0）或 TC_…｜…[P0]）')
    if mode == 'new':
        record(re.search(r'\d+$', l1) is not None, 'error', 'L1 未以总条数数字结尾（§5.4：文件名主干+总条数直拼）')
        record(not empty_l2, 'error', '存在 %d 个无 TC 的空 L2 节点（§5.5：附录/记录类不进 XMind），如: %s'
               % (len(empty_l2), (empty_l2[:2] or [''])[0][:50]))
        non_merged = [t for t in ((titles(l2) or [''])[0] for l2 in l2_list) if '）-' not in t]
        record(not non_merged, 'warn', 'L2 存在 %d 个非「章（N条）-节」合并格式节点（确有无节章可豁免）: %s'
               % (len(non_merged), (non_merged[:2] or [''])[0][:50]))
    else:
        record(not empty_l2, 'warn', '存在 %d 个空 L2 节点' % len(empty_l2))

    bad_cnt = []
    for l2 in l2_list:
        t = (titles(l2) or [''])[0]
        if mode == 'new':
            m = re.match(r'^.+（(\d+)条）', t)
        else:
            m = re.match(r'^.+\((\d+)条\)$', t)
        if not m:
            bad_cnt.append(t[:40])
        elif mode == 'old':
            # 新标合并节点的（N条）是章总条数，不与本节点子数直接对（有 md 时另行对账）
            if int(m.group(1)) != len(attached(l2)):
                bad_cnt.append('%s 声明%d 实际%d' % (t[:30], int(m.group(1)), len(attached(l2))))
    record(not bad_cnt, 'error', 'L2 计数格式问题 %d 处: %s' % (len(bad_cnt), bad_cnt[:3]))

    # L4 结构
    l4_bad, prio_bad = [], []
    for l2 in l2_list:
        for l3 in attached(l2):
            t3 = (titles(l3) or [''])[0]
            l4s = attached(l3)
            l4_titles = [(titles(l4) or [''])[0] for l4 in l4s]
            if len(l4_titles) != 4 or any(not s.startswith(p) for s, p in zip(l4_titles, l4pfx)):
                l4_bad.append(t3[:40])
            elif mode == 'new':
                pm = re.search(r'（(P[0-3])）\s*(?:【[^】]*】|〔[^〕]*〕|『[^』]*』)*\s*$', t3)
                pv = l4_titles[0][len('优先级：'):]
                if pv not in VALID_PRIORITIES:
                    prio_bad.append(t3[:40] + ' 非法优先级=' + pv)
                if not pm or pv != pm.group(1):
                    prio_bad.append(t3[:40])
    record(not l4_bad, 'error', 'L4 非恰 4 子节点/前缀不符 %d 处: %s' % (len(l4_bad), l4_bad[:3]))
    record(not prio_bad, 'error' if mode == 'new' else 'warn', 'L4 优先级与 L3 标题（P）不一致 %d 处: %s' % (len(prio_bad), prio_bad[:3]))

    # 源对账（可选）
    if mdp:
        md_cases = parse_md_cases(mdp)
        record(len(md_cases) > 0, 'error', 'MD 中未解析到用例')
        base = os.path.splitext(os.path.basename(mdp))[0]
        base = re.sub(r'_v\d+$', '', base)
        exp_l1 = base + str(len(md_cases))
        record(l1 == exp_l1, 'error', 'L1 不符：期望「%s」实际「%s」' % (exp_l1, l1))
        record(len(l3_all) == len(md_cases), 'error', 'L3 总数 %d ≠ MD 用例数 %d' % (len(l3_all), len(md_cases)))
        xm_ids = [re.match(r'^(TC[-_][A-Z0-9_\-]+)', t).group(1) if re.match(r'^(TC[-_][A-Z0-9_\-]+)', t) else t for t in l3_all]
        only_xm = set(xm_ids) - set(md_cases)
        only_md = set(md_cases) - set(xm_ids)
        record(not only_xm, 'error', 'XMind 多出编号 %d 个: %s' % (len(only_xm), sorted(only_xm)[:5]))
        record(not only_md, 'error', 'XMind 缺少编号 %d 个: %s' % (len(only_md), sorted(only_md)[:5]))
        xm_by_id = {}
        for t in l3_all:
            m = re.match(r'^(TC[-_][A-Z0-9_\-]+)', t)
            if m:
                xm_by_id[m.group(1)] = t
        _norm = lambda s: re.sub(r'~+', '', s).strip()
        mismatch = [i for i in md_cases if i in xm_by_id and _norm(md_cases[i]) != _norm(xm_by_id[i])]
        record(not mismatch, 'error', 'L3 标题与 MD #### 行原文不一致 %d 处: %s' % (len(mismatch), mismatch[:5]))

    errs = [m for ok, lv, m in results if not ok and lv == 'error']
    warns = [m for ok, lv, m in results if not ok and lv == 'warn']
    print('结构: L1=%s' % l1)
    print('     L2=%d 个（空节点 %d） L3=%d 条 L4=%d 个' % (len(l2_list), len(empty_l2), len(l3_all), len(l3_all) * 4))
    print('     模式=%s' % ('§5.5 新标' if mode == 'new' else ('旧 WorkBuddy' if mode == 'old' else '未知')))
    for m in errs:
        print('  [ERROR] %s' % m)
    for m in warns:
        print('  [WARN]  %s' % m)
    if not errs and not warns:
        print('验证通过（0 错误 0 警告）')
    elif not errs:
        print('验证通过（0 错误，%d 警告——建议清零）' % len(warns))
        sys.exit(0)
    else:
        print('验证失败：%d 错误' % len(errs))
        sys.exit(1)


if __name__ == '__main__':
    main()
