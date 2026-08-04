/* 设置：成员、角色与产品资料。运行服务配置只保留在服务端。 */

import { $, $$, esc, fileToDataUrl, uid } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, saveMembers, currentMember, currentTeam, ROLE_LABEL } from "../core/store.js";
import { toast, confirmModal, promptModal, openModal } from "../ui/components.js?v=20260804-v140-supplier-metric-sync-1";
import * as remote from "../core/remote.js";
import { renderSupplierSettings } from "./supplierViews.js?v=20260804-v140-supplier-metric-sync-1";

const ROLE_DESC = { admin: "团队管理员", editor: "创作成员", user: "个人用户", supplier_parent: "供应商管理员", supplier_child: "供应商子账号" };
const ROLE_OPTS = ["admin", "editor"];

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

function renderTeamJoin(root) {
  const member = currentMember() || {};
  const team = currentTeam();
  let teams = [];
  let loading = false;
  let submitted = false;
  const draw = () => {
    root.innerHTML = `<div class="team-join-page">
      <section class="card team-join-card">
        <span class="team-join-icon">${icon(team ? "users" : "plus", 22)}</span>
        <div class="team-join-heading">
          <b>${team ? esc(team.name) : "加入团队"}</b>
          <em>${team ? `当前身份：${team.role === "owner" ? "团队所有者" : team.role === "admin" ? "团队管理员" : "创作成员"}` : "输入准确的团队名称，申请会发送给该团队的所有者和管理员。"}</em>
        </div>
        ${team ? `
          <div class="team-join-status">
            <span><b>团队套餐</b><em>${team.quotaMode === "unlimited" ? "无限额度" : "共享额度"}</em></span>
            <span><b>已解锁</b><em>全部团队功能</em></span>
          </div>
          ${team.role === "owner" && team.kind !== "internal" ? `
            <form class="team-rename-form" id="teamRenameForm">
              <label class="field">团队名称
                <input class="input" id="teamRenameName" value="${esc(team.name || "")}" maxlength="80" required />
              </label>
              <button class="btn primary" id="teamRenameSubmit" type="submit">${icon("check", 14)} 保存团队名称</button>
            </form>
          ` : `<p class="team-name-managed">${team.kind === "internal" ? "ACG 市场部名称由平台统一维护。" : "只有团队所有者可以修改团队名称。"}</p>`}
          <button class="btn ghost" type="button" data-team-profile>${icon("user", 14)} 返回个人资料</button>
        ` : `
          <form class="team-join-form" id="teamJoinForm">
            <label class="field">团队名称
              <input class="input" id="teamJoinName" autocomplete="organization" list="joinableTeams" placeholder="例如：ACG市场部" required />
              <datalist id="joinableTeams">${teams.map(item => `<option value="${esc(item.name)}"></option>`).join("")}</datalist>
            </label>
            <label class="field">申请说明（可选）
              <textarea class="input" id="teamJoinMessage" rows="3" maxlength="240" placeholder="简单说明你的身份，方便管理员确认"></textarea>
            </label>
            <div class="team-join-actions">
              <span>${loading ? "正在读取可加入团队…" : submitted ? "申请已提交，请等待团队管理员审批。" : "团队之间的数据、供应商和账号彼此隔离。"}</span>
              <button class="btn primary" id="teamJoinSubmit" type="submit" ${loading || submitted ? "disabled" : ""}>${icon("send", 14)} ${submitted ? "已提交" : "提交申请"}</button>
            </div>
          </form>
        `}
      </section>
    </div>`;
    root.querySelector("[data-team-profile]")?.addEventListener("click", () => { location.hash = "#/settings/profile"; });
    $("#teamRenameForm", root)?.addEventListener("submit", async event => {
      event.preventDefault();
      const name = $("#teamRenameName", root)?.value.trim() || "";
      if (!name) { toast("请输入团队名称"); return; }
      const button = $("#teamRenameSubmit", root);
      if (button) button.disabled = true;
      try {
        const result = await remote.teams.rename(name);
        const savedMember = result?.member;
        if (savedMember?.id) {
          state.members = state.members.map(item => item.id === savedMember.id ? savedMember : item);
          saveMembers();
        }
        toast("团队名称已更新");
        renderTeamJoin(root);
      } catch (error) {
        if (button) button.disabled = false;
        toast("保存失败：" + (error?.message || error));
      }
    });
    $("#teamJoinForm", root)?.addEventListener("submit", async event => {
      event.preventDefault();
      const name = $("#teamJoinName", root)?.value.trim() || "";
      const message = $("#teamJoinMessage", root)?.value.trim() || "";
      if (!name) { toast("请输入团队名称"); return; }
      const button = $("#teamJoinSubmit", root);
      if (button) button.disabled = true;
      try {
        await remote.teams.requestJoin(name, message);
        submitted = true;
        draw();
        toast(`已向「${name}」提交加入申请`);
      } catch (error) {
        if (button) button.disabled = false;
        toast("提交失败：" + (error?.message || error));
      }
    });
  };
  draw();
  if (!team && remote.isOn()) {
    loading = true;
    draw();
    remote.teams.list().then(result => {
      teams = Array.isArray(result) ? result : (result?.items || []);
    }).catch(error => {
      toast("读取团队列表失败：" + (error?.message || error));
    }).finally(() => {
      loading = false;
      draw();
    });
  }
}

export const settingsView = {
  render(root, { page } = {}) {
    const member = currentMember() || {};
    const team = currentTeam();
    const canManageTeam = ["owner", "admin"].includes(member.teamRole || "");
    if (page === "team") {
      root.dataset.settingsView = "team";
      renderTeamJoin(root);
      return;
    }
    if (page === "profile" || (!canManageTeam && ["editor", "user"].includes(state.role))) {
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
    let teamJoinRequests = [];
    let teamSupplierAccounts = [];
    let teamSuppliersLoaded = false;
    let platformAccounts = { personal: [], teamOwners: [], creators: [] };
    let platformAccountsLoaded = false;
    let requestsLoaded = false;
    let apiUsageRows = [];
    let apiUsageLoaded = false;
    let apiUsageLoading = false;
    let productLibraryOpen = managementPage === "products";
    const canReviewRegistrations = () => remote.isOn() && team?.kind === "internal" && canManageTeam;
    const canReviewPlatformAccounts = () => remote.isOn() && team?.kind === "internal" && canManageTeam;
    const canReviewTeamRequests = () => remote.isOn() && canManageTeam;
    const canReviewRequests = () => canReviewRegistrations() || canReviewTeamRequests();
    const canSeeApiUsage = () => remote.isOn() && state.role === "admin";
    const usageNumber = value => Number(value || 0).toLocaleString("zh-CN");
    const apiUsageSummaryHtml = () => {
      if (!apiUsageLoaded) return `<div class="muted api-usage-empty">正在读取用量...</div>`;
      if (!apiUsageRows.length) return `<div class="muted api-usage-empty">暂未收到已记录的模型调用。历史图片、视频调用若当时没有服务端账本，无法可靠追溯或估算。</div>`;
      const activeRows = apiUsageRows
        .filter(row => Number(row.calls || 0) || Number(row.imageCalls || 0) || Number(row.videoCalls || 0) || Number(row.voiceCalls || 0))
        .sort((a, b) => (Number(b.totalTokens || 0) + Number(b.calls || 0) + Number(b.imageCalls || 0) + Number(b.videoCalls || 0) + Number(b.voiceCalls || 0)) - (Number(a.totalTokens || 0) + Number(a.calls || 0) + Number(a.imageCalls || 0) + Number(a.videoCalls || 0) + Number(a.voiceCalls || 0)));
      const quietRows = apiUsageRows.filter(row => !activeRows.includes(row));
      const totals = apiUsageRows.reduce((sum, row) => ({
        tokens: sum.tokens + Number(row.totalTokens || 0),
        tokenUnknownCalls: sum.tokenUnknownCalls + Number(row.tokenUnknownCalls || 0),
        imageOutputs: sum.imageOutputs + Number(row.imageOutputs || 0),
        videoOutputs: sum.videoOutputs + Number(row.videoOutputs || 0),
        voiceOutputs: sum.voiceOutputs + Number(row.voiceOutputs || 0),
      }), { tokens: 0, tokenUnknownCalls: 0, imageOutputs: 0, videoOutputs: 0, voiceOutputs: 0 });
      const memberRow = row => `<article class="api-usage-summary-row">
        <span class="api-usage-member"><b>${esc(row.memberName || "成员")}</b><em>@${esc(row.username || "")}</em></span>
        <span class="api-usage-row-stat"><b>${usageNumber(row.totalTokens)}</b><em>语言 Token · ${usageNumber(row.calls)} 次${Number(row.tokenUnknownCalls || 0) ? ` · ${usageNumber(row.tokenUnknownCalls)} 次 Token 未知` : ""}</em></span>
        <span class="api-usage-row-stat"><b>${usageNumber(row.imageOutputs)}</b><em>图片输出 · ${usageNumber(row.imageCalls)} 次</em></span>
        <span class="api-usage-row-stat"><b>${usageNumber(row.videoOutputs)}</b><em>视频任务 · ${usageNumber(row.videoCalls)} 次</em></span>
        <span class="api-usage-row-stat"><b>${usageNumber(row.voiceOutputs)}</b><em>语音输出 · ${usageNumber(row.voiceCalls)} 次</em></span>
        <button class="icon-btn sm api-member-detail" data-usage-member="${esc(row.memberId || "")}" title="查看 ${esc(row.memberName || "成员")} 的接口明细">${icon("eye", 13)}</button>
      </article>`;
      return `<div class="api-usage-overview">
        <div class="api-usage-kpis">
          <span class="api-usage-kpi"><b>${usageNumber(totals.tokens)}</b><em>语言 Token${totals.tokenUnknownCalls ? ` · ${usageNumber(totals.tokenUnknownCalls)} 次未知` : ""}</em></span>
          <span class="api-usage-kpi"><b>${usageNumber(totals.imageOutputs)}</b><em>图片输出</em></span>
          <span class="api-usage-kpi"><b>${usageNumber(totals.videoOutputs)}</b><em>视频任务</em></span>
          <span class="api-usage-kpi"><b>${usageNumber(totals.voiceOutputs)}</b><em>语音输出</em></span>
          <span class="api-usage-kpi"><b>${usageNumber(activeRows.length)}</b><em>有用量成员</em></span>
        </div>
        <div class="api-usage-summary-list">
          <div class="api-usage-summary-label"><span>创作者</span><span>语言模型</span><span>图片模型</span><span>视频模型</span><span>语音模型</span><span>明细</span></div>
          ${activeRows.length ? activeRows.map(memberRow).join("") : `<div class="muted api-usage-empty">暂未产生用量；成员明细仍可从“查看 API 明细”中查看。</div>`}
        </div>
        ${quietRows.length ? `<details class="api-usage-zero-members"><summary>未产生用量的成员（${quietRows.length}）</summary><div class="api-usage-summary-list is-quiet">${quietRows.map(memberRow).join("")}</div></details>` : ""}
      </div>`;
    };
    const draw = () => {
      const visibleMembers = state.members.filter(item => item.role !== "supplier_child");
      const requestCount = memberRequests.length + teamJoinRequests.length;
      root.innerHTML = `
        <div class="settings-page" data-settings-page="${managementPage}">
          ${managementPage === "requests" ? `<section class="card set-data member-requests">
            <div class="card-head"><span><b>${icon("users", 14)} 团队申请看板</b><em>${requestsLoaded ? `${requestCount} 条待审批` : "正在读取申请"}</em></span>
              ${canReviewRequests() ? `<button class="btn ghost sm" id="reqRefresh">${icon("pulse", 13)} 刷新</button>` : ""}</div>
            ${canReviewTeamRequests() ? `<div class="settings-request-section">
              <div class="settings-request-title"><b>加入 ${esc(team?.name || "团队")}</b><span>${teamJoinRequests.length} 条</span></div>
              <div class="mem-list">
                ${!requestsLoaded ? `<div class="muted" style="padding:8px 2px">正在读取申请...</div>` : teamJoinRequests.length ? teamJoinRequests.map(r => `
                  <div class="mem-row">
                    <span class="ovt-main"><b>${esc(r.memberName || "用户")}</b><em>@${esc(r.username || "")} · ${esc(r.message || "未填写说明")} · ${r.createdAt ? new Date(r.createdAt).toLocaleString() : ""}</em></span>
                    <button class="btn primary sm" data-team-approve="${r.id}">${icon("check", 13)} 加入团队</button>
                    <button class="btn ghost sm danger" data-team-reject="${r.id}">${icon("x", 13)} 拒绝</button>
                  </div>`).join("") : `<div class="muted" style="padding:8px 2px">暂无待处理的团队加入申请。</div>`}
              </div>
            </div>` : ""}
            ${canReviewRegistrations() ? `<div class="settings-request-section">
              <div class="settings-request-title"><b>平台注册账号</b><span>${memberRequests.length} 条</span></div>
              <div class="mem-list">
                ${!requestsLoaded ? `<div class="muted" style="padding:8px 2px">正在读取申请...</div>` : memberRequests.length ? memberRequests.map(r => `
                <div class="mem-row">
                  <span class="ovt-main"><b>${esc(r.name)}</b><em>@${esc(r.username)} · 注册为普通个人用户 · ${r.createdAt ? new Date(r.createdAt).toLocaleString() : ""}</em></span>
                  <button class="btn primary sm" data-rapprove="${r.id}">${icon("check", 13)} 通过</button>
                  <button class="btn ghost sm danger" data-rreject="${r.id}">${icon("x", 13)} 拒绝</button>
                </div>`).join("") : `<div class="muted" style="padding:8px 2px">暂无待审批的注册账号。</div>`}
              </div>
            </div>` : ""}
            ${!canReviewRequests() ? `<div class="muted" style="padding:8px 2px">当前账号没有团队审批权限。</div>` : ""}
          </section>` : ""}

          ${managementPage === "members" ? `<section class="card set-data member-accounts">
            <div class="card-head"><span><b>成员账号</b><em>按身份着色；多人同屏管理，创作和数据权限仍按账号隔离</em></span>
              <button class="btn primary sm" id="memAdd">${icon("plus", 13)} 添加成员</button></div>
            <div class="settings-member-grid" id="memList">
              ${visibleMembers.map(m => `
                <article class="settings-member-card" data-mem="${m.id}">
                  <span class="settings-member-avatar ${m.teamRole || m.role}">${m.avatarUrl ? `<img src="${esc(m.avatarUrl)}" alt="${esc(m.name)} 的头像"/>` : icon(["owner", "admin"].includes(m.teamRole) ? "shield" : "user", 14)}</span>
                  <span class="ovt-main"><b>${esc(m.name)} ${m.id === state.ui.currentMemberId ? `<i class="mem-me">当前</i>` : ""}</b><em>@${esc(m.username)} · ${ROLE_DESC[m.role] || ROLE_LABEL[m.role] || m.role}</em></span>
                  <span class="mem-role tag ${m.teamRole || m.role}">${m.teamRole === "owner" ? "团队所有者" : m.teamRole === "admin" ? "团队管理员" : "创作成员"}</span>
                  <span class="settings-member-actions"><button class="icon-btn sm" data-medit="${m.id}" title="编辑">${icon("edit", 13)}</button><button class="icon-btn sm danger" data-mdel="${m.id}" title="踢出团队" ${m.id === state.ui.currentMemberId || m.teamRole === "owner" ? "disabled" : ""}>${icon("logOut", 13)}</button></span>
                </article>`).join("")}
            </div>
          </section>
          <section class="card set-data team-supplier-accounts">
            <div class="card-head"><span><b>团队供应商入口</b><em>供应商管理员可登录供应商端并建立自己的子账号；密码不会以明文保存或回显</em></span></div>
            <div class="mem-list">
              ${!teamSuppliersLoaded ? `<div class="muted" style="padding:8px 2px">正在读取团队供应商账号...</div>` : teamSupplierAccounts.length ? teamSupplierAccounts.map(account => `
                <div class="mem-row team-supplier-row">
                  <span class="ovt-main"><b>${esc(account.name || "供应商管理员")}</b><em>登录用户名：@${esc(account.username || "")}</em></span>
                  <button class="btn ghost sm" type="button" data-team-supplier-password="${esc(account.id)}">${icon("keyRound", 13)} 设置新密码</button>
                </div>`).join("") : `<div class="muted" style="padding:8px 2px">当前团队尚未绑定供应商管理员。</div>`}
            </div>
          </section>
          ${canReviewPlatformAccounts() ? `<section class="card set-data platform-account-overview">
            <div class="card-head"><span><b>平台账号概览</b><em>仅显示安全身份与套餐摘要，不回显密码、凭证或业务数据</em></span></div>
            ${!platformAccountsLoaded ? `<div class="muted" style="padding:8px 2px">正在读取平台账号...</div>` : `
              <div class="settings-request-section">
                <div class="settings-request-title"><b>无主个人账号</b><span>${platformAccounts.personal.length} 个</span></div>
                <div class="mem-list">${platformAccounts.personal.length ? platformAccounts.personal.map(account => `
                  <div class="mem-row"><span class="ovt-main"><b>${esc(account.name || "个人用户")}</b><em>@${esc(account.username || "")} · 每日 70 点，当日清零</em></span><span class="tag user">个人用户</span></div>`).join("") : `<div class="muted" style="padding:8px 2px">暂无独立个人账号。</div>`}</div>
              </div>
              <div class="settings-request-section">
                <div class="settings-request-title"><b>团队版账号</b><span>${platformAccounts.teamOwners.length} 个</span></div>
                <div class="mem-list">${platformAccounts.teamOwners.length ? platformAccounts.teamOwners.map(account => `
                  <div class="mem-row"><span class="ovt-main"><b>${esc(account.teamName || "团队")}</b><em>所有者 ${esc(account.name || "用户")} · @${esc(account.username || "")}</em></span><span class="tag admin">${account.plan === "team-pro" ? "团队专业版" : "团队版"}</span></div>`).join("") : `<div class="muted" style="padding:8px 2px">暂无已开通的外部团队。</div>`}</div>
              </div>
              <div class="settings-request-section">
                <div class="settings-request-title"><b>全部创作端账号</b><span>${platformAccounts.creators.length} 个</span></div>
                <div class="mem-list">${platformAccounts.creators.length ? platformAccounts.creators.map(account => {
                  const disabled = account.accountStatus === "disabled";
                  const protectedAccount = account.id === state.ui.currentMemberId || (account.teamId === "team-acg-marketing" && account.teamRole === "owner");
                  return `<div class="mem-row"><span class="ovt-main"><b>${esc(account.name || "创作用户")}</b><em>@${esc(account.username || "")} · ${esc(account.teamName || "Free")} · ${disabled ? "已停用" : "使用中"}</em></span><span class="tag ${disabled ? "danger" : "user"}">${disabled ? "已停用" : "正常"}</span><button class="btn ghost sm ${disabled ? "" : "danger"}" type="button" data-platform-status="${esc(account.id)}" data-next-status="${disabled ? "active" : "disabled"}" ${protectedAccount ? "disabled" : ""}>${disabled ? "恢复账号" : "停用账号"}</button></div>`;
                }).join("") : `<div class="muted" style="padding:8px 2px">暂无创作端账号。</div>`}</div>
              </div>`}
          </section>` : ""}` : ""}

          ${managementPage === "usage" ? `<section class="card set-data api-usage-panel" id="apiUsagePanel">
            <div class="card-head"><span><b>创作者模型用量</b><em>语言只显示上游真实 Token；图片、视频、语音显示已确认调用，未回传 Token 会明确标记未知</em></span>
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
        const [registrations, joins] = await Promise.all([
          canReviewRegistrations() ? remote.memberRequests.list("pending") : Promise.resolve([]),
          canReviewTeamRequests() ? remote.teams.requests("pending") : Promise.resolve({ items: [] }),
        ]);
        memberRequests = (Array.isArray(registrations) ? registrations : []).filter(x => x.role !== "supplier_child");
        teamJoinRequests = Array.isArray(joins) ? joins : (joins?.items || []);
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
      const receiptRows = Array.isArray(details?.receiptRows) ? details.receiptRows : [];
      const unresolvedReceipts = Array.isArray(details?.unresolvedReceiptEvents) ? details.unresolvedReceiptEvents : [];
      const apiTable = apiRows.length ? apiRows.map(row => `<div class="api-detail-row api-detail-api-row"><span><b>${esc(row.feature || "通用调用")}</b><em>${esc(row.model || "上游未回传模型")}</em></span><span>${usageNumber(row.calls)}</span><span>${usageNumber(row.promptTokens)}</span><span>${usageNumber(row.completionTokens)}</span><strong>${usageNumber(row.totalTokens)}</strong><time>${usageTime(row.lastUsedAt)}</time></div>`).join("") : `<p class="muted api-detail-empty">暂未收到上游可核验的 token 用量。</p>`;
      const eventTable = events.length ? events.map(row => `<div class="api-detail-row api-detail-event-row"><span><b>${esc(row.memberName || "成员")}</b><em>@${esc(row.username || "未知账号")}</em></span><span><b>${esc(row.feature || "通用调用")}</b><em>${esc(row.model || "上游未回传模型")}</em></span><span>${usageNumber(row.promptTokens)}</span><span>${usageNumber(row.completionTokens)}</span><strong>${usageNumber(row.totalTokens)}</strong><time>${usageTime(row.createdAt)}</time></div>`).join("") : `<p class="muted api-detail-empty">暂无调用记录。</p>`;
      const assetTable = assetRows.length ? assetRows.map(row => `<div class="api-asset-row"><span><b>${esc(row.feature || "模型调用")}</b><em>${esc(row.model || "上游未回传模型")}</em></span><span>${usageNumber(row.calls)} 次</span><strong>${usageNumber(row.outputUnits)} ${esc(row.unitLabel || "任务")}</strong><time>${usageTime(row.lastUsedAt)}</time></div>`).join("") : `<p class="muted api-detail-empty">暂无已记录的图片、视频或语音成功调用；旧调用不会以猜测值补写。</p>`;
      const assetEventTable = assetEvents.length ? assetEvents.map(row => `<div class="api-asset-row api-asset-event-row"><span><b>${esc(row.memberName || "成员")}</b><em>@${esc(row.username || "未知账号")} · ${esc(row.feature || "模型调用")} · ${esc(row.model || "上游未回传模型")}</em></span><span>${usageNumber(row.calls)} 次</span><strong>${usageNumber(row.outputUnits)} ${esc(row.unitLabel || "任务")}</strong><time>${usageTime(row.createdAt)}</time></div>`).join("") : `<p class="muted api-detail-empty">暂无调用记录。</p>`;
      const receiptTable = receiptRows.length ? receiptRows.map(row => `<div class="api-asset-row"><span><b>${esc(row.feature || "模型调用")}</b><em>${esc(row.surface || "平台")} · ${esc(row.usageKind || "未知")} · ${esc(row.model || "上游未回传模型")} · ${esc(row.status || "未知")}</em></span><span>${usageNumber(row.calls)} 次</span><strong>${row.usageKind === "llm" ? `${usageNumber(row.totalTokens)} Token${Number(row.tokenUnknownCalls || 0) ? ` · ${usageNumber(row.tokenUnknownCalls)} 次未知` : ""}` : `${usageNumber(row.outputUnits)} 输出单位`}</strong><time>${usageTime(row.lastUpdatedAt)}</time></div>`).join("") : `<p class="muted api-detail-empty">暂无新版可对账凭证。</p>`;
      const unresolvedTable = unresolvedReceipts.length ? unresolvedReceipts.map(row => `<div class="api-asset-row api-usage-unresolved-row"><span><b>${esc(row.feature || "模型调用")}</b><em>${esc(row.surface || "平台")} · ${esc(row.usageKind || "未知")} · ${esc(row.status || "未知")}</em></span><span>${esc(row.outboxState || "待核对")}</span><strong>${esc(row.error || "待持久化投影")}</strong><time>${usageTime(row.updatedAt)}</time></div>`).join("") : `<p class="muted api-detail-empty">当前没有待核对或未知凭证。</p>`;
      return `<section class="api-detail-section"><div class="api-detail-title"><b>可对账调用凭证</b><em>先落盘再调用上游；无 Token 回包的成功调用依然可见，但不伪造 Token</em></div><div class="api-asset-table">${receiptTable}</div></section><section class="api-detail-section"><div class="api-detail-title"><b>待核对 / 未知凭证</b><em>正常稳态应为 0；未知表示上游结果无法安全判定，需要对账而不是删除</em></div><div class="api-asset-table">${unresolvedTable}</div></section><section class="api-detail-section"><div class="api-detail-title"><b>语言模型 Token（按 API / 模型）</b><em>仅来自上游返回的真实 usage 字段</em></div><div class="api-detail-table"><div class="api-detail-row api-detail-label"><span>调用类型 / 模型</span><span>调用</span><span>输入</span><span>输出</span><span>合计</span><span>最近调用</span></div>${apiTable}</div></section><section class="api-detail-section"><div class="api-detail-title"><b>图片、视频与语音模型（成功调用）</b><em>显示实际调用次数与输出单位；不是 Token，也不估算成本</em></div><div class="api-asset-table"><div class="api-asset-row api-detail-label"><span>调用类型 / 模型</span><span>调用</span><strong>输出</strong><time>最近调用</time></div>${assetTable}</div></section><section class="api-detail-section"><div class="api-detail-title"><b>最近语言调用记录</b><em>旧表只包含上游返回了 Token 的请求；新凭证请以上方对账区为准</em></div><div class="api-detail-table api-detail-events"><div class="api-detail-row api-detail-label api-detail-event-row"><span>创作者</span><span>调用类型 / 模型</span><span>输入</span><span>输出</span><span>合计</span><span>时间</span></div>${eventTable}</div></section><section class="api-detail-section"><div class="api-detail-title"><b>最近图片 / 视频 / 语音调用</b><em>只在服务端确认成功返回输出或创建任务后写入</em></div><div class="api-asset-table">${assetEventTable}</div></section>`;
    };
    const openApiUsageDetails = (memberId = "") => {
      const member = apiUsageRows.find(row => row.memberId === memberId) || null;
      openModal(`<div class="mp-head"><div><b>${member ? `${esc(member.memberName || "成员")} · 模型调用明细` : "模型调用明细"}</b><em>真实 Token 与图片 / 视频 / 语音输出分开统计，未知状态单独标记</em></div><button class="icon-btn" data-close>${icon("x", 16)}</button></div><div class="api-usage-detail-body"><div class="muted" style="padding:12px 2px">正在读取 API 明细...</div></div>`, { wide: true, onMount(panel) {
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
      $$("[data-team-approve]", root).forEach(button => button.addEventListener("click", async () => {
        const req = teamJoinRequests.find(item => item.id === button.dataset.teamApprove);
        const ok = await confirmModal({
          title: `允许「${req?.memberName || "用户"}」加入团队？`,
          body: "通过后会成为创作成员，并获得团队全部功能与团队共享数据权限。",
          okText: "加入团队",
        });
        if (!ok) return;
        try {
          await remote.teams.review(button.dataset.teamApprove, true);
          state.members = await remote.members.list(true);
          saveMembers();
          toast("已加入团队");
          await loadRequests();
        } catch (error) {
          toast("审批失败：" + (error?.message || error));
        }
      }));
      $$("[data-team-reject]", root).forEach(button => button.addEventListener("click", async () => {
        const req = teamJoinRequests.find(item => item.id === button.dataset.teamReject);
        const ok = await confirmModal({
          title: `拒绝「${req?.memberName || "用户"}」的加入申请？`,
          danger: true,
          okText: "拒绝申请",
        });
        if (!ok) return;
        try {
          await remote.teams.review(button.dataset.teamReject, false);
          toast("申请已拒绝");
          await loadRequests();
        } catch (error) {
          toast("操作失败：" + (error?.message || error));
        }
      }));
      const memberDialog = (m) => {
        const editing = !!m;
        m = m || { name: "", username: "", pin: "", role: "editor" };
        const selectedRole = m.teamRole === "admin" ? "admin" : "editor";
        openModal(`
          <div class="mp-head"><b>${editing ? "编辑成员" : "添加成员"}</b><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
          <div class="mp-body">
            <label class="field">姓名<input class="input" id="mdName" value="${esc(m.name)}" placeholder="例如：小红" /></label>
            <label class="field">用户名（登录用）<input class="input" id="mdUser" value="${esc(m.username)}" placeholder="字母/数字，唯一" /></label>
            <label class="field">${editing ? "重设登录密码（留空不改）" : "初始登录密码"}<input class="input" id="mdPin" type="password" value="" autocomplete="new-password" placeholder="${editing ? "设置新密码" : "登录密码"}" /></label>
            <label class="field">角色
              <select class="input" id="mdRole">
                ${ROLE_OPTS.map(r => `<option value="${r}" ${selectedRole === r ? "selected" : ""}>${ROLE_DESC[r]}</option>`).join("")}
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
                const expectedTeamRole = role === "admin" ? "admin" : "creator";
                if (!savedMember || savedMember.teamRole !== expectedTeamRole) throw new Error("团队角色保存未生效，请刷新后重试");
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
        const ok = await confirmModal({ title: `把「${m.name}」踢出团队？`, body: "账号和创作记录会完整保留；该账号将退出当前团队并变为 Free 用户。", danger: true, okText: "踢出团队" });
        if (!ok) return;
        if (remote.isOn()) {
          try { await remote.members.kick(m.id); state.members = await remote.members.list(); saveMembers(); }
          catch (e) { toast("踢出失败：" + (e.message || e), "error"); return; }
        } else {
          m.role = "user"; m.team = null; m.teamId = null; m.teamRole = null;
          state.members = state.members.filter(x => x.id !== m.id);
          saveMembers();
        }
        draw();
        toast("成员已踢出团队，账号已转为 Free");
      }));
      $$('[data-platform-status]', root).forEach(button => button.addEventListener("click", async () => {
        const nextStatus = button.dataset.nextStatus;
        const account = platformAccounts.creators.find(item => item.id === button.dataset.platformStatus);
        if (!account) return;
        const action = nextStatus === "disabled" ? "停用" : "恢复";
        const ok = await confirmModal({ title: `${action}「${account.name}」？`, body: nextStatus === "disabled" ? "停用后现有登录态和后续登录都会被服务端拒绝；账号、资产和历史记录不会删除。" : "恢复后该账号可以重新登录，原有账号和数据保持不变。", danger: nextStatus === "disabled", okText: action + "账号" });
        if (!ok) return;
        try {
          await remote.admin.setPlatformAccountStatus(account.id, nextStatus);
          const result = await remote.admin.platformAccounts();
          platformAccounts = { personal: result?.personal || [], teamOwners: result?.teamOwners || [], creators: result?.creators || [] };
          toast(`账号已${action}`);
          draw();
        } catch (error) { toast(error?.message || `${action}失败`, "error"); }
      }));
      $$("[data-team-supplier-password]", root).forEach(button => button.addEventListener("click", () => {
        const account = teamSupplierAccounts.find(item => item.id === button.dataset.teamSupplierPassword);
        if (!account) return;
        openModal(`
          <div class="mp-head"><div><b>设置供应商登录密码</b><em>@${esc(account.username || "")}</em></div><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
          <div class="mp-body">
            <p class="mp-sub">出于安全原因，旧密码无法查看。这里设置的新密码只用于该供应商管理员登录。</p>
            <label class="field">新密码<input class="input" id="teamSupplierPin" type="password" minlength="6" autocomplete="new-password" placeholder="至少 6 位" /></label>
            <label class="field">确认新密码<input class="input" id="teamSupplierPinConfirm" type="password" minlength="6" autocomplete="new-password" placeholder="再次输入" /></label>
          </div>
          <div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="teamSupplierPinSave">保存新密码</button></div>
        `, { onMount(panel, close) {
          $("#teamSupplierPinSave", panel)?.addEventListener("click", async () => {
            const pin = $("#teamSupplierPin", panel)?.value || "";
            const confirm = $("#teamSupplierPinConfirm", panel)?.value || "";
            if (pin.length < 6) { toast("新密码至少 6 位"); return; }
            if (pin !== confirm) { toast("两次输入的密码不一致"); return; }
            try {
              await remote.teams.resetSupplierPassword(account.id, pin);
              close();
              toast("供应商登录密码已更新");
            } catch (error) {
              toast("供应商密码更新失败：" + (error?.message || error));
            }
          });
        }});
      }));

    }

    draw();
    if (managementPage === "members" && remote.isOn() && canManageTeam) {
      remote.members.list(true).then(items => {
        state.members = Array.isArray(items) ? items : state.members;
        saveMembers();
        draw();
      }).catch(error => toast("读取团队成员失败：" + (error?.message || error)));
      remote.teams.supplierAccounts().then(result => {
        teamSupplierAccounts = Array.isArray(result) ? result : (result?.items || []);
        teamSuppliersLoaded = true;
        draw();
      }).catch(error => {
        teamSuppliersLoaded = true;
        toast("读取团队供应商账号失败：" + (error?.message || error));
        draw();
      });
      if (canReviewPlatformAccounts()) {
        remote.admin.platformAccounts().then(result => {
          platformAccounts = {
            personal: Array.isArray(result?.personal) ? result.personal : [],
            teamOwners: Array.isArray(result?.teamOwners) ? result.teamOwners : [],
            creators: Array.isArray(result?.creators) ? result.creators : [],
          };
          platformAccountsLoaded = true;
          draw();
        }).catch(error => {
          platformAccountsLoaded = true;
          toast("读取平台账号失败：" + (error?.message || error));
          draw();
        });
      }
    }
    if (managementPage === "requests") loadRequests();
    if (managementPage === "usage") loadApiUsage();
  }
};
