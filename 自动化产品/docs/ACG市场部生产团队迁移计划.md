# ACG 市场部生产团队迁移计划

记录日期：2026-08-03

状态：**生产已按受保护流程完成 `137003`→`137004`→`139001`→`140001`→`140002`→`140003`→`140004` 并运行 `9e8aeb5`，团队、资源 scope、媒体 registry 与数据完整性正常。当前增量候选保留 expand-only `140005` compose 幂等 schema，并新增供应商对“可见交付的精确媒体依赖”的只读权限。`140005` 必须绑定新的 fresh v2 备份单独双跑，交付媒体验收必须证明 parent/child 正例可读且跨 team/交付外文件/写删反例被拒绝；禁止重做既有 ACG/resource/media data migration。本地候选尚未部署，未写生产。**

本文件负责 ACG 市场部的数据归属、角色映射、冲突阻断和迁移验收。它不是生产执行授权；每个 apply 必须单独确认，不能由应用启动隐式触发。首次迁移不搬动当前约 15 GB 数据，也不将模块机械拆分与生产数据迁移绑定。

## 0. 当前事实边界

### 0.1 本地 v140

- 生产普通启动 validate-only；RO 允许完整的旧库进入迁移验收并显示 `writeReady=false`，RW 则必须在提供 socket 前通过全部安全门禁。
- 完整八步迁移使用 `schema_migrations` version/checksum/status 账本；`137004`、`140002`、`140004` 均先只读 preflight，再在 `BEGIN IMMEDIATE` 中重新校验并幂等冻结，`140005` 只新增 owner-scoped compose claim 表。已退役的 `137001/137002` 不得复用。
- 每个 apply 必须绑定当次操作前刚生成的 v2 备份；上一个 apply 成功后不得复用旧 manifest。
- `140002` 要求历史资源 100% 得到唯一 scope；unresolved/ambiguous 阻断，陈旧次要引用仅在唯一主证据存在时记 warning。可选 override 只能在 writer 冻结的维护窗作为精确人工复核 manifest 生成，必须绑定 database identity、path/logical digest、schema/user version 和 fresh backup manifest SHA；使用 override 的 preflight/apply 均传同一备份并重验，不能解决歧义。
- `140004` 只登记媒体归属，不改 URL/文件。无引用文件 quarantine 保留但不开放；有引用却缺 owner、缺文件、多 owner 或 team 冲突会阻断整个 apply。
- 主服务/sidecar 精确 lock、目标 ABI wheelhouse 验签和完整 runtime snapshot/verify/restore-drill 工具已本地实现；正式生产物料与实地演练仍待维护窗。
- v139 usage receipt/outbox/spool 继续作为 `139001` 独立不变量；旧 event/member ID 原样保留，未知 token 不估算。最终测试与提交证据以 `docs/version.md` 为准。

### 0.2 生产只读事实快照

以下事实来自 2026-08-03 14:20-14:25 CST 的固定、非交互只读 SSH 命令；未导入生产应用，也未调用会触发状态 heal 的业务接口。数据计数是瞬时快照，部署日必须重新获取。

| 维度 | 已核对的生产事实 | 对 v140 的约束 |
| --- | --- | --- |
| 运行版本 | 首页缓存身份包含 `20260728-v120-shell-21`；活动源码无 Git 元数据，精确 commit 不能由服务器仓库确认 | 当前可确认的是 v120 静态基线，不得把本地 commit 号当作生产事实；新 release 必须携带独立 manifest/build ID |
| 服务 | `dumate-studio.service` 活跃，主服务和 sidecar 健康；主服务自 2026-07-28 启动，systemd 未显式设置 `User/Group` | `/api/health` 不含 release/schema/path 门禁；服务用户与文件 UID/GID 需单独审计，不能和 schema 迁移同时调整 |
| 代码与进程 | 主服务从 `/data/dumate-studio/current` 启动；视频 sidecar 使用独立 `video-workshop-v91` 虚拟环境 | 保留 8787 主入口、8765 回环 sidecar 与双环境边界，不能合并环境或只更新其中一层 |
| 发布拓扑 | `current` 是活动实体目录而非版本 symlink；`.env.local`、SQLite 和媒体目录均位于其中 | 首迁把 `/data/dumate-studio/current` 暂作持久根，新 release 放 sibling `/data/dumate-studio/releases/<id>`；不搬 15 GB、不假设或改造 `current` symlink |
| SQLite | 活动库约 30.9 MB，WAL，`schema_version=23`、`user_version=0`，仅有 12 张业务表；没有 teams、配额、计费或社区表 | v137 不会在普通启动隐式迁移；必须在副本先执行 `137003`，再执行 `137004`，两者均须双演练 |
| 角色与业务量 | 72 名成员，其中 admin 2、editor 63、supplier_parent 4、supplier_child 3；`docs` 10,048 条 | 迁移应验证唯一 canonical `admin`，其余管理员映射为 ACG 管理员；不能只看总数不下降 |
| 模型用量 | 两张 usage 表完整性正常并持续写入；现有 824 条 LLM、1,186 条图片/视频事件。北京时间 8 月 2 日两表均为 0；指定 editor 的 7 月 31 日成功视频工坊项目未生成任何中央用量行 | 保留原事件和 member ID，不更新、删除或重算；在副本对账 sidecar runtime/provider receipt。没有可核验 token 的历史项目只作 observation，不补写“真实用量” |
| 媒体 | uploads 4,352 文件/约 4.7 GB；composed 801/约 6.9 GB；canvas blobs 449/约 368 MB；视频 runtime 971/约 3.3 GB | 数据库、媒体和 runtime 必须形成同一一致性点的 inventory 与恢复演练，禁止用本地目录覆盖 |
| 无限画布 | 生产 v120 vendor 目录 128 文件/约 4.0 MB；本地 v139 审计闭包为 63 文件/1,759,226 bytes | 不得在旧目录上增量覆盖；新 release 必须从 manifest 构造独立闭包并拒绝额外/缺失文件 |
| 运行环境 | Python 3.12.3、SQLite 3.45.1、FFmpeg 6.1.1；数据盘空间充足 | 副本演练和目标/回滚 release 必须锁定并核对同等运行环境，维护窗内禁止安装依赖 |

生产数据库文件当前权限为 `0644`，所有者名称在系统账户库中无法解析；`.env.local` 为 `0600`。正式调整服务用户或目录归属前必须按 UID/GID、ACL 和真实读写路径单独演练，不能为了“规范权限”在迁移窗口递归改属主。

## 1. 迁移目标、固定身份与冲突规则

- 内部团队固定为：`team_id=team-acg-marketing`、`slug=acg-marketing`、`name=ACG市场部`、`kind=internal`。
- 生产 canonical `admin` 映射为 ACG 唯一所有者；用户名、密码哈希、认证状态和登录方式逐字节保持不变。
- 其他既有管理员映射为 ACG 团队管理员，既有创作者映射为 ACG 团队成员。
- 当前供应商父/子账号、供应商分配关系和平台账号通过稳定关系映射到 ACG；供应商端仍是独立工作区。
- 既有资产、草稿、生产单、任务、批次、发布清单、回链、统计和历史媒体通过 owner、平台账号、供应商及项目稳定 ID 投影归属，不复制业务记录、不批量改媒体 URL。
- 迁移后新注册的个人账号保持个人租户；未来外部团队使用自己的团队与供应商关系，不自动并入 ACG。

以下任一情况必须在 dry-run 中阻断，不能用 `INSERT OR IGNORE` 跳过后仍写完成标记：

- 固定 team ID、slug、名称或 kind 已被不一致对象占用。
- 没有唯一 canonical `admin`、出现多个 owner，或用户名 canonical 化后冲突。
- 成员已归属外部团队，或供应商/平台账号已映射到冲突团队。
- 存在无法唯一推导 owner/team 的孤儿账号、资产、任务、草稿、发布记录或媒体引用。
- migration version/checksum/status 与目标 release 不匹配，或上次迁移处于 running/failed/dirty。
- 稳定 ID 集合、关系摘要、删除墓碑、幂等键、业务计数或媒体 inventory 异常减少。

## 2. 架构优化与迁移分期

每一阶段形成独立提交、release manifest、自动测试、生产副本证据和停止条件；上一阶段稳定前不得进入下一阶段。

### 阶段 0：release 兼容合同（本地已实现核心门禁）

- release verifier 已解析原生 ESM 图并拒绝同一物理模块的多 URL 身份；画布闭包必须恰好符合 63 文件 manifest 的路径、大小和 SHA-256。
- 主服务、视频 Web、sidecar、iframe bridge 和画布 vendor 仍必须当作一个 release tuple，不允许单层替换。
- 生产副本演练前仍须记录 API 契约、SQLite schema hash、稳定 ID、owner/team/supplier 摘要和媒体 URL 形状；本地 verifier 不代替这些生产证据。

### 阶段 1：v137 部署安全层（本地已实现，生产未演练）

- 环境与固定路径已改为 store 导入前解析；生产数据库不存在、落入 release 或不属于批准持久根时 fail closed。
- 生产普通启动强制 validate-only；只有显式 CLI 可以执行编号迁移。主服务和 sidecar 均有服务端只读契约，GET 不得隐式恢复或写库。
- `/api/ready` 已将 release、schema/data migration、SQLite、固定路径、sidecar contract 和画布 manifest 组合为非 2xx fail-closed 门禁。
- Python SQLite backup API 已提供一致副本、`quick_check`、大小与 SHA-256 验证；真实恢复演练和媒体 inventory 仍必须在生产副本执行。

### 阶段 2：分离 release 与持久数据（首迁无搬迁方案）

- 新代码只放 `/data/dumate-studio/releases/<release_id>`，首次 v140 直接把现有 `/data/dumate-studio/current` 当作持久根。systemd 指向批准的版本目录，数据通过绝对环境变量回指 `current` 下现有路径。
- 不重命名、清空、转为 symlink 或对 `current` 删除式同步；不在首迁维护窗搬动约 15 GB 媒体。
- 后续物理拆分成 shared 数据目录是独立项目，必须另做备份、恢复和路径切换演练。

### 阶段 3：机械拆分模块，不改接口与数据

- `server.main:app` 继续作为兼容入口，按 auth/teams/supplier/assets/community/canvas/video 逐域迁出 router。
- `server.store` 继续作为 façade，内部逐域迁到 repositories/services；事务由 service/UnitOfWork 统一拥有。
- 一次只搬一个域，规范化 OpenAPI、响应、schema、稳定 ID 和媒体 URL 必须零计划外差异。
- 前端保留单一 transport/auth singleton；`remote.js` 旧导出作为适配器，避免拆出多个 token/缓存状态实例。

### 阶段 4：完整八步迁移（前七步已在生产完成，当前仅增量 `140005`）

- `137003` 只做 expand-only schema；`137004` 的只读 dry-run 不持久化 scope，正式 apply 会在同一写事务内重新预检并把当次稳定 member/supplier/account/identity scope 写入冻结表后建立 ACG 关系。不全表覆盖 docs JSON，不改凭据、父子关系、业务 ID 或媒体 URL。
- 新环境固定顺序是 `137003`→`137004`→`139001`→`140001`→`140002`→`140003`→`140004`→`140005`。当前生产只执行 `140005`；每次 apply 前必须创建 fresh v2 备份，结束后重新读取 identity 和逻辑摘要，第二次必须零写。
- `acg_internal_migration_scope` 只是“本次生产历史对象的冻结映射”，不是通用租户资源鉴权账本。

### 阶段 5：租户与媒体 scope（代码已实现，生产证据待验收）

- `140002` 将 docs 资源收口为 deny-by-default；生产副本必须达到 scope 100%，真正 unresolved/ambiguous 为 0。陈旧次要引用 warning 不影响已由唯一主证据确定的归属。
- `140004` 建立兼容历史 URL/Range 的 registry。无引用文件 quarantine 但不对用户开放；有引用缺 owner/缺文件/歧义则零写阻断。
- 供应商切片已 fail closed，但仍必须在 `137004` 生产映射后跑完外部团队 A/B 与供应商父/子正负矩阵。

### 阶段 6：后续域化

- 再处理账号与 team_accounts 原子事务、AssetRegistry、持久任务 lease/heartbeat、事务 outbox 和 docs 逐集合 shadow table。
- 多 worker、对象存储、Postgres、bundler 或微服务化均是后续独立项目，不能与 ACG 迁移捆绑。

## 3. 兼容合同

| 合同 | 必须保持 | 允许演进方式 |
| --- | --- | --- |
| HTTP API | 路径、状态码、核心请求/响应字段 | additive 字段；旧客户端契约测试通过后再 contract |
| SQLite | 旧稳定 ID、旧字段可读、凭据不变 | 编号 expand migration；至少两个 release 周期双读，暂不 drop |
| 媒体 | uploads/composed/blob/runtime 相对 URL 与 Range 行为 | 只加 registry/scope；不改名、不搬 URL、不重写历史引用 |
| 原生 ESM | 一个物理模块一个 canonical URL | 内容哈希或版本目录；N/N-1 字节同时可用，禁止 query token 指向漂移字节 |
| 视频工坊 | 8787 主服务、8765 sidecar、Web 与 bridge 为批准组合 | capabilities/buildId/projectSchemaVersion additive 升级，旧 JSON 始终可读 |
| 无限画布 | source→build→manifest→vendor 闭包可复现 | 独立 verifier 核对当前 63 文件、大小、SHA-256、入口 build ID，无额外文件 |
| iframe bridge | 保留 origin/source 校验和现有 type/payload | 增加 protocolVersion/channelId/requestId/capabilities；legacy v1 与 v2 并存 |
| 运行环境 | 固定数据路径、单 worker、独立 sidecar venv | 锁定 Python/SQLite/FFmpeg/字体与依赖；构建、迁移、启动分离 |

## 4. 逐集合归属矩阵

| 数据域 | 稳定身份/当前权威 | 迁移方式 | 不变量 |
| --- | --- | --- | --- |
| members / teams | member ID、canonical username、固定 team ID | 直接写显式关系表 | 凭据、用户名和登录方式不变；唯一 owner |
| supplier / accounts | supplier ID、account ID、既有父子与分配关系 | 建 team_suppliers/team_accounts，冲突即停 | 不改变父子层级、平台账号 ID 或供应商工作区 |
| docs collections | collection+record ID、owner/account/supplier/project 关系 | 先投影 scope，不批量改 JSON | productions/jobs/sessions/batches/assets/deliveries/analytics 等稳定 ID 与数量可解释 |
| uploads / composed | 现有 URL、文件 hash、引用记录 | 只登记 registry/scope，不复制或改名 | 相对路径、Range、大小、hash 不异常变化 |
| canvas | project ID、draft revision、blob ID | 保留现表和 Blob，补 scope 与核对器 | 旧草稿可恢复，Blob 引用与 vendor 闭包成对验证 |
| video runtime | workshopProjectId/sourceProjectId、历史 JSON 与媒体 | 旧格式可读，新写 additive schemaVersion | 主库映射和 runtime inventory 同时备份、同时核对 |
| community | post ID、author identity、source identity | 由 `137003` 显式扩展 schema，通用资源 scope 完整后再开放 v137 写入 | 代分享署名/团队、跨入口幂等、点赞收藏隔离 |
| quota / billing | reservation/event/idempotency key | 显式账本迁移，不从 UI 状态推导 | 预占、结算、退款守恒；ACG 无限积分旁路可审计 |
| model usage | 旧 usage event ID、member ID；`139001` operation/provider attempt receipt | 旧表原样保留，新 receipt/outbox 追加式迁移并以唯一键幂等；completion spool 与 DB 同一恢复集 | 旧 824 / 1,186 行及关联成员不漂移；未知历史 token 不估算，轮询/刷新/重启不重复 |
| tombstone / requests | deleted record ID、request/idempotency key | 原样保留并纳入摘要 | 不复活已删除数据，不重复执行历史请求 |

无法通过上述稳定关系唯一归属的记录必须进入冲突报告，不得默认收入 ACG。

## 5. 部署前硬条件与副本演练

必须同时满足：

1. 用户明确批准目标 commit、release manifest、部署范围和维护窗口。
2. 从批准提交建立干净 release；不得同步当前脏工作区，不得携带本地数据库或运行态。
3. 真正由服务端强制冻结主 API、后台任务和 sidecar writer；不是只在前端隐藏按钮。
4. 冻结后使用 Python SQLite backup API 生成一致副本并验证 `quick_check`、大小与 SHA-256；禁止复制活动 `data.sqlite*` 兜底。
5. 数据库、uploads、composed、canvas blobs、视频 runtime、环境、认证状态、systemd、依赖与旧代码/静态闭包形成同步目录外的完整回滚点，并完成隔离恢复演练。
6. 新环境迁移 CLI 必须按 `137003`→`137004`→`139001`→`140001`→`140002`→`140003`→`140004`→`140005` 执行，并使用 schema/ACG/resource/media 各自的 preflight/apply 及专用 ALLOW；当前生产不得重跑前七步，只增量执行 `140005`。每个 apply 前产生 fresh v2 backup manifest/数据库副本/独立 manifest SHA-256；只读命令保持 `ACG_READ_ONLY=1`，只有当次 CLI 进程临时设 `0`。
7. 目标 release 和兼容回滚 release 均已离线构建并验证；维护窗内禁止安装或升级依赖。
8. 主服务、视频 Web、sidecar、bridge 和画布 closure 的 release tuple 与 ESM 图验签通过。
9. `MODEL_USAGE_COMPLETION_SPOOL_DIR` 位于 release 外持久根并与 SQLite 形成同一备份/恢复点；readiness 的 unresolved、outbox pending、spool pending/corrupt/conflict 全为 0。历史恢复只在隔离数据库副本执行 `scan -> apply -> reconcile-copy`，第二轮零写入，禁止把恢复工具目标指向活动库。
10. 在生产同规格磁盘的暖库副本连续 5 轮 receipt 压测：唯一数/授权数精确且零异常；64 路 P99 不超过 750ms、128 路 P99 不超过 1s、单次不超过 1.25s、异步事件循环 P99 gap 不超过 100ms；外部长锁期间必须零供应商调用。

副本演练至少执行：

- 对两个分别从同一原始一致备份恢复的副本执行全部七步顺序；第二轮零新增、零重复、零归属漂移，每步后 `quick_check=ok`。
- 比较迁移前后稳定 ID 集合、逐集合 digest、owner/team/supplier 关系摘要、删除墓碑、社区 identity、配额流水和幂等键。
- 比较 `llm_usage_events` / `api_usage_events` 的原始 ID、member ID、逐日计数和总计；新 usage receipt/outbox 连续 reconciliation 两次，第二次必须零新增。成功项目与中央账本不一致时列为 observation/conflict，不能用猜测回填通过门禁。
- 凭据 hash 仅在内存比较，不打印、不写文档；任何差异立即停止。
- 目标 release 与兼容回滚 release 均能读取 v120 历史数据、v120 视频 JSON、canvas 草稿/Blob 和历史媒体。
- 在强制只读模式执行浏览器验收，数据库/WAL/hash 前后不变，证明 GET 零写入。
- 角色矩阵覆盖 ACG owner/admin/member、个人、外部团队 A/B、供应商父/子和游客的读/写/删/文件访问。
- 两个独立 SQLite 连接验证幂等与事务原子性；不能只依赖进程内 lock。
- 画布 vendor 必须由 manifest 独立验签为恰好 63 文件；不能接受生产旧目录的 128 文件混合闭包。

任何冲突非零、计数无法解释、稳定 ID/媒体减少、凭据变化、readiness 非 2xx 或第二次迁移仍写入，都禁止进入生产切换。

## 6. 未来获授权后的生产顺序

1. 重新取得生产实时事实、所有 writer、在途任务、文件 UID/GID、release/schema 身份、稳定 ID/关系摘要和媒体 inventory；冻结全部写入并完成一致备份与恢复验证。
2. 在 `/data/dumate-studio/releases/<id>` 建立 **v140 只读目标 release**，以 `/data/dumate-studio/current` 为首迁持久根，不搬动现有数据。RO readiness 可为 2xx，但 `writeReady=false` 是预期。
3. 在两个生产形状副本分别按七步顺序执行，每个 apply 前 fresh v2 backup；核对凭据不变、唯一 owner、供应商/账号映射、resource scope 100%、可开放媒体唯一归属和 `quick_check`。
4. 完成完整 snapshot/restore drill、正式 wheelhouse 离线验签/安装、usage 恢复/性能、权限/媒体正负矩阵和兼容回滚 release 验证。
5. 只有上述证据全部通过，才能在维护窗冻结全部 writer，对生产重复同一七步顺序。完成后仍先 RO 验收，只有 RW 预检明确 `writeReady=true` 才能解除冻结。
6. 真实付费生成、真实发布或外部消息仍需用户另行授权。

一旦生产库执行 `137003` 或 `137004`，原始 v120 代码不能读取演进库，只能作为历史基线；回滚必须使用理解新 schema/租户语义的兼容 release。

## 7. 通过标准

- 迁移前后稳定 ID 集合一致；所有新增结构和关系均有可解释摘要，业务记录、墓碑和媒体无异常减少。
- SQLite `quick_check=ok`，migration ledger clean，`/api/ready` 返回批准的 release/schema/path/sidecar/vendor 组合。
- canonical `admin` 为 ACG 唯一 owner，其他管理员与创作者映射正确，凭据逐字节不变。
- 当前供应商绑定 ACG 且仍展示独立首页、全部账号和发布清单。
- 供应商 parent 和已绑定 child 能下载可见交付的全部 cover/pack/final media，ZIP 实际包含媒体字节；未绑定 child、其他团队、交付外文件和任何写/删请求仍 fail closed，缺媒体时不产出伪完整 ZIP。
- ACG、个人、外部团队 A/B 与供应商层级遵守 deny-by-default 隔离。
- 通用 `resource_scopes` 和 uploads/composed owner registry 均达到 coverage=100%、orphan=0、conflict=0，历史直接 URL、Range 和缓存行为仍可用。
- 主前端 ESM 无多身份，视频 bridge N/N-1 兼容，v120 项目 JSON 与历史媒体可读，画布闭包 hash 正确。
- 关键写事务原子、幂等，失败扣点/退款/资产持久化/社区分享不会产生半成品。

## 8. 回滚原则

- **开放新写入前失败**：保持冻结，优先切换到已验证的兼容回滚 release。只有能证明数据库与媒体快照属于同一一致性点且快照后零写入时，才可整体恢复原 v120 快照。
- **开放新写入后失败**：再次冻结并先保存事故后数据库与媒体；只能切换到理解新 schema、租户、角色、配额和幂等语义的兼容 release，并做前向数据修复。
- 新迁移采用 expand-first，但“旧代码能忽略新增表/列”必须由兼容矩阵实证。执行 v137 `137003` 或 `137004` 后，原始 v120 不得作为代码回滚目标。
- 回滚不得只替换主前端、sidecar、视频 Web、bridge 或 canvas vendor 中的一层；release tuple 必须成套切换。
- 任何数据恢复、反向迁移或权限批量修复都需要用户再次明确批准。

## 9. 永久禁止事项

- 禁止用本地 SQLite、种子状态、uploads、composed、canvas blobs 或视频 runtime 覆盖生产。
- 禁止 reset、clean、清库、重新播种、整目录覆盖或删除式同步来解决权限/显示问题。
- 禁止在未显式启用 v137 生产 validate-only/只读契约时导入应用，禁止调用任何本地 auto-bootstrap 通道，也不得用 `/api/state` 代替 SQLite `mode=ro` 原始核验。
- 禁止启动时自动建表、补列、改凭据、修角色或收编团队。
- 禁止在一个 release 同时搬路由、改 API、改 schema、搬媒体、改服务用户和迁移 ACG 数据。
- 禁止在任务 lease 未持久化前启用多 worker，或把 sidecar 合回主服务依赖环境。
- 禁止在未盘点冲突前新增强制唯一约束/外键，或用 `INSERT OR IGNORE` 掩盖冲突。
- 禁止在聊天、Git、Markdown 或日志摘要中记录明文服务器地址、密码、密钥、token 或凭据哈希。
- 禁止把“本地已提交”“自动测试通过”“生产只读可达”描述为“已推送”“已上线”或“已完成生产验收”。
