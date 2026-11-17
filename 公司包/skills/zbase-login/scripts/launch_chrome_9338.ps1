# 启动 Chrome 9338 独立实例（ZBASE 专用；默认无头模式，需可视化时传 -Visual）
# 已在运行：输出 __RUNNING__ 并退出；未运行：启动后输出 __STARTED__ <版本>；失败输出 __FAILED__ 退出码 1
param([switch]$Visual)
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cands = @((Resolve-Path (Join-Path $ScriptDir '..\..\..\..\..')).Path, 'D:\ZCodetest')
# G51 同款：经 junction/硬链接位调用时相对层级解析错位——优先取已有 .chrome-cdp-9338 的候选，
# 其次取已跑过 Chrome CDP（有 .chrome-cdp）的候选，都无才退回第一个存在的候选（首跑建目录）。
$Root = $Cands | Where-Object { Test-Path (Join-Path $_ '.chrome-cdp-9338') } | Select-Object -First 1
if (-not $Root) { $Root = $Cands | Where-Object { Test-Path (Join-Path $_ '.chrome-cdp') } | Select-Object -First 1 }
if (-not $Root) { $Root = $Cands | Where-Object { Test-Path $_ } | Select-Object -First 1 }
if (-not $Root) { Write-Output '__FAILED__ 未找到部署根（候选：脚本相对层级 / D:\ZCodetest）'; exit 1 }
$Profile = Join-Path $Root '.chrome-cdp-9338'
if (-not (Test-Path $Profile)) { New-Item -ItemType Directory -Path $Profile | Out-Null }
$Chrome = @('C:\Program Files\Google\Chrome\Application\chrome.exe', (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Chrome) { Write-Output '__FAILED__ 未找到 Google Chrome'; exit 1 }

# 已在跑就直接复用（幂等）
try {
  $null = Invoke-RestMethod -Uri 'http://127.0.0.1:9338/json/version' -TimeoutSec 2
  Write-Output '__RUNNING__'
  exit 0
} catch { }

$args = @(
  '--remote-debugging-port=9338',
  ('--user-data-dir=' + $Profile),
  '--no-first-run',
  '--no-default-browser-check',
  '--ignore-certificate-errors',
  '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForEngagedSites'
)

if ($Visual) {
  $args += '--start-maximized'
  $mode = 'VISUAL'
} else {
  $args += @( '--headless=new', '--disable-gpu', '--window-size=1920,1080' )
  $mode = 'HEADLESS'
}

Start-Process -FilePath $Chrome -ArgumentList $args
Start-Sleep -Seconds 3

try {
  $v = Invoke-RestMethod -Uri 'http://127.0.0.1:9338/json/version' -TimeoutSec 5
  Write-Output ("__STARTED__ [{0}] {1}" -f $mode, $v.Browser)
} catch {
  Write-Output '__FAILED__'
  exit 1
}
