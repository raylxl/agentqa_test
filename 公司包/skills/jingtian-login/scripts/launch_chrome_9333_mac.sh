#!/bin/bash
# 启动 Chrome 9333 独立实例 · macOS 版（参数照抄 Windows 版 launch_chrome_9333.ps1：防 https 自动升级断 SSO）
# 用法：bash launch_chrome_9333_mac.sh        默认无头；传 -v 可视化
# 输出：__RUNNING__（已在跑）/ __STARTED__ <版本>（启动成功）/ __FAILED__（失败，退出码 1）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
D="$SCRIPT_DIR"
while [ "$D" != "/" ] && [ "$(basename "$D")" != "agentqa_test" ]; do D="$(dirname "$D")"; done
if [ "$(basename "$D")" != "agentqa_test" ]; then echo "__FAILED__ 未定位到 agentqa_test"; exit 1; fi
ROOT="$(dirname "$D")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  CHROME="$(ls "$HOME/Applications/"*Chrome*/Contents/MacOS/Google\ Chrome 2>/dev/null | head -1)"
fi
if [ -z "$CHROME" ] || [ ! -x "$CHROME" ]; then echo "__FAILED__ 未找到 Google Chrome（请安装标准版）"; exit 1; fi

if curl -s --max-time 2 http://127.0.0.1:9333/json/version >/dev/null; then echo "__RUNNING__"; exit 0; fi

ARGS=(--remote-debugging-port=9333
  "--user-data-dir=$ROOT/.chrome-cdp"
  --no-first-run --no-default-browser-check --ignore-certificate-errors
  --disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForEngagedSites
  --no-sandbox --disable-gpu-sandbox --disable-dev-shm-usage --disable-software-rasterizer)
if [ "$1" = "-v" ]; then
  ARGS+=(--start-maximized)
else
  ARGS+=(--headless=new --disable-gpu --window-size=1920,1080)
fi
"$CHROME" "${ARGS[@]}" >/dev/null 2>&1 &
sleep 3
V="$(curl -s --max-time 5 http://127.0.0.1:9333/json/version)"
if [ -n "$V" ]; then
  echo "__STARTED__ $(echo "$V" | tr -d '\n' | grep -o '"Browser":[^,]*')"
else
  echo "__FAILED__（Chrome 启动后 9333 未就绪——检查是否已有别的 Chrome 占用用户目录）"; exit 1
fi
