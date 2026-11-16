# -*- coding: utf-8 -*-
"""
竖排→横排 用例格式统一转换脚本 v1.0
====================================
把竖排五列（每字段一行 | label | value |）转成横排五列（表头+分隔+单数据行）。
用法: python conv_v2h.py <分章目录>  (处理目录下所有 NN_*.md 文件，自动备份 .bak_v2h)
"""
import re, os, sys, io, glob

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# 字段标签匹配（按优先级，支持加粗/不加粗/含空格）
LABELS = ['前置条件', '操作步骤', '预期结果', '判断依据', '测试方法']
LABEL_ALT = {
    '前置条件': ['前置条件', '前置'],
    '操作步骤': ['操作步骤', '步骤', '测试步骤'],
    '预期结果': ['预期结果', '预期'],
    '判断依据': ['判断依据', '依据', '判定依据'],
    '测试方法': ['测试方法', '方法'],
}

def norm_label(text):
    """标准化字段标签（去加粗/冒号/空格）"""
    t = text.strip().strip('*').strip()
    for std, alts in LABEL_ALT.items():
        for alt in alts:
            if t.startswith(alt):
                return std
    return None

def extract_value(line):
    """从 | label | value | 行提取 value"""
    # 去掉首尾 |
    parts = line.strip().strip('|').split('|')
    if len(parts) >= 2:
        label = norm_label(parts[0])
        value = '|'.join(parts[1:]).strip()
        return label, value
    return None, None

def is_vertical_block(lines, start_idx):
    """检测从 start_idx 开始的块是否为竖排格式"""
    found = set()
    for i in range(start_idx, min(start_idx + 15, len(lines))):
        line = lines[i].strip()
        if not line.startswith('|'):
            if found:
                break
            continue
        parts = line.strip('|').split('|')
        if len(parts) >= 2:
            label = norm_label(parts[0])
            if label:
                found.add(label)
                if len(found) == 5:
                    return True
    return False

def convert_vertical_to_horizontal(lines, tc_start):
    """把从 tc_start 开始的一个竖排 TC 块转为横排，返回新行列表"""
    tc_line = lines[tc_start]
    
    # 收集 5 个字段值
    fields = {}
    field_lines = []  # 记录哪些行是字段行（用于删除）
    end_idx = tc_start + 1
    
    for i in range(tc_start + 1, min(tc_start + 20, len(lines))):
        line = lines[i].strip()
        if line.startswith('#### ') or line.startswith('### ') or line.startswith('## '):
            break
        if not line.startswith('|'):
            if fields:  # 已收集部分字段后遇到非 | 行，可能字段结束
                end_idx = i
                break
            continue
        parts = line.strip('|').split('|')
        if len(parts) >= 2:
            label = norm_label(parts[0])
            if label and label not in fields:
                value = '|'.join(parts[1:]).strip()
                fields[label] = value
                field_lines.append(i)
                if len(fields) == 5:
                    end_idx = i + 1
                    break
        end_idx = i + 1
    
    if len(fields) < 5:
        return None  # 无法转换
    
    # 构建横排块
    header = '| 前置条件 | 操作步骤 | 预期结果 | 判断依据 | 测试方法 |'
    sep = '| --- | --- | --- | --- | --- |'
    data = '| ' + ' | '.join(fields.get(l, '') for l in LABELS) + ' |'
    
    new_block = ['', header, sep, data, '']
    
    # 替换：tc行 + new_block + end_idx之后的行
    result = lines[:tc_start + 1] + new_block + lines[end_idx:]
    return result

def convert_file(filepath, dry_run=False):
    """转换单个文件，返回统计"""
    content = io.open(filepath, encoding='utf-8').read()
    lines = content.split('\n')
    
    converted = 0
    skipped = 0
    already_h = 0
    
    i = 0
    new_lines = []
    while i < len(lines):
        if lines[i].startswith('#### TC-'):
            # 检测是否已是横排（下一非空行是表头行）
            j = i + 1
            while j < len(lines) and lines[j].strip() == '':
                j += 1
            if j < len(lines) and '| 前置条件 | 操作步骤 |' in lines[j]:
                already_h += 1
                new_lines.append(lines[i])
                i += 1
                continue
            
            # 尝试竖排转换
            if is_vertical_block(lines, i):
                result = convert_vertical_to_horizontal(lines, i)
                if result:
                    # result[0:i+1] 是到 TC 行为止的部分
                    # result 中 TC 行之后是新块，然后是 end_idx 之后的行
                    # 我们需要找到新块的结尾位置
                    # 简单方法：直接用 result，然后跳到 i + (原end_idx - i) 处
                    # 但 result 已经是完整替换，所以我们把 i 设为原 end_idx 位置
                    
                    # 计算 end_idx：原块占了多少行
                    # 找到 fields 收集的最后一行的下一行
                    # 实际上 convert_vertical_to_horizontal 返回了完整新行列表
                    # 但我们只需要知道从哪里继续
                    
                    # 更简单的方法：重新扫描
                    # 找到 TC 行后 5 个字段行的最后位置
                    field_count = 0
                    last_field = i
                    for k in range(i + 1, min(i + 20, len(lines))):
                        line = lines[k].strip()
                        if line.startswith('|'):
                            parts = line.strip('|').split('|')
                            if len(parts) >= 2:
                                label = norm_label(parts[0])
                                if label:
                                    field_count += 1
                                    last_field = k
                                    if field_count == 5:
                                        break
                        elif not line.startswith('|') and field_count >= 3:
                            # 可能块结束
                            last_field = k - 1
                            break
                    
                    # 构建新块
                    fields = {}
                    for k in range(i + 1, last_field + 1):
                        line = lines[k].strip()
                        if line.startswith('|'):
                            parts = line.strip('|').split('|')
                            if len(parts) >= 2:
                                label = norm_label(parts[0])
                                if label and label not in fields:
                                    fields[label] = '|'.join(parts[1:]).strip()
                    
                    header = '| 前置条件 | 操作步骤 | 预期结果 | 判断依据 | 测试方法 |'
                    sep = '| --- | --- | --- | --- | --- |'
                    data = '| ' + ' | '.join(fields.get(l, '') for l in LABELS) + ' |'
                    
                    new_lines.append(lines[i])  # TC 标题行
                    new_lines.append('')
                    new_lines.append(header)
                    new_lines.append(sep)
                    new_lines.append(data)
                    new_lines.append('')
                    
                    converted += 1
                    i = last_field + 1
                    continue
                else:
                    skipped += 1
                    new_lines.append(lines[i])
                    i += 1
                    continue
            else:
                skipped += 1
                new_lines.append(lines[i])
                i += 1
                continue
        else:
            new_lines.append(lines[i])
            i += 1
    
    if converted > 0 and not dry_run:
        # 备份
        bak = filepath + '.bak_v2h'
        io.open(bak, 'w', encoding='utf-8').write(content)
        # 写入新内容
        io.open(filepath, 'w', encoding='utf-8').write('\n'.join(new_lines))
    
    return converted, skipped, already_h

def main():
    if len(sys.argv) < 2:
        print('用法: python conv_v2h.py <分章目录> [--dry-run]')
        sys.exit(1)
    
    directory = sys.argv[1]
    dry_run = '--dry-run' in sys.argv
    
    files = sorted(glob.glob(os.path.join(directory, '*.md')))
    # 匹配所有含 TC- 的分章文件（排除 _ 开头工具文件、00_BRIEF、99_附录）
    files = [f for f in files if not os.path.basename(f).startswith(('_','00_','99_')) and 'TC-' in io.open(f, encoding='utf-8').read()[:5000]]
    
    if not files:
        print(f'!! 目录无分章文件: {directory}')
        sys.exit(1)
    
    total_converted = 0
    total_skipped = 0
    total_already = 0
    
    for filepath in files:
        fn = os.path.basename(filepath)
        conv, skip, already = convert_file(filepath, dry_run)
        total_converted += conv
        total_skipped += skip
        total_already += already
        status = 'DRY' if dry_run else 'DONE'
        print(f'  {fn}: 转换{conv} 跳过{skip} 已横排{already} [{status}]')
    
    print(f'\n合计: 转换={total_converted} 跳过={total_skipped} 已横排={total_already}')
    if total_skipped > 0:
        print(f'⚠ 有 {total_skipped} 条未转换（格式不识别），需人工检查')
    if not dry_run and total_converted > 0:
        print(f'✅ 已写入并备份 .bak_v2h')

if __name__ == '__main__':
    main()
