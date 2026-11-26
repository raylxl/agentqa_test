# -*- coding: utf-8 -*-
r"""timeline_mark.py — 阶段计时打点与时间线汇总（计时与时间线规范 v1.2，2026-11-25 立）

每个步骤都计时：技能开工第一步 begin、收工最后一步 end；净耗时由工具按底账自动算，禁手填、禁事后补造。

用法：
  python timeline_mark.py begin  --id <册名> --phase <阶段码> [--round <轮次/回合标签>] [--run-id <账本run_id>]
                                  [--actor <技能名>] [--note …]
  python timeline_mark.py end    --id <册名> --phase <阶段码> --artifact <产出物绝对路径> --evidence <证据定位>
                                  [--round …] [--run-id …] [--actor …] [--note …]
      关闭该阶段进行中的段，自动算净耗时并打印 ⏱ 播报行（原样转述给用户），同时重出 {册名}_timeline.md
  python timeline_mark.py miss   --id <册名> --phase <码,码…> --reason <原因>
      漏记 / 生效前已完成的阶段如实申报 unknown（禁补造耗时）
  python timeline_mark.py status --id <册名> [--upto <阶段码>]
      各阶段状态：起而无终、必经段缺计时也未申报 → exit 1（验门用）
  python timeline_mark.py report --id <册名> [--force]   重出 {册名}_timeline.md 并打印汇总
  python timeline_mark.py phases                        阶段码表
  python timeline_mark.py --selftest                   内置自测

净耗时（net）取数三路（只认本会话，并行会话不串）：
  ① 主会话回合区间：activity 底账 turn_in/turn_out（hooks\turn_in_trace.py、turn_out_trace.py；须重开会话生效）
  ② 子代理运行区间：~/.zcode/cli/agents/<会话>/agent_*/metadata.json 的 createdAt~completedAt
     （钩子在子代理内不触发，2026-11-25 探针实证，故取此处）
  ③ 工具调用时刻：activity 底账 post 行按相邻间隔≤180 秒聚簇（①生效前的兜底）
  三路取并集裁到本段 [begin, end]，再扣除本段内嵌套的其他阶段段；全无底账（宿主无钩子）→ 按墙钟计并标 wall。
执行轮（run）按拍板⑤以起止墙钟计（wall），agent 净操作另记 agent_ms。

落位：{paths.用例文件}\计时\{册名}_timeline.jsonl（只追加）＋ {册名}_timeline.md（派生视图）；
      无公司配置/路径不可达 → <workspace>\计时；--dir 或环境变量 TIMELINE_DIR 可覆盖。
"""
import argparse
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BJ = timezone(timedelta(hours=8))
TS_FMT = "%Y-%m-%d %H:%M:%S+08:00"
EFFECTIVE = "2026-11-25 12:00:00+08:00"      # v1.2 生效时刻：此后推进的段必须计时或申报
GAP_S = 180                                 # 工具时刻聚簇阈值（秒）
SNAP_S = 900                                # begin 起点回吸到本回合开始的上限（秒）
SUF = "_timeline"
TURN = ("turn_in", "turn_out")
PACK_ROOT = Path(__file__).resolve().parents[2]            # tools → Agent本体 → 包根
_NOW = None                                                # 自测注入时钟用

# (阶段码, 所属段, 名称, 常规必经)——顺序＝流水线先后；必经段在 --upto 之前须"已计时或已申报"
PHASES = [
    ("lanhu", "⓪前", "蓝湖采集", False),
    ("locate", "⓪", "需求熟悉·定位", True),
    ("qa", "①", "答疑", True),
    ("generate", "②", "用例生成", True),
    ("challenge", "③", "用例复核（质疑）", True),
    ("deliver", "④", "三格式交付", True),
    ("prep", "⑤", "执行准备", True),
    ("specgate", "⑤", "规格保真门", False),
    ("run", "⑤", "执行轮", False),
    ("exreview", "⑤", "执行判定质疑", False),
    ("feedback", "⑥", "反馈闭环", False),
    ("qc", "⑦", "独立质检", False),
    ("compare", "—", "外部用例对比", False),
    ("archive", "—", "归档", False),
]
PINDEX = {p[0]: i for i, p in enumerate(PHASES)}
PNAME = {p[0]: p[2] for p in PHASES}
PSEG = {p[0]: p[1] for p in PHASES}
PREQ = {p[0]: p[3] for p in PHASES}
# 技能 → 阶段（漏记探测用：本会话调过技能却没有任何对应阶段的段＝疑似漏记）
SKILL_PHASE = {"lanhu-req-extract": "lanhu", "requirement-qa-loop": "qa", "usecase-generator": "generate",
               "usecase-spec-gate": "specgate", "usecase-challenger": "challenge", "usecase-executor": "run",
               "usecase-execution-challenger": "exreview", "usecase-feedback-loop": "feedback",
               "usecase-defect-challenger": "feedback", "usecase-qc": "qc", "usecase-external-compare": "compare"}


# ───────── 时间 ─────────
def now_dt():
    return _NOW or datetime.now(BJ).replace(microsecond=0)


def fmt_dt(d):
    return d.strftime(TS_FMT)


def parse_ts(s):
    try:
        return datetime.strptime(str(s), TS_FMT).replace(tzinfo=BJ)
    except (TypeError, ValueError):
        return None


def parse_utc(s):
    if not isinstance(s, str):
        return None
    try:
        return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).astimezone(BJ)
    except ValueError:
        return None


def fmt_dur(ms):
    s = max(0, int((ms or 0) // 1000))
    h, m = s // 3600, s % 3600 // 60
    if h:
        return f"{h}小时{m}分{s % 60}秒"
    if m:
        return f"{m}分{s % 60}秒"
    return f"{s}秒"


# ───────── 会话与底账 ─────────
def session_id():
    return (os.environ.get("ZCODE_SESSION_ID") or os.environ.get("CLAUDE_SESSION_ID") or "").strip()


def sid16(s=None):
    return (session_id() if s is None else str(s or ""))[:16] or None


def activity_files():
    env = os.environ.get("TIMELINE_ACTIVITY")
    base = Path(env) if env else PACK_ROOT.parent / ".zcode" / "agent_activity.jsonl"
    if base.is_dir():
        base = base / "agent_activity.jsonl"
    return [base] + sorted(base.parent.glob(base.name + ".rotated_*"))


def _activity_rows(sid, t_from, t_to, want):
    """本会话在 [t_from, t_to] 的底账行；want="span"→[(t,event)]，want="skill"→[(t,skill名)]"""
    out = []
    if not sid:
        return out
    for f in activity_files():
        try:
            with io.open(str(f), encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if sid not in line:
                        continue
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if r.get("sid") != sid:
                        continue
                    t = parse_ts(r.get("ts"))
                    if t is None or t < t_from or t > t_to:
                        continue
                    if want == "skill":
                        if r.get("tool") == "Skill" and r.get("skill"):
                            out.append((t, str(r["skill"])))
                    else:
                        out.append((t, str(r.get("event") or "post")))
        except OSError:
            continue
    # 按时间稳定排序，同一秒内保持落盘先后（上一回合 turn_out 与下一回合 turn_in 同秒时，落盘序才是真实先后）
    out.sort(key=lambda x: x[0])
    return out


def turn_spans(rows):
    """回合区间：turn_in 开、turn_out 合。没有 turn_in 的续跑回合（后台任务/子代理完成通知唤起）从上一回合结束起算；
    上一回合没等到 turn_out（被打断）就收到新输入 → 只算到它最后一次工具时刻。返回 (区间, 进行中回合起点, 上一标记点)"""
    spans, open_t, last_mark, last_post = [], None, None, None
    for t, ev in rows:
        if ev == "turn_in":
            if open_t is not None:
                spans.append((open_t, last_post if last_post and open_t < last_post <= t else open_t))
            open_t, last_mark = t, t
        elif ev == "turn_out":
            start = open_t if open_t is not None else last_mark
            if start is not None and t >= start:
                spans.append((start, t))
            open_t, last_mark = None, t
        else:
            last_post = t
    return spans, open_t, last_mark


def clusters(rows, gap=GAP_S):
    """工具时刻聚簇：相邻间隔≤gap 秒归同一段（无钩子回合记录时的兜底）。
    底账秒级分辨率、每个点代表一次工具调用结束，故每簇止点按 +1 秒计（孤立一点也至少 1 秒）"""
    out, cur, last = [], None, None
    for t, ev in rows:
        if ev in TURN:
            continue
        if cur is not None and (t - last).total_seconds() <= gap:
            cur = (cur[0], t + timedelta(seconds=1))
        else:
            if cur:
                out.append(cur)
            cur = (t, t + timedelta(seconds=1))
        last = t
    if cur:
        out.append(cur)
    return out


def subagent_spans(full_sid, t_to):
    """子代理运行区间（宿主为每个子代理留的元数据：createdAt~completedAt，UTC）"""
    out = []
    if not full_sid:
        return out
    home = os.environ.get("ZCODE_HOME") or (Path.home() / ".zcode")
    try:
        metas = sorted((Path(home) / "cli" / "agents" / full_sid).glob("agent_*/metadata.json"))
    except OSError:
        return out
    for m in metas:
        try:
            j = json.loads(m.read_text(encoding="utf-8"))
            st = m.stat()
        except Exception:
            continue
        if j.get("parentSessionId") not in (None, "", full_sid):
            continue
        s = parse_utc(j.get("createdAt"))
        if s is None:
            s = datetime.fromtimestamp(getattr(st, "st_birthtime", st.st_ctime), BJ).replace(microsecond=0)
        e = parse_utc(j.get("completedAt"))
        if e is None:
            running = j.get("status") in (None, "", "running", "pending", "working")
            e = t_to if running else datetime.fromtimestamp(st.st_mtime, BJ).replace(microsecond=0)
        if e > s:
            out.append((s, e))
    return out


def evidence_spans(sids, t0, t1):
    """sids＝{sid16: 完整会话id}；返回 (证据区间列表, 取数来源集合)。来源只记与 [t0,t1] 有交集的证据"""
    spans, src = [], set()
    for s, full in sorted(sids.items()):
        rows = _activity_rows(s, t0, t1, "span")
        sp, open_t, _ = turn_spans(rows)
        if open_t is not None:
            sp = sp + [(open_t, t1)]
        cl = clusters(rows)
        sub = subagent_spans(full or s, t1)
        hit = lambda iv: [x for x in iv if x[1] > t0 and x[0] < t1]
        for name, iv in (("回合起止", sp), ("工具时刻", cl), ("子代理", sub)):
            if hit(iv):
                src.add(name)
                spans += hit(iv)
    return spans, src


def union_ms(spans, t0, t1):
    """区间并集裁到 [t0,t1] 后的毫秒数"""
    iv = sorted((max(s, t0), min(e, t1)) for s, e in spans if s is not None and e is not None and e > t0 and s < t1)
    total, cur = timedelta(), None
    for s, e in iv:
        if cur and s <= cur[1]:
            cur = (cur[0], max(cur[1], e))
        else:
            if cur:
                total += cur[1] - cur[0]
            cur = (s, e)
    if cur:
        total += cur[1] - cur[0]
    return int(total.total_seconds() * 1000)


# ───────── 落位 ─────────
def company_cfg():
    cands = [PACK_ROOT / "公司包" / "agent-company.json"] + sorted(PACK_ROOT.glob("*/agent-company.json"))
    for f in cands:
        try:
            if f.is_file():
                return json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
    return {}


def timeline_dir(override=None):
    p = override or os.environ.get("TIMELINE_DIR")
    if p:
        return Path(p)
    cfg = company_cfg()
    base = (cfg.get("paths") or {}).get("用例文件")
    if base:
        alias = {str(k).replace("\\", "/"): v for k, v in (cfg.get("路径迁移别名") or {}).items()}
        root = Path(alias.get(str(base).replace("\\", "/"), base))
        if root.is_dir():
            return root / "计时"
    ws = os.environ.get("ZCODE_PROJECT_DIR") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return Path(ws) / "计时"


_BAD = re.compile(r'[\\/:*?"<>|\r\n\t]')


def norm_id(s):
    """归同名：去非法字符/空白，去尾部版本号（v3.3）与需求批次（11.30）——同一需求各阶段写法略异也落到同一份时间线"""
    s = re.sub(r"\s+", "", _BAD.sub("", str(s)))
    for _ in range(4):
        n = re.sub(r"(?<![A-Za-z])v\d+(?:\.\d+)*$", "", s)
        n = re.sub(r"\d{1,2}\.\d{1,2}$", "", n)
        n = re.sub(r"[_\-]+$", "", n)
        if n == s:
            break
        s = n
    return s


def resolve_id(raw, tdir):
    """返回 (落盘 id, 提示语列表)：已有归同名的时间线则沿用其 id"""
    stem = _BAD.sub("", str(raw)).strip()
    if not stem:
        raise SystemExit("[RED] --id 不能为空")
    hits = []
    if tdir.is_dir():
        hits = [p.name[:-len(SUF + ".jsonl")] for p in tdir.glob("*" + SUF + ".jsonl")
                if norm_id(p.name[:-len(SUF + ".jsonl")]) == norm_id(stem)]
    if stem in hits or not hits:
        return stem, []
    if len(hits) > 1:
        raise SystemExit("[RED] 有多份相近时间线，请沿用其中之一：`" + "`、`".join(hits) + "`")
    return hits[0], [f"已归并到既有时间线「{hits[0]}」（与「{stem}」视为同一需求）"]


def read_rows(path):
    rows = []
    try:
        with io.open(str(path), encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                    if isinstance(r, dict):
                        rows.append(r)
                except ValueError:
                    pass
    except OSError:
        pass
    return rows


def append_row(path, row):
    """只追加；跨进程短锁防并行会话同册互踩（锁在临时目录，不污染数据目录；等不到锁也照写＝底账尽力而为）"""
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(row, ensure_ascii=False) + "\n"
    lock = Path(tempfile.gettempdir()) / ("timeline_" + hashlib.md5(str(path).encode("utf-8")).hexdigest() + ".lock")
    fd = None
    for _ in range(40):
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(str(lock)) > 10:
                    os.unlink(str(lock))
                    continue
            except OSError:
                pass
            time.sleep(0.1)
    try:
        with io.open(str(path), "a", encoding="utf-8", newline="\n") as f:
            f.write(line)
    finally:
        if fd is not None:
            os.close(fd)
            try:
                os.unlink(str(lock))
            except OSError:
                pass


def segments(rows):
    """按时间序配对：closed＝已收口段，open＝起而无终，unknown＝未计时申报"""
    closed, opens, unknown = [], [], []
    for r in sorted(rows, key=lambda r: str(r.get("ts", ""))):
        ph = str(r.get("phase") or "")
        ev = str(r.get("event") or "")
        if ph not in PINDEX:
            continue
        if ev == ph + "_start":
            opens.append({"phase": ph, "t0": r["ts"], "t1": None, "row": r})
        elif ev == ph + "_end":
            host = next((s for s in opens if s["phase"] == ph), None)
            if host is None:                      # 终而无始：不认，交 timeline_check 判红
                continue
            host.update({"t1": r["ts"], "row_end": r})
            opens.remove(host)
            closed.append(host)
        elif r.get("duration_kind") == "unknown":
            unknown.append(r)
    return {"closed": closed, "open": opens, "unknown": unknown}


def base_row(rid, phase, actor):
    return {"timeline_id": rid, "phase": phase, "label": PNAME[phase], "ts": fmt_dt(now_dt()),
            "actor": actor or "", "sid": sid16(), "session": session_id()}


def tag_of(phase, rnd):
    return f"{PSEG[phase]}{PNAME[phase]}" + (f"·{rnd}" if rnd else "")


def close_row(rid, seg, now, kind, net, agent_ms, elapsed, src, artifact, evidence, note, extra):
    r0 = seg["row"]
    row = base_row(rid, seg["phase"], r0.get("actor"))
    row.update({"event": seg["phase"] + "_end", "duration_kind": kind,
                "net_ms": net if net else None, "agent_ms": agent_ms, "elapsed_ms": elapsed,
                "round": r0.get("round", ""), "run_id": r0.get("run_id", ""),
                "artifact": artifact, "evidence": evidence,
                "sources": "＋".join(sorted(src)) or "无底账", "note": note})
    row.update(extra)
    return row


def seg_sids(seg):
    """本段涉及的会话：{sid16: 完整会话id}＝打起点的会话＋当前会话"""
    sids = {}
    b_sid, c_sid = seg["row"].get("sid"), sid16()
    if b_sid:
        sids[b_sid] = seg["row"].get("session") or b_sid
    if c_sid:
        sids[c_sid] = session_id() or c_sid
    return sids


def sid_seen(sid):
    """宿主有没有计时底账：底账里出现过这个会话的行即算有"""
    if not sid:
        return False
    needle = '"sid": "%s"' % sid
    for f in activity_files():
        try:
            with io.open(str(f), encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if needle in line:
                        return True
        except OSError:
            continue
    return False


def net_of(seg, data, now):
    """本段 agent 净操作毫秒数、取数来源：证据并集 − 本段内嵌套的其他阶段段"""
    sids = seg_sids(seg)
    t0 = parse_ts(seg["t0"])
    spans, src = evidence_spans(sids, t0, now)
    nested = []
    for s in data["closed"]:
        a, b = parse_ts(s["t0"]), parse_ts(s["t1"])
        if s["phase"] != seg["phase"] and a and b and a >= t0:      # 只扣"开在本段之内"的段；包着本段的大段不扣
            nested.append((a, b))
    return max(0, union_ms(spans, t0, now) - union_ms(nested, t0, now)), src, sids


def compute_end(rid, seg, data, now, phase, artifact, evidence, rnd, run_id, actor, note):
    """end 的公共算法（end 命令与自动收口共用）→ (行, 说明)
    口径：执行轮＝起止墙钟；其余段有底账就按净耗时（宁小勿大，用户等待一律不计）；
    段内无底账＝如实标 unknown；墙钟只用于完全没有底账设施的宿主。"""
    t0 = parse_ts(seg["t0"])
    elapsed = int((now - t0).total_seconds() * 1000)
    agent_ms, src, sids = net_of(seg, data, now)
    why, extra = "", {}
    if phase == "run":
        kind, net = "wall", elapsed
    elif agent_ms > 0:
        kind, net = "net", agent_ms
    elif src:
        kind, net = "unknown", 0
        extra = {"endKind": "nodata"}
        why = "证据全部落在嵌套的其他阶段段内，本段自身净耗时不足记，只记起止跨度"
    elif any(sid_seen(s) for s in sids):
        kind, net = "unknown", 0
        extra = {"endKind": "nodata"}
        why = "段内没有工具底账，净耗时无法判定，只记起止跨度"
    else:
        kind, net = "wall", elapsed
        why = "宿主无计时底账，按起止墙钟计"
    row = close_row(rid, seg, now, kind, net, agent_ms, elapsed, src, artifact, evidence,
                    "；".join(x for x in (note, why) if x), extra)
    if rnd:
        row["round"] = rnd
    if run_id:
        row["run_id"] = run_id
    if actor:
        row["actor"] = actor
    return row, why


# ───────── 报告 ─────────
def summarize(data):
    per = {c: {"n": 0, "ms": 0, "agent": 0, "t0": None, "t1": None, "kinds": set(), "art": "", "ev": ""}
           for c in PINDEX}
    for s in data["closed"]:
        r, p = s["row_end"], per[s["phase"]]
        p["n"] += 1
        p["ms"] += int(r.get("net_ms") or 0)
        p["agent"] += int(r.get("agent_ms") or r.get("net_ms") or 0)
        p["t0"] = s["t0"] if p["t0"] is None else min(p["t0"], s["t0"])
        p["t1"] = s["t1"] if p["t1"] is None else max(p["t1"], s["t1"])
        p["kinds"].add(str(r.get("duration_kind")))
        p["art"], p["ev"] = r.get("artifact") or "", r.get("evidence") or ""
    return per


def build_md(rid, data, now):
    per = summarize(data)
    sh = lambda ts: ts[:19]                                   # 表内只列到秒；时区恒为北京时间
    L = [f"# {rid} 时间线（各步骤耗时）", "",
         f"> 数据源：{rid}{SUF}.jsonl（只追加；本文件由 timeline_mark.py 派生，勿手改）· 口径正本：《计时与时间线规范》现行版（公司包\标准体系） · 生成 {fmt_dt(now)}",
         "> 净耗时（net）＝只计 agent 操作时间（主会话回合＋子代理运行），不含您思考、答复、等待的时间；"
         "执行轮（wall）＝从开始测试到本轮收尾的起止时间。", "",
         "## 一、分阶段汇总", "",
         "| 段 | 阶段 | 开始 | 结束 | 耗时 | 口径 | 段数 | 证据（最近一段） |",
         "| --- | --- | --- | --- | --- | --- | ---: | --- |"]
    for code, no, name, _req in PHASES:
        p = per[code]
        un = [u for u in data["unknown"] if u["phase"] == code]
        if p["n"]:
            L.append(f"| {no} | {name} | {sh(p['t0'])} | {sh(p['t1'])} | {fmt_dur(p['ms'])} | "
                     f"{'/'.join(sorted(p['kinds']))} | {p['n']} | {(p['ev'] or '—').replace('|', '／')} |")
        elif un:
            L.append(f"| {no} | {name} | — | — | 未计时 | unknown | 0 | 已申报 {len(un)} 次（见三） |")
    grand = sum(p["agent"] for p in per.values())
    runwall = sum(p["ms"] for p, c in zip(per.values(), PINDEX) if c == "run")
    L += ["", f"**agent 净操作合计：{fmt_dur(grand)}**（其中执行轮按起止墙钟计为 {fmt_dur(runwall)}；"
          "跨段之间您思考、答复、等待的时间不计）", "", "## 二、逐段明细", "",
          "| 阶段 | 轮次/回合 | 开始 | 结束 | 耗时 | agent 净操作 | 取数来源 | 产出物 | 证据 |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for s in sorted(data["closed"], key=lambda s: s["t0"]):
        r = s["row_end"]
        L.append(f"| {PSEG[s['phase']]}{PNAME[s['phase']]} | {r.get('round') or '—'} | {sh(s['t0'])} | {sh(s['t1'])} | "
                 f"{fmt_dur(r.get('net_ms'))} | {fmt_dur(r.get('agent_ms'))} | {r.get('sources') or '—'} | "
                 f"{(r.get('artifact') or '—').replace('|', '／')} | {(r.get('evidence') or '—').replace('|', '／')} |"
                 + ("" if not r.get("endKind") else f" 〔{r.get('endKind')}〕"))
    for s in sorted(data["open"], key=lambda s: s["t0"]):
        L.append(f"| {PSEG[s['phase']]}{PNAME[s['phase']]} | {s['row'].get('round') or '—'} | {sh(s['t0'])} | 进行中 | — | — | — | — | 起而无终（未收口） |")
    L += ["", "## 三、未计时申报（unknown）", "", "| 阶段 | 申报时间 | 原因 |", "| --- | --- | --- |"]
    for u in sorted(data["unknown"], key=lambda u: u["ts"]):
        L.append(f"| {PSEG[u['phase']]}{PNAME[u['phase']]} | {sh(u['ts'])} | {(u.get('note') or '—').replace('|', '／')} |")
    L += ["", "## 四、口径说明", "",
          "- 时间一律北京时间，年月日时分秒；同一段的起止在时间线与执行账本批次行两处必须一致。",
          "- 净耗时由工具取底账自动算（主会话回合起止／子代理运行区间／工具调用时刻三路并集），不手填；"
          "漏记的阶段只能如实申报 unknown，不补造。",
          "- 执行轮按起止墙钟计；agent 净操作列另列供对照，两者差得远说明轮内有等待。",
          "- 取数来源只写\"工具时刻\"的段＝回合起止钩子尚未生效，单次超过 3 分钟的长命令会被少算；"
          "口径为 unknown 的段＝段内没有底账（整段在一次长命令内，或等答复期间没有操作），无法判定净耗时，只记起止跨度。",
          f"- 本表只统计 {EFFECTIVE[:16]} 之后真实打点的段；此前已完成的阶段不补录。", ""]
    text = "\n".join(L)
    meta = f"<!-- timeline_meta segments={len(data['closed'])} rows={len(data['closed']) + len(data['open']) + len(data['unknown'])} -->"
    return text + "\n" + meta + "\n"


def write_md(path, text, force=False):
    """派生视图覆盖写；新表比旧表更薄（段/行更少）＝先探源，拒覆盖"""
    if path.exists() and not force:
        try:
            m = re.search(r"<!-- timeline_meta segments=(\d+) rows=(\d+) -->", path.read_text(encoding="utf-8"))
            n = re.search(r"<!-- timeline_meta segments=(\d+) rows=(\d+) -->", text)
            if m and n and (int(n.group(1)) < int(m.group(1)) or int(n.group(2)) < int(m.group(2))):
                print("[RED] 新时间线比旧表更薄（段/行变少），已拒绝覆盖——先查 jsonl 是否被改动；确需覆盖加 --force")
                return False
        except OSError:
            pass
    tmp = path.with_name(path.name + ".tmp")
    with io.open(str(tmp), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(str(tmp), str(path))
    return True


def refresh_md(rid, data, force=False):
    path = timeline_dir_of(rid) / f"{rid}{SUF}.md"
    return write_md(path, build_md(rid, data, now_dt()), force), path


_DIR_OVERRIDE = None


def timeline_dir_of(rid):
    return timeline_dir(_DIR_OVERRIDE)


def load(rid_override, dir_override):
    """→ (落盘 id, jsonl 路径)；id 归并提示直接打印"""
    global _DIR_OVERRIDE
    _DIR_OVERRIDE = dir_override or None
    tdir = timeline_dir(_DIR_OVERRIDE)
    rid, notes = resolve_id(rid_override, tdir)
    for m in notes:
        print("[i] " + m)
    return rid, tdir / f"{rid}{SUF}.jsonl"


def seg_ms(s):
    r = s["row_end"]
    return int(r.get("agent_ms") or r.get("net_ms") or 0)


def print_cumulative(rid, data, phase):
    closed = data["closed"]
    n = len([s for s in closed if s["phase"] == phase])
    tot = sum(seg_ms(s) for s in closed if s["phase"] == phase)
    grand = sum(seg_ms(s) for s in closed)
    print(f"   本阶段累计 {n} 段 · {fmt_dur(tot)}；全流程 agent 净操作合计 {fmt_dur(grand)}（时间线：{rid}{SUF}.md）")


# ───────── 命令 ─────────
def cmd_begin(a):
    rid, path = load(a.id, a.dir)
    data = segments(read_rows(path))
    now = now_dt()
    for seg in [s for s in data["open"] if s["phase"] == a.phase]:
        agent_ms, src, _ = net_of(seg, data, now)
        kind, net = ("net", agent_ms) if agent_ms > 0 else ("unknown", 0)
        row = close_row(rid, seg, now, kind, net, agent_ms, int((now - parse_ts(seg["t0"])).total_seconds() * 1000),
                        src, seg["row"].get("artifact") or "—", "底账自动收口",
                        "上一段未收口（会话中断或漏记 end），系统按底账自动收口", {"endKind": "auto"})
        append_row(path, row)
        data = segments(read_rows(path))
        print(f"[i] 「{tag_of(a.phase, seg['row'].get('round'))}」上一段未收口，已按底账自动收口（净 {fmt_dur(agent_ms) if agent_ms else '无底账，标 unknown'}）")
    t0, snapped = now, False
    c_sid = sid16()
    if c_sid:
        _, open_t, _ = turn_spans(_activity_rows(c_sid, now - timedelta(seconds=SNAP_S), now, "span"))
        if open_t is not None:
            t0, snapped = open_t, True
    row = base_row(rid, a.phase, a.actor)
    row.update({"event": a.phase + "_start", "duration_kind": "wall" if a.phase == "run" else "net",
                "round": a.round or "", "run_id": a.run_id or "", "artifact": a.artifact or "", "note": a.note or ""})
    append_row(path, row)
    print(f"⏱ [{tag_of(a.phase, a.round)}] 开始 {fmt_dt(t0)}" + ("（起点取本回合开始）" if snapped else ""))
    return 0


def cmd_end(a):
    rid, path = load(a.id, a.dir)
    data = segments(read_rows(path))
    seg = next((s for s in data["open"] if s["phase"] == a.phase), None)
    if seg is None:
        print(f"[RED] 「{tag_of(a.phase, a.round)}」没有进行中的段（终而无始）：先 begin 再 end；整段都漏了用 miss 如实申报，禁补造。")
        return 2
    now = now_dt()
    row, why = compute_end(rid, seg, data, now, a.phase, a.artifact, a.evidence, a.round, a.run_id, a.actor, a.note)
    append_row(path, row)
    data = segments(read_rows(path))
    ok, md = refresh_md(rid, data)
    tag = tag_of(a.phase, row["round"])
    if row["duration_kind"] == "wall" and a.phase == "run":
        print(f"⏱ [{tag}] 结束 {fmt_dt(now)} · 耗时 {fmt_dur(row['net_ms'])}（执行轮按起止计）· 其中 agent 净操作 {fmt_dur(row['agent_ms'])}")
    elif row["duration_kind"] == "net":
        print(f"⏱ [{tag}] 结束 {fmt_dt(now)} · 净耗时 {fmt_dur(row['net_ms'])}（不含您答复期间）")
    elif row["duration_kind"] == "unknown":
        print(f"⏱ [{tag}] 结束 {fmt_dt(now)} · 起止 {fmt_dur(row['elapsed_ms'])}（{why}）")
    else:
        print(f"⏱ [{tag}] 结束 {fmt_dt(now)} · 起止 {fmt_dur(row['net_ms'])}（墙钟：{why}）")
    if row["duration_kind"] == "net" and sid16() and "回合起止" not in row["sources"]:
        print("   ⚠ 回合起止钩子尚未生效（重开会话后生效），本段按工具调用时刻估算，长命令会被少算")
    print_cumulative(rid, data, a.phase)
    if not ok:
        return 2
    return 0


def cmd_miss(a):
    rid, path = load(a.id, a.dir)
    codes = [c.strip() for c in a.phase.split(",") if c.strip()]
    bad = [c for c in codes if c not in PINDEX]
    if bad or not codes:
        print(f"[RED] 阶段码非法：{bad or '空'}（合法码见 phases）")
        return 2
    for c in codes:
        row = base_row(rid, c, a.actor)
        row.update({"event": c + "_unknown", "duration_kind": "unknown", "note": a.reason})
        append_row(path, row)
    data = segments(read_rows(path))
    refresh_md(rid, data)
    print("已申报未计时（unknown）：" + "、".join(tag_of(c, "") for c in codes) + f"｜原因：{a.reason}")
    print(f"   全流程 agent 净操作合计 {fmt_dur(sum(seg_ms(s) for s in data['closed']))}（时间线：{rid}{SUF}.md）")
    return 0


def cmd_status(a):
    rid, path = load(a.id, a.dir)
    data = segments(read_rows(path))
    red, warn = [], []
    print(f"── timeline_status：{rid}（{path}）")
    for code, no, name, _req in PHASES:
        cs = [s for s in data["closed"] if s["phase"] == code]
        un = [u for u in data["unknown"] if u["phase"] == code]
        op = [s for s in data["open"] if s["phase"] == code]
        if op:
            state = "进行中（自 {0}）".format("、".join(sorted(s["t0"][:19] for s in op)))
            red.append(f"{tag_of(code, '')} 起而无终（进行中未收口）")
        elif cs:
            und = [s for s in cs if s["row_end"].get("duration_kind") == "unknown"]
            state = "已计时 {0} 段 · {1}".format(len(cs) - len(und), fmt_dur(sum(seg_ms(s) for s in cs)))
            if und:
                state += "（另有 {0} 段净耗时无法判定，只记起止）".format(len(und))
        elif un:
            state = "未计时（已申报 {0} 次）".format(len(un))
        else:
            state = "未开始"
        if PREQ[code] and a.upto and PINDEX[code] < PINDEX[a.upto] and not cs and not un and not op:
            state += "  ← 必经段，缺计时也未申报"
            red.append(f"{tag_of(code, '')} 必经段缺计时也未申报")
        print(f"  {no} {name}　{state}")
    # 漏记探测：本需求用过的会话里调过某技能，却没有任何对应阶段的段
    sids = {}
    for s in data["closed"] + data["open"]:
        if s["row"].get("sid"):
            sids[s["row"]["sid"]] = True
    if sids:
        t_from = parse_ts(min(s["t0"] for s in data["closed"] + data["open"])) or now_dt()
        have = {s["phase"] for s in data["closed"] + data["open"]}
        for sid in sids:
            for t, skill in _activity_rows(sid, t_from, now_dt() + timedelta(minutes=5), "skill"):
                ph = SKILL_PHASE.get(skill)
                if not ph:
                    continue
                ok = bool(have & ({"qa", "locate"} if ph == "qa" else {ph}))
                if not ok:
                    warn.append(f"{fmt_dt(t)[:19]} 调过 {skill}，但「{tag_of(ph, '')}」没有任何计时段——属本需求请补 begin/end 或 miss 申报")
    for w in sorted(set(warn)):
        print(f"  ⚠ {w}")
    print(f"  全流程 agent 净操作合计 {fmt_dur(sum(seg_ms(s) for s in data['closed']))}"
          f"（已计时 {sum(1 for p in PHASES if any(s['phase'] == p[0] for s in data['closed']))} 个阶段；时间线：{path.with_suffix('.md').name}）")
    if red:
        for r in red:
            print(f"  ✗ {r}")
        print("结论：[RED] 处置：漏记→ miss 如实申报；起而无终→ 续跑同阶段会自动收口，或补 end；禁事后补造耗时")
        return 1
    print("结论：[GREEN] 无起而无终，必经段均已计时或申报")
    return 0


def cmd_report(a):
    rid, path = load(a.id, a.dir)
    data = segments(read_rows(path))
    ok, md = refresh_md(rid, data, a.force)
    print(md)
    if not ok:
        return 2
    print_cumulative(rid, data, "run")
    print(f"已重出时间线：{md}")
    return 0


def cmd_phases(_a):
    print(f"{'阶段码':10} {'段':4} {'名称':14} 常规必经")
    for code, no, name, req in PHASES:
        print(f"{code:10} {no:4} {name:16} {'是' if req else '否（做过才计）'}")
    print("\n常规必经＝--upto 之前的必经段须已计时或已申报；执行轮每轮一段（--run-id 对齐账本 run_start 行）。")
    return 0


def selftest():
    import shutil
    import timeline_check
    ok = True

    def eq(name, got, exp):
        nonlocal ok
        good = got == exp
        ok = ok and good
        print(f"  {'✓' if good else '✗'} {name}：{got!r}" + ("" if good else f"（应为 {exp!r}）"))

    D = lambda h, m=0, s=0: datetime(2026, 11, 25, h, m, s, tzinfo=BJ)
    # ① 回合配对
    rows = [(D(9), "turn_in"), (D(9, 0, 30), "post"), (D(9, 2), "turn_out"),                # 回合1：2 分钟
            (D(9, 30), "turn_in"), (D(9, 30, 30), "post"), (D(9, 33), "turn_out"),          # 回合2：3 分钟（用户间隔 28 分钟不计）
            (D(9, 40), "post"), (D(9, 42), "turn_out"),                                     # 续跑回合（无 turn_in）：从 9:33 起算
            (D(10), "turn_in"), (D(10, 1), "post"), (D(10, 5), "turn_in")]                  # 被打断回合：算到 10:01
    sp, open_t, _ = turn_spans(rows)
    eq("回合配对·已收口区间数（另 1 个进行中）", len(sp), 4)
    eq("回合配对·续跑回合起点", sp[2][0], D(9, 33))
    eq("回合配对·被打断回合止点", sp[3][1], D(10, 1))
    eq("回合配对·进行中回合", open_t, D(10, 5))
    # ② 聚簇与并集
    cl = clusters([(D(9), "post"), (D(9, 2), "post"), (D(9, 2, 30), "post"), (D(9, 10), "post")])
    eq("聚簇·段数", len(cl), 2)
    eq("并集·裁窗", union_ms([(D(9), D(9, 10)), (D(9, 5), D(9, 20))], D(9, 3), D(9, 15)), 12 * 60 * 1000)
    eq("归同名·去版本", norm_id("仓内作业价格 11.30 v3.3"), "仓内作业价格")
    eq("归同名·去批次", norm_id("对客报价_11.30"), "对客报价")
    eq("归同名·原样", norm_id("云仓账单"), "云仓账单")
    eq("归同名·字母V不算版本", norm_id("TestV2"), "TestV2")
    # ③ 端到端：临时目录＋注入时钟＋合成底账/子代理元数据
    tmp = Path(tempfile.mkdtemp(prefix="tl_selftest_"))
    old = {k: os.environ.get(k) for k in ("TIMELINE_DIR", "TIMELINE_ACTIVITY", "ZCODE_HOME", "ZCODE_SESSION_ID")}
    try:
        act = tmp / "act"
        act.mkdir()
        (act / "agent_activity.jsonl").write_text("", encoding="utf-8")
        sid_full = "sess_selftest000000000000000000001"
        os.environ.update({"TIMELINE_DIR": str(tmp / "out"), "TIMELINE_ACTIVITY": str(act),
                           "ZCODE_HOME": str(tmp / "home"), "ZCODE_SESSION_ID": sid_full})
        sid = sid_full[:16]

        def log(ts, event, **kw):
            with io.open(str(act / "agent_activity.jsonl"), "a", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps(dict({"ts": fmt_dt(ts), "event": event, "tool": "Bash", "fp": "", "sid": sid}, **kw),
                                   ensure_ascii=False) + "\n")

        def sub(name, c, e, status="completed"):
            d = tmp / "home" / "cli" / "agents" / sid_full / f"agent_{name}"
            d.mkdir(parents=True)
            (d / "metadata.json").write_text(json.dumps({"parentSessionId": sid_full, "status": status,
                                                         "createdAt": c, "completedAt": e}), encoding="utf-8")
        args = lambda **kw: argparse.Namespace(**kw)
        global _NOW
        # 生成段：回合 10:00~10:10 ＋（用户间隔到 10:30 不计）回合 10:30~10:40 ＋ 子代理 10:35~10:55（回合结束后仍在跑）
        _NOW = D(10)
        cmd_begin(args(id="示例需求 11.30", phase="generate", round="", run_id="", actor="usecase-generator", note="", artifact="", dir=""))
        log(D(10), "turn_in"); log(D(10, 1), "post"); log(D(10, 10), "turn_out")
        log(D(10, 30), "turn_in"); log(D(10, 31), "post"); log(D(10, 40), "turn_out")
        sub("x1", "2026-11-25T02:35:00.000Z", "2026-11-25T02:55:00.000Z")      # 10:35~10:55 北京时间
        _NOW = D(11)
        rc = cmd_end(args(id="示例需求", phase="generate", artifact="D:/x/示例需求_v1.md", evidence="assemble 全绿·100 条",
                          round="", run_id="", actor="", note="", dir=""))
        eq("端到端·end 退出码", rc, 0)
        eq("端到端·归并到既有 id", (tmp / "out" / "示例需求 11.30_timeline.jsonl").exists(), True)
        ev = [json.loads(x) for x in (tmp / "out" / "示例需求 11.30_timeline.jsonl").read_text(encoding="utf-8").splitlines()]
        eq("端到端·行数", len(ev), 2)
        eq("端到端·净耗时（10 分钟＋〔10:30,10:55〕25 分钟＝35 分钟；用户间隔 20 分钟不计）", ev[1]["net_ms"], 35 * 60 * 1000)
        eq("端到端·取数来源", set(ev[1]["sources"].split("＋")), {"子代理", "工具时刻", "回合起止"})
        eq("端到端·口径", ev[1]["duration_kind"], "net")
        # 执行轮：起止墙钟
        _NOW = D(14)
        cmd_begin(args(id="示例需求", phase="run", round="示例-R1", run_id="R1", actor="", note="", artifact="", dir=""))
        _NOW = D(14, 30)
        cmd_end(args(id="示例需求", phase="run", artifact="D:/x/账本.jsonl", evidence="run_start/run_end 批次行",
                     round="", run_id="", actor="", note="", dir=""))
        ev = [json.loads(x) for x in (tmp / "out" / "示例需求 11.30_timeline.jsonl").read_text(encoding="utf-8").splitlines()]
        eq("执行轮·墙钟", (ev[-1]["duration_kind"], ev[-1]["net_ms"]), ("wall", 30 * 60 * 1000))
        # 中断段：begin 后不 end，再次 begin 自动收口
        _NOW = D(16)
        cmd_begin(args(id="示例需求", phase="qa", round="第1问", run_id="", actor="", note="", artifact="", dir=""))
        log(D(16), "turn_in"); log(D(16, 2), "post"); log(D(16, 5), "turn_out")
        _NOW = D(17)
        cmd_begin(args(id="示例需求", phase="qa", round="第2问", run_id="", actor="", note="", artifact="", dir=""))
        ev = [json.loads(x) for x in (tmp / "out" / "示例需求 11.30_timeline.jsonl").read_text(encoding="utf-8").splitlines()]
        eq("自动收口·endKind", ev[-2].get("endKind"), "auto")
        eq("自动收口·净耗时（只算到 16:05）", ev[-2]["net_ms"], 5 * 60 * 1000)
        _NOW = D(17, 3)
        log(D(17), "turn_in"); log(D(17, 1), "post"); log(D(17, 2), "turn_out")
        cmd_end(args(id="示例需求", phase="qa", artifact="D:/x/理解说明.md", evidence="闭环表第2项",
                     round="", run_id="", actor="", note="", dir=""))
        ev = [json.loads(x) for x in (tmp / "out" / "示例需求 11.30_timeline.jsonl").read_text(encoding="utf-8").splitlines()]
        eq("第2问·净耗时（回合 17:00~17:02；窗口外的子代理不计入来源）", (ev[-1]["net_ms"], set(ev[-1]["sources"].split("＋"))),
           (2 * 60 * 1000, {"回合起止", "工具时刻"}))
        # 嵌套扣除：保真门开在准备段之内，准备段净耗时须扣掉它
        _NOW = D(19)
        cmd_begin(args(id="示例需求", phase="prep", round="", run_id="", actor="", note="", artifact="", dir=""))
        log(D(19), "turn_in"); log(D(19, 1), "post"); log(D(19, 10), "turn_out")
        _NOW = D(19, 10)
        cmd_begin(args(id="示例需求", phase="specgate", round="", run_id="", actor="", note="", artifact="", dir=""))
        log(D(19, 10), "turn_in"); log(D(19, 15), "turn_out")
        _NOW = D(19, 15)
        cmd_end(args(id="示例需求", phase="specgate", artifact="D:/x/保真报告.md", evidence="红清单清零",
                     round="", run_id="", actor="", note="", dir=""))
        _NOW = D(19, 16)
        cmd_end(args(id="示例需求", phase="prep", artifact="D:/x/specs.json", evidence="阶段〇双绿",
                     round="", run_id="", actor="", note="", dir=""))
        ev = [json.loads(x) for x in (tmp / "out" / "示例需求 11.30_timeline.jsonl").read_text(encoding="utf-8").splitlines()]
        eq("嵌套扣除·准备段净耗时（证据 19:00~19:15 共 15 分钟 − 保真门 5 分钟）", ev[-1]["net_ms"], 10 * 60 * 1000)
        eq("嵌套扣除·保真门自身净耗时", ev[-2]["net_ms"], 5 * 60 * 1000)
        # 段内只有孤立一次工具调用＝至少 1 秒（有底账就按净耗时，宁小勿大）
        _NOW = D(21)
        cmd_begin(args(id="示例需求", phase="qa", round="第3问", run_id="", actor="", note="", artifact="", dir=""))
        log(D(21, 0, 30), "post")
        _NOW = D(21, 2)
        cmd_end(args(id="示例需求", phase="qa", artifact="D:/x/理解说明.md", evidence="闭环表第3项",
                     round="", run_id="", actor="", note="", dir=""))
        ev = [json.loads(x) for x in (tmp / "out" / "示例需求 11.30_timeline.jsonl").read_text(encoding="utf-8").splitlines()]
        eq("孤立一次工具调用·至少 1 秒", ev[-1]["net_ms"], 1000)
        # 段内没有任何底账（比如整段是一次长命令，或等答复期间没操作）→ 如实标 unknown，不拿墙钟把等待算进去
        _NOW = D(22)
        cmd_begin(args(id="示例需求", phase="challenge", round="质疑轮1", run_id="", actor="", note="", artifact="", dir=""))
        _NOW = D(23)
        cmd_end(args(id="示例需求", phase="challenge", artifact="D:/x/违例清单.md", evidence="违例清单 K 条",
                     round="", run_id="", actor="", note="", dir=""))
        ev = [json.loads(x) for x in (tmp / "out" / "示例需求 11.30_timeline.jsonl").read_text(encoding="utf-8").splitlines()]
        eq("段内无底账·标 unknown 不按墙钟", (ev[-1]["duration_kind"], ev[-1].get("endKind"), ev[-1].get("net_ms")),
           ("unknown", "nodata", None))
        # 宿主完全没有底账设施（拿不到会话标识）→ 才按墙钟计
        os.environ.pop("ZCODE_SESSION_ID", None)
        _NOW = D(23)
        cmd_begin(args(id="示例需求", phase="deliver", round="", run_id="", actor="", note="", artifact="", dir=""))
        _NOW = D(23, 5)
        cmd_end(args(id="示例需求", phase="deliver", artifact="D:/x/册.xlsx", evidence="三格式差异=0",
                     round="", run_id="", actor="", note="", dir=""))
        os.environ["ZCODE_SESSION_ID"] = sid_full
        ev = [json.loads(x) for x in (tmp / "out" / "示例需求 11.30_timeline.jsonl").read_text(encoding="utf-8").splitlines()]
        eq("宿主无底账设施·按墙钟", (ev[-1]["duration_kind"], ev[-1]["net_ms"]), ("wall", 5 * 60 * 1000))
        # status：必经段缺计时 → 红；申报后 → 绿
        _NOW = D(18)
        rc = cmd_status(args(id="示例需求", upto="run", dir=""))
        eq("status·缺必经段时退出码", rc, 1)
        cmd_miss(args(id="示例需求", phase="locate,qa,challenge,deliver,prep", reason="自测：生效前已完成", actor="", dir=""))
        rc = cmd_status(args(id="示例需求", upto="run", dir=""))
        eq("status·申报后退出码", rc, 0)
        # 质检机检（独立检查器）对工具产出必绿；返工回路（答疑首现在生成之后）只提示不判红
        p = tmp / "out" / "示例需求 11.30_timeline.jsonl"
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = timeline_check.check(str(p))
        eq("timeline_check·机检绿", rc, 0)
        eq("timeline_check·先后序只提示", "⚠ 阶段首现序" in buf.getvalue(), True)
        md = (tmp / "out" / "示例需求 11.30_timeline.md").read_text(encoding="utf-8")
        eq("时间线 md·已生成", "分阶段汇总" in md and "示例-R1" in md, True)
    finally:
        for k, v in old.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"[{'GREEN' if ok else 'RED'}] timeline_mark selftest {'全过' if ok else '有失败项'}")
    return 0 if ok else 1


def main(argv=None):
    global _NOW
    ap = argparse.ArgumentParser(description="阶段计时打点与时间线汇总（计时与时间线规范 v1.2）")
    ap.add_argument("--selftest", action="store_true", help="内置自测")
    ap.add_argument("--now", help=argparse.SUPPRESS)            # 自测/演练用：注入时钟
    sub = ap.add_subparsers(dest="cmd")
    for name in ("begin", "end", "miss", "status", "report"):
        p = sub.add_parser(name)
        p.add_argument("--id", required=True, help="册名（流水线台账里的需求名，各阶段沿用同名）")
        p.add_argument("--dir", default="", help="覆盖时间线目录（默认 {paths.用例文件}/计时）")
        p.add_argument("--actor", default="", help="技能名（写入 actor）")
        if name in ("begin", "end", "miss"):
            p.add_argument("--phase", required=True, help="阶段码（多个用逗号分隔，仅 miss）；码表见 phases")
        if name in ("begin", "end"):
            p.add_argument("--round", default="", help="轮次/回合标签：第3问 / 质疑轮2 / 仓内-R7")
            p.add_argument("--run-id", default="", help="执行轮号（与账本 run_start 行一致）")
            p.add_argument("--note", default="", help="备注（中途停机写原因）")
        if name == "begin":
            p.add_argument("--artifact", default="", help="预期产出（可省）")
        if name == "end":
            p.add_argument("--artifact", required=True, help="产出物绝对路径")
            p.add_argument("--evidence", required=True, help="证据定位（文件内章节/校验输出/条数等）")
        if name == "miss":
            p.add_argument("--reason", required=True, help="漏记或未计时的原因")
        if name == "status":
            p.add_argument("--upto", default="", help="验门：此阶段码之前的必经段须已计时或已申报")
        if name == "report":
            p.add_argument("--force", action="store_true", help="允许覆盖成更薄的表（先探源再用）")
    p = sub.add_parser("phases")
    a = ap.parse_args(argv)
    if session_id().startswith("sess_subagent_") and a.cmd in ("begin", "end", "miss"):
        # 钩子在子代理内不触发、子代理时长由工具读宿主元数据自动计入——打点只由主会话统一做，防重复
        print("[i] 当前在子代理内：计时由主会话统一打点（子代理运行时长工具自动计入），本命令不落盘")
        return 0
    if getattr(a, "now", None):
        _NOW = parse_ts(a.now)
    if a.selftest:
        return selftest()
    if getattr(a, "upto", "") and a.upto not in PINDEX:
        print(f"[RED] --upto 阶段码非法：{a.upto}（合法码见 phases）")
        return 2
    if getattr(a, "phase", "") and (a.cmd != "miss" or "," not in a.phase) and a.phase not in PINDEX:
        print(f"[RED] 阶段码非法：{a.phase}（合法码见 phases）")
        return 2
    return {"begin": cmd_begin, "end": cmd_end, "miss": cmd_miss, "status": cmd_status,
            "report": cmd_report, "phases": cmd_phases}.get(a.cmd, lambda _a: ap.print_help() or 2)(a)


if __name__ == "__main__":
    sys.exit(main())
