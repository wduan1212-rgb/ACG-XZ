/* 链路 · 视频制作（数字人 / 信息流共用一体节点）：
   按场景合并的「分镜单元」——一个单元 = 一条 10-15s 多镜头视频片段
   含产品 logo / 产品界面 → 【全能参考】：自动附上固定的 logo + 界面图作参考（替代旧的图生视频）
   纯场景 → 【文生视频】：直接文生视频，不带参考
   顶部「全能参考素材」(logo / 界面图，所有全能参考单元共用) + 口播音频上传 + 一键复制所有口播 */

import { $, $$, esc, gradFor, copyText, fileToDataUrl, wireDropZone, fmtTC, uid } from "../core/util.js";
import { sanitizeXhsText } from "../core/xhsGuard.js";
import { icon } from "../ui/icons.js";
import { state, save, persistNow, on, accountById, productById, primaryProductById, primaryProducts } from "../core/store.js";
import { AI } from "../api/ai.js?v=20260724-v117-21";
import { activeProviderFor, defaultTtsVoiceId, findKnownTtsVoice, imageApiConfigured, lookupTtsVoice, providerKeyFor, synthesizeTts, ttsApiConfigured, ttsVoicePresets } from "../api/providers.js";
import { estimateAudio, setStage, setStatus, jobsOf, rebindUnitClip, autoAssemble, buildMaterialUnits, materialUnits, unitShots, isMaterial, enforceSupportedVideoMode } from "../domain/productions.js";
import { urlFor, addAssetFromDataUrl, addAssetFromFile, removeAsset, thumbHtml } from "../domain/assets.js";
import { polishImageForPublish as polishPublishImage } from "../domain/imagePolish.js";
import { createUnitVideoJobs } from "../agent/orchestrator.js?v=20260724-v117-21";
import { toast, withLoading, openLightbox } from "../ui/components.js?v=20260724-v117-21";
import { go, currentRoute } from "../core/router.js";
import * as remote from "../core/remote.js";
import { stepperHtml, wireStepper } from "./studio.js?v=20260724-v117-21";
import { productionAssets as accAssets } from "../domain/accounts.js";
import { favoriteVoiceIds as sharedFavoriteVoiceIds, setFavoriteVoice, voicePickerGroups } from "../domain/voices.js";
import {
  DIGITAL_HUMAN_FIXED_PROMPT,
  DIGITAL_SEGMENT_MAX_SEC,
  DIGITAL_SEGMENT_TARGET_SEC,
  planDigitalNarrationSegments,
  planDigitalSegmentGroups
} from "../domain/digitalHuman.js";

let liveRoot = null, liveProd = null, liveDraw = null, wired = false;
const liveJobUiSignatures = new Map();
const COVER_LOADING_TIMEOUT_MS = 8 * 60 * 1000;
const COVER_GENERATE_TIMEOUT_MS = 140000;
const COVER_NEGATIVE_PROMPT = "负面约束：不出现二维码，不出现过多小字。";
const VIDEO_NEGATIVE_PROMPT = "负面约束：无字幕，不生成花字，不生成水印，不生成二维码。";
const COVER_STYLE_HINTS = [
  "波普风，大色块和强对比排版",
  "极简风，大留白和一个强视觉焦点",
  "杂志封面风，标题醒目、层级清楚",
  "手写标注风，少量重点圈画",
  "蓝白科技风，干净界面和冷色高光",
  "轻 3D 插画风，主体明确、空间干净"
];
let videoConfigCache = null;
let videoConfigAt = 0;

const assetById = id => state.assets.find(a => a.id === id);
function audioDuration(url) {
  return new Promise(res => {
    if (!url) return res(0);
    const el = new Audio();
    el.preload = "metadata";
    el.onloadedmetadata = () => res(isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => res(0);
    el.src = url;
  });
}

export { planDigitalNarrationSegments, planDigitalSegmentGroups };

function narrationText(shots) {
  return (shots || []).map(s => (s.line || "").trim()).filter(Boolean).join("\n");
}

function isPublicHttpUrl(url = "") {
  const u = String(url || "");
  return /^https?:\/\//i.test(u) && !/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::|\/|$)/i.test(u);
}

function isServerFileUrl(url = "") {
  const u = String(url || "");
  return /^\/api\/files\//.test(u) || /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/api\/files\//i.test(u);
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

function liveJobUiSignature(job) {
  return JSON.stringify([
    job?.status || "",
    outputUrl(job?.output),
    job?.error || "",
    job?.referenceReceipt || null,
  ]);
}

function updateLiveJobProgress(job) {
  if (!liveRoot || !["queued", "submitted", "running"].includes(job?.status || "")) return false;
  const progress = Math.max(1, Math.min(99, Math.round(Number(job.progress || 1))));

  if (job.model === "__digital_human__") {
    const cards = $$('[data-dh-seg]', liveRoot);
    const card = cards.find(el => el.dataset.dhSeg === String(job.segmentId || ""))
      || cards[Number(job.segIndex || 0)];
    const placeholder = card?.querySelector(".dh-video-placeholder");
    const bar = placeholder?.querySelector("i > b");
    if (!card || !placeholder || !bar) return false;
    card.classList.add("is-generating");
    const status = card.querySelector(".dh-status");
    if (status) {
      status.className = "dh-status running";
      status.textContent = "生成中";
    }
    const detail = placeholder.querySelector("em");
    if (detail) detail.textContent = `${job.status === "queued" ? "已进入队列" : job.status === "submitted" ? "已提交上游" : "正在轮询成片"} · ${progress}%`;
    bar.style.width = `${progress}%`;
    return true;
  }

  const card = liveRoot.querySelector(`[data-ws="${Number(job.segIndex || 0)}"]`);
  const infoFlowState = card?.querySelector(".if-card-actions > span");
  const infoFlowPlaceholder = card?.querySelector(".if-video-placeholder > em");
  if (card?.classList.contains("if-segment-row") && infoFlowState && infoFlowPlaceholder) {
    const label = job.status === "queued" ? "排队中" : `生成 ${progress}%`;
    infoFlowState.textContent = label;
    infoFlowPlaceholder.textContent = label;
    return true;
  }
  const running = card?.querySelector(".wsj.run");
  const bar = running?.querySelector(".wsj-bar > b");
  if (!card || !running || !bar) return false;
  const textNode = [...running.childNodes].find(node => node.nodeType === 3);
  if (textNode) textNode.nodeValue = job.status === "queued" ? " 排队中" : ` 渲染 ${progress}%`;
  bar.style.width = `${progress}%`;
  return true;
}

async function videoServerConfig() {
  if (videoConfigCache && Date.now() - videoConfigAt < 30000) return videoConfigCache;
  try {
    const token = remote.getToken();
    const res = await fetch("/api/video/config", {
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    const data = await res.json().catch(() => ({}));
    videoConfigCache = res.ok ? data : { ok: false, detail: data.detail || data.error || `HTTP ${res.status}` };
  } catch (err) {
    videoConfigCache = { ok: false, detail: err.message || "视频服务不可用" };
  }
  videoConfigAt = Date.now();
  return videoConfigCache;
}

function selectedVoicePreset(p, acc) {
  const voiceId = (p?.artifacts?.audio?.voiceId || acc?.voiceId || defaultTtsVoiceId() || "").trim();
  const preset = ttsVoicePresets().find(v => v.voiceId === voiceId);
  const known = findKnownTtsVoice(voiceId);
  const accountName = acc?.voiceId === voiceId ? acc?.voiceName : "";
  const transientName = p?.artifacts?.audio?.voiceName || "";
  return { voiceId, name: preset?.name || accountName || transientName || known?.name || voiceId || "默认/手动声线" };
}

function coverState(p) {
  const A = p.artifacts.boards || (p.artifacts.boards = {});
  A.cover = A.cover || { prompt: "", assetId: null, refAssetIds: [], status: "idle", error: "" };
  A.cover.refAssetIds = Array.isArray(A.cover.refAssetIds) ? A.cover.refAssetIds.filter(Boolean).slice(0, 5) : [];
  A.cover.status = A.cover.status || "idle";
  if (A.cover.status === "loading" && !A.cover.assetId) {
    const age = Date.now() - Number(A.cover.updatedAt || 0);
    if (!A.cover.updatedAt || age > COVER_LOADING_TIMEOUT_MS) {
      A.cover.status = "failed";
      A.cover.error = "封面生成超时，已恢复为可重试状态";
      A.cover.updatedAt = Date.now();
      save("productions");
    }
  }
  return A.cover;
}

function referenceReceiptLabel(receipt) {
  const intended = Number(receipt?.intendedRefs || 0);
  if (!intended) return "";
  const used = Number(receipt?.usedRefs || 0);
  const skipped = Number(receipt?.skippedRefs || Math.max(0, intended - used));
  return `参考图实际使用 ${used}/${intended}${skipped ? `，${skipped} 张未被接收` : ""}`;
}

function coverRefAssets(cover) {
  return (cover.refAssetIds || []).map(assetById).filter(Boolean).slice(0, 5);
}

function ensureDigitalCoverRoleRef(p, acc, cover) {
  if (p?.subType !== "数字人") return false;
  const id = p.artifacts?.boards?.characterRefAssetId || acc?.charBoardAssetId || "";
  if (!id || !assetById(id)) return false;
  cover.refAssetIds = Array.isArray(cover.refAssetIds) ? cover.refAssetIds.filter(Boolean) : [];
  if (cover.refAssetIds.includes(id)) return false;
  cover.refAssetIds = [id, ...cover.refAssetIds].slice(0, 5);
  cover.updatedAt = Date.now();
  return true;
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function coverUrlToDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("图片 URL 下载失败：" + res.status);
  return await fileToDataUrl(await res.blob());
}

async function coverProviderRefs(cover) {
  const refs = [];
  for (const a of coverRefAssets(cover)) {
    const u = urlFor(a);
    let dataUrl = "";
    let publicUrl = "";
    if (/^data:/.test(u || "")) dataUrl = u;
    else if (/^https?:\/\//.test(u || "")) publicUrl = u;
    else if (u) {
      try { dataUrl = await coverUrlToDataUrl(u); } catch (_) { /* ignore local reference failures */ }
    }
    if (dataUrl || publicUrl) {
      refs.push({
        id: a.id,
        name: a.name || "封面参考图",
        type: a.type,
        mime: a.mime || "image/png",
        url: publicUrl,
        dataUrl
      });
    }
  }
  return refs;
}

async function providerRefsFromAssetIds(assetIds = [], max = 9) {
  const refs = [];
  const seen = new Set();
  for (const id of assetIds) {
    if (!id || seen.has(id) || refs.length >= max) continue;
    seen.add(id);
    const a = assetById(id);
    if (!a) continue;
    const u = urlFor(a);
    let dataUrl = "";
    let publicUrl = "";
    if (/^data:/.test(u || "")) dataUrl = u;
    else if (/^https?:\/\//.test(u || "")) publicUrl = u;
    else if (u) {
      try { dataUrl = await coverUrlToDataUrl(u); } catch (_) { /* ignore local reference failures */ }
    }
    if (dataUrl || publicUrl) {
      refs.push({
        id: a.id,
        name: a.name || "参考图",
        type: a.type,
        mime: a.mime || "image/png",
        url: publicUrl,
        dataUrl
      });
    }
  }
  return refs;
}

function enrichCoverPromptWithRefs(prompt, cover) {
  const names = coverRefAssets(cover).map(a => a.name || "封面参考图").filter(Boolean).slice(0, 5);
  if (!names.length) return prompt || "";
  const body = String(prompt || "").replace(/负面约束\s*[:：][\s\S]*$/g, "").trim();
  return `${body}\n\n封面参考图：本次提供 ${names.length} 张参考图（${names.join("、")}），只参考人物、产品或构图气质；封面内容仍以标题为主，不要把正文内容画成小字。\n\n${COVER_NEGATIVE_PROMPT}`.trim();
}

function coverStyleHint(seed = "") {
  const s = String(seed || "");
  let n = 0;
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
  return COVER_STYLE_HINTS[(n + Math.floor(Date.now() / 60000)) % COVER_STYLE_HINTS.length];
}

function coverPromptFromCopy({ title = "", body = "", product = null, custom = "", ratio = "3:4" } = {}) {
  const safeTitle = sanitizeXhsText(title || "视频封面");
  const extra = sanitizeXhsText(custom || "").slice(0, 280);
  const style = coverStyleHint(`${safeTitle}:${product?.id || product?.name || ""}:${extra}`);
  return [
    `这是一张具有冲击力的短视频封面图，比例${ratio}，文字清晰明显。`,
    `标题内容：${safeTitle}`,
    `风格描述：${style}。`,
    extra ? `补充风格：${extra}` : "",
    COVER_NEGATIVE_PROMPT
  ].filter(Boolean).join("\n");
}

function voicePickerHtml({ selected, groups, favoriteIds, lockedVoiceId }) {
  const selectedId = selected.voiceId || "";
  const blocks = (groups || []).filter(g => (g.items || []).length);
  return `<div class="voice-picker" id="wsVoicePicker">
    <button class="voice-picker-btn" id="wsVoicePickerBtn" type="button">
      <span>${esc(selected.name || "默认/手动声线")}</span>
      <em>${selectedId ? esc(selectedId) : "平台默认 / 手动输入"}</em>
      ${icon("chevronDown", 13)}
    </button>
    <div class="voice-menu" id="wsVoiceMenu" hidden>
      ${blocks.map(group => `<div class="voice-menu-group">
        <div class="voice-menu-title">${esc(group.title)}</div>
        ${(group.items || []).map(opt => {
          const fav = favoriteIds.has(opt.voiceId);
          const active = opt.voiceId === selectedId;
          const locked = opt.voiceId && opt.voiceId === lockedVoiceId;
          const sourceText = ({ mine: "我的音色", system: "系统音色", favorite: "收藏音色", default: "平台默认", current: "当前声线" }[opt.source]) || opt.source || "";
          return `<button class="voice-option ${active ? "is-active" : ""} ${fav ? "is-fav" : ""}" type="button" data-voice-option="${esc(opt.voiceId)}">
            <span>${fav ? icon("star", 12) : icon(active ? "check" : "mic", 12)} <b>${esc(opt.name || opt.voiceId || "默认/手动声线")}</b></span>
            <em>${locked ? "已锁定" : fav ? "已收藏" : esc(sourceText)}</em>
          </button>`;
        }).join("")}
      </div>`).join("")}
    </div>
  </div>`;
}

function audioPlanFromDuration(shots, duration) {
  const est = estimateAudio(shots);
  const total = est.duration || 1;
  const scale = duration > 0 ? duration / total : 1;
  const perShot = (est.perShot || []).map(x => ({ dur: Math.max(3, Math.round(x.dur * scale * 10) / 10) }));
  return { perShot, duration: duration > 0 ? Math.round(duration * 10) / 10 : est.duration };
}

function digitalSegmentsFromShots(p, acc) {
  const shots = p.artifacts.script.shots || [];
  const A = p.artifacts.boards;
  const old = A.digitalHuman?.segments || [];
  const claimedOld = new Set();
  const planned = planDigitalNarrationSegments(shots);
  const segments = planned.map(plan => ({
    id: uid(),
    shotIndexes: plan.shotIndexes,
    dur: plan.dur,
    line: plan.line,
    characterRefAssetId: "",
    customCharacterRefAssetId: "",
    audioAssetId: null,
    audioDuration: 0,
    status: "pending"
  }));
  const globalChar = A.characterRefAssetId || acc?.charBoardAssetId || null;
  segments.forEach(seg => {
    let oldIndex = old.findIndex((x, i) => !claimedOld.has(i) && String(x.line || "").trim() === String(seg.line || "").trim());
    const matchedByLine = oldIndex >= 0;
    if (oldIndex < 0) oldIndex = old.findIndex((x, i) => !claimedOld.has(i) && (x.shotIndexes || []).some(index => seg.shotIndexes.includes(index)));
    if (oldIndex >= 0) claimedOld.add(oldIndex);
    const oldSeg = oldIndex >= 0 ? old[oldIndex] : null;
    if (oldSeg?.id) seg.id = oldSeg.id;
    if (oldSeg?.customCharacterRefAssetId) seg.customCharacterRefAssetId = oldSeg.customCharacterRefAssetId;
    // 镜头位置相同只代表角色参考可以延续，不代表口播内容相同。
    // 逐字一致时才复用旧音频/视频，避免用户改稿后仍播放自动生成的旧口播。
    if (matchedByLine) {
      if (oldSeg?.audioAssetId) seg.audioAssetId = oldSeg.audioAssetId;
      if (oldSeg?.audioDuration) seg.audioDuration = oldSeg.audioDuration;
      if (oldSeg?.voiceId) seg.voiceId = oldSeg.voiceId;
      if (oldSeg?.status) seg.status = oldSeg.status;
      if (oldSeg?.videoJobId) seg.videoJobId = oldSeg.videoJobId;
      if (oldSeg?.videoStatus) seg.videoStatus = oldSeg.videoStatus;
      if (oldSeg?.videoPrompt) seg.videoPrompt = oldSeg.videoPrompt;
      if (oldSeg?.providerRef) seg.providerRef = oldSeg.providerRef;
      if (oldSeg?.videoOutput) seg.videoOutput = oldSeg.videoOutput;
      if (oldSeg?.videoError) seg.videoError = oldSeg.videoError;
      if (oldSeg?.videoProgress) seg.videoProgress = oldSeg.videoProgress;
      if (oldSeg?.videoQueuedAt) seg.videoQueuedAt = oldSeg.videoQueuedAt;
      if (oldSeg?.videoUpdatedAt) seg.videoUpdatedAt = oldSeg.videoUpdatedAt;
    }
    seg.dur = Math.round(Math.min(DIGITAL_SEGMENT_MAX_SEC, seg.dur) * 10) / 10;
    seg.characterRefAssetId = seg.customCharacterRefAssetId || globalChar || null;
  });
  A.digitalHuman = { ...(A.digitalHuman || {}), provider: A.digitalHuman?.provider || "reserved", model: A.digitalHuman?.model || "digital-human-api-placeholder", segments };
  return segments;
}

function digitalSegmentsForDisplay(p, acc) {
  const existing = Array.isArray(p.artifacts.boards?.digitalHuman?.segments) ? p.artifacts.boards.digitalHuman.segments : [];
  const globalChar = p.artifacts.boards?.characterRefAssetId || acc?.charBoardAssetId || null;
  existing.forEach(seg => { seg.characterRefAssetId = seg.customCharacterRefAssetId || globalChar || null; });
  return existing;
}

function persistDigitalSegmentsForCurrentState(p, acc) {
  const segs = digitalSegmentsForDisplay(p, acc).length ? digitalSegmentsForDisplay(p, acc) : digitalSegmentsFromShots(p, acc);
  const A = p.artifacts.boards || (p.artifacts.boards = {});
  A.digitalHuman = A.digitalHuman || { provider: "", model: "", segments: [] };
  A.digitalHuman.segments = segs;
  return segs;
}

const INFO_FLOW_DIRECTIONS = [
  {
    key: "zero-start",
    topic: "国产AI工具零门槛上手",
    title: product => `${product}，不用安装也能快速上手！`,
    hook: product => `0-3s：深夜工位，一个不会写代码的人盯着空白网页草稿，屏幕上弹出一堆红色待办；3-7s：手机震动，朋友发来“你不是不会做网页吗？”角色抬头笑一下，直接打开${product}；7-11s：镜头快速推近屏幕，需求被拆成任务卡，页面轮廓一块块亮起；11-15s：角色把咖啡放下，对镜头说“我真的一行代码都没写”，画面定格在已经能看的页面。`,
    demo: product => `0-4s：角色把一句需求输入${product}，屏幕左侧保留原始想法，右侧自动拆出“结构、素材、执行、检查”四张任务卡；4-8s：镜头近景点击任务卡，网页、文档和素材被拉进同一工作区，口播说“先别写代码，先让它把任务拆清楚”；8-12s：执行进度、结果预览和可修改入口连续出现；12-15s：角色把手机举到镜头前，屏幕显示任务进度和初版页面，收束“想法能先跑起来”。`
  },
  {
    key: "workflow",
    topic: "AI工作流提效",
    title: product => `${product}把乱任务跑成可交付流程`,
    hook: product => `0-3s：会议结束，桌上堆满录音、截图和表格，角色把文件夹直接倒在桌面上；3-6s：镜头俯冲进一堆资料，文件像风暴一样旋转；6-10s：角色说“别先整理，先让AI跑一遍”，屏幕上出现${product}的任务队列；10-15s：资料被吸进一个发光任务板，三列卡片依次弹出“分类、提取、交付”。`,
    demo: product => `0-4s：角色把一堆截图、会议纪要和表格拖进${product}，界面先标出资料类型和缺口；4-8s：镜头俯拍切到任务清单，系统把“分类、提取、生成、复核”拆成可执行步骤；8-12s：周报、表格、脚本草稿并排生成，旁边有修改入口；12-15s：散乱资料回扣成一个可交付文件夹，角色直接复制交付清单。`
  },
  {
    key: "compare",
    topic: "AI工具对比测评",
    title: product => `${product}和别的AI工具到底差在哪？`,
    hook: product => `0-4s：桌面分成左右两边，一边是“只聊天”，另一边是“能执行”，两边同时开始计时；4-8s：左边还在输出建议，右边已经打开文件、生成页面、整理清单；8-12s：角色从画面中间伸手按下暂停，镜头定格在两边结果差距；12-15s：屏幕大字“不是谁更会说，是谁能把事往前推”。`,
    demo: product => `0-4s：画面左右对比，一边还在输出建议，另一边${product}已经把需求拆成任务卡；4-8s：镜头切到自动读文件、改页面、整理素材三个真实动作，每个动作都有进度反馈；8-12s：执行日志、可预览结果和交付物同时出现；12-15s：回到左右对比桌面，${product}一侧已经有可发送的初版，另一侧只剩一段建议。`
  },
  {
    key: "office-scene",
    topic: "真实办公场景测评",
    title: product => `真实办公场景里，${product}到底能干什么？`,
    hook: product => `0-3s：早会刚结束，老板一句“今天下班前给我”，角色表情瞬间僵住；3-6s：白板上飞出“整理资料、做表格、写脚本、出封面”四个任务砸向屏幕；6-11s：角色把这些需求一句话扔给${product}，镜头跟随任务卡快速分裂成多个小步骤；11-15s：画面突然安静，屏幕显示“已生成初版”，角色小声说“这就能看了？”`,
    demo: product => `0-4s：老板口头需求被贴到${product}输入框，界面立刻拆出资料整理、脚本生成、封面图和审核清单四个交付项；4-9s：镜头快速切过四个窗口，每个窗口都生成可修改内容；9-13s：结果页显示初版链接、可编辑文案和交付清单；13-15s：回到聊天窗口，角色直接发送初版链接，口播收束“先有能改的版本”。`
  }
];

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

function touchProduction(p, info = null) {
  const now = Date.now();
  if (info) info.updatedAt = now;
  if (p) p.updatedAt = now;
}

function safeTtsText(text = "") {
  return sanitizeXhsText(String(text || "")
    .replace(/翻墙/g, "跨网络访问")
    .replace(/科学上网/g, "跨网络访问")
    .replace(/魔法上网/g, "跨网络访问")
    .replace(/VPN/gi, "网络环境")
    .trim());
}

function ensureInfoFlowState(p) {
  const A = p.artifacts.boards || (p.artifacts.boards = {});
  A.materialMode = A.materialMode || (isMaterial(p) ? "infoFlow" : "standard");
  A.infoFlow = A.infoFlow || { segments: [], status: "idle", error: "" };
  A.infoFlow.segments = Array.isArray(A.infoFlow.segments) ? A.infoFlow.segments.slice(0, 2) : [];
  let changed = false;
  A.infoFlow.segments.forEach(seg => {
    if (!seg) return;
    if (seg.videoPrompt) {
      const next = stripInfoFlowDirectorNotes(seg.videoPrompt);
      if (next !== seg.videoPrompt) { seg.videoPrompt = next; changed = true; }
    }
    for (const key of ["storyboardPrompts", "storyboardAssetIds", "storyboardReferenceReceipts"]) {
      if (Object.prototype.hasOwnProperty.call(seg, key)) {
        delete seg[key];
        changed = true;
      }
    }
  });
  if (Object.prototype.hasOwnProperty.call(A.infoFlow, "storyboards")) {
    delete A.infoFlow.storyboards;
    changed = true;
  }
  A.infoFlow.status = A.infoFlow.status || "idle";
  if (A.infoFlow.status === "storyboarding") {
    A.infoFlow.status = A.infoFlow.segments.length ? "ready" : "idle";
    A.infoFlow.error = "";
    touchProduction(p, A.infoFlow);
    changed = true;
  }
  if (changed) save("productions");
  return A.infoFlow;
}

function infoProductName(product) {
  return product?.shortName || product?.name || "百度搭子";
}

function compactInfoFlowText(text = "", max = 96) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function infoFlowHash(seed = "") {
  let h = 2166136261;
  for (const ch of String(seed || "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickInfoFlow(list = [], seed = "", offset = 0) {
  if (!list.length) return null;
  return list[Math.abs(infoFlowHash(`${seed}:${offset}`)) % list.length];
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
    if (firstNorm && (firstNorm === titleNorm || firstNorm.startsWith(titleNorm))) {
      const rest = lines[0]
        .replace(new RegExp(`^\\s*${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：,，.。!！?？-]*\\s*`), "")
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

function copyBodyForSpeech(body = "") {
  return sanitizeXhsText(String(body || "")
    .split(/\n+/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => !/^#/.test(x))
    .join("\n")
    .replace(/#[^\s#]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim());
}

function completeCustomVideoBody(title = "", product = null) {
  const t = sanitizeXhsText(String(title || "").trim()) || "这件事";
  const productName = infoProductName(product);
  const tagLine = videoPublishTagLine(product);
  return [
    `很多人卡在${t}，不是因为不会用 AI，而是每次都从一堆零散资料里重新开始试。`,
    `我的做法是先把资料边界、目标结果和复核点列清楚，再交给${productName}跑出一版能继续修改的初稿。`,
    "真正省时间的地方，是中间那些分类、提取、整理和生成结果的重复动作先被压下去。",
    "这样人不用放弃判断，只需要把注意力留给最后的筛选、修改和确认。",
    tagLine
  ].join("\n");
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

const INFO_FLOW_STYLE_ANCHORS = [
  "统一为超写实真人信息流质感：真实自然光、真实材质、克制手持运镜；前后两段保持同一色温、颗粒、对比度和镜头语言。"
];

const INFO_FLOW_TITLE_PATTERNS = [
  (topic, product) => `别再硬聊AI了，${topic}这样跑`,
  (topic, product) => `${topic}卡住？先让${product}拆开`,
  (topic, product) => `我用${product}重做了一遍：${topic}`,
  (topic, product) => `${topic}效率翻倍，关键不是多写Prompt`,
  (topic, product) => `普通人做${topic}，先避开这个坑`,
  (topic, product) => `${product}这招，专治${topic}跑偏`,
  (topic, product) => `${topic}别从零开始，先要一个可改初版`,
  (topic, product) => `同样是${topic}，换个流程差太多`,
  (topic, product) => `${topic}别再瞎试，先看这一步`,
  (topic, product) => `我终于知道${topic}为什么慢了`,
  (topic, product) => `${product}处理${topic}，第一步很反常识`,
  (topic, product) => `${topic}想提速，别让模型乱猜`,
  (topic, product) => `把${topic}交给${product}，结果很意外`,
  (topic, product) => `${topic}从混乱到能交付，我只改了流程`,
  (topic, product) => `${topic}真正省时间的是这件小事`,
  (topic, product) => `${product}不是聊天框，${topic}要这样用`,
  (topic, product) => `${topic}跑不出来，可能不是提示词问题`,
  (topic, product) => `${topic}先别追求完美，先拿到初版`,
  (topic, product) => `做${topic}，我现在先问${product}这句`,
  (topic, product) => `${topic}被低估的提效入口在这里`
];

function infoFlowHotTitle(topic = "", productName = "百度搭子", seed = "") {
  const t = String(topic || "").replace(/[!！?？。,.，、]+$/g, "").trim() || "这件办公乱事";
  const make = pickInfoFlow(INFO_FLOW_TITLE_PATTERNS, seed, 41) || INFO_FLOW_TITLE_PATTERNS[0];
  const raw = make(t, productName).replace(/\s+/g, "");
  return raw.length > 34 ? `${raw.slice(0, 33)}…` : raw;
}

function videoPublishTagLine(product = null) {
  const name = infoProductName(product);
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
    `0-3s：镜头从桌面低角度冲进来，${focus.prop}像多米诺一样倒向键盘，角色手忙脚乱按住电脑和手机。`,
    `0-3s：电梯门一开，角色怀里抱着${focus.prop}冲回工位，屏幕上任务提醒连续闪烁，表情像刚被临时加班砸中。`,
    `0-3s：画面先给一个极近特写：鼠标旁堆着${focus.prop}，聊天窗口又跳出新需求，角色闭眼深呼吸三秒。`
  ];
  const turns = [
    `3-6s：镜头手持快速绕桌一圈，文件夹、截图、表格和聊天消息像失控一样叠到屏幕前；角色用符合本次主题的原创短台词回应冲突。`,
    `3-6s：画面快切三次：空白文档、凌乱资料、错误输出，角色每切一次表情更崩一点，最后用本次主题专属台词把阻碍说清。`,
    `3-6s：角色试着随便跑一次，屏幕弹出三段完全跑偏的结果，镜头突然推到他愣住的表情；反应和台词必须针对本次文案重新创作。`,
    `3-6s：桌面被分成两半，一边是“直接开跑”的混乱输出，一边是还没被整理的真实资料，角色皱眉说“先别急，流程还没定”。`
  ];
  const twists = [
    `6-10s：画面切成夸张对比：左边随便选工具后输出一堆空话，右边角色把「${mainTopic}」拆成几张任务卡贴到屏幕上，镜头快速推近每张卡的错位结果。`,
    `6-10s：角色突然停下，把「${mainTopic}」写成一句完整任务，旁边三张模型/流程卡依次亮起，镜头跟着卡片快速横移。`,
    `6-10s：错误输出被角色一张张拖到废纸篓，屏幕中央只留下「${mainTopic}」和“先判断、再执行、再复核”三步。`,
    `6-10s：桌面灯光一收，角色像开盲盒一样翻开三张方案卡，前两张跑偏，第三张终于把任务拆到可执行。`
  ];
  const closes = [
    `10-15s：角色把错误输出揉成纸团扔到桌边，深吸一口气，对镜头说“先别急着跑，先选对怎么跑”，画面停在一张清晰的执行路线草图上。`,
    `10-15s：镜头从角色表情拉回屏幕，混乱资料被一条路线框住，角色点头说“这次先让它按步骤来”。`,
    `10-15s：画面突然安静，桌面只剩一张干净任务卡，角色把手机扣下，对镜头抛一句“别让模型替你乱猜”。`,
    `10-15s：角色把三张方案卡合成一条执行线，屏幕定格在操作画面，对镜头说“先选对模型，再跑流程”。`
  ];
  return [
    pickInfoFlow(openers, seed, 1),
    pickInfoFlow(turns, seed, 2),
    pickInfoFlow(twists, seed, 3),
    pickInfoFlow(closes, seed, 4)
  ].join(" ");
}

function buildInfoFlowBackBeat({ mainTopic, productName, focus, copyText = "", seed = "" }) {
  const cue = infoFlowCopyCue(copyText, mainTopic);
  const starts = [
    `0-3s：画面近景看到用户在${productName}里输入「${mainTopic}」，旁边放着资料、截图和待办，口播自然扣回发布文案重点：“${cue}”。`,
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
    pickInfoFlow(starts, seed, 11),
    pickInfoFlow(mids, seed, 12),
    pickInfoFlow(results, seed, 13),
    pickInfoFlow(closes, seed, 14)
  ].join(" ");
}

function buildInfoFlowPublishCopy({ title, topic, productName, product, seed = "" }) {
  const focus = infoFlowFeatureBrief(topic, productName);
  const isModelTopic = /模型|model|隐藏|玩法|效率翻倍|选对|十大|10大|十个|10个/.test(String(topic || "").toLowerCase());
  const modelOpeners = [
    `很多人用 AI 提效慢，不是不会提问，而是一开始就让同一个模型包办所有事。`,
    `我现在判断一个 AI 工作流靠不靠谱，第一步不是写 Prompt，而是先决定这件事该怎么分工。`,
    `同一个需求，模型选错以后很容易越跑越偏：看起来字很多，能直接改的结果却很少。`,
    `最近我重新梳理了一遍「${topic}」，发现真正省时间的不是一句神奇指令，而是先把模型和任务顺序排对。`
  ];
  const modelMids = [
    `${productName}这类桌面智能体适合做的，是把「${topic}」拆成可执行流程：谁负责拆步骤，谁负责拉资料，谁负责写初版，谁负责复核修改。`,
    `我的习惯是先把目标、素材和判断标准说清楚，再让${productName}把任务卡、资料整理、初版结果和修改入口一起跑出来。`,
    `这次会重点看几个隐藏玩法：先选模型，再拆任务；先给资料，再生成；先要可修改初版，不要一开始追求完美。`
  ];
  const modelEnds = [
    `这样做的好处是每一步都有结果能检查，跑偏了也知道该从哪里改，不会一路返工到最后。`,
    `它不是替人拍脑袋做决定，而是先把重复劳动压下去，让人把注意力留给判断和修改。`,
    `如果你也经常被资料、截图、临时需求追着跑，可以先从一个小任务试：选对模型和流程，再看效率是不是真的翻倍。`
  ];
  if (isModelTopic) {
    return [
      pickInfoFlow(modelOpeners, seed, 21),
      pickInfoFlow(modelMids, seed, 22),
      pickInfoFlow(modelEnds, seed, 23),
      videoPublishTagLine(product)
    ].join("\n\n");
  }
  const generalOpeners = [
    `${productName}这类工具，最容易被低估的不是“会回答”，而是能先把一件乱事推到能改的版本。`,
    `我现在看 AI 办公工具，会先看它能不能把${focus.pain}这种场景拆成可检查步骤。`,
    `真正省时间的地方，经常不是最后那段漂亮文案，而是中间那些分类、提取、生成初版和复核动作。`
  ];
  const generalMids = [
    `比如${focus.pain}，以前我会先卡在整理这一步：资料要看，步骤要拆，结果还要能交付。现在我会先把需求丢进去，让它把任务拆出来，再看哪些地方需要我判断。`,
    `这次重点看${focus.feature}：${focus.action}。它不替你做最终判断，但能把重复动作先压下去。`,
    `我的用法很简单：先说清材料边界和结果格式，再让它跑一版可修改初稿，最后只检查遗漏和判断依据。`
  ];
  const generalEnds = [
    `很多时候，最难的不是一次做完美，而是先有一个能看的初稿。`,
    `如果你也经常被资料、截图、表格和临时需求追着跑，可以先拿一个低风险任务试一遍。`,
    `只要结果能回到原资料里复核，这种流程就比单纯聊天更适合日常办公。`
  ];
  return [
    pickInfoFlow(generalOpeners, seed, 31),
    pickInfoFlow(generalMids, seed, 32),
    pickInfoFlow(generalEnds, seed, 33),
    videoPublishTagLine(product)
  ].join("\n\n");
}

function pickInfoFlowDirection(seed = "") {
  const s = String(seed || "");
  const sum = [...s].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return INFO_FLOW_DIRECTIONS[sum % INFO_FLOW_DIRECTIONS.length];
}

function compactInfoTopic(raw, product) {
  const clean = sanitizeXhsText(String(raw || "").replace(/\s+/g, " ").trim());
  if (clean) return clean.slice(0, 48);
  const productName = infoProductName(product);
  const d = pickInfoFlowDirection(`${Date.now()}-${productName}`);
  return d.topic;
}

function buildInfoFlowPlan({ topic = "", product = null, acc = null, copyText = "", publishCopy = "", title = "", creativePlan = null } = {}) {
  const productName = infoProductName(product);
  const customTitle = sanitizeXhsText(String(title || "").replace(/\s+/g, " ").trim());
  const cleanTopic = compactInfoTopic(topic || customTitle, product);
  const runSeed = `${cleanTopic || topic}:${productName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const direction = pickInfoFlowDirection(cleanTopic || productName);
  const isCustom = !!String(topic || "").trim();
  const finalTitle = customTitle || (isCustom
    ? infoFlowHotTitle(cleanTopic, productName, runSeed)
    : direction.title(productName));
  const roleAnchor = infoFlowRoleAnchor(acc);
  const voiceAnchor = infoFlowVoiceAnchor(acc);
  const styleAnchor = pickInfoFlow(INFO_FLOW_STYLE_ANCHORS, runSeed, 0);
  const mainTopic = cleanTopic || finalTitle || direction.topic;
  const focus = infoFlowFeatureBrief(mainTopic, productName);
  const frontBase = creativePlan?.frontPrompt || buildInfoFlowFrontBeat({ mainTopic, productName, focus, seed: runSeed });
  const promptCue = String(copyText || "").trim();
  const customCopy = String(publishCopy || copyText || "").trim();
  const generatedCopy = buildInfoFlowPublishCopy({ title: finalTitle, topic: mainTopic, productName, product, seed: runSeed });
  const copy = stripLeadingCopyTitle(customCopy || generatedCopy, finalTitle);
  const backBase = creativePlan?.backPrompt || buildInfoFlowBackBeat({ mainTopic, productName, focus, copyText: promptCue || copy, seed: runSeed });
  const frontPrompt = creativePlan?.frontPrompt ? [
    creativePlan.frontPrompt,
    VIDEO_NEGATIVE_PROMPT
  ].join("\n") : [
    "快节奏的信息流广告风格，生成9:16短视频前15秒钩子段。目标是用夸张、具体、可拍出来的办公剧情把观众停住；所选参考图直接用于人物、产品、场景与视觉风格一致性，但前段不出现产品logo和产品界面。镜头每2-4秒切一次，节奏爽快但不能乱。",
    styleAnchor,
    roleAnchor,
    voiceAnchor,
    frontBase,
    VIDEO_NEGATIVE_PROMPT
  ].join("\n");
  const backPrompt = creativePlan?.backPrompt ? [
    creativePlan.backPrompt,
    VIDEO_NEGATIVE_PROMPT
  ].join("\n") : [
    "快节奏的信息流广告风格，生成9:16短视频后15秒产品功能演示段。直接使用所选产品、界面与场景参考图继续生成；画面要呼应前段冲突，口播直接讲操作动作和结果，不要使用自指式说明。",
    styleAnchor,
    "B面仅展示真实产品界面、桌面软件窗口和屏幕录制式操作；禁止人物、手部、手指、人体部位、Q版角色和拟人化肢体。界面文字少而清楚，避免高密度文字。",
    voiceAnchor,
    backBase,
    VIDEO_NEGATIVE_PROMPT
  ].join("\n");
  return {
    title: finalTitle,
    topic: cleanTopic,
    copy,
    segments: [
      { id: "front15", label: "前15s", title: "前15s钩子", duration: 15, caption: creativePlan?.creativeAngle || finalTitle, visual: frontBase, videoPrompt: frontPrompt },
      { id: "back15", label: "后15s", title: "后15s功能演示", duration: 15, caption: creativePlan?.creativeAngle ? `承接「${creativePlan.creativeAngle}」的冲突，用产品界面完成解决。` : `我把这件事交给${productName}，让它先拆步骤、跑资料、给出初版。`, visual: backBase, videoPrompt: backPrompt }
    ]
  };
}

function applyInfoFlowPlan(p, plan, { preserveCopy = false } = {}) {
  const A = p.artifacts.boards || (p.artifacts.boards = {});
  A.materialMode = "infoFlow";
  const prev = ensureInfoFlowState(p);
  const oldCopy = p.artifacts.copy || {};
  const nextTitle = preserveCopy
    ? (oldCopy.title || p.title || plan.title || p.topic || "")
    : (plan.title || p.title || p.topic || "");
  const nextBody = preserveCopy
    ? (oldCopy.body || stripLeadingCopyTitle(plan.copy || "", nextTitle))
    : stripLeadingCopyTitle(plan.copy || oldCopy.body || "", nextTitle);
  A.infoFlow = {
    ...prev,
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
  touchProduction(p, A.infoFlow);
}

function normProductText(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s"'“”‘’《》「」【】\[\]（）()!！?？:：,，.。;；、~～\-_/\\]+/g, "");
}

function productTerms(product = {}) {
  return [
    product.id,
    product.name,
    product.shortName,
    product.category,
    ...(product.keywords || []),
    ...(product.coreFeatures || []),
    ...(product.tutorialAngles || []),
    ...(product.blogAngles || [])
  ].filter(Boolean);
}

function inferWorkshopProductFromCopy(title = "", body = "", fallback = null) {
  const source = normProductText(`${title}\n${body}`);
  const choices = primaryProducts();
  const hit = choices.find(product => productTerms(product).some(term => {
    const t = normProductText(term);
    return t && t.length >= 2 && source.includes(t);
  }));
  return hit || fallback || primaryProductById("dumate") || productById("dumate");
}

export async function ensureVideoCover(p, { force = false, onStatus = null } = {}) {
  if (!p || p.mode !== "视频") return true;
  const acc = accountById(p.accountId);
  if (!acc) throw new Error("账号不存在，无法生成封面");
  const cover = coverState(p);
  if (!force && cover.assetId && assetById(cover.assetId)) return true;
  if (cover.status === "loading") throw new Error("封面正在生成，请稍候");
  const title = (p.artifacts.copy?.title || p.title || p.topic || "").trim();
  if (!title) throw new Error("缺少发布标题，无法自动生成封面");
  if (!imageApiConfigured()) throw new Error("图片 API 未接入，无法自动生成封面");
  ensureDigitalCoverRoleRef(p, acc, cover);
  const ratio = "3:4";
  const custom = /^生成短视频封面图/.test(cover.prompt || "") ? "" : (cover.prompt || "").trim();
  cover.prompt = coverPromptFromCopy({
    title,
    body: p.artifacts.copy?.body || narrationText(p.artifacts.script.shots || []),
    product: inferWorkshopProductFromCopy(title, p.artifacts.copy?.body || "", productById(p.artifacts.script.productId || "dumate")),
    custom,
    ratio
  });
  cover.status = "loading";
  cover.error = "";
  cover.referenceReceipt = null;
  cover.updatedAt = Date.now();
  save("productions");
  if (typeof onStatus === "function") onStatus();
  try {
    const provider = activeProviderFor("image");
    const key = providerKeyFor("image", provider);
    if (provider?.mock) throw new Error("图片 API 未接入：当前图片 Provider 是模拟模式");
    const refs = await withTimeout(coverProviderRefs(cover), 45000, "封面参考图读取超时");
    const prompt = refs.length ? enrichCoverPromptWithRefs(cover.prompt, cover) : cover.prompt;
    const submitted = await withTimeout(provider.submit({
      prompt,
      refs,
      intendedRefAssetIds: cover.refAssetIds || [],
      ratio,
      // 视频成片可继续是 9:16；这里只锁定最终发布封面的原生画幅。
      // 必须传到图片代理，不能仅依赖提示词中的“3:4”。
      strictRatio: true,
      apiKey: key?.secret,
      endpoint: key?.provider,
      model: key?.model || "custom-imagemodel-gt"
    }), COVER_GENERATE_TIMEOUT_MS, "封面图提交超时");
    const output = await withTimeout(provider.poll(submitted.providerRef), COVER_GENERATE_TIMEOUT_MS, "封面图生成超时");
    cover.referenceReceipt = output.output?.referenceReceipt || submitted.referenceReceipt || null;
    if (output.status !== "succeeded" || !output.output?.dataUrl) throw new Error(output.error || "图片生成未返回结果");
    const raw = output.output.dataUrl.startsWith("data:") ? output.output.dataUrl : await coverUrlToDataUrl(output.output.dataUrl);
    const dataUrl = await polishPublishImage(raw, `${p.id}-cover-${title}`);
    const asset = await addAssetFromDataUrl(acc.id, {
      name: `视频封面_${title.slice(0, 12)}`,
      tags: ["视频封面", "站内生成", "发布前精修", "账号资产"],
      dataUrl,
      forceNew: p.customPublish === true
    });
    cover.assetId = asset.id;
    cover.status = "done";
    cover.error = "";
    cover.updatedAt = Date.now();
    save("productions");
    return true;
  } catch (err) {
    cover.status = "failed";
    cover.error = err?.message || String(err);
    if (err?.referenceReceipt) cover.referenceReceipt = err.referenceReceipt;
    cover.updatedAt = Date.now();
    save("productions");
    throw err;
  }
}

export function renderWorkshopPage(root, p) {
  liveRoot = root; liveProd = p;
  const acc = accountById(p.accountId);
  const canConfigureAccount = state.role === "admin";
  const modeChanged = enforceSupportedVideoMode(p);
  const A = p.artifacts.boards;
  let shots = p.artifacts.script.shots || [];
  p.artifacts.script.productId = primaryProductById(p.artifacts.script.productId || "dumate")?.id || "dumate";
  const product = productById(p.artifacts.script.productId || "dumate");
  const isDigital = p.subType === "数字人";
  if (!canConfigureAccount && acc) {
    p.artifacts.audio.voiceId = acc.voiceId || defaultTtsVoiceId() || "";
    p.artifacts.audio.voiceName = acc.voiceName || "";
  }
  A.digitalHuman = A.digitalHuman || { provider: "", model: "", segments: [] };
  let isDigitalHumanMode = isDigital;
  const hasAudio = () => !!p.artifacts.audio.assetId && ["tts", "upload"].includes(p.artifacts.audio.source);
  const materialPureVideo = () => isMaterial(p) && !isDigital;
  let activeInfoFlowMode = false;
  ensureInfoFlowState(p);
  if (modeChanged) save("productions");

  // 全能参考素材迁移：旧的单张统一参考图 sharedRefAssetId → omniRefAssetIds 数组（logo / 界面图可多张）
  A.omniRefAssetIds = A.omniRefAssetIds || [];
  if (!A.omniRefAssetIds.length && A.sharedRefAssetId) A.omniRefAssetIds = [A.sharedRefAssetId];
  A.sceneRefAssetIds = A.sceneRefAssetIds || [];
  if (!A.sceneRefAssetIds.length && A.omniRefAssetIds.length) A.sceneRefAssetIds = [...A.omniRefAssetIds];
  if (isDigital && !A.characterRefAssetId && acc?.charBoardAssetId) A.characterRefAssetId = acc.charBoardAssetId;
  if (!isDigital) A.characterRefAssetId = null;
  A.ratio = A.ratio || "9:16";   // 全片统一尺寸（9:16 / 16:9）

  // 估时兜底 + 单元构建
  if (!(p.artifacts.audio.perShot || []).length && shots.length) {
    Object.assign(p.artifacts.audio, estimateAudio(shots), { source: p.artifacts.audio.source || "estimate" });
    save("productions");
  }
  if (!(A.units || []).length && shots.length) { buildMaterialUnits(p); save("productions"); }
  shots = p.artifacts.script.shots || [];

  const jobOfUnit = i => {
    const u = materialUnits(p)[i];
    const list = state.jobs.filter(j => !j.superseded && j.productionId === p.id && j.segIndex === i && (!u?.videoPrompt || j.prompt === u.videoPrompt)).sort((a, b) => a.createdAt - b.createdAt);
    return list[list.length - 1] || null;
  };
  const digitalJobFor = (seg, i) => (state.jobs || []).find(j => !j.superseded && j.id === seg?.videoJobId)
    || [...(state.jobs || [])].reverse().find(j =>
      !j.superseded
      && j.productionId === p.id
      && j.kind === "video"
      && j.model === "__digital_human__"
      && (j.segmentId ? j.segmentId === seg?.id : j.segIndex === i)
    );

  const draw = () => {
    liveDraw = draw;
    isDigitalHumanMode = isDigital;
    activeInfoFlowMode = materialPureVideo();
    const infoFlow = ensureInfoFlowState(p);
    if (activeInfoFlowMode) {
      buildMaterialUnits(p);
      shots = p.artifacts.script.shots || [];
    }
    const units = materialUnits(p);
    const okCount = units.filter((u, i) => jobOfUnit(i)?.status === "succeeded").length;
    const running = units.some((u, i) => ["queued", "submitted", "running"].includes(jobOfUnit(i)?.status || ""));
    const refN = units.filter(u => u.needsImage).length;
    const sceneRefs = [...new Set([...(A.sceneRefAssetIds || []), ...(A.omniRefAssetIds || []).filter(id => id !== A.characterRefAssetId)])].map(assetById).filter(Boolean);
    const referenceAudio = A.referenceAudioAssetId ? assetById(A.referenceAudioAssetId) : null;
    const charRef = A.characterRefAssetId ? assetById(A.characterRefAssetId) : null;
    const audioAsset = p.artifacts.audio.assetId ? assetById(p.artifacts.audio.assetId) : null;
    const hasNarrationAudio = hasAudio();
    const digitalSegments = isDigitalHumanMode ? digitalSegmentsForDisplay(p, acc) : [];
    const selectedVoice = selectedVoicePreset(p, acc);
    const favoriteVoiceIds = sharedFavoriteVoiceIds();
    const voiceGroups = voicePickerGroups({ selectedId: selectedVoice.voiceId, selectedName: selectedVoice.name });
    const voiceLocked = !!(selectedVoice.voiceId && acc?.voiceId === selectedVoice.voiceId);
    const voiceFav = !!(selectedVoice.voiceId && favoriteVoiceIds.has(selectedVoice.voiceId));
    const C = p.artifacts.copy || (p.artifacts.copy = { title: "", body: "" });
    if (C.customMode !== true) {
      C.customMode = true;
      save("productions");
    }
    const customCopyMode = true;
    const cover = coverState(p);
    if (ensureDigitalCoverRoleRef(p, acc, cover)) save("productions");
    const coverAsset = cover.assetId ? assetById(cover.assetId) : null;
    const coverRefs = coverRefAssets(cover);
    const ratio = A.ratio || "9:16";
    const rtBtn = r => `<button class="ws-rt" data-ratio="${r}" aria-pressed="${ratio === r ? "true" : "false"}">${r}</button>`;
    const digitalBusy = digitalSegments.some((seg, i) => ["queued", "running", "submitted"].includes(digitalJobFor(seg, i)?.status || seg.videoStatus || ""));
    const digitalFailed = digitalSegments.some((seg, i) => (digitalJobFor(seg, i)?.status || seg.videoStatus || "") === "failed");
    const digitalAllLabel = digitalBusy ? "生成中…" : digitalFailed ? "继续生成/重试失败段" : "一键生成视频";
    const digitalPlanHtml = isDigitalHumanMode ? `<div class="dh-plan-inline">
      <div class="dh-plan-head">
        <div>
          <b>${icon("user", 13)} 数字人分段</b>
          <em>${digitalSegments.length ? `已切为 ${digitalSegments.length} 段，尽量少切，单段目标约${DIGITAL_SEGMENT_TARGET_SEC}s且不超过${DIGITAL_SEGMENT_MAX_SEC}s；每段=口播音频 + 角色图。` : `生成口播草稿后按接近${DIGITAL_SEGMENT_TARGET_SEC}s自动拆段，只有长口播才会多切。`}</em>
        </div>
        <div class="dh-plan-actions">
          <span class="ws-ratio-control" title="所有数字人片段统一这个尺寸"><em>尺寸</em>${rtBtn("9:16")}${rtBtn("16:9")}</span>
          <button class="btn gen sm" id="wsDhVideoAll" ${digitalBusy ? "disabled" : ""}>${digitalBusy ? `<span class="spin-dot"></span> ${digitalAllLabel}` : `${icon("spark", 13)} ${digitalAllLabel}`}</button>
        </div>
      </div>
      <div class="dh-segs">
        ${digitalSegments.length ? digitalSegments.map((seg, i) => {
          const ref = seg.characterRefAssetId ? assetById(seg.characterRefAssetId) : null;
          const refPoster = ref ? (urlFor(ref) || "") : "";
          const job = digitalJobFor(seg, i);
          const status = job?.status || seg.videoStatus || "";
          const busy = ["queued", "running", "submitted"].includes(status);
          const videoUrl = outputUrl(job?.output) || outputUrl(seg.videoOutput);
          const done = status === "succeeded" || !!videoUrl;
          const failed = status === "failed";
          const stateText = busy ? "生成中" : done ? "已生成" : failed ? "失败" : seg.audioAssetId ? "可生成" : "待口播";
          const jobError = failed && job?.error ? String(job.error || "") : "";
          const progress = Math.max(1, Math.min(99, Number(job?.progress || seg.videoProgress || 1)));
          const waitingText = status === "queued" ? "已进入队列" : status === "submitted" ? "已提交上游" : "正在轮询成片";
          const visibleDuration = Number(seg.audioDuration || seg.dur || 0);
          return `<div class="dh-seg ${busy ? "is-generating" : ""}" data-dh-seg="${seg.id}">
            <b>D${String(i + 1).padStart(2, "0")}</b><span>${fmtTC(visibleDuration)}</span>
            <em>${ref ? esc(ref.name) : "未设置角色图"}</em><i class="dh-status ${busy ? "running" : done ? "done" : failed ? "failed" : ""}">${stateText}</i>
            <div class="dh-seg-drop ${canConfigureAccount ? "droppable" : "is-locked"}" ${canConfigureAccount ? `data-unit-char-ref="${seg.id}"` : ""}>${ref ? thumbHtml(ref) : icon(canConfigureAccount ? "upload" : "lock", 13)}<span>${canConfigureAccount ? "单段角色图" : "账号固定角色"}</span></div>
            ${seg.audioAssetId && assetById(seg.audioAssetId) ? `<audio class="dh-audio" src="${esc(urlFor(assetById(seg.audioAssetId)))}" controls preload="metadata"></audio>` : `<small class="dh-audio-miss">未生成分段音频</small>`}
            ${videoUrl
              ? `<video class="dh-video" src="${esc(videoUrl)}" ${refPoster ? `poster="${esc(refPoster)}"` : ""} controls playsinline preload="metadata"></video>`
              : busy ? `<div class="dh-video-placeholder">
                <span class="spin-dot"></span>
                <b>视频生成中</b>
                <em>${esc(waitingText)} · ${progress}%</em>
                <i><b style="width:${progress}%"></b></i>
              </div>` : `<div class="dh-video-placeholder idle">
                ${icon("film", 18)}
                <b>${seg.audioAssetId ? "等待生成视频" : "等待口播音频"}</b>
                <em>${seg.audioAssetId ? "生成后会在这里预览" : "先生成分段口播后再提交"}</em>
              </div>`}
            ${jobError ? `<small class="dh-error">${esc(jobError)}</small>` : ""}
            <div class="dh-seg-actions">
              <button class="btn ghost sm" data-dh-regen="${seg.id}">${icon("refresh", 11)} 重新生成</button>
              <button class="btn primary sm" data-dh-video="${seg.id}" ${busy ? "disabled" : ""}>${busy ? "生成中…" : done ? "重新生成视频" : "生成视频"}</button>
            </div>
          </div>`;
        }).join("") : `<div class="dh-plan-empty">${icon("mic", 18)}<b>尚未创建数字人分段</b><em>点击“一键生成视频”后，系统会先用账号固定声线生成口播，再按接近 30 秒智能分段。</em></div>`}
      </div>
    </div>` : "";
    root.innerHTML = `
      ${stepperHtml(p, "workshop")}
      <div class="chain-page solo workshop-chain-page">
        <div class="chain-main">
          ${isDigital && canConfigureAccount ? `<div class="refbar card" id="wsCharbar">
            <div class="refbar-left">
              <b>${icon("user", 13)} 角色形象</b>
              <em>数字人默认每段都参考这张角色图；单段可覆盖专属角色形象。</em>
            </div>
            <div class="refbar-chip">${charRef
              ? `<span class="ref-chip">${thumbHtml(charRef)}<span>${esc(charRef.name)}</span><button class="ref-x" data-chardel>${icon("x", 11)}</button></span>`
              : `<span class="muted">未设置，可拖拽角色形象图到此</span>`}</div>
            <div class="refbar-actions">
              <label class="btn ghost sm">上传角色形象<input type="file" accept="image/*" hidden id="wsCharUp" /></label>
            </div>
          </div>` : ""}

          ${!isDigitalHumanMode && !activeInfoFlowMode ? `<div class="refbar card" id="wsRefbar">
            <div class="refbar-left">
              <b>${icon("star", 13)} 场景 / 产品参考图</b>
              <em>${esc(product?.shortName || "产品")} logo、界面、场景光线与桌面风格从这里参考；支持拖拽图片，只影响画面参考</em>
            </div>
            <div class="refbar-chip">${sceneRefs.length
              ? sceneRefs.map(a => `<span class="ref-chip">${thumbHtml(a)}<span>${esc(a.name)}</span><button class="ref-x" data-omnidel="${a.id}">${icon("x", 11)}</button></span>`).join("")
              : ""}${referenceAudio ? `<span class="ref-chip is-audio">${icon("pulse", 13)}<span>${esc(referenceAudio.name)}</span><button class="ref-x" data-reference-audio-del>${icon("x", 11)}</button></span>` : ""}${!sceneRefs.length && !referenceAudio ? `<span class="muted">可拖入图片或 MP3 总参考音频</span>` : ""}</div>
            <div class="refbar-actions">
              <button class="btn ghost sm" id="wsRefPick">从资产选择</button>
              <label class="btn ghost sm">上传<input type="file" accept="image/*,.mp3,audio/mpeg" multiple hidden id="wsRefUp" /></label>
            </div>
          </div>
          <div id="wsRefChooser" class="ref-chooser card" hidden></div>` : ""}

          <div class="refbar card video-briefbar video-brief-coverbar ${activeInfoFlowMode ? "no-narration" : ""} ${isDigitalHumanMode ? "is-digital-human" : ""} ${customCopyMode ? "custom-copy-mode" : "standard-copy-mode"}" id="wsBriefbar">
            ${customCopyMode ? "" : `<div class="refbar-left">
              <b>${icon("fileText", 13)} 创作主题 / 发布文案</b>
              <em>主题、发布文案和封面统一在这里定稿；封面跟随标题与正文生成</em>
            </div>`}
            <div class="refbar-chip ws-brief-fields">
              <div class="ws-topic-row ${customCopyMode ? "is-custom" : "is-standard"}">
                ${customCopyMode ? `<div class="ws-brief-heading">
                  <b>${icon("fileText", 13)} 创作主题 / 发布文案</b>
                  <em>主题、发布文案和封面统一在这里定稿；封面跟随标题与正文生成</em>
                </div>` : ""}
                ${customCopyMode ? "" : `<div class="input-with-action"><input class="input" id="wsTopic" value="${esc(p.topic || "")}" placeholder="详细写创作主题，例如：AI工作流提效、Skill速通、资料整理对比" /><button class="icon-btn sm" id="wsDice" title="随机创作内容">${icon("dice", 13)}</button></div>`}
                <div class="ws-topic-actions">
                  <button class="btn gen sm" id="wsBriefGenerate">${icon("spark", 13)} 一键生成</button>
                  <button class="btn primary button-anthe" id="wsNext"><span>下一步：智能混剪 ${icon("arrowRight", 14)}</span></button>
                </div>
              </div>
              <div class="ws-copy-fields">
                <textarea class="input ws-copy-title" id="wsCopyTitle" rows="2" required placeholder="发布标题（必填），例如：国产桌面智能体，1分钟上手讲清楚">${esc(C.title || "")}</textarea>
                <textarea class="input" id="wsCopyBody" rows="4" placeholder="按口播内容总结成发布简介，可直接修改">${esc(C.body || "")}</textarea>
              </div>
              ${activeInfoFlowMode ? "" : `<div class="ws-narration-inline">
                <div class="ws-inline-head">
                  <div class="ws-inline-label">
                    <b>${icon("list", 13)} 口播草稿</b>
                    <em>${materialPureVideo() ? "素材号视频只生成纯画面；这里用于后期字幕和混剪" : "数字人和真人视频会把口播写入对应时间结构"}</em>
                  </div>
                  <div class="ws-brief-actions">
                    <button class="btn dark sm" id="wsDraft">${icon("spark", 13)} ${(shots || []).length ? "一键重生成" : "一键生成"}</button>
                    <button class="btn ghost sm" id="wsCopyGen">按口播生成文案</button>
                    <button class="btn ghost sm" id="wsCopyLines">${icon("list", 13)} 复制口播</button>
                  </div>
                </div>
                <textarea class="input" id="wsNarrationText" rows="4" placeholder="一键生成后可在这里修改；也可以直接粘贴自定义口播，每行一句">${esc(narrationText(shots))}</textarea>
              </div>`}
              <div class="ws-cover-inline ${cover.status === "loading" ? "is-loading" : ""}" id="wsCoverBar">
                <button class="cover-frame ${coverAsset ? "has-cover" : ""} ${cover.status === "loading" ? "is-loading" : ""}" id="wsCoverStage" type="button" aria-label="${coverAsset ? "预览封面图" : "拖入或点击上传封面图"}">
                  ${cover.status === "loading"
                    ? `<div class="cover-loading"><span></span><b>封面生成中</b><em>3:4</em></div>`
                    : coverAsset
                      ? `${thumbHtml(coverAsset)}<span>点击预览</span>`
                      : `<div class="cover-empty"><b>3:4</b><em>封面预览</em></div>`}
                </button>
                <div class="ws-cover-fields">
                  <div class="ws-cover-toolbar">
                    <div class="ws-cover-label"><b>${icon("image", 12)} 封面图</b><em>拖到右侧预览位可直接设为封面；拖到此区域会加入参考图</em></div>
                    <div class="ws-cover-actions">
                      <button class="btn ghost sm" id="wsCoverGen">${cover.status === "loading" ? "生成中…" : `${icon("spark", 13)} 生成封面`}</button>
                      <label class="btn ghost sm">上传参考<input type="file" accept="image/*" multiple hidden id="wsCoverRefUp" /></label>
                      <label class="btn ghost sm">${coverAsset ? "替换封面" : "上传封面"}<input type="file" accept="image/*" hidden id="wsCoverUpload" /></label>
                    </div>
                  </div>
                  <textarea class="input" id="wsCoverPrompt" rows="2" placeholder="补充封面风格或参考要求；系统只把发布标题作为封面主文字">${esc(cover.prompt || "")}</textarea>
                  <div class="cover-ref-strip">
                    ${coverRefs.length ? coverRefs.map(a => `<span class="ref-chip">${thumbHtml(a)}<span>${esc(a.name)}</span><button class="ref-x" data-cover-ref-rm="${a.id}">${icon("x", 11)}</button></span>`).join("") : `<span class="muted">未设置封面参考图</span>`}
                  </div>
                  ${referenceReceiptLabel(cover.referenceReceipt) ? `<div class="${Number(cover.referenceReceipt?.usedRefs || 0) > 0 ? "muted" : "sc-error"}">${esc(referenceReceiptLabel(cover.referenceReceipt))}</div>` : ""}
                  ${cover.error ? `<div class="sc-error">${esc(cover.error)}</div>` : ""}
                </div>
              </div>
            </div>
          </div>

          ${activeInfoFlowMode ? "" : `<div class="refbar card" id="wsAudioBar">
            <div class="refbar-left">
              <b>${icon("mic", 13)} 口播音频</b>
            </div>
            <div class="refbar-chip"></div>
            <div class="refbar-actions voice-audio-actions">
              <div class="voice-main-controls">
                ${(!isDigital || isDigitalHumanMode) && canConfigureAccount ? voicePickerHtml({ selected: selectedVoice, groups: voiceGroups, favoriteIds: favoriteVoiceIds, lockedVoiceId: acc?.voiceId || "" }) : ""}
                ${(!isDigital || isDigitalHumanMode) && canConfigureAccount ? `<div class="voice-id-search">
                  <input class="input sm" id="wsVoiceId" value="${esc(selectedVoice.voiceId || "")}" placeholder="粘贴 / 搜索 voice_id" />
                  <button class="btn ghost sm" id="wsVoiceLookup">${icon("search", 12)} 识别</button>
                </div>` : (!isDigital || isDigitalHumanMode) ? `<div class="voice-account-fixed">${icon("lock", 13)}<span><b>${esc(selectedVoice.name || "账号默认声线")}</b><em>管理员已固定，生成时自动使用</em></span></div>` : ""}
              </div>
              <div class="voice-side-actions">
                ${(!isDigital || isDigitalHumanMode) && canConfigureAccount ? `<button class="btn ghost sm voice-fav-btn ${voiceFav ? "voice-action-active" : ""}" id="wsVoiceFav">${icon("star", 12)} ${voiceFav ? "已收藏" : "收藏"}</button>` : ""}
                <div class="voice-stacked-actions">
                  ${(!isDigital || isDigitalHumanMode) && canConfigureAccount ? `<button class="btn ghost sm ${voiceLocked ? "voice-action-active" : ""}" id="wsVoiceFix">${icon("check", 12)} ${voiceLocked ? "已锁定" : "固定到账号"}</button>` : ""}
                  ${!isDigital || isDigitalHumanMode ? `<button class="btn ghost sm" id="wsTts">${icon("mic", 13)} ${isDigitalHumanMode ? "生成分段口播" : (audioAsset && p.artifacts.audio.source === "tts" ? "重新生成口播" : "生成口播音频")}${ttsApiConfigured() ? "" : "（估时）"}</button>` : ""}
                  ${!isDigital || isDigitalHumanMode ? `<label class="btn ghost sm">${audioAsset ? "重新上传" : "上传口播音频"}<input type="file" accept="audio/*" hidden id="wsAudioUp" /></label>` : ""}
                </div>
              </div>
            </div>
            <div class="voice-lookup-note" id="wsVoiceLookupNote" style="grid-column:1/-1" ${p.artifacts.audio.voiceLookup ? "" : "hidden"}>${esc(p.artifacts.audio.voiceLookup || "")}</div>
            ${audioAsset && !isDigitalHumanMode ? `<div class="tts-audio" style="grid-column:1/-1;margin-top:10px;display:flex;align-items:center;gap:10px">
              <span class="muted" style="font-size:12px">口播预览</span>
              <audio src="${esc(urlFor(audioAsset))}" controls preload="metadata" style="width:min(520px,100%);height:34px"></audio>
            </div>` : ""}
            ${digitalPlanHtml}
          </div>`}

          ${isDigitalHumanMode ? "" : activeInfoFlowMode ? infoFlowPanel(infoFlow, sceneRefs, referenceAudio) : `
            <div class="inhouse-controls">
              <button class="btn gen" id="wsAuto">${icon("spark", 15)} ${running ? "生成中…" : okCount === units.length && units.length ? "全部片段已就绪" : "一键全自动编排出片"}</button>
              <button class="btn ghost" id="wsGenPrompts">${icon("list", 14)} 仅生成提示词</button>
              <span class="muted">${isDigital ? "真人链路：提示词会把每句口播放进对应时间结构" : hasNarrationAudio ? "已有口播音频：视频提示词不再写口播，后期混剪合入音频" : "素材号视频保持纯画面，请先生成/上传口播音频后混剪"}</span>
            </div>

            <div class="ws-cards" id="wsCards">
              ${units.map((u, i) => unitCard(u, i, jobOfUnit(i))).join("") ||
                `<div class="empty-state slim">${icon("layers", 22)}<b>先生成口播草稿</b><p>在上方输入创作主题，直接生成可拆分的分镜单元</p></div>`}
            </div>
          `}
        </div>
      </div>`;
    if (isDigitalHumanMode) {
      const audioBar = $("#wsAudioBar", root);
      const charBar = $("#wsCharbar", root);
      const pageHead = $(".page-head", root);
      if (audioBar) (charBar || pageHead)?.after(audioBar);
      const briefBar = $("#wsBriefbar", root);
      const digitalPlan = $(".dh-plan-inline", root);
      const coverBar = $("#wsCoverBar", root);
      if (digitalPlan && briefBar) briefBar.after(digitalPlan);
      if (coverBar && digitalPlan) {
        coverBar.classList.add("card", "is-detached-cover");
        digitalPlan.after(coverBar);
      }
    }
    wireStepper(root);
    wire();
  };

  function infoFlowPanel(infoFlow, sceneRefs = [], referenceAudio = null) {
    const segs = (infoFlow.segments || []).length
      ? infoFlow.segments
      : [
        { id: "front15", label: "前15s", title: "前15s钩子", videoPrompt: "", caption: "用一个强冲突开场，快速把观众停住", duration: 15 },
        { id: "back15", label: "后15s", title: "后15s功能演示", videoPrompt: "", caption: "功能演示要和前面呼应，产品动作必须具体", duration: 15 }
      ];
    const infoRatio = A.ratio || "9:16";
    const infoRatioButton = r => `<button class="ws-rt" data-ratio="${r}" aria-pressed="${infoRatio === r ? "true" : "false"}">${r}</button>`;
    const videoItems = segs.slice(0, 2).map((seg, i) => {
      const job = jobOfUnit(i);
      const status = job?.status || "";
      const busy = ["queued", "submitted", "running"].includes(status);
      const done = status === "succeeded";
      const failed = status === "failed";
      return { seg, i, job, status, busy, done, failed, videoUrl: done ? (job.output?.url || "") : "" };
    });
    const hasVideoJobs = videoItems.some(x => x.job);
    const busyVideos = videoItems.filter(x => x.busy).length;
    const doneVideos = videoItems.filter(x => x.done).length;
    const failedVideos = videoItems.filter(x => x.failed).length;
    const infoVideoRunning = busyVideos > 0;
    const infoVideoDone = videoItems.length > 0 && doneVideos === videoItems.length;
    const infoVideoFailed = failedVideos > 0;
    const infoVideoLabel = infoVideoRunning
      ? "生成中…"
      : infoVideoDone
        ? "重新生成信息流视频"
        : infoVideoFailed
          ? "重试信息流视频"
          : "生成信息流视频";
    const videoState = infoVideoFailed
      ? ["failed", "有片段失败", "失败原因会显示在对应片段卡片，可直接重试生成。"]
      : infoVideoRunning
        ? ["running", "信息流视频生成中", "前15s和后15s片段已进入队列，完成后这里会自动换成视频预览。"]
        : infoVideoDone
          ? ["done", "信息流视频已生成", "两个片段都已就绪，可以继续进入剪辑或回看。"]
          : ["queued", "信息流片段已提交", "如果上游较慢，会先显示占位和进度，完成后自动出现预览。"];
    return `<div class="infoflow-panel card" id="wsInfoFlow">
      <div class="infoflow-head">
        <div>
          <b>${icon("film", 14)} 信息流</b>
          <em>标题与文案生成 A/B 面时间轴提示词；所选参考图直接随前后两段视频提交，不再经过分镜图中转。</em>
        </div>
        <div class="infoflow-actions">
          <span class="ws-ratio-control" title="前后两段统一这个尺寸"><em>尺寸</em>${infoRatioButton("9:16")}${infoRatioButton("16:9")}</span>
          <button class="btn ghost sm" id="wsInfoPlan">${icon("refresh", 13)} 重新生成提示词</button>
          <button class="btn gen sm" id="wsInfoVideo" ${infoVideoRunning ? "disabled" : ""}>${infoVideoRunning ? `<span class="spin-dot"></span> ${infoVideoLabel}` : `${icon("film", 13)} ${infoVideoLabel}`}</button>
        </div>
      </div>
      ${infoFlow.error ? `<div class="sc-error">${esc(infoFlow.error)}</div>` : ""}
      <div class="infoflow-ref-row" id="wsInfoFlowRefs">
        <div>
          <b>${icon("star", 13)} 产品 / 界面参考</b>
          <em>${esc(product?.shortName || "产品")} logo、界面、角色和场景从这里参考；提交时会直接带入前后两段视频。</em>
        </div>
        <div class="refbar-chip">${sceneRefs.length
          ? sceneRefs.map(a => `<span class="ref-chip">${thumbHtml(a)}<span>${esc(a.name)}</span><button class="ref-x" data-omnidel="${a.id}">${icon("x", 11)}</button></span>`).join("")
          : ""}${referenceAudio ? `<span class="ref-chip is-audio">${icon("pulse", 13)}<span>${esc(referenceAudio.name)}</span><button class="ref-x" data-reference-audio-del>${icon("x", 11)}</button></span>` : ""}${!sceneRefs.length && !referenceAudio ? `<span class="muted">可拖入产品图或 MP3，总参考会用于每段视频</span>` : ""}</div>
        <div class="refbar-actions">
          <button class="btn ghost sm" id="wsRefPick">从资产选择</button>
          <label class="btn ghost sm">上传<input type="file" accept="image/*,.mp3,audio/mpeg" multiple hidden id="wsRefUp" /></label>
        </div>
      </div>
      <div id="wsRefChooser" class="ref-chooser card" hidden></div>
      <div class="infoflow-segment-list">
        ${segs.slice(0, 2).map((seg, i) => {
          const video = videoItems[i] || {};
          const canSubmit = !video.busy && String(seg.videoPrompt || "").trim();
          const regenLabel = video.failed ? "重试本段" : video.done ? "重生本段" : "生成本段";
          const stateText = video.busy ? (video.status === "queued" ? "排队中" : `生成 ${Math.max(1, Math.round(video.job?.progress || 1))}%`) : video.done ? "已生成" : video.failed ? "生成失败" : "等待生成";
          const err = video.failed && video.job?.error ? String(video.job.error || "").slice(0, 100) : "";
          return `<div class="if-segment-row ${i === 1 ? "back" : "front"}" data-ws="${i}">
            <div class="if-segment-copy">
              <div class="if-card-top">
                <span>${esc(seg.label || (i === 0 ? "前15s" : "后15s"))}</span>
                <b>${esc(seg.title || (i === 0 ? "前15s钩子" : "后15s功能演示"))}</b>
                <em>${fmtTC(seg.duration || 15)}</em>
              </div>
              <p>${esc(seg.caption || (i === 0 ? "强钩子 / 角色冲突 / 快切" : "功能演示 / 直接参考 / 产品呼应"))}</p>
              <div class="if-segment-editor">
                <textarea class="input" rows="9" data-if-prompt="${i}" placeholder="${i === 0 ? "前15s导演提示词" : "后15s导演提示词，会直接使用所选参考图"}">${esc(seg.videoPrompt || "")}</textarea>
                <div class="if-segment-media ${video.busy ? "running" : video.done ? "done" : video.failed ? "failed" : ""}">
                  ${video.videoUrl
                    ? `<div class="if-video-frame has-video"><video src="${esc(video.videoUrl)}" controls playsinline preload="metadata"></video></div>`
                    : `<div class="if-video-placeholder">${video.busy ? `<span class="if-video-pulse"></span>` : icon(video.failed ? "alert" : "film", 22)}<b>${esc(seg.label || (i === 0 ? "前15s" : "后15s"))}视频</b><em>${esc(stateText)}</em></div>`}
                  ${err ? `<small>${esc(err)}</small>` : ""}
                </div>
              </div>
              <div class="if-card-actions">
                <span>${stateText}</span>
                <button class="btn ghost sm" data-if-seg-video="${i}" ${canSubmit ? "" : "disabled"}>${video.busy ? `<span class="spin-dot"></span> 生成中` : `${icon("refresh", 12)} ${regenLabel}`}</button>
              </div>
            </div>
          </div>`;
        }).join("")}
      </div>
      ${hasVideoJobs ? `<div class="if-video-status compact ${videoState[0]}">
        <div class="if-video-summary">
          ${infoVideoRunning ? `<span class="if-video-pulse"></span>` : icon(infoVideoDone ? "checkCircle" : infoVideoFailed ? "alert" : "film", 15)}
          <b>${videoState[1]}</b>
          <em>${videoState[2]}</em>
        </div>
      </div>` : ""}
    </div>`;
  }

  function unitCard(u, i, job) {
    const us = unitShots(p, u);
    const isRef = u.needsImage;   // 全能参考（含 logo/界面）
    const dur = Math.min(15, Math.ceil(u.dur || 4));
    const ok = job && job.status === "succeeded";
    const videoUrl = ok ? (job.output?.url || "") : "";
    const partLabel = u.sceneParts > 1 ? `·${u.part}` : "";
    let jobHtml = "";
    if (!job) jobHtml = `<button class="btn ghost sm" data-wsgen="${i}">${icon("film", 13)} 生成视频</button>`;
    else if (["queued", "submitted", "running"].includes(job.status))
      jobHtml = `<div class="wsj run"><span class="spin-dot"></span> ${job.status === "queued" ? "排队中" : `渲染 ${job.progress}%`}<i class="wsj-bar"><b style="width:${job.progress}%"></b></i></div>`;
    else if (ok)
      jobHtml = `<div class="wsj ok">${icon("checkCircle", 13)} 片段就绪 · ${dur}s</div>`;
    else
      jobHtml = `<div class="wsj fail">${icon("alert", 13)} ${esc((job.error || "失败").slice(0, 18))}<button class="link-btn" data-wsgen="${i}">${icon("refresh", 11)} 重试</button></div>`;

    const busy = job && ["queued", "submitted", "running"].includes(job.status);
    return `<div class="ws-card card ${isRef ? "i2v" : "t2v"} ${busy ? "is-generating" : ""}" data-ws="${i}">
      <div class="ws-head">
        <span class="sc-num">S${String(u.scene).padStart(2, "0")}${partLabel}</span>
        <b>${us.length > 1 ? `连贯 ${us.length} 镜` : esc(us[0]?.idea || "分镜")}</b>
        <span class="ws-mode ${isRef ? "i2v" : "t2v"}">${isRef ? icon("star", 11) + " 全能参考" : icon("film", 11) + " 文生视频"}</span>
        <span class="ws-dur ${u.dur >= 15 ? "cap" : ""}">${icon("clock", 11)} ${dur}s${u.sceneParts > 1 ? " · 已按15s拆分" : ""}</span>
      </div>
      <div class="ws-align">
        <div class="ws-al-head">${icon("mic", 11)} 口播 ↔ 画面对齐 <em class="muted">混剪时字幕按此逐句对齐</em></div>
        ${alignRows(u, us)}
      </div>
      <div class="ws-body single ${ok ? "has-prev" : ""}">
        <div class="ws-col">
          <div class="ws-label">视频提示词 <em class="muted">${isRef ? "全能参考 · " : ""}${us.length > 1 ? "多镜头连贯 · " : ""}${dur}s 分段，负面约束只放末尾</em></div>
          <div class="sc-prompt" contenteditable="true" data-wsv="${i}" data-ph="点上方「仅生成提示词」自动填入">${esc(u.videoPrompt || "")}</div>
          ${isRef ? `<div class="muted" style="margin-top:6px;font-size:11px;display:flex;align-items:center;gap:4px">${icon("star", 10)} 生成时自动附上统一参考图（角色 / logo / 界面），无需逐镜出图</div>` : ""}
          <div class="ws-jobrow">${jobHtml}</div>
        </div>
        ${ok ? `
        <div class="ws-col ws-prevcol">
          <div class="ws-label">成片预览 <em class="muted">${videoUrl ? "真实成片" : "等待回链"}</em></div>
          <div class="ws-prev-frame ${videoUrl ? "has-video" : ""}" data-wsprev="${i}" ${videoUrl ? `data-video-url="${esc(videoUrl)}"` : ""} ${videoUrl ? "" : `style="background:${gradFor(u.videoPrompt || ("S" + u.scene))}"`}>
            ${videoUrl
              ? `<video src="${esc(videoUrl)}" controls playsinline preload="metadata"></video>`
              : `<span class="ws-prev-play">${icon("play", 18)}</span>`}
            <span class="ws-prev-dur">${dur}s</span>
          </div>
          <div class="ws-prev-acts">
            <button class="btn ghost sm" data-wsgen="${i}">${icon("refresh", 11)} 重生成</button>
          </div>
        </div>` : ""}
      </div>
    </div>`;
  }

  /* 口播↔画面对齐：每镜的时间区间 + 口播原句 + 画面要点（单元内累计计时） */
  function alignRows(u, us) {
    const per = p.artifacts.audio.perShot || [];
    let t = 0;
    return (u.shotIndexes || []).map((si, k) => {
      const s = us[k] || {};
      const d = (per[si] && per[si].dur) || 3;
      const a = t, b = t + d; t = b;
      return `<div class="ws-al"><em>${a.toFixed(1)}-${b.toFixed(1)}s</em><b>${esc((s.line || "").trim() || "（无口播）")}</b><span>${esc((s.visual || s.idea || "").slice(0, 38))}</span></div>`;
    }).join("");
  }

  async function ensurePrompts(force = false) {
    syncNarrationFromEditor({ silent: true });
    const units = materialUnits(p);
    if (isDigitalHumanMode) {
      applyDigitalFixedPrompts(units);
      save("productions");
      return;
    }
    const pureVideoByPolicy = materialPureVideo();
    const hasVoiceConflict = pureVideoByPolicy && units.some(u => /口播(?:原话)?[:：]|画外音|旁白|人声|声音参考|声线/.test(u.videoPrompt || ""));
    if (!force && units.every(u => u.videoPrompt) && !hasVoiceConflict) return;
    if (hasVoiceConflict) units.forEach(u => { u.videoPrompt = ""; });
    const res = await AI.generateUnitPrompts({
      units, shots, account: acc, style: p.artifacts.script.style,
      product: productById(p.artifacts.script.productId || "dumate"),
      hasNarrationAudio: isDigital ? false : (pureVideoByPolicy || hasAudio()),
      hasVoiceRef: false,
      hasCharacterRef: false,
      hasSceneRef: !!((A.sceneRefAssetIds || []).length || (A.omniRefAssetIds || []).filter(id => id !== A.characterRefAssetId).length)
    });
    units.forEach((u, i) => {
      const r = res.units[i] || {};
      if (force || !u.videoPrompt) u.videoPrompt = r.videoPrompt || u.videoPrompt;
    });
    save("productions");
  }

  function applyDigitalFixedPrompts(units = materialUnits(p)) {
    units.forEach(u => {
      u.videoPrompt = DIGITAL_HUMAN_FIXED_PROMPT;
      u.needsImage = true;
    });
    A.digitalHuman = A.digitalHuman || {};
    A.digitalHuman.fixedPrompt = DIGITAL_HUMAN_FIXED_PROMPT;
  }

  async function synthesizeDigitalSegmentAudio(voiceId) {
    const segs = digitalSegmentsFromShots(p, acc);
    if (!segs.length) throw new Error("没有可生成的数字人口播分段");
    if (!ttsApiConfigured()) {
      const existingCount = segs.filter(seg => seg.audioAssetId && assetById(seg.audioAssetId)).length;
      Object.assign(p.artifacts.audio, estimateAudio(shots), {
        assetId: null,
        source: existingCount ? "tts-segments" : "estimate",
        voiceId,
        lastError: "服务器未配置 Minimax TTS，已保留原有分段音频"
      });
      segs.forEach(seg => { if (!seg.audioAssetId) seg.status = "estimate"; });
      A.digitalHuman.segments = segs;
      return { count: existingCount, duration: p.artifacts.audio.duration || 0, changed: false };
    }
    let total = 0;
    let changed = false;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const previousAudioAssetId = seg.audioAssetId || null;
      const text = safeTtsText(seg.line || "");
      if (!text) continue;
      const out = await synthesizeTts({ text, voiceId, speed: 1.2 });
      const a = await addAssetFromDataUrl(acc.id, {
        name: `数字人口播_D${String(i + 1).padStart(2, "0")}_${(p.title || p.topic || "视频").slice(0, 8)}`,
        type: "音频",
        tags: ["口播音频", "Minimax", "数字人分段", "账号资产"],
        dataUrl: out.audioDataUrl
      });
      seg.audioAssetId = a.id;
      const measuredDuration = await audioDuration(urlFor(a) || a.fileUrl || "");
      seg.audioDuration = Math.round((measuredDuration || out.duration || seg.dur || 0) * 10) / 10;
      seg.voiceId = out.voiceId || voiceId;
      seg.status = "audioReady";
      seg.videoStatus = "pending";
      seg.videoOutput = null;
      seg.videoJobId = null;
      changed = changed || previousAudioAssetId !== a.id;
      A.digitalHuman.segments = segs;
      save("productions");
      await persistNow();
      if (previousAudioAssetId && previousAudioAssetId !== a.id) await removeAsset(previousAudioAssetId);
      total += seg.audioDuration || seg.dur || 0;
    }
    A.digitalHuman.segments = segs;
    Object.assign(p.artifacts.audio, {
      assetId: null,
      duration: Math.round(total * 10) / 10,
      source: "tts-segments",
      voiceId,
      voiceRefAssetId: null,
      lastError: "",
      segmentsReady: true
    });
    return { count: segs.filter(x => x.audioAssetId).length, duration: total, changed };
  }

  async function ensureDigitalAudioForVideo(voiceId) {
    const planned = planDigitalNarrationSegments(shots);
    const existing = digitalSegmentsForDisplay(p, acc);
    const audioSignature = segments => JSON.stringify((segments || []).map(seg => [
      seg.id || "",
      seg.audioAssetId || "",
      Number(seg.audioDuration || 0),
      String(seg.line || "")
    ]));
    const beforeAudioSignature = audioSignature(existing);
    const canSafelyReplan = planned.length > 0
      && existing.length > planned.length
      && existing.every(seg => !seg.videoJobId
        && !seg.videoOutput?.url
        && !seg.videoOutput?.videoUrl
        && !["queued", "running", "succeeded"].includes(seg.videoStatus));
    const backup = canSafelyReplan
      ? existing.map(seg => ({ ...seg, shotIndexes: [...(seg.shotIndexes || [])] }))
      : null;
    if (backup) {
      A.digitalHuman = A.digitalHuman || { segments: [] };
      A.digitalHuman.segments = [];
      p.artifacts.audio.segmentsReady = false;
    }
    try {
      let segs = digitalSegmentsForDisplay(p, acc);
      const ready = segs.length && segs.every(seg => seg.audioAssetId && assetById(seg.audioAssetId));
      const result = ready
        ? { count: segs.length, duration: segs.reduce((sum, seg) => sum + Number(seg.audioDuration || seg.dur || 0), 0), changed: false }
        : await synthesizeDigitalSegmentAudio(voiceId);
      segs = digitalSegmentsForDisplay(p, acc);
      if (backup && (!result.count || !segs.every(seg => seg.audioAssetId && assetById(seg.audioAssetId)))) {
        const backupIds = new Set(backup.map(seg => seg.audioAssetId).filter(Boolean));
        const partialIds = segs.map(seg => seg.audioAssetId).filter(id => id && !backupIds.has(id));
        A.digitalHuman.segments = backup;
        p.artifacts.audio.segmentsReady = backup.some(seg => seg.audioAssetId && assetById(seg.audioAssetId));
        await Promise.all(partialIds.map(id => removeAsset(id).catch(() => {})));
        return { ...result, count: 0, restored: true };
      }
      if (backup) {
        const currentIds = new Set(segs.map(seg => seg.audioAssetId).filter(Boolean));
        const retiredIds = backup.map(seg => seg.audioAssetId).filter(id => id && !currentIds.has(id));
        await Promise.all(retiredIds.map(id => removeAsset(id).catch(() => {})));
      }
      const changed = result.changed || audioSignature(segs) !== beforeAudioSignature;
      if (changed) invalidateDerivedMediaAfterDigitalAudioChange();
      return { ...result, changed };
    } catch (error) {
      const partial = digitalSegmentsForDisplay(p, acc);
      if (backup) {
        const backupIds = new Set(backup.map(seg => seg.audioAssetId).filter(Boolean));
        const partialIds = partial.map(seg => seg.audioAssetId).filter(id => id && !backupIds.has(id));
        A.digitalHuman.segments = backup;
        p.artifacts.audio.segmentsReady = backup.some(seg => seg.audioAssetId && assetById(seg.audioAssetId));
        await Promise.all(partialIds.map(id => removeAsset(id).catch(() => {})));
        save("productions");
      }
      if (audioSignature(digitalSegmentsForDisplay(p, acc)) !== beforeAudioSignature) {
        invalidateDerivedMediaAfterDigitalAudioChange();
        save("productions");
      }
      throw error;
    }
  }

  async function synthesizeOneDigitalSegment(segId, voiceId) {
    const segs = digitalSegmentsForDisplay(p, acc);
    const index = segs.findIndex(x => x.id === segId);
    const seg = segs[index];
    if (!seg) throw new Error("未找到数字人分段");
    const text = safeTtsText(seg.line || "");
    if (!text) throw new Error("该段没有口播内容");
    if (!ttsApiConfigured()) {
      if (!seg.audioAssetId) seg.status = "estimate";
      A.digitalHuman.segments = segs;
      Object.assign(p.artifacts.audio, estimateAudio(shots), {
        assetId: null,
        source: seg.audioAssetId ? "tts-segments" : "estimate",
        voiceId,
        voiceRefAssetId: null,
        lastError: "服务器未配置 Minimax TTS，已保留原有分段音频"
      });
      return { count: seg.audioAssetId ? 1 : 0, duration: seg.audioDuration || seg.dur || 0 };
    }
    const previousAudioAssetId = seg.audioAssetId || null;
    const out = await synthesizeTts({ text, voiceId, speed: 1.2 });
    const a = await addAssetFromDataUrl(acc.id, {
      name: `数字人口播_D${String(index + 1).padStart(2, "0")}_${(p.title || p.topic || "视频").slice(0, 8)}`,
      type: "音频",
      tags: ["口播音频", "Minimax", "数字人分段", "账号资产"],
      dataUrl: out.audioDataUrl
    });
    seg.audioAssetId = a.id;
    const measuredDuration = await audioDuration(urlFor(a) || a.fileUrl || "");
    seg.audioDuration = Math.round((measuredDuration || out.duration || seg.dur || 0) * 10) / 10;
    seg.voiceId = out.voiceId || voiceId;
    seg.status = "audioReady";
    seg.videoStatus = "pending";
    seg.videoOutput = null;
    seg.videoJobId = null;
    A.digitalHuman.segments = segs;
    save("productions");
    await persistNow();
    if (previousAudioAssetId && previousAudioAssetId !== a.id) await removeAsset(previousAudioAssetId);
    const total = segs.reduce((sum, x) => sum + Number(x.audioDuration || x.dur || 0), 0);
    Object.assign(p.artifacts.audio, {
      assetId: null,
      duration: Math.round(total * 10) / 10,
      source: "tts-segments",
      voiceId,
      voiceRefAssetId: null,
      lastError: "",
      segmentsReady: segs.some(x => x.audioAssetId)
    });
    invalidateDerivedMediaAfterDigitalAudioChange();
    return { count: 1, duration: seg.audioDuration || seg.dur || 0, changed: true };
  }

  function prepareDigitalVideoSegments(ids = null) {
    const segs = persistDigitalSegmentsForCurrentState(p, acc);
    const pick = ids ? segs.filter(x => ids.includes(x.id)) : segs;
    if (!pick.length) {
      const hasSegmentAudio = (A.digitalHuman?.segments || []).some(x => x.audioAssetId && assetById(x.audioAssetId));
      toast(hasSegmentAudio ? "已检测到旧分段口播，但当前按钮指向的片段已刷新；请再点一次生成视频" : "先生成口播草稿并切分数字人片段");
      return false;
    }
    const missingAudio = pick.filter(x => !x.audioAssetId || !assetById(x.audioAssetId));
    const missingRef = pick.filter(x => !x.characterRefAssetId || !assetById(x.characterRefAssetId));
    const ready = pick.filter(x =>
      x.audioAssetId && assetById(x.audioAssetId)
      && x.characterRefAssetId && assetById(x.characterRefAssetId)
    );
    if (ids && missingAudio.length) { toast("该段缺少分段口播音频，请先点「生成分段口播」或重新生成该段口播"); return false; }
    if (ids && missingRef.length) { toast("该段缺少角色图，请先上传统一角色图，或给单段拖入角色图"); return false; }
    if (!ids && !ready.length) {
      toast(missingAudio.length ? "当前没有可生成的数字人片段：至少先生成一段分段口播音频" : "当前没有可生成的数字人片段：请先补齐角色图");
      return false;
    }
    applyDigitalFixedPrompts();
    ready.forEach(seg => {
      if (seg.videoStatus !== "succeeded" && !seg.videoOutput?.url) seg.videoStatus = "ready";
      seg.videoPrompt = A.digitalHuman.fixedPrompt;
    });
    A.digitalHuman.segments = segs;
    save("productions");
    if (!ids && missingAudio.length) toast(`已跳过 ${missingAudio.length} 个缺少分段口播音频的数字人片段`);
    if (!ids && missingRef.length && ready.length) toast(`已跳过 ${missingRef.length} 个缺少角色图的数字人片段`);
    return true;
  }

  function pickDigitalVideoSegments(ids = null) {
    const segs = persistDigitalSegmentsForCurrentState(p, acc);
    return ids ? segs.filter(x => ids.includes(x.id)) : segs;
  }

  async function ensureDigitalHumanCanSubmit(ids = null) {
    const pick = pickDigitalVideoSegments(ids).filter(seg =>
      seg.audioAssetId && assetById(seg.audioAssetId)
      && seg.characterRefAssetId && assetById(seg.characterRefAssetId)
    );
    if (!pick.length) return false;
    const cfg = await videoServerConfig();
    if (!cfg.ok) {
      toast(`数字人服务不可用：${cfg.detail || "无法读取视频配置"}`, "error");
      return false;
    }
    if (!cfg.digitalHumanConfigured) {
      toast("数字人模型未配置智能视觉 AK/SK；部署服务器后需配置数字人环境变量", "error");
      return false;
    }
    const localRefs = [];
    pick.forEach(seg => {
      const charAsset = assetById(seg.characterRefAssetId);
      const audioAsset = assetById(seg.audioAssetId);
      [[charAsset, "角色图"], [audioAsset, "口播音频"]].forEach(([asset, label]) => {
        const u = urlFor(asset) || "";
        if (!asset || isPublicHttpUrl(u)) return;
        if (isServerFileUrl(u) && cfg.publicBaseConfigured) return;
        localRefs.push(label);
      });
    });
    if (localRefs.length) {
      toast("已检测到分段口播和角色图，但它们当前不是公网 URL；OmniHuman 只能读取公网素材。部署服务器后请配置 PUBLIC_BASE_URL，或先换成公网图片/音频链接再生成。", "error");
      return false;
    }
    return true;
  }

  function setNarrationLines(lines, { invalidateAudio = true, silent = false } = {}) {
    const clean = (lines || []).map(x => sanitizeXhsText(String(x || "").trim())).filter(Boolean);
    if (!clean.length) { if (!silent) toast("口播内容不能为空"); return false; }
    const before = narrationText(shots);
    const after = clean.join("\n");
    if (before === after) return true;
    if (!shots.length) {
      p.artifacts.script.shots = clean.map((line, i) => ({
        idea: `口播段 ${i + 1}`,
        visual: i === 0 ? "真实痛点开场，明亮办公环境，桌面文件与屏幕任务形成问题感" : "围绕口播内容匹配对应办公动作、数据流转或结果展示",
        line,
        ui: i % 3 !== 1,
        scene: i + 1
      }));
    } else {
      clean.forEach((line, i) => {
        if (shots[i]) shots[i].line = line;
        else shots.push({
          idea: `补充口播 ${i + 1}`,
          visual: "承接前文的办公场景，使用手部动作、文件卡片、数据面板或结果物料推进信息",
          line,
          ui: i % 3 !== 1,
          scene: Math.max(1, shots.length + 1)
        });
      });
      if (clean.length < shots.length) shots.slice(clean.length).forEach(s => { s.line = ""; });
    }
    shots = p.artifacts.script.shots || [];
    Object.assign(p.artifacts.audio, estimateAudio(shots), {
      assetId: invalidateAudio ? null : p.artifacts.audio.assetId || null,
      source: invalidateAudio ? "estimate" : (p.artifacts.audio.source || "estimate"),
      lastError: invalidateAudio ? "口播已修改，请重新生成或上传口播音频" : ""
    });
    if (invalidateAudio && A.digitalHuman) A.digitalHuman.segments = [];
    invalidatePromptsAfterAudioChange();
    save("productions");
    return true;
  }

  function syncNarrationFromEditor({ silent = true } = {}) {
    const text = $("#wsNarrationText", root)?.value || "";
    return setNarrationLines(text.split(/\n+/), { invalidateAudio: true, silent });
  }

  function syncCopyFromEditor({ markBodyManual = false } = {}) {
    p.artifacts.copy = p.artifacts.copy || { title: "", body: "" };
    const title = ($("#wsCopyTitle", root)?.value || "").trim();
    const body = ($("#wsCopyBody", root)?.value || "").trim();
    p.artifacts.copy.title = sanitizeXhsText(title);
    p.artifacts.copy.body = sanitizeXhsText(body);
    if (markBodyManual) p.artifacts.copy.infoFlowBodyManual = true;
    save("productions");
  }

  function infoFlowCopyOverride() {
    return p.artifacts.copy?.infoFlowBodyManual ? (p.artifacts.copy.body || "") : "";
  }

  async function generateVideoCopyFromWorkshop(triggerEl = null) {
    syncNarrationFromEditor({ silent: true });
    const currentShots = p.artifacts.script.shots || [];
    if (!currentShots.length) { toast("先生成口播草稿"); return; }
    const selectedProduct = productById(p.artifacts.script.productId || "dumate");
    const style = p.artifacts.script.style || acc?.styleProfile || acc?.lockedStyle || "";
    const run = async () => {
      const res = await AI.generateCopy({
        topic: p.topic,
        shots: currentShots,
        account: acc,
        style,
        kind: "video",
        product: selectedProduct,
        useOnlineTrends: false,
        trendGuide: "",
        trendPrep: null
      });
      p.artifacts.copy = {
        ...(p.artifacts.copy || {}),
        title: res.title || p.artifacts.script.title || p.title || p.topic || "",
        body: stripLeadingCopyTitle(res.copy || "", res.title || p.artifacts.script.title || p.title || p.topic || "")
      };
      save("productions");
      const titleInput = $("#wsCopyTitle", root);
      const bodyInput = $("#wsCopyBody", root);
      if (titleInput) titleInput.value = p.artifacts.copy.title || "";
      if (bodyInput) bodyInput.value = p.artifacts.copy.body || "";
      toast(AI.sourceNote("已按口播生成发布文案"));
    };
    if (triggerEl) return withLoading(triggerEl, run, "生成中…");
    return run();
  }

  async function customVideoDraftFromModel({ title = "", body = "", product = null } = {}) {
    const mode = activeInfoFlowMode ? "infoFlow" : "digital";
    const generated = await AI.generateCustomVideoDraft({
      title,
      body,
      account: acc,
      product,
      mode
    });
    const finalTitle = sanitizeXhsText(title || generated.title || p.title || p.topic || "").replace(/[「」]/g, "").trim();
    return {
      title: finalTitle,
      copy: stripLeadingCopyTitle((generated.copy || body || "").replace(/[「」]/g, ""), finalTitle),
      narration: copyBodyForSpeech((generated.narration || "").replace(/[「」]/g, "")),
      visualPrompt: sanitizeXhsText((generated.visualPrompt || "").replace(/[「」]/g, "")).trim()
    };
  }

  function customWorkshopShotsFromCopy(title = "", body = "", visualPrompt = "") {
    const raw = sanitizeXhsText(body || title || "");
    const lines = raw
      .replace(/#[^\s#]+/g, " ")
      .replace(/\n+/g, "。")
      .split(/[。！？!?；;]+/)
      .map(x => x.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const beats = (lines.length ? lines : [title || p.topic || "本期口播"]).slice(0, isDigitalHumanMode ? 14 : 10);
    return beats.map((line, i) => ({
      time: "",
      idea: i === 0 ? (title || line).slice(0, 40) : line.slice(0, 44),
      visual: isDigitalHumanMode
        ? (i === 0
          ? `固定真人/数字人正面中近景开场，围绕标题 ${title || line} 自然开口，表情真实，背景是干净办公桌。`
          : `真人/数字人延续同一角色讲述，旁边穿插产品任务卡、资料整理结果或界面局部，画面服务这句口播：${line.slice(0, 42)}。`)
        : (visualPrompt && i === 0
          ? `${visualPrompt} 本镜头先交代主题和核心结果：${line.slice(0, 42)}。`
          : `围绕这句内容生成可拍办公画面：${line.slice(0, 42)}。使用手部操作、产品界面、资料流转或结果展示推进，不偏离用户自定义文案。`),
      line,
      ui: !isDigitalHumanMode || i % 3 !== 1,
      scene: i + 1
    }));
  }

  async function generateWorkshopDraft() {
    let topic = sanitizeXhsText(($("#wsTopic", root)?.value || p.topic || "").trim());
    const customMode = true;
    syncCopyFromEditor();
    let customTitle = (p.artifacts.copy?.title || "").trim();
    let customBody = (p.artifacts.copy?.body || "").trim();
    if (!customTitle) {
      toast("先填写发布标题，再生成文案和视频");
      return;
    }
    const configuredProduct = productById(p.artifacts.script.productId || "dumate");
    const selectedProduct = customMode
      ? inferWorkshopProductFromCopy(customTitle || topic, customBody, configuredProduct)
      : configuredProduct;
    if (selectedProduct?.id) p.artifacts.script.productId = selectedProduct.id;
    if (activeInfoFlowMode) {
      if (customMode) {
        const generated = await customVideoDraftFromModel({ title: customTitle, body: customBody, product: selectedProduct });
        const userTitle = customTitle;
        const userBody = customBody;
        customBody = customBody || generated.copy || "";
        p.artifacts.copy.title = customTitle || p.title || topic;
        p.artifacts.copy.body = userBody ? userBody : stripLeadingCopyTitle(customBody, p.artifacts.copy.title);
        p.artifacts.copy.generatedNarration = generated.narration || "";
        p.artifacts.copy.generatedVisualPrompt = generated.visualPrompt || "";
        if (userTitle) p.artifacts.copy.title = userTitle;
      }
      const existingInfoFlowPrompts = ensureInfoFlowState(p).segments
        .map(segment => segment?.videoPrompt || "")
        .filter(Boolean);
      const creativePlan = await AI.generateInfoFlowCreativePlan({
        title: customTitle || p.artifacts.copy.title || topic,
        copy: p.artifacts.copy.body || customBody,
        narration: p.artifacts.copy.generatedNarration || customBody,
        account: acc,
        product: selectedProduct,
        previousPrompts: existingInfoFlowPrompts
      });
      const plan = buildInfoFlowPlan({
        topic: customMode ? (customTitle || topic) : topic,
        title: customMode ? customTitle : "",
        acc,
        product: selectedProduct,
        publishCopy: customMode ? customBody : "",
        copyText: customMode ? copyBodyForSpeech(p.artifacts.copy.generatedNarration || customBody) : infoFlowCopyOverride(),
        creativePlan
      });
      applyInfoFlowPlan(p, plan, { preserveCopy: customMode });
      const input = $("#wsTopic", root); if (input) input.value = p.topic || "";
      save("productions");
      toast("已按标题与文案生成全新的 A/B 面信息流提示词");
      draw();
      return;
    }
    if (customMode) {
      const generated = await customVideoDraftFromModel({ title: customTitle, body: customBody, product: selectedProduct });
      customBody = generated.copy || customBody;
      if (!topic) topic = customTitle || customBody.split(/\n+/).find(Boolean) || "";
      p.topic = sanitizeXhsText(topic);
      p.title = customTitle || p.topic;
      p.artifacts.script.shots = customWorkshopShotsFromCopy(customTitle || p.title, generated.narration || copyBodyForSpeech(customBody), generated.visualPrompt);
      shots = p.artifacts.script.shots || [];
      p.artifacts.script.title = p.title;
      p.artifacts.script.source = "custom-copy";
      p.artifacts.script.style = p.artifacts.script.style || acc?.styleProfile || acc?.lockedStyle || "";
      p.artifacts.script.productId = selectedProduct?.id || p.artifacts.script.productId || "dumate";
      p.artifacts.copy.title = p.title;
      p.artifacts.copy.body = stripLeadingCopyTitle(customBody, p.title);
      p.artifacts.copy.generatedNarration = generated.narration || "";
      p.artifacts.copy.generatedVisualPrompt = generated.visualPrompt || "";
      Object.assign(p.artifacts.audio, estimateAudio(shots), { assetId: null, source: "estimate", lastError: "" });
      p.artifacts.boards.units = [];
      buildMaterialUnits(p);
      save("productions");
      toast("已按自定义文案生成口播和视频提示词结构");
      draw();
      return;
    }
    if (!topic) {
      topic = sanitizeXhsText(await AI.generateCreativeBrief({ account: acc, product: selectedProduct, imageCount: 6, kind: "video" }));
      p.topic = topic;
      const input = $("#wsTopic", root); if (input) input.value = topic;
      toast(AI.sourceNote("已按四方向生成短选题"));
    }
    p.topic = sanitizeXhsText(topic);
    const style = p.artifacts.script.style || acc?.styleProfile || acc?.lockedStyle || "";
    const res = isMaterial(p)
      ? await AI.generateMaterialScript({ topic, account: acc, style, product: selectedProduct })
      : await AI.generateScript({ topic, duration: isDigitalHumanMode ? 64 : 55, account: acc, image: false, style, product: selectedProduct });
    p.artifacts.script.shots = res.shots || [];
    shots = p.artifacts.script.shots || [];
    p.artifacts.script.title = res.title || topic;
    p.title = res.title || topic;
    const copyRes = await AI.generateCopy({
      topic,
      shots,
      account: acc,
      style,
      kind: "video",
      product: selectedProduct,
      useOnlineTrends: false,
      trendGuide: "",
      trendPrep: null
    });
    p.artifacts.copy = {
      ...(p.artifacts.copy || {}),
      title: copyRes.title || res.title || topic,
      body: stripLeadingCopyTitle(copyRes.copy || "", copyRes.title || res.title || topic)
    };
    Object.assign(p.artifacts.audio, estimateAudio(p.artifacts.script.shots), { assetId: null, source: "estimate", lastError: "" });
    p.artifacts.boards.units = [];
    buildMaterialUnits(p);
    save("productions");
    toast(AI.sourceNote("已生成口播草稿、发布文案并按可读时长重排片段"));
    draw();
  }

  function invalidatePromptsAfterAudioChange() {
    buildMaterialUnits(p);
    (p.artifacts.boards.units || []).forEach(u => {
      u.videoPrompt = "";
      u.imagePrompt = "";
      u.imageAssetId = null;
      u.refAssetId = null;
      u.refAssetIds = [];
    });
    p.artifacts.timeline = [];
    p.artifacts.subs = [];
    p.artifacts.subTimingSource = "";
    p.artifacts.audioTimingSource = "";
    p.artifacts.audioTimingAttemptSig = "";
    p.artifacts.audioTimingPending = false;
    p.artifacts.audioTimingRevision = Number(p.artifacts.audioTimingRevision || 0) + 1;
  }

  function invalidateDerivedMediaAfterDigitalAudioChange() {
    p.artifacts.timeline = [];
    p.artifacts.subs = [];
    p.artifacts.subTimingSource = "";
    p.artifacts.audioTimingSource = "";
    p.artifacts.audioTimingAttemptSig = "";
    p.artifacts.audioTimingPending = false;
    p.artifacts.audioTimingRevision = Number(p.artifacts.audioTimingRevision || 0) + 1;
    p.artifacts.finalVideoUrl = "";
    p.artifacts.finalVideoName = "";
    p.artifacts.finalVideoCaptionSig = "";
    p.artifacts.finalVideoTimelineSig = "";
    p.artifacts.finalVideoMixSig = "";
    p.artifacts.composeError = "";
  }

  function wire() {
    $("#wsTopic", root)?.addEventListener("input", e => {
      p.topic = sanitizeXhsText(e.target.value.trim());
      if (p.artifacts.copy) p.artifacts.copy.infoFlowBodyManual = false;
      save("productions");
    });
    $("#wsDice", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      if (activeInfoFlowMode) {
        if (p.artifacts.copy) p.artifacts.copy.infoFlowBodyManual = false;
        const plan = buildInfoFlowPlan({
          topic: "",
          acc,
          product: productById(p.artifacts.script.productId || "dumate")
        });
        applyInfoFlowPlan(p, plan);
        const input = $("#wsTopic", root); if (input) input.value = p.topic || "";
        save("productions");
        toast("已随机生成信息流方向");
        draw();
        return;
      }
      const topic = sanitizeXhsText(await AI.generateCreativeBrief({
        account: acc,
        product: productById(p.artifacts.script.productId || "dumate"),
        imageCount: 6,
        kind: "video"
      }));
      p.topic = topic;
      const input = $("#wsTopic", root); if (input) input.value = topic;
      save("productions");
      toast(AI.sourceNote("已从四方向库随机生成视频选题"));
    }, "随机中…"));
    $("#wsBriefGenerate", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      const title = ($("#wsCopyTitle", root)?.value || "").trim();
      if (!title) {
        toast(activeInfoFlowMode ? "先填写发布标题，再一键生成两段信息流视频" : "先填写发布标题，再一键生成数字人视频");
        return;
      }
      await generateWorkshopDraft();
      if (!activeInfoFlowMode) return;
      const n = await prepareInfoFlowVideos();
      toast(n ? `已直接派发 ${n} 个信息流视频片段` : "信息流片段已在队列或已生成");
      draw();
    }, activeInfoFlowMode ? "生成并提交中…" : "生成中…"));
    $("#wsDraft", root)?.addEventListener("click", e => withLoading(e.currentTarget, generateWorkshopDraft, "生成中…"));
    $("#wsNarrationText", root)?.addEventListener("blur", () => syncNarrationFromEditor({ silent: true }));
    $("#wsNarrationText", root)?.addEventListener("change", () => syncNarrationFromEditor({ silent: true }));
    $("#wsCopyTitle", root)?.addEventListener("input", () => syncCopyFromEditor());
    $("#wsCopyBody", root)?.addEventListener("input", () => syncCopyFromEditor({ markBodyManual: true }));
    $("#wsCopyGen", root)?.addEventListener("click", e => generateVideoCopyFromWorkshop(e.currentTarget));
    $("#wsCoverPrompt", root)?.addEventListener("input", e => {
      const cover = coverState(p);
      cover.prompt = e.currentTarget.value;
      save("productions");
    });
    $("#wsCoverGen", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      await generateCoverImage();
    }, "生成中…"));
    $("#wsCoverRefUp", root)?.addEventListener("change", async e => {
      await addCoverRefs(e.target.files);
      e.target.value = "";
    });
    $("#wsCoverUpload", root)?.addEventListener("change", async e => {
      const f = Array.from(e.target.files || []).find(x => x.type.startsWith("image/"));
      e.target.value = "";
      if (f) await uploadCoverImage(f);
    });
    const coverbar = $("#wsCoverBar", root);
    wireDropZone(coverbar, async files => {
      const list = Array.from(files || []).filter(f => f.type.startsWith("image/"));
      if (list.length) await addCoverRefs(list);
    }, { filesOnly: true });
    const coverStage = $("#wsCoverStage", root);
    wireDropZone(coverStage, async files => {
      const file = Array.from(files || []).find(f => f.type.startsWith("image/"));
      if (file) await uploadCoverImage(file);
    }, { filesOnly: true });
    $$("[data-cover-ref-rm]", root).forEach(b => b.addEventListener("click", () => {
      const cover = coverState(p);
      cover.refAssetIds = (cover.refAssetIds || []).filter(id => id !== b.dataset.coverRefRm);
      save("productions");
      draw();
    }));
    coverStage?.addEventListener("click", e => {
      const cover = coverState(p);
      const asset = cover.assetId ? assetById(cover.assetId) : null;
      if (asset) openLightbox(e.currentTarget, urlFor(asset), asset.name || "视频封面");
      else $("#wsCoverUpload", root)?.click();
    });
    // 全能参考素材（logo / 界面图，可多张）
    const charbar = $("#wsCharbar", root);
    if (canConfigureAccount) wireDropZone(charbar, async files => {
      const f = Array.from(files || []).find(x => x.type.startsWith("image/"));
      if (f) await setCharRef(f);
    });
    $("#wsCharUp", root)?.addEventListener("change", async e => {
      const f = e.target.files[0]; e.target.value = "";
      if (f) await setCharRef(f);
    });
    $("[data-chardel]", root)?.addEventListener("click", () => {
      A.characterRefAssetId = null;
      if (acc) acc.charBoardAssetId = null;
      save("productions", "accounts");
      draw();
    });
    const refbar = $("#wsRefbar", root) || $("#wsInfoFlowRefs", root);
    wireDropZone(refbar, async files => { await addRefs(files); });
    $("#wsRefUp", root)?.addEventListener("change", async e => { await addRefs(e.target.files); e.target.value = ""; });
    $$("[data-omnidel]", root).forEach(b => b.addEventListener("click", () => {
      const removedId = b.dataset.omnidel;
      A.omniRefAssetIds = A.omniRefAssetIds.filter(id => id !== removedId);
      A.sceneRefAssetIds = (A.sceneRefAssetIds || []).filter(id => id !== removedId);
      save("productions");
      $$("[data-omnidel]", root)
        .filter(node => node.dataset.omnidel === removedId)
        .forEach(node => node.closest(".ref-chip")?.remove());
      const chipRow = $(".refbar-chip", refbar);
      if (chipRow && !chipRow.querySelector(".ref-chip")) {
        chipRow.innerHTML = `<span class="muted">${activeInfoFlowMode ? "可拖入产品图或 MP3，总参考会用于每段视频" : "未设置（可选）"}</span>`;
      }
    }));
    $("[data-reference-audio-del]", root)?.addEventListener("click", () => {
      A.referenceAudioAssetId = null;
      save("productions");
      $("[data-reference-audio-del]", root)?.closest(".ref-chip")?.remove();
      const chipRow = $(".refbar-chip", refbar);
      if (chipRow && !chipRow.querySelector(".ref-chip")) {
        chipRow.innerHTML = `<span class="muted">${activeInfoFlowMode ? "可拖入产品图或 MP3，总参考会用于每段视频" : "未设置（可选）"}</span>`;
      }
    });
    // 尺寸切换（9:16 / 16:9）：全片统一，写进 boards.ratio，生成时传给视频 API
    $$("[data-ratio]", root).forEach(b => b.addEventListener("click", () => {
      if (A.ratio === b.dataset.ratio) return;
      A.ratio = b.dataset.ratio; save("productions"); toast(`已切换为 ${A.ratio}，所有分镜统一此尺寸`); draw();
    }));
    $("#wsRefPick", root)?.addEventListener("click", () => {
      const box = $("#wsRefChooser", root);
      if (!box.hidden) { box.hidden = true; return; }
      const known = new Set([...(A.sceneRefAssetIds || []), ...(A.omniRefAssetIds || []), A.characterRefAssetId, A.referenceAudioAssetId].filter(Boolean));
      const images = accAssets(acc.id).filter(a => a.type === "图片");
      const referenceAudios = accAssets(acc.id).filter(a => a.type === "音频" && (a.tags || []).some(tag => /参考音频库|声线参考/i.test(tag)));
      const assets = [...images, ...referenceAudios].filter(a => !known.has(a.id));
      box.innerHTML = assets.length ? `<div class="ref-grid">${assets.map(a => `<button class="ref-item" data-ref="${a.id}">${thumbHtml(a)}<span>${esc(a.name)}</span></button>`).join("")}</div>`
        : `<div class="muted" style="padding:10px">暂无可选的图片或参考音频</div>`;
      box.hidden = false;
      box.querySelectorAll("[data-ref]").forEach(b => b.addEventListener("click", () => {
        const picked = assetById(b.dataset.ref);
        if (picked?.type === "音频") A.referenceAudioAssetId = picked.id;
        else {
          A.omniRefAssetIds.push(b.dataset.ref);
          A.sceneRefAssetIds = [...new Set([...(A.sceneRefAssetIds || []), b.dataset.ref])];
        }
        save("productions"); draw();
      }));
    });
    async function addRefs(files) {
      const list = Array.from(files || []);
      await addOmni(list.filter(f => f.type.startsWith("image/")));
      const audio = list.find(f => f.type === "audio/mpeg" || /\.mp3$/i.test(f.name || ""));
      if (audio) {
        const saved = await addAssetFromFile(null, audio, {
          tags: ["参考音频库", "声线参考", "生产总参考"],
          name: audio.name.replace(/\.[^.]+$/, "")
        });
        A.referenceAudioAssetId = saved.id;
        save("productions");
        toast("已设置本次生产的 MP3 总参考音频");
        draw();
      }
    }
    async function addOmni(files) {
      const imgs = Array.from(files || []).filter(f => f.type.startsWith("image/"));
      let added = 0;
      for (const f of imgs) {
        const dataUrl = await fileToDataUrl(f);
        const a = await addAssetFromDataUrl(acc.id, { name: f.name.replace(/\.[^.]+$/, ""), tags: ["全能参考图"], dataUrl });
        A.omniRefAssetIds.push(a.id);
        A.sceneRefAssetIds = [...new Set([...(A.sceneRefAssetIds || []), a.id])];
        added++;
      }
      if (added) { save("productions"); toast("已加入全能参考素材"); draw(); }
    }
    async function setCharRef(f) {
      if (!f || !f.type.startsWith("image/")) { toast("请上传角色图片"); return; }
      const dataUrl = await fileToDataUrl(f);
      const a = await addAssetFromDataUrl(acc.id, { name: f.name.replace(/\.[^.]+$/, ""), tags: ["角色形象", "角色版"], dataUrl });
      A.characterRefAssetId = a.id;
      if (acc) acc.charBoardAssetId = a.id;
      A.omniRefAssetIds = (A.omniRefAssetIds || []).filter(id => id !== a.id);
      A.sceneRefAssetIds = (A.sceneRefAssetIds || []).filter(id => id !== a.id);
      save("productions", "accounts");
      toast("已设置角色形象");
      draw();
    }

    async function addCoverRefs(files) {
      const imgs = Array.from(files || []).filter(f => f.type.startsWith("image/"));
      if (!imgs.length) return;
      const cover = coverState(p);
      for (const f of imgs.slice(0, 5)) {
        const dataUrl = await fileToDataUrl(f);
        const a = await addAssetFromDataUrl(acc.id, {
          name: f.name.replace(/\.[^.]+$/, ""),
          tags: ["视频封面参考", "账号资产"],
          dataUrl
        });
        cover.refAssetIds = [...new Set([...(cover.refAssetIds || []), a.id])].slice(0, 5);
      }
      cover.updatedAt = Date.now();
      save("productions");
      toast("已加入封面参考图");
      draw();
    }

    async function uploadCoverImage(file) {
      if (!file || !file.type.startsWith("image/")) { toast("请上传图片文件"); return; }
      const cover = coverState(p);
      let dataUrl = await fileToDataUrl(file);
      dataUrl = await polishPublishImage(dataUrl, `${p.id}-cover-upload-${p.artifacts.copy?.title || p.topic || ""}`);
      const a = await addAssetFromDataUrl(acc.id, {
        name: `视频封面_${file.name.replace(/\.[^.]+$/, "").slice(0, 18)}`,
        tags: ["视频封面", "上传封面", "账号资产"],
        dataUrl
      });
      cover.assetId = a.id;
      cover.status = "done";
      cover.error = "";
      cover.referenceReceipt = null;
      cover.updatedAt = Date.now();
      save("productions");
      toast("已上传封面图");
      draw();
    }

    async function generateCoverImage() {
      syncCopyFromEditor();
      const cover = coverState(p);
      cover.prompt = ($("#wsCoverPrompt", root)?.value || cover.prompt || "").trim();
      try {
        await ensureVideoCover(p, { force: true, onStatus: draw });
        toast("封面图已生成并入库");
      } catch (err) {
        toast("封面生成失败：" + (err?.message || err), "error");
      } finally {
        draw();
      }
    }

    function syncInfoFlowPrompts() {
      if (!activeInfoFlowMode) return;
      const info = ensureInfoFlowState(p);
      if (!info.segments.length) return;
      $$("[data-if-prompt]", root).forEach(el => {
        const i = +el.dataset.ifPrompt;
        if (info.segments[i]) {
          const cleaned = stripInfoFlowDirectorNotes(el.value.trim());
          info.segments[i].videoPrompt = cleaned;
          if (el.value !== cleaned) el.value = cleaned;
        }
      });
      buildMaterialUnits(p);
      touchProduction(p, info);
      save("productions");
    }

    function ensureCurrentInfoFlowPlanReady() {
      let info = ensureInfoFlowState(p);
      if (!info.segments.length || !info.segments[0]?.videoPrompt || !info.segments[1]?.videoPrompt) {
        throw new Error("请先点「重新生成提示词」，不要使用旧的本地模板");
      }
      if (!info.segments.length || !info.segments[0]?.videoPrompt || !info.segments[1]?.videoPrompt) {
        info.status = "failed";
        info.error = "信息流脚本生成失败：没有写入前后15秒脚本。";
        touchProduction(p, info);
        save("productions");
        throw new Error(info.error);
      }
      info.status = "ready";
      info.error = "";
      touchProduction(p, info);
      save("productions");
      return info;
    }

    $$("[data-if-prompt]", root).forEach(el => {
      el.addEventListener("blur", syncInfoFlowPrompts);
      el.addEventListener("change", syncInfoFlowPrompts);
    });
    $("#wsInfoPlan", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      syncCopyFromEditor();
      try {
        await generateWorkshopDraft();
        ensureCurrentInfoFlowPlanReady();
        toast("已重新生成信息流前后15秒提示词");
      } catch (err) {
        const info = ensureInfoFlowState(p);
        info.status = "failed";
        info.error = err.message || String(err) || "信息流脚本生成失败";
        touchProduction(p, info);
        save("productions");
        toast(info.error, "error");
      } finally {
        draw();
      }
    }, "重生成中…"));
    async function prepareInfoFlowVideos(targetIndex = null) {
      if (!activeInfoFlowMode) return 0;
      const info = ensureInfoFlowState(p);
      if (!info.segments.length) throw new Error("请先重新生成信息流提示词");
      syncInfoFlowPrompts();
      buildMaterialUnits(p);
      const infoNow = ensureInfoFlowState(p);
      const readySegs = (infoNow.segments || []).slice(0, 2);
      const neededSegs = targetIndex == null ? readySegs : [readySegs[targetIndex]];
      if (neededSegs.some(seg => !String(seg?.videoPrompt || "").trim())) {
        toast(targetIndex == null ? "请先生成信息流脚本" : "请先填写该段信息流提示词");
        return 0;
      }
      let units = materialUnits(p);
      if (!units.length) {
        buildMaterialUnits(p);
        units = materialUnits(p);
      }
      units.forEach((u, i) => {
        if (!u.videoPrompt && readySegs[i]?.videoPrompt) u.videoPrompt = readySegs[i].videoPrompt;
      });
      const n = targetIndex == null ? createUnitVideoJobs(p) : createUnitVideoJobs(p, targetIndex);
      if (n && p.stage === "workshop") setStatus(p, "running");
      save("productions");
      return n;
    }
    $("#wsInfoVideo", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      const n = await prepareInfoFlowVideos();
      toast(n ? `已派发 ${n} 个信息流视频片段` : "信息流片段已在队列或已生成");
      draw();
    }, "提交中…"));
    $$("[data-if-seg-video]", root).forEach(b => b.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      const i = +e.currentTarget.dataset.ifSegVideo;
      const n = await prepareInfoFlowVideos(i);
      toast(n ? `已派发 ${i === 0 ? "前15s" : "后15s"}片段生成` : "该信息流片段已在队列或已生成");
      draw();
    }, "提交中…")));

    // 口播：一键复制 + 上传音频（按真实时长重排）
    $("#wsCopyLines", root)?.addEventListener("click", () => {
      syncNarrationFromEditor({ silent: true });
      const text = safeTtsText(narrationText(shots));
      if (!text) { toast("脚本里还没有口播文案"); return; }
      copyText(text);
      toast("已复制全部口播文案");
    });
    const voiceBtn = $("#wsVoicePickerBtn", root);
    const voiceMenu = $("#wsVoiceMenu", root);
    voiceBtn?.addEventListener("click", e => {
      e.stopPropagation();
      if (voiceMenu) voiceMenu.hidden = !voiceMenu.hidden;
    });
    const syncVoiceControls = () => {
      const selected = selectedVoicePreset(p, acc);
      const label = voiceBtn?.querySelector("span");
      const idLabel = voiceBtn?.querySelector("em");
      if (label) label.textContent = selected.name || "默认/手动声线";
      if (idLabel) idLabel.textContent = selected.voiceId || "平台默认 / 手动输入";
      const input = $("#wsVoiceId", root);
      if (input && document.activeElement !== input) input.value = selected.voiceId || "";
      $$("[data-voice-option]", root).forEach(option => option.classList.toggle("is-active", option.dataset.voiceOption === selected.voiceId));
      if (voiceMenu) voiceMenu.hidden = true;
    };
    $$("[data-voice-option]", root).forEach(b => b.addEventListener("click", () => {
      const id = b.dataset.voiceOption || "";
      const known = id ? findKnownTtsVoice(id) : null;
      const preset = ttsVoicePresets().find(v => v.voiceId === id);
      p.artifacts.audio.voiceId = id;
      p.artifacts.audio.voiceName = preset?.name || known?.name || "";
      p.artifacts.audio.voiceLookup = "";
      save("productions");
      toast(id ? `已切换声线：${p.artifacts.audio.voiceName || id}` : "已切回默认/手动声线");
      syncVoiceControls();
    }));
    $("#wsVoiceId", root)?.addEventListener("input", e => {
      p.artifacts.audio.voiceId = e.currentTarget.value.trim();
      p.artifacts.audio.voiceName = "";
      p.artifacts.audio.voiceLookup = "";
      save("productions");
    });
    $("#wsVoiceLookup", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      const voiceId = ($("#wsVoiceId", root)?.value || "").trim();
      if (!voiceId) { toast("请先填写 voice_id"); return; }
      const res = await lookupTtsVoice(voiceId, { test: true });
      p.artifacts.audio.voiceId = voiceId;
      p.artifacts.audio.voiceName = res.name || "";
      const usedBy = (res.accounts || []).map(x => x.account).filter(Boolean).slice(0, 3).join("、");
      const local = res.name ? `识别为：${res.name}${usedBy ? `（用于 ${usedBy}${(res.accounts || []).length > 3 ? " 等账号" : ""}）` : ""}` : "本地未命名，按自定义声线 ID 使用";
      const remote = res.valid === true ? "上游测试有效" : res.valid === false ? "上游返回无效" : (res.configured ? "上游未能确认" : "本地未配置 TTS，暂未上游测试");
      p.artifacts.audio.voiceLookup = `${local} · ${remote}${res.detail ? `：${res.detail.slice(0, 120)}` : ""}`;
      save("productions");
      toast(res.valid === false ? "声线上游测试未通过" : "声线识别完成");
      const note = $("#wsVoiceLookupNote", root);
      if (note) { note.hidden = false; note.textContent = p.artifacts.audio.voiceLookup; }
      syncVoiceControls();
    }, "识别中…"));
    $("#wsVoiceFav", root)?.addEventListener("click", () => {
      const typed = ($("#wsVoiceId", root)?.value || "").trim();
      if (typed) p.artifacts.audio.voiceId = typed;
      const { voiceId, name } = selectedVoicePreset(p, acc);
      if (!voiceId) { toast("请先选择一个有效声线"); return; }
      setFavoriteVoice(voiceId, true);
      toast(`已收藏声线：${name}`);
      const button = $("#wsVoiceFav", root);
      if (button) { button.classList.add("voice-action-active"); button.innerHTML = `${icon("star", 12)} 已收藏`; }
    });
    $("#wsVoiceFix", root)?.addEventListener("click", () => {
      const typed = ($("#wsVoiceId", root)?.value || "").trim();
      if (typed) p.artifacts.audio.voiceId = typed;
      const { voiceId, name } = selectedVoicePreset(p, acc);
      if (!voiceId || !acc) { toast("请先选择一个有效声线"); return; }
      acc.voiceId = voiceId;
      acc.voiceName = name;
      p.artifacts.audio.voiceId = voiceId;
      p.artifacts.audio.voiceName = name;
      save("accounts", "productions");
      toast(`已固定到账号：${name}`);
      const button = $("#wsVoiceFix", root);
      if (button) { button.classList.add("voice-action-active"); button.innerHTML = `${icon("check", 12)} 已锁定`; }
      syncVoiceControls();
    });
    $("#wsTts", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      syncNarrationFromEditor({ silent: true });
      if (!shots.length) { toast("先生成口播草稿"); return; }
      const text = narrationText(shots);
      if (!text) { toast("没有可合成的口播文本"); return; }
      const typedVoiceId = ($("#wsVoiceId", root)?.value || "").trim();
      const voiceId = (typedVoiceId || p.artifacts.audio.voiceId || acc?.voiceId || defaultTtsVoiceId() || "").trim();
      p.artifacts.audio.voiceId = voiceId;
      if (isDigitalHumanMode) {
        try {
          const out = await ensureDigitalAudioForVideo(voiceId);
          applyDigitalFixedPrompts();
          save("productions");
          toast(out.count ? `数字人口播已分段生成：${out.count} 段 · ${fmtTC(out.duration || 0)}` : "已生成数字人分段估时");
          draw();
        } catch (err) {
          p.artifacts.audio.voiceId = voiceId;
          p.artifacts.audio.lastError = err.message || "Minimax TTS 生成失败";
          save("productions");
          toast("Minimax 分段口播失败，已保留原有分段音频", "error");
          draw();
        }
        return;
      }
      if (ttsApiConfigured()) {
        try {
          const out = await synthesizeTts({ text, voiceId, speed: 1.2 });
          if (out.fallbackVoice && out.voiceId && out.voiceId !== voiceId) toast(`账号声线不可用，已自动改用默认声线：${out.voiceId}`);
          const a = await addAssetFromDataUrl(acc.id, {
            name: `口播音频_${(p.title || p.topic || "视频").slice(0, 10)}`,
            type: "音频",
            tags: ["口播音频", "Minimax"],
            dataUrl: out.audioDataUrl
          });
          Object.assign(p.artifacts.audio, audioPlanFromDuration(shots, out.duration), {
            assetId: a.id,
            source: "tts",
            voiceId: out.voiceId || voiceId,
            voiceRefAssetId: null,
            lastError: ""
          });
        } catch (err) {
          Object.assign(p.artifacts.audio, estimateAudio(shots), {
            assetId: null,
            source: "estimate",
            voiceId,
            voiceRefAssetId: null,
            lastError: err.message || "Minimax TTS 生成失败"
          });
          save("productions");
          toast("Minimax 口播失败，已切换为估时备用", "error");
          draw();
          return;
        }
      } else {
        Object.assign(p.artifacts.audio, estimateAudio(shots), {
          assetId: null,
          source: "estimate",
          voiceId,
          voiceRefAssetId: null,
          lastError: "服务器未配置 Minimax TTS，当前仅估时"
        });
      }
      invalidatePromptsAfterAudioChange();
      save("productions");
      toast(`口播音频已就绪：${fmtTC(p.artifacts.audio.duration || 0)} · 已按真实/估算时长重排分镜，请重新生成提示词`);
      draw();
    }, "合成中…"));
    $("#wsAudioUp", root)?.addEventListener("change", async e => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      await setAudio(f);
    });
    const audioBar = $("#wsAudioBar", root);
    wireDropZone(audioBar, async files => {
      if (isDigitalHumanMode) return;
      const f = Array.from(files || []).find(x => x.type.startsWith("audio/"));
      if (f) await setAudio(f);
    });
    if (canConfigureAccount) $$("[data-unit-char-ref]", root).forEach(z => {
      wireDropZone(z, async files => {
        const f = Array.from(files || []).find(x => x.type.startsWith("image/"));
        if (!f) return;
        const dataUrl = await fileToDataUrl(f);
        const a = await addAssetFromDataUrl(acc.id, { name: f.name.replace(/\.[^.]+$/, ""), tags: ["数字人单段角色图"], dataUrl });
        A.digitalHuman = A.digitalHuman || { segments: [] };
        const seg = (A.digitalHuman.segments || []).find(x => x.id === z.dataset.unitCharRef);
        if (seg) {
          seg.customCharacterRefAssetId = a.id;
          seg.characterRefAssetId = a.id;
        }
        save("productions");
        toast("已设置该段数字人定制角色图");
        draw();
      }, { filesOnly: true });
    });
    async function setAudio(file) {
      const a = await addAssetFromFile(acc.id, file, { tags: ["口播音频"] });
      const realDur = await audioDuration(urlFor(a));
      const est = estimateAudio(shots);
      const estTotal = est.duration || 1;
      const scale = realDur > 0 ? realDur / estTotal : 1;
      const perShot = (est.perShot || []).map(x => ({ dur: Math.max(3, Math.round(x.dur * scale * 10) / 10) }));
      const duration = realDur > 0 ? Math.round(realDur * 10) / 10 : est.duration;
      p.artifacts.audio = {
        assetId: a.id,
        duration,
        perShot,
        source: "upload",
        voiceId: p.artifacts.audio.voiceId || acc?.voiceId || "",
        voiceRefAssetId: null,
        lastError: ""
      };
      invalidatePromptsAfterAudioChange();   // 按真实时长重排分镜单元（15s 拆分也随之更新），并清掉旧提示词
      save("productions");
      toast(realDur > 0 ? `口播音频已上传 · ${fmtTC(duration)}，已按真实时长重排分镜，请重新生成提示词` : "音频已上传，但未能读出时长，仍按估时");
      draw();
    }

    $("#wsDhVideoAll", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      syncNarrationFromEditor({ silent: true });
      const voiceId = (p.artifacts.audio.voiceId || acc?.voiceId || defaultTtsVoiceId() || "").trim();
      const audio = await ensureDigitalAudioForVideo(voiceId);
      applyDigitalFixedPrompts();
      save("productions");
      await persistNow();
      if (!audio.count) { toast("账号固定声线暂时无法生成口播，请稍后重试", "error"); draw(); return; }
      if (prepareDigitalVideoSegments()) {
        if (!await ensureDigitalHumanCanSubmit()) { draw(); return; }
        const n = createUnitVideoJobs(p);
        if (p.stage === "workshop") setStatus(p, "running");
        save("productions");
        toast(n ? `已派发 ${n} 个数字人片段生成任务` : "数字人片段都已在队列或已生成");
        draw();
      }
    }, "生成中…"));
    $$(".dh-video", root).forEach(video => video.addEventListener("error", () => {
      const segId = video.closest("[data-dh-seg]")?.dataset.dhSeg || "";
      const segs = digitalSegmentsForDisplay(p, acc);
      const idx = segs.findIndex(x => x.id === segId);
      const seg = idx >= 0 ? segs[idx] : null;
      const job = seg ? digitalJobFor(seg, idx) : null;
      const message = "视频已生成，但预览资源暂不可读取；请重试该段，系统会重新缓存成片。";
      if (job) {
        job.status = "failed";
        job.error = message;
        job.output = null;
        job.updatedAt = Date.now();
        save("jobs");
      }
      if (seg) {
        seg.videoStatus = "failed";
        seg.videoError = message;
        seg.videoOutput = null;
        seg.videoUpdatedAt = Date.now();
        save("productions");
      }
      toast(message, "error");
      draw();
    }, { once: true }));
    $$("[data-dh-video]", root).forEach(b => b.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      const requestedIndex = digitalSegmentsForDisplay(p, acc).findIndex(x => x.id === b.dataset.dhVideo);
      syncNarrationFromEditor({ silent: true });
      const syncedSegments = persistDigitalSegmentsForCurrentState(p, acc);
      const requestedId = (requestedIndex >= 0 ? syncedSegments[requestedIndex]?.id : "") || b.dataset.dhVideo;
      if (prepareDigitalVideoSegments([requestedId])) {
        if (!await ensureDigitalHumanCanSubmit([requestedId])) { draw(); return; }
        const segs = digitalSegmentsForDisplay(p, acc);
        const i = segs.findIndex(x => x.id === requestedId);
        const n = i >= 0 ? createUnitVideoJobs(p, i) : 0;
        if (p.stage === "workshop") setStatus(p, "running");
        save("productions");
        toast(n ? "已派发该段数字人生成任务" : "该段数字人片段已在队列或已生成");
        draw();
      }
    }, "生成中…")));
    $$("[data-dh-regen]", root).forEach(b => b.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      const requestedIndex = digitalSegmentsForDisplay(p, acc).findIndex(x => x.id === b.dataset.dhRegen);
      syncNarrationFromEditor({ silent: true });
      const syncedSegments = persistDigitalSegmentsForCurrentState(p, acc);
      const requestedId = (requestedIndex >= 0 ? syncedSegments[requestedIndex]?.id : "") || b.dataset.dhRegen;
      const voiceId = (p.artifacts.audio.voiceId || acc?.voiceId || defaultTtsVoiceId() || "").trim();
      try {
        const out = await synthesizeOneDigitalSegment(requestedId, voiceId);
        applyDigitalFixedPrompts();
        save("productions");
        toast(out.count ? `已重新生成该段口播：${fmtTC(out.duration || 0)}` : "已重算该段口播估时");
      } catch (err) {
        toast(err.message || "该段口播生成失败", "error");
      }
      draw();
    }, "生成中…")));

    $("#wsAuto", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      syncNarrationFromEditor({ silent: true });
      const existingDigitalSegments = isDigitalHumanMode ? digitalSegmentsForDisplay(p, acc) : [];
      if (!shots.length && !existingDigitalSegments.length) { toast("先在上方生成口播草稿"); return; }
      if (isDigitalHumanMode) {
        const voiceId = (p.artifacts.audio.voiceId || acc?.voiceId || defaultTtsVoiceId() || "").trim();
        const audio = await ensureDigitalAudioForVideo(voiceId);
        applyDigitalFixedPrompts();
        save("productions");
        await persistNow();
        const segs = digitalSegmentsForDisplay(p, acc);
        const audioReady = audio.count > 0 && segs.every(x => x.audioAssetId && assetById(x.audioAssetId));
        if (!audioReady) { draw(); toast("账号固定声线暂时无法生成口播，请稍后重试", "error"); return; }
        if (!segs.every(x => x.characterRefAssetId)) {
          save("productions");
          draw();
          toast("数字人模式还缺角色图：请上传统一角色图，或给单段拖入定制角色图");
          return;
        }
        if (!prepareDigitalVideoSegments()) { draw(); return; }
        if (!await ensureDigitalHumanCanSubmit()) { draw(); return; }
        const n = createUnitVideoJobs(p);
        if (p.stage === "workshop") setStatus(p, "running");
        save("productions");
        toast(n ? `已派发 ${n} 个数字人片段（需要公网角色图和口播音频）` : "数字人片段都已在队列或已生成");
        draw();
        return;
      }
      await ensurePrompts();
      const n = createUnitVideoJobs(p);
      if (p.stage === "workshop") setStatus(p, "running");
      toast(n ? `已派发 ${n} 个分镜单元（统一视频任务队列，超出上游并发容量时自动排队）` : "所有单元都已就绪");
      draw();
    }, "起草中…"));

    $("#wsGenPrompts", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      syncNarrationFromEditor({ silent: true });
      if (!shots.length) { toast("先在上方生成口播草稿"); return; }
      await ensurePrompts(true);
      draw();
      toast(AI.sourceNote("视频提示词已生成（按真实时长分段）"));
    }, "生成中…"));

    $$("[data-wsv]", root).forEach(el => el.addEventListener("blur", () => {
      const u = materialUnits(p)[+el.dataset.wsv]; if (u) { u.videoPrompt = el.textContent.trim(); save("productions"); }
    }));
    $$("[data-wsgen]", root).forEach(b => b.addEventListener("click", async () => {
      const i = +b.dataset.wsgen;
      const u = materialUnits(p)[i];
      if (!u.videoPrompt) await ensurePrompts();
      if (!u.videoPrompt) { toast("先填写该单元的视频提示词"); return; }
      createUnitVideoJobs(p, i);
      if (p.stage === "workshop") setStatus(p, "running");
      draw();
    }));
    // 成片预览：Seedance 返回 output.url 后直接播放真实视频；未回链时保留轻提示。
    $$("[data-wsprev]", root).forEach(el => el.addEventListener("click", e => {
      if (e.target.closest("video")) return;
      const video = el.querySelector("video");
      if (video) {
        if (video.paused) video.play().catch(() => null);
        else video.pause();
        return;
      }
      toast("视频已提交但还没有拿到回链，稍后自动刷新或点重生成");
    }));
    $("#wsNext", root)?.addEventListener("click", () => {
      syncNarrationFromEditor({ silent: true });
      syncCopyFromEditor();
      if (!((p.artifacts.copy?.title || "").trim()) || !((p.artifacts.copy?.body || "").trim())) {
        toast("先生成或填写发布文案，再进入剪辑");
        return;
      }
      if (!coverState(p).assetId) {
        toast("先生成或上传封面图，再进入下一步");
        return;
      }
      if (isDigitalHumanMode) {
        const segs = digitalSegmentsForDisplay(p, acc);
        const ready = segs.length && segs.every(x => x.audioAssetId && assetById(x.audioAssetId) && x.characterRefAssetId && assetById(x.characterRefAssetId));
        if (!ready) { toast("数字人模式请先完成分段口播和角色图"); return; }
        prepareDigitalVideoSegments();
        autoAssemble(p);
        if (p.stage === "workshop") setStage(p, "cut", "pending");
        go("studio", "cut");
        return;
      }
      const okCount = materialUnits(p).filter((u, i) => jobOfUnit(i)?.status === "succeeded").length;
      if (!okCount) { toast("还没有就绪片段：点「一键全自动」先生成"); return; }
      autoAssemble(p);
      if (p.stage === "workshop") setStage(p, "cut", "pending");
      go("studio", "cut");
    });
  }

  if (!wired) {
    wired = true;
    on("job:update", j => {
      // 任务匹配才处理；成片回绑要照常发生（即使已离开工坊页，剪辑页才拿得到正确片段）
      if (!liveProd || j.productionId !== liveProd.id) return;
      if (j.status === "succeeded") rebindUnitClip(liveProd, j.segIndex, j);
      // 仅当「仍停在该任务的工坊页」才重渲染：否则会把已切换到的其它阶段页打回工坊（批量任务在跑时尤甚）
      if (document.body.dataset.zone !== "studio") return;
      if (currentRoute().page !== "workshop") return;
      if (liveProd.id !== state.ui.activeProductionId) return;
      const uiSignature = liveJobUiSignature(j);
      const previousUiSignature = liveJobUiSignatures.get(j.id);
      liveJobUiSignatures.set(j.id, uiSignature);
      // The first active event builds the loading UI. Later poll updates only
      // patch progress in place so existing audio/video/cover nodes keep their
      // playback and loading state. Terminal or structural changes still draw.
      if (previousUiSignature && ["queued", "submitted", "running"].includes(j.status) && updateLiveJobProgress(j)) return;
      (liveDraw || draw)();
    });
  }

  draw();
}
