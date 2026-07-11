import { $, $$, esc, gradFor, timeAgo } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state } from "../core/store.js";
import { emptyState, openModal, confirmModal, toast } from "../ui/components.js";
import * as remote from "../core/remote.js";
import { urlFor } from "../domain/assets.js";

const accountAvatar = acc => {
  const avatar = acc?.avatarUrl || (acc?.avatarAssetId ? urlFor(acc.avatarAssetId) : "");
  return avatar
    ? `<img src="${esc(avatar)}" alt=""/>`
    : `<span style="background:${gradFor(acc?.name || "账号")}">${esc((acc?.name || "?")[0])}</span>`;
};
let supplierAccountQuery = "";
let supplierPlatform = "all";

function transitionSupplier(render) {
  if (document.startViewTransition) document.startViewTransition(render);
  else render();
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
    const delivered = state.assets.filter(a => a.delivered);
    const published = delivered.filter(a => a.publishedUrl);
    root.innerHTML = `<div class="supplier-shell">
      <div class="page-head"><div><div class="eyebrow">供应商首页</div><h2>账号分配与发布进度</h2></div><button class="btn primary" id="supplierOverviewChildAdd">${icon("plus", 14)} 批量建立子账号</button></div>
      <div class="supplier-stats">
        <div><b>${children.length}</b><span>子账号</span></div><div><b>${bindings.length}</b><span>已分配账号</span></div>
        <div><b>${delivered.length}</b><span>待发布内容</span></div><div><b>${published.length}</b><span>已回传链接</span></div>
      </div>
      <section class="card supplier-activity"><div class="card-head supplier-activity-head"><b>最近操作</b></div>
        ${activity.length ? activity.slice(0, 30).map(x => `<div class="supplier-log"><i></i><span><b>${esc(x.memberName || "成员")}</b><em>${esc(x.detail || x.action || "更新了发布内容")}</em></span><time>${timeAgo(x.createdAt)}</time></div>`).join("") : emptyState("pulse", "暂无操作记录", "子账号下载、回传链接或更新观看量后会显示在这里")}
      </section>
    </div>`;
    $("#supplierOverviewChildAdd", root)?.addEventListener("click", () => createChildrenDialog(() => renderSupplierOverview(root)));
  } catch (e) {
    root.innerHTML = `<div class="supplier-shell">${emptyState("x", "供应商数据读取失败", esc(e.message || e))}</div>`;
  }
}

export async function renderSupplierAccounts(root) {
  root.innerHTML = `<div class="supplier-shell"><div class="page-head"><div><div class="eyebrow">全部账号</div><h2>自媒体账号分配看板</h2></div></div><div class="supplier-loading">正在读取...</div></div>`;
  try {
    const { children, bindings } = await supplierData();
    const childMap = new Map(children.map(x => [x.id, x]));
    const platforms = [...new Set(state.accounts.map(x => x.platform).filter(Boolean))];
    const visibleAccounts = state.accounts.filter(acc => (!supplierAccountQuery || `${acc.name} ${acc.platform} ${acc.mode}`.toLowerCase().includes(supplierAccountQuery.toLowerCase())) && (supplierPlatform === "all" || acc.platform === supplierPlatform));
    root.innerHTML = `<div class="supplier-shell"><div class="page-head"><div><div class="eyebrow">全部账号</div><h2>自媒体账号分配看板</h2></div></div>
      <div class="supplier-account-tools"><label>${icon("search", 14)}<input id="supplierAccountSearch" value="${esc(supplierAccountQuery)}" placeholder="搜索账号" /></label><div class="supplier-filter-chips"><button class="${supplierPlatform === "all" ? "on" : ""}" data-supplier-platform="all">全部平台</button>${platforms.map(x => `<button class="${supplierPlatform === x ? "on" : ""}" data-supplier-platform="${esc(x)}">${esc(x)}</button>`).join("")}</div></div>
      <div class="supplier-account-grid is-switching">${visibleAccounts.map(acc => {
        const binding = bindings.find(x => x.accountId === acc.id);
        const child = binding ? childMap.get(binding.childId) : null;
        return `<article class="supplier-account"><div class="supplier-account-avatar">${accountAvatar(acc)}</div><div><b>${esc(acc.name)}</b><em>${esc(acc.platform || "平台")} · ${esc(acc.mode || "内容")}</em></div><label class="supplier-inline-assign"><span>分配给</span><select data-account-assign="${esc(acc.id)}"><option value="">未分配</option>${children.map(c => `<option value="${esc(c.id)}" ${c.id === child?.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label></article>`;
      }).join("")}</div></div>`;
    let composing = false;
    $("#supplierAccountSearch", root)?.addEventListener("compositionstart", () => { composing = true; });
    $("#supplierAccountSearch", root)?.addEventListener("compositionend", e => { composing = false; supplierAccountQuery = e.currentTarget.value; transitionSupplier(() => renderSupplierAccounts(root)); });
    $("#supplierAccountSearch", root)?.addEventListener("input", e => { if (!composing && !e.isComposing) { supplierAccountQuery = e.currentTarget.value; transitionSupplier(() => renderSupplierAccounts(root)); } });
    $$("[data-supplier-platform]", root).forEach(b => b.addEventListener("click", () => { supplierPlatform = b.dataset.supplierPlatform; transitionSupplier(() => renderSupplierAccounts(root)); }));
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
  openModal(`<div class="mp-head"><b>分配账号 · ${esc(child.name)}</b><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
    <div class="mp-body"><div class="supplier-assign-list">${state.accounts.map(acc => `<label><input type="checkbox" value="${esc(acc.id)}" ${selected.has(acc.id) ? "checked" : ""}/><span class="supplier-account-avatar small">${accountAvatar(acc)}</span><b>${esc(acc.name)}</b><em>${esc(acc.platform || "平台")}</em></label>`).join("")}</div></div>
    <div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="supplierAssignSave">保存分配</button></div>`, { onMount(panel, close) {
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
      root.innerHTML = `<div class="supplier-shell">
        <div class="page-head"><div><div class="eyebrow">设置</div><h2>子账号与账号分配</h2></div><button class="btn primary" id="supplierChildAdd">${icon("plus", 14)} 批量建立子账号</button></div>
        <section class="card supplier-requests"><div class="card-head"><b>子账号申请</b><em>${requests.length} 条待处理</em></div>
          ${requests.length ? requests.map(r => `<div class="supplier-child-row"><span class="mem-ava" style="background:${gradFor(r.name)}">${esc((r.name || "?")[0])}</span><span><b>${esc(r.name)}</b><em>@${esc(r.username)} · ${r.createdAt ? timeAgo(r.createdAt) : "刚刚"}</em></span><button class="btn primary sm" data-supplier-approve="${r.id}">通过</button><button class="btn ghost sm danger" data-supplier-reject="${r.id}">拒绝</button></div>`).join("") : `<p class="supplier-empty">暂无待处理申请</p>`}
        </section>
        <section class="card supplier-children"><div class="card-head"><b>供应商子账号</b><em>为每个子账号分配可见的自媒体账号</em></div>
          ${children.length ? children.map(c => { const n = bindings.filter(x => x.childId === c.id).length; return `<div class="supplier-child-row"><span class="mem-ava" style="background:${gradFor(c.name)}">${esc((c.name || "?")[0])}</span><span><b>${esc(c.name)}</b><em>@${esc(c.username)} · 已分配 ${n} 个账号</em></span><button class="btn ghost sm" data-supplier-assign="${c.id}">${icon("grid", 13)} 分配账号</button><button class="icon-btn sm danger" data-supplier-delete="${c.id}" title="删除">${icon("trash", 13)}</button></div>`; }).join("") : emptyState("users", "还没有子账号", "可批量建立，或审批子账号申请")}
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
      root.innerHTML = `<div class="supplier-shell">${emptyState("x", "供应商设置读取失败", esc(e.message || e))}</div>`;
    }
  };
  draw();
}
