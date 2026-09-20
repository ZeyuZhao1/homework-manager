# 核心接口参考

本文记录作业簿 `v0.4.0` 前端与 Tauri 后端之间的接口。它不是网络 HTTP API；调用只发生在桌面应用的 WebView 与同一进程的 Rust 后端之间。

前端代码应优先调用 `src/service.ts`，不要在页面组件中直接使用 `invoke`。内置 AI 模块使用自己的 `modules/assignment-import/frontend/service.ts`，并在需要写入核心数据时回到核心服务。

## 1. 调用约定

桌面模式：

```ts
const snapshot = await service.snapshot()
const id = await service.saveAssignment(assignment)
```

浏览器预览模式下，同一服务对象会使用 LocalStorage 示例状态。文件选择器、SQLite、系统凭据和本地模块只在 Tauri 桌面模式可用。

通用约定：

- 所有接口返回 Promise；
- Rust 失败以字符串错误拒绝 Promise；
- 新记录的 `id` 传空字符串，由后端生成 UUID v4；
- 更新记录时传现有 `id`；
- Rust 字段采用 `snake_case`，TypeScript 数据类型保持同名；
- Tauri 命令参数在 TypeScript 调用处使用 `camelCase`，对象字段仍使用数据契约定义的 `snake_case`；
- 日期时间是本地时间字符串 `YYYY-MM-DDTHH:mm:ss`，不携带时区；
- 空 DDL 使用 `null`，而不是空字符串。

## 2. 核心数据类型

权威 TypeScript 定义位于 `src/types.ts`，Rust 对应定义位于 `src-tauri/src/db.rs` 和 `files.rs`。

### 2.1 学期、课程和作业

```ts
type Status = 'todo' | 'doing' | 'done' | 'submitted'

interface Semester {
  id: string
  name: string
  source_root: string
}

interface Course {
  id: string
  semester_id: string
  name: string
  code: string
  folder_path: string
}

interface Assignment {
  id: string
  course_id: string
  title: string
  description: string
  due_at: string | null
  status: Status
  submission_label: string
  submission_url: string
  submission_notes: string
  source_name: string
  source_text: string
  created_at: string
  updated_at: string
  custom_fields: Record<string, string>
}
```

校验要点：

- 学期名、课程名和作业标题不能为空；
- 作业状态只能使用四个固定值；
- 自定义字段最多 40 项；键不能为空且最长 80 字符，值最长 4000 字符；
- `created_at` 在新增时由后端设置，更新时保留；`updated_at` 每次保存更新；
- `source_name` 和 `source_text` 用于保留导入来源，不参与模型调用。

### 2.2 文件相关类型

```ts
type FileRole = 'prompt' | 'reference' | 'solution'

interface FileAsset {
  id: string
  path: string
  missing: boolean
}

interface FileLink {
  id: string
  assignment_id: string
  file_id: string
  role: FileRole
  page: string
  chapter: string
  problem: string
  note: string
}

interface CommonFile {
  course_id: string
  file_id: string
  kind: 'textbook' | 'extra' | 'other'
  label: string
}

interface LinkInput {
  id: string
  assignment_id: string
  path: string
  role: FileRole
  page: string
  chapter: string
  problem: string
  note: string
}

interface LinkBatchInput {
  assignment_id: string
  paths: string[]
  role: FileRole
  page: string
  chapter: string
  problem: string
  note: string
}
```

`FileAsset.missing` 是读取快照时根据当前文件系统计算的字段，不直接存入数据库。

### 2.3 设置和快照

```ts
interface Settings {
  theme: 'light' | 'dark'
  naming_template: string
}

interface Snapshot {
  semesters: Semester[]
  courses: Course[]
  assignments: Assignment[]
  files: FileAsset[]
  links: FileLink[]
  common_files: CommonFile[]
  renames: RenameEvent[]
  file_history: FileHistoryEvent[]
  settings: Settings
  recent_values: Record<string, string[]>
}
```

快照中的改名历史最多 100 条，文件历史最多 1000 条，每个最近值字段最多 12 项。读取快照可能检测并记录文件内容变化，因此不是严格的无副作用查询。

### 2.4 模块描述符

```ts
interface ModuleDescriptor {
  id: string
  name: string
  version: string
  capabilities: string[]
  builtin: boolean
  enabled: boolean
}
```

## 3. 快照与领域写接口

| 前端服务 | Tauri 命令 | 输入 | 返回 | 主要副作用/约束 |
| --- | --- | --- | --- | --- |
| `snapshot()` | `load_snapshot` | 无 | `Snapshot` | 读取完整状态；可能写入文件签名历史 |
| `saveSemester(payload)` | `save_semester` | `Semester` | 学期 ID | 新增或覆盖；名称必填 |
| `deleteSemester(id)` | `delete_semester` | 学期 ID | `void` | 至少保留一个学期；事务级联课程、作业和当前关联；不删磁盘文件 |
| `saveCourse(payload)` | `save_course` | `Course` | 课程 ID | 新增或覆盖；名称必填；目录可以为空 |
| `saveAssignment(payload)` | `save_assignment` | `Assignment` | 作业 ID | 事务写作业和自定义字段；更新最近值 |
| `saveAssignmentsBatch(assignments, paths, fileRole)` | `save_assignments_batch` | 作业数组、路径数组、文件角色 | 作业 ID 数组 | 单事务创建全部作业，并把每个文件关联到每个作业；任一步失败全部回滚 |
| `deleteAssignment(id)` | `delete_assignment` | 作业 ID | `void` | 写取消关联历史后删除；不删磁盘文件 |
| `saveSettings(payload)` | `save_settings` | `Settings` | `void` | 保存主题和命名模板 |

批量保存要求：

- 作业数组不能为空；
- 所有标题必须非空；
- `fileRole` 必须为 `prompt`、`reference` 或 `solution`；
- 所有路径必须存在且指向文件；
- 重复路径会在规范化后去重；
- 附件关联失败时不会留下部分作业。

## 4. 文件接口

### 4.1 关联和常用文件

| 前端服务 | Tauri 命令 | 返回 | 行为 |
| --- | --- | --- | --- |
| `linkFile(payload)` | `link_file` | 关联 ID | 规范化路径，复用相同路径的 `FileAsset`，新增或更新关联并写历史 |
| `linkFilesBatch(payload)` | `link_files_batch` | 新建关联数 | 单事务批量关联；相同作业、文件、角色的已有关系不会重复创建 |
| `saveFileLink(payload)` | `save_file_link` | `void` | 更新角色、页码、章节、题号和备注并写历史 |
| `unlinkFile(id)` | `unlink_file` | `void` | 写历史后删除当前关联；必要时清理不再引用的文件资产 |
| `saveCommonFile(payload)` | `save_common_file` | 文件 ID | 添加或更新课程常用文件并写历史 |
| `removeCommonFile(courseId, fileId)` | `remove_common_file` | `void` | 移除常用文件并写历史 |

`saveCommonFile` 输入：

```ts
{
  course_id: string
  path: string
  kind: 'textbook' | 'extra' | 'other'
  label: string
}
```

### 4.2 浏览、搜索和打开

| 前端服务 | Tauri 命令 | 输入 | 返回/限制 |
| --- | --- | --- | --- |
| `browseDirectory(courseId, relativePath)` | `browse_directory` | 课程 ID、相对路径 | `DirectoryEntry[]`；请求规范化后必须仍在课程根目录内；目录优先排序 |
| `searchCourseFiles(courseId, query)` | `search_course_files` | 课程 ID、查询 | 少于 2 字符返回空；最大深度 12；最多 100 个文件 |
| `openFile(fileId)` | `open_file` | 文件 ID | 用系统默认程序打开；缺失路径会失败 |
| `relinkFile(fileId, path)` | `relink_file` | 文件 ID、新路径 | 新路径必须存在并为文件；更新当前路径并写 `relocated` 历史 |

```ts
interface DirectoryEntry {
  name: string
  path: string
  is_dir: boolean
}
```

浏览和搜索会忽略点开头的目录项与 `node_modules`。

### 4.3 命名预览、改名和撤回

```ts
interface NamingInput {
  material: string
  sections: string
  version: string
  scope_kind: 'section' | 'chapter'
}

interface RenamePreview {
  file_id: string
  old_path: string
  new_path: string
  conflict: boolean
  unchanged: boolean
}
```

| 前端服务 | Tauri 命令 | 返回 | 行为 |
| --- | --- | --- | --- |
| `previewRename(linkId, naming)` | `preview_rename` | `RenamePreview` | 只计算目标，不修改文件或数据库 |
| `renameFile(linkId, naming)` | `rename_file` | 改名记录 ID | 拒绝无变化和冲突；原地改名并事务更新路径与历史 |
| `undoRename(id)` | `undo_rename` | `void` | 仅撤回该文件最新有效改名；检查当前路径、原名占用及文件签名 |

允许的命名模板占位符在 [README.md](../README.md#4-统一命名与撤回) 中列出。未知花括号占位符会导致预览失败。

## 5. 数据库维护接口

| 前端服务 | Tauri 命令 | 行为 |
| --- | --- | --- |
| `backup(path)` | `backup_database` | 使用 SQLite backup API 导出当前数据库 |
| `restore(path)` | `restore_database` | 先做 `integrity_check`，仅接受 `user_version` 1–4，然后恢复、补表并升级到版本 4 |
| `compactDatabase()` | `compact_database` | 清理无引用文件记录，截断 WAL 并执行 `VACUUM` |

恢复后会重新初始化内置模块的表与提示词兼容逻辑。备份不含 API Key、提示词、模块文件或实际学习文件。

## 6. 文件选择和外部打开

这些服务使用 Tauri 插件而不是自定义 Rust 命令：

| 服务 | 行为 |
| --- | --- |
| `pickFiles(defaultPath?)` | 多选文件；取消时返回空数组 |
| `pickDirectory()` | 单选目录；取消时返回 `null` |
| `pickBackupSave()` | 选择 `.db` 保存路径 |
| `pickBackupOpen()` | 选择现有 `.db` 文件 |
| `openUrl(url)` | 桌面模式使用 opener 插件，浏览器模式新开窗口 |

调用方必须把“用户取消选择”当作正常分支，而不是错误。

## 7. 模块宿主接口

| 前端服务 | Tauri 命令 | 输入/返回 | 行为 |
| --- | --- | --- | --- |
| `listModules()` | `list_modules` | 返回 `ModuleDescriptor[]` | 合并内置模块和有效外部模块，再应用启用状态 |
| `setModuleEnabled(moduleId, enabled)` | `set_module_enabled` | 返回 `void` | 只接受当前已安装模块；写 `module_states` |
| `modulesDirectory()` | `modules_directory` | 返回路径字符串 | 获取 AppData 模块根目录 |
| `openModulesDirectory()` | `open_modules_directory` | 返回 `void` | 使用系统文件管理器打开模块目录 |
| `invokeModule<T>(moduleId, capability, input)` | `invoke_module` | 返回能力 `result` | 检查启用状态和能力；内置分派或启动外部 EXE |

`invokeModule` 对外部模块应用 2 MB 请求、4 MB 输出和 120 秒超时。完整协议见 [MODULES.md](../MODULES.md)。

## 8. AI 作业导入模块接口

权威前端类型位于 `modules/assignment-import/frontend/types.ts`。

### 8.1 配置类型

```ts
interface Provider {
  id: string
  name: string
  kind: 'bailian' | 'deepseek' | 'gemini' | 'custom'
  base_url: string
  model: string
  has_key: boolean
}

interface ProviderInput extends Provider {
  api_key: string
}

interface ModuleConfig {
  providers: Provider[]
  assignment_provider_id: string
  material_provider_id: string
  prompt_directory: string
}
```

`has_key` 只表示凭据管理器中是否存在密码，不会返回真实密钥。编辑已有服务商时可把 `api_key` 留空以保留旧密钥；新服务商必须提供密钥。

### 8.2 配置服务

| 模块服务 | Tauri 命令 | 行为 |
| --- | --- | --- |
| `config()` | `get_config` | 返回服务商、路由和提示词目录 |
| `saveProvider(payload)` | `save_provider` | 校验类型、名称、模型和 URL；保存元数据并把密钥写入凭据管理器 |
| `deleteProvider(id)` | `delete_provider` | 删除元数据、清空引用路由并尝试删除凭据 |
| `saveRouting(assignmentId, materialId)` | `save_routing` | 保存作业识别和预留材料匹配服务商 |
| `openPromptDirectory()` | `open_prompt_directory` | 打开用户可编辑提示词目录 |

服务地址必须使用 HTTPS；只允许 `http://localhost` 或 `http://127.0.0.1` 作为本地开发例外。

### 8.3 识别能力

模块 UI 通过核心接口调用：

```ts
service.invokeModule<AiResult>(
  moduleId,
  'assignment.extract',
  { text, paths },
)
```

返回类型：

```ts
interface AiDraft {
  course_name: string
  course_id: string
  title: string
  description: string
  due_at: string | null
  submission_label: string
  submission_url: string
  submission_notes: string
  evidence: string
}

interface AiResult {
  assignments: AiDraft[]
}
```

后端在返回 UI 前会：

- 拒绝文字和文件都为空的请求；
- 校验文件扩展名和所选模型能力；
- 限制单文件 20 MB；
- 读取运行时提示词并填充日期、课程列表和公告；
- 验证模型 JSON 并删除空标题项；
- 把非法 DDL 置为 `null`；
- 仅在课程名或代码唯一匹配时填写 `course_id`。

审核确认后，`saveDrafts` 将草稿映射为核心 `Assignment`，并调用 `saveAssignmentsBatch(..., 'prompt')`。因此识别和持久化之间存在明确的人工确认边界。

## 9. 错误和副作用处理

前端一般用以下模式集中显示错误：

```ts
try {
  await service.renameFile(linkId, naming)
  await refresh()
} catch (error) {
  showToast(errorText(error))
}
```

接口不会返回统一错误码，当前稳定契约是用户可读字符串。不要在业务逻辑中依赖完整中文错误文本；如未来需要程序化分支，应新增结构化错误类型。

需要用户确认的高影响操作包括：

- 删除作业或学期；
- 恢复数据库；
- 执行文件改名；
- 提交 AI 识别和保存审核结果；
- 启用用户安装的外部模块。

## 10. 新增接口的检查清单

新增核心能力时至少同步：

1. 在 Rust 中定义可序列化输入/输出和命令；
2. 在 `src-tauri/src/lib.rs` 注册命令；
3. 在 `src/types.ts` 增加共享前端类型；
4. 在 `src/service.ts` 增加桌面实现和合理的预览实现；
5. 明确校验、事务、文件/网络副作用和删除语义；
6. 添加 Rust 单元测试，必要时补前端测试；
7. 更新本文及 [ARCHITECTURE.md](ARCHITECTURE.md)；
8. 若涉及模块公共能力，同时更新 [MODULES.md](../MODULES.md)。
