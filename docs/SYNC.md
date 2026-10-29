# 可选个人云同步与网页版

本功能保留桌面本地优先模式。默认关闭同步；未启用时不会发送同步请求或上传附件。云端面向一个人的多设备空间，不提供公开注册或多人共享。

## 客户端和范围

- Windows、macOS、Linux 继续使用 Tauri 桌面应用，离线修改保存在本地 SQLite。
- 网页支持电脑、手机和平板，必须联网；可添加到支持的浏览器主屏幕。手机 PWA 的页面禁用双指缩放，普通浏览器页面保留缩放；顶部安全区由应用背景延伸填充，移除独立深色遮罩及主题切换刷新。页面与弹窗使用各自滚动区域，动态视口缩小时编辑器随之收缩。只有主题偏好写入普通 Cookie，服务端提前提供匹配的主题元数据和清单。iOS 原生顶栏、键盘及安装时缓存表现仍需目标设备验证。没有离线网页编辑或后台通知保证。
- 学期、课程、作业、自定义字段、状态、命名设置、内置模块开关、AI 服务商元数据、周期计划、文件关联及脱敏业务历史参与同步。外部导入的来源映射和忽略基线也参与同步，外部模块程序本身仍留在设备上。
- 本地目录、绝对路径、文件大小/mtime 观测、原地改名撤回栈、外部进程模块和桌面 API Key 不会同步。
- 附件内容默认不上传。关联或选择文件只建立元数据；每次内容上传都有独立确认，之后本地文件变化不会自动再次上传。

## 初次连接与设备授权

1. 在你自己的 Cloudflare 账户部署私有服务，并设置一次性初始化 Secret。部署配置和凭据必须留在仓库外。
2. 在首台桌面的“设置 → 个人多设备同步”输入私有服务地址，选择首次初始化，输入初始化 Secret。也可以先在网页版初始化。
3. 桌面显示准备同步的实体数量；确认开启后才建立同步基线。实际附件不随此确认上传。
4. 新桌面或浏览器申请配对，将短时配对码输入已授权设备的同步设置。新设备获得独立、可撤销授权，不能使用 Cloudflare 管理 Token 充当设备凭据。
5. 首次导入会保留已有 UUID 和已生成的周期节点。导入分页尚未完成时，云端暂停周期生成，避免生成重复作业；请保持导入设备联网直到完成。

桌面开启后，会在启动、窗口聚焦、网络恢复及定期检查时同步；常规写操作也会提示同步运行。同步失败保留本地待发送队列，下次重试沿用相同操作 ID。网页版约每 30 秒及重新聚焦时刷新，也可以手动刷新。

## 修改顺序、删除与恢复

同一字段以服务端最后接收的修改为准，不弹出冲突选择。不同字段分别发送补丁。离线设备较晚上传的旧修改可能覆盖其他设备之前的同字段修改；不依赖设备时钟判断先后。同一操作的网络重试不会被视为一次新修改。

删除保留墓碑，旧设备不能通过过期编辑自动复活记录。删除业务记录不会删除本机实际文件。若一台设备已有旧随机 ID 的来源导入作业，另一台应先同步来源映射再导入；无法安全自动合并既有的不同 UUID 作业。新来源导入使用确定性 ID，减少独立设备首次导入的重复。

数据库恢复会先在暂存库校验核心表、引用和迁移，成功后替换。备份不包含设备授权，恢复后暂停同步，需要重新配对和核对基线，不能直接回放备份中的旧同步队列。

## 文件与周期

文件采用稳定逻辑 ID，每台设备分别保存本地定位。新设备可以手动重新定位，或在文件已上传的情况下明确选择下载位置。下载不会覆盖已有文件。网页可下载已上传附件；只有元数据的文件会显示相应提示。

云管理周期由服务端统一生成，全部桌面关闭后仍运行；当前后台约每 15 分钟检查，读取云端快照时也会补查，并非精确定时提醒。离线可以修改计划，联网后生效。规则保存 IANA 时区，默认 `Asia/Shanghai`；改变设备所在时区不会悄悄改变已有云规则。超过既有自动补齐阈值仍需审核。

暂停或断开某台设备后，云端周期继续执行，本机不会自动接管云管理周期。未开启过云管理的独立本地安装保持原调度行为。首次导入中断会保留保护状态；其他授权设备可查看待完成设备，并在确需放弃时撤销其授权，再核对遗留计划。

网页不执行磁盘原地改名、撤回改名、系统打印或本地外部模块；对应入口隐藏或提示桌面专属，不返回模拟成功。

## AI 与身份恢复

桌面 AI Key 仍只保存在系统凭据库。已授权网页可在“设置 → AI 作业导入 → 添加／编辑服务商”直接填写、替换 API Key；留空保留已有值，也可单独清除。网页只显示已配置状态，不回显原密钥。密钥使用 AES-GCM 随机 IV 加密后，存于 R2 独立私有前缀；加密主密钥 `AI_CREDENTIAL_ENCRYPTION_KEY` 仅存 Worker Secret。密钥不进入业务数据库、业务备份、同步实体、浏览器持久存储或 GitHub，也不自动同步至桌面凭据库。

旧 `AI_PROVIDER_KEYS` Secret 仍可作为兼容来源；网页保存的值优先，清除操作留下禁用标记，避免旧值自动恢复。部署者应安全保留主密钥；更换或遗失主密钥后，已有加密内容无法解密，需要重新填写服务商密钥。个人测试部署已自动配置主密钥，日常管理无需进入后台数据库。

网页识别前的文件内容仍需独立确认上传。识别只产生待审核草稿，确认保存后才创建作业。网页请求携带当前浏览器时区，用于解释相对日期。

GitHub 和 Google 恢复入口均受私有部署配置控制。请在仍有授权设备时，先授权一个浏览器，再在该浏览器设置中绑定恢复身份。桌面 Bearer 授权不会自动登录浏览器。恢复验证提供商的稳定账号 ID，不通过同名或相同显示昵称认领空间。

## 私有部署

公共文件 `cloud/wrangler.jsonc` 只用于本地模拟，所有资源名都是合成示例。真实账号 ID、Worker 名、桶名、域名、路由、OAuth 客户端配置必须写在仓库外的私有 JSON 中。私有网络地址不会编入公开桌面包；由用户运行时配置。已授权设备在访问时仍能看到实际域名。

私有配置最小形状如下；所有尖括号均需替换，实际文件必须位于仓库外：

```json
{
  "name": "<YOUR_PRIVATE_WORKER_NAME>",
  "account_id": "<YOUR_ACCOUNT_ID>",
  "workers_dev": false,
  "routes": [{ "pattern": "<YOUR_PRIVATE_DOMAIN>", "custom_domain": true }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "<YOUR_PRIVATE_BUCKET>" }],
  "vars": { "PUBLIC_ORIGIN": "https://<YOUR_PRIVATE_DOMAIN>" }
}
```

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm cloud:deploy --config /absolute/outside-checkout/cloud.json --dry-run
```

部署脚本将代码位置与静态资源位置补齐，并在私有配置旁生成权限受限的配置文件；不会把实际值写回仓库。去掉 `--dry-run` 才会执行真实部署。部署需要你账户中已经创建的私有桶及相应权限。

使用默认测试地址时，可在私有配置中设置 `workers_dev: true` 并移除 `routes`，将 `PUBLIC_ORIGIN` 设为实际 HTTPS 地址。请为测试新建独立 Worker 和桶。

仅能通过管理 API 部署、无法完成 Static Assets 上传时，可运行 `node scripts/build-embedded-worker.mjs --out /absolute/outside-checkout/worker.js`，将当前 `dist` 打包进模块。该备用方式仍使用同一服务、Durable Object 和 R2；上传模块时需设置同样的绑定、迁移、Secret 和定时计划。它会增加 Worker 包大小，常规部署仍优先使用 Static Assets。

以下值应使用 Worker Secret，不写入 `vars`。通过受保护的交互输入或仓库外 Secret 文件配置；不要把值作为命令行参数、日志或提交内容：

| 名称 | 用途 |
| --- | --- |
| `BOOTSTRAP_SECRET` | 首次初始化授权，初始化后不能再次认领已有空间 |
| `AI_CREDENTIAL_ENCRYPTION_KEY` | 必需：32 字节随机主密钥，以 64 位十六进制保存，用于网页凭据加密 |
| `AI_PROVIDER_KEYS` | 可选旧版兼容：服务商 ID 到网页专用 AI Key 的 JSON 对象 |
| `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` | 可选 GitHub 恢复 OAuth 应用 |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | 可选 Google 恢复 OAuth 应用 |

### GitHub / Google 账号登录

两种提供商均可独立启用；客户端显示配置状态，已授权网页还会显示绑定状态。没有配置完整 Client ID、Client Secret 与 HTTPS `PUBLIC_ORIGIN` 的提供商不会提供可点击登录入口。

1. 在 [GitHub OAuth Apps](https://github.com/settings/developers) 新建 OAuth App，Homepage URL 使用自己的服务根地址，Authorization callback URL 使用该地址加 `/api/recovery/github/callback`。生成并安全保存 Client Secret。
2. 在 [Google Auth Platform](https://console.cloud.google.com/auth/overview) 选择项目，配置 Branding 与 Audience；个人测试时将自己的账号加入 Test users。创建 **Web application** 类型客户端，Authorized redirect URIs 使用服务地址加 `/api/recovery/google/callback`。本实现从后端交换授权码，无需填写 JavaScript origins。
3. 将对应 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`、`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 配置为私有 Worker Secrets；实际域名和 OAuth 配置保存在仓库外。不要提交下载的客户端配置或把凭据写入 `vars`。
4. 首次通过设备配对进入网页，在“设置 → 个人多设备同步 → 账号与登录”绑定自己的账号。以后在未授权设备上选择“使用 GitHub / Google 登录”；未预先绑定的身份不能认领空间。
5. 可在同一设置页解除绑定；现有设备会话保留，该身份不能再登录新设备。若要撤销旧设备，请另外使用设备列表的“撤销”。

首次绑定必须在已有网页会话中完成；桌面端按钮打开外部浏览器登录入口，不会把桌面授权传给浏览器。登录/绑定使用短时单次 state、PKCE 与 HttpOnly Cookie，按不可变提供商 ID 识别账号；不保存提供商访问令牌。取消、过期、未绑定、账号冲突、服务端凭据校验、授权码交换及账号读取失败等情况返回应用内固定提示，不展示提供商原始错误。提供商请求采用 Workers 支持的 `manual` 重定向模式并拒绝 3xx，不把授权凭据转发给重定向目标。备用域名上的登录会转到 `PUBLIC_ORIGIN`，配对与绑定应在该正式地址完成。

注册入口和流程依据 [GitHub 官方授权文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)及 [Google Web Server OAuth 文档](https://developers.google.com/identity/protocols/oauth2/web-server)。真实提供商授权仍需完成私有注册、配置及本人账号回调验证。

公开 CI 只运行本地 Worker/SQLite/R2 模拟，不持有私人 Cloudflare 凭据，不部署服务。`pnpm repository:check` 会检查公开候选配置、运行文件和 CI 是否混入私人部署信息；它不能代替对任意新增源码或日志的人工作业审查。

## 开发验证

```bash
pnpm test
pnpm build
pnpm cloud:check
pnpm cloud:test
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

`pnpm cloud:dev` 启动本地服务，静态资源来自 `dist`。本地初始化 Secret 使用被 Git 忽略的 `.dev.vars` 配置，值仅用于本地模拟。Vite `pnpm dev` 仍是演示模式；生产网页一旦无法连接 API 会显示错误，不会降级成样例数据。

真实 OAuth 提供商回调、你的网络环境与私有账户部署，需要在私有测试环境中验证后才能认定正式可用。实现契约见 [SYNC_DESIGN.md](SYNC_DESIGN.md)。


## Google Drive 文件关联

先更新所有桌面客户端至支持 schema 8 / Drive 来源的版本；旧客户端不理解新的 Drive 元数据字段。网页和 PWA 使用在线版本。

1. 在设置的“Google Drive”中检查连接状态并连接账号；桌面需先配对个人云端，同步可以保持暂停。
2. 在作业“关联文件”中选择“从 Google Drive 选择”，或粘贴 Drive / Google 文档、表格、幻灯片链接。私人链接未获文件权限时会再打开选择器，确认选中的文件。
3. 按原有方式填写用途、页码、章节、题号等并保存。关联信息进入业务同步，内容继续留在 Drive；不自动上传到 R2、下载或传给 AI。
4. 打开文件关联详情或点击“刷新信息”时才查询最新名称和可访问状态。文件移动保持 ID 关联；不可访问时保留原记录和关系。离线仍可查看桌面缓存元数据，网页保持在线使用。
5. 点击文件会在 Google Drive 打开。各设备浏览器仍需登录有权限的 Google 账号；作业簿共用授权不会自动登录外部 Google 页面。

Google Drive 授权与应用 Google 身份登录相互独立，一个 Drive 账号由所有已授权设备共享。断开账号保留已有链接；换账号前需显式断开。Google 的逐文件 `drive.file` 权限本身包含编辑能力，但本应用仅调用读取账户/文件信息接口。

### 私有 Google 配置

在自己的 Google Cloud 项目中启用 **Google Drive API** 和 **Google Picker API**，创建 **Web application** OAuth 客户端，将实际服务源地址加 `/api/drive/callback` 登记为授权重定向 URI。授权界面配置逐文件权限 `https://www.googleapis.com/auth/drive.file`；测试项目添加自己的 Google 账号为测试用户。Google 对测试状态应用的刷新令牌可能施加较短有效期，遇到重新授权提示时可重新连接；正式使用需按 Google 项目要求调整发布状态。

Google 登录成功后仍需调用 Drive API 查询账号。若提示 API 尚未启用，请先在 OAuth 客户端所属项目启用它，再重新连接；失败的连接不会保存为已连接。外观设置接受 `system`，同步的是用户偏好，各设备按自身系统配色显示。

| Worker Secret | 用途 |
| --- | --- |
| `DRIVE_GOOGLE_CLIENT_ID` | 独立的 Drive OAuth 客户端 ID |
| `DRIVE_GOOGLE_CLIENT_SECRET` | Drive 客户端密钥 |
| `DRIVE_CREDENTIAL_ENCRYPTION_KEY` | 独立的 32 字节随机主密钥，以 64 位十六进制保存 |

采用 OAuth 重定向式 Picker，无需将 Google API Key 或访问令牌放进前端。实际客户端文件、域名和加密主密钥保存在仓库外。OAuth 刷新/访问令牌独立加密在私有 R2，不进入数据库、同步、应用备份或日志。链接资源键属于关联元数据，不是 OAuth 凭据。

配置参考：[Google Picker 系统浏览器流程](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker)、[Drive 权限范围](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)。

## 手机 PWA 顶部显示

手机页面、作业详情、周期详情和全屏表单共享页面背景与根级安全区变量，内容在各自的窗格中滚动，文档背景留在正常布局。iOS 不再设置已弃用的 `apple-mobile-web-app-status-bar-style`；`theme-color` 只用于支持它的浏览器，更新它不等于刷新 iOS 的原生状态区。时钟、信号和电量仍由系统绘制，应用统一其取色来源，而不伪造系统状态栏。

旧主屏幕图标可能保留安装时的窗口配置。先在 Safari 打开更新后的网页，必要时重新添加到主屏幕；新图标可能需要重新授权。保留原有已授权设备，完成新入口的配对或身份恢复后再移除旧入口，不要先清除网站数据。

自动化手机视口测试只能验证页面画布、取色、滚动和安全区，不能证明真实 iOS 系统状态区已更新。[WebKit 官方建议移除旧状态栏配置](https://www2.webkit.org/show_bug.cgi?id=317153#c2)，[iOS 原生状态区与安装配置相关的问题记录](https://bugs.webkit.org/show_bug.cgi?id=301994)仍应结合具体设备判断。
