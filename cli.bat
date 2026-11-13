@echo off
setlocal
node "%~dp0scripts\launch.mjs" %*
exit /b %errorlevel%
