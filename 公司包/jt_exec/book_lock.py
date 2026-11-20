# -*- coding: utf-8 -*-
"""book_lock.py — 共享件锁协议（2026-11-20 立 · 并发会话互踩根治第一层）
两类用法：round 级持有锁（开工 acquire / 收尾 release，owner=轮次名）+ 短锁写窗（读改写瞬间）。
锁=目标文件旁 <file>.lock（JSON：owner/start/note/ttl_min）。崩溃自愈：mtime 超 TTL→挪 .broken-<ts> 留审计+可接管。
用法：
  python book_lock.py acquire <目标文件> <owner> [--note 备注] [--ttl-min 240]
  python book_lock.py release <目标文件> <owner>
  python book_lock.py status
退出码：0=成功；2=锁被在途会话持有（退避勿动）；3=非本 owner 持有禁释放；4=参数错
"""
import json, os, re, sys, time, glob, argparse
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
JOURNAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'locks_journal.jsonl')


def lock_path(t): return t + '.lock'


def read_lock(t):
    p = lock_path(t)
    if not os.path.exists(p): return None
    try: return json.load(open(p, encoding='utf-8'))
    except Exception: return {'owner': '?', 'start': 0, 'note': '损坏锁', 'ttl_min': 240}


def age_min(t): return (time.time() - os.path.getmtime(lock_path(t))) / 60


def journal(ev):
    with open(JOURNAL, 'a', encoding='utf-8') as f:
        f.write(json.dumps({**ev, 'ts': time.strftime('%Y-%m-%d %H:%M:%S')}, ensure_ascii=False) + '\n')


def acquire(t, owner, note='', ttl=240):
    os.makedirs(os.path.dirname(t) or '.', exist_ok=True)
    lk = read_lock(t)
    if lk:
        if age_min(t) < lk.get('ttl_min', 240):
            print(f'✗ 锁被在途会话持有：{lock_path(t)}')
            print(f'  owner={lk.get("owner")} start={time.strftime("%m-%d %H:%M", time.localtime(lk.get("start", 0)))} note={lk.get("note","")}')
            print(f'  （{age_min(t):.0f} 分钟前心跳，TTL {lk.get("ttl_min",240)}——退避，该册勿动；确需接管先人工核')
            sys.exit(2)
        broken = f'{lock_path(t)}.broken-{time.strftime("%Y%m%d_%H%M%S")}'
        os.rename(lock_path(t), broken)
        journal({'ev': 'stale-break', 'target': t, 'old': lk, 'broken_file': broken})
        print(f'⚠ 死锁接管：旧锁超 TTL 已挪 {os.path.basename(broken)}（审计在 locks_journal.jsonl）')
    data = {'owner': owner, 'start': time.time(), 'note': note, 'ttl_min': ttl}
    with open(lock_path(t), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    journal({'ev': 'acquire', 'target': t, 'owner': owner, 'note': note})
    print(f'✓ 已持有：{lock_path(t)}（owner={owner} ttl={ttl}min）')


def release(t, owner):
    lk = read_lock(t)
    if not lk:
        print(f'⚠ 无锁可释：{t}'); sys.exit(0)
    if lk.get('owner') != owner:
        print(f'✗ 非本 owner（{lk.get("owner")}≠{owner}）禁释放'); sys.exit(3)
    os.remove(lock_path(t))
    journal({'ev': 'release', 'target': t, 'owner': owner})
    print(f'✓ 已释放：{lock_path(t)}')


def status():
    dirs = [r'D:\ZCodetest', r'D:\ZCodetest\需求用例库\用例文件',
            os.path.dirname(os.path.abspath(__file__))]
    found = 0
    for d in dirs:
        for p in glob.glob(os.path.join(d, '*.lock')):
            lk = read_lock(p[:-5])
            found += 1
            a = age_min(p[:-5])
            state = '🟢在途' if a < lk.get('ttl_min', 240) else '🔴超时'
            print(f'  {state} {os.path.basename(p)} owner={lk.get("owner")} {a:.0f}min前 note={lk.get("note","")}')
    if not found: print('  （当前无持有锁）')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['acquire', 'release', 'status'])
    ap.add_argument('target', nargs='?')
    ap.add_argument('owner', nargs='?')
    ap.add_argument('--note', default='')
    ap.add_argument('--ttl-min', type=int, default=240)
    A = ap.parse_args()
    if A.cmd == 'status':
        status()
    elif A.cmd == 'acquire':
        if not (A.target and A.owner):
            print('用法：acquire <目标文件> <owner>'); sys.exit(4)
        acquire(A.target, A.owner, A.note, A.ttl_min)
    else:
        if not (A.target and A.owner):
            print('用法：release <目标文件> <owner>'); sys.exit(4)
        release(A.target, A.owner)
