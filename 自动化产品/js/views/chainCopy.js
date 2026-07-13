/* 链路 · 文案页 + 审核页 */

import { $, $$, esc } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { canDeliver } from "../core/store.js";
import { urlFor } from "../domain/assets.js";
import { deliver } from "../domain/delivery.js";
import { toast, openLightbox, publishModal } from "../ui/components.js";
import { go } from "../core/router.js";
import { stepperHtml, wireStepper } from "./studio.js?v=20260713-v75-1";
import { reviewPreviewHtml } from "./prodDrawer.js";

export function renderCopyPage(root, p) {
  const isImg = p.mode === "图文";
  if (isImg) {
    root.innerHTML = `
      ${stepperHtml(p, "images")}
      <div class="chain-page solo">
        <div class="empty-state card">
          ${icon("image", 24)}
          <b>图文文案已合并到图文创作台</b>
          <p>标题、文案、图卡结构和提示词现在在一个界面完成。</p>
          <button class="btn primary" id="ccBackToImages">回到图文创作台</button>
        </div>
      </div>`;
    wireStepper(root);
    $("#ccBackToImages", root)?.addEventListener("click", () => go("studio", "images"));
    return;
  }
  root.innerHTML = `
    ${stepperHtml(p, "workshop")}
    <div class="chain-page solo">
      <div class="empty-state card">
        ${icon("layers", 24)}
        <b>视频文案已合并到文案分镜</b>
        <p>标题、简介、口播草稿和分镜现在在一个界面完成。</p>
        <button class="btn primary" id="ccBackToWorkshop">回到文案分镜</button>
      </div>
    </div>`;
  wireStepper(root);
  $("#ccBackToWorkshop", root)?.addEventListener("click", () => go("studio", "workshop"));
}

/* ---------- 审核页 ---------- */
export function renderReviewPage(root, p) {
  const isImg = p.mode === "图文";
  if (!isImg && !p.artifacts?.boards?.cover?.assetId) {
    const cover = p.artifacts?.boards?.cover || {};
    root.innerHTML = `
      ${stepperHtml(p, "review")}
      <div class="chain-page solo review-page">
        <div class="empty-state card">
          ${icon("image", 24)}
          <b>${cover.status === "failed" ? "封面自动生成失败" : "正在补齐视频封面"}</b>
          <p>${cover.status === "failed" ? esc(cover.error || "请重试或返回文案分镜手动上传封面") : "审核前必须有封面，生成完成后会自动进入审核。"}</p>
          ${cover.status === "failed" ? `<button class="btn primary" id="rvRetryCover">重新生成封面</button><button class="btn ghost" id="rvBackWorkshop">返回文案分镜</button>` : `<span class="status-pill running">生成中</span>`}
        </div>
      </div>`;
    wireStepper(root);
    const run = async () => {
      try {
        const { ensureVideoCover } = await import("./chainWorkshop.js?v=20260713-v75-1");
        await ensureVideoCover(p);
        if (root.isConnected) renderReviewPage(root, p);
      } catch (err) {
        if (root.isConnected) renderReviewPage(root, p);
      }
    };
    if (cover.status !== "loading" && cover.status !== "failed") queueMicrotask(run);
    $("#rvRetryCover", root)?.addEventListener("click", () => {
      p.artifacts.boards.cover.status = "idle";
      run();
    });
    $("#rvBackWorkshop", root)?.addEventListener("click", () => go("studio", "workshop"));
    return;
  }
  const canPub = canDeliver();
  const shots = p.artifacts.script.shots || [];
  const items = (isImg ? p.artifacts.images.items : p.artifacts.boards.items) || [];
  const visuals = items.filter(x => x.assetId);
  const deliveredState = p.stage === "delivered";

  root.innerHTML = `
    ${stepperHtml(p, "review")}
    <div class="chain-page solo review-page">
      <div class="chain-main">
        ${deliveredState ? `<div class="review-banner ok card review-publish-bar">${icon("checkCircle", 18)}<div><b>已发布：${esc(p.delivery?.name || "")}${p.delivery?.pubSeq ? ` · #${String(p.delivery.pubSeq).padStart(3, "0")}` : ""}</b><em>发布清单与供应商端可见 · ${isImg ? "图集 zip + 文案.txt" : "成片 + 标题简介"}</em></div><button class="btn ghost" id="rvToDelivery">${icon("package", 14)} 去发布清单</button></div>`
        : `<div class="review-banner card review-publish-bar">${icon("eye", 16)}<div><b>发布前自检</b><em>核对下方成片预览、脚本与文案，确认无误后即可定稿发布</em></div>${canPub ? `<button class="btn primary" id="rvDeliver">${icon("package", 14)} 定稿并发布入供应商端</button>` : `<span class="muted">当前账号无发布权限</span>`}</div>`}

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
          <div class="card-head"><b>${isImg ? "③" : "④"} 发布文案</b><button class="link-btn" data-chain="${isImg ? "images" : "workshop"}">去编辑 ${icon("arrowRight", 12)}</button></div>
          <div class="rv-copy"><b>${esc(p.artifacts.copy.title || "（未填标题）")}</b><pre>${esc(p.artifacts.copy.body || "（未填文案）")}</pre></div>
        </section>
      </div>
    </div>`;

  wireStepper(root);
  $$("[data-rv-img]", root).forEach(im => im.addEventListener("click", () => openLightbox(im, im.src, "")));

  const dl = $("#rvDeliver", root);
  if (dl) dl.addEventListener("click", async () => {
    if (!isImg && !p.artifacts?.boards?.cover?.assetId) {
      toast("先回到文案分镜生成或上传封面图，再发布到供应商端");
      return;
    }
    const r = await publishModal({ title: `定稿并发布「${p.artifacts.copy.title || p.title}」` });
    if (r == null) return;
    const a = deliver(p, r);
    toast(a ? `已发布入供应商端 · #${String(a.pubSeq).padStart(3, "0")}${a.planDate ? ` · 计划 ${a.planDate}` : ""}` : "发布失败");
    renderReviewPage(root, p);
  });
  const td = $("#rvToDelivery", root);
  if (td) td.addEventListener("click", () => go("delivery"));
}
