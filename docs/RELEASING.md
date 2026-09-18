# 发布指南

## 版本约定

使用 `MAJOR.MINOR.PATCH` 版本号。发布前应在以下位置保持相同版本：

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

## 本地验证

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm desktop:build
```

## 正式发布

推送形如 `v0.3.1` 的标签会触发 `.github/workflows/release.yml`。工作流会在 GitHub 的 Windows runner 上执行前端构建与 Rust 测试，生成 NSIS 安装包、便携 EXE 和 SHA-256 清单，并创建同名 GitHub Release。标签版本若与 Tauri 配置不一致，工作流会停止。

```powershell
git tag v0.3.1
git push origin v0.3.1
```

首次 `v0.3.0` 已由经验证的本地构建产物作为 Release 资产上传。以后请优先使用标签工作流，避免手工产物与源代码版本不一致。

## 回滚

不要修改已有 Release 资产。发现问题时发布新的补丁版本，并在 Release 说明中标记受影响版本与升级建议；如需隐藏错误版本，可将 Release 标记为 pre-release 或删除公开 Release，但保留对应 Git 标签和问题记录以便追溯。
