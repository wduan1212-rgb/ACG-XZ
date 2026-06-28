/* 发布清单：创作端全景（含明细 + 发布回链）+ 供应商视角（下载 / 回传发布链接）
   供应商回传小红书/视频号链接 → 素材标记「已发布」，链路闭环 */

import { $, $$, esc, gradFor, timeAgo } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, notify, accountById, productionById, canMarkReviewed, productById } from "../core/store.js";
import { platChip, modeLabel, PLATFORM_CODE } from "../domain/accounts.js";
import { deliveredAssets, downloadDelivery, batchDownloadZip, toggleAdminReviewed, productTagLabel } from "../domain/delivery.js";
import { urlFor } from "../domain/assets.js";
import { ensureAnalyticsForAsset, isAnalyticsSupported, refreshAnalyticsLink } from "../domain/analytics.js";
import { openProductionDrawer } from "./prodDrawer.js";
import { emptyState, toast, openLightbox, promptModal } from "../ui/components.js";
import { copyText } from "../core/util.js";

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

function deliveredItemHtml(asset, acc, i) {
  const isImg = asset.type === "图集";
  const coverId = isImg ? (asset.packAssetIds || [])[0] : null;
  const u = coverId ? urlFor(coverId) : null;
  const seq = asset.pubSeq ? `#${String(asset.pubSeq).padStart(3, "0")}` : "";
  const productTag = asset.productTag || productTagLabel(productById(asset.productId || ""));
  return `<div class="dv-item" style="--d:${i * 40}ms">
    <span class="dv-node${i === 0 ? " latest" : ""}"></span>
    <div class="dv-card card" data-aid="${asset.id}">
      <div class="dv-head" data-dvtoggle>
        <span class="dv-cover">${u ? `<img src="${u}"/>` : `<i style="background:${gradFor(asset.name)}">${isImg ? "图" : "▶"}</i>`}<em>${isImg ? `${(asset.packAssetIds || []).length} 张` : `${asset.clips || 0} 段`}</em></span>
        <span class="dv-main">
          <b>${seq ? `<span class="dv-seq">${seq}</span>` : ""}${esc(asset.title || asset.name)}</b>
          <span class="dv-meta">${platChip(acc.platform, true)}${productTag ? `<span class="tag product">${esc(productTag)}</span>` : ""}<span class="tag acc">${esc(asset.byAccount || acc.name)}</span>${asset.planDate ? `<span class="tag date">${icon("clock", 10)} 计划 ${esc(asset.planDate)}</span>` : ""}${asset.adminReviewed ? `<span class="tag rev">${icon("checkCircle", 10)} 已审阅</span>` : ""}${asset.publishedUrl ? `<span class="tag pub">${icon("checkCircle", 10)} 已发布</span>` : ""}<em>${esc(asset.name)}${isImg ? ".zip" : ".mp4"}${asset.byMemberName ? ` · 由 ${esc(asset.byMemberName)} 发布` : ""} · ${timeAgo(asset.deliveredAt || asset.createdAt)} · 供应商：${asset.status || "未下载"}</em></span>
        </span>
        <span class="dv-chev">${icon("chevronDown", 14)}</span>
      </div>
      <div class="dv-detail" hidden>
        ${asset.planDate || asset.publishNote ? `<div class="dv-pubmeta">${asset.planDate ? `<span>${icon("clock", 12)} 计划发布：<b>${esc(asset.planDate)}</b></span>` : ""}${asset.publishNote ? `<span>${icon("fileText", 12)} 备注：${esc(asset.publishNote)}</span>` : ""}</div>` : ""}
        ${asset.publishedUrl ? `<div class="dv-published">${icon("link", 13)} 发布链接：<a href="${esc(asset.publishedUrl)}" target="_blank" rel="noopener noreferrer">${esc(asset.publishedUrl.slice(0, 64))}${asset.publishedUrl.length > 64 ? "…" : ""}</a><em>${asset.publishedAt ? timeAgo(asset.publishedAt) + "回传" : ""}</em></div>` : ""}
        ${asset.copy ? `<pre class="dv-copy">${esc(asset.copy)}</pre>` : ""}
        ${isImg && (asset.packAssetIds || []).length ? `<div class="cc-grid">${asset.packAssetIds.map((id, k) => { const uu = urlFor(id); return uu ? `<div class="cc-thumb"><img src="${uu}" data-dvimg/><span>${k + 1}</span></div>` : ""; }).join("")}</div>` : ""}
        <div class="dv-actions">
          <button class="btn ghost sm" data-dvact="copy">${icon("copy", 13)} 复制标题+文案</button>
          <button class="btn ghost sm" data-dvact="download">${icon("download", 13)} 下载 zip</button>
          <button class="btn ghost sm" data-dvact="link">${icon("link", 13)} ${asset.publishedUrl ? "修改发布链接" : "登记发布链接"}</button>
          ${canMarkReviewed() ? `<button class="btn ghost sm" data-dvact="review">${icon("eye", 13)} ${asset.adminReviewed ? "取消已审阅" : "标记已审阅"}</button>` : ""}
          ${asset.productionId ? `<button class="btn ghost sm" data-dvact="prod">${icon("eye", 13)} 全链路回看</button>` : ""}
        </div>
      </div>
    </div>
  </div>`;
}

async function returnLinkFlow(asset, acc, redraw) {
  const raw = await promptModal({
    title: `回传发布链接 · ${asset.name}`,
    placeholder: `粘贴${acc?.platform || "平台"}链接，或整段分享文案`,
    value: asset.publishedUrl || "", okText: "确认回传"
  });
  if (raw == null) return;
  const url = extractUrl(raw);
  if (!url) { toast("没有识别到链接：请粘贴包含 http:// 或 https:// 的分享内容"); return; }
  const shareTitle = extractShareTitle(raw);
  asset.publishedUrl = url;
  if (shareTitle) asset.publishedTitle = shareTitle;
  asset.publishedRawText = String(raw || "").slice(0, 500);
  asset.publishedAt = Date.now();
  asset.status = "已发布";
  save("assets");
  notify("delivery", `「${asset.title || asset.name}」已发布`, `供应商回传了发布链接，链路闭环 ✓`);
  const link = ensureAnalyticsForAsset(asset, acc);
  if (link && isAnalyticsSupported(link.url, link.platform)) {
    refreshAnalyticsLink(link.id).then(snap => {
      if (snap) notify("analytics", "小红书数据已完成首次检测", `${asset.title || asset.name} 已进入数据分析看板`);
    });
    toast("已记录发布链接，素材标记为「已发布」，数据检测已排队");
  } else {
    toast("已记录发布链接，素材标记为「已发布」");
  }
  redraw();
}

let tab = "creator"; // creator | supplier
let supFilter = "all";

export const deliveryView = {
  render(root) {
    const isSupplierRole = state.role === "supplier";
    if (isSupplierRole) tab = "supplier";

    const draw = () => {
      const all = deliveredAssets();
      root.innerHTML = `
        <div class="delivery-page">
          <div class="page-head">
            <div><div class="eyebrow">发布清单</div>
            <h2>${isSupplierRole ? "下载素材 → 平台发布 → 回传链接，完成闭环" : "定稿归档 · 供应商领取 · 发布回链全程可见"}</h2></div>
            ${isSupplierRole ? `<button class="btn primary" id="dvBatchDl">${icon("download", 14)} 一键下载未下载</button>` : ""}
          </div>
          ${isSupplierRole ? "" : `
          <div class="mode-tabs slim" data-active="${tab}">
            <button class="mode-tab ${tab === "creator" ? "is-active" : ""}" data-dtab="creator">创作端视角<span>交付明细 · 全链路回看</span></button>
            <button class="mode-tab ${tab === "supplier" ? "is-active" : ""}" data-dtab="supplier">供应商视角<span>他们看到的素材库</span></button>
          </div>`}
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
      body.innerHTML = all.length
        ? `<div class="dv-flow">${all.map(({ asset, acc }, i) => deliveredItemHtml(asset, acc, i)).join("")}</div>`
        : emptyState("package", "还没有发布记录", "在审核页点「定稿并发布」后，会按发布序号汇总在这里（未发布的内容在「草稿箱」）");

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
          if (act === "prod" && asset.productionId && productionById(asset.productionId)) openProductionDrawer(asset.productionId);
        }));
      });
    }

    function drawSupplier(body, all) {
      const platforms = [...new Set(all.map(x => x.acc.platform))];
      const productTags = [...new Set(all.map(x => x.asset.productTag || productTagLabel(productById(x.asset.productId || ""))).filter(Boolean))];
      const tags = [...new Set(all.flatMap(x => x.asset.tags || []))];
      const filters = ["all", ...productTags.map(t => `产品:${t}`), ...platforms, "视频", "图文", ...tags.filter(t => !["视频", "图文", ...platforms, ...productTags].includes(t))];
      const rows = all.filter(x => {
        const ptag = x.asset.productTag || productTagLabel(productById(x.asset.productId || ""));
        return supFilter === "all" || x.acc.mode === supFilter || x.acc.platform === supFilter || `产品:${ptag}` === supFilter || (x.asset.tags || []).includes(supFilter);
      });
      body.innerHTML = `
        <div class="fb-row" style="margin-bottom:12px">${filters.map(f => {
          const isPlat = PLATFORM_CODE[f];
          return `<button class="chip ${isPlat ? "plat" : ""} ${supFilter === f ? "on" : ""}" data-supf="${esc(f)}">${f === "all" ? "全部" : esc(f.replace(/^产品:/, "产品 · "))}</button>`;
        }).join("")}</div>
        <div class="sup-table-wrap card">
          <table class="sup-table">
            <thead><tr>
              <th class="c-check"><input type="checkbox" id="supAll" /></th>
              <th class="c-seq">序号</th>
              <th>素材名</th><th>产品</th><th>发布账号</th><th>平台</th><th>形式</th><th>标签</th><th>状态</th><th></th>
            </tr></thead>
            <tbody>${rows.length ? rows.map(({ asset, acc }) => `
              <tr data-sup="${asset.id}">
                <td class="c-check"><input type="checkbox" class="sup-check" /></td>
                <td class="sup-seq">${asset.pubSeq ? `#${String(asset.pubSeq).padStart(3, "0")}` : "—"}</td>
                <td class="sup-name"><b>${esc(asset.name)}</b>${asset.title ? `<em>${esc(asset.title)}</em>` : ""}${asset.planDate ? `<em class="sup-plan">${icon("clock", 10)} 计划发布 ${esc(asset.planDate)}</em>` : ""}${asset.publishNote ? `<em class="sup-pubnote" title="${esc(asset.publishNote)}">${icon("fileText", 10)} ${esc(asset.publishNote.slice(0, 20))}${asset.publishNote.length > 20 ? "…" : ""}</em>` : ""}</td>
                <td><span class="tag product">${esc(asset.productTag || productTagLabel(productById(asset.productId || "")) || "未标记")}</span></td>
                <td><b>${esc(asset.byAccount || acc.name)}</b>${asset.byMemberName ? `<em class="sup-by">由 ${esc(asset.byMemberName)} 发布</em>` : ""}</td>
                <td>${platChip(acc.platform, true)}</td>
                <td>${modeLabel(acc)}</td>
                <td><div class="sup-tags">${(asset.tags || []).slice(0, 4).map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div></td>
                <td><span class="sup-status ${asset.status === "已发布" ? "pub" : asset.status === "已下载" ? "done" : ""}">${asset.publishedUrl ? "已发布 ✓" : asset.status || "未下载"}</span></td>
                <td class="sup-acts">
                  <button class="btn ghost sm" data-supdl="${asset.id}">${icon("download", 13)} 下载</button>
                  <button class="btn ${asset.publishedUrl ? "ghost" : "primary"} sm" data-suplink="${asset.id}">${icon("link", 13)} ${asset.publishedUrl ? "改链接" : "回传链接"}</button>
                </td>
              </tr>`).join("") : `<tr><td colspan="10" class="sup-empty">暂无成片素材。创作端发布后会按发布序号 + 产品标签自动进入这里。</td></tr>`}
            </tbody>
          </table>
        </div>`;
      $$("[data-supf]", body).forEach(b => b.addEventListener("click", () => { supFilter = b.dataset.supf; draw(); }));
      const supAll = $("#supAll", body);
      if (supAll) supAll.addEventListener("change", e => $$(".sup-check", body).forEach(c => c.checked = e.target.checked));
      $$("[data-supdl]", body).forEach(b => b.addEventListener("click", async () => {
        const a = state.assets.find(x => x.id === b.dataset.supdl);
        if (a) { await downloadDelivery(a); toast("已下载 " + a.name); draw(); }
      }));
      $$("[data-suplink]", body).forEach(b => b.addEventListener("click", async () => {
        const a = state.assets.find(x => x.id === b.dataset.suplink);
        if (!a) return;
        const acc = accountById(a.accountId);
        await returnLinkFlow(a, acc, draw);
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
