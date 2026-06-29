/* 产品知识库种子：我们的产品 + 竞品/同类产品。
   用于选题、脚本、图文提示词和发布文案的产品视角，不替代账号风格。 */

const now = () => Date.now();

export const PRODUCT_CATALOG_VERSION = "20260629-product-db-v1";

export const PRODUCT_CATALOG_SEED = [
  {
    id: "dumate",
    owner: "ours",
    name: "Dumate / 百度搭子",
    shortName: "Dumate",
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
    comparisonAngles: ["和 TRAE Builder 的区别", "和 Manus 交付网页/报告的区别", "和 Cursor/Codex 写代码路线的区别", "和 DuMate 桌面执行路线的分工"],
    blogAngles: ["不会代码也能做一个能用的小工具", "AI 应用生成更适合验证想法", "秒哒负责生成应用，搭子负责处理本地任务"],
    visualAngles: ["一句需求到页面原型", "页面/数据表/发布按钮三段流程", "非技术人拖拽修改应用", "活动页和后台数据表对照"],
    competitors: ["trae", "manus", "cursor", "codex"],
    toneRule: "像真实产品体验笔记：讲清适合谁、能做什么小应用、哪里仍需要人工确认；不要夸成万能开发者。",
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
    comparisonAngles: ["和 DuMate 的本地执行路线对比", "和 Manus 的 Web 自动化路线对比", "和 Codex/Claude Code 的代码任务路线对比"],
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
    comparisonAngles: ["和 Claude Code 的工程任务对比", "和 Cursor 的 IDE 体验对比", "和 DuMate 的办公执行边界对比"],
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
    comparisonAngles: ["和 DuMate 的执行型 Agent 对比", "和 Notion/飞书的协作型知识库对比", "和 Manus 的交付型 Agent 对比"],
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
    comparisonAngles: ["和 DuMate 的本地桌面执行对比", "和秒哒的应用生成对比", "和 OpenClaw 的本地个人中枢对比"],
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
    comparisonAngles: ["和 DuMate 的桌面执行能力对比", "和 Manus 的 Web 任务交付对比", "和 Obsidian 的知识沉淀对比"],
    blogAngles: ["办公 AI 不该只比聊天质量", "真正要测的是交付物和权限边界", "同类工具适合做横向测评选题"],
    visualAngles: ["工具能力表格", "办公任务前后对比", "多产品边界对照卡"],
    competitors: ["dumate", "manus", "obsidian"],
    toneRule: "作为未深调研竞品使用时必须克制：只做同类框架对比，不编造具体未确认功能。",
    needsResearch: true,
    updatedAt: now()
  }
];

export function mergeProductCatalog(existing = []) {
  const byId = new Map();
  PRODUCT_CATALOG_SEED.forEach(p => byId.set(p.id, { ...p }));
  (existing || []).forEach(p => {
    if (!p || !p.id) return;
    const seeded = byId.get(p.id);
    byId.set(p.id, seeded ? { ...seeded, ...p, updatedAt: p.updatedAt || seeded.updatedAt } : { ...p });
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

export function relatedProducts(product, all = [], limit = 4) {
  if (!product) return (all || []).filter(p => p.owner === "competitor").slice(0, limit);
  const ids = new Set(product.competitors || []);
  const chosen = (all || []).filter(p => ids.has(p.id));
  if (chosen.length >= limit) return chosen.slice(0, limit);
  const same = (all || []).filter(p => p.id !== product.id && p.owner === "competitor" && p.category === product.category);
  const fill = (all || []).filter(p => p.id !== product.id && p.owner === "competitor");
  return [...new Map([...chosen, ...same, ...fill].map(p => [p.id, p])).values()].slice(0, limit);
}
