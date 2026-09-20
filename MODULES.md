# 本地功能模块协议

本文档定义作业簿 `v0.4.0` 支持的模块机制。外部模块协议版本为 **1**，适用于用户安装的本地可执行程序；仓库内的内置模块还可以使用编译期 Rust/React 扩展点。

模块系统的目标是让文档解析、命名建议、打印或其他辅助能力独立演进，同时把数据库写入、文件改名等高影响操作保留在主程序中。

## 1. 模块类型

### 1.1 外部进程模块

外部模块由一个 `module.json` 和一个可执行文件组成，安装在：

```text
%APPDATA%\app.homeworkbook.local\modules\<任意目录名>\
```

主程序按需启动可执行文件，通过标准输入发送一个协议 v1 JSON 请求，并从标准输出读取一个 JSON 响应。模块没有自动获得应用数据库、API Key 或 UI 扩展权限。

### 1.2 内置模块

内置模块随应用编译，可同时提供：

- Rust 后端能力；
- Tauri 命令；
- React 操作入口、浮层和设置卡；
- 模块独立的数据库表、配置和资源。

当前内置模块为 `builtin.ai.assignment-import`。内置模块的源码布局和接口见本文末尾的“内置模块开发”。

## 2. 外部模块目录与清单

示例目录：

```text
modules\
└── document-tools\
    ├── module.json
    └── document-tools.exe
```

`module.json`：

```json
{
  "id": "example.document-tools",
  "name": "文档工具",
  "version": "1.0.0",
  "capabilities": [
    "document.parse",
    "file.suggest-name",
    "file.print"
  ],
  "executable": "document-tools.exe"
}
```

### 2.1 清单字段

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `id` | string | 是 | 1–100 字符；只能使用小写 ASCII 字母、数字、点和连字符；不得以 `builtin.` 开头 |
| `name` | string | 是 | 用户可见名称；去除空白后不得为空 |
| `version` | string | 是 | 用户可见的模块版本；当前宿主不解析其语义 |
| `capabilities` | string[] | 是 | 至少一个；每项遵循与 `id` 相同的字符和长度规则 |
| `executable` | string | 是 | 模块目录内的相对路径，只允许普通路径段 |

目录名本身不参与模块身份判断；`id` 才是启用状态和调用的稳定标识。因此发布新版本时应保留 `id`，只更新 `version` 和文件。

### 2.2 发现与校验

宿主只扫描模块根目录的直接子目录。遇到以下情况时会静默忽略该目录：

- `module.json` 不存在、无法读取或不是有效 JSON；
- `id`、`name` 或能力列表不符合规则；
- 外部模块冒用保留的 `builtin.*` ID；
- `executable` 是绝对路径，包含 `..`、`.` 等非普通路径段；
- 规范化后的可执行文件不在模块目录内部，或不是文件。

宿主会对模块目录和可执行文件做规范化校验，以阻止清单通过路径穿越启动目录外的程序。通过校验的外部模块按名称排序显示。

## 3. 生命周期

### 3.1 安装

1. 在设置页打开模块目录；
2. 为模块创建独立子目录；
3. 将 `module.json`、可执行文件及模块自己的资源放入其中；
4. 回到设置页刷新模块列表。

安装文件不会进入作业簿数据库备份。需要迁移时应单独备份模块目录。

### 3.2 启用和禁用

发现到的新模块默认启用。启用状态保存在 SQLite 的 `module_states` 表中，以模块 `id` 为键。

禁用模块会产生两层效果：

- 对应应用入口应隐藏；
- 即使前端仍尝试调用，模块宿主也会返回“模块已关闭”。

禁用不会删除模块文件或模块自行维护的数据。

### 3.3 执行

外部模块不会在应用启动或模块发现时执行。只有用户触发某项能力时，宿主才会：

1. 确认模块已启用；
2. 重新发现模块并确认能力已在清单中声明；
3. 序列化请求，检查输入大小；
4. 不经过 shell，直接启动清单指定的可执行文件；
5. 写入标准输入后关闭输入管道；
6. 等待进程结束并读取标准输出/错误；
7. 校验退出码、输出大小、JSON 和协议版本；
8. 将 `result` 返回给调用方，或把错误转换为用户可见消息。

每次调用启动一个新进程。协议 v1 没有常驻进程、会话、流式输出或取消消息。

## 4. 标准输入/输出协议 v1

### 4.1 请求

宿主向 stdin 写入一个 UTF-8 JSON 对象，然后关闭 stdin：

```json
{
  "protocol": 1,
  "capability": "document.parse",
  "input": {
    "path": "D:\\share\\example.pdf"
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `protocol` | 固定为整数 `1` |
| `capability` | 本次调用的能力名，必定已在清单中声明 |
| `input` | 能力自己的任意 JSON 输入 |

序列化后的请求最大为 **2,000,000 字节**。超过限制时不会启动模块。

### 4.2 成功响应

进程应以退出码 0 结束，并向 stdout 只写入一个 UTF-8 JSON 对象：

```json
{
  "protocol": 1,
  "ok": true,
  "result": {
    "text": "...",
    "pages": [
      { "number": 1, "text": "..." }
    ]
  }
}
```

`protocol` 必须为 `1`，`result` 必须存在。`ok: true` 建议显式提供；当前宿主只把 `ok: false` 视为能力错误。

### 4.3 可预期失败

当请求有效但模块无法完成任务时，仍应以退出码 0 返回结构化错误：

```json
{
  "protocol": 1,
  "ok": false,
  "error": "无法解析此文件"
}
```

宿主会把 `error` 展示给调用方。若缺少错误文本，则使用通用“模块执行失败”。

### 4.4 进程失败

若进程以非零退出码结束，宿主返回“模块运行失败”，并附带 stderr 的前 400 个字符。诊断日志应写入 stderr，绝不能混入 stdout，否则 stdout 将不再是有效 JSON。

### 4.5 资源限制

| 限制 | 值 | 行为 |
| --- | --- | --- |
| 请求大小 | 2,000,000 字节 | 启动前拒绝 |
| stdout 大小 | 4,000,000 字节 | 进程结束后拒绝 |
| 执行时间 | 120 秒 | 超时后终止子进程并返回错误 |
| 响应数量 | 一个 JSON 对象 | 额外文本会导致 JSON 解析失败 |

stderr 当前没有单独的宿主大小协议；仍应限制日志量，避免占用内存。

## 5. 推荐能力契约

能力名是宿主与模块之间的业务协议。下面的契约用于保持不同实现可以互换；新字段应尽量采用向后兼容的可选扩展。

### 5.1 `assignment.extract`

从公告文字和可选文件中提出作业草稿。

输入：

```json
{
  "text": "Calculus 作业 4，9 月 27 日提交……",
  "paths": ["D:\\courses\\notice.pdf"]
}
```

结果：

```json
{
  "assignments": [
    {
      "course_name": "Calculus",
      "course_id": "",
      "title": "作业 4",
      "description": "完成指定习题",
      "due_at": "2026-09-27T23:59:00",
      "submission_label": "Moodle",
      "submission_url": "https://moodle.example.edu",
      "submission_notes": "提交 PDF",
      "evidence": "公告中的原文依据"
    }
  ]
}
```

约束：

- `assignments` 必须是数组；一条公告可返回多项作业；
- `title` 应非空；
- `due_at` 使用本地时间格式 `YYYY-MM-DDTHH:mm:ss`，无法确定具体时间时使用 `null`；
- 外部模块通常不知道内部课程 UUID，应把 `course_id` 留空并提供 `course_name`；
- `evidence` 应保留支持该草稿的简短依据，供用户审核；
- 返回内容只是草稿，主程序审核后才调用批量保存接口。

当前 UI 会列出声明此能力的模块。附件路径来自用户主动选择，模块应自行验证路径和格式。

### 5.2 `document.parse`

输入：

```json
{ "path": "D:\\courses\\handout.pdf" }
```

结果：

```json
{
  "text": "文档完整文本",
  "pages": [
    { "number": 1, "text": "第一页文本" }
  ]
}
```

`pages` 可用于保留页码边界；`number` 从 1 开始。

### 5.3 `file.suggest-name`

输入：

```json
{
  "path": "D:\\courses\\scan.pdf",
  "course_code": "MA117",
  "role": "prompt"
}
```

结果：

```json
{
  "name": "MA117-assignment-hw-s2.5.pdf",
  "reason": "文件内容对应教材 2.5 节"
}
```

模块只能提出文件名建议。实际路径拼接、冲突检查、改名、历史记录和撤回必须由主程序执行。

### 5.4 `file.print`

输入：

```json
{
  "paths": ["D:\\courses\\homework.pdf"],
  "copies": 1
}
```

结果：

```json
{ "queued": 1 }
```

`queued` 表示成功提交到打印流程的文件数，不保证物理打印已经完成。

### 5.5 当前 UI 覆盖范围

`assignment.extract` 已有完整的选择、审核和持久化 UI。其他推荐能力已经可以通过前端的 `service.invokeModule(moduleId, capability, input)` 调用，但当前版本没有通用用户界面；为其增加入口需要修改并重新构建主程序。

## 6. 安全与信任边界

外部模块是用户主动安装和信任的本地程序，不是沙箱插件。它以当前 Windows 用户权限运行，因此理论上可以访问该用户可访问的文件和网络。

宿主提供的保护包括：

- 不在应用启动时执行模块；
- 不通过 shell 启动；
- 限制可执行路径必须位于模块目录内；
- 调用前检查声明能力和启用状态；
- 限制请求、响应和执行时间；
- 不把应用保存的 API Key 注入外部模块；
- 不直接向模块提供 SQLite 连接或数据库快照。

宿主目前不提供：

- 操作系统沙箱或文件访问白名单；
- 网络访问限制；
- 模块签名、来源验证或自动更新；
- 每项能力的用户授权弹窗；
- 外部模块 UI 注入。

需要云服务的外部模块必须自行管理凭据，并在自己的文档中说明数据发送范围。不要在 `module.json`、stdout 或错误日志中写入密钥。

## 7. 模块作者实现要求

一个可靠的模块应当：

1. 一次读取 stdin 到 EOF；
2. 验证 `protocol` 和 `capability`；
3. 对 `input` 做严格但可理解的校验；
4. 把所有诊断输出写到 stderr；
5. stdout 只输出一个紧凑 JSON 对象；
6. 对预期业务失败使用 `ok: false` 和退出码 0；
7. 对进程损坏、未捕获异常等使用非零退出码；
8. 在 120 秒内完成，并自行限制内存和子进程；
9. 不修改主程序数据库；
10. 对文件或网络副作用进行清晰记录并保持幂等性。

最小伪代码：

```text
request = parse_json(read_stdin_to_end())
assert request.protocol == 1
result = dispatch(request.capability, request.input)
write_stdout(json({ protocol: 1, ok: true, result }))
```

开发时可先用 PowerShell 管道向 EXE 发送固定 JSON，并确认 stdout 能被 `ConvertFrom-Json` 独立解析。由于宿主不会启动 shell，`.ps1`、`.cmd` 或需要文件关联才能运行的脚本不能直接作为 `executable`；应提供真正可执行的启动器或编译产物。

## 8. 兼容性与版本策略

- `protocol: 1` 是传输协议版本，不等同于模块自身的 `version`；
- 宿主拒绝未知协议版本；
- 在协议 v1 内增加可选字段通常是兼容变更；
- 删除字段、改变字段类型或语义属于不兼容变更，应定义新的能力名或未来协议版本；
- 模块应忽略请求中的未知字段，宿主也会忽略响应中的额外字段；
- 清单中的能力应真实反映当前实现，不能用版本号代替能力检查。

## 9. 内置模块开发

内置模块不是可动态安装的第三方 UI 插件，而是仓库源代码的一部分。当前约定布局：

```text
modules/<module-name>/
├── module.json
├── backend.rs
├── frontend/
│   ├── index.tsx
│   ├── service.ts
│   └── ...
└── 模块资源
```

前端入口由 `src/moduleRegistry.ts` 在构建时使用 `import.meta.glob('../modules/*/frontend/index.tsx')` 自动发现。入口需导出：

```ts
export interface AppModule {
  id: string
  Action: ComponentType<{ onOpen: () => void }>
  Overlay: ComponentType<{
    snapshot: Snapshot
    onClose: () => void
    onSettings: () => void
    onSaved: () => Promise<void>
  }>
  SettingsCard: ComponentType<{
    enabled: boolean
    onToggle: (enabled: boolean) => void
  }>
}
```

后端需要在 `src-tauri/src/modules.rs` 中注册描述符、初始化逻辑和能力分派；如果暴露专用 Tauri 命令，还必须加入 `src-tauri/src/lib.rs` 的 `generate_handler!`。

内置模块 ID 必须以 `builtin.` 开头，并与前端 `AppModule.id`、后端描述符及 `module.json` 保持一致。内置模块可以建立自己的表，但不应把模块私有字段塞入核心 `Snapshot`；应通过模块自己的服务获取配置。

AI 作业导入模块的完整实现说明见 [modules/assignment-import/README.md](modules/assignment-import/README.md)。

## 10. 宿主实现位置

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/modules.rs` | 清单解析、发现、启用状态、进程启动、协议和资源限制 |
| `src/moduleRegistry.ts` | 编译期发现内置模块前端 |
| `src/moduleTypes.ts` | 内置模块 React 接口 |
| `src/service.ts` | `listModules`、`setModuleEnabled`、`invokeModule` 等前端服务 |
| `modules/assignment-import/` | 当前内置模块参考实现 |

核心 Tauri 接口的完整清单见 [docs/CORE_API.md](docs/CORE_API.md)，系统边界和数据流见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
