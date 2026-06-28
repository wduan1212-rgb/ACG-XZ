# 升级方案 v5：Agent 沉浸式工作区 + 整体框架重构

> 2026-06-11 · 基于对 index.html / app.js / styles.css / server / cli 全量代码阅读
>
> **范围声明**：本工具是团队内部的合规内容生产与项目管理工具（素材整理、选题规划、分镜规划、人工审核、任务协作）。不涉及操控平台账号、自动发布、刷量或虚假互动。方案中"发布"一律指**内部定稿入库**（进入发布后台 + 供应商素材库），建议本次升级把措辞统一改为「定稿 / 交付」。

---

## 0. TL;DR

- 现状是一个完成度不低的**高保真原型**：17 个视图、全链路可点击、LLM（DeepSeek）真实接入、图文链路基本能跑、视频链路有占位。但它是 4257 行单文件 IIFE + 双任务模型 + DOM 级 Agent 日志，继续往上叠功能会越来越痛。
- 本次升级做四件事：**① 统一任务模型（production + 阶段状态机）→ ② Agent 独立沉浸式工作区（会话持久化 + 结构化消息卡片 + 事件驱动编排器）→ ③ 视频链路按异步 Job + ProviderAdapter 设计到位（mock 跑通全状态，真 API 来了只写一个 adapter）→ ④ 全局 UI 体系升级（design tokens + 应用外壳 + 组件清洗）**。
- 图文链路最先全通（LLM 文本真实生成 + 站外出图回传 + 文案 + 审核 + 定稿入库），视频链路架构与 UI 状态全部就位但不真实调用。
- ⚠️ **有一个需要今天就处理的安全问题：DeepSeek API Key 明文写在 app.js 和 proxy.py 里，请立即在 DeepSeek 后台作废该 Key。**

---

## 1. 现状盘点

### 1.1 系统地图

```
index.html (1127 行)  17 个 <section class="view"> 平铺，showView() 切换
styles.css (2310 行)  浅色主题 + 生成台深色 + quick 模式深色（三套并存）
app.js     (4257 行)  单 IIFE：
  ├─ state 单对象（accounts / draft / quick / timeline / segmentRuns…）
  ├─ IndexedDB 整包快照持久化（防抖 700ms + 8s 兜底）
  ├─ 17 个 render* 函数（innerHTML 全量重绘）
  ├─ bind()（约 600 行集中事件绑定）
  └─ DumateAPI（LLM 调用层，每个方法带 mock 兜底）
server/main.py        FastAPI 最小后端（/api/llm 代理、账号/素材 CRUD、静态托管）——已写好但前端未接
cli/dumate.py         CLI（健康检查/账号/脚本/素材）——对接后端，同样未被前端使用
proxy.py              本地 CORS 代理（内置同一个明文 Key）
```

**两条创作链路**（单账号模式）：

- 视频：脚本(8 镜/30s) → 分镜图(站内/站外回传) → 提示词(每场景两段独立 15s) → 即梦式生成台(对话流 + @资产) → 粗剪(时间轴/字幕/SRT) → 文案 → 发布后台/供应商库
- 图文：脚本(3-9 张图卡) → 图片提示词(站内/站外回传) → 文案 → 发布后台/供应商库

**真实接入情况**：脚本/提示词/文案/随机骰子 = DeepSeek 真实调用（失败回退 mock）；图片/视频生成 = 占位（CONFIG.image / CONFIG.video 为空时延时返回 null）。

### 1.2 现有 Agent（⚡快速批量创作）的真实实现

- 入口是首页一条光带，进入 quickView（整页深色接管）。左栏 = Agent 对话（`#agentLog` 纯 DOM 追加 + 单行输入框），右栏 = 选号表单 + 总进度条 + 节点画布（每任务 5 阶段节点链）。
- `agentRun()` 的路由 = 三条正则快通道（建号/触发生成/全部发布）+ 一次 LLM 抽参 `{topic, tags, group, style}`（失败回退正则解析）。
- 批量执行 = `startQuickBatch()` 并发 2 起草 → 等人工回传分镜 → `setInterval` 每 1.5s 盯进度，全部就绪后自动触发生成 → check → publish。
- 任务存在 `state.quick.tasks`，状态机：`drafting → awaiting → ready → queued → generating → check → publish → published`（+failed）。

这套东西**思路是对的**（选号→起草→回传→生成→审核→定稿的编排是成立的），问题在于实现层级太低，撑不起"沉浸式 Agent 工作区"的定位——详见 §2.3。

---

## 2. 问题清单

### 2.1 安全（P0，今天处理）

| # | 问题 | 位置 |
|---|------|------|
| S1 | DeepSeek Key 明文硬编码，且该目录在 git 仓库内 | app.js:3766、proxy.py:17 |
| S2 | 浏览器直连 LLM，Key 随前端分发给所有使用者 | app.js llm() |
| S3 | 设置页保存的 Key 存 IndexedDB 明文（内部工具可接受，但应说明） | settings |

→ 处理：**立即作废现有 Key**；前端默认改走 `server/main.py` 的 `/api/llm`（Key 进环境变量，部署文档里你们自己已写了这条但没执行）；proxy.py 删除内置 Key 改读环境变量。

### 2.2 架构与数据

| # | 问题 | 后果 |
|---|------|------|
| A1 | **双任务模型**：`account.tasks`（状态 draft/script/prompt/gen/cut/done）与 `state.quick.tasks`（drafting/awaiting/…/published）是两套互不相通的实体和状态机 | 首页统计、发布后台、供应商库要分别拼数据；Agent 批量产物与手动创作产物无法互转；"继续任务"只对手动链路有效 |
| A2 | 草稿是**账号级单例**（workByAccount），一个账号同时只能有一条在制内容，新建即覆盖 | 多任务并行会串台，这是链路"不完善"感觉的主要来源之一 |
| A3 | 整包快照持久化，且保存时**直接丢弃 generating/queued 状态的任务**（app.js:3702 filter）| 批量生成中途刷新 = 任务整条消失（数据丢失 bug） |
| A4 | 资产以 base64 dataURL 存在状态树里，每次保存全量序列化 | 图片一多 IndexedDB 体积爆炸、保存卡顿 |
| A5 | 视频生成是同步函数假设（await 一次返回），真实视频 API 全是异步任务（submit + poll） | 现在的代码形态没法平滑接真 API，需要 Job 模型 |
| A6 | 后端/CLI 已写好但前端零对接，数据存在两个世界（IndexedDB vs data.json） | 团队协作/多人共享根本走不通 |
| A7 | 4257 行单文件 + innerHTML 全量重绘 + bind() 集中绑定 | 改一处全文件搜索，事件重复绑定风险（renderQuickProgress 每次重绘重新 addEventListener） |

### 2.3 Agent 模块局限

| # | 问题 |
|---|------|
| G1 | 对话不是数据：`#agentLog` 纯 DOM 追加，**刷新即消失**，无会话历史、无法回放 |
| G2 | 计划不是对象：解析出的 plan 只是一条日志文案，用户**无法在执行前修改/确认**（选错号只能重来） |
| G3 | `setInterval` 盯进度：离开页面/刷新后自动推进**静默失效**；和 A3 叠加，批量任务中断后无法恢复 |
| G4 | 意图路由覆盖面窄：建号/生成/发布三条正则 + 一次抽参，无多轮上下文（"重试失败的那两个"这类指令无法理解） |
| G5 | Agent 与单账号链路割裂：quickTune 单向跳转过去，回不来、状态不同步 |
| G6 | 原生 `confirm()` 弹窗打断 Agent 流（app.js:2742），与沉浸式定位冲突 |
| G7 | 沉浸感靠背景光斑撑，信息层级（对话 vs 表单 vs 画布）互相挤压，1100px 以下直接堆叠 |

### 2.4 UI/UX「廉价感」来源（具体到点）

1. **三套视觉体系并存**：浅色主页面 / 生成台深色 / quick 深色，token 不共享，色值各写各的。
2. **Emoji 当图标**：🗂🚀⚡🎲📝🎬✍️🐱 大量出现在按钮、节点、标题里——这是"原型感"最大的来源。
3. `agent.png` 引用但**文件不存在**，头像永远走 🐱 emoji 兜底。
4. 步骤编号漂移：分镜图叫 Step 2、提示词页 HTML 写 Step 2 而 TITLES 写 Step 3、生成台又叫 Step 3、粗剪 Step 4——链路没有统一的进度语言。
5. 信息架构平铺：左栏只有账号列表，没有全局导航；"大资产库/供应商端/设置"散落在角落按钮里；顶栏标题与页内标题重复。
6. 空态/加载态/错误态没有体系：多数是一行灰字；LLM 失败静默回退 mock，用户不知道拿到的是真生成还是模板。
7. 原生 confirm/alert、toast 单一通道，没有操作审计（Agent 干了什么只能翻日志气泡）。
8. 行内样式散落在 JS 模板字符串里（`style="padding:34px"` 等），微调要进 JS 改。

### 2.5 死代码与小缺陷（顺手清掉）

- `#libraryView` 整个视图无路由、无 JS 引用（index.html:898-913）——死代码。
- 创建账号对话框里有**两个**"账号标签"块，`#accTagChips`（index.html:1019-1030）无 JS 绑定——死代码。
- `agent.png` 缺失（见上）。
- TITLES 与页内 eyebrow 文案不一致（见 2.4-4）。

---

## 3. 目标信息架构

### 3.1 应用外壳（App Shell）

```
┌──┬──────────┬──────────────────────────────────────┐
│  │ 上下文面板 │  主画布                                │
│图│ (按域切换) │                                       │
│标│           │  顶栏：面包屑 + 全局搜索(⌘K) + 通知中心   │
│导│ 创作域=    │                                       │
│航│ 账号列表   │                                       │
│栏│ 资产域=    │                                       │
│  │ 筛选器     │                                       │
└──┴──────────┴──────────────────────────────────────┘
```

- **图标导航栏**（56px，全局常驻）：总览 / Agent 工作台 / 创作空间 / 资产库 / 交付中心 / 设置。
- **上下文面板**（240px，可收起）：进入"创作空间"时才是账号列表（现左栏的角色），其他域显示各自的筛选/列表。
- **Agent 工作台与生成台**：整页接管（隐藏外壳），但保留左上角返回锚点——"独立沉浸式"的具体含义。
- 五个域的归属：现 home→总览；quick→Agent 工作台（彻底重做）；workspace+六个 step 页→创作空间；assets+vault 合并→资产库（账号维度变筛选条件）；pubs+supplier 合并→交付中心（创作端视角 + 供应商视角两个 tab）；settings→设置。

### 3.2 一条链路、一种语言

全部内容生产统一为 production（见 §5.1），阶段语言全局统一：

```
图文：拟稿 → 脚本 → 成图 → 文案 → 审核 → 定稿
视频：拟稿 → 脚本 → 分镜 → 提示词 → 生成 → 粗剪 → 文案 → 审核 → 定稿
```

- 链路页头部放**统一 stepper**（替代各页自写的 Step N），点击可跳已完成阶段。
- "审核"成为正式阶段（现在只有 quick 链路有 check）：通过/驳回 + 驳回原因 + 退回到指定阶段。
- "发布"全部改叫**定稿入库/交付**：定稿后进入交付中心（创作端可见 + 供应商可下载），与现有逻辑一致，只改措辞与入口组织。

---

## 4. Agent 沉浸式工作区设计

### 4.1 布局（三栏）

```
┌─────────┬───────────────────────────┬─────────────┐
│ 会话列表  │  对话流（结构化卡片）         │ 任务看板      │
│ 240px    │  居中 max-width 760px      │ 420px        │
│ 可收起    │                           │ 可收起        │
│          │  ┌─────────────────────┐  │ 批次进度环    │
│ + 新会话  │  │ PlanCard 计划卡      │  │ ┌─────────┐ │
│ 会话1     │  │ topic/范围/风格 可改  │  │ │账号A ●●●○○│ │
│ 会话2     │  │ [调整] [确认执行]     │  │ │账号B ●●●●○│ │
│          │  └─────────────────────┘  │ └─────────┘ │
│          │  底部 Composer：           │ 点行→任务抽屉 │
│          │  多行输入+拖拽热区+快捷指令  │ (脚本/分镜/   │
│          │                           │  文案/审核tab)│
└─────────┴───────────────────────────┴─────────────┘
顶部状态条：批次阶段指示（起草中 3/8 · 等待回传 2 · 生成中 1）+ 退出
```

视觉基调：深石板蓝底（沿用现 --d-* 系列并升级），玻璃拟态面板，**唯一**强调渐变（品牌蓝→紫），细噪点/极光只在此域保留且调低强度；全部 SVG 线性图标，零 emoji。

### 4.2 会话与消息卡片体系（对话即数据）

```js
session = { id, title, createdAt, status, batchIds: [], messages: [
  { id, role: "user"|"agent", ts,
    type: "text" | "plan" | "selection" | "progress" | "need_input"
        | "results" | "approval" | "error",
    payload: {...},          // 卡片数据，引用 production/batch 的 id（活卡片）
    resolved: bool }         // 卡片上的操作是否已消费
]}
```

七种卡片（替代现在的日志气泡）：

| 卡片 | 内容与操作 |
|------|-----------|
| PlanCard | 解析出的 主题/标签/范围/风格 以可编辑 chips 呈现 + 命中账号预览 → [调整][确认执行]。**确认前不动手** |
| SelectionCard | 命中账号清单，可勾选增减，显示每号的定位摘要 |
| ProgressCard | 活卡片：从 store 实时取批次进度（起草/回传/生成/审核分段进度条） |
| NeedInputCard | 等待回传时内嵌 dropzone：拖图直接在对话里完成分发（保留现有顺序分发逻辑），显示每任务缺口 |
| ResultsCard | 任务结果缩略网格，点开任务抽屉 |
| ApprovalCard | 审核汇总：逐条通过/驳回，或[全部通过][全部定稿]（替代原生 confirm） |
| ErrorCard | 失败任务清单 + [重试失败项] |

会话与消息全部持久化（独立 store），刷新后完整回放；活卡片重新挂载到当前 store 状态。

### 4.3 批次编排器（替代 setInterval）

```js
batch = { id, sessionId, goal, plan, accountIds, productionIds,
          phase: "planning"|"drafting"|"awaiting_input"|"generating"
               |"review"|"done"|"paused",
          autoAdvance: true, createdAt, updatedAt }
```

- **事件驱动**：production / job 每次状态变更发事件 → `orchestrator.evaluate(batch)` 判断是否推进阶段，并向会话插入对应卡片。不再有 1.5s 轮询。
- **可恢复**：batch 持久化；应用启动时对所有未完成 batch 重新 evaluate（生成中的 job 转入恢复逻辑，见 §5.3），接续而不是丢失。修复 A3 数据丢失。
- `autoAdvance` 可关：关掉后每个阶段都等用户在卡片上点确认（给"想盯紧一点"的场景）。

### 4.4 意图路由

```
route(text, context) → { intent, params }
intent: plan_batch | create_accounts | run_generation | approve
      | deliver | retry_failed | status_query | tune_task | chat
```

- 一次 LLM 调用，few-shot + 严格 JSON + schema 校验；**context 注入当前批次摘要**（各状态计数、失败清单），使"重试失败的""把第二个驳回"可理解。
- 保留现有三条正则作为离线兜底；解析失败回落为 chat（普通回答），不再硬执行。

### 4.5 与单账号链路互通

- 任务抽屉里"进入完整工作台"= 跳到创作空间对应 production 的当前阶段页；改完回来，**同一条 production**，看板状态自然同步（统一模型带来的免费收益，替代现在的 quickTune 单向复制）。
- 反向：手动创作的 production 也可在 Agent 里被指挥（"把 A 账号那条改成…"→ tune_task）。

---

## 5. 数据与状态设计

### 5.1 production 统一任务模型

```js
production = {
  id, accountId,
  origin: "manual" | "agent",  batchId: null,
  mode: "图文" | "视频",  subType: "数字人"|"无数字人"|null,
  title, topic, style, direction,
  stage:  "brief"|"script"|"boards"|"prompts"|"render"|"cut"|"copy"|"review"|"delivered",
  stageStatus: "pending"|"running"|"needs_input"|"failed"|"done",
  artifacts: {
    script:   { shots: [], title, source: "llm"|"mock"|"manual" },
    boards:   { items: [{ prompt, assetId, status }], sharedRefAssetId, externalPrompt },
    prompts:  [{ name, front, back, ui }],
    renders:  [jobId],                          // 视频
    images:   { items: [{ prompt, assetId, status }] },  // 图文
    timeline: [], subs: [], subStyle: {},
    copy:     { title, body }
  },
  review: { state: "pending"|"approved"|"rejected", notes: "", by: "", at: null,
            returnTo: null },                   // 驳回退回的阶段
  delivery: { assetId, name, at },              // 定稿产物（命名规则沿用 平台码-账号-形式-序号）
  error: null, createdAt, updatedAt
}
```

迁移：`account.tasks` 与 `state.quick.tasks` 一次性映射进 productions（旧状态→新阶段映射表写死在 migration 里），`workByAccount` 草稿挂到对应 production 的 artifacts。

### 5.2 阶段状态机

- 每个 stage 内有四态：pending（未开始）/ running（生成中）/ needs_input（等人：回传、确认）/ failed（可重试）；完成即 advance 到下一 stage。
- 图文与视频的 stage 序列不同（§3.2），由 `flowOf(production)` 给出；stepper、看板、列表全部读这一处定义。
- 审核驳回：`review.returnTo` 指定退回阶段，stageStatus 置 pending，保留 artifacts 供修改。

### 5.3 Job 与 ProviderAdapter（视频/图片可扩展接口——本次的"预埋"重点）

```js
job = { id, kind: "video"|"image", productionId, segIndex,
        prompt, refAssetIds: [], params: { ratio, duration },
        provider,                       // "mock" | "jimeng" | "qianfan" | ...
        status: "queued"|"submitted"|"running"|"succeeded"|"failed"|"canceled",
        providerRef, progress: 0-100, attempts,
        output: { assetId },  error, createdAt, updatedAt }

ProviderAdapter = {
  id, kind, label,
  capabilities: { ratios, maxDuration, refImages, characterLock },
  async submit(req)            → { providerRef },
  async poll(providerRef)      → { status, progress, output? },
  async cancel(providerRef)
}
```

- **JobRunner**：独立 store 持久化；并发 2；submitted/running 的 job 定时 poll；失败记 error 可手动重试（attempts+1）；启动时恢复未完成 job（mock 直接重跑，真实 provider 凭 providerRef 续 poll）。
- **MockVideoProvider**：submit 即返回 ref，poll 按时间推进 progress（含随机慢任务与可配置失败率），succeeded 时产出占位资产。→ 视频链路全部 UI 状态（排队/进度/失败/重试/取消）在无 API 的情况下真实可走。
- 真 API 到位时：新建 `providers/jimeng.js` 实现三个方法 + 字段映射（现 `_mapRefs` 的 all/character/firstFrame 映射逻辑迁入 adapter），其余零改动。
- 生成工作台（即梦式对话流）改为 job 驱动：每次"生成"= 创建 job，消息卡片订阅 job 状态。

### 5.4 存储分仓与迁移

```
IndexedDB "acgVideoTool" v2：
  meta            schema 版本、UI 偏好
  accounts        账号（资产改存引用）
  productions     统一任务
  assets          资产元数据（name/type/tags/accountId/thumbRef/blobRef）
  blobs           二进制（Blob 而非 base64 字符串）+ 缩略图
  agentSessions   会话与消息
  batches         批次
  jobs            生成任务
```

- 按实体写入（不再整包序列化）；防抖保存保留。
- **迁移流程**：启动检测 v1 快照 → 自动导出一份 JSON 备份（下载提示）→ 执行迁移 → 旧 blob 保留不删，验证两周后手动清。
- 设置页加"导出全部数据 / 导入"按钮（团队换机、备份刚需，顺手解决）。
- 后端同步暂不做，但 `core/storage.js` 以 Repository 接口写（local 实现先行），将来切 FastAPI 同步只换实现层——A6 的解决放到下一期。

---

## 6. 文件与组件拆分

技术栈不变（原生 HTML/CSS/JS、无构建工具），改用 **ES Modules**（`<script type="module">`）：

```
index.html                外壳 + <template> 片段（瘦身）
styles/
  tokens.css              全部 design tokens（浅/深两套，唯一来源）
  base.css                reset / 排版 / 外壳布局
  components.css          按钮/卡片/chips/表格/抽屉/弹层/stepper/骨架/空态
  agent.css  chain.css  delivery.css  …（按域拆）
js/
  main.js                 入口：装配 + 启动迁移
  core/  db.js  store.js(状态+事件)  router.js(hash 路由)  bus.js
  api/   llm.js  jobs.js(JobRunner)  providers/(mock.js, index.js)
  domain/ accounts.js  productions.js(阶段机)  assets.js  delivery.js
  agent/  session.js  intent.js  orchestrator.js  cards.js  view.js
  views/  overview.js  chain/(script.js boards.js prompts.js render.js cut.js copy.js review.js)
          assets.js  delivery.js  settings.js
  ui/    icons.js(SVG 图标集)  toast.js  palette.js(⌘K)  drawer.js  notify.js
```

注意：模块化后 **file:// 双击打开失效**，必须 `python3 -m http.server` 或 uvicorn 启动（你们文档里两种方式都已有）；会提供 `start.command` 一键脚本。旧 app.js 整体移入 `_backup_v4/` 保留。

UI 组件清单（components.css + ui/）：Button(4 级)、Chip、StatusPill(统一阶段配色)、Card、Table、Drawer、Modal、Stepper、ProgressRing/Bar、Skeleton、EmptyState、Toast、NotifyCenter、CommandPalette、Dropzone、SegmentedControl。

---

## 7. 分阶段落地计划

> 估时按"你 + Claude Code 协作"的有效工作日粗估，P4 可与 P1-P3 穿插。

### P0 止血与地基（0.5–1 天）
1. **作废泄露 Key**（人工在 DeepSeek 后台操作）；前端默认走 `server/main.py /api/llm`，proxy.py 改读环境变量。
2. 清死代码：libraryView、#accTagChips、agent.png 引用、步骤编号统一。
3. ES Modules 机械拆分（不改逻辑），冒烟回归。
4. IndexedDB v2 分仓 + 迁移 + 自动备份导出。
- **验收**：功能与现状逐页一致；仓库 `grep -r "sk-"` 无命中；刷新无数据丢失；迁移前自动产出备份文件。

### P1 统一任务模型 + 图文链路全通（2–3 天）
1. productions + 阶段机 + 旧数据迁移；列表/首页统计/交付中心全部改读 productions。
2. 链路页接 production（支持同账号多条并行在制，修 A2）。
3. 审核阶段落地（通过/驳回/退回）；"发布"改"定稿入库"。
4. 链路统一 stepper + 任务详情抽屉。
- **验收**：图文从输入主题 → 脚本 → 站外出图回传 → 文案 → 审核 → 定稿全链可演示；两条任务并行互不串台；中途刷新可续作；驳回可退回成图阶段重改。

### P2 Agent 沉浸式工作区（3–4 天）★ 本次重点
1. 新路由 + 三栏布局 + 深色视觉体系。
2. 会话/消息持久化 + 七种结构化卡片。
3. 意图路由器（LLM + 正则兜底 + 上下文注入）。
4. 计划确认环（PlanCard 先确认后执行；可开 autoAdvance）。
5. 批次编排器（事件驱动、刷新可恢复）；对话内拖图回传。
6. 任务看板 + 任务抽屉；与创作空间双向互通。
- **验收**：一句话目标 → 计划卡（可改）→ 确认 → 批量起草 → 对话内拖图回传 → 自动推进 → 审核卡逐条/批量处理 → 批量定稿；**生成中途刷新页面，回来批次接续**；历史会话可完整回放；全程无原生 confirm。

### P3 视频链路架构就位·不真实调用（1.5–2 天）
1. jobs store + JobRunner + ProviderAdapter + MockVideoProvider（含模拟失败）。
2. 生成工作台改 job 驱动：排队/进度/失败/重试/取消全状态 UI。
3. 粗剪接 job 产物；Agent 批量视频走同一 Job 通道。
4. 设置页改"能力-Provider 档案"（语言/图片/视频/TTS 各自配置 + 测试连接），明确显示当前用 mock 还是真实服务、每次产物标注 source。
- **验收**：mock 下视频链路（手动 + Agent 批量）全状态可走；拔掉 mock 换真 adapter 的接入文档随代码交付；LLM 失败回退 mock 时 UI 有明确标识（修 2.4-6 的静默回退）。

### P4 全局 UI 升级（2–3 天，穿插进行）
1. tokens.css 统一两套主题；全站去 emoji 图标 → SVG 集。
2. 应用外壳（图标导航 + 上下文面板 + 新顶栏）。
3. 组件清洗（空态/骨架/错误态成体系）；通知中心（Agent/Job 事件审计流）。
4. ⌘K 命令面板（跳账号/任务/动作）。
5. 总览页重做（待办导向：待回传/待审核/生成中/本月产量）。
- **验收**：附视觉 QA 清单逐项过（同一 token 来源、无行内样式新增、关键页空载错三态齐全、1280/1440/1920 三档布局正常）。

---

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| 迁移丢数据 | 迁移前强制自动导出备份；旧快照保留两周；迁移函数带单测式自检（计数核对） |
| base64 体量已超限导致迁移本身失败 | 迁移分批事务 + 失败回滚到 v1 只读模式 |
| 纯前端编排：关页即停 | 明确产品语义"网页开着才推进"+ 持久化恢复兜底；中期把编排挪 FastAPI（底座已有） |
| LLM JSON 不稳定 | schema 校验 + 一次"修复重试"+ 保留 mock 兜底，且 UI 标注 source |
| ES 模块拆分引入回归 | 机械搬移不改逻辑、每模块冒烟、_backup_v4 随时可回退 |
| file:// 使用习惯被打破 | start.command 一键启动 + 文档更新 |
| 视觉升级范围蔓延 | P4 锁清单、超出项进 backlog |
| 多人同用一份 IndexedDB 的幻觉 | 明确"单机数据"提示 + 导出/导入；多人协作排期到后端同步期 |

---

## 9. 总验收标准

1. 仓库与产物中无任何明文 Key；旧 Key 已作废。
2. 图文链路（手动 + Agent 批量）端到端可演示，全程刷新可续。
3. Agent 工作区独立沉浸：三栏布局、会话持久化回放、计划确认环、批次可恢复、对话内回传。
4. 视频链路在 MockProvider 下全状态可走；ProviderAdapter 接口 + 接入文档就绪，接真 API 仅需新增一个 adapter 文件。
5. 全站单一任务模型：首页/看板/交付中心/供应商端同一数据源，状态语言一致。
6. 视觉：单一 token 来源、零 emoji 图标、统一 stepper、空/载/错三态成体系、⌘K 可用。
7. 性能底线：50 账号 × 200 任务 × 500 资产下，启动 < 2s、页面切换无可感卡顿。

---

## 10. 待你拍板的 4 个决策

| # | 问题 | 选项 A（推荐） | 选项 B |
|---|------|--------------|--------|
| D1 | 代码组织 | ES Modules 拆分（需 http 启动，双击 index.html 失效） | 维持单文件，仅做分区整理（后续维护持续付费） |
| D2 | 外壳重构幅度 | 图标导航栏 + 上下文面板（信息架构升级到位） | 保留现左栏账号列表，仅视觉翻新（快但天花板低） |
| D3 | LLM 调用路径 | 默认走本地 FastAPI `/api/llm`（需起 uvicorn，Key 进环境变量） | 浏览器直连 + 设置页填 Key（仅限单机自用） |
| D4 | "发布"措辞 | 全站改「定稿 / 交付」（贴合内部工具定位） | 保留"发布"叫法 |

确认 D1–D4 后即可按 P0 → P1 → P2 → P3 → P4 开工；P0+P1 完成时图文链路即全通，P2 完成时 Agent 工作区成型。
