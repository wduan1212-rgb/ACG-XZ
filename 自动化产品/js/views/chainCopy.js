/* 链路 · 文案页 + 审核页 */

import { $, $$, esc } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { canDeliver, save } from "../core/store.js";
import * as remote from "../core/remote.js";
import { urlFor } from "../domain/assets.js";
import { deliver } from "../domain/delivery.js";
import { toast, openLightbox, publishModal } from "../ui/components.js?v=20260805-v140-platform-stability-3";
import { go } from "../core/router.js";
import { stepperHtml, wireStepper } from "./studio.js?v=20260805-v140-platform-stability-3";
import { reviewPreviewHtml } from "./prodDrawer.js?v=20260805-v140-platform-stability-3";

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
        <b>视频文案已合并到视频制作</b>
        <p>标题、简介、口播草稿和分镜现在在一个界面完成。</p>
        <button class="btn primary" id="ccBackToWorkshop">回到视频制作</button>
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
          <p>${cover.status === "failed" ? esc(cover.error || "请重试或返回视频制作手动上传封面") : "审核前必须有封面，生成完成后会自动进入审核。"}</p>
          ${cover.status === "failed" ? `<button class="btn primary" id="rvRetryCover">重新生成封面</button><button class="btn ghost" id="rvBackWorkshop">返回视频制作</button>` : `<span class="status-pill running">生成中</span>`}
        </div>
      </div>`;
    wireStepper(root);
    const run = async () => {
      try {
        const { ensureVideoCover } = await import("./chainWorkshop.js?v=20260805-v140-platform-stability-3");
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
  const items = (isImg ? p.artifacts.images.items : p.artifacts.boards.items) || [];
  const visuals = items.filter(x => x.assetId);
  const deliveredState = p.stage === "delivered";
  const speedVersions = Array.isArray(p.artifacts?.finalVideoVersions)
    ? p.artifacts.finalVideoVersions.filter(item => item?.url)
    : [];
  const coverAssetId = p.artifacts?.boards?.cover?.assetId || "";
  const coverUrl = coverAssetId ? urlFor(coverAssetId) : "";
  const publishBar = deliveredState
    ? `<div class="review-banner ok card review-publish-bar">${icon("checkCircle", 18)}<div><b>已发布：${esc(p.delivery?.name || "")}${p.delivery?.pubSeq ? ` · #${String(p.delivery.pubSeq).padStart(3, "0")}` : ""}</b><em>发布清单与供应商端可见 · ${isImg ? "图集 zip + 文案.txt" : "成片 + 标题简介"}</em></div><button class="btn ghost" id="rvToDelivery">${icon("package", 14)} 去发布清单</button></div>`
    : `<div class="review-banner card review-publish-bar">${icon("eye", 16)}<div><b>发布前自检</b><em>核对成片、封面与发布文案，确认无误后即可定稿发布</em></div>${canPub ? `<button class="btn primary" id="rvDeliver">${icon("package", 14)} 定稿并发布入供应商端</button>` : `<span class="muted">当前账号无发布权限</span>`}</div>`;

  const videoReview = !isImg ? `
    <div class="video-review-shell">
      ${publishBar}
      <div class="video-review-grid">
        <section class="card video-review-panel video-review-final">
          <div class="card-head"><b>合成成片</b><em>最终预览</em></div>
          <div class="video-review-media">${reviewPreviewHtml(p) || `<div class="muted">成片尚未就绪</div>`}</div>
          ${p.artifacts?.finalVideoUrl ? `<div class="video-speed-tools"><select class="input sm" id="rvVideoSpeed" aria-label="调整成片速度"><option value="1.2">1.2x</option><option value="1.3">1.3x</option><option value="1.5">1.5x</option><option value="1.8">1.8x</option><option value="2">2.0x</option></select><button class="btn ghost sm" id="rvVideoSpeedRun">另存变速版</button></div>` : ""}
          ${speedVersions.length ? `<div class="video-speed-versions"><span>成片版本</span>${speedVersions.map(item => `<button type="button" class="link-btn" data-rv-speed-version="${esc(item.url)}">${Number(item.speed || 1).toFixed(1)}x</button>`).join("")}</div>` : ""}
        </section>
        <section class="card video-review-panel video-review-cover">
          <div class="card-head"><b>封面图</b><button class="link-btn" data-chain="workshop">去编辑 ${icon("arrowRight", 12)}</button></div>
          ${coverUrl ? `<button class="video-review-cover-button" data-rv-cover><img src="${esc(coverUrl)}" alt="${esc(p.artifacts.copy.title || p.title || "视频封面")}"/></button>` : `<div class="muted">封面尚未生成</div>`}
        </section>
        <section class="card video-review-panel video-review-copy">
          <div class="card-head"><b>标题与发布文案</b><button class="link-btn" data-chain="workshop">去编辑 ${icon("arrowRight", 12)}</button></div>
          <div class="rv-copy"><b>${esc(p.artifacts.copy.title || "（未填标题）")}</b><pre>${esc(p.artifacts.copy.body || "（未填文案）")}</pre></div>
        </section>
      </div>
    </div>` : "";

  if (!isImg) {
    root.innerHTML = `${stepperHtml(p, "review")}
      <div class="chain-page solo review-page video-review-page"><div class="chain-main">${videoReview}</div></div>`;
    wireStepper(root);
    $("[data-rv-cover]", root)?.addEventListener("click", () => openLightbox($("[data-rv-cover] img", root), coverUrl, "视频封面"));
    $$('[data-chain]', root).forEach(button => button.addEventListener("click", () => go("studio", button.dataset.chain)));
    $$('[data-rv-speed-version]', root).forEach(button => button.addEventListener("click", () => {
      p.artifacts.finalVideoUrl = button.dataset.rvSpeedVersion || p.artifacts.finalVideoUrl;
      save("productions");
      renderReviewPage(root, p);
    }));
    $("#rvVideoSpeedRun", root)?.addEventListener("click", async event => {
      const button = event.currentTarget;
      const speed = Number($("#rvVideoSpeed", root)?.value || 1.2);
      const sourceUrl = String(p.artifacts.finalVideoBaseUrl || p.artifacts.finalVideoUrl || "");
      if (!sourceUrl) return;
      button.disabled = true;
      button.textContent = "处理中…";
      try {
        const response = await fetch("/api/video/speed-version", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(remote.getToken() ? { Authorization: `Bearer ${remote.getToken()}` } : {}),
          },
          body: JSON.stringify({ sourceUrl, speed, title: p.artifacts.copy?.title || p.title || "speed-version" }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.detail || "生成变速版本失败");
        p.artifacts.finalVideoBaseUrl = sourceUrl;
        p.artifacts.finalVideoUrl = data.url;
        p.artifacts.finalVideoName = data.name || "";
        p.artifacts.finalVideoVersions = [
          { url: data.url, name: data.name || "", speed: data.speed, createdAt: Date.now() },
          ...speedVersions.filter(item => item.url !== data.url),
        ].slice(0, 12);
        save("productions");
        toast(`已生成新的 ${speed.toFixed(1)} 倍速成片`);
        renderReviewPage(root, p);
      } catch (error) {
        toast(error.message || "生成变速版本失败", "error");
        button.disabled = false;
        button.textContent = "另存变速版";
      }
    });
    const publish = $("#rvDeliver", root);
    if (publish) publish.addEventListener("click", async () => {
      const result = await publishModal({ title: `定稿并发布「${p.artifacts.copy.title || p.title}」` });
      if (result == null) return;
      const asset = deliver(p, result);
      toast(asset ? `已发布入供应商端 · #${String(asset.pubSeq).padStart(3, "0")}${asset.planDate ? ` · 计划 ${asset.planDate}` : ""}` : "发布失败");
      renderReviewPage(root, p);
    });
    $("#rvToDelivery", root)?.addEventListener("click", () => go("delivery"));
    return;
  }

  root.innerHTML = `
    ${stepperHtml(p, "review")}
    <div class="chain-page solo review-page">
      <div class="chain-main">
        ${deliveredState ? `<div class="review-banner ok card review-publish-bar">${icon("checkCircle", 18)}<div><b>已发布：${esc(p.delivery?.name || "")}${p.delivery?.pubSeq ? ` · #${String(p.delivery.pubSeq).padStart(3, "0")}` : ""}</b><em>发布清单与供应商端可见 · ${isImg ? "图集 zip + 文案.txt" : "成片 + 标题简介"}</em></div><button class="btn ghost" id="rvToDelivery">${icon("package", 14)} 去发布清单</button></div>`
        : `<div class="review-banner card review-publish-bar">${icon("eye", 16)}<div><b>发布前自检</b><em>核对下方成图与发布文案，确认无误后即可定稿发布</em></div>${canPub ? `<button class="btn primary" id="rvDeliver">${icon("package", 14)} 定稿并发布入供应商端</button>` : `<span class="muted">当前账号无发布权限</span>`}</div>`}

        <section class="card review-sec">
          <div class="card-head"><b>① 成图</b><em>${visuals.length}/${items.length} 张</em></div>
          ${visuals.length ? `<div class="cc-grid lg">${visuals.map((it, i) => `<div class="cc-thumb"><img src="${urlFor(it.assetId)}" data-rv-img/><span>${i + 1}</span></div>`).join("")}</div>` : `<div class="muted">没有视觉素材</div>`}
        </section>

        ${isImg ? "" : `<section class="card review-sec">
          <div class="card-head"><b>③ 成片构成</b><em>${(p.artifacts.timeline || []).length} 段 · ${(p.artifacts.subs || []).filter(s => (s.text || "").trim()).length} 条字幕</em></div>
          ${(p.artifacts.timeline || []).map((c, i) => `<div class="rv-line"><em>${c.dur || 15}s</em><span>${esc(c.name)}${c.trimIn ? `（裁头${c.trimIn}s）` : ""}</span></div>`).join("") || `<div class="muted">时间轴为空</div>`}
        </section>`}

        <section class="card review-sec">
          <div class="card-head"><b>② 发布文案</b><button class="link-btn" data-chain="images">去编辑 ${icon("arrowRight", 12)}</button></div>
          <div class="rv-copy"><b>${esc(p.artifacts.copy.title || "（未填标题）")}</b><pre>${esc(p.artifacts.copy.body || "（未填文案）")}</pre></div>
        </section>
      </div>
    </div>`;

  wireStepper(root);
  $$("[data-rv-img]", root).forEach(im => im.addEventListener("click", () => openLightbox(im, im.src, "")));

  const dl = $("#rvDeliver", root);
  if (dl) dl.addEventListener("click", async () => {
    if (!isImg && !p.artifacts?.boards?.cover?.assetId) {
      toast("先回到视频制作生成或上传封面图，再发布到供应商端");
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
