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
node app.js
