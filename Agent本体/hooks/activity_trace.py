# -*- coding: utf-8 -*-
"""PostToolUse：计时底账·工具调用时刻（2026-11-16 立，计时与时间线规范 §十一 第二批；2026-11-25 抽公共件供回合钩子复用）。

动作：把每次工具调用时刻追加到 <workspace>\\.zcode\\agent_activity.jsonl（北京时间+08:00 秒级），
供 timeline_mark.py 按本会话算各阶段净耗时（工具时刻聚簇；相邻间隔≤180s 归同工作段，等待用户期无记录=不计）。
Skill 工具调用另记 skill 名（漏记探测用）。回合起止见同目录 turn_in_trace.py / turn_out_trace.py。
口径正本=agentqa_test\\公司包\\标准体系\\计时与时间线规范_v1.md（2026-11-19 正本收拢于此，旧工作区目录=死副本勿读勿写）。
不改文件不阻断（exit 0）；文件超 10MB 滚动一次。路径由 __file__ 推导不写死（同 rewire 模式）。
注意：2026-11-25 探针实证——钩子在子代理内不触发，子代理的运行时长由 timeline_mark.py 读宿主元数据补齐。
"""
import io
import json
import os
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


def read_stdin():
    """钩子输入（JSON 对象）；空输入/乱码/非对象一律当空对象，绝不抛错"""
    try:
        obj = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace") or "{}")
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def sid_of(data):
    """会话标识前 16 位：优先钩子输入里的 session_id，退回宿主注入的环境变量"""
    s = data.get("session_id") or os.environ.get("CLAUDE_SESSION_ID") or os.environ.get("ZCODE_SESSION_ID") or ""
    return str(s)[:16] or None


def append_rec(rec):
    """底账尽力而为：记录失败绝不干扰工具执行/回合"""
    try:
        ACTIVITY.parent.mkdir(parents=True, exist_ok=True)
        if ACTIVITY.exists() and ACTIVITY.stat().st_size > MAX_BYTES:
            ACTIVITY.rename(ACTIVITY.with_suffix(".jsonl.rotated_" + time.strftime("%Y%m%d_%H%M%S")))
        with io.open(ACTIVITY, "a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


def main():
    try:
        data = read_stdin()
        tool = data.get("tool_name") or data.get("tool") or "?"
        ti = data.get("tool_input") or {}
        fp = str(ti.get("file_path") or ti.get("path") or ti.get("command") or "")[:120]
        rec = {"ts": bj_ts(), "event": "pre" if data.get("event") == "PreToolUse" else "post",
               "tool": tool, "fp": fp}
        if tool == "Skill" and ti.get("skill"):
            rec["skill"] = str(ti["skill"])[:40]
        sid = sid_of(data)
        if sid:
            rec["sid"] = sid
        append_rec(rec)
    except Exception:
        pass  # 底账尽力而为：记录失败绝不干扰工具执行


if __name__ == "__main__":
    main()
    sys.exit(0)
