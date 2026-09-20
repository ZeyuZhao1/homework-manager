# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，并以 Git 标签和 GitHub Release 作为正式发布记录。

## [0.4.0] - 2026-09-20

### 新增

- 将 AI 作业导入重构为独立的内置功能模块，统一能力 ID 为 `assignment.extract`。
- 支持通过编译期注册表发现模块前端，并通过通用模块宿主调用内置或外部能力。
- 增加模块独立的服务商、模型路由、提示词目录和设置卡。
- 增加 Google Gemini 原生文字、图片和 PDF 请求支持。

### 改进

- 核心快照不再承载 AI 私有配置，模块使用独立 SQLite 表并迁移旧数据。
- 旧提示词安全迁移到模块目录，保留用户修改并升级未修改的旧默认值。
- 批量导入继续由核心事务负责持久化和附件关联，模块结果必须经人工审核。
- 补充 README、架构、核心接口、开发、模块协议与内置模块文档。

### 发布

- GitHub Actions 自动生成 Windows x64 安装版、便携版和 SHA-256 清单。

## [0.3.0] - 2026-09-18

### 新增

- 提供 AI 公告识别与审核后批量导入作业。
- 支持关联、筛选、统一命名与撤回课程文件。
- 支持 SQLite 数据备份、恢复与压缩。
- 提供版本化本地功能模块协议与内置作业识别模块。

### 发布

- 提供 Windows x64 安装版与便携版下载。

[0.4.0]: https://github.com/ZeyuZhao1/homework-manager/releases/tag/v0.4.0
[0.3.0]: https://github.com/ZeyuZhao1/homework-manager/releases/tag/v0.3.0
