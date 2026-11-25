#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
lanhu_verify.py - 蓝湖需求文档重写后强制校验（标准方法 v1 / R6+R7）

检查项:
  1. 图片引用 ![](x) <-> imgdir 实际文件，缺则报 MISSING
  2. MD 表格逐表 `|` 计数一致；--fix 时按表头列数自动补齐尾部空单元格
  3. --keys 文件：关键内容必须命中（每行一个关键词）
  4. --olds 文件：旧错误/拍扁残留必须清零（每行一个，命中报 RESIDUAL）
  5. G91/G93 流程图块：```mermaid 代码块（阅读器直接显示为流程图）；围栏须闭合、块内只允许流程图语法行；
     流程图块数 == 流程图渲染_*.png 张数；@@…@@ 占位标记不得残留；结构文字被藏进 HTML 注释（<!-- 流程图结构 … -->）判红
     ——注释里的流程图在用户阅读器里整块消失（G93，2026-11-24 v5 实证）；--no-render-ok 可放宽"块数==渲染图数"

用法:
  python lanhu_verify.py <doc.md> <imgdir> [--keys 关键词.txt] [--olds 残留.txt] [--fix]
"""
import re, os, sys, argparse

def load_list(path):
    if not path or not os.path.exists(path):
        return []
    with open(path, encoding="utf-8-sig") as f:
        return [l.strip() for l in f if l.strip()]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("doc")
    ap.add_argument("imgdir")
    ap.add_argument("--keys", default="")
    ap.add_argument("--olds", default="")
    ap.add_argument("--fix", action="store_true")
    ap.add_argument("--no-render-ok", action="store_true", help="G91：允许流程图块没有渲染图（无渲染库的环境只出源码块时用）")
    a = ap.parse_args()

    doc = open(a.doc, encoding="utf-8").read()
    base = os.path.dirname(a.doc)

    # 0. G91/G93：围栏代码块（```mermaid 流程图源码）结构校验
    #    ① 围栏必须成对 ② 块内只允许流程图语法行（防残留清理/拼接把语法行删改坏）③ 流程图块数 == 渲染图数
    #    ④ 流程图源码被藏进 HTML 注释 = 红（注释里的流程图用户看不到，等于流程图没了）
    vlines = doc.splitlines()
    fence_open, fence_lang, fence_bad = False, "", []
    flow_bad, flow_blocks, hidden_flow = [], 0, 0
    NODE = re.compile(r'^\s*n\d+(\["[^"]*"\]|\{"[^"]*"\}|\("[^"]*"\))\s*$')
    EDGE = re.compile(r'^\s*n\d+ -->(\|"[^"]*"\|)? n\d+\s*$')
    HEADLINE = re.compile(r'^flowchart (LR|RL|TD|BT)\s*$')
    # kind=None 不在流程图块内；"fenced"=```mermaid 代码块（现行形态）；"hidden"=HTML 注释内的流程图源码（判红，只找结束符）
    kind, blk_no, in_comment = None, 0, False
    for ln in vlines:
        st = ln.strip()
        if kind is None and in_comment:          # 其他 HTML 注释：整段跳过
            if "-->" in st:
                in_comment = False
            continue
        if kind is None and st.startswith("<!--"):
            if "流程图结构" in st:
                hidden_flow += 1
                kind, blk_no = "hidden", hidden_flow
            else:
                in_comment = True
            continue
        if kind is None and st.startswith("```"):
            if not fence_open:
                fence_open, fence_lang = True, st[3:].strip().lower()
                if fence_lang == "mermaid":
                    flow_blocks += 1
                    kind, blk_no = "fenced", flow_blocks
            else:
                fence_open, fence_lang = False, ""
            continue
        if kind is not None:
            if kind == "hidden" and "-->" in st:
                kind = None
                continue
            if kind == "fenced" and st.startswith("```"):
                kind, fence_open = None, False
                continue
            if st and not (HEADLINE.match(st) or NODE.match(st) or EDGE.match(st)):
                flow_bad.append("块%d: %s" % (blk_no, st[:50]))
            continue
    if kind == "hidden":
        fence_bad.append("流程图源码藏进了 HTML 注释且未闭合（<!-- 流程图结构 开了没关）")
    if fence_open or kind == "fenced":
        fence_bad.append("围栏未闭合（``` 开了没关）")
    renders = sorted(f for f in (os.listdir(a.imgdir) if os.path.isdir(a.imgdir) else []) if f.startswith("流程图渲染_") and f.lower().endswith(".png"))
    print("FLOW blocks", flow_blocks, "renders", len(renders), "hidden", hidden_flow, "fence_bad", fence_bad, "bad_lines", flow_bad[:4])
    markers = [ln.strip()[:40] for ln in vlines if re.match(r'^@@[A-Z]+:\d+@@\s*$', ln.strip())]

    # 1. 图片引用 <-> 文件
    imgs = re.findall(r'!\[.*?\]\((.+?)\)', doc)
    files = sorted(os.listdir(a.imgdir)) if os.path.isdir(a.imgdir) else []
    missing = [i for i in imgs if not os.path.exists(os.path.join(base, i))]
    # G79：孤儿文件检查（图目录有 png 但 MD 未引用=历史迭代尸体，删除或补引用）——防"文件比引用多"的静默膨胀
    referenced = set(os.path.basename(i) for i in imgs)
    orphans = [f for f in files if f.lower().endswith(".png") and f not in referenced]
    print("IMG_REFS", len(imgs), "FILES", len(files), "MISSING", missing, "ORPHANS", orphans[:6], "..." if len(orphans) > 6 else "")

    # 2. 表格列数一致（按表分组）
    lines = doc.splitlines()
    tables, i = [], 0
    while i < len(lines):
        if lines[i].strip().startswith("|"):
            j = i
            while j < len(lines) and lines[j].strip().startswith("|"):
                j += 1
            tables.append(lines[i:j]); i = j
        else:
            i += 1
    print("TABLES", len(tables))
    mismatch = []
    for ti, t in enumerate(tables):
        counts = set(r.count("|") for r in t)
        if len(counts) != 1:
            mismatch.append((ti, sorted(counts)))
        print("TABLE", ti, "rows", len(t), "pipe_counts", sorted(counts),
              "OK" if len(counts) == 1 else "MISMATCH")

    # --fix: 按表头列数补齐每表数据行尾部空单元格
    if a.fix and mismatch:
        new_lines = lines[:]
        # 重建（按原表区间替换）
        idx, repl = 0, []
        while idx < len(lines):
            if lines[idx].strip().startswith("|"):
                j = idx
                while j < len(lines) and lines[j].strip().startswith("|"):
                    j += 1
                block = lines[idx:j]
                header = block[0]
                ncol = header.count("|")
                fixed = [r + "|" * (ncol - r.count("|")) for r in block]
                repl.append((idx, j, fixed))
                idx = j
            else:
                idx += 1
        # 从后往前替换，避免索引漂移
        for s, e, fixed in sorted(repl, reverse=True):
            new_lines[s:e] = fixed
        with open(a.doc, "w", encoding="utf-8") as f:
            f.write("\n".join(new_lines))
        print("FIXED_TABLES", [m[0] for m in mismatch])

    # 3. 关键内容命中
    key_fail = [k for k in load_list(a.keys) if k not in doc]
    for k in load_list(a.keys):
        print("HIT" if k in doc else "FAIL", k)

    # 4. 旧残留清零
    old_residual = [k for k in load_list(a.olds) if k in doc]
    for k in load_list(a.olds):
        print("CLEAN" if k not in doc else "RESIDUAL", k)

    # 5. 硬闸门（R14：不一致非零退出，绝不声称完成）——--fix 后仍 MISMATCH 的表也计红
    hard = []
    if missing:
        hard.append("图片引用缺文件 %d 处: %s" % (len(missing), missing[:3]))
        if orphans:
            hard.append("孤儿文件(未引用png) %d 张: %s" % (len(orphans), orphans[:3]))
    if mismatch:
        hard.append("表格列数不一致 %d 表: %s" % (len(mismatch), [m[0] for m in mismatch]))
    if key_fail:
        hard.append("关键词未命中 %d 个: %s" % (len(key_fail), key_fail[:3]))
    if old_residual:
        hard.append("旧残留未清零 %d 处: %s" % (len(old_residual), old_residual[:3]))
    # 6. G91/G93：流程图块结构硬闸门——块未闭合/语法行坏/块数与渲染图数不符/占位标记残留/源码被藏进注释，任一即红
    if fence_bad:
        hard.append("流程图块问题: %s" % fence_bad)
    if flow_bad:
        hard.append("流程图块内语法行异常 %d 处: %s" % (len(flow_bad), flow_bad[:3]))
    if hidden_flow:
        hard.append("流程图源码被藏进 HTML 注释 %d 处——注释里的流程图用户看不到，等于流程图没了；必须是可见的 ```mermaid 代码块（G93，2026-11-24 用户实证）" % hidden_flow)
    if not a.no_render_ok and flow_blocks != len(renders):
        hard.append("流程图块 %d 个 ≠ 渲染图 %d 张（每个流程图块须有对应的 流程图渲染_*.png；确无渲染库的环境可加 --no-render-ok）" % (flow_blocks, len(renders)))
    if markers:
        hard.append("占位标记残留 %d 处（采集器未替换成图片引用）: %s" % (len(markers), markers[:3]))
    if hard:
        print("VERIFY FAIL:")
        for h in hard:
            print("  ✗", h)
        sys.exit(1)
    print("VERIFY PASS ✅")

if __name__ == "__main__":
    main()
