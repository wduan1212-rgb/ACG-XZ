/* 草稿箱（独立页）：本人名下、尚未发布的全部 production（进行中 / 失败 / 已生成待发布）。
   与「发布清单」分开——草稿箱按账号隔离、仅本人可见；发布清单是共享的成片库。 */

import { $, $$, esc, gradFor, timeAgo } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, ownedBy, accountById, productionById } from "../core/store.js";
import { STAGES, statusPill, deleteProduction } from "../domain/productions.js";
import { urlFor } from "../domain/assets.js";
import { openProductionDrawer, stagePage } from "./prodDrawer.js";
import { emptyState, toast, confirmModal } from "../ui/components.js";
import { go } from "../core/router.js";

function draftProductions() {
  return state.productions
    .filter(p => ownedBy(p) && p.stage !== "delivered")
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function draftRowHtml(p) {
  const [label, cls] = statusPill(p);
  const items = (p.mode === "图文" ? p.artifacts.images.items : p.artifacts.boards.items) || [];
  const cover = items.find(x => x.assetId);
  const u = cover ? urlFor(cover.assetId) : null;
  return `<div class="draft-row ${p.stageStatus === "failed" ? "fail" : ""}" data-draft="${p.id}">
    <span class="draft-cover">${u ? `<img src="${u}"/>` : `<i style="background:${gradFor(p.title || p.id)}">${p.mode === "图文" ? "图" : "▶"}</i>`}</span>
    <span class="draft-main"><b>${esc(p.artifacts.copy.title || p.title || p.topic || "未命名创作")}</b><em>${STAGES[p.stage]?.label || p.stage} · ${timeAgo(p.updatedAt)}</em></span>
    <span class="status-pill ${cls}">${label}</span>
    <button class="btn ghost sm" data-draft-go="${p.id}">继续 ${icon("arrowRight", 12)}</button>
    <button class="icon-btn sm" data-draft-del="${p.id}" title="删除草稿">${icon("trash", 13)}</button>
  </div>`;
}

export const draftsView = {
  render(root) {
    const draw = () => {
      const drafts = draftProductions();
      const byAcc = new Map();
      drafts.forEach(p => { const a = accountById(p.accountId); const k = a ? a.id : "?"; if (!byAcc.has(k)) byAcc.set(k, { acc: a, list: [] }); byAcc.get(k).list.push(p); });
      const failed = drafts.filter(p => p.stageStatus === "failed").length;

      root.innerHTML = `
        <div class="drafts-page">
          <div class="page-head">
            <div><div class="eyebrow">草稿箱</div>
            <h2>未发布的进行中 / 失败 / 已生成待发布 · 按账号隔离仅本人可见</h2></div>
            <div class="head-actions">
              <span class="tag">${icon("inbox", 12)} ${drafts.length} 条草稿</span>
              ${failed ? `<span class="tag warn">${icon("alert", 11)} ${failed} 条失败</span>` : ""}
            </div>
          </div>
          ${drafts.length ? `<div class="draft-groups page">${[...byAcc.values()].map(({ acc, list }) => `
            <section class="draft-acc card">
              <div class="draft-acc-head"><span class="dot sm" style="background:${gradFor(acc?.name || "")}"></span><b>${esc(acc?.name || "未知账号")}</b><em>${list.length} 条</em></div>
              ${list.map(draftRowHtml).join("")}
            </section>`).join("")}</div>`
          : emptyState("inbox", "草稿箱是空的", "在批量创作 / 单号创作里发起的内容，未发布前都会先存放在这里。点「定稿并发布」后才进入发布清单。")}
        </div>`;

      $$("[data-draft-go]", root).forEach(b => b.addEventListener("click", e => {
        e.stopPropagation();
        const p = productionById(b.dataset.draftGo); if (!p) return;
        state.ui.activeAccountId = p.accountId; state.ui.activeProductionId = p.id; save("meta");
        go("studio", stagePage(p));
      }));
      $$("[data-draft-del]", root).forEach(b => b.addEventListener("click", async e => {
        e.stopPropagation();
        const p = productionById(b.dataset.draftDel); if (!p) return;
        const ok = await confirmModal({ title: `删除草稿「${p.artifacts.copy.title || p.title || p.topic || "未命名"}」？`, body: "该任务的脚本 / 分镜等中间产物会被移除（已发布资产不受影响）。", danger: true, okText: "删除" });
        if (ok) { deleteProduction(p.id); toast("已删除草稿"); draw(); }
      }));
      $$("[data-draft]", root).forEach(el => el.addEventListener("click", e => {
        if (e.target.closest("button")) return;
        openProductionDrawer(el.dataset.draft);
      }));
    };
    draw();
  }
};
