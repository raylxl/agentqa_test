# open_devops.ps1 — 一站式研发平台自动登录浏览器（9334 有头 + devops 登录态 + 允许访问本地应用）
# 用法：powershell -File open_devops.ps1 [URL]
# 依赖：电脑已登录中通宝盒（OAuth 页会展示"一键登录"按钮，由 cdp 自动点击）
param([string]$TargetUrl = "https://devops.dev.ztoeco.com/cooperate/bug?productCode=PRO2307058000&tabActive=4")

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $ScriptDir '..\..\..\..\..')
$chrome = @('C:\Program Files\Google\Chrome\Application\chrome.exe', (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Error '未找到 Google Chrome'; exit 1 }
$prof = Join-Path $Root '.chrome-cdp-9334'
# 9334 profile 已含 devops 登录态（2026-11-11 一键登录落档）
# 允许访问本地应用 = --allow-outdated-plugins 不需要；关键是 localhost 白名单由 --allow-running-insecure-content + 无 --headless 保证
Start-Process $chrome -ArgumentList @(
  "--remote-debugging-port=9334",
  "--user-data-dir=$prof",
  "--no-first-run", "--no-default-browser-check",
  "--ignore-certificate-errors",
  "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForEngagedSites",
  "--allow-running-insecure-content",
  "--window-size=1440,900",
  $TargetUrl
)
Write-Output "浏览器已启动: 9334 有头, profile=$prof, URL=$TargetUrl"
Write-Output "等待 OAuth 自动跳转或一键登录..."
