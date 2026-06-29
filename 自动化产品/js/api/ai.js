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
- 信息密度高、可复制：给出具体工具名、步骤、指令模板、前后对比、数字和适用场景；分点可以用 ①②③、👉、✅，但不要每段都堆同一种符号。
- 少写假剧情，尤其不要"上周领导突然…"这种短剧感开头；优先写真实踩坑、真实效率变化、能直接复制的方法。
- 开头可以反常识或结论先行：例如"才知道不同 AI 真有分工""我把小红书 SOP 装进了一个固定流程""一分钟搞定思维导图不是玄学"。
- 结尾自然收束，可以给一个适用场景/避坑提醒/复盘结论；不要强行求评论、求收藏、喊下载。最后一行 4-7 个贴合定位的话题标签（#开头），标签要具体，不只写泛泛的 #AI工具。
- 严禁 AI 腔与硬广腔：不要"赋能/助力/高效便捷/一站式/打造闭环"这类空话，不要通篇形容词没有实质内容。宁可具体、口语、有细节。文案要紧扣脚本里的真实内容来写，有含金量。`;

const XHS_COPY_STYLE = `

【AI 博主小红书文案参考风格】
- 标题优先用：对比选择型、结论前置型、反转吐槽型、清单合集型。像"打工人别再手动整理文件了""说实话 这个桌面 AI 比想象中能干""3步把乱文件夹收拾干净"这类真实用户标题。
- 选题和标题不必每次硬带产品名。可以借同类高流量词切入，例如 AI Agent、桌面智能体、AI办公、效率工具、无代码应用、Codex、WorkBuddy、DeepSeek，再在正文自然落到本次产品。
- 标签组合用「品类词 + 场景词 + 流量词 + 品牌词」：例如 #AI工具 #桌面智能体 #效率工具 #自动化办公 #打工人效率。不要只写品牌词。
- 正文不要把创作内容原文当开头。先提炼一个真实痛点或反常识体验，再分点讲清具体方法。
- 口吻像朋友推荐：可以写"我也是被安利的""本来没抱期望""试了一圈才发现""说实话"；优点缺点都可以说一点，增强真实感。
- 少呼吁、少广告，不要"快去下载""立刻体验"；结尾用适用场景、避坑提醒或评论问题自然收束。
- 图文笔记正文适合 300-520 字，段落短，信息密度高，有步骤、有场景、有结果。`;

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

function inferCopyIntent({ topic = "", shots = [], account = null, product = null, useAccountPosition = true }) {
  const productName = product?.shortName || product?.name || "百度搭子";
  const raw = [topic, useAccountPosition ? account?.position : "", account?.tone, ...(shots || []).flatMap(s => [s.idea, s.line, s.visual])].join(" ");
  const cleaned = stripPromptMeta(raw);
  const lower = cleaned.toLowerCase();
  const audience = /学生|毕业|论文|导师|课件|考点/.test(cleaned) ? "学生党"
    : /自媒体|小红书|选题|素材|脚本|图文/.test(cleaned) ? "内容创作者"
    : /合同|报表|Excel|PPT|Word|PDF|周报|会议|文件|数据|汇报/.test(cleaned) ? "打工人"
    : /老师|教学|课件/.test(cleaned) ? "老师"
    : "办公人";
  const pain = /论文|导师|毕业/.test(cleaned) ? "论文资料和数据整理太磨人"
    : /周报|汇报/.test(cleaned) ? "周报汇报每次都要反复整理"
    : /PDF|Word|格式|转换/.test(cleaned) ? "文件格式来回转换太耗时间"
    : /Excel|表格|数据/.test(cleaned) ? "表格数据整理和提取太费脑"
    : /会议|录音|纪要/.test(cleaned) ? "会议纪要和录音复盘太拖时间"
    : /素材|选题|脚本/.test(cleaned) ? "选题素材越攒越乱"
    : /文件|归档|分类/.test(cleaned) ? "桌面文件乱到找不到重点"
    : "重复办公动作太占精力";
  const action = /PDF|Word|格式|转换/.test(cleaned) ? "一句话交代转换和提取规则"
    : /Excel|表格|数据/.test(cleaned) ? "把表格丢进去让它提重点和做结构"
    : /会议|录音|纪要/.test(cleaned) ? "把录音和资料交给它整理成纪要"
    : /素材|选题|脚本/.test(cleaned) ? "让它按目标人群拆选题和脚本"
    : /文件|归档|分类/.test(cleaned) ? "让它按类型自动分类归档"
    : "把需求像跟同事说话一样说清楚";
  const result = /论文|导师|毕业/.test(cleaned) ? "资料、考点和报告结构能更快理顺"
    : /周报|汇报/.test(cleaned) ? "最后直接得到能继续加工的汇报骨架"
    : /PDF|Word|格式|转换/.test(cleaned) ? "格式转换和金额/字段提取能一起完成"
    : /Excel|表格|数据/.test(cleaned) ? "数据重点和图表结构能快速出来"
    : /会议|录音|纪要/.test(cleaned) ? "重点、待办和复盘结论更清楚"
    : /素材|选题|脚本/.test(cleaned) ? "素材能变成可执行的内容清单"
    : "重复步骤被固定成流程";
  const scene = lower.includes("dumate") || /Dumate|百度搭子/.test(cleaned) ? `${productName} 桌面端`
    : productName;
  return { productName, audience, pain, action, result, scene };
}

function copyTitlePool(intent, kind = "image") {
  const p = intent.productName;
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
  if (kind === "image") {
    base.push(`3步把${intent.pain.replace(/太.+$/, "")}理顺`);
    base.push(`${intent.audience}后悔没早用的整理方法`);
  }
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

function polishCopyResult(result, { topic, shots, account, kind, product }) {
  const intent = inferCopyIntent({ topic, shots, account, product, useAccountPosition: kind === "video" });
  let title = sanitizeProduct(String(result?.title || "").trim());
  let copy = sanitizeProduct(String(result?.copy || "").trim());
  if (!title || looksLikeRawBrief(title, topic)) {
    const pool = copyTitlePool(intent, kind);
    title = pool[Math.abs((topic || "").length + (shots || []).length) % pool.length];
  }
  if (!copy || looksLikeRawBrief(copy.slice(0, 80), topic) || /想要宣传|画面风格|不要有页码|利他性强/.test(copy)) {
    copy = fallbackXhsCopy({ intent, shots, account, kind });
  }
  return { title, copy };
}

function fallbackXhsCopy({ intent, shots = [], account = {}, kind = "image" }) {
  const lines = (shots || []).map(s => stripPromptMeta(s.line || s.idea || s.visual || "")).filter(Boolean);
  const usableLine = (x) => x && x.length >= 10 && x.length <= 42 && !/面向|有真实的感觉|小红书|配图|画面|构图|白底|无页码|不要|整体|参考|风格|按钮|高亮|截图|文案|打开\s*Dumate|一句话交给|自己动手干|效率交给/.test(x);
  const dataLike = /论文|课件|考点/.test(intent.pain) ? "资料、课件、表格和导师要求"
    : /周报|汇报/.test(intent.pain) ? "本周进展、数据截图和零散结论"
    : /格式|转换/.test(intent.pain) ? "PDF、Word、合同和字段要求"
    : /表格|数据/.test(intent.pain) ? "Excel、CSV 和关键指标"
    : /会议/.test(intent.pain) ? "录音、聊天记录和会议待办"
    : "文件、截图和零散需求";
  const nuggets = [
    `① 先别急着让工具"全自动"。我会先把${dataLike}放在同一个任务里，告诉它最终要什么结果。`,
    `② 指令尽量写成一句可执行的话，比如"${intent.action}，最后给我一份能复核的清单"。`,
    `③ 中间别只看它跑没跑完，要看它有没有把关键字段、分类逻辑和遗漏项列出来。`,
    `④ 真正省时间的是最后一步：${intent.result}，你只需要核对结论，不用从头搬数据。`
  ];
  const fromShots = lines.filter(usableLine).slice(0, 3).map((x, i) => `${["①", "②", "③"][i]} ${x.replace(/[。！？!?]+$/, "")}`);
  const points = fromShots.length >= 3 ? fromShots : nuggets;
  const openerPool = [
    `我也是试了一圈才发现，${intent.pain}这件事，真的没必要全靠手动硬扛。`,
    `本来没抱太大期待，结果用 ${intent.scene} 跑了一遍，才发现省时间的点不在"更快点击"，而在流程被固定住。`,
    `说实话，${intent.audience}最烦的不是不会做，而是同一套重复动作每次都要重新来。`
  ];
  const opener = openerPool[(intent.pain.length + (account.name || "").length) % openerPool.length];
  const ending = kind === "video"
    ? `比较适合那种每天都有重复办公动作的人。它不是万能，但把低价值的整理活先挡掉，脑子就能留给更重要的判断。`
    : `适合当一个小 SOP 留着：先给资料，再给目标，再让它输出可复核的结果。这样不夸张，但确实能少掉很多重复整理。`;
  const tags = `#AI办公 #自动化办公 #打工人效率 #${intent.audience} #${intent.productName.replace(/[ /]/g, "")}`;
  return `${opener}\n\n${points.join("\n")}\n\n${ending}\n\n${tags}`;
}

function allProductsForAI() {
  return (state.products && state.products.length) ? state.products : PRODUCT_CATALOG_SEED;
}

function isDumateProduct(product) {
  const text = `${product?.id || ""} ${product?.name || ""} ${product?.shortName || ""}`;
  return !product || /dumate|百度搭子|搭子/i.test(text);
}

function baseProductFacts(product) {
  return isDumateProduct(product) ? DUMATE_BRIEF + "\n\n" : "";
}

function productListLine(list = []) {
  return list.map(p => `${p.shortName || p.name}（${p.category || "同类工具"}）`).join("、");
}

function productAliases(product) {
  return [product?.name, product?.shortName, product?.id]
    .filter(Boolean)
    .flatMap(x => String(x).split(/[\/｜|、\s]+/))
    .map(x => x.trim())
    .filter(x => x && x.length >= 2);
}

function currentProductLine(product) {
  const p = product || {};
  const aliases = productAliases(p).filter(x => !/^[a-z0-9_-]+$/i.test(x) || /dumate|codex|cursor|manus|trae|windsurf|openclaw|obsidian|workbuddy/i.test(x));
  return `当前产品已锁定：${p.name || "本次产品"}${p.shortName ? `（短名：${p.shortName}）` : ""}。账号名、旧主题或历史素材里若出现其他产品名，只能当作旧数据，不得改写成本次产品。${aliases.length ? `选题可以不硬带产品名，但如果出现产品名，必须优先使用：${aliases.join(" / ")}。` : ""}`;
}

function productTopicFallback(product, rel = []) {
  const p = product || {};
  const name = p.shortName || p.name || "本次产品";
  const source = [
    ...(p.tutorialAngles || []),
    ...(p.blogAngles || []),
    ...(p.comparisonAngles || [])
  ].filter(Boolean);
  const base = source[(name.length + source.length) % Math.max(1, source.length)] || "真实使用流程复盘";
  if (/对比|分工|区别/.test(base) && rel.length) {
    const other = rel[0]?.shortName || rel[0]?.name || "同类工具";
    return cleanText(`${name}和${other}怎么分工`).slice(0, 18);
  }
  return cleanText(`${name}${base}`.replace(/百度秒哒秒哒|秒哒秒哒/g, "秒哒")).slice(0, 18);
}

function enforceCurrentProductTopic(topic, product, rel = []) {
  const t = cleanText(topic || "").replace(/[。.\n"'`]/g, "").slice(0, 18);
  if (!product) return t;
  const isMiaoda = /miaoda|百度秒哒|秒哒/i.test(`${product.id || ""} ${product.name || ""} ${product.shortName || ""}`);
  const isDumate = isDumateProduct(product);
  const wronglyDumate = !isDumate && /Dumate|百度搭子|搭子/.test(t);
  const wronglyMiaoda = !isMiaoda && /百度秒哒|秒哒/.test(t);
  const miaodaCapabilityLeak = isMiaoda
    && /文件整理|乱文件|桌面|会议数据|会议纪要|合同|PDF|Word|Excel|归档|格式转换|本地文件/.test(t)
    && !/应用|页面|H5|原型|小工具|CRM|后台|数据表|报名页/.test(t);
  if (wronglyDumate || wronglyMiaoda || miaodaCapabilityLeak) return productTopicFallback(product, rel);
  return t || productTopicFallback(product, rel);
}

function productBrief(product) {
  const p = product || {};
  const name = p.name || "Dumate / 百度搭子";
  const rel = relatedProducts(p, allProductsForAI(), 5);
  const ownerLine = p.owner === "ours" ? "我们的产品" : p.owner === "competitor" ? "竞品/同类产品" : "产品";
  const featureLine = (p.coreFeatures || []).slice(0, 8).join(" / ");
  const tutorialLine = (p.tutorialAngles || []).slice(0, 5).join("；");
  const comparisonLine = (p.comparisonAngles || []).slice(0, 5).join("；");
  const blogLine = (p.blogAngles || []).slice(0, 5).join("；");
  return `【本次宣传产品】${name}
产品身份：${ownerLine}
产品类别：${p.category || "办公效率 AI Agent"}
核心信息：${p.brief || "桌面端 AI Agent，可理解一句话指令并自动完成文件整理、格式转换、信息提取、数据分析、汇报生成和网页自动操作。"}
核心能力：${featureLine || "按产品事实展开，不编造未确认能力。"}
教程选题可用角度：${tutorialLine || "围绕真实使用流程和可复用方法展开。"}
对比/测评可用角度：${comparisonLine || "可与同类工具做场景、能力边界、适用人群对比。"}
AI 博主视角：${blogLine || "像真实创作者做工具观察，不只硬讲单个产品。"}
可参考同类产品：${productListLine(rel) || "无"}
表达要求：${p.toneRule || "可信、理性、有梗、像真实用户经验分享；不要硬广，不要强 CTA。"}
脚本和提示词里必须围绕本次产品写；可以引用同类产品做对比、合集或场景分工，但不能把竞品能力误写成本次产品能力。`;
}

function topicalHook(product) {
  return `${TOPICAL_HOOK}

【产品数据库选题意识】
- 你是 AI 博主/工具观察者，不是单一产品说明书。选题可以是教程、对比、测评、场景清单或工具分工。
- 本次主产品优先讲清真实能力；同类产品只作为对照、背景或合集视角，不要喧宾夺主。
- 如果做教程，既可以只讲本次产品的完整流程，也可以提到"这一类工具怎么选/怎么分工"，再自然落到本次产品。
- 如果做图文，画面信息要像真实博主整理出来的经验：对比表、流程卡、工具分工图、评分卡、真实桌面场景都可以用。

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
    title: "资料从乱到顺",
    role: "让用户一眼知道这篇笔记解决什么具体办公麻烦",
    layout: "左侧放大具体功能标题与一句结果短句，右侧放产品/桌面结果画面，底部留一个动作标签区",
    visual: "用混乱文件、待处理表格、消息提醒或任务卡片展示真实办公麻烦，再用一块干净的结果界面形成对比"
  },
  {
    title: "资料堆积现场",
    role: "把读者常遇到的混乱场景拆成可识别的问题清单",
    layout: "上方大标题，中间用两到三张卡片横向排布待处理资料，右下角放模糊界面缩略图",
    visual: "文件夹层层嵌套、表格列名混乱、聊天消息和便签交错出现，关键文字只保留真实场景短句"
  },
  {
    title: "一句话交代任务",
    role: "展示一句指令或一个流程如何把问题接住",
    layout: "中央放输入框或流程主卡，左右两侧用箭头连接原始资料和处理结果",
    visual: "鼠标光标停在输入框旁，文件卡片被自动归类，进度条或步骤圆点用蓝紫色高亮"
  },
  {
    title: "三个动作跑完",
    role: "把方法拆成可复制的步骤，而不是只展示结果",
    layout: "三段式竖向动作卡，每段直接写动词短句，不使用编号词",
    visual: "每一段都对应一个清楚动作：拖入资料、识别字段、生成结果，卡片层级有轻微阴影和留白"
  },
  {
    title: "整理结果可复用",
    role: "让用户看到前后变化，建立可信度",
    layout: "左右对比结构，左边是处理前的混乱，右边是处理后的整齐结果，中间用细箭头连接",
    visual: "结果区出现整齐文件夹、统计卡片、报告缩略图或清爽表格，文字做模糊化处理但结构清晰"
  },
  {
    title: "少做重复整理",
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
  return cut.replace(/[，、；：,.!?！？。]*$/, "");
}

const INTERNAL_IMAGE_LABEL_RE = /(封面|痛点引入|问题引入|解决路径|关键步骤|结果对比|总结收束|收束|图片任务|第\d+\/\d+张|第\d+张|图\d+)/g;
const IMAGE_PLANNING_WORD_RE = /(种草|种草感|构图|版式|画面定位|图片定位|内容页|开头钩子|钩子|共鸣场景|共鸣|痛点|痛点引入|问题引入|解决路径|关键步骤|结果对比|总结收束|自然收束|收束|封面|首图|图片任务|核心思想|视觉线索|提示词|文案|截图|图上文字|干货步骤|步骤[一二三四五六七八九十\d]*)/g;
const BAD_IMAGE_HEADLINE_RE = /^(图\d+|第\d+张|内容页|干货步骤|核心思想|画面|版式|构图|文案|截图|提示词|视觉线索|封面|首图|种草|共鸣|痛点|痛点引入|问题引入|解决路径|关键步骤|结果对比|总结收束|自然收束|收束|图片任务|步骤[一二三四五六七八九十\d]*)|想要宣传|不要有页码|利他性强|账号定位|参考图|整体的画面|图\d+\s*[·.-]\s*干货步骤|[｜|<>]/;

function cleanImagePlanningWords(text = "") {
  return cleanText(text)
    .replace(/清爽种草感/g, "清爽真实分享感")
    .replace(/种草感/g, "真实分享感")
    .replace(/轻种草/g, "轻推荐")
    .replace(/种草/g, "推荐功能")
    .replace(/痛点/g, "待处理问题")
    .replace(/共鸣/g, "真实场景")
    .replace(/构图/g, "画面结构")
    .replace(/版式/g, "画面布局")
    .replace(/封面/g, "大字标题页")
    .replace(/首图/g, "大字标题")
    .replace(/关键步骤/g, "关键动作")
    .replace(/步骤([一二三四五六七八九十\d]*)/g, "动作$1")
    .replace(/开头钩子|钩子/g, "开头问题")
    .replace(/结果对比/g, "前后变化")
    .replace(/总结收束|自然收束|收束/g, "结论")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanImageDisplayTitle(text = "", fallback = "资料整理完成") {
  const raw = shortChinese(cleanImagePlanningWords(text), 18);
  if (!raw || BAD_IMAGE_HEADLINE_RE.test(raw)) return fallback;
  return raw;
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
  const raw = cleanImagePlanningWords(stripPromptScaffold(text || ""))
    .replace(/模型给出的视觉线索可提炼为[:：]?/g, "")
    .replace(/参考脚本如下[:：]?/g, "")
    .replace(/(?:核心思想|画面|文案|visual|line|idea)[:：]/gi, "")
    .replace(/图上文字[:：]/g, "画面短句：")
    .replace(/[｜|<>]/g, "，")
    .replace(/^[，,。；、\s]+|[，,。；、\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/面向|讲清楚|重点是|画面要|用户输入|创作内容|不要有|整体风格|利他性|直接加入|生成小红书笔记风格|^信息按|^所有文字|^画面文字|图片定位|画面定位/.test(raw)) return "";
  if (!raw || BAD_IMAGE_HEADLINE_RE.test(raw.slice(0, 24))) return "";
  return shortChinese(raw, max);
}

function stripPromptScaffold(text = "") {
  return cleanImagePlanningWords(stripPromptMeta(text || ""))
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

function summarizeImageIntent({ script = "", topic = "", account = {}, product = null }) {
  const src = stripPromptMeta(cleanText(topic || script || ""));
  const inferred = inferCopyIntent({ topic: src, account, product, useAccountPosition: false });
  const productName = product?.shortName || product?.name || "这个工具";
  const compact = src
    .replace(/(请|帮我|生成|做一篇|做一个|图片|图文|笔记|提示词|小红书)/g, "")
    .replace(/面向[^，。；\n]*[，。；]?/g, "")
    .replace(/讲清楚|重点是|画面要像|真实小红书效率笔记/g, "")
    .replace(/图\d+[:：][^。；\n]+/g, "")
    .replace(/(?:核心思想|画面|文案|visual|line|idea)[:：]/gi, "")
    .replace(/[｜|<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const inferredMain = `${inferred.audience}${inferred.pain.replace(/^(.{2,8})?太/, "").replace(/太/g, "")}`;
  const main = compact && !/面向|讲清楚|重点是|不要有|画面风格/.test(compact)
    ? shortChinese(compact, 36)
    : shortChinese(inferredMain, 36) || `${productName}办公效率方法`;
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
    `${intent.audience}别再手动熬`,
    `${intent.pain || "重复动作"}到底卡在哪`,
    `一句话把流程跑起来`,
    `三步把资料理顺`,
    `前后对比很明显`,
    `把重复动作交给流程`
  ];
  const candidates = [
    item?.headline,
    item?.title,
    fromLine,
    i === 0 ? `${intent.main}怎么破` : "",
    fallbackByTask[Math.min(i, fallbackByTask.length - 1)]
  ];
  const picked = candidates
    .map(x => cleanImageDisplayTitle(x, ""))
    .find(x => x && !BAD_IMAGE_HEADLINE_RE.test(x));
  return picked || fallbackByTask[Math.min(i, fallbackByTask.length - 1)] || `${intent.productName}到底省在哪`;
}

function richImagePrompt(item, i, total, ctx) {
  const task = IMAGE_CARD_TASKS[Math.min(i, IMAGE_CARD_TASKS.length - 1)] || IMAGE_CARD_TASKS[IMAGE_CARD_TASKS.length - 1];
  const intent = summarizeImageIntent(ctx);
  const sourcePrompt = stripPromptScaffold(cleanText(item?.prompt || item?.idea || item?.line || ""));
  const cue = cleanImagePromptSignal(stripInternalImageLabels(sourcePrompt), 72);
  const contentCue = cue
    ? `内容线索：把「${cue}」拆成一个真实办公场景，明确出现待处理资料、操作动作、结果界面三层信息。`
    : `围绕「${intent.main}」重新组织信息，明确出现待处理资料、操作动作、结果界面三层信息。`;
  const title = cleanImageDisplayTitle(item?.title, task.title);
  const headline = deriveImageHeadline(item, i, intent, task);
  const imageStyle = ctx.style
    ? shortChinese(cleanImagePlanningWords(stripPromptScaffold(stripFieldLabel(ctx.style, "账号风格"))), 130)
    : "白底或浅色底，圆角卡片，大留白，真实办公截图质感，蓝紫点缀，文字大而清楚。";
  const refPrefix = ctx.styleRefName
    ? `请根据上传的参考图（${ctx.styleRefName}），综合参考产品界面层级、品牌色、截图质感和视觉密度；不要复制参考图里的旧标题和示例文案。`
    : "";
  const productLine = ctx.product ? `产品/应用：${intent.productName}，只在流程或界面里自然出现。` : "产品表达以真实办公流程和界面结果为主。";
  const promptBody = cleanImagePlanningWords(`${refPrefix}生成小红书笔记风格3:4尺寸图片。【图片风格：${imageStyle}】图片具体内容：【${productLine} ${task.layout}；${task.visual}；${contentCue}把待处理资料、执行动作、可复用结果放进界面、文件、数据卡片或桌面物件里，不能照抄用户输入。画面文字只放大标题「${headline}」和一句短副标题，最多2个具体功能标签，例如“自动归类”“字段识别”“报告可用”。】`);
  return {
    title,
    ui: item?.ui !== false,
    prompt: normalizeImageSizeText(`${promptBody}${minimalImageNegative()}`)
  };
}

function normalizeImagePromptItems(items, ctx) {
  const n = Math.max(3, Math.min(12, Number(ctx.imageCount) || (items || []).length || 6));
  const src = Array.isArray(items) ? items : [];
  return Array.from({ length: n }, (_, i) => richImagePrompt(src[i] || {}, i, n, ctx));
}

export const AI = {
  lastSource: "mock",
  lastError: "",

  _ok(d) { this.lastSource = "llm"; this.lastError = ""; return d; },
  _fb(e) { this.lastSource = "mock"; this.lastError = (e && e.message) || String(e || "网络/CORS"); },

  sourceNote(okMsg) {
    return this.lastSource === "llm" ? okMsg : `API 未通（${this.lastError || "网络/CORS"}），已用本地模板`;
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
- 按账号定位决定风格：偏知识/测评就讲出真东西——给具体数字、横向对比、反常识结论、可复用的方法；偏轻松就有梗有节奏（口语、自嘲、神转折），让人忍不住看完。
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
        { role: "user", content: `账号定位：${account.position}\n语气：${account.tone || "教程感"}\n平台：${account.platform}\n主题：${topic}\n先用当下热点/真实痛点切入并和主题焊在一起，再自然安利产品（不硬塞，全篇自然提到 1-2 次即可）。口播要有信息量、利他、理性可信，可以有梗但不油，结尾不要任何引导关注/下载的话。${topicalHook(product)}${this.memoryLine(account)}` }
      ], { json: true, temperature: 0.85 });
      const d = parseJSONLoose(content);
      if (!d.shots || d.shots.length < 8) throw new Error("模型未返回足够镜头");
      return this._ok({ title: cleanText(d.title) || topic, shots: d.shots.map((x, i) => ({
        idea: cleanText(x.idea), visual: cleanText(x.visual), line: stripCTA(cleanText(x.line)),
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
- 每个 videoPrompt 只输出最终视频生成指令，不要写“参考脚本如下 / 账号定位参考 / 主体设定 / 镜头依据”等解释给人的文字，不要额外发明声音标签。
- 真人/数字人账号若已有统一角色参考图，第一段固定博主可以正脸出镜并用参考图锁定同一张脸；非第一段不要写固定博主，不要写无关出镜人的脸部特写。
- 不要写“这句话自然说完、吐字清楚、不要压缩语速”这类空泛限制；真正控制每段口播字数，让时间结构本身能读完。
- 负面约束只能放在每个 videoPrompt 的最后一段，前面不要重复写。负面约束统一使用：「${NEG}」${style ? `\n- 整体画面风格基调：${style}。` : ""}

只输出 JSON：{"units":[{"videoPrompt":"镜头…完整分段提示词"}]}，顺序与单元一致，数量等于单元数。`;
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + sys },
        { role: "user", content: `账号定位：${account.position}\n共 ${units.length} 个单元：\n${unitText}` }
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
    const productName = product?.shortName || product?.name || "本次产品";
    const v = us.map(s => s.visual || s.idea || "").filter(Boolean)[0] || `${productName}产品界面与整洁桌面`;
    const lines = us.map((s, i) => `画面依据${i + 1}：${s.visual || s.idea || ""}`).join("；");
    return cleanText(`9:16竖版分镜首帧定帧，真实办公产品广告质感，${style || "白底极简、科技蓝紫渐变(#3f6bff→#9a45ff)、圆角卡片UI、大留白、干净现代办公感"}。画面结构为桌面/电脑屏幕/人物手部或办公环境的稳定中近景，主体关系清晰：屏幕占画面主要视觉中心，前景可见键盘、鼠标、咖啡杯或文件夹等真实办公物件，背景保持浅景深虚化。光线为正面偏侧的明亮柔光，冷暖适中，屏幕区域清晰但不刺眼，桌面材质干净。核心画面：${v}。${lines}。${productName}产品界面必须清晰呈现，界面只保留少量大字号中文，例如「整理资料」「生成页面」「数据分析」「生成报告」等可读模块。画面不要字幕、不要花字、不要二维码、不要乱码、不要密集小字、不要多余下载按钮。`);
  },
  _fbUnitVideo(u, shots, style, NEG, opts = {}) {
    const us = (u.shotIndexes || []).map(k => shots[k]).filter(Boolean);
    const account = opts.account || {};
    const productName = opts.product?.shortName || opts.product?.name || "本次产品";
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
    const hasMetaText = /主体设定|角色设定|参考脚本|旁白含义|镜头依据|账号定位参考|声线锚点|<[^>]+>/.test(prompt);
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
    const productName = product?.shortName || product?.name || "本次产品";
    const fallback = (s, i) => cleanText(`这是一条${productName}产品视频的单镜头素材，9:16 竖屏，时长${Math.ceil(perShot[i]?.dur || 4)}秒，场景/产品界面混剪，纯画面无人声。画面内容：${s.visual || s.idea || "产品界面演示"}。镜头语言：${i % 2 ? "缓推" : "横移"}运镜、干净画面结构、明亮柔光${style ? `；整体风格：${style}` : ""}。${MATERIAL_VIDEO_NEG}`);
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + `\n\n你为素材混剪视频逐镜头生成视频提示词：每个镜头一条独立提示词，对应生成一段独立的视频素材片段。每条开头写明"9:16竖屏，时长N秒，场景/产品界面混剪，纯画面无人声"。画面具体到景别/机位运镜/界面文字/动效/光线，禁止抽象词。每条结尾都必须带上这段负面提示词："${MATERIAL_VIDEO_NEG}"。只输出 JSON：{"shots":[{"prompt":"..."}]}，数量与镜头数一致。` },
        { role: "user", content: `账号定位：${account.position}\n${style ? `画面风格：${style}\n` : ""}共 ${shots.length} 个镜头（含各自时长）：\n${shots.map((s, i) => `${i + 1}. [${Math.ceil(perShot[i]?.dur || 4)}秒] ${s.visual || ""}`).join("\n")}` }
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
      return [
        `给${tags.length ? "所有" + pick(tags) + "标签的" : "全部"}账号做「${own.shortName || own.name} ${t1}」`,
        `给图文组做${own.shortName || own.name}和${comp.shortName || comp.name}对比`,
        `给素材号全自动出一批「${t3}」AI博主视角`
      ];
    };
    try {
      const content = await llm([
        { role: "system", content: `根据账号矩阵和产品知识库，给内容量产 Agent 生成 3 条一句话指令建议。要求像真实 AI 博主选题：可以做教程、对比、测评、工具分工或场景清单；优先使用我们的产品，也可以引入竞品/同类产品做横向对比；主题每次新颖不重复；指明范围（全部 / 某标签 / 图文组 / 真人 / 素材号）；每条不超过 32 字；只输出 JSON：{"suggestions":["...","...","..."]}` },
        { role: "user", content: `账号矩阵：${JSON.stringify(accounts.map(a => ({ 名称: a.name, 分组: a.mode === "图文" ? "图文组" : a.subType === "数字人" ? "真人" : "素材", 定位: (a.position || "").slice(0, 30), 标签: a.qtags || [] })))}\n产品知识库：${JSON.stringify(productList.map(p => ({ 名称: p.name, 身份: p.owner === "ours" ? "我们的产品" : "竞品", 类别: p.category, 选题角度: (p.blogAngles || p.tutorialAngles || []).slice(0, 3), 可对比: (p.comparisonAngles || []).slice(0, 2) })))}\n随机种子：${Math.random().toString(36).slice(2, 8)}` }
      ], { json: true, temperature: 1.2 });
      const d = parseJSONLoose(content);
      if (Array.isArray(d.suggestions) && d.suggestions.length >= 3) return this._ok(d.suggestions.slice(0, 3).map(s => String(s).slice(0, 40)));
      throw new Error("空");
    } catch (e) {
      this._fb(e);
      return offline();
    }
  },

  /* ---------- 脚本生成 ---------- */
  async generateScript({ topic, duration = 30, account, image, direction = "", style = "", imageCount = 6, product = null, imageTemplate = "", styleRefName = "" }) {
    const hasImageTemplate = image && String(imageTemplate || "").trim();
    const dirText = image
      ? (direction ? `本次创作内容：${direction}。` : `本次创作内容：围绕主题自由发挥，但每张图都要有清晰信息点。`)
      : (direction ? `目标人群方向：${direction}（脚本语气、痛点、例子都贴合这个人群）。` : `人群方向：不限，自由发挥最合适的角度。`);
    const nImg = Math.max(3, Math.min(12, imageCount || 6));
    const sys = image
      ? `你是小红书图文笔记策划，为百度 ACG 市场部写「小红书笔记图卡内容表」，每行是笔记里的一张配图。严格围绕用户本次创作内容展开，不要让账号定位改变主题方向；账号只提供创作风格。标题和图上文案要像真实笔记，具体、有信息量、能让人看懂功能和结果。图文没有口播，只有画面与图上文案。每行 idea 写清这张图要传达的信息；visual 必须非常具体（画面布局/主视觉/界面里出现的具体文字/配色/光线/产品视觉位置），先在脑内把这张图具象化成真实画面再写，不要用电影感、高级感、种草感这类抽象词。内部结构词不要出现在 idea、visual、line 里。${hasImageTemplate ? `账号配置了固定图文模板，必须优先遵守模板的风格、画面语言、参考图使用方式和统一要求；但模板中的张数、主题、产品名、各图内容都要按本次创作内容重写，最终 shots 必须正好 ${nImg} 行。` : ""}只输出 JSON：{"title":"小红书笔记风标题","shots":[{"idea":"核心思想","visual":"非常具体的画面","line":"图上文案(小红书笔记口吻、精简)"}]}，shots 必须正好 ${nImg} 行。`
      : (account.subType === "无数字人"
        ? `你是百度 ACG 市场部资深短视频编剧，写指定产品教程【无数字人】视频：没有固定出镜人物，以场景/产品界面/手部操作混剪为主，line 写专业画外音旁白。成片控制在45-58秒，绝不超过60秒，拆成8-10个镜头；每镜头口播1句，尽量12-24个中文字符，单句至少能自然说3秒，不要赶。偏教程专业可信、理性有梗、不要信息流硬广。visual 非常具体：景别、机位运镜(固定/缓推/横移/跟随)、产品界面模块、界面动效(卡片滑入/进度条/局部高亮)、配色、光线，禁止电影感/高级感/种草感等抽象词。visual 里不要安排叠加字幕/标题文字。每镜头带 ui(true/false) 和 scene(连续场景编号)。只输出 JSON：{"title":"标题","shots":[{"time":"0-4s","idea":"核心思想","visual":"非常具体的画面分镜","line":"专业画外音旁白","ui":true,"scene":1}]}。`
        : `你是百度 ACG 市场部资深短视频编剧，写指定产品教程【真人/数字人口播】视频。成片控制在45-58秒，绝不超过60秒，拆成8-10个镜头；每镜头口播1句，尽量12-24个中文字符，单句至少能自然说3秒，不要赶。结构上有真人开场、有产品场景演示、有真人收束，但不要死板两段式。内容丰富、偏教程专业可信、理性有梗、不要信息流硬广：口播像真实经验分享，能直接念。visual 非常具体：人物动作表情、产品界面模块、运镜、界面动效、配色、光线；如果后续有统一参考图，人物外貌由参考图锁定，这里不要写五官长相。禁止电影感/高级感/种草感等抽象词。visual 里不要安排叠加字幕/标题文字。每镜头带 ui(true/false) 和 scene(连续场景编号)。只输出 JSON：{"title":"标题","shots":[{"time":"0-4s","idea":"核心思想","visual":"非常具体的画面分镜","line":"口播原话","ui":true,"scene":1}]}。`);
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + sys },
        { role: "user", content: image
          ? `账号创作风格：${style || account.styleProfile || "干净可读的小红书图文风"}\n语气：${account.tone || "教程感"}\n平台：${account.platform}\n内容模式：${account.mode}\n${dirText}\n共生成 ${nImg} 张图。\n${style ? `图文总风格：${style}（所有画面统一这个视觉风格）。\n` : ""}${styleRefName ? `成图风格参考：${styleRefName}。\n` : ""}${hasImageTemplate ? `账号图文模板（只作为风格/结构母版，不要照抄示例变量）：\n${imageTemplate}\n` : ""}主题：${topic}\n围绕本次宣传产品的真实功能延展教学，优先服从用户本次创作内容，不要强呼吁下载。${topicalHook(product)}`
          : `账号定位：${account.position}\n语气：${account.tone || "教程感"}\n平台：${account.platform}\n内容模式：${account.mode}\n${dirText}\n主题：${topic}\n目标时长：${Math.min(60, duration || 55)}秒以内，最终不超过60秒。口播宁可少一点，保证每句都能自然读完。围绕本次宣传产品的真实功能延展教学，但要先用当下热点/真实痛点切入、自然安利，不要孤立自嗨，不要强呼吁下载。${topicalHook(product)}${this.memoryLine(account)}` }
      ], { json: true });
      const d = parseJSONLoose(content);
      if (!d.shots || !d.shots.length) throw new Error("模型未返回 shots");
      const cleanShots = d.shots.map((x, i) => ({
        ...x,
        idea: cleanText(x.idea),
        visual: cleanText(x.visual),
        line: image ? cleanText(x.line) : stripCTA(cleanText(x.line)),
        ui: x.ui !== false && /界面|logo|文字|屏幕|表格|数据|文档|报告|卡片|按钮|输入框|窗口/.test((x.visual || "") + (x.ui === true ? "界面" : "")),
        scene: Number.isFinite(x.scene) ? x.scene : i + 1
      }));
      return this._ok({ title: cleanText(d.title) || topic, shots: cleanShots });
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
        { role: "user", content: `${image ? `账号创作风格：${account.styleProfile || ""}` : `账号定位：${account.position}`}\n优化方向：${direction}\n当前脚本（JSON）：\n${JSON.stringify(shots)}` }
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
        { role: "user", content: `账号定位：${account.position}\n语气：${account.tone || "教程感"}\n平台：${account.platform}\n\n以下是已确定的分镜脚本，严格据此改写（每段都是独立的0-15秒视频，不要写衔接性措辞）：\n${scenesText}\n\n请为每个场景输出 segA(第一段0-15秒) 与 segB(第二段0-15秒) 完整提示词。` }
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
    const productName = product?.shortName || product?.name || "本次产品";
    return cleanText(`9:16 竖图，${styleTxt}。画面内容：${v}。镜头：中近景、固定机位、人物三分位画面结构；光线：正面偏侧暖色柔光；界面元素：${productName}产品界面，界面文字精简、大字号、清晰可读；主体动作与表情：自然放松、看向镜头或界面；背景：简洁办公桌面、浅景深虚化。${refTxt}无字幕、不叠加标题花字，不要二维码、不要乱码、不要密集小字、不要 emoji。`);
  },

  async generateStoryboardPrompts({ shots, account, style, sharedRefName, product = null }) {
    const refLine = sharedRefName ? `所有分镜图统一参考「${sharedRefName}」，保持品牌/角色一致。` : "";
    const productName = product?.shortName || product?.name || "本次产品";
    const sys = `你是${productName}视频分镜图设计师。脚本每个镜头对应生成一张静态分镜图(9:16竖图)的画面提示词，数量必须与脚本镜头数完全一致、不能少、不能留空。${style ? "统一风格：" + style + "。" : "默认白底极简、蓝紫渐变品牌色、圆角卡片 UI、大留白。"}${refLine}写每条前，先把脚本那句画面在脑内具象化成一个完整真实场景（空间环境里有什么物件、光线从哪来、人物正在做哪个具体动作、屏幕里显示什么文字数据），脚本一句话至少扩成 3-5 个可落地的具体视觉细节。每条都要非常具体：景别(中近景/特写/全景)、机位与画面结构、人物动作与表情、界面里出现的具体文字、配色、光线方向与冷暖、背景元素、产品界面出现位置。整体偏教程、专业、可信，不是信息流硬广，画面干净克制。画面里不要叠加字幕/标题/花字(产品界面本身自带的少量UI文字可以)。禁止使用『电影感/高级感/种草感/氛围感/科技感』等抽象词，要把这种感觉翻译成具体画面结构/光线/景深来写。不要 emoji、不要二维码、不要乱码。只输出 JSON：{"shots":[{"prompt":"..."}]}，shots 数量=脚本镜头数。`;
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + sys },
        { role: "user", content: `账号定位：${account.position}\n共 ${shots.length} 个镜头，请输出 ${shots.length} 条提示词：\n${shots.map((x, i) => (i + 1) + ". " + (x.visual || "")).join("\n")}` }
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
  async generateImagePrompts({ script, account, style, imageTemplate = "", styleRefName = "", imageCount = 6, product = null, topic = "" }) {
    const tpl = String(imageTemplate || "").trim();
    const nImg = Math.max(3, Math.min(12, imageCount || 6));
    const safeTopic = sanitizeXhsText(topic || "");
    const safeScript = sanitizeXhsText(script || "");
    const safeStyle = sanitizeXhsText(style || "");
    const safeTpl = sanitizeXhsText(stripPromptScaffold(tpl));
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + `你是小红书笔记配图的图片提示词设计师。先理解用户创作内容，再拆成 ${nImg} 张静态图片：开场问题、真实办公场景、执行动作、关键细节、可复用结果、结论提醒等叙事功能。功能名只用于你内部理解，绝不能当作画面文字。
每条 prompt 必须使用「生成小红书笔记风格3:4尺寸，【图片风格：...】，图片具体内容：【...】。${minimalImageNegative()}」结构；如果有参考图，则在开头加入「请根据上传的参考图」。风格主要按账号创作风格和账号模板，不要把账号定位当成本次内容方向，不要把用户输入原句整段塞进提示词，不要在“图片具体内容”里重复外层结构。${safeStyle ? "账号创作风格：" + cleanImagePlanningWords(safeStyle) + "。" : "默认白底极简、蓝紫品牌色、圆角卡片排版、大留白、真实截图质感。"}${styleRefName ? `统一参考图：${sanitizeXhsText(styleRefName)}。每条都要继承参考图的品牌色、界面结构、图标比例、截图质感和视觉密度；多张参考图要综合，不要只参考第一张。` : ""}${safeTpl ? `账号有固定模板，必须继承模板的画面语言、色彩、字体、参考图使用方式和统一要求；但模板只当风格母版，不能原样复制模板句子。` : ""}

每条 prompt 控制在 160-260 字，说清：版式、主视觉、关键界面/文件/数据卡片、画面里允许出现的短文字、光线与颜色。只保留1个大标题和1句短副标题，最多2个小标签。
画面文字必须写具体功能、动作或结果，例如「资料自动归类」「字段一眼识别」「报告可直接用」，不能写空泛定位。
内部分类词只用于你理解结构，不要出现在最终 prompt 或画面文字里；最终负面约束只能使用指定的短句，不要额外扩写。

${xhsGuardPrompt()}

只输出 JSON：{"shots":[{"title":"给操作员看的短标题，必须是具体功能/结果，不能是种草/痛点/构图/步骤/封面等定位词","prompt":"可直接给图像模型的提示词","ui":true}]}` },
        { role: "user", content: `账号创作风格：${sanitizeXhsText(account.styleProfile || style || "")}\n语气：${sanitizeXhsText(account.tone || "教程感")}\n${product ? `宣传产品：${sanitizeXhsText(product.name || product.shortName || "")}\n` : ""}${safeTopic ? `本次主题：${safeTopic}\n` : ""}${styleRefName ? `风格参考图：${sanitizeXhsText(styleRefName)}\n` : ""}${safeTpl ? `账号图文模板（风格/结构母版，变量需替换）：\n${safeTpl}\n` : ""}脚本：\n${safeScript || "(据本次主题和创作风格自拟)"}` }
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
          product
        })
      });
    } catch (e) {
      this._fb(e);
      await delay(400);
      const rows = String(safeScript || "").split(/\n+/).map(x => x.trim()).filter(Boolean);
      return {
        shots: normalizeImagePromptItems(Array.from({ length: nImg }, (_, i) => {
          const rawBase = rows[i] || rows[Math.min(rows.length - 1, i)] || topic || `${product?.shortName || product?.name || "AI工具"}办公效率方法`;
          const base = rawBase.replace(/^(图\d+|镜头\d+|第\d+张)[：:｜\s]*/g, "").replace(/图上文案[:：][^｜\n]+/g, "").trim();
          const titleText = (base.match(/图上文案[:：]([^｜\n]+)/) || base.match(/line[:：]([^｜\n]+)/) || [])[1]?.trim()
            || (i === 0 ? shortChinese(safeTopic, 18) || `${(product?.shortName || product?.name || "这个工具")}到底省在哪` : i === nImg - 1 ? "把重复动作交给流程" : base.replace(/^图\d+[：:｜\s]*/, "").slice(0, 18));
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
          product
        })
      };
    }
  },

  /* ---------- 发布文案（交付包随附） ---------- */
  async generateCopy({ topic, shots, account, style, kind = "image", product = null }) {
    const safeTopic = sanitizeXhsText(topic || "");
    const safeShots = sanitizeXhsObject(JSON.parse(JSON.stringify(shots || [])));
    const safeStyle = sanitizeXhsText(style || "");
    const intent = inferCopyIntent({ topic: safeTopic, shots: safeShots, account, product, useAccountPosition: kind === "video" });
    const script = kind === "video"
      ? (safeShots || []).map((s, i) => `镜头${i + 1}｜${s.time || ""}｜口播：${s.line || ""}`).join("\n")
      : (safeShots || []).map((s, i) => `图${i + 1}｜${s.idea || ""}｜图上文案：${s.line || ""}`).join("\n");
    const sys = kind === "video"
      ? `你是短视频发布文案写手，为成片写发布标题与简介（发布平台：${account.platform}，按该平台调性写）：
- title：20字以内，像真实创作者的结论/痛点标题，具体、有梗、有信息量，可带1个贴合 emoji，但不要标题党过度。
- copy：220-420字简介，结构：真实体验/反常识开头 → 视频里的3-5个可复用亮点（来自口播脚本，每点一行）→ 一句适用场景/避坑结论自然收束 → 最后一行4-7个具体话题标签。
语气按账号定位细化，像真人发视频，不要硬广腔，不要假装临时接到领导任务。用户给的创作内容只是素材和约束，禁止原样当标题或正文第一句；必须先提炼痛点、动作和结果后再写。只输出 JSON：{"title":"...","copy":"..."}`
      : `你是小红书爆款笔记文案写手。根据图卡脚本写一篇配套笔记：
- title：20字以内，像真实创作者的结论/痛点标题，具体、有梗、有信息量，可带1个贴合 emoji。
- copy：260-520字正文，结构：第一句真实体验/反常识钩子 → 按脚本分点干货（每点一行，可用 ①②③、👉 或 ✅，但不要符号堆砌）→ 一句适用场景/避坑结论自然收束 → 最后一行4-7个具体话题标签。
语气按本次内容和账号创作风格细化，像真人发笔记，不要硬广腔。不要让账号定位改变用户本次要写的内容方向。用户给的创作内容只是素材和约束，禁止原样当标题或正文第一句；必须先提炼痛点、动作和结果后再写。只输出 JSON：{"title":"...","copy":"..."}`;
    try {
      const content = await llm([
        { role: "system", content: baseProductFacts(product) + productBrief(product) + "\n\n" + sys + XHS_COPY_STYLE + "\n\n" + xhsGuardPrompt() },
        { role: "user", content: kind === "video"
          ? `账号定位：${sanitizeXhsText(account.position)}\n语气：${sanitizeXhsText(account.tone || "教程感")}\n创作内容原文（只用于理解，不要照抄）：${safeTopic}\n提炼后的发布角度：面向${intent.audience}，痛点是「${intent.pain}」，核心动作是「${intent.action}」，结果价值是「${intent.result}」。\n${safeStyle ? "图片风格：" + safeStyle + "\n" : ""}图卡/视频内容摘要：\n${script}\n${HUMAN_COPY_VOICE}${this.memoryLine(account)}`
          : `账号创作风格：${sanitizeXhsText(account.styleProfile || safeStyle || "")}\n语气：${sanitizeXhsText(account.tone || "教程感")}\n创作内容原文（只用于理解，不要照抄）：${safeTopic}\n提炼后的发布角度：面向${intent.audience}，痛点是「${intent.pain}」，核心动作是「${intent.action}」，结果价值是「${intent.result}」。\n${safeStyle ? "图片风格：" + safeStyle + "\n" : ""}图卡内容摘要：\n${script}\n${HUMAN_COPY_VOICE}` }
      ], { json: true, temperature: 0.9 });
      const d = sanitizeXhsObject(parseJSONLoose(content));
      if (!d.title || !d.copy) throw new Error("模型未返回 title/copy");
      return this._ok(polishCopyResult(d, { topic: safeTopic, shots: safeShots, account, kind, product }));
    } catch (e) {
      this._fb(e);
      await delay(400);
      return sanitizeXhsObject(this._mockCopy({ topic: safeTopic, shots: safeShots, account, product }));
    }
  },

  async randomTitle({ topic, account, product = null }) {
    try {
      const styleLine = account?.mode === "图文"
        ? `账号创作风格「${account.styleProfile || "干净可读"}」`
        : `账号定位「${account.position}」`;
      const productName = product?.shortName || product?.name || "AI工具";
      const r = await llm([{ role: "user", content: `给小红书笔记起一个标题，主题「${topic || `${productName} 办公效率`}」，${styleLine}。20字以内，口语化、有信息量，带1-2个emoji。只回标题本身，不要引号不要解释。` }], { temperature: 1.1 });
      const t = sanitizeProduct(String(r).trim().replace(/^["'「]|["'」]$/g, "").slice(0, 30));
      if (t) return this._ok(t);
      throw new Error("空");
    } catch (e) {
      this._fb(e);
      return this._mockCopy({ topic, shots: [], account }).title;
    }
  },

  /* ---------- 随机骰子 ---------- */
  async randomPick({ kind, account, product = null }) {
    try {
      const p = product || allProductsForAI().find(x => x.owner === "ours") || null;
      const rel = relatedProducts(p, allProductsForAI(), 4);
      const productName = p?.shortName || p?.name || "本次产品";
      const relLine = rel.length ? `可参考同类产品：${rel.map(x => `${x.shortName || x.name}（${x.category || "同类工具"}）`).join("、")}。` : "";
      const ask = kind === "direction"
        ? `给我一个适合做「${productName}」产品教程短视频的目标人群方向，要主流、好理解、贴近大众（比如 职场白领 / 宝妈 / 大学生 / 老师 / 电商卖家 这类），不要冷门抽象概念。只回一个3-6字的词，不要标点不要解释。`
        : kind === "style"
        ? `为小红书图文笔记配图想一个总视觉风格短语，参考当前创作风格「${account.styleProfile || account.position || "干净可读"}」。可以超出常见标签、有新鲜感但要好落地（例如：奶油色清晨书桌风 / 蓝白格子手帐风 / 低饱和莫兰迪办公风）。只回一个5-12字的风格短语，不要标点不要解释。`
        : `${currentProductLine(p)}\n给我一个「${productName}」相关的 AI 博主选题，贴合账号人群「${account.position || account.styleProfile || "办公效率人群"}」。可以是教程、对比、测评、工具分工或场景清单，不要只生硬介绍产品。${p?.id === "miaoda" ? "秒哒是无代码 AI 应用生成平台，选题必须围绕应用生成、H5/页面、原型、小工具、数据表/后台、非技术人验证想法；不要写文件整理、桌面自动操作、PDF/Word/Excel 转格式、会议纪要这类桌面执行能力，除非明确是“做一个应用来管理这些流程”。" : ""}${relLine}只回一句不超过18字的主题，不要标点不要解释。`;
      const r = await llm([{ role: "user", content: ask }], { temperature: 1.0 });
      const t = String(r).trim().replace(/[。.\n"'`]/g, "").slice(0, kind === "style" ? 16 : 18);
      if (t) return this._ok(kind === "direction" ? (t.endsWith("方向") ? t : t + "方向") : kind === "topic" ? enforceCurrentProductTopic(t, p, rel) : t);
      throw new Error("空");
    } catch (e) {
      this._fb(e);
      const pool = kind === "direction" ? DIR_POOL : kind === "style" ? STYLE_POOL : TOPIC_POOL;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      return kind === "direction" ? pick + "方向" : pick;
    }
  },

  /* ---------- md / 自然语言 → 批量账号 ---------- */
  async parseAccountsMd(text) {
    try {
      const content = await llm([
        { role: "system", content: `把用户的 markdown 解析成账号数组。每个账号字段：name(必填)、platform(小红书|视频号)、mode(图文|视频)、subType(数字人|无数字人，仅视频)、position(账号定位描述)、qtags(数组，仅限：${TAG_POOL.join("/")})。缺失字段合理推断。只输出 JSON：{"accounts":[...]}` },
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
          position: (b.match(/定位[：:]\s*([^\n]+)/) || [])[1] || "",
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
    const productName = product?.shortName || product?.name || "本次产品";
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
    return { title: topic, shots: rows.map(r => ({ ...r, line: stripCTA(r.line) })) };
  },

  /* ---------- 本地回退模板 ---------- */
  async _mockScript({ topic, account, image, imageCount, product = null }) {
    await delay(600);
    const productName = product?.shortName || product?.name || "本次产品";
    const clean = (topic || "").replace(/Dumate|百度搭子|百度秒哒|秒哒/g, "").trim() || "杂事";
    if (image) {
      const n = Math.max(3, Math.min(9, imageCount || 6));
      const cover = { idea: "真实问题开场", visual: `白底大留白，居中大字标题，旁边出现${productName}产品界面小卡片`, line: `${clean}太费时？` };
      const ending = { idea: "方法结论", visual: `${productName}完成卡片居中，旁边是整齐结果清单`, line: `把重复动作交给${productName}` };
      const stepsPool = [
        { idea: "引入产品入口", visual: `${productName}首页圆角输入框，浅蓝网格背景`, line: `打开${productName}` },
        { idea: "演示输入任务", visual: "输入框内出现任务文字，发送按钮高亮", line: "一句话交给它" },
        { idea: "展示自动执行过程", visual: "任务卡片展开，进度条推进，蓝紫扫描线", line: "它自己动手干" },
        { idea: "展示结构化结果", visual: "结果卡片三个分区，蓝紫完成圆点", line: "几秒出结果" },
        { idea: "展示更多功能", visual: "白色卡片排列三个小图标：转格式/提信息/批量改名", line: "不止这一招" },
        { idea: "对比前后效果", visual: `左乱右整对比图，中间箭头指向${productName}结果卡`, line: "前后差距一目了然" },
        { idea: "使用小贴士", visual: "便签式卡片列两条使用技巧，配勾选图标", line: "记住这两个技巧" }
      ];
      const mid = stepsPool.slice(0, Math.max(1, n - 2));
      return { title: topic, shots: [cover, ...mid, ending].slice(0, n) };
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
    return { title: topic, shots };
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
    const productName = product?.shortName || product?.name || "本次产品";
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
      const themeLine = `本条主题：${(account.position || "").split("，")[0]}；场景：明亮办公桌前、暖色柔光(前后两段同一场景)；BGM：轻快办公背景乐(前后两段同一BGM)。`;
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

  _mockCopy({ topic, shots, account, product = null }) {
    const intent = inferCopyIntent({ topic, shots, account, product });
    const titles = copyTitlePool(intent, "image");
    const copy = fallbackXhsCopy({ intent, shots, account, kind: "image" });
    return { title: titles[Math.floor(Math.random() * titles.length)], copy };
  }
};

window.DumateAI = AI;
