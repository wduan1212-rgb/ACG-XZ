/* 链路 · 智能剪辑页：自动拼接 + 时间轴精修
   片段：拖拽排序 / 两端裁剪 / 播放头处分割 / 删除；字幕：自动铺入 / 拖动 / 拉伸 / 样式；SRT 导出；撤销；缩放 */

import { $, $$, esc, gradFor, fmtTC, buildSRT, downloadBlob, clamp, spreadCaption, cleanCaptionText, wireDropZone } from "../core/util.js?v=20260623-captions";
import { icon } from "../ui/icons.js";
import { save, accountById, state } from "../core/store.js";
import { autoAssemble, setStage, isVideoWorkshop, pickBgm } from "../domain/productions.js";
import { BGM_POOL } from "../api/prompts.js";
import { buildDeliveryName } from "../domain/accounts.js";
import { accountAssets } from "../domain/accounts.js";
import { addAssetFromFile, assetBlob, urlFor } from "../domain/assets.js";
import { toast, withLoading } from "../ui/components.js";
import { go } from "../core/router.js";
import { stepperHtml, wireStepper } from "./studio.js";

let PPS = 40;
const CLIP_SEC = 15;
const histories = new Map(); // productionId -> []

export function renderCutPage(root, p) {
  const acc = accountById(p.accountId);
  if (!p.artifacts.subStyle) p.artifacts.subStyle = { size: 13, stroke: 2, bottom: 12 };
  let playheadT = 0;
  let playTimer = null;
  let activeSubIdx = 0;
  let selectedClipId = null;

  const TL = () => p.artifacts.timeline || (p.artifacts.timeline = []);
  const SUBS = () => p.artifacts.subs || (p.artifacts.subs = []);
  const clipDur = c => Math.max(1, c.dur != null ? c.dur : CLIP_SEC);
  const clipStart = i => { let t = 0; for (let k = 0; k < i; k++) t += clipDur(TL()[k]); return t; };
  const clipsTotal = () => TL().reduce((s, c) => s + clipDur(c), 0);
  const totalDur = () => Math.max(30, clipsTotal(), SUBS().reduce((m, s) => Math.max(m, s.end || 0), 0));
  const jobForClip = c => c?.jobId ? state.jobs.find(j => j.id === c.jobId) : null;
  const videoUrlForClip = c => jobForClip(c)?.output?.url || "";
  const audioAssets = () => accountAssets(p.accountId).filter(a => a.type === "音频" && !a.delivered);
  const mediaUrlForAsset = id => {
    const u = urlFor(id) || "";
    return u || "";
  };
  const narrationPreviewUrl = () => mediaUrlForAsset(p.artifacts.audio?.assetId);
  const bgmPreviewUrl = () => mediaUrlForAsset(p.artifacts.bgm?.assetId);
  const assetMedia = async (id) => {
    if (!id) return { dataUrl: "", url: "" };
    const blob = await assetBlob(id).catch(() => null);
    const rawUrl = urlFor(id) || "";
    const url = rawUrl && !rawUrl.startsWith("blob:") && !rawUrl.startsWith("data:")
      ? new URL(rawUrl, location.origin).href
      : "";
    if (!blob) return { dataUrl: "", url };
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = e => resolve(e.target.result || "");
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    return { dataUrl, url };
  };

  if (!TL().length && state.jobs.some(j => j.productionId === p.id && j.status === "succeeded")) {
    autoAssemble(p);
  }

  const hist = histories.get(p.id) || histories.set(p.id, []).get(p.id);
  const snapshot = () => {
    hist.push(JSON.stringify({ timeline: TL(), subs: SUBS(), subStyle: p.artifacts.subStyle }));
    if (hist.length > 60) hist.shift();
  };
  const undo = () => {
    const last = hist.pop();
    if (!last) { toast("没有可撤回的操作"); return; }
    const d = JSON.parse(last);
    p.artifacts.timeline = d.timeline || [];
    p.artifacts.subs = d.subs || [];
    p.artifacts.subStyle = d.subStyle || p.artifacts.subStyle;
    save("productions");
    drawTimeline();
    toast(`已撤回（还可撤 ${hist.length} 步）`);
  };

  root.innerHTML = `
    ${stepperHtml(p, "cut")}
    <div class="cut-page">
      <div class="cut-top">
        <section class="cut-preview card dark">
          <div class="cp-screen" id="cpScreen">
            <video class="cp-video" id="cpVideo" playsinline preload="metadata"></video>
            <audio id="cpNarration" src="${esc(narrationPreviewUrl())}" preload="metadata"></audio>
            <audio id="cpBgmAudio" src="${esc(bgmPreviewUrl())}" preload="metadata" loop></audio>
            <div class="cp-frame" id="cpFrame"></div>
            <div class="cp-cliplabel" id="cpClipLabel"></div>
            <button class="cp-play" id="cpPlay">${icon("play", 22)}</button>
            <div class="cp-sub" id="cpSub" hidden></div>
          </div>
          <div class="cp-bar"><span id="cpTimecode">00:00 / 00:30</span><em id="cpHint">拖动字幕可调垂直位置</em></div>
        </section>
        <aside class="cut-side">
          <div class="side-card card">
            <h3>${icon("wand", 14)} 智能${isVideoWorkshop(p) ? "混剪" : "剪辑"}</h3>
            <p class="muted">${isVideoWorkshop(p) ? "按口播时长拼片段 + 铺字幕 + 自动选配 BGM，再来精修。" : "自动按片段顺序拼接 + 从口播铺字幕，再来精修。"}</p>
            <button class="btn gen block" id="cutAuto">${icon("spark", 14)} 一键智能${isVideoWorkshop(p) ? "混剪" : "拼接"}</button>
          </div>
          ${isVideoWorkshop(p) ? `
          <div class="side-card card">
            <h3>${icon("music", 14)} 声音轨</h3>
            <div class="cut-audio-row">${icon("mic", 12)} 口播音频 <b>${fmtTC(p.artifacts.audio?.duration || 0)}</b><em class="muted">音量 100%</em></div>
            <div class="cut-audio-row">
              ${icon("music", 12)} BGM
              <select class="input sm" id="cutBgm">
                <option value="">无 BGM</option>
                ${BGM_POOL.map(b => `<option value="${esc(b.name)}" ${p.artifacts.bgm?.name === b.name ? "selected" : ""}>${esc(b.name)}（${b.mood}）</option>`).join("")}
                ${audioAssets().length ? `<optgroup label="账号 BGM 库">${audioAssets().map(a => `<option value="asset:${esc(a.id)}" ${p.artifacts.bgm?.assetId === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</optgroup>` : ""}
              </select>
            </div>
            <div class="cut-bgm-drop" id="cutBgmDrop">${icon("upload", 12)} 拖拽 / 上传 BGM<input type="file" id="cutBgmUp" accept="audio/*" hidden /></div>
            <div class="cut-audio-row vol">
              <span>BGM 音量</span>
              <input type="range" id="cutBgmVol" min="5" max="60" step="5" value="${Math.round((p.artifacts.bgm?.volume ?? 0.25) * 100)}" />
              <em id="cutBgmVolV">${Math.round((p.artifacts.bgm?.volume ?? 0.25) * 100)}%</em>
            </div>
            <p class="muted" style="margin-top:6px">BGM 音量恒低于口播（上限 60%）${p.artifacts.bgm?.auto ? " · 当前为智能选配" : ""}</p>
          </div>` : ""}
          <div class="side-card card">
            <h3>导出</h3>
            <p class="muted">9:16 竖屏 · 1080×1920${TL().length ? ` · 将命名「${esc(buildDeliveryName(acc, (acc.exportSeq || 0) + 1))}」` : ""}</p>
            ${p.artifacts.finalVideoUrl ? `<a class="btn ghost block" href="${esc(p.artifacts.finalVideoUrl)}" target="_blank" rel="noreferrer">${icon("download", 13)} 查看/下载合成成片</a>` : ""}
            <button class="btn ghost block" id="cutCompose">${icon("film", 13)} 合成成片</button>
            <button class="btn primary block" id="cutNext">下一步：文案 ${icon("arrowRight", 13)}</button>
          </div>
        </aside>
      </div>

      <div class="tl-editor card">
        <div class="tl-toolbar">
          <div class="tlt-left">
            <b>时间轴</b>
            <em class="muted" id="tlMeta">拖动排序 · 拖两端裁剪 · 点片段选中后可分割 · ⌘Z 撤回</em>
          </div>
          <div class="tlt-actions">
            <button class="btn ghost sm" id="tlFillSubs">${icon("type", 13)} 从口播填字幕</button>
            <button class="btn ghost sm" id="tlAddSub">${icon("plus", 13)} 字幕块</button>
            <button class="btn ghost sm" id="tlSplit" title="在播放头处分割选中片段">${icon("split", 13)} 分割</button>
            <button class="btn ghost sm" id="tlSrt">${icon("download", 13)} .srt</button>
            <button class="btn ghost sm" id="tlUndo">${icon("undo", 13)} 撤回</button>
            <span class="tl-zoom">
              <button class="icon-btn sm" id="tlZoomOut">${icon("zoomOut", 13)}</button>
              <button class="icon-btn sm" id="tlZoomIn">${icon("zoomIn", 13)}</button>
            </span>
          </div>
        </div>
        <div class="tl-scroll" id="tlScroll">
          <div class="tl-inner" id="tlInner">
            <div class="tl-playhead" id="tlPlayhead"><i></i></div>
            <div class="tl-row"><div class="tl-label"></div><div class="tl-body tl-ruler" id="tlRuler"></div></div>
            <div class="tl-row"><div class="tl-label">${icon("type", 12)} 字幕</div><div class="tl-body tl-subtrack" id="tlSubTrack"></div></div>
            <div class="tl-row"><div class="tl-label">${icon("film", 12)} 视频</div><div class="tl-body tl-cliptrack" id="tlClipTrack"></div></div>
          </div>
        </div>
        <div id="tlSubEditor" class="tl-sub-editor"></div>
      </div>
    </div>`;

  wireStepper(root);

  /* ---------- 渲染 ---------- */
  function drawTimeline() {
    const total = totalDur(), W = total * PPS;
    $("#tlMeta", root).textContent = TL().length
      ? `${TL().length} 段 · 共 ${Math.round(clipsTotal())}s · 拖动排序 / 两端裁剪 / 选中后分割 · ⌘Z 撤回`
      : "时间轴为空：在生成台「加入剪辑」或点上方「一键智能拼接」";
    const ruler = $("#tlRuler", root);
    ruler.style.width = W + "px";
    const step = PPS >= 28 ? 5 : 10;
    let ticks = "";
    for (let t = 0; t <= total; t += step) ticks += `<span class="tl-tick" style="left:${t * PPS}px">${t}s</span>`;
    ruler.innerHTML = ticks;

    const ct = $("#tlClipTrack", root); ct.style.width = W + "px";
    ct.innerHTML = TL().length ? TL().map((c, i) => `
      <div class="tl-clip ${c.id === selectedClipId ? "is-selected" : ""}" draggable="true" data-id="${c.id}" style="left:${clipStart(i) * PPS}px;width:${clipDur(c) * PPS - 4}px;--g:${gradFor(c.name)}">
        <span class="tl-trim l" data-trim="l" data-id="${c.id}" title="向右拖：裁掉开头"></span>
        <span class="tl-clip-name">${esc(c.name)}</span>
        <span class="tl-clip-dur">${clipDur(c)}s${c.trimIn ? ` · 裁头${c.trimIn}s` : ""}</span>
        <button class="tl-clip-x" data-x="${c.id}">${icon("x", 10)}</button>
        <span class="tl-trim r" data-trim="r" data-id="${c.id}" title="向左拖：裁掉结尾"></span>
      </div>`).join("") : `<div class="tl-empty">把生成的片段「加入剪辑」，或点「一键智能拼接」</div>`;

    const stk = $("#tlSubTrack", root); stk.style.width = W + "px";
    stk.innerHTML = SUBS().map((s, i) => `
      <div class="tl-sub ${i === activeSubIdx ? "is-active" : ""}" data-i="${i}" style="left:${(s.start || 0) * PPS}px;width:${Math.max(24, ((s.end || 0) - (s.start || 0)) * PPS - 2)}px">
        <span class="tl-sub-text">${esc(cleanCaptionText(s.text || "字幕"))}</span>
        <span class="tl-sub-resize" data-i="${i}"></span>
      </div>`).join("");

    wireClips(); wireSubs();
    drawSubEditor(); updatePlayhead();
  }

  function updatePlayhead() {
    const ph = $("#tlPlayhead", root); if (!ph) return;
    playheadT = clamp(playheadT, 0, totalDur());
    ph.style.left = (52 + playheadT * PPS) + "px";
    $("#cpTimecode", root).textContent = `${fmtTC(playheadT)} / ${fmtTC(totalDur())}`;
    let label = "", grad = "", clip = null, clipBase = 0;
    let acc2 = 0;
    for (const c of TL()) { if (playheadT < acc2 + clipDur(c)) { label = c.name; grad = gradFor(c.name); clip = c; clipBase = acc2; break; } acc2 += clipDur(c); }
    $("#cpClipLabel", root).textContent = label;
    const video = $("#cpVideo", root);
    const videoUrl = videoUrlForClip(clip);
    if (videoUrl) {
      const localTime = Math.max(0, playheadT - clipBase + (clip?.trimIn || 0));
      if (video.dataset.src !== videoUrl) {
        video.dataset.src = videoUrl;
        video.src = videoUrl;
        video.addEventListener("loadedmetadata", () => {
          if (Number.isFinite(video.duration)) video.currentTime = Math.min(localTime, Math.max(0, video.duration - 0.1));
          if (playTimer) video.play().catch(() => null);
        }, { once: true });
      } else if (!video.seeking && Math.abs((video.currentTime || 0) - localTime) > 0.6) {
        video.currentTime = Math.min(localTime, Math.max(0, (video.duration || localTime + 1) - 0.1));
      }
      video.hidden = false;
      $("#cpFrame", root).style.opacity = ".18";
    } else {
      video.pause();
      video.removeAttribute("src");
      delete video.dataset.src;
      video.load();
      video.hidden = true;
      $("#cpFrame", root).style.opacity = ".85";
    }
    $("#cpFrame", root).style.background = grad || "linear-gradient(135deg,#1a2540,#0c1322)";
    const sub = SUBS().find(s => playheadT >= (s.start || 0) && playheadT < (s.end || 0));
    const el = $("#cpSub", root);
    if (sub && (sub.text || "").trim()) { el.hidden = false; el.textContent = cleanCaptionText(sub.text); }
    else { const s2 = SUBS()[activeSubIdx]; if (s2 && (s2.text || "").trim() && !playTimer) { el.hidden = false; el.textContent = cleanCaptionText(s2.text); } else el.hidden = true; }
    applySubStyle();
    syncPreviewAudio(!!playTimer);
  }
  function applySubStyle() {
    const el = $("#cpSub", root); if (!el) return;
    const st = p.artifacts.subStyle;
    el.style.fontSize = st.size + "px";
    el.style.bottom = st.bottom + "%";
    el.style.webkitTextStroke = st.stroke ? `${st.stroke}px rgba(0,0,0,.85)` : "";
    el.style.paintOrder = "stroke fill";
  }
  function syncPreviewAudio(shouldPlay = false) {
    const narration = $("#cpNarration", root);
    const bgm = $("#cpBgmAudio", root);
    const setAudioSrc = (audio, src) => {
      if (!audio) return;
      const next = src || "";
      if ((audio.getAttribute("src") || "") === next) return;
      const wasPlaying = !audio.paused;
      audio.setAttribute("src", next);
      audio.load();
      if (shouldPlay || wasPlaying) audio.play().catch(() => null);
    };
    setAudioSrc(narration, narrationPreviewUrl());
    setAudioSrc(bgm, bgmPreviewUrl());
    const syncOne = (audio, t, volume = 1) => {
      if (!audio || !audio.getAttribute("src")) return;
      audio.volume = clamp(volume, 0, 1);
      const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const target = dur ? Math.min(Math.max(0, t), Math.max(0, dur - 0.05)) : Math.max(0, t);
      if (!audio.seeking && Math.abs((audio.currentTime || 0) - target) > 0.55) {
        try { audio.currentTime = target; } catch {}
      }
      if (shouldPlay && audio.paused) audio.play().catch(() => null);
    };
    syncOne(narration, playheadT, 1);
    const bgmDur = Number.isFinite(bgm?.duration) && bgm.duration > 0 ? bgm.duration : 0;
    syncOne(bgm, bgmDur ? playheadT % bgmDur : playheadT, p.artifacts.bgm?.volume ?? 0.25);
  }
  const stopPlay = () => {
    const video = $("#cpVideo", root);
    if (video) video.pause();
    $("#cpNarration", root)?.pause();
    $("#cpBgmAudio", root)?.pause();
    if (playTimer) { clearInterval(playTimer); playTimer = null; $("#cpPlay", root).innerHTML = icon("play", 22); }
  };
  const togglePlay = () => {
    if (playTimer) { stopPlay(); return; }
    if (!TL().length && !SUBS().length) { toast("时间轴还是空的"); return; }
    if (playheadT >= totalDur() - 0.05) playheadT = 0;
    const video = $("#cpVideo", root);
    if (video && !video.hidden && video.src) video.play().catch(() => null);
    syncPreviewAudio(true);
    $("#cpPlay", root).innerHTML = icon("pause", 22);
    playTimer = setInterval(() => {
      playheadT += 0.1;
      if (playheadT >= totalDur()) { playheadT = totalDur(); stopPlay(); }
      updatePlayhead();
    }, 100);
  };

  /* ---------- 片段轨交互 ---------- */
  function wireClips() {
    let dragId = null;
    $$(".tl-clip-x", root).forEach(x => x.addEventListener("click", e => {
      e.stopPropagation(); snapshot();
      p.artifacts.timeline = TL().filter(c => c.id !== x.dataset.x);
      save("productions"); drawTimeline();
    }));
    $$(".tl-clip", root).forEach(el => {
      el.addEventListener("click", e => {
        if (e.target.closest(".tl-trim") || e.target.closest(".tl-clip-x")) return;
        selectedClipId = selectedClipId === el.dataset.id ? null : el.dataset.id;
        drawTimeline();
      });
      el.addEventListener("dragstart", () => { dragId = el.dataset.id; el.classList.add("dragging"); });
      el.addEventListener("dragend", () => el.classList.remove("dragging"));
    });
    $$(".tl-trim", root).forEach(h => {
      h.addEventListener("pointerdown", e => {
        e.stopPropagation(); e.preventDefault();
        const c = TL().find(x => x.id === h.dataset.id); if (!c) return;
        const side = h.dataset.trim, startX = e.clientX, origDur = clipDur(c), origIn = c.trimIn || 0;
        snapshot();
        h.setPointerCapture(e.pointerId);
        const el = h.closest(".tl-clip");
        el.draggable = false; el.classList.add("trimming");
        const move = ev => {
          const ds = (ev.clientX - startX) / PPS;
          if (side === "r") c.dur = Math.round(Math.max(2, Math.min(CLIP_SEC - origIn, origDur + ds)) * 2) / 2;
          else {
            const nd = Math.round(Math.max(2, Math.min(origDur + origIn, origDur - ds)) * 2) / 2;
            c.trimIn = Math.round((origIn + (origDur - nd)) * 2) / 2;
            c.dur = nd;
          }
          el.style.width = (clipDur(c) * PPS - 4) + "px";
          el.querySelector(".tl-clip-dur").textContent = `${clipDur(c)}s${c.trimIn ? ` · 裁头${c.trimIn}s` : ""}`;
        };
        const up = () => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); save("productions"); drawTimeline(); };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
      });
    });
    const ct = $("#tlClipTrack", root);
    ct.addEventListener("dragover", e => e.preventDefault());
    ct.addEventListener("drop", e => {
      e.preventDefault(); if (!dragId) return;
      const rect = ct.getBoundingClientRect();
      const x = e.clientX - rect.left;
      let to = TL().length - 1;
      for (let i = 0; i < TL().length; i++) { if (x < (clipStart(i) + clipDur(TL()[i]) / 2) * PPS) { to = Math.max(0, i); break; } }
      const from = TL().findIndex(c => c.id === dragId);
      if (from < 0) return;
      snapshot();
      const [m] = TL().splice(from, 1); TL().splice(to, 0, m); dragId = null;
      save("productions"); drawTimeline();
    });
  }

  /* ---------- 字幕轨交互 ---------- */
  function wireSubs() {
    $$(".tl-sub-resize", root).forEach(h => {
      h.addEventListener("pointerdown", e => {
        e.stopPropagation(); e.preventDefault();
        const i = +h.dataset.i; const s = SUBS()[i]; if (!s) return;
        const startX = e.clientX, origEnd = s.end || 0;
        let snapped = false;
        h.setPointerCapture(e.pointerId);
        const el = h.closest(".tl-sub");
        const move = ev => {
          if (!snapped) { snapshot(); snapped = true; }
          s.end = Math.max((s.start || 0) + 0.5, Math.round((origEnd + (ev.clientX - startX) / PPS) * 2) / 2);
          el.style.width = Math.max(24, (s.end - (s.start || 0)) * PPS - 2) + "px";
        };
        const up = () => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); save("productions"); drawTimeline(); };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
      });
    });
    $$(".tl-sub", root).forEach(el => {
      const i = +el.dataset.i;
      let startX = 0, origStart = 0, moved = false;
      el.addEventListener("pointerdown", e => {
        if (e.target.classList.contains("tl-sub-resize")) return;
        el.setPointerCapture(e.pointerId); startX = e.clientX; origStart = SUBS()[i].start || 0; moved = false;
        activeSubIdx = i;
        $$(".tl-sub", root).forEach(x => x.classList.toggle("is-active", +x.dataset.i === i));
        drawSubEditor(); updatePlayhead();
      });
      el.addEventListener("pointermove", e => {
        if (!el.hasPointerCapture(e.pointerId)) return;
        const dx = e.clientX - startX; if (Math.abs(dx) < 3) return;
        if (!moved) { snapshot(); moved = true; }
        const s = SUBS()[i]; const dur = (s.end || 0) - (s.start || 0);
        const ns = Math.max(0, Math.round((origStart + dx / PPS) * 2) / 2);
        s.start = ns; s.end = ns + dur;
        el.style.left = (ns * PPS) + "px";
      });
      el.addEventListener("pointerup", () => { if (moved) { save("productions"); drawTimeline(); } });
    });
  }

  function drawSubEditor() {
    const box = $("#tlSubEditor", root); if (!box) return;
    const subs = SUBS();
    if (!subs.length) { box.innerHTML = `<div class="muted" style="padding:8px 2px">还没有字幕：点「从口播填字幕」自动铺好，或「+ 字幕块」手动加。</div>`; return; }
    const i = Math.min(activeSubIdx, subs.length - 1); const s = subs[i];
    const st = p.artifacts.subStyle;
    box.innerHTML = `
      <div class="tse-row">
        <b>第 ${i + 1} 条字幕</b>
        <input class="input num" id="tseStart" type="number" min="0" step="0.5" value="${s.start}" /> →
        <input class="input num" id="tseEnd" type="number" min="0" step="0.5" value="${s.end}" /> 秒
        <textarea class="input grow" id="tseText" rows="1" placeholder="字幕文字，可换行">${esc(s.text || "")}</textarea>
        <button class="icon-btn danger" id="tseDel" title="删除此条">${icon("trash", 14)}</button>
      </div>
      <div class="tse-row style">
        <span>字号</span><input type="range" id="tseSize" min="10" max="26" step="1" value="${st.size}" /><em id="tseSizeV">${st.size}px</em>
        <span>描边</span><input type="range" id="tseStroke" min="0" max="5" step="0.5" value="${st.stroke}" /><em id="tseStrokeV">${st.stroke}px</em>
        <span>垂直位置</span><input type="range" id="tseBottom" min="4" max="80" step="1" value="${st.bottom}" /><em id="tseBottomV">距底 ${st.bottom}%</em>
      </div>`;
    let edited = false;
    const snapOnce = () => { if (!edited) { snapshot(); edited = true; } };
    $("#tseStart", root).addEventListener("input", e => { snapOnce(); s.start = parseFloat(e.target.value) || 0; save("productions"); drawTimeline(); });
    $("#tseEnd", root).addEventListener("input", e => { snapOnce(); s.end = parseFloat(e.target.value) || 0; save("productions"); drawTimeline(); });
    $("#tseText", root).addEventListener("input", e => {
      snapOnce(); s.text = e.target.value; save("productions");
      const blk = $$(".tl-sub", root)[i];
      if (blk) blk.querySelector(".tl-sub-text").textContent = cleanCaptionText(e.target.value || "字幕");
      updatePlayhead();
    });
    $("#tseDel", root).addEventListener("click", () => { snapshot(); subs.splice(i, 1); if (activeSubIdx >= subs.length) activeSubIdx = Math.max(0, subs.length - 1); save("productions"); drawTimeline(); });
    const wireStyle = (id, valId, key, fmt) => {
      $(id, root).addEventListener("input", e => {
        snapOnce(); p.artifacts.subStyle[key] = parseFloat(e.target.value);
        $(valId, root).textContent = fmt(p.artifacts.subStyle[key]);
        save("productions"); applySubStyle(); updatePlayhead();
      });
    };
    wireStyle("#tseSize", "#tseSizeV", "size", v => v + "px");
    wireStyle("#tseStroke", "#tseStrokeV", "stroke", v => v + "px");
    wireStyle("#tseBottom", "#tseBottomV", "bottom", v => "距底 " + v + "%");
  }

  /* ---------- 工具栏 ---------- */
  $("#cutAuto", root).addEventListener("click", () => {
    snapshot();
    const r = autoAssemble(p);
    if (!r.clips && !TL().length) { toast(isVideoWorkshop(p) ? "还没有就绪片段：回分镜工坊「一键全自动」生成" : "还没有可用片段：先去生成台生成，或等 Agent 渲染完成"); return; }
    renderCutPage(root, p);
    toast(`智能${isVideoWorkshop(p) ? "混剪" : "拼接"}完成：${TL().length} 段 + ${SUBS().length} 条字幕${r.bgm ? ` · BGM「${r.bgm}」` : ""}`);
  });
  const bgmSel = $("#cutBgm", root);
  if (bgmSel) bgmSel.addEventListener("change", e => {
    const name = e.target.value;
    if (!name) { p.artifacts.bgm = null; }
    else if (name.startsWith("asset:")) {
      const id = name.slice(6);
      const a = state.assets.find(x => x.id === id);
      p.artifacts.bgm = { name: a?.name || "上传 BGM", assetId: id, mood: "自定义", volume: p.artifacts.bgm?.volume ?? 0.25, auto: false };
    }
    else {
      const b = BGM_POOL.find(x => x.name === name);
      p.artifacts.bgm = { name, mood: b?.mood || "", volume: p.artifacts.bgm?.volume ?? 0.25, auto: false };
    }
    save("productions");
    toast(name ? `BGM 已换为「${p.artifacts.bgm?.name || name}」` : "已移除 BGM");
  });
  const addBgmFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("audio/")) { toast("BGM 只支持音频文件", "error"); return; }
    const a = await addAssetFromFile(p.accountId, file, { tags: ["BGM", "音乐库"], name: file.name.replace(/\.[^.]+$/, "") });
    p.artifacts.bgm = { name: a.name, assetId: a.id, mood: "自定义", volume: p.artifacts.bgm?.volume ?? 0.25, auto: false };
    save("productions", "assets", "meta");
    toast(`已加入 BGM 库：${a.name}`);
    renderCutPage(root, p);
  };
  const bgmDrop = $("#cutBgmDrop", root);
  if (bgmDrop) {
    wireDropZone(bgmDrop, files => addBgmFile(Array.from(files || [])[0]), { filesOnly: true });
    bgmDrop.addEventListener("click", () => $("#cutBgmUp", root)?.click());
  }
  $("#cutBgmUp", root)?.addEventListener("change", e => addBgmFile(e.target.files?.[0]));
  const bgmVol = $("#cutBgmVol", root);
  if (bgmVol) bgmVol.addEventListener("input", e => {
    if (!p.artifacts.bgm) {
      const b = pickBgm(acc?.styleProfile || acc?.voiceName, p.topic);
      p.artifacts.bgm = { name: b.name, mood: b.mood, volume: 0.25, auto: false };
    }
    p.artifacts.bgm.volume = (+e.target.value) / 100;
    $("#cutBgmVolV", root).textContent = e.target.value + "%";
    save("productions");
  });
  $("#tlFillSubs", root).addEventListener("click", () => {
    const rows = (p.artifacts.script.shots || []).filter(s => (s.line || "").trim());
    if (!rows.length) { toast("脚本里没有口播/画外音"); return; }
    snapshot();
    let t = 0; const subs = [];
    const per = p.artifacts.audio?.perShot || [];
    (p.artifacts.script.shots || []).forEach((s, i) => {
      const line = (s.line || "").trim();
      const d = isVideoWorkshop(p) ? ((per[i] && per[i].dur) || 3) : 0;
      let st = t, en;
      if (isVideoWorkshop(p)) {
        en = st + d;
      } else {
        const m = String(s.time || "").match(/(\d+)\s*-\s*(\d+)/);
        if (m) { st = +m[1]; en = +m[2]; } else { en = st + 3; }
      }
      t = en;
      if (line) subs.push(...spreadCaption(line, st, en));
    });
    p.artifacts.subs = subs;
    save("productions"); drawTimeline();
    toast(`已从脚本填入 ${p.artifacts.subs.length} 条字幕（长句已自动断行）`);
  });
  $("#tlAddSub", root).addEventListener("click", () => {
    snapshot();
    const subs = SUBS(); const last = subs[subs.length - 1];
    const st = last ? last.end : Math.round(playheadT);
    subs.push({ start: st, end: st + 3, text: "" });
    activeSubIdx = subs.length - 1;
    save("productions"); drawTimeline();
  });
  $("#tlSplit", root).addEventListener("click", () => {
    const c = TL().find(x => x.id === selectedClipId);
    if (!c) { toast("先点选一个片段，再把播放头拖到分割点"); return; }
    const i = TL().indexOf(c);
    const start = clipStart(i);
    const at = playheadT - start;
    if (at <= 0.5 || at >= clipDur(c) - 0.5) { toast("播放头要落在片段中间才能分割"); return; }
    snapshot();
    const d1 = Math.round(at * 2) / 2;
    const c2 = { id: Math.random().toString(36).slice(2, 10), jobId: c.jobId, name: c.name + " ·切", dur: clipDur(c) - d1, trimIn: (c.trimIn || 0) + d1 };
    c.dur = d1;
    TL().splice(i + 1, 0, c2);
    save("productions"); drawTimeline();
    toast("已在播放头处分割");
  });
  $("#tlSrt", root).addEventListener("click", () => {
    const srt = buildSRT(SUBS());
    if (!srt) { toast("还没有字幕"); return; }
    downloadBlob(buildDeliveryName(acc, (acc.exportSeq || 0) + 1) + ".srt", new Blob([srt], { type: "text/plain" }));
    toast("已下载 .srt");
  });
  $("#tlUndo", root).addEventListener("click", undo);
  $("#tlZoomIn", root).addEventListener("click", () => { PPS = Math.min(100, Math.round(PPS * 1.3)); drawTimeline(); });
  $("#tlZoomOut", root).addEventListener("click", () => { PPS = Math.max(14, Math.round(PPS / 1.3)); drawTimeline(); });
  $("#cpPlay", root).addEventListener("click", togglePlay);
  $("#cutCompose", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
    if (!TL().length) { toast("时间轴为空：先一键智能拼接"); return; }
    const clips = TL().map(c => ({
      url: videoUrlForClip(c),
      name: c.name || "",
      dur: c.dur || 15,
      trimIn: c.trimIn || 0
    })).filter(c => c.url);
    if (!clips.length) { toast("时间轴里还没有真实视频回链"); return; }
    const narrationMedia = await assetMedia(p.artifacts.audio?.assetId);
    const bgmMedia = await assetMedia(p.artifacts.bgm?.assetId);
    const res = await fetch("/api/video/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: p.artifacts.copy?.title || p.title || p.topic || "final",
        clips,
        narrationDataUrl: narrationMedia.dataUrl || "",
        narrationUrl: narrationMedia.url || "",
        bgmDataUrl: bgmMedia.dataUrl || "",
        bgmUrl: bgmMedia.url || "",
        bgmVolume: p.artifacts.bgm?.volume ?? 0.25
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.detail || data.error || `合成失败 (${res.status})`);
    p.artifacts.finalVideoUrl = data.url;
    p.artifacts.finalVideoName = data.name || "";
    save("productions");
    toast("合成成片已生成，交付包将优先使用这个 mp4");
    renderCutPage(root, p);
  }, "合成中…").catch(err => toast(err.message || "合成失败", "error")));
  $("#tlRuler", root).addEventListener("pointerdown", e => {
    const rect = $("#tlRuler", root).getBoundingClientRect();
    stopPlay(); playheadT = (e.clientX - rect.left) / PPS; updatePlayhead();
  });
  $("#tlPlayhead", root).addEventListener("pointerdown", e => {
    e.preventDefault(); stopPlay();
    const ph = $("#tlPlayhead", root);
    ph.setPointerCapture(e.pointerId);
    const move = ev => {
      const rect = $("#tlRuler", root).getBoundingClientRect();
      playheadT = (ev.clientX - rect.left) / PPS; updatePlayhead();
    };
    const up = () => { ph.removeEventListener("pointermove", move); ph.removeEventListener("pointerup", up); };
    ph.addEventListener("pointermove", move);
    ph.addEventListener("pointerup", up);
  });
  // 预览字幕拖动调位置
  const cpSub = $("#cpSub", root);
  cpSub.addEventListener("pointerdown", e => {
    e.preventDefault(); snapshot();
    cpSub.setPointerCapture(e.pointerId);
    const screen = $("#cpScreen", root);
    const move = ev => {
      const rect = screen.getBoundingClientRect();
      const pct = Math.round((rect.bottom - ev.clientY) / rect.height * 100);
      p.artifacts.subStyle.bottom = clamp(pct, 4, 80);
      applySubStyle();
      const r = $("#tseBottom", root); if (r) { r.value = p.artifacts.subStyle.bottom; $("#tseBottomV", root).textContent = "距底 " + p.artifacts.subStyle.bottom + "%"; }
    };
    const up = () => { cpSub.removeEventListener("pointermove", move); cpSub.removeEventListener("pointerup", up); save("productions"); };
    cpSub.addEventListener("pointermove", move);
    cpSub.addEventListener("pointerup", up);
  });
  // ⌘Z
  const keyHandler = e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && document.body.dataset.zone === "studio" && root.isConnected) {
      const tag = (document.activeElement || {}).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault(); undo();
    }
  };
  document.addEventListener("keydown", keyHandler);
  window.addEventListener("view:rendered", function off() {
    if (!root.isConnected) { document.removeEventListener("keydown", keyHandler); window.removeEventListener("view:rendered", off); }
  });

  $("#cutNext", root).addEventListener("click", () => {
    if (!TL().length) { toast("时间轴为空：先加入片段或一键智能拼接"); return; }
    if (p.stage === "cut" || p.stage === "render") setStage(p, "copy", "pending");
    go("studio", "copy");
  });

  drawTimeline();
}
