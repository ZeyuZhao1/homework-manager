# 项目地图

本文帮助 Agent 在修改前建立代码全景。更详细的数据流和 ER 图见 [架构文档](../docs/ARCHITECTURE.md)，逐项接口见 [核心接口参考](../docs/CORE_API.md)。

## 1. 仓库布局

```text
.
├── AGENTS.md                    Agent 全仓规则
├── .agent/                      Agent 导航、项目地图和工作流
├── src/                         React/TypeScript 核心前端
├── src-tauri/                   Tauri/Rust 桌面后端与打包配置
├── modules/assignment-import/   内置 AI 作业导入模块
├── docs/                        架构、接口、开发和发布文档
├── .github/workflows/           校验与 Windows 发布流程
├── README.md                    用户与项目概览
├── MODULES.md                   外部模块协议
└── package.json                 前端与 Tauri 脚本
```

## 2. 启动路径

```text
src/main.tsx
  └─ React renders src/App.tsx

src-tauri/src/main.rs
  └─ homework_manager_lib::run()
      └─ src-tauri/src/lib.rs
          ├─ initialize dialog/opener plugins
          ├─ db::init(app.handle())
          │   ├─ resolve AppData
          │   ├─ open/create homework.db
          │   ├─ create/upgrade core schema
          │   ├─ initialize default semester/course mappings
          │   └─ modules::initialize()
          ├─ manage AppState
          └─ register explicit Tauri commands
```

`AppState` 只包含：

- `Mutex<rusqlite::Connection>`；
- AppData 下的模块根目录路径。

新增全局状态前先判断它是否真的需要跨命令持久存在；优先把持久事实放在 SQLite，把请求级数据留在局部变量。

## 3. 前端地图

### `src/App.tsx`

职责：

- 加载和刷新完整 `Snapshot`；
- 管理视图、当前学期/课程、选中作业、筛选和搜索；
- 协调编辑器、文件抽屉、重命名对话框和模块浮层；
- 根据后端模块描述符过滤内置模块入口；
- 在成功写操作后重新读取后端状态。

不要在这里复制后端校验逻辑。前端可做即时提示，但 Rust 仍必须验证所有外部输入。

### `src/pages.tsx`

- `FilesPage`：文件搜索、类型/课程/失效筛选、关系和历史、重新定位、撤回改名；
- `SettingsPage`：主题、命名模板、学期课程、模块开关、模块目录和数据库维护。

### `src/ui.tsx`

作业表格、详情、状态显示、DDL 状态和文件历史摘要。该文件同时导出若干工具函数，现有 lint 会提示 Fast Refresh warning；不要在无关任务中重排整个文件。

### `src/dialogs.tsx` 与 `src/optimizedDialogs.tsx`

- 学期/课程编辑；
- 作业编辑与自定义字段；
- 文件浏览、系统选择、批量关联和常用文件；
- 重命名参数、预览、冲突提示和确认。

### `src/types.ts`

核心前端契约。与 Rust 序列化结构共同定义桌面边界。改字段时搜索全部构造位置，包括：

- `blankAssignment`；
- 浏览器预览示例；
- AI `saveDrafts` 映射；
- Rust 测试 fixture；
- 表单初始值。

### `src/service.ts`

统一提供桌面和浏览器预览实现：

```text
UI -> service.method()
          ├─ Tauri: invoke(command)
          └─ Browser: mutate/read previewState + LocalStorage
```

新增方法时两条路径都必须编译。无法在浏览器真实模拟的系统能力，应返回空/明确错误，而不是伪造危险成功。

### `src/moduleTypes.ts` / `src/moduleRegistry.ts`

- `AppModule` 定义内置模块的 `Action`、`Overlay`、`SettingsCard`；
- `import.meta.glob` 在构建时发现 `modules/*/frontend/index.tsx`；
- 这是编译期机制，不会加载 AppData 中外部模块的前端代码。

## 4. Rust 后端地图

### `src-tauri/src/db.rs`

核心职责：

- AppData、SQLite 和 schema 初始化；
- 学期、课程、作业与设置；
- 完整 Snapshot 装配；
- 最近值与自定义字段；
- 批量 AI 草稿保存；
- 删除语义与无引用文件记录清理；
- 在线备份、完整性检查、恢复和压缩。

关键事实：

- `PRAGMA foreign_keys=ON`；
- WAL 模式；
- 当前 `user_version=4`；
- 恢复接受版本 1–4；
- 至少保留一个学期；
- Snapshot 读取可能记录外部文件变化。

### `src-tauri/src/files.rs`

核心职责：

- 规范化和验证文件路径；
- 单个/批量关联与常用文件；
- 打开、重新定位；
- 在课程根目录内浏览和搜索；
- 根据模板生成改名预览；
- 原地改名、数据库同步和失败补偿；
- 使用大小/mtime 安全撤回；
- 统一写 `file_history`。

改这里时重点审查：路径穿越、重复路径、TOCTOU、跨文件系统行为、数据库失败后的文件状态、Windows 非法文件名和真实文件误删。

### `src-tauri/src/modules.rs`

核心职责：

- 初始化内置模块；
- 外部 `module.json` 发现与校验；
- 模块启用状态；
- 内置能力分派；
- 外部 EXE JSON over stdio 调用；
- 2 MB 输入、4 MB stdout、120 秒超时。

外部进程直接以当前用户权限启动。宿主不使用 shell，但也没有 OS 沙箱。

### `src-tauri/src/lib.rs`

Tauri 命令注册清单。定义命令但忘记在这里注册，会导致前端运行时找不到命令。

### `src-tauri/tauri.conf.json`

- 产品名与版本；
- 标识符 `app.homeworkbook.local`；
- 开发地址 `127.0.0.1:1420`；
- 前端构建命令和 `dist`；
- Windows 窗口尺寸；
- 当前 CSP 为 `null`；
- bundle 目标为 NSIS。

## 5. 内置 AI 模块地图

### 后端 `modules/assignment-import/backend.rs`

包含：

- 内置模块描述符和 `assignment.extract` 分派；
- 模块表初始化和旧配置迁移；
- Windows 凭据读写；
- 提示词初始化、迁移和占位符；
- 文件类型/模型能力校验；
- 百炼、DeepSeek、自定义 OpenAI 兼容请求；
- Gemini 原生请求；
- JSON 提取、DDL 清理和课程匹配。

敏感边界：

- 用户点击识别前不发送内容；
- URL 必须 HTTPS，本地 loopback 例外；
- 单文件 20 MB；
- 普通请求 120 秒，含 PDF 360 秒；
- API Key 不返回前端；
- 模型结果不直接写核心表。

### 前端 `modules/assignment-import/frontend/`

- `index.tsx`：注册内置模块 UI；
- `Dialogs.tsx`：输入、调用、审核和确认保存；
- `SettingsCard.tsx`：服务商、模型路由、提示词目录和开关；
- `service.ts`：模块命令与核心批量保存的桥接；
- `types.ts`：Provider、ModuleConfig、AiDraft、AiResult。

### 资源

- `provider-presets.json` 只提供 UI 默认值，不是能力白名单；
- `prompts/` 编译进默认值；
- 运行时提示词在 AppData 中，用户修改不可被无条件覆盖；
- `prompts/legacy/` 用于识别“仍是旧默认”的安全升级场景。

## 6. 数据模型速查

```text
Semester 1 ── * Course 1 ── * Assignment
                              *
                              │ assignment_files
                              *
                           FileAsset

Course * ── * FileAsset via common_files
FileAsset 1 ── * rename_history
FileAsset 1 ── * file_history
Assignment 1 ── * assignment_custom_fields
```

### 核心当前态

- `semesters`
- `courses`
- `assignments`
- `assignment_custom_fields`
- `file_assets`
- `assignment_files`
- `common_files`
- `settings`
- `recent_values`
- `module_states`

### 审计/撤回态

- `file_history`：历史事件流，即使当前关联删除仍保留；
- `rename_history`：改名栈和撤回状态。

### 模块私有态

- `assignment_import_providers`；
- `assignment_import_settings`。

API Key 不属于任何表。

## 7. 关键不变量

### 数据不变量

- Course 必须属于 Semester；
- Assignment 必须属于 Course；
- Assignment title 非空；
- Assignment status 仅四个值；
- 一个文件路径在 `file_assets` 中唯一；
- 文件角色仅 `prompt` / `reference` / `solution`；
- 常用文件类型仅 `textbook` / `extra` / `other`；
- 至少存在一个 Semester。

### 文件不变量

- 保存关联前路径必须真实存在且为文件；
- 课程浏览路径必须仍在课程根目录内；
- 改名不能覆盖既有目标；
- 撤回只能针对最新有效改名；
- 文件签名变化后拒绝撤回；
- 删除数据库记录不删除真实文件。

### 模块不变量

- 外部 ID/能力只使用小写字母、数字、点、连字符，最长 100；
- 外部 ID 不能以 `builtin.` 开头；
- 外部 executable 必须规范化后位于模块目录；
- 调用能力必须在清单声明；
- 禁用模块不得执行；
- 响应必须是 protocol 1 JSON 且包含 `result`，或返回结构化错误。

## 8. 运行时位置

```text
%APPDATA%\app.homeworkbook.local\
├── homework.db
├── homework.db-wal / homework.db-shm
└── modules\
    ├── assignment-import\prompts\
    └── <external-module>\
```

安装版和便携版共享这些数据。实际学习文件仍在课程或用户选择的目录中。

## 9. 命令与数据流索引

完整表见 [CORE_API.md](../docs/CORE_API.md)。常用链路：

```text
Manual save:
AssignmentEditor -> service.saveAssignment -> save_assignment -> transaction -> refresh Snapshot

AI import:
Overlay -> service.invokeModule(assignment.extract)
        -> built-in backend -> provider API -> drafts
        -> user review
        -> saveDrafts -> save_assignments_batch -> one transaction

File rename:
RenameDialog -> previewRename -> user confirm -> renameFile
             -> fs::rename -> DB transaction
             -> on DB failure attempt filesystem rollback

External module:
UI/core -> invoke_module -> enabled/capability/path checks
        -> spawn EXE -> stdin request -> stdout response -> result
```

## 10. 已知技术边界

- 正式发布仅 Windows x64；
- 没有账号、云同步或跨设备同步；
- Snapshot 是全量读取，数据规模很大时需要分页演进；
- schema 迁移目前以兼容建表/更新为主，复杂演进需要显式迁移框架；
- 当前没有独立前端测试框架；
- CSP 为 `null`，新增远程内容需重新评估；
- 外部模块没有签名、来源验证、自动更新或 OS 沙箱；
- 教材页码/题号模型匹配只有预留契约；
- lint 有现存 React warning，不等于检查失败。

