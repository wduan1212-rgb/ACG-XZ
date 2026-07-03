/* AI 生成服务（脚本 / 提示词 / 文案 / 解析）：LLM 优先，失败回退本地模板
   每次调用记录 lastSource: "llm" | "mock"，UI 据此明确标注产物来源 */

import { llm } from "./llm.js";
import { DUMATE_BRIEF, PROMPT_FRAMEWORK, NO_DH_FRAMEWORK, DIR_POOL, TOPIC_POOL, STYLE_POOL } from "./prompts.js";
import { cleanText, sanitizeProduct, stripCTA, parseJSONLoose, delay } from "../core/util.js";
import { sanitizeXhsText, sanitizeXhsObject, xhsGuardPrompt } from "../core/xhsGuard.js";
import { TAG_POOL } from "../domain/accounts.js";
import { getCreativeMemoryContext } from "../domain/analytics.js";
import { state } from "../core/store.js";
import { PRODUCT_CATALOG_SEED, relatedProducts } from "../data/productCatalogSeed.js";
import { buildTrendGuide, buildTrendPrep, buildTrendSearchQuery, normalizeTrendItems, pickDefaultCreativeTopic } from "../data/xhsTrendLibrary.js";

const DEFAULT_XHS_IMAGE_COUNT = 4;
const TREND_NOTICE_KEY = "acg_xhs_trend_notice_muted";
const TREND_USED_KEY = "acg_xhs_trend_used_refs_v1";
let trendNoticeShown = false;

/* 选题"和当下结合、自然安利"指引（脚本类共用）：避免孤立自嗨、硬塞产品名。
   注：模型不能真实联网，这里用的是它知识里的常青热点/话题方向，不保证是今天的最新事件。 */
const TOPICAL_HOOK = `

【选题要和当下结合，别自嗨式介绍产品】
- 开头不要孤立地介绍产品。先用一个"当下真实在发生的点"切入：最近这个领域大家都在聊的现象/热度方向（如 AI Agent 集中爆发、各类工具刷屏、打工人与自媒体人的效率焦虑、降本增效、副业与内容内卷等，结合你知识里该领域近期的热点话题），或一个戳中人的真实痛点、反常识结论。把这个钩子和本期主题自然焊在一起，让人第一秒就觉得"说的就是我现在的事"。
- 本次产品是"解决方案"之一，要自然带出、不要硬塞：先把痛点/场景讲透、讲到观众点头，再顺势引出"后来我是怎么用这个工具解决的"，像真人跟朋友分享。全篇提到产品名 1-2 次即可，不要每句都念，更不要广告腔。
- 引出后落到本次产品能真正应用的具体场景，说清"它具体怎么做、帮你省下了什么"，不要把不同产品的能力混在一起。
- 全程利他、有信息量、有钩子，别空喊口号或自夸——没人想看一个只会王婆卖瓜的视频。`;

/* 小红书/视频号"真人写"文案语气指引（去 AI 腔、有含金量） */
const HUMAN_COPY_VOICE = `

【按"真人发的"来写，不要 AI 腔模板文】
对照真实账号"配文案参考"的语气与信息密度来写：
- 更像真实创作者的使用笔记：可以写"我试了一圈""才知道""逼自己看完/跑完之后""以前每次都要反复交代，后来我把它做成固定流程"。
- 信息密度高、可复制：给出具体工具名、步骤、指令模板、前后对比、数字和适用场景；默认写成真实复盘，只有用户内容天然适合清单时才少量分点。
- 少写假剧情，尤其不要"上周领导突然…"这种短剧感开头；优先写真实踩坑、真实效率变化、能直接复制的方法。
- 开头可以反常识、结论先行、对话式吐槽或实测复盘，不要固定成"第一段抛观点 + 三点内容 + 收尾段"。
- 正文段落要紧凑：段落之间只用单换行，不留空行；不要用一堆空行把内容撑开。
- 结尾自然收束，可以给一个适用场景/避坑提醒/复盘结论；不要强行求评论、求收藏、喊下载。最后一行 4-7 个贴合定位的话题标签（#开头），标签要具体，不只写泛泛的 #AI工具。
- 禁止固定套话：不要再写可保存流程口号、备忘录/小抄口吻、"先把流程搭稳"、"不夸张但确实"这类固定收束句。
- 严禁 AI 腔与硬广腔：不要"赋能/助力/高效便捷/一站式/打造闭环"这类空话，不要通篇形容词没有实质内容。宁可具体、口语、有细节。文案要紧扣脚本里的真实内容来写，有含金量。`;

const XHS_COPY_STYLE = `

【AI 博主小红书文案编辑规则】
来自同类高互动内容的稳定结构：标题要先让人想点开，正文再给可复用信息，而不是把产品名放大喊三遍。
- 标题优先从这些类型里选一种，不要连续重复：时间收益型（5分钟/15分钟/从1小时到5分钟）、组合王炸型（A+B怎么分工）、反常识型（别再把AI当聊天框）、清单收藏型（必装N个/通用指令/工作流合集）、实测复盘型（我试了一圈/跑通了）、新手教程型（零基础/手把手/完整流程）、问题挑战型（真的有人用得到吗）、边界判断型（适合谁/不适合谁）。
- 标题不必每次带产品名；可以用 AI Agent、桌面智能体、AI办公、效率工具、无代码应用、Codex、WorkBuddy、Obsidian 等品类词或同类工具制造点击理由，再在正文自然落到本次产品。
- 标题必须具体但克制：避免"最强/封神/吊打/秒杀/全网第一"等夸大词；避免敏感夸张承诺；20字以内，尽量有场景、有动作、有结果。
- 正文首句必须换写法：可以是实测结论、吐槽痛点、反常识观察、问题引入、收藏价值、避坑提醒。不要所有账号都用"说实话"或"打工人最烦"开头。
- 正文骨架也要轮换：可以是完整实测复盘、场景叙述、对话式吐槽、避坑提醒、方法拆解、适合/不适合边界、工具分工表述；不要每次都写三点清单。
- 批量生产最重要的是"像不同博主写的"：同一批里标题、第一句话、分点标签、例子、结尾标签不能像换词复读；如果主题相同，也要换成不同场景、不同切入、不同证据和不同表达节奏。
- 没有用户明确内容时，必须主动发散真实 AI 博主选题：可以写桌面智能体 vs 聊天机器人、Codex/Obsidian/WorkBuddy/百度搭子的分工、打工人场景、创作者场景、知识库场景、资料整理场景、自动化流程场景。不要所有账号都写"整理资料从乱到顺"。
- 内容要像 AI 博主：讲清功能分工、真实场景、操作动作、结果证据、适用人群和一个小技巧。可以带 1-2 个同类/互补产品做对比或组合，但主产品能力不能写混。
- 标签组合用「品类词 + 场景词 + 流量词 + 品牌词」：例如 #AI工具 #桌面智能体 #效率工具 #自动化办公 #打工人效率。不要只写品牌词。
- 对外发布的标题、正文和话题标签不要出现自家产品名（例如百度搭子、百度秒哒），统一用桌面智能体、AI应用搭建工具、AI工具、这个工具等品类词表达；竞品或互补工具名可以按主题自然出现。
- 图文笔记正文适合 320-620 字，高信息密度；视频简介适合更口语。段落之间只用单换行，不留空行。少呼吁、少广告，不要"快去下载""立刻体验"。`;

const XHS_BATCH_COPY_FORMS = [
  {
    key: "pain-relief",
    name: "痛点急救型",
    titleHint: "打工人必看 / 别再手动扛 / 终于不用反复整理",
    opening: "先写一个具体、扎心但不夸张的办公痛点，再落到本条解决方法。",
    structure: "痛点现场 -> 具体动作 -> 结果变化 -> 适用人群"
  },
  {
    key: "tool-division",
    name: "工具分工型",
    titleHint: "才知道不同 AI 真有分工 / A 负责思考 B 负责执行",
    opening: "先讲清不同工具各自适合做什么，再写主产品在本流程里负责的具体动作。",
    structure: "工具边界 -> 组合流程 -> 主产品动作 -> 避坑提醒"
  },
  {
    key: "real-test",
    name: "真实实测型",
    titleHint: "说实话 / 我试了一圈 / 附真实截图",
    opening: "用真实试用后的克制口吻开头，既写有效点，也写边界。",
    structure: "实测背景 -> 做了什么 -> 哪里省事 -> 不适合谁"
  },
  {
    key: "template-save",
    name: "模板收藏型",
    titleHint: "附模板 / 一页纸就够 / 直接照着做",
    opening: "开头给出可复制结果，让读者知道这条能收藏复用。",
    structure: "可复制模板 -> 三步填法 -> 复用场景 -> 保存提醒式结论"
  },
  {
    key: "mistake-fix",
    name: "避坑修正型",
    titleHint: "别再乱问 / 不是让 AI 直接写 / 先搭流程",
    opening: "先指出一个常见误区，再给出更稳的操作方式。",
    structure: "常见误区 -> 正确做法 -> 示例指令 -> 复盘结论"
  },
  {
    key: "before-after",
    name: "前后对比型",
    titleHint: "以前 vs 现在 / 从乱到顺 / 省下重复整理",
    opening: "用处理前后的具体差异开头，不写抽象夸奖。",
    structure: "处理前 -> 执行动作 -> 处理后 -> 可复核结果"
  },
  {
    key: "one-person-team",
    name: "一人团队型",
    titleHint: "一个人干活 / 像多了个同事 / 小团队也能跑",
    opening: "从个人或小团队的真实压力切入，强调流程化分工。",
    structure: "一个人的卡点 -> 把任务拆给工具 -> 输出物 -> 适合场景"
  },
  {
    key: "calm-note",
    name: "冷静备忘型",
    titleHint: "公开备忘录 / 我把流程记下来 / 冷静复盘",
    opening: "像写给自己的经验备忘，不喊口号，强调可复盘。",
    structure: "结论 -> 操作清单 -> 边界 -> 下次怎么复用"
  },
  {
    key: "time-save",
    name: "时间收益型",
    titleHint: "从1小时到5分钟 / 15分钟跑通 / 少加班一小时",
    opening: "用真实可感的时间差开头，必须说明省下来的时间来自哪一步。",
    structure: "原来耗时 -> 关键动作 -> 时间变化 -> 使用边界"
  },
  {
    key: "combo-wow",
    name: "组合王炸型",
    titleHint: "A+B王炸组合 / 一个负责沉淀一个负责执行",
    opening: "先说明两个工具为什么要一起用，再讲各自职责。",
    structure: "工具A职责 -> 主产品职责 -> 衔接动作 -> 适合场景"
  },
  {
    key: "anti-chat",
    name: "反聊天框型",
    titleHint: "别再只会问AI / 不是聊天是执行 / 让AI自己跑流程",
    opening: "用反常识观点开头：不是让 AI 回答，而是让它执行。",
    structure: "旧用法 -> 新用法 -> 桌面执行证据 -> 可复用句式"
  },
  {
    key: "starter-guide",
    name: "新手教程型",
    titleHint: "零基础上手 / 第一次用桌面智能体 / 新手别绕路",
    opening: "用新手视角降低门槛，告诉读者第一步做什么。",
    structure: "准备什么 -> 输入什么 -> 看什么结果 -> 第一次避坑"
  },
  {
    key: "question-talk",
    name: "话题提问型",
    titleHint: "真的有人用得到AI Agent吗 / 它到底能干嘛",
    opening: "先抛一个真实疑问，再用本条案例回答。",
    structure: "问题 -> 真实案例 -> 结论 -> 讨论边界"
  },
  {
    key: "collection",
    name: "收藏合集型",
    titleHint: "必存 / 通用指令 / 工作流合集 / 这几类任务",
    opening: "开头明确这条适合收藏，但正文必须给具体可执行内容。",
    structure: "可收藏场景 -> 3类任务 -> 复制句式 -> 保存价值"
  },
  {
    key: "proof-shot",
    name: "证据截图型",
    titleHint: "附真实截图 / 跑完才知道 / 结果长这样",
    opening: "强调看结果说话，用截图/结果/文件变化建立可信度。",
    structure: "输入材料 -> 执行中证据 -> 输出结果 -> 复核方法"
  }
];

function copyVariant(seed = 0, explicit = null) {
  const picked = XHS_BATCH_COPY_FORMS[Math.abs(Number(seed) || 0) % XHS_BATCH_COPY_FORMS.length];
  if (explicit?.key || explicit?.name) {
    const matched = XHS_BATCH_COPY_FORMS.find(x => x.key === explicit.key || x.name === explicit.name) || picked;
    return { ...matched, ...explicit };
  }
  return picked;
}

function batchVariantLine(variant = null) {
  if (!variant) return "";
  const v = copyVariant(0, variant);
  const parts = [
    `本条批量差异化任务：${v.name || "差异化内容"}`,
    v.angle ? `切入角度：${v.angle}` : "",
    v.titleHint ? `标题形式参考：${v.titleHint}` : "",
    v.opening ? `首句写法：${v.opening}` : "",
    v.structure ? `正文结构：${v.structure}` : "",
    v.focus ? `本条只重点展开：${v.focus}` : "",
    Number.isFinite(v.index) && Number.isFinite(v.total) ? `这是同批第 ${v.index}/${v.total} 条，必须和同批其他账号的标题、首句、分点顺序和例子明显不同。` : ""
  ].filter(Boolean);
  return parts.join("\n");
}

function normalizeForDedupe(text = "") {
  return String(text || "")
    .replace(/#[^\s#]+/g, "")
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩0-9一二三四五六七八九十、，。！？!?；;：:\s"'“”「」【】（）()\-—_]/g, "")
    .slice(0, 220);
}

function tooSimilarCopy(candidate = {}, avoidCopies = []) {
  const title = normalizeForDedupe(candidate.title || "");
  const body = normalizeForDedupe(candidate.copy || "");
  if (!title && !body) return false;
  return (avoidCopies || []).some(x => {
    const t = normalizeForDedupe(x.title || "");
    const b = normalizeForDedupe(x.copy || x.body || "");
    if (title && t && (title === t || title.includes(t) || t.includes(title))) return true;
    if (body && b) {
      const a = body.slice(0, 120);
      const c = b.slice(0, 120);
      return a.length > 36 && c.length > 36 && (a === c || a.includes(c.slice(0, 60)) || c.includes(a.slice(0, 60)));
    }
    return false;
  });
}

function hashTextSeed(text = "") {
  let h = 2166136261;
  for (const ch of String(text || "")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function tooSimilarTopic(topic = "", avoidTopics = []) {
  const t = normalizeForDedupe(topic);
  if (!t) return false;
  return (avoidTopics || []).some(x => {
    const y = normalizeForDedupe(x);
    return y && (t === y || t.includes(y) || y.includes(t));
  });
}

function cleanRandomTopicText(text = "", max = 30) {
  const raw = sanitizeProduct(String(text || ""))
    .replace(/[。.\n"'`“”「」]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (raw.length <= max) return raw;
  const cut = raw.slice(0, max);
  const stops = ["，", "、", "：", " vs ", " VS ", " 和 ", " 与 ", " + ", " / "]
    .map(mark => cut.lastIndexOf(mark))
    .filter(i => i > Math.floor(max * 0.55));
  const stop = stops.length ? Math.max(...stops) : -1;
  const candidate = stop > 0 ? cut.slice(0, stop) : cut;
  return candidate
    .replace(/[A-Za-z]{1,4}$/, "")
    .replace(/[，、；：,.!?！？+\-/\s]*$/, "")
    .trim() || raw.slice(0, max).trim();
}

function titleConflictsWithTopic(title = "", topic = "", shots = []) {
  const src = `${topic} ${(shots || []).map(s => `${s.idea || ""} ${s.line || ""} ${s.visual || ""}`).join(" ")}`;
  const t = String(title || "");
  const groups = [
    { re: /论文|导师|学生党|课件|考点|毕业/, src: /论文|导师|学生|课件|考点|毕业/ },
    { re: /周报|汇报/, src: /周报|汇报/ },
    { re: /会议|纪要/, src: /会议|纪要|录音/ },
    { re: /合同|法务/, src: /合同|法务/ },
    { re: /格式|转换|PDF|Word|Excel|表格|文件整理/, src: /格式|转换|PDF|Word|Excel|表格|文件整理|文件|归档/ }
  ];
  return groups.some(g => g.re.test(t) && !g.src.test(src));
}

function fallbackRandomTopic({ account = {}, product = null, batchVariant = null, seed = "", avoidTopics = [] }) {
  const p = product || allProductsForAI().find(x => x.owner === "ours") || null;
  const rel = relatedProducts(p, allProductsForAI(), 6).filter(x => x.id !== p?.id);
  const productName = chineseProductDisplayName(p, "百度搭子");
  const v = copyVariant(hashTextSeed(seed || account?.name || productName), batchVariant);
  const relName = productDisplayName(rel[hashTextSeed(`${seed}:rel`) % Math.max(1, rel.length)] || null, "同类工具");
  const accountCue = sanitizeXhsText((account?.name || account?.styleProfile || "AI博主").slice(0, 12));
  const templates = [
    `${productName}和${relName}怎么分工`,
    `${accountCue}实测${productName}桌面执行`,
    `不是资料从乱到顺这么简单`,
    `${productName}把重复办公固定成流程`,
    `${relName}负责沉淀 ${productName}负责执行`,
    `一个人也能跑完办公流程`,
    `别再把所有任务塞进聊天框`,
    `从一条指令到可交付结果`,
    `用${productName}整理一堆待处理文件`,
    `${productName}适合哪些桌面任务`,
    `AI工具分工别再混着用`,
    `把周报资料先交给桌面智能体`
  ];
  const byVariant = {
    "pain-relief": [`${accountCue}的办公急救流程`, `${productName}救回重复整理时间`],
    "tool-division": [`${productName}和${relName}分工清楚点`, `AI工具不是都负责同一件事`],
    "real-test": [`我试了${productName}这件小事`, `${productName}真实跑一次桌面任务`],
    "template-save": [`这张${productName}流程卡能复用`, `一页纸存下桌面执行流程`],
    "mistake-fix": [`别再一句话让AI全包`, `先说边界再让${productName}执行`],
    "before-after": [`以前手动翻现在流程跑`, `同一堆资料处理前后对比`],
    "one-person-team": [`一个人也能像有个执行同事`, `${productName}当桌面执行搭子`],
    "calm-note": [`公开备忘：桌面AI怎么用`, `我把${productName}流程先存下`]
  };
  const pool = [...(byVariant[v.key] || []), ...templates, ...TOPIC_POOL.map(x => `${productName}${x}`)];
  const start = hashTextSeed(`${seed}:${account?.id || ""}:${v.key}`) % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const picked = cleanRandomTopicText(pool[(start + i) % pool.length], 30);
    if (picked && !tooSimilarTopic(picked, avoidTopics)) return picked;
  }
  return `${productName}${accountCue}效率笔记`.slice(0, 22);
}

function stripPromptMeta(text) {
  return String(text || "")
    .replace(/想要宣传[^，。；\n]*[，。；]?/g, "")
    .replace(/整体的?画面风格[^，。；\n]*[，。；]?/g, "")
    .replace(/不要有页码[^，。；\n]*[，。；]?/g, "")
    .replace(/利他性强[^，。；\n]*[，。；]?/g, "")
    .replace(/画面风格[^，。；\n]*[，。；]?/g, "")
    .replace(/账号定位[^，。；\n]*[，。；]?/g, "")
    .replace(/参考图[^，。；\n]*[，。；]?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function productDisplayName(product, fallback = "本次产品") {
  return sanitizeProduct(product?.shortName || product?.name || fallback);
}

function chineseProductDisplayName(product, fallback = "百度搭子") {
  const text = `${product?.id || ""} ${product?.name || ""} ${product?.shortName || ""} ${product?.category || ""}`;
  if (/miaoda|秒哒/i.test(text)) return "百度秒哒";
  if (/dumate|百度搭子|搭子|桌面智能体/i.test(text)) return "百度搭子";
  return productDisplayName(product, fallback)
    .replace(/Dumate|DuMate/gi, "百度搭子")
    .replace(/MIAODA/gi, "百度秒哒");
}

function sanitizeOwnProductForGeneratedText(text = "") {
  return String(text || "")
    .replace(/Dumate|DuMate/gi, "百度搭子")
    .replace(/MIAODA/gi, "百度秒哒");
}

function stripVisibleTextLabels(text = "") {
  return String(text || "")
    .replace(/([「“"'])\s*(?:标题|主标题|大标题|副标题|小标题|文案|正文|主题|画面短句|画面文字|图上文案|图上文字|核心文字)\s*[:：]\s*/g, "$1")
    .replace(/^(?:标题|主标题|大标题|副标题|小标题|文案|正文|主题|画面短句|画面文字|图上文案|图上文字|核心文字)\s*[:：]\s*/g, "")
    .replace(/[，,；;\s]+(?:标题|主标题|大标题|副标题|小标题|文案|正文|主题|画面短句|画面文字|图上文案|图上文字|核心文字)\s*[:：]\s*/g, "，")
    .replace(/\s+/g, " ")
    .trim();
}

function genericProductLabel(product = null) {
  const text = `${product?.id || ""} ${product?.name || ""} ${product?.shortName || ""} ${product?.category || ""}`;
  if (/miaoda|秒哒/i.test(text)) return "AI应用搭建工具";
  if (/dumate|百度搭子|搭子|桌面智能体/i.test(text)) return "桌面智能体";
  if (/agent|智能体/i.test(text)) return "AI智能体工具";
  return "AI工具";
}

function publicCopyProductLabel(intent = {}, product = null) {
  if (product) return genericProductLabel(product);
  const text = `${intent?.productName || ""} ${intent?.scene || ""}`;
  if (/秒哒/i.test(text)) return "AI应用搭建工具";
  if (/Dumate|百度搭子|搭子|桌面智能体/i.test(text)) return "桌面智能体";
  if (/Agent|智能体/i.test(text)) return "AI智能体工具";
  return "AI工具";
}

function inferCopyIntent({ topic = "", shots = [], account = null, product = null, useAccountPosition = true }) {
  const productName = chineseProductDisplayName(product, "百度搭子");
  const raw = [topic, useAccountPosition ? (account?.styleProfile || account?.voiceName || "") : "", account?.tone, ...(shots || []).flatMap(s => [s.idea, s.line, s.visual])].join(" ");
  const cleaned = stripPromptMeta(raw);
  const lower = cleaned.toLowerCase();
  const isKnowledge = /Obsidian|Notion|知识库|双链|沉淀|复盘|笔记|卡片笔记|PKM/i.test(cleaned);
  const audience = /学生|毕业|论文|导师|课件|考点/.test(cleaned) ? "学生党"
    : /自媒体|小红书|选题|素材|脚本|图文/.test(cleaned) ? "内容创作者"
    : isKnowledge ? "知识管理党"
    : /合同|报表|Excel|PPT|Word|PDF|周报|会议|文件|数据|汇报/.test(cleaned) ? "打工人"
    : /老师|教学|课件/.test(cleaned) ? "老师"
    : "办公人";
  const pain = /论文|导师|毕业/.test(cleaned) ? "论文资料和数据整理太磨人"
    : /周报|汇报/.test(cleaned) ? "周报汇报每次都要反复整理"
    : isKnowledge ? "资料收集容易但复盘沉淀太断裂"
    : /PDF|Word|格式|转换/.test(cleaned) ? "文件格式来回转换太耗时间"
    : /Excel|表格|数据/.test(cleaned) ? "表格数据整理和提取太费脑"
    : /会议|录音|纪要/.test(cleaned) ? "会议纪要和录音复盘太拖时间"
    : /素材|选题|脚本/.test(cleaned) ? "选题素材越攒越乱"
    : /文件|归档|分类/.test(cleaned) ? "桌面文件乱到找不到重点"
    : "重复办公动作太占精力";
  const action = /PDF|Word|格式|转换/.test(cleaned) ? "一句话交代转换和提取规则"
    : isKnowledge ? "先让桌面智能体提炼碎片，再沉淀到知识库"
    : /Excel|表格|数据/.test(cleaned) ? "把表格丢进去让它提重点和做结构"
    : /会议|录音|纪要/.test(cleaned) ? "把录音和资料交给它整理成纪要"
    : /素材|选题|脚本/.test(cleaned) ? "让它按目标人群拆选题和脚本"
    : /文件|归档|分类/.test(cleaned) ? "让它按类型自动分类归档"
    : "把需求像跟同事说话一样说清楚";
  const result = /论文|导师|毕业/.test(cleaned) ? "资料、考点和报告结构能更快理顺"
    : /周报|汇报/.test(cleaned) ? "最后直接得到能继续加工的汇报骨架"
    : isKnowledge ? "零散资料能变成可检索、可复用的知识卡片"
    : /PDF|Word|格式|转换/.test(cleaned) ? "格式转换和金额/字段提取能一起完成"
    : /Excel|表格|数据/.test(cleaned) ? "数据重点和图表结构能快速出来"
    : /会议|录音|纪要/.test(cleaned) ? "重点、待办和复盘结论更清楚"
    : /素材|选题|脚本/.test(cleaned) ? "素材能变成可执行的内容清单"
    : "重复步骤被固定成流程";
  const scene = lower.includes("dumate") || /Dumate|百度搭子/.test(cleaned) ? `${productName} 桌面端`
    : productName;
  return { productName, audience, pain, action, result, scene };
}

function copyTitlePool(intent, kind = "image", variant = null) {
  const p = publicCopyProductLabel(intent);
  const base = [
    `${intent.audience}别再手动扛了`,
    `不是所有AI工具都只会聊天`,
    `AI Agent到底能不能真干活`,
    `桌面智能体这次有点像正经同事`,
    `说实话 ${p}比我想的能干`,
    `${intent.pain} 这招真省事`,
    `才知道${intent.action}也能自动跑`,
    `${intent.audience}可以试试这套固定流程`,
    `我把${intent.pain.replace(/太.+$/, "")}交给了桌面AI`
  ];
  if (kind === "video") {
    base.unshift(
      `国产桌面智能体，1分钟上手教程讲清楚`,
      `不用安装复杂环境，这个AI工具真能上手`,
      `AI办公别只会聊天，这条把用法讲透`,
      `零基础用桌面智能体，先看这条少绕路`,
      `${intent.audience}第一次用AI Agent看这篇`,
      `${intent.pain.replace(/太.+$/, "")}，这套流程讲明白`
    );
  }
  if (kind === "image") {
    base.push(`3步把${intent.pain.replace(/太.+$/, "")}理顺`);
    base.push(`${intent.audience}后悔没早用的整理方法`);
  }
  const v = copyVariant(intent.pain.length, variant);
  if (v?.key === "tool-division") base.unshift(`才知道不同AI真有分工`, `${p}适合负责执行这步`);
  if (v?.key === "real-test") base.unshift(`说实话 ${p}这点挺实用`, `我试了一圈才留下这套流程`);
  if (v?.key === "template-save") base.unshift(`这张流程卡可以直接存`, `${intent.audience}直接照着做就行`);
  if (v?.key === "mistake-fix") base.unshift(`别再让AI直接写稿了`, `先把流程搭好再交给AI`);
  if (v?.key === "before-after") base.unshift(`从乱到顺只差这一步`, `以前手动整理现在交给流程`);
  if (v?.key === "one-person-team") base.unshift(`一个人干活也能像有同事`, `${intent.audience}的小团队工作法`);
  if (v?.key === "calm-note") base.unshift(`这份流程我先存了`, `公开备忘录：${intent.action}`);
  if (v?.key === "time-save") base.unshift(`从1小时到5分钟差在哪`, `${intent.pain.replace(/太.+$/, "")}终于省下来了`);
  if (v?.key === "combo-wow") base.unshift(`这两个AI工具真该分工用`, `别把所有事都塞进聊天框`);
  if (v?.key === "anti-chat") base.unshift(`别再只让AI回答问题了`, `桌面AI真正有用的是执行`);
  if (v?.key === "starter-guide") base.unshift(`第一次用桌面智能体先看这条`, `${intent.audience}别从复杂功能开始`);
  if (v?.key === "question-talk") base.unshift(`AI Agent真的用得到吗`, `这个场景我终于看懂了`);
  if (v?.key === "collection") base.unshift(`${intent.audience}可以存这几句指令`, `这几类重复任务别手动做`);
  if (v?.key === "proof-shot") base.unshift(`跑完结果长这样`, `看截图才知道它省在哪`);
  return base.map(x => x.replace(/\s+/g, " ").slice(0, 28));
}

function looksLikeRawBrief(text, topic) {
  const t = String(text || "");
  const raw = String(topic || "");
  if (t.length > 34) return true;
  if (/想要宣传|画面风格|利他性强|不要有页码|参考图|账号定位|整体的画面/.test(t)) return true;
  if (raw.length > 30 && raw.includes(t) && t.length > 16) return true;
  return false;
}

function deTemplateCopy(copy = "") {
  return String(copy || "")
    .replace(/适合当一个小\s*S\s*O\s*P\s*留着[：:]?/gi, "这套方法可以直接复用：")
    .replace(/适合放在自己的\s*S\s*O\s*P\s*里[，,]?/gi, "适合放进自己的固定流程里，")
    .replace(/这条更像我给自己存的一份小抄[，,]?/g, "这条我按真实复盘来写，")
    .replace(/这条更像一份备忘录，不是广告稿。?/g, "这次我只保留能照着做的部分。")
    .replace(/先把流程搭稳，再谈让 AI 帮你省时间/g, "先把资料、目标和复核方式说清楚，再让工具接手重复动作")
    .replace(/这样不夸张，但确实能少掉很多重复整理。?/g, "真正省下来的，是来回解释和反复核对的时间。")
    .replace(/①\s*/g, "")
    .replace(/②\s*/g, "")
    .replace(/③\s*/g, "")
    .replace(/[ \t]*\n[ \t]*\n+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function polishCopyResult(result, { topic, shots, account, kind, product, batchVariant = null, avoidCopies = [] }) {
  const intent = inferCopyIntent({ topic, shots, account, product, useAccountPosition: kind === "video" });
  let title = sanitizeProduct(String(result?.title || "").trim());
  let copy = sanitizeProduct(String(result?.copy || "").trim());
  if (!title || looksLikeRawBrief(title, topic) || titleConflictsWithTopic(title, topic, shots) || tooSimilarCopy({ title, copy: "" }, avoidCopies)) {
    const pool = copyTitlePool(intent, kind, batchVariant);
    title = pool[Math.abs((topic || "").length + (shots || []).length) % pool.length];
  }
  if (!copy || looksLikeRawBrief(copy.slice(0, 80), topic) || /想要宣传|画面风格|不要有页码|利他性强/.test(copy) || tooSimilarCopy({ title, copy }, avoidCopies)) {
    copy = fallbackXhsCopy({ intent, shots, account, kind, batchVariant, product });
  }
  copy = deTemplateCopy(copy);
  return {
    title: stripOwnProductMentions(title, product),
    copy: stripOwnProductMentions(copy, product)
  };
}

function fallbackXhsCopy({ intent, shots = [], account = {}, kind = "image", batchVariant = null, product = null }) {
  const variant = copyVariant((account.name || "").length + intent.pain.length, batchVariant);
  const toolLabel = publicCopyProductLabel(intent, product);
  const publicScene = intent.productName
    ? String(intent.scene || "").replace(new RegExp(escapeRegExp(intent.productName), "g"), toolLabel)
    : String(intent.scene || "");
  const lines = (shots || []).map(s => stripPromptMeta(s.line || s.idea || s.visual || "")).filter(Boolean);
  const usableLine = (x) => x && x.length >= 10 && x.length <= 42 && !/面向|有真实的感觉|小红书|配图|画面|构图|白底|无页码|不要|整体|参考|风格|按钮|高亮|截图|文案|打开\s*(Dumate|百度搭子)|一句话交给|自己动手干|效率交给/.test(x);
  const dataLike = /论文|课件|考点/.test(intent.pain) ? "资料、课件、表格和导师要求"
    : /周报|汇报/.test(intent.pain) ? "本周进展、数据截图和零散结论"
    : /格式|转换/.test(intent.pain) ? "PDF、Word、合同和字段要求"
    : /表格|数据/.test(intent.pain) ? "Excel、CSV 和关键指标"
    : /会议/.test(intent.pain) ? "录音、聊天记录和会议待办"
    : "文件、截图和零散需求";
  const seed = (account.name || "").length + intent.pain.length + (variant?.key || "").length;
  const choose = (arr, offset = 0) => arr[Math.abs(seed + offset) % arr.length];
  const shotHint = lines.filter(usableLine).slice(0, 2).map(x => x.replace(/[。！？!?]+$/, "")).join("；");
  const sceneExamples = {
    "tool-division": `我会把资料先放在知识库或文档里沉淀，再让${toolLabel}负责读取文件、提字段和整理结果。这样分工后，写稿、做表、复盘不会全挤在一个聊天窗口里。`,
    "template-save": `我的写法会更偏执行：先说资料范围，再写交付格式，最后要求它把不确定项单独列出来。下次只换材料，流程不用重新解释。`,
    "mistake-fix": `以前一句"帮我整理"很容易得到一段漂亮废话。现在我会把目标字段、判断标准和输出格式写清楚，结果不对也知道该从哪一步改。`,
    "time-save": `我最在意的不是它生成得快不快，而是能不能少掉反复复制、改格式、核对遗漏这些低价值动作。`,
    "combo-wow": `这类工作最好别迷信单个工具。一个负责存资料和结构，一个负责把桌面动作跑完，最后再把结果回填到原来的项目里。`,
    "anti-chat": `把 AI 当聊天框用，最后还是要自己搬数据。把它当执行流程用，关键是提前说清资料在哪里、要做什么、结果长什么样。`,
    "starter-guide": `第一次不要上来就做大自动化，拿一个低风险文件夹练手就够了。能看懂输出、能复核遗漏，再把这套方法迁到正式工作里。`,
    "question-talk": `它有没有用，别看宣传词，看任务是不是固定、材料是不是明确、结果是不是能检查。满足这三点，工具才真的能帮上忙。`,
    "collection": `我会优先保存四类句式：分类、提字段、生成清单、复核遗漏。它们不花哨，但刚好覆盖了大部分重复办公动作。`,
    "proof-shot": `判断一个工具是否靠谱，我会先看输出物：字段有没有漏、分类是否说得通、结论能不能回到原资料里验证。`
  };
  const method = sceneExamples[variant?.key] || `我会先把${dataLike}放到同一个任务里，再写清楚"${intent.action}"和最终交付格式。中间不用急着夸效率，先看它有没有把遗漏项、判断依据和可复核结果列出来。`;
  const detail = shotHint
    ? `这次图卡里已经有两个可用细节：${shotHint}。正文可以顺着这两个细节写，不要另起一套空泛说法。`
    : `可以从一个很小的场景写起，比如周报、资料归档、表格字段或会议待办。场景越具体，读者越容易判断自己能不能照着做。`;
  const openerPool = [
    `我后来发现，${intent.pain}最耗人的地方不是难，而是每次都要重新解释一遍。`,
    `如果你也经常被${dataLike}拖住，可以先别急着换工具，先把任务说清楚。`,
    `我试这类工具时会先看一个很土的指标：跑完之后，结果能不能直接拿去复核。`,
    `很多 AI 办公内容写得太满了，真正有用的反而是那几个能立刻照做的小动作。`,
    `${publicScene || toolLabel}这类工具最适合接的，不是灵感问题，而是边界清楚的重复动作。`
  ];
  if (variant?.key === "real-test") openerPool.unshift(`我按真实工作流跑了一遍，最值得写的不是功能多，而是结果有没有交代清楚。`);
  if (variant?.key === "before-after") openerPool.unshift(`以前处理${dataLike}经常越理越乱，现在我会先把它们拆成能检查的几类。`);
  if (variant?.key === "one-person-team") openerPool.unshift(`一个人干活最怕的不是任务多，是每个任务都要从零开始组织。`);
  const opener = choose(openerPool, 2);
  const forms = [
    `${opener}\n\n${method}\n\n${detail}\n\n最后一定留一个人工复核动作：检查字段有没有漏、分类是不是合理、结果能不能回到原资料。这个动作不酷，但它决定内容有没有含金量。`,
    `${opener}\n\n我的习惯是先把"要它做什么"写成一句完整任务，而不是直接丢一句帮我整理。比如资料范围、目标字段、输出格式这三件事，少一个都会让结果变虚。\n\n${method}\n\n所以这类工具不是替你判断全部事情，更像把重复整理先压下去，让人把注意力留给最后的判断。`,
    `${opener}\n\n${detail}\n\n真正能复用的是这条顺序：先给材料边界，再写结果样式，跑完后让它列出不确定项。看起来慢半拍，但比反复重生成更稳。\n\n如果是重要资料，我不会直接复制结果，会先抽查原文、表格或文件名，再决定能不能进入下一步。`
  ];
  const copy = choose(forms, 5);
  const tags = `#AI办公 #自动化办公 #打工人效率 #${intent.audience} #${toolLabel.replace(/[ /]/g, "")}`;
  return stripOwnProductMentions(deTemplateCopy(`${copy}\n\n${tags}`), product);
}

function allProductsForAI() {
  return (state.products && state.products.length) ? state.products : PRODUCT_CATALOG_SEED;
}

function isDumateProduct(product) {
  const text = `${product?.id || ""} ${product?.name || ""} ${product?.shortName || ""}`;
  return !product || /dumate|百度搭子|搭子/i.test(text);
}

function ownProductAliases(product = null) {
  const ours = allProductsForAI().filter(p => p?.owner === "ours" || isDumateProduct(p) || /miaoda|秒哒/i.test(`${p?.id || ""} ${p?.name || ""} ${p?.shortName || ""}`));
  const list = [product, ...ours].filter(Boolean);
  return [...new Set(list.flatMap(productAliases))]
    .filter(x => x && !/^AI$/i.test(x))
    .sort((a, b) => b.length - a.length);
}

function stripOwnProductMentions(text = "", product = null) {
  let out = sanitizeProduct(String(text || ""));
  const generic = genericProductLabel(product);
  ownProductAliases(product).forEach(alias => {
    const re = productMentionRegex(alias);
    if (re) out = out.replace(re, (m, a = "", b = "") => `${a || ""}${generic}${b || ""}`);
  });
  return out
    .replace(/#(?:百度搭子|百度秒哒|Dumate|DuMate|秒哒|搭子)\b/gi, `#${generic}`)
    .replace(/搭子/g, generic)
    .replace(new RegExp(`${escapeRegExp(generic)}\\s*${escapeRegExp(generic)}`, "g"), generic)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function baseProductFacts(product) {
  return isDumateProduct(product) ? DUMATE_BRIEF + "\n\n" : "";
}

function trendReferenceForCopy(prep = null, product = null) {
  const items = Array.isArray(prep?.referenceItems) ? prep.referenceItems.slice(0, 5) : [];
  if (!items.length) return "";
  return items.map((item, i) => {
    const bits = [
      `${i + 1}. 标题：${stripOwnProductMentions(item.title || "", product)}`,
      item.author ? `作者：${sanitizeXhsText(item.author)}` : "",
      item.likes ? `互动：${sanitizeXhsText(String(item.likes))}` : "",
      item.desc ? `正文/摘要可用信息：${stripOwnProductMentions(sanitizeXhsText(item.desc).slice(0, 360), product)}` : "正文不可得：只能参考标题钩子、互动信号和选题方向。"
    ].filter(Boolean);
    return bits.join("\n");
  }).join("\n\n");
}

function productListLine(list = []) {
  return list.map(p => `${productDisplayName(p, "同类工具")}（${sanitizeProduct(p.category || "同类工具")}）`).join("、");
}

function productRelationLine(list = []) {
  return list.map(p => {
    const angles = [...(p.blogAngles || []), ...(p.comparisonAngles || []), ...(p.tutorialAngles || [])]
      .filter(Boolean)
      .slice(0, 2)
      .join("；");
    const features = (p.coreFeatures || []).slice(0, 4).join("/");
    return `${productDisplayName(p, "同类工具")}：${sanitizeProduct(p.category || "同类工具")}；能力 ${sanitizeProduct(features || "按已知信息克制引用")}；可用角度 ${sanitizeProduct(angles || "只作场景对照")}`;
  }).join("\n");
}

function showTrendSearchNotice(message = "") {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  try {
    if (window.localStorage?.getItem(TREND_NOTICE_KEY) === "1" || trendNoticeShown) return;
  } catch {}
  trendNoticeShown = true;
  const box = document.createElement("div");
  box.className = "modal-ov open";
  box.id = "xhsTrendNotice";
  box.innerHTML = `<div class="modal-panel sm">
    <h3>联网参考热门暂不可用</h3>
    <p class="muted">${sanitizeProduct(message || "服务器进程未检测到 OpenCLI，或服务器侧 OpenCLI 未完成小红书授权。本机浏览器配置不会自动同步到线上服务；本次会自动使用本地趋势库继续生成。")}</p>
    <div class="modal-actions">
      <button class="btn ghost sm" data-trend-ok>确定</button>
      <button class="btn primary sm" data-trend-mute>不再提醒</button>
    </div>
  </div>`;
  const close = () => box.remove();
  box.addEventListener("click", e => {
    if (e.target === box || e.target.closest("[data-trend-ok]")) close();
    if (e.target.closest("[data-trend-mute]")) {
      try { window.localStorage?.setItem(TREND_NOTICE_KEY, "1"); } catch {}
      close();
    }
  });
  document.body.appendChild(box);
}

function trendItemKey(item = {}) {
  return normalizeForDedupe(`${item.url || ""}|${item.title || ""}|${item.author || ""}`).slice(0, 120);
}

function readUsedTrendRefs() {
  if (typeof window === "undefined") return new Set();
  try {
    const arr = JSON.parse(window.localStorage?.getItem(TREND_USED_KEY) || "[]");
    return new Set(Array.isArray(arr) ? arr.filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function rememberTrendRefs(items = []) {
  if (typeof window === "undefined" || !items.length) return;
  try {
    const used = readUsedTrendRefs();
    items.forEach(item => {
      const key = trendItemKey(item);
      if (key) used.add(key);
    });
    window.localStorage?.setItem(TREND_USED_KEY, JSON.stringify([...used].slice(-160)));
  } catch {}
}

async function fetchOnlineTrendItems(query = "") {
  const q = String(query || "").trim();
  if (!q || typeof fetch === "undefined") return [];
  try {
    const res = await fetch("/api/research/xhs-trends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, limit: 8 })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      if (["opencli_missing", "auth_required", "timeout", "opencli_failed"].includes(json.reason)) {
        showTrendSearchNotice(json.message);
      }
      return [];
    }
    const items = normalizeTrendItems(json.items || []);
    const used = readUsedTrendRefs();
    const fresh = items.filter(item => !used.has(trendItemKey(item)));
    const repeated = items.filter(item => used.has(trendItemKey(item)));
    const ordered = [...fresh, ...repeated].slice(0, 8);
    rememberTrendRefs(ordered.slice(0, fresh.length ? Math.min(3, fresh.length) : 1));
    return ordered;
  } catch {
    return [];
  }
}

async function resolveTrendPrep({ topic = "", account = {}, product = null, batchVariant = null, useOnlineTrends = false, kind = "image", imageCount = DEFAULT_XHS_IMAGE_COUNT, seed = "" } = {}) {
  const query = buildTrendSearchQuery({ topic, account, product, batchVariant, kind });
  const allowOnline = kind === "image" && useOnlineTrends;
  const onlineItems = allowOnline ? await fetchOnlineTrendItems(query) : [];
  return buildTrendPrep({ topic, account, product, batchVariant, onlineItems, useOnlineTrends: allowOnline, kind, imageCount, seed });
}

async function resolveTrendGuide({ topic = "", account = {}, product = null, batchVariant = null, useOnlineTrends = false, kind = "image", imageCount = DEFAULT_XHS_IMAGE_COUNT, seed = "" } = {}) {
  const prep = await resolveTrendPrep({ topic, account, product, batchVariant, useOnlineTrends, kind, imageCount, seed });
  return prep.guide || buildTrendGuide({ topic, account, product, batchVariant, kind, imageCount, seed });
}

function trimCreativeBrief(text, max = 220) {
  const s = sanitizeXhsText(cleanText(text || ""));
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf("，"));
  return (last >= 80 ? cut.slice(0, last + 1) : cut).replace(/[，；、:：]$/, "。");
}

function productAliases(product) {
  return [product?.name, product?.shortName, product?.id]
    .filter(Boolean)
    .flatMap(x => String(x).split(/[\/｜|、\s]+/))
    .map(x => x.trim())
    .filter(x => x && x.length >= 2);
}

function escapeRegExp(text = "") {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function productMentionRegex(alias) {
  const raw = String(alias || "").trim();
  if (!raw) return null;
  const escaped = escapeRegExp(raw);
  return /^[a-z0-9][a-z0-9._-]*$/i.test(raw)
    ? new RegExp(`(^|[^a-z0-9._-])${escaped}([^a-z0-9._-]|$)`, "i")
    : new RegExp(escaped, "i");
}

function productsMentionedIn(text = "", currentProduct = null, limit = 4) {
  const src = cleanText(text || "");
  if (!src) return [];
  const currentId = currentProduct?.id;
  return allProductsForAI()
    .filter(p => p?.id && p.id !== currentId)
    .filter(p => productAliases(p).some(alias => {
      const re = productMentionRegex(alias);
      return re && re.test(src);
    }))
    .slice(0, limit);
}

function productRoleLine(product) {
  if (!product) return "";
  const name = productDisplayName(product, "同类工具");
  const src = `${product.id || ""} ${product.name || ""} ${product.shortName || ""} ${product.category || ""}`;
  const category = sanitizeProduct(product.category || "同类工具")
    .replace(/通用任务 Agent（Cloud Browser \/ Browser Operator）/i, "云端通用任务")
    .replace(/编程 Agent（代码库搜索 \/ 多文件修改 \/ 运行测试）/i, "代码与开发任务")
    .replace(/知识库 \/ PKM（本地 Markdown \/ 双向链接）/i, "知识沉淀和双链")
    .replace(/AI 代码编辑器（代码补全 \/ 智能编辑 \/ 项目上下文）/i, "代码编辑")
    .replace(/AI IDE \/ 开发平台（多智能体协作 \/ 项目级开发）/i, "项目级开发");
  if (/obsidian/i.test(src)) return `${name}负责知识沉淀和双链`;
  if (/manus/i.test(src)) return `${name}负责云端通用任务`;
  if (/claude code|openai codex|cursor|trae|windsurf|openclaw/i.test(src)) return `${name}负责代码与开发任务`;
  if (/workbuddy/i.test(src)) return `${name}负责协作知识管理`;
  return `${name}负责${shortChinese(category, 12) || "参照任务"}`;
}

function productRelationDetail(ctx = {}, item = {}) {
  const text = [
    ctx.topic,
    ctx.script,
    item?.prompt,
    item?.idea,
    item?.line,
    item?.visual,
    item?.title
  ].filter(Boolean).join(" ");
  const explicit = productsMentionedIn(text, ctx.product, 4);
  if (!explicit.length) return "";
  const main = chineseProductDisplayName(ctx.product);
  const roles = explicit.map(productRoleLine).filter(Boolean).join("；");
  const names = explicit.map(p => p.shortName || p.name).join("、");
  const mode = /组合|搭配|配合|一起|协同|联动/.test(text) ? "组合用法"
    : /分工|边界|适合|不适合/.test(text) ? "任务分工"
    : /对比|vs|VS|区别|相比|测评/.test(text) ? "功能对比"
    : "工具分工";
  return `本次是${mode}：${main}负责桌面执行和结果交付；${roles || `${names}负责参照任务`}。画面呈现具体分工、衔接动作或适用边界，不能只把${names}当摆设。`;
}

function imageRelationContext(ctx = {}, item = {}) {
  const text = [
    ctx.topic,
    ctx.script,
    item?.prompt,
    item?.idea,
    item?.line,
    item?.visual,
    item?.title
  ].filter(Boolean).join(" ");
  const explicit = productsMentionedIn(text, ctx.product, 4);
  if (!explicit.length) return "";
  const names = explicit.map(p => p.shortName || p.name).join("、");
  const mode = /组合|搭配|配合|一起|协同|联动/.test(text) ? "组合用法"
    : /分工|边界|适合|不适合/.test(text) ? "任务分工"
    : /对比|vs|VS|区别|相比|测评/.test(text) ? "对比关系"
    : "同类参照";
  const detail = productRelationDetail(ctx, item);
  return `${detail || `延续本次${mode}：主产品是 ${chineseProductDisplayName(ctx.product)}，参照对象是 ${sanitizeProduct(names)}。`}画面只呈现双方职责、任务边界或组合流程里与本张主题相关的一点。`;
}

function currentProductLine(product) {
  const p = product || {};
  const aliases = productAliases(p).filter(x => !/^[a-z0-9_-]+$/i.test(x) || /dumate|codex|cursor|manus|trae|windsurf|openclaw|obsidian|workbuddy/i.test(x));
  return `当前产品已锁定：${productDisplayName(p)}${p.shortName ? `（短名：${productDisplayName(p)}）` : ""}。账号名、旧主题或历史素材里若出现其他产品名，只能当作旧数据，不得改写成本次产品。${aliases.length ? `选题可以不硬带产品名，但如果出现产品名，必须优先使用：${sanitizeProduct(aliases.join(" / "))}。` : ""}`;
}

function productTopicFallback(product, rel = []) {
  const p = product || {};
  const name = productDisplayName(p);
  const source = [
    ...(p.tutorialAngles || []),
    ...(p.blogAngles || []),
    ...(p.comparisonAngles || [])
  ].filter(Boolean);
  const base = source[(name.length + source.length) % Math.max(1, source.length)] || "真实使用流程复盘";
  if (/对比|分工|区别/.test(base) && rel.length) {
    const other = rel[0]?.shortName || rel[0]?.name || "同类工具";
    return cleanRandomTopicText(`${name}和${productDisplayName(rel[0], other)}怎么分工`, 30);
  }
  return cleanRandomTopicText(`${name}${base}`.replace(/百度秒哒秒哒|秒哒秒哒/g, "秒哒"), 30);
}

function enforceCurrentProductTopic(topic, product, rel = []) {
  const t = cleanRandomTopicText(topic, 30);
  if (!product) return t;
  const isMiaoda = /miaoda|百度秒哒|秒哒/i.test(`${product.id || ""} ${product.name || ""} ${product.shortName || ""}`);
  const isDumate = isDumateProduct(product);
  const wronglyDumate = !isDumate && /Dumate|百度搭子|搭子/.test(t);
  const wronglyMiaoda = !isMiaoda && /百度秒哒|秒哒/.test(t);
  const miaodaCapabilityLeak = isMiaoda
    && /文件整理|乱文件|桌面|会议数据|会议纪要|合同|PDF|Word|Excel|归档|格式转换|本地文件/.test(t)
    && !/应用|页面|H5|原型|小工具|CRM|后台|数据表|报名页/.test(t);
  const dumateCapabilityLeak = isDumate && /聊天搭子|日常聊天|陪聊|聊天机器人|问答机器人|找餐厅|导航|点餐|探店/.test(t);
  if (wronglyDumate || wronglyMiaoda || miaodaCapabilityLeak || dumateCapabilityLeak) return productTopicFallback(product, rel);
  return t || productTopicFallback(product, rel);
}

function productBrief(product) {
  const p = product || {};
  const name = productDisplayName(p, "百度搭子");
  const rel = relatedProducts(p, allProductsForAI(), 5);
  const ownerLine = p.owner === "ours" ? "我们的产品" : p.owner === "competitor" ? "竞品/同类产品" : "产品";
  const featureLine = (p.coreFeatures || []).slice(0, 8).join(" / ");
  const tutorialLine = (p.tutorialAngles || []).slice(0, 5).join("；");
  const comparisonLine = (p.comparisonAngles || []).slice(0, 5).join("；");
  const blogLine = (p.blogAngles || []).slice(0, 5).join("；");
  return `【本次宣传产品】${name}
产品身份：${ownerLine}
产品类别：${p.category || "办公效率 AI Agent"}
核心信息：${sanitizeProduct(p.brief || "桌面端 AI Agent，可理解一句话指令并自动完成文件整理、格式转换、信息提取、数据分析、汇报生成和网页自动操作。")}
核心能力：${sanitizeProduct(featureLine || "按产品事实展开，不编造未确认能力。")}
教程选题可用角度：${sanitizeProduct(tutorialLine || "围绕真实使用流程和可复用方法展开。")}
对比/测评可用角度：${sanitizeProduct(comparisonLine || "可与同类工具做场景、能力边界、适用人群对比。")}
AI 博主视角：${sanitizeProduct(blogLine || "像真实创作者做工具观察，不只硬讲单个产品。")}
可参考同类产品：${productListLine(rel) || "无"}
同类/互补工具细节：
${productRelationLine(rel) || "无"}
表达要求：${sanitizeProduct(p.toneRule || "可信、理性、有梗、像真实用户经验分享；不要硬广，不要强 CTA。")}
脚本和提示词里必须围绕本次产品写；可以引用同类产品做对比、合集或场景分工，但不能把竞品能力误写成本次产品能力。`;
}

function topicalHook(product) {
  return `${TOPICAL_HOOK}

【产品数据库选题意识】
- 你是 AI 博主/工具观察者，不是单一产品说明书。选题可以是教程、对比、测评、场景清单或工具分工。
- 本次主产品优先讲清真实能力；同类产品只作为对照、背景或合集视角，不要喧宾夺主。
- 如果做教程，既可以只讲本次产品的完整流程，也可以提到"这一类工具怎么选/怎么分工"，再自然落到本次产品。
- 用户没有写明确创作内容时，允许主动带 1-2 个同类/互补工具做对比、组合或分工妙用，例如"Obsidian 负责知识沉淀，百度搭子负责桌面执行"。这样内容更像 AI 博主科普，而不是孤立宣传。
- 用户明确写了创作方向时，必须优先服从用户方向；如果用户内容里提到竞品/同类产品，要识别它们在产品库里的功能点，再合理解释它们和本次主产品的关系。不要把竞品能力写成本次主产品能力。
- 如果做图文，画面信息要像真实博主整理出来的经验：对比表、流程卡、工具分工图、边界对照卡、真实桌面场景都可以用。
- 如果是测评、对比或工具选择类选题，不做分数、星级、排名或打分表；改用“适合谁 / 不适合谁 / 任务边界 / 真实证据 / 组合方式”来表达判断。

${productBrief(product)}`;
}

function videoNegative({ hasNarrationAudio = true } = {}) {
  return hasNarrationAudio
    ? "负面约束：无字幕，不生成字幕轨，不生成花字，不出现可读文字，不出现旁白标注、外框、水印，不出现二维码与乱码，不要在屏幕的任何地方加logo，出现文字或界面的地方一律模糊处理；无口播、无人声、无 BGM，可保留轻微真实环境音或操作声。"
    : "负面约束：无字幕，不生成字幕轨，不生成花字，不出现可读文字，不出现旁白标注、外框、水印，不出现二维码与乱码，不要在屏幕的任何地方加logo，出现文字或界面的地方一律模糊处理；无 BGM、无多余音效，不要下载按钮，不要扫码引导。";
}

function timeBlocksForDuration(duration) {
  const dur = Math.max(2, Math.min(15, Math.ceil(duration || 4)));
  const count = dur >= 13 ? 5 : dur >= 10 ? 4 : dur >= 6 ? 3 : (dur > 4 ? 2 : 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    const start = i === 0 ? 0 : Math.min(dur, i * 3);
    let end = i === count - 1 ? dur : Math.min(dur, (i + 1) * 3);
    if (end <= start) end = Math.min(dur, start + 1);
    out.push([start, end]);
  }
  return out.filter(([a, b]) => b > a);
}

function speechSeconds(text) {
  const n = String(text || "").replace(/[\s，。、！？!?,.；;：“”"']/g, "").length;
  return Math.max(3, Math.round(n / 4.2 * 10) / 10);
}

function compactNarration(text, maxChars = 36) {
  const raw = String(text || "").trim();
  if (raw.length <= maxChars) return raw;
  const first = raw.split(/(?<=[。！？!?])/).map(s => s.trim()).find(Boolean);
  if (first && first.length <= maxChars) return first;
  return raw.slice(0, maxChars).replace(/[，、；：,.!?！？。]*$/, "");
}

function splitClauses(text) {
  const raw = String(text || "").replace(/[“”"]/g, "").trim();
  if (!raw) return [];
  const parts = raw
    .split(/(?<=[。！？!?；;])|(?<=[，,、])|(?<=\s)/)
    .map(s => s.trim().replace(/[，,、；;。！？!?]+$/, ""))
    .filter(Boolean);
  const out = [];
  parts.forEach(p => {
    if (p.length <= 24) { out.push(p); return; }
    const split = p
      .replace(/(后来|而且|最后|直接|再也|以前|文件不上传|安全得很|公司资料|不到一分钟|一键|自动)/g, "｜$1")
      .replace(/(，|,|；|;)/g, "｜")
      .split("｜")
      .map(x => x.trim())
      .filter(Boolean);
    if (split.length > 1 && split.every(x => x.length <= 24)) out.push(...split);
    else {
      for (let i = 0; i < p.length; i += 20) out.push(p.slice(i, i + 20));
    }
  });
  return out;
}

function distributeNarration(shots, spans) {
  const clauses = (shots || []).flatMap(s => splitClauses(s.line || ""));
  const out = [];
  let cursor = 0;
  spans.forEach(([a, b]) => {
    const sec = Math.max(1, b - a);
    const maxChars = Math.max(10, Math.min(20, Math.floor(sec * 4.2)));
    let line = "";
    while (cursor < clauses.length) {
      const next = clauses[cursor];
      const joined = line ? `${line}，${next}` : next;
      if (joined.length > maxChars && line) break;
      if (joined.length > maxChars + 4) break;
      line = joined;
      cursor++;
      if (line.length >= maxChars * 0.72) break;
    }
    out.push(line);
  });
  return out;
}

function visualForBlock(shots, i, total, fallback) {
  const list = (shots || []).filter(Boolean);
  if (!list.length) return fallback;
  const idx = Math.min(list.length - 1, Math.floor(i * list.length / Math.max(1, total)));
  return list[idx].visual || list[idx].idea || fallback;
}

const MATERIAL_VISUAL_BEATS = [
  {
    phase: "真实痛点开场",
    move: "环境中景 + 轻微推近 + 情绪铺垫",
    base: "明亮办公室里，画面重点拍真实工作物件：一叠待处理文件、打开的文件夹、停在屏幕边缘的鼠标光标、便签和咖啡杯形成压力。窗外白天自然光进入，屏幕光略冷，画面有真实工作被卡住的停顿感。",
    props: "文件夹、打印纸、便利贴、咖啡杯、键盘、鼠标、会议笔记本"
  },
  {
    phase: "细节触发",
    move: "手部近景 + 斜侧特写 + 小幅跟随",
    base: "镜头切到手部动作：指尖敲击键盘、拖动文件、圈选一片表格、拿起U盘或翻开笔记，动作连续可拍。屏幕只露出大块界面轮廓和模糊色块，重点是动作带来的解决感。",
    props: "手部、鼠标轨迹、键帽反光、纸张边缘、文件卡片"
  },
  {
    phase: "信息流转",
    move: "俯拍/横移 + 卡片滑入 + 克制转场",
    base: "把抽象效率做成可视化：文件卡片像桌面便签一样被归类，表格列从混乱变整齐，几张数据卡片沿着固定路径排队移动。可以用半透明图表块、进度条、分类标签的模糊色块表达处理过程，但不要出现可读小字。",
    props: "模糊数据图、文件卡片、归档盒、进度条、分组色块"
  },
  {
    phase: "动作反应",
    move: "手部特写 + 过肩无脸 + 柔和拉近",
    base: "给画面一点真实动作但不露脸：只拍手从鼠标上放松、肩部或背影轻微后仰、手指停在键盘旁确认结果。背景里的电脑和文件成为辅助，不让出镜人成为主角。",
    props: "手部、肩部背影、放开的鼠标、键盘边缘、窗边自然光"
  },
  {
    phase: "结果收束",
    move: "稳定中近景 + 缓慢拉开 + 自然停顿",
    base: "最后画面从局部结果拉开到整洁桌面或清爽工作区：文件夹被归到三个清晰区域，报告卡片或数据面板以模糊大块呈现，桌面物件恢复秩序，空间光线更亮，形成事情被处理完的松弛感。",
    props: "整洁桌面、归档文件夹、完成卡片、明亮窗光、清爽蓝白色块"
  }
];

const DIGITAL_VISUAL_BEATS = [
  {
    phase: "真人开场",
    move: "中近景 + 正侧三分位 + 轻微推近",
    base: "第一段让同一位真人/数字人出现：人物在明亮办公桌前自然开口，眼神看向镜头再扫向屏幕，表情有真实困扰但不夸张。背景保持干净，有电脑、笔记本、杯子和柔和窗光。",
    props: "人物面部、肩部、桌面、电脑侧影、自然窗光"
  },
  {
    phase: "情绪承接",
    move: "过肩镜头 + 屏幕边缘特写 + 手部衔接",
    base: "从人物切到过肩视角，看到人物把注意力转向任务。画面可展示手部点击、拖动文件、打开输入框，但人物只保留侧脸或肩部轮廓，让参考角色继续统一。",
    props: "侧脸、手部、输入框、模糊任务卡片、浅色桌面"
  },
  {
    phase: "产品执行",
    move: "屏幕特写 + 卡片推进 + 横向跟随",
    base: "后续重点切到产品/任务流程：界面卡片推进、文件分类、数据块重排、表格生成，所有文字模糊处理，只保留蓝白界面轮廓和动效节奏。",
    props: "任务面板、文件卡片、数据图块、进度条、鼠标轨迹"
  },
  {
    phase: "结果确认",
    move: "手部特写 + 结果卡片 + 缓慢拉开",
    base: "镜头回到桌面和屏幕之间，人物的手从鼠标上放松，结果卡片或整理后的文件夹稳定出现。光线从冷白变为更通透的日光，表达解决后的轻松。",
    props: "手部、结果卡片、整齐文件夹、柔和窗光"
  }
];

function unitBeat(opts, i) {
  const account = opts.account || {};
  const digital = account.subType === "数字人";
  const pool = digital && opts.needsCharacter ? DIGITAL_VISUAL_BEATS : MATERIAL_VISUAL_BEATS;
  return pool[Math.min(pool.length - 1, i % pool.length)] || MATERIAL_VISUAL_BEATS[0];
}

function enrichVisualBrief(raw, beat, i, total, u) {
  const visual = String(raw || "").trim();
  const productLine = u.needsImage
    ? "产品界面只作为参考一致性的载体出现，保留窗口轮廓、模块色块、鼠标轨迹和动效，不出现新增 logo，不出现可读小字。"
    : "把重点放在真实办公环境、手部动作、桌面物件、文件/数据的视觉化变化，画面以物件和动作承接信息。";
  const bridge = i === 0
    ? "开头不要急着展示功能，先让观众感到这个问题真实存在。"
    : i === total - 1
      ? "收尾要有完成感，画面稳定下来，情绪从紧绷转为松弛。"
      : "这一段要承接上一段动作，让信息推进像一个连续小短篇。";
  return `${beat.base}${visual ? ` 本段画面核心：${visual}。` : ""}${bridge}${productLine}`;
}

function sceneAnchorLine(account, hasSceneRef, needsCharacter) {
  if (hasSceneRef) return needsCharacter
      ? "统一参考素材中包含场景/产品参考图；角色出现时只参考角色图保持身份，场景和产品界面参考场景/产品图保持空间与品牌一致。"
    : "统一参考素材中包含场景/产品参考图；画面根据参考图保持桌面、界面、产品色块和空间光线一致。";
  if (needsCharacter) return "没有上传场景参考图时，默认场景锚点为明亮真实办公室：浅色桌面、白墙或玻璃隔断、自然窗光、电脑与少量办公物件，空间干净不拥挤。";
  return "";
}

function hasRepeatedNarration(prompt) {
  const lines = [...String(prompt || "").matchAll(/口播(?:原话)?[:：]\s*“?([^”\n。！？!?]{8,})/g)].map(m => m[1].trim());
  return lines.some((x, i) => lines.indexOf(x) !== i);
}

function compactVideoPrompt(prompt, maxLen = 2000) {
  const raw = cleanText(prompt).replace(/\n{3,}/g, "\n\n").trim();
  if (raw.length <= maxLen) return raw;
  const neg = (raw.match(/负面约束[:：][\s\S]*$/) || [""])[0];
  const headRoom = Math.max(900, maxLen - neg.length - 20);
  const head = raw.replace(/负面约束[:：][\s\S]*$/, "").slice(0, headRoom).replace(/[，,；;。\s]*$/, "");
  return `${head}\n\n${neg || "负面约束：无字幕，不生成字幕轨，不生成花字，不出现可读文字，不出现旁白标注、外框、水印，不出现二维码与乱码，不要在屏幕的任何地方加logo，出现文字或界面的地方一律模糊处理；无 BGM、无多余音效，不要下载按钮，不要扫码引导。"}`.slice(0, maxLen);
}

const IMAGE_CARD_TASKS = [
  {
    title: "桌面乱到崩",
    role: "用强点击理由吸引用户进入，不承担教程细节",
    layout: "大字标题作为视觉中心，旁边搭配简单视觉符号、工具标识或前后对比箭头，留白充足",
    visual: "用产品标识、电脑/文件夹小图标、箭头或 VS 关系表达主题，保持入口图简洁有冲击"
  },
  {
    title: "资料堆成山",
    role: "把读者常遇到的混乱场景拆成可识别的问题清单",
    layout: "上方大标题，中间用两到三张卡片横向排布待处理资料，右下角放模糊界面缩略图",
    visual: "文件夹层层嵌套、表格列名混乱、聊天消息和便签交错出现，关键文字只保留真实场景短句"
  },
  {
    title: "一句话接住",
    role: "展示一句指令或一个流程如何把问题接住",
    layout: "中央放输入框或流程主卡，左右两侧用箭头连接原始资料和处理结果",
    visual: "鼠标光标停在输入框旁，文件卡片被自动归类，进度条或步骤圆点用蓝紫色高亮"
  },
  {
    title: "动作跑起来",
    role: "把方法拆成可复制的步骤，而不是只展示结果",
    layout: "竖向动作卡分层展示，每段直接写动词短句，节奏清楚",
    visual: "每一段都对应一个清楚动作：拖入资料、识别字段、生成结果，卡片层级有轻微阴影和留白"
  },
  {
    title: "结果能复用",
    role: "让用户看到前后变化，建立可信度",
    layout: "左右对比结构，左边是处理前的混乱，右边是处理后的整齐结果，中间用细箭头连接",
    visual: "结果区出现整齐文件夹、统计卡片、报告缩略图或清爽表格，文字做模糊化处理但结构清晰"
  },
  {
    title: "流程变轻松",
    role: "给出适用场景和一句可记住的方法结论",
    layout: "大留白结论页，中间放一句核心结论，下方放三枚小卡片总结适用场景",
    visual: "桌面从杂乱变得清爽，产品界面以小窗口形式停在右下角，整体光线更通透"
  }
];

function shortChinese(text, max = 24) {
  const raw = cleanText(text || "")
    .replace(/小红书笔记风格配图|竖版3:4|真实感|高级感/g, "")
    .replace(/清爽种草感|种草感|种草/g, "")
    .replace(/模型给出的视觉线索可提炼为|参考脚本如下/g, "")
    .replace(/^(核心思想|画面|构图|版式|文案|截图|提示词|视觉线索|图上文字|图片任务|本页补充线索)[:：]/, "")
    .replace(/^(封面|种草|共鸣|痛点|痛点引入|问题引入|解决路径|关键步骤|结果对比|总结收束|自然收束|收束|内容页|图\d+|第\d+张|步骤[一二三四五六七八九十\d]*)[·:：｜|\s-]*/g, "")
    .replace(/[「」"'“”]/g, "")
    .replace(/[｜|<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  if (raw.length <= max) return raw;
  const cut = raw.slice(0, max);
  const stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf(";"));
  if (stop > Math.floor(max * 0.55)) return cut.slice(0, stop).replace(/[，、；：,.!?！？。]*$/, "");
  let out = cut.replace(/[，、；：,.!?！？。]*$/, "");
  if (/[A-Za-z]$/.test(out) && /[A-Za-z]/.test(raw.charAt(max))) {
    out = out.replace(/[A-Za-z]{1,24}$/, "").replace(/[，、；：,.!?！？。]*$/, "").trim();
  }
  return out || cut.replace(/[，、；：,.!?！？。]*$/, "");
}

function completeImageText(text = "", max = 34) {
  const raw = cleanText(text || "")
    .replace(/[「」"'“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  const compact = raw
    .replace(/(.{2,16})(?:负责|管)?桌面执行[，,；;、\s]*(Obsidian|知识库)(?:负责|管)?知识沉淀[^，。；;]*/i, "$1执行，$2沉淀")
    .replace(/(.{2,16})(?:动手|先)?整理[，,；;、\s]*(Obsidian|知识库)[^，。；;]*/i, "$1整理，$2沉淀")
    .replace(/(.{2,16})(?:负责|管)?分类[，,；;、\s]*(Obsidian|知识库)[^，。；;]*/i, "$1分类，$2沉淀")
    .replace(/(.{2,16})(?:负责|管)?执行[，,；;、\s]*(Obsidian|知识库)[^，。；;]*/i, "$1执行，$2沉淀")
    .replace(/负责知识沉淀和双链/g, "负责知识沉淀")
    .replace(/知识沉淀和双链/g, "知识沉淀")
    .replace(/桌面执行和结果交付/g, "桌面执行")
    .replace(/自动化办公/g, "自动办公")
    .replace(/\s+/g, " ")
    .trim();
  const candidate = compact || raw;
  if (candidate.length <= max) return candidate;
  const cut = candidate.slice(0, max);
  const stops = ["。", "；", ";", "，", ",", "、", "：", ":"].map(ch => cut.lastIndexOf(ch));
  const stop = Math.max(...stops);
  if (stop >= Math.max(8, Math.floor(max * 0.45))) {
    return cut.slice(0, stop).replace(/[，,；;、：:\s]+$/g, "").trim();
  }
  const safe = shortChinese(candidate, max);
  if (/[A-Za-z]+[\u4e00-\u9fa5]{1,2}$/.test(safe) && candidate.length > safe.length) {
    const prev = Math.max(safe.lastIndexOf("，"), safe.lastIndexOf(","), safe.lastIndexOf("；"), safe.lastIndexOf(";"), safe.lastIndexOf("、"));
    if (prev >= 8) return safe.slice(0, prev).replace(/[，,；;、\s]+$/g, "");
  }
  return safe;
}

const INTERNAL_IMAGE_LABEL_RE = /(封面|痛点引入|问题引入|解决路径|关键步骤|结果对比|总结收束|收束|图片任务|第\d+\/\d+张|第\d+张|图\d+)/g;
const IMAGE_PLANNING_WORD_RE = /(种草|种草感|构图|版式|画面定位|图片定位|内容页|开头钩子|钩子|共鸣场景|共鸣|痛点|痛点引入|问题引入|解决路径|关键步骤|结果对比|总结收束|自然收束|收束|封面|首图|图片任务|核心思想|视觉线索|提示词|文案|截图|图上文字|干货步骤|步骤[一二三四五六七八九十\d]*)/g;
const BAD_IMAGE_HEADLINE_RE = /^(图\d+|第\d+张|内容页|干货步骤|核心思想|画面|版式|构图|文案|截图|提示词|视觉线索|封面|首图|种草|共鸣|痛点|痛点引入|问题引入|解决路径|关键步骤|结果对比|总结收束|自然收束|收束|图片任务|步骤[一二三四五六七八九十\d]*|一眼想点开|吸引点击|点击入口)|想要宣传|不要有页码|利他性强|账号定位|参考图|整体的画面|图\d+\s*[·.-]\s*干货步骤|[｜|<>]/;

function stripStructuredPromptNoise(text = "") {
  return String(text || "")
    .replace(/\b\d+\s*[-~—]\s*\d+\s*s\s*,?/gi, "")
    .replace(/\b(?:idea|visual|line|title|prompt|headline|ui|scene|time)\s*[:=]\s*/gi, "")
    .replace(/["{}[\]]/g, " ")
    .replace(/,+/g, "，")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanImagePlanningWords(text = "") {
  return stripVisibleTextLabels(cleanText(stripStructuredPromptNoise(text)))
    .replace(/清爽种草感/g, "清爽真实分享感")
    .replace(/种草感/g, "真实分享感")
    .replace(/轻种草/g, "轻推荐")
    .replace(/种草/g, "推荐功能")
    .replace(/评分卡/g, "适配判断卡")
    .replace(/评分/g, "适配判断")
    .replace(/打分/g, "适配判断")
    .replace(/星级/g, "适用层级")
    .replace(/排行榜/g, "对照表")
    .replace(/分数表/g, "边界对照表")
    .replace(/分数/g, "判断维度")
    .replace(/排名/g, "对照关系")
    .replace(/给分/g, "给出适配结论")
    .replace(/(?:评分|打分|得分|分数)\s*(\d+)\s*分/g, "$1项维度")
    .replace(/痛点/g, "待处理问题")
    .replace(/共鸣/g, "真实场景")
    .replace(/构图/g, "画面结构")
    .replace(/版式/g, "画面布局")
    .replace(/封面/g, "大字标题页")
    .replace(/首图/g, "大字标题")
    .replace(/关键步骤/g, "关键动作")
    .replace(/步骤([一二三四五六七八九十\d]*)/g, "动作$1")
    .replace(/最多\s*[一二三四五六七八九十\d]+\s*(?:行|个|条|处|段|组|张|字)?\s*(?:重点|短标签|小标签|标签|副标题|主标题|视觉元素|图标|文字|气泡)?/g, "")
    .replace(/(?:控制在|限定在)\s*\d+\s*[-~—]\s*\d+\s*字/g, "按内容复杂度精炼表达")
    .replace(/第一张\s*(?:控制在|限定在)\s*\d+\s*[-~—]\s*\d+\s*字/g, "第一张更简洁有点击感")
    .replace(/只(?:保留|放|讲|写|画|呈现|展示)\s*[一二三四五六七八九十\d]*\s*(?:个|条|处|张|组|行)?/g, "")
    .replace(/本图只(?:讲|放|写|画|呈现|展示)/g, "本图聚焦")
    .replace(/(?:^|[。；;])\s*[^。；;\n]*(?:不要出现|不出现|不要加入|不要放|不要写|禁止出现|避免出现|不得出现|不能出现|不要二维码|不要页码|不要logo|不要乱码)[^。；;\n]*[。；;]?/g, "。")
    .replace(/开头钩子|钩子/g, "开头问题")
    .replace(/结果对比/g, "前后变化")
    .replace(/总结收束|自然收束|收束/g, "结论")
    .replace(/\s+/g, " ")
    .replace(/^[，,。；、\s]+|[，,。；、\s]+$/g, "")
    .trim();
}

function cleanImageDisplayTitle(text = "", fallback = "资料整理完成", max = 32) {
  const raw = completeImageText(stripVisibleTextLabels(cleanImagePlanningWords(text)), max);
  if (!raw || BAD_IMAGE_HEADLINE_RE.test(raw)) return fallback;
  return raw;
}

function cleanScriptTitle(text = "", topic = "", product = null) {
  const productName = productDisplayName(product, "");
  const raw = stripOwnProductMentions(stripCreativeInstructionText(text || ""), product)
    .replace(/不要[^，。；\n]*[，。；]?/g, "")
    .replace(/不能[^，。；\n]*[，。；]?/g, "")
    .replace(/禁止[^，。；\n]*[，。；]?/g, "")
    .replace(/请|帮我|想讲清楚|想讲一个|真实工作流复盘|硬广/g, "")
    .replace(productName, "")
    .replace(/\s+/g, " ")
    .replace(/^[，,。；、\s]+|[，,。；、\s]+$/g, "")
    .trim();
  const fromText = shortChinese(raw, 18);
  if (fromText && !BAD_IMAGE_HEADLINE_RE.test(fromText) && !looksLikeRawBrief(fromText, topic)) return fromText;
  const compactTopic = stripOwnProductMentions(stripCreativeInstructionText(topic || ""), product)
    .replace(/不要[^，。；\n]*[，。；]?/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/Obsidian/i.test(compactTopic)) return "知识库和桌面怎么分工";
  if (/Codex/i.test(compactTopic)) return "写代码和跑桌面别混用";
  if (/合同|报价|金额|负责人/.test(compactTopic)) return "合同资料终于理顺了";
  if (/桌面|文件|资料/.test(compactTopic)) return "桌面乱文件有救了";
  return "重复办公别硬扛";
}

function minimalImageNegative() {
  return "负面约束：不出现页码，不出现二维码，图片右上角和左上角不要加入logo，其他位置可以正常出现logo。";
}

function stripInternalImageLabels(text = "") {
  return cleanImagePlanningWords(text)
    .replace(/(?:封面|痛点引入|问题引入|解决路径|关键步骤|结果对比|总结收束|收束)[:：·｜|\s-]*/g, "")
    .replace(/第\d+\/\d+张[。；，,\s]*/g, "")
    .replace(/图片任务[:：][^。；\n]*[。；]?/g, "")
    .replace(/图上文字[:：]/g, "画面短句：")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeImageSizeText(text = "") {
  return cleanText(text)
    .replace(/画面以小红书竖版3:4（1080×1440）为主/g, "画面按小红书竖版3:4（1080×1440）出图")
    .replace(/小红书笔记风格配图，竖版3:4/g, "小红书笔记风格配图，竖版3:4（1080×1440）")
    .replace(/小红书笔记风格配图，小红书竖版3:4（1080×1440）/g, "小红书笔记风格配图，竖版3:4（1080×1440）")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanImagePromptSignal(text, max = 96) {
  const raw = cleanImagePlanningWords(stripPromptScaffold(stripStructuredPromptNoise(text || "")))
    .replace(/模型给出的视觉线索可提炼为[:：]?/g, "")
    .replace(/参考脚本如下[:：]?/g, "")
    .replace(/(?:核心思想|画面|文案|visual|line|idea)[:：]/gi, "")
    .replace(/图上文字[:：]/g, "画面短句：")
    .replace(/[｜|<>]/g, "，")
    .replace(/^[，,。；、\s]+|[，,。；、\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const styleOnly = /(简笔画|火柴人|手绘|漫画|白底|大字标题|少文字|箭头|气泡|圆角|留白|配色|背景|卡片|字体|色彩)/.test(raw)
    && !/(整理|执行|沉淀|提取|归档|对比|输入|输出|生成|复盘|文件|知识|任务|结果|流程|工具|适合|不适合|Obsidian|Manus|WorkBuddy|Codex|Excel|PDF|Word)/i.test(raw);
  if (styleOnly) return "";
  if (/面向|讲清楚|重点是|画面要|用户输入|创作内容|不要有|整体风格|利他性|直接加入|生成小红书笔记风格|^信息按|^所有文字|^画面文字|图片定位|画面定位|核心[:：]|引出产品|缓推|首页圆角输入框/.test(raw)) return "";
  if (!raw || BAD_IMAGE_HEADLINE_RE.test(raw.slice(0, 24))) return "";
  return shortChinese(raw, max);
}

function isStyleOnlyCue(text = "") {
  const raw = cleanText(text || "");
  if (!raw) return false;
  const style = /(简笔画|火柴人|手绘|漫画|白底|大字标题|少文字|箭头|气泡|圆角|留白|配色|背景|卡片|字体|色彩|组图风|截图质感)/.test(raw);
  const content = /(整理|执行|沉淀|提取|归档|对比|输入|输出|生成|复盘|文件|知识|任务|结果|流程|适合|不适合|Obsidian|Manus|WorkBuddy|Codex|Excel|PDF|Word)/i.test(raw);
  return style && !content;
}

function stripPromptScaffold(text = "") {
  return cleanImagePlanningWords(stripPromptMeta(stripStructuredPromptNoise(text || "")))
    .replace(/如果有参考图，?先吸收参考图的[^。；\n]*(?:重写|替换)[^。；\n]*[。；，,]?/g, "")
    .replace(/综合参考产品界面[^。；\n]*[。；，,]?/g, "")
    .replace(/参考图(?:里|中的)?旧标题[^。；\n]*[。；，,]?/g, "")
    .replace(/（?请根据上传的参考图[^。；\n]*[。；，,]?）?/g, "")
    .replace(/请根据上传的参考图[^。；\n]*[。；，,]?/g, "")
    .replace(/生成小红书笔记风格\s*3:4\s*尺寸(?:图片)?[，,。；\s]*/g, "")
    .replace(/小红书笔记风格配图[，,。；\s]*/g, "")
    .replace(/【\s*账号定位\s*[:：][^】]*】/g, "")
    .replace(/【\s*图片风格\s*[:：][^】]*】/g, "")
    .replace(/【[^】]*(?:账号定位|账号风格|图片风格|视角)[^】]*】/g, "")
    .replace(/图片具体内容\s*[:：]\s*【?/g, "")
    .replace(/精准描述图片(?:的)?内容，?所有文字清晰可读/g, "")
    .replace(/负面约束\s*[:：][\s\S]*$/g, "")
    .replace(/账号定位\s*[:：]\s*/g, "")
    .replace(/(?:账号风格|图片风格|整体风格)\s*[:：]\s*/g, "")
    .replace(/模型给出的视觉线索可提炼为[:：]?/g, "")
    .replace(/参考脚本如下[:：]?/g, "")
    .replace(/(?:核心思想|画面|文案|visual|line|idea)[:：]/gi, "")
    .replace(/图上文字[:：]/g, "画面短句：")
    .replace(/[【】]/g, "")
    .replace(/[｜|<>]/g, "，")
    .replace(/，{2,}/g, "，")
    .replace(/^[，,。；、\s]+|[，,。；、\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFieldLabel(text = "", label = "") {
  const raw = cleanText(text || "");
  if (!raw) return "";
  const re = new RegExp(`^${label}\\s*[:：]\\s*`);
  return raw
    .replace(re, "")
    .replace(/^账号定位\s*[:：]\s*/, "")
    .replace(/^账号风格\s*[:：]\s*/, "")
    .replace(/^整体风格\s*[:：]\s*/, "")
    .replace(/^图片风格\s*[:：]\s*/, "")
    .trim();
}

function compactImageStyle(text = "", max = 38) {
  const raw = cleanImagePlanningWords(stripPromptScaffold(stripFieldLabel(text, "账号风格")));
  if (!raw) return "";
  const parts = raw.split(/[，,；;。]+/).map(x => x.trim()).filter(Boolean);
  const picked = [];
  for (const part of parts) {
    const next = [...picked, part].join("，");
    if (next.length > max && picked.length) break;
    if (part.length <= max) picked.push(part);
    else if (!picked.length) picked.push(shortChinese(part, max));
    if (picked.join("，").length >= max * 0.72) break;
  }
  return (picked.join("，") || shortChinese(raw, max))
    .replace(/风为$/, "风为辅")
    .replace(/为主、([^，。；;]+)为$/, "为主、$1为辅")
    .replace(/[，,；;、]\s*$/, "");
}

function copyTextForImagePlanning(copy = null) {
  if (!copy) return "";
  return cleanText([
    copy.title ? stripVisibleTextLabels(copy.title) : "",
    stripVisibleTextLabels(copy.body || copy.copy || "")
  ].filter(Boolean).join("\n"));
}

function copyTitleForImagePlanning(copy = null, product = null) {
  const raw = stripOwnProductMentions(stripVisibleTextLabels(copy?.title || copy?.headline || ""), product)
    .replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const title = cleanImagePlanningWords(raw)
    .replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/g, "")
    .replace(/[，,。；;、\s]+$/g, "")
    .trim();
  if (!title || BAD_IMAGE_HEADLINE_RE.test(title.slice(0, 24))) return "";
  return title;
}

function summarizeImageIntent({ script = "", topic = "", account = {}, product = null, copy = null }) {
  const copyText = copyTextForImagePlanning(copy);
  const src = stripPromptMeta(cleanText(copyText || topic || script || ""));
  const inferred = inferCopyIntent({ topic: src, account, product, useAccountPosition: false });
  const productName = chineseProductDisplayName(product, "百度搭子");
  const compact = src
    .replace(/(请|帮我|生成|做一篇|做一个|图片|图文|笔记|提示词|小红书)/g, "")
    .replace(/面向[^，。；\n]*[，。；]?/g, "")
    .replace(/讲清楚|重点是|画面要像|真实小红书效率笔记/g, "")
    .replace(/图\d+[:：][^。；\n]+/g, "")
    .replace(/(?:核心思想|画面|文案|visual|line|idea)[:：]/gi, "")
    .replace(/[｜|<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const relationTools = productsMentionedIn(src, product, 3);
  const inferredMain = `${inferred.audience}${inferred.pain.replace(/^(.{2,8})?太/, "").replace(/太/g, "")}`;
  const relationMain = relationTools.length
    ? /对比|vs|VS|区别|分工|边界|相比|测评/.test(src)
      ? "两个工具怎么分工"
      : "工具组合更省事"
    : "";
  const main = relationMain || (compact && !/面向|讲清楚|重点是|不要有|画面风格|我想|帮我|图片只有|硬广/.test(compact)
    ? shortChinese(compact, 36)
    : shortChinese(inferredMain, 36) || `${productName}办公效率方法`);
  return {
    main,
    productName,
    audience: inferred.audience || "目标读者",
    pain: inferred.pain,
    action: inferred.action,
    result: inferred.result,
    tone: shortChinese(account.tone || "", 18) || "真实经验分享"
  };
}

function deriveImageHeadline(item, i, intent, task) {
  const structured = cleanImagePlanningWords(item?.line || item?.prompt || "");
  const fromLine = structured.match(/(?:文案|图上文字|大标题)[:：]\s*([^｜\n。；]+)/)?.[1];
  const fallbackByTask = [
    `${intent.main || "重复办公"}别硬扛`,
    `${intent.pain || "重复动作"}卡在哪`,
    `一句话把流程跑起来`,
    `三步把资料理顺`,
    `前后对比很明显`,
    `把重复动作交给流程`
  ];
  const candidates = [
    i === 0 ? item?.headline : item?.title,
    i === 0 ? intent.main : "",
    i === 0 ? item?.line || item?.idea : "",
    i === 0 ? item?.title : "",
    item?.headline,
    fromLine,
    i === 0 ? `${intent.main}怎么破` : "",
    fallbackByTask[Math.min(i, fallbackByTask.length - 1)]
  ];
  const picked = candidates
    .map(x => cleanImageDisplayTitle(x, ""))
    .find(x => x && !BAD_IMAGE_HEADLINE_RE.test(x));
  return picked || fallbackByTask[Math.min(i, fallbackByTask.length - 1)] || `${intent.productName}到底省在哪`;
}

function isLightIllustrationStyle(ctx = {}) {
  const src = [
    ctx.style,
    ctx.imageTemplate,
    ctx.account?.styleProfile,
    ctx.account?.name,
    ctx.account?.tone
  ].filter(Boolean).join(" ");
  return /火柴人|简笔画|小人|漫画|手绘|插画|涂鸦|故事|对话气泡|四格/.test(src);
}

function imageBeatCue(item, ctx, max = 52) {
  if (ctx.beat) return completeImageText(ctx.beat, max);
  const raw = stripPromptScaffold(cleanText(item?.prompt || item?.idea || item?.line || item?.visual || item?.title || ctx.topic || ""));
  if (raw.length > max * 1.8 && ctx.beat) return completeImageText(ctx.beat, max);
  const cue = cleanImagePromptSignal(stripInternalImageLabels(raw), max);
  return cue || completeImageText(stripPromptScaffold(ctx.topic || ctx.script || ""), max) || "";
}

function splitImageBeats(ctx = {}, n = DEFAULT_XHS_IMAGE_COUNT) {
  const raw = stripPromptScaffold(cleanText(copyTextForImagePlanning(ctx.copy) || ctx.script || ctx.topic || ""));
  const relationTools = productsMentionedIn(raw, ctx.product, 2);
  const parts = raw
    .replace(/(第一张|第二张|第三张|第四张|第五张|第六张|第七张|第八张|第九张|第十张)/g, "。$1")
    .replace(/(前排张|第二张|第三张|小技巧|适合|不适合|从一句话)/g, "。$1")
    .split(/[。；;\n]+|——|，(?=(?:第二|第三|第四|第五|第六|小技巧|适合|不适合|再用|然后))/)
    .map(x => stripInternalImageLabels(x)
      .replace(/^\s*\d+\s*[.)、:：]\s*/, "")
      .replace(/^.{0,14}[:：]/, "")
      .replace(/^(请|帮我)?讲清楚/, "")
      .replace(/百度搭子本地桌面对\s*Manus\s*云端通用任务[^，。；]*/i, "本地桌面 vs 云端任务")
      .replace(/从回答到交付的\s*AI\s*Agent\s*分水岭/gi, "回答到交付的差别")
      .replace(/前排张/g, "")
      .trim())
    .map(x => completeImageText(x, 36))
    .filter(x => x && !BAD_IMAGE_HEADLINE_RE.test(x) && !/核心[:：]|引出产品|缓推|首页圆角输入框/.test(x));
  const uniq = [];
  parts.forEach(x => { if (!uniq.some(y => y === x || y.includes(x) || x.includes(y))) uniq.push(x); });
  const fallback = relationTools.length
    ? [
      "先判断任务类型",
      "一个负责执行一个沉淀",
      "文件资料先交给桌面流程",
      "知识经验再放进知识库",
      "看清适合谁不适合谁",
      "最后形成可复用流程"
    ]
    : [
      "桌面文件先聚到一起",
      "一句话说清整理目标",
      "自动归类重复资料",
      "关键字段被提取出来",
      "结果能直接复用交付",
      "从小流程开始训练"
    ];
  return Array.from({ length: n }, (_, i) => uniq[i] || fallback[Math.min(i, fallback.length - 1)]);
}

function imageDensityMode(ctx = {}) {
  const raw = stripPromptScaffold(cleanText(copyTextForImagePlanning(ctx.copy) || ctx.script || ctx.topic || ""));
  if (raw.length < 42) return "sparse";
  if (raw.length > 180) return "dense";
  return "balanced";
}

function simpleRelationVisual(ctx = {}) {
  const text = copyTextForImagePlanning(ctx.copy) || [ctx.script, ctx.topic].filter(Boolean).join(" ");
  const mentioned = productsMentionedIn(text, ctx.product, 2);
  if (!mentioned.length) return "";
  const main = chineseProductDisplayName(ctx.product, "百度搭子");
  const other = productDisplayName(mentioned[0], "同类工具");
  const connector = /对比|vs|VS|区别|相比|测评/.test(text) ? "VS" : "+";
  return `${other}与${main}两个标识作为主视觉，中间用「${connector}」或箭头表达关系。`;
}

function conciseRelationLine(ctx = {}, item = {}) {
  const text = [
    copyTextForImagePlanning(ctx.copy),
    ctx.script,
    item?.line,
    item?.idea,
    item?.visual,
    item?.title
  ].filter(Boolean).join(" ");
  const explicit = productsMentionedIn(text, ctx.product, 2);
  if (!explicit.length) return "";
  const main = chineseProductDisplayName(ctx.product, "百度搭子");
  const roles = explicit.map(productRoleLine).filter(Boolean).join("；");
  return `${main}负责桌面执行；${roles || explicit.map(p => productDisplayName(p)).join("、") + "负责参照任务"}。`.slice(0, 42);
}

function coverBeatText(item, ctx, intent) {
  const candidates = [
    item?.line,
    item?.title,
    item?.idea,
    intent.main,
    copyTextForImagePlanning(ctx.copy),
    ctx.topic
  ];
  return candidates
    .map(x => cleanImageDisplayTitle(x, ""))
    .find(Boolean) || intent.main || "这套流程更省事";
}

function promptCanBeDense(ctx = {}, item = {}) {
  const src = [
    copyTextForImagePlanning(ctx.copy),
    ctx.style,
    ctx.imageTemplate,
    ctx.account?.styleProfile,
    item?.visual,
    item?.line,
    item?.idea,
    item?.prompt,
    item?.title
  ].filter(Boolean).join(" ");
  return /模拟飞书|飞书文档|文档截图|表格截图|Excel表|数据表|日报|周报|长文|报告页|清单页|文章页|备忘录页/.test(src);
}

function richImagePrompt(item, i, total, ctx) {
  const task = IMAGE_CARD_TASKS[Math.min(i, IMAGE_CARD_TASKS.length - 1)] || IMAGE_CARD_TASKS[IMAGE_CARD_TASKS.length - 1];
  const intent = summarizeImageIntent(ctx);
  const lightStyle = isLightIllustrationStyle(ctx);
  const density = imageDensityMode(ctx);
  const isCover = i === 0;
  const fullCoverTitle = isCover ? copyTitleForImagePlanning(ctx.copy, ctx.product) : "";
  const canDense = promptCanBeDense(ctx, item);
  const localCueRaw = imageBeatCue(item, { ...ctx, topic: "", script: "", beat: "" }, lightStyle ? 32 : canDense ? 42 : 36);
  const styleText = cleanText(ctx.style || ctx.account?.styleProfile || "");
  const localCue = isStyleOnlyCue(localCueRaw) || (localCueRaw && styleText.includes(localCueRaw)) ? "" : localCueRaw;
  const cue = isCover
    ? fullCoverTitle || coverBeatText(item, ctx, intent)
    : localCue || completeImageText(ctx.beat || "", canDense ? 42 : 36);
  const oneBeat = cue || intent.main;
  const contentCue = isCover
    ? `围绕「${oneBeat}」做大字标题页，画面留白。`
    : lightStyle
    ? `围绕「${oneBeat}」用小人动作、表情和气泡表达，文字少量辅助。`
    : canDense
      ? `围绕「${oneBeat}」用一个文档/表格局部承载，信息分层清楚。`
      : density === "sparse"
        ? `围绕「${oneBeat}」补一个真实例子。`
        : `围绕「${oneBeat}」安排一个核心动作或结果，留白足，逻辑清楚。`;
  const title = fullCoverTitle || cleanImageDisplayTitle(item?.title, task.title);
  const relationCover = isCover && simpleRelationVisual(ctx);
  let headlineRaw = fullCoverTitle || (relationCover ? intent.main : deriveImageHeadline(item, i, intent, task));
  if (!isCover && IMAGE_CARD_TASKS.some(t => t.title === headlineRaw) && oneBeat) headlineRaw = oneBeat;
  const headline = fullCoverTitle || completeImageText(headlineRaw, isCover ? 48 : canDense ? 40 : 36);
  const imageStyle = ctx.style
    ? compactImageStyle(ctx.style, isCover ? 24 : lightStyle ? 32 : 38)
    : "白底或浅色底，圆角卡片，大留白，真实办公截图质感，蓝紫点缀，文字大而清楚。";
  const refPrefix = ctx.styleRefName
    ? `请根据上传的参考图（${ctx.styleRefName}）。`
    : "";
  const relationCore = conciseRelationLine(ctx, item);
  const coverRelation = simpleRelationVisual(ctx);
  const productLine = ctx.product
    ? (isCover
      ? `${coverRelation || `${intent.productName}可用简化标识出现。`}`
      : lightStyle
      ? `${relationCore || `${intent.productName}呈现本张主题相关的一个动作或结果。`}`
      : `${relationCore || `${intent.productName}呈现一个办公动作和结果。`}`)
    : "产品表达以真实办公流程和界面结果为主。";
  const layoutLine = isCover
    ? "超大标题作为视觉中心，少量图标或箭头辅助，强对比"
    : lightStyle
    ? "中央简笔画小人+电脑/文件小物件"
    : canDense
      ? "大标题+局部文档/表格卡片，信息分层清楚"
      : "大标题+一个主视觉卡片+一处结果提示";
  const visualLine = isCover
    ? "干净背景，画面空旷有冲击"
    : lightStyle
    ? "用表情、手势、文件图标和轻箭头讲动作"
    : canDense
      ? "局部文字可读，用操作箭头和结果状态形成层次"
      : "一个办公物件或界面卡片突出核心动作";
  const textLine = isCover
    ? `文字以超大标题「${headline}」为主，标题必须完整出现，不得截断；可分两行排版，配一句短副标题，画面保留呼吸感。`
    : lightStyle
    ? `文字以标题「${headline}」和简短气泡配合人物动作；标题必须完整出现，不得截断，必要时分两行。`
    : canDense
      ? `画面文字围绕完整标题「${headline}」展开，不得截断标题，并配合文案提炼的关键说明自然排布。`
      : `文字以完整标题「${headline}」和一句短副标题为主，不得截断标题，必要时加入功能标签。`;
  const promptBody = cleanImagePlanningWords(isCover
    ? `${refPrefix}生成小红书笔记风格3:4尺寸图片。【图片风格：${imageStyle}】图片具体内容：【${productLine}${layoutLine}；${visualLine}；${textLine}】`
    : lightStyle
    ? `${refPrefix}生成小红书笔记风格3:4尺寸图片。【图片风格：${imageStyle}】图片具体内容：【${productLine}${layoutLine}；${contentCue}${textLine}】`
    : `${refPrefix}生成小红书笔记风格3:4尺寸图片。【图片风格：${imageStyle}】图片具体内容：【${productLine}${layoutLine}；${visualLine}；${contentCue}${textLine}】`);
  return {
    title,
    ui: item?.ui !== false,
    prompt: normalizeImageSizeText(stripVisibleTextLabels(sanitizeOwnProductForGeneratedText(`${promptBody}${minimalImageNegative()}`)))
  };
}

function normalizeImagePromptItems(items, ctx) {
  const n = Math.max(3, Math.min(12, Number(ctx.imageCount) || (items || []).length || DEFAULT_XHS_IMAGE_COUNT));
  const src = Array.isArray(items) ? items : [];
  const beats = splitImageBeats(ctx, n);
  return Array.from({ length: n }, (_, i) => richImagePrompt(src[i] || {}, i, n, { ...ctx, beat: beats[i] }));
}

function stripCreativeInstructionText(text = "") {
  return cleanText(stripStructuredPromptNoise(text))
    .replace(/帮我做一篇|帮我做一个|帮我生成|生成一篇|生成一个|做成小红书笔记|做成图文笔记|做成笔记|小红书笔记|图文笔记/g, "")
    .replace(/只要\s*\d+\s*张图|拆成\s*\d+\s*张图|共生成\s*\d+\s*张图|要\s*\d+\s*张图/g, "")
    .replace(/本次创作内容|用户创作内容|用户方向|主题是|主题[:：]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function scriptInputText(script) {
  if (!script) return "";
  const rows = Array.isArray(script) ? script : Array.isArray(script?.shots) ? script.shots : null;
  if (rows) {
    return rows.map((s, i) => [
      `图${i + 1}`,
      s.idea ? `核心：${s.idea}` : "",
      s.visual ? `画面：${s.visual}` : "",
      s.line ? `文案：${s.line}` : ""
    ].filter(Boolean).join("｜")).join("\n");
  }
  return String(script || "");
}

function fallbackImageShot(i, total, { topic = "", product = null } = {}) {
  const productName = chineseProductDisplayName(product, "百度搭子");
  const rel = productsMentionedIn(topic, product, 3);
  const first = productDisplayName(rel[0], "知识库");
  const second = rel[1] ? productDisplayName(rel[1], "") : "";
  const relation = rel.length;
  const relationRows = [
    { idea: "先拆工具分工", visual: `三栏分工卡：${productName}写桌面执行，${first}写知识沉淀${second ? `，${second}写云端任务` : ""}，每栏只放一个图标和一句职责`, line: "先分清谁负责什么" },
    { idea: `${productName}负责执行`, visual: `电脑桌面上混乱文件夹被拖入${productName}任务框，右侧出现分类清单和结果卡`, line: `${productName}管桌面执行` },
    { idea: `${first}负责沉淀`, visual: `${first}知识库里出现双链节点、标签和知识卡片，箭头从${productName}结果卡连过去`, line: "知识再沉淀成网络" },
    { idea: "组合流程跑通", visual: `一条流程线串起输入资料、桌面执行、知识沉淀和复用结果，最后停在一张清爽复核清单`, line: "执行和沉淀分开做" },
    { idea: "适用边界提醒", visual: `两列边界卡：适合本地文件、合同、表格；不适合只记零碎待办，画面留白清楚`, line: "不是所有任务都要上" },
    { idea: "结果可复用", visual: `整齐文件夹、知识卡片和复盘清单并排出现，桌面从乱到清爽`, line: "结果回到你的流程" }
  ];
  const normalRows = [
    { idea: "真实问题开场", visual: `桌面文件、表格和消息提醒堆在一起，旁边出现${productName}输入框`, line: "重复整理太耗人" },
    { idea: "一句话说清任务", visual: `${productName}任务框里出现一条清晰指令，资料卡片被框选进任务区`, line: "先把目标说清楚" },
    { idea: "自动执行过程", visual: `文件卡片自动分类，字段被高亮提取，进度条稳步推进`, line: "让流程自己跑" },
    { idea: "结果可检查", visual: `结果区出现清单、表格和报告卡，右侧有待复核小勾选`, line: "结果能直接复核" },
    { idea: "复用小技巧", visual: `便签卡写着资料范围、输出格式、复核项三个关键词`, line: "下次只换资料" },
    { idea: "方法结论", visual: `整洁桌面和完成卡居中，文件夹按项目排好`, line: "把杂事变成流程" }
  ];
  const rows = relation ? relationRows : normalRows;
  return rows[Math.min(i, rows.length - 1)] || rows[rows.length - 1];
}

function normalizeScriptResult(d, { topic = "", image = false, imageCount = DEFAULT_XHS_IMAGE_COUNT, product = null } = {}) {
  const want = image ? Math.max(3, Math.min(12, Number(imageCount) || DEFAULT_XHS_IMAGE_COUNT)) : Math.max(1, (d.shots || []).length);
  const src = Array.isArray(d.shots) ? d.shots : [];
  const badLine = (text = "") => {
    const t = cleanText(text);
    return !t || /做成小红书|图文笔记|小红书笔记|本次创作|用户创作|被不同.*困住|半天搞不定|数字人开场|口播/.test(t) || (image && t.length > 38);
  };
  const badVisual = (text = "") => image && /数字人|真人|正面中近景|固定机位|口播|镜头|运镜/.test(cleanText(text));
  const shots = Array.from({ length: want }, (_, i) => {
    const fallback = fallbackImageShot(i, want, { topic, product });
    const raw = src[i] || {};
    let idea = sanitizeOwnProductForGeneratedText(stripCreativeInstructionText(raw.idea || ""));
    let visual = sanitizeOwnProductForGeneratedText(stripCreativeInstructionText(raw.visual || ""));
    let line = sanitizeOwnProductForGeneratedText(stripCreativeInstructionText(raw.line || ""));
    if (!idea || BAD_IMAGE_HEADLINE_RE.test(idea) || /做成|生成|用户/.test(idea)) idea = fallback.idea;
    if (!visual || badVisual(visual)) visual = fallback.visual;
    if (image && badLine(line)) line = fallback.line;
    return {
      ...raw,
      idea: image ? completeImageText(idea, 42) : cleanText(idea),
      visual: cleanText(visual),
      line: image ? completeImageText(line, 36) : stripCTA(sanitizeXhsText(cleanText(line))),
      ui: raw.ui !== false && /界面|logo|文字|屏幕|表格|数据|文档|报告|卡片|按钮|输入框|窗口/.test((visual || "") + (raw.ui === true ? "界面" : "")),
      scene: Number.isFinite(raw.scene) ? raw.scene : i + 1
    };
  });
  return { title: sanitizeOwnProductForGeneratedText(cleanScriptTitle(d.title || "", topic, product)), shots };
}

export const AI = {
  lastSource: "mock",
  lastError: "",

  _ok(d) { this.lastSource = "llm"; this.lastError = ""; return d; },
  _fb(e) { this.lastSource = "mock"; this.lastError = (e && e.message) || String(e || "网络/CORS"); },

  sourceNote(okMsg) {
    if (this.lastSource === "llm") return okMsg;
    const err = this.lastError || "网络/CORS";
    const apiLike = /未配置|api.?key|authorization|401|403|鉴权|认证|unauthorized|forbidden/i.test(err);
    return `${apiLike ? "语言模型接口未接通" : "模型生成未完成"}（${err}），已用本地模板`;
  },

  async trendGuide(opts = {}) {
    return resolveTrendGuide(opts);
  },
  async trendPrep(opts = {}) {
    return resolveTrendPrep(opts);
  },

  memoryLine(account) {
    const ctx = getCreativeMemoryContext({ account, platform: account?.platform });
    return ctx ? "\n\n" + ctx + "\n生成时优先吸收这些经过数据验证的规则，但不要生硬复述。" : "";
  },

  /* ---------- 素材号长视频脚本（60s+，有深度/有梗、利他，画外音后期配；每镜头标 ui/scene） ---------- */
  async generateMaterialScript({ topic, account, style = "", product = null }) {
    const sys = `你是百度 ACG 市场部资深长视频编剧，为指定产品写【素材号】视频脚本：没有固定出镜人物，画面全部由场景/产品界面/实拍素材混剪而成。line 是后期配音的画外音口播稿（画面本身无人声）。

【时长与篇幅】成片控制在 45-58 秒，绝不超过 60 秒，拆成 8-10 个镜头。每镜头口播只写 1 句，尽量 12-24 个中文字符；宁可少说一点、说清楚一点，确保每句话至少能自然讲 3 秒，不要把口播写得太赶。

【口播是灵魂，必须有内容、利他】
- 按账号创作风格和口播风格参考决定表达方式：偏知识/测评就讲出真东西——给具体数字、横向对比、反常识结论、可复用的方法；偏轻松就有梗有节奏（口语、自嘲、神转折），让人忍不住看完。
- 强利他：站在观众角度，告诉他"能省什么、怎么用、避什么坑"，让人觉得"看完有收获"。开头 3 秒就抛出钩子或痛点。
- 严禁任何"关注我/点赞收藏/求三连/记得关注/下期见/评论区告诉我"之类的引导式结尾。结尾用一句利他的总结或金句收束（例如把方法点题、留一个让人回味的观点）。

【画面 visual】非常具体：空间环境、产品界面里出现的具体文字与数据、界面动效、配色、光线。不要写运镜（运镜留给视频提示词阶段）。画面中不要安排任何叠加文字/字幕。${style ? `整体画面风格：${style}。` : ""}

【每镜头两个关键标记】
- ui：布尔。该镜头画面是否包含"产品界面 / 产品 logo / 需要清晰呈现的真实中文文字"。含这些→ui=true（后续需要分镜图参考再图生视频）；纯场景/空镜/氛围/手部特写等不含界面文字的→ui=false（后续直接文生视频，省去出图）。
- scene：整数场景编号。连续几个镜头若发生在同一场景、动作连贯，给同一个 scene 编号（后续会合成一条多镜头视频）；切换场景就换新编号。

只输出 JSON：{"title":"标题","shots":[{"idea":"核心思想","visual":"非常具体的画面","line":"画外音口播稿(可直接念，1句短句)","ui":true,"scene":1}]}，8-10 个镜头。`;
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + sys },
        { role: "user", content: `账号创作风格：${account.styleProfile || style || "真实经验分享"}\n账号口播风格参考：${account.voiceName || account.tone || "自然、可信、有教程感"}\n语气：${account.tone || "教程感"}\n平台：${account.platform}\n主题：${topic}\n先用当下热点/真实痛点切入并和主题焊在一起，再自然安利产品（不硬塞，全篇自然提到 1-2 次即可）。口播要有信息量、利他、理性可信，可以有梗但不油，结尾不要任何引导关注/下载的话。${topicalHook(product)}${this.memoryLine(account)}` }
      ], { json: true, temperature: 0.85 });
      const d = parseJSONLoose(content);
      if (!d.shots || d.shots.length < 8) throw new Error("模型未返回足够镜头");
      return this._ok({ title: cleanText(d.title) || topic, shots: d.shots.map((x, i) => ({
        idea: cleanText(x.idea), visual: cleanText(x.visual), line: stripCTA(sanitizeXhsText(cleanText(x.line))),
        ui: x.ui !== false && /界面|logo|文字|屏幕|表格|数据|文档|报告|卡片|按钮|输入框|窗口/.test((x.visual || "") + (x.ui === true ? "界面" : "")),
        scene: Number.isFinite(x.scene) ? x.scene : i + 1
      })) });
    } catch (e) {
      this._fb(e);
      return this._mockMaterialScript({ topic, account, product });
    }
  },

  /* ---------- 素材号：按「分镜单元」生成 图片提示词(先) + 视频提示词(后，呼应图片、多镜头) ----------
     units: [{ scene, needsImage, dur, shotIndexes }]；shots: 全量镜头 */
  async generateUnitPrompts({ units, shots, account, style = "", product = null, hasNarrationAudio = false, hasVoiceRef = false, hasCharacterRef = false, hasSceneRef = false }) {
    const NEG = videoNegative({ hasNarrationAudio });
    const unitText = units.map((u, i) => {
      const us = (u.shotIndexes || []).map(k => shots[k]).filter(Boolean);
      const dur = Math.min(15, Math.max(2, Math.ceil(u.dur || 10)));
      const rows = us.map((s, j) => {
        const visual = `  画面${j + 1}：${s.visual || s.idea || ""}`;
        return hasNarrationAudio ? visual : `${visual}\n  口播${j + 1}：${s.line || "无"}`;
      }).join("\n");
      return `单元${i + 1}（必须写成 ${dur} 秒，不得出现超过 ${dur}s 的时间码，${u.needsImage ? "【全能参考】出现角色/产品 logo/产品界面 → 统一参考固定图" : "【文生视频】纯场景，不出现 logo/界面"}，${us.length}个连贯镜头）：\n${rows}`;
    }).join("\n");
    const narrationRule = hasNarrationAudio
      ? "本任务已有外部口播音频。视频提示词只写纯画面，不要写口播原话，不要要求模型生成人声；后期会把口播音频混入。"
      : `本任务没有外部口播音频。视频提示词必须把口播原话拆短后放进对应时间段，作为视频内自然口播生成依据；按中文约4字/秒估算，每个时间段只放能在该段内读完的一小段口播，不得整句重复，不得把同一句塞进多个时间段。口播内容必须用中文引号“”包住，每个时间段最多承载1句。${hasVoiceRef ? "统一参考素材里有参考声线音频，提示词只写“口播音色与语气参考统一参考音频”，不要额外发明声音标签。" : "可写自然、清晰、可信的口播语气要求，但不要额外发明声音标签。"}`;
    const sys = `你为指定产品的视频按「分镜单元」生成视频提示词。每个单元 = 一条独立的 2-15 秒视频片段（同场景多个连贯镜头合成一条）。${narrationRule}

每个 videoPrompt 必须达到广告级完整分镜密度，写成这种"按时间分段的多镜头脚本"格式。即使只有 15 秒，也要像可直接交给视频模型的完整导演稿，不允许只写几句概括：

9:16竖屏，真实感办公效率产品广告风格，时长N秒，整体为「痛点情绪建立 → 指令触发 → 界面/文件自动推进 → 结果收束」的短视频。直接写最终画面生成指令，不要插入解释性段落，不要写“参考脚本如下”。

0-2s｜痛点开场｜中景 + 轻微推近 + 氛围建立
具体写空间、物件、光线、主体状态、画面为什么有痛点。

3-6s｜指令触发｜手部近景 + 屏幕特写 + 界面变化
具体写鼠标/键盘/拖拽/输入/点击动作，界面如何响应。

7-9s｜执行推进｜多窗口/文件/数据流转 + 克制动效
具体写文件、表格、网页、进度条、卡片如何移动和变化。

10-12s｜结果显现｜结果卡片/报告/归档完成 + 情绪转亮
具体写结果如何出现，光线和色彩如何从压迫转为清爽。

最后一段｜完成收束｜稳定特写/中景 + 完成感
最后一个时间段必须以本单元实际时长 N 秒结束，例如 11 秒单元只能写到 11s，不能写 13-15s。具体写最终画面停在哪里，保持真实可拍摄，不要下载按钮，不要多余收尾。

整体要求：
用一段话总结完整叙事逻辑、转场方式、画面风格、参考图使用方式、重点对象。13 秒以上至少 5 个时间段；10-12 秒至少 4 个时间段；不足 10 秒至少 3 个时间段。每个时间段至少 60 字，不能空泛。

负面约束：……（见下）

写作要求：
- 每个时间段都要具体到能照拍：空间环境、主体动作、镜头景别与运镜、界面/桌面元素如何出现与变化、光线与节奏。禁用"高级感/科技感/氛围感"等抽象词，把感觉翻译成具体光影与构图。
- 画面不要单调重复：不能每段都写电脑屏幕/文件夹/界面。素材号优先用手部动作、桌面物件、文件拟物化流转、数据卡片、空间光线变化、结果物料展示来丰富画面，不要反复安排无关出镜人。真人/数字人账号第一段要让固定博主正脸出镜并参考角色图，后续段落尽量不出现出镜人；若必须有人，只出现一次手部、背影、肩部或过肩轮廓，不写脸部特写。整体像一个完整小短篇，而不是连续录屏。
- 每句口播要有情绪色彩：焦虑、吐槽、松一口气、轻微惊喜、理性确认都要通过停顿、手部动作、镜头节奏和环境变化表达，避免机械 AI 播报感。
- 画面整体更明亮：白天自然光、浅色办公空间、蓝白界面色块、干净桌面，少用压抑暗色；痛点可以冷一点，但不要脏乱。
- 【全能参考】单元：画面会出现本次产品的产品界面与品牌视觉（系统会自动附上固定参考图作为参考），要写清界面/桌面如何出现与变化；但界面上的文字一律做模糊处理、不要求可读（品牌一致由参考图保证）。
- 【文生视频】单元：纯场景/空镜/实物/手部/环境，不出现 logo、不出现产品界面。
- 每个 videoPrompt 只输出最终视频生成指令，不要写“参考脚本如下 / 账号背景参考 / 主体设定 / 镜头依据”等解释给人的文字，不要额外发明声音标签。
- 真人/数字人账号若已有统一角色参考图，第一段固定博主可以正脸出镜并用参考图锁定同一张脸；非第一段不要写固定博主，不要写无关出镜人的脸部特写。
- 不要写“这句话自然说完、吐字清楚、不要压缩语速”这类空泛限制；真正控制每段口播字数，让时间结构本身能读完。
- 负面约束只能放在每个 videoPrompt 的最后一段，前面不要重复写。负面约束统一使用：「${NEG}」${style ? `\n- 整体画面风格基调：${style}。` : ""}

只输出 JSON：{"units":[{"videoPrompt":"镜头…完整分段提示词"}]}，顺序与单元一致，数量等于单元数。`;
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + sys },
        { role: "user", content: `账号创作风格：${account.styleProfile || style || "真实办公教程风"}\n共 ${units.length} 个单元：\n${unitText}` }
      ], { json: true, temperature: 0.75 });
      const d = parseJSONLoose(content);
      if (!d.units || !d.units.length) throw new Error("模型未返回 units");
      return this._ok({ units: units.map((u, i) => {
        const r = d.units[i] || {};
        const unitOpts = { account, hasNarrationAudio, hasVoiceRef, hasCharacterRef, hasSceneRef, needsCharacter: account?.subType === "数字人" && i === 0 };
        return { imagePrompt: "", videoPrompt: this._ensureRichVideoPrompt(cleanText((r.videoPrompt || "").trim()), u, shots, style, NEG, { ...unitOpts, product }) };
      }) });
    } catch (e) {
      this._fb(e);
      await delay(300);
      return { units: units.map((u, i) => ({ imagePrompt: "", videoPrompt: this._fbUnitVideo(u, shots, style, NEG, { account, product, hasNarrationAudio, hasVoiceRef, hasCharacterRef, hasSceneRef, needsCharacter: account?.subType === "数字人" && i === 0 }) })) };
    }
  },
  _fbUnitImage(u, shots, style, product = null) {
    const us = (u.shotIndexes || []).map(k => shots[k]).filter(Boolean);
    const productName = chineseProductDisplayName(product);
    const v = us.map(s => s.visual || s.idea || "").filter(Boolean)[0] || `${productName}产品界面与整洁桌面`;
    const lines = us.map((s, i) => `画面依据${i + 1}：${s.visual || s.idea || ""}`).join("；");
    return cleanText(`9:16竖版分镜首帧定帧，真实办公产品广告质感，${style || "白底极简、科技蓝紫渐变(#3f6bff→#9a45ff)、圆角卡片UI、大留白、干净现代办公感"}。画面结构为桌面/电脑屏幕/人物手部或办公环境的稳定中近景，主体关系清晰：屏幕占画面主要视觉中心，前景可见键盘、鼠标、咖啡杯或文件夹等真实办公物件，背景保持浅景深虚化。光线为正面偏侧的明亮柔光，冷暖适中，屏幕区域清晰但不刺眼，桌面材质干净。核心画面：${v}。${lines}。${productName}产品界面必须清晰呈现，界面只保留少量大字号中文，例如「整理资料」「生成页面」「数据分析」「生成报告」等可读模块。画面不要字幕、不要花字、不要二维码、不要乱码、不要密集小字、不要多余下载按钮。`);
  },
  _fbUnitVideo(u, shots, style, NEG, opts = {}) {
    const us = (u.shotIndexes || []).map(k => shots[k]).filter(Boolean);
    const account = opts.account || {};
    const productName = chineseProductDisplayName(opts.product);
    const hasNarrationAudio = !!opts.hasNarrationAudio;
    const hasVoiceRef = !!opts.hasVoiceRef;
    const hasCharacterRef = !!opts.hasCharacterRef;
    const dur = Math.min(15, Math.ceil(u.dur || 4));
    const split = timeBlocksForDuration(dur);
    const title = us[0]?.idea || (u.needsImage ? `${productName}自动执行任务` : "办公效率痛点转折");
    const firstVisual = us.map(s => s.visual || s.idea || "").filter(Boolean)[0] || `真实电脑桌面、浏览器窗口、文件夹和${productName}工作台界面`;
    const setupLine = u.needsImage
      ? "画面围绕真实电脑桌面、产品工作台界面、文件夹/表格/报告卡片、鼠标轨迹和少量手部操作展开；界面参考固定产品界面图保持品牌色和布局一致，不主动添加额外 logo。"
      : "画面围绕真实办公桌面、电脑屏幕、手部操作、浏览器窗口、文件夹、便签与少量办公物件展开；不出现产品 logo 和清晰产品界面。";
    const needsCharacter = !!opts.needsCharacter;
    const hasSceneRef = !!opts.hasSceneRef;
    const identityAnchor = needsCharacter && !hasCharacterRef ? this._humanAppearanceAnchor(account) : "";
    const characterRefLine = needsCharacter && hasCharacterRef
      ? "统一参考素材中包含角色参考图；所有出现人物的镜头都严格以参考图保持同一角色、同一服装、同一发型、同一体态和同一表情习惯，不要重新设计角色。"
      : "";
    const sceneLine = sceneAnchorLine(account, hasSceneRef, needsCharacter);
    const voiceAnchor = !hasNarrationAudio
      ? (hasVoiceRef
        ? "口播音色与语气参考统一参考音频；普通话清晰自然，像真实经验分享，不机械播报，不夸张带货。"
        : `${account.voiceName ? `使用账号固定声线「${account.voiceName}」，普通话清晰，语气自然可信，有信息量但不硬广。` : "普通话清晰，语气自然可信，有解释感，像真实使用经验分享，不机械播报，不夸张带货。"} `)
      : "";
    const peopleRule = needsCharacter
      ? "本单元是固定博主/数字人的主出镜片段；博主正脸看向镜头开口，严格参考角色图或外貌锚点保持同一张脸、同一服装、同一发型，表演自然，不夸张。画面只保留固定博主一人。"
      : "本单元以任务、文件、数据、物件和光线变化为主；如果需要人来承接动作，只使用一次手部、背影、肩部或过肩轮廓，不写脸部特写。";
    const narrationParts = hasNarrationAudio ? [] : distributeNarration(us, split);
    const segs = split.map(([a, b], i) => {
      const beat = unitBeat({ ...opts, needsCharacter }, i);
      const visual = enrichVisualBrief(visualForBlock(us, i, split.length, firstVisual), beat, i, split.length, u);
      const narration = !hasNarrationAudio ? (narrationParts[i] || "") : "";
      const refLine = u.needsImage
        ? "产品界面由参考图锁定一致性，画面里只保留模块色块、窗口轮廓、鼠标轨迹和动效节奏；不要在屏幕任何位置新增 logo，所有具体文字都做模糊处理，避免乱码和可读小字。"
        : "这是纯场景文生视频，不出现产品 logo、不出现清晰产品界面，重点放在办公桌面、手部动作、屏幕光、文件流转和情绪变化。";
      const transitionLine = needsCharacter
        ? "可以用手部经过镜头、窗光变化、文件卡片滑入、角色视线转移或桌面物件遮挡完成衔接"
        : "可以用手部经过镜头、窗光变化、文件卡片滑入、屏幕反光、鼠标轨迹或桌面物件遮挡完成衔接";
      return `${a}-${b}s｜${beat.phase}｜${beat.move}\n${narration ? `口播原话：“${narration}”。` : ""}画面内容：${visual} 镜头语言：${beat.move}，动作要连续可拍，转场自然，${transitionLine}，不用夸张特效。光线与色彩：${i === 0 ? "明亮冷白屏幕光叠加自然窗光，轻微突出焦虑但不要压暗" : i === split.length - 1 ? "窗光和柔和顶光变亮，画面通透，收束到清爽完成感" : "日间办公室光线稳定，蓝白界面色块和浅灰桌面带来秩序感"}。${refLine}`;
    });
    return compactVideoPrompt(`9:16竖屏，真实感办公效率产品广告风格，时长${dur}秒，整体为「真实痛点被看见——一句指令触发自动执行——文件/数据/任务可视化推进——结果完成带来清爽松弛」的情绪转折短视频。画面节奏由慢到快，再收束到稳定满足；镜头语言干净利落，真实可拍。${setupLine}本单元主题为「${title}」。${style ? `整体视觉风格：${style}。` : "整体视觉保持明亮办公广告风格，白色/浅灰环境，白天自然光，屏幕蓝白色块，少量蓝紫品牌色点缀。"}${characterRefLine ? `\n${characterRefLine}` : ""}${identityAnchor ? `\n${identityAnchor}` : ""}${sceneLine ? `\n${sceneLine}` : ""}${voiceAnchor ? `\n${voiceAnchor}` : ""}\n${peopleRule}\n\n${segs.join("\n\n")}\n\n整体要求：用手部细节、桌面物件、数据卡片、文件拟物化流转、空间光线和结果展示，让画面像一个流畅的小短篇；转场用手部经过、窗光变化、文件卡片滑入、屏幕反光、物件遮挡或鼠标移动自然完成。画面真实、明亮、干净、可信；办公环境不要杂乱，界面不要密集小字，文字位置全部模糊处理。\n${NEG}`);
  },
  _ensureRichImagePrompt(prompt, u, shots, style) {
    if (prompt && prompt.length >= 160 && /光|构图|界面|负面|不要/.test(prompt)) return prompt;
    return this._fbUnitImage(u, shots, style);
  },
  _ensureRichVideoPrompt(prompt, u, shots, style, NEG, opts = {}) {
    const hasSegments = (prompt.match(/\d+\s*[-–]\s*\d+\s*s/gi) || []).length >= 2;
    const dur = Math.min(15, Math.ceil(u.dur || 4));
    const segmentNeed = dur >= 13 ? 5 : dur >= 10 ? 4 : dur >= 6 ? 3 : 2;
    const ranges = prompt.match(/\d+\s*[-–]\s*\d+(?:\.\d+)?\s*s/gi) || [];
    const segmentCount = ranges.length;
    const hasZeroRange = ranges.some(x => {
      const mm = x.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
      return mm ? Number(mm[2]) <= Number(mm[1]) : false;
    });
    const maxEnd = ranges.reduce((m, x) => {
      const mm = x.match(/[-–]\s*(\d+(?:\.\d+)?)/);
      return Math.max(m, mm ? Number(mm[1]) : 0);
    }, 0);
    const wrongDuration = maxEnd > dur + 0.2 || (dur < 13 && /(13\s*[-–]\s*15\s*s|时长\s*15\s*秒)/.test(prompt));
    const hasHardNeg = /无字幕|不生成字幕|不要字幕/.test(prompt) && /无\s*BGM|不要\s*BGM|不出现\s*BGM/.test(prompt) && (opts.hasNarrationAudio ? /无口播|不要口播|无人声/.test(prompt) : true);
    const hasMetaText = /主体设定|角色设定|参考脚本|旁白含义|镜头依据|账号定位参考|账号背景参考|声线锚点|<[^>]+>/.test(prompt);
    const duplicateNeg = ((prompt.match(/负面约束/g) || []).length > 1) || (/无口播|无人声/.test(prompt.slice(0, 220)) && /负面约束/.test(prompt));
    const wrongNarrationNeg = !opts.hasNarrationAudio && /无口播|不要口播|无人声/.test(prompt);
    const missingNarration = !opts.hasNarrationAudio && !/口播(?:原话)?[:：]/.test(prompt);
    const narrationConflict = opts.hasNarrationAudio && /口播(?:原话)?[:：]|画外音|旁白|人声|声音参考|声线/.test(prompt);
    const repeatedVoice = hasRepeatedNarration(prompt);
    const appearanceWithRef = opts.hasCharacterRef && /博主（|男，\d+岁|女，\d+岁|戴眼镜|穿.*衬衫|鹅蛋脸|杏眼|鼻梁|嘴唇|发型|外貌|五官/.test(prompt);
    const peopleOverflow = !opts.needsCharacter && /路人|陌生人正脸|人物正脸|博主正脸|博主看向镜头|面部特写|表情特写/.test(prompt);
    const denseVoice = !opts.hasNarrationAudio && ranges.some(x => {
      const mm = x.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
      if (!mm) return false;
      const seg = prompt.slice(Math.max(0, prompt.indexOf(x)), prompt.indexOf(x) + 220);
      const span = Number(mm[2]) - Number(mm[1]);
      const voice = (seg.match(/口播(?:原话)?[:：]\s*“?([^”\n。！？!?]+)/) || [])[1] || "";
      return (span < 3 && /口播原话|口播[:：]/.test(seg)) || voice.replace(/\s/g, "").length > Math.max(12, Math.floor(span * 5));
    });
    const minLen = dur >= 10 ? 700 : 420;
    if (prompt && prompt.length >= minLen && prompt.length <= 2000 && hasSegments && segmentCount >= segmentNeed && hasHardNeg && !hasMetaText && !wrongDuration && !hasZeroRange && !duplicateNeg && !wrongNarrationNeg && !missingNarration && !narrationConflict && !denseVoice && !repeatedVoice && !appearanceWithRef && !peopleOverflow) return compactVideoPrompt(prompt);
    return compactVideoPrompt(this._fbUnitVideo(u, shots, style, NEG, opts));
  },

  /* ---------- 素材号：逐镜头视频提示词（旧版，保留兼容） ---------- */
  async generateShotVideoPrompts({ shots, perShot = [], account, style = "", product = null }) {
    const { MATERIAL_VIDEO_NEG } = await import("./prompts.js");
    const productName = chineseProductDisplayName(product);
    const fallback = (s, i) => cleanText(`这是一条${productName}产品视频的单镜头素材，9:16 竖屏，时长${Math.ceil(perShot[i]?.dur || 4)}秒，场景/产品界面混剪，纯画面无人声。画面内容：${s.visual || s.idea || "产品界面演示"}。镜头语言：${i % 2 ? "缓推" : "横移"}运镜、干净画面结构、明亮柔光${style ? `；整体风格：${style}` : ""}。${MATERIAL_VIDEO_NEG}`);
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + `\n\n你为素材混剪视频逐镜头生成视频提示词：每个镜头一条独立提示词，对应生成一段独立的视频素材片段。每条开头写明"9:16竖屏，时长N秒，场景/产品界面混剪，纯画面无人声"。画面具体到景别/机位运镜/界面文字/动效/光线，禁止抽象词。每条结尾都必须带上这段负面提示词："${MATERIAL_VIDEO_NEG}"。只输出 JSON：{"shots":[{"prompt":"..."}]}，数量与镜头数一致。` },
        { role: "user", content: `账号创作风格：${account.styleProfile || style || "真实办公教程风"}\n${style ? `画面风格：${style}\n` : ""}共 ${shots.length} 个镜头（含各自时长）：\n${shots.map((s, i) => `${i + 1}. [${Math.ceil(perShot[i]?.dur || 4)}秒] ${s.visual || ""}`).join("\n")}` }
      ], { json: true, temperature: 0.6 });
      const d = parseJSONLoose(content);
      if (!d.shots || !d.shots.length) throw new Error("模型未返回 shots");
      return this._ok({ shots: shots.map((s, i) => ({ prompt: cleanText((d.shots[i]?.prompt || "").trim()) || fallback(s, i) })) });
    } catch (e) {
      this._fb(e);
      await delay(300);
      return { shots: shots.map((s, i) => ({ prompt: fallback(s, i) })) };
    }
  },

  /* ---------- 灵感建议：按账号矩阵随机生成量产指令（LLM 优先，离线真随机兜底） ---------- */
  async suggestGoals({ accounts = [], products = null }) {
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const productList = products && products.length ? products : allProductsForAI();
    const ours = productList.filter(p => p.owner === "ours");
    const comps = productList.filter(p => p.owner === "competitor").slice(0, 8);
    const offline = () => {
      const tags = [...new Set(accounts.flatMap(a => a.qtags || []))];
      const t1 = pick(TOPIC_POOL), t2 = pick(TOPIC_POOL.filter(x => x !== t1)), t3 = pick(TOPIC_POOL);
      const own = pick(ours.length ? ours : productList) || { shortName: "本次产品" };
      const comp = pick(comps.length ? comps : productList.filter(p => p.id !== own.id)) || { shortName: "同类工具" };
      const ownName = productDisplayName(own);
      const compName = productDisplayName(comp, "同类工具");
      return [
        `给${tags.length ? "所有" + pick(tags) + "标签的" : "全部"}账号做「${ownName} ${t1}」`,
        `给图文组做${ownName}和${compName}对比`,
        `给素材号全自动出一批「${t3}」AI博主视角`
      ];
    };
    try {
      const content = await llm([
        { role: "system", content: `根据账号矩阵和产品知识库，给内容量产 Agent 生成 3 条一句话指令建议。要求像真实 AI 博主选题：可以做教程、对比、测评、工具分工或场景清单；优先使用我们的产品，也可以引入竞品/同类产品做横向对比；主题每次新颖不重复；指明范围（全部 / 某标签 / 图文组 / 真人 / 素材号）；每条不超过 32 字；只输出 JSON：{"suggestions":["...","...","..."]}` },
        { role: "user", content: `账号矩阵：${JSON.stringify(accounts.map(a => ({ 名称: a.name, 分组: a.mode === "图文" ? "图文组" : a.subType === "数字人" ? "真人" : "素材", 风格: (a.styleProfile || a.voiceName || a.lockedStyle || "").slice(0, 50), 标签: a.qtags || [] })))}\n产品知识库：${JSON.stringify(productList.map(p => ({ 名称: p.name, 身份: p.owner === "ours" ? "我们的产品" : "竞品", 类别: p.category, 选题角度: (p.blogAngles || p.tutorialAngles || []).slice(0, 3), 可对比: (p.comparisonAngles || []).slice(0, 2) })))}\n随机种子：${Math.random().toString(36).slice(2, 8)}` }
      ], { json: true, temperature: 1.2 });
      const d = parseJSONLoose(content);
      if (Array.isArray(d.suggestions) && d.suggestions.length >= 3) return this._ok(d.suggestions.slice(0, 3).map(s => String(s).slice(0, 40)));
      throw new Error("空");
    } catch (e) {
      this._fb(e);
      return offline();
    }
  },

  /* ---------- 创作内容补全：空内容时先生成 brief，再拆图/脚本 ---------- */
  async generateCreativeBrief({ account, product = null, imageCount = DEFAULT_XHS_IMAGE_COUNT, userText = "", kind = "image", useOnlineTrends = false, trendGuide = "", trendPrep = null }) {
    const p = product || allProductsForAI().find(x => x.owner === "ours") || null;
    const rel = relatedProducts(p, allProductsForAI(), 5);
    const productName = chineseProductDisplayName(p);
    const count = Math.max(3, Math.min(12, Number(imageCount) || DEFAULT_XHS_IMAGE_COUNT));
    const emptyRunSeed = `${account?.id || account?.name || "account"}:${p?.id || "product"}:${kind}:${count}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const fixedEmptyTopic = pickDefaultCreativeTopic({
      seed: emptyRunSeed
    });
    const fallback = () => {
      if (!userText) return fixedEmptyTopic;
      const first = chineseProductDisplayName(rel[0], "同类工具");
      const second = rel[1] ? chineseProductDisplayName(rel[1], "") : "";
      if (p?.id === "miaoda") {
        return `${productName}做无代码应用原型：从一个真实小需求切入，先讲非技术人为什么不想从零写代码，再对比 ${first}${second ? ` / ${second}` : ""} 这类工具的适用边界，重点展示用${productName}把需求拆成页面、数据表、后台和发布流程，最后总结适合快速验证想法的小技巧，拆成 ${count} 张图卡讲清楚。`;
      }
      return `${productName}和${first}组合做办公知识流：先讲资料分散、知识沉淀和桌面执行割裂的麻烦，再说明${first}更适合沉淀资料/结构化知识，${productName}更适合读取本地文件、整理资料、提取字段和生成可复用结果；中间用一个真实文件夹或项目资料场景演示分工，最后给出适合打工人复用的执行流程，拆成 ${count} 张图卡讲清楚。`;
    };
    if (!String(userText || "").trim()) return this._ok(fixedEmptyTopic);
    try {
      const prep = trendPrep || await resolveTrendPrep({ topic: userText, account, product: p, useOnlineTrends, kind, imageCount: count });
      const trendGuideText = prep?.guide || trendGuide || await resolveTrendGuide({ topic: userText, account, product: p, useOnlineTrends, kind, imageCount: count });
      const content = await llm([
        { role: "system", content: baseProductFacts(p) + productBrief(p) + `\n\n你是 AI 博主选题策划，负责在生成图卡结构/口播脚本前，先把用户的创作需求补全成一段可执行的「创作内容 brief」。只输出 JSON：{"brief":"..."}。` },
        { role: "user", content: `${currentProductLine(p)}
账号：${account?.name || "未命名账号"}
${kind === "video" ? `账号创作风格：${account?.styleProfile || account?.voiceName || "真实经验分享"}` : `账号创作风格：${account?.styleProfile || "干净可读、真实经验分享"}`}
内容形态：${kind === "video" ? "视频口播脚本" : `小红书图文，计划 ${count} 张图卡`}
用户已写创作方向：${userText ? userText : "未填写"}
可参考/可组合的同类工具：
${productRelationLine(rel)}
小红书热门结构参考（只学选题钩子、标题结构、图卡节奏，不要照抄样本，不要把样本标题写入成品）：
${trendGuideText}
${prep?.referenceNote ? `\n联网/本地参考说明：${prep.referenceNote}` : ""}
${prep?.imageStrategy ? `\n图片策略预案：${prep.imageStrategy}` : ""}

写作规则：
1. 如果用户已写创作方向，必须优先服从用户方向，不要改成另一个主题。
2. 如果用户未填写方向，请主动带 1-2 个同类或互补工具，做对比、组合、分工或妙用科普，让内容像 AI 博主经验，不像孤立宣传。
3. 如果用户方向里提到竞品/同类产品，要识别它们的功能点，再解释它们和当前主产品如何分工、对比或组合；不能把竞品能力写成当前主产品能力。
4. brief 要具体到能直接拆图/拆脚本：真实痛点、主产品做什么、参考工具做什么、前后变化、适合人群、可复制小技巧。
5. 80-150 字，中文，不要编号，不要空泛营销词，不要强 CTA。` }
      ], { json: true, temperature: userText ? 0.65 : 0.95 });
      const d = parseJSONLoose(content);
      const brief = trimCreativeBrief(d.brief || "");
      if (brief && brief.length >= 30) return this._ok(brief);
      throw new Error("模型未返回有效 brief");
    } catch (e) {
      this._fb(e);
      return fallback();
    }
  },

  /* ---------- 脚本生成 ---------- */
  async generateScript({ topic, duration = 30, account, image, direction = "", style = "", imageCount = DEFAULT_XHS_IMAGE_COUNT, product = null, imageTemplate = "", styleRefName = "", batchVariant = null, useOnlineTrends = false, trendGuide = "", trendPrep = null }) {
    const hasImageTemplate = image && String(imageTemplate || "").trim();
    const mentionedTools = productsMentionedIn(`${topic}\n${direction}`, product, 4);
    const mentionedGuide = productRelationLine(mentionedTools);
    const dirText = image
      ? (direction ? `本次创作内容：${direction}。` : `本次创作内容：围绕主题自由发挥，每张图承担清晰信息点。`)
      : (direction ? `目标人群方向：${direction}（脚本语气、痛点、例子都贴合这个人群）。` : `人群方向：不限，自由发挥最合适的角度。`);
    const nImg = Math.max(3, Math.min(12, imageCount || DEFAULT_XHS_IMAGE_COUNT));
    const variantGuide = batchVariantLine(batchVariant);
    const onlineForScript = image && useOnlineTrends;
    const prep = trendPrep || await resolveTrendPrep({ topic: `${topic}\n${direction}`, account, product, batchVariant, useOnlineTrends: onlineForScript, kind: image ? "image" : "video", imageCount: nImg });
    const trendGuideText = prep?.guide || trendGuide || await resolveTrendGuide({ topic: `${topic}\n${direction}`, account, product, batchVariant, useOnlineTrends: onlineForScript, kind: image ? "image" : "video", imageCount: nImg });
    const prepLine = prep ? `结构化选题预案：\n选题来源：${prep.source === "online" ? "联网趋势改写" : "本地投放方向"}（仅内部参考）\n预制创作内容：${prep.creativeContent || ""}\n图片/内容策略：${prep.imageStrategy || ""}\n预制标题方向：${prep.title || ""}\n预制文案骨架：${String(prep.copy || "").split(/\n/).slice(0, 8).join(" / ")}\n` : "";
    const sys = image
      ? `你是小红书图文笔记策划，为百度 ACG 市场部写「小红书笔记图卡内容表」，每行是笔记里的一张配图。严格围绕用户本次创作内容展开；账号只提供创作风格，不提供内容方向。
先把用户创作内容整理成 ${nImg} 个信息节拍，每张图承担一个清楚的信息任务：观点、动作、证据、结果或边界。长内容要总结、取舍、分布，不要把所有信息塞进每一张图；短内容要补真实使用场景、结果证据或边界提醒。信息密度由内容判断：封面更轻，内页可以适当承载具体信息；模拟文档、表格、报告页时可以更细，但必须分层清楚、文字可读、重点明确。标题和图上文案要像真实笔记，具体、有信息量、能让人看懂功能和结果。图文没有口播，只有画面与图上文案。每行 idea 写清这张图唯一要传达的信息；visual 必须非常具体（画面布局/主视觉/界面里出现的具体文字/配色/光线/产品视觉位置），先在脑内把这张图具象化成真实画面再写，不要用电影感、高级感、种草感这类抽象词。内部结构词不要出现在 idea、visual、line 里。
第一张图默认是点击入口，不是教程信息页：优先强标题、简单主视觉和清晰关系。除非用户明确要求首图高信息量，否则第一张不要变成流程、长清单、复杂表格、多截图或密集小字。若主题是 Obsidian、Codex、WorkBuddy 等工具和主产品对比/组合，第一张优先用两个工具标识或简化图标 + 大字标题 + 箭头/VS 关系来表达。
第二张开始再讲真实场景、执行动作、工具分工、结果证据和结论。图片数量少时要主动压缩信息，把次要内容变成一句结论；图片数量多但用户只给少量方向时，要补真实使用场景、例子和边界提醒。
同一批量任务里每个账号都要像不同博主写同一方向：可以共享大主题，但必须更换切入角度、例子、标题表达、图卡顺序和结尾结论；不要输出多条相同或近似的图卡脚本。
如果账号风格是火柴人、简笔画、小人、漫画或手绘，line 更偏短句，visual 重点写人物动作、表情、气泡、箭头和小物件，减少界面文字和表格密度。
若本次创作内容提到竞品/同类工具，要先识别其在产品库中的功能点，再安排成对比表、分工流程、组合用法或边界提醒；本次主产品仍是主角，不能把竞品能力写成主产品能力。测评或对比类内容只写适合谁、任务边界、真实证据和组合方式，不写分数、星级、排行榜或评分卡。
小红书趋势参考只用于你内部决定标题钩子、文案骨架和图卡节奏，禁止照抄样本标题，也不要把“热门参考/趋势参考/样本标题”等词写进 shots。${hasImageTemplate ? `账号配置了固定图文模板，必须优先遵守模板的风格、画面语言、参考图使用方式和统一要求；但模板中的张数、主题、产品名、各图内容都要按本次创作内容重写，最终 shots 必须正好 ${nImg} 行。` : ""}只输出 JSON：{"title":"小红书笔记风标题","shots":[{"idea":"核心思想","visual":"非常具体的画面","line":"图上文案(小红书笔记口吻、精简)"}]}，shots 必须正好 ${nImg} 行。`
      : (account.subType === "无数字人"
        ? `你是百度 ACG 市场部资深短视频编剧，写指定产品教程【无数字人】视频：没有固定出镜人物，以场景/产品界面/手部操作混剪为主，line 写专业画外音旁白。成片控制在45-58秒，绝不超过60秒，拆成8-10个镜头；每镜头口播1句，尽量12-24个中文字符，单句至少能自然说3秒，不要赶。偏教程专业可信、理性有梗、不要信息流硬广。visual 非常具体：景别、机位运镜(固定/缓推/横移/跟随)、产品界面模块、界面动效(卡片滑入/进度条/局部高亮)、配色、光线，禁止电影感/高级感/种草感等抽象词。visual 里不要安排叠加字幕/标题文字。每镜头带 ui(true/false) 和 scene(连续场景编号)。只输出 JSON：{"title":"标题","shots":[{"time":"0-4s","idea":"核心思想","visual":"非常具体的画面分镜","line":"专业画外音旁白","ui":true,"scene":1}]}。`
        : `你是百度 ACG 市场部资深短视频编剧，写指定产品教程【真人/数字人口播】视频。成片控制在50-65秒，拆成12-16个可切分口播镜头；每镜头口播1句，尽量14-30个中文字符，像真人一口气讲经验，不要赶。口播风格参考：先从真实误解或门槛担心切入，例如以为AI工具很复杂；随后给轻微惊讶/松一口气的反差；中段用1-2个具体办公或作品集案例讲清“直接说人话、工具拆解任务、一步步执行、还能整理文件/总结资料/分析表格/捋需求”；结尾落在“不是让我变程序员，而是把脑子里的想法或手里的乱东西推进到可看可用的版本”。不要逐字照抄任何参考话术。可以有情绪起伏、口语停顿和朋友式解释感，但不要输出 {happy}、{/happy}、(clear-throat) 这类情绪/音效标签，也不要输出括号舞台指令。结构上有真人开场、有产品场景演示、有真人收束，但不要死板两段式。内容丰富、偏教程专业可信、理性有梗、不要信息流硬广：口播像真实经验分享，能直接念。visual 非常具体：人物动作表情、产品界面模块、运镜、界面动效、配色、光线；如果后续有统一参考图，人物外貌由参考图锁定，这里不要写五官长相。禁止电影感/高级感/种草感等抽象词。visual 里不要安排叠加字幕/标题文字。每镜头带 ui(true/false) 和 scene(连续场景编号)。只输出 JSON：{"title":"标题","shots":[{"time":"0-4s","idea":"核心思想","visual":"非常具体的画面分镜","line":"口播原话","ui":true,"scene":1}]}。`);
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + sys },
        { role: "user", content: image
          ? `账号创作风格：${style || account.styleProfile || "干净可读的小红书图文风"}\n语气：${account.tone || "教程感"}\n平台：${account.platform}\n内容模式：${account.mode}\n${dirText}\n${variantGuide ? `\n${variantGuide}\n` : ""}共生成 ${nImg} 张图。\n${style ? `图文总风格：${style}（所有画面统一这个视觉风格）。\n` : ""}${styleRefName ? `成图风格参考：${styleRefName}。\n` : ""}${hasImageTemplate ? `账号图文模板（只作为风格/结构母版，不要照抄示例变量）：\n${imageTemplate}\n` : ""}${prepLine}${mentionedGuide ? `本次创作内容里明确提到的同类/互补工具能力：\n${mentionedGuide}\n请把这些工具具体安排成组合流程、功能边界或对比卡，不要只挂名字。\n` : ""}小红书趋势参考（只学结构、节奏和选题钩子，不要照抄，不要写进图上文字）：\n${trendGuideText}\n主题：${topic}\n围绕本次宣传产品的真实功能延展教学，优先服从用户本次创作内容，不要强呼吁下载。${topicalHook(product)}`
          : `账号创作风格：${account.styleProfile || style || "真实经验分享"}\n账号口播风格参考：${account.voiceName || account.styleProfile || style || account.tone || "自然、可信、有教程感"}\n语气：${account.tone || "教程感"}\n平台：${account.platform}\n内容模式：${account.mode}\n${dirText}\n${prepLine}视频号脚本不使用联网热门参考；只参考账号创作风格、账号口播风格、本次选题、产品真实功能和本地内容结构。\n本地结构参考（只学节奏，不要照抄）：\n${trendGuideText}\n主题：${topic}\n目标时长：${Math.min(60, duration || 55)}秒以内，最终不超过60秒。口播宁可少一点，保证每句都能自然读完。围绕本次宣传产品的真实功能延展教学，但要先用真实痛点切入、自然安利，不要孤立自嗨，不要强呼吁下载。${topicalHook(product)}${this.memoryLine(account)}` }
      ], { json: true });
      const d = parseJSONLoose(content);
      if (!d.shots || !d.shots.length) throw new Error("模型未返回 shots");
      const normalized = normalizeScriptResult(d, { topic, image, imageCount: nImg, product });
      return this._ok(normalized);
    } catch (e) {
      this._fb(e);
      return this._mockScript({ topic, account, image, imageCount: nImg, product });
    }
  },

  /* ---------- 脚本优化 ---------- */
  async optimizeScript({ shots, direction, account, image }) {
    try {
      const content = await llm([
        { role: "system", content: `你在优化一张${image ? "图文" : "视频"}分镜脚本表。保持原有列结构${image ? "（idea/visual/line，无口播）" : "（time/idea/visual/line）"}，按用户的优化方向重写，使脚本更好。只输出 JSON：{"title":"可选新标题","shots":[...]}，shots 字段与输入一致。` },
        { role: "user", content: `${image ? `账号创作风格：${account.styleProfile || ""}` : `账号创作风格：${account.styleProfile || account.voiceName || account.tone || "真实经验分享"}`}\n优化方向：${direction}\n当前脚本（JSON）：\n${JSON.stringify(shots)}` }
      ], { json: true, temperature: 0.7 });
      const d = parseJSONLoose(content);
      if (!d.shots || !d.shots.length) throw new Error("模型未返回 shots");
      return this._ok({ title: d.title, shots: d.shots });
    } catch (e) {
      this._fb(e);
      await delay(400);
      return { shots: shots.map(s => ({ ...s, idea: (s.idea || "") + `（按"${direction}"优化）` })) };
    }
  },

  /* ---------- 视频提示词（两段式） ---------- */
  _sceneGroups(shots, duration = 30) {
    const scenes = Math.max(1, Math.round((duration || 30) / 30));
    const per = Math.max(1, Math.ceil(shots.length / scenes));
    const groups = [];
    for (let i = 0; i < scenes; i++) {
      const slice = shots.slice(i * per, (i + 1) * per);
      const half = Math.ceil(slice.length / 2) || 1;
      groups.push({ all: slice, front: slice.slice(0, half), back: slice.slice(half) });
    }
    return groups;
  },

  async generatePrompts({ shots, duration = 30, account, product = null }) {
    const groups = this._sceneGroups(shots || [], duration);
    const scenesText = groups.map((g, i) =>
      `【场景${i + 1}】\n  第一段(0-15秒)对应脚本镜头：\n${(g.front.length ? g.front : g.all).map((x, j) => `   镜头${j + 1} 画面：${x.visual || ""}｜口播：${x.line || ""}`).join("\n") || "   （无）"}\n  第二段(0-15秒)对应脚本镜头：\n${(g.back.length ? g.back : g.all).map((x, j) => `   镜头${j + 1} 画面：${x.visual || ""}｜口播：${x.line || ""}`).join("\n") || "   （无）"}`
    ).join("\n\n");
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + (account.subType === "无数字人" ? NO_DH_FRAMEWORK : PROMPT_FRAMEWORK) },
        { role: "user", content: `账号创作风格：${account.styleProfile || account.voiceName || "真实经验分享"}\n语气：${account.tone || "教程感"}\n平台：${account.platform}\n\n以下是已确定的分镜脚本，严格据此改写（每段都是独立的0-15秒视频，不要写衔接性措辞）：\n${scenesText}\n\n请为每个场景输出 segA(第一段0-15秒) 与 segB(第二段0-15秒) 完整提示词。` }
      ], { json: true, temperature: 0.6 });
      const d = parseJSONLoose(content);
      const prompts = (d.scenes || []).map((x, i) => ({
        name: cleanText(x.title) || `场景 ${String(i + 1).padStart(2, "0")}`,
        time: "0-15s",
        front: this._ensureRenderPrompt(cleanText(x.segA || x.front), account),
        back: this._ensureRenderPrompt(cleanText(x.segB || x.back), account), ui: x.ui !== false
      }));
      if (!prompts.length) throw new Error("模型未返回 scenes");
      return this._ok({ prompts });
    } catch (e) {
      this._fb(e);
      return this._mockPrompts({ groups, account, product });
    }
  },

  /* ---------- 分镜图提示词 ---------- */
  fallbackStoryboardPrompt(shot, account, style, sharedRefName, product = null) {
    const styleTxt = style || "白底极简、蓝紫渐变品牌色(#3f6bff 到 #9a45ff)、圆角卡片 UI、大留白、干净办公感";
    const refTxt = sharedRefName ? `统一参考「${sharedRefName}」保持品牌/角色一致；` : "";
    const v = (shot.visual || "数字人坐在办公桌前").trim();
    const productName = chineseProductDisplayName(product);
    return cleanText(`9:16 竖图，${styleTxt}。画面内容：${v}。镜头：中近景、固定机位、人物三分位画面结构；光线：正面偏侧暖色柔光；界面元素：${productName}产品界面，界面文字精简、大字号、清晰可读；主体动作与表情：自然放松、看向镜头或界面；背景：简洁办公桌面、浅景深虚化。${refTxt}无字幕、不叠加标题花字，不要二维码、不要乱码、不要密集小字、不要 emoji。`);
  },

  async generateStoryboardPrompts({ shots, account, style, sharedRefName, product = null }) {
    const refLine = sharedRefName ? `所有分镜图统一参考「${sharedRefName}」，保持品牌/角色一致。` : "";
    const productName = chineseProductDisplayName(product);
    const sys = `你是${productName}视频分镜图设计师。脚本每个镜头对应生成一张静态分镜图(9:16竖图)的画面提示词，数量必须与脚本镜头数完全一致、不能少、不能留空。${style ? "统一风格：" + style + "。" : "默认白底极简、蓝紫渐变品牌色、圆角卡片 UI、大留白。"}${refLine}写每条前，先把脚本那句画面在脑内具象化成一个完整真实场景（空间环境里有什么物件、光线从哪来、人物正在做哪个具体动作、屏幕里显示什么文字数据），脚本一句话至少扩成 3-5 个可落地的具体视觉细节。每条都要非常具体：景别(中近景/特写/全景)、机位与画面结构、人物动作与表情、界面里出现的具体文字、配色、光线方向与冷暖、背景元素、产品界面出现位置。整体偏教程、专业、可信，不是信息流硬广，画面干净克制。画面里不要叠加字幕/标题/花字(产品界面本身自带的少量UI文字可以)。禁止使用『电影感/高级感/种草感/氛围感/科技感』等抽象词，要把这种感觉翻译成具体画面结构/光线/景深来写。不要 emoji、不要二维码、不要乱码。只输出 JSON：{"shots":[{"prompt":"..."}]}，shots 数量=脚本镜头数。`;
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + sys },
        { role: "user", content: `账号创作风格：${account.styleProfile || account.voiceName || "真实经验分享"}\n共 ${shots.length} 个镜头，请输出 ${shots.length} 条提示词：\n${shots.map((x, i) => (i + 1) + ". " + (x.visual || "")).join("\n")}` }
      ], { json: true, temperature: 0.7 });
      const d = parseJSONLoose(content);
      if (!d.shots || !d.shots.length) throw new Error("模型未返回 shots");
      return this._ok({ shots: shots.map((x, i) => ({ prompt: cleanText((d.shots[i] && d.shots[i].prompt || "").trim()) || this.fallbackStoryboardPrompt(x, account, style, sharedRefName, product) })) });
    } catch (e) {
      this._fb(e);
      await delay(400);
      return { shots: shots.map(x => ({ prompt: this.fallbackStoryboardPrompt(x, account, style, sharedRefName, product) })) };
    }
  },

  /* ---------- 图文：逐张图片提示词 ---------- */
  async generateImagePrompts({ script, account, style, imageTemplate = "", styleRefName = "", imageCount = DEFAULT_XHS_IMAGE_COUNT, product = null, topic = "", batchVariant = null, useOnlineTrends = false, trendGuide = "", trendPrep = null, copy = null }) {
    const tpl = String(imageTemplate || "").trim();
    const nImg = Math.max(3, Math.min(12, imageCount || DEFAULT_XHS_IMAGE_COUNT));
    const safeTopic = sanitizeXhsText(cleanText(topic || ""));
    const safeScript = sanitizeXhsText(cleanText(scriptInputText(script)));
    const safeStyle = sanitizeXhsText(cleanText(style || ""));
    const safeTpl = sanitizeXhsText(stripPromptScaffold(tpl));
    const copyTitle = sanitizeXhsText(stripOwnProductMentions(copy?.title || "", product));
    const copyBody = sanitizeXhsText(stripOwnProductMentions(copy?.body || copy?.copy || "", product));
    const copyBrief = [copyTitle ? `标题：${copyTitle}` : "", copyBody ? `正文：${shortChinese(copyBody.replace(/\n+/g, " / "), 420)}` : ""].filter(Boolean).join("\n");
    const hasCopyBrief = !!copyBrief;
    const contentBasis = hasCopyBrief ? copyBrief : [safeTopic, safeScript].filter(Boolean).join("\n");
    const mentionedTools = productsMentionedIn(contentBasis, product, 4);
    const mentionedGuide = productRelationLine(mentionedTools);
    const variantGuide = batchVariantLine(batchVariant);
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + `你是小红书笔记配图的图片提示词设计师。图文配图的内容判断以「发布文案」为第一依据，用户创作内容和脚本只作为补充，账号只提供视觉风格，不参与内容方向判断。图片里讲什么必须跟最终标题、正文和标签一致；如果发布文案和脚本/趋势参考冲突，以发布文案为准，并删除脚本里无关工具词。先把发布文案整理成 ${nImg} 个信息节拍，再拆成 ${nImg} 张静态图片：点击入口、真实办公场景、执行动作、关键细节、可复用结果、结论提醒等叙事功能。每张图承载一个清楚的核心信息，长文案先做摘要、取舍和分布。信息密度由内容判断：入口图更轻，突出强标题和简单主视觉；内页按文案需要承载具体动作、证据或结果，模拟文档/表格/报告页时可以更细，同时保持层级清楚、文字可读。
第一张图默认是点击入口，优先冲击感和可点击性：用强标题、短副标题和简单视觉关系吸引点击。工具组合/对比主题的第一张以工具标识或简化图标、大字标题、箭头或 VS 关系为主；第二张之后再展开场景、操作、结果和边界。
若内容过多，先在内部重新规划：把重要信息分给 ${nImg} 张图，次要内容压成一句结论；若内容过少，补一个真实使用例子、结果证据或边界提醒。功能名只用于内部理解，画面文字要写具体动作和结果。若创作内容里出现竞品/同类工具，要把它们作为对比、组合或分工对象写进画面信息结构，例如分工箭头、工具边界卡片、组合流程或适用场景提醒，让画面明确呈现主产品和其他工具的关系。
同一批量任务的不同账号必须有不同内容编排：即使统一创作方向相同，也要改变每张图的标题、例子、主视觉、卡片顺序和结论，形成不同账号的内容差异。
每条 prompt 输出正向主体，使用「生成小红书笔记风格3:4尺寸，【图片风格：...】，图片具体内容：【...】。」结构；如果有参考图，则在开头加入「请根据上传的参考图」。系统会统一追加固定短负面约束，模型只写正向画面主体。图片内容只来自最终发布文案、图卡脚本和产品信息；视觉效果只来自账号创作风格、账号模板和参考图。联网参考、热门样本、账号名称都不得改写图片内容主题。用户输入原句需先整理成画面信息。${safeStyle ? "账号创作风格（只决定视觉效果）：" + cleanImagePlanningWords(safeStyle) + "。" : "默认白底极简、蓝紫品牌色、圆角卡片排版、大留白、真实截图质感。"}${styleRefName ? `参考图（只作为视觉/构图参考，不提供内容主题）：${sanitizeXhsText(styleRefName)}。` : ""}${safeTpl ? `账号有固定模板，继承模板的画面语言、色彩、字体、参考图使用方式和统一要求；模板只当风格母版，模板句子需要替换成本次内容。` : ""}

每条 prompt 保持精炼但足够具体。说清：画面布局、主视觉、关键界面/文件/数据卡片、画面里允许出现的短文字、光线与颜色。画面文字围绕主标题、短解释和必要标签组织，按内容复杂度自然取舍；封面更简洁，内页可适当增加信息。若账号风格是火柴人、简笔画、小人、漫画或手绘，则画面靠人物动作、表情、气泡和箭头讲解，文字更少，避免复杂表格和长文案。
画面文字必须写具体功能、动作或结果，例如「资料自动归类」「字段一眼识别」「报告可直接用」，不能写空泛定位。
测评、对比或工具选择类选题用适合谁、不适合谁、任务边界、证据和组合方式表达，采用边界对照、场景分工和使用建议，不采用分数、星级、排行榜、打分表或评分卡。
内部分类词只用于理解结构，最终 prompt 主体保持正向画面描述。

${xhsGuardPrompt()}

只输出 JSON：{"shots":[{"title":"给操作员看的短标题，写具体功能或结果","prompt":"可直接给图像模型的提示词","ui":true}]}` },
        { role: "user", content: `账号创作风格（只决定视觉效果，不决定内容）：${sanitizeXhsText(account.styleProfile || style || "")}\n${product ? `主产品：${sanitizeXhsText(chineseProductDisplayName(product))}\n` : ""}${safeTopic ? `本次主题（只作辅助，不得覆盖发布文案）：${safeTopic}\n` : ""}${variantGuide ? `${variantGuide}\n` : ""}${copyBrief ? `发布文案（图片内容第一依据，只能围绕它拆图）：\n${copyBrief}\n` : "发布文案暂缺：只允许根据本次主题和图卡脚本拆图，不要引用联网参考或账号风格去改写内容方向。\n"}${mentionedGuide ? `发布文案/图卡脚本里明确提到的其他工具能力：\n${mentionedGuide}\n图片提示词必须具体写出它们和主产品如何结合、分工或对比；不要只写“作参照”。\n` : ""}${styleRefName ? `风格参考图：${sanitizeXhsText(styleRefName)}\n` : ""}${safeTpl ? `账号图文模板（只作为视觉风格/结构母版，变量需替换）：\n${safeTpl}\n` : ""}图卡脚本（只补充画面线索；若和发布文案冲突，以发布文案为准）：\n${safeScript || "(按发布文案拆图)"}` }
      ], { json: true, temperature: 0.8 });
      const d = sanitizeXhsObject(parseJSONLoose(content));
      if (!d.shots || !d.shots.length) throw new Error("模型未返回 shots");
      return this._ok({
        shots: normalizeImagePromptItems(d.shots, {
          script: safeScript,
          topic: safeTopic,
          account,
          style: safeStyle,
          imageTemplate: safeTpl,
          styleRefName,
          imageCount: nImg,
          product,
          copy,
          trendPrep: null
        })
      });
    } catch (e) {
      this._fb(e);
      await delay(400);
      const rows = String(safeScript || "").split(/\n+/).map(x => x.trim()).filter(Boolean);
      return {
        shots: normalizeImagePromptItems(Array.from({ length: nImg }, (_, i) => {
          const rawBase = rows[i] || rows[Math.min(rows.length - 1, i)] || topic || `${genericProductLabel(product)}办公效率方法`;
          const base = rawBase.replace(/^(图\d+|镜头\d+|第\d+张)[：:｜\s]*/g, "").replace(/图上文案[:：][^｜\n]+/g, "").trim();
          const titleText = (base.match(/图上文案[:：]([^｜\n]+)/) || base.match(/line[:：]([^｜\n]+)/) || [])[1]?.trim()
            || (i === 0 ? copyTitleForImagePlanning(copy, product) || completeImageText(safeTopic, 36) || `${genericProductLabel(product)}到底省在哪` : i === nImg - 1 ? "把重复动作交给流程" : completeImageText(base.replace(/^图\d+[：:｜\s]*/, ""), 36));
          return {
            title: IMAGE_CARD_TASKS[Math.min(i, IMAGE_CARD_TASKS.length - 1)]?.title || `资料处理 ${i + 1}`,
            headline: titleText,
            ui: i > 0 && i < nImg - 1,
            prompt: base
          };
        }), {
          script,
          topic: safeTopic,
          account,
          style: safeStyle,
          imageTemplate: safeTpl,
          styleRefName,
          imageCount: nImg,
          product,
          copy,
          trendPrep: null
        })
      };
    }
  },

  /* ---------- 发布文案（交付包随附） ---------- */
  async generateCopy({ topic, shots, account, style, kind = "image", product = null, batchVariant = null, avoidCopies = [], useOnlineTrends = false, trendGuide = "", trendPrep = null }) {
    const safeTopic = sanitizeXhsText(cleanText(topic || ""));
    const safeShots = sanitizeXhsObject(JSON.parse(JSON.stringify(shots || [])));
    const safeStyle = sanitizeXhsText(cleanText(style || ""));
    const intent = inferCopyIntent({ topic: safeTopic, shots: safeShots, account, product, useAccountPosition: kind === "video" });
    const variantGuide = batchVariantLine(batchVariant);
    const avoidLine = (avoidCopies || []).slice(-6).map((x, i) => `${i + 1}. 标题：${sanitizeXhsText(x.title || "")}；首句：${sanitizeXhsText(String(x.copy || x.body || "").split(/\n/).find(Boolean) || "").slice(0, 60)}`).join("\n");
    const prep = trendPrep || await resolveTrendPrep({ topic: safeTopic, account, product, batchVariant, useOnlineTrends, kind, imageCount: Math.max(3, Math.min(12, (safeShots || []).length || DEFAULT_XHS_IMAGE_COUNT)) });
    const trendGuideText = prep?.guide || trendGuide || await resolveTrendGuide({ topic: safeTopic, account, product, batchVariant, useOnlineTrends, kind });
    const trendReferenceText = trendReferenceForCopy(prep, product);
    const offlineCopyLine = !trendReferenceText
      ? "当前没有联网参考原文可用：本地趋势库只当灵感，不要被它的标题、结构或固定话术限制。请直接围绕本次主题、图卡内容和账号风格，写成真实使用后的经验复盘；允许选择更自然的叙述顺序。正文少换行，不留空行，不要机械分点；要讲清一个具体场景、一个可执行方法和一个复核/边界判断。"
      : "";
    const script = kind === "video"
      ? (safeShots || []).map((s, i) => `镜头${i + 1}｜${s.time || ""}｜口播：${s.line || ""}`).join("\n")
      : (safeShots || []).map((s, i) => `图${i + 1}｜${s.idea || ""}｜图上文案：${s.line || ""}`).join("\n");
    const sys = kind === "video"
      ? `你是短视频发布文案写手，为成片写发布标题与简介（发布平台：${account.platform}，按该平台调性写）：
- title：16-32字，必须从口播内容里提炼，不要不明所以。优先仿照这些网感结构，但不能照抄完整句：` + `国产codex，不用安装1分钟上手零门槛教程，一篇讲清楚！ / AI办公别只会聊天，这条把真实用法讲透 / 零基础用桌面智能体，先看这篇少绕路。标题要有对象、门槛/收益/教程感、具体结果；可以出现 Codex/AI Agent/桌面智能体等品类词，避免空泛标题。
- copy：260-480字简介，像真实创作者发视频后的补充说明。必须先根据口播逐句总结出一个主结论，再展开真实使用场景、关键动作和边界提醒。不要总是分点，不要写固定编号清单；可以用实测复盘、适合/不适合、一个可复制口播流程来写。段落之间只用单换行，不留空行。必须来自口播脚本，不能脱离口播另写一套图文文案；最后一行4-7个具体话题标签。
语气按账号创作风格和口播风格细化，像真人发视频，不要硬广腔，不要假装临时接到领导任务。用户给的创作内容只是素材和约束，禁止原样当标题或正文第一句；必须先提炼痛点、动作和结果后再写。只输出 JSON：{"title":"...","copy":"..."}`
      : `你是小红书爆款笔记文案写手。根据图卡脚本写一篇配套笔记：
- title：20字以内，像真实创作者的结论/痛点标题，具体、有梗、有信息量，可带1个贴合 emoji。
- copy：320-620字正文，像真实小红书效率博主的经验笔记。不要总是分点，不要写固定编号清单；优先写成实测复盘或场景叙述，必要时再少量列点。段落之间只用单换行，不留空行。正文要有干货：具体场景、操作顺序、指令写法、结果怎么复核、适合/不适合谁，最后一行4-7个具体话题标签。
语气按本次内容和账号创作风格细化，像真人发笔记，不要硬广腔。用户给的创作内容只是素材和约束，禁止原样当标题或正文第一句；必须先提炼痛点、动作和结果后再写。只输出 JSON：{"title":"...","copy":"..."}`;
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + sys + XHS_COPY_STYLE + "\n\n【小红书联网参考吸收规则】\n如果有联网参考，优先吸收里面真实可用的信息：痛点、教程步骤、踩坑点、读者关心的问题、互动数字暗示的受欢迎角度、标题情绪和口语节奏。不要只学结构，也不要写成泛泛的工具说明。\n可以把参考内容改写成更适合本账号的亲历式经验，但必须换场景、换顺序、换表达，不能连续照搬样本文案原句；参考只有标题/摘要时，要基于可得信息做真实推断，不能编造参考正文。\n\n【离线创作放开规则】\n没有联网参考或用户关闭联网时，不要被本地趋势库限制成模板文。本地趋势只提供方向词，最终文案要优先服从用户主题、图卡内容、账号语气和真实使用逻辑。可以写成亲历复盘、经验分享、避坑提醒、场景叙述、轻教程或观点表达，只要主题点讲透、信息有深度、语气像真人。\n\n【小红书热门结构与内容参考】\n" + trendGuideText + "\n\n【对外文案产品名规则】\n标题、正文和话题标签都不要出现自家产品名；需要指代时用「桌面智能体」「AI应用搭建工具」「这个工具」「这类工具」等品类词。竞品或互补工具名可以出现，但不要把主产品名写进标题或正文。\n\n【同批去重硬约束】\n如果用户没有写很具体的内容，请先自己选择一个不同于同批其他账号的真实场景，再写标题和正文。禁止只改产品名、账号名或数字；禁止连续使用同一种标题类型、同一种首句和同一种三点清单。标题可以不带产品名，但正文必须让人知道具体工具怎么分工或怎么用。\n\n" + xhsGuardPrompt() },
        { role: "user", content: kind === "video"
          ? `账号创作风格：${sanitizeXhsText(account.styleProfile || account.voiceName || safeStyle || "")}\n账号口播风格参考：${sanitizeXhsText(account.voiceName || account.styleProfile || account.tone || "自然、可信、有教程感")}\n语气：${sanitizeXhsText(account.tone || "教程感")}\n创作内容原文（只用于理解，不要照抄）：${safeTopic}\n${variantGuide ? `${variantGuide}\n` : ""}${avoidLine ? `同批已经出现过的标题/首句，必须避开：\n${avoidLine}\n` : ""}提炼后的发布角度：面向${intent.audience}，痛点是「${intent.pain}」，核心动作是「${intent.action}」，结果价值是「${intent.result}」。\n${safeStyle ? "图片风格：" + safeStyle + "\n" : ""}已定口播逐句稿（发布标题和简介必须围绕这些口播总结，不要另起主题）：\n${script}\n标题参考方向：国产Codex/AI Agent/桌面智能体/零门槛/1分钟上手/一篇讲清楚/少绕路/真实用法。根据口播选择最贴切的一种，不要硬塞无关词。\n${HUMAN_COPY_VOICE}${this.memoryLine(account)}`
          : `账号创作风格：${sanitizeXhsText(account.styleProfile || safeStyle || "")}\n语气：${sanitizeXhsText(account.tone || "教程感")}\n创作内容原文（只用于理解，不要照抄）：${safeTopic}\n${variantGuide ? `${variantGuide}\n` : ""}${avoidLine ? `同批已经出现过的标题/首句，必须避开：\n${avoidLine}\n` : ""}提炼后的发布角度：面向${intent.audience}，痛点是「${intent.pain}」，核心动作是「${intent.action}」，结果价值是「${intent.result}」。\n${trendReferenceText ? `联网参考原始可用信息（要吸收真实痛点/步骤/互动信号，但不要照抄原句）：\n${trendReferenceText}\n` : `${offlineCopyLine}\n`}${safeStyle ? "图片风格：" + safeStyle + "\n" : ""}图卡内容摘要：\n${script}\n${HUMAN_COPY_VOICE}` }
      ], { json: true, temperature: 1.02 });
      const d = sanitizeXhsObject(parseJSONLoose(content));
      if (!d.title || !d.copy) throw new Error("模型未返回 title/copy");
      return this._ok(polishCopyResult(d, { topic: safeTopic, shots: safeShots, account, kind, product, batchVariant, avoidCopies }));
    } catch (e) {
      this._fb(e);
      await delay(400);
      return sanitizeXhsObject(this._mockCopy({ topic: safeTopic, shots: safeShots, account, product, batchVariant, avoidCopies }));
    }
  },

  async randomTitle({ topic, account, product = null, useOnlineTrends = false, trendGuide = "", trendPrep = null }) {
    try {
      const prep = trendPrep || await resolveTrendPrep({ topic, account, product, useOnlineTrends, kind: "image" });
      if (prep?.title) return this._ok(stripOwnProductMentions(prep.title, product));
      const trendGuideText = prep?.guide || trendGuide || await resolveTrendGuide({ topic, account, product, useOnlineTrends, kind: "image" });
      const styleLine = `账号创作风格「${account?.styleProfile || account?.lockedStyle || "干净可读"}」`;
      const productName = genericProductLabel(product);
      const r = await llm([{ role: "user", content: `给小红书笔记起一个标题，主题「${topic || `${productName} 办公效率`}」，${styleLine}。参考这些热门标题结构但可以做 80% 模仿 + 20% 改写，不能照抄完整原句：\n${trendGuideText}\n20字以内，口语化、有信息量，带1个以内贴合 emoji。不要出现自家产品名，用品类词替代。只回标题本身，不要引号不要解释。` }], { temperature: 1.1 });
      const t = stripOwnProductMentions(String(r).trim().replace(/^["'「]|["'」]$/g, "").slice(0, 30), product);
      if (t) return this._ok(t);
      throw new Error("空");
    } catch (e) {
      this._fb(e);
      return stripOwnProductMentions(this._mockCopy({ topic, shots: [], account, product }).title, product);
    }
  },

  /* ---------- 随机骰子 ---------- */
  async randomPick({ kind, account, product = null, batchVariant = null, seed = "", avoidTopics = [], useOnlineTrends = false, trendGuide = "", trendPrep = null }) {
    try {
      const runSeed = seed || `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const p = product || allProductsForAI().find(x => x.owner === "ours") || null;
      const rel = relatedProducts(p, allProductsForAI(), 4);
      const productName = chineseProductDisplayName(p);
      const relLine = rel.length ? `可参考同类产品：${productListLine(rel)}。` : "";
      const variantGuide = batchVariantLine(batchVariant);
      const avoidLine = (avoidTopics || []).slice(-8).map((x, i) => `${i + 1}. ${sanitizeXhsText(x)}`).join("\n");
      const prep = trendPrep || await resolveTrendPrep({ topic: "", account, product: p, batchVariant, useOnlineTrends, kind: "image", seed: runSeed });
      if (kind === "topic" && prep?.creativeContent && !tooSimilarTopic(prep.creativeContent, avoidTopics)) return this._ok(enforceCurrentProductTopic(cleanRandomTopicText(prep.creativeContent, 30), p, rel));
      const trendGuideText = prep?.guide || trendGuide || await resolveTrendGuide({ topic: "", account, product: p, batchVariant, useOnlineTrends, kind: "image", seed: runSeed });
      const ask = kind === "direction"
        ? `给我一个适合做「${productName}」产品教程短视频的目标人群方向，要主流、好理解、贴近大众（比如 职场白领 / 宝妈 / 大学生 / 老师 / 电商卖家 这类），不要冷门抽象概念。只回一个3-6字的词，不要标点不要解释。`
        : kind === "style"
        ? `为小红书图文笔记配图想一个总视觉风格短语，参考当前创作风格「${account.styleProfile || "干净可读"}」。可以超出常见标签、有新鲜感但要好落地（例如：奶油色清晨书桌风 / 蓝白格子手帐风 / 低饱和莫兰迪办公风）。只回一个5-12字的风格短语，不要标点不要解释。`
        : `${currentProductLine(p)}\n给我一个「${productName}」相关的 AI 博主选题，贴合账号创作风格「${account.styleProfile || "办公效率人群"}」和账号名「${account.name || "未命名账号"}」。用户没有写创作内容，所以你要主动引入 1 个同类/互补工具做对比、组合、分工或妙用科普，不要只孤立介绍${productName}。${variantGuide ? `\n${variantGuide}` : ""}${avoidLine ? `\n同批已经出现过这些主题，必须避开，不要同义改写：\n${avoidLine}` : ""}${p?.id === "miaoda" ? "秒哒是无代码 AI 应用生成平台，选题必须围绕应用生成、H5/页面、原型、小工具、数据表/后台、非技术人验证想法；不要写文件整理、桌面自动操作、PDF/Word/Excel 转格式、会议纪要这类桌面执行能力，除非明确是“做一个应用来管理这些流程”。" : ""}${relLine}\n热门方向参考（只学选题角度，不照抄）：\n${trendGuideText}\n随机种子：${runSeed}。只回一句不超过22字的主题，不要标点不要解释。`;
      const r = await llm([{ role: "user", content: ask }], { temperature: 1.0 });
      const t = kind === "style"
        ? String(r).trim().replace(/[。.\n"'`]/g, "").slice(0, 16)
        : cleanRandomTopicText(r, 30);
      if (t && (kind !== "topic" || !tooSimilarTopic(t, avoidTopics))) return this._ok(kind === "direction" ? (t.endsWith("方向") ? t : t + "方向") : kind === "topic" ? enforceCurrentProductTopic(t, p, rel) : t);
      throw new Error("空");
    } catch (e) {
      this._fb(e);
      const runSeed = seed || `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      if (kind === "topic") return fallbackRandomTopic({ account, product, batchVariant, seed: runSeed, avoidTopics });
      const pool = kind === "direction" ? DIR_POOL : kind === "style" ? STYLE_POOL : TOPIC_POOL;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      return kind === "direction" ? pick + "方向" : pick;
    }
  },

  /* ---------- md / 自然语言 → 批量账号 ---------- */
  async parseAccountsMd(text) {
    try {
      const content = await llm([
        { role: "system", content: `把用户的 markdown 解析成账号数组。每个账号字段：name(必填)、platform(小红书|视频号)、mode(图文|视频)、subType(数字人|无数字人，仅视频)、styleProfile(创作风格/口播风格描述)、qtags(数组，仅限：${TAG_POOL.join("/")})。不再生成账号定位字段；缺失字段合理推断。只输出 JSON：{"accounts":[...]}` },
        { role: "user", content: text.slice(0, 6000) }
      ], { json: true, temperature: 0.2 });
      const d = parseJSONLoose(content);
      if (d.accounts && d.accounts.length) return this._ok(d.accounts);
      throw new Error("空");
    } catch (e) {
      this._fb(e);
      const blocks = text.split(/\n(?=#{1,3}\s|\d+[.、]\s|-\s+[^\s])/).map(b => b.trim()).filter(Boolean);
      return blocks.map(b => {
        const name = (b.match(/^[#\d.、\-\s]*([^\n｜|：:]+)/) || [])[1]?.trim().slice(0, 20);
        if (!name) return null;
        return {
          name,
          platform: b.includes("视频号") ? "视频号" : "小红书",
          mode: b.includes("图文") ? "图文" : "视频",
          subType: b.includes("无数字人") ? "无数字人" : "数字人",
          position: "",
          styleProfile: (b.match(/(?:风格|口播风格|创作风格)[：:]\s*([^\n]+)/) || [])[1] || "",
          qtags: TAG_POOL.filter(t => b.includes(t))
        };
      }).filter(Boolean);
    }
  },

  /* ---------- 自由对话（Agent chat 兜底走状态摘要） ---------- */
  async chat(messages) {
    return llm(messages, { temperature: 0.6 });
  },

  /* 素材号长脚本本地兜底（12 镜头、利他口播、带 ui/scene 标记） */
  async _mockMaterialScript({ topic, account, product = null }) {
    await delay(600);
    const productName = chineseProductDisplayName(product);
    const t = (topic || "").replace(/Dumate|百度搭子|百度秒哒|秒哒/g, "").trim() || "重复的办公杂活";
    const rows = [
      { idea: "痛点钩子", visual: "凌乱桌面、堆叠文件与杂乱文件夹的特写，冷调光，画面略压抑", line: `先说个扎心的：很多人每天有近一个小时，是耗在${t}这种重复杂活上的。不是你不够快，是这些活本就不该手动干。`, ui: false, scene: 1 },
      { idea: "提出方案", visual: `${productName}产品界面首页圆角输入框，浅蓝网格背景，界面干净明亮，输入框光标闪烁`, line: `后来我会先看这类 AI 工具能不能把流程真的跑起来，这次用的是${productName}。重点不是会聊天，而是能把任务拆开并交付结果。`, ui: true, scene: 2 },
      { idea: "演示输入", visual: "特写输入框里逐字浮现一句任务指令，发送按钮蓝紫高亮，任务卡片从下方滑入", line: `用法简单到离谱：把要做的事，像跟同事说话一样打一句话发给它。`, ui: true, scene: 2 },
      { idea: "拆解步骤", visual: "任务卡片展开成三张步骤卡片自上而下排开，每张带蓝紫小圆点和一行中文说明", line: `它会先把这件事拆成清清楚楚的几步，让你知道它打算怎么干，而不是黑箱乱来。`, ui: true, scene: 2 },
      { idea: "执行过程", visual: "文件卡片成批滑入处理区，蓝紫扫描线自左向右扫过，进度条推进、数字跳动", line: `确认之后它就自己开始执行，批量处理、跨软件来回切换，全程你不用守着。`, ui: true, scene: 3 },
      { idea: "结果展示", visual: "结构化结果卡片汇聚成三个分区，右上角逐个亮起完成圆点，关键数据被局部高亮放大", line: `几十秒后，结果直接是能用的版本：归好类的文件、提好的关键信息、甚至一份排好版的汇报。`, ui: true, scene: 3 },
      { idea: "能力一：文件整理", visual: "左乱右整的文件夹对比画面横移，中间一条箭头指向整洁的分类结构", line: `具体能帮你做什么？第一类是文件：一键分类归档、Word Excel PPT 和 PDF 互转、从合同会议纪要里把关键信息抠出来。`, ui: false, scene: 4 },
      { idea: "能力二：数据分析", visual: "原始数据表格流入处理区，自动生成柱状图与一页汇报 PPT 的画面", line: `第二类是数据：从一堆原始表格，到一份能直接拿去汇报的分析 PPT，中间那些拉表格、做图的功夫，它全包了。`, ui: true, scene: 5 },
      { idea: "能力三：办公自动化", visual: "网页表单被自动填写、资料批量下载、多个软件窗口依次被操作的画面", line: `第三类更狠，是替你动手：自动网页填表、批量查信息下资料、把好几个软件串成一条流程跑下来。`, ui: true, scene: 6 },
      { idea: "安全说明", visual: "本地沙箱的示意画面，数据在本机闭环流转、不外传的图示，冷静蓝调", line: `可能你担心数据安全——它跑在本地沙箱里，资料不外流，这点对处理公司文件的人挺关键。`, ui: false, scene: 7 },
      { idea: "适用人群", visual: "办公桌前空镜，桌上摆着键盘、咖啡和便签，暖色晨光", line: `所以它真正帮到的，是每天被这些重复活拖住、本该把时间花在更值钱的事情上的人。`, ui: false, scene: 8 },
      { idea: "金句收束", visual: `所有结果卡片缓缓汇聚成${productName}完成卡片，白底浅蓝网格，定格成一张干净的完成卡片`, line: `一句话总结：能交给工具的，就别再用人肉硬扛。把重复留给流程，把脑子留给真正重要的事。`, ui: true, scene: 9 }
    ];
    return { title: topic, shots: rows.map(r => ({ ...r, line: stripCTA(sanitizeXhsText(r.line)) })) };
  },

  /* ---------- 本地回退模板 ---------- */
  async _mockScript({ topic, account, image, imageCount, product = null }) {
    await delay(600);
    const productName = chineseProductDisplayName(product);
    const clean = (topic || "").replace(/Dumate|百度搭子|百度秒哒|秒哒/g, "").trim() || "杂事";
    if (image) {
      const n = Math.max(3, Math.min(9, imageCount || DEFAULT_XHS_IMAGE_COUNT));
      const mentioned = productsMentionedIn(topic, product, 2);
      const firstRef = mentioned[0];
      const refName = firstRef ? productDisplayName(firstRef, "同类工具") : "";
      const isRelation = !!firstRef;
      const cover = isRelation
        ? { idea: `${refName}和${productName}怎么分工`, visual: `左右分栏：左侧是${refName}知识库/资料沉淀界面，右侧是${productName}桌面执行结果卡，中间用箭头连接`, line: `${refName}负责沉淀，${productName}负责执行` }
        : { idea: "真实问题开场", visual: `白底大留白，居中大字标题，旁边出现${productName}产品界面小卡片`, line: `${clean}太费时？` };
      const ending = isRelation
        ? { idea: "组合方法结论", visual: `一张复核清单卡片：先在${refName}整理资料，再让${productName}读取本地文件并输出清单/报告`, line: "先沉淀，再执行" }
        : { idea: "方法结论", visual: `${productName}完成卡片居中，旁边是整齐结果清单`, line: `把重复动作交给${productName}` };
      const stepsPool = isRelation ? [
        { idea: "先用知识库收住上下文", visual: `${refName}里有双链节点、Canvas资料墙或标签卡，标出合同/金额/项目资料`, line: `${refName}放长期资料` },
        { idea: "再用桌面 Agent 执行动作", visual: `${productName}输入框写着“按知识库规则整理本地合同文件并提取金额”，任务卡开始执行`, line: `${productName}处理本地文件` },
        { idea: "展示分工边界", visual: `两列对照卡：${refName}写沉淀/检索/知识结构，${productName}写分类/提取/转格式/生成结果`, line: "一个帮你想，一个帮你干" },
        { idea: "输出可复用结果", visual: `${productName}生成表格清单、归档文件夹和复盘报告，旁边回写到${refName}的一张总结卡`, line: "结果再回到知识库" },
        { idea: "适用场景提醒", visual: "便签列出内容选题、合同归档、项目资料复盘三个场景，小箭头串成循环", line: "适合反复做的流程" }
      ] : [
        { idea: "引入产品入口", visual: `${productName}首页圆角输入框，浅蓝网格背景`, line: `打开${productName}` },
        { idea: "演示输入任务", visual: "输入框内出现任务文字，发送按钮高亮", line: "一句话交给它" },
        { idea: "展示自动执行过程", visual: "任务卡片展开，进度条推进，蓝紫扫描线", line: "它自己动手干" },
        { idea: "展示结构化结果", visual: "结果卡片三个分区，蓝紫完成圆点", line: "几秒出结果" },
        { idea: "展示更多功能", visual: "白色卡片排列三个小图标：转格式/提信息/批量改名", line: "不止这一招" },
        { idea: "对比前后效果", visual: `左乱右整对比图，中间箭头指向${productName}结果卡`, line: "前后差距一目了然" },
        { idea: "使用小贴士", visual: "便签式卡片列两条使用技巧，配勾选图标", line: "记住这两个技巧" }
      ];
      const mid = stepsPool.slice(0, Math.max(1, n - 2));
      return { title: cleanScriptTitle(topic, topic, product), shots: [cover, ...mid, ending].slice(0, n) };
    }
    const dh = account.subType !== "无数字人";
    const base = dh ? [
      { idea: "数字人开场钩子", visual: `数字人正面中近景、固定机位、暖色正面光，${productName}产品界面小卡片右上轻浮现`, line: `你是不是也总被${clean}困住，半天搞不定？` },
      { idea: "引出产品", visual: `缓推切到${productName}首页圆角输入框，浅蓝网格背景，输入框微微高亮`, line: `其实这类任务可以先交给${productName}跑一遍。` },
      { idea: "输入任务演示", visual: "特写输入框出现任务文字、点发送按钮蓝紫高亮，任务卡片滑入", line: "把要做的事直接发给它。" },
      { idea: "拆解步骤演示", visual: "任务卡片展开成三张步骤卡片依次滑入，蓝紫小圆点，鼠标依次划过", line: "它会自动拆成清晰的步骤，一步到位。" },
      { idea: "执行过程", visual: "文件/资料卡片滑入处理区，蓝紫扫描线+进度条从左推进", line: "交给它之后，等几秒就好。" },
      { idea: "结果展示", visual: "结构化结果卡片汇聚，三个分区、右上完成圆点，局部高亮", line: "结果清晰、能直接用。" },
      { idea: "数字人使用建议", visual: "切回数字人中近景，右侧悬浮结果卡片三条结果", line: "省下来的时间，喝杯咖啡不香吗？" },
      { idea: "数字人收束", visual: `数字人微笑看镜头，结果卡片缩小汇聚到${productName}完成卡片`, line: `适合重复出现的任务，就把它固定成一套流程。` }
    ] : [
      { idea: "场景痛点引入", visual: "凌乱桌面/堆叠文件特写，缓推运镜，冷调光，画面压抑", line: "处理这些杂事，常常要花掉一上午。" },
      { idea: "引出产品界面", visual: `横移切到${productName}首页圆角输入框，浅蓝网格，界面干净明亮`, line: `用${productName}这类工具，先把任务说清楚。` },
      { idea: "输入任务演示", visual: "输入框任务文字浮现、发送按钮蓝紫高亮，任务卡片滑入", line: "把需求直接发过去。" },
      { idea: "拆解步骤演示", visual: "三张步骤卡片自上而下滑入，蓝紫小圆点，轻微推拉", line: "它会自动拆解成清晰步骤。" },
      { idea: "执行过程", visual: "文件卡片滑入处理区，蓝紫扫描线、进度条推进、数字跳动", line: "整个过程自动完成。" },
      { idea: "结果展示", visual: "结构化结果卡片汇聚，三分区、完成圆点、局部高亮放大", line: "几秒就能拿到能直接用的结果。" },
      { idea: "对比收束", visual: "左乱右整对比画面横移，右侧定格整洁结果", line: "效率差距，一目了然。" },
      { idea: "结论收束", visual: `所有卡片汇聚到${productName}完成卡片，白底浅蓝网格，定格完成卡片`, line: `把杂事变成流程，才是真的省时间。` }
    ];
    const shots = base.map((b, i) => ({ time: `${i * 3}-${i === 7 ? 30 : i * 3 + 3}s`, idea: b.idea, visual: b.visual, line: b.line }));
    return { title: cleanScriptTitle(topic, topic, product), shots };
  },

  _humanAppearanceAnchor(account) {
    const key = `${account?.id || ""}${account?.name || ""}`;
    const n = [...key].reduce((a, c) => a + c.charCodeAt(0), 0) % 2;
    const anchors = [
      `真人角色一致性要求：同一位中国年轻职场女性数字人，26-30岁，气质干净专业但有亲和力；鹅蛋脸偏小，下颌线柔和清晰，额头饱满，发际线自然；自然平直眉，眉尾略收，杏眼偏圆，双眼皮自然，眼神专注但不锐利；鼻梁中等偏挺，鼻头圆润不过分尖；嘴唇厚薄适中，微笑时嘴角轻微上扬；肤色自然白皙偏暖，妆容清淡，唇色豆沙或浅玫瑰；黑棕色中长发，锁骨到肩下长度，三七分或自然中分，发尾微内扣；身形中等偏瘦，肩颈舒展，穿浅米色针织衫或白色衬衫，搭配深色简洁下装。所有出现人物的镜头保持同一张脸、同一发型、同一服装、同一体态和同一表情习惯，不能换人、不能脸型漂移。`,
      `真人角色一致性要求：同一位中国年轻职场男性数字人，27-32岁，气质理性松弛、像懂技术的同事；脸型为偏长的清瘦椭圆脸，下颌线利落但不锋利，额头开阔；眉毛自然偏浓，眼型细长偏内双，眼神稳定专注；鼻梁中等偏高，鼻翼自然；嘴唇偏薄，讲话时表情克制，有轻微吐槽感和理性幽默；肤色自然偏暖，皮肤质感真实不过度磨皮；黑色短发，侧分或自然蓬松，发际线自然；身形中等偏瘦，肩背挺直，穿浅蓝或白色衬衫、深色休闲外套或针织开衫。所有出现人物的镜头保持同一张脸、同一发型、同一服装、同一体态和同一表情习惯，不能换人、不能脸型漂移。`
    ];
    return anchors[n];
  },

  _voiceAnchor(account) {
    const tone = account?.tone || "专业、自然、可信";
    return `口播声音要求：普通话清晰标准，音色干净自然，中音区稳定；语速中等，不抢话、不赶句，像在给同事讲一个真实有效的方法；情绪有解释感和轻微惊喜感，不机械播报，不夸张带货；整体语气为${tone}。`;
  },

  _ensureRenderPrompt(prompt, account) {
    let out = cleanText(prompt || "")
      .replace(/@参考音频[，,、\s]*/g, "")
      .replace(/口播语气节奏参考上传音频[（(][^）)]*[）)]?/g, "口播音色与语气参考统一参考音频")
      .replace(/参考上传音频/g, "参考统一参考音频")
      .replace(/参考音频/g, "参考统一参考音频");
    const neg = "负面约束：无字幕，不生成字幕轨，不在画面上叠加任何字幕/标题/花字/文字条，不出现二维码或扫码引导，不要乱码，不要大段密集文字，不要桌面杂乱，不要使用任何 emoji。";
    if (account?.subType !== "无数字人") {
      if (!account?.charBoardAssetId && !/外貌锚点|脸型|眉毛|眼型|鼻梁|发型|参考数字人图|角色参考图/.test(out)) out += `\n\n${this._humanAppearanceAnchor(account)}`;
      if (account?.voiceRefAssetId) {
        if (!/统一参考音频|参考声线|参考音色/.test(out)) out += `\n口播音色与语气参考统一参考音频；语速自然，不要把句子压缩到听不清。`;
      } else if (!/口播声音要求|音色|语速|普通话/.test(out)) {
        out += `\n${this._voiceAnchor(account)}`;
      }
    }
    if (!/无字幕|不生成字幕|不要字幕/.test(out)) out += `\n${neg}`;
    return cleanText(out);
  },

  async _mockPrompts({ groups, account, product = null }) {
    await delay(500);
    const productName = chineseProductDisplayName(product);
    const NEG = "负面提示词：无字幕，不要在画面上叠加任何字幕/标题/花字/文字条，不要二维码或扫码引导，不要乱码，不要大段密集文字，不要夸张特效，不要复杂剧情，不要像硬广，不要人物表情僵硬，不要桌面杂乱，不要过多 UI 小字，不要使用任何 emoji。";
    const dh = account.subType !== "无数字人";
    const characterLine = account?.charBoardAssetId
      ? "角色形象以参考数字人图为准，所有出镜镜头保持同一人物、同一服装、同一发型和同一表情习惯，不重新设计角色。"
      : this._humanAppearanceAnchor(account);
    const voiceLine = account?.voiceRefAssetId
      ? "口播音色与语气参考统一参考音频；普通话清晰自然，语速中等，不要把句子压缩到听不清。"
      : this._voiceAnchor(account);
    const head = dh
      ? `@参考数字人图，@参考产品界面与logo图，这是一条${productName}产品教程短视频，9:16竖屏，时长15秒。\n${characterLine}\n${voiceLine}`
      : `@参考产品界面与logo图，这是一条${productName}产品教程短视频，9:16竖屏，时长15秒，场景/产品界面混剪，专业画外音旁白（无固定出镜人物）。`;
    const voiceKey = dh ? "口播" : "画外音";
    const defVisual = dh ? "数字人中近景，固定机位，柔和正面光，背景简洁办公桌" : "产品界面特写，缓推运镜，卡片滑入动效，浅蓝网格背景";
    const seg = (arr) => {
      const slots = ["0-3秒", "3-7秒", "7-11秒", "11-15秒"];
      return (arr.length ? arr : [{}]).slice(0, 4).map((x, j) =>
        `镜头${j + 1}｜${slots[j] || ""}｜画面：${x.visual || defVisual}；${voiceKey}：${x.line || ""}`).join("\n");
    };
    const uiOf = (arr) => arr.some(x => /UI|界面|屏幕|文件|数据|表格|卡片|演示/.test(x.visual || ""));
    const prompts = groups.map((g, i) => {
      const A = g.front.length ? g.front : g.all;
      const B = g.back.length ? g.back : g.all;
      const themeLine = `本条主题：${(account.styleProfile || account.voiceName || "真实办公教程").split("，")[0]}；场景：明亮办公桌前、暖色柔光(前后两段同一场景)；BGM：轻快办公背景乐(前后两段同一BGM)。`;
      return {
        name: `场景 ${String(i + 1).padStart(2, "0")}`,
        time: "0-15s",
        ui: uiOf(g.all),
        front: this._ensureRenderPrompt(`${head}\n${themeLine}\n${seg(A)}\n${NEG}`, account),
        back: this._ensureRenderPrompt(`${head}\n${themeLine}\n${seg(B)}\n${NEG}`, account)
      };
    });
    return { prompts };
  },

  _mockCopy({ topic, shots, account, product = null, batchVariant = null, avoidCopies = [] }) {
    const intent = inferCopyIntent({ topic, shots, account, product });
    const titles = copyTitlePool(intent, "image", batchVariant);
    let idx = Math.abs((account?.name || "").length + (topic || "").length + Number(batchVariant?.index || 0)) % titles.length;
    let out = { title: titles[idx], copy: fallbackXhsCopy({ intent, shots, account, kind: "image", batchVariant, product }) };
    if (tooSimilarCopy(out, avoidCopies)) {
      idx = (idx + 3) % titles.length;
      out = { title: titles[idx], copy: fallbackXhsCopy({ intent, shots, account, kind: "image", batchVariant: { ...batchVariant, key: "mistake-fix" }, product }) };
    }
    return {
      title: stripOwnProductMentions(out.title, product),
      copy: stripOwnProductMentions(out.copy, product)
    };
  }
};

window.XingzhenAI = AI;
window.DumateAI = AI; // 兼容旧调试入口
