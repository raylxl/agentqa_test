# report_stale_check.py — Session 收尾检查（防线三，2026-11-18 立）
# 比对：账本最后写入时间 vs 报告最后收尾行日期；报告更早=未同步→提醒
# 用法: python report_stale_check.py <pw_run_results.log> <测试报告.md>
# 可作为 PostToolUse hook 或手动运行；输出提醒文本，退出码 0=OK 1=STALE
import sys, io, re, os, datetime
try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception: pass

if len(sys.argv) < 3:
    print('提醒: 报告可能未同步。用法: python report_stale_check.py <账本.log> <报告.md>')
    sys.exit(0)  # 参数不足不阻断

log_path, report_path = sys.argv[1], sys.argv[2]

# 账本最后写入
try:
    log_mtime = os.path.getmtime(log_path)
    log_dt = datetime.datetime.fromtimestamp(log_mtime)
    log_date = log_dt.strftime('%Y-%m-%d')
except OSError:
    sys.exit(0)  # 账本不存在=无测试=不检查

# 报告收尾行日期
try:
    report = io.open(report_path, encoding='utf-8').read()
    m = re.search(r'最后收尾\**[：:]\s*第\s*\d+\s*轮\s*·\s*.+?\s*·\s*(\d{4}-\d{2}-\d{2})', report)
    if not m:
        print(f'⚠ 报告无收尾声明行；账本最后写入={log_date} → 请同步报告')
        sys.exit(1)
    report_date = m.group(1)
except OSError:
    sys.exit(0)  # 报告不存在=首次测试前=不检查

if log_date > report_date:
    print(f'⚠ 报告未同步：账本最后写入={log_date} > 报告收尾={report_date}')
    print(f'  → 请更新报告轮次块+收尾行后再结束会话')
    print(f'  → 账本={log_path}')
    print(f'  → 报告={report_path}')
    sys.exit(1)
else:
    # 静默通过
    sys.exit(0)
