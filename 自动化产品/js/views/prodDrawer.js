/* 任务详情抽屉：Agent 看板 / 创作空间 / 发布清单 共用的任务控制面板 */

import { esc, gradFor, copyText, fileToDataUrl, wireDropZone, $, $$ } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, accountById, productionById, canDeliver } from "../core/store.js";
import { openDrawer, toast, confirmModal, openLightbox, publishModal } from "../ui/components.js";
import { STAGES, jobsOf } from "../domain/productions.js";
import { platChip } from "../domain/accounts.js";
import { urlFor } from "../domain/assets.js";
import { addAssetFromDataUrl } from "../domain/assets.js";
import { deliver } from "../domain/delivery.js";
import { maybeAdvanceAfterInput } from "../agent/orchestrator.js";
import { go, currentRoute, allowStudioFromAgent } from "../core/router.js";

/* 成片预览：9:16 预览帧 + 分镜缩略胶片条（方便发布前自检看成片构成） */
export function reviewPreviewHtml(p) {
  if (p.mode === "图文") {
    const imgs = (p.artifacts.images.items || []).filter(x => x.assetId);
    if (!imgs.length) return "";
    return `<div class="rv-preview img">
      <div class="rvp-grid">${imgs.map((it, i) => `<div class="rvp-cell"><img src="${urlFor(it.assetId)}" data-rv-img/><span>${i + 1}</span></div>`).join("")}</div>
    </div>`;
  }
  const tl = p.artifacts.timeline || [];
  if (!tl.length) return "";
  const thumbAsset = (clip, i) => {
    if (clip.unitId) { const u = (p.artifacts.boards.units || []).find(x => x.id === clip.unitId); if (u && u.imageAssetId) return u.imageAssetId; }
    const it = (p.artifacts.boards.items || [])[i]; return it && it.assetId ? it.assetId : null;
  };
  const coverId = thumbAsset(tl[0], 0);
  const coverUrl = coverId ? urlFor(coverId) : null;
  const firstSub = (p.artifacts.subs || []).find(s => (s.text || "").trim());
  const total = tl.reduce((s, c) => s + (c.dur || 15), 0);
  const jobs = jobsOf(p);
  const clipUrl = c => c?.jobId ? (jobs.find(j => j.id === c.jobId)?.output?.url || "") : "";
  const firstRealClipUrl = tl.map(clipUrl).find(Boolean);
  const previewVideoUrl = p.artifacts.finalVideoUrl || firstRealClipUrl || "";
  if (previewVideoUrl) {
    return `<div class="rv-preview vid">
      <div class="rvp-screen">
        <video src="${esc(previewVideoUrl)}" controls playsinline preload="metadata"></video>
        <span class="rvp-ratio">9:16</span>
        <span class="rvp-time">${Math.round(total)}s</span>
        ${!p.artifacts.finalVideoUrl ? `<div class="rvp-hint">当前播放首段真实视频 · 合成后替换为完整成片</div>` : ""}
      </div>
      <div class="rvp-strip">${tl.map((c, i) => {
        const u = thumbAsset(c, i); const url = u ? urlFor(u) : null;
        return `<div class="rvp-clip"><div class="rvp-clip-thumb">${url ? `<img src="${url}"/>` : `<i style="background:${gradFor(c.name)}"></i>`}</div><span>${esc(c.name)}</span><em>${c.dur || 15}s</em></div>`;
      }).join("")}</div>
    </div>`;
  }
  return `<div class="rv-preview vid">
    <div class="rvp-screen">
      <div class="rvp-frame" style="background:${coverUrl ? "#0a0e1a" : gradFor(p.title || p.id)}">${coverUrl ? `<img src="${coverUrl}"/>` : ""}</div>
      <span class="rvp-ratio">9:16</span>
      <span class="rvp-time">${Math.round(total)}s</span>
      <span class="rvp-play">${icon("play", 20)}</span>
      ${firstSub ? `<div class="rvp-sub">${esc(firstSub.text)}</div>` : ""}
      <div class="rvp-hint">预览为示意 · 接视频 API 后可播放成片</div>
    </div>
    <div class="rvp-strip">${tl.map((c, i) => {
      const u = thumbAsset(c, i); const url = u ? urlFor(u) : null;
      return `<div class="rvp-clip"><div class="rvp-clip-thumb">${url ? `<img src="${url}"/>` : `<i style="background:${gradFor(c.name)}"></i>`}</div><span>${esc(c.name)}</span><em>${c.dur || 15}s</em></div>`;
    }).join("")}</div>
  </div>`;
}

export function openProductionDrawer(pid, tab) {
  const p = productionById(pid);
  if (!p) { toast("任务不存在"); return; }
  const isImg = p.mode === "图文";
  let curTab = tab || defaultTab(p);

  const { close } = openDrawer(`<div id="pdRoot"></div>`, {
    width: 640,
    onMount(panel) {
      const root = panel.querySelector("#pdRoot");
      const render = () => {
        const acc = accountById(p.accountId);
        const material = p.subType === "无数字人" && p.mode === "视频";
        const tabs = [
          [isImg ? "images" : "boards", isImg ? "图片工坊" : "分镜工坊"],
          ...(isImg ? [] : material ? [["render", "成片"]] : [["prompts", "提示词"], ["render", "成片"]]),
          ["copy", "文案"],
          ["review", "审核"]
        ];
        root.innerHTML = `
          <div class="pd-head">
            <div class="pd-title">
              <span class="dot lg" style="background:${gradFor(acc?.name || "")}"></span>
              <div><b>${esc(p.artifacts.copy.title || p.title || p.topic || "未命名任务")}</b>
              <em>${esc(acc?.name || "")} ${platChip(acc?.platform || "", true)} · ${p.mode}${p.origin === "agent" ? " · Agent 批次" : ""}</em></div>
            </div>
            <button class="icon-btn" data-close>${icon("x", 16)}</button>
          </div>
          <div class="pd-tabs">${tabs.map(([k, l]) => `<button class="pd-tab ${curTab === k ? "is-active" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
          <div class="pd-body">${TAB[curTab] ? TAB[curTab](p) : ""}</div>
          <div class="pd-foot">
            <span class="muted">${p.error ? `⚠ ${esc(p.error)}` : ""}</span>
            <button class="btn ghost sm" data-pd="workbench">${icon("sliders", 14)} 进入单号工坊微调</button>
          </div>`;
        wire(root);
      };

      const wire = (rootEl) => {
        rootEl.querySelectorAll(".pd-tab").forEach(b => b.addEventListener("click", () => { curTab = b.dataset.tab; render(); }));
        // 去工作台微调：按当前页签路由到对应可编辑节点（再在那里重新生成）
        rootEl.querySelectorAll('[data-pd="workbench"]').forEach(wb => wb.addEventListener("click", async () => {
          const from = currentRoute();
          if (from.zone === "agent") {
            const ok = await confirmModal({
              title: "进入单号工坊？",
              body: "批量创作会继续留在任务板；只有需要单独微调这条内容时，才进入单号图片工坊。",
              okText: "进入微调"
            });
            if (!ok) return;
          }
          state.ui.activeAccountId = p.accountId;
          state.ui.activeProductionId = p.id;
          state.ui.returnTo = from;   // 记住来处，工作台里给「返回」按钮用
          save("meta");
          close();
          if (from.zone === "agent") allowStudioFromAgent();
          go("studio", tabStage(p, curTab));
        }));
        // 脚本编辑
        rootEl.querySelectorAll("[data-shot-field]").forEach(td => td.addEventListener("blur", () => {
          const i = +td.dataset.idx;
          const f = td.dataset.shotField;
          if (p.artifacts.script.shots[i]) { p.artifacts.script.shots[i][f] = td.textContent.trim(); save("productions"); }
        }));
        // 复制站外提示词
        const cp = rootEl.querySelector("[data-pd-copy]");
        if (cp) cp.addEventListener("click", () => {
          const txt = isImg ? p.artifacts.images.externalPrompt : p.artifacts.boards.externalPrompt;
          copyText(txt || "", "已复制整段提示词，去第三方模型粘贴即可");
        });
        // 槽位上传
        rootEl.querySelectorAll("[data-slot-up]").forEach(inp => inp.addEventListener("change", async e => {
          const i = +inp.dataset.slotUp;
          const f = e.target.files[0]; if (!f) return;
          await fillSlot(p, i, f);
          render();
        }));
        // 整体拖拽上传
        const dz = rootEl.querySelector("[data-pd-drop]");
        if (dz) {
          wireDropZone(dz, async files => {
            for (const f of Array.from(files).filter(x => x.type.startsWith("image/"))) await fillSlot(p, -1, f);
            render();
          });
          dz.addEventListener("click", e => {
            if (e.target.closest("img") || e.target.closest(".pd-slot")) return;
            const inp = dz.querySelector("[data-pd-drop-input]");
            if (inp) inp.click();
          });
          const inp = dz.querySelector("[data-pd-drop-input]");
          if (inp) inp.addEventListener("change", async e => {
            for (const f of Array.from(e.target.files)) await fillSlot(p, -1, f);
            render();
          });
        }
        // 槽位图放大
        rootEl.querySelectorAll(".pd-slot img").forEach(im => im.addEventListener("click", () => openLightbox(im, im.src, "")));
        // 文案编辑
        const t = rootEl.querySelector("#pdCopyTitle"), c = rootEl.querySelector("#pdCopyBody");
        if (t) t.addEventListener("input", () => { p.artifacts.copy.title = t.value; save("productions"); });
        if (c) c.addEventListener("input", () => { p.artifacts.copy.body = c.value; save("productions"); });
        // 定稿发布（计划发布时间必填，备注可选）
        const dl = rootEl.querySelector("[data-pd-deliver]");
        if (dl) dl.addEventListener("click", async () => {
          const r = await publishModal({ title: `定稿并发布「${p.artifacts.copy.title || p.title}」` });
          if (r == null) return;
          const a = deliver(p, r);
          toast(a ? `已发布 · #${String(a.pubSeq).padStart(3, "0")}${a.planDate ? ` · 计划 ${a.planDate}` : ""}` : "发布失败");
          render();
        });
      };
      render();
    }
  });
}

function defaultTab(p) {
  if (p.stage === "review" || p.stage === "delivered") return "review";
  if (p.stage === "copy") return "copy";
  if (p.mode === "视频" && (p.stage === "workshop" || p.stage === "render")) return "boards";
  if (p.stage === "cut") return "render";
  if (p.mode === "视频") return "boards";
  if (p.mode === "图文" && p.stage === "script") return "images";
  if (p.stage === "boards") return "boards";
  if (p.stage === "images") return "images";
  return p.mode === "图文" ? "images" : "script";
}

export function stagePage(p) {
  const m = { script: "script", boards: "boards", images: "images", prompts: "prompts", workshop: "workshop", render: "render", cut: "cut", copy: "copy", review: "review", delivered: "review" };
  if (p.mode === "图文" && p.stage === "script") return "images";
  if (p.mode === "视频" && ["script", "boards", "prompts", "render"].includes(p.stage)) return "workshop";
  return m[p.stage] || "script";
}

/* 抽屉页签 → 工作台里可编辑+重新生成的对应节点（去微调用） */
function tabStage(p, tab) {
  const video = p.mode === "视频";
  switch (tab) {
    case "script": return video ? "workshop" : "images";
    case "boards": return video ? "workshop" : "boards";
    case "images": return "images";
    case "prompts": return "prompts";
    case "render": return video ? "workshop" : "review";
    case "copy": return "copy";
    case "review": return "review";
    default: return stagePage(p);
  }
}

async function fillSlot(p, idx, file) {
  const isImg = p.mode === "图文";
  const items = isImg ? p.artifacts.images.items : p.artifacts.boards.items;
  let i = idx;
  if (i < 0) i = items.findIndex(x => !x.assetId);
  if (i < 0) i = items.length ? items.length - 1 : -1;
  if (i < 0) return;
  const dataUrl = await fileToDataUrl(file);
  const a = await addAssetFromDataUrl(p.accountId, {
    name: `${isImg ? "笔记图" : "分镜图"}${String(i + 1).padStart(2, "0")}_${(p.title || "").slice(0, 6)}`,
    tags: [isImg ? "笔记图" : "分镜图"], dataUrl
  });
  items[i].assetId = a.id;
  items[i].status = "done";
  save("productions");
  const complete = items.every(x => x.assetId);
  if (complete && p.stageStatus === "needs_input") maybeAdvanceAfterInput(p);
  toast(`已上传 ${isImg ? "图" : "分镜"} ${i + 1}/${items.length}${complete ? " ✓ 全部就位" : ""}`);
}

/* ---------- 各 Tab 内容 ---------- */
const TAB = {
  script(p) {
    const shots = p.artifacts.script.shots || [];
    const isImg = p.mode === "图文";
    if (!shots.length) return `<div class="pd-empty">${icon("fileText", 22)}<p>脚本还未生成${p.stageStatus === "running" ? "（起草中…）" : ""}</p></div>`;
    const cols = isImg ? [["idea", "核心思想"], ["visual", "画面"], ["line", "图上文案"]] : [["time", "时间"], ["idea", "核心思想"], ["visual", "画面"], ["line", "口播"]];
    return `<div class="pd-note">主题「${esc(p.topic)}」 · ${shots.length} ${isImg ? "张图卡" : "个镜头"} · 单元格可直接编辑${p.artifacts.script.source === "mock" ? ` · <i class="src-mock">本地模板</i>` : ""}</div>
    <table class="mini-table"><thead><tr><th>#</th>${cols.map(c => `<th>${c[1]}</th>`).join("")}</tr></thead>
    <tbody>${shots.map((s, i) => `<tr><td class="c-idx">${i + 1}</td>${cols.map(c => `<td contenteditable="true" data-shot-field="${c[0]}" data-idx="${i}">${esc(s[c[0]] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  },

  boards(p) {
    if (p.mode === "视频") {
      const units = p.artifacts.boards.units || [];
      if (!units.length) return `<div class="pd-empty">${icon("layers", 22)}<p>脚本起草后会按场景合并成分镜单元，进工坊编排</p></div>`;
      return `<div class="pd-note">${units.length} 个分镜单元 · 含角色/界面/logo 走统一参考，其余文生视频</div>
        <div class="pd-units">${units.map((u, i) => {
          const jobs = jobsOf(p).filter(j => j.segIndex === i);
          const ok = jobs.some(j => j.status === "succeeded");
          return `<div class="pd-unit ${u.needsImage ? "i2v" : "t2v"}"><b>S${String(u.scene).padStart(2, "0")}${u.sceneParts > 1 ? `·${u.part}` : ""}</b><span>${u.needsImage ? "图生" : "文生"} · ${u.shotIndexes.length}镜 · ${Math.min(15, Math.ceil(u.dur))}s</span>${ok ? icon("checkCircle", 13, "ok") : `<em class="muted">未出片</em>`}</div>`;
        }).join("")}</div>
        <div class="pd-note" style="margin-top:8px"><button class="link-btn" data-pd="workbench">进工坊编排 →</button></div>`;
    }
    return slotsTab(p, false);
  },
  images(p) { return slotsTab(p, true); },

  prompts(p) {
    const prompts = p.artifacts.prompts || [];
    if (!prompts.length) return `<div class="pd-empty">${icon("list", 22)}<p>提示词未生成</p></div>`;
    return prompts.map((sc, i) => `
      <div class="pd-prompt">
        <div class="pdp-head"><b>${esc(sc.name)}</b>${sc.ui ? `<span class="tag warn">含 UI 镜头</span>` : ""}</div>
        <div class="pdp-seg"><span class="t-tag front">第一段 0-15s</span><pre>${esc(sc.front || "")}</pre></div>
        ${sc.back ? `<div class="pdp-seg"><span class="t-tag back">第二段 0-15s</span><pre>${esc(sc.back)}</pre></div>` : ""}
      </div>`).join("");
  },

  render(p) {
    const jobs = jobsOf(p);
    const tl = p.artifacts.timeline || [];
    if (!jobs.length && !tl.length) return `<div class="pd-empty">${icon("film", 22)}<p>还没有渲染任务。分镜齐了之后由 Agent 派发，或进完整工作台手动生成。</p></div>`;
    return `
      ${jobs.length ? `<div class="pd-note">渲染任务 ${jobs.filter(j => j.status === "succeeded").length}/${jobs.length} 完成</div>
      <div class="pd-jobs">${jobs.map(j => `
        <div class="pdj ${j.status}">
          <b>${esc(j.segName || "Segment " + (j.segIndex + 1))}</b>
          <span class="pdj-bar"><i style="width:${j.progress}%"></i></span>
          <em>${{ queued: "排队中", submitted: "已提交", running: j.progress + "%", succeeded: "完成", failed: "失败", canceled: "已取消" }[j.status]}</em>
        </div>`).join("")}</div>` : ""}
      ${tl.length ? `<div class="pd-note" style="margin-top:10px">时间轴 ${tl.length} 段 · ${(p.artifacts.subs || []).filter(s => (s.text || "").trim()).length} 条字幕（已智能拼接，可进工作台精修）</div>` : ""}`;
  },

  copy(p) {
    return `
      <label class="field">标题<input id="pdCopyTitle" class="input" value="${esc(p.artifacts.copy.title || "")}" /></label>
      <label class="field">发布文案<textarea id="pdCopyBody" class="input" rows="10">${esc(p.artifacts.copy.body || "")}</textarea></label>
      <div class="pd-note">改动实时保存，交付时随包带出。</div>`;
  },

  review(p) {
    const canPub = canDeliver();
    if (p.stage === "delivered") {
      return `<div class="pd-review ok">${icon("checkCircle", 20)}<b>已发布</b><p>${esc(p.delivery?.name || "")}${p.delivery?.pubSeq ? ` · #${String(p.delivery.pubSeq).padStart(3, "0")}` : ""} · 发布清单与供应商端可见</p></div>`;
    }
    return `
      <div class="pd-review">
        ${reviewPreviewHtml(p)}
        <div class="pdr-state">${icon("eye", 16)} 发布前自检：核对成片预览与文案，确认无误即可定稿发布</div>
        <div class="pdr-sum">「${esc(p.artifacts.copy.title || p.title)}」 · ${p.mode === "图文" ? `${(p.artifacts.images.items || []).filter(x => x.assetId).length} 张组图打包 zip + 文案.txt` : `${(p.artifacts.timeline || []).length} 段成片拼接${(p.artifacts.subs || []).some(s => s.text) ? " + 字幕" : ""}`}</div>
        <div class="pdr-actions">
          ${p.stage === "review"
            ? (canPub ? `<button class="btn primary" data-pd-deliver>${icon("package", 14)} 定稿并发布入供应商端</button>`
              : `<span class="muted">当前账号无发布权限</span>`)
            : `<span class="muted">当前在「${STAGES[p.stage].label}」阶段，完成后进入发布</span>`}
        </div>
      </div>`;
  }
};

function slotsTab(p, isImg) {
  const A = isImg ? p.artifacts.images : p.artifacts.boards;
  const items = A.items || [];
  if (!items.length) return `<div class="pd-empty">${icon("image", 22)}<p>脚本起草后这里会列出${isImg ? "每张图" : "每个分镜"}的上传槽位</p></div>`;
  const got = items.filter(x => x.assetId).length;
  return `
    <div class="pd-note">站外出图上传 <b>${got}/${items.length}</b> · <button class="link-btn" data-pd-copy>${icon("copy", 13)} 复制整段提示词</button></div>
    <div class="pd-drop" data-pd-drop>
      ${icon("upload", 16)} 把图拖到这里按顺序分发（可多选）
      <input type="file" accept="image/*" multiple hidden data-pd-drop-input />
    </div>
    <div class="pd-slots">${items.map((it, i) => {
      const u = it.assetId ? urlFor(it.assetId) : null;
      return `<div class="pd-slot ${u ? "filled" : ""}">
        ${u ? `<img src="${u}"/>` : `<span class="pds-ph">${i + 1}</span>`}
        <div class="pds-cap"><b>${i + 1}. ${esc(it.title || (isImg ? "图" : "分镜") + (i + 1))}</b><em>${esc((it.visual || "").slice(0, 30))}</em></div>
        <label class="pds-up">${u ? "替换" : "上传"}<input type="file" accept="image/*" hidden data-slot-up="${i}" /></label>
      </div>`;
    }).join("")}</div>`;
}
