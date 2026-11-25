# -*- coding: utf-8 -*-
"""timeline_check.py — timeline.jsonl 独立机检（证伪方）与净耗时辅助（计时与时间线规范 §十，v1.2 2026-11-25）

用法：
  python timeline_check.py <timeline.jsonl> [--ledger <执行账本.jsonl>] [--upto <阶段码>] [--since "YYYY-MM-DD HH:MM:SS+08:00"]
      机检十三项：①行 JSON 合法 ②必填字段 ③ts=北京时间 YYYY-MM-DD HH:MM:SS+08:00 ④phase∈阶段码表
      ⑤duration_kind∈net/wall/unknown ⑥end 行 net_ms 为正 ⑦end 行 artifact+evidence 非空
      ⑧阶段首现序与流水线先后对照（只提示不判红：返工回路属正常；compare 时点不固定、unknown 申报不计序）
      ⑨timeline run 段 run_id 须在账本批次行
      ⑩账本生效后（默认 2026-11-25 12:00:00）的轮次须有 timeline run 段（反向漏记） ⑪起止配对（起而无终／终而无始）
      ⑫unknown 申报须写原因 ⑬--upto：此阶段码之前的必经段须已计时或已申报
  python timeline_check.py --net <agent_activity.jsonl> --since "2026-11-16 14:00" [--until "…"]
      净耗时辅助：全部会话的工具时刻按相邻间隔≤180s 聚簇为工作段，输出各段与合计（不分需求，粗看用）
  python timeline_check.py --selftest      内置样例自测（合规样例必绿 + 15 类违规各一必红）
红=exit 1（接交付门禁用：usecase-qc、签证前、orchestrator 验门）；输出人读结论。
本工具只读不写，与打点方 timeline_mark.py 相互独立（生成方不自证）；阶段码表以 timeline_mark.PHASES 为唯一来源防两处漂移。
账本批次行兼容两种写法：pw_runner（kind/runId/ts 带 +08:00）与手写轮（type/run/ts 为 ISO 无时区，按北京时间读）。
"""
import argparse
import io
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from timeline_mark import EFFECTIVE, PHASES, PINDEX, PREQ, PNAME, PSEG, SUF, parse_ts  # noqa: E402

PH_ORDER = [p[0] for p in PHASES]
ORDER_FREE = {"compare"}                    # 时点不固定，不参与首现序
BJ = timezone(timedelta(hours=8))
TS_RX = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+08:00$")
KINDS = ("net", "wall", "unknown")


def parse_any(s):
    """时间线 ts（带 +08:00）与账本两种 ts（带时区／ISO 无时区按北京时间）"""
    s = str(s or "").strip()
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S%z")
    except ValueError:
        pass
    try:
        return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=BJ)
    except ValueError:
        return None


def ledger_runs(path):
    """账本批次行 → [(轮号, run_start/run_end, ts)]"""
    out = []
    try:
        for line in io.open(path, encoding="utf-8"):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if not isinstance(r, dict):
                continue
            t = r.get("type") or r.get("kind")
            if t in ("run_start", "run_end"):
                out.append((str(r.get("runId") or r.get("run") or r.get("run_id") or ""), t, parse_any(r.get("ts"))))
    except OSError as e:
        print(f"  ⚠ 账本不可读（跳过⑨⑩）: {e}")
    return out


def check(path, ledger=None, upto=None, since=None):
    reds, warns, n = [], [], 0
    try:
        text = io.open(path, encoding="utf-8").read()
    except OSError as e:
        print(f"[RED] 无法读取 {path}: {e}")
        return 1
    if upto and upto not in PH_ORDER:
        print(f"[RED] --upto 阶段码非法: {upto}")
        return 1
    since_ts = parse_any(since or EFFECTIVE)
    first_seen, tl_runs, no_runid = [], [], 0
    open_by, ended_by, unknown_by = {}, {}, {}
    for i, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError as e:
            reds.append(f"行{i} JSON 解析失败: {e}")
            continue
        if not isinstance(ev, dict):
            reds.append(f"行{i} 不是 JSON 对象")
            continue
        miss = [k for k in ("timeline_id", "phase", "event", "ts", "duration_kind") if not ev.get(k)]
        if miss:
            reds.append(f"行{i} 缺必填字段: {'、'.join(miss)}")
            continue
        n += 1
        ph, kind, event = str(ev["phase"]), str(ev["duration_kind"]), str(ev["event"])
        is_end = event == ph + "_end"
        if ph not in PH_ORDER:
            reds.append(f"行{i} phase 非法: {ph}")
        elif kind != "unknown" and ph not in first_seen and ph not in ORDER_FREE:
            first_seen.append(ph)
        if kind not in KINDS:
            reds.append(f"行{i} duration_kind 非法: {kind}")
        if not TS_RX.match(str(ev["ts"])):
            reds.append(f"行{i} ts 格式非北京时间规范: {ev['ts']}")
        is_start, is_unknown = event == ph + "_start", event == ph + "_unknown"
        if not (is_start or is_end or is_unknown):
            reds.append(f"行{i} event 与 phase 不配: {event}")
            continue
        if is_end:
            v = ev.get("net_ms")
            if kind in ("net", "wall") and not (isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0):
                reds.append(f"行{i} kind={kind} 但 net_ms 缺失/非正数: {v}")
            if kind in ("net", "wall") and not (ev.get("artifact") and ev.get("evidence")):
                reds.append(f"行{i} {kind} 段缺 artifact/evidence")
            if kind == "unknown" and not ev.get("endKind"):
                reds.append(f"行{i} end 行口径为 unknown 却非自动收口（未计时须用 miss 申报）")
            if ph in open_by and open_by[ph] > 0:
                open_by[ph] -= 1
                ended_by[ph] = ended_by.get(ph, 0) + 1
            else:
                reds.append(f"行{i} 终而无始: {PSEG.get(ph, '')}{PNAME.get(ph, ph)} 的 end 没有对应 start")
            if ph == "run":
                rid = str(ev.get("run_id") or "")
                if rid:
                    tl_runs.append(rid)
                elif kind != "unknown":
                    no_runid += 1
        elif is_start:
            open_by[ph] = open_by.get(ph, 0) + 1
        else:
            unknown_by[ph] = unknown_by.get(ph, 0) + 1
            if not str(ev.get("note") or "").strip():
                reds.append(f"行{i} unknown 申报缺原因（note）")
    for ph, c in open_by.items():
        if c > 0:
            reds.append(f"起而无终: {PSEG.get(ph, '')}{PNAME.get(ph, ph)} 有 {c} 个 start 没有 end")
    idx = [PH_ORDER.index(p) for p in first_seen]
    if idx != sorted(idx):
        warns.append(f"阶段首现序与流水线先后不一致: {'→'.join(PSEG[p] + PNAME[p] for p in first_seen)}"
                     "（返工回路属正常，如执行后回到答疑；只需核对阶段码有没有标错）")
    if upto:
        lack = [p for p in PH_ORDER if PREQ[p] and PINDEX[p] < PINDEX[upto]
                and not ended_by.get(p) and not unknown_by.get(p)]
        if lack:
            reds.append(f"到「{PSEG[upto]}{PNAME[upto]}」之前的必经段缺计时也未申报: " + "、".join(PSEG[p] + PNAME[p] for p in lack))
    if ledger:
        runs = ledger_runs(ledger)
        if runs:
            led = {r[0] for r in runs}
            bad = sorted(set(tl_runs) - led)
            if bad:
                reds.append(f"run 段 run_id 不在账本批次行: {', '.join(bad[:5])}")
            late = {r[0] for r in runs if r[1] == "run_start" and r[0] and (r[2] is None or r[2] >= since_ts)}
            miss = sorted(late - set(tl_runs))
            if miss:
                reds.append(f"账本 {since_ts.strftime('%Y-%m-%d %H:%M') if since_ts else ''} 后的轮次没有 timeline run 段（漏记）: {', '.join(miss[:8])}")
            if no_runid:
                reds.append(f"{no_runid} 个 run 段没带 run_id，无法与账本对账")
            if not bad and not miss and not no_runid:
                print(f"  ✓ 账本对账：timeline {len(set(tl_runs))} 轮 ↔ 账本批次行一致（{os.path.basename(ledger)}）")
        else:
            warns.append("账本无批次行，⑨⑩ 无可对账（生效前轮次属正常）")
    print(f"── timeline_check：{path}")
    print(f"  事件 {n} 行 / 已计时阶段 {len(ended_by)} 个（{'>'.join(PSEG[p] + PNAME[p] for p in PH_ORDER if p in ended_by)}）"
          f" / 未计时申报 {sum(unknown_by.values())} 次")
    for w in warns:
        print(f"  ⚠ {w}")
    if reds:
        for r in reds:
            print(f"  ✗ {r}")
        print(f"结论：[RED] {len(reds)} 项违规")
        return 1
    print("结论：[GREEN] 十三项全过")
    return 0


def net_from_activity(path, since, until=None):
    """相邻间隔≤180s 聚簇为工作段；净耗时=各段首末跨度之和（等待用户期无记录=天然不计）。"""
    rows = []
    try:
        for line in io.open(path, encoding="utf-8"):
            try:
                r = json.loads(line)
            except Exception:
                continue
            t = r.get("ts", "")
            if t >= since and (until is None or t <= until):
                try:
                    rows.append((parse_ts(t), r.get("tool", "?")))
                except (TypeError, ValueError, AttributeError):
                    pass
    except OSError as e:
        print(f"[RED] 无法读取 {path}: {e}")
        return 1
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
    import tempfile
    S = lambda ph, ev, kind, **kw: json.dumps(dict({"timeline_id": "T1", "phase": ph, "event": f"{ph}_{ev}", "ts": "2026-11-25 10:00:00+08:00",
                                                    "duration_kind": kind}, **kw), ensure_ascii=False)
    start = lambda ph: S(ph, "start", "net")
    end = lambda ph, kind="net", **kw: S(ph, "end", kind, net_ms=60000, artifact="a", evidence="e", **kw)
    good = [start("locate"), end("locate"), start("qa"), end("qa"), start("generate"), end("generate"),
            start("challenge"), end("challenge"), start("deliver"), end("deliver"), start("prep"), end("prep"),
            start("run").replace('"net"', '"wall"'), end("run", "wall", run_id="R-1"), S("specgate", "unknown", "unknown", note="豁免：不足30条")]
    t = "2026-11-25 10:00:00+08:00"
    bad = [("坏 JSON", ['{ 坏']),
           ("缺 ts", ['{"timeline_id":"T","phase":"locate","event":"locate_start","duration_kind":"net"}']),
           ("phase 非法", ['{"timeline_id":"T","phase":"飞","event":"x","ts":"%s","duration_kind":"net"}' % t]),
           ("ts 缺时区", ['{"timeline_id":"T","phase":"locate","event":"locate_start","ts":"2026-11-25 10:00:00","duration_kind":"net"}']),
           ("kind 非法", ['{"timeline_id":"T","phase":"locate","event":"locate_start","ts":"%s","duration_kind":"快"}' % t]),
           ("net_ms 非正", [end("locate").replace("60000", "0")]),
           ("缺 artifact/evidence", [end("locate").replace('"artifact": "a", ', '').replace(', "evidence": "e"', '')]),
           ("起而无终", [start("locate"), end("locate"), start("qa")]),
           ("终而无始", [end("locate")]),
           ("unknown 缺原因", [S("locate", "unknown", "unknown")]),
           ("end 行 unknown 非自动收口", [start("locate"), end("locate", "unknown")]),
           ("event 与 phase 不配", ['{"timeline_id":"T","phase":"locate","event":"gen_start","ts":"%s","duration_kind":"net"}' % t])]
    red = 0
    tmp = tempfile.mkdtemp(prefix="tlc_selftest_")
    fp = os.path.join(tmp, "t.jsonl")
    led_pw = os.path.join(tmp, "pw.jsonl")      # pw_runner 写法
    led_hw = os.path.join(tmp, "hw.jsonl")      # 手写轮写法
    io.open(led_pw, "w", encoding="utf-8").write(
        '{"kind":"run_start","runId":"R-1","ts":"2026-11-25 14:00:00+08:00","note":"x"}\n'
        '{"kind":"run_end","runId":"R-1","ts":"2026-11-25 14:30:00+08:00","durationMs":1}\n')
    io.open(led_hw, "w", encoding="utf-8").write(
        '{"run":"R2-20261125-1500","type":"run_start","ts":"2026-11-25T15:00:00","note":"x"}\n'
        '{"run":"R2-20261125-1500","type":"run_end","ts":"2026-11-25T15:20:00","note":"x"}\n'
        '{"run":"R1-20261120-1126","type":"run_start","ts":"2026-11-20T11:26:28","note":"历史轮"}\n')
    try:
        cases = [("合规样例", good, 0, {}), ("合规＋pw 账本", good, 0, {"ledger": led_pw}),
                 ("upto=run 必经段齐", good, 0, {"upto": "run"}),
                 ("返工回路（答疑首现在生成之后）只提示不判红", [start("generate"), end("generate"), start("qa"), end("qa")], 0, {})]
        cases += [(name, rows, 1, {}) for name, rows in bad]
        cases += [("upto=run 缺必经段", [start("run").replace('"net"', '"wall"'), end("run", "wall", run_id="R-1")], 1, {"upto": "run"}),
                  ("run_id 不在账本", [end("run", "wall", run_id="R-9")], 1, {"ledger": led_pw}),
                  ("账本生效后轮次漏记（手写账本）", [], 1, {"ledger": led_hw}),
                  ("run 段缺 run_id", [end("run", "wall")], 1, {"ledger": led_pw})]
        for name, rows, expect, kw in cases:
            io.open(fp, "w", encoding="utf-8").write("\n".join(rows) + "\n")
            import contextlib
            with contextlib.redirect_stdout(io.StringIO()):
                rc = check(fp, **kw)
            ok = (rc == 0) == (expect == 0)
            red += 0 if ok else 1
            print(f"  {'✓' if ok else '✗'} {name}: {'绿' if rc == 0 else '红'}")
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"[{'GREEN' if not red else 'RED'}] timeline_check selftest：{len(cases)} 例，{'全过' if not red else f'{red} 例不符'}")
    return 1 if red else 0


def main():
    ap = argparse.ArgumentParser(description="timeline.jsonl 独立机检 / activity 净耗时 / 自测")
    ap.add_argument("path", nargs="?", help="timeline.jsonl")
    ap.add_argument("--ledger", help="执行账本 jsonl（启用⑨⑩ 对账，兼容 pw_runner 与手写轮两种批次行）")
    ap.add_argument("--upto", help="阶段码：此阶段之前的必经段须已计时或已申报（⑬）")
    ap.add_argument("--since", help="check 模式＝⑩ 的生效时刻（默认规范 v1.2 生效时刻）；--net 模式＝起始时刻 YYYY-MM-DD HH:MM")
    ap.add_argument("--net", help="agent_activity.jsonl（净耗时聚簇模式）")
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
    return check(a.path, a.ledger, a.upto or None, a.since)


if __name__ == "__main__":
    sys.exit(main())
