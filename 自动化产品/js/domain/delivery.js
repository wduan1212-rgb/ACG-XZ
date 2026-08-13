/* 发布清单：定稿入库（创作端） + 素材分发（供应商端）
   交付 = 内部定稿归档，产物进入交付库供供应商下载，不涉及任何平台发布 */

import { state, save, persistNow, notify, accountById, assetById, canDeliver, currentMember, productById, pullRemote, removeRemote, cacheCanonicalDocuments } from "../core/store.js";
import { uid, esc, buildZipBlob, downloadBlob } from "../core/util.js";
import { buildDeliveryName, modeLabel } from "./accounts.js";
import { setStage, touch } from "./productions.js?v=20260813-v1431-creation-queue-stability-1";
import { assetU8, urlFor } from "./assets.js";
import * as remote from "../core/remote.js";
import { assertPublishText } from "./publishRules.js?v=20260813-v1431-creation-queue-stability-1";
import {
  accountPublishAvailable,
  invalidateAccountPublishQuotas,
  refreshAccountPublishQuotas,
} from "./productionQuota.js?v=20260813-v1431-creation-queue-stability-1";

const SUPPLIER_ROLES = new Set(["supplier", "supplier_parent", "supplier_child"]);

async function markSupplierDownloadedWithRetry(assetId) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await remote.supplier.markDownloaded(assetId);
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 350));
      }
    }
  }
  throw lastError || new Error("供应商下载状态同步失败");
}

export function productTagLabel(product) {
  const name = String(product?.name || "");
  const short = String(product?.shortName || "");
  if (/百度搭子/.test(name + short)) return "百度搭子";
  const picked = short || name.split(/[\/｜|]/).map(x => x.trim()).find(Boolean) || name;
  return String(picked || "").replace(/\s+/g, "").slice(0, 12);
}

function productTagFor(p) {
  const product = productById(p?.artifacts?.script?.productId || "dumate");
  return productTagLabel(product);
}

function memberNameById(id) {
  return state.members.find(m => m.id === id)?.name || "";
}

function publisherNameFor(asset, prod = null) {
  // byMemberName is a historical snapshot.  Prefer the current member name
  // so Settings renames are reflected everywhere without rewriting history.
  return memberNameById(asset?.byMemberId) || memberNameById(prod?.ownerId) || asset?.byMemberName || "";
}

export function productionImageAssetIssues(p) {
  if (!p || p.mode !== "图文") return [];
  const items = Array.isArray(p.artifacts?.images?.items) ? p.artifacts.images.items : [];
  if (!items.length) return [{ index: 0, assetId: "", reason: "empty" }];
  return items.flatMap((item, index) => {
    const assetId = String(item?.assetId || "").trim();
    if (!assetId) return [{ index, assetId: "", reason: "missing" }];
    const asset = assetById(assetId);
    if (!asset) return [{ index, assetId, reason: "not-found" }];
    if (asset.delivered) return [{ index, assetId, reason: "already-delivered" }];
    if (asset.type !== "图片") return [{ index, assetId, reason: "wrong-type" }];
    if (String(asset.accountId || "") !== String(p.accountId || "")) {
      return [{ index, assetId, reason: "wrong-account" }];
    }
    if (asset.fileMissing === true) return [{ index, assetId, reason: "file-missing" }];
    return [];
  });
}

function deliverySnapshotFromProduction(p, acc, productTag = productTagFor(p)) {
  const isImg = p.mode === "图文";
  const imgItems = (p.artifacts.images.items || []).filter(x => x.assetId);
  const timeline = p.artifacts.timeline || [];
  const withSub = (p.artifacts.subs || []).some(s => (s.text || "").trim());
  const coverAssetId = isImg
    ? (imgItems[0]?.assetId || "")
    : (p.artifacts?.boards?.cover?.assetId || "");
  return {
    type: isImg ? "图集" : "视频",
    tags: ["成片", acc?.mode, acc?.platform, ...(productTag ? [productTag] : []), ...(isImg ? [`${imgItems.length}张组图`] : withSub ? ["带字幕"] : [])].filter(Boolean),
    title: p.artifacts.copy.title || p.title,
    copy: p.artifacts.copy.body || "",
    packAssetIds: isImg ? imgItems.map(x => x.assetId) : [],
    videoUrl: isImg ? "" : (p.artifacts.finalVideoUrl || ""),
    clipJobIds: isImg ? [] : timeline.map(x => x.jobId).filter(Boolean),
    clipUrls: isImg ? [] : timeline.map(x => state.jobs.find(j => j.id === x.jobId)?.output?.url).filter(Boolean),
    clips: isImg ? 0 : timeline.length,
    subCount: (p.artifacts.subs || []).filter(s => (s.text || "").trim()).length,
    productId: p.artifacts?.script?.productId || "dumate",
    productTag,
    byAccount: acc?.name || "",
    coverAssetId
  };
}

export function supplierHasPublished(asset) {
  return !!asset?.publishedUrl || asset?.publishedWithoutLink === true || asset?.status === "已发布";
}

export function applySupplierReturnResponse(asset, response) {
  const returned = response?.asset;
  if (!asset || !returned || String(returned.id || "") !== String(asset.id || "")) return false;
  if (returned.publishedUrl) delete asset.publishedWithoutLink;
  if (returned.publishedWithoutLink) {
    for (const key of ["publishedUrl", "publishedTitle", "publishedRawText"] ) delete asset[key];
  }
  if (returned.publishedClearedAt && !returned.publishedUrl) {
    for (const key of ["publishedUrl", "supplierNote", "publishedTitle", "publishedRawText", "publishedAt", "publishedWithoutLink"]) delete asset[key];
  }
  Object.assign(asset, returned);
  // A successful clear-link response intentionally returns the same asset
  // without publishedUrl.  Identity is the acknowledgement; published state
  // is not, otherwise the UI would report a valid clear as a failed request.
  return true;
}

export function supplierReturnRowState(asset) {
  const returned = supplierHasPublished(asset);
  const hasLink = !!asset?.publishedUrl;
  const downloaded = supplierHasDownloaded(asset);
  return {
    returned,
    statusClass: returned ? "pub" : downloaded ? "done" : "",
    statusText: returned ? "已回传 ✓" : downloaded ? "已下载" : "未下载",
    actionClass: hasLink ? "ghost" : "primary",
    actionText: hasLink ? "改链接" : "回传链接"
  };
}

/* 服务端 globalSeq 是跨成员、跨供应商视角的全局时间线投影；历史 pubSeq
   可能是旧浏览器按个人可见子集生成的编号，只在没有全局投影时兼容使用。 */
export function deliveryDisplaySequence(asset, fallback = 0) {
  for (const value of [asset?.globalSeq, asset?.projectedSeq, asset?.pubSeq, fallback]) {
    const seq = Number(value || 0);
    if (Number.isSafeInteger(seq) && seq > 0) return seq;
  }
  return 0;
}

/* 供应商收到素材的制作时间，以交付记录真正进入供应商端的时间为准。
   deliveredAt 是现行权威字段；createdAt 仅用于兼容没有 deliveredAt 的旧交付记录。
   sourceCreatedAt 是创作任务建立时间，不能误当成素材提交时间。 */
export function deliverySubmittedAt(asset = {}) {
  for (const value of [asset?.deliveredAt, asset?.createdAt]) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return 0;
}

export function parseSupplierViewCount(value) {
  const normalized = String(value ?? "").replace(/[,，\s]/g, "");
  if (!normalized) return { ok: false, message: "请输入当前观看量" };
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return { ok: false, message: "观看量必须是大于或等于 0 的数字" };
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) {
    return { ok: false, message: "观看量超出可填写范围" };
  }
  return { ok: true, value: Math.round(number) };
}

export function supplierViewCountPromptValue(asset = {}) {
  const hasSavedMarker = Number(asset.viewsUpdatedAt || 0) > 0
    || !!String(asset.viewsUpdatedBy || "").trim();
  const number = Number(asset.viewCount || 0);
  const hasLegacyNonZeroValue = Number.isFinite(number) && number > 0;
  if (!hasSavedMarker && !hasLegacyNonZeroValue) return "";
  return String(Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0);
}

function isPublishedDelivery(asset) {
  return supplierHasPublished(asset);
}

function purgeOpenDeliveryAssetsForProduction(p) {
  const stale = state.assets.filter(x => x.delivered && x.productionId === p.id && !isPublishedDelivery(x));
  if (!stale.length) return 0;
  const ids = stale.map(x => x.id);
  const analyticsIds = state.analyticsLinks
    .filter(x => ids.includes(x.assetId))
    .map(x => x.id);
  state.assets = state.assets.filter(x => !ids.includes(x.id));
  state.analyticsLinks = state.analyticsLinks.filter(x => !analyticsIds.includes(x.id));
  ids.forEach(id => removeRemote("assets", id));
  analyticsIds.forEach(id => removeRemote("analyticsLinks", id));
  return stale.length;
}

function insertProductTagBeforeDate(name, tag) {
  if (!tag || String(name || "").includes(`-${tag}-`)) return name;
  return String(name || "").replace(/-(20\d{6})$/, `-${tag}-$1`);
}

function todayPlanDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function normalizePlanDate(value = "") {
  const raw = String(value || "").trim();
  return (raw ? raw.slice(0, 10).replace(/\//g, "-") : todayPlanDate());
}

function markPackImagesShared(p, productTag) {
  const items = (p.artifacts?.images?.items || []).filter(x => x.assetId);
  items.forEach((it, index) => {
    const img = assetById(it.assetId);
    if (!img || img.delivered || img.type !== "图片") return;
    img.shared = true;
    img.sharedAt = Date.now();
    img.sharedSource = "delivered-production";
    img.productionId = p.id;
    img.productId = p.artifacts?.script?.productId || img.productId || "dumate";
    img.productTag = productTag || img.productTag || "";
    img.title = img.title || it.title || p.artifacts?.copy?.title || p.title || "";
    img.name = img.name || `已发布生成图${String(index + 1).padStart(2, "0")}`;
    img.tags = [...new Set([...(img.tags || []), "已发布生成图", "共享素材", ...(productTag ? [productTag] : [])])];
  });
}

function markDeliveryCoverShared(coverAssetId, {
  projectId = "",
  productionId = "",
  productId = "dumate",
  productTag = "",
  title = "",
  source = "delivered-video"
} = {}) {
  const cover = assetById(coverAssetId);
  if (!cover || cover.delivered || cover.type !== "图片") return;
  cover.shared = true;
  cover.sharedAt = Date.now();
  cover.sharedSource = source;
  if (projectId) cover.customProjectId = projectId;
  if (productionId) cover.productionId = productionId;
  cover.productId = productId || cover.productId || "dumate";
  cover.productTag = productTag || cover.productTag || "";
  cover.title = cover.title || title;
  cover.tags = [...new Set([
    ...(cover.tags || []),
    "发布封面",
    "共享素材",
    ...(productTag ? [productTag] : [])
  ])];
}

/* 发布交付：创作者自行定稿入库（无强制审核门槛），分配全局发布序号 + 记录发布账号/成员
   交付 = 内部定稿归档，产物进入交付库供供应商下载，不涉及任何平台发布 */
export async function deliver(p, opts = {}) {
  const acc = accountById(p.accountId);
  if (!acc) return null;
  if (!canDeliver()) { window.__toast && window.__toast("当前账号没有发布权限"); return null; }
  const imageIssues = productionImageAssetIssues(p);
  if (imageIssues.length) {
    const positions = imageIssues.map(issue => issue.index + 1).join("、");
    const error = new Error(`第 ${positions} 张图片尚未正确同步，请先重试这些图片再发布`);
    error.code = "DELIVERY_MEDIA_INCOMPLETE";
    error.imageIssues = imageIssues;
    throw error;
  }
  const planDate = normalizePlanDate(opts.planDate);
  await refreshAccountPublishQuotas([acc.id], { force: true, dayKey: planDate });
  if (!accountPublishAvailable(acc.id, 1, planDate)) {
    throw new Error(`该账号 ${planDate} 已达到 2 条内容的发布上限`);
  }
  assertPublishText({
    platform: acc.platform,
    title: p.artifacts?.copy?.title || p.title || "",
    copy: p.artifacts?.copy?.body || "",
  });
  if (p.mode === "视频" && !String(p.artifacts?.finalVideoUrl || "").trim()) {
    window.__toast && window.__toast("完整成片尚未合成，请先回到剪辑台完成合成", "error");
    return null;
  }
  const productTag = String(opts.productTag || "").trim().slice(0, 20);
  if (!productTag) { window.__toast && window.__toast("请在发布弹窗填写产品标签", "error"); return null; }
  const nextExportSeq = (acc.exportSeq || 0) + 1;
  const name = insertProductTagBeforeDate(buildDeliveryName(acc, nextExportSeq), productTag);
  const mem = currentMember();
  const publisherName = mem?.name || memberNameById(p.ownerId);
  const pubSeq = (state.ui.deliverSeq || 0) + 1;
  const snapshot = deliverySnapshotFromProduction(p, acc, productTag);
  const now = Date.now();

  const asset = {
    id: uid(), accountId: acc.id, name,
    ...snapshot,
    createdAt: now, delivered: true, status: "未下载",
    productionId: p.id,
    pubSeq, deliveredAt: now,
    sourceCreatedAt: p.createdAt || now,      // 创作端建立该任务的时间
    byAccount: acc.name,                          // 发布所属内容账号
    byMemberId: mem?.id || p.ownerId || null,
    byMemberName: publisherName || "",            // 谁点的发布
    sourceUpdatedAt: p.updatedAt || now,
    planDate,                                     // 计划发布日期（必填，默认今天）
    publishNote: opts.note || "",                 // 简短备注（可选）
    adminReviewed: false                          // 管理员「已审阅」标注（非强制门槛）
  };
  const dependencyIds = snapshot.type === "图集"
    ? snapshot.packAssetIds
    : [snapshot.coverAssetId].filter(Boolean);
  const dependencyAssets = dependencyIds.map(assetById).filter(Boolean).map(item => ({ ...item }));
  const productionDraft = JSON.parse(JSON.stringify(p));
  productionDraft.review = { ...(productionDraft.review || {}), state: "approved", at: now };
  productionDraft.delivery = { assetId: asset.id, name, at: now, pubSeq, planDate: asset.planDate, productTag, note: asset.publishNote, sourceUpdatedAt: asset.sourceUpdatedAt };
  productionDraft.stage = "delivered";
  productionDraft.stageStatus = "done";
  productionDraft.updatedAt = now;

  if (remote.isOn()) {
    let response;
    try {
      response = await remote.productionDeliveries.publish(p.id, {
        deliveryId: asset.id,
        delivery: asset,
        assets: dependencyAssets,
        account: { ...acc },
        production: productionDraft,
      });
    } catch (error) {
      if (Number(error?.status || 0) === 409) {
        invalidateAccountPublishQuotas([acc.id]);
        void refreshAccountPublishQuotas([acc.id], { force: true, dayKey: planDate });
      }
      throw error;
    }
    const canonical = response?.delivery;
    if (!canonical?.id || !response?.production?.id || !response?.account?.id) {
      throw new Error("服务器未返回完整发布确认");
    }
    Object.assign(acc, response.account);
    Object.assign(p, response.production);
    for (const item of response.assets || []) {
      const current = assetById(item.id);
      if (current) Object.assign(current, item);
      else state.assets.push(item);
    }
    const existing = assetById(canonical.id);
    if (existing) Object.assign(existing, canonical);
    else state.assets.push(canonical);
    state.ui.deliverSeq = Math.max(Number(state.ui.deliverSeq || 0), Number(canonical.pubSeq || 0));
    await Promise.all([
      cacheCanonicalDocuments("assets", ...(response.assets || []), canonical),
      cacheCanonicalDocuments("accounts", response.account),
      cacheCanonicalDocuments("productions", response.production),
    ]);
    invalidateAccountPublishQuotas([acc.id]);
    await refreshAccountPublishQuotas([acc.id], { force: true, dayKey: planDate });
    save("meta");
    notify("delivery", `「${canonical.title || canonical.name}」已发布`, `#${String(canonical.pubSeq || 0).padStart(3, "0")} · ${canonical.name}${canonical.type === "图集" ? ".zip" : ".mp4"} · 供应商端可见`);
    return canonical;
  }

  p.review = productionDraft.review;
  acc.exportSeq = nextExportSeq;
  if (snapshot.type === "图集") markPackImagesShared(p, productTag);
  else markDeliveryCoverShared(snapshot.coverAssetId, {
    productionId: p.id,
    productId: snapshot.productId,
    productTag,
    title: snapshot.title,
    source: "delivered-production-video"
  });
  state.assets.push(asset);
  invalidateAccountPublishQuotas([acc.id]);
  acc.monthlyDone = (acc.monthlyDone || 0) + 1;
  Object.assign(p, productionDraft);
  state.ui.deliverSeq = pubSeq;
  save("assets", "accounts", "productions", "analyticsLinks", "meta");
  await persistNow();
  notify("delivery", `「${asset.title || name}」已发布`, `#${String(pubSeq).padStart(3, "0")} · ${name}${snapshot.type === "图集" ? ".zip" : ".mp4"} · 供应商端可见`);
  return asset;
}

/* 定制创作交付：视频工坊 / 无限画布先把成品写入账号资产，再复用发布清单与供应商端。
   子应用草稿仍由 owner-scoped customProjects 管理，这里只接收已经物化到主平台资产库的输出。 */
export function deliverCustomOutput(output = {}, opts = {}) {
  const acc = accountById(output.accountId);
  if (!acc) return null;
  if (!canDeliver()) { window.__toast && window.__toast("当前账号没有发布权限"); return null; }
  const title = String(output.title || "").trim();
  if (!title) { window.__toast && window.__toast("请先填写发布标题", "error"); return null; }
  assertPublishText({ platform: acc.platform, title, copy: output.copy || "" });
  const kind = output.kind === "canvas" || output.type === "图集" ? "canvas" : "video";
  const expectedMode = kind === "canvas" ? "图文" : "视频";
  if (acc.mode !== expectedMode) {
    window.__toast && window.__toast(`该成品只能提交到${expectedMode}账号`, "error");
    return null;
  }
  const packAssetIds = [...new Set((output.packAssetIds || []).filter(Boolean))].slice(0, 20);
  const videoUrl = String(output.videoUrl || "").trim();
  if (kind === "canvas" && !packAssetIds.length) {
    window.__toast && window.__toast("没有可提交的画布图片", "error");
    return null;
  }
  if (kind === "video" && !videoUrl) {
    window.__toast && window.__toast("没有可提交的视频成片", "error");
    return null;
  }
  if (kind === "canvas") {
    const validImages = packAssetIds.every(id => {
      const image = assetById(id);
      return !!image && image.type === "图片" && !image.delivered && image.accountId === acc.id;
    });
    if (!validImages) {
      window.__toast && window.__toast("画布成品未完整写入当前发布账号，已停止提交", "error");
      return null;
    }
  }
  const sourceAsset = kind === "video" ? assetById(output.sourceAssetId) : null;
  if (kind === "video" && (
    !sourceAsset
    || sourceAsset.type !== "视频"
    || sourceAsset.delivered
    || sourceAsset.accountId !== acc.id
  )) {
    window.__toast && window.__toast("视频成片未正确写入当前发布账号，已停止提交", "error");
    return null;
  }
  const coverAsset = kind === "video" ? assetById(output.coverAssetId) : null;
  if (kind === "video" && (
    !coverAsset
    || coverAsset.type !== "图片"
    || coverAsset.delivered
    || coverAsset.accountId !== acc.id
  )) {
    window.__toast && window.__toast("请先生成或选择封面", "error");
    return null;
  }

  const planDate = normalizePlanDate(opts.planDate);
  const productTag = String(opts.productTag || "定制创作").trim().slice(0, 20);
  const projectId = String(output.customProjectId || output.projectId || "").trim();

  acc.exportSeq = (acc.exportSeq || 0) + 1;
  const name = insertProductTagBeforeDate(buildDeliveryName(acc, acc.exportSeq), productTag);
  const mem = currentMember();
  const pubSeq = (state.ui.deliverSeq = (state.ui.deliverSeq || 0) + 1);
  const now = Date.now();
  const type = kind === "canvas" ? "图集" : "视频";
  const sourceItemIds = kind === "canvas"
    ? [...new Set([
        ...(output.sourceItemIds || []),
        ...((output.items || []).map(item => item?.sourceItemId || ""))
      ].map(value => String(value || "").trim()).filter(Boolean))].slice(0, 20)
    : [];
  const asset = {
    id: uid(),
    accountId: acc.id,
    name,
    type,
    tags: [
      "成片",
      "定制创作",
      kind === "canvas" ? "无限画布" : "视频工坊",
      acc.mode,
      acc.platform,
      productTag,
      ...(kind === "canvas" ? [`${packAssetIds.length}张组图`] : [])
    ].filter(Boolean),
    title,
    copy: String(output.copy || ""),
    packAssetIds: kind === "canvas" ? packAssetIds : [],
    videoUrl: kind === "video" ? videoUrl : "",
    clipJobIds: [],
    clipUrls: [],
    clips: kind === "video" ? 1 : 0,
    subCount: Number(output.subCount || 0),
    productId: String(output.productId || opts.productId || "dumate"),
    productTag,
    byAccount: acc.name,
    coverAssetId: String(output.coverAssetId || (kind === "canvas" ? packAssetIds[0] || "" : "")),
    createdAt: now,
    deliveredAt: now,
    delivered: true,
    status: "未下载",
    pubSeq,
    planDate,
    publishNote: String(opts.note || ""),
    adminReviewed: false,
    byMemberId: mem?.id || state.ui.currentMemberId || null,
    byMemberName: mem?.name || "",
    sourceCreatedAt: Number(output.createdAt || now),
    sourceUpdatedAt: now,
    customProjectId: projectId,
    customOutputKind: kind,
    sourceDeliveryId: kind === "video" ? String(output.sourceDeliveryId || "").trim().slice(0, 180) : "",
    sourceOutputId: kind === "video" ? String(output.sourceOutputId || "").trim().slice(0, 180) : "",
    sourceItemIds,
    sourceAssetId: String(output.sourceAssetId || ""),
    aspectRatio: String(output.aspectRatio || "")
  };

  if (kind === "canvas") {
    packAssetIds.forEach((id, index) => {
      const image = assetById(id);
      if (!image || image.type !== "图片" || image.accountId !== acc.id) return;
      image.shared = true;
      image.sharedAt = now;
      image.sharedSource = "delivered-custom-canvas";
      image.customProjectId = projectId;
      image.productId = asset.productId;
      image.productTag = productTag;
      image.title = image.title || title;
      image.name = image.name || `画布发布图${String(index + 1).padStart(2, "0")}`;
      image.tags = [...new Set([...(image.tags || []), "已发布生成图", "共享素材", "无限画布", productTag])];
    });
  } else {
    markDeliveryCoverShared(asset.coverAssetId, {
      projectId,
      productId: asset.productId,
      productTag,
      title,
      source: "delivered-custom-video"
    });
  }

  state.assets.push(asset);
  acc.monthlyDone = (acc.monthlyDone || 0) + 1;
  if (!opts.deferCommit) commitCustomDelivery(asset);
  return asset;
}

export function commitCustomDelivery(asset) {
  if (!asset?.delivered || !asset.customProjectId) return null;
  save("assets", "accounts", "meta");
  persistNow();
  notify(
    "delivery",
    `「${asset.title || asset.name}」已发布`,
    `#${String(asset.pubSeq).padStart(3, "0")} · ${asset.name}${asset.type === "图集" ? ".zip" : ".mp4"} · 供应商端可见`
  );
  return asset;
}

export function discardCustomDelivery(asset) {
  if (!asset?.delivered) return false;
  const acc = accountById(asset.accountId);
  state.assets = state.assets.filter(item => item.id !== asset.id);
  if (acc && (acc.monthlyDone || 0) > 0) {
    acc.monthlyDone = Math.max(0, acc.monthlyDone - 1);
  }
  if (acc && (acc.exportSeq || 0) > 0) {
    acc.exportSeq = Math.max(0, acc.exportSeq - 1);
  }
  return true;
}

/* 管理员在发布清单标注/取消「已审阅」（仅记号，不阻断任何流程） */
export function toggleAdminReviewed(asset) {
  asset.adminReviewed = !asset.adminReviewed;
  asset.reviewedBy = asset.adminReviewed ? (currentMember()?.name || "管理员") : "";
  asset.reviewedAt = asset.adminReviewed ? Date.now() : null;
  save("assets");
  return asset.adminReviewed;
}

export function canDeleteDelivery(asset) {
  if (!asset?.delivered) return false;
  if (deliveryRetractBlockReason(asset)) return false;
  if (state.role === "admin") return true;
  if (state.role !== "editor") return false;
  const mem = currentMember();
  const prod = state.productions.find(p => p.id === asset.productionId);
  return !!mem && (
    asset.byMemberId === mem.id ||
    prod?.ownerId === mem.id ||
    (!asset.byMemberId && asset.byMemberName && asset.byMemberName === mem.name)
  );
}

export function canSeeDeliveryRetract(asset) {
  if (!asset?.delivered) return false;
  if (state.role === "admin") return true;
  if (state.role !== "editor") return false;
  const mem = currentMember();
  const prod = state.productions.find(p => p.id === asset.productionId);
  return !!mem && (
    asset.byMemberId === mem.id ||
    prod?.ownerId === mem.id ||
    (!asset.byMemberId && asset.byMemberName && asset.byMemberName === mem.name)
  );
}

export function deliveryRetractBlockReason(asset) {
  if (!asset?.delivered) return "不是发布清单内容";
  if (asset.publishedUrl || asset.status === "已发布") return "供应商已回传发布链接，无法回撤";
  if (supplierHasDownloaded(asset)) return "供应商已下载，无法回撤";
  return "";
}

export function supplierHasDownloaded(asset) {
  return !!asset?.supplierDownloadedAt || asset?.status === "已下载";
}

export function matchesDeliveryStatusFilters(asset, filters = {}) {
  const download = filters.download || "all";
  const publish = filters.publish || "all";
  const downloaded = supplierHasDownloaded(asset);
  const published = supplierHasPublished(asset);
  const downloadMatches = download === "all"
    || (download === "downloaded" && downloaded)
    || (download === "undownloaded" && !downloaded);
  const publishMatches = publish === "all"
    || (publish === "published" && published)
    || (publish === "unpublished" && !published);
  return downloadMatches && publishMatches;
}

export async function deleteDeliveryAsset(asset) {
  if (!asset || !canDeleteDelivery(asset)) return false;
  if (asset.customProjectId && remote.isOn()) {
    if (!remote.hasToken()) throw new Error("登录已过期，请重新登录后再回撤");
    await remote.customProjects.unpublish(asset.customProjectId, asset.id);
    if (!await pullRemote()) {
      throw new Error("服务器已处理回撤，但本地状态刷新失败，请保持页面并重试刷新");
    }
    notify("delivery", `「${asset.title || asset.name}」已回撤`, "发布清单记录已删除，定制项目已恢复为草稿/上一版本，原始账号素材保留");
    return true;
  }
  const acc = accountById(asset.accountId);
  const prod = state.productions.find(p => p.id === asset.productionId);
  const analyticsIds = state.analyticsLinks
    .filter(x => x.assetId === asset.id || (asset.publishedUrl && x.url === asset.publishedUrl))
    .map(x => x.id);
  state.analyticsLinks = state.analyticsLinks.filter(x => !analyticsIds.includes(x.id));
  state.assets = state.assets.filter(x => x.id !== asset.id);
  if (acc && (acc.monthlyDone || 0) > 0) acc.monthlyDone = Math.max(0, (acc.monthlyDone || 0) - 1);
  if (prod?.delivery?.assetId === asset.id) {
    prod.delivery = null;
    prod.review = { ...(prod.review || {}), state: "pending", at: Date.now() };
    setStage(prod, "review", "pending");
    touch(prod);
  }
  save("assets", "accounts", "productions", "analyticsLinks", "meta");
  removeRemote("assets", asset.id);
  analyticsIds.forEach(id => removeRemote("analyticsLinks", id));
  notify("delivery", `「${asset.title || asset.name}」已回撤`, "发布清单记录已删除，内容已退回草稿/审核状态，原始账号素材保留");
  return true;
}

export function deliveredAssets() {
  const out = [];
  state.assets.forEach(x => {
    if (!x.delivered) return;
    const prod = state.productions.find(p => p.id === x.productionId);
    if (prod?.delivery?.assetId && prod.delivery.assetId !== x.id && !isPublishedDelivery(x)) return;
    const acc = accountById(x.accountId);
    if (acc) out.push({ asset: syncDeliveryAssetSnapshot(x), acc });
  });
  // 按发布序号（点击发布的先后）排序，最新在前
  return out.sort((a, b) => {
    const aSeq = deliveryDisplaySequence(a.asset);
    const bSeq = deliveryDisplaySequence(b.asset);
    if (aSeq && bSeq && aSeq !== bSeq) return bSeq - aSeq;
    if (aSeq !== bSeq) return bSeq ? 1 : -1;
    return Number(b.asset.deliveredAt || b.asset.createdAt || 0) - Number(a.asset.deliveredAt || a.asset.createdAt || 0);
  });
}

export function deliveryViewsSummary(platform = "all") {
  const rows = deliveredAssets().filter(({ acc }) => platform === "all" || acc.platform === platform);
  const rowsByAccount = new Map();
  rows.forEach(row => {
    const key = row.acc?.id || row.asset?.accountId || "";
    if (!rowsByAccount.has(key)) rowsByAccount.set(key, []);
    rowsByAccount.get(key).push(row);
  });
  const totalViews = [...rowsByAccount.entries()].reduce((sum, [accountId, accountRows]) => {
    const derived = accountRows.reduce((subtotal, { asset }) => subtotal + Math.max(0, Number(asset.viewCount || 0)), 0);
    return sum + derived;
  }, 0);
  return {
    totalViews,
    deliveryCount: rows.length
  };
}

export function syncDeliveryAssetSnapshot(asset) {
  if (!asset?.delivered) return asset;
  const prod = state.productions.find(p => p.id === asset.productionId);
  const acc = accountById(asset.accountId);
  if (!prod || !acc) return asset;
  asset.byAccount = asset.byAccount || acc.name;
  asset.byMemberName = publisherNameFor(asset, prod);
  asset.byMemberId = asset.byMemberId || prod.ownerId || null;
  if (prod.delivery?.assetId && prod.delivery.assetId === asset.id) {
    Object.assign(asset, deliverySnapshotFromProduction(prod, acc, asset.productTag || productTagFor(prod)));
    asset.byAccount = acc.name;
    asset.byMemberName = publisherNameFor(asset, prod);
    asset.sourceUpdatedAt = prod.updatedAt || asset.sourceUpdatedAt || asset.deliveredAt || asset.createdAt;
  }
  return asset;
}

function safeName(str, fallback = "未命名") {
  return String(str || fallback).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || fallback;
}

function encText(text) {
  const enc = new TextEncoder();
  return enc.encode(String(text || ""));
}

async function remoteFileU8(url, { deliveryId = "", label = "视频成片" } = {}) {
  if (!url) throw new Error(`${label}缺少可下载的媒体地址`);
  try {
    let requestUrl = String(url);
    const sameOrigin = requestUrl.startsWith("/") || requestUrl.startsWith(location.origin);
    if (sameOrigin && deliveryId) {
      const scoped = new URL(requestUrl, location.origin);
      scoped.searchParams.set("deliveryId", String(deliveryId));
      requestUrl = requestUrl.startsWith("http://") || requestUrl.startsWith("https://")
        ? scoped.href
        : `${scoped.pathname}${scoped.search}${scoped.hash}`;
    }
    const res = sameOrigin
      ? await fetch(requestUrl, {
          credentials: "same-origin",
          headers: remote.getToken() ? { Authorization: `Bearer ${remote.getToken()}` } : {},
        })
      : await fetch("/api/proxy/file", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(remote.getToken() ? { Authorization: `Bearer ${remote.getToken()}` } : {})
          },
          body: JSON.stringify({ url })
        });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = typeof body.detail === "string" ? body.detail : body.detail?.message;
      throw new Error(detail || body.error || `HTTP ${res.status}`);
    }
    const ct = res.headers.get("content-type") || "video/mp4";
    const ext = /webm/.test(ct) ? "webm" : /quicktime|mov/.test(ct) ? "mov" : "mp4";
    return { u8: new Uint8Array(await res.arrayBuffer()), ext };
  } catch (e) {
    if (String(e?.message || "").startsWith(`${label}下载失败`)) throw e;
    throw new Error(`${label}下载失败：${e?.message || "网络异常"}`);
  }
}

/* 供应商只能经由自己可见的具体交付读取私有媒体。缩略图和预览与 ZIP 下载
   使用同一条 delivery-linked 授权链路；创作端与外部公开地址保持原样。 */
export function deliveryScopedMediaUrl(url, deliveryId, role = state.role) {
  const raw = String(url || "").trim();
  const did = String(deliveryId || "").trim();
  if (!raw || !did || !SUPPLIER_ROLES.has(String(role || ""))) return raw;
  try {
    const origin = String(globalThis.location?.origin || "http://local.invalid");
    const scoped = new URL(raw, origin);
    const sameOrigin = scoped.origin === origin;
    const deliveryLinkedPath = scoped.pathname.startsWith("/api/files/")
      || scoped.pathname.startsWith("/api/video/composed/")
      || scoped.pathname.startsWith("/custom-video/outputs/");
    if (!sameOrigin || !deliveryLinkedPath) return raw;
    scoped.searchParams.set("deliveryId", did);
    return /^https?:\/\//i.test(raw)
      ? scoped.href
      : `${scoped.pathname}${scoped.search}${scoped.hash}`;
  } catch (_) {
    return raw;
  }
}

export async function deliveryEntries(asset, folder = "") {
  asset = syncDeliveryAssetSnapshot(asset);
  const base = folder ? safeName(folder) + "/" : "";
  const entries = [];
  const manifest = [
    `素材名：${asset.name || ""}`,
    asset.productTag ? `产品标签：${asset.productTag}` : "",
    asset.byAccount ? `内容账号：${asset.byAccount}` : "",
    asset.byMemberName ? `发布人：${asset.byMemberName}` : "",
    `标题：${asset.title || ""}`,
    `形式：${asset.type || ""}`,
    asset.planDate ? `计划发布：${asset.planDate}` : "",
    asset.publishNote ? `备注：${asset.publishNote}` : "",
    asset.supplierNote ? `供应商回传备注：${asset.supplierNote}` : "",
    asset.publishedUrl ? `发布链接：${asset.publishedUrl}` : "",
    "", "--- 发布文案 ---", asset.copy || ""
  ].filter(x => x != null).join("\n");
  entries.push({ name: `${base}标题文案.txt`, u8: encText(manifest) });
  if (asset.coverAssetId) {
    const d = await assetU8(asset.coverAssetId, {
      deliveryId: asset.id,
      required: true,
      label: "封面图",
    });
    entries.push({ name: `${base}封面图.${d.ext}`, u8: d.u8 });
  }
  if (asset.type === "图集" && (asset.packAssetIds || []).length) {
    for (let i = 0; i < asset.packAssetIds.length; i++) {
      const d = await assetU8(asset.packAssetIds[i], {
        deliveryId: asset.id,
        required: true,
        label: `第 ${i + 1} 张图片`,
      });
      entries.push({ name: `${base}图片/${String(i + 1).padStart(2, "0")}.${d.ext}`, u8: d.u8 });
    }
  } else if (asset.type === "图集") {
    throw new Error("图文交付缺少图片清单，已停止生成不完整 ZIP");
  } else {
    const prod = state.productions.find(p => p.id === asset.productionId);
    const finalUrl = asset.videoUrl || prod?.artifacts?.finalVideoUrl || "";
    if (!finalUrl) throw new Error("视频交付缺少完整成片，已停止生成不完整 ZIP");
    const d = await remoteFileU8(finalUrl, {
      deliveryId: asset.id,
      label: "视频成片",
    });
    entries.push({ name: `${base}视频/01.${d.ext}`, u8: d.u8 });
    entries.push({ name: `${base}视频下载链接.txt`, u8: encText(`1. ${finalUrl}`) });
  }
  return entries;
}

/* 下载交付物：图集/视频均打包为 zip；任一必备媒体缺失就显式失败。 */
export async function downloadDelivery(asset, { markDownloaded = true } = {}) {
  asset = syncDeliveryAssetSnapshot(asset);
  const entries = await deliveryEntries(asset);
  downloadBlob(`${safeName(asset.name)}.zip`, buildZipBlob(entries));
  if (markDownloaded && SUPPLIER_ROLES.has(state.role)) {
    if (remote.isOn()) {
      try {
        const result = await markSupplierDownloadedWithRetry(asset.id);
        Object.assign(asset, result?.asset || {});
      } catch (err) {
        window.__toast?.(`文件已下载，但供应商下载状态同步失败：${err?.message || err}`, "error");
      }
    } else {
      asset.supplierDownloadedAt = Date.now();
      asset.supplierDownloadedBy = state.ui.currentMemberId || "";
      if (!asset.publishedUrl && asset.status !== "已发布") asset.status = "已下载";
      save("assets");
    }
  }
}

export async function batchDownload(assets) {
  return batchDownloadZip(assets);
}

export async function batchDownloadZip(assets, filename = "", { markDownloaded = true } = {}) {
  const list = (assets || []).filter(Boolean);
  const entries = [];
  for (let i = 0; i < list.length; i++) {
    const a = syncDeliveryAssetSnapshot(list[i]);
    const folder = `${String(i + 1).padStart(3, "0")}_${safeName(a.name || a.title)}`;
    entries.push(...await deliveryEntries(a, folder));
  }
  if (!entries.length) return 0;
  downloadBlob(filename || `供应商待下载素材_${Date.now()}.zip`, buildZipBlob(entries));
  if (markDownloaded && SUPPLIER_ROLES.has(state.role)) {
    if (remote.isOn()) {
      const results = await Promise.allSettled(list.map(a => markSupplierDownloadedWithRetry(a.id)));
      results.forEach((result, index) => {
        if (result.status === "fulfilled") Object.assign(list[index], result.value?.asset || {});
      });
      const failed = results.filter(result => result.status === "rejected").length;
      if (failed) window.__toast?.(`文件已下载，但有 ${failed} 条供应商下载状态同步失败`, "error");
    } else {
      const now = Date.now();
      list.forEach(a => {
        a.supplierDownloadedAt = now;
        a.supplierDownloadedBy = state.ui.currentMemberId || "";
        if (!a.publishedUrl && a.status !== "已发布") a.status = "已下载";
      });
      save("assets");
    }
  }
  return list.length;
}

/* 单个普通资产下载 */
export async function downloadAsset(a) {
  if (a.delivered) {
    const supplierDownload = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
    return downloadDelivery(a, { markDownloaded: supplierDownload });
  }
  const d = await assetU8(a.id);
  if (d) { downloadBlob(`${a.name}.${d.ext}`, new Blob([d.u8])); return; }
  const u = urlFor(a);
  if (u && u.startsWith("data:")) {
    const link = document.createElement("a");
    link.href = u; link.download = a.name; link.click();
  } else {
    window.__toast && window.__toast("该素材是占位示例，没有可下载的文件");
  }
}
