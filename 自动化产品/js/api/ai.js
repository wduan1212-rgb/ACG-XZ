/* AI 生成服务（脚本 / 提示词 / 文案 / 解析）：LLM 优先，失败回退本地模板
   每次调用记录 lastSource: "llm" | "mock"，UI 据此明确标注产物来源 */

import { llm, visionCopy } from "./llm.js?v=20260720-v103-2";
import { DUMATE_BRIEF } from "./prompts.js";
import { cleanText, sanitizeProduct, stripCTA, parseJSONLoose, delay } from "../core/util.js";
import { sanitizeXhsText, sanitizeXhsObject, xhsGuardPrompt } from "../core/xhsGuard.js";
import { getCreativeMemoryContext } from "../domain/analytics.js";
import { state } from "../core/store.js";
import { PRODUCT_CATALOG_SEED, relatedProducts } from "../data/productCatalogSeed.js";
import { buildTrendGuide, buildTrendPrep } from "../data/xhsTrendLibrary.js";

const DEFAULT_XHS_IMAGE_COUNT = 4;

/* 选题"和当下结合、自然安利"指引（脚本类共用）：避免孤立自嗨、硬塞产品名。
   注：模型不能调用外部检索，这里用的是它知识里的常青热点/话题方向，不保证是今天的最新事件。 */
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
- 内容要像 AI 博主：讲清功能分工、真实场景、操作动作、结果证据、适用人群和一个小技巧。可以带 1-2 个同类/互补产品做对比或组合，但主产品能力不能写混。
- 标签组合用「品类词 + 场景词 + 流量词 + 品牌词」：例如 #AI工具 #桌面智能体 #效率工具 #自动化办公 #打工人效率。不要只写品牌词。
- 标题、正文和话题标签可以自然出现当前主产品名；如果用户主题里有竞品/同类产品名，按对比/联动关系自然处理，不要改成空泛的“AI测试”“这个工具”。竞品或互补工具名只在对比/联动主题里自然出现。
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

function stripImageRoleLabels(text = "") {
  return String(text || "")
    .replace(/([「“"'])\s*(?:封面图?|首图|入口图|内页图?\s*\d*|内容页\s*\d*|图\s*\d+|第\s*\d+\s*张)\s*[:：]\s*/g, "$1")
    .replace(/^(?:封面图?|首图|入口图|内页图?\s*\d*|内容页\s*\d*|图\s*\d+|第\s*\d+\s*张)\s*[:：]\s*/g, "")
    .replace(/([，,。；;\s])(?:封面图?|首图|入口图|内页图?\s*\d*|内容页\s*\d*|图\s*\d+|第\s*\d+\s*张)\s*[:：]\s*/g, "$1")
    .replace(/(?:画面文字|图上文案|图上文字)\s*[:：]\s*(?:封面图?|首图|入口图|内页图?\s*\d*|内容页\s*\d*)\s*[:：]\s*/g, "画面文字：")
    .replace(/\s+/g, " ")
    .trim();
}

function stripVisibleTextLabels(text = "") {
  return stripImageRoleLabels(text)
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

function ensureVideoTitleBrand(title = "", product = null) {
  const current = chineseProductDisplayName(product, "百度搭子");
  let out = replaceReferenceToolNames(title, product)
    .replace(/【\s*AI测试\s*】/gi, "")
    .replace(/AI测试/g, "AI办公")
    .replace(/\s+/g, " ")
    .trim();
  if (!out) return `${current}零门槛上手，一条讲清楚`;
  if (!out.includes(current)) {
    out = out
      .replace(/国产\s*Codex/gi, `国产${current}`)
      .replace(/这个\s*AI\s*工具/gi, current)
      .replace(/这款\s*AI\s*工具/gi, current)
      .replace(/桌面智能体/g, current)
      .replace(/AI\s*Agent/gi, current);
  }
  if (!out.includes(current)) out = `${current}：${out}`;
  return normalizeOwnProductNoise(out, current).slice(0, 34);
}

function ensureVideoBrandTags(copy = "", product = null) {
  const current = chineseProductDisplayName(product, "百度搭子");
  let out = replaceReferenceToolNames(copy, product)
    .replace(/#国产百度搭子(?=\s|$)/g, "")
    .replace(/\n{3,}/g, "\n")
    .trim();
  const tags = current === "百度搭子"
    ? ["#AI工具", "#AI提效", "#codex", "#AI办公", "#效率工具", "#百度搭子"]
    : ["#AI工具", "#AI提效", "#codex", "#AI办公", "#效率工具", `#${current}`];
  const missing = tags.filter(t => !new RegExp(escapeRegExp(t)).test(out));
  if (missing.length) {
    if (/#\S+/.test(out)) {
      out = out.replace(/((?:#[^\s#]+[ \t]*)+)$/m, (m) => `${m.trim()} ${missing.join(" ")}`.trim());
    } else {
      out += `\n${tags.join(" ")}`;
    }
  }
  return normalizeOwnProductNoise(out, current).replace(/#国产百度搭子(?=\s|$)/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

function explicitProductTags(text = "", product = null) {
  const source = cleanText(text || "");
  const tags = [];
  if (product) tags.push(`#${chineseProductDisplayName(product, "百度搭子")}`);
  [
    [/百度搭子|Dumate|DuMate/i, "#百度搭子"],
    [/秒哒|Miaoda/i, "#秒哒"],
    [/\bCodex\b/i, "#Codex"],
    [/\bObsidian\b/i, "#Obsidian"],
    [/\bWorkBuddy\b/i, "#WorkBuddy"],
    [/\bManus\b/i, "#Manus"]
  ].forEach(([pattern, tag]) => { if (pattern.test(source)) tags.push(tag); });
  return [...new Set(tags)];
}

function normalizeGeneratedEscapes(text = "") {
  return String(text || "")
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ensureImagePublishTags(copy = "", product = null, sourceText = "") {
  let out = normalizeGeneratedEscapes(copy);
  const productTags = explicitProductTags(sourceText, product);
  if (sourceText) {
    ["#百度搭子", "#秒哒", "#Codex", "#Obsidian", "#WorkBuddy", "#Manus"]
      .filter(tag => !productTags.includes(tag))
      .forEach(tag => { out = out.replace(new RegExp(`${escapeRegExp(tag)}(?=\\s|$)`, "gi"), ""); });
    out = out.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim();
  }
  const existing = [...out.matchAll(/#[^\s#]+/g)].map(match => match[0]);
  const genericTags = ["#AI办公", "#效率工具", "#工作流", "#AI工具"];
  const orderedTags = [...new Set([...productTags, ...existing])].slice(0, 7);
  genericTags.forEach(tag => {
    if (orderedTags.length < 4 && !orderedTags.includes(tag)) orderedTags.push(tag);
  });
  const body = out
    .replace(/#[^\s#]+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `${body}\n${orderedTags.join(" ")}`.trim();
}

const IMAGE_COPY_CROWD_ADDRESS_RE = /兄弟们|家人们|姐妹们|宝子们|老铁们|集美们|亲们|各位宝宝|各位宝子|朋友们/;

function assertProfessionalImageCopy(copy = "") {
  const value = normalizeGeneratedEscapes(copy);
  if (IMAGE_COPY_CROWD_ADDRESS_RE.test(value)) {
    throw new Error("图文文案含直播式群体称呼，请改为专业表达");
  }
  if (/冲就完了|闭眼入|无脑冲|绝绝子|狠狠爱了|听我一句劝/.test(value)) {
    throw new Error("图文文案含夸张直播话术，请改为可信测评表达");
  }
  return value;
}

function polishVideoBrandCopy(result = {}, product = null) {
  return {
    title: ensureVideoTitleBrand(result.title || "", product),
    copy: ensureVideoBrandTags(result.copy || "", product)
  };
}

function stripLeadingDuplicateTitle(copy = "", title = "") {
  const raw = String(copy || "").trim();
  const t = String(title || "").trim();
  if (!raw || !t) return raw;
  const norm = x => String(x || "").replace(/[#\s"'“”‘’《》「」【】\[\]（）()!！?？:：,，.。;；、~～-]/g, "").toLowerCase();
  const lines = raw.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const titleNorm = norm(t);
  while (lines.length) {
    const firstNorm = norm(lines[0]);
    if (firstNorm && (firstNorm === titleNorm || firstNorm.startsWith(titleNorm))) {
      const rest = lines[0]
        .replace(new RegExp(`^\\s*${escapeRegExp(t)}\\s*[:：,，.。!！?？-]*\\s*`), "")
        .trim();
      if (rest && norm(rest) !== titleNorm) {
        lines[0] = rest;
        break;
      }
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join("\n").replace(/^\s*[:：,，.。!！?？-]+/, "").trim();
}

function polishCopyResult(result, {
  topic,
  shots,
  account,
  kind,
  product,
  batchVariant = null,
  avoidCopies = [],
  allowSemanticFallback = true
}) {
  const intent = inferCopyIntent({ topic, shots, account, product, useAccountPosition: kind === "video" });
  let title = sanitizeProduct(String(result?.title || "").trim());
  let copy = sanitizeProduct(String(result?.copy || "").trim());
  const invalidTitle = !title
    || looksLikeRawBrief(title, topic)
    || titleConflictsWithTopic(title, topic, shots)
    || tooSimilarCopy({ title, copy: "" }, avoidCopies);
  if (invalidTitle) {
    if (!allowSemanticFallback) {
      throw new Error("模型返回的发布标题无效或与当前主题不匹配，请重试");
    }
    const pool = copyTitlePool(intent, kind, batchVariant);
    title = pool[Math.abs((topic || "").length + (shots || []).length) % pool.length];
  }
  const rawBriefCopy = /想要宣传|画面风格|不要有页码|利他性强/.test(copy);
  const invalidCopy = !copy
    || (allowSemanticFallback ? looksLikeRawBrief(copy.slice(0, 80), topic) : copy.length < 16)
    || rawBriefCopy
    || tooSimilarCopy({ title, copy }, avoidCopies);
  if (invalidCopy) {
    if (!allowSemanticFallback) {
      throw new Error("模型返回的发布文案无效或与当前标题不匹配，请重试");
    }
    copy = fallbackXhsCopy({ intent, shots, account, kind, batchVariant, product });
  }
  copy = deTemplateCopy(copy);
  title = stripOwnProductMentions(replaceReferenceToolNames(title, product), product);
  copy = stripOwnProductMentions(replaceReferenceToolNames(copy, product), product);
  copy = stripLeadingDuplicateTitle(copy, title);
  if (kind === "video") return sanitizeXhsObject(polishVideoBrandCopy({ title, copy }, product));
  return { title, copy: ensureImagePublishTags(copy, product) };
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
  const workInput = /Codex|代码|开发|应用|页面|网站/i.test(`${intent.pain} ${intent.action} ${intent.result}`)
    ? "需求描述、页面目标和修改点"
    : dataLike;
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
    `${publicScene || toolLabel}这类工具最适合接的，不是灵感问题，而是边界清楚、结果能检查的任务。`
  ];
  if (variant?.key === "real-test") openerPool.unshift(`我按真实工作流跑了一遍，最值得写的不是功能多，而是结果有没有交代清楚。`);
  if (variant?.key === "before-after") openerPool.unshift(`以前处理${dataLike}经常越理越乱，现在我会先把它们拆成能检查的几类。`);
  if (variant?.key === "one-person-team") openerPool.unshift(`一个人干活最怕的不是任务多，是每个任务都要从零开始组织。`);
  const opener = choose(openerPool, 2);
  const forms = [
    `${opener}\n\n${method}\n\n${detail}\n\n最后一定留一个人工复核动作：检查字段有没有漏、分类是不是合理、结果能不能回到原资料。这个动作不酷，但它决定内容有没有含金量。`,
    `${opener}\n\n我的习惯是先把"要它做什么"写成一句完整任务，而不是直接丢一句帮我整理。比如${workInput}、目标字段、输出格式这三件事，少一个都会让结果变虚。\n\n${method}\n\n所以这类工具不是替你判断全部事情，更像把重复动作先压下去，让人把注意力留给最后的判断。`,
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
  const current = chineseProductDisplayName(product, "百度搭子");
  let out = normalizeOwnProductNoise(sanitizeProduct(String(text || "")), current);
  ownProductAliases(product).forEach(alias => {
    out = replaceOwnProductAlias(out, alias, current);
  });
  out = out
    .replace(/#(?:百度搭子|百度秒哒|Dumate|DuMate|秒哒|搭子)\b/gi, `#${current}`)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalizeOwnProductNoise(out, current);
}

function baseProductFacts(product) {
  return isDumateProduct(product) ? DUMATE_BRIEF + "\n\n" : "";
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

async function resolveTrendPrep({ topic = "", account = {}, product = null, batchVariant = null, useOnlineTrends = false, kind = "image", imageCount = DEFAULT_XHS_IMAGE_COUNT, seed = "" } = {}) {
  return buildTrendPrep({ topic, account, product, batchVariant, onlineItems: [], useOnlineTrends: false, kind, imageCount, seed });
}

async function resolveTrendGuide({ topic = "", account = {}, product = null, batchVariant = null, useOnlineTrends = false, kind = "image", imageCount = DEFAULT_XHS_IMAGE_COUNT, seed = "" } = {}) {
  const prep = await resolveTrendPrep({ topic, account, product, batchVariant, useOnlineTrends: false, kind, imageCount, seed });
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

function productAliasReplacementRegex(alias = "", current = "") {
  const raw = String(alias || "").trim();
  if (!raw || raw === current) return null;
  const escaped = escapeRegExp(raw);
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(raw)) {
    return { re: new RegExp(`(^|[^a-z0-9._-])${escaped}([^a-z0-9._-]|$)`, "gi"), edge: "ascii" };
  }
  if (current && current.includes(raw) && raw.length < current.length) {
    return { re: new RegExp(`(^|[^\\u4e00-\\u9fa5A-Za-z0-9])${escaped}(?=$|[^\\u4e00-\\u9fa5A-Za-z0-9])`, "g"), edge: "prefix" };
  }
  return { re: new RegExp(escaped, "g"), edge: "plain" };
}

function replaceOwnProductAlias(text = "", alias = "", current = "百度搭子") {
  const spec = productAliasReplacementRegex(alias, current);
  if (!spec) return text;
  const { re, edge } = spec;
  let out = String(text || "");
  if (edge === "ascii") {
    out = out.replace(re, (m, a = "", b = "") => `${a || ""}${current}${b || ""}`);
  } else if (edge === "prefix") {
    out = out.replace(re, (m, a = "") => `${a || ""}${current}`);
  } else {
    out = out.replace(re, current);
  }
  return normalizeOwnProductNoise(out, current);
}

function normalizeOwnProductNoise(text = "", current = "百度搭子") {
  let out = String(text || "");
  if (current === "百度搭子") {
    out = out
      .replace(/(?:\d+\s*)?百度(?:\d+|百度|搭子){1,10}搭子?/g, "百度搭子")
      .replace(/(?:\d+\s*)?百度(?:\d+\s*)?百度(?:\s*)搭子/g, "百度搭子")
      .replace(/(?:\d+\s*)?百度(?:\d+\s*)?搭子/g, "百度搭子")
      .replace(/\d*百度\d*(?:百度)+搭子/g, "百度搭子")
      .replace(/百度(?:百度)+搭子/g, "百度搭子")
      .replace(/百度搭子(?:搭子)+/g, "百度搭子")
      .replace(/百度搭子(?:百度搭子)+/g, "百度搭子");
  }
  if (current) {
    const escaped = escapeRegExp(current);
    out = out
      .replace(new RegExp(`(?:${escaped}[!！~～、，,。\\s]*){2,}`, "g"), current)
      .replace(new RegExp(`${escaped}(?:\\s*${escaped})+`, "g"), current)
      .replace(new RegExp(`(${escaped})和\\1`, "g"), `${current}和同类工具`)
      .replace(new RegExp(`(${escaped})\\+\\1`, "g"), `${current}+同类工具`);
  }
  return out
    .replace(/([！!？?~～。])\1+/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function replaceReferenceToolNames(text = "", product = null) {
  const current = chineseProductDisplayName(product, "百度搭子");
  let out = sanitizeOwnProductForGeneratedText(String(text || ""));
  const competitors = [
    /OpenAI\s+Codex/gi,
    /\bCodex\b/gi,
    /\bWorkBuddy\b/gi,
    /\bManus\b/gi,
    /Claude\s+Code/gi,
    /\bCursor\b/gi,
    /\bCopilot\b/gi,
    /\bOpenClaw\b/gi
  ];
  competitors.forEach(re => { out = out.replace(re, current); });
  return normalizeOwnProductNoise(out, current);
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

function copyProductBrief(product) {
  const p = product || {};
  const label = genericProductLabel(p);
  const name = chineseProductDisplayName(p, label);
  const features = (p.coreFeatures || [])
    .filter(Boolean)
    .map(x => sanitizeProduct(x))
    .slice(0, 4)
    .join(" / ");
  const brief = sanitizeProduct(p.brief || "");
  return `【发布文案轻量产品事实】
当前主产品：${name}。标题、正文和标签可以自然出现当前主产品名；如果用户主题里有同类/竞品产品名，按对比、联动或替换关系自然处理。
品类指代：${label}、AI工具、桌面智能体、这个工具。
可用事实：${features || brief || "按用户创作需求和图卡内容写，不编造未确认能力。"}
优先级：用户创作需求 > 发布文案 > 图卡脚本 > 产品事实校准。产品事实只用于纠错和补充边界，不允许覆盖用户主题。`;
}

function imagePromptProductBrief(product) {
  const p = product || {};
  const name = chineseProductDisplayName(p, genericProductLabel(p));
  const label = genericProductLabel(p);
  const features = (p.coreFeatures || [])
    .filter(Boolean)
    .map(x => sanitizeProduct(x))
    .slice(0, 2)
    .join(" / ");
  return `【图片提示词轻量产品校准】
当前主产品：${name}。
品类：${label}。
可用事实：${features || "仅用于校准主产品，不参与选题发散。"}
硬规则：图片内容只跟最终发布标题、正文、标签一致；产品资料库、竞品关系、账号定位、历史模板都不能改写本次图片主题。`;
}

function copyAccountVoice(account = {}, style = "", topic = "") {
  const raw = sanitizeXhsText(cleanText([
    style,
    account?.voiceName,
    account?.tone,
    account?.styleProfile
  ].filter(Boolean).join("；")));
  if (!raw) return "真实使用、口语但有信息量";
  let out = raw
    .replace(/(?:正文结构建议固定为|发布结构|固定栏目|每篇建议|第一张负责|2[-－~—到至]\s*5\s*张|最后一张|封面建议|标题建议|图卡结构建议)[：:][^。；\n]*(?:[。；\n]|$)/g, " ")
    .replace(/(?:正文结构建议固定为|发布结构|固定栏目|每篇建议|第一张负责|最后一张)[^。；\n]*(?:[。；\n]|$)/g, " ")
    .replace(/(?:账号定位|定位)[：:][^。；\n]*(?:[。；\n]|$)/g, " ");
  if (!/Obsidian|知识库|笔记|资料|文件|表格|周报|会议/i.test(topic || "")) {
    out = out.replace(/[^。；\n]*(?:Obsidian|知识库|资料沉淀|资料库|固定流程|SOP|流程卡|文件夹)[^。；\n]*(?:[。；\n]|$)/gi, " ");
  }
  out = cleanText(out)
    .replace(/[；;]{2,}/g, "；")
    .replace(/^[；;，,\s]+|[；;，,\s]+$/g, "");
  return shortChinese(out || account?.tone || "真实使用、口语但有信息量", 120);
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
  return "负面约束：无字幕，不生成花字，不生成水印，不生成二维码。";
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
  return `${head}\n\n${neg || videoNegative()}`.slice(0, maxLen);
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

const INTERNAL_IMAGE_LABEL_RE = /(封面|首图|内页\d*|内容页|痛点引入|问题引入|解决路径|关键步骤|结果对比|总结收束|收束|图片任务|第\d+\/\d+张|第\d+张|图\d+)/g;
const IMAGE_PLANNING_WORD_RE = /(种草|种草感|构图|版式|画面定位|图片定位|内页\d*|内容页|开头钩子|钩子|共鸣场景|共鸣|痛点|痛点引入|问题引入|解决路径|关键步骤|结果对比|总结收束|自然收束|收束|封面|首图|图片任务|核心思想|视觉线索|提示词|文案|截图|图上文字|干货步骤|步骤[一二三四五六七八九十\d]*)/g;
const BAD_IMAGE_HEADLINE_RE = /^(图\d+|第\d+张|内页\d*|内容页|干货步骤|核心思想|画面|版式|构图|文案|截图|提示词|视觉线索|封面|首图|种草|共鸣|痛点|痛点引入|问题引入|解决路径|关键步骤|结果对比|总结收束|自然收束|收束|图片任务|步骤[一二三四五六七八九十\d]*|一眼想点开|吸引点击|点击入口)|想要宣传|不要有页码|利他性强|账号定位|参考图|整体的画面|图\d+\s*[·.-]\s*干货步骤|[｜|<>]/;

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

function cleanGeneratedHeadlineNoise(text = "", product = null, max = 48) {
  const current = chineseProductDisplayName(product, "百度搭子");
  let out = normalizeOwnProductNoise(cleanImagePlanningWords(stripVisibleTextLabels(text || "")), current)
    .replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/g, "")
    .replace(/[，,。；;、\s]+$/g, "")
    .trim();
  if (!out) return "";
  out = out.replace(/\d+\s*分钟学会(?:(?!\d+\s*分钟学会)[^！!？?。；;，,~～]){2,28}(?=\d+\s*分钟学会)/g, "");
  const tutorial = out.match(/\d+\s*分钟学会.{0,38}?(?:终级教程|终极教程|教程)[~～]?/);
  const locked = tutorial?.[0] && tutorial[0].length >= 8;
  if (locked) {
    out = tutorial[0];
  } else {
    ["40分钟学会", "30分钟学会", "一篇讲清楚", "零基础"].forEach(marker => {
      const first = out.indexOf(marker);
      const second = first >= 0 ? out.indexOf(marker, first + marker.length) : -1;
      if (second > 0) out = out.slice(0, second);
    });
    const firstProduct = current ? out.indexOf(current) : -1;
    const secondProduct = firstProduct >= 0 ? out.indexOf(current, firstProduct + current.length) : -1;
    if (secondProduct > 0 && secondProduct <= max + 12) out = out.slice(0, secondProduct);
  }
  out = normalizeOwnProductNoise(out, current)
    .replace(/[，,。；;、\s]+$/g, "")
    .trim();
  return out.length > max ? completeImageText(out, max) : out;
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
    .replace(/(?:封面图?|首图|入口图|内页图?\s*\d*|内页\s*\d*|内容页\s*\d*|图\s*\d+|第\s*\d+\s*张|痛点引入|问题引入|解决路径|关键步骤|结果对比|总结收束|收束)[:：·｜|\s-]*/g, "")
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
  const raw = sanitizeOwnProductForGeneratedText(copy?.title || copy?.headline || "");
  const title = cleanGeneratedHeadlineNoise(raw, product, 48);
  if (!title || BAD_IMAGE_HEADLINE_RE.test(title.slice(0, 24))) return "";
  return title;
}

function imageThemeAnchor(ctx = {}) {
  const title = copyTitleForImagePlanning(ctx.copy, ctx.product)
    || cleanImageDisplayTitle(ctx.topic || ctx.script || "", "", 42);
  const raw = stripPromptScaffold(cleanText(copyTextForImagePlanning(ctx.copy) || ctx.topic || ctx.script || ""));
  const body = raw
    .replace(title || "", "")
    .replace(/#[^\s#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = body
    .split(/[。！？!?；;\n]+/)
    .map(x => cleanImagePromptSignal(x, 48))
    .find(x => x && !isStyleOnlyCue(x));
  // 只从用户最终文案提炼当前内容，不再用关键词映射成固定办公案例。
  const cue = sentence || cleanImagePromptSignal(body, 72) || title || "";
  const line = cue ? `主题内容：${cue}。` : title ? `主题内容：${completeImageText(title, 48)}。` : "";
  return { title, cue, line };
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
  const relationMode = /对比|vs|VS|区别|分工|边界|相比|测评|联动|组合|\+/.test(src);
  const inferredMain = `${inferred.audience}${inferred.pain.replace(/^(.{2,8})?太/, "").replace(/太/g, "")}`;
  const relationMain = relationMode && relationTools.length
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
  const relationTools = /对比|vs|VS|区别|分工|边界|相比|测评|联动|组合|\+/.test(raw)
    ? productsMentionedIn(raw, ctx.product, 2)
    : [];
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
    : /工作流|流程|自动化/.test(raw)
      ? [
        "20个自动化工作流清单",
        "每个流程对应一个真实场景",
        "输入材料动作结果分清楚",
        "可复用模板统一沉淀",
        "先跑小流程再扩展",
        "把重复动作交给流程"
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

function copyContentBeats(title = "", body = "", n = DEFAULT_XHS_IMAGE_COUNT) {
  const count = Math.max(1, Math.min(12, Number(n) || DEFAULT_XHS_IMAGE_COUNT));
  const cleanTitle = stripVisibleTextLabels(cleanText(normalizeGeneratedEscapes(title))).trim();
  const cleanBody = stripVisibleTextLabels(cleanText(normalizeGeneratedEscapes(body)))
    .replace(/#[^\s#]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const sentences = cleanBody
    .replace(/\n+/g, "。")
    .split(/[。！？!?；;]+/)
    .map(x => x.replace(/^[①②③④⑤⑥⑦⑧⑨⑩\d.)、\s]+/, "").trim())
    .filter(x => x.length >= 4)
    .flatMap(sentence => sentence.length > 90
      ? sentence.split(/[，,：:]/).map(x => x.trim()).filter(x => x.length >= 6)
      : [sentence]);
  const bodyCore = sentences.join("；") || cleanBody || cleanTitle;
  if (count === 1) return [`标题「${cleanTitle}」；图片内容：${bodyCore}`.trim()];

  const beats = [`主标题「${cleanTitle}」；短副标题概括「${completeImageText(bodyCore, 64)}」`];
  const slots = count - 1;
  const expansionLenses = ["核心判断", "真实场景", "具体动作", "执行步骤", "结果变化", "适用边界", "常见误区", "结论复盘", "可直接照做的要点", "前后对照", "使用提醒"];
  for (let i = 0; i < slots; i++) {
    const start = Math.floor(i * Math.max(1, sentences.length) / slots);
    const end = Math.max(start + 1, Math.floor((i + 1) * Math.max(1, sentences.length) / slots));
    const assigned = sentences.slice(start, end).join("；")
      || sentences[Math.min(i, sentences.length - 1)]
      || bodyCore;
    const lens = expansionLenses[i % expansionLenses.length];
    beats.push(sentences.length >= slots
      ? completeImageText(assigned, 150)
      : `${lens}视角：${completeImageText(assigned, 120)}`);
  }
  return beats;
}

function stripImagePlanningInstructions(text = "") {
  return normalizeGeneratedEscapes(text)
    .replace(/围绕正文分配信息「([^」]+)」设计一张强相关静态图[^。；;]*[。；;]?/g, "画面核心内容：「$1」。")
    .replace(/本张只展开「([^」]+)」[^。；;]*[。；;]?/g, "画面核心内容：「$1」。")
    .replace(/只基于正文信息「([^」]+)」换一个表达角度展开[^。；;]*/g, "$1")
    .replace(/正文第\d+部分[:：]/g, "")
    .replace(/信息密度按[^。；;]+[。；;]?/g, "")
    .replace(/不重复封面[^。；;]*[。；;]?/g, "")
    .replace(/也不提前讲后续内容[^。；;]*[。；;]?/g, "")
    .replace(/不加入正文外的办公案例或产品知识[^。；;]*[。；;]?/g, "")
    .replace(/\s+/g, " ")
    .replace(/([。；;])\1+/g, "$1")
    .trim();
}

function innerCardDensityVisual(beat = "") {
  const core = completeImageText(stripImagePlanningInstructions(beat), 160) || "当前正文要点";
  return `画面以「${core}」作为核心结论，下方排布 2—4 个层级分明的信息模块，分别呈现这段正文已有的具体动作、判断依据、证据、结果或适用边界；模块标题具体，关键词高亮，信息量明显高于封面但字号保持可读。`;
}

function promptMatchesAssignedCopy(prompt = "", beat = "", title = "") {
  const haystack = cleanText(prompt || "").toLowerCase();
  const source = cleanText(`${title} ${beat}`)
    .replace(/[的了和是在把与及或一个这那为用从到中上下来]+/g, " ")
    .toLowerCase();
  const latin = source.match(/[a-z][a-z0-9._+-]{2,}/g) || [];
  const chinese = (source.match(/[\u4e00-\u9fa5]{2,}/g) || [])
    .flatMap(word => word.length <= 6 ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)))
    .filter(word => word.length >= 2);
  return [...new Set([...latin, ...chinese])].some(token => haystack.includes(token));
}

function imageDensityMode(ctx = {}) {
  const raw = stripPromptScaffold(cleanText(copyTextForImagePlanning(ctx.copy) || ctx.script || ctx.topic || ""));
  if (raw.length < 42) return "sparse";
  if (raw.length > 180) return "dense";
  return "balanced";
}

function simpleRelationVisual(ctx = {}) {
  const text = copyTextForImagePlanning(ctx.copy) || [ctx.script, ctx.topic].filter(Boolean).join(" ");
  if (!/对比|vs|VS|区别|分工|边界|相比|测评|联动|组合|\+/.test(text)) return "";
  const mentioned = productsMentionedIn(text, ctx.product, 2);
  if (!mentioned.length) return "";
  const main = chineseProductDisplayName(ctx.product, "百度搭子");
  const other = productDisplayName(mentioned[0], "同类工具");
  const connector = /对比|vs|VS|区别|相比|测评/.test(text) ? "VS" : "+";
  return `${other}与${main}两个标识作为主视觉，中间用「${connector}」或箭头表达关系。`;
}

function conciseRelationLine(ctx = {}, item = {}) {
  const copyText = copyTextForImagePlanning(ctx.copy);
  const authoritative = copyText || [ctx.script, ctx.topic].filter(Boolean).join(" ");
  if (!/对比|vs|VS|区别|分工|边界|相比|测评|联动|组合|\+/.test(authoritative)) return "";
  const explicit = productsMentionedIn(authoritative, ctx.product, 2);
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
  const theme = imageThemeAnchor(ctx);
  const lightStyle = isLightIllustrationStyle(ctx);
  const density = imageDensityMode(ctx);
  const isCover = i === 0;
  const fullCoverTitle = isCover ? (copyTitleForImagePlanning(ctx.copy, ctx.product) || theme.title || "") : "";
  const canDense = promptCanBeDense(ctx, item);
  const localCueRaw = imageBeatCue(item, { ...ctx, topic: "", script: "", beat: "" }, lightStyle ? 32 : canDense ? 42 : 36);
  const styleText = cleanText(ctx.style || ctx.account?.styleProfile || "");
  const localCue = isStyleOnlyCue(localCueRaw) || (localCueRaw && styleText.includes(localCueRaw)) ? "" : localCueRaw;
  const themeCue = theme.cue || "";
  const localExpansion = localCue && themeCue && localCue !== themeCue && !themeCue.includes(localCue) && !localCue.includes(themeCue)
    ? `${themeCue}；本张展开：${localCue}`
    : themeCue || localCue;
  const cue = isCover
    ? fullCoverTitle || coverBeatText(item, ctx, intent)
    : localExpansion || completeImageText(ctx.beat || "", canDense ? 42 : 36);
  const oneBeat = cue || themeCue || intent.main;
  const contentCue = isCover
    ? `围绕「${oneBeat}」做大字标题页，画面留白。`
    : lightStyle
    ? `${innerCardDensityVisual(oneBeat)}用小人动作、表情、气泡和箭头分别解释信息模块。`
    : canDense
      ? `${innerCardDensityVisual(oneBeat)}用文档、表格或结果卡承载具体信息。`
      : density === "sparse"
        ? `${innerCardDensityVisual(oneBeat)}优先把原文中的例子、动作和结果做成短卡片。`
        : `${innerCardDensityVisual(oneBeat)}用流程、对照或清单关系组织这些信息。`;
  const title = fullCoverTitle || cleanImageDisplayTitle(stripInternalImageLabels(item?.title || ""), task.title);
  const relationCover = isCover && simpleRelationVisual(ctx);
  let headlineRaw = fullCoverTitle || (relationCover ? intent.main : deriveImageHeadline(item, i, intent, task));
  if (!isCover && IMAGE_CARD_TASKS.some(t => t.title === headlineRaw) && oneBeat) headlineRaw = oneBeat;
  const cleanHeadline = cleanImageDisplayTitle(stripInternalImageLabels(headlineRaw), "");
  const headline = fullCoverTitle || completeImageText(cleanHeadline || headlineRaw, isCover ? 48 : canDense ? 40 : 36);
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
    ? "顶部清楚标题+中央简笔画小人+2—4个气泡信息模块"
    : canDense
      ? "大标题+2—4个局部文档/表格/结果卡片，信息分层清楚"
      : "大标题+2—4个动作、证据、结果或边界信息卡";
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
  const themeLine = theme.line ? `${theme.line}` : "";
  const promptBody = cleanImagePlanningWords(isCover
    ? `${refPrefix}3:4竖版图片。${themeLine}${productLine}${layoutLine}；${visualLine}；${textLine}视觉风格：${imageStyle}。`
    : lightStyle
    ? `${refPrefix}3:4竖版图片。${themeLine}${productLine}${layoutLine}；${contentCue}${textLine}视觉风格：${imageStyle}。`
    : `${refPrefix}3:4竖版图片。${themeLine}${productLine}${layoutLine}；${visualLine}；${contentCue}${textLine}视觉风格：${imageStyle}。`);
  return {
    title,
    ui: item?.ui !== false,
    prompt: normalizeImageSizeText(stripVisibleTextLabels(sanitizeOwnProductForGeneratedText(`${promptBody}${minimalImageNegative()}`)))
  };
}

function normalizeImagePromptItems(items, ctx) {
  const n = Math.max(1, Math.min(12, Number(ctx.imageCount) || (items || []).length || DEFAULT_XHS_IMAGE_COUNT));
  const src = Array.isArray(items) ? items : [];
  const beats = splitImageBeats(ctx, n);
  return Array.from({ length: n }, (_, i) => richImagePrompt(src[i] || {}, i, n, { ...ctx, beat: beats[i] }));
}

function normalizeCopyDrivenImagePromptItems(items, ctx) {
  const n = Math.max(1, Math.min(12, Number(ctx.imageCount) || (items || []).length || DEFAULT_XHS_IMAGE_COUNT));
  const src = Array.isArray(items) ? items : [];
  const copyTitle = stripVisibleTextLabels(cleanText(normalizeGeneratedEscapes(ctx.copy?.title || ctx.copy?.headline || ""))).trim();
  const copyBody = cleanText(normalizeGeneratedEscapes(ctx.copy?.body || ctx.copy?.copy || "")).trim();
  const beats = Array.isArray(ctx.contentBeats) && ctx.contentBeats.length
    ? ctx.contentBeats.slice(0, n)
    : copyContentBeats(copyTitle, copyBody, n);
  const style = compactImageStyle(ctx.style || ctx.account?.styleProfile || "白底或浅色底，清晰层级，大留白", 32);
  return Array.from({ length: n }, (_, i) => {
    const item = src[i] || {};
    const beat = completeImageText(stripImagePlanningInstructions(beats[i] || copyTextForImagePlanning(ctx.copy) || ctx.topic || "本次文案内容"), 180);
    const title = i === 0 && copyTitle
      ? cleanImageDisplayTitle(copyTitle, copyTitle.slice(0, 36), 56)
      : cleanImageDisplayTitle(item.title || item.headline || beat, beat.slice(0, 36));
    const raw = stripImagePlanningInstructions(stripPromptScaffold(String(item.prompt || "")
      .replace(/负面约束\s*[:：][\s\S]*$/g, "")
      .replace(/【图片提示词轻量产品校准】[\s\S]*$/g, "")
      .trim()));
    const related = promptMatchesAssignedCopy(raw, beat, i === 0 ? copyTitle : "");
    const generatedContent = related
      ? raw
      : `画面直接呈现「${beat}」，用与这段信息对应的主体、动作、界面或数据结果完成表达。`;
    const anchor = i === 0 && copyTitle
      ? `主标题完整显示「${copyTitle}」，简洁低噪点背景，单一强主视觉带明显纵深感。`
      : "";
    const density = i === 0 ? "" : innerCardDensityVisual(beat);
    const content = stripImagePlanningInstructions(`${anchor}${generatedContent}${density}`);
    const prefix = ctx.styleRefName ? `请根据上传的参考图（${ctx.styleRefName}）的视觉语言。` : "";
    const prompt = `${prefix}3:4竖版图片。${content}${style ? `视觉风格：${style}。` : ""}`;
    return {
      title,
      ui: item.ui !== false,
      prompt: normalizeImageSizeText(`${prompt}${minimalImageNegative()}`)
    };
  });
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
  if (total === 1) {
    return {
      idea: cleanText(topic || "本次主题").slice(0, 30),
      visual: `一张有序信息图：上部强标题，中部用三个简洁动作或证据卡讲清主题，下部以一条可复用结论收束，画面层级清楚且不出现页码或内页字样`,
      line: cleanText(topic || "把关键动作排成一张图").slice(0, 30)
    };
  }
  if (total === 2 && i === 1) {
    return {
      idea: "关键动作和结果",
      visual: `第二张干货信息图：以具体操作、证据或结果卡展开主题，信息密度高于首图但保持文字可读和层级清楚`,
      line: "把关键动作和结果讲清楚"
    };
  }
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
  const want = image ? Math.max(1, Math.min(12, Number(imageCount) || DEFAULT_XHS_IMAGE_COUNT)) : Math.max(1, (d.shots || []).length);
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

function cleanCustomVideoText(text = "", { stripTags = false, title = "" } = {}) {
  let out = sanitizeXhsText(cleanText(String(text || "")))
    .replace(/[「」]/g, "")
    .replace(/翻墙/g, "跨网络访问")
    .replace(/科学上网/g, "跨网络访问")
    .replace(/魔法上网/g, "跨网络访问")
    .replace(/VPN/gi, "网络环境")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (stripTags) out = out.replace(/#[^\s#]+/g, " ").replace(/[ \t]+/g, " ").trim();
  const titleNorm = normalizeForDedupe(title);
  if (titleNorm) {
    const lines = out.split(/\n+/).map(x => x.trim()).filter(Boolean);
    while (lines.length && normalizeForDedupe(lines[0]).startsWith(titleNorm)) {
      const rest = lines[0]
        .replace(new RegExp(`^\\s*${String(title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[，,。.!！?？:：-]*\\s*`), "")
        .trim();
      if (rest && normalizeForDedupe(rest) !== titleNorm) {
        lines[0] = rest;
        break;
      }
      lines.shift();
    }
    out = lines.join("\n").trim();
  }
  return out.replace(/[“”]/g, "\"").trim();
}

/*
 * 信息流导演稿是视频模型的执行指令，不是直接发布的小红书正文。
 * 这里只做无损文本整理，避免内容合规替换把“第一扇门 / 电话亭”等
 * 正常画面改成别的词，破坏已经生成好的创意与镜头语义。
 */
function cleanInfoFlowDirectorText(text = "", { stripTags = false } = {}) {
  let out = String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (stripTags) out = out.replace(/#[^\s#]+/g, " ").replace(/[ \t]+/g, " ").trim();
  return out;
}

function withSharedInfoFlowStyle(prompt = "", style = "") {
  const fallback = "超写实商业广告质感，自然电影光影，真实材质，统一色彩与镜头语言";
  const sharedStyle = cleanInfoFlowDirectorText(style || fallback, { stripTags: true })
    .replace(/[。；;,，\s]+$/g, "")
    .trim() || fallback;
  const body = cleanInfoFlowDirectorText(prompt, { stripTags: true })
    .replace(/^(?:\s*(?:统一)?画面风格\s*[:：][^\n]*(?:\n|$))+/i, "")
    .trim();
  return `统一画面风格：${sharedStyle}。${body ? `\n${body}` : ""}`;
}

function parseCustomVideoDraftText(content = "", fallbackTitle = "") {
  const raw = String(content || "").replace(/\r/g, "").trim();
  if (!raw) throw new Error("模型无有效返回");
  try {
    const d = sanitizeXhsObject(parseJSONLoose(raw));
    if (d && (d.copy || d.narration)) return d;
  } catch (_) {
    // Thinking models can return good prose that is fragile as JSON; use sections.
  }
  const text = raw
    .replace(/^\s*[-#*\d.、\s]*(?:结果|输出)[:：]\s*/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const labels = {
    title: "(?:标题|发布标题|title)",
    copy: "(?:发布文案|平台文案|正文|copy)",
    narration: "(?:口播|口播稿|口播内容|narration)",
    visualPrompt: "(?:分镜提示|分镜图提示|视觉提示|画面提示|visualPrompt|visual)"
  };
  const allLabels = Object.values(labels).join("|");
  const pick = key => {
    const re = new RegExp(`(?:^|\\n)\\s*(?:${labels[key]})\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:${allLabels})\\s*[:：]|$)`, "i");
    return (text.match(re)?.[1] || "").trim();
  };
  const parsed = {
    title: pick("title") || fallbackTitle,
    copy: pick("copy"),
    narration: pick("narration"),
    visualPrompt: pick("visualPrompt")
  };
  if (!parsed.copy || !parsed.narration) {
    throw new Error("模型未按标题/发布文案/口播/画面提示四段返回");
  }
  return parsed;
}

const INFO_FLOW_BANNED_LINES = [
  "这不是一个需求，这是来拆我的",
  "别再给我加需求了",
  "字很多，但完全不能用"
];

function infoFlowSimilarity(left = "", right = "") {
  const normalize = value => String(value || "").toLowerCase().replace(/[^\u4e00-\u9fffa-z0-9]+/g, "");
  const tokens = value => {
    const text = normalize(value);
    const set = new Set();
    for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
    return set;
  };
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  a.forEach(token => { if (b.has(token)) overlap++; });
  return overlap / Math.max(1, a.size + b.size - overlap);
}

function parseInfoFlowCreativePlan(content = "") {
  const raw = parseJSONLoose(content);
  const front = raw.frontPrompt || raw.front?.videoPrompt || raw.front?.prompt || raw.segments?.[0]?.videoPrompt || raw.segments?.[0]?.prompt || "";
  const back = raw.backPrompt || raw.back?.videoPrompt || raw.back?.prompt || raw.segments?.[1]?.videoPrompt || raw.segments?.[1]?.prompt || "";
  return {
    creativeAngle: cleanInfoFlowDirectorText(raw.creativeAngle || raw.angle || raw.front?.creativeAngle || "全新信息流创意", { stripTags: true }),
    visualStyle: cleanInfoFlowDirectorText(raw.visualStyle || raw.style || raw.front?.visualStyle || "超写实商业广告质感，自然电影光影，真实材质，统一色彩与镜头语言", { stripTags: true }),
    frontPrompt: cleanInfoFlowDirectorText(front, { stripTags: true }),
    backPrompt: cleanInfoFlowDirectorText(back, { stripTags: true })
  };
}

function assertInfoFlowCreativePlan(plan, previousPrompts = []) {
  const combined = `${plan.frontPrompt}\n${plan.backPrompt}`;
  const normalizedCombined = combined.replace(/[^\u4e00-\u9fff]+/g, "");
  if (!plan.frontPrompt || !plan.backPrompt) throw new Error("模型未返回完整的 A/B 面视频提示词");
  if (plan.frontPrompt.length < 240 || plan.backPrompt.length < 220) throw new Error("信息流提示词细节不足，请重新创作");
  if (INFO_FLOW_BANNED_LINES.some(line => normalizedCombined.includes(line.replace(/[^\u4e00-\u9fff]+/g, "")))) throw new Error("信息流仍含固定模板台词，请重新创作");
  const timedFront = (plan.frontPrompt.match(/\d+\s*[-—–~至]\s*\d+\s*(?:s|秒)/gi) || []).length;
  const timedBack = (plan.backPrompt.match(/\d+\s*[-—–~至]\s*\d+\s*(?:s|秒)/gi) || []).length;
  if (timedFront < 4 || timedBack < 4) throw new Error("信息流提示词缺少完整的分时镜头设计");
  if (infoFlowSimilarity(plan.frontPrompt, plan.backPrompt) > 0.62) throw new Error("A/B 面内容过于雷同，请重新创作");
  if ((previousPrompts || []).some(prev => infoFlowSimilarity(combined, prev) > 0.68)) throw new Error("新提示词与上一版过于相似，请重新创作");
  return plan;
}

export const AI = {
  lastSource: "mock",
  lastError: "",

  _ok(d) { this.lastSource = "llm"; this.lastError = ""; return d; },
  _fb(e) { this.lastSource = "mock"; this.lastError = (e && e.message) || String(e || "网络/CORS"); },

  sourceNote(okMsg) {
    if (/^llm(?:$|-)/.test(this.lastSource || "")) return okMsg;
    const err = this.lastError || "网络/CORS";
    const apiLike = /未配置|api.?key|authorization|401|403|鉴权|认证|unauthorized|forbidden/i.test(err);
    const fallbackNote = this.lastSource === "mock" ? "，已用本地模板" : "";
    return `${apiLike ? "语言模型接口未接通" : "模型生成未完成"}（${err}）${fallbackNote}`;
  },

  memoryLine(account) {
    const ctx = getCreativeMemoryContext({ account, platform: account?.platform });
    return ctx ? "\n\n" + ctx + "\n生成时优先吸收这些经过数据验证的规则，但不要生硬复述。" : "";
  },

  /* ---------- 素材号长视频脚本（60s+，有深度/有梗、利他，画外音后期配；每镜头标 ui/scene） ---------- */
  async generateMaterialScript({ topic, account, style = "", product = null }) {
    const sys = `你是百度 ACG 市场部资深长视频编剧，为指定产品写【素材号】视频脚本：没有固定出镜人物，画面全部由场景/产品界面/实拍素材混剪而成。line 是口播或旁白内容参考。

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
    const hasHardNeg = /无字幕|不生成字幕|不要字幕/.test(prompt) && /不生成花字|不要花字/.test(prompt) && /不生成水印|不要水印|无水印/.test(prompt) && /不生成二维码|不要二维码|无二维码/.test(prompt);
    const hasMetaText = /主体设定|角色设定|参考脚本|旁白含义|镜头依据|账号定位参考|账号背景参考|声线锚点|<[^>]+>/.test(prompt);
    const duplicateNeg = ((prompt.match(/负面约束/g) || []).length > 1) || (/无口播|无人声|无\s*BGM|无多余音效/.test(prompt.slice(0, 260)) && /负面约束/.test(prompt));
    const wrongNarrationNeg = /无口播|不要口播|无人声|无\s*BGM|不要\s*BGM|无多余音效|无音效/.test(prompt);
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

  /* ---------- 创作内容补全：只扩写用户明确输入，不替用户选择主题 ---------- */
  async generateCreativeBrief({ account, product = null, imageCount = DEFAULT_XHS_IMAGE_COUNT, userText = "", kind = "image", useOnlineTrends = false, trendGuide = "", trendPrep = null }) {
    const p = product || allProductsForAI().find(x => x.owner === "ours") || null;
    const rel = relatedProducts(p, allProductsForAI(), 5);
    const count = Math.max(1, Math.min(12, Number(imageCount) || DEFAULT_XHS_IMAGE_COUNT));
    const rawUserText = sanitizeXhsText(cleanText(userText || ""));
    if (!rawUserText) throw new Error("请先填写发布标题或创作内容");
    if (rawUserText.length <= 80) return this._ok(rawUserText);
    try {
      const accountVoice = copyAccountVoice(account, "", rawUserText);
      const content = await llm([
        { role: "system", content: copyProductBrief(p) + `\n\n你负责把用户已经明确填写的标题或创作内容整理成可执行 brief。用户输入是唯一主题，不得另选题、换题或从账号资料推断内容方向。只输出 JSON：{"brief":"..."}。` },
        { role: "user", content: `${currentProductLine(p)}
账号：${account?.name || "未命名账号"}
${kind === "video" ? `账号创作风格：${accountVoice}` : `账号创作风格：${accountVoice}`}
内容形态：${kind === "video" ? "视频口播脚本" : `小红书图文，计划 ${count} 张图卡`}
用户已写标题/创作内容：${rawUserText}
可参考/可组合的同类工具：
${productRelationLine(rel.slice(0, 2))}

写作规则：
1. 必须服从用户标题/内容，不得改成另一个主题。
2. 只有用户输入明确提到同类工具时，才解释分工、对比或组合；不能自行植入。
3. brief 要具体到能直接拆图/拆脚本，并且所有事实都能从用户输入或所选产品资料得到。
4. 80-150 字，中文，不要编号，不要空泛营销词，不要强 CTA。` }
      ], { json: true, temperature: 0.55 });
      const d = parseJSONLoose(content);
      const brief = trimCreativeBrief(d.brief || "");
      if (brief && brief.length >= 30) return this._ok(brief);
      throw new Error("模型未返回有效 brief");
    } catch (e) {
      this._fb(e);
      return rawUserText;
    }
  },

  /* ---------- 脚本生成 ---------- */
  async generateScript({ topic, duration = 30, account, image, direction = "", style = "", imageCount = DEFAULT_XHS_IMAGE_COUNT, product = null, imageTemplate = "", styleRefName = "", batchVariant = null, useOnlineTrends = false, trendGuide = "", trendPrep = null }) {
    const requiredTopic = sanitizeXhsText(cleanText(topic || "")).trim();
    if (!requiredTopic) throw new Error("请先填写发布标题或创作内容");
    const hasImageTemplate = image && String(imageTemplate || "").trim();
    const mentionedTools = productsMentionedIn(`${requiredTopic}\n${direction}`, product, 4);
    const mentionedGuide = productRelationLine(mentionedTools);
    const dirText = image
      ? (direction ? `本次创作内容：${direction}。` : `本次创作内容：围绕主题自由发挥，每张图承担清晰信息点。`)
      : (direction ? `目标人群方向：${direction}（脚本语气、痛点、例子都贴合这个人群）。` : `人群方向：不限，自由发挥最合适的角度。`);
    const nImg = Math.max(1, Math.min(12, imageCount || DEFAULT_XHS_IMAGE_COUNT));
    const variantGuide = batchVariantLine(batchVariant);
    const prep = await resolveTrendPrep({ topic: `${requiredTopic}\n${direction}`, account, product, batchVariant, useOnlineTrends: false, kind: image ? "image" : "video", imageCount: nImg });
    const trendGuideText = prep?.guide || await resolveTrendGuide({ topic: `${requiredTopic}\n${direction}`, account, product, batchVariant, useOnlineTrends: false, kind: image ? "image" : "video", imageCount: nImg });
    const prepLine = prep ? `结构化内容参考（只决定节奏，不得改写用户标题）：\n用户主题：${requiredTopic}\n结构方向：${prep.directionName || "按用户内容判断"}\n图片/内容策略：${prep.imageStrategy || ""}\n` : "";
    const sys = image
      ? `你是小红书图文笔记策划，为百度 ACG 市场部写「小红书笔记图卡内容表」，每行是笔记里的一张配图。严格围绕用户本次创作内容展开；账号只提供创作风格，不提供内容方向。
先把用户创作内容整理成 ${nImg} 个信息节拍，每张图承担一个清楚的信息任务：观点、动作、证据、结果或边界。长内容要总结、取舍、分布，不要把所有信息塞进每一张图；短内容要补真实使用场景、结果证据或边界提醒。信息密度由内容判断：封面更轻，内页可以适当承载具体信息；模拟文档、表格、报告页时可以更细，但必须分层清楚、文字可读、重点明确。标题和图上文案要像真实笔记，具体、有信息量、能让人看懂功能和结果。图文没有口播，只有画面与图上文案。每行 idea 写清这张图唯一要传达的信息；visual 必须非常具体（画面布局/主视觉/界面里出现的具体文字/配色/光线/产品视觉位置），先在脑内把这张图具象化成真实画面再写，不要用电影感、高级感、种草感这类抽象词。内部结构词不要出现在 idea、visual、line 里。
第一张图默认是点击入口，不是教程信息页：优先强标题、简单主视觉和清晰关系。除非用户明确要求首图高信息量，否则第一张不要变成流程、长清单、复杂表格、多截图或密集小字。若主题是 Obsidian、Codex、WorkBuddy 等工具和主产品对比/组合，第一张优先用两个工具标识或简化图标 + 大字标题 + 箭头/VS 关系来表达。
第二张开始再讲真实场景、执行动作、工具分工、结果证据和结论。图片数量少时要主动压缩信息，把次要内容变成一句结论；图片数量多但用户只给少量方向时，要补真实使用场景、例子和边界提醒。
同一批量任务里每个账号都要像不同博主写同一方向：可以共享大主题，但必须更换切入角度、例子、标题表达、图卡顺序和结尾结论；不要输出多条相同或近似的图卡脚本。
如果账号风格是火柴人、简笔画、小人、漫画或手绘，line 更偏短句，visual 重点写人物动作、表情、气泡、箭头和小物件，减少界面文字和表格密度。
若本次创作内容提到竞品/同类工具，要先识别其在产品库中的功能点，再安排成对比表、分工流程、组合用法或边界提醒；本次主产品仍是主角，不能把竞品能力写成主产品能力。测评或对比类内容只写适合谁、任务边界、真实证据和组合方式，不写分数、星级、排行榜或评分卡。
本地结构参考只用于决定图卡节奏和信息分布，不得覆盖用户创作内容、发布标题和最终文案；不要把“结构参考/样本标题”等词写进 shots。${hasImageTemplate ? `账号配置了固定图文模板，必须优先遵守模板的风格、画面语言、参考图使用方式和统一要求；但模板中的张数、主题、产品名、各图内容都要按本次创作内容重写，最终 shots 必须正好 ${nImg} 行。` : ""}只输出 JSON：{"title":"小红书笔记风标题","shots":[{"idea":"核心思想","visual":"非常具体的画面","line":"图上文案(小红书笔记口吻、精简)"}]}，shots 必须正好 ${nImg} 行。`
      : (account.subType === "无数字人"
        ? `你是百度 ACG 市场部资深短视频编剧，写指定产品教程【无数字人】视频：没有固定出镜人物，以场景/产品界面/手部操作混剪为主，line 写专业画外音旁白。成片控制在45-58秒，绝不超过60秒，拆成8-10个镜头；每镜头口播1句，尽量12-24个中文字符，单句至少能自然说3秒，不要赶。偏教程专业可信、理性有梗、不要信息流硬广。visual 非常具体：景别、机位运镜(固定/缓推/横移/跟随)、产品界面模块、界面动效(卡片滑入/进度条/局部高亮)、配色、光线，禁止电影感/高级感/种草感等抽象词。visual 里不要安排叠加字幕/标题文字。每镜头带 ui(true/false) 和 scene(连续场景编号)。只输出 JSON：{"title":"标题","shots":[{"time":"0-4s","idea":"核心思想","visual":"非常具体的画面分镜","line":"专业画外音旁白","ui":true,"scene":1}]}。`
        : `你是百度 ACG 市场部资深短视频编剧，写指定产品教程【真人/数字人口播】视频。成片控制在50-65秒，拆成12-16个可切分口播镜头；每镜头口播1句，尽量14-30个中文字符，像真人一口气讲经验，不要赶。用户写的主题是硬约束：标题、前3句口播、中段例子和结尾都必须服务这个主题，不得改写成默认资料整理、周报或泛泛工具介绍。口播风格参考：先从真实误解或门槛担心切入；随后给轻微惊讶/松一口气的反差；中段用1-2个具体办公或内容场景讲清“直接说人话、工具拆解任务、一步步执行、还能整理文件/总结资料/分析表格/捋需求”；结尾落在“不是让我变程序员，而是把脑子里的想法或手里的乱东西推进到可看可用的版本”。不要逐字照抄任何参考话术。可以有情绪起伏、口语停顿和朋友式解释感，但不要输出 {happy}、{/happy}、(clear-throat) 这类情绪/音效标签，也不要输出括号舞台指令。结构上有真人开场、有产品场景演示、有真人收束，但不要死板两段式。内容丰富、偏教程专业可信、理性有梗、不要信息流硬广：口播像真实经验分享，能直接念。visual 非常具体：人物动作表情、产品界面模块、运镜、界面动效、配色、光线；如果后续有统一参考图，人物外貌由参考图锁定，这里不要写五官长相。禁止电影感/高级感/种草感等抽象词。visual 里不要安排叠加字幕/标题文字。每镜头带 ui(true/false) 和 scene(连续场景编号)。只输出 JSON：{"title":"标题","shots":[{"time":"0-4s","idea":"核心思想","visual":"非常具体的画面分镜","line":"口播原话","ui":true,"scene":1}]}。`);
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + sys },
        { role: "user", content: image
          ? `账号创作风格：${style || account.styleProfile || "干净可读的小红书图文风"}\n语气：${account.tone || "教程感"}\n平台：${account.platform}\n内容模式：${account.mode}\n${dirText}\n${variantGuide ? `\n${variantGuide}\n` : ""}共生成 ${nImg} 张图。\n${style ? `图文总风格：${style}（所有画面统一这个视觉风格）。\n` : ""}${styleRefName ? `成图风格参考：${styleRefName}。\n` : ""}${hasImageTemplate ? `账号图文模板（只作为风格/结构母版，不要照抄示例变量）：\n${imageTemplate}\n` : ""}${prepLine}${mentionedGuide ? `本次创作内容里明确提到的同类/互补工具能力：\n${mentionedGuide}\n请把这些工具具体安排成组合流程、功能边界或对比卡，不要只挂名字。\n` : ""}本地结构参考（只学节奏，不覆盖主题）：\n${trendGuideText}\n主题：${requiredTopic}\n围绕本次宣传产品的真实功能延展教学，优先服从用户本次创作内容，不要强呼吁下载。${topicalHook(product)}`
          : `账号创作风格：${account.styleProfile || style || "真实经验分享"}\n账号口播风格参考：${account.voiceName || account.styleProfile || style || account.tone || "自然、可信、有教程感"}\n语气：${account.tone || "教程感"}\n平台：${account.platform}\n内容模式：${account.mode}\n当前主产品：${chineseProductDisplayName(product, "百度搭子")}\n${dirText}\n${prepLine}视频号脚本只参考账号创作风格、账号口播风格、本次选题、产品真实功能和本地内容结构。\n本地结构参考（只学节奏，不要照抄）：\n${trendGuideText}\n主题：${requiredTopic}\n目标时长：${Math.min(60, duration || 55)}秒以内，最终不超过60秒。口播宁可少一点，保证每句都能自然读完。口播可以自然出现「${chineseProductDisplayName(product, "百度搭子")}」1-3次，尤其在讲工具能力、真实使用结果和结尾总结时不要刻意回避产品名。围绕本次宣传产品的真实功能延展教学，但要先用真实痛点切入、自然安利，不要孤立自嗨，不要强呼吁下载。${topicalHook(product)}${this.memoryLine(account)}` }
      ], { json: true });
      const d = parseJSONLoose(content);
      if (!d.shots || !d.shots.length) throw new Error("模型未返回 shots");
      const normalized = normalizeScriptResult(d, { topic: requiredTopic, image, imageCount: nImg, product });
      return this._ok(normalized);
    } catch (e) {
      this._fb(e);
      return this._mockScript({ topic: requiredTopic, account, image, imageCount: nImg, product });
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
  async generateImagePrompts({ script, account, style, imageTemplate = "", styleRefName = "", imageCount = DEFAULT_XHS_IMAGE_COUNT, product = null, topic = "", batchVariant = null, useOnlineTrends = false, trendGuide = "", trendPrep = null, copy = null, requireLlm = false }) {
    const tpl = String(imageTemplate || "").trim();
    const nImg = Math.max(1, Math.min(12, imageCount || DEFAULT_XHS_IMAGE_COUNT));
    const safeTopic = sanitizeXhsText(cleanText(topic || ""));
    const safeScript = sanitizeXhsText(cleanText(scriptInputText(script)));
    const safeStyle = sanitizeXhsText(cleanText(style || ""));
    const safeTpl = sanitizeXhsText(stripPromptScaffold(tpl));
    const rawCopyTitle = stripVisibleTextLabels(cleanText(normalizeGeneratedEscapes(copy?.title || ""))).trim();
    const copyTitle = sanitizeXhsText(rawCopyTitle);
    const copyBody = sanitizeXhsText(cleanText(normalizeGeneratedEscapes(copy?.body || copy?.copy || "")))
      .replace(/#[^\s#]+/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const copyForPrompt = copy ? { ...copy, title: copyTitle, headline: copyTitle, body: copyBody, copy: copyBody } : null;
    const copyBrief = [copyTitle ? `标题：${copyTitle}` : "", copyBody ? `正文：${copyBody.slice(0, 2800)}` : ""].filter(Boolean).join("\n");
    const hasCopyBrief = !!copyBrief;
    const contentBeats = hasCopyBrief ? copyContentBeats(copyTitle, copyBody, nImg) : [];
    try {
      const content = await llm([
        { role: "system", content: `你是小红书笔记配图的图片提示词设计师。最终发布标题和正文是图片内容的唯一事实来源；账号资料只决定视觉设计，不决定图片讲什么。不得使用产品资料库、竞品关系、账号定位、历史模板、本地结构样本或默认办公案例补写内容。发布文案里明确出现的产品名、软件名和动作可以原样理解，但不能用你记忆中的产品介绍覆盖正文。禁止把发布标题换成另一个主题。先把正文完整理解并均匀规划为 ${nImg} 个不重复的信息节拍，再拆成 ${nImg} 张静态图片；每张承担正文中的一段具体信息，顺序合理，覆盖正文要点，不重复同一句。
第一张图默认是点击入口，优先冲击感和可点击性：用强标题、短副标题和简单视觉关系吸引点击。第一张负责概括正文的核心入口；第二张之后是干货承载页，按正文顺序展开具体信息。每张内页必须有 1 个清楚结论，并从该页分配到的正文里提炼 2—4 个具体支撑项，例如步骤、动作、判断依据、证据、结果、避坑或适用边界；不得为了凑数量补写正文外事实。
若内容过多，先在内部重新规划：把重要信息均匀分给 ${nImg} 张图，次要内容压成一句结论；若内容较少，只能把正文已有信息改写成例子、结果或边界提醒，不得补入正文之外的产品知识、默认案例或事实。
同一批量任务的不同账号可以改变每张图的标题表达、主视觉和卡片顺序，但内容事实仍只能来自该账号最终正文。
每条 prompt 必须是可直接交给图像模型的正向画面描述，不要复述任务、正文分段编号、信息密度策略或生成规则，不要输出「本张只展开」「不得换题」「正文第几部分」「内容唯一依据」等规划语言。图片内容只来自最终发布文案；视觉效果只来自账号创作风格、账号模板和参考图。账号风格最多提炼成一句简短的配色或画风说明，不得替用户改写画面内容。${safeStyle ? "账号创作风格（只决定视觉效果）：" + cleanImagePlanningWords(safeStyle) + "。" : "默认白底极简、蓝紫品牌色、圆角卡片排版、大留白、真实截图质感。"}${styleRefName ? `参考图（只作为视觉/构图参考，不提供内容主题）：${sanitizeXhsText(styleRefName)}。` : ""}${safeTpl ? `账号固定模板只作为配色、字体、布局和画面语言母版，模板文字和内容必须全部换成本次正文。` : ""}

每条 prompt 保持精炼但足够具体。说清：画面布局、主视觉、关键界面/文件/数据卡片、画面里允许出现的短文字、光线与颜色。画面文字围绕主标题、短解释和必要标签组织，按内容复杂度自然取舍；第一张保持简洁，第二张以后用 2—4 个层级明确的信息模块承载可操作干货，文字量明显高于封面但字号必须可读。若账号风格是火柴人、简笔画、小人、漫画或手绘，则用 2—4 组人物动作、表情、气泡和箭头分别解释信息模块，避免复杂表格和长段落。
画面文字必须写具体功能、动作或结果，例如「资料自动归类」「字段一眼识别」「报告可直接用」，不能写空泛定位。
测评、对比或工具选择类选题用适合谁、不适合谁、任务边界、证据和组合方式表达，采用边界对照、场景分工和使用建议，不采用分数、星级、排行榜、打分表或评分卡。
内部分类词只用于理解结构，最终 prompt 主体保持正向画面描述。不要套用任何默认产品卖点、默认办公清单或历史常用句式。

只输出 JSON：{"shots":[{"title":"给操作员看的短标题，写具体功能或结果","prompt":"可直接给图像模型的提示词","ui":true}]}` },
        { role: "user", content: `账号创作风格（只决定视觉设计）：${sanitizeXhsText(account.styleProfile || style || "")}\n${copyBrief ? `最终发布文案（图片内容唯一依据；标签已移除，不参与画面规划）：\n${copyBrief}\n\n已经按正文顺序确定的信息分配（必须逐张遵守，不能换题）：\n${contentBeats.map((beat, i) => `图${i + 1}：${beat}`).join("\n")}\n` : `发布文案暂缺，只能使用这次标题/脚本：\n${[safeTopic, safeScript].filter(Boolean).join("\n")}`}\n${styleRefName ? `风格参考图：${sanitizeXhsText(styleRefName)}\n` : ""}${safeTpl ? `账号视觉模板：\n${safeTpl}\n` : ""}请输出 ${nImg} 张图的完整提示词。图1必须是简洁、有冲击力、低噪点的封面；图2及后续每张都必须有一个清楚结论和 2—4 个来自该页正文信息的具体支撑模块，提升干货密度但保持可读。` }
      ], { json: true, temperature: 0.8 });
      const d = sanitizeXhsObject(parseJSONLoose(content));
      if (!d.shots || !d.shots.length) throw new Error("模型未返回 shots");
      return this._ok({
        shots: (hasCopyBrief ? normalizeCopyDrivenImagePromptItems : normalizeImagePromptItems)(d.shots, {
          script: safeScript,
          topic: safeTopic,
          account,
          style: safeStyle,
          imageTemplate: safeTpl,
          styleRefName,
          imageCount: nImg,
          product,
          copy: copyForPrompt,
          contentBeats,
          trendPrep: null
        })
      });
    } catch (e) {
      this._fb(e);
      if (requireLlm) {
        const detail = this.lastError || "语言模型未返回有效图卡提示词";
        this.lastSource = "error";
        throw new Error(`图卡提示词模型生成失败：${detail}`);
      }
      await delay(400);
      const rows = String(safeScript || "").split(/\n+/).map(x => x.trim()).filter(Boolean);
      return {
        shots: (hasCopyBrief ? normalizeCopyDrivenImagePromptItems : normalizeImagePromptItems)(Array.from({ length: nImg }, (_, i) => {
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
          copy: copyForPrompt,
          contentBeats,
          trendPrep: null
        })
      };
    }
  },

  async generateImageCopyFromTitle({ title = "", account = {}, product = null } = {}) {
    const sourceTitle = stripVisibleTextLabels(cleanText(title || "")).trim();
    if (!sourceTitle) throw new Error("请先填写发布标题");
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const content = await llm([
          { role: "system", content: `你是专业的小红书图文正文写手。用户给出的标题是唯一内容主题，必须先理解标题在说什么，再写一篇与标题强相关、可直接发布的干货正文。不得把标题替换成泛化的 AI 办公、效率清单或其他常见模板；不得引入标题未指向的新产品、新选题或竞品关系。正文必须自然保留标题中的主产品名、核心对象和任务关系词，不能把所有关键字都换成泛化同义词。内容优先采用三类可靠结构之一：测评类写结论、依据、适合谁与边界；教学类写前提、步骤、结果与避坑；种草类写使用场景、真实价值、选择理由与限制。正文要回答标题承诺的问题，给出具体做法、判断依据或可验证结果，语气专业、清楚、克制、可信，不把标题原样重复成第一句。全文禁止使用“兄弟们、家人们、姐妹们、宝子们、老铁们、集美们、亲们、朋友们”等直播式群体称呼，也禁止“闭眼入、无脑冲、冲就完了、绝绝子”等夸张带货话术。最后一行给 4-7 个相关话题标签。账号信息只决定表达风格，不改变主题和专业度。只输出单行 JSON：{"copy":"正文和标签"}。JSON 字符串里的换行必须写成 \\n，不能在引号内直接换行。` },
          { role: "user", content: `发布标题：${sourceTitle}\n账号语气：${copyAccountVoice(account, account?.tone || "真实、清楚、有具体信息", sourceTitle)}\n所选产品：${productDisplayName(product) || "未指定"}。产品资料只用于事实边界；标题没有谈到该产品时不得强行植入，标题明确涉及产品时不得写成其他产品。\n请只围绕这个标题写正文。` }
        ], { json: true, temperature: attempt ? 0.72 : 0.92 });
        const data = sanitizeXhsObject(parseJSONLoose(content));
        const copyText = ensureImagePublishTags(assertProfessionalImageCopy(data.copy || data.body || ""), null, sourceTitle);
        if (!copyText) throw new Error("模型没有返回与标题对应的正文");
        this.lastSource = "llm-title-copy";
        this.lastError = "";
        return { title: sourceTitle, copy: copyText, source: this.lastSource };
      } catch (error) {
        lastError = error;
      }
    }
    this.lastSource = "error";
    this.lastError = (lastError && lastError.message) || String(lastError || "标题文案生成失败");
    throw lastError || new Error("标题文案生成失败");
  },

  async generateCopyFromImage({ imageDataUrl = "", account = {} } = {}) {
    if (!imageDataUrl) throw new Error("没有可供识别的成图");
    const content = await visionCopy(imageDataUrl, copyAccountVoice(account, account?.styleProfile || "", ""));
    const data = sanitizeXhsObject(parseJSONLoose(content));
    const title = cleanGeneratedHeadlineNoise(data.title || data.headline || "", null, 32);
    const copy = ensureImagePublishTags(data.copy || data.body || "", null);
    if (!title || !copy) throw new Error("视觉模型没有返回完整标题和文案");
    this.lastSource = "llm-vision";
    this.lastError = "";
    return { title, copy };
  },

  /* ---------- 发布文案（交付包随附） ---------- */
  async generateCopy({ topic, shots, account, style, kind = "image", product = null, batchVariant = null, avoidCopies = [], useOnlineTrends = false, trendGuide = "", trendPrep = null, requireLlm = false }) {
    useOnlineTrends = false;
    trendGuide = "";
    trendPrep = null;
    const safeTopic = sanitizeXhsText(cleanText(topic || ""));
    const safeShots = sanitizeXhsObject(JSON.parse(JSON.stringify(shots || [])));
    const safeStyle = sanitizeXhsText(cleanText(style || ""));
    const accountVoice = copyAccountVoice(account, safeStyle, safeTopic);
    const speechVoice = copyAccountVoice(account, account?.voiceName || safeStyle, safeTopic);
    const intent = inferCopyIntent({ topic: safeTopic, shots: safeShots, account, product, useAccountPosition: false });
    const variantGuide = batchVariantLine(batchVariant);
    const offlineCopyLine = "围绕用户主题和图卡内容写即可，自由组织标题、正文和表达方式；不要换题，不要把标题原样放在正文第一句。";
    const script = kind === "video"
      ? (safeShots || []).map((s, i) => `镜头${i + 1}｜${s.time || ""}｜口播：${s.line || ""}`).join("\n")
      : (safeShots || []).map((s, i) => `图${i + 1}｜${s.idea || ""}｜图上文案：${s.line || ""}`).join("\n");
    const videoProductName = chineseProductDisplayName(product, "百度搭子");
    const sys = kind === "video"
      ? `你是短视频发布文案写手。根据用户主题、平台、产品和口播内容，写一个发布标题和简介。自由发挥，贴合主题即可；标题自然有点击欲，正文像真人发布后的补充说明。不要换题，不要把标题原样当正文第一句。最后一行给 4-7 个话题标签，包含「#${videoProductName}」。只输出 JSON：{"title":"...","copy":"..."}`
      : `你是专业的小红书图文文案写手。根据用户主题和图卡内容，写一个发布标题和正文。内容偏向测评、教学或可信种草：给出判断依据、具体步骤、真实结果、适用边界或选择建议，避免空泛口号。语气专业、清楚、克制，不要使用“兄弟们、家人们、姐妹们、宝子们、老铁们、集美们、亲们、朋友们”等直播式群体称呼，也不要使用“闭眼入、无脑冲、冲就完了、绝绝子”等夸张带货话术。不要换题，不要把标题原样当正文第一句。最后一行给 4-7 个话题标签。只输出 JSON：{"title":"...","copy":"..."}`;
    const copyGroundRules = "只根据用户主题、已定内容、账号语气和当前产品写文案；主题优先，可以自然出现产品名，不要写成无关的固定模板。";
    const messages = [
      { role: "system", content: sys + "\n\n" + copyGroundRules },
      { role: "user", content: kind === "video"
        ? `平台：${account.platform}\n账号语气：${accountVoice}\n口播风格：${speechVoice}\n当前主产品：${videoProductName}\n用户主题：${safeTopic}\n${variantGuide ? `${variantGuide}\n` : ""}${safeStyle ? `视觉/口吻参考：${safeStyle}\n` : ""}已定口播内容：\n${script}\n${this.memoryLine(account)}`
        : `平台：${account.platform}\n账号语气：${accountVoice}\n当前主产品：${videoProductName}\n用户主题：${safeTopic}\n${variantGuide ? `${variantGuide}\n` : ""}${offlineCopyLine}\n${safeStyle ? `视觉/口吻参考：${safeStyle}\n` : ""}图卡内容：\n${script}` }
    ];
    let lastError = null;
    const attempts = requireLlm ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const content = await llm(messages, {
          json: true,
          temperature: attempt === 0 ? 1.02 : 0.72
        });
        const d = sanitizeXhsObject(parseJSONLoose(content));
        if (!d.title || !d.copy) throw new Error("模型未返回 title/copy");
        const polished = polishCopyResult(d, {
          topic: safeTopic,
          shots: safeShots,
          account,
          kind,
          product,
          batchVariant,
          avoidCopies,
          allowSemanticFallback: !requireLlm
        });
        if (kind === "image") polished.copy = assertProfessionalImageCopy(polished.copy);
        return this._ok(polished);
      } catch (error) {
        lastError = error;
        const message = (error && error.message) || String(error || "");
        // JSON/transport retry is centralized in llm(); this layer retries only
        // valid JSON that fails the publishing contract, avoiding duplicate calls.
        const retryableModelOutput = /模型未返回 title\/copy|模型返回的发布标题无效|模型返回的发布文案无效/.test(message);
        if (attempt + 1 < attempts && retryableModelOutput) await delay(240);
        else break;
      }
    }
    this._fb(lastError);
    if (requireLlm) {
      this.lastSource = "error";
      this.lastError = (lastError && lastError.message) || String(lastError || "语言模型生成失败");
      throw lastError instanceof Error ? lastError : new Error(this.lastError);
    }
    await delay(400);
    return sanitizeXhsObject(this._mockCopy({ topic: safeTopic, shots: safeShots, account, product, kind, batchVariant, avoidCopies }));
  },

  async generateCustomVideoDraft({ title = "", body = "", account = {}, product = null, mode = "digital" } = {}) {
    const safeTitle = cleanCustomVideoText(title);
    const safeBody = cleanCustomVideoText(body);
    if (!safeTitle && !safeBody) throw new Error("自定义模式需要填写标题或文案");
    const productName = chineseProductDisplayName(product);
    const platform = account?.platform || "视频号";
    const accountVoice = copyAccountVoice(account, account?.styleProfile || account?.lockedStyle || "", safeTitle || safeBody);
    const isInfoFlowMode = mode === "infoFlow";
    const sys = [
      "你是短视频内容策划和发布文案写手。先理解用户标题/文案的真实意图，再写内容，不套固定模板。",
      "发布文案：专业、克制、偏解析测评，像真人创作者发平台内容；第一句直接给判断或场景，不要完整复述标题，不要用 哎/跟你说/说个事/你感受一下 这类闲聊开场，不要写 本条围绕/这条围绕/本文围绕/本期围绕。",
      "口播：比发布文案更长，用第一人称 我 的视角，口语化，有情绪和现场感，像 60-90 秒内能自然讲完的真人口播；不要照抄发布文案。",
      "如果只有标题，请补出文案和口播；如果正文含 #标签，标签只留在发布文案末尾，不进入口播或视频提示词。",
      "不要使用「」『』符号，不要输出思考过程。",
      "只按四段输出，不要加解释：\n标题：...\n发布文案：...\n口播：...\n画面提示：..."
    ].join("\n");
    const bodyNote = safeBody
      ? `用户已写文案：\n${safeBody}\n\n如果里面有 #标签，只把标签留给发布文案最后一行，不要写进口播和视频提示词。`
      : "用户未写正文：请根据标题补出发布文案和口播。";
    const visualAsk = isInfoFlowMode
        ? "画面提示固定写：由后续信息流创意链路生成。不要在这里提前套用剧情、台词或视频提示词。"
      : "visualPrompt 写成真人/数字人画面提示词：同一角色、办公室场景、自然讲述，可穿插产品界面和资料处理结果，不要写标签。";
    const messages = [
      { role: "system", content: sys },
      { role: "user", content: [
        `平台：${platform}`,
        `账号语气：${accountVoice}`,
        `主产品：${productName}`,
        `生成类型：${isInfoFlowMode ? "信息流视频" : "真人/数字人视频"}`,
        `用户标题：${safeTitle || "未填写"}`,
        bodyNote,
        visualAsk,
        "发布文案 180-340 个中文字符，最后一行 4-7 个标签；口播 380-620 个中文字符。标题可优化但不能换题。"
      ].join("\n") }
    ];
    try {
      let content = "";
      try {
        content = await llm(messages, { temperature: 0.9, timeoutMs: 90000, thinking: "disabled", maxTokens: 4096 });
      } catch (err) {
        if (!/模型无有效返回|finish_reason|length|JSON|四段/.test(err?.message || String(err))) throw err;
        content = await llm(messages, { temperature: 0.9, timeoutMs: 90000, thinking: "disabled", maxTokens: 4096 });
      }
      const d = parseCustomVideoDraftText(content, safeTitle);
      const out = {
        title: cleanCustomVideoText(d.title || safeTitle || ""),
        copy: ensureVideoBrandTags(cleanCustomVideoText(d.copy || safeBody || "", { title: d.title || safeTitle }), product),
        narration: cleanCustomVideoText(d.narration || "", { stripTags: true, title: d.title || safeTitle }),
        visualPrompt: cleanCustomVideoText(d.visualPrompt || "", { stripTags: true, title: d.title || safeTitle })
      };
      if (!out.title) out.title = safeTitle || cleanCustomVideoText((out.copy || out.narration).split(/\n+/)[0] || "");
      if (!out.copy || !out.narration) throw new Error("模型未返回完整的发布文案和口播");
      if (normalizeForDedupe(out.copy) === normalizeForDedupe(out.narration)) throw new Error("模型返回的发布文案和口播过于相似，请重试");
      if (!/我|咱|我们/.test(out.narration)) throw new Error("模型口播缺少第一人称视角，请重试");
      if (out.narration.length < Math.min(360, out.copy.length + 80)) throw new Error("模型口播长度不足，请重试");
      if (/本条围绕|这条围绕|本文围绕|本期围绕/.test(`${out.copy}\n${out.narration}`)) throw new Error("模型文案仍含元话术，请重试");
      if (/^(哎|嘿|诶|欸|跟你说|我跟你说|说个事|你感受一下|家人们|兄弟们|姐妹们)/.test(out.copy.trim())) throw new Error("模型发布文案过于口语化，请重试");
      return this._ok(out);
    } catch (e) {
      this.lastSource = "error";
      this.lastError = (e && e.message) || String(e || "语言模型调用失败");
      throw new Error(`自定义视频内容需要语言模型生成：${this.lastError}`);
    }
  },

  async generateInfoFlowCreativePlan({ title = "", copy = "", narration = "", account = {}, product = null, previousPrompts = [] } = {}) {
    const safeTitle = cleanInfoFlowDirectorText(title, { stripTags: true });
    const safeCopy = cleanInfoFlowDirectorText(copy, { stripTags: true });
    const safeNarration = cleanInfoFlowDirectorText(narration, { stripTags: true });
    if (!safeTitle && !safeCopy) throw new Error("生成信息流提示词前需要标题或发布文案");
    const productName = chineseProductDisplayName(product);
    const accountVoice = copyAccountVoice(account, account?.styleProfile || account?.lockedStyle || "", safeTitle || safeCopy);
    const engines = [
      "荒诞任务短剧：用一个意外事件把痛点推到极端，再自然回落到解决方案",
      "视觉隐喻广告：把抽象任务具象成会失控的空间、道具或机关，用强运镜讲清冲突",
      "反常识对话：用两名角色立场冲突和一句反转建立钩子，台词短、狠、自然",
      "伪纪录片现场：像偶然拍到的真实办公事故，镜头有观察感，结尾突然给出可执行办法",
      "高密度喜剧误会：连续升级三次误会，最后用产品流程把前面的笑点全部回收",
      "一镜到底挑战：用空间调度和连续动作制造压力，最后切进纯界面完成反差"
    ];
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${attempt}`;
      const engine = engines[Math.floor(Math.random() * engines.length)];
      const avoid = (previousPrompts || []).some(Boolean)
        ? "当前任务存在旧稿；本次必须重新构思，不沿用旧稿剧情、台词、道具、角色身份或界面结构。"
        : "";
      const system = [
        "你是顶级短视频创意导演。每次都要从标题和发布文案重新构思，不套用固定办公焦虑模板，不复用上一版台词或镜头。",
        "输出一组连续的 30 秒信息流创意，A 面 15 秒负责剧情钩子，B 面 15 秒负责产品界面演示。",
        "A 面必须有完整微型剧情：明确人物目标、阻碍、升级和反转。可以夸张剧情、表演、对话、空间变化或运镜，但必须服务本次标题和文案。前 2 秒就出现异常事件；至少 4 个分时镜头；台词必须原创、短促、自然。A 面禁止出现产品 logo、产品界面和产品名。",
        "B 面必须接住 A 面冲突，用真实产品界面、桌面软件窗口和屏幕录制式操作完成解决。B 面至少 4 个分时镜头，只展示界面、窗口、文件、图标和流程卡；禁止人物、手部、手指、人体部位、Q版角色和拟人化肢体；低文字密度。",
        "视频提示词要能直接交给视频模型：每个时间段写景别、机位或运镜、具体画面、动作变化、声音或台词、光线和转场。A/B 都是 9:16，每段严格 15 秒。",
        "不得出现这些固定句：这不是一个需求这是来拆我的、别再给我加需求了、字很多但完全不能用。不得写模板、同上、延续常规、根据文案等空话。",
        "发布标签不进入台词、画面或提示词。",
        "先为整条视频定义一个统一画面风格，例如超写实、电影纪实、夸张舞台广告或高质感三维界面；A/B 两面必须使用完全相同的光影、色彩、材质和镜头语言。",
        "只输出 JSON：{\"creativeAngle\":\"一句话创意\",\"visualStyle\":\"A/B面共用的画面风格\",\"frontPrompt\":\"A面完整导演提示词\",\"backPrompt\":\"B面完整导演提示词\"}"
      ].join("\n");
      const user = [
        `创意引擎：${engine}`,
        `创意随机种子：${nonce}`,
        `平台：${account?.platform || "视频号"}`,
        `账号语气：${accountVoice}`,
        `主产品：${productName}`,
        `标题：${safeTitle || "未填写"}`,
        `去标签发布文案：${safeCopy || "未填写"}`,
        `口播内容依据：${safeNarration || safeCopy || safeTitle}`,
        avoid
      ].filter(Boolean).join("\n\n");
      try {
        const content = await llm([
          { role: "system", content: system },
          { role: "user", content: user }
        ], { json: true, temperature: 1.15, timeoutMs: 90000, thinking: "disabled", maxTokens: 5200 });
        const plan = parseInfoFlowCreativePlan(content);
        const sharedStyle = plan.visualStyle || "超写实商业广告质感，自然电影光影，真实材质，统一色彩与镜头语言";
        plan.frontPrompt = withSharedInfoFlowStyle(plan.frontPrompt, sharedStyle);
        plan.backPrompt = withSharedInfoFlowStyle(plan.backPrompt, sharedStyle);
        assertInfoFlowCreativePlan(plan, previousPrompts);
        return this._ok(plan);
      } catch (error) {
        lastError = error;
      }
    }
    this.lastSource = "error";
    this.lastError = lastError?.message || String(lastError || "信息流创意生成失败");
    throw new Error(`信息流创意需要语言模型重新生成：${this.lastError}`);
  },

  /* ---------- md / 自然语言 → 批量账号 ---------- */
  async parseAccountsMd(text) {
    try {
      const content = await llm([
        { role: "system", content: `把用户的 markdown 解析成账号数组。每个账号字段：name(必填)、platform(小红书|视频号)、mode(图文|视频)、subType(数字人|无数字人，仅视频)、styleProfile(创作风格/口播风格描述)。不要生成目标人群、职业、家庭身份或账号分类标签；缺失字段合理推断。只输出 JSON：{"accounts":[...]}` },
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
          styleProfile: (b.match(/(?:风格|口播风格|创作风格)[：:]\s*([^\n]+)/) || [])[1] || ""
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

  _digitalTopicPlan(topic = "", productName = "百度搭子") {
    const raw = sanitizeXhsText(String(topic || ""))
      .replace(/Dumate|DuMate|百度搭子|百度秒哒|秒哒/g, "")
      .replace(/[！!。.\s]+$/g, "")
      .trim() || "重复办公任务";
    const has = re => re.test(raw);
    const base = {
      title: cleanScriptTitle(topic, topic, { name: productName, shortName: productName }),
      pain: `${raw}最怕的不是不会做，而是每次都从零开始想步骤。`,
      firstAction: `我会先把“${raw}”拆成目标、材料、执行和复核四件事。`,
      secondAction: `再交给${productName}按这个顺序跑一遍，先出能改的初版。`,
      proof: `看结果时别只看写得顺不顺，还要看有没有留下可复核的依据。`,
      close: `所以${raw}不是靠灵感硬扛，而是先让流程把重复动作接住。`,
      ui: "任务拆解卡、资料卡和结果预览依次出现"
    };
    if (has(/模型|隐藏玩法|玩法|效率翻倍|选对|Claude|GPT|DeepSeek|豆包/i)) {
      return {
        ...base,
        pain: "很多人提效慢，不是模型不够强，是一开始就把任务交错了对象。",
        firstAction: "我会先判断这件事该让谁负责：拆步骤、拉资料、写初版还是复核。",
        secondAction: `在${productName}里把任务目标说清楚后，再让流程去调用合适能力。`,
        proof: "这样做的好处是，结果错了也知道该改模型、改资料，还是改任务描述。",
        close: "模型选对以后，效率翻倍来自少返工，而不是多点几次生成。",
        ui: "模型选择卡、任务分工表和复核清单依次亮起"
      };
    }
    if (has(/会议|录音|聊天记录|纪要|待办|会后/)) {
      return {
        ...base,
        pain: "会议录音和聊天记录最容易散在各处，最后待办和复盘都要重新翻。",
        firstAction: "我会先让它识别会议结论、责任人、时间点和待确认问题。",
        secondAction: `${productName}把录音、聊天记录和资料整理成待办清单，再生成复盘骨架。`,
        proof: "交付前重点核对每条待办能不能追溯到原话，避免总结看着顺但责任不清。",
        close: "会议复盘省时间的关键，是先把原始记录变成能跟进的清单。",
        ui: "录音波形、聊天记录、待办清单和复盘页依次展开"
      };
    }
    if (has(/周报|汇报|日报|月报|老板/)) {
      return {
        ...base,
        pain: "写汇报最烦的不是排版，是进展、数据和结论总散在不同地方。",
        firstAction: "我会把本周资料先放进去，让它按项目、动作和结果拆开。",
        secondAction: `${productName}先生成汇报骨架，再把缺口和待确认项单独列出来。`,
        proof: "最后我只需要补判断，不用再一条条翻聊天记录和表格。",
        close: "周报真正省时间的点，是让资料先变成能审的结构。",
        ui: "聊天记录、数据表和汇报页三列同步生成"
      };
    }
    if (has(/合同|PDF|Word|格式|转换|法务|协议|盖章/)) {
      return {
        ...base,
        pain: "合同和格式转换最容易耗在小规则上，页眉、字段、附件一个都不能漏。",
        firstAction: "我会先说清目标格式、字段范围和哪些内容必须人工复核。",
        secondAction: `${productName}把文件读取、格式处理和字段提取拆成可检查步骤。`,
        proof: "结果出来后先核金额、日期、主体和附件，再决定能不能交付。",
        close: "这类任务别追求一次完美，先要一版能核对、能修改的结果。",
        ui: "文件转换进度、字段提取表和复核红点依次出现"
      };
    }
    if (has(/数据|表格|Excel|指标|报表|分析|看板/)) {
      return {
        ...base,
        pain: "数据分析卡住，通常不是不会算，而是不知道先看哪几个字段。",
        firstAction: "我会先让它识别表头、异常值和最值得汇报的指标。",
        secondAction: `${productName}把原始表格整理成结论、图表和待确认清单。`,
        proof: "真正要看的是结论能不能回到原表里复核，而不是图做得多漂亮。",
        close: "表格提效的关键，是先让数据有结构，再让人做判断。",
        ui: "原始表格、指标卡和图表草稿并排出现"
      };
    }
    if (has(/小红书|视频号|内容|脚本|选题|封面|信息流|素材/)) {
      return {
        ...base,
        pain: "内容创作最容易看起来忙，实际上卡在选题、脚本和素材对不上。",
        firstAction: "我会先把主题、账号语气和想讲的结论放在同一个任务里。",
        secondAction: `${productName}先拆脚本，再把封面、口播和发布文案绑回同一主题。`,
        proof: "检查时只看一件事：标题、正文和画面是不是在说同一个点。",
        close: "内容链路跑顺后，省下来的不是灵感，而是反复重写的时间。",
        ui: "选题卡、口播草稿、封面预览和发布文案连成一条线"
      };
    }
    if (has(/口头需求|交付包|下载|步骤|不漏|初版|可修改/)) {
      return {
        ...base,
        pain: "从口头需求到交付包最怕中间漏步骤，最后下载出来还是旧版本。",
        firstAction: "我会先把口头需求拆成材料、产物、命名、预览和下载五个检查点。",
        secondAction: `${productName}先跑出可修改初版，再把标题、文案、素材和交付包重新绑定。`,
        proof: "提交前一定核对预览、下载和全链路回看是不是同一个最新版本。",
        close: "交付链路真正要稳，是每次撤回修改后都能重新生成最新包。",
        ui: "口头需求卡、版本预览、下载包和回看链路依次亮起"
      };
    }
    if (has(/截图|资料|文件|桌面|归档|整理|知识库|Obsidian|笔记/i)) {
      return {
        ...base,
        pain: "资料越多越不等于知识越多，真正难的是让它们能被下次复用。",
        firstAction: "我会先按来源、用途和下一步动作，把截图和文件分成几类。",
        secondAction: `${productName}负责读取本地资料、提炼重点，再生成可回填的清单。`,
        proof: "最后要检查每条结论能不能找到原始材料，不能只看总结顺不顺。",
        close: "资料整理的目标不是变整齐，而是让下一次开工少解释一遍。",
        ui: "桌面文件、知识卡片和待办清单被自动归类"
      };
    }
    if (has(/Prompt|Agent|Codex|自动化|工作流|任务|流程|需求/i)) {
      return {
        ...base,
        pain: "会写 Prompt 只是开始，真正难的是让任务按标准反复跑通。",
        firstAction: "我会先写目标、输入材料、验收标准和失败后怎么修。",
        secondAction: `${productName}把这几件事拆成步骤，让每一步都有可检查结果。`,
        proof: "这样不是让 AI 多执行几次，而是每次循环都朝验收标准收敛。",
        close: "Agent 提效的核心，是把模糊需求变成能执行、能复核的流程。",
        ui: "Prompt、任务队列、验收标准和修正记录依次展开"
      };
    }
    return base;
  },

  /* ---------- 本地回退模板 ---------- */
  async _mockScript({ topic, account, image, imageCount, product = null }) {
    await delay(600);
    const productName = chineseProductDisplayName(product);
    const clean = (topic || "").replace(/Dumate|百度搭子|百度秒哒|秒哒/g, "").trim() || "杂事";
    if (image) {
      const n = Math.max(1, Math.min(9, imageCount || DEFAULT_XHS_IMAGE_COUNT));
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
    const plan = this._digitalTopicPlan(topic, productName);
    const base = dh ? [
      { idea: "数字人开场钩子", visual: `数字人正面中近景、固定机位、暖色正面光，旁边浮现本期主题「${clean}」的任务卡`, line: plan.pain },
      { idea: "明确任务拆法", visual: `缓推切到${productName}首页圆角输入框，输入框里出现本期主题和目标结果`, line: plan.firstAction },
      { idea: "引出产品", visual: `${productName}界面把主题拆成任务卡，蓝紫高亮从上到下扫过`, line: plan.secondAction },
      { idea: "输入任务演示", visual: "特写输入框出现任务文字，发送按钮高亮，任务卡片滑入", line: "重点不是一句话求万能答案，而是先把目标和材料说完整。" },
      { idea: "拆解步骤演示", visual: `${plan.ui}，每张卡片旁边出现勾选状态`, line: "它会把这件事拆成能检查的步骤，你能看见它准备怎么做。" },
      { idea: "执行过程", visual: "资料卡、任务队列和结果预览在同一工作区里流转，进度条推进", line: "确认后再让流程往下跑，中间结果随时能改。" },
      { idea: "结果复核", visual: "结果卡片旁出现复核清单，重点项被蓝色框选", line: plan.proof },
      { idea: "数字人收束", visual: `数字人微笑看镜头，结果卡片缩小汇聚到${productName}完成卡片`, line: plan.close }
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
    const shots = base.map((b, i) => ({ time: `${i * 3}-${i === 7 ? 30 : i * 3 + 3}s`, idea: b.idea, visual: b.visual, line: stripCTA(sanitizeXhsText(b.line)) }));
    return { title: dh ? plan.title : cleanScriptTitle(topic, topic, product), shots };
  },

  _humanAppearanceAnchor(account) {
    const key = `${account?.id || ""}${account?.name || ""}`;
    const n = [...key].reduce((a, c) => a + c.charCodeAt(0), 0) % 2;
    const anchors = [
      `真人角色一致性要求：同一位中国年轻女性数字人，26-30岁，气质干净专业但有亲和力；鹅蛋脸偏小，下颌线柔和清晰，额头饱满，发际线自然；自然平直眉，眉尾略收，杏眼偏圆，双眼皮自然，眼神专注但不锐利；鼻梁中等偏挺，鼻头圆润不过分尖；嘴唇厚薄适中，微笑时嘴角轻微上扬；肤色自然白皙偏暖，妆容清淡，唇色豆沙或浅玫瑰；黑棕色中长发，锁骨到肩下长度，三七分或自然中分，发尾微内扣；身形中等偏瘦，肩颈舒展，穿浅米色针织衫或白色衬衫，搭配深色简洁下装。所有出现人物的镜头保持同一张脸、同一发型、同一服装、同一体态和同一表情习惯，不能换人、不能脸型漂移。`,
      `真人角色一致性要求：同一位中国年轻男性数字人，27-32岁，气质理性松弛、像懂技术的朋友；脸型为偏长的清瘦椭圆脸，下颌线利落但不锋利，额头开阔；眉毛自然偏浓，眼型细长偏内双，眼神稳定专注；鼻梁中等偏高，鼻翼自然；嘴唇偏薄，讲话时表情克制，有轻微吐槽感和理性幽默；肤色自然偏暖，皮肤质感真实不过度磨皮；黑色短发，侧分或自然蓬松，发际线自然；身形中等偏瘦，肩背挺直，穿浅蓝或白色衬衫、深色休闲外套或针织开衫。所有出现人物的镜头保持同一张脸、同一发型、同一服装、同一体态和同一表情习惯，不能换人、不能脸型漂移。`
    ];
    return anchors[n];
  },

  _mockCopy({ topic, shots, account, product = null, kind = "image", batchVariant = null, avoidCopies = [] }) {
    const intent = inferCopyIntent({ topic, shots, account, product, useAccountPosition: false });
    const titles = copyTitlePool(intent, kind, batchVariant);
    let idx = Math.abs((account?.name || "").length + (topic || "").length + Number(batchVariant?.index || 0)) % titles.length;
    let out = { title: titles[idx], copy: fallbackXhsCopy({ intent, shots, account, kind, batchVariant, product }) };
    if (tooSimilarCopy(out, avoidCopies)) {
      idx = (idx + 3) % titles.length;
      out = { title: titles[idx], copy: fallbackXhsCopy({ intent, shots, account, kind, batchVariant: { ...batchVariant, key: "mistake-fix" }, product }) };
    }
    if (kind === "video") {
      const topicText = String(topic || "");
      const raw = `${topic || ""} ${(shots || []).map(s => `${s.idea || ""} ${s.line || ""}`).join(" ")}`;
      const ensure = (topicTest, rawTest, must, title, line) => {
        if (!topicTest.test(topicText) && !rawTest.test(raw)) return;
        if (!must.test(out.title || "")) out.title = title;
        if (!must.test(out.copy || "")) out.copy = `${line}\n${out.copy || ""}`.trim();
      };
      ensure(
        /会议|录音|聊天记录|纪要|待办|会后/,
        /会议|录音|纪要|会后/,
        /会议|录音|聊天记录|纪要|待办|复盘/,
        "会议待办复盘别再手动翻",
        "这条会从会议录音和聊天记录讲起：先把原话、待办和责任人整理清楚，再写一版能追踪的复盘。"
      );
    }
    const cleaned = {
      title: stripOwnProductMentions(replaceReferenceToolNames(out.title, product), product),
      copy: stripOwnProductMentions(replaceReferenceToolNames(out.copy, product), product)
    };
    return kind === "video" ? polishVideoBrandCopy(cleaned, product) : cleaned;
  }
};

window.XingzhenAI = AI;
window.DumateAI = AI; // 兼容旧调试入口
