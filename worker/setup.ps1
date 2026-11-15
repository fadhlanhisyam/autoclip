# AutoClip Worker setup (Windows). Run via SETUP-WORKER.bat.
# - downloads a portable Node.js (no system install, no admin)
# - asks for your AutoClip password and checks it
# - registers a daily Windows Task Scheduler job at 09:00
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Worker = $PSScriptRoot
$Root = Split-Path $Worker -Parent
$Tools = Join-Path $Root 'tools'
$NodeDir = Join-Path $Tools 'node'
$NodeExe = Join-Path $NodeDir 'node.exe'
$ConfigPath = Join-Path $Worker 'config.json'
$Site = 'https://autoclip-gray.vercel.app'

function Say($t) { Write-Host $t -ForegroundColor Cyan }
function Ok($t) { Write-Host "  OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  !!  $t" -ForegroundColor Yellow }

Say "=============================================="
Say "  Setup AutoClip Worker (karyawan Downloader + Editor)"
Say "=============================================="

# 1. yt-dlp + ffmpeg (installed by YT-Download.bat)
foreach ($f in @('yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe')) {
  if (-not (Test-Path (Join-Path $Tools $f))) {
    Warn "$f belum ada di $Tools"
    Warn "Jalankan YT-Download.bat sekali dulu (folder Documents\autoclip), lalu ulangi setup ini."
    exit 1
  }
}
Ok "yt-dlp dan ffmpeg ditemukan"

# 2. portable Node.js
if (-not (Test-Path $NodeExe)) {
  Say "Mengunduh Node.js portable (sekali saja, +-30 MB)..."
  $rel = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.lts -ne $false } | Select-Object -First 1
  $ver = $rel.version
  $zip = Join-Path $env:TEMP "node-$ver-win-x64.zip"
  $tmp = Join-Path $env:TEMP "node-$ver-extract"
  Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip -UseBasicParsing
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip -DestinationPath $tmp -Force
  Move-Item (Join-Path $tmp "node-$ver-win-x64") $NodeDir
  Remove-Item $zip -Force
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Ok ("Node.js " + (& $NodeExe --version))

# 3. password
$config = @{}
if (Test-Path $ConfigPath) {
  try { (Get-Content $ConfigPath -Raw | ConvertFrom-Json).psobject.properties | ForEach-Object { $config[$_.Name] = $_.Value } } catch {}
}
if (-not $config['site']) { $config['site'] = $Site }
while ($true) {
  $pw = Read-Host "Ketik password AutoClip (APP_PASSWORD yang Anda isi di Vercel)"
  try {
    Invoke-RestMethod -Method Post -Uri ($config['site'] + '/api/auth') -Headers @{ 'x-app-password' = $pw } | Out-Null
    $config['password'] = $pw
    Ok "Password benar"
    break
  } catch {
    Warn "Password salah atau server tidak bisa dihubungi. Coba lagi."
  }
}
($config | ConvertTo-Json) | Set-Content -Path $ConfigPath -Encoding UTF8
Ok "Pengaturan disimpan di worker\config.json"

# 4. daily schedule 09:00
$runBat = Join-Path $Worker 'run-worker.bat'
$taskName = 'AutoClip Worker'
try {
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c start `"AutoClip Worker`" /min `"$runBat`""
  $trigger = New-ScheduledTaskTrigger -Daily -At '09:00'
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 4)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Virtual Office: download + clip video otomatis setiap hari' -Force | Out-Null
  Ok "Jadwal harian jam 09.00 terpasang (Task Scheduler: '$taskName')"
} catch {
  Warn "Register-ScheduledTask gagal ($($_.Exception.Message)). Mencoba schtasks..."
  schtasks /Create /SC DAILY /ST 09:00 /TN $taskName /TR "`"$runBat`"" /F | Out-Null
  if ($LASTEXITCODE -eq 0) { Ok "Jadwal harian jam 09.00 terpasang (schtasks)" } else { Warn "Jadwal gagal dipasang. Program tetap bisa dijalankan manual lewat JALANKAN-SEKARANG.bat" }
}

Say ""
Say "Setup selesai!"
Say "- Hasil klip akan muncul di: $([Environment]::GetFolderPath('MyVideos'))\AutoClip Hasil"
Say "- Daftar sumber video: worker\channels.txt   |   Link prioritas: worker\antrian.txt"
Say ""
$ans = Read-Host "Jalankan uji coba sekarang? (y/n)"
if ($ans -match '^[yY]') {
  & (Join-Path $Worker 'JALANKAN-SEKARANG.bat')
}
