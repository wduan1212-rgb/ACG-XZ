/* 链路 · 智能剪辑页：自动拼接 + 时间轴精修
   片段：拖拽排序 / 两端裁剪 / 播放头处分割 / 删除；字幕：自动铺入 / 拖动 / 拉伸 / 样式；SRT 导出；撤销；缩放 */

import { $, $$, esc, gradFor, fmtTC, buildSRT, downloadBlob, clamp, spreadCaption, cleanCaptionText, wireDropZone } from "../core/util.js?v=20260623-captions";
import { icon } from "../ui/icons.js";
import { save, accountById, state } from "../core/store.js";
import { autoAssemble, setStage, isVideoWorkshop } from "../domain/productions.js";
import { buildDeliveryName } from "../domain/accounts.js";
import { addAssetFromFile, assetBlob, globalBgmAssets, urlFor } from "../domain/assets.js";
import { toast, openVideoPreview } from "../ui/components.js";
import { go } from "../core/router.js";
import * as remote from "../core/remote.js";
import { stepperHtml, wireStepper } from "./studio.js?v=20260723-v117-8";

let PPS = 40;
const CLIP_SEC = 15;
const COMPOSE_TIMEOUT_MS = 3 * 60 * 1000;
const histories = new Map(); // productionId -> []
const activeComposes = new Set();

export function cleanEstimatedCaption(text = "") {
  const value = cleanCaptionText(String(text || "")
    .replace(/\\n/g, " ")
    .replace(/[□■▢▣�\uFFFD]+/g, "")
    .replace(/<\|[^>]+\|>/g, "")
    .replace(/^(?:声音|台词|角色|主角|旁白|画外音)(?:\s*[\/:|：]→?\s*)?/i, "")
    .replace(/(?:声线锚点|说话像|运镜|镜头|画面|负面约束)[\s\S]*$/i, ""));
  if (!value || value.length < 2) return "";
  if (/^(?:声音|台词|角色|主角|旁白|画外音|镜头|画面)(?:\s|$)/.test(value)) return "";
  if (/^(?:快节奏|生成9 16|生成短视频|统一视觉风格|禁止|不出现)/.test(value)) return "";
  const useful = (value.match(/[\u3400-\u9fffA-Za-z0-9]/g) || []).length;
  if (useful / Math.max(1, value.length) < .62) return "";
  return value;
}

export function cleanTrustedNarrationCaption(text = "") {
  return cleanCaptionText(String(text || "")
    .replace(/\\n/g, " ")
    .replace(/[□■▢▣�\uFFFD]+/g, "")
    .replace(/<\|[^>]+\|>/g, ""));
}

export function cleanAlignedCaptionText(text = "", trustedNarration = false) {
  return trustedNarration
    ? cleanTrustedNarrationCaption(text)
    : cleanEstimatedCaption(text);
}

// 信息流字幕只旁路读取现有导演提示词里的时间段和真实说话内容。
// 解析结果不会回写或约束提示词；界面文案、导演说明和负面要求会被排除。
const STRICT_SPOKEN_SOURCE = /^(?:台词|口播|旁白|旁|画外音|对白|OS|VO|男声|女声|人声)(?:原话|原文|只有)?[^：:\n]{0,28}$/i;
const STRICT_SPOKEN_METADATA = /(?:台词|口播|旁白|画外音|对白)(?:要点|场控(?:栏)?|风格|规范|要求|说明|策略|节奏|语气|声线|设计|结构|规则|提示|汇总|清单)/i;
const STRICT_SPOKEN_ACTOR = /(?:角色(?:[A-Za-z0-9一二三四五六七八九十甲乙丙丁]{0,4})?|人物|主角|男主|女主|演员|博主|主播|室友|领导|老板|同事|朋友|客户|用户|职员|员工|店员|顾客|对方|产品经理|项目经理|经理|主管|主持人|记者|医生|老师|学生|工程师|设计师|运营|前台|男生|女生|男人|女人|男子|女子|他|她|两人|三人|众人)/;
const STRICT_SPOKEN_VERB = /(?:说(?:出|道)?(?!话|明|法|辞|书)|喊|问(?!题|卷|号)|答道|回答(?:道)?|回应|反驳|提出(?:方案)?|质问|追问|强调|解释|补充|提醒|反问|吐槽|嘀咕|念出?|读出?|低语|收束|点出|脱口而出|开口|吼|同时说|回一句|来一句|自言自语)/i;
const STRICT_ACTOR_ACTION = /(?:拍桌|抬头|转身|转头|回头|侧身|皱眉|咬牙|厉声|低声|轻声|压低声音|声音急促|声音低沉|沉声|笑着|哭着|呼出一口气|推开|扒开|拨开|举着|蹲下)/;
const STRICT_DIRECTOR_OR_UI = /(?:画面|镜头|运镜|景别|机位|构图|光线|光源|色温|声音设计|音效|同期音|环境音|音乐|BGM|转场|字幕|花字|界面|屏幕|显示器|窗口|输入框|按钮|标题|标签|文字|卡片|表格|列表|字段|图标|侧栏|菜单|工具栏|面板|工作台|进度|状态|链接|风险|目标|阻碍|配色|材质|风格|服装|外貌|角色锚点|人物设定|导演|规则|要求|提示|负面|时长|比例|分镜|节奏|画幅|画质|背景|前景|道具|输入|点击|选择|拖拽|上传|下载|打开|关闭|填写|勾选|切换|复制|粘贴|提交|保存|确认)/i;
const STRICT_SPOKEN_NEGATIVE = /(?:^|[，,。；;\n])\s*(?:禁止|不要|不得|避免|无需|不允许|不应|不能|无台词|无对白|无口播|无旁白)/i;
const STRICT_REFERENCE_METADATA = /(?:外貌|外观|形象|性格|一致性|服装|服饰|角色设定|人物设定|镜头设计|说话风格|语言风格|表演要求|状态面板|(?:声线|语气)(?:设定|要求|风格|说明|锚点))/i;
const STRICT_UI_QUOTE_CONTEXT = /(?:界面|屏幕|输入框|按钮|窗口|面板|标题|标签|文字|提示牌|便签|负责人|写着|标注|显示|弹出|输入|点击|拖入|高亮)[^。；;\n]{0,32}$/i;
const QUOTED_SPEECH = /[“"「『‘']([^”"」』’'\n]{1,180})[”"」』’']/g;

function strictInfoFlowSpeechLabel(raw = "") {
  const label = String(raw || "")
    .replace(/^\s*\d+(?:\.\d+)?\s*(?:-|\u2013|—|~|至|到)\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*/i, "")
    .trim();
  if (!label
    || /\d\s*(?:s|秒)?$/i.test(label)
    || /^(?:禁止|不要|不得|避免|无需|要求|提示)/.test(label)
    || /(?:外貌|外观|形象|性格|一致性|服装|服饰|角色设定|人物设定|镜头设计|说话风格|语言风格|表演要求|状态面板|(?:声线|语气)(?:设定|要求|风格)|(?:角色|人物|台词|口播)(?:声线|语气))/.test(label)
    || STRICT_SPOKEN_METADATA.test(label)) return false;
  const source = STRICT_SPOKEN_SOURCE.test(label);
  const actor = STRICT_SPOKEN_ACTOR.test(label);
  const verb = STRICT_SPOKEN_VERB.test(label);
  const namedActor = /(?:^|[，,\s])(?:小|老|阿)?[\u3400-\u9fff]{1,4}/.test(label) && (verb || STRICT_ACTOR_ACTION.test(label));
  const startsAsDirector = /^(?:画面|镜头|运镜|界面|屏幕|输入框|按钮|窗口|面板|光线|音效|字幕|标题|标签|文字|卡片|字段)/.test(label);
  if (STRICT_DIRECTOR_OR_UI.test(label) && !(source || actor || (verb && namedActor && !startsAsDirector))) return false;
  return source || actor || namedActor || (verb && /[\u3400-\u9fff]/.test(label));
}

function spokenContextBefore(value = "", index = 0) {
  const prefix = String(value || "").slice(Math.max(0, Number(index || 0) - 180), Number(index || 0));
  const boundary = Math.max(
    prefix.lastIndexOf("\n"), prefix.lastIndexOf("。"), prefix.lastIndexOf("；"),
    prefix.lastIndexOf(";"), prefix.lastIndexOf("！"), prefix.lastIndexOf("？"),
  );
  return prefix.slice(boundary + 1).trim();
}

function explicitQuotedSpeechContext(context = "") {
  return /^(?:台词|口播(?:原话|原文)?|旁白|旁|画外音|对白|OS|VO|男声|女声)(?!(?:要点|风格|规范|要求|说明|策略|节奏|语气|声线|设计|结构|规则|提示|汇总|清单|场控))[^：:\n]{0,40}[:：]\s*$/i
    .test(String(context || "").trim());
}

function naturalTimelineSpeechLines(text = "") {
  const value = String(text || "")
    .replace(/^\s*\d+(?:\.\d+)?\s*(?:-|\u2013|—|~|至|到)\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[，,:：]?\s*/i, "")
    .trim();
  if (!value) return [];
  if (/^(?:(?:界面|屏幕|输入框|按钮|窗口|面板|右侧|左侧|工具栏|用户界面)(?:显示|写着|弹出|输入|点击|选择|拖拽|高亮|说明|把)|(?:切换到|打开|关闭)[^。；;\n]{0,32}(?:界面|屏幕|窗口|面板|按钮|页面))/i.test(value)) return [];
  const lines = [];
  for (const match of value.matchAll(QUOTED_SPEECH)) {
    const index = Number(match.index || 0);
    const context = spokenContextBefore(value, index);
    const source = STRICT_SPOKEN_SOURCE.test(context) || explicitQuotedSpeechContext(context);
    const actorQuote = STRICT_SPOKEN_ACTOR.test(context);
    const verb = STRICT_SPOKEN_VERB.test(context);
    const namedActor = strictInfoFlowSpeechLabel(context);
    const explicitSpeechTail = /(?:说(?:出|道)?|喊|问|答道|回答|回应|反驳|提出(?:方案)?|质问|追问|强调|解释|补充|提醒|吐槽|嘀咕|念出?|读出?|低语|点出|脱口而出|开口|吼|自言自语|声音急促|声音低沉|低声|轻声|厉声|旁白|台词|口播)\s*[:：]?\s*$/i.test(context);
    const blocked = STRICT_SPOKEN_NEGATIVE.test(context)
      || STRICT_SPOKEN_METADATA.test(context)
      || STRICT_REFERENCE_METADATA.test(context)
      || (STRICT_UI_QUOTE_CONTEXT.test(context) && !explicitSpeechTail)
      || (STRICT_DIRECTOR_OR_UI.test(context) && !(source || actorQuote || namedActor));
    if (blocked || !(source || actorQuote || verb || namedActor)) continue;
    const raw = String(match[1] || "").trim();
    const textValue = cleanEstimatedCaption(raw);
    if (!textValue) continue;
    lines.push({ raw, text: textValue });
  }

  // 高质量提示词并不总给台词加引号。只在明确说话动作之后读取同句内容，
  // 并在后续动作或句末处停止，避免把导演描述一起塞进字幕。
  const spokenVerb = new RegExp(STRICT_SPOKEN_VERB.source, "gi");
  for (const match of value.matchAll(spokenVerb)) {
    const index = Number(match.index || 0);
    const context = spokenContextBefore(value, index + String(match[0] || "").length);
    if (STRICT_SPOKEN_NEGATIVE.test(context) || STRICT_SPOKEN_METADATA.test(context)) continue;
    const actor = strictInfoFlowSpeechLabel(context);
    if (!actor) continue;
    const afterVerb = value.slice(index + String(match[0] || "").length)
      .replace(/^\s*[:：]\s*/, "");
    const nestedColon = afterVerb.search(/[:：]/);
    const sentenceEnd = afterVerb.search(/[。！？!?；;\n]/);
    if (nestedColon >= 0 && (sentenceEnd < 0 || nestedColon < sentenceEnd)) continue;
    let raw = afterVerb
      .replace(/^\s*(?:一句台词)?\s*[:：,，]?\s*/, "")
      .split(/[。！？!?；;\n]/)[0]
      .split(/[，,]\s*(?=(?:他|她|其|随后|同时|接着|镜头|画面|界面|屏幕|按钮|窗口)[^，,。；;]{0,36}(?:动作|转身|抬头|低头|接过|推开|打开|关闭|显示|弹出|切换|移动|进入))/)[0]
      .trim();
    if (!raw || /^[“"「『‘']/.test(raw)) continue;
    const textValue = cleanEstimatedCaption(raw);
    if (!textValue) continue;
    lines.push({ raw, text: textValue });
  }

  const seen = new Set();
  return lines.filter(line => {
    const key = line.text.replace(/\s+/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function timedCaptionChunks(text = "", maxLen = 12) {
  const raw = String(text || "").replace(/\\n/g, " ").trim();
  const clauses = raw.split(/(?<=[，、。！？!?；;…])/).map(item => item.trim()).filter(Boolean);
  const chunks = [];
  (clauses.length ? clauses : [raw]).forEach(clause => {
    const pause = /[。！？!?]”?$/.test(clause) ? 2.2 : /[，、；;…]”?$/.test(clause) ? 1.2 : .35;
    let clean = cleanCaptionText(clause);
    while (clean.length > maxLen) {
      chunks.push({ text: clean.slice(0, maxLen), weight: maxLen + .25 });
      clean = clean.slice(maxLen);
    }
    if (clean) chunks.push({ text: clean, weight: Math.max(1, [...clean].length) + pause });
  });
  return chunks;
}

export function spreadKnownCaption(text = "", start = 0, end = 0, maxLen = 12) {
  const chunks = timedCaptionChunks(text, maxLen);
  const from = Math.max(0, Number(start || 0));
  const to = Math.max(from + .05, Number(end || 0));
  if (!chunks.length) return [];
  const totalWeight = chunks.reduce((sum, chunk) => sum + chunk.weight, 0) || 1;
  let cursor = from;
  return chunks.map((chunk, index) => {
    const rawEnd = index === chunks.length - 1 ? to : cursor + (to - from) * chunk.weight / totalWeight;
    const cueEnd = Math.min(to, Math.max(cursor + .05, rawEnd));
    const cue = { text: chunk.text, start: Math.round(cursor * 100) / 100, end: Math.round(cueEnd * 100) / 100 };
    cursor = cueEnd;
    return cue;
  }).filter(cue => cue.text && cue.end > cue.start);
}

// Only explicit spoken-source fields are eligible. Generic “声音/台词” director
// instructions and arbitrary quoted copy must never become captions.
export function extractStructuredSpokenCues(text = "", duration = 0) {
  const prompt = String(text || "");
  const limit = Math.max(0, Number(duration || 0));
  const markers = [...prompt.matchAll(/(\d+(?:\.\d+)?)\s*(?:-|–|—|~|至|到)\s*(\d+(?:\.\d+)?)\s*(?:s|秒)/gi)];
  // 没有原始时间段就不猜时间。这样不会把汇总台词或导演说明
  // 平均铺满整段视频。
  if (!markers.length) return [];
  const markerStarts = markers.map(marker => Number(marker[1])).filter(Number.isFinite);
  const markerOffset = limit && markerStarts.length && Math.min(...markerStarts) >= limit - .01
    ? Math.min(...markerStarts)
    : 0;
  const cues = [];
  markers.forEach((marker, index) => {
    const start = Math.max(0, Number(marker[1]) - markerOffset);
    const rawEnd = Math.max(start, Number(marker[2]) - markerOffset);
    const end = limit ? Math.min(limit, rawEnd) : rawEnd;
    if (end <= start) return;
    const blockEnd = markers[index + 1]?.index ?? prompt.length;
    const block = prompt.slice(marker.index, blockEnd);
    // 不再把任意“标签：内容”当成口播。只读取明确的说话动作或
    // 与说话主体相连的引号文本，避免画面、界面和参数冒号误入字幕。
    const spokenLines = naturalTimelineSpeechLines(block)
      .filter((line, lineIndex, rows) => rows.findIndex(row => row.text.replace(/\s+/g, "") === line.text.replace(/\s+/g, "")) === lineIndex);
    if (!spokenLines.length) return;
    const weights = spokenLines.map(line => timedCaptionChunks(line.raw).reduce((sum, chunk) => sum + chunk.weight, 0) || 1);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    let cursor = start;
    spokenLines.forEach((spoken, lineIndex) => {
      const lineEnd = lineIndex === spokenLines.length - 1
        ? end
        : Math.min(end, cursor + (end - start) * weights[lineIndex] / totalWeight);
      cues.push(...spreadKnownCaption(spoken.raw, cursor, lineEnd));
      cursor = lineEnd;
    });
  });
  const seen = new Set();
  return cues.filter(cue => {
    const key = `${Number(cue.start || 0).toFixed(2)}:${Number(cue.end || 0).toFixed(2)}:${String(cue.text || "").replace(/\s+/g, "").trim()}`;
    if (!cue.text || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function digitalSegmentAt(timeline = [], clipIndex = 0, segments = []) {
  const clip = timeline?.[clipIndex] || {};
  const rows = (segments || []).filter(Boolean);
  const byId = clip.segmentId
    ? rows.find(segment => String(segment.id || "") === String(clip.segmentId))
    : null;
  if (byId) return byId;
  const byJob = clip.jobId
    ? rows.find(segment => String(segment.videoJobId || "") === String(clip.jobId))
    : null;
  if (byJob) return byJob;
  const legacyIndexSafe = timeline.length === rows.length
    && timeline.every(item => !item?.segmentId && !item?.jobId);
  return legacyIndexSafe ? (rows[clipIndex] || null) : null;
}

export function digitalSegmentDurationCuesForClip(timeline = [], clipIndex = 0, segments = []) {
  const clip = timeline?.[clipIndex] || {};
  const segment = digitalSegmentAt(timeline, clipIndex, segments);
  // segment.line 是生成独立 MP3 时使用的可信 TTS 原文，只清乱码和
  // 标点，不套提示词过滤器，避免误删“声音 / 镜头 / 画面”等正常口播。
  const timingText = String(segment?.line || "")
    .replace(/\\n/g, " ")
    .replace(/[□■▢▣�\uFFFD]+/g, "")
    .replace(/<\|[^>]+\|>/g, "")
    .trim();
  const text = cleanTrustedNarrationCaption(timingText);
  if (!text || !segment) return [];
  const segmentKey = String(segment.id || segment.videoJobId || "");
  const group = (timeline || []).map((item, index) => ({
    clip: item || {},
    index,
    segment: digitalSegmentAt(timeline, index, segments)
  })).filter(item => item.segment && (
    item.segment === segment
    || (segmentKey && String(item.segment.id || item.segment.videoJobId || "") === segmentKey)
  ));
  const measuredAudio = [Number(segment.audioDuration || 0)]
    .concat(group.map(item => Number(item.clip.audioDuration || 0)))
    .filter(value => Number.isFinite(value) && value > 0);
  const measuredVideo = [Number(segment.videoDuration || 0)]
    .concat(group.map(item => Number(item.clip.videoDuration || 0)))
    .filter(value => Number.isFinite(value) && value > 0);
  // 不再用分镜计划时长猜测口播时间。优先用生成 MP3 的实测时长，
  // 旧成片没有音频时长时才用已加载视频的真实时长。
  const sourceDuration = measuredAudio.length
    ? Math.max(...measuredAudio)
    : (measuredVideo.length ? Math.max(...measuredVideo) : 0);
  if (!(sourceDuration > 0)) return [];
  const ranges = group.map(item => {
    const start = Math.max(0, Number(item.clip.trimIn || 0));
    const duration = Math.max(.1, Number(item.clip.dur || item.clip.videoDuration || 0));
    return { ...item, start, end: Math.min(sourceDuration, start + duration) };
  }).filter(item => item.end > item.start + .05);
  const target = ranges.find(item => item.index === clipIndex);
  if (!target) return [];
  const shortestRange = Math.min(...ranges.map(item => item.end - item.start));
  const proportionalMaxLen = Math.ceil([...text].length * shortestRange / sourceDuration);
  const maxLen = Math.max(4, Math.min(12, proportionalMaxLen || 12));
  const baseCues = spreadKnownCaption(timingText, 0, sourceDuration, maxLen);
  return baseCues.flatMap(cue => {
    let winner = null;
    let winnerOverlap = 0;
    ranges.forEach(range => {
      const overlap = Math.max(0, Math.min(cue.end, range.end) - Math.max(cue.start, range.start));
      if (overlap > winnerOverlap + .001) {
        winner = range;
        winnerOverlap = overlap;
      }
    });
    if (!winner || winner.index !== clipIndex || winnerOverlap <= .05) return [];
    return [{
      text: cue.text,
      start: Math.max(0, Math.max(cue.start, target.start) - target.start),
      end: Math.min(target.end, cue.end) - target.start
    }];
  }).filter(cue => cue.text && cue.end > cue.start + .05);
}

export function buildDigitalSegmentDurationCaptions(timeline = [], segments = []) {
  const cues = [];
  let offset = 0;
  (timeline || []).forEach((clip, clipIndex) => {
    cues.push(...digitalSegmentDurationCuesForClip(timeline, clipIndex, segments).map(cue => ({
      ...cue,
      start: Math.round((offset + cue.start) * 10) / 10,
      end: Math.round((offset + cue.end) * 10) / 10,
      clipId: clip?.id || "",
      clipIndex,
      autoAligned: true,
      precise: false,
      digitalSegmentDuration: true
    })));
    offset += Math.max(1, Number(clip?.dur || 0) || 15);
  });
  return cues;
}

export function renderCutPage(root, p) {
  root.__cutStopPlay?.();
  root.__cutStopPlay = null;
  if (p.artifacts.composing && !activeComposes.has(p.id)) {
    p.artifacts.composing = false;
    p.artifacts.composeError = "上次合成已中断，请重新点击下一步";
    save("productions");
  }
  if (p.artifacts.audioTimingPending) {
    p.artifacts.audioTimingPending = false;
    save("productions");
  }
  const acc = accountById(p.accountId);
  const digitalCaptionMode = p.artifacts?.boards?.generationMode === "digitalHuman";
  const legacySubStyle = p.artifacts.subStyle
    && Number(p.artifacts.subStyle.size) === 13
    && Number(p.artifacts.subStyle.stroke) === 2
    && Number(p.artifacts.subStyle.bottom) === 12;
  const lowSubStyle = p.artifacts.subStyle
    && Number(p.artifacts.subStyle.size) === 11
    && Number(p.artifacts.subStyle.stroke) === 1
    && Number(p.artifacts.subStyle.bottom) === 5;
  const previousDefaultSubStyle = p.artifacts.subStyle
    && Number(p.artifacts.subStyle.size) === 11
    && Number(p.artifacts.subStyle.stroke) === 1
    && Number(p.artifacts.subStyle.bottom) === 22;
  const canMigrateSystemSubStyle = !p.artifacts.subStyleUserEdited
    && (legacySubStyle || lowSubStyle || previousDefaultSubStyle);
  if (!p.artifacts.subStyle || canMigrateSystemSubStyle) {
    p.artifacts.subStyle = { size: digitalCaptionMode ? 15 : 11, stroke: 1, bottom: 22 };
    p.artifacts.subStyleDefaultVersion = 3;
    if (legacySubStyle || lowSubStyle || (digitalCaptionMode && previousDefaultSubStyle)) {
      p.artifacts.finalVideoUrl = "";
      p.artifacts.finalVideoCaptionSig = "";
    }
    save("productions");
  }
  let playheadT = 0;
  let playTimer = null;
  let playStartedAt = 0;
  let playStartedT = 0;
  let timelineRedrawFrame = null;
  let activeSubIdx = 0;
  let selectedClipId = null;
  let activeTrack = "";
  let subtitleClipboard = null;

  const TL = () => p.artifacts.timeline || (p.artifacts.timeline = []);
  const SUBS = () => p.artifacts.subs || (p.artifacts.subs = []);
  const isDigitalHuman = () => p.artifacts?.boards?.generationMode === "digitalHuman";
  const protectedCaptionTiming = () => {
    const source = p.artifacts.subTimingSource || "";
    return source === "manual"
      || source.startsWith("audio-analysis-")
      || source.startsWith("digital-segment-duration-v2")
      || source.startsWith("prompt-speech-timeline-v3");
  };
  const clipDur = c => Math.max(1, c.dur != null ? c.dur : CLIP_SEC);
  const clipStart = i => { let t = 0; for (let k = 0; k < i; k++) t += clipDur(TL()[k]); return t; };
  const clipsTotal = () => TL().reduce((s, c) => s + clipDur(c), 0);
  const totalDur = () => Math.max(1, clipsTotal());
  const jobForClip = c => c?.jobId ? state.jobs.find(j => j.id === c.jobId) : null;
  const digitalSegmentForClip = c => (p.artifacts?.boards?.digitalHuman?.segments || [])
    .find(seg => (c?.segmentId && seg.id === c.segmentId) || (c?.jobId && seg.videoJobId === c.jobId));
  const videoUrlForClip = c => c?.videoUrl || jobForClip(c)?.output?.url || digitalSegmentForClip(c)?.videoOutput?.url || "";
  const audioAssets = () => globalBgmAssets();
  const mediaUrlForAsset = id => {
    const u = urlFor(id) || "";
    return u || "";
  };
  const narrationPreviewUrl = () => mediaUrlForAsset(p.artifacts.audio?.assetId);
  const bgmPreviewUrl = () => mediaUrlForAsset(p.artifacts.bgm?.assetId);
  const assetMedia = async (id) => {
    if (!id) return { dataUrl: "", url: "" };
    const blob = await assetBlob(id).catch(() => null);
    const rawUrl = urlFor(id) || "";
    const url = rawUrl && !rawUrl.startsWith("blob:") && !rawUrl.startsWith("data:")
      ? new URL(rawUrl, location.origin).href
      : "";
    if (!blob) return { dataUrl: "", url };
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = e => resolve(e.target.result || "");
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    return { dataUrl, url };
  };
  const captionSignature = () => JSON.stringify({
    cues: SUBS().map(s => [s.start, s.end, cleanCaptionText(s.text || "")]),
    style: p.artifacts.subStyle
  });
  const timelineSignature = () => JSON.stringify(TL().map(c => [c.id, c.videoUrl || c.jobId, c.dur, c.trimIn || 0]));
  const mixSignature = () => JSON.stringify({
    narration: p.artifacts.audio?.assetId || "clip-audio",
    narrationVolume: Number(p.artifacts.audio?.volume ?? 1),
    bgm: p.artifacts.bgm?.assetId || "",
    bgmVolume: Number(p.artifacts.bgm?.volume ?? 0.25),
    preserveClipAudio: isDigitalHuman()
  });
  const invalidateFinalMix = () => {
    p.artifacts.finalVideoUrl = "";
    p.artifacts.finalVideoName = "";
    p.artifacts.finalVideoBaseUrl = "";
    p.artifacts.finalVideoVersions = [];
    p.artifacts.finalVideoMixSig = "";
    p.artifacts.composeError = "";
  };
  const legacyInfoFlowCaptions = !isDigitalHuman()
    && p.artifacts.subTimingSource !== "manual"
    && !String(p.artifacts.subTimingSource || "").endsWith("-manual")
    && SUBS().length > 0;
  if (legacyInfoFlowCaptions) {
    p.artifacts.subs = [];
    p.artifacts.subTimingSource = "";
    p.artifacts.audioTimingSource = "";
    p.artifacts.audioTimingAttemptSig = "";
    invalidateFinalMix();
    save("productions");
  }
  const bumpAudioTimingRevision = () => {
    p.artifacts.audioTimingRevision = Number(p.artifacts.audioTimingRevision || 0) + 1;
    return p.artifacts.audioTimingRevision;
  };
  const markCaptionTimingManual = () => {
    p.artifacts.subTimingSource = "manual";
    p.artifacts.audioTimingSource = "";
    p.artifacts.audioTimingAttemptSig = "";
    bumpAudioTimingRevision();
    invalidateFinalMix();
  };
  let queuedCaptionRealignment = false;
  const queueCaptionRealignment = () => {
    // 信息流默认不生成字幕：只有用户主动点击“匹配字幕”时才解析提示词。
    if (!isDigitalHuman() || queuedCaptionRealignment || p.artifacts.subTimingSource === "manual") return;
    queuedCaptionRealignment = true;
    queueMicrotask(async () => {
      try {
        if (root.isConnected && p.artifacts.subTimingSource !== "manual") {
          await alignCaptionsToAudio({ silent: true });
        }
      } finally {
        queuedCaptionRealignment = false;
      }
    });
  };
  const invalidateDerivedCaptionTiming = ({ schedule = true } = {}) => {
    const manual = p.artifacts.subTimingSource === "manual";
    if (!manual) {
      p.artifacts.subs = [];
      p.artifacts.subTimingSource = "";
    }
    p.artifacts.audioTimingSource = "";
    p.artifacts.audioTimingAttemptSig = "";
    bumpAudioTimingRevision();
    invalidateFinalMix();
    if (schedule && !manual) queueCaptionRealignment();
    return !manual;
  };
  const needsCompose = () => !!TL().length && (!p.artifacts.finalVideoUrl
    || p.artifacts.finalVideoCaptionSig !== captionSignature()
    || p.artifacts.finalVideoTimelineSig !== timelineSignature()
    || p.artifacts.finalVideoMixSig !== mixSignature());

  // Keep one caption lane readable: generated cues follow the finished clip duration,
  // while manual edits are clamped between adjacent cues instead of stacking.
  function normalizeCaptionTrack(subs = SUBS()) {
    const videoEnd = totalDur();
    const ranges = TL().map((clip, index) => ({
      index,
      clipId: clip.id,
      start: clipStart(index),
      end: clipStart(index) + clipDur(clip)
    }));
    let cursor = 0;
    subs.sort((a, b) => (a.start || 0) - (b.start || 0));
    subs.forEach(s => {
      const duration = Math.max(.5, Number(s.end || 0) - Number(s.start || 0));
      const rawStart = Number(s.start || 0);
      const exactTiming = Boolean(s.precise || String(p.artifacts.subTimingSource || "").startsWith("audio-analysis-"));
      const range = (s.clipId && ranges.find(item => item.clipId === s.clipId))
        || (Number.isInteger(Number(s.clipIndex))
        ? ranges[Number(s.clipIndex)]
        : ranges.find(item => rawStart >= item.start - .05 && rawStart < item.end));
      if (range) {
        s.clipId = range.clipId;
        s.clipIndex = range.index;
      }
      if (exactTiming) {
        const lower = range?.start ?? 0;
        const upper = range?.end ?? videoEnd;
        s.start = Math.round(clamp(rawStart, lower, Math.max(lower, upper - .05)) * 100) / 100;
        s.end = Math.round(clamp(Number(s.end || 0), s.start + .05, upper) * 100) / 100;
        return;
      }
      if (range) {
        if (cursor >= range.end - .12 || cursor < range.start) cursor = range.start;
        s.start = Math.round(Math.max(range.start, cursor, rawStart) * 10) / 10;
        s.end = Math.round(Math.min(range.end - .05, s.start + duration) * 10) / 10;
        if (s.end <= s.start) s.end = Math.round(Math.min(range.end, s.start + .25) * 10) / 10;
      } else {
        s.start = Math.round(clamp(Math.max(cursor, rawStart), 0, Math.max(0, videoEnd - .25)) * 10) / 10;
        s.end = Math.round(Math.min(videoEnd, s.start + duration) * 10) / 10;
      }
      s.start = clamp(s.start, 0, Math.max(0, videoEnd - .05));
      s.end = clamp(s.end, Math.min(videoEnd, s.start + .05), videoEnd);
      cursor = s.end + .1;
    });
    for (let i = subs.length - 1; i >= 0; i--) {
      if (!Number.isFinite(subs[i].start) || subs[i].start >= videoEnd || subs[i].end <= subs[i].start) subs.splice(i, 1);
    }
    return subs;
  }

  function splitCaptionText(text = "") {
    const value = String(text || "");
    if (!value) return ["", ""];
    const chars = [...value];
    const middle = Math.max(1, Math.min(chars.length - 1, Math.ceil(chars.length / 2)));
    return [chars.slice(0, middle).join("").trim(), chars.slice(middle).join("").trim()];
  }

  function activeCaptionAtPlayhead() {
    const direct = SUBS().findIndex(s => playheadT > Number(s.start || 0) + .05 && playheadT < Number(s.end || 0) - .05);
    if (direct >= 0) return direct;
    const current = SUBS()[activeSubIdx];
    return current && playheadT > Number(current.start || 0) + .05 && playheadT < Number(current.end || 0) - .05 ? activeSubIdx : -1;
  }

  function splitSubtitle({ keep = "both" } = {}) {
    const i = activeCaptionAtPlayhead();
    if (i < 0) { toast("把播放头放到要分割的字幕中间"); return false; }
    const source = SUBS()[i];
    const at = Math.round(playheadT * 10) / 10;
    if (at <= source.start + .1 || at >= source.end - .1) { toast("播放头要落在字幕中间"); return false; }
    snapshot();
    const [leftText, rightText] = splitCaptionText(source.text || "");
    const left = { ...source, end: at, text: leftText };
    const right = { ...source, start: at, text: rightText };
    const replacement = keep === "left" ? [left] : keep === "right" ? [right] : [left, right];
    SUBS().splice(i, 1, ...replacement);
    activeSubIdx = keep === "right" ? i : Math.min(i, SUBS().length - 1);
    activeTrack = "sub";
    markCaptionTimingManual();
    normalizeCaptionTrack();
    save("productions");
    drawTimeline();
    toast(keep === "both" ? "已分割字幕" : keep === "left" ? "已分割并删除后段" : "已分割并删除前段");
    return true;
  }

  function copySubtitle({ cut = false } = {}) {
    const s = SUBS()[activeSubIdx];
    if (!s) { toast("先选择一条字幕"); return; }
    subtitleClipboard = { text: s.text || "", duration: Math.max(.5, Number(s.end || 0) - Number(s.start || 0)) };
    if (cut) {
      snapshot();
      SUBS().splice(activeSubIdx, 1);
      activeSubIdx = Math.max(0, Math.min(activeSubIdx, SUBS().length - 1));
      markCaptionTimingManual();
      save("productions");
      drawTimeline();
    }
    toast(cut ? "已剪切字幕" : "已复制字幕");
  }

  function pasteSubtitle() {
    if (!subtitleClipboard) { toast("还没有复制字幕"); return; }
    const end = totalDur();
    const start = clamp(playheadT, 0, Math.max(0, end - .25));
    snapshot();
    SUBS().push({ start, end: Math.min(end, start + subtitleClipboard.duration), text: subtitleClipboard.text });
    markCaptionTimingManual();
    normalizeCaptionTrack();
    activeSubIdx = Math.max(0, SUBS().findIndex(s => Math.abs(s.start - start) < .06));
    activeTrack = "sub";
    save("productions");
    drawTimeline();
    toast("已粘贴到播放头");
  }

  function rebuildDigitalCaptions() {
    const subs = buildDigitalSegmentDurationCaptions(
      TL(),
      p.artifacts?.boards?.digitalHuman?.segments || []
    );
    p.artifacts.subs = normalizeCaptionTrack(subs);
    p.artifacts.subTimingSource = subs.length ? "digital-segment-duration-v2" : "digital-segment-duration-v2-empty";
    p.artifacts.audioTimingSource = subs.length ? "known-narration-real-duration" : "missing-real-duration-or-narration";
  }

  function refreshCaptionAlignment({ force = false } = {}) {
    const digital = isDigitalHuman();
    const protectedTiming = protectedCaptionTiming();
    if (digital && !protectedTiming && (
      force
      || !SUBS().length
      || !p.artifacts.subTimingSource.startsWith("digital-segment-duration-v2")
    )) rebuildDigitalCaptions();
    else normalizeCaptionTrack();
  }

  function timedSpeechHintsForClip(clip, index) {
    if (isDigitalHuman()) {
      return digitalSegmentDurationCuesForClip(
        TL(),
        index,
        p.artifacts.boards?.digitalHuman?.segments || []
      );
    }
    const segments = p.artifacts.boards?.infoFlow?.segments || [];
    const segment = segments.find(item => (
      (clip.segmentId && item.id === clip.segmentId)
      || (clip.unitId && (item.id === clip.unitId || item.unitId === clip.unitId))
    )) || segments[index] || {};
    const unit = (p.artifacts.boards?.units || []).find(item => item.id === clip.unitId);
    const savedCues = Array.isArray(segment.spokenCues)
      ? segment.spokenCues
      : (Array.isArray(unit?.spokenCues) ? unit.spokenCues : []);
    if (savedCues.length) {
      return savedCues.map(cue => ({
        text: cleanEstimatedCaption(cue.text),
        start: Number.isFinite(Number(cue.start)) ? Math.max(0, Number(cue.start)) : undefined,
        end: Number.isFinite(Number(cue.end)) ? Math.min(clipDur(clip), Number(cue.end)) : undefined
      })).filter(cue => cue.text && (cue.end == null || cue.end > (cue.start || 0)));
    }
    const prompt = String(segment.videoPrompt || unit?.prompt || unit?.videoPrompt || segment.visual || "");
    return extractStructuredSpokenCues(prompt, clipDur(clip));
  }

  function promptTimelineCaptions() {
    const cues = [];
    TL().forEach((clip, clipIndex) => {
      const duration = clipDur(clip);
      const offset = clipStart(clipIndex);
      timedSpeechHintsForClip(clip, clipIndex)
        .filter(hint => Number.isFinite(Number(hint.start)) && Number.isFinite(Number(hint.end)))
        .forEach(hint => {
          const text = cleanEstimatedCaption(hint.text);
          const localStart = clamp(Number(hint.start), 0, Math.max(0, duration - .05));
          const localEnd = clamp(Number(hint.end), localStart + .05, duration);
          if (!text || localEnd <= localStart) return;
          cues.push(...spreadKnownCaption(text, offset + localStart, offset + localEnd).map(cue => ({
            ...cue,
            clipId: clip.id,
            clipIndex,
            autoAligned: true,
            precise: true,
            promptTimeline: true
          })));
        });
    });
    return cues;
  }

  const audioTimingDescriptors = () => TL().map((clip, index) => {
    const seg = digitalSegmentForClip(clip);
    const hints = timedSpeechHintsForClip(clip, index);
    return {
      clipId: String(clip.id || `clip-${index}`),
      videoUrl: videoUrlForClip(clip),
      audioAssetId: isDigitalHuman() ? (clip.audioAssetId || seg?.audioAssetId || "") : "",
      trimIn: Math.max(0, Number(clip.trimIn || 0)),
      duration: clipDur(clip),
      text: hints.map(hint => hint.text).join("，"),
      hints,
      strict: !isDigitalHuman(),
      trustedNarration: Boolean(
        isDigitalHuman()
        && (clip.audioAssetId || seg?.audioAssetId)
        && hints.length
      )
    };
  }).filter(item => item.videoUrl || item.audioAssetId);

  const audioTimingAttemptSignature = (revision = Number(p.artifacts.audioTimingRevision || 0)) => JSON.stringify({
    revision,
    mode: isDigitalHuman() ? "digital-human" : "info-flow",
    clips: audioTimingDescriptors()
  });

  const timingAttemptIsCurrent = (attemptSig, revision, { allowExistingManual = false } = {}) => (
    Number(p.artifacts.audioTimingRevision || 0) === revision
    && p.artifacts.audioTimingAttemptSig === attemptSig
    && audioTimingAttemptSignature(revision) === attemptSig
    && (allowExistingManual || p.artifacts.subTimingSource !== "manual")
  );

  async function alignCaptionsToAudio({ silent = false, force = false, manualTrigger = false } = {}) {
    // 手工编辑的字幕永远最高优先：即使用户再点一次自动生成，也不覆盖。
    if (p.artifacts.subTimingSource === "manual") {
      if (!silent) toast("已保留手工编辑字幕，如需重建请先手工清空字幕轨");
      return false;
    }
    if (!isDigitalHuman() && !manualTrigger) {
      if (!silent) toast("信息流默认不自动生成字幕，可点击“匹配字幕”手动建立", "info");
      return false;
    }
    const descriptors = audioTimingDescriptors();
    if (!descriptors.length) return false;
    const requestRevision = Number(p.artifacts.audioTimingRevision || 0);
    const attemptSig = audioTimingAttemptSignature(requestRevision);
    if (!force && p.artifacts.audioTimingAttemptSig === attemptSig) return false;
    p.artifacts.audioTimingAttemptSig = attemptSig;
    const cues = isDigitalHuman()
      ? buildDigitalSegmentDurationCaptions(TL(), p.artifacts?.boards?.digitalHuman?.segments || [])
      : promptTimelineCaptions();
    if (p.artifacts.subTimingSource === "manual" || !timingAttemptIsCurrent(attemptSig, requestRevision)) return false;
    p.artifacts.subs = normalizeCaptionTrack(cues);
    p.artifacts.subTimingSource = isDigitalHuman()
      ? (cues.length ? "digital-segment-duration-v2" : "digital-segment-duration-v2-empty")
      : (cues.length ? "prompt-speech-timeline-v3-manual" : "prompt-speech-timeline-v3-empty-manual");
    p.artifacts.audioTimingSource = isDigitalHuman()
      ? (cues.length ? "known-narration-real-duration" : "missing-real-duration-or-narration")
      : (cues.length ? "existing-prompt-spoken-timeline" : "no-explicit-spoken-dialogue-timeline");
    p.artifacts.audioTimingPending = false;
    p.artifacts.finalVideoUrl = "";
    p.artifacts.finalVideoCaptionSig = "";
    save("productions");
    drawTimeline();
    if (!silent) {
      if (cues.length) toast(isDigitalHuman()
        ? `已按分段口播原文与实测时长生成 ${cues.length} 条字幕`
        : `已按原提示词的明确说话内容与时间段生成 ${cues.length} 条字幕`);
      else toast(isDigitalHuman()
        ? "没有可靠的分段口播原文或实测音视频时长，未生成猜测字幕"
        : "提示词中没有可确认的说话内容与时间段，未生成猜测字幕", "error");
    }
    return cues.length > 0;
  }

  function syncClipDurationFromMedia(clipId, duration) {
    const clip = TL().find(c => c.id === clipId);
    const actual = Math.round(Number(duration || 0) * 10) / 10;
    if (!clip || !Number.isFinite(actual) || actual < 1) return;
    const seg = digitalSegmentForClip(clip);
    const previousVideoDuration = Number(clip.videoDuration || 0);
    clip.videoDuration = actual;
    if (seg) {
      seg.videoDuration = actual;
    }
    const narrationDuration = Math.max(0, Number(clip.audioDuration || seg?.audioDuration || 0));
    const availableVideoDuration = Math.max(1, actual - Number(clip.trimIn || 0));
    const availableNarrationDuration = Math.max(1, narrationDuration - Number(clip.trimIn || 0));
    const targetDuration = isDigitalHuman() && narrationDuration > 0
      ? Math.min(availableNarrationDuration, availableVideoDuration)
      : availableVideoDuration;
    const durationChanged = !clip.manualTrim && Math.abs(clipDur(clip) - targetDuration) >= .2;
    if (durationChanged) clip.dur = targetDuration;
    if (!durationChanged && Math.abs(previousVideoDuration - actual) < .05) return;
    // Video metadata is diagnostic only for digital-human clips. The original
    // narration duration remains the timing source and is never overwritten.
    const learnedRealDuration = isDigitalHuman()
      && p.artifacts.subTimingSource === "digital-segment-duration-v2-empty"
      && Math.abs(previousVideoDuration - actual) >= .05;
    if ((durationChanged || learnedRealDuration) && p.artifacts.subTimingSource !== "manual") {
      invalidateDerivedCaptionTiming();
    }
    normalizeCaptionTrack();
    invalidateFinalMix();
    save("productions");
    if (!timelineRedrawFrame) {
      timelineRedrawFrame = requestAnimationFrame(() => {
        timelineRedrawFrame = null;
        if (root.isConnected && !playTimer) drawTimeline();
      });
    }
  }

  async function composeFinal({ automatic = false } = {}) {
    if (p.artifacts.composing || !TL().length) return false;
    const clips = TL().map(c => ({
      url: videoUrlForClip(c), name: c.name || "", dur: c.dur || 15, trimIn: c.trimIn || 0
    })).filter(c => c.url);
    if (!clips.length) return false;
    p.artifacts.composing = true;
    p.artifacts.composingStartedAt = Date.now();
    activeComposes.add(p.id);
    p.artifacts.composeError = "";
    save("productions");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COMPOSE_TIMEOUT_MS);
    try {
      const narrationMedia = await assetMedia(p.artifacts.audio?.assetId);
      const bgmMedia = await assetMedia(p.artifacts.bgm?.assetId);
      const res = await fetch("/api/video/compose", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(remote.getToken() ? { Authorization: `Bearer ${remote.getToken()}` } : {})
        },
        body: JSON.stringify({
          title: p.artifacts.copy?.title || p.title || p.topic || "final",
          clips,
          narrationDataUrl: narrationMedia.dataUrl || "",
          narrationUrl: narrationMedia.url || "",
          bgmDataUrl: bgmMedia.dataUrl || "",
          bgmUrl: bgmMedia.url || "",
          bgmVolume: p.artifacts.bgm?.volume ?? 0.25,
          narrationVolume: p.artifacts.audio?.volume ?? 1,
          preserveClipAudio: isDigitalHuman(),
          transitionDuration: 0,
          subtitleStyle: p.artifacts.subStyle,
          subtitles: SUBS().filter(s => cleanCaptionText(s.text || "")).map(s => ({
            start: Number(s.start || 0), end: Number(s.end || 0), text: cleanCaptionText(s.text || "")
          }))
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.detail || data.error || `合成失败 (${res.status})`);
      p.artifacts.finalVideoUrl = data.url;
      p.artifacts.finalVideoName = data.name || "";
      p.artifacts.finalVideoCaptionSig = captionSignature();
      p.artifacts.finalVideoTimelineSig = timelineSignature();
      p.artifacts.finalVideoMixSig = mixSignature();
      p.artifacts.composeError = "";
      return true;
    } catch (err) {
      p.artifacts.composeError = err?.name === "AbortError"
        ? "合成超过 3 分钟已停止，请重试"
        : (err?.message || "自动合成失败");
      if (!automatic) toast(p.artifacts.composeError, "error");
      return false;
    } finally {
      clearTimeout(timeout);
      p.artifacts.composing = false;
      p.artifacts.composingStartedAt = 0;
      activeComposes.delete(p.id);
      save("productions");
    }
  }

  if (p.artifacts?.boards?.generationMode === "digitalHuman" && (
    state.jobs.some(j => j.productionId === p.id && j.status === "succeeded")
    || (p.artifacts?.boards?.digitalHuman?.segments || []).some(seg => seg.videoOutput)
  )) {
    autoAssemble(p);
  } else if (!TL().length && state.jobs.some(j => j.productionId === p.id && j.status === "succeeded")) {
    autoAssemble(p);
  }
  refreshCaptionAlignment();

  const hist = histories.get(p.id) || histories.set(p.id, []).get(p.id);
  const snapshot = () => {
    hist.push(JSON.stringify({
      timeline: TL(),
      subs: SUBS(),
      subStyle: p.artifacts.subStyle,
      subTimingSource: p.artifacts.subTimingSource || "",
      audioTimingSource: p.artifacts.audioTimingSource || "",
      audioTimingAttemptSig: p.artifacts.audioTimingAttemptSig || "",
      audioTimingRevision: Number(p.artifacts.audioTimingRevision || 0)
    }));
    if (hist.length > 60) hist.shift();
  };
  const undo = () => {
    const last = hist.pop();
    if (!last) { toast("没有可撤回的操作"); return; }
    const d = JSON.parse(last);
    p.artifacts.timeline = d.timeline || [];
    p.artifacts.subs = d.subs || [];
    p.artifacts.subStyle = d.subStyle || p.artifacts.subStyle;
    p.artifacts.subTimingSource = d.subTimingSource || "";
    p.artifacts.audioTimingSource = d.audioTimingSource || "";
    p.artifacts.audioTimingAttemptSig = d.audioTimingAttemptSig || "";
    p.artifacts.audioTimingRevision = Math.max(
      Number(p.artifacts.audioTimingRevision || 0),
      Number(d.audioTimingRevision || 0)
    ) + 1;
    invalidateFinalMix();
    save("productions");
    drawTimeline();
    toast(`已撤回（还可撤 ${hist.length} 步）`);
  };

  root.innerHTML = `
    ${stepperHtml(p, "cut").replace('chain-stepper', 'chain-stepper cut-stepper')}
    <div class="cut-page">
      <div class="cut-top">
        <section class="cut-preview card dark">
          <div class="cp-screen" id="cpScreen">
            <video class="cp-video" id="cpVideo" playsinline preload="metadata"></video>
            <video class="cp-video cp-video-next" id="cpVideoNext" playsinline preload="metadata" muted></video>
            <audio id="cpNarration" src="${esc(narrationPreviewUrl())}" preload="metadata"></audio>
            <audio id="cpBgmAudio" src="${esc(bgmPreviewUrl())}" preload="metadata" loop></audio>
            <div class="cp-frame" id="cpFrame"></div>
            <div class="cp-cliplabel" id="cpClipLabel"></div>
            <button class="cp-play" id="cpPlay">${icon("play", 22)}</button>
            <button class="cp-zoom icon-btn" id="cpZoom" title="放大预览">${icon("zoomIn", 16)}</button>
            <div class="cp-sub" id="cpSub" hidden></div>
          </div>
          <div class="cp-bar"><span id="cpTimecode">00:00 / 00:30</span></div>
        </section>
        <aside class="cut-side">
          <div class="side-card card">
            <h3>${p.artifacts.composing ? "正在合成" : "交付"}</h3>
            ${p.artifacts.composeError ? `<p class="muted">${esc(p.artifacts.composeError)}</p>` : ""}
            <button class="btn primary block button-anthe" id="cutNext"><span>下一步：审核 ${icon("arrowRight", 13)}</span></button>
          </div>
          ${isVideoWorkshop(p) ? `
          <div class="side-card card">
            <h3>${icon("music", 14)} 声音轨</h3>
            <div class="cut-audio-row vol">
              ${icon("mic", 12)} <span>口播</span>
              <input type="range" id="cutNarrationVol" min="0" max="100" step="5" value="${Math.round((p.artifacts.audio?.volume ?? 1) * 100)}" />
              <em id="cutNarrationVolV">${Math.round((p.artifacts.audio?.volume ?? 1) * 100)}%</em>
            </div>
            <div class="cut-audio-row cut-bgm-select">
              ${icon("music", 12)} BGM
              <select class="input sm" id="cutBgm" aria-label="选择 BGM">
                <option value="">无 BGM</option>
                ${audioAssets().length ? `<optgroup label="共享 BGM 库">${audioAssets().map(a => `<option value="asset:${esc(a.id)}" ${p.artifacts.bgm?.assetId === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</optgroup>` : ""}
              </select>
            </div>
            <div class="cut-bgm-drop" id="cutBgmDrop">${icon("upload", 12)} 拖拽 / 上传 BGM<input type="file" id="cutBgmUp" accept="audio/*" hidden /></div>
            <div class="cut-audio-row vol">
              <span>BGM 音量</span>
              <input type="range" id="cutBgmVol" min="5" max="60" step="5" value="${Math.round((p.artifacts.bgm?.volume ?? 0.25) * 100)}" />
              <em id="cutBgmVolV">${Math.round((p.artifacts.bgm?.volume ?? 0.25) * 100)}%</em>
            </div>
            <button class="btn ghost block" id="tlFillSubs" title="数字人按分段口播原文与实测时长对齐；信息流仅在手动点击后按提示词时间段匹配">${icon("type", 13)} ${digitalCaptionMode ? "生成字幕" : "匹配字幕"}</button>
          </div>` : ""}
        </aside>
      </div>

      <div class="tl-editor card">
        <div class="tl-toolbar">
          <div class="tlt-left">
            <b>时间轴</b>
            <em class="muted" id="tlMeta"></em>
          </div>
          <div class="tlt-actions">
            <button class="icon-btn sm tl-text-btn" id="tlAddSub" title="增加文字">T</button>
            <button class="icon-btn sm" id="tlSplit" title="在播放头处分割选中片段">${icon("split", 13)}</button>
            <button class="icon-btn sm" id="tlSubSplit" title="在播放头处分割字幕">${icon("scissors", 13)}</button>
            <button class="icon-btn sm" id="tlSubCopy" title="复制字幕">${icon("copy", 13)}</button>
            <button class="icon-btn sm" id="tlSrt" title="导出 SRT">${icon("download", 13)}</button>
            <button class="icon-btn sm" id="tlUndo" title="撤回">${icon("undo", 13)}</button>
            <span class="tl-zoom">
              <button class="icon-btn sm" id="tlZoomOut">${icon("zoomOut", 13)}</button>
              <button class="icon-btn sm" id="tlZoomIn">${icon("zoomIn", 13)}</button>
            </span>
          </div>
        </div>
        <div class="tl-scroll" id="tlScroll">
          <div class="tl-inner" id="tlInner">
            <div class="tl-playhead" id="tlPlayhead"><i></i></div>
            <div class="tl-row"><div class="tl-label"></div><div class="tl-body tl-ruler" id="tlRuler"></div></div>
            <div class="tl-row"><div class="tl-label">${icon("type", 12)} 字幕</div><div class="tl-body tl-subtrack" id="tlSubTrack"></div></div>
            <div class="tl-row"><div class="tl-label">${icon("film", 12)} 视频</div><div class="tl-body tl-cliptrack" id="tlClipTrack"></div></div>
          </div>
        </div>
        <div id="tlSubEditor" class="tl-sub-editor"></div>
      </div>
    </div>`;

  wireStepper(root);

  /* ---------- 渲染 ---------- */
  function drawTimeline() {
    const total = totalDur(), W = total * PPS;
    $("#tlMeta", root).textContent = TL().length
      ? `${TL().length} 段 · ${Math.round(clipsTotal())}s`
      : "等待已生成视频";
    const ruler = $("#tlRuler", root);
    ruler.style.width = W + "px";
    const step = PPS >= 28 ? 5 : 10;
    let ticks = "";
    for (let t = 0; t <= total; t += step) ticks += `<span class="tl-tick" style="left:${t * PPS}px">${t}s</span>`;
    ruler.innerHTML = ticks;

    const ct = $("#tlClipTrack", root); ct.style.width = W + "px";
    ct.innerHTML = TL().length ? TL().map((c, i) => `
      <div class="tl-clip ${c.id === selectedClipId ? "is-selected" : ""}" draggable="true" data-id="${c.id}" style="left:${clipStart(i) * PPS}px;width:${clipDur(c) * PPS - 4}px;--g:${gradFor(c.name)}">
        ${videoUrlForClip(c) ? `<video class="tl-clip-preview" data-id="${esc(c.id)}" src="${esc(videoUrlForClip(c))}" muted playsinline preload="none"></video>` : ""}
        <span class="tl-trim l" data-trim="l" data-id="${c.id}" title="向右拖：裁掉开头"></span>
        <span class="tl-clip-name">${esc(c.name)}</span>
        <span class="tl-clip-dur">${clipDur(c)}s${c.trimIn ? ` · 裁头${c.trimIn}s` : ""}</span>
        <span class="tl-trim r" data-trim="r" data-id="${c.id}" title="向左拖：裁掉结尾"></span>
      </div>`).join("") : `<div class="tl-empty">生成完成的片段会自动加入时间轴</div>`;

    const stk = $("#tlSubTrack", root); stk.style.width = W + "px";
    stk.innerHTML = SUBS().map((s, i) => {
      const cueWidth = Math.max(6, ((s.end || 0) - (s.start || 0)) * PPS - 2);
      return `
      <div class="tl-sub ${cueWidth < 28 ? "is-compact" : ""} ${i === activeSubIdx ? "is-active" : ""}" data-i="${i}" style="left:${(s.start || 0) * PPS}px;width:${cueWidth}px">
        <span class="tl-sub-text">${esc(cleanCaptionText(s.text || "字幕"))}</span>
        <span class="tl-sub-resize left" data-i="${i}" data-side="left" title="拖动字幕开始时间"></span>
        <span class="tl-sub-resize right" data-i="${i}" data-side="right" title="拖动字幕结束时间"></span>
      </div>`;
    }).join("");

    $$(".tl-clip-preview", root).forEach(video => video.addEventListener("loadedmetadata", () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      try { video.currentTime = Math.min(.35, Math.max(0, video.duration - .05)); } catch {}
      syncClipDurationFromMedia(video.dataset.id, video.duration);
    }, { once: true }));
    wireClips(); wireSubs();
    drawSubEditor(); updatePlayhead();
  }

  function updatePlayhead() {
    const ph = $("#tlPlayhead", root); if (!ph) return;
    playheadT = clamp(playheadT, 0, totalDur());
    ph.style.left = (52 + playheadT * PPS) + "px";
    $("#cpTimecode", root).textContent = `${fmtTC(playheadT)} / ${fmtTC(totalDur())}`;
    let label = "", grad = "", clip = null, clipBase = 0, clipIndex = -1;
    let acc2 = 0;
    for (let index = 0; index < TL().length; index++) {
      const c = TL()[index];
      if (playheadT < acc2 + clipDur(c)) {
        label = c.name;
        grad = gradFor(c.name);
        clip = c;
        clipBase = acc2;
        clipIndex = index;
        break;
      }
      acc2 += clipDur(c);
    }
    $("#cpClipLabel", root).textContent = label;
    const video = $("#cpVideo", root);
    const videoUrl = videoUrlForClip(clip);
    if (videoUrl) {
      const localTime = Math.max(0, playheadT - clipBase + (clip?.trimIn || 0));
      if (video.dataset.src !== videoUrl) {
        video.dataset.src = videoUrl;
        video.src = videoUrl;
        video.addEventListener("loadedmetadata", () => {
          if (Number.isFinite(video.duration)) video.currentTime = Math.min(localTime, Math.max(0, video.duration - 0.1));
          if (playTimer) video.play().catch(() => null);
        }, { once: true });
      } else if (!video.seeking && Math.abs((video.currentTime || 0) - localTime) > 1.1) {
        video.currentTime = Math.min(localTime, Math.max(0, (video.duration || localTime + 1) - 0.1));
      }
      video.hidden = false;
      $("#cpFrame", root).style.opacity = "0";
    } else {
      video.pause();
      video.removeAttribute("src");
      delete video.dataset.src;
      video.load();
      video.hidden = true;
      $("#cpFrame", root).style.opacity = ".85";
    }
    const nextVideo = $("#cpVideoNext", root);
    const nextClip = clipIndex >= 0 ? TL()[clipIndex + 1] : null;
    const transition = 0;
    const remaining = clip ? clipBase + clipDur(clip) - playheadT : Infinity;
    const nextUrl = videoUrlForClip(nextClip);
    if (nextVideo && transition > 0 && nextUrl && remaining <= transition && remaining >= 0) {
      const transitionProgress = clamp((transition - remaining) / transition, 0, 1);
      const nextLocalTime = Math.max(0, transitionProgress * transition + (nextClip?.trimIn || 0));
      if (nextVideo.dataset.src !== nextUrl) {
        nextVideo.dataset.src = nextUrl;
        nextVideo.src = nextUrl;
        nextVideo.addEventListener("loadedmetadata", () => {
          if (Number.isFinite(nextVideo.duration)) nextVideo.currentTime = Math.min(nextLocalTime, Math.max(0, nextVideo.duration - 0.1));
          if (playTimer) nextVideo.play().catch(() => null);
        }, { once: true });
      } else if (!nextVideo.seeking && Math.abs((nextVideo.currentTime || 0) - nextLocalTime) > .45) {
        nextVideo.currentTime = Math.min(nextLocalTime, Math.max(0, (nextVideo.duration || nextLocalTime + 1) - 0.1));
      }
      nextVideo.style.opacity = String(transitionProgress);
      nextVideo.hidden = false;
      if (playTimer && nextVideo.paused) nextVideo.play().catch(() => null);
    } else if (nextVideo) {
      nextVideo.style.opacity = "0";
      nextVideo.pause();
      nextVideo.hidden = true;
    }
    $("#cpFrame", root).style.background = grad || "linear-gradient(135deg,#1a2540,#0c1322)";
    const sub = SUBS().find(s => playheadT >= (s.start || 0) && playheadT < (s.end || 0));
    const el = $("#cpSub", root);
    if (sub && (sub.text || "").trim()) { el.hidden = false; el.textContent = cleanCaptionText(sub.text); }
    else el.hidden = true;
    applySubStyle();
    syncPreviewAudio(!!playTimer);
  }
  function applySubStyle() {
    const el = $("#cpSub", root); if (!el) return;
    const st = p.artifacts.subStyle;
    el.style.fontSize = st.size + "px";
    el.style.bottom = st.bottom + "%";
    el.style.webkitTextStroke = st.stroke ? `${st.stroke}px rgba(0,0,0,.85)` : "";
    el.style.paintOrder = "stroke fill";
  }
  function syncPreviewAudio(shouldPlay = false) {
    const narration = $("#cpNarration", root);
    const bgm = $("#cpBgmAudio", root);
    const setAudioSrc = (audio, src) => {
      if (!audio) return;
      const next = src || "";
      if ((audio.getAttribute("src") || "") === next) return;
      const wasPlaying = !audio.paused;
      audio.setAttribute("src", next);
      audio.load();
      if (shouldPlay || wasPlaying) audio.play().catch(() => null);
    };
    setAudioSrc(narration, narrationPreviewUrl());
    setAudioSrc(bgm, bgmPreviewUrl());
    const syncOne = (audio, t, volume = 1) => {
      if (!audio || !audio.getAttribute("src")) return;
      audio.volume = clamp(volume, 0, 1);
      const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const target = dur ? Math.min(Math.max(0, t), Math.max(0, dur - 0.05)) : Math.max(0, t);
      if (!audio.seeking && Math.abs((audio.currentTime || 0) - target) > 0.9) {
        try { audio.currentTime = target; } catch {}
      }
      if (shouldPlay && audio.paused) audio.play().catch(() => null);
    };
    syncOne(narration, playheadT, p.artifacts.audio?.volume ?? 1);
    const bgmDur = Number.isFinite(bgm?.duration) && bgm.duration > 0 ? bgm.duration : 0;
    syncOne(bgm, bgmDur ? playheadT % bgmDur : playheadT, p.artifacts.bgm?.volume ?? 0.25);
  }
  const stopPlay = () => {
    const video = $("#cpVideo", root);
    if (video) video.pause();
    $("#cpVideoNext", root)?.pause();
    $("#cpNarration", root)?.pause();
    $("#cpBgmAudio", root)?.pause();
    if (playTimer) cancelAnimationFrame(playTimer);
    playTimer = null;
    const playButton = $("#cpPlay", root);
    if (playButton) playButton.innerHTML = icon("play", 22);
  };
  root.__cutStopPlay = stopPlay;
  const togglePlay = () => {
    if (playTimer) { stopPlay(); return; }
    if (!TL().length && !SUBS().length) { toast("时间轴还是空的"); return; }
    if (playheadT >= totalDur() - 0.05) playheadT = 0;
    const video = $("#cpVideo", root);
    if (video && !video.hidden && video.src) video.play().catch(() => null);
    const nextVideo = $("#cpVideoNext", root);
    if (nextVideo && !nextVideo.hidden && nextVideo.src) nextVideo.play().catch(() => null);
    syncPreviewAudio(true);
    $("#cpPlay", root).innerHTML = icon("pause", 22);
    playStartedAt = performance.now();
    playStartedT = playheadT;
    const tick = now => {
      if (!playTimer) return;
      playheadT = playStartedT + Math.max(0, now - playStartedAt) / 1000;
      if (playheadT >= totalDur()) {
        playheadT = totalDur();
        updatePlayhead();
        stopPlay();
        return;
      }
      updatePlayhead();
      playTimer = requestAnimationFrame(tick);
    };
    playTimer = requestAnimationFrame(tick);
  };

  /* ---------- 片段轨交互 ---------- */
  function wireClips() {
    let dragId = null;
    $$(".tl-clip", root).forEach(el => {
      el.addEventListener("click", e => {
        if (e.target.closest(".tl-trim")) return;
        selectedClipId = selectedClipId === el.dataset.id ? null : el.dataset.id;
        activeTrack = selectedClipId ? "clip" : "";
        drawTimeline();
      });
      el.addEventListener("dragstart", () => { dragId = el.dataset.id; el.classList.add("dragging"); });
      el.addEventListener("dragend", () => el.classList.remove("dragging"));
    });
    $$(".tl-trim", root).forEach(h => {
      h.addEventListener("pointerdown", e => {
        e.stopPropagation(); e.preventDefault();
        const c = TL().find(x => x.id === h.dataset.id); if (!c) return;
        const side = h.dataset.trim, startX = e.clientX, origDur = clipDur(c), origIn = c.trimIn || 0;
        const sourceDuration = Math.max(origIn + origDur, Number(c.videoDuration || 0), Number(c.audioDuration || 0));
        snapshot();
        h.setPointerCapture(e.pointerId);
        const el = h.closest(".tl-clip");
        el.draggable = false; el.classList.add("trimming");
        const move = ev => {
          const ds = (ev.clientX - startX) / PPS;
          if (side === "r") c.dur = Math.round(Math.max(2, Math.min(sourceDuration - origIn, origDur + ds)) * 2) / 2;
          else {
            const nd = Math.round(Math.max(2, Math.min(origDur + origIn, origDur - ds)) * 2) / 2;
            c.trimIn = Math.round((origIn + (origDur - nd)) * 2) / 2;
            c.dur = nd;
          }
          el.style.width = (clipDur(c) * PPS - 4) + "px";
          el.querySelector(".tl-clip-dur").textContent = `${clipDur(c)}s${c.trimIn ? ` · 裁头${c.trimIn}s` : ""}`;
        };
        const up = () => {
          h.removeEventListener("pointermove", move);
          h.removeEventListener("pointerup", up);
          const changed = Math.abs(clipDur(c) - origDur) >= .05 || Math.abs(Number(c.trimIn || 0) - origIn) >= .05;
          if (changed) {
            c.manualTrim = true;
            invalidateDerivedCaptionTiming();
            normalizeCaptionTrack();
          }
          save("productions");
          drawTimeline();
        };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
      });
    });
    const ct = $("#tlClipTrack", root);
    ct.addEventListener("dragover", e => e.preventDefault());
    ct.addEventListener("drop", e => {
      e.preventDefault(); if (!dragId) return;
      const rect = ct.getBoundingClientRect();
      const x = e.clientX - rect.left;
      let to = TL().length - 1;
      for (let i = 0; i < TL().length; i++) { if (x < (clipStart(i) + clipDur(TL()[i]) / 2) * PPS) { to = Math.max(0, i); break; } }
      const from = TL().findIndex(c => c.id === dragId);
      if (from < 0) return;
      snapshot();
      const [m] = TL().splice(from, 1); TL().splice(to, 0, m); dragId = null;
      invalidateDerivedCaptionTiming();
      normalizeCaptionTrack();
      save("productions"); drawTimeline();
    });
  }

  /* ---------- 字幕轨交互 ---------- */
  function wireSubs() {
    $$(".tl-sub-resize", root).forEach(h => {
      h.addEventListener("pointerdown", e => {
        e.stopPropagation(); e.preventDefault();
        const i = +h.dataset.i; const s = SUBS()[i]; if (!s) return;
        const side = h.dataset.side || "right";
        const startX = e.clientX, origStart = s.start || 0, origEnd = s.end || 0;
        let snapped = false;
        h.setPointerCapture(e.pointerId);
        const el = h.closest(".tl-sub");
        const move = ev => {
          if (!snapped) { snapshot(); snapped = true; }
          const delta = (ev.clientX - startX) / PPS;
          if (side === "left") {
            const prev = SUBS()[i - 1];
            const lower = prev ? (prev.end || 0) + .1 : 0;
            s.start = Math.min(origEnd - .5, Math.max(lower, Math.round((origStart + delta) * 2) / 2));
          } else {
            const next = SUBS()[i + 1];
            const upper = next ? Math.max((s.start || 0) + .5, (next.start || 0) - .1) : Infinity;
            s.end = Math.min(upper, Math.max((s.start || 0) + 0.5, Math.round((origEnd + delta) * 2) / 2));
          }
          el.style.left = (s.start * PPS) + "px";
          el.style.width = Math.max(24, (s.end - (s.start || 0)) * PPS - 2) + "px";
        };
        const up = () => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); markCaptionTimingManual(); normalizeCaptionTrack(); save("productions"); drawTimeline(); };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
      });
    });
    $$(".tl-sub", root).forEach(el => {
      const i = +el.dataset.i;
      let startX = 0, origStart = 0, moved = false;
      el.addEventListener("pointerdown", e => {
        if (e.target.classList.contains("tl-sub-resize")) return;
        el.setPointerCapture(e.pointerId); startX = e.clientX; origStart = SUBS()[i].start || 0; moved = false;
        activeSubIdx = i;
        activeTrack = "sub";
        $$(".tl-sub", root).forEach(x => x.classList.toggle("is-active", +x.dataset.i === i));
        drawSubEditor(); updatePlayhead();
      });
      el.addEventListener("pointermove", e => {
        if (!el.hasPointerCapture(e.pointerId)) return;
        const dx = e.clientX - startX; if (Math.abs(dx) < 3) return;
        if (!moved) { snapshot(); moved = true; }
        const s = SUBS()[i]; const dur = (s.end || 0) - (s.start || 0);
        const prev = SUBS()[i - 1], next = SUBS()[i + 1];
        const lower = prev ? (prev.end || 0) + .1 : 0;
        const upper = next ? Math.max(lower, (next.start || 0) - dur - .1) : Infinity;
        const ns = Math.min(upper, Math.max(lower, Math.round((origStart + dx / PPS) * 2) / 2));
        s.start = ns; s.end = ns + dur;
        el.style.left = (ns * PPS) + "px";
      });
      el.addEventListener("pointerup", () => { if (moved) { markCaptionTimingManual(); normalizeCaptionTrack(); save("productions"); drawTimeline(); } });
    });
  }

  function drawSubEditor() {
    const box = $("#tlSubEditor", root); if (!box) return;
    const subs = SUBS();
    if (!subs.length) { box.innerHTML = `<div class="muted" style="padding:8px 2px">按 T 从已绑定口播生成字幕，或用 + 新增字幕。</div>`; return; }
    const i = Math.min(activeSubIdx, subs.length - 1); const s = subs[i];
    const st = p.artifacts.subStyle;
    box.innerHTML = `
      <div class="tse-row">
        <b>第 ${i + 1} 条字幕</b>
        <input class="input num" id="tseStart" type="number" min="0" step="0.5" value="${s.start}" /> →
        <input class="input num" id="tseEnd" type="number" min="0" step="0.5" value="${s.end}" /> 秒
        <textarea class="input grow" id="tseText" rows="1" placeholder="字幕文字，可换行">${esc(s.text || "")}</textarea>
        <button class="btn ghost sm" id="tseSplitBefore" title="保留播放头后的字幕">删前段</button>
        <button class="btn ghost sm" id="tseSplitAfter" title="保留播放头前的字幕">删后段</button>
        <button class="icon-btn sm" id="tseDelete" title="删除当前字幕">${icon("trash", 13)}</button>
      </div>
      <div class="tse-row style">
        <span>字号</span><input type="range" id="tseSize" min="10" max="26" step="1" value="${st.size}" /><em id="tseSizeV">${st.size}px</em>
        <span>描边</span><input type="range" id="tseStroke" min="0" max="5" step="0.5" value="${st.stroke}" /><em id="tseStrokeV">${st.stroke}px</em>
        <span>垂直位置</span><input type="range" id="tseBottom" min="4" max="80" step="1" value="${st.bottom}" /><em id="tseBottomV">距底 ${st.bottom}%</em>
      </div>`;
    let edited = false;
    const snapOnce = () => { if (!edited) { snapshot(); edited = true; } };
    $("#tseStart", root).addEventListener("input", e => { snapOnce(); s.start = parseFloat(e.target.value) || 0; markCaptionTimingManual(); normalizeCaptionTrack(); save("productions"); drawTimeline(); });
    $("#tseEnd", root).addEventListener("input", e => { snapOnce(); s.end = parseFloat(e.target.value) || 0; markCaptionTimingManual(); normalizeCaptionTrack(); save("productions"); drawTimeline(); });
    $("#tseText", root).addEventListener("input", e => {
      snapOnce();
      s.text = e.target.value;
      markCaptionTimingManual();
      save("productions");
      const blk = $$(".tl-sub", root)[i];
      if (blk) blk.querySelector(".tl-sub-text").textContent = cleanCaptionText(e.target.value || "字幕");
      updatePlayhead();
    });
    $("#tseSplitBefore", root).addEventListener("click", () => splitSubtitle({ keep: "right" }));
    $("#tseSplitAfter", root).addEventListener("click", () => splitSubtitle({ keep: "left" }));
    $("#tseDelete", root).addEventListener("click", () => {
      snapshot();
      SUBS().splice(i, 1);
      activeSubIdx = Math.max(0, Math.min(i, SUBS().length - 1));
      activeTrack = "";
      markCaptionTimingManual();
      save("productions");
      drawTimeline();
      toast("已删除字幕，可用撤回恢复");
    });
    const wireStyle = (id, valId, key, fmt) => {
      $(id, root).addEventListener("input", e => {
        snapOnce(); p.artifacts.subStyle[key] = parseFloat(e.target.value);
        p.artifacts.subStyleUserEdited = true;
        p.artifacts.subStyleDefaultVersion = 3;
        $(valId, root).textContent = fmt(p.artifacts.subStyle[key]);
        save("productions"); applySubStyle(); updatePlayhead();
      });
    };
    wireStyle("#tseSize", "#tseSizeV", "size", v => v + "px");
    wireStyle("#tseStroke", "#tseStrokeV", "stroke", v => v + "px");
    wireStyle("#tseBottom", "#tseBottomV", "bottom", v => "距底 " + v + "%");
  }

  /* ---------- 工具栏 ---------- */
  const bgmSel = $("#cutBgm", root);
  if (bgmSel) bgmSel.addEventListener("change", e => {
    const name = e.target.value;
    if (!name) { p.artifacts.bgm = null; }
    else if (name.startsWith("asset:")) {
      const id = name.slice(6);
      const a = state.assets.find(x => x.id === id);
      p.artifacts.bgm = { name: a?.name || "上传 BGM", assetId: id, mood: "自定义", volume: p.artifacts.bgm?.volume ?? 0.25, auto: false };
    }
    else { p.artifacts.bgm = null; }
    invalidateFinalMix();
    save("productions");
    toast(name ? `BGM 已换为「${p.artifacts.bgm?.name || name}」` : "已移除 BGM");
  });
  const addBgmFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("audio/")) { toast("BGM 只支持音频文件", "error"); return; }
    const a = await addAssetFromFile(null, file, { tags: ["BGM", "音乐库"], name: file.name.replace(/\.[^.]+$/, "") });
    p.artifacts.bgm = { name: a.name, assetId: a.id, mood: "自定义", volume: p.artifacts.bgm?.volume ?? 0.25, auto: false };
    invalidateFinalMix();
    save("productions", "assets", "meta");
    toast(`已加入 BGM 库：${a.name}`);
    renderCutPage(root, p);
  };
  const bgmDrop = $("#cutBgmDrop", root);
  if (bgmDrop) {
    wireDropZone(bgmDrop, files => addBgmFile(Array.from(files || [])[0]), { filesOnly: true });
    bgmDrop.addEventListener("click", () => $("#cutBgmUp", root)?.click());
  }
  $("#cutBgmUp", root)?.addEventListener("change", e => addBgmFile(e.target.files?.[0]));
  const bgmVol = $("#cutBgmVol", root);
  if (bgmVol) bgmVol.addEventListener("input", e => {
    if (!p.artifacts.bgm?.assetId) { toast("请先上传或选择一条 BGM", "error"); return; }
    p.artifacts.bgm.volume = (+e.target.value) / 100;
    $("#cutBgmVolV", root).textContent = e.target.value + "%";
    invalidateFinalMix();
    save("productions");
  });
  $("#cutNarrationVol", root)?.addEventListener("input", e => {
    p.artifacts.audio = p.artifacts.audio || {};
    p.artifacts.audio.volume = (+e.target.value) / 100;
    $("#cutNarrationVolV", root).textContent = e.target.value + "%";
    invalidateFinalMix();
    syncPreviewAudio(!!playTimer);
    save("productions");
  });
  $("#tlFillSubs", root).addEventListener("click", async () => {
    if (p.artifacts.subTimingSource === "manual") {
      toast("已保留手工编辑字幕，自动生成不会覆盖");
      return;
    }
    snapshot();
    const button = $("#tlFillSubs", root);
    button.disabled = true;
    button.innerHTML = `${icon("refresh", 13)} ${isDigitalHuman() ? "生成中…" : "匹配中…"}`;
    const aligned = await alignCaptionsToAudio({ force: true, manualTrigger: true });
    button.disabled = false;
    button.innerHTML = `${icon("type", 13)} ${isDigitalHuman() ? "生成字幕" : "匹配字幕"}`;
    if (aligned) return;
  });
  $("#tlAddSub", root).addEventListener("click", () => {
    snapshot();
    const subs = SUBS();
    const videoEnd = totalDur();
    const st = clamp(Math.round(playheadT * 10) / 10, 0, Math.max(0, videoEnd - .25));
    subs.push({ start: st, end: Math.min(videoEnd, st + 2.5), text: "" });
    markCaptionTimingManual();
    normalizeCaptionTrack(subs);
    activeSubIdx = Math.max(0, subs.findIndex(s => Math.abs(Number(s.start || 0) - st) < .06));
    activeTrack = "sub";
    save("productions"); drawTimeline();
  });
  $("#tlSubSplit", root).addEventListener("click", () => splitSubtitle());
  $("#tlSubCopy", root).addEventListener("click", () => copySubtitle());
  $("#tlSplit", root).addEventListener("click", () => {
    const c = TL().find(x => x.id === selectedClipId);
    if (!c) { toast("先点选一个片段，再把播放头拖到分割点"); return; }
    const i = TL().indexOf(c);
    const start = clipStart(i);
    const at = playheadT - start;
    if (at <= 0.5 || at >= clipDur(c) - 0.5) { toast("播放头要落在片段中间才能分割"); return; }
    snapshot();
    const d1 = Math.round(at * 2) / 2;
    const c2 = {
      id: Math.random().toString(36).slice(2, 10), jobId: c.jobId, segmentId: c.segmentId || "",
      audioAssetId: c.audioAssetId || "",
      audioDuration: Number(c.audioDuration || 0),
      videoDuration: Number(c.videoDuration || 0),
      videoUrl: c.videoUrl || "",
      name: c.name + " ·切",
      dur: clipDur(c) - d1,
      trimIn: (c.trimIn || 0) + d1,
      manualTrim: true
    };
    c.dur = d1;
    c.manualTrim = true;
    TL().splice(i + 1, 0, c2);
    invalidateDerivedCaptionTiming();
    normalizeCaptionTrack();
    save("productions"); drawTimeline();
    toast("已在播放头处分割");
  });
  $("#tlSrt", root).addEventListener("click", () => {
    const srt = buildSRT(SUBS());
    if (!srt) { toast("还没有字幕"); return; }
    downloadBlob(buildDeliveryName(acc, (acc.exportSeq || 0) + 1) + ".srt", new Blob([srt], { type: "text/plain" }));
    toast("已下载 .srt");
  });
  $("#tlUndo", root).addEventListener("click", undo);
  $("#tlZoomIn", root).addEventListener("click", () => { PPS = Math.min(100, Math.round(PPS * 1.3)); drawTimeline(); });
  $("#tlZoomOut", root).addEventListener("click", () => { PPS = Math.max(14, Math.round(PPS / 1.3)); drawTimeline(); });
  $("#cpPlay", root).addEventListener("click", togglePlay);
  $("#cpZoom", root).addEventListener("click", () => {
    let elapsed = 0, clip = null;
    for (const item of TL()) {
      if (playheadT < elapsed + clipDur(item)) { clip = item; break; }
      elapsed += clipDur(item);
    }
    const src = videoUrlForClip(clip);
    if (!src) { toast("当前播放头还没有可预览的视频"); return; }
    openVideoPreview(src, clip?.name || "片段预览");
  });
  $("#tlRuler", root).addEventListener("pointerdown", e => {
    const rect = $("#tlRuler", root).getBoundingClientRect();
    stopPlay(); playheadT = (e.clientX - rect.left) / PPS; updatePlayhead();
  });
  $("#tlPlayhead", root).addEventListener("pointerdown", e => {
    e.preventDefault(); stopPlay();
    const ph = $("#tlPlayhead", root);
    ph.setPointerCapture(e.pointerId);
    const move = ev => {
      const rect = $("#tlRuler", root).getBoundingClientRect();
      playheadT = (ev.clientX - rect.left) / PPS; updatePlayhead();
    };
    const up = () => { ph.removeEventListener("pointermove", move); ph.removeEventListener("pointerup", up); };
    ph.addEventListener("pointermove", move);
    ph.addEventListener("pointerup", up);
  });
  // 预览字幕拖动调位置
  const cpSub = $("#cpSub", root);
  cpSub.addEventListener("pointerdown", e => {
    e.preventDefault(); snapshot();
    cpSub.setPointerCapture(e.pointerId);
    const screen = $("#cpScreen", root);
    const move = ev => {
      const rect = screen.getBoundingClientRect();
      const pct = Math.round((rect.bottom - ev.clientY) / rect.height * 100);
      p.artifacts.subStyle.bottom = clamp(pct, 4, 80);
      applySubStyle();
      const r = $("#tseBottom", root); if (r) { r.value = p.artifacts.subStyle.bottom; $("#tseBottomV", root).textContent = "距底 " + p.artifacts.subStyle.bottom + "%"; }
    };
    const up = () => { cpSub.removeEventListener("pointermove", move); cpSub.removeEventListener("pointerup", up); save("productions"); };
    cpSub.addEventListener("pointermove", move);
    cpSub.addEventListener("pointerup", up);
  });
  // 键盘剪辑：Delete 删除；⌘Z 撤回；字幕支持 ⌘C / ⌘X / ⌘V。
  const keyHandler = e => {
    if (document.body.dataset.zone !== "studio" || !root.isConnected) return;
    const tag = (document.activeElement || {}).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement || {}).isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault(); undo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && activeTrack === "sub") {
      const key = e.key.toLowerCase();
      if (key === "c") { e.preventDefault(); copySubtitle(); return; }
      if (key === "x") { e.preventDefault(); copySubtitle({ cut: true }); return; }
      if (key === "v") { e.preventDefault(); pasteSubtitle(); return; }
    }
    if ((e.key === "Delete" || e.key === "Backspace") && activeTrack) {
      e.preventDefault();
      snapshot();
      if (activeTrack === "clip" && selectedClipId) {
        p.artifacts.timeline = TL().filter(clip => clip.id !== selectedClipId);
        selectedClipId = null;
        invalidateDerivedCaptionTiming();
        normalizeCaptionTrack();
      } else if (activeTrack === "sub" && SUBS()[activeSubIdx]) {
        SUBS().splice(activeSubIdx, 1);
        activeSubIdx = Math.max(0, Math.min(activeSubIdx, SUBS().length - 1));
        markCaptionTimingManual();
      }
      activeTrack = "";
      save("productions"); drawTimeline();
    }
  };
  if (root.__cutKeyHandler) document.removeEventListener("keydown", root.__cutKeyHandler);
  root.__cutKeyHandler = keyHandler;
  document.addEventListener("keydown", keyHandler);
  window.addEventListener("view:rendered", function off() {
    if (!root.isConnected) {
      document.removeEventListener("keydown", keyHandler);
      if (root.__cutKeyHandler === keyHandler) delete root.__cutKeyHandler;
      window.removeEventListener("view:rendered", off);
    }
  });

  $("#cutNext", root).addEventListener("click", async event => {
    const nextButton = event.currentTarget;
    const resetNextButton = () => {
      nextButton.disabled = false;
      nextButton.innerHTML = `<span>下一步：审核 ${icon("arrowRight", 13)}</span>`;
    };
    if (!TL().length) { toast("时间轴为空：请先等待视频片段生成完成"); return; }
    if (p.artifacts.composing) { toast("正在自动合成成片，请稍候"); return; }
    const pendingVideoJobs = state.jobs.some(job => job.productionId === p.id
      && job.kind === "video"
      && ["queued", "submitted", "running"].includes(job.status));
    if (pendingVideoJobs) { toast("仍有视频片段生成中，全部就绪后再合成成片"); return; }
    if (!protectedCaptionTiming()) {
      await alignCaptionsToAudio({ silent: true });
    }
    if (needsCompose()) {
      nextButton.disabled = true;
      nextButton.innerHTML = `<span class="spin-dot"></span> 正在合成成片`;
      const composed = await composeFinal({ automatic: false });
      if (!composed) {
        resetNextButton();
        toast(p.artifacts.composeError || "成片合成失败，请重试", "error");
        return;
      }
    }
    if (p.mode === "视频" && !p.artifacts?.boards?.cover?.assetId) {
      toast("未检测到封面，正在自动生成");
      try {
        const { ensureVideoCover } = await import("./chainWorkshop.js?v=20260723-v117-8");
        await ensureVideoCover(p);
        toast("封面已自动生成并入库");
      } catch (err) {
        toast("封面自动生成失败：" + (err?.message || err), "error");
        resetNextButton();
        return;
      }
    }
    if (p.stage === "cut" || p.stage === "render" || p.stage === "copy") setStage(p, "review", "pending");
    go("studio", "review");
  });

  drawTimeline();
  const timingSource = p.artifacts.subTimingSource || "";
  if (timingSource !== "manual" && TL().some(c => videoUrlForClip(c)) && !p.artifacts.audioTimingPending) {
    if (!protectedCaptionTiming()) {
      queueMicrotask(() => alignCaptionsToAudio({ silent: true }));
    }
  }
}
