@echo off
rem deploy = bootstrap (same deployer). ASCII-only on purpose: cmd mangles non-ASCII args across codepages.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo [RED] Python not found. Install Python 3.8+ first.
  pause
  exit /b 1
)
python deploy.py %*
pause
