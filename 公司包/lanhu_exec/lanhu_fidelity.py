#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""采集忠实机器闸（2026-11-19 立·B4 堵口：对账器查"丢没丢"，本闸查"改没改"）

背景：R22 采集忠实（禁改写混入）此前靠人工抽核——Mac 真机首跑首版文档混入改写与乱码，
自查抓回后仍标"持续风险"。reconcile（第三道闸门，在线×原页）已覆盖"文档→蓝湖"行级溯源与
coverage；本闸离线对 collect_cache 的 leaves_text.txt（采集时原页文本叶子），专攻三件事：

  ① 改写/自撰检测（红）：文档里的每一段（正文块、表格单元格）都必须**原样来自页面**——
     归一后的整串恰好等于：页面上同一行的若干文字按左右顺序拼接，或源里下标连续的若干行拼接（不限行数）；
     单元格先整体判，过不了再按 <br> 切成视觉行逐行判，且相邻视觉行须是页面上"紧邻的下一行"。
     2026-11-24 起**没有相似度兜底**（旧法"与源行 Dice 相似度 ≥0.55 即放行"会放过段落内改一个词/调顺序，已撤）。
     判据实现与逐步解释见 build_sourcer()；改判据后必跑 selftest/selftest_fidelity.py（标准 R14a）；
  ② 丢失抽查（黄，正门=lanhu_reconcile）：源行未在文档出现（含/近似，Dice ≥ --sim）→ 疑似丢失，只警告；
  ③ 乱码字符直扫（红）：文档中出现 CJK 扩展A/兼容区/扩展B+ 字符（頃/鵠 类生僻错字高发区）；
  ④ 文档字 ∉ 源字集（红）：増/説明/頃类异体错字。

用法：
  python lanhu_fidelity.py --doc <采集产物md> [--menu "<树内菜单名>"] [--src <leaves_text.txt>]
                           [--cache <collect_cache目录>] [--sim 0.55] [--min-chars 6] [--top 20]
  --menu 与 --src 二选一；--cache 默认=本脚本目录/out/collect_cache（menu 子目录取最新时间戳）。
  --sim 只用于 ② 丢失抽查的"近似"判定；① 不再用相似度。
  红项排障：python lanhu_fidelity_explain.py --doc <md> --menu <菜单名>（逐步看卡在哪）。
退出码：0=绿；3=红项>0（①③④）；2=参数/源缺失。
"""
import argparse
import re
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

GARBAGE_RE = re.compile(r"[\u3400-\u4dbf\uf900-\ufaff\U00020000-\U0002ebef]")
NORM_RE = re.compile(r"[^\u4e00-\u9fffa-z0-9]+")


def norm(s: str) -> str:
    return NORM_RE.sub("", (s or "").lower())


def bigrams(s: str) -> set:
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) >= 2 else ({s} if s else set())


def dice(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))


def load_source(src_file: Path):
    """leaves_text.txt 行式：y|x|tag||css|text（text=第6段起，内含|也归文本）"""
    lines = []
    for raw in src_file.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = raw.split("|", 5)
        if len(parts) < 6:
            continue
        t = parts[5].strip()
        if t:
            lines.append(t)
    return lines




MM_ENTITY = re.compile(r"#(38|34|60|62|124);")  # G91：流程图标签里的数字实体（#34;=引号 等），核对前还原


def load_doc_blocks(md_file: Path):
    """文档正文块：剔除图片/引用/清单符号/表格骨架，表格按单元格拆块"""
    blocks, cells, garb = [], [], []
    in_fence, fence_lang = False, ""
    in_comment, in_flow = False, False
    for no, raw in enumerate(md_file.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if GARBAGE_RE.search(raw):
            garb.append((no, GARBAGE_RE.search(raw).group(0), raw.strip()[:40]))
        s = raw.strip()
        # G91/G93：流程图块（```mermaid 代码块，可见）只取"带引号的标签"作为文字块（节点文字、连线标注=蓝湖原文，逐个溯源）；
        # 语法行（flowchart / n0 --> n1）不是正文，不参与比对——不先处理的话语法行会被当"自撰"误判。
        # 注释分支只为核对 v1.1 的旧形态（源码曾被放进 <!-- 流程图结构 … -->，已废：用户阅读器里流程图整块消失）；
        # 其他 HTML 注释整段跳过。
        def _flow_labels(line):
            for lab in re.findall(r'"([^"]*)"', line):
                lab = MM_ENTITY.sub(lambda m: chr(int(m.group(1))), lab)
                for part in re.split(r"<br\s*/?>", lab):
                    part = part.strip()
                    if part:
                        blocks.append((no, part))
        if not in_comment and s.startswith("<!--"):
            in_comment, in_flow = True, ("流程图结构" in s)
            continue
        if in_comment:
            if "-->" in s:
                in_comment, in_flow = False, False
            elif in_flow:
                _flow_labels(s)
            continue
        if s.startswith("```"):
            if not in_fence:
                in_fence, fence_lang = True, s[3:].strip().lower()
            else:
                in_fence, fence_lang = False, ""
            continue
        if in_fence:
            if fence_lang == "mermaid":
                _flow_labels(s)
            continue
        if not s or s.startswith(("![", "> ", "<!--", "|--")) or ".png" in s or "_images" in s:
            continue
        if re.match(r"^#{0,6}\s*蓝湖需求（.*保真版）", s):   # 采集器自产文档标题行（脚手架，非正文）
            continue
        s = re.sub(r"^#{1,6}\s*", "", s)
        s = s.replace("**", "").replace("`", "")
        s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)          # 链接留字
        if s.startswith("|") or s.endswith("|"):
            for cell in s.strip("|").split("|"):
                c = cell.strip()
                if c and not re.fullmatch(r"[:\-\s]*", c):
                    # G93：格内分行标记 <br> 原样保留——溯源判据按 <br> 把单元格切成"视觉行"逐行核对
                    #（采集器 cellText：同一视觉行内按 x 相邻、多行以 <br> 分隔；G86 时曾在此处把 <br> 换成空格，
                    #  那是为了配合旧的逐段溯源；现在换成空格会让格内上下两行被当成同一行而溯源失败）。
                    # 只做纯文本比对的地方（丢失抽查 / 字∉源字集）自行去掉 <br>。
                    cells.append((no, c))
        elif s:
            blocks.append((no, s))
    return blocks, cells, garb


def build_sourcer(src_file, src_norm):
    """构建溯源判定器。返回 text_sourced(text, is_cell) 与 explain(text, is_cell)。

    判据（2026-11-24 全量重采重做；正文块与单元格共用；依据=采集器 cellText 的成行规则：
          同一视觉行内按 x 相邻、格内多行以 <br> 分隔）：
      待核文本归一后的整串，必须**恰好等于**页面上
        B. 同一行（y 相近）的若干源行按 x 从左到右拼接（中间可隔别的列），或
        A. 源里下标连续的若干行拼接（一个文字件被拆成多行、相邻叶子合成一句）。
      单元格先整体判；整体过不了再按 <br> 切成视觉行逐行判，且相邻视觉行须是页面上"紧邻的下一行"（y 增大、间距 ≤ NEXT_ROW_MAX_PX）。
    为什么不用"按空白拆段、每段是某条源行的子串"：太松——页面上的词换个位置/重复拼成假行也会放行（反向验证 F1/F2/F5 击穿）。
    改判据必配反向用例（标准 R14a）：out/flow_poc/g93/fidelity_verdict.py 一键跑"反向 6 例 + 全量真文档"。"""
    src_y, src_x = [], []
    for raw in src_file.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = raw.split("|", 5)
        if len(parts) < 6 or not parts[5].strip():
            continue
        try:
            src_y.append(int(float(parts[0])))
            src_x.append(int(float(parts[1])))
        except ValueError:
            src_y.append(None)
            src_x.append(None)
    assert len(src_y) == len(src_norm), (len(src_y), len(src_norm))   # 留行条件与 load_source 一致
    SAME_ROW_PX = 20          # 采集器 cellText：中心点 y 差 ≤8px 归同一视觉行；这里放宽到 20——
                              # 按钮框比文字件高，按钮与其旁边数字的 y 中心差实测落在 12~20（发票管理"30 校验失败"）
    NEXT_ROW_MAX_PX = 40      # 格内相邻两视觉行的 y 间距上限（实测行距 16~25：报表核对工具 539→564、公式格 1751→1774）
    src_all = [x for x in src_norm if x]                  # 归一后非空的源行（含 1 字的短标签）
    first_index = {}
    for i, s in enumerate(src_all):
        first_index.setdefault(s, []).append(i)

    def row_sourced(nb):
        """nb 是否恰好 = 页面同一行上若干源行按 x 从左到右拼接（中间可隔别的列）。返回用到的源行下标集合，或 None。"""
        n = len(nb)
        if not n:
            return None
        for s in range(len(src_all)):
            seg0 = src_all[s]
            if not seg0 or not nb.startswith(seg0) or src_y[s] is None:
                continue
            ys = src_y[s]
            cands = sorted([i for i in range(len(src_all)) if i != s and src_y[i] is not None
                            and abs(src_y[i] - ys) <= SAME_ROW_PX and src_x[i] >= src_x[s] - 2],
                           key=lambda i: (src_x[i], i))
            stack = [(len(seg0), 0, frozenset([s]))]
            seen = set()
            while stack:
                pos, ci, used = stack.pop()
                if pos == n:
                    return set(used)
                if (pos, ci) in seen:
                    continue
                seen.add((pos, ci))
                for k in range(ci, len(cands)):
                    seg = src_all[cands[k]]
                    if seg and nb.startswith(seg, pos):
                        stack.append((pos + len(seg), k + 1, used | {cands[k]}))
        return None

    def row_ys(nb):
        """row_sourced 的**全部**解里，该页面行的 y（所用源行的最小 y）集合；无解返回空集。
        为什么不能只认第一个解：同一行文字在页面上常出现多次（"一口价…元/单"在一张报价页上出现十几处），
        只拿第一处去量"与上一视觉行的间距"会量到毫不相干的位置（对客报价 11.30 实证：量出 -1241px / 43px 而误红）。"""
        n = len(nb)
        out = set()
        if not n:
            return out
        for s in range(len(src_all)):
            seg0 = src_all[s]
            if not seg0 or not nb.startswith(seg0) or src_y[s] is None:
                continue
            ys = src_y[s]
            cands = sorted([i for i in range(len(src_all)) if i != s and src_y[i] is not None
                            and abs(src_y[i] - ys) <= SAME_ROW_PX and src_x[i] >= src_x[s] - 2],
                           key=lambda i: (src_x[i], i))
            stack = [(len(seg0), 0, frozenset([s]))]
            seen = set()
            while stack:
                pos, ci, used = stack.pop()
                if pos == n:
                    yy = [src_y[i] for i in used if src_y[i] is not None]
                    out.add(min(yy) if yy else None)
                    continue
                if (pos, ci) in seen:
                    continue
                seen.add((pos, ci))
                for k in range(ci, len(cands)):
                    seg = src_all[cands[k]]
                    if seg and nb.startswith(seg, pos):
                        stack.append((pos + len(seg), k + 1, used | {cands[k]}))
        return out

    def concat_sourced(nb):
        """nb 是否恰好 = 源里一段**下标连续**的源行拼接（一个文字件被拆成多行、或相邻叶子合成一句）。
        与相邻 2/3 行窗口同义，只是不限行数（外部参考价 实证：605 字 = 源第 224 行起连续拼接）。"""
        n = len(nb)
        if not n:
            return False
        lens = sorted({len(x) for x in src_all})
        for ln in lens:
            if ln <= n:
                for s in first_index.get(nb[:ln], ()):
                    acc, e = src_all[s], s
                    while len(acc) < n and e + 1 < len(src_all):
                        e += 1
                        acc += src_all[e]
                    if acc == nb:
                        return True
        return False

    def _whole(nb):
        used = row_sourced(nb)
        if used is not None:
            yy = sorted({src_y[i] for i in used if src_y[i] is not None})
            return True, "同一页面行按 x 拼接（用到的源行 y=%s）" % yy
        if concat_sourced(nb):
            return True, "连续源行拼接"
        return False, "既不是同一页面行的拼接，也不是连续源行"

    def explain(text, is_cell):
        """逐步说明判定过程：{'ok': bool, 'steps': [(阶段, 通过?, 说明), …]}。排障与回归用；text_sourced 即取其 ok。"""
        steps = []
        if not is_cell:
            ok, why = _whole(norm(re.sub(r"<br\s*/?>", "", text)))
            steps.append(("整体", ok, why))
            return {"ok": ok, "steps": steps}
        ok, why = _whole(norm(re.sub(r"<br\s*/?>", "", text)))
        steps.append(("整体", ok, why))
        if ok:
            return {"ok": True, "steps": steps}
        vis = [norm(v) for v in re.split(r"<br\s*/?>", text)]
        vis = [v for v in vis if v]
        if len(vis) < 2:
            steps.append(("切分", False, "没有 <br> 可切"))
            return {"ok": False, "steps": steps}
        # last_ys = 上一视觉行**所有可行**的页面 y。行距核对看"任意一对可行组合"：存在一对满足 0 ≤ 间距 ≤ NEXT_ROW_MAX_PX 即可。
        # （已知边界：页面上同一列相邻两行文字相同时，用别处的同名词拼出的叠放假格也能找到可行组合——离线闸没有格子边界，
        #   这一点拦不住；单视觉行的判据不受影响，仍然严格。）
        last_ys, all_ok = None, True
        for v in vis:
            ys = row_ys(v) or None
            if ys:
                why, ok_v = "同一页面行拼接（页面 y=%s）" % sorted(y for y in ys if y is not None)[:6], True
                if last_ys:
                    feas = {y for y in ys if y is not None and any(0 <= y - p <= NEXT_ROW_MAX_PX for p in last_ys)}
                    ok_v = bool(feas)
                    why += "；与上一行间距在 0~%d 内的位置组合：%s" % (NEXT_ROW_MAX_PX, ("有" if feas else "没有"))
                    ys = feas
            elif concat_sourced(v):
                ys, why, ok_v = None, "连续源行拼接", True
            else:
                why, ok_v = "溯源不到（既不是同一页面行的拼接，也不是连续源行）", False
            if ys:
                last_ys = ys
            elif ok_v:
                last_ys = None            # 走连续拼接的行不提供行位置：下一行不再受行距约束
            steps.append(("视觉行「%s」" % v[:20], ok_v, why))
            all_ok = all_ok and ok_v
        return {"ok": all_ok, "steps": steps}

    def text_sourced(text, is_cell):
        return explain(text, is_cell)["ok"]

    return text_sourced, explain


def main():
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", required=True, help="采集产物 md")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--menu", help="树内菜单名（在 cache 下定位最新采集目录）")
    g.add_argument("--src", help="直接给 leaves_text.txt 路径")
    ap.add_argument("--cache", default=str(here / "out" / "collect_cache"))
    ap.add_argument("--sim", type=float, default=0.55, help="② 丢失抽查的\"近似\"阈值（默认0.55）；① 改写检测不用相似度")
    ap.add_argument("--min-chars", type=int, default=6, help="参与比对的块/行最小归一字数（默认6）")
    ap.add_argument("--top", type=int, default=20, help="每类清单最多打印条数")
    a = ap.parse_args()

    doc = Path(a.doc)
    if not doc.is_file():
        print(f"[红] 文档不存在：{doc}")
        sys.exit(2)
    if a.src:
        src_file = Path(a.src)
    else:
        # 菜单名含 / ? 等字符时须与采集侧同一套目录名归一（路线 B 与路线 A G90 均按此落盘）
        bad = chr(92) + '/:*?"<>|'
        safe_menu = ''.join('_' if ch in bad else ch for ch in a.menu)[:40]
        menu_dir = Path(a.cache) / safe_menu
        cands = sorted(menu_dir.glob("*/leaves_text.txt"))
        if not cands:
            print(f"[红] 缓存无此菜单：{menu_dir}\\*\\leaves_text.txt（先采集，或用 --src 指定；在线正门=lanhu_reconcile）")
            sys.exit(2)
        src_file = cands[-1]
    src_lines = load_source(src_file)
    if not src_lines:
        print(f"[红] 源文本为空：{src_file}")
        sys.exit(2)

    src_norm = [norm(x) for x in src_lines]
    src_hits = [s for s in src_norm if len(s) >= 2]
    # 相邻 2/3 行拼接窗（文档常把相邻叶子合并成句）
    src_windows = src_hits[:]
    for i in range(len(src_hits) - 1):
        src_windows.append(src_hits[i] + src_hits[i + 1])
    for i in range(len(src_hits) - 2):
        src_windows.append(src_hits[i] + src_hits[i + 1] + src_hits[i + 2])
    src_bigrams = [bigrams(w) for w in src_windows]
    src_charset = set("".join(src_norm))

    doc_blocks, doc_cells, garbage = load_doc_blocks(doc)

    # ── G93（2026-11-24 全量重采）溯源判据重做 ─────────────────────────────────────────────
    # 背景：旧判据"逐段溯源只认 ≥2 字的段"把查询条件行（"30 99+ 4 全部 全部 云冷 …"含 1 字段）判成改写；
    #       而"每段是某条源行的子串"又太松——页面上的词换个位置/重复拼成假行也放行（反向验证 F1/F2/F5 击穿）。
    # 现判据（正文块与单元格共用，依据=采集器 cellText 的成行规则：同一视觉行内按 x 相邻、多行以 <br> 分隔）：
    #   把待核文本切成"视觉行"（单元格按 <br> 切；正文块整体是一行）；
    #   每个视觉行归一后的整串，必须恰好等于页面上**同一行（y 相近）** 的若干源行按 x 从左到右拼接的结果
    #     —— 中间可以隔着别的列（读一行要跨列），但这些源行必须同 y、x 不倒退；
    #   单元格的多个视觉行，其 y 依次不减（格内自上而下）。
    # 这样：查询条件行（同一行上的下拉/按钮值）、叠放格（冻结列盖在另一列上、同一 y）、格内多行 都能原样溯源；
    #       换词/重复词/硬拼别处的同名词/调序，因 y 或 x 对不上而判红。
    # 注：正文长段（一个文字件在源里被拆成多行、y 逐行 +16）另有一条通道——下面的"源行连续拼接"判定。
    text_sourced, explain_sourced = build_sourcer(src_file, src_norm)

    rewrites = []
    kept = 0
    for no, b in doc_blocks:
        nb = norm(b)
        if len(nb) < a.min_chars:
            continue
        if any(nb in w for w in src_windows):
            kept += 1
        elif text_sourced(b, False):
            kept += 1
        else:
            # G98（2026-11-24 全量重采·合成样例自检实证）：**不再有"字符相似度 ≥ 阈值即放行"的兜底**。
            # 旧法（2026-11-19 立闸时设，那时还没有精确匹配）对精确匹配不上的块再算一次 bigram-Dice 相似度，≥0.55 即放行——
            # 而一段 113 字的段落里改一个词/调换两个短语，与最佳 3 行窗口的相似度是 0.566/0.552，刚好压线放过
            #（之前用真实文档验证"能拦住"，只因那段恰好 605 字、相似度被稀释到 0.43——有偶然性）。
            # 现行：文档里的每一段都必须原样来自页面（整段是相邻几行原文的拼接，或页面上同一行的若干文字按左右顺序拼接）。
            # 去掉兜底前用 65 份最终文档 7405 个文字块验证：精确匹配零误判，兜底已无存在必要。sim 只作参考值打印。
            bb = bigrams(nb)
            best = max((dice(bb, sb) for sb in src_bigrams), default=0)
            rewrites.append((no, round(best, 2), b[:48]))
    # G86：表格单元格=多个原子值按格拼成（如操作列"详情 提交 编辑 删除 修改记录"、同一格里的第4条/第5条），
    # 整句比对必误判"自撰"——改用 text_sourced（按视觉行溯源，见上）
    for no, c in doc_cells:
        nb = norm(c)
        if len(nb) < a.min_chars:
            continue
        if text_sourced(c, True):
            kept += 1
        else:
            rewrites.append((no, 0.0, c[:48]))
    # ② 源 → 文档 丢失抽查（黄；覆盖正门=lanhu_reconcile coverage=1.0）
    # G93：单元格里的 <br> 是呈现层记号，纯文本比对前去掉（否则 norm 会留下字母 b、r 混进正文）
    strip_br = lambda x: re.sub(r"<br\s*/?>", "", x)
    docfull = "".join(norm(strip_br(b)) for _, b in doc_blocks + doc_cells)
    doc_block_norms = [norm(b) for _, b in doc_blocks if len(norm(b)) >= a.min_chars]
    doc_block_bgs = [bigrams(x) for x in doc_block_norms]
    lost = []
    for s in src_norm:
        if len(s) < a.min_chars or s in docfull:
            continue
        sb = bigrams(s)
        if not any(dice(sb, db) >= a.sim for db in doc_block_bgs):
            lost.append((0, 0.0, s[:40]))
    # ④ 文档字 ∉ 源字集（同块低占比错字/乱码替换：増/説明/頃类异体字与源不同码位，①的行级相似度漏网）
    alien = []
    for no, b in doc_blocks + doc_cells:
        b = strip_br(b)
        if len(norm(b)) < a.min_chars:
            continue
        bad = sorted({ch for ch in b if "\u4e00" <= ch <= "\u9fff" and ch not in src_charset})
        if bad:
            alien.append((no, 0.0, "".join(bad) + " ← " + b[:36]))
    # ③ 生僻乱码直扫已在 load 时收集

    n_cmp = kept + len(rewrites)
    print(f"源={src_file.parent.name}/{src_file.name}（{len(src_hits)} 行）；文档块（≥{a.min_chars}字）={n_cmp}")
    print(f"① 溯源通过 {kept}/{n_cmp}，疑似改写/自撰 {len(rewrites)}；② 疑似丢失(黄) {len(lost)}；"
          f"③ 生僻乱码字符 {len(garbage)}；④ 字∉源字集 {len(alien)}")
    for no, sim, txt in rewrites[: a.top]:
        print(f"  [①疑似改写/自撰] L{no} sim={sim} {txt}")
    for _no, _sim, txt in lost[: a.top]:
        print(f"  [②疑似丢失(黄)] {txt}")
    for no, _ch, txt in garbage[: a.top]:
        print(f"  [③乱码字符] L{no} 「{_ch}」 {txt}")
    for no, _s, txt in alien[: a.top]:
        print(f"  [④字∉源字集] L{no} {txt}")
    red = len(rewrites) + len(garbage) + len(alien)
    if red:
        print(f"[红] 忠实闸未过：红 {red} 项——逐条对原文修正（禁改写），复跑本闸至零")
        sys.exit(3)
    print("[OK ] 采集忠实闸绿（文字层未发现改写/自撰/乱码；覆盖正门=lanhu_reconcile）")
    sys.exit(0)


if __name__ == "__main__":
    main()
