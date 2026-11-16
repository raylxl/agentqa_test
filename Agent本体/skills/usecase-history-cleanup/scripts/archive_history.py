# -*- coding: utf-8 -*-
"""用例文件文件夹 · 历史版本归档清理脚本（usecase-history-cleanup）

默认 dry-run 只打印计划；--apply 才真移动并把台账追加到 历史版本\\归档说明.md。
规则与依据见同目录上级 SKILL.md 的判定规则表（R1~R8）。
"""
import argparse
import datetime
import json
import os
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")


def _find_company_cfg():
    env = os.environ.get("AGENT_COMPANY_JSON")
    if env and os.path.isfile(env):
        return env
    here = Path(__file__).resolve()
    for base in [here.parent, *here.parents]:
        direct = base / "agent-company.json"
        if direct.is_file():
            return str(direct)
        try:
            for child in base.iterdir():
                if not child.is_dir():
                    continue
                for candidate in (child / "agent-company.json", child / "公司包" / "agent-company.json"):
                    if candidate.is_file():
                        return str(candidate)
        except OSError:
            pass
    return None


def _load_profile():
    cfgp = _find_company_cfg()
    if not cfgp:
        return {}, None
    try:
        with open(cfgp, "r", encoding="utf-8") as f:
            return json.load(f), cfgp
    except (OSError, ValueError):
        return {}, cfgp


def _profile_policy(profile):
    policy = profile.get("archive_policy") or {}
    root = ((profile.get("paths") or {}).get("用例文件") or "")
    return {
        "root": root,
        "archive_dirname": policy.get("archive_dirname", "archive"),
        "ledger_name": policy.get("ledger_name", "archive-ledger.md"),
        "name_patterns": tuple(policy.get("name_patterns", [])),
        "keep_patterns": tuple(policy.get("keep_patterns", [])),
        "backup_patterns": tuple(policy.get("backup_patterns", [])),
        "debug_patterns": tuple(policy.get("debug_patterns", [])),
        "version_regex": policy.get("version_regex", r"^(?P<family>.+)_v(?P<ver>\d+(?:\.\d+)?)(?P<ext>\.[A-Za-z0-9]+)$"),
    }


def ver_key(ver_str):
    return tuple(int(x) for x in ver_str.split("."))


def classify_root(root, policy):
    """只看根目录一层，归档判据全部从公司 profile 读取。"""
    moves, keeps, ambigs = [], [], []
    entries = sorted(os.listdir(root))
    archive_dir = policy["archive_dirname"]
    name_patterns = policy["name_patterns"]
    keep_patterns = policy["keep_patterns"]
    backup_patterns = policy["backup_patterns"]
    debug_patterns = policy["debug_patterns"]
    try:
        version_re = re.compile(policy["version_regex"])
    except re.error:
        version_re = re.compile(r"^(?P<family>.+)_v(?P<ver>\d+(?:\.\d+)?)(?P<ext>\.[A-Za-z0-9]+)$")

    families = defaultdict(list)
    for name in entries:
        if os.path.isfile(os.path.join(root, name)):
            match = version_re.match(name)
            if match:
                families[(match.group("family"), match.group("ext"))].append((ver_key(match.group("ver")), name))
    current_by_family = {}
    for key, versions in families.items():
        versions.sort(key=lambda item: item[0])
        current_by_family[key] = versions[-1][1]

    for name in entries:
        path = os.path.join(root, name)
        if name == archive_dir:
            continue
        if any(token in name for token in name_patterns):
            moves.append((name, "目录" if os.path.isdir(path) else "文件", "profile name_patterns", "—"))
            continue
        if os.path.isdir(path):
            if any(token in name for token in keep_patterns):
                keeps.append((name, "目录", "profile keep_patterns", "—"))
            elif any(token in name for token in backup_patterns + debug_patterns):
                moves.append((name, "目录", "profile backup/debug_patterns", "—"))
            else:
                ambigs.append((name, "目录", "规则未覆盖的目录", "—"))
            continue
        match = version_re.match(name)
        if match:
            current = current_by_family[(match.group("family"), match.group("ext"))]
            if name == current:
                keeps.append((name, "文件", "同名族最高版本（现行）", current))
            else:
                moves.append((name, "文件", "同名族旧版本", current))
        elif any(token in name for token in backup_patterns + debug_patterns):
            moves.append((name, "文件", "profile backup/debug_patterns", "—"))
        else:
            keeps.append((name, "文件", "无版本后缀/单版本，非归档目标", "—"))
    return moves, keeps, ambigs



def print_report(moves, keeps, ambigs, archive_dir):
    print(f"=== 计划移入 {archive_dir}\\（{len(moves)} 项）===")
    for name, typ, reason, cur in moves:
        print(f"  [移入|{typ}] {name}  ← {reason}")
    print(f"\n=== 保留根目录（{len(keeps)} 项）===")
    for name, typ, reason, cur in keeps:
        print(f"  [保留|{typ}] {name}  ← {reason}")
    print(f"\n=== 存疑待拍板（{len(ambigs)} 项，本次不动）===")
    for name, typ, reason, cur in ambigs:
        print(f"  [存疑|{typ}] {name}  ← {reason}")


def apply_moves(root, moves, archive_dir):
    arch = os.path.join(root, archive_dir)
    os.makedirs(arch, exist_ok=True)
    ok, skipped = [], []
    for name, typ, reason, cur in moves:
        src, dst = os.path.join(root, name), os.path.join(arch, name)
        if os.path.exists(dst):
            skipped.append((name, "目标已存在同名，跳过"))
            continue
        shutil.move(src, dst)
        ok.append(name)
    return ok, skipped


def update_ledger(root, moves, archive_dir, ledger_name):
    arch = os.path.join(root, archive_dir)
    ledger = os.path.join(arch, ledger_name)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        f"\n## 增量归档 {now}\n",
        "| 类型 | 文件/目录 | 归档原因 | 现行版本（留在根目录） |",
        "|---|---|---|---|",
    ]
    for name, typ, reason, cur in moves:
        lines.append(f"| {typ} | {name} | {reason} | {cur or '—'} |")
    with open(ledger, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return ledger


def main():
    profile, _ = _load_profile()
    policy = _profile_policy(profile)
    default_root = policy["root"]
    ap = argparse.ArgumentParser(description="用例文件历史版本归档（默认dry-run）")
    ap.add_argument("--root", default=default_root or None, help="用例文件根目录（缺少公司配置时必须传入）")
    ap.add_argument("--apply", action="store_true", help="执行移动（默认只打印计划）")
    args = ap.parse_args()

    if not args.root:
        print("未配置 paths.用例文件；请传入 --root。未执行任何操作。")
        raise SystemExit(2)
    if not os.path.isdir(args.root):
        print("归档根目录不存在，未执行任何操作。")
        raise SystemExit(1)

    moves, keeps, ambigs = classify_root(args.root, policy)
    print_report(moves, keeps, ambigs, policy["archive_dirname"])

    if not args.apply:
        print("\n(dry-run 未做任何改动；确认后加 --apply 执行)")
        return

    ok, skipped = apply_moves(args.root, moves, policy["archive_dirname"])
    print("\n=== 执行结果 ===")
    for name in ok:
        print(f"  OK   {name}")
    for name, why in skipped:
        print(f"  SKIP {name} ← {why}")
    if moves:
        ledger = update_ledger(args.root, moves, policy["archive_dirname"], policy["ledger_name"])
        print(f"\n台账已追加：{ledger}")



if __name__ == "__main__":
    main()
