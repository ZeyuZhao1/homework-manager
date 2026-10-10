# 本地功能模块协议

本文档定义 `v0.5.0` 的模块机制；本次新增行为见 [更新日志](CHANGELOG.md)。外部模块协议版本为 **1**，适用于用户安装的本地可执行程序或 PowerShell 脚本；仓库内的内置模块还可以使用编译期 Rust/React 扩展点。

模块系统的目标是让文档解析、命名建议、打印或其他辅助能力独立演进，同时把数据库写入、文件改名等高影响操作保留在主程序中。

## 1. 模块类型

### 1.1 外部进程模块

外部模块由一个 `module.json` 和一个可执行文件或 PowerShell 入口组成，安装在：

```text
%APPDATA%\app.homeworkbook.local\modules\<任意目录名>\
```

主程序按需启动模块入口，通过标准输入发送一个协议 v1 JSON 请求，并从标准输出读取一个 JSON 响应。模块没有自动获得应用数据库、API Key 或 UI 扩展权限。

### 1.2 内置模块

内置模块随应用编译，可同时提供：

- Rust 后端能力；
- Tauri 命令；
- React 操作入口、浮层和设置卡；
- 模块独立的数据库表、配置和资源。

本仓库仅包含两个内置模块： `builtin.ai.assignment-import` 与 `builtin.assignment.recurring`。内置模块的源码布局和接口见本文末尾的“内置模块开发”。

## 2. 外部模块目录与清单

示例目录：

```text
modules\
└── document-tools\
    ├── module.json
    └── document-tools.exe 或 module.ps1
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

无需编译的 PowerShell 入口使用互斥的 `runtime` / `entrypoint` 字段：

```json
{
  "id": "example.navigation",
  "name": "文档定位",
  "version": "1.0.0",
  "capabilities": ["document.navigation.index", "document.navigation.open"],
  "runtime": "powershell",
  "entrypoint": "module.ps1"
}
```

### 2.1 清单字段

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `id` | string | 是 | 1–100 字符；只能使用小写 ASCII 字母、数字、点和连字符；不得以 `builtin.` 开头 |
| `name` | string | 是 | 用户可见名称；去除空白后不得为空 |
| `version` | string | 是 | 用户可见的模块版本；当前宿主不解析其语义 |
| `capabilities` | string[] | 是 | 至少一个；每项遵循与 `id` 相同的字符和长度规则 |
| `executable` | string | 条件必填 | 原生入口；与 `runtime` / `entrypoint` 互斥，路径必须位于模块目录内 |
| `runtime` | string | 条件必填 | 脚本入口当前只接受 `powershell` |
| `entrypoint` | string | 条件必填 | `runtime` 对应的模块内相对路径；PowerShell 入口必须以 `.ps1` 结尾 |

目录名本身不参与模块身份判断；`id` 才是启用状态和调用的稳定标识。因此发布新版本时应保留 `id`，只更新 `version` 和文件。

### 2.2 发现与校验

宿主只扫描模块根目录的直接子目录。遇到以下情况时会静默忽略该目录：

- `module.json` 不存在、无法读取或不是有效 JSON；
- `id`、`name` 或能力列表不符合规则；
- 外部模块冒用保留的 `builtin.*` ID；
- 同时或都没有声明 `executable` 与 `runtime` / `entrypoint`；
- 入口是绝对路径，包含 `..`、`.` 等非普通路径段；
- `runtime` 未受支持，或规范化后的入口不在模块目录内部、不是文件。

宿主会对模块目录和入口文件做规范化校验，以阻止清单通过路径穿越启动目录外的程序或脚本。通过校验的外部模块按名称排序显示。

## 3. 生命周期

### 3.1 安装

1. 在设置页打开模块目录；
2. 为模块创建独立子目录；
3. 将 `module.json`、入口文件及模块自己的资源放入其中；
4. 回到设置页刷新模块列表。

安装文件不会进入作业簿数据库备份。需要迁移时应单独备份模块目录。

### 3.2 启用和禁用

发现到的新模块默认启用。启用状态保存在 SQLite 的 `module_states` 表中，以模块 `id` 为键。

禁用模块会产生两层效果：

- 对应应用入口应隐藏；
- 即使前端仍尝试调用，模块宿主也会返回“模块已关闭”。

禁用不会删除模块文件或模块自行维护的数据。

### 3.3 执行

外部模块不会仅因“发现清单”而执行。一般能力只在用户触发时执行；宿主集成能力可以在相关事件后运行，例如已启用的 `document.navigation.index` 会在快照载入或关联文件变化后建立缓存。宿主调用时会：

1. 确认模块已启用；
2. 重新发现模块并确认能力已在清单中声明；
3. 序列化请求，检查输入大小；
4. 不经过命令行 shell，直接启动清单指定的原生入口；PowerShell 入口由 `powershell.exe -File` 启动；
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

### 5.2 `assignment.schedule`

内置周期作业模块使用此能力标识，并通过编译期 Rust/React 扩展点实现调度、列表分组和时间线。规则采用带 `version: 1` 与 `kind` 的 tagged JSON；模块私有表只保存周期定义、计划节点和实例映射，生成结果仍写入核心 `assignments`。

周期共享文件使用核心 `module_file_links`，不会复制到每个作业的 `assignment_files`。关闭模块会停止同步并隐藏周期界面，但保留周期数据和已生成作业。

### 5.3 `document.parse`

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

### 5.4 `file.suggest-name`

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

### 5.5 `file.print`

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

`queued` 表示成功提交到打印流程的文件数，不保证物理打印已经完成。用户从作业详情的单个关联文件触发；主程序只传这次选择的路径，不传数据库、作业正文或其他附件。入口只显示启用且声明 `file.print` 的模块，不自动重试打印。

兼容的可选输入 `options`：

```json
{
  "paths": ["D:\\courses\\homework.pdf"],
  "options": { "printer": "打印机名称", "copies": 1, "pages": "1-3,5", "duplex": "long-edge", "color": "monochrome", "paper": "A4", "orientation": "portrait" }
}
```

省略参数时由模块读取自己的默认值。`pages` 使用文件的实际页序（从 1 开始），空字符串表示全部；与关联中的教材印刷页码无关。`duplex` 接受 `simplex`、`long-edge`、`short-edge`，`color` 接受 `monochrome`、`color`，`paper` 接受 `A4`、`A3`、`Letter`，`orientation` 接受 `portrait`、`landscape`。返回可带 `files: [{path, queued, error?}]` 和 `warning`，用于表达部分成功与提交状态未知。发生错误后应先检查队列，再决定是否重试。

可选 `file.print.configure` 供通用设置界面使用，输入为 `{ "operation": "get" }` 或 `{ "operation": "save", "config": {...} }`；结果为 `{config, printers: [{name, is_default}], warning?}`。`config` 包括上述打印参数与模块私有的 `renderer_path`（参考实现使用现有 Ghostscript 的绝对路径）。配置由模块独立保存，不写主数据库；仅用户打开设置时读取。`file.print.printers` 返回同形的 `printers` 清单。

可选 `file.print.authenticate` 接受 `{}`，只在用户点击连接按钮时准备外部客户端的认证流程。结果可包含 `{mode, started, warning}`，客户端启动或复用不表示已认证成功。凭据、验证码、首次登录及网络要求由外部模块和客户端处理；主程序不包含特定学校实现。

### 5.6 `document.navigation.index`

宿主在载入快照及关联文件发生变化后，把当前未失效的作业关联文件交给所有已启用且声明此能力的外部模块。输入只含路径和可选文件签名，不包含数据库连接、作业正文或其他文件：

```json
{
  "files": [
    {
      "path": "D:\\courses\\textbook.pdf",
      "file_size": 123456,
      "modified_at_ms": 1789999999999
    }
  ]
}
```

建议模块使用自身目录内的缓存，并以真实文件大小和修改时间做幂等更新。参考结果：

```json
{ "indexed": 1, "cached": 3, "skipped": 2 }
```

### 5.7 `document.navigation.open`

用户从某个作业的文件关联点击文件名，且该关联填写了页码或章节时，核心会按模块名称顺序调用已启用且声明此能力的外部模块：

```json
{
  "path": "D:\\courses\\textbook.pdf",
  "page": "84-86",
  "chapter": "2.5 多元函数",
  "problem": "3-6"
}
```

模块成功接管打开操作时返回：

```json
{
  "handled": true,
  "location_applied": true,
  "warning": null
}
```

不支持该格式时应返回 `handled: false`，让宿主继续尝试其他模块或以默认程序普通打开。模块已打开文件但无法定位时返回 `handled: true`、`location_applied: false` 和可选 `warning`。这项能力只在用户点击文件链接时触发；模块不得在索引阶段自行打开文件。

### 5.8 当前 UI 覆盖范围

`assignment.extract` 已有完整的选择、审核和持久化 UI。`assignment.sync.snapshot` 使用通用“导入待审核”界面。`document.navigation.index` 与 `document.navigation.open` 由文件关联界面的通用宿主集成，不依赖模块专属 UI。`file.print` 和可选的配置/认证能力提供通用文件按钮及设置界面，独立模块可热安装；首次获得这些通用入口需要构建含本次改动的主程序。其他推荐能力仍可通过 `service.invokeModule(moduleId, capability, input)` 调用。

### 5.9 `assignment.sync.snapshot`

供已安装的外部模块返回最近一次完成检查的作业元数据。宿主以 `input: {}` 调用；模块以协议 v1 的 `result` 返回以下 JSON。`due_at` 是当地墙上时间，格式为 `YYYY-MM-DDTHH:mm:ss`；未知时间必须为 `null`。

```json
{
  "protocol": 1,
  "account_key": "不含密码的稳定账户标识",
  "checked_at": "2026-09-28T01:00:00Z",
  "courses": [{ "id": "remote-course-id", "name": "Calculus", "code": "MA117", "term": "2026 秋" }],
  "assignments": [{ "id": "remote-assignment-id", "course_id": "remote-course-id", "title": "Homework 1", "description": "...", "due_at": null, "status": "unknown", "url": "https://lms.example.edu/assignments/1" }],
  "warnings": []
}
```

`status` 只接受 `unknown`、`submitted` 和 `graded`。来源模块应只返回本次成功确认的作业，不用缺席表示删除。核心按模块、账户、来源课程和来源作业 ID 关联，未关联的已提交项不新建；所有创建、课程映射和更新都须在审核后由核心事务执行。`preview_assignment_import` 和 `apply_assignment_import` 是通用接口，详见 [核心接口](docs/CORE_API.md)。本仓库不附带外部同步实现。

## 6. 安全与信任边界

外部模块是用户主动安装和信任的本地程序，不是沙箱插件。它以当前 Windows 用户权限运行，因此理论上可以访问该用户可访问的文件和网络。

宿主提供的保护包括：

- 不在清单发现阶段执行模块，只有能力对应的宿主事件才会调用；
- 不通过 shell 启动；
- 限制入口路径必须位于模块目录内；
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

开发时可先用 PowerShell 管道向入口发送固定 JSON，并确认 stdout 能被 `ConvertFrom-Json` 独立解析。`.cmd` 或依赖文件关联的脚本不能作为 `executable`；无需编译的 PowerShell 模块应使用 `runtime: "powershell"` 与模块内的 `.ps1` `entrypoint`。为兼容 Windows PowerShell 5.1，脚本源码应使用 ASCII，或保存为带 BOM 的 UTF-8。

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
  descriptor: Omit<ModuleDescriptor, 'enabled'>
  savedMessage: string
  Action: ComponentType<{ onOpen: () => void }>
  Overlay: ComponentType<{
    snapshot: Snapshot
    onClose: () => void
    onSettings: () => void
    onSaved: () => Promise<void>
  }>
  SettingsCard: ComponentType<{
    enabled: boolean
    snapshot: Snapshot
    onToggle: (enabled: boolean) => void
  }>
  assignmentList?: AssignmentListExtension
}
```

后端通过 `BuiltinModuleRegistration` 注册描述符、初始化逻辑、快照前同步、作业保存/删除钩子以及可选管理分派。宿主只遍历通用注册信息；模块私有管理操作统一经过 `manage_builtin_module(moduleId, operation, payload)`，不再要求主程序为每个周期操作增加专用命令。

内置模块 ID 必须以 `builtin.` 开头，并与前端 `AppModule.id`、后端描述符及 `module.json` 保持一致。内置模块可以建立自己的表，但不应把模块私有字段塞入核心 `Snapshot`；应通过模块自己的服务获取配置。

两个内置模块分别见 [AI 作业导入](modules/assignment-import/README.md) 与 [周期作业](modules/recurring-assignments/README.md)。其他模块应独立维护并安装到 AppData，不放入本仓库的 `modules/`。宿主保留通用文档定位、打印及作业同步契约，具体实现不随主程序提供。

## 10. 宿主实现位置

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/modules.rs` | 清单解析、发现、启用状态、进程启动、协议和资源限制 |
| `modules/registry.rs` | 内置模块后端的编译期清单；核心只读取通用注册项 |
| `src/moduleRegistry.ts` | 编译期发现内置模块前端 |
| `src/moduleTypes.ts` | 内置模块 React 接口 |
| `src/service.ts` | `listModules`、`setModuleEnabled`、`invokeModule` 等前端服务 |
| `modules/assignment-import/` | AI 作业导入模块实现 |
| `modules/recurring-assignments/` | 周期规则、调度、时间线、抽屉和模块私有前后端服务 |

核心 Tauri 接口的完整清单见 [docs/CORE_API.md](docs/CORE_API.md)，系统边界和数据流见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
