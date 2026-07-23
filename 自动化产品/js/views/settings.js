/* 设置：成员、角色与产品资料。运行服务配置只保留在服务端。 */

import { $, $$, esc } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, saveMembers, ROLE_LABEL } from "../core/store.js";
import { toast, confirmModal, promptModal, openModal } from "../ui/components.js";
import { uid } from "../core/util.js";
import * as remote from "../core/remote.js";
import { renderSupplierSettings } from "./supplierViews.js?v=20260723-v117-2";

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
    let apiUsageRows = [];
    let apiUsageLoaded = false;
    let productLibraryOpen = false;
    const canReviewRequests = () => remote.isOn() && state.role === "admin";
    const canSeeApiUsage = () => remote.isOn() && state.role === "admin";
    const draw = () => {
      const visibleMembers = state.members.filter(member => member.role !== "supplier_child");
      root.innerHTML = `
        <div class="settings-page">
          ${canReviewRequests() ? `<section class="card set-data member-requests">
            <div class="card-head"><span><b>${icon("users", 14)} 成员申请看板</b><em>${requestsLoaded ? `${memberRequests.length} 条待审批` : "正在读取申请"}</em></span>
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
            <div class="card-head"><span><b>成员账号</b><em>按身份着色；多人同屏管理，创作和数据权限仍按账号隔离</em></span>
              <button class="btn primary sm" id="memAdd">${icon("plus", 13)} 添加成员</button></div>
            <div class="settings-member-grid" id="memList">
              ${visibleMembers.map(m => `
                <article class="settings-member-card" data-mem="${m.id}">
                  <span class="settings-member-avatar ${m.role}">${icon(m.role === "admin" ? "shield" : "user", 14)}</span>
                  <span class="ovt-main"><b>${esc(m.name)} ${m.id === state.ui.currentMemberId ? `<i class="mem-me">当前</i>` : ""}</b><em>@${esc(m.username)} · ${ROLE_DESC[m.role] || ROLE_LABEL[m.role] || m.role}</em></span>
                  <span class="mem-role tag ${m.role}">${ROLE_LABEL[m.role] || m.role}</span>
                  <span class="settings-member-actions"><button class="icon-btn sm" data-medit="${m.id}" title="编辑">${icon("edit", 13)}</button><button class="icon-btn sm danger" data-mdel="${m.id}" title="删除" ${m.id === state.ui.currentMemberId ? "disabled" : ""}>${icon("trash", 13)}</button></span>
                </article>`).join("")}
            </div>
          </section>

          ${canSeeApiUsage() ? `<section class="card set-data api-usage-panel">
            <div class="card-head"><span><b>创作者接口用量</b><em>仅统计服务端上游真实返回的 LLM token；点账号可查看其 API 明细</em></span>
              <span class="api-usage-actions"><button class="btn ghost sm" id="apiUsageDetails">${icon("list", 13)} 查看 API 明细</button><button class="btn ghost sm" id="apiUsageRefresh">${icon("pulse", 13)} 刷新</button></span></div>
            <div class="api-usage-table">
              <div class="api-usage-row api-usage-label"><span>创作者</span><span>调用</span><span>输入</span><span>输出</span><span>合计</span><span>明细</span></div>
              ${!apiUsageLoaded ? `<div class="muted" style="padding:12px 2px">正在读取用量...</div>` : apiUsageRows.map(row => `<div class="api-usage-row"><span><b>${esc(row.memberName || "成员")}</b><em>@${esc(row.username || "")}</em></span><span>${Number(row.calls || 0).toLocaleString("zh-CN")}</span><span>${Number(row.promptTokens || 0).toLocaleString("zh-CN")}</span><span>${Number(row.completionTokens || 0).toLocaleString("zh-CN")}</span><strong>${Number(row.totalTokens || 0).toLocaleString("zh-CN")}</strong><button class="btn ghost sm api-member-detail" data-usage-member="${esc(row.memberId || "")}" title="查看 ${esc(row.memberName || "成员")} 的接口明细">${icon("eye", 13)} 查看</button></div>`).join("") || `<div class="muted" style="padding:12px 2px">暂未收到上游可统计的 token 用量；新调用会在成功后自动记录。</div>`}
            </div>
          </section>` : ""}

          <section class="card set-data product-library ${productLibraryOpen ? "is-open" : ""}">
            <div class="card-head"><span><b>产品库</b><em>${state.products.length} 个产品事实与视觉边界；默认收起，避免占用设置看板</em></span>
              <span class="product-library-actions"><button class="btn ghost sm" id="prodLibraryToggle">${icon(productLibraryOpen ? "chevronUp" : "chevronDown", 13)} ${productLibraryOpen ? "收起" : "展开"}</button><button class="btn primary sm" id="prodAdd">${icon("plus", 13)} 添加产品</button></span></div>
            ${productLibraryOpen ? `<div class="prod-list">
              ${state.products.map(p => `
                <div class="key-row product-row">
                  <span class="ovt-main"><b>${esc(p.name)}</b><em>${esc(p.category || "未分类")} · ${esc((p.brief || "").slice(0, 80))}${(p.brief || "").length > 80 ? "…" : ""}</em></span>
                  <button class="icon-btn sm" data-pedit="${p.id}" title="编辑">${icon("edit", 13)}</button>
                  <button class="icon-btn sm danger" data-pdel="${p.id}" title="删除" ${state.products.length <= 1 ? "disabled" : ""}>${icon("trash", 13)}</button>
                </div>`).join("")}
            </div>` : ""}
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

    async function loadApiUsage() {
      if (!canSeeApiUsage()) return;
      try {
        const result = await remote.admin.llmUsage();
        apiUsageRows = Array.isArray(result?.rows) ? result.rows : [];
      } catch (e) {
        toast("读取接口用量失败：" + (e.message || e));
      } finally {
        apiUsageLoaded = true;
        draw();
      }
    }

    const usageNumber = value => Number(value || 0).toLocaleString("zh-CN");
    const usageTime = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无";
    const apiUsageDetailsHtml = (details, member = null) => {
      const allEvents = Array.isArray(details?.events) ? details.events : [];
      const events = member ? allEvents.filter(row => row.memberId === member.memberId) : allEvents;
      const apiRows = member ? [...events.reduce((map, row) => {
        const key = `${row.feature || "通用调用"}::${row.model || "上游未回传模型"}`;
        const current = map.get(key) || { feature: row.feature, model: row.model, calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, lastUsedAt: 0 };
        current.calls += 1;
        current.promptTokens += Number(row.promptTokens || 0);
        current.completionTokens += Number(row.completionTokens || 0);
        current.totalTokens += Number(row.totalTokens || 0);
        current.lastUsedAt = Math.max(Number(current.lastUsedAt || 0), Number(row.createdAt || 0));
        map.set(key, current);
        return map;
      }, new Map()).values()].sort((a, b) => b.totalTokens - a.totalTokens) : (Array.isArray(details?.apiRows) ? details.apiRows : []);
      const apiTable = apiRows.length ? apiRows.map(row => `<div class="api-detail-row api-detail-api-row"><span><b>${esc(row.feature || "通用调用")}</b><em>${esc(row.model || "上游未回传模型")}</em></span><span>${usageNumber(row.calls)}</span><span>${usageNumber(row.promptTokens)}</span><span>${usageNumber(row.completionTokens)}</span><strong>${usageNumber(row.totalTokens)}</strong><time>${usageTime(row.lastUsedAt)}</time></div>`).join("") : `<p class="muted api-detail-empty">暂未收到上游可核验的 token 用量。</p>`;
      const eventTable = events.length ? events.map(row => `<div class="api-detail-row api-detail-event-row"><span><b>${esc(row.memberName || "成员")}</b><em>@${esc(row.username || "未知账号")}</em></span><span><b>${esc(row.feature || "通用调用")}</b><em>${esc(row.model || "上游未回传模型")}</em></span><span>${usageNumber(row.promptTokens)}</span><span>${usageNumber(row.completionTokens)}</span><strong>${usageNumber(row.totalTokens)}</strong><time>${usageTime(row.createdAt)}</time></div>`).join("") : `<p class="muted api-detail-empty">暂无调用记录。</p>`;
      return `<section class="api-detail-section"><div class="api-detail-title"><b>按 API / 模型汇总</b><em>每一项来自服务端收到的真实 usage 字段</em></div><div class="api-detail-table"><div class="api-detail-row api-detail-label"><span>调用类型 / 模型</span><span>调用</span><span>输入</span><span>输出</span><span>合计</span><span>最近调用</span></div>${apiTable}</div></section><section class="api-detail-section"><div class="api-detail-title"><b>最近调用记录</b><em>最多展示最近 120 笔；不含未返回 token 的请求</em></div><div class="api-detail-table api-detail-events"><div class="api-detail-row api-detail-label api-detail-event-row"><span>创作者</span><span>调用类型 / 模型</span><span>输入</span><span>输出</span><span>合计</span><span>时间</span></div>${eventTable}</div></section>`;
    };
    const openApiUsageDetails = (memberId = "") => {
      const member = apiUsageRows.find(row => row.memberId === memberId) || null;
      openModal(`<div class="mp-head"><div><b>${member ? `${esc(member.memberName || "成员")} · 接口 Token 用量` : "接口 Token 用量明细"}</b><em>仅展示上游已返回 usage 的语言模型调用</em></div><button class="icon-btn" data-close>${icon("x", 16)}</button></div><div class="api-usage-detail-body"><div class="muted" style="padding:12px 2px">正在读取 API 明细...</div></div>`, { wide: true, onMount(panel) {
        panel.classList.add("api-usage-modal");
        const body = $(".api-usage-detail-body", panel);
        remote.admin.llmUsageDetails().then(details => {
          if (body) body.innerHTML = apiUsageDetailsHtml(details, member);
        }).catch(error => {
          if (body) body.innerHTML = `<p class="muted api-detail-empty">读取明细失败：${esc(error?.message || String(error))}</p>`;
        });
      }});
    };

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
      $("#prodLibraryToggle", root)?.addEventListener("click", () => { productLibraryOpen = !productLibraryOpen; draw(); });
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
      $("#apiUsageRefresh", root)?.addEventListener("click", () => {
        apiUsageLoaded = false;
        draw();
        loadApiUsage();
      });
      $("#apiUsageDetails", root)?.addEventListener("click", openApiUsageDetails);
      $$('[data-usage-member]', root).forEach(button => button.addEventListener("click", () => openApiUsageDetails(button.dataset.usageMember || "")));
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
    loadApiUsage();
  }
};
