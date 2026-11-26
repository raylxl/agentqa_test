# -*- coding: utf-8 -*-
"""PostToolUse：记忆索引守卫（2026-11-15 立，随 memory_health_check.py 三道防线；2026-11-26 判据更正＋分册）。

命中条件：Write|Edit 的 file_path 为 memories\\…\\MEMORY.md（记忆总索引）或 分册索引_*.md（总索引的分册）。
动作：跑 tools\\memory_health_check.py --path <该目录的 MEMORY.md>，把五查结论注入当前会话——
  绿=一句话安心；黄=提醒（接近行数上限→按提示折叠；条目回退需 --sync-state/--restore 处置）；红=强提醒+修复指引。
客户端上限是 200 行／25000 字符（不是字节）：超出的尾部不会加载。
定位与校验器同在 Agent本体（tools\\），路径由 __file__ 推导，不写死。
不改文件、不阻断（exit 0），自动修复与折叠只由助手跑 --repair / --fold 触发——hook 只报不修，防并发下连环写。
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

TARGET_RX = re.compile(r"[\\/]memories[\\/].*(?:MEMORY|分册索引_[^\\/]+)\.md$", re.I)


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
    # 分册被写入时体检同目录的总索引（断链、条目回退都按 总索引∪分册 算）
    target = fp if fp.lower().endswith("memory.md") else str(Path(fp).parent / "MEMORY.md")
    r = subprocess.run([sys.executable, str(checker), "--path", target],
                       capture_output=True, timeout=60,
                       env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    out = r.stdout.decode("utf-8", "replace").strip()
    tail = "\n".join(out.splitlines()[-8:])
    if r.returncode == 0:
        msg = f"✅[记忆守卫] 记忆索引写后体检无红项：\n{tail}"
    else:
        msg = (f"🔴[记忆守卫] 记忆索引写后体检有红项，坏索引活不过本次写入，请当场处置后再继续：\n{tail}\n"
               f"修复入口：重复拼接=python \"{checker}\" --repair --path \"{target}\"；"
               f"超过 200 行/25000 字符=--fold \"<节名>\" 折叠低频的节（规则节不折叠）。"
               f"规则与资源类条目的可执行要点必须留在索引，不能以瘦身为由删掉")
    sys.stdout.buffer.write(json.dumps({"additionalContext": msg}, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
