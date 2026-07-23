/* 批次编排器：事件驱动的状态机（替代 v4 的 setInterval 盯进度）
   会话/消息/批次全部持久化，刷新后 resumeActiveBatches() 接续 */

import { state, save, emit, on, notify, accountById, productionById, productById, primaryProductById, ownedBy, removeRemoteAsync } from "../core/store.js";
import { uid, runPool, debounce, singleImageGenerationPrompt } from "../core/util.js";
import { AI } from "../api/ai.js?v=20260723-v117-1";
import { groupOf, isAccountDisabled } from "../domain/accounts.js";
import { createProduction, setStage, setStatus, touch, autoAssemble, jobsOf, isMaterial, isVideoWorkshop, estimateAudio, buildMaterialUnits, shotsToText, enforceSupportedVideoMode } from "../domain/productions.js";
import { createRenderJobsFor, retryJob, createJob } from "../api/jobs.js";
import { deliver } from "../domain/delivery.js";
import { addAssetFromDataUrl, addAssetFromFile, assetBlob, replaceAssetBlob, urlFor } from "../domain/assets.js";
import { polishImageForPublish } from "../domain/imagePolish.js";
import { activeProviderFor, defaultTtsVoiceId, imageApiConfigured, providerKeyFor, refreshProviderStatus, synthesizeTts, ttsApiConfigured } from "../api/providers.js";
import { routeIntent, parseGoalFallback } from "./intent.js";
import { fileToDataUrl } from "../core/util.js";
import { DIGITAL_HUMAN_FIXED_PROMPT, planDigitalNarrationSegments } from "../domain/digitalHuman.js";
import * as remote from "../core/remote.js";

const DEFAULT_XHS_IMAGE_COUNT = 4;
const IMAGE_NEGATIVE_PROMPT = "负面约束：不出现二维码，不出现过多小字。";
const VIDEO_NEGATIVE_PROMPT = "负面约束：无字幕，不生成花字，不生成水印，不生成二维码。";
const COVER_STYLE_HINTS = [
  "波普风，大色块和强对比排版",
  "极简风，大留白和一个强视觉焦点",
  "杂志封面风，标题醒目、层级清楚",
  "手写标注风，少量重点圈画",
  "蓝白科技风，干净界面和冷色高光",
  "轻 3D 插画风，主体明确、空间干净"
];
const activeImageRecoveries = new Set();

const CONTENT_KIND_GROUP = { image: "图文组", material: "素材", real: "真人" };

function contentKindFromGroup(group = "") {
  if (group === "素材") return "material";
  if (group === "真人") return "real";
  return "image";
}

function coverStyleHint(seed = "") {
  const s = String(seed || "");
  let n = 0;
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
  return COVER_STYLE_HINTS[(n + Math.floor(Date.now() / 60000)) % COVER_STYLE_HINTS.length];
}

function normalizeContentKind(kind = "", group = "") {
  return ["image", "material", "real"].includes(kind) ? kind : contentKindFromGroup(group);
}

function accountMatchesKind(acc, kind = "image") {
  const g = groupOf(acc);
  if (kind === "image") return acc?.mode === "图文" || g === "图文组";
  if (kind === "material") return acc?.mode === "视频" && g === "素材";
  if (kind === "real") return acc?.mode === "视频" && g === "真人";
  return true;
}

function cleanPlanRefIds(value, limit) {
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.filter(Boolean))].slice(0, limit);
}

export function resetPlanReferences(plan = {}) {
  plan.referenceSelectionId = uid();
  plan.sharedRefAssetId = null;
  plan.sharedRefAssetIds = [];
  plan.coverRefAssetIds = [];
  plan.accountRefAssetIds = {};
  return plan;
}

export function prunePlanReferences(plan = {}) {
  const contentKind = normalizeContentKind(plan.contentKind, plan.group);
  const selectedAccounts = new Set(plan.accountIds || []);
  const shared = cleanPlanRefIds([
    ...(Array.isArray(plan.sharedRefAssetIds) ? plan.sharedRefAssetIds : []),
    plan.sharedRefAssetId
  ], 5);
  plan.sharedRefAssetIds = contentKind === "image" ? shared : [];
  plan.sharedRefAssetId = plan.sharedRefAssetIds[0] || null;
  plan.coverRefAssetIds = contentKind === "image" ? [] : cleanPlanRefIds(plan.coverRefAssetIds, 5);
  plan.accountRefAssetIds = Object.fromEntries(
    Object.entries(plan.accountRefAssetIds || {})
      .filter(([accountId]) => selectedAccounts.has(accountId))
      .map(([accountId, ids]) => [accountId, cleanPlanRefIds(ids, 3)])
      .filter(([, ids]) => ids.length)
  );
  if (!plan.referenceSelectionId) plan.referenceSelectionId = uid();
  return plan;
}

function enforcePlanKind(plan = {}) {
  const contentKind = normalizeContentKind(plan.contentKind, plan.group);
  plan.contentKind = contentKind;
  plan.group = CONTENT_KIND_GROUP[contentKind] || plan.group || "图文组";
  plan.creativeMode = "custom";
  if (plan.creativeMode === "custom") {
    plan.topicMode = "fixed";
    plan.content = "";
    plan.perAccountCount = 1;
    plan.accountCounts = {};
  }
  plan.accountIds = (plan.accountIds || []).filter(id => accountMatchesKind(accountById(id), contentKind));
  return prunePlanReferences(plan);
}

const BATCH_CREATIVE_VARIANTS = [
  { key: "pain-relief", name: "痛点急救型", angle: "从一个具体办公痛点切入，讲清这条内容解决哪种麻烦", focus: "痛点现场、具体动作、结果变化" },
  { key: "tool-division", name: "工具分工型", angle: "讲同类/互补工具和主产品如何分工，不孤立宣传", focus: "工具边界、组合流程、主产品负责的动作" },
  { key: "real-test", name: "真实实测型", angle: "像真实博主试完后复盘，优点和边界都说一点", focus: "实测过程、有效证据、适用/不适用" },
  { key: "template-save", name: "模板收藏型", angle: "把内容做成可收藏复用的流程卡或模板", focus: "模板字段、复用步骤、适用场景" },
  { key: "mistake-fix", name: "避坑修正型", angle: "先指出常见错误做法，再给更稳的流程", focus: "误区、正确做法、示例指令" },
  { key: "before-after", name: "前后对比型", angle: "展示处理前后的变化，用结果建立可信度", focus: "处理前、执行中、处理后" },
  { key: "one-person-team", name: "一人团队型", angle: "从一个人或小团队的重复劳动切入", focus: "个人卡点、任务拆分、交付结果" },
  { key: "calm-note", name: "冷静备忘型", angle: "像公开备忘录一样冷静总结，不喊口号", focus: "结论、清单、边界、复用提醒" },
  { key: "time-save", name: "时间收益型", angle: "从可感知的时间差切入，说明省时来自哪一步", focus: "原来耗时、关键动作、时间变化、使用边界" },
  { key: "combo-wow", name: "组合王炸型", angle: "讲两个工具为什么要分工组合，而不是孤立宣传", focus: "工具A职责、主产品职责、衔接动作、适合场景" },
  { key: "anti-chat", name: "反聊天框型", angle: "从“不要只让AI回答”切入，强调执行和交付", focus: "旧用法、新用法、执行证据、可复用句式" },
  { key: "starter-guide", name: "新手教程型", angle: "降低门槛，讲第一次上手应该怎么试", focus: "准备材料、第一句指令、结果检查、避坑" },
  { key: "question-talk", name: "话题提问型", angle: "用真实疑问制造讨论，再用案例回答", focus: "问题、案例、结论、边界" },
  { key: "collection", name: "收藏合集型", angle: "把内容做成可保存的指令/流程合集", focus: "可收藏场景、任务类型、复制句式、保存价值" },
  { key: "proof-shot", name: "证据截图型", angle: "用结果截图/输出物建立可信度", focus: "输入材料、执行中证据、输出结果、复核方法" }
];

const INFO_FLOW_BATCH_DIRECTIONS = [
  {
    key: "zero-start",
    topic: "国产AI工具零门槛上手",
    title: product => `${product}，不用安装也能快速上手！`,
    front: product => `0-3s：深夜工位，一个不会写代码的人盯着空白网页草稿，屏幕上弹出一堆红色待办；3-7s：手机震动，朋友发来“你不是不会做网页吗？”角色抬头笑一下，直接打开${product}；7-11s：镜头快速推近屏幕，需求被拆成任务卡，页面轮廓一块块亮起；11-15s：角色把咖啡放下，对镜头说“我真的一行代码都没写”，画面定格在已经能看的页面。`,
    back: product => `0-4s：角色把一句需求输入${product}，屏幕左侧保留原始想法，右侧自动拆出“结构、素材、执行、检查”四张任务卡；4-8s：镜头近景点击任务卡，网页、文档和素材被拉进同一工作区，口播说“先别写代码，先让它把任务拆清楚”；8-12s：执行进度、结果预览和可修改入口连续出现；12-15s：角色把手机举到镜头前，屏幕显示任务进度和初版页面。`
  },
  {
    key: "workflow",
    topic: "AI工作流提效",
    title: product => `${product}把乱任务跑成可交付流程`,
    front: product => `0-3s：会议结束，桌上堆满录音、截图和表格，角色把文件夹直接倒在桌面上；3-6s：镜头俯冲进一堆资料，文件像风暴一样旋转；6-10s：角色说“别先整理，先让AI跑一遍”，屏幕上出现${product}的任务队列；10-15s：资料被吸进一个任务板，三列卡片依次弹出“分类、提取、交付”。`,
    back: product => `0-4s：角色把截图、会议纪要和表格拖进${product}，界面先标出资料类型和缺口；4-8s：镜头俯拍切到任务清单，系统把“分类、提取、生成、复核”拆成可执行步骤；8-12s：周报、表格、脚本草稿并排生成，旁边有修改入口；12-15s：散乱资料回扣成一个可交付文件夹，角色直接复制交付清单。`
  },
  {
    key: "compare",
    topic: "AI工具对比测评",
    title: product => `${product}和别的AI工具到底差在哪？`,
    front: product => `0-4s：桌面分成左右两边，一边是“只聊天”，另一边是“能执行”，两边同时开始计时；4-8s：左边还在输出建议，右边已经打开文件、生成页面、整理清单；8-12s：角色从画面中间伸手按下暂停，镜头定格在两边结果差距；12-15s：屏幕大字“不是谁更会说，是谁能把事往前推”。`,
    back: product => `0-4s：画面左右对比，一边还在输出建议，另一边${product}已经把需求拆成任务卡；4-8s：镜头切到自动读文件、改页面、整理素材三个真实动作，每个动作都有进度反馈；8-12s：执行日志、可预览结果和交付物同时出现；12-15s：回到左右对比桌面，${product}一侧已经有可发送的初版，另一侧只剩一段建议。`
  },
  {
    key: "office-scene",
    topic: "真实办公场景测评",
    title: product => `真实办公场景里，${product}到底能干什么？`,
    front: product => `0-3s：早会刚结束，老板一句“今天下班前给我”，角色表情瞬间僵住；3-6s：白板上飞出“整理资料、做表格、写脚本、出封面”四个任务砸向屏幕；6-11s：角色把这些需求一句话扔给${product}，镜头跟随任务卡快速分裂成多个小步骤；11-15s：画面突然安静，屏幕显示“已生成初版”，角色小声说“这就能看了？”`,
    back: product => `0-4s：老板口头需求被贴到${product}输入框，界面立刻拆出资料整理、脚本生成、封面图和审核清单四个交付项；4-9s：镜头快速切过四个窗口，每个窗口都生成可修改内容；9-13s：结果页显示初版链接、可编辑文案和交付清单；13-15s：回到聊天窗口，角色直接发送初版链接。`
  }
];

function variantHash(str = "") {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function batchVariantFor({ acc, batch, globalIndex = 0, itemIndex = 1, itemTotal = 1 }) {
  const offset = variantHash(`${batch?.id || ""}:${acc?.id || acc?.name || ""}:${itemIndex}`);
  const base = BATCH_CREATIVE_VARIANTS[(globalIndex + (offset % 5)) % BATCH_CREATIVE_VARIANTS.length];
  const accStyle = String(acc?.styleProfile || acc?.lockedStyle || groupOf(acc) || "当前账号").slice(0, 48);
  const repeated = itemTotal > 1 ? `同账号第 ${itemIndex}/${itemTotal} 条也要换例子和标题，不要复用上一条。` : "";
  return {
    ...base,
    index: globalIndex + 1,
    total: Math.max(1, batch?.plannedTotal || batch?.productionIds?.length || 1),
    accountName: acc?.name || "",
    accountTag: "",
    focus: `${base.focus}；结合账号真实创作风格「${accStyle}」写不同例子。${repeated}`
  };
}

function existingBatchCopies(batch, currentId) {
  return batchProds(batch)
    .filter(x => x.id !== currentId && (x.artifacts?.copy?.title || x.artifacts?.copy?.body))
    .map(x => ({ title: x.artifacts.copy.title || x.title || "", copy: x.artifacts.copy.body || "" }));
}

function copyTags(body = "", fallback = []) {
  const tags = Array.from(String(body || "").matchAll(/#[\p{L}\p{N}_-]{2,}/gu)).map(m => m[0].replace(/^#/, ""));
  return [...new Set(tags.length ? tags : (fallback || []))].slice(0, 8);
}

function stripLeadingCopyTitle(body = "", title = "") {
  const raw = String(body || "").trim();
  const t = String(title || "").trim();
  if (!raw || !t) return raw;
  const norm = x => String(x || "").replace(/[#\s"'“”‘’《》「」【】\[\]（）()!！?？:：,，.。;；、~～-]/g, "").toLowerCase();
  const lines = raw.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const titleNorm = norm(t);
  while (lines.length) {
    const firstNorm = norm(lines[0]);
    if (!firstNorm || !(firstNorm === titleNorm || firstNorm.startsWith(titleNorm))) break;
    const rest = lines[0]
      .replace(new RegExp(`^\\s*${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：,，.。!！?？-]*\\s*`), "")
      .trim();
    if (rest && norm(rest) !== titleNorm) { lines[0] = rest; break; }
    lines.shift();
  }
  return lines.join("\n").replace(/^\s*[:：,，.。!！?？-]+/, "").trim();
}

function infoFlowProductName(product) {
  return product?.shortName || product?.name || "百度搭子";
}

function compactInfoFlowText(text = "", max = 96) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function infoFlowCopyCue(copyText = "", fallback = "") {
  const fallbackText = String(fallback || "").trim();
  const lines = String(copyText || "")
    .split(/\n+/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => !x.startsWith("#") && x !== fallbackText);
  const body = lines[0] || fallbackText;
  const parts = body.match(/[^。！？!?]+[。！？!?]?/g) || [body];
  return compactInfoFlowText(parts.slice(0, 2).join(""), 128);
}

function stripInfoFlowDirectorNotes(text = "") {
  const cleaned = String(text || "")
    .split(/\n{2,}/)
    .filter(block => !/(?:功能演示分镜结构|分镜结构|第一镜|第二镜|第三镜|第四镜|第五镜|第六镜|前排镜|前景镜|后排镜|第[一二三四五六七八九十]+镜\s*[:：])/.test(block))
    .join("\n\n")
    .replace(/(?:^|\n)导演要求：[^\n]*(?=\n|$)/g, "")
    .replace(/不要写“冲突打开”“要有概念”“高级感”这类抽象占位词。?/g, "")
    .replace(/不要只出现抽象光效。?/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned;
}

function infoFlowRoleAnchor(acc = {}) {
  return [
    "角色外貌锚点：真实办公室内容创作者，25-32岁，脸型偏鹅蛋或小方脸，眉眼清爽，鼻梁自然，嘴角有轻微疲惫但反应很快；中等身材，肩颈放松，动作干净。",
    "穿搭细节：浅灰或白色通勤上衣，外搭薄衬衫或简洁夹克，袖口自然挽起；桌面动作以抓手机、推开文件、敲键盘、拖拽资料、指向屏幕为主。",
    "表情变化：开头被任务压住时焦躁又好笑，中段看到任务开始自动跑时明显惊讶，结尾松一口气，像真的发现一个省事方法。"
  ].filter(Boolean).join(" ");
}

function infoFlowVoiceAnchor(acc = {}) {
  const selected = compactInfoFlowText(acc.voiceName || acc.voiceId || "", 42);
  return [
    `声线锚点：${selected ? `${selected}；` : ""}自然真实的中文讲解感，普通话清晰，音色干净，语速约1.15到1.25倍，句尾自然下落，吐字清楚。`,
    "说话像边操作边吐槽：开头有一点被任务追着跑的无奈，中段带明显惊喜，结尾给出确定结论；不要播音腔，不要机械念稿。"
  ].join(" ");
}

const VIDEO_BAIDU_TAG_LINE = "#AI工具 #AI提效 #codex #AI办公 #效率工具 #百度搭子";

function videoPublishTagLine(product = null) {
  const name = infoFlowProductName(product);
  if (/百度搭子|Dumate|DuMate|搭子/.test(name)) return VIDEO_BAIDU_TAG_LINE;
  return `#AI工具 #AI提效 #codex #AI办公 #效率工具 #${name.replace(/\s+/g, "")}`;
}

function infoFlowFeatureBrief(topic = "", productName = "百度搭子") {
  const t = String(topic || "").toLowerCase();
  if (/模型|model|隐藏|玩法|效率翻倍|选对|十大|10大|十个|10个/.test(t)) {
    return {
      pain: "同一个需求用错模型时，输出会像跑偏的实习生：要么空泛、要么过度发挥、要么完全不按格式来",
      feature: "模型选择和隐藏玩法组合",
      action: `${productName}把“选模型、拆任务、拉资料、生成初版、复核修改”串成一条流程，让不同模型负责不同环节`,
      result: "模型先选对，后面的整理、生成和复核才不会一路返工",
      prop: "三块写着不同模型的小卡片、返工记录、任务看板、资料文件夹和一个正在对比输出结果的屏幕"
    };
  }
  if (/skill|技能|教程|速通/.test(t)) {
    return {
      pain: "同一类复盘、整理、写脚本的活反复出现，每次都像从零开始",
      feature: "Skill 复用流程",
      action: `把“读资料、拆步骤、生成初版、复核清单”沉淀成 ${productName} 里的固定 Skill`,
      result: "下次只换素材，流程还能继续复用",
      prop: "一叠贴满便签的资料、一个弹出十几条返工消息的手机、一个正在生成任务卡的电脑屏幕"
    };
  }
  if (/钱|成本|预算|外包|省/.test(t)) {
    return {
      pain: "老板问这个月少花多少钱，桌面上摊着预算表、报价单和项目截图",
      feature: "成本核算和交付拆解",
      action: `${productName}把外包项、沟通成本和可自动化步骤拆成一张可复核表`,
      result: "哪些钱能省、哪些活该留给人，一眼能看出来",
      prop: "计算器、预算表、报价截图、红色待确认便签"
    };
  }
  if (/表格|周报|资料|知识库|流程|工作流|整理/.test(t)) {
    return {
      pain: "周报、截图、会议纪要和表格混成一团，越整理越乱",
      feature: "资料沉淀和工作流整理",
      action: `${productName}先分类资料，再提取字段，最后输出能复核的清单和报告初稿`,
      result: "散乱资料被推进成一个可以继续修改的交付包",
      prop: "文件夹、会议录音、表格截图、知识库页面和一张进度看板"
    };
  }
  if (/对比|测评|差在哪|codex|agent|ai/.test(t)) {
    return {
      pain: "一边是只会回答建议的 AI，一边是能把任务往前推的桌面智能体",
      feature: "任务执行链路对比",
      action: `${productName}把需求拆成任务，自动读取资料并生成一个可看的初版`,
      result: "观众能看到差别不是谁更会说，而是谁真的推进了一步",
      prop: "左右分屏、计时器、任务日志、预览页面和交付文件夹"
    };
  }
  return {
    pain: "一个普通打工人被一堆临时需求追着跑，屏幕、手机和桌面同时爆炸",
    feature: "任务拆解到初版交付",
    action: `${productName}把一句口头需求拆成步骤，拉资料、跑任务、给出可修改结果`,
    result: "先把事情推进到能看的版本，而不是停在建议里",
    prop: "手机消息、电脑屏幕、文件夹、待办便签和咖啡杯"
  };
}

function buildInfoFlowFrontBeat({ mainTopic, productName, focus, seed = "" }) {
  const openers = [
    `0-3s：办公室桌面突然被${focus.prop}塞满，手机连续弹出“十分钟后要初版”“顺便做个封面”“再整理下资料”，角色一边抓头发一边把咖啡差点碰倒。`,
    `0-3s：电梯门一开，角色怀里抱着${focus.prop}冲回工位，屏幕上任务提醒连续闪烁，表情像刚被临时加班砸中。`,
    `0-3s：镜头从桌面低角度冲进来，${focus.prop}像多米诺一样倒向键盘，角色手忙脚乱按住电脑和手机。`
  ];
  const turns = [
    `3-6s：镜头手持快速绕桌一圈，文件夹、截图、表格和聊天消息像失控一样叠到屏幕前；角色用符合本次主题的原创短台词回应冲突。`,
    `3-6s：画面快切三次：空白文档、凌乱资料、错误输出，角色每切一次表情更崩一点，最后用本次主题专属台词把阻碍说清。`,
    `3-6s：角色试着随便跑一次，屏幕弹出三段完全跑偏的结果，镜头突然推到他愣住的表情；反应和台词必须针对本次文案重新创作。`
  ];
  const twists = [
    `6-10s：画面突然切成夸张对比：左边随便选工具后输出一堆空话，右边角色把「${mainTopic}」拆成几张任务卡贴到屏幕上，镜头快速推近每张卡的错位结果。`,
    `6-10s：角色突然停下，把「${mainTopic}」写成一句完整任务，旁边三张模型/流程卡依次亮起，镜头跟着卡片快速横移。`,
    `6-10s：错误输出被角色一张张拖到废纸篓，屏幕中央只留下「${mainTopic}」和“先判断、再执行、再复核”三步。`
  ];
  const closes = [
    `10-15s：角色把错误输出揉成纸团扔到桌边，深吸一口气，对镜头说“先别急着跑，先选对怎么跑”，画面停在一张清晰的执行路线草图上。`,
    `10-15s：镜头从角色表情拉回屏幕，混乱资料被一条路线框住，角色点头说“这次先让它按步骤来”。`,
    `10-15s：画面突然安静，桌面只剩一张干净任务卡，角色把手机扣下，对镜头抛一句“别让模型替你乱猜”。`
  ];
  return [
    pickBatchInfoFlow(openers, seed, 1),
    pickBatchInfoFlow(turns, seed, 2),
    pickBatchInfoFlow(twists, seed, 3),
    pickBatchInfoFlow(closes, seed, 4)
  ].join(" ");
}

function buildInfoFlowBackBeat({ mainTopic, productName, focus, copyText = "", seed = "" }) {
  const cue = infoFlowCopyCue(copyText, mainTopic);
  const starts = [
    `0-3s：口播直接扣回发布文案重点：“${cue}”。画面近景看到用户在${productName}里输入「${mainTopic}」，旁边放着资料、截图和待办。`,
    `0-3s：接前段桌面，角色把路线草图拍进${productName}工作区，输入框里清楚出现「${mainTopic}」，口播点出“先把任务说清楚”。`,
    `0-3s：镜头从前段那张任务卡推入屏幕，${productName}工作区打开，资料、目标和判断标准被放进同一行，口播说“先把资料和目标放到同一处”。`
  ];
  const mids = [
    `3-7s：界面按文案逻辑生成任务清单，逐项展示${focus.action}；镜头用近景点击、快速推拉和屏幕录制感切换，让观众看到每一步负责什么。`,
    `3-7s：任务卡从左到右展开，先拆步骤，再读取资料，再生成初版；每一步旁边都有可修改入口，画面不跳题。`,
    `3-7s：屏幕中部出现流程看板，资料、模型选择、执行动作和复核项依次亮起，角色只做确认和微调。`
  ];
  const results = [
    `7-11s：切到功能结果：不同模型或步骤产出的内容并排出现，资料被归类，关键字段被提取，页面或报告初稿出现，旁边保留修改入口和复核清单。`,
    `7-11s：结果区分成三列：输入材料、执行过程、可改初版，镜头逐列扫过，观众能看到它不是只给建议。`,
    `7-11s：原始资料被自动归类成清单、表格和文案初稿，角色点击一处错误项，界面立刻进入可修改状态。`
  ];
  const closes = [
    `11-15s：回扣前段混乱桌面，角色把生成的初版发出去，口播收束“先选对模型和流程，效率才真的翻倍。”画面突出${focus.result}。`,
    `11-15s：画面回到前段的同一个桌面，道具位置保持一致，但屏幕已经有可交付初版，角色松一口气说“这次终于能交了”。`,
    `11-15s：最后给到执行路线和结果预览同屏，角色把错乱资料移到一边，旁白收束“先有可改初版，再谈完美”。`
  ];
  return [
    pickBatchInfoFlow(starts, seed, 11),
    pickBatchInfoFlow(mids, seed, 12),
    pickBatchInfoFlow(results, seed, 13),
    pickBatchInfoFlow(closes, seed, 14)
  ].join(" ");
}

function buildInfoFlowPublishCopy({ title, topic, productName, product }) {
  const focus = infoFlowFeatureBrief(topic, productName);
  const isModelTopic = /模型|model|隐藏|玩法|效率翻倍|选对|十大|10大|十个|10个/.test(String(topic || "").toLowerCase());
  if (isModelTopic) {
    return [
      title,
      `我发现很多人用 AI 提效慢，不是工具不行，而是一上来就把所有任务丢给同一个模型。真正影响效率的，是先判断这件事该让谁负责：谁适合拆步骤，谁适合拉资料，谁适合写初版，谁适合做复核。`,
      `${productName}这类桌面智能体适合做的，就是把「${topic}」这种需求拆成可执行流程。你不用先想完整答案，只要把目标、素材和判断标准说清楚，它就能先把任务卡、资料整理、初版结果和修改入口跑出来。`,
      `这条 B 面会重点看几个隐藏玩法：先选模型，再拆任务；先给资料，再让它生成；先要可修改初版，不要一次追求完美。这样做的好处是返工会少很多，因为每一步都有结果可以检查。`,
      `A 面会拍得更夸张一点：用错模型时，输出像开盲盒；B 面再回到真实操作，看看怎么把模型选择和工作流串起来。`,
      videoPublishTagLine(product)
    ].join("\n\n");
  }
  return [
    title,
    `${productName}这类工具，最容易被低估的其实不是“会回答”，而是它能先把一件乱事推到能改的版本。`,
    `比如${focus.pain}，以前我会先卡在整理这一步：资料要看，步骤要拆，结果还要能交付。现在我会先把需求丢进去，让它把任务拆出来，再看哪些地方需要我判断。`,
    `这条视频里重点看${focus.feature}：${focus.action}。它不替你拍脑袋做决定，但能把重复劳动先压下去，让人把注意力留给判断和修改。`,
    `如果你也经常被资料、截图、表格和临时需求追着跑，可以试试先让它跑一版。很多时候，最难的不是完美，而是先有一个能看的初稿。`,
    videoPublishTagLine(product)
  ].join("\n\n");
}

function pickBatchInfoFlowDirection(seed = "") {
  const s = String(seed || "");
  const sum = [...s].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return INFO_FLOW_BATCH_DIRECTIONS[sum % INFO_FLOW_BATCH_DIRECTIONS.length];
}

const INFO_FLOW_BATCH_TOPIC_ANGLES = [
  { key: "task-burst", name: "任务爆炸", focus: "临时需求同时砸来、桌面乱成一团、先拆出第一步" },
  { key: "first-run", name: "第一次上手", focus: "新手第一次试用、只说一句需求、从空白到初版结果" },
  { key: "save-hour", name: "省下半天", focus: "原本要半天整理的资料、先分类再生成清单、时间差明显" },
  { key: "boss-rush", name: "老板催交", focus: "老板临时催交、任务被拆成卡片、先交可看的初稿" },
  { key: "messy-docs", name: "资料混乱", focus: "截图、网页、表格和文档混在一起、先沉淀成结构" },
  { key: "tool-compare", name: "工具对比", focus: "只聊天的AI和能执行的工具对比、强调推进到结果" },
  { key: "phone-check", name: "手机追进度", focus: "离开电脑也能查看任务进度、手机端跟进结果" },
  { key: "repeat-skill", name: "复用Skill", focus: "重复工作沉淀成Skill、下次只换素材继续跑" }
];

const INFO_FLOW_BATCH_TITLE_PATTERNS = [
  (topic, product) => `${topic}，先让${product}跑一版`,
  (topic, product) => `${topic}别硬扛，${product}先打底`,
  (topic, product) => `${product}怎么处理「${topic}」？30秒看懂`,
  (topic, product) => `${topic}卡住了？用${product}先拆步骤`,
  (topic, product) => `${topic}从一团乱到能交付，${product}跑给你看`,
  (topic, product) => `把「${topic}」交给${product}，结果有点离谱`,
  (topic, product) => `别再硬聊AI了，${topic}先这样拆`,
  (topic, product) => `${topic}效率差距，往往差在第一步`,
  (topic, product) => `普通人做${topic}，先别让AI自由发挥`,
  (topic, product) => `${product}这招，专治${topic}跑偏`,
  (topic, product) => `${topic}别再瞎试，先看这一步`,
  (topic, product) => `我终于知道${topic}为什么慢了`,
  (topic, product) => `${product}处理${topic}，第一步很反常识`,
  (topic, product) => `${topic}想提速，别让模型乱猜`,
  (topic, product) => `把${topic}交给${product}，结果很意外`,
  (topic, product) => `${topic}从混乱到能交付，我只改了流程`,
  (topic, product) => `${topic}真正省时间的是这件小事`,
  (topic, product) => `${product}不是聊天框，${topic}要这样用`,
  (topic, product) => `${topic}跑不出来，可能不是提示词问题`,
  (topic, product) => `${topic}先别追求完美，先拿到初版`
];

function pickBatchInfoFlowAngle(seed = "") {
  return INFO_FLOW_BATCH_TOPIC_ANGLES[variantHash(seed) % INFO_FLOW_BATCH_TOPIC_ANGLES.length];
}

function pickBatchInfoFlow(list = [], seed = "", offset = 0) {
  if (!list.length) return "";
  return list[variantHash(`${seed}:${offset}`) % list.length];
}

function batchInfoFlowTitle({ topic, productName, seed }) {
  const t = String(topic || "").trim() || "这件办公乱事";
  const make = INFO_FLOW_BATCH_TITLE_PATTERNS[variantHash(`${seed}:title`) % INFO_FLOW_BATCH_TITLE_PATTERNS.length];
  const raw = make(t, productName);
  return raw.length > 38 ? `${raw.slice(0, 37)}…` : raw;
}

function buildBatchInfoFlowPlan({ topic = "", product = null, acc = null, seed = "", title = "", copyText = "", publishCopy = "", creativePlan = null } = {}) {
  const productName = infoFlowProductName(product);
  const customTitle = String(title || "").replace(/\s+/g, " ").trim();
  const promptCue = String(copyText || "").trim();
  const customCopy = String(publishCopy || copyText || "").trim();
  const cleanTopic = String(topic || customTitle || "").replace(/\s+/g, " ").trim().slice(0, 48);
  const variantSeed = `${cleanTopic || "auto"}:${seed}:${acc?.id || acc?.name || ""}:${productName}`;
  const direction = pickBatchInfoFlowDirection(variantSeed);
  const angle = pickBatchInfoFlowAngle(`${variantSeed}:angle`);
  const mainTopic = cleanTopic || direction.topic;
  const storyTopic = cleanTopic ? `${mainTopic}｜${angle.name}` : mainTopic;
  const finalTitle = customTitle || (cleanTopic ? batchInfoFlowTitle({ topic: mainTopic, productName, seed: variantSeed }) : direction.title(productName));
  const roleAnchor = infoFlowRoleAnchor(acc);
  const voiceAnchor = infoFlowVoiceAnchor(acc);
  const styleAnchor = "超写实真人信息流质感，真实自然光、真实皮肤和材质、克制手持运镜；前后两段保持同一色温、颗粒和镜头语言。";
  const focus = infoFlowFeatureBrief(`${mainTopic} ${angle.focus}`, productName);
  const frontBase = creativePlan?.frontPrompt || buildInfoFlowFrontBeat({ mainTopic: storyTopic, productName, focus, seed: variantSeed });
  const copy = stripLeadingCopyTitle(customCopy || buildInfoFlowPublishCopy({ title: finalTitle, topic: mainTopic, productName, product }), finalTitle);
  const backBase = creativePlan?.backPrompt || buildInfoFlowBackBeat({ mainTopic: storyTopic, productName, focus, copyText: promptCue || copy, seed: variantSeed });
  const frontPrompt = creativePlan?.frontPrompt ? [creativePlan.frontPrompt, VIDEO_NEGATIVE_PROMPT].join("\n") : [
    "快节奏的信息流广告风格，生成9:16短视频前15秒钩子段。目标是用夸张、具体、可拍出来的办公剧情把观众停住；所选参考图直接用于人物、产品、场景与视觉风格一致性，但前段不出现产品logo和产品界面。镜头每2-4秒切一次。",
    roleAnchor,
    voiceAnchor,
    styleAnchor,
    frontBase,
    VIDEO_NEGATIVE_PROMPT
  ].join("\n");
  const backPrompt = creativePlan?.backPrompt ? [creativePlan.backPrompt, VIDEO_NEGATIVE_PROMPT].join("\n") : [
    "快节奏的信息流广告风格，生成9:16短视频后15秒产品功能演示段。直接使用所选产品、界面与场景参考图继续生成；画面要呼应前段冲突，口播直接讲操作动作和结果，不要使用自指式说明。",
    "B面仅展示真实产品界面、桌面软件窗口和屏幕录制式操作；禁止人物、手部、手指、人体部位、Q版角色和拟人化肢体。界面文字少而清楚，避免高密度文字。",
    voiceAnchor,
    styleAnchor,
    backBase,
    VIDEO_NEGATIVE_PROMPT
  ].join("\n");
  return {
    title: finalTitle,
    topic: mainTopic,
    copy,
    segments: [
      { id: "front15", label: "前15s", title: "前15s钩子", duration: 15, caption: creativePlan?.creativeAngle || finalTitle, visual: frontBase, videoPrompt: frontPrompt },
      { id: "back15", label: "后15s", title: "后15s功能演示", duration: 15, caption: creativePlan?.creativeAngle ? `承接「${creativePlan.creativeAngle}」的冲突，用产品界面完成解决。` : `我把这件事交给${productName}，让它先拆步骤、跑资料、给出初版。`, visual: backBase, videoPrompt: backPrompt }
    ]
  };
}

function applyBatchInfoFlowPlan(p, plan, { preserveCopy = false } = {}) {
  const A = p.artifacts.boards || (p.artifacts.boards = {});
  A.materialMode = "infoFlow";
  const oldCopy = p.artifacts.copy || {};
  const nextTitle = preserveCopy
    ? (oldCopy.title || p.title || plan.title || p.topic || "")
    : (plan.title || p.title || p.topic || "");
  const nextBody = preserveCopy
    ? (oldCopy.body || plan.copy || "")
    : (plan.copy || oldCopy.body || "");
  A.infoFlow = {
    ...(A.infoFlow || {}),
    status: "ready",
    error: "",
    segments: (plan.segments || []).slice(0, 2).map(seg => ({
      ...seg,
      videoPrompt: stripInfoFlowDirectorNotes(seg.videoPrompt || "")
    }))
  };
  p.topic = plan.topic || p.topic || "";
  p.title = nextTitle;
  p.artifacts.script.title = p.title;
  p.artifacts.copy = { ...oldCopy, title: nextTitle, body: nextBody };
  Object.assign(p.artifacts.audio, {
    assetId: null,
    duration: 30,
    perShot: [{ dur: 15 }, { dur: 15 }],
    source: "seedance-native",
    lastError: ""
  });
  buildMaterialUnits(p);
  touch(p);
}

function referenceRewriteForCopy(trendPrep, copy) {
  const rw = trendPrep?.referenceRewrite || null;
  if (!rw) return null;
  return {
    ...rw,
    rewrite: {
      ...(rw.rewrite || {}),
      title: copy?.title || rw.rewrite?.title || "",
      copy: copy?.body || copy?.copy || rw.rewrite?.copy || "",
      tags: copyTags(copy?.body || copy?.copy || "", rw.rewrite?.tags || [])
    }
  };
}

function ensureVideoCoverPrompt(p, product = null) {
  if (!p || p.mode === "图文") return;
  const A = p.artifacts?.boards || (p.artifacts.boards = {});
  A.cover = A.cover || { prompt: "", assetId: null, refAssetIds: [], status: "idle", error: "" };
  const title = (p.artifacts?.copy?.title || p.title || p.topic || "").trim();
  if (!title) return;
  if (A.cover.prompt && A.cover.prompt.includes(title)) return;
  const style = coverStyleHint(`${title}:${product?.id || product?.name || ""}:${p.id || ""}`);
  A.cover.prompt = [
    "这是一张具有冲击力的短视频封面图，比例3:4，文字清晰明显。",
    `标题内容：${title}`,
    `风格描述：${style}。`,
    IMAGE_NEGATIVE_PROMPT
  ].filter(Boolean).join("\n");
  A.cover.status = A.cover.status || "idle";
  A.cover.refAssetIds = Array.isArray(A.cover.refAssetIds) ? A.cover.refAssetIds.filter(Boolean).slice(0, 8) : [];
}

export function batchCoverRefIds(batch, accountId = "") {
  const customRaw = batch?.accountRefAssetIds?.[accountId];
  return [...new Set([
    ...(Array.isArray(batch?.coverRefAssetIds) ? batch.coverRefAssetIds : []),
    ...(Array.isArray(customRaw) ? customRaw : [customRaw])
  ].filter(Boolean))].slice(0, 8);
}

export function batchSceneRefIds(batch, accountId = "") {
  // 信息流允许把任务参考图同时交给视频和封面；真人/数字人视频只接收角色版与口播音频，
  // 任务里的统一/定制参考图仅用于封面，避免产品图或风格图污染角色生成。
  return batch?.contentKind === "material" ? batchCoverRefIds(batch, accountId) : [];
}

export function applyBatchCoverRefs(p, batch) {
  if (!p || p.mode === "图文") return;
  const account = accountById(p.accountId);
  const ids = [...new Set([
    ...batchCoverRefIds(batch, p.accountId),
    p.subType === "数字人" ? account?.charBoardAssetId : null
  ].filter(Boolean))].slice(0, 8);
  if (!ids.length) return;
  const A = p.artifacts?.boards || (p.artifacts.boards = {});
  A.cover = A.cover || { prompt: "", assetId: null, refAssetIds: [], status: "idle", error: "" };
  A.cover.refAssetIds = [...new Set([...(A.cover.refAssetIds || []), ...ids])].slice(0, 8);
}

async function generateVideoCoverInHouse(p, { force = false } = {}) {
  if (!p || p.mode === "图文") return false;
  const A = p.artifacts?.boards || {};
  const cover = A.cover || null;
  if (!cover?.prompt || (!force && cover.assetId) || cover.status === "loading") return false;
  if (!imageApiConfigured()) return false;
  const provider = activeProviderFor("image");
  if (!provider || provider.mock) return false;
  const key = providerKeyFor("image", provider);
  cover.status = "loading";
  cover.error = "";
  cover.referenceReceipt = null;
  save("productions");
  try {
    const refs = await imageRefsForIds(cover.refAssetIds || [], "cover");
    const req = await provider.submit({
      prompt: enrichBatchImagePrompt(cover.prompt, refs),
      refs,
      intendedRefAssetIds: cover.refAssetIds || [],
      ratio: "3:4",
      apiKey: key?.secret,
      endpoint: key?.provider,
      model: key?.model || "custom-imagemodel-gt"
    });
    const out = await provider.poll(req.providerRef);
    cover.referenceReceipt = out.output?.referenceReceipt || req.referenceReceipt || null;
    if (out.status !== "succeeded" || !out.output?.dataUrl) throw new Error(out.error || "封面图未返回结果");
    const raw = out.output.dataUrl.startsWith("data:") ? out.output.dataUrl : await dataUrlFromUrl(out.output.dataUrl);
    const title = (p.artifacts?.copy?.title || p.title || p.topic || "视频封面").trim();
    const polished = await polishImageDataUrl(raw, `${p.id}-batch-cover-${title}`);
    if (force && cover.assetId) {
      await replaceAssetBlob(cover.assetId, polished);
    } else {
      const a = await addAssetFromDataUrl(p.accountId, {
        name: `视频封面_${title.slice(0, 12)}`,
        tags: ["视频封面", "站内生成", "批量封面", "账号资产"],
        dataUrl: polished
      });
      cover.assetId = a.id;
    }
    cover.status = "done";
    cover.error = "";
    save("productions");
    return true;
  } catch (err) {
    cover.status = "failed";
    cover.error = err.message || String(err);
    if (err?.referenceReceipt) cover.referenceReceipt = err.referenceReceipt;
    save("productions");
    return false;
  }
}

export async function regenerateBatchVideoCover(p, prompt = "", refAssetIds = null) {
  if (!p || p.mode === "图文" || !p.batchId) throw new Error("当前任务不是批量视频任务");
  const cover = p.artifacts?.boards?.cover;
  if (!cover) throw new Error("当前任务还没有封面配置");
  const nextPrompt = String(prompt || cover.prompt || "").trim();
  if (!nextPrompt) throw new Error("请先填写封面提示词");
  cover.prompt = nextPrompt;
  if (Array.isArray(refAssetIds)) cover.refAssetIds = [...new Set(refAssetIds.filter(Boolean))].slice(0, 8);
  const ok = await generateVideoCoverInHouse(p, { force: true });
  if (!ok) throw new Error(cover.error || "封面重新生成失败");
  return cover;
}

/* ---------- 会话 ---------- */
export function ensureSession() {
  let s = mySessions().find(x => x.id === state.ui.activeSessionId);
  if (!s) s = mySessions()[0] || newSession();
  state.ui.activeSessionId = s.id;
  return s;
}
/* 当前成员名下的会话（每人会话隔离，聊天记录不共享） */
export function mySessions() {
  return state.sessions.filter(ownedBy);
}
export function newSession() {
  // 已有空会话则复用，避免堆积
  const empty = mySessions().find(s => !(s.messages || []).length);
  if (empty) {
    state.ui.activeSessionId = empty.id;
    save("meta");
    emit("agent:session");
    return empty;
  }
  const s = { id: uid(), ownerId: state.ui.currentMemberId || null, title: "新会话", createdAt: Date.now(), messages: [] };
  state.sessions.unshift(s);
  state.ui.activeSessionId = s.id;
  save("sessions", "meta");
  emit("agent:session");
  return s;
}
export function renameSession(id, title) {
  const s = state.sessions.find(x => x.id === id);
  if (s && title) { s.title = title.slice(0, 24); save("sessions"); emit("agent:session"); }
}
export async function deleteSession(id) {
  const target = state.sessions.find(x => x.id === id);
  if (!target || !ownedBy(target)) return;
  await removeRemoteAsync("sessions", id);
  state.sessions = state.sessions.filter(x => x.id !== id);
  if (state.ui.activeSessionId === id) state.ui.activeSessionId = mySessions()[0]?.id || null;
  save("sessions", "meta");
  emit("agent:session");
}
/* 启动清理：历史遗留的空会话只保留最新一个 */
export function pruneEmptySessions() {
  const empties = mySessions().filter(s => !(s.messages || []).length);
  if (empties.length > 1) {
    const keep = empties[0].id;
    state.sessions = state.sessions.filter(s => (s.messages || []).length || !ownedBy(s) || s.id === keep);
    if (!mySessions().find(s => s.id === state.ui.activeSessionId)) state.ui.activeSessionId = mySessions()[0]?.id || null;
    save("sessions", "meta");
  }
}
/* 某会话下的批次（任务看板按会话独立） */
export function sessionBatches(sessionId) {
  return state.batches.filter(b => b.sessionId === sessionId);
}
/* 删除整批（连同未交付的在制产物与其 job） */
export async function deleteBatch(batchId) {
  const b = batchById(batchId); if (!b) return;
  const ids = b.productionIds || [];
  const removedProdIds = state.productions.filter(p => ids.includes(p.id) && p.stage !== "delivered").map(p => p.id);
  const removedJobIds = state.jobs.filter(j => removedProdIds.includes(j.productionId)).map(j => j.id);
  await Promise.all([
    removeRemoteAsync("batches", batchId),
    removeRemoteAsync("productions", ...removedProdIds),
    removeRemoteAsync("jobs", ...removedJobIds)
  ]);
  state.productions = state.productions.filter(p => !(ids.includes(p.id) && p.stage !== "delivered"));
  state.jobs = state.jobs.filter(j => !ids.includes(j.productionId) || state.productions.some(p => p.id === j.productionId));
  state.batches = state.batches.filter(x => x.id !== batchId);
  save("productions", "jobs", "batches");
  emit("batch:update", b);
}
/* 从批次里删除单条任务 */
export async function removeProductionFromBatch(pid) {
  const p = productionById(pid);
  const jobIds = state.jobs.filter(j => j.productionId === pid).map(j => j.id);
  await Promise.all([
    removeRemoteAsync("productions", pid),
    removeRemoteAsync("jobs", ...jobIds)
  ]);
  state.productions = state.productions.filter(x => x.id !== pid);
  state.jobs = state.jobs.filter(j => j.productionId !== pid);
  state.batches.forEach(b => { b.productionIds = (b.productionIds || []).filter(id => id !== pid); });
  save("productions", "jobs", "batches");
  if (p) emit("production:update", p);
}
export function addMsg(session, msg) {
  const m = { id: uid(), ts: Date.now(), ...msg };
  session.messages.push(m);
  if (session.title === "新会话" && msg.role === "user" && msg.type === "text") {
    session.title = (msg.payload.text || "").slice(0, 18) || "新会话";
  }
  save("sessions");
  emit("agent:msg", m);
  return m;
}
export function agentSay(text, extra = {}) {
  return addMsg(ensureSession(), { role: "agent", type: "text", payload: { text }, ...extra });
}

/* ---------- 批次 ---------- */
export function createBatch(plan, sessionId) {
  enforcePlanKind(plan);
  const customTitles = Object.values(plan.accountCopyTitles || {}).map(x => String(x || "").trim()).filter(Boolean);
  const sharedRefAssetIds = [...new Set([
    ...(Array.isArray(plan.sharedRefAssetIds) ? plan.sharedRefAssetIds : []),
    plan.sharedRefAssetId
  ].filter(Boolean))];
  const coverRefAssetIds = [...new Set(Array.isArray(plan.coverRefAssetIds) ? plan.coverRefAssetIds.filter(Boolean) : [])].slice(0, 5);
  const accountRefAssetIds = Object.fromEntries(
    Object.entries(plan.accountRefAssetIds || {}).map(([accountId, ids]) => [accountId, [...ids]])
  );
  const accountCustomCopyModes = { ...(plan.accountCustomCopyModes || {}) };
  (plan.accountIds || []).forEach(id => {
    if (accountCustomCopyModes[id] == null) accountCustomCopyModes[id] = plan.creativeMode === "custom";
  });
  const batch = {
    id: uid(), sessionId,
    planMessageId: plan.planMessageId || "",
    ownerId: state.ui.currentMemberId || null,
    goal: plan.goal || "",
    creativeMode: plan.creativeMode || "custom",
    contentKind: plan.contentKind || "image",
    topic: (plan.content || "").trim() || (plan.topic || "").trim() || customTitles[0] || "",
    topicMode: "fixed",
    productId: plan.productId || "dumate",
    content: plan.content || "",
    accountProductIds: plan.accountProductIds || {},
    accountContents: plan.accountContents || {},
    accountCustomCopyModes,
    accountCopyTitles: plan.accountCopyTitles || {},
    accountCopyBodies: plan.accountCopyBodies || {},
    accountImageCreationModes: plan.accountImageCreationModes || {},
    accountImagePrompts: plan.accountImagePrompts || {},
    accountSingleImageTitles: plan.accountSingleImageTitles || {},
    accountCounts: plan.accountCounts || {},
    accountImageCounts: plan.accountImageCounts || {},
    useOnlineTrends: false,
    imageCount: Math.max(1, Math.min(12, Number(plan.imageCount || DEFAULT_XHS_IMAGE_COUNT) || DEFAULT_XHS_IMAGE_COUNT)),
    style: plan.style || "",
    accountCount: Number(plan.accountCount || plan.count) || null,
    perAccountCount: Math.max(1, Math.min(12, Number(plan.perAccountCount || 1) || 1)),
    referenceSelectionId: plan.referenceSelectionId || uid(),
    sharedRefAssetId: sharedRefAssetIds[0] || null,  // 兼容旧字段
    sharedRefAssetIds,                               // 批量统一参考图（所有账号共用 logo/产品界面，可多张）
    coverRefAssetIds,                                // 批量统一视频参考图：给封面和信息流 B 面分镜共用
    accountRefAssetIds,                              // 单账号定制参考图（批次快照，不与计划卡共享对象）
    tags: [], group: plan.group || "all",
    accountIds: plan.accountIds || [],
    productionIds: [],
    phase: "drafting",         // drafting | awaiting_input | generating | review | done
    autoAdvance: true,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  state.batches.push(batch);
  save("batches");
  return batch;
}

/* 固定流程模板：只预选账号与内容类型，标题和文案由用户逐个填写。 */
export const FLOW_TEMPLATES = {
  notes: { label: "全部图文号 · 自定义笔记", group: "图文组", icon: "image", desc: "预选图文账号 · 逐个填写标题与正文" },
  material: { label: "全部素材号 · 自定义视频", group: "素材", icon: "layers", desc: "预选素材账号 · 逐个填写标题与文案" },
  dh: { label: "全部真人号 · 自定义口播", group: "真人", icon: "user", desc: "预选真人账号 · 逐个填写标题与口播文案" }
};
export function templatePlan(key) {
  const t = FLOW_TEMPLATES[key];
  if (!t) return null;
  const matched = selectAccountsForPlan({ tags: [], group: t.group, accountCount: 3, sort: "stale" });
  return enforcePlanKind({
    goal: t.label, creativeMode: "custom", contentKind: contentKindFromGroup(t.group), topicMode: "fixed", topic: "", productId: "dumate", content: "", style: "",
    tags: [], group: t.group, sort: "stale", accountCount: 3, perAccountCount: 1,
    accountIds: matched.map(a => a.id), template: key,
    accountCounts: {},
    accountCustomCopyModes: {}, accountCopyTitles: {}, accountCopyBodies: {},
    accountImageCreationModes: {}, accountImagePrompts: {}, accountSingleImageTitles: {},
    useOnlineTrends: false,
    sharedRefAssetIds: [], coverRefAssetIds: [], accountRefAssetIds: {}
  });
}
export const batchById = id => state.batches.find(b => b.id === id);
export const batchProds = b => (b.productionIds || []).map(productionById).filter(Boolean);
export const activeBatches = () => state.batches.filter(b => b.phase !== "done" && ownedBy(b));
/* 当前会话的批次（看板按会话独立） */
export const currentSessionBatches = () => sessionBatches(state.ui.activeSessionId)
  .filter(ownedBy)
  .filter(b => (b.productionIds || []).length);

function accountLastActivityAt(acc) {
  const prodTimes = state.productions
    .filter(p => p.accountId === acc.id)
    .map(p => p.deliveredAt || p.updatedAt || p.createdAt || 0);
  const assetTimes = state.assets
    .filter(a => a.accountId === acc.id && a.delivered)
    .map(a => a.publishedAt || a.updatedAt || a.createdAt || 0);
  return Math.max(acc.lastPublishedAt || 0, acc.updatedAt || 0, acc.createdAt || 0, ...prodTimes, ...assetTimes);
}

export function matchAccounts({ group = "all", sort = "" } = {}) {
  const list = state.accounts.filter(a => !isAccountDisabled(a) && (group === "all" || !group || groupOf(a) === group));
  if (sort === "stale") {
    list.sort((a, b) => accountLastActivityAt(a) - accountLastActivityAt(b) || String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN"));
  }
  return list;
}

export function selectAccountsForPlan(params = {}) {
  const matched = matchAccounts(params);
  const want = Number(params.accountCount || params.count);
  if (want > 0 && want < matched.length) {
    if (params.pickFrom === "end") return matched.slice(-want);
    return matched.slice(0, want);
  }
  return matched;
}

export function defaultPlan(goal = "新量产计划") {
  const fb = parseGoalFallback(goal);
  const params = {
    ...fb,
    group: fb.group && fb.group !== "all" ? fb.group : "all",
    sort: fb.sort || "stale",
    accountCount: fb.accountCount || fb.count || null,
    perAccountCount: fb.perAccountCount || 1
  };
  return enforcePlanKind({
    status: "pending", goal,
    creativeMode: "custom", contentKind: "image",
    topicMode: "fixed", topic: "",
    productId: "dumate", content: "",
    accountProductIds: {}, accountContents: {},
    accountCustomCopyModes: {}, accountCopyTitles: {}, accountCopyBodies: {}, accountSingleImageTitles: {},
    accountCounts: {},
    accountImageCounts: {}, accountImageCreationModes: {}, accountImagePrompts: {},
    useOnlineTrends: false,
    imageCount: DEFAULT_XHS_IMAGE_COUNT,
    style: params.style || "", tags: [], group: params.group,
    sort: params.sort,
    pickFrom: params.pickFrom || "",
    accountCount: params.accountCount,
    perAccountCount: params.perAccountCount,
    accountIds: [],
    sharedRefAssetIds: [], coverRefAssetIds: [], accountRefAssetIds: {}
  });
}

async function polishImageDataUrl(dataUrl, seedText = "") {
  return polishImageForPublish(dataUrl, seedText);
}

async function dataUrlFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("图片 URL 下载失败：" + res.status);
  return await fileToDataUrl(await res.blob());
}

function imageRefGroupsFor(acc, batch, p) {
  const uniq = arr => [...new Set(arr.filter(Boolean))];
  const shared = uniq([
    ...(Array.isArray(batch.sharedRefAssetIds) ? batch.sharedRefAssetIds : []),
    batch.sharedRefAssetId
  ]);
  const customRaw = batch.accountRefAssetIds?.[acc.id];
  const custom = uniq(Array.isArray(customRaw) ? customRaw : [customRaw]);
  const sharedIds = shared.slice(0, 5);
  const customIds = custom.slice(0, 3);
  return {
    shared: sharedIds,
    custom: customIds,
    all: uniq([...sharedIds, ...customIds]).slice(0, 8)
  };
}

async function imageRefsForIds(ids, role = "shared") {
  const refs = [];
  for (const id of ids) {
    const a = state.assets.find(x => x.id === id);
    if (!a) continue;
    let blob = null;
    try { blob = await assetBlob(id); } catch (_) { blob = null; }
    const u = urlFor(a);
    let dataUrl = "";
    let publicUrl = "";
    if (blob) dataUrl = await fileToDataUrl(blob);
    else if (/^data:/.test(u || "")) dataUrl = u;
    else if (/^https?:\/\//.test(u || "")) publicUrl = u;
    else if (u) {
      try { dataUrl = await dataUrlFromUrl(u); } catch (_) { /* ignore */ }
    }
    if (dataUrl || publicUrl) {
      refs.push({ id, role, name: a.name || "参考图", type: a.type, mime: a.mime || blob?.type || "image/png", url: publicUrl, dataUrl });
    }
  }
  return refs;
}

function enrichBatchImagePrompt(prompt, refs) {
  if (!refs.length) return prompt || "";
  const shared = refs.filter(r => r.role !== "custom");
  const custom = refs.filter(r => r.role === "custom");
  const sharedNames = shared.map(r => r.name).filter(Boolean).slice(0, 5).join("、");
  const customNames = custom.map(r => r.name).filter(Boolean).slice(0, 3).join("、");
  const customNote = custom.length ? `\n定制参考图：另提供 ${custom.length} 张本账号专属参考图（${customNames}）。` : "";
  const body = String(prompt || "").replace(/负面约束\s*[:：][\s\S]*$/g, "").trim();
  const refNote = `参考图：本次提供 ${refs.length} 张参考图（${[sharedNames, customNames].filter(Boolean).join("、")}），以本次提示词的主题和文字内容为准。${customNote}`;
  return `${body}\n\n${refNote}\n\n${IMAGE_NEGATIVE_PROMPT}`.trim();
}

function splitBatchCopyBeats(title = "", body = "", count = DEFAULT_XHS_IMAGE_COUNT) {
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
  const cleanBody = String(body || "")
    .replace(/#[^\s#]+/g, " ")
    .replace(/\n+/g, "。")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = cleanBody
    .split(/[。！？!?；;]+/)
    .map(x => x.trim())
    .filter(x => x && x.length > 4);
  const beats = [cleanTitle, ...sentences].filter(Boolean);
  const fallback = cleanTitle || sentences[0] || "本次文案主题";
  return Array.from({ length: count }, (_, i) => beats[i] || beats[beats.length - 1] || fallback);
}

function buildBatchCustomCopyShots(copy, count, product) {
  const title = String(copy?.title || "").trim();
  const body = String(copy?.body || copy?.copy || "").trim();
  const productName = product?.shortName || product?.name || "百度搭子";
  const beats = splitBatchCopyBeats(title, body, count);
  return beats.map((beat, i) => {
    const shortBeat = String(beat || "").slice(0, i === 0 ? 38 : 52);
    if (i === 0) {
      return {
        idea: title || shortBeat,
        visual: `围绕发布标题「${title || shortBeat}」做强点击入口，主视觉、文字和副标题都服务这篇文案，不引入文案外的新主题。`,
        line: title || shortBeat
      };
    }
    return {
      idea: shortBeat,
      visual: `围绕发布文案里的信息「${shortBeat}」展开，用${productName}相关的真实办公动作、流程卡片、结果对照或可复核清单表达。`,
      line: shortBeat
    };
  });
}

function buildVideoCustomCopyShots(copy, product, isDigital = false) {
  const title = String(copy?.title || "").trim();
  const body = String(copy?.body || copy?.copy || "").trim();
  const productName = product?.shortName || product?.name || "百度搭子";
  const raw = body || title;
  const sentences = String(raw || "")
    .replace(/#[^\s#]+/g, " ")
    .replace(/\n+/g, "。")
    .split(/[。！？!?；;]+/)
    .map(x => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const beats = sentences.length ? sentences : [title || `${productName}本期口播`];
  const max = isDigital ? 14 : 10;
  return beats.slice(0, max).map((line, i) => ({
    time: "",
    idea: i === 0 ? (title || line).slice(0, 40) : line.slice(0, 44),
    visual: isDigital
      ? (i === 0
        ? `固定真人/数字人正面中近景开场，围绕标题「${title || line}」自然开口，神态真实，背景是干净办公桌。`
        : `真人/数字人延续同一角色口播，旁边穿插${productName}任务卡、资料整理结果或界面局部，画面服务这句口播：「${line.slice(0, 42)}」。`)
      : `围绕这句口播生成可拍画面：「${line.slice(0, 42)}」。画面以办公物件、手部操作、产品界面、资料流转或结果展示推进，不偏离用户自定义文案。`,
    line,
    ui: !isDigital || i % 3 !== 1,
    scene: i + 1
  }));
}

async function generateBatchImagesInHouse(p, batch, acc) {
  if (!imageApiConfigured()) return false;
  const provider = activeProviderFor("image");
  if (!provider || provider.mock) return false;
  const key = providerKeyFor("image", provider);
  const A = p.artifacts.images;
  const refGroups = imageRefGroupsFor(acc, batch, p);
  A.usedSharedRefAssetIds = refGroups.shared;
  A.usedCustomRefAssetIds = refGroups.custom;
  A.usedRefAssetIds = refGroups.all;
  const defaultRefs = [
    ...(await imageRefsForIds(refGroups.shared, "shared")),
    ...(await imageRefsForIds(refGroups.custom, "custom"))
  ].slice(0, 8);
  const items = A.items || [];
  setStage(p, "images", "running");
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it?.prompt) continue;
    const hasItemRefOverride = Object.prototype.hasOwnProperty.call(it, "refAssetIds");
    if (it.assetId && it.status === "done") continue;
    if (!hasItemRefOverride) {
      it.refAssetIds = [...refGroups.all];
      it.referenceSource = "batch-plan";
      it.referenceSelectionId = batch.referenceSelectionId || "";
    } else if (!it.referenceSource) {
      it.referenceSource = "item";
    }
    const refs = hasItemRefOverride
      ? await imageRefsForIds(Array.isArray(it.refAssetIds) ? it.refAssetIds.slice(0, 8) : [], "custom")
      : defaultRefs;
    const intendedRefAssetIds = Array.isArray(it.refAssetIds) ? it.refAssetIds.slice(0, 8) : [];
    it.status = "loading";
    it.error = "";
    it.referenceReceipt = null;
    save("productions");
    try {
      const req = await provider.submit({
        prompt: enrichBatchImagePrompt(it.prompt, refs),
        refs,
        intendedRefAssetIds,
        ratio: "3:4",
        apiKey: key?.secret,
        endpoint: key?.provider,
        model: key?.model || ""
      });
      const out = await provider.poll(req.providerRef);
      it.referenceReceipt = out.output?.referenceReceipt || req.referenceReceipt || null;
      if (out.status !== "succeeded" || !out.output?.dataUrl) throw new Error(out.error || `第 ${i + 1} 张图片生成未返回结果`);
      const raw = out.output.dataUrl.startsWith("data:") ? out.output.dataUrl : await dataUrlFromUrl(out.output.dataUrl);
      const polished = await polishImageDataUrl(raw, `${p.id}-batch-${i}-${p.topic || ""}`);
      const a = await addAssetFromDataUrl(acc.id, {
        name: `站内笔记图${String(i + 1).padStart(2, "0")}_${(it.title || p.title || "").slice(0, 10)}`,
        tags: ["笔记图", "站内生成", "发布前精修"],
        dataUrl: polished
      });
      it.assetId = a.id;
      it.status = "done";
      save("productions");
    } catch (err) {
      it.status = "failed";
      it.error = err?.message || String(err);
      if (err?.referenceReceipt) it.referenceReceipt = err.referenceReceipt;
      save("productions");
      throw err;
    }
  }
  return items.length > 0 && items.every(x => x.assetId);
}

export async function regenerateBatchImage(p, imageIndex) {
  if (!p || p.mode !== "图文") throw new Error("当前任务不是图文生产");
  const item = p.artifacts.images?.items?.[Number(imageIndex)];
  if (!item?.prompt?.trim()) throw new Error("请先填写这张图的提示词");
  const batch = batchById(p.batchId);
  const acc = accountById(p.accountId);
  if (!batch || !acc) throw new Error("批次或账号不存在");
  if (!imageApiConfigured()) throw new Error("图片生成服务未配置");
  const provider = activeProviderFor("image");
  if (!provider || provider.mock) throw new Error("图片生成服务当前不可用");
  const key = providerKeyFor("image", provider);
  const refGroups = imageRefGroupsFor(acc, batch, p);
  const hasItemRefOverride = Object.prototype.hasOwnProperty.call(item, "refAssetIds");
  const refs = hasItemRefOverride
    ? await imageRefsForIds(Array.isArray(item.refAssetIds) ? item.refAssetIds.slice(0, 8) : [], "custom")
    : [
        ...(await imageRefsForIds(refGroups.shared, "shared")),
        ...(await imageRefsForIds(refGroups.custom, "custom"))
      ].slice(0, 8);
  const intendedRefAssetIds = hasItemRefOverride
    ? (Array.isArray(item.refAssetIds) ? item.refAssetIds.slice(0, 8) : [])
    : refGroups.all;
  item.status = "loading";
  item.error = "";
  item.referenceReceipt = null;
  save("productions");
  try {
    const req = await provider.submit({
      prompt: enrichBatchImagePrompt(item.prompt, refs),
      refs,
      intendedRefAssetIds,
      ratio: "3:4",
      apiKey: key?.secret,
      endpoint: key?.provider,
      model: key?.model || ""
    });
    const out = await provider.poll(req.providerRef);
    item.referenceReceipt = out.output?.referenceReceipt || req.referenceReceipt || null;
    if (out.status !== "succeeded" || !out.output?.dataUrl) throw new Error(out.error || "图片生成未返回结果");
    const raw = out.output.dataUrl.startsWith("data:") ? out.output.dataUrl : await dataUrlFromUrl(out.output.dataUrl);
    const polished = await polishImageDataUrl(raw, `${p.id}-batch-regen-${Number(imageIndex)}-${p.topic || ""}`);
    if (item.assetId) await replaceAssetBlob(item.assetId, polished);
    else {
      const asset = await addAssetFromDataUrl(acc.id, {
        name: `站内笔记图${String(Number(imageIndex) + 1).padStart(2, "0")}_${(item.title || p.title || "").slice(0, 10)}`,
        tags: ["笔记图", "站内生成", "发布前精修"],
        dataUrl: polished
      });
      item.assetId = asset.id;
    }
    item.status = "done";
    item.updatedAt = Date.now();
    save("productions");
    return item;
  } catch (err) {
    item.status = "failed";
    item.error = err?.message || String(err);
    if (err?.referenceReceipt) item.referenceReceipt = err.referenceReceipt;
    save("productions");
    throw err;
  }
}

async function runBatchImagesToReview(p, batch) {
  if (activeImageRecoveries.has(p.id)) return false;
  const acc = accountById(p.accountId);
  if (!acc) {
    setStatus(p, "failed", "账号不存在");
    return false;
  }
  activeImageRecoveries.add(p.id);
  try {
    setBatchPhase(batch, "generating");
    const generated = await generateBatchImagesInHouse(p, batch, acc);
    setStage(p, generated ? "review" : "images", generated ? "pending" : "needs_input");
    return generated;
  } catch (e) {
    setStatus(p, "failed", "站内图片生成失败：" + (e.message || e));
    return false;
  } finally {
    activeImageRecoveries.delete(p.id);
    evaluate(batch.id);
  }
}

export function reconcileBatchDigitalSegments(p, acc) {
  const A = p.artifacts.boards || (p.artifacts.boards = {});
  const previous = Array.isArray(A.digitalHuman?.segments) ? A.digitalHuman.segments : [];
  const planned = planDigitalNarrationSegments(p.artifacts.script.shots || []);
  const claimed = new Set();
  const characterRefAssetId = A.characterRefAssetId || acc?.charBoardAssetId || null;
  const segments = planned.map(plan => {
    let previousIndex = previous.findIndex((segment, index) =>
      !claimed.has(index) && String(segment.line || "").trim() === String(plan.line || "").trim()
    );
    const exactLine = previousIndex >= 0;
    if (previousIndex < 0) {
      previousIndex = previous.findIndex((segment, index) =>
        !claimed.has(index)
        && (segment.shotIndexes || []).some(shotIndex => plan.shotIndexes.includes(shotIndex))
      );
    }
    if (previousIndex >= 0) claimed.add(previousIndex);
    const old = previousIndex >= 0 ? previous[previousIndex] : null;
    const customCharacterRefAssetId = old?.customCharacterRefAssetId || "";
    return {
      id: old?.id || uid(),
      shotIndexes: [...plan.shotIndexes],
      dur: plan.dur,
      line: plan.line,
      characterRefAssetId: customCharacterRefAssetId || characterRefAssetId,
      customCharacterRefAssetId,
      audioAssetId: exactLine ? (old?.audioAssetId || null) : null,
      audioDuration: exactLine ? Number(old?.audioDuration || 0) : 0,
      voiceId: exactLine ? (old?.voiceId || "") : "",
      status: exactLine && old?.audioAssetId ? "audioReady" : "pending",
      videoJobId: exactLine ? (old?.videoJobId || null) : null,
      videoStatus: exactLine ? (old?.videoStatus || "pending") : "pending",
      videoPrompt: DIGITAL_HUMAN_FIXED_PROMPT,
      videoOutput: exactLine ? (old?.videoOutput || null) : null,
      videoError: exactLine ? (old?.videoError || "") : ""
    };
  });
  A.digitalHuman = {
    ...(A.digitalHuman || {}),
    provider: A.digitalHuman?.provider || "reserved",
    model: A.digitalHuman?.model || "digital-human-api-placeholder",
    fixedPrompt: DIGITAL_HUMAN_FIXED_PROMPT,
    segments
  };
  return segments;
}

export async function prepareBatchDigitalHuman(p, acc, deps = {}) {
  enforceSupportedVideoMode(p);
  const segments = reconcileBatchDigitalSegments(p, acc);
  if (!segments.length) return { ready: false, error: "数字人口播为空，无法创建分段" };
  const assetExists = deps.assetExists || (id => !!state.assets.find(asset => asset.id === id));
  const characterMissing = segments.some(segment => !segment.characterRefAssetId || !assetExists(segment.characterRefAssetId));
  if (characterMissing) return { ready: false, error: "数字人账号缺少角色形象，请先在账号主页上传角色版参考图" };
  const voiceId = p.artifacts.audio.voiceId || acc?.voiceId || defaultTtsVoiceId() || "";
  if (!voiceId) return { ready: false, error: "数字人账号缺少固定声线，请先在账号设置里选择声线" };
  segments.forEach(segment => {
    if (!segment.audioAssetId || segment.voiceId === voiceId) return;
    segment.audioAssetId = null;
    segment.audioDuration = 0;
    segment.voiceId = "";
    segment.status = "pending";
    segment.videoJobId = null;
    segment.videoStatus = "pending";
    segment.videoOutput = null;
  });
  let isTtsConfigured = deps.ttsConfigured == null ? ttsApiConfigured() : !!deps.ttsConfigured;
  if (deps.ttsConfigured == null && !isTtsConfigured) {
    await refreshProviderStatus().catch(() => null);
    isTtsConfigured = ttsApiConfigured();
  }
  if (!isTtsConfigured) return { ready: false, error: "服务器未配置 Minimax TTS，无法自动生成数字人口播" };
  const synthesize = deps.synthesize || synthesizeTts;
  const storeAudio = deps.storeAudio || (async ({ index, dataUrl }) => addAssetFromDataUrl(acc.id, {
    name: `数字人口播_D${String(index + 1).padStart(2, "0")}_${(p.title || p.topic || "视频").slice(0, 8)}`,
    type: "音频",
    tags: ["口播音频", "Minimax", "数字人分段", "账号资产"],
    dataUrl
  }));
  let total = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment.audioAssetId && assetExists(segment.audioAssetId)) {
      total += Number(segment.audioDuration || segment.dur || 0);
      continue;
    }
    try {
      const output = await synthesize({ text: segment.line, voiceId, speed: 1.2 });
      const asset = await storeAudio({ index, dataUrl: output.audioDataUrl, segment, output });
      if (!asset?.id) throw new Error("口播音频保存失败");
      segment.audioAssetId = asset.id;
      segment.audioDuration = Math.round(Number(output.duration || segment.dur || 0) * 10) / 10;
      segment.voiceId = output.voiceId || voiceId;
      segment.status = "audioReady";
      segment.videoStatus = "pending";
      segment.videoJobId = null;
      segment.videoOutput = null;
      total += Number(segment.audioDuration || segment.dur || 0);
      save("productions");
    } catch (error) {
      p.artifacts.audio.lastError = error?.message || "Minimax TTS 生成失败";
      save("productions");
      return { ready: false, error: `数字人第 ${index + 1} 段口播生成失败：${p.artifacts.audio.lastError}` };
    }
  }
  const estimated = estimateAudio(p.artifacts.script.shots || []);
  Object.assign(p.artifacts.audio, {
    assetId: null,
    perShot: estimated.perShot,
    duration: Math.round(total * 10) / 10,
    source: "tts-segments",
    voiceId,
    voiceRefAssetId: null,
    lastError: "",
    segmentsReady: true
  });
  p.artifacts.boards.digitalHuman.segments = segments;
  save("productions");
  return { ready: true, count: segments.length, duration: p.artifacts.audio.duration };
}

async function queueBatchDigitalHuman(p, batch, acc, product) {
  const A = p.artifacts.boards;
  p.artifacts.subStyle = { ...(p.artifacts.subStyle || {}), size: 15 };
  A.characterRefAssetId = A.characterRefAssetId || acc?.charBoardAssetId || null;
  applyBatchCoverRefs(p, batch);
  ensureVideoCoverPrompt(p, product);
  await generateVideoCoverInHouse(p);
  const prepared = await prepareBatchDigitalHuman(p, acc);
  if (!prepared.ready) {
    A.digitalHuman = A.digitalHuman || { segments: [] };
    A.digitalHuman.error = prepared.error;
    setStage(p, "workshop", "needs_input");
    setStatus(p, "needs_input", prepared.error);
    save("productions");
    return false;
  }
  A.digitalHuman.error = "";
  setStage(p, "workshop", "running");
  const queued = createUnitVideoJobs(p);
  const active = jobsOf(p).some(job => ["queued", "submitted", "running"].includes(job.status));
  if (!queued && !active) {
    setStatus(p, "failed", "数字人口播和角色图已准备，但没有成功派发视频任务");
    return false;
  }
  setStatus(p, "running");
  return true;
}

/* ---------- 起草 ---------- */
async function draftOne(p, batch) {
  const acc = accountById(p.accountId);
  if (!acc) { setStatus(p, "failed", "账号不存在"); return; }
  const isImg = p.mode === "图文";
  if (!isImg) enforceSupportedVideoMode(p);
  const material = isMaterial(p);
  try {
    setStatus(p, "running");
    // 主题 / 创作内容只来自用户填写；账号资料仅提供风格，不再代替用户选题。
    const rawProductId = (batch.accountProductIds && batch.accountProductIds[acc.id]) || batch.productId || p.artifacts.script.productId || "dumate";
    const productId = primaryProductById(rawProductId)?.id || "dumate";
    p.artifacts.script.productId = productId;
    const contentOverride = ((batch.accountContents && batch.accountContents[acc.id]) || batch.content || "").trim();
    let topic = contentOverride || batch.topic || p.topic || "";
    const product = productById(productId);
    const style = acc.styleProfile || acc.lockedStyle || batch.style || "";
    const useOnlineTrends = false;
    const batchVariant = p.batchCreativeVariant || p.artifacts.script.batchCreativeVariant || batchVariantFor({
      acc,
      batch,
      globalIndex: Math.max(0, (batch.productionIds || []).indexOf(p.id)),
      itemIndex: p.batchItemIndex || 1,
      itemTotal: p.batchItemTotal || 1
    });
    p.batchCreativeVariant = batchVariant;
    p.artifacts.script.batchCreativeVariant = batchVariant;
    let trendPrep = null;
    let trendGuide = "";
    p.topic = topic;
    p.artifacts.script.trendPrep = trendPrep;
    p.artifacts.script.trendGuide = trendGuide;
    p.artifacts.script.useOnlineTrends = useOnlineTrends;
    const draftRw = referenceRewriteForCopy(trendPrep, p.artifacts.copy);
    if (draftRw) p.artifacts.copy.referenceRewrite = draftRw;

    const customCopyMode = batch.accountCustomCopyModes?.[acc.id] === true;
    const singleImageMode = isImg && batch.accountImageCreationModes?.[acc.id] === "single";
    const singleImagePrompt = String(batch.accountImagePrompts?.[acc.id] || "").trim();
    const singleImageTitle = String(batch.accountSingleImageTitles?.[acc.id] || "").trim();
    const customCopyTitle = ((batch.accountCopyTitles || {})[acc.id] || "").trim();
    const customCopyBody = ((batch.accountCopyBodies || {})[acc.id] || "").trim();
    if (singleImageMode) {
      if (!singleImageTitle || !singleImagePrompt) {
        setStatus(p, "failed", "单图创作请先填写标题和图片提示词");
        return;
      }
      p.topic = singleImageTitle;
      p.title = singleImageTitle;
      p.artifacts.copy = { title: "", body: "" };
      p.artifacts.script.imageCount = 1;
      p.artifacts.script.source = "single-image-prompt";
      p.artifacts.script.style = style;
      p.artifacts.images.creationMode = "single";
      p.artifacts.images.singlePrompt = singleImagePrompt;
      p.artifacts.images.items = [{
        title: singleImageTitle,
        visual: singleImagePrompt,
        prompt: singleImageGenerationPrompt(singleImagePrompt, style || acc.imagePromptTemplate || ""),
        assetId: null,
        status: "idle"
      }];
      const copyPromise = AI.generateImageCopyFromTitle({ title: singleImageTitle, account: acc });
      const generated = await generateBatchImagesInHouse(p, batch, acc);
      const item = p.artifacts.images.items[0];
      if (!generated || !item?.assetId) {
        await copyPromise.catch(() => null);
        setStatus(p, "failed", item?.error || "单图生成失败");
        return;
      }
      try {
        const generatedCopy = await copyPromise;
        p.title = singleImageTitle;
        p.artifacts.copy = {
          title: p.title,
          body: generatedCopy.copy || "",
          source: generatedCopy.source || AI.lastSource || "llm-title-copy"
        };
        p.artifacts.script.title = p.title;
        p.artifacts.script.source = "single-image-title-copy";
        setStage(p, "review", "pending");
        setStatus(p, "pending");
      } catch (error) {
        setStatus(p, "failed", error?.message || "图片已生成，但看图生成文案失败");
      }
      return;
    }
    if (customCopyMode && !customCopyTitle) {
      setStatus(p, "failed", isImg ? "图文组图请先填写标题" : "视频生产请先填写标题");
      return;
    }
    if (customCopyMode && (customCopyTitle || customCopyBody)) {
      const customTopic = (customCopyTitle || topic).slice(0, 80);
      p.topic = customTopic;
      p.title = customCopyTitle || customTopic;
      p.artifacts.copy = { title: p.title, body: customCopyBody, source: customCopyBody ? "manual" : "" };
      let customVideoDraft = null;
      if (!isImg) {
        try {
          customVideoDraft = await AI.generateCustomVideoDraft({
            title: customCopyTitle || customTopic,
            body: customCopyBody,
            account: acc,
            product,
            mode: material && p.artifacts.boards?.materialMode === "infoFlow" ? "infoFlow" : "digital"
          });
          p.title = customCopyTitle || p.title || customVideoDraft.title;
          p.artifacts.copy = {
            title: p.title,
            body: customCopyBody || customVideoDraft.copy || ""
          };
          p.artifacts.script.generatedNarration = customVideoDraft.narration || "";
          p.artifacts.script.generatedVisualPrompt = customVideoDraft.visualPrompt || "";
          p.artifacts.script.source = "llm-custom-video";
        } catch (err) {
          setStatus(p, "failed", err?.message || "自定义视频内容需要语言模型生成，请稍后重试");
          return;
        }
      }
      if (material && p.artifacts.boards?.materialMode === "infoFlow") {
        let creativePlan;
        try {
          creativePlan = await AI.generateInfoFlowCreativePlan({
            title: p.artifacts.copy.title || customTopic,
            copy: p.artifacts.copy.body || customVideoDraft?.copy || "",
            narration: customVideoDraft?.narration || p.artifacts.copy.body || "",
            account: acc,
            product,
            previousPrompts: (p.artifacts.boards?.infoFlow?.segments || []).map(segment => segment?.videoPrompt || "").filter(Boolean)
          });
        } catch (err) {
          setStatus(p, "failed", err?.message || "信息流创意提示词生成失败，请稍后重试");
          return;
        }
        const planInfo = buildBatchInfoFlowPlan({
          topic: customTopic,
          title: p.artifacts.copy.title,
          copyText: customVideoDraft?.narration || p.artifacts.copy.body,
          publishCopy: customCopyBody || p.artifacts.copy.body || customVideoDraft?.copy,
          product,
          acc,
          seed: `${batch.id}:${p.id}:${acc.id}:${p.batchItemIndex || 1}`,
          creativePlan
        });
        applyBatchInfoFlowPlan(p, planInfo, { preserveCopy: true });
        p.artifacts.copy.title = customCopyTitle || p.artifacts.copy.title || customVideoDraft?.title || planInfo.title || p.title;
        p.artifacts.copy.body = stripLeadingCopyTitle(customCopyBody || p.artifacts.copy.body || customVideoDraft?.copy || planInfo.copy || "", p.artifacts.copy.title);
        p.artifacts.script.source = "llm-custom-infoflow";
        p.artifacts.script.style = style;
        if (acc.voiceId && !p.artifacts.audio.voiceId) p.artifacts.audio.voiceId = acc.voiceId;
        const explicitVideoRefs = batchSceneRefIds(batch, acc.id);
        p.artifacts.boards.omniRefAssetIds = [...explicitVideoRefs];
        p.artifacts.boards.sceneRefAssetIds = [...explicitVideoRefs];
        applyBatchCoverRefs(p, batch);
        ensureVideoCoverPrompt(p, product);
        await generateVideoCoverInHouse(p);
        setStage(p, "workshop", "running");
        createUnitVideoJobs(p);
        return;
      }
      if (!isImg) {
        const narrationCopy = {
          title: p.artifacts.copy.title || p.title,
          body: customVideoDraft?.narration || p.artifacts.copy.body || ""
        };
        const shots = buildVideoCustomCopyShots(narrationCopy, product, p.subType === "数字人");
        p.artifacts.script.shots = shots;
        p.artifacts.script.title = p.title;
        p.artifacts.script.source = "llm-custom-video";
        p.artifacts.script.style = style;
        Object.assign(p.artifacts.audio, estimateAudio(shots), { assetId: null, source: "estimate", lastError: "" });
        if (acc.voiceId && !p.artifacts.audio.voiceId) p.artifacts.audio.voiceId = acc.voiceId;
        const explicitVideoRefs = batchSceneRefIds(batch, acc.id);
        p.artifacts.boards.omniRefAssetIds = [...explicitVideoRefs];
        p.artifacts.boards.sceneRefAssetIds = [...explicitVideoRefs];
        if (p.subType === "数字人") {
          await queueBatchDigitalHuman(p, batch, acc, product);
          return;
        }
        const units = buildMaterialUnits(p);
        const ures = await AI.generateUnitPrompts({
          units, shots, account: acc, style, product,
          hasNarrationAudio: false,
          hasVoiceRef: false,
          hasCharacterRef: false,
          hasSceneRef: explicitVideoRefs.length > 0
        });
        units.forEach((u, i) => { u.imagePrompt = (ures.units[i] || {}).imagePrompt || ""; u.videoPrompt = (ures.units[i] || {}).videoPrompt || ""; });
        applyBatchCoverRefs(p, batch);
        ensureVideoCoverPrompt(p, product);
        await generateVideoCoverInHouse(p);
        setStage(p, "workshop", "running");
        createUnitVideoJobs(p);
        return;
      }
      if (!p.artifacts.copy.body.trim()) {
        try {
          const generatedCopy = await AI.generateImageCopyFromTitle({
            title: p.artifacts.copy.title || customTopic,
            account: acc
          });
          p.artifacts.copy.title = customCopyTitle || p.artifacts.copy.title;
          p.title = p.artifacts.copy.title;
          p.artifacts.copy.body = generatedCopy.copy || generatedCopy.body || "";
          p.artifacts.copy.source = generatedCopy.source || AI.lastSource || "llm-title-copy";
        } catch (error) {
          setStatus(p, "failed", error?.message || "只填写标题时自动生成正文失败");
          return;
        }
      }
      const count = Math.max(1, Math.min(12, Number(
        p.artifacts.script.imageCount || batch.accountImageCounts?.[acc.id] || batch.imageCount || DEFAULT_XHS_IMAGE_COUNT
      ) || DEFAULT_XHS_IMAGE_COUNT));
      const shots = buildBatchCustomCopyShots(p.artifacts.copy, count, null);
      p.artifacts.script.imageCount = count;
      p.artifacts.script.shots = shots;
      p.artifacts.script.title = p.title;
      p.artifacts.script.source = "custom-copy";
      p.artifacts.script.style = style;
      p.artifacts.script.useOnlineTrends = false;
      p.artifacts.script.trendPrep = null;
      p.artifacts.script.trendGuide = "";
      const imgPromptRes = await AI.generateImagePrompts({
        script: shotsToText(shots, true),
        account: acc,
        style,
        imageTemplate: acc.imagePromptTemplate || "",
        imageCount: count,
        product: null,
        topic: customTopic,
        styleRefName: "",
        batchVariant,
        useOnlineTrends: false,
        trendGuide: "",
        trendPrep: null,
        copy: p.artifacts.copy,
        requireLlm: true
      });
      p.artifacts.images.promptSource = AI.lastSource;
      const promptRows = imgPromptRes.shots || [];
      p.artifacts.images.items = shots.map((s, i) => ({
        title: promptRows[i]?.title || s.idea || `图片${i + 1}`,
        visual: s.visual || "",
        prompt: promptRows[i]?.prompt || `生成小红书图文3:4图片。图片内容必须围绕标题「${p.artifacts.copy.title}」和正文信息「${(p.artifacts.copy.body || s.line || "").slice(0, 360)}」。${s.visual || ""}\n${IMAGE_NEGATIVE_PROMPT}`,
        assetId: null,
        status: "idle"
      }));
      await runBatchImagesToReview(p, batch);
      return;
    }

    if (!topic) {
      setStatus(p, "failed", "请先填写标题");
      return;
    }

    if (material && p.artifacts.boards?.materialMode === "infoFlow") {
      let infoDraft;
      let creativePlan;
      try {
        infoDraft = await AI.generateCustomVideoDraft({
          title: topic,
          body: "",
          account: acc,
          product,
          mode: "infoFlow"
        });
        p.title = infoDraft.title || p.title || topic;
        p.artifacts.copy = { title: p.title, body: infoDraft.copy || "" };
        p.artifacts.script.generatedNarration = infoDraft.narration || "";
        creativePlan = await AI.generateInfoFlowCreativePlan({
          title: p.title,
          copy: p.artifacts.copy.body,
          narration: infoDraft.narration || "",
          account: acc,
          product,
          previousPrompts: (p.artifacts.boards?.infoFlow?.segments || []).map(segment => segment?.videoPrompt || "").filter(Boolean)
        });
      } catch (err) {
        setStatus(p, "failed", err?.message || "信息流文案或创意提示词生成失败，请稍后重试");
        return;
      }
      const planInfo = buildBatchInfoFlowPlan({
        topic,
        title: p.artifacts.copy.title,
        publishCopy: p.artifacts.copy.body,
        copyText: infoDraft.narration,
        product,
        acc,
        seed: `${batch.id}:${p.id}:${acc.id}:${p.batchItemIndex || 1}`,
        creativePlan
      });
      applyBatchInfoFlowPlan(p, planInfo, { preserveCopy: true });
      p.artifacts.script.source = "llm-infoflow";
      p.artifacts.script.style = style;
      if (acc.voiceId && !p.artifacts.audio.voiceId) p.artifacts.audio.voiceId = acc.voiceId;
      const explicitVideoRefs = batchSceneRefIds(batch, acc.id);
      p.artifacts.boards.omniRefAssetIds = [...explicitVideoRefs];
      p.artifacts.boards.sceneRefAssetIds = [...explicitVideoRefs];
      applyBatchCoverRefs(p, batch);
      ensureVideoCoverPrompt(p, product);
      await generateVideoCoverInHouse(p);
      setStage(p, "workshop", "running");
      createUnitVideoJobs(p);
      return;
    }

    const sres = material
      ? await AI.generateMaterialScript({ topic, account: acc, style, product })
      : await AI.generateScript({
        topic,
        duration: isImg ? 0 : 55, account: acc, image: isImg, style: isImg ? style : "",
        imageCount: p.artifacts.script.imageCount || DEFAULT_XHS_IMAGE_COUNT, product,
        direction: isImg ? topic : "",
        imageTemplate: acc.imagePromptTemplate || "",
        styleRefName: "",
        batchVariant: isImg ? batchVariant : null,
        useOnlineTrends,
        trendGuide,
        trendPrep
      });
    p.artifacts.script.shots = sres.shots || [];
    p.artifacts.script.title = sres.title || topic;
    p.artifacts.script.source = AI.lastSource;
    p.artifacts.script.style = style;
    p.title = sres.title || topic;

    if (isImg) {
      const cp = await AI.generateCopy({
        topic,
        shots: p.artifacts.script.shots,
        account: acc,
        style,
        kind: "image",
        product,
        batchVariant,
        avoidCopies: existingBatchCopies(batch, p.id),
        useOnlineTrends,
        trendGuide,
        trendPrep
      });
      p.artifacts.copy = { title: cp.title || p.title, body: cp.copy || "", source: AI.lastSource || "" };
      const rw = referenceRewriteForCopy(trendPrep, p.artifacts.copy);
      if (rw) p.artifacts.copy.referenceRewrite = rw;
      const imgPromptRes = await AI.generateImagePrompts({
        script: shotsToText(p.artifacts.script.shots, true),
        account: acc,
        style,
        imageTemplate: acc.imagePromptTemplate || "",
        imageCount: p.artifacts.script.imageCount || DEFAULT_XHS_IMAGE_COUNT,
        product,
        topic,
        styleRefName: "",
        batchVariant,
        useOnlineTrends,
        trendGuide,
        trendPrep,
        copy: p.artifacts.copy
      });
      p.artifacts.images.promptSource = AI.lastSource;
      const promptRows = imgPromptRes.shots || [];
      p.artifacts.images.items = p.artifacts.script.shots.map((s, i) => ({
        title: promptRows[i]?.title || `图片${i + 1}`,
        visual: s.visual || "",
        prompt: promptRows[i]?.prompt || "",
        assetId: null,
        status: "idle"
      }));
    } else {
      // 视频号全自动：口播估时 → 按场景合并分镜单元 → 分段提示词 → 派发视频任务
      Object.assign(p.artifacts.audio, estimateAudio(p.artifacts.script.shots), { source: "estimate" });
      if (acc.voiceId && !p.artifacts.audio.voiceId) p.artifacts.audio.voiceId = acc.voiceId;
      const explicitVideoRefs = batchSceneRefIds(batch, acc.id);
      p.artifacts.boards.omniRefAssetIds = [...explicitVideoRefs];
      p.artifacts.boards.sceneRefAssetIds = [...explicitVideoRefs];
      if (p.subType === "数字人") {
        const cp0 = await AI.generateCopy({
          topic,
          shots: p.artifacts.script.shots,
          account: acc,
          style,
          kind: "video",
          product,
          batchVariant,
          avoidCopies: existingBatchCopies(batch, p.id),
          useOnlineTrends,
          trendGuide,
          trendPrep
        });
        p.artifacts.copy = { title: cp0.title || p.title, body: cp0.copy || "" };
        await queueBatchDigitalHuman(p, batch, acc, product);
        return;
      }
      const units = buildMaterialUnits(p);
      const ures = await AI.generateUnitPrompts({
        units, shots: p.artifacts.script.shots, account: acc, style, product,
        hasNarrationAudio: false,
        hasVoiceRef: false,
        hasCharacterRef: false,
        hasSceneRef: explicitVideoRefs.length > 0
      });
      units.forEach((u, i) => { u.imagePrompt = (ures.units[i] || {}).imagePrompt || ""; u.videoPrompt = (ures.units[i] || {}).videoPrompt || ""; });
      const cp0 = await AI.generateCopy({ topic, shots: p.artifacts.script.shots, account: acc, style, kind: "video", product, batchVariant, avoidCopies: existingBatchCopies(batch, p.id), useOnlineTrends, trendGuide, trendPrep });
      p.artifacts.copy = { title: cp0.title || p.title, body: cp0.copy || "" };
      applyBatchCoverRefs(p, batch);
      ensureVideoCoverPrompt(p, product);
      await generateVideoCoverInHouse(p);
      setStage(p, "workshop", "running");
      createUnitVideoJobs(p);   // t2v 单元直接生成；i2v 单元无图时也先出片占位，回工坊可补图重生成
      return;
    }
    if (!isImg) {
      const cp = await AI.generateCopy({ topic, shots: p.artifacts.script.shots, account: acc, style, kind: "video", product, batchVariant: null, avoidCopies: existingBatchCopies(batch, p.id), useOnlineTrends, trendGuide, trendPrep });
      p.artifacts.copy = { title: cp.title || p.title, body: cp.copy || "" };
      applyBatchCoverRefs(p, batch);
      ensureVideoCoverPrompt(p, product);
      await generateVideoCoverInHouse(p);
    }
    if (isImg) {
      await runBatchImagesToReview(p, batch);
    } else {
      setStage(p, "boards", "needs_input");
    }
  } catch (e) {
    setStatus(p, "failed", "起草失败：" + (e.message || e));
  }
}

function digitalJobMatches(j, p, segIndex, segmentId = "") {
  if (!(j.productionId === p.id && j.kind === "video" && j.model === "__digital_human__")) return false;
  if (segmentId && j.segmentId) return j.segmentId === segmentId;
  return j.segIndex === segIndex;
}

function outputUrl(output) {
  if (!output) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = outputUrl(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof output === "object") {
    for (const key of ["url", "videoUrl", "video_url", "result_url"]) {
      const value = output[key];
      if (typeof value === "string" && value) return value;
    }
    for (const value of Object.values(output)) {
      const found = outputUrl(value);
      if (found) return found;
    }
  }
  return "";
}

export async function composeBatchFinalVideo(p) {
  if (!p?.artifacts || p.mode !== "视频") return false;
  if (p.artifacts.finalVideoUrl) return true;
  if (p.artifacts.composing) return false;
  const clips = (p.artifacts.timeline || []).map(clip => {
    const job = state.jobs.find(item => item.id === clip.jobId);
    return {
      url: clip.videoUrl || outputUrl(job?.output),
      name: clip.name || job?.segName || "",
      dur: Math.max(.5, Number(clip.dur || job?.duration || 15)),
      trimIn: Math.max(0, Number(clip.trimIn || 0))
    };
  }).filter(clip => clip.url);
  if (!clips.length || clips.length !== (p.artifacts.timeline || []).length) {
    p.artifacts.composeError = "片段已生成，但有视频地址尚未就绪，无法合成完整成片";
    save("productions");
    return false;
  }
  p.artifacts.composing = true;
  p.artifacts.composingStartedAt = Date.now();
  p.artifacts.composeError = "";
  save("productions");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3 * 60 * 1000);
  try {
    const response = await fetch("/api/video/compose", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(remote.getToken() ? { Authorization: `Bearer ${remote.getToken()}` } : {})
      },
      body: JSON.stringify({
        title: p.artifacts.copy?.title || p.title || p.topic || "batch-final",
        clips,
        preserveClipAudio: true,
        transitionDuration: 0,
        subtitleStyle: p.artifacts.subStyle || { size: 15, stroke: 1, bottom: 22 },
        subtitles: (p.artifacts.subs || []).filter(item => String(item.text || "").trim()).map(item => ({
          start: Number(item.start || 0),
          end: Number(item.end || 0),
          text: String(item.text || "").trim()
        }))
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.url) throw new Error(data.detail || data.error || `合成失败 (${response.status})`);
    p.artifacts.finalVideoUrl = data.url;
    p.artifacts.finalVideoName = data.name || "";
    p.artifacts.finalVideoTimelineSig = JSON.stringify(clips.map(clip => [clip.url, clip.dur, clip.trimIn]));
    p.artifacts.finalVideoCaptionSig = JSON.stringify((p.artifacts.subs || []).map(item => [item.start, item.end, item.text]));
    p.artifacts.composeError = "";
    return true;
  } catch (error) {
    p.artifacts.composeError = error?.name === "AbortError"
      ? "批量成片合成超过 3 分钟，请重试"
      : (error?.message || "批量成片合成失败");
    return false;
  } finally {
    clearTimeout(timer);
    p.artifacts.composing = false;
    p.artifacts.composingStartedAt = 0;
    save("productions");
  }
}

function latestDigitalJob(p, segIndex, segmentId = "") {
  return [...(state.jobs || [])].reverse().find(j =>
    digitalJobMatches(j, p, segIndex, segmentId) && !j.superseded
  );
}

function activeDigitalJobCount(p) {
  return (state.jobs || []).filter(j =>
    !j.superseded
    && j.productionId === p.id
    && j.kind === "video"
    && j.model === "__digital_human__"
    && ["queued", "submitted", "running"].includes(j.status)
  ).length;
}

function supersedeSegmentJobs(p, segIndex, segmentId = "") {
  let changed = false;
  (state.jobs || []).forEach(j => {
    if (digitalJobMatches(j, p, segIndex, segmentId) && !["queued", "submitted", "running"].includes(j.status)) {
      j.superseded = true;
      changed = true;
    }
  });
  if (changed) save("jobs");
}

function latestUnitJob(p, segIndex, prompt) {
  return [...(state.jobs || [])].reverse().find(j =>
    !j.superseded && j.productionId === p.id && j.segIndex === segIndex && j.kind === "video" && (!prompt || j.prompt === prompt)
  );
}

function supersedeUnitJobs(p, segIndex, prompt) {
  let changed = false;
  (state.jobs || []).forEach(j => {
    if (j.productionId === p.id && j.segIndex === segIndex && j.kind === "video" && (!prompt || j.prompt === prompt) && !["queued", "submitted", "running"].includes(j.status)) {
      j.superseded = true;
      changed = true;
    }
  });
  if (changed) save("jobs");
}

/* 素材号：按「分镜单元」派发视频任务（全能参考单元带固定 logo+界面图、文生视频单元纯文生；已成功的跳过） */
export function createUnitVideoJobs(p, onlyUnitIndex = null) {
  enforceSupportedVideoMode(p);
  const units = buildMaterialUnits(p); // 重算确保与脚本同步
  const A = p.artifacts.boards;
  // 单号和批量都只使用当前任务明确选择的场景参考；数字人角色板仍按账号身份配置单独处理。
  const acc = accountById(p.accountId);
  A.omniRefAssetIds = A.omniRefAssetIds || [];
  A.sceneRefAssetIds = A.sceneRefAssetIds || [];
  if (p.subType === "数字人" && !A.characterRefAssetId && acc?.charBoardAssetId) A.characterRefAssetId = acc.charBoardAssetId;
  const characterRefId = p.subType === "数字人" ? (A.characterRefAssetId || acc?.charBoardAssetId || null) : null;
  const sceneRefs = [...new Set([
    ...(A.sceneRefAssetIds || []),
    ...(A.omniRefAssetIds || []).filter(id => id !== characterRefId),
    !p.batchId ? A.sharedRefAssetId : null
  ].filter(Boolean))];
  const hasExternalVoice = !!p.artifacts.audio.assetId && ["tts", "upload"].includes(p.artifacts.audio.source);
  const productionReferenceAudioId = A.referenceAudioAssetId || null;
  const wantsSeedanceVoice = p.subType === "无数字人" && !!(productionReferenceAudioId || acc?.voiceRefAssetId);
  const useDigitalHumanModel = p.subType === "数字人" && A.generationMode === "digitalHuman";
  const voiceRefs = wantsSeedanceVoice ? [productionReferenceAudioId || acc.voiceRefAssetId] : [];
  const audioRefs = [...voiceRefs].filter(Boolean);
  let n = 0;
  if (useDigitalHumanModel) {
    const availableSlots = Math.max(0, 10 - activeDigitalJobCount(p));
    if (!availableSlots) return 0;
    const segs = Array.isArray(A.digitalHuman?.segments) ? A.digitalHuman.segments : [];
    segs.forEach((seg, i) => {
      if (n >= availableSlots) return;
      if (onlyUnitIndex != null && i !== onlyUnitIndex) return;
      const existing = latestDigitalJob(p, i, seg.id || "");
      if (existing && ["queued", "submitted", "running"].includes(existing.status)) return;
      if (onlyUnitIndex == null && (outputUrl(existing?.output) || outputUrl(seg.videoOutput))) return;
      const characterAssetId = seg.characterRefAssetId || characterRefId;
      const audioAssetId = seg.audioAssetId;
      const prompt = (seg.videoPrompt || A.digitalHuman?.fixedPrompt || "角色动作自然，表情自然生动，语言表达流畅，视线自然看镜头，自然地讲述内容。").trim();
      if (!characterAssetId || !audioAssetId || !prompt) return;
      supersedeSegmentJobs(p, i, seg.id || "");
      const job = createJob({
        kind: "video",
        productionId: p.id,
        segmentId: seg.id || "",
        segIndex: i,
        segName: `数字人${String(i + 1).padStart(2, "0")}`,
        prompt,
        refAssetIds: [...new Set([characterAssetId, audioAssetId].filter(Boolean))].slice(0, 9),
        ratio: A.ratio || "9:16",
        duration: Math.min(59, Math.max(2, Math.ceil(seg.audioDuration || seg.dur || 15))),
        generateAudio: false,
        model: "__digital_human__"
      });
      seg.videoStatus = "queued";
      seg.videoJobId = job.id;
      seg.videoQueuedAt = Date.now();
      seg.videoError = "";
      n++;
    });
    return n;
  }
  units.forEach((u, i) => {
    if (onlyUnitIndex != null && i !== onlyUnitIndex) return;
    const prompt = u.infoFlow ? stripInfoFlowDirectorNotes(u.videoPrompt || "") : (u.videoPrompt || "");
    if (!prompt) return;
    if (u.infoFlow && u.videoPrompt !== prompt) u.videoPrompt = prompt;
    const existing = latestUnitJob(p, i, prompt);
    if (existing && ["queued", "submitted", "running"].includes(existing.status)) return;
    if (onlyUnitIndex == null && existing?.status === "succeeded") return;
    supersedeUnitJobs(p, i, prompt);
    // 真人只在第一段带角色参考；场景/产品参考按需要挂载，避免角色图污染纯场景片段。
    const needsCharacter = p.subType === "数字人" && i === 0;
    // Seedance 2.0 上游不接受“音频是唯一参考模态”；固定声线时为每段同时挂一张已有视觉参考。
    const audioCompanionVisual = wantsSeedanceVoice
      ? ((u.refAssetIds || [])[0] || sceneRefs[0] || characterRefId || A.cover?.assetId || acc?.avatarAssetId || null)
      : null;
    if (wantsSeedanceVoice && !audioCompanionVisual) {
      window.__toast?.("已选择参考音频：还需要一张产品图、封面或账号头像作为 Seedance 视觉参考", "error");
      return;
    }
    const refs = [...new Set([
      needsCharacter ? characterRefId : null,
      audioCompanionVisual,
      ...(u.refAssetIds || []),
      ...(u.needsImage || needsCharacter ? sceneRefs : []),
      ...audioRefs
    ].filter(Boolean))].slice(0, 9);
    createJob({
      kind: "video", productionId: p.id, segIndex: i,
      segName: u.infoFlow ? (u.label || `信息流${String(i + 1).padStart(2, "0")}`) : `场景${String(u.scene).padStart(2, "0")}${u.shotIndexes.length > 1 ? `·${u.shotIndexes.length}镜` : ""}`,
      prompt, refAssetIds: refs,
      ratio: A.ratio || "9:16",
      duration: Math.min(15, Math.max(2, Math.ceil(u.dur || 4))),
      generateAudio: wantsSeedanceVoice || !hasExternalVoice,
      model: useDigitalHumanModel ? "__digital_human__" : ""
    });
    n++;
  });
  return n;
}
/* 兼容旧调用名 */
export const createShotVideoJobs = createUnitVideoJobs;

export async function regenerateBatchVideo(p) {
  if (!p || p.mode === "图文" || !p.batchId) throw new Error("当前任务不是批量视频任务");
  const currentJobs = jobsOf(p).filter(job => job.kind === "video" && !job.superseded);
  if (currentJobs.some(job => ["queued", "submitted", "running"].includes(job.status))) {
    throw new Error("当前视频仍在生成，请完成后再重新生成");
  }
  const batch = batchById(p.batchId);
  if (!batch) throw new Error("原批次不存在，无法恢复视频任务");
  const hasPreparedUnits = Boolean(
    (p.artifacts?.boards?.units || []).some(unit => String(unit?.videoPrompt || "").trim())
    || (p.artifacts?.boards?.infoFlow?.segments || []).some(segment => String(segment?.videoPrompt || "").trim())
    || (p.artifacts?.boards?.digitalHuman?.segments || []).some(segment => String(segment?.videoPrompt || segment?.narration || "").trim())
  );
  if (!hasPreparedUnits) {
    // The original failure happened before Seedance and left no executable
    // units. Re-run the preserved title/copy plan instead of replacing the
    // useful drafting error with a misleading "no video unit" message.
    const previousError = String(p.error || "");
    setStage(p, "script", "running");
    setStatus(p, "running");
    await draftOne(p, batch);
    const recoveredJobs = jobsOf(p).filter(job =>
      job.kind === "video" && !job.superseded
      && ["queued", "submitted", "running", "succeeded"].includes(job.status)
    );
    if (!recoveredJobs.length) {
      const detail = String(p.error || previousError || "视频计划重新起草后仍未形成可执行单元");
      if (!p.error) setStatus(p, "failed", detail);
      throw new Error(detail);
    }
    evaluate(p.batchId);
    return recoveredJobs.length;
  }
  currentJobs.forEach(job => { job.superseded = true; });
  const segments = p.artifacts?.boards?.digitalHuman?.segments || [];
  segments.forEach(segment => {
    segment.videoJobId = null;
    segment.videoStatus = "pending";
    segment.videoOutput = null;
    segment.videoError = "";
  });
  p.artifacts.finalVideoUrl = "";
  p.artifacts.finalVideoName = "";
  p.artifacts.finalVideoCaptionSig = "";
  p.artifacts.finalVideoTimelineSig = "";
  p.artifacts.finalVideoMixSig = "";
  setStage(p, "workshop", "running");
  setStatus(p, "running");
  save("jobs", "productions");
  const queued = createUnitVideoJobs(p);
  if (!queued) {
    const detail = String(p.error || "视频单元已经保留，但本次没有成功派发生成任务");
    setStatus(p, "failed", detail);
    throw new Error(detail);
  }
  return queued;
}

function setBatchPhase(batch, phase) {
  if (!batch || batch.phase === phase) return;
  batch.phase = phase;
  batch.updatedAt = Date.now();
  save("batches");
  emit("batch:update", batch);
}

export async function startBatch(plan, session) {
  enforcePlanKind(plan);
  const accounts = plan.accountIds.map(accountById).filter(Boolean);
  if (!accounts.length) { agentSay("⚠ 没有可用账号，先调整筛选条件。"); return null; }
  const batch = createBatch(plan, session.id);
  const defaultPerAccountCount = Math.max(1, Math.min(12, Number(plan.perAccountCount || 1) || 1));
  const defaultImageCount = Math.max(1, Math.min(12, Number(plan.imageCount || DEFAULT_XHS_IMAGE_COUNT) || DEFAULT_XHS_IMAGE_COUNT));
  batch.plannedTotal = accounts.reduce((sum, acc) => {
    const n = Math.max(1, Math.min(12, Number((plan.accountCounts || {})[acc.id] || defaultPerAccountCount) || defaultPerAccountCount));
    return sum + n;
  }, 0);
  accounts.forEach(acc => {
    const rawProductId = (plan.accountProductIds || {})[acc.id] || plan.productId || "dumate";
    const productId = primaryProductById(rawProductId)?.id || "dumate";
    const perAccountCount = Math.max(1, Math.min(12, Number((plan.accountCounts || {})[acc.id] || defaultPerAccountCount) || defaultPerAccountCount));
    const imageCount = Math.max(1, Math.min(12, Number((plan.accountImageCounts || {})[acc.id] || defaultImageCount) || defaultImageCount));
    for (let i = 0; i < perAccountCount; i++) {
      const globalIndex = batch.productionIds.length;
      const topic = String(
        (plan.accountCopyTitles || {})[acc.id]
        || (plan.accountContents || {})[acc.id]
        || plan.content
        || plan.topic
        || ""
      ).trim();
      const p = createProduction({ accountId: acc.id, topic, origin: "agent", batchId: batch.id, style: plan.style, productId });
      if (p) {
        p.referenceSelectionId = batch.referenceSelectionId || "";
        p.artifacts.script.imageCount = imageCount;
        p.batchItemIndex = i + 1;
        p.batchItemTotal = perAccountCount;
        p.batchCreativeVariant = batchVariantFor({ acc, batch, globalIndex, itemIndex: i + 1, itemTotal: perAccountCount });
        p.artifacts.script.batchCreativeVariant = p.batchCreativeVariant;
        if (!(acc.mode === "图文" || groupOf(acc) === "图文组")) applyBatchCoverRefs(p, batch);
        batch.productionIds.push(p.id);
      }
    }
  });
  save("batches", "productions");
  emit("batch:update", batch);
  addMsg(session, { role: "agent", type: "progress", payload: { batchId: batch.id } });
  notify("agent", `批次启动：「${batch.topic}」`, `${accounts.length} 个账号 · 共 ${batch.productionIds.length} 条内容`);
  // 起草过程播报到思考面板
  emit("agent:thinking", { sessionId: session.id, value: true });
  think(`并发起草 ${accounts.length} 个账号 · ${batch.productionIds.length} 条内容…`, session.id);
  let drafted = 0;
  const total = batch.productionIds.length;
  runPool(batchProds(batch), async p => {
    await draftOne(p, batch);
    drafted++;
    think(`起草完成 ${drafted}/${total} · ${accountById(p.accountId)?.name || ""}`, session.id);
  }, 2).then(() => {
    emit("agent:thinking", { sessionId: session.id, value: false });
    evaluate(batch.id);
  }).catch(err => {
    console.error(err);
    batch.phase = "review";
    batch.error = String(err?.message || err || "批量任务启动失败");
    batch.updatedAt = Date.now();
    save("batches");
    think("批量任务启动失败，请检查本地 API 或稍后重试", session.id);
    emit("agent:thinking", { sessionId: session.id, value: false });
    emit("batch:update", batch);
  });
  return batch;
}

/* ---------- 上传完成后的推进 ---------- */
export function maybeAdvanceAfterInput(p) {
  const isImg = p.mode === "图文";
  const items = isImg ? p.artifacts.images.items : p.artifacts.boards.items;
  if (!items.length || !items.every(x => x.assetId)) return false;
  if (isImg) {
    // 图文：文案已合并到图文创作台；文案缺失时留在本页补齐。
    setStage(p, (p.artifacts.copy.body || "").trim() ? "review" : "images", "pending");
  } else {
    // 视频：分镜齐 → 渲染就绪
    setStage(p, "render", "pending");
  }
  return true;
}

/* ---------- 渲染 ---------- */
export function startGeneration(batch) {
  let jobs = 0;
  batchProds(batch).forEach(p => {
    if (isVideoWorkshop(p) && p.stage === "workshop") {
      if (p.stage === "workshop" && p.stageStatus !== "running") {
        const n = createUnitVideoJobs(p);
        if (n) { setStatus(p, "running"); jobs += n; }
      }
      return;
    }
  });
  if (jobs) {
    batch.phase = "generating"; batch.updatedAt = Date.now();
    save("batches");
    emit("batch:update", batch);
  }
  return jobs;
}

/* ---------- 审核 / 交付 ---------- */
export function approveAll(batch) {
  let n = 0;
  batchProds(batch).forEach(p => {
    if (p.stage === "review" && p.review.state !== "approved") { p.review.state = "approved"; p.review.at = Date.now(); n++; }
  });
  save("productions");
  emit("batch:update", batch);
  return n;
}
export function deliverAll(batch, opts = {}) {
  let n = 0;
  batchProds(batch).forEach(p => {
    if (p.stage === "review") { if (deliver(p, opts)) n++; }   // deliver 自带定稿，无需先 approve
  });
  evaluate(batch.id);
  return n;
}
export function retryFailedIn(batch) {
  let n = 0;
  batchProds(batch).forEach(p => {
    const jobStage = p.stage === "render" || p.stage === "workshop";
    if (p.stageStatus !== "failed") {
      // 渲染/工坊中的失败 job 也重试
      if (jobStage) jobsOf(p).filter(j => j.status === "failed").forEach(j => { retryJob(j.id); setStatus(p, "running"); n++; });
      return;
    }
    if (p.stage === "script") { setStatus(p, "pending"); draftOne(p, batch).then(() => evaluate(batch.id)); n++; }
    else if (p.mode === "图文" && (p.stage === "images" || p.artifacts?.images?.items?.length)) {
      runBatchImagesToReview(p, batch);
      n++;
    }
    else if (jobStage) {
      const failed = jobsOf(p).filter(j => j.status === "failed");
      if (failed.length) failed.forEach(j => retryJob(j.id));
      else if (p.stage === "workshop") {
        const prepared = (p.artifacts?.boards?.units || []).some(unit => String(unit?.videoPrompt || "").trim())
          || (p.artifacts?.boards?.infoFlow?.segments || []).some(segment => String(segment?.videoPrompt || "").trim())
          || (p.artifacts?.boards?.digitalHuman?.segments || []).some(segment => String(segment?.videoPrompt || segment?.narration || "").trim());
        if (!prepared) {
          setStage(p, "script", "running");
          setStatus(p, "running");
          draftOne(p, batch).then(() => evaluate(batch.id));
          n++;
          return;
        }
        createUnitVideoJobs(p);
      }
      setStatus(p, "running"); n++;
    } else { setStatus(p, "pending"); n++; }
  });
  if (n && batch.phase === "review") { batch.phase = "generating"; save("batches"); }
  return n;
}

/* ---------- 阶段评估（事件驱动核心） ---------- */
export function evaluate(batchId) {
  const batch = batchById(batchId);
  if (!batch || batch.phase === "done") return;
  if (batch.autoAdvance !== true) batch.autoAdvance = true;
  const prods = batchProds(batch);
  if (!prods.length) return;
  const session = state.sessions.find(s => s.id === batch.sessionId) || ensureSession();

  // 老批次（改动前创建、无 emitted 标记）：用会话里已存在的卡片回填，避免刷新后重复发卡
  if (!batch.emitted) {
    batch.emitted = {};
    const msgs = session.messages || [];
    const has = (type, pred) => msgs.some(x => x.type === type && x.payload?.batchId === batch.id && (pred ? pred(x) : true));
    if (has("need_input", x => x.payload?.mode !== "confirm_generate")) batch.emitted.awaiting_input = true;
    if (has("need_input", x => x.payload?.mode === "confirm_generate")) batch.emitted.gen_wait = true;
    if (has("approval")) batch.emitted.review = true;
    if (has("results")) batch.emitted.done = true;
    if (has("error")) batch.emitted.allfail = true;
    // gen_kick 是纯文本无法精确回填：只要有任务已过/在渲染阶段，就认为已发过
    if (prods.some(p => ["render", "workshop", "cut", "copy", "review", "delivered"].includes(p.stage))) batch.emitted.gen_kick = true;
  }

  const drafting = prods.filter(p => p.stage === "script" && p.stageStatus !== "failed").length;
  const failed = prods.filter(p => p.stageStatus === "failed").length;
  const waiting = prods.filter(p => p.stageStatus === "needs_input").length;
  const imageGenerating = prods.filter(p => p.stage === "images" && p.stageStatus === "running").length;
  const renderPending = prods.filter(p =>
    (p.mode === "视频" && p.stage === "render" && p.stageStatus !== "running") ||
    (p.stage === "workshop" && p.stageStatus !== "running")).length;
  const rendering = prods.filter(p => (p.stage === "render" || p.stage === "workshop") && p.stageStatus === "running");
  const inReview = prods.filter(p => p.stage === "review").length;
  const delivered = prods.filter(p => p.stage === "delivered").length;

  // 渲染完成检测：所有 job 成功 → 智能剪辑 → 进审核
  rendering.forEach(p => {
    const jobs = jobsOf(p);
    if (!jobs.length) return;
    const allOk = jobs.every(j => j.status === "succeeded");
    const anyFail = jobs.some(j => j.status === "failed");
    const active = jobs.some(j => ["queued", "submitted", "running"].includes(j.status));
    if (allOk) {
      const r = autoAssemble(p);
      if (p.artifacts.finalVideoUrl) {
        setStage(p, "review", "pending");
        notify("agent", `「${p.title || p.topic}」渲染完成`, `已合成为 1 个完整视频：${r.clips} 段 + ${r.subs} 条字幕${r.bgm ? ` · BGM「${r.bgm}」` : ""}，进入待审核`);
      } else if (!p.artifacts.composing) {
        composeBatchFinalVideo(p).then(ok => {
          if (ok) {
            setStage(p, "review", "pending");
            notify("agent", `「${p.title || p.topic}」成片完成`, `已合成为 1 个完整视频：${r.clips} 段 + ${r.subs} 条字幕，进入待审核`);
          } else {
            setStatus(p, "failed", p.artifacts.composeError || "视频片段已生成，但完整成片合成失败");
          }
          evaluate(batch.id);
        });
      }
    } else if (anyFail && !active) {
      setStatus(p, "failed", jobs.find(j => j.status === "failed")?.error || "部分片段生成失败");
    }
  });

  // 已发卡片/消息去重：持久化在 batch 上，刷新或状态震荡都不会重复发同一条
  const emitOnce = (ph, fn) => { batch.emitted = batch.emitted || {}; if (!batch.emitted[ph]) { batch.emitted[ph] = true; fn(); } };

  if (imageGenerating > 0) { batch.phase = "generating"; }
  else if (drafting > 0) { batch.phase = "drafting"; }
  else if (waiting > 0) {
    batch.phase = "awaiting_input";
    emitOnce("awaiting_input", () => {
      addMsg(session, { role: "agent", type: "need_input", payload: { batchId: batch.id } });
    });
  } else if (renderPending > 0 || rendering.length > 0) {
    if (renderPending > 0) {
      // 素材号用站内分镜（无需上传）；真人号按工坊设置生成后渲染。
      const pend = prods.filter(p => (p.mode === "视频" && p.stage === "render" && p.stageStatus !== "running") || (p.stage === "workshop" && p.stageStatus !== "running"));
      const allInhouse = pend.length > 0 && pend.every(p => p.stage === "workshop");
      emitOnce("gen_kick", () => agentSay(allInhouse
        ? "脚本就绪，自动开始批量生成分镜视频（统一视频任务队列，超出上游并发容量时自动排队）。"
        : "分镜全部上传完成，自动开始批量渲染（统一视频任务队列，超出上游并发容量时自动排队）。"));
      startGeneration(batch);
    } else {
      batch.phase = "generating";
    }
  } else if (inReview > 0 || (failed > 0 && delivered + inReview > 0)) {
    batch.phase = "review";
    emitOnce("review", () => {
      addMsg(session, { role: "agent", type: "approval", payload: { batchId: batch.id } });
      notify("review", `批次「${batch.topic}」待审核`, `${inReview} 条内容等待人工确认`);
    });
  } else if (delivered === prods.length && prods.length > 0) {
    batch.phase = "done";
    emitOnce("done", () => {
      addMsg(session, { role: "agent", type: "results", payload: { batchId: batch.id } });
      notify("agent", `批次「${batch.topic}」全部交付完成`, `${delivered} 条内容已入库`);
    });
  } else if (failed === prods.length) {
    batch.phase = "review";
    emitOnce("allfail", () => addMsg(session, { role: "agent", type: "error", payload: { batchId: batch.id } }));
  }
  batch.updatedAt = Date.now();
  save("batches");
  emit("batch:update", batch);
}

const evaluateAll = debounce(() => activeBatches().forEach(b => evaluate(b.id)), 250);
on("production:update", evaluateAll);
on("job:done", evaluateAll);

/* 启动恢复：把中断的起草接着跑 */
export function resumeActiveBatches() {
  let resumed = 0;
  activeBatches().forEach(b => {
    const stuck = batchProds(b).filter(p => p.stage === "script" && (p.stageStatus === "running" || p.stageStatus === "pending"));
    if (stuck.length) { runPool(stuck, p => draftOne(p, b), 2).then(() => evaluate(b.id)); resumed += stuck.length; }
    const imageStuck = batchProds(b).filter(p =>
      p.mode === "图文"
      && p.stage === "images"
      && (p.stageStatus === "running" || p.stageStatus === "pending")
      && (p.artifacts?.images?.items || []).some(x => x.prompt && !x.assetId)
    );
    if (imageStuck.length) {
      runPool(imageStuck, p => runBatchImagesToReview(p, b), 1).then(() => evaluate(b.id));
      resumed += imageStuck.length;
    }
    evaluate(b.id);
  });
  return resumed;
}

/* ---------- 媒体路由：对话区拖图 → 顺序分发到等待上传的任务 ---------- */
export async function routeMediaFiles(files, batchId = null) {
  const imgs = Array.from(files).filter(f => f.type.startsWith("image/"));
  const vids = Array.from(files).filter(f => f.type.startsWith("video/"));
  const out = { assigned: 0, tasks: 0, extra: 0, videos: vids.length };
  if (imgs.length) {
    const hasGap = p => ((p.mode === "图文" ? p.artifacts.images.items : p.artifacts.boards.items) || []).some(x => !x.assetId);
    // 从某个批次的上传区拖入 → 只分发到该批次的任务，且按看板/卡片显示顺序填，避免跑到别的账号/会话上
    const b = batchId ? batchById(batchId) : null;
    const targets = b && ownedBy(b)
      ? batchProds(b).filter(p => p.stageStatus === "needs_input" && hasGap(p))
      : state.productions.filter(p => ownedBy(p) && p.stageStatus === "needs_input" && hasGap(p)).sort((a, b2) => a.createdAt - b2.createdAt);
    let fi = 0;
    for (const p of targets) {
      if (fi >= imgs.length) break;
      const isImg = p.mode === "图文";
      const items = isImg ? p.artifacts.images.items : p.artifacts.boards.items;
      let took = 0;
      for (const item of items) {
        if (fi >= imgs.length) break;
        if (item.assetId) continue;
        const rawDataUrl = await fileToDataUrl(imgs[fi++]);
        const dataUrl = isImg ? await polishImageDataUrl(rawDataUrl, `${p.id}-agent-upload-${items.indexOf(item)}-${p.topic || ""}`) : rawDataUrl;
        const a = await addAssetFromDataUrl(p.accountId, {
          name: `${isImg ? "笔记图" : "分镜图"}${String(items.indexOf(item) + 1).padStart(2, "0")}_${(p.title || "").slice(0, 6)}`,
          tags: [isImg ? "笔记图" : "分镜图", "Agent上传", ...(isImg ? ["发布前精修"] : [])], dataUrl
        });
        item.assetId = a.id; item.status = "done";
        took++; out.assigned++;
      }
      if (took) {
        out.tasks++;
        if (items.every(x => x.assetId)) maybeAdvanceAfterInput(p);
        else save("productions");
      }
    }
    out.extra = imgs.length - fi;
  }
  for (const f of vids) {
    const accId = state.productions.find(p => ownedBy(p) && p.batchId)?.accountId || state.accounts[0]?.id;
    if (accId) await addAssetFromFile(accId, f, { tags: ["Agent上传"] });
  }
  evaluateAll();
  return out;
}

/* ---------- 用户输入主入口 ---------- */
export function contextSummary() {
  const bs = activeBatches();
  if (!bs.length) return "无进行中的批次";
  return bs.map(b => {
    const prods = batchProds(b);
    const c = {};
    prods.forEach(p => { const k = p.stage + (p.stageStatus === "failed" ? "(失败)" : ""); c[k] = (c[k] || 0) + 1; });
    return `批次「${b.topic}」阶段:${b.phase}，任务:${Object.entries(c).map(([k, v]) => k + "×" + v).join("、")}`;
  }).join("；");
}

/* 思考过程播报（驱动对话区的思考小面板） */
export function think(step, sessionId = state.ui.activeSessionId) { emit("agent:think", { sessionId, step }); }
const INTENT_LABEL = { plan_batch: "拆解量产计划", run_generation: "派发生成任务", approve_all: "批量过审", deliver_all: "批量交付", retry_failed: "重试失败项", status_query: "汇总当前进度" };

function isPureAccountSelection(text) {
  const s = text.trim();
  if (/[「"]/.test(s) || /主题|关于|围绕|做一?期|出一?期/.test(s)) return false;
  return /(选择|选|挑|找|找出|匹配|帮我选|帮我选择|帮我找|给我挑|给我找|选出|安排|量产|创作|做).{0,24}(账号|号|图文|素材|真人|数字人)/.test(s);
}

export async function handleUserText(text) {
  const session = ensureSession();
  session.title = (text || "").slice(0, 18) || "量产计划";
  save("sessions");
  emit("agent:thinking", { sessionId: session.id, value: true });
  think("读取工作台上下文…", session.id);
  try {
    const r = await routeIntent(text, contextSummary());
    think(`识别意图 · ${INTENT_LABEL[r.intent] || r.intent}`, session.id);
    const fb = parseGoalFallback(text);
    const params = { ...(r.params || {}), ...fb };
    if (fb.group && fb.group !== "all") params.group = fb.group;
    params.contentKind = normalizeContentKind(params.contentKind, params.group);
    params.group = CONTENT_KIND_GROUP[params.contentKind] || params.group || "图文组";
    if (fb.accountCount != null) params.accountCount = fb.accountCount;
    if (fb.perAccountCount != null) params.perAccountCount = fb.perAccountCount;
    if (fb.count != null) params.count = fb.count;
    if (fb.sort) params.sort = fb.sort;
    if (fb.pickFrom) params.pickFrom = fb.pickFrom;
    if (isPureAccountSelection(text)) params.topic = "";
    think("按内容分组与活跃度匹配账号矩阵…", session.id);
    const matched = selectAccountsForPlan(params);
    const accountCount = Number(params.accountCount || params.count) || matched.length;
    const perAccountCount = Math.max(1, Math.min(12, Number(params.perAccountCount || 1) || 1));
    think(`命中 ${matched.length} 个账号 · 每号 ${perAccountCount} 条 · 生成量产任务板`, session.id);
    const payload = enforcePlanKind({
      status: "pending", goal: text,
      creativeMode: "custom",
      contentKind: params.contentKind,
      topicMode: "fixed",
      topic: params.topic || "", productId: "dumate", content: "",
      accountProductIds: {}, accountContents: {},
      accountCounts: {},
      accountImageCounts: {},
      imageCount: DEFAULT_XHS_IMAGE_COUNT,
      style: params.style || "", tags: [], group: params.group || "all",
      sort: params.sort || "",
      pickFrom: params.pickFrom || "",
      accountCount, perAccountCount,
      accountIds: matched.map(a => a.id),
      sharedRefAssetIds: [], coverRefAssetIds: [], accountRefAssetIds: {}
    });
    const existing = [...session.messages].reverse().find(m => m.type === "plan" && m.payload?.status === "pending");
    if (existing) {
      existing.payload = { ...existing.payload, ...payload };
      save("sessions");
      emit("agent:session");
    } else {
      addMsg(session, { role: "agent", type: "plan", payload });
    }
  } finally {
    emit("agent:thinking", { sessionId: session.id, value: false });
  }
}

export function statusText() {
  const bs = activeBatches();
  if (!bs.length) {
    const n = state.productions.filter(p => ownedBy(p) && p.stage !== "delivered").length;
    return n ? `当前没有进行中的批次，但有 ${n} 条在制任务散落在单号创作。一句话告诉我主题，我可以发起一批新的量产。` : "一切就绪。说出主题（可带范围/风格），例如：「给全部图文账号做一期下班前自动生成日报，偏教程风」。";
  }
  return bs.map(b => {
    const prods = batchProds(b);
    const phase = { drafting: "批量起草中", awaiting_input: "等待分镜上传", generating: "生成中", review: "待审核", done: "已完成" }[b.phase] || b.phase;
    const fail = prods.filter(p => p.stageStatus === "failed").length;
    const done = prods.filter(p => p.stage === "delivered").length;
    return `「${b.topic}」：${phase} · ${done}/${prods.length} 已交付${fail ? ` · ${fail} 条失败（说"重试失败的"即可）` : ""}`;
  }).join("\n");
}
