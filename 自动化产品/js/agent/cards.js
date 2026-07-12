/* Agent 对话的结构化消息卡片（对话即数据：卡片从 store 实时取数渲染） */

import { esc, gradFor, timeAgo } from "../core/util.js";
import { icon, agentAvatar } from "../ui/icons.js";
import { state, save, accountById, canDeliver, ownedBy } from "../core/store.js";
import { platChip, groupOf, tagsOf, TAG_POOL } from "../domain/accounts.js";
import { STAGES, flowOf, normalizeStage, stageDone, statusPill, jobsOf } from "../domain/productions.js";
import { batchById, batchProds, currentSessionBatches, selectAccountsForPlan } from "./orchestrator.js";
import { urlFor } from "../domain/assets.js";

const DEFAULT_XHS_IMAGE_COUNT = 4;
const CONTENT_KIND_GROUP = { image: "图文组", material: "素材", real: "真人" };
const CONTENT_KIND_LABEL = { image: "图文", material: "素材视频", real: "真人视频" };

function kindFromGroup(group = "") {
  if (group === "素材") return "material";
  if (group === "真人") return "real";
  return "image";
}

function normalizePlanKind(p) {
  p.creativeMode = "custom";
  p.contentKind = ["image", "material", "real"].includes(p.contentKind) ? p.contentKind : kindFromGroup(p.group);
  p.group = CONTENT_KIND_GROUP[p.contentKind] || "图文组";
  if (p.creativeMode === "custom") {
    p.content = "";
    p.topic = "";
    p.topicMode = "fixed";
    p.perAccountCount = 1;
    p.accountCounts = {};
  }
  const match = a => {
    const g = groupOf(a);
    if (p.contentKind === "image") return a?.mode === "图文" || g === "图文组";
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

function tagMatches(goal, tag) {
  if (goal.includes(tag)) return true;
  if (tag === "学生教培") return /学生党|学生|教培|学习|复习|校园/.test(goal);
  if (tag === "职场效率") return /职场|办公|效率|打工|上班/.test(goal);
  if (tag === "创作者") return /自媒体|创作者|博主|内容号|创作号|OPC|个人IP/.test(goal);
  if (tag === "产品功能") return /产品功能|功能教程|产品教程|工具教程|功能演示/.test(goal);
  if (tag === "家庭管理") return /家庭|家务|居家|亲子/.test(goal);
  if (tag === "岗位垂类") return /岗位|运营|财务|法务|销售|人事|HR|设计|教师/.test(goal);
  if (tag === "测评中立") return /测评|对比|横评|中立|避坑/.test(goal);
  return false;
}

function normalizeSelectionPlan(p) {
  if (!p || p.status !== "pending" || !isPureAccountSelectionText(p.goal || "")) return false;
  let changed = false;
  const goal = p.goal || "";
  const tailPick = /(?:最后|后|倒数|末尾)\s*([0-9]+|[两一二三四五六七八九十]+)\s*(个|只|家)?\s*(账号|号|图文|图文号|图文账号|素材号|真人号|数字人号)?/.test(goal);
  if (tailPick && p.pickFrom !== "end") { p.pickFrom = "end"; changed = true; }
  const lockedGroup = CONTENT_KIND_GROUP[p.contentKind || ""];
  const group = lockedGroup || (/图文|笔记|小红书图/.test(goal) ? "图文组" : (goal.includes("真人") || goal.includes("数字人")) ? "真人" : (goal.includes("素材") || goal.includes("无数字人")) ? "素材" : p.group || "all");
  const explicitTags = TAG_POOL.filter(t => tagMatches(goal, t));
  if (p.topic || p.topicMode !== "fixed") { p.topic = ""; p.topicMode = "fixed"; changed = true; }
  if (group !== p.group) { p.group = group; changed = true; }
  if (!explicitTags.length && (p.tags || []).length) { p.tags = []; changed = true; }
  else if (explicitTags.length && explicitTags.join("|") !== (p.tags || []).join("|")) { p.tags = explicitTags; changed = true; }
  const want = p.accountCount || zhCount(goal);
  if (/很久没发布|久未发布|长期没发|沉默|低活跃|不活跃|没更新/.test(goal)) { p.sort = "stale"; changed = true; }
  if (!p.manualAccountSelection) {
    let matched = selectAccountsForPlan({ group: p.group, tags: p.tags || [], sort: p.sort || "", pickFrom: p.pickFrom || "", accountCount: want });
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
    .filter(a => a.type === "图片" && !a.delivered && (a.shared || ownedBy(a)))
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
    const beforePlan = JSON.stringify({ creativeMode: p.creativeMode, contentKind: p.contentKind, group: p.group, accountIds: p.accountIds, perAccountCount: p.perAccountCount, content: p.content, topic: p.topic });
    const accountMatchesCurrentKind = normalizePlanKind(p);
    const normalized = normalizeSelectionPlan(p);
    if (normalized || beforePlan !== JSON.stringify({ creativeMode: p.creativeMode, contentKind: p.contentKind, group: p.group, accountIds: p.accountIds, perAccountCount: p.perAccountCount, content: p.content, topic: p.topic })) save("sessions");
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
    const isImageAcc = a => a?.mode === "图文" || groupOf(a) === "图文组";
    const customMode = true;
    const isImageKind = p.contentKind === "image";
    const isMaterialKind = p.contentKind === "material";
    const isRealKind = p.contentKind === "real";
    const globalRefs = selectedRefIds(p);
    const coverRefs = selectedRefIds(p, "coverRefAssetIds");
    const accountRefs = p.accountRefAssetIds || {};
    const accountPool = (state.accounts || []).filter(Boolean).filter(accountMatchesCurrentKind);
    const kindBtn = (kind, label) => `<button type="button" class="agc-seg ${p.contentKind === kind ? "is-active" : ""}" data-pf-kind="${kind}" ${locked ? "disabled" : ""}>${label}</button>`;
    const perAccountOverrides = matched.length ? `<div class="agc-overrides">
      ${matched.map(a => {
        const imgAcc = isImageAcc(a);
        const customCopyMode = customMode;
        const customCopyTitle = ((p.accountCopyTitles || {})[a.id] || "").trim();
        const customCopyBody = ((p.accountCopyBodies || {})[a.id] || "").trim();
        const copyFields = `<div class="agc-copy-fields ${customCopyMode ? "is-custom" : ""}">
          <div class="agc-account-copy">
            <input data-pacc-copy-title="${a.id}" value="${esc(customCopyTitle)}" placeholder="必填标题" ${locked ? "disabled" : ""} />
            <textarea data-pacc-copy-body="${a.id}" rows="2" placeholder="${imgAcc ? "文案正文；只写标题也可以由模型补全文案" : "文案正文；真人号会转成更长口播，素材号会转成 B 面提示词"}" ${locked ? "disabled" : ""}>${esc(customCopyBody)}</textarea>
          </div>
        </div>`;
        return `<div class="agc-override ${imgAcc ? "is-image" : "is-video"} ${customMode ? "is-custom-plan" : ""}" ${locked ? "" : `data-plan-custom-refdrop="${m.id}" data-ref-account="${a.id}"`}>
        <div class="agc-override-name"><b>${esc(a.name)}</b><span>${esc(groupOf(a))} · ${esc(a.platform || a.mode || "账号")}</span></div>
        ${locked ? "" : `<div class="agc-override-actions">
          <button data-act="plan-asset-pick" data-mid="${m.id}" data-ref-kind="custom" data-ref-account="${a.id}">${icon("image", 11)} 从资产选择</button>
          <button data-act="plan-remove-account" data-mid="${m.id}" data-account="${a.id}">${icon("x", 10)} 取消选择</button>
        </div>`}
        ${customMode ? "" : `<label class="agc-mini-count">本号条数<input type="number" min="1" max="12" data-pacc-count="${a.id}" value="${esc(countFor(a.id))}" ${locked ? "disabled" : ""} /></label>`}
        ${imgAcc ? `<label class="agc-mini-count img-count">每条图数<input type="number" min="1" max="12" data-pacc-imgcount="${a.id}" value="${esc(imageCountFor(a.id))}" ${locked ? "disabled" : ""} /></label>` : (customMode ? "" : `<span class="agc-video-chain" title="口播 / 数字人 / 混剪">${icon("video", 12)} 视频</span>`) }
        ${copyFields}
        <div class="agc-mini-ref">
          <div class="agc-mini-head"><span>定制参考图</span><em>最多3张</em></div>
          <div class="agc-ref-chips mini" data-ref-account="${a.id}">${refChips((accountRefs[a.id] || []).slice(0, 3), locked ? "" : "plan-custom-refremove", m.id, a.id)}</div>
          ${locked ? "" : `<input type="file" accept="image/*" multiple hidden data-pacc-ref-up="${a.id}" data-mid="${m.id}" />`}
        </div>
      </div>`;
      }).join("")}
    </div>` : "";
    return `<div class="ag-card plan ${confirmed ? "resolved" : ""}" data-plan="${m.id}">
      <div class="agc-head">${icon("kanban", 15)}<b>量产任务板</b>
        <div class="agc-modebar">
          <span class="agc-seg-group">${kindBtn("image", "图文")}${kindBtn("material", "素材视频")}${kindBtn("real", "真人视频")}</span>
        </div>
        <span class="agc-state ${confirmed ? "ok" : cancelled ? "off" : starting ? "busy" : ""}">${confirmed ? "已执行" : cancelled ? "已取消" : starting ? "启动中" : "待确认"}</span>
      </div>
      <div class="agc-custom-hint">${icon("spark", 13)} ${esc(CONTENT_KIND_LABEL[p.contentKind])} · 逐个账号填写标题和文案；产品库仅提供事实与视觉参考，不决定创作内容。</div>
      ${(() => {
        const editable = !locked;
        const refKind = isImageKind ? "shared" : "cover";
        const refIds = isImageKind ? globalRefs : coverRefs;
        const removeAct = isImageKind ? "plan-refremove" : "plan-cover-refremove";
        const clearAct = isImageKind ? "plan-refclear" : "plan-cover-refclear";
        const dropAttr = isImageKind ? `data-plan-refdrop="${m.id}"` : `data-plan-cover-refdrop="${m.id}"`;
        const inputAttr = isImageKind ? `data-plan-ref="${m.id}"` : `data-plan-cover-ref="${m.id}"`;
        const refTitle = isImageKind ? "统一参考图" : isMaterialKind ? "统一素材视频参考" : "统一真人视频封面参考";
        const refDesc = isImageKind
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
          <button class="agc-random-pick" data-act="plan-select-all" data-mid="${m.id}">${accountPool.length > 0 && accountPool.every(a => (p.accountIds || []).includes(a.id)) ? "取消全选" : "全选"}</button>
          <button class="agc-random-pick" data-act="plan-random-accounts" data-mid="${m.id}" title="随机选择最多10个账号">${icon("dice", 13)} 随机选 ≤10</button>
        </span>`}
      </div>
      <div class="agc-accs">${accountPool.map((a, idx) => {
        const on = (p.accountIds || []).includes(a.id);
        const imgAcc = isImageAcc(a);
        return `<button class="agc-acc ${on ? "on" : ""} ${imgAcc ? "is-image" : "is-video"}" data-pacc="${a.id}" ${locked ? "disabled" : ""}>
          <span class="agc-idx">#${String(idx + 1).padStart(2, "0")}</span>
          <b>${esc(a.name)}</b><em>${groupOf(a)}${tagsOf(a).length ? " · " + tagsOf(a).slice(0, 2).join("/") : ""}</em>
          ${on ? icon("check", 13, "ok") : ""}
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
        <button class="link-btn" data-act="open-prod" data-pid="${p.id}">详情</button>
      </div>`;
    }).join("");
    return `<div class="ag-card live" data-live="batch" data-batch="${b.id}">
      <div class="agc-head">${icon("upload", 15)}<b>等待补图 / 上传</b><span class="agc-state wait">${waiting.length} 条任务</span></div>
      <p class="agc-p">站内生成失败或需要人工补图时，把图片<b>直接拖进下面这块区域</b>（或拖到输入框），我会按顺序分发到各任务，全部就位后${b.autoAdvance ? "自动" : "等你确认再"}继续。</p>
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
  return `<div class="mb-row ${p.stageStatus === "running" ? "is-running" : ""}" data-act="open-prod" data-pid="${p.id}" data-dropprod="${p.id}" role="button">
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
