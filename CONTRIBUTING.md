# 贡献指南

感谢参与作业簿。开始修改前，建议按任务类型先阅读：

- [Agent 协作入口](.agent/README.md)：自动化编程 Agent 的任务路由、约束和验证规则；
- [系统架构](docs/ARCHITECTURE.md)：组件、数据模型和一致性边界；
- [核心接口](docs/CORE_API.md)：前端服务和 Tauri 命令；
- [模块协议](MODULES.md)：外部协议与内置模块接口；
- [开发指南](docs/DEVELOPMENT.md)：环境、运行、测试和排错。

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
- UI 组件不直接访问 SQLite、凭据管理器或本地文件系统。
- 有文件系统副作用的功能必须先提供预览或确认，并明确失败后的补偿策略。
- 涉及数据结构或 Tauri 接口的变更，请同步更新 `src/types.ts`、`src/service.ts` 和 `docs/CORE_API.md`。
- 涉及模块协议或公共能力的变更，请同步更新 `MODULES.md` 和对应模块 README。
- 涉及架构、数据位置、隐私或用户流程的变更，请同步更新 `README.md` 和 `docs/ARCHITECTURE.md`。
- 发布版本必须同时更新 `package.json` 与 `src-tauri/tauri.conf.json`（Rust 包版本也应保持一致）。
- 提交应保持单一目的，并说明用户可见影响和验证方式。

## Pull Request 说明

请在 PR 中写明：

- 解决的问题和用户可见变化；
- 数据库、文件系统、网络或凭据副作用；
- 兼容/迁移策略；
- 实际运行过的验证命令；
- 尚未覆盖的风险或限制。

不要在 Issue、PR、截图或测试夹具中提交真实课程内容、数据库、路径中的个人信息、API Key 或服务商完整响应。
