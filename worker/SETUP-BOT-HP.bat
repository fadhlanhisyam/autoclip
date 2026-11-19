@echo off
title AutoClip - hubungkan bot Telegram
chcp 65001 >nul
cd /d "%~dp0"
"%~dp0..\tools\node\node.exe" "%~dp0bot.mjs" --setup
echo.
pause
