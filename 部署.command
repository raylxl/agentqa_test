#!/bin/bash
# [部署] 与 [自举] 是同一部署器（克隆通道首次安装/更新通用）
cd "$(dirname "$0")"
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then
  echo "[红] 未检测到 Python，先装 Python 3.8+ 再跑"
  read -r -p "回车退出" _
  exit 1
fi
"$PY" "Agent本体/tools/deploy_colleague.py" "$@"
