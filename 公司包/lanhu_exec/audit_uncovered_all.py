# -*- coding: utf-8 -*-
"""
audit_uncovered_all.py — 漏采审计全量驱动：对一批需求文档逐份跑 lanhu_uncovered_audit.js（在线）。

查什么：页面上看得见、但文档里既没有文字、也没落在任何截图范围内的内容（短标签、小面板里的字、
没人管的表单控件…）。四道闸门都不查这一类：对账器只核 ≥6 字的文字件、且豁免面板内内容；忠实闸只查"改没改"。
全量入库前必跑（采集标准 v1.3 R14 ⑥）：无覆盖 / 表内漏 / 面板缺图 / 栏外控件 四项须全为 0。

用法：
  python audit_uncovered_all.py --stage <暂存根目录> [--shard k/N] [--start-port 9334]
        逐个读 <stage>/state/NN.json，对每份暂存文档跑审计，结果落 <stage>/audit_NN.json，每份打印一行结论。
        多路并行：开 N 个进程 --shard 0/N … (N-1)/N，各给不同 --start-port；每个进程输出重定向到各自的日志文件。
"""
import argparse, glob, io, json, os, shutil, subprocess, sys

LE = os.path.dirname(os.path.abspath(__file__))
JT = os.path.normpath(os.path.join(LE, '..', 'jt_exec'))
BASH = shutil.which('bash')

ap = argparse.ArgumentParser(description='蓝湖需求文档漏采审计（全量）')
ap.add_argument('--stage', required=True, help='batch_recollect.py 的暂存根目录（读 state/NN.json）')
ap.add_argument('--shard', default='', help='k/N：本进程处理第 k 份起每隔 N 份的菜单')
ap.add_argument('--start-port', default='9334')
a = ap.parse_args()

states = []
for f in glob.glob(os.path.join(a.stage, 'state', '*.json')):
    states.append(json.load(io.open(f, encoding='utf-8')))
states.sort(key=lambda s: s['idx'])
if a.shard:
    k, n = (int(x) for x in a.shard.split('/'))
    states = states[k::n]

tot = {'bad': 0, 'leaves': 0, 'uncovered': 0, 'gap': 0, 'outside': 0, 'panel_missing': 0, 'failed': 0}
for st in states:
    md = os.path.join(a.stage, '%02d' % st['idx'], st['new'])
    if not os.path.exists(md):
        continue
    out = os.path.join(a.stage, 'audit_%02d.json' % st['idx'])
    log = os.path.join(a.stage, 'audit_%02d.log' % st['idx'])
    if os.path.exists(out):
        os.remove(out)
    with open(log, 'wb') as lf:                       # pool_run 输出一律落文件，不接管道
        subprocess.run([BASH, os.path.join(JT, 'pool_run.sh'), os.path.join(LE, 'lanhu_uncovered_audit.js'),
                        '--doc', md, '--menu', st['menu'], '--out', out],
                       stdout=lf, stderr=subprocess.STDOUT, env=dict(os.environ, POOL_START=a.start_port), timeout=300)
    if not os.path.exists(out):
        tot['failed'] += 1
        print('[%02d] %-30s 审计未产出（见日志 %s）' % (st['idx'], st['menu'][:30], os.path.basename(log)), flush=True)
        continue
    r = json.load(io.open(out, encoding='utf-8'))
    c = r['classes']
    bad = len(r['UNCOVERED']) + len(r['GAP_table']) + c.get('control_outside', 0) + (r['panelMissing'] if r['panelMissing'] > 0 else 0)
    tot['bad'] += 1 if bad else 0
    tot['leaves'] += r['leaves']
    tot['uncovered'] += len(r['UNCOVERED']); tot['gap'] += len(r['GAP_table'])
    tot['outside'] += c.get('control_outside', 0); tot['panel_missing'] += max(0, r['panelMissing'])
    print('[%02d] %-30s 页面可见项 %4d；无文字的 %3d 项去向：查询带截图 %d / 面板截图 %d / 图内 %d / 隐形 %d / 零星单控件 %d ｜ 表内漏 %d / 无覆盖 %d / 栏外控件 %d / 面板缺图 %d  %s' % (
        st['idx'], st['menu'][:30], r['leaves'], sum(v for k2, v in c.items() if k2 not in ('GAP_table', 'control_outside', 'UNCOVERED')),
        c.get('band', 0), c.get('panel', 0), c.get('diagram', 0), c.get('hidden', 0), c.get('control_single', 0),
        len(r['GAP_table']), len(r['UNCOVERED']), c.get('control_outside', 0), r['panelMissing'], 'OK' if not bad else '**需看**'), flush=True)
    if bad:
        for x in r['UNCOVERED'][:4]:
            print('        无覆盖：%s（y=%s x=%s）' % (x['t'][:40], x['top'], x['left']), flush=True)
        for x in r['GAP_table'][:4]:
            print('        表内漏：%s' % x['t'][:50], flush=True)
print('合计 %d 份：有遗漏 %d 份；可见项 %d → 无覆盖 %d / 表内漏 %d / 栏外控件 %d / 面板缺图 %d；审计失败 %d 份' % (
    len(states), tot['bad'], tot['leaves'], tot['uncovered'], tot['gap'], tot['outside'], tot['panel_missing'], tot['failed']), flush=True)
sys.exit(0 if (tot['bad'] == 0 and tot['failed'] == 0) else 1)
