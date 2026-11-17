# -*- coding: utf-8 -*-
"""compare_md_xmind_v2 —— MD 用例 vs XMind 成品 逐条数据终验（差异=0 才交付）

支持模式（与 xmind_unified_generator_v2 一致）：
  new  = §5.5 新标（## 章 / ### 节 / #### TC-XX-nn 标题（P0）/ 五列竖排 label 行）
  row7 = 七列标准行（2026-10-31 三套格式统一新增：| TC-编号 | 名称 | P0 | 前置 | 步骤 | 预期 | 判定依据 |）
  old  = WorkBuddy V21（## 模块 / #### TC_001｜名称 [P0] / 加粗表）
比对口径：逐用例比对 优先级 + 前置条件/操作步骤(测试步骤)/预期结果；
字段等价判定对 <br> 与真实换行做双向归一（XMind 标题以 <br> 或换行承载多行，语义等价）。
用法: python compare_md_xmind_v2.py <md路径> <xmind路径>
"""
import html
import io
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xmind_unified_generator_v2 import parse_md, parse_new, parse_old, parse_row7

FIELD_KEYS_NEW = ["前置条件", "操作步骤", "预期结果"]
FIELD_KEYS_OLD = ["前置条件", "测试步骤", "预期结果"]
BS = chr(92)  # 反斜杠（避免转义环境差异）


def norm(s):
    return s.replace(chr(10), '<br>').replace(chr(13), '').replace('**', '')


def md_cases(md_path):
    mode, lines, _ = parse_md(md_path)
    cases = {}
    if mode == "row7":
        for ch in parse_row7(lines):
            for sec in ch["sections"]:
                for c in sec["cases"]:
                    cases[c["id"]] = {"prio": c["prio"], "fields": c["fields"]}
        keys = FIELD_KEYS_NEW
    elif mode == "new":
        for ch in parse_new(lines):
            for sec in ch["sections"]:
                for c in sec["cases"]:
                    cases[c["id"]] = {"prio": c["prio"], "fields": c["fields"]}
        keys = FIELD_KEYS_NEW
    else:
        for mod in parse_old(lines):
            for c in mod["cases"]:
                cases[c["num"]] = {"prio": c["prio"], "fields": c["fields"]}
        keys = FIELD_KEYS_OLD
    return cases, mode, keys


def xmind_cases(xp):
    with zipfile.ZipFile(xp) as z:
        root = ET.fromstring(z.read("content.xml"))
    ln = lambda tag: tag.rsplit("}", 1)[-1] if "}" in tag else tag

    def title(tp):
        for c in tp:
            if ln(c.tag) == "title":
                return html.unescape(c.text or "")
        return ""

    def kids(tp):
        for c in tp:
            if ln(c.tag) == "children":
                for t in c:
                    if ln(t.tag) == "topics" and t.get("type") == "attached":
                        return [x for x in t if ln(x.tag) == "topic"]
        return []

    sheet = next(c for c in root if ln(c.tag) == "sheet")
    root_topic = next(c for c in sheet if ln(c.tag) == "topic")
    out = {}
    for l2 in kids(root_topic):
        for l3 in kids(l2):
            t3 = title(l3)
            m = re.match(r"^(TC[-_][A-Z0-9_\-]+)", t3)
            if not m:
                continue
            f = {}
            for l4 in kids(l3):
                t4 = title(l4)
                for lbl in ("优先级", "前置条件", "操作步骤", "测试步骤", "预期结果"):
                    if t4.startswith(lbl + "："):
                        f[lbl] = t4[len(lbl) + 1:]
                        break
            out[m.group(1)] = f
    return out


def main():
    if len(sys.argv) != 3:
        print("用法: python compare_md_xmind_v2.py <md路径> <xmind路径>")
        sys.exit(1)
    mdp, xp = sys.argv[1], sys.argv[2]
    md, mode, keys = md_cases(mdp)
    xm = xmind_cases(xp)

    diffs = []
    only_md = sorted(set(md) - set(xm))
    only_xm = sorted(set(xm) - set(md))
    if only_md:
        diffs.append("XMind 缺 %d 条: %s" % (len(only_md), only_md[:5]))
    if only_xm:
        diffs.append("XMind 多 %d 条: %s" % (len(only_xm), only_xm[:5]))

    p_rx = re.compile(r"P[0-3]")
    for cid in sorted(set(md) & set(xm)):
        exp_prio = md[cid]["prio"]
        exp_fields = md[cid]["fields"]
        got = xm[cid]
        gm = p_rx.search(got.get("优先级", ""))
        if gm is None or gm.group(0) != exp_prio:
            diffs.append("%s 优先级: MD=%s XMind=%s" % (cid, exp_prio, got.get("优先级", "")))
        for k in keys:
            exp = exp_fields.get(k, "")
            got_v = got.get(k, "")
            if not exp:
                diffs.append("%s %s: MD 侧字段缺失/为空（检查表格行是否丢行）" % (cid, k))
                continue
            _e, _g = norm(exp), norm(got_v)
            if _e != _g:
                i = next((j for j in range(min(len(_e), len(_g))) if _e[j] != _g[j]), min(len(_e), len(_g)))
                diffs.append("%s %s: 首差@%d MD=%s XMind=%s" % (cid, k, i, _e[max(0, i - 20):i + 20], _g[max(0, i - 20):i + 20]))

    print("MD 用例 %d 条 / XMind 用例 %d 条 / 模式=%s" % (len(md), len(xm), {"new": "§5.5 新标", "row7": "七列标准行"}.get(mode, "旧 WorkBuddy")))
    if diffs:
        print("差异 %d 处：" % len(diffs))
        for d in diffs[:20]:
            print("  - %s" % d)
        if len(diffs) > 20:
            print("  …（其余 %d 处略）" % (len(diffs) - 20))
        sys.exit(1)
    print("差异 = 0，数据终验通过 ✅")


if __name__ == "__main__":
    main()
