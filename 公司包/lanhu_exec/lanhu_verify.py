#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
lanhu_verify.py - 蓝湖需求文档重写后强制校验（标准方法 v1 / R6+R7）

检查项:
  1. 图片引用 ![](x) <-> imgdir 实际文件，缺则报 MISSING
  2. MD 表格逐表 `|` 计数一致；--fix 时按表头列数自动补齐尾部空单元格
  3. --keys 文件：关键内容必须命中（每行一个关键词）
  4. --olds 文件：旧错误/拍扁残留必须清零（每行一个，命中报 RESIDUAL）
  5. G91 流程图块：``` 围栏成对；mermaid 块内只允许流程图语法行；流程图块数 == 流程图渲染_*.png 张数；
     @@…@@ 占位标记不得残留（--no-render-ok 可放宽"块数==渲染图数"）

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
    ap.add_argument("--no-render-ok", action="store_true", help="G91：允许流程图块没有渲染图（无渲染库的环境只出源码时用）")
    a = ap.parse_args()

    doc = open(a.doc, encoding="utf-8").read()
    base = os.path.dirname(a.doc)

    # 0. G91：围栏代码块（```mermaid 流程图源码）结构校验
    #    ① 围栏必须成对 ② 块内只允许流程图语法行（防残留清理/拼接把语法行删改坏）③ 流程图块数 == 渲染图数
    vlines = doc.splitlines()
    fence_open, fence_lang, fence_bad, mermaid_blocks, mermaid_bad = False, "", [], 0, []
    NODE = re.compile(r'^\s*n\d+(\["[^"]*"\]|\{"[^"]*"\}|\("[^"]*"\))\s*$')
    EDGE = re.compile(r'^\s*n\d+ -->(\|"[^"]*"\|)? n\d+\s*$')
    HEADLINE = re.compile(r'^flowchart (LR|RL|TD|BT)\s*$')
    in_mermaid, blk_no = False, 0
    for ln in vlines:
        st = ln.strip()
        if st.startswith("```"):
            if not fence_open:
                fence_open, fence_lang = True, st[3:].strip().lower()
                if fence_lang == "mermaid":
                    mermaid_blocks += 1
                    in_mermaid, blk_no = True, mermaid_blocks
            else:
                fence_open, fence_lang, in_mermaid = False, "", False
            continue
        if in_mermaid and st and not (HEADLINE.match(st) or NODE.match(st) or EDGE.match(st)):
            mermaid_bad.append("块%d: %s" % (blk_no, st[:50]))
    if fence_open:
        fence_bad.append("围栏未闭合（```mermaid 开了没关）")
    renders = sorted(f for f in (os.listdir(a.imgdir) if os.path.isdir(a.imgdir) else []) if f.startswith("流程图渲染_") and f.lower().endswith(".png"))
    print("MERMAID blocks", mermaid_blocks, "renders", len(renders), "fence_bad", fence_bad, "bad_lines", mermaid_bad[:4])
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
    # 6. G91：流程图块结构硬闸门——围栏坏/语法行坏/块数与渲染图数不符/占位标记残留，任一即红
    if fence_bad:
        hard.append("流程图围栏问题: %s" % fence_bad)
    if mermaid_bad:
        hard.append("流程图块内语法行异常 %d 处: %s" % (len(mermaid_bad), mermaid_bad[:3]))
    if not a.no_render_ok and mermaid_blocks != len(renders):
        hard.append("流程图块 %d 个 ≠ 渲染图 %d 张（每个流程图块须有对应的 流程图渲染_*.png；确无渲染库的环境可加 --no-render-ok）" % (mermaid_blocks, len(renders)))
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
