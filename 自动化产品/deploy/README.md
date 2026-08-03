# v140 部署入口契约

> 本文件是代码仓内契约，不代表生产已迁移。v140 本地已收口资源/媒体
> deny-by-default、fresh v2 备份绑定、完整 snapshot/restore 和精确离线依赖工具；生产
> 仍为 v120、未部署、未写入。RO 可用于迁移验收，RW 只能在生产形状副本、冻结
> 恢复、正式 wheelhouse 均通过且 `writeReady=true` 后开启。本地开发继续使用 `start.command`。

正式操作前还必须阅读：

- `docs/服务器部署交接指南.md`
- `docs/ACG市场部生产团队迁移计划.md`
- `docs/本地代码架构优化与服务器迁移部署方案.md`
- `deploy/release-runtime.manifest.json`

## 运行边界

- 主平台 FastAPI：默认 `8787`，只对外暴露这一个端口。
- 视频工坊 sidecar：默认 `127.0.0.1:8765`，必须是字面回环 IP，禁止
  Nginx、安全组或 Docker 端口映射直接公开。
- 无限画布：不起独立进程，只使用已审计的
  `vendor/infinite-canvas/` 和对应 manifest。
- 主服务与 sidecar 必须同时回报精确的 `ACG_RELEASE_ID`；仅为非空
  `contractVersion` 不能通过门禁。

## 不可变的持久化边界

生产环境文件和所有运行数据必须位于 release 目录外，并位于显式
`ACG_PERSISTENT_ROOT` 下。生产入口不会创建缺失目录、安装依赖、复制旧数据、
自动建表或修复角色。任一持久路径不存在、落入 release 内或不在持久根下都会
fail closed。

必须保护：

```text
外部 env / 密钥 / 认证状态
SQLite 及 WAL 所代表的业务数据
uploads / composed / canvas_blobs
视频工坊 projects / uploads / outputs
服务器独立的代理、Nginx、systemd 和上传大小配置
```

禁止用本地数据库或本地 runtime 覆盖服务器；禁止对生产目录使用
`rsync --delete`、`--delete-excluded` 或整目录覆盖。生产 v120 的 `/data/dumate-studio/current`
是实体目录，首迁暂作持久根；新 release 只放 sibling `/data/dumate-studio/releases/<release-id>`，
不搬动、清理或覆盖 `current` 中约 15 GB 数据。

## 生产环境最小契约

真实配置必须放在 release 外的绝对路径，由 `ACG_ENV_FILE` 指定。进程
环境优先于文件，不得在 release 内保留 `.env`、`.env.local` 或
`apps/video-workshop/.env.local`。

```bash
ACG_RUNTIME_MODE=production
ACG_DB_BOOTSTRAP_MODE=validate
ACG_READ_ONLY=1
ACG_REQUIRE_INTERNAL_TEAM=1
ACG_REQUIRE_RESOURCE_SCOPES=1
ACG_REQUIRE_PRIVATE_MEDIA=1
ACG_RELEASE_ID=20260803-v140-deployment-readiness-1
ACG_RELEASE_ROOT=/data/dumate-studio/releases/<release-id>
ACG_PERSISTENT_ROOT=/data/dumate-studio/current
ACG_ENV_FILE=/data/dumate-studio/current/.env.local
ACG_READY_TOKEN=<random-secret>
PUBLIC_BASE_URL=https://<current-approved-public-origin>
PRIVATE_MEDIA_LEGACY_ORIGINS=<comma-separated-reviewed-old-origins-or-empty>

BACKUP_ROOT=/data/dumate-studio/current/backups
LOG_DIR=/data/dumate-studio/current/server/logs
DATA_DB=/data/dumate-studio/current/server/data.sqlite
MODEL_USAGE_COMPLETION_SPOOL_DIR=/data/dumate-studio/current/server/model_usage_spool
LEGACY_DATA_FILE=/data/dumate-studio/current/server/data.json
UPLOAD_DIR=/data/dumate-studio/current/server/uploads
COMPOSED_DIR=/data/dumate-studio/current/server/composed
CUSTOM_CANVAS_BLOB_DIR=/data/dumate-studio/current/server/canvas_blobs
VIDEO_WORKSHOP_PROJECTS_DIR=/data/dumate-studio/current/runtime/video-workshop/projects
VIDEO_WORKSHOP_OUTPUT_DIR=/data/dumate-studio/current/runtime/video-workshop/outputs
VIDEO_WORKSHOP_UPLOAD_DIR=/data/dumate-studio/current/runtime/video-workshop/uploads
BGM_LIBRARY_DIR=/data/dumate-studio/current/runtime/bgm-library
HF_HOME=/data/dumate-studio/current/runtime/model-cache

VIDEO_WORKSHOP_HOST=127.0.0.1
VIDEO_WORKSHOP_PORT=8765
VIDEO_WORKSHOP_URL=http://127.0.0.1:8765
VIDEO_WORKSHOP_HEALTH_URL=http://127.0.0.1:8765
```

`BACKUP_ROOT`、`LOG_DIR`、`BGM_LIBRARY_DIR` 和上述所有其他目录必须在获授权的
预备阶段按实际 UID/GID 预创建，并已位于 `/data/dumate-studio/current` 下。生产入口
不会创建缺失目录；任一路径不存在、落入 release 或超出持久根都应 fail closed。
不得为了通过预检而递归改整个 `current` 的属主或权限。

sidecar URL 只允许 `http` + 字面回环 IP + 显式同端口，不允许用户信息、
path、query 或 fragment。
`PUBLIC_BASE_URL` 必须是当前经审计的公网 origin；`PRIVATE_MEDIA_LEGACY_ORIGINS`
只能列出生产副本中确实出现过的历史 origin。两者均不接受凭据、path、query、
fragment 或回环地址；不得为了让 `140004` 通过而添加宽泛域名。

## 发布前只读校验

```bash
cd /path/to/unpacked-release
ACG_RELEASE_ID=20260803-v140-deployment-readiness-1 \
  deploy/verify_release_contracts.sh
```

校验同时覆盖：

- 首页可达 ESM 图及“一个物理模块只有一个 URL 身份”，并输出当前图的内容摘要；
- 无限画布精确文件集、size 和 SHA-256；
- 主后端、迁移/备份工具、部署脚本、视频 sidecar、视频 Web 桥接与
  依赖声明的 runtime manifest；
- manifest 的 release id 必须精确等于 `ACG_RELEASE_ID`。

画布或 runtime manifest 覆盖范围内的漏文件、路径越界、symlink、哈希不一致，
以及 ESM 多 URL 身份或不可达依赖，都必须在停服、备份和迁移之前失败。
runtime manifest 所列源文件发生变化时必须重建
`deploy/release-runtime.manifest.json`；ESM 变化必须重跑 verifier，并把输出摘要
绑定到批准的外部 release 摘要/identity set。当前 CSS 和普通 assets 尚未纳入
同一 manifest，这仍是生产发布 P1；不得声称 verifier 已自动阻断所有前端字节混版，
也不得在服务器上为了通过门禁而重建 manifest。

## 启动与 readiness

`deploy/start_server.sh` 和 `deploy/docker_entrypoint.sh` 均只允许 production；传入
`local/test` 会立即失败。二者均不负责安装依赖或执行迁移。非 Docker
环境还要求两个已审计、已预装的独立虚拟环境。

当前生产的 native 唯一进程所有者是两个独立的
`systemd Type=simple` 单元：主单元直接执行 uvicorn，sidecar 单元直接
执行 `run.py`。切换时必须继续保持这一唯一拓扑，禁止在两个单元运行时
再调用 `deploy/start_server.sh` 启动第三套脱离 systemd 的后台进程。该脚本
仅作停止两个单元后的隔离维护工具；它会在 TERM 前同时核对 service、
cwd、Python executable 和命令行标识，pidfile 或端口指向未知进程时只会
阻断，不会尝试终止它。

持续存活不由 `start_server.sh` 另造 supervisor；切流前要审计两个单元均为
`Type=simple`、直指已批准 release、带有受控的 `Restart=on-failure`。另用
systemd timer 周期检查受 token 保护的 `/api/ready` 和 sidecar `/api/health`；
timer 只调用轻量 registry/ledger/readiness，不调用 snapshot、media preflight 或
约 15 GB 媒体强哈希。若实际 unit 或 timer 未达到该契约，只能停在 RO
验收，不得切 RW。

启动成功不以 `/api/health` 为准，必须以受 token 保护的 `/api/ready` 为准：

```bash
curl -fsS -H "X-Readiness-Token: $ACG_READY_TOKEN" \
  http://127.0.0.1:8787/api/ready
curl -fsS http://127.0.0.1:8765/api/health
```

`/api/ready` 要求 release、SQLite/schema/migration ledger、ACG 团队迁移、所有持久
路径、sidecar 精确版本和只读状态、无限画布 manifest，以及模型用量
unresolved/outbox/spool pending/corrupt/conflict 全部通过。
生产 RO 模式可在旧库完整、路径/release/sidecar/画布正常时返回 2xx，但必须同时显示
`writeReady=false`。生产 RW 模式只有在 `137004/140002/140004`、全部 schema、媒体 coverage
和上述检查全部通过时才能启动，最终必须 `writeReady=true`。

`MODEL_USAGE_COMPLETION_SPOOL_DIR` 必须位于 release 外持久根，并与 SQLite 纳入同一
snapshot ID 的备份与恢复；不得为了通过 readiness 删除来源未核验的 envelope。

## 完整生产快照与离线依赖

维护窗必须复制并人工核对
`deploy/runtime-snapshot.production-v120.plan.example.json`，不得用通用示例代替。该计划带
`profile=acg-production-complete-v1`；组件名、类型、必填性、持久路径和越界许可都是精确契约。
数据库、uploads、composed、canvas blobs、视频 runtime、BGM、模型缓存、现用环境、systemd
和 Nginx 等必保组件不得缺失；只有计划中明确 `required=false` 的 legacy data、usage
spool、server logs 或未启用的 v140 外部环境才可以以 `absent` 状态记录，仍不得从计划删除。
create 前必须冻结所有 writer，restore-drill 只能输出到全新的隔离目录。
create stdout 中的 `manifestSha256` 必须另行记录；verify 和 restore-drill 都强制提供该值，
不允许只信任快照目录内可同时被替换的文件。
启动器内置 `backup_runtime_data` 只是启动前辅助保护；其默认 `BACKUP_MEDIA=0` 只保存
部分媒体路径清单，即使手工开启媒体打包也不等于 complete profile 的同一 snapshot ID、
哈希验签与恢复演练。它不能作为 schema/data 迁移的备份或回滚点。

```bash
python3 server/scripts/runtime_snapshot.py create \
  --plan deploy/runtime-snapshot.production-v120.plan.example.json \
  --persistent-root /data/dumate-studio/current \
  --output /data/dumate-studio/backups/<snapshot-id>
python3 server/scripts/runtime_snapshot.py verify \
  --snapshot /data/dumate-studio/backups/<snapshot-id> \
  --confirm-manifest-sha256 <independently-recorded-manifest-sha256>
python3 server/scripts/runtime_snapshot.py restore-drill \
  --snapshot /data/dumate-studio/backups/<snapshot-id> \
  --output /data/dumate-studio/restore-drills/<snapshot-id> \
  --confirm-manifest-sha256 <independently-recorded-manifest-sha256>
```

生产运行依赖以 `server/requirements.lock.txt` 和
`apps/video-workshop/requirements.lock.txt` 为唯一基线。主服务正式基线固定为
FastAPI 0.68.1、Starlette 0.14.2、Pydantic 1.10.26；不得用开发机的 Pydantic 2
回归代替。`server/requirements-test.lock.txt` 是独立、完整的主服务测试闭包：它必须
逐项同版本包含主运行锁，且只可额外包含 TestClient 所需的 requests/urllib3。测试锁
不得安装到生产主服务 venv，否则生产 `installed` 验证应将其判为额外包并拒绝。视频
sidecar 的 37 项运行锁显式包含 ctranslate2 所需的 `setuptools==83.0.0`；setuptools
不属于可忽略启动包，缺失或版本漂移必须拒绝。

正式 wheelhouse 必须由生产同 Python/ABI 的联网构建环境产生，用
`deploy/verify_offline_dependencies.py build` 创建，
build stdout 中的 `manifestSha256` 必须独立记录；`verify-wheelhouse` 必须传入该值，
同时校验运行时身份、lock 和每个文件 SHA-256。离线安装后再用 `installed` 拒绝
缺包、版本漂移和额外包，并强制执行 `pip check`。此外，每个生产运行 wheelhouse
都必须先运行 `install-check`：从空的一次性 venv 以 `--no-index --no-deps` 安装，随后
再做 exact-installed 与 `pip check`，证明 lock 本身覆盖传递依赖。不得在维护窗现场联网
升级依赖，也不得只信任可与 wheel 同时被替换的目录内 manifest。

```bash
python3 deploy/verify_offline_dependencies.py verify-wheelhouse \
  --python /path/to/target-python \
  --lock server/requirements.lock.txt \
  --root /path/to/main-wheelhouse \
  --confirm-manifest-sha256 <independently-recorded-manifest-sha256>
python3 deploy/verify_offline_dependencies.py install-check \
  --python /path/to/target-python \
  --lock server/requirements.lock.txt \
  --root /path/to/main-wheelhouse \
  --confirm-manifest-sha256 <the-same-independently-recorded-manifest-sha256>
python3 deploy/verify_offline_dependencies.py install-check \
  --python /path/to/target-python \
  --lock apps/video-workshop/requirements.lock.txt \
  --root /path/to/video-wheelhouse \
  --confirm-manifest-sha256 <independently-recorded-video-manifest-sha256>
```

主服务完整回归必须另建测试 wheelhouse 和一次性测试 venv。先证明测试锁严格扩展
运行锁，再在没有 `.env.local` / `.env` 的干净提交中运行离线、清空进程环境的测试器；
测试器还会要求 Node 支持 `--experimental-strip-types`，并记录 Python、Node、FFmpeg、
Git 版本。任何本地 Key、endpoint 或私密配置都不能作为用例通过条件。干净提交可因
未携带被 Git 排除的旧 v120 只读快照而跳过对应单项；runner 只允许该精确测试和原因，
其他任何 skip 都视为失败。

```bash
python3 deploy/verify_offline_dependencies.py extends \
  --base-lock server/requirements.lock.txt \
  --extended-lock server/requirements-test.lock.txt \
  --allow-extra requests --allow-extra urllib3
python3 deploy/verify_offline_dependencies.py build \
  --python /path/to/production-compatible-python \
  --lock server/requirements-test.lock.txt \
  --output /path/to/main-test-wheelhouse
tools/run_locked_server_tests.sh \
  --python /path/to/production-compatible-python \
  --wheelhouse /path/to/main-test-wheelhouse \
  --confirm-manifest-sha256 <independently-recorded-test-manifest-sha256>
```

## 迁移与备份边界

迁移不在应用启动中执行。只能在只读预检、维护窗冻结写入、完整备份
与恢复演练后，使用 `python -m server.migrations` 显式执行：
`137003`→`137004`→`139001`→`140001`→`140002`→`140003`→`140004`。`137004`、`140002`、
`140004` 分别先做 ACG/resource/media preflight。主服务、sidecar、后台任务及其他 writer 必须保持
停止或服务端冻结；`status` / `acg-preflight` 保持 `ACG_READ_ONLY=1`。每个 apply
只能在单独 CLI 进程中临时覆盖 `ACG_READ_ONLY=0`，并同时提供对应的
`ACG_ALLOW_SCHEMA_MIGRATION=1` 或 `ACG_ALLOW_ACG_TEAM_MIGRATION=1`、版本和数据库
identity 确认；结束后先恢复 `ACG_READ_ONLY=1` 再启动服务。禁止把外部环境文件
永久改成可写或在 apply 期间启动业务进程。两次连续迁移必须验证幂等，记录数不得下降。

每一个会写库的 apply 都必须绑定“紧接在该 apply 前”生成的 v2 SQLite
备份；上一个 apply 成功后数据库逻辑摘要已变，不得复用旧 manifest。备份
命令 stdout 中的 `manifestSha256` 需独立记录，迁移 CLI 同时校验
manifest 字节、关联 SQLite 文件的 size/SHA-256/`quick_check`/逻辑摘要，并在
同一 `BEGIN IMMEDIATE` 中重新比对当前源库的 inode identity、路径摘要、
schema/user version 和逻辑摘要。任一不匹配都在业务表或迁移账本写入前拒绝。

```bash
python3 server/scripts/consistent_sqlite_backup.py \
  --source "$DATA_DB" \
  --destination /persistent/backups/<snapshot-id>/data.sqlite \
  --manifest /persistent/backups/<snapshot-id>/data.sqlite.manifest.json

ACG_READ_ONLY=0 ACG_ALLOW_SCHEMA_MIGRATION=1 \
python3 -m server.migrations apply \
  --confirm-version <approved-next-schema-version> \
  --confirm-identity <status-identity> \
  --backup-manifest /persistent/backups/<snapshot-id>/data.sqlite.manifest.json \
  --backup-database /persistent/backups/<snapshot-id>/data.sqlite \
  --confirm-backup-manifest-sha256 <recorded-manifest-sha256>
```

`140002` 会把可由 owner、账号或现存上游唯一证明的历史文档冻结到一个 scope。
已失效的次要引用只在存在该唯一证据时记为 warning；歧义或仍等待现存上游解析的记录
继续阻断。确实没有自动证据的孤儿记录，只能在 writer 冻结的维护窗生成精确人工复核的
`acg-resource-scope-overrides-v1` 文件；模板见
`deploy/resource-scope-overrides.plan.example.json`。禁止在代码或命令中硬编码生产 ID。

无 override 预检输出的 `unresolvedResources` 必须与 entries 完全相等。文件除自身 SHA-256 外，
还必须精确绑定冻结库的 `databaseIdentity`、`databasePathSha256`、`databaseLogicalSha256`、
`schemaVersion`、`userVersion` 和当次 fresh `backupManifestSha256`。使用 override 的 resource-preflight
必须同时提供该备份 manifest/闭合 SQLite/SHA；apply 在同一 `BEGIN IMMEDIATE` 重新复核全部
绑定。缺项、多项、重复项、错库、状态漂移、无效目标或歧义项均零写拒绝。
首先在下列 preflight 命令中省略两个 override 参数、保留三个 backup 参数，用其
`unresolvedResources` 和数据库绑定字段生成人工复核 manifest；然后在 writer 仍冻结且数据库
未改变的前提下，使用同一 fresh 备份运行完整 preflight 和 apply。

```bash
python3 -m server.migrations resource-preflight \
  --confirm-schema-version 140001 \
  --confirm-identity <status-identity> \
  --override-manifest <reviewed-resource-overrides.json> \
  --confirm-override-manifest-sha256 <recorded-override-sha256> \
  --backup-manifest <fresh-snapshot.manifest.json> \
  --backup-database <fresh-snapshot.sqlite> \
  --confirm-backup-manifest-sha256 <fresh-backup-manifest-sha256>

ACG_READ_ONLY=0 ACG_ALLOW_RESOURCE_SCOPE_MIGRATION=1 \
python3 -m server.migrations resource-apply \
  --confirm-schema-version 140001 \
  --confirm-identity <status-identity> \
  --override-manifest <the-same-reviewed-resource-overrides.json> \
  --confirm-override-manifest-sha256 <the-same-recorded-override-sha256> \
  --backup-manifest <fresh-snapshot.manifest.json> \
  --backup-database <fresh-snapshot.sqlite> \
  --confirm-backup-manifest-sha256 <fresh-backup-manifest-sha256>
```

`140002` 成功后必须证明历史资源 scope 覆盖 100%。陈旧次要引用只在已有唯一
主证据时是 warning；真正 unresolved/ambiguous 仍阻断。`140004` 不改文件名或 URL：无业务
引用的孤立文件 quarantine 保留但不开放；有引用却缺 owner、缺文件、归属歧义或
registry conflict 将在任何 registry/账本写入前拒绝整个 apply。

v139 的 `139001` usage migration、receipt/outbox reconciliation 和 completion spool
replay 也必须在生产同环境副本连续验证两次，第二次零新增、零重复投影，旧 usage event
ID/member ID 保持不变。

历史用量恢复只允许先以 `server/model_usage_recovery.py` 对只读生产副本/runtime 做
`scan`，人工审计 evidence-only manifest，再对隔离目录数据库副本执行 `apply` 与
`reconcile-copy`。工具必须拒绝活动 `DATA_DB`、源库同目录和生产持久根目标；无法证明的
token、日期和调用不得猜补。任何生产 apply 仍需单独授权。

```bash
python3 server/model_usage_recovery.py scan \
  --database <closed-read-only-snapshot.sqlite> \
  --video-dir <snapshot-video-projects> --output <manifest.json>
python3 server/model_usage_recovery.py apply \
  --manifest <manifest.json> --target-database <isolated-copy/data.sqlite> \
  --confirm-manifest-sha256 <manifest-sha256> --expected-db-sha256 <current-copy-sha256>
python3 server/model_usage_recovery.py reconcile-copy \
  --manifest <manifest.json> --target-database <isolated-copy/data.sqlite> \
  --confirm-manifest-sha256 <manifest-sha256> --expected-db-sha256 <recomputed-copy-sha256>
```

每一步后都要重新计算副本 SHA-256；不得把上一阶段的 hash 复用到已变化的副本。

receipt 性能必须在生产同规格磁盘暖库后连续 5 轮通过：64 路 P99 不超过 750ms，
128 路 P99 不超过 1s，单次不超过 1.25s，异步事件循环 P99 gap 不超过 100ms；
任一写异常、重复授权、数量错位或数据库长锁期间发生供应商调用都阻断部署。

v140 不允许把原始 v120 二进制回滚到已迁移数据库上。回滚只能使用理解七步 schema/
租户/媒体语义的前向兼容版本。RO readiness 通过不代表可写；只有 RW 启动预检明确
`writeReady=true` 才能解除冻结。

## Docker

镜像包含主后端、sidecar、静态闭包、FFmpeg 和两个隔离的 Python 环境，
但不包含真实配置和运行数据。必须只映射 `8787`，且把完整持久根和
外部 env 挂载到 `/data`。下一轮未完成目标环境依赖锁定和恢复演练前，
本仓库不将 Docker 示例命令视为生产发布授权。

视频工坊包含 AGPL-3.0 的 OpenMontage 精简运行文件。公网部署前须落实
`apps/video-workshop/THIRD_PARTY_NOTICES.md` 中的许可证和网络交互源代码提供义务。
