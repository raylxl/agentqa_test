# -*- coding: utf-8 -*-
"""
软闸检查器（无 hooks 宿主用，如 WorkBuddy）——把机器闸降级为"工序检查"：
每轮执行/回写收尾前手动跑一次，替代 PreToolUse/PostToolUse 的事前拦截为事后抓取。

用法：python soft_gates_check.py          （在公司包配置可达的环境跑；无配置则全跳过只提示）
三查：
  ① 正本直改嗅探：用例正本 md 的修改时间 晚于 其分章目录最新文件 → 警"可能被直改，请重组装"
  ② 记忆索引体检：调 memory_health_check --full（存在才跑；多会话并发写坏可检出）
  ③ 报告收尾对账：根目录各测试报告是否有"最后收尾"行（无=该轮未收尾，提醒补）
"""
import sys, os, subprocess, re
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = Path(__file__).resolve().parent


def find_config():
    for base in [HERE.parents[1], HERE.parents[2], Path.cwd()]:      # Agent本体\tools → 公司包 / 工作区根
        for cand in [base / "agent-company.json", base / "公司包" / "agent-company.json"]:
            if cand.exists():
                import json
                return json.loads(cand.read_text(encoding="utf-8"))
    return None


def main():
    red = 0
    print("=" * 52)
    print("软闸检查（无 hooks 宿主的工序级补偿）")
    print("=" * 52)

    cfg = find_config()
    if not cfg:
        print("  [红 ] 未找到 agent-company.json——软闸未执行；请在部署根的 agentqa_test/Agent本体/tools 下运行")
        return 1

    # ── ① 正本直改嗅探 ──
    print("── ① 正本直改嗅探 ──")
    uc_dir = Path(cfg["paths"]["用例文件"])
    hits = 0
    if uc_dir.is_dir():
        for md in uc_dir.glob("*_测试用例_v*.md"):
            m = re.match(r"(.+?)_测试用例_v", md.name)
            chap = uc_dir / (m.group(1) + "分章") if m else None
            if chap and chap.is_dir():
                chapter_files = [p for p in chap.rglob("*") if p.is_file()]
                if not chapter_files:
                    print(f"  [提示] {chap.name} 为空，暂无分章可对账")
                    continue
                newest = max(p.stat().st_mtime for p in chapter_files)
                if md.stat().st_mtime > newest + 60:      # 60s 容差
                    print(f"  [警] {md.name} 比分章新——可能被直改，请重跑组装（硬闸环境本会在事前拦下）")
                    hits += 1
    print(f"  [OK ] 嗅探完成，疑似直改 { hits } 件" if hits == 0 else f"  [红 ] 疑似直改 {hits} 件")
    red += hits

    # ── ② 记忆索引体检 ──
    print("── ② 记忆索引体检 ──")
    mhc = HERE / "memory_health_check.py"
    if mhc.exists():
        r = subprocess.run([sys.executable, str(mhc), "--full"], capture_output=True,
                           text=True, encoding="utf-8", errors="replace")
        tail = [x for x in (r.stdout or "").splitlines() if x.strip()][-3:]
        print("\n".join("  " + x for x in tail))
        out = r.stdout or ""
        if "未找到" in out and "MEMORY" in out:
            print("  [提示] 本机无 ZCode 记忆目录（WorkBuddy/Codex 等宿主档常态）——记忆体检跳过，不算红")
        elif r.returncode != 0:
            red += 1
    else:
        print("  [提示] 未找到 memory_health_check.py，跳过")

    # ── ③ 报告收尾对账 ──
    print("── ③ 报告收尾对账 ──")
    n_no_close = 0
    if uc_dir.is_dir():
        for rp in uc_dir.glob("*_测试报告_v*.md"):
            if "最后收尾" not in rp.read_text(encoding="utf-8", errors="replace")[:4000]:
                print(f"  [警] {rp.name} 头部无『最后收尾』行——该轮未收尾，补收尾或跑 report_sync")
                n_no_close += 1
    if n_no_close == 0:
        print("  [OK ] 各报告收尾声明齐")
    red += n_no_close

    print("=" * 52)
    print(f"结论：{'全绿' if red == 0 else f'红/警 {red} 项——按上面提示处置后再收尾'}")
    return 1 if red else 0


if __name__ == "__main__":
    sys.exit(main())
