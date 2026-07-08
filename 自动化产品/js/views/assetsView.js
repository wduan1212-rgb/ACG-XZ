/* 共享资产库：展示已发布/已交付内容，以及发布后沉淀的生成图；草稿、口播和生成中素材留在账号资产/草稿链路 */

import { $, $$, esc, gradFor, buildZipBlob, downloadBlob } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, accountById } from "../core/store.js";
import { searchAssets, thumbHtml, removeAsset, urlFor, assetCode, assetU8 } from "../domain/assets.js";
import { downloadAsset } from "../domain/delivery.js";
import { platChip, groupOf } from "../domain/accounts.js";
import { emptyState, promptModal, confirmModal, openLightbox, toast, withLoading } from "../ui/components.js";

let fAcc = "all", fQ = "", fKind = "all", accFilterExpanded = false;
const collapsedAcc = new Set();
const isSharedAsset = a => !!a?.delivered || !!a?.shared;
const assetKind = a => a.type === "视频" || (a.tags || []).some(t => /视频|成片/.test(t)) ? "视频" : "图文";
const cleanName = s => String(s || "未命名").replace(/[\\/:*?"<>|#]+/g, "_").replace(/\s+/g, "_").slice(0, 60);
const accountImageAssets = accountId => state.assets
  .filter(a => isSharedAsset(a) && a.accountId === accountId && a.type === "图片")
  .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

async function exportAndPurgeAccountImages(accountId) {
  const acc = accountById(accountId);
  const imgs = accountImageAssets(accountId);
  if (!imgs.length) { toast("这个账号暂无可清理的共享图片"); return 0; }
  const ok = await confirmModal({
    title: `导出并清空「${esc(acc?.name || "该账号")}」的共享图片？`,
    body: `<p>将先下载 ${imgs.length} 张图片的压缩包，随后从整体资产和服务器文件中删除这些图片。视频成片、发布记录和账号资料不会删除。</p>`,
    okText: "导出并清空",
    danger: true
  });
  if (!ok) return 0;
  const entries = [];
  for (let i = 0; i < imgs.length; i++) {
    const a = imgs[i];
    const d = await assetU8(a.id);
    if (d) entries.push({ name: `${String(i + 1).padStart(3, "0")}_${cleanName(a.name)}.${d.ext}`, u8: d.u8 });
  }
  if (!entries.length) { toast("没有拿到可打包的图片文件，已取消清空", "error"); return 0; }
  downloadBlob(`整体资产_${cleanName(acc?.name || accountId)}_图片归档_${Date.now()}.zip`, buildZipBlob(entries));
  for (const a of imgs) await removeAsset(a.id);
  toast(`已导出并清空 ${imgs.length} 张共享图片`);
  return imgs.length;
}

export const assetsView = {
  render(root) {
    // 从账号资产库跳来时预筛该账号
    if (state.ui.assetsFilterAccount) { fAcc = state.ui.assetsFilterAccount; fQ = ""; state.ui.assetsFilterAccount = null; }
    const draw = () => {
      let list = searchAssets({ accountId: fAcc, tag: "all", q: fQ, includeDelivered: true })
        .filter(isSharedAsset)
        .sort((a, b) => (b.deliveredAt || b.createdAt || 0) - (a.deliveredAt || a.createdAt || 0));
      if (fKind === "video") list = list.filter(a => assetKind(a) === "视频");
      if (fKind === "image") list = list.filter(a => assetKind(a) === "图文");
      const accounts = state.accounts || [];
      const visibleAccounts = accFilterExpanded
        ? accounts
        : accounts.filter((a, i) => i < 16 || a.id === fAcc);
      const hiddenCount = Math.max(0, accounts.length - visibleAccounts.length);
      const selectedImageCount = fAcc === "all" ? 0 : accountImageAssets(fAcc).length;
      root.innerHTML = `
        <div class="assets-page">
          <div class="page-head">
            <div><div class="eyebrow">共享素材库 · 发布后入库</div>
            <h2>已发布内容和发布后沉淀的生成图会进入这里；草稿口播和生成中素材留在个人链路</h2></div>
            <div class="head-actions">
              <span class="tag">${icon("package", 13)} 发布后自动进入共享库</span>
              ${fAcc !== "all" ? `<button class="btn ghost" data-export-del-acc="${esc(fAcc)}" ${selectedImageCount ? "" : "disabled"}>${icon("download", 14)} 导出并清空图片 ${selectedImageCount ? `(${selectedImageCount})` : ""}</button>` : ""}
              <button class="btn ghost" data-go-delivery>${icon("package", 14)} 去发布清单</button>
            </div>
          </div>
          <div class="filter-bar card">
            <div class="fb-search">${icon("search", 14)}<input id="avSearch" placeholder="搜索素材名 / 标签" value="${esc(fQ)}" /></div>
            <div class="fb-row">
              <button class="chip ${fKind === "all" ? "on" : ""}" data-fkind="all">全部</button>
              <button class="chip ${fKind === "video" ? "on" : ""}" data-fkind="video">${icon("film", 12)} 视频</button>
              <button class="chip ${fKind === "image" ? "on" : ""}" data-fkind="image">${icon("image", 12)} 图文</button>
            </div>
            <div class="fb-row account-row ${accFilterExpanded ? "expanded" : ""}">
              <button class="chip ${fAcc === "all" ? "on" : ""}" data-facc="all">全部账号</button>
              ${visibleAccounts.map(a => `<button class="chip ${fAcc === a.id ? "on" : ""}" data-facc="${a.id}">${esc(a.name)}</button>`).join("")}
              ${hiddenCount ? `<button class="chip ghost" data-acc-more>展开全部账号 +${hiddenCount}</button>` : (accFilterExpanded && accounts.length > 16 ? `<button class="chip ghost" data-acc-more>收起账号</button>` : "")}
            </div>
          </div>
          <div id="avBody">
            ${renderBody(list)}
          </div>
        </div>`;
      wire();
    };

    const cardHtml = a => {
      const acc = accountById(a.accountId);
      const kind = assetKind(a);
      return `<div class="asset-card card" data-aid="${a.id}">
        <div class="ac-thumb">${thumbHtml(a)}
          ${a.seq ? `<span class="ac-seq">${assetCode(a)}</span>` : ""}
          ${a.type === "视频" ? `<span class="ac-play">${icon("play", 13)}</span>` : ""}
          <div class="ac-hover">
            <button class="ac-mini" data-aact="download" title="下载">${icon("download", 13)}</button>
            <button class="ac-mini" data-aact="rename" title="重命名">${icon("edit", 13)}</button>
            <button class="ac-mini" data-aact="tag" title="加标签">#</button>
            <button class="ac-mini danger" data-aact="del" title="删除">${icon("trash", 13)}</button>
          </div>
        </div>
        <div class="ac-body">
          <div class="ac-name" title="${esc(a.name)}">${esc(a.name)}</div>
          <div class="ac-tags">${acc ? platChip(acc.platform, true) : ""}<span class="tag">${esc(kind)}</span></div>
        </div>
      </div>`;
    };

    function renderBody(list) {
      if (!list.length) return emptyState("folder", "还没有已发布素材", "完成定稿发布后，内容会进入这里供团队共享和下载");
      // 指定账号：直接平铺
      if (fAcc !== "all") return `<div class="asset-grid">${list.map(cardHtml).join("")}</div>`;
      // 全部账号：按账号分组，支持折叠
      const byAcc = new Map();
      list.forEach(a => { const k = a.accountId || "__none"; if (!byAcc.has(k)) byAcc.set(k, []); byAcc.get(k).push(a); });
      const order = state.accounts.map(a => a.id).filter(id => byAcc.has(id));
      if (byAcc.has("__none")) order.push("__none");
      return order.map(id => {
        const acc = id === "__none" ? null : accountById(id);
        const items = byAcc.get(id);
        const collapsed = collapsedAcc.has(id);
        const imgCount = acc ? accountImageAssets(id).length : 0;
        return `<section class="acc-sec ${collapsed ? "collapsed" : ""}">
          <div class="acc-sec-head">
            <button class="acc-sec-main" data-accsec="${id}">
              <span class="chev">${icon("chevronDown", 13)}</span>
              ${acc ? `<span class="acc-sec-ava" style="background:${gradFor(acc.name)}">${esc(acc.name[0])}</span>` : `<span class="acc-sec-ava" style="background:var(--line-2)">?</span>`}
              <b>${esc(acc?.name || "未归属账号")}</b>
              ${acc ? `<span class="tag">${groupOf(acc)}</span>${platChip(acc.platform, true)}` : ""}
              <em>${items.length} 个</em>
            </button>
            ${acc && imgCount ? `<button class="btn ghost sm" data-export-del-acc="${id}">${icon("download", 12)} 导出并清空图片 (${imgCount})</button>` : ""}
          </div>
          ${collapsed ? "" : `<div class="asset-grid">${items.map(cardHtml).join("")}</div>`}
        </section>`;
      }).join("");
    }

    const wire = () => {
      $("#avSearch", root).addEventListener("input", e => { fQ = e.target.value; draw(); setTimeout(() => { const i = $("#avSearch", root); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 0); });
      $$("[data-fkind]", root).forEach(b => b.addEventListener("click", () => { fKind = b.dataset.fkind; draw(); }));
      $$("[data-facc]", root).forEach(b => b.addEventListener("click", () => { fAcc = b.dataset.facc; draw(); }));
      root.querySelector("[data-acc-more]")?.addEventListener("click", () => { accFilterExpanded = !accFilterExpanded; draw(); });
      root.querySelector("[data-go-delivery]")?.addEventListener("click", () => { location.hash = "#/delivery"; });
      $$("[data-export-del-acc]", root).forEach(b => b.addEventListener("click", e => {
        e.stopPropagation();
        withLoading(e.currentTarget, async () => {
          const n = await exportAndPurgeAccountImages(e.currentTarget.dataset.exportDelAcc);
          if (n) draw();
        }, "导出中…");
      }));
      $$("[data-accsec]", root).forEach(b => b.addEventListener("click", () => {
        const id = b.dataset.accsec;
        collapsedAcc.has(id) ? collapsedAcc.delete(id) : collapsedAcc.add(id);
        draw();
      }));

      $$(".asset-card", root).forEach(card => {
        const a = state.assets.find(x => x.id === card.dataset.aid);
        if (!a) return;
        const img = card.querySelector(".ac-thumb img");
        if (img) img.addEventListener("click", () => openLightbox(img, urlFor(a), a.name));
        card.querySelector('[data-aact="download"]').addEventListener("click", () => downloadAsset(a));
        card.querySelector('[data-aact="rename"]').addEventListener("click", async () => {
          const name = await promptModal({ title: "重命名素材", value: a.name });
          if (name) { a.name = name; save("assets"); draw(); }
        });
        card.querySelector('[data-aact="tag"]').addEventListener("click", async () => {
          const t = await promptModal({ title: "添加标签（逗号分隔多个）", placeholder: "例如：角色版, 界面截图" });
          if (t) {
            t.split(/[,，]/).map(s => s.trim()).filter(Boolean).forEach(tag => { a.tags = a.tags || []; if (!a.tags.includes(tag)) a.tags.push(tag); });
            save("assets"); draw();
          }
        });
        card.querySelector('[data-aact="del"]').addEventListener("click", async () => {
          const ok = await confirmModal({ title: `删除素材「${a.name}」？`, danger: true, okText: "删除" });
          if (ok) { await removeAsset(a.id); draw(); }
        });
      });
    };
    draw();
  }
};
