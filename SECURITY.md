# 安全策略

## 支持范围

仅当前最新发布版本接受安全修复。桌面 SQLite 位于当前用户应用数据目录，桌面 API Key 与设备凭据仅保存至系统原生凭据存储。可选同步默认关闭，网页 AI 凭据由授权用户在网页管理，以 Worker Secret 主密钥加密后独立保存至私有 R2；不自动上传桌面 Key。Cloudflare 实际配置与凭据不得进入公开仓库、CI 或安装包。跨平台构建范围见 [平台支持](docs/PLATFORMS.md)，同步授权、上传与恢复边界见 [云同步指南](docs/SYNC.md)。

## 报告漏洞

请勿公开提交包含可复现攻击步骤或敏感数据的 Issue。请通过 GitHub 账户个人资料中的联系方式私下联系维护者，并提供受影响版本、影响范围和最小复现步骤。维护者会确认收到报告，并在评估后协调修复与披露。

## 发布文件验证

每个 Release 都附带 `SHA256SUMS.txt`。在 PowerShell 中可用下列命令核对下载文件：

```powershell
Get-FileHash .\homework-manager-v0.4.0-windows-x64-installer.exe -Algorithm SHA256
```

将输出的 `Hash` 与同一 Release 中 `SHA256SUMS.txt` 对应文件名的值比较。安装版和便携版都应分别校验。

## 信任边界

- 实际学习文件保留在用户目录中；数据库只记录路径和元数据。
- AI 功能只有在用户点击开始识别后才向所选服务商发送文字和附件。
- API Key 存入 Windows Credential Manager、macOS Keychain 或 Linux Secret Service，不回退到模拟存储或明文文件，不进入数据库备份。
- 外部模块是用户自行安装的本地可执行文件，以当前操作系统用户权限运行，并不处于操作系统沙箱中。

安装外部模块前应核实来源和哈希。模块协议的路径限制和超时只能保护宿主调用流程，不能阻止恶意程序访问当前用户有权访问的资源。
