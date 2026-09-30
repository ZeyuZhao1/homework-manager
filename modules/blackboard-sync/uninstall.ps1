$ErrorActionPreference = 'Stop'
$moduleDir = Join-Path $env:APPDATA 'app.homeworkbook.local\modules\blackboard-sync'
$manifestPath = Join-Path $moduleDir 'native-host.json'
$regPath = 'Registry::HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\app.homeworkbook.bbreader'
if (Test-Path -Path $regPath) {
  $registered = (Get-Item -Path $regPath).GetValue('')
  if ($registered -eq $manifestPath) { Remove-Item -Path $regPath -Force }
}
if (Test-Path -LiteralPath (Join-Path $moduleDir 'module.json')) { Remove-Item -LiteralPath (Join-Path $moduleDir 'module.json') -Force }
if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath -Force }
Write-Output '本地连接已卸载。请在 Chrome 扩展页移除“作业簿 · 南科大 BB 作业同步”。'
Write-Output '模块缓存和作业簿里的已导入作业保留在本机。'
