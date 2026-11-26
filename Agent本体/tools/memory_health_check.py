# -*- coding: utf-8 -*-
r"""memory_health_check.py — 记忆索引体检与守卫校验器（2026-11-15 立；2026-11-26 判据更正＋分节分册机制）

背景：MEMORY.md 被多会话并发写，出过两类事故——索引被拼接两份后尾部没被加载、旧快照覆盖新写（丢更新，无声）。
本工具查体量/表头/条目/断链 + last-good 备份；供手动巡检与 memory_guard hook 共用。

客户端加载规则（2026-11-26 读 ZCode 客户端实现 formatMemoryIndexContent 实证；此前“24KB 字节上限”是误读）：
  每次会话只自动加载 <项目记忆目录>/MEMORY.md，最多 200 行、25000 个字符（按 UTF-16 计，汉字算 1），超出的尾部不加载；
  主题文件不自动加载。所以真正要管的是行数，字节不是约束。

索引结构（分节＋分册）：
  MEMORY.md 用 “## 节名” 分四节，按加载要求排序：规则（用户给的规则与纠正——永不折叠，排最前）／资源与环境／
  标准与流程体系／需求与工作台账。条目接近上限时，把低频的节整节折叠到 分册索引_<节名>.md（索引行原样搬过去，不压缩），
  总索引该节只留一行指针。SessionStart 钩子（hooks/session_memory_context.py）开会话时提示有哪些分册要先读。

五查（每次必跑）：
  ① 体量（只看总索引）：>200 行或 >25000 字符＝红（尾部不会加载）；≥170 行或 ≥22000 字符＝黄，并给出下一步该折叠的节
  ② 重复表头："# Memory Index" 出现多次 = 索引被整体拼接（红，--repair 可自动修：保留条目最多的副本）
  ③ 条目回退：与上一份绿灯状态的条目清单比对（总索引∪分册），已知主题消失 = 疑似丢更新（黄=可能蓄意删除；--sync-state 确认 / --restore 还原）
  ④ 断链：索引引用的文件不存在（红，含分册指针）；--full 另查孤儿主题文件（存在但未被任何索引引用，黄）
  ⑤ 分册：同一主题同时出现在总索引和分册＝黄（重复）；--full 时分册未被总索引引用＝黄

用法：
  python memory_health_check.py                      # 体检所有项目的 MEMORY.md（绿灯后自动存 last-good 备份）
  python memory_health_check.py --path <MEMORY.md>   # 只查指定索引（hook 即此模式）
  python memory_health_check.py --full               # 加查孤儿主题文件与分册引用
  python memory_health_check.py --repair [--path …]  # 自动修复"重复拼接"损坏（其余红项只报告不动手）
  python memory_health_check.py --fold "<节名>" --path <MEMORY.md>    # 把该节折叠到分册索引（规则节拒绝折叠）
  python memory_health_check.py --unfold "<节名>" --path <MEMORY.md>  # 把分册搬回总索引并删除分册
  python memory_health_check.py --sync-state [--path…]  # 条目回退为蓄意删除时，确认当前态为新基线
  python memory_health_check.py --restore [--path …]   # 从最近一份 last-good 备份还原索引
  python memory_health_check.py --diff-hooks <旧MEMORY.md> --path <当前索引>
                                                     # 索引瘦身后的必跑核对：列出旧索引有、新索引同条里没有的钩子段（不改文件）

瘦身与折叠的边界：规则与资源类条目的索引钩子必须含全部可执行要点（约束、例外条款、具体情境、账号/路径/技能名），
只能去日期和事故出处——“主题文件里有”不能作为从索引删要点的理由；折叠只是把整行搬到分册，不改内容。

退出码：0=绿/仅黄；1=有红。状态与备份落在 <memories 上级>\memory_guard_state.json 与 memory_guard_backups\，
不进 Agent本体（保持机检零绝对路径）、不进框架解析的 projects 目录。
"""
import argparse
import io
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 客户端硬限（zcode.cjs formatMemoryIndexContent）：只加载总索引的前 200 行、前 25000 个字符
LINES_RED, LINES_YELLOW = 200, 170
CHARS_RED, CHARS_YELLOW = 25000, 22000
HEADER = "# Memory Index"
ENTRY_RX = re.compile(r"^- \[([^\]]+)\]\(([^)]+)\)", re.M)
HOOK_RX = re.compile(r"^- \[([^\]]+)\]\(([^)]+)\) — (.*)$", re.M)
SECTION_RX = re.compile(r"^##\s+(.+?)\s*$", re.M)
BACKUP_KEEP = 10
RULE_SECTION = "规则"                                  # 永不折叠：用户给的规则必须每次会话在上下文里
FOLD_ORDER = ["需求与工作台账", "标准与流程体系", "资源与环境"]  # 折叠顺序：越靠前越先折叠
FOLD_PREFIX = "分册索引_"
FOLD_HINT = {
    "需求与工作台账": "报某需求进度、跑某需求前先读",
    "标准与流程体系": "涉及标准归属、工具链、技能接线时先读",
    "资源与环境": "涉及账号、环境、路径、工具时先读",
}


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


def _alnum(s):
    return "".join(ch for ch in s if ch.isalnum())


def _u16(s):
    """客户端按 UTF-16 码元计字符数（汉字算 1，与 JS string.length 一致）"""
    return len(s.encode("utf-16-le")) // 2


def loaded_view(text):
    """客户端实际加载前的文本：剥顶层 frontmatter、两端去空白（HTML 注释剥离从略——索引里不用注释）"""
    return re.sub(r"^---\s*\n[\s\S]*?---\s*\n?", "", text).strip()


def client_split(text):
    """模拟客户端截断：返回 (会被加载的部分, 不会被加载的尾部)；未超限时尾部为空串"""
    t = loaded_view(text)
    if not t:
        return "", ""
    lines = t.split("\n")
    over_lines, over_chars = len(lines) > LINES_RED, _u16(t) > CHARS_RED
    if not over_lines and not over_chars:
        return t, ""
    u = "\n".join(lines[:LINES_RED]) if over_lines else t
    if _u16(u) > CHARS_RED:
        k = u.rfind("\n", 0, CHARS_RED + 1)
        u = u[:k] if k > 0 else u[:CHARS_RED]
    return u, t[len(u):].lstrip("\n")


def parse_entries(text):
    return [(m.group(1), m.group(2)) for m in ENTRY_RX.finditer(text)]


def parse_sections(text):
    """总索引分节 → [(节名或 None, 条目行原文)]：只收条目行、保持原顺序；节名＝其上方最近的 “## 节名”"""
    out, sec = [], None
    for ln in text.split("\n"):
        m = SECTION_RX.match(ln)
        if m:
            sec = m.group(1)
            continue
        if ENTRY_RX.match(ln):
            out.append((sec, ln.rstrip()))
    return out


def booklets(mem_md):
    """总索引同目录下的分册索引文件"""
    return sorted(Path(mem_md).parent.glob(FOLD_PREFIX + "*.md"))


def all_entries(mem_md):
    """总索引∪分册的条目 [(标题, 文件)]：条目回退、断链、孤儿检查都按合并视图算"""
    ents = parse_entries(io.open(mem_md, encoding="utf-8").read())
    for p in booklets(mem_md):
        ents += parse_entries(io.open(p, encoding="utf-8").read())
    return ents


def next_fold(text):
    """按折叠顺序找下一个还在总索引里的可折叠节 → 操作提示"""
    cnt = {}
    for sec, _ in parse_sections(text):
        cnt[sec] = cnt.get(sec, 0) + 1
    for name in FOLD_ORDER:
        if cnt.get(name):
            return f"下一步折叠：--fold \"{name}\"（“{name}”节 {cnt[name]} 条整行搬到分册索引，总索引留 1 行指针）"
    return "可折叠的节都已折叠，只剩规则节——规则不能折叠，须合并同类规则或清理已失效的条目"


def diff_hooks(old_md, new_md):
    """索引瘦身后的必跑核对（2026-11-26 立）：旧索引每条钩子按“；”切段，列出新索引同条钩子里找不到的段（两边都算上分册）。

    只有 MEMORY.md 是每次会话必加载的，主题文件只在相关时才被召回——所以规则/资源类条目的可执行要点
    （约束、例外条款、具体情境、账号/路径/技能名）必须留在索引，"主题文件里有"不能作为从索引删要点的理由；
    只有已收官的状态细节才可压。输出须逐段人工判断，不能凭印象。"""
    def load(p):
        pp = Path(p)
        ents = {m.group(2): (m.group(1), m.group(3).rstrip("；; "))
                for m in HOOK_RX.finditer(io.open(pp, encoding="utf-8").read())}
        if pp.name == "MEMORY.md" and pp.parent.name == "memory":
            for bk in booklets(pp):
                for m in HOOK_RX.finditer(io.open(bk, encoding="utf-8").read()):
                    ents.setdefault(m.group(2), (m.group(1), m.group(3).rstrip("；; ")))
        return ents
    old, new = load(old_md), load(new_md)
    n = miss_n = lost = 0
    for f, (title, hook) in old.items():
        if f not in new:
            lost += 1
            print(f"  [缺条目] {title} ({f})")
            continue
        cur = _alnum(new[f][1])
        miss = [s for s in re.split(r"[；;]", hook) if len(_alnum(s)) >= 4 and _alnum(s) not in cur]
        if not miss:
            continue
        n += 1
        miss_n += len(miss)
        print(f"  [{title}] {f}")
        print(f"      现：{new[f][1]}")
        for s in miss:
            print(f"      旧：{s.strip()}")
    print(f"  结论：缺条目 {lost}；{n} 条有差异、共 {miss_n} 段——逐段判断：是规则/资源要点的加回索引；"
          f"只是日期、出处、已收官状态的可不加。规则是否被遵守由助手自己保证，不交给用户发现。")


def check(mem_md, full=False):
    """返回 (reds, yellows, greens)；不改文件"""
    p = Path(mem_md)
    text = io.open(p, encoding="utf-8").read()
    reds, yellows, greens = [], [], []
    view = loaded_view(text)
    loaded, tail = client_split(text)
    n_lines, n_chars, n_all = len(loaded.split("\n")) if loaded else 0, _u16(loaded), len(view.split("\n")) if view else 0
    if tail:
        reds.append(f"①超限红：总索引 {n_all} 行／{_u16(view)} 字符，超过客户端上限（{LINES_RED} 行／{CHARS_RED} 字符），"
                    f"尾部 {len(tail.splitlines())} 行不会被加载——{next_fold(text)}")
    elif n_lines >= LINES_YELLOW or n_chars >= CHARS_YELLOW:
        yellows.append(f"①接近限：{n_lines}/{LINES_RED} 行、{n_chars}/{CHARS_RED} 字符——下次新增条目前先处理；{next_fold(text)}")
    else:
        greens.append(f"①体量 {n_lines}/{LINES_RED} 行、{n_chars}/{CHARS_RED} 字符／总索引条目 {len(parse_sections(text))}")
    heads = text.count(HEADER)
    if heads > 1:
        reds.append(f"②重复表头红：'{HEADER}' 出现 {heads} 次=索引被整体拼接（多会话并发写事故）——可 --repair 自动修（保留条目最多副本）")
    else:
        greens.append("②表头唯一")
    root = locate_root(p)
    st = load_state(state_path(root, p)).get(str(p), {})
    known = set(st.get("topics") or [])
    entries = all_entries(p)
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
        greens.append(f"④索引↔主题文件链全通（{len(entries)} 条，含分册）")
    if full:
        idx_files = {tgt for _, tgt in entries}
        orphans = [f.name for f in p.parent.glob("*.md")
                   if f.name != p.name and not f.name.startswith(FOLD_PREFIX) and not f.name.startswith(".")
                   and f.name not in idx_files]
        if orphans:
            yellows.append(f"孤儿主题文件 {len(orphans)} 个（存在但未被任何索引引用，确认后补索引或归档）→ {orphans[:8]}")
        unref = [bk.name for bk in booklets(p) if bk.name not in idx_files]
        if unref:
            yellows.append(f"分册未被总索引引用 {len(unref)} 个（指针行丢了，补指针或 --unfold 搬回）→ {unref}")
    seen, dup = set(), set()
    for _, tgt in entries:
        (dup if tgt in seen else seen).add(tgt)
    if dup:
        yellows.append(f"⑤同一主题重复出现在总索引与分册 {len(dup)} 条 → {sorted(dup)[:6]}（留一处）")
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


def _section_span(lines, section):
    """该节在总索引行列表里的 (节标题行号, 下一节标题行号或文件末尾)；节不存在返回 None"""
    heads = [(i, m.group(1)) for i, ln in enumerate(lines) for m in [SECTION_RX.match(ln)] if m]
    hit = [i for i, name in heads if name == section]
    if not hit:
        return None
    k = [n for n, (_, name) in enumerate(heads) if name == section][0]
    return hit[0], (heads[k + 1][0] if k + 1 < len(heads) else len(lines))


def _rw(mem_md, eol):
    raw = io.open(mem_md, encoding="utf-8", newline="").read()
    return raw.replace("\r\n", "\n").split("\n"), (lambda ls: io.open(mem_md, "w", encoding="utf-8", newline="").write(eol.join(ls)))


def fold(mem_md, section):
    """把总索引的一节整节折叠到分册索引：条目行原样搬过去（不压缩、不改内容），总索引留 1 行指针"""
    p = Path(mem_md)
    if section == RULE_SECTION:
        print(f"  [fold] 拒绝：“{RULE_SECTION}”节永不折叠——用户给的规则必须每次会话在上下文里")
        return False
    lines, write = _rw(p, "\r\n" if "\r\n" in io.open(p, encoding="utf-8", newline="").read() else "\n")
    span = _section_span(lines, section)
    if span is None:
        names = [m.group(1) for ln in lines for m in [SECTION_RX.match(ln)] if m]
        print(f"  [fold] 没有这一节：{section}（现有节：{names}）")
        return False
    a, b = span
    while b > a + 1 and lines[b - 1] == "":   # 节尾空行与文件末尾换行原地保留，不随条目搬走
        b -= 1
    rows = [ln.rstrip() for ln in lines[a + 1:b] if ENTRY_RX.match(ln)]
    if not rows:
        print(f"  [fold] “{section}”节在总索引里没有条目，不动")
        return False
    bk = p.parent / (FOLD_PREFIX + section + ".md")
    hint = FOLD_HINT.get(section, "需要时先读")
    if bk.exists():
        body = io.open(bk, encoding="utf-8").read().replace("\r\n", "\n").rstrip("\n") + "\n" + "\n".join(rows) + "\n"
    else:
        body = (f"# 分册索引：{section}\n\n"
                f"> 本文件是记忆总索引 MEMORY.md 的分册：这一类记忆的索引行原样放在这里，**不随会话自动加载**。{hint}。\n"
                f"> 折叠于 {time.strftime('%Y-%m-%d %H:%M')}；搬回总索引：memory_health_check.py --unfold \"{section}\"\n\n"
                "## 条目\n\n" + "\n".join(rows) + "\n")
    io.open(bk, "w", encoding="utf-8", newline="\n").write(body)
    total = len(parse_entries(body))
    lines[a + 1:b] = [f"- [{section}·分册]({bk.name}) — 本类 {total} 条记忆的索引行在分册里（不自动加载）；{hint}"]
    write(lines)
    print(f"  [fold] “{section}” {len(rows)} 条 → {bk.name}（分册共 {total} 条）；总索引留 1 行指针")
    return True


def unfold(mem_md, section):
    """把分册索引里的条目行搬回总索引对应节，并删除分册；总索引没有这一节时追加到末尾"""
    p = Path(mem_md)
    bk = p.parent / (FOLD_PREFIX + section + ".md")
    if not bk.exists():
        print(f"  [unfold] 没有这个分册：{bk.name}")
        return False
    rows = [ln.rstrip() for ln in io.open(bk, encoding="utf-8").read().split("\n") if ENTRY_RX.match(ln)]
    lines, write = _rw(p, "\r\n" if "\r\n" in io.open(p, encoding="utf-8", newline="").read() else "\n")
    span = _section_span(lines, section)
    if span is None:
        while lines and lines[-1] == "":
            lines.pop()
        lines += ["", f"## {section}"] + rows + [""]
    else:
        a, b = span
        while b > a + 1 and lines[b - 1] == "":
            b -= 1
        lines[a + 1:b] = rows
    bk.unlink()
    write(lines)
    print(f"  [unfold] {bk.name} {len(rows)} 条已搬回总索引，分册已删除")
    return True


def save_good(mem_md):
    """绿灯后存 last-good 备份并更新基线状态（基线条目按 总索引∪分册 算，折叠前后不丢）"""
    p, root = Path(mem_md), locate_root(mem_md)
    sp, bd = state_path(root, p), backup_dir(root, p)
    bd.mkdir(exist_ok=True)
    entries = all_entries(p)
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


def run_one(mem_md, full, do_repair, sync_state, do_restore, do_fold=None, do_unfold=None):
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
    if do_unfold:
        unfold(p, do_unfold)
    if do_fold:
        fold(p, do_fold)
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
    ap = argparse.ArgumentParser(description="记忆索引体检/修复/备份/折叠")
    ap.add_argument("--path", help="只查指定 MEMORY.md（默认扫所有 projects）")
    ap.add_argument("--full", action="store_true", help="加查孤儿主题文件与分册引用")
    ap.add_argument("--repair", action="store_true", help="自动修复重复拼接")
    ap.add_argument("--fold", metavar="节名", help="把总索引的一节整节折叠到分册索引（须给 --path；规则节拒绝）")
    ap.add_argument("--unfold", metavar="节名", help="把分册索引搬回总索引并删除分册（须给 --path）")
    ap.add_argument("--sync-state", action="store_true", help="条目回退=蓄意删除时确认新基线")
    ap.add_argument("--restore", action="store_true", help="从 last-good 还原")
    ap.add_argument("--diff-hooks", metavar="旧MEMORY.md",
                    help="索引瘦身后的必跑核对：列出旧索引有、新索引同条里没有的钩子段（不改文件；须同时给 --path）")
    a = ap.parse_args()
    if a.diff_hooks:
        if not a.path:
            print("[红] --diff-hooks 须同时给 --path <当前 MEMORY.md>")
            sys.exit(2)
        print(f"── 钩子核对：{a.diff_hooks} → {a.path} ──")
        diff_hooks(a.diff_hooks, a.path)
        return
    if (a.fold or a.unfold) and not a.path:
        print("[红] --fold / --unfold 须同时给 --path <MEMORY.md>")
        sys.exit(2)
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
        rc |= run_one(t, a.full, a.repair, a.sync_state, a.restore, a.fold, a.unfold)
    sys.exit(rc)


if __name__ == "__main__":
    main()
