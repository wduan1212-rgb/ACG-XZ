/* 草稿箱（独立页）：本人名下、尚未发布的全部 production（进行中 / 失败 / 已生成待发布）。 */

import { $, $$, esc, timeAgo } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, ownedBy, accountById, productionById } from "../core/store.js";
import { STAGES, statusPill, deleteProduction } from "../domain/productions.js";
import { urlFor } from "../domain/assets.js";
import { openProductionDrawer, stagePage } from "./prodDrawer.js?v=20260716-v86-1";
import { emptyState, toast, confirmModal, removeWithMotion } from "../ui/components.js";
import { go } from "../core/router.js";

function draftProductions() {
  return state.productions
    .filter(p => ownedBy(p) && p.stage !== "delivered")
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function draftRowHtml(p, selected) {
  const [label, cls] = statusPill(p);
  const items = (p.mode === "图文" ? p.artifacts.images.items : p.artifacts.boards.items) || [];
  const cover = items.find(x => x.assetId);
  const u = cover ? urlFor(cover.assetId) : null;
  return `<div class="draft-row ${p.stageStatus === "failed" ? "fail" : ""}" data-draft="${p.id}">
    <input class="draft-check" type="checkbox" data-draft-check="${p.id}" ${selected.has(p.id) ? "checked" : ""} aria-label="选择草稿" />
    <span class="draft-cover">${u ? `<img src="${u}"/>` : `<i class="draft-cover-empty">${icon(p.mode === "图文" ? "image" : "video", 15)}</i>`}</span>
    <span class="draft-main"><b>${esc(p.artifacts.copy.title || p.title || p.topic || "未命名创作")}</b><em>${STAGES[p.stage]?.label || p.stage} · ${timeAgo(p.updatedAt)}</em></span>
    <span class="status-pill ${cls}">${label}</span>
    <button class="btn ghost sm" data-draft-go="${p.id}">继续 ${icon("arrowRight", 12)}</button>
    <button class="icon-btn sm" data-draft-del="${p.id}" title="删除草稿">${icon("trash", 13)}</button>
  </div>`;
}

export const draftsView = {
  render(root) {
    const selected = new Set();
    const collapsed = new Set();
    const draw = () => {
      const drafts = draftProductions();
      const byDate = new Map();
      drafts.forEach(p => {
        const d = new Date(p.updatedAt || Date.now());
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push(p);
      });
      const failed = drafts.filter(p => p.stageStatus === "failed").length;

      root.innerHTML = `
        <div class="drafts-page">
          <div class="page-head">
            <div><div class="eyebrow">草稿箱</div>
            <h2>未发布的进行中 / 失败 / 已生成待发布</h2></div>
            <div class="head-actions">
              <span class="tag">${icon("inbox", 12)} ${drafts.length} 条草稿</span>
              ${failed ? `<span class="tag warn">${icon("alert", 11)} ${failed} 条失败</span>` : ""}
              <button class="btn danger ghost sm" id="draftBulkDelete" ${selected.size ? "" : "hidden"}>${icon("trash", 12)} 删除已选 <span>${selected.size}</span></button>
            </div>
          </div>
          ${drafts.length ? `<div class="draft-groups page draft-timeline">${[...byDate.entries()].map(([date, list]) => `
            <section class="draft-acc card ${collapsed.has(date) ? "collapsed" : ""}">
              <button class="draft-acc-head" data-draft-fold="${date}"><span class="draft-line-marker"></span><b>${date}</b><em>${list.length} 条</em>${icon("chevronDown", 14)}</button>
              <div class="draft-date-shell"><div class="draft-date-list">${list.map(p => draftRowHtml(p, selected)).join("")}</div></div>
            </section>`).join("")}</div>`
          : emptyState("inbox", "草稿箱是空的", "在批量创作 / 单号创作里发起的内容，未发布前都会先存放在这里。点「定稿并发布」后才进入发布清单。")}
        </div>`;

      $("#draftBulkDelete", root)?.addEventListener("click", async () => {
        const ids = [...selected];
        const ok = await confirmModal({ title: `删除已选 ${ids.length} 条草稿？`, body: "草稿及其未发布中间产物会被移除。", danger: true, okText: "删除" });
        if (!ok) return;
        const rows = ids.map(id => root.querySelector(`[data-draft="${CSS.escape(id)}"]`)).filter(Boolean);
        await removeWithMotion(rows, async () => {
          for (const id of ids) await deleteProduction(id);
        });
        selected.clear(); toast("已删除所选草稿");
        if (!draftProductions().length) draw();
      });
      $$('[data-draft-check]', root).forEach(b => b.addEventListener("click", e => {
        e.stopPropagation();
        if (b.checked) selected.add(b.dataset.draftCheck); else selected.delete(b.dataset.draftCheck);
        const bulk = $("#draftBulkDelete", root);
        if (bulk) {
          bulk.hidden = selected.size === 0;
          const count = bulk.querySelector("span");
          if (count) count.textContent = String(selected.size);
        }
      }));
      $$('[data-draft-fold]', root).forEach(b => b.addEventListener("click", () => {
        const date = b.dataset.draftFold;
        const section = b.closest(".draft-acc");
        if (!section) return;
        if (collapsed.has(date)) collapsed.delete(date); else collapsed.add(date);
        section.classList.toggle("collapsed", collapsed.has(date));
      }));
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
        if (ok) {
          try {
            const row = b.closest("[data-draft]");
            await removeWithMotion(row, () => deleteProduction(p.id));
            toast("已删除草稿");
            if (!draftProductions().length) draw();
          } catch (err) {
            toast("服务器删除失败，请刷新或重新登录后再试", "error");
          }
        }
      }));
      $$("[data-draft]", root).forEach(el => el.addEventListener("click", e => {
        if (e.target.closest("button")) return;
        openProductionDrawer(el.dataset.draft);
      }));
    };
    draw();
  }
};
