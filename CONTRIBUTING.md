# 贡献指南

## 开发环境

需要 Windows、Node.js 24+、pnpm 11+、Rust stable，以及 Visual Studio 的 C++ Build Tools。克隆后执行：

```powershell
pnpm install --frozen-lockfile
pnpm desktop:dev
```

## 提交前检查

```powershell
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

不要提交 `node_modules`、`dist`、`src-tauri/target`、本地数据库、备份文件或 API Key。应用凭据应只保存在 Windows 凭据管理器中。

## 变更范围

- 前端的 Tauri 调用须集中经由 `src/service.ts` 的类型化接口。
- 涉及数据结构或模块协议的变更，请同步更新 `README.md` 和 `MODULES.md`。
- 发布版本必须同时更新 `package.json` 与 `src-tauri/tauri.conf.json`（Rust 包版本也应保持一致）。
- 提交应保持单一目的，并说明用户可见影响和验证方式。
