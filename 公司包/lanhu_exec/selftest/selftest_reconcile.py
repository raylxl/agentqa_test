# -*- coding: utf-8 -*-
"""lanhu_reconcile.js（对账器）自检（在线：经浏览器池连蓝湖）：5 份故意改坏的文档必须全部判红，且拦住的原因要对。
改过 lanhu_reconcile.js 的判据后必跑（采集标准 R14a：改判据必配反向用例）。

假文档不进仓库：运行时从本地暂存区（batch_recollect.py 的 --stage 目录）里**现场**拿已采集的真文档来改坏，
改完放系统临时目录，跑完即删——仓库里只留"怎么改坏"，不留任何需求内容。

用法：
  python selftest/selftest_reconcile.py --stage <暂存根目录> [--port 9334]      退出码 0=全部符合预期
  （暂存目录里须至少有一份带 3 行以上表格的文档、一份带"带标注连线"流程图的文档；构造不出来会判未通过，不会静默放行）

改坏方式与应报的原因：
  m1 删掉文档里第一张表            → 蓝湖表未入文档
  m2 把该表表头每个单元格改字       → 蓝湖表未入文档
  m3 删掉该表最后两行数据          → 覆盖缺失（missing > 0）
  m4 流程图一条连线标注的末尾加字   → 流程图标签未溯源
  m5 删掉流程图一条连线            → 节点/连线数"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
LE = os.path.normpath(os.path.join(HERE, '..'))
JT = os.path.normpath(os.path.join(LE, '..', 'jt_exec'))
ap = argparse.ArgumentParser()
ap.add_argument('--stage', required=True, help='batch_recollect.py 的暂存根目录（读 state/NN.json 与各菜单文档）')
ap.add_argument('--port', default='9334', help='池起始端口（POOL_START）')
a = ap.parse_args()
BASH = shutil.which('bash')

docs = []                                            # [(菜单名, 文档绝对路径)]
for f in sorted(os.listdir(os.path.join(a.stage, 'state'))):
    if not f.endswith('.json'):
        continue
    st = json.load(open(os.path.join(a.stage, 'state', f), encoding='utf-8'))
    p = os.path.join(a.stage, '%02d' % st['idx'], st['new'])
    if os.path.isfile(p) and st.get('state') == 'ok':
        docs.append((st['menu'], p, st['new']))
if not docs:
    sys.exit('暂存目录里没有已通过的文档：%s' % a.stage)


def first_table(L):
    """返回 (表头行号, 表尾行号)：第一张 ≥3 行（表头+分隔+≥1 数据行）的 MD 表"""
    i = 0
    while i < len(L):
        if L[i].lstrip().startswith('|'):
            j = i
            while j < len(L) and L[j].lstrip().startswith('|'):
                j += 1
            if j - i >= 4 and i > 2 and not any('<br>' in x and '优化点' in x for x in L[i:j]):
                return i, j
            i = j
        else:
            i += 1
    return None


def flow_edge(L):
    """返回第一条"带标注连线"的行号（nX -->|"标注"| nY）"""
    inf = False
    for i, l in enumerate(L):
        if l.strip().startswith('```'):
            inf = not inf
            continue
        if inf and re.match(r'^\s*n\d+ -->\|"[^"]+"\| n\d+\s*$', l):
            return i
    return None


tmp = tempfile.mkdtemp(prefix='lanhu_selftest_')
cases = []                                           # (假文档路径, 菜单, 期望原因, 说明)
tb_menu = flow_menu = None
for menu, p, name in docs:
    L = open(p, encoding='utf-8').read().split('\n')
    if tb_menu is None and first_table(L):
        h, e = first_table(L)
        cells = [c.strip() for c in L[h].strip().strip('|').split('|')]
        tag = re.sub(r'[^\w\u4e00-\u9fff]+', '_', name)[:40]
        def w(mut, suffix, lines):
            q = os.path.join(tmp, '%s_%s.md' % (tag, suffix))
            open(q, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
            cases.append((q, menu, mut, suffix))
        w('蓝湖表未入文档', 'm1_del_table', L[:h] + L[e:])
        w('蓝湖表未入文档', 'm2_header', L[:h] + ['| ' + ' | '.join('改坏的表头%s' % ('甲乙丙丁戊己庚辛壬'[k % 10]) for k in range(len(cells))) + ' |'] + L[h + 1:])
        w('missing', 'm3_rows', L[:e - 2] + L[e:] if e - 2 > h + 2 else L[:h + 3] + L[e:])
        tb_menu = menu
    if flow_menu is None and flow_edge(L) is not None:
        i = flow_edge(L)
        tag = re.sub(r'[^\w\u4e00-\u9fff]+', '_', name)[:40]
        q = os.path.join(tmp, '%s_m4_label.md' % tag)
        M = L[:]; M[i] = re.sub(r'"\| n(\d+)\s*$', '改"| n\\1', M[i])
        open(q, 'w', encoding='utf-8', newline='\n').write('\n'.join(M)); cases.append((q, menu, '流程图标签未溯源', 'm4_label'))
        q = os.path.join(tmp, '%s_m5_edge.md' % tag)
        open(q, 'w', encoding='utf-8', newline='\n').write('\n'.join(L[:i] + L[i + 1:])); cases.append((q, menu, '节点/连线数', 'm5_edge'))
        flow_menu = menu
    if tb_menu and flow_menu:
        break

missing_kind = [k for k in ('m1', 'm2', 'm3') if not any(c[3].startswith(k) for c in cases)] + \
               [k for k in ('m4', 'm5') if not any(c[3].startswith(k) for c in cases)]
if missing_kind:
    shutil.rmtree(tmp, ignore_errors=True)
    sys.exit('暂存文档里构造不出这些假文档：%s（需要一份带 ≥3 行表格的文档、一份带"带标注连线"流程图的文档）——自检无法进行，按未通过处理' % missing_kind)

bad = 0
try:
    for doc, menu, expect, suffix in cases:
        log = os.path.join(tmp, suffix + '.log')
        with open(log, 'wb') as lf:                   # pool_run 输出一律落文件，不接管道
            subprocess.run([BASH, os.path.join(JT, 'pool_run.sh'), os.path.join(LE, 'lanhu_reconcile.js'), '--doc', doc, '--menu', menu],
                           stdout=lf, stderr=subprocess.STDOUT, env=dict(os.environ, POOL_START=a.port), timeout=400)
        t = open(log, encoding='utf-8', errors='replace').read()
        i = t.find('\n{\n  "menu"')
        if i < 0:
            print('✗ %-14s 对账器没产出结果（自身报错，不算拦住）：%s' % (suffix, t[-160:].replace('\n', ' ')))
            bad += 1
            continue
        r = json.JSONDecoder().raw_decode(t[i + 1:])[0]   # 结果 JSON 后面还有 pool_run 的收尾行，不能用 loads
        reasons = [x.get('kind', '') for x in (r['tables'].get('issues') or [])] + [x.get('kind', '') for x in (r['flow'].get('issues') or [])]
        hit = (r['VERDICT'] == 'RED') and (expect in reasons or (expect == 'missing' and r['missingCount'] > 0))
        bad += 0 if hit else 1
        print('%s %-14s %s｜应报「%s」← 实报：%s' % ('✓' if hit else '✗', suffix, r['VERDICT'], expect,
                                                  '；'.join(dict.fromkeys(reasons))[:80] or ('覆盖缺失 %d' % r['missingCount'])), flush=True)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print('\n自检%s：%d/%d 符合预期' % ('通过' if not bad else '未通过', len(cases) - bad, len(cases)))
sys.exit(0 if not bad else 1)
