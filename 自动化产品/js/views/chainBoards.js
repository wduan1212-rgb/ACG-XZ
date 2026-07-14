/* 链路 · 分镜（视频）/ 图文创作台（图文）：站内图片 API + 上传补图 */

import { $, $$, esc, gradFor, fileToDataUrl, wireDropZone } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, accountById, productById, primaryProducts, primaryProductById } from "../core/store.js";
import { AI } from "../api/ai.js";
import { setStage, shotsToText } from "../domain/productions.js";
import { productionAssets as accountAssets } from "../domain/accounts.js";
import { urlFor, thumbHtml, addAssetFromDataUrl, replaceAssetBlob, removeAsset } from "../domain/assets.js";
import { polishImageForPublish as polishPublishImage } from "../domain/imagePolish.js";
import { activeProviderFor, imageApiConfigured, providerKeyFor } from "../api/providers.js";
import { maybeAdvanceAfterInput } from "../agent/orchestrator.js";
import { toast, withLoading, openLightbox, confirmModal } from "../ui/components.js";
import { currentRoute, go } from "../core/router.js";
import { stepperHtml, wireStepper } from "./studio.js?v=20260714-v79-1";

const modeBySlot = new Map(); // productionId -> "in"
const MAX_IMAGE_REFS = 5;
const DEFAULT_XHS_IMAGE_COUNT = 4;
const IMAGE_NEGATIVE_PROMPT = "负面约束：不出现页码，不出现二维码，图片右上角和左上角不要加入logo，其他位置可以正常出现logo。";

export function polishImageForPublish(dataUrl, seedText = "") {
  return polishPublishImage(dataUrl, seedText);
}

export async function urlToDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("图片 URL 下载失败：" + res.status);
  const blob = await res.blob();
  return await fileToDataUrl(blob);
}

function refIdsOf(A) {
  const ids = Array.isArray(A.sharedRefAssetIds) ? A.sharedRefAssetIds.filter(Boolean) : [];
  if (A.sharedRefAssetId && !ids.includes(A.sharedRefAssetId)) ids.unshift(A.sharedRefAssetId);
  return [...new Set(ids)].slice(0, MAX_IMAGE_REFS);
}

function refAssetsOf(A) {
  return refIdsOf(A).map(id => state.assets.find(x => x.id === id)).filter(Boolean);
}

function setRefIds(A, ids) {
  const clean = [...new Set((ids || []).filter(Boolean))].slice(0, MAX_IMAGE_REFS);
  A.sharedRefAssetIds = clean;
  A.sharedRefAssetId = clean[0] || null; // 兼容旧字段/旧部署
}

function appendRefId(A, id) {
  if (!id) return;
  setRefIds(A, [...refIdsOf(A), id]);
}

export async function providerRefsFor(A) {
  const refs = [];
  for (const a of refAssetsOf(A)) {
    const u = urlFor(a);
    let dataUrl = "";
    let publicUrl = "";
    if (/^data:/.test(u || "")) dataUrl = u;
    else if (u) {
      try {
        dataUrl = await urlToDataUrl(u);
      } catch (_) {
        if (/^https?:\/\//.test(u)) publicUrl = u;
      }
    }
    if (dataUrl || publicUrl) {
      refs.push({
        id: a.id,
        name: a.name || "参考图",
        type: a.type,
        mime: a.mime || "image/png",
        url: publicUrl,
        dataUrl
      });
    }
  }
  return refs;
}

function refNamesOf(A, extra = []) {
  return [...refAssetsOf(A).map(a => a.name), ...extra].filter(Boolean).slice(0, MAX_IMAGE_REFS);
}

export function enrichPromptWithRefs(prompt, A) {
  const names = refNamesOf(A);
  if (!names.length) return prompt || "";
  const body = String(prompt || "").replace(/负面约束\s*[:：][\s\S]*$/g, "").trim();
  const refNote = `参考图：本次提供 ${names.length} 张参考图（${names.join("、")}），以本次提示词的主题和文字内容为准。`;
  return `${body}\n\n${refNote}\n\n${IMAGE_NEGATIVE_PROMPT}`.trim();
}

function normalizeImageWorkshopText(text = "") {
  return String(text || "")
    .replace(/小红书竖版3:4（1080×1440）\s*[，,。；;]?\s*（1080×1440）/g, "小红书竖版3:4（1080×1440）")
    .replace(/小红书竖版3:4（1080×1440）\s*[，,。；;]?\s*画面以小红书竖版3:4（1080×1440）为主/g, "小红书竖版3:4（1080×1440）")
    .replace(/画面以小红书竖版3:4（1080×1440）为主/g, "画面按小红书竖版3:4（1080×1440）出图")
    .replace(/\s+/g, " ")
    .trim();
}

function ratioFromImagePrompt(text = "", fallback = "3:4") {
  const s = String(text || "");
  if (/9\s*[:：]\s*16|1080\s*[x×]\s*1920|竖屏\s*9\s*[:：]\s*16/.test(s)) return "9:16";
  if (/16\s*[:：]\s*9|1920\s*[x×]\s*1080|横屏\s*16\s*[:：]\s*9/.test(s)) return "16:9";
  if (/4\s*[:：]\s*3|1440\s*[x×]\s*1080/.test(s)) return "4:3";
  if (/1\s*[:：]\s*1|1024\s*[x×]\s*1024|1080\s*[x×]\s*1080|正方形(?:画布|尺寸|图片|配图)|方形(?:画布|图片|配图)/.test(s)) return "1:1";
  if (/3\s*[:：]\s*4|1080\s*[x×]\s*1440|小红书竖版|小红书笔记/.test(s)) return "3:4";
  return fallback;
}

function promptForImageModel(text = "") {
  const bannedLabels = "种草|痛点|共鸣|构图|封面|首图|痛点引入|问题引入|关键步骤|结果对比|总结收束|图\\d+|第\\d+张|步骤一|步骤二|步骤三";
  const cleaned = normalizeImageWorkshopText(text)
    .replace(new RegExp(`图上文字[：:]\\s*[「“"]?(?:${bannedLabels})[」”"]?`, "g"), "图上文字按本页标题与副标题生成")
    .replace(new RegExp(`图片任务[：:]\\s*(?:${bannedLabels})[，,。；;]?`, "g"), "图片任务：")
    .replace(new RegExp(`\\b(?:${bannedLabels})[：:]`, "g"), "")
    .replace(/负面约束\s*[:：][\s\S]*$/g, IMAGE_NEGATIVE_PROMPT);
  return /负面约束\s*[:：]/.test(cleaned)
    ? cleaned
    : `${cleaned}\n\n${IMAGE_NEGATIVE_PROMPT}`;
}

export function renderSlotsPage(root, p, isImg) {
  const acc = accountById(p.accountId);
  const A = isImg ? p.artifacts.images : p.artifacts.boards;
  const page = isImg ? "images" : "boards";
  let genMode = "in";
  modeBySlot.set(p.id, "in");
  const S = p.artifacts.script;
  const products = primaryProducts();
  const allowCustomCopy = isImg && !p.batchId && p.origin !== "agent";
  if (isImg) {
    p.artifacts.copy = p.artifacts.copy || { title: "", body: "" };
    S.productId = primaryProductById(S.productId || "dumate")?.id || "dumate";
    S.imageCount = S.imageCount || DEFAULT_XHS_IMAGE_COUNT;
    S.direction = S.direction || "";
    S.useOnlineTrends = false;
    if (isImg) A.customCopyMode = true;
    else if (allowCustomCopy && A.customCopyMode == null) A.customCopyMode = true;
    A.customCopyMode = isImg ? true : (allowCustomCopy ? A.customCopyMode !== false : false);
    if (p.stage === "script") p.stage = "images";
  }

  // 槽位缺失时按脚本初始化
  if (!(A.items || []).length && (p.artifacts.script.shots || []).length) {
    A.items = p.artifacts.script.shots.map((s, i) => ({ title: s.idea || `${isImg ? "图" : "分镜"}${i + 1}`, visual: s.visual || "", prompt: "", assetId: null, status: "idle" }));
    save("productions");
  }

  function syncImageFactoryDraft() {
    if (!isImg) return;
    const count = $("#imgCount", root);
    if (count) S.imageCount = Math.max(1, Math.min(12, parseInt(count.value, 10) || S.imageCount || DEFAULT_XHS_IMAGE_COUNT));
    S.useOnlineTrends = false;
  }

  function syncCopyDraft() {
    if (!isImg) return;
    const C = p.artifacts.copy || (p.artifacts.copy = { title: "", body: "" });
    const title = $("#imgCopyTitle", root);
    const body = $("#imgCopyBody", root);
    if (title) C.title = title.value.trim();
    if (body) C.body = body.value.trim();
  }

  function splitCopyBeats(title = "", body = "", count = DEFAULT_XHS_IMAGE_COUNT) {
    const withoutTags = String(body || "").replace(/#[^\s#]+/g, " ");
    const sentences = withoutTags
      .replace(/\n+/g, "。")
      .split(/[。！？!?；;]+/)
      .map(x => x.replace(/\s+/g, " ").trim())
      .filter(x => x && x.length > 4);
    const first = title || sentences[0] || "本次主题";
    const beats = [first, ...sentences.filter(x => x !== first)];
    return Array.from({ length: count }, (_, i) => beats[i] || beats[beats.length - 1] || first);
  }

  function buildCustomCopyShots(copy, count, product) {
    const title = (copy?.title || "").trim();
    const body = (copy?.body || copy?.copy || "").trim();
    const productName = product?.shortName || product?.name || "百度搭子";
    const beats = splitCopyBeats(title, body, count);
    if (count === 1) {
      return [{
        idea: title || beats[0],
        visual: `做成一张有序信息图：上部是发布标题的强视觉入口，中部用2到3个${productName}相关的关键动作、证据或流程卡解释正文，底部用一句结论收束；不出现页码、内页或拆页字样。`,
        line: title || beats[0]
      }];
    }
    return beats.map((beat, i) => {
      const shortBeat = beat.slice(0, i === 0 ? 36 : 46);
      if (i === 0) {
        return {
          idea: title || shortBeat,
          visual: `围绕发布标题「${title || shortBeat}」做强点击入口，主视觉和短副标题必须服务这篇文案，不引入文案外的新主题。`,
          line: title || shortBeat
        };
      }
      if (count === 2 && i === 1) {
        return {
          idea: shortBeat,
          visual: `围绕发布文案里的信息「${shortBeat}」做一张干货信息图，用${productName}相关的具体动作、步骤卡、证据或可复核结果组织内容，层级清楚但不堆小字。`,
          line: shortBeat
        };
      }
      return {
        idea: shortBeat,
        visual: `围绕发布文案里的信息「${shortBeat}」展开，用${productName}相关的真实办公动作、流程卡片、结果对照或可复核清单表达。`,
        line: shortBeat
      };
    });
  }

  const draw = () => {
    syncImageFactoryDraft();
    const items = A.items || [];
    const C = p.artifacts.copy || { title: "", body: "" };
    const customCopyMode = allowCustomCopy && !!A.customCopyMode;
    const got = items.filter(x => x.assetId).length;
    const refs = refAssetsOf(A);
    const trendPanel = "";
    const flowTitle = isImg
      ? (customCopyMode ? "自定义文案 → 图卡提示词 → 一键生成 / 上传补图" : "创作内容 → 文案标题 → 图卡提示词 → 一键生成 / 上传补图")
      : "按脚本逐镜头出分镜图";
    root.innerHTML = `
      ${stepperHtml(p, page)}
      <div class="chain-page solo">
        <div class="chain-main">
          <div class="page-head">
            <div><div class="eyebrow">${isImg ? "图文链路 · 图文创作台" : "视频链路 · 分镜图"}</div>
            <h2>${flowTitle} <span class="head-count">${got}/${items.length}</span></h2></div>
            <div class="head-actions">
              ${isImg ? "" : `<button class="btn ghost" id="cbSkip">跳过此步 ${icon("arrowRight", 13)}</button>`}
              <button class="btn primary" id="cbNext">下一步：${isImg ? "审核" : "提示词"} ${icon("arrowRight", 14)}</button>
            </div>
          </div>

          ${isImg ? `
          ${trendPanel ? "" : `<div class="copy-inline card ${customCopyMode ? "is-custom-copy" : ""}">
            <div class="copy-inline-head">
              <div><b>${icon("image", 14)} 图文创作台</b><em>${customCopyMode ? "标题、正文和图卡提示词在这里一次准备" : "文案先生成，图卡提示词会轻量呼应；可在这里直接微调"}</em></div>
              <button class="btn gen sm" id="imgFactoryGen">${icon("spark", 13)} 按文案生成图卡提示词</button>
            </div>
            <label class="field">标题
              <input class="input" id="imgCopyTitle" value="${esc(C.title || "")}" required placeholder="${customCopyMode ? "必填标题：填写发布标题，图片封面会完整围绕它" : "必填标题：生成后可编辑"}" />
            </label>
            <label class="field">正文
              <textarea class="input" id="imgCopyBody" rows="5" placeholder="${customCopyMode ? "粘贴或写入最终正文；系统会按正文含义拆成图卡提示词。" : "发布文案会随交付包带出；生成图卡前会优先准备它。"}">${esc(C.body || "")}</textarea>
            </label>
          </div>`}
          ${trendPanel}` : ""}

          <div class="refbar card img-ref-generation" id="cbRefbar">
            <div class="refbar-left">
              <b>${icon("star", 13)} 统一参考图</b>
              <em>生成和上传补图都会保留这些参考（最多 5 张：logo / 角色版 / 界面截图）· 可拖图到此</em>
            </div>
            <div class="refbar-chip">${refs.length
              ? refs.map(a => `<span class="ref-chip">${thumbHtml(a)}<span>${esc(a.name)}</span><button class="ref-x" data-ref-rm="${a.id}">${icon("x", 11)}</button></span>`).join("")
              : `<span class="muted">未设置（建议）</span>`}</div>
            <div class="refbar-actions">
              <button class="btn ghost sm" id="cbRefPick">从资产选择</button>
              <label class="btn ghost sm">上传<input type="file" accept="image/*" multiple hidden id="cbRefUp" /></label>
              ${isImg ? `<button class="btn gen" id="cbGenAllImages">${icon("spark", 15)} 一键生成全部图片</button>` : ""}
            </div>
          </div>
          <div id="cbRefChooser" class="ref-chooser card" hidden></div>

          ${isImg ? "" : `<div class="inhouse-controls">
            <button class="btn gen" id="cbGenPrompts">${icon("spark", 15)} 按脚本生成分镜图提示词</button>
            <span class="muted">${imageApiConfigured() ? "" : "图片 API 未接入"}</span>
          </div>`}

          <div class="slot-cards" id="cbCards">${items.map((it, i) => slotCard(it, i, isImg)).join("") ||
            `<div class="empty-state slim">${icon("image", 22)}<b>${isImg ? "先在上方图文创作台生成图卡结构" : "先回脚本页生成脚本"}</b><p>每${isImg ? "张图" : "个镜头"}会在这里生成一个出图槽位</p></div>`}</div>
        </div>
      </div>`;
    wireStepper(root);
    wire();
  };

  function slotCard(it, i, img) {
    const u = it.assetId ? urlFor(it.assetId) : null;
    const refined = img && it.assetId;
    const loading = it.status === "loading";
    const shownPrompt = img ? normalizeImageWorkshopText(it.prompt || "") : (it.prompt || "");
    const shownVisual = img ? normalizeImageWorkshopText(it.visual || "") : (it.visual || "");
    return `<div class="slot-card card ${img ? "is-image-slot" : ""} ${loading ? "is-generating" : ""}" data-slot="${i}">
      <span class="sc-num">${i + 1}</span>
      <div class="sc-text">
        <div class="sc-line">${esc(it.title || "")}<em>${esc(shownVisual.slice(0, 60))}</em></div>
        <div class="sc-prompt" contenteditable="true" data-prompt="${i}" data-ph="点右侧按钮生成图片，或手写提示词">${esc(shownPrompt)}</div>
        ${it.error ? `<div class="sc-error">${esc(it.error)}</div>` : ""}
      </div>
      <div class="sc-thumb" data-thumb="${i}">
        ${u ? `<img src="${u}"/>` : it.status === "loading"
          ? `<div class="sc-loading"><span class="spin-dot"></span></div>`
          : it.status === "done" ? `<div class="sc-empty">待图片</div>`
          : `<div class="sc-empty"><span>3:4</span><em>待生成</em></div>`}
        ${refined ? `<span class="sc-badge">已精修</span>` : ""}
      </div>
      <div class="sc-side">
        <button class="btn ghost sm" data-gen="${i}">${u || it.status === "done" ? "重新生成" : "生成此图"}</button>
        <label class="btn ghost sm">上传<input type="file" accept="image/*" hidden data-up="${i}" /></label>
      </div>
    </div>`;
  }

  const routePage = isImg ? "images" : "boards";
  const canRedrawCurrent = () => {
    const r = currentRoute();
    return root.isConnected && r.zone === "studio" && r.page === routePage && state.ui.activeProductionId === p.id;
  };

  function startImageRun(mode, index = null) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    A.imageRun = { token, mode, index, startedAt: Date.now() };
    return token;
  }

  function imageRunActive(token, mode = "") {
    if (!token) return true;
    return A.imageRun?.token === token && (!mode || A.imageRun.mode === mode);
  }

  function clearOtherLoadingSlots(index) {
    (A.items || []).forEach((x, j) => {
      if (j !== index && x.status === "loading" && !x.assetId) {
        x.status = "idle";
        x.error = "";
      }
    });
  }

  function wire() {
    if (isImg) {
      $("#imgCount", root)?.addEventListener("input", e => {
        S.imageCount = Math.max(1, Math.min(12, parseInt(e.target.value, 10) || DEFAULT_XHS_IMAGE_COUNT));
        save("productions");
      });
      $("#imgFactoryGen", root)?.addEventListener("click", e => withLoading(e.currentTarget, generateImageWorkshop, "生成中…"));
      $("#imgCopyTitle", root)?.addEventListener("input", e => { p.artifacts.copy.title = e.target.value; save("productions"); });
      $("#imgCopyBody", root)?.addEventListener("input", e => { p.artifacts.copy.body = e.target.value; save("productions"); });
      $("#imgCopyGen", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
        await generateImageCopy({ force: true });
        draw();
      }, "生成文案中…"));
    }

    $$(".mode-tab", root).forEach(t => t.addEventListener("click", () => {
      syncImageFactoryDraft();
      genMode = "in"; modeBySlot.set(p.id, "in");
    }));

    // 统一参考
    const refbar = $("#cbRefbar", root);
    wireDropZone(refbar, async files => { await setRefsFromFiles(files); });
    $$("[data-ref-rm]", root).forEach(btn => btn.addEventListener("click", () => {
      syncImageFactoryDraft();
      setRefIds(A, refIdsOf(A).filter(id => id !== btn.dataset.refRm));
      save("productions"); draw();
    }));
    $("#cbRefUp", root).addEventListener("change", async e => { syncImageFactoryDraft(); await setRefsFromFiles(e.target.files); e.target.value = ""; });
    $("#cbRefPick", root).addEventListener("click", () => {
      const box = $("#cbRefChooser", root);
      if (!box.hidden) { box.hidden = true; return; }
      const assets = accountAssets(acc.id).filter(a => a.type === "图片");
      box.innerHTML = assets.length ? `<div class="ref-grid">${assets.map(a => `
        <div class="ref-item ${refIdsOf(A).includes(a.id) ? "is-picked" : ""}" data-ref="${a.id}" role="button" tabindex="0">${thumbHtml(a)}<span>${esc(a.name)}</span>${/(已发布生成图|站内生成|笔记图)/.test((a.tags || []).join(" ")) ? "" : `<button class="ref-del" data-ref-del="${a.id}" title="删除参考图">${icon("trash", 11)}</button>`}</div>`).join("")}</div>`
        : `<div class="muted" style="padding:10px">该账号还没有图片资产，先上传一张</div>`;
      box.hidden = false;
      box.querySelectorAll("[data-ref-del]").forEach(b => b.addEventListener("click", async e => {
        e.stopPropagation();
        const a = state.assets.find(x => x.id === b.dataset.refDel);
        const ok = await confirmModal({ title: `删除参考图「${a?.name || "未命名图片"}」？`, body: "会从资产库移除，并从当前参考图选择中摘掉。", danger: true, okText: "删除" });
        if (!ok) return;
        syncImageFactoryDraft();
        setRefIds(A, refIdsOf(A).filter(id => id !== b.dataset.refDel));
        await removeAsset(b.dataset.refDel);
        save("productions");
        draw();
      }));
      box.querySelectorAll("[data-ref]").forEach(b => b.addEventListener("click", () => {
        syncImageFactoryDraft();
        appendRefId(A, b.dataset.ref); save("productions"); draw();
      }));
    });

    async function setRefsFromFiles(files) {
      syncImageFactoryDraft();
      const imgs = Array.from(files || []).filter(f => f && f.type.startsWith("image/"));
      if (!imgs.length) return;
      for (const f of imgs.slice(0, MAX_IMAGE_REFS)) {
        if (refIdsOf(A).length >= MAX_IMAGE_REFS) break;
        const dataUrl = await fileToDataUrl(f);
        const a = await addAssetFromDataUrl(acc.id, { name: f.name.replace(/\.[^.]+$/, ""), tags: ["参考图"], dataUrl });
        appendRefId(A, a.id);
      }
      save("productions");
      toast(`已添加 ${refIdsOf(A).length}/${MAX_IMAGE_REFS} 张统一参考图`);
      draw();
    }

    $("#cbGenAllImages", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
        const runToken = startImageRun("all");
        const items = A.items || [];
        if (!items.length) {
          await generateImageWorkshop();
        }
        const fresh = A.items || [];
        if (!fresh.length) { toast("还没有可生成的图卡"); return; }
        if (!imageApiConfigured()) { toast("图片 API 未接入，请先配置站内图片服务，或使用槽位上传补图", "error"); return; }
        fresh.forEach(x => {
          if (imageRunActive(runToken, "all") && x.prompt && !x.assetId) {
            x.status = "loading";
            x.error = "";
          }
        });
        save("productions");
        if (canRedrawCurrent()) draw();
        let ok = 0;
        for (let i = 0; i < fresh.length; i++) {
          if (!imageRunActive(runToken, "all")) {
            toast("已切换为单张生成，停止全量队列");
            return;
          }
          if (!fresh[i].prompt) continue;
          await generateOneImage(i, { redraw: true, silent: true, runToken, runMode: "all" });
          if (fresh[i].assetId) ok++;
        }
        if (!imageRunActive(runToken, "all")) return;
        save("productions");
        if (canRedrawCurrent()) draw();
        toast(ok ? "已生成" : "没有图片生成成功，请检查错误提示", ok ? "" : "error");
    }, "生成图片中…"));

    $("#cbGenPrompts", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
        const shots = p.artifacts.script.shots || [];
        if (!shots.length) { toast(isImg ? "先在图文创作台生成图卡结构" : "先回脚本页生成脚本"); return; }
        const sharedRefs = refAssetsOf(A);
        if (isImg) {
          const styleRef = acc.imageStyleAssetId ? state.assets.find(x => x.id === acc.imageStyleAssetId) : null;
          const res = await AI.generateImagePrompts({
            script: shotsToText(shots, true),
            account: acc,
            style: p.artifacts.script.style,
            imageTemplate: acc.imagePromptTemplate || "",
            styleRefName: refNamesOf(A, [styleRef?.name]).join("、"),
            imageCount: p.artifacts.script.imageCount || (A.items || []).length || shots.length || DEFAULT_XHS_IMAGE_COUNT,
            product: productById(p.artifacts.script.productId),
            topic: p.topic,
            copy: p.artifacts.copy
          });
          A.items = (res.shots || []).map((s, i) => ({
            title: s.title || `图${i + 1}`, visual: (shots[i] || {}).visual || "", prompt: s.prompt || "", ui: !!s.ui,
            assetId: (A.items[i] || {}).assetId || null, status: (A.items[i] || {}).assetId ? "done" : "idle"
          }));
        } else {
          const res = await AI.generateStoryboardPrompts({ shots, account: acc, style: p.artifacts.script.style, sharedRefName: sharedRefs.map(x => x.name).join("、"), product: productById(p.artifacts.script.productId || "dumate") });
          A.items = shots.map((s, i) => ({
            title: s.idea || `分镜${i + 1}`, visual: s.visual || "",
            prompt: (res.shots[i] || {}).prompt || AI.fallbackStoryboardPrompt(s, acc, p.artifacts.script.style, sharedRefs.map(x => x.name).join("、")),
            assetId: (A.items[i] || {}).assetId || null, status: (A.items[i] || {}).assetId ? "done" : "idle"
          }));
        }
        save("productions");
        draw();
        toast(AI.sourceNote(`已生成 ${A.items.length} 条提示词`));
    }, "生成中…"));

    // 槽位编辑/上传/站内生成
    $$("[data-prompt]", root).forEach(el => el.addEventListener("blur", () => {
      const it = A.items[+el.dataset.prompt];
      if (it) { it.prompt = el.textContent.trim(); save("productions"); }
    }));
    $$("[data-up]", root).forEach(inp => inp.addEventListener("change", async e => {
      const f = e.target.files[0]; if (!f) return;
      await fillSlot(+inp.dataset.up, f);
      draw();
    }));
    $$("[data-gen]", root).forEach(b => b.addEventListener("click", async e => {
      e.preventDefault();
      e.stopPropagation();
      const index = +b.dataset.gen;
      const runToken = startImageRun("single", index);
      clearOtherLoadingSlots(index);
      save("productions");
      if (canRedrawCurrent()) draw();
      await generateOneImage(index, { single: true, runToken, runMode: "single" });
    }));
    $$(".sc-thumb img", root).forEach(im => im.addEventListener("click", () => openLightbox(im, im.src, "")));

    // 下一步
    $("#cbNext", root).addEventListener("click", () => {
      const items = A.items || [];
      const got = items.filter(x => x.assetId).length;
      if (isImg) {
        if (!got) { toast("还没有上传任何成图（至少上传 1 张）"); return; }
        if (!(p.artifacts.copy.body || "").trim()) { toast("先生成或填写发布文案"); return; }
        if (!(p.artifacts.copy.title || "").trim()) p.artifacts.copy.title = p.title || p.topic || "未命名内容";
        if (p.stage === "images" || p.stage === "copy") setStage(p, "review", "pending");
        go("studio", "review");
      } else {
        if (p.stage === "boards" && got === items.length && items.length) maybeAdvanceAfterInput(p);
        else if (p.stage === "boards") setStage(p, "prompts", (p.artifacts.prompts || []).length ? "done" : "pending");
        go("studio", "prompts");
      }
    });
    const skip = $("#cbSkip", root);
    if (skip) skip.addEventListener("click", () => {
      if (p.stage === "boards") setStage(p, "prompts", "pending");
      go("studio", "prompts");
    });
  }

  async function fillSlot(i, file) {
    const it = A.items[i]; if (!it) return;
    let dataUrl = await fileToDataUrl(file);
    if (isImg) dataUrl = await polishImageForPublish(dataUrl, `${p.id}-${i}-${it.title || ""}-${p.topic || ""}`);
    if (it.assetId) {
      await replaceAssetBlob(it.assetId, dataUrl);
      if (isImg) {
        const asset = state.assets.find(a => a.id === it.assetId);
        if (asset) asset.tags = Array.from(new Set([...(asset.tags || []), "笔记图", "发布前精修"]));
        save("assets");
      }
    } else {
      const a = await addAssetFromDataUrl(acc.id, {
        name: `${isImg ? "笔记图" : "分镜图"}${String(i + 1).padStart(2, "0")}_${(p.title || p.topic || "").slice(0, 6)}`,
        tags: isImg ? ["笔记图", "发布前精修"] : ["分镜图"], dataUrl
      });
      it.assetId = a.id;
    }
    it.status = "done";
    save("productions");
    const complete = (A.items || []).every(x => x.assetId);
    if (complete && p.stageStatus === "needs_input") maybeAdvanceAfterInput(p);
    toast(`${isImg ? "已上传并完成发布前精修" : "已上传"} ${i + 1}/${A.items.length}${complete ? " ✓ 全部就位" : ""}`);
  }

  async function generateOneImage(i, opts = {}) {
    const { redraw = true, silent = false, single = false, runToken = "", runMode = "" } = opts;
    if (!imageRunActive(runToken, runMode)) return;
    const it = A.items[i];
    if (!it) return;
    if (!it.prompt && isImg) {
      if (single) {
        toast("这张图还没有提示词，先点「生成图卡结构与提示词」");
        return;
      }
      await generateImageWorkshop();
    }
    const fresh = A.items[i];
    if (!fresh || !fresh.prompt) { toast("这张图还没有提示词，先生成图卡结构"); return; }
    if (!imageRunActive(runToken, runMode)) return;
    if (runMode === "single") clearOtherLoadingSlots(i);
    fresh.status = "loading";
    fresh.error = "";
    if (redraw && canRedrawCurrent()) draw();
    try {
      const provider = activeProviderFor("image");
      const key = providerKeyFor("image", provider);
      if (!imageApiConfigured() || provider?.mock) {
        throw new Error("图片 API 未接入：请配置站内图片服务，或使用槽位上传补图");
      } else {
        const finalPrompt = enrichPromptWithRefs(promptForImageModel(fresh.prompt), A);
        const r = await provider.submit({
          prompt: finalPrompt,
          refs: await providerRefsFor(A),
          ratio: ratioFromImagePrompt(finalPrompt, "3:4"),
          apiKey: key?.secret,
          endpoint: key?.provider,
          model: key?.model || "custom-imagemodel-gt"
        });
        const out = await provider.poll(r.providerRef);
        if (!imageRunActive(runToken, runMode)) return;
        if (out.status !== "succeeded" || !out.output?.dataUrl) throw new Error(out.error || "图片生成未返回结果");
        const dataUrl = out.output.dataUrl.startsWith("data:")
          ? out.output.dataUrl
          : await urlToDataUrl(out.output.dataUrl);
        const polished = isImg ? await polishImageForPublish(dataUrl, `${p.id}-inhouse-${i}-${p.topic || ""}`) : dataUrl;
        const a = await addAssetFromDataUrl(acc.id, {
          name: `站内笔记图${String(i + 1).padStart(2, "0")}_${(fresh.title || p.title || "").slice(0, 10)}`,
          tags: ["笔记图", "站内生成", "发布前精修"],
          dataUrl: polished
        });
        fresh.assetId = a.id;
        fresh.status = "done";
        if (!silent) toast(`第 ${i + 1} 张已生成并精修入库`);
      }
    } catch (e) {
      if (!imageRunActive(runToken, runMode)) return;
      fresh.status = "failed";
      fresh.error = e.message || String(e);
      toast("图片生成失败：" + fresh.error, "error");
    }
    save("productions");
    if (redraw && canRedrawCurrent()) draw();
  }

  async function handleReturn(files) {
    const imgs = Array.from(files).filter(f => f.type.startsWith("image/"));
    if (!imgs.length) return;
    for (const f of imgs) {
      const slot = (A.items || []).findIndex(x => !x.assetId);
      if (slot < 0) {
        let dataUrl = await fileToDataUrl(f);
        if (isImg) dataUrl = await polishImageForPublish(dataUrl, `${p.id}-extra-${f.name}-${p.topic || ""}`);
        await addAssetFromDataUrl(acc.id, { name: `上传补图_${f.name.replace(/\.[^.]+$/, "").slice(0, 10)}`, tags: isImg ? ["笔记图", "上传补图", "发布前精修"] : ["分镜图", "上传补图"], dataUrl });
      } else {
        await fillSlot(slot, f);
      }
    }
    if (canRedrawCurrent()) draw();
  }

  async function generateImageCopy(opts = {}) {
    const {
      force = false,
      topicOverride = "",
      shotsOverride = null,
      productOverride = null,
      styleOverride = "",
      trendPrep = null,
      trendGuide = ""
    } = opts;
    const C = p.artifacts.copy;
    const shots = shotsOverride || S.shots || p.artifacts.script.shots || [];
    const product = productOverride || productById(S.productId || "dumate");
    const style = styleOverride || S.style || acc.styleProfile || "";
    const topicForCopy = topicOverride || p.topic || S.direction || "";
    S.useOnlineTrends = false;
    S.trendPrep = null;
    S.trendGuide = "";
    if (C.referenceRewrite) delete C.referenceRewrite;
    if (!force && (C.title || "").trim() && (C.body || "").trim()) {
      return C;
    }
    if (!shots.length) return C;
    const res = await AI.generateCopy({
      topic: topicForCopy,
      shots,
      account: acc,
      style,
      kind: "image",
      product,
      useOnlineTrends: false,
      trendGuide: "",
      trendPrep: null
    });
    C.title = res.title || C.title || p.title || p.topic || "";
    C.body = res.copy || C.body || "";
    const titleInput = $("#imgCopyTitle", root);
    const bodyInput = $("#imgCopyBody", root);
    if (titleInput) titleInput.value = C.title;
    if (bodyInput) bodyInput.value = C.body;
    save("productions");
    return C;
  }

  async function generateImageWorkshop() {
    await generateCustomCopyImageWorkshop();
  }

  async function generateCustomCopyImageWorkshop() {
    syncCopyDraft();
    const C = p.artifacts.copy || (p.artifacts.copy = { title: "", body: "" });
    const title = (C.title || "").trim();
    const body = (C.body || "").trim();
    if (!title && !body) {
      toast("自定义文案模式需要先填写标题或正文");
      return;
    }
    const count = Math.max(1, Math.min(12, parseInt($("#imgCount", root)?.value, 10) || S.imageCount || DEFAULT_XHS_IMAGE_COUNT));
    S.imageCount = count;
    S.productId = S.productId || "dumate";
    S.productId = primaryProductById(S.productId)?.id || "dumate";
    S.useOnlineTrends = false;
    S.trendPrep = null;
    S.trendGuide = "";
    if (C.referenceRewrite) delete C.referenceRewrite;
    const selectedProduct = productById(S.productId);
    const topic = (title || body.split(/\n+/).find(Boolean) || `${selectedProduct?.shortName || selectedProduct?.name || "产品"} 自定义文案`).slice(0, 80);
    p.topic = topic;
    p.title = title || topic;
    const styleRef = acc.imageStyleAssetId ? state.assets.find(x => x.id === acc.imageStyleAssetId) : null;
    const style = acc.styleProfile || S.style || "";
    const shots = buildCustomCopyShots(C, count, selectedProduct);
    S.direction = "";
    S.shots = shots;
    S.title = p.title;
    S.source = "custom-copy";
    S.style = style;
    const promptRes = await AI.generateImagePrompts({
      script: shotsToText(shots, true),
      account: acc,
      style,
      imageTemplate: acc.imagePromptTemplate || "",
      styleRefName: refNamesOf(A, [styleRef?.name]).join("、"),
      imageCount: count,
      product: selectedProduct,
      topic,
      useOnlineTrends: false,
      trendGuide: "",
      trendPrep: null,
      copy: C
    });
    const promptRows = promptRes.shots || [];
    A.items = shots.map((s, i) => ({
      title: promptRows[i]?.title || s.idea || `图片${i + 1}`,
      visual: s.visual || "",
      prompt: promptRows[i]?.prompt || "",
      assetId: (A.items[i] || {}).assetId || null,
      status: (A.items[i] || {}).assetId ? "done" : "idle"
    }));
    p.stage = "images";
    p.stageStatus = "pending";
    save("productions");
    if (canRedrawCurrent()) draw();
    toast(AI.sourceNote("已按自定义文案生成图卡提示词"));
  }

  draw();
}
