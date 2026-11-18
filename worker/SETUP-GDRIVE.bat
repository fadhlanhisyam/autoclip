@echo off
title AutoClip - hubungkan Google Drive
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-gdrive.ps1"
echo.
pause
