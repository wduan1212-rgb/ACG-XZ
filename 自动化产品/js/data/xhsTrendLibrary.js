/* 小红书 AI 工具内容趋势库
   只保存可复用的标题结构、文案骨架和图卡节奏；线上搜索结果只作为补充灵感。 */

const SAFE_TITLE_PATTERNS = [
  "别再把 {thing} 当聊天框了",
  "{time} 跑完一个真实流程",
  "{toolA}+{toolB} 到底怎么分工",
  "真的有人日常用得到 {thing} 吗",
  "这一步交给 AI 后，我少做了很多重复活",
  "小白也能照着跑的 {scene} 流程",
  "我试了一圈，才发现关键不是工具多",
  "一图看懂 {toolA} 和 {toolB} 的边界",
  "别急着换工具，先把流程搭起来",
  "把 {scene} 从手动活变成固定流程"
];

const COPY_STRUCTURES = [
  {
    name: "实测复盘",
    flow: "一句结论 -> 真实场景 -> 具体动作 -> 结果证据 -> 边界提醒",
    opening: "我试了一圈，发现真正省时间的不是让 AI 多写几句，而是把重复流程固定下来。"
  },
  {
    name: "工具分工",
    flow: "先拆任务 -> 再说工具边界 -> 给一个组合流程 -> 最后提醒适合谁",
    opening: "这几个工具不是互相替代，更像一条工作流里的不同工位。"
  },
  {
    name: "避坑备忘",
    flow: "常见误区 -> 正确做法 -> 可复制句式 -> 复盘结论",
    opening: "很多人用 AI 低效，不是不会问，而是每次都从零开始交代。"
  },
  {
    name: "收藏清单",
    flow: "适用人群 -> 3 个可复用场景 -> 操作模板 -> 保存理由",
    opening: "这条适合先收藏：不是工具合集，而是一套能重复使用的小流程。"
  },
  {
    name: "反常识判断",
    flow: "反常识结论 -> 解释原因 -> 真实案例 -> 不适合场景",
    opening: "越是复杂的 AI 工具，越不能一上来就让它帮你包办所有事。"
  },
  {
    name: "前后对比",
    flow: "以前怎么做 -> 卡在哪一步 -> 现在怎么拆 -> 输出物长什么样",
    opening: "以前我以为耗时间的是写内容，后来才发现是整理、归类、复核这些杂活。"
  }
];

const TOPIC_SEEDS = [
  "桌面智能体 vs 聊天机器人：一个负责回答，一个负责执行",
  "Obsidian 负责沉淀知识，桌面智能体负责把本地资料跑成结果",
  "Codex 适合改代码，桌面智能体适合处理电脑里的办公流",
  "WorkBuddy/Manus 这类云端 Agent 和本地桌面执行的边界",
  "打工人周报、合同、表格、素材文件夹的重复整理流程",
  "AI 工具不是越多越好，关键是把任务拆成思考、沉淀、执行三层",
  "自媒体选题、素材归档、脚本复盘、发布清单的一人团队流程",
  "无代码应用生成适合做小工具原型，不等于桌面文件自动化",
  "知识库、文件夹、表格和聊天窗口之间的信息断层",
  "让 AI 交付可复核结果，而不是只给一段漂亮回答"
];

const IMAGE_RHYTHMS = [
  "封面只做点击入口：一个大标题、一句短副标题、一个简单符号/对比关系；不要表格、步骤和长说明。",
  "内页每张只讲一个动作或证据：问题现场、工具分工、执行动作、结果界面、边界提醒按顺序拆开。",
  "如果用户给的信息很多，先压缩成当前图数能承载的主线；不重要的信息舍弃或放进文案，不塞进图片。",
  "如果用户给的信息很少，补真实办公场景、适用人群、操作动作和结果证据，不要空泛宣传。",
  "简笔画/火柴人风格靠人物动作、表情、箭头和气泡讲逻辑；每张图文字更少，标题必须更大。",
  "模拟飞书/表格/文档风可以承载更多文字，但也要分层：标题区、主体截图区、结论标签区。"
];

const SAMPLES = [
  { title: "偷偷学：4个能替你上班的AI提效工具", hook: "工具清单 + 替你上班幻想", use: "适合做合集，但要落到具体任务，不照抄标题" },
  { title: "手把手搭建一个私人助理", hook: "教程承诺 + 私人助理", use: "适合新手流程，用步骤但别堆信息" },
  { title: "小白速通 Codex 安装 + 国产大模型接入", hook: "小白速通 + 具体对象", use: "适合教程标题，必须给真实门槛和边界" },
  { title: "AI+Obsidian不只是整理笔记，还能变工作助手", hook: "反常识 + 工具组合", use: "适合组合分工选题" },
  { title: "真的会有人日常工作用得到 AI Agent 吗", hook: "质疑式问题", use: "适合做边界判断和实测复盘" },
  { title: "让这些AI替我上班，早2小时下班", hook: "时间收益 + 夸张愿望", use: "可以借结构，但文案要克制避免夸大" },
  { title: "别再乱问了，36个公式直接用", hook: "纠错 + 可复制模板", use: "适合指令模板和 SOP 收藏" },
  { title: "4个热门AI Agent对比，到底怎么选", hook: "对比 + 怎么选", use: "适合适用场景，不做评分排名" }
];

function safeWords(s = "") {
  return String(s || "")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9+#/ 　-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTrendItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map(x => ({
      title: safeWords(x.title || x.name || "").slice(0, 50),
      likes: x.likes || x.like || x.stats || "",
      url: x.url || ""
    }))
    .filter(x => x.title)
    .slice(0, 8);
}

export function buildTrendSearchQuery({ topic = "", account = {}, product = null, batchVariant = null, kind = "image" } = {}) {
  const topicPart = safeWords(topic).replace(/百度搭子|百度秒哒|Dumate/gi, "").slice(0, 36);
  const accountPart = safeWords([account.name, account.styleProfile, account.position, ...(account.qtags || [])].filter(Boolean).join(" ")).slice(0, 28);
  const base = kind === "video" ? "AI办公 口播 小红书" : "AI办公 小红书 图文";
  const productPart = product?.id === "miaoda" ? "无代码 AI应用" : "AI Agent 桌面智能体 Obsidian Codex WorkBuddy";
  const variant = batchVariant?.name ? safeWords(batchVariant.name).slice(0, 12) : "";
  return [topicPart, accountPart, variant, productPart, base].filter(Boolean).join(" ").slice(0, 90);
}

export function buildTrendGuide({ topic = "", account = {}, product = null, batchVariant = null, onlineItems = [], kind = "image" } = {}) {
  const online = normalizeTrendItems(onlineItems);
  const titlePool = SAFE_TITLE_PATTERNS.slice(0, 8).join(" / ");
  const structures = COPY_STRUCTURES.slice(0, 6).map(x => `${x.name}：${x.flow}`).join("；");
  const seeds = TOPIC_SEEDS.slice(0, 8).join("；");
  const rhythm = IMAGE_RHYTHMS.join("；");
  const onlineLine = online.length
    ? `\n线上参考标题（只学钩子和结构，禁止照抄）：${online.map(x => `「${x.title}」`).join("、")}`
    : "";
  const styleHint = safeWords(account.styleProfile || account.position || "").slice(0, 100);
  const productHint = product?.id === "miaoda"
    ? "主产品是无代码 AI 应用生成/原型/页面和数据表方向；不要写成本地文件自动执行。"
    : "主产品是桌面智能体/本地执行/资料整理方向；可以和 Obsidian、Codex、WorkBuddy、Manus 等做分工或对比。";
  return [
    `趋势参考只用于启发，不得复制样本标题或文案。${productHint}`,
    topic ? `本次主题关键词：${safeWords(topic).slice(0, 80)}。` : "用户未填主题时，主动选择一个真实 AI 博主选题，不要重复“资料从乱到顺”。",
    batchVariant?.name ? `本条批量差异化角度：${batchVariant.name}，${batchVariant.structure || ""}` : "",
    styleHint ? `账号风格提示：${styleHint}。` : "",
    `标题钩子可参考：${titlePool}。标题和正文不要出现自家产品名，用品类词表达；竞品/互补工具名可自然出现。`,
    `文案骨架轮换：${structures}。同批不要重复标题类型、首句、分点符号和结尾标签。`,
    `选题池：${seeds}。`,
    kind === "image" ? `图卡节奏：${rhythm}` : "视频口播节奏：前3秒给问题或结论，中段给具体操作和证据，结尾给边界或复用建议。",
    onlineLine
  ].filter(Boolean).join("\n");
}

export const XHS_TREND_LIBRARY = {
  titlePatterns: SAFE_TITLE_PATTERNS,
  copyStructures: COPY_STRUCTURES,
  topicSeeds: TOPIC_SEEDS,
  imageRhythms: IMAGE_RHYTHMS,
  samples: SAMPLES
};
