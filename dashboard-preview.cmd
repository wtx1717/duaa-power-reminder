@echo off
REM Dashboard preview launcher.
setlocal

REM Always run from the directory containing this script.
pushd "%~dp0"
if errorlevel 1 (
  echo Failed to enter the project directory.
  exit /b 1
)

REM Generate the latest dashboard before starting the server.
call npm.cmd run generate:dashboard
if errorlevel 1 exit /b 1

REM Start the preview server in a separate process.
start "dashboard-preview-serve" cmd.exe /d /c "call npm.cmd run dashboard:serve"

REM Wait without requiring interactive console input, then open the page.
ping 127.0.0.1 -n 5 >nul
start "" "http://127.0.0.1:33123/dashboard-daily.html"

popd
exit /b 0
