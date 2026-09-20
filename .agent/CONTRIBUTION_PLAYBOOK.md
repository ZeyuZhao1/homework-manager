# Agent 贡献工作流

本文把“完成一个修改”拆成可重复的工作流。目标是既快速推进，又不破坏本地数据、用户文件、模块协议和其他贡献者的工作区。

## 1. 接收任务

先判断用户要的是哪类工作：

| 类型 | 默认行为 |
| --- | --- |
| 解释/评审 | 只读检查并给证据，不修改 |
| 诊断 | 找到原因、复现路径和影响，不自动实施修复，除非请求包含修复 |
| 功能/修复 | 实施、按风险验证、更新相关文档 |
| 发布 | 校验版本、提交/标签/推送、跟踪 workflow，前提是用户明确授权外部写入 |
| 文档 | 对照当前代码更新，不把计划中的功能写成已实现 |

若任务描述存在多个合理方向，优先选择不改变公共行为、不会造成数据丢失且与现有架构一致的方案；只有会显著改变产品语义时才要求用户决策。

## 2. 建立工作区基线

```powershell
git status --short --branch
git log -5 --oneline --decorate
rg --files -g AGENTS.md -g '!node_modules' -g '!src-tauri/target'
```

记录：

- 当前分支和远端差异；
- 已修改/未跟踪文件；
- 是否存在与任务重叠的用户改动；
- 版本号和最近发布标签（发布任务才需要）；
- 对应测试是否已经失败。

不要为了“干净环境”回退未知改动。构建生成物由 `.gitignore` 管理，不要把用户源文件误当作生成物删除。

## 3. 代码探索

优先使用 `rg`：

```powershell
rg -n "serviceMethod|tauri::command|TypeName" src src-tauri modules
rg -n "CREATE TABLE|PRAGMA user_version|INSERT INTO|UPDATE" src-tauri/src
rg -n "test_name|#\[test\]" src-tauri modules
```

对跨层功能至少读完：

```text
UI event
  -> frontend service method
  -> Tauri command registration
  -> Rust command/internal implementation
  -> database or filesystem effects
  -> tests
  -> public documentation
```

只搜索到符号不等于理解行为；特别要读错误分支和事务结束后的补偿逻辑。

## 4. 风险分级

### 高风险

- 删除或覆盖磁盘文件；
- 数据库恢复、迁移或 schema 变更；
- API Key、认证头或模型请求内容；
- 外部模块执行、路径与权限；
- 发布、标签和 Release 资产；
- 破坏兼容的公共能力字段。

高风险改动需要：明确用户触发点、失败恢复、测试夹具、文档、安全评审和完整验证。

### 中风险

- 核心 CRUD、批量保存、级联删除；
- 文件关联、重新定位、命名模板；
- 新 Tauri 命令；
- AI 输出解析或服务商适配；
- AppData 路径和模块状态。

### 低风险

- 不改变行为的文案和样式；
- 纯文档；
- 类型内聚或局部重构且有现有测试覆盖。

风险低不代表可以跳过工作区检查和最小验证。

## 5. 按任务类型实施

### 5.1 前端 UI 改动

修改顺序：

1. 确认数据已存在于 `Snapshot` 或模块服务；
2. 在最接近使用位置的组件实现；
3. 保持键盘可操作、标签、对比度和错误提示；
4. 不在组件内直接调用 Tauri `invoke`；
5. 同时检查窄窗口和最小窗口尺寸；
6. 在浏览器预览检查布局，在桌面模式检查真实调用。

至少验证：`pnpm lint`、`pnpm build`。交互依赖 Rust 时再跑对应 Rust 测试和桌面烟雾测试。

### 5.2 新增或修改核心 CRUD

1. 更新 Rust 结构和校验；
2. 需要多表写入时使用事务；
3. 明确删除对文件历史和真实文件的影响；
4. 更新 Snapshot 查询和排序；
5. 同步 `src/types.ts`；
6. 更新 `src/service.ts` 桌面与预览实现；
7. 添加新增、更新、错误和回滚测试；
8. 更新 `docs/CORE_API.md` 和必要的架构说明。

### 5.3 新增 Tauri 命令

检查清单：

- 输入/输出可被 serde 序列化；
- 命令函数尽量薄，核心逻辑可独立测试；
- 在 `src-tauri/src/lib.rs` 注册；
- 前端服务封装返回准确泛型；
- camelCase 参数名与 Rust snake_case 映射正确；
- 浏览器预览有对应行为；
- 失败返回用户可理解信息；
- 接口文档已更新。

### 5.4 数据库 schema 或迁移

设计时回答：

- 新安装如何建表/列/索引？
- 从每个受支持 `user_version` 如何升级？
- 恢复旧备份后如何补表和更新版本？
- foreign key 和 cascade 是否正确？
- 事务中途失败会留下什么？
- Snapshot 对旧记录缺省值如何处理？
- 模块私有字段是否应留在模块私有表？

测试至少包含：新库、最小旧 schema、升级后读取、备份恢复、失败完整性。不要直接拿用户真实数据库做唯一测试。

### 5.5 文件系统改动

始终遵循：

1. 规范化用户路径；
2. 检查文件/目录类型；
3. 验证课程根目录边界；
4. 预览目标；
5. 检查冲突；
6. 执行文件操作；
7. 事务更新数据库与历史；
8. 数据库失败时尝试补偿；
9. 错误信息不能声称未完成的回滚成功。

使用临时目录测试：目标已存在、原文件消失、外部内容变化、连续改名、非最新撤回、数据库失败等路径。

禁止：删除真实学习文件作为清理策略、静默覆盖目标、绕过历史表更新。

### 5.6 内置 AI 模块改动

1. 先明确是配置、提供商传输、提示词、解析、课程匹配还是审核 UI；
2. 保持 API Key 只在后端读取；
3. 用户未触发时不发送内容；
4. 新附件类型要更新能力校验、MIME、大小限制、UI 和文档；
5. 提供商错误需要剥离不必要的敏感响应；
6. 模型输出始终视为不可信输入；
7. 未唯一匹配课程时要求审核；
8. 识别与核心保存保持分离；
9. 修改默认提示词时保护用户运行时副本；
10. 使用模拟 HTTP 测试，不依赖真实 Key。

更新：模块前后端类型、提示词约束、模块 README、根 README 能力矩阵，公共字段变化还要更新 `MODULES.md`。

### 5.7 外部模块协议改动

协议 v1 内优先增加可选字段。删除字段、改类型或改语义通常需要新能力名或新协议版本。

测试：

- 有效清单；
- 非法 ID/能力；
- `builtin.` 冒用；
- 绝对路径和 `..`；
- executable 不存在；
- 未声明能力；
- 模块禁用；
- 请求超过 2 MB；
- stdout 超过 4 MB；
- 超时；
- 非零退出和 stderr；
- 非 JSON、错误协议、`ok:false`、缺少 result。

任何安全模型变化都要同步 `MODULES.md`、`SECURITY.md` 和 `.agent` 说明。

### 5.8 文档改动

1. 以当前源码和测试为事实来源；
2. 区分已实现、预留契约和未来方向；
3. 示例使用当前版本和真实路径；
4. 不在文档中暴露真实 Key、私人目录内容或账号信息；
5. 检查相对链接；
6. 运行 `git diff --check`；
7. 若文档包含命令或类型，抽查其与代码一致。

### 5.9 发布改动

完整流程见 `docs/RELEASING.md`。Agent 必须确认用户明确授权提交、推送、标签和发布。

版本同步位置：

- `package.json`；
- `src-tauri/tauri.conf.json`；
- `src-tauri/Cargo.toml`；
- `src-tauri/Cargo.lock`；
- `modules/assignment-import/module.json`；
- README/CHANGELOG 示例。

公开标签不可移动。workflow 成功后还要验证 Release 资产名称、大小、上传状态和 SHA-256 清单。

## 6. 验证矩阵

| 改动范围 | 最低验证 | 追加验证 |
| --- | --- | --- |
| 纯 Markdown | `git diff --check`、本地链接 | 代码事实抽查 |
| CSS/静态 React | `pnpm lint`, `pnpm build` | 浏览器视觉检查 |
| React 服务调用 | 上述两项 | 桌面真实流程 |
| Rust 纯逻辑 | 目标测试、全部 lib tests | `pnpm build` 验证类型联动 |
| 数据库/schema | Rust tests | 旧库/恢复 fixture、桌面烟雾 |
| 文件系统 | Rust tests | 临时文件集成、失败补偿 |
| AI 后端 | 模块 tests、全部 lib tests | 模拟 HTTP、各文件类型 |
| 外部模块宿主 | 模块 tests | 测试 EXE 的错误/超时/大小边界 |
| 打包配置 | lint/build/tests | `pnpm desktop:build` |
| 正式发布 | 全部本地检查 | GitHub workflow 与 Release 资产验证 |

lint warning 和 lint failure 必须区分报告。不要把已有 warning 说成新增错误，也不要忽略非零退出码。

## 7. 并行协作

推荐按边界拆分：

- Agent A：Rust 实现和测试；
- Agent B：React UI；
- Agent C：文档/接口核对；
- 主 Agent：共享类型、服务、整合与最终验证。

避免多人同时修改：

- `src/types.ts`；
- `src/service.ts`；
- `src-tauri/src/lib.rs`；
- `README.md`；
- `CHANGELOG.md`。

无法避免时，先约定字段和接口，再由一方集中落地共享文件。任何 Agent 都不得通过回退整个文件解决冲突。

## 8. Git 收尾

```powershell
git diff --check
git status --short --branch
git diff --stat
```

确认：

- 只包含任务范围内的文件；
- 没有数据库、target、dist、日志或密钥；
- 新文件已被列出；
- 删除是预期的；
- 文档与测试同步；
- 没有回退用户已有改动。

除非用户要求，不自动 commit、push、tag 或发布。

## 9. 交付格式

建议最终说明：

```text
完成结果
- 用户可见变化
- 关键实现边界

主要文件
- path: 作用

验证
- command: pass/fail/warnings

剩余事项
- 未验证、已知限制或无
```

不要只说“已完成”。给出可核查的文件与验证结果，同时避免粘贴冗长日志。

