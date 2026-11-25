# -*- coding: utf-8 -*-
"""UserPromptSubmit：计时底账·回合开始时刻（2026-11-25 立，计时与时间线规范 v1.2 §十一）。

记一行 turn_in（北京时间秒级＋会话标识）到 agent_activity.jsonl，与 turn_out_trace.py 配对得出
"agent 正在操作的回合区间"——用户思考/答复的时间（两个回合之间）天然不计。
不记输入内容（只记字数），不输出、不阻断（exit 0）。公共件=同目录 activity_trace.py。
"""
import sys

from activity_trace import append_rec, bj_ts, read_stdin, sid_of


def main():
    try:
        data = read_stdin()
        rec = {"ts": bj_ts(), "event": "turn_in", "tool": "UserPromptSubmit", "fp": "",
               "chars": len(str(data.get("prompt") or ""))}
        sid = sid_of(data)
        if sid:
            rec["sid"] = sid
        append_rec(rec)
    except Exception:
        pass  # 底账尽力而为：记录失败绝不干扰会话


if __name__ == "__main__":
    main()
    sys.exit(0)
