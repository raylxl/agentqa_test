# -*- coding: utf-8 -*-
r"""用例分章组装 + 结构门禁脚本（通用版）

用法：
  组装：python assemble.py --dir <chapter_dir> --out <output.md> --title "<title>"
  仅门禁：python assemble.py --dir <chapter_dir> --check-only

分章目录约定：文件名按序拼接；章节与用例块形态由通用用例标准定义。
公司/项目差异（历史白名单、治理清单、目录路径）由 agent-company.json 注入，
本脚本不携带任何具体公司或需求默认值。
"""
import re, os, glob, argparse, sys, io, json, tempfile, subprocess

def _find_company_cfg():
    """公司配置定位（2026-11-14 目录化重构·改名免疫）：环境变量 AGENT_COMPANY_JSON →
    技能根上级的 agent-company.json（旧部署位）→ 同级各目录内同名文件（公司包，目录改名不影响）。"""
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


def _load_company_whitelists():
    """公司白名单外置（2026-11-13 参数化）：workspace 公司包/agent-company.json 的「白名单」节。
    缺文件=空集（新部署无历史豁免）。等价性由 公司包/param_check.py 快照校验守护。"""
    cfgp = _find_company_cfg()
    ids, dirs_ = [], []
    try:
        with io.open(cfgp, "r", encoding="utf-8") as f:
            wl = json.load(f).get("白名单", {})
        ids = wl.get("历史豁免需求ID", [])
        dirs_ = wl.get("历史分章目录", [])
    except (OSError, ValueError):
        pass
    return frozenset(ids), frozenset(dirs_)

HISTORICAL_ALLOWLIST, HISTORICAL_ALLOWLIST_DIRS = _load_company_whitelists()

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

tc_re  = re.compile(r'^####\s+(TC[-_][A-Z0-9][A-Z0-9_-]*?)\s')
row7_re = re.compile(r'^\|\s*(TC[-_][A-Z0-9][A-Z0-9_-]*?)\s*\|')
row7_full = re.compile(r'^\|\s*(TC[-_][A-Z0-9][A-Z0-9_-]*?)\s*\|\s*(.*?)\s*\|\s*(P[0-3])\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$')
pri_re = re.compile(r'（(P[0-3])）')
cnt_re = re.compile(r'（(?:\?\?|\d+)\s*条）')
# 拍板编号启发式：单大写字母（可二连）+1~3位数字，前后非字母数字；可用 --letters 覆盖
def mk_pollute(letters):
    return re.compile(r'(?:^|[^A-Za-z0-9])[' + letters + r']\d{1,3}(?![0-9A-Za-z])')

def check_form_13_3(fn, lines):
    """修订形态门禁（执行反馈闭环标准 §13.3，2026-11-07 仓内 v2.1 事故立）：
    禁删正文留空位 / 禁标题挂修订标记 / 失效标识三要素齐备 / 承载条挂老用例编号。"""
    bad = []
    n = len(lines)
    base = os.path.basename(fn)
    for idx, l in enumerate(lines):
        if not l.startswith("#### "):
            continue
        if re.search(r"已删除|删除留位|编号不复用", l):
            bad.append(f"{base}:{idx+1} 空位标注（§13.3 禁删正文留空位，应恢复原文+失效标识）: {l[:50]}")
        if re.search(r"〔[^〕]*修订", l):
            bad.append(f"{base}:{idx+1} 标题含修订标记（修订注记只允许落判断依据格）: {l[:50]}")
        has_del = "~~" in l
        has_tag = "〔已失效〕" in l
        if has_del and not has_tag:
            bad.append(f"{base}:{idx+1} 划线缺〔已失效〕尾标: {l[:50]}")
        if has_tag and not has_del:
            bad.append(f"{base}:{idx+1} 失效尾标缺标题划线: {l[:50]}")
        if re.match(r"^#### TC-(SYS|DEF|CHG)-", l) and not has_tag:  # IMP 前缀与导入功能用例 TC-IMP 碰撞故不纳入（2026-11-07 平台/配送实测误报）
            blk = []
            for j in range(idx + 1, min(idx + 15, n)):
                if lines[j].startswith("#### "):
                    break
                blk.append(lines[j])
            blk_txt = chr(10).join(blk)
            if not re.search(r"老用例[：:]|原用例无对应", blk_txt):
                bad.append(f"{base}:{idx+1} 承载条判断依据未挂老用例编号/原用例无对应: {l[:50]}")
        if has_del and has_tag:
            blk = []
            for j in range(idx + 1, min(idx + 15, n)):
                if lines[j].startswith("#### "):
                    break
                blk.append(lines[j])
            blk_txt = chr(10).join(blk)
            if "判断依据" in blk_txt and "〔已失效·" not in blk_txt:
                bad.append(f"{base}:{idx+1} 失效条判断依据缺替代指针（〔已失效·执行跳过·替代：…〕）: {l[:50]}")
    return bad

def governance_check(candidate_text, manifest_path, historical_exempt):
    """Run governance validation against the exact assembled candidate text."""
    fd, gov_tmp = tempfile.mkstemp(prefix='governance_candidate_', suffix='.md')
    os.close(fd)
    try:
        io.open(gov_tmp, 'w', encoding='utf-8').write(candidate_text)
        gov_script = os.path.join(os.path.dirname(__file__), 'governance_manifest.py')
        cmd = [sys.executable, gov_script, '--manifest', manifest_path, '--md', gov_tmp]
        if historical_exempt:
            cmd.append('--historical-exempt')
        return subprocess.run(cmd).returncode
    finally:
        try: os.remove(gov_tmp)
        except OSError: pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True)
    ap.add_argument('--out')
    ap.add_argument('--title', default='测试用例')
    ap.add_argument('--intro-file')
    ap.add_argument('--pre-file')
    ap.add_argument('--footer-file')
    ap.add_argument('--check-only', action='store_true')
    ap.add_argument('--letters', default='FMN', help='拍板编号首字母集（按需求配置传入；不要把造数标识字母当作拍板前缀）')
    ap.add_argument('--strategy-card', dest='strategy_card', help='治理策略卡路径（兼容视图）')
    ap.add_argument('--governance-manifest', dest='governance_manifest', help='治理 JSON 正本（新需求必附）')
    ap.add_argument('--historical-exempt', action='store_true', help='存量历史三层豁免')
    a = ap.parse_args()
    fm_re = mk_pollute(a.letters)
    strategy = ''
    if a.strategy_card:
        strategy = a.strategy_card
        if not os.path.exists(strategy):
            print(f'!! 策略卡不存在: {strategy}（治理前置门硬失败）'); sys.exit(2)
    if a.historical_exempt:
        folder = os.path.basename(os.path.normpath(a.dir))
        if folder not in HISTORICAL_ALLOWLIST_DIRS:
            print(f'!! 历史豁免仅允许登记的存量八册目录使用: {folder}'); sys.exit(2)
    manifest = a.governance_manifest or ''
    if manifest:
        if not os.path.exists(manifest):
            print(f'!! 治理 JSON 不存在: {manifest}（治理前置门硬失败）'); sys.exit(2)
        try:
            gov_data = json.load(open(manifest, encoding='utf-8-sig'))
        except (OSError, ValueError) as exc:
            print(f'!! 治理 JSON 解析失败: {exc}'); sys.exit(2)
        rid = (gov_data.get('requirement') or {}).get('id', '')
        if a.historical_exempt and rid not in HISTORICAL_ALLOWLIST:
            print(f'!! 历史豁免仅对白名单册开放，需求ID未登记: {rid}'); sys.exit(2)
        if gov_data.get('policy', {}).get('historical_exempt'):
            print('!! manifest 不得自授 historical_exempt'); sys.exit(2)
        # Governance JSON is the machine-readable source of truth; the strategy card is a derived view.
    elif not a.historical_exempt:
        print('!! 新需求缺少 --governance-manifest（历史册请显式 --historical-exempt）'); sys.exit(2)

    files = sorted(f for f in glob.glob(os.path.join(a.dir, '*.md'))
                   if re.match(r'^\d{2}_', os.path.basename(f)))
    if not files:
        print(f'!! 目录无分章文件: {a.dir}'); sys.exit(2)

    rep = {"dups": [], "gaps": [], "bad": [], "poll": [], "form": []}
    chapters, all_ids, grand = [], [], [0, 0, 0, 0, 0]
    collide = {}

    for fn in files:
        lines = open(fn, encoding='utf-8').read().splitlines()
        rep["form"].extend(check_form_13_3(fn, lines))
        ids = [m.group(1) for l in lines if (m := tc_re.match(l))]
        row7s = [m.group(1) for l in lines if (m := row7_re.match(l))]
        all_ids += ids + row7s
        pris = [m.group(1) for l in lines if tc_re.match(l) for m in [pri_re.search(l)] if m]
        pris += [m.group(3) for l in lines if (m := row7_full.match(l))]
        for l in lines:
            if tc_re.match(l) and not pri_re.search(l):
                rep["bad"].append(f"{os.path.basename(fn)} 用例标题缺失或非法优先级（允许 P0/P1/P2/P3）: {l[:100]}")
            if row7_re.match(l) and not row7_full.match(l):
                rep["bad"].append(f"{os.path.basename(fn)} 七列用例优先级缺失或非法（允许 P0/P1/P2/P3）: {l[:100]}")
        p = [pris.count('P0'), pris.count('P1'), pris.count('P2'), pris.count('P3')]
        total = len(ids) + len(row7s)
        seen = set()
        for i in ids + row7s:
            (rep["dups"].append(f"{os.path.basename(fn)}:{i}") if i in seen else None); seen.add(i)
        # 断号：按"前缀"分组各查连续性；不连续=警告（空位保留系通用规范 §10.7 合法动作，不作失败）
        import collections as _c
        grp = _c.defaultdict(list)
        for i in ids + row7s:
            mm = re.match(r'^(.*?)(\d+)$', i)
            if mm and mm.group(1):
                grp[mm.group(1)].append(int(mm.group(2)))
        for pre, nums in grp.items():
            nums.sort()
            miss = set(range(nums[0], nums[-1] + 1)) - set(nums)
            if miss:
                rep["gaps"].append(f"{os.path.basename(fn)}:{pre} {nums[0]}~{nums[-1]} 空位/断号 {sorted(miss)[:6]}（警告，编号保留不重排为合法）")
        # 用例块校验（2026-10-31 双格式统一：[主]标题式竖排五列 / [等效]七列标准行）
        LAB5 = ('前置条件', '操作步骤', '预期结果', '判断依据', '测试方法')
        cur, got = None, set()
        def flush(ln):
            nonlocal cur, got
            if cur and got != set(LAB5):
                miss = set(LAB5) - got
                rep["bad"].append(f"{os.path.basename(fn)}:{ln}:{cur} 竖排缺字段 {sorted(miss)}")
            cur, got = None, set()
        tbl = 0  # 七列表状态：0 表外 1 已见表头 2 已见分隔行
        for idx, l in enumerate(lines, 1):
            m = tc_re.match(l)
            if m: flush(idx); cur = m.group(1); continue
            st = l.strip()
            if st.startswith('| 编号 |') and '用例名称' in st: tbl = 1; continue
            if tbl == 1 and re.match(r'^\|\s*-{3,}\s*\|', st): tbl = 2; continue
            m7 = row7_full.match(l) if tbl == 2 else None
            if m7:
                cells = st.split('|')[1:-1]
                if len(cells) != 7:
                    rep["bad"].append(f"{os.path.basename(fn)}:{idx}:{m7.group(1)} 七列行列数={len(cells)}≠7")
                    continue
                if '（源：' not in cells[6] and '（源:' not in cells[6]:
                    rep["bad"].append(f"{os.path.basename(fn)}:{idx}:{m7.group(1)} 判定依据无源引用")
                for ci in (3, 4, 5):
                    if fm_re.search(cells[ci]):
                        rep["poll"].append(f"{os.path.basename(fn)}:{idx} {m7.group(1)} 第{ci+1}格含编号: {cells[ci][:50]}")
                continue
            # 横排五列：与现行新标准 row5 同源，避免把合法横表误判为缺字段
            if cur is not None and tbl == 0 and st.startswith('|'):
                cells = st.split('|')[1:-1]
                if len(cells) == 5 and cells[0].strip() == '前置条件' and cells[1].strip() == '操作步骤' \
                        and cells[2].strip() == '预期结果' and cells[3].strip() == '判断依据' and cells[4].strip() == '测试方法':
                    tbl = 3
                    continue
            if cur is not None and tbl in (3, 4) and st.startswith('|'):
                cells = st.split('|')[1:-1]
                if tbl == 3 and cells and all(re.match(r'^-{3,}$', c.strip()) for c in cells):
                    tbl = 4
                    continue
                if tbl == 4 and len(cells) == 5:
                    if '（源：' not in cells[3] and '（源:' not in cells[3]:
                        rep["bad"].append(f"{os.path.basename(fn)}:{idx}:{cur} 判断依据无源引用")
                    for ci, cell in enumerate(cells[:3]):
                        if fm_re.search(cell):
                            rep["poll"].append(f"{os.path.basename(fn)}:{idx} {cur} 第{ci+1}格含编号: {cell[:50]}")
                    got.update(LAB5)
                    tbl = 0
                    continue
            if tbl == 2 and st.startswith('|') and st.strip('|').strip():
                tbl = 0  # 非数据行=表结束
            if cur is not None and st.startswith('|'):
                cells = st.split('|')[1:-1]
                if cells and cells[0].strip() in LAB5:
                    lab = cells[0].strip(); val = '|'.join(cells[1:]).strip()
                    got.add(lab)
                    if lab == '判断依据' and '（源：' not in val and '（源:' not in val:
                        rep["bad"].append(f"{os.path.basename(fn)}:{idx}:{cur} 判断依据无源引用")
                    if lab in ('前置条件', '操作步骤', '预期结果') and fm_re.search(val):
                        rep["poll"].append(f"{os.path.basename(fn)}:{idx} {cur} {lab}含编号: {val[:50]}")
                continue
            if cur is not None and (l.startswith('#') or (st and not st.startswith('|'))):
                flush(idx)
            if cur is None and re.match(r'^#{2,3}\s', l) and fm_re.search(l):
                rep["poll"].append(f"{os.path.basename(fn)}:{idx} 标题含编号: {l[:60]}")
        flush(len(lines))
        # 撞号收集
        for pat in (r'DO[A-Z]{2,5}\d{3,}', r'WD[A-Z]{2,5}\d{3,}'):
            for tok in set(re.findall(pat, '\n'.join(lines))):
                collide.setdefault(tok, set()).add(os.path.basename(fn))
        # 回填/规整计数并重组章节文本
        res, sec_head, buf = [], None, []
        def emit_section():
            nonlocal sec_head, buf
            if sec_head is not None:
                n_tc = sum(1 for l in buf if tc_re.match(l) or row7_re.match(l))  # 2026-11-11 修复：按 TC 数回填（原 len(buf) 行数会把竖排节头写成虚高条数）
                res.append(cnt_re.sub(f'（{n_tc} 条）', sec_head, count=1)); res.extend(buf)
            sec_head, buf = None, []
        for l in lines:
            if l.startswith('### '):
                emit_section(); sec_head, buf = l, []
            elif l.startswith('## '):
                # 章头去计数（族内正源：章头不带条数，L2 计数由 XMind 生成器拼接；节头保留（N 条）供 L2 取数）
                emit_section(); res.append(cnt_re.sub('', l, count=1).rstrip())
            elif sec_head is not None: buf.append(l)
            else: res.append(l)
        emit_section()
        chapters.append((lines[0].lstrip('# ').strip(), total, p, '\n'.join(res).rstrip()))
        grand[0] += total
        grand[1] += p[0]; grand[2] += p[1]; grand[3] += p[2]; grand[4] += p[3]

    dups2 = {k: sorted(v) for k, v in collide.items() if len(v) > 1}

    print('=== 结构门禁 ===')
    print(f'章数={len(files)} 总条数={grand[0]} P0={grand[1]} P1={grand[2]} P2={grand[3]} P3={grand[4]}')
    for t, n, p, _ in chapters: print(f'  {t}: {n} (P0={p[0]} P1={p[1]} P2={p[2]} P3={p[3]})')
    print(f'重号: {rep["dups"] or "无"}'); print(f'断号/空位(警告): {rep["gaps"] or "无"}')
    print(f'表结构/源引用: {len(rep["bad"])} 处 {rep["bad"][:8] or ""}')
    print(f'正文/标题编号污染: {len(rep["poll"])} 处'); [print('  ', x) for x in rep["poll"][:10]]
    print(f'修订形态(§13.3): {len(rep["form"])} 处'); [print('  ', x) for x in rep["form"][:10]]
    print(f'跨章订单/运单撞号: {dups2 or "无"}')

    # 全册 TC 全局重号门禁（跨文件）
    from collections import Counter
    global_dups = [tc for tc, n in Counter(all_ids).items() if n > 1]
    for tc in global_dups:
        rep["dups"].append(f"[全局] {tc} 出现 {all_ids.count(tc)} 次")
    ok = not (rep["dups"] or rep["bad"] or rep["poll"] or rep["form"] or dups2)  # gaps=空位警告不计失败（历史空号需另有白名单）
    print('===> ' + ('全绿' if ok else '存在违例，修复分章后重跑'))

    def rf(p):
        return open(p, encoding='utf-8-sig').read().rstrip() if p and os.path.exists(p) else ''

    if a.check_only or not a.out:
        if manifest and ok:
            preview_stats = "\n".join(f'| {t} | {n} | {p[0]} | {p[1]} | {p[2]} | {p[3]} |' for t, n, p, _ in chapters)
            preview_gov = f'\n> **治理**：策略卡={strategy}\n' if strategy else ''
            preview_header = f"# {a.title}\n\n{rf(a.intro_file)}{preview_gov}\n\n| 章 | 条数 | P0 | P1 | P2 | P3 |\n| --- | --- | --- | --- | --- | --- |\n{preview_stats}\n| **合计** | **{grand[0]}** | **{grand[1]}** | **{grand[2]}** | **{grand[3]}** | **{grand[4]}** |\n"
            preview_parts = [preview_header]
            if a.pre_file: preview_parts.append(rf(a.pre_file))
            preview_parts.append("\n\n---\n\n".join(c[3] for c in chapters))
            if a.footer_file: preview_parts.append(rf(a.footer_file))
            gov_rc = governance_check("\n\n".join(preview_parts) + "\n", manifest, a.historical_exempt)
            if gov_rc:
                sys.exit(gov_rc)
        sys.exit(0 if ok else 1)

    stats = "\n".join(f'| {t} | {n} | {p[0]} | {p[1]} | {p[2]} | {p[3]} |' for t, n, p, _ in chapters)
    gov = f'\n> **治理**：策略卡={strategy}（风险—覆盖深度矩阵与执行集见治理 JSON）\n' if strategy else ''
    header = f"# {a.title}\n\n{rf(a.intro_file)}{gov}\n\n| 章 | 条数 | P0 | P1 | P2 | P3 |\n| --- | --- | --- | --- | --- | --- |\n{stats}\n| **合计** | **{grand[0]}** | **{grand[1]}** | **{grand[2]}** | **{grand[3]}** | **{grand[4]}** |\n"
    parts = [header]
    if a.pre_file: parts.append(rf(a.pre_file))
    parts.append("\n\n---\n\n".join(c[3] for c in chapters))
    if a.footer_file: parts.append(rf(a.footer_file))
    if not ok:
        print('!! 组装存在门禁违例，拒绝写入正式输出（请先 --check-only 修复）')
        sys.exit(1)
    candidate = "\n\n".join(parts) + "\n"
    if manifest:
        gov_script = os.path.join(os.path.dirname(__file__), 'governance_manifest.py')
        fd, gov_tmp = tempfile.mkstemp(prefix='governance_candidate_', suffix='.md')
        os.close(fd)
        try:
            io.open(gov_tmp, 'w', encoding='utf-8').write(candidate)
            gov_cmd = [sys.executable, gov_script, '--manifest', manifest, '--md', gov_tmp]
            if a.historical_exempt:
                gov_cmd.append('--historical-exempt')
            if subprocess.run(gov_cmd).returncode != 0:
                print('!! 治理 JSON 与候选成册对账失败，拒绝写入正式输出')
                sys.exit(1)
        finally:
            try: os.remove(gov_tmp)
            except OSError: pass
    tmp_out = a.out + '.tmp'
    open(tmp_out, 'w', encoding='utf-8').write(candidate)
    os.replace(tmp_out, a.out)
    print(f'已组装输出: {a.out}')
    if not a.strategy_card:
        print('⚠ 治理前置门：未提供策略卡（新需求按《测试策略与风险治理标准》必附；存量册豁免）')

if __name__ == '__main__':
    main()
