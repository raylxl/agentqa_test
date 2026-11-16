# -*- coding: utf-8 -*-
"""timeline_check.py — timeline.jsonl 机检与净耗时计算（计时与时间线规范 §十，2026-11-16 第二批）

用法：
  python timeline_check.py <timeline.jsonl> [--ledger <ledger.jsonl>]
      机检九项：①行 JSON 合法 ②必填字段 ③ts=北京时间 YYYY-MM-DD HH:MM:SS+08:00 ④phase∈12 阶段枚举
      ⑤duration_kind∈net/wall/unknown ⑥kind=net 时 net_ms 数值>0 ⑦net/wall 段 artifact+evidence 非空
      ⑧阶段首现序粗单调（received→…→archive；同阶段多轮允许）⑨--ledger 给出时 run 段 run_id 须存在于账本批次行
  python timeline_check.py --net <agent_activity.jsonl> --since "2026-11-16 14:00" [--until "…"]
      净耗时辅助：activity 底账按相邻间隔≤180s 聚簇为工作段（等待用户期无记录=不计），输出各段与合计
  python timeline_check.py --selftest
      内置样例自测（含 7 类违规必中 + 合规样例必绿）
红=exit 1（接交付门禁用）；输出人读结论。
"""
import argparse
import io
import json
import re
import sys
import time
from datetime import datetime, timedelta

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

PH_ORDER = ["received", "locate", "qa", "brief", "approval", "generate", "qc",
            "deliver", "prep", "run", "close", "archive"]
TS_RX = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+08:00$")
REQUIRED = ["timeline_id", "phase", "event", "ts", "duration_kind"]


def parse_ts(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S+08:00")


def check(path, ledger=None):
    reds, warns, n = [], [], 0
    try:
        text = io.open(path, encoding="utf-8").read()
    except OSError as e:
        print(f"[RED] 无法读取 {path}: {e}")
        return 1
    first_seen, run_ids = [], set()
    for i, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        n += 1
        try:
            ev = json.loads(line)
        except json.JSONDecodeError as e:
            reds.append(f"行{i} JSON 解析失败: {e}")
            continue
        miss = [k for k in REQUIRED if not ev.get(k)]
        if miss:
            reds.append(f"行{i} 缺必填字段: {'、'.join(miss)}")
            continue
        ph = str(ev["phase"])
        if ph not in PH_ORDER:
            reds.append(f"行{i} phase 非法: {ph}")
        elif ph not in first_seen:
            first_seen.append(ph)
        kind = str(ev["duration_kind"])
        if kind not in ("net", "wall", "unknown"):
            reds.append(f"行{i} duration_kind 非法: {kind}")
        if not TS_RX.match(str(ev["ts"])):
            reds.append(f"行{i} ts 格式非北京时间规范: {ev['ts']}")
        if kind == "net":
            v = ev.get("net_ms")
            if not isinstance(v, (int, float)) or v <= 0:
                reds.append(f"行{i} kind=net 但 net_ms 缺失/非正数: {v}")
            if not ev.get("artifact") or not ev.get("evidence"):
                reds.append(f"行{i} net 段缺 artifact/evidence")
        if kind == "wall" and not ev.get("artifact"):
            reds.append(f"行{i} wall 段缺 artifact")
        if ph == "run" and ev.get("run_id"):
            run_ids.add(str(ev["run_id"]))
    # ⑧ 阶段首现序粗单调
    idx = [PH_ORDER.index(p) for p in first_seen if p in PH_ORDER]
    if idx != sorted(idx):
        reds.append(f"阶段首现序乱序: {'→'.join(first_seen)}（应粗单调 received→…→archive）")
    # ⑨ 账本批次行存在性
    if ledger:
        try:
            led_runs = set()
            for line in io.open(ledger, encoding="utf-8"):
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                if row.get("type") == "run_start":
                    led_runs.add(str(row.get("runId") or ""))
            miss = run_ids - led_runs
            if miss:
                reds.append(f"run 段 run_id 不在账本批次行: {', '.join(sorted(miss)[:5])}")
            else:
                print(f"  ✓ run_id 对账 {len(run_ids)}/{len(run_ids)} 均在账本 {ledger.split('/')[-1]}")
        except OSError as e:
            warns.append(f"账本不可读（跳过⑨）: {e}")
    print(f"── timeline_check：{path}")
    print(f"  事件 {n} 行 / 阶段 {len(first_seen)} 个（{'>'.join(first_seen)}）")
    for w in warns:
        print(f"  ⚠ {w}")
    if reds:
        for r in reds:
            print(f"  ✗ {r}")
        print(f"结论：[RED] {len(reds)} 项违规")
        return 1
    print("结论：[GREEN] 九项全过")
    return 0


def net_from_activity(path, since, until=None):
    """相邻间隔≤180s 聚簇为工作段；净耗时=各段首末跨度之和（等待用户期无记录=天然不计）。"""
    rows = []
    for line in io.open(path, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        t = r.get("ts", "")
        if t >= since and (until is None or t <= until):
            try:
                rows.append((parse_ts(t), r.get("tool", "?")))
            except ValueError:
                pass
    rows.sort()
    if not rows:
        print(f"[RED] 窗口 {since}~{until or '现在'} 内无 activity 记录")
        return 1
    segs, cur = [], [rows[0]]
    for prev, nxt in zip(rows, rows[1:]):
        if (nxt[0] - prev[0]).total_seconds() <= 180:
            cur.append(nxt)
        else:
            segs.append(cur)
            cur = [nxt]
    segs.append(cur)
    total = sum((s[-1][0] - s[0][0]).total_seconds() for s in segs)
    print(f"窗口 {since} ~ {until or rows[-1][0]}：工作段 {len(segs)} 个，净耗时合计 {int(total // 60)}分{int(total % 60)}秒")
    for i, s in enumerate(segs, 1):
        span = (s[-1][0] - s[0][0]).total_seconds()
        print(f"  段{i}: {s[0][0]} ~ {s[-1][0]} · {int(span // 60)}分{int(span % 60)}秒 · {len(s)} 次工具")
    return 0


def selftest():
    ok = [  # 合规样例
        '{"timeline_id":"T1","phase":"received","event":"received_at","ts":"2026-11-16 09:00:00+08:00","duration_kind":"net","net_ms":1,"artifact":"a","evidence":"e"}',
        '{"timeline_id":"T1","phase":"qa","event":"qa_turn_out","ts":"2026-11-16 09:10:00+08:00","duration_kind":"net","net_ms":708000,"artifact":"a","evidence":"e"}',
        '{"timeline_id":"T1","phase":"run","event":"run_start","ts":"2026-11-16 14:00:00+08:00","duration_kind":"wall","artifact":"a","run_id":"R1"}',
        '{"timeline_id":"T1","phase":"archive","event":"archive_at","ts":"2026-11-16 18:00:00+08:00","duration_kind":"unknown"}']
    bad = [  # 7 类违规各一
        '{"timeline_id":"T2","phase":"locate","event":"x","duration_kind":"net"}',                                    # 缺 ts
        '{"timeline_id":"T2","phase":"飞","event":"x","ts":"2026-11-16 09:00:00+08:00","duration_kind":"net","net_ms":1,"artifact":"a","evidence":"e"}',  # phase 非法
        '{"timeline_id":"T2","phase":"brief","event":"x","ts":"2026-11-16 09:00:00","duration_kind":"net","net_ms":1,"artifact":"a","evidence":"e"}',     # ts 缺 +08:00
        '{"timeline_id":"T2","phase":"approval","event":"x","ts":"2026-11-16 09:00:00+08:00","duration_kind":"快","artifact":"a"}',                      # kind 非法
        '{"timeline_id":"T2","phase":"generate","event":"x","ts":"2026-11-16 09:00:00+08:00","duration_kind":"net","net_ms":0,"artifact":"a","evidence":"e"}',  # net_ms 非正
        '{"timeline_id":"T2","phase":"qc","event":"x","ts":"2026-11-16 09:00:00+08:00","duration_kind":"net","net_ms":5}',                                # 缺 artifact/evidence
        '{ 坏 JSON']                                                                                                                                      # JSON 解析
    import os, tempfile
    for name, lines, expect in [("good", ok, 0), ("bad", bad, 1)]:
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as f:
            f.write("\n".join(lines))
            tmp = f.name
        rc = 0
        try:
            rc = check(tmp)
        finally:
            os.unlink(tmp)
        if (rc == 0) != (expect == 0):
            print(f"[RED] selftest {name} 期望{'绿' if expect == 0 else '红'}实得 rc={rc}")
            return 1
        print(f"  selftest {name}: {'绿 ✓' if expect == 0 else '红 ✓（违规全中）'}")
    print("[GREEN] selftest 2/2 通过")
    return 0


def main():
    ap = argparse.ArgumentParser(description="timeline.jsonl 机检 / activity 净耗时 / 自测")
    ap.add_argument("path", nargs="?", help="timeline.jsonl")
    ap.add_argument("--ledger", help="执行账本 ledger.jsonl（启用⑨ run_id 对账）")
    ap.add_argument("--net", help="agent_activity.jsonl（净耗时聚簇模式）")
    ap.add_argument("--since", help="起始时刻 YYYY-MM-DD HH:MM（--net 模式）")
    ap.add_argument("--until", help="结束时刻（可缺省）")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if a.net:
        if not a.since:
            ap.error("--net 需要 --since")
        return net_from_activity(a.net, a.since, a.until)
    if not a.path:
        ap.error("给 timeline.jsonl 路径，或 --net/--selftest")
    return check(a.path, a.ledger)


if __name__ == "__main__":
    sys.exit(main())
