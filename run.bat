@echo off
cd /d "%~dp0"
node scripts\check-deps.js --quiet
if errorlevel 2 (
  echo [VALIDATION] dependency check failed. Startup canceled.
  pause
  exit /b 1
)
if errorlevel 1 (
  echo [VALIDATION] installing missing dependencies...
  npm.cmd install
  if errorlevel 1 (
    echo [VALIDATION] dependency install failed. Startup canceled.
    pause
    exit /b 1
  )
  echo [VALIDATION] dependencies installed.
)
:start_bot
node app.js
set EXIT_CODE=%ERRORLEVEL%
if "%EXIT_CODE%"=="42" (
  echo [BOOT] Restart requested from dashboard. Relaunching...
  timeout /t 2 /nobreak >nul
  goto start_bot
)
exit /b %EXIT_CODE%
