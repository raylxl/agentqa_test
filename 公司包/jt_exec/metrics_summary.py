# -*- coding: utf-8 -*-
"""Summarize final execution events from JSONL ledgers.

Final states are PASS/FAIL/NOT_EXECUTED/BLOCKED. PENDING/OBSERVE are
intermediate and fail closed. Each JSONL row is one execution event; the same
TC may legitimately appear in separate runs. Duplicate input files or repeated
execId/eventId values are rejected.
"""
import argparse
import hashlib
import io
import json
import os
import sys
from collections import defaultdict

FINAL_STATES = frozenset({"PASS", "FAIL", "NOT_EXECUTED", "BLOCKED"})
STATUS_MAP = {
    "通过": "PASS", "pass": "PASS", "PASS": "PASS",
    "不通过": "FAIL", "失败": "FAIL", "fail": "FAIL", "FAIL": "FAIL",
    "阻塞": "BLOCKED", "blocked": "BLOCKED", "BLOCKED": "BLOCKED",
    "未执行": "NOT_EXECUTED", "NOT_EXECUTED": "NOT_EXECUTED",
}
INTERMEDIATE = frozenset({"待复核", "观察", "OBSERVE", "PENDING", "pending"})


def parse_record(obj):
    tc = obj.get("tc") or obj.get("TC") or obj.get("id") or obj.get("case_id") or ""
    raw_status = obj.get("status") or obj.get("判定") or obj.get("result") or ""
    raw_status = str(raw_status).strip()
    if raw_status in INTERMEDIATE:
        status = "INTERMEDIATE"
    else:
        status = STATUS_MAP.get(raw_status, raw_status if raw_status in FINAL_STATES else "UNKNOWN")
    priority = obj.get("优先级") or obj.get("priority") or obj.get("prio") or ""
    priority = str(priority).upper().replace("（", "").replace("）", "")
    channel = obj.get("channel") or obj.get("engine") or obj.get("通道") or "未标注"
    duration = obj.get("durationMs") or obj.get("ms") or obj.get("耗时ms") or obj.get("duration_ms")
    try:
        duration = float(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration = None
    event_id = obj.get("eventId") or obj.get("execId") or obj.get("execution_id") or ""
    run_id = obj.get("runId") or obj.get("run_id") or ""
    ts = obj.get("timestamp") or obj.get("ts") or obj.get("time") or ""
    return {"tc": str(tc), "status": status, "priority": priority,
            "channel": str(channel), "duration": duration,
            "event_id": str(event_id), "run_id": str(run_id), "ts": str(ts)}


def pct(n, d):
    return "%.1f%%" % (100.0 * n / d) if d else "—"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+", help="执行账本 JSONL，可传多个")
    parser.add_argument("--planned", type=int, required=True,
                        help="本执行集计划 dispatch 事件数（manual_only/失效等执行前排除不计入）")
    parser.add_argument("--duplicate-policy", choices=("error", "events"), default="error",
                        help="重复 TC 策略：不同 run_id 可重复；同一运行重复默认失败，events 可显式按事件计")
    parser.add_argument("--require-priority", action="store_true",
                        help="要求每条账本记录都带 P0/P1/P2/P3；适用于新治理JSON执行批次")
    parser.add_argument("--out", help="汇总 Markdown 输出路径；缺省只打印")
    parser.add_argument("--timeline", help="生成侧 timeline.jsonl（计时与时间线规范§三）；给出则追加各阶段净耗时段")
    args = parser.parse_args()
    if args.planned < 0:
        parser.error("--planned 不能小于0")

    paths = [os.path.abspath(p) for p in args.files]
    if len(paths) != len(set(paths)):
        print("!! 同一账本路径重复传入，拒绝重复计数", file=sys.stderr)
        return 2

    records = []
    source_rows = []
    run_meta = {}
    for path in paths:
        try:
            raw = io.open(path, "rb").read()
        except OSError as exc:
            print("!! 无法读取账本 %s: %s" % (path, exc), file=sys.stderr)
            return 2
        digest = hashlib.sha256(raw).hexdigest()
        if any(digest == old_digest for _, old_digest, _ in source_rows):
            print("!! 多个输入文件内容完全相同，可能重复导入同一账本；拒绝汇总", file=sys.stderr)
            return 2
        source_rows.append((path, digest, 0))
        count = 0
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            print("!! 账本不是有效UTF-8: %s" % path, file=sys.stderr)
            return 2
        for line_no, line in enumerate(text.splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                print("!! JSONL解析失败 %s:%d: %s" % (path, line_no, exc), file=sys.stderr)
                return 2
            if not isinstance(obj, dict):
                print("!! 账本行必须是对象 %s:%d" % (path, line_no), file=sys.stderr)
                return 2
            if obj.get("type") in ("run_start", "run_end", "prep_start"):
                rid = str(obj.get("runId") or obj.get("run_id") or "")
                run_meta.setdefault(rid, {})[obj["type"]] = str(obj.get("timestamp") or obj.get("ts") or obj.get("time") or "")
                if obj.get("type") in ("run_start", "run_end"):   # v1.11 批次行附带字段（label/ms/endKind，细则§十五）
                    meta = run_meta[rid]
                    if obj.get("label"):
                        meta["label"] = str(obj["label"])
                    if obj.get("ms") is not None:
                        try:
                            meta.setdefault("ms", {})[obj["type"]] = float(obj["ms"])
                        except (TypeError, ValueError):
                            pass
                    if obj.get("endKind"):
                        meta["endKind"] = str(obj["endKind"])
                continue
            rec = parse_record(obj)
            rec["source"] = os.path.basename(path)
            rec["line"] = line_no
            records.append(rec)
            count += 1
        source_rows[-1] = (path, digest, count)

    if not records:
        print("!! 输入账本没有记录", file=sys.stderr)
        return 2
    invalid = sorted({r["status"] for r in records} - FINAL_STATES)
    if invalid:
        if "INTERMEDIATE" in invalid:
            print("!! 有待复核/观察等临时态；须先收敛为四态再汇总", file=sys.stderr)
        else:
            print("!! 非法最终状态: %s；只允许 %s" % (", ".join(invalid), "/".join(sorted(FINAL_STATES))), file=sys.stderr)
        return 2
    missing_tc = [r for r in records if not r["tc"]]
    if missing_tc:
        print("!! 有 %d 条账本记录缺 TC 编号，拒绝汇总" % len(missing_tc), file=sys.stderr)
        return 2
    event_ids = [(r["run_id"], r["event_id"]) for r in records if r["event_id"]]
    if len(event_ids) != len(set(event_ids)):
        print("!! 同一 run_id 内重复 eventId/execId，疑似重复账本事件，拒绝汇总", file=sys.stderr)
        return 2
    run_tc_pairs = [(r["run_id"], r["tc"]) for r in records if r["run_id"]]
    duplicate_run_tc = len(run_tc_pairs) != len(set(run_tc_pairs))
    if duplicate_run_tc and args.duplicate_policy == "error":
        print("!! 同一 run_id 中同一 TC 有多条最终记录；如确属重试事件，请显式使用 --duplicate-policy events", file=sys.stderr)
        return 2
    if len(records) > args.planned:
        print("!! 实际账本事件数 %d 超过计划 dispatch 数 %d；请核对重复导入/计划集合" % (len(records), args.planned), file=sys.stderr)
        return 2
    missing_priority = [r for r in records if r["priority"] not in ("P0", "P1", "P2", "P3")]
    if args.require_priority and missing_priority:
        print("!! 新治理执行批有 %d 条缺失/非法优先级记录" % len(missing_priority), file=sys.stderr)
        return 2

    states = defaultdict(int)
    by_priority = defaultdict(lambda: defaultdict(int))
    by_channel = defaultdict(lambda: {"n": 0, "pass": 0, "duration": []})
    for rec in records:
        states[rec["status"]] += 1
        if rec["priority"] in ("P0", "P1", "P2", "P3"):
            by_priority[rec["priority"]][rec["status"]] += 1
        chan = by_channel[rec["channel"]]
        chan["n"] += 1
        if rec["status"] == "PASS":
            chan["pass"] += 1
        if rec["duration"] is not None:
            chan["duration"].append(rec["duration"])

    attempts = len(records)
    verified = states["PASS"] + states["FAIL"]
    unique_tcs = len({r["tc"] for r in records})
    lines = ["## 执行指标汇总（四态契约）", ""]
    lines.append("数据源：%s" % "；".join("%s=%d事件" % (os.path.basename(p), n) for p, _, n in source_rows))
    lines.append("- **计划 dispatch 事件**：%d" % args.planned)
    lines.append("- **实际执行事件**：%d；覆盖的唯一TC：%d" % (attempts, unique_tcs))
    if duplicate_run_tc:
        lines.append("- **重试事件提示**：同一 run_id 内有同一 TC 多次记录，按 --duplicate-policy events 作为独立执行事件统计")
    lines.append("- **最终状态**：PASS=%d；FAIL=%d；NOT_EXECUTED=%d；BLOCKED=%d（合计=%d）" % (
        states["PASS"], states["FAIL"], states["NOT_EXECUTED"], states["BLOCKED"], attempts))
    lines.append("- **尝试覆盖率**：%s（已 dispatch 事件 / 计划 dispatch 事件）" % pct(attempts, args.planned))
    lines.append("- **已验证覆盖率**：%s（PASS+FAIL / 计划 dispatch 事件）" % pct(verified, args.planned))
    lines.append("- **通过率**：%s（PASS / (PASS+FAIL)；NOT_EXECUTED/BLOCKED不进分母）" % pct(states["PASS"], verified))
    lines.append("- **BLOCKED率**：%s（BLOCKED / 计划 dispatch 事件）" % pct(states["BLOCKED"], args.planned))
    if missing_priority:
        lines.append("- **优先级未标注**：%d条（未纳入P0123分层统计）" % len(missing_priority))
    lines.append("- **P0123分层**：")
    for priority in ("P0", "P1", "P2", "P3"):
        d = by_priority.get(priority)
        if not d:
            continue
        verified_p = d["PASS"] + d["FAIL"]
        lines.append("  - %s：PASS=%d FAIL=%d NOT_EXECUTED=%d BLOCKED=%d；通过率=%s" % (
            priority, d["PASS"], d["FAIL"], d["NOT_EXECUTED"], d["BLOCKED"], pct(d["PASS"], verified_p)))
    lines.append("- **通道效率**：")
    for channel, d in sorted(by_channel.items()):
        mean = "%.0fms" % (sum(d["duration"]) / len(d["duration"])) if d["duration"] else "—"
        verified_c = sum(1 for r in records if r["channel"] == channel and r["status"] in ("PASS", "FAIL"))
        lines.append("  - %s：事件=%d；通过率=%s；平均耗时=%s" % (channel, d["n"], pct(d["pass"], verified_c), mean))
    lines.append("- **轮次耗时（细则§十五，报告〇.2 三时间要素来源）**：")
    from datetime import datetime as _dt
    def _parse_ts(x):
        return _dt.fromisoformat(str(x).replace("Z", "+00:00"))
    if run_meta:
        for rid in sorted(run_meta):
            meta = run_meta[rid]
            s, e = meta.get("run_start"), meta.get("run_end")
            label = (str(meta["label"]) + "（" + rid + "）") if meta.get("label") else (rid or "<未标 run_id>")
            endk = " · endKind=" + str(meta["endKind"]) if meta.get("endKind") not in (None, "normal") else ""
            ms_pair = meta.get("ms") or {}
            if s and e and ms_pair.get("run_end") is not None:
                sec = ms_pair["run_end"] / 1000.0   # 批次行 ms 优先（细则§十五 v1.11，报告〇.2 直接引用）
                lines.append("  - run %s：%s ~ %s，净耗时 %dh%02dm%02ds（批次行 ms）%s" % (
                    label, s, e, int(sec // 3600), int(sec % 3600 // 60), int(sec % 60), endk))
            elif s and e:
                try:
                    sec = (_parse_ts(e) - _parse_ts(s)).total_seconds()
                    lines.append("  - run %s：%s ~ %s，耗时 %dh%02dm%02ds%s" % (
                        label, s, e, int(sec // 3600), int(sec % 3600 // 60), int(sec % 60), endk))
                except (ValueError, TypeError):
                    lines.append("  - run %s：%s ~ %s（时间格式非 ISO，未换算）%s" % (label, s, e, endk))
            else:
                lines.append("  - run %s：缺 %s" % (label, "run_end（批次未收尾或漏记）" if s else "run_start"))
    else:
        ts_by_run = defaultdict(list)
        for r in records:
            if r["run_id"] and r["ts"]:
                ts_by_run[r["run_id"]].append(r["ts"])
        if ts_by_run:
            for rid, tss in sorted(ts_by_run.items()):
                tss.sort()
                lines.append("  - run %s：首条 %s ~ 末条 %s（按逐条时间戳推算，不含准备/清场）" % (rid, tss[0], tss[-1]))
        else:
            lines.append("  - 账本无 run_start/run_end 且无逐条时间戳——历史轮不可算（细则§十五起执行器必落）")
    if args.timeline:   # 生成侧阶段净耗时（net 口径，规范§一；报告〇.2 生成侧引用本段）
        lines.append("- **生成侧阶段净耗时（timeline.jsonl，口径=net 只计 agent 操作）**：")
        ph_net = defaultdict(lambda: {"ms": 0.0, "n": 0, "unknown": 0})
        try:
            for line in io.open(args.timeline, encoding="utf-8"):
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ph = str(ev.get("phase") or "?")
                kind = ev.get("duration_kind")
                if kind == "net" and ev.get("net_ms") is not None:
                    try:
                        ph_net[ph]["ms"] += float(ev["net_ms"])
                        ph_net[ph]["n"] += 1
                    except (TypeError, ValueError):
                        pass
                elif kind == "unknown":
                    ph_net[ph]["unknown"] += 1
            ph_order = ["received", "locate", "qa", "brief", "approval", "generate", "qc",
                        "deliver", "prep", "run", "close", "archive"]
            for ph in ph_order + sorted(set(ph_net) - set(ph_order)):
                d = ph_net.get(ph)
                if not d:
                    continue
                if d["ms"]:
                    lines.append("  - %s：%d 段净耗时合计 %dh%02dm%02ds" % (
                        ph, d["n"], int(d["ms"] // 3600000), int(d["ms"] % 3600000 // 60000), int(d["ms"] % 60000 // 1000)))
                if d["unknown"]:
                    lines.append("  - %s：%d 段 unknown（历史无记录，不进效率汇总）" % (ph, d["unknown"]))
        except OSError as exc:
            lines.append("  - !! 无法读取 %s: %s" % (args.timeline, exc))
    text = "\n".join(lines) + "\n"
    print(text, end="")
    if args.out:
        tmp = args.out + ".tmp"
        io.open(tmp, "w", encoding="utf-8").write(text)
        os.replace(tmp, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY