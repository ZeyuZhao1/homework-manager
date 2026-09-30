$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$manifest = Join-Path $root 'host\Cargo.toml'
cargo test --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { throw '本地主机测试失败' }
cargo build --release --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { throw '本地主机构建失败' }
$out = Join-Path $root 'dist\blackboard-sync'
New-Item -ItemType Directory -Force -Path (Join-Path $out 'extension') | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'host\target\release\homeworkbook-bb-import-host.exe') -Destination (Join-Path $out 'bb-import-host.exe') -Force
foreach ($name in @('module.json','install.ps1','uninstall.ps1','LICENSE','README.md')) {
  Copy-Item -LiteralPath (Join-Path $root $name) -Destination (Join-Path $out $name) -Force
}
Copy-Item -Path (Join-Path $root 'extension\*') -Destination (Join-Path $out 'extension') -Recurse -Force
Compress-Archive -Path (Join-Path $out '*') -DestinationPath (Join-Path $root 'dist\blackboard-sync.zip') -Force
Write-Output "安装包：$(Join-Path $root 'dist\blackboard-sync.zip')"
