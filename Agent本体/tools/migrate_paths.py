# -*- coding: utf-8 -*-
"""migrate_paths.py — 分发包换路径部署的一键路径换算（2026-11-16 立，配套部署说明 v2「仅同路径」改口）

背景：jt_chrome 数百个执行脚本内嵌 D:\\ZCodetest 绝对路径，agent-company.json 的 paths/迁移别名同源；
手工只改 14 条 paths 救不了脚本层 —— 本工具做全量换算。

换路径部署三步（顺序执行）：
  ① python migrate_paths.py <新根路径>            # dry-run：只列改动计划，不落盘
     python migrate_paths.py <新根路径> --apply    # 真改：改前把原文件快照备份到 _migrate_backup_<时间戳>/
  ② python rewire.py --repair                     # 重建联接（.zcode\\skills、用户级技能位、hooks）
  ③ python ../公司包/param_check.py --check        # 机检应回全绿（迁移别名已登记，按别名换算）

换算范围：agentqa_test + jt_chrome 下 .py/.js/.cjs/.ps1/.json/.sh/.bat 文本件中的三种写法
  D:\\ZCodetest / D:/ZCodetest / D:\\\\ZCodetest（同形保留：正斜杠→正斜杠、反斜杠→反斜杠），
  并在 agent-company.json 的 路径迁移别名 登记 "D:/ZCodetest" → 新根。
不碰：需求用例库/标准体系等文档资产（历史件保持原样，别名机制兜底显示）、agent-secrets.json（凭证红线）。
已知边界：用户名类路径（C:\\Users\\<发起人>）不换算 —— 核心件已改动态解析，剩余两处 mem_*_1109.py
  属发起人记忆库事故件，不属同事可用件。
"""
import argparse
import json
import shutil
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

AGENT_ROOT = Path(__file__).resolve().parents[2]      # …\\agentqa_test
WORKSPACE = AGENT_ROOT.parent                          # …\\（jt_chrome 所在层）
SCAN_DIRS = [AGENT_ROOT, WORKSPACE / "jt_chrome"]
EXTS = {".py", ".js", ".cjs", ".ps1", ".json", ".sh", ".bat", ".command"}
SKIP_NAMES = {"node_modules", "__pycache__", ".git", "dist", "locks", ".playwright-cli"}
SKIP_FILES = {"agent-secrets.json", "migrate_paths.py",   # 凭证红线；本工具自身（防自替换破坏别名登记）
              "deploy_colleague.py"}                       # 部署器自身（内嵌 D:\ZCodetest 替换源串，被换即自我破坏——Mac 首验 R2 实锤）
OLD_FWD = "D:/ZCodetest"

# ── 包内布局 v2（2026-11-17 用户拍板"解压后=agentqa_test+说明件"）──
# 工作区正本形态 → 同事包内形态：三资产从部署根收进三包（标准体系/执行工具→公司包；工具链→手艺包05）
# 仅作用于同事部署包（migrate 只在包解压根跑，工作区正本不经此路径）。
LAYOUT_MAP = [
    ("MD转XMind生成工具集/07_新标准工具链", "agentqa_test/手艺包/05_交付工具链/07_新标准工具链"),
    ("MD转XMind生成工具集\\07_新标准工具链", "agentqa_test/手艺包/05_交付工具链/07_新标准工具链"),
    ("用例设计标准_我的定稿", "agentqa_test/公司包/标准体系"),
    ("jt_chrome", "agentqa_test/公司包/执行工具"),
]
_ROOT_FORMS = ["D:/ZCodetest", "D:\\ZCodetest", "D:\\\\ZCodetest", "d:/ZCodetest", "d:\\ZCodetest", "d:\\\\ZCodetest"]

# 三种字节形态（正/双反/单反）× 盘符大小写两种，替换后同形保留
FORMS = [
    ("D:/ZCodetest", "{fwd}"),
    ("D:\\\\ZCodetest", "{dbl}"),
    ("D:\\ZCodetest", "{sgl}"),
    ("d:/ZCodetest", "{fwd}"),
    ("d:\\\\ZCodetest", "{dbl}"),
    ("d:\\ZCodetest", "{sgl}"),
]


def norm_root(s):
    s = s.strip().replace("\\", "/").replace("\\\\", "/").rstrip("/")
    return s


def main():
    ap = argparse.ArgumentParser(description="换路径部署一键换算（默认 dry-run）")
    ap.add_argument("new_root", help="新根路径，如 E:/mytest")
    ap.add_argument("--apply", action="store_true", help="真改（默认只预览）")
    a = ap.parse_args()

    new_fwd = norm_root(a.new_root)
    if not root_ok(new_fwd):
        sys.exit(f"[RED] 新根路径异常：{new_fwd}")
    if new_fwd.lower() == OLD_FWD.lower():
        sys.exit("[RED] 新根与旧根相同（D:/ZCodetest），无需迁移")
    if new_fwd.startswith("/"):
        # Mac/POSIX 新根：三种旧写法（正斜杠/双反/单反）一律换为正斜杠形态——目标系统只认这个
        repl = {"fwd": new_fwd, "dbl": new_fwd, "sgl": new_fwd}
    else:
        repl = {"fwd": new_fwd, "dbl": new_fwd.replace("/", "\\\\"),
                "sgl": new_fwd.replace("/", "\\")}

    # ── 收集与统计 ──
    plan = []          # (file, counts_by_form)
    scanned = 0
    for base in SCAN_DIRS:
        if not base.exists():
            print(f"[WARN] 扫描目录不存在，跳过：{base}")
            continue
        for p in base.rglob("*"):
            if not p.is_file() or p.suffix.lower() not in EXTS:
                continue
            parts = {x.name for x in p.parents}
            if parts & SKIP_NAMES or p.name in SKIP_FILES:
                continue
            if "_migrate_backup_" in str(p):
                continue
            scanned += 1
            raw = p.read_text(encoding="utf-8", errors="surrogateescape")
            counts = {form: raw.count(form) for form, _ in FORMS}
            if any(counts.values()):
                plan.append((p, counts))

    total = sum(sum(c.values()) for _, c in plan)
    print(f"扫描 {scanned} 文本件，命中 {len(plan)} 文件 / {total} 处路径引用")
    print(f"换算：D:/ZCodetest → {new_fwd}（三种写法同形保留）")
    for p, c in sorted(plan, key=lambda x: -sum(x[1].values()))[:20]:
        mark = "/".join(f"{k}x{v}" for k, v in c.items() if v)
        print(f"  {p.relative_to(WORKSPACE)}  [{mark}]")
    if len(plan) > 20:
        print(f"  … 其余 {len(plan) - 20} 文件略")

    if not a.apply:
        print("\n[dry-run] 未落盘。确认无误后加 --apply 执行。")
        return

    # ── 备份 + 落改 ──
    stamp = time.strftime("%Y%m%d_%H%M%S")
    backup_dir = Path(__file__).parent / f"_migrate_backup_{stamp}"
    for p, _ in plan:
        dst = backup_dir / p.relative_to(WORKSPACE)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dst)
    print(f"\n已备份 {len(plan)} 件原文件 → {backup_dir.name}/")

    for p, _ in plan:
        raw = p.read_text(encoding="utf-8", errors="surrogateescape")
        # ① 布局映射（长前缀优先）：旧根+旧子路径（三写法）→ 旧根占位+新子路径（归一正斜杠根，②步再整体换新根）
        for old_sub, new_sub in LAYOUT_MAP:
            for rf in _ROOT_FORMS:
                raw = raw.replace(rf + "/" + old_sub, "D:/ZCodetest/" + new_sub)
                raw = raw.replace(rf + "\\" + old_sub.replace("/", "\\"), "D:/ZCodetest/" + new_sub)
        # ② 根替换（同形保留）
        for form, tpl in FORMS:
            raw = raw.replace(form, tpl.format(**repl))
        p.write_text(raw, encoding="utf-8", errors="surrogateescape")

    # ── 迁移别名登记（在文本换算后的 agent-company.json 上追加 old→new）──
    cfg_path = None
    for d in sorted(AGENT_ROOT.iterdir()):
        f = d / "agent-company.json"
        if not d.name.startswith(".") and d.is_dir() and f.exists():
            cfg_path = f
            break
    if cfg_path:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        alias = cfg.setdefault("路径迁移别名", {})
        # 布局映射别名先登记（param_check 首命中即换算：长键必须排在根键之前）
        for old_sub, new_sub in LAYOUT_MAP:
            alias[f"D:/ZCodetest/{old_sub}"] = f"{new_fwd}/{new_sub}"
        alias[OLD_FWD] = new_fwd
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"迁移别名已登记：根+布局映射{len(LAYOUT_MAP)}条（{cfg_path.name}）")
    else:
        print("[WARN] 未定位到 agent-company.json，别名未登记（机检可能红，请手工补）")

    print("\n完成。后续两步：")
    print("  ① python " + str(Path(__file__).with_name("rewire.py")) + " --repair")
    print("  ② python " + str(cfg_path.parent / "param_check.py") + " --check   （应全绿）")


def root_ok(s):
    if s.startswith("/"):
        return len(s) > 1                                    # POSIX 绝对路径（Mac 部署）
    return len(s) > 3 and s[1] == ":" and s[2] == "/" and s[0].isalpha()   # Windows 盘符


if __name__ == "__main__":
    main()
