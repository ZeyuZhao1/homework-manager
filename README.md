# 作业簿（Homework Manager）

基于 Tauri 的本地优先大学作业管理应用，核心功能支持 Windows、macOS 和 Linux 的原生构建。它把学期、课程、作业、提交信息和学习文件组织在一个桌面界面中，并通过可选的 AI 模块从课程公告或附件中提取作业草稿。

作业簿不是把文件复制进封闭资料库的云端服务。实际 PDF、图片和文档继续保留在原文件夹中，应用只保存结构化作业数据、文件路径、关联关系和操作历史。只有用户主动执行 AI 识别、选择联网模块或启用自己的云同步服务时，才会按相应确认流程发送相关数据；附件内容每次上传都需单独确认。

当前发布版本：[`v0.6.0`](https://github.com/ZeyuZhao1/homework-manager/releases/tag/v0.6.0)。原生构建目标为 Windows x64/ARM64、macOS ARM64、Linux x64/ARM64，系统要求与限制见 [平台支持](docs/PLATFORMS.md)。本次变化见 [CHANGELOG.md](CHANGELOG.md)。

**多设备同步与网页版需要使用者自行部署。** 每位使用者在自己的 Cloudflare 账户中创建服务、私有 R2 桶和设备授权；本仓库与公开安装包不提供维护者的云服务地址、凭据或基础设施使用权。桌面本地功能无需部署。开始前请阅读[Cloudflare 自托管指南](deploy/cloudflare/README.md)。

桌面服务地址由用户数据目录的独立 `services.json` 控制，修改后无需重新编译，GitHub 安装包正常更新会保留已有配置。设备密钥仍留在系统凭据库，格式与迁移方式见[客户端服务配置](docs/SERVICE_CONFIG.md)（未发布功能）。

![作业簿界面](src/assets/hero.png)

## 核心能力

- **按学期和课程管理作业**：记录标题、描述、截止时间、处理状态、提交平台、链接、提交要求和自定义字段。
- **关注真正需要处理的事项**：总览、课程视图和全部作业视图支持未提交、进行中、待提交、逾期和已提交筛选。
- **关联而非搬运文件**：一个作业可关联多份题目、教材参考或解答；同一文件也可服务多个作业。
- **按关联位置打开文档**：可选的热加载模块会预索引 PDF、Word 或 HTML 目录；关联中填写页码或章节后，点击文件名可直接定位。
- **系统文件打印**：Windows、macOS、Linux 内置系统打印入口，由系统对话框选择打印机及参数，无需专用打印程序；可选兼容外部模块。
- **安全整理文件名**：重命名前预览目标和冲突，操作仅发生在原文件夹，并在文件未被外部修改时支持撤回。
- **保留文件审计轨迹**：记录关联、取消关联、重新定位、改名、撤回和应用外内容变化。
- **AI 辅助录入**：从公告文字、PDF、DOCX 或图片中识别多项作业，必须经用户逐条审核后才写入数据库。
- **通用作业导入审核**：可读取兼容外部模块提供的作业快照，审核后创建、关联或更新作业；本仓库不附带学校同步模块。
- **周期作业**：内置周期模块支持定时、序列、教学周与自定义日期，提供周期时间线和共享文件。
- **可扩展模块系统**：内置模块与用户安装的本地进程模块使用能力名和版本化 JSON 协议协作。
- **本地数据与可恢复性**：SQLite 数据库支持导出、恢复和压缩；API Key 存入系统安全凭据存储（Windows 凭据管理器、macOS Keychain、Linux Secret Service）。
- **可选个人云同步与网页版**：默认关闭，开启后在授权设备间同步业务数据；附件内容逐次确认上传。云端使用用户私有的 Cloudflare 基础设施，配置见[云同步指南](docs/SYNC.md)。
- **Google Drive 关联**：已授权设备可浏览选择或粘贴 Drive 链接，关联只保存文件信息，点击在 Drive 打开；支持按需刷新名称与可访问状态，配置见[云同步指南](docs/SYNC.md)。
- **手机布局**：背景延伸至顶部安全区，手机 PWA 禁用双指页面缩放；学习概览显示作业状态，文件关联按需展开。编辑表单适配窄屏并独立滚动，返回恢复列表位置，模块设置按需展开。

## 下载与安装

从 [GitHub Releases](https://github.com/ZeyuZhao1/homework-manager/releases) 下载对应版本：

| 资产 | 用途 |
| --- | --- |
| `homework-manager-v<版本>-windows-<x64或arm64>-installer.exe` | 对应架构的 Windows NSIS 安装程序 |
| `homework-manager-v<版本>-windows-<x64或arm64>-portable.exe` | 对应架构的 Windows 便携程序 |
| `homework-manager-v<版本>-macos-arm64.dmg` | Apple Silicon Mac 安装包；当前仅 ad-hoc 签名，未公证 |
| `homework-manager-v<版本>-linux-<x64或arm64>.deb` | 对应架构的 Debian/Ubuntu 安装包 |
| `homework-manager-v<版本>-linux-<x64或arm64>.AppImage` | 对应架构的 AppImage；glibc 兼容基线见平台文档 |
| `SHA256SUMS.txt` | 所有九项发布资产的 SHA-256 校验值 |

安装版和便携版使用同一数据库。移动便携版 EXE 不会迁移数据。

若系统提示缺少 WebView2，请安装 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。未签名的个人发行版可能触发 SmartScreen；请只从本仓库的 Releases 页面下载，并核对 SHA-256。验证示例：

```powershell
Get-FileHash .\homework-manager-v0.6.0-windows-x64-installer.exe -Algorithm SHA256
```

## 核心使用流程

### 1. 建立学期与课程

首次启动时应用至少保留一个学期。课程可以设置课程名、课程代码和对应的磁盘文件夹。课程文件夹用于内置浏览和搜索，但应用不会在启动时扫描整个目录。

顶部使用随主题变化的应用标题栏，支持拖动、最小化、最大化/还原和关闭；课程列表保留滚动能力但隐藏滚动条。应用启动时以窗口化模式居中显示，默认内容区域最大为 1200×800 逻辑像素；小屏幕或高缩放比例下会自动缩小，为任务栏和窗口四周留出空间。

外观支持浅色、深色与跟随系统，选择后立即保存；跟随系统时可随设备配色实时切换。手机顶部安全区沿用页面背景，日期时间选择保持原生选择能力并适配窄屏。

iOS 主屏幕应用使用系统跟随页面的状态区模式；旧图标可能缓存安装时的窗口配置。更新后仍出现固定颜色时，参见[手机 PWA 顶部显示说明](docs/SYNC.md#手机-pwa-顶部显示)。

当前版本包含一个面向项目作者环境的首次启动兼容逻辑（仅 Windows）：若 `D:\share\University\Year 1 Fall` 存在，会创建“2026 秋季”并关联其中已存在的课程文件夹；否则只创建空学期，不访问该路径。所有内容都可在“设置”中修改。

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

右键点击作业详情中的关联文件，可选择“统一命名”、“打印”和“打印选项与配置”。这些操作不再固定显示在文件名右侧。也可选择“打开所在文件夹”，在系统文件浏览器中查看该文件的目录。左键点击文件名仍会打开文件；文件丢失但原文件夹仍存在时，也可打开原目录。键盘可使用菜单键或 Shift+F10 调出菜单，按 Esc 关闭。此系统操作仅在桌面应用中可用。

点击“打印”后，应用在当前窗口后台准备所选文件，随后直接打开系统打印对话框，不跳转页面或显示额外预览窗口；打印机、份数、页码、纸张、方向及单双面等由系统控制，确认后才会打印。加密 PDF 会先在应用内提示输入密码，取消输入不会打开打印对话框。支持 PDF、PNG、JPEG、WebP、GIF、BMP；Office 等其他文档请先导出为 PDF。文件及字体、解码资源全部在本地处理，系统选择网络打印机时由系统负责发送。PDF 按 150 DPI 准备，单文件不超过 50 MiB，累计渲染不超过 8000 万像素；超限时请先导出所需页面。关联中的教材页码不会自动作为打印页码。取消、打开对话框均不代表已提交或完成，请在系统打印队列查看进度。

已安装的 `file.print` 外部模块仍可在“打印选项与配置”中手动选择；其默认配置和可选客户端认证继续由模块管理，旧配置不自动导入系统打印。系统打印不依赖外部模块，也不会自动启动学校客户端。

### 4. 文档定位、统一命名与撤回

文档定位是可选的外部能力，本仓库不附带实现。用户安装声明 `document.navigation.index` / `document.navigation.open` 的兼容模块后，在设置中刷新即可发现。模块只接收已关联且未失效的文件清单；具体格式和定位支持由模块决定。

在作业关联中填写页码或章节后，点击文件名可请求定位；未安装模块时回退到系统默认程序。

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

## 周期作业与导入审核

内置 [周期作业模块](modules/recurring-assignments/README.md) 支持每 N 天、周、月、完成后接续、教学周和指定日期清单，可设置截止规则、结束条件及共享文件。调度在应用运行和读取快照时执行；补齐超过 10 项时需审核。关闭模块或删除周期定义不会删除已有作业和磁盘文件。

安装声明 `assignment.sync.snapshot` 的外部模块后，可在“导入待审核”预览来源作业变化。用户确认后才会建立课程映射、创建或更新作业；来源缺席不会触发删除。仓库仅提供通用审核宿主，不包含学校登录、网页解析或外部同步实现。

## AI 作业导入

AI 导入由内置模块 `builtin.ai.assignment-import` 提供。使用流程是：

1. 在设置中添加服务商、模型、地址和 API Key；
2. 为“作业识别”选择一个服务商；
3. 在输入框直接粘贴公告文字或截图（Ctrl+V），也可选择 PDF、DOCX 或图片；
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

模型输出不会直接落库。后端兼容 JSON 外围代码块、说明文字及空值字段，过滤无标题结果、清除格式非法的 `due_at`，再按课程名或课程代码匹配本地课程；不能唯一匹配的课程必须由用户审核选择。输出截断、拒答或字段类型错误会给出具体提示，不导入不完整结果。

运行时提示词位于：

```text
%APPDATA%\app.homeworkbook.local\modules\assignment-import\prompts
```

修改后下次识别立即生效。`assignment_user.txt` 必须保留 `{content}` 占位符；单个提示词文件不能超过 64 KB。

## 数据、隐私与备份

下表以 Windows 目录为例；macOS、Linux 数据位置和凭据存储要求见[平台支持](docs/PLATFORMS.md)。

| 数据 | 位置 | 是否进入数据库备份 |
| --- | --- | --- |
| 学期、课程、作业、设置、文件路径和历史 | `%APPDATA%\app.homeworkbook.local\homework.db` | 是 |
| SQLite WAL 临时文件 | 数据库同目录 | 由 SQLite 管理 |
| AI 服务商 API Key | 对应系统的安全凭据存储，服务名 `app.homeworkbook.local` | 否 |
| 可编辑提示词 | `%APPDATA%\app.homeworkbook.local\modules\assignment-import\prompts` | 否 |
| 外部模块及其文件 | `%APPDATA%\app.homeworkbook.local\modules\<模块目录>` | 否 |
| 实际学习文件 | 用户原始目录 | 否 |

备份使用 SQLite 在线备份接口生成完整数据库副本。恢复会替换当前数据库内容并重新初始化模块表，但不会复制、移动或删除磁盘上的学习文件。恢复旧备份后，失效路径可在“文件”页重新定位。

## 模块化设计

模块分为两类：

- **内置模块**：随应用编译，包含 Rust 后端和可按需加载的 React UI。当前包括 AI 作业导入与周期作业；周期规则、时间线和界面代码均位于各自的 `modules/` 目录。
- **外部进程模块**：由用户放入 AppData 模块目录，通过标准输入/输出交换协议 v1 JSON；支持原生可执行文件和无需编译的 PowerShell 入口。模块不会仅因清单发现而执行，只有用户操作或已声明的宿主集成事件才会调用。

仓库仅维护 `assignment-import` 和 `recurring-assignments` 两个模块，后端由 `modules/registry.rs` 注册，前端在构建时发现。其他模块由用户另行安装在 AppData，源码不随本仓库上传；已有历史提交不重写。

主程序负责权限边界和有副作用的操作：模块只能返回解析结果或建议，数据库写入、文件关联和文件重命名仍由核心执行。详细清单格式、调用流程、错误语义、能力契约和安全约束见 [MODULES.md](MODULES.md)。

## 技术架构

可选个人多设备同步及网页版的配置、范围和平台差异见[云同步指南](docs/SYNC.md)。桌面同步默认关闭；附件内容需要逐次确认上传。可在已授权网页绑定 GitHub / Google，之后通过已绑定账号登录新设备；两种提供商分别以私有配置启用。当前源码的云端测试使用本地模拟，私人 Cloudflare 配置不进入本仓库。

```text
React 19 + TypeScript + Vite
            │ typed service
            ▼
       Tauri 2 commands
       ├── SQLite / domain state
       ├── file operations + history
       ├── module host
       └── built-in modules (assignment-import / recurring-assignments)
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
│   ├── src/import_sync.rs       通用导入预览、映射和审核持久化
│   ├── src/modules.rs           模块发现、状态和进程宿主
│   └── src/lib.rs               Tauri 初始化与命令注册
├── modules/assignment-import/   内置 AI 作业导入模块
├── modules/recurring-assignments/ 内置周期作业模块
├── modules/registry.rs           内置模块后端注册清单
├── cloud/                        可选 Worker 服务源码与合成本地模拟配置
├── deploy/cloudflare/            自托管指南与占位模板（实际配置在仓库外）
├── scripts/                      私有配置生成、部署及仓库检查
├── docs/                        架构、接口、开发和发布文档
├── .github/workflows/           校验与 Windows 发布工作流
└── MODULES.md                   外部模块协议规范
```

## 本地开发

### 环境要求

以下为 Windows 环境要求；macOS、Linux 依赖及五个平台的构建矩阵见[平台支持](docs/PLATFORMS.md)。

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
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm desktop:build
```

桌面产物位于 `src-tauri/target/release/`，NSIS 安装包位于 `src-tauri/target/release/bundle/nsis/`。

## 当前边界

- main 的核心构建目标为 Windows x64/ARM64、macOS ARM64、Linux x64/ARM64；新平台是否已有发行包以 Release 资产为准。移动平台不在本轮支持范围。
- 系统打印使用三个桌面平台的原生接口；外部打印模块和依赖 PowerShell 的模块仍需独立适配。macOS 包当前仅 ad-hoc 签名，Linux 构建基线为 Ubuntu 24.04；详见平台文档。
- 多设备同步需要自行配置私有 Cloudflare 服务；默认关闭，不提供公开账号注册。网页仅支持在线使用，桌面保留离线能力。
- 外部模块由用户自行安装和信任；协议提供路径限制、能力检查和资源上限，但不是操作系统级沙箱。
- 文档定位和外部作业同步需要用户另行安装兼容模块；系统打印已内置，其他打印实现可另行安装。
- AI 结果受模型、账号权限和服务商 API 变化影响，始终需要人工审核。

## 参与项目

提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。项目尚未在仓库中声明开源许可证；在添加许可证前，请不要假设代码具有某种开放授权。
