# -*- coding: utf-8 -*-
"""
standards_version_check_v1.py — 版本一致性机检（防"索引/文件/引用"版本漂移 + L4 双正本分叉）
锚点 = 00_标准体系索引.md §一矩阵（体系唯一版本锚点）
检查：
  [红] 标准文件文内修订记录最新版 ≠ 索引版本列内容修订版
  [红] L4 域标准双正本分叉：活正本（需求文档库）与仓内副本（产品线/{线}/L4域标准/）内容不一致/单侧缺失
       ——正本方向=活正本（qa-loop 抽域标准工序产出侧）；同步=活→仓单向镜像，修分叉用 cp 活正本 覆盖仓内副本
  [黄] 仓内副本孤儿件（活正本侧无同名件；人工判：或为改名/下线）
  [黄] 技能 SKILL.md 中的"XX标准 vX.Y"引用 ≠ 索引现行版（人工判：可能是历史表述）
  [黄] 无法解析修订记录 / 引用未登记
路径自定位（2026-11-19 双树根治+批次3拆分适配）：STD_DIR=本文件所在目录（发起机/克隆同构可跑）；
     技能根/需求文档/当前线 从 公司包/agent-company.json 解析（缺失走布局缺省）。
用法：python standards_version_check_v1.py   （红>0 → exit 1）
"""
import json
import re
import sys
import pathlib

STD_DIR = pathlib.Path(__file__).resolve().parent          # = 公司包/标准体系（正本树）
COMPANY_DIR = STD_DIR.parent                               # = 公司包
REPO_ROOT = STD_DIR.parents[1]                             # = agentqa_test 仓根
CFG = COMPANY_DIR / "agent-company.json"

VRE = re.compile(r'v(\d+(?:\.\d+)?)')


def _cfg():
    try:
        return json.loads(CFG.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _paths():
    p = _cfg().get("paths", {})
    skills = p.get("技能根") or str(REPO_ROOT / "Agent本体" / "skills")
    docs = p.get("需求文档") or str(REPO_ROOT.parent / "需求用例库" / "需求文档")
    line = _cfg().get("业务线", {}).get("当前线", "财务线")
    return pathlib.Path(skills), pathlib.Path(docs), line


SKILL_DIR, LIVE_DIR, CUR_LINE = _paths()
L4_DIR = COMPANY_DIR / "产品线" / CUR_LINE / "L4域标准"


def content_ver(ver_col: str):
    """从索引版本列提取内容修订版：优先'内容修订 vX'，否则第一个 vX。"""
    m = re.search(r'内容修订\s*v(\d+(?:\.\d+)?)', ver_col)
    if m:
        return m.group(1)
    m = VRE.search(ver_col)
    return m.group(1) if m else None


def resolve_std_file(name_raw: str):
    """索引文件列 → 可读文件。兼容：裸文件名（标准体系内）/ 仓根相对路径（产品线等）/
    L4 活正本复合行（取基名，读仓内副本）。"""
    s = name_raw.split("+")[0].strip().strip("`").strip()
    m = re.search(r"活正本=`([^`]+)`", s)
    if m:
        s = pathlib.PurePath(m.group(1).replace("\\", "/")).name
        cand = L4_DIR / s
        return cand if cand.exists() else None
    for cand in (STD_DIR / pathlib.PurePath(s.replace("\\", "/")).name,
                 REPO_ROOT / s.replace("\\", "/")):
        if cand.exists():
            return cand
    return None


def parse_index():
    """解析§一矩阵 → [(显示名, 文件或None, 索引内容版本)]。"""
    rows, in_m = [], False
    for line in (STD_DIR / "00_标准体系索引.md").read_text(encoding="utf-8").splitlines():
        if re.match(r'^\|\s*层\b', line):
            in_m = True
            continue
        if in_m:
            if not line.startswith("|"):
                if rows:
                    break
                continue
            cells = [c.strip().strip('`') for c in line.strip("|").split("|")]
            if len(cells) >= 3 and not re.match(r'^[-—\s]+$', cells[0]):
                name, ver = cells[1], content_ver(cells[2])
                rows.append((name, resolve_std_file(name), ver))
    return rows


def last_rev_in_file(fp: pathlib.Path):
    """取文件'## 修订记录'表最后一行的版本号。"""
    if fp is None:
        return None, "索引行无可解析文件"
    if not fp.exists():
        return None, "文件不存在"
    txt = fp.read_text(encoding="utf-8", errors="replace")
    i = txt.find("修订记录")
    if i < 0:
        return None, "无修订记录节"
    last = None
    for line in txt[i:].splitlines():
        if line.startswith("|"):
            m = VRE.search(line)
            if m and not re.match(r'^\|[\s\-—|]+$', line):
                last = m.group(1)
    return last, None


def check_l4_sync():
    """L4 双正本对账（2026-11-19 立项）：活正本（需求文档库）↔ 仓内副本，内容不一致/单侧缺失=红。"""
    reds, yellows = [], []
    if not LIVE_DIR.is_dir():
        return [f"L4 活正本目录不可达：{LIVE_DIR}（无工作区配置的纯克隆=预期，跳过本项）"], []
    live = {p.name: p for p in LIVE_DIR.glob("*_用例编写标准_*.md")}
    repo = {p.name: p for p in L4_DIR.glob("*.md")}
    for n in sorted(set(live) & set(repo)):
        a = live[n].read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
        b = repo[n].read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
        if a != b:
            reds.append(f"[L4分叉] {n}：活正本≠仓内副本——正本=活正本，同步：cp 活正本 覆盖仓内副本后提交")
    for n in sorted(set(live) - set(repo)):
        reds.append(f"[L4缺镜像] {n}：活正本已建、仓内副本缺——cp 入 {L4_DIR} 后提交（qa-loop 抽域标准收尾步）")
    for n in sorted(set(repo) - set(live)):
        yellows.append(f"[L4孤儿] {n}：仓内副本有、活正本无（人工判：或为改名/下线/待建域）")
    return reds, yellows


def scan_skills(index_rows):
    """扫描技能中"XX标准/规范/细则/索引 vX.Y"引用 → 与索引比对。"""
    hits = []
    pat = re.compile(r'([\u4e00-\u9fa5A-Za-z·—（）()-]{2,24}?(?:标准|规范|细则|索引))[^|\n]{0,28}?v(\d+(?:\.\d+)?)')
    if not SKILL_DIR.is_dir():
        return hits
    for d in sorted(SKILL_DIR.glob("*/SKILL.md")):
        for ln, line in enumerate(d.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            for m in pat.finditer(line):
                ref_name, ref_ver = m.group(1), m.group(2)
                match = next((r for r in index_rows if ref_name[:6] in r[0] or r[0][:6] in ref_name), None)
                hits.append((d.parent.name, ln, ref_name, ref_ver, match[2] if match else "未登记"))
    return hits


def main():
    rows = parse_index()
    reds, yellows = [], []
    print(f"== 版本一致性机检 v1 == 锚点：00_标准体系索引.md，登记 {len(rows)} 项；当前线={CUR_LINE}")
    for stem, fp, idx_ver in rows:
        file_ver, err = last_rev_in_file(fp)
        if err:
            yellows.append(f"[{stem}] {err}（跳过比对）")
            continue
        if idx_ver and file_ver and file_ver != idx_ver:
            reds.append(f"[{stem}] 文件修订记录最新 v{file_ver} ≠ 索引 v{idx_ver}")
    r2, y2 = check_l4_sync()
    reds += r2
    yellows += y2
    for sk, ln, name, rv, iv in scan_skills(rows):
        if iv == "未登记":
            yellows.append(f"[{sk}:{ln}] 引用\"{name} v{rv}\"未登记（人工判）")
        elif rv != iv:
            yellows.append(f"[{sk}:{ln}] 引用\"{name} v{rv}\" ≠ 索引 v{iv}（人工判：或为历史表述）")
    for r in reds:
        print("红｜" + r)
    for y in yellows:
        print("黄｜" + y)
    print(f"结论：红 {len(reds)} 项，黄 {len(yellows)} 项" + ("（红≠0 → exit 1）" if reds else ""))
    sys.exit(1 if reds else 0)


if __name__ == "__main__":
    main()
