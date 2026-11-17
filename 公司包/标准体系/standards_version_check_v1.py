# -*- coding: utf-8 -*-
"""
standards_version_check_v1.py — 版本一致性机检（防"索引/文件/引用"版本漂移）
锚点 = 00_标准体系索引.md §一矩阵（体系唯一版本锚点）
检查：
  [红] 标准文件文内修订记录最新版 ≠ 索引版本列内容修订版
  [黄] 技能 SKILL.md 中的"XX标准 vX.Y"引用 ≠ 索引现行版（人工判：可能是历史表述）
  [黄] 无法解析修订记录 / 引用未登记
用法：python standards_version_check_v1.py   （红>0 → exit 1）
"""
import re, sys, pathlib

STD_DIR = pathlib.Path(r"D:\ZCodetest\用例设计标准_我的定稿")
IDX = STD_DIR / "00_标准体系索引.md"
SKILL_DIR = pathlib.Path(r"D:\ZCodetest\.zcode\skills")

VRE = re.compile(r'v(\d+(?:\.\d+)?)')

def content_ver(ver_col: str):
    """从索引版本列提取内容修订版：优先'内容修订 vX'，否则第一个 vX。"""
    m = re.search(r'内容修订\s*v(\d+(?:\.\d+)?)', ver_col)
    if m: return m.group(1)
    m = VRE.search(ver_col)
    return m.group(1) if m else None

def parse_index():
    """解析§一矩阵 → [(显示名, 文件path, 索引内容版本)]。"""
    rows, in_m = [], False
    for line in IDX.read_text(encoding='utf-8').splitlines():
        if re.match(r'^\|\s*层\b', line): in_m = True; continue
        if in_m:
            if not line.startswith('|'):
                if rows: break
                continue
            cells = [c.strip().strip('`') for c in line.strip('|').split('|')]
            if len(cells) >= 3 and not re.match(r'^[-—\s]+$', cells[0]):
                name, ver = cells[1], content_ver(cells[2])
                p = pathlib.Path(name)
                rows.append((p.stem, p, ver))
    return rows

def last_rev_in_file(fp: pathlib.Path):
    """取文件'## 修订记录'表最后一行的版本号。"""
    if not fp.exists(): return None, '文件不存在'
    txt = fp.read_text(encoding='utf-8', errors='replace')
    i = txt.find('修订记录')
    if i < 0: return None, '无修订记录节'
    seg = txt[i:]
    last = None
    for line in seg.splitlines():
        if line.startswith('|'):
            m = VRE.search(line)
            if m and not re.match(r'^\|[\s\-—|]+$', line):
                last = m.group(1)
    return last, None

def scan_skills(index_rows):
    """扫描技能中"XX标准/规范/细则/索引 vX.Y"引用 → 与索引比对。"""
    hits = []
    pat = re.compile(r'([\u4e00-\u9fa5A-Za-z·—（）()-]{2,24}?(?:标准|规范|细则|索引))[^|\n]{0,28}?v(\d+(?:\.\d+)?)')
    for d in sorted(SKILL_DIR.glob('*/SKILL.md')):
        for ln, line in enumerate(d.read_text(encoding='utf-8', errors='replace').splitlines(), 1):
            for m in pat.finditer(line):
                ref_name, ref_ver = m.group(1), m.group(2)
                match = next((r for r in index_rows if ref_name[:6] in r[0] or r[0][:6] in ref_name), None)
                hits.append((d.parent.name, ln, ref_name, ref_ver, match[2] if match else '未登记'))
    return hits

def main():
    rows = parse_index()
    reds, yellows = [], []
    print(f'== 版本一致性机检 v1 == 锚点：{IDX.name}，登记 {len(rows)} 项')
    for stem, p, idx_ver in rows:
        fp = p if p.is_absolute() else STD_DIR / p.name
        file_ver, err = last_rev_in_file(fp)
        if err: yellows.append(f'[{stem}] {err}（跳过比对）'); continue
        if idx_ver and file_ver and file_ver != idx_ver:
            reds.append(f'[{stem}] 文件修订记录最新 v{file_ver} ≠ 索引 v{idx_ver}')
    for sk, ln, name, rv, iv in scan_skills(rows):
        if iv == '未登记': yellows.append(f'[{sk}:{ln}] 引用"{name} v{rv}"未登记（人工判）')
        elif rv != iv: yellows.append(f'[{sk}:{ln}] 引用"{name} v{rv}" ≠ 索引 v{iv}（人工判：或为历史表述）')
    for r in reds: print('红｜' + r)
    for y in yellows: print('黄｜' + y)
    print(f'结论：红 {len(reds)} 项，黄 {len(yellows)} 项' + ('（红≠0 → exit 1）' if reds else ''))
    sys.exit(1 if reds else 0)

if __name__ == '__main__':
    main()
