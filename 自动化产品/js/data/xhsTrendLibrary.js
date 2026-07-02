/* 小红书趋势/选题预案库
   用途：联网搜索可用时吸收热门标题骨架；不可用时走本地五大投放方向。
   对外标题/文案不出现自家产品名；图像策略里统一使用中文产品名。 */

const OWN_PRODUCT_RE = /(Dumate|DuMate|MIAODA|百度搭子|百度秒哒|秒哒|搭子)/gi;
export const MIN_TREND_INTERACTIONS = 100;

export const XHS_TREND_LIBRARY = [
  {
    key: "negative_reversal",
    name: "反向吐槽到真香",
    search: "AI办公 打工人 效率 真香 桌面智能体",
    seeds: [
      "千万别再把AI只当聊天框",
      "一开始嫌麻烦，后来每天都用",
      "这个重复动作真的不用自己扛",
      "才发现AI工具不是拿来闲聊的"
    ],
    hooks: ["千万别", "一开始我也不信", "别再", "才发现"],
    structures: ["吐槽痛点 -> 真实动作 -> 结果反转 -> 适合谁", "误区 -> 新做法 -> 证据 -> 小技巧"]
  },
  {
    key: "comparison_choice",
    name: "强对比选型",
    search: "Codex WorkBuddy Obsidian AI Agent 怎么选",
    seeds: [
      "这类AI工具到底怎么分工",
      "不是谁更强，是该放在哪一步",
      "我终于分清这些工具怎么用",
      "别再用同一个AI解决所有问题"
    ],
    hooks: ["到底怎么选", "半个月分清楚了", "不是谁更强", "别再混用"],
    structures: ["场景边界 -> 工具分工 -> 组合流程 -> 适用人群", "问题 -> A适合 -> B适合 -> 一句结论"]
  },
  {
    key: "ecosystem_combo",
    name: "生态联动组合",
    search: "Obsidian AI Agent 组合 工作流 小红书",
    seeds: [
      "一个负责沉淀，一个负责执行",
      "知识库和桌面执行终于接上了",
      "把资料库变成能跑起来的流程",
      "这个组合适合长期做内容的人"
    ],
    hooks: ["王炸组合", "一个负责", "接上了", "长期记忆"],
    structures: ["A沉淀 -> B执行 -> 连接动作 -> 复用结果", "资料入口 -> 自动处理 -> 输出物 -> 下次复用"]
  },
  {
    key: "worker_efficiency",
    name: "打工人效率场景",
    search: "AI工具 周报 Excel 打工人 效率 小红书",
    seeds: [
      "写周报的时间终于能省一点",
      "表格和资料别再手动捋",
      "下班前最烦的活可以流程化",
      "每天重复整理文件的人先看这个"
    ],
    hooks: ["从1小时到10分钟", "写周报", "整理资料", "打工人"],
    structures: ["原来耗时 -> 卡在哪 -> 自动动作 -> 复核结果", "真实场景 -> 三步处理 -> 输出结果 -> 边界提醒"]
  },
  {
    key: "beginner_reversal",
    name: "小白低门槛反转",
    search: "零基础 AI工具 教程 小白 工作流 小红书",
    seeds: [
      "不会写代码也能让AI跑流程",
      "第一次用桌面智能体先做这一步",
      "小白别一上来就问大问题",
      "先把一个重复动作跑通就够了"
    ],
    hooks: ["零基础", "小白先看", "不用编程", "第一次"],
    structures: ["新手误区 -> 第一步 -> 看结果 -> 下次复用", "准备材料 -> 输入一句话 -> 检查输出 -> 避坑"]
  }
];

const OFFLINE_WORKER_TOPICS = [
  "周报从一小时压到十分钟",
  "文件夹乱到不敢打开怎么办",
  "表格字段一个个复制太折磨",
  "会议纪要写完还要再整理一遍",
  "下班前突然要一份汇总",
  "资料散在聊天记录和网盘里",
  "每天重复填同一张表",
  "把截图、表格、文档串成一个流程",
  "同事问一遍就能跑的自动化",
  "新手第一次做AI办公工作流"
];

export const DEFAULT_CREATIVE_DIRECTIONS = [
  {
    key: "comparison_choice",
    name: "强对比选型",
    topics: [
      "一篇讲清 Codex / Claude Code / WorkBuddy 怎么选",
      "用了一个月 Codex 换桌面智能体",
      "从 WorkBuddy 迁到桌面智能体的28天"
    ]
  },
  {
    key: "ecosystem_combo",
    name: "联动绑定生态",
    topics: [
      "桌面智能体 + Obsidian 知识库工作流",
      "桌面智能体 + 飞书五分钟搭自动化报表",
      "桌面智能体 + WPS 做 AI 办公全家桶"
    ]
  },
  {
    key: "worker_efficiency",
    name: "打工人效率场景",
    topics: [
      "AI 帮我少加班三小时",
      "周报写到崩溃？让桌面智能体先打底",
      "同事以为我招了 AI 助理"
    ]
  },
  {
    key: "beginner_reversal",
    name: "小白反转入门",
    topics: [
      "零基础桌面智能体全攻略",
      "不用编程也能让 AI 跑流程",
      "被 AI 劝退三次后终于上手"
    ]
  }
];

const HOT_TITLE_PATTERNS = [
  "{pain}，终于不用手动扛了",
  "我试了一圈，才分清{category}怎么用",
  "别再把{category}当聊天框了",
  "{time}省下来的，不是玄学",
  "这类重复活，真的可以交给流程",
  "一个人干活，也别再靠手补",
  "{scenario}最该先自动化的3步",
  "不是谁更强，是分工不一样",
  "小白第一次用{category}先看这条",
  "从乱到顺，我只改了一个流程"
];

const COPY_OPENINGS = [
  "我以前以为 AI 办公就是问一句、复制一段，后来发现真正省时间的是把重复动作固定下来。",
  "最烦的不是任务难，而是同一套整理、分类、复制、汇总每天都要重新来。",
  "这条不讲玄学，只讲一个能复用的小流程：先把材料放对，再让工具按步骤执行。",
  "如果你也经常被文件、表格和消息拖着走，可以先从一个很小的重复场景开始。",
  "同类工具不是互相替代关系，更像不同工位：一个负责想清楚，一个负责把活跑完。"
];

function hashText(text = "") {
  let h = 2166136261;
  for (const ch of String(text || "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick(list, seed = 0) {
  if (!Array.isArray(list) || !list.length) return "";
  const n = Number.isFinite(Number(seed)) ? Number(seed) : hashText(seed);
  return list[Math.abs(n) % list.length];
}

export function trendInteractionCount(value = "") {
  if (typeof value === "number") return Math.max(0, Math.round(value));
  const s = String(value || "").replace(/,/g, "").trim().toLowerCase();
  if (!s) return 0;
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return 0;
  const n = Number(m[1]) || 0;
  const mul = /万|w/.test(s) ? 10000 : /千|k/.test(s) ? 1000 : 1;
  return Math.round(n * mul);
}

export function pickDefaultCreativeTopic({ seed = "", avoidTopics = [] } = {}) {
  const avoid = new Set((avoidTopics || []).map(x => compactText(x, 80)));
  const base = Math.abs(hashText(seed));
  const directions = DEFAULT_CREATIVE_DIRECTIONS;
  for (let i = 0; i < directions.length * 3; i++) {
    const dir = directions[(base + i) % directions.length];
    const topic = dir.topics[(Math.floor(base / 7) + i) % dir.topics.length];
    if (topic && !avoid.has(compactText(topic, 80))) return topic;
  }
  return directions[base % directions.length].topics[base % directions[base % directions.length].topics.length];
}

function compactText(text = "", max = 180) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/[，、；:：\s]*$/, "");
}

function zhProductName(product) {
  const raw = String(product?.shortName || product?.name || "");
  if (/秒哒|miaoda/i.test(raw) || product?.id === "miaoda") return "百度秒哒";
  return "百度搭子";
}

function publicCategory(product) {
  const raw = String(product?.shortName || product?.name || "");
  if (/秒哒|miaoda/i.test(raw) || product?.id === "miaoda") return "AI应用搭建工具";
  return "桌面智能体";
}

function stripOwnProductNames(text = "", product = null) {
  const cat = publicCategory(product);
  return String(text || "")
    .replace(OWN_PRODUCT_RE, cat)
    .replace(/AI应用搭建工具应用搭建工具/g, "AI应用搭建工具")
    .replace(/桌面智能体桌面智能体/g, "桌面智能体")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanTags(tags = [], product = null) {
  const base = (Array.isArray(tags) ? tags : String(tags || "").split(/[，,\s#]+/))
    .map(x => String(x || "").replace(/^#/, "").trim())
    .filter(Boolean)
    .map(x => stripOwnProductNames(x, product).replace(/^#/, "").trim())
    .filter(x => x && !OWN_PRODUCT_RE.test(x));
  const merged = [...base, "AI办公", "效率工具", "打工人效率"].filter(Boolean);
  return [...new Set(merged)].slice(0, 6).map(x => `#${x}`);
}

export function normalizeTrendItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((x, i) => {
      const rawLikes = x.likes || x.like || x.interactions || x.collects || x.comments || "";
      return {
        title: compactText(x.title || x.note_title || x.name || "", 60),
        desc: compactText(x.desc || x.description || x.summary || x.content || x.text || "", 520),
        author: compactText(x.author || x.user || x.nickname || "", 24),
        url: x.url || x.link || "",
        likes: rawLikes,
        interactions: trendInteractionCount(rawLikes),
        index: i + 1
      };
    })
    .filter(x => x.title || x.desc)
    .sort((a, b) => (b.interactions || 0) - (a.interactions || 0) || a.index - b.index)
    .slice(0, 12);
}

function chooseDirection({ topic = "", account = {}, batchVariant = null, seed = "" } = {}) {
  const text = `${topic} ${account?.name || ""} ${account?.styleProfile || ""} ${batchVariant?.name || ""}`;
  const lower = text.toLowerCase();
  if (/周报|表格|excel|文件|资料|打工人|下班|会议|纪要/.test(text)) return XHS_TREND_LIBRARY.find(x => x.key === "worker_efficiency");
  if (/obsidian|codex|workbuddy|manus|cursor|copilot|对比|怎么选|vs/i.test(lower)) return XHS_TREND_LIBRARY.find(x => x.key === "comparison_choice");
  if (/组合|联动|知识库|生态|沉淀|长期/.test(text)) return XHS_TREND_LIBRARY.find(x => x.key === "ecosystem_combo");
  if (/小白|零基础|不用编程|第一次|新手/.test(text)) return XHS_TREND_LIBRARY.find(x => x.key === "beginner_reversal");
  if (/别|千万|真香|吐槽|反转|嫌/.test(text)) return XHS_TREND_LIBRARY.find(x => x.key === "negative_reversal");
  return pick(XHS_TREND_LIBRARY, hashText(`${seed}${text}`));
}

export function buildTrendSearchQuery({ topic = "", account = {}, product = null, batchVariant = null, kind = "image" } = {}) {
  const dir = chooseDirection({ topic, account, batchVariant, seed: kind });
  const raw = compactText(topic, 50);
  const accountHint = compactText(account?.styleProfile || account?.mode || "", 24);
  const cat = publicCategory(product);
  return [raw, dir?.search, accountHint, cat, kind === "video" ? "视频号 口播" : "小红书 图文"].filter(Boolean).join(" ");
}

function topicFromInput({ topic = "", direction = null, seed = 0 } = {}) {
  const raw = compactText(topic, 120);
  if (raw && raw.length >= 6) return raw;
  const base = pick(direction?.seeds || OFFLINE_WORKER_TOPICS, seed);
  const extra = pick(OFFLINE_WORKER_TOPICS, seed + 3);
  return `${base}：用一个真实办公场景讲清痛点、动作、结果和适合谁，可带一个同类工具做分工或组合参考。${extra && extra !== base ? `延展例子：${extra}。` : ""}`;
}

function inferTitleFromTopic(topic = "", product = null) {
  const raw = stripOwnProductNames(topic, product);
  if (/obsidian/i.test(raw) && /codex/i.test(raw)) return "Codex+Obsidian，一个沉淀一个执行";
  if (/obsidian/i.test(raw) && /内容|运营|自媒体|笔记/.test(raw)) return "Obsidian不只做资料库";
  if (/obsidian/i.test(raw)) return "知识库别只拿来囤资料";
  if (/codex/i.test(raw) && /workbuddy/i.test(raw)) return "Codex和协作智能体到底怎么选？";
  if (/codex/i.test(raw) && /区别|对比|怎么选|分工/.test(raw)) return "代码智能体别再混着用";
  if (/manus/i.test(raw) && /无代码|应用|秒哒|搭建|怎么选|分工/.test(raw)) return "Manus和无代码工具到底怎么选？";
  if (/周报/.test(raw)) return "周报别再手动拼了";
  if (/资料|文件/.test(raw)) return "资料乱到爆，先别急着整理";
  if (/表格|Excel/i.test(raw)) return "表格不是不会做，是太重复";
  return "";
}

function rewriteTitle({ direction, topic, onlineItems, product, seed }) {
  const ref = pick(onlineItems, seed);
  const cat = publicCategory(product);
  const pain = /周报/.test(topic) ? "写周报" : /表格|Excel/i.test(topic) ? "表格整理" : /文件|资料/.test(topic) ? "资料整理" : /Obsidian|知识库/i.test(topic) ? "知识库流程" : "重复办公";
  const time = /周报|表格|文件|资料/.test(topic) ? "10分钟" : "一次跑通";
  const hot = String(ref?.title || "");
  const imitate = imitateHotTitle(hot, { topic, product, pain, cat, time });
  if (imitate) return imitate;
  const topicTitle = inferTitleFromTopic(topic, product);
  if (!hot && topicTitle) return compactText(stripOwnProductNames(topicTitle, product), 28);
  const hotPattern = /怎么选|到底/.test(hot)
    ? "这类工具到底怎么选"
    : /区别|分清/.test(hot)
    ? "我终于分清这些工具怎么用"
    : /全行业|通用|模板|指令/.test(hot)
    ? `${pain}通用流程，先收藏`
    : /半个月|7天|小白|入门/.test(hot)
    ? `小白第一次用${cat}先看这条`
    : /王炸|组合|Obsidian|飞书|多维表格/i.test(hot)
    ? "一个负责沉淀，一个负责执行"
    : /5分钟|10分钟|2小时|周报|Excel/i.test(hot)
    ? `${pain}，终于能省点时间`
    : "";
  const pattern = hotPattern || pick(HOT_TITLE_PATTERNS, seed + (ref?.title ? ref.title.length : 0));
  const base = pattern
    .replace("{pain}", pain)
    .replace("{category}", cat)
    .replace("{time}", time)
    .replace("{scenario}", pain);
  return compactText(stripOwnProductNames(base, product), 28);
}

function imitateHotTitle(hot = "", { topic = "", product = null, pain = "重复办公", cat = "AI工具", time = "10分钟" } = {}) {
  const toolName = (name = "") => {
    const raw = stripOwnProductNames(String(name || "").trim(), product)
      .replace(/OpenAI\s+Codex/gi, "Codex")
      .replace(/\s+/g, " ");
    if (!raw) return "";
    if (/桌面智能体|AI应用搭建工具/.test(raw)) return raw;
    if (/obsidian/i.test(raw)) return /obsidian/i.test(topic) ? "Obsidian" : "知识库";
    if (/codex/i.test(raw)) return /codex/i.test(topic) ? "Codex" : "代码智能体";
    if (/workbuddy/i.test(raw)) return /workbuddy/i.test(topic) ? "WorkBuddy" : "协作智能体";
    if (/manus/i.test(raw)) return /manus/i.test(topic) ? "Manus" : "云端智能体";
    if (/cursor|claude code|copilot|trae|windsurf|openclaw/i.test(raw)) return /cursor|claude|copilot|trae|windsurf|openclaw/i.test(topic) ? raw : "同类工具";
    return compactText(raw, 10);
  };
  const pairTitle = (a, b, tail) => {
    const left = toolName(a);
    const right = toolName(b);
    if (!left || !right || left === right || /同类工具/.test(`${left}${right}`)) return "";
    return compactText(stripOwnProductNames(`${left}和${right}${tail}`, product), 30);
  };
  const raw = stripOwnProductNames(hot, product)
    .replace(/WorkBuddy|workbuddy|Codex|OpenAI Codex|Manus|Cursor|Claude Code|GitHub Copilot|Obsidian/gi, (m) => {
      if (/obsidian/i.test(m)) return /obsidian/i.test(topic) ? "Obsidian" : "知识库";
      if (/codex|workbuddy|manus|cursor|claude|copilot/i.test(m)) return /codex|workbuddy|manus|cursor|claude|copilot/i.test(topic) ? m : "同类工具";
      return m;
    })
    .replace(/全行业通用|全网通用|保姆级|神器|封神|吊打|秒杀/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw || raw.length < 5) return "";
  const diff = raw.match(/(.+?)和(.+?)(?:的)?区别/);
  if (diff) return pairTitle(diff[1], diff[2], "的区别，我终于分清了") || "这类工具的区别，我终于分清了";
  const pickOne = raw.match(/用(.+?)还是(.+?)[？?]?$/);
  if (pickOne) return pairTitle(pickOne[1], pickOne[2], "到底怎么选？") || "这类工具到底怎么选？";
  const turned = raw.match(/(.+?)帮我把(.+?)装成了(.+)/);
  if (turned) return compactText(stripOwnProductNames(`我把${toolName(turned[2]) || "知识库"}做成了${compactText(turned[3], 8)}`, product), 28);
  const notOnly = raw.match(/(.+?)不做(.+?)，做(.+)/);
  if (notOnly) return compactText(stripOwnProductNames(`${toolName(notOnly[1]) || "知识库"}不只做${compactText(notOnly[2], 6)}，还能做${compactText(notOnly[3], 8)}`, product), 30);
  const made = raw.match(/我把(.+?)做成了(.+)/);
  if (made) return compactText(stripOwnProductNames(`我把${toolName(made[1]) || compactText(made[1], 8)}做成了${compactText(made[2], 9)}`, product), 28);
  const combo = raw.match(/(.+?)\+(.+?)(?:王炸组合)?(.+)?/);
  if (combo && /组合|知识库|Obsidian|飞书|多维表格|AI/i.test(raw)) {
    const left = toolName(combo[1]);
    const right = toolName(combo[2]);
    if (left && right && left !== right) return compactText(stripOwnProductNames(`${left}+${right}，一个沉淀一个执行`, product), 30);
  }
  const after = raw.match(/(.+?)之后，(.+?)卷到(.+?)了/);
  if (after) return compactText(`${cat}之后，办公真的卷到桌面执行了`, 30);
  const templates = [
    [/(.+?)和(.+?)的区别/, "这类工具的区别，我终于分清了"],
    [/用(.+?)还是(.+?)[？?]?/, "这类工具到底怎么选？"],
    [/(.+?)之后，(.+?)卷到(.+?)了/, `${cat}之后，办公方式真的变了`],
    [/(.+?)\+(.+?)王炸组合/, "一个负责沉淀，一个负责执行"],
    [/(\d+)\s*分钟.*?(搞定|跑完|完成)(.+)/, `${time}省下来的，不是玄学`],
    [/(.+?)，半个月分清楚了/, "我试了一圈，才分清怎么用"],
    [/一个(.+?)，顶一个(.+)/, "一个人干活，也别再靠手补"],
    [/(.+?)必装(\d+)?个?(.+)/, `${pain}最该先自动化的3步`],
    [/别再(.+)/, `别再把${cat}只当聊天框了`]
  ];
  for (const [re, tpl] of templates) {
    if (re.test(raw)) return compactText(stripOwnProductNames(tpl, product), 24);
  }
  if (/怎么选|到底/i.test(raw)) return "这类工具到底怎么选？";
  if (/区别|分清|对比|VS|vs/.test(raw)) return "我终于分清这些工具怎么用";
  if (/周报|Excel|表格|文件|资料/.test(raw)) return `${pain}，终于能省点时间`;
  if (/小白|零基础|入门/.test(raw)) return `小白第一次用${cat}先看这条`;
  if (/组合|知识库|Obsidian/i.test(raw)) return "一个负责沉淀，一个负责执行";
  return "";
}

function buildCopy({ title, direction, topic, onlineItems, product, seed, kind }) {
  const ref = pick(onlineItems, seed + 1);
  const opening = pick(COPY_OPENINGS, seed);
  const structure = pick(direction?.structures || [], seed + 2);
  const cat = publicCategory(product);
  const compare = /obsidian/i.test(topic) ? "知识库负责沉淀，桌面执行负责把文件、表格和动作跑起来" : /codex|workbuddy|manus|cursor/i.test(topic) ? "不同工具放在不同步骤，别让一个聊天框包办所有事情" : "先把材料、动作和结果拆开，再让工具按流程处理";
  const cleanTopic = stripOwnProductNames(topic, product).replace(/[。.]$/, "");
  const refHook = ref?.title ? `我参考的是「${stripOwnProductNames(ref.title, product)}」这种标题钩子，但正文一定要换成自己的流程。` : "";
  const tips = [
    `先把需求写成一句能执行的话：资料在哪里、要提什么字段、最后交付什么格式。`,
    `中间不要只看生成速度，要让它列出遗漏项和判断依据，这一步最能防止返工。`,
    `${compare}，最后再把结果放回原来的文档或知识库里复盘。`
  ];
  const proseForms = [
    [
      opening,
      "",
      `这次主题是「${cleanTopic}」。我会先把它写成一个真实使用场景，而不是一上来介绍功能：人为什么会卡住、哪一步最浪费时间、工具到底接住了哪一段。`,
      "",
      `比较有内容的写法，是把一个小动作讲细：材料怎么给、目标怎么说、跑完后怎么判断结果能不能用。${tips[1]}这样读起来不像说明书，更像有人真的踩过一遍。`,
      "",
      structure ? `可以参考「${structure}」的节奏，但不要照着排成固定清单。封面给一个清楚判断，内页挑最有用的动作展开，最后补一句边界。` : `图文节奏可以更松一点：先让人看到真实问题，再给做法和复核方式，别把每页都塞成说明书。`,
      refHook
    ],
    [
      `我现在写这类 AI 办公内容，会先问一个很现实的问题：读者看完能不能马上少踩一个坑？`,
      "",
      `如果主题是「${cleanTopic}」，不要只写“效率提升”。更有用的是讲清楚它具体省掉哪一段：是少翻文件、少改格式，还是少来回解释需求。`,
      "",
      `可以把方法写得像一次真实复盘：${tips.join(" ")}`,
      "",
      kind === "video" ? "做成口播时，不用强行三段论，像跟朋友讲一次试用体验就行：哪里卡、怎么改、最后值不值得。" : "做成图文时，封面给判断，正文像经验贴一样展开，读者能拿走一个具体动作就够了。"
    ],
    [
      `这次我只保留读者能照着做的部分，不写空泛的工具夸法。`,
      "",
      `围绕「${cleanTopic}」，正文可以不用固定分点。只要讲清哪些材料最乱、哪个动作最重复、最后怎么确认结果靠谱，内容就不会空。`,
      "",
      `小技巧是别一上来就写“全自动”。先给一个真实例子，比如周报、合同、资料归档、选题表或客服记录，再把工具放进那一步里。这样读者知道它到底帮在哪，也知道什么时候不该用。`,
      "",
      refHook || "离线没有热门正文时，就按本次主题自己造一个可信场景，别复读模板句。"
    ]
  ];
  const body = [
    ...pick(proseForms, seed + 3).filter(Boolean),
    "",
    cleanTags(["AI办公", cat, "效率工具", "工作流", "打工人效率"], product).join(" ")
  ].join("\n");
  return stripOwnProductNames(body, product);
}

function inferRefTags(item = {}, product = null) {
  const raw = `${item.title || ""} ${item.desc || ""}`;
  const picked = [];
  if (/周报|汇报/.test(raw)) picked.push("周报效率");
  if (/Excel|表格|数据/i.test(raw)) picked.push("表格整理");
  if (/Obsidian|知识库|笔记/i.test(raw)) picked.push("知识库");
  if (/Codex|Cursor|代码|开发/i.test(raw)) picked.push("AI开发");
  if (/Manus|智能体|Agent/i.test(raw)) picked.push("智能体");
  if (/小白|零基础|新手/.test(raw)) picked.push("新手教程");
  if (/对比|区别|怎么选|VS|vs/.test(raw)) picked.push("工具对比");
  return cleanTags([...(picked.length ? picked : ["热门参考"]), publicCategory(product)], product).slice(0, 5);
}

function buildReferenceRewrite({ items = [], title = "", copy = "", tags = [], product = null, source = "local", referenceNote = "" } = {}) {
  if (source !== "online" || !items.length) return null;
  const ref = items[0] || {};
  const refCopy = ref.desc && ref.desc.length > 18
    ? ref.desc
    : "搜索接口当前只返回标题、摘要或互动信息，未开放完整正文；这里保留可得钩子，改写时只参考结构和选题。";
  return {
    source,
    referenceNote,
    reference: {
      title: stripOwnProductNames(ref.title || "", product),
      copy: stripOwnProductNames(refCopy, product),
      tags: inferRefTags(ref, product),
      author: ref.author || "",
      likes: ref.likes || "",
      url: ref.url || ""
    },
    rewrite: {
      title: stripOwnProductNames(title || "", product),
      copy: stripOwnProductNames(copy || "", product),
      tags: tags || []
    }
  };
}

function buildImageStrategy({ topic, product, direction, imageCount, onlineItems, seed }) {
  const zh = zhProductName(product);
  const n = Math.max(3, Math.min(12, Number(imageCount) || 4));
  const ref = pick(onlineItems, seed + 2);
  const parts = [
    `图片里主产品统一写「${zh}」；涉及百度秒哒时也只使用中文名。`,
    `第1张低信息密度：一个大标题、一句短副标题、1-2 个简单视觉元素，避免表格、长流程和密集截图。`,
    `内页按 ${n} 张重新分配信息：每张只讲一个小问题，依次覆盖真实场景、工具分工/组合动作、可复核结果、边界或收藏结论。`,
    `如果主题里有同类工具，具体写清它负责哪一步、${zh}负责哪一步，用箭头、左右分工或场景卡表达。`,
    `文字轻量：普通风格以醒目主标题、短解释和必要标签为主；火柴人/漫画风格主要靠人物动作、气泡和箭头。`,
    `内部取材方向：${ref?.title ? `参考热门标题钩子和结构节奏，改写成本次主题` : direction?.name || "本地五大方向"}；画面只呈现本次内容本身。`
  ];
  return parts.join("\n");
}

export function buildTrendPrep({
  topic = "",
  account = {},
  product = null,
  batchVariant = null,
  onlineItems = [],
  useOnlineTrends = false,
  kind = "image",
  imageCount = 4,
  seed = ""
} = {}) {
  const normalizedItems = normalizeTrendItems(onlineItems);
  const lowInteractionCount = useOnlineTrends ? normalizedItems.filter(x => (x.interactions || 0) < MIN_TREND_INTERACTIONS).length : 0;
  const items = useOnlineTrends
    ? normalizedItems.filter(x => (x.interactions || 0) >= MIN_TREND_INTERACTIONS)
    : normalizedItems;
  const direction = chooseDirection({ topic, account, batchVariant, seed });
  const h = hashText(`${topic}|${account?.id || account?.name || ""}|${batchVariant?.name || ""}|${kind}|${seed}|${items.map(x => x.title).join("|")}`);
  const creativeContent = topicFromInput({ topic, direction, seed: h });
  const title = rewriteTitle({ direction, topic: creativeContent, onlineItems: items, product, seed: h });
  const copy = buildCopy({ title, direction, topic: creativeContent, onlineItems: items, product, seed: h, kind });
  const tags = cleanTags([publicCategory(product), direction?.name, kind === "video" ? "口播脚本" : "图文笔记"], product);
  const imageStrategy = buildImageStrategy({ topic: creativeContent, product, direction, imageCount, onlineItems: items, seed: h });
  const referenceNote = items.length
    ? `参考了「${items.slice(0, 3).map(x => stripOwnProductNames(x.title, product)).filter(Boolean).join("」「")}」等热门笔记的标题钩子和内容结构，已重新改写。`
    : useOnlineTrends && normalizedItems.length
    ? `本轮联网结果有 ${lowInteractionCount} 条互动低于 ${MIN_TREND_INTERACTIONS}，未纳入热门参考；改用本地四方向选题继续生成。`
    : `使用本地投放方向「${direction?.name || "AI办公选题"}」生成选题和文案结构。`;
  const source = useOnlineTrends && items.length ? "online" : "local";
  const referenceRewrite = buildReferenceRewrite({ items, title, copy, tags, product, source, referenceNote });
  const guideLines = [
    `方向：${direction?.name || "AI办公选题"}`,
    `参考说明：${referenceNote}`,
    `预制标题：${title}`,
    `创作内容：${creativeContent}`,
    `文案骨架：${stripOwnProductNames(copy.split("\n").slice(0, 8).join(" / "), product)}`,
    `图片策略：${imageStrategy}`,
    items.length ? `热门样本：${items.slice(0, 5).map((x, i) => `${i + 1}. ${stripOwnProductNames(x.title, product)}${x.likes ? `（${x.likes}）` : ""}${x.desc ? `｜可用摘要：${stripOwnProductNames(compactText(x.desc, 120), product)}` : ""}`).join("；")}` : ""
  ].filter(Boolean);
  return {
    source,
    directionKey: direction?.key || "",
    directionName: direction?.name || "",
    topic: compactText(stripOwnProductNames(title, product), 60),
    creativeContent,
    title,
    copy,
    tags,
    imageStrategy,
    referenceNote,
    referenceRewrite,
    referenceItems: items,
    guide: guideLines.join("\n")
  };
}

export function buildTrendGuide(opts = {}) {
  return buildTrendPrep(opts).guide;
}
