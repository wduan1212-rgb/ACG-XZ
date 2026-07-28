/* 通用 UI 组件：toast / 确认弹层 / 抽屉 / lightbox / 空态 / 命令面板 / 通知中心 */

import { $, $$, esc, timeAgo } from "../core/util.js";
import { icon } from "./icons.js";
import { state, save, on } from "../core/store.js";

/* ---------- toast ---------- */
let toastTimer;
export function toast(msg, kind = "info") {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast"; t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.dataset.kind = kind;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show"); setTimeout(() => (t.hidden = true), 260); }, 2400);
}
window.__toast = toast;

/* Collapse a row/card only after its async delete succeeds. */
export async function removeWithMotion(elements, removeAction, { duration = 220 } = {}) {
  const rows = (Array.isArray(elements) ? elements : [elements]).filter(Boolean);
  const result = await removeAction();
  await Promise.all(rows.map(row => new Promise(resolve => {
    const rect = row.getBoundingClientRect();
    const marginBlock = getComputedStyle(row).marginBlock;
    row.style.overflow = "hidden";
    row.style.height = `${rect.height}px`;
    row.style.pointerEvents = "none";
    const animation = row.animate([
      { opacity: 1, transform: "translateX(0)", height: `${rect.height}px`, marginBlock },
      { opacity: 0, transform: "translateX(12px)", height: "0px", marginBlock: "0px", paddingBlock: "0px", borderWidth: "0px" }
    ], { duration, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
    animation.onfinish = animation.oncancel = () => { row.remove(); resolve(); };
  })));
  return result;
}

/* ---------- 确认弹层（替代原生 confirm） ---------- */
export function confirmModal({ title, body = "", okText = "确认", cancelText = "取消", danger = false }) {
  return new Promise(res => {
    const ov = document.createElement("div");
    ov.className = "modal-ov";
    ov.innerHTML = `
      <div class="modal-panel sm" role="dialog">
        <div class="mp-head"><b>${esc(title)}</b></div>
        ${body ? `<div class="mp-body">${body}</div>` : ""}
        <div class="mp-foot">
          <button class="btn ghost" data-r="0">${esc(cancelText)}</button>
          <button class="btn ${danger ? "danger" : "primary"}" data-r="1">${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add("open"));
    let closed = false;
    const close = v => { if (closed) return; closed = true; document.removeEventListener("keydown", onKey); ov.classList.remove("open"); setTimeout(() => ov.remove(), 200); res(v); };
    ov.addEventListener("click", e => {
      if (e.target === ov) return close(false);
      const b = e.target.closest("[data-r]");
      if (b) close(b.dataset.r === "1");
    });
    const onKey = e => { if (e.key === "Escape") close(false); };
    document.addEventListener("keydown", onKey);
  });
}

/* ---------- 输入弹层（替代原生 prompt） ---------- */
export function promptModal({ title, placeholder = "", value = "", okText = "确定" }) {
  return new Promise(res => {
    const ov = document.createElement("div");
    ov.className = "modal-ov";
    ov.innerHTML = `
      <div class="modal-panel sm" role="dialog">
        <div class="mp-head"><b>${esc(title)}</b></div>
        <div class="mp-body"><input class="input" id="pmInput" placeholder="${esc(placeholder)}" value="${esc(value)}" /></div>
        <div class="mp-foot">
          <button class="btn ghost" data-r="0">取消</button>
          <button class="btn primary" data-r="1">${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => { ov.classList.add("open"); $("#pmInput", ov).focus(); });
    let closed = false;
    const close = v => { if (closed) return; closed = true; ov.classList.remove("open"); setTimeout(() => ov.remove(), 200); res(v); };
    ov.addEventListener("click", e => {
      if (e.target === ov) return close(null);
      const b = e.target.closest("[data-r]");
      if (b) close(b.dataset.r === "1" ? $("#pmInput", ov).value.trim() : null);
    });
    $("#pmInput", ov).addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") close($("#pmInput", ov).value.trim());
      if (e.key === "Escape") close(null);
    });
  });
}

/* 供应商回传链接：已有链接可直接清空，撤回当前回传状态。
   确认 → { raw, note }；清除 → { clear: true }；取消 → null */
export function supplierReturnModal({ title = "回传发布链接", platform = "平台", value = "", note = "" } = {}) {
  return new Promise(res => {
    const ov = document.createElement("div");
    ov.className = "modal-ov";
    ov.innerHTML = `
      <div class="modal-panel sm" role="dialog">
        <div class="mp-head"><b>${esc(title)}</b></div>
        <div class="mp-body">
          <p class="mp-sub">粘贴${esc(platform)}发布链接或整段分享文案；误传后可清空并保存，恢复为未回传状态。</p>
          <label class="field"><span>发布链接${value ? "（清空后保存即可取消回传）" : "（必填）"}</span><input class="input" id="retRaw" placeholder="https://..." value="${esc(value)}" /></label>
          <label class="field"><span>供应商备注（可选）</span><textarea class="input" id="retNote" rows="3" placeholder="例如：已按约定话题发布，标题略有调整">${esc(note)}</textarea></label>
        </div>
        <div class="mp-foot">
          <button class="btn ghost" data-r="0">取消</button>
          ${value ? '<button class="btn danger" data-r="clear">清除链接</button>' : ""}
          <button class="btn primary" data-r="1">确认回传</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => {
      ov.classList.add("open");
      const input = $("#retRaw", ov);
      input.focus();
      if (value) input.select();
    });
    let closed = false;
    const close = v => { if (closed) return; closed = true; ov.classList.remove("open"); setTimeout(() => ov.remove(), 200); res(v); };
    ov.addEventListener("click", e => {
      if (e.target === ov) return close(null);
      const b = e.target.closest("[data-r]");
      if (!b) return;
      if (b.dataset.r === "1") {
        const raw = $("#retRaw", ov).value.trim();
        if (!raw && value) return close({ clear: true });
        if (!raw) { toast("请先粘贴发布链接", "error"); $("#retRaw", ov).focus(); return; }
        close({ raw, note: $("#retNote", ov).value.trim() });
      } else if (b.dataset.r === "clear") close({ clear: true });
      else close(null);
    });
    $("#retRaw", ov).addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const raw = $("#retRaw", ov).value.trim();
        if (!raw && value) return close({ clear: true });
        if (!raw) { toast("请先粘贴发布链接", "error"); return; }
        close({ raw, note: $("#retNote", ov).value.trim() });
      }
    });
  });
}

/* 定稿发布弹窗：计划发布日期和产品标签必填，备注可选。
   确认 → { planDate, productTag, note }；取消 → null */
function todayDateValue() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeDateValue(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return todayDateValue();
  return raw.slice(0, 10).replace(/\//g, "-");
}

export function publishModal({ title = "定稿并发布", okText = "定稿并发布", date = "", productTag = "", note = "" } = {}) {
  return new Promise(res => {
    const defaultDate = normalizeDateValue(date);
    const ov = document.createElement("div");
    ov.className = "modal-ov";
    ov.innerHTML = `
      <div class="modal-panel sm" role="dialog">
        <div class="mp-head"><b>${esc(title)}</b></div>
        <div class="mp-body">
          <p class="mp-sub">定稿后入供应商端，按发布序号可见可下载。计划发布日期默认今天，可按需调整：</p>
          <label class="field"><span>计划发布日期（必填）</span><input class="input" type="date" id="pubDate" value="${esc(defaultDate)}" required /></label>
          <label class="field"><span>产品标签（必填）</span><input class="input" id="pubProductTag" value="${esc(productTag)}" maxlength="20" placeholder="例如：百度搭子" required /></label>
          <label class="field"><span>备注（可选，几句话）</span><textarea class="input" id="pubNote" rows="2" placeholder="例如：周五晚高峰发，配合活动话题">${esc(note)}</textarea></label>
        </div>
        <div class="mp-foot">
          <button class="btn ghost" data-r="0">取消</button>
          <button class="btn primary" data-r="1">${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add("open"));
    let closed = false;
    const close = v => { if (closed) return; closed = true; ov.classList.remove("open"); setTimeout(() => ov.remove(), 200); res(v); };
    ov.addEventListener("click", e => {
      if (e.target === ov) return close(null);
      const b = e.target.closest("[data-r]");
      if (!b) return;
      if (b.dataset.r === "1") {
        const planDate = normalizeDateValue($("#pubDate", ov).value || "");
        if (!planDate) { toast("请先填写计划发布日期", "error"); $("#pubDate", ov).focus(); return; }
        const nextProductTag = $("#pubProductTag", ov).value.trim().slice(0, 20);
        if (!nextProductTag) { toast("请填写产品标签", "error"); $("#pubProductTag", ov).focus(); return; }
        close({ planDate, productTag: nextProductTag, note: $("#pubNote", ov).value.trim() });
      }
      else close(null);
    });
  });
}

/* ---------- 大弹层 / 抽屉 ---------- */
export function openModal(html, { wide = false, onMount, onBeforeClose, onClose } = {}) {
  const ov = document.createElement("div");
  ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal-panel ${wide ? "wide" : ""}" role="dialog">${html}</div>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("open"));
  let closed = false;
  const close = () => {
    if (closed) return;
    if (onBeforeClose && onBeforeClose() === false) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    ov.classList.remove("open");
    try { onClose?.(); } catch (error) { console.warn("[modal-close]", error); }
    setTimeout(() => ov.remove(), 200);
  };
  ov.addEventListener("pointerdown", e => { if (e.target === ov) close(); });
  ov.addEventListener("click", e => { if (e.target.closest("[data-close]")) { e.preventDefault(); close(); } });
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  if (onMount) onMount(ov.querySelector(".modal-panel"), close);
  return { el: ov, close };
}

export function openDrawer(html, { onMount, width = 560 } = {}) {
  // 单实例：先关掉任何已存在的抽屉，避免叠层导致"要点好几次才关"
  document.querySelectorAll(".drawer-ov").forEach(el => el.remove());
  const ov = document.createElement("div");
  ov.className = "drawer-ov";
  ov.innerHTML = `<aside class="drawer" style="width:${width}px">${html}</aside>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("open"));
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    document.removeEventListener("keydown", onKey);
    ov.classList.remove("open"); setTimeout(() => ov.remove(), 240);
  };
  // 用 pointerdown 更跟手；命中遮罩或任意 data-close 即关
  ov.addEventListener("pointerdown", e => { if (e.target === ov) close(); });
  ov.addEventListener("click", e => { if (e.target.closest("[data-close]")) { e.preventDefault(); close(); } });
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  if (onMount) onMount(ov.querySelector(".drawer"), close);
  return { el: ov, close };
}

/* ---------- lightbox（mac 展开动效，自 v4 移植） ---------- */
export function openLightbox(originEl, src, name) {
  if (!src) return;
  const rect = originEl.getBoundingClientRect();
  const ov = document.createElement("div");
  ov.className = "lightbox";
  ov.innerHTML = `<div class="lb-bg"></div><img class="lb-img" src="${src}" draggable="false"/>${name ? `<div class="lb-name">${esc(name)}</div>` : ""}`;
  document.body.appendChild(ov);
  const im = ov.querySelector(".lb-img");
  const place = r => { im.style.left = r.left + "px"; im.style.top = r.top + "px"; im.style.width = r.width + "px"; im.style.height = r.height + "px"; };
  place(rect);
  const expand = () => {
    const ar = (im.naturalWidth || rect.width) / (im.naturalHeight || rect.height || 1);
    const vw = window.innerWidth, vh = window.innerHeight;
    let w = Math.min(vw * 0.8, vh * 0.85 * ar), h = w / ar;
    if (h > vh * 0.85) { h = vh * 0.85; w = h * ar; }
    place({ left: (vw - w) / 2, top: (vh - h) / 2, width: w, height: h });
  };
  requestAnimationFrame(() => { ov.classList.add("open"); if (im.complete) expand(); else im.onload = expand; });
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    ov.classList.remove("open"); ov.classList.add("closing");
    place(originEl.isConnected ? originEl.getBoundingClientRect() : rect);
    document.removeEventListener("keydown", onKey);
    setTimeout(() => ov.remove(), 480);
  };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", close);
}

/* Video preview keeps native controls outside workshop cards, so browser media
   controls are never blocked by a parent card's interaction layer. */
export function openVideoPreview(src, name = "视频预览") {
  if (!src) return;
  const ov = document.createElement("div");
  ov.className = "lightbox media-preview";
  ov.innerHTML = `<div class="lb-bg"></div><button class="lb-back" type="button">${icon("arrowLeft", 15)} 返回</button><div class="lb-video-wrap"><video class="lb-video" src="${esc(src)}" controls playsinline preload="metadata"></video><button class="lb-close" type="button" aria-label="关闭预览">${icon("x", 18)}</button></div><div class="lb-name">${esc(name)}</div>`;
  document.body.appendChild(ov);
  const video = ov.querySelector(".lb-video");
  const onKey = e => { if (e.key === "Escape") close(); };
  const close = () => {
    video?.pause();
    document.removeEventListener("keydown", onKey);
    ov.classList.remove("open");
    setTimeout(() => ov.remove(), 220);
  };
  requestAnimationFrame(() => {
    ov.classList.add("open");
    video?.play().catch(() => null);
  });
  ov.addEventListener("click", e => {
    if (e.target === ov || e.target.closest(".lb-bg") || e.target.closest(".lb-close") || e.target.closest(".lb-back")) close();
  });
  document.addEventListener("keydown", onKey);
}

/* ---------- 空态 ---------- */
export function emptyState(icoName, title, hint = "", cta = "") {
  return `<div class="empty-state">
    <span class="es-ico">${icon(icoName, 26)}</span>
    <b>${esc(title)}</b>
    ${hint ? `<p>${hint}</p>` : ""}
    ${cta || ""}
  </div>`;
}

/* ---------- 通知中心 ---------- */
export function toggleNotifyPanel(anchorBtn) {
  const exist = $("#notifyPanel");
  if (exist) { exist.remove(); return; }
  const panel = document.createElement("div");
  panel.id = "notifyPanel";
  panel.className = "notify-panel";
  const items = state.notifications.slice(0, 30);
  const KIND_ICO = { delivery: "package", job: "film", agent: "spark", account: "user", review: "eye", info: "info" };
  panel.innerHTML = `
    <div class="np-head"><b>通知中心</b>${items.length ? `<button class="link-btn" id="npClear">全部已读</button>` : ""}</div>
    <div class="np-list">${items.length ? items.map(n => `
      <div class="np-item ${n.read ? "" : "unread"}">
        <span class="np-ico">${icon(KIND_ICO[n.kind] || "info", 14)}</span>
        <span class="np-main"><b>${esc(n.title)}</b>${n.body ? `<em>${esc(n.body)}</em>` : ""}</span>
        <time>${timeAgo(n.ts)}</time>
      </div>`).join("") : `<div class="np-empty">暂无通知</div>`}
    </div>`;
  document.body.appendChild(panel);
  const r = anchorBtn.getBoundingClientRect();
  panel.style.top = (r.bottom + 8) + "px";
  panel.style.right = (window.innerWidth - r.right) + "px";
  requestAnimationFrame(() => panel.classList.add("open"));
  state.notifications.forEach(n => n.read = true);
  save("notifications");
  updateNotifyBadge();
  const off = e => {
    if (!panel.contains(e.target) && e.target !== anchorBtn && !anchorBtn.contains(e.target)) {
      panel.remove(); document.removeEventListener("pointerdown", off);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", off), 10);
  const clr = $("#npClear", panel);
  if (clr) clr.addEventListener("click", () => { panel.remove(); });
}

export function updateNotifyBadge() {
  const b = $("#notifyBadge");
  if (!b) return;
  const n = state.notifications.filter(x => !x.read).length;
  b.textContent = n > 9 ? "9+" : String(n);
  b.hidden = n === 0;
}
on("notify", updateNotifyBadge);

/* ---------- ⌘K 命令面板 ---------- */
function gooeyPaletteSupported() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return false;
  const ua = navigator.userAgent || "";
  const ios = /iPad|iPhone|iPod/.test(ua);
  const safari = /Safari/.test(ua) && !/Chrome|CriOS|Edg|OPR/.test(ua);
  return !ios && !safari;
}

export function openPalette(commandSource, options = {}) {
  const exist = $("#palette");
  if (exist) { exist.__close?.(); return; }
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const gooey = gooeyPaletteSupported();
  const resolveCommands = query => {
    const commands = typeof commandSource === "function"
      ? commandSource(query)
      : commandSource;
    return Array.isArray(commands) ? commands : [];
  };
  const filterId = `gooey-palette-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const ov = document.createElement("div");
  ov.id = "palette";
  ov.className = `palette-ov ${gooey ? "is-gooey" : "is-flat"}`;
  ov.innerHTML = `
    ${gooey ? `<svg class="pal-goo-defs" width="0" height="0" aria-hidden="true"><defs>
      <filter id="${filterId}">
        <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur" />
        <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -15" result="goo" />
        <feComposite in="SourceGraphic" in2="goo" operator="atop" />
      </filter>
    </defs></svg>` : ""}
    <div class="palette" role="dialog" aria-modal="true" aria-label="全局搜索">
      <div class="pal-goo-layer" ${gooey ? `style="filter:url(#${filterId})"` : ""} aria-hidden="true"></div>
      <div class="pal-input-row"><span class="pal-search-orb">${icon("search", 16)}</span><input id="palInput" role="combobox" aria-controls="palList" aria-expanded="true" aria-autocomplete="list" placeholder="${esc(options.placeholder || "搜索账号 / 任务 / 操作…")}" autocomplete="off" /></div>
      <div class="pal-list" id="palList" role="listbox"></div>
      <div class="pal-foot"><span>↑↓ 选择 · Enter 执行 · Esc 关闭</span></div>
    </div>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("open"));
  const input = $("#palInput", ov);
  const list = $("#palList", ov);
  const gooLayer = $(".pal-goo-layer", ov);
  let idx = 0, filtered = resolveCommands("");
  let visibleLimit = 12;
  let closed = false;
  const visibleCommands = () => filtered.slice(0, visibleLimit);
  const syncGooGeometry = () => {
    if (!gooLayer || !list) return;
    gooLayer.style.setProperty("--pal-scroll", `${list.scrollTop}px`);
    gooLayer.style.setProperty("--pal-list-height", `${list.clientHeight}px`);
  };
  const updateSelection = ({ scroll = false } = {}) => {
    const shown = visibleCommands();
    idx = shown.length ? Math.max(0, Math.min(idx, shown.length - 1)) : 0;
    $$("[data-i]", list).forEach((item, i) => {
      const selected = i === idx;
      item.classList.toggle("is-active", selected);
      item.setAttribute("aria-selected", selected ? "true" : "false");
    });
    $$(".pal-goo-result-bg", gooLayer).forEach((item, i) => item.classList.toggle("is-active", i === idx));
    input.setAttribute("aria-activedescendant", shown.length ? `palOption${idx}` : "");
    if (scroll && shown.length) {
      list.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: "nearest" });
      requestAnimationFrame(syncGooGeometry);
    }
  };
  const renderList = () => {
    const shown = visibleCommands();
    const hiddenCount = Math.max(0, filtered.length - shown.length);
    idx = shown.length ? Math.max(0, Math.min(idx, shown.length - 1)) : 0;
    list.innerHTML = (shown.map((c, i) => `
      <div class="pal-item" data-i="${i}" id="palOption${i}" role="option" aria-selected="false" style="--pal-i:${i}">
        <span class="pi-ico">${icon(c.icon || "arrowRight", 15)}</span>
        <span class="pi-main"><b>${esc(c.label)}</b>${c.hint ? `<em>${esc(c.hint)}</em>` : ""}</span>
        ${c.group ? `<span class="pi-group">${esc(c.group)}</span>` : ""}
      </div>`).join("")
      + (hiddenCount
        ? `<button class="pal-more" type="button" data-pal-more>还有 ${hiddenCount} 条结果，展开更多</button>`
        : "")) || `<div class="np-empty">没有匹配项</div>`;
    if (gooLayer) {
      gooLayer.innerHTML = `<i class="pal-goo-input-bg"></i><span class="pal-goo-results-clip">${shown
        .map((_, i) => `<i class="pal-goo-result-bg" style="--pal-i:${i}"></i>`)
        .join("")}</span>`;
    }
    updateSelection();
    requestAnimationFrame(syncGooGeometry);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    ov.classList.remove("open");
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", syncGooGeometry);
    setTimeout(() => {
      ov.remove();
      if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
    }, 180);
  };
  ov.__close = close;
  const run = () => { const c = visibleCommands()[idx]; if (c) { close(); c.run(); } };
  const onKey = e => {
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { e.preventDefault(); input.focus(); }
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      const shown = visibleCommands();
      idx = shown.length ? Math.min(shown.length - 1, idx + 1) : 0;
      updateSelection({ scroll: true });
    }
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      idx = Math.max(0, idx - 1);
      updateSelection({ scroll: true });
    }
    else if (e.key === "Enter") { e.preventDefault(); run(); }
  };
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", syncGooGeometry);
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    const commands = resolveCommands(q);
    filtered = !q ? commands : commands.filter(c => (
      c.searchText
      || `${c.label || ""} ${c.hint || ""} ${c.group || ""}`
    ).toLowerCase().includes(q));
    idx = 0;
    visibleLimit = 12;
    list.scrollTop = 0;
    renderList();
  });
  list.addEventListener("pointermove", e => {
    const it = e.target.closest("[data-i]");
    if (!it || Number(it.dataset.i) === idx) return;
    idx = Number(it.dataset.i);
    updateSelection();
  });
  list.addEventListener("scroll", syncGooGeometry, { passive: true });
  list.addEventListener("click", e => {
    if (e.target.closest("[data-pal-more]")) {
      visibleLimit += 12;
      renderList();
      return;
    }
    const it = e.target.closest("[data-i]");
    if (it) { idx = +it.dataset.i; run(); }
  });
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  input.focus();
  renderList();
}

/* ---------- 按钮加载态 ---------- */
export async function withLoading(btn, fn, loadingText = "处理中…") {
  if (!btn || btn.classList.contains("is-loading")) return;
  const old = btn.innerHTML;
  btn.classList.add("is-loading");
  btn.innerHTML = `<span class="spin-dot"></span> ${loadingText}`;
  try { return await fn(); }
  catch (e) {
    toast(e.message || "操作失败", "error");
    return null;
  }
  finally { btn.classList.remove("is-loading"); btn.innerHTML = old; }
}
