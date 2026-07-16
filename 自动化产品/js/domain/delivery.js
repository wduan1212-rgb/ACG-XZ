/* 发布清单：定稿入库（创作端） + 素材分发（供应商端）
   交付 = 内部定稿归档，产物进入交付库供供应商下载，不涉及任何平台发布 */

import { state, save, persistNow, notify, accountById, assetById, canDeliver, currentMember, productById, pullRemote, removeRemote } from "../core/store.js";
import { uid, esc, buildZipBlob, downloadBlob } from "../core/util.js";
import { buildDeliveryName, modeLabel } from "./accounts.js";
import { setStage, touch } from "./productions.js";
import { assetU8, urlFor } from "./assets.js";
import * as remote from "../core/remote.js";

const SUPPLIER_ROLES = new Set(["supplier", "supplier_parent", "supplier_child"]);

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
  return asset?.byMemberName || memberNameById(asset?.byMemberId) || memberNameById(prod?.ownerId) || "";
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

function isPublishedDelivery(asset) {
  return !!asset?.publishedUrl || asset?.status === "已发布";
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
export function deliver(p, opts = {}) {
  const acc = accountById(p.accountId);
  if (!acc) return null;
  if (!canDeliver()) { window.__toast && window.__toast("当前账号没有发布权限"); return null; }
  const planDate = normalizePlanDate(opts.planDate);
  const productTag = String(opts.productTag || "").trim().slice(0, 20);
  if (!productTag) { window.__toast && window.__toast("请在发布弹窗填写产品标签", "error"); return null; }
  p.review.state = "approved";   // 创作者点击发布即定稿
  const replaced = purgeOpenDeliveryAssetsForProduction(p);
  if (replaced && (acc.monthlyDone || 0) > 0) acc.monthlyDone = Math.max(0, (acc.monthlyDone || 0) - replaced);
  acc.exportSeq = (acc.exportSeq || 0) + 1;
  const name = insertProductTagBeforeDate(buildDeliveryName(acc, acc.exportSeq), productTag);
  const mem = currentMember();
  const publisherName = mem?.name || memberNameById(p.ownerId);
  const pubSeq = (state.ui.deliverSeq = (state.ui.deliverSeq || 0) + 1);
  const snapshot = deliverySnapshotFromProduction(p, acc, productTag);

  const asset = {
    id: uid(), accountId: acc.id, name,
    ...snapshot,
    createdAt: Date.now(), delivered: true, status: "未下载",
    productionId: p.id,
    pubSeq, deliveredAt: Date.now(),
    sourceCreatedAt: p.createdAt || Date.now(),      // 创作端建立该任务的时间
    byAccount: acc.name,                          // 发布所属内容账号
    byMemberId: mem?.id || p.ownerId || null,
    byMemberName: publisherName || "",            // 谁点的发布
    sourceUpdatedAt: p.updatedAt || Date.now(),
    planDate,                                     // 计划发布日期（必填，默认今天）
    publishNote: opts.note || "",                 // 简短备注（可选）
    adminReviewed: false                          // 管理员「已审阅」标注（非强制门槛）
  };
  if (snapshot.type === "图集") markPackImagesShared(p, productTag);
  else markDeliveryCoverShared(snapshot.coverAssetId, {
    productionId: p.id,
    productId: snapshot.productId,
    productTag,
    title: snapshot.title,
    source: "delivered-production-video"
  });
  state.assets.push(asset);
  acc.monthlyDone = (acc.monthlyDone || 0) + 1;
  p.delivery = { assetId: asset.id, name, at: Date.now(), pubSeq, planDate: asset.planDate, productTag, note: asset.publishNote, sourceUpdatedAt: asset.sourceUpdatedAt };
  p.review.at = Date.now();
  touch(p);
  setStage(p, "delivered", "done");
  save("assets", "accounts", "productions", "analyticsLinks", "meta");
  persistNow();
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
  return out.sort((a, b) => (b.asset.pubSeq || b.asset.createdAt || 0) - (a.asset.pubSeq || a.asset.createdAt || 0));
}

export function deliveryViewsSummary(platform = "all") {
  const rows = deliveredAssets().filter(({ acc }) => platform === "all" || acc.platform === platform);
  return {
    totalViews: rows.reduce((sum, { asset }) => sum + Math.max(0, Number(asset.viewCount || 0)), 0),
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

async function remoteFileU8(url) {
  if (!url) return null;
  try {
    const sameOrigin = String(url).startsWith("/") || String(url).startsWith(location.origin);
    const res = sameOrigin
      ? await fetch(url, { credentials: "same-origin" })
      : await fetch("/api/proxy/file", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(remote.getToken() ? { Authorization: `Bearer ${remote.getToken()}` } : {})
          },
          body: JSON.stringify({ url })
        });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "video/mp4";
    const ext = /webm/.test(ct) ? "webm" : /quicktime|mov/.test(ct) ? "mov" : "mp4";
    return { u8: new Uint8Array(await res.arrayBuffer()), ext };
  } catch (e) {
    return null;
  }
}

async function deliveryEntries(asset, folder = "") {
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
    const d = await assetU8(asset.coverAssetId);
    if (d) entries.push({ name: `${base}封面图.${d.ext}`, u8: d.u8 });
  }
  if (asset.type === "图集" && (asset.packAssetIds || []).length) {
    for (let i = 0; i < asset.packAssetIds.length; i++) {
      const d = await assetU8(asset.packAssetIds[i]);
      if (d) entries.push({ name: `${base}图片/${String(i + 1).padStart(2, "0")}.${d.ext}`, u8: d.u8 });
    }
  } else {
    const prod = state.productions.find(p => p.id === asset.productionId);
    const timelineUrls = (prod?.artifacts?.timeline || [])
      .map(x => state.jobs.find(j => j.id === x.jobId)?.output?.url)
      .filter(Boolean);
    const finalUrl = asset.videoUrl || prod?.artifacts?.finalVideoUrl || "";
    const urls = finalUrl
      ? [finalUrl]
      : [...new Set([...(asset.clipUrls || []), ...timelineUrls].filter(Boolean))];
    let got = 0;
    for (let i = 0; i < urls.length; i++) {
      const d = await remoteFileU8(urls[i]);
      if (d) {
        got++;
        entries.push({ name: `${base}视频/${String(i + 1).padStart(2, "0")}.${d.ext}`, u8: d.u8 });
      }
    }
    if (urls.length) {
      entries.push({ name: `${base}视频下载链接.txt`, u8: encText(urls.map((u, i) => `${i + 1}. ${u}`).join("\n")) });
    }
    if (!got && !urls.length) {
      entries.push({ name: `${base}视频说明.txt`, u8: encText(`当前交付记录还没有真实视频回链。\n构成：${asset.clips || 0} 段成片拼接${asset.subCount ? ` · ${asset.subCount} 条字幕` : ""}`) });
    }
  }
  return entries;
}

/* 下载交付物：图集/视频均打包为 zip（视频尽量拉取真实 mp4，失败时保留下载链接） */
export async function downloadDelivery(asset, { markDownloaded = true } = {}) {
  asset = syncDeliveryAssetSnapshot(asset);
  const entries = await deliveryEntries(asset);
  downloadBlob(`${safeName(asset.name)}.zip`, buildZipBlob(entries));
  if (markDownloaded && SUPPLIER_ROLES.has(state.role)) {
    if (remote.isOn()) {
      try {
        const result = await remote.supplier.markDownloaded(asset.id);
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
      const results = await Promise.allSettled(list.map(a => remote.supplier.markDownloaded(a.id)));
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
