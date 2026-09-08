@echo off
setlocal

cd /d %~dp0
start /wait "dashboard-preview-generate" cmd /c npm.cmd run generate:dashboard
if errorlevel 1 exit /b 1
start "dashboard-preview-serve" cmd /c npm.cmd run dashboard:serve
timeout /t 4 /nobreak >nul
start "" http://127.0.0.1:33123/dashboard-daily.html
