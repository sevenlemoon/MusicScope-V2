@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1" %*
set "MUSICSCOPE_EXIT=%ERRORLEVEL%"
if not "%MUSICSCOPE_EXIT%"=="0" pause
exit /b %MUSICSCOPE_EXIT%
