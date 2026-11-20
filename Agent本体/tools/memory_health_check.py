# -*- coding: utf-8 -*-
r"""memory_health_check.py — 记忆索引体检与守卫校验器（2026-11-15 立，防多会话并发写坏 MEMORY.md）

背景：MEMORY.md 被多会话并发写，出过两类事故——整份索引拼接两遍（超 24.4KB 加载限，尾部条目被静默截断）、
旧快照覆盖新写（丢更新，无声）。本工具四查 + 自动修复 + last-good 备份；供手动巡检与 memory_guard hook 共用。

四查（每次必跑）：
  ① 超限：索引 ≥24000B 红（客户端加载限 24.4KB，留余量）、≥20000B 黄
  ② 重复表头："# Memory Index" 出现多次 = 索引被整体拼接（红，--repair 可自动修：保留条目最多的副本）
  ③ 条目回退：与上一份绿灯状态的条目清单比对，已知主题消失 = 疑似丢更新（黄=可能蓄意删除；--sync-state 确认 / --restore 还原）
  ④ 断链：索引引用的主题文件不存在（红）；--full 另查孤儿主题文件（存在但未被索引引用，黄）

用法：
  python memory_health_check.py                      # 体检所有项目的 MEMORY.md（绿灯后自动存 last-good 备份）
  python memory_health_check.py --path <MEMORY.md>   # 只查指定索引（hook 即此模式）
  python memory_health_check.py --full               # 加查孤儿主题文件
  python memory_health_check.py --repair [--path …]  # 自动修复"重复拼接"损坏（其余红项只报告不动手）
  python memory_health_check.py --sync-state [--path…]  # 条目回退为蓄意删除时，确认当前态为新基线
  python memory_health_check.py --restore [--path …]   # 从最近一份 last-good 备份还原索引

退出码：0=绿/仅黄；1=有红。状态与备份落在 <memories 上级>\memory_guard_state.json 与 memory_guard_backups\，
不进 Agent本体（保持机检零绝对路径）、不进框架解析的 projects 目录。
"""
import argparse
import io
import json
import re
import shutil
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

SIZE_RED, SIZE_YELLOW = 24000, 20000
HEADER = "# Memory Index"
ENTRY_RX = re.compile(r"^- \[([^\]]+)\]\(([^)]+)\)", re.M)
BACKUP_KEEP = 10


def zcode_home():
    return Path(os.environ.get("ZCODE_HOME") or (Path.home() / ".zcode")).expanduser()


def locate_root(mem_md):
    """状态/备份落点：沿目录上溯找 memories\，取其上级（=cli\）；找不到则落索引同目录（沙箱模式）"""
    p = Path(mem_md).resolve()
    for anc in list(p.parents)[:6]:
        if anc.name.lower() == "memories":
            return anc.parent
    return p.parent


def state_path(root, mem_md):
    return root / "memory_guard_state.json" if root != Path(mem_md).parent else root / ".memory_guard_state.json"


def backup_dir(root, mem_md):
    return root / "memory_guard_backups" if root != Path(mem_md).parent else root / ".memory_guard_backups"


def load_state(sp):
    try:
        return json.loads(io.open(sp, encoding="utf-8").read())
    except Exception:
        return {}


def parse_entries(text):
    return [(m.group(1), m.group(2)) for m in ENTRY_RX.finditer(text)]


def check(mem_md, full=False):
    """返回 (reds, yellows, greens, info)；不改文件"""
    p = Path(mem_md)
    text = io.open(p, encoding="utf-8").read()
    reds, yellows, greens = [], [], []
    size = len(text.encode("utf-8"))
    entries = parse_entries(text)
    if size >= SIZE_RED:
        reds.append(f"①超限红：{size}B ≥ {SIZE_RED}B（加载限 24.4KB 会截断尾部条目）——需瘦身：索引一行一钩子，细节移主题文件")
    elif size >= SIZE_YELLOW:
        yellows.append(f"①接近限：{size}B（≥{SIZE_YELLOW}B），下次新增条目前先瘦身")
    else:
        greens.append(f"①体量 {size}B / 条目 {len(entries)}")
    heads = text.count(HEADER)
    if heads > 1:
        reds.append(f"②重复表头红：'{HEADER}' 出现 {heads} 次=索引被整体拼接（多会话并发写事故）——可 --repair 自动修（保留条目最多副本）")
    else:
        greens.append("②表头唯一")
    root = locate_root(p)
    st = load_state(state_path(root, p)).get(str(p), {})
    known = set(st.get("topics") or [])
    if known:
        lost = known - {t for t, _ in entries}
        if lost:
            yellows.append(f"③条目回退黄：对比上一份绿灯状态少了 {len(lost)} 条 → {sorted(lost)}；"
                           f"若系蓄意删除请跑 --sync-state 确认，否则 --restore 还原 last-good")
        else:
            greens.append(f"③无条目回退（基线 {len(known)} 条）")
    else:
        greens.append("③首跑建基线")
    missing = [tgt for _, tgt in entries if not (p.parent / tgt).exists()]
    if missing:
        reds.append(f"④断链红：{len(missing)} 个主题文件不存在 → {missing[:5]}")
    else:
        greens.append(f"④索引↔主题文件链全通（{len(entries)} 条）")
    if full:
        referenced = {tgt for _, tgt in entries}
        orphans = [f.name for f in p.parent.glob("*.md")
                   if f.name != p.name and f.name not in referenced and not f.name.startswith(".")]
        if orphans:
            yellows.append(f"孤儿主题文件 {len(orphans)} 个（存在但索引未引用，确认后补索引或归档）→ {orphans[:8]}")
    return reds, yellows, greens


def repair(mem_md):
    """仅自动修"重复拼接"：按表头切段，保留条目最多的副本（并列取最后=通常为超集）"""
    p = Path(mem_md)
    text = io.open(p, encoding="utf-8").read()
    parts = re.split(r"(?m)^\s*" + re.escape(HEADER) + r"\s*$", text)
    segs = [s for s in parts if parse_entries(s)]
    if len(segs) < 2:
        print("  [repair] 未发现重复拼接段，不动文件")
        return False
    best = max(range(len(segs)), key=lambda i: (len(parse_entries(segs[i])), i))
    io.open(p, "w", encoding="utf-8", newline="").write(HEADER + "\n" + segs[best].lstrip("\r\n"))
    print(f"  [repair] 已保留第 {best + 1} 段（{len(parse_entries(segs[best]))} 条），丢弃 {len(segs) - 1} 个重复副本")
    return True


def save_good(mem_md):
    """绿灯后存 last-good 备份并更新基线状态"""
    p, root = Path(mem_md), locate_root(mem_md)
    sp, bd = state_path(root, p), backup_dir(root, p)
    bd.mkdir(exist_ok=True)
    entries = parse_entries(io.open(p, encoding="utf-8").read())
    bak = bd / f"{p.parent.parent.name}_{p.stem}_{time.strftime('%Y%m%d_%H%M%S')}{p.suffix}"
    shutil.copy2(p, bak)
    olds = sorted(bd.glob(f"{p.parent.parent.name}_{p.stem}_*{p.suffix}"))
    for f in olds[:-BACKUP_KEEP]:
        f.unlink()
    st = load_state(sp)
    st[str(p)] = {"topics": sorted(t for t, _ in entries), "count": len(entries),
                  "bytes": p.stat().st_size, "mtime": p.stat().st_mtime, "last_backup": str(bak)}
    io.open(sp, "w", encoding="utf-8", newline="").write(json.dumps(st, ensure_ascii=False, indent=1) + "\n")
    return bak


def run_one(mem_md, full, do_repair, sync_state, do_restore):
    p = Path(mem_md)
    print(f"── {p} ──")
    if do_restore:
        st = load_state(state_path(locate_root(p), p)).get(str(p), {})
        bak = st.get("last_backup")
        if bak and Path(bak).exists():
            shutil.copy2(bak, p)
            print(f"  [restore] 已从 last-good 还原：{bak}")
        else:
            print("  [restore] 无可用备份")
            return 1
    if do_repair:
        repair(p)
    reds, yellows, greens = check(p, full)
    for g in greens:
        print(f"  [绿] {g}")
    for y in yellows:
        print(f"  [黄] {y}")
    for r in reds:
        print(f"  [红] {r}")
    if sync_state and not reds:
        bak = save_good(p)
        print(f"  [sync] 已确认当前态为基线，备份 {Path(bak).name}")
        return 0
    if reds:
        print("  结论：红（须处理后重跑）")
        return 1
    bak = save_good(p)
    print(f"  结论：绿（last-good 备份 {Path(bak).name}）")
    return 0


def main():
    ap = argparse.ArgumentParser(description="记忆索引体检/修复/备份")
    ap.add_argument("--path", help="只查指定 MEMORY.md（默认扫所有 projects）")
    ap.add_argument("--full", action="store_true", help="加查孤儿主题文件")
    ap.add_argument("--repair", action="store_true", help="自动修复重复拼接")
    ap.add_argument("--sync-state", action="store_true", help="条目回退=蓄意删除时确认新基线")
    ap.add_argument("--restore", action="store_true", help="从 last-good 还原")
    a = ap.parse_args()
    if a.path:
        targets = [a.path]
    else:
        mem_root = zcode_home() / "cli" / "memories" / "projects"
        targets = sorted(str(m) for m in mem_root.glob("*/memory/MEMORY.md")) if mem_root.exists() else []
        if not targets:
            print("[红] 未找到任何 MEMORY.md")
            sys.exit(1)
    rc = 0
    for t in targets:
        rc |= run_one(t, a.full, a.repair, a.sync_state, a.restore)
    sys.exit(rc)


if __name__ == "__main__":
    main()
