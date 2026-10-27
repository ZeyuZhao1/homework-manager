# 桌面平台与原生构建

本轮适配覆盖核心作业管理、周期作业、文件关联/浏览/重命名、备份恢复、AI 导入与粘贴图片。打印模块、学校客户端及依赖 PowerShell 的模块不在本轮适配范围；外部原生模块需要匹配当前操作系统和 CPU 架构。

这里描述的是源码及 workflow 的构建目标，不代表尚未运行的 GitHub 构建或各平台图形界面已经通过实机验证。已发布版本的实际支持范围以其 Release 资产为准。

| 目标 | Rust target | GitHub runner | 分发格式 |
| --- | --- | --- | --- |
| Windows x64 | `x86_64-pc-windows-msvc` | `windows-2022` | NSIS `.exe`、便携 `.exe` |
| Windows ARM64 | `aarch64-pc-windows-msvc` | `windows-11-arm` | NSIS `.exe`、便携 `.exe` |
| macOS ARM64 | `aarch64-apple-darwin` | `macos-15`（Apple Silicon） | `.dmg` |
| Linux x64 | `x86_64-unknown-linux-gnu` | `ubuntu-24.04` | `.deb`、`.AppImage` |
| Linux ARM64 | `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm` | `.deb`、`.AppImage` |

矩阵由 `scripts/desktop-targets.mjs` 统一定义。每个 runner 原生执行对应架构的 Rust 单元测试与构建；`check-native-host.mjs` 拒绝使用架构不匹配的 Node/Rust 工具链。分发前额外读取 PE/ELF/Mach-O 文件头校验架构。Windows ARM64 指应用本体为 ARM64；NSIS 安装引导程序本身可能通过 Windows 的兼容机制运行。

## 系统要求与数据位置

- Windows x64：Windows 10/11；Windows ARM64：Windows 11 ARM64。需要 WebView2（NSIS 安装程序可按 Tauri 默认流程安装，便携版需系统已具备）。
- macOS ARM64：Apple Silicon，最低系统版本配置为 macOS 11。使用系统 WebKit 和原生红绿灯窗口控件，保留 Tauri 默认的 macOS 应用菜单。当前配置使用 ad-hoc 签名，不包含 Apple Developer ID 签名或公证；首次打开可能受到 Gatekeeper 限制。正式面向广泛用户分发时应另行配置签名与公证。
- Linux 安装包使用符合 Debian 规则的 ASCII 包名 `homework-manager`，应用内部仍显示“作业簿”。
- Linux：构建基线为 Ubuntu 24.04（glibc 2.39），需要 GTK 3、WebKitGTK 4.1、D-Bus 及可用图形会话。其他发行版需要提供兼容运行库；AppImage 不保证兼容比构建基线更旧的 glibc。Wayland 可能由窗口管理器决定窗口位置，应用不会因定位被拒绝而保持隐藏或退出。

使用 Tauri 的 `app_data_dir()`，不硬编码跨系统保存路径：

| 系统 | 默认应用数据根目录 | API Key |
| --- | --- | --- |
| Windows | `%APPDATA%\app.homeworkbook.local` | Windows Credential Manager |
| macOS | `~/Library/Application Support/app.homeworkbook.local` | macOS Keychain |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/app.homeworkbook.local` | Secret Service（如 GNOME Keyring 或兼容的 KWallet） |

`homework.db`、`modules/` 和粘贴图片均相对于该目录保存。跨系统恢复数据库不会迁移原文件，也不会重写旧绝对路径；需要复制材料并重新定位文件。密钥不进入数据库备份，在另一台设备上需重新配置。

Linux 必须运行并解锁 Secret Service；不可用时 AI 密钥保存/读取会失败，不回退到模拟后端或明文文件。手动录入和文件管理仍可使用。

## 本地开发与验证

所有平台需要 Node.js 24+、pnpm 11 和 Rust stable。Windows 还需要 Visual Studio C++ 工具链（ARM64 安装对应编译组件）；macOS 需要 Xcode Command Line Tools。

Ubuntu 构建依赖与原生密钥测试依赖：

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libdbus-1-dev gnome-keyring dbus-x11 xdg-utils
```

```bash
pnpm install --frozen-lockfile
pnpm repository:check
pnpm lint
pnpm test
pnpm build
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
node node_modules/@tauri-apps/cli/tauri.js build -- --locked
```

需要传入 Cargo 参数时直接调用项目内的 Tauri CLI，保留 `-- --locked`；不要依赖 Windows 下 pnpm 脚本的分隔符转发行为。带目标的示例：`node node_modules/@tauri-apps/cli/tauri.js build --target aarch64-pc-windows-msvc -- --locked`。

Tauri 自动合并 `tauri.<平台>.conf.json`，无需手动修改 NSIS 为 DMG/DEB。一般构建写入 `src-tauri/target/release/`；显式传入 `--target <triple>` 时写入 `src-tauri/target/<triple>/release/`。

`native_credential_roundtrip` 是需解锁系统凭据存储的独立集成测试，默认忽略，CI 显式执行。测试只使用随机条目和合成测试值，完成后删除条目，不读写用户的模型凭据：

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib native_credential_roundtrip -- --ignored
```

CI 的 Linux 任务在独立 `dbus-run-session` 内启动并解锁 GNOME Keyring；这只建立 runner 上的测试会话，不是应用启动时自动创建或解锁用户的钥匙串。

## GitHub Actions 打包分发

- `ci.yml` 在 PR、main 推送或手动运行时调用 `build-desktop.yml`，执行全部五个平台的原生测试、凭据往返测试、打包及架构检查，上传 14 天有效的 Actions artifacts。
- `release.yml` 在推送版本标签时调用同一个构建 workflow。解析并固定一个源码 SHA，所有平台检出同一提交；标签版本与项目版本必须一致。
- 只有五个平台全部成功，发布任务才合并九项资产、验证文件非空和清单完整、生成统一 `SHA256SUMS.txt`，随后创建同一个 GitHub Release。任何平台失败不会先发布部分平台。
- 当前 workflow 不需要 Apple 开发者账号或签名密钥，但 macOS 包仅为 ad-hoc 签名。CI 编译、单元测试和凭据测试通过仍不能替代安装、文件对话框、剪贴板、窗口及桌面环境的实机烟雾测试。

原生 runner 以 GitHub 官方提供的架构为准；仓库/组织需要具备所选 ARM runner 的使用权限。矩阵未使用 QEMU 或 Rosetta 来伪装原生测试。

## 本轮本地验证记录（2026-10-27）

在 Debian 13 x64 云环境中通过了前端 lint/build（保留 21 条现有 lint warning）、7 项 Node 路径/发布测试、45 项常规 Rust 测试，以及独立 D-Bus / GNOME Keyring 会话中的真实凭据往返测试。Linux x64 调试版二进制、合法 DEB 元数据和 AppImage 打包已验证；这些调试产物不是基于 Ubuntu 24.04 构建的正式发行包。

本地开发库安装在独立 sysroot，首次 AppImage 打包的 GTK 插件因此找不到系统模块目录；对已构建的二进制单独执行打包时，使用 `PKG_CONFIG_SYSROOT_DIR=/ APPIMAGE_EXTRACT_AND_RUN=1 pnpm tauri bundle --debug --bundles appimage` 后成功。workflow 安装标准系统开发包，不使用该本地 sysroot。

三个平台配置通过 Tauri JSON Schema 检查，三个 workflow 通过 actionlint。用户已反馈 main 的 GitHub Actions 构建成功；各平台图形界面、安装与用户流程仍需实机验证。GitHub 原生矩阵的执行结果以 Actions 记录为准；提交到 main 只触发构建与 artifact 上传，正式发布仍需新的版本标签。
