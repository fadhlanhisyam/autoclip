@echo off
title AutoClip - bot Telegram (biarkan terbuka)
chcp 65001 >nul
cd /d "%~dp0"
"%~dp0..\tools\node\node.exe" "%~dp0bot.mjs"
echo.
pause
