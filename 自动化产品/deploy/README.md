# v138 部署入口契约（沿用 v137 迁移安全协议）

> 本文件是代码仓内的通用契约，不代表当前生产实况。v138 仍只允许作为
> **生产只读迁移验收版**；资源级管理员鉴权和私有媒体注册表未收口前，
> 且统一模型用量 receipt/outbox 未实现前，不得开启生产业务写入。本地开发使用 `start.command`，不使用本目录的
> 生产入口。

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
`rsync --delete`、`--delete-excluded` 或整目录覆盖。发布应生成新的版本化
release，验证后再原子切换；不在当前目录原地清理。

## 生产环境最小契约

真实配置必须放在 release 外的绝对路径，由 `ACG_ENV_FILE` 指定。进程
环境优先于文件，不得在 release 内保留 `.env`、`.env.local` 或
`apps/video-workshop/.env.local`。

```bash
ACG_RUNTIME_MODE=production
ACG_DB_BOOTSTRAP_MODE=validate
ACG_READ_ONLY=1
ACG_REQUIRE_INTERNAL_TEAM=1
ACG_RELEASE_ID=20260803-v138-home-usage-audit-1
ACG_RELEASE_ROOT=/srv/acg/releases/<release-id>
ACG_PERSISTENT_ROOT=/srv/acg/shared
ACG_ENV_FILE=/srv/acg/shared/config/runtime.env
ACG_READY_TOKEN=<random-secret>

DATA_DB=/srv/acg/shared/data/data.sqlite
LEGACY_DATA_FILE=/srv/acg/shared/data/data.json
UPLOAD_DIR=/srv/acg/shared/uploads
COMPOSED_DIR=/srv/acg/shared/composed
CUSTOM_CANVAS_BLOB_DIR=/srv/acg/shared/canvas_blobs
VIDEO_WORKSHOP_PROJECTS_DIR=/srv/acg/shared/video-workshop/projects
VIDEO_WORKSHOP_OUTPUT_DIR=/srv/acg/shared/video-workshop/outputs
VIDEO_WORKSHOP_UPLOAD_DIR=/srv/acg/shared/video-workshop/uploads
HF_HOME=/srv/acg/shared/model-cache

VIDEO_WORKSHOP_HOST=127.0.0.1
VIDEO_WORKSHOP_PORT=8765
VIDEO_WORKSHOP_URL=http://127.0.0.1:8765
VIDEO_WORKSHOP_HEALTH_URL=http://127.0.0.1:8765
```

sidecar URL 只允许 `http` + 字面回环 IP + 显式同端口，不允许用户信息、
path、query 或 fragment。

## 发布前只读校验

```bash
cd /path/to/unpacked-release
ACG_RELEASE_ID=20260803-v138-home-usage-audit-1 \
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

```bash
cd /srv/acg/releases/<release-id>
deploy/start_server.sh
```

启动成功不以 `/api/health` 为准，必须以受 token 保护的 `/api/ready` 为准：

```bash
curl -fsS -H "X-Readiness-Token: $ACG_READY_TOKEN" \
  http://127.0.0.1:8787/api/ready
curl -fsS http://127.0.0.1:8765/api/health
```

`/api/ready` 要求 release、SQLite/schema/migration ledger、ACG 团队迁移、所有持久
路径、sidecar 精确版本和只读状态、无限画布 manifest 全部通过。

## 迁移与备份边界

迁移不在应用启动中执行。只能在只读预检、维护窗冻结写入、完整备份
与恢复演练后，使用 `python -m server.migrations` 的显式 status / apply /
ACG preflight / ACG apply 命令。主服务、sidecar、后台任务及其他 writer 必须保持
停止或服务端冻结；`status` / `acg-preflight` 保持 `ACG_READ_ONLY=1`。每个 apply
只能在单独 CLI 进程中临时覆盖 `ACG_READ_ONLY=0`，并同时提供对应的
`ACG_ALLOW_SCHEMA_MIGRATION=1` 或 `ACG_ALLOW_ACG_TEAM_MIGRATION=1`、版本和数据库
identity 确认；结束后先恢复 `ACG_READ_ONLY=1` 再启动服务。禁止把外部环境文件
永久改成可写或在 apply 期间启动业务进程。两次连续迁移必须验证幂等，记录数不得下降。

v137 不允许把原始 v120 二进制回滚到已迁移数据库上。回滚只能使用兼容
137003/137004 的前向版本。完整媒体备份、异机恢复演练、锁定依赖的同环境
离线 wheelhouse，仍是真正执行生产迁移前的硬门禁。

## Docker

镜像包含主后端、sidecar、静态闭包、FFmpeg 和两个隔离的 Python 环境，
但不包含真实配置和运行数据。必须只映射 `8787`，且把完整持久根和
外部 env 挂载到 `/data`。下一轮未完成目标环境依赖锁定和恢复演练前，
本仓库不将 Docker 示例命令视为生产发布授权。

视频工坊包含 AGPL-3.0 的 OpenMontage 精简运行文件。公网部署前须落实
`apps/video-workshop/THIRD_PARTY_NOTICES.md` 中的许可证和网络交互源代码提供义务。
