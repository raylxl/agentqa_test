@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [部署] 与 [自举] 是同一部署器（克隆通道首次安装/更新通用）。开始...
where python >nul 2>nul
if errorlevel 1 (
  echo [红] 未检测到 Python，先装 Python 3.8+ 再跑
  pause
  exit /b 1
)
python "Agent本体\tools\deploy_colleague.py" %*
pause
