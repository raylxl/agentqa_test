# -*- coding: utf-8 -*-
"""坑库信任度扫描器（执行坑库_v1 §六·2026-11-12 立）

按条目"来源"列最近日期判断信任度：>N 天未复验→待复验；无日期→需补；
已失效/已推翻条目跳过。开工注入（usecase-executor 工序 1.85）时必跑，
输出贴进执行上下文——待复验条目照用前先验，验证后在来源列追加"；复验YYYY-MM-DD"。

用法: python pitfall_scan.py [坑库路径] [--days 60]
"""
import argparse
import io
import re
import sys
from pathlib import Path
from datetime import date

ENTRY_RE = re.compile(r'^\|\s*([GQHE]\d+[a-z]?)\s*\|')
FULL_DATE_RE = re.compile(r'(20\d{2})-(\d{1,2})-(\d{1,2})')
MD_DATE_RE = re.compile(r'(?<!\d)(\d{1,2})-(\d{1,2})(?!\d)')
RETIRE_RE = re.compile(r'〔已失效|〔已推翻')


def latest_date(text, year):
    dates = [date(int(y), int(m), int(d)) for y, m, d in FULL_DATE_RE.findall(text)]
    for m, d in MD_DATE_RE.findall(text):
        try:
            dates.append(date(year, int(m), int(d)))
        except ValueError:
            pass
    return max(dates) if dates else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", default=str(Path(__file__).with_name("执行坑库_v1.md")))
    ap.add_argument("--days", type=int, default=60)
    a = ap.parse_args()
    today = date.today()
    buckets = {"current": [], "stale": [], "nodate": [], "retired": []}
    for line in io.open(a.path, encoding="utf-8-sig").read().splitlines():
        m = ENTRY_RE.match(line)
        if not m:
            continue
        eid = m.group(1)
        if RETIRE_RE.search(line):
            buckets["retired"].append(eid)
            continue
        d = latest_date(line, today.year)
        if d is None:
            buckets["nodate"].append(eid)
        elif (today - d).days > a.days:
            buckets["stale"].append("%s（%s，%d天）" % (eid, d.isoformat(), (today - d).days))
        else:
            buckets["current"].append(eid)
    print("=== 坑库信任度扫描（阈值 %d 天｜库=%s）===" % (a.days, a.path))
    print("现行 %d｜待复验 %d｜无日期需补 %d｜已失效 %d" % tuple(len(buckets[k]) for k in ("current", "stale", "nodate", "retired")))
    if buckets["stale"]:
        print("— 待复验（照用前先验；验证后来源列追加；复验YYYY-MM-DD）—")
        for x in buckets["stale"]:
            print("  " + x)
    if buckets["nodate"]:
        print("— 无日期（需补来源日期）—")
        print("  " + " ".join(buckets["nodate"]))
    if not buckets["stale"] and not buckets["nodate"]:
        print("全部条目在信任窗口内")
    return 0


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.exit(main())
