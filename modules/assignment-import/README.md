# AI 作业导入模块

本目录包含该模块的能力清单、Rust 后端、React 前端、服务商预设和可编辑提示词源文件。桌面程序编译时纳入此内置模块；修改源代码后需重新构建应用。其他外部进程模块仍通过项目根目录的 `MODULES.md` 所述协议安装。

## 接口

- 能力：`assignment.extract`，输入 `{ "text": "…", "paths": ["…"] }`，输出 `assignments` 数组。
- 前端入口：`frontend/index.tsx`，由核心的 `src/moduleRegistry.ts` 自动发现。导入抽屉和设置卡片按需加载。
- 后端入口：`backend.rs`，通过 `src-tauri/src/modules.rs` 注册。模块只负责识别、服务商配置和课程名称匹配；审核后的批量写入调用核心的 `save_assignments_batch` 接口。
- 模块配置：SQLite 中的 `assignment_import_providers` 与 `assignment_import_settings` 表。API Key 存在 Windows 凭据管理器，不进入数据库备份。
- 可编辑提示词：运行时位于 `%APPDATA%\app.homeworkbook.local\modules\assignment-import\prompts`。首次升级会迁移旧目录中的自定义文件；后续保留用户修改。

## 服务商

预设值在 `provider-presets.json`。Gemini 走原生 `models/{model}:generateContent`，支持文字、图片和 PDF，返回 JSON 后仍进入逐条审核。单文件限 20 MB，DOCX 在发送前拒绝；百炼支持原有文件接口，DeepSeek 保持原有能力检查。未配置真实密钥时可用模块的模拟测试验证请求格式，但不能证明实际账号权限或模型配额。
