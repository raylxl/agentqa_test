@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo [红] 未检测到 Python，先装 Python 3.8+ 再跑自举
  pause
  exit /b 1
)
python "Agent本体\tools\deploy_colleague.py" %*
pause
