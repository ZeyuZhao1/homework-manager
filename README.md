# 作业簿（Homework Manager）

面向 Windows 的本地优先大学作业管理应用。它把学期、课程、作业、提交信息和学习文件组织在一个桌面界面中，并通过可选的 AI 模块从课程公告或附件中提取作业草稿。

作业簿不是把文件复制进封闭资料库的云端服务。实际 PDF、图片和文档继续保留在原文件夹中，应用只保存结构化作业数据、文件路径、关联关系和操作历史。除非用户主动执行 AI 识别，否则应用不会上传学习内容。

当前版本：`v0.4.0`。目前正式发布目标为 Windows x64。

![作业簿界面](src/assets/hero.png)

## 核心能力

- **按学期和课程管理作业**：记录标题、描述、截止时间、处理状态、提交平台、链接、提交要求和自定义字段。
- **关注真正需要处理的事项**：总览、课程视图和全部作业视图支持未提交、进行中、待提交、逾期和已提交筛选。
- **关联而非搬运文件**：一个作业可关联多份题目、教材参考或解答；同一文件也可服务多个作业。
- **安全整理文件名**：重命名前预览目标和冲突，操作仅发生在原文件夹，并在文件未被外部修改时支持撤回。
- **保留文件审计轨迹**：记录关联、取消关联、重新定位、改名、撤回和应用外内容变化。
- **AI 辅助录入**：从公告文字、PDF、DOCX 或图片中识别多项作业，必须经用户逐条审核后才写入数据库。
- **可扩展模块系统**：内置模块与用户安装的本地进程模块使用能力名和版本化 JSON 协议协作。
- **本地数据与可恢复性**：SQLite 数据库支持导出、恢复和压缩；API Key 存入 Windows 凭据管理器。

## 下载与安装

从 [GitHub Releases](https://github.com/ZeyuZhao1/homework-manager/releases) 下载对应版本：

| 资产 | 用途 |
| --- | --- |
| `homework-manager-v<版本>-windows-x64-installer.exe` | 推荐使用的 NSIS 安装程序，会创建开始菜单入口 |
| `homework-manager-v<版本>-windows-x64-portable.exe` | 无需安装，可直接运行；仍使用当前 Windows 账户的 AppData 数据 |
| `SHA256SUMS.txt` | 两个可执行文件的 SHA-256 校验值 |

安装版和便携版使用同一数据库。移动便携版 EXE 不会迁移数据。

若系统提示缺少 WebView2，请安装 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。未签名的个人发行版可能触发 SmartScreen；请只从本仓库的 Releases 页面下载，并核对 SHA-256。验证示例：

```powershell
Get-FileHash .\homework-manager-v0.4.0-windows-x64-installer.exe -Algorithm SHA256
```

## 核心使用流程

### 1. 建立学期与课程

首次启动时应用至少保留一个学期。课程可以设置课程名、课程代码和对应的磁盘文件夹。课程文件夹用于内置浏览和搜索，但应用不会在启动时扫描整个目录。

当前版本包含一个面向项目作者环境的首次启动兼容逻辑：若 `D:\share\University\Year 1 Fall` 存在，会创建“2026 秋季”并关联其中已存在的课程文件夹；否则只创建空学期，不访问该路径。所有内容都可在“设置”中修改。

### 2. 创建和推进作业

作业状态使用以下固定流程：

| 内部值 | 界面名称 | 含义 |
| --- | --- | --- |
| `todo` | 待做 | 尚未开始 |
| `doing` | 进行中 | 正在完成 |
| `done` | 待提交 | 内容完成但尚未提交 |
| `submitted` | 已提交 | 已完成提交 |

截止时间可以为空。标题、提交平台、链接和提交要求会保留最近使用值，方便后续快速选择。每项作业还可保存最多 40 个自定义键值字段。

### 3. 关联学习文件

在作业详情中添加文件时，需要指定角色：

- `prompt`：题目材料；
- `reference`：教材或参考资料；
- `solution`：自己的解答。

课程文件夹选择器支持逐层浏览和按文件名搜索。搜索至少输入两个字符，最多返回 100 项；它只在用户搜索时运行。教材、补充题集等可设为课程常用文件，之后一键关联到作业。

应用只保存规范化后的绝对路径，不复制文件内容。若文件在应用外被移动，文件页会标记失效路径，并允许重新定位。

### 4. 统一命名与撤回

默认模板是：

```text
{course_code}-{material}-hw-{scope}
```

例如 `MA117-textbook-hw-s2.5&s2.6.pdf` 或 `MA117-extra-hw-ch3.pdf`。可用占位符包括：

| 占位符 | 内容 |
| --- | --- |
| `{course_code}` | 课程代码；为空时回退到课程名 |
| `{material}` | `textbook`、`extra`、`solution`、`assignment` 或用户输入 |
| `{scope}` / `{sections}` | 带 `s` 或 `ch` 前缀的节/章范围 |
| `{semester}` | 学期名 |
| `{course}` | 课程名 |
| `{assignment}` | 作业标题 |
| `{role}` | 文件角色的中文名称 |
| `{version}` | 可选版本文本 |

扩展名始终保留。应用会先检查原文件、目标冲突和模板占位符，再执行原地改名。撤回仅允许针对该文件最新、尚未撤回的改名；若文件内容、修改时间、当前位置或原文件名占用情况发生变化，应用会拒绝撤回以保护数据。

## AI 作业导入

AI 导入由内置模块 `builtin.ai.assignment-import` 提供。使用流程是：

1. 在设置中添加服务商、模型、地址和 API Key；
2. 为“作业识别”选择一个服务商；
3. 粘贴公告，可选附加 PDF、DOCX 或图片；
4. 点击“开始识别”后才会发送本次内容；
5. 在审核抽屉中修改课程、标题、DDL 和提交信息；
6. 确认后批量写入，附件作为题目材料关联，原文件不移动。

### 当前服务商能力

| 服务商/模型 | 文字 | 图片 | PDF | DOCX |
| --- | --- | --- | --- | --- |
| 百炼 `qwen3.8-*` | 支持 | 支持 | Base64 直传 | 不支持 |
| 百炼 `qwen-long*` | 支持 | 文件接口 | 文件接口 | 文件接口 |
| 百炼 `qwen-doc-turbo` | 支持 | 文件接口 | 文件接口 | 文件接口；一次最多一个文件 |
| DeepSeek `deepseek-flash` | 支持 | 支持 | 不支持 | 不支持 |
| Google Gemini | 支持 | 支持 | 原生内联 | 不支持 |
| 自定义 OpenAI 兼容接口 | 支持 | 取决于模型但当前未声明 | 不支持 | 不支持 |

单文件上限为 20 MB。普通请求超时 120 秒，包含 PDF 的请求超时 360 秒。百炼文件接口会在请求结束后尝试删除临时上传；网络异常时应在服务商后台检查残留文件。

模型输出不会直接落库。后端先验证 JSON、过滤无标题结果、清除格式非法的 `due_at`，再按课程名或课程代码匹配本地课程；不能唯一匹配的课程必须由用户审核选择。

运行时提示词位于：

```text
%APPDATA%\app.homeworkbook.local\modules\assignment-import\prompts
```

修改后下次识别立即生效。`assignment_user.txt` 必须保留 `{content}` 占位符；单个提示词文件不能超过 64 KB。

## 数据、隐私与备份

| 数据 | 位置 | 是否进入数据库备份 |
| --- | --- | --- |
| 学期、课程、作业、设置、文件路径和历史 | `%APPDATA%\app.homeworkbook.local\homework.db` | 是 |
| SQLite WAL 临时文件 | 数据库同目录 | 由 SQLite 管理 |
| AI 服务商 API Key | Windows 凭据管理器，服务名 `app.homeworkbook.local` | 否 |
| 可编辑提示词 | `%APPDATA%\app.homeworkbook.local\modules\assignment-import\prompts` | 否 |
| 外部模块及其文件 | `%APPDATA%\app.homeworkbook.local\modules\<模块目录>` | 否 |
| 实际学习文件 | 用户原始目录 | 否 |

备份使用 SQLite 在线备份接口生成完整数据库副本。恢复会替换当前数据库内容并重新初始化模块表，但不会复制、移动或删除磁盘上的学习文件。恢复旧备份后，失效路径可在“文件”页重新定位。

## 模块化设计

模块分为两类：

- **内置模块**：随应用编译，包含 Rust 后端和可按需加载的 React UI。当前内置模块是 AI 作业导入。
- **外部进程模块**：由用户放入 AppData 模块目录，通过标准输入/输出交换协议 v1 JSON；应用不会在启动时执行它们。

主程序负责权限边界和有副作用的操作：模块只能返回解析结果或建议，数据库写入、文件关联和文件重命名仍由核心执行。详细清单格式、调用流程、错误语义、能力契约和安全约束见 [MODULES.md](MODULES.md)。

## 技术架构

```text
React 19 + TypeScript + Vite
            │ typed service
            ▼
       Tauri 2 commands
       ├── SQLite / domain state
       ├── file operations + history
       ├── module host
       └── built-in AI assignment-import
            │
            ├── HTTPS model providers
            └── external module executables (JSON over stdio)
```

前端通过 `src/service.ts` 访问核心命令；浏览器模式使用同一接口的 LocalStorage 预览实现。Rust 后端把数据库、文件系统和模块宿主分开，Tauri 命令只在 `src-tauri/src/lib.rs` 中集中注册。

更深入的说明：

- [系统架构](docs/ARCHITECTURE.md)：分层、数据模型、关键数据流、运行时目录和一致性策略；
- [核心接口](docs/CORE_API.md)：前端服务、Tauri 命令、数据结构、错误和副作用；
- [模块协议](MODULES.md)：外部模块协议 v1 与内置模块扩展点；
- [开发指南](docs/DEVELOPMENT.md)：环境、脚本、修改路径、测试和排错；
- [发布指南](docs/RELEASING.md)：版本同步、标签工作流和发布资产；
- [贡献指南](CONTRIBUTING.md) 与 [安全策略](SECURITY.md)。

## 仓库结构

```text
.
├── src/                         React 应用、类型、核心服务和页面
├── src-tauri/
│   ├── src/db.rs                SQLite、领域数据和备份恢复
│   ├── src/files.rs             文件关联、浏览、重命名与历史
│   ├── src/modules.rs           模块发现、状态和进程宿主
│   └── src/lib.rs               Tauri 初始化与命令注册
├── modules/assignment-import/   内置 AI 作业导入模块
├── docs/                        架构、接口、开发和发布文档
├── .github/workflows/           校验与 Windows 发布工作流
└── MODULES.md                   外部模块协议规范
```

## 本地开发

### 环境要求

- Windows 10/11 x64；
- Node.js 24+；
- pnpm 11+；
- Rust stable；
- Visual Studio C++ Build Tools 与 Windows SDK；
- WebView2 Runtime。

### 启动桌面开发模式

```powershell
pnpm install --frozen-lockfile
pnpm desktop:dev
```

仅启动浏览器预览：

```powershell
pnpm dev
```

浏览器预览使用 LocalStorage 示例数据，不访问 SQLite、文件系统、凭据管理器或本地模块进程，因此不能替代桌面集成测试。

### 检查与构建

```powershell
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm desktop:build
```

桌面产物位于 `src-tauri/target/release/`，NSIS 安装包位于 `src-tauri/target/release/bundle/nsis/`。

## 当前边界

- 仅正式发布 Windows x64；移动平台图标存在于 Tauri 模板中，但没有对应发布或验证流程。
- 应用不内置账号同步、云数据库或跨设备同步。
- 外部模块由用户自行安装和信任；协议提供路径限制、能力检查和资源上限，但不是操作系统级沙箱。
- 教材页码/题号自动匹配目前只有数据契约，尚未执行模型调用。
- AI 结果受模型、账号权限和服务商 API 变化影响，始终需要人工审核。

## 参与项目

提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。项目尚未在仓库中声明开源许可证；在添加许可证前，请不要假设代码具有某种开放授权。
