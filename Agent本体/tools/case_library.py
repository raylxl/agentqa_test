#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Total case-library proxy for machine-independent skill commands.

The proxy reads paths.总用例库 from 公司包/agent-company.json, validates the
configured library, then delegates to its scripts with UTF-8 IO. Skills call
this proxy instead of embedding a machine-specific library path.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

AGENT_ROOT = Path(__file__).resolve().parents[1]
CONFIG = AGENT_ROOT.parent / "公司包" / "agent-company.json"

TARGETS = {
    "gateway": "case_library.py",
    "bridge": Path("schemas") / "md_to_changeset.py",
    "execution": Path("schemas") / "write_execution.py",
    "excel": Path(".总用例库_用例清单.ref") / "build.py",
    "metadata": Path("schemas") / "主数据.yaml",
}


def emit(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False, indent=2))
    return code


def library_root():
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
        raw = cfg["paths"]["总用例库"]
    except (OSError, ValueError, KeyError) as exc:
        return None, f"读取 paths.总用例库 失败: {exc}"
    root = Path(os.path.expandvars(os.path.expanduser(raw)))
    return root, None


def child_env():
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    return env


def run_target(target, args):
    result = subprocess.run(
        [sys.executable, str(target), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=child_env(),
    )
    if result.stdout:
        sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    return result.returncode


def normalize_merge_path(root, args):
    if len(args) >= 2 and args[0] == "merge" and not Path(args[1]).is_absolute():
        args[1] = str(root / args[1])


def main():
    if len(sys.argv) < 2:
        return emit({
            "ok": False,
            "error": "用法: case_library.py {root|gateway|bridge|execution|excel|metadata} [参数...]",
        }, 2)

    command, args = sys.argv[1], sys.argv[2:]
    root, error = library_root()
    if error:
        return emit({"ok": False, "error": error}, 2)

    if command in ("root", "check"):
        missing = [name for name, rel in TARGETS.items() if not (root / rel).exists()]
        return emit({
            "ok": not missing,
            "配置文件": str(CONFIG),
            "总用例库": str(root),
            "缺失目标": missing,
        }, 0 if not missing else 1)

    if command not in TARGETS:
        return emit({"ok": False, "error": f"未知命令 {command}", "可用": list(TARGETS)}, 2)

    target = root / TARGETS[command]
    if not target.exists():
        return emit({"ok": False, "error": f"目标不存在: {target}"}, 1)

    if command == "metadata":
        try:
            sys.stdout.write(target.read_text(encoding="utf-8"))
            return 0
        except OSError as exc:
            return emit({"ok": False, "error": f"读取主数据失败: {exc}"}, 1)

    if command == "gateway":
        normalize_merge_path(root, args)
    return run_target(target, args)


if __name__ == "__main__":
    sys.exit(main())
