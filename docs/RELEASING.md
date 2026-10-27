# 发布指南

项目使用语义化版本、不可变 Git 标签和 GitHub Actions 发布原生桌面资产。正式流程为 `.github/workflows/release.yml`，复用 `.github/workflows/build-desktop.yml`；目标由 `scripts/desktop-targets.mjs` 定义。支持范围、原生 runner 和签名限制见 [平台支持](PLATFORMS.md)。旧发行版仍以原有 Release 资产为准，不移动公开标签。

## 1. 版本与发布前检查

同步以下文件中的应用/模块版本：

- `package.json`；
- `src-tauri/tauri.conf.json`；
- `src-tauri/Cargo.toml` 与 `src-tauri/Cargo.lock`；
- `modules/assignment-import/module.json`；
- `modules/recurring-assignments/module.json`；
- README 的当前版本与示例、CHANGELOG。

平台 Tauri 配置只覆盖平台差异，不重复声明应用版本。标签必须采用 `vMAJOR.MINOR.PATCH`，与应用版本一致。

```bash
git status --short --branch
git fetch origin --tags
git log -5 --oneline --decorate
pnpm install --frozen-lockfile
pnpm repository:check
pnpm lint
pnpm test
pnpm build
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
pnpm desktop:build -- --locked
```

确保没有无关改动，本地包含远端最新代码，目标标签未存在。单个平台本地通过不能替代其他平台验证。CI 会在 Windows x64/ARM64、macOS ARM64、Linux x64/ARM64 上原生执行测试、真实凭据往返测试、打包及架构检查；仍需在目标桌面环境执行安装、启动、文件对话框、剪贴板、备份恢复和卸载烟雾测试。

## 2. 创建新版本

仅在用户明确授权提交、推送与发布后执行。例如未来发布 `0.6.0`：

```bash
git add <本次发布文件>
git commit -m "Release v0.6.0"
git tag -a v0.6.0 -m "Release v0.6.0"
git push --atomic origin HEAD:main refs/tags/v0.6.0
```

推送标签后：

1. 解析标签，检查版本，并固定该标签提交的完整 SHA；
2. 五个原生 runner 检出同一 SHA，检查本机 Node/Rust 架构；
3. 安装依赖，检查仓库、前端 lint、Node 测试和 Rust 测试；
4. 单独运行 `native_credential_roundtrip`，Linux 在独立 D-Bus / GNOME Keyring 会话中执行；
5. 根据平台 Tauri 配置构建 NSIS、DMG、DEB / AppImage；
6. 检查 PE/ELF/Mach-O 架构，收集对应平台的安装包并上传 Actions artifact；
7. **仅全部构建成功后**合并所有平台资产，验证完整清单和非空文件，生成一个 `SHA256SUMS.txt`；
8. 由唯一的 publish job 创建同一个 GitHub Release 并上传所有资产。

构建任务只有 `contents: read` 权限，只有 publish 任务获得 `contents: write`。同标签发布使用 concurrency 串行运行，避免并发任务争抢上传。

## 3. 发布资产

版本 `<版本>` 预期有九项程序/安装包，外加一个统一校验清单：

```text
homework-manager-v<版本>-windows-x64-installer.exe
homework-manager-v<版本>-windows-x64-portable.exe
homework-manager-v<版本>-windows-arm64-installer.exe
homework-manager-v<版本>-windows-arm64-portable.exe
homework-manager-v<版本>-macos-arm64.dmg
homework-manager-v<版本>-linux-x64.deb
homework-manager-v<版本>-linux-x64.AppImage
homework-manager-v<版本>-linux-arm64.deb
homework-manager-v<版本>-linux-arm64.AppImage
SHA256SUMS.txt
```

`prepare-release-assets.mjs` 要求架构匹配、各平台只有一份预期安装包；聚合步骤拒绝缺失、多余、空文件或其他版本的资产。清单格式为 `<小写 SHA-256>  <文件名>`，按文件名排序。

macOS 当前使用 ad-hoc 签名，未配置 Developer ID 或 Apple 公证，不应把它描述为已公证安装包。Windows 安装包也未配置发行证书。签名和公证需要额外配置凭据，本轮不会索取或伪造这些信息。

## 4. 发布后验证

确认 workflow 为 success，五个平台使用同一目标 SHA，Release 不是 draft/prerelease，十项资产完整且非空。下载后验证校验清单：

```bash
sha256sum -c SHA256SUMS.txt
```

macOS 可使用 `shasum -a 256 <文件>`，Windows 使用 `Get-FileHash <文件> -Algorithm SHA256`，与清单逐项比较。

安装烟雾测试至少覆盖：新建与编辑作业、关联临时材料、打开文件和目录、重命名及撤回、AI 密钥保存后重启读取、粘贴截图、周期作业、导出/恢复数据库，以及窗口控制。Linux 应验证 X11 和 Wayland，macOS 验证原生窗口控件。跨系统恢复后原文件绝对路径通常失效，需要重新定位；数据库备份不包含凭据或实际文件。

## 5. 失败与重建

任一平台失败时，其他成功平台的 Actions artifacts 仍可用于排查；不会提前生成部分平台的 Release。先修复问题并重新运行 CI。源码变更应使用新的版本与标签，不移动已公开标签。

仅当源码标签正确、失败原因是 runner/下载/上传的暂时故障时，允许重新构建同一不可变标签：

```bash
gh workflow run release.yml --ref v0.6.0 -f release_tag=v0.6.0
```

执行 workflow 的 ref 与输入标签必须相同。旧标签仍使用其提交中的旧 workflow，不应把本轮多平台脚本强行用于缺少这些脚本的旧版本。上传失败可能留下不完整 Release，此时先标记为预发布并调查，不能把构建阶段的完整性门禁描述为 GitHub 多文件上传的原子事务。

发布后发现问题时保留标签与审计记录，在 Release 中说明问题，并发布新的修复版本。不要删除用户数据库或重写历史作为回滚方式。
