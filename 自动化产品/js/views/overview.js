/* 首页：待办导向 + 底部数据问答（只读数据助手，不执行操作） */

import { $, $$, esc, gradFor, timeAgo } from "../core/util.js";
import { icon, agentAvatar } from "../ui/icons.js";
import { state, save, accountById, ownedBy, assetById } from "../core/store.js";
import { platChip, groupOf } from "../domain/accounts.js";
import { STAGES, statusPill } from "../domain/productions.js";
import { deliveredAssets } from "../domain/delivery.js";
import { urlFor } from "../domain/assets.js";
import { AI } from "../api/ai.js";
import { LLM_CONFIG } from "../api/llm.js";
import { openProductionDrawer } from "./prodDrawer.js";
import { emptyState } from "../ui/components.js";
import { go } from "../core/router.js";
import { renderSupplierOverview } from "./supplierViews.js";

/* ---------- 数据问答（会话仅存内存，问的是库里的真实数据） ---------- */
let chatLog = [];   // {role:"user"|"agent", text}
let chatBusy = false;

const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const safeAccount = a => ({
  ...(a || {}),
  id: (a && a.id) || "",
  name: (a && a.name) || "未命名账号",
  platform: (a && a.platform) || "小红书",
  mode: (a && a.mode) || "图文",
  subType: (a && a.subType) || "",
  styleProfile: (a && a.styleProfile) || "",
  monthlyDone: (a && a.monthlyDone) || 0
});
const safeGroup = a => {
  try { return groupOf(safeAccount(a)); } catch (e) { return "未分组"; }
};
const safeChip = (platform, sm = true) => {
  try { return platChip(platform || "小红书", sm); } catch (e) { return `<span class="plat-chip sm">小红书</span>`; }
};
const visibleWorkProductions = () => state.productions.filter(p => p.stage === "delivered" || ownedBy(p));
const visiblePrivateAssets = () => state.assets.filter(a => !a.delivered && !a.shared && ownedBy(a));

function computeStats() {
  const today = dayKey(Date.now());
  const yest = dayKey(Date.now() - 864e5);
  const delivered = state.assets.filter(a => a.delivered);
  const privateAssets = visiblePrivateAssets();
  const visibleProds = visibleWorkProductions();
  const visibleProdIds = new Set(visibleProds.map(p => p.id));
  const stageCount = {};
  visibleProds.forEach(p => {
    const k = p.stage === "delivered" ? "已交付" : (STAGES[p.stage] || {}).label || p.stage;
    stageCount[k] = (stageCount[k] || 0) + 1;
  });
  const assetsToday = privateAssets.filter(a => dayKey(a.createdAt) === today).length;
  const assetsYest = privateAssets.filter(a => dayKey(a.createdAt) === yest).length;
  return {
    日期: { 今天: today, 昨天: yest },
    账号: state.accounts.filter(Boolean).map(a => {
      const acc = safeAccount(a);
      return { 名称: acc.name, 平台: acc.platform, 分组: safeGroup(acc), 本月交付: acc.monthlyDone || 0 };
    }),
    任务阶段分布: stageCount,
    待审核: visibleProds.filter(p => p.stage === "review" && p.stageStatus !== "failed").length,
    失败任务: visibleProds.filter(p => p.stageStatus === "failed").length,
    交付: {
      总数: delivered.length,
      今天交付: delivered.filter(a => dayKey(a.createdAt) === today).length,
      昨天交付: delivered.filter(a => dayKey(a.createdAt) === yest).length,
      已下载: delivered.filter(a => a.status === "已下载" || a.status === "已发布").length,
      未下载: delivered.filter(a => !a.status || a.status === "未下载").length,
      已上传发布链接: delivered.filter(a => a.publishedUrl).length,
      最新5条: delivered.slice(0, 5).map(a => ({ 名称: a.name, 标题: a.title, 状态: a.status, 链接: a.publishedUrl || "" }))
    },
    素材入库: { 今天: assetsToday, 昨天: assetsYest },
    渲染任务: {
      成功: state.jobs.filter(j => visibleProdIds.has(j.productionId) && j.status === "succeeded").length,
      失败: state.jobs.filter(j => visibleProdIds.has(j.productionId) && j.status === "failed").length,
      进行中: state.jobs.filter(j => visibleProdIds.has(j.productionId) && ["queued", "submitted", "running"].includes(j.status)).length
    }
  };
}

/* 离线规则问答（无 LLM Key 时兜底，常见问题直接算） */
function offlineAnswer(q, s) {
  if (/下载|领取/.test(q)) return `已交付 ${s.交付.总数} 个素材：已下载 ${s.交付.已下载} 个、未下载 ${s.交付.未下载} 个${s.交付.已上传发布链接 ? `，其中 ${s.交付.已上传发布链接} 个已上传发布链接` : ""}。`;
  if (/(昨天|今天).*(产出|素材|交付|多少)/.test(q) || /(产出|交付).*(昨天|今天)/.test(q)) {
    return `今天交付 ${s.交付.今天交付} 条、入库素材 ${s.素材入库.今天} 个；昨天交付 ${s.交付.昨天交付} 条、入库素材 ${s.素材入库.昨天} 个。`;
  }
  if (/产量|最高|最多|哪个账号/.test(q)) {
    const top = [...s.账号].sort((a, b) => b.本月交付 - a.本月交付).slice(0, 3);
    return top[0] ? `本月产量前三：${top.map(a => `${a.名称}（${a.本月交付} 条）`).join("、")}。` : "还没有交付记录。";
  }
  if (/审核/.test(q)) return `当前 ${s.待审核} 条内容等待审核${s.失败任务 ? `，另有 ${s.失败任务} 条任务失败待重试` : ""}。`;
  if (/发布|链接|上传/.test(q)) return `供应商已上传发布链接 ${s.交付.已上传发布链接} 条（共交付 ${s.交付.总数} 条）。`;
  if (/失败|出错/.test(q)) return `失败任务 ${s.失败任务} 条；渲染层面：成功 ${s.渲染任务.成功}、失败 ${s.渲染任务.失败}、进行中 ${s.渲染任务.进行中}。`;
  return `当前共 ${s.账号.length} 个账号；任务分布：${Object.entries(s.任务阶段分布).map(([k, v]) => `${k} ${v}`).join("、") || "暂无任务"}；累计交付 ${s.交付.总数} 条（已下载 ${s.交付.已下载}）。可以问我：昨天产出多少素材？供应商下载了多少？哪个账号产量最高？`;
}

async function askData(q) {
  const stats = computeStats();
  if (!LLM_CONFIG.apiKey) return offlineAnswer(q, stats);
  try {
    const r = await AI.chat([
      { role: "system", content: `你是星阵内容工作台的数据助理，只负责"读数据回答问题"，绝不执行任何操作。只能依据下面这份 JSON 数据回答，数字必须与数据一致，数据里没有的就直说没有。回答用简洁中文，最多 3 行，不用 markdown。\n数据：${JSON.stringify(stats)}` },
      { role: "user", content: q }
    ]);
    return (r || "").trim() || offlineAnswer(q, stats);
  } catch (e) {
    return offlineAnswer(q, stats);
  }
}

const CHAT_SUGS = ["昨天产出了多少素材？", "供应商下载了多少？", "哪个账号本月产量最高？", "还有多少在等审核？"];

function firstAccountImage(accountId) {
  return [...state.assets]
    .filter(a => a.accountId === accountId && a.type === "图片" && !a.delivered)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .find(a => urlFor(a)) || null;
}

function realDeliveryThumb(asset, acc) {
  const packCover = (asset.packAssetIds || []).map(id => assetById(id)).find(a => a && urlFor(a));
  const avatar = acc?.avatarAssetId ? assetById(acc.avatarAssetId) : null;
  const avatarCover = avatar && urlFor(avatar) ? avatar : null;
  const firstImage = firstAccountImage(asset.accountId);
  const cover = packCover || avatarCover || firstImage;
  const u = cover ? urlFor(cover) : "";
  if (u) return `<span class="ovr-cover real"><img src="${esc(u)}" alt="${esc(asset.title || acc?.name || "交付封面")}"/></span>`;
  return `<span class="ovr-cover fallback" style="background:${gradFor(asset.name)}">${asset.type === "图集" ? icon("image", 14) : icon("play", 14)}</span>`;
}

/* ---------- 视图 ---------- */
export const overviewView = {
  render(root) {
    if (["supplier", "supplier_parent"].includes(state.role)) { renderSupplierOverview(root); return; }
    const accounts = state.accounts.filter(Boolean).map(safeAccount);
    const prods = state.productions.filter(ownedBy);
    const inflight = prods.filter(p => p.stage !== "delivered");
    const waiting = inflight.filter(p => p.stageStatus === "needs_input");
    const rendering = inflight.filter(p => (p.stage === "render" || p.stage === "workshop") && p.stageStatus === "running");
    const inReview = inflight.filter(p => p.stage === "review");
    const failed = inflight.filter(p => p.stageStatus === "failed");
    const monthly = accounts.reduce((s, a) => s + (a.monthlyDone || 0), 0);
    const delivered = deliveredAssets();
    const pendingDl = delivered.filter(x => !x.asset.status || x.asset.status === "未下载").length;

    const stat = (label, n, sub, zone, accent = "") => `
      <button class="ov-stat card ${accent}" data-ov-go="${zone}">
        <b>${n}</b><span>${label}</span><em>${sub}</em>
      </button>`;

    root.innerHTML = `
      <div class="overview">
        <div class="ov-hero card">
          <div class="ovh-left">
            <div class="eyebrow">星阵 · 内容生产工作台</div>
            <h2>${greeting()}，今天从这里开始</h2>
            <p>${accounts.length} 个账号 · ${inflight.length} 条在制 · 本月已交付 ${monthly} 条</p>
          </div>
          <div class="ovh-right">
            <section class="ov-chat ov-chat-mini" id="ovChat">
              <div class="ovc-head">
                <span class="ovc-ava">${agentAvatar(24)}</span>
                <div><b>数据问答</b><em>只读真实数据</em></div>
              </div>
              <div class="ovc-msgs" id="ovcMsgs"></div>
              <div class="ovc-input">
                <input id="ovcInput" placeholder="问问数据：昨天产出多少素材？" />
                <button class="ovc-send" id="ovcSend" title="发送">${icon("send", 15)}</button>
              </div>
            </section>
          </div>
        </div>

        <div class="ov-stats">
          ${stat("等待上传", waiting.length, "上传补图后继续", "agent", waiting.length ? "warn" : "")}
          ${stat("生成中", rendering.length, "文案分镜 / 渲染", "agent", rendering.length ? "run" : "")}
          ${stat("待审核", inReview.length, "人工确认后交付", "agent", inReview.length ? "review" : "")}
          ${stat("失败待重试", failed.length, "一键重试", "agent", failed.length ? "fail" : "")}
          ${stat("供应商待下载", pendingDl, "发布清单可批量下载", "delivery", "")}
        </div>

        <div class="ov-cols">
          <section class="card ov-todo">
            <div class="card-head"><b>待你处理</b><em>${waiting.length + inReview.length + failed.length} 项</em></div>
            ${(waiting.length + inReview.length + failed.length) ? `
            <div class="ov-todo-list ov-scroll">
              ${[...inReview, ...waiting, ...failed].map(p => {
                const acc = accountById(p.accountId);
                const [label, cls] = statusPill(p);
                return `<button class="ovt-row" data-prod="${p.id}">
                  <span class="dot" style="background:${gradFor(acc?.name || "")}"></span>
                  <span class="ovt-main"><b>${esc(p.artifacts.copy.title || p.title || p.topic || "未命名")}</b><em>${esc(acc?.name || "")} · ${(STAGES[p.stage] || {}).label || ""}</em></span>
                  <span class="status-pill ${cls}">${label}</span>
                </button>`;
              }).join("")}
            </div>` : emptyState("checkCircle", "没有待办", "需要人工介入的任务会出现在这里")}
          </section>

          <section class="card ov-recent">
            <div class="card-head"><b>最新交付</b><button class="link-btn" data-ov-go="delivery">发布清单 ${icon("arrowRight", 12)}</button></div>
            ${delivered.length ? `<div class="ov-recent-list ov-scroll">
              ${delivered.slice(0, 20).map(({ asset, acc }) => `
                <div class="ovr-row" ${asset.productionId ? `data-prod="${asset.productionId}"` : ""}>
                  ${realDeliveryThumb(asset, acc)}
                  <span class="ovt-main"><b>${esc(asset.title || asset.name)}</b><em>${esc(acc.name)} · ${asset.publishedUrl ? "已发布 ✓" : asset.status || "未下载"}${asset.supplierNote ? ` · 备注：${esc(asset.supplierNote)}` : ""}</em></span>
                  ${safeChip(acc?.platform, true)}
                  <time>${timeAgo(asset.createdAt)}</time>
                </div>`).join("")}
            </div>` : emptyState("package", "还没有交付记录", "完成创作并审核交付后会汇总在这里")}
          </section>
        </div>
      </div>`;

    root.querySelectorAll("[data-ov-go]").forEach(b => b.addEventListener("click", () => go(b.dataset.ovGo)));
    root.querySelectorAll("[data-prod]").forEach(b => b.addEventListener("click", () => openProductionDrawer(b.dataset.prod)));
    root.querySelectorAll("[data-acc]").forEach(b => b.addEventListener("click", () => {
      state.ui.activeAccountId = b.dataset.acc; save("meta");
      go("studio");
    }));
    /* 数据问答 */
    const msgsEl = $("#ovcMsgs", root);
    const inputEl = $("#ovcInput", root);
    const drawChat = () => {
      msgsEl.innerHTML = chatLog.length
        ? chatLog.map(m => `<div class="ovc-bubble ${m.role}">${esc(m.text).replace(/\n/g, "<br/>")}</div>`).join("") + (chatBusy ? `<div class="ovc-bubble agent typing"><i></i><i></i><i></i></div>` : "")
        : `<div class="ovc-sugs">${CHAT_SUGS.map(q => `<button class="chip" data-ovq="${esc(q)}">${esc(q)}</button>`).join("")}</div>`;
      msgsEl.scrollTop = msgsEl.scrollHeight;
      msgsEl.querySelectorAll("[data-ovq]").forEach(b => b.addEventListener("click", () => { inputEl.value = b.dataset.ovq; send(); }));
    };
    const send = async () => {
      const q = inputEl.value.trim();
      if (!q || chatBusy) return;
      inputEl.value = "";
      chatLog.push({ role: "user", text: q });
      if (chatLog.length > 20) chatLog = chatLog.slice(-20);
      chatBusy = true;
      drawChat();
      const a = await askData(q);
      chatBusy = false;
      chatLog.push({ role: "agent", text: a });
      drawChat();
    };
    $("#ovcSend", root).addEventListener("click", send);
    inputEl.addEventListener("keydown", e => { if (e.key === "Enter") send(); });
    drawChat();
  }
};

function greeting() {
  const h = new Date().getHours();
  return h < 6 ? "夜深了" : h < 12 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
}
