@echo off
title AutoClip Worker - jalan sekarang
chcp 65001 >nul
cd /d "%~dp0"
if not exist logs mkdir logs
"%~dp0..\tools\node\node.exe" "%~dp0worker.mjs" --tanya
echo.
echo Selesai. Hasil ada di folder Videos\AutoClip Hasil
pause
