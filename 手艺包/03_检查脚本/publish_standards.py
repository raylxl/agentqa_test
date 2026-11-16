# -*- coding: utf-8 -*-
"""publish_standards.py — 标准发布视图生成器（手艺包 v2.0，2026-11-16 立；v2.0.1 规则外置）

职责：从内部标准正本生成"通用发布视图"进本包 01_标准/——正本不动，发布视图每次重生成防漂移。
**引擎与规则分离（v2.0.1）**：清洗规则表含内部域词锚点，属内部资产放包外（--rules 传入，
默认找同级公司包/publish_rules.json）；包内仅留本引擎与 publish_rules.example.json 结构示例——
引擎本身零域词，可随包公开。

用法：python publish_standards.py [--src 正本目录] [--rules 规则.json] [--check]
  --check：生成后跑 generic_layer_check（公司词表）自验，红=失败。
规则四类操作见 publish_rules.example.json（rep 的引号形态自动归一化匹配）。
注意：本文件由编辑工具维护；Git Bash heredoc 喂中文会按 GBK 解码写坏文件（2026-11-16 实证）。
"""
import argparse
import io
import json
import re
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
PACK = HERE.parent

NOTE = "> 〔通用发布视图〕本文由内部标准正本经 publish_standards.py 自动生成（案例已中性化、内部注记已剥离、域沉淀节已归内部层）。方法本体与正本同步，修订记录见内部层。\n\n"
POST_OPS = [["drop_line", r"^\|\s*v\d+\.\d+\s*\|"]]   # 全局兜底：残留修订记录行


def _norm(s):
    """引号归一化：弯引号(U+201C/201D)→直引号（正本与规则表引号形态可能不一致，2026-11-16 实证）。"""
    return s.replace("\u201c", '"').replace("\u201d", '"')


def _drop_block(text, start_rx, end_rx):
    lines = text.splitlines(keepends=True)
    out, dropping, n = [], False, 0
    for ln in lines:
        if not dropping and re.search(start_rx, ln):
            dropping = True
            n += 1
            continue
        if dropping:
            if re.search(end_rx, ln):
                dropping = False
                out.append(ln)
            else:
                n += 1
            continue
        out.append(ln)
    return "".join(out), n


def _drop_section(text, title_rx):
    lines = text.splitlines(keepends=True)
    out, dropping, n = [], False, 0
    for ln in lines:
        if not dropping and re.search(title_rx, ln):
            dropping = True
            n += 1
            continue
        if dropping:
            if re.match(r"^#{1,2} ", ln):
                dropping = False
                out.append(ln)
            else:
                n += 1
            continue
        out.append(ln)
    return "".join(out), n


def apply_ops(text, ops, src_name):
    errs = []
    for op in ops:
        kind = op[0]
        if kind == "rep":
            old, new = op[1], op[2]
            i = _norm(text).find(_norm(old))
            if i < 0:
                errs.append(f"[RED] {src_name}: 定点替换未命中 → {old[:60]}…")
            else:
                text = text[:i] + new + text[i + len(old):]
        elif kind == "drop_line":
            text, _ = re.subn(op[1] + r".*\n?", "", text, flags=re.M)
        elif kind == "drop_block":
            text, _ = _drop_block(text, op[1], op[2])
        elif kind == "drop_section":
            text, _ = _drop_section(text, op[1])
    return text, errs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(PACK.parent.parent / "用例设计标准_我的定稿"))
    ap.add_argument("--rules", default=str(PACK.parent / "公司包" / "publish_rules.json"),
                    help="清洗规则表（内部资产，包外；结构见 publish_rules.example.json）")
    ap.add_argument("--check", action="store_true", help="生成后跑 generic_layer_check（公司词表）自验")
    a = ap.parse_args()
    src_dir, rules_path = Path(a.src), Path(a.rules)
    if not rules_path.exists():
        print(f"[RED] 规则表不存在：{rules_path}（内部资产不随包分发；示例见 publish_rules.example.json）")
        sys.exit(2)
    rules = json.loads(rules_path.read_text(encoding="utf-8"))
    dst_dir = PACK / "01_标准"
    all_errs, done = [], []
    for src_name, spec in rules.items():
        if src_name.startswith("_"):
            continue
        src = src_dir / src_name
        if not src.exists():
            all_errs.append(f"[RED] 正本缺失：{src}")
            continue
        text = io.open(src, encoding="utf-8").read()
        text, errs = apply_ops(text, spec["ops"], src_name)
        text, _ = apply_ops(text, POST_OPS, src_name)
        all_errs += errs
        io.open(dst_dir / spec["dst"], "w", encoding="utf-8", newline="\n").write(NOTE + text)
        done.append(spec["dst"])
    print(f"发布视图生成 {len(done)} 件 → 01_标准/（规则={rules_path.name}）")
    if all_errs:
        for e in all_errs:
            print(e)
        sys.exit(1)
    if a.check:
        wl = PACK.parent / "公司包" / "company_wordlist.json"
        r = subprocess.run([sys.executable, str(HERE / "generic_layer_check.py"), str(dst_dir),
                            "--config", str(wl)], capture_output=True)
        print((r.stdout + r.stderr).decode("utf-8", "replace")[-900:])
        sys.exit(r.returncode)


if __name__ == "__main__":
    main()
