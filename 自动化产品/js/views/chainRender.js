/* 链路 · 生成台（即梦式深色工作台，Job 驱动：排队/进度/失败/重试/取消 全状态） */

import { $, $$, esc, gradFor, uid } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, on, accountById } from "../core/store.js";
import { segmentsForGen, setStage, setStatus, autoAssemble } from "../domain/productions.js";
import { accountAssets } from "../domain/accounts.js";
import { urlFor, thumbHtml, addAssetFromFile } from "../domain/assets.js";
import { createJob, retryJob, cancelJob } from "../api/jobs.js";
import { videoApiConfigured, videoApiHealthy, videoProviderLabel } from "../api/providers.js";
import { toast } from "../ui/components.js";
import { go, currentRoute } from "../core/router.js";
import { stepperHtml, wireStepper } from "./studio.js";

const segIdxByProd = new Map();
const draftBySeg = new Map(); // `${pid}:${seg}` -> html
let wired = false;
let liveRoot = null, liveProd = null, liveLight = null;

export function renderRenderPage(root, p) {
  liveRoot = root; liveProd = p;
  liveLight = () => renderRenderPageLight();
  const segs = segmentsForGen(p);
  if (!segs.length) {
    root.innerHTML = `${stepperHtml(p, "render")}
      <div class="empty-state">${icon("film", 26)}<b>还没有提示词</b><p>先回「提示词」生成两段式提示词，再进生成台</p>
      <button class="btn primary" data-chain="prompts">去生成提示词</button></div>`;
    wireStepper(root);
    return;
  }
  let segIdx = Math.min(segIdxByProd.get(p.id) || 0, segs.length - 1);

  const jobsOfSeg = i => state.jobs.filter(j => j.productionId === p.id && j.segIndex === i).sort((a, b) => a.createdAt - b.createdAt);

  const draw = () => {
    const seg = segs[segIdx];
    const allDone = segs.every((s, i) => jobsOfSeg(i).some(j => j.status === "succeeded"));
    root.innerHTML = `
      ${stepperHtml(p, "render")}
      <div class="workbench" data-surface="dark">
        <aside class="wb-segs">
          <div class="wbs-head"><b>${esc(p.title || p.topic || "新创作")}</b><em>${segs.length} 个片段</em></div>
          ${(() => {
            let html = ""; let lastScene = -1;
            segs.forEach((s, i) => {
              if (s.scene !== lastScene) { html += `<div class="wbs-group">${esc(s.sceneName)}</div>`; lastScene = s.scene; }
              const jobs = jobsOfSeg(i);
              const ok = jobs.filter(j => j.status === "succeeded").length;
              const running = jobs.some(j => ["queued", "submitted", "running"].includes(j.status));
              html += `<button class="wbs-item ${i === segIdx ? "is-active" : ""}" data-seg="${i}">
                <span class="t-tag ${s.part}">${s.part === "front" ? "第一段" : "第二段"}</span>
                <em>${running ? `<i class="live-dot"></i> 生成中` : ok ? `${jobs.length} 个版本 · ${ok} 成功` : jobs.length ? `${jobs.length} 个版本` : "尚未生成"}</em>
              </button>`;
            });
            return html;
          })()}
          ${allDone ? `<button class="wbs-assemble" id="wbAssemble">${icon("scissors", 14)} 全部就绪 · 智能拼接进剪辑</button>` : ""}
        </aside>

        <section class="wb-stage">
          <div class="wb-toolbar">
            <div><div class="eyebrow light">生成台 · ${esc(seg.sceneName)}</div><h2>${esc(seg.name)} · ${durationOf(p)}s</h2></div>
            <div class="wb-toolbar-right">
              <span class="api-badge ${videoApiHealthy() ? "ok" : "warn"}">${esc(videoProviderLabel())}</span>
              <button class="btn ghost sm dark" id="wbToCut">${icon("scissors", 13)} 进入剪辑</button>
            </div>
          </div>

          <div class="wb-flow" id="wbFlow"></div>

          <div class="wb-composer" id="wbComposer">
            <div class="wb-input" id="wbInput" contenteditable="true" data-ph="输入视频提示词，@ 可调用账号资产，可拖拽 / 粘贴图片做参考"></div>
            <div class="wb-mention" id="wbMention" hidden></div>
            <div class="wb-tools">
              <label class="tool-btn" title="上传图片做参考">${icon("image", 14)} 图片<input type="file" accept="image/*" multiple hidden id="wbImgUp" /></label>
              <button class="tool-btn" id="wbAt">@ 资产库</button>
              <span class="tool-sep"></span>
              <button class="tool-chip" id="wbRatio" title="切换画幅">${ratioOf(p)}</button>
              <select class="tool-select" id="wbDuration" title="视频秒数">
                ${[5, 8, 10, 12, 15].map(n => `<option value="${n}" ${durationOf(p) === n ? "selected" : ""}>${n}s</option>`).join("")}
              </select>
              <button class="wb-send" id="wbGen">生成 ${icon("arrowRight", 15)}</button>
            </div>
          </div>
        </section>

        <aside class="wb-assets" id="wbAssets" hidden>
          <div class="wba-head"><b>账号资产 · 点击插入</b><button class="icon-btn" id="wbAssetsClose">${icon("x", 14)}</button></div>
          <input class="input dark" id="wbAssetsSearch" placeholder="搜索素材" />
          <div class="wba-list" id="wbAssetsList"></div>
        </aside>
      </div>`;

    wireStepper(root);
    drawFlow();
    wireAll();
    // 恢复草稿或默认提示词
    const key = `${p.id}:${segIdx}`;
    const inp = $("#wbInput", root);
    if (draftBySeg.has(key)) inp.innerHTML = draftBySeg.get(key);
    else inp.textContent = seg.prompt || "";
  };

  const ratioOf = pp => ["9:16", "16:9"].includes(pp.artifacts.ratio) ? pp.artifacts.ratio : "9:16";
  const durationOf = pp => Math.max(5, Math.min(15, Number(pp.artifacts.renderDuration || 15)));

  function drawFlow() {
    const flow = $("#wbFlow", root); if (!flow) return;
    const jobs = jobsOfSeg(segIdx);
    const wasNearBottom = flow.scrollHeight - flow.scrollTop - flow.clientHeight < 90;
    const oldTop = flow.scrollTop;
    if (!jobs.length) {
      flow.innerHTML = `<div class="wb-empty">${icon("film", 26)}<b>输入提示词，点「生成」</b><p>结果按对话流出现在这里 · 排队 / 进度 / 失败重试全程可见</p></div>`;
      return;
    }
    const inCut = new Set((p.artifacts.timeline || []).map(c => c.jobId));
    flow.innerHTML = jobs.map((j, vi) => {
      const refs = (j.refAssetIds || []).map(id => {
        const u = urlFor(id);
        return u ? `<span class="wbr"><img src="${u}"/></span>` : "";
      }).join("");
      const user = `<div class="wb-msg user"><div class="wb-bubble">${refs ? `<div class="wbr-row">${refs}</div>` : ""}${esc(j.prompt)}</div></div>`;
      let card = "";
      if (["queued", "submitted", "running"].includes(j.status)) {
        card = `<div class="gen-card running">
          <div class="gen-frame"><div class="gf-grad" style="background:${gradFor(j.prompt)}"></div>
            <div class="gf-center"><span class="spin-ring"></span><b>${j.status === "queued" ? "排队中…" : `渲染中 ${j.progress}%`}</b></div>
            <div class="gf-bar"><i style="width:${j.progress}%"></i></div></div>
          <div class="gen-meta"><span>${esc(j.ratio)}</span><span>${j.duration || 15}s</span><span>v${vi + 1}</span>
            <button class="gen-act" data-jcancel="${j.id}">取消</button></div>
        </div>`;
      } else if (j.status === "failed") {
        card = `<div class="gen-card failed">
          <div class="gen-frame fail"><div class="gf-center">${icon("alert", 18)}<b>生成失败</b><em>${esc(j.error || "")}</em></div></div>
          <div class="gen-actions"><button class="gen-act primary" data-jretry="${j.id}">${icon("refresh", 12)} 重试</button>
          ${(j.refAssetIds || []).length ? `<button class="gen-act" data-jretryclean="${j.id}">去掉参考图重试</button>` : ""}
          <button class="gen-act" data-jedit="${j.id}">重新编辑</button></div>
        </div>`;
      } else if (j.status === "canceled") {
        card = `<div class="gen-card canceled"><div class="gen-frame fail"><div class="gf-center"><b>已取消</b></div></div>
          <div class="gen-actions"><button class="gen-act" data-jretry="${j.id}">重新生成</button></div></div>`;
      } else {
        const video = j.output?.url ? `<video src="${esc(j.output.url)}" controls playsinline preload="metadata"></video>` : "";
        card = `<div class="gen-card done">
          <div class="gen-frame">${video || `<div class="gf-grad" style="background:${gradFor(j.prompt)}"></div>`}
            <div class="gf-label">${icon("film", 16)}<b>${esc(j.output?.label || `${j.duration || 15}s 片段已生成`)}</b></div>
            ${video ? "" : `<span class="gf-play">${icon("play", 16)}</span>`}</div>
          <div class="gen-meta"><span>${esc(j.ratio)}</span><span>${j.duration || 15}s</span><span>v${vi + 1}</span></div>
          <div class="gen-actions">
            <button class="gen-act" data-jregen="${j.id}">再次生成</button>
            <button class="gen-act" data-jedit="${j.id}">重新编辑</button>
            <button class="gen-act ${inCut.has(j.id) ? "added" : "primary"}" data-jcut="${j.id}">${inCut.has(j.id) ? "✓ 已在时间轴" : "加入剪辑"}</button>
          </div>
        </div>`;
      }
      return user + `<div class="wb-msg sys">${card}</div>`;
    }).join("");
    const fresh = jobs.some(j => Date.now() - j.createdAt < 1200);
    if (wasNearBottom || fresh) flow.scrollTop = flow.scrollHeight;
    else flow.scrollTop = oldTop;

    flow.querySelectorAll("[data-jretry]").forEach(b => b.addEventListener("click", () => { retryJob(b.dataset.jretry); if (p.stage === "render") setStatus(p, "running"); }));
    flow.querySelectorAll("[data-jretryclean]").forEach(b => b.addEventListener("click", () => {
      const j = state.jobs.find(x => x.id === b.dataset.jretryclean);
      if (!j) return;
      submit(j.prompt, []);
      toast("已去掉参考图重新提交");
    }));
    flow.querySelectorAll("[data-jcancel]").forEach(b => b.addEventListener("click", () => cancelJob(b.dataset.jcancel)));
    flow.querySelectorAll("[data-jedit]").forEach(b => b.addEventListener("click", () => {
      const j = state.jobs.find(x => x.id === b.dataset.jedit);
      $("#wbInput", root).textContent = j.prompt; $("#wbInput", root).focus();
    }));
    flow.querySelectorAll("[data-jregen]").forEach(b => b.addEventListener("click", () => {
      const j = state.jobs.find(x => x.id === b.dataset.jregen);
      submit(j.prompt, j.refAssetIds || []);
    }));
    flow.querySelectorAll("[data-jcut]").forEach(b => b.addEventListener("click", () => {
      const j = state.jobs.find(x => x.id === b.dataset.jcut);
      if ((p.artifacts.timeline || []).some(c => c.jobId === j.id)) return;
      p.artifacts.timeline.push({ id: uid(), jobId: j.id, name: `${segs[j.segIndex]?.name || "片段"}`, dur: j.duration || 15, trimIn: 0 });
      save("productions");
      toast("已加入剪辑时间轴");
      drawFlow();
    }));
  }

  function readComposer() {
    const editor = $("#wbInput", root);
    let text = ""; const refs = []; const seen = new Set();
    const walk = node => {
      if (node.nodeType === 3) { text += node.textContent; return; }
      if (node.nodeType === 1 && node.classList.contains("inline-chip")) {
        const id = node.dataset.id;
        const a = state.assets.find(x => x.id === id);
        text += "@" + (a ? a.name : node.textContent.replace("×", "")) + " ";
        if (a && !seen.has(id)) { seen.add(id); refs.push(id); }
        return;
      }
      if (node.nodeName === "BR") { text += "\n"; return; }
      node.childNodes.forEach(walk);
    };
    editor.childNodes.forEach(walk);
    return { text: text.replace(/[ \t]+\n/g, "\n").trim(), refs };
  }

  function insertChip(asset) {
    const editor = $("#wbInput", root);
    editor.focus();
    const chip = document.createElement("span");
    chip.className = "inline-chip";
    chip.contentEditable = "false";
    chip.dataset.id = asset.id;
    chip.innerHTML = `<span class="ic-thumb">${thumbHtml(asset)}</span><span class="ic-name">${esc(asset.name)}</span><span class="ic-x">×</span>`;
    chip.querySelector(".ic-x").addEventListener("click", e => { e.preventDefault(); chip.remove(); });
    const sel = window.getSelection();
    let range;
    if (sel.rangeCount && editor.contains(sel.getRangeAt(0).startContainer)) range = sel.getRangeAt(0);
    else { range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); }
    range.deleteContents();
    range.insertNode(chip);
    const space = document.createTextNode(" ");
    chip.after(space);
    range.setStartAfter(space); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
  }

  function submit(promptText, refIds) {
    const seg = segs[segIdx];
    createJob({
      kind: "video", productionId: p.id, segIndex: segIdx, segName: seg.name,
      prompt: promptText, refAssetIds: refIds, ratio: $("#wbRatio", root).textContent.trim(), duration: durationOf(p)
    });
    if (p.stage === "render" || p.stage === "prompts" || p.stage === "boards") setStage(p, "render", "running");
    drawFlow();
  }

  function wireAll() {
    $$(".wbs-item", root).forEach(b => b.addEventListener("click", () => {
      const key = `${p.id}:${segIdx}`;
      draftBySeg.set(key, $("#wbInput", root).innerHTML);
      segIdx = +b.dataset.seg;
      segIdxByProd.set(p.id, segIdx);
      draw();
    }));

    const asm = $("#wbAssemble", root);
    if (asm) asm.addEventListener("click", () => {
      const r = autoAssemble(p);
      if (p.stage === "render") setStage(p, "cut", "pending");
      toast(`智能拼接完成：${r.clips} 段 + ${r.subs} 条字幕`);
      go("studio", "cut");
    });
    $("#wbToCut", root).addEventListener("click", () => go("studio", "cut"));

    $("#wbRatio", root).addEventListener("click", () => {
      const order = ["9:16", "16:9"];
      const cur = order.indexOf($("#wbRatio", root).textContent.trim());
      const next = order[(cur + 1) % order.length];
      $("#wbRatio", root).textContent = next;
      p.artifacts.ratio = next; save("productions");
    });
    $("#wbDuration", root).addEventListener("change", e => {
      p.artifacts.renderDuration = Number(e.target.value) || 15;
      save("productions");
      const title = root.querySelector(".wb-toolbar h2");
      if (title) title.textContent = `${segs[segIdx].name} · ${durationOf(p)}s`;
    });

    $("#wbGen", root).addEventListener("click", () => {
      const { text, refs } = readComposer();
      if (!text) { toast("请输入视频提示词"); return; }
      const key = `${p.id}:${segIdx}`;
      draftBySeg.delete(key);
      $("#wbInput", root).innerHTML = "";
      submit(text, refs);
    });
    $("#wbInput", root).addEventListener("keydown", e => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("#wbGen", root).click(); }
    });

    // @ 提及
    $("#wbInput", root).addEventListener("input", () => {
      const menu = $("#wbMention", root);
      const sel = window.getSelection();
      if (!sel.rangeCount) { menu.hidden = true; return; }
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== 3) { menu.hidden = true; return; }
      const before = node.textContent.slice(0, range.startOffset);
      const m = before.match(/@([^@\s]*)$/);
      if (!m) { menu.hidden = true; return; }
      const q = m[1].toLowerCase();
      const list = accountAssets(p.accountId).filter(a => a.name.toLowerCase().includes(q)).slice(0, 8);
      if (!list.length) { menu.hidden = true; return; }
      menu.innerHTML = list.map(a => `<button class="wbm-item" data-mid="${a.id}"><span class="wbm-thumb">${thumbHtml(a)}</span><span><b>${esc(a.name)}</b><em>${esc(a.type)}</em></span></button>`).join("");
      menu.hidden = false;
      menu.querySelectorAll("[data-mid]").forEach(it => it.addEventListener("click", () => {
        const a = state.assets.find(x => x.id === it.dataset.mid);
        const r = document.createRange();
        r.setStart(node, range.startOffset - m[0].length);
        r.setEnd(node, range.startOffset);
        r.deleteContents();
        sel.removeAllRanges(); sel.addRange(r);
        insertChip(a);
        menu.hidden = true;
      }));
    });

    // 粘贴 / 上传图片 → 资产 + 芯片
    $("#wbInput", root).addEventListener("paste", async e => {
      const items = Array.from(e.clipboardData.items).filter(i => i.type.startsWith("image/"));
      if (items.length) {
        e.preventDefault();
        for (const it of items) { const a = await addAssetFromFile(p.accountId, it.getAsFile(), { tags: ["参考图"] }); insertChip(a); }
        return;
      }
      e.preventDefault();
      const txt = e.clipboardData.getData("text/plain");
      document.execCommand("insertText", false, txt);
    });
    $("#wbImgUp", root).addEventListener("change", async e => {
      for (const f of Array.from(e.target.files)) { const a = await addAssetFromFile(p.accountId, f, { tags: ["参考图"] }); insertChip(a); }
      e.target.value = "";
    });
    const composer = $("#wbComposer", root);
    ["dragenter", "dragover"].forEach(ev => composer.addEventListener(ev, e => { e.preventDefault(); composer.classList.add("drag-over"); }));
    ["dragleave", "drop"].forEach(ev => composer.addEventListener(ev, e => { e.preventDefault(); composer.classList.remove("drag-over"); }));
    composer.addEventListener("drop", async e => {
      for (const f of Array.from(e.dataTransfer.files).filter(x => x.type.startsWith("image/"))) {
        const a = await addAssetFromFile(p.accountId, f, { tags: ["参考图"] });
        insertChip(a);
      }
    });

    // 资产面板
    const panel = $("#wbAssets", root);
    $("#wbAt", root).addEventListener("click", () => { panel.hidden = false; drawAssets(""); });
    $("#wbAssetsClose", root).addEventListener("click", () => panel.hidden = true);
    $("#wbAssetsSearch", root).addEventListener("input", e => drawAssets(e.target.value));
    function drawAssets(q) {
      const list = accountAssets(p.accountId).filter(a => a.name.toLowerCase().includes(q.toLowerCase()));
      $("#wbAssetsList", root).innerHTML = list.map(a => `
        <button class="wba-item" data-aid="${a.id}">${thumbHtml(a)}<span class="wba-tag">${esc(a.type)}</span></button>`).join("") || `<div class="muted" style="padding:12px">没有素材</div>`;
      $$("#wbAssetsList [data-aid]", root).forEach(b => b.addEventListener("click", () => {
        const a = state.assets.find(x => x.id === b.dataset.aid);
        insertChip(a);
        toast("已 @ 引用：" + a.name);
      }));
    }
  }

  if (!wired) {
    wired = true;
    on("job:update", j => {
      if (!liveRoot || !liveRoot.isConnected) return;
      if (document.body.dataset.zone !== "studio") return;
      if (!liveProd || j.productionId !== liveProd.id) return;
      // 已切到别的阶段页 / 别的任务：不刷新，避免打回生成台
      if (currentRoute().page !== "render") return;
      if (liveProd.id !== state.ui.activeProductionId) return;
      // 只更新流区域与左栏状态，避免打断输入
      const flowEl = liveRoot.querySelector("#wbFlow");
      if (flowEl) (liveLight || renderRenderPageLight)();
    });
  }

  function renderRenderPageLight() {
    // 轻量刷新：重绘消息流与左栏（不动 composer）
    drawFlow();
    const segsEl = $$(".wbs-item", root);
    segs.forEach((s, i) => {
      const el = segsEl[i]; if (!el) return;
      const jobs = jobsOfSeg(i);
      const ok = jobs.filter(j => j.status === "succeeded").length;
      const running = jobs.some(j => ["queued", "submitted", "running"].includes(j.status));
      const em = el.querySelector("em");
      if (em) em.innerHTML = running ? `<i class="live-dot"></i> 生成中` : ok ? `${jobs.length} 个版本 · ${ok} 成功` : jobs.length ? `${jobs.length} 个版本` : "尚未生成";
    });
    // 全部就绪提示
    const allDone = segs.every((s, i) => jobsOfSeg(i).some(j => j.status === "succeeded"));
    if (allDone && !$("#wbAssemble", root)) draw();
  }

  draw();
}
