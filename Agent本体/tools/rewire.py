# -*- coding: utf-8 -*-
r"""rewire.py — agentqa_test 三包接线体检与改名工具（2026-11-14 目录化重构立，同日收拢 agentqa_test）

布局：workspace\\agentqa_test\\{Agent本体, 手艺包, 公司包} = 物理正本；
ZCode 只认固定运行位（workspace\\.zcode\\skills、用户目录 skills、cli\\config.json 的 hook 路径），
之间靠目录联接（junction）与配置路径接线。本工具管这层接线，使目录**改名后仍兼容**。

用法：
  python rewire.py --status                 体检：三包定位/接线贯通/hook 路径/公司配置路径可达
  python rewire.py --rename 公司包 新名      改名（agentqa_test 下的子目录名）：迁目录→重建受影响联接
                                            →改 hook 配置路径→改公司配置路径值→登记路径迁移别名→旧名留兼容联接
  python rewire.py --rename 公司包 新名 --dry-run  只打印改名计划（摘/建联接＋改写配置），不落盘
  python rewire.py --repair                 按接线表重建缺失/断开的联接（不动目录），并把 hooks 七件
                                            幂等写进 cli\config.json（新机器部署=解压后只跑这一条）
                                            （2026-11-14 随 pack_for_colleague.py 立，补"第二实例"缺口；
                                             后增 memory_guard 记忆索引守卫与 activity_trace 计时底账）

说明：改 cli\\config.json 属重启级配置，执行后必须重开会话才生效（硬规则 8）。
"""
import argparse
import io
import json
import os
import subprocess
import sys
from pathlib import Path

AGENT_ROOT = Path(__file__).resolve().parents[2]          # …\agentqa_test\Agent本体\tools\ 上溯两级= agentqa_test
WORKSPACE = AGENT_ROOT.parent                              # workspace 根（联接位所在）
USER_ZCODE = Path(os.environ.get("ZCODE_HOME") or (Path(os.path.expanduser("~")) / ".zcode")).expanduser()
CLI_CONFIG = USER_ZCODE / "cli" / "config.json"
ENV_SKILLS = ["jingtian-login", "jingtian-org-switch", "jingtian-tenant-switch", "pm-center-login"]


IS_MAC = sys.platform == "darwin"          # 2026-11-16 Mac 适配轮：Mac 无 Junction/PowerShell，用原生 symlink


def is_junction(p):
    if IS_MAC:
        try:
            return os.path.islink(p)       # Mac：符号链接即"联接"
        except OSError:
            return False
    try:
        return bool(os.lstat(p).st_file_attributes & 0x400)   # Windows：FILE_ATTRIBUTE_REPARSE_POINT
    except (OSError, AttributeError):
        return False


def find_dir(marker):
    """在 agentqa_test 下按内容特征找子目录（改名免疫）；跳过点开头与联接"""
    for d in sorted(AGENT_ROOT.iterdir()):
        try:
            if d.name.startswith(".") or not d.is_dir() or is_junction(d):
                continue
            if (d / marker).exists():
                return d
        except OSError:
            continue
    return None


def locate():
    return (find_dir(Path("skills") / "usecase-orchestrator"),   # Agent本体
            find_dir("agent-company.json"),                      # 公司包
            find_dir(Path("03_检查脚本") / "generic_layer_check.py"))  # 手艺包


def wiring(agent, company, workbuddy=False, claude=False, codex=False, codebuddy=False, zcode=True):
    """接线表：(联接位置, 物理目标, 说明)。zcode=False 时不改 ZCode 运行位。"""
    w = []
    if zcode:
        w.append((WORKSPACE / ".zcode" / "skills", agent / "skills", "流程技能运行位（ZCode 发现口）"))
    # agent 内部技能挂载始终需要：这是物理本体内的公司环境技能联接，不是宿主选择。
    for n in ("devops-login", "zbase-login", "zbase-log-query"):
        w.append((agent / "skills" / n, company / "skills" / n, "环境技能挂入技能树"))
    if zcode:
        w.append((USER_ZCODE / "cli" / "hooks", agent / "hooks", "hook 旧路径兼容联接（缓存未失效会话用；稳定后可删）"))
        for n in ENV_SKILLS:
            w.append((USER_ZCODE / "skills" / n, company / "skills" / n, "用户级环境技能运行位"))
        craft = find_dir(Path("03_检查脚本") / "generic_layer_check.py")
        if craft:
            w.append((WORKSPACE / "通用测试agent包", craft, "手艺包旧名兼容联接"))
    for flag, base, tag in ((workbuddy, Path(os.path.expanduser("~")) / ".workbuddy" / "skills", "WorkBuddy"),
                            (claude, Path(os.path.expanduser("~")) / ".claude" / "skills", "Claude Code"),
                            (codex, Path(os.path.expanduser("~")) / ".codex" / "skills", "Codex"),
                            (codebuddy, Path(os.path.expanduser("~")) / ".codebuddy" / "skills", "CodeBuddy")):
        if not flag:
            continue
        for src_dir in (agent / "skills", company / "skills"):
            if src_dir.is_dir():
                for s in sorted(src_dir.iterdir()):
                    if s.name.startswith((".", "__")) or not s.is_dir() or is_junction(s):
                        continue
                    w.append((base / s.name, s, f"{tag} 宿主技能位：{s.name}"))
    return w


def make_junction(link, target):
    link, target = Path(link), Path(target)
    if not target.is_dir():
        raise RuntimeError(f"联接目标不存在或不是目录，拒绝创建悬空联接：{target}")
    if link.exists() or is_junction(link):
        if is_junction(link):
            (link.unlink() if IS_MAC and link.is_symlink() else os.rmdir(link))   # 只删联接本身，不碰目标内容
        else:
            raise RuntimeError(f"联接位已被实体目录占用，拒绝覆盖：{link}")
    link.parent.mkdir(parents=True, exist_ok=True)   # 新机器上联接位父目录可能不存在
    if IS_MAC:
        try:
            os.symlink(target, link, target_is_directory=True)   # Mac 原生符号链接
            return
        except OSError as e:
            raise RuntimeError(f"建符号链接失败 {link} -> {target}: {e}")
    qlink=str(link).replace("'", "''"); qtarget=str(target).replace("'", "''")
    r = subprocess.run(["powershell", "-NoProfile", "-Command",
                        f"New-Item -ItemType Junction -Path '{qlink}' -Target '{qtarget}' | Out-Null"],
                       capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"建联接失败 {link} -> {target}: {r.stderr.decode('utf-8', 'replace')[:200]}")


def hook_paths():
    if not CLI_CONFIG.exists():
        return []
    cfg = json.loads(io.open(CLI_CONFIG, encoding="utf-8").read())
    out = []
    for arr in (cfg.get("hooks", {}).get("events", {}) or {}).values():
        for e in arr:
            for h in e.get("hooks", []):
                out += [a for a in h.get("args", []) if a.lower().endswith(".py")]
    return out


def hook_templates(agent):
    """hooks 八件接线表：(事件, matcher, 脚本名, 状态文案)；路径按当前本体解析，不写死。
    memory_guard（2026-11-15 立）：MEMORY.md 写后自动体检，防多会话并发写坏记忆索引。
    activity_trace（2026-11-16 立，计时与时间线规范§十一第二批）：全部工具调用时刻落
    workspace\\.zcode\\agent_activity.jsonl（净耗时底账）；只挂 PostToolUse 单边=每调用一次开销。
    turn_in_trace / turn_out_trace（2026-11-25 立，规范 v1.2"每个步骤都计时"）：回合开始/结束时刻落同一底账，
    配对出"agent 正在操作的回合区间"，用户思考答复的时间不计；只记不输出不阻断，Stop 钩子严禁回内容。
    session_memory_context（2026-11-26 立）：会话启动/恢复/清空/上下文压缩后，提示记忆总索引之外的分册索引要先读；
    总索引超过客户端上限（200 行／25000 字符）时把不会加载的尾部补注入（兜底）。用户给的规则靠这条通道保证在上下文里。"""
    return [("PostToolUse", "Write|Edit", "reread_reminder.py", "正本改动检查"),
            ("PostToolUse", "Write|Edit|ApplyPatch", "paiban_ledger_reminder.py", "拍板对账提醒"),
            ("PreToolUse", "Edit|Write|ApplyPatch", "block_master_edit.py", "正本直改拦截检查"),
            ("PostToolUse", "Write|Edit|ApplyPatch", "memory_guard.py", "记忆索引守卫"),
            ("PostToolUse", ".*", "activity_trace.py", "计时底账（工具时刻）"),
            ("UserPromptSubmit", ".*", "turn_in_trace.py", "计时底账（回合开始）"),
            ("Stop", ".*", "turn_out_trace.py", "计时底账（回合结束）"),
            ("SessionStart", ".*", "session_memory_context.py", "记忆分册提示与截断兜底")]


def ensure_hooks(agent):
    """把 hooks 七件幂等写进 cli\\config.json：按脚本文件名识别，缺则补、路径旧则改；写前备份。
    （新机器部署缺口：--repair 原先只管联接，同事的 config.json 里没有 hook 条目则五道机器闸全不生效）"""
    events = {}
    if CLI_CONFIG.exists():
        cfg = json.loads(io.open(CLI_CONFIG, encoding="utf-8").read())
        events = (cfg.get("hooks", {}) or {}).get("events", {})
    else:
        cfg, events = {}, {}
    changed = []
    for event, matcher, script, msg in hook_templates(agent):
        path = str(agent / "hooks" / script)
        arr = events.setdefault(event, [])
        hit = None
        for e in arr:
            for h in e.get("hooks", []):
                if any(isinstance(a, str) and a.replace("\\", "/").endswith("/" + script) for a in h.get("args", [])):
                    hit = h
        if hit is None:
            arr.append({"matcher": matcher, "hooks": [{"type": "process", "command": sys.executable,
                        "args": [path], "timeoutMs": 8000, "statusMessage": msg}]})
            changed.append(f"补 {event} += {script}")
        elif hit["args"][0].replace("\\", "/") != path.replace("\\", "/"):
            hit["args"][0] = path
            changed.append(f"改路径 {script}")
    if not (cfg.get("hooks") or {}).get("enabled"):
        changed.append("启用 hooks.enabled")
    if changed:
        cfg.setdefault("hooks", {})["enabled"] = True
        cfg["hooks"]["events"] = events
        if CLI_CONFIG.exists():
            import time
            bak = CLI_CONFIG.with_suffix(".json.bak_rewire_" + time.strftime("%Y%m%d_%H%M%S"))
            io.open(bak, "wb").write(io.open(CLI_CONFIG, "rb").read())
        else:
            CLI_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        io.open(CLI_CONFIG, "w", encoding="utf-8", newline="").write(
            json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
        for c in changed:
            print(f"  [hook] {c}")
        print("  ⚠ 已写 cli\\config.json（先备份）——重启级配置，须重开会话生效（硬规则 8）")
    else:
        print("  hooks 配置已齐，无改动")


CLAUDE_HOME = Path(os.environ.get("CLAUDE_HOME") or (Path(os.path.expanduser("~")) / ".claude")).expanduser()
CLAUDE_SETTINGS = CLAUDE_HOME / "settings.json"


def ensure_claude_hooks(agent):
    """Claude Code 档：把 hooks 七件按 Claude settings.json 格式幂等写入（备份先行）。
    格式已对齐官方（PreToolUse/PostToolUse + matcher 正则 + command）；脚本 stdin 协议与 ZCode 同构度高，
    但**运行时行为属真机首验项**（2026-11-16 立档，部署验证报告边界节）。"""
    if not CLAUDE_SETTINGS.parent.is_dir():
        print("  [claude] 未装 Claude Code（~/.claude 不存在），跳过")
        return
    cfg = {}
    if CLAUDE_SETTINGS.exists():
        cfg = json.loads(io.open(CLAUDE_SETTINGS, encoding="utf-8").read())
    hooks = cfg.setdefault("hooks", {})
    changed = []
    for event, matcher, script, msg in hook_templates(agent):
        cmd = f'"{sys.executable}" "{agent / "hooks" / script}"'
        arr = hooks.setdefault(event, [])
        hit = None
        for e in arr:
            for h in e.get("hooks", []):
                if script in str(h.get("command", "")):
                    hit = h
        m = matcher.replace("ApplyPatch", "") .strip("|")     # Claude 无 ApplyPatch 工具名，正则里去掉
        if hit is None:
            arr.append({"matcher": m, "hooks": [{"type": "command", "command": cmd}]})
            changed.append(f"补 {event} += {script}")
        elif hit["command"] != cmd:
            hit["command"] = cmd
            changed.append(f"改路径 {script}")
    if changed:
        import time
        bak = CLAUDE_SETTINGS.with_suffix(".json.bak_rewire_" + time.strftime("%Y%m%d_%H%M%S"))
        io.open(bak, "wb").write(io.open(CLAUDE_SETTINGS, "rb").read()) if CLAUDE_SETTINGS.exists() else None
        io.open(CLAUDE_SETTINGS, "w", encoding="utf-8", newline="").write(
            json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
        for c in changed:
            print(f"  [claude-hook] {c}")
        print("  ⚠ 已写 ~/.claude/settings.json（先备份）——重启级配置；运行时行为属真机首验项")
    else:
        print("  [claude] hooks 配置已齐，无改动")


def status(workbuddy=False, claude=False, codex=False, codebuddy=False, zcode=True):
    agent, company, craft = locate()
    print(f"workspace：{WORKSPACE}\n  agentqa_test = {AGENT_ROOT}")
    print(f"  Agent本体 = {agent}\n  公司包    = {company}\n  手艺包    = {craft}")
    red = 0
    if not (agent and company and craft):
        print("[RED] 三包定位不全")
        return 1
    print("── 接线 ──")
    for link, target, note in wiring(agent, company, workbuddy, claude, codex, codebuddy, zcode):
        try:
            ok = is_junction(link) and Path(link).exists() and os.path.samefile(link, target)
        except OSError:
            ok = False
        red += 0 if ok else 1
        print(f"  [{'OK ' if ok else 'RED'}] {link}  →  {target}   （{note}）")
    if zcode:
        print("── ZCode hooks ──")
        cfg = json.loads(io.open(CLI_CONFIG, encoding="utf-8").read()) if CLI_CONFIG.exists() else {}
        enabled = bool((cfg.get("hooks") or {}).get("enabled"))
        red += 0 if enabled else 1
        print(f"  [{'OK ' if enabled else 'RED'}] hooks.enabled = {enabled}")
        found = {Path(a).name: Path(a).exists() for a in hook_paths()}
        for _event, _matcher, script, _msg in hook_templates(agent):
            good = found.get(script, False)
            red += 0 if good else 1
            print(f"  [{'OK ' if good else 'RED'}] {script}")
    print("── 公司配置路径可达 ──")
    cfg = json.loads(io.open(company / "agent-company.json", encoding="utf-8").read())
    alias = {k.replace("\\", "/"): v.replace("\\", "/") for k, v in (cfg.get("路径迁移别名", {}) or {}).items()}
    for k, v in cfg.get("paths", {}).items():
        if isinstance(v, str) and (v.startswith("/") or (len(v) > 2 and v[1] == ":")):
            ok = Path(v).exists() or v.replace("\\", "/") in alias
            red += 0 if ok else 1
            print(f"  [{'OK ' if ok else 'RED'}] paths.{k} = {v}")
    print(f"结论：{'全绿' if red == 0 else f'红 {red} 项'}")
    return 1 if red else 0


def repair(workbuddy=False, claude=False, codex=False, codebuddy=False, zcode=True):
    agent, company, _ = locate()
    for link, target, _n in wiring(agent, company, workbuddy, claude, codex, codebuddy, zcode):
        try:
            ok = is_junction(link) and Path(link).exists() and os.path.samefile(link, target)
        except OSError:
            ok = False
        if not ok:
            make_junction(link, target)
            print(f"  [修] {link} → {target}")
    if zcode:
        ensure_hooks(agent)
    if claude:
        # Claude hooks 协议尚未完成真机兼容验收；仅接技能，使用软闸，不自动改其 settings.json。
        print("  [claude] 仅接 skills；hooks 试验档不自动注入（运行时协议待真机适配）")
    return status(workbuddy, claude, codex, codebuddy, zcode)


def _backup(path):
    import time
    bak = path.with_name(path.name + ".bak_rewire_" + time.strftime("%Y%m%d_%H%M%S"))
    io.open(bak, "wb").write(io.open(path, "rb").read())
    return bak


def rename(old, new, dry_run=False):
    src, dst = AGENT_ROOT / old, AGENT_ROOT / new
    if not src.is_dir() or is_junction(src):
        print(f"[RED] 不是 {AGENT_ROOT} 下的实体目录：{src}")
        return 1
    if dst.exists():
        print(f"[RED] 目标名已存在：{dst}")
        return 1
    old_s, new_s = str(src).replace("\\", "/"), str(dst).replace("\\", "/")
    agent0, company0, _ = locate()
    removed = [(link, target) for link, target, _n in wiring(agent0, company0)
               if is_junction(link) and str(target).replace("\\", "/").startswith(old_s)]
    if dry_run:
        print(f"[DRY-RUN] 将改名 {src} → {dst}")
        for link, target in removed:
            print(f"[DRY-RUN] 摘联接 {link} → {target}")
        cp0 = company0 / "agent-company.json"
        print(f"[DRY-RUN] 备份并改写 {cp0}（{old_s} → {new_s}＋登记路径迁移别名）")
        if CLI_CONFIG.exists():
            print(f"[DRY-RUN] 备份并按需改写 {CLI_CONFIG} 的 hook 路径")
        print(f"[DRY-RUN] 按接线表重建受影响联接，并留旧名兼容联接 {src} → {dst}")
        return 0
    baks, made = {}, []
    try:
        cp = company0 / "agent-company.json"
        baks[cp] = _backup(cp)
        if CLI_CONFIG.exists():
            baks[CLI_CONFIG] = _backup(CLI_CONFIG)
        for link, _target in removed:
            (Path(link).unlink() if IS_MAC and Path(link).is_symlink() else os.rmdir(link))
        os.rename(src, dst)
        agent, company, _ = locate()
        text = io.open(cp, encoding="utf-8").read().replace(old_s, new_s)
        cfg = json.loads(text)
        cfg.setdefault("路径迁移别名", {})[old_s] = new_s
        io.open(cp, "w", encoding="utf-8", newline="").write(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
        if CLI_CONFIG.exists():
            raw = io.open(CLI_CONFIG, encoding="utf-8").read()
            o_esc, n_esc = str(src).replace("\\", "\\\\"), str(dst).replace("\\", "\\\\")
            if o_esc in raw:
                io.open(CLI_CONFIG, "w", encoding="utf-8", newline="").write(raw.replace(o_esc, n_esc))
                print("  ⚠ 已改 cli\\config.json 的 hook 路径 —— 需重开会话生效")
        for link, target, _n in wiring(agent, company):
            try:
                ok = is_junction(link) and Path(link).exists() and os.path.samefile(link, target)
            except OSError:
                ok = False
            if not ok:
                make_junction(link, target)
                made.append(link)
        make_junction(src, dst)
    except Exception as e:
        print(f"[RED] 改名中途失败，开始逆序回滚：{e}")
        try:
            for link in made:
                if is_junction(link):
                    (Path(link).unlink() if IS_MAC and Path(link).is_symlink() else os.rmdir(link))
            if dst.is_dir() and not is_junction(dst):
                os.rename(dst, src)
            for path, bak in baks.items():
                if bak.exists():
                    io.open(path, "wb").write(io.open(bak, "rb").read())
            for link, target in removed:
                if not (link.exists() or is_junction(link)):
                    make_junction(link, target)
            print("[RED] 已回滚到改名前状态；改前备份保留：")
            for bak in baks.values():
                print(f"  {bak}")
        except Exception as e2:
            print(f"[RED] 回滚不完整，请按下列备份手工恢复：{e2}")
            for path, bak in baks.items():
                print(f"  原文件 {path} ← 备份 {bak}")
        return 1
    print(f"  已改名 {old} → {new}；旧名保留为兼容联接；别名已登记；改前备份：")
    for bak in baks.values():
        print(f"  {bak}")
    print("  后续人工清扫（可选，旧路径经兼容联接仍可达）：技能/记忆/文档里的旧名文字引用")
    return status()


def main():
    ap = argparse.ArgumentParser(description="agentqa_test 三包接线体检与改名")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--repair", action="store_true")
    ap.add_argument("--workbuddy", action="store_true",
                    help="同时接入 WorkBuddy 宿主（.workbuddy\\skills 联接全部技能；WorkBuddy 重启后生效）")
    ap.add_argument("--codebuddy", action="store_true",
                    help="同时接入 CodeBuddy 宿主（.codebuddy\\skills 技能联接；CLI 版适用——hooks 兼容性属首验项，IDE 插件版请走手艺包三步）")
    ap.add_argument("--codex", action="store_true",
                    help="同时接入 Codex 宿主（.codex\\skills 联接技能；无工具级 hooks→软闸档）")
    ap.add_argument("--claude", action="store_true",
                    help="同时接入 Claude Code 宿主（.claude\\skills 联接技能 + settings.json 注入 hooks 七件，运行时行为属真机首验项）")
    ap.add_argument("--no-zcode", action="store_true",
                    help="不改 ZCode 运行位/hooks（非 ZCode 宿主选择时使用；仅接宿主参数指定的技能位）")
    ap.add_argument("--rename", nargs=2, metavar=("旧名", "新名"))
    ap.add_argument("--dry-run", action="store_true",
                    help="配合 --rename：仅打印改名计划（摘/建联接、改写配置），不落盘")
    a = ap.parse_args()
    if a.rename:
        sys.exit(rename(*a.rename, dry_run=a.dry_run))
    zcode = not a.no_zcode
    if a.repair:
        sys.exit(repair(a.workbuddy, a.claude, a.codex, a.codebuddy, zcode))
    sys.exit(status(a.workbuddy, a.claude, a.codex, a.codebuddy, zcode))


if __name__ == "__main__":
    main()
