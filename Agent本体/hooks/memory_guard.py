# -*- coding: utf-8 -*-
"""PostToolUse：记忆索引守卫（2026-11-15 立，随 memory_health_check.py 三道防线）。

命中条件：Write|Edit 的 file_path 为 memories\\…\\MEMORY.md（记忆索引）。
动作：跑 tools\\memory_health_check.py --path <该文件>，把四查结论注入当前会话——
  绿=一句话安心；黄=提醒（条目回退需 --sync-state/--restore 处置）；红=强提醒+修复指引。
定位与校验器同在 Agent本体（tools\\），路径由 __file__ 推导，不写死。
不改文件、不阻断（exit 0），自动修复只由人跑 --repair 触发——hook 只报不修，防并发下连环写。
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

TARGET_RX = re.compile(r"[\\/]memories[\\/].*MEMORY\.md$", re.I)


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except Exception:
        return
    fp = ((data.get("tool_input") or {}).get("file_path") or "").replace("/", "\\")
    if not fp or not TARGET_RX.search(fp):
        return
    checker = Path(__file__).resolve().parent.parent / "tools" / "memory_health_check.py"
    if not checker.exists():
        sys.stdout.buffer.write(json.dumps({"additionalContext":
            f"⚠[记忆守卫] 校验器缺失：{checker}"}, ensure_ascii=False).encode("utf-8"))
        return
    r = subprocess.run([sys.executable, str(checker), "--path", fp],
                       capture_output=True, timeout=60,
                       env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    out = r.stdout.decode("utf-8", "replace").strip()
    tail = "\n".join(out.splitlines()[-8:])
    if r.returncode == 0:
        msg = f"✅[记忆守卫] MEMORY.md 写后体检绿灯：\n{tail}"
    else:
        msg = (f"🔴[记忆守卫] MEMORY.md 写后体检有红项，坏索引活不过本次写入，请当场处置后再继续：\n{tail}\n"
               f"修复入口：python \"{checker}\" --repair --path \"{fp}\"（重复拼接自动修）；瘦身=索引一行一钩子细节入主题文件")
    sys.stdout.buffer.write(json.dumps({"additionalContext": msg}, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
