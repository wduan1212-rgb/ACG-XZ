/* 发布清单：创作端全景（含明细 + 发布回链）+ 供应商视角（下载 / 回传发布链接）
   供应商回传小红书/视频号链接 → 素材标记「已发布」，链路闭环 */

import { $, $$, esc, gradFor, timeAgo } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, notify, accountById, productionById, canMarkReviewed, productById } from "../core/store.js";
import { platChip } from "../domain/accounts.js";
import { canDeleteDelivery, canSeeDeliveryRetract, deleteDeliveryAsset, deliveredAssets, deliveryRetractBlockReason, downloadDelivery, batchDownloadZip, toggleAdminReviewed, productTagLabel } from "../domain/delivery.js";
import { urlFor } from "../domain/assets.js";
import { ensureAnalyticsForAsset } from "../domain/analytics.js";
import { openProductionDrawer } from "./prodDrawer.js";
import { confirmModal, emptyState, toast, openLightbox, supplierReturnModal, promptModal } from "../ui/components.js";
import { copyText } from "../core/util.js";
import * as remote from "../core/remote.js";

function extractUrl(text) {
  const m = String(text || "").match(/https?:\/\/[^\s"'<>，。；、）】]+/);
  return m ? m[0].trim() : "";
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
  return `<div class="dv-item" style="--d:${i * 40}ms">
    <span class="dv-node${i === 0 ? " latest" : ""}"></span>
    <div class="dv-card card" data-aid="${asset.id}">
      <div class="dv-head" data-dvtoggle>
        <span class="dv-cover">${u ? `<img src="${u}"/>` : `<i style="background:${gradFor(asset.name)}">${isImg ? "图" : "▶"}</i>`}<em>${isImg ? `${(asset.packAssetIds || []).length} 张` : `${asset.clips || 0} 段`}</em></span>
        <span class="dv-main">
          <b>${seq ? `<span class="dv-seq">${seq}</span>` : ""}${esc(asset.title || asset.name)}</b>
          <span class="dv-meta">
            <span class="dv-tagline">${productTag ? `<span class="tag product" title="${esc(productTag)}">${esc(productTag)}</span>` : ""}<span class="tag pubby">发布人：${esc(publisher)}</span><span class="tag date">${icon("clock", 10)} ${esc(plan || dateOnly(asset.deliveredAt || asset.createdAt))}</span><span class="tag ${asset.publishedUrl ? "pub" : ""}">${asset.publishedUrl ? `${icon("checkCircle", 10)} 已发布` : "待发布"}</span></span>
          </span>
        </span>
        <span class="dv-chev">${icon("chevronDown", 14)}</span>
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
          <button class="btn ghost sm" data-dvact="link">${icon("link", 13)} ${asset.publishedUrl ? "修改发布链接" : "登记发布链接"}</button>
          ${canMarkReviewed() ? `<button class="btn ghost sm" data-dvact="review">${icon("eye", 13)} ${asset.adminReviewed ? "取消已审阅" : "标记已审阅"}</button>` : ""}
          ${showRetract ? `<button class="btn ghost sm danger-soft" ${canRetract ? `data-dvact="delete"` : "disabled"} title="${esc(retractReason || "回撤到草稿/审核状态")}">${icon("trash", 13)} ${canRetract ? "回撤删除" : "已下载不可回撤"}</button>` : ""}
          ${asset.productionId ? `<button class="btn ghost sm" data-dvact="prod">${icon("eye", 13)} 全链路回看</button>` : ""}
        </div>
      </div>
    </div>
  </div>`;
}

async function returnLinkFlow(asset, acc, redraw) {
  const ret = await supplierReturnModal({
    title: `回传发布链接 · ${asset.name}`,
    platform: acc?.platform || "平台",
    value: asset.publishedUrl || "",
    note: asset.supplierNote || ""
  });
  if (ret == null) return;
  const raw = ret.raw || "";
  const url = extractUrl(raw);
  if (!url) { toast("没有识别到链接：请粘贴包含 http:// 或 https:// 的分享内容"); return; }
  const shareTitle = extractShareTitle(raw);
  asset.publishedUrl = url;
  asset.supplierNote = String(ret.note || "").trim().slice(0, 300);
  if (shareTitle) asset.publishedTitle = shareTitle;
  asset.publishedRawText = String(raw || "").slice(0, 500);
  asset.publishedAt = Date.now();
  asset.status = "已发布";
  save("assets");
  notify("delivery", `「${asset.title || asset.name}」已发布`, `供应商回传了发布链接，链路闭环 ✓`);
  ensureAnalyticsForAsset(asset, acc);
  if (["supplier_parent", "supplier_child", "supplier"].includes(state.role) && remote.isOn()) {
    remote.supplier.record({ action: "return_link", accountId: asset.accountId || "", assetId: asset.id, detail: `回传了「${asset.title || asset.name}」的发布链接` }).catch(() => {});
  }
  toast("已记录发布链接，素材标记为「已发布」");
  redraw();
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
let supFilters = { product: "all", type: "all", publisher: "all", date: "all" };

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
          <div class="page-head">
            <div><div class="eyebrow">发布清单</div>
            <h2>${isSupplierRole ? "发布清单" : "定稿归档 · 发布回链全程可见"}</h2></div>
            ${(isSupplierRole || tab === "supplier") ? `<button class="btn primary" id="dvBatchDl">${icon("download", 14)} 批量下载未下载</button>` : ""}
          </div>
          ${isAdmin ? `
          <div class="mode-tabs slim" data-active="${tab}">
            <button class="mode-tab ${tab === "creator" ? "is-active" : ""}" data-dtab="creator">创作端视角<span>交付明细 · 全链路回看</span></button>
            <button class="mode-tab ${tab === "supplier" ? "is-active" : ""}" data-dtab="supplier">供应商视角<span>他们看到的素材库</span></button>
          </div>` : ""}
          <div id="dvBody"></div>
        </div>`;

      $$("[data-dtab]", root).forEach(b => b.addEventListener("click", () => { tab = b.dataset.dtab; draw(); }));
      const body = $("#dvBody", root);
      if (tab === "creator") drawCreator(body, all);
      else drawSupplier(body, all);
      const bd = $("#dvBatchDl", root);
      if (bd) bd.addEventListener("click", batchDl);
    };

    function drawCreator(body, all) {
      const seqMap = displaySeqMap(all);
      const groups = groupByDay(all);
      body.innerHTML = all.length
        ? `<div class="dv-layout">
            <aside class="dv-date-nav" aria-label="发布时间轴">
              ${groups.map(g => `<button class="dv-date-link" data-day-jump="${esc(g.key)}"><span>${esc(dayLabel(g.key))}</span><em>${g.items.length}</em></button>`).join("")}
            </aside>
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
        : emptyState("package", "还没有发布记录", "在审核页点「定稿并发布」后，会按发布序号汇总在这里（未发布的内容在「草稿箱」）");

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
          if (act === "download") { await downloadDelivery(asset); toast("已下载 " + asset.name); draw(); }
          if (act === "link") await returnLinkFlow(asset, acc, draw);
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
      const rows = all.filter(x => {
        const ptag = x.asset.productTag || productTagLabel(productById(x.asset.productId || ""));
        return (supFilters.product === "all" || ptag === supFilters.product)
          && (supFilters.type === "all" || x.acc.mode === supFilters.type)
          && (supFilters.publisher === "all" || publisherLabel(x.asset) === supFilters.publisher)
          && (supFilters.date === "all" || dayKey(x.asset) === supFilters.date);
      });
      body.innerHTML = `
        <div class="supplier-filters">
          <label class="select-shell">${icon("package", 13)}<select data-sup-select="product"><option value="all">全部产品</option>${productTags.map(x => `<option value="${esc(x)}" ${supFilters.product === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("filter", 13)}<select data-sup-select="type"><option value="all">全部形式</option><option value="视频" ${supFilters.type === "视频" ? "selected" : ""}>视频</option><option value="图文" ${supFilters.type === "图文" ? "selected" : ""}>图文</option></select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("user", 13)}<select data-sup-select="publisher"><option value="all">全部发布人</option>${[...new Set(all.map(x => publisherLabel(x.asset)))].map(x => `<option value="${esc(x)}" ${supFilters.publisher === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
          <label class="select-shell">${icon("clock", 13)}<select data-sup-select="date"><option value="all">全部时间</option>${[...new Set(all.map(x => dayKey(x.asset)))].map(x => `<option value="${esc(x)}" ${supFilters.date === x ? "selected" : ""}>${esc(dayLabel(x))}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
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
            <tbody>${rows.length ? rows.map(({ asset, acc }) => `
              <tr data-sup="${asset.id}">
                <td class="c-check"><input type="checkbox" class="sup-check" /></td>
                <td class="sup-seq">${seqText(seqMap.get(asset.id)) || "—"}</td>
                <td class="sup-name" title="${esc(asset.name)}"><b>${esc(asset.name)}</b>${asset.title ? `<em title="${esc(asset.title)}">${esc(asset.title)}</em>` : ""}${asset.planDate ? `<em class="sup-plan">${icon("clock", 10)} 计划发布 ${esc(dateOnly(asset.planDate))}</em>` : ""}${asset.publishNote ? `<em class="sup-pubnote" title="${esc(asset.publishNote)}">${icon("fileText", 10)} ${esc(asset.publishNote.slice(0, 20))}${asset.publishNote.length > 20 ? "…" : ""}</em>` : ""}${asset.supplierNote ? `<em class="sup-return-note" title="${esc(asset.supplierNote)}">${icon("fileText", 10)} 回传备注：${esc(asset.supplierNote.slice(0, 18))}${asset.supplierNote.length > 18 ? "…" : ""}</em>` : ""}</td>
                <td><span class="tag product">${esc(asset.productTag || productTagLabel(productById(asset.productId || "")) || "未标记")}</span></td>
                <td><b>${esc(publisherLabel(asset))}</b></td>
                <td>${platChip(acc.platform, true)}</td>
                <td>${canUpdateViews
                  ? `<button class="sup-views" data-supviews="${asset.id}" title="更新观看量">${Number(asset.viewCount || 0).toLocaleString()} ${icon("edit", 11)}</button>`
                  : `<span class="sup-views-readonly" title="供应商同步的观看量">${Number(asset.viewCount || 0).toLocaleString()}</span>`}</td>
                <td><span class="sup-status ${asset.status === "已发布" ? "pub" : asset.status === "已下载" ? "done" : ""}">${asset.publishedUrl ? "已发布 ✓" : asset.status || "未下载"}</span></td>
                <td class="sup-acts">
                  <button class="btn ghost sm" data-supdl="${asset.id}">${icon("download", 13)} 下载</button>
                  <button class="btn ${asset.publishedUrl ? "ghost" : "primary"} sm" data-suplink="${asset.id}">${icon("link", 13)} ${asset.publishedUrl ? "改链接" : "回传链接"}</button>
                </td>
              </tr>${supplierDetailHtml(asset, acc)}`).join("") : `<tr><td colspan="9" class="sup-empty">暂无成片素材。创作端发布后会按发布序号 + 产品标签自动进入这里。</td></tr>`}
            </tbody>
          </table>
        </div>`;
      $$("[data-sup-select]", body).forEach(b => b.addEventListener("change", () => { supFilters[b.dataset.supSelect] = b.value; draw(); }));
      const supAll = $("#supAll", body);
      if (supAll) supAll.addEventListener("change", e => $$(".sup-check", body).forEach(c => c.checked = e.target.checked));
      $$("[data-supdl]", body).forEach(b => b.addEventListener("click", async () => {
        const a = state.assets.find(x => x.id === b.dataset.supdl);
        if (a) {
          await downloadDelivery(a);
          if (isSupplierRole && remote.isOn()) remote.supplier.record({ action: "download", accountId: a.accountId || "", assetId: a.id, detail: `下载了「${a.title || a.name}」` }).catch(() => {});
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
        await returnLinkFlow(a, acc, draw);
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
      const checkedIds = $$("tr[data-sup]", root).filter(tr => tr.querySelector(".sup-check")?.checked).map(tr => tr.dataset.sup);
      const pendingIds = $$("tr[data-sup]", root).filter(tr => {
        const a = state.assets.find(x => x.id === tr.dataset.sup);
        return a && !a.publishedUrl && (a.status || "未下载") !== "已下载";
      }).map(tr => tr.dataset.sup);
      const ids = checkedIds.length ? checkedIds : pendingIds;
      if (!ids.length) { toast("当前筛选下没有未下载素材"); return; }
      const assets = ids.map(id => state.assets.find(x => x.id === id)).filter(Boolean);
      const n = await batchDownloadZip(assets);
      toast(`${checkedIds.length ? "已打包所选" : "已打包未下载"} ${n} 个素材，状态更新为已下载`);
      draw();
    }

    draw();
  }
};
