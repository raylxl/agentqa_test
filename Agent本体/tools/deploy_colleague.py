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


def ok(msg):  print(f"  [OK ] {msg}")
def red(msg): print(f"  [红 ] {msg}")

REG = Path(os.path.expanduser("~")) / ".testagent_deploy.json"     # 安装登记（升级模式的记忆）
USER_ZONES = {"需求用例库", "AiTest", ".chrome-cdp", "需求流水线台账_v1.md"}   # 用户数据区：升级永不触碰


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
            shutil.copytree(item, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(item, dst)
        n_top += 1
    ok(f"程序件已覆盖（顶层 {n_top} 项）")
    # 布局 v2 迁移：旧布局把三资产放部署根——升级后改名为备份，不删（防同事在旧目录里有运行产物）
    import time as _t2
    for legacy in ("jt_chrome", "用例设计标准_我的定稿", "MD转XMind生成工具集"):
        lp = old_root / legacy
        if lp.exists():
            bak = old_root / f"{legacy}_旧布局备份_{_t2.strftime('%Y%m%d_%H%M%S')}"
            lp.rename(bak)
            print(f"    [布局迁移] {legacy} → {bak.name}（新版已收进 agentqa_test 内；旧件保留可查删）")
    mp = new_root / "agentqa_test" / "Agent本体" / "tools" / "migrate_paths.py"   # 新文件未换算 → 按旧根重跑（幂等）
    r = subprocess.run([sys.executable, str(mp), str(old_root).replace("\\", "/"), "--apply"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    ok("路径已按旧根换算" if r.returncode == 0 else "换算异常——把上方输出发发起人")
    pc = old_root / "agentqa_test" / "公司包" / "param_check.py"
    r = subprocess.run([sys.executable, str(pc), "--check"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    print("\n".join("    " + x for x in (r.stdout or "").strip().splitlines()[-2:]))
    ok("param_check PASS" if r.returncode == 0 else "param_check 未过——回传输出")
    write_reg(old_root)
    print("=" * 56)
    print(f"升级完成：{old_root}")
    print("用户数据（需求库/台账/登录态）原样保留；宿主接线不变；重开宿主会话即用新版。")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-rewire", action="store_true", help="跳过接线（本机双环境试验用）")
    ap.add_argument("--host", help="非交互指定接入宿主（逗号分隔：zcode,workbuddy,claude,codex,codebuddy）")
    ap.add_argument("--force", action="store_true", help="允许在 D:\\ZCodetest 正本目录执行")
    args = ap.parse_args()

    print("=" * 56)
    print("测试 Agent 一键部署")
    print("=" * 56)

    # ── 1. 定位根 + 防呆 ──
    if not (ROOT / "agentqa_test").is_dir():
        red(f"目录结构不像同事包（{ROOT}\\agentqa_test 不存在）——请解压完整 zip 后再跑")
        sys.exit(1)
    print(f"  [OK ] 部署根 = {ROOT}（部署器跟着目录走，装完别挪；挪了重跑 {LAUNCHER} 即可）")
    if str(ROOT).replace("/", "\\").lower() == "d:\\zcodetest" and not args.force:
        red("检测到这是发起人正本目录 D:\\ZCodetest——请换目录试验，或加 --force 确认")
        sys.exit(1)

    # ── 1.5 升级检测（2026-11-17：更新只动程序，用户数据永不触碰）──
    reg = read_reg()
    if reg and Path(reg["root"]).is_dir() and Path(reg["root"]) != ROOT:
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
            upgrade(ROOT, old)
            sys.exit(0)
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
    for md in list(ROOT.glob("*.md")) + list((ROOT / "agentqa_test").glob("*.md")):
        try:
            s = md.read_text(encoding="utf-8")
        except Exception:
            continue
        if IS_MAC:   # Mac 上目标路径只认正斜杠——两种源写法都换正斜杠形态（R2：反斜杠源串换出 \Users\... 是坏路径）
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
        hosts.append(("Claude Code", "100%目标（技能联接+五闸按其格式注册；运行时行为属真机首验项）", "claude", ["--claude"]))
    if real_use(home / ".codex", ["config.toml", "auth.json", "sessions"]):
        hosts.append(("Codex", "九成（.codex\\skills 原生技能目录联接；无工具级 hooks→软闸）", "codex", ["--codex"]))
    if real_use(home / ".codebuddy", ["skills", "config.json", "config.toml", "sessions"]):
        hosts.append(("CodeBuddy", "九成档预设（.codebuddy\\skills 技能联接——CLI 版适用；hooks 兼容性属首验实测；IDE 插件版走手艺包三步）", "codebuddy", ["--codebuddy"]))
    if not hosts:
        red(f"未检测到任何宿主（ZCode / WorkBuddy / Claude Code / Codex / CodeBuddy）——装任一后重跑 {LAUNCHER}，或按部署说明手动挂技能")
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
            r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
            print("\n".join("    " + x for x in (r.stdout or "").strip().splitlines()[-8:]))
            if r.returncode != 0:
                red("rewire 有红项，见上方输出（宿主未登录/目录被占常见）")
            else:
                ok(f"接线完成：{'、'.join(h[0] for h in chosen)}（重开对应宿主会话后生效）")
            if any(h[2] in ("workbuddy", "codex", "codebuddy") for h in chosen) and not any(h[2] == "zcode" for h in chosen):
                print("    [软闸] 所选宿主无 hooks 插槽：每轮执行/回写收尾前跑 "
                      f"python \"{HERE / 'soft_gates_check.py'}\"（正本直改嗅探/记忆体检/报告对账三查）")
        elif hosts:
            print(f"    按选择未接入任何宿主——想接时重跑 {LAUNCHER} 再选")

    # ── 5.5 依赖自装（Mac 首验 R4：playwright/pymysql 缺失自动化——只装库不装浏览器，执行链连本机 Chrome 用）──
    print("── 依赖自装 ──")
    import shutil as _sh
    if _sh.which("npm"):
        if not (ROOT / "node_modules" / "playwright").is_dir():
            r = subprocess.run(["npm", "i", "playwright", "--no-fund", "--no-audit", "--loglevel=error"],
                               cwd=str(ROOT), capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=300)
            ok("playwright 库已装（连接用，不下载浏览器——执行链连你本机的 Chrome）" if r.returncode == 0
               else "playwright 安装失败（网络？）——不影响部署，需要执行侧时在部署根手动 npm i playwright")
        else:
            ok("playwright 库已在位")
    else:
        print("  [提示] 未检测到 npm（Node.js）——执行侧需要时先装 Node 18+ 再 npm i playwright")
    import importlib.util as _iu
    for mod, pip_name in (("pymysql", "pymysql"), ("openpyxl", "openpyxl")):
        if _iu.find_spec(mod) is None:
            r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", pip_name],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
            ok(f"{pip_name} 已装" if r.returncode == 0 else f"{pip_name} 安装失败——需要 DB/xlsx 功能时手动 pip install {pip_name}")
        else:
            ok(f"{pip_name} 已在位")

    # ── 6. 校验 ──
    print("── 校验 ──")
    pc = ROOT / "agentqa_test" / "公司包" / "param_check.py"
    r = subprocess.run([sys.executable, str(pc), "--check"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    print("\n".join("    " + x for x in (r.stdout or "").strip().splitlines()[-2:]))
    if r.returncode != 0:
        red("param_check 未过——把上面输出发给发起人")
        sys.exit(1)
    ok("param_check PASS（48 值零丢失+路径全可达）")

    # ── 7. 凭证状态提示 ──
    sec = ROOT / "agentqa_test" / "公司包" / "agent-secrets.json"
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
    print("部署完成。下一步：重开 ZCode 会话 → 跑 rewire --status 四道验证 →")
    print('会话说"登录鲸天"冒烟 → 丢一份需求文档说"熟悉下这个需求"冒烟。')
    print("=" * 56)


if __name__ == "__main__":
    main()
