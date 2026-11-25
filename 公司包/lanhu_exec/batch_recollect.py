#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
batch_recollect.py — 蓝湖需求文档批量重采驱动（采集标准 v1.2 · 四道闸门 · 断点续传 · 先暂存后入库）

用法:
  python batch_recollect.py run    --config "<菜单配置 md>" --stage <暂存根目录>
                                    [--lib <权威库目录>] [--hist <历史版本目录>]
                                    [--shard k/N] [--start-port 9334] [--only "关键字|关键字"] [--skip "行序号|关键字"]
                                    [--rerun-ok] [--no-retry-fail] [--gates-only]
  python batch_recollect.py land   --config "<菜单配置 md>" --stage <暂存根目录> [--apply] [--force "序号|序号"]
  python batch_recollect.py report --config "<菜单配置 md>" --stage <暂存根目录>
  python batch_recollect.py check  --doc "<需求文档 md>"      # 单份文档结构体检（正文非空、章节标题不在表格单元格里）

run   逐菜单：①collect（池化，内置 GATE）②lanhu_verify ③lanhu_fidelity ④lanhu_reconcile（池化，须 GREEN 且 coverage=1）
      → 四道全绿记 ok，并做"变薄探源"初筛（新旧正文字数比 < 0.85 标 thin，入库前须人工看一眼）；
        任一红记 fail，不中断，续下一个。单菜单状态落 <stage>/state/NN.json（终态只增不覆盖：重跑跳过 ok，fail 默认重试）。
land  只动 ok 的菜单：旧版 md + _images 移入 <hist>/全量重采前_<日期>/，新版自暂存拷入权威库；库内/归档内同名即中止该菜单。
      默认只打印计划，--apply 才真动。thin 的默认不动，--force 指定序号才动。
report 汇总各菜单状态、变薄比、新旧文字差异（蓝湖新增 / 旧文档独有），写 <stage>/report.json 与 report.md。

约束：
  - 权威库只在 land 阶段被改动；run 阶段只写暂存目录。
  - 池化命令输出一律落文件（执行坑库 G98：pool_run 输出不能接管道）。
"""
import argparse, datetime, hashlib, json, os, re, shutil, subprocess, sys, time

HERE = os.path.normpath(os.path.dirname(os.path.abspath(__file__)))
JT_EXEC = os.path.normpath(os.path.join(HERE, '..', 'jt_exec'))
POOL_RUN = os.path.join(JT_EXEC, 'pool_run.sh')
COLLECT = os.path.join(HERE, 'collect_lanhu_req.js')
RECONCILE = os.path.join(HERE, 'lanhu_reconcile.js')
VERIFY = os.path.join(HERE, 'lanhu_verify.py')
FIDELITY = os.path.join(HERE, 'lanhu_fidelity.py')
CACHE = os.path.join(HERE, 'out', 'collect_cache')

ROW_RE = re.compile(
    r'^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|'
    r'\s*(财务需求\d{4}_[^|]+?\.md)\s*\|\s*([^|]+?)\s*\|\s*$')
THIN_RATIO = 0.85
POOL_TIMEOUT = 600


def now():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


# ───────────────────────── 菜单配置解析 ─────────────────────────
def load_rows(config):
    rows = []
    for ln in open(config, encoding='utf-8').read().splitlines():
        m = ROW_RE.match(ln)
        if m:
            # 配置表的"序号"按模块重新起算（快运 1~23、云仓 1~27…），不唯一；idx=全表行序，用于状态文件与暂存目录
            rows.append({'no': int(m.group(1)), 'idx': len(rows) + 1, 'module': m.group(2), 'menu': m.group(3),
                         'status': m.group(4), 'note': m.group(5), 'fname': m.group(6), 'date': m.group(7)})
    if not rows:
        sys.exit('菜单配置里没解析到明细行：' + config)
    return rows


def next_version_name(old, lib, hist):
    """旧文件名 → 新文件名（版本号 = 权威库与历史版本根目录里同前缀最大版本 + 1，防撞名）。"""
    stem = old[:-3]
    m = re.match(r'^(.*)_v(\d+)$', stem)
    if not m:
        sys.exit('文件名不符合 _vN 规范：' + old)
    pre, mx = m.group(1), int(m.group(2))
    pat = re.compile(re.escape(pre) + r'_v(\d+)\.md$')
    for d in (lib, hist):
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            mm = pat.match(f)
            if mm:
                mx = max(mx, int(mm.group(1)))
    return '%s_v%d' % (pre, mx + 1)


# ───────────────────────── 子进程 ─────────────────────────
def _read(path):
    try:
        return open(path, 'rb').read().decode('utf-8', 'replace').replace('\r\n', '\n')
    except OSError:
        return ''


def sh(cmd, log_path, env=None, timeout=POOL_TIMEOUT):
    """跑命令，输出落文件。超时杀进程树，并归还池实例（pool_run 的 trap 在被杀时不触发）。"""
    with open(log_path, 'wb') as lf:
        p = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT, env=env)
        try:
            rc = p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            subprocess.run(['taskkill', '/T', '/F', '/PID', str(p.pid)], capture_output=True)
            rc = -9
    text = _read(log_path)
    if rc == -9:
        m = re.search(r'租借 (\d+)', text)
        if m:
            subprocess.run(['node', 'browser_pool.js', 'release', m.group(1)], cwd=JT_EXEC, capture_output=True)
        text += '\n[batch] 超时 %ds，已杀进程树并归还实例 %s' % (timeout, m.group(1) if m else '?')
    return rc, text


def pool(tail, log_path, start_port):
    """pool_run 包装：实例全忙时退避重试。"""
    env = dict(os.environ, POOL_START=str(start_port))
    bash = shutil.which('bash')
    rc, text = -1, ''
    for attempt in range(4):
        rc, text = sh([bash, POOL_RUN] + tail, log_path, env=env)
        if '无空闲实例' not in text:
            break
        time.sleep(20 * (attempt + 1))
    return rc, text


def fail_lines(text, n=5):
    keep = []
    for ln in text.split('\n'):
        if re.search(r'FAIL|FATAL|Error|✗|未采信|RED|超时', ln) and 'GATE PASS' not in ln:
            s = ln.strip()
            s = re.sub(r'^\[[^\]]+\] \[\w+\] \[[\w_]+\] ', '', s)
            if s not in keep:
                keep.append(s[:160])
    return keep[:n]


def parse_result(text):
    """对账器输出里的结果 JSON（pretty-print，以 {"menu": 开头）。"""
    i = text.find('\n{\n  "menu"')
    if i < 0:
        return None
    depth = 0
    for k in range(i + 1, len(text)):
        c = text[k]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[i + 1:k + 1])
                except ValueError:
                    return None
    return None


# ───────────────────────── 文字比对（变薄探源 / 新旧差异） ─────────────────────────
def _norm(s):
    return re.sub(r'\s+', '', s)


def md_atoms(md):
    """文档文字原子：去图片行/注释/表格骨架/清单符号；流程图块取引号内标签。"""
    out, in_fence, in_comment = [], False, False
    for raw in md.splitlines():
        s = raw.strip()
        if in_comment:
            if '-->' in s:
                in_comment = False
            continue
        if s.startswith('<!--'):
            if '-->' not in s:
                in_comment = True
            continue
        if s.startswith('```'):
            in_fence = not in_fence
            continue
        if in_fence:
            out += re.findall(r'"([^"]*)"', s)
            continue
        if not s or s.startswith('!['):
            continue
        if s.startswith('|'):
            out += [c.strip() for c in s.strip('|').split('|')]
            continue
        out.append(re.sub(r'^#+\s*|^>\s*|^[-*]\s+', '', s))
    return [a for a in out if a]


def _trivial(w):
    return len(w) < 2 or re.fullmatch(r'[\d.\-:/~xX×+%=()（）\[\]【】]+', w) is not None


def text_diff(old_md, new_md, leaves_path):
    """added=蓝湖现有、旧文档里找不到的文字件；old_only=旧文档里有、新文档里找不到的词。"""
    old_atoms, new_atoms = md_atoms(old_md), md_atoms(new_md)
    old_full, new_full = _norm('§'.join(old_atoms)), _norm('§'.join(new_atoms))
    live = []  # [原文, 归一]；leaves_text.txt 行式：y|x|tag||css|text（text 自第 6 段起，内含 | 也归文本）
    if leaves_path and os.path.exists(leaves_path):
        for ln in open(leaves_path, encoding='utf-8', errors='replace').read().splitlines():
            parts = ln.split('|', 5)
            if len(parts) < 6:
                continue
            raw = '|'.join(parts[5:]).strip()
            t = _norm(raw)
            if t and t not in [x[1] for x in live]:
                live.append((raw, t))
    added = []
    for raw, t in live:
        if len(t) < 2 or t in old_full:
            continue
        words = [_norm(w) for w in re.split(r'\s+', raw) if len(_norm(w)) >= 2]
        if len(words) > 1 and all(w in old_full for w in words):
            continue  # 旧文档里按词都有，只是分件不同
        added.append(raw)
    old_only = []
    for a in old_atoms:
        for w in re.split(r'\s+', a):
            w = _norm(w)
            if _trivial(w) or w in new_full:
                continue
            # 旧文档把相邻格/相邻件拼在了一起：按标点再拆一次
            subs = [x for x in re.split(r'[，。；：、,;:（）()【】\[\]]', w) if len(x) >= 2]
            if subs and all(x in new_full for x in subs):
                continue
            if w not in old_only:
                old_only.append(w)
    return {'old_chars': len(old_full), 'new_chars': len(new_full),
            'added': added, 'old_only': old_only}


def latest_leaves(menu):
    d = os.path.join(CACHE, re.sub(r'[\\/:*?"<>|]', '_', menu))
    if not os.path.isdir(d):
        return None
    cands = sorted(os.listdir(d), reverse=True)
    for ts in cands:
        p = os.path.join(d, ts, 'leaves_text.txt')
        if os.path.exists(p):
            return p
    return None


# ───────────────────────── run ─────────────────────────
def run_menu(row, a):
    no, menu = row['idx'], row['menu']
    mdir = os.path.join(a.stage, '%02d' % no)
    logs = os.path.join(mdir, 'logs')
    os.makedirs(logs, exist_ok=True)
    # 日志名带时刻：pool_run 的心跳子进程会在脚本结束后继续占着日志文件句柄最多 300 秒（坑库 G98 的同源现象），
    # 同名覆盖虽可写，但清理时会"Device or resource busy"；带时刻则各次互不干扰，重试也有据可查
    stamp = datetime.datetime.now().strftime('%H%M%S')
    lg = lambda k: os.path.join(logs, '%s_%s.log' % (k, stamp))
    spath = os.path.join(a.stage, 'state', '%02d.json' % no)
    tries = 1
    prev = None
    if os.path.exists(spath):
        prev = json.load(open(spath, encoding='utf-8'))
        tries = int(prev.get('tries', 1)) + 1
    newbase = next_version_name(row['fname'], a.lib, a.hist)
    md = os.path.join(mdir, newbase + '.md')
    imgdir = md[:-3] + '_images'
    # --gates-only：上一轮采集与前三道闸门都过了、只差对账（如对账器误判修好后复核）——沿用暂存产物，不重采
    reuse = bool(a.gates_only and prev and prev.get('state') == 'fail' and prev.get('new') == newbase + '.md'
                 and os.path.exists(md) and os.path.isdir(imgdir)
                 and (prev.get('gates', {}).get('collect') or {}).get('rc') == 0
                 and (prev.get('gates', {}).get('verify') or {}).get('rc') == 0
                 and (prev.get('gates', {}).get('fidelity') or {}).get('rc') == 0)
    if not reuse:
        for p in (md, imgdir):  # 暂存区里上一轮的产物先清（只清暂存）
            if os.path.isdir(p):
                shutil.rmtree(p)
            elif os.path.exists(p):
                os.remove(p)
    old_path = os.path.join(a.lib, row['fname'])
    st = {'idx': no, 'menu': menu, 'module': row['module'], 'old': row['fname'], 'new': newbase + '.md',
          'start': now(), 'tries': tries, 'state': 'fail', 'reason': [], 'gates': {}}
    print('[%02d] %s 开始（第 %d 次%s）→ %s' % (no, menu, tries, '，沿用暂存产物只重跑检查' if reuse else '', st['new']), flush=True)

    if not os.path.exists(old_path):
        st['reason'] = ['权威库里找不到旧文档：' + row['fname']]
        return st

    if reuse:
        st['gates']['collect'] = prev['gates']['collect']
    else:
        t0 = time.time()
        rc, text = pool([COLLECT, '--menu', menu, '--name', newbase, '--outdir', mdir], lg('collect'), a.start_port)
        st['gates']['collect'] = {'rc': rc, 'secs': round(time.time() - t0, 1)}
        if rc != 0 or not os.path.exists(md):
            st['reason'] = ['采集 GATE 未过 rc=%d' % rc] + fail_lines(text)
            return st
        fm = re.search(r'流程图去向: (.*)', text)
        st['gates']['collect']['flow'] = fm.group(1).strip() if fm else ''

    rc, text = sh([sys.executable, VERIFY, md, imgdir], lg('verify'), timeout=120)
    st['gates']['verify'] = {'rc': rc}
    if rc != 0:
        st['reason'] = ['文件校验红'] + fail_lines(text)
        return st

    rc, text = sh([sys.executable, FIDELITY, '--doc', md, '--menu', menu], lg('fidelity'), timeout=300)
    st['gates']['fidelity'] = {'rc': rc}
    if rc != 0:
        st['reason'] = ['文字忠实闸红'] + fail_lines(text)
        return st

    t0 = time.time()
    rc, text = pool([RECONCILE, '--doc', md, '--menu', menu], lg('reconcile'), a.start_port)
    res = parse_result(text)
    st['gates']['reconcile'] = {'rc': rc, 'secs': round(time.time() - t0, 1),
                                'verdict': (res or {}).get('VERDICT'), 'coverage': (res or {}).get('coverage'),
                                'flow': (res or {}).get('flow')}
    if rc != 0 or not res or res.get('VERDICT') != 'GREEN' or res.get('coverage') != 1:
        st['reason'] = ['对账未绿'] + fail_lines(json.dumps(res, ensure_ascii=False) if res else text, 6)
        return st

    # 结构体检（离线、纯文本；2026-11-24 全量重采立）——四道闸门都没拦住的两类结构坏损，这里兜底：
    #   ① 正文为空（配送价格：页面没渲染就采了，5 行 87 字，四道闸门当时全绿）；
    #   ② 章节标题出现在表格单元格里（报价时效查询：高 539px 的正文文本框罩在小表上，被按中心点归进一格，
    #      "优化点一/优化点二"两大段成了表格内容；表头一致、行数一致、文字可溯源，四道闸门同样全绿）。
    body = open(md, encoding='utf-8').read()
    struct = structure_check(body)
    st['structure'] = struct
    if struct['bodyChars'] < 20:
        st['reason'] = ['正文为空（%d 字）——页面未渲染' % struct['bodyChars']]
        return st
    if struct['headsInCells']:
        st['reason'] = ['章节标题出现在表格单元格内（正文被吞进表格）%d 处：%s' % (len(struct['headsInCells']), struct['headsInCells'][:3])]
        return st

    td = text_diff(open(old_path, encoding='utf-8').read(), open(md, encoding='utf-8').read(), latest_leaves(menu))
    st['text'] = {'old_chars': td['old_chars'], 'new_chars': td['new_chars'],
                  'ratio': round(td['new_chars'] / td['old_chars'], 3) if td['old_chars'] else None,
                  'added': td['added'][:300], 'old_only': td['old_only'][:300]}
    st['thin'] = bool(td['old_chars'] and (td['old_chars'] - td['new_chars']) > 50
                      and td['new_chars'] / td['old_chars'] < THIN_RATIO)
    st['state'] = 'ok'
    st['end'] = now()
    return st


HEAD_IN_CELL = re.compile(r'^(优化点[一二三四五六七八九十]+[：:]|[一二三四五六七八九十]+[、）)])')


def structure_check(md):
    """文档结构体检（纯文本）：
       bodyChars  —— 去掉文档头、图片引用、表格骨架线后的正文字符数；
       headsInCells —— 表格"数据行"的单元格里出现的章节标题（格内任意一行以"优化点N："或"一、"开头且不长）。
       判据说明：章节标题在蓝湖上永远是独立成行的正文；落进表格单元格只可能是"罩在表上的文本框被归格"这类结构坏损。
       只查数据行——表头里出现"一、""二、"这类是产品给列起的序号名，属正常。"""
    lines = md.split('\n')
    body = [l for l in lines if l.strip() and not l.strip().startswith('![')
            and not re.match(r'^\|[:\-\s|]+\|\s*$', l) and not re.match(r'^#\s|^>\s*采集时间', l)]
    heads = []
    i = 0
    while i < len(lines):
        if not lines[i].strip().startswith('|'):
            i += 1
            continue
        j = i
        while j < len(lines) and lines[j].strip().startswith('|'):
            j += 1
        for k in range(i + 2, j):                 # 跳过表头与分隔行
            for cell in lines[k].strip().strip('|').split('|'):
                for part in cell.strip().split('<br>'):
                    p = part.strip()
                    if 2 <= len(p) <= 40 and HEAD_IN_CELL.match(p):
                        heads.append('L%d %s' % (k + 1, p))
        i = j
    return {'bodyChars': len(re.sub(r'\s+', '', ''.join(body))), 'headsInCells': heads}


def save(st, a):
    os.makedirs(os.path.join(a.stage, 'state'), exist_ok=True)
    tmp = spath(a, st['idx']) + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, spath(a, st['idx']))


def spath(a, no):
    return os.path.join(a.stage, 'state', '%02d.json' % no)


def load_states(a):
    out = {}
    d = os.path.join(a.stage, 'state')
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if f.endswith('.json'):
                st = json.load(open(os.path.join(d, f), encoding='utf-8'))
                out[st['idx']] = st
    return out


def cmd_run(a):
    rows = load_rows(a.config)
    if a.only:
        keys = [k for k in re.split(r'[|｜]', a.only) if k]
        rows = [r for r in rows if any(k in r['menu'] or k in r['fname'] for k in keys)]
    if a.skip:  # 全表行序号（纯数字只按序号匹配，不拿数字去匹配菜单名——菜单名里到处是迭代号）或菜单关键字
        nums = {int(k) for k in re.split(r'[|｜]', a.skip) if k.isdigit()}
        keys = [k for k in re.split(r'[|｜]', a.skip) if k and not k.isdigit()]
        rows = [r for r in rows if r['idx'] not in nums and not any(k in r['menu'] for k in keys)]
    if a.shard:
        k, n = (int(x) for x in a.shard.split('/'))
        rows = rows[k::n]
    states = load_states(a)
    print('本进程待处理 %d 个菜单（shard=%s start_port=%s）' % (len(rows), a.shard or '-', a.start_port), flush=True)
    for row in rows:
        prev = states.get(row['idx'])
        # 断点续跑：已 ok 的跳过；--rerun-ok 时全部重跑（采集器/检查代码变更后，旧产物与旧结论都不再代表现行代码）
        if (prev and prev.get('state') == 'ok' and not a.rerun_ok
                and os.path.exists(os.path.join(a.stage, '%02d' % row['idx'], prev['new']))):
            print('[%02d] %s 已是 ok，跳过' % (row['idx'], row['menu']), flush=True)
            continue
        if prev and prev.get('state') == 'fail' and a.no_retry_fail:
            print('[%02d] %s 上次 fail，按 --no-retry-fail 跳过' % (row['idx'], row['menu']), flush=True)
            continue
        try:
            st = run_menu(row, a)
        except Exception as e:  # 单菜单异常不中断
            st = {'idx': row['idx'], 'menu': row['menu'], 'module': row['module'], 'old': row['fname'],
                  'new': '', 'tries': 1, 'state': 'fail', 'reason': ['驱动异常：' + repr(e)[:200]], 'gates': {}}
        save(st, a)
        extra = ''
        if st['state'] == 'ok':
            t = st.get('text', {})
            extra = '字数比=%s 新增=%d 旧独有=%d%s' % (t.get('ratio'), len(t.get('added', [])), len(t.get('old_only', [])),
                                                ' 【变薄】' if st.get('thin') else '')
        print('[%02d] %s → %s %s %s' % (row['idx'], row['menu'], st['state'].upper(), '；'.join(st['reason'])[:300], extra), flush=True)
    print('本进程结束 %s' % now(), flush=True)


# ───────────────────────── report ─────────────────────────
def cmd_report(a):
    rows = {r['idx']: r for r in load_rows(a.config)}
    states = load_states(a)
    rep = []
    for no in sorted(rows):
        st = states.get(no)
        r = rows[no]
        item = {'no': no, 'menu': r['menu'], 'old': r['fname'], 'state': st['state'] if st else '未跑'}
        if st:
            item.update({'new': st.get('new'), 'reason': st.get('reason'), 'gates': st.get('gates'),
                         'thin': st.get('thin'), 'landed': st.get('landed'), 'text': st.get('text')})
        rep.append(item)
    json.dump(rep, open(os.path.join(a.stage, 'report.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    L = ['# 全量重采报告（%s）' % now(), '', '| 序号 | 菜单 | 状态 | 新文件 | 字数比 | 蓝湖新增 | 旧文档独有 | 原因 |', '|---|---|---|---|---|---|---|---|']
    for it in rep:
        t = it.get('text') or {}
        L.append('| %d | %s | %s%s | %s | %s | %d | %d | %s |' % (
            it['no'], it['menu'], it['state'], '（变薄）' if it.get('thin') else '', it.get('new') or '',
            t.get('ratio') if t else '', len(t.get('added', [])) if t else 0, len(t.get('old_only', [])) if t else 0,
            '；'.join(it.get('reason') or []).replace('|', '/')[:200]))
    L += ['', '## 逐菜单文字差异（蓝湖新增 / 旧文档独有；供判断"蓝湖内容是否真变了"）', '']
    for it in rep:
        t = it.get('text')
        if not t or not (t.get('added') or t.get('old_only')):
            continue
        L += ['### %d. %s' % (it['no'], it['menu']), '']
        if t.get('added'):
            L.append('- 蓝湖现有、旧文档没有（%d）：%s' % (len(t['added']), ' ｜ '.join(x[:40] for x in t['added'][:40])))
        if t.get('old_only'):
            L.append('- 旧文档有、新文档没有（%d）：%s' % (len(t['old_only']), ' ｜ '.join(x[:40] for x in t['old_only'][:40])))
        L.append('')
    open(os.path.join(a.stage, 'report.md'), 'w', encoding='utf-8').write('\n'.join(L))
    cnt = {}
    for it in rep:
        cnt[it['state']] = cnt.get(it['state'], 0) + 1
    print('状态统计：', cnt, ' 变薄：', [it['no'] for it in rep if it.get('thin')], ' 已入库：', len([it for it in rep if it.get('landed')]))


# ───────────────────────── land ─────────────────────────
def _sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def same_tree(src_md, src_img, dst_md, dst_img):
    """暂存产物与库内副本逐字节一致：md 字节相等；_images 下文件名集合相同且每个文件 sha256 相同。"""
    if not (os.path.isfile(src_md) and os.path.isdir(src_img) and os.path.isfile(dst_md) and os.path.isdir(dst_img)):
        return False
    if _sha(src_md) != _sha(dst_md):
        return False
    a, b = sorted(os.listdir(src_img)), sorted(os.listdir(dst_img))
    if a != b:
        return False
    return all(_sha(os.path.join(src_img, f)) == _sha(os.path.join(dst_img, f)) for f in a)


def cmd_land(a):
    rows = {r['idx']: r for r in load_rows(a.config)}
    states = load_states(a)
    force = set(int(x) for x in (a.force or '').split('|') if x.strip())
    archive = os.path.join(a.hist, '全量重采前_' + datetime.date.today().strftime('%Y%m%d'))
    plan, done = [], 0
    for no in sorted(states):
        st = states[no]
        if st.get('state') != 'ok' or st.get('landed'):
            continue
        old_md = os.path.join(a.lib, st['old'])
        old_img = old_md[:-3] + '_images'
        new_md = os.path.join(a.stage, '%02d' % no, st['new'])
        new_img = new_md[:-3] + '_images'
        tgt_md = os.path.join(a.lib, st['new'])
        if st.get('thin') and no not in force:
            plan.append((no, st['menu'], '不动：变薄待看'))
            continue
        if not os.path.exists(old_md) and not st.get('archived'):
            plan.append((no, st['menu'], '不动：权威库里旧文档已不在'))
            continue
        if not (os.path.exists(new_md) and os.path.isdir(new_img)):
            plan.append((no, st['menu'], '不动：暂存产物不全'))
            continue
        archived = bool(st.get('archived'))
        if os.path.exists(tgt_md) and not archived:
            plan.append((no, st['menu'], '不动：权威库已有同名 ' + st['new']))
            continue
        if archived:
            plan.append((no, st['menu'], '续作：旧版已归档，只核/拷新版'))
        else:
            if os.path.exists(os.path.join(archive, st['old'])):
                plan.append((no, st['menu'], '不动：归档目录已有同名 ' + st['old']))
                continue
            plan.append((no, st['menu'], '旧版 → %s；新版入库' % os.path.basename(archive)))
    for p in plan:
        print('  ', p)
    if not a.apply:
        print('（预演，未改动任何文件；加 --apply 执行）')
        return
    os.makedirs(archive, exist_ok=True)
    for no, menu, _ in plan:
        st = states[no]
        old_md = os.path.join(a.lib, st['old'])
        old_img = old_md[:-3] + '_images'
        new_md = os.path.join(a.stage, '%02d' % no, st['new'])
        new_img = new_md[:-3] + '_images'
        tgt_md = os.path.join(a.lib, st['new'])
        tgt_img = tgt_md[:-3] + '_images'
        # 顺序：先拷新版 → 逐字节核对 → 才归档旧版。保证库里任何时刻都有这个菜单的文档（新旧文件名不同，不互相覆盖）
        if not os.path.exists(tgt_md):
            shutil.copy2(new_md, tgt_md)
        if not os.path.exists(tgt_img):
            shutil.copytree(new_img, tgt_img)
        ok = same_tree(new_md, new_img, tgt_md, tgt_img)
        if not ok:
            print('  [%02d] %s 入库后比对不一致！（旧版未动，新版残留 %s，须人工处理）' % (no, menu, st['new']))
            continue
        if not st.get('archived'):
            if os.path.exists(old_md):
                shutil.move(old_md, os.path.join(archive, st['old']))
            if os.path.isdir(old_img):
                shutil.move(old_img, os.path.join(archive, os.path.basename(old_img)))
            st['archived'] = now()
            save(st, a)
        st['landed'] = now()
        save(st, a)
        done += 1
        print('  [%02d] %s 入库 %s' % (no, menu, st['new']))
    print('入库 %d 份；归档目录 %s' % (done, archive))


def cmd_check(a):
    """单份文档的结构体检（离线、纯文本）：正文非空 + 章节标题不在表格数据行的单元格里。单菜单采集后也可单独跑。"""
    r = structure_check(open(a.doc, encoding='utf-8').read())
    print('文档: %s\n正文字符数: %d\n章节标题出现在表格单元格内: %d 处 %s' % (a.doc, r['bodyChars'], len(r['headsInCells']), r['headsInCells'][:6]))
    if r['bodyChars'] < 20:
        print('红：正文为空——页面未渲染就采集了')
    if r['headsInCells']:
        print('红：正文被吞进表格（罩在表上的大文本框被归进了格子）')
    if r['bodyChars'] >= 20 and not r['headsInCells']:
        print('结构体检 通过')
    sys.exit(0 if (r['bodyChars'] >= 20 and not r['headsInCells']) else 1)


def main():
    ap = argparse.ArgumentParser(description='蓝湖需求文档批量重采驱动')
    ap.add_argument('cmd', choices=['run', 'land', 'report', 'check'])
    ap.add_argument('--config', default='', help='run/land/report 必填：菜单配置 md')
    ap.add_argument('--stage', default='', help='run/land/report 必填：暂存根目录')
    ap.add_argument('--doc', default='', help='check 必填：待体检的需求文档 md')
    ap.add_argument('--lib', default='')
    ap.add_argument('--hist', default='')
    ap.add_argument('--shard', default='')
    ap.add_argument('--start-port', type=int, default=9334)
    ap.add_argument('--only', default='')
    ap.add_argument('--skip', default='', help='跳过：全表行序号或菜单关键字，| 分隔')
    ap.add_argument('--gates-only', action='store_true', help='上一轮只差对账的菜单沿用暂存产物，只重跑文件校验/忠实闸/对账')
    ap.add_argument('--rerun-ok', action='store_true', help='连已 ok 的菜单也全部重采重检（代码变更后做全量回归用）')
    ap.add_argument('--no-retry-fail', action='store_true')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--force', default='')
    a = ap.parse_args()
    if a.cmd == 'check':
        if not a.doc or not os.path.isfile(a.doc):
            sys.exit('check 需要 --doc <需求文档 md>')
        cmd_check(a)
        return
    if not a.config or not a.stage:
        sys.exit('run/land/report 需要 --config 与 --stage')
    a.lib = a.lib or os.path.dirname(os.path.abspath(a.config))
    a.hist = a.hist or os.path.join(os.path.dirname(a.lib), '历史版本')
    os.makedirs(a.stage, exist_ok=True)
    {'run': cmd_run, 'report': cmd_report, 'land': cmd_land}[a.cmd](a)


if __name__ == '__main__':
    main()
