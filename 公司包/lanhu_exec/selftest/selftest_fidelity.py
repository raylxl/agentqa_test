# -*- coding: utf-8 -*-
"""lanhu_fidelity.py（文字忠实闸）自检：假文档必须全部判红、真文档必须判绿。
改过 lanhu_fidelity.py 的判据后必跑（采集标准 R14a：改判据必配反向用例）。
用法：python selftest/selftest_fidelity.py        退出码 0=全部符合预期
样例全部是合成的虚构数据（build_fixtures.py 生成，不含任何真实需求内容）。
假文档都是用真文档故意改坏的，而且改得"像真的"（用页面上现成的词），所以才能检验判据是不是真的严。
每个假文档还要求是**因为"疑似改写/自撰"那一项**判红的（不能只靠"字不在页面字集里"这类旁证碰巧拦住）。"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, '..', 'lanhu_fidelity.py')
FX = os.path.join(HERE, 'fixtures')
SRC = os.path.join(FX, 'src_synthetic_leaves_text.txt')

CASES = [  # (文件, 期望: '红' | '绿', 说明)
    ('real_synthetic.md', '绿', '真文档（阳性对照）：工具栏行、按钮格、上下两行格、九行长段'),
    ('f1_repeat_word.md', '红', '同一条工具栏里四个状态词换成重复的另一个状态词'),
    ('f2_page_words_fake_line.md', '红', '插入一行全由页面上的词拼成的假规则'),
    ('f3_rewrite_word.md', '红', '九行长段里"必填"改成"选填"（"选"字页面上别处没有——另有 ④ 兜着，但 ① 也必须报）'),
    ('f4_reorder.md', '红', '九行长段里两个短语调换顺序（用到的字页面上都有，只能靠 ①）'),
    ('f5_swap_word.md', '红', '同一行里三个不同的词换成重复的另一个页面词'),
    ('f6_self_written.md', '红', '插入一句页面上没有的自撰规则'),
    ('f7_stacked_unrelated.md', '红', '一格里两行都是页面真话，但取自毫不相干的位置'),
    ('f8_stacked_reversed.md', '红', '一格里上下两行顺序颠倒'),
]
if not os.path.exists(SRC):
    sys.exit('样例缺失：先跑 python selftest/build_fixtures.py')
bad = 0
for f, expect, note in CASES:
    r = subprocess.run([sys.executable, GATE, '--doc', os.path.join(FX, f), '--src', SRC], capture_output=True, text=True, encoding='utf-8', errors='replace')
    got = '绿' if r.returncode == 0 else '红'
    reds = [l.strip() for l in r.stdout.splitlines() if '[①疑似改写' in l]
    ok = got == expect and (expect == '绿' or bool(reds))
    bad += 0 if ok else 1
    print('%s %-28s 期望=%s 实得=%s  %s%s' % ('✓' if ok else '✗', f, expect, got, note, ('' if (ok or not reds) else '  ← ' + reds[0][:70])))
print('\n自检%s：%d/%d 符合预期' % ('通过' if not bad else '未通过', len(CASES) - bad, len(CASES)))
sys.exit(0 if not bad else 1)
