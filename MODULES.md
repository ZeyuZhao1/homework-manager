# 本地功能模块协议（v1）

应用在 `%APPDATA%\app.homeworkbook.local\modules` 的每个子目录中查找 `module.json`。安装模块时，把清单和可执行文件放入同一个子目录，在设置页点击“刷新模块”。每个模块都可在设置页单独开启或关闭；关闭状态保存在 SQLite，模块入口会隐藏，模块宿主也会拒绝调用。应用不会在启动时运行模块；用户触发功能时才启动对应进程。模块由用户自行安装和信任。

```json
{
  "id": "example.document-tools",
  "name": "文档工具",
  "version": "1.0.0",
  "capabilities": ["document.parse", "file.suggest-name", "file.print"],
  "executable": "document-tools.exe"
}
```

`id` 和能力名使用小写字母、数字、点及连字符。`executable` 必须是模块目录内的相对路径。应用通过标准输入发送一个 JSON 对象，关闭输入后等待标准输出中的单个 JSON 对象；不启动 shell。超时为 120 秒。输入最大 2 MB，输出最大 4 MB。

请求：

```json
{"protocol":1,"capability":"document.parse","input":{"path":"D:\\share\\example.pdf"}}
```

成功响应：

```json
{"protocol":1,"ok":true,"result":{"text":"...","pages":[{"number":1,"text":"..."}]}}
```

失败响应：

```json
{"protocol":1,"ok":false,"error":"无法解析此文件"}
```

模块可以声明多个能力；主程序在调用前会检查能力声明。推荐能力契约：

| 能力 | 输入 | 结果 |
| --- | --- | --- |
| `assignment.extract` | `{ "text": "…", "paths": ["…"] }` | `{ "assignments": [{ "course_name": "…", "title": "…", "description": "…", "due_at": null, "submission_label": "…", "submission_url": "…", "submission_notes": "…", "evidence": "…" }] }` |
| `document.parse` | `{ "path": "…" }` | `{ "text": "…", "pages": [{ "number": 1, "text": "…" }] }` |
| `file.suggest-name` | `{ "path": "…", "course_code": "…", "role": "…" }` | `{ "name": "…", "reason": "…" }` |
| `file.print` | `{ "paths": ["…"], "copies": 1 }` | `{ "queued": 1 }` |

`assignment.extract` 已有内置模块 `builtin.ai.assignment-import`，源代码完整位于 [`modules/assignment-import`](modules/assignment-import)。其中 `module.json` 声明能力，`backend.rs` 实现识别与配置，`frontend/` 包含导入抽屉、服务商编辑、整块设置卡和类型化服务，`provider-presets.json` 保存预设，`prompts/` 存放默认提示词。`src/moduleRegistry.ts` 自动发现前端入口，`src-tauri/src/modules.rs` 注册内置后端。核心快照不包含 AI 服务商或模型分配；模块使用独立的 SQLite 表，并在首次启动时迁移旧配置和用户修改过的提示词。模块密钥沿用 Windows 凭据管理器。

AI 导入抽屉会列出所有声明该能力的模块，审核后才保存。外部模块的其他能力目前通过前端服务接口 `service.invokeModule` 调用；今后新增的界面操作可直接使用该接口。模块可以解析文件或提出命名建议，但实际数据库写入和文件重命名仍由主程序负责，以保留冲突预览及撤回记录。

模块不会收到应用保存的 API 密钥。需要云服务的外部模块应自行管理其凭据。数据库备份不包含模块文件。
