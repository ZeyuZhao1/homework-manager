# 作业簿 Agent 指南

本文件适用于整个仓库。开始实现前先阅读 [.agent/README.md](.agent/README.md)，再根据任务进入对应文档。

## 项目一句话说明

作业簿是 Windows 本地优先的大学作业管理桌面应用：React/TypeScript 前端通过 Tauri 2 调用 Rust 后端，以 SQLite 保存结构化数据，实际学习文件留在用户原目录；内置 AI 模块只生成待审核草稿，核心负责数据库和文件系统副作用。

## 必须保持的系统约束

1. **本地优先**：不要在没有明确用户操作的情况下上传、移动或复制学习文件。
2. **核心掌握写权限**：模块可以解析和建议；作业保存、文件关联、重命名及撤回必须由核心接口执行。
3. **文件不随记录删除**：删除学期、课程关联或作业不能删除磁盘上的真实文件。
4. **副作用可解释、可验证**：网络发送、数据库恢复和文件改名必须有明确的用户动作、错误处理及必要确认。
5. **保留审计历史**：修改文件关联、位置或名称时，不得绕过 `file_history` / `rename_history`。
6. **凭据不入库、不入日志**：API Key 只保存在 Windows 凭据管理器；不得写入 SQLite、备份、源码、测试夹具或输出日志。
7. **外部模块不是沙箱**：不得把模块协议的路径校验描述成操作系统隔离；新增能力要维持最小数据暴露。
8. **兼容现有数据**：schema 变更必须考虑已有数据库、`user_version`、备份恢复和模块迁移。

## 编码边界

- React 页面和组件通过 `src/service.ts` 调用核心能力，不直接散落 Tauri `invoke`。
- 内置 AI 模块的私有调用集中在 `modules/assignment-import/frontend/service.ts`。
- 新 Tauri 命令必须在 `src-tauri/src/lib.rs` 注册，并同步 TypeScript 类型、服务包装、测试和接口文档。
- 文件系统写操作必须先校验路径和冲突；涉及数据库时保留事务或补偿逻辑。
- 浏览器预览实现要与桌面接口形状一致，但不得把预览成功当作桌面集成验证。
- 不要在无关任务中重构大段代码、清理 warning 或改变公共协议。

## 修改前

```powershell
git status --short --branch
rg --files -g AGENTS.md -g '!node_modules' -g '!src-tauri/target'
```

工作区可能包含用户或其他 Agent 的未提交改动。保留所有不属于当前任务的内容；不要使用 `git reset --hard`、`git checkout --` 等丢弃改动的命令。

## 最低验证

按改动范围选择，并在交付时说明实际运行结果：

```powershell
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

影响桌面打包或发布时再运行：

```powershell
pnpm desktop:build
```

仅文档改动至少运行 `git diff --check` 并检查相对链接。完整验证矩阵见 [.agent/CONTRIBUTION_PLAYBOOK.md](.agent/CONTRIBUTION_PLAYBOOK.md)。

## 文档联动

| 变更 | 必须同步检查 |
| --- | --- |
| 用户功能、路径、限制 | `README.md` |
| 架构或数据流 | `docs/ARCHITECTURE.md` |
| Tauri 命令、类型、服务 | `docs/CORE_API.md` |
| 外部模块清单或能力 | `MODULES.md` |
| 内置 AI 模块 | `modules/assignment-import/README.md` |
| 环境、脚本、测试 | `docs/DEVELOPMENT.md` |
| 版本与发布 | `CHANGELOG.md`、`docs/RELEASING.md` |
| Agent 协作规则 | `.agent/` 与本文件 |

## Git 与协作

- 提交和推送只在任务明确要求时执行。
- 不移动或重写已经公开的发布标签。
- 不提交 `node_modules`、`dist`、`src-tauri/target`、数据库、备份、提示词用户副本、密钥或真实课程文件。
- 与其他 Agent 并行工作时，先声明文件范围；不要覆盖或回退他人的修改。
- 交付说明以结果为先，列出关键文件、验证、已知 warning 和未完成风险。

## 权威资料

- Agent 导航：[.agent/README.md](.agent/README.md)
- 项目地图：[.agent/PROJECT_MAP.md](.agent/PROJECT_MAP.md)
- 贡献工作流：[.agent/CONTRIBUTION_PLAYBOOK.md](.agent/CONTRIBUTION_PLAYBOOK.md)
- 评审清单：[.agent/REVIEW_CHECKLIST.md](.agent/REVIEW_CHECKLIST.md)
- 用户与项目概览：[README.md](README.md)
- 架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 核心接口：[docs/CORE_API.md](docs/CORE_API.md)
- 模块协议：[MODULES.md](MODULES.md)

