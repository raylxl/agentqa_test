#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""采集忠实机器闸（2026-11-19 立·B4 堵口：对账器查"丢没丢"，本闸查"改没改"）

背景：R22 采集忠实（禁改写混入）此前靠人工抽核——Mac 真机首跑首版文档混入改写与乱码，
自查抓回后仍标"持续风险"。reconcile（第三道闸门，在线×原页）已覆盖"文档→蓝湖"行级溯源与
coverage；本闸离线对 collect_cache 的 leaves_text.txt（采集时原页文本叶子），专攻三件事：

  ① 改写/自撰检测（红）：文档正文块（≥min 字）对源行（含相邻 2~3 行拼接窗）算字符二元组
     Dice 相似度，最高分 < 阈值 → 疑似改写/自撰/乱码替换；
  ② 丢失抽查（黄，正门=lanhu_reconcile）：源行未在文档出现（含/近似）→ 疑似丢失，只警告；
  ③ 乱码字符直扫（红）：文档中出现 CJK 扩展A/兼容区/扩展B+ 字符（頃/鵠 类生僻错字高发区）。

用法：
  python lanhu_fidelity.py --doc <采集产物md> [--menu "<树内菜单名>"] [--src <leaves_text.txt>]
                           [--cache <collect_cache目录>] [--sim 0.55] [--min-chars 6] [--top 20]
  --menu 与 --src 二选一；--cache 默认=本脚本目录/out/collect_cache（menu 子目录取最新时间戳）。
退出码：0=绿；3=红项>0（①或③）；2=参数/源缺失。
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
    for no, raw in enumerate(md_file.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if GARBAGE_RE.search(raw):
            garb.append((no, GARBAGE_RE.search(raw).group(0), raw.strip()[:40]))
        s = raw.strip()
        # G91：围栏代码块——mermaid 流程图块只取"带引号的标签"作为文字块（节点文字、连线标注=蓝湖原文，逐个溯源）；
        # 语法行（flowchart / n0 --> n1）不是正文，不参与比对；其他围栏内容跳过。不先处理的话语法行会被当"自撰"误判
        if s.startswith("```"):
            if not in_fence:
                in_fence, fence_lang = True, s[3:].strip().lower()
            else:
                in_fence, fence_lang = False, ""
            continue
        if in_fence:
            if fence_lang == "mermaid":
                for lab in re.findall(r'"([^"]*)"', s):
                    lab = MM_ENTITY.sub(lambda m: chr(int(m.group(1))), lab)
                    for part in re.split(r"<br\s*/?>", lab):
                        part = part.strip()
                        if part:
                            blocks.append((no, part))
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
                    # G86：格内分行标记 <br> 还原为空格——单元格是"多个原子值（文字件/按钮值/下拉项）按格拼成"的块
                    cells.append((no, re.sub(r"<br\s*/?>", " ", c)))
        elif s:
            blocks.append((no, s))
    return blocks, cells, garb


def main():
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", required=True, help="采集产物 md")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--menu", help="树内菜单名（在 cache 下定位最新采集目录）")
    g.add_argument("--src", help="直接给 leaves_text.txt 路径")
    ap.add_argument("--cache", default=str(here / "out" / "collect_cache"))
    ap.add_argument("--sim", type=float, default=0.55, help="改写判定阈值（默认0.55）")
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

    # ① 文档块 → 源 溯源（改写/自撰/乱码替换检测）
    rewrites = []
    kept = 0
    for no, b in doc_blocks:
        nb = norm(b)
        if len(nb) < a.min_chars:
            continue
        if any(nb in w for w in src_windows):
            kept += 1
            continue
        bb = bigrams(nb)
        best = max((dice(bb, sb) for sb in src_bigrams), default=0.0)
        if best >= a.sim:
            kept += 1
        else:
            rewrites.append((no, round(best, 2), b[:48]))
    # G86：表格单元格=多个原子值按格拼成（如操作列"详情 提交 编辑 删除 修改记录"、同一格里的第4条/第5条），
    # 整句比对必误判"自撰"——改为逐段溯源：按空白拆段，每段须是某条源行（文字件行/控件值）的子串
    src_all = [x for x in src_norm if len(x) >= 2]
    for no, c in doc_cells:
        nb = norm(c)
        if len(nb) < a.min_chars:
            continue
        segs = [norm(x) for x in c.split()]
        if segs and all(len(sg) < 2 or any(sg in x for x in src_all) for sg in segs):
            kept += 1
        else:
            rewrites.append((no, 0.0, c[:48]))
    # ② 源 → 文档 丢失抽查（黄；覆盖正门=lanhu_reconcile coverage=1.0）
    docfull = "".join(norm(b) for _, b in doc_blocks + doc_cells)
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
