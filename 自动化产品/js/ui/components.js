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
    $("#pmInput", ov).addEventListener("keydown", e => { if (e.key === "Enter") close($("#pmInput", ov).value.trim()); });
  });
}

/* 定稿发布弹窗：计划发布时间必填，备注可选。
   确认 → { planDate, note }；取消 → null */
export function publishModal({ title = "定稿并发布", okText = "定稿并发布", date = "", note = "" } = {}) {
  return new Promise(res => {
    const ov = document.createElement("div");
    ov.className = "modal-ov";
    ov.innerHTML = `
      <div class="modal-panel sm" role="dialog">
        <div class="mp-head"><b>${esc(title)}</b></div>
        <div class="mp-body">
          <p class="mp-sub">定稿后入供应商端，按发布序号可见可下载。请先填写计划发布时间：</p>
          <label class="field"><span>计划发布时间（必填）</span><input class="input" type="datetime-local" id="pubDate" value="${esc(date)}" required /></label>
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
        const planDate = $("#pubDate", ov).value || "";
        if (!planDate) { toast("请先填写计划发布时间", "error"); $("#pubDate", ov).focus(); return; }
        close({ planDate, note: $("#pubNote", ov).value.trim() });
      }
      else close(null);
    });
  });
}

/* ---------- 大弹层 / 抽屉 ---------- */
export function openModal(html, { wide = false, onMount } = {}) {
  const ov = document.createElement("div");
  ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal-panel ${wide ? "wide" : ""}" role="dialog">${html}</div>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("open"));
  let closed = false;
  const close = () => { if (closed) return; closed = true; document.removeEventListener("keydown", onKey); ov.classList.remove("open"); setTimeout(() => ov.remove(), 200); };
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
export function openPalette(commands) {
  const exist = $("#palette");
  if (exist) { exist.remove(); return; }
  const ov = document.createElement("div");
  ov.id = "palette";
  ov.className = "palette-ov";
  ov.innerHTML = `
    <div class="palette">
      <div class="pal-input-row">${icon("search", 16)}<input id="palInput" placeholder="搜索账号 / 任务 / 操作…" autocomplete="off" /></div>
      <div class="pal-list" id="palList"></div>
      <div class="pal-foot"><span>↑↓ 选择 · Enter 执行 · Esc 关闭</span></div>
    </div>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("open"));
  const input = $("#palInput", ov);
  const list = $("#palList", ov);
  let idx = 0, filtered = commands;
  const renderList = () => {
    list.innerHTML = filtered.slice(0, 12).map((c, i) => `
      <div class="pal-item ${i === idx ? "is-active" : ""}" data-i="${i}">
        <span class="pi-ico">${icon(c.icon || "arrowRight", 15)}</span>
        <span class="pi-main"><b>${esc(c.label)}</b>${c.hint ? `<em>${esc(c.hint)}</em>` : ""}</span>
        ${c.group ? `<span class="pi-group">${esc(c.group)}</span>` : ""}
      </div>`).join("") || `<div class="np-empty">没有匹配项</div>`;
  };
  const close = () => { ov.classList.remove("open"); setTimeout(() => ov.remove(), 160); document.removeEventListener("keydown", onKey); };
  const run = () => { const c = filtered[idx]; if (c) { close(); c.run(); } };
  const onKey = e => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(filtered.length - 1, idx + 1); renderList(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(0, idx - 1); renderList(); }
    else if (e.key === "Enter") { e.preventDefault(); run(); }
  };
  document.addEventListener("keydown", onKey);
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    filtered = !q ? commands : commands.filter(c => (c.label + (c.hint || "") + (c.group || "")).toLowerCase().includes(q));
    idx = 0; renderList();
  });
  list.addEventListener("click", e => { const it = e.target.closest("[data-i]"); if (it) { idx = +it.dataset.i; run(); } });
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
