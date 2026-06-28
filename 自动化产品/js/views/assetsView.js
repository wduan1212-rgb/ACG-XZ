/* 共享资产库：只展示已发布/已交付内容；草稿、口播和生成中素材留在账号资产/草稿链路 */

import { $, $$, esc, gradFor } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, accountById } from "../core/store.js";
import { searchAssets, thumbHtml, removeAsset, urlFor, assetCode } from "../domain/assets.js";
import { downloadAsset } from "../domain/delivery.js";
import { platChip, groupOf } from "../domain/accounts.js";
import { emptyState, promptModal, confirmModal, openLightbox } from "../ui/components.js";

let fAcc = "all", fTag = "all", fQ = "", fKind = "all";
const collapsedAcc = new Set();
const isSharedAsset = a => !!a?.delivered;
function deliveredTags(accountId = "all") {
  const set = new Set();
  state.assets.forEach(a => {
    if (!isSharedAsset(a)) return;
    if (accountId !== "all" && a.accountId !== accountId) return;
    (a.tags || []).forEach(t => set.add(t));
  });
  return [...set];
}

export const assetsView = {
  render(root) {
    // 从账号资产库跳来时预筛该账号
    if (state.ui.assetsFilterAccount) { fAcc = state.ui.assetsFilterAccount; fTag = "all"; fQ = ""; state.ui.assetsFilterAccount = null; }
    const draw = () => {
      let list = searchAssets({ accountId: fAcc, tag: fTag, q: fQ, includeDelivered: true })
        .filter(isSharedAsset)
        .sort((a, b) => (b.deliveredAt || b.createdAt || 0) - (a.deliveredAt || a.createdAt || 0));
      const tagsOfAsset = a => (a.tags || []).map(t => String(t || ""));
      const isBgmAsset = a => tagsOfAsset(a).some(t => /^(BGM|音乐库)$/.test(t)) && !tagsOfAsset(a).some(t => /口播音频|声线参考|统一参考音频/.test(t));
      if (fKind === "bgm") list = list.filter(isBgmAsset);
      if (fKind === "screen") list = list.filter(a => a.type === "视频" || (a.tags || []).some(t => /录屏|屏幕录制|产品录屏/.test(t)));
      const tags = deliveredTags(fAcc);
      root.innerHTML = `
        <div class="assets-page">
          <div class="page-head">
            <div><div class="eyebrow">共享素材库 · 发布后入库</div>
            <h2>只展示已发布/已交付内容；草稿口播和生成中视频留在个人链路</h2></div>
            <div class="head-actions">
              <span class="tag">${icon("package", 13)} 发布后自动进入共享库</span>
              <button class="btn ghost" data-go-delivery>${icon("package", 14)} 去发布清单</button>
            </div>
          </div>
          <div class="filter-bar card">
            <div class="fb-search">${icon("search", 14)}<input id="avSearch" placeholder="搜索素材名 / 标签" value="${esc(fQ)}" /></div>
            <div class="fb-row">
              <button class="chip ${fKind === "all" ? "on" : ""}" data-fkind="all">全部发布素材</button>
              <button class="chip ${fKind === "bgm" ? "on" : ""}" data-fkind="bgm">${icon("music", 12)} 已发布 BGM</button>
              <button class="chip ${fKind === "screen" ? "on" : ""}" data-fkind="screen">${icon("film", 12)} 已发布录屏</button>
            </div>
            <div class="fb-row">
              <button class="chip ${fAcc === "all" ? "on" : ""}" data-facc="all">全部账号</button>
              ${state.accounts.map(a => `<button class="chip ${fAcc === a.id ? "on" : ""}" data-facc="${a.id}">${esc(a.name)}</button>`).join("")}
            </div>
            <div class="fb-row">
              <button class="chip ${fTag === "all" ? "on" : ""}" data-ftag="all">全部标签</button>
              ${tags.map(t => `<button class="chip ${fTag === t ? "on" : ""}" data-ftag="${esc(t)}"># ${esc(t)}</button>`).join("")}
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
          <div class="ac-tags">${acc ? platChip(acc.platform, true) : ""}${(a.tags || []).slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join("") || `<span class="tag muted-tag">未打标签</span>`}</div>
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
        return `<section class="acc-sec ${collapsed ? "collapsed" : ""}">
          <button class="acc-sec-head" data-accsec="${id}">
            <span class="chev">${icon("chevronDown", 13)}</span>
            ${acc ? `<span class="acc-sec-ava" style="background:${gradFor(acc.name)}">${esc(acc.name[0])}</span>` : `<span class="acc-sec-ava" style="background:var(--line-2)">?</span>`}
            <b>${esc(acc?.name || "未归属账号")}</b>
            ${acc ? `<span class="tag">${groupOf(acc)}</span>${platChip(acc.platform, true)}` : ""}
            <em>${items.length} 个</em>
          </button>
          ${collapsed ? "" : `<div class="asset-grid">${items.map(cardHtml).join("")}</div>`}
        </section>`;
      }).join("");
    }

    const wire = () => {
      $("#avSearch", root).addEventListener("input", e => { fQ = e.target.value; draw(); setTimeout(() => { const i = $("#avSearch", root); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 0); });
      $$("[data-fkind]", root).forEach(b => b.addEventListener("click", () => { fKind = b.dataset.fkind; draw(); }));
      $$("[data-facc]", root).forEach(b => b.addEventListener("click", () => { fAcc = b.dataset.facc; fTag = "all"; draw(); }));
      $$("[data-ftag]", root).forEach(b => b.addEventListener("click", () => { fTag = b.dataset.ftag; draw(); }));
      root.querySelector("[data-go-delivery]")?.addEventListener("click", () => { location.hash = "#/delivery"; });
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
