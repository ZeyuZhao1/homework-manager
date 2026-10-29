# Optional personal cloud synchronization

Implementation contract, 2026-10-28. This describes the target and must not be read as a release claim.

The desktop application remains local-first. Sync is disabled until explicitly configured and enabled. Web clients require connectivity and device authorization. The service is single-owner, using a SQLite-backed Durable Object for atomic ordered mutations, R2 for explicitly confirmed uploads, and a cloud scheduler for cloud-managed recurring assignments.

## Privacy and behavior

- No private domain, account ID, resource ID, deployment resource name, route, OAuth identity or credential belongs in the repository or a public desktop bundle. Production configuration lives outside the checkout. Public examples contain synthetic values only.
- Attachments synchronize names and association metadata by default. Each content upload requires explicit confirmation. A later local file change never automatically uploads a replacement.
- Local paths, course roots, filesystem signatures, native rename/undo state and module executables stay on their device. Replaying a remote change never renames, moves, deletes or uploads local files.
- The last server-received modification wins per modified field. Server sequence numbers determine order; replaying the same operation ID does not create a later modification. A tombstone cannot be implicitly restored by a stale edit.
- Cloud-managed recurrence is generated only by the server; offline desktop edits are queued and become effective after synchronization. Local-only installations retain their current scheduler.
- Desktop AI credentials stay in system credential storage. Web AI uses separately configured private Worker secrets, never database, backups or repository content.
- An already authorized device approves new desktop/web devices. Third-party identity provides recovery. Provider selection is configured privately.
- Browser-native limitations are explicit: native filesystem operations, native printing and external process modules remain desktop features.

## Wire API

Types live in `src/sync/protocol.ts`. All routes use JSON except attachment bodies. Errors use `{ error: string }` without credentials or raw infrastructure errors. HTTPS is required except loopback development. Browser requests are same-origin with HttpOnly, Secure sessions; desktop uses a device bearer credential in native credential storage.

| Route | Contract |
| --- | --- |
| `GET /api/health` | Public protocol/version health only |
| `POST /api/bootstrap` | `{ bootstrap_secret, device_name, client_type }`, one-time initial owner setup; returns device and desktop token or browser session |
| `POST /api/pair/start` | `{ device_name, client_type }` -> PairRequest |
| `POST /api/pair/poll` | `{ pair_id, poll_secret }` -> PairResult; authenticated web session established on approval |
| `POST /api/pair/approve` | Authenticated `{ code }`; short-lived, single-use approval |
| `GET /api/devices` | Authenticated `{ devices: SyncDevice[] }` |
| `DELETE /api/devices/:id` | Revoke device session |
| `POST /api/logout` | Revoke current device session |
| `GET /api/snapshot` | Authenticated CloudSnapshot |
| `POST /api/sync` | Authenticated SyncRequest -> SyncResponse |
| `PUT /api/files/:id/content` | Explicit `X-Upload-Confirmed: true`, raw body and content type; immutable R2 version, publish metadata after success |
| `GET /api/files/:id/content` | Authenticated current uploaded content |
| `DELETE /api/files/:id/content` | Remove cloud availability; no local deletion |
| `POST /api/ai/analyze` | Authenticated `{ text, file_ids?: string[], timezone?: string }`; IANA timezone for relative dates (default Asia/Shanghai); use only confirmed cloud uploads and configured private provider secret |
| `GET /api/recovery/providers` | Public enabled flags; authenticated requests also receive bound booleans, never identity/configuration values |
| `GET /api/recovery/:provider/start` | Begin OAuth with state and PKCE; `intent=bind` requires an authorized browser, `intent=login` cannot bind; absent intent preserves legacy behavior |
| `DELETE /api/recovery/:provider` | Authenticated same-origin unlink; existing device sessions remain, pending OAuth states are invalidated |
| `GET /api/recovery/:provider/callback` | Verify state, provider identity and prior binding; authorize recovered device |

Rate-limit unauthenticated pairing/bootstrap/recovery endpoints. Never return session secrets through the public change stream. Bootstrap, pairing and provider callbacks must fail closed if configuration is absent.

## Entity payloads

Payloads mirror database rows except where explicitly narrowed. Each entity has the stable source ID; `id` itself is carried as `entity_id`.

- semester: `name`; course: `semester_id,name,code`.
- assignment: its current domain fields and `custom_fields`; no local path fields.
- file: `name,mime,size,cloud_version` (optional); local `path` is never transmitted.
- link: `assignment_id,file_id,role,page,chapter,problem,note`.
- common_file: `course_id,file_id,kind,label`, ID `course_id:file_id`.
- module_file_link: current fields excluding local paths.
- setting: `{value}`, ID restricted to shared user-facing settings.
- module_state: `{enabled}`, built-in modules only; external installation state stays local.
- provider: `name,kind,base_url,model`, never api_key/has_key. ai_setting: `{value}` for provider selection.
- recurring_series: database row fields including `rule_json,due_rule_json,status`, optional explicit `timezone`.
- recurring_occurrence: `series_id,sequence_no,scheduled_at,due_at,state,assignment_id,overridden`.
- calendar: `semester_id,week1_start_date`, entity ID is semester ID.
- history: path-free business audit fields only; file names are permitted, raw path-bearing details are not.
- import_course_map: `module_id,account_key,remote_course_id,course_id`; import_link: `module_id,account_key,remote_course_id,remote_assignment_id,assignment_id,baseline`; import_ignored: same source identity plus `baseline`. These are business provenance, never authentication cookies or credentials. Opaque deterministic IDs identify the natural source key. Newly imported courses/assignments use versioned deterministic UUIDs; pre-existing UUIDs and links are preserved.

Remote application, cursor advancement and queue acknowledgements must be atomic. Pending unsent local changes must survive pulling newer server records. Parent deletion emits child tombstones. Reconnect and retries must be idempotent. Backup recovery suspends synchronization and re-establishes a baseline instead of replaying a rolled-back device identity/cursor.

An existing desktop begins an explicit baseline session before sending its initial entities. While any baseline is incomplete, cloud recurrence generation is paused, including snapshot and scheduled paths. Only the importing authorized device may import existing occurrence identifiers. Completing all initial pages ends the baseline and hands future generation to the cloud. A lost connection must not let a half-imported series generate duplicate assignments.

### 网页 AI 凭据管理

授权设备可读取 `GET /api/ai/credentials` 的布尔配置状态，或通过 `PUT /api/ai/providers/:id/credential` 提交 `{api_key}` 替换密钥，`DELETE` 清除。服务商必须存在，写入要求同源授权、限流和 8KB 请求限制；响应不含密钥。

凭据以 AES-GCM（随机 12 字节 IV，服务商 ID 为附加认证数据）保存在私有 R2 前缀，使用 `AI_CREDENTIAL_ENCRYPTION_KEY` Secret 的 32 字节主密钥；不经 EntityStore、变更流、快照或业务备份。附件内容 API 限定 `content/<file-id>/` 前缀，不能读取凭据对象。旧 `AI_PROVIDER_KEYS` 只作为兼容来源；清除写入禁用标记，防止旧值复活。
