/* Agent 对话的结构化消息卡片（对话即数据：卡片从 store 实时取数渲染） */

import { esc, gradFor, timeAgo } from "../core/util.js";
import { icon, agentAvatar } from "../ui/icons.js";
import { state, save, accountById, canDeliver, ownedBy } from "../core/store.js";
import { platChip, groupOf, isAvatarAsset, isAccountDisabled } from "../domain/accounts.js";
import { accountCreationQuota } from "../domain/productionQuota.js?v=20260810-v141-dashboard-metrics-1";
import { STAGES, flowOf, normalizeStage, stageDone, statusPill, jobsOf } from "../domain/productions.js?v=20260810-v141-dashboard-metrics-1";
import { batchById, batchProds, currentSessionBatches, selectAccountsForPlan, prunePlanReferences } from "./orchestrator.js?v=20260810-v141-dashboard-metrics-1";
import { urlFor } from "../domain/assets.js";

const DEFAULT_XHS_IMAGE_COUNT = 4;
const CONTENT_KIND_GROUP = { image: "图文组", static: "静态视频", material: "素材", real: "真人" };
const CONTENT_KIND_LABEL = { image: "图文", static: "静态视频", material: "素材视频", real: "真人视频" };

/* 旧数据里偶尔会把“昵称+英文别名”整段重复写入 name。
   这里只修正展示投影，不回写账号数据，避免影响历史任务和交付命名。 */
export function accountDisplayName(account, fallback = "未命名账号") {
  const raw = String(account?.name || "").trim().replace(/\s+/g, " ");
  if (!raw) return fallback;
  const parts = raw.split(" ");
  if (parts.length < 2) return raw;
  const comparable = value => value.replace(/[\s_-]+/g, "").toLocaleLowerCase("zh-Hans-CN");
  for (let cut = 1; cut < parts.length; cut++) {
    const head = comparable(parts.slice(0, cut).join(""));
    const tail = comparable(parts.slice(cut).join(""));
    if (!head || tail.length < head.length || tail.length % head.length !== 0) continue;
    if (tail === head.repeat(tail.length / head.length)) return parts.slice(0, cut).join(" ");
  }
  return raw;
}

function kindFromGroup(group = "") {
  if (group === "静态视频") return "static";
  if (group === "素材") return "material";
  if (group === "真人") return "real";
  return "image";
}

function normalizePlanKind(p) {
  p.creativeMode = "custom";
  p.contentKind = ["image", "static", "material", "real"].includes(p.contentKind) ? p.contentKind : kindFromGroup(p.group);
  p.group = CONTENT_KIND_GROUP[p.contentKind] || "图文组";
  if (p.creativeMode === "custom") {
    p.content = "";
    p.topic = "";
    p.topicMode = "fixed";
    p.perAccountCount = 1;
    p.accountCounts = {};
  }
  const match = a => {
    if (!a || isAccountDisabled(a)) return false;
    const g = groupOf(a);
    if (p.contentKind === "image") return a?.mode === "图文" || g === "图文组";
    if (p.contentKind === "static") return true;
    if (p.contentKind === "material") return a?.mode === "视频" && g === "素材";
    if (p.contentKind === "real") return a?.mode === "视频" && g === "真人";
    return true;
  };
  p.accountIds = (p.accountIds || []).filter(id => match(accountById(id)));
  p.accountCount = p.accountIds.length;
  return match;
}

export function renderMessage(m) {
  if (m.role === "user") {
    return `<div class="ag-row user" data-mid="${m.id}">
      <div class="ag-bubble user">${esc(m.payload.text)}</div>
    </div>`;
  }
  const inner = CARD[m.type] ? CARD[m.type](m) : CARD.text(m);
  return `<div class="ag-row agent" data-mid="${m.id}" data-mtype="${m.type}">
    <span class="ag-avatar">${agentAvatar(30)}</span>
    <div class="ag-content">${inner}<time class="ag-time">${timeAgo(m.ts)}</time></div>
  </div>`;
}

function isPureAccountSelectionText(text) {
  const s = String(text || "").trim();
  if (/[「"]/.test(s) || /主题|关于|围绕|做一?期|出一?期/.test(s)) return false;
  return /(选择|选|挑|找|找出|匹配|帮我选|帮我选择|帮我找|给我挑|给我找|选出|安排|量产|创作|做).{0,24}(账号|号|图文|素材|真人|数字人)/.test(s);
}

function zhCount(text) {
  const m = String(text || "").match(/([0-9]+|[两一二三四五六七八九十]+)\s*(个|条|只|家|篇|张|支)?\s*(账号|号|图文|笔记|图文号|图文账号|素材视频|素材号|素材账号|真人号|真人账号|数字人号|数字人账号|视频)/);
  if (!m) return null;
  if (/^[0-9]+$/.test(m[1])) return parseInt(m[1], 10);
  const d = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (m[1] === "十") return 10;
  const ten = m[1].match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (ten) return (ten[1] ? d[ten[1]] : 1) * 10 + (ten[2] ? d[ten[2]] : 0);
  return d[m[1]] || null;
}

function normalizeSelectionPlan(p) {
  if (!p || p.status !== "pending" || !isPureAccountSelectionText(p.goal || "")) return false;
  let changed = false;
  const goal = p.goal || "";
  const tailPick = /(?:最后|后|倒数|末尾)\s*([0-9]+|[两一二三四五六七八九十]+)\s*(个|只|家)?\s*(账号|号|图文|图文号|图文账号|素材号|真人号|数字人号)?/.test(goal);
  if (tailPick && p.pickFrom !== "end") { p.pickFrom = "end"; changed = true; }
  const lockedGroup = CONTENT_KIND_GROUP[p.contentKind || ""];
  const group = lockedGroup || (/图文|笔记|小红书图/.test(goal) ? "图文组" : (goal.includes("真人") || goal.includes("数字人")) ? "真人" : (goal.includes("素材") || goal.includes("无数字人")) ? "素材" : p.group || "all");
  if (p.topic || p.topicMode !== "fixed") { p.topic = ""; p.topicMode = "fixed"; changed = true; }
  if (group !== p.group) { p.group = group; changed = true; }
  if ((p.tags || []).length) { p.tags = []; changed = true; }
  const want = p.accountCount || zhCount(goal);
  if (/很久没发布|久未发布|长期没发|沉默|低活跃|不活跃|没更新/.test(goal)) { p.sort = "stale"; changed = true; }
  if (!p.manualAccountSelection) {
    let matched = selectAccountsForPlan({ group: p.group, sort: p.sort || "", pickFrom: p.pickFrom || "", accountCount: want });
    const nextIds = matched.map(a => a.id);
    if (!(p.accountIds || []).length || (p.accountIds || []).some(id => !nextIds.includes(id))) { p.accountIds = nextIds; changed = true; }
  } else if (p.accountCount !== (p.accountIds || []).length) {
    p.accountCount = (p.accountIds || []).length;
    changed = true;
  }
  if (!p.perAccountCount) { p.perAccountCount = 1; changed = true; }
  return changed;
}

function imageAssets() {
  const score = a => {
    const tags = (a.tags || []).join(" ");
    if (/logo|头像|图文风格参考|主界面|角色版/i.test(`${a.name || ""} ${tags}`)) return 0;
    if (a.shared || /已发布生成图|站内生成|笔记图/.test(tags)) return 1;
    return 2;
  };
  const seen = new Set();
  return state.assets
    .filter(a => a.type === "图片" && !isAvatarAsset(a) && !a.accountId && !a.delivered && (a.shared || ownedBy(a)))
    .sort((a, b) => score(a) - score(b) || (b.sharedAt || b.createdAt || 0) - (a.sharedAt || a.createdAt || 0))
    .filter(a => {
      const key = a.dataUrl || a.url || a.remoteUrl || `${String(a.name || "").toLowerCase()}|${(a.tags || []).join("|")}|${a.accountId || ""}`;
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function selectedRefIds(p, key = "sharedRefAssetIds") {
  const ids = Array.isArray(p[key]) ? [...p[key]] : [];
  if (key === "sharedRefAssetIds" && p.sharedRefAssetId && !ids.includes(p.sharedRefAssetId)) ids.unshift(p.sharedRefAssetId);
  return [...new Set(ids.filter(Boolean))].slice(0, 5);
}

function refOptions(selected = []) {
  const sel = new Set(selected);
  const assets = imageAssets();
  if (!assets.length) return `<option value="" disabled>资产库暂无图片参考</option>`;
  return assets.map(a => `<option value="${esc(a.id)}" ${sel.has(a.id) ? "selected" : ""}>${esc(a.name || "未命名图片")}</option>`).join("");
}

function refChips(ids = [], action, mid, accountId = "") {
  const list = ids.map(id => state.assets.find(a => a.id === id)).filter(Boolean);
  if (!list.length) return `<span class="muted">未设置</span>`;
  return list.map(a => `<span class="ref-chip dark">
    ${urlFor(a.id) ? `<img src="${urlFor(a.id)}"/>` : ""}
    <span>${esc(a.name || "参考图")}</span>
    ${action ? `<button type="button" class="ref-x" data-act="${action}" data-mid="${mid}" data-refid="${a.id}" ${accountId ? `data-ref-account="${esc(accountId)}"` : ""} aria-label="移除参考图">${icon("x", 10)}</button>` : ""}
  </span>`).join("");
}

const CARD = {
  text(m) {
    return `<div class="ag-bubble agent">${esc(m.payload.text).replace(/\n/g, "<br/>")}</div>`;
  },

  /* 计划卡：确认前可改主题/风格/标签/选号 */
  plan(m) {
    const p = m.payload;
    const planSnapshot = () => JSON.stringify({
      creativeMode: p.creativeMode, contentKind: p.contentKind, group: p.group,
      accountIds: p.accountIds, perAccountCount: p.perAccountCount, content: p.content, topic: p.topic,
      referenceSelectionId: p.referenceSelectionId, sharedRefAssetId: p.sharedRefAssetId,
      sharedRefAssetIds: p.sharedRefAssetIds, coverRefAssetIds: p.coverRefAssetIds,
      accountRefAssetIds: p.accountRefAssetIds
    });
    const beforePlan = planSnapshot();
    const accountMatchesCurrentKind = normalizePlanKind(p);
    const normalized = normalizeSelectionPlan(p);
    prunePlanReferences(p);
    if (normalized || beforePlan !== planSnapshot()) save("sessions");
    const matched = (p.accountIds || []).map(accountById).filter(Boolean);
    const confirmed = p.status === "confirmed";
    const cancelled = p.status === "cancelled";
    const starting = p.status === "starting";
    const locked = confirmed || cancelled || starting;
    const perAccountCount = Math.max(1, Math.min(12, Number(p.perAccountCount || 1) || 1));
    const imageCountDefault = Math.max(1, Math.min(12, Number(p.imageCount || DEFAULT_XHS_IMAGE_COUNT) || DEFAULT_XHS_IMAGE_COUNT));
    const countFor = id => Math.max(1, Math.min(12, Number((p.accountCounts || {})[id] || perAccountCount) || perAccountCount));
    const imageCountFor = id => Math.max(1, Math.min(12, Number((p.accountImageCounts || {})[id] || imageCountDefault) || imageCountDefault));
    const totalCount = matched.reduce((sum, a) => sum + countFor(a.id), 0);
    const isImageKind = p.contentKind === "image";
    const isStaticKind = p.contentKind === "static";
    const isMaterialKind = p.contentKind === "material";
    const isRealKind = p.contentKind === "real";
    const staticVideoStyle = String(p.staticVideoStyle || "现代漫画分镜风");
    // 图文账号也能参与静态视频，但此时它走独立的视频产物链路，不能继续
    // 显示“多图 / 单图”和每条图数等图文专属编辑项。
    const isImageAcc = a => isImageKind && (a?.mode === "图文" || groupOf(a) === "图文组");
    const customMode = true;
    const globalRefs = selectedRefIds(p);
    const coverRefs = selectedRefIds(p, "coverRefAssetIds");
    const accountRefs = p.accountRefAssetIds || {};
    const accountPool = (state.accounts || []).filter(Boolean).filter(accountMatchesCurrentKind);
    const kindBtn = (kind, label) => `<button type="button" class="agc-seg ${p.contentKind === kind ? "is-active" : ""}" data-pf-kind="${kind}" ${locked ? "disabled" : ""}>${label}</button>`;
    const perAccountOverrides = matched.length ? `<div class="agc-overrides">
      ${matched.map(a => {
        const imgAcc = isImageAcc(a);
        const creationQuota = accountCreationQuota(a.id);
        const customCopyMode = customMode;
        const imageCreationMode = imgAcc ? ((p.accountImageCreationModes || {})[a.id] || "copy") : "copy";
        const singleImagePrompt = ((p.accountImagePrompts || {})[a.id] || "").trim();
        const singleImageTitle = ((p.accountSingleImageTitles || {})[a.id] || "").trim();
        const customCopyTitle = ((p.accountCopyTitles || {})[a.id] || "").trim();
        const customCopyBody = ((p.accountCopyBodies || {})[a.id] || "").trim();
        const presetRefId = !imgAcc && isRealKind && a.subType === "数字人" ? a.charBoardAssetId : "";
        const taskRefIds = (accountRefs[a.id] || []).slice(0, 3);
        const presetRefHtml = presetRefId ? `<span class="agc-ref-origin is-preset">数字人角色版 · 生成时自动用于锁定角色身份</span>${refChips([presetRefId], "", m.id, a.id)}` : "";
        const imageModeSwitch = imgAcc ? `<div class="agc-image-mode-switch" data-mode="${imageCreationMode}" aria-label="图文创作模式">
          <button type="button" class="${imageCreationMode === "copy" ? "is-active" : ""}" data-act="plan-image-mode" data-mid="${m.id}" data-account="${a.id}" data-mode="copy" title="多图笔记：根据标题和文案生成一组配图" ${locked ? "disabled" : ""}>多图</button>
          <button type="button" class="${imageCreationMode === "single" ? "is-active" : ""}" data-act="plan-image-mode" data-mid="${m.id}" data-account="${a.id}" data-mode="single" title="单图创作：只生成一张指定画面" ${locked ? "disabled" : ""}>单图</button>
        </div>` : "";
        const imageCountControl = imgAcc && imageCreationMode !== "single"
          ? `<label class="agc-mini-count img-count">每条图数<input type="number" min="1" max="12" aria-label="${esc(accountDisplayName(a))}每条图数" data-pacc-imgcount="${a.id}" value="${esc(imageCountFor(a.id))}" ${locked ? "disabled" : ""} /></label>`
          : "";
        const copyFields = `<div class="agc-copy-fields ${customCopyMode ? "is-custom" : ""} image-mode-panel" data-image-mode="${imageCreationMode}">
          ${imageCreationMode === "single" ? `<div class="agc-account-copy single-image-copy has-mode-switch">
            ${imageModeSwitch}
            <input class="agc-copy-title-input" data-pacc-single-title="${a.id}" value="${esc(singleImageTitle)}" placeholder="必填标题：用于生成发布文案" ${locked ? "disabled" : ""} />
            <button type="button" class="agc-copy-editor-btn ${singleImagePrompt ? "is-filled" : ""}" data-act="plan-edit-single-image" data-mid="${m.id}" data-account="${a.id}" ${locked ? "disabled" : ""}>${icon("image", 11)} ${singleImagePrompt ? "已填图片提示词" : "填写图片提示词"}</button>
          </div>` : `<div class="agc-account-copy ${imgAcc ? "has-mode-switch has-image-count" : ""}">
            ${imageModeSwitch}
            <input class="agc-copy-title-input" data-pacc-copy-title="${a.id}" value="${esc(customCopyTitle)}" placeholder="必填标题" ${locked ? "disabled" : ""} />
            <button type="button" class="agc-copy-editor-btn ${customCopyBody ? "is-filled" : ""}" data-act="plan-edit-copy" data-mid="${m.id}" data-account="${a.id}" ${locked ? "disabled" : ""}>${icon("fileText", 11)} ${customCopyBody ? "已填文案" : "填写文案"}</button>
            ${imageCountControl}
          </div>`}
        </div>`;
        return `<div class="agc-override ${imgAcc ? "is-image" : "is-video"} ${customMode ? "is-custom-plan" : ""}" ${locked ? "" : `data-plan-custom-refdrop="${m.id}" data-ref-account="${a.id}"`}>
        <div class="agc-override-name"><b>${esc(accountDisplayName(a))}</b><span>${esc(groupOf(a))} · ${esc(a.platform || a.mode || "账号")}</span><em class="agc-created-today">今日 ${creationQuota.used}/${creationQuota.limit}</em></div>
        ${customMode ? "" : `<label class="agc-mini-count">本号条数<input type="number" min="1" max="12" data-pacc-count="${a.id}" value="${esc(countFor(a.id))}" ${locked ? "disabled" : ""} /></label>`}
        ${imgAcc ? "" : customMode ? "" : `<span class="agc-video-chain" title="口播 / 数字人 / 混剪">${icon("video", 12)} 视频</span>`}
        ${copyFields}
        <div class="agc-mini-ref">
          <div class="agc-mini-head"><span>参考图</span><em>本次定制最多3张；数字人角色版会单独标记</em></div>
          <div class="agc-ref-chips mini" data-ref-account="${a.id}">
            ${presetRefHtml}
            <span class="agc-ref-origin">本次任务</span>
            ${refChips(taskRefIds, locked ? "" : "plan-custom-refremove", m.id, a.id)}
          </div>
          ${locked ? "" : `<div class="agc-override-actions">
            <button class="agc-account-asset-btn" data-act="plan-asset-pick" data-mid="${m.id}" data-ref-kind="custom" data-ref-account="${a.id}">${icon("image", 11)} 从资产选择</button>
            <button class="agc-account-remove-btn" data-act="plan-remove-account" data-mid="${m.id}" data-account="${a.id}">${icon("x", 10)} 取消选择</button>
          </div>`}
          ${locked ? "" : `<input type="file" accept="image/*" multiple hidden data-pacc-ref-up="${a.id}" data-mid="${m.id}" />`}
        </div>
      </div>`;
      }).join("")}
    </div>` : "";
    return `<div class="ag-card plan ${confirmed ? "resolved" : ""}" data-plan="${m.id}">
      <div class="agc-head">${icon("kanban", 15)}<b>量产任务板</b>
        <div class="agc-modebar">
          <span class="agc-seg-group">${kindBtn("image", "图文")}${kindBtn("static", "静态视频")}${kindBtn("material", "素材视频")}${kindBtn("real", "真人视频")}</span>
        </div>
        <span class="agc-state ${confirmed ? "ok" : cancelled ? "off" : starting ? "busy" : ""}">${confirmed ? "已执行" : cancelled ? "已取消" : starting ? "启动中" : "待确认"}</span>
      </div>
      <div class="agc-custom-hint">${icon("spark", 13)} ${esc(CONTENT_KIND_LABEL[p.contentKind])} · 新任务只使用任务板明确选择的参考图；数字人账号会额外使用管理员锁定的角色版。</div>
      ${isStaticKind ? `<div class="agc-static-style-row">
        <label>画面风格
          <select data-pf="staticVideoStyle" ${locked ? "disabled" : ""}>
            ${[
              ["现代漫画分镜风", "现代漫画（默认）"],
              ["清爽 2.5D 动画广告风", "2.5D 动画"],
              ["写实电影感短片风", "写实电影感"],
              ["极简产品演示风", "极简产品演示"]
            ].map(([value, label]) => `<option value="${esc(value)}" ${staticVideoStyle === value ? "selected" : ""}>${esc(label)}</option>`).join("")}
          </select>
        </label>
        <span>用于本次全部静态视频；账号设定只补充人物与品牌细节。</span>
      </div>` : ""}
      ${(() => {
        const editable = !locked;
        const usesUnifiedImageRefs = isImageKind || isStaticKind;
        const refKind = usesUnifiedImageRefs ? "shared" : "cover";
        const refIds = usesUnifiedImageRefs ? globalRefs : coverRefs;
        const removeAct = usesUnifiedImageRefs ? "plan-refremove" : "plan-cover-refremove";
        const clearAct = usesUnifiedImageRefs ? "plan-refclear" : "plan-cover-refclear";
        const dropAttr = usesUnifiedImageRefs ? `data-plan-refdrop="${m.id}"` : `data-plan-cover-refdrop="${m.id}"`;
        const inputAttr = usesUnifiedImageRefs ? `data-plan-ref="${m.id}"` : `data-plan-cover-ref="${m.id}"`;
        const refTitle = usesUnifiedImageRefs ? "统一参考图" : isMaterialKind ? "统一素材视频参考" : "统一真人视频封面参考";
        const refDesc = isStaticKind
          ? "静态视频的每张图片分镜都会携带这些参考图，最多5张；单账号可再追加"
          : isImageKind
          ? "图文成图会参考，最多5张；单账号定制图可单独追加"
          : isMaterialKind
          ? "用于视频封面、信息流 B 面分镜和功能演示参考，最多5张"
          : "用于视频封面参考；角色形象仍读取账号角色图，缺失时生成会拦截";
        return `<div class="agc-ref">
          <div class="agc-ref-top">
            <span class="agc-ref-l">${icon("star", 12)} ${refTitle}<em>${refDesc}</em></span>
            ${editable && refIds.length ? `<button class="link-btn" data-act="${clearAct}" data-mid="${m.id}">清空统一参考</button>` : ""}
          </div>
          <div class="agc-ref-body">
            <div class="agc-ref-picked ${editable ? "is-dropzone" : ""}" ${editable ? dropAttr : ""}>
              <div class="agc-ref-picked-head"><b>已选参考图</b>${editable ? `<span>${icon("upload", 11)} 拖入或点击上传</span>` : ""}</div>
              <div class="agc-ref-chips">${refChips(refIds, editable ? removeAct : "", m.id)}</div>
              ${editable ? `<input type="file" accept="image/*" multiple hidden ${inputAttr} />` : ""}
            </div>
            ${editable ? `<button class="agc-ref-library" data-act="plan-asset-pick" data-mid="${m.id}" data-ref-kind="${refKind}">
              ${icon("image", 16)}
              <b>打开资产库</b>
              <em>放大看图后选择</em>
            </button>` : ""}
          </div>
        </div>`;
      })()}
      <div class="agc-sec"><span>命中 ${matched.length} 个账号 · 共 ${totalCount} 条 <em>点击账号可增减</em></span>
        ${locked ? "" : `<span class="agc-sec-tools">
          ${customMode ? "" : `<label class="agc-count-inline">每号内容数<input type="number" min="1" max="12" data-pf="perAccountCount" value="${esc(perAccountCount)}" /></label>`}
          ${isImageKind ? `<label class="agc-count-inline">统一每条图数<input type="number" min="1" max="12" data-pf="imageCount" value="${esc(imageCountDefault)}" /></label>
          <button class="agc-random-pick" data-act="plan-apply-image-count" data-mid="${m.id}">应用到全部图文</button>` : ""}
          <button class="agc-random-pick" data-act="plan-select-all" data-mid="${m.id}">${accountPool.length > 0 && accountPool.every(a => (p.accountIds || []).includes(a.id)) ? "取消全选" : "全选"}</button>
          <button class="agc-random-pick" data-act="plan-random-accounts" data-mid="${m.id}" title="随机选择最多10个账号">${icon("dice", 13)} 随机选 ≤10</button>
        </span>`}
      </div>
      <div class="agc-accs">${accountPool.map((a, idx) => {
        const on = (p.accountIds || []).includes(a.id);
        const imgAcc = isImageAcc(a);
        const quota = accountCreationQuota(a.id);
        const quotaFull = quota.remaining <= 0;
        return `<button class="agc-acc ${on ? "on" : ""} ${quotaFull ? "is-quota-full" : ""} ${imgAcc ? "is-image" : "is-video"}" data-pacc="${a.id}" aria-pressed="${on ? "true" : "false"}" ${(locked || (quotaFull && !on)) ? "disabled" : ""} title="同一账号所有成员今日合计 ${quota.used}/${quota.limit} 条">
          <span class="agc-idx">#${String(idx + 1).padStart(2, "0")}</span>
          <b>${esc(accountDisplayName(a))}</b>
          <em class="agc-account-meta"><span class="agc-account-type">${esc(groupOf(a))}</span><span class="agc-created-today">今日 ${quota.used}/${quota.limit}</span></em>
          <span class="agc-select-mark ${on ? "is-visible" : ""}" aria-hidden="true">${icon("check", 13, "ok")}</span>
        </button>`;
      }).join("")}</div>
      ${perAccountOverrides}
      ${locked ? "" : `<div class="agc-foot is-plan-actions">
        <button class="btn ghost sm" data-act="plan-cancel" data-mid="${m.id}">取消</button>
        <button class="btn primary sm" data-act="plan-confirm" data-mid="${m.id}">${icon("spark", 14)} 确认执行（${totalCount} 条）</button>
      </div>`}
    </div>`;
  },

  /* 进度卡：活卡片，从 store 实时取数 */
  progress(m) {
    const b = batchById(m.payload.batchId);
    if (!b) return `<div class="ag-bubble agent">批次已不存在</div>`;
    const prods = batchProds(b);
    const seg = (label, n, cls) => n ? `<span class="agp-seg ${cls}"><b>${n}</b>${label}</span>` : "";
    const c = { draft: 0, gen: 0, review: 0, done: 0, fail: 0 };
    prods.forEach(p => {
      if (p.stageStatus === "failed") c.fail++;
      else if (p.stage === "delivered") c.done++;
      else if (p.stage === "review") c.review++;
      else if (p.stage === "render" || p.stage === "workshop" || (p.stage === "images" && p.stageStatus === "running")) c.gen++;
      else c.draft++;
    });
    const pct = prods.length ? Math.round(c.done / prods.length * 100) : 0;
    const PHASE = { drafting: "批量起草中", generating: "生成中", review: "待发布", done: "已完成" };
    return `<div class="ag-card live" data-live="batch" data-batch="${b.id}">
      <div class="agc-head">${icon("pulse", 15)}<b>「${esc(b.topic)}」</b><span class="agc-state run">${PHASE[b.phase] || b.phase}</span></div>
      <div class="agp-bar"><i style="width:${pct}%"></i></div>
      <div class="agp-segs">
        ${seg("起草", c.draft, "draft")}${seg("生成", c.gen, "gen")}${seg("待审", c.review, "review")}${seg("已交付", c.done, "done")}${seg("失败", c.fail, "fail")}
      </div>
    </div>`;
  },

  /* 发布卡：创作者自检后直接「定稿发布」入供应商端（无强制审核门槛） */
  approval(m) {
    const b = batchById(m.payload.batchId);
    if (!b) return `<div class="ag-bubble agent">批次已不存在</div>`;
    const canPub = canDeliver();
    const prods = batchProds(b);
    const inReview = prods.filter(p => p.stage === "review");
    const failed = prods.filter(p => p.stageStatus === "failed");
    const rows = inReview.map(p => {
      const acc = accountById(p.accountId);
      const items = (p.mode === "图文" ? p.artifacts.images.items : p.artifacts.boards.items) || [];
      const coverAssetId = p.mode === "图文"
        ? items.find(x => x.assetId)?.assetId
        : p.artifacts.boards?.cover?.assetId;
      const coverUrl = coverAssetId ? urlFor(coverAssetId) : null;
      const finalVideoUrl = p.mode === "视频" ? String(p.artifacts?.finalVideoUrl || "").trim() : "";
      const editableBoards = p.mode === "图文" ? items.map((item, index) => {
        const src = item.assetId ? urlFor(item.assetId) : "";
        return `<button class="agr-board ${item.status === "loading" ? "is-loading" : ""}" type="button" data-act="batch-image-edit" data-pid="${p.id}" data-image-index="${index}" title="编辑第 ${index + 1} 张提示词并重新生成">${src ? `<img src="${src}" alt="第 ${index + 1} 张"/>` : `<i>${index + 1}</i>`}<span>${icon("sliders", 9)} 微调</span></button>`;
      }).join("") : "";
      return `<div class="agr-row">
        ${editableBoards ? `<span class="agr-board-strip">${editableBoards}</span>` : `<span class="agr-cover ${finalVideoUrl ? "is-video" : ""}">${finalVideoUrl ? `<video src="${esc(finalVideoUrl)}" poster="${esc(coverUrl || "")}" muted playsinline preload="metadata"></video>` : coverUrl ? `<img src="${coverUrl}" alt="视频封面"/>` : `<i style="background:${gradFor(p.title)}">封面</i>`}</span>`}
        <span class="agr-main"><b>${esc(p.artifacts.copy.title || p.title || p.topic)}</b><em>${esc(acc?.name || "")} · ${p.mode}</em></span>
        ${p.mode === "视频" && !p.staticVideo ? `<button class="link-btn" data-act="batch-cover-edit" data-pid="${p.id}">${icon("sliders", 11)} 微调封面</button>
        <button class="link-btn" data-act="batch-video-regenerate" data-pid="${p.id}">${icon("refresh", 11)} 重新生成视频</button>` : ""}
        <button class="link-btn" data-act="open-prod" data-pid="${p.id}">查看</button>
        ${canPub ? `<button class="btn primary sm" data-act="prod-deliver" data-pid="${p.id}">定稿发布</button>` : ""}
      </div>`;
    }).join("");
    return `<div class="ag-card live" data-live="batch" data-batch="${b.id}">
      <div class="agc-head">${icon("eye", 15)}<b>定稿发布</b><span class="agc-state review">${inReview.length} 条待发布</span></div>
      ${rows || `<div class="agc-p ok">${icon("checkCircle", 14)} 本批全部处理完毕</div>`}
      ${failed.length ? `<div class="agc-p fail">${icon("alert", 13)} 另有 ${failed.length} 条失败 <button class="link-btn" data-act="batch-retry" data-batch="${b.id}">重试失败项</button></div>` : ""}
      ${inReview.length && canPub ? `<div class="agc-foot">
        <button class="btn primary sm" data-act="batch-deliver-all" data-batch="${b.id}">${icon("package", 14)} 全部定稿发布</button>
      </div>` : ""}
    </div>`;
  },

  /* 结果卡 */
  results(m) {
    const b = batchById(m.payload.batchId);
    if (!b) return `<div class="ag-bubble agent">批次已不存在</div>`;
    const prods = batchProds(b);
    const done = prods.filter(p => p.stage === "delivered");
    return `<div class="ag-card">
      <div class="agc-head">${icon("checkCircle", 15)}<b>批次完成</b><span class="agc-state ok">${done.length}/${prods.length} 已交付</span></div>
      <div class="agres-grid">${done.map(p => {
        const acc = accountById(p.accountId);
        const imageItems = p.artifacts?.images?.items || [];
        const deliveryAsset = state.assets.find(asset => asset.id === p.delivery?.assetId);
        const coverAssetId = p.mode === "图文"
          ? imageItems.find(item => item.assetId)?.assetId
          : (p.artifacts?.boards?.cover?.assetId || deliveryAsset?.coverAssetId || "");
        const coverUrl = coverAssetId ? urlFor(coverAssetId) : "";
        const finalVideoUrl = p.mode === "视频"
          ? String(p.artifacts?.finalVideoUrl || deliveryAsset?.videoUrl || "").trim()
          : "";
        const media = coverUrl
          ? `<img src="${esc(coverUrl)}" alt="${p.mode === "视频" ? "视频封面" : "图文首图"}" loading="lazy" decoding="async"/>`
          : finalVideoUrl
            ? `<video src="${esc(finalVideoUrl)}" muted playsinline preload="metadata" aria-label="视频首帧"></video>`
            : `<i style="background:${gradFor(p.title)}"></i>`;
        return `<button class="agres-item" data-act="open-prod" data-pid="${p.id}">
          ${media}
          <b>${esc(p.artifacts.copy.title || p.title)}</b><em>${esc(acc?.name || "")} · ${esc(p.delivery?.name || "")}</em>
        </button>`;
      }).join("")}</div>
      <p class="agc-p">交付物已进入发布清单，供应商端可见可下载。</p>
    </div>`;
  },

  /* 错误卡 */
  error(m) {
    const b = batchById(m.payload.batchId);
    const prods = b ? batchProds(b).filter(p => p.stageStatus === "failed") : [];
    return `<div class="ag-card live" data-live="batch" data-batch="${b ? b.id : ""}">
      <div class="agc-head">${icon("alert", 15)}<b>有任务失败</b><span class="agc-state fail">${prods.length} 条</span></div>
      ${prods.map(p => {
        const acc = accountById(p.accountId);
        return `<div class="agn-row"><span class="dot" style="background:${gradFor(acc?.name || "")}"></span><b>${esc(acc?.name || "")}</b><em class="fail-text">${esc(p.error || "未知错误")}</em></div>`;
      }).join("")}
      ${b ? `<div class="agc-foot"><button class="btn primary sm" data-act="batch-retry" data-batch="${b.id}">${icon("refresh", 13)} 重试失败项</button></div>` : ""}
    </div>`;
  }
};

/* 看板任务行（右栏 Mission Board） */
export function boardRow(p) {
  const acc = accountById(p.accountId);
  const flow = flowOf(p);
  const curIdx = flow.indexOf(normalizeStage(p));
  const [label, cls] = statusPill(p);
  if (p.staticVideo) {
    const agent = p.staticAgent || {};
    const last = (agent.messages || []).at(-1);
    const coverAssetId = p.artifacts?.boards?.cover?.assetId || "";
    const coverUrl = coverAssetId ? urlFor(coverAssetId) : "";
    return `<div class="mb-row static-agent-row ${p.stageStatus === "running" ? "is-running" : ""}" data-act="open-prod" data-pid="${p.id}" role="button">
      ${coverUrl ? `<span class="mb-preview static-agent-cover"><img src="${esc(coverUrl)}" alt="静态视频封面"/></span>` : ""}
      <div class="mb-top">
        <span class="mb-type mat">静态</span>
        <b>${esc(acc?.name || "")}</b>
        <span class="status-pill ${cls}">${label}</span>
        <button class="mb-del" data-proddel="${p.id}" title="删除任务">${icon("x", 11)}</button>
      </div>
      <div class="mb-title">${esc(p.artifacts.copy.title || p.title || p.topic || "未命名")}</div>
      <div class="static-agent-board-mark ${p.stage === "delivered" ? "is-delivered" : p.stageStatus === "running" ? "is-running" : ""}">
        <span class="static-agent-board-icon" aria-hidden="true">${p.stage === "delivered" ? icon("checkCircle", 15) : agentAvatar(20, p.stageStatus === "running" ? "working" : p.stageStatus === "done" ? "success" : "normal")}</span>
        <b>${esc(p.stage === "delivered" ? "成片已交付" : last?.title || "静态视频 Agent 等待启动")}</b>
      </div>
      <div class="mb-actions"><button type="button" data-act="batch-cover-edit" data-pid="${p.id}">${icon("sliders", 10)} 封面</button><span>${icon("send", 10)} 对话修改</span></div>
    </div>`;
  }
  const dots = flow.map((st, i) => {
    let s = "idle";
    if (p.stage === "delivered" || i < curIdx || (i === curIdx && p.stageStatus === "done") || stageDone(p, st) && i <= curIdx) s = "done";
    if (i === curIdx && p.stage !== "delivered") {
      s = p.stageStatus === "failed" ? "fail" : p.stageStatus === "running" ? "run" : "cur";
    }
    return `<span class="mb-dot ${s}" title="${STAGES[st].label}"><i></i></span>`;
  }).join(`<span class="mb-link"></span>`);
  // 生成中的细进度
  let sub = "";
  if (p.stage === "images" && p.stageStatus === "running") {
    const items = p.artifacts.images.items || [];
    sub = `<span class="mb-sub">成图 ${items.filter(x => x.assetId).length}/${items.length || 0}</span>`;
  } else if ((p.stage === "render" || p.stage === "workshop") && p.stageStatus === "running") {
    const jobs = jobsOf(p);
    const ok = jobs.filter(j => j.status === "succeeded").length;
    const run = jobs.find(j => j.status === "running");
    sub = `<span class="mb-sub">渲染 ${ok}/${jobs.length}${run ? ` · ${run.progress}%` : ""}</span>`;
  } else if (p.stageStatus === "failed") {
    sub = `<span class="mb-sub fail-text">${esc((p.error || "失败").slice(0, 18))}</span>`;
  }
  const TYPE = p.mode === "图文" ? ["图文", "img"] : p.staticVideo ? ["静态", "mat"] : p.subType === "无数字人" ? ["素材", "mat"] : ["真人", "dh"];
  const previewAssetId = p.mode === "图文"
    ? p.artifacts.images?.items?.find(item => item.assetId)?.assetId
    : p.artifacts.boards?.cover?.assetId;
  const previewUrl = previewAssetId ? urlFor(previewAssetId) : "";
  return `<div class="mb-row ${p.stageStatus === "running" ? "is-running" : ""}" data-act="open-prod" data-pid="${p.id}" data-dropprod="${p.id}" role="button">
    ${previewUrl ? `<span class="mb-preview"><img src="${previewUrl}" alt="${p.mode === "图文" ? "首图" : "视频封面"}"/></span>` : ""}
    <div class="mb-top">
      <span class="mb-type ${TYPE[1]}">${esc(TYPE[0])}</span>
      <b>${esc(acc?.name || "")}</b>
      <span class="status-pill ${cls}">${label}</span>
      <button class="mb-del" data-proddel="${p.id}" title="删除任务">${icon("x", 11)}</button>
    </div>
    <div class="mb-title">${esc(p.artifacts.copy.title || p.title || p.topic || "未命名")}</div>
    <div class="mb-dots">${dots}${sub}</div>
    ${p.mode === "视频" && !p.staticVideo ? `<div class="mb-actions"><button type="button" data-act="batch-cover-edit" data-pid="${p.id}">${icon("sliders", 10)} 封面</button><button type="button" data-act="batch-video-regenerate" data-pid="${p.id}">${icon("refresh", 10)} 重生视频</button></div>` : ""}
  </div>`;
}
