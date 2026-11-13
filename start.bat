@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24+ is required. Install Node.js and run start.bat again.
  pause
  exit /b 1
)
node "%~dp0scripts\launch.mjs" up --format text %*
set "kb_exit=%errorlevel%"
if not "%kb_exit%"=="0" pause
exit /b %kb_exit%
