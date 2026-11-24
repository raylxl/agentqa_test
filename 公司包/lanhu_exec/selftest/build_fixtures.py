# -*- coding: utf-8 -*-
"""生成文字忠实闸自检用的合成样例（全部虚构，不含任何真实需求内容）。

页面原文 src_synthetic.txt 模仿采集器落盘的 leaves_text.txt 行式：y|x|tag|||text（y、x 为页面坐标像素）。
它刻意凑齐了判据要区分的几种版面：
  · 查询工具栏一行：分页器 "30 99+ 4"（y=306）与一排筛选项（y=320）同一条工具栏
  · 表格里的一格：数据 "示例省" 与三个行按钮（控件值）同一行
  · 表格里的一格：上下两行（y 差 23px），中间隔着别的列的一行
  · 正文长段：页面上是连续三行（每行一个文字件）
真文档 real_synthetic.md 是它的忠实搬运；假文档 f1~f8 各用一种"像真的"的方式改坏。
用法：python selftest/build_fixtures.py"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FX = os.path.join(HERE, 'fixtures')
os.makedirs(FX, exist_ok=True)

SRC = """70|0|span|||一、背景说明
90|0|span|||本页用于自检，所有文字均为虚构。
306|1019|span|||30
306|1073|span|||99+
306|1209|span|||4
320|195|span|||全部
320|195|span|||全部
320|259|span|||甲线
320|259|span|||甲一
320|323|span|||甲二
320|387|span|||乙线
320|603|span|||全部
320|667|span|||未归档
320|731|span|||已归档
320|909|span|||全部
320|973|span|||待发送
320|1037|span|||发送中
320|1101|span|||发送成功
320|1165|span|||发送失败
320|1231|span|||免发送
560|0|span|||二、规则
578|0|span|||序号
578|100|span|||区域类型
578|300|span|||区域
578|700|span|||操作
599|18|span|||1
599|100|span|||省份
599|300|span|||示例省
599|700|input|||查看
599|740|input|||改动
599|780|input|||留痕
620|18|span|||2
620|100|span|||城市
620|300|span|||示例市
641|18|span|||3
641|100|span|||备注
641|300|span|||第一行说明
650|900|span|||夹在中间的一行
664|300|span|||第二行说明
700|0|span|||1、接口说明：调用方传入日期、网点、地址等参数，
716|0|span|||渠道、网点、地址三项均为必填，缺一项即拒绝。
732|0|span|||返回匹配到的结果列表。
748|0|span|||匹配不到时返回空列表，不报错。
764|0|span|||结果按日期倒序排列。
780|0|span|||单次最多返回两百条。
796|0|span|||超出部分需要分页获取。
812|0|span|||分页从第一页开始，页码从一计。
828|0|span|||每页条数可指定，默认二十条。
"""

TOOLBAR = '30 99+ 4 全部 全部 甲线 甲一 甲二 乙线 全部 未归档 已归档 全部 待发送 发送中 发送成功 发送失败 免发送'
PARA = ('1、接口说明：调用方传入日期、网点、地址等参数， 渠道、网点、地址三项均为必填，缺一项即拒绝。 返回匹配到的结果列表。 '
        '匹配不到时返回空列表，不报错。 结果按日期倒序排列。 单次最多返回两百条。 超出部分需要分页获取。 分页从第一页开始，页码从一计。 每页条数可指定，默认二十条。')
HEAD = ['# 蓝湖需求（文本保真版）— 自检样例', '', '> 采集时间: 2026-11-24 | 合成数据，全部虚构', '', '一、背景说明', '本页用于自检，所有文字均为虚构。', '']
TABLE = ['| 序号 | 区域类型 | 区域 | 操作 |', '| --- | --- | --- | --- |',
         '| 1 | 省份 | 示例省 | 查看 改动 留痕 |', '| 2 | 城市 | 示例市 |  |', '| 3 | 备注 | 第一行说明<br>第二行说明 |  |']
TAIL = ['', '夹在中间的一行', '', '二、规则', '', PARA, '']
REAL = HEAD + [TOOLBAR, ''] + TABLE + TAIL


def swap(text, old, new):
    assert text.count(old) == 1, (old, text.count(old))
    return text.replace(old, new)


MUT = {
    # 同一条工具栏里四个状态词换成重复的另一个状态词（每个词页面上都有）
    'f1_repeat_word.md': swap(REAL and '\n'.join(REAL), '待发送 发送中 发送成功 发送失败', '发送失败 发送失败 发送失败 发送失败'),
    # 插入一行全由页面上的词拼成的假规则
    'f2_page_words_fake_line.md': swap('\n'.join(REAL), '\n二、规则\n', '\n全部 发送失败 免发送 已归档 未归档 30 99+ 4 全部\n\n二、规则\n'),
    # 长段里改一个词（"必填"→"选填"）
    'f3_rewrite_word.md': swap('\n'.join(REAL), '三项均为必填', '三项均为选填'),
    # 长段里两个短语调换顺序
    'f4_reorder.md': swap('\n'.join(REAL), '渠道、网点、地址三项均为必填，缺一项即拒绝。', '缺一项即拒绝，渠道、网点、地址三项均为必填。'),
    # 同一行里三个不同的词换成重复的另一个页面词
    'f5_swap_word.md': swap('\n'.join(REAL), '甲线 甲一 甲二', '乙线 乙线 乙线'),
    # 插入一句页面上没有的自撰规则
    'f6_self_written.md': swap('\n'.join(REAL), '\n二、规则\n', '\n二、规则\n\n系统应当在每日凌晨自动重算全部数据。\n'),
    # 一格里两行都是页面上的真话，但取自页面上毫不相干的位置（y 相差 279px）
    'f7_stacked_unrelated.md': swap('\n'.join(REAL), '| 3 | 备注 | 第一行说明<br>第二行说明 |  |', '| 3 | 备注 | 甲线<br>示例省 |  |'),
    # 一格里上下两行顺序颠倒（第二行在上）
    'f8_stacked_reversed.md': swap('\n'.join(REAL), '| 3 | 备注 | 第一行说明<br>第二行说明 |  |', '| 3 | 备注 | 第二行说明<br>第一行说明 |  |'),
}

with open(os.path.join(FX, 'src_synthetic_leaves_text.txt'), 'w', encoding='utf-8', newline='\n') as f:
    f.write(SRC)
with open(os.path.join(FX, 'real_synthetic.md'), 'w', encoding='utf-8', newline='\n') as f:
    f.write('\n'.join(REAL))
for name, text in MUT.items():
    with open(os.path.join(FX, name), 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
print('已生成 %d 个文件：%s' % (2 + len(MUT), ', '.join(sorted(os.listdir(FX)))))
