#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""质疑证书存在性机器闸（2026-11-19 立·Mac 真机 C5 堵口：门禁全绿≠可交付，证书在才算）

背景：pipeline 规定"生成→自动接 challenger（质疑→修复→收敛→证书）→停"，但宿主降级
（WorkBuddy 无 hooks、技能触发不稳）时质疑步被跳过而结构/治理门禁照样全绿——
本闸把"证书文件存在"变成机器判据，堵"门禁全绿即交付"（首例：外部参考价 236 条未经质疑）。

用法：
  python cert_gate.py <用例册md路径> [--dir <证书目录，默认册同目录>] [--allow-legacy]
退出码：0=证书在；3=无证书（禁入执行段/交付）；2=参数/路径错
命名正本=真实签发形：<族前缀>_用例完成证书_v{N}.md（变体 …_完成证书_v1.md，如全流程场景册）；
族前缀=册名去掉 _测试用例/_用例册/_全流程场景用例_vN 尾段。
"""
import argparse
import re
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("book", help="用例册 md 路径")
    ap.add_argument("--dir", help="证书查找目录（默认=册所在目录）")
    ap.add_argument("--allow-legacy", action="store_true", help="历史豁免册放行（只警告，须在报告注明）")
    a = ap.parse_args()

    book = Path(a.book)
    if not book.is_file():
        print(f"[红] 册不存在：{book}")
        sys.exit(2)
    d = Path(a.dir).resolve() if a.dir else book.parent
    m = re.match(r"^(.*?)[_](?:测试用例|用例册|全流程场景用例)[_]?v[\d.]+$", book.stem)
    prefix = (m.group(1) if m else book.stem).replace("[", "[[]").replace("*", "[*]").replace("?", "[?]")
    hits = sorted(d.glob(f"{prefix}*证书*.md"))
    if hits:
        latest = hits[-1]
        note = f"（共 {len(hits)} 份，最新 v{re.search(r'_v([\\d.]+)', latest.stem).group(1) if re.search(r'_v([\\d.]+)', latest.stem) else '?'}）" if len(hits) > 1 else ""
        print(f"[OK ] 完成证书：{latest.name}{note}")
        sys.exit(0)
    if a.allow_legacy:
        print(f"[WARN] 无证书，--allow-legacy 放行：{book.name}（须在测试报告注明未经独立质疑）")
        sys.exit(0)
    print(f"[红] {d} 下无『{prefix}*证书*.md』——生成方未经 usecase-challenger 独立质疑签发，禁入执行段/交付")
    print("     生成方不自证（pipeline 规定 go=生成→质疑→证书）；历史豁免册加 --allow-legacy 并注明")
    sys.exit(3)


if __name__ == "__main__":
    main()
