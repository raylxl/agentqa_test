# -*- coding: utf-8 -*-
"""
一键部署器（同事包）—— 解压到任意目录后双击 部署.bat 即调本件。
设计原则：目录由同事定（部署器所在处=根）；幂等（重跑无害）；每步打印 [OK]/[红]。

用法：
  python deploy_colleague.py                 # 以本件上溯两级为根（=解压根）
  python deploy_colleague.py --skip-rewire   # 跳过接线（试验场/无 ZCode 客户端机）
  python deploy_colleague.py --force         # 允许在 D:\\ZCodetest 正本目录跑（防误用默认拦）

步骤：定位根 → 防呆 → 占位骨架 → 路径换算(migrate_paths) → 文档通用化 → 接线(rewire --repair) → 校验(param_check) → 汇总
"""
import sys, os, re, json, shutil, subprocess, argparse
from pathlib import Path

IS_MAC = sys.platform == "darwin"

try:
    # 不要动编码：真控制台 python 走 WriteConsoleW 宽字符通道（中文自动正常显示）；
    # 重定向/管道场景回退 locale。此前 reconfigure(gbk) 曾致真控制台乱码（GBK 字节被底层按 UTF-8 强解）——已回撤。
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

LAUNCHER = "部署.command" if IS_MAC else "部署.bat"

HERE = Path(__file__).resolve().parent          # <根>\agentqa_test\Agent本体\tools
ROOT = HERE.parents[2]                          # 解压根（任意盘任意目录）

# ── 布局自适应（2026-11-19 Mac 真机克隆通道立）：PKG=三包所在目录 ──
#   安全包： <解压根>\agentqa_test\Agent本体\tools → PKG=ROOT\agentqa_test（.git 不在）
#   git克隆：<克隆根>\Agent本体\tools             → PKG=克隆根=HERE.parents[1]（.git 在此；ROOT=克隆根上一级=工作区根）
PKG_CANDIDATE = HERE.parents[1]
IS_CLONE = (PKG_CANDIDATE / "公司包").is_dir() and (PKG_CANDIDATE / ".git").exists()
PKG = PKG_CANDIDATE if IS_CLONE else ROOT / "agentqa_test"


def git_pkg(args):
    return subprocess.run(["git", "-C", str(PKG_CANDIDATE)] + args,
                          capture_output=True, text=True, encoding="utf-8", errors="replace")


def git_skipped_files():
    """skip-worktree 受保护文件清单（git ls-files -v 前缀 S）"""
    r = git_pkg(["ls-files", "-v"])
    if r.returncode != 0:
        return []
    return [l[2:] for l in (r.stdout or "").splitlines() if l.startswith("S ")]


def git_tracked_set():
    r = git_pkg(["ls-files"])
    if r.returncode != 0:
        return set()
    return {l.strip() for l in (r.stdout or "").splitlines() if l.strip()}


def ok(msg):  print(f"  [OK ] {msg}")
def red(msg): print(f"  [红 ] {msg}")

REG = Path(os.path.expanduser("~")) / ".testagent_deploy.json"     # 安装登记（升级模式的记忆）
USER_ZONES = {"需求用例库", "AiTest", ".chrome-cdp", "需求流水线台账_v1.md"}
PROTECTED_COMPANY_FILES = {"agent-company.json", "agent-secrets.json", "company_wordlist.json", "publish_rules.json"}
RUNTIME_DIRS = {"run-results", "shots", "ego_shots", "locks", ".headless_profile", ".headless_r7"}
RUNTIME_PREFIXES = ("evid_", "_r", "_rg", "_t")


def _protected_upgrade_path(rel: Path, dst: Path) -> bool:
    """升级只跳过明确的用户配置/用户数据；程序件仍正常覆盖。"""
    parts = rel.parts
    if len(parts) >= 3 and parts[0] == "agentqa_test" and parts[1] == "公司包" and parts[2] in PROTECTED_COMPANY_FILES:
        return dst.exists()                  # 旧值存在就保留；首次缺失可由包初始化
    if len(parts) >= 4 and parts[:3] in (("agentqa_test", "公司包", "jt_exec"), ("agentqa_test", "公司包", "执行工具")):
        tail = parts[3:]
        if any(x in RUNTIME_DIRS or x.startswith(RUNTIME_PREFIXES) for x in tail):
            return dst.exists()
        if parts[-1].lower().endswith((".log", ".jsonl")):
            return dst.exists()
    return False


def _copy_program_tree(src: Path, dst: Path, rel_root: Path) -> int:
    """逐文件覆盖程序件，保留公司配置/凭证与执行产物；避免 copytree 回调层级判断歧义。"""
    copied = 0
    for base, dirs, files in os.walk(src):
        base_p = Path(base)
        rel_dir = base_p.relative_to(src)
        out_dir = dst / rel_dir
        out_dir.mkdir(parents=True, exist_ok=True)
        dirs[:] = [d for d in dirs if d not in {".git", "__pycache__", "node_modules", "dist"}]
        for name in dirs:
            rel = rel_root / rel_dir / name
            target = dst / rel_dir / name
            if _protected_upgrade_path(rel, target) and target.exists():
                dirs.remove(name)
                continue
            target.mkdir(parents=True, exist_ok=True)
        for name in files:
            if name.endswith((".pyc", ".log")) or name == "MANIFEST.json":
                if name == "MANIFEST.json" and rel_dir == Path("."):
                    shutil.copy2(base_p / name, dst / name)
                continue
            rel = rel_root / rel_dir / name
            target = dst / rel_dir / name
            if _protected_upgrade_path(rel, target) and target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(base_p / name, target)
            copied += 1
    return copied


def _preserve_runtime(src, dst):
    """从旧 jt_chrome 搬用户运行产物到新执行工具目录：只补缺，不覆盖新包或用户已有同名文件。"""
    if not src.exists():
        return 0
    copied = 0
    for base, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d in RUNTIME_DIRS or d.startswith(RUNTIME_PREFIXES)]
        rel = Path(base).relative_to(src)
        dest = dst / rel
        dest.mkdir(parents=True, exist_ok=True)
        for d in dirs:
            (dest / d).mkdir(parents=True, exist_ok=True)
        for name in files:
            f = Path(base) / name
            if name.lower().endswith((".log", ".jsonl")) or (name.startswith(("dk_r", "_")) and f.suffix.lower() in {".png", ".jpg"}):
                t = dest / name
                if not t.exists():
                    t.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(f, t)
                    copied += 1
    return copied



def read_reg():
    try:
        return json.loads(REG.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_reg(root: Path):
    import time as _t
    ver = {}
    m = root / "MANIFEST.json"
    if m.exists():
        try:
            ver = json.loads(m.read_text(encoding="utf-8"))
        except Exception:
            pass
    REG.write_text(json.dumps({
        "root": str(root), "打包时间": ver.get("打包时间", ""),
        "条目": (ver.get("合计") or {}).get("文件数", ""),
        "登记时间": _t.strftime("%Y-%m-%d %H:%M")}, ensure_ascii=False, indent=2), encoding="utf-8")


def upgrade(new_root: Path, old_root: Path):
    """升级=只覆盖程序件；用户数据区（他的需求库/台账/登录态）一个字节不碰——软件更新不碰用户内容。"""
    print(f"── 升级：{old_root} ← 本包（程序件覆盖，用户数据不动）──")
    om, nm = old_root / "MANIFEST.json", new_root / "MANIFEST.json"
    if om.exists() and nm.exists():
        try:
            o, n = json.loads(om.read_text(encoding="utf-8")), json.loads(nm.read_text(encoding="utf-8"))
            print(f"    版本：{o.get('打包时间', '?')} / {o.get('合计', {}).get('文件数', '?')}条  →  "
                  f"{n.get('打包时间', '?')} / {n.get('合计', {}).get('文件数', '?')}条")
        except Exception:
            pass
    n_top = 0
    for item in sorted(new_root.iterdir()):
        if item.name in USER_ZONES or item.name.startswith(("_migrate_backup", ".chrome-cdp")):
            print(f"    [保留·用户数据] {item.name}")
            continue
        if item.name in (".git", "__pycache__", "node_modules", "dist"):
            continue
        dst = old_root / item.name
        if item.is_dir():
            _copy_program_tree(item, dst, Path(item.name))
        else:
            if item.name == "MANIFEST.json":
                shutil.copy2(item, dst)
            elif not dst.exists():
                shutil.copy2(item, dst)
            else:
                print(f"    [保留·已有文件] {item.name}")
        n_top += 1
    ok(f"程序件已覆盖（顶层 {n_top} 项；公司配置/凭证与运行产物保护保留）")
    # 布局 v2 迁移：旧布局三资产先备份，再迁用户运行产物到新位置；同名不覆盖。
    import time as _t2
    for legacy, new_rel in (("jt_chrome", "agentqa_test/公司包/jt_exec"),
                            ("用例设计标准_我的定稿", "agentqa_test/公司包/标准体系"),
                            ("MD转XMind生成工具集", "agentqa_test/手艺包/05_交付工具链")):
        lp = old_root / legacy
        if lp.exists():
            newp = old_root / new_rel
            newp.mkdir(parents=True, exist_ok=True)
            if legacy == "jt_chrome":
                copied = _preserve_runtime(lp, newp)
                print(f"    [用户运行产物] 从旧 jt_chrome 补入 {copied} 件（同名不覆盖）")
            bak = old_root / f"{legacy}_旧布局备份_{_t2.strftime('%Y%m%d_%H%M%S')}"
            if not bak.exists():
                lp.rename(bak)
            print(f"    [布局迁移] {legacy} → {bak.name}（原件保留备查）")
    # 旧配置/凭证优先保留；缺失时从新包补齐，不覆盖用户值。
    old_company = old_root / "agentqa_test/公司包"
    new_company = new_root / "agentqa_test/公司包"
    for name in PROTECTED_COMPANY_FILES:
        src, dst = new_company / name, old_company / name
        if src.exists() and not dst.exists():
            shutil.copy2(src, dst)
            print(f"    [初始化] {name}（旧安装缺失，已从新包补入）")
    mp = old_root / "agentqa_test" / "Agent本体" / "tools" / "migrate_paths.py"
    r = subprocess.run([sys.executable, str(mp), str(old_root).replace("\\", "/"), "--apply"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print("\n".join("    " + x for x in (r.stdout or r.stderr or "").strip().splitlines()[-8:]))
        red("路径换算失败——升级未完成，安装登记不更新")
        return 1
    ok("路径已按旧根换算")
    pc = old_root / "agentqa_test" / "公司包" / "param_check.py"
    r = subprocess.run([sys.executable, str(pc), "--check"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    print("\n".join("    " + x for x in (r.stdout or "").strip().splitlines()[-2:]))
    if r.returncode != 0:
        red("param_check 未过——升级未完成，安装登记不更新")
        return 1
    ok("param_check PASS")
    write_reg(old_root)
    print("=" * 56)
    print(f"升级完成：{old_root}")
    print("用户数据（需求库/台账/登录态）原样保留；宿主接线不变；重开宿主会话即用新版。")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-rewire", action="store_true", help="跳过接线（本机双环境试验用）")
    ap.add_argument("--host", help="非交互指定接入宿主（逗号分隔：zcode,workbuddy,claude,codex,codebuddy）")
    ap.add_argument("--no-zcode", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--skip-deps", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--force", action="store_true", help="允许在 D:\\ZCodetest 正本目录执行")
    ap.add_argument("--no-pull", action="store_true", help="克隆通道跳过 git pull（离线/刚克隆完）")
    args = ap.parse_args()

    print("=" * 56)
    print("测试 Agent 一键部署")
    print("=" * 56)

    # ── 1. 定位根 + 防呆（布局自适应：安全包 / git 克隆两形态，2026-11-19）──
    if not PKG.is_dir():
        red(f"目录结构不像同事包/克隆仓（{PKG} 不存在）——解压完整 zip 或完整克隆后再跑")
        sys.exit(1)
    if IS_CLONE and ROOT.resolve().as_posix().lower() == "d:/zcodetest" and not args.force:
        red("这是发起人正本机（D:\\ZCodetest）——克隆通道部署在此机禁跑（--force 才放行）")
        sys.exit(1)
    print(f"  [OK ] 部署根 = {ROOT}" + ("〔git 克隆通道：三包根=克隆根〕" if IS_CLONE else "")
          + f"（部署器跟着目录走，装完别挪；挪了重跑 {LAUNCHER} 即可）")
    if IS_CLONE:
        # 克隆通道 git 同步：恢复受保护文件（还原上轮本地路径改写）→ 拉最新；本轮 migrate 重新换算，末尾再保护
        print("── git 同步（克隆通道）──")
        prot = git_skipped_files()
        if prot:
            r1 = git_pkg(["update-index", "--no-skip-worktree", "--"] + prot)
            r2 = git_pkg(["checkout", "--"] + prot)
            if r1.returncode == 0 and r2.returncode == 0:
                ok(f"已恢复 {len(prot)} 件受保护文件到库版本（本地路径改写本轮重新生成）")
            else:
                red("受保护文件恢复失败——git 状态异常，先跑 git status 处理后再来")
                sys.exit(1)
        if args.no_pull:
            print("  [跳过] --no-pull：本轮不拉远端")
        else:
            r = git_pkg(["pull", "--ff-only"])
            if r.returncode == 0:
                last = [x for x in (r.stdout or "").strip().splitlines() if x.strip()]
                ok("git pull --ff-only：" + (last[-1] if last else "已是最新"))
            else:
                print("  [黄] pull 未成（网络/代理？）——先用本地版本继续，恢复网络后重跑自举")

    # ── 1.5 升级检测（2026-11-17：更新只动程序，用户数据永不触碰）──
    reg = read_reg()
    if not IS_CLONE and reg and Path(reg["root"]).is_dir() and Path(reg["root"]) != ROOT:
        old = Path(reg["root"])
        print(f"  [检测] 本机已有部署：{old}（{reg.get('打包时间', '')} / {reg.get('条目', '')}条）")
        a = ""
        if sys.stdin is not None and sys.stdin.isatty():
            try:
                a = input("    回车=升级到旧位置（推荐：程序更新，你的数据/登录态不动）；输入 n=改为全新安装到本目录：").strip().lower()
            except EOFError:
                pass
        else:
            print("    [非交互] 默认升级到旧位置")
        if a != "n":
            sys.exit(upgrade(ROOT, old) or 0)
        print("    → 按选择：全新安装到本目录")

    # ── 2. 占位骨架（裁剪掉的域数据目录补占位，param_check 要求路径可达；幂等）──
    print("── 占位骨架 ──")
    for d in ["需求用例库/需求文档", "需求用例库/用例文件", "AiTest"]:
        p = ROOT / d
        p.mkdir(parents=True, exist_ok=True)
        ok(f"{d}\\")
    ledger = ROOT / "需求流水线台账_v1.md"
    if not ledger.exists():
        ledger.write_text(
            "# 需求流水线台账（同事部署占位——按需自行启用，格式见发起人正本）\n\n"
            "## 一、在途需求状态\n\n"
            "| 线 | 需求 | 当前阶段 | 断点详情 | 待拍板 | 阻塞 | 下一步动作 | 最后更新 |\n"
            "| --- | --- | --- | --- | --- | --- | --- | --- |\n", encoding="utf-8")
        ok("需求流水线台账_v1.md（占位）")
    else:
        ok("需求流水线台账_v1.md 已存在，跳过")

    # ── 3. 路径换算（整包内嵌 D:/ZCodetest → 当前根；migrate_paths 自带备份+幂等）──
    print("── 路径换算 ──")
    mp = HERE / "migrate_paths.py"
    r = subprocess.run([sys.executable, str(mp), str(ROOT).replace("\\", "/"), "--apply"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    tail = (r.stdout or r.stderr or "").strip().splitlines()
    print("\n".join("    " + x for x in tail[-4:]))
    if r.returncode != 0:
        red("migrate_paths 失败，见上方输出")
        sys.exit(1)
    ok("内嵌路径已全量换算为本目录（原件备份在 _migrate_backup_*\\）")

    # ── 4. 文档通用化（包内说明文档的 D:\ZCodetest 字样改为本目录，同事看到的就是自己的路径）──
    print("── 文档通用化 ──")
    root_win = str(ROOT).replace("/", "\\")
    root_fwd = str(ROOT).replace("\\", "/")
    n = 0
    mds = list(ROOT.glob("*.md")) + list((PKG if IS_CLONE else ROOT / "agentqa_test").glob("*.md"))
    if IS_CLONE:
        # 克隆通道：git 跟踪件（README 等发版说明）不做本地化改写——保住 git pull 更新流
        _tracked = git_tracked_set()

        def _is_tracked(m: Path) -> bool:
            try:
                return m.relative_to(PKG).as_posix() in _tracked
            except ValueError:
                return False
        mds = [m for m in mds if not _is_tracked(m)]
    for md in mds:
        try:
            s = md.read_text(encoding="utf-8")
        except Exception:
            continue
        if IS_MAC:
            s2 = s.replace("D:\\ZCodetest", root_fwd).replace("D:/ZCodetest", root_fwd)
        else:
            s2 = s.replace("D:\\ZCodetest", root_win).replace("D:/ZCodetest", root_fwd)
        if s2 != s:
            md.write_text(s2, encoding="utf-8")
            n += 1
    ok(f"说明文档路径本地化：{n} 件（部署说明/入口/README 等指向本目录）")

    # ── 5. 接线（宿主自适应：检测只报菜名，接哪个由同事选——不替用户决定往他的工具里塞东西）──
    print("── 宿主检测与接线 ──")
    home = Path(os.path.expanduser("~"))

    def real_use(d, signs, hollow=("diagnostics", "logs", "cache", "tmp")):
        """真实使用判定：签名文件/目录存在；或目录里除日志诊断类空壳外还有实质内容（防卸载/组件残留误报）"""
        if not d.is_dir():
            return False
        for s in signs:
            if (d / s).exists():
                return True
        real = [p for p in d.iterdir() if p.name.lower() not in hollow]
        return len(real) > 0

    hosts = []
    if real_use(home / ".zcode", ["cli/config.json"]):
        hosts.append(("ZCode", "100%（技能自动+五道机器闸）", "zcode", []))
    if real_use(home / ".workbuddy", ["skills", "settings.json"]):
        hosts.append(("WorkBuddy", "九成（技能联接；无 hooks 插槽→软闸=收尾跑 soft_gates_check.py）", "workbuddy", ["--workbuddy"]))
    if real_use(home / ".claude", ["settings.json", "projects", "sessions"]):
        hosts.append(("Claude Code", "试验档（技能联接可用；hooks 输出协议待 Claude 真机复验，不承诺 100%）", "claude", ["--claude"]))
    if real_use(home / ".codex", ["config.toml", "auth.json", "sessions"]):
        hosts.append(("Codex", "九成（.codex\\skills 原生技能目录联接；无工具级 hooks→软闸）", "codex", ["--codex"]))
    if real_use(home / ".codebuddy", ["skills", "config.json", "config.toml", "sessions"]):
        hosts.append(("CodeBuddy", "试验档（仅 CLI/skills 形态接线；IDE 插件版走手艺包三步，兼容性需同事真机复验）", "codebuddy", ["--codebuddy"]))
    if not hosts and not args.skip_rewire:
        red(f"未检测到任何宿主（ZCode / WorkBuddy / Claude Code / Codex / CodeBuddy）——安装未完成；装任一后重跑 {LAUNCHER}")
        sys.exit(1)
    else:
        print(f"    检测到 {len(hosts)} 个宿主（接入与否由你决定）：")
        for i, (name, grade, _k, _f) in enumerate(hosts, 1):
            print(f"      [{i}] {name} —— {grade}")
        chosen = []
        if args.host:                                     # 脚本化：--host zcode,codex
            keys = {x.strip().lower() for x in args.host.split(",")}
            chosen = [h for h in hosts if h[2] in keys]
            miss = keys - {h[2] for h in chosen}
            if miss:
                red(f"--host 指定的 {miss} 未检测到，忽略")
        elif args.skip_rewire:
            pass
        elif sys.stdin is not None and sys.stdin.isatty():
            tip = "回车=只接 [1]（推荐档）" if len(hosts) > 1 else "回车=接入"
            ans = input(f"    接哪个？输入编号（可多选如 1,3；a=全部；0=都不接；{tip}）：").strip().lower()
            if ans in ("", "1"):
                chosen = hosts[:1]
            elif ans == "a":
                chosen = hosts
            elif ans == "0":
                chosen = []
            else:
                idx = {int(x) - 1 for x in re.findall(r"\d+", ans)}
                chosen = [hosts[i] for i in idx if 0 <= i < len(hosts)]
        else:                                             # 非交互且未指定 → 克制默认：只接最高档
            chosen = hosts[:1]
            print("    [非交互模式] 默认只接推荐档；如需自选，重跑加 --host zcode,codex,…")
        if args.skip_rewire:
            ok(f"按参数跳过接线（试验模式；将可选：{'/'.join(h[0] for h in hosts) or '无宿主'}）")
        elif chosen:
            rw = HERE / "rewire.py"
            cmd = [sys.executable, str(rw), "--repair"] + [f for h in chosen for f in h[3]]
            if not any(h[2] == "zcode" for h in chosen):
                cmd.append("--no-zcode")
            r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
            print("\n".join("    " + x for x in (r.stdout or "").strip().splitlines()[-8:]))
            if r.returncode != 0:
                red("rewire 有红项——安装未完成，不写安装登记")
                sys.exit(1)
            else:
                ok(f"接线完成：{'、'.join(h[0] for h in chosen)}（重开对应宿主会话后生效）")
            if any(h[2] in ("workbuddy", "codex", "codebuddy", "claude") for h in chosen) and not any(h[2] == "zcode" for h in chosen):
                print("    [软闸] 所选宿主无 hooks 插槽：每轮执行/回写收尾前跑 "
                      f"\"{sys.executable}\" \"{HERE / 'soft_gates_check.py'}\"（正本直改嗅探/记忆体检/报告对账三查）")
        elif hosts and not args.skip_rewire:
            red("未选择任何宿主——安装未完成；重跑部署入口并选择至少一个宿主")
            sys.exit(1)

    # ── 5.5 依赖自装 ──
    print("── 依赖自装 ──")
    deps_ok = True
    if not args.skip_deps:
        import shutil as _sh
        npm = _sh.which("npm.cmd") if os.name == "nt" else _sh.which("npm")
        npm = npm or _sh.which("npm")
        if not npm:
            red("未检测到 npm（Node.js）——执行能力缺失；先装 Node.js 18+ 后重跑部署")
            deps_ok = False
        elif not ((PKG if IS_CLONE else ROOT) / "node_modules" / "playwright").is_dir():
            try:
                npm_cmd = ([os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", npm,
                            "i", "playwright", "--no-fund", "--no-audit", "--loglevel=error"]
                           if os.name == "nt" and npm.lower().endswith((".cmd", ".bat"))
                           else [npm, "i", "playwright", "--no-fund", "--no-audit", "--loglevel=error"])
                r = subprocess.run(npm_cmd, cwd=str(PKG if IS_CLONE else ROOT), capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", timeout=300)
                if r.returncode == 0:
                    ok("playwright 库已装（只连接本机 Chrome，不下载浏览器）")
                else:
                    red("playwright 自动安装失败——执行能力缺失；检查网络后重跑部署")
                    deps_ok = False
            except (OSError, subprocess.TimeoutExpired) as e:
                red(f"playwright 自动安装未完成：{e}")
                deps_ok = False
        else:
            ok("playwright 库已在位")
        import importlib.util as _iu
        # pillow/PIL 供蓝湖视觉还原（assemble/convert），playwright(python) 供 lanhu_collect.py
        for mod, pip_name in (("pymysql", "pymysql"), ("openpyxl", "openpyxl"), ("PIL", "pillow"), ("playwright", "playwright")):
            if _iu.find_spec(mod) is None:
                try:
                    r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", pip_name],
                                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
                    if r.returncode == 0: ok(f"{pip_name} 已装")
                    else: red(f"{pip_name} 自动安装失败"); deps_ok = False
                except (OSError, subprocess.TimeoutExpired) as e:
                    red(f"{pip_name} 自动安装未完成：{e}"); deps_ok = False
            else:
                ok(f"{pip_name} 已在位")
        if not deps_ok:
            red("依赖未齐——安装未完成，不写安装登记")
            sys.exit(1)
    else:
        print("  [测试模式] 跳过依赖安装")

    # ── 6. 校验 ──
    print("── 校验 ──")
    pc = PKG / "公司包" / "param_check.py"
    r = subprocess.run([sys.executable, str(pc), "--check"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    print("\n".join("    " + x for x in (r.stdout or "").strip().splitlines()[-2:]))
    if r.returncode != 0:
        red("param_check 未过——把上面输出发给发起人")
        sys.exit(1)
    ok("param_check PASS（48 值零丢失+路径全可达）")

    if IS_CLONE:
        # ── 6.5 git 保护（克隆通道）：本轮 migrate/接线产生的本地路径改写全部 skip-worktree，
        #    同事的 git pull 永不与本地路径冲突；拉最新=重跑本部署器（恢复→pull→重换算→重新保护）──
        print("── git 保护（克隆通道）──")
        r = git_pkg(["diff", "--name-only"])
        mods = [l.strip().replace("\\", "/") for l in (r.stdout or "").splitlines() if l.strip()]
        if mods:
            git_pkg(["update-index", "--skip-worktree", "--"] + mods)
            ok(f"本地路径改写已保护 {len(mods)} 件（skip-worktree；例：{'、'.join(mods[:3])}…）")
        else:
            ok("无本地改写，无需保护")
        print("       以后拉最新=重跑自举（自动 恢复→pull→重换算→重新保护）；你新建的文件不受影响")

    # ── 7. 凭证状态提示 ──
    sec = PKG / "公司包" / "agent-secrets.json"
    print("── 凭证 ──")
    if sec.exists():
        s = sec.read_text(encoding="utf-8")
        blank = s.count('""') + s.count("''")
        if blank >= 4:
            ok("agent-secrets.json 是空值骨架——填入你的账密后保存（四组：jt_login/jt_login_2/pm_login/db_pwqsdb）")
        else:
            ok("agent-secrets.json 已含凭证（红线：仅公司内使用，永不再外发）")

    print("=" * 56)
    write_reg(ROOT)
    ok(f"安装登记已写入 {REG.name}（以后升级自动找到这里，你的数据不动）")
    print("部署完成。下一步：重开你选择的宿主会话，再按《真机首验清单》验证。")
    print('会话说"登录鲸天"冒烟 → 丢一份需求文档说"熟悉下这个需求"冒烟。')
    print("=" * 56)


if __name__ == "__main__":
    main()
