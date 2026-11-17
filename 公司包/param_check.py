# -*- coding: utf-8 -*-
"""
param_check.py — 参数化改造护航校验器（快照一致性 + 配置可达）
用法:
  python param_check.py --snapshot   # 改造前：抓取目标文件全部硬编码值 → param_snapshot.json
  python param_check.py --check      # 每批改造后：快照值必须 ∈ (现存字面量 ∪ 配置值 ∪ 配置路径前缀)
不变量：改造零信息丢失——旧硬编码值要么仍在文件里，要么已迁入 agent-company.json 可解析。
exit 1 = 红项存在。
"""
import re
import sys
import json
import argparse
from pathlib import Path

HERE = Path(__file__).resolve().parent
SNAPSHOT = HERE / "param_snapshot.json"
CONFIG = HERE / "agent-company.json"


def _target_base():
    """流程技能根的上级目录（2026-11-14 目录化重构）：优先公司配置 paths.技能根 的父目录；
    取不到则在同级各目录里找含 skills/usecase-orchestrator 者（目录改名免疫）；兜底 HERE。"""
    try:
        root = json.loads(CONFIG.read_text(encoding="utf-8")).get("paths", {}).get("技能根")
        if root and Path(root).is_dir():
            return Path(root).parent
    except (OSError, ValueError):
        pass
    for d in sorted(HERE.parent.iterdir()):
        if (d / "skills" / "usecase-orchestrator").is_dir():
            return d
    return HERE


BASE = _target_base()
SKILL_DIR = BASE / "skills"
# 十个流程技能 + 三个组装族脚本 + 归档脚本
TARGETS = {
    "skills/requirement-qa-loop/SKILL.md": None,
    "skills/requirement-qa-loop/references/qa-formats.md": None,
    "skills/usecase-generator/SKILL.md": None,
    "skills/usecase-challenger/SKILL.md": None,
    "skills/usecase-pipeline/SKILL.md": None,
    "skills/usecase-pipeline/references/brief-and-prompts.md": None,
    "skills/usecase-external-compare/SKILL.md": None,
    "skills/usecase-executor/SKILL.md": None,
    "skills/usecase-feedback-loop/SKILL.md": None,
    "skills/usecase-history-cleanup/SKILL.md": None,
    "skills/usecase-orchestrator/SKILL.md": None,
    "skills/usecase-qc/SKILL.md": None,
    "skills/usecase-pipeline/scripts/assemble.py": None,
    "skills/usecase-pipeline/scripts/governance_manifest.py": None,
    "skills/usecase-generator/scripts/assemble_universal.py": None,
    "skills/usecase-history-cleanup/scripts/archive_history.py": None,
}

ABS_PATH = re.compile(r'[A-Za-z]:[/\\][^\s）)"\'，。；|`）]+')
QUOTED = re.compile(r'''["']([^"']{4,})["\']''')


def wanted(v: str) -> bool:
    """只抓参数化目标类字面量：绝对路径 / FIN需求ID / 分章目录 / 归档常量"""
    if re.match(r'[A-Za-z]:[/\\]', v):
        return True
    if "FIN-2026" in v:
        return True
    if v.endswith("分章"):
        return True
    return v in ("历史版本", "归档说明.md")


def extract(path: Path):
    vals = set()
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return vals
    for m in ABS_PATH.finditer(text):
        vals.add(m.group(0).replace("\\", "/").rstrip(".,；)）`"))
    for m in QUOTED.finditer(text):
        v = m.group(1)
        if wanted(v):
            vals.add(v.replace("\\", "/"))
    return vals


def norm(v: str) -> str:
    return v.replace("\\", "/").rstrip("/")


def flatten_config(cfg):
    vals, prefixes = set(), set()
    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        elif isinstance(x, str):
            vals.add(norm(x))
            # 前缀=绝对路径形态：Windows 盘符 或 POSIX（Mac 部署）。路径允许空格；只排除模板占位符。
            if "{" not in x and (re.match(r'^[A-Za-z]:[/\\]', x) or x.startswith("/")):
                prefixes.add(norm(x))
    walk(cfg)
    return vals, prefixes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    current = {}
    for rel in TARGETS:
        p = BASE / rel
        if p.exists():
            got = extract(p)
            if got:
                current[rel] = sorted(got)

    if args.snapshot:
        SNAPSHOT.write_text(json.dumps(current, ensure_ascii=False, indent=1), encoding="utf-8")
        total = sum(len(v) for v in current.values())
        print(f"[SNAPSHOT] {len(current)} 文件 {total} 值 -> {SNAPSHOT}")
        return

    if not SNAPSHOT.exists():
        print("[RED] 无快照，先 --snapshot"); sys.exit(1)
    snap = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    cfg = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {}
    cfg_vals, cfg_prefixes = flatten_config(cfg)
    alias = {norm(k): norm(v) for k, v in (cfg.get("路径迁移别名", {}) or {}).items()}

    # 配置路径可达性
    missing_paths = [p for p in cfg_prefixes if not Path(p).exists()]

    red = []
    cur_all = set()
    for rel, vals in current.items():
        cur_all.update(vals)
    for rel, vals in snap.items():
        for v in vals:
            nv = norm(v)
            # 路径迁移别名（目录改名/搬迁登记）：旧前缀按别名换成新前缀后再判
            mv = nv
            for ok_, nk_ in alias.items():
                if nv == ok_ or nv.startswith(ok_ + "/"):
                    mv = nk_ + nv[len(ok_):]
                    break
            ok = (nv in cur_all or nv in cfg_vals or mv in cur_all or mv in cfg_vals
                  or any(nv.startswith(cp + "/") or mv.startswith(cp + "/") or mv == cp
                         for cp in cfg_prefixes))
            if not ok:
                red.append((rel, v))
    # 快照文件被删/改名也要红
    for rel in snap:
        if rel not in current and not (BASE / rel).exists():
            red.append((rel, "【文件缺失】"))

    print(f"[CHECK] 快照{sum(len(v) for v in snap.values())}值 | 现存字面量{len(cur_all)} | 配置值{len(cfg_vals)}+前缀{len(cfg_prefixes)}")
    if missing_paths:
        for p in missing_paths:
            print(f"  [RED-配置路径不存在] {p}")
    if red:
        for rel, v in red:
            print(f"  [RED-信息丢失] {rel} :: {v}")
        sys.exit(1)
    print("[CHECK] PASS —— 零信息丢失，配置路径全可达" if not missing_paths else "[CHECK] FAIL")
    sys.exit(0 if not red and not missing_paths else 1)


if __name__ == "__main__":
    main()
