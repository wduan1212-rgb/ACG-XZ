/* 设置：成员、角色与产品资料。运行服务配置只保留在服务端。 */

import { $, $$, esc, fileToDataUrl, uid } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, saveMembers, ROLE_LABEL } from "../core/store.js";
import { toast, confirmModal, promptModal, openModal } from "../ui/components.js?v=20260727-v118-7";
import * as remote from "../core/remote.js";
import { renderSupplierSettings } from "./supplierViews.js?v=20260728-v120-shell-20";

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

function renderCreatorProfile(root) {
  const member = state.members.find(item => item.id === state.ui.currentMemberId) || {};
  let avatarUrl = member.avatarUrl || "";
  const initials = String(member.name || member.username || "我").trim().slice(0, 1) || "我";
  const avatarHtml = () => avatarUrl
    ? `<img src="${esc(avatarUrl)}" alt="当前头像"/>`
    : `<span>${esc(initials)}</span>`;
  root.innerHTML = `<div class="creator-profile-page">
    <section class="card creator-profile-card">
      <div class="creator-profile-heading">
        <label class="creator-avatar-drop" id="creatorProfileAvatarDrop" title="点击或拖入图片修改头像">
          <span class="creator-profile-avatar" id="creatorProfileAvatar">${avatarHtml()}</span>
          <span class="creator-avatar-edit">${icon("upload", 12)} 更换头像</span>
          <input id="creatorProfileAvatarFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif"/>
        </label>
        <b>我的资料</b><em>头像、昵称、账号和密码只会修改自己；管理员后台会同步显示。</em>
      </div>
      <form class="creator-profile-form" id="creatorProfileForm">
        <label class="creator-profile-line"><span>昵称</span><input class="input" id="creatorProfileName" value="${esc(member.name || "")}" maxlength="60" required /></label>
        <label class="creator-profile-line"><span>账号</span><input class="input" id="creatorProfileUsername" value="${esc(member.username || "")}" maxlength="60" required /></label>
        <label class="creator-profile-line"><span>新密码</span><input class="input" id="creatorProfilePin" type="password" autocomplete="new-password" placeholder="留空则不修改密码" maxlength="120" /></label>
        <div class="creator-profile-actions"><span>支持点击或拖入 PNG / JPG / WebP / GIF 图片（2MB 以内）。</span><button class="btn primary" id="creatorProfileSave" type="submit">${icon("check", 14)} 保存我的资料</button></div>
      </form>
    </section>
  </div>`;
  const avatar = $("#creatorProfileAvatar", root);
  const avatarDrop = $("#creatorProfileAvatarDrop", root);
  const updateAvatar = async file => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { toast("头像仅支持 PNG、JPG、WebP 或 GIF"); return; }
    if (file.size > 2 * 1024 * 1024) { toast("头像请控制在 2MB 以内"); return; }
    try {
      avatarUrl = remote.isOn()
        ? (await remote.memberProfile.uploadAvatar(file)).avatarUrl
        : await fileToDataUrl(file);
      if (avatar) avatar.innerHTML = avatarHtml();
    } catch (error) {
      toast("头像上传失败：" + (error?.message || error));
    }
  };
  $("#creatorProfileAvatarFile", root)?.addEventListener("change", event => updateAvatar(event.currentTarget.files?.[0]));
  avatarDrop?.addEventListener("dragover", event => { event.preventDefault(); avatarDrop.classList.add("is-dragging"); });
  avatarDrop?.addEventListener("dragleave", () => avatarDrop.classList.remove("is-dragging"));
  avatarDrop?.addEventListener("drop", event => {
    event.preventDefault();
    avatarDrop.classList.remove("is-dragging");
    updateAvatar(event.dataTransfer?.files?.[0]);
  });
  $("#creatorProfileForm", root)?.addEventListener("submit", async event => {
    event.preventDefault();
    const name = $("#creatorProfileName", root)?.value.trim() || "";
    const username = $("#creatorProfileUsername", root)?.value.trim() || "";
    const pin = $("#creatorProfilePin", root)?.value.trim() || "";
    if (!name || !username) { toast("请填写姓名和账号"); return; }
    const saveButton = $("#creatorProfileSave", root);
    if (saveButton) saveButton.disabled = true;
    try {
      const saved = remote.isOn()
        ? await remote.memberProfile.update({ name, username, pin, avatarUrl })
        : { ...member, name, username, avatarUrl };
      state.members = state.members.map(item => item.id === saved.id ? saved : item);
      saveMembers();
      $("#creatorProfilePin", root).value = "";
      toast("我的资料已保存，管理员后台已同步");
    } catch (error) {
      toast("保存失败：" + (error?.message || error));
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  });
}

export const settingsView = {
  render(root, { page } = {}) {
    if (page === "profile" || state.role === "editor") {
      root.dataset.settingsView = "profile";
      renderCreatorProfile(root);
      return;
    }
    if (["supplier", "supplier_parent"].includes(state.role)) {
      const supplierPage = page === "accounts" ? "accounts" : "requests";
      root.dataset.settingsView = `supplier-${supplierPage}`;
      renderSupplierSettings(root, { page: supplierPage });
      return;
    }
    const managementPages = new Set(["members", "products", "usage", "requests"]);
    const managementPage = managementPages.has(page) ? page : "members";
    root.dataset.settingsView = managementPage;
    let memberRequests = [];
    let requestsLoaded = false;
    let apiUsageRows = [];
    let apiUsageLoaded = false;
    let apiUsageLoading = false;
    let productLibraryOpen = managementPage === "products";
    const canReviewRequests = () => remote.isOn() && state.role === "admin";
    const canSeeApiUsage = () => remote.isOn() && state.role === "admin";
    const usageNumber = value => Number(value || 0).toLocaleString("zh-CN");
    const apiUsageSummaryHtml = () => {
      if (!apiUsageLoaded) return `<div class="muted api-usage-empty">正在读取用量...</div>`;
      if (!apiUsageRows.length) return `<div class="muted api-usage-empty">暂未收到已记录的模型调用。历史图片、视频调用若当时没有服务端账本，无法可靠追溯或估算。</div>`;
      const activeRows = apiUsageRows
        .filter(row => Number(row.totalTokens || 0) || Number(row.imageCalls || 0) || Number(row.videoCalls || 0))
        .sort((a, b) => (Number(b.totalTokens || 0) + Number(b.imageCalls || 0) + Number(b.videoCalls || 0)) - (Number(a.totalTokens || 0) + Number(a.imageCalls || 0) + Number(a.videoCalls || 0)));
      const quietRows = apiUsageRows.filter(row => !activeRows.includes(row));
      const totals = apiUsageRows.reduce((sum, row) => ({
        tokens: sum.tokens + Number(row.totalTokens || 0),
        imageOutputs: sum.imageOutputs + Number(row.imageOutputs || 0),
        videoOutputs: sum.videoOutputs + Number(row.videoOutputs || 0),
      }), { tokens: 0, imageOutputs: 0, videoOutputs: 0 });
      const memberRow = row => `<article class="api-usage-summary-row">
        <span class="api-usage-member"><b>${esc(row.memberName || "成员")}</b><em>@${esc(row.username || "")}</em></span>
        <span class="api-usage-row-stat"><b>${usageNumber(row.totalTokens)}</b><em>语言 Token · ${usageNumber(row.calls)} 次</em></span>
        <span class="api-usage-row-stat"><b>${usageNumber(row.imageOutputs)}</b><em>图片输出 · ${usageNumber(row.imageCalls)} 次</em></span>
        <span class="api-usage-row-stat"><b>${usageNumber(row.videoOutputs)}</b><em>视频任务 · ${usageNumber(row.videoCalls)} 次</em></span>
        <button class="icon-btn sm api-member-detail" data-usage-member="${esc(row.memberId || "")}" title="查看 ${esc(row.memberName || "成员")} 的接口明细">${icon("eye", 13)}</button>
      </article>`;
      return `<div class="api-usage-overview">
        <div class="api-usage-kpis">
          <span class="api-usage-kpi"><b>${usageNumber(totals.tokens)}</b><em>语言 Token</em></span>
          <span class="api-usage-kpi"><b>${usageNumber(totals.imageOutputs)}</b><em>图片输出</em></span>
          <span class="api-usage-kpi"><b>${usageNumber(totals.videoOutputs)}</b><em>视频任务</em></span>
          <span class="api-usage-kpi"><b>${usageNumber(activeRows.length)}</b><em>有用量成员</em></span>
        </div>
        <div class="api-usage-summary-list">
          <div class="api-usage-summary-label"><span>创作者</span><span>语言模型</span><span>图片模型</span><span>视频模型</span><span>明细</span></div>
          ${activeRows.length ? activeRows.map(memberRow).join("") : `<div class="muted api-usage-empty">暂未产生用量；成员明细仍可从“查看 API 明细”中查看。</div>`}
        </div>
        ${quietRows.length ? `<details class="api-usage-zero-members"><summary>未产生用量的成员（${quietRows.length}）</summary><div class="api-usage-summary-list is-quiet">${quietRows.map(memberRow).join("")}</div></details>` : ""}
      </div>`;
    };
    const draw = () => {
      const visibleMembers = state.members.filter(member => member.role !== "supplier_child");
      root.innerHTML = `
        <div class="settings-page" data-settings-page="${managementPage}">
          ${managementPage === "requests" ? `<section class="card set-data member-requests">
            <div class="card-head"><span><b>${icon("users", 14)} 成员申请看板</b><em>${requestsLoaded ? `${memberRequests.length} 条待审批` : "正在读取申请"}</em></span>
              ${canReviewRequests() ? `<button class="btn ghost sm" id="reqRefresh">${icon("pulse", 13)} 刷新</button>` : ""}</div>
            <div class="mem-list">
              ${!canReviewRequests() ? `<div class="muted" style="padding:8px 2px">成员申请仅在管理员连接主服务后可用。</div>` : !requestsLoaded ? `<div class="muted" style="padding:8px 2px">正在读取申请...</div>` : memberRequests.length ? memberRequests.map(r => `
                <div class="mem-row">
                  <span class="ovt-main"><b>${esc(r.name)}</b><em>@${esc(r.username)} · 申请角色：${ROLE_LABEL[r.role] || r.role} · ${r.createdAt ? new Date(r.createdAt).toLocaleString() : ""}</em></span>
                  <button class="btn primary sm" data-rapprove="${r.id}">${icon("check", 13)} 通过</button>
                  <button class="btn ghost sm danger" data-rreject="${r.id}">${icon("x", 13)} 拒绝</button>
                </div>`).join("") : `<div class="muted" style="padding:8px 2px">暂无待审批申请。</div>`}
            </div>
          </section>` : ""}

          ${managementPage === "members" ? `<section class="card set-data member-accounts">
            <div class="card-head"><span><b>成员账号</b><em>按身份着色；多人同屏管理，创作和数据权限仍按账号隔离</em></span>
              <button class="btn primary sm" id="memAdd">${icon("plus", 13)} 添加成员</button></div>
            <div class="settings-member-grid" id="memList">
              ${visibleMembers.map(m => `
                <article class="settings-member-card" data-mem="${m.id}">
                  <span class="settings-member-avatar ${m.role}">${m.avatarUrl ? `<img src="${esc(m.avatarUrl)}" alt="${esc(m.name)} 的头像"/>` : icon(m.role === "admin" ? "shield" : "user", 14)}</span>
                  <span class="ovt-main"><b>${esc(m.name)} ${m.id === state.ui.currentMemberId ? `<i class="mem-me">当前</i>` : ""}</b><em>@${esc(m.username)} · ${ROLE_DESC[m.role] || ROLE_LABEL[m.role] || m.role}</em></span>
                  <span class="mem-role tag ${m.role}">${ROLE_LABEL[m.role] || m.role}</span>
                  <span class="settings-member-actions"><button class="icon-btn sm" data-medit="${m.id}" title="编辑">${icon("edit", 13)}</button><button class="icon-btn sm danger" data-mdel="${m.id}" title="删除" ${m.id === state.ui.currentMemberId ? "disabled" : ""}>${icon("trash", 13)}</button></span>
                </article>`).join("")}
            </div>
          </section>` : ""}

          ${managementPage === "usage" ? `<section class="card set-data api-usage-panel" id="apiUsagePanel">
            <div class="card-head"><span><b>创作者模型用量</b><em>语言显示真实 Token；图片/视频显示成功调用与输出单位，不估算历史消耗</em></span>
              ${canSeeApiUsage() ? `<span class="api-usage-actions"><button class="btn ghost sm" id="apiUsageDetails">${icon("list", 13)} 查看 API 明细</button><button class="btn ghost sm" id="apiUsageRefresh" ${apiUsageLoading ? "disabled" : ""}>${icon("pulse", 13)} ${apiUsageLoading ? "刷新中…" : "刷新"}</button></span>` : ""}</div>
            <div class="api-usage-table">${canSeeApiUsage() ? apiUsageSummaryHtml() : `<div class="muted api-usage-empty">模型用量仅在管理员连接主服务后可用。</div>`}</div>
          </section>` : ""}

          ${managementPage === "products" ? `<section class="card set-data product-library ${productLibraryOpen ? "is-open" : ""}">
            <div class="card-head"><span><b>产品库</b><em>${state.products.length} 个产品事实与视觉边界；默认收起，避免占用设置看板</em></span>
              <span class="product-library-actions"><button class="btn ghost sm" id="prodLibraryToggle">${icon(productLibraryOpen ? "chevronUp" : "chevronDown", 13)} ${productLibraryOpen ? "收起" : "展开"}</button><button class="btn primary sm" id="prodAdd">${icon("plus", 13)} 添加产品</button></span></div>
            <div class="prod-list product-library-grid" ${productLibraryOpen ? "" : "hidden"}>
              ${state.products.map(p => `
                <article class="product-row product-library-card">
                  <span class="ovt-main"><b>${esc(p.name)}</b><em>${esc(p.category || "未分类")} · ${esc((p.brief || "").slice(0, 80))}${(p.brief || "").length > 80 ? "…" : ""}</em></span>
                  <span class="product-library-card-actions"><button class="icon-btn sm" data-pedit="${p.id}" title="编辑">${icon("edit", 13)}</button><button class="icon-btn sm danger" data-pdel="${p.id}" title="删除" ${state.products.length <= 1 ? "disabled" : ""}>${icon("trash", 13)}</button></span>
                </article>`).join("")}
            </div>
          </section>` : ""}

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

    function refreshApiUsagePanel() {
      const panel = $("#apiUsagePanel", root);
      if (!panel) return;
      const table = $(".api-usage-table", panel);
      if (table) table.innerHTML = apiUsageSummaryHtml();
      const refresh = $("#apiUsageRefresh", panel);
      if (refresh) {
        refresh.disabled = apiUsageLoading;
        refresh.innerHTML = `${icon("pulse", 13)} ${apiUsageLoading ? "刷新中…" : "刷新"}`;
      }
      wireApiUsageMemberButtons(panel);
    }

    async function loadApiUsage({ inPlace = false } = {}) {
      if (!canSeeApiUsage()) return;
      if (inPlace) {
        apiUsageLoading = true;
        refreshApiUsagePanel();
      }
      try {
        const result = await remote.admin.llmUsage();
        apiUsageRows = Array.isArray(result?.rows) ? result.rows : [];
      } catch (e) {
        toast("读取接口用量失败：" + (e.message || e));
      } finally {
        apiUsageLoaded = true;
        apiUsageLoading = false;
        if (inPlace) refreshApiUsagePanel();
        else draw();
      }
    }

    const usageTime = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无";
    const apiUsageDetailsHtml = (details, member = null) => {
      const events = Array.isArray(details?.events) ? details.events : [];
      const apiRows = Array.isArray(details?.apiRows) ? details.apiRows : [];
      const assetRows = Array.isArray(details?.assetApiRows) ? details.assetApiRows : [];
      const assetEvents = Array.isArray(details?.assetEvents) ? details.assetEvents : [];
      const apiTable = apiRows.length ? apiRows.map(row => `<div class="api-detail-row api-detail-api-row"><span><b>${esc(row.feature || "通用调用")}</b><em>${esc(row.model || "上游未回传模型")}</em></span><span>${usageNumber(row.calls)}</span><span>${usageNumber(row.promptTokens)}</span><span>${usageNumber(row.completionTokens)}</span><strong>${usageNumber(row.totalTokens)}</strong><time>${usageTime(row.lastUsedAt)}</time></div>`).join("") : `<p class="muted api-detail-empty">暂未收到上游可核验的 token 用量。</p>`;
      const eventTable = events.length ? events.map(row => `<div class="api-detail-row api-detail-event-row"><span><b>${esc(row.memberName || "成员")}</b><em>@${esc(row.username || "未知账号")}</em></span><span><b>${esc(row.feature || "通用调用")}</b><em>${esc(row.model || "上游未回传模型")}</em></span><span>${usageNumber(row.promptTokens)}</span><span>${usageNumber(row.completionTokens)}</span><strong>${usageNumber(row.totalTokens)}</strong><time>${usageTime(row.createdAt)}</time></div>`).join("") : `<p class="muted api-detail-empty">暂无调用记录。</p>`;
      const assetTable = assetRows.length ? assetRows.map(row => `<div class="api-asset-row"><span><b>${esc(row.feature || "模型调用")}</b><em>${esc(row.model || "上游未回传模型")}</em></span><span>${usageNumber(row.calls)} 次</span><strong>${usageNumber(row.outputUnits)} ${esc(row.unitLabel || "任务")}</strong><time>${usageTime(row.lastUsedAt)}</time></div>`).join("") : `<p class="muted api-detail-empty">暂无已记录的图片或视频成功调用；旧调用不会以猜测值补写。</p>`;
      const assetEventTable = assetEvents.length ? assetEvents.map(row => `<div class="api-asset-row api-asset-event-row"><span><b>${esc(row.memberName || "成员")}</b><em>@${esc(row.username || "未知账号")} · ${esc(row.feature || "模型调用")} · ${esc(row.model || "上游未回传模型")}</em></span><span>${usageNumber(row.calls)} 次</span><strong>${usageNumber(row.outputUnits)} ${esc(row.unitLabel || "任务")}</strong><time>${usageTime(row.createdAt)}</time></div>`).join("") : `<p class="muted api-detail-empty">暂无调用记录。</p>`;
      return `<section class="api-detail-section"><div class="api-detail-title"><b>语言模型 Token（按 API / 模型）</b><em>仅来自上游返回的真实 usage 字段</em></div><div class="api-detail-table"><div class="api-detail-row api-detail-label"><span>调用类型 / 模型</span><span>调用</span><span>输入</span><span>输出</span><span>合计</span><span>最近调用</span></div>${apiTable}</div></section><section class="api-detail-section"><div class="api-detail-title"><b>图片与视频模型（成功调用）</b><em>显示实际调用次数与输出单位；不是 Token，也不估算成本</em></div><div class="api-asset-table"><div class="api-asset-row api-detail-label"><span>调用类型 / 模型</span><span>调用</span><strong>输出</strong><time>最近调用</time></div>${assetTable}</div></section><section class="api-detail-section"><div class="api-detail-title"><b>最近语言调用记录</b><em>最多展示最近 120 笔；不含未返回 token 的请求</em></div><div class="api-detail-table api-detail-events"><div class="api-detail-row api-detail-label api-detail-event-row"><span>创作者</span><span>调用类型 / 模型</span><span>输入</span><span>输出</span><span>合计</span><span>时间</span></div>${eventTable}</div></section><section class="api-detail-section"><div class="api-detail-title"><b>最近图片 / 视频调用</b><em>只在服务端确认成功返回图片或创建视频任务后写入</em></div><div class="api-asset-table">${assetEventTable}</div></section>`;
    };
    const openApiUsageDetails = (memberId = "") => {
      const member = apiUsageRows.find(row => row.memberId === memberId) || null;
      openModal(`<div class="mp-head"><div><b>${member ? `${esc(member.memberName || "成员")} · 模型调用明细` : "模型调用明细"}</b><em>语言 Token 与图片 / 视频成功调用分开统计</em></div><button class="icon-btn" data-close>${icon("x", 16)}</button></div><div class="api-usage-detail-body"><div class="muted" style="padding:12px 2px">正在读取 API 明细...</div></div>`, { wide: true, onMount(panel) {
        panel.classList.add("api-usage-modal");
        const body = $(".api-usage-detail-body", panel);
        remote.admin.llmUsageDetails(memberId).then(details => {
          if (body) body.innerHTML = apiUsageDetailsHtml(details, member);
        }).catch(error => {
          if (body) body.innerHTML = `<p class="muted api-detail-empty">读取明细失败：${esc(error?.message || String(error))}</p>`;
        });
      }});
    };
    const wireApiUsageMemberButtons = scope => $$('[data-usage-member]', scope).forEach(button => button.addEventListener("click", () => openApiUsageDetails(button.dataset.usageMember || "")));

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
      $("#prodLibraryToggle", root)?.addEventListener("click", event => {
        productLibraryOpen = !productLibraryOpen;
        const section = event.currentTarget.closest(".product-library");
        const list = $(".product-library-grid", section);
        section?.classList.toggle("is-open", productLibraryOpen);
        if (list) list.hidden = !productLibraryOpen;
        event.currentTarget.innerHTML = `${icon(productLibraryOpen ? "chevronUp" : "chevronDown", 13)} ${productLibraryOpen ? "收起" : "展开"}`;
        event.currentTarget.setAttribute("aria-expanded", String(productLibraryOpen));
      });
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
      $("#apiUsageRefresh", root)?.addEventListener("click", () => loadApiUsage({ inPlace: true }));
      $("#apiUsageDetails", root)?.addEventListener("click", openApiUsageDetails);
      wireApiUsageMemberButtons(root);
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
    if (managementPage === "requests") loadRequests();
    if (managementPage === "usage") loadApiUsage();
  }
};
