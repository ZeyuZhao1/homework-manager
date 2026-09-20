# 编程 Agent 入门

`.agent/` 是作业簿仓库的 Agent 协作手册。它不替代面向用户和开发者的正式文档，而是告诉自动化编程 Agent：先读什么、任务落在哪、哪些约束不能破坏、怎样验证和交付。

## 1. 建议阅读顺序

### 快速修复或小改动

1. 根目录 [AGENTS.md](../AGENTS.md)；
2. 本文件；
3. [PROJECT_MAP.md](PROJECT_MAP.md) 中对应模块；
4. 将要修改的源文件及附近测试；
5. 对应正式文档。

### 跨层功能或数据变更

1. [AGENTS.md](../AGENTS.md)；
2. [PROJECT_MAP.md](PROJECT_MAP.md)；
3. [架构文档](../docs/ARCHITECTURE.md)；
4. [核心接口](../docs/CORE_API.md)；
5. [CONTRIBUTION_PLAYBOOK.md](CONTRIBUTION_PLAYBOOK.md)；
6. [REVIEW_CHECKLIST.md](REVIEW_CHECKLIST.md)。

### 模块或 AI 改动

再加读：

- [模块协议](../MODULES.md)；
- [AI 作业导入模块](../modules/assignment-import/README.md)；
- `modules/assignment-import/module.json`；
- `src-tauri/src/modules.rs`；
- `src/moduleTypes.ts` 与 `src/moduleRegistry.ts`。

## 2. 项目现状

- 产品名：作业簿（Homework Manager）；
- 当前版本：`0.4.0`；
- 正式平台：Windows x64；
- 前端：React 19、TypeScript、Vite；
- 桌面框架：Tauri 2；
- 后端：Rust；
- 数据库：bundled SQLite via rusqlite；
- 凭据：Windows Credential Manager via keyring；
- 包管理：pnpm 11；
- Node.js：24；
- 发布：GitHub Actions 标签 workflow。

核心产品原则：结构化数据归应用，实际学习文件归用户；AI 只辅助提取，用户最终确认；模块只提出结果，核心执行敏感写操作。

## 3. 任务路由

| 用户意图 | 主要入口 | 必须关注 |
| --- | --- | --- |
| 改页面布局/筛选/导航 | `src/App.tsx`, `src/pages.tsx`, `src/ui.tsx`, `src/App.css` | React 状态、可访问性、浏览器和桌面两种模式 |
| 改表单或抽屉 | `src/dialogs.tsx`, `src/optimizedDialogs.tsx` | 类型、确认流程、失败态、最近值 |
| 改领域数据/CRUD | `src-tauri/src/db.rs` | 事务、级联、schema、备份恢复、Snapshot |
| 改文件关联/浏览/改名 | `src-tauri/src/files.rs` | 路径边界、历史、安全撤回、数据库补偿 |
| 新增前后端接口 | Rust 命令 + `src-tauri/src/lib.rs` + `src/types.ts` + `src/service.ts` | 注册、预览实现、接口文档、测试 |
| 改模块发现/外部协议 | `src-tauri/src/modules.rs`, `MODULES.md` | 清单校验、能力检查、输入输出限制、超时 |
| 改 AI 提取 | `modules/assignment-import/` | 凭据、提供商差异、附件隐私、提示词迁移、审核边界 |
| 改备份/恢复 | `src-tauri/src/db.rs` | integrity check、user_version、WAL、模块表初始化 |
| 改构建或发布 | `package.json`, `src-tauri/*`, `.github/workflows/*` | 多处版本同步、Windows runner、资产名、哈希 |
| 只改文档 | `README.md`, `docs/`, `MODULES.md` | 必须对照实际代码，不猜测行为 |

## 4. Agent 的默认工作方式

### 先建立事实

- 先看 `git status`，辨别已有改动；
- 用 `rg` 搜索命令、类型、表和测试；
- 阅读完整调用链，而不是只看 UI 或单个函数；
- 对时效性依赖低的仓库事实，以当前源码为准；
- 若文档和代码冲突，先报告冲突，再按任务范围决定修代码或修文档。

### 再做最小完整改动

“最小”不是只改一处，而是完成该行为所需的全部层：类型、后端、前端服务、UI、测试和文档。避免顺手重写无关结构。

### 最后按风险验证

- 静态 UI：lint + build；
- Rust 逻辑：对应单测 + 全部 lib tests；
- 文件系统：临时目录/临时文件测试；
- schema/恢复：旧版本 fixture 或最小旧 schema 测试；
- 模块协议：成功、结构化失败、非零退出、大小/超时边界；
- 发布：desktop build + workflow 配置核对。

## 5. 协作约定

- 一个 Agent 在一个任务中尽量拥有清晰的文件范围；
- 并行工作前拆分成互不重叠的子任务；
- 共享文件（例如 `src/types.ts`、`src/service.ts`、`README.md`）由主任务统一整合；
- 不把其他 Agent 的未提交改动当作需要“清理”的噪声；
- 发现同文件冲突时停止覆盖，先比较双方意图；
- 不在没有用户授权时提交、推送、创建标签或发布；
- 交付时明确哪些是已验证事实，哪些是推断或尚未验证。

## 6. 常见误区

- **只改 React 类型，不改 Rust 序列化结构**：桌面模式会在运行时失败。
- **直接在组件里新增 `invoke`**：破坏预览实现和接口集中管理。
- **删除作业时顺便删除文件**：违背核心产品边界。
- **模块直接写 SQLite**：绕过事务、历史和审核。
- **把浏览器预览当成完整验证**：它不会运行 Rust、SQLite 或文件系统。
- **把外部模块称为安全沙箱**：当前只是受限宿主调用，不是进程隔离。
- **修改默认提示词并强制覆盖运行时文件**：会丢失用户定制。
- **只更新一个版本号**：发布时会出现标签、Tauri、Cargo 和模块不一致。
- **为了修复失败而移动公开标签**：破坏发布可追溯性。

## 7. 手册索引

- [PROJECT_MAP.md](PROJECT_MAP.md)：代码所有权、数据模型、调用链和运行时路径；
- [CONTRIBUTION_PLAYBOOK.md](CONTRIBUTION_PLAYBOOK.md)：按任务类型实施与验证；
- [REVIEW_CHECKLIST.md](REVIEW_CHECKLIST.md)：代码评审、风险优先级和交付前检查。

