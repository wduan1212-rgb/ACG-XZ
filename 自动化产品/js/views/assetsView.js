/* 共享资产库：展示已发布/已交付内容，以及发布后沉淀的生成图；草稿、口播和生成中素材留在账号资产/草稿链路 */

import { $, $$, esc, buildZipBlob, downloadBlob, wireDropZone } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, accountById, currentMember, currentTeam } from "../core/store.js";
import { community } from "../core/remote.js";
import { searchAssets, thumbHtml, removeAsset, urlFor, assetCode, assetU8, addAssetFromFile, inferAssetFileMeta, isBgmAsset, isEditingMaterialAsset } from "../domain/assets.js";
import { downloadAsset } from "../domain/delivery.js";
import { platChip, groupOf, isAvatarAsset } from "../domain/accounts.js";
import { emptyState, promptModal, confirmModal, openLightbox, openModal, toast, withLoading, removeWithMotion } from "../ui/components.js?v=20260805-v140-platform-stability-2";
import { renderSupplierAccounts } from "./supplierViews.js?v=20260805-v140-platform-stability-2";

let fAcc = "all", fQ = "", fKind = "all", fSource = "all", fBackendKind = "bgm", libraryMode = "drafts", collapseInitialized = false;
let activeAssetsController = null;
let favoritePosts = [];
let favoritePostsMemberId = "";
let favoritePostsLoading = false;
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
  Object.freeze({ key: "drafts", label: "草稿箱", shortLabel: "草稿箱" }),
  Object.freeze({ key: "shared", label: "账号资产", shortLabel: "账号资产" }),
  Object.freeze({ key: "favorites", label: "收藏夹", shortLabel: "收藏夹" }),
  Object.freeze({ key: "backend", label: "后台素材", shortLabel: "后台素材" }),
]);
const libraryLabels = Object.fromEntries(ASSET_LIBRARY_OPTIONS.map(option => [option.key, option.label]));
const assetLibraryKeys = new Set(ASSET_LIBRARY_OPTIONS.map(option => option.key));
const isPersonalLibrary = () => state.role === "user";
const hasProfessionalAssetFilters = () => {
  const member = currentMember();
  const plan = String(member?.plan || member?.subscription || "").toLowerCase();
  return Boolean(currentTeam()?.id || currentTeam()?.name)
    || ["pro", "professional", "personal-pro", "personal-high", "team", "team-pro"].includes(plan);
};
const visibleLibraryOptions = () => ASSET_LIBRARY_OPTIONS;
const libraryTabsHtml = () => `<div class="asset-library-tabs text-switch">${visibleLibraryOptions().map(option => `<button class="${libraryMode === option.key ? "on is-active" : ""}" data-library="${option.key}">${option.shortLabel}</button>`).join("")}</div>`;
// 后台素材是团队共享的 BGM / 剪辑素材池；收藏夹始终严格绑定当前成员。
const isGlobalLibrary = () => libraryMode === "backend";

export function getAssetLibraryModel() {
  return {
    value: libraryMode,
    options: visibleLibraryOptions().map(option => ({ ...option })),
  };
}

function emitAssetLibraryModel() {
  if (typeof window === "undefined" || typeof window.CustomEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("xingzhen:asset-library-model", {
    detail: getAssetLibraryModel(),
  }));
}

async function refreshFavoritePosts(redraw) {
  const memberId = String(currentMember()?.id || "");
  if (!memberId || favoritePostsLoading) return;
  favoritePostsLoading = true;
  if (favoritePostsMemberId !== memberId) favoritePosts = [];
  try {
    const response = await community.favorites(80);
    favoritePosts = Array.isArray(response?.items) ? response.items : [];
    favoritePostsMemberId = memberId;
  } catch (_) {
    favoritePosts = [];
    favoritePostsMemberId = memberId;
  } finally {
    favoritePostsLoading = false;
    if (typeof redraw === "function" && libraryMode === "favorites") redraw();
  }
}

export function setAssetLibraryMode(nextMode, { redraw = true, resetKind = true } = {}) {
  const normalized = String(nextMode || "").trim();
  if (!assetLibraryKeys.has(normalized)) return getAssetLibraryModel();
  const changed = normalized !== libraryMode;
  libraryMode = normalized;
  if (changed && resetKind) {
    fKind = "all";
    fSource = "all";
    fQ = "";
  }
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
    const mountTopDock = () => {
      const topDock = $(".head-actions", root);
      const topbar = document.querySelector(".topbar");
      const topActions = document.querySelector(".top-actions");
      if (!topDock || !topbar || !topActions) return;
      topDock.id = "assetsTopDock";
      topDock.classList.add("topbar-assets-dock");
      topbar.insertBefore(topDock, topActions);
    };
    const wireLibraryTabs = () => {
      $$('[data-library]', $("#assetsTopDock") || root).forEach(button => button.addEventListener("click", () => {
        setAssetLibraryMode(button.dataset.library);
      }));
    };
    const draw = () => {
      root.__assetDropController?.abort();
      root.__assetDropController = null;
      root.classList.remove("drag-over");
      delete root.dataset.dropHint;
      $("#assetsTopDock")?.remove();
      if (libraryMode === "drafts") {
        root.innerHTML = `<div class="assets-page"><div class="page-head"><div><div class="eyebrow">整体资产</div><h2>草稿箱</h2></div><div class="head-actions">${libraryTabsHtml()}</div></div><div class="asset-mode-stage" id="assetDraftsHost"></div></div>`;
        mountTopDock();
        wireLibraryTabs();
        import("./draftsView.js?v=20260805-v140-platform-stability-2").then(({ draftsView }) => {
          const host = $("#assetDraftsHost", root);
          if (host) draftsView.render(host);
        });
        return;
      }
      if (libraryMode === "favorites") {
        const memberId = String(currentMember()?.id || "");
        if (favoritePostsMemberId !== memberId && !favoritePostsLoading) {
          queueMicrotask(() => refreshFavoritePosts(draw));
        }
        root.innerHTML = `<div class="assets-page"><div class="page-head"><div><div class="eyebrow">整体资产</div><h2>收藏夹</h2></div><div class="head-actions">${libraryTabsHtml()}</div></div><div class="asset-mode-stage" id="avBody">${renderFavorites()}</div></div>`;
        mountTopDock();
        wireLibraryTabs();
        $$('[data-favorite-post]', root).forEach(card => card.addEventListener("click", () => {
          const post = favoritePosts.find(item => String(item.id) === String(card.dataset.favoritePost));
          if (post) openFavoritePost(post);
        }));
        return;
      }
      let list = searchAssets({ accountId: isGlobalLibrary() || isPersonalLibrary() ? "all" : fAcc, tag: "all", q: fQ, includeDelivered: true })
        .filter(a => !isAvatarAsset(a))
        .filter(a => libraryMode === "shared"
          ? (isPersonalLibrary()
              ? (a.ownerId === state.ui.currentMemberId && (isSharedAsset(a) || (a.tags || []).some(tag => /个人资产|视频工坊|无限画布|语音素材库|口播|tts/i.test(tag))))
              : (includeAccountPrivate && fAcc !== "all"
                  ? a.accountId === fAcc
                  : isSharedAsset(a) || (a.type === "音频" && (a.tags || []).some(tag => /语音素材库|口播|tts/i.test(tag)))))
          : fBackendKind === "bgm"
            ? (isBgmAsset(a) && (!isPersonalLibrary() || a.ownerId === state.ui.currentMemberId))
            : isEditingMaterialAsset(a))
        .sort((a, b) => (b.deliveredAt || b.createdAt || 0) - (a.deliveredAt || a.createdAt || 0));
      if (fKind === "video") list = list.filter(a => assetKind(a) === "视频");
      if (fKind === "image") list = list.filter(a => assetKind(a) === "图文");
      if (fKind === "audio") list = list.filter(a => assetKind(a) === "音频");
      if (isPersonalLibrary() && hasProfessionalAssetFilters() && libraryMode === "shared" && fSource !== "all") {
        const sourcePattern = fSource === "video" ? /视频工坊/ : /无限画布/;
        list = list.filter(a => (a.tags || []).some(tag => sourcePattern.test(tag)));
      }
      const accounts = state.accounts || [];
      const selectedFileCount = fAcc === "all" ? 0 : accountArchivableAssets(fAcc).length;
      if (!collapseInitialized) { state.accounts.forEach(a => collapsedAcc.add(a.id)); collapsedAcc.add("__none"); collapseInitialized = true; }
      root.innerHTML = `
        <div class="assets-page">
          <div class="page-head">
            <div><div class="eyebrow">整体资产</div><h2>${libraryLabels[libraryMode] || "账号资产"}</h2></div>
            <div class="head-actions">${libraryTabsHtml()}</div>
          </div>
          <div class="filter-bar card asset-smart-filters ${isPersonalLibrary() ? "is-personal" : ""}">
            <div class="fb-search">${icon("search", 14)}<input id="avSearch" placeholder="搜索素材名 / 标签" value="${esc(fQ)}" /></div>
            ${libraryMode === "backend" ? `<div class="asset-backend-kind text-switch" aria-label="后台素材分类"><button class="${fBackendKind === "bgm" ? "on is-active" : ""}" data-backend-kind="bgm">BGM</button><button class="${fBackendKind === "material" ? "on is-active" : ""}" data-backend-kind="material">剪辑素材</button></div>` : `<label class="select-shell">${icon("filter", 13)}<select id="avKind"><option value="all">全部形式</option><option value="video" ${fKind === "video" ? "selected" : ""}>视频</option><option value="image" ${fKind === "image" ? "selected" : ""}>图文</option><option value="audio" ${fKind === "audio" ? "selected" : ""}>语音</option></select>${icon("chevronDown", 12)}</label>`}
            ${isPersonalLibrary() && hasProfessionalAssetFilters() && libraryMode === "shared" ? `<div class="asset-personal-source-filter text-switch" aria-label="个人资产来源筛选"><button class="${fSource === "all" ? "on is-active" : ""}" data-personal-source="all">全部</button><button class="${fSource === "video" ? "on is-active" : ""}" data-personal-source="video">视频工坊</button><button class="${fSource === "canvas" ? "on is-active" : ""}" data-personal-source="canvas">无限画布</button></div>` : ""}
            ${isGlobalLibrary() || isPersonalLibrary() ? "" : `<label class="select-shell account-select">${icon("users", 13)}<select id="avAccount"><option value="all">全部账号</option>${accounts.map(a => `<option value="${esc(a.id)}" ${fAcc === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>`}
            ${!isGlobalLibrary() && fAcc !== "all" ? `<button class="btn ghost asset-filter-action" data-export-del-acc="${esc(fAcc)}" ${selectedFileCount ? "" : "disabled"}>${icon("download", 14)} 导出并清空文件 ${selectedFileCount ? `(${selectedFileCount})` : ""}</button>` : ""}
          </div>
          <div class="asset-mode-stage" id="avBody">
            ${renderBody(list)}
          </div>
        </div>`;
      mountTopDock();
      wire();
    };

    const cardHtml = a => {
      const acc = accountById(a.accountId);
      const kind = assetKind(a);
      const audioUrl = a.type === "音频" ? urlFor(a) : "";
      const globalLabel = libraryMode === "backend"
        ? (fBackendKind === "bgm" ? "BGM" : "剪辑素材")
        : "";
      return `<div class="asset-card card ${a.type === "音频" ? "is-audio" : ""}" data-aid="${a.id}">
        <div class="ac-thumb">${a.type === "音频" && audioUrl ? `<div class="asset-audio-thumb">${icon("pulse", 22)}<audio controls preload="metadata" src="${esc(audioUrl)}"></audio></div>` : thumbHtml(a)}
          ${a.seq ? `<span class="ac-seq">${assetCode(a)}</span>` : ""}
          ${a.type === "视频" ? `<span class="ac-play">${icon("play", 13)}</span>` : ""}
          <div class="ac-hover">
            <button class="ac-mini" data-aact="download" title="下载">${icon("download", 13)}</button>
            <button class="ac-mini" data-aact="rename" title="重命名">${icon("edit", 13)}</button>
            ${isGlobalLibrary() || isPersonalLibrary() ? "" : `<button class="ac-mini" data-aact="assign" title="分配到账号素材库">${icon("users", 13)}</button>`}
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

    function renderFavorites() {
      if (favoritePostsLoading && !favoritePosts.length) return emptyState("folder", "正在读取收藏夹", "收藏内容严格按当前成员隔离");
      if (!favoritePosts.length) return emptyState("bookmark", "收藏夹暂无内容", "在首页灵感详情中点击收藏后，会出现在这里");
      return `<div class="asset-favorite-grid">${favoritePosts.map(post => {
        const media = (post.media || [])[0] || {};
        const poster = post.cover?.url || media.poster || "";
        const preview = media.type === "video"
          ? `<video src="${esc(media.url)}" ${poster ? `poster="${esc(poster)}"` : ""} muted playsinline preload="metadata"></video>`
          : `<img src="${esc(media.url)}" alt="${esc(post.title || "收藏灵感")}" loading="lazy" />`;
        return `<article class="asset-favorite-card card" data-favorite-post="${esc(post.id)}">
          <div class="asset-favorite-preview">${preview}${(post.media || []).length > 1 ? `<span>${post.media.length} 项素材</span>` : ""}</div>
          <div class="asset-favorite-copy"><em>${esc(post.category || "灵感")}</em><b>${esc(post.title || "未命名灵感")}</b><small>${esc(post.authorName || "星阵用户")}${post.teamName ? ` · ${esc(post.teamName)}` : ""}</small></div>
        </article>`;
      }).join("")}</div>`;
    }

    function openFavoritePost(post) {
      const entries = (post.media || []).filter(entry => entry?.url);
      const cover = post.cover?.url || entries.find(entry => entry?.poster)?.poster || "";
      const reactionButton = (field, active) => {
        const isLike = field === "liked";
        const label = active
          ? (isLike ? "取消点赞" : "取消收藏")
          : (isLike ? "点赞" : "收藏");
        return `<button class="community-detail-action is-${isLike ? "like" : "favorite"}" type="button" data-favorite-reaction="${field}" aria-pressed="${active ? "true" : "false"}" aria-label="${label}" title="${label}">${icon(isLike ? "heart" : "bookmark", 18)}</button>`;
      };
      const media = entries.map((entry, index) => entry.type === "video"
        ? `<video class="asset-favorite-dialog-item${index ? "" : " is-active"}" data-favorite-detail-media="${index}" src="${esc(entry.url)}" ${entry.poster || cover ? `poster="${esc(entry.poster || cover)}"` : ""} controls playsinline preload="metadata" ${index ? "hidden" : ""}></video>`
        : `<button class="asset-favorite-dialog-item${index ? "" : " is-active"}" type="button" data-favorite-detail-media="${index}" data-favorite-image="${index}" ${index ? "hidden" : ""}><img src="${esc(entry.url)}" alt="${esc(entry.alt || post.title || "收藏灵感")}" loading="lazy" /></button>`
      ).join("");
      const thumbs = entries.length > 1 ? `<div class="asset-favorite-dialog-thumbs" role="tablist" aria-label="查看全部媒体">${entries.map((entry, index) => {
        const preview = entry.type === "video" ? (entry.poster || cover) : entry.url;
        return `<button class="${index ? "" : "is-active"}" type="button" role="tab" aria-selected="${index ? "false" : "true"}" data-favorite-detail-thumb="${index}" aria-label="查看第 ${index + 1} 项媒体">${preview ? `<img src="${esc(preview)}" alt="" />` : icon("video", 15)}${entry.type === "video" ? `<i>${icon("play", 10)}</i>` : ""}</button>`;
      }).join("")}</div>` : "";
      openModal(`<article class="asset-favorite-dialog">
        <header>
          <div><span>${esc(post.category || "灵感")}</span><h2>${esc(post.title || "未命名灵感")}</h2><small>${esc(post.authorName || "星阵用户")}${post.teamName ? ` · ${esc(post.teamName)}` : ""}</small></div>
          <div class="asset-favorite-dialog-tools">
            <div class="community-detail-actions" role="group" aria-label="收藏灵感操作">
              ${reactionButton("liked", Boolean(post.viewerLiked))}
              ${reactionButton("favorited", Boolean(post.viewerFavorited))}
            </div>
            <button class="icon-btn" type="button" data-close aria-label="关闭" title="关闭">${icon("x", 16)}</button>
          </div>
        </header>
        <div class="asset-favorite-dialog-media"><div class="asset-favorite-dialog-stage">${media}</div>${thumbs}</div>
        <div class="asset-favorite-dialog-copy">${post.copy ? `<p>${esc(post.copy)}</p>` : ""}${post.prompt ? `<label>参考提示词</label><pre>${esc(post.prompt)}</pre>` : ""}</div>
      </article>`, {
        onMount(panel, close) {
          panel.classList.add("asset-favorite-panel");
          panel.querySelectorAll("video[data-favorite-detail-media]").forEach(video => {
            video.defaultMuted = false;
            video.muted = false;
          });
          panel.querySelectorAll("[data-favorite-image]").forEach(button => button.addEventListener("click", () => {
            const index = Number(button.dataset.favoriteImage);
            const image = button.querySelector("img");
            if (image) openLightbox(image, entries[index]?.url || image.src, post.title || "收藏灵感");
          }));
          panel.querySelectorAll("[data-favorite-detail-thumb]").forEach(button => button.addEventListener("click", () => {
            const index = button.dataset.favoriteDetailThumb;
            panel.querySelectorAll("[data-favorite-detail-media]").forEach(mediaItem => {
              const active = mediaItem.dataset.favoriteDetailMedia === index;
              mediaItem.hidden = !active;
              mediaItem.classList.toggle("is-active", active);
              if (!active && mediaItem.tagName === "VIDEO") mediaItem.pause();
            });
            panel.querySelectorAll("[data-favorite-detail-thumb]").forEach(tab => {
              const active = tab === button;
              tab.classList.toggle("is-active", active);
              tab.setAttribute("aria-selected", active ? "true" : "false");
            });
          }));
          panel.querySelectorAll("[data-favorite-reaction]").forEach(button => button.addEventListener("click", async event => {
            const button = event.currentTarget;
            const field = button.dataset.favoriteReaction;
            const next = button.getAttribute("aria-pressed") !== "true";
            button.disabled = true;
            try {
              const result = await community.react(post.id, { [field]: next });
              Object.assign(post, result);
              const active = field === "liked" ? Boolean(result.viewerLiked) : Boolean(result.viewerFavorited);
              const label = active
                ? (field === "liked" ? "取消点赞" : "取消收藏")
                : (field === "liked" ? "点赞" : "收藏");
              button.setAttribute("aria-pressed", active ? "true" : "false");
              button.setAttribute("aria-label", label);
              button.title = label;
              if (field === "favorited" && !active) {
                favoritePosts = favoritePosts.filter(item => String(item.id) !== String(post.id));
                close();
                draw();
                toast("已取消收藏");
              }
            } catch (error) {
              button.disabled = false;
              if (/登录|401|未登录/.test(String(error?.message || ""))) {
                window.dispatchEvent(new CustomEvent("xingzhen:auth-required", { detail: { reason: "community-reaction" } }));
              } else toast(error?.message || "操作失败，请稍后重试", "error");
            } finally {
              if (button.isConnected) button.disabled = false;
            }
          }));
        },
      });
    }

    function renderBody(list) {
      if (!list.length) return emptyState("folder", `${libraryLabels[libraryMode] || "资产库"}暂无内容`, libraryMode === "shared" ? (isPersonalLibrary() ? "无限画布和视频工坊的生成结果会自动收纳到这里" : "完成定稿发布后，内容会进入这里供团队共享和下载") : "可从上方拖入符合格式的文件");
      if (isGlobalLibrary() || isPersonalLibrary()) return `<div class="asset-grid">${list.map(cardHtml).join("")}</div>`;
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
      $$('[data-personal-source]', root).forEach(button => button.addEventListener("click", () => {
        fSource = button.dataset.personalSource || "all";
        draw();
      }));
      $$('[data-backend-kind]', root).forEach(button => button.addEventListener("click", () => {
        fBackendKind = button.dataset.backendKind || "bgm";
        draw();
      }));
      $$("[data-library]", $("#assetsTopDock") || root).forEach(b => b.addEventListener("click", () => {
        setAssetLibraryMode(b.dataset.library);
      }));
      $("#avAccount", root)?.addEventListener("change", e => { fAcc = e.currentTarget.value; includeAccountPrivate = false; draw(); });
      const uploadLibraryFile = async file => {
        if (!file) return;
        const { mime, type } = inferAssetFileMeta(file);
        const isMp3 = mime === "audio/mpeg" && /\.mp3$/i.test(file.name || "");
        const isEditingMaterial = ["图片", "视频"].includes(type) && /^(image|video)\//.test(mime);
        if (fBackendKind === "bgm" && !isMp3) { toast("BGM 仅支持 MP3 格式", "error"); return; }
        if (fBackendKind === "material" && !isEditingMaterial) { toast("剪辑素材仅支持视频或图片格式", "error"); return; }
        const tags = fBackendKind === "bgm"
          ? ["BGM", "音乐"]
          : ["剪辑素材", "共享剪辑素材", `${type}素材`];
        try {
          await addAssetFromFile(null, file, {
            tags,
            rejectDuplicateName: true,
            libraryLabel: libraryLabels[libraryMode] || "当前素材库",
          });
        } catch (error) {
          toast(error?.message || "素材加入失败，请稍后重试", "error");
          return false;
        }
        toast(`已加入后台素材 · ${fBackendKind === "bgm" ? "BGM" : "剪辑素材"}`);
        draw();
        return true;
      };
      if (libraryMode === "backend") {
        const controller = new AbortController();
        root.__assetDropController = controller;
        root.dataset.dropHint = fBackendKind === "bgm" ? "松手加入 BGM · 仅 MP3" : "松手加入剪辑素材 · 视频或图片";
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
        card.querySelector('[data-aact="download"]').addEventListener("click", async () => {
          try {
            await downloadAsset(a);
          } catch (error) {
            toast(error?.message || "素材下载失败，请刷新后重试", "error");
          }
        });
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
