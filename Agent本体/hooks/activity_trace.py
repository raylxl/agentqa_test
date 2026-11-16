# -*- coding: utf-8 -*-
"""PreToolUse/PostToolUse：计时底账（2026-11-16 立，计时与时间线规范 §十一 第二批）。

动作：把每次工具调用时刻追加到 <workspace>\\.zcode\\agent_activity.jsonl（北京时间+08:00 秒级），
供 metrics_summary 聚簇计算各阶段净耗时（相邻间隔≤180s 归同工作段；等待用户期自然无记录=不计）。
口径正本=用例设计标准_我的定稿\\计时与时间线规范_v1.md（net=只计 agent 操作时长）。
不改文件不阻断（exit 0）；文件超 10MB 滚动一次。路径由 __file__ 推导不写死（同 rewire 模式）。
"""
import io
import json
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ACTIVITY = Path(__file__).resolve().parents[2].parent / ".zcode" / "agent_activity.jsonl"
MAX_BYTES = 10 * 1024 * 1024


def bj_ts():
    t = time.time() + 8 * 3600
    lt = time.gmtime(t)
    return time.strftime("%Y-%m-%d %H:%M:%S", lt) + "+08:00"


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace") or "{}")
    except Exception:
        return
    tool = data.get("tool_name") or data.get("tool") or "?"
    ti = data.get("tool_input") or {}
    fp = str(ti.get("file_path") or ti.get("path") or ti.get("command") or "")[:120]
    rec = {"ts": bj_ts(), "event": "pre" if data.get("event") == "PreToolUse" else "post",
           "tool": tool, "fp": fp}
    if data.get("session_id"):
        rec["sid"] = str(data["session_id"])[:16]
    try:
        ACTIVITY.parent.mkdir(parents=True, exist_ok=True)
        if ACTIVITY.exists() and ACTIVITY.stat().st_size > MAX_BYTES:
            ACTIVITY.rename(ACTIVITY.with_suffix(".jsonl.rotated_" + time.strftime("%Y%m%d_%H%M%S")))
        with io.open(ACTIVITY, "a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass  # 底账尽力而为：记录失败绝不干扰工具执行


if __name__ == "__main__":
    main()
