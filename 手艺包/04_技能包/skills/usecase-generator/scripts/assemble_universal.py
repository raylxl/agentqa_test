# -*- coding: utf-8 -*-
r"""
通用用例册组装+结构门禁脚本（assemble_universal）
=================================================
定位：组装与结构校验引擎；业务差异只通过配置对象和公司 profile 注入。

支持能力：
- 多段 TC 编号识别、按文件与前缀分组的断号校验；
- 跨文件章节计数回填、结构统计与失效条目统计；
- 可配置的章节注入、重排、附录、治理清单与历史豁免；
- 通用占位符替换，兼容单/双花括号。

用法（由调用方提供配置）：
    from assemble_universal import AssembleConfig, run
    cfg = AssembleConfig()
    cfg.BASE = '<chapter_directory>'
    cfg.FILES = ['01_section.md', '02_section.md']
    cfg.OUT = '<output_directory>/<product>_<menu>_cases_vN.md'
    cfg.TITLE = '<product>_<menu> cases'
    cfg.LETTERS = 'ABC'
    run(cfg)
"""
import re, os, sys, io, json, tempfile, subprocess

def _find_company_cfg():
    """公司配置定位（2026-11-14 目录化重构·改名免疫）：环境变量 AGENT_COMPANY_JSON →
    技能根上级的 agent-company.json（旧部署位）→ 同级各目录内同名文件（同级配置目录，改名不影响）。"""
    env = os.environ.get("AGENT_COMPANY_JSON")
    if env and os.path.isfile(env):
        return env
    base = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..")
    cand = os.path.join(base, "agent-company.json")
    if os.path.isfile(cand):
        return cand
    parent = os.path.join(base, "..")
    try:
        for name in sorted(os.listdir(parent)):
            c = os.path.join(parent, name, "agent-company.json")
            if os.path.isfile(c):
                return c
    except OSError:
        pass
    return cand


def _load_exempt_dirs():
    """公司白名单外置（2026-11-13 参数化）：agent-company.json（workspace .zcode/ 或环境变量定位）「白名单.历史分章目录」；
    缺文件=空集。等价性由部署侧快照校验守护。"""
    cfgp = _find_company_cfg()
    dirs_ = []
    try:
        with io.open(cfgp, "r", encoding="utf-8") as f:
            dirs_ = json.load(f).get("白名单", {}).get("历史分章目录", [])
    except (OSError, ValueError):
        pass
    return frozenset(dirs_)

HISTORICAL_EXEMPT_DIRS = _load_exempt_dirs()

class AssembleConfig:
    """各需求组装配置——只设值不改逻辑"""
    def __init__(self):
        self.BASE = ''           # 分章目录绝对路径
        self.FILES = []          # 分章文件名列表（按序）
        self.OUT = ''            # 成册输出路径
        self.TITLE = ''          # 成册标题
        self.INTRO_FILE = ''     # 导语文件名（分章目录下）
        self.PRE_FILE = ''       # PRE文件名
        self.FOOTER_FILE = ''    # 修改记录文件名
        self.LETTERS = 'FMN'     # 拍板编号首字母集
        self.SYS_FILE = ''       # SYS章文件名（有增量模块时设）
        self.DEF_FILE = ''       # DEF章文件名
        self.IMP_FILE = ''       # IMP章文件名
        self.HEADER_EXTRA = ''   # 需求自定义头部文本（需求一句话/依据链/体例/断言口径等）
        self.STRATEGY_CARD = ''  # 治理策略卡路径（兼容视图）
        self.GOVERNANCE_MANIFEST = ''  # 治理 JSON 正本；新需求必填，历史豁免可不填
        self.HISTORICAL_EXEMPT = False
        # ---- v1.1 扩展 ----
        self.INJECT_HEADS = {}       # {文件名: 注入文本}——置于该文件内容之前
        self.SECTION_SORT = False    # 小节全局重排模式（### N.M 跨文件按号排序重组）
        self.CHAPTER_TITLES = {}     # {int 章号: 章标题}（SECTION_SORT 模式）
        self.CHAPTER_NOTES = {}      # {int 章号: 章首注记文本}
        self.CHAPTER_NOTE_FILES = {} # {int 章号: 章首注记文件名}
        self.APPENDIX_FILES = []     # 组装于正文之后的整文件
        self.CHECK_GAPS = True       # 断号门禁开关

CN = {"〇": "0", "一": "1", "二": "2", "三": "3", "四": "4", "五": "5", "六": "6",
      "七": "7", "八": "8", "九": "9", "十": "10", "十一": "11", "十二": "12",
      "十三": "13", "十四": "14", "十五": "15", "十六": "16", "十七": "17",
      "十八": "18", "十九": "19", "二十": "20"}

tc_re  = re.compile(r'^####\s+(TC[-_](?:[A-Za-z0-9]+[-_])*[A-Za-z0-9]*?\d+)')
pri_re = re.compile(r'（(P[0-3])）')
HEADING_RE = re.compile(r'^(#{2,3})\s+([0-9〇一二三四五六七八九十]+(?:\.[0-9]+)*)')
CNT_RE = re.compile(r'（(?:\?\?|\d+)\s*条）')

def _norm_num(tok):
    """章/节编号归一：中文数字→阿拉伯（一→1、十四→14、二.1→2.1）"""
    parts = tok.split('.')
    if parts[0] in CN:
        parts[0] = CN[parts[0]]
    return '.'.join(parts)

def _mk_pollute(letters):
    if not letters:
        return None
    # 边界不含下划线：TEST_P1_Q06 等"下划线连接的造数标识符"不算拍板编号污染
    return re.compile(r'(?:^|[^A-Za-z0-9_])[' + letters + r']\d{1,3}(?![0-9A-Za-z_])')

def _find_gov_script():
    """定位治理清单校验器 governance_manifest.py：先找本文件所在目录（含联接解析后的物理位），
    找不到再找兄弟技能 usecase-pipeline/scripts（校验器实际住那里）。
    2026-11-25 修：此前只找本目录，新需求（非豁免）一开治理前置门即报"结构校验失败"，存量册走豁免未暴露。"""
    for base in (os.path.dirname(os.path.abspath(__file__)), os.path.dirname(os.path.realpath(__file__))):
        for cand in (os.path.join(base, 'governance_manifest.py'),
                     os.path.normpath(os.path.join(base, '..', '..', 'usecase-pipeline', 'scripts', 'governance_manifest.py'))):
            if os.path.isfile(cand):
                return cand
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'governance_manifest.py')

def _read(path):
    return io.open(path, encoding='utf-8').read()

def _write(path, content):
    io.open(path, 'w', encoding='utf-8').write(content)

def _read_or(path, default=''):
    if path and os.path.exists(path):
        return _read(path)
    return default

def _sub_placeholders(text, grand):
    """{TOTAL}/{P0}/{P1}/{P2}/{P3} 与双花括号占位替换（老头部模板兼容）"""
    for key, val in (('{{TOTAL}}', grand[0]), ('{{P0}}', grand[1]), ('{{P1}}', grand[2]), ('{{P2}}', grand[3]), ('{{P3}}', grand[4]),
                     ('{TOTAL}', grand[0]), ('{P0}', grand[1]), ('{P1}', grand[2]), ('{P2}', grand[3]), ('{P3}', grand[4])):
        text = text.replace(key, str(val))
    return text

def _p_dist(seg_lines):
    p = [0, 0, 0, 0]
    for l in seg_lines:
        if tc_re.match(l):
            pm = pri_re.search(l)
            if pm:  # 非法/缺失优先级已由阶段一扫描记录违例（收集不中断，与 pipeline 版一致），此处跳过
                p[int(pm.group(1)[1])] += 1
    return p

def _fill_counts(lines):
    """全册层级式条数回填。
    章级（##）范围=到下一个 ## 行（任意 ## 均为章边界，含 "## 附A/## B.1" 等非数字章头）；
    节级（###）范围=到下一个非子号标题（14.1 含 14.1.x）。
    计数为 0 的标题不回填。返回 (新行列表, [(章标题, 条数, (P0,P1,P2,P3)), ...])"""
    heads = []
    for i, l in enumerate(lines):
        m = HEADING_RE.match(l)
        if m:
            heads.append((i, len(m.group(1)), _norm_num(m.group(2))))
    out = list(lines)

    lv2 = [(i, l) for i, l in enumerate(lines) if l.startswith('## ')]
    chap_ranges = []
    for k, (i, _l) in enumerate(lv2):
        end = lv2[k + 1][0] if k + 1 < len(lv2) else len(lines)
        chap_ranges.append((i, end))

    # 节级回填
    for k, h in enumerate(heads):
        if h[1] != 3:
            continue
        i, num = h[0], h[2]
        if not CNT_RE.search(out[i]):
            continue
        end = len(lines)
        for h2 in heads[k + 1:]:
            if not (h2[2] == num or h2[2].startswith(num + '.')):
                end = h2[0]
                break
        cnt = sum(1 for l in out[i:end] if tc_re.match(l))
        if cnt > 0:
            out[i] = CNT_RE.sub('（%d 条）' % cnt, out[i], count=1)

    # 章级回填 + 章统计
    stats = []
    for (i, end) in chap_ranges:
        seg = out[i:end]
        cnt = sum(1 for l in seg if tc_re.match(l))
        if CNT_RE.search(out[i]) and cnt > 0:
            out[i] = CNT_RE.sub('（%d 条）' % cnt, out[i], count=1)
        title = re.sub(r'^##\s+', '', out[i])
        title = CNT_RE.sub('', title).strip()
        stats.append((title, cnt, tuple(_p_dist(seg))))
    return out, stats

def _skey(sid, issues, fn):
    m = re.match(r'^(〇|\d+)\.(\d+)$', sid)
    if not m:
        issues.append('[结构] %s 无法解析小节号 %s' % (fn, sid))
        return (999, 999)
    a = 0 if m.group(1) == '〇' else int(m.group(1))
    return (a, int(m.group(2)))

def run(cfg):
    assert cfg.BASE and cfg.FILES and cfg.OUT, 'BASE/FILES/OUT 必填'
    fm_re = _mk_pollute(cfg.LETTERS)

    if cfg.HISTORICAL_EXEMPT and os.path.basename(os.path.normpath(cfg.BASE)) not in HISTORICAL_EXEMPT_DIRS:
        print('!! HISTORICAL_EXEMPT 仅允许登记的存量历史册目录使用: %s' % cfg.BASE); sys.exit(2)

    # 治理前置门：新需求以治理 JSON 为唯一正本；策略卡仅兼容视图。
    strategy_path = ''
    if cfg.STRATEGY_CARD:
        strategy_path = cfg.STRATEGY_CARD if os.path.isabs(cfg.STRATEGY_CARD) else os.path.join(cfg.BASE, cfg.STRATEGY_CARD)
        if not os.path.exists(strategy_path):
            print('!! 策略卡不存在: %s（治理前置门硬失败）' % strategy_path); sys.exit(2)
    manifest_path = ''
    if cfg.GOVERNANCE_MANIFEST:
        manifest_path = cfg.GOVERNANCE_MANIFEST if os.path.isabs(cfg.GOVERNANCE_MANIFEST) else os.path.join(cfg.BASE, cfg.GOVERNANCE_MANIFEST)
        if not os.path.exists(manifest_path):
            print('!! 治理 JSON 不存在: %s（治理前置门硬失败）' % manifest_path); sys.exit(2)
        gov_script = _find_gov_script()
        # 初始校验只验证清单结构；候选成册组装后还会再做一次 risk→TC 对账
        cmd = [sys.executable, gov_script, '--manifest', manifest_path]
        if cfg.HISTORICAL_EXEMPT: cmd += ['--historical-exempt']
        gov_rc = subprocess.run(cmd).returncode
        if gov_rc != 0:
            print('!! 治理 JSON 结构校验失败（治理前置门硬失败）'); sys.exit(gov_rc)
    elif not cfg.HISTORICAL_EXEMPT:
        print('!! 新需求缺少 GOVERNANCE_MANIFEST（治理 JSON 正本；历史册请显式 HISTORICAL_EXEMPT=True）'); sys.exit(2)

    report = {"chapters": [], "dups": [], "gaps": [], "bad_blocks": [], "pollution": [], "structure": []}
    all_ids = []
    collide = {}
    grand = [0, 0, 0, 0, 0]
    file_lines = {}

    # ========== 阶段一：逐文件门禁扫描 ==========
    for fn in cfg.FILES:
        path = os.path.join(cfg.BASE, fn)
        lines = [l for l in _read(path).split('\n') if not l.startswith('# ')]  # 去文件级 # 标题
        if fn in cfg.INJECT_HEADS:
            lines = cfg.INJECT_HEADS[fn].split('\n') + lines
        file_lines[fn] = lines

        ids = []
        pris = []
        for l in lines:
            m = tc_re.match(l)
            if m:
                ids.append(m.group(1))
                pm = pri_re.search(l)
                if pm:
                    pris.append(pm.group(1))
                else:
                    report["bad_blocks"].append("%s:%s 用例标题缺失或非法优先级（允许 P0/P1/P2/P3）: %s" % (fn, m.group(1), l[:80]))
        all_ids += ids
        p = [pris.count('P0'), pris.count('P1'), pris.count('P2'), pris.count('P3')]

        seen = set()
        for i in ids:
            if i in seen:
                report["dups"].append("%s:%s" % (fn, i))
            seen.add(i)
        if cfg.CHECK_GAPS:
            # 复合编号只按结尾数字部分检测，如 TC-GEN-EDIT02 → 前缀 TC-GEN-EDIT、序号 02
            byp = {}
            for i in ids:
                mm = re.match(r'^(.*?)(\d+)$', i)
                if mm and mm.group(1):
                    byp.setdefault(mm.group(1), []).append(int(mm.group(2)))
            for pre, nums in sorted(byp.items()):
                s = sorted(nums)
                if s != list(range(s[0], s[-1] + 1)):
                    report["gaps"].append("%s: TC-%s %d~%d 有断号" % (fn, pre, s[0], s[-1]))

        # 五列表 state 机校验（row5 横排 + 竖排两列双格式；2026-11-11 补竖排分支与 pipeline 版对齐——竖排分册全册误报修复）
        LAB5 = ('前置条件', '操作步骤', '预期结果', '判断依据', '测试方法')
        cur = None; state = 0; prev_table = False; vlabels = set()
        def flush(c, s, ln, vlab):
            if c and s != 3 and vlab != set(LAB5):
                miss = sorted(set(LAB5) - vlab)
                report["bad_blocks"].append("%s:%d:%s 表结构不完整(state=%d%s)" % (fn, ln, c, s, ('，竖排缺%s' % miss) if miss else ''))
        for idx, l in enumerate(lines, 1):
            m = tc_re.match(l)
            if m:
                flush(cur, state, idx, vlabels); cur = m.group(1); state = 0; prev_table = False; vlabels = set(); continue
            if cur is None:
                if fm_re and re.match(r'^#{2,3}\s', l):
                    hits = fm_re.findall(l)
                    if hits:
                        report["pollution"].append("%s:%d 标题含编号%s: %s" % (fn, idx, hits, l[:60]))
                continue
            s = l.strip()
            if state == 0 and s.startswith('| 前置条件 | 操作步骤 | 预期结果 | 判断依据 | 测试方法 |'):
                state = 1; prev_table = True; continue
            if state == 0 and s == '| 列 | 内容 |':
                prev_table = True; continue  # 竖排表头
            if state == 1 and re.match(r'^\|\s*-{3,}\s*\|', s):
                state = 2; prev_table = True; continue
            if state == 0 and prev_table and re.match(r'^\|\s*-{3,}\s*\|\s*$', s):
                continue  # 竖排分隔行（| --- |）
            if state == 2 and s.startswith('|'):
                cells = s.split('|')[1:-1]
                if len(cells) != 5:
                    report["bad_blocks"].append("%s:%d:%s 数据行列数=%d≠5" % (fn, idx, cur, len(cells)))
                else:
                    if not ('（源：' in cells[3] or '（源:' in cells[3]):
                        report["bad_blocks"].append("%s:%d:%s 判断依据无源引用" % (fn, idx, cur))
                    if fm_re:
                        for ci, cell in enumerate(cells[:3]):
                            hits = fm_re.findall(cell)
                            if hits:
                                report["pollution"].append("%s:%d %s 第%d格含编号%s" % (fn, idx, cur, ci + 1, hits))
                state = 3; prev_table = True; continue
            if state == 0 and s.startswith('|'):
                cells = s.split('|')[1:-1]
                if len(cells) >= 2 and cells[0].strip() in LAB5:
                    lab = cells[0].strip(); val = '|'.join(cells[1:]).strip()
                    vlabels.add(lab)
                    if lab == '判断依据' and '（源：' not in val and '（源:' not in val:
                        report["bad_blocks"].append("%s:%d:%s 判断依据无源引用(竖排)" % (fn, idx, cur))
                    if lab in ('前置条件', '操作步骤', '预期结果') and fm_re and fm_re.search(val):
                        report["pollution"].append("%s:%d %s %s含编号(竖排): %s" % (fn, idx, cur, lab, val[:50]))
                    continue
            if state == 3:
                if s.startswith('|') and prev_table:
                    report["bad_blocks"].append("%s:%d:%s 表后多余表格行(紧邻)" % (fn, idx, cur))
                    prev_table = True; continue
                if s.startswith('|') and not prev_table:
                    # TC 块之后隔空行的独立表格（对照表/速查表）：放行并结束本块监听
                    cur = None; state = 0; prev_table = False; continue
                prev_table = False; continue
        flush(cur, state, len(lines), vlabels)

        # 跨章撞号
        for pat in (r'DO\d{2}\d{4}', r'WD\d{2}\d{4}'):
            for tok in set(re.findall(pat, '\n'.join(lines))):
                collide.setdefault(tok, set()).add(fn)

        grand[0] += len(ids); grand[1] += p[0]; grand[2] += p[1]; grand[3] += p[2]; grand[4] += p[3]

    # ========== 阶段二：组装 ==========
    if not cfg.SECTION_SORT:
        parts = ['\n'.join(file_lines[fn]).rstrip() for fn in cfg.FILES]
        blines = '\n\n---\n\n'.join(parts).split('\n')
        blines, ch_stats = _fill_counts(blines)
        body = '\n'.join(blines)
    else:
        # ---- 小节全局重排模式 ----
        sections = []; ledgers = []
        for fn in cfg.FILES:
            lines = file_lines[fn]
            lidx = None
            for i, l in enumerate(lines):
                if l.startswith('## 附'):
                    lidx = i; break
            if lidx is None:
                body_l, ledger = lines, []
            else:
                body_l, ledger = lines[:lidx], lines[lidx:]
            if ledger:
                ledgers.append((fn, ledger))
            cur = None
            for l in body_l:
                m = re.match(r'^### (\S+)\s+(.*)$', l)
                if m:
                    if cur:
                        sections.append(cur)
                    cur = {'sid': m.group(1), 'title': m.group(2), 'body': [], 'src': fn}
                elif cur is not None:
                    cur['body'].append(l)
                elif l.strip():
                    report["structure"].append('[结构] %s 小节外孤行: %s' % (fn, l[:40]))
            if cur:
                sections.append(cur)

        seen_sid = set()
        for s in sections:
            if s['sid'] in seen_sid:
                report["structure"].append('[结构] 小节号重复 %s（%s）' % (s['sid'], s['src']))
            seen_sid.add(s['sid'])
        sections.sort(key=lambda s: _skey(s['sid'], report["structure"], s['src']))
        for s in sections:
            s['key'] = _skey(s['sid'], report["structure"], s['src'])
            s['n'] = sum(1 for l in s['body'] if tc_re.match(l))

        ch_counts = {}; ch_p = {}
        for s in sections:
            a = s['key'][0]
            ch_counts[a] = ch_counts.get(a, 0) + s['n']
            pd = _p_dist(s['body'])
            if a not in ch_p:
                ch_p[a] = [0, 0, 0, 0]
            for i in range(4):
                ch_p[a][i] += pd[i]

        def chap_head(a):
            t = cfg.CHAPTER_TITLES[a]
            n = ch_counts.get(a, 0)
            return '## %s%s' % (t, ('（%d条）' % n) if n > 0 else '')

        def chap_notes(a):
            outp = []
            if a in cfg.CHAPTER_NOTES and cfg.CHAPTER_NOTES[a]:
                outp.append(cfg.CHAPTER_NOTES[a].rstrip())
            if a in cfg.CHAPTER_NOTE_FILES and cfg.CHAPTER_NOTE_FILES[a]:
                outp.append(_read(os.path.join(cfg.BASE, cfg.CHAPTER_NOTE_FILES[a])).rstrip())
            return outp

        blocks = []
        cur_ch = None
        for s in sections:
            a = s['key'][0]
            if a != cur_ch:
                if cur_ch is not None:
                    for gap_a in range(cur_ch + 1, a):
                        if gap_a in cfg.CHAPTER_TITLES:   # 有章名但无小节的章（如 六、审核驳回（不适用））
                            blocks.append(chap_head(gap_a) + '\n\n' + '\n\n'.join(chap_notes(gap_a)) + ('\n\n' if chap_notes(gap_a) else ''))
                blocks.append(chap_head(a) + '\n\n' + '\n\n'.join(chap_notes(a)) + ('\n\n' if chap_notes(a) else ''))
                cur_ch = a
            title = re.sub(r'（\d+条）', '（%d条）' % s['n'], s['title'], count=1)
            blocks.append('### %s %s\n\n%s' % (s['sid'], title, '\n'.join(s['body']).rstrip('\n')))

        body = '\n\n'.join(blocks)
        # 附录A：造数台账汇总（从各分章文件尾部的 ## 附 块汇聚）
        if ledgers:
            ap = ['---\n\n## 附录A：造数台账汇总（分章，防撞对账用）\n']
            for fn, led in ledgers:
                name = fn[:-3] if fn.endswith('.md') else fn
                inner = list(led)
                if inner and inner[0].startswith('## '):
                    inner[0] = '### ' + name + ' 台账'
                ap.append('\n'.join(inner).rstrip('\n'))
            body = body + '\n\n' + '\n\n'.join(ap)
        for af in cfg.APPENDIX_FILES:
            body = body + '\n\n---\n\n' + _read(os.path.join(cfg.BASE, af)).rstrip()
        ch_stats = [(cfg.CHAPTER_TITLES[a], ch_counts.get(a, 0), tuple(ch_p.get(a, [0, 0, 0, 0])))
                    for a in sorted(set(list(ch_counts.keys()) + [k for k in cfg.CHAPTER_TITLES if k <= max(ch_counts.keys())]))]

    # 全册 TC 全局重号门禁（不能只按分章文件内 seen）
    from collections import Counter
    global_dups = [tc for tc, n in Counter(all_ids).items() if n > 1]
    if global_dups:
        report["dups"].extend('[全局] %s 出现 %d 次' % (tc, all_ids.count(tc)) for tc in global_dups)

    # ========== 阶段三：统计摘要与头部 ==========
    total_tc = grand[0]
    invalid_count = 0
    for fn in cfg.FILES:
        for l in file_lines[fn]:
            if l.startswith('#### ') and '〔已失效' in l:
                invalid_count += 1
    sys_count = sum(1 for l in file_lines.get(cfg.SYS_FILE, []) if tc_re.match(l)) if cfg.SYS_FILE else 0
    def_count = sum(1 for l in file_lines.get(cfg.DEF_FILE, []) if tc_re.match(l)) if cfg.DEF_FILE else 0
    imp_count = sum(1 for l in file_lines.get(cfg.IMP_FILE, []) if tc_re.match(l)) if cfg.IMP_FILE else 0
    orig_count = total_tc - sys_count - def_count - imp_count
    effective = total_tc - invalid_count

    if sys_count or def_count or imp_count:
        summary_block = f"""
> **用例册统计摘要**（截至本次组装）
>
> | 维度 | 数量 | 说明 |
> | --- | --- | --- |
> | **用例总数** | **{total_tc}** | P0={grand[1]}/P1={grand[2]}/P2={grand[3]}/P3={grand[4]} |
> | 原始设计用例（一~十六章） | {orig_count} | 首次生成+首轮修复后版本 |
> | ↳ 已失效 | {invalid_count} | 预期被系统实现推翻，标题标〔已失效〕，场景由增量模块承接 |
> | ↳ 有效可执行 | {orig_count - invalid_count} | 含首轮已执行+待执行 |
> | 新增·系统与用例不符（SYS） | {sys_count} | 十七章：系统实现与原用例预期不一致的修正用例（挂老用例编号） |
> | 新增·缺陷数据场景（DEF） | {def_count} | 十八章：缺陷单引入的新增测试场景 |
> | 新增·实现行为固化（IMP） | {imp_count} | 十九章：需求未定义、系统已实现的合理行为固化 |
> | **有效可执行合计** | **{effective}** | = 总数 − 已失效；执行遇〔已失效〕跳过、以 SYS/DEF/IMP 对应条执行 |
"""
    else:
        summary_block = f"""
> **用例册统计摘要**{'（截至本次组装）' if invalid_count else '（初始版，尚未执行）'}
>
> | 维度 | 数量 | 说明 |
> | --- | --- | --- |
> | **用例总数** | **{total_tc}** | P0={grand[1]}/P1={grand[2]}/P2={grand[3]}/P3={grand[4]} |
> | 原始设计用例 | {orig_count} | 本次生成版本 |
> | ↳ 已失效 | {invalid_count} | {'尚未执行，无失效' if invalid_count == 0 else '标题标〔已失效〕，执行跳过（历史执行轮回写）'} |
> | ↳ 有效可执行 | {orig_count - invalid_count} | {'全部待执行' if invalid_count == 0 else '= 总数 − 已失效'} |
"""

    stat_rows = "\n".join("| %s | %d | %d | %d | %d | %d |" % (t, n, a, b, c, d) for t, n, (a, b, c, d) in ch_stats)
    total_line = f"| **合计** | **{grand[0]}** | **{grand[1]}** | **{grand[2]}** | **{grand[3]}** | **{grand[4]}** |"

    LEAD = _read_or(os.path.join(cfg.BASE, cfg.INTRO_FILE) if cfg.INTRO_FILE else '', '')
    if LEAD:
        LEAD = re.sub(r'^(# .*(?:\n|$))+', '', LEAD)  # 去文件级 # 标题行（成册 H1 由 TITLE 统一出具）
    PRE = _read_or(os.path.join(cfg.BASE, cfg.PRE_FILE) if cfg.PRE_FILE else '', '')
    FCONTENT = _read_or(os.path.join(cfg.BASE, cfg.FOOTER_FILE) if cfg.FOOTER_FILE else '', '')
    HEADER_EXTRA = _sub_placeholders(cfg.HEADER_EXTRA, grand)
    LEAD = _sub_placeholders(LEAD, grand)
    FCONTENT = _sub_placeholders(FCONTENT, grand)
    FOOTER = '\n---\n\n' + FCONTENT + '\n' if (cfg.FOOTER_FILE and not cfg.SECTION_SORT) else \
             ('\n\n' + FCONTENT.rstrip() + '\n' if (cfg.FOOTER_FILE and cfg.SECTION_SORT) else '')

    gov_line = ''
    if manifest_path:
        gov_line = '> **治理正本**：治理 JSON=%s' % manifest_path
        if strategy_path:
            gov_line += '；策略卡派生视图=%s' % strategy_path
    elif strategy_path:
        gov_line = '> **治理**：策略卡=%s（历史兼容视图）' % strategy_path
    HEADER = f"""# {cfg.TITLE}

{HEADER_EXTRA}

{gov_line}

{LEAD}

{summary_block}

| 章 | 条数 | P0 | P1 | P2 | P3 |
| --- | --- | --- | --- | --- | --- |
{stat_rows}
{total_line}
"""

    final = HEADER + ('\n\n' + PRE if PRE else '') + '\n\n' + body + FOOTER

    ok = not (report["dups"] or report["gaps"] or report["bad_blocks"] or report["pollution"] or report["structure"] or
              {k: v for k, v in collide.items() if len(v) > 1})
    if not ok:
        print('!! 组装存在门禁违例，拒绝写入正式输出')
        sys.exit(1)
    if manifest_path:
        gov_script = _find_gov_script()
        fd, gov_tmp = tempfile.mkstemp(prefix='governance_candidate_', suffix='.md')
        os.close(fd)
        try:
            io.open(gov_tmp, 'w', encoding='utf-8').write(final)
            gov_cmd = [sys.executable, gov_script, '--manifest', manifest_path, '--md', gov_tmp]
            if cfg.HISTORICAL_EXEMPT: gov_cmd.append('--historical-exempt')
            if subprocess.run(gov_cmd).returncode != 0:
                print('!! 治理 JSON 与候选成册对账失败，拒绝写入正式输出')
                sys.exit(1)
        finally:
            try: os.remove(gov_tmp)
            except OSError: pass
    tmp_out = cfg.OUT + '.tmp'
    _write(tmp_out, final)
    os.replace(tmp_out, cfg.OUT)
    out = cfg.OUT

    # 输出报告
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    print("=== 组装 ===")
    print(f"输出: {out}")
    print(f"总条数={grand[0]}  P0={grand[1]}  P1={grand[2]}  P2={grand[3]}  P3={grand[4]}")
    for t, n, p in ch_stats:
        print(f"  {t}: {n} 条 (P0={p[0]} P1={p[1]} P2={p[2]} P3={p[3]})")
    if cfg.INJECT_HEADS:
        print(f"注入合成章头: {list(cfg.INJECT_HEADS.keys())}")
    if cfg.SECTION_SORT:
        print("模式: 小节全局重排(SECTION_SORT)")
    if not cfg.CHECK_GAPS:
        print("断号门禁: 关闭(历史编号有意留空)")
    print(f"\n=== 结构门禁 ===")
    print(f"重号: {report['dups'] or '无'}")
    print(f"断号: {report['gaps'] or '无'}")
    print(f"五列表/源引用缺失: {len(report['bad_blocks'])} 处 {report['bad_blocks'][:10] or ''}")
    print(f"正文/标题拍板编号污染: {len(report['pollution'])} 处")
    for x in report["pollution"][:20]: print("  ", x)
    if report["structure"]:
        print(f"结构问题: {len(report['structure'])} 处")
        for x in report["structure"][:20]: print("  ", x)
    cross = {k: sorted(v) for k, v in collide.items() if len(v) > 1}
    print(f"跨章订单/运单撞号: {cross or '无'}")
    print(f"\n=== 统计摘要 ===")
    print(f"总数={total_tc} 原始={orig_count} 失效={invalid_count} SYS={sys_count} DEF={def_count} IMP={imp_count} 有效={effective}")
    print(f"\n===> {'全绿' if ok else '存在违例，修复分章后重跑'}")
    if not cfg.STRATEGY_CARD:
        print('⚠ 治理前置门：未配置策略卡（新需求按《测试策略与风险治理标准》必附；存量册豁免）')
