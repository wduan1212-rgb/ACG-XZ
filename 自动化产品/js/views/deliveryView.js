/* 发布清单：创作端全景（含明细 + 发布回链）+ 供应商视角（下载 / 回传发布链接）
   供应商回传小红书/视频号链接 → 素材标记「已发布」，链路闭环 */

import { $, $$, esc, gradFor, timeAgo } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, notify, accountById, productionById, canMarkReviewed, productById, currentMember, refreshDeliveryMetrics } from "../core/store.js";
import { accountDisplaySequenceMap, platChip } from "../domain/accounts.js";
import { canDeleteDelivery, canSeeDeliveryRetract, deleteDeliveryAsset, deliveredAssets, deliveryRetractBlockReason, downloadDelivery, batchDownloadZip, toggleAdminReviewed, productTagLabel, supplierHasDownloaded, supplierHasPublished, matchesDeliveryStatusFilters, deliveryDisplaySequence, deliverySubmittedAt, parseSupplierViewCount, supplierViewCountPromptValue, applySupplierReturnResponse, supplierReturnRowState, deliveryScopedMediaUrl } from "../domain/delivery.js?v=20260812-v1426-supplier-avatar-copy-limit-1";
import { urlFor } from "../domain/assets.js";
import { ensureAnalyticsForAsset } from "../domain/analytics.js?v=20260727-v118-7";
import { openProductionDrawer } from "./prodDrawer.js?v=20260812-v1426-supplier-avatar-copy-limit-1";
import { confirmModal, emptyState, toast, openLightbox, supplierReturnModal, promptModal, openModal } from "../ui/components.js?v=20260812-v1426-supplier-avatar-copy-limit-1";
import { copyText } from "../core/util.js";
import * as remote from "../core/remote.js";
import { openCommunityShare, syncCommunityShareStatus } from "./communityShare.js";

function extractUrl(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s"'<>，。；、）】]+/g) || [];
  return matches.length ? matches[matches.length - 1].trim() : "";
}

function extractShareTitle(text) {
  const body = (String(text || "").match(/【([^】]+)】/) || [])[1] || "";
  if (!body) return "";
  const beforeSource = body.split(/\s*[|｜]\s*小红书/)[0] || body;
  return beforeSource.split(/\s+-\s+/)[0].replace(/^\d+\s*/, "").trim();
}

function dateOnly(value = "") {
  const raw = String(value || "").trim();
  const m = raw.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
  return m ? m[0].replace(/\//g, "-") : raw;
}

function dateFromTime(value) {
  const time = Number(value || 0);
  if (!time) return "";
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateTimeFromTime(value) {
  const time = Number(value || 0);
  if (!time) return "";
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

let collapsedDays = new Set();

function deliveryTime(asset) {
  return Number(asset.deliveredAt || asset.createdAt || 0);
}

function dayKey(asset) {
  const d = new Date(deliveryTime(asset) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function dayLabel(key) {
  const today = dayKey({ deliveredAt: Date.now() });
  const yesterday = dayKey({ deliveredAt: Date.now() - 86400000 });
  if (key === today) return "今天";
  if (key === yesterday) return "昨天";
  return key.replace(/-/g, "/");
}

function displaySeqMap(all) {
  const map = new Map();
  [...all]
    .sort((a, b) => deliveryTime(a.asset) - deliveryTime(b.asset))
    .forEach((x, i) => map.set(x.asset.id, i + 1));
  // 以交付记录自带的全局序号覆盖角色可见子集的本地排名。
  // 子账号未分配到其他素材时，序号允许不连续，但同一素材始终一致。
  all.forEach(x => map.set(x.asset.id, deliveryDisplaySequence(x.asset, map.get(x.asset.id))));
  return map;
}

function seqText(seq) {
  return seq ? `#${String(seq).padStart(3, "0")}` : "";
}

function publisherLabel(asset) {
  const production = productionById(asset?.productionId);
  const memberId = asset?.byMemberId || production?.ownerId || "";
  return state.members.find(member => member.id === memberId)?.name || asset?.byMemberName || "未记录";
}

function supplierReturnTime(asset) {
  return dateTimeFromTime(asset?.publishedUpdatedAt || asset?.publishedAt || 0);
}

function creationDay(asset) {
  return dateFromTime(productionById(asset?.productionId)?.createdAt || asset?.sourceCreatedAt || asset?.createdAt);
}

function supplierReturnDay(asset) {
  return dateFromTime(asset?.publishedUpdatedAt || asset?.publishedAt || 0);
}

function matchesDateRange(day, start, end) {
  if (!start && !end) return true;
  if (!day) return false;
  return (!start || day >= start) && (!end || day <= end);
}

function sortDelivered(all) {
  return [...all].sort((a, b) => deliveryTime(b.asset) - deliveryTime(a.asset));
}

function remarkReadAt(asset) {
  return Number(asset?.remarkReadAt?.[state.ui.currentMemberId || ""] || 0);
}

function hasUnreadRemark(asset) {
  return Number(asset?.latestRemarkAt || 0) > remarkReadAt(asset);
}

function remarkDot(asset) {
  return hasUnreadRemark(asset) ? `<i class="delivery-remark-dot" title="有未读备注"></i>` : "";
}

function deliveryMedia(asset) {
  if (asset?.type === "图集") {
    return (asset.packAssetIds || []).map(id => {
      const item = state.assets.find(entry => entry.id === id);
      const url = deliveryScopedMediaUrl(item ? urlFor(item) : urlFor(id), asset.id);
      return {
        type: "image",
        url: url || "",
        title: item?.name || asset.title || asset.name || "发布图片",
      };
    });
  }
  const url = deliveryScopedMediaUrl(
    urlFor(asset) || asset?.videoUrl || asset?.fileUrl || asset?.url || "",
    asset.id,
  );
  return url ? [{ type: "video", url, title: asset.title || asset.name || "发布视频" }] : [];
}

function bindDeliveryMediaFallback(scope) {
  scope?.querySelectorAll?.("img[data-delivery-media],video[data-delivery-media]").forEach(media => {
    if (media.dataset.deliveryMediaBound === "1") return;
    media.dataset.deliveryMediaBound = "1";
    const showUnavailable = () => {
      const frame = media.closest("[data-delivery-media-frame]");
      if (!frame) return;
      frame.classList.add("is-media-unavailable");
      const status = frame.querySelector("[data-delivery-media-error]");
      if (status) status.hidden = false;
      media.hidden = true;
      if (frame instanceof HTMLButtonElement) frame.disabled = true;
    };
    media.addEventListener("error", showUnavailable, { once: true });
    if (media instanceof HTMLImageElement && media.complete && media.naturalWidth === 0) {
      showUnavailable();
    }
  });
}

function deliveryCover(asset) {
  const coverId = asset?.coverAssetId || (asset?.type === "图集" ? (asset.packAssetIds || [])[0] : "");
  if (!coverId) return null;
  const item = state.assets.find(entry => entry.id === coverId);
  const url = deliveryScopedMediaUrl(item ? urlFor(item) : urlFor(coverId), asset.id);
  return url ? {
    type: "image",
    url,
    width: Number(item?.width || 0) || 0,
    height: Number(item?.height || 0) || 0,
    title: item?.name || asset?.title || asset?.name || "发布封面",
  } : null;
}

function deliveryCommunitySource(asset) {
  const sourceItemIds = [...new Set((Array.isArray(asset?.sourceItemIds) ? asset.sourceItemIds : [])
    .map(item => String(item || "").trim())
    .filter(Boolean))].slice(0, 20);
  return {
    sourceProjectId: String(asset?.customProjectId || "").trim(),
    sourceOutputId: String(asset?.sourceOutputId || "").trim(),
    sourceItemIds,
  };
}

function openDeliveryPreview(asset) {
  const media = deliveryMedia(asset);
  const cover = deliveryCover(asset);
  if (!media.length) { toast("当前成果还没有可预览的媒体文件", "error"); return; }
  openModal(`<article class="delivery-preview-dialog">
    <header><div><span>${asset.type === "图集" ? `${media.length} 张图片` : "视频预览"}</span><h2>${esc(asset.title || asset.name || "发布内容")}</h2></div><button class="icon-btn" data-close>${icon("x", 16)}</button></header>
    <div class="delivery-preview-media ${asset.type === "图集" ? "is-gallery" : "is-video"}">${media.map((item, index) => item.type === "video"
      ? `<div class="delivery-preview-video-frame" data-delivery-media-frame><video src="${esc(item.url)}" ${cover?.url ? `poster="${esc(cover.url)}"` : ""} controls playsinline preload="metadata" data-delivery-media></video><em data-delivery-media-error hidden>视频暂时无法读取，请刷新后重试</em></div>`
      : `<button type="button" data-delivery-preview-image="${index}" data-delivery-media-frame ${item.url ? "" : "disabled class=\"is-media-unavailable\""}>${item.url ? `<img src="${esc(item.url)}" alt="${esc(item.title)}" loading="lazy" decoding="async" data-delivery-media />` : ""}<em data-delivery-media-error ${item.url ? "hidden" : ""}>图片暂时无法读取</em><span>${index + 1}</span></button>`).join("")}</div>
    ${asset.copy ? `<div class="delivery-preview-copy"><b>发布文案</b><pre>${esc(asset.copy)}</pre></div>` : ""}
  </article>`, {
    onMount(panel) {
      panel.classList.add("delivery-preview-panel");
      bindDeliveryMediaFallback(panel);
      panel.querySelectorAll("[data-delivery-preview-image]").forEach((button, index) => button.addEventListener("click", () => {
        const img = button.querySelector("img");
        if (img && !img.hidden) openLightbox(img, media[index]?.url || img.src, media[index]?.title || "发布图片");
      }));
    },
  });
}

export async function openDeliveryRemarks(asset) {
  if (!asset) return;
  openModal(`<div class="mp-head delivery-chat-head"><div><b>发布沟通</b><em>${esc(asset.title || asset.name || "发布内容")}</em></div><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
    <div class="mp-body delivery-remark-modal"><div id="deliveryRemarkTimeline" class="delivery-remark-timeline"><p class="supplier-empty">正在读取消息…</p></div><label class="delivery-remark-reply"><span>发送消息</span><textarea class="input" id="deliveryRemarkText" rows="3" maxlength="1200" placeholder="输入消息，发送后双方会在同一条时间线上看到"></textarea></label></div>
    <div class="mp-foot delivery-chat-foot"><span id="deliveryRemarkStatus" class="supplier-child-submit-status"></span><button class="btn ghost" data-close>关闭</button><button class="btn primary" id="deliveryRemarkSend">${icon("arrowRight", 13)} 发送</button></div>`, { onMount(panel) {
      const timeline = $("#deliveryRemarkTimeline", panel);
      const status = $("#deliveryRemarkStatus", panel);
      const renderTimeline = remarks => {
        timeline.innerHTML = remarks.length ? remarks.map(item => `<article class="delivery-remark-entry ${item.authorId === state.ui.currentMemberId ? "is-mine" : ""}"><span class="delivery-chat-avatar">${esc((item.authorName || "成").slice(0, 1))}</span><div><header><b>${esc(item.authorName || "成员")}</b><span>${item.authorRole === "supplier_parent" ? "供应商管理员" : item.authorRole === "supplier_child" ? "供应商子账号" : item.authorRole === "admin" ? "创作管理员" : "创作者"}</span><time>${timeAgo(item.createdAt)}</time></header><p>${esc(item.text || "").replace(/\n/g, "<br/>")}</p></div></article>`).join("") : `<p class="delivery-remark-empty">还没有消息，可以直接开始沟通。</p>`;
        timeline.scrollTop = timeline.scrollHeight;
      };
      const load = async () => {
        try {
          if (remote.isOn()) {
            const data = await remote.deliveryRemarks.list(asset.id);
            asset.remarks = data.remarks || [];
            asset.remarkReadAt = data.remarkReadAt || {};
            asset.latestRemarkAt = data.latestRemarkAt || 0;
            const readResult = await remote.deliveryRemarks.read(asset.id);
            Object.assign(asset, readResult.asset || {});
          } else {
            asset.remarks = asset.remarks || [];
            asset.remarkReadAt = asset.remarkReadAt || {};
            asset.remarkReadAt[state.ui.currentMemberId || "local"] = Math.max(Date.now(), Number(asset.latestRemarkAt || 0));
            save("assets");
          }
          renderTimeline(asset.remarks || []);
        } catch (error) {
          timeline.innerHTML = `<p class="delivery-remark-empty is-error">${esc(error?.message || "备注读取失败")}</p>`;
        }
      };
      $("#deliveryRemarkSend", panel)?.addEventListener("click", async () => {
        const button = $("#deliveryRemarkSend", panel);
        const input = $("#deliveryRemarkText", panel);
        const text = input?.value.trim() || "";
        if (!text) { status.textContent = "请先填写消息内容"; status.className = "supplier-child-submit-status is-error"; return; }
        button.disabled = true;
        status.textContent = "发送中…";
        status.className = "supplier-child-submit-status is-loading";
        try {
          if (remote.isOn()) {
            const result = await remote.deliveryRemarks.add(asset.id, text);
            Object.assign(asset, result.asset || {});
          } else {
            const now = Date.now();
            asset.remarks = [...(asset.remarks || []), { id: `local-${now}`, authorId: state.ui.currentMemberId || "local", authorName: state.members.find(x => x.id === state.ui.currentMemberId)?.name || "当前成员", authorRole: state.role, text, createdAt: now }];
            asset.latestRemarkAt = now;
            asset.remarkReadAt = { ...(asset.remarkReadAt || {}), [state.ui.currentMemberId || "local"]: now };
            save("assets");
          }
          input.value = "";
          status.textContent = "已发送";
          status.className = "supplier-child-submit-status is-success";
          renderTimeline(asset.remarks || []);
        } catch (error) {
          status.textContent = error?.message || "发送失败";
          status.className = "supplier-child-submit-status is-error";
        } finally {
          button.disabled = false;
        }
      });
      load();
    }});
}

function groupByDay(all) {
  const groups = [];
  sortDelivered(all).forEach(row => {
    const key = dayKey(row.asset);
    let g = groups.find(x => x.key === key);
    if (!g) { g = { key, items: [] }; groups.push(g); }
    g.items.push(row);
  });
  return groups;
}

function deliveredItemHtml(asset, acc, i, displaySeq) {
  const isImg = asset.type === "图集";
  const coverId = asset.coverAssetId || (isImg ? (asset.packAssetIds || [])[0] : null);
  const u = coverId ? urlFor(coverId) : null;
  const seq = seqText(displaySeq);
  const productTag = asset.productTag || productTagLabel(productById(asset.productId || ""));
  const retractReason = deliveryRetractBlockReason(asset);
  const canRetract = canDeleteDelivery(asset);
  const showRetract = canRetract || canSeeDeliveryRetract(asset);
  const plan = dateOnly(asset.planDate);
  const contentAccount = asset.byAccount || acc.name;
  const publisher = publisherLabel(asset);
  const supplierDownloaded = supplierHasDownloaded(asset);
  const supplierPublished = supplierHasPublished(asset);
  return `<div class="dv-item" style="--d:${i * 40}ms">
    <span class="dv-node${i === 0 ? " latest" : ""}"></span>
    <div class="dv-card card" data-aid="${asset.id}">
      <div class="dv-head" data-dvtoggle>
        <span class="dv-cover">${u ? `<img src="${u}"/>` : `<i style="background:${gradFor(asset.name)}">${isImg ? "图" : "▶"}</i>`}<em>${isImg ? `${(asset.packAssetIds || []).length} 张` : `${asset.clips || 0} 段`}</em></span>
        <span class="dv-main">
          <b>${seq ? `<span class="dv-seq">${seq}</span>` : ""}${esc(asset.title || asset.name)}</b>
          <span class="dv-meta">
            <span class="dv-tagline">${productTag ? `<span class="tag product" title="${esc(productTag)}">${esc(productTag)}</span>` : ""}<span class="tag pubby">发布人：${esc(publisher)}</span><span class="tag date">${icon("clock", 10)} ${esc(plan || dateOnly(asset.deliveredAt || asset.createdAt))}</span><span class="tag ${supplierDownloaded ? "supplier-downloaded" : "supplier-pending"}">${supplierDownloaded ? `${icon("checkCircle", 10)} 供应商已下载` : "供应商未下载"}</span><span class="tag ${supplierPublished ? "pub" : ""}">${supplierPublished ? `${icon("checkCircle", 10)} 已发布` : "待发布"}</span></span>
          </span>
        </span>
        <span class="dv-chev">${remarkDot(asset)}${icon("chevronDown", 14)}</span>
      </div>
      <div class="dv-detail" hidden>
        <div class="dv-detail-facts"><span>内容账号：${esc(contentAccount)}</span><span>平台：${esc(acc.platform || "平台")}</span><span>文件：${esc(asset.name)}${isImg ? ".zip" : ".mp4"}</span></div>
        ${asset.planDate || asset.publishNote ? `<div class="dv-pubmeta">${plan ? `<span>${icon("clock", 12)} 计划发布：<b>${esc(plan)}</b></span>` : ""}${asset.publishNote ? `<span>${icon("fileText", 12)} 备注：${esc(asset.publishNote)}</span>` : ""}</div>` : ""}
        ${asset.publishedUrl ? `<div class="dv-published">${icon("link", 13)} 发布链接：<a href="${esc(asset.publishedUrl)}" target="_blank" rel="noopener noreferrer">${esc(asset.publishedUrl.slice(0, 64))}${asset.publishedUrl.length > 64 ? "…" : ""}</a><em>回传时间：${esc(supplierReturnTime(asset) || "未记录")}</em></div>` : ""}
        ${asset.supplierNote ? `<div class="dv-supplier-note">${icon("fileText", 13)} 供应商备注：${esc(asset.supplierNote)}</div>` : ""}
        ${asset.copy ? `<pre class="dv-copy">${esc(asset.copy)}</pre>` : ""}
        ${isImg && (asset.packAssetIds || []).length ? `<div class="cc-grid">${asset.packAssetIds.map((id, k) => { const uu = urlFor(id); return uu ? `<div class="cc-thumb"><img src="${uu}" data-dvimg/><span>${k + 1}</span></div>` : ""; }).join("")}</div>` : ""}
        <div class="dv-actions">
          <button class="btn ghost sm" data-dvact="preview">${icon("eye", 13)} 预览${isImg ? `全部 ${Math.max(0, (asset.packAssetIds || []).length)} 张` : "视频"}</button>
          <button class="btn ghost sm" data-dvact="copy">${icon("copy", 13)} 复制标题+文案</button>
          <button class="btn ghost sm" data-dvact="download">${icon("download", 13)} 下载 zip</button>
          <button class="btn ghost sm${asset.communityPostId ? " is-shared" : ""}" data-dvact="community" ${asset.communityPostId ? "disabled" : ""}>${asset.communityPostId ? `${icon("check", 13)} 已分享` : `${icon("send", 13)} 分享灵感`}</button>
          ${asset.publishedUrl
            ? `<a class="btn ghost sm" href="${esc(asset.publishedUrl)}" target="_blank" rel="noopener noreferrer">${icon("link", 13)} 查看链接</a>`
            : `<button class="btn ghost sm" disabled>${icon("link", 13)} 供应商未回传</button>`}
          <button class="btn ghost sm delivery-remark-button" data-dvact="remarks">${icon("fileText", 13)} 查看备注${remarkDot(asset)}</button>
          ${canMarkReviewed() ? `<button class="btn ghost sm" data-dvact="review">${icon("eye", 13)} ${asset.adminReviewed ? "取消已审阅" : "标记已审阅"}</button>` : ""}
          ${showRetract ? `<button class="btn ghost sm danger-soft" ${canRetract ? `data-dvact="delete"` : "disabled"} title="${esc(retractReason || "回撤到草稿/审核状态")}">${icon("trash", 13)} ${canRetract ? "回撤删除" : "已下载不可回撤"}</button>` : ""}
          ${asset.productionId ? `<button class="btn ghost sm" data-dvact="prod">${icon("eye", 13)} 全链路回看</button>` : ""}
        </div>
      </div>
    </div>
  </div>`;
}

async function returnLinkFlow(asset, acc) {
  const ret = await supplierReturnModal({
    title: `回传发布链接 · ${asset.name}`,
    platform: acc?.platform || "平台",
    value: asset.publishedUrl || "",
    note: asset.supplierNote || ""
  });
  if (ret == null) return false;
  const clearing = !!ret.clear;
  const noPublish = !!ret.noPublish;
  const raw = ret.raw || "";
  let payload;
  if (clearing) {
    payload = { clear: true };
  } else if (noPublish) {
    payload = { noPublish: true, note: String(ret.note || "").trim().slice(0, 300) };
  } else {
    const url = extractUrl(raw);
    if (!url) { toast("没有识别到链接：请粘贴包含 http:// 或 https:// 的分享内容"); return false; }
    const shareTitle = extractShareTitle(raw);
    payload = {
      url,
      note: String(ret.note || "").trim().slice(0, 300),
      title: shareTitle || asset.publishedTitle || "",
      rawText: String(raw || "").slice(0, 500)
    };
  }
  if (remote.isOn()) {
    try {
      const result = await remote.supplier.returnLink(asset.id, payload);
      if (!applySupplierReturnResponse(asset, result)) {
        throw new Error("服务端未返回完整的回传状态，请重试");
      }
    } catch (error) {
      toast(error?.message || "发布链接回传失败", "error");
      return false;
    }
  } else {
    const now = Date.now();
    if (clearing) {
      delete asset.publishedUrl;
      delete asset.supplierNote;
      delete asset.publishedTitle;
      delete asset.publishedRawText;
      delete asset.publishedAt;
      asset.publishedClearedAt = now;
      asset.status = asset.supplierDownloadedAt ? "已下载" : "未下载";
      delete asset.publishedWithoutLink;
    } else if (noPublish) {
      asset.publishedWithoutLink = true;
      asset.supplierNote = payload.note;
      asset.publishedAt = now;
      asset.status = "已发布";
    } else {
      delete asset.publishedWithoutLink;
      asset.publishedUrl = payload.url;
      asset.supplierNote = payload.note;
      if (payload.title) asset.publishedTitle = payload.title;
      asset.publishedRawText = payload.rawText;
      asset.publishedAt = now;
      asset.status = "已发布";
      ensureAnalyticsForAsset(asset, acc);
    }
    asset.publishedUpdatedAt = now;
    asset.publishedUpdatedBy = state.ui.currentMemberId || "local";
    asset.updatedAt = now;
    save("assets");
  }
  if (clearing) {
    notify("delivery", `「${asset.title || asset.name}」已清除回传链接`, "已恢复为未回传状态，历史数据仅保留存档。");
    toast("已清除回传链接，素材恢复为未回传状态");
  } else if (noPublish) {
    notify("delivery", `「${asset.title || asset.name}」无需发布`, "供应商已确认无需对外发布，已计入发布完成。");
    toast("已标记为无需发布");
  } else {
    notify("delivery", `「${asset.title || asset.name}」已发布`, `供应商回传了发布链接，链路闭环 ✓`);
    toast("已记录发布链接，素材标记为「已发布」");
  }
  return true;
}

function supplierDetailHtml(asset, acc, accountSequence = 0) {
  const isImg = asset.type === "图集";
  const ids = isImg ? (asset.packAssetIds || []) : [];
  const title = asset.title || asset.name;
  const contentAccount = asset.byAccount || acc.name;
  const publisher = publisherLabel(asset);
  const submittedAt = dateTimeFromTime(deliverySubmittedAt(asset));
  const accountNumber = accountSequence > 0 ? `#${String(accountSequence).padStart(2, "0")}` : "未记录";
  return `<tr class="sup-detail-row" data-sup-detail="${asset.id}" hidden>
    <td colspan="10">
      <div class="sup-detail">
        <div class="sup-detail-copy">
          <b>${esc(title)}</b>
          ${asset.copy ? `<pre>${esc(asset.copy)}</pre>` : `<p>暂无文案，可从创作端补充后重新定稿。</p>`}
          <div class="sup-detail-meta">
            <span>${esc(acc.platform || "平台")}</span>
            <span>内容账号：${esc(contentAccount)}</span>
            <span>发布账号编号：${esc(accountNumber)}</span>
            <span>制作时间：${esc(submittedAt || "未记录")}</span>
            <span>回传时间：${esc(supplierReturnTime(asset) || "未回传")}</span>
            <span>发布人：${esc(publisher)}</span>
            <span>${esc(asset.productTag || productTagLabel(productById(asset.productId || "")) || "未标记产品")}</span>
            <span>${esc(dateOnly(asset.planDate) || "未计划")}</span>
            <span>${esc(asset.status || "未下载")}</span>
          </div>
          <div class="sup-detail-link-slot">
            ${asset.publishedUrl ? `<a class="btn ghost sm sup-detail-link" href="${esc(asset.publishedUrl)}" target="_blank" rel="noopener noreferrer">${icon("external", 13)} 跳转链接</a>` : ""}
          </div>
        </div>
        ${ids.length ? `<div class="sup-detail-imgs">${ids.map((id, k) => {
          const u = deliveryScopedMediaUrl(urlFor(id), asset.id);
          return `<button class="sup-thumb${u ? "" : " is-media-unavailable"}" data-supimg="${id}" data-delivery-media-frame title="预览第 ${k + 1} 张" ${u ? "" : "disabled"}>${u ? `<img src="${esc(u)}" alt="第 ${k + 1} 张" loading="lazy" decoding="async" data-delivery-media/>` : ""}<em data-delivery-media-error ${u ? "hidden" : ""}>图片暂不可用</em><span>${k + 1}</span></button>`;
        }).join("")}</div>` : `<div class="sup-detail-empty">${isImg ? "图集文件缺少预览图" : "视频素材可下载后预览"}</div>`}
      </div>
    </td>
  </tr>`;
}

const deliveryFilterDefaults = Object.freeze({
  product: "all",
  type: "all",
  publisher: "all",
  account: "all",
  date: "all",
  download: "all",
  publish: "all",
  returnedFrom: "",
  returnedTo: "",
  createdFrom: "",
  createdTo: "",
});
const deliveryFilterKeys = new Set(Object.keys(deliveryFilterDefaults));
const deliveryDateRangeKeys = new Set(["returnedFrom", "returnedTo", "createdFrom", "createdTo"]);
let supFilters = { ...deliveryFilterDefaults };
let creatorRemarkFilter = "all";
let hydratedDeliveryFilterScope = "";
let activeDeliveryController = null;
let supplierDeliveryQuery = "";
let supplierDeliveryFocusId = "";
let deliveryMetricPollTimer = 0;
const supplierAccountCollator = new Intl.Collator("zh-CN-u-co-pinyin", {
  numeric: true,
  sensitivity: "base",
});

function deliveryFilterScopeKey() {
  return `${state.role || "member"}:${state.ui.currentMemberId || currentMember()?.id || "current"}`;
}

function normalizedDeliveryFilterState(value = {}) {
  const normalized = { ...deliveryFilterDefaults };
  deliveryFilterKeys.forEach(key => {
    const candidate = String(value?.[key] ?? deliveryFilterDefaults[key]).trim();
    normalized[key] = deliveryDateRangeKeys.has(key)
      ? (/^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "")
      : (candidate || "all");
  });
  return normalized;
}

function hydrateDeliveryFilters() {
  const key = deliveryFilterScopeKey();
  if (hydratedDeliveryFilterScope === key) return;
  const saved = state.ui.deliveryFiltersByScope?.[key];
  supFilters = normalizedDeliveryFilterState(saved?.filters);
  creatorRemarkFilter = saved?.remarks === "unread" ? "unread" : "all";
  hydratedDeliveryFilterScope = key;
}

function persistDeliveryFilters() {
  const key = deliveryFilterScopeKey();
  state.ui.deliveryFiltersByScope = {
    ...(state.ui.deliveryFiltersByScope || {}),
    [key]: { filters: { ...supFilters }, remarks: creatorRemarkFilter },
  };
  save("meta");
}

if (typeof window !== "undefined") {
  window.addEventListener("xingzhen:supplier-authority-refreshed", () => {
    activeDeliveryController?.syncAuthority?.();
  });
  window.addEventListener("focus", () => {
    if (document.body.dataset.zone !== "delivery") return;
    void activeDeliveryController?.refreshMetrics?.(true);
  });
}

const filterOption = (value, label) => ({ value, label });
const withAllOption = (label, options) => [filterOption("all", label), ...options];

export function getDeliveryFilterModel() {
  hydrateDeliveryFilters();
  const all = sortDelivered(deliveredAssets());
  const isSupplierRole = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
  const canFilterPublisher = isSupplierRole || ["admin", "editor"].includes(state.role);
  const selfPublisher = isSupplierRole ? "" : String(currentMember()?.name || "").trim();
  const products = [...new Set(all
    .map(item => item.asset.productTag || productTagLabel(productById(item.asset.productId || "")))
    .filter(Boolean))];
  const publishers = [...new Set([
    ...all.map(item => publisherLabel(item.asset)),
    selfPublisher,
  ].filter(Boolean))];
  const accounts = [...new Map(all.map(item => [item.acc.id, item.acc])).values()]
    .sort((a, b) => supplierAccountCollator.compare(a.name || "", b.name || ""));
  const dates = [...new Set(all.map(item => dayKey(item.asset)))];
  const fields = [
    {
      key: "product",
      label: "产品",
      type: "select",
      value: supFilters.product,
      options: withAllOption("全部产品", products.map(value => filterOption(value, value))),
    },
    {
      key: "type",
      label: "形式",
      type: "select",
      value: supFilters.type,
      options: [filterOption("all", "全部形式"), filterOption("视频", "视频"), filterOption("图文", "图文")],
    },
    ...(canFilterPublisher ? [{
      key: "publisher",
      label: "发布人",
      type: "select",
      value: supFilters.publisher,
      options: withAllOption("全部发布人", publishers.map(value => filterOption(value, value))),
    }] : []),
    {
      key: "account",
      label: "账号",
      type: "select",
      value: supFilters.account,
      options: withAllOption("全部账号", accounts.map(account => filterOption(account.id, account.name || "未命名账号"))),
    },
    ...(!isSupplierRole ? [{
      key: "date",
      label: "时间",
      type: "select",
      value: supFilters.date,
      options: withAllOption("全部时间", dates.map(value => filterOption(value, dayLabel(value)))),
    }] : []),
    {
      key: "download",
      label: "下载",
      type: "choice",
      value: supFilters.download,
      options: [filterOption("all", "全部"), filterOption("downloaded", "已下载"), filterOption("undownloaded", "未下载")],
    },
    {
      key: "publish",
      label: "发布",
      type: "choice",
      value: supFilters.publish,
      options: [filterOption("all", "全部"), filterOption("published", "已发布"), filterOption("unpublished", "未发布")],
    },
    ...(!isSupplierRole ? [{
      key: "remarks",
      label: "备注",
      type: "choice",
      value: creatorRemarkFilter,
      options: [filterOption("all", "全部"), filterOption("unread", "最新备注")],
    }] : []),
  ];
  return {
    role: state.role || "",
    supplier: isSupplierRole,
    values: { ...supFilters, remarks: creatorRemarkFilter },
    fields,
    ranges: isSupplierRole ? [
      {
        key: "returned",
        label: "回传链接时间",
        startKey: "returnedFrom",
        endKey: "returnedTo",
        start: supFilters.returnedFrom,
        end: supFilters.returnedTo,
      },
      {
        key: "created",
        label: "创作时间",
        startKey: "createdFrom",
        endKey: "createdTo",
        start: supFilters.createdFrom,
        end: supFilters.createdTo,
      },
    ] : [],
  };
}

function emitDeliveryFilterModel() {
  if (typeof window === "undefined" || typeof window.CustomEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("xingzhen:delivery-filter-model", {
    detail: getDeliveryFilterModel(),
  }));
}

export function setDeliveryFilter(key, value, { toggle = false, redraw = true } = {}) {
  const normalizedKey = String(key || "").trim();
  const normalizedValue = deliveryDateRangeKeys.has(normalizedKey)
    ? String(value || "").trim()
    : (String(value || "all").trim() || "all");
  if (normalizedKey === "remarks") {
    if (!["all", "unread"].includes(normalizedValue)) return getDeliveryFilterModel();
    creatorRemarkFilter = toggle && creatorRemarkFilter === normalizedValue ? "all" : normalizedValue;
  } else {
    if (!deliveryFilterKeys.has(normalizedKey)) return getDeliveryFilterModel();
    if (deliveryDateRangeKeys.has(normalizedKey) && normalizedValue && !/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) return getDeliveryFilterModel();
    if (normalizedKey === "type" && !["all", "视频", "图文"].includes(normalizedValue)) return getDeliveryFilterModel();
    if (normalizedKey === "download" && !["all", "downloaded", "undownloaded"].includes(normalizedValue)) return getDeliveryFilterModel();
    if (normalizedKey === "publish" && !["all", "published", "unpublished"].includes(normalizedValue)) return getDeliveryFilterModel();
    supFilters[normalizedKey] = toggle && supFilters[normalizedKey] === normalizedValue ? "all" : normalizedValue;
  }
  persistDeliveryFilters();
  if (redraw && activeDeliveryController?.draw) activeDeliveryController.draw();
  emitDeliveryFilterModel();
  return getDeliveryFilterModel();
}

export function resetDeliveryFilters({ redraw = true } = {}) {
  supFilters = { ...deliveryFilterDefaults };
  creatorRemarkFilter = "all";
  persistDeliveryFilters();
  if (redraw && activeDeliveryController?.draw) activeDeliveryController.draw();
  emitDeliveryFilterModel();
  return getDeliveryFilterModel();
}

export function setSupplierDeliveryQuery(value, { redraw = true } = {}) {
  supplierDeliveryQuery = String(value || "").trim().toLowerCase();
  if (redraw && activeDeliveryController?.draw) activeDeliveryController.draw();
  return supplierDeliveryQuery;
}

export function focusSupplierDeliveryAsset(assetId, { redraw = true } = {}) {
  supplierDeliveryFocusId = String(assetId || "");
  if (redraw && activeDeliveryController?.draw) activeDeliveryController.draw();
  return supplierDeliveryFocusId;
}

export async function batchDownloadSupplierDelivery() {
  return activeDeliveryController?.batchDl?.();
}

function deliveryStatusFiltersHtml(scope) {
  return `<div class="delivery-status-filters" aria-label="交付状态筛选" title="下载状态与发布状态可组合筛选；再次点击当前标签可取消">
    <span class="delivery-status-group" role="group" aria-label="下载状态">
      <em class="delivery-status-caption">下载</em>
      <button class="delivery-status-chip ${supFilters.download === "downloaded" ? "on" : ""}" type="button" data-${scope}-status="download" data-status-value="downloaded" aria-pressed="${supFilters.download === "downloaded"}">已下载</button>
      <button class="delivery-status-chip ${supFilters.download === "undownloaded" ? "on" : ""}" type="button" data-${scope}-status="download" data-status-value="undownloaded" aria-pressed="${supFilters.download === "undownloaded"}">未下载</button>
    </span>
    <i class="delivery-status-divider" aria-hidden="true"></i>
    <span class="delivery-status-group" role="group" aria-label="发布状态">
      <em class="delivery-status-caption">发布</em>
      <button class="delivery-status-chip ${supFilters.publish === "published" ? "on" : ""}" type="button" data-${scope}-status="publish" data-status-value="published" aria-pressed="${supFilters.publish === "published"}">已发布</button>
      <button class="delivery-status-chip ${supFilters.publish === "unpublished" ? "on" : ""}" type="button" data-${scope}-status="publish" data-status-value="unpublished" aria-pressed="${supFilters.publish === "unpublished"}">未发布</button>
    </span>
  </div>`;
}

export const deliveryView = {
  getFilterModel: getDeliveryFilterModel,
  setFilter: setDeliveryFilter,
  resetFilters: resetDeliveryFilters,
  setQuery: setSupplierDeliveryQuery,
  focusAsset: focusSupplierDeliveryAsset,
  batchDownload: batchDownloadSupplierDelivery,
  render(root) {
    const isSupplierRole = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
    const canUpdateViews = ["supplier_parent", "supplier_child"].includes(state.role);
    hydrateDeliveryFilters();
    if (!isSupplierRole) {
      // 团队交付对创作成员可见，但每次进入发布清单先聚焦当前发布人。
      supFilters.publisher = currentMember()?.name || "all";
    }

    const draw = () => {
      const all = sortDelivered(deliveredAssets());
      root.innerHTML = `
        <div class="delivery-page">
          <div id="dvBody"></div>
        </div>`;

      const body = $("#dvBody", root);
      if (isSupplierRole) drawSupplier(body, all);
      else drawCreator(body, all);
    };

    function drawCreator(body, all) {
      const seqMap = displaySeqMap(all);
      const productTags = [...new Set(all.map(x => x.asset.productTag || productTagLabel(productById(x.asset.productId || ""))).filter(Boolean))];
      const selfPublisher = currentMember()?.name || "";
      const publishers = [...new Set([...all.map(x => publisherLabel(x.asset)), selfPublisher].filter(Boolean))];
      const canFilterPublisher = ["admin", "editor"].includes(state.role);
      if (!canFilterPublisher) supFilters.publisher = "all";
      const accounts = [...new Map(all.map(x => [x.acc.id, x.acc])).values()];
      const dates = [...new Set(all.map(x => dayKey(x.asset)))];
      const noStructuredFilter = Object.entries(supFilters).every(([key, value]) => (
        deliveryDateRangeKeys.has(key) ? value === "" : value === "all"
      ));
      const visible = all.filter(x => {
        const product = x.asset.productTag || productTagLabel(productById(x.asset.productId || ""));
        return (supFilters.product === "all" || product === supFilters.product)
          && (supFilters.type === "all" || x.acc.mode === supFilters.type)
          && (supFilters.publisher === "all" || publisherLabel(x.asset) === supFilters.publisher)
          && (supFilters.account === "all" || x.acc.id === supFilters.account)
          && (supFilters.date === "all" || dayKey(x.asset) === supFilters.date)
          && matchesDateRange(creationDay(x.asset), supFilters.createdFrom, supFilters.createdTo)
          && matchesDateRange(supplierReturnDay(x.asset), supFilters.returnedFrom, supFilters.returnedTo)
          && matchesDeliveryStatusFilters(x.asset, supFilters)
          && (creatorRemarkFilter === "all" || hasUnreadRemark(x.asset));
      });
      const groups = groupByDay(visible);
      body.innerHTML = `<div class="supplier-filters creator-delivery-filters"><div class="delivery-filter-controls">
          <label class="select-shell">${icon("package", 13)}<select data-creator-select="product"><option value="all">全部产品</option>${productTags.map(x => `<option value="${esc(x)}" ${supFilters.product === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("filter", 13)}<select data-creator-select="type"><option value="all">全部形式</option><option value="视频" ${supFilters.type === "视频" ? "selected" : ""}>视频</option><option value="图文" ${supFilters.type === "图文" ? "selected" : ""}>图文</option></select>${icon("chevronDown", 12)}</label>
          ${canFilterPublisher ? `<label class="select-shell">${icon("user", 13)}<select data-creator-select="publisher"><option value="all">全部发布人</option>${publishers.map(x => `<option value="${esc(x)}" ${supFilters.publisher === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>` : ""}
          <label class="select-shell">${icon("users", 13)}<select data-creator-select="account"><option value="all">全部账号</option>${accounts.map(acc => `<option value="${esc(acc.id)}" ${supFilters.account === acc.id ? "selected" : ""}>${esc(acc.name)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("clock", 13)}<select data-creator-select="date"><option value="all">全部时间</option>${dates.map(x => `<option value="${esc(x)}" ${supFilters.date === x ? "selected" : ""}>${esc(dayLabel(x))}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          ${deliveryStatusFiltersHtml("creator")}
          <button class="creator-remark-filter ${creatorRemarkFilter === "unread" ? "on" : ""}" data-creator-remarks="unread">${icon("fileText", 12)} 最新备注${all.some(x => hasUnreadRemark(x.asset)) ? `<i class="delivery-remark-dot"></i>` : ""}</button>
        </div></div>` + (visible.length
        ? `<div class="dv-layout ${noStructuredFilter && creatorRemarkFilter === "all" ? "" : "is-filtered"}">
            ${noStructuredFilter && creatorRemarkFilter === "all" ? `<aside class="dv-date-nav" aria-label="发布时间轴">
              ${groups.map(g => `<button class="dv-date-link" data-day-jump="${esc(g.key)}"><span>${esc(dayLabel(g.key))}</span><em>${g.items.length}</em></button>`).join("")}
            </aside>` : ""}
            <div class="dv-flow">
              ${groups.map(g => {
                const closed = collapsedDays.has(g.key);
                return `<section class="dv-day ${closed ? "collapsed" : ""}" id="dv-day-${esc(g.key)}">
                  <button class="dv-day-head" data-day-toggle="${esc(g.key)}">
                    <span>${esc(dayLabel(g.key))}</span>
                    <em>${esc(g.key)} · ${g.items.length} 条</em>
                    ${icon("chevronDown", 14)}
                  </button>
                  <div class="dv-day-list">
                    <div class="dv-day-list-inner">
                      ${g.items.map(({ asset, acc }, i) => deliveredItemHtml(asset, acc, i, seqMap.get(asset.id))).join("")}
                    </div>
                  </div>
                </section>`;
              }).join("")}
            </div>
          </div>`
        : emptyState("package", noStructuredFilter ? "还没有发布记录" : "当前筛选下还没有发布记录", noStructuredFilter ? "在审核页点「定稿并发布」后，会按发布序号汇总在这里（未发布的内容在「草稿箱」）" : "调整筛选条件，或恢复全部条件查看时间轴"));

      $$("[data-creator-select]", body).forEach(select => select.addEventListener("change", () => {
        setDeliveryFilter(select.dataset.creatorSelect, select.value, { redraw: false });
        const height = body.offsetHeight;
        body.style.minHeight = `${height}px`;
        drawCreator(body, all);
        const animation = body.animate?.([{ opacity: .55, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "cubic-bezier(.2,.8,.2,1)" });
        if (animation) animation.finished.finally(() => { body.style.minHeight = ""; });
        else body.style.minHeight = "";
      }));

      $$("[data-creator-status]", body).forEach(button => button.addEventListener("click", () => {
        const dimension = button.dataset.creatorStatus;
        const value = button.dataset.statusValue;
        setDeliveryFilter(dimension, value, { toggle: true, redraw: false });
        drawCreator(body, all);
      }));

      $$("[data-creator-remarks]", body).forEach(button => button.addEventListener("click", () => {
        setDeliveryFilter("remarks", "unread", { toggle: true, redraw: false });
        drawCreator(body, all);
      }));

      $$("[data-day-jump]", body).forEach(b => b.addEventListener("click", () => {
        const target = body.querySelector(`#dv-day-${CSS.escape(b.dataset.dayJump)}`);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
      }));
      $$("[data-day-toggle]", body).forEach(b => b.addEventListener("click", e => {
        e.stopPropagation();
        const key = b.dataset.dayToggle;
        collapsedDays.has(key) ? collapsedDays.delete(key) : collapsedDays.add(key);
        const sec = b.closest(".dv-day");
        sec?.classList.toggle("collapsed", collapsedDays.has(key));
      }));

      // 已发布列表
      $$(".dv-head", body).forEach(h => h.addEventListener("click", () => {
        const d = h.parentElement.querySelector(".dv-detail");
        d.hidden = !d.hidden;
        h.parentElement.classList.toggle("open", !d.hidden);
      }));
      $$("[data-dvimg]", body).forEach(im => im.addEventListener("click", e => { e.stopPropagation(); openLightbox(im, im.src, ""); }));
      $$(".dv-card", body).forEach(card => {
        const asset = state.assets.find(x => x.id === card.dataset.aid);
        if (!asset) return;
        const acc = accountById(asset.accountId);
        const shareButton = card.querySelector('[data-dvact="community"]');
        if (shareButton && !asset.communityPostId) {
          syncCommunityShareStatus(shareButton, {
            authorId: asset.byMemberId || asset.ownerId || productionById(asset.productionId)?.ownerId || "",
            sourceKind: "delivery",
            sourceId: asset.id,
            ...deliveryCommunitySource(asset),
            media: deliveryMedia(asset),
            cover: deliveryCover(asset),
          }, { onShared: post => { asset.communityPostId = post?.id || "shared"; } });
        }
        card.querySelectorAll("[data-dvact]").forEach(b => b.addEventListener("click", async e => {
          e.stopPropagation();
          const act = b.dataset.dvact;
          if (act === "preview") openDeliveryPreview(asset);
          if (act === "copy") copyText((asset.title || "") + "\n\n" + (asset.copy || ""), "已复制标题+文案");
          if (act === "download") {
            try {
              await downloadDelivery(asset, { markDownloaded: false });
              toast("已下载 " + asset.name);
            } catch (error) {
              toast(error?.message || "交付文件下载失败，请刷新后重试", "error");
            }
          }
          if (act === "community") {
            openCommunityShare({
              authorId: asset.byMemberId || asset.ownerId || productionById(asset.productionId)?.ownerId || "",
              sourceKind: "delivery",
              sourceId: asset.id,
              ...deliveryCommunitySource(asset),
              title: asset.title || asset.name || "星阵灵感",
              copy: asset.copy || "",
              prompt: asset.prompt || asset.promptText || "",
              category: asset.type === "图集" ? "视觉设计" : "视频灵感",
              media: deliveryMedia(asset),
              cover: deliveryCover(asset),
              trigger: b,
              onShared: post => { asset.communityPostId = post?.id || "shared"; },
            });
          }
          if (act === "remarks") await openDeliveryRemarks(asset);
          if (act === "review") { const on = toggleAdminReviewed(asset); toast(on ? "已标记为「已审阅」" : "已取消「已审阅」"); draw(); }
          if (act === "delete") {
            const ok1 = await confirmModal({
              title: "确认回撤这条发布内容？",
              body: `<p>将从发布清单删除「${esc(asset.title || asset.name)}」，并退回到自己的草稿/审核状态。供应商端不再可见，原始账号素材会保留。</p>`,
              okText: "继续回撤",
              danger: true
            });
            if (!ok1) return;
            const ok2 = await confirmModal({
              title: "二次确认删除",
              body: `<p>该操作会同步到共享数据。删除后如需重新进入发布清单，需要回到审核页再次定稿发布。</p>`,
              okText: "确认删除",
              danger: true
            });
            if (!ok2) return;
            try {
              if (await deleteDeliveryAsset(asset)) { toast("已回撤删除发布记录"); draw(); }
              else toast("当前账号无权删除这条发布记录", "error");
            } catch (error) {
              toast(error?.message || "回撤失败，请稍后重试", "error");
            }
          }
          if (act === "prod" && asset.productionId && productionById(asset.productionId)) openProductionDrawer(asset.productionId);
        }));
      });
    }

    function drawSupplier(body, all) {
      const seqMap = displaySeqMap(all);
      const accountSequence = accountDisplaySequenceMap(state.accounts);
      const productTags = [...new Set(all.map(x => x.asset.productTag || productTagLabel(productById(x.asset.productId || ""))).filter(Boolean))];
      const supplierAccounts = [...new Map(all.map(x => [x.acc.id, x.acc])).values()]
        .sort((a, b) => supplierAccountCollator.compare(a.name || "", b.name || ""));
      const searchValue = item => {
        const product = item.asset.productTag || productTagLabel(productById(item.asset.productId || ""));
        return `${item.asset.name || ""} ${item.asset.title || ""} ${item.acc.name || ""} ${item.acc.platform || ""} ${publisherLabel(item.asset)} ${product}`.toLowerCase();
      };
      const matchesFilters = x => {
        const ptag = x.asset.productTag || productTagLabel(productById(x.asset.productId || ""));
        return (supFilters.product === "all" || ptag === supFilters.product)
          && (supFilters.type === "all" || x.acc.mode === supFilters.type)
          && (supFilters.publisher === "all" || publisherLabel(x.asset) === supFilters.publisher)
          && (supFilters.account === "all" || x.acc.id === supFilters.account)
          && (supFilters.date === "all" || dayKey(x.asset) === supFilters.date)
          && matchesDateRange(creationDay(x.asset), supFilters.createdFrom, supFilters.createdTo)
          && matchesDateRange(supplierReturnDay(x.asset), supFilters.returnedFrom, supFilters.returnedTo)
          && matchesDeliveryStatusFilters(x.asset, supFilters)
          && (!supplierDeliveryQuery || searchValue(x).includes(supplierDeliveryQuery));
      };
      const rows = all;
      const visibleCount = rows.filter(matchesFilters).length;
      body.innerHTML = `
        <div class="supplier-filters">
          <div class="delivery-filter-controls">
          <label class="select-shell">${icon("package", 13)}<select data-sup-select="product"><option value="all">全部产品</option>${productTags.map(x => `<option value="${esc(x)}" ${supFilters.product === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("filter", 13)}<select data-sup-select="type"><option value="all">全部形式</option><option value="视频" ${supFilters.type === "视频" ? "selected" : ""}>视频</option><option value="图文" ${supFilters.type === "图文" ? "selected" : ""}>图文</option></select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("user", 13)}<select data-sup-select="publisher"><option value="all">全部发布人</option>${[...new Set(all.map(x => publisherLabel(x.asset)))].map(x => `<option value="${esc(x)}" ${supFilters.publisher === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("users", 13)}<select data-sup-select="account"><option value="all">全部账号</option>${supplierAccounts.map(acc => `<option value="${esc(acc.id)}" ${supFilters.account === acc.id ? "selected" : ""}>${esc(acc.name)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("clock", 13)}<select data-sup-select="date"><option value="all">全部时间</option>${[...new Set(all.map(x => dayKey(x.asset)))].map(x => `<option value="${esc(x)}" ${supFilters.date === x ? "selected" : ""}>${esc(dayLabel(x))}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          ${deliveryStatusFiltersHtml("sup")}
          </div>
          <span class="supplier-selection-count" id="dvSelectedCount" hidden>已选 <b>0</b> 条</span>
        </div>
        <div class="sup-table-wrap card">
          <table class="sup-table">
            <colgroup>
              <col class="sup-col-check" />
              <col class="sup-col-seq" />
              <col class="sup-col-name" />
              <col class="sup-col-product" />
              <col class="sup-col-account" />
              <col class="sup-col-platform" />
              <col class="sup-col-tags" />
              <col class="sup-col-exposure" />
              <col class="sup-col-status" />
              <col class="sup-col-actions" />
            </colgroup>
            <thead><tr>
              <th class="c-check"><input type="checkbox" id="supAll" /></th>
              <th class="c-seq">序号</th>
              <th>素材名</th><th>产品</th><th>发布人</th><th>平台</th><th>观看量</th><th>曝光量</th><th>状态</th><th></th>
            </tr></thead>
            <tbody>${rows.length ? rows.map(item => {
              const { asset, acc } = item;
              const ptag = asset.productTag || productTagLabel(productById(asset.productId || ""));
              const returnState = supplierReturnRowState(asset);
              return `
              <tr data-sup="${asset.id}" data-sup-product="${esc(ptag)}" data-sup-type="${esc(acc.mode || "")}" data-sup-publisher="${esc(publisherLabel(asset))}" data-sup-account="${esc(acc.id)}" data-sup-date="${esc(dayKey(asset))}" data-sup-search="${esc(searchValue(item))}" data-sup-visible="${matchesFilters(item) ? "1" : "0"}" ${matchesFilters(item) ? "" : "hidden"}>
                <td class="c-check"><input type="checkbox" class="sup-check" /></td>
                <td class="sup-seq">${seqText(seqMap.get(asset.id)) || "—"}</td>
                <td class="sup-name" title="${esc(asset.name)}"><b>${esc(asset.name)}${remarkDot(asset)}</b>${asset.title ? `<em title="${esc(asset.title)}">${esc(asset.title)}</em>` : ""}<span class="sup-date-line">${dateTimeFromTime(productionById(asset.productionId)?.createdAt || asset.sourceCreatedAt || asset.createdAt) ? `<em class="sup-created">${icon("calendar", 10)} 创作 ${esc(dateTimeFromTime(productionById(asset.productionId)?.createdAt || asset.sourceCreatedAt || asset.createdAt))}</em>` : ""}${asset.planDate ? `<em class="sup-plan">${icon("clock", 10)} 计划发布 ${esc(dateOnly(asset.planDate))}</em>` : ""}</span>${asset.publishNote ? `<em class="sup-pubnote" title="${esc(asset.publishNote)}">${icon("fileText", 10)} ${esc(asset.publishNote.slice(0, 20))}${asset.publishNote.length > 20 ? "…" : ""}</em>` : ""}${asset.supplierNote ? `<em class="sup-return-note" title="${esc(asset.supplierNote)}">${icon("fileText", 10)} 回传备注：${esc(asset.supplierNote.slice(0, 18))}${asset.supplierNote.length > 18 ? "…" : ""}</em>` : ""}</td>
                <td><span class="tag product">${esc(asset.productTag || productTagLabel(productById(asset.productId || "")) || "未标记")}</span></td>
                <td><b>${esc(publisherLabel(asset))}</b></td>
                <td>${platChip(acc.platform, true)}</td>
                <td>${canUpdateViews
                  ? `<button class="sup-views" data-supviews="${asset.id}" title="更新观看量">${Number(asset.viewCount || 0).toLocaleString()} ${icon("edit", 11)}</button>`
                  : `<span class="sup-views-readonly" data-supviews-value="${asset.id}" title="供应商同步的观看量">${Number(asset.viewCount || 0).toLocaleString()}</span>`}</td>
                <td>${canUpdateViews
                  ? `<button class="sup-views sup-exposure" data-supexposure="${asset.id}" title="更新曝光量">${Number(asset.exposureCount || 0).toLocaleString()} ${icon("edit", 11)}</button>`
                  : `<span class="sup-views-readonly" data-supexposure-value="${asset.id}" title="供应商同步的曝光量">${Number(asset.exposureCount || 0).toLocaleString()}</span>`}</td>
                <td><span class="sup-status ${returnState.statusClass}">${returnState.statusText}</span></td>
                <td class="sup-acts">
                  <div class="sup-actions-inner"><button class="btn ghost sm" data-suppreview="${asset.id}">${icon("eye", 13)} 预览</button><button class="btn ghost sm" data-supdl="${asset.id}">${icon("download", 13)} 下载</button>
                  ${isSupplierRole && asset.publishedUrl ? `<a class="btn ghost sm sup-row-jump-link" href="${esc(asset.publishedUrl)}" target="_blank" rel="noopener noreferrer">${icon("external", 13)} 跳转链接</a>` : ""}
                  ${isSupplierRole ? `<button class="btn ghost sm delivery-remark-button" data-supremarks="${asset.id}">${icon("fileText", 13)} 备注${remarkDot(asset)}</button>` : ""}
                  ${isSupplierRole
                    ? `<button class="btn ${returnState.actionClass} sm" data-suplink="${asset.id}">${icon("link", 13)} ${returnState.actionText}</button>`
                    : asset.publishedUrl
                      ? `<a class="btn ghost sm" href="${esc(asset.publishedUrl)}" target="_blank" rel="noopener noreferrer">${icon("link", 13)} 查看链接</a>`
                      : `<button class="btn ghost sm" disabled>${icon("link", 13)} 暂无链接</button>`}</div>
                </td>
              </tr>${supplierDetailHtml(asset, acc, accountSequence.get(acc.id) || 0)}`;
            }).join("") + `<tr class="sup-empty-filter" ${visibleCount ? "hidden" : ""}><td colspan="10" class="sup-empty">当前筛选下暂无素材。</td></tr>` : `<tr><td colspan="10" class="sup-empty">暂无成片素材。创作端发布后会按发布序号 + 产品标签自动进入这里。</td></tr>`}
            </tbody>
          </table>
        </div>`;
      const visibleSupplierRows = () => $$("tr[data-sup]", body).filter(row => row.dataset.supVisible === "1");
      const updateSupplierSelection = () => {
        const visible = visibleSupplierRows();
        const selected = visible.filter(row => $(".sup-check", row)?.checked);
        const count = $("#dvSelectedCount", body);
        if (count) {
          count.hidden = selected.length === 0;
          count.innerHTML = `已选 <b>${selected.length}</b> 条`;
        }
        const selectAll = $("#supAll", body);
        if (selectAll) {
          selectAll.checked = visible.length > 0 && selected.length === visible.length;
          selectAll.indeterminate = selected.length > 0 && selected.length < visible.length;
        }
      };
      const applySupplierFilters = () => {
        let shown = 0;
        $$("tr[data-sup]", body).forEach(row => {
          const asset = state.assets.find(item => item.id === row.dataset.sup);
          const show = (supFilters.product === "all" || row.dataset.supProduct === supFilters.product)
            && (supFilters.type === "all" || row.dataset.supType === supFilters.type)
            && (supFilters.publisher === "all" || row.dataset.supPublisher === supFilters.publisher)
            && (supFilters.account === "all" || row.dataset.supAccount === supFilters.account)
            && (supFilters.date === "all" || row.dataset.supDate === supFilters.date)
            && matchesDateRange(creationDay(asset), supFilters.createdFrom, supFilters.createdTo)
            && matchesDateRange(supplierReturnDay(asset), supFilters.returnedFrom, supFilters.returnedTo)
            && matchesDeliveryStatusFilters(asset, supFilters)
            && (!supplierDeliveryQuery || row.dataset.supSearch.includes(supplierDeliveryQuery));
          row.dataset.supVisible = show ? "1" : "0";
          const detail = body.querySelector(`[data-sup-detail="${CSS.escape(row.dataset.sup)}"]`);
          row.getAnimations?.().forEach(animation => animation.cancel());
          if (show) {
            shown++;
            if (row.hidden) {
              row.hidden = false;
              row.animate?.([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
            }
          } else if (!row.hidden) {
            if (detail) detail.hidden = true;
            row.classList.remove("open");
            const animation = row.animate?.([{ opacity: 1 }, { opacity: 0, transform: "translateY(-3px)" }], { duration: 120, easing: "ease-out" });
            if (animation) animation.onfinish = () => { row.hidden = true; };
            else row.hidden = true;
          }
        });
        const empty = $(".sup-empty-filter", body);
        if (empty) empty.hidden = shown > 0;
        updateSupplierSelection();
      };
      $$("[data-sup-select]", body).forEach(b => b.addEventListener("change", () => {
        setDeliveryFilter(b.dataset.supSelect, b.value, { redraw: false });
        applySupplierFilters();
      }));
      $$("[data-sup-status]", body).forEach(button => button.addEventListener("click", () => {
        const dimension = button.dataset.supStatus;
        const value = button.dataset.statusValue;
        setDeliveryFilter(dimension, value, { toggle: true, redraw: false });
        drawSupplier(body, all);
      }));
      const supAll = $("#supAll", body);
      if (supAll) supAll.addEventListener("change", e => visibleSupplierRows().forEach(row => {
        const checkbox = $(".sup-check", row);
        if (checkbox) checkbox.checked = e.target.checked;
      }));
      $$(".sup-check", body).forEach(checkbox => checkbox.addEventListener("change", updateSupplierSelection));
      supAll?.addEventListener("change", updateSupplierSelection);
      updateSupplierSelection();
      $$("[data-supdl]", body).forEach(b => b.addEventListener("click", async () => {
        const a = state.assets.find(x => x.id === b.dataset.supdl);
        if (a) {
          try {
            await downloadDelivery(a, { markDownloaded: isSupplierRole });
            toast("已下载 " + a.name);
            draw();
          } catch (error) {
            toast(error?.message || "交付文件下载失败，请刷新后重试", "error");
          }
        }
      }));
      $$("[data-suppreview]", body).forEach(button => button.addEventListener("click", event => {
        event.stopPropagation();
        const asset = state.assets.find(item => item.id === button.dataset.suppreview);
        if (asset) openDeliveryPreview(asset);
      }));
      $$("[data-supviews]", body).forEach(b => b.addEventListener("click", async e => {
        e.stopPropagation();
        const a = state.assets.find(x => x.id === b.dataset.supviews);
        if (!a) return;
        const value = await promptModal({ title: "更新观看量", value: supplierViewCountPromptValue(a), placeholder: "请输入当前观看量" });
        if (value == null) return;
        const parsedViews = parseSupplierViewCount(value);
        if (!parsedViews.ok) {
          toast(parsedViews.message, "error");
          return;
        }
        const nextViews = parsedViews.value;
        if (remote.isOn()) {
          try {
            const result = await remote.supplier.updateViews(a.id, nextViews);
            Object.assign(a, result.asset || {});
            await refreshDeliveryMetrics({ force: true });
          } catch (err) {
            toast(err?.message || "观看量更新失败", "error");
            return;
          }
        } else {
          a.viewCount = nextViews;
          a.viewsUpdatedAt = Date.now(); a.viewsUpdatedBy = state.ui.currentMemberId;
          save("assets");
        }
        toast("观看量已更新"); draw();
      }));
      $$("[data-supexposure]", body).forEach(b => b.addEventListener("click", async e => {
        e.stopPropagation();
        const a = state.assets.find(x => x.id === b.dataset.supexposure);
        if (!a) return;
        const currentExposure = Math.max(0, Number(a.exposureCount || 0));
        const value = await promptModal({ title: "更新曝光量", value: currentExposure > 0 ? String(currentExposure) : "", placeholder: "请输入当前曝光量" });
        if (value == null) return;
        const parsedExposure = parseSupplierViewCount(value);
        if (!parsedExposure.ok) {
          toast(parsedExposure.message.replace("观看量", "曝光量"), "error");
          return;
        }
        const nextExposure = parsedExposure.value;
        if (remote.isOn()) {
          try {
            const result = await remote.supplier.updateExposure(a.id, nextExposure);
            Object.assign(a, result.asset || {});
            await refreshDeliveryMetrics({ force: true });
          } catch (err) {
            toast(err?.message || "曝光量更新失败", "error");
            return;
          }
        } else {
          a.exposureCount = nextExposure;
          a.exposureUpdatedAt = Date.now();
          a.exposureUpdatedBy = state.ui.currentMemberId;
          save("assets");
        }
        toast("曝光量已更新");
        draw();
      }));
      $$("[data-suplink]", body).forEach(b => b.addEventListener("click", async () => {
        const a = state.assets.find(x => x.id === b.dataset.suplink);
        if (!a) return;
        const acc = accountById(a.accountId);
        const changed = await returnLinkFlow(a, acc);
        if (!changed) return;
        draw();
      }));
      $$("[data-supremarks]", body).forEach(b => b.addEventListener("click", async event => {
        event.stopPropagation();
        const asset = state.assets.find(x => x.id === b.dataset.supremarks);
        if (asset) await openDeliveryRemarks(asset);
      }));
      $$("tr[data-sup]", body).forEach(tr => tr.addEventListener("click", e => {
        if (e.target.closest("button,input,a")) return;
        const detail = body.querySelector(`[data-sup-detail="${tr.dataset.sup}"]`);
        if (!detail) return;
        detail.hidden = !detail.hidden;
        tr.classList.toggle("open", !detail.hidden);
      }));
      if (supplierDeliveryFocusId) {
        const focusId = supplierDeliveryFocusId;
        supplierDeliveryFocusId = "";
        requestAnimationFrame(() => {
          const row = body.querySelector(`tr[data-sup="${CSS.escape(focusId)}"]`);
          if (!row || row.hidden) return;
          row.scrollIntoView({ block: "center", behavior: "smooth" });
          row.classList.add("is-search-focus");
          window.setTimeout(() => row.classList.remove("is-search-focus"), 1800);
        });
      }
      $$("[data-supimg]", body).forEach(b => b.addEventListener("click", e => {
        e.stopPropagation();
        const a = state.assets.find(x => x.id === b.dataset.supimg);
        const img = b.querySelector("img");
        if (a && img && !img.hidden) {
          const deliveryId = b.closest("[data-sup-detail]")?.dataset.supDetail || "";
          openLightbox(img, deliveryScopedMediaUrl(urlFor(a), deliveryId), a.name);
        }
      }));
      bindDeliveryMediaFallback(body);
    }

    async function batchDl() {
      const checkedIds = $$("tr[data-sup]", root).filter(tr => tr.dataset.supVisible === "1" && tr.querySelector(".sup-check")?.checked).map(tr => tr.dataset.sup);
      const pendingIds = $$("tr[data-sup]", root).filter(tr => {
        const a = state.assets.find(x => x.id === tr.dataset.sup);
        return tr.dataset.supVisible === "1" && a && !supplierHasPublished(a) && !supplierHasDownloaded(a);
      }).map(tr => tr.dataset.sup);
      const ids = checkedIds.length ? checkedIds : pendingIds;
      if (!ids.length) { toast("当前筛选下没有未下载素材"); return; }
      const assets = ids.map(id => state.assets.find(x => x.id === id)).filter(Boolean);
      try {
        const n = await batchDownloadZip(assets, "", { markDownloaded: isSupplierRole });
        toast(`${checkedIds.length ? "已打包所选" : "已打包未下载"} ${n} 个素材${isSupplierRole ? "，供应商下载状态已更新" : ""}`);
        draw();
      } catch (error) {
        toast(error?.message || "批量交付下载失败，请刷新后重试", "error");
      }
    }

    const syncAuthority = () => {
      $$('[data-supviews]', root).forEach(button => {
        const asset = state.assets.find(item => item.id === button.dataset.supviews);
        if (asset) button.innerHTML = `${Number(asset.viewCount || 0).toLocaleString()} ${icon("edit", 11)}`;
      });
      $$('[data-supexposure]', root).forEach(button => {
        const asset = state.assets.find(item => item.id === button.dataset.supexposure);
        if (asset) button.innerHTML = `${Number(asset.exposureCount || 0).toLocaleString()} ${icon("edit", 11)}`;
      });
      $$('[data-supviews-value]', root).forEach(value => {
        const asset = state.assets.find(item => item.id === value.dataset.supviewsValue);
        if (asset) value.textContent = Number(asset.viewCount || 0).toLocaleString();
      });
      $$('[data-supexposure-value]', root).forEach(value => {
        const asset = state.assets.find(item => item.id === value.dataset.supexposureValue);
        if (asset) value.textContent = Number(asset.exposureCount || 0).toLocaleString();
      });
    };
    const refreshMetrics = async (force = false) => {
      try {
        const result = await refreshDeliveryMetrics({ force });
        if (result.changed && activeDeliveryController?.root === root) syncAuthority();
        return result;
      } catch (error) {
        if (force) toast(`播放与曝光数据刷新失败：${error?.message || error}`, "error");
        return { refreshed: false, changed: false };
      }
    };
    activeDeliveryController = { root, draw, batchDl, syncAuthority, refreshMetrics };
    window.clearInterval(deliveryMetricPollTimer);
    deliveryMetricPollTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || document.body.dataset.zone !== "delivery") return;
      void refreshMetrics(false);
    }, 8000);
    root.__viewCleanup = () => {
      if (activeDeliveryController?.root === root) activeDeliveryController = null;
      window.clearInterval(deliveryMetricPollTimer);
      deliveryMetricPollTimer = 0;
    };
    draw();
    void refreshMetrics(true);
    emitDeliveryFilterModel();
  }
};
