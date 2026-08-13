import { esc } from "../core/util.js";
import { state, save, persistNow, accountById, assetById, productById, canDeliver } from "../core/store.js";
import * as remote from "../core/remote.js";
import { AI } from "../api/ai.js?v=20260813-v1429-canvas-durable-batch-1";
import { addAssetFromDataUrl, addAssetFromFile, removeAsset, urlFor } from "../domain/assets.js";
import { commitCustomDelivery, deliverCustomOutput, discardCustomDelivery, productTagLabel } from "../domain/delivery.js?v=20260813-v1429-canvas-durable-batch-1";
import { polishImageForPublish } from "../domain/imagePolish.js";
import { ensureVideoCover } from "./chainWorkshop.js?v=20260813-v1429-canvas-durable-batch-1";
import { icon } from "../ui/icons.js";
import { openLightbox, openModal, toast, withLoading } from "../ui/components.js?v=20260813-v1429-canvas-durable-batch-1";
import { isAccountDisabled } from "../domain/accounts.js";
import {
  accountPublishAvailable,
  accountPublishQuota,
  invalidateAccountPublishQuotas,
  refreshAccountPublishQuotas,
} from "../domain/productionQuota.js?v=20260813-v1429-canvas-durable-batch-1";
import { assertPublishText, validatePublishText } from "../domain/publishRules.js?v=20260813-v1429-canvas-durable-batch-1";

let activeCustomPublishModal = null;
const CUSTOM_PUBLISH_DRAFT_PREFIX = "xingzhen:custom-publish-draft:v1";
const COVER_STYLE_OPTIONS = [
  ["editorial", "高级杂志", "高级杂志封面，克制留白，清晰层级，精致排版与真实质感"],
  ["social", "社媒爆款", "社交媒体爆款封面，主体醒目，大标题高识别，强视觉停留点"],
  ["cinematic", "电影海报", "电影海报质感，戏剧性光影，空间纵深，画面叙事明确"],
  ["minimal", "极简留白", "极简主义封面，大面积留白，单一视觉焦点，精确网格排版"],
  ["tech", "未来科技", "未来科技视觉，精密光线与材质，现代信息图形，避免廉价霓虹"],
  ["documentary", "纪实人文", "纪实摄影风格，自然光线，真实人物与环境，可信且有温度"],
  ["lifestyle", "生活方式", "生活方式品牌视觉，柔和自然光，松弛构图，清爽且具亲和力"],
  ["commerce", "产品商业", "高端商业产品摄影，主体轮廓清晰，材质细节准确，卖点聚焦"],
  ["illustration", "设计插画", "现代编辑插画风格，统一造型语言，图形简洁，视觉节奏鲜明"],
  ["bold-type", "强字效海报", "强字效平面海报，中文标题为核心视觉，字图关系明确且易读"],
];
const COVER_PALETTE_OPTIONS = [
  ["auto", "智能配色", ""],
  ["ink", "墨黑银白", "墨黑、炭灰与银白，少量冷光点缀"],
  ["blue", "深海蓝", "深海蓝、雾蓝与象牙白，少量钴蓝强调"],
  ["red", "朱红米白", "朱红、米白与深灰，传统感和现代排版结合"],
  ["green", "森林绿", "森林绿、鼠尾草绿与暖白，质感自然克制"],
  ["orange", "日落橙", "日落橙、杏色与深棕，温暖但保持高级"],
  ["purple", "暮光紫", "暮光紫、灰紫与冷白，柔和渐变而不过度霓虹"],
  ["yellow", "柠檬黄", "柠檬黄、暖白与石墨黑，明快醒目且高对比"],
  ["pastel", "低饱和粉彩", "低饱和粉蓝、粉灰与奶油白，轻盈柔和"],
  ["random", "随机灵感", ""],
];

function publishDraftKey(output = {}, kind = outputKind(output)) {
  const memberId = String(state.ui.currentMemberId || state.meta?.memberId || "local");
  const projectId = String(output.projectId || output.id || output.customProjectId || "untitled");
  return `${CUSTOM_PUBLISH_DRAFT_PREFIX}:${memberId}:${kind}:${projectId}`;
}

function readPublishDraft(output = {}, kind = outputKind(output)) {
  const attached = output.publishDraft && typeof output.publishDraft === "object"
    ? output.publishDraft
    : null;
  try {
    const stored = JSON.parse(localStorage.getItem(publishDraftKey(output, kind)) || "null");
    return stored && typeof stored === "object" ? { ...(attached || {}), ...stored } : (attached || {});
  } catch (_) {
    return attached || {};
  }
}

function writePublishDraft(output, kind, draft) {
  const value = { ...(draft || {}), updatedAt: Date.now() };
  output.publishDraft = value;
  try {
    localStorage.setItem(publishDraftKey(output, kind), JSON.stringify(value));
  } catch (error) {
    console.warn("[custom-publish-draft-save]", error);
  }
  return value;
}

function clearPublishDraft(output, kind) {
  delete output.publishDraft;
  try {
    localStorage.removeItem(publishDraftKey(output, kind));
  } catch (_) {}
}

function todayValue() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function outputKind(output = {}) {
  return output.kind === "canvas" || output.type === "图集" ? "canvas" : "video";
}

export function compactCanvasPublishCopy(value = "") {
  return String(value || "")
    .replace(/\\[nr]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function outputItems(output = {}) {
  const rows = Array.isArray(output.items) ? output.items : [];
  if (rows.length) return rows;
  if (output.dataUrl || output.url || output.assetUrl || output.blob) {
    return [{
      id: output.id || "",
      name: output.name || output.title || "画布成品",
      dataUrl: output.dataUrl || "",
      url: output.url || output.assetUrl || "",
      blob: output.blob || null,
      mime: output.mime || ""
    }];
  }
  return [];
}

function eligibleAccounts(kind) {
  const expectedMode = kind === "canvas" ? "图文" : "视频";
  return state.accounts.filter(account => !isAccountDisabled(account) && account.mode === expectedMode);
}

function accountOptions(accounts, selectedId = "") {
  return accounts.map(account => {
    const quota = accountPublishQuota(account.id);
    const blocked = quota.remaining <= 0;
    return `
      <option value="${esc(account.id)}" ${account.id === selectedId ? "selected" : ""} ${blocked ? "disabled" : ""}>
        【今日 ${quota.used}/${quota.limit}】${esc(account.name)} · ${esc(account.platform || "")} · ${esc(account.mode || "")}
      </option>
    `;
  }).join("");
}

function productOptions(products, selectedId = "") {
  return products.map(product => {
    const label = product.shortName || product.name || "未命名产品";
    const detail = product.category ? ` · ${product.category}` : "";
    return `
      <option value="${esc(product.id)}" ${product.id === selectedId ? "selected" : ""}>
        ${esc(label)}${esc(detail)}
      </option>
    `;
  }).join("");
}

function spokenShots(output = {}) {
  const scenes = output.plan?.scenes || output.project?.plan?.scenes || [];
  return (Array.isArray(scenes) ? scenes : []).map((scene, index) => ({
    time: scene.time || scene.timeRange || "",
    idea: scene.title || scene.description || `场景 ${index + 1}`,
    line: scene.narration || scene.voiceover || scene.spokenText || scene.dialogue || "",
    visual: scene.visual || scene.prompt || scene.description || ""
  }));
}

async function responseBlob(url) {
  const target = String(url || "").trim();
  if (!target) throw new Error("成品地址为空");
  const headers = {};
  if (remote.hasToken() && (/^\//.test(target) || target.startsWith(location.origin))) {
    headers.Authorization = `Bearer ${remote.getToken()}`;
  }
  const response = await fetch(target, { cache: "no-store", headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail.slice(0, 180) || `读取成品失败 (${response.status})`);
  }
  return response.blob();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取画布图片失败"));
    reader.readAsDataURL(blob);
  });
}

function safeFilename(name = "", fallback = "custom-output", mime = "") {
  const clean = String(name || fallback)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || fallback;
  if (/\.[a-z0-9]{2,5}$/i.test(clean)) return clean;
  const ext = /png/i.test(mime) ? "png"
    : /webp/i.test(mime) ? "webp"
      : /jpe?g/i.test(mime) ? "jpg"
        : /video|mp4/i.test(mime) ? "mp4"
          : "bin";
  return `${clean}.${ext}`;
}

async function materializeVideo(output, accountId, title) {
  const existing = output.sourceAssetId ? assetById(output.sourceAssetId) : null;
  if (existing && existing.type !== "视频") throw new Error("所选成品不是有效视频");
  const sourceUrl = (existing ? urlFor(existing) : "")
    || output.videoUrl
    || output.downloadUrl
    || output.url
    || output.project?.outputs?.[0]?.url
    || "";
  if (!sourceUrl) throw new Error("视频工坊还没有可提交的最终成片");
  const blob = output.blob instanceof Blob ? output.blob : await responseBlob(sourceUrl);
  const mime = blob.type || output.mime || "video/mp4";
  const file = new File(
    [blob],
    safeFilename(output.name || `${title}_成片`, `${title}_成片`, mime),
    { type: mime }
  );
  const asset = await addAssetFromFile(accountId, file, {
    name: `${title}_成片`,
    tags: ["定制创作", "视频工坊", "成片", "账号资产"],
    forceNew: true
  });
  return {
    sourceAssetId: asset.id,
    videoUrl: urlFor(asset) || asset.fileUrl || sourceUrl,
    createdAssetIds: [asset.id]
  };
}

async function materializeCanvas(output, accountId, title) {
  const existingIds = [...new Set((output.packAssetIds || output.assetIds || []).filter(Boolean))];
  const existingRows = existingIds.map(id => assetById(id));
  if (existingRows.some(asset => !asset || asset.type !== "图片")) {
    throw new Error("画布输出包含无效或已删除的图片");
  }
  const rows = existingRows.length
    ? existingRows.map(asset => ({
      name: asset.name,
      url: urlFor(asset),
      mime: asset.mime || "image/png"
    })).slice(0, 20)
    : outputItems(output).slice(0, 20);
  if (!rows.length) throw new Error("无限画布还没有可提交的导出图片");
  const ids = [];
  try {
    for (let index = 0; index < rows.length; index++) {
      const item = rows[index] || {};
      let sourceDataUrl = String(item.dataUrl || "");
      if (!sourceDataUrl) {
        const sourceUrl = item.url || item.assetUrl || "";
        const blob = item.blob instanceof Blob ? item.blob : await responseBlob(sourceUrl);
        sourceDataUrl = await blobToDataUrl(blob);
      }
      if (!/^data:image\/(?:png|jpe?g|webp);base64,/i.test(sourceDataUrl)) {
        throw new Error(`第 ${index + 1} 张画布成品不是有效图片`);
      }
      // 无限画布仅在“发布”路径执行与图文工坊相同的轻量发布前精修。
      // 子应用自己的“导出”路径不经过本函数，因此仍下载用户看到的原始成图。
      const polishedDataUrl = await polishImageForPublish(
        sourceDataUrl,
        `${output.projectId || output.id || "canvas"}-publish-${item.sourceItemId || index}-${title}`
      );
      const asset = await addAssetFromDataUrl(accountId, {
        name: item.name || `${title}_${String(index + 1).padStart(2, "0")}`,
        type: "图片",
        tags: ["定制创作", "无限画布", "画布成品", "发布前精修", "账号资产"],
        dataUrl: polishedDataUrl,
        forceNew: true
      });
      if (asset?.id) ids.push(asset.id);
    }
  } catch (error) {
    await Promise.all(ids.map(id => removeAsset(id).catch(() => {})));
    throw error;
  }
  if (!ids.length) throw new Error("无限画布成品没有成功写入账号资产");
  return { packAssetIds: ids, createdAssetIds: ids.slice() };
}

function accountCoverStylePrompt(account = {}, stylePrompt = "", palettePrompt = "") {
  const hints = [
    account.imagePromptTemplate,
    account.lockedStyle,
    account.styleProfile,
    account.tone
  ]
    .filter(value => typeof value === "string")
    .map(value => value.trim())
    .filter(Boolean);
  const style = hints.length ? `账号视觉风格：${[...new Set(hints)].join("；").slice(0, 600)}\n` : "";
  // 仅用于视频工坊发布封面；底层生成仍沿用单号/批量的封面链路与 ratio 参数。
  const selectedStyle = String(stylePrompt || "").trim();
  const selectedPalette = String(palettePrompt || "").trim();
  return [
    style,
    selectedStyle ? `封面风格：${selectedStyle}\n` : "",
    selectedPalette ? `配色方向：${selectedPalette}\n` : "",
    "画幅要求：竖版 3:4，适合作为视频发布封面，主体和标题信息保持在安全可见区域。"
  ].join("");
}

function coverReferenceIds(output = {}, account = {}, extraReferenceAssetIds = []) {
  const idList = value => Array.isArray(value) ? value : (value ? [value] : []);
  const roleRefAssetId = account.subType === "数字人"
    && assetById(account.charBoardAssetId)?.type === "图片"
    ? account.charBoardAssetId
    : "";
  const ids = [
    roleRefAssetId,
    ...idList(extraReferenceAssetIds),
    ...idList(output.coverRefAssetIds),
    ...idList(output.referenceAssetIds)
  ];
  return {
    roleRefAssetId,
    refAssetIds: [...new Set(ids.filter(id => assetById(id)?.type === "图片"))].slice(0, 5)
  };
}

async function generateCover({
  output,
  accountId,
  productId,
  title,
  copy,
  extraReferenceAssetIds = [],
  stylePrompt = "",
  palettePrompt = "",
}) {
  const account = accountById(accountId);
  if (!account) throw new Error("请先选择发布账号");
  const { roleRefAssetId, refAssetIds } = coverReferenceIds(output, account, extraReferenceAssetIds);
  const projectId = String(output.projectId || output.id || Date.now());
  const temp = {
    id: `custom-cover-${projectId}`,
    mode: "视频",
    subType: account.subType || "无数字人",
    customPublish: true,
    accountId,
    title,
    topic: title,
    artifacts: {
      copy: { title, body: copy || "" },
      script: {
        productId: productId || output.productId || "dumate",
        shots: spokenShots(output)
      },
      boards: {
        characterRefAssetId: roleRefAssetId || null,
        cover: {
          prompt: accountCoverStylePrompt(account, stylePrompt, palettePrompt),
          assetId: null,
          refAssetIds,
          status: "idle",
          error: ""
        }
      }
    }
  };
  await ensureVideoCover(temp);
  return {
    assetId: temp.artifacts.boards.cover.assetId || "",
    roleRefAssetId,
    refAssetIds: temp.artifacts.boards.cover.refAssetIds || []
  };
}

function coverPreviewHtml(assetId = "") {
  const asset = assetId ? state.assets.find(item => item.id === assetId) : null;
  const url = asset ? urlFor(asset) : "";
  return url
    ? `<img src="${esc(url)}" alt="发布封面" />`
    : `<div>${icon("image", 20)}<b>生成或拖入封面</b><em>这里展示最终封面；AI 参考图请拖入右侧参考区。</em></div>`;
}

function coverReferencePreviewHtml(assetIds = []) {
  const rows = assetIds
    .map(id => assetById(id))
    .filter(asset => asset?.type === "图片")
    .map(asset => {
      const url = urlFor(asset);
      return url ? `
        <span class="custom-publish-cover-ref" data-cover-ref-id="${esc(asset.id)}">
          <button type="button" class="custom-publish-cover-ref-preview" data-cover-ref-preview="${esc(asset.id)}" aria-label="放大预览参考图 ${esc(asset.name || "")}">
            <img src="${esc(url)}" alt="${esc(asset.name || "封面参考图")}" />
          </button>
          <button type="button" class="custom-publish-cover-ref-remove" data-cover-ref-remove="${esc(asset.id)}" aria-label="移除参考图">${icon("x", 10)}</button>
        </span>
      ` : "";
    })
    .join("");
  return rows || `<em>尚未添加自定义参考图</em>`;
}

async function ensureRemoteCustomProject(output, kind, title) {
  const existingId = String(output.customProjectId || "").trim();
  if (!remote.isOn() || !remote.hasToken()) return existingId;
  if (existingId) {
    try {
      await remote.customProjects.get(existingId);
      return existingId;
    } catch (error) {
      if (![403, 404].includes(Number(error?.status || 0))) throw error;
      output.customProjectId = "";
    }
  }
  const sourceProjectId = String(output.projectId || output.id || "").trim();
  if (sourceProjectId) {
    const listed = await remote.customProjects.list(kind);
    const matched = (listed?.items || []).find(item => {
      const projectState = item?.projectState && typeof item.projectState === "object"
        ? item.projectState
        : {};
      return (
        String(projectState.sourceProjectId || "") === sourceProjectId
        || String(projectState.workshopProjectId || "") === sourceProjectId
      );
    });
    if (matched?.id) {
      output.customProjectId = String(matched.id);
      return output.customProjectId;
    }
  }
  const result = await remote.customProjects.create({
    kind,
    title,
    appVersion: kind === "canvas" ? "infinite-canvas-embedded-v1" : "video-workshop-embedded-v1",
    projectState: {
      integration: kind === "canvas" ? "infinite-canvas" : "video-workshop",
      sourceProjectId
    },
    outputIds: [],
    status: "draft"
  });
  const projectId = String(result?.project?.id || "").trim();
  if (!projectId) throw new Error("服务器没有返回定制项目编号");
  output.customProjectId = projectId;
  return projectId;
}

function publishBundle(asset, account) {
  const ids = [
    asset.id,
    asset.sourceAssetId,
    asset.coverAssetId,
    ...(asset.packAssetIds || [])
  ].filter(Boolean);
  const assets = [...new Set(ids)].map(id => assetById(id)).filter(Boolean);
  return {
    deliveryId: asset.id,
    delivery: asset,
    assets,
    account
  };
}

function publishSignature(values) {
  return JSON.stringify(values);
}

function definitivePublishFailure(error) {
  const status = Number(error?.status || 0);
  return (status >= 400 && status < 500)
    || /^HTTP 4\d\d\b/.test(String(error?.message || error || ""));
}

async function rollbackPending(asset, materialized) {
  discardCustomDelivery(asset);
  await Promise.all((materialized?.createdAssetIds || []).map(id => removeAsset(id).catch(() => {})));
  save("assets", "accounts", "meta");
  await persistNow();
}

export async function openCustomPublish(output = {}, { onPublished } = {}) {
  if (activeCustomPublishModal?.el?.isConnected) {
    activeCustomPublishModal.el.querySelector("input, select, textarea, button")?.focus();
    toast("发布设置已经打开");
    return activeCustomPublishModal;
  }
  const kind = outputKind(output);
  const draft = readPublishDraft(output, kind);
  const accounts = eligibleAccounts(kind);
  if (!accounts.length) {
    toast(`请先创建至少一个${kind === "video" ? "视频号" : "图文"}账号`, "error");
    return null;
  }
  const products = state.products.filter(product => product?.id);
  if (!products.length) {
    toast("请先在设置中配置至少一个产品", "error");
    return null;
  }
  const requestedAccountId = String(draft.accountId || output.accountId || "");
  const selectedAccountId = accounts.some(account => account.id === requestedAccountId)
    ? requestedAccountId
    : accounts[0].id;
  const requestedProductId = String(draft.productId || output.productId || "");
  const selectedProductId = products.some(product => product.id === requestedProductId)
    ? requestedProductId
    : (products.some(product => product.id === "dumate") ? "dumate" : products[0].id);
  const initialProductTag = String(
    productTagLabel(productById(selectedProductId)) || "定制创作"
  ).trim();
  const initialTitle = String(
    draft.title
    || (kind === "video" ? "" : (output.title || output.project?.name || "无限画布作品"))
  ).trim();
  const initialCopy = kind === "canvas"
    ? compactCanvasPublishCopy(draft.copy || output.copy || "")
    : String(draft.copy || output.copy || "");
  const validDraftCoverId = assetById(draft.coverAssetId)?.type === "图片"
    ? String(draft.coverAssetId)
    : "";
  let coverAssetId = validDraftCoverId;
  let coverAccountId = validDraftCoverId ? String(draft.coverAccountId || selectedAccountId) : "";
  let coverProductId = validDraftCoverId ? String(draft.coverProductId || selectedProductId) : "";
  let coverTitle = validDraftCoverId ? String(draft.coverTitle || initialTitle) : "";
  let coverCopy = validDraftCoverId ? String(draft.coverCopy || initialCopy) : "";
  let coverSource = validDraftCoverId ? String(draft.coverSource || "uploaded") : "";
  let coverBusy = false;
  let coverReferenceAssetIds = [...new Set(
    (Array.isArray(draft.coverReferenceAssetIds) ? draft.coverReferenceAssetIds : [])
      .filter(id => assetById(id)?.type === "图片")
  )].slice(0, 5);
  const createdCoverIds = new Set(
    (Array.isArray(draft.createdCoverIds) ? draft.createdCoverIds : [])
      .filter(id => assetById(id)?.type === "图片")
  );
  const createdCoverReferenceIds = new Set(
    (Array.isArray(draft.createdCoverReferenceIds) ? draft.createdCoverReferenceIds : [])
      .filter(id => assetById(id)?.type === "图片")
  );
  const initialCoverStyle = COVER_STYLE_OPTIONS.some(([value]) => value === draft.coverStyle)
    ? draft.coverStyle
    : "editorial";
  const initialCoverPalette = COVER_PALETTE_OPTIONS.some(([value]) => value === draft.coverPalette)
    ? draft.coverPalette
    : "auto";
  let pendingSubmission = null;
  let published = false;
  let releaseSyncHold = null;
  let persistDraft = () => {};
  let modal = null;
  modal = openModal(`
    <div class="mp-head custom-publish-head">
      <div><b>提交发布</b><em>${kind === "video" ? "视频工坊成片" : "无限画布组图"}将写入所选账号资产，并进入发布清单与供应商端。</em></div>
      <button class="icon-btn" type="button" data-close aria-label="关闭">${icon("x", 15)}</button>
    </div>
    <div class="mp-body custom-publish-body">
      <div class="custom-publish-grid">
        <label class="field"><span>发布账号（必填）</span>
          <select class="input" id="customPublishAccount">${accountOptions(accounts, selectedAccountId)}</select>
        </label>
        <label class="field"><span>产品（必填）</span>
          <select class="input" id="customPublishProduct">${productOptions(products, selectedProductId)}</select>
        </label>
      </div>
      <div class="custom-publish-grid">
        <label class="field"><span>计划发布日期（必填）</span>
          <input class="input" type="date" id="customPublishDate" value="${esc(draft.planDate || todayValue())}" required />
        </label>
        <label class="field"><span>发布清单产品标签（随产品自动填写）</span>
          <input class="input" id="customPublishProductTag" maxlength="20" value="${esc(initialProductTag)}" readonly />
        </label>
      </div>
      <label class="field"><span>发布标题（必填）</span>
        <input class="input" id="customPublishTitle" maxlength="80" value="${esc(initialTitle)}" placeholder="填写最终发布标题" required />
      </label>
      <label class="field custom-publish-copy-field">
        <span>发布文案 <button class="link-btn" type="button" id="customPublishGenerateCopy">${icon("spark", 12)} 根据标题生成</button></span>
        <textarea class="input" id="customPublishCopy" rows="${kind === "canvas" ? 4 : 6}" placeholder="可自己填写，也可以根据标题生成">${esc(initialCopy)}</textarea>
        <small id="customPublishTextRule" aria-live="polite"></small>
      </label>
      ${kind === "video" ? `
        <section class="custom-publish-cover">
          <div class="custom-publish-cover-frame" id="customPublishCoverPreview" role="button" tabindex="0" aria-label="点击放大预览最终封面；也可将现成封面拖入此处">${coverPreviewHtml(coverAssetId)}</div>
          <input id="customPublishCoverFile" type="file" accept="image/png,image/jpeg,image/webp" hidden />
          <div>
            <b>发布封面</b>
            <p id="customPublishCoverHint">沿用单号与批量创作的封面链路，根据标题、账号风格和视觉资料生成。</p>
            <div class="custom-publish-cover-reference-zone" id="customPublishCoverReferenceZone" role="button" tabindex="0" aria-label="点击选择或拖入 AI 封面参考图">
              <span>${icon("upload", 13)} 点击或拖入 AI 封面参考图</span>
              <small>最多 5 张；数字人角色版仍会优先作为默认参考</small>
            </div>
            <input id="customPublishCoverReferenceFile" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden />
            <div class="custom-publish-cover-reference-list" id="customPublishCoverReferenceList">${coverReferencePreviewHtml(coverReferenceAssetIds)}</div>
            <div class="custom-publish-cover-controls">
              <label><span>封面风格</span>
                <select class="input" id="customPublishCoverStyle">
                  ${COVER_STYLE_OPTIONS.map(([value, label]) => `<option value="${esc(value)}" ${value === initialCoverStyle ? "selected" : ""}>${esc(label)}</option>`).join("")}
                </select>
              </label>
              <label><span>配色方向</span>
                <span class="custom-publish-cover-palette-control">
                  <select class="input" id="customPublishCoverPalette">
                    ${COVER_PALETTE_OPTIONS.map(([value, label]) => `<option value="${esc(value)}" ${value === initialCoverPalette ? "selected" : ""}>${esc(label)}</option>`).join("")}
                  </select>
                  <button class="btn ghost" type="button" id="customPublishRandomPalette" title="随机换一组配色">${icon("spark", 13)} 随机</button>
                </span>
              </label>
            </div>
            <div class="custom-publish-cover-actions">
              <button class="btn ghost" type="button" id="customPublishGenerateCover">${icon("image", 13)} ${coverAssetId ? "重新生成封面" : "生成封面"}</button>
              <button class="btn ghost" type="button" id="customPublishUploadCover">${icon("upload", 13)} 上传现成封面</button>
            </div>
          </div>
        </section>
      ` : ""}
      <label class="field"><span>备注</span>
        <input class="input" id="customPublishNote" maxlength="200" value="${esc(draft.note || output.note || "")}" placeholder="例如：周五晚发布" />
      </label>
      <div class="custom-publish-status" id="customPublishStatus">${kind === "canvas"
        ? "提交发布时会先执行与图文工坊相同的发布前精修，再复制到主平台资产库；直接导出保持原图。"
        : "成品会在提交时复制到主平台资产库，子应用原项目不会被删除。"}</div>
    </div>
    <div class="mp-foot">
      <button class="btn ghost" type="button" data-close>取消</button>
      <button class="btn primary" type="button" id="customPublishSubmit">${icon("package", 14)} 提交并打包</button>
    </div>
  `, {
    wide: true,
    onBeforeClose() {
      // 预览层位于发布弹窗之上；按 Escape 时先只关闭预览，避免连带丢失未提交字段和临时参考图。
      if (document.querySelector(".lightbox")) return false;
      if (coverBusy) {
        toast("封面正在处理中，请完成后再关闭发布设置。", "error");
        return false;
      }
      if (pendingSubmission && !published) {
        toast("交付已在本地准备完成，请先点击“重试同步”，避免产生重复发布记录。", "error");
        return false;
      }
      return true;
    },
    onClose() {
      if (activeCustomPublishModal?.el === modal?.el) activeCustomPublishModal = null;
      releaseSyncHold?.({ flush: false });
      releaseSyncHold = null;
      if (!published) {
        persistDraft();
        return;
      }
      clearPublishDraft(output, kind);
      if (coverAssetId) createdCoverIds.delete(coverAssetId);
      [...createdCoverIds, ...createdCoverReferenceIds].forEach(id => {
        removeAsset(id).catch(error => console.warn("[custom-cover-published-cleanup]", error));
      });
      createdCoverIds.clear();
      createdCoverReferenceIds.clear();
    },
    onMount(panel, close) {
      const accountInput = panel.querySelector("#customPublishAccount");
      const productInput = panel.querySelector("#customPublishProduct");
      const productTagInput = panel.querySelector("#customPublishProductTag");
      const titleInput = panel.querySelector("#customPublishTitle");
      const copyInput = panel.querySelector("#customPublishCopy");
      const dateInput = panel.querySelector("#customPublishDate");
      const noteInput = panel.querySelector("#customPublishNote");
      const status = panel.querySelector("#customPublishStatus");
      const coverPreview = panel.querySelector("#customPublishCoverPreview");
      const coverFileInput = panel.querySelector("#customPublishCoverFile");
      const coverReferenceZone = panel.querySelector("#customPublishCoverReferenceZone");
      const coverReferenceFileInput = panel.querySelector("#customPublishCoverReferenceFile");
      const coverReferenceList = panel.querySelector("#customPublishCoverReferenceList");
      const coverHint = panel.querySelector("#customPublishCoverHint");
      const coverStyleInput = panel.querySelector("#customPublishCoverStyle");
      const coverPaletteInput = panel.querySelector("#customPublishCoverPalette");
      const submitButton = panel.querySelector("#customPublishSubmit");
      const textRule = panel.querySelector("#customPublishTextRule");
      const updateTextRule = () => {
        const account = accountById(accountInput?.value || "");
        const result = validatePublishText({
          platform: account?.platform || "",
          title: titleInput?.value || "",
          copy: copyInput?.value || "",
        });
        if (titleInput) titleInput.maxLength = account?.platform === "小红书" ? 20 : account?.platform === "视频号" ? 16 : 80;
        if (copyInput) {
          if (account?.platform === "小红书") copyInput.maxLength = 1000;
          else copyInput.removeAttribute("maxlength");
        }
        if (textRule) {
          textRule.classList.toggle("is-error", !result.ok);
          textRule.textContent = result.ok
            ? (account?.platform === "小红书"
              ? `小红书：标题 ${result.titleLength}/20 · 文案 ${result.copyLength}/1000`
              : account?.platform === "视频号"
                ? `视频号：标题 ${result.titleLength}/16 · 不可含标点`
                : `标题 ${result.titleLength} 字`)
            : result.message;
        }
        if (submitButton && !pendingSubmission) submitButton.disabled = !result.ok;
        return result;
      };
      let draftTimer = 0;
      const saveDraftNow = () => writePublishDraft(output, kind, {
        accountId: accountInput?.value || selectedAccountId,
        productId: productInput?.value || selectedProductId,
        planDate: dateInput?.value || todayValue(),
        title: titleInput?.value || "",
        copy: copyInput?.value || "",
        note: noteInput?.value || "",
        coverAssetId,
        coverAccountId,
        coverProductId,
        coverTitle,
        coverCopy,
        coverSource,
        coverReferenceAssetIds: coverReferenceAssetIds.slice(),
        createdCoverIds: [...createdCoverIds],
        createdCoverReferenceIds: [...createdCoverReferenceIds],
        coverStyle: coverStyleInput?.value || "editorial",
        coverPalette: coverPaletteInput?.value || "auto",
      });
      const queueDraftSave = () => {
        window.clearTimeout(draftTimer);
        draftTimer = window.setTimeout(saveDraftNow, 120);
      };
      persistDraft = () => {
        window.clearTimeout(draftTimer);
        if (!published) saveDraftNow();
      };
      const setPendingMode = active => {
        panel.querySelectorAll("input, select, textarea, #customPublishGenerateCopy, #customPublishGenerateCover, #customPublishUploadCover")
          .forEach(control => { control.disabled = active; });
        panel.querySelectorAll("[data-close]").forEach(control => { control.disabled = active; });
        coverPreview?.classList.toggle("is-disabled", active);
        coverPreview?.setAttribute("aria-disabled", active ? "true" : "false");
        if (coverPreview) coverPreview.tabIndex = active ? -1 : 0;
        coverReferenceZone?.classList.toggle("is-disabled", active);
        coverReferenceZone?.setAttribute("aria-disabled", active ? "true" : "false");
        if (coverReferenceZone) coverReferenceZone.tabIndex = active ? -1 : 0;
        coverReferenceList?.classList.toggle("is-disabled", active);
        coverReferenceList?.setAttribute("aria-disabled", active ? "true" : "false");
        if (!submitButton) return;
        submitButton.disabled = false;
        submitButton.innerHTML = active
          ? `${icon("refresh", 14)} 重试同步`
          : `${icon("package", 14)} 提交并打包`;
      };
      const removeCreatedCover = (assetId, reason) => {
        if (!assetId || !createdCoverIds.has(assetId)) return;
        removeAsset(assetId)
          .then(() => createdCoverIds.delete(assetId))
          .catch(error => console.warn(reason, error));
      };
      const removeCreatedCoverReference = (assetId, reason) => {
        if (!assetId || !createdCoverReferenceIds.has(assetId)) return;
        removeAsset(assetId)
          .then(() => createdCoverReferenceIds.delete(assetId))
          .catch(error => console.warn(reason, error));
      };
      const invalidateCover = message => {
        if (kind !== "video" || !coverAssetId) return;
        const retiredId = coverAssetId;
        coverAssetId = "";
        coverAccountId = "";
        coverProductId = "";
        coverTitle = "";
        coverCopy = "";
        coverSource = "";
        if (coverPreview) coverPreview.innerHTML = coverPreviewHtml("");
        status.textContent = message;
        removeCreatedCover(retiredId, "[custom-cover-cleanup]");
        queueDraftSave();
      };
      const markGeneratedCoverStale = message => {
        if (kind !== "video" || coverSource !== "generated" || !coverAssetId) return;
        status.textContent = `${message} 当前封面已保留；需要时可点击重新生成。`;
        queueDraftSave();
      };
      const updateCoverHint = () => {
        if (!coverHint) return;
        const account = accountById(accountInput.value);
        const hasRoleRef = (
          account?.subType === "数字人"
          && assetById(account.charBoardAssetId)?.type === "图片"
        );
        coverHint.textContent = hasRoleRef
          ? "该数字人账号的角色形象会默认作为 AI 封面参考图；下方仍可补充自定义参考图。"
          : "沿用单号与批量创作的封面链路，根据标题、账号风格和下方参考图生成。";
      };
      const renderCoverReferences = () => {
        if (!coverReferenceList) return;
        coverReferenceList.innerHTML = coverReferencePreviewHtml(coverReferenceAssetIds);
      };
      const clearCoverReferences = message => {
        const retiredIds = coverReferenceAssetIds.slice();
        coverReferenceAssetIds = [];
        renderCoverReferences();
        retiredIds.forEach(id => removeCreatedCoverReference(id, "[custom-cover-reference-cleanup]"));
        if (message && retiredIds.length) status.textContent = message;
        queueDraftSave();
      };
      const invalidateGeneratedCoverForReferences = () => {
        if (coverSource === "generated" && coverAssetId) {
          invalidateCover("AI 封面参考图已变化，请按当前参考图重新生成封面。");
        }
      };
      const installCover = ({ assetId, source, title = "", copy = "", message = "" }) => {
        const retiredId = coverAssetId;
        coverAssetId = assetId;
        coverAccountId = accountInput.value;
        coverProductId = productInput.value;
        coverTitle = title;
        coverCopy = copy;
        coverSource = source;
        if (source === "generated" || source === "uploaded") createdCoverIds.add(assetId);
        coverPreview.innerHTML = coverPreviewHtml(assetId);
        status.textContent = message;
        if (retiredId && retiredId !== assetId) {
          removeCreatedCover(retiredId, "[custom-cover-replace]");
        }
        saveDraftNow();
      };
      const withCoverBusy = async task => {
        if (pendingSubmission) throw new Error("交付正在等待同步，不能再更换封面");
        if (coverBusy) throw new Error("封面正在处理中，请稍候");
        coverBusy = true;
        const lockedControls = [
          accountInput,
          productInput,
          titleInput,
          copyInput,
          coverFileInput,
          coverReferenceFileInput,
          panel.querySelector("#customPublishGenerateCopy"),
          panel.querySelector("#customPublishGenerateCover"),
          panel.querySelector("#customPublishUploadCover"),
          submitButton
        ].filter(Boolean);
        const previousDisabled = new Map(
          lockedControls.map(control => [control, control.disabled])
        );
        lockedControls.forEach(control => { control.disabled = true; });
        coverPreview?.classList.add("is-busy");
        coverPreview?.setAttribute("aria-busy", "true");
        coverReferenceZone?.classList.add("is-busy");
        coverReferenceZone?.setAttribute("aria-busy", "true");
        try {
          return await task();
        } finally {
          coverBusy = false;
          previousDisabled.forEach((disabled, control) => {
            control.disabled = disabled;
          });
          coverPreview?.classList.remove("is-busy", "is-dragover");
          coverPreview?.removeAttribute("aria-busy");
          coverReferenceZone?.classList.remove("is-busy", "is-dragover");
          coverReferenceZone?.removeAttribute("aria-busy");
        }
      };
      const useDroppedCover = async file => {
        if (
          !(file instanceof File)
          || !["image/png", "image/jpeg", "image/webp"].includes(file.type)
        ) {
          throw new Error("请拖入 PNG、JPG 或 WebP 图片");
        }
        const account = accountById(accountInput.value);
        if (!account) throw new Error("请先选择发布账号");
        status.textContent = "正在把拖入图片写入所选账号资产…";
        const title = titleInput.value.trim();
        const asset = await addAssetFromFile(account.id, file, {
          name: title
            ? `视频封面_${title.slice(0, 12)}`
            : `视频封面_${file.name.replace(/\.[^.]+$/, "").slice(0, 24)}`,
          tags: ["视频封面", "定制创作", "手动上传", "账号资产"],
          forceNew: true
        });
        if (!asset?.id || asset.type !== "图片") throw new Error("封面图片写入失败");
        installCover({
          assetId: asset.id,
          source: "uploaded",
          title,
          copy: copyInput.value.trim(),
          message: "已使用拖入图片作为封面；标题或文案变化不会替换这张手动封面。"
        });
      };
      const addCoverReferences = async files => {
        const account = accountById(accountInput.value);
        if (!account) throw new Error("请先选择发布账号");
        const candidates = [...(files || [])].filter(file => (
          file instanceof File
          && ["image/png", "image/jpeg", "image/webp"].includes(file.type)
        ));
        if (!candidates.length) throw new Error("请选择 PNG、JPG 或 WebP 参考图");
        const roleRefReserved = (
          account.subType === "数字人"
          && assetById(account.charBoardAssetId)?.type === "图片"
        ) ? 1 : 0;
        const available = Math.max(0, 5 - roleRefReserved - coverReferenceAssetIds.length);
        if (!available) throw new Error("封面参考图已达到上限");
        const accepted = candidates.slice(0, available);
        const addedIds = [];
        status.textContent = `正在写入 ${accepted.length} 张封面参考图…`;
        try {
          for (const file of accepted) {
            const asset = await addAssetFromFile(account.id, file, {
              name: `封面参考_${file.name.replace(/\.[^.]+$/, "").slice(0, 24)}`,
              tags: ["视频封面", "定制创作", "AI参考图", "临时素材"],
              forceNew: true
            });
            if (!asset?.id || asset.type !== "图片") throw new Error("参考图写入失败");
            addedIds.push(asset.id);
            createdCoverReferenceIds.add(asset.id);
          }
        } catch (error) {
          await Promise.all(addedIds.map(id => removeAsset(id).catch(() => {})));
          addedIds.forEach(id => createdCoverReferenceIds.delete(id));
          throw error;
        }
        invalidateGeneratedCoverForReferences();
        coverReferenceAssetIds = [...coverReferenceAssetIds, ...addedIds];
        renderCoverReferences();
        const skipped = candidates.length - accepted.length;
        status.textContent = skipped > 0
          ? `已添加 ${accepted.length} 张参考图；受 5 张上限影响，另有 ${skipped} 张未加入。`
          : `已添加 ${accepted.length} 张 AI 封面参考图；生成封面时会真实传入。`;
        saveDraftNow();
      };

      accountInput.addEventListener("change", () => {
        if (coverAccountId && coverAccountId !== accountInput.value) {
          invalidateCover("发布账号已变化，请按新账号重新生成或拖入封面。");
        }
        clearCoverReferences("发布账号已变化，已清除仅属于原账号的自定义封面参考图。");
        updateCoverHint();
        updateTextRule();
        queueDraftSave();
      });
      productInput.addEventListener("change", () => {
        const selectedProduct = productById(productInput.value);
        productTagInput.value = productTagLabel(selectedProduct) || "定制创作";
        if (coverProductId && coverProductId !== productInput.value) {
          invalidateCover("发布产品已变化，请按新产品重新生成或拖入封面。");
        }
        queueDraftSave();
      });
      titleInput.addEventListener("input", () => {
        if (coverSource === "generated" && coverTitle !== titleInput.value.trim()) {
          markGeneratedCoverStale("发布标题已变化。");
        }
        updateTextRule();
        queueDraftSave();
      });
      copyInput.addEventListener("input", () => {
        if (coverSource === "generated" && coverCopy !== copyInput.value.trim() && coverAssetId) {
          markGeneratedCoverStale("发布文案已变化。");
        }
        updateTextRule();
        queueDraftSave();
      });
      dateInput?.addEventListener("change", queueDraftSave);
      noteInput?.addEventListener("input", queueDraftSave);
      coverStyleInput?.addEventListener("change", () => {
        if (coverSource === "generated") invalidateCover("封面风格已变化，请按新风格重新生成封面。");
        queueDraftSave();
      });
      coverPaletteInput?.addEventListener("change", () => {
        if (coverSource === "generated") invalidateCover("封面配色已变化，请按新配色重新生成封面。");
        queueDraftSave();
      });
      panel.querySelector("#customPublishRandomPalette")?.addEventListener("click", () => {
        const choices = COVER_PALETTE_OPTIONS.filter(([value]) => !["auto", "random"].includes(value));
        const current = coverPaletteInput?.value || "";
        const alternatives = choices.filter(([value]) => value !== current);
        const selected = (alternatives.length ? alternatives : choices)[Math.floor(Math.random() * choices.length)];
        if (!selected || !coverPaletteInput) return;
        coverPaletteInput.value = selected[0];
        coverPaletteInput.dispatchEvent(new Event("change", { bubbles: true }));
        status.textContent = `已随机选择「${selected[1]}」，生成封面时会加入这组配色提示。`;
      });
      updateCoverHint();
      updateTextRule();
      saveDraftNow();

      coverPreview?.addEventListener("click", () => {
        if (coverBusy) return;
        const asset = coverAssetId ? assetById(coverAssetId) : null;
        const img = coverPreview.querySelector("img");
        if (asset && img) openLightbox(img, urlFor(asset), asset.name || "发布封面");
        else coverFileInput?.click();
      });
      coverPreview?.addEventListener("keydown", event => {
        if ((event.key === "Enter" || event.key === " ") && !coverBusy) {
          event.preventDefault();
          const asset = coverAssetId ? assetById(coverAssetId) : null;
          const img = coverPreview.querySelector("img");
          if (asset && img) openLightbox(img, urlFor(asset), asset.name || "发布封面");
          else coverFileInput?.click();
        }
      });
      ["dragenter", "dragover"].forEach(type => {
        coverPreview?.addEventListener(type, event => {
          event.preventDefault();
          if (!coverBusy) coverPreview.classList.add("is-dragover");
        });
      });
      ["dragleave", "dragend"].forEach(type => {
        coverPreview?.addEventListener(type, () => coverPreview.classList.remove("is-dragover"));
      });
      coverPreview?.addEventListener("drop", event => {
        event.preventDefault();
        coverPreview.classList.remove("is-dragover");
        const file = [...(event.dataTransfer?.files || [])]
          .find(item => item.type.startsWith("image/"));
        withCoverBusy(() => useDroppedCover(file))
          .catch(error => {
            status.textContent = error?.message || "封面拖入失败";
            toast(error?.message || "封面拖入失败", "error");
          });
      });
      coverFileInput?.addEventListener("change", () => {
        const file = coverFileInput.files?.[0];
        coverFileInput.value = "";
        withCoverBusy(() => useDroppedCover(file))
          .catch(error => {
            status.textContent = error?.message || "封面上传失败";
            toast(error?.message || "封面上传失败", "error");
          });
      });
      panel.querySelector("#customPublishUploadCover")?.addEventListener("click", () => {
        if (!coverBusy) coverFileInput?.click();
      });

      coverReferenceZone?.addEventListener("click", () => {
        if (!coverBusy) coverReferenceFileInput?.click();
      });
      coverReferenceZone?.addEventListener("keydown", event => {
        if ((event.key === "Enter" || event.key === " ") && !coverBusy) {
          event.preventDefault();
          coverReferenceFileInput?.click();
        }
      });
      ["dragenter", "dragover"].forEach(type => {
        coverReferenceZone?.addEventListener(type, event => {
          event.preventDefault();
          if (!coverBusy) coverReferenceZone.classList.add("is-dragover");
        });
      });
      ["dragleave", "dragend"].forEach(type => {
        coverReferenceZone?.addEventListener(type, () => coverReferenceZone.classList.remove("is-dragover"));
      });
      coverReferenceZone?.addEventListener("drop", event => {
        event.preventDefault();
        coverReferenceZone.classList.remove("is-dragover");
        withCoverBusy(() => addCoverReferences(event.dataTransfer?.files))
          .catch(error => {
            status.textContent = error?.message || "封面参考图拖入失败";
            toast(error?.message || "封面参考图拖入失败", "error");
          });
      });
      coverReferenceFileInput?.addEventListener("change", () => {
        const files = [...(coverReferenceFileInput.files || [])];
        coverReferenceFileInput.value = "";
        withCoverBusy(() => addCoverReferences(files))
          .catch(error => {
            status.textContent = error?.message || "封面参考图上传失败";
            toast(error?.message || "封面参考图上传失败", "error");
          });
      });
      coverReferenceList?.addEventListener("click", event => {
        const removeButton = event.target.closest("[data-cover-ref-remove]");
        if (removeButton) {
          event.preventDefault();
          event.stopPropagation();
          if (coverBusy) return;
          if (pendingSubmission) {
            toast("交付正在等待同步，不能再修改封面参考图。", "error");
            return;
          }
          const assetId = removeButton.dataset.coverRefRemove || "";
          coverReferenceAssetIds = coverReferenceAssetIds.filter(id => id !== assetId);
          invalidateGeneratedCoverForReferences();
          renderCoverReferences();
          removeCreatedCoverReference(assetId, "[custom-cover-reference-remove]");
          status.textContent = "已移除参考图；如需 AI 封面，请按当前参考图重新生成。";
          saveDraftNow();
          return;
        }
        const previewButton = event.target.closest("[data-cover-ref-preview]");
        if (!previewButton) return;
        const asset = assetById(previewButton.dataset.coverRefPreview || "");
        const img = previewButton.querySelector("img");
        if (asset && img) openLightbox(img, urlFor(asset), asset.name || "封面参考图");
      });

      panel.querySelector("#customPublishGenerateCopy")?.addEventListener("click", event => {
        withLoading(event.currentTarget, async () => {
          const previousCopy = copyInput.value;
          try {
            const title = titleInput.value.trim();
            if (!title) throw new Error("请先填写发布标题");
            const account = accountById(accountInput.value);
            if (!account) throw new Error("请先选择发布账号");
            status.textContent = "正在根据标题生成发布文案…";
            const product = productById(productInput.value);
            const generated = kind === "video"
              ? await AI.generateCopy({
                topic: title,
                shots: spokenShots(output),
                account,
                style: account.styleProfile || account.lockedStyle || "",
                kind: "video",
                product,
                requireLlm: true
              })
              : await AI.generateImageCopyFromTitle({ title, account, product });
            const generatedCopy = kind === "canvas"
              ? compactCanvasPublishCopy(generated.copy || "")
              : String(generated.copy || "");
            copyInput.value = generatedCopy;
            updateTextRule();
            if (coverSource === "generated" && coverAssetId) {
              // Generating copy after a cover is an intentional publish workflow.
              // Keep the chosen cover, then use the new copy as the next edit baseline.
              coverCopy = generatedCopy.trim();
              status.textContent = "文案已生成，现有封面已保留。";
            } else {
              status.textContent = "文案已生成，可以继续手动修改。";
            }
            saveDraftNow();
          } catch (error) {
            copyInput.value = previousCopy;
            status.textContent = "文案生成失败，已保留原文案。";
            throw error;
          }
        }, "生成中…");
      });

      panel.querySelector("#customPublishGenerateCover")?.addEventListener("click", event => {
        withLoading(event.currentTarget, async () => {
          const title = titleInput.value.trim();
          if (!title) throw new Error("请先填写发布标题");
          await withCoverBusy(async () => {
            const styleOption = COVER_STYLE_OPTIONS.find(([value]) => value === coverStyleInput?.value)
              || COVER_STYLE_OPTIONS[0];
            let paletteOption = COVER_PALETTE_OPTIONS.find(([value]) => value === coverPaletteInput?.value)
              || COVER_PALETTE_OPTIONS[0];
            if (paletteOption[0] === "random") {
              const choices = COVER_PALETTE_OPTIONS.filter(([value]) => !["auto", "random"].includes(value));
              paletteOption = choices[Math.floor(Math.random() * choices.length)] || COVER_PALETTE_OPTIONS[0];
            }
            status.textContent = "正在根据标题、账号风格和参考图生成封面…";
            const generated = await generateCover({
              output,
              accountId: accountInput.value,
              productId: productInput.value,
              title,
              copy: copyInput.value.trim(),
              extraReferenceAssetIds: coverReferenceAssetIds,
              stylePrompt: styleOption[2],
              palettePrompt: paletteOption[2],
            });
            if (!generated.assetId) throw new Error("封面生成没有返回图片");
            installCover({
              assetId: generated.assetId,
              source: "generated",
              title,
              copy: copyInput.value.trim(),
              message: generated.roleRefAssetId
                ? `封面已生成，已默认使用数字人角色形象${coverReferenceAssetIds.length ? `及 ${coverReferenceAssetIds.length} 张自定义参考图` : ""}。`
                : `封面已根据标题和账号风格生成${coverReferenceAssetIds.length ? `，并参考了 ${coverReferenceAssetIds.length} 张自定义图片` : ""}。`
            });
          });
        }, "生成中…");
      });

      submitButton?.addEventListener("click", event => {
        withLoading(event.currentTarget, async () => {
          const accountId = accountInput.value;
          const account = accountById(accountId);
          const productId = productInput.value;
          const product = productById(productId);
          const title = titleInput.value.trim();
          const planDate = panel.querySelector("#customPublishDate").value;
          if (!canDeliver()) throw new Error("当前账号没有发布权限");
          if (!account) throw new Error("请先选择发布账号");
          if (!planDate) throw new Error("请填写计划发布日期");
          await refreshAccountPublishQuotas([accountId], { force: true, dayKey: planDate });
          if (!accountPublishAvailable(accountId, 1, planDate)) throw new Error(`该账号 ${planDate} 已达到 2 条内容的发布上限`);
          if (!product) throw new Error("请先选择产品");
          if (!title) throw new Error("发布标题为必填项");
          assertPublishText({ platform: account.platform, title, copy: copyInput.value.trim() });
          if (kind === "video" && (
            !coverAssetId
            || coverAccountId !== accountId
            || coverProductId !== productId
          )) throw new Error("封面与当前账号或产品不一致，请重新生成或拖入");
          const productTag = productTagLabel(product) || "定制创作";
          const note = panel.querySelector("#customPublishNote").value.trim();
          const signature = publishSignature({
            accountId,
            productId,
            title,
            copy: copyInput.value.trim(),
            coverAssetId,
            planDate,
            productTag,
            note,
            coverStyle: coverStyleInput?.value || "",
            coverPalette: coverPaletteInput?.value || "",
          });
          if (pendingSubmission && pendingSubmission.signature !== signature) {
            throw new Error("已有待同步交付，不能修改字段后重复创建；请先重试同步");
          }

          if (!pendingSubmission) {
            status.textContent = kind === "video"
              ? "正在复制成片并准备原子提交…"
              : "正在精修画布成品并准备原子提交…";
            const sharedMode = remote.isOn() && remote.hasToken();
            let materialized = null;
            let asset = null;
            try {
              output.productId = productId;
              output.productTag = productTag;
              const customProjectId = sharedMode
                ? await ensureRemoteCustomProject(output, kind, title)
                : String(output.customProjectId || output.projectId || "").trim();
              if (!customProjectId) throw new Error("缺少定制项目编号");
              if (sharedMode && !releaseSyncHold) {
                releaseSyncHold = remote.holdCollectionSync(["assets", "accounts"]);
              }
              materialized = kind === "video"
                ? await materializeVideo(output, accountId, title)
                : await materializeCanvas(output, accountId, title);
              asset = deliverCustomOutput({
                ...output,
                ...materialized,
                kind,
                accountId,
                title,
                copy: copyInput.value.trim(),
                coverAssetId,
                customProjectId,
                productId
              }, {
                planDate,
                productTag,
                note,
                deferCommit: sharedMode
              });
              if (!asset) throw new Error("提交发布失败");
              pendingSubmission = {
                signature,
                asset,
                materialized,
                customProjectId,
                requiresRemote: sharedMode
              };
            } catch (error) {
              releaseSyncHold?.({ flush: false });
              releaseSyncHold = null;
              if (!asset && materialized?.createdAssetIds?.length) {
                await Promise.all(materialized.createdAssetIds.map(id => removeAsset(id).catch(() => {})));
              }
              throw error;
            }
          }

          const { asset, materialized, customProjectId, requiresRemote } = pendingSubmission;
          let publishedCount = Math.max(0, Number(output.publishedCount || 0));
          if (requiresRemote && (!remote.isOn() || !remote.hasToken())) {
            await rollbackPending(asset, materialized);
            pendingSubmission = null;
            releaseSyncHold?.({ flush: false });
            releaseSyncHold = null;
            setPendingMode(false);
            status.textContent = "登录状态已经失效，本地待同步记录已回滚。请重新登录后再提交。";
            throw new Error("登录已过期，请重新登录后再提交");
          }
          if (requiresRemote) {
            status.textContent = "正在原子同步交付单、素材、账号统计和项目状态…";
            try {
              const result = await remote.customProjects.publish(
                customProjectId,
                publishBundle(asset, account)
              );
              if (result?.account) Object.assign(account, result.account);
              if (result?.delivery) Object.assign(asset, result.delivery);
              publishedCount = Math.max(
                0,
                Number(result?.project?.publishedCount || 0),
              );
            } catch (error) {
              console.error("[custom-publish-atomic]", error);
              if (Number(error?.status || 0) === 409) {
                invalidateAccountPublishQuotas([accountId]);
                void refreshAccountPublishQuotas([accountId], { force: true, dayKey: planDate });
              }
              if (definitivePublishFailure(error)) {
                if ([403, 404].includes(Number(error?.status || 0))) {
                  output.customProjectId = "";
                }
                await rollbackPending(asset, materialized);
                pendingSubmission = null;
                releaseSyncHold?.({ flush: false });
                releaseSyncHold = null;
                setPendingMode(false);
                status.textContent = "服务器拒绝了本次交付，已安全回滚复制的成品；请检查后重试。";
                throw error;
              }
              status.textContent = "连接中断，交付仍保留在当前弹窗中。请直接点击“重试同步”，不会重复复制或重复计数。";
              setPendingMode(true);
              window.setTimeout(() => setPendingMode(true), 0);
              toast(error?.message || "服务器同步中断，请重试", "error");
              return null;
            }
            releaseSyncHold?.({ flush: false });
            releaseSyncHold = null;
            commitCustomDelivery(asset);
            invalidateAccountPublishQuotas([accountId]);
            await refreshAccountPublishQuotas([accountId], { force: true, dayKey: planDate });
          } else {
            publishedCount += 1;
          }

          pendingSubmission = null;
          published = true;
          output.publishedCount = publishedCount;
          setPendingMode(false);
          toast(`已提交发布 · #${String(asset.pubSeq).padStart(3, "0")} · 供应商端可见`);
          onPublished?.(asset, { customProjectId, publishedCount });
          close();
          return asset;
        }, "提交中…");
      });
    }
  });
  activeCustomPublishModal = modal;
  return modal;
}
