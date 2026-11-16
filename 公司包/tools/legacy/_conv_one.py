import sys, io, os
sys.path.insert(0, '.')
import conv_v2h
f = r'D:\ZCodetest\需求用例库\用例文件\财务需求2026_云仓_11.30_全流程场景用例_v1.md'
dry = '--run' not in sys.argv
conv, skip, already = conv_v2h.convert_file(f, dry_run=dry)
print(f'{"DRY" if dry else "DONE"}: conv={conv} skip={skip} already={already}')
