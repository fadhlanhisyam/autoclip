# Hubungkan AutoClip ke Google Drive (sekali saja). Gratis, pakai rclone (tanpa instal).
$ErrorActionPreference = 'Stop'
$tools = Resolve-Path (Join-Path $PSScriptRoot '..\tools')
$rc = Join-Path $tools 'rclone.exe'

if (-not (Test-Path $rc)) {
  Write-Host 'Mengunduh rclone (sekitar 25 MB, sekali saja)...'
  $zip = Join-Path $env:TEMP 'rclone.zip'
  $tmp = Join-Path $env:TEMP 'rclone-extract'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest 'https://downloads.rclone.org/rclone-current-windows-amd64.zip' -OutFile $zip -UseBasicParsing
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip $tmp -Force
  Copy-Item (Get-ChildItem $tmp -Recurse -Filter rclone.exe | Select-Object -First 1).FullName $rc
  Remove-Item $zip, $tmp -Recurse -Force
}

Write-Host ''
Write-Host '=================================================================='
Write-Host ' Browser akan terbuka. Login ke akun Google Anda, lalu klik "Allow".'
Write-Host ' (Izin yang diminta hanya untuk file yang dibuat AutoClip sendiri.)'
Write-Host '=================================================================='
Write-Host ''
& $rc config delete gdrive 2>$null | Out-Null
& $rc config create gdrive drive scope=drive.file
if ($LASTEXITCODE -ne 0) { throw 'Login Google gagal / dibatalkan. Jalankan SETUP-GDRIVE.bat lagi.' }

& $rc mkdir 'gdrive:AutoClip Gaming'
& $rc mkdir 'gdrive:AutoClip Podcast'
Write-Host ''
Write-Host 'BERHASIL. Folder di Google Drive Anda:'
& $rc lsd gdrive:
Write-Host ''
Write-Host 'Mulai sekarang klip otomatis terupload ke "AutoClip Gaming" (GAMING-CLIP.bat)'
Write-Host 'dan "AutoClip Podcast" (JALANKAN-SEKARANG.bat).'
