# 启动 Chrome 9333 独立实例（默认无头模式；需可视化时传 -Visual）
# 已在运行：输出 __RUNNING__ 并退出；未运行：启动后输出 __STARTED__ <版本>；失败输出 __FAILED__ 退出码 1
# 2026-11-09 用户拍板：默认无头（--headless=new），需要可视化时手动传 -Visual 参数
param([switch]$Visual)
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $ScriptDir '..\..\..\..\..')
# G51（2026-11-17）：脚本经用户级 junction 联接位调用时相对层级解析错位（Root=C:\Users），
# profile 落到不存在的 C:\Users\.chrome-cdp。取第一个真实存在 .chrome-cdp 的候选为准。
$Root = @($Root.Path, 'D:\ZCodetest') | Where-Object { Test-Path (Join-Path $_ '.chrome-cdp') } | Select-Object -First 1
if (-not $Root) { Write-Output '__FAILED__ 未找到 .chrome-cdp 配置目录（候选：脚本相对层级 / D:\ZCodetest）'; exit 1 }
$Chrome = @('C:\Program Files\Google\Chrome\Application\chrome.exe', (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Chrome) { Write-Output '__FAILED__ 未找到 Google Chrome'; exit 1 }

# 已在跑就直接复用（幂等）
try {
  $null = Invoke-RestMethod -Uri 'http://127.0.0.1:9333/json/version' -TimeoutSec 2
  Write-Output '__RUNNING__'
  exit 0
} catch { }

$args = @(
  '--remote-debugging-port=9333',
  ('--user-data-dir=' + (Join-Path $Root '.chrome-cdp')),
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
  $v = Invoke-RestMethod -Uri 'http://127.0.0.1:9333/json/version' -TimeoutSec 5
  Write-Output ("__STARTED__ [{0}] {1}" -f $mode, $v.Browser)
} catch {
  Write-Output '__FAILED__'
  exit 1
}
