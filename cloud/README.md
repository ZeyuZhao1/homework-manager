# 可选个人云服务源码

本目录提供可自行部署的 Workers 服务实现：SQLite Durable Object 保存有序同步和设备授权，私有 R2 保存经确认上传的附件及加密凭据，Static Assets 提供在线网页。

- **部署自己的服务**：从[自托管指南](../deploy/cloudflare/README.md)开始；真实配置、地址和凭据保存在仓库外。
- **使用与平台差异**：[云同步指南](../docs/SYNC.md)。
- **接口与数据边界**：[同步设计](../docs/SYNC_DESIGN.md)。

`wrangler.jsonc` 仅用于本地模拟，不包含可复用的生产服务或账户。`pnpm cloud:dev` 使用本地绑定，`pnpm cloud:check` / `pnpm cloud:test` 进行类型检查与本地集成验证。公开 CI 不访问远端 Cloudflare 资源。

克隆源码不会获得任何既有私人空间的使用权；新用户需要自己的账户、私有 R2 桶、初始化密钥，以及按需注册的 OAuth 应用。
