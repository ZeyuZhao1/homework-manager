# 开发指南

本文面向准备在本地运行、调试或扩展作业簿的开发者。系统设计见 [ARCHITECTURE.md](ARCHITECTURE.md)，前后端接口见 [CORE_API.md](CORE_API.md)，外部模块协议见 [MODULES.md](../MODULES.md)。

使用自动化编程 Agent 贡献时，还应先阅读根目录 [AGENTS.md](../AGENTS.md) 和 [.agent 协作手册](../.agent/README.md)。

## 1. 环境要求

当前开发和发布流程以 Windows x64 为准：

- Windows 10/11；
- Git；
- Node.js 24 或更高版本；
- pnpm 11；
- Rust stable 与 Cargo；
- Visual Studio C++ Build Tools；
- Windows 10/11 SDK；
- Microsoft Edge WebView2 Runtime。

确认环境：

```powershell
node --version
pnpm --version
rustc --version
cargo --version
```

## 2. 安装依赖

```powershell
git clone https://github.com/ZeyuZhao1/homework-manager.git
Set-Location homework-manager
pnpm install --frozen-lockfile
```

Rust 依赖会在第一次 `cargo test` 或 Tauri 构建时由 Cargo 下载。`rusqlite` 使用 bundled SQLite，不要求系统预装 SQLite 开发库。

## 3. 运行模式

### 3.1 桌面开发模式

```powershell
pnpm desktop:dev
```

Tauri 会先执行 `pnpm dev`，Vite 固定监听 `127.0.0.1:1420`，随后启动桌面窗口。该模式使用真实 AppData、SQLite、文件系统和 Windows 凭据管理器。

开发数据库默认位于：

```text
%APPDATA%\app.homeworkbook.local\homework.db
```

它与安装版和便携版共享。调试会修改真实数据时，应先在应用中导出备份；不要把本地数据库复制进仓库。

### 3.2 浏览器预览模式

```powershell
pnpm dev
```

打开终端显示的本地地址。浏览器模式使用 `homeworkbook-preview` LocalStorage 键保存示例状态，适合快速调 UI，但有以下差异：

- 不使用真实 SQLite；
- 不访问课程目录或文件元数据；
- 文件选择和系统打开操作为空实现；
- 不读取 Windows 凭据；
- 不启动外部模块；
- AI 返回演示草稿。

需要重置预览数据时，在浏览器开发者工具中删除 `homeworkbook-preview`、`homeworkbook-assignment-import-preview` 和模块状态相关键。

## 4. 常用脚本

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 启动 Vite 浏览器预览 |
| `pnpm build` | TypeScript project build 后生成 Vite 生产资源 |
| `pnpm lint` | 使用 oxlint 检查 `src`、`modules` 和 `vite.config.ts` |
| `pnpm preview` | 预览已经生成的 `dist` |
| `pnpm desktop:dev` | 启动 Tauri 桌面开发模式 |
| `pnpm desktop:build` | 生成 release EXE 和 NSIS 安装包 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 运行 Rust 库测试 |

完整本地验证：

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm desktop:build
```

`pnpm lint` 当前可能报告 React Fast Refresh 或 effect 中同步更新状态的 warning；退出码为 0 时不会阻塞构建。新增代码不应引入 error，并应尽量减少现有 warning。

## 5. 源码导航

### 5.1 修改用户界面

- 导航、筛选、应用级刷新：`src/App.tsx`；
- 文件页和设置页：`src/pages.tsx`；
- 作业表格和详情：`src/ui.tsx`；
- 编辑器/抽屉：`src/dialogs.tsx`、`src/optimizedDialogs.tsx`；
- 全局样式：`src/App.css`；
- 前端共享类型：`src/types.ts`。

组件不应直接访问 SQLite 或自己散落 `invoke`。需要后端能力时先扩展 `src/service.ts`。

### 5.2 修改核心数据

- 表结构、启动初始化和快照：`src-tauri/src/db.rs`；
- 文件关联、浏览、搜索和改名：`src-tauri/src/files.rs`；
- 命令注册：`src-tauri/src/lib.rs`；
- 前端映射：`src/types.ts`、`src/service.ts`。

改变 schema 时必须考虑：

1. 新安装建表；
2. 旧数据库升级；
3. 版本 1–4 备份恢复后的补表；
4. `PRAGMA user_version`；
5. Snapshot 序列化兼容；
6. Rust 测试中的最小测试 schema。

当前迁移主要采用 `CREATE TABLE IF NOT EXISTS` 和兼容更新；复杂变更应引入明确的顺序迁移，而不是继续叠加隐式语句。

### 5.3 修改内置 AI 模块

模块全部源码位于 `modules/assignment-import/`：

- `backend.rs`：能力实现、配置、凭据和服务商 HTTP；
- `frontend/`：入口、审核抽屉、设置卡和模块服务；
- `provider-presets.json`：新增服务商时的默认地址/模型；
- `prompts/`：编译进程序的默认提示词；
- `module.json`：内置描述符元数据。

模块版本应与应用版本保持一致。详细约定见 [模块 README](../modules/assignment-import/README.md)。

### 5.4 新增外部模块能力

若能力可由独立 EXE 完成，优先保持外部模块协议：

1. 在 `MODULES.md` 定义输入/结果；
2. 在模块清单声明能力；
3. 使用 `service.invokeModule` 调用；
4. 对任何数据库写入或文件改名增加核心审核和执行接口；
5. 添加资源限制和失败路径测试。

外部模块当前不能动态注入 React UI。若需要完整 UI，只能新增编译期内置模块或在核心界面中增加通用能力 UI。

## 6. 新增 Tauri 命令

推荐顺序：

1. 在 `db.rs`、`files.rs` 或合适的新模块中定义序列化类型；
2. 实现不依赖 `State` 的内部函数，方便单元测试；
3. 用薄的 `#[tauri::command]` 包装内部函数；
4. 在 `src-tauri/src/lib.rs` 的 `generate_handler!` 注册；
5. 在 `src/types.ts` 增加 TypeScript 类型；
6. 在 `src/service.ts` 增加桌面调用和浏览器预览行为；
7. 在 UI 中只调用服务；
8. 更新 [CORE_API.md](CORE_API.md)。

所有写命令都应明确：输入校验、事务边界、级联影响、文件系统补偿、错误信息和用户确认位置。

## 7. 测试策略

### 7.1 Rust 单元测试

现有测试覆盖：

- 作业批量保存与共享附件的事务性；
- 数据库备份和恢复；
- 文件冲突与安全撤回；
- 模块清单路径和 ID 校验；
- AI 输出解析、课程匹配和无效 DDL；
- 提示词迁移与占位符；
- 各服务商文件能力；
- Gemini 请求结构；
- 模拟 HTTP 响应和超时。

运行单个测试：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib modules::assignment_import::tests::unknown_course_requires_review
```

涉及文件系统的测试应使用随机临时目录，并在完成后清理；不要依赖开发者真实课程目录。

### 7.2 前端验证

当前仓库没有独立前端测试框架，最低要求是：

```powershell
pnpm lint
pnpm build
```

对交互改动还应在浏览器预览中检查布局，并在 Tauri 桌面模式验证至少一个真实后端流程。涉及文件改名时使用临时文件，不要使用唯一副本。

### 7.3 发布构建

`pnpm desktop:build` 是本地端到端打包检查。release profile 开启体积优化、LTO、单 codegen unit、strip 和 `panic=abort`，因此首次构建会比开发编译慢。

## 8. 数据和凭据调试

### 8.1 不要提交的内容

- `node_modules/`；
- `dist/`；
- `src-tauri/target/`；
- 本地 `homework.db`、WAL/SHM 和备份；
- AppData 下的自定义提示词；
- API Key、访问令牌或带敏感正文的模型日志；
- 本地课程文件。

### 8.2 重置开发数据

优先在应用中建立新的测试学期或恢复备份。若必须手工重置，应先关闭所有作业簿进程并备份准确的 AppData 目录；数据库、WAL 和 SHM 是一个整体，不能在应用运行时随意删除其中一部分。

### 8.3 API Key

服务名为 `app.homeworkbook.local`，账户键使用服务商 UUID。应用只返回 `has_key`，不会把已保存密钥重新展示到前端。删除服务商会尝试删除对应凭据。

## 9. 常见问题

### Vite 端口被占用

开发服务器使用固定端口 1420。结束占用进程后重试；不要随意改端口而不同步 `src-tauri/tauri.conf.json` 的 `devUrl`。

### Windows 链接器或 `windows.h` 相关错误

确认 Visual Studio Installer 中已安装“使用 C++ 的桌面开发”和 Windows SDK，然后从新的终端运行构建。

### 缺少 WebView2

安装 Evergreen WebView2 Runtime 后重新启动应用。

### Rust 构建时间很长

首次 release 构建会完整编译 Tauri、reqwest 和 Windows 依赖。后续增量构建通常更快；不要删除 `src-tauri/target` 作为普通排错第一步。

### AI 配置存在但提示没有 Key

数据库只保存服务商元数据，密钥在 Windows 凭据管理器。换 Windows 账户、恢复数据库或迁移到新设备后需要重新输入 API Key。

### 浏览器预览正常但桌面失败

预览服务绕过了 Rust 和本地系统集成。检查 Tauri 终端错误，并直接运行相关 Rust 测试；不要把预览成功当作桌面集成通过。

## 10. Pull Request 前检查

```powershell
git diff --check
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

若改动影响打包，再运行 `pnpm desktop:build`。PR 描述应包含用户可见变化、数据/文件副作用、验证命令和必要的迁移说明。
