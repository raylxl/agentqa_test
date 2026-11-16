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
import sys, os, subprocess, argparse
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = Path(__file__).resolve().parent          # <根>\agentqa_test\Agent本体\tools
ROOT = HERE.parents[2]                          # 解压根（任意盘任意目录）


def ok(msg):  print(f"  [OK ] {msg}")
def red(msg): print(f"  [红 ] {msg}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-rewire", action="store_true", help="跳过接线（本机双环境试验用）")
    ap.add_argument("--force", action="store_true", help="允许在 D:\\ZCodetest 正本目录执行")
    args = ap.parse_args()

    print("=" * 56)
    print("测试 Agent 一键部署")
    print("=" * 56)

    # ── 1. 定位根 + 防呆 ──
    if not (ROOT / "agentqa_test").is_dir():
        red(f"目录结构不像同事包（{ROOT}\\agentqa_test 不存在）——请解压完整 zip 后再跑")
        sys.exit(1)
    print(f"  [OK ] 部署根 = {ROOT}（部署器跟着目录走，装完别挪；挪了重跑本部署器即可）")
    if str(ROOT).replace("/", "\\").lower() == "d:\\zcodetest" and not args.force:
        red("检测到这是发起人正本目录 D:\\ZCodetest——请换目录试验，或加 --force 确认")
        sys.exit(1)

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
        s2 = s.replace("D:\\ZCodetest", root_win).replace("D:/ZCodetest", root_fwd)
        if s2 != s:
            md.write_text(s2, encoding="utf-8")
            n += 1
    ok(f"说明文档路径本地化：{n} 件（部署说明/入口/README 等指向本目录）")

    # ── 5. 接线（宿主自适应：检测装了什么就接什么，同事不用选）──
    print("── 宿主检测与接线 ──")
    home = Path(os.path.expanduser("~"))
    hosts = []
    if (home / ".zcode").is_dir():
        hosts.append(("ZCode", "100%（技能自动+五道机器闸）", []))
    if (home / ".workbuddy").is_dir():
        hosts.append(("WorkBuddy", "九成（技能联接；无 hooks 插槽→软闸=收尾跑 soft_gates_check.py）", ["--workbuddy"]))
    if (home / ".claude").is_dir():
        hosts.append(("Claude Code", "100%目标（技能联接+五闸按其格式注册；运行时行为属真机首验项）", ["--claude"]))
    if (home / ".codex").is_dir():
        hosts.append(("Codex", "九成（.codex\\skills 原生技能目录联接；无工具级 hooks→软闸）", ["--codex"]))
    if (home / ".codebuddy").is_dir():
        hosts.append(("CodeBuddy", "九成档预设（.codebuddy\\skills 技能联接——CodeBuddy Code CLI 适用；hooks 兼容性属首验实测项；IDE 插件版无插槽请走手艺包三步）", ["--codebuddy"]))
    if not hosts:
        red("未检测到任何宿主（ZCode / WorkBuddy / Claude Code）——装任一后重跑部署.bat，或按部署说明手动挂技能")
    for name, grade, flags in hosts:
        print(f"    检测到 {name} → {grade}")
    if args.skip_rewire:
        ok(f"按参数跳过接线（试验模式；正式部署将接入：{'/'.join(h[0] for h in hosts) or '无宿主'}）")
    elif hosts:
        rw = HERE / "rewire.py"
        cmd = [sys.executable, str(rw), "--repair"] + [f for h in hosts for f in h[2]]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        print("\n".join("    " + x for x in (r.stdout or "").strip().splitlines()[-8:]))
        if r.returncode != 0:
            red("rewire 有红项，见上方输出（宿主未登录/目录被占常见）")
        else:
            ok("接线完成（重开对应宿主会话后生效）")
        if any(h[0] in ("WorkBuddy", "Codex", "CodeBuddy") for h in hosts) and not any(h[0] == "ZCode" for h in hosts):
            print("    [软闸] 本机无 hooks 宿主：每轮执行/回写收尾前跑 "
                  f"python \"{HERE / 'soft_gates_check.py'}\"（正本直改嗅探/记忆体检/报告对账三查）")

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
    print("部署完成。下一步：重开 ZCode 会话 → 跑 rewire --status 四道验证 →")
    print('会话说"登录鲸天"冒烟 → 丢一份需求文档说"熟悉下这个需求"冒烟。')
    print("=" * 56)


if __name__ == "__main__":
    main()
