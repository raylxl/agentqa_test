# -*- coding: utf-8 -*-
"""hook 自测：使用当前 profile 的真实路径键，不依赖具体公司菜单或绝对路径。"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
HOOKS_ROOT = HERE.parents[1].parent / "Agent本体" / "hooks"
if str(HOOKS_ROOT) not in sys.path:
    sys.path.insert(0, str(HOOKS_ROOT))
HOOK = HOOKS_ROOT / "reread_reminder.py"

try:
    import _company_profile as profile_mod
    profile, _ = profile_mod.load_company_profile()
except Exception:
    profile = {}
paths = profile.get("paths") or {}
agent_root = Path(paths.get("Agent本体", HERE.parents[1]))
HOOK = agent_root / "hooks" / "reread_reminder.py"
std = paths.get("标准体系", "<标准根>")
ledger = paths.get("需求流水线台账", "<台账>")
skills = paths.get("技能根", "<技能根>")
company = paths.get("公司包", "<公司包>")

cases = [
    ("命中标准", str(Path(std) / "通用用例设计标准_v1.md"), True),
    ("命中台账", ledger, True),
    ("命中技能", str(Path(skills) / "usecase-orchestrator" / "SKILL.md"), True),
    ("命中公司包", str(Path(company) / "agent-company.json"), True),
    ("不命中", "<workspace>/random.md", False),
    ("无路径", None, False),
]

ok = True
for name, fp, expect in cases:
    payload = {"tool_name": "Edit", "tool_input": ({"file_path": fp} if fp else {})}
    r = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload, ensure_ascii=False).encode("utf-8"), capture_output=True)
    hit = bool(r.stdout.decode("utf-8", errors="replace").strip())
    good = hit == expect
    ok = ok and good
    print(f"[{ '✓' if good else '✗' }] {name}: exit={r.returncode} hit={hit}")
print("\n全部通过" if ok else "\n存在失败")
sys.exit(0 if ok else 1)
