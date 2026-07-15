/* 共享资产库：展示已发布/已交付内容，以及发布后沉淀的生成图；草稿、口播和生成中素材留在账号资产/草稿链路 */

import { $, $$, esc, buildZipBlob, downloadBlob, wireDropZone } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, accountById } from "../core/store.js";
import { searchAssets, thumbHtml, removeAsset, urlFor, assetCode, assetU8, addAssetFromFile } from "../domain/assets.js";
import { downloadAsset } from "../domain/delivery.js";
import { platChip, groupOf, isAvatarAsset } from "../domain/accounts.js";
import { emptyState, promptModal, confirmModal, openLightbox, openModal, toast, withLoading, removeWithMotion } from "../ui/components.js";
import { renderSupplierAccounts } from "./supplierViews.js?v=20260715-v82-4";

let fAcc = "all", fQ = "", fKind = "all", libraryMode = "shared", collapseInitialized = false;
const collapsedAcc = new Set();
const isSharedAsset = a => !!a?.delivered || !!a?.shared;
const assetKind = a => a.type === "视频" || (a.tags || []).some(t => /视频|成片/.test(t)) ? "视频" : "图文";
const cleanName = s => String(s || "未命名").replace(/[\\/:*?"<>|#]+/g, "_").replace(/\s+/g, "_").slice(0, 60);
const accountImageAssets = accountId => state.assets
  .filter(a => isSharedAsset(a) && a.accountId === accountId && a.type === "图片" && !isAvatarAsset(a))
  .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
const libraryLabels = { shared: "账号资产", bgm: "BGM 库", material: "剪辑素材库", voice: "语音素材库", reference: "总参考音频库" };

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
    if (["supplier", "supplier_parent"].includes(state.role)) { renderSupplierAccounts(root); return; }
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
      let list = searchAssets({ accountId: fAcc, tag: "all", q: fQ, includeDelivered: true })
        .filter(a => !isAvatarAsset(a))
        .filter(a => libraryMode === "shared"
          ? (includeAccountPrivate && fAcc !== "all" ? a.accountId === fAcc : isSharedAsset(a))
          : libraryMode === "bgm"
            ? (a.type === "音频" && (a.tags || []).some(t => /bgm|配乐|音乐/i.test(t)) && !(a.tags || []).some(t => /口播|语音|tts/i.test(t)))
            : libraryMode === "material"
              ? (a.type === "视频" && (a.tags || []).some(t => /素材库|剪辑素材|视频素材/.test(t)))
              : libraryMode === "voice"
                ? (a.type === "音频" && (a.tags || []).some(t => /语音素材库|口播|tts/i.test(t)) && !(a.tags || []).some(t => /参考音频库/i.test(t)))
                : (a.type === "音频" && (a.tags || []).some(t => /参考音频库|声线参考/i.test(t))))
        .sort((a, b) => (b.deliveredAt || b.createdAt || 0) - (a.deliveredAt || a.createdAt || 0));
      if (fKind === "video") list = list.filter(a => assetKind(a) === "视频");
      if (fKind === "image") list = list.filter(a => assetKind(a) === "图文");
      const accounts = state.accounts || [];
      const selectedImageCount = fAcc === "all" ? 0 : accountImageAssets(fAcc).length;
      if (!collapseInitialized) { state.accounts.forEach(a => collapsedAcc.add(a.id)); collapsedAcc.add("__none"); collapseInitialized = true; }
      root.innerHTML = `
        <div class="assets-page">
          <div class="page-head">
            <div><div class="eyebrow">整体资产</div><h2>${libraryLabels[libraryMode] || "账号资产"}</h2></div>
            <div class="head-actions">
              <div class="asset-library-tabs"><button class="${libraryMode === "shared" ? "on" : ""}" data-library="shared">${icon("package", 13)} 账号资产</button><button class="${libraryMode === "bgm" ? "on" : ""}" data-library="bgm">${icon("music", 13)} BGM</button><button class="${libraryMode === "material" ? "on" : ""}" data-library="material">${icon("film", 13)} 剪辑素材</button><button class="${libraryMode === "voice" ? "on" : ""}" data-library="voice">${icon("mic", 13)} 语音素材</button><button class="${libraryMode === "reference" ? "on" : ""}" data-library="reference">${icon("pulse", 13)} 参考音频</button></div>
              <button class="btn ghost" data-go-delivery>${icon("package", 14)} 去发布清单</button>
            </div>
          </div>
          <div class="filter-bar card asset-smart-filters">
            <div class="fb-search">${icon("search", 14)}<input id="avSearch" placeholder="搜索素材名 / 标签" value="${esc(fQ)}" /></div>
            ${libraryMode !== "bgm" ? `<label class="select-shell">${icon("filter", 13)}<select id="avKind"><option value="all">全部形式</option><option value="video" ${fKind === "video" ? "selected" : ""}>视频</option><option value="image" ${fKind === "image" ? "selected" : ""}>图文</option></select>${icon("chevronDown", 12)}</label>` : ""}
            <label class="select-shell account-select">${icon("users", 13)}<select id="avAccount"><option value="all">全部账号</option>${accounts.map(a => `<option value="${esc(a.id)}" ${fAcc === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>${icon("chevronDown", 12)}</label>
            ${fAcc !== "all" ? `<button class="btn ghost asset-filter-action" data-export-del-acc="${esc(fAcc)}" ${selectedImageCount ? "" : "disabled"}>${icon("download", 14)} 导出并清空图片 ${selectedImageCount ? `(${selectedImageCount})` : ""}</button>` : ""}
          </div>
          <div id="avBody">
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
      return `<div class="asset-card card ${a.type === "音频" ? "is-audio" : ""}" data-aid="${a.id}">
        <div class="ac-thumb">${a.type === "音频" && audioUrl ? `<div class="asset-audio-thumb">${icon("pulse", 22)}<audio controls preload="metadata" src="${esc(audioUrl)}"></audio></div>` : thumbHtml(a)}
          ${a.seq ? `<span class="ac-seq">${assetCode(a)}</span>` : ""}
          ${a.type === "视频" ? `<span class="ac-play">${icon("play", 13)}</span>` : ""}
          <div class="ac-hover">
            <button class="ac-mini" data-aact="download" title="下载">${icon("download", 13)}</button>
            <button class="ac-mini" data-aact="rename" title="重命名">${icon("edit", 13)}</button>
            <button class="ac-mini" data-aact="assign" title="分配到账号素材库">${icon("users", 13)}</button>
            <button class="ac-mini" data-aact="tag" title="加标签">#</button>
            <button class="ac-mini danger" data-aact="del" title="删除">${icon("trash", 13)}</button>
          </div>
        </div>
        <div class="ac-body">
          <div class="ac-name" title="${esc(a.name)}">${esc(a.name)}</div>
          <div class="ac-tags">${acc ? `<span class="tag">${esc(acc.name)}</span>${platChip(acc.platform, true)}` : `<span class="tag">公共素材池</span>`}<span class="tag">${esc(kind)}</span></div>
        </div>
      </div>`;
    };

    function renderBody(list) {
      if (!list.length) return emptyState("folder", `${libraryLabels[libraryMode] || "资产库"}暂无内容`, libraryMode === "shared" ? "完成定稿发布后，内容会进入这里供团队共享和下载" : "可从上方拖入符合格式的文件");
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
              <b>${esc(acc?.name || "未归属账号")}</b>
              ${acc ? `<span class="tag">${groupOf(acc)}</span>${platChip(acc.platform, true)}` : ""}
              <em>${items.length} 个</em>
            </button>
            ${acc && imgCount ? `<button class="btn ghost sm" data-export-del-acc="${id}">${icon("download", 12)} 导出并清空图片 (${imgCount})</button>` : ""}
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
      $$("[data-library]", $("#assetsTopDock") || root).forEach(b => b.addEventListener("click", () => { libraryMode = b.dataset.library; fKind = "all"; draw(); }));
      $("#avAccount", root)?.addEventListener("change", e => { fAcc = e.currentTarget.value; includeAccountPrivate = false; draw(); });
      const uploadLibraryFile = async file => {
        if (!file) return;
        const isMp3 = file.type === "audio/mpeg" || /\.mp3$/i.test(file.name || "");
        if (libraryMode === "bgm" && !isMp3) { toast("BGM 库仅支持 MP3 格式", "error"); return; }
        if (libraryMode === "material" && !file.type.startsWith("video/")) { toast("剪辑素材库仅支持视频格式", "error"); return; }
        if (["voice", "reference"].includes(libraryMode) && !file.type.startsWith("audio/")) { toast("请拖入音频文件", "error"); return; }
        const tags = libraryMode === "bgm" ? ["BGM", "音乐"]
          : libraryMode === "material" ? ["剪辑素材", "视频素材"]
            : libraryMode === "voice" ? ["语音素材库"] : ["参考音频库", "声线参考"];
        await addAssetFromFile(null, file, { tags });
        toast(`已加入${libraryLabels[libraryMode]} · 公共素材池`);
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
      $("#assetsTopDock [data-go-delivery]")?.addEventListener("click", () => { location.hash = "#/delivery"; });
      [...$$("[data-export-del-acc]", root), ...$$("#assetsTopDock [data-export-del-acc]")].forEach(b => b.addEventListener("click", e => {
        e.stopPropagation();
        withLoading(e.currentTarget, async () => {
          const n = await exportAndPurgeAccountImages(e.currentTarget.dataset.exportDelAcc);
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
        card.querySelector('[data-aact="assign"]').addEventListener("click", () => {
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
    draw();
  }
};
