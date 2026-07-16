/* 链路 · 智能剪辑页：自动拼接 + 时间轴精修
   片段：拖拽排序 / 两端裁剪 / 播放头处分割 / 删除；字幕：自动铺入 / 拖动 / 拉伸 / 样式；SRT 导出；撤销；缩放 */

import { $, $$, esc, gradFor, fmtTC, buildSRT, downloadBlob, clamp, spreadCaption, cleanCaptionText, wireDropZone } from "../core/util.js?v=20260623-captions";
import { icon } from "../ui/icons.js";
import { save, accountById, state } from "../core/store.js";
import { autoAssemble, setStage, isVideoWorkshop } from "../domain/productions.js";
import { buildDeliveryName } from "../domain/accounts.js";
import { addAssetFromFile, assetBlob, globalBgmAssets, urlFor } from "../domain/assets.js";
import { toast, openVideoPreview } from "../ui/components.js";
import { go } from "../core/router.js";
import { stepperHtml, wireStepper } from "./studio.js?v=20260716-v88-1";

let PPS = 40;
const CLIP_SEC = 15;
const COMPOSE_TIMEOUT_MS = 3 * 60 * 1000;
const histories = new Map(); // productionId -> []
const activeComposes = new Set();
const activeAudioTiming = new Set();
const activeAudioTimingTasks = new Map();

export function renderCutPage(root, p) {
  root.__cutStopPlay?.();
  root.__cutStopPlay = null;
  if (p.artifacts.composing && !activeComposes.has(p.id)) {
    p.artifacts.composing = false;
    p.artifacts.composeError = "上次合成已中断，请重新点击下一步";
    save("productions");
  }
  if (p.artifacts.audioTimingPending && !activeAudioTiming.has(p.id)) {
    p.artifacts.audioTimingPending = false;
    save("productions");
  }
  const acc = accountById(p.accountId);
  const legacySubStyle = p.artifacts.subStyle
    && Number(p.artifacts.subStyle.size) === 13
    && Number(p.artifacts.subStyle.stroke) === 2
    && Number(p.artifacts.subStyle.bottom) === 12;
  const lowSubStyle = p.artifacts.subStyle
    && Number(p.artifacts.subStyle.size) === 11
    && Number(p.artifacts.subStyle.stroke) === 1
    && Number(p.artifacts.subStyle.bottom) === 5;
  if (!p.artifacts.subStyle || legacySubStyle || lowSubStyle) {
    p.artifacts.subStyle = { size: 11, stroke: 1, bottom: 22 };
    if (legacySubStyle || lowSubStyle) {
      p.artifacts.finalVideoUrl = "";
      p.artifacts.finalVideoCaptionSig = "";
    }
    save("productions");
  }
  let playheadT = 0;
  let playTimer = null;
  let playStartedAt = 0;
  let playStartedT = 0;
  let timelineRedrawFrame = null;
  let activeSubIdx = 0;
  let selectedClipId = null;
  let activeTrack = "";
  let subtitleClipboard = null;

  const TL = () => p.artifacts.timeline || (p.artifacts.timeline = []);
  const SUBS = () => p.artifacts.subs || (p.artifacts.subs = []);
  const isDigitalHuman = () => p.artifacts?.boards?.generationMode === "digitalHuman";
  const usesEstimatedMaterialCaptions = () => !isDigitalHuman();
  const protectedCaptionTiming = () => {
    const source = p.artifacts.subTimingSource || "";
    return source === "manual" || source.startsWith("audio-analysis-v5");
  };
  const clipDur = c => Math.max(1, c.dur != null ? c.dur : CLIP_SEC);
  const clipStart = i => { let t = 0; for (let k = 0; k < i; k++) t += clipDur(TL()[k]); return t; };
  const clipsTotal = () => TL().reduce((s, c) => s + clipDur(c), 0);
  const totalDur = () => Math.max(1, clipsTotal());
  const jobForClip = c => c?.jobId ? state.jobs.find(j => j.id === c.jobId) : null;
  const digitalSegmentForClip = c => (p.artifacts?.boards?.digitalHuman?.segments || [])
    .find(seg => (c?.segmentId && seg.id === c.segmentId) || (c?.jobId && seg.videoJobId === c.jobId));
  const videoUrlForClip = c => c?.videoUrl || jobForClip(c)?.output?.url || digitalSegmentForClip(c)?.videoOutput?.url || "";
  const audioAssets = () => globalBgmAssets();
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
  const videoJobsComplete = () => {
    const digital = p.artifacts?.boards?.digitalHuman?.segments || [];
    if (p.artifacts?.boards?.generationMode === "digitalHuman") {
      return digital.length > 0 && digital.every(seg => !!(seg.videoOutput?.url || seg.videoOutput?.videoUrl));
    }
    const jobs = state.jobs.filter(job => job.productionId === p.id && job.kind === "video");
    return jobs.length > 0 && jobs.every(job => job.status === "succeeded");
  };
  const captionSignature = () => JSON.stringify({
    cues: SUBS().map(s => [s.start, s.end, cleanCaptionText(s.text || "")]),
    style: p.artifacts.subStyle
  });
  const timelineSignature = () => JSON.stringify(TL().map(c => [c.id, c.videoUrl || c.jobId, c.dur, c.trimIn || 0]));
  const mixSignature = () => JSON.stringify({
    narration: p.artifacts.audio?.assetId || "clip-audio",
    narrationVolume: Number(p.artifacts.audio?.volume ?? 1),
    bgm: p.artifacts.bgm?.assetId || "",
    bgmVolume: Number(p.artifacts.bgm?.volume ?? 0.25),
    preserveClipAudio: isDigitalHuman()
  });
  const invalidateFinalMix = () => {
    p.artifacts.finalVideoUrl = "";
    p.artifacts.finalVideoName = "";
    p.artifacts.finalVideoMixSig = "";
    p.artifacts.composeError = "";
  };
  const needsCompose = () => !!TL().length && (!p.artifacts.finalVideoUrl
    || p.artifacts.finalVideoCaptionSig !== captionSignature()
    || p.artifacts.finalVideoTimelineSig !== timelineSignature()
    || p.artifacts.finalVideoMixSig !== mixSignature());

  // Keep one caption lane readable: generated cues follow the finished clip duration,
  // while manual edits are clamped between adjacent cues instead of stacking.
  function normalizeCaptionTrack(subs = SUBS()) {
    const videoEnd = totalDur();
    const ranges = TL().map((clip, index) => ({
      index,
      start: clipStart(index),
      end: clipStart(index) + clipDur(clip)
    }));
    let cursor = 0;
    subs.sort((a, b) => (a.start || 0) - (b.start || 0));
    subs.forEach(s => {
      const duration = Math.max(.5, Number(s.end || 0) - Number(s.start || 0));
      const rawStart = Number(s.start || 0);
      const exactTiming = Boolean(s.precise || String(p.artifacts.subTimingSource || "").startsWith("audio-analysis-v5"));
      const range = Number.isInteger(Number(s.clipIndex))
        ? ranges[Number(s.clipIndex)]
        : ranges.find(item => rawStart >= item.start - .05 && rawStart < item.end);
      if (exactTiming) {
        const lower = range?.start ?? 0;
        const upper = range?.end ?? videoEnd;
        s.start = Math.round(clamp(rawStart, lower, Math.max(lower, upper - .05)) * 100) / 100;
        s.end = Math.round(clamp(Number(s.end || 0), s.start + .05, upper) * 100) / 100;
        return;
      }
      if (range) {
        if (cursor >= range.end - .12 || cursor < range.start) cursor = range.start;
        s.start = Math.round(Math.max(range.start, cursor, rawStart) * 10) / 10;
        s.end = Math.round(Math.min(range.end - .05, s.start + duration) * 10) / 10;
        if (s.end <= s.start) s.end = Math.round(Math.min(range.end, s.start + .25) * 10) / 10;
      } else {
        s.start = Math.round(clamp(Math.max(cursor, rawStart), 0, Math.max(0, videoEnd - .25)) * 10) / 10;
        s.end = Math.round(Math.min(videoEnd, s.start + duration) * 10) / 10;
      }
      s.start = clamp(s.start, 0, Math.max(0, videoEnd - .05));
      s.end = clamp(s.end, Math.min(videoEnd, s.start + .05), videoEnd);
      cursor = s.end + .1;
    });
    for (let i = subs.length - 1; i >= 0; i--) {
      if (!Number.isFinite(subs[i].start) || subs[i].start >= videoEnd || subs[i].end <= subs[i].start) subs.splice(i, 1);
    }
    return subs;
  }

  function splitCaptionText(text = "") {
    const value = String(text || "");
    if (!value) return ["", ""];
    const chars = [...value];
    const middle = Math.max(1, Math.min(chars.length - 1, Math.ceil(chars.length / 2)));
    return [chars.slice(0, middle).join("").trim(), chars.slice(middle).join("").trim()];
  }

  function activeCaptionAtPlayhead() {
    const direct = SUBS().findIndex(s => playheadT > Number(s.start || 0) + .05 && playheadT < Number(s.end || 0) - .05);
    if (direct >= 0) return direct;
    const current = SUBS()[activeSubIdx];
    return current && playheadT > Number(current.start || 0) + .05 && playheadT < Number(current.end || 0) - .05 ? activeSubIdx : -1;
  }

  function splitSubtitle({ keep = "both" } = {}) {
    const i = activeCaptionAtPlayhead();
    if (i < 0) { toast("把播放头放到要分割的字幕中间"); return false; }
    const source = SUBS()[i];
    const at = Math.round(playheadT * 10) / 10;
    if (at <= source.start + .1 || at >= source.end - .1) { toast("播放头要落在字幕中间"); return false; }
    snapshot();
    const [leftText, rightText] = splitCaptionText(source.text || "");
    const left = { ...source, end: at, text: leftText };
    const right = { ...source, start: at, text: rightText };
    const replacement = keep === "left" ? [left] : keep === "right" ? [right] : [left, right];
    SUBS().splice(i, 1, ...replacement);
    activeSubIdx = keep === "right" ? i : Math.min(i, SUBS().length - 1);
    activeTrack = "sub";
    p.artifacts.subTimingSource = "manual";
    normalizeCaptionTrack();
    save("productions");
    drawTimeline();
    toast(keep === "both" ? "已分割字幕" : keep === "left" ? "已分割并删除后段" : "已分割并删除前段");
    return true;
  }

  function copySubtitle({ cut = false } = {}) {
    const s = SUBS()[activeSubIdx];
    if (!s) { toast("先选择一条字幕"); return; }
    subtitleClipboard = { text: s.text || "", duration: Math.max(.5, Number(s.end || 0) - Number(s.start || 0)) };
    if (cut) {
      snapshot();
      SUBS().splice(activeSubIdx, 1);
      activeSubIdx = Math.max(0, Math.min(activeSubIdx, SUBS().length - 1));
      p.artifacts.subTimingSource = "manual";
      save("productions");
      drawTimeline();
    }
    toast(cut ? "已剪切字幕" : "已复制字幕");
  }

  function pasteSubtitle() {
    if (!subtitleClipboard) { toast("还没有复制字幕"); return; }
    const end = totalDur();
    const start = clamp(playheadT, 0, Math.max(0, end - .25));
    snapshot();
    SUBS().push({ start, end: Math.min(end, start + subtitleClipboard.duration), text: subtitleClipboard.text });
    p.artifacts.subTimingSource = "manual";
    normalizeCaptionTrack();
    activeSubIdx = Math.max(0, SUBS().findIndex(s => Math.abs(s.start - start) < .06));
    activeTrack = "sub";
    save("productions");
    drawTimeline();
    toast("已粘贴到播放头");
  }

  function rebuildDigitalCaptions() {
    const subs = [];
    let t = 0;
    TL().forEach(c => {
      const seg = digitalSegmentForClip(c);
      const line = String(seg?.line || "").trim();
      const end = t + clipDur(c);
      if (line) subs.push(...spreadCaption(line, t, end).map(s => ({ ...s, autoAligned: true })));
      t = end;
    });
    p.artifacts.subs = normalizeCaptionTrack(subs);
    p.artifacts.subTimingSource = "clip-audio";
  }

  function refreshCaptionAlignment({ force = false } = {}) {
    const digital = isDigitalHuman();
    const protectedTiming = protectedCaptionTiming();
    if (digital && !protectedTiming && (force || !SUBS().length || p.artifacts.subTimingSource !== "clip-audio")) rebuildDigitalCaptions();
    else normalizeCaptionTrack();
  }

  function captionTextForClip(clip) {
    const digital = digitalSegmentForClip(clip);
    if (digital?.line) return String(digital.line).trim();
    return "";
  }

  function cleanEstimatedCaption(text = "") {
    const value = cleanCaptionText(String(text || "")
      .replace(/\\n/g, " ")
      .replace(/[□■▢▣�\uFFFD]+/g, "")
      .replace(/<\|[^>]+\|>/g, "")
      .replace(/^(?:声音|台词|角色|主角|旁白|画外音)(?:\s*[\/:|：]→?\s*)?/i, "")
      .replace(/(?:声线锚点|说话像|运镜|镜头|画面|负面约束)[\s\S]*$/i, ""));
    if (!value || value.length < 2) return "";
    if (/^(?:声音|台词|角色|主角|旁白|画外音|镜头|画面)(?:\s|$)/.test(value)) return "";
    if (/^(?:快节奏|生成9 16|生成短视频|统一视觉风格|禁止|不出现)/.test(value)) return "";
    const useful = (value.match(/[\u3400-\u9fffA-Za-z0-9]/g) || []).length;
    if (useful / Math.max(1, value.length) < .62) return "";
    return value;
  }

  function explicitSpeechLines(text = "") {
    const value = String(text || "");
    const quoted = [...value.matchAll(/(?:(?:声音\s*\/\s*台词|口播原话|画外音旁白原文|口播|台词|对白|旁白|画外音)[^。；\n]{0,20}?|(?:角色|人物|用户)?(?:对镜头)?(?:说|吐槽|喊|回应)\s*)(?:[:：]\s*)?[“"「']([^“”"「」'\n]{2,100})[”"」']/g)]
      .map(match => cleanEstimatedCaption(match[1]))
      .filter(Boolean);
    const labeled = [...value.matchAll(/(?:声音\s*\/\s*台词|口播原话|画外音旁白原文|口播|台词|对白|旁白|画外音)\s*[:：]\s*([^。；\n]{2,100})/g)]
      .map(match => cleanEstimatedCaption(match[1].split(/(?:画面|镜头|运镜|景别)\s*[:：]/)[0]))
      .filter(Boolean);
    return [...new Set([...quoted, ...labeled])];
  }

  function timedSpeechHintsForClip(clip, index) {
    const digitalLine = cleanEstimatedCaption(captionTextForClip(clip));
    if (digitalLine) return [{ text: digitalLine, start: 0, end: clipDur(clip) }];
    const segment = (p.artifacts.boards?.infoFlow?.segments || [])[index] || {};
    const unit = (p.artifacts.boards?.units || []).find(item => item.id === clip.unitId);
    const prompt = String(segment.videoPrompt || unit?.prompt || unit?.videoPrompt || segment.visual || "");
    const markers = [...prompt.matchAll(/(\d+(?:\.\d+)?)\s*(?:-|–|—|~|至|到)\s*(\d+(?:\.\d+)?)\s*(?:s|秒)/gi)];
    const hints = [];
    markers.forEach((marker, markerIndex) => {
      const start = Math.max(0, Number(marker[1]));
      const end = Math.min(clipDur(clip), Number(marker[2]));
      const blockEnd = markers[markerIndex + 1]?.index ?? prompt.length;
      const block = prompt.slice(marker.index, blockEnd);
      explicitSpeechLines(block).forEach(text => hints.push({ text, start, end }));
    });
    if (!hints.length) explicitSpeechLines(prompt).forEach(text => hints.push({ text }));
    const seen = new Set();
    return hints.filter(hint => {
      const key = `${hint.start ?? ""}-${hint.end ?? ""}-${hint.text}`;
      if (!hint.text || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function alignCaptionsToAudio({ silent = false, force = false } = {}) {
    if (!force && p.artifacts.subTimingSource === "manual") return false;
    const clips = TL().map((clip, index) => {
      const hints = timedSpeechHintsForClip(clip, index);
      return {
        url: videoUrlForClip(clip),
        text: hints.map(hint => hint.text).join("，"),
        hints,
        strict: usesEstimatedMaterialCaptions()
      };
    }).filter(item => item.url);
    if (!clips.length) return false;
    if (p.artifacts.audioTimingPending) return await (activeAudioTimingTasks.get(p.id) || Promise.resolve(false));
    const attemptSig = JSON.stringify({ mode: isDigitalHuman() ? "digital-human" : "info-flow", clips });
    if (!force && p.artifacts.audioTimingAttemptSig === attemptSig) return false;
    p.artifacts.audioTimingAttemptSig = attemptSig;
    p.artifacts.audioTimingPending = true;
    activeAudioTiming.add(p.id);
    let settleTimingTask;
    let timingResult = false;
    activeAudioTimingTasks.set(p.id, new Promise(resolve => { settleTimingTask = resolve; }));
    save("productions");
    try {
      const res = await fetch("/api/video/audio-timing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clips })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !Array.isArray(data.cues) || !data.cues.length) throw new Error(data.detail || "未检测到可匹配的人声区间");
      const cues = data.cues
        .map(cue => ({ ...cue, text: cleanEstimatedCaption(cue.text), autoAligned: true, precise: cue.precise !== false }))
        .filter(cue => cue.text);
      if (!cues.length) throw new Error("未识别到可用的台词字幕");
      p.artifacts.subs = normalizeCaptionTrack(cues);
      p.artifacts.subTimingSource = "audio-analysis-v5";
      p.artifacts.audioTimingSource = data.source || "audio-analysis-v5";
      p.artifacts.finalVideoUrl = "";
      p.artifacts.finalVideoCaptionSig = "";
      save("productions");
      drawTimeline();
      if (!silent) toast(`已按真实视频人声识别 ${cues.length} 条字幕`);
      timingResult = true;
      return timingResult;
    } catch (err) {
      if (usesEstimatedMaterialCaptions() && p.artifacts.subTimingSource !== "manual") {
        p.artifacts.subs = [];
        p.artifacts.subTimingSource = "audio-analysis-v5-empty";
        p.artifacts.audioTimingSource = "whisper-script-forced-v1-no-match";
        p.artifacts.finalVideoUrl = "";
        p.artifacts.finalVideoCaptionSig = "";
        drawTimeline();
      }
      if (!silent) toast(usesEstimatedMaterialCaptions()
        ? `音轨中未确认到提示词口播，已移除猜测字幕：${err?.message || err}`
        : `音轨识别失败，已保留现有字幕：${err?.message || err}`, "error");
      timingResult = false;
      return timingResult;
    } finally {
      p.artifacts.audioTimingPending = false;
      activeAudioTiming.delete(p.id);
      activeAudioTimingTasks.delete(p.id);
      settleTimingTask?.(timingResult);
      save("productions");
    }
  }

  function syncClipDurationFromMedia(clipId, duration) {
    const clip = TL().find(c => c.id === clipId);
    const actual = Math.round(Number(duration || 0) * 10) / 10;
    if (!clip || !Number.isFinite(actual) || actual < 1 || Math.abs(clipDur(clip) - actual) < .2) return;
    clip.dur = actual;
    const seg = digitalSegmentForClip(clip);
    if (seg) {
      seg.audioDuration = actual;
      seg.dur = actual;
    }
    // 媒体 metadata 可能在用户手动改字幕后才到达；只能更新时长，不能覆盖手改轨道。
    normalizeCaptionTrack();
    if (!protectedCaptionTiming()) {
      p.artifacts.audioTimingAttemptSig = "";
    }
    p.artifacts.finalVideoUrl = "";
    p.artifacts.finalVideoName = "";
    p.artifacts.composeError = "";
    save("productions");
    if (!timelineRedrawFrame) {
      timelineRedrawFrame = requestAnimationFrame(() => {
        timelineRedrawFrame = null;
        if (root.isConnected && !playTimer) drawTimeline();
      });
    }
  }

  async function composeFinal({ automatic = false } = {}) {
    if (p.artifacts.composing || !TL().length) return false;
    const clips = TL().map(c => ({
      url: videoUrlForClip(c), name: c.name || "", dur: c.dur || 15, trimIn: c.trimIn || 0
    })).filter(c => c.url);
    if (!clips.length) return false;
    p.artifacts.composing = true;
    p.artifacts.composingStartedAt = Date.now();
    activeComposes.add(p.id);
    p.artifacts.composeError = "";
    save("productions");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COMPOSE_TIMEOUT_MS);
    try {
      const narrationMedia = await assetMedia(p.artifacts.audio?.assetId);
      const bgmMedia = await assetMedia(p.artifacts.bgm?.assetId);
      const res = await fetch("/api/video/compose", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: p.artifacts.copy?.title || p.title || p.topic || "final",
          clips,
          narrationDataUrl: narrationMedia.dataUrl || "",
          narrationUrl: narrationMedia.url || "",
          bgmDataUrl: bgmMedia.dataUrl || "",
          bgmUrl: bgmMedia.url || "",
          bgmVolume: p.artifacts.bgm?.volume ?? 0.25,
          narrationVolume: p.artifacts.audio?.volume ?? 1,
          preserveClipAudio: isDigitalHuman(),
          transitionDuration: p.artifacts?.boards?.generationMode === "digitalHuman" && clips.length > 1 ? 0.35 : 0,
          subtitleStyle: p.artifacts.subStyle,
          subtitles: SUBS().filter(s => cleanCaptionText(s.text || "")).map(s => ({
            start: Number(s.start || 0), end: Number(s.end || 0), text: cleanCaptionText(s.text || "")
          }))
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.detail || data.error || `合成失败 (${res.status})`);
      p.artifacts.finalVideoUrl = data.url;
      p.artifacts.finalVideoName = data.name || "";
      p.artifacts.finalVideoCaptionSig = captionSignature();
      p.artifacts.finalVideoTimelineSig = timelineSignature();
      p.artifacts.finalVideoMixSig = mixSignature();
      p.artifacts.composeError = "";
      return true;
    } catch (err) {
      p.artifacts.composeError = err?.name === "AbortError"
        ? "合成超过 3 分钟已停止，请重试"
        : (err?.message || "自动合成失败");
      if (!automatic) toast(p.artifacts.composeError, "error");
      return false;
    } finally {
      clearTimeout(timeout);
      p.artifacts.composing = false;
      p.artifacts.composingStartedAt = 0;
      activeComposes.delete(p.id);
      save("productions");
    }
  }

  if (p.artifacts?.boards?.generationMode === "digitalHuman" && (
    state.jobs.some(j => j.productionId === p.id && j.status === "succeeded")
    || (p.artifacts?.boards?.digitalHuman?.segments || []).some(seg => seg.videoOutput)
  )) {
    autoAssemble(p);
  } else if (!TL().length && state.jobs.some(j => j.productionId === p.id && j.status === "succeeded")) {
    autoAssemble(p);
  }
  refreshCaptionAlignment();

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
    ${stepperHtml(p, "cut").replace('chain-stepper', 'chain-stepper cut-stepper')}
    <div class="cut-page">
      <div class="cut-top">
        <section class="cut-preview card dark">
          <div class="cp-screen" id="cpScreen">
            <video class="cp-video" id="cpVideo" playsinline preload="metadata"></video>
            <video class="cp-video cp-video-next" id="cpVideoNext" playsinline preload="metadata" muted></video>
            <audio id="cpNarration" src="${esc(narrationPreviewUrl())}" preload="metadata"></audio>
            <audio id="cpBgmAudio" src="${esc(bgmPreviewUrl())}" preload="metadata" loop></audio>
            <div class="cp-frame" id="cpFrame"></div>
            <div class="cp-cliplabel" id="cpClipLabel"></div>
            <button class="cp-play" id="cpPlay">${icon("play", 22)}</button>
            <button class="cp-zoom icon-btn" id="cpZoom" title="放大预览">${icon("zoomIn", 16)}</button>
            <div class="cp-sub" id="cpSub" hidden></div>
          </div>
          <div class="cp-bar"><span id="cpTimecode">00:00 / 00:30</span></div>
        </section>
        <aside class="cut-side">
          <div class="side-card card">
            <h3>${p.artifacts.composing ? "正在合成" : "交付"}</h3>
            ${p.artifacts.composeError ? `<p class="muted">${esc(p.artifacts.composeError)}</p>` : ""}
            <button class="btn primary block button-anthe" id="cutNext"><span>下一步：审核 ${icon("arrowRight", 13)}</span></button>
          </div>
          ${isVideoWorkshop(p) ? `
          <div class="side-card card">
            <h3>${icon("music", 14)} 声音轨</h3>
            <div class="cut-audio-row vol">
              ${icon("mic", 12)} <span>口播</span>
              <input type="range" id="cutNarrationVol" min="0" max="100" step="5" value="${Math.round((p.artifacts.audio?.volume ?? 1) * 100)}" />
              <em id="cutNarrationVolV">${Math.round((p.artifacts.audio?.volume ?? 1) * 100)}%</em>
            </div>
            <div class="cut-audio-row cut-bgm-select">
              ${icon("music", 12)} BGM
              <select class="input sm" id="cutBgm" aria-label="选择 BGM">
                <option value="">无 BGM</option>
                ${audioAssets().length ? `<optgroup label="共享 BGM 库">${audioAssets().map(a => `<option value="asset:${esc(a.id)}" ${p.artifacts.bgm?.assetId === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</optgroup>` : ""}
              </select>
            </div>
            <div class="cut-bgm-drop" id="cutBgmDrop">${icon("upload", 12)} 拖拽 / 上传 BGM<input type="file" id="cutBgmUp" accept="audio/*" hidden /></div>
            <div class="cut-audio-row vol">
              <span>BGM 音量</span>
              <input type="range" id="cutBgmVol" min="5" max="60" step="5" value="${Math.round((p.artifacts.bgm?.volume ?? 0.25) * 100)}" />
              <em id="cutBgmVolV">${Math.round((p.artifacts.bgm?.volume ?? 0.25) * 100)}%</em>
            </div>
            <button class="btn ghost block" id="tlFillSubs" title="从视频真实音轨识别人声，并用现有文案智能纠错；识别质量不足时保留稳定估时字幕">${icon("type", 13)} 识别字幕</button>
          </div>` : ""}
        </aside>
      </div>

      <div class="tl-editor card">
        <div class="tl-toolbar">
          <div class="tlt-left">
            <b>时间轴</b>
            <em class="muted" id="tlMeta"></em>
          </div>
          <div class="tlt-actions">
            <button class="icon-btn sm tl-text-btn" id="tlAddSub" title="增加文字">T</button>
            <button class="icon-btn sm" id="tlSplit" title="在播放头处分割选中片段">${icon("split", 13)}</button>
            <button class="icon-btn sm" id="tlSubSplit" title="在播放头处分割字幕">${icon("scissors", 13)}</button>
            <button class="icon-btn sm" id="tlSubCopy" title="复制字幕">${icon("copy", 13)}</button>
            <button class="icon-btn sm" id="tlSrt" title="导出 SRT">${icon("download", 13)}</button>
            <button class="icon-btn sm" id="tlUndo" title="撤回">${icon("undo", 13)}</button>
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
      ? `${TL().length} 段 · ${Math.round(clipsTotal())}s`
      : "等待已生成视频";
    const ruler = $("#tlRuler", root);
    ruler.style.width = W + "px";
    const step = PPS >= 28 ? 5 : 10;
    let ticks = "";
    for (let t = 0; t <= total; t += step) ticks += `<span class="tl-tick" style="left:${t * PPS}px">${t}s</span>`;
    ruler.innerHTML = ticks;

    const ct = $("#tlClipTrack", root); ct.style.width = W + "px";
    ct.innerHTML = TL().length ? TL().map((c, i) => `
      <div class="tl-clip ${c.id === selectedClipId ? "is-selected" : ""}" draggable="true" data-id="${c.id}" style="left:${clipStart(i) * PPS}px;width:${clipDur(c) * PPS - 4}px;--g:${gradFor(c.name)}">
        ${videoUrlForClip(c) ? `<video class="tl-clip-preview" data-id="${esc(c.id)}" src="${esc(videoUrlForClip(c))}" muted playsinline preload="none"></video>` : ""}
        <span class="tl-trim l" data-trim="l" data-id="${c.id}" title="向右拖：裁掉开头"></span>
        <span class="tl-clip-name">${esc(c.name)}</span>
        <span class="tl-clip-dur">${clipDur(c)}s${c.trimIn ? ` · 裁头${c.trimIn}s` : ""}</span>
        <span class="tl-trim r" data-trim="r" data-id="${c.id}" title="向左拖：裁掉结尾"></span>
      </div>`).join("") : `<div class="tl-empty">生成完成的片段会自动加入时间轴</div>`;

    const stk = $("#tlSubTrack", root); stk.style.width = W + "px";
    stk.innerHTML = SUBS().map((s, i) => `
      <div class="tl-sub ${i === activeSubIdx ? "is-active" : ""}" data-i="${i}" style="left:${(s.start || 0) * PPS}px;width:${Math.max(24, ((s.end || 0) - (s.start || 0)) * PPS - 2)}px">
        <span class="tl-sub-text">${esc(cleanCaptionText(s.text || "字幕"))}</span>
        <span class="tl-sub-resize left" data-i="${i}" data-side="left" title="拖动字幕开始时间"></span>
        <span class="tl-sub-resize right" data-i="${i}" data-side="right" title="拖动字幕结束时间"></span>
      </div>`).join("");

    $$(".tl-clip-preview", root).forEach(video => video.addEventListener("loadedmetadata", () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      try { video.currentTime = Math.min(.35, Math.max(0, video.duration - .05)); } catch {}
      syncClipDurationFromMedia(video.dataset.id, video.duration);
    }, { once: true }));
    wireClips(); wireSubs();
    drawSubEditor(); updatePlayhead();
  }

  function updatePlayhead() {
    const ph = $("#tlPlayhead", root); if (!ph) return;
    playheadT = clamp(playheadT, 0, totalDur());
    ph.style.left = (52 + playheadT * PPS) + "px";
    $("#cpTimecode", root).textContent = `${fmtTC(playheadT)} / ${fmtTC(totalDur())}`;
    let label = "", grad = "", clip = null, clipBase = 0, clipIndex = -1;
    let acc2 = 0;
    for (let index = 0; index < TL().length; index++) {
      const c = TL()[index];
      if (playheadT < acc2 + clipDur(c)) {
        label = c.name;
        grad = gradFor(c.name);
        clip = c;
        clipBase = acc2;
        clipIndex = index;
        break;
      }
      acc2 += clipDur(c);
    }
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
      } else if (!video.seeking && Math.abs((video.currentTime || 0) - localTime) > 1.1) {
        video.currentTime = Math.min(localTime, Math.max(0, (video.duration || localTime + 1) - 0.1));
      }
      video.hidden = false;
      $("#cpFrame", root).style.opacity = "0";
    } else {
      video.pause();
      video.removeAttribute("src");
      delete video.dataset.src;
      video.load();
      video.hidden = true;
      $("#cpFrame", root).style.opacity = ".85";
    }
    const nextVideo = $("#cpVideoNext", root);
    const nextClip = clipIndex >= 0 ? TL()[clipIndex + 1] : null;
    const transition = isDigitalHuman() && nextClip ? 0.35 : 0;
    const remaining = clip ? clipBase + clipDur(clip) - playheadT : Infinity;
    const nextUrl = videoUrlForClip(nextClip);
    if (nextVideo && transition > 0 && nextUrl && remaining <= transition && remaining >= 0) {
      const transitionProgress = clamp((transition - remaining) / transition, 0, 1);
      const nextLocalTime = Math.max(0, transitionProgress * transition + (nextClip?.trimIn || 0));
      if (nextVideo.dataset.src !== nextUrl) {
        nextVideo.dataset.src = nextUrl;
        nextVideo.src = nextUrl;
        nextVideo.addEventListener("loadedmetadata", () => {
          if (Number.isFinite(nextVideo.duration)) nextVideo.currentTime = Math.min(nextLocalTime, Math.max(0, nextVideo.duration - 0.1));
          if (playTimer) nextVideo.play().catch(() => null);
        }, { once: true });
      } else if (!nextVideo.seeking && Math.abs((nextVideo.currentTime || 0) - nextLocalTime) > .45) {
        nextVideo.currentTime = Math.min(nextLocalTime, Math.max(0, (nextVideo.duration || nextLocalTime + 1) - 0.1));
      }
      nextVideo.style.opacity = String(transitionProgress);
      nextVideo.hidden = false;
      if (playTimer && nextVideo.paused) nextVideo.play().catch(() => null);
    } else if (nextVideo) {
      nextVideo.style.opacity = "0";
      nextVideo.pause();
      nextVideo.hidden = true;
    }
    $("#cpFrame", root).style.background = grad || "linear-gradient(135deg,#1a2540,#0c1322)";
    const sub = SUBS().find(s => playheadT >= (s.start || 0) && playheadT < (s.end || 0));
    const el = $("#cpSub", root);
    if (sub && (sub.text || "").trim()) { el.hidden = false; el.textContent = cleanCaptionText(sub.text); }
    else el.hidden = true;
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
      if (!audio.seeking && Math.abs((audio.currentTime || 0) - target) > 0.9) {
        try { audio.currentTime = target; } catch {}
      }
      if (shouldPlay && audio.paused) audio.play().catch(() => null);
    };
    syncOne(narration, playheadT, p.artifacts.audio?.volume ?? 1);
    const bgmDur = Number.isFinite(bgm?.duration) && bgm.duration > 0 ? bgm.duration : 0;
    syncOne(bgm, bgmDur ? playheadT % bgmDur : playheadT, p.artifacts.bgm?.volume ?? 0.25);
  }
  const stopPlay = () => {
    const video = $("#cpVideo", root);
    if (video) video.pause();
    $("#cpVideoNext", root)?.pause();
    $("#cpNarration", root)?.pause();
    $("#cpBgmAudio", root)?.pause();
    if (playTimer) cancelAnimationFrame(playTimer);
    playTimer = null;
    const playButton = $("#cpPlay", root);
    if (playButton) playButton.innerHTML = icon("play", 22);
  };
  root.__cutStopPlay = stopPlay;
  const togglePlay = () => {
    if (playTimer) { stopPlay(); return; }
    if (!TL().length && !SUBS().length) { toast("时间轴还是空的"); return; }
    if (playheadT >= totalDur() - 0.05) playheadT = 0;
    const video = $("#cpVideo", root);
    if (video && !video.hidden && video.src) video.play().catch(() => null);
    const nextVideo = $("#cpVideoNext", root);
    if (nextVideo && !nextVideo.hidden && nextVideo.src) nextVideo.play().catch(() => null);
    syncPreviewAudio(true);
    $("#cpPlay", root).innerHTML = icon("pause", 22);
    playStartedAt = performance.now();
    playStartedT = playheadT;
    const tick = now => {
      if (!playTimer) return;
      playheadT = playStartedT + Math.max(0, now - playStartedAt) / 1000;
      if (playheadT >= totalDur()) {
        playheadT = totalDur();
        updatePlayhead();
        stopPlay();
        return;
      }
      updatePlayhead();
      playTimer = requestAnimationFrame(tick);
    };
    playTimer = requestAnimationFrame(tick);
  };

  /* ---------- 片段轨交互 ---------- */
  function wireClips() {
    let dragId = null;
    $$(".tl-clip", root).forEach(el => {
      el.addEventListener("click", e => {
        if (e.target.closest(".tl-trim")) return;
        selectedClipId = selectedClipId === el.dataset.id ? null : el.dataset.id;
        activeTrack = selectedClipId ? "clip" : "";
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
        const side = h.dataset.side || "right";
        const startX = e.clientX, origStart = s.start || 0, origEnd = s.end || 0;
        let snapped = false;
        h.setPointerCapture(e.pointerId);
        const el = h.closest(".tl-sub");
        const move = ev => {
          if (!snapped) { snapshot(); snapped = true; }
          const delta = (ev.clientX - startX) / PPS;
          if (side === "left") {
            const prev = SUBS()[i - 1];
            const lower = prev ? (prev.end || 0) + .1 : 0;
            s.start = Math.min(origEnd - .5, Math.max(lower, Math.round((origStart + delta) * 2) / 2));
          } else {
            const next = SUBS()[i + 1];
            const upper = next ? Math.max((s.start || 0) + .5, (next.start || 0) - .1) : Infinity;
            s.end = Math.min(upper, Math.max((s.start || 0) + 0.5, Math.round((origEnd + delta) * 2) / 2));
          }
          el.style.left = (s.start * PPS) + "px";
          el.style.width = Math.max(24, (s.end - (s.start || 0)) * PPS - 2) + "px";
        };
        const up = () => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); p.artifacts.subTimingSource = "manual"; normalizeCaptionTrack(); save("productions"); drawTimeline(); };
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
        activeTrack = "sub";
        $$(".tl-sub", root).forEach(x => x.classList.toggle("is-active", +x.dataset.i === i));
        drawSubEditor(); updatePlayhead();
      });
      el.addEventListener("pointermove", e => {
        if (!el.hasPointerCapture(e.pointerId)) return;
        const dx = e.clientX - startX; if (Math.abs(dx) < 3) return;
        if (!moved) { snapshot(); moved = true; }
        const s = SUBS()[i]; const dur = (s.end || 0) - (s.start || 0);
        const prev = SUBS()[i - 1], next = SUBS()[i + 1];
        const lower = prev ? (prev.end || 0) + .1 : 0;
        const upper = next ? Math.max(lower, (next.start || 0) - dur - .1) : Infinity;
        const ns = Math.min(upper, Math.max(lower, Math.round((origStart + dx / PPS) * 2) / 2));
        s.start = ns; s.end = ns + dur;
        el.style.left = (ns * PPS) + "px";
      });
      el.addEventListener("pointerup", () => { if (moved) { p.artifacts.subTimingSource = "manual"; normalizeCaptionTrack(); save("productions"); drawTimeline(); } });
    });
  }

  function drawSubEditor() {
    const box = $("#tlSubEditor", root); if (!box) return;
    const subs = SUBS();
    if (!subs.length) { box.innerHTML = `<div class="muted" style="padding:8px 2px">按 T 从已绑定口播生成字幕，或用 + 新增字幕。</div>`; return; }
    const i = Math.min(activeSubIdx, subs.length - 1); const s = subs[i];
    const st = p.artifacts.subStyle;
    box.innerHTML = `
      <div class="tse-row">
        <b>第 ${i + 1} 条字幕</b>
        <input class="input num" id="tseStart" type="number" min="0" step="0.5" value="${s.start}" /> →
        <input class="input num" id="tseEnd" type="number" min="0" step="0.5" value="${s.end}" /> 秒
        <textarea class="input grow" id="tseText" rows="1" placeholder="字幕文字，可换行">${esc(s.text || "")}</textarea>
        <button class="btn ghost sm" id="tseSplitBefore" title="保留播放头后的字幕">删前段</button>
        <button class="btn ghost sm" id="tseSplitAfter" title="保留播放头前的字幕">删后段</button>
        <button class="icon-btn sm" id="tseDelete" title="删除当前字幕">${icon("trash", 13)}</button>
      </div>
      <div class="tse-row style">
        <span>字号</span><input type="range" id="tseSize" min="10" max="26" step="1" value="${st.size}" /><em id="tseSizeV">${st.size}px</em>
        <span>描边</span><input type="range" id="tseStroke" min="0" max="5" step="0.5" value="${st.stroke}" /><em id="tseStrokeV">${st.stroke}px</em>
        <span>垂直位置</span><input type="range" id="tseBottom" min="4" max="80" step="1" value="${st.bottom}" /><em id="tseBottomV">距底 ${st.bottom}%</em>
      </div>`;
    let edited = false;
    const snapOnce = () => { if (!edited) { snapshot(); edited = true; } };
    $("#tseStart", root).addEventListener("input", e => { snapOnce(); s.start = parseFloat(e.target.value) || 0; p.artifacts.subTimingSource = "manual"; normalizeCaptionTrack(); save("productions"); drawTimeline(); });
    $("#tseEnd", root).addEventListener("input", e => { snapOnce(); s.end = parseFloat(e.target.value) || 0; p.artifacts.subTimingSource = "manual"; normalizeCaptionTrack(); save("productions"); drawTimeline(); });
    $("#tseText", root).addEventListener("input", e => {
      snapOnce();
      s.text = e.target.value;
      p.artifacts.subTimingSource = "manual";
      save("productions");
      const blk = $$(".tl-sub", root)[i];
      if (blk) blk.querySelector(".tl-sub-text").textContent = cleanCaptionText(e.target.value || "字幕");
      updatePlayhead();
    });
    $("#tseSplitBefore", root).addEventListener("click", () => splitSubtitle({ keep: "right" }));
    $("#tseSplitAfter", root).addEventListener("click", () => splitSubtitle({ keep: "left" }));
    $("#tseDelete", root).addEventListener("click", () => {
      snapshot();
      SUBS().splice(i, 1);
      activeSubIdx = Math.max(0, Math.min(i, SUBS().length - 1));
      activeTrack = "";
      p.artifacts.subTimingSource = "manual";
      save("productions");
      drawTimeline();
      toast("已删除字幕，可用撤回恢复");
    });
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
  const bgmSel = $("#cutBgm", root);
  if (bgmSel) bgmSel.addEventListener("change", e => {
    const name = e.target.value;
    if (!name) { p.artifacts.bgm = null; }
    else if (name.startsWith("asset:")) {
      const id = name.slice(6);
      const a = state.assets.find(x => x.id === id);
      p.artifacts.bgm = { name: a?.name || "上传 BGM", assetId: id, mood: "自定义", volume: p.artifacts.bgm?.volume ?? 0.25, auto: false };
    }
    else { p.artifacts.bgm = null; }
    invalidateFinalMix();
    save("productions");
    toast(name ? `BGM 已换为「${p.artifacts.bgm?.name || name}」` : "已移除 BGM");
  });
  const addBgmFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("audio/")) { toast("BGM 只支持音频文件", "error"); return; }
    const a = await addAssetFromFile(null, file, { tags: ["BGM", "音乐库"], name: file.name.replace(/\.[^.]+$/, "") });
    p.artifacts.bgm = { name: a.name, assetId: a.id, mood: "自定义", volume: p.artifacts.bgm?.volume ?? 0.25, auto: false };
    invalidateFinalMix();
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
    if (!p.artifacts.bgm?.assetId) { toast("请先上传或选择一条 BGM", "error"); return; }
    p.artifacts.bgm.volume = (+e.target.value) / 100;
    $("#cutBgmVolV", root).textContent = e.target.value + "%";
    invalidateFinalMix();
    save("productions");
  });
  $("#cutNarrationVol", root)?.addEventListener("input", e => {
    p.artifacts.audio = p.artifacts.audio || {};
    p.artifacts.audio.volume = (+e.target.value) / 100;
    $("#cutNarrationVolV", root).textContent = e.target.value + "%";
    invalidateFinalMix();
    syncPreviewAudio(!!playTimer);
    save("productions");
  });
  $("#tlFillSubs", root).addEventListener("click", async () => {
    const digitalSegments = p.artifacts.boards?.digitalHuman?.segments || [];
    const rows = (p.artifacts.script.shots || []).filter(s => (s.line || "").trim());
    if (!digitalSegments.length && !rows.length) { toast("还没有可匹配的口播内容"); return; }
    snapshot();
    const button = $("#tlFillSubs", root);
    button.disabled = true;
    button.innerHTML = `${icon("refresh", 13)} 识别中…`;
    const aligned = await alignCaptionsToAudio({ force: true });
    button.disabled = false;
    button.innerHTML = `${icon("type", 13)} 识别字幕`;
    if (aligned) return;
    if (!isDigitalHuman()) {
      toast("没有在真实音轨中确认到提示词口播，已不生成猜测字幕", "error");
      return;
    }
    let t = 0; const subs = [];
    const per = p.artifacts.audio?.perShot || [];
    const sourceRows = digitalSegments.length
      ? digitalSegments.map(seg => ({ line: seg.line || "", dur: seg.audioDuration || seg.dur || 0 }))
      : (p.artifacts.script.shots || []).map((shot, i) => ({ ...shot, dur: per[i]?.dur || 0 }));
    sourceRows.forEach((s, i) => {
      const line = (s.line || "").trim();
      const d = isVideoWorkshop(p) ? (Number(s.dur) || (per[i] && per[i].dur) || 3) : 0;
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
    p.artifacts.subs = normalizeCaptionTrack(subs);
    p.artifacts.subTimingSource = "clip-audio";
    save("productions"); drawTimeline();
    toast(`已按已绑定口播排入 ${p.artifacts.subs.length} 条字幕`);
  });
  $("#tlAddSub", root).addEventListener("click", () => {
    snapshot();
    const subs = SUBS();
    const videoEnd = totalDur();
    const st = clamp(Math.round(playheadT * 10) / 10, 0, Math.max(0, videoEnd - .25));
    subs.push({ start: st, end: Math.min(videoEnd, st + 2.5), text: "" });
    p.artifacts.subTimingSource = "manual";
    normalizeCaptionTrack(subs);
    activeSubIdx = Math.max(0, subs.findIndex(s => Math.abs(Number(s.start || 0) - st) < .06));
    activeTrack = "sub";
    save("productions"); drawTimeline();
  });
  $("#tlSubSplit", root).addEventListener("click", () => splitSubtitle());
  $("#tlSubCopy", root).addEventListener("click", () => copySubtitle());
  $("#tlSplit", root).addEventListener("click", () => {
    const c = TL().find(x => x.id === selectedClipId);
    if (!c) { toast("先点选一个片段，再把播放头拖到分割点"); return; }
    const i = TL().indexOf(c);
    const start = clipStart(i);
    const at = playheadT - start;
    if (at <= 0.5 || at >= clipDur(c) - 0.5) { toast("播放头要落在片段中间才能分割"); return; }
    snapshot();
    const d1 = Math.round(at * 2) / 2;
    const c2 = {
      id: Math.random().toString(36).slice(2, 10), jobId: c.jobId, segmentId: c.segmentId || "",
      videoUrl: c.videoUrl || "", name: c.name + " ·切", dur: clipDur(c) - d1, trimIn: (c.trimIn || 0) + d1
    };
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
  $("#cpZoom", root).addEventListener("click", () => {
    let elapsed = 0, clip = null;
    for (const item of TL()) {
      if (playheadT < elapsed + clipDur(item)) { clip = item; break; }
      elapsed += clipDur(item);
    }
    const src = videoUrlForClip(clip);
    if (!src) { toast("当前播放头还没有可预览的视频"); return; }
    openVideoPreview(src, clip?.name || "片段预览");
  });
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
  // 键盘剪辑：Delete 删除；⌘Z 撤回；字幕支持 ⌘C / ⌘X / ⌘V。
  const keyHandler = e => {
    if (document.body.dataset.zone !== "studio" || !root.isConnected) return;
    const tag = (document.activeElement || {}).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement || {}).isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault(); undo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && activeTrack === "sub") {
      const key = e.key.toLowerCase();
      if (key === "c") { e.preventDefault(); copySubtitle(); return; }
      if (key === "x") { e.preventDefault(); copySubtitle({ cut: true }); return; }
      if (key === "v") { e.preventDefault(); pasteSubtitle(); return; }
    }
    if ((e.key === "Delete" || e.key === "Backspace") && activeTrack) {
      e.preventDefault();
      snapshot();
      if (activeTrack === "clip" && selectedClipId) {
        p.artifacts.timeline = TL().filter(clip => clip.id !== selectedClipId);
        selectedClipId = null;
      } else if (activeTrack === "sub" && SUBS()[activeSubIdx]) {
        SUBS().splice(activeSubIdx, 1);
        activeSubIdx = Math.max(0, Math.min(activeSubIdx, SUBS().length - 1));
        p.artifacts.subTimingSource = "manual";
      }
      activeTrack = "";
      save("productions"); drawTimeline();
    }
  };
  if (root.__cutKeyHandler) document.removeEventListener("keydown", root.__cutKeyHandler);
  root.__cutKeyHandler = keyHandler;
  document.addEventListener("keydown", keyHandler);
  window.addEventListener("view:rendered", function off() {
    if (!root.isConnected) {
      document.removeEventListener("keydown", keyHandler);
      if (root.__cutKeyHandler === keyHandler) delete root.__cutKeyHandler;
      window.removeEventListener("view:rendered", off);
    }
  });

  $("#cutNext", root).addEventListener("click", async event => {
    const nextButton = event.currentTarget;
    const resetNextButton = () => {
      nextButton.disabled = false;
      nextButton.innerHTML = `<span>下一步：审核 ${icon("arrowRight", 13)}</span>`;
    };
    if (!TL().length) { toast("时间轴为空：请先等待视频片段生成完成"); return; }
    if (p.artifacts.composing) { toast("正在自动合成成片，请稍候"); return; }
    const pendingVideoJobs = state.jobs.some(job => job.productionId === p.id
      && job.kind === "video"
      && ["queued", "submitted", "running"].includes(job.status));
    if (pendingVideoJobs) { toast("仍有视频片段生成中，全部就绪后再合成成片"); return; }
    if (!protectedCaptionTiming()) {
      await alignCaptionsToAudio({ silent: true });
    }
    if (videoJobsComplete() && needsCompose()) {
      nextButton.disabled = true;
      nextButton.innerHTML = `<span class="spin-dot"></span> 正在合成成片`;
      const composed = await composeFinal({ automatic: false });
      if (!composed) {
        resetNextButton();
        toast(p.artifacts.composeError || "成片合成失败，请重试", "error");
        return;
      }
    }
    if (p.mode === "视频" && !p.artifacts?.boards?.cover?.assetId) {
      toast("未检测到封面，正在自动生成");
      try {
        const { ensureVideoCover } = await import("./chainWorkshop.js?v=20260716-v88-1");
        await ensureVideoCover(p);
        toast("封面已自动生成并入库");
      } catch (err) {
        toast("封面自动生成失败：" + (err?.message || err), "error");
        resetNextButton();
        return;
      }
    }
    if (p.stage === "cut" || p.stage === "render" || p.stage === "copy") setStage(p, "review", "pending");
    go("studio", "review");
  });

  drawTimeline();
  const timingSource = p.artifacts.subTimingSource || "";
  if (timingSource !== "manual" && TL().some(c => videoUrlForClip(c)) && !p.artifacts.audioTimingPending) {
    if (!protectedCaptionTiming()) {
      queueMicrotask(() => alignCaptionsToAudio({ silent: true }));
    }
  }
}
