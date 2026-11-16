#!/bin/bash
# pool_run.sh — 一切执行器的标准入口（浏览器实例调度标准 · 坑库G33 正本用法）
# 用法: bash pool_run.sh <执行器.js> [执行器自身参数...]
# 行为: acquire 空闲实例(有在用的跳过,全忙则起新并登录) → 后台心跳续租(5min) → 跑执行器(端口以 $PORT 传入) → release(页签归位+删锁)
set -u
cd "$(dirname "$0")"
SCRIPT="$1"; shift || true
PURPOSE="${POOL_PURPOSE:-$(basename "$SCRIPT")}"

PORT_JSON=$(node browser_pool.js acquire "$PURPOSE" ${POOL_START:-})
PORT=$(echo "$PORT_JSON" | python -c "import json,sys;print(json.load(sys.stdin).get('port',''))" 2>/dev/null)
if [ -z "$PORT" ]; then echo "[pool_run] 无空闲实例: $PORT_JSON"; exit 1; fi
echo "[pool_run] 租借 $PORT ← $PURPOSE"

# 心跳：每 5 分钟续租（长跑批防 60min 超时收编）
( while true; do sleep 300; node browser_pool.js touch "$PORT" >/dev/null 2>&1 || break; done ) &
HB=$!
trap 'kill $HB 2>/dev/null; node browser_pool.js release "$PORT"; echo "[pool_run] 已释放 $PORT"' EXIT

node "$SCRIPT" "$PORT" "$@"
