$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $env:APPDATA 'app.homeworkbook.local\modules\document-navigation'
[System.IO.Directory]::CreateDirectory($target) | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'module.json') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $source 'module.ps1') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $source 'README.md') -Destination $target -Force
Write-Host "Document navigation module installed to: $target"
Write-Host 'In Homework Manager, open Settings and select Refresh Modules to hot-load it.'
