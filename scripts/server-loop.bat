@echo off
cd /d %~dp0..\server
:loop
call npm run start
timeout /t 3 /nobreak >nul
goto loop
