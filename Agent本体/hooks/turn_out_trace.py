# -*- coding: utf-8 -*-
"""Stop：计时底账·回合结束时刻（2026-11-25 立，计时与时间线规范 v1.2 §十一）。

记一行 turn_out（北京时间秒级＋会话标识）到 agent_activity.jsonl，与 turn_in_trace.py 配对。
**绝不输出任何内容**：Stop 钩子的标准输出会被宿主当作"请求继续"的指令解析，这里只记不回、exit 0。
公共件=同目录 activity_trace.py。
"""
import sys

from activity_trace import append_rec, bj_ts, read_stdin, sid_of


def main():
    try:
        data = read_stdin()
        rec = {"ts": bj_ts(), "event": "turn_out", "tool": "Stop", "fp": ""}
        sid = sid_of(data)
        if sid:
            rec["sid"] = sid
        append_rec(rec)
    except Exception:
        pass  # 底账尽力而为：记录失败绝不干扰会话


if __name__ == "__main__":
    main()
    sys.exit(0)
