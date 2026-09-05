@echo off
setlocal

cd /d %~dp0
start "dashboard-preview" cmd /c npm.cmd run dashboard:serve
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:33123/dashboard-daily.html

