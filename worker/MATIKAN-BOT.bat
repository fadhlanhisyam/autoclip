@echo off
title AutoClip - matikan bot
chcp 65001 >nul
cd /d "%~dp0"
if not exist bot.pid goto none
set /p P=<bot.pid
taskkill /pid %P% /t /f >nul 2>&1
del bot.pid >nul 2>&1
echo Bot dimatikan. (Kalau autostart aktif, bot jalan lagi saat PC dinyalakan ulang.)
goto end
:none
echo Bot tidak sedang berjalan.
:end
echo.
pause
