# 星阵版本记录

## v142.7 - 2026-08-12（本地候选：生成启动同步与共享图片排队）

### 本版范围

- 修复无限画布首次生成时“只写本地可恢复检查点，服务器项目和 resource scope 尚未落库就创建后台 job”的时序竞态。编辑与新建两个付费边界都先串行等待服务器 PUT 与 revision 收口，再创建 owner-scoped 生成任务；已开始的 PUT 不会被并发的同 base revision 覆盖。
- 修复远程批量数据水合后比图片配置探测更早恢复 worker，导致明明服务器图片模型可用却把整批写成“未配置”的竞态。批量图文、单图重试、创意视频故事板、静态分镜与视频封面都在真实 submit 边界重新等待配置，只接受非 mock 图片适配器。
- 修复无限画布多参考图中的超窄 Logo 条仍被图片上游以参数无效拒绝：短边不足 `256px` 继续等比放大，宽高比超过 `3:1` 的图片只在送往 provider 的临时副本上增加最小白色留白，原图像素不裁切、不拉伸，服务器素材、画布 Blob 和账号数据均不改写。
- 生产现场证据显示，王端的最新画布项目和 job 已成功同步，但在全站三个图片上游槽位都被其他任务占用时等待 `30s` 后返回 `image_queue_busy / providerCalled=false`，没有调用上游或重复扣费。本版将单画布并发收敛为 `2`，为其他成员/功能保留槽位；共享服务器排队窗口调整为 `120s`，避免正常长耗时图片刚腾出槽位前就提前失败。上游参数拒绝和结果未知仍保持可审计终态，不伪造成功、不自动重提。
- 批量标题生正文不再把模型偶发超长输出直接裁成残句。模型在第一次输出时即被要求将正文、换行和 `4–7` 个标签完整控制在 `900` 个 Unicode 字符以内；最终值必须严格少于 `1000`。若模型仍违约则该次明确失败，不截断、不把残缺文案推进图卡，也不因超长自动发起第二次改写。
- 每账号每日 `2` 条仍只由首次成功交付占用，但日期改为用户选择的 `planDate`，不是点击提交的当天。服务端在同一 `BEGIN IMMEDIATE` 事务中按计划日裁决，`quotaPublishedAt` 仅保留提交审计时间；历史无 `quotaDayKey` 的定时交付按 `planDate` 统计。批量起草和账号选择不再因“今天已满”被提前阻断，最终发布按所选日期查询并由服务端原子复核。
- release/cache identity 更新为 `20260812-v1427-generation-startup-sync-1`。本版不新增 schema、数据迁移、依赖、持久目录、权限或 Nginx 变更；生产部署仅允许同步验签代码/静态和 release 外非密钥排队参数，不覆盖 SQLite、账号、媒体、任务、认证或 provider 密钥。

### 本地验证边界

- 真实 Chromium 在独立临时数据库与 fake image provider 上连续跑 `10/10`：每轮都人为延迟图片配置探测，浏览器仍等待并选中真实图片适配器；项目 PUT 均为 `200`、后台 job 均为 `202`、最终均为 `succeeded` 且保存 `1` 张图，计划日配额查询也返回所请求日期。trace 为 `trace-1786529452245.trace`。该证据验证浏览器、静态模块、主服务、SQLite scope、后台 worker、媒体落盘和日期查询时序，不使用生产数据或付费 provider。
- 当前 release verifier：Phase 0 `e6d8163161d1038332582ee7f1b412315ba1e2b45832dacb3e4cfab61e055d09`，ESM `61 modules / 349 edges`、graph `5893310e3b9d7b656ef730ef54309ec27f645b5fcdbe7ae5a48494edaf0b6bd9`、closure `99bdd3f5e967621fba60ed4cd89cd7c642f586e6bed1e8bbf8c2403e43d62883`，canvas `63 files / 1,770,288 bytes / 3ba12d2d53d68f89918077ae3a0ef532eba56a1110a2cac86d0c6c0cad44b065`，runtime `65 files / 3,323,973 bytes / d7e4528cebaf2111dfd2f4d1875aafc0aaad250fb3c37d730f4256c69425c527`。
- 目标 Ubuntu x86_64 已在无私密、锁定 20 包的一次性 Python 3.12 环境完成 `825 collected / 824 passed / 1 approved skip`；视频 sidecar `160/160`、Node `129/129`、三套现有 Linux wheelhouse 与本版锁 SHA 精确一致且 `pip check` 通过。
- 生产真实 provider 、目标 Linux 锁定全量与新旧服务并行切流仍是独立部署门禁；只有无流量候选真实最小图片调用及切流后受控无限画布/批量图文都完整成功，才能记为生产闭环。

## v142.6 - 2026-08-12（生产：供应商头像与批量文案发布边界）

### 生产部署闭环

- 生产流量现运行功能 SHA `f2c35ed1457e635331ce56042cf40b8ef4f78371`，分支 `codex/v141-content-governance`，release/cache `20260812-v1426-supplier-avatar-copy-limit-1`，实际 sibling release 为 `20260812-v1426-supplier-avatar-copy-limit-1-f2c35ed1`。v142.6 主服务/sidecar 在私有端口 `8793/8769` 完成全部验证后，以两条置于 v142.5 规则之前的精确路由原子接流；v142.5 主服务、sidecar 和路由始终 active/RW，发布全程没有停服、只读或 502 窗口，撤销 v142.6 路由即可回到仍在线的 v142.5，且不回灌旧数据库。
- 只同步验签 Git archive 中的代码和静态文件。生产外部 env 由 v142.5 服务器文件原值复制，权限保持 `0600`，仅替换 release 身份、代码根和无流量端口；SQLite、账号、成员、认证、uploads、composed、canvas blobs、视频 projects/uploads/outputs、Nginx 和 provider 密钥均未上传、覆盖或写入 Git/release/日志。运行依赖锁与 v142.5 完全一致，目标 Linux 的主服务 18 包、sidecar 37 包 exact-installed 与 `pip check` 均通过。
- 目标 Ubuntu x86_64 完整验证为锁定主服务 `820 collected / 819 passed / 1 approved skip`、sidecar `160/160`、Node `129/129`。release verifier 与本地候选逐字一致：Phase 0 `700a304cd0b2277bffdd8613be02ddc2b33d048c0a77d38700136c59ec1d57b4`，ESM graph `cccb6260628b003b3189d05dd3b40632aede87e095179861be4ee75735d5e597`、closure `ca9c31f6e0fa5a5d48f412e6c8940b9f8d401669231e3a4ed365adec15b559e3`，canvas `63 files / 1,768,749 bytes / 1cec16f2cd3fede5021d521cd8d0abcc3f46d9d2409c8f3dad5f63b8d6189d75`，runtime `65 files / 3,322,592 bytes / c935ce1784fda6e1166efca02dbd6f1070ad377df71616060332395591a549fc`。
- 切流前在线 SQLite v2 保护点为 `/data/dumate-studio/backups/v1426-pre-f2c35ed1-20260812T054035Z`，manifest SHA-256 `0b65fbbd3874c50930c954dbe88973e1bb059da616b45722bd6b16fbff98b906`，数据库 SHA-256 `a162639be23e6b90751b17d2b408dfbab00f9eab2dba1f2ddd7ec6eb4b4fbb7f`；独立 verify、逐字节 restore drill 和恢复库 `quick_check=ok` 通过。旧 v142.5 单元、路由脚本和私密环境的回滚副本保存在 `/data/dumate-studio/deployment-backups/v1426-pre-f2c35ed1-20260812T054035Z`，其 `SHA256SUMS` 已验证。
- 无流量验收中，主服务与 sidecar 均 active/RW、`NRestarts=0`，protected readiness 为 `ready=true / writeReady=true / startupVerified=true / blockers=[]`。creator-auth 的 LLM、图片、TTS、视频、OmniHuman 和无限画布配置均返回 200 且配置/可达；最小真实文案、图片、TTS、百度搜索 AI 选题均返回 HTTP 200，图片为有效 image data URL，搜索返回 10 条资料和 1 条正文加标签共 `465` 字的合规预览。供应商生产快照读取为 200，既有内容账号头像在携带精确 `accountId` 后返回 200 的有效 PNG；省略账号上下文仍按预期拒绝。
- 公网切流后 health 连续 `10/10` 为 200，root、OpenAPI、community、无限画布和视频工坊入口均 200，匿名 `/api/auth/me` 为 401，页面加载精确 v142.6 cache；真实用户的账号状态、发布配额和交付指标请求持续 200。切流后主服务 HTTP 5xx 与 Traceback 均为 0。SQLite 保持 48 表，行数因 4 次受控模型烟测与正常请求从 `66,982→67,000`，关键业务表无减少，`model_usage_receipts 5,543→5,547` 对应上述四次烟测；六类媒体文件数与字节完全不变。历史 raw missing `47`、pending `48`、isolated `46`、unisolated `1`、effective pending `0` 继续可见，模型/sidecar 用量仍是 warning-only，不会让正常生产停服或转只读。

### 本版范围

- 修复供应商母账号替换内容账号头像时报“私有媒体归属登记失败”，以及供应商账号看板中既有内容账号头像批量破图。供应商身份的权威团队映射存放在 `team_suppliers`，媒体登记现在与资源作用域使用同一团队事实；母账号可维护并读取本团队全部内容账号头像，子账号只读取已分配账号头像。读取必须逐次精确匹配 `账号 → avatarAssetId → 资产 → 文件`，未放宽为团队媒体库通读、跨团队读取、覆盖或通用资产写入。
- 标题驱动的批量图文正文同时在模型提示和本地收口层限定：正文与最终 4–7 个话题标签合计不超过 `1000` 个 Unicode 字符。本地收口会先保留标签预算，再截断超长正文，因此模型偶发超限也不会把不可发布文案推进后续图卡与发布阶段。
- 复核现有账号每日配额契约：只统计 `assets` 中 `delivered=true` 且带权威发布日的成功交付；草稿、起草、图片生成和未发布 production 均不占配额。本版不重写历史配额或业务数据，只保留并复跑“创作不计数、成功发布才计数”的服务端回归。
- release/cache identity 为 `20260812-v1426-supplier-avatar-copy-limit-1`。本版不新增 schema、迁移、依赖、持久目录或 Nginx 变化；生产只新增独立绿色 systemd/路由实例并保留 v142.5 在线回滚，没有修改或覆盖生产 SQLite、账号、媒体与任务。

### 验证边界

- 供应商账号/交付读取、私有媒体全组、发布配额、标题生文案与 release/cache 定向回归 `90/90`；视频 sidecar `160/160`、工作区 Node `129/129` 通过。新增安全负例确认母账号可读取本团队账号的精确头像、错误账号上下文和无上下文读取均被拒绝，供应商仍不能借此读取团队其他媒体。
- 修改 Python 编译、JavaScript 语法、`git diff --check` 与 release verifier 通过。最终 Phase 0 `700a304cd0b2277bffdd8613be02ddc2b33d048c0a77d38700136c59ec1d57b4`，ESM `61 modules / 349 edges`、graph `cccb6260628b003b3189d05dd3b40632aede87e095179861be4ee75735d5e597`、closure `ca9c31f6e0fa5a5d48f412e6c8940b9f8d401669231e3a4ed365adec15b559e3`，canvas `63 files / 1,768,749 bytes / 1cec16f2cd3fede5021d521cd8d0abcc3f46d9d2409c8f3dad5f63b8d6189d75`，runtime `65 files / 3,322,592 bytes / c935ce1784fda6e1166efca02dbd6f1070ad377df71616060332395591a549fc`。测试使用临时数据库与 fake LLM，没有调用真实生成、发布或供应商写入。

## v142.5 - 2026-08-12（生产：批量图文媒体隔离与图片重试恢复）

### 生产部署闭环

- 生产流量运行功能 SHA `f3287b230f8e76d3e744a35bb153307e44e94440`，分支 `codex/v141-content-governance`，release/cache `20260812-v1425-batch-media-recovery-1`，实际 sibling release 为 `20260812-v1425-batch-media-recovery-1-f3287b23`。新主服务/sidecar 在无流量端口完成验证后，以两条置于 v142.3 规则之前的精确路由原子接流；v142.3 绿色服务、路由和更早 v141.3 服务始终 active/RW，发布全程没有停止服务器或切只读。撤销 v142.5 路由会立即回到仍在线的 v142.3，不回灌旧数据库。
- 只从验签 Git SHA 同步代码/静态文件，既有 release 外私密 env 由服务器端原值复制，并且只覆盖 release 身份、代码路径和无流量端口。SQLite、账号、成员、认证、uploads、composed、canvas blobs、视频 projects/uploads/outputs、Nginx 和 provider 密钥均未上传、替换或写入 release/Git/日志。主服务和 sidecar 的依赖锁与 v142.3 完全一致，继续使用已验签 Linux venv；18/37 包 exact-installed 与 `pip check` 通过。
- 目标 Ubuntu x86_64 验证通过：锁定主服务 `817 collected / 816 passed / 1 approved skip`，sidecar `160/160`，Node `129/129`。release verifier 为 Phase 0 `3c497d0b3a523fb5ba21a5cb964d47c33cb8e77b0d0df7f356166e770c72671f`，ESM `61 modules / 349 edges`、closure `77dbdd6882192bc0bd48109f3f42805b87f3ba02b9169cfc9cfe5f08a5da6285`，canvas `63 files / 1,768,749 bytes / 1cec16f2cd3fede5021d521cd8d0abcc3f46d9d2409c8f3dad5f63b8d6189d75`，runtime `65 files / 3,318,796 bytes / c478fbe3aefb64e8c1d273f65b0fa9fb20cea7ee2ad5f5c3acf1ad39dcd2636f`。
- 切换前在线 SQLite v2 保护点为 `/data/dumate-studio/backups/v1425-pre-f3287b23-20260812T033347Z`，manifest SHA-256 `5ffcc0ae3ce27d6b5aa3cff5e8eab621767e963466ff7f5aa865efe4e8f068fb`，备份 SHA-256 `841e2268ddd7d4a0739f17304004e8f8a6a4f69d6a176277b45fc19112d2d3e9`。独立 verify、隔离副本逐字节比较与 `quick_check=ok` 通过；验证完成后只移除了可重建的临时 restore-drill 副本。旧路由、systemd 和私密 env 的代码回滚副本保存在 `/data/dumate-studio/deployment-backups/v1425-pre-f3287b23-20260812T033347Z`。
- 切换前后均为 `48` 表 / `66,978` 行，逐表无减少，SQLite `quick_check=ok`。媒体也无减少：uploads `6,904`、composed `1,005`、canvas blobs `645`、视频 projects/uploads/outputs `63/205/1,968`，字节数保持一致。历史一条 registry 缺失仍以同一证据 SHA 和数量保留；候选主服务先在无流量状态按旧 release 绑定正确拒绝启动，随后用新代码独立重算证明 hash/count/effective pending 未漂移，才只把既有例外的 release ID 精确重绑定到 v142.5，未修改引用、文件、owner 或业务数据。
- 最终主服务和 sidecar 均 active/RW、`NRestarts=0`；readiness 连续两次为 `ready=true / writeReady=true / startupVerified=true / blockers=[]`，sidecar 为 `readOnly=false / writePolicy=normal`。模型用量与 sidecar usage 继续仅作 warning，不阻断普通生产；供应商曝光量、观看量、回传链接和权限数据未放宽或改写。公网 health 连续 `40/40` 为 200，root/OpenAPI/community、Nginx 入口、无限画布和视频工坊静态入口均 200，匿名鉴权为 401；管理员、创作者、Free、供应商 parent/child 共 22 条真实生产只读 API 验收全部通过。部署没有重复提交真实图片、视频、语音、发布或供应商回传。

### 本版范围

- 修复批量图文跨账号错绑媒体的根因：图片资产的内容哈希去重现在同时绑定内容账号，批量生成图片每个 item 则固定建立独立资产。不同账号即使产出字节完全相同的图片，也不再复用对方的 asset ID。
- 发布前浏览器对每张图执行存在性、类型、内容账号、交付状态和物理文件状态校验，不再仅以 `assetId` 非空冒充“已完成”。历史任务中可确证的错账号/错类型绑定保留原 ID 审计痕迹后只清空该错绑 item，其他成功图片不重生。批量发布改为逐条收口：某条未完整不再让后续已完整内容整批中止。
- 图片调用不再把已确认 `failed/not_called` 的旧幂等键永久复用；只在用户明确点击重试时创建新 revision。上游结果未知也会保留已成功图片并转为明确的“可重试缺失项”，不自动重提付费 provider。
- 无限画布对小于 `256px` 短边的 logo/条形参考图仅在上游 transport 副本中等比放大，不修改用户源资产；“把右上角图片换成第二个图片”类指令按定向编辑识别目标与 donor。`ReadTimeout` 在看板上显示可理解且不泄露 provider 地址的恢复提示。
- release/cache identity 为 `20260812-v1425-batch-media-recovery-1`。本版不新增 SQLite schema、迁移、依赖、持久目录或 Nginx 变化；生产只新增独立绿色 systemd/路由实例并保留旧实例回滚，未修改生产 SQLite、账号、媒体或任务。
- v142.4 的 worktree 私密环境回退仅保留给 `local`。`test` 与 `production` 都不再沿 Git commondir 读取主检出 `.env.local`，保证无密钥锁定套件的结果不会被开发者本机配置污染；本地直接启动的便利性保留。

### 验证边界

- 批量媒体、图片 MaaS 与无限画布定向回归 `77/77` 通过；无密钥锁定主服务 CPython 3.12.11 收集 `817`，`816 passed + 1` 个既有获准 v120 快照 skip；视频 sidecar `160/160`，Node `129/129`。无限画布 `lint` / `typecheck` / `build:embed` 通过，vendor 审计同步为 `63 files / 1,768,749 bytes / 1cec16f2cd3fede5021d521cd8d0abcc3f46d9d2409c8f3dad5f63b8d6189d75`。这些自动测试使用本地数据/fake provider，未触发真实图片、视频、语音、发布或供应商回传。
- release verifier 通过：Phase 0 `3c497d0b3a523fb5ba21a5cb964d47c33cb8e77b0d0df7f356166e770c72671f`，ESM `61 modules / 349 edges`，graph `13043a28971f31c5f1f220243a2669f1920f69c6e656e2df673dd548e60c498b`，closure `77dbdd6882192bc0bd48109f3f42805b87f3ba02b9169cfc9cfe5f08a5da6285`，runtime `65 files / 3,318,796 bytes / c478fbe3aefb64e8c1d273f65b0fa9fb20cea7ee2ad5f5c3acf1ad39dcd2636f`。

## v142.4 - 2026-08-11（本地候选：Seedance 参考闭环与并发图卡 JSON 收口）

### 本版范围

- 创意视频的统一参考图不再只在生图/视频提交阶段“挂附件”：既有视觉理解接口先读取真实图片，形成受限视觉摘要、主题词与引用凭据，再约束语言模型的 `0–30s` 逻辑分镜、单张 `16:9` 多格素描故事板提示词和连续视频提示词。image-2 生成故事板时携带原图；最终 Seedance 2.5 同时携带故事板与原统一参考图，显式提交默认 `9:16`、`30s`、音画同出。任何参考图不可验证时都在付费视频调用前停止；创意任务遇到上游参考图拒绝也不再静默降级为纯文本出片。
- 修复隔离 worktree 直接启动时“代码已是 2.5、进程却未载入私密模型配置”的本地混合实例。local/test 可沿 Git worktree `commondir` 只读定位主检出目录的 `.env.local`，production 和无效运行模式明确禁止该回退；密钥不复制到 worktree、不进入 Git、runtime manifest、日志或文档。
- 图文批量生产面对“HTTP 200 但不是严格 JSON”的首次模型结果时，不再把同一复杂提示原样重跑。每个调用只在自身内存中保留首次返回，最多发起一次语法修复请求；修复器只允许处理围栏、引号、转义、逗号和括号，不得新增、删除或猜写任何 shot。修复后仍执行原有字段、数量和正文事实校验；完全不可修复时在 `/api/image/generate` 前明确失败，其他并发任务板和已完成内容不受影响。
- 批量右侧看板持续显示故事板/封面的真实状态和封面缩略图；“预览/调整封面”沿用原微调入口，只有用户明确确认才生成新 revision。release/cache identity 为 `20260811-v1424-creative-reference-1`，不新增 SQLite schema、数据迁移、依赖、持久目录、Nginx 或 systemd 变化。
- 当前生产仍为 v142.3 功能 SHA `ec0a4daf86502f5cbf5a03806c202942661f5d29`。生产已经把中央与 sidecar 用量审计统一为可观察 `writeGateWarnings`，不阻断启动、RW、路由和普通生产；v142.4 继承该生产契约，不恢复用量阻断，也不改写供应商数据或业务媒体。

### 验证边界

- 自动验证覆盖并发两任务板、首次非严格 JSON 后单次定向修复、完全不可修复、有效 shots 前图片提交为零、已完成对象不变，以及参考图视觉摘要进入规划、故事板/原图共同提交和创意任务禁止纯文本降级。自动测试不触发真实图片、视频、语音、发布或供应商回传调用；真实 Seedance 2.5 连通继续沿用 v142.3 已记录的受控 submit/poll/output 证据。
- 本地相关 Python `110/110`、视频 sidecar `160/160`、工作区 Node `129/129` 通过；修改 JavaScript 语法、Python 编译与 `git diff --check` 通过。release verifier Phase 0 `bb6801a10bfa9a23dda93293d8e78d849cdfc65c8e71761b0772d7e0d0227ee4`，ESM `61` modules / `349` edges、closure `da6c96f2c4c8305aac480aa9c2f5bf456b181fdfed3a12d720db27e5b1fdbeaa`，canvas `63` files / `1,768,481` bytes / `6ca04ee8ff6c4fba5bc581c641e542830dc7d7c0d187311b89663bed4f63a018`，runtime `65` files / `3,316,740` bytes / `6e679ba13f612e922e890e2bd669ffe39533fd3e0fe9af1af279683cb7db5701`。

## v142.3 - 2026-08-11（生产：统一视频号、image-2 故事版与 Seedance 2.5 创意视频）

### 生产部署闭环

- 生产流量运行功能 SHA `ec0a4daf86502f5cbf5a03806c202942661f5d29`，release/cache `20260811-v1423-batch-video-editor-1`，实际 sibling release 为 `20260811-v1423-batch-video-editor-1-ec0a4daf`。切换使用持久绿色主服务/sidecar 和精确路由，旧 v141.3 主服务/sidecar 始终 active/RW，构建、验证、回切和再切换期间没有停止服务器或进入只读。停止路由单元即可只撤销两条精确规则并回到仍在线的旧服务，不替换 SQLite 或业务数据。
- 生产启动后曾发现绿色进程的 release 外环境只包含本版新增的搜索/创意视频变量，没有继承原生产 LLM、图片、TTS、数字人等 31 个 provider 配置项。流量先即时回到旧服务，再把原生产外部配置中缺失的键原值合并到新外部 env，权限保持 `0600`；绿色主服务/sidecar 在无流量状态重启并通过 health/readiness 后再恢复路由。密钥值没有进入 Git、release、日志或文档。最终主服务报告 LLM 已配置，图片配置接口正常，真实图片生成连续两次 HTTP 200。
- 目标 Linux 验证：锁定主服务收集 `807`，`806 passed + 1` 个获准旧快照 skip；视频 sidecar `160/160`，Node `129/129`，三套 wheelhouse 的离线安装、exact-installed 与 `pip check` 通过。最终 release verifier Phase 0 为 `862a4553802914ca817541183d54f50ac45c3eb5bc0a8525bb26eadd4b84cabd`，runtime `65` files / `3,313,747` bytes / `b4d5fb1641ec27651fe067fa255a83eaf5afc31d618e7f50d917eb0b1ae71cb5`。
- 切换前一致 SQLite 备份为 `v1423-pre-switch-ec0a4daf-20260811T004158Z.sqlite`，SHA-256 `7a91ef6ed1de47209630d1270ffd0d9e8ebcf0a573e94a90068f0cdba2154782`；独立 restore drill 的摘要一致且 `quick_check=ok`。部署前后均为 48 表，行数随正常生产从 `64,195` 增至 `64,237`，逐表无减少；uploads `6,718→6,720`，composed `1,005`、canvas blobs `638`、视频 projects/uploads/outputs `60/203/1,872` 无减少。
- 生产 readiness 为 `ready=true / writeReady=true / startupVerified=true / blockers=[]`，SQLite `quick_check=ok`，sidecar 为 `readOnly=false / writePolicy=normal`。模型用量未决只保留可观察 warning，永久不再阻断启动、读写或切换；供应商曝光量/观看量及其业务权限没有放宽或改写。历史媒体仍保留 raw 缺失事实，本次新增的一条精确 registry 缺失通过 release 与证据摘要绑定的例外保持可见，不删除引用、不伪造文件、不冒充恢复。
- 公网根页面、health、OpenAPI 与真实浏览器均加载本版 cache；首页、社区真实媒体、历史媒体保留提示和游客鉴权边界正常。百度千帆服务器私密烟测返回 HTTP 200；部署过程中没有重复提交 Seedance 付费任务。用户实测暴露出“前一任务板未结束时新建第二任务板，图卡提示词模型返回非严格 JSON”的代码稳定性问题；现场图片服务随后连续成功，故该问题已交本地代码线程修复，不能误判为图片 provider 故障。

### 本版范围

- 真实生成验证结论：百度千帆搜索已真实返回 HTTP 200、`request_id` 和 3 条 references。火山方舟控制台的 Seedance 2.5 服务已由“未开通”切换为“已开通”；随后使用本地 release 外私密环境向 `doubao-seedance-2-5-260628` 提交最小真实任务，提交 HTTP 200、任务 `cgt-20260811065820-5dj9d`，轮询最终返回 `succeeded` 且包含真实输出。此前 HTTP 404 `ModelNotOpen` 的账号能力阻断已解除；该证据只证明当前授权环境的 2.5 提交/轮询/输出连通，生产仍须由部署线程在目标 release 和服务器私密环境完成故事板全链路验收后切换。API key 只能进入 release 外私密 env，禁止进入 Git、release、日志或交接消息正文。

- 故事版链路修正为“一张多格素描故事板”：语言模型仍输出覆盖 `0–30s` 的 5–10 个逻辑分镜，但 image-2 只执行一次生图，把全部分镜组合到同一张 `16:9` 横版铅笔/灰阶故事板。用户统一参考图参与故事板生成；Seedance 提交时同时携带这张故事板、用户统一参考图和按《视频制作》流程组织的连续视频提示词。故事板比例不决定成片比例，最终视频仍显式使用默认 `ratio=9:16`、`duration=30` 与 `generate_audio=true`。生成看板只展示一张大图并整张微调，不再展示多张彩色分镜卡。

- 发布前真实连通复核：使用本地私密环境直接请求百度千帆 `POST /v2/ai_search/web_search`，返回 HTTP 200、`request_id` 与 3 条 references；火山方舟在服务开通后完成一次最小、受控的真实 Seedance 2.5 提交、轮询和输出闭环。部署契约据此固定 `SEEDANCE_CREATIVE_MODEL=doubao-seedance-2-5-260628` 与 `SEEDANCE_CREATIVE_MAX_DURATION=30`；两把 API key 仍只允许安全转存到 release 外生产 env，禁止进入 Git、release、日志或交接消息正文。该最小任务不代替生产故事板、30 秒 9:16 音画同出和剪辑台的完整验收。

- 视频号账号从“永久绑定真人/素材链路”调整为纯发布身份：批量任务板对同一批视频号同时开放“数字人”和“创意视频”，本次任务选择数字人时沿用角色版、口播与既有数字人生成链路，选择创意视频时进入新的故事版与创意成片链路。历史账号 `subType` 和历史任务不迁移、不删除，只用于旧任务兼容；视频工坊与定制发布的账号选择均开放全部未停用视频号。
- 原“素材视频”对外更名为“创意视频”，原“真人视频”更名为“数字人”。新创意视频先由语言模型返回覆盖 `0–30s` 的结构化分镜、完整口播、统一画风和单条 30 秒视频提示词；用户提供参考图时作为故事板与最终视频共同使用的主体/产品/画风参考，未提供时仍先生成故事板。单张故事板复用无限画布和批量图文同一个 `activeProviderFor("image")`、服务器图片配置、参考图协议和稳定 operation key，不新增第二套图片密钥或模型；失败重试只续跑这一张未完成的故事板。
- 新创意视频不再进入 A/B 面或“前 15 秒/后 15 秒”两段式界面和调度，而是把 16:9 故事板、用户统一参考图、30 秒连续视频提示词与口播一起提交为一条默认 9:16 的音画同出创意视频任务。画风可在批量计划中选择，提示词参考《视频制作》流程，逐时间段明确景别/机位、具体场景与动作、镜头运动、光线、转场、环境声和口播同步，并禁止烧录字幕、花字、水印和二维码。旧 A/B 数据与旧项目继续只读兼容，避免破坏历史任务和已生成媒体。
- 主服务新增显式 `SEEDANCE_CREATIVE_MODEL`（兼容 `SEEDANCE_25_MODEL`）和 `SEEDANCE_CREATIVE_MAX_DURATION` 配置；创意视频请求只接受显式配置的 2.5 模型，未配置时在计费和上游提交前返回可理解的 `503`，绝不静默降级到既有 Seedance 2.0。普通旧视频和数字人请求仍使用原模型路由与账本；配置接口单独回报 `creativeConfigured/creativeModel/creativeMaxDuration`。
- “账号数据”里的“开始新创作”不再打开旧单号制作工作台，而是创建一个只预选当前账号的批量任务计划；图文账号默认图文，视频号默认创意视频，用户仍可在任务板切换数字人。旧单号任务的继续、审核、发布和历史媒体保持原路由，不改数据模型。
- 数字人和创意视频的详情统一收敛为“1 生成 / 2 审核”两个可见节点；生成节点展示真实成片预览和“进入剪辑台”，创意视频额外显示 30 秒规格与单张多格故事板。故事板“微调”可查看、编辑整张提示词和本任务参考图，并只在用户明确确认后重生成该张。剪辑入口把批量成片以 owner-scoped、幂等、只读媒体桥接方式打开到视频工坊既有剪辑台，继续使用画中画、主轨替换、字幕、口播/BGM/音效、转场和外部素材拖入能力；桥接本身不调用 provider、不复制业务数据库，也不改写原始成片。
- 图片上游的连接超时、响应丢失和 `502/503/504` 未知结果不再把创意故事版或整条 production 直接写成终态失败。服务端返回结构化 `IMAGE_PROVIDER_RESULT_UNKNOWN` 与稳定 operation key，浏览器先查询耐久回执；未证实失败时显示“结果确认中”并保留全部已完成故事版，禁止自动盲重提。只有用户在故事版微调中明确重新生成才创建新 revision 操作键。
- release/cache identity 为 `20260811-v1423-batch-video-editor-1`。本版不新增 SQLite schema、数据迁移、持久业务目录、Python/Node 依赖或 Nginx 变化；生产已按上面的绿色服务和精确路由边界部署功能 SHA `ec0a4daf86502f5cbf5a03806c202942661f5d29`，旧 v141.3 服务继续作为在线代码回滚点保留。

### 快速验证边界

- 单张素描故事板收口后，故事板/计费/上游 payload/剪辑桥接主服务定向回归 `60/60`，视频 sidecar `160/160`、Node `129/129` 的上一轮基线均通过；本轮继续定向断言一个 `storyboardSheet`、一个图片 operation key、一个视频 job，故事板请求 `ratio=16:9`，视频上游请求 `ratio=9:16`、`duration=30`、`generate_audio=true`，并同时包含故事板与用户统一参考图。本机系统 Python 3.9 的非锁定 805 项套件受当前 TestClient 版本影响出现统一 `TestClient.adapters` 兼容错误，不作为锁定 Linux 全量结论；目标 Linux 仍需用验签 wheelhouse 执行正式全量。
- 最终 release verifier：Phase 0 `36d33cbc500dcdcbd84379fe114cfbacc2f6dbaed5093ab9ca5379e9cecef5d4`；ESM `61` modules / `349` local edges，graph `6019e999874c254346ff519c0bfa06eb80de1f5c9da4ad2fe92b19bf5bcb17c6`、closure `37d83522323797e2451a0e2cc844ebc2e5b6940b12242b11474b7371bbf57a0e`；canvas `63` files / `1,768,481` bytes / `6ca04ee8ff6c4fba5bc581c641e542830dc7d7c0d187311b89663bed4f63a018`；runtime `65` files / `3,311,104` bytes / `3dc993d95b9b64a3b22f49d253dc37e3ee9e6e3fcf4b3d02eb1ca07c3edef032`。

- 创意视频计费/模型路由、数字人兼容、故事版未知结果恢复、批量剪辑台桥接、画布和前端静态契约的相关主服务 Python 回归 `163/163`，视频 sidecar `160/160`，工作区 Node 全量 `129/129`；相关 JavaScript 语法与 `server/main.py` 编译通过。无模型的创意请求在调用前失败，有显式测试模型时按单条 30 秒任务生成 payload；剪辑台桥接测试只使用临时本地媒体，全部自动测试均没有触发真实图片、视频、语音、发布或供应商回传。
- 自动回归确认新任务使用同一图片 provider 生成故事版、同一视频号可选两条链路、创意任务只创建一个 `30s` job、单号入口跳到批量任务板，且新提示词拒绝 A/B 面结构。`doubao-seedance-2-5-260628` 已完成真实任务闭环；私密密钥仍必须由获授权运行环境注入，本地代码和仓库均不保存用户密钥。
- 当前 runtime manifest 已按“16:9 故事板 + 原参考图共同提交”的最终代码重建，release verifier 通过：Phase 0 `7c03a159ced9f1a1f1e3946873ca3277eb8c9be6e4c677380ca56236defbbcdb`；ESM `61` modules / `349` local edges，closure `89d9636bc29044b98a7d132b12723c23acf53271869f424d349f212e82324011`；canvas `63` files / `1,768,481` bytes / `6ca04ee8ff6c4fba5bc581c641e542830dc7d7c0d187311b89663bed4f63a018`；runtime `65` files / `3,311,104` bytes / `3dc993d95b9b64a3b22f49d253dc37e3ee9e6e3fcf4b3d02eb1ca07c3edef032`。

## v142.1 - 2026-08-10（本地候选：百度搜索 AI 选题、批次控制与可折叠工作区）

### 本版范围

- 批量生产的计划卡新增“AI选题”：用户先选择账号，再以选题方向调用服务器侧百度千帆 AI 搜索正式接口 `POST https://qianfan.baidubce.com/v2/ai_search/web_search`；搜索源固定为 `baidu_search_v2`，支持近一周/近一月，返回来源先进入预览。多账号请求按最多 6 个账号分组生成，模型若漏项只逐账号补齐缺失行，前端在全部所选账号都有合法预览前禁用填入；确认后只填所选账号的空白标题和文案，不覆盖已经人工填写的行，也不允许把单个结果误填成多账号完成。
- 搜索密钥只从服务器私密环境变量 `QIANFAN_SEARCH_API_KEY` 读取，不进入浏览器、源码、runtime manifest 或文档。搜索结果只作为受限事实资料交给既有文案模型，忽略网页中的指令型文本；预览仅渲染合法 HTTP(S) 来源。AI 选题不读取账号定位、人设、语气或历史文风：小红书统一使用与搜索事实匹配的热门标题写法，正文按题目内容在“干货拆解”和“自然真人分享”之间选择，且不得虚构亲测或效果。服务端再次强制小红书标题不超过 20 字、正文连标签不超过 1000 字，视频号标题不超过 16 字且移除标点；前端在填入前复用发布门禁复核。
- 管理后台删除“全部创作端账号”重复列表，账号停用/恢复控制合并进原成员账号行，既保留管理能力也不重复显示。模型用量增加近一周、近一月筛选，汇总、旧事件、新版 receipt 与明细使用同一时间窗口；无调用成员仍保留为零值行，不伪造历史用量。
- 批量生产右侧项目看板增加暂停/继续与删除。暂停先确认，只阻止尚未开始的账号或下一阶段调用，已经在途的单次调用允许安全完成并保存；删除经过两次确认，只移除该批未交付 production/job，已交付内容保留。暂停状态写入既有批次文档，刷新和多成员共享视角继续读取同一状态。
- 全平台左侧上下文栏可收起为 56px 白色图标栏，使用用户提供的原版蓝色星阵图标；显式展开按钮与搜索按钮分离，底部只保留当前用户头像。收起后的入口不再沿用旧版静态顺序，而是复用当前 Logo 下拉栏的同一权限过滤、顺序和路由：团队视角为“首页 → 视频工坊 → 无限画布 → 批量生产 → 整体资产 → 发布清单 → 账号数据”，个人视角按同一来源保留其单号入口。主内容自适应扩展；状态只保存在本机 UI 偏好。视频工坊声音工作台另有独立收起按钮，收起为窄栏后对话区自适应扩展。
- 无限画布不再维护第二套收起按钮或把小地图传送到平台侧栏：全平台只保留统一白色图标 rail，画布小地图和缩放控件固定留在画布左下角；Logo 工作区下拉项使用单行布局，“无限画布”不会被窄菜单挤成两行。
- 修复“采用服务器版本后仍反复出现草稿冲突”的根因。相同逻辑草稿在响应丢失后可以用原 revision 幂等确认，真正不同的本地/服务器编辑仍返回 `409`。同时，普通画布保存的 Blob GC 现在使用独立 savepoint：若扫描到与当前画布无关的历史社区/业务缺失引用，只延后本次 GC 并提交当前有效草稿，不再用全局历史缺失把当前画布写入回滚为 `500`；缺失引用、媒体门禁和审计事实原样保留，新草稿中的缺失/伪造 Blob 仍在写入前拒绝。
- release/cache identity 为 `20260810-v1421-qianfan-workspace-controls-4`。本版不新增 SQLite schema、数据迁移、运行依赖、持久目录或 Nginx/systemd 配置；生产仍为 v141.3 / `1332f8c8e9408c7e9a36f49ab13b48a46ca353f5` / `20260810-v1413-runtime-finalization-1`，本地候选尚未提交、推送或部署。

### 快速验证边界

- 工作区 Node 全量烟测 `129/129`，无限画布草稿/集成回归 `85/85`，服务端用量、前端身份与视频 Web 定向回归 `38/38`；修改 Python 编译、JavaScript 语法与 `git diff --check` 通过。
- 本地恢复数据上的真实画布项目连续刷新三次均没有冲突横幅，实际 `PUT /api/custom-canvas/projects/...` 返回 `200`；展开状态只有统一的“收起左侧栏”，收起后七个入口顺序与 Logo 菜单一致，小地图仍在画布左下角。历史社区缺失媒体仍按原 URL 返回缺失状态，没有被删除、伪造、隔离或放宽。
- release verifier Phase 0 为 `747bb91f74d40d4157d2873b6f23573bf212098f695abc56f1edd569137d77ae`，ESM closure 为 `2eb8608855de70812bc112866323fdc4797f7af4fd2fad516e7ecb3538d5ba44`，canvas closure 为 `63` files / `1,768,481` bytes / `6ca04ee8ff6c4fba5bc581c641e542830dc7d7c0d187311b89663bed4f63a018`，runtime 为 `65` files / `3,297,705` bytes / `8ce496218435ace39570d0af66aa40844cf0986d97af8fbd70b16644c319f6f5`。
- 官方接口形状已按百度示例中心的成功 `200` 调试结果核对；用户已在本地私密环境手动确认 AI 选题可返回预览。自动测试只覆盖本地规范化、全账号完整性和静态契约，不把用户提供的私密 key 写进测试或仓库，也不为验证重复消耗真实搜索/模型配额。

## v142.0 - 2026-08-10（本地候选：批量生成耐断线、幂等续跑与恢复点绑定）

### 本版范围

- 批量图文的浏览器、主服务与队列等待使用同一有界超时契约：主服务管理的 LLM 请求客户端窗口覆盖服务端两次 `120s` 尝试，图片请求窗口覆盖队列等待与单次上游调用。图片提交队列最多等待 `30s`；繁忙时返回 `providerCalled=false` 的可重试响应，明确证明本轮没有调用上游，而不是让浏览器持有长请求直到 `499`。
- 每个批量图片 item 持久化稳定的幂等操作键。浏览器中断、`409` 或结果未知时先查询只读 operation receipt；已成功项目直接复用结果，仍在进行的项目标记为“结果确认中”，只有明确未调用上游的队列繁忙才允许安全重试。`2/3` 图片完成后只续跑缺失项，不删除已完成图片，也不重复扣费或盲目提交 provider。
- 恢复检查点改用 `20s` 专用写入窗口和受控退避，先保留本地已生成结果，再同步服务端；短暂保存失败标记为“保存待确认”，不再把图片生成误写成终态失败。成功进入 review 会清除 production 与 item 的陈旧错误。失败重试会区分“有可执行 prompt 的缺图续跑”和“items 为空/无 prompt 的重新起草”，二次执行保持幂等。
- 信息流素材视频先请求结构化 A/B 分镜，解析兼容常见编号、中文秒数和时间段写法；首次结构不完整只进行一次定向修复，仍缺镜头才失败，且在结构校验通过前绝不进入 Seedance。该修复不伪造缺失镜头，也不放宽真实少镜头负例。
- 本地启动器在未显式传入 `DATA_DB` 时只接受一个完整恢复点，并把 SQLite、uploads、composed、canvas blobs 与视频 projects/uploads/outputs 作为同一不可拆分集合绑定；无完整点沿用默认本地目录，存在多个完整点则明确停止并要求选择，避免“账号还在、会话或媒体却消失”的混合运行状态。生产仍只使用服务器既有持久路径。
- 恢复项目 `05cbfcf2769f` 的历史用量再次按原 reviewed、fresh backup 与完整 runtime snapshot 精确闭合，二跑零写；当前 `_usageReconciliation` 为 `58 reconciled / 0 pending / 0 conflict`。同一会话成功刷新或成功回复后会立即清除旧的“安全收口”提示，仅修显示残留，不改变对话、生成或用量门禁。
- release/cache identity 为 `20260810-v1420-generation-resilience-1`。本版没有新增 SQLite schema、数据迁移、Python/Node 依赖、生产持久目录或 Nginx/systemd 配置；生产仍为 v141.3 / `1332f8c8e9408c7e9a36f49ab13b48a46ca353f5` / `20260810-v1413-runtime-finalization-1`，本地候选尚未部署。

### 验证边界

- 主服务定向回归 `66/66`，视频 sidecar `160/160`，工作区 Node `127/127`，视频 Web 定向 `12/12`，两个继承版本的前端测试断言对齐后 `2/2`；修改 JavaScript/Python 与启动脚本语法、`git diff --check` 均通过。release verifier Phase 0 为 `b5e62688da3fbbd485412b1c1a7a0c85f2dd78758a6e8228ccf2256a20de0de7`，ESM closure 为 `f05cb9e79f61f19be17d3c81548b4f499668e26941eee9f5852f1764303f0f1a`，runtime 为 `65` files / `3,275,572` bytes / `27304afbb0a73eea9b8f84cecf802faa9a9ece476538b7e585cac58fb35403f0`。
- 本地浏览器在原账号和恢复数据上读取批量生产与视频工坊；旧项目原 URL、历史消息、附件、成片和输入框均保留，项目级 pending/conflict 为 `0`，页面不再显示“安全收口”。本轮自动验收只读取状态，没有提交新的图片、视频、语音、发布或供应商回传调用。
- macOS 公网环境无法取得锁文件中的目标 wheel `click==8.4.1`，因此不把本机运行结果冒充正式 Linux / CPython 3.12 locked 全量。该套目标全量仍须在用户批准后由部署线程使用验签 wheelhouse 执行；本地候选不因验证边界而放宽任何运行门禁。

## v141.9 - 2026-08-10（本地候选：视频原会话续开、意图相关公开进度与稳定恢复）

### 本版范围

- 视频工坊收到结构化 `video_workshop_usage_pending` 时不再自动新建会话或把用户带到另一个历史窗口。当前项目 ID、历史消息和用量证据原样保留，本轮文本与附件恢复到原输入区并提示稍后重试；不重写旧 receipt、不猜测结算、不在被拦项目发起 provider 调用。历史用量只能由既有后台幂等收口路径处理，不能用前端换会话掩盖。
- 本地恢复项目 `05cbfcf2769f` 的 `3` 条 sidecar submitted receipt 已通过 reviewed v2 的单项目精确计划收口为 `indeterminate/calls=0`：计划只接受同一项目、同一种 `sidecar-submitted-indeterminate` 证据，先绑定 fresh SQLite v2 backup 与完整 runtime snapshot/restore-drill，再 apply；二跑零写，项目 `effectivePendingRows 3→0`、冲突为 `0`。其他项目和中央账本仍有 `20` 条真实网络失败证据，未被本次计划触碰；该操作只写本地恢复库，不连接或修改生产。
- 两个本地启动器会优先读取当前工作树的 `.env.local`，不存在时通过 Git common dir 精确定位主检出目录的私密环境文件，并以不执行文件内容的逐行解析方式注入。主服务开放页面前必须同时确认 `LLM_API_KEY`、`SEEDANCE_API_KEY`、`MINIMAX_API_KEY` 非空，缺任一项就停止启动并明确报错；不再出现“页面能打开、导演请求才发现 API Key 未配置”的半联通状态，也不复制或提交私密值。
- “思考中”及展开的公开事件改为无外框、无底板的紧凑文本流；工作头像、状态点和省略号取消循环动画，事件更新复用原 DOM 节点，不再每隔一段时间整块重建造成闪烁。请求刚发出时只展示当前 token 的一条当前判断；服务端切到 `running` 后只读取本轮 `runStartedAt` 之后的事件，过滤旧通用占位并去重，最多展示三个真实且不同的当前步骤，当前事件尚未落盘时回退到当前指令摘要，不再把上一轮“合成/质检”显示成新任务进度。普通问候只显示本轮问候，独立咨询/新任务只围绕当前文本；“继续上一条、按刚才的改、把字幕缩短”等明确承接或修改指令才引用同一会话最近的有效任务摘要。该识别与筛选仅生成用户可见进度文案，不修改 `/api/chat` 请求、导演上下文、项目状态、媒体 provider、用量或成片流程，也不展示或伪造隐藏推理。
- 视频工坊左侧运行中会话的三点菜单继续使用绝对定位浮层。运行柔光只提升会话主按钮与三点按钮，不再用通配选择器把菜单改成普通布局项；打开菜单时会话行保持约 `35px` 高，不覆盖或挤动后续历史会话。该修复不改变会话排序、分组、重命名、收藏与删除逻辑。
- 首次打开已有视频会话时，对话区在消息、图片、视频和交付卡完成延迟布局的短窗口内持续锁定真实底部；初始化不使用平滑滚动，避免先卡到“快到底部”再跳动。初始化结束后仍沿用既有规则：轮询只在用户原本接近底部时跟随，用户阅读历史时保持其位置。
- 用户显式发送后为当前项目建立有界底部锁，覆盖用户消息、公开进度和最终导演回复三次高度变化；锁的项目与截止时间不会被中途普通重绘清空，最终回复变高后仍贴住 `.conversation-column` 底部。消息行不再重播入场动画，避免每次替换 DOM 时视觉闪烁；真实 `hi` 验收在 pending 与最终回复后多次采样的距底部均约为 `0px`，原项目 URL 保持不变。
- 供应商“图片暂不可用”的本地故障确认不是交付引用或权限回归，而是恢复数据库仍引用 `server/local-restore-20260810-v1413-origin-1/uploads`，启动参数却错误指向空的 `server/uploads`。本地服务已重新绑定与恢复库配套的 uploads/composed/canvas/video 目录；原资产引用、交付记录和图片文件均未删除或伪造，生产持久媒体路径不作任何修改。
- release/cache identity 为 `20260810-v1419-video-continuation-media-15`。本版没有新增 SQLite schema、数据库迁移、依赖、持久目录或 Nginx/systemd 配置；生产仍为 v141.3 / `1332f8c8e9408c7e9a36f49ab13b48a46ca353f5` / `20260810-v1413-runtime-finalization-1`，本地候选尚未提交、推送或部署。

### 快速验证边界

- 视频工坊 Web、用量协调和主平台集成定向测试通过；JavaScript/Python 语法、前端资源身份、runtime manifest 与 `git diff --check` 通过。
- 浏览器验证旧项目打开后对话区距底部由 `571px` 收敛到约 `0px`，交付卡与输入框直接可见且没有平滑跳动；在真实历史项目 `d2bbf44b8928` 发送“你好”时，pending 只有 `1` 个当前事件节点且展开区没有重复标题，最终回复后项目 URL 不变、输出仍为 `0`。同项目启动新“规则怪谈”生产后，运行态只显示本轮参考设定、图片分镜等三个不同步骤，不再显示旧成片合成/质检；左侧打开三点菜单时行高保持 `35px`、菜单为绝对定位。承接/修改分类另由无 provider 的 Web 单测验证会引用最近有效任务，而独立新任务不会继承；供应商真实交付的两张 JPEG 均为 `200`，浏览器解码尺寸 `1152×1536`，不再显示“图片暂不可用”。
- 浏览器为验证原会话续开和“你好”的意图相关进度触发了本地已配置的 MiniMax-M3 文本导演调用；没有触发图片、视频、语音、重渲染、发布或供应商回传。除上述受保护的本地项目级 receipt 收口外，没有改写其他历史用量凭据；未连接生产，未提交、推送或部署。

## v141.8 - 2026-08-10（本地候选：账号数据首屏重排、回链直达与视频进度续时）

### 本版范围

- “账号数据”首屏改为上下两层：上层并排显示总播放量的平台环图、发布量的平台环图和发布沟通预览，下层使用整行发布趋势，移除顶栏“同步数据”按钮和旧账号轮播占位，避免中部出现无意义空白。两张环图的扇区和中心总数都继续打开原只读明细，不触发同步或写业务数据。
- 内容数据弹窗仍合并逐条曝光、播放、赞藏评分享、创作人和账号，但列表默认按账号折叠；用户展开后才看到单条内容。有真实供应商回传 URL 的内容行显示“跳转链接”并以新窗口打开，没有 URL 时只显示空值，不构造或猜测链接。进入任一账号工作台后，左栏顶部保留“数据看板”，可随时返回账号数据总览。
- 视频工坊保留星阵 Logo 但移除头像外框；“思考中 / 当前阶段 / 已用时 / 进度”压缩为同一条无边框状态行，展开区只显示已有公开制作事件和确认进度，不输出隐藏推理。服务端在项目进入 `running` 时写入同一项目 JSON 的 `runStartedAt`，轮询、离开页面和重新进入都沿用该时间；旧项目缺字段时只用当前成员与项目隔离的本地首见时间兜底，终态后清除兜底时钟。
- release/cache identity 为 `20260810-v1418-dashboard-thinking-2`。本版没有新增 SQLite schema、数据库迁移、持久目录、依赖或 Nginx/systemd 配置；生产仍为 v141.3 / `1332f8c8e9408c7e9a36f49ab13b48a46ca353f5` / `20260810-v1413-runtime-finalization-1`，本地候选尚未提交、推送或部署。

### 快速验证边界

- 视频工坊定向测试 `15/15`、工作区 Node 烟测 `67/67`、账号数据与前端身份服务端测试 `12/12` 通过；三个修改 JavaScript 文件语法检查、`store.py` 编译、runtime manifest 重建和 `git diff --check` 通过。
- 恢复后的本地服务以 `20260810-v1418-dashboard-thinking-2` 运行，主服务 `/api/health` 正常；sidecar live/RW 与本地媒体工具正常，因本机未注入导演、视频和语音 provider key 而按预期显示 `ready=false`，没有伪造运行任务或触发付费调用。
- 本地浏览器在 `1440×900` 验证首屏三卡、下置折线图、移除同步按钮、内容明细 `6/6` 账号默认折叠、唯一真实回链的“跳转链接”完整可见，以及从账号工作台点击“数据看板”返回总览。没有触发真实同步、生成、发布、供应商回传或生产写入。

## v141.7 - 2026-08-10（本地候选：账号数据整合、供应商筛选续存与剪辑台单字幕流畅预览）

### 本版范围

- 剪辑台预览只保留一条可编辑字幕：当前成片已经烧录旧字幕时，监看器先用局部遮罩覆盖旧字幕带，再在同一位置显示当前片段唯一的可编辑字幕；提交重渲染仍只把该条结构化字幕交给既有 ASS 合成一次，不生成第二条字幕轨。播放时以 `requestAnimationFrame` 按真实 `currentTime` 同步红色播放头、进度条和时间码，`timeupdate` 只作兼容回退，暂停、结束和关闭工作台都会停止动画时钟。
- 供应商端已选的平台、产品、形式、发布人、账号、下载/发布状态和日期范围按“当前角色 + 当前成员”隔离保存在既有 UI 元数据中，刷新后自动恢复，不把 A 供应商的筛选带给 B 供应商；搜索词仍保持临时输入。交付列表的创作时间改为 `YYYY-MM-DD HH:mm`，同一天的内容可精确到小时和分钟区分。
- 原“单号创作”和“数据看板”合并为“账号数据”：团队首页入口与左侧工作区统一使用新名称，左栏顶部固定“数据看板”，下方列出全部账号；点击账号继续进入原单号创作，不改变生产、权限和发布链路。右侧看板移除账号轮播，把发布分布饼图与发布趋势放到合并指标下方；“观看与互动数据”弹窗逐条并排展示曝光、播放、点赞、收藏、评论、分享、发布账号和创作人，并支持平台、更新时间、账号、创作人、自定义日期及最低/最高播放量筛选。
- 百舸产品库依据 `百度百舸产品信息与数据汇总-2.md` 更新为完整基础设施口径，补充 RealOmni、LoongForge、异构训练/推理、世界模型、强化学习、VLA/dVLA 与典型效率数据，并扩大禁止幻觉清单。持久化目录中的旧百舸 seed 在目录版本升级后由本版受管 seed 覆盖，避免旧“待确认”信息压住新权威描述；“百舸 / 百舸 6.0 / 百度百舸”仍命中同一产品。
- release/cache identity 为 `20260810-v1417-account-data-editor-subtitles-2`。本版没有新增 schema、数据库迁移、持久目录、依赖或 Nginx/systemd 配置；生产仍为 v141.3 / `1332f8c8e9408c7e9a36f49ab13b48a46ca353f5` / `20260810-v1413-runtime-finalization-1`，本地候选尚未提交、推送或部署。

### 快速验证边界

- 视频工坊字幕/运行时定向测试 `10/10`、工作区 Node 烟测 `58/58`、账号数据/供应商/前端身份相关服务端测试 `34/34` 通过，相关 JavaScript 语法检查、runtime manifest 重建和 `git diff --check` 通过。
- 本地浏览器在 `1440×900` 验证“账号数据”左栏、全部账号、合并指标、下置图表和内容数据弹窗；最低播放量 `1000` 的显式筛选把当前样例从 `6` 个账号收敛为 `2` 个，并保留逐条创作人和互动列。未触发真实同步、生成、发布、供应商回传或生产写入；供应商登录态和剪辑台真实重渲染留给用户手动验收。

## v141.6 - 2026-08-10（本地候选：剪辑台拖放分流、独立音轨与内置音效）

### 本版范围

- 修复外部素材拖进已打开的剪辑台后仍被视频工坊对话附件区接收的问题。根因是剪辑台弹窗没有在自身边界截断文件拖放事件，事件继续冒泡到页面级附件处理器。现在剪辑台先接管并停止传播：只有明确落在某个 V1 主轨片段时才替换该片段；图片/视频落在 V2 或剪辑台其他区域时默认成为按当前播放头插入的画中画；音频落在空白区域时默认进入 A3 音效轨，落在 A2 时替换 BGM。项目素材内部拖放仍遵守同一落点规则，不再误入聊天输入框。
- 字幕块改为可访问的真实按钮，点击对应字幕后才在右侧显示并编辑该条内容。右侧不再重复展示可由时间线拖柄完成的片段时长、入点和替换参数，只保留当前对象上下文、字幕编辑、BGM 管理和音效操作；关闭按钮与选中态继续降低框架感和高亮强度。
- 音频拆成 `A1 口播 / A2 配乐 / A3 音效` 三条轨道。口播与 BGM 可分别选中并调节各自音量；BGM 可保留、替换或移除；音效可从项目音频或外部音频添加、移动、调节时长/音量和删除。提交仍写入既有结构化 `timeline_edit/audio_design`，继续复用现有 FFmpeg 合成与版本化输出，不覆盖旧成片，也不重新调用图片、视频或语音 provider。
- 内置 5 个 Kenney CC0 基础音效并保留官方来源与许可说明，文件随 runtime 静态验签，不依赖运行时联网或第三方 CDN。后端只接受内置白名单 ID 或当前 owner 项目已登记音频，未知路径和跨项目素材继续 fail closed。
- release/cache identity 为 `20260810-v1416-editor-drop-audio-1`。本版没有新增 schema、数据库迁移、持久目录、Nginx/systemd 配置或 npm/Python 依赖；生产仍为 v141.3 / `1332f8c8e9408c7e9a36f49ab13b48a46ca353f5` / `20260810-v1413-runtime-finalization-1`，本地候选尚未提交、推送或部署。

### 快速验证边界

- 剪辑台 Web 运行时、revision/pipeline 合约共 `44/44` 项定向测试通过，工作区 Node 烟测 `38/38`、前端模块身份 `10/10` 通过；`app.js` 语法检查、相关 Python 编译与 `git diff --check` 通过。另以两段本地测试视频、口播、BGM 和内置音效完成不调用 provider 的 FFmpeg 合成烟测，输出同时包含视频与音频流。
- 恢复后的真实本地会话成功打开 18 片段、13 项素材的校园规则怪谈成片。浏览器验证字幕块、A1 口播和 A2 BGM 均可独立选中，A3 与 5 个内置音效可见，剪辑台在 `1280×720` 下没有水平溢出；没有点击提交重渲染、发布或任何付费生成。

## v141.5 - 2026-08-10（本地候选：视频生产隔离与多轨剪辑台）

### 本版范围

- 修复同一视频工坊会话连续制作多条视频时的跨任务串片。校园规则怪谈任务本身没有携带 ChinaJoy 参考图；真正原因是中间镜头长期使用项目级 `scene-01...scene-N` 文件名，服务重启后的恢复器会把上一条生产已存在的同名镜头误判为当前任务已完成。现在每个被接受的新生产计划都有稳定 `reference_scope_id`，镜头文件、分段文件、重试缺失检查和重启恢复全部绑定该生产 scope；上一条生产的文件不能再满足下一条任务。旧计划继续沿用原无 scope 文件名以兼容中断恢复，原有历史输出和媒体不删除、不覆盖。
- 视频工坊成片剪辑台升级为真实多轨工作区：左侧读取当前项目真实素材，中间预览当前成片，右侧按选中对象编辑属性，底部按视觉层级提供 V2 画中画、V1 主画面、T 字幕、A1 口播和 A2 配乐。加入画中画后，真实图片或视频素材会立即叠加到监看器；图片和视频画中画都可直接在画布内拖动、由右下角缩放，并保留淡入/滑入等入场与淡出/滑出等出场效果。当前镜头字幕同时显示在最上层，选中单条字幕块即可修改准确文案，不再被主画面、画中画或浏览器原生进度条遮住；原生 controls 已替换为监看器下方独立播放键、进度条和时间码。
- 主轨支持拖动排序、两侧拖柄裁剪、入点/时长、播放头分割、删除、撤销/重做和逐片段基础转场。项目素材可拖到具体 V1 片段做真实替换并立即在监看器显示，不再只是改变下拉框；外部 PNG/JPG/WebP、MP4/MOV/WebM 可直接拖到具体 V1 或 V2，上传只进入当前项目素材库，不启动导演或 provider。外部 MP3/WAV/M4A 可拖到独立 A2 轨替换 BGM，口播与配乐不再混为一个音频轨。各素材轨高度同步收细，剪辑台外框、三栏分隔、素材卡和时间线边界继续以明暗层级替代层层描边。
- 剪辑数据以结构化 `timeline_edit` 写入已有视频项目：逐片段字幕、素材替换、转场、画中画 `position_x/position_y/scale`、入出场效果与 `bgm_selection` 都是显式字段。每个交付版本保存独立 composition 快照，历史成片仍可按当时镜头源编辑；提交后保留旧成片，只复用已生成素材重新剪辑、合成和质检，不再调用图片、视频或口播 provider。主平台代理新增 owner-scoped 的 `video-editor`、`assets` 与 `timeline-revision` 路由，未认证或非 owner 项目仍 fail closed。没有新增 schema、数据库、持久目录、Nginx/systemd 配置或 npm/Python 依赖。
- GitHub 方案评估以 [OpenReel](https://github.com/Augani/openreel-video)、[OpenCut](https://github.com/OpenCut-app/OpenCut)、[OpenCut Classic](https://github.com/OpenCut-app/opencut-classic) 与 [react-timeline-editor](https://github.com/xzdarcy/react-timeline-editor) 为参考。OpenReel/OpenCut Classic 的完整编辑器依赖各自 React/Next/WebCodecs/WASM 运行栈，直接嵌入会引入第二套前端和渲染生命周期；本版只借鉴多轨、素材池、检查器和非破坏性编辑模型，在现有 vanilla JS sidecar 内隔离实现，没有复制第三方源码或引入许可证冲突。
- 当前 release/cache identity 为 `20260810-v1415-production-scope-timeline-5`。生产仍为 v141.3 / `1332f8c8e9408c7e9a36f49ab13b48a46ca353f5` / `20260810-v1413-runtime-finalization-1`；本地候选尚未提交、推送或部署。

### 快速验证边界

- Python 编译与视频工坊 JavaScript 语法检查通过；本轮剪辑台、外部素材导入、视频画中画、pipeline、字幕和主平台集成定向测试 `59/59`，工作区 Node 快速烟测 `58/58`，前端缓存身份与 release contract `25/25` 通过。另以两段本地纯色测试视频、真实画中画图片和本地音频完成 FFmpeg 烟测，`slideleft` 主轨转场及画中画 `slide-left / slide-up` 入出场成功合成为 `2.067s` 成片；没有调用 provider。
- 恢复后的真实本地会话中，历史校园成片剪辑台成功加载 18 个镜头与 13 项项目素材；浏览器在 `1280×720` 验证六行细轨、监看器下方独立进度条、字幕块选择、A1/A2 分轨、BGM 选择与撤销恢复，且先前已验证画中画在画布内拖动和缩放、素材替换即时预览。未点击“提交修改并重渲染”，原有串片成片作为历史事实保留，没有在本轮自动重做或覆盖。
- 本轮没有触发真实图片、视频、语音付费生成，没有发布、写生产数据、通知部署线程或执行生产切换。

## v141.4 - 2026-08-10（本地候选：团队入口、耐久会话删除与视频声音剪辑工作台）

### 本版范围

- 团队成员的“单号创作”不再占用 Logo 工具切换器位置，改由团队首页右上角积分旁的“全部账号”进入；个人工作区仍保留原单号入口。原独立“语音生成”入口合并到视频工坊右栏，旧 `#/voice` 与 `#/custom/voice` 路由兼容跳转到视频工坊。
- 视频工坊右栏改为紧凑的“声音工作台”，在同一右栏切换口播声线、语音生成和音色设计。每次发起视频制作默认从当前租户对该成员可见的定制音色中随机选择，也可按成员在本机固定一条声线；服务端对没有显式 `voiceId` 的旧客户端同样执行 owner/scope 过滤后的随机兜底，不会跨租户取音色。
- 固定声线不再使用浏览器原生 `select`，改为与平台一致的自定义选择器。可选集合同时包含当前 scope 内的我的/团队设计音色与真实 MiniMax 系统音色，主平台把当前成员的收藏 ID 通过同源 workspace 协议传入，下拉顺序固定为“收藏→我的设计→团队设计→MiniMax 系统音色”。随机口播仍只从定制音色中选，不会因扩充固定列表而随机到系统音色。
- 语音生成拥有独立声线选择器，不再要求先切回口播声线页；口播和语音生成两个选择器都可从同一真实集合中搜索、选择并逐项试听。试听按需复用既有 TTS 接口，不在打开列表时批量生成音频。音色设计复用既有 `/api/tts/voice/design`，候选试听通过后按当前成员/团队 scope 写入 `voicePresets`，保存成功即进入“我的设计”并自动选为本次语音生成声线；没有新增第二套音色数据或跨租户共享。
- 导演记录不再常驻占用右栏。运行中的“思考中”卡片可点击展开，桌面端也可悬停查看最近进度与事件；既有服务端事件和项目进度仍是唯一数据来源。
- “思考中”改为无边框状态行，展开后才显示事件。同时移除导演追问结果的 `240` 字符硬截断：普通回复完整保留，只有超长异常输出才会在完整段落或句号处收口，不再出现“⏱️ 时”这类 Markdown 半句入库。
- 每个已渲染成片增加弹窗式剪辑台：预览当前成片和完整导演轨道，支持调整片段顺序、时长、替换项目素材、增加画中画与选择字幕动效。提交时保留旧成片，把结构化修改交给视频工坊已有导演、剪辑、合成和质检链路生成新版；本版没有引入第二套渲染器，也不直接覆盖历史输出。
- 删除本人批量生产会话时，服务端在同一事务内依据不可变 resource scope 核对真实创建者，并把同 owner 批次的 `sessionId` 解除为 `archivedSessionId/sessionDeletedAt`。批次、production、job 和媒体全部保留，但刷新、重登或旧客户端恢复器不会再把已删会话重建；同团队其他成员仍无权删除。语音生成按钮移除旧动画容器类，独立深色圆角按钮不再露出蓝色底板。
- 本版没有 schema、依赖、持久路径、媒体归属或系统配置变化；release/cache identity 为 `20260810-v1414-voice-workbench-6`。生产仍为 v141.3 / `1332f8c8e9408c7e9a36f49ab13b48a46ca353f5` / `20260810-v1413-runtime-finalization-1`，本地候选尚未提交、推送或部署。

### 快速验证边界

- 改动 JavaScript 已通过语法检查，`server/main.py` 与视频工坊 `providers.py` 通过 Python 编译；导演完整追问、视频工坊主平台集成与 Web 运行时共 `71/71` 项 Python 定向测试，工作区/团队入口共 `58/58` 项 Node 烟测通过，`git diff --check` 通过。本地真实浏览器在恢复后的历史会话中验证三栏切换、语音生成独立选声、菜单内真实 MiniMax 音色与逐项试听按钮、音色设计完整表单，右栏没有水平溢出。release verifier 同步通过：Phase 0 `f2969ec6a806b2b0f4275465fe267846ab1d3c429a29c88b22d3860b7c44d4ce`，ESM `61` modules / `346` edges / closure `117c9521039948ab6fa9ea5314528de983327e31d607f9becb094c8876ed86eb`，runtime `58` files / `3,088,660` bytes / `917f8cf1bae03b808489ee4243b9c88819def18cc4c7df46f365fc781503c7c8`。
- 本轮没有触发真实图片、视频、语音付费生成，没有发布内容、写生产数据、通知部署线程或执行生产切换。剪辑台已验证代码路径和既有重渲染接口契约，真实成片效果仍需本地用户以已有项目手动验收。

## v141.3 - 2026-08-10（生产已发布：隔离后增量媒体结算与视频工坊关页终态收口）

### 生产部署结果

- 生产功能 SHA 为 `1332f8c8e9408c7e9a36f49ab13b48a46ca353f5`，分支 `codex/v141-content-governance`，release/cache identity 为 `20260810-v1413-runtime-finalization-1`，active sibling release 为 `20260810-v1413-runtime-finalization-1-1332f8c`。旧 v140.6 在构建、验签和受保护结算期间始终 active/RW；先恢复并确认其公网 200 和完整写能力，再以约 9 秒的滚动窗口切到 v141.3。主服务与 sidecar 当前均 active/RW、`NRestarts=0`，进程工作目录和公开 release 环境精确指向新 release，生产 SQLite、账号、媒体、认证、私密配置与 Nginx 没有被本地状态覆盖。
- 原候选按 `effectivePendingRows=25` 生成状态，但 apply 错把 raw 73 条候选全部纳入计划而安全失败。最终前向修复以不可变 `140010` 隔离时间为边界，只接受同一历史基线下、精确 `video-output / video-workshop-project` 拓扑，并证明基线前 48 条与基线后 25 条完整分区；任何数量、类型、mtime 或历史文件漂移仍整批 fail closed。生产首次 apply 只登记 25 条，raw `73→48`、effective `25→0`、drift `1→0`，fresh binding 二跑 `applied=false / insertedRows=0`。
- usage v2 对切换前精确 2 条中央未决记录写入 2 条终态并二跑零写；随后 `video-usage-recover` 仅导入 13 条 sidecar 已持久化成功、中央精确缺失的终态，二跑仍零写。结算结束时 unresolved/outbox/spool/effective sidecar 均为 0，SQLite `quick_check=ok`，全程没有 provider submit、retry 或猜补费用。切换后的正常用户请求可短暂产生新的 pending receipt；它只由业务请求自然闭合，`/api/ready` 继续纯观察，不能把一次 GET 用来停服或切只读。
- 部署前后均为 48 张表，总行数 `58,509→58,595`，没有任何表减少；媒体 inventory digest 始终为 `d0c6af65bf266bc5f314bf0f354912b50361e3b10ae84aca635c9a67f0f0659f`，uploads/composed/canvas/video projects/uploads/outputs 分别保持 `6,240 / 993 / 634 / 58 / 176 / 1,777`，无文件减少。供应商活动 2,354 行、账号绑定 52 行、团队供应商 4 行及其摘要部署前后完全一致，80 个账号文档不变；曝光量、观看量和回传数据未被迁移或重写。

### 本版范围

- v141.2 已在目标 Linux 完成构建和测试，但生产切换前的实时门禁发现新增视频工坊成片尚未登记到私有媒体 registry，raw `pendingRows=73` 中只有既有隔离基线 `48` 条可保留，新增 `effectivePendingRows=25` 且 `mediaIsolationAuditDrift=1`。v141.3 将 `media-settle` 改为只处理 effective 增量：仅登记物理文件存在、owner/project 证据唯一、未隔离且不属于公共头像例外的行；事务提交前必须同时证明 effective/drift 归零并且 raw 精确回到不可变隔离基线。既有隔离引用、原文档和物理文件均不删除、不伪造、不改写。
- 视频工坊原先只在用户再次打开项目时由主服务水合 sidecar 终态；用户关页后 sidecar 虽可完成任务，主服务却不会及时登记成片和闭合中央用量。现在主服务为已认证成员实际访问到的 active 项目启动 owner-scoped、进程内去重的 checkpoint finalizer，只观察本地耐久项目文件的摘要变化并复用既有 `_sync_video_workshop_project`。它不提交、轮询或重试 provider，项目进入 terminal 后自动退出，主服务 shutdown 时统一清理。
- 本版吸收 v141.2 的发布配额、百舸路由、无限画布有序多图与精修、v141.1 数据看板和 v141.0 内容治理功能；不新增 schema、依赖、持久路径或 Nginx 配置。systemd 只增加可回滚的新 release 指针，数据与私密环境继续使用原服务器持久路径。

### 验证与发布边界

- 目标 Ubuntu / CPython 3.12 三套 wheelhouse 已从最终 SHA 重建，并通过 manifest 验签、离线 `--no-deps` install-check、exact-installed 与 `pip check`。主 runtime/test/sidecar wheelhouse manifest 分别为 `9093dfce52d392123b803534c21998c3e259a243578921ef796d6c464be62fc7`、`d748941d9b0cf6dd78fd24d432df24784e7e1ff6601bce467b5ead58b4957de7`、`d41503a784a27373bc6069ae7ecd6d9d34183dc58101e5d2a0fe2dc05808d1e2`；主服务全量 `781 passed + 1 approved skip`，视频 sidecar `142/142`、Node `127/127`。
- 最终 release verifier 通过：Phase 0 `5160b64d7ad75ebbf69fa54dce8146d840b82ee07d061087e32d5ceeb800f2e2`；ESM `62` modules / `354` edges，graph `500f6ec6a4a4261d48a7fcd55a5ef3f30635e6d0bb658d638369a30d7d5c3d14`、closure `a6a641e6aa01a2c4a1f3bbdaf6e1c8a950fc6a554992518da38734ca739a25f1`；canvas `63` files / `1,768,916` bytes / `efd2eff99df225ebbfabe37fa90571f21e430c5ced91cec34168d53daf578dd5`；runtime `58` files / `3,025,471` bytes / `730bf796628acf05cf50e8bbad4e505333d97d5e3f2e5a38702438d48cf00616`。
- 切换门禁曾精确达到 `ready=true / writeReady=true / startupVerified=true`；公网 root、health、OpenAPI、community、无限画布和视频工坊静态入口均为 200，未认证受保护 API 为 401。真实浏览器加载 v141.3 cache identity，首页和社区媒体正常渲染，历史隔离项显示保留记录，来宾进入无限画布触发登录边界；未发起重复或付费生成，因此三条生成链路以目标 Linux/Node 全量回归、静态闭包和现有生产配置健康为本轮部署证据，不冒充新的付费成片验收。

## v141.2 - 2026-08-10（本地候选：发布配额、百舸智能路由与无限画布有序多图发布）

### 本版范围

- 每个内容账号的中国日历日上限改为只统计“成功发布到供应商清单”的内容，不再把草稿创建或生成过程计入配额；同一团队的所有成员共享每账号每日 `2` 条额度。普通单号/批量发布与视频工坊/无限画布定制发布都在服务端 `BEGIN IMMEDIATE` 内做最终裁决，发布成功后立即刷新权威用量；旧页面兼容接口也返回同一发布口径，不能凭未刷新视角绕过。
- 百舸产品库把“百舸”“百舸 6.0”等别名与“百度百舸 6.0”绑定。批量图文、单号、素材号、静态/动态口播、图片提示词和定制视频会从标题、正文、主题及口播中识别该产品，优先使用产品库已确认事实并保留禁止外推边界；不再要求用户必须写完整“百度百舸”才能命中。
- 无限画布支持按点选顺序发布 `1–20` 张图片：Mac 使用 Command，Windows 使用 Ctrl/Shift，也可拖框多选；桥接协议保留选择数组顺序，主平台逐张调用既有 `polishImageForPublish`，再按同一顺序写入发布图集。批量图文和单号原有精修链路保持不变，没有增加第二套精修或重复精修。
- 多选本身不再改变 z-order 或保存草稿，只有真实拖动超过 `3px` 后才置顶并持久化；瞬态同步失败按 `1s/3s/8s` 有界重试并提供手动重试，真正 revision 冲突仍保留本地恢复包和服务器版本。历史业务媒体缺失会返回明确的存储异常，不再误报为“草稿数据格式无效”。
- 本版不新增 schema、数据迁移、持久路径、依赖或 systemd/Nginx 配置；release/cache identity 为 `20260810-v1412-publish-quota-baige-canvas-1`，功能提交为 `9833a0e94d49b7fc0e70e3c955dff7449fc30721`。v141.1 被本版吸收并取代，生产仍为 v140.6，当前待部署。

### 验证与本地数据边界

- 服务端相关 `217/217`、Node `127/127`、视频 sidecar `142/142` 通过；无限画布 TypeScript、ESLint、vendor closure、Python compileall 与 `git diff --check` 通过。release verifier 最终为 Phase 0 `57ea4b62c2479af08a6813735374cd27bb1c56a64e230935ae5d8739b28085a6`；ESM `62` modules / `354` edges，graph `8317808b62e4701865add94a8b2b8a217cbd5713fb0e4f0002bcea702aa774d1`、closure `8eebbc7a11934ee2abf1fb30ae2efd20d28779f948b5ba520bde69f70e42d5c9`；canvas `63` files / `1,768,916` bytes / `efd2eff99df225ebbfabe37fa90571f21e430c5ced91cec34168d53daf578dd5`；runtime `58` files / `3,015,341` bytes / `f4e261e612abd464a95179615197bc791f089891d4d029dabfbcbe22469e52a7`。
- 真实浏览器只使用独立验收画布：两张图片以 `acceptance-one → acceptance-two` 顺序形成发布请求，按钮显示“导出 2 张 / 发布 2 张”，两次只切换选择后服务端 revision 保持 `3`，未产生同步写；请求中两个 `sourceItemId`、PNG data URL 和顺序均完整。验收画布随后精确删除，未触发真实发布或付费生成。
- 本机反复同步提示的直接阻断来自临时本地库中一条与当前画布无关、且原图已不存在的旧社区记录。用户明确授权本地坏数据可删除后，先生成 `acg-sqlite-backup-v2` 一致性备份，再仅将该记录软删除；当前画布未删除、GC 预检无待删图片，清理前后 `quick_check=ok`。这是本地数据处置，不进入 Git、不随发布同步，也不授权删除或改写生产历史媒体。
- 本机 v141.2 主服务和 sidecar 已用同一 release identity 重启，`ready=true / writeReady=true / startupVerified=true / sidecarOk=true`，SQLite `quick_check=ok`。这些是本地候选证据，不等于生产已发布。

## v141.1 - 2026-08-10（本地候选：数据看板逐条曝光、播放与互动明细）

### 本版范围

- 首页数据看板「总播放量」详情改为更大的宽屏弹窗，平台、更新时间和自定义日期筛选在桌面宽度保持一行；账号分组同时显示曝光与播放合计，每条内容直接并排展示权威 `exposureCount` 和 `viewCount`，仅有曝光而播放为 `0` 的内容也不会被遗漏。
- 「互动构成」详情使用同一宽屏信息密度：左侧固定显示内容标题、发布账号、平台和快照时间，右侧按列展示播放、点赞、收藏、评论与分享；无快照项明确显示 `—`，不再把多项指标压缩成难读的一串小字。
- 本版不新增 schema、数据迁移、持久路径、依赖或系统配置；只读取已有供应商权威回填字段和分析快照。release/cache identity 为 `20260810-v141-dashboard-metrics-1`，功能提交为 `ba01d35b34cbafd1021900549ad931be6c2c51c6`，当前待推送、待部署；生产仍为 v140.6。

### 验证边界

- 本地 CPython 3.12.13、验签 20 包离线测试 wheelhouse 与无私密 `env -i` 主服务全量收集 `776` 项：`775` 通过，唯一跳过为既有批准的 v120 只读快照项；视频 sidecar `142/142`、Node `126/126`、全部 JavaScript 语法检查与 Python compileall 通过，未触发 provider 或付费生成。
- 真实浏览器在 `1536×1024`、`1180×800`、`900×800` 检查两组弹窗：桌面筛选单行、逐条曝光/播放双列、互动固定列、内部滚动和窄屏换行均无裁切或横向溢出；筛选“小红书”后账号数及双指标汇总同步更新，控制台无 application error/warn。需求截图与实现截图同屏复核为 P0/P1/P2=`0/0/0`，视觉验收 `passed`。
- 最终 `20260810-v141-dashboard-metrics-1` release verifier 通过：Phase 0 `f5f9733bb78bd166ca9830a7fae93f7d13424e91576a94bfb4d423daf237c8fc`；ESM `62` modules / `352` edges，graph `1e46896eb88196205451798c371dd61f8d5cb1746393d6d6af23c38946c0b4f7`、closure `55653fe6a38d0e22a0ff7e440e4b7b9f424b7378b586973e73fa4e12ccf942bd`；canvas `63` files / `1,767,334` bytes / `59b1d83c6235ad26c4b20c1e0182dec47205c53677a06035f95cde42667d6789`；runtime `58` files / `3,017,489` bytes / `8c11682949534a5074ce1866ee24d90dd58fda68eed2e95db1cdd92b35827d1f`。

## v141.0 - 2026-08-09（本地候选：内容配额、发布规则与百舸产品事实）

### 本版范围

- 同一内容账号每个中国日历日最多创建 `2` 条内容，所有团队成员共用。前端同步权威用量、用完即禁选；旧页面或并发页面的第三条写入仍会在服务端 `BEGIN IMMEDIATE` 事务内收到 `409`。首次创建日由服务器盖章，后续整文档回推不能擦除或改日。
- 常规单号、批量生产、视频工坊与无限画布共用发布文字门禁：小红书标题最多 `20` 字（标点计入）、文案最多 `1000` 字；视频号标题最多 `16` 字且不得含 Unicode 标点。定制发布窗口实时识别账号平台并显示计数，前端提交与服务端原子发布各校验一次。
- 产品库新增「百度百舸 6.0」，按用户提供的产品资料记录数据生产、开发训练、仿真评测、推理四阶段能力和已确认性能数据。标题明确出现百舸时优先以它作为主产品事实；`LoongForge` 保持「待确定」，不得写成正式能力。
- 视频工坊静态分镜的大图参考在上游请求前用 FFmpeg 生成独立 JPEG 压缩副本，原始上传不改动；最多 `8` 张参考图按整包原始字节不超过约 `5.5MB` 分配预算，为 base64 和提示词保留空间，避免 `request body too large, maximum size is 10MB`。
- 供应商发布清单操作列扩宽，回传链接后的末个按钮不再被裁切。发布清单搜索改为仅当前页面会话有效，刷新后不再把旧账号/素材关键词恢复为看似「默认 ID」的值。批量图文任务板新增「统一每条图数」与「应用到全部图文」。
- release/cache identity 为 `20260809-v141-content-governance-2`。候选已通过本地验收并进入受保护生产发布流程；在服务器完成验签、备份、短时切换和验收记录前，生产仍以 v140.6 / `2d48b0efa5d836f8f0d9c50ad52ef8540f73a578` / `20260809-v140-core-connectivity-3` 为准。

### 验证边界

- 锁定 CPython 3.12 主服务全量收集 `776` 项：`775` 通过，唯一跳过为既有批准的 v120 只读快照项；视频 sidecar `142/142`、最终 Node `126/126`。服务端覆盖跨成员每日配额、旧页面回推保留服务器日期、四类发布文字负例、通用集合权限、团队授权与供应商原子发布；sidecar 覆盖大图压缩副本、八图整包预算与既有静态分镜并发/携带参考图。
- 最终 `20260809-v141-content-governance-2` release verifier 通过：Phase 0 `c06479d47fa033905eac0218f2b6fc17f9f9fea2e50f632bb8a01707fa698d8b`；ESM `62` modules / `352` edges，graph `58645f76354e38de5e22cae84d84fa397cda157c021517b1362a8adbe24e2786`、closure `8c644ca786275f9314cc952ea57f7efedc68c41b47e5a873be9f9709e48d33e2`；canvas manifest `59b1d83c6235ad26c4b20c1e0182dec47205c53677a06035f95cde42667d6789`；runtime `58` files / `3,017,493` bytes，manifest `a665b6e8a2c21d989a6eda92b8b742761746b4d4c69ddbede73dcd9e82116227`。
- 本地真实浏览器用临时供应商与六条回传数据验收：最终样式计算为操作组 `307px`、可用区 `390px`、`gap=0`、`clipped=false`，五个操作含“改链接”文字及右边界完整可见；发布清单搜索不再跨刷新恢复。相关选择器仅命中供应商清单，没有改动首页全局布局。当前本地服务已打开供用户手动验收；这不等于生产已发布。

## v140.6 - 2026-08-09（核心生成链路恢复与信息流缓存闭环）

### 本版范围

- 生产功能 SHA 为 `2d48b0efa5d836f8f0d9c50ad52ef8540f73a578`，分支 `codex/v122-team-auth-home`，release/cache identity 为 `20260809-v140-core-connectivity-3`；实际运行 release 为 `20260809-v140-core-connectivity-3-2d48b0e`。主服务和视频 sidecar 均从该 release 以完整 RW 运行，`NRestarts=0`。
- 无限画布后台 job 兼容浏览器 `sourceProjectId` 与服务端稳定项目 ID 的历史映射，但仍严格校验 job/project owner、payload identity 和唯一 team/resource scope；已授权媒体隔离证据加入 GC live-set 后，既有 38 条隔离历史结果不再误触发跨 owner 冲突。生产真实画布 job 已进入 `succeeded`。
- OmniHuman 1.5 的角色图和音频必须能由上游公网读取。生产 `PUBLIC_BASE_URL` 已显式设置为 `http://xingzhenworld.com`；签名后的公网图片、音频 Range 探针分别返回 `206 image/png` 与 `206 audio/mpeg`，数字人 submit/poll 真实请求返回 200。私有源文件和鉴权配置没有公开或覆盖。
- 信息流失败不是模型未生成镜头：真实服务器 LLM 首轮已返回前后各 5 条 `0.0-2.0s | ...` 式分时镜头。首个修复放宽了中文秒数边界，但六个上游模块仍以旧 `v=20260727-v118-7` 导入 `js/api/ai.js`，浏览器 immutable cache 因而继续执行旧解析器。最终提交把 `ai.js` 和完整 ESM 依赖图统一到新 identity；生产浏览器已实际请求 `ai.js?v=20260809-v140-core-connectivity-3`，线上字节 SHA 与 release 完全一致。

### 验证与数据保护

- 目标 Linux 上 release verifier 通过：Phase 0 `6f257170c55084814298d4387e397c794d12da9d8879f1639f62f6806d6af96e`，ESM `60` modules / `342` edges，graph `06aa09adc2c0d5d0e2cda8b58fbcf9966ddd191ba1e06cd3fc3193ea0a9b5bb6`，closure `80e5670dca6263206efdb7d2553480b99575f429e9ae4b06cd20b40456bf17f5`，canvas manifest 保持 `59b1d83c6235ad26c4b20c1e0182dec47205c53677a06035f95cde42667d6789`，runtime `58` files / `3,001,887` bytes / `526ab76ee1d7636711bd4d65dc1b5d479a1e59226b055358278da12b2bb81556`。完整功能提交通过主服务 `773 passed + 1 approved skip`、sidecar `140/140`、Node `124/124`；最终缓存提交另在 Linux 通过 `57/57` 定向 Python 与 `124/124` Node。
- 切换前 SQLite v2 backup 为 `pre-v1406-core-connectivity-7c0bff0-20260809T080435Z`，manifest `2e951862723aca70356f7ecd0dc0d34dc09230dbe085c1154612dc8157f119a1`；20-component snapshot 为 `pre-v1406-core-connectivity-7c0bff0-20260809T080833Z`，manifest `53d3e10b44be6b6710c73ed74ecc1e0b9f27ecc6114c8b1362c48814e99b2b2d`，已 verify 并 restore-drill，恢复库 `quick_check=ok`。前一生产 release 和 systemd 配置回滚点均保留。
- 生产 readiness 为 `ready=true / writeReady=true / startupVerified=true`，数据库 `quick_check=ok`；resource missing、usage unresolved/outbox/spool、unisolated media、isolation conflict/drift 均为 0。raw 缺失事实仍保留为 `missingReferencedFiles=46 / pendingRows=48`，但精确 `isolated=46 / unisolated=0 / effectivePending=0`，没有删除引用或伪造媒体。
- 部署前后均为 48 张表，行数 `57,843 -> 58,045`，没有任何表下降；媒体 uploads `6,232 -> 6,238`、composed `986 -> 991`、canvas blobs `632 -> 634`，video projects/uploads/outputs 保持 `56/168/1,694`，没有任何受保护媒体减少。增长来自部署窗口内的正常生产活动并完整保留。
- 公网 root、health、OpenAPI、community 均为 200；未认证受保护 API 为 401。重复读取 `/api/ready` 不改变 live gate。部署仅更新验签代码、静态文件和受控 systemd release 指针，未用本地 SQLite、账号、媒体、认证状态、私密配置或 Nginx 覆盖生产。

## v140.5 - 2026-08-09（生产已恢复完整 RW）

### 本版范围

- 生产功能 SHA 为 `390a563802fa62d2fa1278a25fe7ad266e1f294c`（`fix: recover durable video usage receipts`，parent `5f2ee647a6421bb782aa8079646f860c0a681eb8`），分支 `codex/v122-team-auth-home`；release/cache identity 继续为 `20260809-v140-media-isolation-1`。主服务与视频 sidecar 已从同一受审计 release 以 `ACG_READ_ONLY=0` 稳定运行。
- expand-only `140010` 媒体隔离账本已按用户授权的精确计划 apply。`46` 个无可靠原件引用仍全部保留：`38` 个 succeeded `customCanvasGenerationJobs` 输出、`1` 个已发布 community canvas 与 `7` 个 server asset/upload；不改写原 docs、引用、`private_media_registry` 或物理文件，不伪造占位、hash、归属或 provider 结果。隔离媒体返回 `410 media_isolated`，依赖原件的下载、发布、转发和复用逐条拒绝，其他业务恢复正常。
- 媒体审计继续显示 raw `missingReferencedFiles=46 / pendingRows=48 / publicAvatarExemptions=2`，同时严格计算 `isolated=46 / unisolated=0 / effectivePending=0`。隔离不是恢复文件；任何未来新增缺失、owner/scope/hash/reference 或数据库/媒体摘要漂移仍会重新阻断写门。
- 生产锁定 FastAPI 0.68.1 / Starlette 0.14.2 不执行较新 `FastAPI(..., lifespan=...)` 的问题已改为旧栈原生 startup/shutdown 事件。主服务必须在 `_prime_production_write_gate` 完整通过后才进入 `Application startup complete`，失败则不提供服务；`/api/ready` 保持纯观察，不能武装或撤销 live gate。
- 视频工坊用量审计接受精确的旧 v1 `operator-confirmed-unknown` 不可变结算证据，从而识别并关闭 `14` 个历史假冲突而不改写历史 receipt。另新增绑定 plan、snapshot、backup 与 DB identity 的耐久恢复 CLI，仅导入 `3` 条 sidecar 已持久化且已确认完成、但中央账本缺失的记录；原子写 receipt/outbox/projection/v2 settlement，全程不调用或重试 provider。

### 验证与发布边界

- 目标 Ubuntu x86_64 / CPython 3.12.3 三套 wheelhouse 重新验签，离线 `--no-deps`、exact-installed 与 `pip check` 全部通过：主 runtime `18` 包 / manifest `a683258aec8c78864792d90184eed682709659dd6127f84ccfa04a6b2bb2a089`，主 test `20` 包 / `f064da114e892e9607ad076d728c23967ffdef4b560b0ba622c9edc1f22bfb79`，sidecar `37` 包 / `2288f55ffcf180da34e7e7b02c119990dda042ad1de48d3ec479c6af96bbc1ac`。
- Linux locked 主服务收集 `773` 项：`772` 通过，唯一 skip 是已批准的 v120 快照项；sidecar `140/140`、Node `124/124`，compileall、全部跟踪 JavaScript `node --check` 和 release verifier 通过。Phase 0 为 `7c920495f0f67c630b0686891f16b5b90dea9571af8e42ba2e9ac54e35cc717c`；ESM `60` modules / `342` edges；canvas manifest `59b1d83c6235ad26c4b20c1e0182dec47205c53677a06035f95cde42667d6789`；runtime `58` files / `2,997,715` bytes / `15ce077bfa61dba6e4bf54a59afc3804f6a4dced16fe467c7f5833cb085fe972`。
- `3` 条耐久用量恢复 apply 结果为 `applied=true / inserted=3 / projected=3 / terminal=3 / unresolved=0 / outbox=0 / quick_check=ok`；fresh post binding 二跑为 `applied=false / reused=true / insertedRows=0`。最终 sidecar 审计为 receipt `810`、raw pending `810`、terminal `810`、settled `40`、effective pending `0`、conflict `0`；raw 是历史证据计数，不等于未结算，且全程没有 provider retry。
- apply 前后分别创建并验签 fresh SQLite v2 backup，当前 20-component complete snapshot 也通过 verify/restore-drill；没有重放 `140008/140009/140010`、tenant/resource/canvas/incident 或旧 usage settlement。所有业务表行数无下降，新增仅为预期的 `3` 条 usage receipt/outbox/projection 及对应 v2 settlement；媒体文件数完全不变。
- 最终主服务和 sidecar 均 active/running、`NRestarts=0`，两者 `ACG_READ_ONLY=0`。连续受保护 `/api/ready` 为 `ok=true / ready=true / writeReady=true / startupVerified=true / blockers=[]`，SQLite `quick_check=ok`；root、OpenAPI、health、community 均为 `200`，受保护负例为 `401`，隔离媒体精确为 `410`。真实浏览器首页和社区正常渲染，隔离卡明确显示历史原件不可用，控制台无应用 error/warn。
- 部署仅更新受审计代码与公开 systemd RW 覆盖层；生产数据库、账号、媒体、认证状态、私密环境和 Nginx 未被本地状态覆盖。既有 RO 配置、旧 release、代码/服务回滚点以及 pre/post 数据保护点均保留；回滚只能恢复代码和服务配置，不能用旧数据库覆盖当前业务写入。

## v140.4 - 2026-08-09（生产恢复工具已受保护上线，保持 RO）

### 本版范围

- 新增 expand-only `140008`/`140009`：前者只增加生产恢复审计账本，后者只增加多来源模型用量裁决账本；不修改旧表、不重放 `140002/140004`，不在应用启动时自动修复生产数据。
- `customCanvasGenerationJobs` 新写入与 resource scope 同事务；成员加入团队时先完整验证其旧个人 scope/private registry，再原子收编到唯一活动团队。踢出团队不反向改写已归团队的资源，账号保留为 Free 且不再获得访问权。
- 增加只针对当前精确异常集的 resource scope 增量结算、历史个人租户收编、画布 Blob 恢复和缺失媒体事故裁决 CLI。所有 apply 都绑定当前 DB identity、fresh SQLite v2 backup、fresh `acg-production-complete-v1` snapshot 与 live media digest，计划哈希/条目不一致时整体 fail closed，第二次执行必须零写。
- 5 个已验签的历史社区画布 Blob 可从指定的历史完整快照/恢复证据安全复原：历史 DB owner/mime/size/stored name、当前唯一业务引用和 `sha256(mime + NUL + bytes)` 必须全部一致，目标已存在则禁止覆盖。历史 18 组件快照只是媒体证据源，不被伪装成当前 20 组件回滚点，恢复器也不读取其 env/systemd 内容。
- 无限画布 GC 的 live-set 纳入同 owner 已成功后台 job 和已发布 community 的持久引用；坏 JSON、归属不明或跨 scope 冲突时整批不删除，只有真正无引用 Blob 才能 GC。已发布/交付/账号引用的 server asset 删除改为文档权威保护先行，不再先删物理文件、再异步删文档而留下悬空引用。
- 多来源 usage v2 严格覆盖人工计划列出的全部 unresolved：中央 timeout/5xx unknown 只记录“已知调用尝试”且 Token/输出为未知 0；sidecar succeeded 按唯一回执投影；sidecar unknown 只记尝试；sidecar submitted 裁决为不计费、不投影的 terminal indeterminate。任何模式都不重试 provider，不补扣积分，不猜 Token/providerRef。
- 代码审计确认：无限画布上游图片 URL 只在当次请求内用于下载，随后即转为 data URL 和本机 Blob；后台 job、generation receipt 与 completion spool 都不持久化原始成片 URL。因此剩余 38 个 job 结果、1 个 community 媒体和 7 个 upload 不能通过现有外部 URL 可验签恢复，不得重新提交 provider、伪造占位或删除业务引用。事故裁决只会写不可变证据，不会让 readiness 通过。
- 生产已运行功能提交 `eb4c9c599c25aaad3d361d0aa2d6697e870c5f0f`，release/缓存身份为 `20260809-v140-production-recovery-1`，实际 release 目录后缀为 `eb4c9c5`。主服务和 sidecar 均 active/healthy，systemd 与进程 cwd 已核对指向同一受审计 release；`ACG_READ_ONLY=1` 继续保持，本地数据、媒体和私密配置未覆盖生产。

### 验证与发布边界

- 目标 Linux x86_64 / CPython 3.12.3 三套 wheelhouse 全部通过 build/verify、离线 `--no-deps`、exact-installed 与 `pip check`：主 runtime `18` 包 / manifest `b9db22222b6af456656c628fd2d416b64f9f05a049751a3b0dcc5eb184b4327c`，主 test `20` 包 / `a3ff598a8d2c3cece4ad74f1b069f5213dee3dc7888a9147aa97f11840ae7471`，视频 sidecar `37` 包 / `69943e2e8ee1936b6d819c44ef91395d543af7ab930b1e1cccc10dee12ed39e4`。
- Linux 无私密 locked 主服务收集 `767` 项：`766` 通过，唯一 skip 是已批准的 v120 快照项；sidecar `140/140`，Node `123/123`，compileall 通过。release verifier 通过：Phase 0 `87fb5996ddd38bc6027b3a7d2b050b10017965a09b13d731c08e8fb7f8f4de85`，ESM `60` modules / `342` edges，graph `8a8b7888449f2d6ccdcf53164994d919ded4e6800cd5138146b60f1bac956aef`，closure `1db4271109d46345afda01a60a27a3610e5aae222c4683f7583e27de476126f2`，canvas manifest `59b1d83c6235ad26c4b20c1e0182dec47205c53677a06035f95cde42667d6789`，runtime `58` files / `2,901,522` bytes / `a1782177ab8d2ac14beb1d25d791c5aa8df78ea58b9b10f8d4209c52749be61c`。

### 生产受控数据闭环

- expand-only schema `140008/140009` 已早前双跑成功，本轮没有重放。tenant adoption 精确 apply `60` 行且二跑 `0`；resource settlement apply `166`，全部记录 `historical source project absent`，二跑 `insertedRows=0`；canvas recovery 仅恢复已验签的 `5` 个 Blob / `10,924,695` bytes，二跑 `recoveredRows=0`。
- incident adjudication 精确覆盖 `46` 条缺失事故，二跑 `insertedRows=0`，且 `readinessUnchanged=true`。usage v2 精确结算 `83`：`56` central unknown、`19` sidecar unknown、`7` submitted indeterminate、`1` succeeded；apply 结果 `insertedRows=83 / terminalRows=83 / projectedRows=76 / indeterminateRows=7 / unresolved=0 / outboxPending=0 / quickCheck=ok`，二跑 `applied=false / insertedRows=0 / reused=true`，全程无 provider retry。
- 最终 fresh post-usage 保护点为 `v1404-post-usage-20260808T234813Z`：SQLite backup manifest `bd1527e81e0e99d99499f021297866f5eb6124042860567a5837f36e4b3b9660`，DB logical `3106ebfa610a3cdf7e9e7d8d32ad9b0625027bb7cdfed248c3257c998733e026`，20 组件 snapshot manifest `8426d3e038e6cea2618ac06945a35b6daf2634718f7b1cddf4b58e25f73c58d2`，media digest `b8946380118911ab6530be35444e19d38b0e0764b3a2e08bc0c03cfd595c30b9`。verify、restore-drill 和 SQLite `quick_check` 均通过；已保留报告、哈希、SQLite backup、snapshot 与既有 rollback，只清理可由保留 snapshot 重建的重复 restore-drill 副本。
- 与部署前保护点对账，最终 `46` 张表无任何行数下降，docs 仍为 `14,786`；members `88`、teams `1`、team_members `76`、team_suppliers `4`、supplier bindings `52`、team accounts `80`、community posts `60`。媒体 inventory 为 uploads `6,223`、composed `984`、canvas blobs `627 -> 632`、video projects `56`、video uploads `168`、video outputs `1,694`；新增仅来自受控账本/scope 和 `5` 个真实 Blob，usage ledger v2 entries=`83`。
- 公网 root/index/health/community/download manifest 均为 `200`；未认证受保护资源为 `401`，无效登录为 `401`，无认证写入探针为 `503 maintenance`；sidecar health ready 且 deny-mutations。重复携带保护 token 请求 `/api/ready` 结果完全一致，不改变 live gate。60 个 community posts 共 `138` 个媒体，`137` 个返回 200，唯一 404 与唯一缺失的已发布 community 媒体精确对应。
- **完整 RW 尚未恢复**：最终 `/api/ready` 为 `ok=true / ready=true / writeReady=false`。resource missing/orphans/invalid、usage unresolved/outbox/spool 和 registry conflicts 均已归零，但 media registry 仍有 `missingReferencedFiles=46`、`pendingRows=48`，`issues=[missingReferencedFiles]`。46 条分为 `38` 个 succeeded `customCanvasGenerationJobs` 输出、`1` 个已发布 community canvas 和 `7` 个 server asset/upload；除已恢复的 5 个外，已穷尽现有可验签证据而无可靠原件。不得用裁决回执、占位、删引用、伪造归属或放宽 readiness 解锁 RW；只有用户提供精确原件/独立可验签来源，或另行明确批准不丢数据的业务隔离设计后，才能继续恢复写入。

## v140.3 - 2026-08-09（受保护生产部署，当前 active + RO）

### 本版范围

- 首页灵感从一次读取 48 条改为每页 16 条的 `createdAt + id` 复合游标分页，同一毫秒发布的帖子跨页不漏不重；图片保持懒加载，卡片视频仅在接近视口或悬停时设置媒体源，追加失败保留已有内容并提供重试，降低社区内容增长后的首屏网络、鉴权和解码压力。
- 供应商交付展开行修正为覆盖完整 10 列，媒体栏使用受限宽度，不再留下截图中的大块右侧空位；图集弹窗以受限宽度居中排列，单图在桌面端不再缩在左侧。图集 URL 缺失或 401/404 时保留图片序号并显示明确“暂不可用”，预览与下载继续使用 delivery-linked 精确授权，不把私有媒体改成公开 URL。
- 供应商缩略图、封面和弹窗预览与下载统一携带当前 `deliveryId`，由服务端继续精确核对交付可见性和媒体依赖，修复文件真实存在却因裸私有 URL 被拒而显示“图片暂不可用”。批量图文在刷新后按持久化 production/job 检查点恢复：空的 `images/running 0/0` 重新接续起草，已有提示词继续生图，已齐图片直接审核，已有 provider job 只恢复进度；“思考中”同步从持久状态重建。提示词计划、每次图片调用前状态、逐张完成结果和全部图片完成后的 review 终态均等待服务器单文档确认；水合发现 4/4 仍残留 running 时也会幂等落盘 review，不再依赖刷新即丢的内存 Map 或延迟整集合回推。
- 批量工作台的远程水合改为渐进分组：先返回 session/batch 让左栏和选中会话可见，再返回 production 打开工作台，job 轮询状态、assets 和分析继续后台到达；恢复器以累计集合判定四类核心文档完整，不会因拆请求而提前重放任务。真实统一左栏的批量会话行现在固定显示无边框三点菜单，提供重命名/删除；选中会话参考无限画布/视频工坊的轻量视觉，只用柔和光影流动、轻阴影和 `aria-current` 表达，不再显示“当前”文字或整行蓝色框架。思考卡的进度只统计本轮仍有真实活动的批次，已审核/失败的历史批次不再混入分母形成误导性 `1/13`。
- 本轮审计确认批量生产仍是浏览器编排：已有 `providerRef` 的上游任务在刷新后会查询同一任务，已持久化的起草/图片检查点会在重新打开后接续；但关闭最后一个页面后，尚未提交上游的后续步骤不会自主推进。因此本候选只承诺“刷新可恢复且不重提”，不冒充“关页整批仍全自动完成”；后者必须将 LLM/图片/视频分步状态机迁入 owner-scoped 服务端 durable workflow，并通过幂等与计费门禁后才能上线。
- 无限画布把查询超时、临时 429/5xx 和浏览器网络中断识别为可恢复连接状态：占位继续保持 running，按 2/5/10/20/30 秒退避并在网络恢复后查询同一 owner-scoped job；隐藏页降低轮询频率。服务端 job 的明确 failed 改用非瞬态 422 语义，避免被 502 网络分类误判为永久后台运行；不重提 provider、不重复扣费。
- 保留 v140.2 的服务端原子发布、缺失批次 session 幂等恢复、供应商权威指标和视频工坊稳定性闭包。旧 `/logo.png` 文件不存在时安全回退到受跟踪品牌图，不恢复或提交工作区中的历史删除，也不让兼容路由抛 500。
- 主平台、供应商视图与视频工坊缓存身份统一为 `20260808-v140-platform-stability-15`；无限画布从当前源码重建并同步受控 vendor 闭包。

### 自动验证与边界

- Python 3.12.13、精确 20 包测试锁、无私密 `env -i` 的单一 locked runner 最终收集主服务 `745` 项：`744` 通过，唯一跳过是规则允许的旧 v120 只读快照未进入隔离副本；无功能失败、错误或其他 skip。测试 wheelhouse `20` files，lock SHA-256 `2761fda33970336dcca73c7cf1e82e1c0a0d045a89c23fef0b3b70549b87c32e`、目标 Linux manifest SHA-256 `fd48f76360949430fd8bf217026544e8b63fa25814579316f1a1d0513033918a`。locked runner 显式要求 Node、FFmpeg/FFprobe、Git 与 `lsof`，避免缺少端口证明工具时把安全退出误判成业务失败。视频工坊 `140/140`；Node 全量 `123/123`。供应商交付关联预览/下载/回传、父子账号权限，批次刷新恢复、持久思考态、社区分享、Free 积分、画布后台任务和创作端各模型账本均已纳入。
- 无限画布 TypeScript、ESLint、production embed build 和 vendor 闭包校验通过；最终闭包为 `63` files / `1,767,334` bytes。Python 编译、全部现存跟踪 JavaScript 语法、`git diff --check` 均通过。本地视觉证据覆盖统一缓存启动、首页与两个健康端点；生产只读浏览器证据另列于下方。供应商缩略图、批次刷新恢复、三点会话菜单及选中呼吸阴影没有生产业务账号验收，不能沿用前一缓存或源码测试冒充通过。
- release verifier 通过：Phase 0 SHA-256 `91e5f5457070c0da0cac4f1ecca28d17927fe3f30ff38126a3c500db2dac692b`；ESM `60` modules / `342` edges，graph SHA-256 `9dff4d2bc3a9641e5e8b3cb769e0b87d11f5546a8f8d22212f18517febb6ae26`、closure SHA-256 `cb3fea9879aa38e352f6ae01bc9a8c42c9829d09c2dd5a4ff9d63d76652cc70e`；canvas `63` files / `1,767,334` bytes，manifest SHA-256 `59b1d83c6235ad26c4b20c1e0182dec47205c53677a06035f95cde42667d6789`；runtime `56` files / `2,766,415` bytes，manifest SHA-256 `b6845c5b8e82fa0d453c4fc2d9c852e0f9d9fca07fbf5005880689374388801c`。
- 本地启动验收曾按安全截止规则接续用户当天已派发的两条 `123` 图文任务并产生图片，旧任务均明确失败且没有自动重放；这不是生产调用或生产写入。生产部署只接收最终干净提交的代码/静态闭包，服务器 SQLite、账号、资产、发布清单、uploads/composed/canvas/video runtime、认证与私密配置继续使用既有绝对持久路径。

### 生产部署结果（受保护 RO）

- 2026-08-09 从最终部署提交 `7aeec8f65e02e7f5aa183ef6aa623c785813646a` 建立 sibling release `/data/dumate-studio/releases/20260809-v140-platform-stability-15-7aeec8f`。主服务与视频工坊 sidecar 的 systemd 实际进程均解析到该 release，统一业务身份为 `20260808-v140-platform-stability-15`；两套服务 active、健康端点和主站/视频工坊/无限画布静态入口均为 200，切换后 `NRestarts=0`，错误与严重异常日志命中均为 0。
- 切换前在双写入进程冻结窗口内创建 fresh SQLite v2 备份 `/data/dumate-studio/migration-backups/pre-v1403-final-20260808T163547Z`，manifest SHA-256 `8db8e2e84fa58459b6b74cf316d6aa13611a54740d74bfedff521e1d1c4f4bdb`；另创建包含实际 systemd drop-in 的 20 组件完整快照 `/data/dumate-studio/snapshots/pre-v1403-final-7aeec8f-20260808T163547Z`，snapshot ID `f13c9d95e6a94e4299a032c50ebbfe62`、manifest SHA-256 `36a78674cb60a2c83db4a8cedb48cafc506a192954cdcc827ec1a99827b815ea`、媒体摘要 `e0ad0f8d1a33925c3f10f5c28bcc9fdf481609938abc9a7c1f99ac1b6014c9d0`。独立 verify、空目录 restore-drill 和恢复库 `quick_check` 均通过；既有 rollback 未轮换。
- 目标 Ubuntu / CPython 3.12 三套 wheelhouse 重新验签并离线 `--no-deps` install-check、exact-installed、`pip check`：主 runtime `18` 包 / manifest `3f8b942eb34b7ea757e9ad7ea9378e615152e4f07031c583d495f3dcdd27e77b`，主 test `20` 包 / `fd48f76360949430fd8bf217026544e8b63fa25814579316f1a1d0513033918a`，sidecar `37` 包 / `81d36bc2822f25dd4ec7df8589f6b0ca5e8ac722e3b43225cc7707383cab7262`。干净无私密环境复跑主服务 `744 passed + 1 approved skip`、sidecar `140/140`、Node `123/123` 和上述 release verifier。
- 切换前后生产 SQLite 均为 `42` 表 / `56,957` 行，`quick_check=ok`，物理 SHA-256 都是 `740d28eaddd98808722bd47a98eaf7ee6fdcf8290eb8760e6804a86bc81b88c9`；成员、团队、账号、供应商关系、文档、媒体 registry、resource scope、模型用量、画布与社区等关键表均无异常减少，切换后媒体 inventory digest 与 final snapshot 完全一致。生产环境、数据库、媒体、账号和私密配置没有被 release 同步覆盖。
- RW 未解除。新 release 的受保护 `/api/ready` 为 `ok=true / ready=true / writeReady=false`：resource preflight 仍有 `166` 条 unresolved 和 `15` 个无效目标；media preflight 仍有 `48` 条 pending、`51` 个缺失引用文件、`45` 个 registry conflict；usage 仍有 `83` 条 unresolved，其中 snapshot 仅找到 `27` 条 sidecar receipt、缺 `56` 条，现有证据也不足以安全结算。既有 `140002/140004/140007` 成功账本禁止重放，所有 preview 均 fail closed，本轮未运行 apply、裸 SQL、provider 重试或猜补用量。
- 真实浏览器只读验收确认公网首页、灵感首屏与复合游标加载更多、社区详情、视频工坊登录边界和无限画布静态闭包可达；浏览器同时复现了缺失社区媒体的 404，与 preflight 阻断一致。任务没有提供生产业务验收账号，且写门禁未闭合，因此供应商父子账号、管理员/创作者写入、付费模型、发布/回传、团队踢出和账号停用等多角色场景未执行，不能沿用源码测试或游客烟测冒充生产 RW 验收。

## v140.2 - 2026-08-06（平台稳定性与交付恢复候选，尚未部署）

### 本版范围

- 发布动作改为服务端原子提交 production、delivery asset 与全局序号；服务器处于只读或写入失败时前端明确报错，不再出现浏览器先显示发布成功、刷新后交付消失。历史重复/错位序号保留受控校准入口，只能在生产快照确认后单独执行。
- 批量会话恢复改为幂等补齐缺失 session 文档，并把恢复结果显式增量同步到服务端；刷新后批次、production 与 job 继续从服务端权威状态水合，不因一个缺失会话把仍存在的批次显示为“不存在”。左侧增加当前会话高亮、重命名、删除、移动到项目文件夹与收藏入口。
- 批量视频共用受控队列，数字人并发恢复为 `10`，超出任务继续排队。静态视频把 BGM 视为可选依赖：历史 BGM 媒体缺失或无权读取时跳过 BGM，仍严格要求画面和口播素材，不再让一条可选音轨使整批失败。
- 供应商交付的观看量与曝光量继续由专用服务端字段权威保存，父账号、子账号和创作端进入/聚焦时轻量刷新同一值。日常编辑保持最后一次成功写入覆盖前一次；新增的历史恢复工具只用于生产备份中已审计出的未同步差异，预览确认后按历史最大值做一次性恢复，不改变后续写入语义。
- 供应商交付媒体预览/下载携带精确 delivery 身份与会话；图片或视频缺失/拒绝时显式失败，不再生成只有文案的伪完整 ZIP，也不错误标记为已下载。供应商可将回传项标记为“无需发布”，该状态计入已处理但不伪造发布链接。
- 无限画布合并同一资源的并发读取，增加短缓存、超时和瞬态重试，减少域名入口下重复轮询造成的负载；生成与同步仍使用 owner-scoped 服务端任务。没有改变画布的尺寸判断或用户提示词，单号图文的横竖版约束只在单号链路修复。
- 单号图文对明确选择的画幅启用严格比例，防止参考图描述中的横版像素反向覆盖用户选择；视频工坊、加入团队弹窗、供应商团队标签、子账号入口、单号剪辑台和首页明细等既有稳定性/UI 修复一并纳入候选闭包。
- 统一缓存与候选发布身份为 `20260806-v140-platform-stability-5`。

### 验证与生产边界

- 主服务完整回归共 `731` 项：临时候选副本 `729` 项通过，另外 `2` 项仅因副本缺少 Git 元数据和被忽略的 sidecar 示例环境文件而在真实工作区隔离环境复跑通过；目标功能回归无失败。视频工坊 `140/140`、Node 全量、无限画布 TypeScript/ESLint/生产构建、Python compileall、全部受跟踪 JavaScript 语法与 `git diff --check` 均通过。
- release verifier 通过：Phase 0 SHA-256 `1974c8e51c40ebcf90ad4fd19676ffe85617169fd5a36e2d78f73906ece48354`；ESM `60` modules / `342` edges，closure SHA-256 `73accc4500dffa9fead96f8ecc7715b216a077cb4842552fd7f7c125f29fefaa`；canvas `63` files / `1,765,857` bytes，manifest SHA-256 `d54e2416a0479049396d088f8d09fd027159438f0efd40b7b7ed40b364f4594f`；runtime `56` files / `2,757,968` bytes，manifest SHA-256 `c6da264f6a6582c24f8abed7d47884041b56bd03b02606ca0468254c561bc9af`。
- 本地服务已从当前候选启动，`/api/health` 正常并返回目标 release；入口 HTML 命中同一缓存标识。该结果只证明本地候选可运行，不等于生产已部署。
- 生产只读核对确认 SQLite `quick_check=ok`，服务与数据仍在；本轮没有部署、迁移、恢复、补数或切换生产。生产当前处于只读状态时，任何业务写入都会明确失败，不能用浏览器本地快照冒充服务器成功。
- 下次受保护部署必须先建立一致 SQLite/媒体快照和代码回滚点，只同步本候选代码与静态闭包。之后依次执行原子发布验收、缺失 session 幂等恢复、历史全局序号受控校准，以及历史指标恢复的 preview/精确 apply；不得覆盖数据库、账号、资产、上传、成片、画布、视频工坊 runtime、认证或私密环境。

## v140.1 - 2026-08-05（平台生成稳定性与无限画布后台任务，已受保护部署）

### 本版范围

- 供应商父账号、子账号与创作端继续使用服务端权威的交付播放量/曝光量；普通资产快照不能覆盖专用指标字段，页面进入和重新聚焦会拉取轻量权威集合，使同一团队看到同一真实值。
- 修复普通创作者被错误排除在服务端模型配置探测之外的问题。所有具备创作权限的已登录成员都从服务器读取同一套 LLM、图片、TTS、Seedance 与数字人私密配置，不再依赖个人电脑或浏览器里的 Key。
- 登录过期的生成任务不再被误报为“模型未配置”。尚未提交上游的任务保留在队列，已有 `providerRef` 的任务只暂停轮询并保留引用；重新登录后继续查询同一任务，避免重复提交和重复计费。
- 无限画布的文生图与定向编辑改为 owner-scoped 服务端后台任务。浏览器先持久化占位和确定性 job ID，再提交服务端；离开页面只停止当前页面轮询，不取消上游请求，回到项目后从服务器恢复图片或明确失败。服务重启后的过久遗留任务会失败关闭，不自动重提付费请求。
- 无限画布首次进入时，只有在登录水合完成且服务器项目索引已成功同步、确认项目数为零后，才自动创建一个空白画布；索引读取失败时不误建重复项目。分享灵感使用独立分享图标，和发布动作保持可辨识。
- 视频工坊发布页在先生成封面、再根据标题生成文案时保留既有封面并更新文案基线；既有对话滚动修复继续保持。首页加入团队弹窗补齐宽度、换行和维护态错误，信息流重试会携带上一轮草稿与失败原因定向补足 A/B 面分时镜头。
- 私有媒体历史迁移完成后，唯一 `private_media_registry` 所有者继续作为权威归属；同团队后续共享的资产或交付文档只增加使用引用，不会把一份已登记媒体误判为多所有者。供应商父账号经 `team_suppliers` 明确绑定团队、且团队资产的 `supplierManagedBy` 精确指向该父账号时，该团队资产可以引用供应商登记的上传媒体；错绑供应商、跨团队引用、上传文件名前缀、视频工坊项目或画布 Blob 等强来源与 registry 冲突时仍失败关闭。
- 缓存与发布身份统一为 `20260805-v140-platform-stability-3`，无限画布已从同一源码重新构建并同步受控 vendor 闭包。

### 本地验证与生产边界

- Node 全量 `120/120`、视频工坊 `140/140`、既有定向回归 `177/177` 与新增私有媒体门禁 `16/16` 通过；无限画布 TypeScript、ESLint、生产构建和 vendor 闭包核对通过；Python 编译、全部受跟踪 JavaScript 语法、Shell 语法与 `git diff --check` 通过。
- release verifier 通过：Phase 0 SHA-256 `f1f70d1d64326724fcb1a835b70edfc7d4dacd1b439c4095a924de93f2943b3d`；ESM `60` modules / `342` edges，closure SHA-256 `05c30ef13ebb71aae6894ec95ec7a2e2225e21ee94dd70f82ebe98533df08020`；canvas `63` files / `1,764,379` bytes；runtime `56` files / `2,727,506` bytes，manifest SHA-256 `146cfafc8773ff183d64b5256a0548e4bfbe7527da2a08b0533b11a8bf24ae57`。
- 当前开发机系统 Python 3.9 与生产锁定 TestClient 闭包不一致，且工作树保留用户删除的旧 `logo.png`，因此未把系统 Python 直接运行的 51 个环境错误计作代码回归。正式主服务全量必须在最终干净提交、目标 Linux / CPython 3.12 和验签离线测试 wheelhouse 中重新通过后才允许切换。
- 部署只允许同步最终干净提交的代码和静态资源；不得覆盖 SQLite、账号/成员、资产/发布清单、草稿、分析数据、uploads、composed、canvas blobs、视频工坊 runtime、模型缓存、认证或私密环境。生产已在 schema `140007` 时不得重跑早期迁移。

### 生产部署结果

- 2026-08-05 从干净提交 `0d690d6` 建立 sibling release 并完成受保护切换，实际运行身份为 `20260805-v140-platform-stability-3`。主服务与视频工坊 sidecar 均已恢复正常读写，`/api/ready` 返回 `ready=true / writeReady=true`，SQLite `quick_check=ok`。
- 目标 Linux / CPython 3.12 验签既有三套锁定 wheelhouse，并重新执行主 runtime 与 sidecar 离线 install-check。主服务锁定全量收集 `720` 项、`719` 通过且只有批准的旧 v120 快照项跳过；视频工坊 `140/140`、Node `120/120`。服务器 release verifier 与本地最终闭包一致。
- 部署前创建并验证独立 SQLite v2 备份、代码/静态回滚点和受保护目录基线。切换前后 SQLite 仍为 `42` 张表、总行数 `37,465`，主要集合与 uploads `4,545`、composed `859`、canvas blobs `481`、视频工坊 projects `34` / uploads `123` / outputs `955` 均无减少；私密环境未替换。
- 私有媒体只读 preflight 已闭合：`ambiguousFiles=0`、`pendingRows=0`、registry conflict / missing owner / missing reference / team binding conflict 均为 `0`。供应商绑定媒体新增规则没有扩大任意私有 URL 读取权限。
- 服务器私密配置继续由服务端统一提供。管理员与普通创作者的 LLM、TTS、图片、Seedance / 数字人配置均返回 configured / reachable；真实最小 LLM、TTS、图片和 Seedance 提交与轮询均成功。未把 Key 写入前端、仓库或部署记录。
- 团队指标做了全量只读核对：`680` 条已交付数据中 `153` 条由供应商子账号更新过观看量或曝光量；更新者、对应供应商父账号与创作端管理员的缺失数和字段不一致数均为 `0`，证明专用轻量同步已在线生效。
- 生产浏览器加载目标缓存，1280px 与 1024px 两档均无横向溢出或白屏；游客访问受保护入口会正确打开登录层。日志观察窗口内主服务与 sidecar 均无新增应用级 traceback、5xx 或超时。
- 代码/静态回滚目录已按既定策略轮换并复核为最新 `5` 份。该轮换不涉及数据库快照、上传、成片、画布、视频工坊 runtime 或部署证据；当前直接回滚点为前一 sibling release `20260805-v140-platform-stability-2-1b41200`，回滚只允许切换代码和静态资源。

## v140 - 2026-08-04（生产已受保护运行 `9e8aeb5`；当前 P0 候选待部署）

### 本版范围

- 在既有 `137003` schema、`137004` ACG 团队数据和 `139001` 模型用量迁移之后，新增 `140001` resource scope schema 与 `140002` 历史资源归属迁移。受保护资源必须冻结到唯一个人或团队 scope；启用严格模式后，平台管理员也不再拥有跨租户 collection 旁路，新写入、更新和删除都在事务内核验行为人、owner、账号与上游资源的 scope。歧义、缺失或后续漂移均 fail closed，不能以“默认归入 ACG”掩盖未知归属。
- 新增 `140003` private media schema 与 `140004` 历史媒体归属迁移，为 uploads、composed、画布 Blob 与视频工坊持久媒体建立 owner/team registry。受保护文件读取使用服务端会话并支持 Range；本人及同团队成员按归属放行，外部团队管理员不能越权。社区已发布媒体保留独立公共读取边界；无业务引用的孤立文件只作为 quarantine 证据，不自动授予任何成员。
- 资源和媒体的少量真实孤儿可以使用人工复核 override，但 manifest 必须精确覆盖无 override preflight 报告的条目，并绑定冻结库的 database identity、路径摘要、逻辑摘要、schema/user version 及当次 fresh 备份 manifest SHA-256。所有生产 apply 都要求紧接执行前生成的 `acg-sqlite-backup-v2`，并在同一 `BEGIN IMMEDIATE` 内重新核对源库身份和逻辑摘要；前一步迁移成功后旧备份绑定立即失效。
- 新增 `acg-production-complete-v1` runtime snapshot/verify/restore-drill：把 SQLite、uploads、composed、canvas blobs、模型用量 spool、视频工坊 projects/uploads/outputs、BGM、模型缓存、环境、systemd 与 Nginx 纳入同一 snapshot ID，独立确认 manifest SHA-256，并把恢复限制到全新的隔离目录。媒体强内容摘要只用于显式 snapshot、media preflight/apply 和维护窗验收，不进入常规 `/api/ready` 轮询，避免约 15 GB 媒体反复哈希拖慢在线服务。
- complete snapshot 的 symlink 语义改为组件级、默认关闭的精确契约：只有 production plan 的 `model-cache` 与 `nginx-site` 允许解引用。模型缓存仅接受根内相对文件链接，Nginx 仅接受最终留在 `/etc/nginx` 的单文件链接；越界、绝对模型缓存链接、目录链接、环、dangling 和特殊文件继续失败关闭。归档/manifest 按最终真实字节验签，restore-drill 物化为普通文件，不改写现网模型缓存。production plan 本身也已纳入 runtime manifest。
- restore-drill 对目录组件增加精确纳秒恢复：安全解包后逐个普通文件按 manifest 写回 `mtimeNs`，禁用链接跟随并以 `lstat` 严格复核。生产媒体摘要继续绑定 path/size/mtimeNs/content SHA-256；文件系统哪怕只舍入 1ns 也会失败关闭，不以“字节一致”冒充完整恢复点。
- 主服务与视频 sidecar 新增精确依赖 lock、目标 Python/ABI wheelhouse manifest 与离线安装验签工具。生产启动器在监听 socket 前执行强制 write gate，核对 release、production/validate 模式、只读状态、资源/媒体严格开关、七步迁移、固定持久路径、公开媒体 origin、sidecar、画布闭包和用量账本；RO 可用于迁移验收但明确 `writeReady=false`，只有全部门禁闭合的 RW 启动才允许 `writeReady=true`。
- 本版没有为追求“拆文件”机械重写大单体。8787 主服务、8765 回环 sidecar、无限画布源码/审计后 vendor 闭包和 release 外持久数据边界保持不变；优化重点是把环境、迁移、权限、媒体、备份、依赖和切换条件变成可独立验证的契约，降低一次改动同时牵动代码与生产数据的风险。
- 移除真人/数字人和图文批量任务的“站内生成失败后等待补图/上传”兜底：图片服务缺失、图片未完整返回、数字人口播/角色准备失败和视频 job 终态失败都进入带原因的 `failed`，只允许用户明确点击重试。`evaluate()` 与 JobRunner 只自动派发 `pending`，刷新不再重启 failed；旧 `needs_input/awaiting_input`、等待卡和关联 queued/running job 在本地/远端快照及 IndexedDB 水合时幂等归一为失败终态。计划参考图、任务行、详情和资产入口的主动上传仍保留，但不再跨任务自动填补生成缺口。
- 补齐视频任务的水合终态收敛：仅对当前 owner 的 `render/workshop + running` 进行只读分类。已有明确 `finalVideoUrl` 直接进入 review；所有非 superseded 片段 job 都 succeeded、覆盖完整规划且带可验证视频输出时，只复用现有片段合成成片，不重提 provider、不新建 job、不重复扣费。失败 job、缺段、缺输出或未知终态 fail closed 为可读 failed；无 batch、done batch 内残留 running 和无真正活跃任务的 generating batch 均可幂等收敛。`finalVideoUrl` 和 job output 只接受真实 URL/path/data/blob 或已知媒体键/容器，`status/providerRef/message/taskId` 不再可能被误认成视频。
- 新增 expand-only schema `140005`：`video_compose_operations` 以 owner + 确定性 production/timeline 指纹建立 SQLite 原子 claim。成功成片与 `private_media_registry` 在同一 `BEGIN IMMEDIATE` 提交；同标签页复用进程内 Promise，跨标签页/跨进程由持久账本等待并复用同一 URL，失败行可重新 claim。浏览器 `artifacts.composing` 只表示展示态，不再作为“刷新中断”的失败依据；服务端 pending 或浏览器 180 秒停止等待都保持 running，下一次水合用同一请求查询账本并在成功后进入 review。
- 供应商交付媒体读取改为三重精确授权：请求必须携带持久化交付 ID，当前 supplier parent/child 必须通过既有团队、账号与 child binding 可见性，目标文件又必须恰好是该交付的 `coverAssetId` / `packAssetIds` / `sourceAssetId` 或最终 `videoUrl`。这不会让供应商成为 team member，也不授予其他私有 URL、删除或覆盖权限；历史绝对 URL 只接受明确配置的本站 public origin。图文/视频 ZIP 任一必备媒体读取失败时直接显示报错并停止，不再静默产出只有文案的伪完整 ZIP。
- 视频工坊的“发布成片”以被点击 delivery/output 的已持久化记录为权威，不再要求项目顶层 `status=succeeded`。因此项目回到 conversation/brief 后的当前成片和历史交付仍可发布；策略只接受当前项目 ID 下的站内成片路径，拒绝空 URL、failed/running output、路径穿越、外链与跨项目伪造，并以项目中的 canonical output 覆盖请求传入的可疑 URL。
- 视频工坊发送消息后只滚动 `.conversation-column`，不再对消息节点调用会联动所有可滚动祖先的元素定位 API。每次对话 DOM 重绘前记录容器 `scrollTop` 与距底部状态：显式发送强制让新用户消息和 pending 回复进入可视区，原本接近底部的轮询继续跟随；正在阅读历史消息时则恢复原位置，项目轮询、状态更新和普通重绘都不得把外层工作区带回顶部。
- 供应商 delivered asset 的播放/曝光数、更新时间和操作人改为服务端权威 triplet；泛用资产快照、父子账号旧标签页或创作端更新只能保留它们，不能用更大 `updatedAt` 覆盖。供应商页进入/聚焦时轻量拉取权威集合，写失败显式报错。首页总播放量弹窗增加账号下逐交付标题/播放量/更新来源明细和响应式筛选布局。
- 首页小红书图集使用主图+缩略图切换，主图可放大；小红书和视频号灵感都提供显式下载。下载仍使用携带会话的同源媒体端点，不把其他成员私有资产改为公开 URL。
- Free 用户的图片、视频、主语言对话、兼容对话代理、无限画布 Agent 和视频工坊对话都进入同一积分预占/结算/失败释放边界；幂等键防止刷新重扣。团队“删除”改为“踢出团队”，只释放席位并把账号回到 Free，账号、作品和历史资料不删除。ACG 市场部 owner/admin 可停用/恢复所有创作端账号；停用后旧 token 与两类媒体 cookie 都被服务端拒绝。
- 新增 expand-only `140006`：`member_account_states` 保存停用状态，`private_media_registry_settlements` 记录 post-140004 媒体增量收口。生产当前 114 条 pending 已精准定位为新视频工坊 `video-output`：新代码在项目终态同步/水合时原子登记当前 owner/team/provenance，登记失败返回 503 并允许下次水合补偿。既有 114 条只能用独立 `media-settle` 命令处理：必须绑定 fresh complete snapshot 的 manifest/media digest、当前库 identity 和 fresh v2 备份，只写无冲突 plan 行及审计 receipt，二次执行零写；不重放或改写 `140004`。
- 新增 expand-only `140007` 与 `usage-settle-inspect/preflight/usage-settle`：操作员必须逐条提供精确 operation ID，中央 receipt 与 complete snapshot 内 sidecar receipt 均按 SHA-256 绑定，计划还绑定当前 SQLite identity 和 snapshot manifest/media digest；每次预检/写入再单独验证 fresh `acg-sqlite-backup-v2`。sidecar succeeded 按权威 providerRef/Token/输出完成并走既有 projection；确实无法判断计费的 sidecar unknown 只能在显式人工复核后记 calls=1、Token/输出=0，绝不重试 provider。全部 receipt、legacy projection 和不可变 settlement header/entries 在一个 `BEGIN IMMEDIATE` 中提交，任一冲突整批回滚；同一计划在新 fresh backup 下二次运行 `applied=false/insertedRows=0`。RW write gate 现要求 `140007` 且 unresolved/outbox/spool 全部归零。

### 验证、Git 与生产边界

- 目标 Ubuntu 24.04 / CPython 3.12.3 的隔离 staging 在 `da8f2f0` 连续复现 64 个不同幂等键并发写 receipt 时至少一个 writer 用尽 5 次 `BEGIN IMMEDIATE` 重试；同一 staging 还证明 sidecar lock 缺少 ctranslate2 4.8.1 所需的 setuptools，联网 wheelhouse 和已有 venv 会掩盖该缺项，而 `--no-deps` 离线新 venv 的 `pip check` 稳定失败。生产因此保持 v120，未冻结、迁移、切换或重启。
- receipt 写入改为模型账本专用进程内微批：同一时刻到达的短 operation 分别在 savepoint 内执行，一次 `BEGIN IMMEDIATE`、一次 FULL durability commit；调用者仅在整批提交成功后获得上游授权。它不使用全局 `store._lock`，跨进程 exactly-once 仍由 SQLite 事务与唯一索引裁决，外部长锁继续共享 1.25 秒总截止时间并 fail closed。新增 128 unique 自动门禁，同时收紧 64 unique/replay P99 与单次最大延迟断言。
- 视频 sidecar 的开发依赖和正式运行锁显式增加 `setuptools==83.0.0`，正式锁为 37 项。依赖 verifier 不再忽略 setuptools；`installed` 在精确包核对后强制 `pip check`，新增 `install-check` 从验签 wheelhouse 创建一次性 venv，以 `--no-index --no-deps` 安装后再次执行 exact-installed 与 `pip check`。本地 CPython 3.12.13/macOS arm64 sidecar wheelhouse 为 37 个文件，lock SHA-256 `a062e5b9021c5430e585baeeb555d986e9644f0a80af23712a205481dc42fc59`、manifest SHA-256 `05c7caededf360deae12aa5f60a70778de0555b8195accb89497604fbf9f5f22`，`--no-deps` 离线闭包及视频工坊 `137/137` 功能回归通过；正式 Linux wheelhouse 仍必须从最终提交重新构建。
- 部署线程在干净提交上发现原 v140 依赖证据不成立：主服务锁是 FastAPI 0.68.1 / Starlette 0.14.2 / Pydantic 1.10.26，但一条 TTS 测试使用 Pydantic 2 专属 API，且 TestClient 的 requests 依赖未声明；另有 5 条图片端点用例会从本地私密环境继承 `IMAGE_API_KEY`。本次补充将生产运行锁与完整测试锁彻底分离，锁定兼容的 requests 2.28.2 / urllib3 1.26.20，增加锁扩展校验、离线一次性测试 venv 和 `env -i` 无私密全量入口；图片用例只注入假的测试配置，不触发真实 provider。
- 本轮在独立 detached 工作树、无 `.env*`、`env -i`、CPython 3.12.13、离线一次性 venv 中完整收集主服务 `691` 项：`690` 项通过，`1` 项仅因 Git 提交按规则不携带旧 v120 只读数据库快照而明确跳过；runner 只允许这一精确测试/原因，其他任何 skip 都失败。本轮样本 64 unique P99 `0.025698s`、128 unique P99 `0.020987s`、64 replay P99 `0.012155s`，外部写锁 `1.136343s` 后拒绝，事件循环在约 `1.125032s` 等待中持续调度；前序 10 轮定向压力也全部通过。测试 wheelhouse 为 20 个文件，lock SHA-256 `2761fda33970336dcca73c7cf1e82e1c0a0d045a89c23fef0b3b70549b87c32e`、manifest SHA-256 `dc97563ccaf172ba3ac0bcaf2c8d604f490aa295ee9c8c369b7a390ee4291ede`；它只证明本地 macOS arm64 闭包，生产 Linux/ABI 仍必须重新构建验签。release verifier 核对 59 个 ESM 模块/339 条本地边、63 个画布文件/1,759,226 bytes 和 54 个 backend/video runtime 文件；Phase 0 SHA-256 为 `da2c4988006a541cb2706e11c1232d63b6ecf27c3a1c34613ae66a6e2bbd4b53`，runtime manifest SHA-256 为 `d6a473d8f269b74934704804f889b53560d4e00a274e5d818308fc8974ae6c2d`。
- 一份较早的本地 v120 只读副本完成生产形态数据库演练：7,044 条历史文档、65 名成员、72 条成员申请、52 条供应商账号绑定和 884 条供应商活动均未减少，`quick_check=ok`；80 个平台账号、58 名已捕获成员和 4 个供应商完成 ACG 映射。资源 scope 自动确定 7,039 条，5 条经“v120 尚无外部团队、全部既有历史资料归 ACG”的既定迁移边界逐条复核后达到 7,044/7,044、歧义 0、未解析 0；第二轮 schema/ACG/resource apply 均为零写幂等。该旧副本没有约 15 GB 真实媒体，media preflight 因缺根目录、缺文件和缺 owner 正确阻断，未伪造文件强行通过；正式部署必须对当前线上完整冻结快照重新生成实数与 override，不能复用上述旧结果。
- 前序本地 8787/8765 曾以标准 `start.command` 通过主服务 `/api/health`、sidecar `/api/health` 与 `/api/ready`，当时 release 为 `20260804-v140-failed-generation-terminal-1`。本轮新 release 必须在最终提交后重新健康检查，不得复用前序证据。
- 2026-08-03 对生产仅做固定、非交互只读核对：线上仍为 v120，活动目录 `/data/dumate-studio/current` 是实体目录，业务库与约 15 GB 持久媒体仍与现行代码共同位于该树内；本轮没有改动服务器、数据库、文件、服务、账号或私密配置。
- 部署线程已在目标 Ubuntu 证明 `6767129` 的三套 Linux wheelhouse、install-check、无私密主服务/sidecar 全量与 64/128 receipt 门禁通过，但 complete snapshot 在现网 Nginx sites-enabled 与 Hugging Face 内部 symlink 形态上正确失败，因此未进入冻结、迁移、切换或重启。进一步生产只读扫描确认：除 model-cache 外的全部 complete 目录组件 symlink 数均为 0；model-cache 只有 4 个 symlink，全部解析到同一组件根内普通文件，越界、dangling 和内部非普通文件均为 0。因此不需要把解引用扩到 uploads、composed、画布、视频 runtime 或 BGM。本轮修复后必须从新唯一提交重建洁净 release，在生产形状重做 create→verify→restore-drill；本地回归不代替该证据。
- `927bd29` 在目标 Ubuntu 已继续通过三套 wheelhouse、无私密全量、64/128 receipt、complete snapshot 和前六步迁移；第七步证明五类媒体 6,713 个文件的路径、大小和内容完全一致，但恢复副本中 6,688 个纳秒 mtime 最多漂移 120ns，故 approved media-preflight 正确阻断。本轮为此补充五类媒体 create→verify→restore→live digest 闭环及 1ns 舍入失败测试；生产仍未 apply，修复后须从新提交重新执行完整演练。
- 本轮定向 snapshot/private-media/release 测试 `43/43` 通过；独立 detached 工作树在无 `.env*`、`env -i`、CPython 3.12.13 和已验签 20 包测试 wheelhouse 中完整收集主服务 `692` 项，`691` 项通过，唯一跳过仍是批准的旧 v120 只读快照项。release verifier 核对 59 个 ESM 模块/339 条本地边、63 个画布文件/1,759,226 bytes 和 54 个 backend/video runtime 文件。更新后的 Phase 0 SHA-256 为 `55e191c27b5b05ed2760f5f72c2a29e0bdf7e07e10fa6e0419f5902b3840f9eb`，runtime manifest SHA-256 为 `9cfba923d0579465101637ef46656f33657df261800efca0a8d77270f1986202`。
- 失败终态修复新增可执行回归：11 条真人/数字人旧等待任务及关联 queued job 全部一次性归一为 failed，二次刷新零变化；只有 pending 可自动生成，failed job 不参与队列或恢复。当时统一缓存/release 身份为 `20260804-v140-failed-generation-terminal-1`。独立无 `.env*` detached 工作树的主服务锁定全量为 `692` 项收集、`691` 通过、唯一批准快照项跳过；视频工坊 `137/137`、Node `100/100`、改动 JavaScript 语法和 release verifier 均通过。最终闭包为 60 个 ESM 模块/342 条边、63 个画布文件/1,759,226 bytes、54 个 backend/video runtime 文件/2,594,597 bytes；Phase 0 SHA-256 为 `2228814d9080f1f80805cef8ec8986743b25901babc6a0b887310d152c3674c0`，runtime manifest SHA-256 为 `c1ec0008e0478d02e4aea132f7b3012aa6ba121028ac3d80c94acc5c519e8e05`。
- 本轮 hydration/compose 候选在独立 detached 工作树、无 `.env*`、CPython 3.12.13 与验签 20 包测试 wheelhouse 中完整收集主服务 `696` 项：`695` 通过，唯一跳过仍是批准的旧 v120 快照项；视频工坊 `137/137`、Node `109/109` 通过。两个并发标签页只执行一次 render、只产生一份成片和一条媒体归属，失败后第二次请求可重试，成功重放复用同一 URL，不同 owner 分别隔离。`140005` 精确 apply 第一次 `appliedVersions=[140005]`、第二次零写，readiness `ok=true`、dirty=0。应用 `140005` 后再用生产当前 `9e8aeb5` 代码执行 production/validate/read-only 的 `database_readiness()` 与 `_ensure_db()` 均通过，SQLite 文件前后 SHA-256 同为 `47902a4ee70a972a68f03806086cb1f34375fcf1f9b6e96afb59290f266e33fb`，证明 extra success ledger/table 不破坏只读前向回滚。最终闭包为 60 个 ESM 模块/342 条边、63 个画布文件/1,759,226 bytes、54 个 backend/video runtime 文件/2,612,253 bytes；Phase 0 SHA-256 为 `887e186b8c0dcf66d76d2336f4735d9c9239f20e0b59468801ba2146898605fa`，runtime manifest SHA-256 为 `5d86b5a728b575d2d83c59c6111145aae485cab564b7ee9b75aea110f12bac9c`。
- 本轮供应商交付媒体/成片发布候选在新的干净 detached 工作树中以无 `.env*`、`env -i`、CPython 3.12.13 和验签离线 wheelhouse 复验：主服务收集 `697` 项，`696` 通过，唯一跳过为获准的旧 v120 只读快照；视频 sidecar `139/139`、Node `111/111` 通过。主服务 20 包测试锁与 sidecar 37 包运行锁都通过 `--no-index --no-deps`、exact-installed 和 `pip check`；发布端对所有改动 JavaScript 做语法检查，Python compileall 通过。供应商 parent/已绑定 child、未绑定 child、跨 team、交付外媒体、Range、写权拒绝、本站绝对 URL/伪造外域以及图片/视频真实 ZIP entries 均有可执行回归。最终闭包为 60 个 ESM 模块/342 条本地边、63 个画布文件/1,759,226 bytes、55 个 backend/video runtime 文件/2,621,863 bytes；Phase 0 SHA-256 为 `dc26b5f51ac69e2c004686d3f03e0cfa90c25808788ff821f35eac0fd5d29ac9`，runtime manifest SHA-256 为 `ca1853fd2112331c9bd4e3c1bdac069ef53bb3925161ee6f54a729f04d59a6af`。
- 本轮视频工坊滚动候选新增两条 Node DOM 门禁：发送路径不能出现消息元素定位调用，且只把 `.conversation-column` 平滑滚到底部；轮询重绘对历史阅读位置精确恢复 `scrollTop`，接近底部才自动跟随。CPython 3.12.13 按 37 项 sidecar lock 离线 `--no-deps` 安装并通过 `pip check` 后，视频工坊 `139/139`；Node 全量 `113/113`、相关主服务/发布契约测试 `72/72`、全部改动 JavaScript 语法检查和 release verifier 均通过。统一缓存为 `20260804-v140-workshop-scroll-1`；闭包仍为 60 个 ESM 模块/342 条边、63 个画布文件/1,759,226 bytes、55 个 runtime 文件/2,622,600 bytes，Phase 0 SHA-256 为 `4855256a67b2389e8caf4813e7a43928329d2faa347bfc90178e518cc6b4e182`，runtime manifest SHA-256 为 `95ed3be8ae3ae2f2d337adcb36fdfb188ff8e98ef82fdcc6288c4da90e028238`。该证据未连接生产，目标 Linux 仍须从最终推送 SHA 重建并验签。
- 本轮最终候选统一缓存/release 为 `20260804-v140-usage-settlement-1`。最终独立干净检出无 `.env*`、CPython 3.12.13、验签 20 包离线测试 wheelhouse 中收集主服务 `707` 项：`706` 通过，唯一跳过仍是批准的旧 v120 只读快照；新测试覆盖 succeeded/unknown 两类结算、精确 unresolved 集合、中央/sidecar 哈希冲突整批回滚、不可变触发器、同计划新备份二次零写和 `140007` 对旧 `140006` 只读 schema 的加法兼容。视频 sidecar `139/139`、Node `117/117`、改动 JavaScript 语法与 Python compileall 通过；未触发任何 provider 或付费生成。最终发布闭包为 60 个 ESM 模块/342 条边、63 个画布文件/1,759,226 bytes、56 个 backend/video runtime 文件/2,701,817 bytes；Phase 0 SHA-256 为 `f1ef29137a01f2f0afa2b5c0a473d056005acd0002194cdebe1c692b35f94c89`，runtime manifest SHA-256 为 `a732b2cc8c9a729fd1a56099c924f657d1f728ce5149fac0aa6b316b24f85c6c`。本轮未用新 release 重启本地 8787/8765；前序浏览器 UI 验收仍属于 `f642571`，不能冒充本提交健康证据。
- 生产当前仍在受保护只读维护态。部署线程已在 `f642571` 完成 `140005`、`140006`、complete snapshot/restore 和 media settlement 双跑，`quick_check` 与受保护数据门禁通过；9 条模型用量 unresolved 是唯一已知 RW 阻断。本候选只允许 fresh backup 双跑 `140007`，随后使用 fresh complete snapshot、逐条 reviewed plan 和每次 fresh backup 双跑 `usage-settle`；首次 unresolved/outbox=0、第二次零写后才可重新运行 RW write gate。不得重跑既有迁移、调用 provider、猜补 Token 或覆盖生产数据/媒体。
- 本代码线程没有连接、修改或开启生产 RW；候选完成本地实现和验证后才可推送给部署线程从干净提交重建 Linux 物料。部署必须以 systemd 实际运行 release 为代码真源，不能依赖已证明可能滞后的 `/data/.../current` 目录。两份 Project Memory 与 `logo.png` 的归属未知删除继续排除。

## v139 - 2026-08-03（统一模型用量持久凭证与副本恢复工具；本地代码 `7b6e36c`，未推送、未部署）

### 本版范围

- 新增 `139001` (`v139-model-usage-receipt-outbox`)：每次真实上游尝试都在调用前持久化独立 receipt，主服务 LLM/视觉文案/图片/Seedance/数字人/TTS/音色/供应商助手、无限画布 Agent 与图片链路、视频工坊导演/图片/TTS/Seedance 全部接入；重试和降级使用 `:attempt:N`，幂等重放不会二次授权上游。
- SQLite 完成写失败不再静默吞掉：精简、去敏的 completion envelope 先写 `MODEL_USAGE_COMPLETION_SPOOL_DIR`（默认 `DATA_DB` 同级 `model_usage_spool`），后台循环重放 spool 与 legacy projection outbox；`/api/ready` 显式报告 unresolved、outbox pending、spool pending/corrupt/conflict。供应商已接受但本地解析、下载或 resize 失败仍按已调用完成记录，不误降为“未知”。
- 视频工坊使用主服务核验 owner/member/team 的 receipt bridge，并把项目保存改成临时文件 fsync、原子替换和目录 fsync；项目轮询对已投影终态采用只读精确查找，避免每次刷新重复抢 SQLite 写锁。无限画布浏览器端供应商 Key/直连路径已禁用，所有模型调用统一经过主服务。
- 新增 `server/model_usage_recovery.py` 历史恢复工具：只从只读、immutable/query-only 的生产副本及 runtime 形成证据下限 manifest；只允许对独立目录中的数据库副本执行 `scan -> apply -> reconcile-copy`，拒绝活动库、同目录副本和生产持久根。无法证明的导演 token、日期或调用次数不估算，不把 observation 冒充供应商账单。
- 设置页用量增加调用数、图片/视频/语音、token 未知调用及未决凭证展示；旧 `llm_usage_events` / `api_usage_events` 保持原样，通过 outbox 幂等投影。生产 v120 尚未获得这些能力，历史 824 / 1,186 行也未被改写或回填。

### 性能、验证与发布边界

- 本地临时 SQLite 压测 64 路唯一调用典型 P99 约 200ms、最坏样本 689ms；128 路典型 P99 约 475ms、最坏 743ms，均 0 异常、唯一数和授权数准确。外部长写锁约 1.06–1.08s 后 fail closed，期间不持有 `store._lock`，异步入口通过 `asyncio.to_thread` 保持事件循环可调度。生产同盘副本仍必须暖库连续 5 轮；64 路 P99 >750ms、128 路 P99 >1s、单次 >1.25s 或事件循环 P99 间隔 >100ms 均阻断部署。
- 最终自动回归通过：主服务 `618/618`、视频工坊 `137/137`、Node `97/97`；Python compileall、全部 JavaScript 语法、无限画布 lint/typecheck/生产构建/vendor 校验和 `git diff --check` 通过。完成写失败的画布测试已隔离补偿队列，假凭证不会再进入本地运行目录。
- release verifier 通过 59 个 ESM 模块/339 条本地边、63 个无限画布文件/1,759,226 bytes 和 48 个 backend/video runtime 文件；最终 Phase 0 SHA-256 为 `539b9657d401eb076edd0fd722f0907ece33aec7d45ec69c4de0e1dbe41641c5`，画布 manifest 为 `5f30a760868603d79727d7ed9af472ce15a7e304afaf31833dd50f7f8cfbaa7d`，runtime manifest 为 `b17813006dbfb51b42c33bae71611ce1139affec79fdcb0830adad4da029d0f6`。
- 本地 8787/8765 已以标准启动器重启，主服务 `/api/health`、sidecar `/api/health` 与 `/api/ready` 全部通过并回报 `20260803-v139-durable-usage-1`；本地 readiness 为 migration `139001`、unresolved/outbox/spool pending/corrupt/conflict 全为 0。
- 本轮没有真实图片、语音或视频付费调用；没有向生产执行恢复、迁移、回填或任何写入，也未推送、未部署。两份归属未知的 Project Memory 删除继续排除。下一轮即使获部署授权，也必须先在生产一致副本验证迁移、恢复、receipt 性能和权限/媒体门禁，不能直接同步当前工作区。

## v138 - 2026-08-03（默认首页、灵感详情白条与生产模型用量审计；本地代码 `844039a`，未推送、未部署）

### 本版范围

- 主启动器默认打开 `#/home`，入口初始 zone 同步为 home；供应商登录后的专属路由不变。首页灵感/整体资产收藏详情继续沿用 v137 的“点击后有声播放、桌面左侧媒体固定、右栏独立滚动、右上角纯图标点赞收藏”，并移除详情头部 sticky 白色渐变条。
- 主平台、供应商视图和视频工坊抬升到统一 release/缓存身份 `20260803-v138-home-usage-audit-1`，避免一年 immutable 缓存继续返回旧 CSS；runtime manifest 已按最终源码重建。浏览器已实际从根地址进入 `#/home`，打开指定灵感详情并确认白条消失、分类和纯图标操作保持在右上区域。
- 生产仅做固定、非交互只读核对：SQLite `quick_check=ok`；`llm_usage_events` / `api_usage_events` 共 824 / 1,186 行并在前后日期持续写入，但北京时间 2026-08-02 两表全平台均为 0。指定 editor 在 2026-07-31 有成功视频工坊项目（80 条事件、1 个最终输出、3 条平台输出映射）而两表历史均为 0，证实视频工坊调用真实漏记；没有证据支持把该成员的使用日期写成 8 月 2 日。
- 根因是视频工坊 sidecar 直接调用 LLM、图片、TTS 和 Seedance，却没有中央 usage bridge；v137 `billingUsage` 只结算静态视频积分。主服务 TTS/音色、`role=user` 汇总和 SQLite 写失败持久重试也未完整覆盖。因此当前面板是有限覆盖的事件账本，不是供应商账单；本版没有伪造或回填任何历史 token/调用。
- 架构复核结论：v137 已完成环境/持久路径隔离、显式 `137003/137004` 迁移、强制只读、readiness、release verifier 和一致 SQLite 备份等 Phase 0/1 安全层，但 `server/main.py` / `server/store.py` 仍是大单体。生产写入继续被 deny-by-default 资源 scope、媒体 owner registry、迁移与备份 manifest 原子绑定、完整媒体恢复/离线依赖，以及幂等 usage receipt/outbox 阻断。

### 验证与发布边界

- 最终自动回归通过：主服务 `557/557`、视频工坊 `132/132`、Node `97/97`；Python compileall（缓存定向到 `/private/tmp`）、改动 JavaScript 语法、shell 语法、`git diff --check` 和暂存后的 `git diff --cached --check` 均通过。
- release verifier 通过 59 个 ESM 模块/339 条本地边、61 个无限画布文件/1,761,292 bytes 和 46 个 backend/video runtime 文件；Phase 0 SHA-256 为 `8c94aced2b2b9f98fb5b81ee8d8f53d5344ff113f5cf932fee150ba56a2b54d9`，runtime manifest SHA-256 为 `e69927ddb3ac4496ecd0f5e93d77911d36a3cdaabdbcc168dedd24336a3e6f40`。
- 本地已以标准启动器重启 8787/8765；主服务 `/api/health`、`/api/ready` 与 sidecar `/api/health` 均通过并回报同一 v138 build ID。Playwright 冷启动确认根地址自动落到 `#/home`，详情截图保存在 `output/playwright/v138-final-home-detail.png`（运行证据，不入 Git）。
- 本轮未执行真实图片、语音或视频付费生成，未推送、未部署，也未修改生产数据库、生产文件、服务、账号或私密配置。两份归属未知的 Project Memory 删除继续排除。
- 下一步不能直接把当前主工作区同步到服务器。获得部署授权后应从批准提交构建干净 release，冻结全部 writer，形成同一 snapshot ID 的 SQLite/媒体/环境/认证/systemd/Nginx/依赖恢复集，在同环境副本连续演练迁移与 usage reconciliation 两次，再做只读切换；执行 `137003/137004` 后原始 v120 不能作为回滚代码。

## v137 - 2026-08-03（架构隔离、静态任务引用安全与灵感详情收口；本地代码 `52e3d72`，未推送、未部署）

### 本版范围

- 修复同一视频工坊项目跨任务串参考图：每次接受的生产计划获得独立 `reference_scope_id`，连续性 anchor 文件名绑定该 scope；旧计划使用计划内容的 SHA-256 身份回退，不再命中项目级 `continuity-anchor-NN.jpg`。导演上下文也从最近一次助手交付边界后开始，同一任务恢复/重试仍复用自身 scope。已生成的错误成片不会自动改写，修复作用于后续新任务。
- 首页灵感和整体资产收藏详情的视频改为用户点击后有声播放，卡片悬停预览仍保持静音；桌面详情固定左侧媒体，长标题/文案仅在右栏滚动，窄屏恢复自然页面流。点赞、收藏统一放到右上角，以纯图标、辅助标签和选中颜色表达状态。
- 在不改现有 8787 主服务、8765 回环 sidecar、无限画布源码/静态闭包边界的前提下，增加部署安全层：外部环境在 store import 前解析；生产普通启动 validate-only；主服务/sidecar 服务端强制只读；`/api/ready` 精确核验 release、SQLite、迁移、持久路径、sidecar 契约与画布 manifest；release verifier 校验 ESM、画布和后端/视频运行闭包。
- schema 与 ACG 数据迁移改为独立 CLI、独立授权和 version/checksum/status 账本，最终编号为 `137003` 与 `137004`。本机早期中间构建已写入旧 `137001` checksum，因此没有覆盖、删除或放宽校验，而是顺延正式版本；`137001/137002` 明确退役。
- 发布入口只接受 release 外的既有持久路径，并增加 SQLite online backup 的 `quick_check`、大小、SHA-256 与 fsync 验证；Docker/runtime 采用精确文件闭包。统一 release/缓存身份为 `20260803-v137-architecture-isolation-1`，无限画布仍为 61 文件、`1,761,292` bytes。

### 自动验证与本地运行

- 最终自动回归通过：主服务 `557/557`、视频工坊 `132/132`、Node `97/97`；社区服务端专项 `11/11`，迁移/备份/部署/release 定向 `56/56`。改动 JavaScript 语法、Python compileall、shell 语法和 `git diff --check` 均通过。
- 无限画布 `npm run lint`、`npm run typecheck`、`npm run check:vendor` 通过；release verifier 核对 59 个 ESM 模块/339 条边、61 个画布文件和 46 个后端/视频 runtime 文件通过。最终 Phase 0 SHA-256 为 `0492069a8157966b47e069fc15f870c8dd3f15dc7a088238e00ea52e74a3c711`。
- 启动前对本地 SQLite 创建了一致备份并通过 `quick_check`/SHA-256；随后以当前源码启动 8787/8765。主服务 `/api/health`、`/api/ready` 与 sidecar `/api/health` 均返回通过，readiness 同时如实报告仍阻断生产写入的租户/媒体 scope 缺口。
- 未执行真实图片、语音或视频付费生成，也未完成本轮浏览器视觉验收。用户需重点手验：先做带附件任务、再在同一项目做无附件任务确认不串图，以及首页/收藏详情的有声播放、固定媒体、右栏滚动和右上角点赞收藏状态。

### Git、服务器与部署边界

- v137 功能与安全代码已精确提交为 `52e3d72`；版本与迁移记录由后续独立文档提交固化。两份归属未知的 Project Memory 删除未恢复、未暂存、未带入提交；当前未推送、未部署。
- 生产事实沿用本轮前段的固定只读盘点。最终收口阶段未主动发起新的远端命令；发现并终止此前只读盘点遗留的本机 SSH/expect 进程，未修改服务器、生产数据库、生产文件、账号、媒体或私密配置。
- v137 仍不能直接执行生产迁移或开放写入。P0 阻断为：通用管理员资源 scope 尚未全面 deny-by-default；uploads/composed 缺完整 owner registry 与历史直链授权；迁移 apply 尚未在同一事务内绑定已验证备份 manifest 与当前库逻辑摘要；完整媒体异机恢复演练和目标环境离线依赖锁尚未完成。下一轮即使获得服务器操作授权，也只能先收口这些门禁并做只读副本预演。

## v136 - 2026-08-03（本地代码收口：功能提交 `03882da`；未推送、未部署）

### 本版范围

- v136 功能代码已在 `0e9d144` 之上形成本地提交 `03882da`；本节审计记录由后续独立文档提交固化。均未推送、未部署，本轮未连接或修改生产服务器、数据库、账号、媒体或私密配置。
- 社区分享改为“同一作者 + 服务端核验的规范化来源身份”：视频工坊的项目/输出、无限画布的项目/图片和发布清单的原始 provenance 可跨不同物化 URL 复用同一帖子；无稳定来源的旧记录才回退到规范化 URL。作者+来源别名在 `BEGIN IMMEDIATE` 事务和唯一约束下写入，独立 SQLite 连接并发提交也只形成一帖；旧 URL-only、旧身份字段和软删除残留别名继续兼容。
- 首页灵感改为四列密排，并按真实媒体尺寸回填卡片高度；详情页以单一自适应媒体舞台展示图片/视频，视频可使用帖子的封面，多个媒体通过缩略图切换。
- 静态视频按口播语义和导演节拍细化分镜。约一分钟且语义充足时通常可规划 12 张以上，短口播允许更少，3–5 秒只是软节奏而非精确时长约束；每镜带附件归属、全片统一风格和负约束，画面保持中心、连续、单调慢速放大。场景图与连续性参考图在真实 provider 调用处共享三路上限；动态 Seedance 和动态插图运动链路不变。
- UI 随本版收口：移除无目标的全局“分享灵感”入口，只保留有明确媒体来源的三个入口；视频工坊使用与首页一致的眨眼小星头像并保留 sidecar fallback，语音按钮伪元素蓝底泄漏已修正。整体资产的 BGM/剪辑素材切换只有源码烟测，仍待用户手动视觉确认。
- 缓存身份集为：主平台与视频工坊 `20260803-v136-community-static-1`，供应商共享视图 `20260803-v136-supplier-shared-1`；无限画布继续使用已审计的 61 文件、`1,761,292` bytes manifest 闭包。

### 验证与发布边界

- 本轮最终自动验证：主服务 `495/495`、视频工坊 `126/126`、Node 唯一用例 `96/96`；其中社区专项 Python `21/21`、JS `10/10`，静态导演/并发 `48/48`。无限画布 lint、typecheck、vendor 闭包校验通过（61 文件、`1,761,292` bytes）；改动 JavaScript 语法、Python 编译、`git diff --check` 通过。
- 本地主平台 `8787` 与视频 sidecar `8765` 均以当前源码启动并返回 200 健康响应，检查后已停止。未执行浏览器视觉验收、真实社区发布、图片/语音/Seedance 付费生成、Git 推送或部署；功能提交 `03882da` 由 51 个精确审计路径形成，两份归属未知的 Project Memory 删除未暂存、未带入。
- 静态视频最终单张失败仍可能取消同批兄弟任务，expanded scene 的 partial retry/收尾与真实高对比 FFmpeg 帧位移烟测保留为 P2，不能描述为已完成。
- 生产迁移仍被 fail-closed 数据库路径、显式迁移账本、只读维护、租户鉴权、备份恢复演练、兼容回滚、依赖锁定及 `/api/ready` 门禁阻断；`/api/health` 不能替代这些核验。

## v135 - 2026-08-03（本地发布候选与安全收口：代码与静态闭包 `88a0460`；未推送、未部署）

### 本版范围

- `61346a4` 是 v123–v135 的功能快照；安全遗留处理、无限画布静态闭包和视频工坊头像修复已在本地形成代码闭包提交 `88a0460`。本节文档由后续独立提交记录；两次提交均未推送、未部署。
- 功能基线仍以 v134 的静态视频、终态计费、社区资产、团队鉴权和无限画布可靠性为准。静态视频继续独立于 Seedance，按语义及存在的口播自然拆分，只要求整体时长大致合理，不建立精确时长约束，也不强制用户提供或生成口播。
- 新增 `docs/本地代码架构优化与服务器迁移部署方案.md`，明确保留主平台、视频 sidecar、无限画布源码/静态闭包三类边界，并将后端拆分、正式迁移账本、`/api/ready`、关键写终态、持久任务和 release manifest 分为 P0/P1/P2 实施。
- 固化生产 v120 形状向本地功能基线迁移的 expand-contract 方案：只做稳定 ID 的增量归属，不改变既有凭据、供应商父子关系、业务记录或媒体路径；继续按冻结写入、完整备份、同环境副本连续演练两次、数据计数和文件清单不下降、角色与租户矩阵通过后再切换。
- 工作树按来源和运行依赖完成安全收口：恢复当前客户端清单仍引用的 `0.2.0` macOS DMG 及两份 Project Memory；删除未跟踪的飞书认证二维码和三个 `*-chroma.png` 品牌中间图；保留用于隔离 `服务器详情.md`、`服务器数据/` 的 `.gitignore` 数据保护规则；接受已被正式品牌 PNG / 当前架构文档替代的旧 `favicon.svg` 与两份旧方案删除。全程禁止 reset、clean、全量 stash、`git add .` 或为追求空状态而删除未知遗留。
- 无限画布改为从源码构建并经可恢复的审计同步形成静态闭包，生成 `vendor/infinite-canvas.manifest.json`：共 `61` 个文件、`1,761,292` bytes，manifest 为每个相对路径记录大小和 SHA-256；不再把多个历史构建哈希拼在同一发布目录。
- 修复视频工坊嵌入主平台后的 Agent 头像 404：动态脚本使用 `/assets/xingzhen-logo-white.png` 时会越过 `/custom-video/assets/` 映射，现改为子应用相对路径 `assets/xingzhen-logo-white.png`，并同步修正页面品牌图及缓存标识。

### 审计与验证

- 本地代码审计确认 `server/main.py` 与 `server/store.py` 均接近 9,000 行，当前约 134 个主服务路由；启动阶段仍有隐式 schema / 数据修复，`DATA_DB` 错配或持久卷未挂载时还可能静默创建并初始化空库，且尚无正式 `schema_migrations` 与 `/api/ready`。这些均是未完成的生产 P0 门禁，架构审计结论为：**当前 v135 禁止生产部署**。
- 公网主入口与健康接口只读探针返回成功，但健康响应不包含发布版本、数据库或迁移状态；SSH 非交互只读探测未取得内部状态，因此不能把生产内部版本、SQLite、sidecar 或团队映射描述为已实时确认。
- 本轮本地收口实际重新执行并通过：视频工坊运行时 `6/6`；无限画布队列、集成、草稿与持久化 Python `67/67`；主平台工作区、画布布局和供应商路由 Node `44/44`；无限画布 `npm run typecheck`、`npm run build:embed`、`npm run sync:vendor`、`npm run check:vendor`。同步后的 vendor 与 manifest 闭包一致，`git diff --check` 通过。
- 本地主平台 `8787` 与视频 sidecar `8765` 健康接口均返回 200；从主平台请求 `/custom-video/assets/xingzhen-logo-white.png` 返回 `image/png`、`45,290` bytes，证明嵌入头像路径已恢复。以上是自动回归和实时接口检查，不等于浏览器视觉验收或用户手动验收。
- `61346a4` 功能快照形成前记录过的主平台 Node/UI、主服务 Python、完整视频工坊与其他大回归属于该快照的历史证据，本轮没有重新执行，不能冒充本轮验证结果；当前也没有重新进行付费生成、浏览器视觉验收或用户手动验收。
- v134 已通过的静态复杂意图 `30/30` 与真实静态媒体 `10/10` 是上一版历史证据，本轮没有重复付费生成、浏览器视觉验收或用户手动验收，不能把历史结果误报为本轮重新执行。静态视频时长继续只是由语义和既有口播自然规划的软目标，允许合理误差，不增加精确时长或强制口播约束。

### Git、数据与部署

- 功能快照为 `61346a4`，代码与静态闭包提交为 `88a0460`；61 文件无限画布闭包 / SHA manifest、视频工坊头像路径修复和经确认的安全遗留处理均已本地提交。本轮不推送、不部署，不修改生产数据库、服务器文件、环境变量、账号、媒体或私密配置。
- 恢复 DMG 与两份 Project Memory 只是撤销归属未知且仍有引用的本地删除；认证二维码和 chroma 中间图确认不被运行或构建引用后已从本地清理且未进入 Git；`.gitignore` 的服务器详情 / 数据目录保护继续保留。被当前 PNG 品牌资源和正式架构文档取代的旧 favicon 与两份旧方案删除，已随 `88a0460` 精确提交。
- **当前 v135 不得部署生产。** 即使后续获得部署授权，也必须先提交并锁定审计源、完成正式迁移账本与 fail-closed 数据库路径检查、实现 `/api/ready`、在同环境生产副本演练迁移，并重新取得线上 commit、缓存标识、systemd / worker、SQLite、团队 / 供应商映射和受保护目录基线；不能只凭 `/api/health` 或本轮定向测试升级。

## v134 - 2026-08-02（静态视频稳定性、终态计费、社区资产与画布闭包收口，本地待手动确认）

### 本版范围

- 静态视频保持独立图片分镜链路，不进入 Seedance 队列；单张画面改为全镜头连续、居中、单调慢速放大，并使用高分辨率缩放与稳定偶数像素裁切消除抖动。分镜时长继续按口播和语义自然拆分，只要求整体时长大致合理，不增加精确时长或强制口播约束。
- 补齐动态与静态视频的任务级积分闭环：有限额度账号先原子预占，动态视频在成功终态按提交模型与归一化请求时长对应费率结算，静态视频按本轮新生成图片及存在且本轮新生成的 TTS 实际用量结算；失败、取消和中断释放预占，重复提交、轮询和终态回调保持幂等。ACG 市场部继续精确走无限积分旁路，不误扣个人或订阅钱包。
- 首页灵感发现接入真实社区与个人收藏夹：视频工坊、无限画布和发布清单可主动分享，已分享操作恢复后置灰；团队所有者 / 管理员可代分享团队作品但保留原创作者和团队署名，普通成员只能分享本人作品。社区详情支持点赞、收藏、视频封面与静音悬停预览、多图和长文，瀑布流按原始尺寸紧密吸附；收藏按个人隔离并进入整体资产。
- 整体资产按身份收口：草稿箱前置；普通个人只看本人视频、图文、语音和收藏，不显示团队账号标签；专业版 / 团队版保留账号筛选，BGM 与剪辑素材合并为后台素材。发布清单补齐视频预览、多图完整展示和长文滚动。
- 无限画布十张批量生成继续限制最多三路并发，每张成功图先写 owner-scoped Blob 再 checkpoint；刷新、499、413、超时和旧 `loading / thinking` 均有确定中断终态，混合成功 / 失败不会永久旋转或自动重新计费。当前源码通过类型检查与嵌入构建，构建输出以不删除方式同步到 `vendor/infinite-canvas`，输出路径内容校验一致，历史多余静态哈希仍原样保留。
- 主平台、共享模块、无限画布嵌入入口和视频工坊静态入口统一缓存标识为 `20260802-v134-static-community-1`；供应商专用模块继续保持独立路由和数据边界。

### 自动验证与真实静态媒体测试

- 静态复杂意图回归 `30/30` 通过；真实图片生成、口播与 MP4 渲染 `10/10` 成功。真实媒体批次使用默认并发 2、硬上限 3；另以 3 个不同类型启用账号完成批量选择与独立静态 Agent 路由回归，未把该路由检查误报为三个账号各自重新付费渲染。
- Node 首页、团队、社区、订阅、供应商、工作区和布局回归 `86/86` 通过；无限画布队列、草稿、持久化和主平台集成回归 `67/67` 通过。最终 Python 定向回归 `265/265` 通过：配额及动态 / 静态结算 `38/38`、视频工坊 sidecar `120/120`、团队 / 供应商 / 社区安全 `107/107`；仅出现一个不影响断言与退出码的测试事件循环 `ResourceWarning`。
- 无限画布 `npm run typecheck` 与 `npm run build:embed` 通过，静态输出为 61 个文件、约 2.2 MB；源码 `out/` 与运行时 vendor 对应文件的 checksum dry-run 无差异。`git diff --check` 通过。
- 本轮按用户边界没有执行浏览器视觉验收、Seedance 真实生成、真实社区发布、Git 提交 / 推送或服务器部署。最终页面视觉仍由用户手动确认；本地 `8787` 健康探针因主服务未启动不可用，`8765` sidecar 健康接口为 ready，未把离线端口误报为健康。

### 数据、Git 与部署

- 当前仍在 `codex/v122-team-auth-home`、提交 `1e0a857` 之上的本地主工作树开发；既有未知删除、认证缓存、运行态目录、本地素材和 vendor 历史残留全部保留，没有 reset、clean、删除式同步、整体暂存或提交。
- 本版只允许未来部署审计后的代码与静态闭包。生产团队迁移继续执行已记录方案：冻结写入并完整备份，在同环境生产副本连续演练两次，保留管理员凭据，将 `admin` 映射为 ACG 所有者、其他管理员映射为团队管理员、既有创作者与供应商资源归入 ACG，完成保护计数、`quick_check`、角色登录和租户隔离核验后再开放写入。本轮未连接或修改服务器。

## v133 - 2026-08-02（鉴权、租户隔离、社区分享与服务器迁移演练，本地待手动确认）

### 本版范围

- 将版本、问题、部署和交接记录统一归入产品目录下的 `docs/`，保留 `运行与架构说明.md` 作为项目根目录的当前事实入口；同步更新文档间路径、定向阅读规则和服务器部署快照，不改变业务代码或生产环境。
- 重新收口游客、个人账号与团队权限：游客直接进入首页，真正创作时再打开登录 / 注册弹窗；左下角游客操作显示“登录”。新注册用户名按去空白、大小写不敏感规则全局去重，注册成功后直接成为个人用户。个人账号使用中国时区每日 70 点、当日清零且不累计；模型调用采用原子预占、成功结算、失败释放和请求幂等，ACG 内部团队及已加入团队的成员不走个人每日钱包。
- 完成团队生命周期边界：个人用户可搜索现有团队并提交加入申请，团队所有者 / 管理员收到红色高优先级通知并审核；外部付费团队可由受信任的订阅成功回调原子建立团队与所有者，所有者可在团队管理中改名。ACG 市场部名称、无限积分和无限席位保持受保护状态，前端方案预览不能冒充支付成功。
- 资产与账号读取统一按 `owner + team` 隔离：个人只看自己的产出，外部团队只看本团队，ACG 可兼容读取部署前既有管理员、创作者、供应商、平台账号、资产和画布数据；历史无显式租户字段的记录暂按成员 / 账号映射推导，未来新个人不会自动并入 ACG。
- 修复供应商首页和“全部账号”长期停在“正在读取”：全局供应商查询不再在持有全局非重入锁时递归调用再次加锁的团队辅助函数，供应商账号与设置请求也不再被非必要活动查询阻塞。供应商父子账号继续进入独立供应商工作区，不会落入创作者首页。
- 首页灵感发现从占位内容改为真实社区：登录用户可从视频工坊、无限画布和发布清单主动分享；社区公开列表 / 详情展示选题、文案、提示词和实际尺寸媒体，视频仅在悬停时静音预览，图片与画布产出按原始比例自适应。只允许站内持久化 URL，拒绝 Base64、临时 Blob 和外链；删除限作者、平台管理员或帖子所属团队的所有者 / 管理员。
- 再次验证无限画布可靠性闭环：十张批量生成最多三路并发，每张成功图先写 owner-scoped Blob 再 checkpoint；单张失败隔离，刷新 / 499 / 413 / 超时有确定终态，旧 `loading / thinking` 恢复为“任务已中断，可重试”，不会自动重生成或重复扣点。
- 使用临时生产形状 SQLite 完成 ACG 增量迁移演练：主管理员映射为 ACG 所有者，其他管理员为团队管理员，既有创作者为团队成员，供应商父账号、平台账号及历史资源归入 ACG；连续执行两次无重复，保护计数不下降且 `quick_check=ok`。正式服务器切换仍需维护窗、完整备份、生产副本演练和凭据不变检查，本版没有连接或修改服务器。
- 主平台、共享模块和视频工坊静态入口统一缓存标识为 `20260802-v133-auth-community-1`；供应商专用模块继续保留独立身份。当前 118 个 `/api/*` 方法与前端 68 个远程调用完成静态契约核对，没有发现前端调用缺失的当前源码路由。

### 快速烟测

- Node 首页、团队鉴权、批量 UI、订阅、供应商路由、社区分享和统一工作区定向回归 `75/75` 通过。
- Python 团队鉴权、注册与平台账号、个人积分、供应商、社区、无限画布队列 / 草稿 / 集成和模块缓存主回归 `154/154` 通过，社区越权专项 `3/3`、无限画布历史持久化函数回归 `5/5` 通过；临时迁移形状与团队供应商补充回归 `17/17` 通过。
- `git diff --check`、关键 JavaScript 语法和 Python 编译检查通过。无限画布当前只确认干净源码与自动回归，混杂的 `vendor/infinite-canvas` 历史构建遗留仍未整体同步或暂存。
- 本版没有执行浏览器视觉验收、真实图片 / Seedance / 语音付费生成、真实社区发布、Git 提交 / 推送或服务器部署；页面最终视觉与真实生成仍等待用户手动确认或单独授权。

### 数据、Git 与部署

- 当前仍在 `codex/v122-team-auth-home` 本地主链路、提交 `1e0a857` 之上的脏工作树开发态；未知删除、认证缓存、本地素材、运行态目录和混杂 vendor 遗留全部保留，没有 reset、clean、整目录覆盖或整体暂存。
- 正式部署必须只同步审计后的代码 / 静态文件，并保留服务器环境变量、凭据、SQLite、WAL/SHM、uploads、composed、canvas blobs、视频工坊 runtime 和全部历史业务数据。迁移前必须在生产副本用相同环境执行两次，确认管理员凭据哈希不会被默认配置改写，再开放写入。

## v132 - 2026-08-02（平台账号、批量图文与订阅交互收口，本地待手动确认）

### 本版范围

- 修正本地长驻旧服务造成的“读取平台账号失败：HTTP 404”。当前源码的 `/api/platform/accounts` 路由保持唯一且位于静态挂载之前；重启 `8787` 后，未登录请求稳定返回预期 `401`，不再错误落入 `404 Not Found`。
- 批量图文任务在桌面宽度下将“多图 / 单图、必填标题、填写文案、每条图数”固定为同一行；标题保持可收缩宽度，文案和图数保留稳定槽位，参考图与资产操作继续位于独立下一行。后置样式显式清除旧 `grid-area`，避免缓存或模块加载次序再次把图数推到第二行。
- 首页“动态 / 静态”模式按钮收紧为 60px，并同时覆盖桌面与窄屏规则；按钮仍保留滚轮切换、悬停解释和减少动态兼容。
- 订阅工作区的左侧上下文栏只保留“订阅方案”；加量包改为方案页内独立按钮，点击打开六档简洁弹窗。连续包月、连续包年和单月订购使用同一 DOM 原位更新与滑块过渡，卡片区域不再整块重绘或跳动；标题、说明和周期控件居中，ACG 团队权益继续独立固定在右侧。
- ACG 市场部保持第四档“团队专业版”为已生效金色方案、无限积分且不可误切换或产生付款反馈；六档加量包仅作本地方案展示，没有接入真实支付。

### 快速烟测

- Node 订阅、批量 UI、工作区、供应商路由和团队首页定向回归 `67/67` 通过；`js/main.js` 与 `js/views/subscription.js` 均通过 `node --check`。
- 主服务平台账号、注册、团队、个人额度、供应商、无限画布队列和模块缓存定向回归 `55/55` 通过；合计 `122/122`。
- 当前源码重启后的主平台 `8787/api/health` 返回 `200`；`/api/platform/accounts` 未登录探针返回预期 `401`；视频工坊 `8765/api/health` 返回 `200`。实时读取的 `views.css` 已包含首页 60px 模式按钮规则。
- 本版未执行浏览器视觉验收、真实图片 / 视频 / 语音付费生成、Git 推送或服务器部署；页面最终视觉仍由用户本地手动确认。

### 数据、Git 与部署

- 本版只修改当前本地工作区代码、样式、测试与文档；没有创建提交、没有推送 GitHub、没有部署服务器，也没有修改生产数据库、生产文件、账号数据或私密配置。
- 既有未知删除、认证缓存、运行态目录、本地素材及混杂的无限画布 vendor 遗留均保持原样，没有恢复、删除、覆盖或整体暂存。

## v131 - 2026-08-02（游客账户、个人积分与无限画布可靠性收口，本地待手动确认）

### 本版范围

- 新用户可先以游客身份进入首页，在真正发起创作时再打开登录 / 注册弹窗；注册暂不要求验证，但用户名会先去除首尾空白并按大小写不敏感规则检查。旧库若已存在大小写冲突账号仍按稳定规则兼容读取，后续注册、改名、待审核转正和供应商子账号创建都会事务内阻止新冲突。
- 个人账号使用中国时区每日 70 点且不累计。主图片、无限画布生成 / 增强 / 局部编辑 / 定向编辑、TTS 与音色设计接入原子“预占 → 成功结算 / 失败释放”闭环，幂等键同时绑定请求摘要，避免并发超扣和重复请求换内容；ACG 内部团队及其他团队成员继续绕过个人额度。异步视频任务因尚无稳定的任务终态结算绑定和批准费率，本版不冒险提前扣点。
- 无限画布批量生成改为最多 3 路并发，其余分镜显示排队位置；每张成功图片先固化为 owner-scoped Blob URL，再完成占位并写入本地 checkpoint。单张失败不会阻塞整批，批次最终明确进入完成、部分完成、失败或中断；生成、定向编辑、高清和局部编辑统一增加取消、五分钟超时及 413 / 499 可识别错误。
- 项目首次恢复时会把遗留的 `loading / thinking` 转为“任务已中断，可重试”，不会刷新后无限旋转，也不会自动重新计费。旧内联 Base64 草稿继续兼容并在后续读写时惰性迁移为 Blob；新成图不再反复塞入几百 MB 的整体草稿 PUT。
- 外部已激活团队的所有者可显式、幂等地开通一名供应商管理员；初始密码仅在首次响应返回并使用 `Cache-Control: no-store`，后续只返回用户名，重置继续走既有受控接口。ACG 内部团队不自动创建新供应商，也不改变既有团队供应商映射；订阅页仍是本地方案预览，没有接入真实支付。
- 视频工坊内部创作模式统一显示为“动态 / 静态”，收紧浅蓝切换控件并补充小星工作态；无限画布当前项目移除前置蓝条，批量图文的模式、标题、文案与每条图数重新保持同行，头像拖入与生成音频按钮补齐反馈和动效。
- 主平台、共享模块、无限画布嵌入入口和视频工坊静态入口统一缓存标识为 `20260802-v131-guest-canvas-1`，避免刷新时短暂混入 v130 旧 UI。

### 快速烟测

- 无限画布队列 / 恢复、草稿与 Blob、画布集成和个人额度边界定向回归 `84/84` 通过；TypeScript 类型检查、Python 编译和干净隔离的 `build:embed` 均通过，隔离闭包为 61 个文件、约 2.2 MB。
- 本轮合并后的快速回归共 `191/191` 通过：Node UI / 权限 / 订阅 / 工作区 `61/61`，主服务注册、团队、供应商、成员、缓存、画布和额度 `124/124`，视频工坊前端运行时 `6/6`；无限画布 TypeScript 类型检查通过。
- 当前混杂的 `vendor/infinite-canvas` 只做 dry-run 审计，共发现 178 项历史 / 新构建差异，没有整目录同步、删除、覆盖或暂存；未来发布仍必须从干净源码构建并精确审计静态闭包。
- 健康检查时本地 `8787` 与 `8765` 服务未启动，因此没有把离线端口误报为健康；本版没有执行浏览器视觉验收、导演大轮次回归、真实图片 / Seedance / 语音付费生成、真实发布、Git 推送或服务器部署，界面效果仍由用户本地手动确认。

### 数据、Git 与部署

- 新增表与字段均通过 `CREATE IF NOT EXISTS` / 幂等迁移建立，不需要覆盖生产数据库，也不需要一次性重跑旧生成任务。旧大草稿只在正常读写时惰性迁移，旧中断任务只标记可重试，不自动生成或扣点。
- 本版只修改当前本地工作区代码、测试与文档；既有文档删除、`.gitignore` 修改、认证缓存、运行态目录、本地素材以及混杂的无限画布 vendor 遗留均保持原样。

## v130 - 2026-08-01（个人入口、订阅与批量交互收口，本地待手动确认）

### 本版范围

- 个人基础账号的左侧顺序调整为“首页、视频工坊、无限画布、语音生成、整体资产”，后续未解锁能力显示 VIP 标识；团队版导航顺序保持不变。首页 Logo 不再打开工作区下拉，创作入口收紧为“视频 / 图片”与“动态 / 静态”，并增强英文 `STARMATRIX` 背景的低对比呼吸。
- 订阅管理收口为一屏方案：已生效方案和 ACG 内部团队不能切换或触发付款，团队当前卡可查看席位滑杆与 `¥99 / 席位 / 月` 的增量口径；点数加量包改为独立简洁弹窗。窄屏通过水平卡片轨道自适应，不再恢复整页纵向滚动。
- 批量生产账号选择增加固定尾部对号、浅蓝选中动效和真实“今日已创作”标记，账号属性位置不再因选中而跳动；图文多图的“每条图数”与模式、标题和填写文案同行。统一参考图和单账号定制参考区增加可见拖入反馈，定制弹窗的整个选择区都可接收图片。
- 视频工坊的成片变速文字恢复高对比；对话输入框变高时，消息内容的底部安全区和贴底滚动随实际高度同步。无限画布的壳层品牌列为完整“无限画布”后缀保留宽度，不再只显示“无”。
- 主平台、共享模块、无限画布嵌入入口和视频工坊静态入口统一缓存标识为 `20260801-v130-personal-polish-1`。

### 快速烟测

- Node 首页 / 团队权限 / 订阅 / 统一工作区 / 视频工坊布局烟测 `56/56` 通过，本轮关键 JavaScript 均通过 `node --check`。
- 主服务批量参考图与模块缓存身份定向回归 `28/28` 通过；视频工坊前端运行时 `6/6` 通过；`git diff --check` 通过。
- 按用户边界，本版没有执行浏览器视觉验收、导演大轮次回归、真实图片 / Seedance / 语音付费生成或真实发布，界面效果仍由用户本地手动确认。

### 数据、Git 与部署

- 本版只修改当前本地工作区的代码、样式、测试与文档；没有创建 v130 提交，未推送 GitHub，未部署服务器，未修改生产数据库、生产文件或私密配置。
- 既有文档删除、`.gitignore` 修改、认证缓存、运行态目录、本地素材和混杂的无限画布 vendor 遗留均保持原样，未恢复、删除、整体暂存或同步到外部。

## v129 - 2026-08-01（订阅管理、首页动效与批量任务收口，本地待手动确认）

### 本版范围

- 首页背景恢复为单一淡色英文 `STARMATRIX`，移除中文背景层与伪元素残留；Hero 继续使用单一透明小星动画，增加自动 wink、轻缓俯冲和流星尾迹，标题动效收敛为柔和蓝金流光。灵感发现按四列自适应展示，动态 / 静态视频入口补充悬停说明。
- 新增独立“订阅管理”工作区，左下角个人菜单与首页右上角升级入口指向同一页面；以浅色中文定价卡展示个人专业版、个人高频版、团队版和团队专业版，并明确点数、约一分钟成片容量、席位与加购口径。ACG 内部团队继续显示无限点数，不触发真实支付。
- 登录页左侧升级为本地 WebGL Grainient 风格的蓝紫渐变颗粒动效，并保留低功耗、减少动态、页面隐藏和 WebGL 不可用时的安全降级。账号编辑弹窗补齐选中 / 悬停 / 键盘状态和高对比取消按钮，窄屏改为可用的单列布局。
- 批量生产任务行统一标题、文案、每条图数、参考图与资产操作的区域协议；统一参考图弹窗支持拖入 / 上传并即时选中，任务看板用简洁“已交付”标识替代大块成片卡，账号展示名只做显示层去重。新建入口收口为单一“新建任务板”按钮。
- 无限画布在子应用首次建立或从首页建立项目后，主动向主平台发布项目创建事件；父平台按项目 ID 幂等刷新左侧索引，避免画布已有内容而左侧仍显示“暂无项目”。
- 主平台、共享模块和视频工坊静态入口统一缓存标识为 `20260801-v129-home-subscription-batch-3`，避免刷新时短暂混入旧版 UI。

### 快速烟测

- Node 首页 / 团队权限 / 统一工作区快速烟测 `48/48` 通过；本轮关键 JavaScript 均通过 `node --check`。
- 主服务首页、画布项目、账号弹窗、批量参考图和模块身份定向回归 `68/68` 通过；视频工坊前端运行时 `6/6` 通过。
- 主平台 `8787/api/health` 正常，视频工坊 `8765/api/health` 为 `ready`；`git diff --check` 通过。
- 按用户明确指定的批量生产范围完成 `1440×900` 与 `1024×768` 浏览器视觉回归：页面无横向溢出；静态视频下的图文 / 小红书账号不再出现“多图 / 单图 / 每条图数”，标题、填写文案和参考图操作仍完整；窄屏量产任务板标题保持单行，模式栏安全换到下一行。未扩展到首页、画布或视频工坊的浏览器视觉验收。
- 本轮没有执行真实图片、Seedance、语音付费生成、真实发布或导演大轮次回归；除用户指定的批量生产布局外，其余页面仍由用户本地手动确认。

### 数据、Git 与部署

- 本版仍只修改当前本地工作区的代码、静态资源、测试与文档；没有创建 v129 提交，未推送 GitHub，未部署服务器，未修改生产数据库、生产文件或私密配置。
- 既有文档删除、`.gitignore` 修改、认证缓存、运行态目录、本地素材和混杂的无限画布 vendor 遗留均保持原样，未恢复、删除、整体暂存或同步到外部。

## v128 - 2026-07-31（首页品牌、画布项目闭环与批量任务布局，本地待手动确认）

### 本版范围

- 首页收口为星阵统一创作入口：保留更紧凑的左侧功能 / 视频 / 画布历史，通知移到左下角；普通用户显示视频工坊、无限画布、语音生成和整体资产，其他团队能力显示独立 VIP 标识。首页右上角不再重复放置个人头像。
- 首页 Hero 使用用户提供的蓝色星火 Logo 和“和小星一起创作！”字样的真实透明资源，小星为单一 13 帧自动 wink 动画，同时带有流星呼吸 / 漂移，标题保留蓝金流光。左上角、登录页、机器人头像和浏览器图标改用带 alpha 的星阵资源；登录页光束改为与蓝色 Logo 匹配的淡金色。
- 首页创作框继续缩小，附件加入后不再撑高；支持拖入、剪贴板、回车发送和可见拖入反馈。底部左侧固定视频工坊 / 无限画布切换，视频模式通过单按钮滚轮动画在“动态视频 / 静态视频”之间切换，发送键稳定在最右侧。视频工坊输入框同步收口提示文案、占位色和项目资产空间。
- 灵感发现只保留“视频灵感、视觉设计、笔记风格”三个类别，删除补充占位文案，改为一行四张的紧凑图片瀑布；详情回填一次即可离开。创作框下方增加本地 Canvas 2D 蓝金光迹、网格与鼠标跟随，路由离开后会释放事件与绘制循环。
- 无限画布完成真实项目闭环：新用户首次进入自动建立 owner-scoped 项目并同步到左侧；首页的提示词和图片附件会进入新项目且幂等执行一次。Agent 支持回车发送、小星思考态头像、不同尺寸图片自适应与点击大图；左栏可折叠而小地图留在左下角，同时修复“高清”换行。右上角恢复导出，发布仅对显式具备权益的团队 / 专业账号显示。
- 个人版“整体资产”使用独立口径：只显示 BGM 库与当前用户的视频 / 画布产出，并附带类型筛选；不复用团队版“已发布账号资产”的数据边界。
- 批量生产任务行的布局协议统一为 `name / content / imgcount / actions / refs`：标题输入恢复完整宽度，“填写文案”落在其后，每条图数可编辑，资产选择与参考图状态分行并不再重叠。右侧任务卡不再使用前置竖线或底部进度线，品牌、标签与按钮保持浅色高对比。
- 主平台、共享模块、视频工坊与画布嵌入入口统一缓存标识为 `20260731-v128-home-canvas-assets-2`。

### 验证

- 主平台 Node 首页 / 统一工作区 / 团队权限 / 趋势几何 `56/56` 通过；相关 JavaScript 全部通过 `node --check`。
- 主服务 13 个定向模块使用满足 `server/requirements.txt` 的系统 Python 完成 `171/171` 通过；项目 `.venv` 同组回归通过，其中 6 项因该 venv 未安装已声明的 `Pillow==11.3.0` 而安全跳过，不再误报为业务失败。
- 无限画布源码 Node `35/35`、Python `44/44`、TypeScript 类型检查与 ESLint 通过；嵌入构建成功输出 61 个文件，构建 ID 为 `-izmnEU3mH9AWVzoVdcLx`。审计后以不删除方式同步到托管 vendor，内容校验无差异；历史多余哈希和未知遗留保持原样。
- 视频工坊前端、附件回合隔离与导演语义快速烟测 `53/53` 通过；静态视频继续按口播语义拆分分镜，优先通过增加有意义的切镜加快节奏，不对每个分镜强制五秒上限。
- 按用户要求，本轮仅对批量生产页执行浏览器视觉回归：参考标注与当前 v128 使用同一比较图复核，9 个可编辑任务行的标题、文案、图数、操作和参考图区几何重叠数为 0，图数实际完成 `4 → 5 → 4` 编辑回复。未对首页、画布或视频工坊执行其他浏览器视觉验收。
- 透明品牌 PNG 和浏览器图标均验证 RGBA alpha；首页 animated WebP 为 512×512、13 帧并保持透明。主平台 `8787/api/health` 正常，视频工坊 `8765/api/health` 为 `ready`，`git diff --check` 通过。
- 本轮没有执行导演 30 轮大回归、真实图片 / Seedance / 语音付费生成或真实发布，符合用户“只做快速烟测，未指定不要视觉验收”的本轮边界。

### 数据、Git 与部署

- 本版仍只修改当前本地工作区的代码、静态资源、测试与文档；尚未创建 v128 提交，未推送 GitHub，未部署服务器，未修改生产数据库、生产文件或私密配置。
- 既有文档删除、`.gitignore` 修改、认证缓存、运行态目录、本地素材、品牌中间产物和无限画布历史 vendor 遗留均保持原样，未恢复、删除、整体暂存或同步到外部。

## v127 - 2026-07-31（固定会话侧栏与小星创作首页，本地待手动确认）

### 本版范围

- 首页恢复统一工作区的固定左侧栏：个人基础账号只显示视频工坊、无限画布和语音生成，团队版按能力展示完整功能；左栏历史只合并视频工坊与无限画布的真实项目并标注类型，不再混入语音记录或批量生产会话。无限画布创建项目后会主动刷新左栏索引。
- 首页主创作区改为秒哒式单入口：左侧单一透明小星与“和小星一起创作！”并排，背景使用淡化 `STARMATRIX` 漂移动效；输入框自动轮换打字 / 删除示例，附件支持拖入、剪贴板和选择上传。
- 小星首页形象不再叠加普通、休息、悬停与工作多张位图，而是使用一个自动循环、自然眨单眼的透明 animated WebP；不依赖悬停触发表情，并对系统减少动态设置回退为同一透明静态形象。
- 首页创作框底部收口为上传、视频工坊 / 无限画布平滑切换、动态视频 / 静态视频单箭头选择和最右侧上箭头发送。视频工坊继续接收图片、视频和音频，无限画布只保留图片；首页交接仍携带真实 `creationMode`。
- 首页多模态附件改用当前页短生命周期令牌暂存，`sessionStorage` 只传模式、提示词和附件元数据；工作区消费后立即释放二进制，读取或暂存失败会保留输入并给出反馈。视频 / 画布项目列表同时绑定成员与请求代次，创建画布时即使撞上在途请求也会合并追加一次真正刷新。
- 创作框下增加本地 Canvas 2D 下落光迹与鼠标辉光，不引入 React、WebGL 或远程运行时；效果限制绘制频率、像素比和可见性，在路由离开时释放观察器与事件。灵感发现保持无文字框的三列紧凑瀑布，详情中的“用这个灵感开始”改为一次点击关闭并回填提示词。
- 个人基础能力补齐语音生成，与左侧前三项解锁规则一致；主平台、共享模块和视频工坊入口统一缓存标识为 `20260731-v127-home-sidebar-1`。

### 快速烟测

- Node 首页、统一工作区、团队权限与趋势几何快速烟测 `55/55` 通过；首页、工作区交接、光迹模块、主入口、图标和画布桥均通过 `node --check`。
- 主服务团队权限、前端模块身份和无限画布集成定向回归 `51/51` 通过；动画资源确认为 512×512、13 帧、9.58 秒无限循环，所有帧保持透明 alpha 且像素变化只发生在单眼区域。
- 本地主平台 `8787/api/health` 正常，视频工坊 `8765/api/health` 为 `ready`；健康检查未触发任何真实生成。
- 本轮目标文件 `git diff --check` 通过。按用户要求没有执行浏览器视觉验收、导演大轮次回归或任何真实图片、视频、语音付费生成，界面效果留给用户本地手动确认。

### 数据、后端与部署

- 本版仍只修改本地代码、静态资源、测试与文档；没有创建提交、推送 GitHub、部署生产、修改服务器、生产数据库、生产文件或私密配置。
- 既有文档删除、认证缓存、运行态目录和混杂的 `vendor/infinite-canvas` 历史构建残留均保持原样，未恢复、删除、覆盖或整体暂存。

## v126 - 2026-07-31（首页交互与视频类型入口收口，本地待手动确认）

### 本版范围

- 首页继续收口为悬浮式创作入口：移除顶部横线与固定栏感，左上角透明品牌标志可展开工作区，右上角保留积分与个人入口；中部标题、输入框和纯图片瀑布流缩紧，不再在灵感卡下显示文字框。
- 首页星阵形象使用透明背景的普通、休息、悬停、工作和完成状态图叠加轻量动画；登录页、主平台标志、机器人头像与浏览器图标统一改用抠图资源。新增可重复执行的品牌素材处理脚本，避免白底或黑底方块再次进入界面。
- 首页输入框保持固定高度，附件加入后在框内展示而不撑高布局；底部加入上传、创作入口、视频类型、工作区和发送操作。视频工坊入口新增“动态视频 / 静态视频”选择，原“正常视频”统一改名为“动态视频”，并在创建新会话、发送首页提示词和附件之前同步到视频工坊真实模式。
- 首页工作区与视频 / 画布入口增加悬停说明和连续切换反馈；视频工坊输入框发送键固定在最右侧，项目资产入口不再被挤出。批量生产标题输入加宽，填写文案与资产操作向右对齐并保持完整可见。
- 主平台与视频工坊相关静态入口统一缓存标识为 `20260731-v126-home-refine-1`。

### 快速烟测

- Node 工作区与团队权限快速烟测 `43/43` 通过；本轮修改的首页、图标、视频桥和视频工坊脚本均通过 `node --check`。
- 主服务模块身份与视频工坊集成定向用例 `10/10 + 15/15` 通过；视频工坊前端运行时定向用例 `6/6` 通过。
- 品牌输出的四个正式资源均确认包含 alpha 通道；`git diff --check` 通过。
- 按用户要求，本版没有执行浏览器视觉验收、导演复杂大轮次回归或真实图片、视频、语音付费生成，交由用户启动本地服务后手动确认。

### 数据、后端与部署

- 本版仍只修改本地代码、静态资源、测试与文档；没有创建新提交、推送 GitHub、部署生产、修改服务器、生产数据库、生产文件或私密配置。
- 工作树中既有文档删除、认证缓存、运行态目录和混杂的 `vendor/infinite-canvas` 历史构建残留均保持原样，未恢复、删除、覆盖或整体暂存。

## v125 - 2026-07-30（灵感首页、星阵品牌与发布权限，本地待手动确认）

### 本版范围

- 首页改为 Lovart 式单入口：首页不再固定展示历史会话或“最近项目”，顶部收起为 StarMatrix 品牌、积分 / 升级和个人头像；主体使用“StarMatrix一句话实现灵感 / 懂你的素材助理，一句话唤醒！”与视频工坊 / 无限画布双模式输入框，下方直接进入带分类标签的紧凑灵感瀑布流。灵感卡可打开详情和占位提示词，并可把提示词带回首页继续使用。
- 首页输入框支持选择、拖入和剪贴板粘贴附件。视频工坊接收图片、视频和音频并创建新会话；无限画布只接收图片并创建新项目。视频工坊已经接通首页提示词与附件的同源消息桥；无限画布的提示词 / 图片桥已写入干净源码，但当前混杂的 `vendor/infinite-canvas` 没有整体重建或覆盖，待后续在干净环境审计静态闭包后发布。
- 引入用户提供的蓝色星火形象及工作、休息、悬停、完成状态，用真实图片资源替换首页、批量静态 Agent、生产抽屉和数据助手等机器人头像，并加入轻量浮动、呼吸、工作和完成动效。登录页改用白色品牌 Logo 与浅蓝光束，主平台左上角和浏览器图标切换为新的星阵品牌素材。
- 个人基础账号的视频工坊和无限画布不再提供发布能力；只有团队成员、专业版或显式具备发布权益的账号可以发起发布。主平台发布入口、视频工坊子应用和无限画布嵌入层使用同一权限结果，避免只隐藏按钮但仍能从子应用消息绕过。
- 普通视频附件用途继续与静态视频隔离。Logo、IP、角色、人物设定和产品外观等身份参考会标记为全局身份锚点，按优先级随普通视频的每个 Seedance 分镜请求发送；提示词同时写入全片身份一致性约束。普通截图等非身份附件仍交给导演按语义分配，避免无差别广播污染画面。
- 收口上一轮未生效的界面：批量生产使用浅色任务板、清晰序号和统一新建任务板入口，移除卡片前置竖线、底部进度线及过弱按钮；标题区域加宽，文案与参考操作保持可见。语音“生成音频”按钮向右利用空余位置，并与下一步按钮使用同一套由圆角按钮过渡为箭头的动效。
- 主平台、共享组件、生产链路和视频工坊静态入口统一缓存标识为 `20260730-v125-home-brand-1`，防止刷新后同时加载 v124 / v125 两套有状态模块。

### 快速烟测

- Node 工作区与团队权限烟测 `35/35 + 8/8` 通过；相关 JavaScript 均通过 `node --check`。
- 主服务定向回归 `68/68` 通过，覆盖视频 / 画布嵌入桥、发布权限参数、语音按钮布局和前端模块缓存唯一性。
- 视频工坊普通导演附件语义回归 `43/43` 通过，团队权限回归 `6/6` 通过；其中身份参考测试断言同一 Logo 真实进入每一个普通视频分镜的参考数组。
- 供应商回传、下载状态和账号看板定向回归 `31/31` 通过，继续以回传链接作为已发布事实，供应商真实下载标记与浏览器展示语义保持一致。
- `git diff --check` 通过。无限画布源码环境没有安装 `tsc`，因此没有执行 TypeScript 类型检查，也没有触碰当前混杂的 vendor 闭包。
- 按用户要求，本版没有执行浏览器视觉验收、复杂导演大轮次回归、真实图片 / Seedance / 语音付费生成或真实发布；本地 `8787 / 8765` 在最终健康探测时未监听，需用户启动双服务后手动验收。

### 数据、后端与部署

- 本版只修改本地代码、静态品牌资源、测试和文档；没有提交、推送、部署，也没有修改服务器、生产数据库、生产文件或私密配置。
- 后续若获准部署，只能从干净检出精确同步审计后的代码和静态文件，继续保留生产环境变量、密钥、认证、数据库、成员、账号、供应商关系、资产、任务、发布清单、uploads、composed、canvas_blobs 和视频工坊 runtime。
- 当前无限画布源码变更不能与工作树中既有的历史 vendor 删除 / 新构建残留一起暂存或同步；必须在干净环境重新构建、核对哈希闭包后单独审计。

## v123 - 2026-07-29（视频工坊稳定性、静态导演与交互收口，本地待确认）

### 本版范围

- 静态视频后半段与普通视频彻底分离：只生成图片分镜、口播、BGM、字幕和本地成片，不提交 Seedance；批量生产也使用自己的静态视频 Agent 与小型对话看板，不再把任务伪装成普通视频工坊节点或开放普通视频微调入口。
- 静态导演默认使用 `16:9`，整片统一风格、角色、场景和情绪色彩。用户本轮上传的所有图片会作为每一个图片请求的真实参考输入，并至少在一个语义匹配分镜中明确出现；若贯穿全片的人物、场景或关键物件没有用户参考，导演会先生成角色三视图、场景设定图或物件多角度设定图，再把一致性锚点加入每个分镜。
- 图片生成对 HTTP 成功但缺少有效图片、临时网络失败和上游空结果实行整响应自动重试，最多五次，不再要求用户重新发起整条任务。停止后的任务保存缺失分镜位置；用户说“继续”时直接恢复上一轮创作，不重新做一份导演方案。静态和普通视频的局部修改、继续、否定式“不要改口播”等语义保持隔离。
- 静态成片使用单调、居中的持续慢推近，同一张图片未切换前不会缩放重置或抖动。分镜时长继续依据真实口播语义切分；约五秒只是节奏参考，长语义段可以更久，优先通过增加有意义的图片分镜加快节奏，不设置硬性五秒上限。默认横屏字幕位于画面下方安全区，字号适中并保留轻量动效。
- 视频工坊成片改为随本轮 Agent 对话交付，历史内容集中到“项目资产”。历史成片卡片增高自适应，下载入口改为图标加文字，速度选择使用向上展开的定制菜单并与下载、变速、发布形成一体工具条；筛选文字、关闭按钮、下拉层级和圆角展示同步收口。
- 制作中不再单独显示大号“停止制作”按钮，输入框左侧添加按钮会变为方形停止键；首次对话统一显示“正在思考”，当前会话工作时使用流光状态而不是左侧蓝条。通知按钮补齐可见反馈，导演流水日志按一批分镜汇总，不逐条刷屏。
- 主平台首屏在鉴权和新外壳初始化前保持隐藏，避免刷新瞬间暴露旧 UI；主缓存统一为 `20260730-v123-static-agent-4`。工作区默认顺序改为“首页、视频工坊、无限画布、语音生成、单号创作、批量生产、整体资产、发布清单、数据看板”，个人账号只解锁首页、视频工坊、无限画布。

### 自动与真实验证

- 主平台 Node 全量回归 `57/57`、主服务 Python 全量回归 `397/397`、视频工坊 Python 全量回归 `113/113` 通过；覆盖首帧隐藏、缓存闭包、导航鉴权、成片工具条、续作恢复、附件用途、静态图片重试、连续推近、批量静态隔离和普通视频不串链。最终通知 / 缓存调整前另通过主服务定向 `63/63`、视频工坊定向 `45/45`。
- 静态视频和普通视频各完成 `30/30` 轮复杂导演语义回归。普通视频继续验证附件用途、复杂脚本、暂停后继续和 Seedance 提示词质量；静态视频验证 16:9 默认、图片提示词、风格锚点、人物一致性锚点及无视频运镜词。两类链路的中断、继续与对话修改另完成 `60/60`（各 30 轮）状态回归。
- 普通视频完成 `30/30` 个真实 Seedance 提交边界验证，均成功进入真实额度任务；该项只验证智能判断、提示词、附件用途和提交，不冒充 30 条成片均已下载验收。
- 静态视频已有 `10` 个独立真实项目完成图片、口播和成片渲染复验，共 `48` 个真实图片节拍；节拍平均约 `5.34s`，较长片段保留完整口播语义。本版另使用真实 IP 三视图和品牌 Logo 完成两轮最新附件成片复验：最终项目 `0a6244bef98f` 为 1280×720、有声、动态字幕、BGM 的真实成片，5 个语义图片节拍平均 `3.697s`、最长 `4.677s`，本轮没有超过五秒；IP 贯穿首中尾，真实 Logo 在结尾清晰出现。
- 批量生产补做真实静态 Agent 验证：新批次 `ok8pjtxx` 的生产 `e8n045oi` 独立生成 10 张分镜、57.6 秒口播与 1920×1080 有声成片，全程没有创建 Seedance 任务。旧批次 `tiv6pvej` 中此前因图片超时失败的 `aawdlljb`、`y87ychd4` 在刷新后以原生产 ID 自动续作；两条任务各遇到一次真实图片超时，均在同一分镜第 2 次尝试成功，既有图片没有重做，最终分别生成 64.3 秒和 112.8 秒的 1920×1080 有声成片。三条批量任务合计完成 30 张真实图片且 Seedance 任务数为 0。
- 对三条批量静态成片抽取全片时间点做视觉检查：均为原生 16:9，字幕位于下方安全区、字号适中；连续同图的近景抽帧确认画面保持居中并平滑持续推近，没有缩放重置或可见振动。批量自然语言“真实静态视频批次”还暴露并修复了内容类型未提前锁定的问题，现已由解析层直接路由到独立静态 Agent。
- 本地 `8787 /api/health` 正常，`8765 /api/health` 为 `ready`，两端实际提供新缓存标识。尚未把自动回归当作用户最终手动浏览器验收。

### 数据、后端与部署

- 本版只修改本地主链路代码、静态资源和测试；真实媒体测试产生的项目、上传与成片保留在既有本地视频工坊 runtime，没有清理、覆盖或迁移现有项目数据。
- 当前仍位于本地 `codex/v122-team-auth-home` 工作区，尚未提交新的 v123 Git 提交、尚未推送 GitHub、尚未部署生产，也没有修改服务器、生产数据库、生产文件或私密配置。
- 未来若获准部署，只能同步审计后的代码和静态文件；必须保留服务器环境变量、密钥、认证状态、SQLite、成员、账号、供应商关系、资产、任务、批次、uploads、composed、canvas_blobs 和视频工坊 runtime。无限画布当前混杂的历史 vendor 遗留仍不得整体暂存或同步。

## v122 - 2026-07-29（团队权限、商业化首页与静态视频，本地待续）

### 本版范围

- 新增平台团队模型与能力鉴权：既有内部管理员、创作者、供应商及账号在首次迁移时归入“ACG市场部”；默认主管理员保持团队所有者，其他既有管理员为团队管理员，创作者为团队成员。新注册账号先建立为个人账号，默认开放无限画布、视频工坊、语音生成和整体资产；批量生产、单号创作、发布清单与数据看板等团队能力在加入团队并获批后解锁。
- 加入团队改为“输入团队名称 → 团队所有者 / 管理员审批”的独立流程；团队管理员可管理本团队成员、产品库、模型用量、成员申请和本团队供应商身份。团队账号、供应商与自媒体账号均按团队隔离，外部团队不能读取 ACG 市场部的成员、账号或业务数据。
- 原数据首页迁为“数据看板”，新首页建立社区 / Skill 占位结构：左侧直接显示个人基础能力，右侧预留上新事件与 Skill 视频预览；团队能力在界面中显示锁定状态并引导加入团队。供应商端保持原有入口与业务首页。
- 视频工坊增加与普通视频完全并列的“静态视频”模式。前半段继续复用导演的信息完整度判断、文案、口播和分镜拆解；后半段改为 GPT 图片分镜并发生成，再进行居中轻推近、字幕、口播、BGM、质检、归档和交付，不调用 Seedance。整条视频固定视觉风格锚点和负面约束，当前轮参考图会随各图片分镜请求提交。
- 批量生产增加“静态视频”分类，覆盖全部启用的视频号账号：只有标题时自动生成文案，有文案时直接作为导演依据；每个账号建立独立视频工坊静态任务并恢复轮询，失败支持整条重试。静态视频不复用普通视频的封面微调、重生视频或进入工坊微调入口。
- 无限画布源码补回“新建项目”的父子应用消息链路；视频工坊本地启动脚本允许外部显式指定 projects / outputs / uploads 持久目录，避免启动器覆盖已绑定的数据路径。
- 主平台静态缓存统一到 `20260729-v122-static-1`；团队界面模块使用 `20260729-v122-team-3`。视频工坊静态入口同步使用 `20260729-v122-static-1`。

### 自动验证

- 主平台定向 Python 回归 `79/79` 通过，覆盖团队迁移与隔离、批量参考图、静态视频桥接、前端模块身份和数字生产链路。
- Node 前端工具回归 `49/49` 通过，覆盖 v122 首页 / 鉴权、统一工作区缓存闭包和首页趋势几何。
- 视频工坊完整回归 `97/97` 通过，覆盖当前轮附件隔离、静态图片生成分支、媒体合成、事务恢复、LLM 重试和前端模式恢复。
- 本轮修改的 JavaScript 通过 `node --check`，Python 文件通过语法编译，`git diff --check` 通过。
- 尚未做用户手动浏览器验收，也未调用付费图片、视频或语音接口执行真实媒体生成；自动测试结果不能代替这两项验收。

### 数据、后端与部署

- `server/store.py` 增加团队、团队成员、团队账号、团队供应商和加入申请的增量表与首次归属迁移。迁移只补充关联关系，不重建或清空既有成员、账号、资产、任务、发布清单、草稿、上传或视频工坊项目；内部团队所有者关系在迁移标记已存在时仍会被安全修复。
- 生产部署必须沿用服务器现有 SQLite、uploads、composed、canvas_blobs、视频工坊 runtime、认证状态和私密环境，只允许执行代码自带的增量建表 / 关联迁移；禁止用本地空数据或本地 runtime 覆盖服务器数据。
- 本版本当前只在本地主链路工作区，尚未推送 GitHub、尚未部署生产。部署前仍需在干净检出中复跑全量回归、重建并审计无限画布静态闭包，并对既有团队归属和受保护数据做只读快照核对。
- 回滚应只恢复本版代码和静态资源；数据库新增团队表及关联记录属于增量元数据，不得通过旧本地数据库覆盖生产。任何回滚前先备份并校验生产数据库与持久目录。
- 本版没有在代码、文档或提交信息中写入密钥、密码、IP、token 或账号凭据。

## v120 - 2026-07-28（统一工作区，已部署生产）

### 本版范围

- 主平台切换为单一白色工作区外壳，左侧按功能显示真实上下文；品牌区使用“星阵 + 灰色功能名”同一行，移除固定黑色功能栏、旧版界面入口和重复筛选，发布入口统一命名为“发布清单”。主平台缓存为 `20260728-v120-shell-21`。
- 批量生产进入单号微调后保留流程上一步节点与“返回批量生产”；图文工坊统一参考图、整体资产拖入、视频工坊附件区均补齐明确但克制的拖入反馈。BGM 支持浏览器 MP3 MIME 别名与空 MIME 推断，剪辑素材同时支持图片和视频；同名素材会被拒绝并返回具体错误。
- 视频工坊统一为白色工作区，内部重复历史栏被统一左栏替代；历史会话支持新建、重命名、收藏、分组移动、分组新建 / 改名 / 删除和已发布数量，打开历史会话时恢复对应真实对话记录。输入框、附件、消息气泡、成片工具条和白色下拉菜单按统一交互收口。
- 无限画布直接等待并打开真实最近项目，不再进入或闪现旧首页；最近项目、缩放控制和小地图迁入统一左栏，画布内部重复顶栏被移除。“画布项目”固定展开且不再显示折叠箭头，每个项目以整行悬停的三点菜单提供真实重命名和删除，操作复用当前成员隔离的画布草稿接口并同步刷新嵌入画布索引。选中图片的悬浮工具条补回“发布”入口，位于导出与删除之间并复用原有图片合成及主平台发布消息链路。语音生成把真实音色库迁入左栏，保留音色分类、声线 / 语言筛选和可键盘操作的三点菜单，右侧预览与参数区减少重复边框。
- 创作端与供应商端首页统一指标卡、发布分布、趋势、账号轮播和数据助手布局；折线节点和值严格对齐。供应商“全部账号”按平台筛选、三个账号一排且单卡内部保持一行，观看量由单条内容自动汇总，不再提供账号总量手工覆盖。
- 供应商发布清单左栏增加账号 / 素材搜索、批量下载、回传链接时间与创建时间筛选；单条内容支持观看量和曝光量编辑。曝光量从未填写或原值为 `0` 时，编辑框保持为空并只显示提示文字，不再用数字占位冒充既有数据。
- 登录页改为全屏双栏布局，保留一个品牌 Logo；手机验证与 Google 快速登录目前为明确的待上线占位，账号密码登录、申请账号和忘记密码申请继续使用原后端。状态型 `remote.js` 固定为唯一无查询串模块身份，避免登录令牌与工作区同步分裂。
- 管理设置左栏拆为成员账号、产品库、模型用量和成员申请；个人资料独立显示并垂直居中。意见反馈、单号账号列表、发布筛选、资产分类和顶栏业务按钮避让继续按统一工作区收口。

### 自动验证

- 主服务测试全量 `383/383` 通过；Node 前端工具测试全量 `48/48` 通过。无限画布定向回归 `34/34`、视频工坊集成回归 `15/15` 均通过。
- 本轮修改的 JavaScript 均通过 `node --check`，Python 测试文件可编译，`git diff --check` 通过。测试覆盖登录模块单例、供应商日期筛选、观看量汇总、曝光量空值语义、BGM / 剪辑素材拖入、参考图、生成路由、封面、发布与成员隔离。
- 本机固定入口 `8787` 实际加载 `20260728-v120-shell-21`，主服务健康；`8765` 视频工坊 sidecar 为 `ready`，导演、视频、语音、合成、质检和共享 BGM 均可用。主动终止 sidecar 后，看门狗以新 PID 自动恢复，期间 `8787` 保持在线。
- 本轮交付按约定只做自动检查，不把源码或自动测试结果当作用户手动浏览器验收。

### 数据、后端与部署

- 本版位于分支 `codex/v120-unified-workspace-shell` 的独立工作树，本机 `8787` 已切换为 v120 并显式复用原本地 SQLite、uploads、composed、canvas_blobs 及视频工坊 projects / outputs / uploads / 模型缓存，未创建或迁移第二套业务数据。
- 原有任务、草稿、账号、资产、生成、参考图、发布、画布、语音和视频能力未改写。后端仅增加供应商单素材曝光量的窄接口与对应字段保留，未引入数据库结构迁移，也未修改生产配置。
- 已于 2026-07-28 从干净检出的受控提交 `769bed1` 部署生产。精确同步 `97` 个运行代码 / 静态文件，主平台实际加载 `20260728-v120-shell-21`，视频工坊加载统一外壳缓存 `20260728-v120-shell-7`，无限画布构建为 `3kJ2GVghGaFvcIZrHvqcj`；全部目标文件哈希一致，主服务和视频工坊 sidecar 健康。
- 部署前创建并验证纯代码 / 静态回滚点 `v120-pre-20260728-200718` 和独立一致性 SQLite 快照。部署后 SQLite `quick_check` 为 `ok`，私密环境指纹不变，受保护集合和目录无减少：账号 `80`、成员 `67`、资产 `4118`、生产单 `790`、任务 `980`、批次 `99`、画布草稿 `61`、画布图片 `344`。
- 生产只读浏览器确认统一首页、批量生产、视频工坊、无限画布、语音生成和个人资料可打开；历史批量会话与 `12` 个真人任务可读，既有视频项目及交付成片仍在，无限画布当前项目的 `16/16` 张图片均加载成功，语音库显示定制 / 收藏 / 系统音色及既有 `201` 条语音素材。页面没有横向溢出，也未发现应用自身的控制台错误；验收未触发生成、发布、删除、重试或资料保存。
- 语言、图片、语音、Seedance、数字人及数据接口均使用服务器原私密环境完成配置 / 连通性检查；语言模型和语音最小测试成功，未替换任何 Key，也未执行媒体生成业务写入。
- 初次部署检查使用了视频工坊已废弃的 `/health` 路径，检查脚本按设计自动回滚；回滚后服务、旧缓存、目标文件和全部受保护数据均核对正常。改用真实 `/api/health` 后重新部署成功，没有用数据库快照覆盖部署窗口内的数据。
- 新回滚点验证后，先将最老回滚点所带的数据库快照转存到独立数据快照区并再次通过完整性与哈希校验，再轮换最早的纯代码 / 静态回滚目录；当前严格保留最近 `5` 次代码 / 静态回滚点。数据快照、uploads、composed、canvas_blobs、视频工坊 runtime、认证和私密配置不参与轮换。

## v119 - 2026-07-27（客户端入口、发布分布与批量成片封面，已部署）

### 本版范围

- 创作端首页饼图由历史“全部交付的平台分布”改为与顶部“发布数量”完全同口径的“发布分布”：只统计已回传发布链接的内容，并按小红书 / 视频号拆分；点击扇区可查看该平台各账号的已发布数量。
- 左侧设置上方增加独立“客户端”入口。浏览器端可选择 macOS / Windows 并查看四步安装引导；桌面壳环境优先显示“刷新平台”，未来只有在桌面壳显式提供当前版本且版本清单更高时才提示安装新版本。该模块不读取或写入业务 store，不接入账号、创作、发布或数据接口。
- 客户端安装引导移除普通用户不需要的 SHA-256 长串、顶部重复标题和单独重试区；下载失败时可直接再次点击原下载按钮。弹窗在默认桌面尺寸和 1024px 宽度均完整显示，无内部滚动或横向溢出。
- 客户端安装包仅放入本地版本化下载目录并由服务端固定白名单路由提供，不开放目录遍历；macOS 包明确为 ad-hoc 签名且未公证，Windows 包明确为未代码签名，界面提供对应系统的首次安装放行说明。
- 批量视频交付完成卡片优先显示真实封面；旧数据缺少封面时使用成片首帧，只有两者均不存在时才保留彩色占位。
- 主平台缓存升级为 `20260727-v119-4`。

### 验证结果

- 客户端下载白名单、安装包哈希、隔离性、桌面壳识别降级、批量成片封面和首页发布分布相关定向回归共 `50/50` 通过；相关 JavaScript 语法、Python 编译和 `git diff --check` 通过。
- 本地真实浏览器命中 `20260727-v119-4`：发布饼图显示“发布分布 / 已发布”并与顶部发布数量一致；平台扇区可通过键盘打开账号发布明细。
- 客户端弹窗在 `1512×722` 和 `1024×768` 下均无内部滚动、无横向溢出，客户端与设置按钮不重叠；页面控制台没有应用级 error / warning。
- 本地设置页的“读取接口用量失败：Failed to fetch”已定位为当时 `8787` 本地服务未启动；服务启动后接口用量卡片正常读取。该现象不会影响生产服务器自身的用量记录或读取。
- 生产部署前在干净目标检出中复跑主服务完整回归 `369/369`、视频工坊完整回归 `92/92`；目标 JavaScript、Python、Shell 语法、安装包哈希、固定白名单路由和 `git diff --check` 均通过。共享旧虚拟环境缺少测试依赖时没有修改该环境，改用本机完整隔离依赖环境完成全量回归。

### 数据与部署

- 已于 2026-07-27 从干净检出的受控提交 `fefd1b7` 部署。仅精确同步 `12` 个主平台运行代码 / 静态文件、版本清单和两份版本化安装包；视频工坊与无限画布静态闭包未重建或替换。生产主平台实际加载 `20260727-v119-4`，全部目标文件哈希一致，主服务与视频工坊 sidecar 健康。
- 部署前创建并校验纯代码 / 静态回滚点 `v119-pre-20260727-153633` 和独立一致性 SQLite 快照。部署后 SQLite `quick_check` 为 `ok`，账号保持 `80`，成员、任务、草稿、资产、发布清单等受保护集合均未减少；部署窗口内 analyticsLinks 增加 `4`、assets 增加 `1`、supplier_activity 增加 `5`、composed 增加 `1`，视频运行目录与模型缓存也有正常并发增长，均原样保留。uploads、canvas_blobs 没有减少，私密环境指纹不变。
- 版本清单、Mac / Windows 安装包 HEAD 响应的类型、文件名、长度均正确；经生产 HTTP 下载流重新计算的两份 SHA-256 与批准值一致。已登录生产浏览器确认客户端悬停入口、两个系统的四步引导、无内部滚动弹窗、首页发布分布键盘明细和批量真实封面均正常，控制台 `0` application error / warning；没有点击下载、生成、发布、删除、取消或重跑业务任务。
- 新回滚点加入后共有 `5` 份纯代码 / 静态回滚集，正好达到保留上限，本轮无需删除；独立数据快照不参与该轮换。回滚仅恢复上述代码 / 静态文件并移除本版新增下载文件，绝不能用快照覆盖部署后新增业务数据。

## v118 - 2026-07-26（发布数据看板、账号播放量与批量视频稳定性）

### 本版范围

- 管理员首页去掉“累计交付”，近 7 / 30 日及自定义趋势统一改为统计供应商实际回传链接的发布数量；总播放量详情改为按自媒体账号汇总，继续保留平台与日期筛选。
- 供应商“全部账号”为每个账号增加紧凑的总播放量入口：默认使用该账号全部内容的单条播放量之和；可单独填写账号总量，覆盖值只参与账号与总播放量展示，不会随机拆分或改写任何单条内容播放量。
- v118-4 修复账号卡片新增播放量入口后与编辑、停用、分配控件互相覆盖的问题：四项仍保持同一横排，但收窄“分配给”下拉框并为整组控制区预留稳定宽度；从未手动填写账号总播放量时，编辑框保持为空，不再用 `0` 冒充既有填写值。
- 供应商“全部账号”顶部移除无实际价值的账号搜索框，保留新建账号、平台筛选和全局搜索，减少重复入口并释放顶部横向空间。
- 创作端首页“平台分布”和上方“发布数量”复用同一组三等分网格轨道，右边缘精确共线；发布趋势横跨其余两列，不改变原有趋势空间和数据助手布局。
- 创作端“总互动”明细把每条内容的播放、点赞、收藏、评论和分享收拢到行尾指标区，“打开”入口继续固定在最右侧；窄屏时指标再自然换到下一行，避免横向溢出。
- 管理员设置中的产品库展开 / 收起改为局部显隐，不再触发整页重绘；图文工坊只清理由模型偶发生成的同名括号重复，例如“百度搭子（百度搭子）”，不会改动其他正文结构。
- 无限画布的拖入、上传和系统剪贴板图片按当前最右侧内容继续向右稳定落位；同一次多图导入也逐张读取最新画布状态，不再重叠或随机散落。
- 发布与回传相关列表统一按有效业务时间倒序显示，最新记录优先。
- 修复重任务成员进入批量数字人时任务看板闪烁、卡顿和集合写回放大：活跃任务的状态、进度和文案只原位更新对应任务行，缩略图 / 视频 DOM 与 `src` 保持稳定；只有生产批次结构或终态输出发生真实变化时才允许完整重绘。
- 数字人与信息流视频共用同一轮询和视频队列，因此本版同时覆盖两类任务：浏览器视频并发统一收敛为受控 `3` 路；无变化轮询不落盘，有变化时以单文档 / 小批量增量同步 jobs 与 productions，不再在每次轮询深拷贝并 PUT 整个集合。
- 主平台缓存升级为 `20260727-v118-7`；无限画布嵌入式构建刷新为 `1lusSDhjMfp40zIG_fwT9`，视频工坊静态缓存保持不变。

### 验证结果

- 新增重任务压力回归：`12` 个 production、每个 `3—4` 个片段、`10` 个初始活跃 job、连续 `100` 轮轮询；任务行和缩略图节点身份及媒体地址保持不变，整板只在首次 / 结构变化时重绘，无 jobs / productions 整集合 PUT。
- 压力回归同时验证数字人和信息流视频共享 `3` 路受控并发，重任务成员不会阻塞其他轻量成员的任务摘要；最终供应商账号、任务压力、首页布局与缓存闭包定向回归 `57/57` 通过。
- 主服务完整回归 `364/364`、视频工坊完整回归 `92/92` 通过；无限画布 TypeScript、ESLint、嵌入式生产构建、全部相关 JavaScript / Python / Shell 语法与差异检查通过。
- v118-4 额外通过供应商账号卡片结构、未填写播放量空值语义和主缓存闭包定向回归；本地真实页面刷新后逐卡测量，播放量、编辑、停用和分配控件均保持同排、底部对齐并位于自身边界内。
- 最终 `v118-7` 已在本地已登录创作端真实刷新：平台分布与发布数量的左右边界完全一致，1024px 与默认桌面宽度均无横向溢出；总互动三条真实明细的指标区固定在右侧，与“打开”按钮保持独立间距。主验收页控制台 `0` error / `0` warning。

### 数据与部署

- 已于 2026-07-27 从干净检出受控部署提交 `37c5194`。精确同步 `63` 个运行代码 / 静态文件，生产主平台实际加载 `20260727-v118-7`，无限画布实际加载 `1lusSDhjMfp40zIG_fwT9`，视频工坊静态缓存未改；全部目标文件哈希与发布清单一致，主服务和视频工坊 sidecar 健康。
- 部署前创建并验证纯代码 / 静态回滚点 `v118-pre-20260727-123403` 和独立一致性 SQLite 快照。部署后 SQLite `quick_check` 为 `ok`，账号、成员、资产、发布清单及所有受保护集合均未减少；uploads、composed、canvas_blobs、视频工坊 runtime、模型缓存和私密环境指纹保持不变。部署窗口内 jobs 从快照时的 `879` 增至 `887`，属于线上任务正常并发写入，已原样保留。本次共有 `4` 份纯代码 / 静态回滚集，低于最多保留 `5` 份的阈值，无需删除。
- 已登录生产浏览器强刷后确认首页与主模块均命中 `v118-7`：发布趋势使用回传链接口径，总播放量按 `51` 个账号汇总，平台分布与发布数量同轨且页面无横向溢出；互动明细指标位于每行右侧，“打开”固定最右。真实 `12` 条数字人批次可读，轮询前后任务行内容与 `12` 个封面地址完全一致；无限画布新构建、最近项目和缩略图正常加载，控制台 `0` error / `0` warning。验收未生成、删除、取消、重跑或迁移任何业务任务。
- 账号总播放量是新增的独立覆盖字段，不执行历史播放量迁移，也不回写单条内容；批量任务修复不删除、不取消、不重跑任何既有数字人或信息流任务。

## v117.23 - 2026-07-24（无限画布尺寸职责收口）

### 本版范围

- 收口 v117.22 的剩余界面语义：超宽比例的尺寸规划统一称为“完整适配回目标像素”，不再显示“裁切为目标尺寸”。
- “适配新尺寸”快捷操作不再把“尺寸转译与裁切建议”交给创作链路；现在明确要求完整画面适配、不裁切、不补模糊背景，并保持主体、版式与内容不变。
- 最终像素继续只作为结构化输出契约。单张参考图编辑仍逐字使用用户指令，多参考图仅补充目标图与参考图的角色关系。
- 主平台缓存升级为 `20260724-v117-23`；无限画布嵌入式构建刷新为 `KUHu0JKubL-tLCqpqdIyX`，视频工坊缓存保持不变。

### 验证结果

- 无限画布 TypeScript、ESLint、嵌入式生产构建和尺寸语义定向回归 `41/41` 通过；新构建只引用当前哈希闭包。
- v117.22 已完成的同提示词 20 轮超宽单图编辑与 50 轮复杂多参考规划继续作为本版基础回归；本版额外禁止源码和尺寸提示重新出现“生成后裁切”“裁切为目标尺寸”等旧语义。
- 主服务完整回归 `354/354`、视频工坊完整回归 `92/92` 通过。
- 生产浏览器只读打开真实 3496×1022 历史项目，成图节点保持 3496×1022；尺寸规划明确显示“生成母版 3504×1168 → 完整适配为 3496×1022”，没有裁切或模糊补边语义，控制台 `0` 错误 / `0` 警告。

### 数据与部署

- 只允许精确同步本版代码和静态哈希闭包。继续保护服务器 SQLite、账号 / 成员、资产 / 发布清单、uploads、composed、画布项目 / blob、视频工坊 runtime / uploads / outputs、认证及私密环境；不执行迁移、补数或删除式同步。
- 生产已部署受控提交 `57d1275`，精确同步 `34` 个代码 / 静态文件；主服务和视频工坊 sidecar 健康，部署文件哈希全部匹配。
- SQLite 完整性为 `ok`，全部受控业务集合计数、uploads / composed / canvas_blobs 文件数与字节数、私密环境指纹均与部署前完全一致；未执行业务写入、迁移、补数或 reconcile。
- 新代码 / 静态回滚点验证完成后，按轮换策略删除最早的纯代码 / 静态回滚集，当前只保留最近 `5` 次。数据库、媒体、画布 blob、视频工坊 runtime 与私密配置快照不参与轮换。

## v117.22 - 2026-07-24（无限画布原样编辑、精确尺寸与无模糊补边）

### 本版范围

- 修复无限画布自定义尺寸被误当成创作语义的问题：`16:9`、`3496×1022` 等尺寸只通过结构化请求字段传给图片模型，不再写入用户提示词，也不再把超宽画布降级为固定 `16:9` 创作要求。
- 单张参考图定向编辑现在把用户输入逐字传给服务端；仅在存在额外多参考图时补充“第一张为待编辑原图、其余为视觉参考”的必要角色说明。尺寸标签只负责输出像素，不再改写标题、版式、构图或内容。
- 对上游不接受的超宽比例使用可逆的合规母版传输：完整原图先适配到模型允许的结构化尺寸，模型结果再完整恢复到用户所选像素。服务端已移除模糊背景扩边、居中裁切和尺寸文字注入，不会再人为制造截图中的底部 / 两侧模糊区域。
- PNG、JPEG 均覆盖真实编解码回归；运行环境具备 WebP 编解码器时同一路径支持 WebP。区域遮罩继续使用最近邻适配，避免选区边缘软化。
- 主服务依赖显式加入 `Pillow==11.3.0`。精确尺寸恢复不再隐式依赖开发机已有的图像库，生产部署必须先安装该依赖再启用本版。
- 保留同一共享工作区中已完成的管理员 API 用量看板紧凑化：按语言、图片、视频汇总有用量成员，零用量成员折叠显示。
- 主平台缓存升级为 `20260724-v117-22`；无限画布嵌入式静态构建同步刷新，视频工坊缓存保持不变。

### 验证结果

- 无限画布专项 `32/32` 通过，包含同一 3496×1022 提示词连续 20 轮原样透传 / 精确像素 / 全边缘保留检查，以及复杂多参考图 50 轮目标识别与逐图拆分检查。
- 主服务完整回归 `354/354`、视频工坊完整回归 `92/92` 通过；无限画布 TypeScript、ESLint、嵌入式生产构建、全量 JavaScript / Python / Shell 语法检查通过。
- 使用真实 3496×1022 JPEG 和真实图片模型完成一次最小定向编辑：40 秒返回 3496×1022 PNG，副标题及左下角文案按指令更新，画面无模糊补边、无裁切。浏览器自定义尺寸选择显示 `3496×1022 · 约 3.42:1`，比例仅作为界面提示。

### 数据与部署

- 本版部署仅允许从干净提交同步代码和静态资源，并在服务器现有主服务虚拟环境中安装新增的 Pillow 依赖。必须保留服务器 SQLite、账号 / 成员、资产 / 发布清单、uploads、composed、画布项目 / blob、视频工坊 runtime / uploads / outputs、认证和私密环境；禁止删除式同步、迁移或本地状态覆盖。

## v117.21 - 2026-07-24（MiniMax-M3 视觉摘要兼容与可诊断失败）

### 本版范围

- 修复统一参考图识别在 MiniMax-M3 兼容接口上的格式边界：该接口不强制 `response_format`，模型有时会返回 `summary` / `required_terms` 或“摘要：… / 主题词：…”文本，而旧解析器只接受 `brief` / `requiredTerms` JSON，因而把已完成的看图结果误判为“未完成内容识别”。
- 现在同时兼容上述 JSON 别名和明确的摘要 / 主题词文本。若模型给出了有效视觉摘要但漏了主题词，则仅以用户已上传的非通用附件名称补出 2—4 个正文必含主题词，仍由正文校验阻止泛化文案；没有可解析的视觉摘要时继续安全停止，并把具体原因回显给用户。
- 资产名 `logo百度搭子` 这类连写中文名称现在会正确识别为 Logo。主素材与品牌识别的落位策略不再把它误当作普通截图。
- 主平台缓存升级为 `20260724-v117-21`；视频工坊静态缓存保持不变。

### 验证结果

- 新增 MiniMax-M3 非 JSON兼容回归：`summary`、`required_terms`、中文“摘要 / 主题词”文本以及“只有有效摘要、由用户附件名补主题词”均可进入正文主题约束；无摘要仍会停止。
- 前述统一参考全量归属、供应商链接清除、交付状态和前端缓存闭包回归共 `100/100` 通过；主服务完整回归 `348/348` 通过。相关 Python 编译、全部主平台 JavaScript 语法检查、精确差异检查和本机健康接口均通过。
- 验证未发送真实模型请求或写入供应商、账号、交付、链接、观看量或画布业务数据。

### 数据与部署

- 已于 2026-07-24 从干净检出部署受控提交 `f483f8e`。主平台实际加载 `20260724-v117-21`，视频工坊静态文件未变；部署包仅包含 34 个目标差异中的运行代码和静态文件，测试、文档、本地状态及环境文件均未上传。
- 部署前创建了代码/静态回滚点和一致性 SQLite 快照。最终文件哈希与目标包一致，主服务及视频工坊 sidecar 健康，SQLite `quick_check` 为 `ok`；业务集合和 uploads、composed、画布 blob、视频工坊运行目录的文件数量与字节数在部署前后保持一致。
- 本轮未运行 reconcile、迁移、补数、恢复或浏览器业务写操作。私密环境不在归档和同步清单内，服务器现有模型与权限配置保持原样。部署结束时已验证代码/静态回滚集合数量低于五份，无需轮换删除。

## v117.20 - 2026-07-24（统一参考全量归属与回传链接可撤回）

### 本版范围

- 图文工坊把“统一参考图必须有归属”从按图卡数量的默认策略收紧为绝对不变量：即使用户只生成 `2` 张图、却上传 `5` 张统一参考图，五张素材也都会分配到这两张图的明确主素材 / 品牌识别 / 证据位置中；同一图承接多张素材时会为每张素材写不同的位置，避免全部叠在画面中心。任一统一参考遗漏时，浏览器会在图片生成前停止任务。
- 供应商“改链接”弹窗现在支持直接清空后确认，或点击“清除链接”。成功后交付恢复为“未回传”（保留原有下载状态），当前分析链接标记为归档，不会继续刷新或计入当前统计；既有播放快照不删除，留作历史审计。较新的清除状态也会阻止旧浏览器快照把误传 URL 写回。
- 主平台缓存升级为 `20260724-v117-20`，同时刷新交付、数据分析和弹窗模块的加载闭包；视频工坊静态缓存保持不变。

### 验证结果

- 新增 10 轮 “2 张图 / 5 张统一参考图”反例回归：模型故意只分配 Logo，服务端均重排为五张参考各有明确归属与落位说明。
- 供应商回传状态回归覆盖：有权限回传、清除链接、历史分析记录归档、播放快照保留、旧浏览器带错误 URL 的整条资产回推不复活链接，以及前端清除响应后恢复“回传链接”按钮。
- 图文参考、供应商状态和交付状态定向回归 `20/20` 通过；`server/main.py`、`server/store.py` Python 编译和相关前端 JavaScript 语法检查通过。

### 数据与部署

- 本版仅修改本地代码、测试和版本 / 避坑记录，尚未推送或部署。后续部署只能精确同步审计过的代码与静态文件；严禁覆盖服务器 SQLite、成员、账号、资产、交付、回传链接、观看量、上传、成片、画布、认证或私密环境。

## v117.19 - 2026-07-24（统一参考图全量主图归属与正文主题强校验）

### 本版范围

- 图文工坊把统一参考图从“模型可选的视觉线索”收紧为“必用生产素材”：视觉编排返回后，服务端为每张统一参考图确定一张主图归属；当图卡数量不少于参考图数量时默认一图一主素材，避免 Logo 重复占用多页而套件、流程截图、主界面等用户素材被遗漏。仍保留单图定制参考的图卡隔离。
- 视觉模型若返回“前三页都用 Logo、其余附件未使用”或 all-to-all 广播，服务端会在进入图片提示词前重排为覆盖全部统一参考图的计划；浏览器再独立检查所有统一参考图均已分配，任一遗漏即停止生成，不再提交不完整任务。
- 前置视觉摘要现在必须给出可确认的共同宣传主题与 2—4 个核心主题词。标题仅为口号时，正文必须自然包含这些主题词；未覆盖则重试后失败并明确报错，不能再生成泛化的“桌面整理 / 效率工具”模板文。摘要仍避免逐项复述图片外观，完整提示词只写对应附件在当前图的用途、位置与保留要求。
- 主平台静态缓存升级为 `20260724-v117-19`；旧任务的参考图规划签名同步失效并按新策略重新编排，避免浏览器继续复用可选附件时代的旧计划。视频工坊静态缓存保持不变。

### 验证结果

- 新增并运行 10 轮反例回归：每轮故意输入“Logo 被 4 张图重复选择、其余 2 张统一参考遗漏”的视觉规划响应，均修复为 4 张统一参考图各有主图归属，且每条提示词保留附件名称与版面位置；同时验证视觉主题词会传入正文并成为必过条件。
- 图文参考链路、供应商数据助手与既有批量参考选择回归共 `25/25` 通过；相关 JavaScript 语法检查与 `server/main.py` Python 编译通过。

### 数据与部署

- 本版仅修改本地代码、测试和版本 / 避坑记录，尚未推送或部署。后续部署仍必须精确同步已审计代码和静态文件，严禁覆盖服务器 SQLite、成员、账号、资产、交付、回传链接、观看量、上传、成片、画布、认证或私密环境。

## v117.18 - 2026-07-24（图文先看参考图再写正文与数据助手下载问答）

### 本版范围

- 图文工坊把有统一参考图的首次生成收紧为不可跳步的四段流程：先由可看图的 MiniMax-M3 识别标题与统一参考图间可确认的品牌 / 产品 / 功能关系，再写正文；正文确定后才拆图卡，最后再次看全部统一参考图与单图定制参考图，把每张附件分配给真正需要的图卡，并把“附件怎么用、放在哪里、保留什么”写入该图的完整提示词。用户已填正文时保留正文，直接从逐图编排继续。
- 当独立视觉模型未配置而当前主模型为 MiniMax-M3 时，服务端允许 MiniMax-M3 承担上述图片理解；若图片读取、视觉识别或逐图分配没有完成，图文任务会明确停止，不再静默按泛化标题生成正文、均衡轮转附件或把全部附件广播给每一张图。
- 统一参考图会按内容职责智能分配：非 Logo 的主界面、套件截图、海报或流程证据优先作为某一内页的完整主体；Logo 仅在确有品牌识别关系的页面使用。单图定制参考图只允许供对应图卡使用。既有图卡提示词的主题、正文节拍、版式和文字规格不被缩减，新增的只是附件落位语义。
- 供应商首页统一称为“数据助手”。每一轮提问先在原对话位置显示“正在读取数据…”，然后由已部署的 MiniMax-M3 基于服务端同权限快照组织答复；在不越过当前供应商层级权限的前提下，新增“谁下载过 / 哪个账号领取过”的交付下载记录查询，返回交付编号、账号、内容和可见下载成员。
- 主平台静态缓存升级为 `20260724-v117-18`，并同步更新图文工作台、供应商视图及其加载链的模块版本；视频工坊静态缓存保持不变。

### 验证结果

- 新增 10 轮确定性图文参考图回归；每轮均覆盖“4 张统一参考图视觉摘要 → 标题关联正文主题 → 4 张图卡的附件分配与位置指令”，共 20 次服务端视觉编排模拟调用，未发送真实语言、图片或视频模型请求。
- 图文参考链路、供应商数据助手与既有批量参考图回归共 `25/25` 通过；相关 JavaScript 语法检查和 `server/main.py` Python 编译通过。

### 数据与部署

- 本版仅修改本地代码、测试和版本 / 避坑记录，尚未推送或部署。后续部署必须在受保护备份后精确同步已审计代码与静态文件，并同时保留服务器已有的 `store.py` 资产混合快照保护；严禁覆盖 SQLite、成员、账号、资产、交付、回传链接、观看量、上传、成片、画布、认证或私密环境。

## v117.17 - 2026-07-24（供应商数据助手强制模型对话与真实失败提示）

### 本版范围

- 供应商首页的每一条聊天消息（包括问候、日期统计、播放量、排行和“给我回传链接”）均先经过服务端已授权的 MiniMax-M3 对话链路；问候会自然回应并提示可查询范围，不再把“你好”误答为交付总计。
- 日期、数量、播放量仍先由服务端从同一角色可见快照计算为权威结论，MiniMax-M3 只能据此组织和解释，不能改写数字、日期、账号或权限范围。回传链接问题也会调用模型；完整 URL 由服务端在模型答复后追加，保持逐条可复制且不会被模型截断或伪造。
- 移除供应商浏览器侧的 `supplierDataAnswer` 降级。模型调用、权限或服务异常时，界面明确提示“语言模型暂时不可用”，不再用本地规则统计伪装成智能答复。
- 供应商首页、全部账号与设置入口统一更新到 `supplierViews.js?v=20260724-v117-17`；主平台入口缓存更新为 `20260724-v117-17`。视频工坊静态缓存保持不变。

### 验证结果

- 供应商问答定向回归 `9/9` 通过：问候、日期统计、回传链接、权限裁剪、MiniMax-M3 使用账本和模型不可用时的明确错误路径均已覆盖。
- `server/main.py` Python 编译及供应商相关前端模块 JavaScript 语法检查通过。
- 验证本身未发送真实语言、图片或视频模型请求，也未主动创建、编辑或删除账号、交付、回传链接、观看量或素材。为加载新后端按标准启动器重启后，已有本地浏览器的自动恢复向本机写回一次既有批次快照（`/api/db/batches` 返回成功）；本轮没有发起任何供应商业务写操作，也未触碰服务器数据。

### 数据与部署

- 本版仅修改本地代码、回归和版本 / 避坑记录，尚未推送或部署。后续部署只能精确同步已审计的代码与静态文件；严禁覆盖 SQLite、成员、账号、资产、发布清单、回传链接、观看量、上传、成片、画布、认证或私密环境。
- 模型服务是否可用必须在真实供应商登录态下只读验证；若服务端返回模型不可用提示，应检查服务器已有私密环境和上游可达性，不得写入、输出或重置任何密钥。

## v117.16 - 2026-07-24（图文参考图实际路由与供应商问答模型补全）

### 本版范围

- 修正批量图文的最后执行边界：不论视觉模型规划或视觉模型不可用时的均衡回退，每张图都只提交该图已选的统一参考图 / 定制参考图子集，不再在生成前把全部参考图重新写回每一张。遇到异常的“所有附件分给所有图”视觉规划时，服务端只保留每张统一图的一个确定性主图卡，其余真实的多图分配仍保留。
- 图文参考图编排会明确区分品牌标识、完整主素材、证据截图与风格辅助。非 Logo 的截图、产品图、海报和文件图默认作为某一图的完整主体，围绕其排版；完整提示词会保留原本主题、正文节拍、版式和文字规格，并附带“参考图名称 / 附件编号 / 用途 / 位置”，不会长篇复述附件画面。
- 供应商数据助手除原始回传链接外，均把同一份服务端角色授权快照交给 MiniMax-M3。日期、数量、播放量等先由服务端写入不可改写的权威结论，模型只能在其后补充基于快照的解释；回传链接仍由服务端直接返回，确保逐条 URL 完整且可复制。
- 主平台入口与图文工作台模块缓存更新为 `20260724-v117-16`；视频工坊静态缓存保持 `20260722-25`。

### 验证结果

- 批量参考图前置规划 / 均衡路由 / 提示词注入、图文文案参考、供应商问答（日期、链接、权限范围、MiniMax-M3 模拟调用）和资产混合快照权限回归通过。
- 主服务 Python 编译、相关前端 JavaScript 语法检查、前端模块缓存身份检查与精确差异检查通过；未发送真实语言、图片或视频模型请求。

### 数据与部署

- 本版仅在本地工作区，尚未推送或部署。后续部署必须同时带上 `server/store.py` 的 `f16bd44` 混合资产快照保护及 `server/main.py` 的实际写入计数返回。
- 只能精确同步已审计的代码 / 静态文件；禁止同步或覆盖 SQLite、账号、交付、回传链接、观看量、上传、成片、画布、视频工坊运行数据、认证和私密环境。

## v117.15 - 2026-07-24（供应商数据助手权威日期问答与资产混合快照保护）

### 本版范围

- 供应商端数据助手改为服务端受权数据问答：供应商管理员和子账号只能读取与其首页相同范围内的账号与已交付内容，前端不再用整页本地规则把“昨天交付多少条”误答成累计总数。
- “今天 / 昨天 / 前天 / 指定日期”的交付数、已回传链接数、播放量、账号发布排行和链接列表由服务端按中国时区直接从权威交付字段计算；准确数字不交给模型猜测。开放式趋势、节奏和汇总问题会把同一份已授权、裁剪后的数据快照交给部署的 MiniMax-M3，并记录已返回 `usage` 的语言调用账本。
- 问答在页面中先显示原地加载气泡、完成后替换为答案；对话区、输入框和当前页面布局均不重绘。模型服务不可用时保留“今天 / 昨天 / 前天”本地只读回退，不会显示错误的全局累计值。
- 以提交 `f16bd44` 的修复为基线移植资产混合快照保护：创作者提交包含他人已更新交付和自己新交付的陈旧快照时，服务端跳过不可修改的他人行但仍保存自己的新增行；仅含越权改动的请求仍拒绝。该修复不会改写既有资产、账号或交付数据。
- 初始主平台入口缓存更新为 `20260724-v117-15`；后续图文路由与问答优化升级为 `20260724-v117-16`，视频工坊静态缓存保持 `20260722-25`。

### 验证结果

- 新增供应商助手定向回归：昨天日期统计、日期范围链接 / 播放量、供应商子账号可见范围、MiniMax-M3 模拟调用与 `usage` 旁路记录、前端异步调用均通过。
- 资产混合快照修复回归通过：他人记录保持不变、自己的新交付可保存、纯越权请求仍拒绝。
- 主服务完整发现回归、Python 编译、相关前端 JavaScript 语法检查和精确差异检查通过；验证没有发送真实语言、图片或视频模型请求。

### 数据与部署

- 本版目前只在本地工作区，未提交、未推送、未部署。后续部署必须同时包含本版 `server/store.py` 的资产混合快照保护，不能用旧文件覆盖服务器的 `f16bd44` 修复。
- 部署只能精确同步已审计的代码 / 静态文件；禁止同步或覆盖 SQLite、账号、交付、回传链接、观看量、上传、成片、画布、视频工坊运行数据、认证和私密环境。供应商问答只读验收不得执行任何业务写入。

## v117.14 - 2026-07-24（图文参考图先写文案与视频素材语义落位）

### 本版范围

- 图文工坊在“标题已填、正文尚未生成”的路径中，先让视觉模型只查看统一参考图并生成简短的内容关联摘要；MiniMax-M3 再用标题、账号语气和该摘要正常编写完整正文。摘要只帮助判断真实场景、证据、功能关系或叙事角度，不会把图片外观、文字或物体清单重复塞进正文。
- 文案完成后，逐图参考编排才结合标题、正文和图卡规划选择实际需要的统一参考图；每张图片请求只收到自己的附件。多张统一参考图不再默认在每张提示词中全量出现；视觉模型不可用时也会采用稳定的均衡回退，不会把所有附件复制到所有图卡。
- 单号图文仍会查看统一参考图后再写正文；单张定制参考图只在该图的完整提示词与生成请求中参与，并会思考它在本图承担的主体、证据或版式角色，绝不会进入其他图或污染正文。
- 视频工坊将素材放置从“文件名像 Logo 就固定角落”改为导演语义决策：普通剪辑素材默认作为中心 / 全画面的叙事证据；Logo 只有用户明确要求角标、水印或角落时才小尺寸角标。口播提及品牌或产品、且用户上传真实 Logo 时，导演会在对应关键镜头选择真实附件作为 reference 或 both，避免凭空重绘错误品牌标志。
- 主平台的图文链路及其缓存闭包更新为 `20260724-v117-14`；视频工坊没有新增静态构建，仍沿用 `20260722-25`。

### 验证结果

- 图文文案、统一参考图路由、单图定制隔离、图片参考回执、前端缓存身份、视频发布文案与数字人 / 视频导演语义定向回归通过。
- 视频工坊完整回归 92 项通过；主服务完整发现回归、Python 编译与本次前端 JavaScript 语法检查通过。
- 未调用语言、图片或视频模型；未创建或改写账号、交付、素材、画布、发布清单、观看量或供应商业务数据。

### 数据与部署

- 本版目前仅在本地工作区，未提交、未推送、未部署。部署时只能精确同步已审计的代码 / 静态文件，绝不能同步 SQLite、业务数据、上传、成片、画布、视频工坊运行数据、认证或私密环境。
- 若服务器没有可用视觉模型，系统会诚实降级为标题写正文和均衡附件路由，不会声称模型看过参考图；部署前由服务器线程只读核验视觉模型可用性即可。

## v117.13 - 2026-07-24（图文参考图前置编排与真实模型调用账本）

### 本版范围

- 图文提示词流程调整为：先由视觉模型结合标题、正文、图卡草案和真实参考图，逐图决定统一参考图该附到哪里、附件在画面中的角色与位置；再由 MiniMax-M3 按原有完整图卡规格生成每张提示词；最后只向被规划选中的图片生成任务提交对应附件。
- 统一参考图不再默认无差别附给全部图卡；视觉规划可明确某张不使用参考图。单张定制参考图带有图卡范围约束，只能用于当前图；新增或替换后会在本图生成前按同规格完整重写提示词，用户已经手改的提示词不会被覆盖。
- 提示词会保留正常的主题、信息层级、构图、版式和文字规格，并明确附件应放在哪里 / 承担什么角色；不会重复长篇描述已随请求提交的参考图内容。
- 管理员模型用量账本除上游返回的语言 Token 外，新增实际成功的图片调用（张）和视频调用（任务）记录与按成员明细；不把图片 / 视频伪装成 Token，也不会估算补写历史调用。新表仅为追加式 `api_usage_events`。
- 主平台缓存标识更新为 `20260724-v117-13`；视频工坊静态缓存保持 `20260722-25`。

### 验证结果

- 图文参考图、批量路由、单图定制隔离、图片参考回执、图文文案与数字人相关定向回归共 64 项通过。
- `python3 -m py_compile` 通过 `server/main.py`、`server/store.py`；`node --check` 通过本次涉及的前端模块；本次精确文件 `git diff --check` 通过。
- 未调用任何图片、视频或语言模型；未创建或改写账号、交付、素材、画布、发布清单、观看量或供应商业务数据。

### 数据与部署

- 本版仅包含代码、样式、测试和版本记录；不含数据库、业务数据、上传、成片、画布、认证或私密环境。
- 后续部署只能精确同步已推送的代码 / 静态文件。数据库仅允许启动时幂等创建新的调用账本表，严禁同步或覆盖线上 SQLite、账号、交付、分析、上传、成片、画布、视频工坊运行数据、认证和私密环境。
- 若服务器未配置明确的视觉模型，系统不会假称 MiniMax-M3 已看图：会保持真实附件传图的安全回退，但不会做虚假的视觉路由；部署前需由服务器线程只读核验视觉模型配置可用性。

## v117.9 - 2026-07-23（交付全局编号与播放量可追溯明细）

### 本版范围

- 发布清单新增所有交付物共用的只读全局序号投影，管理员、创作者、供应商管理员与供应商子账号即使各自只看见部分内容，也会显示同一编号；排序只按交付进入发布清单的时间，不按发布人或当前筛选集重新计数。
- 服务端新增受控的历史编号校准：按既有交付时间把历史 `pubSeq` 一次性校正为连续全局编号；校准后新交付由服务端唯一账本分配下一号，旧浏览器的个人本地计数不会覆盖已确认编号。该迁移只修改交付编号及并发保护时间戳，保留账号、素材、回传链接、观看量和供应商状态。
- 创作端“总播放量”改为可点击的逐条回传链接明细，仅汇总已有同步 / 回填观看量的链接；明细支持平台、近 7 天、近 30 天与自定义日期筛选，卡片总数与明细口径一致。
- 供应商首页右侧数据助手与左侧主看板固定在同一网格行拉伸，顶部对齐保持不变，底部也与最近操作区域齐平；长消息仍仅在助手消息区滚动。
- 创作者“我的”改为居中圆形头像的个人资料卡，昵称、账号和密码按纵向分隔行编辑；头像支持点击选图与直接拖入图片，头像区和每个资料行均提供悬停 / 键盘聚焦反馈。
- 修正供应商首页右栏与主看板的同高逻辑：两侧共享受限视口高度，右栏长消息只在内部滚动，左侧 KPI 不再被多余高度拉伸。
- 主平台入口、看板样式、发布清单、个人资料与创作总播放量模块初始缓存标识更新为 `20260723-v117-11`；随后播放量热修复升至 `20260723-v117-12`。视频工坊静态缓存仍为 `20260722-25`。

### 验证结果

- 主服务 Python 编译、关键前端模块 JavaScript 语法检查、供应商状态 / 账号管理 / 发布清单筛选 / 前端缓存 / 创作流程定向回归共 60 项通过。
- 本地健康接口正常；确认本地服务实际返回新的 `v117-11` 看板样式和入口模块。
- 未执行历史编号迁移，未写入账号、交付、链接、素材、观看量或任何服务器业务数据；未推送、未部署。

### 数据与部署

- 下次受保护部署须先建立数据库快照，再由管理员权限调用受控编号校准接口一次；完成后再次核验管理员、创作者、供应商管理员、供应商子账号对同一交付显示相同编号。
- 部署包只能包含已推送的受控代码 / 静态文件，不得同步本地 SQLite、账号、交付、分析、上传、画布、视频工坊运行数据、认证或私密环境。
- 2026-07-23 已将受控提交 `5111913` 部署到生产；主平台入口静态资源确认加载 `20260723-v117-11`，视频工坊保留 `20260722-25`，主服务与视频工坊服务健康。
- 本次从干净目标工作区精确同步 29 个代码 / 静态文件，未使用删除式同步。部署前建立独立 SQLite 快照与代码 / 静态回滚点；部署后 SQLite 完整性正常，受保护目录与私密环境指纹一致。资产集合在部署窗口出现 2 条并发业务新增，未发生集合减少或本地数据覆盖。
- 管理员只读浏览器验收确认首页、总播放量明细与目标静态资源正常加载。历史编号校准接口仅提供受管理员认证保护的服务端 POST，当前无安全的前台受控入口可调用，未绕过认证执行迁移；待提供明确的管理员受控操作入口后再执行并复核跨角色编号。
- 2026-07-23 已将热修复提交 `942ebec` 部署到生产，仅更新 `index.html`、`js/main.js` 与 `js/views/overview.js`。真实管理员页面确认总播放量不再按接口链接归零，历史供应商填写的播放记录会进入总计和只读明细。
- 热修复前建立独立 SQLite 快照与代码 / 静态回滚点；部署后 SQLite 完整性正常，私密环境指纹不变。资产、定制项目及上传目录在部署窗口出现并发业务新增，未发生集合减少、数据覆盖或迁移；未执行编号校准。

## v117.8 - 2026-07-23（数据助手固定输入与趋势明细）

### 本版范围

- 创作端与供应商端数据助手的消息区改为独立滚动容器：长回答只在消息区内滚动，输入框、快捷提问与发送按钮始终留在可见底部；供应商右栏不再被左侧整页内容拉伸。
- 供应商首页平台发布构成升级为可单独交互的蓝色小红书 / 红色视频号扇区，悬停或键盘聚焦会突出当前平台并显示数量，点击可查看对应平台的发布明细。
- 创作端与供应商端近 7 日趋势都新增 30 日与自定义时间入口；30 日数据可横向查看，点击趋势、日期节点或“查看明细”会打开按时间筛选的明细弹窗。自定义起止日期可应用回两端对应趋势图。
- 主平台前端缓存标识更新为 `20260723-v117-8`；视频工坊静态缓存仍为 `20260722-25`。

### 验证结果

- 创作端本地页面确认助手消息区独立滚动、输入框固定可见，趋势 7 日 / 30 日 / 自定义入口加载；供应商端与创作端定向单元回归、JavaScript 语法与源码差异检查通过。
- 未执行账号、供应商、交付、画布或服务器业务写操作；未推送、未部署。

## v117.7 - 2026-07-23（创作者资料与画布多参考图尺寸）

### 本版范围

- 创作者端左侧导航新增“我的”，可只编辑本人姓名、账号、密码和头像；头像经独立的本人资料接口保存，管理员设置的成员卡片同步显示最新头像，不开放创作者修改他人资料或角色。
- 供应商数据助手的“今日回传”新增“复制全部”，一次复制当天全部回传链接的账号编号、账号名和链接；单条链接复制继续保留。
- 无限画布的“按参考图尺寸”在多张参考图时逐张显示名称、原始像素和比例，用户可选对应图片尺寸；仍不会在后续拖入参考图时自动覆盖已选尺寸。
- 无限画布输入框支持普通文本粘贴、Command / Ctrl + V 图片粘贴和“粘贴参考图”按钮读取剪贴板图片；Enter 立即开始创作、Shift + Enter 换行。供应商数据助手也支持 Enter 发送。
- 主平台前端缓存标识更新为 `20260723-v117-7`；视频工坊静态缓存仍为 `20260722-25`。

### 验证结果

- 主服务完整单元回归、创作者资料 / 供应商助手 / 画布尺寸定向回归、Python 编译、JavaScript 语法、无限画布 TypeScript 类型检查、ESLint 和嵌入式生产静态构建通过。
- 不执行成员资料、头像、供应商回传或画布业务写操作；未推送、未部署。

### Git 与部署

- 2026-07-23 已部署受控提交 `defe1c2`。仅同步了精确的代码与静态资源；线上入口已确认加载 `20260723-v117-7`。
- 部署窗口内检测到 `docs` 集合新增 2 条正常业务写入，SQLite 完整性仍为 `ok`；为避免抹除用户刚写入的数据，未执行回滚。部署包未包含业务数据库、账号成员、资产、上传、成片、画布项目/blob、视频工坊运行数据、认证或私密环境。

## v117.6 - 2026-07-23（无限画布尺寸与数据看板清晰化）

### 本版范围

- 无限画布初始尺寸菜单新增“按参考图尺寸”：添加参考图后，以第一张参考图的原始宽高直接建立画布；没有参考图时按钮禁用并提示先添加。
- 参考图只在用户主动点击“按参考图尺寸”时生效；用户手动选定尺寸后再拖入参考图，不会覆盖原有尺寸选择。
- 预设尺寸与当前尺寸均显示“宽 × 高 · 比例”，例如 `1080×1920 · 9:16`；自定义宽高输入明确标注单位为像素 `px`。
- 供应商管理员首页的数据助手新增“今日回传链接”：自动发送当天全部已回传链接，按账号显示序号标记，并为每条链接提供一键复制；对话继续按当前供应商管理员账号独立保存。
- 管理员“创作者接口用量”刷新改为仅原位更新用量卡片，不再整页重绘、闪跳；用量和明细仅来自服务端实际留存的上游 `usage` 字段，不能可靠追溯的历史调用不估算补写。创作者用量与展开后的产品库均改为紧凑卡片网格。
- 主平台前端缓存标识更新为 `20260723-v117-5`；视频工坊静态缓存仍为 `20260722-25`。

### 验证结果

- 无限画布尺寸选择定向回归、供应商账号与看板回归、创作流程与 Token 用量回归、TypeScript 类型检查、ESLint、嵌入式生产静态构建和静态产物检查通过。
- 未调用模型、未创建画布项目、未上传或写入任何业务数据；未推送、未部署。

### Git 与部署

- 本地提交仅包含无限画布 UI 源码、必要静态构建、测试与版本记录；待用户明确授权后才推送。

## v117.5 - 2026-07-23（视频工坊无私密环境回归隔离补齐）

### 本版范围

- 时长修订导演语义测试显式注入测试用 LLM 设置，不再借用本机私密环境中的 Key。
- 流水线事务公共 fixture 补齐时序视觉导演 mock，返回与真实契约一致的分镜、最小单元数、公开摘要和素材落位；QA 失败和通知失败测试可抵达各自真正的事务边界。

### 验证结果

- 无私密环境下，导演语义 30 项、流水线事务 4 项、完整视频工坊 90 项和主服务完整回归均通过。
- 生产部署前再次完成主服务 324 项与视频工坊 90 项完整回归，以及 Python、JavaScript、Shell 和差异格式检查。
- 生产主服务与视频工坊 sidecar 健康；主平台实际加载 `20260723-v117-3`，视频工坊与无限画布入口均可打开。
- 已登录管理员只读烟测通过：首页正常渲染，视频工坊历史项目列表可见；无限画布项目库可见，所有可见项目缩略图均成功加载，浏览器无应用级错误或警告。

### Git 与部署

- 已部署精确提交 `4789521`。仅同步 123 个受控代码 / 静态文件，并仅移除 7 个已被新构建替代的哈希静态文件；未同步本地 state、SQLite、业务数据、媒体、模型缓存、认证或私密环境。
- 部署前后的数据库集合基线、受保护目录指纹和私密环境指纹均保持一致；SQLite 完整性检查通过。已创建独立的代码 / 静态回滚点与数据快照；当前代码回滚备份为 3 份，未达到轮换阈值，数据快照未参与轮换。

## v117.4 - 2026-07-23（视频工坊真实时序回归补齐）

### 本版范围

- 补齐“先测真实口播时长、再提交镜头时长”的流水线回归：mock 当前必经的时序视觉导演，并返回真实消费的分镜、最小单元数、公开摘要和素材落位结构。
- 回归明确断言时序导演在 Seedance 提交前被调用，避免测试因未 mock 的外部导演依赖提前失败后掩盖真正的时长顺序问题。

### 验证结果

- 该用例 17 项通过；主服务完整回归和视频工坊完整回归通过，其中视频工坊 90 项通过。
- 仅修改测试与版本 / 避坑记录，不改生产流水线、不调用模型、不写入业务数据；未部署生产。

### Git 与部署

- 本版随当前分支中尚未推送的 v117.2、v117.3 一并精确推送。部署只同步已推送代码与必要静态文件，必须保留服务器原有业务数据、认证与私密环境。

## v117.3 - 2026-07-23（音色工作台单侧动效修正）

### 本版范围

- 音色合成、音色设计、音色管理切换时，左侧音色库与中间口播输入板固定为原 DOM；只有右侧功能面板执行平滑退场 / 入场。
- 主平台前端缓存标识更新为 `20260723-v117-3`；视频工坊静态缓存仍为 `20260722-25`。

### 验证结果

- 音色工作台 JavaScript 语法检查、布局 / 节点保留定向回归（5 项）与修改文件差异格式检查通过。
- 未调用语音模型、未写入音色、账号或任何业务数据；未推送、未部署。

### Git 与部署

- 本地提交只包含语音工作台源码、样式、回归与版本记录；待用户明确授权后才推送。

## v117.2 - 2026-07-23（供应商账号编号稳定性修复）

### 本版范围

- 供应商账号的显示编号首次确定后写入账号记录；停用或恢复不会再因 SQLite 物理行顺序变化而重排编号。
- 历史未编号账号继续按原有顺序补位，同时避开已持久化编号，防止停用过的账号与其他账号重号。

### 验证结果

- 新增停用 / 恢复前后全量编号一致性回归，并通过供应商账号序号与账号管理定向测试（14 项）、Python 编译和差异格式检查。
- 未触发账号状态、分配、上传、发布或任何本地 / 服务器业务数据写入；未推送、未部署。

### Git 与部署

- 本地提交只包含服务端编号投影、对应回归与版本记录；待用户明确授权后才推送。部署时仍必须保留服务器原有业务数据、认证与私密环境。

## v117.1 - 2026-07-23（供应商账号卡片紧凑热修）

### 本版范围

- 移除未填写主页链接时的“主页链接请在编辑账号中填写”占位文字；实际主页链接仍可从“编辑账号”对话框维护。
- 将编辑、停用 / 恢复图标与“分配给”下拉固定在账号卡片同一行，缩短卡片纵向高度并保持分配操作清晰可见。
- 主平台前端缓存标识更新为 `20260723-v117-2`；视频工坊静态缓存仍为 `20260722-25`。

### 验证结果

- 供应商账号视图 JavaScript 语法检查、账号管理定向回归（9 项）与修改文件差异格式检查通过。
- 未触发账号、分配、停用、上传、发布或任何本地 / 服务器业务数据写入；未部署生产。

### Git 与部署

- 本热修仅提交供应商账号卡片源码、样式、定向测试与版本记录；部署时只同步已推送代码，必须保留服务器原有业务数据、认证与私密环境。

## v117 - 2026-07-23（供应商与管理员设置看板收敛、音色无闪切换、画布定向编辑验收）

### 本版范围

- 供应商设置将“子账号申请”提升为独立申请看板，并增加刷新入口；申请与全部供应商账号均使用一体化卡片，不再由多层分割线切碎页面。全部账号保持多列紧凑排布。
- 供应商全部内容账号把主页链接编辑并入“编辑账号”对话框，卡片只保留主页链接状态；编辑与停用 / 恢复收为同一行图标操作，账号分配继续保留明确文字标签和下拉选择。
- 创作端管理员设置改为首页式信息看板：成员申请置顶、成员账号按多列紧凑卡片展示并用不同身份色标识，产品库默认折叠。接口用量主表适配宽屏，不再要求横向拖动；可分别打开每个账号的 API / 模型汇总和最近真实调用，也可查看全量明细。
- 供应商数据助手的三个快捷问题固定为一行等宽按钮，窄卡片下按文本省略而不改变输入区位置。
- 音色合成、音色设计、音色管理切换时，中间口播文本编辑器保留同一 DOM 节点和焦点 / 输入法状态；仅左侧音色库与右侧工具面板执行平滑退场 / 入场，不再整块闪烁重建。
- 无限画布定向编辑补齐“调整为 / 改为 / 替换为图 N”的风格供体识别，避免把供体图误加入编辑任务。新增 10 轮确定性识别与任务分派回归，只执行本地规划，不请求模型、不写画布数据；同步更新嵌入式静态构建。
- 主平台前端缓存标识更新为 `20260723-v117-1`；视频工坊静态缓存仍为 `20260722-25`。

### 验证结果

- 主平台修改模块 JavaScript 语法检查、Python 编译、画布 TypeScript 类型检查、ESLint 与嵌入式静态构建通过。
- 定向回归覆盖音色编辑器节点保留 / 面板动效、供应商申请刷新与主页编辑合并、账号停用忙态、接口用量个人明细，以及无限画布 10 轮多参考图目标识别。
- 未做模型调用、账号创建 / 停用、素材上传、发布或画布写入；未部署生产。

### Git 与部署

- 本版仅精确提交前端、服务端回归、无限画布源码及对应静态产物、`version.md` 与 `Problem Document.md`。不纳入数据库、成员账号、业务资产、画布 blob、视频工坊 runtime / uploads / outputs、认证缓存、私密环境或既有工作区遗留文件。
- 生产部署仍需用户明确授权；部署时只能同步已推送代码与必要静态文件，并保留线上 SQLite、账号、发布清单、uploads、composed、画布项目与私密环境。

## v116 - 2026-07-23（本地交互、供应商权限与音画自修复完成，待供应商角色视觉验收）

### 本版范围

- 供应商首页把“搜索账号或已交付内容”和“批量建立子账号”收进全局顶部栏，与页面标题、全局搜索和通知处于同一操作层；页面不再重复占用一整行页头，首屏统计、图表和最近操作整体上移，底部保留更明确的滚动余量。
- 近 7 日交付趋势不再把 SVG 的圆形节点放进非等比缩放坐标系。折线仍可自适应铺满卡片，节点改为独立固定圆形锚点；悬停或键盘聚焦会显示该日期的实际交付数量。
- 供应商数据助手改为受视口约束的独立粘性卡片，并与左侧“已发布”指标顶边对齐；问题输入框、发送按钮和快捷提问始终位于卡片内可用区域。每个登录供应商账号的问答记录以本机账号隔离键保留最近 40 条，刷新、筛选重绘或返回首页后不会消失。
- 最近操作在多页时每 3 秒只替换自身列表内容，按行做平滑翻转退场 / 入场；不再调用首页整体重渲染，因此统计、图表、问答输入和页面滚动位置不会闪动。保留前后翻页、完整记录筛选、卡片边框、圆角和底部渐隐。
- 供应商端取消底部悬浮导航，改回与创作端一致的左侧竖向导航；角色筛选保持不变：供应商管理员可见首页、全部账号、发布清单、设置和退出，供应商子账号仅见发布清单与退出。供应商页面不再受居中最大宽度限制，右侧数据助手贴齐主内容区右缘。
- 供应商编辑账号时不再显示数字人角色版、固定口播声线或参考音频控件；服务端供应商账号写入白名单同步拒绝角色版与声线字段，直接构造请求也不能覆盖创作者原有配置。
- 供应商建立 / 编辑账号时移除“账号图片资产”上传区；账号头像仍可维护。服务端专用账号接口只接受带“头像”标签的随账号资产，通用图片资产即使被直接构造请求也会被丢弃。
- 管理员“创作者接口用量”新增“查看 API 明细”：按调用功能与模型分别汇总调用次数、输入 / 输出 / 合计 token 和最近时间，并列出最近 120 笔可核验调用及对应创作者；明细继续只使用上游返回的 usage 字段，不把图像、视频、语音或缺失 usage 的请求估算进去。
- 供应商全部账号的搜索、新建账号、平台筛选与设置页的“批量建立子账号”统一上移至全局顶部栏；设置页移除仅承载按钮的空白页头，供应商账号改为可多列排列的紧凑横向卡片。首页主看板增加适度上左留白、收紧右侧助手宽度，并保持两栏底边对齐。
- 供应商发布清单的“已选 N 条”改为右上固定角标，不再参与筛选工具栏的流式换行，选中内容不会再把批量下载和表格顶下去。
- 创作端语音页把“切换模式”标记和缩窄后的模式页签保留在文本编辑器右上，生成音频按钮移至右侧调试台标题栏，避免与编辑器标题和模式切换争抢横向空间。
- 无限画布会识别“图 2 修改风格”“把这两个参考图都换成……”等定向编辑语义：指定单图时只为该图建立编辑任务；明确多图同时编辑时按图创建独立并发任务。每个任务把自己的原图作为第一输入，其余选图仅作风格参照，服务端同时禁止把多参考图编辑退化成无关新图、拼图或多图合成。
- 无限画布 iframe 入口随主平台更新为 `20260723-v116-5`，静态构建使用新项目页哈希；同步时保留工作区既有的旧生成 chunk，不做全量删除或覆盖。
- 管理员“创作者接口用量”404 经核对并非路由缺失：源码已有 `/api/admin/llm-usage`，但本机 8787 仍在运行旧 Python 进程。标准启动器重启后接口在未登录时返回预期 401，管理员页面正常读取真实 token 汇总。
- 视频工坊遇到超过基础容差的成片音画偏差时，不再直接以失败结束：保持口播轨不变，自动重新编码并按实测口播时长校正画面轨；成功后记录“已自动重校”事件，再继续默认节奏版与质检。仅在源轨比例已超出可安全处理范围或本地媒体工具确实失败时才保留可恢复错误。
- 主平台前端缓存标识更新为 `20260723-v116-5`；视频工坊静态缓存仍为 `20260722-25`。

### 验证结果

- 主服务全量单元回归 `322/322`、视频工坊全量单元回归 `90/90` 通过；无限画布 TypeScript 类型检查、ESLint、嵌入式静态构建通过，画布 + 供应商 + 用量 + 声音模块定向回归 `46/46` 通过。覆盖顶部工具栏、局部轮播、问答历史、左侧导航、角色版 / 声线、通用账号资产服务端保护、停用恢复，以及多参考图定向并发编辑与目标图优先顺序。
- 标准 `./start.command` 重启后，主平台健康接口正常、视频工坊 sidecar `ready`；主平台静态入口已切换为 `20260723-v116-5`。
- 已登录管理员浏览器实际打开“设置”，用量表从加载态进入成员汇总，未再出现 HTTP 404；当前浏览器实际历史视频项目保留“继续”后真实重新合成、检查与交付的记录。
- 当前浏览器会话为管理员身份，未读取或输入供应商测试账号凭据；供应商专属的顶部布局与停用写链路仍应由用户指定的安全供应商账号继续验收。

### Git 与部署

- 本版只在本地修改，未提交、未推送、未部署。后续仅可精确选择本版前端、视频工坊、定向测试、`version.md` 与 `Problem Document.md`；不得带入数据库、账号、业务资产、画布 blob、视频工坊 runtime / uploads / outputs、认证缓存、私密环境或既有工作区遗留文件。
- 生产部署仍只允许同步已推送的代码和必要静态文件，必须保护线上 SQLite、成员、账号、发布清单、uploads、composed、画布数据、视频工坊运行数据、模型缓存与私密环境。

## v115 - 2026-07-23（功能提交完成，待平台部署8号继续）

### 本版范围

- 单号图文创作的每张图卡新增独立“定制参考图”入口，支持点击上传和拖入图片。逐图参考只叠加到当前图的生成请求；原有统一参考图继续保留，其他图、批量图文及已生成图片不受影响。
- 管理员“设置”新增创作者语言模型用量看板。服务端只在上游真实返回 usage 时记录调用次数、输入 / 输出 / 总 token 与最近调用时间；该面板明确不把图像、视频、语音或供应商计费伪装成“API 积分”。
- 供应商账号页将搜索与新建账号收进同一操作栏；账号停用成功后立即切换为“恢复账号”，卡片使用淡红停用态，并从批量创作与单号可用账号中剔除；单号侧保留底部默认折叠的“已停用账号”分组用于识别历史账号，但不能进入创作。供应商管理员编辑账号时不再显示或提交账号风格和图文提示词模板，避免误改创作端专属配置。
- 供应商首页调整为与创作端一致的数据工作台结构：四个指标收进左侧主栏，平台分布、平滑近七日趋势和可轮播最近操作置于其下，右侧只读数据助手完整占据独立列并保留底部对话框；批量建立子账号移至搜索旁边；最近操作可打开带操作 / 时间筛选及精确时间的完整记录弹窗。数据助手中的链接会以可点击链接展示并自动换行。
- 供应商发布清单会按当前筛选范围实时显示勾选数量，全选、逐条勾选与筛选切换时同步更新，批量下载只处理当前可见且选中的记录。
- 账号申请的“姓名 / 昵称”栏增加“请使用真实姓名”提示，并以克制的低频位移动效提醒；系统开启减少动态效果时自动关闭动画。
- 视频工坊改为以真实口播轨作为最终时间轴：几秒内的编码、切镜与尾帧偏差会自动把画面轻微重定时到口播时长，不再因为小误差中断；超过自适应容差的明显音画错位仍阻止交付。旧项目即使已经被后续问答覆盖为“会话”状态，也会从历史错误恢复可执行的合成阶段；用户输入“继续”或“没关系继续合成”会真正调度字幕、合成和检查任务，不再只追加说明文字。
- 供应商账号停用 / 恢复按钮提交后立即显示“正在停用…”或“正在恢复…”；服务端成功后直接使用权威返回更新卡片，不再等待无关集合的全量持久化，因此确认操作后不会出现长时间无反馈。
- 主平台静态缓存标识更新为 `20260723-v115-3`，确保逐图参考、供应商首页、停用反馈、勾选计数和看板脚本不会被旧缓存混用。

### 验证结果

- 逐图参考隔离、供应商编辑权限、账号停用 / 恢复、发布清单勾选计数、实名提示、管理员语言模型用量、视频工坊自适应音画校正 / 历史错误继续合成、模块缓存与静态缓存策略均纳入定向回归。
- 主服务全量单元回归 `318/318`、视频工坊全量单元回归 `89/89` 通过；本轮 JavaScript 语法检查、Python 编译和指定源码差异检查通过。
- 本地 `8787` 健康接口正常；`js/main.js?v=20260723-v115-3` 与 `styles/views.css?v=20260723-v115-3` 作为本轮目标缓存标识。浏览器只读烟测不执行账号创建、停用、上传、生成或发布等业务写操作。

### Git 与部署

- v105–v115 累积功能代码、回归测试与必要静态构建已形成可追踪功能提交 `6eb96bc`；GitHub 仓库为 `wduan1212-rgb/ACG-XZ`，当前及后续默认开发分支仍为 `codex/v1-star-array-batch-image`。如后续确需另开分支，继续使用 `codex/` 前缀，并从已推送提交创建，禁止从混有本地遗留文件的工作区整体复制。
- 本版未部署生产。交接给“平台部署8号”后，先继续完成本记录所列未验收项，再按代码与静态文件精确清单部署；不得带入 SQLite、账号、成员、资产、发布清单、uploads、composed、画布 blob、视频工坊 runtime / uploads / outputs、认证缓存、私密环境或历史遗留删除项，且必须保留线上全部业务数据。

## v114 - 2026-07-23（本地稳定性修复完成，待用户验收）

### 本版范围

- 修复本地视频工坊出现“主平台仍在运行、视频工坊服务未运行（127.0.0.1:8765 ConnectError）”的启动生命周期竞态。每个 Finder / Terminal 启动器现在拥有独立实例标识；旧启动器退出时只停止自己启动的 sidecar，不能再误停接管端口的新实例。
- `start.command` 与 `start-shared.command` 在主服务存活期间启动同实例 sidecar 健康守护：连续两次健康检查失败才恢复 sidecar，避免单次探测抖动中断正在进行的任务。主服务退出时才由所属启动器一并清理其 sidecar。
- 复核上轮供应商功能的完整链路：供应商子账号、供应商管理员与创作端的交付详情均读取同一回传时间；供应商首页已具备可点击指标、可视化图表和只读数据问答；供应商管理员可新建、编辑、停用 / 恢复账号，历史数据保留，创作端单号保留已停用账号可查看、批量自动排除；账号与当天“新”提示使用同一份全局账号状态。

### 验证结果

- 新增真实进程级回归：模拟启动器 A 退出、启动器 B 已接管 sidecar 的场景，A 只会结束自己的子进程，B 的 sidecar 保持存活。
- 视频工坊启动 / 恢复、主平台同源代理、供应商账号管理、供应商状态、账号序号 / 视图、交付状态筛选与批量队列回归共 `55/55` 通过；启动脚本语法、相关 JavaScript 语法与 `git diff --check` 通过。
- 本地 `8787` 主服务和 `8765` sidecar 健康接口均为 ready；浏览器直接打开 sidecar 首页可见“新建会话 / 描述想制作的视频 / 开始创作”，控制台 0 error / 0 warning。主平台未登录时仍正确显示登录失效提示，不以未授权状态伪装成 sidecar 故障。

### Git 与部署

- 本版仍只保存在本地：未提交、未推送、未部署、未通知服务器部署任务。
- 后续提交仅可精确包含启动脚本、对应回归、`version.md` 与本次问题记录；不得带入 `runtime/`、视频工坊 projects / uploads / outputs、SQLite、账号、资产、浏览器缓存、认证信息或历史工作区删除项。部署只能更新代码与静态文件，必须保留线上全部业务数据与私密环境。

## v113 - 2026-07-22（本地验证完成，待用户验收）

### 本版范围

- 视频工坊把用户要求的成片时长明确为最终交付下限：默认交付仍为 `1.2x`，真实交付不得短于用户要求；叙事自然需要时允许多约 15–30 秒。该规则只用于真实口播与最终成片校验，不向导演注入固定镜头数、固定切镜间隔或“一句口播几个镜头”等创意约束。
- 口播时长由 MiniMax 实际生成音频和 FFprobe 决定，不再用字数估算冒充结果。主题创作在实测交付时长不合格时最多进行 3 次有界文案复核，用户明确提供的逐字稿和上传口播不被改写；最终仍短于要求会明确停止，不交付过短成片。
- 导演先完成叙事规划，再在真实口播生成后锁定音画时间线。长叙事段会拆成不超过 Seedance 单次技术上限的独立视觉单元，每个单元只携带自己的视觉节拍，不再重复整段提示词或复用相邻片段画面；全局继续共用 10 个 Seedance 槽位，超出部分排队。
- 视频提示词保持纯画面职责：去除口播原文、字幕式叙述和无关文本，只允许导演明确要求的短界面标签；参考图按导演选中的场景使用，剪辑素材按口播语义锚点进入合适位置，不再把所有附件平均挂到全部镜头。
- 修正“主题”与“逐字稿”识别：只有用户明确要求原文照读 / 不改字时才锁定逐字稿模式，普通“来一条某主题的视频”保持导演自由创作。导演漏填可选顶层视觉摘要时会由已存在的场景视觉身份和节拍恢复，不因一个可推导字段让整条请求失败。
- 收紧供应商账号快照：供应商只读取业务所需头像引用，不下发数字人角色版、旧信息流角色参考、声线参考等创作端管理素材；创作者和管理员原有管理能力保持不变。

### 验证结果

- 真实调用 MiniMax-M3 导演与 MiniMax TTS 完成 10 组不同场景验证，未调用最终 Seedance：长视频、短视频、三类人群、品牌故事、列表型内容、克制叙事、附件语义等 10/10 通过。验证报告与音频保留在本地 `runtime/video-workshop/validation/`，便于用户复查。
- 10 组最终交付估算全部不短于用户要求，且均落在“要求时长至约多 30 秒”的允许范围；例如 180 秒样本最终约 208.7 秒，30 秒样本约 44.9 秒，20 秒样本约 23.2 秒。
- 视频工坊独立回归 83/83、主服务全量回归 309/309 通过；Python 编译、工作区 JavaScript 语法和手写源码差异检查通过。主服务测试仅保留 Python 3.9 测试运行器退出时既有的 event loop `ResourceWarning`，不影响测试结果。
- 本地 8787 健康接口返回正常且 MiniMax-M3 已配置。浏览器只读烟测确认主平台首页、视频工坊鉴权壳和无限画布首页均正常加载：主平台 0 error / warning，视频工坊未登录时正确拒绝访问且 0 error / warning；无限画布仅记录未登录导致的同步延后 warning，没有路由、资源或渲染错误。

### Git 与部署

- 本版继续留在本地等待用户验收，不提交、不推送、不部署，也不通知服务器部署任务。
- 后续若用户确认提交，只能精确选择 v107–v113 的代码、测试、必要静态产物和 `version.md`；不得提交本地真实导演 / 音频验证项目、视频工坊 runtime / uploads / outputs、数据库、认证缓存、私密环境、工作区历史删除或试验源目录。部署必须保留线上 SQLite、账号、成员、资产、发布清单、uploads、composed、画布项目 / blob、视频工坊 runtime / uploads / outputs、模型缓存、认证数据与私密环境。

## v112 - 2026-07-22（本地验证完成，待用户验收）

### 本版范围

- 无限画布的新生成结果不再以当前缩放 / 平移后的视口中心定位，而是以现有画布内容边界为锚点稳定向右追加；同一任务的多张占位会按生成顺序继续向右排列，不再因用户查看位置变化而随机散落。
- 修复放大预览时左右方向键与画布选择快捷键同时响应的问题：放大层独占 `Escape / ArrowLeft / ArrowRight`，切换后同步当前选中图片，并加入区分前后方向的轻量位移、淡入和缩放过渡；系统开启“减少动态效果”时自动关闭动画。
- 批量导出改为一次性按默认 PNG 参数合成全部选中图片并下载一个 ZIP。浏览器不再因拦截第二次及后续异步下载而只保存第一张；ZIP 内文件按选中顺序编号且保留各图实际尺寸与叠加标记。
- 无限画布静态构建标识更新为 `VZqOFgspmITYsNwSL7U2x`；主平台与视频工坊缓存标识保持 v111，不改生成、发布、账号隔离或服务端画布持久化协议。

### 验证结果

- 无限画布 TypeScript 类型检查、ESLint 与 `build:embed` 生产构建通过；构建产物已同步到 `vendor/infinite-canvas`，压缩产物可检索到方向切换动画、单 ZIP 批量导出和新的构建标识。
- 画布交互、owner-scoped 项目集成、持久化迁移与静态缓存回归共 35/35 通过；专项细节回归 9/9 通过，覆盖稳定追加锚点、放大层键盘事件归属、方向动画、减少动态效果和 ZIP 批量导出契约。
- Playwright 打开本地 `8787/XZ-Design/?embed=1`，首页、空白项目、画布工具栏、导出与发布入口正常渲染。隔离浏览器未登录，因此服务端项目索引按预期返回 401 并保留本地内容；该鉴权提示不是本版回归错误，也未触发生成、发布或服务器写入。

### Git 与部署

- 本版继续留在本地验收，不提交、不推送、不部署。
- 后续若用户确认提交，只能精确选择 v112 无限画布源码、静态产物、测试、`version.md` 与对应真实问题记录；不得包含本地浏览器项目、数据库、画布 blob、工作区历史删除或其他用户遗留文件。部署必须保留线上 SQLite、账号、成员、资产、发布清单、uploads、composed、画布项目 / blob、视频工坊 runtime / uploads / outputs、认证数据与私密环境。

## v111 - 2026-07-22（本地验证完成，待用户验收）

### 本版范围

- 修复批量视频偶发“一个成功、一个失败”后无法恢复的问题：确认根因发生在语言模型生成文案 / 口播 / 分镜阶段，失败任务尚未创建 Seedance 单元，并非两个任务并发或切换页面取消。任务板“重生视频”在没有可用单元时会重新完成该账号的脚本与分镜，再创建视频任务；不再用“没有可重新生成的视频单元”覆盖原始失败原因。
- 视频审核与微调补齐成片语义：审核预览优先展示已经剪辑合成的完整视频并扩大 9:16 画面；只有尚未合成时才显示源片段。封面微调可以拖入 / 增加新参考图、删除旧参考图，只重新生成当前账号封面，不影响视频、文案和其他账号。
- 视频工坊在导演与执行两层保持附件理解：导演继续判断附件是生成参考、剪辑素材、口播 / BGM / 音效，并自主选择对应镜头、口播锚点、画中画 / 切入方式和位置；当用户明确说“图1参考、其余图片做剪辑素材”或分别指定图 / 视频用途时，执行层只纠正角色误判，不覆盖导演的放置方案。剪辑素材仍进入最终 FFmpeg 合成，而不是交给 Seedance 冒充生成参考。
- 所有视频工坊 Seedance 技术请求统一追加“无字幕、无花字、无水印、无二维码、画面中不出现文字”的负面要求；该要求只位于视频模型提交边界，不改导演计划，也不解释后期流程。版权 / 安全审核不通过时，导演最多自动原创化改写失败镜头 2 次并原位继续，网络、额度、配置等其他错误仍明确失败、允许人工重试。
- 主平台缓存标识提升为 `20260722-v111-1`，视频工坊缓存标识提升为 `20260722-25`。

### 验证结果

- 附件语义回归覆盖“图1参考、其余图片剪辑”“图与视频分别指定用途”“视频放入指定镜头”三类指令；确认角色纠正后，导演给出的 `scene_number`、`presentation`、位置和时长仍保留，并验证素材真实生成指定场景内的合成时间点。视频工坊定向回归 18/18、独立全量回归 63/63 通过。
- 批量视频专项回归 11/11 通过：覆盖失败账号重新生成脚本 / 分镜、完整成片优先预览、封面参考图增加 / 删除、数字人角色版只进入本账号封面以及信息流 / 数字人参考用途隔离。
- 主服务全量回归 307/307 通过；工作区 JavaScript 全量语法、主服务与视频工坊 Python 编译以及本版手写文件差异检查通过。隔离浏览器分别打开主平台与视频工坊，页面标题、v111 / `20260722-25` 静态资源、健康接口均正确，两页控制台 0 error / 0 warning。主服务测试仅保留 Python 3.9 测试运行器既有的未关闭 event loop `ResourceWarning`，不影响测试结果。
- 本版不提交本地测试任务、视频工坊 runtime / uploads / outputs、数据库、认证缓存或私密环境。

### Git 与部署

- 本版继续留在本地验收，不提交、不推送、不部署。
- 后续若用户确认提交，只能精确选择 v111 代码、测试、静态缓存标识、`version.md` 与本轮真实问题记录；不得包含工作区历史删除、`Server Deployment Log.md`、本地生成项目或任何运行数据。部署必须保留线上 SQLite、账号、成员、资产、发布清单、uploads、composed、画布 blob、视频工坊 runtime / uploads / outputs、模型缓存、认证数据和私密环境。

## v110 - 2026-07-22（本地验证完成，待用户验收）

### 本版范围

- 视频工坊把“导演决策 + 视频生产”整体改为服务端持有的后台任务。`/api/chat` 在消息、附件和 owner 项目已持久化并登记任务后立即返回，MiniMax-M3 规划、Seedance、TTS、合成和质检继续由 sidecar 执行；切换主平台标签、切换会话、卸载 iframe 或关闭当前页面都不会取消已接受任务，停止制作仍只能通过显式停止接口完成。
- 修复 MiniMax-M3 偶发返回空消息 / 空工具参数：瞬态与空响应最多进行 3 次有界恢复，并为包含口播、叙事镜头、素材映射和内部时间结构的完整导演工具结果预留不少于 12000 token 的输出空间；鉴权、余额和明确永久错误仍不盲目重试，也没有新增固定镜头数、固定切镜秒数、强制语速或其他创意限制。
- 新建视频会话改为即时持久化：点击“新建会话”先创建真实 owner-scoped sidecar 项目，再立刻插入左侧历史并进入空白对话；主平台同源代理同步建立当前成员项目映射。历史列表增加请求代次保护，迟到的旧列表响应不能把刚创建的会话覆盖掉。
- 视频工坊缓存标识提升为 `20260722-24`；主平台静态缓存仍为 `20260722-v109-1`，本轮主平台仅增加服务端精确代理分支，不重载主静态闭包。

### 验证结果

- 新增后台导演回归验证：`/api/chat` 返回 `running / brief` 时导演仍被测试事件阻塞；丢弃前端响应后释放事件，服务端任务继续进入 pipeline 并保存计划，证明浏览器不是任务所有者。新会话接口与前端即时历史契约均有独立回归。
- MiniMax-M3 提供方回归覆盖连续 2 次空消息后第 3 次工具调用成功，永久鉴权 / 额度错误保持单次失败；视频工坊独立测试 58/58 通过，JavaScript 语法和 Python 编译通过。
- 真实本地任务 `243d4c733cdd` 完成 10 个独立视觉节拍、口播、合成、默认 1.2x 交付与质检，既有项目和成片均保留在本地 runtime。新代码真实接口在 4.3ms 内返回后台受理状态；浏览器随即切离视频工坊后，两个新任务仍继续完成导演规划、Seedance、TTS、字幕、BGM、合成与质检，最终均为 `succeeded / 100%`。
- 三条真实成片均保留在本地：`c8fa33ba64cb` 为 30.267 秒、`c9cf42b65cd2` 为 29.1 秒、`70375d1263dd` 为 71.034 秒；三者均为 720×1280 H.264 + AAC 且含音频。浏览器重新打开切走后完成的 `c9cf42b65cd2`，视频 `readyState=4`、时长 29.1 秒，页面控制台 0 error / 0 warning。
- 视频工坊独立测试 58/58、主服务全量测试 306/306 通过；JavaScript 语法、Python 编译和三条真实成片的 FFprobe 检查通过。主服务测试仍只出现 Python 3.9 测试运行器既有的未关闭 event loop `ResourceWarning`，不影响测试结果。

### Git 与部署

- 本版继续留在本地验收，不提交、不推送、不部署。
- 后续提交和部署只能精确包含 v110 代码、测试、缓存标识与本记录；本地真实测试项目、uploads、outputs、runtime、空会话测试留档以及任何数据库 / 私密环境都不得进入 Git 或部署包。服务器更新必须保留线上 SQLite、账号、成员、资产、发布清单、uploads、composed、画布 blob、视频工坊 runtime / uploads / outputs、模型缓存、认证数据和私密环境，禁止用本地数据覆盖线上。

## v109 - 2026-07-22（本地验收中）

### 本版范围

- 修复批量信息流与批量数字人点击“确认执行”只出现焦点框、没有任务和提示的问题：账号分组校验实际调用了未导入的 `groupOf`，且异常发生在旧 `try/catch` 之前。现已补齐明确依赖，并把账号归一化、参考图清理、文案 / 角色版校验和任务创建放入同一个异常边界；按钮先绘制“正在启动”，启动失败显示真实原因并恢复可重试状态，不再静默失效。
- 视频工坊导演节奏改为“叙事镜头计划 → 内部剪辑决定 → Seedance 技术片段”。移除导演层和渲染层重复注入的“约 2–4 秒推进一次”数值提示，不新增“一句口播几个镜头”或固定切镜时长；Seedance 4–15 秒只保留为单次技术生成边界，同一技术片段允许通过时间结构包含多次内部镜头变化。
- 导演场景新增 `narrative_role` 与 `shot_intent`，内部节拍新增相对 `pace`、镜头意图和切换原因。列举、反差、动作连锁、笑点或强调可由导演快速推进；情绪建立、关键证据、复杂界面和结果确认可主动停留。每次切换必须增加信息、情绪或视角，没有新增价值时允许保持长镜头，避免把“更快”写成均匀机械节拍。
- 渲染提示词按导演输出生成“内部剪辑方案”，将口播锚点、动作、机位、相对节奏、镜头意图和切换原因一并交给 Seedance；导演未规划内部节拍时只提供语义判断原则，不替导演自动等分时间。
- 主平台缓存标识提升为 `20260722-v109-1`；视频工坊缓存标识提升为 `20260722-23`。

### 验证结果

- Playwright 隔离浏览器先真实复现 `groupOf is not defined`，修复后信息流单击确认即创建 1 个批次、2 条 production、1 张进度卡并进入任务看板；数字人同样一次创建 2 条任务，两张封面分别只带本账号角色版。模型请求在夹具中被定向拦截，未触发真实视频生成，也未写入生产数据。
- 导演语义定向回归 8/8 通过：覆盖技术片段与成片镜头边界、叙事职责、内部剪辑意图、相对节奏保留、不同口播段的节拍映射以及彻底移除固定 2–4 秒提示。
- 当前 MiniMax-M3 只生成导演计划的真实抽检通过：高密度“三类人群”内容在 3 个叙事段内规划 11 个内部剪辑决定，开场用 `hold` 建立人物并以 `quick` 进入痛点，中段混合 `quick / release` 展示处理过程，结尾用 `hold / release` 收束；克制深夜故事样本以 `hold` 为主、仅在时间转折处使用 `quick`。技术片段时长没有被当作成片镜头时长，节奏会随语义变化而非统一变快。抽检没有启动 Seedance、TTS、合成或发布。
- 主服务全量回归 306/306、视频工坊独立回归 54/54 通过；工作区 JavaScript 全量语法检查、主服务与视频工坊 Python 编译、v109 手写源码差异检查通过。主服务测试结束仍有 Python 3.9 既有的未关闭 event loop `ResourceWarning`，不影响测试结果且本轮未改动对应测试运行器。

### Git 与部署

- 本版继续留在本地验收，不提交、不推送、不部署。
- 后续若确认提交，只能精确选择 v109 代码、测试与本记录；不得提交工作区历史删除、认证缓存、品牌素材、试验目录或部署线程维护的 `Server Deployment Log.md`。部署必须保留线上 SQLite、账号、成员、资产、发布清单、uploads、composed、画布 blob、视频工坊 runtime / uploads / outputs、模型缓存、认证数据和私密环境，禁止用本地状态覆盖服务器数据。

## v108 - 2026-07-22（本地验收中）

### 本版范围

- 批量信息流与数字人统一使用 10 个视频任务总槽位：信息流最多同时占用 8 个片段槽（约 4 条双段成片），数字人独占时最多使用 10 个槽；服务端新增跨成员 FIFO 活跃任务闸门，从提交前持续持有到上游任务成功、失败或取消，多人同时创作时排队而不是越过 Seedance / 数字人并发上限。等待请求被浏览器取消时会跳过对应票号，不会堵死后续队列。
- 批量视频不再在源片段完成后直接进入审核。信息流的两段视频与数字人的 2–4 个片段必须先通过 `/api/video/compose` 合成为一个完整 MP4，合成成功后才进入审核；信息流继续默认无字幕并保留片段原声，数字人按确定口播和分段时长烧录单调不重叠字幕，默认字号 15。
- 首页首个指标由“回传链接”改为“发布数量”，只有供应商真实回传 `publishedUrl` 才计为发布；点击可按最近日期或自然周筛选明细。创作者与管理员读取同一份全团队已交付数据，因此累计交付、近 7 日交付和发布数量口径一致。
- 创作者发布清单改为可见全团队交付，进入页面时默认筛选当前发布人；顶部发布人筛选对创作者和管理员同时开放，可切换“全部发布人”或其他成员。服务端只额外下发团队交付及其封面 / 包内媒体，不开放其他成员的未交付草稿、私有素材、任务或定制项目。
- 修复视频工坊新建会话后旧项目异步响应又把页面刷回旧对话的竞态：新建动作立即清空对话、导演记录、成片区和附件并显示新项目；迟到的旧项目响应通过加载代次丢弃。
- 主平台缓存标识提升为 `20260722-v108-1`；视频工坊缓存标识提升为 `20260722-22`。

### 验证结果

- 新增 v108 行为回归 6/6 通过：覆盖浏览器信息流 8 槽 / 数字人 10 槽选择、服务端跨成员 FIFO 与取消容错、团队交付媒体最小可见集、信息流双段单一成片、数字人多段字幕单一成片、首页 / 发布清单 / 新会话交互契约。
- 批量参考图、数字人、交付状态、供应商、成员隔离、模块缓存身份和视频工坊集成等定向回归 88/88 通过；主服务全量回归 305/305、视频工坊独立回归 53/53 通过。
- 主平台与视频工坊 JavaScript 语法检查、主服务与 sidecar Python 编译、启动脚本语法检查通过。自动生成的无限画布压缩 chunk 仍包含构建工具原有的行尾空格提示，未改动该生成文件，也不影响本轮手写代码检查。
- Playwright 只读烟测确认本地主入口加载 `20260722-v108-1`，首页真实显示“发布数量”与近 7 日团队交付结构，控制台 0 error / warning；不落盘的创作成员视图挂载确认“发布人”筛选默认选中当前成员。视频工坊新会话的迟到响应丢弃由 53 项 sidecar 回归与 v108 交互契约共同覆盖，未触发生成或发布。
- 本轮并发与合成验证使用本地模拟提供方响应，没有触发真实付费 Seedance / 数字人生成，也没有写入生产数据。

### Git 与部署

- 本版继续留在本地验收，不提交、不推送、不部署。
- 后续若确认提交，只能精确选择 v108 代码、测试与本记录；不得提交工作区历史删除、认证缓存、品牌素材、试验目录或部署线程维护的 `Server Deployment Log.md`。部署必须保留线上 SQLite、账号、成员、资产、发布清单、uploads、composed、画布 blob、视频工坊 runtime / uploads / outputs、模型缓存、认证数据和私密环境，禁止用本地状态覆盖服务器数据。

## v107 - 2026-07-22（本地验收中）

### 本版范围

- 修复批量真人视频点击“确认执行”后缺少可见反馈：按钮会立即进入“正在启动”忙状态，同步准备错误也纳入同一 `try/finally` 恢复边界，失败时显示真实错误并允许原位重试，不再留下“无反馈 + 卡住”状态。
- 批量视频参考图语义收口：真人 / 数字人的统一参考与本账号定制参考只进入封面，不混入数字人视频画面生成；每个数字人账号的封面会另外自动合并该账号自己锁定的角色版，不会串用其他账号角色。信息流批量仍按产品要求将统一参考与定制参考同时传给对应账号的视频与封面。
- 批量视频任务看板显示真实封面缩略图，审核卡和右侧任务行均可进入封面微调；微调只替换当前封面并保留 3:4 画幅与既有参考集。看板同时增加“重生视频”，保留文案、口播、封面和参考，只重新派发视频单元。
- 视频工坊导演升级为“口播语义锚点 → 可视化节拍 → 实测音频时间线”。每个导演场景保留连续口播原文，具体人物、对象、数字、列举项、对比、流程和情绪转折会被转成可执行画面动作；三类明确人群等列举如被模型遗漏，仅补足缺失的视觉概念，不改导演镜头数、风格和节奏。
- 导演只在缺失主题、主体或核心目标时追问；受众细分、风格、镜头、结尾和可选素材由导演自主判断。对“信息已足够但仍追问”的异常结果只做有上限的工具格式自纠，不添加固定镜头数、固定时长、固定风格或强制口播速度。
- 主平台缓存标识提升为 `20260722-v107-1`；视频工坊缓存标识提升为 `20260722-21`。

### 验证结果

- 批量参考图与任务板 10/10 专项回归通过，包含两个数字人账号不同角色版的行为级隔离验证：封面分别只得到本账号角色版，数字人任务参考不进入视频引用。
- 导演语义回归 7/7、视频工坊独立回归 53/53、主服务全量回归 299/299 通过；本次修改的 JavaScript 与 Python 语法检查通过。
- Playwright 复用本机 Chrome 完成只读浏览器烟测：主平台与视频工坊均返回 200，分别实际加载 `20260722-v107-1` 与 `20260722-21`，两页控制台均为 0 error / warning；本地 8787 与 8765 健康接口保持 ready。
- 真实导演压测先复现 20 轮中 19 轮错误追问；修复后最终轮达到 19/20 直接生产、0 接口错误、19 个生产方案口播覆盖率 100% 且无完全重复镜头提示；剩余一轮随机异常已加有上限的最终工具格式纠正，同题定向复测已直接生产。
- 真实本地生产一条“会议记录 → 百度搭子 → 清晰待办”短片：导演用 3 个独立镜头和 7 个语义节拍完整覆盖口播，Seedance、TTS、字幕、FFmpeg 合成和 OpenMontage 技术质检全部成功。交付文件为 720×1280 H.264 + AAC，可解码，抽帧确认三个阶段画面真实变化；本地测试项目已精准移出可部署工作区。

### Git 与部署

- 本版继续留在本地验收，不提交、不推送、不部署。
- 后续提交只能精确选择 v107 代码、测试和本记录；不提交工作区历史删除、认证缓存、品牌素材、试验目录或部署线程维护的 `Server Deployment Log.md`。若后续部署，必须保留线上 SQLite、账号、成员、资产、发布清单、uploads、composed、画布 blob、视频工坊 runtime / uploads / outputs、模型缓存、认证数据和私密环境，禁止用本地状态覆盖服务器数据。

## v106 - 2026-07-22（本地验收中）

### 本版范围

- 视频工坊运行状态不再由 1.3 秒项目轮询与 3 秒心跳交替覆盖同一整行文字。任务阶段、滚动状态词和稳定计时拆为独立节点：真实事件只更新任务阶段，状态词每 6 秒以纵向滚轮过渡，秒数使用等宽数字原位更新；不调整轮询、Seedance、停止制作、导演计划或媒体刷新逻辑，并兼容系统减少动态效果设置。
- 视频工坊继续由导演模型决定叙事、语义镜头和节奏，不加入“一句口播固定两个镜头”、固定镜头数或强制 TTS 语速。对测评、信息流感或信息密度较高内容，只把约 2–4 秒推进新动作、景别、构图或信息焦点作为可选节奏参考；慢情绪和需要看清的段落仍由导演主动停留，不做机械均分。
- 视频工坊先按自然语速生成口播并测量真实时长，再把超过 Seedance 单段 15 秒能力的口播窗口拆为连续、独立的技术视觉节拍；每个节拍生成独立视频文件，不再用同一个片段重复填满长口播。并发上限保持 10，超过 10 个的任务进入队列，失败时取消尚未开始的等待任务。
- 正常成片合成后保留原始音画源，并自动派生默认 1.2x 交付版；视频工坊和主剪辑审核页均可从保留源另存 1.2x–2.0x 版本，视频、音频和字幕时间整体同步变化，不重新请求导演、Seedance 或 TTS，也不覆盖已有版本。
- 修复视频工坊嵌入主平台后“生成变速版”被代理白名单拒绝；主平台现仅对当前成员已绑定项目开放精确 `speed-version` POST 路径，其他 sidecar 接口仍默认关闭。
- 视频工坊历史成片改为统一的深色玻璃弹窗，保留已发布 / 未发布筛选和逐成片独立发布状态；竖版视频采用紧凑预览，并可对历史成片直接另存变速版。
- 音色设计将用户完整描述传给 Minimax，除女性 / 男性外继续保留“温柔、生活化、朋友聊天、语速舒缓、日常分享”等情绪、质感、语速和场景语义。主平台既有 TTS `speed=1.2` 参数仍受支持；视频工坊 TTS 保持自然语速，避免再次约束导演链路。
- 无限画布主页创作输入框支持 Command / Ctrl+V 直接粘贴系统剪贴板图片为参考图；主页自定义宽高增加可点击开关的比例锁，默认开启时修改任一边会按当前画幅同步另一边，关闭后宽高可独立输入。
- 无限画布图片放大预览支持左右方向键和两侧按钮循环切换，切换时保留平滑淡入；自定义尺寸不落在模型 8 像素网格时改为“自动适配 / 精确适配”说明，明确这是少量技术像素对齐而不是创意构图裁剪。
- 修复无限画布首页首次创作偶尔忽略刚选尺寸：主页交接的第一轮生成显式使用新项目已保存的 `targetSize`，不再等待共享编辑器尺寸异步同步；进入画布后的后续生成仍使用用户当前选择，不改变模型、提示词或参考图链路。
- 主平台缓存标识提升为 `20260721-v106-1`；视频工坊缓存标识提升为 `20260722-20`；无限画布已重新生成并同步新的静态哈希闭包。

### 验证结果

- 视频工坊状态滚轮专项回归确认轮询不再覆盖完整状态行、任务名与状态词由不同节点维护、秒数独立更新；真实浏览器探针确认滚动窗口切换前后固定为 195px、任务名位置不变，300ms 过渡后新状态回到稳定位置且无横向跳动。
- 主服务全量回归 295/295、视频工坊独立回归 46/46 通过；新增覆盖长口播独立技术节拍、最多 10 个并发队列、失败取消、保留源派生变速版、主平台精确代理和 owner / HTTP 方法保护、非硬性节奏建议、不重复请求视频 / 语音模型、音色完整语义、状态滚轮单一所有者和无限画布三个真实交互入口。
- 无限画布 TypeScript、ESLint 与嵌入式静态构建通过；临时 `node_modules / .next / out` 已移出可部署源快照，正式产物只同步到 `vendor/infinite-canvas/`。
- 无限画布 22/22 集成回归通过，新增覆盖“首页选择尺寸 → 新建项目 → 首次自动生成”必须优先读取项目目标尺寸；重新构建后的静态哈希闭包已同步到主平台。
- 工作树实际存在的 JavaScript 全部通过 `node --check`，主服务和视频工坊 Python 通过 `compileall`，受跟踪 Shell / `.command` 通过 `bash -n`；源码差异检查通过。Next.js 自动生成压缩文件存在其工具输出的行尾空格提示，不涉及手写源码。
- 本地 8787 主服务与 8765 视频工坊均健康，导演、Seedance、MiniMax 语音、FFmpeg 合成和质检均 ready。真实 FFmpeg 回归确认音画以同一倍率压缩，1.2x 后音视频时长差保持在允许范围。
- 真实浏览器烟测：视频工坊既有任务按 55.1 秒实测口播生成 5 个独立视觉节拍并产出默认 1.2x 成片；历史玻璃弹窗、筛选和紧凑预览完整。从主平台嵌入页选择 1.3x 并单次点击后，真实生成 19.067 秒新成片并显示 1.3x，原 24.7 秒版本与口播均未重新生成，不再出现“接口未开放”。无限画布主页比例锁真实可见，模拟系统剪贴板粘贴后立即出现参考图预览；未登录 owner 接口按预期返回 401，不影响静态页面交互。
- 变速发布与信息流交付专项确认：变速完成后当前播放器和“发布成片”均绑定新生成的 `speed-1p3` 输出，发布载荷取当前选中输出的 URL、`sourceOutputId` 与 `sourceDeliveryId`，不会回退原片；信息流进入审核前若时间轴尚未合成会强制合成，发布与供应商压缩包只读取单一 `finalVideoUrl`，源片段仅保留为内部时间轴资料，缺少最终成片时明确拒绝冒充打包。相关 4 项针对性回归通过。

### Git 与部署

- 本版仍在本地验收，当前不提交、不推送、不部署。8787 本地服务保持运行，供用户先验证。
- 后续确认后只提交 v105/v106 已核对代码、测试、无限画布新静态闭包、`version.md` 与对应问题记录；不提交工作区历史删除、认证缓存、品牌素材、试验目录或部署线程维护的 `Server Deployment Log.md`。
- 若后续部署，只精确更新提交内代码与静态文件；必须保留线上 SQLite、账号、成员、资产、发布清单、uploads、composed、`server/canvas_blobs/`、视频工坊 runtime / uploads / outputs、模型缓存、认证数据和私密环境，禁止删除式同步或用本地状态覆盖服务器数据。

## v105 - 2026-07-21

### 本版范围

- 修复单号创作“最近交付”预览：图文固定读取第一张成图，视频固定读取已生成封面；没有真实预览时才显示类型占位，不再把视频源片段或错误图片当封面。
- 修复数字人口播与字幕细节：合规清洗不再把“第一步”误改为“前排步”；用户在编辑器改动口播后，旧音频和旧视频只有在口播逐字一致时才可复用；数字人字幕继续默认 15px，极短字幕块不再因最小宽度挤到下一条字幕上。
- 修复视频封面首次点击无响应：生成状态在同一次请求开始后原位更新，不再先重建触发按钮；点击“生成封面”会明确重新生成当前封面，既有 3:4 原生画幅锁定不变。
- 无限画布增加图片 Command / Ctrl+C 与粘贴、左右方向键切换图片、鼠标框选多张图片后批量导出，以及自定义尺寸比例锁；沿用现有项目选择与 owner 隔离状态，不新增发布批处理，也不改变项目持久化协议。
- 音色设计补齐性别提示传递：前端从用户描述识别女性 / 男性诉求，服务端将其作为强约束与原始音色提示词一起提交 Minimax，避免“女生”描述被弱化为男声。
- 视频工坊发布账号仅展示“素材”视频账号；视频工坊、无限画布、批量创作与单号账号页统一按当天真实交付记录展示“已创作”标记，所有创作者与管理员读取同一业务口径，不按当前页面临时计数。
- 信息流标题生成采用同一次点击内的完整模型重试：第一次模型输出若口播长度或结构校验不合格，会保留原主题与创意要求再请求一次；不启用本地模板，不改信息流高质量提示词规则。
- 信息流默认保持空字幕轨，自动拼接和进入剪辑页都不会恢复旧自动字幕；只有用户主动点击“匹配字幕”后才创建并持久化该手动匹配轨。数字人仍按确定口播原文和实测分段时长生成字幕。
- 修复信息流交付压缩包出现两段源视频：剪辑台只要时间轴变化就必须先合成单一成片，未合成的普通视频禁止发布；供应商下载也不再把源片段伪装成最终成片。
- 主平台与延后加载模块缓存标识提升为 `20260721-v105-1`；无限画布静态产物已重新构建为新的内容哈希。

### 验证结果

- 新增 v105 细节回归，覆盖最近交付预览、数字人改稿后禁止复用旧音频、字幕短块、封面单击、信息流同击重试、音色性别、素材账号过滤、今日创作标记、无限画布复制 / 框选 / 批量导出 / 比例锁、信息流默认空字幕与单一成片交付。
- 无限画布 TypeScript 类型检查、ESLint 与嵌入式静态构建通过；构建结果已同步到主平台 `vendor/infinite-canvas/`。
- 主服务全量回归 286/286 通过；v105 细节、数字人、视频工坊、无限画布与持久化定向回归 72/72 通过。
- 工作树实际存在的主平台、视频工坊与无限画布 JavaScript 全部通过 `node --check`；主服务与视频工坊 Python 编译、受跟踪 Shell / `.command` 脚本语法检查及 `git diff --check` 通过。
- 本地 8787 主服务与 8765 视频工坊 sidecar 健康接口均为 200；Playwright 烟测确认主入口加载 `20260721-v105-1`、登录页与首页完整渲染且 0 error / warning。无限画布首页与 hash 项目路由均返回 200；未登录状态的 owner-scoped 项目接口按预期返回 401 并显示隔离提示。
- 本版不修改数据库结构、账号数据、资产内容、上传、已合成视频、画布草稿 / blob、视频工坊 runtime、模型缓存、认证数据或私密环境。

### Git 与部署

- 仅提交 v105 代码、测试、无限画布新静态闭包、本记录及对应问题记录；不提交工作区历史删除、认证缓存、品牌素材、试验目录或服务器实际部署日志。
- 部署只更新提交内精确代码与静态文件。必须保留线上 SQLite、账号、成员、资产、发布清单、uploads、composed、`server/canvas_blobs/`、视频工坊 runtime / uploads / outputs、模型缓存、认证数据和私密环境；禁止删除式同步或用本地状态覆盖服务器数据。
- 部署后重点复核：数字人口播改稿真实生效；“第一步”读音正常；字幕不叠加；封面第一次点击即可生成；信息流默认无字幕且压缩包只有一个合成成片；音色设计性别符合提示；四处“已创作”标记口径一致；无限画布刷新、复制粘贴、方向键、框选批量导出与比例锁正常。

## v104 - 2026-07-20

### 本版范围

- 修复视频工坊在生成封面、运行制作任务或轮询进度时，已有成片区域反复闪烁的问题。成片播放器现在只在成片 ID、URL、画幅、时长或成片自身更新时间真实变化时重新加载，不再把项目级进度更新时间误判为成片变化。
- 修复主平台数字人及视频制作任务在每次轮询时整页重绘的问题。首次进入生成中、最终成功或失败仍正常刷新；中间轮询只原位更新状态文字和进度条，已有音频、视频、封面及输入内容不会被反复销毁重建。
- 本版不调整视频生成、封面生成、发布、轮询频率、媒体接口或历史成片逻辑；真实替换或重新合成成片时仍会触发一次正常刷新。
- 视频工坊静态缓存标识提升为 `20260720-18`。
- 主平台与延后加载模块缓存标识统一提升为 `20260720-v104-1`，确保数字人、信息流和普通视频任务都加载同一版轮询 UI 逻辑。

### 验证结果

- 增加进度轮询回归：项目更新时间变化不能触发成片重载，成片 URL / ID / 时长 / 自身更新时间仍纳入重载判断。
- 增加主平台任务轮询回归：活动任务的后续进度更新必须走原位更新，终态与结构变化仍保留完整重绘。
- 视频工坊独立测试 44/44、主服务全量测试 278/278 通过；全部受跟踪 JavaScript 通过 `node --check`，主服务与视频工坊 Python 通过 `compileall`，受跟踪 Shell / `.command` 启动部署脚本通过 `bash -n`，`git diff --check` 通过。
- 本地 8787 主服务与 8765 视频工坊 sidecar 健康检查正常，导演语言模型、视频、语音、合成和质检均为 ready；主入口实际加载 `20260720-v104-1`，视频工坊实际加载 `20260720-18`。
- Playwright 未登录态烟测确认主平台首页完整渲染且控制台 0 error / warning；无限画布静态入口与 hash 项目路由均为 200，未登录浏览器访问 owner-scoped 项目接口返回 401 并保留登录隔离，页面本身正常渲染。旧的实体项目路径保持 404，避免再次误走错误静态路由。
- 本版不修改数据库、账号、资产、上传、成片、画布草稿、视频工坊 runtime 或私密环境。

### Git 与部署

- 功能提交为 `b56b018`。提交内容已扫描，不含明文密钥、认证数据、`.env`、数据库、runtime、uploads、outputs、画布 blob、视频工坊项目或模型缓存。
- 部署只更新该版本代码与静态资源，并重启主服务和视频工坊 sidecar；必须保留线上 SQLite、账号、成员、资产、发布清单、uploads、composed、`server/canvas_blobs/`、视频工坊 runtime、无限画布草稿、模型缓存、认证数据和私密环境。禁止删除式同步或用本地状态覆盖服务器数据。
- 部署后重点复核：生成封面或运行任务时已有成片不再闪烁；数字人、信息流和普通视频运行中只更新进度，不重建媒体节点；真实成片替换仍会刷新一次；主平台与所有延后加载模块使用同一 v104 缓存标识。
- 回滚只回退 v104 代码与两处缓存标识，不得使用旧数据库或旧运行目录覆盖部署后新增的业务数据。

### 实际生产部署

- 于 `2026-07-20 19:33 CST` 完成生产更新，目标提交为 `08051bf`（功能提交 `b56b018`）。从干净目标工作树精确同步 28 个既有代码 / 静态文件，没有新增、删除或使用删除式同步；部署前保留回滚点 `v104-20260720-192346`。
- 主服务与视频工坊 sidecar 均为 active，两个健康接口正常，最近 10 分钟错误级服务日志为 0；生产主平台实际加载 `20260720-v104-1`，视频工坊实际加载 `20260720-18`，28 个目标文件哈希与发布提交一致。
- SQLite `quick_check=ok`，部署前后所有既有业务表数量均未减少；上传、成片、画布 blob、视频工坊 runtime / uploads / outputs 的文件数和字节数保持不变，私密环境文件指纹保持不变。回滚只恢复本次代码文件，不恢复旧数据库或旧运行目录。
- 已登录生产浏览器只读验收通过：主平台、草稿箱、视频工坊与无限画布均正常加载且控制台 0 error / warning；现有视频工坊成片播放器保持同一节点和同一 URL，媒体就绪状态为 4；无限画布最近项目 hash 路由完整，5 个可见图片节点无破损，草稿箱 15 个可见图片节点无破损。未触发生成、发布、删除、冲突处理或其他业务写入。
- v103.4 的同源语言模型代理自愈代码仍在目标提交中，服务器私密环境未改变；视频工坊发布封面的 3:4 约束与无限画布历史项目逻辑未回退。本次未修改模型配置，也未执行计费型生成调用。

## v103 - 2026-07-20

### 本版范围

- 修复视频工坊“生成封面”只在提示词中写入 `3:4`、但图片代理未传原生锁定参数的问题。该发布封面请求现在会同时传入 `ratio: "3:4"` 与 `strictRatio: true`，服务端不再被同一上下文中的 `9:16` / `竖屏` 视频描述重新推断为 9:16。
- 仅锁定视频工坊最终发布封面的画幅；视频工坊生成成片仍按项目自身的 9:16 / 16:9 设置执行，其他单号、批量和无限画布图片生成继续保持既有提示词画幅推断。
- 主平台缓存标识提升为 `20260720-v103-1`，确保发布面板与封面链路重新加载更新后的模块。

### 验证结果

- `node --check` 已覆盖图片 Provider、视频封面、发布面板、定制创作入口与主入口；`git diff --check` 通过。
- 图片代理回归实际捕获请求体：视频工坊封面会发送 `ratio: "3:4"` 和 `strictRatio: true`，普通图片请求仍发送 `strictRatio: false`；视频工坊发布、图片参考图和缓存入口相关测试 55/55 通过。
- 本版不修改数据库、账号、资产、上传、成片、画布草稿、视频工坊 runtime 或私密环境。

### 实际生产部署补充

- `304a63d` 修复了公共访问场景错误回退到浏览器本机服务的问题；随后于 `2026-07-20` 部署 `f28e610`，入口缓存升级为 `20260720-v103-3`。
- 大体积参考图现在由服务器在请求上游前压缩并维持共同的请求体预算。生产服务环境未安装 Pillow，已验证自动使用 FFmpeg 压缩回退；不修改原始上传资产，也不改动私密模型配置。
- 本次仅从提交归档更新 16 个代码 / 静态文件。部署前后数据库表行数一致，SQLite 完整性检查正常，主服务健康检查通过；未覆盖业务数据或触发真实图片生成。
- 随后部署 `32c6d1c`，入口缓存升级为 `20260720-v103-4`。定制创作的延后加载模块会在首次语言模型调用前自行探测同源服务端代理，避免旧模块缓存或加载顺序导致“未配置语言模型”假报错；主服务和视频工坊导演 / 视频 / 语音配置均通过只读健康核验。
- 本次精确同步 27 个代码 / 静态文件，部署前建立代码回滚归档与一致性 SQLite 备份；部署前后业务表计数摘要一致。未同步或修改线上账号、资产、项目、上传、成片、画布 blob、视频工坊 runtime 或私密环境。

## v102 - 2026-07-20

### 本版范围

- 首页平台环图拆分为两个独立交互扇区：悬停或键盘聚焦“小红书”仅展示今日小红书账号交付；悬停或聚焦“视频号”仅展示今日视频号账号交付。各自最多显示 6 个账号，超出以省略号提示。
- 当前交互扇区会加宽、轻微抬升并高亮，另一侧适度降低透明度；点击扇区只打开对应平台的今日交付明细，不再把两个平台混在同一提示中。
- 主平台缓存标识提升为 `20260720-v102-1`。

### 验证结果

- `node --check`、`git diff --check`、首页相关静态契约测试 36/36 通过。
- 本地 8787 未登录态浏览器烟测确认两个可访问的环图扇区均已输出独立按钮语义与平台标签；登录遮罩按预期拦截交互，未以测试身份触发任何数据写入。
- 本版只涉及首页展示与缓存，不读写数据库、账号、资产、发布清单、上传、成片、子应用或私密环境。

### 实际生产部署

- 于 `2026-07-20 13:41 CST` 部署目标提交 `ad4eebe`。从干净目标工作树仅同步 7 个精确的代码 / 静态文件，未使用删除式同步，也未触碰环境配置或运行态目录；回滚点为 `v102-pre-20260720-133138`。
- 主服务和视频工坊 sidecar 均保持活动状态，健康检查正常；生产入口与样式资源均加载 `20260720-v102-1`。
- SQLite `quick_check=ok`，部署前后账号 80、发布链接 76、资产 2864、生产单 543、任务 692、批次 75、指标快照 108、产品 12、音色 6、定制项目 5 与定制产出 6 均未减少；会话由 62 变为 63，为部署期间的并发正常登录，未被回滚或覆盖。上传、成片和画布 blob 的文件数量与字节数均保持不变。
- 生产浏览器只读验收确认首页环图已分为小红书与视频号独立扇区，当前数据为小红书 256 条、视频号 14 条；键盘打开小红书扇区时仅显示当天对应平台的 2 个账号交付。未触发生成、发布、删除、同步或其他业务写入。

## v101 - 2026-07-20

### 本版范围

- 首页四张核心指标卡移除顶部彩色上沿，保留首张蓝色重点卡与其余白底指标卡，避免出现多条横向色条。
- 平台环图增加今日交付摘要：悬停时按“账号 · 小红书 / 视频号 · 条数”列出最多 6 项，超出部分以省略号提示；点击环图打开今日全部平台交付账号明细，不跳转页面。
- 首页操作卡移除图标灰色方形底座。仅悬停对应卡片时播放短动效：待处理对号描边、互动心电图、发布沟通笔记横线书写、数据完整度链接旋转；默认静止，并尊重系统减少动态效果设置。
- 主平台缓存标识提升为 `20260720-v101-1`。

### 验证结果

- `node --check`：主入口与首页模块通过；`git diff --check` 通过。
- 相关回归 64/64 通过；主应用全量 `unittest discover` 以成功状态完成。静态契约覆盖今日平台交付摘要、点击今日明细入口及四类操作图标标识。
- 本地 8787 真实浏览器在未登录态完成首页渲染烟测：环图已输出“查看今日小红书与视频号交付明细”可访问名称，趋势点仍保留总 / 图文 / 视频描述，控制台无本次改动相关异常。未登录或触发任何数据写入。

### 数据与部署

- 本版仅修改首页前端展示、交付摘要读取、前端缓存标识、静态契约测试和本记录；不修改数据库、账号、资产、发布清单、消息、同步接口、上传、成片、子应用或私密环境。
- 当前仅在本地开发验证，尚未推送或部署。若后续部署，只同步本版精确代码与静态文件，保留线上 SQLite、账号数据、资产库、uploads、composed、`server/canvas_blobs/`、视频工坊 runtime、模型缓存和私密环境，禁止删除式同步或用本地数据覆盖线上数据。

## v99 - 2026-07-20

### 本版范围

- 首页视觉切换为更清晰的红蓝主色：首张核心指标卡采用深蓝高亮，其余指标、平台环图和操作卡保留轻量白底；红色用于交付趋势曲线及渐变面积阴影，蓝色用于平台分布和账号识别，避免影响其他模块色彩。
- 近 7 日交付曲线保持总交付口径；鼠标悬停或键盘聚焦到日期点会同时显示总交付、图文交付和视频交付，日期点击及既有交付筛选链路不变。
- 首页账号表现同步既有账号头像，四账号轮播改为更紧凑的头像条目。点击账号后，详情弹窗新增“跳转主页”：已有创作端 / 供应商端共享主页链接时可新标签打开；未填写时按钮为不可交互灰态。
- 主平台缓存标识提升为 `20260720-v99-1`，首页与发布沟通模块继续统一使用同一版本化 ESM 地址。

### 验证结果

- `node --check`：主入口、首页、发布清单沟通模块均通过；`git diff --check` 通过。
- 相关回归 64/64 通过；主应用全量 `unittest discover` 以成功状态完成。静态契约覆盖趋势面积图、总 / 图文 / 视频拆分、账号头像、主页按钮和首页当前缓存标识。
- 本地 8787 真实浏览器在未登录态完成首页模块渲染烟测：趋势标题、7 个日期点的总 / 图文 / 视频无障碍文本均正确出现，控制台无本次改动相关异常。未使用未知账号登录，不触发真实同步、发布、生成、消息或外链跳转。

### 数据与部署

- 本版只调整首页前端展示、账号详情弹窗动作、前端缓存标识、静态契约测试和本记录；不修改账号资料、主页链接、数据库、资产、发布清单、消息、同步接口、上传、成片、子应用或私密环境。
- 当前仅在本地开发验证，尚未推送或部署。若后续部署，只同步本版精确代码与静态文件，保留线上 SQLite、账号数据、资产库、uploads、composed、`server/canvas_blobs/`、视频工坊 runtime、模型缓存和私密环境，禁止删除式同步或用本地数据覆盖线上数据。

## v98 - 2026-07-20

### 本版范围

- 首页数据区移除不承载操作的“生产流程”看板，将平台分布环图移至左侧、近 7 日交付趋势扩展至右侧主区域；趋势图在卡片中垂直居中，保留横向浏览、日期点击和按日 / 月明细筛选。
- 首页“发布沟通”详情中的“查看沟通”改为直接复用发布清单既有的沟通记录弹窗，可查看当前素材下创作端与供应商的真实历史消息；不再跳转发布清单，不改备注、回传链接或消息写入协议。
- 首页账号表现改为每组 4 个账号的轻量轮播；仅轮换当前已读取的统计结果，保留点击查看该账号详情，并在离开首页时清理计时器，避免后台继续更新已卸载视图。
- 首页卡片视觉调整为更克制的低饱和蓝灰、青灰、紫灰和暖灰点缀，统一圆角与卡片底色；不引入参考图中的左侧生产柱状图。
- 主平台缓存标识提升为 `20260720-v98-1`，首页与发布沟通模块使用同一版本化 ESM 地址，避免重复加载不同版本的沟通视图模块。

### 验证结果

- `node --check`：主入口、首页、发布清单沟通模块均通过；`git diff --check` 通过。
- 相关回归 64/64 通过；主应用全量 `unittest discover` 以成功状态完成。新增静态契约覆盖已移除的生产流程卡、直接沟通入口、账号轮播及首页当前缓存标识。
- 本地 8787 真实浏览器在未登录态完成首页渲染烟测：环图位于左侧、趋势位于右侧且完整显示 7 个日期、生产流程卡未出现，控制台未出现本次改动相关异常。未使用未知账号登录，不触发真实同步、发布、生成或消息写入。

### 数据与部署

- 本版仅修改首页前端布局、既有沟通弹窗入口、前端缓存标识、静态契约测试和本记录；不修改数据库、成员、账号、资产、发布清单、回传链接、JustOne 配置、上传、成片、视频工坊 runtime、无限画布草稿 / blob 或私密环境。
- 当前仅在本地开发验证，尚未推送或部署。若后续部署，必须只同步本版精确代码与静态文件，保留线上 SQLite、账号数据、资产库、uploads、composed、`server/canvas_blobs/`、视频工坊 runtime、模型缓存和私密环境，禁止删除式同步或用本地数据覆盖线上数据。

## v97 - 2026-07-20

### 本版范围

- 首页顶部在“新建账号”左侧新增管理员专用“同步数据”入口，复用数据分析页既有的 JustOne 手动同步链路：先补齐已回传素材，再逐条同步小红书 / 视频号数据快照。首页不再暗示自动刷新；无可同步回链、部分失败和整体失败都会明确提示，未改动 JustOne 后端、回传链接或历史快照规则。
- “近 7 日交付”改为可横向查看的时间轨，保留鼠标悬停提示；点击日期点或日期标签会直接打开当天交付明细，点击“查看明细”可在弹窗中按单日、单月或全部交付筛选。平台分布环图放大，提高总交付与平台占比的可读性。
- 视频工坊“发布成片 → 生成封面”保持既有 `ratio=3:4` 图片接口参数，并在仅此发布封面分支的提示词中明确“竖版 3:4”和安全可见区，避免受账号风格文本影响而弱化画幅要求；图文创作、批量创作和其他图片生成尺寸逻辑未改。
- 主平台缓存标识提升为 `20260720-v97-1`，并精确更新首页、发布弹窗及样式所需的模块入口，避免浏览器继续复用旧版首页或封面提示词。

### 验证结果

- `node --check`：首页、主入口、定制发布模块均通过；`git diff --check` 通过。
- 相关回归 64/64 通过；主应用全量 `unittest discover` 以成功状态完成。新增静态契约覆盖首页同步入口、趋势日期明细、日 / 月筛选、趋势横向控制和视频工坊发布封面 `3:4` 提示词。
- 本地 8787 真实浏览器完成未登录态首页渲染烟测：新版近七日趋势、日期按钮与查看明细入口均已出现，控制台未出现本次改动相关异常。未使用未知账号触发真实 JustOne 同步，避免在验收环境新增数据快照。

### 数据与部署

- 本版只修改主平台前端、前端静态缓存标识、前端回归测试和本记录；不修改数据库、成员、账号、资产、发布清单、JustOne 配置、上传、成片、视频工坊 runtime、无限画布草稿 / blob 或私密环境。
- 当前仅完成本地验证，尚未推送或部署。若后续部署，必须只同步本版精确代码与静态文件，保留线上 SQLite、账号数据、资产库、uploads、composed、`server/canvas_blobs/`、视频工坊 runtime、模型缓存和私密环境，禁止删除式同步或用本地数据覆盖线上数据。

## v96 - 2026-07-19

### 本版范围

- 恢复视频工坊上一稳定版本的主导演智能，不再向导演追加目标秒数、口播字数区间、固定 `1.2x`、二次口播修复或强制执行策略。主导演保留原有结构化生产协议并继续自主判断叙事、口播、镜头数量和节奏；语言模型返回的合法决策不再被后置规则改写。
- 视频时长改为真正的“音频先行”：平台先以自然语速生成或标准化口播，再读取音频实测时长，由后端据此分配导演镜头的时间窗。Seedance 的单次接口时长只在提交模型时做技术限长，合成层通过连续运动重定时覆盖口播窗口，不再因 `16.1` 秒镜头硬失败，也不再复制静止尾帧补时。
- 修复视频工坊修改意见被误判及“规划式回复 → 继续 → 再次规划”的循环。系统现在能识别“补镜头 / 去静止帧 / 重做指定镜头”等真实修订；“继续、说啊、什么”等上下文跟进会承接用户最近一次有效原话，不添加新的导演约束。新做多个镜头、教程咨询和保留定格不会被错误劫持为旧成片局部修改。
- 单镜头替换、字幕排版调整和整片时间线重合成继续保持事务式：只在新产物完整校验后切换，失败保留旧镜头、旧成片和历史版本。整片去静止帧可复用原导演方案、口播与已生成素材，不要求导演重新规划。
- 修复无限画布“本地与服务器同时新编辑”冲突状态下的首页缩略图回落。冲突分支只合并服务端可重新推导的稳定 `thumbnailUrl` 展示元数据，绝不覆盖本地 `items / messages / viewport`、dirty 状态、冲突提示或修订选择；连续刷新仍可显示缩略图。
- 主平台缓存标识保持 `20260718-v94-1`；视频工坊静态前端未修改，继续使用 `20260719-17`；无限画布静态构建标识提升为 `kUskuLna5GU9XqKHhMh6P`。

### 验证结果

- 主应用全量 `unittest` 269/269、视频工坊独立测试 43/43、口播时间线 / 重启恢复 / 画布冲突专项 16/16 全部通过；无限画布子应用接入与持久化专项 31/31、纯持久化脚本 5/5 通过。
- 服务端与视频工坊 Python `compileall`、`git diff --check` 通过。真实导演接口返回 `action=produce` 和 6 个镜头，证明主链路可以直接进入制作而不是停在 ask 循环；本地 8787 主服务与 8765 视频 sidecar 正常。
- 回归覆盖生产截图中的“重新补一下镜头 现在有静止帧 → 继续 / 说啊”循环、`16.1` 秒单逻辑镜头、超长口播后端技术分段、自然语速、无静止尾帧、局部替换映射、并发任务锁，以及冲突画布只合并安全缩略图元数据。

### 数据与部署

- 本版功能提交为 `6e865b2`；生产部署请以包含本记录的后续文档提交为目标，由“服务器部署”任务按现有保护数据流程执行并回传实际上线结果。
- 本版没有破坏性数据库迁移，不重写账号、成员、资产、发布清单、画布草稿、画布 blob、视频项目或成片。无限画布冲突修复只更新本地展示摘要中的服务器缩略图 URL；视频时间线修复只影响新制作或用户明确发起的重新合成。
- 部署只更新目标提交中的代码与静态资源。必须保留服务器 SQLite、账号与成员、资产与发布记录、uploads、composed、`server/canvas_blobs/`、视频工坊 runtime、模型缓存、认证数据和私密环境；禁止用本地空目录、旧数据库或删除式同步覆盖线上数据。
- 实际生产部署于 `2026-07-19 22:58 CST` 完成，目标提交为 `9b9ecf6`（功能提交 `6e865b2`）。最终从干净目标工作树按精确增量同步 49 个代码 / 静态文件，未使用删除式同步；部署前建立回滚点 `v96-pre-20260719-224753`。
- 部署后主服务与视频工坊 sidecar 健康检查均正常；主平台保持 `20260718-v94-1`、视频工坊保持 `20260719-17`、无限画布已加载 `kUskuLna5GU9XqKHhMh6P`。生产文件哈希与目标工作树一致。
- 部署前后关键业务基线一致，SQLite `quick_check=ok`：账号 80、成员 23、资产 2846、生产单 541、任务 692、批次 74、发布链接 75、指标快照 108、会话 62、音色 5、画布草稿 2、画布 blob 6。浏览器只读验收确认视频工坊输入与创作入口可用，已有无限画布项目可重开并加载 3 张历史图片；未提交新的生成或发布任务。

## v95 - 2026-07-19

### 本版范围

- 修复无限画布静态 / 嵌入模式的历史项目重开路由。项目卡与返回首页的原生 `href` 现在始终保留 `/XZ-Design/` 基路径、`embed=1` 和 hash 路由，即使 React 尚未完成 hydration、浏览器执行原生链接兜底或用户刷新 / 后退，也不会再误入不存在的 `/project/{id}` 静态路径并出现浏览器错误页。
- 修复无限画布首页刷新后真实图片缩略图变黑、变白或只显示尺寸占位的问题。服务端项目索引会从当前 owner 的完整草稿中只读推导稳定私有 blob 缩略图；前端即使本地 IndexedDB 已是 clean 状态，也会合并服务器返回的轻量摘要和 `thumbnailUrl`。缩略图优先使用生成图、其次参考图；删除当前图后会回退下一张，纯文本项目继续显示正常占位。列表摘要不写入 Base64 / data URL，也不改变完整草稿、图片 blob 或发布摘要。
- 视频工坊附件改为“每轮消息独立”：单次最多 8 个附件，发送成功后本轮附件清空，上一轮附件不会继续占用下一轮配额，也不会未经用户再次选择就继续传给导演；失败时附件和输入仍可恢复重试。
- 视频工坊有口播时默认按 `1.2x` 生成语音，并以实测口播时长作为成片目标时长和镜头编排依据，减少口播结束后的静止帧。导演规划继续保留原高质量视觉提示词规则，只在下游用实际音频时长约束镜头总长。
- 视频工坊增加对既有成片的局部修改：明确的单镜头修改只重生成目标镜头，字幕文字 / 样式 / 布局修改只在原有视频与音轨基础上重新合成；涉及口播、总时长或全片结构的请求仍进入完整重规划。局部产物采用事务式替换，只有新镜头或新字幕成片完整校验通过后才切换，失败保留原成片与历史版本。
- 主平台缓存标识保持 `20260718-v94-1`；视频工坊缓存提升为 `20260719-17`；无限画布静态构建标识提升为 `EjIfhNcQipNHVEUS6sYeu`。

### 验证结果

- 主应用全量 `unittest` 267/267、视频工坊独立测试 40/40、无限画布与静态接入专项 51/51 全部通过。
- 无限画布源码通过 TypeScript `typecheck`、ESLint 和生产嵌入构建；现存 JavaScript 通过 `node --check`，服务端与视频工坊 Python `compileall` 通过，受跟踪 Shell 脚本通过 `bash -n`，`git diff --check` 通过。
- 本地 8787 主服务与 8765 视频 sidecar 健康检查均为 200。真实浏览器已验证：包含 1080×1080 私有 blob 图片的历史项目在首页显示真实缩略图，连续两次刷新、进入旧项目再返回首页后仍正常；纯文本项目保持轻量占位，图片请求返回 200 / 206。
- 本轮回归覆盖项目卡原生链接、嵌入 hash 路由、刷新 / 后退、缩略图服务器推导与 clean-IDB 合并、逐轮附件隔离、口播目标时长、1.2 倍速、单镜头替换、字幕局部重合成以及失败时保留原成片。

### 数据与部署

- 本版功能提交为 `9503008`，生产目标与实际部署提交为 `09be746`；已于 2026-07-19 19:55 CST 完成上线。主平台缓存标识为 `20260718-v94-1`，视频工坊为 `20260719-17`，无限画布构建为 `EjIfhNcQipNHVEUS6sYeu`。
- 部署前建立回滚点 `v95-pre-20260719-193633`；最终按 Git `name-status -z -M` 清单同步 55 个目标代码 / 静态文件并移除 5 个旧哈希文件。服务器逐文件哈希与目标提交一致，主服务和视频 sidecar 健康检查均为 200。
- 部署前后核心业务数量一致，SQLite `quick_check=ok`，2858 个受保护文件无缺失、无改动，私密环境文件与部署前字节一致。真实浏览器中历史画布可通过 hash 路由退出后重进，项目图片完整加载，视频工坊首页与输入区正常。当前受影响浏览器仍有一条未解决的“本地 / 服务器同时新编辑”冲突，因此整页刷新后首页缩略图会暂时回落占位；服务器稳定缩略图与图片 blob 均存在，本次未代替用户选择冲突版本，避免覆盖本地编辑。
- 本版没有新增破坏性数据库迁移，不批量改写账号、成员、资产、生产单、发布清单、画布草稿、画布 blob、视频项目或成片。缩略图只从当前 owner 已有草稿与稳定 blob URL 推导；局部视频修改只在校验成功后替换目标产物。
- 部署只更新目标提交中的代码与静态资源。必须保留服务器 SQLite、账号与成员、资产与发布记录、uploads、composed、`server/canvas_blobs/`、视频工坊 runtime、模型缓存、认证数据和私密环境；部署前留存一致性备份，禁止用本地空目录、旧数据库或删除式同步覆盖线上数据。
- 回滚只恢复代码和静态资源，不得用旧业务数据库或旧运行目录覆盖部署后新增数据。仓库与部署指令均不包含 API Key、密码、Token 或服务器地址。

## v94 - 2026-07-19

### 本版范围

- 修复 v93 无限画布“项目卡仍在、项目内图片为空”的迁移回归。浏览器迁移改为两阶段提交：先原样保留 owner-scoped `legacy-backup`，再写入 IndexedDB 并逐项目读回校验项目数、节点数、消息、视口和关键图片 URL；只有备份与迁移清单都已持久化、全部读回一致后，才把原 `localStorage` 收敛为摘要。摘要存在但详情为空时会搜索旧 key、历史 namespace 和备份恢复，恢复失败会明确提示并提供重试 / 导出诊断，不再把它渲染成空画布。
- 无限画布完整项目升级为服务器 owner-scoped 权威持久化，项目、节点、消息、视口、修订号与删除墓碑都按当前成员隔离。浏览器 IndexedDB 只作缓存；同步按 `revision / updatedAt` 合并，空快照不能覆盖已有非空项目，迟到 GET / 迁移 PUT 也不能抹掉请求期间的新编辑。创建、改名、编辑、最近项目、项目库、刷新、重登、跨浏览器恢复和删除均复用同一同步协议。
- Base64 / data URL 图片在保存时转换为当前成员私有 blob，项目接口只返回稳定同源 URL；图片读取使用短期 HttpOnly、同源、路径受限会话并支持 Range，不向前端暴露存储路径。替换 / 删除项目只回收当前 owner、已无活项目引用的孤立 blob；事务失败只清理本次新建且数据库没有已提交记录的文件，不删除请求前已经存在的可恢复文件。部署目录 `server/canvas_blobs/` 与数据库、上传、成片和子应用 runtime 一样必须持久保留。
- 视频工坊“根据标题生成文案”改为严格真实模型链路：调用 `AI.generateCopy(... requireLlm: true)`；仅在模型已经响应但 JSON 损坏、缺少标题 / 正文或严格语义校验不通过时追加一次真实模型重试，HTTP、鉴权、额度和配置错误不重试。两次输出仍无效时直接显示失败并保留用户原文案，绝不再使用本地语义模板伪装成功。
- 统一增强主平台、服务端代理、视频工坊导演与无限画布的语言模型稳定性：只对网络故障、`408 / 425 / 429 / 5xx`、提供方临时繁忙、空响应或损坏的业务 JSON 做最多一次短延迟重试；`401 / 403`、配置、余额 / 额度、明确超时等确定性错误直接返回。重试不改写原提示词、温度或模型参数，严格业务链路也不再叠加多层重复请求，更不会用模板伪装模型成功。
- 信息流默认不自动生成字幕；只有用户点击“匹配字幕”后，才从已有高质量视频提示词的真实时间段与明确说话动作 / 主体中只读提取台词。普通“标签：内容”、界面文字、导演说明和无说话证据的冒号内容全部忽略，提示词生成规则与质量不做任何改写。数字人继续以可信分段口播原文和实测音视频时长生成单调、不重叠且不越界的时间轴，默认字号调整为 `15px`，人工字幕始终最高优先级。
- 登录改为先加载身份、账号、产品、音色和必要 UI 状态后进入首页，资产、生产单、任务、分析等重集合按页面在后台分组水合；初始阶段只读取本地身份缓存，不再先扫描全部 IndexedDB。网络分组与本地批量落库解耦，成员切换用 generation / member / token 三重校验拦截迟到响应。未水合页面显示可重试同步状态，不再显示假的空列表；供应商登录也不在首包拉取全部资产。草稿首批 24 条，封面使用 lazy / async 解码。
- 主平台缓存标识提升为 `20260718-v94-1`；视频工坊静态前端本轮未修改，继续使用 `20260718-16`；无限画布静态构建标识为 `Cb3dOInBfODPy4nRJsfpy`。

### 验证结果

- 主应用全量 `unittest` 259/259、视频工坊独立测试 23/23、真实 v92 双项目画布迁移夹具 4/4，合计 286/286 通过。迁移夹具覆盖两项目、参考图 / 生成图 Base64、消息、视口、备份配额失败、迁移清单失败、IDB 空读恢复、namespace 变化、A / B 浏览器修订合并、删除墓碑与迟到响应防覆盖；语言模型专项覆盖临时错误单次恢复、鉴权 / 额度不重试、JSON 损坏恢复与导演合法响应。
- 无限画布源码通过 TypeScript `typecheck`、ESLint 与 Next 生产嵌入构建；75 个受跟踪 JavaScript 通过 `node --check`，服务端与视频工坊 Python `compileall` 通过，7 个受跟踪 Shell 脚本通过 `bash -n`，`git diff --check` 通过。
- 本地重启后的 8787 主服务与 8765 视频 sidecar 健康检查均为 200。真实 Chrome 加载 `20260718-v94-1`，管理员轻量 bootstrap 正常恢复 80 个账号与首页真实数据；定制创作默认进入视频工坊，视频首页仅保留英文标题；切换无限画布后先建立受限 HttpOnly 会话，再加载配置、`Cb3dOInBfODPy4nRJsfpy` 静态资源与 owner-scoped 项目列表，页面约 1.2 秒完成挂载。
- 视频工坊真实模型最终验收使用标题“国产codex百度搭子自动管理你的知识库！”：刷新后的管理员会话一次成功，只发出 1 次真实 `/api/chat/completions`，HTTP 200、约 2.76 秒返回，`source=llm`、`fallbackMatched=false`；生成内容同时命中百度搭子、Codex、知识库归档、原文链接与可追溯。主平台 `/api/llm/test` 返回 200 与“在线”，视频工坊导演真实接口返回 200 和合法决策。另以连续两次无效模型输出验证最终失败保护，原 textarea 与状态均完整保留，不会落到模板。

### 数据与部署

- 本版新增 `custom_canvas_drafts` 与 `custom_canvas_blobs` 两张 SQLite 表，由服务启动时幂等创建；不批量迁移或重写账号、成员、资产、生产单、发布清单、视频项目和已发布画布摘要。已有 `customProjects` 只做关联复用，不重复建立发布项目。
- 部署前必须同时备份 SQLite、`server/canvas_blobs/`、uploads、composed、视频工坊 runtime、模型缓存与私密环境；同步代码时不得使用会删除或覆盖受保护目录的参数。部署后先用受影响浏览器触发 legacy / IDB / 服务器三方恢复，确认图片节点和稳定 URL 后再考虑清理任何浏览器缓存；禁止用本地空项目、旧数据库或空目录覆盖生产。
- 本版功能提交为 `77ce1de`，生产已于 `2026-07-19 12:47 CST` 更新到文档提交 `57641f6`。部署从干净 detached 目标工作树生成受控代码包，先做服务器分期校验和非删除式 dry-run，然后仅同步代码与静态资源。
- 部署前保留回滚点 `v94-pre-20260719-120145`，包含代码快照、SQLite 一致性备份、私密环境备份、服务定义与 2828 个受保护文件的校验清单。回滚只能恢复代码和服务配置，不得用旧数据库覆盖部署后新增业务数据。
- 上线前后关键基线一致：账号 80、成员 23、资产 2844、生产单 541、任务 692、批次 74、发布链接 75、指标快照 108、会话 63、音色 5、供应商绑定 64、供应商活动 146；SQLite 完整性为 `ok`，受保护文件缺失和尺寸减少均为 0，私密环境文件未变。
- `custom_canvas_drafts` 与 `custom_canvas_blobs` 已使用版本自带的幂等初始化创建，建表后库完整性仍为 `ok`；初始行数为 0，符合“只在受影响成员用原浏览器首次进入时执行 owner-scoped 迁移”的设计，没有凭空生成或删除画布数据。
- 两个 systemd 服务均为 `active`，主健康接口正常，主平台、视频工坊和无限画布分别加载 `20260718-v94-1`、`20260718-16` 和 `Cb3dOInBfODPy4nRJsfpy`。生产私密配置下的 LLM 最小真实请求成功，视频工坊导演真实请求返回 6 个镜头；图片、Seedance、数字人与 TTS 配置均显示已配置且可达，sidecar 导演 / 视频 / 语音配置完整。
- 真实公网 Chrome 已确认登录页正常渲染、无白屏。当前受控 Chrome 没有生产登录态，且不将密码写入自动化记录，因此未伪造“已亲眼验证旧浏览器图片恢复”。迁移 / 修订合并 / 墓碑的 4/4 真实夹具已通过，实际旧图片恢复仍需受影响用户在保留原站点数据的浏览器中首次进入画布触发。

### 注意

- 对已经在 v93 浏览器迁移中只剩摘要、且旧 `localStorage`、历史 namespace、IndexedDB 与浏览器备份都已被外部操作彻底清空的图片，代码无法凭空还原；本版会阻止继续静默覆盖，并优先恢复仍存在的任意副本。部署前不要清浏览器站点数据。
- 视频工坊对用户主动上传的任意外部音频仍保留隔离的 `faster-whisper` 转写能力；它不参与主平台数字人 / 信息流字幕，也不影响本版“信息流默认无字幕、手动明确台词匹配”的规则。

## v93 - 2026-07-18

### 本版范围

- 主平台数字人与信息流自动字幕完全移除 Whisper / VAD 猜测链路、`/api/video/audio-timing` 接口与 whisper.cpp 安装脚本。数字人直接使用分段口播原文和每段实测音视频时长，按标点、字数和片段边界生成单调不重叠时间轴；信息流只读取原始高质量视频提示词中已有的时间段、真实说话主体、冒号 / 说话动词和口播内容，继续拦截 UI 文字、道具文字、导演说明、元数据和负面要求。
- 信息流创意生成契约未做任何改动：原 A / B 面分工、六类创意引擎、3 次重试和 `temperature=1.15` 保持不变，字幕解析只在下游消费最终提示词，不回写、不清洗、不要求增加引号或固定格式。人工字幕始终最高优先级；没有可靠原文或时长时明确空轨，不再生成猜测字幕。
- 清理历史长期参考图和旧权限入口：只保留数字人角色版作为长期生成参考，旧 `imageStyleAssetId` 只留在原账号记录中供无损回滚，不再展示、下发或参与生成。创作者可删除本人普通参考图并安全清理旧图文风格图；账号头像、数字人角色版、已交付 / 已发布资产及交付封面与图集仍由服务端强制保护。历史 `/api/accounts` 写入与删除入口返回 `410`，现行账号数据链路不受影响。
- 视频工坊发布文案改为必须调用真实语言模型，失败时明确报错，不再用本地模板伪装生成成功。工坊沿用主平台 MiniMax 配置与安全音色元数据，音色按“当前成员最新设计音色 → 平台共享最新设计音色 → 系统默认音色”选择；只下发必要的音色 ID 和名称，不暴露密钥或大音频数据。
- 视频工坊读取平台共享 BGM 库，按标题、内容气质、音频设计与素材标签先选相关候选，再在同分候选中做项目级稳定随机；用户明确要求无 BGM / 纯口播时仍优先执行用户意图。
- 视频工坊同一对话现保存最多 50 次独立成片记录：最新成片优先显示，旧成片进入“历史成片”弹窗并可按发布状态筛选。发布状态改为 `publishedVideoOutputs[outputId]`，每个成片独立显示“已发布”；发布、撤回任意一个都不会修改同一对话中其他成片。旧项目首次再生成时才懒归档当前成片，不做全量运行数据迁移。
- 供应商端“全部账号”每张账号卡左上角新增与创作端一致的全局账号序号。服务端先基于全量账号顺序生成只读序号投影，再过滤供应商子账号可见集，因此子账号即使只看到部分账号也不会重新编号；投影不写回数据库。供应商发布清单的素材详情同步新增“发布账号编号”和“制作时间”，制作时间优先读取素材真正提交进入供应商端时写入的 `deliveredAt`，旧交付只读回退 `createdAt`，不误用创作任务建立时间。
- 供应商端“更新观看量”弹窗在素材从未编辑时默认空白，不再把列表展示用的默认 `0` 当成已编辑值；保存过后再打开会回显上次值，用户明确保存的 `0` 也会回显。历史非零值在缺少编辑时间标记时仍兼容回显；空值、负数、非数字和超范围值会在前端明确拦截。
- 登录等待动效收紧为主标题进程文字：点击后大号“登录”会以 420ms 轻微翻转淡入依次显示“正在验证账号权限…”和“正在进入星阵…”，申请模式显示“正在提交申请…”。原独立进度卡、旋转图形、进度线、按钮扫光和整块登录面板外框均已删除；用户名或密码错误提示固定显示在按钮下方且不参与居中布局，失败、超时后会恢复“登录”并解锁重试，`prefers-reduced-motion` 下只更换文字不播放翻转。
- 按低风险顺序实施子应用加载优化：视频项目列表增加成员项目索引、分页摘要缓存与 `Server-Timing`；无限画布的 `localStorage` 只保存当前成员项目摘要，完整节点、消息、视口和 Base64 图片迁入对应成员分仓的 IndexedDB 并按项目懒加载，IndexedDB 不可用时保留原本完整本地存储回退。当前仍保留 iframe 与独立 sidecar，未启用高风险原生挂载或后端合并。
- 主平台缓存标识统一提升为 `20260718-v93-2`；视频工坊提升为 `20260718-16`；无限画布静态构建标识为 `Or3fOhHL8VWpchYKGoLnX`。

### 验证结果

- 字幕与信息流高质量契约 26/26 通过；参考图、创作者权限、成员隔离与交付资产保护专项 37/37 通过；无限画布接入与存储合约 18/18 通过。
- 视频工坊自身 21/21、主平台视频接入 12/12、共享 BGM 3/3、定制创作 14/14、成员隔离 7/7 全部通过。独立发布状态用例实际覆盖“发布两个成片、撤回第二个，第一个仍保持已发布”。
- 主平台全量 `unittest` 217/217、视频工坊 21/21，合计 238/238 通过；主服务与视频 sidecar Python `compileall` 通过。80 个现存 / 新增 JavaScript 通过 `node --check`，7 个现存受跟踪 Shell 脚本通过 `bash -n`，`git diff --check` 通过；跟踪变更中明文 Key 扫描为 0。
- 本地 8787 主服务与 8765 视频 sidecar 健康检查均为 200。真实系统 Chrome 烟测确认：页面标题为“星阵”，定制创作默认进入视频工坊，成员隔离会话和已有项目正常加载，切换无限画布后可建立项目，生成 `xingzhen-canvas:<member>` IndexedDB，`localStorage` 摘要不再含完整项目 body；全过程控制台 0 error。
- 真实配置烟测通过：视频 sidecar 成功使用主平台 MiniMax 默认音色生成有效音频，临时测试文件已立即删除；主服务托管的 `MiniMax-M3` 语言模型最小真实请求返回有效内容。本地库当前没有可用的用户设计音色，因此未写入虚假音色做外部调用；设计音色 ID 精确传递和优先级已由回归用例覆盖。
- 真实系统 Chrome 登录烟测确认：登录主体背景透明、边框为 0、阴影和伪元素均关闭；模拟用户名或密码错误前后，登录主体高度差为 0、顶部坐标仅有浏览器亚像素取整误差 `0.141px`，错误提示位于按钮下方且不会挤动内容。失败后标题恢复“登录”、按钮解锁；减少动态效果模式下动画为 `none`。
- 真实供应商浏览器烟测确认：80 张账号卡从左上角 `#01` 起读取全局序号；展开真实交付可同时看到发布账号编号和分钟级制作时间；选取从未编辑过观看量的真实素材后，弹窗输入值为严格空字符串，仅显示“请输入当前观看量”占位文案，控制台 0 error。
- 缓存实测确认：主页、视频工坊 HTML 和未版本化 JS 为 `no-store`；带 `20260718-v93-2`、`20260718-16` 或 Next 内容哈希的静态资源为一年 `immutable`；视频代理正常返回 `Server-Timing`。

### 数据与部署

- 本版不修改数据库结构，不批量重写账号、成员、资产、生产单、发布清单或子应用项目。逐成片发布状态保存在既有项目 JSON 字段中；旧成片只在用户再生成时于原运行目录内懒归档。无限画布只在当前成员浏览器中执行可回退的本地存储分拆。
- 密钥继续只从现有本地 / 服务器私密环境读取，本版代码、测试和文档不包含明文 Key。用户曾在对话中粘贴过的 Key 不写入仓库，应由密钥所有者在上游控制台轮换。
- 本版功能提交为 `5541b8d`，生产已于 `2026-07-18` 更新到文档提交 `ebc09c8`。部署从干净目标工作树生成受控代码 / 静态文件包，未使用删除式同步，未覆盖或清理服务器数据库、账号、成员、资产、上传、成片、发布记录、子应用项目、模型缓存、认证数据或私密环境。
- 部署前保留回滚点 `v93-pre-20260718-191924`，含代码快照、一致性 SQLite 备份和受保护运行目录检查点。回滚只能恢复代码与服务配置，不得用旧数据库覆盖部署后新增的业务数据。
- 上线时数据基线前后一致：账号 80、成员 23、资产 2839、生产单 539、任务 689、批次 74、发布链接 66、指标快照 108、会话 63、音色 5、供应商绑定 64、供应商活动 126；上传、成片、模型缓存和视频工坊运行目录的文件数与字节总量未减少，SQLite 完整性为 `ok`，私密环境指纹未变。
- 生产主服务与视频 sidecar 健康，主入口、视频工坊与无限画布已分别加载 `20260718-v93-2`、`20260718-16` 和 `Or3fOhHL8VWpchYKGoLnX`。服务器复核时负载接近空闲，主健康请求为毫秒级，历史视频文件存在且支持 `206 Partial Content`；用户随后也确认视频工坊成片正常显示。
- 上线后发现两项待修回归：无限画布从 `localStorage` 向 IndexedDB 分拆历史项目时，个别现实浏览器出现“项目摘要仍在、项目内图片节点为空”；登录仍在放行前拉取约 7 MB 全量 `/api/state` 并顺序重写 IndexedDB，草稿列表又一次创建全部封面请求，导致帐号验证后的等待和草稿首屏变慢。服务器资源和媒体文件检查排除了带宽、CPU、内存、磁盘或成片丢失；问题已回传代码任务，等待可恢复迁移与分页 / 增量加载修复后再部署。

### 注意

- “主平台移除 Whisper”不包括视频工坊对用户上传的任意外部音频做独立转写；工坊的 `faster-whisper` 仍在其 sidecar 虚拟环境和持久模型缓存内隔离运行，不会进入数字人 / 信息流自动字幕链。
- 原生前端挂载与后端合并仍属高风险架构变更；本版先通过缓存、摘要、索引、分页和 IndexedDB 减少下载与解析量，保留现有账号隔离、`postMessage` 和回退边界。

## v92.2 - 2026-07-18

### 本版范围

- 累计收口 v92.1 的定制发布能力：无限画布只在“提交发布”时执行与图文工坊一致的发布前精修，直接导出继续保留原图；视频工坊发布封面支持最多 5 张自定义参考图的点击 / 拖拽、缩略图移除和放大预览，数字人角色板仍为默认第一参考。
- 修复批量微调“服务器已经覆盖文件但页面仍像旧图”的缓存错觉：同一资产重生成后更新内容哈希与单调递增修订时间，平台 `/api/files/` URL 自动附加稳定 `asset_rev`；资产 ID、服务器文件名、删除与账号归属语义均不变，外部 URL、data URL 和 Blob URL 不受影响。
- 登录页新增高级两阶段等待反馈：“正在验证账号”与“正在同步工作区”分别展示，输入和按钮在请求中锁定并阻止重复提交；账号验证成功但工作区同步失败时不会进入半登录页面，会清除临时 token、角色和成员身份，显示可读错误并恢复重试。
- 优化主平台及两个定制子应用的加载波动：HTML、未版本化资源和错误响应继续 `no-store`，只有带明确版本参数或内容哈希的静态资源使用长期 `immutable` 缓存；视频工坊历史项目列表增加基于文件纳秒时间与大小的摘要缓存，保存、外部修改和删除都会精确失效。
- 修复供应商端回传闭环与序号一致性：回传接口成功后同一行立即显示“已回传 ✓”，按钮变为“改链接”，刷新或重登后仍由服务端权威状态恢复；创作端、供应商管理员和子账号统一读取同一交付的 `pubSeq`。子账号看不到未分配素材时序号允许不连续，但同一素材绝不因角色可见子集不同而重新编号。
- 兼容没有历史 `pubSeq` 的旧交付：服务端从全量交付集合生成只读 `projectedSeq` 后再做角色过滤，客户端优先显示权威序号；该投影字段不会写回生产资产。供应商发布回传的链接、状态与更新时间继续受服务端保护，晚到的旧页面整集合快照不能清空新回传结果。
- 主平台缓存标识统一提升为 `20260718-v92-3`；视频工坊本轮未修改静态前端，继续使用 `20260717-15`。功能提交为 `b03439a`。

### 验证结果

- 主应用全量 `unittest` 216/216 通过，视频工坊 20/20 通过；跨模块专项 59/59、供应商序号与回传专项 16/16、视频历史摘要缓存专项 4/4 全部通过。集成复核未发现未解决的 P0 / P1 / P2。
- 81 个受跟踪 JavaScript 文件全部通过 `node --check`；服务端与视频工坊 Python 通过 `compileall`；8 个受跟踪 Shell 启动 / 部署脚本通过 `bash -n`；`git diff --check` 通过。
- 8787 主服务与 8765 视频 sidecar 健康检查均为 200。缓存响应验证确认：首页与无限画布 HTML、未版本化主应用 / 视频工坊资源均为 `no-store`；带 `20260718-v92-3`、`20260717-15` 或 Next 内容哈希的资源为一年 `immutable`。
- 真实浏览器隔离烟测确认：登录按“验证账号 → 同步工作区”两阶段运行，连续点击只产生 1 次登录请求；模拟同步 503 后登录门保持、错误可见、控件解锁且 token 被清除。定制创作默认进入视频工坊，视频工坊与无限画布均正常挂载，控制台无应用错误。
- 视频发布烟测确认标题默认空白，封面参考区支持拖拽提示与最终封面点击放大；无限画布发布弹窗明确显示“发布前精修、导出保持原图”。供应商子账号浏览器烟测中，同一已回传素材显示 `#252`、“已回传 ✓”和“改链接”，状态筛选与跳转链接同时正常。
- 100 个、合计约 20 MB 的视频工坊项目摘要模拟中，热加载由 17.74 ms 降至 2.06 ms，约快 8.6 倍；没有实施高风险 iframe 预热，因此不会改变登录 Cookie、`postMessage` 或 IndexedDB 恢复时序。

### 数据与部署

- 本版不修改数据库结构，不执行账号、成员、资产、发布清单或子应用项目的批量迁移 / 重写；旧交付序号仅在读取快照时做只读投影，供应商回传仍更新原交付对象和原分析链接。
- 发布包必须从 `b03439a` 及本版文档提交生成精确代码 / 静态文件清单，只更新应用文件并重启主服务与视频 sidecar；不得覆盖或清理服务器数据库、账号、成员、资产、上传、成片、发布记录、子应用项目、模型缓存、私密环境与认证数据。
- 部署后重点复核：同一交付在创作端、供应商管理员和供应商子账号的序号一致；子账号回传后立即与刷新后均显示“已回传”；批量微调新 URL 立即显示新图；登录同步失败不越过登录门；版本化 / 未版本化缓存边界符合本节记录。
- 生产已于 `2026-07-18 14:13 CST` 更新到文档提交 `09c01fc`（包含功能提交 `b03439a`），主服务与视频 sidecar 均为 active，健康检查为 200；主入口为 `20260718-v92-3`，视频工坊为 `20260717-15`。上线前保留回滚点 `v922-pre-20260718-134500`，部署后文件 dry-run 为 0 条待同步。
- 生产数据保护复核前后完全一致：账号 80、成员 23、资产 2837、生产单 539、任务 689、批次 74、发布链接 66、指标快照 108、会话 63、音色 5、供应商绑定 64、供应商活动 122；上传 2575 个文件、成片 174 个文件、模型缓存 17 个文件、视频工坊运行文件 47 个文件及各目录字节总量均未变化，SQLite 完整性为 `ok`，私密环境指纹未变化。
- 生产浏览器与只读投影验收通过：视频工坊封面多参考图 / 放大预览可见，无限画布正常挂载，批量页面抽查 7/7 个服务器图片 URL 均携带 `asset_rev`，控制台 0 error / warning；267 条子账号可见交付的跨角色序号差异、当前链接差异和未分配泄漏均为 0。登录同步失败、重复提交和供应商即时回传状态继续由生产同版 216/216 测试覆盖，未为验收改写真实交付。
- 缓存边界实测符合设计：主平台及视频工坊 HTML / 未版本化资源为 `no-store`，带发布版本参数的资源和无限画布哈希资源为一年 `immutable`。本次没有出现需要新增到 `Problem Document.md` 的生产事故。
- 回滚方式：精确回退功能提交 `b03439a` 和本版文档提交，恢复主平台缓存标识；不能使用旧数据库覆盖回滚期间新增的线上业务数据。

### 注意

- 长期缓存仅对带明确版本参数或内容哈希的资源生效；以后修改这些文件时必须同步提升 `?v=`。未版本化资源保持不缓存，避免旧代码长期驻留。
- 视频工坊摘要缓存以 `mtime_ns + size` 失效；只有外部程序刻意保持相同纳秒时间且内容大小不变的异常覆盖方式才可能绕过，正常保存、替换和删除都已覆盖。
- 无限画布一次发布最多精修 20 张图片，采用串行处理以避免上游并发限流；处理中会显示等待状态并保持原子清理，直接导出不进入该步骤。

## v92.1 - 2026-07-18

### 本版范围

- 无限画布的“发布”链路新增与图文工坊一致的发布前图片精修：支持 data URL、服务器文件和 Blob 来源，精修后再复制到所选图文账号资产并进入发布清单与供应商端；无限画布原“导出”源码和静态产物均未改动，直接导出继续保留原图。
- 视频工坊发布封面新增独立 AI 参考图区，支持点击多选或拖拽 PNG / JPG / WebP、缩略图移除和点击放大；自定义参考图真实传入既有封面生成链路，数字人账号角色板仍为第一优先参考，最终封面本身也支持点击放大，并保留拖入或上传现成封面。
- 补齐发布弹窗的交互与幂等边界：服务器同步中断、等待重试时锁定参考图删除，避免待同步交付引用的封面被改写；封面预览层按 Escape 只关闭预览，不会连带关闭发布弹窗或清理未提交字段。
- 图文单图重新生成完成只读审计：单号创作每次点击都会重新提交图片模型任务并只写回当前槽位；批量任务微调也会重新提交并覆盖当前资产。本轮未修改图文工坊生成与发布代码。
- 登录等待反馈与两个定制子应用偶发慢加载只完成性能评估，没有实施改动。主平台缓存标识统一提升为 `20260718-v92-2`。

### 验证结果

- 主应用全量 `unittest` 202/202 通过，视频工坊 16/16 通过；单图槽位隔离、图片参考回执、无限画布集成、定制发布、成员隔离、幂等与部署边界等专项测试全部通过。
- 本版修改 JavaScript 通过 `node --check`，服务端与视频工坊 Python 通过编译检查，启动 / 停止 / 状态脚本通过 `bash -n`，`git diff --check` 通过；集成复核结论为可放行。
- 8787 主服务与 8765 视频 sidecar 健康检查通过。真实浏览器隔离烟测确认：视频封面参考图可上传并显示缩略图，参考图与最终封面均可放大，Escape 不关闭发布弹窗；无限画布本地发布生成的真实图片资产带有“发布前精修”标签并进入单图图集，控制台 0 错误。烟测浏览器数据已清除。
- 同一提示词的单图重生无模型回执测试产生两次独立 POST、两个不同任务编号和两个不同结果；真实供应商提交没有在本轮浏览器烟测中触发。

### 数据与部署

- 本版不修改数据库结构，不批量重写账号、资产、发布清单或子应用项目。视频封面自定义参考图仅作为当前发布弹窗的临时账号素材，正常取消、切换账号或发布完成后会清理；不会跨账号进入其他成员项目。
- 本地启动器按项目依赖补齐了受保护的 `apps/video-workshop/.venv`，该运行环境继续由 Git 忽略，不进入版本文件清单。当前本地 8787 与 8765 保持运行，便于继续验收。
- 本轮尚未提交、推送或部署。后续部署继续只同步受控代码与静态资源，不覆盖服务器数据库、账号、资产、上传、成片、发布记录、子应用项目、模型缓存或私密配置。

### 注意

- 批量任务抽屉“保存并重新生成”会真实覆盖同一资产文件，但远端文件 URL 当前可被浏览器缓存最长一小时，极端情况下会短暂显示旧图；这是已确认的显示缓存风险，不代表模型未重新生成，本轮按确认范围未改该旧链路。
- 登录页值得增加按钮内“正在验证 / 正在同步工作区”状态与重复提交保护；真正耗时仍需从 `/api/state` 全量同步和浏览器逐集合落库优化。本轮只评估，未增加动画。
- 子应用时快时慢主要来自离开定制创作后 iframe 被销毁、静态资源强制不缓存、视频历史全量读取项目 JSON，以及无限画布把含 Base64 图片的完整项目状态同步存入 localStorage。建议后续单独实施静态哈希长缓存、历史摘要分页、iframe 预热、视频摘要索引及画布图片迁移 IndexedDB；本轮未动这些加载链路。
- 浏览器崩溃、强制刷新或临时素材删除请求恰好失败时，AI 封面参考图可能以“临时素材”留在当前账号资产中，但不会跨账号或进入交付单；后续可增加按标签和创建时间清扫的低优先级兜底。

## v92 - 2026-07-17

### 本版范围

- 信息流创意提示词恢复并锁定 v91.1 之前的原始高质量生成契约：保留原六类创意引擎、原系统约束、三次生成机会与 `temperature=1.15`，撤销为字幕新增的引号、口播长度、A/B 台词和结构字数限制；生成结果不再经过会替换词语、删除箭头或截断句子的二次清洗。字幕层只读消费最终提示词，不反向修改视频提示词。
- 信息流字幕兜底升级为独立只读解析器：优先识别引号和明确口播字段；冒号写法要求真实人物主体与说话证据，过滤 `台词风格 / 口播要点 / 界面提出方案 / 聊天记录中的用户说` 等元数据和 UI 文案；同时兼容“人物说/问/喊/回答 + 自然台词”的无冒号高质量写法。B 面纯软件界面仍保持零伪字幕，真实音轨和人工轨的优先级不变。
- 视频工坊修复生产普通 HTTP 环境下 `crypto.randomUUID()` 不存在导致拖图、发送均无反馈的问题：统一客户端 ID 生成器依次使用 `randomUUID`、`getRandomValues`、时间戳随机串兜底；发送流程的 `try/finally` 覆盖全部同步准备，附件选择、拖拽、粘贴和异步失败均显示可读错误并恢复输入与 busy 状态。
- 视频工坊发布与音色链路补齐：平台设计音色 ID 可沿用到导演/TTS，音色卡操作区进一步收紧；首页去掉中文副标题，只保留居中的 `XINGZHEN VIDEO WORKSHOP`。浏览器标题统一为“星阵”。
- 无限画布把“生成两张 / 两个不同风格”等数量要求只用于并发任务规划，从每张图片自己的提示词中剥离，避免单张图再次生成双联画；同步更新可维护源码与完整静态部署产物，构建标识为 `s4XuKSY12Bmly5rxjq45o`。
- 创作端与供应商端发布清单新增 `已下载 / 未下载 / 已发布 / 未发布` 四个状态筛选；同一维度互斥切换，下载与发布两个维度按 AND 组合。历史已发布状态、批量待下载和供应商回传链接后的即时刷新统一使用同一状态判断。
- 收紧图文审核、图片工坊文案与参考图状态：审核页只保留成图和发布文案并压缩空白；图片工坊发布文案按紧凑纯文本展示；新建信息流不再继承上一任务的临时参考图，账号长期配置与本次任务选择保持分离。
- 主平台缓存标识提升为 `20260717-v92-1`，视频工坊静态资源缓存标识提升为 `20260717-15`。功能提交为 `8a33494`。

### 验证结果

- 信息流原始质量契约 20 轮真实模型审计全部生成成功：人工评审为 12 轮通过、8 轮边界通过、0 轮失败；没有再出现词语替换、引号断裂、箭头删除或字幕规则污染提示词。
- 使用“国产 Codex 百度搭子自动管理你的知识库！”及另外两组百度搭子知识库标题真实生成：A 面均承担人物痛点/冲突，B 面均为产品界面解决方案，前后通过屏幕、动作或光线自然衔接；A 面真实台词可提取，B 面误字幕为 0。
- 主应用全量 `unittest` 201/201 通过，视频工坊 16/16 通过；新增覆盖普通 HTTP 无 `randomUUID`、同步异常解锁、附件失败恢复、字幕元数据拦截、自然无冒号台词、发布状态筛选、音色 ID 传递和无限画布数量清洗。
- 所有本版实际存在的新/改 JavaScript 通过 `node --check`，Python 通过编译检查，Shell 通过 `bash -n`，`git diff --check` 通过。风险复核结论为 P0=0、P1=0、无未解决阻断 P2。
- 真实浏览器验证创作端与供应商端四个筛选及组合空状态；视频工坊首页只显示居中的英文标题。主动禁用 iframe 内 `crypto.randomUUID` 后，附件预览正常出现，模拟聊天 500 能显示明确错误、恢复原输入并重新启用发送按钮。

### 数据与部署

- 本版不执行数据库结构迁移，不批量重写历史提示词、字幕、账号、发布记录或子应用项目；字幕解析只在用户重新识别或新任务中消费现有提示词。
- 本地 `apps/video-workshop/.venv` 是启动器有意创建的受保护运行环境，不进入 Git；Docker、非 Docker 同步和子应用 `.gitignore` 三层均明确排除。测试改为验证真实打包边界，不再要求开发机物理删除运行环境。
- 部署必须从提交生成精确代码/静态文件清单，继续保留服务器数据库、账号、成员、资产、上传、成片、发布清单、子应用项目、模型缓存和私密环境；不得使用删除式目录同步或把本地 `.venv / runtime / uploads / outputs` 上传到服务器。
- 2026-07-18 已按上述保护边界完成生产部署：线上提交为 `d594ba7`，主平台、视频工坊与无限画布版本标识均与 v92 一致，主服务与 sidecar 均正常运行。回滚点为 `v92-pre-20260718-002112`，回滚仅恢复代码和服务配置，不得使用旧数据库覆盖回滚期间新增数据。
- 部署后已在普通 HTTP 生产入口验证视频工坊拖图、文字发送、异常解锁以及图片/音频/视频附件预览；无限画布带参考图成功返回两张独立图片。数据库完整性为 `ok`，核心业务集合数量与部署前一致，测试项目、媒体和删除墓碑均已精确清理。
- 回滚方式：精确回退 `8a33494` 与本版文档提交，并恢复两处缓存标识；不得用旧数据库覆盖回滚期间新增的线上业务数据。

### 注意

- 字幕解析命中率不足时只能完善只读解析与音频证据，不能再要求视频提示词增加引号、固定口播字段或“无口播”占位。
- 健康接口只证明配置和服务就绪；生产部署后仍要在普通 HTTP 实际入口复测拖图、发送、错误解锁，以及信息流 A/B 提示词质量和字幕误判。
- 本版记录不包含任何明文密钥、服务器地址、token 或生产账号凭据。

## v91.1 - 2026-07-17

### 本版范围

- 修复信息流前后片段字幕识别不一致：字幕后处理现可从既有视频提示词中识别“他说：‘……’ / 喘了一口气说：‘……’ / 闷声说：‘……’”等自然口播描述，并兼容明确的 `旁：` 缩写；继续排除界面文字、导演说明、声音设计、负面约束和普通引号，不修改视频提示词生成逻辑，也不放宽真实音轨严格校验。
- 修复视频工坊本地运行环境使用旧版 `httpx` 时导演请求直接失败：HTTP 客户端按实际版本选择 `proxy / proxies` 与 `follow_redirects / allow_redirects` 参数；生产和标准本地部署仍优先使用依赖固定的视频工坊独立环境。
- 视频工坊空白首页的核心输入区在桌面端向左、向上各微调 8px；平板和移动端布局保持原有响应式位置。
- 主平台缓存标识提升为 `20260717-v91-2`，视频工坊静态资源缓存标识提升为 `20260717-13`。

### 验证结果

- 使用用户截图对应的真实生产单和前 15 秒视频复核：该段音轨并非静音；修复后的解析器从原提示词稳定提取四段既有口播时间线，严格 Whisper 对齐返回 5 条精确字幕，覆盖约 `2.00-13.65s`。后 15 秒原有口播继续识别，并补齐此前漏掉的 `旁：` 时间段。
- 服务端全量 `unittest` 183/183 通过，新增覆盖自然说话动词、`旁：` 缩写、界面文字与负面约束拦截、旧版 `httpx` 客户端兼容及视频工坊首页位置。
- 主前端、视频工坊和无限画布部署产物中的全部 JavaScript 通过 `node --check`；服务端与视频工坊 Python 模块通过编译检查；启动、停止、状态、Docker 入口与本地 sidecar 脚本通过 `bash -n`；`git diff --check` 通过。
- 当前本地 8787 主服务与 8765 视频 sidecar 健康接口均正常；导演模型配置已加载。旧版 `httpx 0.19.0` 环境已验证能够成功构造请求客户端，不再在发起导演请求前因不支持的参数直接失败。

### 数据与部署

- 本版不修改数据库结构，不批量改写现有字幕、生产单或视频工坊会话。截图中的既有生产单刷新后点击一次“识别字幕”即可按新解析规则重新生成；人工字幕轨仍保持最高优先级。
- 2026-07-17 已将目标提交 `0312f48` 累计部署到生产环境，包含 v89-v91.1 全部代码；线上主平台缓存标识为 `20260717-v91-2`，视频工坊缓存标识为 `20260717-13`。
- 部署从目标提交的干净导出生成精确文件清单，只同步 260 个代码 / 静态文件并删除 4 个已废弃源码模块；未使用删除式目录同步，服务器数据库、上传、成片、账号、成员、资产、发布清单、草稿、分析数据、子应用项目、环境文件和认证缓存均未被本地状态覆盖。
- 部署前保留回滚点 `v911-pre-20260717-022439`，包含代码快照、一致性 SQLite 备份、上传 / 成片检查点、私密环境备份与业务数据基线。回滚只恢复代码和服务配置，不能用旧数据库覆盖部署后新增的线上业务数据。
- 主服务与视频工坊 sidecar 均为 active，健康接口正常；视频工坊使用独立虚拟环境并仅绑定本机回环。生产机无法直连默认语音识别模型仓库，已改用可达镜像、禁用不兼容的 Xet 下载路径并预热 `small` 模型到持久缓存，不修改任何模型 Key。
- 真实模型验收通过：主平台 MiniMax-M3 与 MiniMax TTS 最小调用成功；图片、Seedance、OmniHuman、JustOneAPI 均配置可达。无限画布携带 1 张参考图真实出图，服务端回执 `usedRefs=1 / skippedRefs=0`。视频工坊携带参考图、口播音频和视频素材完成端到端成片：参考图进入 Seedance，音频完成转写并作为主音轨，视频素材实际插入剪辑，最终 H.264 + AAC 成片可通过主平台以 `206 Partial Content` 播放。
- 管理员、创作者、供应商母账号和供应商子账号的鉴权 / 权限投影烟测通过；创作角色可使用定制创作，供应商角色被正确拒绝进入私有创作子应用。外部真实浏览器已加载无限画布全部静态资源，并成功读取视频工坊参考素材与最终成片。
- 部署期间活跃成员新增 7 条资产和 6 个上传文件，并删除 2 条 production；这些实时写入均被保留。账号 80、成员 12、发布链接 45、任务 682、批次 65、指标快照 108、会话 57、音色 5、供应商绑定 52 和成片 153 均未减少，私密环境文件指纹前后一致。
- 回滚方式：精确回退自然口播解析、旧版 HTTP 客户端兼容、首页输入区位置及两处缓存标识；不使用旧数据库覆盖回滚期间新增的业务数据。

### 注意

- 健康接口只能证明模型配置和本地服务已经就绪；本轮未额外消耗线上模型额度执行新的导演生成任务。若上游临时网络故障，界面仍会展示上游返回的明确错误，而不会再被本地客户端参数错误混淆。
- 本版记录不包含任何明文密钥、服务器地址、token 或生产账号凭据。

## v91 - 2026-07-16

### 本版范围

- 恢复单号创作视频工作台顶部主操作区：一键生成位于左侧，“下一步：智能混剪”位于右侧，沿用原有黑色长按钮与箭头动效；信息流和数字人下方不再重复出现下一步按钮，尺寸切换与重新生成提示词保持同组，避免此前按钮跑位、圆形化和页面重复操作。
- 信息流取消中间的静态分镜图生成任务，用户明确选择的参考图直接作为前后两段视频的参考输入；点击生成会直接创建两段视频任务。字幕修复不改写、不补充视频提示词：优先识别真实音轨，识别失败时只读取现有提示词中原本就存在的明确口播字段及精确时间段；没有明确口播时间段就保持空字幕，数字人不使用提示词兜底。
- 单号与批量视频只保留数字人和信息流两条主链路，移除已由视频工坊取代的 Seedance / 文案分镜旧页及相关未引用模块。单图“生成此图 / 重新生成”增加槽位身份校验，晚返回结果只能写回原图片，不能覆盖用户已经切换到的下一张图。
- 角色板改为管理员维护：没有角色板时打开空弹窗，管理员可拖拽补充；保存后作为账号固定角色参考，普通创作成员只读。单号封面和定制发布封面均增加拖拽悬停反馈；数字人发布封面默认携带该账号角色板，并继续使用标题、账号风格和现有封面生成链路。
- 无限画布的已发布标记落到实际图片上并可随服务端状态恢复；“定制创作”默认进入视频工坊空白首页。视频工坊历史会话按真实服务端交付显示“已发布 N”，同一会话多次发布会递增，回撤后重新计算。
- 视频工坊助手消息以安全纯文本显示，不再暴露 Markdown 星号；多个成片支持折叠，发送新消息后自动滚动到新消息位置，首页输入区轻微左上校正。增加真实“停止制作”，取消当前异步制作协程并保留已完成文件；当前不伪装暂停 / 无损续跑，符合恢复条件时仍可继续缺失镜头。
- 安全清理账号与选题遗留：删除冗余 `xhsAccountsSeed.js`，`accountProfilesSeed` 只用于真正首次空库初始化，不再在登录或同步时补齐、覆盖、删除管理员维护的账号；移除随机选题、默认主题和占位标题。图文、视频均要求用户先写标题，`xhsTrendLibrary` 仅在用户标题之后提供结构与信息密度参考，不能替用户选题或改题。
- 收紧定制子应用高成本接口、通用集合权限和代理边界：创作接口要求真实登录身份，项目和交付继续按 owner 校验；代理拒绝内网 / 回环 / 越界地址、异常重定向、超限响应和错误媒体类型，避免通过子应用读取服务器私网或写穿他人数据。
- 主平台缓存标识统一提升为 `20260716-v91-1`；视频工坊静态资源缓存标识提升为 `20260717-12`。

### 验证结果

- 服务端全量 `unittest` 180/180 通过，覆盖主按钮唯一性与位置、字幕提示词零注入、真实音轨与现有时间线兜底、信息流直出两段视频、单图槽位隔离、角色板、封面拖拽、画布已发布标记、视频工坊发布计数 / 停止 / 恢复、账号种子减法、标题必填、成员权限和代理安全。
- 主前端、视频工坊和无限画布部署产物中的全部 JavaScript 通过 `node --check`；服务端和视频工坊 Python 模块通过编译检查；启动、停止、状态、Docker 入口与本地 sidecar 脚本通过 `bash -n`；`git diff --check` 通过。
- 专项回归确认字幕代码中不存在“每个时间段必须明确口播原话”或“没有人声就写无口播”等新增生成约束；信息流 A/B 创意提示词仍由原有生成函数产生，字幕层只消费其已有的显式口播时间线。

### 数据与部署

- 本版不执行数据库结构迁移，不批量清理历史账号字段，不覆盖账号、成员、资产、发布清单、供应商数据、草稿、上传、成片、子应用项目或私密环境。已有账号或已有初始化标记时，账号种子不会再次写入。
- 删除的 `xhsAccountsSeed.js` 和旧视频链路模块均为源码冗余；不会删除线上账号、历史生产单、既有成片或资产文件。旧信息流分镜资产继续保留，只是不再被新任务自动创建或读取。
- 本版仍只在本地共享工作区，尚未由本任务提交、推送、部署或发送服务器部署指令。后续部署必须累计包含尚未上线的 v89-v91，并继续保护服务器数据库、上传、成片、子应用运行目录、模型缓存和私密环境。
- 回滚方式：精确回退 v91 的工作台布局、信息流直出、字幕后处理、角色板 / 封面、单图槽位、视频工坊 UX、种子减法、权限代理与缓存改动；不能用旧数据库覆盖回滚期间新增的业务数据。

### 注意

- “停止制作”是真实取消，不等同于可冻结所有第三方任务的暂停。已经进入同步 FFmpeg / QA 工作线程的单个命令可能在后台完成，但被取消的主流水线不会提交该结果。
- 信息流字幕只有在真实识别通过，或现有提示词本身包含明确口播字段和精确时间段时才会生成；不会为了补齐字幕去改变视频提示词、平均分配全文或提取导演说明。
- 本版记录不包含任何明文密钥、服务器地址、token 或生产账号凭据。

## v90 - 2026-07-16

### 本版范围

- 在尚未部署的 v89 基础上完成“定制创作”真实接入：侧边栏入口位于“整体资产”之前，进入后全屏沉浸展示视频工坊 / 无限画布 / 语音生成；三个标签共用平台顶部文字切换和返回首页，视频模式使用黑色顶栏，画布与语音保持白色界面。
- 视频工坊接入项目内 Python sidecar 与真实静态前端，移除嵌入模式下重复的“视频导演台 / 项目标题 / 服务状态”内栏；修复中文输入法组合期间 Enter 误发送、配置状态把可选转写误报为核心缺失、Seedance 下载超时后临时文件损坏、服务重启后运行中任务无法恢复和只重试一个镜头时遗漏其他缺失镜头等问题。
- 视频生成下载采用 `.part` 临时文件、超时重试、退避与原子替换；服务重启会把失去进程的运行态转为可恢复状态，重试时保留口播及全部已完成镜头并继续所有缺失镜头，不重复消耗已成功的生成任务。
- 修复视频目标时长链路：识别用户明确的总时长并排除 `0-2s / 3-6s` 等分镜时间码；主题创作先按目标时长约束口播有效字量，明显不合格时只校准一次，TTS 仅在 `0.85-1.15` 自然语速内微调，生成后再按真实音频做 ±10% 校验。不使用静帧、长静音或异常慢速硬凑；用户上传口播仍是唯一主时间轴，不改写、不拉伸。
- 无限画布接入可维护源码与部署静态产物；最近项目可正常进入，项目卡为一行或两行标题统一预留两行高度并让尺寸/时间贴底；画布选择一张图片后，“发布”与“导出”并列且使用同一选中项。
- 视频工坊的“发布成片”位于成片标题区；无限画布发布使用当前选中的真实图片。两类发布均支持选择匹配的账号与产品、填写必填标题、手写或按标题生成文案、选择发布时间与备注；视频额外支持生成或上传封面。成功后进入账号资产、发布清单和对应供应商端，未发布草稿仍只留在各自子应用。
- 定制发布改为服务端权威事务：账号计数、全局发布序号、交付名称、源资产、封面/图集、发布清单和项目状态一次写入；相同 deliveryId 重试幂等。供应商已下载或已经回传发布链接后禁止回撤；允许回撤时恢复账号进度、共享资产和项目发布态。
- 已发布状态可见且可恢复：视频成片播放器与历史会话显示“已发布”；无限画布首页项目缩略图和真正提交过的单张图片显示“已发布”。画布按 `sourceItemId` 精确记录，多次发布合并已发布图片，回撤后按剩余交付重新计算；刷新后从当前成员的服务端项目恢复，不只依赖临时消息。
- 子应用按登录成员隔离视频项目、画布项目、运行态、临时音频、收藏和私有生成资产；文件读取、覆盖和删除均校验 owner。定制音色对全平台可选，但只有创建者或管理员可以改名、删除和维护。
- 语音生成不再单独占用顶部一行：语音合成 / 音色设计 / 音色管理移动到“文本转语音”编辑框标题区并与“生成音频”同组；删除 MiniMax 模型说明文字，声线卡操作按钮移动到文字下方，长名称与 ID 不再被遮挡；嵌入页保持固定高度，只让音色列表内部滚动。
- 完成子应用部署打包：8787 是唯一对外入口，8765 sidecar 只绑定本机回环；Docker、启动/停止/状态脚本同时管理主服务和 sidecar，代码、静态产物与 FFmpeg/字体/视频依赖纳入镜像，数据库、上传、成片、项目运行数据、模型缓存和环境密钥继续保留在持久目录且不进入代码同步。
- 主平台模块与本版修改过的样式统一使用缓存标识 `20260716-v90-1`；视频子应用静态资源同步提升缓存版本，避免旧 CSS 继续显示重复栏或按钮覆盖。

### 验证结果

- 服务端全量 `unittest` 137/137 通过，覆盖字幕真源、标题→正文→提示词、参考图回执、成员隔离、定制音色权限、视频下载/重启恢复/目标时长、画布桥接、发布与回撤事务、供应商可见性、部署卫生及前端缓存身份。
- 无限画布源码执行 `npm run lint`、`npm run typecheck`、`npm run build:embed` 均通过，部署产物已同步到 `vendor/infinite-canvas/`；构建完成后已清理 `node_modules / .next / out`，部署卫生测试确认不携带本机依赖或运行数据。
- 主前端、视频工坊和无限画布部署产物中的全部 JavaScript 通过 `node --check`；`server/main.py`、`server/store.py` 与视频工坊 Python 模块通过编译检查；`git diff --check` 通过。
- 真实 2048×1024 浏览器验收确认：视频内层重复栏计算样式为隐藏，“未命名服务”不存在，“发布成片”在成片区可见；语音页整体滚动与定制创作舞台滚动均为 0，前三个模式按钮位于编辑框内，抽查 12 张声线卡按钮覆盖数为 0，模型说明文字不存在。
- 无限画布首页与语音页完成真实浏览器烟测；首页、批量创作、单号创作、整体资产、发布清单、数据分析和设置主路由均无页面渲染错误、无横向溢出。浏览器控制台 0 error；仅有同源子应用 iframe sandbox 与主动路由保护的预期 warning。
- 真实视频项目 `73b2390c5620` 在 Seedance `ReadTimeout` 与本地服务重启后成功恢复：缺失镜头 2、4 均生成完成，项目状态为 `succeeded / delivery / 100%`，最终文件为 720×1280 H.264 + AAC 且包含音频。该旧任务的口播只有 24.696 秒，因此既有成片为 24.7 秒；本版已修复未来明确目标时长的制作前校准和合成前实测拦截，但没有为了测试再次消耗视频生成额度重做旧成片。
- 本地验收服务已使用当前代码重新启动：主平台 `http://localhost:8787` 正常，视频 sidecar 核心服务 `ready=true`；本机未安装的可选口播转写模块显示 degraded，但导演、视频、TTS、FFmpeg、质检和共享 BGM 均已就绪。

### 数据与部署

- 本版不执行破坏性数据库迁移，不覆盖既有账号、成员、资产、发布清单、供应商备注、分析数据、草稿、上传、成片或私密环境；新增定制项目、输出和发布关联均为 owner-scoped 文档与服务端事务。
- 视频工坊运行项目、上传和成片继续保留在 `runtime/video-workshop/`；无限画布源代码与部署产物分离。部署时不得使用删除式同步，也不得把本地运行目录、认证缓存、虚拟环境、模型缓存或环境文件上传到生产。
- 本版仍只在本地共享工作区，尚未由本任务提交、推送或部署；生产环境继续运行已上线版本。后续服务器部署必须累计包含尚未上线的 v89 与本版 v90，并在部署前后核对数据库、上传、成片和私密环境指纹。
- 回滚方式：精确回退 v90 的定制创作路由、子应用代码/静态产物、owner API、发布事务、sidecar 生命周期和 `20260716-v90-1` 缓存改动；不使用旧数据库覆盖回滚期间新增的业务数据。

### 注意

- 已完成的旧 40 秒任务不会自动重生成；其 24.7 秒成片保留用于验收恢复链路。新建明确时长的主题视频会使用本版校准逻辑，口播仍不合格时会在提交 Seedance 或最终合成前明确停止。
- 本机 sidecar 的“口播音频转写”是可选能力；生产镜像已声明相关依赖，但部署任务仍需验证真实模型可用性和持久模型缓存，不能只看核心健康状态。
- 本版记录不包含任何明文密钥、服务器地址、token 或生产账号凭据。

## v89 - 2026-07-16

### 本版范围

- 重构数字人与信息流智能字幕的真源链路：数字人优先直接分析每段原始 MP3 / 音频资产，信息流才读取视频人声；不再拿混入 BGM 或经过视频处理的成片音轨替代清晰口播。视频真实时长和口播音频时长分开保存，媒体 metadata 不再覆盖 `audioDuration`。
- 参考 OpenMontage 的可靠原则收紧识别：Whisper 只负责真实 token 时间锚点，不再把整段口播作为 initial prompt；已知台词仅在识别后用于文字校正。清晰音频或严格信息流没有真实锚点时保留空字幕轨，不再用 VAD 均分全文，也不再把导演说明、画面规定、负面约束或任意引号文字伪装成口播。
- 字幕接口返回真实 `engine / source / inputSource / clipSources`。修复本机 whisper.cpp Metal 推理崩溃后仍看似使用 Whisper 的问题：macOS 默认 CPU 推理，其他平台 GPU 失败只自动重试一次 CPU；中文 `.en` 模型直接拒绝。多条口播锚点在同一字幕轨上强制不重叠。
- 字幕与时间轴改用稳定 `clipId` 和异步修订号：重新生成口播、裁切、拆分、删除、排序或重新绑定视频会使旧自动轨和旧成片失效，晚返回的旧识别结果不能覆盖新时间轴；人工字幕继续保持最高优先级。最终合成真正应用 `trimIn / dur`，数字人口播片段取消会混叠人声的 0.35 秒交叉转场。
- 修复服务器图文标题链路：服务端托管的同源语言模型配置不再被浏览器陈旧 key/provider 覆盖；标题变化或正文为空时先真实生成正文并记录来源，成功后才按“标题 + 新正文”生成图卡提示词。该链路禁止静默回落本地模板，失败时明确提示；多图除封面完整保留标题外，其余图片按正文结构互补分配，避免信息过密或过空。
- 继续收紧批量参考图：任务切换和账号移除会清理不可见的旧选择，批次保存独立参考快照；图片、视频封面和信息流分镜保存服务端 `usedRefs / skippedRefs / mode` 回执。用户明确选择参考图但服务端实际使用为零时直接失败，不再悄悄转成纯文生图。
- 全局搜索改为参考 `oguzhantufenk/gooey-search` 的收缩展开交互，保留键盘、输入法、焦点、Safari 和 reduced-motion 降级，不引入 React 运行时。
- 建立“定制创作”第一阶段隔离架构：侧边栏进入后默认视频工坊，顶部可切换视频工坊 / 无限画布 / 语音生成并提供返回首页；语音生成已复用现有页面，视频工坊和无限画布当前只建立独立挂载点。服务端增加 owner-scoped 定制项目 API，禁止通过通用状态接口写穿或伪造已发布状态，为下一阶段接入两个现有子应用保留安全边界。
- 前端缓存标识统一提升为 `20260716-v89-1`。

### 验证结果

- 服务端全量 `unittest` 72/72 通过，覆盖直接 MP3 字幕、真实识别引擎回执、GPU 失败转 CPU、低匹配拒绝、信息流未说文本拦截、字幕不重叠、裁切合成、异步失效、图文标题调用顺序、多图信息编排、参考图回执与定制项目权限。
- 全部 JavaScript 文件通过 `node --check`；`server/main.py`、`server/store.py` 通过 Python 编译；`git diff --check` 通过。
- 使用真实 15.16 秒中文口播转成 MP3 并调用本版字幕接口：返回 `whisper.cpp / direct-audio`，三条字幕分别定位在约 `0.00-1.38s`、`1.40-2.47s`、`9.74-11.69s`，中间长停顿得到保留且字幕没有均摊或重叠。
- 图文专项测试确认请求顺序固定为正文模型在前、图卡提示词模型在后；第二次请求真实包含刚生成的正文，5 张图卡提示词互不重复，封面包含完整标题且长度保持在受控范围。
- 通过本地 8787 与当前服务器托管模型执行真实前端方法：正文来源返回 `llm-title-copy`，图卡来源返回 `llm`，先生成 1034 字正文，再生成 5 张互不重复的提示词；封面标题为用户完整标题，末张收束到“可复用模板与交付前检查”。
- 隔离数据库浏览器烟测确认：登录、首页、Gooey 搜索打开/筛选/Enter 跳转/Esc 关闭与焦点恢复、定制创作三标签、语音内层栏避让和返回首页全部正常；控制台 0 error / 0 warning，服务请求无 4xx/5xx。临时 8791 服务和 Playwright 会话已关闭，未接触真实数据库。

### 数据与部署

- 定制创作使用现有 `docs` 存储中的新增 owner-scoped 集合，不执行破坏性数据库迁移，不改写既有账号、资产、生产单、发布清单、草稿、分析数据、上传或成片。
- 本版仍只在本地工作区，尚未提交、推送或部署；生产环境继续运行 v88，必须完成本地验收后再由服务器部署任务更新。
- 后续部署只能精确同步本版代码与静态资源，不得覆盖或清空服务器原有业务数据库、上传目录、成片目录、环境配置和认证缓存。
- 回滚方式：回退 v89 的字幕真源、标题链路、参考图回执、搜索交互、定制创作外壳和 `20260716-v89-1` 缓存改动；不需要回滚既有业务数据。

### 注意

- “定制创作”目前完成的是隔离壳、路由、权限与项目 API；视频工坊和无限画布的真实前端与发布桥接尚未接入，不能把挂载占位视为子应用已经完成。
- 自动字幕质量未通过时会明确保留空轨，用户可重试或手工编辑；这是为了停止产生看似完整但内容和时间都不可信的字幕。
- 本版记录不包含任何明文密钥、服务器地址、token 或生产账号凭据。

## v88 - 2026-07-16

### 本版范围

- 修复批量图文参考图暗带：生成阶段不再自动合并账号历史 `imageStyleAssetId`、统一参考、产品图、Logo、界面图或角色图；批量成图只使用任务板上明确显示的统一参考图和账号定制参考图。
- 每张新生成的批量图片保存本次实际参考图快照，微调和重新生成沿用该快照；历史已完成图片没有快照时不反写当前选择，避免把新选择误记成旧成图的生成依据。
- 同步检查并修复批量视频：素材视频、信息流分镜、功能演示和视频封面只使用任务板上明确选择的视频参考图及账号定制参考图，不再补入账号历史产品/Logo/界面素材。数字人角色图仍按账号明确配置读取。
- 图文、素材视频、真人视频相互切换时清空不兼容的统一参考图和账号定制参考图，避免上一个类型的隐藏字段进入新任务。
- 图文工作台把按钮改为“按标题生成正文与图卡提示词”：标题变化后先按新标题重写正文，再生成图卡结构与提示词；标题不变时保留用户手写正文。
- 清理 `prompts.js` 历史占位：删除未使用的假 BGM 曲目、固定风格池和固定选题池；旧脚本页不再展示固定风格标签，随机/离线兜底改为读取账号当前风格和产品知识库。
- 前端模块缓存标识统一提升为 `20260716-v88-1`，避免新旧 Agent、创作台和抽屉模块并存。

### 验证结果

- 服务端全量 `unittest` 43/43 通过，覆盖批量视频不读取旧账号参考图、批量图文显式引用约束、标题变化同步重写正文、旧 BGM/风格/选题池清理和前端模块单一缓存身份。
- 全部 JavaScript 文件通过 `node --check`，服务端 Python 编译检查通过，`git diff --check` 通过。
- 隔离数据库真实浏览器验收确认：图文任务选择统一参考图后切换素材视频，旧参考图立即清空；任务板明确提示只使用当前显示的参考图。
- 图文工作台把标题从旧标题改为新标题后，正文与 4 张图卡提示词同步更新；标题不变时再次生成提示词，用户手写正文保持不变。
- 浏览器实际加载 Agent、Studio、ProdDrawer 等模块均为 `20260716-v88-1`，关键页面控制台 0 error，未观察到面板闪烁或重复模块状态覆盖。

### 数据与部署

- 本版只修改生成引用规则、创作交互、历史提示池与前端缓存，不修改数据库结构，不做破坏性数据迁移。
- 不删除历史账号参考图或既有任务数据；只停止批量任务隐式读取。既有账号角色图仍用于数字人身份一致性。
- 浏览器验收使用 `/tmp` 隔离数据库和临时管理员口令，未读取或写入项目原数据库及线上数据。
- 2026-07-16 17:02 CST 已将应用提交 `f44d770` 部署到生产环境，入口静态资源确认加载 `20260716-v88-1`；本次累计包含 v86-v88 代码，只同步 34 个已跟踪代码/静态文件。
- 部署前保留回滚点 `v88-pre-20260716-164948`，包含代码快照、一致性 SQLite 备份、上传/成片检查点、环境配置私密备份和数据基线。回滚只恢复代码与静态资源，不使用旧数据库覆盖部署后的生产写入。
- 干净工作区、服务器暂存目录和生产目录均通过全量 43/43 测试、JavaScript 语法检查与 Python 编译；服务重启、健康接口和线上 HTML 冷读取通过，私密环境文件指纹未变化，最近服务日志无 error/traceback。
- 生产浏览器管理员登录后加载 80 个账号且控制台 0 error / 0 warning；共享 BGM 页平铺显示 2 条历史账号绑定 BGM，页面无账号筛选，剪辑素材页同样为平台共享视图；批量任务板正常加载统一/定制参考图区域和 50 个图文账号。
- 部署前后保护集合没有减少：账号 80、成员 12、发布链接 45、生产单 465、任务 679、批次 64、指标快照 108、会话 56、音色 5、供应商绑定 52、成片 147 均保持；验收期间线上正常新增 1 条资产和 1 个上传文件，已原样保留。
- LLM、图片、TTS、Seedance 与数字人配置接口均报告已配置且可达，未修改任何服务器私密模型配置。
- 回滚方式：回退 v88 的显式参考图选择、标题联动正文、旧提示池清理和 `20260716-v88-1` 缓存改动；不需要回滚业务数据。

### 注意

- 单号创作仍可按账号现有配置使用默认参考素材；本次限制针对批量任务，保证任务板展示与真实生成入参一致。
- 本版记录不包含任何明文密钥、服务器地址、token 或生产账号凭据。

## v87 - 2026-07-16

### 本版范围

- BGM 库与剪辑素材库改为平台共享库：移除账号筛选、账号分组、账号标签与分配账号入口，所有成员按权限看到同一份平铺素材列表。
- 剪辑台 BGM 选择器改为读取全局 BGM 库，不再只读取当前账号资产；任意剪辑台都能选择其他账号历史上传的 BGM。剪辑台新拖入或上传的 BGM 直接写入共享库。
- 兼容历史账号绑定数据：已有 BGM 与剪辑素材即使仍带旧 `accountId` 也按共享素材识别；删除账号时仅解除这类素材的账号绑定，不删除其资产记录或服务器文件。
- 服务端同步开放创作成员之间的共享 BGM / 剪辑素材可见性，普通账号私有图片、视频和音频仍保持原权限边界，供应商权限不扩大。
- 前端缓存标识提升为 `20260716-v87-2`，确保共享库卡片类型与剪辑台选项不会继续命中旧模块缓存。

### 验证结果

- 服务端全量 `unittest` 41/41 通过，新增覆盖跨创作者共享 BGM / 剪辑素材可见、普通私有素材隔离、共享库前端约束和跨账号剪辑台 BGM 选项。
- 目标 JavaScript 通过 `node --check`，服务端 Python 测试导入与执行正常，`git diff --check` 通过。
- 隔离数据库真实浏览器验收确认：BGM-A、BGM-B 在共享 BGM 库平铺显示，账号筛选不存在，卡片显示“共享 BGM · 音频”；共享剪辑片段显示“共享剪辑素材 · 视频”，同样没有账号筛选。
- 账号 A 的剪辑台 BGM 下拉同时包含账号 A、账号 B 的 BGM，分组名称为“共享 BGM 库”；首页、批量创作、单号创作、整体资产、发布清单、语音生成和设置主路由均无视图错误，浏览器控制台 0 error。

### 数据与部署

- 本版已随 v88 应用提交 `f44d770` 于 2026-07-16 累计部署；生产入口统一使用 `20260716-v88-1`。
- 不修改数据库结构，不做破坏性数据迁移；历史共享素材在读取时按内容类型兼容，删除账号时安全解除旧账号绑定。
- 不清理或覆盖账号、成员、资产、发布清单、备注、分析数据、草稿、上传、成片或私密环境配置。
- 回滚方式：回退 v87 的共享素材识别、资产页共享展示、剪辑台全局 BGM、账号删除保护、服务端可见性与 `20260716-v87-2` 缓存改动；不需要回滚业务数据。

### 注意

- 本版记录不包含任何明文密钥、网络地址、token 或账号凭据。

## v86 - 2026-07-16

### 本版范围

- 数字人与信息流字幕改为“已知口播文本负责内容、Whisper 只负责时间”的混合强制对齐：whisper.cpp 启用完整 JSON token 时间戳，将中文 token 展开为字级时间锚点，再把本次真实口播按匹配位置生成字幕，避免段级识别导致整句提前或滞后。
- 信息流从视频提示词的 `0-3s / 3-7s` 等时间线中只抽取明确标注的口播、台词、对白、旁白或角色说话内容；提示词说明、画面描述、标题、负面约束和任意引号文本均不再成为字幕候选。信息流启用严格音频验证，真实音轨未达到匹配阈值时不生成猜测字幕。
- 精确识别字幕保留 0.01 秒时间戳与片段编号，只做片段边界裁剪；不再经过旧的 0.1 秒取整和全轨游标重排。人工字幕与 `audio-analysis-v5` 轨道继续受保护，媒体 metadata、进入审核和重复渲染不能覆盖。
- 清除仍在执行的旧账号分类指令：删除 `宝妈 / 宝爸 / 职场效率 / 家庭管理 / 学生教培 / 岗位垂类` 等目标人群池、Agent 标签识别、标签筛号、模型标签字段、界面标签展示及硬编码“职场口播感”。批量创作改为按内容分组、活跃度与账号真实创作风格工作。
- 源码内置账号种子与旧迁移逻辑已移除 `qtags` 分类字段；线上及本地既有账号数据不做破坏性批量改写，历史记录即使仍含该字段也不再被读取、展示、筛选或发送给语言模型。
- 前端缓存标识提升为 `20260716-v86-1`。

### 验证结果

- 服务端全量 `unittest` 39/39 通过；新增覆盖完整 Whisper token 时间戳对齐、严格信息流拒绝未说提示词、旧账号分类指令清除、人工字幕保护、无自动合成回归及状态模块单一缓存身份。
- 使用本机中文语音实际生成 4 秒临时视频并运行 whisper.cpp：识别结果按真实停顿输出 `0.07-1.62s` 与 `2.02-3.74s` 两条精确字幕，内容严格来自已知口播文本。
- 目标 JavaScript 文件通过 `node --check`，服务端 Python 文件通过编译检查；`git diff --check` 通过。
- 隔离数据库浏览器烟测确认剪辑台按 `0.07 / 1.62 / 2.02 / 3.74` 秒显示两条受保护字幕；账号矩阵只显示内容分组，不再显示旧分类。`studio.js` 与 `prodDrawer.js` 全部统一使用 `20260716-v86-1` 单一模块 URL，避免重复模块状态导致页面闪烁或相互覆盖。

### 数据与部署

- 本版已随 v88 应用提交 `f44d770` 于 2026-07-16 累计部署；生产入口统一使用 `20260716-v88-1`。
- 不修改数据库结构，不清理或覆盖账号、成员、资产、发布清单、备注、分析数据、草稿、上传、成片或私密环境配置。
- 回滚方式：回退 v86 的字幕混合强制对齐、旧分类清理与 `20260716-v86-1` 缓存改动；不需要回滚业务数据。

### 注意

- 信息流没有在真实音轨中确认到提示词口播时会保留空字幕轨，而不是再次用时间均分制造看似完整但内容不可信的字幕。
- 本版记录不包含任何明文密钥、网络地址、token 或账号凭据。

## v85 - 2026-07-16

### 本版范围

- 修复数字人剪辑加入 BGM 后最终审核成片丢失口播：数字人合成明确保留视频片段自带的真实口播音轨，再与循环到完整时长的 BGM 混音；外部口播素材只在片段没有声音时作为回退，避免两条口播叠加。
- 混音配置纳入成片缓存签名。切换、上传或移除 BGM，以及修改 BGM/口播音量后会立即使旧成片失效；服务端输出文件名加入纳秒时间与随机后缀，连续重合成不会复用相同 URL 或命中浏览器旧缓存。
- 信息流剪辑恢复真实视频人声识别：优先使用本机 Whisper 识别人声并结合本次脚本纠错；清理方框、替换符、模型控制标记和常见幻觉字幕，低质量结果不进入时间轴，而是稳定回退到现有脚本估时字幕。
- 字幕识别按“素材组合 + 模式”保存尝试签名，同一任务只自动执行一次；页面自动识别与点击下一步会等待同一个进行中任务，媒体时长到达只归一化边界，不再重复启动识别或覆盖人工字幕。人工修改后的字幕轨保持最高优先级。
- 首页账号表现可点击进入账号级明细，汇总内容、播放、点赞、收藏、评论和分享，并逐条显示账号、素材标题、平台、指标及发布链接；链接明细同步补齐赞藏评与账号、标题信息。
- 首页重复的发布素材/链接摘要改为互动构成与数据完整度，分别查看逐条互动数据和缺少快照的链接；星阵数据助手显示前统一移除 Markdown 粗体、标题、代码标记和列表符号。
- 前端缓存标识提升为 `20260716-v85-1`。

### 验证结果

- 服务端全量 `unittest` 35/35 通过，覆盖数字人片段原声与 BGM 混音命令、信息流智能字幕质量保护、手工字幕保护、成片混音签名和首页明细/纯文本回答。
- 使用真实 FFmpeg 生成三条不同频率的测试音轨并完成实际合成：数字人片段原声与 BGM 同时存在，外部重复口播未混入，输出文件包含有效音频流。
- 使用真实 Whisper 对纯音调素材执行识别，模型产生的无关“字幕 by …”幻觉被质量闸门全部拒绝，0 条进入字幕轨。
- 本地真实浏览器检查首页、整体资产、发布清单、数据分析、语音、设置与批量创作主路由；各页无视图错误、无横向溢出，控制台 0 error / 0 warning，入口确认加载 `20260716-v85-1`。
- 目标 JavaScript 文件通过 `node --check`，服务端 Python 文件通过编译检查，`git diff --check` 通过。

### 数据与部署

- 2026-07-16 已将应用提交 `5f7a9ec` 部署到生产环境，入口主 JavaScript 与主样式均确认加载 `20260716-v85-1`；服务重启和健康检查通过。
- 部署仅精确同步 9 个代码/静态文件，同步前已 dry-run，没有使用删除式同步。生产数据库、上传、成片、账号、成员、资产、发布清单、草稿、分析数据、环境配置和认证缓存均未进入同步清单，私密环境指纹前后一致。
- 生产虚拟环境全量测试 35/35、全部 JavaScript 语法检查和 Python 编译通过；上线后服务日志无 error/traceback，真实浏览器控制台 0 error / 0 warning。
- 生产临时媒体验收以真实 FFmpeg 合成数字人片段原声和循环 BGM，输出含有效 AAC 音轨；命令检查确认保留片段口播、混入 BGM，并跳过重复外部口播。信息流字幕质量闸门和手工字幕保护由生产 35/35 测试覆盖。
- 真实浏览器首页显示 80 个账号，账号表现明细可展开并正常显示标题、平台、播放、赞、藏、评、分享与发布链接；数据助手返回纯文本回答。
- 保护集合无任何减少：账号 80、成员 12、资产 2524、生产单 452、任务 676、批次 62、指标快照 108、会话 55、音色 4、供应商绑定 52、上传文件 2313、成片文件 142。验收期间有成员正常使用线上平台，新增 2 条回传链接和 4 条供应商下载活动，已作为有效生产写入保留，未用部署前备份覆盖。
- 语言、图片、视频/数字人和语音配置端点均报告已配置且可达，未更换任何私密配置。
- 回滚点：`v85-pre-20260716-120840`，包含部署前代码快照、一致性 SQLite 备份与上传/成片校验点。回滚只恢复代码和静态资源，不覆盖当前生产业务数据。
- 本版不修改数据库结构，不清理或覆盖账号、成员、资产、发布清单、备注、分析数据、草稿、上传与成片目录或私密环境配置。
- 回滚方式：回退 v85 的剪辑混音、智能字幕、首页明细和 `20260716-v85-1` 缓存改动；不需要回滚业务数据。

### 注意

- 本版记录不包含任何明文密钥、网络地址、token 或账号凭据。

## v84 - 2026-07-15

### 本版范围

- 整体资产的账号归档从仅图片扩展为共享图片与视频：按账号导出 ZIP 后再删除对应资产及服务器文件；头像、音频、账号资料和发布记录不在清理范围内。服务器删除失败时保留尚未完成的本地引用并明确报错，避免页面显示已清理而文件仍占用空间。
- 收紧整体资产折叠行与素材卡操作区；图片和视频卡片的操作按钮改为卡片内等宽布局，避免越出边界。
- 删除创作端管理员发布清单里的“供应商视角”模拟入口；创作端直接获得产品、形式、发布人、账号、时间和未读备注筛选，真实供应商角色仍保留供应商发布清单与权限语义。
- 移除素材号账号主页的角色版展示；真人数字人账号恢复角色版，图文账号保留风格版，并统一收为“跳转主页”旁的小按钮。已有图片点击查看，管理员在缺失或需要替换时可点击选择或直接拖入，普通创作者只读。
- 修复发布清单、数据分析和语音页首次进入时的重复重绘：页面不再在首屏绘制后自行拉取并整页再画；语音服务状态更新只替换状态文字，不重建整个面板。
- 字幕策略按内容形态分流：数字人继续使用视频人声分析并保护已识别时间轨；素材视频使用脚本与片段时长估算。用户手动修改后的字幕轨始终优先，媒体元数据、进入审核和再次合成都不能覆盖。
- 数字人剪辑预览加入与成片一致的 0.35 秒相邻片段叠化层；素材视频保持硬切，不额外制造叠化。
- 合成字幕显式选择可用中文字体并配置字体目录，避免服务器合成出现方框字；支持私密环境通过字体文件或字体名覆盖，但不写入仓库配置。
- 图片文生图、带参考图编辑及视频任务均加入应用侧排队与上游忙碌重试；达到并发或限流阈值时等待空位，不直接把并发错误抛给创作者。
- 剪辑台字幕编辑补齐播放头工作流：新字幕直接建立在播放头，字幕可按播放头拆成前后两段，并支持复制、剪切、粘贴、删前段和删后段；所有字幕起止时间会被限制在真实视频总时长内。
- 视频审核页改为单屏三列：左侧合成成片、中间封面图、右侧标题与发布文案；视频审核不再展示脚本、视觉素材和成片构成明细，桌面端不需要继续向下滚动。
- 首页与数据分析合并为单屏复合数据看板：借鉴 Overview dashboard 的 KPI 摘要、生产流程、平台环图、近七日折线趋势与明细层级，但沿用项目冷白、偏蓝灰的低饱和黑白体系；不再设置整体 / 发布素材 / 数据分析切换，也不直接铺表格或产生横向滚动。待办、发布素材、沟通备注、回传链接和账号表现统一为可点击的摘要卡与图表；数据助手调整为紧贴主框架右侧的独立全高对话栏，与左侧数据看板共同占满单屏，不再作为页面内嵌卡片或底部长条。
- 草稿箱并入整体资产顶部切换并作为首次进入默认面板，不再占用独立导航；删除“去发布清单”，顶部按钮居中并彻底去除胶囊容器和圆角底框，面板切换使用轻量淡入过渡。图文创作模式切换及登录页“申请账号”同样改为纯文字与克制下划线反馈。
- 批量账号对话栏新增“开启新量产面板”按钮，可在当前会话中插入一份新的独立生产计划；创作端发布清单的发布人筛选仅管理员可见，普通创作者只查看自己的内容。
- 新增版本更新提醒：浏览器发现入口缓存标识变化后在左上角显示可关闭、可立即刷新的轻提示，并在短时间后自动收起。
- 修复服务器修改账号创作风格后过一会恢复种子值：账号手动保存时写入风格编辑时间，登录后的账号画像补全只更新未手动维护的风格字段，不再覆盖管理员修改。
- 首页筛选控件统一由同一外框容纳图标、标签和箭头，避免图标游离；普通大号二级按钮采用 Codrops Button Hover Styles 03 的克制扫入反馈，流程“下一步”按钮采用 08 的方向性轮廓反馈，并保留 reduced-motion 降级。
- 登录面板恢复垂直居中与“申请账号”入口；申请入口保留登录/申请切换逻辑，并采用 Codrops Line Hover Styles 06 的纯文字下划线动效，不再显示胶囊按钮。
- 首页数据助手进一步贴合应用最右侧并占满可用高度，不再继承页面四周留白；生产流程的单柱和近七日折线的单节点增加克制的浮起、高亮与数值提示，交互参考 Simple Graph 但不引入 React/Shadcn 运行时依赖。
- 流程“下一步”按钮彻底移除旧胶囊外框，按钮自身使用方向性箭头轮廓；登录与申请模式改为“淡出—更新字段与文字—淡入”的连续切换，申请入口文字同步显示“返回登录”。
- 按 Codrops Anthe 原始结构重新实现流程按钮：默认由矩形伪元素完整承载底色，悬停时伪元素使用原版贝塞尔时序平滑收束为箭头，按钮本体不裁剪、不残留胶囊背景。登录与申请模式改为卡片内容模糊消散后重新汇聚，卡片外框保持稳定，右上角模式文字同步执行同类过渡。
- 近七日交付改用 Catmull-Rom 转三次贝塞尔曲线，SVG 恢复等比缩放，节点保持正圆；节点悬停延续 Simple Graph 的放大、光晕与数值提示语义。数据助手对话气泡统一为深黑灰与冷浅灰，移除紫蓝渐变。
- 前端静态缓存标识统一提升为 `20260715-v84-5`；`main.js` 与 `store.js` 继续使用不带 query 的规范 `remote.js` 导入，保持单例登录与状态同步。

### 验证结果

- 服务端全量单元测试 31/31 通过，覆盖无参考图/有参考图 MaaS 分流、图片 JSON 与 multipart 排队重试、视频排队重试、中文字体选择、字幕来源保护、字幕编辑边界、数字人预览叠化、资产归档、复合看板、账号风格保护与稳定首屏回归。
- 全部 JavaScript 文件通过 `node --check`；`server/main.py`、`server/store.py` 通过 Python 编译；`git diff --check` 通过。
- 本地使用实际 ffmpeg 完成 1 秒中文 SRT 烧录，选中系统中文字体并生成有效视频文件，验证字幕过滤器与字体目录可用。
- 入口及本轮页面依赖缓存扫描确认统一为 `20260715-v84-5`，`remote.js` 仍只有同一规范模块地址；登录消散汇聚、原版 Anthe 结构、等比正圆节点、贝塞尔趋势曲线、黑白灰对话气泡及图表悬停提示均通过源码断言。
- 本地实际浏览器完成登录页与管理员、创作者、供应商母账号、供应商子账号四角色主要页面回归；全部已验页面无横向溢出、无空白根节点、无视图错误，控制台 0 error。供应商备注对话框、语音筛选下拉层和角色路由权限一并验证通过；验收截图仅保存在本地 `output/playwright/v84-final-audit/`，不写入 `design-qa.md`。

### 数据与部署

- 2026-07-16 已将应用提交 `7756a08` 部署到生产环境，入口缓存标识确认是 `20260715-v84-5`；服务重启、健康接口与真实浏览器冷启动均通过。
- 部署采用干净目标提交、29 文件精确清单和同步前 dry-run，没有使用删除式同步。服务器数据库、上传与成片目录、环境配置、认证缓存和日志均未进入同步清单，私密环境配置指纹部署前后相同。
- 生产虚拟环境全量测试 31/31、全部 JavaScript 语法检查和 Python 编译通过。语言、图片、视频、数字人和语音配置均为已配置且可达。
- 服务器原先没有中文字体文件，部署验收时补装标准 Noto CJK 字体，并用真实 FFmpeg 完成 1 秒中文字幕烧录；字幕字体选择现已返回有效字体与目录。
- 真实浏览器管理员登录后复合首页正常加载 80 个账号且控制台 0 error；整体资产默认进入合并后的草稿箱并展示现有 53 条草稿，全程未执行删除、归档或生成操作。
- 部署前后关键数据计数完全一致：账号 80、成员 12、资产 2523、生产单 453、任务 676、批次 62、分析链接 23、指标快照 108、会话 55、音色 4、供应商绑定 52、供应商活动 28、上传文件 2312、成片文件 140。
- 回滚点：保留 `v84-pre-20260716-011950`，包含部署前代码快照、一致性 SQLite 备份和上传/成片校验点。回滚只恢复代码和静态资源，不覆盖当前生产业务数据；服务器字体依赖可保留。
- 本版不修改数据库结构，不覆盖账号、成员、发布清单、分析数据、草稿或私密环境配置。账号文件归档仅在用户明确确认并成功下载 ZIP 后，按选中账号逐个删除共享图片/视频资产。
- 回滚方式：回退 v84 前端、服务端和 `20260715-v84-5` 缓存改动；不需要回滚业务数据。已经由用户主动执行的资产归档属于显式删除操作，应从导出的 ZIP 恢复，而不能用旧数据库覆盖当前数据。

### 注意

- 本版记录不包含任何明文密钥、网络地址、token 或账号凭据。

## v83 - 2026-07-15

### 本版范围

- 信息流剪辑不再对无独立口播音频的视频强行执行人声识别：只从本次脚本及明确标注为口播、台词、对白、旁白或角色说话的内容生成字幕，再按真实片段时长估算分布；标题、界面标签、导演说明和任意引号文字不再被误当字幕。用户改动字幕文字或时间后立即标记为手动轨，媒体时长回填、进入审核和重新合成均不得覆盖。
- 修复本地与生产图文提示词表现分叉：删除按“文件 / PDF / 资料”等关键词替换成固定办公案例的硬编码兜底，并移除旧的“发布文案主题 / 内容重点 / 图片具体内容”模板。多图只按最终标题和正文分配内容，账号配置只补一句简短视觉风格；最终提示词会再次清洗内部规划语句。
- 批量图文图片微调弹窗同步展示本张实际使用的参考图，支持逐张替换、解除和新增参考图；重新生成时以本张覆盖后的参考图集合为准，空集合表示明确不使用参考图。
- 创作端管理员成员列表不再展示供应商子账号；数据分析表拆为“账号、发布标题”两列，账号名不再藏在标题下方灰字中。
- 黑色主按钮悬停继续保持白色文字，只做克制的背景和边框反馈，不再出现按钮局部变黑、文字消失。
- 收口数字人一键生成链路：工作台初始不再自动创建四个占位分段；点击一键生成后才使用账号固定声线生成口播，再按语义断句并尽可能合并为接近 30 秒、单段不超过 30 秒的较少分段。对还未生成视频的旧碎分段可安全重排，失败时恢复原音频。
- 修复创作者不可配置声线时无法生成数字人视频：一键入口自动读取管理员固定到账号的声线，先生成分段口播再派发视频任务。
- 修复剪辑台反复跳动、反复识别字幕与长时间“合成成片”：同一片段组合的音频时间识别只自动尝试一次，取消页面渲染时自动合成和合成结束后的整页重绘；仅在用户点击下一步时合成，超过 3 分钟会明确停止并允许重试。时间轴缩略视频改为按需加载，降低刚进入剪辑台时的阻塞。
- 修复切换账号双重渲染以及旧任务强制把页面拉回剪辑台：账号切换时清空旧生产单选中态，路由只触发一次渲染；页面过渡改为无位移的轻量淡入。
- 修复供应商备注聊天弹窗读取或发送消息后整页重绘导致的闪跳；供应商操作按钮保留紧凑尺寸并增加稳定间距。
- 创作端数据分析新增账号筛选；口播声线下拉打开时提升工作区层级，避免被下方发布文案面板盖住；通用按钮悬停反馈改为极简的底色和边框变化，不再用扩张黑色伪元素遮挡文字。
- 前端静态缓存标识统一提升为 `20260715-v83-2`，保留 `remote.js` 无 query 的单例导入策略。

### 验证结果

- 服务端全量单元测试 23/23 通过；新增数字人分段回归测试，将等价 11/11/16/14 秒的四段口播规划为 22/30 秒两段，且所有分段不超过 30 秒。
- 本地真实语言模型专项生成测试 60/60 通过：30 组标题生成文案与 30 组多图提示词均通过主题相关性、图片数量、无乱码、无内部规划泄漏、无固定办公案例和专业表达检查。
- 回归断言覆盖信息流使用时长估算而不是音轨识别、字幕文字编辑切换为手动轨、媒体 metadata 不覆盖手改字幕、图文提示词源码不再包含旧固定主题、微调参考图替换/删除、创作端隐藏供应商子账号以及数据分析账号/标题拆列。
- 回归测试断言剪辑页不再在渲染时自动合成，字幕音频识别具有片段签名去重，创作端数据分析已包含账号筛选。
- 全部 JavaScript 模块通过 `node --check`，`git diff --check` 通过；本地服务健康检查与首页响应均正常，入口及目标工作台资源已返回 `20260715-v83-2`。
- 按用户要求只做功能、状态和接口级关键验收，不执行视觉验收，不写入 `design-qa.md`。

### 数据与部署

- 本版只修改前端任务状态机、页面交互、样式、缓存标识和回归测试；不修改数据库结构，不清空或覆盖账号、成员、资产、发布清单、备注、分析数据、草稿、上传与成片目录或私密环境配置。
- 2026-07-15 已将应用提交 `9c9f594` 部署到生产环境，入口静态缓存标识确认是 `20260715-v83-2`，服务重启、健康检查与真实浏览器冷启动均通过。
- 部署从目标提交生成干净归档，并使用仅包含 28 个 v83 代码/静态文件的清单进行 dry-run 和精确同步；没有使用删除式同步，数据库、上传/成片目录、环境文件、认证缓存和运行日志均未进入同步清单，环境配置指纹部署前后相同。
- 服务器项目虚拟环境中全量单元测试 23/23、全部 JavaScript 语法检查和 Python 编译通过。真实浏览器登录后首页显示 80 个账号且控制台 0 错误；创作端设置页不显示供应商子账号，数据分析表第一、二列为“账号 / 发布标题”。
- 部署前后关键数据计数完全一致：账号 80、成员 12、资产 2488、生产单 452、任务 676、发布分析链接 23、指标快照 108、草稿会话 55、批次 61、音色 4、供应商绑定 52、供应商活动 28、上传文件 2296、成片文件 138。
- 回滚点：保留 `v83-pre-20260715-174905`，包含部署前代码/配置快照、一致性 SQLite 备份和运行态媒体校验点。若需回滚，只恢复代码和静态资源，不恢复或覆盖当前生产业务数据。
- 回滚方式：只回退 v83 代码和 `20260715-v83-2` 缓存标识，不回滚或覆盖任何业务数据。

### 注意

- 本版记录不包含任何明文密钥、网络地址、token 或账号凭据。

## v82.3 - 2026-07-15

### 本版范围

- 修复生产真实浏览器登录后未请求 `/api/state`：`main.js`、`store.js` 及所有直接使用共享客户端的模块统一以不带 query 的规范 URL 导入 `remote.js`，确保登录、远端拉取和业务接口共享同一 ESM 单例及同一 `_on` 状态。
- 修复供应商“改链接”仍提交原链接：已有链接打开弹窗时自动全选，直接粘贴即可替换；分享文本意外含多个 URL 时取最后一个新粘贴链接，不再优先命中预填旧链接。
- 前端静态缓存标识统一提升为 `20260715-v82-5`，确保线上浏览器重新加载本次模块图与发布清单交互。

### 验证结果

- 新增前端模块身份回归测试，断言整个 `js` 模块图内所有 `remote.js` 导入均使用同一无 query 规范 URL；新增改链接解析回归测试，断言多 URL 输入优先使用最后一个新链接。
- 服务端全量单元测试 16/16、关键 JavaScript 语法检查、Python 编译和 `git diff --check` 通过。
- 隔离数据下真实浏览器验收通过：供应商母账号和子账号登录后网络请求均出现 `GET /api/state`；母账号看到全部两条交付，子账号只看到已分配的一条，未分配交付完全不可见；两个会话控制台均为 0 错误、0 警告。
- “先回传旧链接、再修改新链接”真实交互通过：修改弹窗自动全选旧 URL；输入同时含旧、新两个 URL 时，专用接口两次 PUT 均返回成功，行内与跳转入口最终只显示新 URL。

### 数据与部署

- 本版只调整前端模块导入、链接输入解析、缓存标识及回归测试，不修改数据库结构或业务数据。
- 服务器更新只允许同步本提交代码和静态资源；必须保留数据库、上传与成片目录、账号、成员、资产、发布清单、备注、分析数据、环境文件和认证缓存。
- 2026-07-15 已将目标提交 `1a82804` 部署到生产环境，入口静态缓存标识确认是 `20260715-v82-5`，服务重启和健康检查均通过。
- 部署采用干净归档与明确排除规则，仅同步代码和静态资源；未使用删除式同步，服务器数据库、上传/成片目录、环境配置和认证缓存均未被覆盖。
- 部署前后关键数据计数一致：账号 80、成员 10、资产 2377、生产单 426、任务 670、发布分析链接 22、指标快照 108、草稿会话 52、上传文件 2188、成片文件 109。
- 隔离数据真实浏览器验收通过：供应商母账号和子账号登录均请求 `/api/state`；母账号可见两条交付，子账号仅可见已分配的一条；供应商列表无横向溢出，两个会话均无控制台错误或警告。
- 链接替换验收通过：修改弹窗自动全选旧 URL，提交同时含旧/新 URL 的文本后，以新 URL 作为唯一当前链接；供应商行、创作端快照和数据分析当前链接保持一致。管理员伪造回传、子账号修改未分配交付均被拒绝，供应商下载状态语义保持正确。
- 回滚点：保留 `v82.3-pre-20260715-133201`。如需回滚，只恢复代码和静态资源，不恢复或覆盖当前生产业务数据。
- 回滚方式：只回退 v82.3 代码与 `20260715-v82-5` 缓存标识，不回滚或覆盖任何业务数据。

### 注意

- 本版记录不包含任何明文密钥、网络地址、token 或账号凭据。

## v82.2 - 2026-07-15

### 本版范围

- 修复供应商子账号回传发布链接后创作端仍显示“暂无链接”：新增供应商专用原子接口，同时更新交付资产和当前数据分析链接；供应商母账号及已分配该账号的子账号都可回传，未分配交付在子账号页面中完全不可见。
- 供应商修改发布链接时直接覆盖同一条当前分析链接，不在数据分析列表残留旧链接；旧链接已有指标快照只做脱离当前链接的归档，避免旧数据错误挂到新链接，也不删除历史数据。
- 创作端发布清单与数据分析进入页面时主动获取最新服务端快照；管理员只显示“查看链接”并跳转，真实供应商回传成功后仅原位更新当前行，避免整表重绘造成闪烁。供应商展开“查看详细”后可用“跳转链接”直接打开自己回传的当前 URL。
- 供应商发布清单进一步压缩素材名、产品、发布人、平台、观看量和状态列，操作区保留稳定宽度；下载、跳转链接、备注和回传按钮紧凑横排，跳转链接紧邻下载，避免入口被裁切，同时不引入横向滚动条。
- 修复批量图文单图/多图切换造成账号行高度跳动：两种模式共用固定控件行高度，切换不再推动上下内容。
- 收紧单图创作最终生图提示词：完整保留用户填写内容，只额外附加一句从账号配置中提取的配色与画风参考；不再携带账号布局、人物、文案、排版、负面约束或内部生成说明。单号与批量单图共用同一规则。
- 前端静态缓存标识统一提升为 `20260715-v82-4`，确保本地验收读取本版发布链路、样式和提示词规则。

### 验证结果

- 服务端全量单元测试 14/14 通过；其中覆盖已分配供应商子账号只看得到自己的交付、子账号成功回传、创作管理员快照同步可见、母账号回传、修改链接覆盖当前分析条目、旧指标快照归档和陈旧前端状态不能覆盖新链接。
- 本地正式服务健康检查与接口注册检查通过；供应商发布链接专用接口已加载，不再使用重启前的旧服务进程。
- 真实语言模型专项验收 60/60 通过：30 组专业文案与 30 组多图提示词均满足主题相关、标签、图片数量、差异度、无乱码、无内部规划泄漏和无直播式口吻要求。
- 单图提示词专项断言通过：示例内容保持原样，结果只有第二行简短配色与画风参考，不包含布局、人物、排版、负面约束或内部指令。
- Python 编译、关键 JavaScript 语法检查和 `git diff --check` 通过；按用户要求不做视觉验收，由用户进行本地页面确认。

### 数据与部署

- 本版没有破坏性数据库迁移，不清空或覆盖账号、成员、资产、发布清单、草稿、沟通记录、分析数据、上传目录、成片目录或私密环境配置。
- 修改链接只覆盖该交付对应的当前 URL；旧指标快照保留为归档，不挂载到新 URL。
- 当前仅更新本地预览，不提交、不推送、不部署，也不通知服务器部署任务，等待用户本地验证。
- 回滚方式：回退 v82.2 代码和 `20260715-v82-4` 缓存标识；业务数据无需回滚或覆盖。

### 注意

- 本版记录不包含任何明文密钥、网络地址、token 或账号凭据。

## v82.1 - 2026-07-15

### 本版范围

- 修复批量图文账号行中“填写文案”和“每条图数”重叠：模式切换、标题、文案按钮、图数和参考图操作改为各自独立列；文案按钮采用固定紧凑宽度，标题列可弹性收缩，桌面端继续保持单行横排。
- 收紧图文自动文案语气：明确采用专业测评、教学或可信种草结构，要求给出判断依据、步骤、结果、适用边界或选择建议；全局拦截“兄弟们 / 家人们 / 宝子们”等直播式称呼及夸张带货话术。
- 生成文案标签统一整理到末行并限制为 4–7 个，保留标题中识别出的产品标签；避免模型偶发输出过多标签影响正文和后续图卡提示词。
- 前端静态缓存标识统一提升为 `20260715-v82-2`，确保本地验收加载本轮样式与生成规则。

### 验证结果

- 真实语言模型专项验收 60/60 通过：30 组单图标题自动生成文案、30 组多图按生成文案规划 2–8 张图卡提示词全部通过。
- 专项断言覆盖：文案与标题至少命中两个核心语义、正文为专业测评/教学/建议表达、产品标签存在且总标签数为 4–7、无直播式称呼、无夸张带货话术、无转义乱码；多图数量与选择值一致、提示词不重复、不泄漏标签或内部规划文本。
- `node --check`、专项脚本和 `git diff --check` 通过；按用户要求不做视觉验收，由用户在本地页面快速确认布局。

### 数据与部署

- 本版只调整前端样式、图文生成约束、专项测试和版本记录；不修改数据库、账号、成员、资产、发布清单、沟通记录、上传目录、成片目录或私密环境配置。
- 当前仅供本地验收，不推送、不部署、不通知服务器部署任务。
- 回滚方式：回退 v82.1 未提交改动及 `20260715-v82-2` 缓存标识；不回退、不覆盖任何业务数据。

### 注意

- 本版记录不包含任何明文密钥、网络地址、token 或账号凭据。

## v82 - 2026-07-15

### 本版范围

- 重建图文创作台的多图链路：标题必填；只有标题时先生成强相关、带标签的发布文案，再按标题与去标签正文规划图卡；标题和正文都已填写时直接规划图卡。封面保持简洁和冲击力，内页按正文顺序展开，并根据正文长短自动扩写或压缩信息密度。
- 新增独立单图创作模式：标题、单张图片提示词和可编辑发布文案分开保存；文案初始为空，用户已填写时不会被模型覆盖。生成时只创建一张图片槽位，并按标题补写文案与相关产品标签。
- 图片数量选择改为真实重建底部槽位，1–12 张立即一致；图文工作台的模式、张数、生成提示词和审核操作固定同一横排，审核位于最右侧。批量图文每个账号用紧凑“多 / 单”切换，模式位于必填标题前，张数、标题、文案和参考图操作保持同一行且互不覆盖。
- 清理图文模型输出：解码转义换行，过滤内部规划说明、正文分段元话术和标签；模型返回不规范 JSON 时只重试一次，不把乱码、`\\n` 或“本张只展开 / 正文第几部分”等生成要求展示为最终图片提示词。
- 供应商与创作端发布清单新增共享沟通时间线：双方都可发送消息，自己的消息位于右侧；创作端可筛选未读消息并显示红点。管理员模拟供应商视角不具备发送权限，供应商下载状态也只由真实供应商角色触发。
- 供应商管理员设置增加全部供应商账号维护，可修改管理员或子账号姓名、用户名和密码，并可删除、分配子账号；发布清单表格收紧操作列与下载按钮，不再依靠横向滚动条展示操作。
- 创作、批量、供应商与共享后端依赖缓存标识统一提升为 `20260715-v82-1`，继续保留产品事实库显式导入修复，版本高于生产热修复缓存链。

### 验证结果

- 真实语言模型关键验收 86/86 通过：20 组仅标题多图、20 组标题加正文多图、10 组短文案多图扩写、10 组长文案多图压缩、20 组单图文案与产品标签、6 组批量账号多/单模式及 2/4/7 张图数路由全部通过。
- 验收脚本同时断言：图卡数量准确、标题和正文强相关、标签不进入图片提示词、短文案能合理扩写、长文案能合理压缩、单图只保留一张槽位、输出无转义乱码或内部规划话术。
- 服务端单元测试、Python 编译检查、关键 JavaScript 语法检查和 `git diff --check` 均通过；本版按用户要求只做 API、功能、接口和生成链路关键验收，不执行视觉验收，也不新增 `design-qa.md`。

### 数据与部署

- 本版沿用现有集合保存沟通记录与已读时间，不进行破坏性数据库迁移；服务端写入继续按资产和成员权限做原子更新，不覆盖完整集合。
- 当前只完成本地代码、关键验收和提交；不推送、不部署、不通知服务器部署任务，等待用户本地验证。
- 后续如获确认，只允许同步代码和静态资源；必须保留服务器数据库、上传与成片目录、账号、成员、自媒体账号、资产库、发布清单、沟通记录、草稿、分析数据、环境文件、API 配置和认证缓存。
- 回滚方式：只回退 v82 提交与 `20260715-v82-1` 静态缓存标识，不回退、不覆盖任何线上业务数据。

### 注意

- 本版记录不包含任何明文密钥、网络地址、token 或账号凭据。

## v80 - 2026-07-14

### 本版范围

- 重建信息流创意生成主链路：先根据标题补齐发布文案和口播，再由语言模型独立创作 A 面剧情提示词与 B 面纯界面提示词，最后只依据 B 面拆出 1–2 张分镜图提示词；不再把本地固定剧情、固定台词或旧分镜模板当作生成结果。
- 信息流每轮加入随机创意引擎、创意种子、上一版相似度规避和 A/B 完整性校验；剧情必须包含目标、阻碍、升级与反转，视频提示词必须包含分时镜头、原创对话、运镜、声音、光线和转场。删除片段右上角独立预览眼睛，保留原生视频控制。
- 图文创作台支持只填写标题：点击一键生成时先生成带 4–7 个标签的发布正文，再用标题与去标签正文生成图片提示词；标签保留在最终发布文案，但不会作为图像内容依据。
- 修复供应商母账号批量创建子账号无反馈：服务端改用强类型批量入参并事务化校验，重复用户名或任一无效项不会产生部分落库；弹窗增加提交中、成功和失败的原位反馈及按钮加载态。
- 保留 v77.1 的产品事实库显式导入修复；前端创作链路缓存标识统一提升为 `20260714-v80-1`，高于线上热修复缓存链。

### 验证结果

- 本版全部修改 JavaScript 通过 `node --check`；服务端文件通过 Python 编译检查；`git diff --check` 通过。
- 服务端单元测试 9 项全部通过，其中新增供应商子账号强类型入参、批量事务与重复用户名测试；原有 MaaS 文生图/图生图分流、JPEG 响应解析、删除墓碑、主页权限和下载语义测试继续通过。
- 本地语言模型真实调用通过：连续两次相同标题与文案生成的 A/B 创意角度不同，提示词相似度约 `0.152`，两次均返回 2 张 B 面分镜提示词，固定问题台词命中为 0。
- 图文标题单独填写链路真实调用通过：先返回带标签的发布文案，再返回 2 条图片提示词；图片提示词不包含发布标签。
- 本地浏览器聚焦验收通过：信息流卡片无独立眼睛按钮；图文文案区明确显示标签保留/生成前剥离；供应商提交加载态、状态提示和禁用按钮均对齐，控制台错误为 0。

### 数据与部署

- 本版没有数据库 schema 迁移；供应商批量创建只增强既有成员写入的校验和事务边界，不触碰现有账号、成员、资产、发布清单、草稿、分析数据、上传与成片目录或私密环境配置。
- 当前只完成本地实现、测试、视觉验收和提交；不推送、不通知服务器部署任务，等待用户本地验证。
- 后续如获用户确认，只允许同步代码和静态资源；必须保留服务器数据库、上传与成片目录、账号、成员、自媒体账号、资产库、发布清单、草稿、分析数据、环境文件、API 配置和认证缓存。
- 回滚方式：回退 v80 提交及 `20260714-v80-1` 缓存标识即可；不回滚、不覆盖任何业务数据。

### 注意

- 本版记录不包含任何明文密钥、网络地址、token 或账号凭据。
- 视觉与交互验收记录见 `自动化产品/design-qa.md`。

## v79 - 2026-07-14

### 本版范围

- 修复信息流工作台 `primaryProducts is not defined`：补齐产品事实库导入，原“生成脚本”改为语义明确的“重新生成提示词”，继续生成前后 15 秒信息流提示与功能演示分镜。
- 修复剪辑工作台播放状态错乱：废弃定时器累加与媒体自身时钟并行的双时钟，改为单个动画帧时钟；重绘前会停止旧播放循环，暂停后视频、口播和 BGM 同步停住。
- 删除产品/界面参考图、参考音频和信息流分镜时改为局部更新，不再重绘整个工作台，避免每删一张图页面闪动。
- 数字人重新生成分段口播采用“先保存新音频，再删除旧音频”的替换顺序；生成失败或语音服务未配置时保留原音频，不再让已生成分段突然消失。
- 数字人工作台顺序收口为：角色形象与口播声线 → 发布标题、发布文案和口播草稿 → 数字人分段视频 → 封面；发布文案仍位于视频生成之前，封面固定在最下方。
- 口播声线区进一步压扁收紧：声线选择在上，声线标识与识别按钮在下，两个控件垂直对齐；收藏与生成/上传操作保持独立右栏，不使用大圆形按钮。
- 修复供应商和资产页长下拉菜单滚动即消失：菜单内部滚轮与触摸滚动不再冒泡触发全局关闭，并保留稳定滚动条槽位。
- 图文工作台移除没有分支意义的“站内生成”单选标签；创作链路缓存标识统一升级为 `20260714-v79-1`。

### 验证结果

- `node --check` 通过本版全部修改 JavaScript；`git diff --check` 通过。
- 服务端单元测试 7 项全部通过，继续覆盖图片接口分流与响应解析、删除墓碑、主页权限、供应商下载语义和账号快照。
- 本地浏览器回归信息流工作台：页面正常渲染“重新生成提示词”，不再出现未定义变量；剪辑台播放后可暂停，暂停时间保持不变。
- 长账号筛选包含 54 个选项；将菜单滚动到中后段后，滚动位置发生变化且菜单仍保持展开。
- 正式本地入口可正常加载，控制台错误为 0；口播声线、数字人顺序和用户标注已制作同画面对照，未发现待处理的 P0/P1/P2 视觉问题。

### 数据与部署

- 本版只修改前端代码、静态样式和版本记录；没有数据库 schema 迁移，不改账号、成员、资产、发布清单、草稿、分析数据或私密环境配置。
- 当前只完成本地验收和提交，不推送、不通知服务器部署任务；待用户本地确认后再交接。
- 后续部署只能同步本版代码和静态资源；必须保留服务器数据库、上传与成片目录、账号、成员、自媒体账号、资产库、发布清单、草稿、分析数据、环境文件和认证缓存。
- 回滚方式：回退 v79 提交与缓存标识即可；不需要回滚或覆盖任何业务数据。

### 注意

- 本版记录不包含任何明文密钥、网络地址、token 或账号凭据。
- 视觉与交互验收记录见 `自动化产品/design-qa.md`。

## v78 - 2026-07-14

### 本版范围

- 图文工作台删除独立的“生成张数”和“站内生成”区块，将标题、正文、图卡提示词生成收进同一张“图文创作台”卡片；标题空态明确标注“必填标题”。
- 统一参考图与“一键生成全部图片”合并为同一操作条，减少重复卡片和纵向留白，原有参考图拖拽、资产选择、上传与批量生成链路保持不变。
- 数字人工作台移除顶部口播/分段状态小标签和模式说明横幅；角色形象、数字人/Seedance 模式、声线选择、识别、收藏及固定账号仅管理员可见，创作者直接使用账号固定配置。
- 数字人口播音频移动到角色形象下方；标题、发布简介、口播草稿和封面改为纵向顺序，封面区加高；口播声线操作改为紧凑横向布局，收藏和操作按钮统一为小圆角矩形，并保留生成与上传能力。
- 创作链路缓存标识统一升级为 `20260714-v78-1`。

### 验证结果

- `node --check` 通过本轮创作链路脚本，`git diff --check` 通过；服务端单元测试全量通过。
- 本地管理员浏览器验收确认：角色形象后紧接口播音频，标题/正文/口播/封面按纵向顺序排列，页面宽度未超过视口，控制台错误为 0。
- 本地创作者权限验收确认：角色形象、声线下拉、声线识别、收藏和固定账号均不渲染；固定声线仍自动使用，生成与上传口播入口保留。
- 视觉对照已将用户数字人标注与本地实现放在同一对比图中，未发现待处理的 P0/P1/P2 问题。

### 数据与部署

- 本版只修改前端结构、权限渲染、样式和缓存标识；没有数据库 schema 迁移，也不需要覆盖账号、资产、发布清单、草稿、成员或环境配置。
- 当前仅完成本地版本，尚未推送或通知服务器部署任务；待用户本地确认后再按数据保护流程交接。
- 回滚方式：回退 v78 提交及缓存标识即可；不需要回滚或覆盖任何业务数据。

### 注意

- 视觉与权限验收记录见 `自动化产品/design-qa.md`。

## v77 - 2026-07-14

### 本版范围

- 语音结果卡改为两层操作结构：下载与删除收进右上角“已生成”状态下方；“加入语音素材库”和“加入参考音频库”固定同排、等高对齐，不再与临时文件操作混排。
- 语音合成、音色设计、音色管理的切换改为完整的淡出—淡入序列：旧面板先柔和退出，再让新面板淡入；过渡期间继续锁定工作区高度、滚动锚点和顶部按钮，避免跳动或连续点击串态。
- 补充减少动态效果降级；入口与语音模块缓存标识升级为 `20260714-v77-1`。

### 验证结果

- `node --check` 通过语音页与入口脚本，`git diff --check` 通过。
- 本地浏览器在已生成状态确认：下载、删除位于状态文字下方；两个入库按钮同一水平线、等高且没有超出右栏；页面宽度与视口一致。
- 三面板回归确认工作区高度持续约 `650px`；过渡中存在透明度渐变，完成后透明度恢复为 `1`、高度锁定解除，音色管理页同样没有横向溢出；浏览器控制台无错误。
- 视觉对照将用户标注与本地结果卡放在同一对比图中，未发现需要继续处理的 P0/P1/P2 问题。

### 数据与部署

- 本版只修改前端布局、动画和缓存标识，没有数据库 schema 迁移，也没有改写账号、资产、发布清单或运行数据。
- 2026-07-14 已将目标提交 `90295f1` 的累计 v73-v77 代码与静态资源部署到生产环境，入口缓存标识确认是 `20260714-v77-1`，健康接口与服务进程正常。
- 部署从远端目标提交建立干净工作区，并在同步前完成 Python/JavaScript 检查、运行态基线采集、代码快照和 SQLite 在线备份；同步明确排除了环境文件、数据库、JSON 状态、上传、成片、日志、认证缓存和虚拟环境。
- 数据保护核对：部署前后账号 80、成员 8、发布分析链接 21、指标快照 108、会话 51、音色 4，均未减少；上传与成片在代码同步阶段数量不变。部署验收期间生产成员仍在使用平台，最终资产、任务、生产单和上传文件较基线有实时新增，没有集合减少或被本地数据覆盖。
- 线上模型验收：语言模型与 MiniMax TTS 最小调用成功；图片模型无参考图走文生图、有参考图走图生图，两条真实最小调用均返回 JPEG；视频、数字人和数据接口配置均为已配置且可达，本次未改动服务器私密环境配置。
- 权限验收：管理员完成真实浏览器冷启动与页面烟测；供应商母账号在生产数据库只读副本上验证可见范围，供应商子账号因生产环境当前没有该角色成员，使用同一只读副本临时构造角色绑定验证，均未写回生产数据，私有素材泄漏计数为 0。
- 浏览器验收：登录与首页无白屏，语音页默认语速为 `1.2`，真实生成音频可预览；下载/删除动作存在，两个入库按钮同排等高，三个语音面板切换无控制台错误；数据分析产品筛选和批量创作页正常加载。
- 回滚点：服务器保留 `pre-v77-20260714-110406` 发布前代码与运行态校验点。需要回滚时只恢复代码和静态资源，不回退或覆盖生产业务数据。
- 回滚方式：回退 v77 提交及缓存标识即可；不需要回滚或覆盖任何业务数据。

### 注意

- 本版不包含任何明文密钥、服务器密码、网络地址、token 或账号凭据。
- 视觉与交互验收记录见 `自动化产品/design-qa.md`。

## v76 - 2026-07-14

### 本版范围

- 账号主页右上操作区固定显示“跳转主页”：账号已填写主页链接时可直接打开，未填写时保留灰色禁用态，管理员与创作者看到相同结果。
- 语音合成右栏新增固定的音频预览框，覆盖待生成、生成中、已生成和失败状态；播放器移动到参数区上方，移除生成结果里的复制声线标识按钮，并让下载、归档和丢弃操作自动换行，避免窄栏溢出。
- 语音合成、音色设计、音色管理三面板切换时锁定工作区高度和滚动位置，沿用局部淡入，避免整页高度瞬时收缩造成跳动。
- 批量图文任务在任务抽屉和审核卡片两处都提供悬停“微调”入口；可编辑单张提示词并调用原有批量单图重生成链路，手工单号任务不误显示依赖批次上下文的按钮。
- 数据分析新增产品筛选，产品值来自发布时填写的交付产品标签；状态筛选与刷新、平台、时间、产品控件统一在同一水平工具栏，窄屏时再有序换行。
- 入口与账号主页模块缓存标识升级为 `20260714-v76-1`，确保本地刷新加载本版界面代码。

### 验证结果

- `node --check` 通过本轮 5 个修改的 JavaScript 文件，`git diff --check` 通过。
- Python `unittest` 共 7 项通过，继续覆盖 MaaS 图片接口分流、图片响应解析、供应商主页权限、供应商下载语义和状态隔离。
- 本地浏览器确认账号主页无链接时“跳转主页”为禁用按钮，保存链接后变为可用链接；数据分析出现“产品筛选”控件。
- 本地浏览器确认语音右栏显示固定“等待生成音频”框，页面宽度与视口一致；右栏、预览框均未越界。三种语音面板切换前后工作区高度保持一致、滚动位置保持不变，并保留局部进入动画。
- 批量图文两处入口均复用同一个单图重生成函数；抽屉只对带批次上下文且已有图片的图文任务显示“微调”，避免普通单号任务点击后缺少批次而失败。

### 数据与部署

- 本版没有数据库 schema 迁移；产品筛选只读取既有交付产品标签，主页链接继续使用既有共享字段，语音预览状态仅保存在当前页面运行态。
- 当前只完成本地修改与验收；没有部署服务器，也没有向服务器部署任务发送消息，等待用户本地体验确认。
- 后续如获用户批准，只允许同步代码和静态资源；不得覆盖服务器数据库、上传与成片目录、账号、成员、自媒体账号、资产库、发布清单、草稿、分析数据、环境文件或认证缓存。
- 回滚方式：回退 v76 提交即可；不需要回滚或覆盖任何业务数据。

### 注意

- 本版不包含任何明文密钥、服务器密码、网络地址、token 或账号凭据。
- 视觉与交互验收记录见 `自动化产品/design-qa.md`；服务器部署日志仍只在真实部署后补记。

## v75 - 2026-07-13

### 本版范围

- 发布流程移除产品选择入口，产品标签改为发布弹窗必填字段，与计划发布日期、备注一起写入交付快照和发布清单；标题输入同步标明必填。
- 账号声线、视频类型和角色形象调整为管理员专属配置；管理员固定后，创作者直接继承账号声线与角色配置，不能创建、编辑账号或改动角色版。
- 账号主页链接在创作端与供应商端共享同一字段：管理员与供应商母账号可编辑，创作者可查看并跳转，供应商子账号无编辑权限；供应商账号卡的主页操作与账号分配改为上下布局。
- 创作者发布清单新增“供应商已下载 / 供应商未下载”语义；创作者下载不写供应商状态，只有供应商母账号或子账号下载才写入。管理员切到供应商视角下载同样不会标记。
- 整体资产默认拖入公共素材池，支持把素材明确分配到单个账号或移回公共池；单号和批量生产只展示公共素材与当前账号素材，账号头像不进入素材网格。账号筛选后的导出操作移入筛选行，避免挤出发布清单入口。
- 批量图文审核看板支持点击单张成图打开提示词编辑器，并在保持资产标识不变的前提下重新生成该图；自动推进开关移除，批量任务默认自动推进。
- 语音生成结果的归档动作移动到生成完成后，分别支持加入语音素材库、参考音频库或不归档；语音页、筛选与供应商 Dock 的轻量交互继续保持原位更新。
- 登录背景替换为原生 WebGL Galaxy 星场，保留鼠标追踪、性能降级、页面隐藏暂停和 `prefers-reduced-motion` 静态帧；不引入新的运行时框架。
- 图片生成 MaaS 分流按参考图存在性选择接口：无参考图走文生图，有参考图走图生图；请求体统一要求 JPEG base64 响应且关闭标识叠加，保留参考图数组与输入保真参数。
- 数据看板总播放量、平台筛选，供应商发布清单账号筛选、创作日期与计划发布日期，以及数字人并发、分段、字幕、封面和信息流 / 文案分镜链路完成本轮回归收口。

### 验证结果

- `node --check` 通过本轮全部修改 JavaScript；Python 单元测试共 7 项通过；`git diff --check` 通过。
- MaaS 最小测试覆盖无参考图 / 有参考图选择不同 endpoint、请求体字段与 JPEG base64 图片解析。
- 服务端权限测试覆盖创作者下载不改变供应商状态、管理员下载不改变供应商状态、供应商母账号和子账号下载才会写入，以及供应商角色可见性与头像同步。
- Playwright 完成管理员、创作者、供应商母账号、供应商子账号烟测：创作者无创建 / 编辑账号入口；供应商母账号可编辑主页链接；子账号无主页编辑和账号分配权限；供应商发布清单恢复显示“未下载”。
- 视觉验收覆盖 Galaxy 登录、账号编辑常态与悬停、供应商账号卡、整体资产筛选与发布清单入口。账号弹窗悬停引发黑块的问题已复现并修复，最终对照结论为通过。
- 本轮浏览器测试产生的临时账号和供应商下载状态已清理或恢复，没有把 QA 状态留在本地业务数据中。

### 数据与部署

- 本版没有数据库 schema 迁移；新增字段均为文档兼容字段，旧数据缺失时继续按默认值读取。
- 当前只完成本地修改、测试、浏览器验收和版本提交；没有部署服务器，也没有向“服务器部署”任务发送消息，等待用户本地体验确认。
- 后续如获用户批准，只允许同步代码和静态资源；必须保留服务器数据库、上传与成片目录、账号、成员、自媒体账号、资产库、发布清单、草稿、分析数据、环境文件和认证缓存。
- 回滚方式：回退 v75 提交与入口缓存号即可；不需要回滚或覆盖业务数据库。

### 注意

- 本版不包含任何明文密钥、服务器密码、网络地址、token 或账号凭据。
- 视觉对照与截图索引见 `自动化产品/design-qa.md`；`Server Deployment Log.md` 仅在真实部署后补记。

## v74 - 2026-07-13

### 本版范围

- 语音生成页彻底移除轻量交互触发的整页重绘：我的音色、收藏音色、系统音色、性别与语言筛选、试听、收藏、改名、删除、声线选择、账号锁定和音色设计状态均原位更新，保留列表节点、滚动位置与页面高度。
- 音色设计改为“先生成候选试听，再明确保存到我的音色”；未确认的候选不会写入 `voicePresets`。我的音色新增删除，删除后同步解除账号上的失效声线绑定。
- 新增语音素材库与总参考音频库；试听结果可缓存复用，用户可把自己的音频拖入总参考音频库，非数字人账号可从库中选择一条统一参考音频并应用到每段 Seedance 视频。
- Seedance 参考音频链路已按真实上游约束补齐：音频不能作为唯一参考输入，提交时同时携带视觉参考；服务端会保留并转发参考音频，不再静默丢弃。
- 数字人口播分段改为生成前的全局规划，优先用尽量少的、接近 27 秒且不超过 30 秒的分段，避免额外生成 3 秒左右的孤立尾段。
- 数字人重新生成分段口播会在新音频成功后替换旧音频并作废旧视频；固定视频提示词统一加入自然动作、表情、表达和视线约束，移除重复的放大预览按钮。
- 数字人调度上限提升为 10，并把同一轮候选任务改为并行提交；一键生成不再仅把上限写成 10 后仍逐条 `await` 排队。
- 数字人字幕严格裁在各自视频片段边界内，片段拼接使用约 `0.35s` 的自然叠化，并同步修正字幕时间偏移。
- 创作端发布清单新增产品标签筛选；筛选时折叠左侧时间轴，恢复“全部标签”后时间轴重新显示。
- 供应商端同步创作端账号头像；发布清单筛选改为原位隐藏/显示表格行，底部 Dock 不重新挂载，并同时显示“创作日期”和“计划发布日期”。
- 入口和创作链路循环模块缓存号统一升级为 `20260713-v74-1`。

### 验证结果

- `node --check` 通过本轮全部修改 JavaScript；`python3 -m py_compile` 通过服务端与新增测试；`git diff --check` 通过。
- `python3 自动化产品/server/tests/test_store_tombstone.py` 与 `python3 自动化产品/server/tests/test_supplier_state.py` 均通过；后者覆盖供应商头像私有资产可见性和旧交付创作日期补全。
- 数字人分段规划用例通过：`18/22/19/3 -> 18/22/22`、`15/12/14/13 -> 27/27`、`25/5/25 -> 25/30`。
- 合成测试用两段 3 秒视频得到约 5.67 秒成片，抽帧确认片段交界处存在自然叠化，而不是硬切或黑帧。
- 真实 Seedance 上游验证：仅音频参考被上游明确拒绝为“不能作为唯一参考输入”；视觉参考与音频参考组合提交成功并完成轮询，证明参考音频进入了真实请求链路而非前端占位。约束参考火山引擎官方 Seedance 2.0 文档：`https://developer.volcengine.com/articles/7606009619928449070`。
- Playwright 验证语音收藏和分类切换后 `.voice-lab-page` 保持同一 DOM 节点，收藏按钮即时变深且收藏列表立即出现。
- Playwright 使用供应商母账号验证发布清单筛选：筛选前后同一表格行 DOM 标记保持不变，底部 Dock 的位置与尺寸不变；“创作 2026-07-12 / 计划发布 2026-07-15”同时可见。

### 数据与部署

- 本版新增的 `sourceCreatedAt` 为交付文档兼容字段；旧交付不做数据库迁移，供应商快照会从原 production 的 `createdAt` 安全补全，无法找到时回退交付记录自身时间。
- 本版没有修改或覆盖运行数据库、上传与成片目录、账号、成员、环境文件、认证缓存或 API Key；本地测试使用隔离的 SQLite 副本和临时 QA 账号。
- 当前只完成本地修改与验收，尚未通知部署任务、尚未部署服务器。部署仍只能同步代码和静态资源，不得使用本地 state 或空数据库覆盖服务器数据。
- 回滚方式：回退 v74 代码与入口缓存号；新增兼容字段可留在文档数据中，旧代码会忽略，不需要数据库回滚。

### 注意

- 本版不包含任何明文密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。
- `Server Deployment Log.md` 只记录服务器部署事实，与本文件的产品迭代版本继续分开维护。

## v73 - 2026-07-12

### 本版范围

- 单号视频链路继续收敛为“文案分镜 -> 剪辑 -> 审核”：真人号默认走数字人模式，自定义标题优先于历史自动选题文案，信息流 B 面只生成 1-2 张低文字密度的纯界面分镜，并继承首段视觉风格约束。
- 剪辑台新增基于实际视频音轨的字幕识别：服务端优先调用本机 `whisper.cpp`，按真实口播时间返回字幕片段，再用当前脚本文字做错字纠正；未安装 Whisper 时保留原 FFmpeg 音频活动检测降级。
- 字幕默认样式改为 `11px / 1px 描边 / 距底 22%`，最终 FFmpeg 烧录与剪辑台预览使用同一参数；字幕时间块支持左右两端拖动，不再只能调整结束时间。
- 剪辑台保留 `T` 作为增加文字，右侧新增独立“识别字幕”；字幕编辑行新增删除按钮，选中字幕后也可用 `Backspace / Delete` 删除，并支持撤回恢复。
- 剪辑台右侧把“下一步：审核”提升到顶部，声音轨、BGM 选择、满宽拖入区和字幕识别放在下方，避免操作区右侧残留空隙。
- 审核前增加封面强制守卫：单号与批量视频没有封面时先自动生成封面，成功后才能进入审核；生成失败会停在明确错误态并提供重试和返回入口。
- 审核页成片预览移除无内容的场景色块占位，只保留真实 9:16 成片；账号资产、删除动效、语音列表紧凑排版和本轮其他 v73 交互修复一并纳入当前前后端代码。
- 创作链路的 ES 模块循环依赖统一升级为 `20260712-v73-4`，确保入口、工坊、剪辑和审核页加载同一版代码。
- 新增 `tools/install_whisper_cpp.sh`，把 `whisper.cpp` 二进制与模型安装到用户缓存目录，不把模型、虚拟环境或运行文件写入 Git。

### 验证结果

- `node --check` 通过 `自动化产品/js` 下全部非 vendor JavaScript；`python3 -m py_compile 自动化产品/server/main.py`、`bash -n 自动化产品/tools/install_whisper_cpp.sh` 和 `git diff --check` 通过。
- `python3 -m unittest 自动化产品/server/tests/test_store_tombstone.py` 通过。
- Playwright 在 `#/studio/cut` 验证最新模块：审核入口位于声音轨上方，BGM 拖入区满宽，“识别字幕”独立可见，字幕编辑行显示删除按钮和左右时间把手，默认样式为 `11 / 1 / 22`。
- 删除按钮烟测：7 条字幕删除 1 条后变为 6 条，点击撤回恢复为 7 条；选中字幕后按 `Backspace` 同样删除成功，再次撤回后完整恢复。
- 旧 30 秒成片重新识别得到 7 条真实时间字幕，包含“下班前要交三个版本”等脚本纠错后的文本；不再按两个 15 秒场景均匀铺满字幕。
- 重新合成产出 30.162 秒 MP4；在 0.8 秒和 16.8 秒抽帧确认字幕为小号细描边、位于画面下三分之一，并分别对应当时真实口播。
- Playwright 在 `#/studio/review` 验证成片预览、脚本、视觉素材和成片构成可见，原橙色 / 绿色空场景预览块已移除，审核步骤可返回剪辑。
- 视觉截图：`自动化产品/output/playwright/v73-cut-editor.png`、`v73-subtitle-0_8s.png`、`v73-subtitle-16_8s.png`、`v73-review.png`。

### 数据与部署

- 本版包含前端、服务端字幕接口和可选本机 Whisper 运行依赖；没有数据库 schema 变更，不需要迁移或覆盖业务数据。
- v73 功能提交 `a7bc47c` 已推送到 `codex/v1-star-array-batch-image`；尚未通知部署线程、尚未部署服务器，等待用户本地体验确认后再交给“服务器部署”任务。
- 后续部署只允许更新代码和静态资源，并在服务器代码目录运行 Whisper 安装脚本或提供等价的服务器私有依赖；严禁覆盖数据库、上传与成片目录、账号、成员、资产、发布清单、草稿、分析数据、环境文件、认证缓存或 API Key。
- 回滚方式：回退 v73 代码与入口缓存号，恢复 v72 静态资源；Whisper 用户缓存可保留，不影响旧代码，也不需要回滚数据库。

### 注意

- 本版不包含任何明文密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。
- `Server Deployment Log.md` 只记录服务器发布事实，与本文件的产品迭代记录继续分开维护。

## v72 - 2026-07-12

### 本版范围

- 批量任务板的账号编辑行进一步收紧：账号名称下明确显示账号类型与平台，“从资产选择”和“取消选择”作为每个账号自己的操作固定在行最右侧。
- 视频账号正文框不再为不存在的“每条图数”控件预留空列，标题与正文延伸到右侧账号操作组前；底部只保留全局取消和确认执行。
- 首页五个任务指标改为可点击任务入口：分别展示等待上传、生成中、待审核、失败待重试和供应商待下载的真实明细。
- 首页任务弹窗显示任务标题、所属账号、账号类型、状态和更新时间；生产任务可直接进入对应单号工作台，供应商待下载可直接进入发布清单。
- 批量任务板、首页任务弹窗继续沿用黑白线条和半透明磨砂弹层，不修改业务接口、权限、数据库或生产任务数据。
- 项目问题记录统一并入根目录 `Problem Document.md`，删除重复的 `自动化产品/问题记录.md`；交接指南明确 `version.md` 与 `Problem Document.md` 的强制维护责任。
- 原 `自动化产品/design-qa.md` 的视觉验收结论与截图索引并入本文件，删除重复的独立 QA 文档；后续视觉验收直接写入对应版本的“验证结果 / 视觉验收归档”。
- 旧 `本地预览入口.md` 与 `启动与架构说明-v5.md` 合并为 `自动化产品/运行与架构说明.md`，统一当前 `8787` 启动入口、模块架构、数据边界和最低验证要求。
- 入口缓存号升级为 `20260712-v72`。

### 验证结果

- `node --check` 通过本版及本轮全部 JavaScript 文件；`git diff --check` 通过。
- Playwright 在多账号素材视频计划中确认：每个账号各有一个资产按钮和取消选择按钮，按钮高 `28px`、右边距 `8px`；底部资产按钮数量为 `0`。
- Playwright 确认视频账号文案区跨过空图数列，账号标记、正文和右侧操作组无重叠。
- Playwright 验证首页指标弹窗与任务直达入口；空指标显示明确空状态，不再跳到混乱的通用页面。
- 本地服务健康接口返回正常，入口静态资源版本为 `20260712-v72`。

### 数据与部署

- 本版只提交代码、静态资源和项目记录，不提交或覆盖 `.env`、API Key、认证缓存、运行态数据库、上传目录、账号、成员、资产、发布清单、草稿或分析数据。
- 部署必须由“平台部署”任务执行，只允许拉取最新版功能代码与静态资源；部署前后保留服务器现有环境文件、生产 Key 和全部业务数据。
- 回滚方式：回退 v72 提交并恢复上一版入口静态资源；不需要数据库回滚。

### 服务器部署记录

- 2026-07-12：已部署提交 `1eb8f3f` 的代码与静态资源，线上入口缓存标识确认是 `20260712-v72`，健康接口正常。
- 数据保护：部署前已建立运行态备份；同步时排除了数据库、上传/成片目录、环境配置、认证缓存和日志。部署后生产账号仍为 80 个，现有资产、生产单、交付、草稿和分析数据保持可用。
- 权限烟测：管理员可登录并进入完整工作台；供应商母账号可进入供应商 Dock、子账号管理和交付视图；供应商子账号只能看到自身可见范围，访问母账号管理接口会被拒绝。验证使用的临时父子账号已在验收结束后删除。
- 功能烟测：首页任务指标可打开明细并直达单号工作台；批量创作显示逐账号参考图入口；语音页显示 MiniMax 音色库、试听/收藏操作和默认语速 `1.2`。服务器既有 TTS 配置保持已配置且可达。
- 回滚点：服务器保留本版发布前的运行态备份和上一稳定代码发布目录；回滚仅恢复代码与静态资源，不回退生产业务数据。

### 注意

- 本版不包含任何明文密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

### 视觉验收归档

- v72：Playwright 验证首页等待上传指标展示 4 条真实任务，每条均有“进入工作台”；点击后直达 `#/studio/images`。任务弹窗为 `.82` 透明磨砂背景与 `28px` 模糊。
- v72：批量视频账号在窄工作区使用“账号与操作 / 满宽文案 / 参考图”三行响应式布局，正文占满可用宽度；每个账号各自保留资产选择和取消选择。
- v71：验收视口为 `1200x760`、`390x844`，覆盖登录、首页、数据分析、批量创作、供应商账号、发布清单和快速路由切换；无未解决 P0/P1/P2 视觉问题。
- v71：供应商 Dock 桌面与移动端持续可见，数据分析筛选无横向溢出；账号行高 `62px`、分配选择器高 `28px`；资产选择器宽 `760px`、缩略图 `82x82px`。
- v71 截图索引：`.playwright-cli/v71-login.png`、`.playwright-cli/v71-overview.png`、`.playwright-cli/v71-analytics.png`、`.playwright-cli/v71-agent.png`、`.playwright-cli/v71-supplier-mobile.png`、`.playwright-cli/element-2026-07-11T17-00-23-729Z.png`。
- v70：验收视口为 `1440x900`、`390x844`，覆盖登录/申请切换、药丸标签、弹性滑块、供应商 Dock 和减少动态效果；移动端无横向溢出，Dock 宽约 `277px`。
- v70 截图索引：`.playwright-cli/page-2026-07-11T14-27-17-357Z.png`、`.playwright-cli/page-2026-07-11T14-28-36-135Z.png`、`.playwright-cli/page-2026-07-11T14-29-37-362Z.png`、`.playwright-cli/page-2026-07-11T14-36-17-516Z.png`。
- v69：供应商角色导航、账号分配、发布清单权限、语音列表裁切、批量建号弹窗和分析表格均通过浏览器检查；账号分配保存前后保持同一网格 DOM，不闪动、不跳滚动位置。
- v69 截图索引：`output/playwright/voice-lab-v69-fixed.png`、`output/playwright/supplier-overview-v69-fixed.png`、`output/playwright/supplier-settings-v69-fixed.png`、`output/playwright/supplier-assignment-no-jump.png`。

## v71 - 2026-07-11

### 本版范围

- 修复供应商底部 Dock 在路由与标签切换中的短暂消失：Dock 固定保持挂载、可见和最高导航层级，切页时同步复位邻近放大状态。
- 修复供应商异步页面的旧请求覆盖新页面：离开首页、全部账号或设置后，晚返回的旧结果会自动作废；供应商全部账号页顶栏标题同步修正为“全部账号”。
- 数据分析新增平台和时间下拉筛选，可按全部平台、小红书、视频号及近 7/30/90 天组合过滤；状态标签筛选继续保留。
- 全站重复页头文字收敛为顶栏单一标题，页面内部仅保留必要操作；交付视角标签等辅助小字移除，主标签文字保持可见。
- 主侧栏统一为纯黑底，星阵标识改为纯白；浏览器角标替换为纯黑底白色星标版本。
- 首页待办色点缩小并收紧行距；常规业务页减少阴影和大圆角，主要区域改用分隔线与开放背景。
- 批量创作保留现有三栏、任务与表单行为，仅把嵌套卡片收敛为线条结构，并移除非必要说明文案。
- 发布清单的创作端/供应商视角与批量下载合并到同一工具栏并垂直对齐；数据分析刷新按钮下移到筛选面板，不再孤立悬在页面顶部。
- 全局筛选下拉统一为 `34px` 小药丸外壳；首页指标数字改为黑色，待办彩色圆点与供应商操作绿点移除，普通页面链接统一为黑白文字。
- 供应商账号看板收紧为 `62px` 行高，默认头像统一为黑白人物线稿，分配选择器固定为 `28px` 小药丸并与账号信息对齐；账号主页与账号弹窗沿用同一默认头像。
- 供应商平台筛选取消整页 View Transition，只保留账号网格自身的轻量淡入，彻底隔离底部 Dock。
- 语音页的拖条、音色切换、试听和收藏改为原位更新，不再重绘整页；收藏态即时变为深色，语速默认值统一为 `1.2`。
- 批量图文、素材视频与真人视频统一为自定义文案路径，移除自动/标准模式选择；产品库只作为参考信息，不参与生成模式分支。
- 批量任务板的统一参考区和账号行本身可接收拖图，移除重复上传框；账号行补充分组/平台标记、取消选择入口，并将资产选择按钮按账号数量就近收纳。
- 供应商首页最近操作新增时间与操作类型筛选；发布清单表格、操作按钮和批量下载工具栏继续收紧，视角切换使用局部平滑过渡。
- 草稿箱、任务节点、生成状态、机器人和数据接口图标统一为黑白线性体系；进行中状态保留克制的脉冲动效。
- 所有共用弹窗和抽屉统一为半透明磨砂玻璃表面；资产选择器缩至 `760px`，缩略图改为约 `82px` 方形密集网格。
- 入口缓存号升级为 `20260711-v71r4`。本版只修改本地前端 HTML、CSS、JavaScript、静态品牌资源和记录文档，没有修改数据库、权限规则或服务器数据。

### 验证结果

- `node --check` 通过 `js/main.js`、`js/ui/uiEnhancements.js`、`js/views/analyticsView.js`、`js/views/supplierViews.js`。
- `git diff --check` 通过。
- Playwright 桌面回归通过登录、首页、数据分析、批量创作和供应商全部账号；移动端 `390x844` 通过供应商 Dock 与数据分析筛选布局。
- 供应商快速执行 `设置 -> 全部账号` 异步竞态测试后，当前内容仍为账号看板；Dock 在首页、全部账号、发布清单、设置连续切换中始终为 `display:flex`、`opacity:1` 且尺寸可见。
- 数据分析状态标签主文字、平台筛选和时间筛选均可访问；重复页头在内容区不再占位。
- 发布清单两个视角标签均为约 `34px` 高，供应商标签与 `36px` 批量下载按钮中心线误差小于 `1px`。
- 供应商平台筛选期间连续采样 24 次，Dock 每次均为 `display:flex`、`opacity:1` 且尺寸非零；账号卡高度 `62px`、分配选择器高度 `28px`。
- 语音页切换音色后页面与列表 DOM 节点保持不变、列表滚动位置保持 `80px`；收藏态计算样式为黑底白字。
- 资产选择弹窗计算宽度为 `760px`、背景为 `rgba(248, 249, 251, 0.82)`、背景模糊为 `28px`；首张缩略图为 `82×82px`。
- 本地忽略环境完成 MiniMax 配置复核，`/api/tts/config` 可达且 `/api/tts/test` 返回 HTTP 200；密钥没有写入版本文件或 Git 跟踪内容。
- 视觉对照与截图记录见 `自动化产品/design-qa.md`，最终结果为 `passed`。

### 数据与部署

- 当前仅完成本地修改与本地验收，等待用户体验确认；没有提交、推送、部署服务器，也没有向“服务器部署”任务发送消息。
- 后续获用户批准后只同步代码与静态资源，继续保护服务器数据库、上传目录、账号、成员、自媒体账号、资产库、发布清单、草稿、分析数据、环境文件和认证缓存。
- 回滚方式：回退 `index.html`、`js/main.js`、`js/ui/uiEnhancements.js`、`js/views/analyticsView.js`、`js/views/supplierViews.js`、`styles/ui-motion.css` 和本版静态角标；不需要数据库回滚。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v70 - 2026-07-11

### 本版范围

- 登录页升级为黑白极简动态光束背景：使用原生 WebGL 绘制 Beams 式光束，不引入 React、Three.js 或动画框架；WebGL 不可用时回退现有静态封面。
- 登录表单取消玻璃卡片边框，仅保留品牌、用户名、密码和主操作；申请账号固定在右上角，进入申请态后变为深色“申请中”，中间标题与主按钮同步切换为“申请”。
- 全局主要按钮、分段标签、音色标签、资产标签和供应商筛选收敛为扁平黑白药丸风格，加入克制的圆形填充悬停动效，移除原有彩色渐变和流光。
- 原生 range 控件统一升级为弹性滑块，根据语速、音量、声调、字号、位置和图数自动匹配图标；拖拽越界仅提供小幅阻力和回弹，不改变原有数值逻辑。
- 供应商管理员与供应商子账号不再使用左侧栏，改为页面底部 Dock 导航；保留现有可见路由和权限，仅增加邻近放大与页面入场过渡。
- 所有新增动效支持 `prefers-reduced-motion`，移动端登录和供应商 Dock 均提供无横向溢出的响应式布局。
- 入口静态资源缓存号升级为 `20260711-v70`，避免部署后浏览器继续使用 v69 入口脚本。
- 本版仅修改前端 HTML、CSS 和 JavaScript 展示层，没有修改后端、接口、数据库或角色权限逻辑。

### 验证结果

- `node --check` 通过 `js/main.js`、`js/ui/loginBeams.js`、`js/ui/uiEnhancements.js`。
- `git diff --check` 通过。
- Playwright 在 `1440x900` 验证桌面登录、申请切换、语音页药丸标签、弹性滑块和供应商 Dock；在 `390x844` 验证登录与申请态无横向溢出。
- 语速滑块点击后数值与轨道比例同步更新；供应商 Dock 邻近放大峰值约 `1.13`，移动端 Dock 宽 `277px` 且完整位于视口内。
- 减少动态效果模式下登录与页面入场动画关闭，WebGL 背景停留在静态帧。
- 本机既有 `8787` 服务返回最新 `20260711-v70` 入口与正常健康状态；真实共享服务登录页控制台 `0 errors / 0 warnings`，本轮没有重启或修改该服务。
- 视觉对照与问题修复记录见 `自动化产品/design-qa.md`，最终结果为 `passed`。

### 数据与部署

- 当前仅完成本地修改与本地验收，等待用户体验确认；没有部署服务器，也没有向“服务器部署”任务发送部署消息。
- 后续获用户批准后，仅同步本版前端代码与静态资源；继续保护服务器数据库、上传目录、账号、成员、自媒体账号、资产库、发布清单、草稿、分析数据、环境文件和认证缓存。
- 回滚方式：回退 `index.html`、`js/main.js`，移除 `js/ui/loginBeams.js`、`js/ui/uiEnhancements.js`、`styles/ui-motion.css` 及本版记录，不需要数据库回滚。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v69 - 2026-07-10

### 本版范围

- 供应商账号分为供应商管理员和供应商子账号：管理员只管理子账号、自媒体账号分配和供应商端操作记录；子账号只能处理已分配账号的发布清单。
- 供应商管理员只显示供应商首页、全部账号、发布清单和供应商设置；不显示批量创作、单号创作、草稿、数据分析、产品库、接口配置或平台成员管理。
- 供应商管理员账号由平台管理员审批；未归属的供应商子账号申请可由任一供应商管理员审批，审批后自动归属该管理员。
- 发布清单对创作成员按发布人隔离；平台管理员可读全量但不能修改观看量。观看量只允许供应商管理员和已分配对应自媒体账号的子账号更新，前后端同时校验。
- 供应商快照只下发必要的账号摘要和已交付素材，不下发创作生产单、产品库、分析、创作记忆或其他创作端数据。
- 剪辑页步骤条进入顶部栏，预览区放大，时间轴与右侧声音控件收紧；横向滚动条隐藏，BGM 下拉只显示真实配乐资产，不再把口播识别为 BGM。
- 数据分析移除无法稳定计算的互动率展示；入口静态资源缓存号升级为 `20260710-v69`。
- 供应商自媒体账号分配改为原位保存，不再重新渲染整张账号看板；搜索和平台筛选保留轻量过渡，账号头像继续复用创作端头像资产。
- 批量建立子账号改为固定尺寸弹窗，新增行只在内部滚动区域增长，新增和删除行带短过渡；供应商申请与子账号管理拆分为独立区块。
- 语音生成音色库修复选项卡和音色条目裁切：三类音色按钮完整可见，音色名称、ID、类型与操作键不再互相覆盖。
- 供应商首页“最近操作”恢复稳定内边距，标题和日志不再贴住容器边缘。

### 验证结果

- `node --check` 通过本版修改的前端模块；`python3 -m py_compile` 通过 `server/main.py` 与 `server/store.py`。
- 服务端权限回归通过：供应商管理员可审批子账号并自动归属，无权访问平台成员管理；子账号仅可更新已分配账号的观看量，平台管理员和创作成员写入观看量被服务端拒绝。
- Playwright 真实浏览器回归通过供应商管理员首页、全部账号、发布清单、子账号设置和剪辑页；冷启动 console 无错误。
- Playwright 追加回归通过：语音页三类音色按钮均为 `34px` 稳定高度且无裁切；音色条目无内容溢出；批量建号增加到 8 行后弹窗仍保持固定尺寸并可内部滚动。
- 供应商账号分配使用拦截保存请求做无数据污染验证：保存前后账号看板保持同一 DOM 节点，当前下拉框恢复可操作，不触发整板刷新。
- 管理员与供应商管理员共 11 个关键路由浏览器烟测无 console error、无前端加载错误、无横向溢出。
- 核心配置与供应商只读接口烟测均返回 HTTP 200 且结构正确；服务端单元测试通过。

### 数据与部署

- 本版包含幂等数据库迁移，旧 `supplier` 角色自动迁移为 `supplier_parent`；不覆盖现有成员、自媒体账号、草稿、资产或发布清单。
- 部署仅同步代码和静态资源；必须保护服务器数据库、上传目录、账号、资产库、发布清单、草稿、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v68 - 2026-07-10

### 本版范围

- 剪辑页字幕改为按已生成片段的真实媒体时长重新对齐；数字人口播生成时同步读取实际音频时长。既有自动字幕会顺排到单一轨道，拖动、拉伸和手工改时均会限制在相邻字幕之间，不再重叠。
- 最终合成请求会把时间轴字幕提交给服务端，服务端用 ffmpeg 将字幕烧录进交付成片；字幕或时间轴变化后会自动重新合成，避免下载旧版本。
- 删除剪辑页“查看/下载合成成片”的跳转入口，改为画布内的放大预览按钮，仍可通过审核与发布清单下载交付文件。
- 剪辑页收紧为更紧凑的桌面单页：步骤条上移、预览高度缩小、右侧声音与交付区不再展示冗长说明，时间轴改为更紧凑的直角轨道。
- 修复批量自定义图文卡的“每条图数”错位：图数输入固定在标题、正文同一控制行的右侧，不再落入定制参考图区域。
- 入口 HTML 静态资源缓存号升级到 `20260710-v68`。

### 验证结果

- `node --check` 通过：`chainCut.js`、`chainWorkshop.js`。
- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- 字幕顺排回归通过：连续口播拆分后不会产生时间交叠。
- 服务端 SRT 写入回归通过：相邻字幕会自动留出最小间隔，输出为 UTF-8 字幕文件。

### 数据与部署

- 部署仅同步代码与静态资源；必须保护服务器数据库、上传目录、账号、资产库、发布清单、草稿、成员、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v67 - 2026-07-10

### 本版范围

- 修复数字人成功片段“放大预览”与视频加载错误处理的任务查询作用域：`digitalJobFor` 提升到工坊渲染公共作用域，预览点击不再引用渲染内部的临时变量。
- 入口 HTML 静态资源缓存号升级到 `20260710-v67`。

### 验证结果

- `node --check 自动化产品/js/views/chainWorkshop.js` 通过。
- 数字人任务查询回归：按 `videoJobId`、`segmentId` 与分段序号均可定位既有成功任务，不创建新任务。
- 模块冷导入与本地 HTTP 冷启动烟测通过。

### 数据与部署

- 本次仅修复前端作用域和静态资源缓存号。部署时只同步代码与静态资源，必须保护服务器数据库、上传目录、账号、资产库、发布清单、草稿、成员、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v66 - 2026-07-10

### 本版范围

- 修复草稿箱时间线的事件监听器作用域：批量删除、勾选和折叠监听器回到草稿页 `render/draw` 生命周期内，避免应用模块加载时引用不存在的 `root` 而导致冷启动白屏。
- 入口 HTML 静态资源缓存号升级到 `20260710-v66`。

### 验证结果

- `node --check 自动化产品/js/views/draftsView.js` 通过。
- Node 模块冷导入通过，草稿页模块在未渲染前不访问页面根节点。
- 本地 HTTP 冷启动烟测通过。

### 数据与部署

- 本次仅修复前端模块和静态资源缓存号。部署时只同步代码与静态资源，必须保护服务器数据库、上传目录、账号、资产库、发布清单、草稿、成员、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v65 - 2026-07-10

### 本版范围

- 图文单号与批量创作统一收敛为标题、正文驱动的自定义文案路径，移除前台“标准生成”、创作内容和产品锁定框；产品信息仅保留为后台事实边界。
- 图文支持 1-12 张：单张会生成一张有序信息图；两张时首图保持强点击入口，第二张展开具体动作、证据或结果。
- 批量图文同步移除标准模式，单账号可直接填写标题、正文和图数；素材与真人视频原有自动/自定义能力不受影响。
- 剪辑页收紧预览与时间轴布局，采用更少圆角和图标工具栏；数字人所有成功片段会按顺序进入时间轴，并在片段条显示视频缩略预览。
- 剪辑页移除手动智能混剪与合成按钮：视频片段齐备后自动进入拼接与合成；增加口播音量控制，删除操作支持选中片段或字幕后直接按 Delete / Backspace。
- 草稿箱改为按日期折叠的时间线，并支持多选批量删除；供应商表仅显示发布人，不再重复内容账号。
- 设置页移除前台密钥管理区和本地密钥导入导出；成员申请与成员账号前置，管理员编辑成员时只能重设密码，不能查看已有密码。
- ZIP 文件写入 UTF-8 文件名标志，改善 Windows 解压中文文件名乱码；数字人任务改为受控多并发队列并保持上游限流退避。
- 入口 HTML 静态资源缓存号升级到 `20260710-v65`。

### 验证结果

- `node --check` 通过：`chainBoards.js`、`chainCut.js`、`draftsView.js`、`deliveryView.js`、`settings.js`、`ai.js`、`jobs.js`、`cards.js`、`view.js`、`orchestrator.js`。
- `python3 -m py_compile 自动化产品/server/main.py` 通过；`git diff --check` 通过。
- 数字人时间轴回归通过：三段已完成视频会全部进入时间轴；缺失的已完成片段会按分段顺序补回。
- ZIP UTF-8 回归通过：本地文件头和中央目录均设置 UTF-8 文件名标志。
- 本地服务 HTTP 烟测通过。

### 数据与部署

- 本次只更新代码、静态资源和版本记录。部署时只同步代码与静态资源，必须保护服务器数据库、上传目录、账号、资产库、发布清单、草稿、成员、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v64 - 2026-07-10

### 本版范围

- 修复视频 provider 配置加载与任务创建之间的竞态：视频任务会等待服务端配置检测结束，检测失败时明确停止提交，不会误建模拟视频任务。
- 视频 job 创建后持久化 provider，并在轮询、取消、刷新恢复时始终使用该 job 的 provider，不再以页面当前 provider 覆盖历史任务。
- 将旧 `mock-video` / `mv_` 任务转为可读失败态，提示按当前真实视频服务重新提交，避免把模拟任务 ID 交给真实视频服务轮询。
- 数字人已完成片段新增独立“放大预览”，并提升工坊内视频控件的交互层级，避免原生播放、进度和全屏控件被卡片覆盖层拦截。
- 批量自定义创作的账号卡移除无操作含义的产品库与自定义装饰标签，释放空间给标题和正文输入；同类账号卡的自定义模式统一采用更紧凑的两列布局。
- 量产任务会话列表移除表情符号前缀，仅保留清晰的任务类型文本与现有图标系统。
- 量产任务会话列表改为单行线程式布局：标题、运行状态圆点与时间同列展示，移除摘要第二行和卡片圆角，降低长列表的视觉噪音。
- 语音生成页的“我的音色”新增重命名入口：只改平台内展示名称，不改变上游 voice_id，并同步已固定账号和已有草稿中的名称显示。
- 入口 HTML 静态资源缓存号升级到 `20260710-v64`。

### 验证结果

- `node --check` 通过：`providers.js`、`jobs.js`、`chainWorkshop.js`、`voiceLab.js`、`voices.js`、`cards.js`、`view.js`。
- `python3 -m py_compile` 通过：`server/main.py`。
- 视频 provider 本地回归通过：模拟“首次配置尚未读取”的视频提交会先等待配置接口返回，并解析到 `seedance-video`，不创建 mock-video 任务。
- `git diff --check` 通过。
- 待部署线程复测：全新浏览器登录后立即提交信息流视频，应使用真实视频服务；刷新后按 job.provider 继续轮询，旧模拟任务不再触发真实上游资源不存在错误。

### 数据与部署

- 本次仅更新前端任务调度与静态资源。部署时只同步代码和静态资源，继续保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v63 - 2026-07-10

### 本版范围

- 修复素材号单号自定义信息流生成脚本被旧前端语言模型参数拖慢的问题：同源代理模式不再发送浏览器侧思考模式与输出上限，由服务器统一管理。
- 服务端语言模型代理强制应用部署环境的模型、思考模式和输出上限；对 MiniMax 路线会清除未配置的思考参数并限制异常偏大的输出请求，避免旧缓存或手工请求绕开策略。
- 自定义视频草稿默认使用受控输出上限和关闭思考模式；语言模型超时后保留用户标题、正文，并通过原有失败状态回写恢复为可重试。
- 入口 HTML 静态资源缓存号升级到 `20260710-v63`。

### 验证结果

- `node --check` 通过：`llm.js`、`ai.js`、`chainWorkshop.js`。
- `python3 -m py_compile` 通过：`server/main.py`。
- 本地请求策略回归通过：同源托管模式调用即使传入旧的高思考 / 高输出参数，请求体也不包含相关字段；服务端模拟回归确认会强制应用模型、关闭思考和受控输出上限。
- `git diff --check` 通过。
- 待部署线程复测：素材号单号自定义标题和正文生成信息流脚本应在 90 秒内完成，标题/正文保持原文，前后15秒脚本写入，正文标签不进入视频提示词。

### 数据与部署

- 本次只涉及前端请求策略、服务端语言模型代理和静态资源缓存号。部署时只同步代码与静态资源，继续保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v62 - 2026-07-09

### 本版范围

- 修复 v61 信息流 B 面分镜失败回写仍可能被服务器跳过的问题：分镜 `storyboarding` / `ready` / `failed` 状态变化会同步更新 production 顶层 `updatedAt`，确保共享后端按后写胜规则接受最新状态。
- 分镜生成失败、超时、连接中断后立即持久化到共享后端，按钮应恢复可重试，不再长期停在“分镜生成中”。
- 服务端 `/api/state` 增加旧数据自愈：遗留 `storyboarding` 超过阈值且没有分镜资产时，会恢复为 `failed` 并写入可读错误。
- B 面分镜相关内容保存前会清洗不适合的真人描述；分镜参考改为产品界面、设备、流程卡、图标、手部局部或 2.5D 动画角色，不再把相关禁止词写入 `infoFlow` 序列化内容。
- 入口 HTML 静态资源缓存号升级到 `20260709-v62`。

### 验证结果

- `node --check` 通过：`chainWorkshop.js`、`orchestrator.js`。
- `python3 -m py_compile` 通过：`server/store.py`。
- `git diff --check` 通过。
- 临时 SQLite 回归通过：旧 `storyboarding` 且无分镜资产的 production 会在 `/api/state` 拉取时恢复为 `failed`，并清洗 B 面分镜相关不适合的人物描述。
- 待部署线程复测：素材号单号自定义信息流点击“生成功能演示分镜”，成功时应落库分镜图；失败 / 超时 / 连接中断时应写回 `failed` 并可重试。

### 数据与部署

- 本次包含服务端读取态自愈逻辑，但不包含数据迁移脚本。部署线程更新时只同步代码和静态资源，继续保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v61 - 2026-07-09

### 本版范围

- 修复信息流 B 面“生成功能演示分镜”长时间卡在生成中的问题：单张分镜提交、轮询、下载和后处理均增加超时，失败会回写 `infoFlow.status=failed` 和可读错误。
- 页面加载 / 重绘时会自动恢复过期的 `storyboarding` 状态；如果分镜生成超时或连接中断且没有任何分镜落库，会变为可重试状态，不再无限显示“分镜生成中”。
- 单号和批量信息流分镜生成统一最多 3 张，和界面占位一致，避免顺序生成 4 张导致等待过长。
- B 面分镜参考 prompt 再次收紧：替换写实真人相关词，并附加只允许产品界面、设备、流程卡、图标、手部局部或 2.5D / 动画人物的约束。
- 入口 HTML 静态资源缓存号升级到 `20260709-v61`。

### 验证结果

- `node --check` 通过：`chainWorkshop.js`、`orchestrator.js`。
- `git diff --check` 通过。
- 待部署线程复测：素材号单号自定义信息流生成脚本后点击“生成功能演示分镜”，成功时应落库分镜图；失败 / 超时 / 连接中断时应显示可重试错误并写回 production。

### 数据与部署

- 本次不包含服务器数据迁移。部署线程更新时只同步代码和静态资源，继续保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v60 - 2026-07-09

### 本版范围

- 修复素材号单号自定义信息流点击“生成脚本”后覆盖用户发布标题 / 发布正文的问题：自定义模式保留用户原文，只派生前15秒 / 后15秒脚本和视频提示词。
- 信息流 B 面分镜图生成增加非写实真人约束：分镜参考只呈现产品界面、设备、流程卡、图标、手部局部或 2.5D / 动画人物，避免写实真人参考导致视频生成失败。
- 数字人分段卡片优先显示真实口播音频时长，视频预览使用角色图作为 poster 占位，生成中 / 已生成状态更容易判断。
- 后端成片和上传文件接口增加浏览器 Range 分段读取支持，视频卡片改为只预加载 metadata，减少多段视频同时预览时黑屏、首帧慢和拖动卡顿。
- 视频与口播生成前清理高风险词，生成标签移除 `#国产百度搭子`，降低 TTS / 平台审核误伤。
- 整体资产和账号搜索保护中文输入法组合态，并支持用账号名、平台和账号类型命中素材。
- 入口 HTML 静态资源缓存号升级到 `20260709-v60`。

### 验证结果

- `node --check` 通过：`chainWorkshop.js`、`orchestrator.js`、`ai.js`、`assets.js`、`assetsView.js`、`main.js`。
- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- `git diff --check` 通过。
- 本地临时服务 smoke 通过：入口资源号为 `20260709-v60`；`/api/video/composed/...` 支持 `206 Partial Content` 分段读取。
- 待部署线程复测：素材号自定义信息流生成脚本后，表单和 production 中的发布标题 / 发布正文保持用户原文；`infoFlow.segments` 正常写入。
- 待部署线程复测：数字人一键生成继续跳过已成功段，只提交下一个缺失 / 失败段。

### 数据与部署

- 本次不包含服务器数据迁移。部署线程更新时只同步代码和静态资源，继续保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v59 - 2026-07-09

### 本版范围

- 数字人 / Seedance 视频轮询成功后，服务端会先把上游生成视频缓存为同源稳定成片地址，再写入 `videoOutput.url`，避免前端直接播放上游临时地址导致 403 或黑屏。
- 如果成片缓存失败，轮询结果会把该段标记为失败并返回可读错误，前端可直接重试该段，不再显示无法判断状态的黑色视频。
- 剪辑合成接口支持读取 `/api/video/composed/...` 与 `/api/files/...` 同源资源，确保数字人预览地址稳定后仍能进入智能混剪并合成成片。
- 数字人分段预览新增资源加载失败兜底：浏览器检测到视频资源不可读时，会把该段切成可重试失败态并提示用户。
- 素材号自定义信息流“生成脚本”增加落库校验：无论自定义生成分支是否重绘页面，都会确认前15秒 / 后15秒脚本写入 `infoFlow.segments`；若生成为空或解析失败，会写入 `infoFlow.error` 并给出可读提示。
- 入口 HTML 静态资源缓存号升级到 `20260709-v59`。

### 验证结果

- `node --check 自动化产品/js/views/chainWorkshop.js` 通过。
- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- `git diff --check` 通过。
- 本地 8787 服务已用当前代码启动，首页加载成功且入口资源为 `20260709-v59`。
- 后端缓存函数本地回归通过：远端视频文件可缓存成 `/api/video/composed/...` 稳定地址。
- 待部署线程复测：数字人成功段的 `videoOutput.url` 应为服务器同源稳定地址，浏览器预览不再请求上游临时视频资源；剪辑页应能读取同一段视频。
- 待部署线程复测：素材号单号自定义信息流点击“生成脚本”后，标题 / 正文保留用户输入，前15秒 / 后15秒脚本 textarea 有内容，production 中 `infoFlow.status=ready` 且 `segments` 非空。

### 数据与部署

- 本次不包含服务器数据迁移。部署线程更新时只同步代码和静态资源，继续保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v58 - 2026-07-09

### 本版范围

- 修复数字人 job 成功后不回写到生产段的问题：数字人任务新增 `segmentId`，job 同步时会兜底创建/定位对应分段，并把 `videoJobId / videoStatus / providerRef / videoOutput / videoError` 写回 production。
- 生成分段口播和生成数字人视频前都会持久化 `artifacts.boards.digitalHuman.segments`，避免显示段和服务器 jobs/docs 分裂。
- 数字人段卡片新增视频占位：未生成时显示待生成区域，队列 / 生成中时显示进度占位，拿到 output 后直接替换为真实视频预览；刷新后可从 job output 或分段 `videoOutput` 恢复。
- 数字人一键生成改为真正单并发：同一 production 同时只派发 1 个数字人片段，下一次点击才继续生成下一个缺失 / 失败片段；缺音频或缺角色图的片段会跳过并提示，已成功段不重复提交。
- 智能混剪新增数字人分段组装逻辑，成功的数字人段会进入 timeline，剪辑页可拿到对应视频 output。
- 单号素材视频自定义信息流的“生成脚本 / 生成功能演示分镜 / 生成信息流视频”全部改为读取当前自定义标题、正文和口播线索；自定义标题优先级高于旧 topic，不再被自动标题覆盖。
- 统一清洗 `#国产百度搭子` 为 `#百度搭子`，避免数字人或视频文案输出错误品牌标签。
- 根据外部审查建议补两个低风险项：MiniMax TTS 音量保留小数并做合法范围钳制；`sanitizeXhsObject` 对 URL / dataUrl / id / token 等字段加清洗豁免，避免未来误伤结构化数据。
- 成片文件读取路由增加文件名 basename 防护。
- 入口 HTML 静态资源缓存号升级到 `20260709-v58`。

### 验证结果

- `node --check` 通过：`api/jobs.js`、`views/chainWorkshop.js`、`agent/orchestrator.js`、`domain/productions.js`、`core/xhsGuard.js`。
- 本地浏览器隔离验证通过：数字人一键生成首次只派发 D01；已有数字人任务进行中时不会重复派发；D01 模拟成功后能组装出 timeline clip；再次生成会派发 D02。
- `git diff --check` 通过。
- 待部署线程复测：线上数字人生成中应显示每段视频占位与进度；单段成功后应在 D01 卡片显示视频预览，刷新后仍恢复；进入剪辑页应能看到该段视频素材；D02 无音频时不提交并给明确提示。
- 待部署线程复测：单号素材视频自定义标题 / 正文生成信息流脚本时，标题不被自动标题覆盖，B 面提示词仍围绕用户标题和正文。

### 数据与部署

- 本次不包含服务器数据迁移。部署线程更新时只同步代码和静态资源，继续保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v57 - 2026-07-08

### 本版范围

- 单号视频自定义文案模式默认不再显示产品选择框；用户只需要填写发布标题和正文，系统从标题 / 正文里推断产品方向。
- 产品知识库保留为后台能力：用于标准生成、批量自动生产、默认品牌素材、封面兜底和资产归类；自定义模式下不再让产品下拉影响用户创作。
- 自定义视频一键生成和封面生成会用标题 / 正文推断后台产品，仅在无法识别时回退到当前账号默认产品。
- 真人 / 数字人单号视频的发布标题改为短文本区，和右侧正文底部对齐；素材号单号视频的标题 / 正文 / 封面提示词 / 封面预览按默认状态重新对齐。
- 自定义模式下发布标题空值时增加浅蓝必填提示动效；填入标题后自动恢复普通样式。
- 口播音频区按钮重新分组：收藏独立成列，固定到账号和生成分段口播上下排列，避免真人 / 数字人账号按钮重叠。
- 入口 HTML 静态资源缓存号升级到 `20260708-v57`。
- 信息流 A/B 视频提示词保留 `0-3s / 3-7s` 等时间分段；只清除 `第一镜 / 第二镜 / 功能演示分镜结构` 这类分镜图提示，避免图片分镜 prompt 混入视频生成 prompt。
- 信息流自定义模式把“发布文案”和“视频线索”分开：发布文案保留话题标签，视频提示词只参考口播/画面线索，避免 B 面生成后把标签吃掉。

### 验证结果

- `node --check` 通过：`api/llm.js`、`api/ai.js`、`api/prompts.js`、`views/chainWorkshop.js`、`views/chainBoards.js`、`agent/orchestrator.js`、`agent/cards.js`、`agent/view.js`。
- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- `git diff --check` 通过。
- 浏览器真实 UI 验证通过：素材号单号自定义信息流、真人 / 数字人单号自定义口播、批量素材号自定义信息流、批量真人 / 数字人自定义口播。
- 素材号单号 / 批量验证结论：用户标题不被覆盖；发布文案保留 `#AI工具 #AI提效 #codex #AI办公 #效率工具 #百度搭子` 等标签；B 面视频提示词保留 `0-3s / 3-7s / 11-15s` 时间分段；视频提示词不包含 `第一镜 / 第二镜 / 功能演示分镜结构`；负面约束固定为 `无字幕，不生成花字，不生成水印，不生成二维码。`
- 真人 / 数字人单号 / 批量验证结论：标题保留；发布文案偏专业解析；口播由 LLM 生成、第一人称、长度明显长于发布文案，且不与发布文案同文。

### 数据与部署

- 本次不包含服务器数据迁移。部署线程更新时只同步代码和静态资源，继续保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。
- 部署后重点复测：单号视频进入默认自定义模式时不应出现产品下拉；素材号标题 / 正文 / 封面区域应按新布局显示；自定义标题和正文应直接驱动口播、信息流 B 面和封面提示词。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v56 - 2026-07-08

### 本版范围

- 图文图片提示词新增可见文本清洗：`封面图 / 内页 / 内页1 / 图1 / 第1张` 等内部结构词不再进入图像模型提示词或画面标题，避免生成“内页：xxx”这类错误画面。
- 图文提示词保留用户标题里的 Codex、WorkBuddy、Obsidian 等工具名，不再把用户写的“平替 / 对比 / 分工”标题强行替换成当前主产品。
- 单号视频文案分镜新增“自定义文案 / 标准生成”切换，默认自定义文案；只填标题时，一键生成会先补正文，再据此生成口播或信息流 B 面提示词。
- 单号视频自定义模式下隐藏“创作内容”输入框，只保留发布标题 / 发布文案，避免用户同时填两套主题；切回标准生成才显示创作内容框。
- 自定义视频正文里的话题标签只保留在发布文案和导出包中，不再进入口播切分或视频提示词。
- 素材号信息流顶部 UI 继续收紧：模式按钮并入顶部主操作行，文案输入和封面区域高度更接近，减少左右空白。
- 入口 HTML 静态资源缓存号升级到 `20260708-v56`。

### 验证结果

- `node --check` 通过：`ai.js`、`chainWorkshop.js`、`chainBoards.js`、`orchestrator.js`。
- 源码断言通过：自定义图文路径不再包含 `封面图：/ 内页图` 前缀，图片提示词不再对用户 copy 标题执行竞品名替换。

### 数据与部署

- 本次不包含服务器数据迁移。部署线程更新时只同步代码和静态资源，继续保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。
- 部署后重点复测：图文自定义标题不要生成“内页：”画面；视频号只填标题时能自动补正文并生成强相关口播 / 信息流 B 面；导出 zip 中继续包含 `标题文案.txt` 和视频文件。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v55 - 2026-07-08

### 本版范围

- 批量创作里的图文号、素材视频号、真人 / 数字人号默认进入“自定义文案”模式；用户需要填写标题和正文，标准生成才使用“创作内容”输入。
- 批量确认前增加自定义文案校验：默认自定义模式下未填写标题/正文会提示对应账号，不会静默跑回默认选题池。
- 批量素材号自定义文案会直接驱动信息流计划、发布文案、封面提示词和 B 面功能演示提示词；B 面不再被默认主题覆盖。
- 批量真人 / 数字人号自定义文案会按用户正文切分出口播镜头，再生成对应视频提示词和封面，不再用泛化脚本模板替换用户文案。
- 单号信息流工坊中，如果用户已填写发布标题和正文，一键生成会保留该标题，并用正文生成后 15 秒功能演示提示词。
- 素材号信息流文案分镜 UI 改为两列紧凑布局：左侧标题/文案，右侧封面提示词、按钮和封面预览，减少大面积空白。
- 入口 HTML 静态资源缓存号升级到 `20260708-v55`。

### 验证结果

- `node --check` 通过：`cards.js`、`view.js`、`orchestrator.js`、`chainWorkshop.js`。
- 自定义文案源码断言通过：批量默认自定义、确认校验、素材号信息流自定义标题/正文、真人口播切分、单号信息流保留自定义标题均已落到代码。

### 数据与部署

- 本次不包含服务器数据迁移。部署线程更新时只同步代码和静态资源，继续保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。
- 部署后重点复测：批量素材号填写标题/正文后，信息流 B 面提示词应强相关；批量真人号填写标题/正文后，口播草稿应直接围绕正文展开。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v54 - 2026-07-08

### 本版范围

- 数字人视频任务调度改为全局单并发：同一时间只提交 1 个 OmniHuman 段，避免一键生成多段时打到上游并发上限。
- 数字人提交/轮询遇到上游并发限制、网关超时、504/TLB 或连接超时时，会自动退避重试最多 3 次，并显示“上游限流/网关超时”的可读提示，不再误导为配置缺失。
- 数字人 job 状态会把 providerRef、progress、output/error 同步回 production 分段；刷新页面后继续按 12-20 秒间隔轮询，完成或失败后停止，减少浏览器高频重复轮询和本地/服务器状态分裂。
- 数字人封面默认带账号上传的角色形象参考图；参考图封面生成超时会先回写失败/可重试状态，并允许降级为纯文本封面重试，避免一直卡在“生成中”。
- 信息流 A/B 片段增加单段“生成/重生/重试本段”按钮；批量生成出来的信息流 production 也复用同一套单段重生逻辑。
- 信息流旧失败任务在重新派发时会被作废，避免新任务成功后仍被旧失败状态拖住。
- 整体资产增加按账号“导出并清空图片”操作：先把该账号共享图片打包下载到本地，再删除对应图片资产和服务器文件；不删除视频成片、发布记录或账号资料。
- 整体资产筛选和卡片标签做减法，默认只保留“视频 / 图文”类型表达，不再铺满历史标签。
- 数据分析刷新类按钮改为管理员专属；普通成员只能查看数据和打开发布链接。
- 视频文案分镜顶部 UI 改为更紧凑的上下结构：主题/标题/正文占用更小，口播草稿与封面提示词/预览并排，封面提示词在左、预览在右。
- 发布清单供应商详情行列数修正，和已删除“形式”列后的表格保持一致。
- 入口 HTML 静态资源缓存号升级到 `20260708-v54`。

### 验证结果

- `node --check` 通过：`jobs.js`、`providers.js`、`chainWorkshop.js`、`orchestrator.js`、`deliveryView.js`。
- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- `git diff --check` 通过。
- 浏览器真实打开本地 8787：页面标题加载正常，未出现“前端加载出错”。
- 本地脱敏接口检查通过：`/api/health` 正常，`/api/video/config` 返回视频与数字人配置/可达性字段；本机没有公网资源地址时不做真实数字人出片。
- 源码断言通过：数字人单并发、退避重试、数字人封面默认角色图、信息流单段重生按钮、整体资产账号级导出清理、数据刷新管理员专属、v54 缓存号均已落到代码。

### 数据与部署

- 本次不包含服务器部署。部署线程更新时只同步代码和静态资源，继续保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。
- 部署后优先复测数字人：一键生成多段时应按 1 个段串行提交；如果上游返回限流或网关超时，应进入自动退避，不应同时失败 3 段。
- 部署后复测数字人封面：带角色图参考时不应无限“生成中”；超时后可重试或降级。
- 服务器侧如果要真实跑数字人，角色图和分段口播音频仍必须是上游可访问的公开资源地址。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v52 - 2026-07-08

### 本版范围

- 信息流智能混剪字幕改为只从 A/B 视频提示词里的自然台词、吐槽、旁白和口播收束中抽取，不再用标题或发布文案兜底成字幕。
- 信息流标题模板扩到 20 种热标题结构，同一批不同主题能生成明显不同的标题，减少“来回都是那几句”的趋同感。
- 单号和批量信息流 A/B 段都改为 seed 多分支：A 面保留夸张吸引人的剧情，B 面围绕功能演示和分镜参考展开，且两段都会带有可被智能混剪识别的自然说话内容。
- 批量信息流不再存在固定 `voiceover` 字段或“口播原话”模板，继续让视频提示词自由发挥。
- 发布清单供应商视角删除“形式”列，避免和“标签”重复。

### 验证结果

- Playwright 真实浏览器验证通过：连续 20 个不同信息流主题，20/20 生成成功，标题 20 个唯一，A/B 提示词均不同，智能混剪字幕行均来自提示词台词且不等于标题。
- Playwright 真实浏览器验证通过：供应商视角表头已无“形式”列，仅保留序号、素材名、产品、内容账号 / 发布人、平台、标签、状态。
- 批量信息流静态验证通过：20 个标题句式、无固定 `voiceover` 字段，A/B 构建接入 seed 多分支。
- `node --check` 通过：`productions.js`、`chainWorkshop.js`、`orchestrator.js`、`deliveryView.js`。
- `git diff --check` 通过。

### 数据与部署

- 本次不包含服务器部署。部署线程下一次更新时只同步代码和静态资源，继续保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。
- 服务器部署后需要重新验证信息流：生成脚本 -> 生成分镜 -> 生成信息流视频 -> 智能混剪字幕，确认字幕来自提示词中的自然台词而不是标题。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v51 - 2026-07-08

### 本版范围

- 数据分析看板去掉当前接口不稳定的“阅读”和“质量”展示，保留回链、快照、赞、藏、评、互动率和单条刷新按钮。
- 视频创作顶部增加显眼的“一键生成”入口；信息流模式不再因为口播草稿框隐藏而找不到生成按钮。
- 修复信息流视频提交误判：已有前 15 秒 / 后 15 秒脚本和功能演示分镜时，不再错误提示“请先生成信息流脚本”。
- 信息流生成增加随机创作种子和统一风格锚点：A 面可以更夸张自由，B 面和分镜参考保持同一视觉风格，并继续把功能演示分镜作为后 15 秒视频参考。
- 发布文案提示词做减法：去掉固定标题模板、固定三段式、字数结构和本地结构参考，只保留主题、平台、产品、账号语气、已定内容和不偏题底线。
- 发布正文去掉开头重复标题的问题，文案围绕用户主题重新组织，不再把标题当正文第一句。
- 链路 stepper 将视频首步显示为“文案分镜”，视频链路彻底合并为“文案分镜 → 剪辑 → 审核”，旧 `studio/copy` 路由会自动回到文案分镜。
- 修复数字人资源预检误判：共享服务模式下，上传素材同时存在本地 `blob:` 预览和服务端文件地址时，数字人预检/提交优先使用服务端文件地址。
- 视频交付快照记录封面图，发布清单的视频卡片优先显示封面；视频进入下一步/发布前会要求先生成或上传封面图。
- MiniMax TTS 上游余额/额度不足时，后端和前端提示改为明确的余额/额度问题，避免误判成 API 不通。
- 入口 HTML 静态资源缓存号升级到 `20260708-v51`。

### 验证结果

- Playwright 真实浏览器验证通过：视频旧 `#/studio/copy` 会自动跳回 `#/studio/workshop`，stepper 只显示“文案分镜 / 剪辑 / 审核”，不再出现独立文案空页。
- Playwright 真实浏览器验证通过：共享模式上传测试图片后，`urlFor()` 返回服务端文件地址而不是本地 `blob:`，数字人预检不会再被前端误拦。
- `node --check` 通过：`studio.js`、`productions.js`、`assets.js`、`chainWorkshop.js`、`chainCut.js`、`chainCopy.js`、`deliveryView.js`、`delivery.js`、`ai.js`、`main.js`。
- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- `git diff --check` 通过。

### 数据与部署

- 本次不包含服务器部署。部署线程需要用本版 commit 只同步代码和静态资源，并保护服务器数据库、上传目录、账号、资产、发布清单、草稿、成员、分析数据、环境文件和认证缓存。
- 服务器语言模型配置需要切到当前本地使用的 MiniMax-M3；不要继续使用旧语言模型配置。
- 数字人真实出片仍必须在服务器侧完成公网素材和上游凭据验证：角色图、分段口播音频必须是上游可访问 URL，本地 `data:`、`blob:`、`localhost` 或内网文件不能直接提交。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v50 - 2026-07-07

### 本版范围

- 入口 HTML 静态资源缓存号正式升级到 `20260707-v50`，避免后续纯按 commit 部署时继续命中旧 JS/CSS。
- Seedance Ark URL 拼接增加容错：当服务器环境把方舟 base 配成带 `/api/v3` 或任务路径的形式时，后端不会再重复拼接 `/api/v3`。

### 验证结果

- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- Seedance URL 拼接抽测通过：base 为根域名、`/api/v3`、完整任务路径三种形式时，提交地址都归一到同一任务 API 路径。
- `rg` 检查入口 HTML 已无旧 v47 缓存号。
- `git diff --check` 通过本次提交范围。

### 数据与部署

- 本次不包含服务器部署；已通知部署线程按保护数据流程重新部署或只重启复测。
- Seedance 服务器侧当前阻塞是 DNS/网络层 `Name or service not known`，优先由部署线程在服务器环境将视频上游 endpoint 切到可解析可访问的方舟/Seedance 网关，并复测最小提交。
- 若部署线程改为火山方舟中国区路线，应保持 endpoint、模型 ID、payloadMode 和 key 类型一致；不要混用不同地域或不同供应商路线。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v49 - 2026-07-07

### 本版范围

- 修复线上 v48 前端加载失败：补齐 `xhsTrendLibrary.js` 导出的 `normalizeCreativeTopicForMode`，与 `api/ai.js` 的 import 保持一致。
- 将本地已验证的数据分析 JustOneAPI 代理前后端配套提交：数据分析页改用 `/api/analytics/justoneapi/config` 和 `/api/analytics/justoneapi/fetch`，删除旧的前端采集适配器文件，避免部署后前后端接口不匹配。
- 将本地已验证的 OmniHuman 数字人服务端实现提交：`/api/video/config` 返回数字人模型、配置可见性、上游可达性、payload 模式、公开资源地址配置状态等验收字段。
- `/api/video/submit` 对数字人请求走智能视觉签名提交，返回带数字人前缀的 providerRef；`/api/video/poll/{task_id}` 能按 providerRef 路由到数字人轮询。
- 数字人缺凭据、缺公网角色图、缺公网口播音频时返回明确错误，不再伪装提交成功。

### 验证结果

- 本地 `curl /api/video/config` 返回 `digitalHumanModel`、`digitalHumanConfigured`、`digitalHumanReachable`、`digitalHumanBaseUrl`、`publicBaseConfigured` 等字段，可供部署线程验收。
- 浏览器真实刷新工作台通过，未再出现 `normalizeCreativeTopicForMode` 缺导出导致的前端加载错误。
- `node --check` 通过：`自动化产品/js/data/xhsTrendLibrary.js`、`自动化产品/js/api/ai.js`、`自动化产品/js/domain/analytics.js`、`自动化产品/js/views/analyticsView.js`。
- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- `git diff --check` 通过本次提交范围。

### 数据与部署

- 本次不包含服务器部署；已通知部署线程重新按保护数据流程部署。
- 部署时只允许更新代码和静态资源并重启服务；不得覆盖服务器数据库、上传目录、账号、资产库、发布清单、草稿、成员、数据分析、环境文件或认证缓存。
- JustOneAPI 与数字人凭据只能放在服务器环境变量或私密配置文件；仓库、文档、聊天和提交信息都不能写入明文凭据。
- 数字人真实验收仍以服务器为准：配置字段可见后，还要提交一个真实数字人分段任务，拿到 providerRef 并轮询到输出才算完成。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v48 - 2026-07-07

### 本版范围

- 修复数字人分段按钮误报问题：数字人分段从分镜重建时保留原分段 ID，避免按钮拿到旧 ID 后误判“缺少数字人片段 / 先生成口播草稿”。
- 数字人生成视频现在会先通过分段口播、角色图和公网素材预检；本地未配置公网访问地址时明确提示 OmniHuman 只能读取公网素材，不再让用户误以为口播没有生成。
- 数字人主题兜底生成增强：当语言模型不可用或超时时，脚本和发布文案仍会围绕用户输入主题展开，覆盖模型选择、周报、合同、表格、内容创作、会议复盘、交付包等常见主题，不再回落成无关泛文案。
- 创作主题 / 发布文案 / 口播草稿 / 封面图合并为一个顶部创作控制台：说明文字改为顶部横排，不再占左侧大面积空白；口播草稿内置“一键生成 / 按口播生成文案 / 复制口播”工具条；封面按钮收进封面区域顶部。
- 顶部封面区改为横向预览 + 内容编辑一体化布局，按钮不再竖向占用整列，减少空白和视觉割裂。

### 验证结果

- Playwright 真实页面验证通过：`#wsBriefbar` 中说明行与内容区等宽，左侧不再保留独立空列；口播三个操作按钮位于口播草稿框内。
- Playwright 真实点击数字人“生成视频”通过：已有分段口播和角色图时不再出现“缺少数字人片段 / 请重新生成口播草稿”；当前本地环境正确停在 OmniHuman 公网素材前置提示。
- 数字人主题兜底生成完成 20 组不同主题抽测，20/20 均围绕用户主题生成口播和发布文案，没有回落到默认无关文案。
- `node --check` 通过：`自动化产品/js/views/chainWorkshop.js`、`自动化产品/js/api/ai.js`。

### 数据与部署

- 本次没有执行服务器部署；只完成部署前置修复和本地验证。
- 数字人真实出片仍依赖服务器进程配置公网可访问地址，并确保上传后的角色图和分段音频能被上游 OmniHuman 读取；本地 `data:`、`blob:`、`localhost` 或内网文件不能直接提交。
- 部署线程更新时只允许更新代码和静态资源并重启服务；不得覆盖线上数据库、上传目录、账号、资产库、发布清单、数据分析、草稿、成员、环境文件或认证缓存。
- 部署后验证顺序：检查 `/api/video/config` 中数字人配置、公开视频/音频可访问状态，再提交 1 个数字人分段任务并轮询到 providerRef / output，不能只看按钮是否可点击。
- 回滚方式：回退本次 `chainWorkshop.js`、`styles/views.css`、`api/ai.js` 以及本记录后重启服务；业务数据不需要回滚。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v41 - 2026-07-04

### 本版范围

- 登录页移除视频背景引用，改为静态白色科技感背景，降低服务器和弱设备首屏负载。
- 登录页恢复星阵 logo，资源写入 `自动化产品/assets/brand/xingzhen-login-logo.png`，不依赖本机临时路径。
- 语音生成入口移动到侧边栏“数据分析”之后，并改为管理员专属；导航、命令面板和 hash 路由均做了权限限制。
- 移除前端入口对本机 `js/local/devKeys.js` 的依赖，避免部署时缺少被忽略文件，也避免任何开发 key 进入仓库。
- 语音生成页功能切换条并入应用顶栏中间，与搜索 / 通知处在同一栏；页面内容区整体上移。
- 登录面板略微上移，保留静态白色科技背景与毛边玻璃质感。
- 数据分析 OpenCLI 查找增强：服务端支持 `OPENCLI_BIN` / `AGENT_REACH_OPENCLI_BIN` 和常见安装路径，缓解服务器服务进程 PATH 过短导致的“未检测到 OpenCLI”。
- 图片生成 / 文件代理 / 视频合成等 URL 下载阶段改为按当前 `httpx` 方法签名动态选择重定向参数，兼容本地新版和服务器旧版依赖。
- 单个账号主页的“账号资产库”现在会显示该账号已进入整体资产库的已发布 / 共享资产；未发布私有素材仍按当前成员隔离。
- 静态资源版本号升级到 `20260704-v41`，避免浏览器继续拿旧的登录页、导航和样式缓存。

### 验证结果

- 本地 8787 `/api/health` 通过，语言模型配置显示已配置，模型为 MiniMax-M3。
- 本地 8787 `/api/llm/test`、`/api/tts/generate`、`/api/image/generate` 真实最小调用均通过。
- 数据分析本地最小链路通过：`/api/analytics/resolve` 返回 200 并解析小红书 noteId；`/api/analytics/fetch` 在本机 OpenCLI 可用时返回真实结构化结果。
- Playwright 验证通过：登录页不存在 `loginBgVideo` / `.lg-bg-video` 节点，登录 logo 存在；非管理员态语音入口隐藏，管理员态语音入口位于数据分析后；非管理员手输 `#/voice` 会回到 `#/overview`。
- Playwright 补充验证通过：登录页视频节点数量为 0，登录 logo 存在，登录面板上移；语音生成功能条挂载到顶栏 `#voiceTopDock`，页面内容区不再保留独立大功能条。
- Node 抽测通过：同账号下本人私有素材、已发布素材和共享素材会出现在单个账号资产库；其他成员未发布私有素材不会出现。
- `python3 -m py_compile` 通过：`自动化产品/server/main.py`、`自动化产品/server/store.py`、`自动化产品/proxy.py`。
- `node --check` 通过：`router.js`、`main.js`、`voiceLab.js`、`voices.js`、`ai.js`、`llm.js`。
- `bash -n` 通过：`start.command`、`start-shared.command`。
- `git diff --check` 通过，无空白格式错误。

### 数据与部署

- 本版不新增业务数据迁移；沿用 v39 已增加的 `voicePresets` 集合。
- 后续服务器部署只更新代码和静态资源并重启服务；不得覆盖服务器数据库、账号、资产库、发布清单、草稿、任务、成员、分析数据、上传目录、环境文件或认证缓存。
- 数据分析服务器可用性依赖服务进程自己的 OpenCLI 命令和小红书登录态，不能只看浏览器或本机是否配置过。
- 若服务器仍提示未检测到 OpenCLI，可在服务环境配置 `OPENCLI_BIN` 指向 OpenCLI 可执行文件，或修正服务进程 PATH；不需要覆盖业务数据库。
- 回滚方式：回退本次提交后重启服务；登录页会回到上一版本，业务数据不需要回滚。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v47 - 2026-07-07

### 本版范围

- 视频号“信息流”发布文案改为完整发布稿：标题、真实使用补充说明、场景动作和固定话题标签一起生成，不再只写一句摘要。
- 百度搭子视频发布文案固定补齐话题标签：`#AI工具 #AI提效 #codex #AI办公 #效率工具 #百度搭子`。
- 单号文案分镜和批量信息流共用更具体的 A/B 片段生成逻辑：前 15 秒负责夸张办公冲突和钩子，后 15 秒负责具体产品功能演示。
- 信息流视频提示词移除自指式口播和抽象占位词，不再写“这是一条功能演示短视频”“要有概念稿”这类模型无法直接执行的描述。
- 信息流提示词不再注入账号定位 / 人物气质参考等会污染剧情的信息，只保留可拍的角色外貌、穿搭、表情和声线锚点。

### 验证结果

- `rg` 检查确认 `这是一条功能演示短视频 / 要机概念稿 / 人物气质参考 / A面和B面必须 / 账号视觉风格补充` 等问题词在本次关键文件中无残留。
- `node --check` 通过 `自动化产品/js/views/chainWorkshop.js`、`自动化产品/js/agent/orchestrator.js`、`自动化产品/js/api/ai.js`。
- `node --check` 追加通过文案分镜相关视图：`chainBoards.js`、`chainScript.js`、`chainCut.js`、`chainCopy.js`、`studio.js`。

### 数据与部署

- 本次只修改本地代码和文案策略，没有执行服务器部署，不涉及服务器数据迁移。
- 后续部署时只允许更新代码和静态资源，不能覆盖线上数据库、上传目录、账号、资产库、发布清单、数据分析、草稿、成员数据、环境文件或认证缓存。
- 回滚方式：回退本次信息流发布文案、A/B 提示词生成和视频标签兜底相关修改后重启服务。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v46 - 2026-07-06

### 本版范围

- 彻底下线外部搜索 / 外部指标采集相关入口：前端文案、后端接口、本地 mock、启动脚本和 Docker 注释均不再保留 OpenCLI、agent-reach、JustOneAPI、小红书外部趋势搜索或数据抓取路径。
- 图文与批量创作统一按本地四方向投放池、用户创作内容、账号语气和产品事实生成，不再尝试外部检索。
- 数据分析页改为发布回链、历史快照和本地复盘展示口径，不再提供服务器侧更新指标动作。
- 复测 Seedance 2.0 视频任务链路：确认当前 8787 本地服务配置可见、上游可达，且图片、视频、音频多模态参考任务可轮询到成功。
- 复测 OmniHuman 数字人链路：服务端已按智能视觉 CV 签名接口接入，但当前本地环境缺少智能视觉 AK/SK 对，无法完成真实提交；Ark 视频 key 不能直接替代该接口凭据。

### 验证结果

- `rg` 检查关键产品代码目录，已无 `OpenCLI / agent-reach / JUSTONEAPI / 小红书趋势接口 / 外部搜索入口 / 外部指标接口` 的可触发路径。
- `node --check` 通过 `api/ai.js`、`domain/analytics.js`、`views/analyticsView.js`、`data/xhsTrendLibrary.js`、`data/accountProfilesSeed.js`。
- `python3 -m py_compile 自动化产品/server/main.py 自动化产品/server/store.py` 通过。
- 本地 8787 `/api/video/config` 显示 Seedance 配置正常；已完成一次含公开图片、公开视频、公开音频参考的 Seedance 2.0 任务，状态为 `succeeded` 且有输出。
- 本地 8787 数字人最小提交会在本地后端明确返回缺少智能视觉 AK/SK，不会误提交或伪装成功。

### 数据与部署

- 本次只修改本地代码和文档，没有执行服务器部署，不涉及服务器数据迁移。
- 后续部署时只允许更新代码和静态资源；不得覆盖线上数据库、上传目录、账号、资产库、发布清单、数据分析、草稿、成员数据、环境文件或认证缓存。
- 回滚方式：回退本次外部搜索 / 外部指标入口移除、数据分析口径调整和相关版本记录，然后重启本地 / 服务器服务。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v45 - 2026-07-06

### 本版范围

- Seedance 视频提交链路补齐多模态参考：同一任务可携带参考图片、参考视频和参考音频，提交到 Ark 内容生成任务时分别映射为 `reference_image`、`reference_video`、`reference_audio`。
- 前端视频 provider 与 JobRunner 的参考素材上限从单一 9 个调整为最多 15 个，后端再按 Seedance 能力裁剪为最多 9 张图、3 段视频、3 段音频。
- 对本地 `data:`、`localhost` 视频 / 音频参考增加明确报错，避免上游无法读取本地文件时误以为已经提交成功；图片仍保留文本降级逻辑。
- 本地私密环境已切到可调用 Seedance 2.0 的视频 key；该配置不入库、不写入文档和提交信息。

### 验证结果

- `python3 -m py_compile 自动化产品/server/main.py 自动化产品/server/store.py` 通过。
- `node --check 自动化产品/js/api/providers.js 自动化产品/js/api/jobs.js 自动化产品/js/agent/orchestrator.js 自动化产品/js/views/chainWorkshop.js` 通过。
- `git diff --check -- 自动化产品/server/main.py 自动化产品/js/api/providers.js 自动化产品/js/api/jobs.js` 通过。
- 使用公开参考图片、公开视频、公开参考音频提交 Seedance 2.0 多模态 4 秒任务：提交成功，轮询到 `succeeded`，返回视频输出。
- 结构断言确认 payload 中包含 `text / image_url / video_url / audio_url`，且三类参考 role 均存在。

### 数据与部署

- 本次没有执行服务器部署，不涉及服务器数据迁移。
- 后续部署只更新代码和静态资源；服务器环境变量需由部署侧单独配置，不能覆盖线上数据库、上传目录、账号、资产库、发布清单、数据分析、草稿、成员数据、环境文件或认证缓存。
- 回滚方式：回退本次 Seedance 多模态参考提交改动和版本记录后重启服务。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v44 - 2026-07-06

### 本版范围

- 接入 OmniHuman 1.5 数字人后端通道：数字人任务不再复用 Seedance/Ark Bearer 提交流程，改为火山智能视觉 CVSubmitTask / CVGetResult 的签名接口。
- 新增数字人专用环境变量读取：`VOLC_ACCESS_KEY_ID`、`VOLC_SECRET_ACCESS_KEY`、`DIGITAL_HUMAN_REQ_KEY`、`DIGITAL_HUMAN_BASE_URL`、`DIGITAL_HUMAN_OUTPUT_RESOLUTION` 等；不把任何密钥写入代码或文档。
- 数字人工坊提交任务时，前端队列会按分段口播派发：每段都带角色图和对应口播音频，避免后端缺 `image_url` 或 `audio_url`。
- 数字人工坊的“一键生成视频”不再停留在“API 预留”提示；分段音频和角色图齐备时会真实创建数字人视频任务，缺配置 / 缺公网资源时由后端返回明确原因。
- Seedance 本地模型配置尝试切到标准 2.0；如果当前 key / 项目没有模型权限，会保留明确失败信息，不伪装成功。

### 验证结果

- `python3 -m py_compile 自动化产品/server/main.py 自动化产品/server/store.py` 通过。
- `node --check` 通过 `自动化产品/js/agent/orchestrator.js`、`自动化产品/js/views/chainWorkshop.js`、`自动化产品/js/api/providers.js`。
- `git diff --check` 通过本次修改的关键文件。
- 本地配置探针显示：Seedance 当前有 key，但当前 key / 项目对标准 Seedance 2.0 与 fast 接入点均未返回可用权限；OmniHuman 未配置火山智能视觉 AK/SK，因此无法完成真实出片。
- OmniHuman 缺配置路径已验证：后端会明确提示需要火山智能视觉 AK/SK，且说明 Ark API Key 不能直接调用该 CV 接口。

### 数据与部署

- 本次只修改本地代码和本地环境模型名，不执行服务器部署，不涉及服务器数据迁移。
- 后续部署时只更新代码和静态资源；不得覆盖线上数据库、上传目录、账号、资产库、发布清单、数据分析、草稿、成员数据、环境文件或认证缓存。
- 服务器若要跑 OmniHuman，必须配置火山智能视觉 AK/SK，并确保角色图和口播音频是上游可访问的公网 URL；本地 dataURL / localhost 资源不能直接提交给火山。
- 回滚方式：回退本次 `server/main.py` 的 OmniHuman CV 签名通道、`agent/orchestrator.js` 的数字人分段任务派发、`views/chainWorkshop.js` 的真实派发入口即可。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v43 - 2026-07-06

### 本版范围

- 视频生成后端默认模型切换为标准 Seedance 2.0：`doubao-seedance-2-0-260128`。
- 保留环境变量覆盖能力：服务器或本地如需使用 fast 版本，仍可通过 `SEEDANCE_MODEL / JIMENG_MODEL / ARK_VIDEO_MODEL` 指定。
- 本地 8787 以临时环境方式配置 Ark 视频网关，不把任何 API key 写入仓库、文档或提交。

### 验证结果

- `python3 -m py_compile 自动化产品/server/main.py 自动化产品/server/store.py` 通过。
- `node --check 自动化产品/js/views/chainWorkshop.js` 通过。
- `git diff --check` 通过本次涉及文件。
- 本地 8787 `/api/video/config` 显示视频 provider 为 Ark/Seedance，模型为标准 Seedance 2.0，网关可达。
- 通过平台自身 `/api/video/submit` 提交最小真实文生视频任务成功；后续轮询返回 `succeeded`，并拿到视频输出。

### 数据与部署

- 本次只修改本地代码与本地运行环境，不执行服务器部署，不涉及数据迁移。
- 后续部署时只需要更新代码并在服务器环境变量中配置视频 API key、Ark 官方 base URL、payload mode 和 Seedance 2.0 模型；不得覆盖线上数据库、上传目录、账号、资产库、发布清单、数据分析、草稿、成员数据、环境文件或认证缓存。
- 回滚方式：把服务端默认模型恢复到上一版默认值，或在运行环境中显式设置旧模型后重启服务。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v39 - 2026-07-03

### 本版范围

- 新增独立“语音生成”入口；页面收紧为单屏语音工作台，顶部小标签切换语音合成、音色设计和音色管理，不再做成长下滑页。
- 接入 MiniMax 音色设计服务端路由 `/api/tts/voice/design`，生成 `voice_id` 和试听音频；普通 TTS 继续走 `/api/tts/generate`。
- 新增统一音色库：我的音色、收藏音色、系统音色会在语音生成页、数字人口播声线选择、账号编辑固定声线中复用。
- 音色库卡片支持点击选择并试听；系统音色、收藏音色和我的音色共用 `/api/tts/generate` 试听链路，收藏 / 复制按钮不会误触试听。
- 新增 `voicePresets` 同步集合保存用户设计音色，按账号 `ownerId` 隔离；试听音频只保留在当前页面运行态，不作为长期服务器业务数据写入。
- 语言模型默认切换到 MiniMax-M3 的 OpenAI 兼容接口；MiniMax 不走 `response_format`，后端和前端都会清理模型可能返回的思考段。
- 语音生成页 UI 再收紧：顶部只保留克制毛边玻璃功能条，左侧音色库 / 中间文本输入 / 右侧调试台单屏布局；输入框支持粘贴，聚焦或有内容时隐藏打字提示，切换动效改为轻滑。
- 离线图文生成进一步放开：用户填写创作需求且不联网时，文案优先围绕用户需求展开，图片提示词再从文案标题、正文和 tag 提取内容；账号风格只决定视觉效果。

### 验证结果

- `python3 -m py_compile` 通过：`自动化产品/server/main.py`、`自动化产品/server/store.py`。
- `node --check` 通过：`voiceLab.js`、`voices.js`、`chainWorkshop.js`、`accountDialog.js`、`providers.js`、`ai.js`、`main.js`、`db.js`、`remote.js`、`store.js`。
- 本地 8787 验证通过：`/api/tts/config` 返回已配置，普通 `/api/tts/generate` 成功返回音频。
- 本地真实音色设计验证通过：`/api/tts/voice/design` 成功返回 `voice_id` 和试听音频。
- 本地 MiniMax-M3 验证通过：`/api/llm/config` 返回已配置，`/api/llm/test` 成功返回最小文本。
- 本地系统音色试听验证通过：`/api/tts/generate` 使用系统 voice_id 成功返回音频 data URL。
- 临时数据库验证通过：`voicePresets` 可写入，创作者只能读取自己的设计音色，其他成员不可见。
- Playwright 打开 `#/voice` 成功，语音生成入口、顶部功能标签、语音合成区、音色库区和调试区均渲染；未登录门禁态下仍可确认页面结构无白屏。
- `git diff --check` 通过，无空白格式错误。

### 数据与部署

- 本版涉及轻量数据结构扩展：前端 IndexedDB 版本从 3 升到 4，新增 `voicePresets`；服务端 `store.py` 新增同名集合和按账号隔离逻辑。
- 部署时只更新代码和静态资源并重启服务；不得覆盖服务器数据库、账号、资产库、发布清单、草稿、任务、成员、分析数据、上传目录、环境文件或认证缓存。
- 部署时服务器环境里的 `LLM_ENDPOINT / LLM_BASE_URL / LLM_API_KEY` 必须来自同一 MiniMax 网关；国内 key 通常应配 `https://api.minimaxi.com/v1/chat/completions`，不要和海外网关混用。
- 回滚方式：回退本次提交后重启服务；数据库中额外存在的 `voicePresets` 集合可保留，不影响旧版本读取其他业务数据。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v38 - 2026-07-03

### 本版范围

- 图文联网参考改为“参考驱动”：命中小红书参考后，标题和正文优先保留参考标题 / 摘要的选题关系、表达结构和语气节奏，只做必要的产品名弱化与产品能力校正。
- 参考中若是 `Obsidian+AI`、`AI办公`、`知识管理` 等泛称，改写结果可直接沿用；若参考中出现 `WorkBuddy+Obsidian` 等同类工具组合，默认弱化成 `AI+Obsidian`，避免硬塞自家产品名。
- 空创作内容随机从四方向里返回更宽的方向词，例如 `Codex 对比相关`、`Obsidian + AI 相关`、`周报效率相关`，不再随机出过细的长主题。
- 数字人口播分段改为尽量少切：目标约 27 秒一段，单段不超过 30 秒；只有长口播才会多切，不再硬按 18 秒拆。
- 数字人口播音频区 UI 收紧：声线选择 / voice_id 识别留在主控区域，收藏、固定到账号、生成分段口播等按钮移到右侧动作区。

### 验证结果

- `node --check` 通过：`自动化产品/js/data/xhsTrendLibrary.js`、`自动化产品/js/api/ai.js`、`自动化产品/js/views/chainWorkshop.js`、`自动化产品/js/views/chainBoards.js`、`自动化产品/js/agent/orchestrator.js`。
- Node 行为测试通过：`Obsidian+AI` 参考标题保留；`WorkBuddy+Obsidian` 被弱化为 `AI+Obsidian`；空创作内容只抽到四方向宽选题。
- `git diff --check` 通过，无空白格式错误。

### 数据与部署

- 本次只修改本地前端生成策略、UI 样式和文档记录，不涉及服务器数据迁移。
- 后续部署时只更新代码和静态资源；禁止覆盖线上数据库、上传目录、账号、资产库、发布清单、数据分析、草稿、成员数据、环境文件或认证缓存。
- 回滚方式：回退本次修改的 `xhsTrendLibrary.js`、`ai.js`、`chainWorkshop.js`、`views.css` 和文档记录，然后重新加载前端资源。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v37 - 2026-07-03

### 本版范围

- 数字人/真人视频随机创作内容改为继续走固定四方向选题库，避免回到自由随机主题。
- 数字人口播脚本、发布文案、TTS 合成前统一清洗 `{happy}`、`{/happy}`、`(clear-throat)` 等情绪/音效标记，避免传给上游造成错乱。
- 数字人分段从接近 30 秒改为约 18 秒以内，增加切口数量，便于后续分段生成。
- 口播草稿编辑框改为自动同步；复制、生成音频、生成提示词、下一步前都会先读取当前编辑内容，不再需要“应用口播”按钮。
- 声线选择从原生下拉改为克制毛玻璃面板；收藏声线置顶显示，固定到账号后显示“已锁定”。
- 声线 ID 识别不再自动写入账号，必须点击“固定到账号”才改变账号固定声线。
- 视频发布标题和简介强化为根据口播总结，标题偏“上手教程 / 零门槛 / 一篇讲清楚”这类网感结构，避免不明所以。

### 验证结果

- `node --check` 通过：`xhsGuard.js`、`providers.js`、`ai.js`、`chainWorkshop.js`。
- 文本清洗测试通过：`{happy}`、`{/happy}`、`(clear-throat)` 等标记会在进入文案/TTS 前移除。
- 四方向选题库测试通过：视频随机创作内容仍从固定方向库返回。
- `git diff --check` 通过，无空白格式错误。
- 本地 8787 健康检查通过；Playwright 打开 `#/studio/workshop` 成功，未登录门禁态下页面无白屏，控制台无业务 JS 报错。

### 注意

- 本版仅修改本地功能和 UI，不执行服务器部署，不涉及服务器业务数据迁移。
- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v30 - 2026-07-01

### 本版范围

- 修复共享模式刷新同步：请求禁用缓存，登录/续登刷新以服务器快照为权威源，发布后立即持久化并写穿透。
- 发布清单创作者端和供应商端均展示“内容账号 / 发布者”，交付资产记录发布成员。
- 管理员、创作者的单号创作、批量创作、会话和草稿箱按本人隔离；发布清单、整体资产、数据分析仍共享已发布/共享数据。
- 数据分析移除模拟指标，真实采集未配置或失败时展示真实失败原因。
- 联网参考接入单号和批量图文改写链路，保存热门参考标题/文案/tag，并在图文创作台展示“热门参考 / 改写结果”左右卡。
- 图文生成链路只使用创作内容、联网结果、产品信息和账号创作风格；站外生成、站外提示词和旧站外字段不再新建或展示。
- 图片发布前精修改为同尺寸轻量 canvas 重绘，不裁剪、不扩图、不叠装饰，尽量保护中文清晰度。
- 登录页背景切换为星阵登录背景视频，保留音轨；移除旧登录 logo；favicon 改为新 PNG，静态资源禁用缓存。
- 部署脚本和 Docker 构建保护服务器业务数据：运行数据排除构建，启动前生成备份，容器运行数据落持久卷。

### 验证结果

- 全量 `node --check` 通过：`自动化产品/js` 下所有 JS 文件。
- `python3 -m py_compile` 通过：`server/main.py`、`server/store.py`。
- `bash -n` 通过：`deploy/start_server.sh`、`deploy/stop_server.sh`、`deploy/status_server.sh`。
- 临时数据库验证通过：管理员/创作者只看本人未发布任务，他人已发布内容和对应任务共享可见。
- 本地 API 验证通过：数据分析 resolve 返回真实 URL 解析；未配置真实采集服务时 fetch 返回明确 503 失败原因。
- 浏览器验证通过：登录页背景视频加载完成、未静音、favicon 指向新 PNG、旧登录 logo 不存在，控制台无错误。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP 或账号凭据。
- 本版为本地未提交改动；尚未创建提交或推送分支。

## v20 - 2026-06-30

### 本版范围

- 批量量产任务板的手动账号池改为完整账号矩阵，显示 80 个账号：50 个小红书图文账号 + 30 个视频号账号。
- 默认量产计划保留 `all` 账号范围；只有用户明确说“图文号 / 视频号 / 素材号 / 真人号”时才按类型过滤。
- 量产账号列表序号按账号创建顺序生成，便于“最后10个账号 / #41 到 #50”等表达；新建账号会按追加顺序继续编号。
- 单号创作左侧账号矩阵用全局序号替代圆点，保留细色条作为账号识别点，和批量编号保持一致。
- 批量账号行重新对齐：产品、每号条数、每条图数、创作内容、定制参考图和上传按钮使用稳定网格，减少参差和挤压。

### 验证结果

- `node --check` 通过：`cards.js`、`orchestrator.js`、`main.js`。
- 账号种子验证通过：总计 80 个账号，其中 50 个小红书图文账号、30 个视频号账号。
- 新计划卡渲染验证通过：批量账号按钮输出 80 个，编号从 `#01` 到 `#80`，并包含视频号账号。
- 浏览器只读验证：`#/agent` 正常打开、非白屏；当前 in-app browser 为未登录 `body.gated` 状态，单号左侧真实点击和侧栏渲染需在已登录浏览器继续看。
- `git diff --check` 通过，无空白格式错误。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- `main.js` 中存在本轮前已有的本地未提交启动逻辑改动，本次提交只应包含账号编号相关 hunk，不要误把无关改动一起提交。

## v1 - 2026-06-28

### 本版范围

- 恢复批量创作为量产计划面板，修复中文批量意图误进聊天问答的问题。
- 批量参考图支持统一最多 5 张、每账号定制最多 3 张，并在站内图片生成时合并传入。
- 图片工坊回归站内生成优先，支持无参考图、多参考图、真实 loading 和错误、3:4 占位。
- 发布清单增加产品标签与产品列，发布命名保留平台、账号、内容类型和序号。
- 数字人 / Seedance 工坊模式可切换，数字人模式隐藏旧分镜上传链路。
- 登录页加入星阵动画，已登录刷新不闪登录页。
- 增加前端语言模型请求超时兜底，避免批量起草被慢请求挂住。

### 验证结果

- 页面可打开，无白屏。
- 30 条中文批量意图回归通过。
- 浏览器中新建“创作两个图文号”直接生成量产计划。
- 浏览器确认批量执行后，2 个图文账号共 12 张站内图片生成完成并进入待发布。
- `/api/image/generate` 文生图成功。
- `/api/image/generate` 使用 2 张参考图成功，参考图被服务端接收。
- 发布清单展示产品标签。
- 数字人工坊显示数字人 / Seedance 切换，数字人模式不显示旧分镜图上传链路。
- 已登录刷新不显示登录页闪屏。

### 注意

- 本版不包含任何密钥、服务器密码或公网 IP。

## v2 - 2026-06-28

### 本版范围

- 批量创作改为量产任务板优先：空会话直接出现待确认任务板，不再进入欢迎聊天页。
- 移除批量创作输入框上方的“查看状态 / 全部生成 / 全部交付”三个快捷标签。
- 批量意图识别增强：支持“久未发布/低活跃”排序、账号数、每号内容数和总量计算，例如 3 个账号每号 3 条会落为 9 条任务。
- 批量执行改为按“账号数 × 每号条数”创建生产任务。
- 首页“待你处理”列表行高和文本布局修复，避免标题、账号信息和状态标签重叠。
- Project Memory 更新为百度智能云 BCC 已创建后的非敏感部署准备；不记录公网 IP、私网 IP、实例名或密码。

### 验证结果

- `node --check` 通过：`intent.js`、`orchestrator.js`、`cards.js`、`view.js`。
- 30 条中文批量生产意图回归通过，覆盖图文/素材/真人、账号数量、每号数量、久未发布排序和复杂表达。
- 浏览器验证页面正常打开、无白屏；首页 17 条待办 DOM 几何检查无重叠。
- 新建量产会话直接出现待确认任务板，0 个用户聊天气泡，三个旧快捷标签不存在。
- 复杂指令“选择3个很久没发布内容的图文账号每一个创作3条内容”落成 3 个账号 × 每号 3 条 = 9 条。
- `/api/image/generate` 文生图成功返回 PNG。
- `/api/image/generate` 带 2 张有效参考图成功返回 PNG；无效参考图会显示真实解码错误。
- 最小批量图片实跑 1 个图文账号 × 1 条，服务端状态确认 6/6 成图并进入待审。

### 注意

- 本版不包含任何密钥、服务器密码或公网 IP。
- GitHub 推送如仍失败，需要在本机补齐 GitHub 认证后再推送分支。

## v3 - 2026-06-28

### 本版范围

- 新建量产会话后，消息区固定停在任务板顶部，避免打开后落在长卡片底部。
- 单号行增加“本号条数”，支持每个账号单独调整发布条数；总条数和确认按钮实时同步。
- 统一参考图和定制参考图改版：去掉原生多选框，改为“已选参考图 / 拖入图片 / 打开资产库”三块独立区域。
- 资产选择改为 920px 大弹窗，展示图片缩略图、名称、标签和已选状态，确认后写回计划卡。
- 单号定制参考图同样支持独立资产弹窗和独立拖入 / 上传区域。

### 验证结果

- `node --check` 通过：`cards.js`、`view.js`、`orchestrator.js`。
- 浏览器中新建量产后 `#agwMsgs.scrollTop = 0`，任务板在顶部可见。
- 单个账号“本号条数”改为 3 后，总量从 3 条变为 5 条，确认按钮同步显示 5 条。
- 资产库弹窗打开成功，宽度 920px，展示 149 张图片卡片，首张包含真实缩略图。
- 选择 2 张统一参考图后写回计划卡；定制参考图区域存在 3 个资产选择按钮、3 个拖入区域。

### 注意

- 本版不包含任何密钥、服务器密码或公网 IP。

## v4 - 2026-06-28

### 本版范围

- 登录页、浏览器 favicon、侧栏入口小标统一替换为用户提供的星阵单独 logo。
- 登录页 logo 放大，避免品牌视觉显得小。
- 新建量产任务板默认不再自动选择账号，进入时为 0 个账号待选择。
- 量产任务板增加“随机选 ≤10”按钮，按当前筛选条件随机选择最多 10 个账号。
- 单号明细排版收紧：定制参考图移到第二行，避免上传按钮和资产选择挤出卡片。
- 前端资源版本号更新，避免浏览器继续使用旧缓存。

### 验证结果

- `node --check` 通过：`orchestrator.js`、`cards.js`、`view.js`、`icons.js`。
- 浏览器验证页面正常打开，无白屏。
- 新建量产后默认选中账号数为 0，确认按钮显示 0 条。
- 点击“随机选 ≤10”后选中 10 个账号，确认按钮同步显示 10 条。
- 1280px 视口、任务卡 564px 宽度下，10 条单号明细无横向溢出。
- favicon、侧栏小标、登录页 logo 均使用 `logo.png`；登录页 logo 宽度为 560px。

### 注意

- 本版不包含任何密钥、服务器密码或公网 IP。
- GitHub 推送仍需要完成本机授权。

## v5 - 2026-06-28

### 本版范围

- 浏览器 favicon 和侧栏入口小标改用用户提供的透明星标图。
- 登录页保留裁剪后的完整横向星阵 logo。
- “每号内容数”移动到“随机选 ≤10”骰子按钮旁边，移除单号明细中的独立条数列。
- 单号明细改成严格对齐的三列主行和三列参考图行。
- 统一产品框、内容框、资产选择按钮和拖入上传按钮的对齐与高度。

### 验证结果

- `node --check` 通过：`orchestrator.js`、`cards.js`、`view.js`、`icons.js`。
- 浏览器验证 `agent.css?v=20260628-xz6` 已加载。
- 10 个随机账号下，产品框与内容框顶边差 0px、高度差 0px。
- 10 个随机账号下，“从资产选择”和“拖入 / 上传”按钮顶边差 0px、高度差 0px。
- 10 条单号明细无横向溢出。
- favicon 与侧栏小标均使用 `assets/brand/xingzhen-icon.png`。

### 注意

- 本版不包含任何密钥、服务器密码或公网 IP。

## v6 - 2026-06-28

### 本版范围

- 修复批量创作停留一段时间后，被后台批量图文生成状态自动带到单号图片工坊的问题。
- 路由层增加批量工作台保护：从 `agent` 自动进入 `studio` 会被拦截回 `#/agent`。
- 明确手动入口仍可进入单号工坊：侧栏“单号创作”、账号入口、抽屉“进入单号工坊微调”会短暂放行。
- 批量确认执行前清理 `activeProductionId` 和 `returnTo`，确认后继续留在量产任务板。
- 从批量页打开单条任务抽屉后，进入单号工坊前增加二次确认。
- Project Memory 记录“批量创作自动跳单号工坊”作为后续避坑项。

### 验证结果

- `node --check` 通过：`router.js`、`main.js`、`view.js`、`prodDrawer.js`。
- `/api/health` 返回 ok，本地共享后端仍在 `8787` 运行。
- `/api/image/config` 返回 configured/reachable，模型为 `custom-imagemodel-gt`。
- 浏览器实测从 `#/agent` 强行跳 `#/studio/images` 会被拦回 `#/agent`，量产任务板仍存在，未出现图片工坊。
- 浏览器实测手动触发“单号创作”入口仍能进入 `#/studio`，没有误伤正常入口。
- 路由保护逻辑已覆盖 `go("studio")` 和直接 hash 跳转两类自动入口。

### 注意

- 本版不包含任何密钥、服务器密码或公网 IP。

## v7 - 2026-06-28

### 本版范围

- 账号编辑弹窗删除“账号标签”选择区，减少量产配置里的自由标签干扰。
- 从飞书“全部账号风格”整理出 80 个账号风格种子：50 个小红书图文账号、19 个视频号数字人账号、11 个视频号素材口播账号。
- 小红书账号补齐简洁账号定位、差异化图片风格和固定图文提示词模板。
- 视频号账号补齐口播节奏、语气、说话习惯和声线字段。
- 图片提示词统一为“参考图 + 账号定位 + 图片风格 + 图片具体内容 + 负面约束”的结构。
- 发布清单命名补强：产品标签自动显示并插入日期前，历史交付记录启动时静默补齐产品标签。
- 共享后端账号风格种子改为分片 upsert，避免合法新增 30 个视频号时触发旧缓存回推保护。

### 验证结果

- `node --check` 通过：`main.js`、`accountDialog.js`、`delivery.js`、`deliveryView.js`、`ai.js`、`prompts.js`、`accountProfilesSeed.js`。
- 账号风格种子统计通过：共 80 个账号，其中小红书图文 50 个、视频号数字人 19 个、视频号素材口播 11 个。
- 浏览器验证首页、批量创作、发布清单正常打开，无白屏；重新打开后无 console error。
- 服务端快照验证：账号总数 83 个，视频号 31 个，小红书 52 个，新视频号口播风格字段已落库。
- 账号弹窗验证：保留“账号定位 / 创作风格”，删除“账号标签 / Agent 量产按标签选号”。
- 发布清单验证：历史交付命名已显示 `...-百度搭子-日期.zip`，产品标签可见。
- 新建量产验证：默认命中 0 个账号、确认执行 0 条、随机选 ≤10 按钮存在、任务板滚动在顶部、无横向溢出。
- `/api/image/generate` 文生图成功：`custom-imagemodel-gt`、3:4、无参考图返回图片。
- `/api/image/generate` 参考图成功：传入 1 张本地参考图，`usedRefs=1`，返回图片。
- 最小批量图片实跑成功：1 个图文账号 × 1 条，站内图片生成 6/6，任务进入待审核。

### 注意

- 本版不包含任何密钥、服务器密码或公网 IP。

## v8 - 2026-06-28

### 本版范围

- 修复图文图片提示词重复：清洗旧模板外壳，避免“账号定位：账号定位”和“图片具体内容”里重复整段生成结构。
- 图文提示词内容更聚焦：第一张优先使用本次主题作大标题，内容描述明确办公资料、操作动作、结果界面三层信息。
- 账号风格种子升级为 `20260628-v8b`：固定 50 个小红书图文账号 + 30 个视频号账号。
- 清理非种子账号和重复账号，视频号只保留飞书表格里的 30 个，不再被旧缓存膨胀到 60 个。
- 50 个图文账号扩展为 20 类差异化视觉方向，覆盖文档截图、Agent 架构、日报周报、评分卡、简笔画故事、项目看板、数据仪表盘等。
- `imagePromptTemplate` 改为账号图文母版，不再存最终图片 prompt 成品。
- 清理种子中的 emoji 和 Unicode 代理字符，避免后端账号 upsert 误报“未知集合”。

### 验证结果

- `node --check` 通过：`ai.js`、`main.js`、`accountProfilesSeed.js`。
- 坏样例 prompt 验证通过：不再重复“账号定位”，不再在“图片具体内容”里嵌套第二段“生成小红书笔记风格”。
- 浏览器验证首页和批量创作页正常打开，无白屏。
- 共享状态验证：账号总数 80；小红书图文 50；视频号数字人 19；视频号素材 11；旧演示账号已清理。
- v8b 账号分片同步请求全部 200，未再出现修复后的 `/api/db/accounts` 400。
- `/api/image/generate` 文生图成功：`custom-imagemodel-gt`、3:4、无参考图返回图片。
- `/api/image/generate` 参考图成功：传入 1 张本地参考图，`usedRefs=1`，返回图片。
- 最小批量图片实跑成功：1 个图文账号 × 1 条，站内图片生成 6/6，无错误，任务进入 review。

### 注意

- 本版不包含任何密钥、服务器密码或公网 IP。
- BCC 部署信息以 `Project Memory.md` 第 4 节为准。

## v9 - 2026-06-28

### 本版范围

- 50 个小红书图文账号全部改为统一格式：`账号定位：类型；人设/视角；读者情绪。`
- 50 个小红书图文账号全部改为统一格式：`整体风格：主风格为主、辅风格为辅；配色；字体气质；版式；信息结构；可读性约束。`
- 图文风格从单纯换色扩展到字体、封面结构、内页叙事、数据结构和视觉元素差异。
- 固定 10 个账号为简笔画 / 火柴人组图风，覆盖管理夹、猫系打工人、课代表、工具整理、钻研、每日学习、灵感、加油、反内卷、聊天办事等人设。
- 图文母版保留 3:4、参考图继承、重写标题/标签/界面文字/数据、禁止内部词等约束。
- 底层提示词清洗增加 `整体风格` / `图片风格` 前缀剥离，避免 UI 字段格式进入最终 prompt 后重复成“图片风格：整体风格”。
- 量产任务板重渲染改用安全节点替换，避免输入 / blur 竞态导致 `replaceWith` 报错。
- Project Memory 增加账号风格种子的后续维护规则。

### 验证结果

- `node --check` 通过：`ai.js`、`view.js`、`accountProfilesSeed.js`。
- 账号风格种子统计通过：共 80 个账号，其中小红书图文 50 个、视频号 30 个。
- 50 个图文账号定位均以 `账号定位：` 开头，50 个图文风格均以 `整体风格：` 开头。
- 简笔画 / 火柴人图文账号数量校验为 10 个。
- 重复前缀校验通过：未发现 `账号定位：账号定位`、`整体风格：整体风格`、`图片风格：整体风格`。

### 注意

- 本版不包含任何密钥、服务器密码或公网 IP。

## v10 - 2026-06-28

### 本版范围

- 修复图文图片提示词把“种草 / 痛点 / 共鸣 / 构图 / 封面 / 首图 / 步骤一”等定位词写进正向 prompt 或图片标题的问题。
- 图片 prompt 改为描述具体功能、执行动作和可复用结果，例如自动归类、字段识别、报告可用，避免空泛标签进入画面。
- 批量创作和单号图片工坊的图片标题不再回退脚本 `idea`，减少“构图 / 步骤”等内部词污染预览标题。
- 服务端图片 API guard 同步扩展，站内生成前会再次拦截内部结构词和定位词。
- 图片精修角落矢量装饰改为随机 0-2 个角，避免每张图四角都出现括号。

### 验证结果

- `node --check` 通过：`ai.js`、`orchestrator.js`、`chainBoards.js`、`assets.js`。
- `python3 -m py_compile` 通过：`server/main.py`。
- 真实语言模型代理三轮提示词测试通过：3 个不同图文账号，每轮 6 张，共 18 条图片 prompt；正向 prompt 不含“种草 / 痛点 / 共鸣 / 构图 / 封面 / 首图 / 步骤一”等定位词。
- 三轮测试均确认图片 prompt 带有“角落装饰最多 1-2 个角 / 不要四角都画括号”的约束。
- 浏览器打开 `http://localhost:8787/#/agent` 正常显示批量任务板，无白屏，无本次改动相关 console error。

### 注意

- 本版不包含任何密钥、服务器密码或公网 IP。

## v11 - 2026-06-29

### 本版范围

- 图文账号生成逻辑不再使用账号定位干预内容方向；图文图片 prompt、图文脚本和图文发布文案只参考本次创作内容、产品功能和账号创作风格。
- 单号账号主页的图文账号卡片展示“创作风格”，不再在主视觉位置展示“账号定位”。
- 图文图片 prompt 移除 `【账号定位】` 段，最终结构统一为参考图说明 + `【图片风格】` + `图片具体内容` + 最小负面约束。
- 图文最终负面约束收敛为：不出现页码、不出现二维码、图片右上角和左上角不要加入 logo，其他位置可以正常出现 logo。
- 参考图说明会插入到负面约束之前，避免服务端 guard 清洗负面约束时误删参考图说明。
- 图片精修角落装饰只保留在发布前图片处理层，不再写进图片生成提示词。
- 修复图片工坊拖入/选择参考图触发重绘时，已填写的创作内容被清空的问题。
- 发布弹窗和 `deliver()` 双层要求计划发布时间必填，不填写不能发布。

### 验证结果

- `node --check` 通过：`ai.js`、`prompts.js`、`chainBoards.js`、`orchestrator.js`、`studio.js`、`delivery.js`、`components.js`、`prodDrawer.js`。
- `python3 -m py_compile` 通过：`server/main.py`。
- Node 三轮图文图片 prompt 验证通过：无大段重复、无 `【账号定位】`、无角落装饰提示、无旧长负面约束，最终负面约束只出现 1 次。
- 站外整段图文提示词验证通过：不含账号定位、角落装饰、旧长负面词。
- 浏览器验证 `http://127.0.0.1:8787/#/agent` / `#/studio` 正常打开，无白屏，无 console error。
- 浏览器验证图文账号主页显示“创作风格”。
- 浏览器验证发布弹窗不填计划发布时间时保持打开、聚焦时间输入框并提示错误。
- 浏览器离屏组件验证：图片工坊创作内容输入后触发重绘仍保留，不会因参考图/模式切换类重绘丢失。

### 注意

- 本版不包含任何密钥、服务器密码或公网 IP。

## v12 - 2026-06-29

### 本版范围

- 新增产品知识库种子：我们的产品为 `Dumate / 百度搭子`、`百度秒哒`；竞品 / 同类产品为 OpenClaw、Codex、Claude Code、Cursor、Windsurf、GitHub Copilot、TRAE、Obsidian、Manus、WorkBuddy。
- 百度秒哒用户可见显示只保留中文名和短名“秒哒”，不显示英文名。
- 图文、视频脚本、文案、随机选题接入产品知识库，选题从 AI 博主视角出发，可做教程、对比、测评、工具分工和合集，不再只硬讲单个产品。
- 产品库同步采用 merge 方式，保留同 id 产品的用户编辑；设置导入导出加入 `products`。
- 非 Dumate 产品不再注入 Dumate 产品事实；旧视频框架里的 Dumate 固定文案改为“本次产品”。
- 随机选题增加当前产品锁定和能力边界纠偏，防止账号旧名称 / 历史主题把当前产品拉回 Dumate。
- 百度秒哒选题限制在无代码应用生成、H5 / 页面、原型、小工具、数据表 / 后台等方向，不再误写成文件整理、桌面自动操作、PDF/Word/Excel 转格式、会议纪要等 Dumate 能力。
- 更新项目记忆：服务器 Key 由部署线程直接写入服务器私有配置；后续更多 Key 等用户补齐后继续接入；更新版本不能覆盖线上账号数据和产品库数据。

### 验证结果

- `node --check` 通过：`productCatalogSeed.js`、`store.js`、`ai.js`、`prompts.js`、`settings.js`、`orchestrator.js`、`chainScript.js`、`chainBoards.js`、`chainWorkshop.js`、`chainPrompts.js`、`chainCopy.js`。
- 产品库合并测试通过：共 12 个产品；我们的产品包含 Dumate / 百度搭子、百度秒哒；百度秒哒展示文案不含英文名；merge 会保留用户编辑并补齐种子字段。
- 硬编码扫描通过：未发现旧 Dumate 固定视频文案、旧 Dumate 品牌标识文案、旧 Dumate 标题兜底和百度秒哒英文名。
- 浏览器打开 `http://127.0.0.1:8787/?v=20260629-product-db-final#/agent` 正常显示批量任务板，无白屏，刷新后 console error 为 0。
- 浏览器验证产品下拉包含“秒哒”，页面正文不展示百度秒哒英文名。
- 真实 LLM 三轮“百度秒哒”随机选题验证通过：返回无代码 / 数据看板 / 原型方向，无 Dumate、百度搭子、文件整理、PDF/Word/Excel 等错产品或错能力污染。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。


- 服务器部署仍以百度智能云 BCC 为准；生产 Key 只进入服务器环境变量 / 私有配置，不进入仓库、回复或文档。
- 后续线上更新必须保护服务器已有账号数据、产品库数据、供应商数据、素材和发布清单，种子同步只做 merge / 补齐。

## v13 - 2026-06-29

### 本版范围

- 宣传产品下拉只保留百度主产品：`Dumate / 百度搭子`、`百度秒哒`。
- 竞品 / 同类产品不再作为主宣传产品可选项，只作为产品知识库里的对比、组合、分工和提示词参考对象。
- 量产任务板、图片工坊、脚本页、分镜工坊统一使用主产品列表；旧会话残留竞品 `productId` 时，渲染和批量执行都会收敛回百度主产品。
- 图片工坊“生成图卡结构与提示词”改成先补全创作内容 brief，再基于 brief 生成图卡结构和图片提示词。
- 用户未填写创作内容时，系统会主动带 1-2 个竞品或互补工具做对比 / 组合 / 分工 / 妙用科普，例如 Obsidian + 百度搭子、Manus 与百度搭子的任务边界。
- 用户已填写明确创作方向时，优先服从用户方向；如果方向里提到竞品 / 同类产品，模型会识别其功能点，再和当前主产品做合理关系，不把竞品能力写成主产品能力。
- 创作 brief 截断按标点收尾，避免半句话。

### 验证结果

- `node --check` 通过：`ai.js`、`store.js`、`productCatalogSeed.js`、`cards.js`、`orchestrator.js`、`chainScript.js`、`chainBoards.js`、`chainWorkshop.js`。
- `git diff --check` 通过。
- 浏览器验证 `#/agent` 正常打开，无白屏。
- 浏览器验证主产品下拉只显示 `Dumate`、`秒哒`，未出现竞品。
- 真实 LLM 空内容链路验证通过：先生成 Dumate 创作 brief，主动带 Manus 对比；再生成 6 张图卡结构和 6 条图片提示词，提示词保留对比关系，未串到秒哒。
- 真实 LLM 明确方向链路验证通过：用户输入 `Obsidian + 百度搭子` 后，图卡结构和图片提示词均识别 Obsidian 的知识库 / 资料索引职责与百度搭子的本地文件 / 提取字段 / 周报职责，未串到秒哒。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 竞品数据库仍在产品知识库中，后续不要从种子里删掉；只是不进入“宣传产品”主选项。

## v14 - 2026-06-29

### 本版范围

- 修复“创作内容已写 Dumate vs Manus，但图片 prompt 又退回孤立宣传 Dumate”的问题。
- 最终图片 prompt 会从创作内容、脚本和单张图卡里识别竞品 / 互补工具，并把对比、组合或分工关系写进每张图的画面信息结构。
- 竞品能力只作为参照对象一侧呈现，主产品能力放在主产品一侧，避免把 Manus / Obsidian 等能力误写成 Dumate 能力。
- 测评 / 对比 / 工具选择类选题改为“适合谁 / 不适合谁 / 任务边界 / 真实证据 / 组合方式”，不再生成分数、星级、排名、打分表或评分卡。
- 最终图片 prompt 里的关系锚点改成正向表达，避免把“不要 / 不能 / 不得 / 禁止”等限制词塞进图像模型提示词。
- WorkBuddy 产品库视觉角度从“多产品评分卡”改为“多产品边界对照卡”。
- Project Memory 记录本地 `API 未通 (Failed to fetch)` 的排查顺序：先确认 8787 共享后端是否运行，再查 Key。

### 验证结果

- `node --check` 通过：`ai.js`、`productCatalogSeed.js`。
- `git diff --check` 通过。
- 本地共享后端已重新启动，`/api/health` 返回语言模型已配置，`/api/image/config` 返回 image-2 configured/reachable，`/api/tts/config` 返回 MiniMax configured/reachable。
- 浏览器打开 `http://127.0.0.1:8787/#/agent` 正常显示量产任务板，无白屏；console 只有浏览器密码框提示，无业务错误。
- 真实 LLM 验证 6 张 Dumate vs Manus 图片 prompt：6/6 均保留 Manus 对比 / 分工关系，未出现评分、打分、星级、排行榜、分数。
- 真实 LLM 精简复测 3 张 prompt：3/3 均保留 Manus；剔除固定负面约束后未出现“不要 / 不能 / 不得 / 禁止”；最终负面约束每张只出现 1 次。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 本地 API 未通时，通常是 `start.command` 启动的 8787 后端进程停了；重启后语言模型、图片、语音会一起恢复。

## v15 - 2026-06-29

### 本版范围

- 修复发布清单供应商视角表格右侧“下载 / 回传链接”按钮错位的问题。
- 撤掉横向滚动条兜底，改为固定表格布局：素材名、账号名、标签自动省略，操作列固定宽度。
- 标签列默认只展示前 2 个关键标签，剩余用 `+N` 收纳；悬停标签区域显示完整标签列表。
- “图文”等形式列不再被挤成竖排，状态列和操作按钮列保持同一行对齐。
- 前端资源版本号更新到 `20260629-v15`，避免浏览器继续使用旧 CSS。
- Project Memory 记录供应商表格布局避坑。

### 验证结果

- `node --check` 通过：`deliveryView.js`。
- `git diff --check` 通过。
- 浏览器打开 `http://127.0.0.1:8787/#/delivery` 正常，无白屏。
- 离屏供应商表格几何验证通过：表格无横向滚动，下载和回传链接按钮在同一行，标签显示为少量标签 + `+N`，悬停 title 保留完整标签。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。

## v16 - 2026-06-29

### 本版范围

- 用户可见产品名称统一为“百度搭子”，不再在图文提示词、口播脚本、发布文案、产品下拉、账号名和旧缓存展示里出现英文旧名。
- 内部 `productId` / 数据库 key 仍保留稳定 id，避免破坏历史任务、产品库、账号和服务器数据关联。
- 产品库 merge 增加旧缓存清洗：历史 `name` / `shortName` / 选题角度里的英文旧名会自动转成“百度搭子”。
- 状态装载层增加可见字段清洗：旧 IndexedDB 或服务端快照里的账号名、标题、文案、提示词、通知、发布素材名会自动转中文；ID、URL、密钥、dataUrl 等内部或敏感字段不处理。
- 小红书合规清洗层同步处理产品名，模型返回的图文 prompt、文案和口播脚本会再次过一遍中文化。
- 定稿发布弹窗从“日期+时间”改为“日期”，默认填入今天；直接点击定稿发布时会使用当天日期。
- 发布交付入口增加日期兜底，即使旧入口未传日期，也会自动使用当天日期。

### 验证结果

- `node --check` 通过：`store.js`、`util.js`、`xhsGuard.js`、`productCatalogSeed.js`、`prompts.js`、`ai.js`、`delivery.js`、`components.js`、`main.js`、`settings.js`、`chainScript.js`、`accountDialog.js`。
- `git diff --check` 通过。
- `/api/health` 本地返回正常，语言模型配置已接通。
- 真实 LLM 链路验证：旧英文输入和旧产品缓存进入后，生成 brief、3 张图片 prompt、发布文案里均无英文旧名，保留“百度搭子”和 Manus 分工关系。
- 图片 prompt 固定负面约束仍为：不出现页码、不出现二维码、图片右上角和左上角不要加入 logo，其他位置可以正常出现 logo。
- 发布默认日期验证：不传计划日期时自动写入 `2026-06-29`，发布素材命名和标签均含“百度搭子”。
- 浏览器验证 `http://127.0.0.1:8787/?v=20260629-v16b#/agent` 正常打开，无白屏；产品下拉显示“百度搭子 / 秒哒”；页面可见文本不再出现英文旧名；未发现 `datetime-local` 时间输入。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 以后不要为了“全中文展示”重命名内部 id；只清洗用户可见字段，否则会破坏已有 IndexedDB / 服务器数据关联。
- 旧浏览器缓存可能保存历史账号名或任务标题，必须依赖状态装载清洗，而不是只改种子数据。

## v17 - 2026-06-29

### 本版范围

- 发布清单回传链接增加“供应商备注”字段：供应商可选填备注，创作者可在首页最新交付和发布清单详情查看。
- 下载交付包的 `标题文案.txt` 增加供应商回传备注和发布链接，便于创作者复盘供应商发布差异。
- 供应商端按钮文案调整为“批量下载未下载”，沿用当前筛选/勾选范围打包下载并标记已下载。
- 发布清单创作者视角增加“回撤删除”：创作者只能删除自己发布的内容，管理员可以删除所有内容；删除前必须经过两级确认。
- 回撤删除只删除发布清单交付包记录和对应数据分析链接，保留原始账号素材；相关 production 退回审核态，方便重新定稿发布。
- 单张“生成此图”只处理当前槽位；如果该槽位没有提示词，会提示先生成图卡结构，不再暗中生成整套图卡。
- 站内图片后台生成完成后只保存结果；如果用户已经切到其他账号或其他页面，不再重绘并把页面自动跳回当前工坊。
- 图文图片提示词升级为“先总结成信息节拍，再分布到每张图”：每张图只承载一个核心观点/动作/证据，避免长创作内容被全部塞入每张图。
- 火柴人 / 简笔画 / 漫画类账号自动走轻文字图解分支，用小人动作、表情、箭头、气泡讲解，减少表格和长文案密度。
- 入口资源版本号更新到 `20260629-v17`，避免浏览器继续使用旧 CSS/JS。

### 验证结果

- `node --check` 通过：`components.js`、`deliveryView.js`、`delivery.js`、`overview.js`、`chainBoards.js`、`ai.js`。
- `git diff --check` 通过。
- 删除权限单元验证通过：非本人创作者不可删，本人创作者可删，管理员可删；删除后交付资产和分析链接移除，production 退回 `review/pending`，账号月交付数回退。
- 图文 prompt 小样本验证通过：6 张火柴人风格图平均约 274 字，无“种草 / 痛点 / 共鸣 / 构图 / 封面 / 步骤一 / 评分 / 打分 / 星级 / 排行榜 / 分数”等内部或测评词，6/6 保留 Manus 对比/分工关系。
- 本地 8787 已启动，`/api/health` 返回语言模型已配置，`/api/image/config` 返回 image-2 configured/reachable，`/api/tts/config` 返回 MiniMax configured/reachable。
- 浏览器打开 `http://127.0.0.1:8787/?v=20260629-v17#/delivery` 正常，无白屏；入口加载 `views.css?v=20260629-v17`；console 无业务错误。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 删除发布清单记录不是删除原始图片/视频资产；后续如要做“彻底删除素材”，必须另做显式入口和权限确认。

## v18 - 2026-06-30

### 本版范围

- 小红书图文生产默认张数统一改为 4 张：图片工坊、旧脚本页入口、AI 默认参数和本地兜底都同步调整。
- 修复单张“生成此图”被旧全量队列污染的问题：点单张会取消上一轮“一键生成全部图片”队列，其他未完成槽位不再继续 loading 或被后台写入。
- 发布清单回撤增加下载限制：供应商已下载或已回传发布链接的内容不能回撤；按钮保留可见但禁用，显示“已下载不可回撤”等原因。
- 图文提示词继续强化 AI 博主内容思维：主题或脚本里提到 Obsidian、Manus、WorkBuddy 等工具时，会从产品库带出具体能力，并写成组合流程、功能边界或对比卡，而不是只写“作参照”。
- 本地回退模板也识别竞品 / 互补工具关系：例如 Obsidian + 百度搭子会生成“知识沉淀 + 桌面执行”的分工图卡。

### 验证结果

- `node --check` 通过：`chainBoards.js`、`chainScript.js`、`ai.js`、`delivery.js`、`deliveryView.js`。
- `/api/health` 本地返回语言模型已配置；`/api/image/config` 返回 image-2 configured/reachable。
- Node 生成测试通过：未显式传张数时默认生成 4 张；Obsidian + 百度搭子主题的图片 prompt 保留 Obsidian 知识库能力和百度搭子执行/输出分工；未出现评分、打分、星级、排行榜。
- 回撤权限测试通过：未下载内容可回撤；已下载内容不可回撤并返回“供应商已下载，无法回撤”；已回传发布链接内容不可回撤。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 本地 8787 后端需要保持运行；如果 UI 再提示 API 未通，先检查服务进程而不是先怀疑 Key。

## v19 - 2026-06-30

### 本版范围

- 批量创作支持“最后10个图文号 / 倒数十个图文账号 / 前5个素材号”等范围选号，按当前分组和排序后的账号池取前后范围。
- 量产账号列表增加序号显示，序号按当前筛选池排序生成，方便用户直接按序号表达选择。
- 修复量产账号列表点击底部账号后跳回顶部的问题：卡片重绘时同时保留消息流滚动和账号列表内部滚动。
- 批量生产增加全局默认图数，并为每个账号单独提供“本号条数 / 每条图数”调整；批次启动时按单号设置创建任务并写入图数。
- 小红书图文底层默认张数从旧的 6 收紧为 4，避免批量链路漏回 6 张。
- 发布前精修随机化角标：批量站内生成和 Agent 上传补图不再固定四角括号，改为 0-2 个角随机出现，并混用圆点、短线、斜线、弧线等轻量装饰。
- 收紧批量意图里的标签误判，避免“创作3条内容”被误识别为“创作者”标签。
- Agent 思考面板按会话隔离，后台批量起草不会串到新开的量产窗口或其他会话。
- 重命名会话弹窗拦截输入框键盘事件，Cmd+A 后 Backspace/Delete 只清空输入，不会穿透导致弹窗或会话窗口消失。
- 计划卡操作改为按 `data-plan` / `data-mid` 在全部会话中定位所属消息，避免第二窗口、旧会话或当前 active session 不一致时，账号点选、随机、参考图和确认按钮操作不到当前卡片。
- 账号 / 标签点选前移到主点击委托的早期分支，配合手动选择锁，用户取消已选账号后不会被“最后10个”等原始指令自动补回。

### 验证结果

- `node --check` 通过：`intent.js`、`orchestrator.js`、`cards.js`、`view.js`、`productions.js`、`components.js`。
- 解析验证通过：“选择最后10个图文号”得到 `pickFrom=end`、`accountCount=10`；“选择前5个素材号”得到 `pickFrom=start`、`accountCount=5`。
- 本地 `/api/health` 返回正常，语言模型配置已接通。
- 浏览器轻量验证：`#/agent` 正常打开、不白屏；账号序号可渲染到 `#48`，默认图数为 4，单号“本号条数 / 每条图数”控件可渲染。in-app browser 未登录时登录蒙层会阻挡真实点击，点击类验证需在已登录浏览器中确认。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 量产卡片重绘属于高频交互，后续新增字段也要复用滚动快照逻辑，避免再次跳顶。
- 未登录浏览器看到工作台但点不动时，先检查 `body.gated` 和登录态，不要先回退账号按钮逻辑。

## v20 - 2026-06-30

### 本版范围

- 批量生产去掉“每号随机主题”显式 UI，固定为量产任务板：总创作要求为空时每条自动随机出内容；填写总创作要求时，未单独填写的账号沿用总要求；单号填写内容时优先使用单号内容。
- 批量图文文案增加差异化策略：同一批量方向下按痛点急救、工具分工、真实实测、模板收藏、避坑修正、前后对比、一人团队、冷静备忘等形式轮换，避免标题、首句和正文架构雷同。
- 图文脚本和图片提示词增加信息密度预算：长内容少图时先压缩主线、分配节拍；短内容多图时补真实例子、证据和边界；每张图只讲一个核心点，减少单图堆叠。
- 图片提示词清洗结构化噪声：过滤 `idea/visual/line`、时间码、用户指令、内部定位词，避免“做成小红书笔记”“画面定位”等系统语言出现在图卡内容里。
- Obsidian / Notion / 知识库类主题单独识别为“知识沉淀”场景，文案和提示词围绕“百度搭子桌面执行 + 知识库沉淀”展开，不再误滑到周报或格式转换。
- 产品关系描述收紧：Manus、Obsidian、代码工具等在图片提示词里只写短职责，避免长产品能力把单张图挤爆。
- 批量单号行 UI 收紧为稳定网格：账号、产品、本号条数、每条图数对齐；创作内容输入独占一行，避免右侧任务看板存在时横向溢出。
- 本地前端语言模型代理探测增强：如果静态前端入口无法同源访问 `/api/health`，会尝试发现 `127.0.0.1:8787` 后端；日常本地正式入口仍以 `http://127.0.0.1:8787/#/agent` 为准。

### 验证结果

- `node --check` 通过：`ai.js`、`llm.js`、`orchestrator.js`、`cards.js`、`view.js`。
- `/api/health` 返回语言模型已配置；`/api/chat/completions` 真实返回“正常”。
- 真实 LLM 多轮压测通过：
  - 长内容 + 3 张图：能压缩成知识卡片、Obsidian 双链、Manus 边界三类图卡，提示词长度约 312-319 字。
  - 同一统一需求 + 不同账号：标题、图卡顺序、例子和发布文案有明显差异，不再整批同文案。
  - 工具分工主题：图片提示词保留“百度搭子负责桌面执行、Obsidian 负责知识沉淀、Manus 负责云端任务”的具体关系。
- 提示词抽查未出现：`Dumate`、`种草`、`痛点`、`共鸣`、`构图`、`封面`、`步骤一`、`评分`、`打分`、`排行榜`、`星级`、`idea/visual/line`、时间码等不该进入最终提示词的内容。
- 浏览器验证 `http://127.0.0.1:8787/#/agent` 正常打开，标题为“星阵 · 内容生产工作台”；页面无横向溢出，语言模型前端配置为同源 `/api/chat/completions` 且 server-managed。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 4173 仅作为静态前端辅助入口；如果用户问“本地 API 未接通”，优先确认是否打开了 8787 正式入口，以及 8787 后端是否在运行。
- 批量提示词质量的核心是“先编排内容，再写单图 prompt”；后续新增账号风格或产品关系时，也必须继续遵守单图信息预算。

## v21 - 2026-06-30

### 本版范围

- 修复批量生产确认执行失败：批量差异化策略里的 `accTag` 变量错写导致 `startBatch()` 同步抛错，页面只留下空批次，看板显示 0/0，思考过程不出现。
- 批量确认流程改为先进入“启动中”，批次和 production 创建成功后才标记“已执行”；失败时自动回滚为待确认。
- 量产卡与批次写入 `planMessageId` 绑定；旧的“已执行但无批次/进度”孤儿卡会自动恢复为待确认。
- 右侧任务看板过滤 0 条空批次，保留原来的节点式任务卡，不再显示退化的纯文本 0/0 列表。
- 发布清单序号按发布时间动态连续计算，创作端和供应商视角共用同一套序号，避免旧缓存字段造成重复。
- 发布清单创作端增加日期时间轴导航和按日期折叠，方便按天快速定位发布内容。
- 创作端切换到“供应商视角”时增加“批量下载未下载”按钮，供应商角色入口同样保留该按钮。

### 验证结果

- `node --check` 通过：`agent/orchestrator.js`、`agent/view.js`、`agent/cards.js`、`views/deliveryView.js`。
- `git diff --check` 通过相关修改文件。
- 浏览器验证 `http://127.0.0.1:8787/#/agent`：新量产默认未选账号时提示“至少选择一个账号”；选择账号后确认会出现节点式任务看板和小机器人“并发起草”思考面板。
- 浏览器验证 `http://127.0.0.1:8787/#/delivery`：日期导航渲染正常，发布序号连续；供应商视角显示批量下载按钮，表格序号连续。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 批量启动失败不一定是语言 API 问题；如果看板出现 0/0，优先检查前端同步异常和空批次。

## v22 - 2026-06-30

### 本版范围

- 单号创作账号矩阵去掉平台文字 chip，用序号颜色区分平台：小红书红色、视频号绿色，给账号名称腾出空间。
- 图文工坊生成结构后的 toast 改为通用“已生成”，不再显示具体张数。
- 发布清单头部信息重排：平台 / 产品 / 账号 / 计划日期进入固定标签区，文件名、发布人和供应商状态进入可省略详情区，悬停可看完整信息。
- 供应商视角素材行支持点击展开详情，直接预览文案和图集缩略图。
- 批量创作参考图选择弹窗增加删除普通上传图的按钮；单号图片工坊参考图选择器同步支持删除普通参考图。
- 已发布生成图不提供快速删除，避免误删发布清单详情预览依赖的图集子图。
- 启动和远端拉取后自动修复历史已发布图集的共享标记，让已发布图片进入整体资产库并按 hash 去重逻辑继续复用。
- 入口资源版本号更新到 `20260630-v22`，避免浏览器继续加载旧 CSS/JS。

### 验证结果

- `node --check` 通过：`main.js`、`views/deliveryView.js`、`agent/view.js`、`views/chainBoards.js`。
- `git diff --check` 通过。
- `/api/health` 本地返回正常，语言模型配置已接通。
- 浏览器验证 `#/studio`：账号矩阵 80 个账号；平台文字 chip 为 0；小红书 50 个红色序号，视频号 30 个绿色序号。
- 浏览器验证 `#/delivery`：发布清单 meta 标签区渲染正常，计划日期不带时间；供应商视角可展开行详情并预览图集缩略图。
- 浏览器验证 `#/agent`：参考图选择弹窗可打开，普通参考图显示删除按钮，已发布生成图不显示删除按钮。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 服务器部署新版本后，旧的已发布图集会在前端拉取数据后自动补共享标记；后续更新不要覆盖服务器账号和资产数据。

## v23 - 2026-06-30

### 本版范围

- 基于小红书 AI Agent / Codex / WorkBuddy / Obsidian 相关高互动样本，升级批量“文案编辑”规则：标题类型、首句、正文骨架、案例和标签必须轮换，空创作要求时也要主动发散真实 AI 博主选题。
- 文案生成增加同批去重硬约束：同一批账号不能只改词复读，必须换场景、切入、证据和表达节奏；标题不强制带“百度搭子”，正文自然落回产品使用和工具分工。
- 批量计划卡区分图文账号和视频账号：图文账号保留“每条图数”，视频账号显示“口播 / 数字人 / 混剪”链路，不再出现图数输入。
- 批量计划卡每号配置行进一步收紧列宽，避免右侧任务看板打开时内容输入框横向溢出。
- 整体素材库筛选分组：已发布生成图单独展示，BGM 库和录屏库归到“剪辑素材库”，账号筛选默认折叠并可展开。
- 发布清单日期折叠改为局部高度动画，不再重绘整个列表，减少卡片闪烁。
- 入口资源版本号更新到 `20260630-v23`，避免浏览器继续加载旧 CSS/JS。

### 验证结果

- 待本轮浏览器和语法检查后补充。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 后续如果继续提升文案质量，应优先扩充“标题类型 + 首句类型 + 正文骨架”的可组合策略，而不是只加更多产品卖点。

## v24 - 2026-06-30

### 本版范围

- 修复批量创作里视频账号配置行的链路标识溢出：视频账号不再显示长文本“口播 / 数字人 / 混剪”，改为紧凑“视频”胶囊，完整链路放到悬停说明。
- 进一步收紧批量账号配置行列宽，给右侧创作内容输入框留出空间，避免右侧任务看板打开时横向挤出。
- 入口资源版本号更新到 `20260630-v24`，避免浏览器继续加载旧的批量创作样式和文案。

### 验证结果

- 待本轮语法、差异和浏览器检查后补充。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。

## v25 - 2026-06-30

### 本版范围

- 图文图片提示词进一步降密度：封面默认只做点击入口，大标题 + 1-2 个简单视觉符号，不再塞步骤、表格、清单和大段信息。
- 后续图卡改为每张只承载一个核心动作 / 场景 / 结果；只有当前图明确是文档、表格、日报、报告等页面时，才允许稍高文字密度。
- 修复模型把“简笔画、白底、大字标题、少文字”等账号风格词误当成本图内容节拍的问题。
- 发布文案标题、正文和话题标签不再出现自家产品名；需要指代时改用品类词，例如“桌面智能体”“AI应用搭建工具”“这个工具”。
- 本地兜底文案也接入同一套自家产品名清洗，避免语言模型失败时模板把产品名写回发布文案。
- 入口资源版本号更新到 `20260630-v25`，避免浏览器继续加载旧的文案和提示词逻辑。

### 验证结果

- `node --check 自动化产品/js/api/ai.js` 通过。
- `git diff --check` 通过。
- `/api/health` 返回正常，语言模型配置已接通。
- 浏览器验证 `http://127.0.0.1:8787/?v=20260630-v25#/agent` 正常打开。
- 浏览器真实调用 `generateImagePrompts + generateCopy` 测试 Obsidian + 百度搭子 4 图：发布标题和正文未出现自家产品名；图片 prompt 未出现旧英文名；风格词不再进入“本图只讲”的内容节拍。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 图片 prompt 仍会在内部使用主产品名来帮助图像模型识别产品界面和工具关系；“不出现自家产品名”只约束对外发布文案标题、正文和标签。

## v26 - 2026-06-30

### 本版范围

- 新增小红书热门参考能力：批量创作和单号图片工坊都增加“联网参考热门 / 联网参考小红书”开关。
- 新增 `/api/research/xhs-trends` 后端接口，通过 OpenCLI 获取小红书趋势样本；OpenCLI 缺失、未授权、超时或失败时自动回退本地趋势库，并弹窗提示“确定 / 不再提醒”。
- 新增本地小红书趋势库，沉淀 AI Agent、Codex、WorkBuddy、Obsidian、桌面效率等方向的标题结构、首句节奏、正文骨架和选题角度，用于无联网或联网失败时兜底。
- 批量创作链路把 `useOnlineTrends` 和 `trendGuide` 传入选题、脚本、图片提示词和发布文案，统一创作方向下也会按账号差异生成不同切入。
- 单号图文链路同步接入热门参考；生成图卡结构时先生成/整理创作内容，再按内容节拍拆成每张图。
- 图片提示词继续极简负面约束：最终负面提示词只保留页码、二维码、左上角/右上角 logo 约束，不再追加大段禁止项。
- 图片正向提示词重写编排逻辑：封面只承担点击入口和冲击感，内页一张图只讲一个场景 / 动作 / 结果；文档、表格、日报类才允许稍高信息密度。
- 修复图片提示词里可能出现 `[object Object]` 的脚本对象串化问题，脚本会先转为可读文本再参与编排。
- 修复账号风格词被当成本图内容的问题，避免“简笔画 / 白底 / 大字标题”等风格描述变成画面主题。

### 验证结果

- `node --check` 通过：`js/api/ai.js`、`js/data/xhsTrendLibrary.js`、`js/agent/orchestrator.js`、`js/agent/cards.js`、`js/agent/view.js`、`js/views/chainBoards.js`、`js/views/chainCopy.js`。
- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- `git diff --check` 通过。
- `/api/health` 本地返回正常，语言模型配置已接通。
- `/api/research/xhs-trends` 本地返回正常；OpenCLI 可用时返回趋势样本，失败时前端会回退本地趋势库。
- 浏览器验证 `http://127.0.0.1:8787/#/agent` 正常打开，无白屏；批量任务板显示“联网参考热门”开关，无横向溢出。
- 多轮提示词抽查：最终图片负面约束仅出现 1 次且为固定短句；未出现大段负面提示词、`[object Object]`、`Dumate`、`种草 / 痛点 / 共鸣 / 构图 / 封面 / 步骤一` 等不该出现在最终图片提示词里的词。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 联网参考热门是增强能力，不是硬依赖；服务器或本地没有 OpenCLI 时，应提示用户在浏览器中配置 OpenCLI 后重试，并继续用本地趋势库完成创作。

## v27 - 2026-07-01

### 本版范围

- 小红书热门标题策略升级为“80% 模仿 + 20% 改写”：保留热门标题的钩子和句式，替换成本次主题、竞品/互补工具关系和账号语气；公开标题、正文、tag 继续清洗自家产品名。
- 联网热门参考与本地趋势库前置为结构化 `trendPrep`，贯穿创作内容、脚本、图片提示词和发布文案；联网失败时继续回退本地五大选题方向。
- 本地趋势库增加主题语义兜底：没有联网样本时，会优先识别 Obsidian、Codex、WorkBuddy、Manus、周报、资料、表格等主题，避免批量创作标题和文案都落到同一套模板。
- 图片提示词正向编排继续收紧：第一张作为点击入口，内页按单一信息节拍展开；竞品或互补工具必须写清具体分工、组合或对比，不再只写“作参照”。
- 图片 prompt 内部清理“封面/构图/种草/痛点/共鸣”等定位词的泄露风险；最终负面提示词仍保持固定短句，不再追加大段禁止内容。
- 数据分析刷新接口返回 `ok/failed` 统计和失败原因，前端“更新数据”能反馈具体失败信息，方便后续接入联网数据刷新。

### 验证结果

- `node --check` 通过：`js/data/xhsTrendLibrary.js`、`js/api/ai.js`、`js/api/prompts.js`、`js/agent/orchestrator.js`、`js/views/chainBoards.js`、`js/views/chainCopy.js`、`js/domain/analytics.js`、`js/views/analyticsView.js`。
- `git diff --check` 通过。
- 本地 `/api/health` 正常，语言模型配置已接通；图片配置检查返回已配置且可达。
- `agent-reach doctor --json` 显示小红书搜索后端可用；已用 OpenCLI 搜索 AI 办公、Codex、WorkBuddy、Obsidian 等方向样本，并沉淀到标题改写策略。
- 逻辑抽查通过：联网样本能把 `WorkBuddy和Codex的区别` 等热门标题改写为本次主题标题；公开标题/文案/tag 未出现自家产品名；图片策略未出现旧英文名。
- 浏览器验证 `http://127.0.0.1:8787/?v=20260701-title-rewrite#/agent` 正常打开，无白屏，批量任务板和联网参考开关可见。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- OpenCLI 是联网热门增强项，不是创作硬依赖；服务器或本地没有 OpenCLI 时，应提示用户在浏览器中配置 OpenCLI 后重试，并继续使用本地趋势库。

## v28 - 2026-07-01

### 本版范围

- 修复批量图文生成链路的状态恢复和重试逻辑：`images running/pending` 且已有 prompt 但未成图时，刷新后会继续调用站内图片生成，不再停在图文创作台。
- 批量图片生成增加单任务锁和已完成图片跳过逻辑，避免重复恢复时同一张图被重复生成。
- 批量图文链路确认按 4 张图执行，文案前置后再生成图片 prompt，图片 prompt 主要参考文案、产品和账号风格。
- 图片 prompt 出口清洗可见字段标签，避免 `标题：/正文：/画面文字：` 被画进图里；负面约束继续只保留页码、二维码、左上角/右上角 logo 约束。
- 修复图片风格短句压缩截断问题，避免出现“深色项目复盘风为”这类半句。
- 修复后端图片代理重定向参数，`httpx` 使用 `follow_redirects=True`。
- 账号种子补齐逻辑改为同时验证 80 个种子账号是否真实存在，避免服务器或本地 state 空账号池却因为版本号相同而跳过初始化。
- 发布清单、供应商视角和整体资产库维持上一版交互：批量下载、展开预览、已发布图进入共享素材、BGM/录屏剪辑素材库分区。

### 验证结果

- `node --check` 通过：`agent/cards.js`、`agent/orchestrator.js`、`agent/view.js`、`api/ai.js`、`api/prompts.js`、`core/migrate.js`、`data/xhsTrendLibrary.js`、`domain/productions.js`、`main.js`、`views/chainBoards.js`、`views/chainCopy.js`、`views/prodDrawer.js`、`views/studio.js`、`views/deliveryView.js`。
- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- `git diff --check` 通过。
- 本地 `/api/health` 正常，语言模型配置已接通；`/api/image/config` 正常，图片 API 配置可达。
- 浏览器真实验证 `http://127.0.0.1:8787/?v=20260701-v28-final#/agent`：账号池为 80 个账号，50 个图文号 + 30 个视频号；批量新建默认 0 账号；选择 1 个账号后确认执行，节点式任务看板出现。
- 浏览器真实跑通批量图文最小任务：生成 4 条图片 prompt，站内生成 4/4 张图并进入待审；prompt 未出现旧英文产品名、可见字段标签或额外负面约束。
- 浏览器验证 `#/delivery`：发布清单无横向溢出，日期时间轴可见，供应商视角有“批量下载未下载”和回传链接，点击素材行可展开文案和图片序号。
- 浏览器验证 `#/assets`：已发布生成图进入共享素材库；BGM 库、录屏库位于剪辑素材库；账号筛选默认折叠，页面无横向溢出。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。
- 未跟踪的 `.codex-lark-auth/`、`diagrams/`、`星阵背景.mp4` 未纳入本次版本；它们不是本次平台代码提交内容。

## v29 - 2026-07-01

### 本版范围

- 覆盖更新 `Project Memory - 平台搭建新会话交接.md` 为“平台部署3号会话交接”。
- 补充 v28 当前状态：批量创作、图片文案链路、发布清单、整体资产、浏览器验证和已推送提交。
- 整理下一波任务：多人刷新同步、发布者展示、管理员/创作者草稿隔离、真实数据分析、联网搜索改写链路、删除账号定位干预、砍掉站外生成、替换图片精修、首页视频背景和 favicon。
- 明确后续部署必须保护服务器业务数据，不用本地空 state 覆盖线上账号、资产、发布清单和草稿。

### 验证结果

- 文档仅记录非敏感交接内容，未写入任何密钥、服务器密码、公网 IP 或私网 IP。

### 注意

- 本版是交接文档更新，不包含业务代码改动。

## v30 - 2026-07-02

### 本版范围

- 原版 8787 登录页去掉视频背景，改为白色科技感 CSS 动态背景；登录页保留用户提供的星阵 logo。
- 浏览器 favicon 改回用户提供的透明星阵图标，并给 favicon 与前端资源链接升级到 `20260702-v33`，降低浏览器缓存旧图标的概率。
- 小红书联网参考改写放开：联网结果里的标题、互动、作者和可用正文/摘要会作为发布文案的一等输入，模型可以吸收真实痛点、教程步骤、踩坑点和表达节奏，但禁止照抄原句。
- 后端小红书趋势解析扩展 `desc/description/summary/content/text` 字段，避免联网搜索只剩标题。
- 修复“重新生成文案”复用旧热门参考的问题：强制重写会刷新 `trendPrep`；切换联网开关会清空旧参考与旧改写对比卡。
- 离线文案策略放开：本地趋势库只提供灵感，最终文案优先服从用户主题、账号风格和真实使用逻辑，减少固定分点、固定 SOP 收束和 AI 腔。
- 图文左右对比卡右侧保持可编辑，顶部重复发布文案区在有对比卡时隐藏。

### 验证结果

- `node --check` 通过：`自动化产品/js/api/ai.js`、`自动化产品/js/data/xhsTrendLibrary.js`、`自动化产品/js/views/chainBoards.js`。
- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- 本地 8787 已重新启动，`/api/health` 返回正常。
- favicon 文件与用户提供的透明图标哈希一致；本地请求新版本 favicon 返回 200，响应头为 no-cache。

### 数据与回滚

- 本次为本地代码和静态资源更新，不涉及服务器数据迁移，不写入或覆盖线上业务数据。
- 回滚方式：恢复本次修改的前端文件、趋势库、后端解析器和 favicon 资源，然后重启 8787。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。

## v31 - 2026-07-02

### 本版范围

- 小红书数据分析接入 `agent-reach` / OpenCLI 的真实回退链：裸链接详情失败后按标题重搜，优先尝试搜索结果完整链接；详情仍不可得时，用搜索结果里的真实标题、作者和互动指标回填，不再把可用搜索指标整条判失败。
- 小红书联网热门参考增加互动门槛：低于 100 互动的样本不进入热门参考和文案改写链路。
- 空创作内容规则改为四方向短选题：强对比选型、联动绑定生态、打工人效率场景、小白反转入门；清除旧的随机长创作内容规则。
- 文案生成放开固定结构限制：减少固定三点清单、SOP 留存句和备忘录模板，联网和离线都优先写成真实使用复盘、场景叙述、避坑提醒或干货教程。
- 图文图片提示词改为“内容看发布文案和图卡脚本，视觉看账号风格 / 模板 / 参考图”；联网参考和账号风格不再改写图片内容主题。
- 图片标题截断修复：首图完整保留发布文案标题，内页标题改用完整短句，不再硬切成半句。
- 创建 / 编辑账号移除“账号定位”；新建账号不再写定位字段。账号主页视频号和图文号操作区统一放在右上角。
- 入口资源版本号升级到 `20260702-v35`，避免浏览器继续加载旧逻辑；favicon 继续使用星阵透明图标。

### 验证结果

- `node --check` 通过：`js/api/ai.js`、`js/data/xhsTrendLibrary.js`、`js/agent/orchestrator.js`、`js/agent/cards.js`、`js/views/chainBoards.js`、`js/views/chainScript.js`、`js/views/accountDialog.js`、`js/views/studio.js`、`js/api/analytics.js`、`js/domain/accounts.js`、`js/domain/productions.js`、`js/views/chainCut.js`、`js/views/chainWorkshop.js`、`js/main.js`、`js/views/overview.js`。
- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- `git diff --check` 通过。
- 本地 8787 已重启，`/api/health` 返回正常，入口 HTML 已加载 `20260702-v35` 资源版本和星阵 favicon。
- `agent-reach doctor --json` 显示小红书后端为 OpenCLI 且状态正常；本地 `/api/analytics/fetch` 对无完整参数的小红书链接可回退为 `agent-reach-opencli-search`，返回真实搜索标题、作者和互动指标，不再直接 503。
- Playwright 打开 `http://localhost:8787/?v=20260702-v35#/overview` 成功，登录页星阵 logo 和白色科技感背景正常；登录后首页导航可见，路由为 `#/overview`。
- 本次不涉及服务器数据迁移，不覆盖线上账号、资产、发布清单、数据分析或草稿。

### 回滚方式

- 恢复本次修改的前端生成链路、趋势库、账号 UI、数据分析后端和入口版本号，然后重启 8787。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。

## v32 - 2026-07-03

### 本版范围

- 主版本 UI 做一轮轻量视觉统一：只调整玻璃质感、黑白灰冷蓝配色和静态资源引用，不改核心布局、路由、登录接口、生成链路或数据结构。
- 登录页接入 `自动化产品/assets/brand/main-login-bg.mp4` 和 `main-login-fallback.png`，保留 poster 降级；移除登录页小 logo 节点，让表单直接浮在主背景上。
- 全局外壳、导航栏、顶栏、普通卡片、输入框和按钮改为更统一的白色液态玻璃材质，降低紫色/高饱和彩色装饰。
- 批量创作工作台保留原三栏和看板结构，只把深色界面收敛为近黑玻璃、半透明白边和冷蓝高光。
- 入口资源版本号升级到 `20260702-v36`，避免浏览器加载旧 CSS。
- 修改前已复制主版本备份到项目根目录：`主版本备份-20260702-UI修改前`。

### 验证结果

- `git diff --check` 通过：`index.html`、`styles/base.css`、`styles/components.css`、`styles/views.css`、`styles/agent.css`。
- 本地 8787 正在运行，入口 HTML 已返回 `20260702-v36`，登录视频和 poster 静态资源均返回 200。
- Playwright 验证 `http://localhost:8787/?v=20260702-v36#/overview`：登录页无旧小 logo，登录框和背景无明显遮挡。
- Playwright 登录后验证 `#/overview` 和 `#/agent`：首页普通卡片、左侧导航、批量创作三栏工作台均可渲染，未发现页面空白或主布局错位。

### 数据与部署

- 本次为 UI 与静态资源更新，不涉及服务器数据迁移，不写入或覆盖线上账号、资产、发布清单、数据分析或草稿。
- 当前登录视频约 89MB，后续服务器部署前应优先压缩为 web 版本或配置静态缓存 / range 请求 / CDN；必须保留 poster 降级，避免首屏卡顿。
- 回滚方式：恢复本次修改的入口文件、样式文件和新增登录背景资源；或用 `主版本备份-20260702-UI修改前` 对照回退 UI 文件，然后重启 8787 / 服务器前端服务。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。

## v33 - 2026-07-03

### 本版范围

- 部署前补强多人协作边界：服务器 `/api/state` 对 `assets` 增加可见性过滤，未发布且未共享的私有素材只返回给 owner；已发布 / shared 素材仍对所有成员共享。
- 前端账号资产、批量参考图选择器、资产搜索和首页只读统计同步加 owner 可见性过滤，避免本地旧缓存里残留的他人私有素材被入口拿出来。
- 保持数据分析集合共享：任一成员更新真实指标后，其他成员刷新 / 重新登录会从服务器权威 state 拉到同一份 `analyticsLinks` 与 `metricSnapshots`。
- 入口资源版本号升级到 `20260703-v37`，确保本次 JS 隔离修复生效。

### 验证结果

- 使用临时 SQLite 数据库验证服务器 state 过滤：成员 A 看不到成员 B 未发布 production / session / batch / private asset；管理员也看不到其他成员未发布创作态；已发布 production、shared / delivered assets、analyticsLinks 对所有成员可见。
- 临时库验证 jobs 跟随可见 production：隐藏的未发布 production 对应 jobs 不返回。
- `node --check` 通过本次修改的 JS 文件；`python3 -m py_compile server/main.py server/store.py` 通过；`git diff --check` 通过。
- 本地 8787 `/api/health` 返回正常，入口 HTML 已加载 `20260703-v37`、登录背景视频和星阵 favicon 引用。
- Playwright 已打开 `#/overview` 与 `#/agent` 并截图；当前浏览器上下文未登录，因此只验证登录层和底层路由渲染，没有在自动化日志里输入口令。
- 本次验证不写入本地 8787 真实业务库，不涉及服务器数据迁移。

### 数据与部署

- 本次为代码级权限 / 可见性修复和资源版本更新，不允许用本地 state 覆盖线上数据。
- 服务器部署必须保留线上数据库、上传文件、账号、资产库、发布清单、数据分析、草稿和成员数据；只更新代码和静态资源，必要时先备份再重启服务。
- 登录背景视频当前仍是原素材体积，部署时应优先压缩为 web 版本或配置静态缓存 / range 请求 / CDN，并保留 poster 降级。
- 回滚方式：回退本次 owner 可见性过滤相关前后端文件与入口版本号，然后重启服务。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。

## v34 - 2026-07-03

### 本版范围

- 修复服务器真实图片生成 502：图片 API 已返回结果后，服务端下载结果图时使用了新版 `httpx` 参数 `follow_redirects`，与服务器锁定的 `httpx==0.19.0` 不兼容。
- 将图片结果下载阶段改为 `allow_redirects=True`，兼容当前服务器依赖版本，也保持本地新版 `httpx` 可运行。
- 不改登录页、前端资源版本、模型配置、数据结构或业务数据。

### 验证结果

- `rg` 检查 `server/main.py`，确认只剩兼容旧版的 `allow_redirects` 用法，没有 `follow_redirects` 用法。
- 使用项目 `.venv` 检查 `httpx 0.19.0` 方法签名，确认 `AsyncClient.get/post` 支持 `allow_redirects`。
- 本地兼容性用例通过：模拟旧版 `AsyncClient.get` 签名调用 `_generated_image_to_data_url`，不再触发 `follow_redirects` 参数错误。
- `python3 -m py_compile 自动化产品/server/main.py 自动化产品/server/store.py` 通过。
- `node --check` 通过仓库内全部 JS 文件；本次未修改 JS。
- 本次不涉及服务器数据迁移，不覆盖线上账号、资产、发布清单、数据分析或草稿。

### 数据与部署

- 服务器部署只需要更新代码并重启服务，不允许覆盖数据库、上传目录、生成目录、环境文件或认证缓存。
- 回滚方式：回退本次 `server/main.py` 的图片下载参数兼容修改，然后重启服务。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。

## v35 - 2026-07-03

### 本版范围

- 修复服务器草稿删除后刷新复活：服务端新增删除墓碑表，删除 `productions / jobs / sessions / batches / assets / accounts` 等同步集合时记录 tombstone，旧浏览器缓存再次 upsert 同 id 时不会把已删除数据插回。
- 前端关键删除路径改为等待远端 DELETE 成功后再本地删除：草稿箱、单号创作页、Agent 批次、批次内单条任务、Agent 会话删除失败时会提示刷新 / 重新登录 / 稍后重试。
- 批量创作详情抽屉的“审核”页新增发布文案编辑区，可直接修改标题和正文；如果图文任务使用了联网参考，会同时显示参考标题、互动信息、可得参考文案和“打开原文 / 搜索原文”入口。
- 服务端 `/api/db/{collection}/{doc_id}` DELETE 对未知集合返回 400，不再让异常冒成 500。

### 验证结果

- `python3 -m py_compile 自动化产品/server/main.py 自动化产品/server/store.py 自动化产品/server/tests/test_store_tombstone.py` 通过。
- `python3 自动化产品/server/tests/test_store_tombstone.py` 通过，覆盖删除后旧快照 upsert 不复活，以及新 id 正常写入。
- `node --check` 通过本次修改的关键 JS 文件：`prodDrawer.js`、`remote.js`、`store.js`、`productions.js`、`draftsView.js`、`studio.js`、`agent/orchestrator.js`、`agent/view.js`。
- `rg` 检查关键删除调用点，确认 UI 删除路径已 await。

### 数据与部署

- 本次会在服务器 SQLite 内自动创建 `deleted_docs` 表，属于兼容性 schema 增量；不需要清库，不迁移业务数据。
- 部署必须只更新代码并重启服务；禁止覆盖线上数据库、上传目录、账号、资产库、发布清单、数据分析、草稿、成员数据、环境文件或认证缓存。
- 部署前建议备份服务器数据库和上传目录；部署后重点验收草稿删除刷新不复活、批次任务删除不复活、批量图文审核页可直接编辑文案。
- 回滚方式：回退本次前端删除 await、服务端 tombstone 和抽屉审核页相关文件后重启服务；已创建的 `deleted_docs` 表可保留，不影响旧代码读取 docs。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP 或私网 IP。

## v36 - 2026-07-03

### 本版范围

- 视频 / 数字人生产新增声线 ID 搜索与校验：粘贴 MiniMax voice_id 后可识别本地账号画像中的声线名称，并可调用后端严格测试该 ID 是否被上游接受。
- 新增后端 `GET /api/tts/voice/lookup`，用于声线有效性测试；该接口不生成可下载音频，也不会在自定义 voice_id 无效时回落到默认声线。
- 账号编辑里的视频账号支持可选固定 `voice_id`：不强制填写；识别成功后可同步声线名称，后续创作会优先使用账号固定声线。
- 单号脚本页、分镜工坊 / 数字人工坊的声线选择区加入 voice_id 输入和“识别”按钮，并支持把识别到的声线固定回账号。
- 首页移除“账号矩阵”模块；新建账号按钮移到顶栏；数据问答压缩到 hero 右侧；统计、待办、最新交付区域上移并拉高列表卡，首屏更紧凑且底部不留大面积空白。
- 首页“最新交付”左侧封面优先显示真实交付首图，其次账号头像，再次账号首张图片，最后才回落到图标。

### 验证结果

- `python3 -m py_compile 自动化产品/server/main.py 自动化产品/server/store.py` 通过。
- `node --check` 通过本次修改的关键 JS 文件：`api/providers.js`、`main.js`、`views/accountDialog.js`、`views/chainScript.js`、`views/chainWorkshop.js`、`views/overview.js`。
- 本地目标 voice_id 测试结果：前端识别为 `Moss 沉稳声线`，后端严格 TTS 查询返回有效。
- Playwright 验证本地 8787 首页：账号矩阵已移除，数据问答位于 hero 内，首屏不需要下拉，最近交付真实封面可渲染。
- Playwright 抽测视频账号编辑弹窗：固定声线名称、voice_id 输入和识别按钮均可见。

### 数据与部署

- 本次只修改本地代码和样式，不执行服务器部署，不涉及服务器数据迁移。
- 后续部署时只更新代码并重启服务；禁止覆盖线上数据库、上传目录、账号、资产库、发布清单、数据分析、草稿、成员数据、环境文件或认证缓存。
- 回滚方式：回退本次新增的 TTS 声线查询接口、前端声线识别入口、首页紧凑布局和版本记录，然后重启本地 / 服务器服务。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v36 追加 - 2026-07-03

### 本版范围

- 修正联网参考不可用提示：后端实际依赖服务器进程可见的 `opencli` 和服务器侧登录态；本地浏览器配置不会自动同步到线上服务。
- 空创作内容随机逻辑改为四方向短选题池：强对比选型、联动绑定生态、打工人效率场景、小白反转入门；每次生成加入运行时 seed，同一账号不会总是固定同一句。
- 文案生成规则放开但压实：联网 / 离线都要求更像真人经验复盘，减少固定分点和模板收束，正文不再保留多余空行。
- 主按钮、生成按钮和顶栏新建账号按钮统一为克制黑白灰毛边玻璃风，只保留少量蓝色边缘光，降低炫彩感。

### 验证结果

- `node --check` 通过 `自动化产品/js/api/ai.js`、`自动化产品/js/data/xhsTrendLibrary.js`、`自动化产品/js/main.js`、`自动化产品/js/views/overview.js`。
- `python3 -m py_compile 自动化产品/server/main.py 自动化产品/server/store.py` 通过。
- Node 抽样验证：空内容可抽到多个四方向短选题；本地趋势库生成文案无空行。

### 数据与部署

- 本次只修改本地代码、样式和文案策略，不执行服务器部署，不涉及数据迁移。
- 后续部署时只更新代码和静态资源；禁止覆盖线上数据库、上传目录、账号、资产库、发布清单、数据分析、草稿、成员数据、环境文件或认证缓存。

### 注意

- 本追加不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v42 - 2026-07-06

### 本版范围

- 下线图文创作和批量创作里的联网参考小红书入口：不再显示联网开关，不再请求小红书趋势搜索；旧状态残留会按离线创作处理。
- 下线数据分析里的手动更新 / 服务器抓取动作：页面改为历史快照、发布回链和复盘口径，避免服务器端 OpenCLI/agent-reach 不可用时反复失败。
- 视频文案分镜工坊新增“封面图”模块：放在发布文案下面，可上传 / 拖入封面参考图，封面提示词自动根据发布标题、正文和产品名生成，生成后的封面进入资产库并绑定当前生产单。
- 批量生产的视频账号计划卡只保留一个“封面参考图”按钮；封面主题自动跟随生成后的标题和文案，不额外增加独立封面需求输入。
- 批量视频任务执行时会自动继承封面参考图，并尝试生成封面资产；生成失败只记录错误，不中断文案、分镜、口播和视频任务。

### 验证结果

- `node --check` 通过本次修改的关键 JS 文件：`api/ai.js`、`views/chainBoards.js`、`views/chainWorkshop.js`、`agent/cards.js`、`agent/view.js`、`agent/orchestrator.js`、`views/analyticsView.js`、`views/deliveryView.js`、`views/prodDrawer.js`、`domain/productions.js`。
- `python3 -m py_compile 自动化产品/server/main.py 自动化产品/server/store.py` 通过。
- `rg` 检查前端和样式，确认已无 `OpenCLI / agent-reach / 联网参考 / 更新数据 / 小红书趋势接口` 的可触发入口。
- 本地 8787 HTTP 烟测通过：`/` 和 `/api/health` 均正常返回。

### 数据与部署

- 本次没有执行服务器部署，不涉及服务器数据迁移。
- 后续部署时只更新代码和静态资源，不能覆盖线上数据库、上传目录、账号、资产库、发布清单、数据分析、草稿、成员数据、环境文件或认证缓存。
- 回滚方式：回退本次前端联网入口下线、数据分析抓取入口下线、视频封面模块和批量封面参考入口相关修改后重启服务。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。

## v57 - 2026-07-08

### 本版范围

- 单号图文、素材视频、真人视频默认进入自定义文案模式；产品选择在前台锁定为后台参考，标题和正文是创作第一优先级。
- 素材视频 / 真人视频自定义生成改为纯 LLM 生成发布文案、口播和分镜参考；没有本地模板兜底，模型不可用时直接报错。
- MiniMax adaptive 思考输出被截断时，仅做一次关闭 thinking 的 LLM 重试；仍然不使用本地兜底文案。
- 信息流自定义生成保留用户标题，不再用模型标题覆盖；信息流发布文案改成专业解析口吻，避免“哎/跟你说/说个事”类口水开场。
- 信息流 B 面分镜提示与视频提示词分离：分镜参考上移，分镜图提示只进入 storyboard prompts，不再拼进视频生成 prompt。
- 视频生成 prompt 的负面约束统一固定为“无字幕、不生成花字、不生成水印、不生成二维码”，不再写“音效留到智能混剪”“无 BGM”“无口播/无人声”等会误导上游的视频限制。
- 视频封面提示词收口为“标题优先 + 随机风格 + 简短负面约束”，不再把长文案摘要写进封面图提示词。
- 素材号自定义发布文案自动补品牌标签；标签只保留在发布文案末尾，不进入口播或视频提示词。
- 批量生产任务板改为先选“自定义 / 自动”和“图文 / 素材视频 / 真人视频”；同一看板只运行一种内容，账号按类型过滤，自定义模式逐账号填写标题和文案。

### 验证结果

- `node --check` 通过 `api/llm.js`、`api/ai.js`、`views/chainWorkshop.js`、`views/chainBoards.js`、`agent/orchestrator.js`、`agent/cards.js`、`agent/view.js`。
- `python3 -m py_compile 自动化产品/server/main.py` 通过。
- `git diff --check` 通过。
- Playwright 本地验证自定义真人视频和素材视频：均由 LLM 生成，用户标题保持不变；发布文案和口播不相同，口播更长且为第一人称；素材号信息流分镜参考未混入视频提示词。
- Playwright 复测素材视频自定义链路：发布文案含标准标签，分镜参考存在且不含“第一镜 / 第二镜 / 0-3s”等分镜结构词。

### 数据与部署

- 本次只修改代码、静态资源和版本记录，不执行服务器部署，不覆盖服务器业务数据。
- 后续部署只允许同步代码和静态资源；必须保护线上数据库、上传目录、账号、资产库、发布清单、草稿、成员、分析数据、环境文件和认证缓存。

### 注意

- 本版不包含任何密钥、服务器密码、公网 IP、私网 IP、token 或账号凭据。
