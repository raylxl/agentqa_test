# -*- coding: utf-8 -*-
"""
XMind 统一生成器 v2（§5.5 新标 · 2026-10-27）
取代 01_核心工具链/xmind_unified_generator.py，向下兼容其旧格式。

支持两种 MD 输入（自动识别，整册单模式）：

  [新] §5.6 五列表格模板（2026-10-27 立标，示例仓储流程价格 11.30 实证）：
       ## 章 → ### 节（N条） → #### TC-XX-nn 标题（P0） → 无加粗五列表格
       L1 = 文件名主干+总条数   L2 = 章-节合并节点（全角（N条））
       L3 = #### 行原文        L4 = 优先级/前置条件/操作步骤/预期结果 四并列节点
       无 TC 的节/章（附录、代入表、统计、修改记录区）不进 XMind

  [旧] WorkBuddy V21 规范（01 目录老脚本的正主）：
       ## 模块 → #### TC_001｜名称 [P0]【必须验证】 → 加粗字段表格
       L2 = 模块(N条)（半角）；L4 字段名为"测试步骤"（操作步骤走别名映射）

XMind 8 兼容：content.xml + meta.xml（xmap-meta 官方成员名）+ META-INF/manifest.xml，
禁 JSON。xmind 库 1.2 构建 API 有坑（WorkbookDocument 无 stylesbook 不可保存、
removeChild DOM 报错），故手写 XML；库仅适合回读核对，不用来构建。

用法:
  python xmind_unified_generator_v2.py <md路径> [<xmind输出路径>] [--sheet-title 标题]
  - 输出路径缺省 = md 同名替换扩展名
  - sheet 标题（画布名）缺省取 MD 的 H1；成品元信息 Creator=ZCode、时间为真实生成时间
  - MD 读取一律 utf-8-sig（BOM 会使 # 前缀正则失效，v1 教训 2）
"""
import io
import os
import re
import sys
import html
import time
import zipfile
import datetime

# 用例行正则：【…】标注允许多重连续（如 [P0]【必须验证】【边界值】）——
# v1 生成器只收一个标注导致此类用例整条静默丢失（退货费样本实测 115 丢 6），此处必须用 *
# 2026-11-03：尾部注记组放宽为【】/〔〕/『』任选零个或多个（此前仅【】——端到端审查补条用〔…〕被整条静默跳过，①册丢5/②册丢19/④册丢12 实测）
NOTE_TAIL = r'(?:[\s~]*(?:【[^】]*】|〔[^〕]*〕|『[^』]*』))*'
PRIORITY_RX = r'P[0-3]'
VALID_PRIORITIES = frozenset({'P0', 'P1', 'P2', 'P3'})
NEW_CASE_RX = re.compile(r'^####\s+(TC-[A-Z0-9][A-Z0-9-]*)\s+(.+?)\s*（(' + PRIORITY_RX + r')）[\s~]*' + NOTE_TAIL + r'\s*$')
OLD_CASE_RX = re.compile(r'^####\s+(TC_\d+)[｜|]\s*(.+?)\s*\[(' + PRIORITY_RX + r')\]((?:【[^】]*】)+)?\s*$')

NEW_L4_FIELDS = ["优先级", "前置条件", "操作步骤", "预期结果"]
OLD_L4_FIELDS = ["优先级", "前置条件", "测试步骤", "预期结果"]
# 旧格式字段别名：不同用例集把「测试步骤」写成「操作步骤」，统一映射防整段丢弃
OLD_FIELD_ALIAS = {"操作步骤": "测试步骤", "测试步骤": "测试步骤"}
# 新格式表格里允许出现的行标签；判断依据/测试方法/用例名称 解析但不进 L4
NEW_ROW_LABELS = {"前置条件", "操作步骤", "预期结果", "判断依据", "测试方法"}
SKIP_CHAPTER_KEYS = ("统计", "修改记录", "版本记录")  # 章名命中即跳过（防 0 条外再兜底）


ROW7_RX = re.compile(r'^\|\s*(TC[-_][A-Z0-9][A-Z0-9_-]*?)\s*\|\s*(.*?)\s*\|\s*(P[0-3])\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$')

def detect_mode(lines):
    for l in lines:
        if l.startswith("#### "):
            if NEW_CASE_RX.match(l):
                return "new"
            if OLD_CASE_RX.match(l):
                return "old"
    for l in lines:
        if ROW7_RX.match(l):
            return "row7"
    return None


def join_cross_line_rows(lines, idx, raw):
    """跨行单元格：字段行以 | 开头但不以 | 闭合时拼接后续物理行，直到出现闭合 |；
    下一行若已是新字段行/标题则异常中断，按已有内容处理（v1 教训 5）。"""
    k = idx + 1
    while not raw.rstrip().endswith("|") and k < len(lines):
        nxt = lines[k]
        if nxt.startswith("#") or re.match(r'^\|\s*\*?\*?\S+\*?\*?\s*\|', nxt):
            break
        raw = raw + "\n" + nxt
        k += 1
    return raw


def split_cells(raw):
    return [c.strip() for c in raw.strip().strip("|").split("|")]


def norm_text(s):
    # XMind 8 title 支持字面换行多行展示；<br> 统一转 \n（v1 实证，非渲染吞行）；
    # Markdown 加粗 ** 剥掉（XMind 标题是纯文本，保留 ** 是噪音——仓内成品同款归一化）
    return s.replace("<br/>", "<br>").replace("<br>", "\n").replace("**", "")


def esc(s):
    return html.escape(s, quote=True)


def parse_new(lines):
    """返回 chapters=[{title, sections:[{title, cases:[…]]}]；
    case = {line: #### 行原文, id, prio, fields:{前置条件/操作步骤/预期结果}}"""
    chapters, cur_ch, cur_sec, cur_case = [], None, None, None

    def flush_case():
        nonlocal cur_case
        if cur_sec is not None and cur_case is not None:
            cur_sec["cases"].append(cur_case)
        cur_case = None

    for idx, line in enumerate(lines):
        m_ch = re.match(r'^##\s+(?!#)(.+)$', line)
        if m_ch:
            flush_case()
            cur_sec = None
            name = m_ch.group(1).strip()
            cur_ch = None
            # v2.1 修复：仅跳过"裸尾注区"（剥离（N条）后以关键词开头，如"修改记录"/"版本记录"/"统计"），
            # 带编号功能章（如"八、修改记录（26条）"）不再误杀（示例运价 2026-10-28 案例）
            _nm1 = re.sub(r'（\d+条）', '', name)
            if not any(_nm1.startswith(k) for k in SKIP_CHAPTER_KEYS):
                cur_ch = {"title": name, "sections": []}
                chapters.append(cur_ch)
            continue
        m_sec = re.match(r'^###\s+(?!#)(.+)$', line)
        if m_sec:
            flush_case()
            cur_sec = None
            if cur_ch is not None:  # 节出现在被跳过的章（如章节统计）下时直接丢弃
                cur_sec = {"title": m_sec.group(1).strip(), "cases": []}
                cur_ch["sections"].append(cur_sec)
            continue
        m_case = NEW_CASE_RX.match(line)
        if m_case:
            flush_case()
            if cur_sec is None and cur_ch is not None:
                # 章下直接挂用例（无 ### 节）：合成一个与章同名的节，保持 L2 合并格式
                cur_sec = {"title": cur_ch["title"], "cases": []}
                cur_ch["sections"].append(cur_sec)
            if cur_sec is not None:
                cur_case = {
                    "id": m_case.group(1),
                    "prio": m_case.group(3),
                    "line": re.sub('~+', '', line[5:].strip()),  # #### 行原文 = L3 标题（去~~划线，保留〔已失效〕标识）
                    "fields": {},
                }
            continue
        if cur_case is not None and line.startswith("|"):
            raw = join_cross_line_rows(lines, idx, line)
            cells = split_cells(raw)
            # [row5 横排五列]（2026-11-02 示例账单B新增）：表头行+分隔行+单数据行，
            # 与竖排 label 行逐用例自动识别互不干扰；数据行须恰 5 列，异常列数回落 label 逻辑由终验暴露。
            if (len(cells) == 5 and cells[0] == "前置条件" and cells[1] == "操作步骤"
                    and cells[2] == "预期结果" and cells[3] == "判断依据" and cells[4] == "测试方法"):
                cur_case["_row5"] = 1  # 已见表头，待分隔行
                continue
            if cur_case.get("_row5") == 1 and cells and all(re.match(r'^-{3,}$', c.strip()) for c in cells):
                cur_case["_row5"] = 2  # 已见分隔行，待数据行
                continue
            if cur_case.get("_row5") == 2 and len(cells) == 5:
                cur_case["fields"]["前置条件"] = norm_text(cells[0])
                cur_case["fields"]["操作步骤"] = norm_text(cells[1])
                cur_case["fields"]["预期结果"] = norm_text(cells[2])
                cur_case["_row5"] = 3
                continue
            if len(cells) >= 2:
                label = cells[0]
                if label in NEW_ROW_LABELS:
                    cur_case["fields"][label] = norm_text(cells[1])
            continue
        if line.strip() == "---":
            flush_case()
    flush_case()
    return chapters


def parse_old(lines):
    """兼容 01 目录 v1 生成器的旧格式：模块=##，字段=加粗表格行。"""
    modules, cur_mod, cur_case = [], None, None

    def flush():
        nonlocal cur_case
        if cur_mod is not None and cur_case is not None:
            cur_mod["cases"].append(cur_case)
        cur_case = None

    for idx, line in enumerate(lines):
        m_mod = re.match(r'^##\s+(?![#])(.+)$', line)
        if m_mod:
            flush()
            # 剥离章标题自带全角计数（如「一、新增（59条）」），防与 (N条) 双计数（v1 教训 1）
            name = re.sub(r'（\d+条）', '', m_mod.group(1).strip()).strip()
            cur_mod = None
            if not any(name.startswith(k) for k in SKIP_CHAPTER_KEYS):
                cur_mod = {"name": name, "cases": []}
                modules.append(cur_mod)
            continue
        m_case = OLD_CASE_RX.match(line)
        if m_case:
            flush()
            if cur_mod is not None:
                cur_case = {
                    "num": m_case.group(1),
                    "name": m_case.group(2).strip(),
                    "prio": m_case.group(3),
                    "must": m_case.group(4) or "",
                    "fields": {},
                }
            continue
        if cur_case is not None and line.startswith("|"):
            raw = join_cross_line_rows(lines, idx, line)
            cells = split_cells(raw)
            if len(cells) >= 2:
                label = re.sub(r'\*\*', '', cells[0]).strip()
                label = OLD_FIELD_ALIAS.get(label, label)
                if label in ("用例名称", "前置条件", "测试步骤", "预期结果"):
                    cur_case["fields"][label] = norm_text(cells[1])
            continue
        if line.strip() == "---":
            flush()
    flush()
    return modules


def parse_row7(lines):
    """[等效·七列标准行]（2026-10-31 三套格式统一新增）：| TC-编号 | 名称 | P0 | 前置 | 步骤 | 预期 | 判定依据 | 表格行。
    返回结构与 parse_new 一致：chapters=[{title, sections:[{title, cases}]}]；
    case = {line: "编号 名称（优先级）", id, prio, fields:{前置条件/操作步骤/预期结果}}。"""
    chapters, cur_ch, cur_sec = [], None, None

    def add_case(m):
        nonlocal cur_sec
        if cur_sec is not None:
            cur_sec["cases"].append({
                "id": m.group(1),
                "prio": m.group(3),
                "line": f"{m.group(1)} {m.group(2).strip()}（{m.group(3)}）",
                "fields": {"前置条件": norm_text(m.group(4)), "操作步骤": norm_text(m.group(5)), "预期结果": norm_text(m.group(6))},
            })

    for line in lines:
        m_ch = re.match(r'^##\s+(?!#)(.+)$', line)
        if m_ch:
            name = m_ch.group(1).strip()
            cur_sec = None
            cur_ch = None
            _nm1 = re.sub(r'（\d+条）', '', name)
            if not any(_nm1.startswith(k) for k in SKIP_CHAPTER_KEYS):
                cur_ch = {"title": name, "sections": []}
                chapters.append(cur_ch)
            continue
        m_sec = re.match(r'^###\s+(?!#)(.+)$', line)
        if m_sec:
            cur_sec = None
            if cur_ch is not None:
                cur_sec = {"title": m_sec.group(1).strip(), "cases": []}
                cur_ch["sections"].append(cur_sec)
            continue
        m7 = ROW7_RX.match(line)
        if m7:
            if cur_sec is None and cur_ch is not None:
                cur_sec = {"title": cur_ch["title"], "cases": []}
                cur_ch["sections"].append(cur_sec)
            add_case(m7)
    return chapters


def parse_md(path):
    text = io.open(path, encoding="utf-8-sig").read()
    lines = text.split("\n")
    mode = detect_mode(lines)
    if mode is None:
        sys.exit("错误: 未识别到任何用例行（#### TC-…/TC_…），请检查 MD 格式")
    h1 = ""
    for l in lines:
        if l.startswith("# ") and not l.startswith("## "):
            h1 = l[2:].strip()
            break
    return mode, lines, h1


def tid_gen():
    n = [0]
    def f():
        n[0] += 1
        return "t%d" % n[0]
    return f


def build_l2_new(ch, sec, ch_cnt):
    # §5.5：{章标题}（{章总条数}条）-{节标题}；节的（N条）随节标题原文保留
    if sec["title"] != ch["title"]:
        return "%s（%d条）-%s" % (ch["title"], ch_cnt, sec["title"])
    return "%s（%d条）" % (ch["title"], ch_cnt)


def build_content_xml_new(chapters, root_title, sheet_title):
    tid = tid_gen()
    topics = []
    for ch in chapters:
        ch_cnt = sum(len(s["cases"]) for s in ch["sections"])
        if ch_cnt == 0:
            continue  # 无 TC 的章（附录/统计/修改记录区）整章不进
        for sec in ch["sections"]:
            if not sec["cases"]:
                continue  # 无 TC 的节（如 2.10 代入表）不进，防空节点噪音
            case_xml = []
            for c in sec["cases"]:
                l4_vals = {
                    "优先级": c["prio"],
                    "前置条件": c["fields"].get("前置条件", ""),
                    "操作步骤": c["fields"].get("操作步骤", ""),
                    "预期结果": c["fields"].get("预期结果", ""),
                }
                l4 = "".join(
                    '<topic id="%s"><title>%s</title></topic>' % (tid(), esc("%s：%s" % (f, l4_vals[f])))
                    for f in NEW_L4_FIELDS
                )
                case_xml.append(
                    '<topic id="%s"><title>%s</title><children><topics type="attached">%s</topics></children></topic>'
                    % (tid(), esc(c["line"]), l4)
                )
            topics.append(
                '<topic id="%s"><title>%s</title><children><topics type="attached">%s</topics></children></topic>'
                % (tid(), esc(build_l2_new(ch, sec, ch_cnt)), "".join(case_xml))
            )
    return wrap_sheet(tid(), root_title, "".join(topics), sheet_title)


def build_content_xml_old(modules, root_title, sheet_title):
    tid = tid_gen()
    topics = []
    for mod in modules:
        cnt = len(mod["cases"])
        if cnt == 0:
            continue
        case_xml = []
        for c in mod["cases"]:
            title = "%s｜%s [%s]%s" % (c["num"], c["name"], c["prio"], c["must"])
            l4_vals = {
                "优先级": c["prio"] + ((" " + c["must"]) if c["must"] else ""),
                "前置条件": c["fields"].get("前置条件", ""),
                "测试步骤": c["fields"].get("测试步骤", ""),
                "预期结果": c["fields"].get("预期结果", ""),
            }
            l4 = "".join(
                '<topic id="%s"><title>%s</title></topic>' % (tid(), esc("%s：%s" % (f, l4_vals[f])))
                for f in OLD_L4_FIELDS
            )
            case_xml.append(
                '<topic id="%s"><title>%s</title><children><topics type="attached">%s</topics></children></topic>'
                % (tid(), esc(title), l4)
            )
        topics.append(
            '<topic id="%s"><title>%s(%d条)</title><children><topics type="attached">%s</topics></children></topic>'
            % (tid(), esc(mod["name"]), cnt, "".join(case_xml))
        )
    return wrap_sheet(tid(), root_title, "".join(topics), sheet_title)


def wrap_sheet(root_tid, root_title, topics_xml, sheet_title):
    st = "<title>%s</title>" % esc(sheet_title) if sheet_title else ""
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>'
        '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0">'
        '<sheet id="sheet1">'
        '<topic id="%s"><title>%s</title><children><topics type="attached">%s</topics></children></topic>'
        '%s</sheet></xmap-content>'
    ) % (root_tid, esc(root_title), topics_xml, st)


def write_xmind(out, content_xml):
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    meta_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>'
        '<xmap-meta xmlns="urn:xmind:xmap:xmlns:meta:2.0" version="2.0">'
        '<Creator>ZCode</Creator><CreatedTime>%s</CreatedTime><ModifiedTime>%s</ModifiedTime>'
        '</xmap-meta>' % (now, now)
    )
    manifest_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>'
        '<manifest xmlns="http://www.eclipse.org/xsd/2002/XMF" version="1.0">'
        '<file-entry media-type="xmind/xmap-content" full-path="content.xml"/></manifest>'
    )
    if os.path.exists(out):
        os.remove(out)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("content.xml", content_xml.encode("utf-8"))
        z.writestr("meta.xml", meta_xml.encode("utf-8"))
        z.writestr("META-INF/manifest.xml", manifest_xml.encode("utf-8"))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = dict(zip(sys.argv[1::2], sys.argv[2::2]))
    sheet_title_opt = opts.get("--sheet-title")
    if len(args) < 1:
        print("用法: python xmind_unified_generator_v2.py <md路径> [<xmind输出路径>] [--sheet-title 标题]")
        sys.exit(1)
    src = args[0]
    out = args[1] if len(args) > 1 else os.path.splitext(src)[0] + ".xmind"
    mode, lines, h1 = parse_md(src)

    # L1 = 文件名主干（去 .md、去尾部 _vN）+ 总条数直拼，无分隔符（§5.4/§5.5）
    base = os.path.splitext(os.path.basename(src))[0]
    base = re.sub(r'_v\d+$', '', base)

    if mode in ("row7", "new"):
        chapters = parse_row7(lines) if mode == "row7" else parse_new(lines)
        total = sum(len(s["cases"]) for ch in chapters for s in ch["sections"])
        content_xml = build_content_xml_new(chapters, base + str(total), h1)
        n_l2 = sum(
            1 for ch in chapters for s in ch["sections"]
            if s["cases"] and sum(len(x["cases"]) for x in ch["sections"]) > 0
        )
        print("模式: §5.5 新标（章-节合并 L2）")
        for ch in chapters:
            ch_cnt = sum(len(s["cases"]) for s in ch["sections"])
            if ch_cnt:
                print("  %s（%d条）: %d 节进 XMind" % (ch["title"], ch_cnt, sum(1 for s in ch["sections"] if s["cases"])))
    else:
        modules = parse_old(lines)
        total = sum(len(m["cases"]) for m in modules)
        content_xml = build_content_xml_old(modules, base + str(total), h1)
        n_l2 = sum(1 for m in modules if m["cases"])
        print("模式: 旧 WorkBuddy 格式（模块级 L2，向下兼容）")
        for m in modules:
            if m["cases"]:
                print("  %s(%d条)" % (m["name"], len(m["cases"])))

    sheet_title = sheet_title_opt or h1
    write_xmind(out, content_xml)
    print("生成成功: %s" % out)
    print("L1=%s%d  L2数=%d  用例总数=%d  sheet标题=%s" % (base, total, n_l2, total, sheet_title or "(无)"))
    print("后续必做: python xmind_format_validator_v2.py %s %s" % (out, src))
    print("        python compare_md_xmind_v2.py %s %s  （差异=0 才交付）" % (src, out))


if __name__ == "__main__":
    main()
