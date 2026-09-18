# 安全策略

## 支持范围

仅当前最新发布版本接受安全修复。该应用为 Windows 本地桌面应用，SQLite 数据保存在当前用户的 AppData 目录，API Key 保存至 Windows 凭据管理器。

## 报告漏洞

请勿公开提交包含可复现攻击步骤或敏感数据的 Issue。请通过 GitHub 账户个人资料中的联系方式私下联系维护者，并提供受影响版本、影响范围和最小复现步骤。维护者会确认收到报告，并在评估后协调修复与披露。

## 发布文件验证

每个 Release 都附带 `SHA256SUMS.txt`。在 PowerShell 中可用下列命令核对下载文件：

```powershell
Get-FileHash .\homework-manager-v0.3.0-windows-x64-installer.exe -Algorithm SHA256
```
