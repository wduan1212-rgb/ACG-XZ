/* 发布清单：定稿入库（创作端） + 素材分发（供应商端）
   交付 = 内部定稿归档，产物进入交付库供供应商下载，不涉及任何平台发布 */

import { state, save, notify, accountById, assetById, canDeliver, currentMember, productById } from "../core/store.js";
import { uid, esc, buildZipBlob, downloadBlob } from "../core/util.js";
import { buildDeliveryName, modeLabel } from "./accounts.js";
import { setStage, touch } from "./productions.js";
import { assetU8, urlFor } from "./assets.js";

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

/* 发布交付：创作者自行定稿入库（无强制审核门槛），分配全局发布序号 + 记录发布账号/成员
   交付 = 内部定稿归档，产物进入交付库供供应商下载，不涉及任何平台发布 */
export function deliver(p, opts = {}) {
  const acc = accountById(p.accountId);
  if (!acc) return null;
  if (!canDeliver()) { window.__toast && window.__toast("当前账号没有发布权限"); return null; }
  const planDate = normalizePlanDate(opts.planDate);
  p.review.state = "approved";   // 创作者点击发布即定稿
  acc.exportSeq = (acc.exportSeq || 0) + 1;
  const productTag = productTagFor(p);
  const name = insertProductTagBeforeDate(buildDeliveryName(acc, acc.exportSeq), productTag);
  const isImg = p.mode === "图文";
  const imgItems = (p.artifacts.images.items || []).filter(x => x.assetId);
  const withSub = (p.artifacts.subs || []).some(s => (s.text || "").trim());
  const mem = currentMember();
  const pubSeq = (state.ui.deliverSeq = (state.ui.deliverSeq || 0) + 1);

  const asset = {
    id: uid(), accountId: acc.id, name,
    type: isImg ? "图集" : "视频",
    tags: ["成片", acc.mode, acc.platform, ...(productTag ? [productTag] : []), ...(isImg ? [`${imgItems.length}张组图`] : withSub ? ["带字幕"] : [])],
    createdAt: Date.now(), delivered: true, status: "未下载",
    title: p.artifacts.copy.title || p.title, copy: p.artifacts.copy.body || "",
    productionId: p.id,
    packAssetIds: isImg ? imgItems.map(x => x.assetId) : [],
    videoUrl: isImg ? "" : (p.artifacts.finalVideoUrl || ""),
    clipJobIds: isImg ? [] : (p.artifacts.timeline || []).map(x => x.jobId).filter(Boolean),
    clipUrls: isImg ? [] : (p.artifacts.timeline || []).map(x => state.jobs.find(j => j.id === x.jobId)?.output?.url).filter(Boolean),
    clips: isImg ? 0 : (p.artifacts.timeline || []).length,
    subCount: (p.artifacts.subs || []).filter(s => (s.text || "").trim()).length,
    pubSeq, deliveredAt: Date.now(),
    productId: p.artifacts?.script?.productId || "dumate",
    productTag,
    byAccount: acc.name,                          // 发布所属内容账号
    byMemberId: mem?.id || p.ownerId || null,
    byMemberName: mem?.name || "",                // 谁点的发布
    planDate,                                     // 计划发布日期（必填，默认今天）
    publishNote: opts.note || "",                 // 简短备注（可选）
    adminReviewed: false                          // 管理员「已审阅」标注（非强制门槛）
  };
  state.assets.push(asset);
  acc.monthlyDone = (acc.monthlyDone || 0) + 1;
  p.delivery = { assetId: asset.id, name, at: Date.now(), pubSeq, planDate: asset.planDate, note: asset.publishNote };
  p.review.at = Date.now();
  touch(p);
  setStage(p, "delivered", "done");
  save("assets", "accounts", "productions", "meta");
  notify("delivery", `「${asset.title || name}」已发布`, `#${String(pubSeq).padStart(3, "0")} · ${name}${isImg ? ".zip" : ".mp4"} · 供应商端可见`);
  return asset;
}

/* 管理员在发布清单标注/取消「已审阅」（仅记号，不阻断任何流程） */
export function toggleAdminReviewed(asset) {
  asset.adminReviewed = !asset.adminReviewed;
  asset.reviewedBy = asset.adminReviewed ? (currentMember()?.name || "管理员") : "";
  asset.reviewedAt = asset.adminReviewed ? Date.now() : null;
  save("assets");
  return asset.adminReviewed;
}

export function deliveredAssets() {
  const out = [];
  state.assets.forEach(x => {
    if (!x.delivered) return;
    const acc = accountById(x.accountId);
    if (acc) out.push({ asset: x, acc });
  });
  // 按发布序号（点击发布的先后）排序，最新在前
  return out.sort((a, b) => (b.asset.pubSeq || b.asset.createdAt || 0) - (a.asset.pubSeq || a.asset.createdAt || 0));
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
    const res = await fetch("/api/proxy/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  const base = folder ? safeName(folder) + "/" : "";
  const entries = [];
  const manifest = [
    `素材名：${asset.name || ""}`,
    asset.productTag ? `产品标签：${asset.productTag}` : "",
    `标题：${asset.title || ""}`,
    `形式：${asset.type || ""}`,
    asset.planDate ? `计划发布：${asset.planDate}` : "",
    asset.publishNote ? `备注：${asset.publishNote}` : "",
    "", "--- 发布文案 ---", asset.copy || ""
  ].filter(x => x != null).join("\n");
  entries.push({ name: `${base}标题文案.txt`, u8: encText(manifest) });
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
export async function downloadDelivery(asset) {
  const entries = await deliveryEntries(asset);
  downloadBlob(`${safeName(asset.name)}.zip`, buildZipBlob(entries));
  asset.status = "已下载";
  save("assets");
}

export async function batchDownload(assets) {
  return batchDownloadZip(assets);
}

export async function batchDownloadZip(assets, filename = "") {
  const list = (assets || []).filter(Boolean);
  const entries = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const folder = `${String(i + 1).padStart(3, "0")}_${safeName(a.name || a.title)}`;
    entries.push(...await deliveryEntries(a, folder));
    a.status = "已下载";
  }
  if (!entries.length) return 0;
  downloadBlob(filename || `供应商待下载素材_${Date.now()}.zip`, buildZipBlob(entries));
  save("assets");
  return list.length;
}

/* 单个普通资产下载 */
export async function downloadAsset(a) {
  if (a.delivered) return downloadDelivery(a);
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
