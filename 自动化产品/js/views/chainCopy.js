/* 链路 · 文案页 + 审核页 */

import { $, $$, esc, gradFor } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { save, accountById, canDeliver, productById } from "../core/store.js";
import { AI } from "../api/ai.js";
import { setStage } from "../domain/productions.js";
import { urlFor } from "../domain/assets.js";
import { deliver } from "../domain/delivery.js";
import { toast, withLoading, confirmModal, openLightbox, publishModal } from "../ui/components.js";
import { go } from "../core/router.js";
import { stepperHtml, wireStepper } from "./studio.js";
import { reviewPreviewHtml } from "./prodDrawer.js";

export function renderCopyPage(root, p) {
  const acc = accountById(p.accountId);
  const isImg = p.mode === "图文";
  const C = p.artifacts.copy;

  root.innerHTML = `
    ${stepperHtml(p, "copy")}
    <div class="chain-page">
      <div class="chain-main">
        <div class="page-head">
          <div><div class="eyebrow">${isImg ? "图文链路 · 文案" : "视频链路 · 文案"}</div>
          <h2>${isImg ? "按图卡生成爆款笔记文案" : "按口播内容生成标题与简介"}</h2></div>
          <button class="btn primary" id="ccNext">提交审核 ${icon("arrowRight", 14)}</button>
        </div>
        <div class="inhouse-controls">
          <button class="btn gen" id="ccGen">${icon("spark", 15)} ${isImg ? "按图卡生成文案与标题" : "按口播生成文案与标题"}</button>
        </div>
        <label class="field">标题
          <div class="input-dice">
            <input class="input" id="ccTitle" value="${esc(C.title || "")}" placeholder="抓人的标题，可带表情 🔥" />
            <button class="dice" id="ccTitleDice" title="随机换一个标题">${icon("dice", 15)}</button>
          </div>
        </label>
        <label class="field">发布文案
          <textarea class="input" id="ccBody" rows="12" placeholder="钩子开头 + 分点干货 + 互动结尾 + 话题标签，可直接编辑">${esc(C.body || "")}</textarea>
        </label>
      </div>
      <aside class="chain-side">
        <div class="side-card card">
          <h3>${isImg ? "本次配图" : "本次成片构成"}</h3>
          <div id="ccPreview">${previewHtml(p, isImg)}</div>
        </div>
        <div class="side-card card hint">
          <h3>交付去向</h3>
          <p>审核通过并交付后，内容 + 标题 + 文案进入<b>发布清单</b>：按账号规则自动命名（${isImg ? "图集打包 zip 附文案.txt" : "成片带标题简介"}），供应商端可见可下载。</p>
        </div>
      </aside>
    </div>`;

  wireStepper(root);
  $$("#ccPreview img", root).forEach(im => im.addEventListener("click", () => openLightbox(im, im.src, "")));

  $("#ccTitle", root).addEventListener("input", e => { C.title = e.target.value; save("productions"); });
  $("#ccBody", root).addEventListener("input", e => { C.body = e.target.value; save("productions"); });

  $("#ccGen", root).addEventListener("click", e => withLoading(e.currentTarget, async () => {
    const shots = p.artifacts.script.shots || [];
    if (!shots.length) { toast(isImg ? "先去图片工坊生成图卡结构" : "先回脚本页生成脚本"); return; }
    const res = await AI.generateCopy({ topic: p.topic, shots, account: acc, style: p.artifacts.script.style, kind: isImg ? "image" : "video", product: productById(p.artifacts.script.productId || "dumate") });
    C.title = res.title; C.body = res.copy;
    $("#ccTitle", root).value = res.title;
    $("#ccBody", root).value = res.copy;
    save("productions");
    toast(AI.sourceNote(isImg ? "已按图卡生成爆款文案与标题" : "已按口播生成标题与简介"));
  }, "生成中…"));

  $("#ccTitleDice", root).addEventListener("click", e => withLoading(e.currentTarget, async () => {
    const t = await AI.randomTitle({ topic: p.topic, account: acc });
    C.title = t; $("#ccTitle", root).value = t; save("productions");
    toast("已随机标题");
  }, "…"));

  $("#ccNext", root).addEventListener("click", () => {
    if (!(C.body || "").trim()) { toast("先生成或写一段发布文案"); return; }
    if (!(C.title || "").trim()) C.title = p.title || p.topic || "未命名内容";
    if (["copy", "cut", "images", "render"].includes(p.stage)) setStage(p, "review", "pending");
    go("studio", "review");
  });
}

function previewHtml(p, isImg) {
  if (isImg) {
    const items = (p.artifacts.images.items || []).filter(x => x.assetId);
    return items.length
      ? `<div class="cc-grid">${items.map((it, i) => `<div class="cc-thumb"><img src="${urlFor(it.assetId)}"/><span>${i + 1}</span></div>`).join("")}</div>`
      : `<div class="muted">还没有成图：回「成图」页上传图片，交付时整组打包。</div>`;
  }
  const tl = p.artifacts.timeline || [];
  const withSub = (p.artifacts.subs || []).some(s => (s.text || "").trim());
  return tl.length
    ? tl.map((c, i) => `<div class="cc-clip"><em>${i + 1}</em><b>${esc(c.name)}</b><span>${c.dur || 15}s${c.trimIn ? ` · 裁头${c.trimIn}s` : ""}</span></div>`).join("")
      + `<div class="muted" style="margin-top:8px;font-size:11px">共 ${tl.length} 段${withSub ? " · 含字幕" : ""}</div>`
    : `<div class="muted">时间轴为空：回「剪辑」页拼接片段。</div>`;
}

/* ---------- 审核页 ---------- */
export function renderReviewPage(root, p) {
  const acc = accountById(p.accountId);
  const isImg = p.mode === "图文";
  const canPub = canDeliver();
  const shots = p.artifacts.script.shots || [];
  const items = (isImg ? p.artifacts.images.items : p.artifacts.boards.items) || [];
  const visuals = items.filter(x => x.assetId);
  const r = p.review;
  const deliveredState = p.stage === "delivered";

  root.innerHTML = `
    ${stepperHtml(p, "review")}
    <div class="chain-page">
      <div class="chain-main">
        <div class="page-head">
          <div><div class="eyebrow">定稿发布</div>
          <h2>${deliveredState ? "已发布" : "确认无误后定稿并发布"}</h2></div>
          <div class="head-actions">
            ${deliveredState ? `<button class="btn ghost" id="rvToDelivery">${icon("package", 14)} 去发布清单</button>`
            : canPub ? `<button class="btn primary" id="rvDeliver">${icon("package", 14)} 定稿并发布入供应商端</button>`
            : `<span class="muted">当前账号无发布权限</span>`}
          </div>
        </div>

        ${deliveredState ? `<div class="review-banner ok card">${icon("checkCircle", 18)}<div><b>已发布：${esc(p.delivery?.name || "")}${p.delivery?.pubSeq ? ` · #${String(p.delivery.pubSeq).padStart(3, "0")}` : ""}</b><em>发布清单与供应商端可见 · ${isImg ? "图集 zip + 文案.txt" : "成片 + 标题简介"}</em></div></div>`
        : `<div class="review-banner card">${icon("eye", 16)}<div><b>发布前自检</b><em>核对下方成片预览 / 脚本 / 文案，确认无误后点右上角「定稿并发布」即入供应商端</em></div></div>`}

        ${reviewPreviewHtml(p) ? `<section class="card review-sec">
          <div class="card-head"><b>成片预览</b><em>${isImg ? "组图配图" : "9:16 成片构成"}</em></div>
          ${reviewPreviewHtml(p)}
        </section>` : ""}

        <section class="card review-sec">
          <div class="card-head"><b>① 脚本</b><em>主题「${esc(p.topic)}」 · ${shots.length} ${isImg ? "张图卡" : "个镜头"}</em></div>
          <div class="rv-shots">${shots.slice(0, 8).map((s, i) => `<div class="rv-line"><em>${esc(s.time || `#${i + 1}`)}</em><span>${esc(s.line || s.visual || s.idea || "")}</span></div>`).join("")}${shots.length > 8 ? `<div class="muted">… 共 ${shots.length} 条</div>` : ""}</div>
        </section>

        <section class="card review-sec">
          <div class="card-head"><b>② ${isImg ? "成图" : "视觉素材"}</b><em>${visuals.length}/${items.length} 张</em></div>
          ${visuals.length ? `<div class="cc-grid lg">${visuals.map((it, i) => `<div class="cc-thumb"><img src="${urlFor(it.assetId)}" data-rv-img/><span>${i + 1}</span></div>`).join("")}</div>` : `<div class="muted">没有视觉素材</div>`}
        </section>

        ${isImg ? "" : `<section class="card review-sec">
          <div class="card-head"><b>③ 成片构成</b><em>${(p.artifacts.timeline || []).length} 段 · ${(p.artifacts.subs || []).filter(s => (s.text || "").trim()).length} 条字幕</em></div>
          ${(p.artifacts.timeline || []).map((c, i) => `<div class="rv-line"><em>${c.dur || 15}s</em><span>${esc(c.name)}${c.trimIn ? `（裁头${c.trimIn}s）` : ""}</span></div>`).join("") || `<div class="muted">时间轴为空</div>`}
        </section>`}

        <section class="card review-sec">
          <div class="card-head"><b>${isImg ? "③" : "④"} 发布文案</b><button class="link-btn" data-chain="copy">去编辑 ${icon("arrowRight", 12)}</button></div>
          <div class="rv-copy"><b>${esc(p.artifacts.copy.title || "（未填标题）")}</b><pre>${esc(p.artifacts.copy.body || "（未填文案）")}</pre></div>
        </section>
      </div>

      <aside class="chain-side">
        <div class="side-card card">
          <h3>交付物</h3>
          <div class="pos-card">
            <div class="pc-row"><span>账号</span><b>${esc(acc.name)}</b></div>
            <div class="pc-row"><span>形式</span><b>${isImg ? `${visuals.length} 张图集 zip` : `${(p.artifacts.timeline || []).length} 段成片`}</b></div>
            <div class="pc-row"><span>命名</span><b>${esc(p.delivery?.name || "交付时自动生成")}</b></div>
          </div>
        </div>
        <div class="side-card card hint">
          <h3>发布说明</h3>
          <p>创作者自检无误后即可「定稿并发布」入供应商端，无需额外审核门槛。发布后进入发布清单按发布序号排序，供应商端按标签可见、可批量下载；管理员可在发布清单非强制地标注「已审阅」。</p>
        </div>
      </aside>
    </div>`;

  wireStepper(root);
  $$("[data-rv-img]", root).forEach(im => im.addEventListener("click", () => openLightbox(im, im.src, "")));

  const dl = $("#rvDeliver", root);
  if (dl) dl.addEventListener("click", async () => {
    const r = await publishModal({ title: `定稿并发布「${p.artifacts.copy.title || p.title}」` });
    if (r == null) return;
    const a = deliver(p, r);
    toast(a ? `已发布入供应商端 · #${String(a.pubSeq).padStart(3, "0")}${a.planDate ? ` · 计划 ${a.planDate}` : ""}` : "发布失败");
    renderReviewPage(root, p);
  });
  const td = $("#rvToDelivery", root);
  if (td) td.addEventListener("click", () => go("delivery"));
}
