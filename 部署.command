#!/bin/bash
# Deploy entry for git-clone installs and updates.
cd "$(dirname "$0")"
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then
  echo "[红] 未检测到 Python，先装 Python 3.8+ 再跑"
  read -r -p "回车退出" _
  exit 1
fi
"$PY" "deploy.py" "$@"
