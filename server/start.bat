@echo off
chcp 65001 >nul
cd /d %~dp0
:loop
node server.js
echo Server stopped. Restarting in 5 seconds...
timeout /t 5 >nul
goto loop
