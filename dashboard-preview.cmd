@echo off
REM 看板预览快捷入口：先生成最新的每日快照页面，再启动本地静态预览服务。
setlocal

REM 将当前工作目录切换到本 cmd 文件所在目录，避免从其他目录双击时找不到 package.json。
cd /d %~dp0

REM /wait 让生成步骤完成后再继续；生成失败时 errorlevel 会大于等于 1。
start /wait "dashboard-preview-generate" cmd /c npm.cmd run generate:dashboard
if errorlevel 1 exit /b 1

REM 启动看板服务器。该命令不使用 /wait，使服务可以在后台持续运行。
start "dashboard-preview-serve" cmd /c npm.cmd run dashboard:serve

REM 给 Node 服务几秒钟完成监听，然后打开固定的本地预览地址。
timeout /t 4 /nobreak >nul
start "" http://127.0.0.1:33123/dashboard-daily.html
