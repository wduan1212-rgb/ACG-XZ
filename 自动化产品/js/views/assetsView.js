/* 共享资产库：展示已发布/已交付内容，以及发布后沉淀的生成图；草稿、口播和生成中素材留在账号资产/草稿链路 */

import { $, $$, esc, buildZipBlob, downloadBlob, wireDropZone } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, accountById } from "../core/store.js";
import { searchAssets, thumbHtml, removeAsset, urlFor, assetCode, assetU8, addAssetFromFile, inferAssetFileMime, isBgmAsset, isEditingMaterialAsset } from "../domain/assets.js";
import { downloadAsset } from "../domain/delivery.js?v=20260727-v118-7";
import { platChip, groupOf, isAvatarAsset } from "../domain/accounts.js";
import { emptyState, promptModal, confirmModal, openLightbox, openModal, toast, withLoading, removeWithMotion } from "../ui/components.js?v=20260727-v118-7";
import { renderSupplierAccounts } from "./supplierViews.js?v=20260727-v118-7";

let fAcc = "all", fQ = "", fKind = "all", libraryMode = "drafts", collapseInitialized = false;
let activeAssetsController = null;
const collapsedAcc = new Set();
const isSharedAsset = a => !!a?.delivered || !!a?.shared;
const assetKind = a => a.type === "音频"
  ? "音频"
  : a.type === "视频" || (a.tags || []).some(t => /视频|成片/.test(t))
    ? "视频"
    : "图文";
const cleanName = s => String(s || "未命名").replace(/[\\/:*?"<>|#]+/g, "_").replace(/\s+/g, "_").slice(0, 60);
const accountArchivableAssets = accountId => state.assets
  .filter(a => isSharedAsset(a) && a.accountId === accountId && ["图片", "视频"].includes(a.type) && !isAvatarAsset(a))
  .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
export const ASSET_LIBRARY_OPTIONS = Object.freeze([
  Object.freeze({ key: "shared", label: "账号资产", shortLabel: "账号资产" }),
  Object.freeze({ key: "drafts", label: "草稿箱", shortLabel: "草稿箱" }),
  Object.freeze({ key: "bgm", label: "BGM 库", shortLabel: "BGM" }),
  Object.freeze({ key: "material", label: "剪辑素材库", shortLabel: "剪辑素材" }),
  Object.freeze({ key: "voice", label: "语音素材库", shortLabel: "语音素材" }),
  Object.freeze({ key: "reference", label: "总参考音频库", shortLabel: "参考音频" }),
]);
const libraryLabels = Object.fromEntries(ASSET_LIBRARY_OPTIONS.map(option => [option.key, option.label]));
const assetLibraryKeys = new Set(ASSET_LIBRARY_OPTIONS.map(option => option.key));
const libraryTabsHtml = () => `<div class="asset-library-tabs text-switch"><button class="${libraryMode === "shared" ? "on is-active" : ""}" data-library="shared">账号资产</button><button class="${libraryMode === "drafts" ? "on is-active" : ""}" data-library="drafts">草稿箱</button><button class="${libraryMode === "bgm" ? "on is-active" : ""}" data-library="bgm">BGM</button><button class="${libraryMode === "material" ? "on is-active" : ""}" data-library="material">剪辑素材</button><button class="${libraryMode === "voice" ? "on is-active" : ""}" data-library="voice">语音素材</button><button class="${libraryMode === "reference" ? "on is-active" : ""}" data-library="reference">参考音频</button></div>`;
// “全局”仅表示跨账号平铺；私有语音/参考音频仍由 searchAssets 的 ownedBy 边界隔离。
const isGlobalLibrary = () => ["bgm", "material", "voice", "reference"].includes(libraryMode);

export function getAssetLibraryModel() {
  return {
    value: libraryMode,
    options: ASSET_LIBRARY_OPTIONS.map(option => ({ ...option })),
  };
}

function emitAssetLibraryModel() {
  if (typeof window === "undefined" || typeof window.CustomEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("xingzhen:asset-library-model", {
    detail: getAssetLibraryModel(),
  }));
}

export function setAssetLibraryMode(nextMode, { redraw = true, resetKind = true } = {}) {
  const normalized = String(nextMode || "").trim();
  if (!assetLibraryKeys.has(normalized)) return getAssetLibraryModel();
  const changed = normalized !== libraryMode;
  libraryMode = normalized;
  if (changed && resetKind) fKind = "all";
  if (redraw && activeAssetsController?.draw) activeAssetsController.draw();
  emitAssetLibraryModel();
  return getAssetLibraryModel();
}

async function exportAndPurgeAccountFiles(accountId) {
  const acc = accountById(accountId);
  const files = accountArchivableAssets(accountId);
  if (!files.length) { toast("这个账号暂无可归档的共享图片或视频"); return 0; }
  const ok = await confirmModal({
    title: `导出并清空「${esc(acc?.name || "该账号")}」的共享文件？`,
    body: `<p>将先下载 ${files.length} 个图片/视频文件的压缩包，随后从整体资产和服务器文件中删除这些文件。发布记录、账号资料、头像和音频不会删除。</p>`,
    okText: "导出并清空",
    danger: true
  });
  if (!ok) return 0;
  const entries = [];
  for (let i = 0; i < files.length; i++) {
    const a = files[i];
    const d = await assetU8(a.id);
    if (d) entries.push({ name: `${String(i + 1).padStart(3, "0")}_${cleanName(a.name)}.${d.ext}`, u8: d.u8 });
  }
  if (!entries.length) { toast("没有拿到可打包的文件，已取消清空", "error"); return 0; }
  downloadBlob(`整体资产_${cleanName(acc?.name || accountId)}_文件归档_${Date.now()}.zip`, buildZipBlob(entries));
  for (const a of files) await removeAsset(a.id);
  toast(`已导出并清空 ${files.length} 个共享文件`);
  return files.length;
}

export const assetsView = {
  getLibraryModel: getAssetLibraryModel,
  setLibraryMode: setAssetLibraryMode,
  render(root) {
    if (["supplier", "supplier_parent"].includes(state.role)) {
      activeAssetsController?.root?.__assetDropController?.abort?.();
      activeAssetsController?.root?.querySelector?.(".asset-workbench-dock")?.remove?.();
      if (activeAssetsController?.root === root) activeAssetsController = null;
      renderSupplierAccounts(root);
      return;
    }
    // 从账号资产库跳来时预筛该账号
    let includeAccountPrivate = Boolean(state.ui.assetsIncludePrivate);
    if (state.ui.assetsFilterAccount) {
      fAcc = state.ui.assetsFilterAccount;
      fQ = "";
      state.ui.assetsFilterAccount = null;
      state.ui.assetsIncludePrivate = false;
      save("meta");
    }
    const draw = () => {
      root.__assetDropController?.abort();
      root.__assetDropController = null;
      root.classList.remove("drag-over");
      delete root.dataset.dropHint;
      $("#assetsTopDock")?.remove();
      if (libraryMode === "drafts") {
        root.innerHTML = `<div class="assets-page"><div class="page-head"><div><div class="eyebrow">整体资产</div><h2>草稿箱</h2></div><div class="head-actions">${libraryTabsHtml()}</div></div><div class="asset-mode-stage" id="assetDraftsHost"></div></div>`;
        const topDock = $(".head-actions", root);
        const topbar = document.querySelector(".topbar");
        const topActions = document.querySelector(".top-actions");
        if (topDock && topbar && topActions) {
          topDock.id = "assetsTopDock";
          topDock.classList.add("topbar-assets-dock");
          topbar.insertBefore(topDock, topActions);
        }
        $$('[data-library]', $("#assetsTopDock") || root).forEach(button => button.addEventListener("click", () => {
          setAssetLibraryMode(button.dataset.library);
        }));
        import("./draftsView.js?v=20260727-v120-shell-8").then(({ draftsView }) => {
          const host = $("#assetDraftsHost", root);
          if (host) draftsView.render(host);
        });
        return;
      }
      let list = searchAssets({ accountId: isGlobalLibrary() ? "all" : fAcc, tag: "all", q: fQ, includeDelivered: true })
        .filter(a => !isAvatarAsset(a))
        .filter(a => libraryMode === "shared"
          ? (includeAccountPrivate && fAcc !== "all" ? a.accountId === fAcc : isSharedAsset(a))
          : libraryMode === "bgm"
            ? isBgmAsset(a)
            : libraryMode === "material"
              ? isEditingMaterialAsset(a)
              : libraryMode === "voice"
                ? (a.type === "音频" && (a.tags || []).some(t => /语音素材库|口播|tts/i.test(t)) && !(a.tags || []).some(t => /参考音频库/i.test(t)))
                : (a.type === "音频" && (a.tags || []).some(t => /参考音频库|声线参考/i.test(t))))
        .sort((a, b) => (b.deliveredAt || b.createdAt || 0) - (a.deliveredAt || a.createdAt || 0));
      if (fKind === "video") list = list.filter(a => assetKind(a) === "视频");
      if (fKind === "image") list = list.filter(a => assetKind(a) === "图文");
      const accounts = state.accounts || [];
      const selectedFileCount = fAcc === "all" ? 0 : accountArchivableAssets(fAcc).length;
      if (!collapseInitialized) { state.accounts.forEach(a => collapsedAcc.add(a.id)); collapsedAcc.add("__none"); collapseInitialized = true; }
      root.innerHTML = `
        <div class="assets-page">
          <div class="page-head">
            <div><div class="eyebrow">整体资产</div><h2>${libraryLabels[libraryMode] || "账号资产"}</h2></div>
            <div class="head-actions">${libraryTabsHtml()}</div>
          </div>
          <div class="filter-bar card asset-smart-filters">
            <div class="fb-search">${icon("search", 14)}<input id="avSearch" placeholder="搜索素材名 / 标签" value="${esc(fQ)}" /></div>
            ${isGlobalLibrary() ? "" : `<label class="select-shell">${icon("filter", 13)}<select id="avKind"><option value="all">全部形式</option><option value="video" ${fKind === "video" ? "selected" : ""}>视频</option><option value="image" ${fKind === "image" ? "selected" : ""}>图文</option></select>${icon("chevronDown", 12)}</label>`}
            ${isGlobalLibrary() ? "" : `<label class="select-shell account-select">${icon("users", 13)}<select id="avAccount"><option value="all">全部账号</option>${accounts.map(a => `<option value="${esc(a.id)}" ${fAcc === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>`}
            ${!isGlobalLibrary() && fAcc !== "all" ? `<button class="btn ghost asset-filter-action" data-export-del-acc="${esc(fAcc)}" ${selectedFileCount ? "" : "disabled"}>${icon("download", 14)} 导出并清空文件 ${selectedFileCount ? `(${selectedFileCount})` : ""}</button>` : ""}
          </div>
          <div class="asset-mode-stage" id="avBody">
            ${renderBody(list)}
          </div>
        </div>`;
      const topDock = $(".head-actions", root);
      const topbar = document.querySelector(".topbar");
      const topActions = document.querySelector(".top-actions");
      if (topDock && topbar && topActions) {
        topDock.id = "assetsTopDock";
        topDock.classList.add("topbar-assets-dock");
        topbar.insertBefore(topDock, topActions);
      }
      wire();
    };

    const cardHtml = a => {
      const acc = accountById(a.accountId);
      const kind = assetKind(a);
      const audioUrl = a.type === "音频" ? urlFor(a) : "";
      const globalLabel = libraryMode === "bgm"
        ? "共享 BGM"
        : libraryMode === "material"
          ? "共享剪辑素材"
          : libraryMode === "voice"
            ? "我的语音素材"
            : libraryMode === "reference"
              ? "我的参考音频"
              : "";
      return `<div class="asset-card card ${a.type === "音频" ? "is-audio" : ""}" data-aid="${a.id}">
        <div class="ac-thumb">${a.type === "音频" && audioUrl ? `<div class="asset-audio-thumb">${icon("pulse", 22)}<audio controls preload="metadata" src="${esc(audioUrl)}"></audio></div>` : thumbHtml(a)}
          ${a.seq ? `<span class="ac-seq">${assetCode(a)}</span>` : ""}
          ${a.type === "视频" ? `<span class="ac-play">${icon("play", 13)}</span>` : ""}
          <div class="ac-hover">
            <button class="ac-mini" data-aact="download" title="下载">${icon("download", 13)}</button>
            <button class="ac-mini" data-aact="rename" title="重命名">${icon("edit", 13)}</button>
            ${isGlobalLibrary() ? "" : `<button class="ac-mini" data-aact="assign" title="分配到账号素材库">${icon("users", 13)}</button>`}
            <button class="ac-mini" data-aact="tag" title="加标签">#</button>
            <button class="ac-mini danger" data-aact="del" title="删除">${icon("trash", 13)}</button>
          </div>
        </div>
        <div class="ac-body">
          <div class="ac-name" title="${esc(a.name)}">${esc(a.name)}</div>
          <div class="ac-tags">${globalLabel ? `<span class="tag">${globalLabel}</span>` : acc ? `<span class="tag">${esc(acc.name)}</span>${platChip(acc.platform, true)}` : `<span class="tag">公共素材池</span>`}<span class="tag">${esc(globalLabel ? a.type : kind)}</span></div>
        </div>
      </div>`;
    };

    function renderBody(list) {
      if (!list.length) return emptyState("folder", `${libraryLabels[libraryMode] || "资产库"}暂无内容`, libraryMode === "shared" ? "完成定稿发布后，内容会进入这里供团队共享和下载" : "可从上方拖入符合格式的文件");
      if (isGlobalLibrary()) return `<div class="asset-grid">${list.map(cardHtml).join("")}</div>`;
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
        const fileCount = acc ? accountArchivableAssets(id).length : 0;
        return `<section class="acc-sec ${collapsed ? "collapsed" : ""}">
          <div class="acc-sec-head">
            <button class="acc-sec-main" data-accsec="${id}">
              <span class="chev">${icon("chevronDown", 13)}</span>
              <b>${esc(acc?.name || "未归属账号")}</b>
              ${acc ? `<span class="tag">${groupOf(acc)}</span>${platChip(acc.platform, true)}` : ""}
              <em>${items.length} 个</em>
            </button>
            ${acc && fileCount ? `<button class="btn ghost sm" data-export-del-acc="${id}">${icon("download", 12)} 导出并清空文件 (${fileCount})</button>` : ""}
          </div>
          <div class="acc-sec-body" ${collapsed ? "hidden" : ""}><div class="asset-grid">${items.map(cardHtml).join("")}</div></div>
        </section>`;
      }).join("");
    }

    const wire = () => {
      const search = $("#avSearch", root);
      if (search) {
        let composing = false;
        const applySearch = () => { fQ = search.value; draw(); };
        search.addEventListener("compositionstart", () => { composing = true; });
        search.addEventListener("compositionend", () => { composing = false; applySearch(); });
        search.addEventListener("input", e => {
          if (composing || e.isComposing) return;
          applySearch();
        });
      }
      $("#avKind", root)?.addEventListener("change", e => { fKind = e.currentTarget.value; draw(); });
      $$("[data-library]", $("#assetsTopDock") || root).forEach(b => b.addEventListener("click", () => {
        setAssetLibraryMode(b.dataset.library);
      }));
      $("#avAccount", root)?.addEventListener("change", e => { fAcc = e.currentTarget.value; includeAccountPrivate = false; draw(); });
      const uploadLibraryFile = async file => {
        if (!file) return;
        const mime = inferAssetFileMime(file);
        const isMp3 = mime === "audio/mpeg" && /\.mp3$/i.test(file.name || "");
        if (libraryMode === "bgm" && !isMp3) { toast("BGM 库仅支持 MP3 格式", "error"); return; }
        if (libraryMode === "material" && !mime.startsWith("video/")) { toast("剪辑素材库仅支持视频格式", "error"); return; }
        if (["voice", "reference"].includes(libraryMode) && !mime.startsWith("audio/")) { toast("请拖入音频文件", "error"); return; }
        const tags = libraryMode === "bgm" ? ["BGM", "音乐"]
          : libraryMode === "material" ? ["剪辑素材", "视频素材"]
            : libraryMode === "voice" ? ["语音素材库"] : ["参考音频库", "声线参考"];
        await addAssetFromFile(null, file, { tags });
        toast(
          ["bgm", "material"].includes(libraryMode)
            ? `已加入${libraryLabels[libraryMode]} · 公共素材池`
            : `已加入我的${libraryLabels[libraryMode]}`
        );
        draw();
      };
      if (libraryMode !== "shared") {
        const controller = new AbortController();
        root.__assetDropController = controller;
        root.dataset.dropHint = libraryMode === "bgm" ? "松手加入 BGM 库 · 仅 MP3" : libraryMode === "material" ? "松手加入剪辑素材库 · 仅视频" : "松手加入音频库";
        wireDropZone(root, async files => { for (const file of Array.from(files || [])) await uploadLibraryFile(file); }, { filesOnly: true, signal: controller.signal });
      } else {
        delete root.dataset.dropHint;
      }
      [...$$("[data-export-del-acc]", root), ...$$("#assetsTopDock [data-export-del-acc]")].forEach(b => b.addEventListener("click", e => {
        e.stopPropagation();
        withLoading(e.currentTarget, async () => {
          const n = await exportAndPurgeAccountFiles(e.currentTarget.dataset.exportDelAcc);
          if (n) draw();
        }, "导出中…");
      }));
      $$("[data-accsec]", root).forEach(b => b.addEventListener("click", () => {
        const id = b.dataset.accsec;
        const section = b.closest(".acc-sec");
        const body = section?.querySelector(".acc-sec-body");
        if (!section || !body) return;
        const opening = collapsedAcc.has(id);
        if (opening) {
          collapsedAcc.delete(id);
          section.classList.remove("collapsed");
          body.hidden = false;
          const height = body.scrollHeight;
          body.animate([{ height: "0px", opacity: 0 }, { height: `${height}px`, opacity: 1 }], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" }).onfinish = () => { body.style.height = ""; };
        } else {
          collapsedAcc.add(id);
          section.classList.add("collapsed");
          const height = body.getBoundingClientRect().height;
          body.animate([{ height: `${height}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 200, easing: "cubic-bezier(.4,0,.2,1)" }).onfinish = () => { body.hidden = true; body.style.height = ""; };
        }
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
        card.querySelector('[data-aact="assign"]')?.addEventListener("click", () => {
          const options = state.accounts.map(acc => `<option value="${esc(acc.id)}" ${a.accountId === acc.id ? "selected" : ""}>${esc(acc.name)} · ${esc(acc.platform)}</option>`).join("");
          openModal(`<div class="mp-head"><b>分配素材库</b><button class="icon-btn" data-close>${icon("x", 15)}</button></div>
            <div class="mp-body"><p class="mp-sub">默认放在公共素材池；明确选择账号后，仅该账号和公共素材可在生产时调用。</p>
              <label class="field"><span>归属素材库</span><select class="input" id="assetAssignAccount"><option value="">公共素材池</option>${options}</select></label>
            </div><div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="assetAssignSave">保存分配</button></div>`, {
            onMount(panel, close) {
              panel.querySelector("#assetAssignSave")?.addEventListener("click", () => {
                const next = panel.querySelector("#assetAssignAccount")?.value || null;
                a.accountId = next;
                a.tags = (a.tags || []).filter(tag => tag !== "账号素材");
                if (next) a.tags.push("账号素材");
                save("assets");
                close();
                toast(next ? "已分配到账号素材库" : "已移回公共素材池");
                draw();
              });
            }
          });
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
          if (ok) {
            await removeWithMotion(card, () => removeAsset(a.id));
            if (!root.querySelector(".asset-card")) draw();
          }
        });
      });
    };
    activeAssetsController = { root, draw };
    root.__viewCleanup = () => {
      root.__assetDropController?.abort();
      root.__assetDropController = null;
      $("#assetsTopDock")?.remove();
      if (activeAssetsController?.root === root) activeAssetsController = null;
    };
    draw();
    emitAssetLibraryModel();
  }
};
