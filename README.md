# 作业簿

Windows 本地大学作业管理应用。安装后从开始菜单打开，或直接运行 `homework-manager.exe`。不需要启动网页服务器。

## 下载与更新

从仓库的 [Releases](../../releases) 页面下载稳定发行版。每个版本提供以下文件：

| 文件 | 适用场景 |
| --- | --- |
| `作业簿_<版本>_x64_安装版.exe` | 推荐。标准 Windows 安装程序，会创建开始菜单入口。 |
| `作业簿_<版本>_便携版.exe` | 无需安装，下载后直接运行；仍与安装版共用当前 Windows 用户的数据。 |
| `SHA256SUMS.txt` | 下载后的文件完整性校验值。 |

当前仅发布 Windows x64 版本。首次运行前，如系统提示缺少 WebView2，请安装 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。Windows 的 SmartScreen 提示通常是因为个人发行版未进行代码签名；请仅从本仓库的 Releases 页面获取安装包，并先核对 SHA-256。

## 首次使用

应用在首次启动时建立“2026 秋季”学期。如果 `D:\share\University\Year 1 Fall` 存在，会将其中的思政、Calculus、Earth Science、Linear Algebra、Physics 五个课程文件夹关联到对应课程，并给 Calculus、Linear Algebra、Physics 预设 MA117、MA113、PHY105 课程代码。只建立目录映射，不读取文件内容、不生成作业，也不移动文件。课程名称、代码和目录可在“设置”里修改。

1. 在课程页点“新建作业”，填写标题、截止时间、提交位置、状态及任意自定义键值。DDL 可以留空。标题、提交平台、链接和提交要求可从曾用值下拉选择。
2. 在作业详情点“添加材料”或“添加解答”，从课程目录点选多份文件，或通过系统文件选择器批量选择。一份作业可以关联多个文件，一个文件也可关联多份作业。选择器会记住每门课程上次浏览的目录。可把课本或补充习题集设为本课程常用文件，之后在关联抽屉一键关联。
3. 在关联文件旁点“统一命名”先查看目标名称和冲突提示。默认格式如 `MA117-textbook-hw-s2.5&s2.6.pdf` 或 `MA117-extra-hw-ch3.pdf`；可指定材料类型、节 `s` 或章 `ch`。确认后只在原文件夹改名；“文件”页可撤回最近的改名。
4. “文件”页支持按文件类型、科目和失效状态筛选。在“设置”中导出或恢复 SQLite 备份，也可压缩数据库。备份包含记录、文件路径、自定义字段和设置，不包含实际文件、提示词文件、模块文件或 API Key。恢复后可在“文件”页重新定位失效路径。

安装版和便携版使用同一数据库：`%APPDATA%\app.homeworkbook.local\homework.db`。移动便携版 EXE 不会移动数据库，已安装版和便携版在同一 Windows 账户下会看到同一数据。可编辑 AI 提示词位于同目录的 `prompts\assignment_system.txt` 与 `prompts\assignment_user.txt`，设置页可直接打开；修改后下次识别立即生效。升级时仅更新未修改的旧默认提示词，手动改过的文件会保留。现有学习文件保持原位。课程目录搜索只在用户输入关键字时执行，不会在启动时批量扫描线性代数习题答案。

## AI 导入

先在设置中添加服务商、模型和 API Key，并指定“作业识别使用”的服务商。API Key 写入 Windows 凭据管理器，不进入 SQLite。点“AI 导入”，粘贴一项或多项公告文字，也可选择 PDF、DOCX、图片；只有点击“开始识别”才发送本次输入。模型会按独立作业拆分，审核抽屉可逐条修改、删除，确认后一起写入数据库。附件会作为题目材料关联，原文件不移动。

| 服务商与模型 | 文字 | 图片 | PDF | DOCX |
| --- | --- | --- | --- | --- |
| 百炼 qwen3.8 系列 | 支持 | 支持 | 直接传入 | 不支持 |
| 百炼 qwen-long | 支持 | 文件接口 | 文件接口 | 文件接口 |
| 百炼 qwen-doc-turbo | 支持 | 文件接口 | 文件接口 | 文件接口；一次一个文件 |
| DeepSeek deepseek-flash | 支持 | 支持 | 不支持 | 不支持 |
| 自定义兼容接口 | 支持 | 未声明 | 不支持 | 不支持 |

百炼文件接口的上传文件在请求结束后尝试自动删除。若上传或删除遇到网络错误，需在服务商后台检查残留文件。首版限制单文件 20 MB。PDF 不在本地提取文字。没有真实密钥时仍可完整使用手动录入和文件管理。

教材页面自动匹配目前只有结构化建议接口与关联字段；首版由用户填写页码和题号。作业详情中的来源依据可用于审核模型结果。

## 功能模块

AI 作业导入已作为内置 `assignment.extract` 模块运行。设置页列出已安装模块，AI 导入抽屉允许选择声明该能力的模块。外部模块放入 `%APPDATA%\app.homeworkbook.local\modules`，通过版本化 JSON 标准输入/输出协议调用；启动应用时不会执行模块。后续 PDF/DOCX 解析、AI 文件命名建议、打印等能力可由独立模块提供。清单格式、能力契约和安装方式见 [MODULES.md](MODULES.md)。模块只提出解析或命名结果；持久化和文件重命名由主程序完成。

默认提示词将固定的拆分规则、字段约束、JSON 格式和防止臆测的规则放在最前面；本地日期、已有课程和本次公告置于末尾。这样可增加不同请求的共同前缀，有利于支持前缀缓存的服务商，但命中取决于具体模型和服务商，不能保证每次节省费用。若公告只给日期而没有具体截止时刻，模型会把 `due_at` 留空，并在说明中保留原文日期供你审核。

## 开发

需要 Node.js、pnpm、Rust 与 Windows C++ Build Tools。

```powershell
pnpm install
pnpm desktop:dev
```

生产构建：

```powershell
pnpm desktop:build
```

发布流程、版本号同步方式与资产命名见 [docs/RELEASING.md](docs/RELEASING.md)。提交规范与安全问题反馈方式分别见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

检查：

```powershell
pnpm build
cd src-tauri
cargo test --lib
```

前端通过 `src/service.ts` 的类型化接口访问 Tauri 命令。SQLite、文件、模块宿主与模型请求分别在 `src-tauri/src/db.rs`、`files.rs`、`modules.rs`、`ai.rs`。将来接入在线服务时，可替换服务实现并保留界面数据类型。
