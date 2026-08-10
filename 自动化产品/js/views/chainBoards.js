/* 链路 · 分镜（视频）/ 图文创作台（图文）：站内图片 API + 上传补图 */

import { $, $$, esc, gradFor, fileToDataUrl, wireDropZone, singleImageGenerationPrompt } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, accountById, productById, primaryProducts, primaryProductById } from "../core/store.js";
import { AI } from "../api/ai.js?v=20260810-v1412-publish-quota-baige-canvas-1";
import { setStage, shotsToText } from "../domain/productions.js?v=20260810-v1412-publish-quota-baige-canvas-1";
import { productionAssets as accountAssets } from "../domain/accounts.js";
import { urlFor, thumbHtml, addAssetFromDataUrl, replaceAssetBlob, removeAsset, canDeleteReferenceAsset } from "../domain/assets.js";
import { polishImageForPublish as polishPublishImage } from "../domain/imagePolish.js";
import { activeProviderFor, imageApiConfigured, providerKeyFor } from "../api/providers.js";
import { maybeAdvanceAfterInput } from "../agent/orchestrator.js?v=20260810-v1412-publish-quota-baige-canvas-1";
import { toast, withLoading, openLightbox, confirmModal } from "../ui/components.js?v=20260810-v1412-publish-quota-baige-canvas-1";
import { currentRoute, go } from "../core/router.js";
import { stepperHtml, wireStepper } from "./studio.js?v=20260810-v1412-publish-quota-baige-canvas-1";

const modeBySlot = new Map(); // productionId -> "in"
const MAX_IMAGE_REFS = 5;
const DEFAULT_XHS_IMAGE_COUNT = 4;
const IMAGE_NEGATIVE_PROMPT = "负面约束：不出现页码，不出现二维码，图片右上角和左上角不要加入logo，其他位置可以正常出现logo。";

export function resizeImageSlots(items = [], count = DEFAULT_XHS_IMAGE_COUNT) {
  const total = Math.max(1, Math.min(12, Number(count) || DEFAULT_XHS_IMAGE_COUNT));
  const existing = Array.isArray(items) ? items : [];
  return Array.from({ length: total }, (_, index) => existing[index] || {
    title: `图片${index + 1}`,
    visual: "",
    prompt: "",
    assetId: null,
    status: "idle"
  });
}

export function commitGeneratedImageToSlot(items, index, expectedSlot, result = {}) {
  if (!Array.isArray(items) || items[index] !== expectedSlot || !result.assetId) return false;
  expectedSlot.assetId = result.assetId;
  expectedSlot.status = "done";
  expectedSlot.error = "";
  if (Object.prototype.hasOwnProperty.call(result, "referenceReceipt")) {
    expectedSlot.referenceReceipt = result.referenceReceipt;
  }
  return true;
}

export function polishImageForPublish(dataUrl, seedText = "") {
  return polishPublishImage(dataUrl, seedText);
}

export async function urlToDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("图片 URL 下载失败：" + res.status);
  const blob = await res.blob();
  return await fileToDataUrl(blob);
}

function normalizeRefIds(ids = []) {
  return [...new Set((ids || []).filter(Boolean))].slice(0, MAX_IMAGE_REFS);
}

function refIdsOf(A) {
  const ids = Array.isArray(A.sharedRefAssetIds) ? A.sharedRefAssetIds.filter(Boolean) : [];
  if (A.sharedRefAssetId && !ids.includes(A.sharedRefAssetId)) ids.unshift(A.sharedRefAssetId);
  return normalizeRefIds(ids);
}

function refAssetsForIds(ids = []) {
  return normalizeRefIds(ids).map(id => state.assets.find(x => x.id === id)).filter(Boolean);
}

function refAssetsOf(A) {
  return refAssetsForIds(refIdsOf(A));
}

/**
 * 单张定制参考优先，同时保留统一参考作为不足五张时的补充。
 * 这样单图的拖入参考不会改变同一生产单的其他图，也不会破坏旧生产单。
 */
export function imageReferenceIdsForSlot(A, item = {}) {
  const itemIds = normalizeRefIds(item?.refAssetIds);
  // 已完成的视觉规划优先：它既保留本张定制参考，也允许统一参考只路由到真正需要的图卡。
  if (["shared-vision-plan", "slot-vision-plan"].includes(String(item?.referenceSource || ""))
    && Array.isArray(item?.plannedRefAssetIds)) {
    return normalizeRefIds(item.plannedRefAssetIds);
  }
  // 本张定制参考由用户显式给出，优先于自动规划；统一参考仍作为补充附件。
  if (itemIds.length) return normalizeRefIds([...itemIds, ...refIdsOf(A)]);
  // 统一参考可由视觉模型按图卡选择；空数组同样是有意“不使用参考图”的结果。
  if (Array.isArray(item?.plannedRefAssetIds)) return normalizeRefIds(item.plannedRefAssetIds);
  return refIdsOf(A);
}

function setRefIds(A, ids) {
  const clean = normalizeRefIds(ids);
  A.sharedRefAssetIds = clean;
  A.sharedRefAssetId = clean[0] || null; // 兼容旧字段/旧部署
  delete A.referencePlan;
  (A.items || []).forEach(item => {
    delete item.plannedRefAssetIds;
    delete item.referenceInstruction;
  });
}

function appendRefId(A, id) {
  if (!id) return;
  setRefIds(A, [...refIdsOf(A), id]);
}

export async function providerRefsFor(A, refIds = refIdsOf(A)) {
  const refs = [];
  for (const a of refAssetsForIds(refIds)) {
    const u = urlFor(a);
    let dataUrl = "";
    let publicUrl = "";
    if (/^data:/.test(u || "")) dataUrl = u;
    else if (u) {
      try {
        dataUrl = await urlToDataUrl(u);
      } catch (_) {
        if (/^https?:\/\//.test(u)) publicUrl = u;
      }
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

export function imageReferenceReceiptLabel(receipt) {
  const intended = Number(receipt?.intendedRefs || 0);
  if (!intended) return "";
  const used = Number(receipt?.usedRefs || 0);
  const skipped = Number(receipt?.skippedRefs || Math.max(0, intended - used));
  const mode = String(receipt?.mode || "").trim();
  return `参考图实际使用 ${used}/${intended}${skipped ? `，${skipped} 张未被接收` : ""}${mode ? ` · ${mode}` : ""}`;
}

function refNamesOf(A, extra = [], refIds = refIdsOf(A)) {
  return [...refAssetsForIds(refIds).map(a => a.name), ...extra].filter(Boolean).slice(0, MAX_IMAGE_REFS);
}

export function enrichPromptWithRefs(prompt, A, refIds = refIdsOf(A), referenceInstruction = "") {
  const names = refNamesOf(A, [], refIds);
  if (!names.length) return prompt || "";
  const body = String(prompt || "").replace(/负面约束\s*[:：][\s\S]*$/g, "").trim();
  const useNote = String(referenceInstruction || "").replace(/\s+/g, " ").trim().slice(0, 220);
  const hasPlacement = /附件使用\s*[:：]/.test(body);
  const refNote = `参考图：本次提供 ${names.length} 张参考图（${names.join("、")}），以本次提示词的主题和文字内容为准。${useNote && !hasPlacement ? `\n附件使用：${useNote}` : ""}`;
  return `${body}\n\n${refNote}\n\n${IMAGE_NEGATIVE_PROMPT}`.trim();
}

function normalizeImageWorkshopText(text = "") {
  return String(text || "")
    .replace(/\\r\\n|\\n|\\r/g, " ")
    .replace(/(?:本张只展开|围绕正文分配信息)「([^」]+)」[^。；;]*[。；;]?/g, "画面核心内容：「$1」。")
    .replace(/信息密度按[^。；;]+[。；;]?/g, "")
    .replace(/不重复封面[^。；;]*[。；;]?/g, "")
    .replace(/也不提前讲后续内容[^。；;]*[。；;]?/g, "")
    .replace(/正文第\d+部分[:：]/g, "")
    .replace(/只基于正文信息「([^」]+)」换一个表达角度展开[^。；;]*/g, "$1")
    .replace(/小红书竖版3:4（1080×1440）\s*[，,。；;]?\s*（1080×1440）/g, "小红书竖版3:4（1080×1440）")
    .replace(/小红书竖版3:4（1080×1440）\s*[，,。；;]?\s*画面以小红书竖版3:4（1080×1440）为主/g, "小红书竖版3:4（1080×1440）")
    .replace(/画面以小红书竖版3:4（1080×1440）为主/g, "画面按小红书竖版3:4（1080×1440）出图")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGeneratedLineBreaks(text = "") {
  return String(text || "")
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ratioFromImagePrompt(text = "", fallback = "3:4") {
  const s = String(text || "");
  if (/9\s*[:：]\s*16|1080\s*[x×]\s*1920|竖屏\s*9\s*[:：]\s*16/.test(s)) return "9:16";
  if (/16\s*[:：]\s*9|1920\s*[x×]\s*1080|横屏\s*16\s*[:：]\s*9/.test(s)) return "16:9";
  if (/4\s*[:：]\s*3|1440\s*[x×]\s*1080/.test(s)) return "4:3";
  if (/1\s*[:：]\s*1|1024\s*[x×]\s*1024|1080\s*[x×]\s*1080|正方形(?:画布|尺寸|图片|配图)|方形(?:画布|图片|配图)/.test(s)) return "1:1";
  if (/3\s*[:：]\s*4|1080\s*[x×]\s*1440|小红书竖版|小红书笔记/.test(s)) return "3:4";
  return fallback;
}

function promptForImageModel(text = "") {
  const bannedLabels = "种草|痛点|共鸣|构图|封面|首图|痛点引入|问题引入|关键步骤|结果对比|总结收束|图\\d+|第\\d+张|步骤一|步骤二|步骤三";
  const cleaned = normalizeImageWorkshopText(text)
    .replace(new RegExp(`图上文字[：:]\\s*[「“"]?(?:${bannedLabels})[」”"]?`, "g"), "图上文字按本页标题与副标题生成")
    .replace(new RegExp(`图片任务[：:]\\s*(?:${bannedLabels})[，,。；;]?`, "g"), "图片任务：")
    .replace(new RegExp(`\\b(?:${bannedLabels})[：:]`, "g"), "")
    .replace(/负面约束\s*[:：][\s\S]*$/g, IMAGE_NEGATIVE_PROMPT);
  return /负面约束\s*[:：]/.test(cleaned)
    ? cleaned
    : `${cleaned}\n\n${IMAGE_NEGATIVE_PROMPT}`;
}

export function renderSlotsPage(root, p, isImg) {
  const acc = accountById(p.accountId);
  const A = isImg ? p.artifacts.images : p.artifacts.boards;
  const page = isImg ? "images" : "boards";
  let genMode = "in";
  let imageModeDirection = "";
  modeBySlot.set(p.id, "in");
  const S = p.artifacts.script;
  const products = primaryProducts();
  const allowCustomCopy = isImg && !p.batchId && p.origin !== "agent";
  const allowSingleImageMode = isImg && !p.batchId && p.origin !== "agent";
  if (isImg) {
    p.artifacts.copy = p.artifacts.copy || { title: "", body: "" };
    S.productId = primaryProductById(S.productId || "dumate")?.id || "dumate";
    S.imageCount = S.imageCount || DEFAULT_XHS_IMAGE_COUNT;
    S.direction = S.direction || "";
    S.useOnlineTrends = false;
    if (isImg) A.customCopyMode = true;
    else if (allowCustomCopy && A.customCopyMode == null) A.customCopyMode = true;
    A.customCopyMode = isImg ? true : (allowCustomCopy ? A.customCopyMode !== false : false);
    if (!allowSingleImageMode) A.creationMode = "copy";
    else if (!["copy", "single"].includes(A.creationMode)) A.creationMode = "copy";
    if (A.creationMode === "single" && (A.items || []).length > 1) {
      if (!(A.copyItems || []).length) A.copyItems = [...A.items];
      A.items = A.singleItem ? [A.singleItem] : [];
    }
    if (p.stage === "script") p.stage = "images";
  }

  // 槽位缺失时按脚本初始化
  if (!(A.items || []).length && (p.artifacts.script.shots || []).length && (!isImg || A.creationMode !== "single")) {
    A.items = p.artifacts.script.shots.map((s, i) => ({ title: s.idea || `${isImg ? "图" : "分镜"}${i + 1}`, visual: s.visual || "", prompt: "", assetId: null, status: "idle" }));
    save("productions");
  }

  function syncImageFactoryDraft() {
    if (!isImg) return;
    const count = $("#imgCount", root);
    if (count) S.imageCount = Math.max(1, Math.min(12, parseInt(count.value, 10) || S.imageCount || DEFAULT_XHS_IMAGE_COUNT));
    S.useOnlineTrends = false;
  }

  function syncCopyDraft() {
    if (!isImg) return;
    if (A.creationMode === "single") {
      const singleTitle = $("#imgSingleTitle", root);
      const singlePrompt = $("#imgSinglePrompt", root);
      const singleCopy = $("#imgSingleCopy", root);
      if (singleTitle) A.singleTitle = singleTitle.value.trim();
      if (singlePrompt) A.singlePrompt = singlePrompt.value.trim();
      if (singleCopy) {
        const body = normalizeGeneratedLineBreaks(singleCopy.value);
        p.artifacts.copy = { title: A.singleTitle || "", body, source: body ? "manual" : "" };
        A.singleResult = { ...p.artifacts.copy };
      }
      return;
    }
    const C = p.artifacts.copy || (p.artifacts.copy = { title: "", body: "" });
    const title = $("#imgCopyTitle", root);
    const body = $("#imgCopyBody", root);
    if (title) C.title = title.value.trim();
    if (body) C.body = body.value.trim();
  }

  function referencePlanSignature(items, refs) {
    const source = JSON.stringify({
      title: p.artifacts.copy?.title || p.title || p.topic || "",
      body: p.artifacts.copy?.body || p.artifacts.copy?.copy || "",
      // 使用图卡草案而不是最终图片提示词，确保编排发生在提示词生成之前。
      items: (items || []).map(item => [item?.title || item?.idea || "", item?.visual || item?.line || item?.prompt || ""]),
      refs: (refs || []).map(ref => [ref.id, ref.role, ref.slotIndex])
    });
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
    return `ref-plan-${(hash >>> 0).toString(36)}`;
  }

  async function referenceCandidatesForCards(draftCards = [], previousItems = A.items || []) {
    const sharedIds = refIdsOf(A);
    const customById = new Map();
    (previousItems || []).forEach((item, index) => {
      normalizeRefIds(item?.refAssetIds).forEach(id => {
        if (!sharedIds.includes(id) && !customById.has(id)) customById.set(id, index);
      });
    });
    const allIds = normalizeRefIds([...sharedIds, ...customById.keys()]);
    const refs = await providerRefsFor(A, allIds);
    return refs.map(ref => {
      const slotIndex = customById.has(ref.id) ? customById.get(ref.id) : -1;
      return { ...ref, role: slotIndex >= 0 ? "custom" : "shared", slotIndex };
    });
  }

  function fallbackPlanForCards(cards = [], refs = [], previousItems = A.items || []) {
    const sharedIds = refs.filter(ref => ref.role !== "custom").map(ref => ref.id);
    return (cards || []).map((_, index) => ({
      index,
      referenceIds: normalizeRefIds([
        // 视觉模型暂不可用时不把所有统一参考图混入每一张。多图按图卡
        // 轮转，单图仍可维持整组视觉一致性；单图定制参考始终只留在本图。
        ...(sharedIds.length <= 1 ? sharedIds : [sharedIds[index % sharedIds.length]]),
        ...normalizeRefIds((previousItems[index] || {}).refAssetIds)
      ]),
      instruction: ""
    }));
  }

  async function prepareSharedReferencesForCopy(title = "") {
    const refs = await providerRefsFor(A, refIdsOf(A));
    const signature = JSON.stringify({ title: String(title || "").trim(), refs: refs.map(ref => ref.id) });
    if (A.copyReferenceBrief?.signature === signature) return A.copyReferenceBrief;
    const result = await AI.prepareImageCopyReferenceContext({ title, refs });
    const brief = {
      signature,
      source: result.source || "unavailable",
      model: result.model || "",
      brief: String(result.brief || "").trim(),
      at: Date.now()
    };
    A.copyReferenceBrief = brief;
    return brief;
  }

  function applyPromptReferencePlan(items = A.items || [], planCards = [], source = "fallback") {
    const byIndex = new Map((planCards || []).map(card => [Number(card.index), card]));
    (items || []).forEach((item, index) => {
      if (!item) return;
      const card = byIndex.get(index);
      if (source === "vision" && card) {
        item.plannedRefAssetIds = normalizeRefIds(card.referenceIds);
        item.referenceInstruction = card.instruction || "";
        item.referenceSource = normalizeRefIds(item.refAssetIds).length ? "slot-vision-plan" : "shared-vision-plan";
      } else {
        delete item.plannedRefAssetIds;
        delete item.referenceInstruction;
        if (!item.referenceSource || /vision-plan/.test(item.referenceSource)) delete item.referenceSource;
      }
    });
  }

  async function prepareReferencesForPromptCards(draftCards = [], previousItems = A.items || []) {
    if (!isImg || !draftCards.length) return { source: "no-references", cards: [] };
    const refs = await referenceCandidatesForCards(draftCards, previousItems);
    if (!refs.length) {
      A.referencePlan = { signature: "", source: "no-references", model: "", cards: [], at: Date.now() };
      return { source: "no-references", cards: [] };
    }
    const signature = referencePlanSignature(draftCards, refs);
    if (A.referencePlan?.signature === signature && Array.isArray(A.referencePlan?.cards)) {
      return { source: A.referencePlan.source || "fallback", cards: A.referencePlan.cards };
    }
    const result = await AI.planImageReferenceUsage({
      title: p.artifacts.copy?.title || p.title || p.topic || "",
      body: p.artifacts.copy?.body || p.artifacts.copy?.copy || "",
      cards: draftCards.map((item, index) => ({
        index,
        title: item?.title || item?.idea || `图${index + 1}`,
        prompt: item?.visual || item?.line || item?.prompt || ""
      })),
      refs
    });
    const byIndex = new Map((result.cards || []).map(card => [Number(card.index), card]));
    const vision = result.source === "vision" && byIndex.size > 0;
    const fallbackCards = fallbackPlanForCards(draftCards, refs, previousItems);
    const fallbackByIndex = new Map(fallbackCards.map(card => [card.index, card]));
    const cards = vision
      ? draftCards.map((_, index) => {
        const card = byIndex.get(index);
        // 模型输出被截断时，缺失的图卡不能被误判为“刻意不使用附件”。
        return card ? {
          index,
          referenceIds: normalizeRefIds(card.referenceIds),
          instruction: card.instruction || ""
        } : (fallbackByIndex.get(index) || { index, referenceIds: [], instruction: "" });
      })
      : fallbackCards;
    A.referencePlan = { signature, source: vision ? "vision" : result.source || "fallback", model: result.model || "", cards, at: Date.now() };
    return { source: A.referencePlan.source, cards };
  }

  async function planCustomReferencesForSlot(item, index) {
    const itemIds = normalizeRefIds(item?.refAssetIds);
    if (!itemIds.length) {
      return {
        ids: imageReferenceIdsForSlot(A, item),
        instruction: item?.referenceInstruction || ""
      };
    }
    const candidateIds = imageReferenceIdsForSlot(A, item);
    const refs = (await providerRefsFor(A, candidateIds)).map(ref => ({
      ...ref,
      role: itemIds.includes(ref.id) ? "custom" : "shared",
      slotIndex: itemIds.includes(ref.id) ? index : -1
    }));
    const result = await AI.planImageReferenceUsage({
      title: p.artifacts.copy?.title || p.title || p.topic || "",
      body: p.artifacts.copy?.body || p.artifacts.copy?.copy || "",
      cards: [{ index, title: item?.title || `图${index + 1}`, prompt: item?.prompt || "" }],
      refs
    });
    const card = (result.cards || []).find(entry => Number(entry.index) === index);
    if (result.source === "vision" && card) {
      // 用户刚添加的定制图对本图是强约束；即使规划模型漏选也不能在提交时丢失。
      item.plannedRefAssetIds = normalizeRefIds([...itemIds, ...normalizeRefIds(card.referenceIds)]);
      item.referenceInstruction = card.instruction || "";
      item.referenceSource = "slot-vision-plan";
      return { ids: item.plannedRefAssetIds, instruction: item.referenceInstruction };
    }
    return { ids: candidateIds, instruction: item?.referenceInstruction || "" };
  }

  async function refreshPromptForReferencePlan(item, index, referencePlan) {
    // 定制参考是用户刚刚针对单张图添加的输入。提示词没有被人工改写时，
    // 重新按“整组同规格图卡 + 本图附件角色”生成这一张，而不是在旧提示词末尾补一句。
    if (!isImg || !item?.referencePromptNeedsRefresh || item.promptUserEdited || !referencePlan?.instruction) return;
    const cards = (A.items || []).map((current, cardIndex) => ({
      idea: current?.title || `图${cardIndex + 1}`,
      visual: current?.visual || current?.prompt || "",
      line: current?.title || ""
    }));
    if (!cards.length) return;
    const referencePlans = cards.map((_, cardIndex) => {
      const current = A.items[cardIndex] || {};
      if (cardIndex === index) {
        return { index, referenceIds: referencePlan.ids, instruction: referencePlan.instruction };
      }
      return {
        index: cardIndex,
        referenceIds: imageReferenceIdsForSlot(A, current),
        instruction: current.referenceInstruction || ""
      };
    });
    try {
      const res = await AI.generateImagePrompts({
        script: shotsToText(cards, true),
        account: acc,
        style: p.artifacts.script.style || S.style || acc.styleProfile || "",
        imageTemplate: acc.imagePromptTemplate || "",
        styleRefName: "",
        imageCount: cards.length,
        product: productById(p.artifacts.script.productId),
        topic: p.topic,
        copy: p.artifacts.copy,
        referencePlans,
        requireLlm: true
      });
      const nextPrompt = (res.shots || [])[index]?.prompt;
      if (nextPrompt) {
        item.prompt = nextPrompt;
        item.referencePromptNeedsRefresh = false;
      }
    } catch (_) {
      // 参考图仍会以真实附件提交；下次点击可再尝试按规划重写完整提示词。
    }
  }

  function splitCopyBeats(title = "", body = "", count = DEFAULT_XHS_IMAGE_COUNT) {
    const withoutTags = normalizeGeneratedLineBreaks(body).replace(/#[^\s#]+/g, " ");
    const sentences = withoutTags
      .replace(/\n+/g, "。")
      .split(/[。！？!?；;]+/)
      .map(x => x.replace(/\s+/g, " ").trim())
      .filter(x => x && x.length > 4);
    const first = title || sentences[0] || "本次主题";
    const beats = [first, ...sentences.filter(x => x !== first)];
    return Array.from({ length: count }, (_, i) => beats[i] || beats[beats.length - 1] || first);
  }

  function buildCustomCopyShots(copy, count, product) {
    const title = (copy?.title || "").trim();
    const body = (copy?.body || copy?.copy || "").trim();
    const productName = product?.shortName || product?.name || "百度搭子";
    const beats = splitCopyBeats(title, body, count);
    if (count === 1) {
      return [{
        idea: title || beats[0],
        visual: `做成一张有序信息图：上部是发布标题的强视觉入口，中部用2到3个${productName}相关的关键动作、证据或流程卡解释正文，底部用一句结论收束；不出现页码、内页或拆页字样。`,
        line: title || beats[0]
      }];
    }
    return beats.map((beat, i) => {
      const shortBeat = beat.slice(0, i === 0 ? 36 : 46);
      if (i === 0) {
        return {
          idea: title || shortBeat,
          visual: `围绕发布标题「${title || shortBeat}」做强点击入口，主视觉和短副标题必须服务这篇文案，不引入文案外的新主题。`,
          line: title || shortBeat
        };
      }
      if (count === 2 && i === 1) {
        return {
          idea: shortBeat,
          visual: `围绕发布文案里的信息「${shortBeat}」做一张干货信息图，用${productName}相关的具体动作、步骤卡、证据或可复核结果组织内容，层级清楚但不堆小字。`,
          line: shortBeat
        };
      }
      return {
        idea: shortBeat,
        visual: `围绕发布文案里的信息「${shortBeat}」展开，用${productName}相关的真实办公动作、流程卡片、结果对照或可复核清单表达。`,
        line: shortBeat
      };
    });
  }

  const draw = () => {
    syncImageFactoryDraft();
    const items = A.items || [];
    const C = p.artifacts.copy || { title: "", body: "" };
    const customCopyMode = allowCustomCopy && !!A.customCopyMode;
    const singleImageMode = allowSingleImageMode && A.creationMode === "single";
    const got = items.filter(x => x.assetId).length;
    const refs = refAssetsOf(A);
    const trendPanel = "";
    const flowTitle = isImg
      ? (customCopyMode ? "自定义文案 → 图卡提示词 → 一键生成 / 上传补图" : "创作内容 → 文案标题 → 图卡提示词 → 一键生成 / 上传补图")
      : "按脚本逐镜头出分镜图";
    const imageCreationSwitcher = isImg && allowSingleImageMode ? `<div class="image-creation-mode" data-mode="${singleImageMode ? "single" : "copy"}" role="tablist" aria-label="图文创作方式">
      <button type="button" class="${singleImageMode ? "" : "is-active"}" data-image-creation-mode="copy">文案组图</button>
      <button type="button" class="${singleImageMode ? "is-active" : ""}" data-image-creation-mode="single">单图创作</button>
    </div>` : "";
    root.innerHTML = `
      ${stepperHtml(p, page)}
      <div class="chain-page solo">
        <div class="chain-main">
          <div class="page-head">
            <div><div class="eyebrow">${isImg ? "图文链路 · 图文创作台" : "视频链路 · 分镜图"}</div>
            <h2>${flowTitle} <span class="head-count">${got}/${items.length}</span></h2></div>
            ${isImg ? "" : `<div class="head-actions">
              ${isImg ? "" : `<button class="btn ghost" id="cbSkip">跳过此步 ${icon("arrowRight", 13)}</button>`}
              <button class="btn primary button-anthe" id="cbNext"><span>下一步：${isImg ? "审核" : "提示词"} ${icon("arrowRight", 14)}</span></button>
            </div>`}
          </div>

          ${isImg ? `
          <div class="image-mode-stage ${imageModeDirection ? `is-${imageModeDirection}` : ""}" data-image-mode-stage>
          ${trendPanel ? "" : singleImageMode ? `<div class="single-image-inline card image-mode-panel">
            <div class="copy-inline-head">
              <div><b>${icon("image", 14)} 单图创作</b><em>标题生成发布文案；提示词和账号视觉风格只负责生成这一张图片</em></div>
              <div class="copy-inline-actions">${imageCreationSwitcher}<button class="btn gen sm" id="imgSingleRun">${icon("spark", 13)} 生成单图并写文案</button><button class="btn primary sm button-anthe" id="cbNext"><span>下一步：审核 ${icon("arrowRight", 14)}</span></button></div>
            </div>
            <label class="field">标题
              <input class="input" id="imgSingleTitle" value="${esc(A.singleTitle || C.title || "")}" required placeholder="必填标题：用于同步生成发布文案" />
            </label>
            <label class="field">提示词
              <textarea class="input" id="imgSinglePrompt" rows="5" required placeholder="必填：完整描述你想生成的单张图片内容；账号风格只影响视觉设计。">${esc(A.singlePrompt || "")}</textarea>
            </label>
            ${A.singleCopyError ? `<p class="single-image-error">${esc(A.singleCopyError)}</p>` : ""}
            <label class="field single-image-copy-field">发布文案
              <textarea class="input" id="imgSingleCopy" rows="5" placeholder="可直接填写；留空则在生成单图时根据标题生成，已填内容不会被覆盖。">${esc(normalizeGeneratedLineBreaks(C.body || ""))}</textarea>
            </label>
          </div>` : `<div class="copy-inline card image-mode-panel ${customCopyMode ? "is-custom-copy" : ""}">
            <div class="copy-inline-head">
              <div><b>${icon("image", 14)} 图文创作台</b><em>${customCopyMode ? "标题、正文和图卡提示词在这里一次准备" : "文案先生成，图卡提示词会轻量呼应；可在这里直接微调"}</em></div>
              <div class="copy-inline-actions">${imageCreationSwitcher}<label class="image-count-select">${icon("image", 12)}<span>图片数量</span><select class="input" id="imgCount">${Array.from({ length: 12 }, (_, i) => i + 1).map(count => `<option value="${count}" ${count === Number(S.imageCount || DEFAULT_XHS_IMAGE_COUNT) ? "selected" : ""}>${count} 张</option>`).join("")}</select></label><button class="btn gen sm" id="imgFactoryGen">${icon("spark", 13)} 按标题生成正文与图卡提示词</button><button class="btn primary sm button-anthe" id="cbNext"><span>下一步：审核 ${icon("arrowRight", 14)}</span></button></div>
            </div>
            <label class="field">标题
              <input class="input" id="imgCopyTitle" value="${esc(C.title || "")}" required placeholder="${customCopyMode ? "必填标题：填写发布标题，图片封面会完整围绕它" : "必填标题：生成后可编辑"}" />
            </label>
            <label class="field">正文
              <textarea class="input" id="imgCopyBody" rows="5" placeholder="${customCopyMode ? "粘贴或写入最终正文；系统会按正文含义拆成图卡提示词。" : "发布文案会随交付包带出；生成图卡前会优先准备它。"}">${esc(normalizeGeneratedLineBreaks(C.body || ""))}</textarea>
            </label>
          </div>`}
          ${trendPanel}</div>` : ""}

          <div class="refbar card img-ref-generation" id="cbRefbar">
            <span class="refbar-drop-cue" aria-hidden="true">${icon("upload", 18)}<b>拖入统一参考图</b><em>松手即可加入</em></span>
            <div class="refbar-left">
              <b>${icon("star", 13)} 统一参考图</b>
              <em>生成和上传补图都会保留这些参考（最多 5 张：logo / 角色版 / 界面截图）· 可拖图到此</em>
            </div>
            <div class="refbar-chip">${refs.length
              ? refs.map(a => `<span class="ref-chip">${thumbHtml(a)}<span>${esc(a.name)}</span><button class="ref-x" data-ref-rm="${a.id}">${icon("x", 11)}</button></span>`).join("")
              : `<span class="muted">未设置（建议）</span>`}</div>
            <div class="refbar-actions">
              <button class="btn ghost sm" id="cbRefPick">从资产选择</button>
              <label class="btn ghost sm">上传<input type="file" accept="image/*" multiple hidden id="cbRefUp" /></label>
              ${isImg && !singleImageMode ? `<button class="btn gen" id="cbGenAllImages">${icon("spark", 15)} 一键生成全部图片</button>` : ""}
            </div>
          </div>
          <div id="cbRefChooser" class="ref-chooser card" hidden></div>

          ${isImg ? "" : `<div class="inhouse-controls">
            <button class="btn gen" id="cbGenPrompts">${icon("spark", 15)} 按脚本生成分镜图提示词</button>
            <span class="muted">${imageApiConfigured() ? "" : "图片 API 未接入"}</span>
          </div>`}

          <div class="slot-cards" id="cbCards">${items.map((it, i) => slotCard(it, i, isImg)).join("") ||
            `<div class="empty-state slim">${icon("image", 22)}<b>${isImg ? "先在上方图文创作台生成图卡结构" : "先回脚本页生成脚本"}</b><p>每${isImg ? "张图" : "个镜头"}会在这里生成一个出图槽位</p></div>`}</div>
        </div>
      </div>`;
    wireStepper(root);
    wire();
  };

  function slotCard(it, i, img) {
    const u = it.assetId ? urlFor(it.assetId) : null;
    const refined = img && it.assetId;
    const loading = it.status === "loading";
    const shownPrompt = img ? normalizeImageWorkshopText(it.prompt || "") : (it.prompt || "");
    const shownVisual = img ? normalizeImageWorkshopText(it.visual || "") : (it.visual || "");
    const referenceReceiptLabel = imageReferenceReceiptLabel(it.referenceReceipt);
    const customRefIds = normalizeRefIds(it.refAssetIds);
    const customRefs = refAssetsForIds(customRefIds);
    const allowSlotRefs = img && !p.batchId;
    return `<div class="slot-card card ${img ? "is-image-slot" : ""} ${loading ? "is-generating" : ""}" data-slot="${i}">
      <span class="sc-num">${i + 1}</span>
      <div class="sc-text">
        <div class="sc-line">${esc(it.title || "")}<em>${esc(shownVisual.slice(0, 60))}</em></div>
        <div class="sc-prompt" contenteditable="true" data-prompt="${i}" data-ph="点右侧按钮生成图片，或手写提示词">${esc(shownPrompt)}</div>
        ${allowSlotRefs ? `<div class="sc-slot-refbar" data-slot-ref-drop="${i}">
          <span class="sc-slot-ref-label">本张定制参考图</span>
          <div class="sc-slot-ref-list">${customRefs.length
            ? customRefs.map(a => `<span class="sc-slot-ref-chip">${thumbHtml(a)}<span>${esc(a.name)}</span><button type="button" class="ref-x" data-slot-ref-rm="${i}:${a.id}" title="移除此图参考">${icon("x", 10)}</button></span>`).join("")
            : `<em>未设置，默认沿用统一参考图</em>`}</div>
          <label class="btn ghost sm sc-slot-ref-upload">${icon("upload", 12)} 拖入 / 上传<input type="file" accept="image/*" multiple hidden data-slot-ref-up="${i}" /></label>
        </div>` : ""}
        ${referenceReceiptLabel ? `<div class="${Number(it.referenceReceipt?.usedRefs || 0) > 0 ? "muted" : "sc-error"}">${esc(referenceReceiptLabel)}</div>` : ""}
        ${it.error ? `<div class="sc-error">${esc(it.error)}</div>` : ""}
      </div>
      <div class="sc-thumb" data-thumb="${i}">
        ${u ? `<img src="${u}"/>` : it.status === "loading"
          ? `<div class="sc-loading"><span class="spin-dot"></span></div>`
          : it.status === "done" ? `<div class="sc-empty">待图片</div>`
          : `<div class="sc-empty"><span>3:4</span><em>待生成</em></div>`}
        ${refined ? `<span class="sc-badge">已精修</span>` : ""}
      </div>
      <div class="sc-side">
        <button class="btn ghost sm" data-gen="${i}">${u || it.status === "done" ? "重新生成" : "生成此图"}</button>
        <label class="btn ghost sm">上传<input type="file" accept="image/*" hidden data-up="${i}" /></label>
      </div>
    </div>`;
  }

  const routePage = isImg ? "images" : "boards";
  const canRedrawCurrent = () => {
    const r = currentRoute();
    return root.isConnected && r.zone === "studio" && r.page === routePage && state.ui.activeProductionId === p.id;
  };

  function startImageRun(mode, index = null) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    A.imageRun = { token, mode, index, startedAt: Date.now() };
    return token;
  }

  function imageRunActive(token, mode = "") {
    if (!token) return true;
    return A.imageRun?.token === token && (!mode || A.imageRun.mode === mode);
  }

  function clearOtherLoadingSlots(index) {
    (A.items || []).forEach((x, j) => {
      if (j !== index && x.status === "loading" && !x.assetId) {
        x.status = "idle";
        x.error = "";
      }
    });
  }

  function switchImageCreationMode(next) {
    if (!allowSingleImageMode || next === A.creationMode) return;
    const oldStage = $("[data-image-mode-stage]", root);
    const oldHeight = oldStage?.getBoundingClientRect().height || 0;
    syncCopyDraft();
    if (A.creationMode === "copy") {
      A.copyItems = [...(A.items || [])];
      A.copyDraft = { ...(p.artifacts.copy || { title: "", body: "" }) };
    } else {
      A.singleItem = (A.items || [])[0] || null;
      A.singleResult = { ...(p.artifacts.copy || { title: A.singleTitle || "", body: "" }) };
    }
    imageModeDirection = next === "single" ? "forward" : "backward";
    A.creationMode = next;
    if (next === "single") {
      A.items = A.singleItem ? [A.singleItem] : [];
      p.artifacts.copy = { ...(A.singleResult || { title: A.singleTitle || "", body: "" }) };
    } else {
      A.items = [...(A.copyItems || [])];
      p.artifacts.copy = { ...(A.copyDraft || { title: "", body: "" }) };
    }
    A.singleCopyError = "";
    save("productions");
    draw();
    const stage = $("[data-image-mode-stage]", root);
    if (!stage) return;
    const targetHeight = stage.scrollHeight;
    if (oldHeight && Math.abs(targetHeight - oldHeight) > 2 && stage.animate) {
      stage.style.height = `${oldHeight}px`;
      stage.style.overflow = "hidden";
      stage.animate([{ height: `${oldHeight}px` }, { height: `${targetHeight}px` }], {
        duration: 300,
        easing: "cubic-bezier(.22,.75,.2,1)"
      }).finished.finally(() => {
        stage.style.height = "";
        stage.style.overflow = "";
      });
    }
    imageModeDirection = "";
  }

  function wire() {
    if (isImg) {
      $$('[data-image-creation-mode]', root).forEach(button => button.addEventListener("click", () => {
        const next = button.dataset.imageCreationMode;
        switchImageCreationMode(next);
      }));
      $("#imgCount", root)?.addEventListener("change", e => {
        const count = Math.max(1, Math.min(12, parseInt(e.target.value, 10) || DEFAULT_XHS_IMAGE_COUNT));
        S.imageCount = count;
        A.items = resizeImageSlots(A.items, count);
        A.copyItems = [...A.items];
        save("productions");
        draw();
      });
      $("#imgFactoryGen", root)?.addEventListener("click", e => withLoading(e.currentTarget, generateImageWorkshop, "生成中…"));
      $("#imgCopyTitle", root)?.addEventListener("input", e => { p.artifacts.copy.title = e.target.value; save("productions"); });
      $("#imgCopyBody", root)?.addEventListener("input", e => {
        p.artifacts.copy.body = e.target.value;
        p.artifacts.copy.source = "manual";
        save("productions");
      });
      $("#imgSingleTitle", root)?.addEventListener("input", e => { A.singleTitle = e.target.value; save("productions"); });
      $("#imgSinglePrompt", root)?.addEventListener("input", e => { A.singlePrompt = e.target.value; save("productions"); });
      $("#imgSingleCopy", root)?.addEventListener("input", e => {
        p.artifacts.copy = { title: A.singleTitle || "", body: e.target.value, source: "manual" };
        A.singleResult = { ...p.artifacts.copy };
        save("productions");
      });
      $("#imgSingleRun", root)?.addEventListener("click", e => withLoading(e.currentTarget, generateSingleImageWorkflow, "生成中…"));
      $("#imgCopyGen", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
        await generateImageCopy({ force: true });
        draw();
      }, "生成文案中…"));
    }

    $$(".mode-tab", root).forEach(t => t.addEventListener("click", () => {
      syncImageFactoryDraft();
      genMode = "in"; modeBySlot.set(p.id, "in");
    }));

    // 统一参考
    const refbar = $("#cbRefbar", root);
    wireDropZone(refbar, async files => { await setRefsFromFiles(files); });
    $$("[data-ref-rm]", root).forEach(btn => btn.addEventListener("click", () => {
      syncImageFactoryDraft();
      setRefIds(A, refIdsOf(A).filter(id => id !== btn.dataset.refRm));
      save("productions"); draw();
    }));
    $("#cbRefUp", root).addEventListener("change", async e => { syncImageFactoryDraft(); await setRefsFromFiles(e.target.files); e.target.value = ""; });
    $("#cbRefPick", root).addEventListener("click", () => {
      const box = $("#cbRefChooser", root);
      if (!box.hidden) { box.hidden = true; return; }
      const assets = accountAssets(acc.id).filter(a => a.type === "图片");
      box.innerHTML = assets.length ? `<div class="ref-grid">${assets.map(a => `
        <div class="ref-item ${refIdsOf(A).includes(a.id) ? "is-picked" : ""}" data-ref="${a.id}" role="button" tabindex="0">${thumbHtml(a)}<span>${esc(a.name)}</span>${canDeleteReferenceAsset(a) ? `<button class="ref-del" data-ref-del="${a.id}" title="删除参考图">${icon("trash", 11)}</button>` : ""}</div>`).join("")}</div>`
        : `<div class="muted" style="padding:10px">该账号还没有图片资产，先上传一张</div>`;
      box.hidden = false;
      box.querySelectorAll("[data-ref-del]").forEach(b => b.addEventListener("click", async e => {
        e.stopPropagation();
        const a = state.assets.find(x => x.id === b.dataset.refDel);
        const ok = await confirmModal({ title: `删除参考图「${a?.name || "未命名图片"}」？`, body: "会从资产库移除，并从当前参考图选择中摘掉。", danger: true, okText: "删除" });
        if (!ok) return;
        syncImageFactoryDraft();
        setRefIds(A, refIdsOf(A).filter(id => id !== b.dataset.refDel));
        await removeAsset(b.dataset.refDel);
        save("productions");
        draw();
      }));
      box.querySelectorAll("[data-ref]").forEach(b => b.addEventListener("click", () => {
        syncImageFactoryDraft();
        appendRefId(A, b.dataset.ref); save("productions"); draw();
      }));
    });

    async function setRefsFromFiles(files) {
      syncImageFactoryDraft();
      const imgs = Array.from(files || []).filter(f => f && f.type.startsWith("image/"));
      if (!imgs.length) return;
      for (const f of imgs.slice(0, MAX_IMAGE_REFS)) {
        if (refIdsOf(A).length >= MAX_IMAGE_REFS) break;
        const dataUrl = await fileToDataUrl(f);
        const a = await addAssetFromDataUrl(acc.id, { name: f.name.replace(/\.[^.]+$/, ""), tags: ["参考图"], dataUrl });
        appendRefId(A, a.id);
      }
      save("productions");
      toast(`已添加 ${refIdsOf(A).length}/${MAX_IMAGE_REFS} 张统一参考图`);
      draw();
    }

    async function setSlotRefsFromFiles(index, files) {
      if (!isImg) return;
      const item = A.items?.[index];
      const imgs = Array.from(files || []).filter(file => file?.type?.startsWith("image/"));
      if (!item || !imgs.length) return;
      const nextIds = normalizeRefIds(item.refAssetIds);
      let added = 0;
      for (const file of imgs) {
        if (nextIds.length >= MAX_IMAGE_REFS) break;
        const dataUrl = await fileToDataUrl(file);
        const asset = await addAssetFromDataUrl(acc.id, {
          name: file.name.replace(/\.[^.]+$/, "") || `图${index + 1} 定制参考`,
          tags: ["参考图", "单张定制参考图"],
          dataUrl
        });
        nextIds.push(asset.id);
        added += 1;
      }
      if (!added) {
        toast(`本张最多 ${MAX_IMAGE_REFS} 张定制参考图`, "error");
        return;
      }
      item.refAssetIds = normalizeRefIds(nextIds);
      item.referenceSource = "slot";
      item.referencePromptNeedsRefresh = true;
      delete item.plannedRefAssetIds;
      delete item.referenceInstruction;
      save("productions");
      toast(`已为第 ${index + 1} 张添加 ${added} 张定制参考图`);
      draw();
    }

    $$('[data-slot-ref-up]', root).forEach(input => input.addEventListener("change", async event => {
      try {
        await setSlotRefsFromFiles(Number(input.dataset.slotRefUp), event.target.files);
      } catch (error) {
        toast(error?.message || "添加定制参考图失败", "error");
      } finally {
        event.target.value = "";
      }
    }));
    $$('[data-slot-ref-drop]', root).forEach(zone => wireDropZone(zone, async files => {
      try {
        await setSlotRefsFromFiles(Number(zone.dataset.slotRefDrop), files);
      } catch (error) {
        toast(error?.message || "添加定制参考图失败", "error");
      }
    }, { filesOnly: true }));
    $$('[data-slot-ref-rm]', root).forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const [rawIndex, assetId] = String(button.dataset.slotRefRm || "").split(":");
      const item = A.items?.[Number(rawIndex)];
      if (!item || !assetId) return;
      item.refAssetIds = normalizeRefIds((item.refAssetIds || []).filter(id => id !== assetId));
      if (!item.refAssetIds.length) delete item.referenceSource;
      item.referencePromptNeedsRefresh = true;
      delete item.plannedRefAssetIds;
      delete item.referenceInstruction;
      save("productions");
      draw();
    }));

    $("#cbGenAllImages", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
        const runToken = startImageRun("all");
        const items = A.items || [];
        if (!items.length) {
          await generateImageWorkshop();
        }
        const fresh = A.items || [];
        if (!fresh.length) { toast("还没有可生成的图卡"); return; }
        if (!imageApiConfigured()) { toast("图片 API 未接入，请先配置站内图片服务，或使用槽位上传补图", "error"); return; }
        fresh.forEach(x => {
          if (imageRunActive(runToken, "all") && x.prompt && !x.assetId) {
            x.status = "loading";
            x.error = "";
          }
        });
        save("productions");
        if (canRedrawCurrent()) draw();
        let ok = 0;
        for (let i = 0; i < fresh.length; i++) {
          if (!imageRunActive(runToken, "all")) {
            toast("已切换为单张生成，停止全量队列");
            return;
          }
          if (!fresh[i].prompt) continue;
          await generateOneImage(i, { redraw: true, silent: true, runToken, runMode: "all" });
          if (fresh[i].assetId) ok++;
        }
        if (!imageRunActive(runToken, "all")) return;
        save("productions");
        if (canRedrawCurrent()) draw();
        toast(ok ? "已生成" : "没有图片生成成功，请检查错误提示", ok ? "" : "error");
    }, "生成图片中…"));

    $("#cbGenPrompts", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
        const shots = p.artifacts.script.shots || [];
        if (!shots.length) { toast(isImg ? "先在图文创作台生成图卡结构" : "先回脚本页生成脚本"); return; }
        const sharedRefs = refAssetsOf(A);
        if (isImg) {
          const previousItems = A.items || [];
          const referencePlan = await prepareReferencesForPromptCards(shots, previousItems);
          const res = await AI.generateImagePrompts({
            script: shotsToText(shots, true),
            account: acc,
            style: p.artifacts.script.style,
            imageTemplate: acc.imagePromptTemplate || "",
            styleRefName: "",
            imageCount: p.artifacts.script.imageCount || (A.items || []).length || shots.length || DEFAULT_XHS_IMAGE_COUNT,
            product: productById(p.artifacts.script.productId),
            topic: p.topic,
            copy: p.artifacts.copy,
            referencePlans: referencePlan.cards
          });
          A.items = (res.shots || []).map((s, i) => ({
            title: s.title || `图${i + 1}`, visual: (shots[i] || {}).visual || "", prompt: s.prompt || "", ui: !!s.ui,
            assetId: (A.items[i] || {}).assetId || null,
            refAssetIds: normalizeRefIds((A.items[i] || {}).refAssetIds),
            referenceSource: (A.items[i] || {}).referenceSource || "",
            status: (A.items[i] || {}).assetId ? "done" : "idle"
          }));
          applyPromptReferencePlan(A.items, referencePlan.cards, referencePlan.source);
        } else {
          const res = await AI.generateStoryboardPrompts({ shots, account: acc, style: p.artifacts.script.style, sharedRefName: sharedRefs.map(x => x.name).join("、"), product: productById(p.artifacts.script.productId || "dumate") });
          A.items = shots.map((s, i) => ({
            title: s.idea || `分镜${i + 1}`, visual: s.visual || "",
            prompt: (res.shots[i] || {}).prompt || AI.fallbackStoryboardPrompt(s, acc, p.artifacts.script.style, sharedRefs.map(x => x.name).join("、")),
            assetId: (A.items[i] || {}).assetId || null, status: (A.items[i] || {}).assetId ? "done" : "idle"
          }));
        }
        save("productions");
        draw();
        toast(AI.sourceNote(`已生成 ${A.items.length} 条提示词`));
    }, "生成中…"));

    // 槽位编辑/上传/站内生成
    $$("[data-prompt]", root).forEach(el => el.addEventListener("blur", () => {
      const it = A.items[+el.dataset.prompt];
      if (it) { it.prompt = el.textContent.trim(); it.promptUserEdited = true; save("productions"); }
    }));
    $$("[data-up]", root).forEach(inp => inp.addEventListener("change", async e => {
      const f = e.target.files[0]; if (!f) return;
      await fillSlot(+inp.dataset.up, f);
      draw();
    }));
    $$("[data-gen]", root).forEach(b => b.addEventListener("click", async e => {
      e.preventDefault();
      e.stopPropagation();
      const index = +b.dataset.gen;
      const runToken = startImageRun("single", index);
      clearOtherLoadingSlots(index);
      save("productions");
      if (canRedrawCurrent()) draw();
      await generateOneImage(index, { single: true, runToken, runMode: "single" });
    }));
    $$(".sc-thumb img", root).forEach(im => im.addEventListener("click", () => openLightbox(im, im.src, "")));

    // 下一步
    $("#cbNext", root)?.addEventListener("click", () => {
      const items = A.items || [];
      const got = items.filter(x => x.assetId).length;
      if (isImg) {
        if (!got) { toast("还没有上传任何成图（至少上传 1 张）"); return; }
        if (!(p.artifacts.copy.body || "").trim()) { toast("先生成或填写发布文案"); return; }
        if (!(p.artifacts.copy.title || "").trim()) p.artifacts.copy.title = p.title || p.topic || "未命名内容";
        if (p.stage === "images" || p.stage === "copy") setStage(p, "review", "pending");
        go("studio", "review");
      } else {
        if (p.stage === "boards" && got === items.length && items.length) maybeAdvanceAfterInput(p);
        else if (p.stage === "boards") setStage(p, "prompts", (p.artifacts.prompts || []).length ? "done" : "pending");
        go("studio", "prompts");
      }
    });
    const skip = $("#cbSkip", root);
    if (skip) skip.addEventListener("click", () => {
      if (p.stage === "boards") setStage(p, "prompts", "pending");
      go("studio", "prompts");
    });
  }

  async function fillSlot(i, file) {
    const it = A.items[i]; if (!it) return;
    let dataUrl = await fileToDataUrl(file);
    if (isImg) dataUrl = await polishImageForPublish(dataUrl, `${p.id}-${i}-${it.title || ""}-${p.topic || ""}`);
    if (it.assetId) {
      await replaceAssetBlob(it.assetId, dataUrl);
      if (isImg) {
        const asset = state.assets.find(a => a.id === it.assetId);
        if (asset) asset.tags = Array.from(new Set([...(asset.tags || []), "笔记图", "发布前精修"]));
        save("assets");
      }
    } else {
      const a = await addAssetFromDataUrl(acc.id, {
        name: `${isImg ? "笔记图" : "分镜图"}${String(i + 1).padStart(2, "0")}_${(p.title || p.topic || "").slice(0, 6)}`,
        tags: isImg ? ["笔记图", "发布前精修"] : ["分镜图"], dataUrl
      });
      it.assetId = a.id;
    }
    it.status = "done";
    it.referenceReceipt = null;
    save("productions");
    const complete = (A.items || []).every(x => x.assetId);
    if (complete && ["failed", "pending"].includes(p.stageStatus)) maybeAdvanceAfterInput(p);
    toast(`${isImg ? "已上传并完成发布前精修" : "已上传"} ${i + 1}/${A.items.length}${complete ? " ✓ 全部就位" : ""}`);
  }

  async function generateOneImage(i, opts = {}) {
    const { redraw = true, silent = false, single = false, runToken = "", runMode = "" } = opts;
    if (!imageRunActive(runToken, runMode)) return;
    const it = A.items[i];
    if (!it) return;
    if (!it.prompt && isImg) {
      if (single) {
        toast("这张图还没有提示词，先点「生成图卡结构与提示词」");
        return;
      }
      await generateImageWorkshop();
    }
    const fresh = A.items[i];
    if (!fresh || !fresh.prompt) { toast("这张图还没有提示词，先生成图卡结构"); return; }
    if (!imageRunActive(runToken, runMode)) return;
    if (runMode === "single") clearOtherLoadingSlots(i);
    fresh.status = "loading";
    fresh.error = "";
    fresh.referenceReceipt = null;
    if (redraw && canRedrawCurrent()) draw();
    try {
      const provider = activeProviderFor("image");
      const key = providerKeyFor("image", provider);
      if (!imageApiConfigured() || provider?.mock) {
        throw new Error("图片 API 未接入：请配置站内图片服务，或使用槽位上传补图");
      } else {
        const referencePlan = await planCustomReferencesForSlot(fresh, i);
        await refreshPromptForReferencePlan(fresh, i, referencePlan);
        const intendedRefAssetIds = referencePlan.ids;
        const finalPrompt = enrichPromptWithRefs(
          promptForImageModel(fresh.prompt), A, intendedRefAssetIds, referencePlan.instruction
        );
        const refs = await providerRefsFor(A, intendedRefAssetIds);
        const r = await provider.submit({
          prompt: finalPrompt,
          refs,
          intendedRefAssetIds,
          ratio: ratioFromImagePrompt(finalPrompt, "3:4"),
          // The selected single-account canvas ratio is authoritative. Text in
          // reference-image descriptions may contain unrelated 16:9/4:3 sizes.
          strictRatio: true,
          apiKey: key?.secret,
          endpoint: key?.provider,
          model: key?.model || "custom-imagemodel-gt"
        });
        const out = await provider.poll(r.providerRef);
        fresh.referenceReceipt = out.output?.referenceReceipt || r.referenceReceipt || null;
        if (!imageRunActive(runToken, runMode)) return;
        if (out.status !== "succeeded" || !out.output?.dataUrl) throw new Error(out.error || "图片生成未返回结果");
        const dataUrl = out.output.dataUrl.startsWith("data:")
          ? out.output.dataUrl
          : await urlToDataUrl(out.output.dataUrl);
        const polished = isImg ? await polishImageForPublish(dataUrl, `${p.id}-inhouse-${i}-${p.topic || ""}`) : dataUrl;
        const a = await addAssetFromDataUrl(acc.id, {
          name: `站内笔记图${String(i + 1).padStart(2, "0")}_${(fresh.title || p.title || "").slice(0, 10)}`,
          tags: ["笔记图", "站内生成", "发布前精修"],
          dataUrl: polished
        });
        const committed = imageRunActive(runToken, runMode) && commitGeneratedImageToSlot(A.items, i, fresh, {
          assetId: a.id,
          referenceReceipt: fresh.referenceReceipt
        });
        if (!committed) {
          await removeAsset(a.id);
          return;
        }
        if (!silent) toast(`第 ${i + 1} 张已生成并精修入库`);
      }
    } catch (e) {
      if (!imageRunActive(runToken, runMode)) return;
      fresh.status = "failed";
      fresh.error = e.message || String(e);
      if (e?.referenceReceipt) fresh.referenceReceipt = e.referenceReceipt;
      toast("图片生成失败：" + fresh.error, "error");
    }
    save("productions");
    if (redraw && canRedrawCurrent()) draw();
  }

  async function handleReturn(files) {
    const imgs = Array.from(files).filter(f => f.type.startsWith("image/"));
    if (!imgs.length) return;
    for (const f of imgs) {
      const slot = (A.items || []).findIndex(x => !x.assetId);
      if (slot < 0) {
        let dataUrl = await fileToDataUrl(f);
        if (isImg) dataUrl = await polishImageForPublish(dataUrl, `${p.id}-extra-${f.name}-${p.topic || ""}`);
        await addAssetFromDataUrl(acc.id, { name: `上传补图_${f.name.replace(/\.[^.]+$/, "").slice(0, 10)}`, tags: isImg ? ["笔记图", "上传补图", "发布前精修"] : ["分镜图", "上传补图"], dataUrl });
      } else {
        await fillSlot(slot, f);
      }
    }
    if (canRedrawCurrent()) draw();
  }

  async function generateImageCopy(opts = {}) {
    const {
      force = false,
      topicOverride = "",
      shotsOverride = null,
      productOverride = null,
      styleOverride = "",
      trendPrep = null,
      trendGuide = ""
    } = opts;
    const C = p.artifacts.copy;
    const shots = shotsOverride || S.shots || p.artifacts.script.shots || [];
    const product = productOverride || productById(S.productId || "dumate");
    const style = styleOverride || S.style || acc.styleProfile || "";
    const topicForCopy = topicOverride || p.topic || S.direction || "";
    S.useOnlineTrends = false;
    S.trendPrep = null;
    S.trendGuide = "";
    if (C.referenceRewrite) delete C.referenceRewrite;
    if (!force && (C.title || "").trim() && (C.body || "").trim()) {
      return C;
    }
    if (!shots.length) return C;
    const res = await AI.generateCopy({
      topic: topicForCopy,
      shots,
      account: acc,
      style,
      kind: "image",
      product,
      useOnlineTrends: false,
      trendGuide: "",
      trendPrep: null
    });
    C.title = res.title || C.title || p.title || p.topic || "";
    C.body = res.copy || C.body || "";
    C.source = res.source || AI.lastSource || "";
    if (/^llm(?:$|-)/.test(C.source)) A.copyGeneratedForTitle = C.title;
    else delete A.copyGeneratedForTitle;
    const titleInput = $("#imgCopyTitle", root);
    const bodyInput = $("#imgCopyBody", root);
    if (titleInput) titleInput.value = C.title;
    if (bodyInput) bodyInput.value = C.body;
    save("productions");
    return C;
  }

  async function generateImageWorkshop() {
    await generateCustomCopyImageWorkshop();
  }

  function singleImagePrompt() {
    const content = String(A.singlePrompt || "").trim();
    if (!content) return "";
    return singleImageGenerationPrompt(content, acc.styleProfile || S.style || acc.imagePromptTemplate || "");
  }

  async function generateSingleImageWorkflow() {
    syncCopyDraft();
    const title = String(A.singleTitle || "").trim();
    const prompt = singleImagePrompt();
    if (!title) {
      toast("请先填写单图标题", "error");
      return;
    }
    if (!prompt) {
      toast("请先填写单图提示词", "error");
      return;
    }
    A.creationMode = "single";
    A.singleCopyError = "";
    const userCopy = normalizeGeneratedLineBreaks(p.artifacts.copy?.body || "");
    const generatedCopyPromise = userCopy ? null : AI.generateImageCopyFromTitle({ title, account: acc });
    const existing = A.items?.[0] || {};
    if (!existing.assetId || existing.sourcePrompt !== A.singlePrompt) {
      A.items = [{
        title: "单图创作",
        visual: A.singlePrompt,
        prompt,
        sourcePrompt: A.singlePrompt,
        assetId: null,
        status: "idle"
      }];
      A.singleItem = A.items[0];
      const token = startImageRun("single", 0);
      await generateOneImage(0, { redraw: false, silent: true, single: true, runToken: token, runMode: "single" });
    }
    const item = A.items?.[0];
    if (!item?.assetId) {
      if (generatedCopyPromise) await generatedCopyPromise.catch(() => null);
      save("productions");
      if (canRedrawCurrent()) draw();
      return;
    }
    try {
      const generated = generatedCopyPromise ? await generatedCopyPromise : { title, copy: userCopy };
      p.artifacts.copy = {
        title,
        body: normalizeGeneratedLineBreaks(generated.copy),
        source: userCopy ? "manual" : (generated.source || AI.lastSource || "llm-title-copy")
      };
      p.title = title;
      p.topic = title;
      S.title = title;
      S.source = "single-image-title-copy";
      setStage(p, "review", "pending");
      A.singleCopyError = "";
      A.singleItem = item;
      A.singleResult = { ...p.artifacts.copy };
      toast(userCopy ? "已保留用户填写文案并生成单图" : "单图和标题对应的发布文案已生成");
    } catch (error) {
      A.singleCopyError = `单图已生成，但标题文案生成失败：${error?.message || error}`;
      toast(A.singleCopyError, "error");
    }
    save("productions");
    if (!A.singleCopyError) go("studio", "review");
    else if (canRedrawCurrent()) draw();
  }

  async function generateCustomCopyImageWorkshop() {
    syncCopyDraft();
    const C = p.artifacts.copy || (p.artifacts.copy = { title: "", body: "" });
    let title = (C.title || "").trim();
    let body = (C.body || "").trim();
    if (!title) {
      toast("文案组图必须先填写标题", "error");
      return;
    }
    const count = Math.max(1, Math.min(12, parseInt($("#imgCount", root)?.value, 10) || S.imageCount || DEFAULT_XHS_IMAGE_COUNT));
    S.imageCount = count;
    S.productId = S.productId || "dumate";
    S.productId = primaryProductById(S.productId)?.id || "dumate";
    S.useOnlineTrends = false;
    S.trendPrep = null;
    S.trendGuide = "";
    if (C.referenceRewrite) delete C.referenceRewrite;
    const topic = title.slice(0, 80);
    const previousGeneratedTitle = String(A.copyGeneratedForTitle || S.title || p.title || "").trim();
    const titleChanged = Boolean(previousGeneratedTitle && previousGeneratedTitle !== title);
    const bodySource = String(C.source || "").trim();
    // 旧任务没有来源字段，不能在标题未变化时贸然覆盖，避免误删历史人工正文。
    // 用户修改标题时仍一律重写；新版本的模板正文会明确标为 mock/template。
    const bodyWasManuallyWritten = bodySource === "manual" || (Boolean(body) && !bodySource);
    const bodyWasModelGenerated = /^llm(?:$|-)/.test(bodySource) || A.copyGeneratedForTitle === title;
    const bodyWasTemplateGenerated = /^(?:mock|template)(?:$|-)/.test(bodySource);
    const shouldGenerateBody = !body || titleChanged || bodyWasTemplateGenerated || (!bodyWasManuallyWritten && !bodyWasModelGenerated);
    if (shouldGenerateBody) {
      // 无正文时先让视觉模型把“标题与统一参考图”的可用内容关系整理出来；
      // 单图定制参考不会参与正文，仍只在它所属图卡的提示词阶段生效。
      const copyReferenceBrief = await prepareSharedReferencesForCopy(title);
      const generatedCopy = await AI.generateImageCopyFromTitle({
        title,
        account: acc,
        referenceContext: copyReferenceBrief.brief
      });
      C.title = title;
      C.body = generatedCopy.copy || "";
      C.source = generatedCopy.source || AI.lastSource || "llm-title-copy";
      A.copyGeneratedForTitle = title;
      title = (C.title || "").trim();
      body = (C.body || "").trim();
      if (!body) throw new Error("发布文案生成失败，请重试");
      const titleInput = $("#imgCopyTitle", root);
      const bodyInput = $("#imgCopyBody", root);
      if (titleInput) titleInput.value = C.title;
      if (bodyInput) bodyInput.value = C.body;
      save("productions");
      toast(titleChanged ? "标题已变化，正文已由语言模型同步重写" : "正文已由语言模型生成，正在拆解图卡提示词");
    }
    p.topic = topic;
    p.title = title || topic;
    const style = acc.styleProfile || S.style || "";
    const shots = buildCustomCopyShots(C, count, null);
    S.direction = "";
    S.shots = shots;
    S.title = p.title;
    S.source = "custom-copy";
    S.style = style;
    const previousItems = A.items || [];
    const referencePlan = await prepareReferencesForPromptCards(shots, previousItems);
    const promptRes = await AI.generateImagePrompts({
      script: shotsToText(shots, true),
      account: acc,
      style,
      imageTemplate: acc.imagePromptTemplate || "",
      styleRefName: "",
      imageCount: count,
      product: null,
      topic,
      useOnlineTrends: false,
      trendGuide: "",
      trendPrep: null,
      copy: C,
      referencePlans: referencePlan.cards,
      requireLlm: true
    });
    A.promptSource = AI.lastSource;
    const promptRows = promptRes.shots || [];
    A.items = shots.map((s, i) => ({
      title: promptRows[i]?.title || s.idea || `图片${i + 1}`,
      visual: s.visual || "",
      prompt: promptRows[i]?.prompt || "",
      refAssetIds: normalizeRefIds((previousItems[i] || {}).refAssetIds),
      referenceSource: (previousItems[i] || {}).referenceSource || "",
      promptUserEdited: false,
      assetId: (previousItems[i] || {}).assetId || null,
      status: (previousItems[i] || {}).assetId ? "done" : "idle"
    }));
    applyPromptReferencePlan(A.items, referencePlan.cards, referencePlan.source);
    p.stage = "images";
    p.stageStatus = "pending";
    save("productions");
    if (canRedrawCurrent()) draw();
    toast(AI.sourceNote(shouldGenerateBody ? "已由模型生成正文与图卡提示词" : "已按当前正文生成图卡提示词"));
  }

  draw();
}
