/* Agent 对话的结构化消息卡片（对话即数据：卡片从 store 实时取数渲染） */

import { esc, gradFor, timeAgo } from "../core/util.js";
import { icon, agentAvatar } from "../ui/icons.js";
import { state, save, accountById, canDeliver } from "../core/store.js";
import { platChip, groupOf, tagsOf, TAG_POOL } from "../domain/accounts.js";
import { STAGES, flowOf, normalizeStage, stageDone, statusPill, jobsOf } from "../domain/productions.js";
import { batchById, batchProds, currentSessionBatches, selectAccountsForPlan } from "./orchestrator.js";
import { urlFor } from "../domain/assets.js";

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
  const group = /图文|笔记|小红书图/.test(goal) ? "图文组" : (goal.includes("真人") || goal.includes("数字人")) ? "真人" : (goal.includes("素材") || goal.includes("无数字人")) ? "素材" : p.group || "all";
  const explicitTags = TAG_POOL.filter(t =>
    goal.includes(t) ||
    goal.includes(t.slice(0, 2)) ||
    (t === "学生教培" && /学生党|学生|教培|学习|复习|校园/.test(goal)) ||
    (t === "职场效率" && /职场|办公|效率|打工|上班/.test(goal))
  );
  if (p.topic || p.topicMode !== "random") { p.topic = ""; p.topicMode = "random"; changed = true; }
  if (group !== p.group) { p.group = group; changed = true; }
  if (!explicitTags.length && (p.tags || []).length) { p.tags = []; changed = true; }
  else if (explicitTags.length && explicitTags.join("|") !== (p.tags || []).join("|")) { p.tags = explicitTags; changed = true; }
  const want = p.accountCount || zhCount(goal);
  if (/很久没发布|久未发布|长期没发|沉默|低活跃|不活跃|没更新/.test(goal)) { p.sort = "stale"; changed = true; }
  let matched = selectAccountsForPlan({ group: p.group, tags: p.tags || [], sort: p.sort || "", accountCount: want });
  const nextIds = matched.map(a => a.id);
  if (!(p.accountIds || []).length || (p.accountIds || []).some(id => !nextIds.includes(id))) { p.accountIds = nextIds; changed = true; }
  if (!p.perAccountCount) { p.perAccountCount = 1; changed = true; }
  return changed;
}

function imageAssets() {
  return state.assets.filter(a => a.type === "图片" && !a.delivered);
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

function refChips(ids = [], action, mid) {
  const list = ids.map(id => state.assets.find(a => a.id === id)).filter(Boolean);
  if (!list.length) return `<span class="muted">未设置</span>`;
  return list.map(a => `<span class="ref-chip dark">
    ${urlFor(a.id) ? `<img src="${urlFor(a.id)}"/>` : ""}
    <span>${esc(a.name || "参考图")}</span>
    ${action ? `<button class="ref-x" data-act="${action}" data-mid="${mid}" data-refid="${a.id}">${icon("x", 10)}</button>` : ""}
  </span>`).join("");
}

const CARD = {
  text(m) {
    return `<div class="ag-bubble agent">${esc(m.payload.text).replace(/\n/g, "<br/>")}</div>`;
  },

  /* 计划卡：确认前可改主题/风格/标签/选号 */
  plan(m) {
    const p = m.payload;
    if (normalizeSelectionPlan(p)) save("sessions");
    const matched = (p.accountIds || []).map(accountById).filter(Boolean);
    const confirmed = p.status === "confirmed";
    const cancelled = p.status === "cancelled";
    const perAccountCount = Math.max(1, Math.min(12, Number(p.perAccountCount || 1) || 1));
    const totalCount = matched.length * perAccountCount;
    const products = Array.isArray(state.products) && state.products.length ? state.products : [{ id: "dumate", name: "百度搭子", shortName: "搭子" }];
    const productOptions = (selected = "") => products.map(pr => `<option value="${esc(pr.id)}" ${selected === pr.id ? "selected" : ""}>${esc(pr.shortName || pr.name)}</option>`).join("");
    const globalRefs = selectedRefIds(p);
    const accountRefs = p.accountRefAssetIds || {};
    const perAccountOverrides = matched.length ? `<div class="agc-overrides">
      ${matched.map(a => `<div class="agc-override">
        <b>${esc(a.name)}</b>
        <select data-pacc-prod="${a.id}" ${confirmed || cancelled ? "disabled" : ""}>${productOptions((p.accountProductIds || {})[a.id] || p.productId || "dumate")}</select>
        <input data-pacc-content="${a.id}" value="${esc((p.accountContents || {})[a.id] || "")}" placeholder="本账号本次创作内容（可留空）" ${confirmed || cancelled ? "disabled" : ""} />
        <label class="agc-mini-ref ${confirmed || cancelled ? "" : "droppable"}" ${confirmed || cancelled ? "" : `data-plan-custom-refdrop="${m.id}" data-ref-account="${a.id}"`}>
          <span>定制参考图（最多3张）<em>可拖图到这里</em></span>
          <select multiple size="3" data-pacc-ref="${a.id}" ${confirmed || cancelled ? "disabled" : ""}>${refOptions(accountRefs[a.id] || [])}</select>
          ${confirmed || cancelled ? "" : `<span class="agc-mini-actions"><em>${refChips((accountRefs[a.id] || []).slice(0, 3), "plan-custom-refremove", m.id)}</em><label class="btn ghost sm">${icon("upload", 11)} 上传<input type="file" accept="image/*" multiple hidden data-pacc-ref-up="${a.id}" data-mid="${m.id}" /></label></span>`}
        </label>
      </div>`).join("")}
    </div>` : "";
    return `<div class="ag-card plan ${confirmed ? "resolved" : ""}" data-plan="${m.id}">
      <div class="agc-head">${icon("kanban", 15)}<b>量产任务板</b>
        <span class="agc-state ${confirmed ? "ok" : cancelled ? "off" : ""}">${confirmed ? "已执行" : cancelled ? "已取消" : "待确认"}</span>
      </div>
      <div class="agc-grid">
        <label class="agc-field">宣传产品
          <select data-pf="productId" ${confirmed || cancelled ? "disabled" : ""}>${productOptions(p.productId || "dumate")}</select>
        </label>
        <label class="agc-field">主题
          ${p.topicMode === "random"
            ? `<span class="agc-random">${icon("dice", 13)} 每号随机主题（AI 按各自定位出题）<button class="link-btn" data-act="plan-topicmode" data-mid="${m.id}" ${confirmed || cancelled ? "disabled" : ""}>改为固定</button></span>`
            : `<span class="agc-topicrow"><input data-pf="topic" value="${esc(p.topic || "")}" ${confirmed || cancelled ? "disabled" : ""} /><button class="link-btn" data-act="plan-topicmode" data-mid="${m.id}" ${confirmed || cancelled ? "disabled" : ""}>改为随机</button></span>`}
        </label>
        <label class="agc-field wide">总创作要求
          <textarea data-pf="content" rows="3" ${confirmed || cancelled ? "disabled" : ""} placeholder="写具体创作内容、产品角度或表达偏好；留空则每号按账号风格随机。">${esc(p.content || p.style || "")}</textarea>
          <em>默认沿用各账号自带风格，不再单独选择标签。</em>
        </label>
        <label class="agc-field">每号内容数
          <input type="number" min="1" max="12" data-pf="perAccountCount" value="${esc(perAccountCount)}" ${confirmed || cancelled ? "disabled" : ""} />
          <em>${matched.length} 个账号 × ${perAccountCount} 条 = ${totalCount} 条</em>
        </label>
      </div>
      ${(() => {
        const editable = !confirmed && !cancelled;
        return `<div class="agc-ref ${editable ? "droppable" : ""}" ${editable ? `data-plan-refdrop="${m.id}"` : ""}>
          <span class="agc-ref-l">${icon("star", 12)} 统一参考图<em>所有选中账号都会参考，最多5张；定制图每号最多3张，单独追加，不互相覆盖</em></span>
          <div class="agc-ref-chips">${refChips(globalRefs, editable ? "plan-refremove" : "", m.id)}</div>
          ${editable ? `<label class="btn ghost sm">${icon("upload", 12)} 上传<input type="file" accept="image/*" multiple hidden data-plan-ref="${m.id}" /></label>` : ""}
          ${editable ? `<label class="agc-ref-select">从资产选择
            <select multiple size="4" data-pf="sharedRefAssetIds">${refOptions(globalRefs)}</select>
          </label>` : ""}
          ${editable && globalRefs.length ? `<button class="link-btn" data-act="plan-refclear" data-mid="${m.id}">清空统一参考</button>` : ""}
        </div>`;
      })()}
      <div class="agc-sec">命中 ${matched.length} 个账号 · 每号 ${perAccountCount} 条 · 共 ${totalCount} 条 <em>点击可增减</em></div>
      <div class="agc-accs">${state.accounts.map(a => {
        const on = (p.accountIds || []).includes(a.id);
        return `<button class="agc-acc ${on ? "on" : ""}" data-pacc="${a.id}" ${confirmed || cancelled ? "disabled" : ""}>
          <span class="dot" style="background:${gradFor(a.name)}"></span>
          <b>${esc(a.name)}</b><em>${groupOf(a)}${tagsOf(a).length ? " · " + tagsOf(a).slice(0, 2).join("/") : ""}</em>
          ${on ? icon("check", 13, "ok") : ""}
        </button>`;
      }).join("")}</div>
      ${perAccountOverrides}
      ${confirmed || cancelled ? "" : `<div class="agc-foot">
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
    const c = { draft: 0, wait: 0, gen: 0, review: 0, done: 0, fail: 0 };
    prods.forEach(p => {
      if (p.stageStatus === "failed") c.fail++;
      else if (p.stage === "delivered") c.done++;
      else if (p.stage === "review") c.review++;
      else if (p.stage === "render" || p.stage === "workshop" || (p.stage === "images" && p.stageStatus === "running")) c.gen++;
      else if (p.stageStatus === "needs_input") c.wait++;
      else c.draft++;
    });
    const pct = prods.length ? Math.round(c.done / prods.length * 100) : 0;
    const PHASE = { drafting: "批量起草中", awaiting_input: "等待上传", generating: "生成中", review: "待发布", done: "已完成" };
    return `<div class="ag-card live" data-live="batch" data-batch="${b.id}">
      <div class="agc-head">${icon("pulse", 15)}<b>「${esc(b.topic)}」</b><span class="agc-state run">${PHASE[b.phase] || b.phase}</span></div>
      <div class="agp-bar"><i style="width:${pct}%"></i></div>
      <div class="agp-segs">
        ${seg("起草", c.draft, "draft")}${seg("待上传", c.wait, "wait")}${seg("生成", c.gen, "gen")}${seg("待审", c.review, "review")}${seg("已交付", c.done, "done")}${seg("失败", c.fail, "fail")}
      </div>
    </div>`;
  },

  /* 等待上传卡：内嵌拖拽热区 + 缺口列表 */
  need_input(m) {
    const b = batchById(m.payload.batchId);
    if (!b) return `<div class="ag-bubble agent">批次已不存在</div>`;
    const prods = batchProds(b);
    if (m.payload.mode === "confirm_generate") {
      const ready = prods.filter(p => p.stage === "render" && p.stageStatus !== "running").length;
      return `<div class="ag-card live" data-live="batch" data-batch="${b.id}">
        <div class="agc-head">${icon("film", 15)}<b>分镜全部就位</b></div>
        <p class="agc-p">自动推进已关闭。${ready} 条视频就绪，确认后开始批量渲染（并发 2）。</p>
        <div class="agc-foot"><button class="btn primary sm" data-act="batch-generate" data-batch="${b.id}">${icon("play", 13)} 开始批量生成</button></div>
      </div>`;
    }
    const waiting = prods.filter(p => p.stageStatus === "needs_input");
    const rows = waiting.map(p => {
      const items = (p.mode === "图文" ? p.artifacts.images.items : p.artifacts.boards.items) || [];
      const got = items.filter(x => x.assetId).length;
      const acc = accountById(p.accountId);
      return `<div class="agn-row">
        <span class="dot" style="background:${gradFor(acc?.name || "")}"></span>
        <b>${esc(acc?.name || "")}</b>
        <span class="agn-bar"><i style="width:${items.length ? got / items.length * 100 : 0}%"></i></span>
        <em>${got}/${items.length}</em>
        <button class="link-btn" data-act="copy-external" data-pid="${p.id}">复制提示词</button>
        <button class="link-btn" data-act="open-prod" data-pid="${p.id}">详情</button>
      </div>`;
    }).join("");
    return `<div class="ag-card live" data-live="batch" data-batch="${b.id}">
      <div class="agc-head">${icon("upload", 15)}<b>等待补图 / 上传</b><span class="agc-state wait">${waiting.length} 条任务</span></div>
      <p class="agc-p">站内生成失败或你选择站外出图时，把图片<b>直接拖进下面这块区域</b>（或拖到输入框），我会按顺序分发到各任务，全部就位后${b.autoAdvance ? "自动" : "等你确认再"}继续。</p>
      ${rows ? `<div class="agn-list">${rows}</div>` : `<div class="agc-p ok">${icon("checkCircle", 14)} 已全部上传完成</div>`}
      ${waiting.length ? `<div class="ag-drop" data-agdrop="${b.id}">
        <span class="agd-rings"><i></i><i></i></span>
        ${icon("upload", 18)}
        <b>拖图到这里 · 自动按缺口分发</b>
        <em>也可以点击选择（可多选）</em>
        <input type="file" accept="image/*" multiple hidden data-agdrop-input="${b.id}" />
      </div>` : ""}
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
      const cover = items.find(x => x.assetId);
      const coverUrl = cover ? urlFor(cover.assetId) : null;
      return `<div class="agr-row">
        <span class="agr-cover">${coverUrl ? `<img src="${coverUrl}"/>` : `<i style="background:${gradFor(p.title)}">${p.mode === "图文" ? "图" : "片"}</i>`}</span>
        <span class="agr-main"><b>${esc(p.artifacts.copy.title || p.title || p.topic)}</b><em>${esc(acc?.name || "")} · ${p.mode}</em></span>
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
        const items = (p.mode === "图文" ? p.artifacts.images.items : p.artifacts.boards.items) || [];
        const cover = items.find(x => x.assetId);
        const u = cover ? urlFor(cover.assetId) : null;
        return `<button class="agres-item" data-act="open-prod" data-pid="${p.id}">
          ${u ? `<img src="${u}"/>` : `<i style="background:${gradFor(p.title)}"></i>`}
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
  const dots = flow.map((st, i) => {
    let s = "idle";
    if (p.stage === "delivered" || i < curIdx || (i === curIdx && p.stageStatus === "done") || stageDone(p, st) && i <= curIdx) s = "done";
    if (i === curIdx && p.stage !== "delivered") {
      s = p.stageStatus === "failed" ? "fail" : p.stageStatus === "running" ? "run" : p.stageStatus === "needs_input" ? "wait" : "cur";
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
  } else if (p.stageStatus === "needs_input") {
    const items = (p.mode === "图文" ? p.artifacts.images.items : p.artifacts.boards.items) || [];
    sub = `<span class="mb-sub">上传 ${items.filter(x => x.assetId).length}/${items.length}</span>`;
  } else if (p.stageStatus === "failed") {
    sub = `<span class="mb-sub fail-text">${esc((p.error || "失败").slice(0, 18))}</span>`;
  }
  const TYPE = p.mode === "图文" ? ["图文", "img"] : p.subType === "无数字人" ? ["素材", "mat"] : ["真人", "dh"];
  return `<div class="mb-row" data-act="open-prod" data-pid="${p.id}" data-dropprod="${p.id}" role="button">
    <div class="mb-top">
      <span class="mb-type ${TYPE[1]}">${esc(TYPE[0])}</span>
      <b>${esc(acc?.name || "")}</b>
      <span class="status-pill ${cls}">${label}</span>
      <button class="mb-del" data-proddel="${p.id}" title="删除任务">${icon("x", 11)}</button>
    </div>
    <div class="mb-title">${esc(p.artifacts.copy.title || p.title || p.topic || "未命名")}</div>
    <div class="mb-dots">${dots}${sub}</div>
  </div>`;
}
