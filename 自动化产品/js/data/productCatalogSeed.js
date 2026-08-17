/* 产品知识库种子：我们的产品 + 竞品/同类产品。
   用于选题、脚本、图文提示词和发布文案的产品视角，不替代账号风格。 */

const now = () => Date.now();

export const PRODUCT_CATALOG_VERSION = "20260817-product-db-v6-baige-token-plan-night";

export const PRODUCT_CATALOG_SEED = [
  {
    id: "dumate",
    owner: "ours",
    name: "百度搭子",
    shortName: "百度搭子",
    category: "桌面办公 AI Agent",
    brief: "百度推出的桌面级 AI 办公智能体，能看见屏幕、操作本地软件、处理文件、提取信息、分析数据、生成汇报，并把重复办公流程沉淀成可复用 Skills。",
    coreFeatures: ["本地桌面执行", "文件整理", "格式转换", "信息提取", "数据分析", "办公自动化", "权限确认"],
    tutorialAngles: ["把乱文件夹自动归档", "从合同/纪要里提取字段", "把表格数据整理成汇报", "让重复网页流程自动跑"],
    comparisonAngles: ["和 Obsidian 的知识沉淀路线对比", "和 Manus 的任务交付路线对比", "和纯聊天 AI 的区别", "和 WorkBuddy 的办公场景对比"],
    blogAngles: ["Obsidian 负责沉淀知识，百度搭子负责执行桌面任务", "桌面智能体不是聊天框", "AI 真正帮人省时间的是执行流程", "文件和表格类任务最容易看出差异"],
    visualAngles: ["杂乱桌面到整洁结果", "输入一句话后文件卡片自动归类", "处理前后对比表格", "权限确认与本地文件夹授权"],
    competitors: ["obsidian", "manus", "openclaw", "workbuddy", "trae"],
    toneRule: "可信、理性、有梗、像真实用户经验分享；先讲场景和问题，再自然出现产品，不要硬广，不要强 CTA。",
    updatedAt: now()
  },
  {
    id: "miaoda",
    owner: "ours",
    name: "百度秒哒",
    shortName: "秒哒",
    category: "无代码 AI 应用生成",
    brief: "百度智能云的无代码 AI 应用生成平台，用户用自然语言描述需求，系统拆解页面、流程、数据结构和交互逻辑，生成 H5、网站、小游戏、轻应用和移动 APP。",
    coreFeatures: ["自然语言生成应用", "无代码拖拽调整", "多智能体协作", "前后端与数据库生成", "H5/APP/小程序发布"],
    tutorialAngles: ["一句话生成活动报名页", "从 Excel 需求变成 H5 工具", "普通人做轻量 CRM", "快速验证一个产品原型"],
    comparisonAngles: ["和 TRAE Builder 的区别", "和 Manus 交付网页/报告的区别", "和 Cursor/Codex 写代码路线的区别", "和百度搭子桌面执行路线的分工"],
    blogAngles: ["不会代码也能做一个能用的小工具", "AI 应用生成更适合验证想法", "秒哒负责生成应用，搭子负责处理本地任务"],
    visualAngles: ["一句需求到页面原型", "页面/数据表/发布按钮三段流程", "非技术人拖拽修改应用", "活动页和后台数据表对照"],
    competitors: ["trae", "manus", "cursor", "codex"],
    toneRule: "像真实产品体验笔记：讲清适合谁、能做什么小应用、哪里仍需要人工确认；不要夸成万能开发者。",
    updatedAt: now()
  },
  {
    id: "baige",
    owner: "ours",
    name: "百度百舸 6.0",
    shortName: "百度百舸",
    keywords: ["百舸", "百舸6.0", "百度百舸", "百度百舸6.0", "具身智能 AI Infra"],
    category: "具身智能 AI Infra 与工具链",
    brief: "百度百舸 6.0 是百度智能云面向具身智能推出的全流程 AI Infra，覆盖数据生产、开发训练、仿真评测和推理四个环节，通过开箱即用的工作流、主流模型与仿真环境适配以及训练、仿真、推理性能优化，帮助团队从单点研发走向规模化落地。",
    coreFeatures: [
      "数据生成、分布式处理、多模态清洗标注、质量评估与长尾仿真补充",
      "RealOmni-Open DataSet 接入以及具身预训练、技能泛化和长程任务验证",
      "VLM、VLA、WAM、世界模型和强化学习的云端开发训练工作流",
      "LoongForge 全模态训练框架与 GPU、昆仑芯 XPU 多模态训练加速",
      "Isaac、Maniskill3、RoboTwin2 等仿真评测环境预置与快速适配",
      "NVIDIA SONIC、CLOT、RLinf v0.3 等运控与持续进化链路",
      "Cosmos 系列、AHA-WAM 等具身模型训练与推理优化",
      "vLLM-Kunlun 主流大模型推理适配"
    ],
    verifiedFacts: [
      "RealOmni-Open DataSet 超过 1 万小时、100 万条以上真实操作记录，覆盖 10 个场景任务、30+ 技能和 3000+ 真实家庭场景，长程任务占比超过 99.2%",
      "LoongForge 基于 Megatron 深度定制，已在 GPU 与昆仑芯 XPU 两大平台、数千卡规模集群上完成长期生产验证",
      "LoongForge DP 负载均衡在 DP256 规模下性能提升约 3.3%，DP512 超大规模场景下提升接近 10%",
      "LoongForge 针对 Qwen3-VL 32k 序列长度、4 机异构并行优化，Level 3 相比基线提升约 12.5%",
      "LoongForge 优化 GR00T N1.6 后训练吞吐达到 2.3 倍，训练周期减少 56.6%",
      "Cosmos3-Nano-Policy-DROID 采用 1 台训练实例加 2 台编码实例时，约 1.5 倍硬件投入获得 2.1 倍吞吐，同样预算可多获得约 35% 训练吞吐",
      "LoongForge 多模态训练提速 45%，面向多模态 VLM 的 SFT 训练加速方案提速 5–6 倍",
      "Newton 物理引擎替换 PhysX 后，强化学习吞吐提升接近 50%",
      "dVLA-RL 在 LIBERO Benchmark 平均任务成功率达到 99.7%，在 RoboTwin 2.0 上从 61.4% 提升至 92.0%",
      "AHA-WAM 单步动作推理延迟从 415 毫秒降至 41 毫秒，AHA-WAM-Flash 闭环推理频率达到 56.95Hz，真机多任务综合成功率达到 78.3%",
      "vLLM-Kunlun 已适配 Qwen、DeepSeek、GLM、MiMo 等 50+ 款主流大模型",
      "万卡集群有效训练时长达到 99.5%",
      "Offload + 动态 Fetch 机制可节省 32% 显存容量",
      "VLM 模型训练性能较社区版本提升 40%+",
      "世界模型训练性能提升 20%+，推理性能提升 36%+",
      "424B MoE VL 模型千卡训练 MFU 达 47%",
      "72B 多模态混训 Packing + CP 吞吐提升 1–5 倍",
      "Cosmos3-Nano-Policy-DROID 训练启动速度提升 89 倍、单机吞吐提升 99.3%、12 节点扩展效率达到 98.3%",
      "Cosmos3-Super 从 4 节点 32 卡扩展至 64 节点 512 卡，扩展效率达到 97.48%",
      "NVIDIA SONIC 训练 Recipe 支持运控策略参数从 1M 扩展到 40M，并可一键扩展至 128 卡训练",
      "已支撑北京、上海、浙江、广东等多地具身智能创新中心建设；最新材料口径为服务超过 30 家具身智能头部企业及创新中心"
    ],
    forbiddenClaims: ["不得把某一模型、硬件或训练规模下的性能数据外推为所有场景的统一效果", "不得省略最高、约、接近、特定规模等原始指标口径", "不得虚构未在产品资料中出现的客户名称、商业承诺或功能"],
    tutorialAngles: ["具身智能数据、训练、仿真、推理四阶段如何串起来", "RealOmni 如何补充真实操作与长程任务数据", "LoongForge 如何解决多模态训练负载不均", "小显存场景如何使用 Offload + 动态 Fetch", "Isaac、Maniskill3、RoboTwin2 仿真环境如何快速部署"],
    comparisonAngles: ["从单点训练工具到全流程 AI Infra 的边界", "GPU 与昆仑芯 XPU 多模态训练适配", "数据、训练、仿真、推理四环节的工程成本对照", "LoongForge 同构并行与异构训练的资源效率差异"],
    blogAngles: ["具身智能落地为什么先卡在 AI Infra", "开发环境从数天压缩到分钟级意味着什么", "RealOmni 为什么从机器人采集转向真实人类操作", "LoongForge 如何把多模态训练提速 45%", "仿真不只是演示，它还在补长尾数据"],
    visualAngles: ["数据生产→开发训练→仿真评测→推理四段流程", "RealOmni 1 万小时、100 万条操作数据卡", "机器人仿真环境与训练集群对照", "LoongForge 45% 多模态训练提速与 5–6 倍 SFT 加速数据卡", "AHA-WAM 415ms→41ms 延迟对比"],
    competitors: [],
    sourceDocument: "百度百舸产品信息与数据汇总-2.md",
    toneRule: "优先使用产品库中明确记录的能力和数据；涉及 LoongForge、RealOmni、Cosmos、dVLA-RL、AHA-WAM 时必须保留对应模型、硬件、规模或评测口径，不把局部性能外推为通用承诺。",
    updatedAt: now()
  },
  {
    id: "token-plan",
    owner: "ours",
    name: "百度千帆 Token Plan",
    shortName: "Token Plan",
    keywords: [
      "Token Plan",
      "TokenPlan",
      "百度千帆 Token Plan",
      "百度千帆Token Plan",
      "千帆 Token Plan",
      "千帆Token Plan",
      "夜享计划",
      "夜享 Tokens 加赠计划",
      "夜享Tokens加赠计划"
    ],
    category: "AI 模型订阅与算力套餐",
    contentCategoryLabel: "AI 模型订阅与算力套餐",
    contentAliases: ["Token Plan", "AI 模型订阅", "算力套餐", "这个套餐"],
    brief: [
      "百度千帆 Token Plan 是面向个人开发者、AI 重度用户与企业团队的 AI 模型订阅和算力套餐，包含个人版与企业版。个人版定位为“个人的 AI 算力流量包”，在 Coding Plan 基础上升级为灵活额度、全场景通用、按需消耗的 Token 量包；企业版定位为企业级 AI 生产力订阅服务，采用“席位制 + 企业共享积分包”和 Credits 积分体系，支持统一采购、管理与运营。",
      "8 月 14 日起上线“夜享 Tokens 加赠计划”（简称夜享计划）：个人版与企业版全量有效订阅用户每天 21:00 至次日 08:00，在套餐内调用明确指定的 4 款模型时按 2 折消耗，约等于节省 80% 成本或获得约 5 倍调用量；无需申请、无需配置、订阅即享。个人版表述为 1 Token 抵 5 Tokens，企业版必须表述为 1 积分抵 5 积分。夜间 2 折只明确覆盖 GLM-5.2、DeepSeek-V4-Flash-0731、DeepSeek-V4-Pro、DeepSeek-V4-Flash-0423，不得扩大到其他模型。",
      "个人版四档月额度：Mini 尝鲜版 1000 万 Token、Lite 标准版 4200 万 Token、Pro 进阶版 2.3 亿 Token、Max 专业版 7 亿 Token，分别面向轻度尝鲜、日常编码、高频 Coding 与重度 Agent 使用。个人版采用统一 Token 抵扣，不区分模型倍率、输入输出或缓存命中；取消原 Coding Plan 三层滑动窗口限流；模型可切换；兼容 OpenAI 与 Anthropic 双协议，并提供与后付费和企业版隔离的个人版 API Key 及用量统计。首购活动口径为每日 10 点开放、每日限量、五折秒杀，最低 4.9 元解锁 1000 万 Token。",
      "企业版轻享版、标准版、高级版原月额度分别为 2 万、6 万、15 万积分，分别加赠 5000、1 万、2.5 万积分，升级后为 2.5 万、7 万、17.5 万积分；新增尊享版为每月 25 万积分。企业版支持成员管理、席位分配与回收、共享积分包、用量统计和告警提醒；百度千帆承诺不使用用户数据进行模型训练与服务优化，并提供企业级数据安全管理与权限控制。",
      "Token Plan 个人版当前资料明确列出的支持模型包括 GLM-5.2、GLM-5.1、Kimi-K2.6、ERNIE-5.1、DeepSeek-V4-Pro、DeepSeek-V4-Flash-0423、DeepSeek-V4-Flash-0731；其中只有前述 4 款享受夜间 2 折。企业版支持全模态、多模型并以 Credits 统一抵扣。",
      "同期加入 Token Plan 的 DeepSeek-V4-Flash-0731 在架构与参数规模不变的前提下通过重新后训练提升 Agent 与代码能力：总参数 2840 亿、激活参数 130 亿、支持 100 万 Token 上下文和思考/非思考双模式；9 项 Agent 基准全面超越前代预览版，Artificial Analysis 智能指数 50 分、较此前高 10 分；Frontend Code Arena 只能写“稳居开放类别前列”，不得写第一或榜首。",
      "接入流程为订阅套餐、在“我的订阅”获取专属 API Key 和 Base URL、配置到 AI 工具。个人版 OpenAI 兼容 Base URL 为 https://qianfan.baidubce.com/v2/tokenplan/personal，Anthropic 兼容 Base URL 为 https://qianfan.baidubce.com/anthropic/tokenplan/personal；已兼容 Cursor、Windsurf、Cline、Cherry Studio、Kilo CLI 等 10 余种主流 AI Coding 工具及智能体框架。"
    ].join("\n\n"),
    coreFeatures: [
      "个人版与企业版统一覆盖的 AI 模型订阅和算力套餐",
      "夜享计划每日 21:00 至次日 08:00 指定模型按 2 折消耗",
      "个人版统一 Token 抵扣且取消原 Coding Plan 三层滑动窗口限流",
      "个人版兼容 OpenAI 与 Anthropic 双协议并提供隔离 API Key",
      "企业版席位制、共享积分包、成员管理、用量统计和告警",
      "Cursor、Windsurf、Cline、Cherry Studio、Kilo CLI 等 10 余种工具兼容",
      "DeepSeek-V4-Flash-0731 支持 100 万 Token 上下文和双模式"
    ],
    verifiedFacts: [
      "夜享 Tokens 加赠计划自 8 月 14 日起生效，每日 21:00 至次日 08:00，共 11 小时",
      "夜间 2 折仅明确适用于 GLM-5.2、DeepSeek-V4-Flash-0731、DeepSeek-V4-Pro、DeepSeek-V4-Flash-0423",
      "个人版与企业版全量有效订阅用户无需额外申请或配置即可享受夜享计划",
      "个人版 Mini、Lite、Pro、Max 月额度依次为 1000 万、4200 万、2.3 亿、7 亿 Token",
      "企业版轻享、标准、高级升级后月额度为 2.5 万、7 万、17.5 万积分，新增尊享版为 25 万积分",
      "DeepSeek-V4-Flash-0731 总参数 2840 亿、激活参数 130 亿、支持 100 万 Token 上下文",
      "个人版支持 OpenAI 与 Anthropic 双协议以及 10 余种主流 AI Coding 工具和 Agent 框架",
      "企业版采用 Credits 积分体系，并承诺不使用用户数据进行模型训练与服务优化"
    ],
    forbiddenClaims: [
      "不得把夜间 2 折扩大到资料未明确覆盖的模型、按量后付费调用或无效订阅用户",
      "企业版必须使用 Credits 积分口径，不得写成企业版 Token 余额",
      "Frontend Code Arena 只能写稳居开放类别前列，不得写第一、榜首或冠军",
      "不得把首购 4.9 元、五折、每日限量等活动口径写成永久价格或无限库存",
      "不得虚构资料中未给出的企业版发布时间、客户名称、全模型夜享折扣或额外安全承诺"
    ],
    tutorialAngles: [
      "如何在每天 21:00 后把 Agent 长链路任务切到夜享时段",
      "个人版 OpenAI 与 Anthropic 双协议三步接入教程",
      "Mini、Lite、Pro、Max 四档额度怎么按使用强度选择",
      "企业如何用席位与共享积分包统一管理分散采购",
      "DeepSeek-V4-Flash-0731 如何在 Token Plan 中直接调用"
    ],
    comparisonAngles: [
      "个人版统一 Token 抵扣与传统模型倍率计费的差异",
      "个人版 Token 量包与企业版 Credits 共享积分包的边界",
      "白天正常消耗与夜间 2 折时段的任务调度差异",
      "Token Plan 与原 Coding Plan 三层滑动窗口限流的变化"
    ],
    blogAngles: [
      "别把夜享计划写成全模型打折：真正覆盖的是哪 4 款",
      "让 Agent 深夜跑长链路任务，为什么同一额度能支撑约 5 倍调用量",
      "从个人算力流量包到企业 AI 生产力订阅，Token Plan 的两套口径",
      "DeepSeek-V4-Flash-0731 与夜享计划为什么适合一起讲"
    ],
    visualAngles: [
      "21:00→次日08:00 的 11 小时时间轴与 2 折数据卡",
      "4 款夜享模型清单与不可扩大的边界提示",
      "个人版四档 Token 额度阶梯",
      "企业版原额度、赠送额度和升级后额度对照表",
      "订阅→获取 API Key/Base URL→接入工具三步流程"
    ],
    competitors: ["codex", "claude-code", "cursor", "windsurf", "trae"],
    sourceDocument: "Token Plan夜享计划-产品知识库.md",
    sourceDigest: "54c8abcbe863e4ad74bb1e86d92f05340ac4a72ac4230fb99aebc116ff9f4532",
    toneRule: "产品全称优先写“百度千帆 Token Plan”，简称可写“Token Plan”；夜享活动全称为“夜享 Tokens 加赠计划”、简称“夜享计划”。所有时间、折扣、模型、额度、价格、榜单和安全表述必须保留资料口径，不把活动利益扩大为全模型或永久承诺。",
    updatedAt: now()
  },
  {
    id: "openclaw",
    owner: "competitor",
    name: "OpenClaw",
    shortName: "OpenClaw",
    category: "本地个人 AI Agent",
    brief: "开源、本地优先的个人 AI 助手平台，把多聊天入口、浏览器、系统工具、文件、技能和多 Agent 路由整合成个人 AI 中枢。",
    coreFeatures: ["本地优先", "多渠道聊天入口", "多 Agent 路由", "工具流式输出", "多模型供应商", "浏览器与系统工具"],
    tutorialAngles: ["把多个聊天入口统一到一个助手", "本地 Agent 怎么管理文件和工具", "用 Skills 扩展个人 AI 工作台"],
    comparisonAngles: ["和百度搭子的本地执行路线对比", "和 Manus 的 Web 自动化路线对比", "和 Codex/Claude Code 的代码任务路线对比"],
    blogAngles: ["私人 AI 助手中枢为什么重要", "开源 Agent 更适合重视隐私的人", "多入口会不会成为 Agent 标配"],
    visualAngles: ["消息入口汇聚到中枢", "工具调用流式过程", "本地文件和浏览器工具面板"],
    competitors: ["dumate", "manus", "codex"],
    toneRule: "偏中立测评，强调开源、本地、可扩展，也提醒配置门槛。",
    updatedAt: now()
  },
  {
    id: "codex",
    owner: "competitor",
    name: "OpenAI Codex",
    shortName: "Codex",
    category: "编程 Agent",
    brief: "OpenAI 的软件开发 Agent，覆盖本地 CLI、云端任务和代码审查，面向理解代码库、修改代码、运行测试、交付 PR 的工程流程。",
    coreFeatures: ["代码库理解", "本地 CLI", "云端并行任务", "代码审查", "Skills", "Automations"],
    tutorialAngles: ["把一个 bug 交给 Codex 修", "让 AI 跑测试再交付 PR", "用 Skills 固定项目规则"],
    comparisonAngles: ["和 Claude Code 的工程任务对比", "和 Cursor 的 IDE 体验对比", "和百度搭子的办公执行边界对比"],
    blogAngles: ["AI 写代码不够，关键是能验证", "本地和云端 Agent 如何分工", "真正的 AI 程序员应该会审查变更"],
    visualAngles: ["issue 到 PR 流程", "终端测试结果", "代码 diff 与审查意见"],
    competitors: ["claude-code", "cursor", "github-copilot", "windsurf"],
    toneRule: "工程化、克制、看结果；不要把代码 Agent 和通用办公 Agent 混成一类。",
    updatedAt: now()
  },
  {
    id: "claude-code",
    owner: "competitor",
    name: "Claude Code",
    shortName: "Claude Code",
    category: "编程 Agent",
    brief: "Anthropic 的 agentic coding 系统，可读代码库、改文件、跑命令和测试，并在 CLI、IDE、桌面、浏览器等界面完成开发任务。",
    coreFeatures: ["代码库搜索", "多文件修改", "运行命令和测试", "Git 工作流", "CLAUDE.md 记忆", "MCP", "子代理"],
    tutorialAngles: ["用 CLAUDE.md 固定团队规则", "让 Claude Code 自己跑测试", "多代理并行排查复杂问题"],
    comparisonAngles: ["和 Codex 的工作流差异", "和 Cursor 的 IDE 体验差异", "和 GitHub Copilot 的 PR 流程差异"],
    blogAngles: ["AI 编程工具的差别不只是模型", "项目记忆为什么影响 Agent 稳定性", "复杂代码任务需要计划和验证"],
    visualAngles: ["终端执行链路", "测试失败到修复", "项目记忆文件和 diff"],
    competitors: ["codex", "cursor", "github-copilot", "windsurf"],
    toneRule: "偏工程经验分享，强调真实修复和测试闭环。",
    updatedAt: now()
  },
  {
    id: "cursor",
    owner: "competitor",
    name: "Cursor",
    shortName: "Cursor",
    category: "AI IDE",
    brief: "面向软件开发的 AI 编辑器和 coding agent，主打代码库索引、Agent/Ask/Plan/Debug、语义搜索、终端和可视化 diff。",
    coreFeatures: ["Agent 模式", "Ask/Plan/Debug", "代码库索引", "语义搜索", "终端工具", "Checkpoint"],
    tutorialAngles: ["大型项目怎么让 AI 找入口", "Ask/Plan/Agent 到底怎么选", "用 Checkpoint 安全试改代码"],
    comparisonAngles: ["和 Codex/Claude Code 的任务级执行对比", "和 GitHub Copilot 的平台原生对比", "和 TRAE 的 Builder 路线对比"],
    blogAngles: ["AI IDE 的核心是上下文", "语义搜索和 grep 各适合什么", "从补全到 Agentic coding"],
    visualAngles: ["编辑器侧栏对话", "代码索引和语义搜索", "diff 与 checkpoint"],
    competitors: ["codex", "claude-code", "github-copilot", "windsurf", "trae"],
    toneRule: "面向开发者，讲具体使用场景和边界。",
    updatedAt: now()
  },
  {
    id: "windsurf",
    owner: "competitor",
    name: "Windsurf / Devin Desktop",
    shortName: "Windsurf",
    category: "AI IDE / 本地 Coding Agent",
    brief: "代码编辑器与本地 Agent 组合，强调 Cascade、Devin Local、上下文检索、Tab 补全、终端工具和插件生态。",
    coreFeatures: ["Cascade", "Devin Local", "Write/Chat 模式", "Tab 补全", "上下文引擎", "自动执行模式"],
    tutorialAngles: ["Auto/Turbo 自动执行该怎么开", "Cascade 和 Cursor Agent 区别", "Tab 不只是补代码还能跳转"],
    comparisonAngles: ["和 Cursor 的 IDE 心流对比", "和 Devin/Claude Code 的本地 Agent 对比", "和 Copilot 的平台工作流对比"],
    blogAngles: ["AI 编程工具开始争夺编码心流", "自动跑命令要不要放权", "插件生态会影响团队迁移成本"],
    visualAngles: ["IDE 内 Cascade 面板", "自动执行模式开关", "Tab 补全和跳转"],
    competitors: ["cursor", "codex", "claude-code", "github-copilot"],
    toneRule: "偏工具体验测评，避免简单排名，讲适合谁。",
    updatedAt: now()
  },
  {
    id: "github-copilot",
    owner: "competitor",
    name: "GitHub Copilot",
    shortName: "Copilot",
    category: "GitHub 原生开发 Agent",
    brief: "GitHub 原生 AI 开发助手，覆盖代码建议、Chat、IDE Agent、Cloud Agent、代码审查、Skills、Custom Agents 和 Actions 环境任务。",
    coreFeatures: ["Copilot Chat", "IDE Agent", "Cloud Agent", "Issue 到 PR", "代码审查", "GitHub Actions 环境"],
    tutorialAngles: ["把 GitHub Issue 分配给 AI", "AI 先写 PR 再自审", "Cloud Agent 和 IDE Agent 怎么分工"],
    comparisonAngles: ["和 Codex 云端任务对比", "和 Cursor IDE 体验对比", "和 Claude Code 终端工作流对比"],
    blogAngles: ["AI Agent 进入团队协作流程", "开发任务异步化之后谁来验收", "平台原生是 Copilot 的最大优势"],
    visualAngles: ["Issue 分配给 AI", "PR diff 和 review 评论", "Actions 运行日志"],
    competitors: ["codex", "claude-code", "cursor", "windsurf"],
    toneRule: "偏团队协作视角，强调透明、审查和 CI。",
    updatedAt: now()
  },
  {
    id: "trae",
    owner: "competitor",
    name: "TRAE",
    shortName: "TRAE",
    category: "AI IDE / 工作助手",
    brief: "AI 原生 IDE 与工作助手组合，包含 TRAE IDE、TRAE Work、Builder、SOLO 等能力，覆盖项目生成、多文件上下文和交付物预览。",
    coreFeatures: ["Builder", "SOLO", "多文件上下文", "Webview 预览", "历史回退", "云端并行任务"],
    tutorialAngles: ["把 PRD 扔给 TRAE 生成可预览页面", "Builder 和 SOLO 该怎么选", "多文件资料怎么变成交付物"],
    comparisonAngles: ["和秒哒的无代码应用生成对比", "和 Cursor 的开发主场对比", "和 Manus 的通用任务对比"],
    blogAngles: ["AI IDE 和 AI 工作助手正在合体", "从需求到预览是 AI 应用生成的关键", "项目型任务要看能不能回退和预览"],
    visualAngles: ["需求文档到预览页面", "Builder 任务步骤", "多文件上下文面板"],
    competitors: ["miaoda", "cursor", "manus", "codex"],
    toneRule: "讲清开发/办公两种场景，不把它当纯聊天工具。",
    updatedAt: now()
  },
  {
    id: "obsidian",
    owner: "competitor",
    name: "Obsidian",
    shortName: "Obsidian",
    category: "知识库 / PKM",
    brief: "本地优先的 Markdown 知识管理工具，主打双链、Graph、Canvas、Bases、插件生态和可扩展工作流，常作为 AI 内容团队的知识底座。",
    coreFeatures: ["本地 Markdown", "双向链接", "Graph", "Canvas", "Bases", "插件生态", "Sync/Publish"],
    tutorialAngles: ["把资料堆变成选题库", "Canvas/Bases 怎么服务内容团队", "Obsidian + AI 做 RAG 问答"],
    comparisonAngles: ["和百度搭子的执行型 Agent 对比", "和 Notion/飞书的协作型知识库对比", "和 Manus 的交付型 Agent 对比"],
    blogAngles: ["AI 内容团队为什么需要知识底座", "本地文件比云笔记更适合长期沉淀吗", "知识库不是 Agent，但能喂给 Agent"],
    visualAngles: ["双链图谱", "Canvas 资料墙", "Bases 数据表视图"],
    competitors: ["dumate", "manus", "openclaw"],
    toneRule: "知识管理视角，强调沉淀、检索和复用，不把它包装成原生 Agent。",
    updatedAt: now()
  },
  {
    id: "manus",
    owner: "competitor",
    name: "Manus",
    shortName: "Manus",
    category: "通用任务 Agent",
    brief: "面向交付完成品的通用 AI Agent，通过浏览器、文件系统、代码执行和技能完成研究、报告、PPT、网页、表格等任务。",
    coreFeatures: ["Cloud Browser", "Browser Operator", "登录态任务", "文件交付", "Agent Skills", "云端沙箱"],
    tutorialAngles: ["让 Agent 做一份调研报告", "Browser Operator 为什么需要用户接管", "把一次流程封装成 Skills"],
    comparisonAngles: ["和百度搭子的本地桌面执行对比", "和秒哒的应用生成对比", "和 OpenClaw 的本地个人中枢对比"],
    blogAngles: ["AI Agent 的分水岭是回答还是交付", "Web 自动化和本地桌面自动化各适合什么", "登录态任务需要权限边界"],
    visualAngles: ["浏览器自动操作", "报告/PPT/表格交付物", "任务执行进度"],
    competitors: ["dumate", "miaoda", "openclaw", "trae"],
    toneRule: "偏任务交付测评，既讲能力也讲授权和接管边界。",
    updatedAt: now()
  },
  {
    id: "workbuddy",
    owner: "competitor",
    name: "WorkBuddy",
    shortName: "WorkBuddy",
    category: "AI 办公助手",
    brief: "面向职场办公的同类 AI 助手占位产品，适合放入办公效率、知识整理、任务协作和团队资料处理类对比选题；具体功能发稿前需要再核对官方信息。",
    coreFeatures: ["办公效率", "资料整理", "任务协作", "文档/表格辅助", "团队工作流"],
    tutorialAngles: ["AI 办公助手怎么帮人少做重复整理", "资料整理类工具到底看哪些指标", "办公 AI 适合单人还是团队"],
    comparisonAngles: ["和百度搭子的桌面执行能力对比", "和 Manus 的 Web 任务交付对比", "和 Obsidian 的知识沉淀对比"],
    blogAngles: ["办公 AI 不该只比聊天质量", "真正要测的是交付物和权限边界", "同类工具适合做横向测评选题"],
    visualAngles: ["工具能力表格", "办公任务前后对比", "多产品边界对照卡"],
    competitors: ["dumate", "manus", "obsidian"],
    toneRule: "作为未深调研竞品使用时必须克制：只做同类框架对比，不编造具体未确认功能。",
    needsResearch: true,
    updatedAt: now()
  }
];

function normalizeDumateText(value) {
  if (typeof value === "string") return value.replace(/\bDuMate\b/gi, "百度搭子").replace(/\bDumate\b/gi, "百度搭子");
  if (Array.isArray(value)) return value.map(normalizeDumateText);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "id" ? v : normalizeDumateText(v)]));
  }
  return value;
}

function normalizeProductDisplay(product = {}) {
  if (product.id !== "dumate") return product;
  const cleaned = normalizeDumateText(product);
  return {
    ...cleaned,
    name: "百度搭子",
    shortName: "百度搭子"
  };
}

export function mergeProductCatalog(existing = []) {
  const byId = new Map();
  PRODUCT_CATALOG_SEED.forEach(p => byId.set(p.id, normalizeProductDisplay({ ...p })));
  (existing || []).forEach(p => {
    if (!p || !p.id) return;
    const seeded = byId.get(p.id);
    const managedSeed = ["baige", "token-plan"].includes(seeded?.id);
    byId.set(p.id, normalizeProductDisplay(seeded
      ? (managedSeed ? { ...p, ...seeded } : { ...seeded, ...p, updatedAt: p.updatedAt || seeded.updatedAt })
      : { ...p }));
  });
  return [...byId.values()];
}

export function productByKey(products = [], key = "") {
  const q = String(key || "").trim().toLowerCase();
  if (!q) return null;
  return (products || []).find(p => {
    const text = [p.id, p.name, p.shortName, ...(p.keywords || [])].join(" ").toLowerCase();
    return text.includes(q);
  }) || null;
}

function normalizedProductMention(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·•._/｜|、，,。:：；;（）()【】\[\]-]+/g, "");
}

export function catalogProductForText(products = [], text = "", currentProduct = null) {
  const source = normalizedProductMention(text);
  if (!source) return currentProduct;
  const matched = (products || [])
    .filter(product => product?.owner === "ours")
    .flatMap(product => [
      product.name,
      product.shortName,
      product.id,
      ...(product.keywords || []),
    ].filter(Boolean).map(alias => ({
      product,
      alias: normalizedProductMention(alias),
    })))
    .filter(item => item.alias.length >= 2 && source.includes(item.alias))
    .sort((left, right) => right.alias.length - left.alias.length)[0];
  return matched?.product || currentProduct;
}

export function relatedProducts(product, all = [], limit = 4) {
  if (!product) return (all || []).filter(p => p.owner === "competitor").slice(0, limit);
  const ids = new Set(product.competitors || []);
  const chosen = (all || []).filter(p => ids.has(p.id));
  if (chosen.length >= limit) return chosen.slice(0, limit);
  const same = (all || []).filter(p => p.id !== product.id && p.owner === "competitor" && p.category === product.category);
  const fill = (all || []).filter(p => p.id !== product.id && p.owner === "competitor");
  return [...new Map([...chosen, ...same, ...fill].map(p => [p.id, p])).values()].slice(0, limit);
}
