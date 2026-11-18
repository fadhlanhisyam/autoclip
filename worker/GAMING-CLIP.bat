@echo off
title AutoClip Gaming
chcp 65001 >nul
cd /d "%~dp0"
if not exist logs mkdir logs
"%~dp0..\tools\node\node.exe" "%~dp0gaming.mjs"
echo.
pause
