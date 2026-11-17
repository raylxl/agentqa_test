# 启动带防 https 升级参数的 Chrome 9334 独立实例（鲸天登录专用）
# 已在运行：输出 __RUNNING__ 并退出；未运行：启动后输出 __STARTED__ <版本>；失败输出 __FAILED__ 退出码 1
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $ScriptDir '..\..\..\..\..')
$Chrome = @('C:\Program Files\Google\Chrome\Application\chrome.exe', (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Chrome) { Write-Output '__FAILED__ 未找到 Google Chrome'; exit 1 }

# 已在跑就直接复用（幂等）
try {
  $null = Invoke-RestMethod -Uri 'http://127.0.0.1:9334/json/version' -TimeoutSec 2
  Write-Output '__RUNNING__'
  exit 0
} catch { }

Start-Process -FilePath $Chrome -ArgumentList @(
  '--remote-debugging-port=9334',
  ('--user-data-dir=' + (Join-Path $Root '.chrome-cdp-2')),
  '--no-first-run',
  '--no-default-browser-check',
  '--start-maximized',
  '--ignore-certificate-errors',
  '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForEngagedSites'
)
Start-Sleep -Seconds 4
try {
  $v = Invoke-RestMethod -Uri 'http://127.0.0.1:9334/json/version' -TimeoutSec 5
  Write-Output ('__STARTED__ ' + $v.Browser)
} catch {
  Write-Output '__FAILED__'
  exit 1
}
