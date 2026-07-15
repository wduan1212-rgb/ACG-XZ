/* 设置：成员、角色与产品资料。运行服务配置只保留在服务端。 */

import { $, $$, esc } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, saveMembers, ROLE_LABEL } from "../core/store.js";
import { toast, confirmModal, promptModal, openModal } from "../ui/components.js";
import { uid } from "../core/util.js";
import * as remote from "../core/remote.js?v=20260715-v82-4";
import { renderSupplierSettings } from "./supplierViews.js?v=20260715-v82-4";

const ROLE_DESC = { admin: "管理员", editor: "创作成员", supplier_parent: "供应商管理员", supplier_child: "供应商子账号" };
const ROLE_OPTS = ["admin", "editor", "supplier_parent"];

function productFromText(text = {}) {
  const raw = typeof text === "string" ? text : (text.raw || "");
  const title = (raw.match(/^#\s+(.+)$/m) || raw.match(/^产品名称[：:]\s*(.+)$/m) || [])[1]?.trim();
  return {
    id: text.id || uid(),
    name: text.name || title || "未命名产品",
    shortName: text.shortName || title || text.name || "产品",
    category: text.category || (raw.match(/^产品类别[：:]\s*(.+)$/m) || [])[1]?.trim() || "待补充",
    brief: text.brief || raw.replace(/^#.+$/m, "").trim().slice(0, 1200) || "待补充产品描述",
    toneRule: text.toneRule || "可信、理性、有梗、像真实用户经验分享；不要硬广，不要强 CTA。",
    updatedAt: Date.now()
  };
}

export const settingsView = {
  render(root) {
    if (["supplier", "supplier_parent"].includes(state.role)) { renderSupplierSettings(root); return; }
    let memberRequests = [];
    let requestsLoaded = false;
    const canReviewRequests = () => remote.isOn() && state.role === "admin";
    const draw = () => {
      root.innerHTML = `
        <div class="settings-page">
          <section class="card set-data product-library">
            <div class="card-head"><b>产品库</b><em>仅提供产品事实、界面与视觉边界参考，不直接决定标题和文案</em>
              <button class="btn primary sm" id="prodAdd">${icon("plus", 13)} 添加产品</button></div>
            <div class="prod-list">
              ${state.products.map(p => `
                <div class="key-row product-row">
                  <span class="ovt-main"><b>${esc(p.name)}</b><em>${esc(p.category || "未分类")} · ${esc((p.brief || "").slice(0, 80))}${(p.brief || "").length > 80 ? "…" : ""}</em></span>
                  <button class="icon-btn sm" data-pedit="${p.id}" title="编辑">${icon("edit", 13)}</button>
                  <button class="icon-btn sm danger" data-pdel="${p.id}" title="删除" ${state.products.length <= 1 ? "disabled" : ""}>${icon("trash", 13)}</button>
                </div>`).join("")}
            </div>
          </section>

          ${canReviewRequests() ? `<section class="card set-data member-requests">
            <div class="card-head"><b>成员申请</b><em>${requestsLoaded ? `${memberRequests.length} 条待审批` : "正在读取申请"}</em>
              <button class="btn ghost sm" id="reqRefresh">${icon("pulse", 13)} 刷新</button></div>
            <div class="mem-list">
              ${!requestsLoaded ? `<div class="muted" style="padding:8px 2px">正在读取申请...</div>` : memberRequests.length ? memberRequests.map(r => `
                <div class="mem-row">
                  <span class="ovt-main"><b>${esc(r.name)}</b><em>@${esc(r.username)} · 申请角色：${ROLE_LABEL[r.role] || r.role} · ${r.createdAt ? new Date(r.createdAt).toLocaleString() : ""}</em></span>
                  <button class="btn primary sm" data-rapprove="${r.id}">${icon("check", 13)} 通过</button>
                  <button class="btn ghost sm danger" data-rreject="${r.id}">${icon("x", 13)} 拒绝</button>
                </div>`).join("") : `<div class="muted" style="padding:8px 2px">暂无待审批申请。</div>`}
            </div>
          </section>` : ""}

          <section class="card set-data member-accounts">
            <div class="card-head"><b>成员账号</b><em>每人一个账号与权限，创作互不干扰；资产库与发布清单全员共享</em>
              <button class="btn primary sm" id="memAdd">${icon("plus", 13)} 添加成员</button></div>
            <div class="mem-list" id="memList">
              ${state.members.map(m => `
                <div class="mem-row" data-mem="${m.id}">
                  <span class="ovt-main"><b>${esc(m.name)} ${m.id === state.ui.currentMemberId ? `<i class="mem-me">当前</i>` : ""}</b><em>@${esc(m.username)} · ${ROLE_DESC[m.role] || ROLE_LABEL[m.role] || m.role}</em></span>
                  <span class="mem-role tag ${m.role}">${ROLE_LABEL[m.role] || m.role}</span>
                  <button class="icon-btn sm" data-medit="${m.id}" title="编辑">${icon("edit", 13)}</button>
                  <button class="icon-btn sm danger" data-mdel="${m.id}" title="删除" ${m.id === state.ui.currentMemberId ? "disabled" : ""}>${icon("trash", 13)}</button>
                </div>`).join("")}
            </div>
          </section>

        </div>`;
      wire();
    };

    async function loadRequests() {
      if (!canReviewRequests()) return;
      try {
        memberRequests = (await remote.memberRequests.list("pending")).filter(x => x.role !== "supplier_child");
        requestsLoaded = true;
        draw();
      } catch (e) {
        requestsLoaded = true;
        toast("读取成员申请失败：" + (e.message || e));
        draw();
      }
    }

    function wire() {
      const productDialog = (item) => {
        const editing = !!item;
        const p0 = item || productFromText("");
        openModal(`
          <div class="mp-head"><b>${editing ? "编辑产品" : "添加产品"}</b><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
          <div class="mp-body">
            <div class="set-grid">
              <label class="field">产品名称<input class="input" id="pdName" value="${esc(p0.name)}" placeholder="例如：百度搭子" /></label>
              <label class="field">短名称<input class="input" id="pdShort" value="${esc(p0.shortName || "")}" placeholder="用于标题/口播，例如 百度搭子" /></label>
              <label class="field">产品类别<input class="input" id="pdCat" value="${esc(p0.category || "")}" placeholder="例如：办公效率 AI Agent" /></label>
              <label class="field">表达要求<input class="input" id="pdTone" value="${esc(p0.toneRule || "")}" placeholder="例如：理性、有梗、不要硬广" /></label>
            </div>
            <label class="field">产品描述 / Markdown
              <textarea class="input" id="pdBrief" rows="9" placeholder="可直接粘贴产品 md、卖点、功能、禁忌、目标人群">${esc(p0.brief || "")}</textarea>
            </label>
            <label class="btn ghost sm">${icon("upload", 13)} 读取 md / txt 文件<input type="file" accept=".md,.txt,text/markdown,text/plain" hidden id="pdFile" /></label>
          </div>
          <div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="pdSave">${editing ? "保存" : "添加"}</button></div>
        `, { onMount(panel, close) {
          $("#pdFile", panel).addEventListener("change", async e => {
            const f = e.target.files[0]; e.target.value = "";
            if (!f) return;
            const text = await f.text();
            const parsed = productFromText(text);
            if (!$("#pdName", panel).value.trim()) $("#pdName", panel).value = parsed.name;
            if (!$("#pdShort", panel).value.trim()) $("#pdShort", panel).value = parsed.shortName;
            if (!$("#pdCat", panel).value.trim()) $("#pdCat", panel).value = parsed.category;
            $("#pdBrief", panel).value = text.trim();
          });
          $("#pdSave", panel).addEventListener("click", () => {
            const item2 = productFromText({
              id: p0.id,
              name: $("#pdName", panel).value.trim(),
              shortName: $("#pdShort", panel).value.trim(),
              category: $("#pdCat", panel).value.trim(),
              brief: $("#pdBrief", panel).value.trim(),
              toneRule: $("#pdTone", panel).value.trim()
            });
            if (!item2.name) { toast("请填写产品名称"); return; }
            if (editing) Object.assign(item, item2);
            else state.products.push(item2);
            save("products", "meta");
            close(); draw();
            toast(editing ? "产品已更新" : "产品已添加");
          });
        }});
      };
      $("#prodAdd", root)?.addEventListener("click", () => productDialog(null));
      $$("[data-pedit]", root).forEach(b => b.addEventListener("click", () => productDialog(state.products.find(p => p.id === b.dataset.pedit))));
      $$("[data-pdel]", root).forEach(b => b.addEventListener("click", async () => {
        const p = state.products.find(x => x.id === b.dataset.pdel);
        if (!p || state.products.length <= 1) return;
        const ok = await confirmModal({ title: `删除产品「${p.name}」？`, body: "已有任务仍会保留原产品 id；后续可手动切换。", danger: true, okText: "删除" });
        if (!ok) return;
        state.products = state.products.filter(x => x.id !== p.id);
        save("products", "meta");
        draw();
        toast("产品已删除");
      }));
      $("#reqRefresh", root)?.addEventListener("click", () => loadRequests());
      $$("[data-rapprove]", root).forEach(b => b.addEventListener("click", async () => {
        const req = memberRequests.find(x => x.id === b.dataset.rapprove);
        const ok = await confirmModal({ title: `通过「${req?.name || "成员"}」的账号申请？`, body: `将创建登录账号 @${req?.username || ""}。`, okText: "通过申请" });
        if (!ok) return;
        try {
          await remote.memberRequests.approve(b.dataset.rapprove);
          state.members = await remote.members.list();
          saveMembers();
          toast("申请已通过，成员可登录");
          await loadRequests();
        } catch (e) {
          toast("审批失败：" + (e.message || e));
        }
      }));
      $$("[data-rreject]", root).forEach(b => b.addEventListener("click", async () => {
        const req = memberRequests.find(x => x.id === b.dataset.rreject);
        const ok = await confirmModal({ title: `拒绝「${req?.name || "成员"}」的账号申请？`, danger: true, okText: "拒绝申请" });
        if (!ok) return;
        try {
          await remote.memberRequests.reject(b.dataset.rreject);
          toast("申请已拒绝");
          await loadRequests();
        } catch (e) {
          toast("操作失败：" + (e.message || e));
        }
      }));
      const memberDialog = (m) => {
        const editing = !!m;
        m = m || { name: "", username: "", pin: "", role: "editor" };
        openModal(`
          <div class="mp-head"><b>${editing ? "编辑成员" : "添加成员"}</b><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
          <div class="mp-body">
            <label class="field">姓名<input class="input" id="mdName" value="${esc(m.name)}" placeholder="例如：小红" /></label>
            <label class="field">用户名（登录用）<input class="input" id="mdUser" value="${esc(m.username)}" placeholder="字母/数字，唯一" /></label>
            <label class="field">${editing ? "重设登录密码（留空不改）" : "初始登录密码"}<input class="input" id="mdPin" type="password" value="" autocomplete="new-password" placeholder="${editing ? "设置新密码" : "登录密码"}" /></label>
            <label class="field">角色
              <select class="input" id="mdRole">
                ${ROLE_OPTS.map(r => `<option value="${r}" ${m.role === r ? "selected" : ""}>${ROLE_DESC[r]}</option>`).join("")}
              </select>
            </label>
          </div>
          <div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="mdSave">${editing ? "保存" : "添加"}</button></div>
        `, { onMount(panel, close) {
          $("#mdSave", panel).addEventListener("click", async () => {
            const name = $("#mdName", panel).value.trim();
            const username = $("#mdUser", panel).value.trim();
            const pin = $("#mdPin", panel).value.trim();
            const role = $("#mdRole", panel).value;
            const pinOptional = editing && remote.isOn();   // 远端编辑时口令留空=不修改
            if (!name || !username || (!pin && !pinOptional)) { toast(`姓名 / 用户名${pinOptional ? "" : " / 口令"}都要填`); return; }
            if (state.members.some(x => x.username === username && x.id !== m.id)) { toast("用户名已存在"); return; }
            if (remote.isOn()) {
              try {
                const savedMember = editing
                  ? await remote.members.update(m.id, { name, username, ...(pin ? { pin } : {}), role })
                  : await remote.members.add({ name, username, pin, role });
                if (!savedMember || savedMember.role !== role) throw new Error("角色保存未生效，请刷新后重试");
                state.members = state.members.filter(x => x.id !== savedMember.id).concat(savedMember);
                state.members = await remote.members.list(true);
                saveMembers();
              } catch (e) { toast("保存失败：" + (e.message || e)); return; }
            } else {
              if (editing) { const t = state.members.find(x => x.id === m.id); Object.assign(t, { name, username, ...(pin ? { pin } : {}), role }); }
              else state.members.push({ id: uid(), name, username, pin, role, createdAt: Date.now() });
              saveMembers();
            }
            close(); draw();
            toast(editing ? "成员已更新" : "成员已添加");
          });
        }});
      };
      const mAdd = $("#memAdd", root);
      if (mAdd) mAdd.addEventListener("click", () => memberDialog(null));
      $$("[data-medit]", root).forEach(b => b.addEventListener("click", () => memberDialog(state.members.find(m => m.id === b.dataset.medit))));
      $$("[data-mdel]", root).forEach(b => b.addEventListener("click", async () => {
        const m = state.members.find(x => x.id === b.dataset.mdel);
        if (!m) return;
        const ok = await confirmModal({ title: `删除成员「${m.name}」？`, body: "其创作记录会保留但归属置空。", danger: true, okText: "删除" });
        if (!ok) return;
        if (remote.isOn()) {
          try { await remote.members.remove(m.id); state.members = await remote.members.list(); saveMembers(); }
          catch (e) { toast("删除失败：" + (e.message || e)); return; }
        } else {
          state.members = state.members.filter(x => x.id !== m.id);
          saveMembers();
        }
        draw();
        toast("成员已删除");
      }));

    }

    draw();
    loadRequests();
  }
};
