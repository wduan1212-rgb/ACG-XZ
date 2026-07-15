/* 发布清单：创作端全景（含明细 + 发布回链）+ 供应商视角（下载 / 回传发布链接）
   供应商回传小红书/视频号链接 → 素材标记「已发布」，链路闭环 */

import { $, $$, esc, gradFor, timeAgo } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, notify, pullRemote, accountById, productionById, canMarkReviewed, productById } from "../core/store.js";
import { platChip } from "../domain/accounts.js";
import { canDeleteDelivery, canSeeDeliveryRetract, deleteDeliveryAsset, deliveredAssets, deliveryRetractBlockReason, downloadDelivery, batchDownloadZip, toggleAdminReviewed, productTagLabel, supplierHasDownloaded } from "../domain/delivery.js";
import { urlFor } from "../domain/assets.js";
import { ensureAnalyticsForAsset } from "../domain/analytics.js";
import { openProductionDrawer } from "./prodDrawer.js";
import { confirmModal, emptyState, toast, openLightbox, supplierReturnModal, promptModal, openModal } from "../ui/components.js";
import { copyText } from "../core/util.js";
import * as remote from "../core/remote.js";

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
  return map;
}

function seqText(seq) {
  return seq ? `#${String(seq).padStart(3, "0")}` : "";
}

function publisherLabel(asset) {
  return asset.byMemberName || "未记录";
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

async function openDeliveryRemarks(asset) {
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
  return `<div class="dv-item" style="--d:${i * 40}ms">
    <span class="dv-node${i === 0 ? " latest" : ""}"></span>
    <div class="dv-card card" data-aid="${asset.id}">
      <div class="dv-head" data-dvtoggle>
        <span class="dv-cover">${u ? `<img src="${u}"/>` : `<i style="background:${gradFor(asset.name)}">${isImg ? "图" : "▶"}</i>`}<em>${isImg ? `${(asset.packAssetIds || []).length} 张` : `${asset.clips || 0} 段`}</em></span>
        <span class="dv-main">
          <b>${seq ? `<span class="dv-seq">${seq}</span>` : ""}${esc(asset.title || asset.name)}</b>
          <span class="dv-meta">
            <span class="dv-tagline">${productTag ? `<span class="tag product" title="${esc(productTag)}">${esc(productTag)}</span>` : ""}<span class="tag pubby">发布人：${esc(publisher)}</span><span class="tag date">${icon("clock", 10)} ${esc(plan || dateOnly(asset.deliveredAt || asset.createdAt))}</span><span class="tag ${supplierDownloaded ? "supplier-downloaded" : "supplier-pending"}">${supplierDownloaded ? `${icon("checkCircle", 10)} 供应商已下载` : "供应商未下载"}</span><span class="tag ${asset.publishedUrl ? "pub" : ""}">${asset.publishedUrl ? `${icon("checkCircle", 10)} 已发布` : "待发布"}</span></span>
          </span>
        </span>
        <span class="dv-chev">${remarkDot(asset)}${icon("chevronDown", 14)}</span>
      </div>
      <div class="dv-detail" hidden>
        <div class="dv-detail-facts"><span>内容账号：${esc(contentAccount)}</span><span>平台：${esc(acc.platform || "平台")}</span><span>文件：${esc(asset.name)}${isImg ? ".zip" : ".mp4"}</span></div>
        ${asset.planDate || asset.publishNote ? `<div class="dv-pubmeta">${plan ? `<span>${icon("clock", 12)} 计划发布：<b>${esc(plan)}</b></span>` : ""}${asset.publishNote ? `<span>${icon("fileText", 12)} 备注：${esc(asset.publishNote)}</span>` : ""}</div>` : ""}
        ${asset.publishedUrl ? `<div class="dv-published">${icon("link", 13)} 发布链接：<a href="${esc(asset.publishedUrl)}" target="_blank" rel="noopener noreferrer">${esc(asset.publishedUrl.slice(0, 64))}${asset.publishedUrl.length > 64 ? "…" : ""}</a><em>${asset.publishedAt ? timeAgo(asset.publishedAt) + "回传" : ""}</em></div>` : ""}
        ${asset.supplierNote ? `<div class="dv-supplier-note">${icon("fileText", 13)} 供应商备注：${esc(asset.supplierNote)}</div>` : ""}
        ${asset.copy ? `<pre class="dv-copy">${esc(asset.copy)}</pre>` : ""}
        ${isImg && (asset.packAssetIds || []).length ? `<div class="cc-grid">${asset.packAssetIds.map((id, k) => { const uu = urlFor(id); return uu ? `<div class="cc-thumb"><img src="${uu}" data-dvimg/><span>${k + 1}</span></div>` : ""; }).join("")}</div>` : ""}
        <div class="dv-actions">
          <button class="btn ghost sm" data-dvact="copy">${icon("copy", 13)} 复制标题+文案</button>
          <button class="btn ghost sm" data-dvact="download">${icon("download", 13)} 下载 zip</button>
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
  const raw = ret.raw || "";
  const url = extractUrl(raw);
  if (!url) { toast("没有识别到链接：请粘贴包含 http:// 或 https:// 的分享内容"); return false; }
  const shareTitle = extractShareTitle(raw);
  const payload = {
    url,
    note: String(ret.note || "").trim().slice(0, 300),
    title: shareTitle || asset.publishedTitle || "",
    rawText: String(raw || "").slice(0, 500)
  };
  if (remote.isOn()) {
    try {
      const result = await remote.supplier.returnLink(asset.id, payload);
      Object.assign(asset, result.asset || {});
    } catch (error) {
      toast(error?.message || "发布链接回传失败", "error");
      return false;
    }
  } else {
    const now = Date.now();
    asset.publishedUrl = url;
    asset.supplierNote = payload.note;
    if (payload.title) asset.publishedTitle = payload.title;
    asset.publishedRawText = payload.rawText;
    asset.publishedAt = now;
    asset.publishedUpdatedAt = now;
    asset.publishedUpdatedBy = state.ui.currentMemberId || "local";
    asset.updatedAt = now;
    asset.status = "已发布";
    save("assets");
    ensureAnalyticsForAsset(asset, acc);
  }
  notify("delivery", `「${asset.title || asset.name}」已发布`, `供应商回传了发布链接，链路闭环 ✓`);
  toast("已记录发布链接，素材标记为「已发布」");
  return true;
}

function supplierDetailHtml(asset, acc) {
  const isImg = asset.type === "图集";
  const ids = isImg ? (asset.packAssetIds || []) : [];
  const title = asset.title || asset.name;
  const contentAccount = asset.byAccount || acc.name;
  const publisher = publisherLabel(asset);
  return `<tr class="sup-detail-row" data-sup-detail="${asset.id}" hidden>
    <td colspan="9">
      <div class="sup-detail">
        <div class="sup-detail-copy">
          <b>${esc(title)}</b>
          ${asset.copy ? `<pre>${esc(asset.copy)}</pre>` : `<p>暂无文案，可从创作端补充后重新定稿。</p>`}
          <div class="sup-detail-meta">
            <span>${esc(acc.platform || "平台")}</span>
            <span>内容账号：${esc(contentAccount)}</span>
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
          const u = urlFor(id);
          return u ? `<button class="sup-thumb" data-supimg="${id}" title="预览第 ${k + 1} 张"><img src="${u}" alt="第 ${k + 1} 张"/><span>${k + 1}</span></button>` : "";
        }).join("")}</div>` : `<div class="sup-detail-empty">${isImg ? "图集文件缺少预览图" : "视频素材可下载后预览"}</div>`}
      </div>
    </td>
  </tr>`;
}

let tab = "creator"; // creator | supplier
let supFilters = { product: "all", type: "all", publisher: "all", account: "all", date: "all" };
let creatorProductFilter = "all";
let creatorRemarkFilter = "all";
let lastDeliveryRemotePullAt = 0;

export const deliveryView = {
  render(root) {
    const isSupplierRole = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
    const canUpdateViews = ["supplier_parent", "supplier_child"].includes(state.role);
    const isAdmin = state.role === "admin";
    if (isSupplierRole) tab = "supplier";
    if (!isAdmin && !isSupplierRole) tab = "creator";

    const draw = () => {
      const all = sortDelivered(deliveredAssets());
      root.innerHTML = `
        <div class="delivery-page">
          ${isAdmin ? `<div class="delivery-toolbar">
            <div class="mode-tabs slim" data-active="${tab}">
              <button class="mode-tab ${tab === "creator" ? "is-active" : ""}" data-dtab="creator">创作端视角<span>交付明细 · 全链路回看</span></button>
              <button class="mode-tab ${tab === "supplier" ? "is-active" : ""}" data-dtab="supplier">供应商视角<span>他们看到的素材库</span></button>
            </div>
          </div>` : ""}
          <div id="dvBody"></div>
        </div>`;

      const body = $("#dvBody", root);
      const renderActiveBody = () => {
        if (tab === "creator") drawCreator(body, all);
        else drawSupplier(body, all);
      };
      renderActiveBody();
      $$("[data-dtab]", root).forEach(button => button.addEventListener("click", () => {
        const next = button.dataset.dtab;
        if (next === tab) return;
        tab = next;
        const scroll = document.querySelector(".main-scroll");
        const beforeScroll = scroll?.scrollTop || 0;
        $$("[data-dtab]", root).forEach(item => item.classList.toggle("is-active", item.dataset.dtab === tab));
        $(".mode-tabs", root)?.setAttribute("data-active", tab);
        const swap = () => {
          renderActiveBody();
          if (scroll) scroll.scrollTop = beforeScroll;
          body.animate?.([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
        };
        if (typeof body.animate !== "function") return swap();
        body.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: "ease-out" }).onfinish = swap;
      }));
    };

    function drawCreator(body, all) {
      const seqMap = displaySeqMap(all);
      const productTags = [...new Set(all.map(x => x.asset.productTag || productTagLabel(productById(x.asset.productId || ""))).filter(Boolean))];
      const visible = all.filter(x => (creatorProductFilter === "all" || (x.asset.productTag || productTagLabel(productById(x.asset.productId || ""))) === creatorProductFilter)
        && (creatorRemarkFilter === "all" || hasUnreadRemark(x.asset)));
      const groups = groupByDay(visible);
      body.innerHTML = `<div class="creator-delivery-filters">
          <button class="${creatorProductFilter === "all" ? "on" : ""}" data-creator-product="all">全部标签</button>
          ${productTags.map(tag => `<button class="${creatorProductFilter === tag ? "on" : ""}" data-creator-product="${esc(tag)}">${esc(tag)}</button>`).join("")}
          <button class="creator-remark-filter ${creatorRemarkFilter === "unread" ? "on" : ""}" data-creator-remarks="unread">${icon("fileText", 12)} 最新备注${all.some(x => hasUnreadRemark(x.asset)) ? `<i class="delivery-remark-dot"></i>` : ""}</button>
        </div>` + (visible.length
        ? `<div class="dv-layout ${creatorProductFilter === "all" && creatorRemarkFilter === "all" ? "" : "is-filtered"}">
            ${creatorProductFilter === "all" && creatorRemarkFilter === "all" ? `<aside class="dv-date-nav" aria-label="发布时间轴">
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
        : emptyState("package", creatorProductFilter === "all" ? "还没有发布记录" : "这个标签下还没有发布记录", creatorProductFilter === "all" ? "在审核页点「定稿并发布」后，会按发布序号汇总在这里（未发布的内容在「草稿箱」）" : "切换其他标签，或返回全部标签查看时间轴"));

      $$("[data-creator-product]", body).forEach(button => button.addEventListener("click", () => {
        const next = button.dataset.creatorProduct || "all";
        if (next === creatorProductFilter) return;
        creatorProductFilter = next;
        const height = body.offsetHeight;
        body.style.minHeight = `${height}px`;
        drawCreator(body, all);
        const animation = body.animate?.([{ opacity: .55, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "cubic-bezier(.2,.8,.2,1)" });
        if (animation) animation.finished.finally(() => { body.style.minHeight = ""; });
        else body.style.minHeight = "";
      }));

      $$("[data-creator-remarks]", body).forEach(button => button.addEventListener("click", () => {
        creatorRemarkFilter = creatorRemarkFilter === "unread" ? "all" : "unread";
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
        card.querySelectorAll("[data-dvact]").forEach(b => b.addEventListener("click", async e => {
          e.stopPropagation();
          const act = b.dataset.dvact;
          if (act === "copy") copyText((asset.title || "") + "\n\n" + (asset.copy || ""), "已复制标题+文案");
          if (act === "download") { await downloadDelivery(asset, { markDownloaded: false }); toast("已下载 " + asset.name); }
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
            if (deleteDeliveryAsset(asset)) { toast("已回撤删除发布记录"); draw(); }
            else toast("当前账号无权删除这条发布记录", "error");
          }
          if (act === "prod" && asset.productionId && productionById(asset.productionId)) openProductionDrawer(asset.productionId);
        }));
      });
    }

    function drawSupplier(body, all) {
      const seqMap = displaySeqMap(all);
      const productTags = [...new Set(all.map(x => x.asset.productTag || productTagLabel(productById(x.asset.productId || ""))).filter(Boolean))];
      const matchesFilters = x => {
        const ptag = x.asset.productTag || productTagLabel(productById(x.asset.productId || ""));
        return (supFilters.product === "all" || ptag === supFilters.product)
          && (supFilters.type === "all" || x.acc.mode === supFilters.type)
          && (supFilters.publisher === "all" || publisherLabel(x.asset) === supFilters.publisher)
          && (supFilters.account === "all" || x.acc.id === supFilters.account)
          && (supFilters.date === "all" || dayKey(x.asset) === supFilters.date);
      };
      const rows = all;
      const visibleCount = rows.filter(matchesFilters).length;
      body.innerHTML = `
        <div class="supplier-filters">
          <label class="select-shell">${icon("package", 13)}<select data-sup-select="product"><option value="all">全部产品</option>${productTags.map(x => `<option value="${esc(x)}" ${supFilters.product === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("filter", 13)}<select data-sup-select="type"><option value="all">全部形式</option><option value="视频" ${supFilters.type === "视频" ? "selected" : ""}>视频</option><option value="图文" ${supFilters.type === "图文" ? "selected" : ""}>图文</option></select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("user", 13)}<select data-sup-select="publisher"><option value="all">全部发布人</option>${[...new Set(all.map(x => publisherLabel(x.asset)))].map(x => `<option value="${esc(x)}" ${supFilters.publisher === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("users", 13)}<select data-sup-select="account"><option value="all">全部账号</option>${[...new Map(all.map(x => [x.acc.id, x.acc])).values()].map(acc => `<option value="${esc(acc.id)}" ${supFilters.account === acc.id ? "selected" : ""}>${esc(acc.name)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("clock", 13)}<select data-sup-select="date"><option value="all">全部时间</option>${[...new Set(all.map(x => dayKey(x.asset)))].map(x => `<option value="${esc(x)}" ${supFilters.date === x ? "selected" : ""}>${esc(dayLabel(x))}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          <button class="btn primary supplier-batch-download" id="dvBatchDl">${icon("download", 14)} 批量下载未下载</button>
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
              <col class="sup-col-status" />
              <col class="sup-col-actions" />
            </colgroup>
            <thead><tr>
              <th class="c-check"><input type="checkbox" id="supAll" /></th>
              <th class="c-seq">序号</th>
              <th>素材名</th><th>产品</th><th>发布人</th><th>平台</th><th>观看量</th><th>状态</th><th></th>
            </tr></thead>
            <tbody>${rows.length ? rows.map(item => {
              const { asset, acc } = item;
              const ptag = asset.productTag || productTagLabel(productById(asset.productId || ""));
              return `
              <tr data-sup="${asset.id}" data-sup-product="${esc(ptag)}" data-sup-type="${esc(acc.mode || "")}" data-sup-publisher="${esc(publisherLabel(asset))}" data-sup-account="${esc(acc.id)}" data-sup-date="${esc(dayKey(asset))}" ${matchesFilters(item) ? "" : "hidden"}>
                <td class="c-check"><input type="checkbox" class="sup-check" /></td>
                <td class="sup-seq">${seqText(seqMap.get(asset.id)) || "—"}</td>
                <td class="sup-name" title="${esc(asset.name)}"><b>${esc(asset.name)}${remarkDot(asset)}</b>${asset.title ? `<em title="${esc(asset.title)}">${esc(asset.title)}</em>` : ""}<span class="sup-date-line">${dateFromTime(productionById(asset.productionId)?.createdAt || asset.sourceCreatedAt || asset.createdAt) ? `<em class="sup-created">${icon("calendar", 10)} 创作 ${esc(dateFromTime(productionById(asset.productionId)?.createdAt || asset.sourceCreatedAt || asset.createdAt))}</em>` : ""}${asset.planDate ? `<em class="sup-plan">${icon("clock", 10)} 计划发布 ${esc(dateOnly(asset.planDate))}</em>` : ""}</span>${asset.publishNote ? `<em class="sup-pubnote" title="${esc(asset.publishNote)}">${icon("fileText", 10)} ${esc(asset.publishNote.slice(0, 20))}${asset.publishNote.length > 20 ? "…" : ""}</em>` : ""}${asset.supplierNote ? `<em class="sup-return-note" title="${esc(asset.supplierNote)}">${icon("fileText", 10)} 回传备注：${esc(asset.supplierNote.slice(0, 18))}${asset.supplierNote.length > 18 ? "…" : ""}</em>` : ""}</td>
                <td><span class="tag product">${esc(asset.productTag || productTagLabel(productById(asset.productId || "")) || "未标记")}</span></td>
                <td><b>${esc(publisherLabel(asset))}</b></td>
                <td>${platChip(acc.platform, true)}</td>
                <td>${canUpdateViews
                  ? `<button class="sup-views" data-supviews="${asset.id}" title="更新观看量">${Number(asset.viewCount || 0).toLocaleString()} ${icon("edit", 11)}</button>`
                  : `<span class="sup-views-readonly" title="供应商同步的观看量">${Number(asset.viewCount || 0).toLocaleString()}</span>`}</td>
                <td><span class="sup-status ${asset.status === "已发布" ? "pub" : supplierHasDownloaded(asset) ? "done" : ""}">${asset.publishedUrl ? "已发布 ✓" : supplierHasDownloaded(asset) ? "已下载" : "未下载"}</span></td>
                <td class="sup-acts">
                  <div class="sup-actions-inner"><button class="btn ghost sm" data-supdl="${asset.id}">${icon("download", 13)} 下载</button>
                  ${isSupplierRole && asset.publishedUrl ? `<a class="btn ghost sm sup-row-jump-link" href="${esc(asset.publishedUrl)}" target="_blank" rel="noopener noreferrer">${icon("external", 13)} 跳转链接</a>` : ""}
                  ${isSupplierRole ? `<button class="btn ghost sm delivery-remark-button" data-supremarks="${asset.id}">${icon("fileText", 13)} 备注${remarkDot(asset)}</button>` : ""}
                  ${isSupplierRole
                    ? `<button class="btn ${asset.publishedUrl ? "ghost" : "primary"} sm" data-suplink="${asset.id}">${icon("link", 13)} ${asset.publishedUrl ? "改链接" : "回传链接"}</button>`
                    : asset.publishedUrl
                      ? `<a class="btn ghost sm" href="${esc(asset.publishedUrl)}" target="_blank" rel="noopener noreferrer">${icon("link", 13)} 查看链接</a>`
                      : `<button class="btn ghost sm" disabled>${icon("link", 13)} 暂无链接</button>`}</div>
                </td>
              </tr>${supplierDetailHtml(asset, acc)}`;
            }).join("") + `<tr class="sup-empty-filter" ${visibleCount ? "hidden" : ""}><td colspan="9" class="sup-empty">当前筛选下暂无素材。</td></tr>` : `<tr><td colspan="9" class="sup-empty">暂无成片素材。创作端发布后会按发布序号 + 产品标签自动进入这里。</td></tr>`}
            </tbody>
          </table>
        </div>`;
      const applySupplierFilters = () => {
        let shown = 0;
        $$("tr[data-sup]", body).forEach(row => {
          const show = (supFilters.product === "all" || row.dataset.supProduct === supFilters.product)
            && (supFilters.type === "all" || row.dataset.supType === supFilters.type)
            && (supFilters.publisher === "all" || row.dataset.supPublisher === supFilters.publisher)
            && (supFilters.account === "all" || row.dataset.supAccount === supFilters.account)
            && (supFilters.date === "all" || row.dataset.supDate === supFilters.date);
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
      };
      $$("[data-sup-select]", body).forEach(b => b.addEventListener("change", () => {
        supFilters[b.dataset.supSelect] = b.value;
        applySupplierFilters();
      }));
      $("#dvBatchDl", body)?.addEventListener("click", batchDl);
      const supAll = $("#supAll", body);
      if (supAll) supAll.addEventListener("change", e => $$("tr[data-sup]", body).filter(row => !row.hidden).forEach(row => {
        const checkbox = $(".sup-check", row);
        if (checkbox) checkbox.checked = e.target.checked;
      }));
      $$("[data-supdl]", body).forEach(b => b.addEventListener("click", async () => {
        const a = state.assets.find(x => x.id === b.dataset.supdl);
        if (a) {
          await downloadDelivery(a, { markDownloaded: isSupplierRole });
          toast("已下载 " + a.name); draw();
        }
      }));
      $$("[data-supviews]", body).forEach(b => b.addEventListener("click", async e => {
        e.stopPropagation();
        const a = state.assets.find(x => x.id === b.dataset.supviews);
        if (!a) return;
        const value = await promptModal({ title: "更新观看量", value: String(a.viewCount || 0), placeholder: "请输入当前观看量" });
        if (value == null) return;
        const nextViews = Math.max(0, Math.round(Number(String(value).replace(/[,，\s]/g, "")) || 0));
        if (remote.isOn()) {
          try {
            const result = await remote.supplier.updateViews(a.id, nextViews);
            Object.assign(a, result.asset || {});
          } catch (err) {
            toast(err?.message || "观看量更新失败");
            return;
          }
        } else {
          a.viewCount = nextViews;
          a.viewsUpdatedAt = Date.now(); a.viewsUpdatedBy = state.ui.currentMemberId;
          save("assets");
        }
        toast("观看量已更新"); draw();
      }));
      $$("[data-suplink]", body).forEach(b => b.addEventListener("click", async () => {
        const a = state.assets.find(x => x.id === b.dataset.suplink);
        if (!a) return;
        const acc = accountById(a.accountId);
        const changed = await returnLinkFlow(a, acc);
        if (!changed) return;
        const row = b.closest("tr[data-sup]");
        const status = row?.querySelector(".sup-status");
        if (status) {
          status.textContent = "已发布 ✓";
          status.classList.add("pub");
        }
        let jumpLink = row?.querySelector(".sup-row-jump-link");
        if (jumpLink) jumpLink.href = a.publishedUrl;
        else {
          const downloadButton = row?.querySelector(`[data-supdl="${CSS.escape(a.id)}"]`);
          downloadButton?.insertAdjacentHTML("afterend", `<a class="btn ghost sm sup-row-jump-link" href="${esc(a.publishedUrl)}" target="_blank" rel="noopener noreferrer">${icon("external", 13)} 跳转链接</a>`);
        }
        b.className = "btn ghost sm";
        b.innerHTML = `${icon("link", 13)} 改链接`;
        const detail = body.querySelector(`[data-sup-detail="${CSS.escape(a.id)}"]`);
        const linkSlot = detail?.querySelector(".sup-detail-link-slot");
        if (linkSlot) linkSlot.innerHTML = `<a class="btn ghost sm sup-detail-link" href="${esc(a.publishedUrl)}" target="_blank" rel="noopener noreferrer">${icon("external", 13)} 跳转链接</a>`;
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
      $$("[data-supimg]", body).forEach(b => b.addEventListener("click", e => {
        e.stopPropagation();
        const a = state.assets.find(x => x.id === b.dataset.supimg);
        const img = b.querySelector("img");
        if (a && img) openLightbox(img, urlFor(a), a.name);
      }));
    }

    async function batchDl() {
      const checkedIds = $$("tr[data-sup]", root).filter(tr => !tr.hidden && tr.querySelector(".sup-check")?.checked).map(tr => tr.dataset.sup);
      const pendingIds = $$("tr[data-sup]", root).filter(tr => {
        const a = state.assets.find(x => x.id === tr.dataset.sup);
        return !tr.hidden && a && !a.publishedUrl && !supplierHasDownloaded(a);
      }).map(tr => tr.dataset.sup);
      const ids = checkedIds.length ? checkedIds : pendingIds;
      if (!ids.length) { toast("当前筛选下没有未下载素材"); return; }
      const assets = ids.map(id => state.assets.find(x => x.id === id)).filter(Boolean);
      const n = await batchDownloadZip(assets, "", { markDownloaded: isSupplierRole });
      toast(`${checkedIds.length ? "已打包所选" : "已打包未下载"} ${n} 个素材${isSupplierRole ? "，供应商下载状态已更新" : ""}`);
      draw();
    }

    draw();
    if (remote.isOn() && Date.now() - lastDeliveryRemotePullAt > 1200) {
      lastDeliveryRemotePullAt = Date.now();
      pullRemote().then(ok => {
        if (ok && root.isConnected) draw();
      }).catch(() => {});
    }
  }
};
