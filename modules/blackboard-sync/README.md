# 南科大 Blackboard 作业同步

此模块基于 [BBReader 0.3.1](https://github.com/Carbene/BBReader) 的课程与作业读取实现精简而来。原作者 Carbene，MIT 许可证见 [LICENSE](LICENSE)。它只支持 `bb.sustech.edu.cn` 的已探索 Blackboard Original 页面，不上传或提交作业，也不下载课件。

## 安装

1. 使用 Windows x64，在本目录运行 `./build.ps1` 生成 `dist/blackboard-sync.zip`。普通用户可以直接使用构建好的 ZIP，无需 Rust 工具链。
2. 解压 ZIP 到固定位置，运行其中的 `install.ps1`。脚本把模块与扩展放入 `%APPDATA%\app.homeworkbook.local\modules\blackboard-sync`，在当前用户的 Chrome 原生消息注册表项中登记固定扩展 ID。无需管理员权限。
3. 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，选取安装脚本打印的 `extension` 目录。原版 BBReader 无需安装。
4. 打开扩展设置，保存校园账号和密码，点击“立即检查”。首次成功检查后，扩展按校园时间每日 09:00 自动检查；可在扩展里更改时间、选课或暂停。Chrome 关闭时不检查，下次启动后补查。
5. 在作业簿设置页刷新模块列表，然后从作业页打开“导入待审核”，匹配课程并确认新建、关联或更新。没有明确截止时间、已经逾期而未提交的作业也会出现。

如果系统阻止 PowerShell 脚本，可在 PowerShell 中使用 `powershell.exe -ExecutionPolicy Bypass -File .\install.ps1` 运行你已检查过的安装脚本。

## 数据与权限

- 扩展只访问南科大 BB 和学校 CAS，使用 Chrome 中的学校会话；失效后读取 Windows 凭据管理器中的校园登录信息尝试自动登录。验证码或登录页面变化需要人工处理。
- 扩展通过 Chrome 原生消息把课程和作业元数据交给独立主机。主机把最近一次检查写入模块目录的 `inbox.json`，不直接打开作业簿数据库。传输不包含校园密码、Cookie 或课程文件。
- 作业簿只在桌面运行时读取模块收件箱。主程序启用状态控制导入入口和写入，不控制扩展自己的扫描；如需停止扫描，请在扩展设置中暂停。
- 检查中的页面失败会显示警告；本次只发送成功读取详情的作业。主机保留上次已确认但本次未读到的条目，并附上警告，防止尚未审核的作业丢失。BB 暂时消失的作业不会被删除。新发现的已提交作业不创建；已关联作业提交状态改变时等待审核。
- 核心数据库备份包含已导入作业、来源关联与课程映射，不包含校园密码、扩展安装文件或模块收件箱。密码只在 Windows 凭据管理器中；卸载扩展不会自动删除凭据，请先在扩展中点“移除账号”。

## 卸载

在已安装模块目录运行 `uninstall.ps1`，再从 Chrome 扩展页移除扩展。脚本撤销当前用户的原生消息注册并取消主程序发现；保留已经导入的作业和模块缓存。需要移除密码时，先在扩展设置点击“移除账号”。

## 开发与验证

```powershell
node --test modules/blackboard-sync/tests/*.test.js
cargo test --manifest-path modules/blackboard-sync/host/Cargo.toml
./modules/blackboard-sync/build.ps1
```

模拟测试覆盖校园时间与截止时间、只读网址限制、每日一次检查、详情页失败、逾期与无截止时间保留，以及本地主机的消息大小和原子写入。实际学校登录和页面抓取需要有效南科大账号，在模拟测试中无法确认。
