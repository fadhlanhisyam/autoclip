@echo off
rem Dipanggil otomatis oleh Task Scheduler setiap jam 09.00. Log disimpan di folder logs.
cd /d "%~dp0"
if not exist logs mkdir logs
for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"') do set "TS=%%t"
"%~dp0..\tools\node\node.exe" "%~dp0worker.mjs" > "logs\%TS%.log" 2>&1
