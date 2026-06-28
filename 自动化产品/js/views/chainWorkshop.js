/* 链路 · 分镜工坊（素材号专属一体节点）：
   按场景合并的「分镜单元」——一个单元 = 一条 10-15s 多镜头视频片段
   含 Dumate logo / 产品界面 → 【全能参考】：自动附上固定的 logo + 界面图作参考（替代旧的图生视频）
   纯场景 → 【文生视频】：直接文生视频，不带参考
   顶部「全能参考素材」(logo / 界面图，所有全能参考单元共用) + 口播音频上传 + 一键复制所有口播 */

import { $, $$, esc, gradFor, copyText, fileToDataUrl, wireDropZone, fmtTC, uid } from "../core/util.js";
import { sanitizeXhsText } from "../core/xhsGuard.js";
import { icon } from "../ui/icons.js";
import { state, save, on, accountById, productById } from "../core/store.js";
import { AI } from "../api/ai.js";
import { defaultTtsVoiceId, synthesizeTts, ttsApiConfigured, ttsVoicePresets } from "../api/providers.js";
import { estimateAudio, setStage, setStatus, jobsOf, rebindUnitClip, autoAssemble, buildMaterialUnits, materialUnits, unitShots, isMaterial } from "../domain/productions.js";
import { urlFor, addAssetFromDataUrl, addAssetFromFile, thumbHtml } from "../domain/assets.js";
import { createUnitVideoJobs } from "../agent/orchestrator.js";
import { toast, withLoading, openLightbox, openModal } from "../ui/components.js";
import { go, currentRoute } from "../core/router.js";
import { stepperHtml, wireStepper } from "./studio.js";
import { accountAssets as accAssets } from "../domain/accounts.js";

let liveRoot = null, liveProd = null, liveDraw = null, wired = false;

const assetById = id => state.assets.find(a => a.id === id);
function audioDuration(url) {
  return new Promise(res => {
    if (!url) return res(0);
    const el = new Audio();
    el.preload = "metadata";
    el.onloadedmetadata = () => res(isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => res(0);
    el.src = url;
  });
}

function narrationText(shots) {
  return (shots || []).map(s => (s.line || "").trim()).filter(Boolean).join("\n");
}

function selectedVoicePreset(p, acc) {
  const voiceId = (p?.artifacts?.audio?.voiceId || acc?.voiceId || defaultTtsVoiceId() || "").trim();
  const preset = ttsVoicePresets().find(v => v.voiceId === voiceId);
  return { voiceId, name: preset?.name || acc?.voiceName || voiceId || "默认声线" };
}

function audioPlanFromDuration(shots, duration) {
  const est = estimateAudio(shots);
  const total = est.duration || 1;
  const scale = duration > 0 ? duration / total : 1;
  const perShot = (est.perShot || []).map(x => ({ dur: Math.max(3, Math.round(x.dur * scale * 10) / 10) }));
  return { perShot, duration: duration > 0 ? Math.round(duration * 10) / 10 : est.duration };
}

function digitalSegmentsFromShots(p, acc) {
  const shots = p.artifacts.script.shots || [];
  const per = p.artifacts.audio.perShot || estimateAudio(shots).perShot || [];
  const A = p.artifacts.boards;
  const old = A.digitalHuman?.segments || [];
  const segments = [];
  let cur = null;
  shots.forEach((s, i) => {
    const d = Math.max(3, Number(per[i]?.dur || 4));
    if (!cur || (cur.dur + d > 30 && cur.shotIndexes.length)) {
      cur = { id: uid(), shotIndexes: [], dur: 0, line: "", characterRefAssetId: "", customCharacterRefAssetId: "", audioAssetId: null, audioDuration: 0, status: "pending" };
      segments.push(cur);
    }
    cur.shotIndexes.push(i);
    cur.dur += d;
  });
  const globalChar = A.characterRefAssetId || acc?.charBoardAssetId || null;
  segments.forEach(seg => {
    const oldSeg = old.find(x => (x.shotIndexes || []).some(i => seg.shotIndexes.includes(i)));
    if (oldSeg?.customCharacterRefAssetId) seg.customCharacterRefAssetId = oldSeg.customCharacterRefAssetId;
    if (oldSeg?.audioAssetId) seg.audioAssetId = oldSeg.audioAssetId;
    if (oldSeg?.audioDuration) seg.audioDuration = oldSeg.audioDuration;
    if (oldSeg?.voiceId) seg.voiceId = oldSeg.voiceId;
    if (oldSeg?.status) seg.status = oldSeg.status;
    if (oldSeg?.videoStatus) seg.videoStatus = oldSeg.videoStatus;
    if (oldSeg?.videoPrompt) seg.videoPrompt = oldSeg.videoPrompt;
    seg.dur = Math.round(Math.min(30, seg.dur) * 10) / 10;
    seg.line = seg.shotIndexes.map(i => sanitizeXhsText((shots[i]?.line || "").trim())).filter(Boolean).join("\n");
    seg.characterRefAssetId = seg.customCharacterRefAssetId || globalChar || null;
  });
  A.digitalHuman = { ...(A.digitalHuman || {}), provider: A.digitalHuman?.provider || "reserved", model: A.digitalHuman?.model || "digital-human-api-placeholder", segments };
  return segments;
}

export function renderWorkshopPage(root, p) {
  liveRoot = root; liveProd = p;
  const acc = accountById(p.accountId);
  const A = p.artifacts.boards;
  let shots = p.artifacts.script.shots || [];
  const product = productById(p.artifacts.script.productId || "dumate");
  const isDigital = p.subType === "数字人";
  A.generationMode = A.generationMode || (isDigital ? "digitalHuman" : "seedance");
  A.digitalHuman = A.digitalHuman || { provider: "", model: "", segments: [] };
  let isDigitalHumanMode = isDigital && A.generationMode === "digitalHuman";
  const hasAudio = () => !!p.artifacts.audio.assetId && ["tts", "upload"].includes(p.artifacts.audio.source);
  const materialPureVideo = () => isMaterial(p) && !isDigital;

  // 全能参考素材迁移：旧的单张统一参考图 sharedRefAssetId → omniRefAssetIds 数组（logo / 界面图可多张）
  A.omniRefAssetIds = A.omniRefAssetIds || [];
  if (!A.omniRefAssetIds.length && A.sharedRefAssetId) A.omniRefAssetIds = [A.sharedRefAssetId];
  A.sceneRefAssetIds = A.sceneRefAssetIds || [];
  if (!A.sceneRefAssetIds.length && A.omniRefAssetIds.length) A.sceneRefAssetIds = [...A.omniRefAssetIds];
  if (!A.characterRefAssetId && acc?.charBoardAssetId) A.characterRefAssetId = acc.charBoardAssetId;
  if (!A.omniRefAssetIds.length && acc) {
    const inferred = [];
    if (acc.charBoardAssetId) inferred.push(acc.charBoardAssetId);
    accAssets(acc.id).forEach(a => {
      if (a.type !== "图片" || a.delivered) return;
      const text = `${a.name || ""} ${(a.tags || []).join(" ")}`;
      if (/全能参考|统一参考|角色|身份|logo|界面|产品/.test(text)) inferred.push(a.id);
    });
    A.omniRefAssetIds = [...new Set(inferred)].slice(0, 5);
    if (!A.sceneRefAssetIds.length) A.sceneRefAssetIds = A.omniRefAssetIds.filter(id => id !== acc?.charBoardAssetId);
  }
  if (acc?.voiceRefAssetId && !p.artifacts.audio.voiceRefAssetId && !p.artifacts.audio.voiceRefDisabled) p.artifacts.audio.voiceRefAssetId = acc.voiceRefAssetId;
  A.ratio = A.ratio || "9:16";   // 全片统一尺寸（9:16 / 16:9）

  // 估时兜底 + 单元构建
  if (!(p.artifacts.audio.perShot || []).length && shots.length) {
    Object.assign(p.artifacts.audio, estimateAudio(shots), { source: p.artifacts.audio.source || "estimate" });
    save("productions");
  }
  if (!(A.units || []).length && shots.length) { buildMaterialUnits(p); save("productions"); }

  const jobOfUnit = i => {
    const u = materialUnits(p)[i];
    const list = state.jobs.filter(j => j.productionId === p.id && j.segIndex === i && (!u?.videoPrompt || j.prompt === u.videoPrompt)).sort((a, b) => a.createdAt - b.createdAt);
    return list[list.length - 1] || null;
  };

  const draw = () => {
    liveDraw = draw;
    isDigitalHumanMode = isDigital && A.generationMode === "digitalHuman";
    const units = materialUnits(p);
    const okCount = units.filter((u, i) => jobOfUnit(i)?.status === "succeeded").length;
    const running = units.some((u, i) => ["queued", "submitted", "running"].includes(jobOfUnit(i)?.status || ""));
    const refN = units.filter(u => u.needsImage).length;
    const sceneRefs = [...new Set([...(A.sceneRefAssetIds || []), ...(A.omniRefAssetIds || []).filter(id => id !== A.characterRefAssetId)])].map(assetById).filter(Boolean);
    const charRef = A.characterRefAssetId ? assetById(A.characterRefAssetId) : null;
    const audioAsset = p.artifacts.audio.assetId ? assetById(p.artifacts.audio.assetId) : null;
    const voiceRefAsset = p.artifacts.audio.voiceRefAssetId ? assetById(p.artifacts.audio.voiceRefAssetId) : null;
    const hasNarrationAudio = hasAudio();
    const digitalSegments = isDigitalHumanMode ? digitalSegmentsFromShots(p, acc) : [];
    const ratio = A.ratio || "9:16";
    const rtBtn = (r) => `<button class="ws-rt" data-ratio="${r}" style="font-size:11px;padding:3px 10px;border-radius:7px;cursor:pointer;border:1px solid ${ratio === r ? "#6a5bff" : "var(--d-line-2,rgba(120,130,160,.3))"};background:${ratio === r ? "rgba(106,91,255,.16)" : "transparent"};color:${ratio === r ? "#8b7bff" : "inherit"}">${r}</button>`;
    const digitalPlanHtml = isDigitalHumanMode ? `<div class="dh-plan-inline">
      <div class="dh-plan-head">
        <div>
          <b>${icon("user", 13)} 数字人分段</b>
          <em>${digitalSegments.length ? `已切为 ${digitalSegments.length} 段，每段不超过30s；每段=口播音频 + 角色图。` : "生成口播草稿后自动拆成不超过30s的数字人口播片段。"}</em>
        </div>
        <button class="btn gen sm" id="wsDhVideoAll">${icon("spark", 13)} 一键生成视频</button>
      </div>
      <div class="dh-segs">
        ${digitalSegments.length ? digitalSegments.map((seg, i) => {
          const ref = seg.characterRefAssetId ? assetById(seg.characterRefAssetId) : null;
          const busy = ["queued", "running", "submitted"].includes(seg.videoStatus || "");
          return `<div class="dh-seg ${busy ? "is-generating" : ""}" data-dh-seg="${seg.id}">
            <b>D${String(i + 1).padStart(2, "0")}</b><span>${fmtTC(seg.dur)}</span>
            <em>${ref ? esc(ref.name) : "未设置角色图"}</em>
            <div class="dh-seg-drop droppable" data-unit-char-ref="${seg.id}">${ref ? thumbHtml(ref) : icon("upload", 13)}<span>单段角色图</span></div>
            ${seg.audioAssetId && assetById(seg.audioAssetId) ? `<audio class="dh-audio" src="${esc(urlFor(assetById(seg.audioAssetId)))}" controls preload="metadata"></audio>` : `<small class="dh-audio-miss">未生成分段音频</small>`}
            <div class="dh-seg-actions">
              <button class="btn ghost sm" data-dh-regen="${seg.id}">${icon("refresh", 11)} 重新生成</button>
              <button class="btn primary sm" data-dh-video="${seg.id}">${busy ? "生成中…" : "生成视频"}</button>
            </div>
          </div>`;
        }).join("") : [0, 1, 2].map(i => `<div class="dh-seg ghost"><b>D${String(i + 1).padStart(2, "0")}</b><span>待切分</span><em>生成口播后出现</em><div class="dh-seg-drop">${icon("upload", 13)}<span>单段角色图</span></div><small class="dh-audio-miss">等待口播</small></div>`).join("")}
      </div>
    </div>` : "";
    root.innerHTML = `
      ${stepperHtml(p, "workshop")}
      <div class="chain-page solo">
        <div class="chain-main">
          <div class="page-head">
            <div><div class="eyebrow">${p.subType === "数字人" ? "真人链路" : "素材链路"} · 分镜工坊</div>
            <h2>${isDigitalHumanMode ? `${digitalSegments.length || units.length || 0} 个数字人口播段 · 分段生成` : `${units.length} 个分镜单元 · Seedance 编排出片`} <span class="head-count">${isDigitalHumanMode ? `${digitalSegments.filter(x => x.audioAssetId).length}/${digitalSegments.length || 0} 音频` : `${okCount}/${units.length} 就绪`}</span></h2></div>
            <div class="head-actions">
              <span class="tag">${icon("mic", 11)} ${hasNarrationAudio ? "外部口播" : "提示词口播"} ${fmtTC(p.artifacts.audio.duration || 0)}${p.artifacts.audio.source === "upload" ? " · 已上传" : ""}</span>
              <span class="tag">${icon("layers", 11)} ${isDigitalHumanMode ? "数字人分段" : `文生 ${units.length - refN} · 全能参考 ${refN}`}</span>
              ${isDigital ? `<span class="dh-mode ${isDigitalHumanMode ? "is-digital" : "is-seedance"}" data-mode="${isDigitalHumanMode ? "digitalHuman" : "seedance"}" title="数字人模式先用 Minimax 生成口播，再按≤30s切段，每段=音频+角色图；Seedance 模式沿用视频模型直接生成">
                <i aria-hidden="true"></i>
                <button class="${isDigitalHumanMode ? "on" : ""}" data-dh-mode="digitalHuman">数字人</button>
                <button class="${!isDigitalHumanMode ? "on" : ""}" data-dh-mode="seedance">Seedance</button>
              </span>` : ""}
              <span style="display:inline-flex;gap:4px;align-items:center" title="所有分镜统一这个尺寸"><em class="muted" style="font-size:11px">尺寸</em>${rtBtn("9:16")}${rtBtn("16:9")}</span>
              <button class="btn primary" id="wsNext">下一步：智能混剪 ${icon("arrowRight", 14)}</button>
            </div>
          </div>
          ${isDigital ? `<div class="ws-mode-note ${isDigitalHumanMode ? "digital" : "seedance"}">
            <b>${isDigitalHumanMode ? "当前：数字人模式" : "当前：Seedance 真人视频模式"}</b>
            <span>${isDigitalHumanMode ? "流程为口播分段 → 每段音频 + 角色图生成数字人口播片段 → 进入混剪；视频提示词固定为自然讲述。" : "直接用 Seedance 生成真人视频，口播会写入对应时间结构。"}</span>
          </div>` : ""}

          ${isDigital ? `<div class="refbar card" id="wsCharbar">
            <div class="refbar-left">
              <b>${icon("user", 13)} ${isDigitalHumanMode ? "统一参考图" : "角色参考图"}</b>
              <em>${isDigitalHumanMode ? "数字人默认每段都参考这张角色图；单段可在下方覆盖专属角色图。" : "只用于真人出镜片段。没有上传时，第一段提示词会自动写入固定外貌锚点。"}</em>
            </div>
            <div class="refbar-chip">${charRef
              ? `<span class="ref-chip">${thumbHtml(charRef)}<span>${esc(charRef.name)}</span><button class="ref-x" data-chardel>${icon("x", 11)}</button></span>`
              : `<span class="muted">未设置，可拖拽角色图到此</span>`}</div>
            <div class="refbar-actions">
              <label class="btn ghost sm">上传角色图<input type="file" accept="image/*" hidden id="wsCharUp" /></label>
            </div>
          </div>` : ""}

          ${!isDigitalHumanMode ? `<div class="refbar card" id="wsRefbar">
            <div class="refbar-left">
              <b>${icon("star", 13)} 场景 / 产品参考图</b>
              <em>${esc(product?.shortName || "产品")} logo、界面、场景光线与桌面风格从这里参考；支持拖拽图片，声线音频请拖到下方参考声线区域</em>
            </div>
            <div class="refbar-chip">${sceneRefs.length
              ? sceneRefs.map(a => `<span class="ref-chip">${thumbHtml(a)}<span>${esc(a.name)}</span><button class="ref-x" data-omnidel="${a.id}">${icon("x", 11)}</button></span>`).join("")
              : `<span class="muted">未设置</span>`}</div>
            <div class="refbar-actions">
              <button class="btn ghost sm" id="wsRefPick">从资产选择</button>
              <label class="btn ghost sm">上传<input type="file" accept="image/*" multiple hidden id="wsRefUp" /></label>
            </div>
          </div>
          <div id="wsRefChooser" class="ref-chooser card" hidden></div>` : ""}

          <div class="refbar card" id="wsBriefbar">
            <div class="refbar-left">
              <b>${icon("fileText", 13)} 创作内容与产品</b>
              <em>写得越具体，口播和画面越准确；留空也可以随机生成一个完整创作内容</em>
            </div>
            <div class="refbar-chip" style="flex:1;display:grid;grid-template-columns:minmax(260px,1fr) minmax(180px,260px) auto;gap:8px">
              <div class="input-with-action"><input class="input" id="wsTopic" value="${esc(p.topic || "")}" placeholder="详细写创作内容，例如：会议纪要整理耗时、录音转报告、适合周报复盘" /><button class="icon-btn sm" id="wsDice" title="随机创作内容">${icon("dice", 13)}</button></div>
              <select class="input" id="wsProduct">
                ${state.products.map(x => `<option value="${esc(x.id)}" ${p.artifacts.script.productId === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}
              </select>
              <button class="btn ghost sm" id="wsProductAdd">${icon("plus", 12)} 产品</button>
            </div>
            <div class="refbar-actions">
              <button class="btn ghost sm" id="wsDraft">${(shots || []).length ? "重生成口播草稿" : "生成口播草稿"}</button>
            </div>
          </div>

          <div class="refbar card" id="wsNarrationBar">
            <div class="refbar-left">
              <b>${icon("list", 13)} 口播草稿</b>
              <em>${materialPureVideo() ? "素材号视频只生成纯画面；这里的口播用于 Minimax/上传音频和后期混剪字幕" : "真人视频会把口播写入对应时间结构"}</em>
            </div>
            <div class="refbar-chip" style="flex:1;display:grid;gap:8px">
              <textarea class="input" id="wsNarrationText" rows="5" placeholder="生成口播草稿后可在这里修改；也可以直接粘贴自定义口播，每行一句">${esc(narrationText(shots))}</textarea>
            </div>
            <div class="refbar-actions">
              <button class="btn ghost sm" id="wsApplyNarration">${icon("check", 12)} 应用口播</button>
            </div>
          </div>

          <div class="refbar card" id="wsAudioBar">
            <div class="refbar-left">
              <b>${icon("mic", 13)} ${isDigitalHumanMode ? "口播音频" : "参考声线 / 口播音频"}</b>
              <em>${isDigitalHumanMode
                ? "数字人模式会先用 Minimax 生成口播，再按≤30s切段；每段默认用统一角色图，可单段覆盖角色参考图。"
                : isDigital
                  ? "Seedance 真人模式会把口播写入视频提示词，并用固定声线锚点保持音色。"
                : (voiceRefAsset ? `参考声线「${esc(voiceRefAsset.name)}」会写入提示词，用于统一口播音色；` : "可上传/拖拽参考音频锁定声线；")}${!isDigital && audioAsset
                ? `已上传「${esc(audioAsset.name)}」· 真实时长 ${fmtTC(p.artifacts.audio.duration || 0)}，分镜已按真实时长重排`
                : isDigital ? "" : `素材号请先生成或上传口播音频；Seedance 视频始终生成纯画面，后期混入口播`}${p.artifacts.audio.lastError ? ` · ${esc(p.artifacts.audio.lastError)}` : ""}</em>
            </div>
            <div class="refbar-chip">${!isDigitalHumanMode && voiceRefAsset ? `<span class="ref-chip audio">${icon("mic", 12)}<span>${esc(voiceRefAsset.name)}</span><button class="ref-x" data-voicedel>${icon("x", 11)}</button></span>` : ""}</div>
            <div class="refbar-actions">
              ${(!isDigital || isDigitalHumanMode) && ttsVoicePresets().length ? `<select class="input sm" id="wsVoicePreset" title="选择 MiniMax 口播声线" style="width:190px">
                <option value="">默认/手动声线</option>
                ${ttsVoicePresets().map(v => `<option value="${esc(v.voiceId)}" ${(p.artifacts.audio.voiceId || acc?.voiceId || defaultTtsVoiceId()) === v.voiceId ? "selected" : ""}>${esc(v.name)}</option>`).join("")}
              </select>` : ""}
              ${(!isDigital || isDigitalHumanMode) ? `<button class="btn ghost sm" id="wsVoiceFav">${icon("star", 12)} 收藏</button>
              <button class="btn ghost sm" id="wsVoiceFix">${icon("check", 12)} 固定到账号</button>` : ""}
              <button class="btn ghost sm" id="wsCopyLines">${icon("list", 13)} 一键复制所有口播</button>
              ${!isDigital || isDigitalHumanMode ? `<button class="btn ghost sm" id="wsTts">${icon("mic", 13)} ${isDigitalHumanMode ? "生成分段口播" : (audioAsset && p.artifacts.audio.source === "tts" ? "重新生成口播" : "生成口播音频")}${ttsApiConfigured() ? "" : "（估时）"}</button>` : ""}
              ${!isDigitalHumanMode ? `<label class="btn ghost sm">${voiceRefAsset ? "更换参考声线" : "上传参考声线"}<input type="file" accept="audio/*" hidden id="wsVoiceRefUp" /></label>` : ""}
              ${!isDigital ? `<label class="btn ghost sm">${audioAsset ? "重新上传" : "上传口播音频"}<input type="file" accept="audio/*" hidden id="wsAudioUp" /></label>` : ""}
            </div>
            ${audioAsset && !isDigitalHumanMode ? `<div class="tts-audio" style="grid-column:1/-1;margin-top:10px;display:flex;align-items:center;gap:10px">
              <span class="muted" style="font-size:12px">口播预览</span>
              <audio src="${esc(urlFor(audioAsset))}" controls preload="metadata" style="width:min(520px,100%);height:34px"></audio>
            </div>` : ""}
            ${digitalPlanHtml}
          </div>

          ${isDigitalHumanMode ? "" : `
            <div class="inhouse-controls">
              <button class="btn gen" id="wsAuto">${icon("spark", 15)} ${running ? "生成中…" : okCount === units.length && units.length ? "全部片段已就绪" : "一键全自动编排出片"}</button>
              <button class="btn ghost" id="wsGenPrompts">${icon("list", 14)} 仅生成提示词</button>
              <span class="muted">${isDigital ? "真人链路：提示词会把每句口播放进对应时间结构" : hasNarrationAudio ? "已有口播音频：视频提示词不再写口播，后期混剪合入音频" : "素材号视频保持纯画面，请先生成/上传口播音频后混剪"}</span>
            </div>

            <div class="ws-cards" id="wsCards">
              ${units.map((u, i) => unitCard(u, i, jobOfUnit(i))).join("") ||
                `<div class="empty-state slim">${icon("layers", 22)}<b>先生成口播草稿</b><p>在上方输入选题与产品，直接生成可拆分的分镜单元</p></div>`}
            </div>
          `}
        </div>
      </div>`;
    wireStepper(root);
    wire();
  };

  function unitCard(u, i, job) {
    const us = unitShots(p, u);
    const isRef = u.needsImage;   // 全能参考（含 logo/界面）
    const dur = Math.min(15, Math.ceil(u.dur || 4));
    const ok = job && job.status === "succeeded";
    const videoUrl = ok ? (job.output?.url || "") : "";
    const partLabel = u.sceneParts > 1 ? `·${u.part}` : "";
    let jobHtml = "";
    if (!job) jobHtml = `<button class="btn ghost sm" data-wsgen="${i}">${icon("film", 13)} 生成视频</button>`;
    else if (["queued", "submitted", "running"].includes(job.status))
      jobHtml = `<div class="wsj run"><span class="spin-dot"></span> ${job.status === "queued" ? "排队中" : `渲染 ${job.progress}%`}<i class="wsj-bar"><b style="width:${job.progress}%"></b></i></div>`;
    else if (ok)
      jobHtml = `<div class="wsj ok">${icon("checkCircle", 13)} 片段就绪 · ${dur}s</div>`;
    else
      jobHtml = `<div class="wsj fail">${icon("alert", 13)} ${esc((job.error || "失败").slice(0, 18))}<button class="link-btn" data-wsgen="${i}">${icon("refresh", 11)} 重试</button></div>`;

    const busy = job && ["queued", "submitted", "running"].includes(job.status);
    return `<div class="ws-card card ${isRef ? "i2v" : "t2v"} ${busy ? "is-generating" : ""}" data-ws="${i}">
      <div class="ws-head">
        <span class="sc-num">S${String(u.scene).padStart(2, "0")}${partLabel}</span>
        <b>${us.length > 1 ? `连贯 ${us.length} 镜` : esc(us[0]?.idea || "分镜")}</b>
        <span class="ws-mode ${isRef ? "i2v" : "t2v"}">${isRef ? icon("star", 11) + " 全能参考" : icon("film", 11) + " 文生视频"}</span>
        <span class="ws-dur ${u.dur >= 15 ? "cap" : ""}">${icon("clock", 11)} ${dur}s${u.sceneParts > 1 ? " · 已按15s拆分" : ""}</span>
      </div>
      <div class="ws-align">
        <div class="ws-al-head">${icon("mic", 11)} 口播 ↔ 画面对齐 <em class="muted">混剪时字幕按此逐句对齐</em></div>
        ${alignRows(u, us)}
      </div>
      <div class="ws-body single ${ok ? "has-prev" : ""}">
        <div class="ws-col">
          <div class="ws-label">视频提示词 <em class="muted">${isRef ? "全能参考 · " : ""}${us.length > 1 ? "多镜头连贯 · " : ""}${dur}s 分段，负面约束只放末尾</em></div>
          <div class="sc-prompt" contenteditable="true" data-wsv="${i}" data-ph="点上方「仅生成提示词」自动填入">${esc(u.videoPrompt || "")}</div>
          ${isRef ? `<div class="muted" style="margin-top:6px;font-size:11px;display:flex;align-items:center;gap:4px">${icon("star", 10)} 生成时自动附上统一参考图（角色 / logo / 界面），无需逐镜出图</div>` : ""}
          <div class="ws-jobrow">${jobHtml}</div>
        </div>
        ${ok ? `
        <div class="ws-col ws-prevcol">
          <div class="ws-label">成片预览 <em class="muted">${videoUrl ? "真实成片" : "等待回链"}</em></div>
          <div class="ws-prev-frame ${videoUrl ? "has-video" : ""}" data-wsprev="${i}" ${videoUrl ? `data-video-url="${esc(videoUrl)}"` : ""} ${videoUrl ? "" : `style="background:${gradFor(u.videoPrompt || ("S" + u.scene))}"`}>
            ${videoUrl
              ? `<video src="${esc(videoUrl)}" controls playsinline preload="metadata"></video>`
              : `<span class="ws-prev-play">${icon("play", 18)}</span>`}
            <span class="ws-prev-dur">${dur}s</span>
          </div>
          <div class="ws-prev-acts">
            <button class="btn ghost sm" data-wsgen="${i}">${icon("refresh", 11)} 重生成</button>
          </div>
        </div>` : ""}
      </div>
    </div>`;
  }

  /* 口播↔画面对齐：每镜的时间区间 + 口播原句 + 画面要点（单元内累计计时） */
  function alignRows(u, us) {
    const per = p.artifacts.audio.perShot || [];
    let t = 0;
    return (u.shotIndexes || []).map((si, k) => {
      const s = us[k] || {};
      const d = (per[si] && per[si].dur) || 3;
      const a = t, b = t + d; t = b;
      return `<div class="ws-al"><em>${a.toFixed(1)}-${b.toFixed(1)}s</em><b>${esc((s.line || "").trim() || "（无口播）")}</b><span>${esc((s.visual || s.idea || "").slice(0, 38))}</span></div>`;
    }).join("");
  }

  async function ensurePrompts(force = false) {
    const units = materialUnits(p);
    if (isDigitalHumanMode) {
      applyDigitalFixedPrompts(units);
      save("productions");
      return;
    }
    const pureVideoByPolicy = materialPureVideo();
    const hasVoiceConflict = pureVideoByPolicy && units.some(u => /口播(?:原话)?[:：]|画外音|旁白|人声|声音参考|声线/.test(u.videoPrompt || ""));
    if (!force && units.every(u => u.videoPrompt) && !hasVoiceConflict) return;
    if (hasVoiceConflict) units.forEach(u => { u.videoPrompt = ""; });
    const res = await AI.generateUnitPrompts({
      units, shots, account: acc, style: p.artifacts.script.style,
      product: productById(p.artifacts.script.productId || "dumate"),
      hasNarrationAudio: isDigital ? false : (pureVideoByPolicy || hasAudio()),
      hasVoiceRef: !!p.artifacts.audio.voiceRefAssetId || (!p.artifacts.audio.voiceRefDisabled && !!acc?.voiceRefAssetId),
      hasCharacterRef: !!(A.characterRefAssetId || acc?.charBoardAssetId),
      hasSceneRef: !!((A.sceneRefAssetIds || []).length || (A.omniRefAssetIds || []).filter(id => id !== A.characterRefAssetId).length)
    });
    units.forEach((u, i) => {
      const r = res.units[i] || {};
      if (force || !u.videoPrompt) u.videoPrompt = r.videoPrompt || u.videoPrompt;
    });
    save("productions");
  }

  function applyDigitalFixedPrompts(units = materialUnits(p)) {
    units.forEach(u => {
      u.videoPrompt = "角色自然地讲述内容，动作自然，表情自然";
      u.needsImage = true;
    });
    A.digitalHuman = A.digitalHuman || {};
    A.digitalHuman.fixedPrompt = "角色自然地讲述内容，动作自然，表情自然";
  }

  async function synthesizeDigitalSegmentAudio(voiceId) {
    const segs = digitalSegmentsFromShots(p, acc);
    if (!segs.length) throw new Error("没有可生成的数字人口播分段");
    if (!ttsApiConfigured()) {
      Object.assign(p.artifacts.audio, estimateAudio(shots), {
        assetId: null,
        source: "estimate",
        voiceId,
        lastError: "服务器未配置 Minimax TTS，当前仅估时"
      });
      segs.forEach(seg => { seg.audioAssetId = null; seg.status = "estimate"; });
      return { count: 0, duration: p.artifacts.audio.duration || 0 };
    }
    let total = 0;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const text = sanitizeXhsText(seg.line || "");
      if (!text) continue;
      const out = await synthesizeTts({ text, voiceId });
      const a = await addAssetFromDataUrl(acc.id, {
        name: `数字人口播_D${String(i + 1).padStart(2, "0")}_${(p.title || p.topic || "视频").slice(0, 8)}`,
        type: "音频",
        tags: ["口播音频", "Minimax", "数字人分段", "账号资产"],
        dataUrl: out.audioDataUrl
      });
      seg.audioAssetId = a.id;
      seg.audioDuration = Math.round((out.duration || seg.dur || 0) * 10) / 10;
      seg.voiceId = out.voiceId || voiceId;
      seg.status = "audioReady";
      total += seg.audioDuration || seg.dur || 0;
    }
    A.digitalHuman.segments = segs;
    Object.assign(p.artifacts.audio, {
      assetId: null,
      duration: Math.round(total * 10) / 10,
      source: "tts-segments",
      voiceId,
      voiceRefAssetId: null,
      lastError: "",
      segmentsReady: true
    });
    return { count: segs.filter(x => x.audioAssetId).length, duration: total };
  }

  async function synthesizeOneDigitalSegment(segId, voiceId) {
    const segs = digitalSegmentsFromShots(p, acc);
    const index = segs.findIndex(x => x.id === segId);
    const seg = segs[index];
    if (!seg) throw new Error("未找到数字人分段");
    const text = sanitizeXhsText(seg.line || "");
    if (!text) throw new Error("该段没有口播内容");
    if (!ttsApiConfigured()) {
      seg.audioAssetId = null;
      seg.status = "estimate";
      A.digitalHuman.segments = segs;
      Object.assign(p.artifacts.audio, estimateAudio(shots), {
        assetId: null,
        source: "estimate",
        voiceId,
        voiceRefAssetId: null,
        lastError: "服务器未配置 Minimax TTS，当前仅估时"
      });
      return { count: 0, duration: seg.dur || 0 };
    }
    const out = await synthesizeTts({ text, voiceId });
    const a = await addAssetFromDataUrl(acc.id, {
      name: `数字人口播_D${String(index + 1).padStart(2, "0")}_${(p.title || p.topic || "视频").slice(0, 8)}`,
      type: "音频",
      tags: ["口播音频", "Minimax", "数字人分段", "账号资产"],
      dataUrl: out.audioDataUrl
    });
    seg.audioAssetId = a.id;
    seg.audioDuration = Math.round((out.duration || seg.dur || 0) * 10) / 10;
    seg.voiceId = out.voiceId || voiceId;
    seg.status = "audioReady";
    A.digitalHuman.segments = segs;
    const total = segs.reduce((sum, x) => sum + Number(x.audioDuration || x.dur || 0), 0);
    Object.assign(p.artifacts.audio, {
      assetId: null,
      duration: Math.round(total * 10) / 10,
      source: "tts-segments",
      voiceId,
      voiceRefAssetId: null,
      lastError: "",
      segmentsReady: segs.some(x => x.audioAssetId)
    });
    return { count: 1, duration: seg.audioDuration || seg.dur || 0 };
  }

  function prepareDigitalVideoSegments(ids = null) {
    const segs = digitalSegmentsFromShots(p, acc);
    const pick = ids ? segs.filter(x => ids.includes(x.id)) : segs;
    if (!shots.length || !pick.length) { toast("先生成口播草稿并切分数字人片段"); return false; }
    const missingAudio = pick.filter(x => !x.audioAssetId || !assetById(x.audioAssetId));
    if (missingAudio.length) { toast("请先生成分段口播音频"); return false; }
    const missingRef = pick.filter(x => !x.characterRefAssetId || !assetById(x.characterRefAssetId));
    if (missingRef.length) { toast("请先上传统一参考图，或给单段拖入角色图"); return false; }
    applyDigitalFixedPrompts();
    pick.forEach(seg => {
      seg.videoStatus = "ready";
      seg.videoPrompt = A.digitalHuman.fixedPrompt;
    });
    A.digitalHuman.segments = segs;
    save("productions");
    return true;
  }

  function setNarrationLines(lines, { invalidateAudio = true } = {}) {
    const clean = (lines || []).map(x => sanitizeXhsText(String(x || "").trim())).filter(Boolean);
    if (!clean.length) { toast("口播内容不能为空"); return false; }
    if (!shots.length) {
      p.artifacts.script.shots = clean.map((line, i) => ({
        idea: `口播段 ${i + 1}`,
        visual: i === 0 ? "真实痛点开场，明亮办公环境，桌面文件与屏幕任务形成问题感" : "围绕口播内容匹配对应办公动作、数据流转或结果展示",
        line,
        ui: i % 3 !== 1,
        scene: i + 1
      }));
    } else {
      clean.forEach((line, i) => {
        if (shots[i]) shots[i].line = line;
        else shots.push({
          idea: `补充口播 ${i + 1}`,
          visual: "承接前文的办公场景，使用手部动作、文件卡片、数据面板或结果物料推进信息",
          line,
          ui: i % 3 !== 1,
          scene: Math.max(1, shots.length + 1)
        });
      });
      if (clean.length < shots.length) shots.slice(clean.length).forEach(s => { s.line = ""; });
    }
    shots = p.artifacts.script.shots || [];
    Object.assign(p.artifacts.audio, estimateAudio(shots), {
      assetId: invalidateAudio ? null : p.artifacts.audio.assetId || null,
      source: invalidateAudio ? "estimate" : (p.artifacts.audio.source || "estimate"),
      lastError: invalidateAudio ? "口播已修改，请重新生成或上传口播音频" : ""
    });
    if (invalidateAudio && A.digitalHuman) A.digitalHuman.segments = [];
    invalidatePromptsAfterAudioChange();
    save("productions");
    return true;
  }

  function openQuickProductDialog() {
    const draftId = uid();
    openModal(`
      <div class="mp-head"><b>添加共享产品</b><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
      <div class="mp-body">
        <div class="set-grid">
          <label class="field">产品名称<input class="input" id="qpdName" placeholder="例如：秒哒 / 新产品名" /></label>
          <label class="field">短名称<input class="input" id="qpdShort" placeholder="用于口播和标题" /></label>
          <label class="field">产品类别<input class="input" id="qpdCat" placeholder="例如：AI 应用搭建工具" /></label>
          <label class="field">表达要求<input class="input" id="qpdTone" value="可信、理性、有梗、像真实用户经验分享；不要硬广，不要强 CTA。" /></label>
        </div>
        <label class="field">产品描述 / Markdown
          <textarea class="input" id="qpdBrief" rows="8" placeholder="粘贴产品功能、卖点、适用场景、禁忌表达；所有成员都能共享使用"></textarea>
        </label>
      </div>
      <div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="qpdSave">添加产品</button></div>
    `, { onMount(panel, close) {
      $("#qpdSave", panel).addEventListener("click", () => {
        const name = $("#qpdName", panel).value.trim();
        const brief = $("#qpdBrief", panel).value.trim();
        if (!name || !brief) { toast("请填写产品名称和产品描述"); return; }
        const item = {
          id: draftId,
          name,
          shortName: $("#qpdShort", panel).value.trim() || name,
          category: $("#qpdCat", panel).value.trim() || "待补充",
          brief,
          toneRule: $("#qpdTone", panel).value.trim() || "可信、理性、有梗、不要硬广。",
          updatedAt: Date.now()
        };
        state.products.push(item);
        p.artifacts.script.productId = item.id;
        save("products", "productions", "meta");
        close();
        toast("产品已添加并共享");
        draw();
      });
    }});
  }

  function invalidatePromptsAfterAudioChange() {
    buildMaterialUnits(p);
    (p.artifacts.boards.units || []).forEach(u => {
      u.videoPrompt = "";
      u.imagePrompt = "";
      u.imageAssetId = null;
      u.refAssetId = null;
      u.refAssetIds = [];
    });
    p.artifacts.timeline = [];
    p.artifacts.subs = [];
  }

  function wire() {
    $$("[data-dh-mode]", root).forEach(b => b.addEventListener("click", () => {
      const next = b.dataset.dhMode;
      if (!next || A.generationMode === next) return;
      A.generationMode = next;
      save("productions");
      toast(next === "digitalHuman" ? "已切到数字人模式：默认先生成口播，再分段生成数字人" : "已切到 Seedance 真人视频模式");
      draw();
    }));
    $("#wsTopic", root)?.addEventListener("input", e => { p.topic = sanitizeXhsText(e.target.value.trim()); save("productions"); });
    $("#wsDice", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      const topic = sanitizeXhsText(await AI.randomPick({ kind: "topic", account: acc }));
      p.topic = topic;
      const input = $("#wsTopic", root); if (input) input.value = topic;
      save("productions");
      toast(AI.sourceNote("已随机生成选题"));
    }, "随机中…"));
    $("#wsProduct", root)?.addEventListener("change", e => { p.artifacts.script.productId = e.target.value || "dumate"; save("productions"); });
    $("#wsDraft", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      let topic = sanitizeXhsText(($("#wsTopic", root)?.value || p.topic || "").trim());
      if (!topic) {
        const picked = sanitizeXhsText(await AI.randomPick({ kind: "topic", account: acc }));
        topic = `${picked}：从真实使用痛点、具体操作过程、结果对比和适用人群四个角度展开，避免空泛介绍。`;
        p.topic = topic;
        const input = $("#wsTopic", root); if (input) input.value = topic;
        toast(AI.sourceNote("已随机生成详细创作内容"));
      }
      p.topic = sanitizeXhsText(topic);
      const selectedProduct = productById(p.artifacts.script.productId || "dumate");
      const style = p.artifacts.script.style || acc?.styleProfile || acc?.lockedStyle || "";
      const res = isMaterial(p)
        ? await AI.generateMaterialScript({ topic, account: acc, style, product: selectedProduct })
        : await AI.generateScript({ topic, duration: 55, account: acc, image: false, style, product: selectedProduct });
      p.artifacts.script.shots = res.shots || [];
      shots = p.artifacts.script.shots || [];
      p.artifacts.script.title = res.title || topic;
      p.title = res.title || topic;
      Object.assign(p.artifacts.audio, estimateAudio(p.artifacts.script.shots), { assetId: null, source: "estimate", lastError: "" });
      p.artifacts.boards.units = [];
      buildMaterialUnits(p);
      save("productions");
      toast(AI.sourceNote("已生成口播草稿并按可读时长重排片段"));
      draw();
    }, "生成中…"));
    $("#wsProductAdd", root)?.addEventListener("click", openQuickProductDialog);
    $("#wsApplyNarration", root)?.addEventListener("click", () => {
      const text = $("#wsNarrationText", root)?.value || "";
      const ok = setNarrationLines(text.split(/\n+/), { invalidateAudio: true });
      if (ok) { toast("口播草稿已应用，已清空旧音频和旧提示词"); draw(); }
    });
    // 全能参考素材（logo / 界面图，可多张）
    const charbar = $("#wsCharbar", root);
    wireDropZone(charbar, async files => {
      const f = Array.from(files || []).find(x => x.type.startsWith("image/"));
      if (f) await setCharRef(f);
    });
    $("#wsCharUp", root)?.addEventListener("change", async e => {
      const f = e.target.files[0]; e.target.value = "";
      if (f) await setCharRef(f);
    });
    $("[data-chardel]", root)?.addEventListener("click", () => {
      A.characterRefAssetId = null;
      if (acc) acc.charBoardAssetId = null;
      save("productions", "accounts");
      draw();
    });
    const refbar = $("#wsRefbar", root);
    wireDropZone(refbar, async files => { await addRefs(files); });
    $("#wsRefUp", root)?.addEventListener("change", async e => { await addOmni(e.target.files); e.target.value = ""; });
    $$("[data-omnidel]", root).forEach(b => b.addEventListener("click", () => {
      A.omniRefAssetIds = A.omniRefAssetIds.filter(id => id !== b.dataset.omnidel);
      A.sceneRefAssetIds = (A.sceneRefAssetIds || []).filter(id => id !== b.dataset.omnidel);
      save("productions"); draw();
    }));
    // 尺寸切换（9:16 / 16:9）：全片统一，写进 boards.ratio，生成时传给视频 API
    $$("[data-ratio]", root).forEach(b => b.addEventListener("click", () => {
      if (A.ratio === b.dataset.ratio) return;
      A.ratio = b.dataset.ratio; save("productions"); toast(`已切换为 ${A.ratio}，所有分镜统一此尺寸`); draw();
    }));
    $("#wsRefPick", root)?.addEventListener("click", () => {
      const box = $("#wsRefChooser", root);
      if (!box.hidden) { box.hidden = true; return; }
      const known = new Set([...(A.sceneRefAssetIds || []), ...(A.omniRefAssetIds || []), A.characterRefAssetId].filter(Boolean));
      const assets = accAssets(acc.id).filter(a => a.type === "图片" && !known.has(a.id));
      box.innerHTML = assets.length ? `<div class="ref-grid">${assets.map(a => `<button class="ref-item" data-ref="${a.id}">${thumbHtml(a)}<span>${esc(a.name)}</span></button>`).join("")}</div>`
        : `<div class="muted" style="padding:10px">该账号没有可选的图片资产</div>`;
      box.hidden = false;
      box.querySelectorAll("[data-ref]").forEach(b => b.addEventListener("click", () => {
        A.omniRefAssetIds.push(b.dataset.ref);
        A.sceneRefAssetIds = [...new Set([...(A.sceneRefAssetIds || []), b.dataset.ref])];
        save("productions"); draw();
      }));
    });
    async function addRefs(files) {
      const list = Array.from(files || []);
      const audios = list.filter(f => f.type.startsWith("audio/"));
      if (audios[0]) await setVoiceRef(audios[0]);
      await addOmni(list.filter(f => f.type.startsWith("image/")));
    }
    async function addOmni(files) {
      const imgs = Array.from(files || []).filter(f => f.type.startsWith("image/"));
      let added = 0;
      for (const f of imgs) {
        const dataUrl = await fileToDataUrl(f);
        const a = await addAssetFromDataUrl(acc.id, { name: f.name.replace(/\.[^.]+$/, ""), tags: ["全能参考图"], dataUrl });
        A.omniRefAssetIds.push(a.id);
        A.sceneRefAssetIds = [...new Set([...(A.sceneRefAssetIds || []), a.id])];
        added++;
      }
      if (added) { save("productions"); toast("已加入全能参考素材"); draw(); }
    }
    async function setCharRef(f) {
      if (!f || !f.type.startsWith("image/")) { toast("请上传角色图片"); return; }
      const dataUrl = await fileToDataUrl(f);
      const a = await addAssetFromDataUrl(acc.id, { name: f.name.replace(/\.[^.]+$/, ""), tags: ["角色参考图", "数字人身份板"], dataUrl });
      A.characterRefAssetId = a.id;
      if (acc) acc.charBoardAssetId = a.id;
      A.omniRefAssetIds = (A.omniRefAssetIds || []).filter(id => id !== a.id);
      A.sceneRefAssetIds = (A.sceneRefAssetIds || []).filter(id => id !== a.id);
      save("productions", "accounts");
      toast("已设置角色参考图");
      draw();
    }

    // 口播：一键复制 + 上传音频（按真实时长重排）
    $("#wsCopyLines", root).addEventListener("click", () => {
      const text = narrationText(shots);
      if (!text) { toast("脚本里还没有口播文案"); return; }
      copyText(text);
      toast("已复制全部口播，可去站外配音/粘贴");
    });
    $("#wsVoicePreset", root)?.addEventListener("change", e => {
      p.artifacts.audio.voiceId = e.currentTarget.value || "";
      save("productions");
      toast(p.artifacts.audio.voiceId ? "已切换口播声线" : "已切回默认/手动声线");
    });
    $("#wsVoiceFav", root)?.addEventListener("click", () => {
      const { voiceId, name } = selectedVoicePreset(p, acc);
      if (!voiceId) { toast("请先选择一个有效声线"); return; }
      const favs = new Set(state.ui.favoriteVoiceIds || []);
      favs.add(voiceId);
      state.ui.favoriteVoiceIds = [...favs];
      save("meta");
      toast(`已收藏声线：${name}`);
    });
    $("#wsVoiceFix", root)?.addEventListener("click", () => {
      const { voiceId, name } = selectedVoicePreset(p, acc);
      if (!voiceId || !acc) { toast("请先选择一个有效声线"); return; }
      acc.voiceId = voiceId;
      acc.voiceName = name;
      p.artifacts.audio.voiceId = voiceId;
      save("accounts", "productions");
      toast(`已固定到账号：${name}`);
    });
    $("#wsTts", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      if (!shots.length) { toast("先生成口播草稿"); return; }
      const text = narrationText(shots);
      if (!text) { toast("没有可合成的口播文本"); return; }
      const voiceId = (p.artifacts.audio.voiceId || acc?.voiceId || defaultTtsVoiceId() || "").trim();
      if (isDigitalHumanMode) {
        try {
          const out = await synthesizeDigitalSegmentAudio(voiceId);
          applyDigitalFixedPrompts();
          save("productions");
          toast(out.count ? `数字人口播已分段生成：${out.count} 段 · ${fmtTC(out.duration || 0)}` : "已生成数字人分段估时");
          draw();
        } catch (err) {
          Object.assign(p.artifacts.audio, estimateAudio(shots), {
            assetId: null,
            source: "estimate",
            voiceId,
            voiceRefAssetId: null,
            lastError: err.message || "Minimax TTS 生成失败"
          });
          save("productions");
          toast("Minimax 分段口播失败，已保留分段计划", "error");
          draw();
        }
        return;
      }
      if (ttsApiConfigured()) {
        try {
          const out = await synthesizeTts({ text, voiceId });
          if (out.fallbackVoice && out.voiceId && out.voiceId !== voiceId) toast(`账号声线不可用，已自动改用默认声线：${out.voiceId}`);
          const a = await addAssetFromDataUrl(acc.id, {
            name: `口播音频_${(p.title || p.topic || "视频").slice(0, 10)}`,
            type: "音频",
            tags: ["口播音频", "Minimax"],
            dataUrl: out.audioDataUrl
          });
          Object.assign(p.artifacts.audio, audioPlanFromDuration(shots, out.duration), {
            assetId: a.id,
            source: "tts",
            voiceId: out.voiceId || voiceId,
            voiceRefAssetId: p.artifacts.audio.voiceRefDisabled ? null : (p.artifacts.audio.voiceRefAssetId || acc?.voiceRefAssetId || null),
            lastError: ""
          });
        } catch (err) {
          Object.assign(p.artifacts.audio, estimateAudio(shots), {
            assetId: null,
            source: "estimate",
            voiceId,
            voiceRefAssetId: p.artifacts.audio.voiceRefDisabled ? null : (p.artifacts.audio.voiceRefAssetId || acc?.voiceRefAssetId || null),
            lastError: err.message || "Minimax TTS 生成失败"
          });
          save("productions");
          toast("Minimax 口播失败，已切换为估时备用", "error");
          draw();
          return;
        }
      } else {
        Object.assign(p.artifacts.audio, estimateAudio(shots), {
          assetId: null,
          source: "estimate",
          voiceId,
          voiceRefAssetId: p.artifacts.audio.voiceRefDisabled ? null : (p.artifacts.audio.voiceRefAssetId || acc?.voiceRefAssetId || null),
          lastError: "服务器未配置 Minimax TTS，当前仅估时"
        });
      }
      invalidatePromptsAfterAudioChange();
      save("productions");
      toast(`口播音频已就绪：${fmtTC(p.artifacts.audio.duration || 0)} · 已按真实/估算时长重排分镜，请重新生成提示词`);
      draw();
    }, "合成中…"));
    $("#wsAudioUp", root)?.addEventListener("change", async e => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      await setAudio(f);
    });
    $("#wsVoiceRefUp", root)?.addEventListener("change", async e => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      await setVoiceRef(f);
    });
    $("[data-voicedel]", root)?.addEventListener("click", () => {
      p.artifacts.audio.voiceRefAssetId = null;
      p.artifacts.audio.voiceRefDisabled = true;
      save("productions");
      draw();
    });
    const audioBar = $("#wsAudioBar", root);
    wireDropZone(audioBar, async files => {
      if (isDigitalHumanMode) return;
      const f = Array.from(files || []).find(x => x.type.startsWith("audio/"));
      if (f) await setVoiceRef(f);
    });
    $$("[data-unit-char-ref]", root).forEach(z => {
      wireDropZone(z, async files => {
        const f = Array.from(files || []).find(x => x.type.startsWith("image/"));
        if (!f) return;
        const dataUrl = await fileToDataUrl(f);
        const a = await addAssetFromDataUrl(acc.id, { name: f.name.replace(/\.[^.]+$/, ""), tags: ["数字人单段角色图"], dataUrl });
        A.digitalHuman = A.digitalHuman || { segments: [] };
        const seg = (A.digitalHuman.segments || []).find(x => x.id === z.dataset.unitCharRef);
        if (seg) {
          seg.customCharacterRefAssetId = a.id;
          seg.characterRefAssetId = a.id;
        }
        save("productions");
        toast("已设置该段数字人定制角色图");
        draw();
      }, { filesOnly: true });
    });
    async function setVoiceRef(f) {
      if (!f || !f.type.startsWith("audio/")) { toast("请上传音频文件"); return; }
      const a = await addAssetFromFile(acc.id, f, { tags: ["声线参考", "统一参考音频"] });
      p.artifacts.audio.voiceRefAssetId = a.id;
      p.artifacts.audio.voiceRefDisabled = false;
      if (acc && !acc.voiceRefAssetId) acc.voiceRefAssetId = a.id;
      save("productions", "accounts");
      toast("已加入统一参考声线");
      draw();
    }
    async function setAudio(file) {
      const a = await addAssetFromFile(acc.id, file, { tags: ["口播音频"] });
      const realDur = await audioDuration(urlFor(a));
      const est = estimateAudio(shots);
      const estTotal = est.duration || 1;
      const scale = realDur > 0 ? realDur / estTotal : 1;
      const perShot = (est.perShot || []).map(x => ({ dur: Math.max(3, Math.round(x.dur * scale * 10) / 10) }));
      const duration = realDur > 0 ? Math.round(realDur * 10) / 10 : est.duration;
      p.artifacts.audio = {
        assetId: a.id,
        duration,
        perShot,
        source: "upload",
        voiceId: p.artifacts.audio.voiceId || acc?.voiceId || "",
        voiceRefAssetId: p.artifacts.audio.voiceRefDisabled ? null : (p.artifacts.audio.voiceRefAssetId || acc?.voiceRefAssetId || null),
        lastError: ""
      };
      invalidatePromptsAfterAudioChange();   // 按真实时长重排分镜单元（15s 拆分也随之更新），并清掉旧提示词
      save("productions");
      toast(realDur > 0 ? `口播音频已上传 · ${fmtTC(duration)}，已按真实时长重排分镜，请重新生成提示词` : "音频已上传，但未能读出时长，仍按估时");
      draw();
    }

    $("#wsDhVideoAll", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      if (prepareDigitalVideoSegments()) {
        toast("数字人生成已准备好：每段已绑定口播音频和角色图，待接入数字人 API 后提交生成");
        draw();
      }
    }, "生成中…"));
    $$("[data-dh-video]", root).forEach(b => b.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      if (prepareDigitalVideoSegments([b.dataset.dhVideo])) {
        toast("该段数字人生成已准备好，待接入数字人 API 后提交生成");
        draw();
      }
    }, "生成中…")));
    $$("[data-dh-regen]", root).forEach(b => b.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      const voiceId = (p.artifacts.audio.voiceId || acc?.voiceId || defaultTtsVoiceId() || "").trim();
      try {
        const out = await synthesizeOneDigitalSegment(b.dataset.dhRegen, voiceId);
        applyDigitalFixedPrompts();
        save("productions");
        toast(out.count ? `已重新生成该段口播：${fmtTC(out.duration || 0)}` : "已重算该段口播估时");
      } catch (err) {
        toast(err.message || "该段口播生成失败", "error");
      }
      draw();
    }, "生成中…")));

    $("#wsAuto", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      if (!shots.length) { toast("先在上方生成口播草稿"); return; }
      if (isDigitalHumanMode) {
        const segs = digitalSegmentsFromShots(p, acc);
        const audioReady = segs.length && segs.every(x => x.audioAssetId && assetById(x.audioAssetId));
        if (!audioReady) {
          save("productions");
          draw();
          toast("数字人模式请先生成分段口播音频；已为你生成分段计划");
          return;
        }
        if (!segs.every(x => x.characterRefAssetId)) {
          save("productions");
          draw();
          toast("数字人模式还缺角色图：请上传统一角色图，或给单段拖入定制角色图");
          return;
        }
        save("productions");
        toast("数字人 API 已预留：当前已完成口播分段与角色图绑定，待接入真实模型后可提交生成");
        return;
      }
      await ensurePrompts();
      const n = createUnitVideoJobs(p);
      if (p.stage === "workshop") setStatus(p, "running");
      toast(n ? `已派发 ${n} 个分镜单元（并发 2，其余排队）` : "所有单元都已就绪");
      draw();
    }, "起草中…"));

    $("#wsGenPrompts", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      if (!shots.length) { toast("先在上方生成口播草稿"); return; }
      await ensurePrompts(true);
      draw();
      toast(AI.sourceNote("视频提示词已生成（按真实时长分段）"));
    }, "生成中…"));

    $$("[data-wsv]", root).forEach(el => el.addEventListener("blur", () => {
      const u = materialUnits(p)[+el.dataset.wsv]; if (u) { u.videoPrompt = el.textContent.trim(); save("productions"); }
    }));
    $$("[data-wsgen]", root).forEach(b => b.addEventListener("click", async () => {
      const i = +b.dataset.wsgen;
      const u = materialUnits(p)[i];
      if (!u.videoPrompt) await ensurePrompts();
      if (!u.videoPrompt) { toast("先填写该单元的视频提示词"); return; }
      createUnitVideoJobs(p, i);
      if (p.stage === "workshop") setStatus(p, "running");
      draw();
    }));
    // 成片预览：Seedance 返回 output.url 后直接播放真实视频；未回链时保留轻提示。
    $$("[data-wsprev]", root).forEach(el => el.addEventListener("click", e => {
      if (e.target.closest("video")) return;
      const video = el.querySelector("video");
      if (video) {
        if (video.paused) video.play().catch(() => null);
        else video.pause();
        return;
      }
      toast("视频已提交但还没有拿到回链，稍后自动刷新或点重生成");
    }));

    $("#wsNext", root).addEventListener("click", () => {
      if (isDigitalHumanMode) {
        const segs = digitalSegmentsFromShots(p, acc);
        const ready = segs.length && segs.every(x => x.audioAssetId && assetById(x.audioAssetId) && x.characterRefAssetId && assetById(x.characterRefAssetId));
        if (!ready) { toast("数字人模式请先完成分段口播和角色图"); return; }
        prepareDigitalVideoSegments();
        autoAssemble(p);
        if (p.stage === "workshop") setStage(p, "cut", "pending");
        go("studio", "cut");
        return;
      }
      const okCount = materialUnits(p).filter((u, i) => jobOfUnit(i)?.status === "succeeded").length;
      if (!okCount) { toast("还没有就绪片段：点「一键全自动」先生成"); return; }
      autoAssemble(p);
      if (p.stage === "workshop") setStage(p, "cut", "pending");
      go("studio", "cut");
    });
  }

  if (!wired) {
    wired = true;
    on("job:update", j => {
      // 任务匹配才处理；成片回绑要照常发生（即使已离开工坊页，剪辑页才拿得到正确片段）
      if (!liveProd || j.productionId !== liveProd.id) return;
      if (j.status === "succeeded") rebindUnitClip(liveProd, j.segIndex, j);
      // 仅当「仍停在该任务的工坊页」才重渲染：否则会把已切换到的其它阶段页打回工坊（批量任务在跑时尤甚）
      if (document.body.dataset.zone !== "studio") return;
      if (currentRoute().page !== "workshop") return;
      if (liveProd.id !== state.ui.activeProductionId) return;
      (liveDraw || draw)();
    });
  }

  draw();
}
