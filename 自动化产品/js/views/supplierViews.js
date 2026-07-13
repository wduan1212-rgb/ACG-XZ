import { $, $$, esc, timeAgo } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save } from "../core/store.js";
import { emptyState, openModal, confirmModal, toast, promptModal } from "../ui/components.js";
import * as remote from "../core/remote.js";
import { urlFor } from "../domain/assets.js";
import { deliveryViewsSummary } from "../domain/delivery.js";
import { normalizeHomepageUrl } from "../domain/accounts.js";

const accountAvatar = acc => {
  const avatar = acc?.avatarUrl || (acc?.avatarAssetId ? urlFor(acc.avatarAssetId) : "");
  return avatar
    ? `<img src="${esc(avatar)}" alt=""/>`
    : `<span class="supplier-avatar-fallback">${icon("user", 18)}</span>`;
};
let supplierAccountQuery = "";
let supplierPlatform = "all";
let supplierActivityType = "all";
let supplierActivityDays = "all";
let supplierViewsPlatform = "all";
const onSupplierRoute = zone => document.body.dataset.zone === zone;

function supplierActivityKind(item = {}) {
  const text = `${item.action || ""} ${item.detail || ""}`;
  if (/观看量|播放量|浏览量|观看|播放/.test(text)) return "views";
  if (/回传|发布链接|链接/.test(text)) return "link";
  if (/下载|领取素材|领取内容/.test(text)) return "download";
  return "other";
}

function supplierActivityTimestamp(item = {}) {
  if (typeof item.createdAt === "number") return item.createdAt;
  return Date.parse(item.createdAt || "") || 0;
}

async function supplierData() {
  const [children, bindings, activity] = await Promise.all([
    remote.supplier.children(), remote.supplier.bindings(), remote.supplier.activity()
  ]);
  return { children: children || [], bindings: bindings || [], activity: activity || [] };
}

export async function renderSupplierOverview(root) {
  root.innerHTML = `<div class="supplier-shell"><div class="page-head"><div><div class="eyebrow">供应商首页</div><h2>账号分配与发布进度</h2></div></div><div class="supplier-loading">正在读取...</div></div>`;
  try {
    const { children, bindings, activity } = await supplierData();
    if (!onSupplierRoute("overview")) return;
    const delivered = state.assets.filter(a => a.delivered);
    const published = delivered.filter(a => a.publishedUrl);
    const views = deliveryViewsSummary(supplierViewsPlatform);
    root.innerHTML = `<div class="supplier-shell">
      <div class="page-head"><div><div class="eyebrow">供应商首页</div><h2>账号分配与发布进度</h2></div><button class="btn primary" id="supplierOverviewChildAdd">${icon("plus", 14)} 批量建立子账号</button></div>
      <div class="supplier-stats">
        <div><b>${children.length}</b><span>子账号</span></div><div><b>${bindings.length}</b><span>已分配账号</span></div>
        <div><b>${delivered.length}</b><span>待发布内容</span></div><div><b>${published.length}</b><span>已回传链接</span></div>
        <div class="supplier-views-stat"><b id="supplierViewsTotal">${Number(views.totalViews || 0).toLocaleString("zh-CN")}</b><span>总播放量 · ${esc(supplierViewsPlatform === "all" ? "全平台" : supplierViewsPlatform)}</span><div class="supplier-stat-switch"><button class="${supplierViewsPlatform === "all" ? "on" : ""}" data-views-platform="all">全部</button><button class="${supplierViewsPlatform === "小红书" ? "on" : ""}" data-views-platform="小红书">小红书</button><button class="${supplierViewsPlatform === "视频号" ? "on" : ""}" data-views-platform="视频号">视频号</button></div></div>
      </div>
      <section class="card supplier-activity"><div class="card-head supplier-activity-head"><b>最近操作</b>
        ${activity.length ? `<div class="supplier-activity-filters">
          <label class="select-shell">${icon("filter", 12)}<select id="supplierActivityType"><option value="all">全部操作</option><option value="views" ${supplierActivityType === "views" ? "selected" : ""}>编辑观看量</option><option value="link" ${supplierActivityType === "link" ? "selected" : ""}>回传链接</option><option value="download" ${supplierActivityType === "download" ? "selected" : ""}>下载素材</option><option value="other" ${supplierActivityType === "other" ? "selected" : ""}>其他操作</option></select>${icon("chevronDown", 11)}</label>
          <label class="select-shell">${icon("clock", 12)}<select id="supplierActivityDays"><option value="all">全部时间</option><option value="7" ${supplierActivityDays === "7" ? "selected" : ""}>近 7 天</option><option value="30" ${supplierActivityDays === "30" ? "selected" : ""}>近 30 天</option></select>${icon("chevronDown", 11)}</label>
        </div>` : ""}</div>
        ${activity.length ? activity.slice(0, 60).map(x => `<div class="supplier-log" data-activity-kind="${supplierActivityKind(x)}" data-activity-ts="${supplierActivityTimestamp(x)}"><i></i><span><b>${esc(x.memberName || "成员")}</b><em>${esc(x.detail || x.action || "更新了发布内容")}</em></span><time>${timeAgo(x.createdAt)}</time></div>`).join("") + `<p class="supplier-activity-empty" hidden>当前筛选下暂无操作</p>` : emptyState("pulse", "暂无操作记录", "子账号下载、回传链接或更新观看量后会显示在这里")}
      </section>
    </div>`;
    const applyActivityFilters = () => {
      const cutoff = supplierActivityDays === "all" ? 0 : Date.now() - Number(supplierActivityDays) * 86400000;
      let visible = 0;
      $$("[data-activity-kind]", root).forEach(row => {
        const show = (supplierActivityType === "all" || row.dataset.activityKind === supplierActivityType)
          && (!cutoff || Number(row.dataset.activityTs || 0) >= cutoff);
        row.hidden = !show;
        if (show) visible += 1;
      });
      const empty = $(".supplier-activity-empty", root);
      if (empty) empty.hidden = visible > 0;
    };
    $("#supplierActivityType", root)?.addEventListener("change", e => { supplierActivityType = e.currentTarget.value; applyActivityFilters(); });
    $("#supplierActivityDays", root)?.addEventListener("change", e => { supplierActivityDays = e.currentTarget.value; applyActivityFilters(); });
    applyActivityFilters();
    $$('[data-views-platform]', root).forEach(button => button.addEventListener("click", () => {
      const next = button.dataset.viewsPlatform || "all";
      if (next === supplierViewsPlatform) return;
      supplierViewsPlatform = next;
      const nextSummary = deliveryViewsSummary(next);
      const total = $("#supplierViewsTotal", root);
      if (total) total.textContent = Number(nextSummary.totalViews || 0).toLocaleString("zh-CN");
      $$('[data-views-platform]', root).forEach(item => item.classList.toggle("on", item.dataset.viewsPlatform === next));
      const label = total?.nextElementSibling;
      if (label) label.textContent = `总播放量 · ${next === "all" ? "全平台" : next}`;
      total?.animate?.([{ opacity: .35, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
    }));
    $("#supplierOverviewChildAdd", root)?.addEventListener("click", () => createChildrenDialog(() => renderSupplierOverview(root)));
  } catch (e) {
    if (!onSupplierRoute("overview")) return;
    root.innerHTML = `<div class="supplier-shell">${emptyState("x", "供应商数据读取失败", esc(e.message || e))}</div>`;
  }
}

export async function renderSupplierAccounts(root) {
  root.innerHTML = `<div class="supplier-shell"><div class="page-head"><div><div class="eyebrow">全部账号</div><h2>自媒体账号分配看板</h2></div></div><div class="supplier-loading">正在读取...</div></div>`;
  try {
    const { children, bindings } = await supplierData();
    if (!onSupplierRoute("assets")) return;
    const childMap = new Map(children.map(x => [x.id, x]));
    const platforms = [...new Set(state.accounts.map(x => x.platform).filter(Boolean))];
    const canEditHomepage = ["supplier", "supplier_parent"].includes(state.role);
    const homepageActionsHtml = acc => `<div class="supplier-homepage-actions" data-homepage-actions="${esc(acc.id)}">${acc.homepageUrl ? `<a class="btn ghost sm" href="${esc(acc.homepageUrl)}" target="_blank" rel="noopener noreferrer">${icon("link", 12)} 查看主页</a>` : `<span>未填写主页</span>`}${canEditHomepage ? `<button class="btn ghost sm" type="button" data-homepage-edit="${esc(acc.id)}">${icon("edit", 12)} 编辑主页链接</button>` : ""}</div>`;
    root.innerHTML = `<div class="supplier-shell"><div class="page-head"><div><div class="eyebrow">全部账号</div><h2>自媒体账号分配看板</h2></div></div>
      <div class="supplier-account-tools"><label>${icon("search", 14)}<input id="supplierAccountSearch" value="${esc(supplierAccountQuery)}" placeholder="搜索账号" /></label><div class="supplier-filter-chips"><button class="${supplierPlatform === "all" ? "on" : ""}" data-supplier-platform="all">全部平台</button>${platforms.map(x => `<button class="${supplierPlatform === x ? "on" : ""}" data-supplier-platform="${esc(x)}">${esc(x)}</button>`).join("")}</div></div>
      <div class="supplier-account-grid">${state.accounts.map(acc => {
        const binding = bindings.find(x => x.accountId === acc.id);
        const child = binding ? childMap.get(binding.childId) : null;
        const searchable = `${acc.name} ${acc.platform} ${acc.mode}`.toLowerCase();
        const hidden = (supplierAccountQuery && !searchable.includes(supplierAccountQuery.toLowerCase())) || (supplierPlatform !== "all" && acc.platform !== supplierPlatform);
        return `<article class="supplier-account" data-account-id="${esc(acc.id)}" data-account-search="${esc(searchable)}" data-account-platform="${esc(acc.platform || "")}" ${hidden ? "hidden" : ""}><div class="supplier-account-avatar">${accountAvatar(acc)}</div><div class="supplier-account-copy"><b>${esc(acc.name)}</b><em>${esc(acc.platform || "平台")} · ${esc(acc.mode || "内容")}</em></div><div class="supplier-account-controls">${homepageActionsHtml(acc)}<label class="supplier-inline-assign"><span>分配给</span><select data-account-assign="${esc(acc.id)}" ${canEditHomepage ? "" : "disabled"}><option value="">未分配</option>${children.map(c => `<option value="${esc(c.id)}" ${c.id === child?.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label></div></article>`;
      }).join("")}</div></div>`;
    const applyAccountFilters = () => {
      const cards = $$(".supplier-account", root);
      const before = new Map(cards.filter(card => !card.hidden).map(card => [card, card.getBoundingClientRect()]));
      const query = supplierAccountQuery.trim().toLowerCase();
      cards.forEach(card => {
        card.hidden = !!query && !card.dataset.accountSearch.includes(query)
          || supplierPlatform !== "all" && card.dataset.accountPlatform !== supplierPlatform;
      });
      $$('[data-supplier-platform]', root).forEach(button => button.classList.toggle("on", button.dataset.supplierPlatform === supplierPlatform));
      requestAnimationFrame(() => cards.filter(card => !card.hidden).forEach(card => {
        const oldRect = before.get(card);
        if (!oldRect) return card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
        const nextRect = card.getBoundingClientRect();
        const dx = oldRect.left - nextRect.left;
        const dy = oldRect.top - nextRect.top;
        if (dx || dy) card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 210, easing: "cubic-bezier(.2,.8,.2,1)" });
      }));
    };
    let composing = false;
    $("#supplierAccountSearch", root)?.addEventListener("compositionstart", () => { composing = true; });
    $("#supplierAccountSearch", root)?.addEventListener("compositionend", e => { composing = false; supplierAccountQuery = e.currentTarget.value; applyAccountFilters(); });
    $("#supplierAccountSearch", root)?.addEventListener("input", e => { if (!composing && !e.isComposing) { supplierAccountQuery = e.currentTarget.value; applyAccountFilters(); } });
    $$("[data-supplier-platform]", root).forEach(b => b.addEventListener("click", () => { supplierPlatform = b.dataset.supplierPlatform; applyAccountFilters(); }));
    const wireHomepageEdit = scope => {
      $$('[data-homepage-edit]', scope).forEach(button => button.addEventListener("click", async () => {
        const acc = state.accounts.find(item => item.id === button.dataset.homepageEdit);
        if (!acc || !canEditHomepage) return;
        const value = await promptModal({ title: `编辑主页链接 · ${acc.name}`, value: acc.homepageUrl || "", placeholder: "https://...（留空可清除）" });
        if (value == null) return;
        let homepageUrl = "";
        try { homepageUrl = normalizeHomepageUrl(value); }
        catch (err) { toast(err.message || "主页链接格式不正确", "error"); return; }
        button.disabled = true;
        try {
          if (remote.isOn()) {
            const result = await remote.supplier.updateHomepage(acc.id, homepageUrl);
            Object.assign(acc, result.account || { homepageUrl });
          } else {
            acc.homepageUrl = homepageUrl;
            acc.updatedAt = Date.now();
            save("accounts");
          }
          const actions = root.querySelector(`[data-homepage-actions="${CSS.escape(acc.id)}"]`);
          if (actions) {
            actions.outerHTML = homepageActionsHtml(acc);
            const card = root.querySelector(`[data-account-id="${CSS.escape(acc.id)}"]`);
            if (card) wireHomepageEdit(card);
          }
          toast(homepageUrl ? "主页链接已更新" : "主页链接已清除");
        } catch (err) {
          button.disabled = false;
          toast(err.message || "主页链接更新失败", "error");
        }
      }));
    };
    wireHomepageEdit(root);
    $$("[data-account-assign]", root).forEach(sel => sel.addEventListener("change", async () => {
      const accountId = sel.dataset.accountAssign;
      const childId = sel.value;
      const previousBinding = bindings.find(x => x.accountId === accountId);
      const previousValue = previousBinding?.childId || "";
      sel.disabled = true;
      try {
        if (childId) {
          const current = bindings.filter(x => x.childId === childId).map(x => x.accountId).filter(x => x !== accountId);
          await remote.supplier.bindAccounts(childId, [...current, accountId]);
        } else if (previousBinding?.childId) {
          await remote.supplier.bindAccounts(previousBinding.childId, bindings.filter(x => x.childId === previousBinding.childId && x.accountId !== accountId).map(x => x.accountId));
        }
        const oldIndex = bindings.findIndex(x => x.accountId === accountId);
        if (oldIndex >= 0) bindings.splice(oldIndex, 1);
        if (childId) bindings.push({ accountId, childId });
        toast("分配已更新");
      } catch (e) {
        sel.value = previousValue;
        toast(e.message || String(e), "error");
      } finally {
        sel.disabled = false;
      }
    }));
  } catch (e) {
    if (!onSupplierRoute("assets")) return;
    root.innerHTML = `<div class="supplier-shell">${emptyState("x", "账号看板读取失败", esc(e.message || e))}</div>`;
  }
}

function createChildrenDialog(onDone) {
  openModal(`<div class="mp-head"><b>批量建立子账号</b><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
    <div class="mp-body supplier-child-modal-body"><div class="supplier-child-editor" id="supplierChildRows">${[0, 1].map(i => `<div class="supplier-child-edit-row"><input class="input" data-child-name placeholder="姓名"/><input class="input" data-child-user placeholder="用户名"/><input class="input" data-child-pin type="password" placeholder="初始密码"/><button class="icon-btn danger" type="button" data-child-row-remove title="删除此行">${icon("trash", 14)}</button></div>`).join("")}</div><button class="btn ghost sm supplier-child-add-row" type="button" id="supplierChildRowAdd">${icon("plus", 13)} 添加一行</button></div>
    <div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="supplierChildCreate">创建账号</button></div>`, { onMount(panel, close) {
      panel.classList.add("supplier-child-modal");
      const addRow = () => { const row = document.createElement("div"); row.className = "supplier-child-edit-row is-entering"; row.innerHTML = `<input class="input" data-child-name placeholder="姓名"/><input class="input" data-child-user placeholder="用户名"/><input class="input" data-child-pin type="password" placeholder="初始密码"/><button class="icon-btn danger" type="button" data-child-row-remove title="删除此行">${icon("trash", 14)}</button>`; const rows = $("#supplierChildRows", panel); rows.appendChild(row); requestAnimationFrame(() => row.classList.remove("is-entering")); rows.scrollTo({ top: rows.scrollHeight, behavior: "smooth" }); };
      $("#supplierChildRowAdd", panel).addEventListener("click", addRow);
      panel.addEventListener("click", e => { const b = e.target.closest("[data-child-row-remove]"); if (b && $$(".supplier-child-edit-row", panel).length > 1) { const row = b.closest(".supplier-child-edit-row"); row.classList.add("is-leaving"); row.addEventListener("transitionend", () => row.remove(), { once: true }); setTimeout(() => row.remove(), 220); } });
      $("#supplierChildCreate", panel).addEventListener("click", async () => {
        const items = $$(".supplier-child-edit-row", panel).map(row => ({ name: $("[data-child-name]", row).value.trim(), username: $("[data-child-user]", row).value.trim(), pin: $("[data-child-pin]", row).value.trim(), role: "supplier_child" })).filter(x => x.name || x.username || x.pin);
        if (items.some(x => !x.name || !x.username || !x.pin)) { toast("每一行都要填写姓名、用户名和初始密码", "error"); return; }
        if (!items.length) { toast("请按示例填写至少一个子账号", "error"); return; }
        try { await remote.supplier.addChildren(items); close(); toast(`已创建 ${items.length} 个子账号`); onDone(); } catch (e) { toast((e.message || String(e)).replace(/^HTTP\s+\d+\s+/, ""), "error"); }
      });
    }});
}

function assignDialog(child, bindings, onDone) {
  const selected = new Set(bindings.filter(x => x.childId === child.id).map(x => x.accountId));
  const platforms = [...new Set(state.accounts.map(acc => acc.platform).filter(Boolean))];
  openModal(`<div class="mp-head"><b>分配账号 · ${esc(child.name)}</b><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
    <div class="mp-body"><div class="supplier-assign-tools"><label>${icon("search", 13)}<input id="supplierAssignSearch" placeholder="搜索账号" /></label><div class="supplier-filter-chips"><button class="on" type="button" data-assign-platform="all">全部</button>${platforms.map(platform => `<button type="button" data-assign-platform="${esc(platform)}">${esc(platform)}</button>`).join("")}</div></div><div class="supplier-assign-list">${state.accounts.map(acc => `<label data-assign-row data-search="${esc(`${acc.name} ${acc.platform} ${acc.mode}`.toLowerCase())}" data-platform="${esc(acc.platform || "")}"><input type="checkbox" value="${esc(acc.id)}" ${selected.has(acc.id) ? "checked" : ""}/><span class="supplier-account-avatar small">${accountAvatar(acc)}</span><b>${esc(acc.name)}</b><em>${esc(acc.platform || "平台")}</em></label>`).join("")}</div><p class="supplier-assign-empty" hidden>当前筛选下没有账号</p></div>
    <div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="supplierAssignSave">保存分配</button></div>`, { onMount(panel, close) {
      let query = "";
      let platform = "all";
      const apply = () => {
        let visible = 0;
        $$('[data-assign-row]', panel).forEach(row => {
          const show = (!query || row.dataset.search.includes(query)) && (platform === "all" || row.dataset.platform === platform);
          row.hidden = !show;
          if (show) visible++;
        });
        const empty = $(".supplier-assign-empty", panel);
        if (empty) empty.hidden = visible > 0;
      };
      $("#supplierAssignSearch", panel)?.addEventListener("input", event => { query = event.currentTarget.value.trim().toLowerCase(); apply(); });
      $$('[data-assign-platform]', panel).forEach(button => button.addEventListener("click", () => {
        platform = button.dataset.assignPlatform || "all";
        $$('[data-assign-platform]', panel).forEach(item => item.classList.toggle("on", item === button));
        apply();
      }));
      $("#supplierAssignSave", panel).addEventListener("click", async () => {
        const ids = $$('input[type="checkbox"]:checked', panel).map(x => x.value);
        try { await remote.supplier.bindAccounts(child.id, ids); close(); toast("账号分配已更新"); onDone(); } catch (e) { toast(e.message || String(e), "error"); }
      });
    }});
}

export async function renderSupplierSettings(root) {
  root.innerHTML = `<div class="supplier-shell"><div class="page-head"><div><div class="eyebrow">设置</div><h2>子账号与账号分配</h2></div></div><div class="supplier-loading">正在读取...</div></div>`;
  const draw = async () => {
    try {
      const [{ children, bindings }, requests] = await Promise.all([supplierData(), remote.memberRequests.list("pending")]);
      if (!onSupplierRoute("settings")) return;
      root.innerHTML = `<div class="supplier-shell">
        <div class="page-head"><div><div class="eyebrow">设置</div><h2>子账号与账号分配</h2></div><button class="btn primary" id="supplierChildAdd">${icon("plus", 14)} 批量建立子账号</button></div>
        <section class="card supplier-requests"><div class="card-head"><b>子账号申请</b><em>${requests.length} 条待处理</em></div>
          ${requests.length ? requests.map(r => `<div class="supplier-child-row"><span class="mem-ava supplier-member-fallback">${icon("user", 15)}</span><span><b>${esc(r.name)}</b><em>@${esc(r.username)} · ${r.createdAt ? timeAgo(r.createdAt) : "刚刚"}</em></span><button class="btn primary sm" data-supplier-approve="${r.id}">通过</button><button class="btn ghost sm danger" data-supplier-reject="${r.id}">拒绝</button></div>`).join("") : `<p class="supplier-empty">暂无待处理申请</p>`}
        </section>
        <section class="card supplier-children"><div class="card-head"><b>供应商子账号</b><em>为每个子账号分配可见的自媒体账号</em></div>
          ${children.length ? children.map(c => { const n = bindings.filter(x => x.childId === c.id).length; return `<div class="supplier-child-row"><span class="mem-ava supplier-member-fallback">${icon("user", 15)}</span><span><b>${esc(c.name)}</b><em>@${esc(c.username)} · 已分配 ${n} 个账号</em></span><button class="btn ghost sm" data-supplier-assign="${c.id}">${icon("grid", 13)} 分配账号</button><button class="icon-btn sm danger" data-supplier-delete="${c.id}" title="删除">${icon("trash", 13)}</button></div>`; }).join("") : emptyState("users", "还没有子账号", "可批量建立，或审批子账号申请")}
        </section>
      </div>`;
      $("#supplierChildAdd", root)?.addEventListener("click", () => createChildrenDialog(draw));
      $$('[data-supplier-assign]', root).forEach(b => b.addEventListener("click", () => assignDialog(children.find(x => x.id === b.dataset.supplierAssign), bindings, draw)));
      $$('[data-supplier-approve]', root).forEach(b => b.addEventListener("click", async () => { await remote.memberRequests.approve(b.dataset.supplierApprove); toast("申请已通过"); draw(); }));
      $$('[data-supplier-reject]', root).forEach(b => b.addEventListener("click", async () => { await remote.memberRequests.reject(b.dataset.supplierReject); toast("申请已拒绝"); draw(); }));
      $$('[data-supplier-delete]', root).forEach(b => b.addEventListener("click", async () => {
        const c = children.find(x => x.id === b.dataset.supplierDelete);
        if (await confirmModal({ title: `删除子账号「${esc(c?.name || "") }」？`, danger: true, okText: "删除" })) { await remote.supplier.removeChild(b.dataset.supplierDelete); toast("子账号已删除"); draw(); }
      }));
    } catch (e) {
      if (!onSupplierRoute("settings")) return;
      root.innerHTML = `<div class="supplier-shell">${emptyState("x", "供应商设置读取失败", esc(e.message || e))}</div>`;
    }
  };
  draw();
}
