#!/bin/bash
# git 克隆通道自举/更新入口（macOS）：首次克隆后与每次拉更新都跑本件（幂等）
# 等价：python Agent本体/tools/deploy_colleague.py
cd "$(dirname "$0")"
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then
  echo "[红] 未检测到 Python，先装 Python 3.8+ 再跑自举"
  read -r -p "回车退出" _
  exit 1
fi
"$PY" "Agent本体/tools/deploy_colleague.py" "$@"
