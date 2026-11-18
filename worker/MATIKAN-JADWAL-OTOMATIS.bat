@echo off
title AutoClip - matikan jadwal otomatis
chcp 65001 >nul
echo Menghapus jadwal otomatis AutoClip (jam 09.00)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = Get-ScheduledTask | Where-Object { $_.TaskName -like '*autoclip*' }; if ($t) { $t | ForEach-Object { Unregister-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath -Confirm:$false; Write-Host ('  Dihapus: ' + $_.TaskName) } } else { Write-Host '  Tidak ada jadwal AutoClip yang aktif.' }"
echo.
echo Selesai. CMD tidak akan muncul lagi jam 9.
echo Untuk memotong video, jalankan JALANKAN-SEKARANG.bat kapan saja.
echo.
pause
