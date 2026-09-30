$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$moduleDir = Join-Path $env:APPDATA 'app.homeworkbook.local\modules\blackboard-sync'
$extensionDir = Join-Path $moduleDir 'extension'
$hostSource = Join-Path $source 'bb-import-host.exe'
if (-not (Test-Path -LiteralPath $hostSource -PathType Leaf)) { throw '安装包缺少 bb-import-host.exe；请使用构建后的 ZIP。' }
New-Item -ItemType Directory -Force -Path $extensionDir | Out-Null
Copy-Item -LiteralPath $hostSource -Destination (Join-Path $moduleDir 'bb-import-host.exe') -Force
Copy-Item -LiteralPath (Join-Path $source 'module.json') -Destination (Join-Path $moduleDir 'module.json') -Force
Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination (Join-Path $moduleDir 'LICENSE') -Force
Copy-Item -Path (Join-Path $source 'extension\*') -Destination $extensionDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $source 'uninstall.ps1') -Destination (Join-Path $moduleDir 'uninstall.ps1') -Force
$manifestPath = Join-Path $moduleDir 'native-host.json'
$hostManifest = @{
  name = 'app.homeworkbook.bbreader'
  description = 'HomeworkBook Blackboard assignment import'
  path = (Join-Path $moduleDir 'bb-import-host.exe')
  type = 'stdio'
  allowed_origins = @('chrome-extension://khcipngaeiianinnofmmiofnbbbinlkm/')
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath,$hostManifest,[System.Text.UTF8Encoding]::new($false))
$regPath = 'Registry::HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\app.homeworkbook.bbreader'
$regKey = 'HKCU\Software\Google\Chrome\NativeMessagingHosts\app.homeworkbook.bbreader'
& reg.exe add $regKey /ve /t REG_SZ /d $manifestPath /f | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Chrome 原生消息主机注册失败' }
if ((Get-Item -Path $regPath).GetValue('') -ne $manifestPath) { throw 'Chrome 原生消息主机注册结果不一致' }
Write-Output "模块已安装：$moduleDir"
Write-Output "在 Chrome 的 chrome://extensions 中开启开发者模式，加载已解压的扩展：$extensionDir"
Write-Output '首次检查后，在作业簿的“导入待审核”中确认作业。'
