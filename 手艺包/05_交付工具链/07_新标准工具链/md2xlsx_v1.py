# -*- coding: utf-8 -*-
"""md2xlsx（脚本 v1.1）—— MD 用例册 → Excel 表格用例（双格式交付之二，交付物规范 §19）
对齐参考文件《示例考核政策_标准测试用例.xlsx》（外部 AI 测试规范 §2.1/§7.2 形态）：
  Sheet1 需求映射表（banner+requirement_id/需求名称/需求描述/关联用例；REQ-{节号} 编号）
  Sheet2 测试用例（R1 即表头，18 列=外部 14 列超集+判断依据+测试方法+关联风险+执行集；执行三列留空=交付态）
  Sheet3 公共测试数据（banner+字段/取值/说明/关联用例；承载 PRE 执行前准备）
  Sheet4 统计与说明（内部溯源用，消费方可忽略；含各章计数与口径注记）
场景类型=功能/边界/异常（由测试方法+标题·预期关键词推断，原始方法保留在列）。
三步内置：生成 → 结构校验 → 数据终验（重读 xlsx 逐条比对源字段，差异=0 才交付）。
用法: python md2xlsx_v1.py <md路径> [输出.xlsx]   （输出缺省=MD 同名 .xlsx）
支持输入：new（五列竖排 + row5 横排，逐用例自动识别）/ row7（七列标准行）。
"""
import sys, io, re, os, datetime, json, subprocess
from xmind_unified_generator_v2 import (split_cells, join_cross_line_rows,
    norm_text, NEW_CASE_RX, SKIP_CHAPTER_KEYS, VALID_PRIORITIES)
import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill

FIVE = ("前置条件", "操作步骤", "预期结果", "判断依据", "测试方法")
NEG_RX = re.compile(r'拦截|提示|失败|不允许|为空|驳回|清空|超长|非法|不可|排除|不生效|不生成|不放行')

def parse_full(lines):
    """与 parse_new 同骨架；row5 横排收全 5 列（XMind 链只收 3 列，本链补判断依据/测试方法）。"""
    chapters, cur_ch, cur_sec, cur_case = [], None, None, None
    def flush():
        nonlocal cur_case
        if cur_case is not None and cur_sec is not None:
            cur_sec["cases"].append(cur_case)
        cur_case = None
    for idx, line in enumerate(lines):
        m = re.match(r'^##\s+(?!#)(.+)$', line)
        if m:
            flush(); cur_sec = None; cur_ch = None
            name = m.group(1).strip()
            nm = re.sub(r'（\d+条）', '', name)
            if not any(nm.startswith(k) for k in SKIP_CHAPTER_KEYS):
                cur_ch = {"title": name, "sections": []}
                chapters.append(cur_ch)
            continue
        m = re.match(r'^###\s+(?!#)(.+)$', line)
        if m:
            flush(); cur_sec = None
            if cur_ch is not None:
                cur_sec = {"title": m.group(1).strip(), "cases": []}
                cur_ch["sections"].append(cur_sec)
            continue
        m = NEW_CASE_RX.match(line)
        if m:
            flush()
            if cur_sec is None and cur_ch is not None:
                cur_sec = {"title": cur_ch["title"], "cases": []}
                cur_ch["sections"].append(cur_sec)
            if cur_sec is not None:
                # 2026-11-13 质检R2修复：失效条〔已失效…〕尾注被 NEW_CASE_RX 尾部吞掉→xlsx 全文不可见；
                # 从原始行提取失效块拼回 title，并清掉孤立 ~~（划线在 xlsx 无意义，保留语义文本）
                _inv = ''.join(re.findall(r'〔已失效[^〕]*〕', line))
                _t = re.sub(r'（P[0-3]）.*$', '', m.group(2)).strip().strip('~').strip()
                cur_case = {"id": m.group(1), "prio": m.group(3),
                            "title": (_t + (' ' + _inv if _inv else '')).strip(),
                            "fields": {}}
            continue
        if cur_case is not None and line.startswith("|"):
            cells = split_cells(join_cross_line_rows(lines, idx, line))
            if len(cells) == 5 and cells[0] == FIVE[0] and cells[1] == FIVE[1] \
               and cells[2] == FIVE[2] and cells[3] == FIVE[3] and cells[4] == FIVE[4]:
                cur_case["_r5"] = 1; continue
            if cur_case.get("_r5") == 1 and cells and all(
                    re.match(r'^-{3,}$', c.strip()) for c in cells):
                cur_case["_r5"] = 2; continue
            if cur_case.get("_r5") == 2 and len(cells) == 5:
                for i, k in enumerate(FIVE):
                    cur_case["fields"][k] = norm_text(cells[i])
                cur_case["_r5"] = 3
                continue
            if len(cells) >= 2 and cells[0] in FIVE:
                cur_case["fields"][cells[0]] = norm_text(cells[1])
            continue
        if line.strip() == "---":
            flush()
    flush()
    return chapters

def parse_row7(lines):
    """七列标准行：| TC-编号 | 名称 | P0 | 前置 | 步骤 | 预期 | 判定依据 |"""
    chapters, cur_ch, cur_sec = [], None, None
    for idx, line in enumerate(lines):
        m = re.match(r'^##\s+(?!#)(.+)$', line)
        if m:
            cur_sec = None; cur_ch = None
            name = m.group(1).strip()
            nm = re.sub(r'（\d+条）', '', name)
            if not any(nm.startswith(k) for k in SKIP_CHAPTER_KEYS):
                cur_ch = {"title": name, "sections": []}
                chapters.append(cur_ch)
            continue
        m = re.match(r'^###\s+(?!#)(.+)$', line)
        if m:
            cur_sec = None
            if cur_ch is not None:
                cur_sec = {"title": m.group(1).strip(), "cases": []}
                cur_ch["sections"].append(cur_sec)
            continue
        if line.startswith("|"):
            cells = split_cells(join_cross_line_rows(lines, idx, line))
            if len(cells) == 7 and re.match(r'^TC[-_]', cells[0]) and cells[2] in VALID_PRIORITIES:
                if cur_sec is None and cur_ch is not None:
                    cur_sec = {"title": cur_ch["title"], "cases": []}
                    cur_ch["sections"].append(cur_sec)
                if cur_sec is not None:
                    cur_sec["cases"].append({"id": cells[0], "prio": cells[2],
                        "title": norm_text(cells[1]),
                        "fields": {"前置条件": norm_text(cells[3]), "操作步骤": norm_text(cells[4]),
                                   "预期结果": norm_text(cells[5]), "判断依据": norm_text(cells[6]),
                                   "测试方法": ""}})
            continue
    return chapters

def parse_pre(lines):
    """两种 PRE 形态：表行式 | PRE-01 | 内容 |；标题式 **PRE-01 标题** + 后续正文段（至下一 PRE/章）。"""
    pre, cur, buf = [], None, []
    def flush():
        nonlocal cur, buf
        if cur is not None:
            pre.append((cur, "\n".join(x for x in buf if x.strip())))
        cur, buf = None, []
    for line in lines:
        s = line.strip()
        m1 = re.match(r'^\|\s*(PRE-\d+)\s*\|(.+)\|\s*$', line)
        m2 = re.match(r'^\*\*(PRE-\d+)\s*(.*?)\*\*\s*$', s)
        if m1:
            flush(); pre.append((m1.group(1), norm_text(m1.group(2)))); continue
        if m2:
            flush(); cur = m2.group(1); buf = [m2.group(2)]; continue
        if cur is not None:
            if line.startswith(("## ", "#### ")) or s == "---":
                flush(); continue
            buf.append(s)
    flush()
    return pre

def req_id(sec_title):
    """REQ 需求编号：节号去点（1.3 → REQ-1-3）；无节号取标题首词编码，保证唯一可读。"""
    m = re.match(r'^([0-9]+(?:\.[0-9]+)?)', sec_title)
    if m:
        return "REQ-" + m.group(1).replace(".", "-")
    key = re.sub(r'[^\u4e00-\u9fa5A-Za-z0-9]', '', sec_title)[:12]
    return "REQ-" + key

def scene_of(method, title, expected):
    """功能/边界/异常 三态：边界值→边界；负向关键词命中（标题+预期）→异常；其余→功能。"""
    if (method or "").strip() in ("边界值", "边界值分析"):
        return "边界"
    if NEG_RX.search((title or "") + (expected or "")):
        return "异常"
    return "功能"

def exec_of(cid, f):
    """三态：TC-API→api；预期/判断依据含「转测校准」→manual_only（人工件）；其余 ui。"""
    if cid.startswith("TC-API"):
        return "api"
    if "转测校准" in (f.get("预期结果", "") + f.get("判断依据", "")):
        return "manual_only"
    return "ui"

HEADERS = ["用例编号", "需求编号", "业务模块", "标题", "优先级", "关联风险", "执行集", "前置条件", "执行步骤", "预期结果",
           "场景类型", "执行方式", "判断依据", "测试方法", "实际测试结果", "测试原因（不通过时必填）",
           "验证截图（不通过时必填）", "备注"]

def load_riskmap(md_path):
    """Load TC risk links and execution-set definitions from governance JSON."""
    base = os.path.splitext(md_path)[0]
    candidates = [base + '_治理.json', os.path.join(os.path.dirname(md_path), '治理.json')]
    for path in candidates:
        if os.path.exists(path):
            try:
                data = json.load(io.open(path, encoding='utf-8-sig'))
            except (ValueError, OSError) as exc:
                raise ValueError('治理JSON不可读: %s (%s)' % (path, exc))
            return {'__tc__': data.get('tc_risk_map') or {},
                    '__execution_sets__': data.get('execution_sets') or {},
                    '__execution_plan__': data.get('execution_plan') or {},
                    '__source__': path, '__historical_exempt__': False}
    path = base + '_riskmap.tsv'
    sections = {}
    if os.path.exists(path):
        for line in io.open(path, encoding='utf-8-sig').read().splitlines():
            cols = [x.strip() for x in line.split('\t')]
            if len(cols) >= 2 and cols[0] and cols[1]:
                sections.setdefault(cols[1], []).append(cols[0])
        return {'__tc__': {}, '__section__': sections, '__execution_sets__': {}, '__execution_plan__': {}, '__source__': path, '__historical_exempt__': True}
    return {'__tc__': {}, '__section__': {}, '__execution_sets__': {}, '__execution_plan__': {}, '__source__': '', '__historical_exempt__': True}


def execution_sets_by_tc(riskmap, cases):
    """Return every named governance execution set containing each TC."""
    specs = riskmap.get('__execution_sets__', {})
    mapping = {}
    if not isinstance(specs, dict):
        return mapping
    for case in cases:
        cid, priority = case['id'], case['prio']
        names = []
        for name, spec in specs.items():
            if isinstance(spec, list):
                spec = {'tc_ids': spec}
            if not isinstance(spec, dict):
                continue
            ids = spec.get('tc_ids') or []
            priorities = spec.get('priorities') or []
            if cid in ids or priority in priorities:
                names.append(name)
        mapping[cid] = names
    return mapping



def build(md_path, out_path, mode):
    with io.open(md_path, "r", encoding="utf-8") as f:
        lines = f.read().split("\n")
    chapters = parse_full(lines) if mode != "row7" else parse_row7(lines)
    pres = parse_pre(lines)
    try:
        riskmap = load_riskmap(md_path)
    except ValueError as exc:
        print('终验失败：%s' % exc, file=sys.stderr); sys.exit(2)
    risk_source = riskmap.get('__source__', '')
    cases = []
    for ch in chapters:
        for sec in ch["sections"]:
            for c in sec["cases"]:
                c["_ch"] = ch["title"]; c["_sec"] = sec["title"]
                cases.append(c)
    execution_map = execution_sets_by_tc(riskmap, cases)
    if risk_source and not riskmap.get('__historical_exempt__'):
        missing = [c['id'] for c in cases if not riskmap.get('__tc__', {}).get(c['id'])]
        if missing:
            print('终验失败：新册缺少逐 TC 风险映射: %s' % ', '.join(missing[:12]), file=sys.stderr); sys.exit(1)
        missing_sets = [c['id'] for c in cases if not execution_map.get(c['id'])]
        if missing_sets:
            print('终验失败：新册缺少逐 TC 执行集映射: %s' % ', '.join(missing_sets[:12]), file=sys.stderr); sys.exit(1)

    p = {"P0": 0, "P1": 0, "P2": 0, "P3": 0}
    for c in cases:
        p[c["prio"]] = p.get(c["prio"], 0) + 1

    wb = openpyxl.Workbook()
    bold = Font(bold=True); fill = PatternFill("solid", fgColor="DDEBF7")
    wrap = Alignment(wrap_text=True, vertical="top")

    # ---- Sheet1 需求映射表（对齐参考文件：banner+表头在 R2）----
    ws1 = wb.active; ws1.title = "需求映射表"
    ws1.cell(1, 1, "需求-用例映射表（对齐参考《示例考核政策_标准测试用例》/AI 测试规范 §2.1·§7.2）").font = bold
    for col, h in enumerate(["requirement_id", "需求名称", "需求描述", "关联用例", "关联风险"], 1):
        c = ws1.cell(2, col, h); c.font = bold; c.fill = fill
    r = 3
    for ch in chapters:
        for sec in ch["sections"]:
            if not sec["cases"]:
                continue
            ws1.cell(r, 1, req_id(sec["title"]))
            ws1.cell(r, 2, sec["title"])
            ws1.cell(r, 3, "本节共 %d 条用例（所属章：%s）" % (len(sec["cases"]), ch["title"]))
            case_ids = [c["id"] for c in sec["cases"]]
            ws1.cell(r, 4, "、".join(case_ids)).alignment = wrap
            tc_map = riskmap.get('__tc__', {})
            sec_map = riskmap.get('__section__', {})
            risks = sorted({rid for tc in case_ids for rid in tc_map.get(tc, [])} | set(sec_map.get(sec["title"], [])))
            ws1.cell(r, 5, "、".join(risks)).alignment = wrap
            r += 1
    for col, w in zip("ABCDE", (14, 34, 34, 60, 18)):
        ws1.column_dimensions[col].width = w

    # ---- Sheet2 测试用例（R1 即表头，16 列）----
    ws2 = wb.create_sheet("测试用例")
    for col, h in enumerate(HEADERS, 1):
        cell = ws2.cell(1, col, h); cell.font = bold; cell.fill = fill
    for i, c in enumerate(cases, 2):
        f = c["fields"]
        tc_risks = riskmap.get('__tc__', {}).get(c["id"], [])
        tc_execution_sets = execution_map.get(c["id"], [])
        if not tc_risks and not riskmap.get('__historical_exempt__'):
            print('终验失败：新册用例 %s 缺少 risk_id 映射' % c["id"], file=sys.stderr); sys.exit(1)
        if risk_source and not riskmap.get('__historical_exempt__') and not tc_execution_sets:
            print('终验失败：新册用例 %s 缺少执行集映射' % c["id"], file=sys.stderr); sys.exit(1)
        row = [c["id"], req_id(c["_sec"]), c["_ch"], c["title"], c["prio"], "、".join(tc_risks),
               "、".join(tc_execution_sets), f.get("前置条件", ""), f.get("操作步骤", ""), f.get("预期结果", ""),
               scene_of(f.get("测试方法", ""), c["title"], f.get("预期结果", "")),
               exec_of(c["id"], f), f.get("判断依据", ""), f.get("测试方法", ""), "", "", "", c["_sec"]]
        for col, v in enumerate(row, 1):
            ws2.cell(i, col, v).alignment = wrap
    widths = [12, 12, 22, 30, 6, 18, 18, 40, 40, 40, 8, 8, 36, 10, 12, 14, 14, 20]
    for col, w in enumerate(widths, 1):
        ws2.column_dimensions[openpyxl.utils.get_column_letter(col)].width = w
    ws2.freeze_panes = "A2"

    # ---- Sheet3 公共测试数据（banner+表头在 R2；承载 PRE 执行前准备）----
    ws3 = wb.create_sheet("公共测试数据")
    ws3.cell(1, 1, "统一测试数据/执行前数据准备（PRE·非用例不计条）").font = bold
    for col, h in enumerate(["字段", "取值", "说明", "关联用例"], 1):
        c = ws3.cell(2, col, h); c.font = bold; c.fill = fill
    for i, (pid, txt) in enumerate(pres, 3):
        ws3.cell(i, 1, pid); ws3.cell(i, 2, txt).alignment = wrap
        ws3.cell(i, 3, "执行前准备事项" if mode != "row7" else "执行前准备事项（row7 册）")
        ws3.cell(i, 4, "")
    ws3.column_dimensions["A"].width = 10; ws3.column_dimensions["B"].width = 90
    ws3.column_dimensions["C"].width = 16; ws3.column_dimensions["D"].width = 20

    # ---- Sheet4 统计与说明（内部溯源，消费方可忽略）----
    ws = wb.create_sheet("统计与说明")
    info = [("源文件", os.path.basename(md_path)), ("生成时间", datetime.datetime.now().strftime("%Y-%m-%d %H:%M")),
            ("输入格式", {"new": "新标（五列竖排/横排 row5 自动识别）", "row7": "七列标准行"}.get(mode, mode)),
            ("用例总数", len(cases)), ("P0/P1/P2/P3", "%d/%d/%d/%d" % (p["P0"], p["P1"], p["P2"], p["P3"])),
            ("PRE 项（非用例不计条）", len(pres)),
            ("风险映射", ("%d 条风险映射（%s）" % (len(riskmap.get('__tc__', {})) or len(riskmap.get('__section__', {})), os.path.basename(risk_source))) if risk_source else "无治理清单（新册由治理 JSON 提供；历史册可无）")]
    for r, (k, v) in enumerate(info, 1):
        ws.cell(r, 1, k).font = bold; ws.cell(r, 2, v)
    r = len(info) + 2
    ws.cell(r, 1, "章").font = bold; ws.cell(r, 2, "条数").font = bold
    for ch in chapters:
        r += 1
        ws.cell(r, 1, ch["title"]); ws.cell(r, 2, sum(len(s["cases"]) for s in ch["sections"]))
    r += 2
    for note in ("口径说明：①执行三列留空=设计/执行分离（交付物规范 §19），执行态由执行方回填（通过/不通过+原因+截图），",
                 "　内部执行记录仍以 UI 报告/证据链为正本；②PRE 为执行前数据准备，不计入用例总数；无 TC 附表不进（同 XMind 规则）；",
                 "　③场景类型=功能/边界/异常三态（测试方法+标题·预期负向关键词推断），原始方法见「测试方法」列；",
                 "　④执行方式三态：TC-API→api；预期/判断依据含「转测校准」→manual_only（人工件）；其余 ui；⑤用例编号保留内部章前缀制（TC-XX-nn，全局唯一），",
                 "　与参考文件 TC_001 连号制等价可读；⑥列集=外部 14 列超集（+判断依据+测试方法），判断依据为内部溯源列禁丢。"):
        ws.cell(r, 1, note); r += 1

    wb.save(out_path)
    # ---- 第三步：数据终验（重读 xlsx 逐条比对源字段）----
    wb2 = openpyxl.load_workbook(out_path)
    ws = wb2["测试用例"]
    diff = 0
    n = ws.max_row - 1
    if n != len(cases):
        print("终验失败：行数 %d ≠ 解析条数 %d" % (n, len(cases))); sys.exit(1)
    for i, c in enumerate(cases, 2):
        f = c["fields"]
        exp = [c["id"], c["prio"], c["title"], "、".join(riskmap.get('__tc__', {}).get(c["id"], [])),
               "、".join(execution_map.get(c["id"], [])), f.get("前置条件", ""), f.get("操作步骤", ""),
               f.get("预期结果", ""), f.get("判断依据", ""), f.get("测试方法", "")]
        act = [ws.cell(i, 1).value, ws.cell(i, 5).value, ws.cell(i, 4).value, ws.cell(i, 6).value,
               ws.cell(i, 7).value, ws.cell(i, 8).value, ws.cell(i, 9).value,
               ws.cell(i, 10).value, ws.cell(i, 13).value, ws.cell(i, 14).value]
        for a, b in zip(exp, act):
            if (a or "") != (b or ""):
                diff += 1
                print("差异@%s: %r ≠ %r" % (c["id"], a, b))
                break
    print("生成 %s：%d 条（P0=%d/P1=%d/P2=%d/P3=%d）＋PRE %d 项＋需求映射 %d 节；数据终验差异=%d %s" % (
        os.path.basename(out_path), len(cases), p["P0"], p["P1"], p["P2"], p["P3"], len(pres),
        sum(1 for ch in chapters for s in ch["sections"] if s["cases"]),
        diff, "✅ 全绿" if diff == 0 else "❌"))
    sys.exit(0 if diff == 0 else 1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    md = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(md)[0] + ".xlsx"
    with io.open(md, "r", encoding="utf-8-sig") as f:
        first = f.read()
    mode = "row7" if re.search(r'^\|\s*TC[-_][A-Z0-9][A-Z0-9_-]*\s*\|.*\|\s*P[0-3]\s*\|', first, re.M) else "new"
    build(md, out, mode)
