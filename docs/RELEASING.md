# 发布指南

项目使用语义化版本、Git 标签和 GitHub Actions 发布 Windows x64 资产。正式发布 workflow 位于 `.github/workflows/release.yml`。

## 1. 版本约定

版本格式为 `MAJOR.MINOR.PATCH`，Git 标签格式为 `vMAJOR.MINOR.PATCH`。

- `MAJOR`：不兼容的数据、协议或使用方式变更；
- `MINOR`：向后兼容的新功能；
- `PATCH`：向后兼容的修复和小改进。

发布前至少同步：

| 文件 | 字段 |
| --- | --- |
| `package.json` | `version` |
| `src-tauri/tauri.conf.json` | `version` |
| `src-tauri/Cargo.toml` | `[package].version` |
| `modules/assignment-import/module.json` | 内置模块 `version` |

更新 Rust 包版本后运行一次 Cargo 命令，让 `src-tauri/Cargo.lock` 中本项目版本同步。README 中“当前版本”、示例文件名和 CHANGELOG 也应更新。

发布 workflow 会强制校验标签与 `package.json`、`tauri.conf.json` 一致。Cargo 和内置模块版本目前依靠发布检查清单保持一致。

## 2. 发布前检查

### 2.1 工作区和历史

```powershell
git status --short --branch
git fetch origin --tags
git log -5 --oneline --decorate
```

确认：

- 在预期发布分支；
- 工作区没有无关改动；
- 本地分支已包含远端最新提交；
- 目标标签和 Release 尚不存在；
- CHANGELOG 已记录用户可见变化。

### 2.2 完整本地验证

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm desktop:build
```

检查本地产物：

```text
src-tauri/target/release/homework-manager.exe
src-tauri/target/release/bundle/nsis/*.exe
```

建议在干净 Windows 环境至少验证一次安装、启动、数据库创建和卸载流程。涉及升级迁移时，还应从上一个正式版本启动同一数据库进行检查。

### 2.3 文档和数据兼容

逐项确认：

- README 的下载、能力矩阵、数据路径和限制仍准确；
- `docs/CORE_API.md` 与 Tauri 命令/类型一致；
- `MODULES.md` 与模块宿主限制一致；
- 数据库 `user_version` 和恢复兼容范围正确；
- 新增网络请求、凭据或文件副作用已记录；
- 新的默认提示词不会覆盖用户修改。

## 3. 创建正式发布

以发布 `0.4.1` 为例：

```powershell
git add -A
git commit -m "Release v0.4.1"
git push origin main
git tag -a v0.4.1 -m "Release v0.4.1"
git push origin v0.4.1
```

推送 `v*` 标签会触发 Release Windows app workflow。workflow 在 `windows-latest` 上：

1. 检出标签对应提交；
2. 安装 pnpm 11、Node.js 24 和 Rust stable；
3. 校验标签与应用版本；
4. 使用 frozen lockfile 安装依赖；
5. 运行 lint；
6. 运行 Rust 库测试；
7. 执行 `pnpm desktop:build`；
8. 复制并统一命名便携 EXE 和 NSIS 安装包；
9. 生成 `SHA256SUMS.txt`；
10. 创建 GitHub Release 并生成发布说明。

## 4. 发布资产

每个正式版本应有且只有以下三项：

```text
homework-manager-v<版本>-windows-x64-installer.exe
homework-manager-v<版本>-windows-x64-portable.exe
SHA256SUMS.txt
```

workflow 计算两个可执行文件的 SHA-256，清单格式为：

```text
<小写哈希>  <文件名>
```

## 5. 发布后验证

在 GitHub Actions 和 Release 页面确认：

- workflow 结论为 success；
- job 使用的 `headSha` 是目标标签提交；
- Release 不是 draft 或 prerelease（除非计划如此）；
- 三项资产都处于 uploaded 状态，文件大小非零；
- 标签和 Release 名称一致；
- 自动生成的发布说明没有遗漏重要迁移或已知问题。

下载资产后验证哈希：

```powershell
Get-FileHash .\homework-manager-v0.4.1-windows-x64-installer.exe -Algorithm SHA256
Get-FileHash .\homework-manager-v0.4.1-windows-x64-portable.exe -Algorithm SHA256
```

至少对安装版执行一次烟雾测试：

1. 启动应用；
2. 打开现有数据库或创建测试数据；
3. 新建/编辑作业；
4. 关联一个临时文件；
5. 打开设置和模块列表；
6. 导出数据库备份；
7. 关闭并重新启动，确认数据存在。

## 6. 重新构建已有标签

workflow 支持手动输入 `release_tag`。只有在源码标签正确但 runner 或上传暂时失败时使用，不应借此用不同源码覆盖同一版本。

使用 GitHub CLI 时必须把执行 ref 指向同一个标签：

```powershell
gh workflow run release.yml --ref v0.4.1 -f release_tag=v0.4.1
```

workflow 配置了 `overwrite_files: true`，会覆盖同名资产。因此重新构建前应确认标签没有移动、workflow 文件未发生影响产物的变化，并在 Release 说明中保留必要的审计记录。

## 7. 失败处理

### 版本校验失败

不要移动已经公开的标签。若标签尚未公开且 workflow 未产生 Release，可修正版本文件、创建新提交，并使用新的补丁版本标签。公开后发现问题则发布新的补丁版本。

### lint、测试或构建失败

在同版本源码上本地复现对应命令。修复后提升版本并重新走完整流程，不要只上传本地产物绕过验证。

### Release 创建失败但构建成功

先确认 GitHub 权限和临时服务状态。若标签源码仍正确，可以按“重新构建已有标签”重新运行 workflow。

### 资产不完整或哈希不符

立即把 Release 标记为 prerelease 或暂时隐藏，并调查产物来源。不要手工替换其中一部分资产；应让同一次 workflow 重新生成全部三项，或发布新的补丁版本。

## 8. 回滚策略

桌面发行不能真正收回已经下载的二进制。发现严重问题时：

1. 在受影响 Release 顶部标明问题和升级建议；
2. 必要时将其标记为 prerelease 或删除公开 Release；
3. 保留 Git 标签和问题记录以便追溯；
4. 修复后发布新的补丁版本；
5. 若涉及数据库变更，优先提供向前修复，不要求用户手工删除数据库。

不要强制重写公开标签，也不要修改旧 Release 使其看起来像原本就是另一份源码。
