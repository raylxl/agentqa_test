# -*- coding: utf-8 -*-
r"""横表五列 → 竖排五字段行 转换器（usecase-pipeline skill 配套）

将分章文件中每个用例块的横表（表头 | 前置条件 | 操作步骤 | 预期结果 | 判断依据 | 测试方法 | + 分隔 + 单数据行）
转换为独立定稿 §1 主形态竖排：
    | 列 | 内容 |
    | --- | --- |
    | 前置条件 | … |
    | 操作步骤 | … |
    | 预期结果 | … |
    | 判断依据 | … |
    | 测试方法 | … |
并把章/节标题末尾的计数规整为「（N 条）」（TC 范围式/纯数字/缺失 → 实际条数），满足 §11 L2 取数。
用法：python convert_h2v.py --dir <分章目录> [--dry-run]
"""
import re, os, glob, argparse, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

tc_re = re.compile(r'^####\s+TC[-_]')
HDR = '| 前置条件 | 操作步骤 | 预期结果 | 判断依据 | 测试方法 |'
LABELS = ['前置条件', '操作步骤', '预期结果', '判断依据', '测试方法']
# 节头尾部可替换的计数括号：TC 范围式 / 纯数字 / ??条 / N条
tail_re = re.compile(r'（(?:TC[-_][^）]*|\d+|\?\?\s*条|\d+\s*条)）\s*$')

def convert_file(path, dry):
    lines = open(path, encoding='utf-8').read().splitlines()
    out, i, n_conv = [], 0, 0
    while i < len(lines):
        l = lines[i]
        if tc_re.match(l):
            # 期望：标题, (空行), 表头, 分隔, 数据行
            j = i + 1
            while j < len(lines) and lines[j].strip() == '': j += 1
            if j < len(lines) and lines[j].strip().startswith(HDR):
                k = j + 1
                if k < len(lines) and re.match(r'^\|\s*-{3,}', lines[k].strip()):
                    d = k + 1
                    if d < len(lines) and lines[d].strip().startswith('|'):
                        cells = lines[d].strip().split('|')[1:-1]
                        if len(cells) == 5:
                            out.append(l); out.append('')
                            out.append('| 列 | 内容 |'); out.append('| --- | --- |')
                            for lab, c in zip(LABELS, cells):
                                out.append(f'| {lab} | {c.strip()} |')
                            n_conv += 1
                            i = d + 1
                            continue
            out.append(l); i += 1; continue
        out.append(l); i += 1
    # 第二遍：规整章/节计数
    res, sec_idx, sec_cnt = [], None, 0
    def tc_count(start):
        c = 0
        for x in range(start + 1, len(out)):
            if out[x].startswith('## ') or out[x].startswith('### '): break
            if tc_re.match(out[x]): c += 1
        return c
    total = sum(1 for x in out if tc_re.match(x))
    for idx, l in enumerate(out):
        if l.startswith('## '):
            base = tail_re.sub('', l).rstrip()
            res.append(f'{base}（{total} 条）')
        elif l.startswith('### '):
            base = tail_re.sub('', l).rstrip()
            res.append(f'{base}（{tc_count(idx)} 条）')
        else:
            res.append(l)
    if not dry:
        open(path, 'w', encoding='utf-8').write('\n'.join(res) + '\n')
    return n_conv, total

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True); ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    files = sorted(f for f in glob.glob(os.path.join(a.dir, '*.md')) if re.match(r'^\d{2}_', os.path.basename(f)))
    g = 0
    for f in files:
        n, t = convert_file(f, a.dry_run); g += n
        print(f'{os.path.basename(f)}: 转换 {n} / 用例 {t}')
    print(f'合计转换 {g} 条' + ('（dry-run 未写回）' if a.dry_run else ''))

if __name__ == '__main__':
    main()
