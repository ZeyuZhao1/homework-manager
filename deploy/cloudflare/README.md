# 使用自己的 Cloudflare 部署同步服务

作业簿的云同步采用自托管模式：**每位使用者在自己的 Cloudflare 账户中部署一套个人服务**，供本人已授权的桌面、浏览器和手机共享数据。仓库提供应用和部署工具，不提供维护者的云端使用权、默认服务器、初始化密钥或付费资源。Fork、下载应用或运行 CI 都不会获得维护者的设备授权。

桌面核心功能无需云服务；需要多设备同步、网页版或 Google Drive 关联时，再自行部署。当前服务是单人空间，不提供多人注册、租户隔离或面向陌生人的托管服务。使用者自行承担 Cloudflare、模型服务和 Google 项目的费用与维护。

## 文件与资源归属

| 内容 | 存放位置 |
| --- | --- |
| Worker 源码、合成的本地配置 | 本仓库的 `cloud/` |
| 可复制的占位配置 | [config.example.json](config.example.json) |
| 真实账户 ID、Worker/桶名、域名与路由 | 仓库外的个人部署目录 |
| 初始化密钥、OAuth 凭据、加密主密钥 | 自己的 Worker Secrets；恢复副本放入个人密码管理器 |
| 作业、设备授权与同步状态 | 自己账户下的 SQLite Durable Object |
| 主动上传的附件与加密凭据 | 自己的私有 R2 桶 |
| 桌面服务地址与设备凭据 | 运行时在设备配置；不编入公开安装包 |

无需创建 D1、KV 或公开 R2 下载域名。Worker 通过 `SPACE` 绑定访问同一 Worker 的 `PersonalSpace`，通过 `FILES` 绑定访问私有 R2，通过 `ASSETS` 提供网页。迁移与每 15 分钟的周期检查由本仓库模板提供。

## 1. 准备自己的账户

1. 安装 Node.js 24、pnpm 11，运行 `pnpm install --frozen-lockfile`。
2. 在自己的 Cloudflare 账户启用 Workers、SQLite Durable Objects 和 R2；按账户当前要求开通相应计费服务。权限与价格以 [Cloudflare 官方文档](https://developers.cloudflare.com/)为准。
3. 在自己的账户创建一个 **私有 R2 桶**，不要启用 Public Development URL 或公共自定义域名。
4. 在 Workers 控制台设置自己的 workers.dev 子域名，或准备自己账户下的自定义域名。
5. 本地执行 `pnpm --dir cloud exec wrangler login`，授权自己的账户。该认证仅用于部署管理，不能作为应用设备密钥。若使用 API Token，也仅在个人环境中配置，不写入本仓库的 GitHub Secrets。

## 2. 在仓库外生成配置

在仓库根目录执行（将路径替换为自己的绝对路径；Windows 可使用 `C:/Users/<用户名>/homework-cloud-private`）：

```bash
pnpm cloud:setup --dir /absolute/outside-checkout/homework-cloud-private
```

脚本只生成带占位符的 `cloud.json`，不连接 Cloudflare、不申请资源、不生成访问授权，也不会覆盖已有配置。打开该文件，填写自己的 Worker 名、Cloudflare account ID、R2 桶名，以及准确的 `PUBLIC_ORIGIN`。账户 ID 在 Cloudflare 控制台获取。

新建目录和文件在 POSIX 系统使用 `0700` / `0600` 权限；Windows 请同时确保该目录的 ACL 只允许自己访问，脚本不会修改已有目录的访问权限。

默认使用自己的 workers.dev 地址，保留 `workers_dev: true`。将 `PUBLIC_ORIGIN` 中的 Worker 名与 Workers 子域名替换为自己的真实值。实际文件不可放回仓库；即使被 `.gitignore` 忽略，也不要在仓库内保存部署密钥。

使用自定义域名时，将 `workers_dev` 改为 `false`，增加以下路由，并使 `PUBLIC_ORIGIN` 与路由对应：

```json
{
  "workers_dev": false,
  "routes": [{ "pattern": "<YOUR_DOMAIN>", "custom_domain": true }],
  "vars": { "PUBLIC_ORIGIN": "https://<YOUR_DOMAIN>" }
}
```

这是对私有 `cloud.json` 的修改示意，不是完整配置。`PUBLIC_ORIGIN` 必须是 HTTPS 源地址，不含路径、查询或用户密码。不要把密钥填入 `vars`。

## 3. 构建并部署

```bash
pnpm repository:check
pnpm build
pnpm cloud:deploy --config /absolute/outside-checkout/homework-cloud-private/cloud.json --dry-run
pnpm cloud:deploy --config /absolute/outside-checkout/homework-cloud-private/cloud.json
```

`--dry-run` 只编译校验，不部署资源。部署脚本强制要求显式指定私有配置，不从维护者环境推断账户或服务地址；未替换占位符、缺少自己的账户/桶或 HTTPS 源地址时会停止。源码、静态资源、DO 绑定与迁移由脚本补齐，实际生成的配置和 dry-run 产物位于私有目录的 `.generated-homework-cloud/` 中。

**不要直接发布 `cloud/wrangler.jsonc`**：它仅用于本地模拟，其中的资源名不是任何人可用的公共服务。私有部署命令及 Wrangler 输出可能含实际资源信息，不要贴到公开 Issue、PR 或 CI 日志。

## 4. 配置自己的 Worker Secrets

首次部署后，在自己的 Worker 控制台设置以下 Secrets，或用下方命令交互输入。密钥值不应出现在命令参数、终端历史、业务数据库或 Git 中。

| Secret | 何时需要 |
| --- | --- |
| `BOOTSTRAP_SECRET` | 首次认领自己的个人空间；由部署者生成强随机值并妥善保管 |
| `AI_CREDENTIAL_ENCRYPTION_KEY` | 使用网页 AI 密钥管理时需要，独立随机 32 字节，以 64 位十六进制保存 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 可选 GitHub 身份恢复；使用自己注册的 OAuth App |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 可选 Google 身份恢复；使用自己注册的 Web OAuth 客户端 |
| `DRIVE_GOOGLE_CLIENT_ID` / `DRIVE_GOOGLE_CLIENT_SECRET` | 可选 Drive 关联；使用自己独立注册的 Drive Web OAuth 客户端 |
| `DRIVE_CREDENTIAL_ENCRYPTION_KEY` | 启用 Drive 时需要，另一个独立随机 32 字节主密钥，以 64 位十六进制保存 |

```bash
pnpm cloud:deploy --config /absolute/outside-checkout/homework-cloud-private/cloud.json --secret BOOTSTRAP_SECRET
pnpm cloud:deploy --config /absolute/outside-checkout/homework-cloud-private/cloud.json --secret AI_CREDENTIAL_ENCRYPTION_KEY
```

命令会由 Wrangler 提示输入值；`--secret` 后仅填写名称。可对表中其他 Secret 使用相同方式。网页 AI 提供商 Key 在已授权网页的 AI 设置中填写，不与桌面 Key 自动共享。旧 `AI_PROVIDER_KEYS` Secret 仅为兼容来源，新部署无需设置。

请把两个加密主密钥分别保存在个人密码管理器中，不要在普通升级时重新生成。主密钥丢失后，R2 中已有的加密凭据无法恢复，必须重新配置或重新授权。初始化密钥由你创建，不从项目维护者或 GitHub 获取；已有空间不能靠它被重新认领。

## 5. 初始化和配对

1. 打开自己部署的 HTTPS 地址，确认网页和 `/api/health` 可访问；健康检查不返回账户或资源配置。
2. 在网页初始化入口或桌面“设置 → 个人多设备同步”中填写自己的服务地址与 `BOOTSTRAP_SECRET`，创建首台授权设备。
3. 桌面确认同步范围后开启同步；其他设备通过短时配对码，由已有授权设备批准。
4. 在自己的网页中绑定恢复身份，保留至少一个可恢复入口，再迁移其他设备。各自部署之间不共享账号、设备授权或数据。

桌面可通过[独立客户端服务配置](../../docs/SERVICE_CONFIG.md)指定此源地址，同一通用程序无需重新编译；实际文件放在设备用户数据目录，安装更新保留它。该文件与此处的 Cloudflare 部署 `cloud.json` 用途不同。

附件默认只同步元数据，内容仍需每次确认上传。详见[云同步使用指南](../../docs/SYNC.md)。

### 可选：GitHub / Google 身份恢复

在 [GitHub OAuth Apps](https://github.com/settings/developers) 或 [Google Auth Platform](https://console.cloud.google.com/auth/overview)注册自己的应用。回调地址分别是 **自己的 `PUBLIC_ORIGIN`** 加 `/api/recovery/github/callback`、`/api/recovery/google/callback`，Google 客户端类型选 **Web application**。Google 测试状态下将自己的账号加入 Test users。配置对应 Worker Secrets 后，在已有授权的网页中绑定；未绑定身份不能直接认领空间。

桌面授权不等于浏览器已登录，首次绑定需要先完成网页配对。应用按提供商稳定账号 ID 校验身份。完整配置要求见 [GitHub OAuth 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)与 [Google Web Server OAuth 文档](https://developers.google.com/identity/protocols/oauth2/web-server)。

### 可选：Google Drive

在自己的 Google Cloud 项目启用 **Google Drive API** 与 **Google Picker API**，创建独立 Web OAuth 客户端，回调为自己的源地址加 `/api/drive/callback`。权限为 `https://www.googleapis.com/auth/drive.file`，测试时添加自己的账号；配置表中三个 Drive Secrets 后，在应用设置中连接。无需把 API Key 或访问令牌放入前端。操作与授权限制见 [Drive 关联说明](../../docs/SYNC.md#google-drive-文件关联)。

## 升级、备份与公开贡献

- 升级时复用自己的私有目录、账户、Worker、桶和主密钥，重新构建、dry-run 后部署。变更服务地址时同步更新 OAuth 回调地址；其他设备需连接对应服务。
- 测试与正式部署使用不同私有目录、Worker、R2 桶、初始化密钥和加密主密钥。不要对已有数据随意删除或重建 DO 迁移、Worker 或桶。
- 桌面业务备份不包含云端设备授权、Worker Secrets、R2 附件或加密凭据。云端资源与 Secret 的备份恢复由部署者分别管理，不能将桌面数据库备份视为整套云端备份。
- 本仓库的 Actions 仅做本地模拟、检查和通用安装包发布，不部署个人服务，不传递 Cloudflare 管理凭据。需要自动部署时，放到自己另行维护的私有运维仓库。
- 提交前运行 `pnpm repository:check`；提交源码、模板和脱敏文档即可。不要提交实际配置、OAuth 下载文件、部署日志或附带已配对数据的安装包。检查是保护措施，不能代替人工审查任意域名和文件内容。

管理 API 场景可使用 `scripts/build-embedded-worker.mjs --out /absolute/outside-checkout/worker.js` 打包网页；调用方仍须在自己的账户配置同样的绑定、迁移、Secrets 和定时计划。此方式增加 Worker 包体积，正常部署优先使用 Static Assets。
