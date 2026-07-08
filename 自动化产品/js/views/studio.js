/* 创作空间：账号主页 + 链路分发（图文 images/review；视频 workshop/cut/review） */

import { $, $$, esc, gradFor, timeAgo, wireDropZone, fileToDataUrl } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, activeAccount, activeProduction, productionById, canManageAccounts } from "../core/store.js";
import { platChip, monthlyBarHtml, modeLabel, charBoardOf, accountAssets, deleteAccount } from "../domain/accounts.js";
import { STAGES, flowOf, normalizeStage, stageDone, statusPill, createProduction, productionsOf, deleteProduction, isVideoWorkshop } from "../domain/productions.js";
import { emptyState, toast, confirmModal, openLightbox } from "../ui/components.js";
import { go } from "../core/router.js";
import { openProductionDrawer, stagePage } from "./prodDrawer.js";
import { urlFor, thumbHtml, assetCode, addAssetFromFile, addAssetFromDataUrl } from "../domain/assets.js";
import { renderScriptPage } from "./chainScript.js";
import { renderSlotsPage } from "./chainBoards.js";
import { renderPromptsPage } from "./chainPrompts.js";
import { renderRenderPage } from "./chainRender.js";
import { renderWorkshopPage } from "./chainWorkshop.js";
import { renderCutPage } from "./chainCut.js?v=20260623-captions";
import { renderCopyPage, renderReviewPage } from "./chainCopy.js";

export const studioView = {
  render(root, { page }) {
    const acc = activeAccount();
    if (!acc) {
      root.innerHTML = emptyState("users", "还没有账号", "先创建第一个内容账号", `<button class="btn primary" data-open-create-account>${icon("plus", 14)} 创建账号</button>`);
      return;
    }
    if (!page || page === "home") return renderHome(root, acc);

    // 链路页需要一个在制 production
    const p = activeProduction();
    if (!p || p.accountId !== acc.id && !productionById(state.ui.activeProductionId)) {
      const mine = productionsOf(acc.id).filter(x => x.stage !== "delivered");
      if (mine.length) { state.ui.activeProductionId = mine[0].id; save("meta"); }
      else { toast("先开始一条新创作"); go("studio"); return; }
    }
    const prod = activeProduction();
    if (!prod) { go("studio"); return; }
    // 切换账号侧栏联动
    if (prod.accountId !== state.ui.activeAccountId) { state.ui.activeAccountId = prod.accountId; save("meta"); }

    const PAGES = {
      script: renderScriptPage,
      boards: (r, p2) => renderSlotsPage(r, p2, false),
      images: (r, p2) => renderSlotsPage(r, p2, true),
      prompts: renderPromptsPage,
      workshop: renderWorkshopPage,
      render: renderRenderPage,
      cut: renderCutPage,
      copy: renderCopyPage,
      review: renderReviewPage
    };
    // 链路类型守卫：所有视频号的 分镜/提示词/生成 统一进工坊
    let target = page;
    if (prod.mode === "图文" && ["script", "copy"].includes(page)) target = "images";
    if (isVideoWorkshop(prod) && ["script", "boards", "prompts", "render", "copy"].includes(page)) target = "workshop";
    if (!isVideoWorkshop(prod) && page === "workshop") target = "images";
    if (target !== page) { go("studio", target); return; }
    const fn = PAGES[target];
    if (!fn) { go("studio"); return; }
    fn(root, prod);
  }
};

/* ---------- 链路 stepper（链路页共用头部） ---------- */
const RETURN_LABEL = { agent: "返回批量创作", delivery: "返回发布清单", overview: "返回首页", assets: "返回整体资产", drafts: "返回草稿箱", studio: "返回账号主页" };

export function stepperHtml(p, currentPage) {
  const flow = flowOf(p);
  const rt = state.ui.returnTo;
  return `<div class="chain-stepper">
    ${rt ? `<button class="cs-back" data-cs-back>${icon("arrowLeft", 14)} ${RETURN_LABEL[rt.zone] || "返回"}</button>` : ""}
    ${flow.map((st, i) => {
      const done = stageDone(p, st);
      const cur = pageStage(currentPage) === st;
      const fail = cur && p.stageStatus === "failed";
      return `<button class="cs-step ${cur ? "is-current" : ""} ${done ? "is-done" : ""} ${fail ? "is-fail" : ""}" data-chain="${stagePageName(st)}">
        <span class="cs-dot">${done && !cur ? icon("check", 11) : `<i>${i + 1}</i>`}</span>
        <span class="cs-label">${STAGES[st].label}</span>
      </button>${i < flow.length - 1 ? `<span class="cs-link ${done ? "on" : ""}"></span>` : ""}`;
    }).join("")}
    <span class="cs-spacer"></span>
    <span class="cs-prod" title="${esc(p.topic)}">${icon("film", 13)} ${esc((p.artifacts.copy.title || p.title || p.topic || "未命名").slice(0, 16))}</span>
  </div>`;
}
const pageStage = page => page === "render" ? "render" : page;
const stagePageName = st => st;

export function wireStepper(root) {
  $$("[data-chain]", root).forEach(b => b.addEventListener("click", () => go("studio", b.dataset.chain)));
  const back = $("[data-cs-back]", root);
  if (back) back.addEventListener("click", () => {
    const rt = state.ui.returnTo;
    state.ui.returnTo = null; save("meta");
    if (rt && rt.zone) go(rt.zone, rt.page); else history.back();
  });
}

/* ---------- 账号主页 ---------- */
function renderHome(root, acc) {
  if (state.ui.returnTo) { state.ui.returnTo = null; save("meta"); }   // 到账号主页即清掉微调返回态
  const prods = productionsOf(acc.id);
  const inflight = prods.filter(p => p.stage !== "delivered");
  const delivered = prods.filter(p => p.stage === "delivered").slice(0, 6);
  const flow = flowOf(acc);
  const board = charBoardOf(acc);
  const admin = canManageAccounts();
  const accAssets = accountAssets(acc.id);
  const avatarUrl = acc.avatarAssetId ? urlFor(acc.avatarAssetId) : "";
  const styleRefUrl = acc.imageStyleAssetId ? urlFor(acc.imageStyleAssetId) : "";
  const charRefUrl = board ? urlFor(board) : "";
  const styleText = String(acc.styleProfile || acc.lockedStyle || "")
    .replace(/^整体风格\s*[:：]\s*/g, "")
    .replace(/^账号风格\s*[:：]\s*/g, "")
    .trim();

  root.innerHTML = `
    <div class="studio-home">
      <header class="sh-head card">
        <div class="sh-id">
          <div class="sh-ref-stack ${admin ? "can-edit" : ""}">
            <button class="sh-ref-card avatar" type="button" data-sh-ref="avatar" title="${admin ? "拖入 / 上传账号头像" : "账号头像"}">
              ${avatarUrl ? `<img src="${avatarUrl}" alt="${esc(acc.name)}"/>` : `<i style="background:${gradFor(acc.name)}">${esc(acc.name[0])}</i>`}
              <span>头像</span>
              ${admin ? `<input type="file" accept="image/*" hidden id="shAvatarUp" />` : ""}
            </button>
            ${acc.mode === "图文" ? `<button class="sh-ref-card style" type="button" data-sh-ref="style" title="${admin ? "拖入 / 上传成图风格参考" : "成图风格参考"}">
              ${styleRefUrl ? `<img src="${styleRefUrl}" alt="成图风格参考"/>` : `<em>${icon("image", 16)}</em>`}
              <span>风格</span>
              ${admin ? `<input type="file" accept="image/*" hidden id="shStyleRefUp" />` : ""}
            </button>` : ""}
            ${acc.mode === "视频" ? `<button class="sh-ref-card style role" type="button" data-sh-ref="role" title="${admin ? "拖入 / 上传角色形象" : "角色形象"}">
              ${charRefUrl ? `<img src="${charRefUrl}" alt="角色形象"/>` : `<em>${icon("user", 16)}</em>`}
              <span>角色</span>
              ${admin ? `<input type="file" accept="image/*" hidden id="shRoleRefUp" />` : ""}
            </button>` : ""}
          </div>
          <div class="sh-meta">
            <h2>${esc(acc.name)}</h2>
            <div class="sh-sub">${platChip(acc.platform, true)}<span class="tag">${modeLabel(acc)}</span>${monthlyBarHtml(acc, true)}</div>
            <p class="sh-pos">创作风格：${esc(styleText || "未设置")}</p>
          </div>
        </div>
        <div class="sh-actions">
          ${admin ? `<button class="btn ghost" data-sh="edit">${icon("edit", 14)} 编辑账号</button><button class="btn ghost danger" data-sh="delete">${icon("trash", 14)} 删除账号</button>` : ""}
          <button class="btn primary" data-sh="new">${icon("plus", 14)} 开始新创作</button>
        </div>
      </header>

      <section class="sh-flow card">
        <div class="card-head"><b>创作链路</b><em>${acc.mode === "图文" ? "图文创作台（文案标题/图卡提示词/成图）→ 审核 → 交付" : "文案分镜（选题/标题文案/口播/提示词）→ 智能混剪+BGM → 审核 → 交付"}</em></div>
        <div class="sh-flow-steps">
          ${flow.map((st, i) => `
            <button class="fs-card" data-sh-flow="${st}" style="--d:${i * 40}ms">
              <span class="fs-ico">${icon(STAGES[st].icon, 18)}<i class="fs-num">${i + 1}</i></span>
              <b>${STAGES[st].label}</b>
            </button>${i < flow.length - 1 ? `<span class="fs-arrow">${icon("chevronRight", 14)}</span>` : ""}`).join("")}
        </div>
      </section>

      <section class="sh-prods card">
        <div class="card-head"><b>在制任务</b><em>${inflight.length} 条</em></div>
        ${inflight.length ? `<div class="sh-prod-list">${inflight.map(p => {
          const [label, cls] = statusPill(p);
          return `<div class="shp-row" data-prod="${p.id}">
            <span class="shp-stage">${icon(STAGES[p.stage].icon, 14)}</span>
            <span class="shp-main"><b>${esc(p.artifacts.copy.title || p.title || p.topic || "未命名创作")}</b>
            <em>${p.origin === "agent" ? "Agent 批次 · " : ""}${STAGES[p.stage].label} · ${timeAgo(p.updatedAt)}</em></span>
            <span class="status-pill ${cls}">${label}</span>
            <button class="icon-btn sm" data-prod-del="${p.id}" title="删除任务">${icon("trash", 13)}</button>
            <button class="btn ghost sm" data-prod-go="${p.id}">继续 ${icon("arrowRight", 12)}</button>
          </div>`;
        }).join("")}</div>` : emptyState("film", "没有在制任务", "点击「开始新创作」或让 Agent 批量发起")}
      </section>

      <section class="sh-assets card">
        <div class="card-head"><b>账号资产库</b><div class="head-actions"><em>${accAssets.length} 个素材</em>
          <label class="link-btn">${icon("upload", 12)} 上传<input type="file" accept="image/*,video/*,audio/*" multiple hidden id="shAssetUp" /></label>
          <button class="link-btn" id="shAssetAll">整体资产 ${icon("arrowRight", 12)}</button></div></div>
        ${accAssets.length ? `<div class="sh-asset-grid">${accAssets.slice(0, 14).map(a => `
          <div class="sh-asset" data-aid="${a.id}" title="${esc(a.name)}">
            ${thumbHtml(a)}${a.seq ? `<span class="sh-asset-seq">${assetCode(a)}</span>` : ""}${a.type === "视频" ? `<span class="ac-play">${icon("play", 12)}</span>` : ""}
          </div>`).join("")}${accAssets.length > 14 ? `<button class="sh-asset more" id="shAssetMore">+${accAssets.length - 14}</button>` : ""}</div>`
        : `<div class="sh-asset-drop" id="shAssetDrop">${icon("folder", 18)}<span>该账号还没有素材，拖图到此或点上方上传 · 生成时可 @ 调用</span></div>`}
      </section>

      <section class="sh-delivered card">
        <div class="card-head"><b>最近交付</b><button class="link-btn" data-sh="delivery">发布清单 ${icon("arrowRight", 12)}</button></div>
        ${delivered.length ? `<div class="sh-dl-grid">${delivered.map(p => {
          const items = (p.mode === "图文" ? p.artifacts.images.items : p.artifacts.boards.items) || [];
          const cover = items.find(x => x.assetId);
          const u = cover ? urlFor(cover.assetId) : null;
          return `<button class="sh-dl" data-prod="${p.id}">
            ${u ? `<img src="${u}"/>` : `<i style="background:${gradFor(p.title || p.id)}">${p.mode === "图文" ? "图" : "▶"}</i>`}
            <b>${esc(p.artifacts.copy.title || p.title)}</b><em>${esc(p.delivery?.name || "")}</em>
          </button>`;
        }).join("")}</div>` : `<div class="muted" style="padding:6px 2px">还没有交付记录</div>`}
      </section>
    </div>`;

  root.querySelectorAll("[data-prod-go]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    const p = productionById(b.dataset.prodGo);
    state.ui.activeProductionId = p.id; save("meta");
    go("studio", stagePage(p));
  }));
  root.querySelectorAll("[data-prod-del]").forEach(b => b.addEventListener("click", async e => {
    e.stopPropagation();
    const p = productionById(b.dataset.prodDel);
    const ok = await confirmModal({ title: `删除任务「${p.title || p.topic || "未命名"}」？`, body: "该任务的脚本/提示词等中间产物会被移除（已入库资产保留）。", danger: true, okText: "删除" });
    if (ok) {
      try {
        await deleteProduction(p.id);
        renderHome(root, acc);
      } catch (err) {
        toast("服务器删除失败，请刷新或重新登录后再试", "error");
      }
    }
  }));
  root.querySelectorAll("[data-prod]").forEach(el => el.addEventListener("click", () => openProductionDrawer(el.dataset.prod)));

  // 账号资产库
  async function uploadToAccount(files) {
    let n = 0;
    for (const f of Array.from(files)) { await addAssetFromFile(acc.id, f); n++; }
    if (n) { toast(`已上传 ${n} 个素材到「${acc.name}」资产库`); renderHome(root, acc); }
  }
  const shUp = $("#shAssetUp", root);
  if (shUp) shUp.addEventListener("change", e => uploadToAccount(e.target.files));
  const goAllAssets = () => { state.ui.assetsFilterAccount = acc.id; go("assets"); };
  const shAll = $("#shAssetAll", root); if (shAll) shAll.addEventListener("click", goAllAssets);
  const shMore = $("#shAssetMore", root); if (shMore) shMore.addEventListener("click", goAllAssets);
  root.querySelectorAll(".sh-asset[data-aid]").forEach(el => {
    const a = state.assets.find(x => x.id === el.dataset.aid);
    if (!a) return;
    const img = el.querySelector("img");
    el.addEventListener("click", () => { if (img && a.type !== "音频") openLightbox(img, urlFor(a), a.name); else goAllAssets(); });
  });
  const drop = $("#shAssetDrop", root);
  if (drop) wireDropZone(drop, files => uploadToAccount(files), { filesOnly: true });

  root.querySelectorAll("[data-sh-flow]").forEach(b => b.addEventListener("click", () => {
    const inflight2 = productionsOf(acc.id).filter(p => p.stage !== "delivered");
    if (!inflight2.length) { toast("先开始一条新创作"); return; }
    state.ui.activeProductionId = inflight2[0].id; save("meta");
    go("studio", b.dataset.shFlow);
  }));
  const onAct = {
    new: () => {
      const p = createProduction({ accountId: acc.id, origin: "manual" });
      state.ui.activeProductionId = p.id; save("meta");
      go("studio", acc.mode === "视频" ? "workshop" : "images");
    },
	    edit: () => document.dispatchEvent(new CustomEvent("open-account-dialog", { detail: { accountId: acc.id } })),
	    delete: async () => {
	      const ok = await confirmModal({ title: `删除账号「${acc.name}」？`, body: "这个账号下的在制任务与资产会一起删除。这个操作不会影响其他账号。", danger: true, okText: "删除账号" });
	      if (!ok) return;
	      deleteAccount(acc.id);
	      toast("账号已删除");
	      go("studio");
	    },
    delivery: () => go("delivery")
  };
  root.querySelectorAll("[data-sh]").forEach(b => b.addEventListener("click", () => onAct[b.dataset.sh] && onAct[b.dataset.sh]()));

  async function setHomeRef(kind, file) {
    if (!admin || !file || !file.type.startsWith("image/")) return;
    const dataUrl = await fileToDataUrl(file);
    const name = kind === "avatar" ? `${acc.name}_头像` : kind === "role" ? `${acc.name}_角色形象` : `${acc.name}_成图风格参考`;
    const tags = kind === "avatar" ? ["账号头像"] : kind === "role" ? ["角色形象", "角色版"] : ["成图风格参考"];
    const a = await addAssetFromDataUrl(acc.id, {
      name,
      tags,
      dataUrl
    });
    if (kind === "avatar") acc.avatarAssetId = a.id;
    else if (kind === "role") acc.charBoardAssetId = a.id;
    else acc.imageStyleAssetId = a.id;
    save("accounts");
    toast(kind === "avatar" ? "头像已更新" : kind === "role" ? "角色形象已更新" : "成图风格参考已更新");
    renderHome(root, acc);
  }

  root.querySelectorAll("[data-sh-ref]").forEach(btn => {
    const kind = btn.dataset.shRef;
    const currentUrl = kind === "avatar" ? avatarUrl : kind === "role" ? charRefUrl : styleRefUrl;
    const currentName = kind === "avatar" ? `${acc.name} 头像` : kind === "role" ? `${acc.name} 角色形象` : `${acc.name} 成图风格参考`;
    if (admin) {
      const input = btn.querySelector("input[type=file]");
      btn.addEventListener("click", e => {
        const img = btn.querySelector("img");
        if (currentUrl && e.target.closest("img")) {
          openLightbox(img, currentUrl, currentName);
          return;
        }
        input && input.click();
      });
      if (input) input.addEventListener("change", e => setHomeRef(kind, e.target.files[0]));
      wireDropZone(btn, files => setHomeRef(kind, Array.from(files).find(f => f.type.startsWith("image/"))), { filesOnly: true });
    } else if (currentUrl) {
      const img = btn.querySelector("img");
      btn.addEventListener("click", () => img && openLightbox(img, currentUrl, currentName));
    }
  });
}
