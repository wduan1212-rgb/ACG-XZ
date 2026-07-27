import { $, $$, esc, copyText, wireDropZone } from "../core/util.js";
import { myId, state, save } from "../core/store.js";
import { icon } from "../ui/icons.js";
import { confirmModal, promptModal, toast, withLoading, removeWithMotion } from "../ui/components.js?v=20260727-v118-7";
import { designTtsVoice, refreshProviderStatus, synthesizeTts } from "../api/providers.js";
import { addAssetFromDataUrl, addAssetFromFile, inferAssetFileMime, removeAsset, urlFor } from "../domain/assets.js";
import { canManageCustomVoice, deleteCustomVoice, favoriteVoiceIds, findVoiceOption, isFavoriteVoice, rememberCustomVoice, renameCustomVoice, setFavoriteVoice, toggleFavoriteVoice, voiceListByTab, voiceMeta } from "../domain/voices.js";

let runtimeAudio = null;
let runtimeAudioState = "idle";
let runtimeAudioError = "";
let runtimeDesignAudio = null;
let previewingVoiceId = "";
const voicePreviewCache = new Map();
let providerStatusLoaded = false;
let providerRefreshPromise = null;
const providerRefreshCallbacks = new Set();
let runtimeMemberId = "";
const VOICE_PREVIEW_TEXT = "这是当前音色试听，语气自然，适合口播内容。";

function ensureRuntimeMemberScope() {
  const memberId = myId() || "anonymous";
  if (!runtimeMemberId) {
    runtimeMemberId = memberId;
    return;
  }
  if (runtimeMemberId === memberId) return;
  runtimeMemberId = memberId;
  runtimeAudio = null;
  runtimeAudioState = "idle";
  runtimeAudioError = "";
  runtimeDesignAudio = null;
  previewingVoiceId = "";
  voicePreviewCache.clear();
}

function labState() {
  const ui = voiceMeta();
  const previous = ui.voiceLab || {};
  const migratedSpeed = previous._speedDefaultV2
    ? previous.speed
    : (previous.speed == null || Number(previous.speed) === 1 ? 1.2 : previous.speed);
  ui.voiceLab = {
    tab: "system",
    mode: "tts",
    text: "",
    voiceId: "",
    speed: 1.2,
    vol: 1,
    pitch: 0,
    designName: "",
    designPrompt: "自然中文女声，清晰、温和、有一点真实内容博主的松弛感，适合讲 AI 办公教程，不要播音腔。",
    designPreview: "大家可以先把需求说清楚，再让工具帮你一步一步跑起来。",
    voiceGender: "all",
    voiceLocale: "all",
    ...previous,
    speed: migratedSpeed ?? 1.2,
    _speedDefaultV2: true
  };
  return ui.voiceLab;
}

function modeTabs(mode) {
  const idx = Math.max(0, [["tts"], ["design"], ["library"]].findIndex(([key]) => key === mode));
  return [["tts", "语音合成"], ["design", "音色设计"], ["library", "音色管理"]].map(([key, label]) =>
    `<button class="${mode === key ? "is-active" : ""}" type="button" data-vl-mode="${key}">${label}</button>`
  ).join("") + `<i class="vl-mode-liquid" style="--i:${idx}"></i>`;
}

function wireVoiceDock(dock, rerender) {
  if (!dock) return;
  $$("[data-vl-mode]", dock).forEach(b => b.addEventListener("click", () => {
    const next = b.dataset.vlMode || "tts";
    if (next === labState().mode) return;
    saveLabPatch({ mode: next });
    rerender?.(next, dock);
  }));
}

function voiceAudioAssets(kind = "all") {
  const ownerId = myId();
  return (state.assets || [])
    .filter(a => {
      if (a.type !== "音频") return false;
      if (a.ownerId && ownerId && a.ownerId !== ownerId) return false;
      const tags = a.tags || [];
      if (kind === "reference") return tags.some(t => /参考音频库|声线参考/i.test(t));
      if (kind === "voice") return tags.some(t => /语音素材库|口播|tts/i.test(t)) && !tags.some(t => /参考音频库/i.test(t));
      return tags.some(t => /语音素材库|参考音频库|口播|tts/i.test(t));
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function saveAudioAsset(audio, tags = []) {
  if (!audio?.url) return null;
  const saved = await addAssetFromDataUrl(state.ui.activeAccountId || null, {
    name: audio.name || "语音素材",
    type: "音频",
    tags: [...new Set(["口播", ...tags])],
    dataUrl: audio.url
  });
  audio.assetId = saved.id;
  return saved;
}

function voiceAudioLibraryHtml() {
  const listHtml = list => list.map(a => {
    const url = urlFor(a);
    return `<div class="vl-audio-item" data-vl-audio-asset="${esc(a.id)}">
      <div>${icon("music", 14)}<b>${esc(a.name)}</b><em>${esc((a.tags || []).filter(t => t !== "语音素材库").slice(0, 2).join(" · "))}</em></div>
      ${url ? `<audio src="${esc(url)}" controls preload="metadata"></audio>` : `<span class="muted">音频文件暂不可用</span>`}
      <button class="icon-btn tiny" type="button" title="删除语音素材" data-vl-delete-audio="${esc(a.id)}">${icon("trash", 13)}</button>
    </div>`;
  }).join("");
  const voice = voiceAudioAssets("voice");
  const reference = voiceAudioAssets("reference");
  return `<div class="vl-audio-library">
    <section><div class="vl-audio-library-head"><b>语音素材库</b><em>${voice.length}</em></div>${voice.length ? listHtml(voice) : `<p class="muted">生成音频时可选择加入。</p>`}</section>
    <section><div class="vl-audio-library-head"><b>我的参考音频库</b><em>${reference.length}</em></div>
      <label class="vl-reference-drop" id="vlReferenceDrop">${icon("upload", 13)} 拖入自己的参考音频<input type="file" accept="audio/*" hidden id="vlReferenceUpload" /></label>
      ${reference.length ? listHtml(reference) : `<p class="muted">这里只显示当前登录成员上传和生成的参考音频。</p>`}
    </section>
  </div>`;
}

function toolPanelHtml(mode, s, selected) {
  if (mode === "design") {
    return `<aside class="vl-side-panel vl-designer glass-panel">
      <div class="vl-section-head compact">
        <div><b>${icon("wand", 16)} 音色设计</b><em>描述性别、年龄感、情绪和场景，生成可复用 voice_id</em></div>
        <button class="btn primary" id="vlDesign">${icon("spark", 14)} 设计音色</button>
      </div>
      <div class="vl-design-form">
        <label class="vl-field">音色名称<input class="input" id="vlDesignName" value="${esc(s.designName || "")}" placeholder="例如：冷静教程女声" /></label>
        <label class="vl-field grow">音色描述<textarea class="input" id="vlDesignPrompt" rows="5" placeholder="描述想要的声音">${esc(s.designPrompt || "")}</textarea></label>
        <label class="vl-field">试听文本<textarea class="input" id="vlDesignPreview" rows="3" placeholder="用于试听的短口播">${esc(s.designPreview || "")}</textarea></label>
      </div>
      <div id="vlDesignResult">${runtimeDesignAudio?.url ? `${audioPlayerHtml(runtimeDesignAudio, "design")}<div class="vl-design-confirm"><button class="btn ghost sm" id="vlDiscardDesign">放弃</button><button class="btn primary sm" id="vlConfirmDesign">${icon("check", 13)} 保存到我的音色</button></div>` : ""}</div>
    </aside>`;
  }
  if (mode === "library") {
    return `<aside class="vl-side-panel vl-console glass-panel">
      <div class="vl-section-head compact">
        <div><b>${icon("archive", 16)} 音色管理</b><em>当前音色会同步到数字人口播和账号固定声线选择里</em></div>
      </div>
      <div class="vl-current-voice is-large">
        <b>${esc(selected.name || "默认/手动声线")}</b>
        <i>${esc(sourceLabel(selected.source))}</i>
        <div>
          <button class="btn ghost sm" id="vlFavCurrent">${icon("star", 13)} ${selected.voiceId && isFavoriteVoice(selected.voiceId) ? "已收藏" : "收藏"}</button>
          <button class="btn ghost sm" id="vlCopyCurrent">${icon("copy", 13)} 复制 ID</button>
        </div>
      </div>
      ${voiceAudioLibraryHtml()}
    </aside>`;
  }
  return `<aside class="vl-side-panel vl-console glass-panel">
    <div class="vl-section-head compact">
      <div><b>${icon("mic", 16)} 调试台</b><em>当前：${esc(selected.name || "默认/手动声线")}</em></div>
      <button class="btn primary sm" id="vlGenerate">${icon("spark", 14)} 生成音频</button>
    </div>
    ${runtimeAudioSlotHtml()}
    <div class="vl-current-voice">
      <b>${esc(selected.name || "默认/手动声线")}</b>
      <i>${esc(sourceLabel(selected.source))}</i>
      <div>
        <button class="btn ghost sm" id="vlFavCurrent">${icon("star", 13)} ${selected.voiceId && isFavoriteVoice(selected.voiceId) ? "已收藏" : "收藏"}</button>
        <button class="btn ghost sm" id="vlCopyCurrent">${icon("copy", 13)} 复制 ID</button>
      </div>
    </div>
    <div class="vl-sliders vl-voice-parameters">
      <label>语速 <span>${Number(s.speed ?? 1.2).toFixed(1)}</span><input id="vlSpeed" type="range" min="0.5" max="2" step="0.1" value="${esc(s.speed ?? 1.2)}" /></label>
      <label>音量 <span>${Number(s.vol || 1).toFixed(1)}</span><input id="vlVol" type="range" min="0.5" max="2" step="0.1" value="${esc(s.vol || 1)}" /></label>
      <label>声调 <span>${Number(s.pitch || 0)}</span><input id="vlPitch" type="range" min="-12" max="12" step="1" value="${esc(s.pitch || 0)}" /></label>
    </div>
  </aside>`;
}

function sourceLabel(source = "") {
  if (source === "mine") return "我的音色";
  if (source === "shared") return "平台定制音色";
  if (source === "favorite") return "收藏音色";
  if (source === "system") return "系统音色";
  if (source === "default") return "平台默认";
  return source || "自定义";
}

function voiceCard(v, selectedId) {
  const fav = isFavoriteVoice(v.voiceId);
  const active = v.voiceId === selectedId;
  const previewing = previewingVoiceId === v.voiceId;
  return `<div class="vl-voice-card ${v.source === "mine" ? "is-mine" : ""} ${active ? "is-active" : ""} ${fav ? "is-fav" : ""} ${previewing ? "is-previewing" : ""}" role="button" tabindex="0" data-vl-voice="${esc(v.voiceId)}" title="点击选择并试听">
    <span class="vl-voice-core">${icon(active ? "check" : "mic", 15)}<b>${esc(v.name || "未命名音色")}</b>${v.source === "system" ? "" : `<i class="vl-voice-source">${esc(sourceLabel(v.source))}</i>`}</span>
    <span class="vl-voice-actions" role="group" aria-label="${esc(v.name || "当前音色")}操作">
      <button class="icon-btn tiny" type="button" title="试听音色" data-vl-preview="${esc(v.voiceId)}">${icon(previewing ? "pause" : "play", 13)}</button>
      <button class="icon-btn tiny ${fav ? "is-active" : ""}" type="button" title="${fav ? "取消收藏" : "收藏音色"}" data-vl-fav="${esc(v.voiceId)}">${icon("star", 13)}</button>
      ${canManageCustomVoice(v) ? `<button class="icon-btn tiny" type="button" title="修改音色名称" data-vl-rename="${esc(v.voiceId)}">${icon("edit", 13)}</button><button class="icon-btn tiny danger" type="button" title="删除定制音色" data-vl-delete-voice="${esc(v.voiceId)}">${icon("trash", 13)}</button>` : ""}
      <button class="icon-btn tiny" type="button" title="复制 voice_id" data-vl-copy="${esc(v.voiceId)}">${icon("copy", 13)}</button>
    </span>
  </div>`;
}

function classifyVoice(v) {
  const text = `${v.name || ""} ${v.voiceId || ""} ${v.description || ""}`.toLowerCase();
  const gender = /女声|少女|女生|女性|female|girl|woman/.test(text) ? "female" : /男声|男生|男性|male|boy|man|大叔|总裁/.test(text) ? "male" : "neutral";
  const locale = /粤语|canton/.test(text) ? "cantonese" : /英语|英文|english|\ben[-_]/.test(text) ? "english" : /日语|japan|\bja[-_]/.test(text) ? "japanese" : /韩语|korean|\bko[-_]/.test(text) ? "korean" : "mandarin";
  return { gender, locale };
}

function voiceListHtml(tab, selectedId, filters = {}) {
  const list = voiceListByTab(tab).filter(v => {
    const meta = classifyVoice(v);
    return (!filters.voiceGender || filters.voiceGender === "all" || meta.gender === filters.voiceGender)
      && (!filters.voiceLocale || filters.voiceLocale === "all" || meta.locale === filters.voiceLocale);
  });
  if (!list.length) {
    return `<div class="vl-empty">${tab === "mine" ? "还没有设计音色。右侧输入描述后生成，就会出现在这里。" : tab === "favorite" ? "还没有收藏音色。常用声线点星标后会集中在这里。" : "系统音色还在加载，稍后刷新或检查 TTS 配置。"}</div>`;
  }
  return list.map(v => voiceCard(v, selectedId)).join("");
}

function audioPlayerHtml(audio, key = "main") {
  if (!audio?.url) return "";
  return `<div class="vl-player">
    <div>${icon("music", 16)}<b>${esc(audio.name || "生成音频")}</b><em>${esc(audio.voiceName || "当前音色")}</em></div>
    <audio src="${esc(audio.url)}" controls preload="metadata"></audio>
    <div class="vl-player-actions">
      ${key === "main"
        ? `<button class="btn ghost sm ${audio.savedVoiceAssetId ? "is-active" : ""}" type="button" data-vl-archive-audio="voice" ${audio.savedVoiceAssetId ? "disabled" : ""}>${icon("archive", 13)} ${audio.savedVoiceAssetId ? "已加入语音素材库" : "加入语音素材库"}</button><button class="btn ghost sm ${audio.savedReferenceAssetId ? "is-active" : ""}" type="button" data-vl-archive-audio="reference" ${audio.savedReferenceAssetId ? "disabled" : ""}>${icon("pulse", 13)} ${audio.savedReferenceAssetId ? "已加入参考音频库" : "加入参考音频库"}</button>`
        : `<a class="btn ghost sm" href="${esc(audio.url)}" download="${esc((audio.name || "voice-lab") + ".mp3")}">${icon("download", 13)} 下载</a>`}
    </div>
  </div>`;
}

function runtimeAudioSlotHtml() {
  let body = `<div class="vl-output-empty">${icon("music", 20)}<b>等待生成音频</b><em>选择音色并生成后，可在这里直接试听和归档</em></div>`;
  if (runtimeAudioState === "loading") {
    body = `<div class="vl-output-loading"><span class="vl-output-spinner" aria-hidden="true"></span><b>正在生成音频</b><em>请稍候，完成后会自动出现播放器</em></div>`;
  } else if (runtimeAudioState === "error") {
    body = `<div class="vl-output-empty is-error">${icon("alert", 20)}<b>生成未完成</b><em>${esc(runtimeAudioError || "请检查接口后重试")}</em></div>`;
  } else if (runtimeAudio?.url) {
    body = audioPlayerHtml(runtimeAudio, "main");
  }
  const isReady = Boolean(runtimeAudio?.url) && runtimeAudioState !== "loading" && runtimeAudioState !== "error";
  const status = runtimeAudioState === "loading" ? "生成中" : isReady ? "已生成" : "待生成";
  const quickActions = isReady
    ? `<div class="vl-output-quick-actions"><a href="${esc(runtimeAudio.url)}" download="${esc((runtimeAudio.name || "voice-lab") + ".mp3")}" title="下载音频">${icon("download", 12)}<span>下载</span></a><button type="button" title="丢弃本次音频" data-vl-discard-audio>${icon("trash", 12)}<span>删除</span></button></div>`
    : "";
  return `<section class="vl-output-slot" id="vlRuntimeSlot" data-state="${esc(runtimeAudioState)}"><div class="vl-output-title"><b>音频预览</b><div class="vl-output-status"><span>${status}</span>${quickActions}</div></div>${body}</section>`;
}

function saveLabPatch(patch) {
  Object.assign(labState(), patch);
  save("meta");
}

async function previewVoice(voiceId, s) {
  const id = String(voiceId || "").trim();
  if (!id) {
    toast("默认声线无需单独试听");
    return;
  }
  const voice = findVoiceOption(id);
  const sample = String(s.designPreview || VOICE_PREVIEW_TEXT).trim().slice(0, 80) || VOICE_PREVIEW_TEXT;
  const cacheKey = `${id}::${sample}`;
  const storedAssetId = voiceMeta().voicePreviewAssetIds?.[id];
  const storedUrl = storedAssetId ? urlFor(storedAssetId) : "";
  let out = voice.previewAudioDataUrl
    ? { audioDataUrl: voice.previewAudioDataUrl, voiceId: id }
    : storedUrl
      ? { audioDataUrl: storedUrl, voiceId: id, assetId: storedAssetId }
      : voicePreviewCache.get(cacheKey);
  if (!out) {
    out = await synthesizeTts({ text: sample, voiceId: id, speed: Number(s.speed ?? 1.2), vol: Number(s.vol || 1), pitch: Number(s.pitch || 0) });
    voicePreviewCache.set(cacheKey, out);
  }
  runtimeAudio = {
    url: out.audioDataUrl,
    voiceId: out.voiceId || id,
    voiceName: voice.name || out.voiceId || id,
    name: `${voice.name || "音色"}_试听`,
    assetId: out.assetId || ""
  };
  if (!runtimeAudio.assetId) {
    const saved = await saveAudioAsset(runtimeAudio, ["语音素材库", "音色试听", id]);
    const ui = voiceMeta();
    ui.voicePreviewAssetIds = ui.voicePreviewAssetIds || {};
    ui.voicePreviewAssetIds[id] = saved.id;
    save("meta");
  }
}

function ensureProviderStatus(renderAgain) {
  if (providerStatusLoaded) return;
  if (typeof renderAgain === "function") providerRefreshCallbacks.add(renderAgain);
  if (providerRefreshPromise) return;
  providerRefreshPromise = refreshProviderStatus()
    .catch(() => null)
    .finally(() => {
      providerStatusLoaded = true;
      providerRefreshPromise = null;
      const callbacks = [...providerRefreshCallbacks];
      providerRefreshCallbacks.clear();
      callbacks.forEach(callback => callback());
    });
}

export const voiceLabView = {
  render(root, { embedded = false } = {}) {
    ensureRuntimeMemberScope();
    const activeMemberId = myId() || "anonymous";
    const workspaceLibraryHost = embedded && document.body.classList.contains("workspace-shell-v2")
      ? document.getElementById("workspaceContextToolHost")
      : null;
    if (
      workspaceLibraryHost
      && workspaceLibraryHost.dataset.voiceMemberId
      && workspaceLibraryHost.dataset.voiceMemberId !== activeMemberId
    ) {
      workspaceLibraryHost.replaceChildren();
    }
    const libraryNode = () => (
      workspaceLibraryHost?.querySelector(".vl-library")
      || $(".vl-library", root)
    );
    const voiceQuery = selector => $(selector, root) || libraryNode()?.querySelector(selector) || null;
    const voiceQueryAll = selector => [
      ...new Set([
        ...$$(selector, root),
        ...(libraryNode()?.querySelectorAll(selector) || [])
      ])
    ];
    const stableRerender = (nextMode = "", dock = null) => {
      if (root.dataset.vlSwitching === "true") return Promise.resolve(false);
      return new Promise(resolve => {
        const scroll = embedded
          ? root.closest(".custom-creation-stage")
          : document.querySelector(".main-scroll");
        const scrollTop = scroll?.scrollTop || 0;
        const oldHeight = root.getBoundingClientRect().height;
        // Keep the editor and the real left-rail library as stable DOM nodes.
        // The right-side mode panel may change without resetting an IME,
        // scroll position, filters, or selected voice.
        const stableEditor = $(".vl-editor", root);
        const stableLibrary = nextMode ? libraryNode() : null;
        root.style.minHeight = `${oldHeight}px`;
        root.classList.add("vl-view-switching");

        const renderNext = () => {
          this.render(root, { embedded });
          const nextEditor = $(".vl-editor", root);
          if (stableEditor && nextEditor) nextEditor.replaceWith(stableEditor);
          const nextLibrary = libraryNode();
          if (stableLibrary && nextLibrary && stableLibrary !== nextLibrary) {
            nextLibrary.replaceWith(stableLibrary);
          }
          const nextHeight = root.getBoundingClientRect().height;
          root.style.minHeight = `${Math.max(oldHeight, nextHeight)}px`;
          if (scroll) scroll.scrollTop = scrollTop;
          requestAnimationFrame(() => {
            if (scroll) scroll.scrollTop = scrollTop;
            $$(".vl-side-panel", root).forEach(panel => panel.classList.add("is-panel-switching-in"));
          });
          window.setTimeout(() => {
            if (scroll) scroll.scrollTop = scrollTop;
            root.style.minHeight = "";
            root.classList.remove("vl-view-switching");
            delete root.dataset.vlSwitching;
            dock?.classList.remove("is-switching");
            $$(".vl-side-panel", root).forEach(panel => panel.classList.remove("is-panel-switching-in"));
          }, nextMode ? 340 : 40);
          resolve(true);
        };

        if (!nextMode) {
          renderNext();
          return;
        }

        root.dataset.vlSwitching = "true";
        dock?.classList.add("is-switching");
        $$('[data-vl-mode]', dock).forEach(button => button.classList.toggle("is-active", button.dataset.vlMode === nextMode));
        const liquid = $(".vl-mode-liquid", dock);
        if (liquid) liquid.style.setProperty("--i", String(Math.max(0, ["tts", "design", "library"].indexOf(nextMode))));
        $$(".vl-side-panel", root).forEach(panel => panel.classList.add("is-panel-switching-out"));
        window.setTimeout(renderNext, 150);
      });
    };
    const s = labState();
    const selected = findVoiceOption(s.voiceId || "");
    const favCount = favoriteVoiceIds().size;
    const currentList = voiceListHtml(s.tab || "system", selected.voiceId, s);
    const mode = s.mode || "tts";
    document.getElementById("voiceTopDock")?.remove();
    document.querySelector(".topbar")?.classList.remove("voice-topbar-active");
    root.innerHTML = `<div class="voice-lab-page ${embedded ? "is-embedded" : ""}">
      <section class="vl-workbench" data-vl-view="${esc(mode)}">
        <div class="vl-library glass-panel">
          <div class="vl-section-head">
            <div><b>${icon("archive", 16)} 音色库</b><em>定制音色 ${voiceListByTab("mine").length} · 收藏 <span data-vl-favorite-count>${favCount}</span> · 系统 ${voiceListByTab("system").length}</em></div>
          </div>
          <div class="vl-tabs">
            ${[["mine", "定制音色"], ["favorite", "收藏音色"], ["system", "系统音色"]].map(([key, label]) => `<button class="${(s.tab || "system") === key ? "is-active" : ""}" data-vl-tab="${key}">${label}</button>`).join("")}
          </div>
          <div class="vl-voice-filters">
            <label class="select-shell">${icon("users", 13)}<select id="vlVoiceGender"><option value="all">全部声线</option><option value="female" ${s.voiceGender === "female" ? "selected" : ""}>女声</option><option value="male" ${s.voiceGender === "male" ? "selected" : ""}>男声</option><option value="neutral" ${s.voiceGender === "neutral" ? "selected" : ""}>特色声线</option></select>${icon("chevronDown", 12)}</label>
            <label class="select-shell">${icon("globe", 13)}<select id="vlVoiceLocale"><option value="all">全部语言</option><option value="mandarin" ${s.voiceLocale === "mandarin" ? "selected" : ""}>普通话</option><option value="cantonese" ${s.voiceLocale === "cantonese" ? "selected" : ""}>粤语</option><option value="english" ${s.voiceLocale === "english" ? "selected" : ""}>英语</option><option value="japanese" ${s.voiceLocale === "japanese" ? "selected" : ""}>日语</option><option value="korean" ${s.voiceLocale === "korean" ? "selected" : ""}>韩语</option></select>${icon("chevronDown", 12)}</label>
          </div>
          <div class="vl-voice-list">${currentList}</div>
        </div>

        <div class="vl-editor glass-panel">
          <div class="vl-section-head">
            <div><b>${icon("type", 16)} 文本转语音</b></div>
            <div class="vl-editor-head-actions">
              <span class="vl-mode-switch-label">切换模式</span><nav class="vl-mode-tabs vl-editor-mode-tabs" aria-label="语音生成模式">${modeTabs(mode)}</nav>
            </div>
          </div>
          <div class="vl-textbox-wrap ${s.text ? "has-value" : ""}">
            <textarea class="vl-textarea" id="vlText" maxlength="5000" placeholder=" ">${esc(s.text || "")}</textarea>
            <div class="vl-typewriter"><span>输入要生成的口播文本</span></div>
          </div>
      <div class="vl-editor-foot"><span id="vlTextCount">${(s.text || "").length} / 5000 字</span><em>生成后再决定是否加入素材库</em></div>
        </div>

        ${toolPanelHtml(mode, s, selected)}
      </section>
    </div>`;
    wireVoiceDock($(".vl-editor-mode-tabs", root), stableRerender);

    const textEl = $("#vlText", root);
    const syncText = () => {
      const value = textEl?.value || "";
      labState().text = value;
      $(".vl-textbox-wrap", root)?.classList.toggle("has-value", Boolean(value));
      const count = $("#vlTextCount", root);
      if (count) count.textContent = `${value.length} / 5000 字`;
      save("meta");
    };
    textEl?.addEventListener("input", syncText);
    textEl?.addEventListener("paste", () => requestAnimationFrame(syncText));
    textEl?.addEventListener("change", syncText);
    textEl?.addEventListener("blur", syncText);
    const syncFavoriteUi = (voiceId, favorite) => {
      voiceQueryAll(`[data-vl-fav="${CSS.escape(voiceId)}"]`).forEach(button => {
        button.title = favorite ? "取消收藏" : "收藏音色";
        button.classList.toggle("is-active", favorite);
        button.closest(".vl-voice-card")?.classList.toggle("is-fav", favorite);
      });
      if (selected.voiceId === voiceId) {
        const current = $("#vlFavCurrent", root);
        if (current) current.innerHTML = `${icon("star", 13)} ${favorite ? "已收藏" : "收藏"}`;
      }
      const counter = voiceQuery("[data-vl-favorite-count]");
      if (counter) counter.textContent = String(favoriteVoiceIds().size);
      if ((labState().tab || "system") === "favorite" && !favorite) {
        const card = voiceQuery(`[data-vl-voice="${CSS.escape(voiceId)}"]`);
        if (card) {
          const height = card.offsetHeight;
          card.animate(
            [{ height: `${height}px`, opacity: 1 }, { height: "0px", opacity: 0, marginBlock: "0px", paddingBlock: "0px" }],
            { duration: 180, easing: "cubic-bezier(.4,0,.2,1)" }
          ).onfinish = () => card.remove();
        }
      }
    };
    const syncSelectedVoiceUi = (voiceId, previewing = false) => {
      const voice = findVoiceOption(voiceId || "");
      voiceQueryAll('[data-vl-voice]').forEach(card => {
        const active = card.dataset.vlVoice === voiceId;
        card.classList.toggle("is-active", active);
        card.classList.toggle("is-previewing", active && previewing);
        const core = card.querySelector(".vl-voice-core");
        const glyph = core?.querySelector("svg");
        if (glyph) glyph.outerHTML = icon(active ? "check" : "mic", 15);
      });
      const current = $(".vl-current-voice", root);
      const name = voice.name || "默认/手动声线";
      const currentName = current?.querySelector(":scope > b");
      const currentSource = current?.querySelector(":scope > i");
      if (currentName) currentName.textContent = name;
      if (currentSource) currentSource.textContent = sourceLabel(voice.source);
      const consoleState = $(".vl-console .vl-section-head em", root);
      if (consoleState) consoleState.textContent = `当前：${name}`;
      const favorite = voice.voiceId ? isFavoriteVoice(voice.voiceId) : false;
      const currentFav = $("#vlFavCurrent", root);
      if (currentFav) currentFav.innerHTML = `${icon("star", 13)} ${favorite ? "已收藏" : "收藏"}`;
    };
    const mountRuntimePlayer = () => {
      const current = $("#vlRuntimeSlot", root);
      if (!current) return;
      current.outerHTML = runtimeAudioSlotHtml();
      const slot = $("#vlRuntimeSlot", root);
      $$('[data-vl-archive-audio]', slot).forEach(button => button.addEventListener("click", e => withLoading(e.currentTarget, async () => {
        if (!runtimeAudio?.url) return;
        const kind = e.currentTarget.dataset.vlArchiveAudio;
        if (kind === "reference") {
          const saved = await saveAudioAsset(runtimeAudio, ["参考音频库", "声线参考"]);
          runtimeAudio.savedReferenceAssetId = saved?.id || "";
          toast("已加入我的参考音频库");
        } else {
          const saved = await saveAudioAsset(runtimeAudio, ["语音素材库"]);
          runtimeAudio.savedVoiceAssetId = saved?.id || "";
          toast("已加入语音素材库");
        }
        mountRuntimePlayer();
      }, "保存中…")));
      $('[data-vl-discard-audio]', slot)?.addEventListener("click", () => {
        runtimeAudio = null;
        runtimeAudioState = "idle";
        runtimeAudioError = "";
        mountRuntimePlayer();
        toast("已丢弃本次临时音频");
      });
    };
    ["Speed", "Vol", "Pitch"].forEach(key => {
      const el = $(`#vl${key}`, root);
      if (!el) return;
      el.addEventListener("input", e => {
        const map = { Speed: "speed", Vol: "vol", Pitch: "pitch" };
        const value = Number(e.currentTarget.value);
        saveLabPatch({ [map[key]]: value, ...(key === "Speed" ? { _speedDefaultV2: true } : {}) });
        const output = e.currentTarget.closest("label")?.querySelector(":scope > span");
        if (output) output.textContent = key === "Pitch" ? String(value) : value.toFixed(1);
      });
    });

    const refreshVoiceList = () => {
      const list = voiceQuery(".vl-voice-list");
      if (!list) return;
      list.innerHTML = voiceListHtml(labState().tab || "system", labState().voiceId || "", labState());
      list.animate?.([{ opacity: .45, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 150, easing: "cubic-bezier(.2,.8,.2,1)" });
    };
    $$("[data-vl-tab]", root).forEach(b => b.addEventListener("click", () => {
      const next = b.dataset.vlTab || "system";
      if (next === labState().tab) return;
      saveLabPatch({ tab: next });
      voiceQueryAll("[data-vl-tab]").forEach(button => button.classList.toggle("is-active", button.dataset.vlTab === next));
      refreshVoiceList();
    }));
    [["vlVoiceGender", "voiceGender"], ["vlVoiceLocale", "voiceLocale"]].forEach(([id, key]) => {
      $("#" + id, root)?.addEventListener("change", e => {
        saveLabPatch({ [key]: e.currentTarget.value });
        refreshVoiceList();
      });
    });
    const selectAndPreview = async (voiceId) => {
      const id = String(voiceId || "").trim();
      const previousMode = labState().mode || "tts";
      saveLabPatch({ voiceId: id, mode: "tts" });
      if (previousMode !== "tts") {
        await stableRerender("tts", $(".vl-editor-mode-tabs", root));
      }
      if (!id) {
        toast("已切换默认声线");
        syncSelectedVoiceUi("");
        return;
      }
      previewingVoiceId = id;
      runtimeAudioState = "loading";
      runtimeAudioError = "";
      mountRuntimePlayer();
      syncSelectedVoiceUi(id, true);
      try {
        await previewVoice(id, labState());
        runtimeAudioState = "ready";
        toast("已生成试听");
      } catch (err) {
        runtimeAudioState = "error";
        runtimeAudioError = err?.message || String(err || "生成失败");
        toast(`试听失败：${err?.message || err}`);
      } finally {
        previewingVoiceId = "";
        syncSelectedVoiceUi(id, false);
        mountRuntimePlayer();
      }
    };
    $(".vl-voice-list", root)?.addEventListener("click", async e => {
      const action = e.target.closest("button");
      if (action?.dataset.vlPreview) { e.stopPropagation(); selectAndPreview(action.dataset.vlPreview); return; }
      if (action?.dataset.vlFav) {
        e.stopPropagation();
        const id = action.dataset.vlFav;
        const next = toggleFavoriteVoice(id);
        toast(next ? "已收藏音色" : "已取消收藏");
        syncFavoriteUi(id, next);
        return;
      }
      if (action?.dataset.vlCopy) { e.stopPropagation(); copyText(action.dataset.vlCopy); toast("已复制 voice_id"); return; }
      if (action?.dataset.vlRename) {
        e.stopPropagation();
        const voice = findVoiceOption(action.dataset.vlRename);
        const name = await promptModal({ title: "修改我的音色名称", placeholder: "输入声线名称", value: voice.name || "", okText: "保存" });
        if (name == null) return;
        try {
          const saved = await renameCustomVoice(voice.voiceId, name);
          if (!saved) { toast("名称不能为空，或该音色不属于当前账号", "error"); return; }
          const card = action.closest("[data-vl-voice]");
          const title = card?.querySelector(".vl-voice-core b");
          if (title) title.textContent = saved.name;
          toast(`已改名为：${saved.name}`);
        } catch (err) {
          toast(`音色改名失败：${err?.message || err}`, "error");
        }
        return;
      }
      if (action?.dataset.vlDeleteVoice) {
        e.stopPropagation();
        const voice = findVoiceOption(action.dataset.vlDeleteVoice);
        const ok = await confirmModal({ title: "删除我的音色？", body: `<p>将删除“${esc(voice.name)}”，使用该音色的账号会恢复为默认声线。</p>`, okText: "删除", danger: true });
        if (!ok) return;
        const card = action.closest("[data-vl-voice]");
        try {
          await removeWithMotion(card, async () => {
            const deleted = await deleteCustomVoice(voice.voiceId);
            if (!deleted) throw new Error("该音色不属于当前账号或已被删除");
            return true;
          });
          const counter = voiceQuery("[data-vl-favorite-count]");
          if (counter) counter.textContent = String(favoriteVoiceIds().size);
          toast("已删除我的音色");
        } catch (err) {
          toast(`音色删除失败：${err?.message || err}`, "error");
        }
        return;
      }
      const card = e.target.closest("[data-vl-voice]");
      if (card) selectAndPreview(card.dataset.vlVoice || "");
    });
    $(".vl-voice-list", root)?.addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest("button")) return;
      const card = e.target.closest("[data-vl-voice]");
      if (!card) return;
      e.preventDefault();
      selectAndPreview(card.dataset.vlVoice || "");
    });
    $("#vlFavCurrent", root)?.addEventListener("click", () => {
      const currentId = labState().voiceId || "";
      if (!currentId) { toast("默认声线无需收藏"); return; }
      const next = toggleFavoriteVoice(currentId);
      toast(next ? "已收藏当前音色" : "已取消收藏当前音色");
      syncFavoriteUi(currentId, next);
    });
    $("#vlCopyCurrent", root)?.addEventListener("click", () => {
      const currentId = labState().voiceId || "";
      if (!currentId) { toast("当前为默认声线"); return; }
      copyText(currentId);
      toast("已复制 voice_id");
    });
    $$("[data-vl-copy-audio]", root).forEach(b => b.addEventListener("click", () => {
      const audio = b.dataset.vlCopyAudio === "design" ? runtimeDesignAudio : runtimeAudio;
      if (!audio?.voiceId) return;
      copyText(audio.voiceId);
      toast("已复制 voice_id");
    }));
    const wireAudioLibrary = () => {
      $$("[data-vl-delete-audio]", root).forEach(b => b.addEventListener("click", async () => {
        const row = b.closest("[data-vl-audio-asset]");
        const id = b.dataset.vlDeleteAudio || "";
        if (!id) return;
        await removeWithMotion(row, async () => removeAsset(id));
        toast("已删除语音素材");
      }));
      const addReferenceFile = async file => {
        if (!file || !inferAssetFileMime(file).startsWith("audio/")) { toast("请拖入音频文件", "error"); return; }
        await addAssetFromFile(null, file, { tags: ["参考音频库", "声线参考"], name: file.name.replace(/\.[^.]+$/, "") });
        const current = $(".vl-audio-library", root);
        if (current) {
          current.outerHTML = voiceAudioLibraryHtml();
          wireAudioLibrary();
        }
        toast("已加入总参考音频库");
      };
      $("#vlReferenceUpload", root)?.addEventListener("change", e => addReferenceFile(e.currentTarget.files[0]));
      const drop = $("#vlReferenceDrop", root);
      if (drop) wireDropZone(drop, files => addReferenceFile(Array.from(files).find(file => inferAssetFileMime(file).startsWith("audio/"))), { filesOnly: true });
    };
    wireAudioLibrary();
    const wireDesignCandidate = () => {
      $("[data-vl-copy-audio=\"design\"]", root)?.addEventListener("click", () => {
        if (!runtimeDesignAudio?.voiceId) return;
        copyText(runtimeDesignAudio.voiceId);
        toast("已复制 voice_id");
      }, { once: true });
      $("#vlDiscardDesign", root)?.addEventListener("click", () => {
        runtimeDesignAudio = null;
        const result = $("#vlDesignResult", root);
        if (result) result.innerHTML = "";
        toast("已放弃本次音色候选");
      });
      $("#vlConfirmDesign", root)?.addEventListener("click", async event => {
        if (!runtimeDesignAudio?.voiceId) return;
        const button = event.currentTarget;
        if (button.disabled) return;
        button.disabled = true;
        try {
          const saved = await rememberCustomVoice({
            voiceId: runtimeDesignAudio.voiceId,
            name: runtimeDesignAudio.pendingName || runtimeDesignAudio.voiceName || "新设计音色",
            description: runtimeDesignAudio.pendingPrompt || "",
            previewAudioDataUrl: runtimeDesignAudio.url || ""
          });
          if (!saved) throw new Error("该 voice_id 已属于其他成员，不能覆盖");
          setFavoriteVoice(saved.voiceId, true);
          saveLabPatch({ voiceId: saved.voiceId, tab: "mine", mode: "design", designName: "" });
          voiceQueryAll("[data-vl-tab]").forEach(tab => tab.classList.toggle("is-active", tab.dataset.vlTab === "mine"));
          refreshVoiceList();
          const result = $("#vlDesignResult", root);
          if (result) result.innerHTML = `<div class="vl-saved-note">${icon("check", 13)} 已保存到我的音色</div>`;
          toast(`音色已保存：${saved.name}`);
        } catch (err) {
          toast(`音色保存失败：${err?.message || err}`, "error");
        } finally {
          button.disabled = false;
        }
      });
    };
    wireDesignCandidate();
    $("#vlGenerate", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      const text = ($("#vlText", root)?.value || "").trim();
      if (!text) { toast("请先输入口播文本"); return; }
      saveLabPatch({ text, mode: "tts" });
      runtimeAudioState = "loading";
      runtimeAudioError = "";
      mountRuntimePlayer();
      try {
        const out = await synthesizeTts({ text, voiceId: s.voiceId || "", speed: Number(s.speed ?? 1.2), vol: Number(s.vol || 1), pitch: Number(s.pitch || 0) });
        const voice = findVoiceOption(out.voiceId || s.voiceId || "");
        runtimeAudio = {
          url: out.audioDataUrl,
          voiceId: out.voiceId || s.voiceId || "",
          voiceName: voice.name || out.voiceId || "生成音频",
          name: `语音_${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`
        };
        runtimeAudioState = "ready";
        toast("音频已生成，可试听后决定是否加入素材库");
      } catch (err) {
        runtimeAudioState = "error";
        runtimeAudioError = err?.message || String(err || "生成失败");
        throw err;
      } finally {
        mountRuntimePlayer();
      }
    }, "生成中…"));
    $("#vlDesign", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      const name = ($("#vlDesignName", root)?.value || "").trim();
      const prompt = ($("#vlDesignPrompt", root)?.value || "").trim();
      const previewText = ($("#vlDesignPreview", root)?.value || "").trim();
      saveLabPatch({ designName: name, designPrompt: prompt, designPreview: previewText });
      const out = await designTtsVoice({ prompt, previewText, name });
      runtimeDesignAudio = {
        url: out.audioDataUrl,
        voiceId: out.voiceId,
        voiceName: name || out.name || "新设计音色",
        name: `${name || out.name || "新设计音色"}_试听`,
        pendingName: name || out.name || "新设计音色",
        pendingPrompt: prompt
      };
      const result = $("#vlDesignResult", root);
      if (result) {
        result.innerHTML = `${audioPlayerHtml(runtimeDesignAudio, "design")}<div class="vl-design-confirm"><button class="btn ghost sm" id="vlDiscardDesign">放弃</button><button class="btn primary sm" id="vlConfirmDesign">${icon("check", 13)} 保存到我的音色</button></div>`;
        wireDesignCandidate();
      }
      toast("音色候选已生成，试听后确认是否保存");
    }, "设计中…"));
    const renderedLibrary = $(".vl-library", root);
    if (workspaceLibraryHost && renderedLibrary) {
      workspaceLibraryHost.dataset.voiceMemberId = activeMemberId;
      workspaceLibraryHost.classList.add("is-voice-library");
      workspaceLibraryHost.replaceChildren(renderedLibrary);
      root.dataset.workspaceVoiceLibrary = "true";
    } else {
      delete root.dataset.workspaceVoiceLibrary;
    }
    ensureProviderStatus(refreshVoiceList);
  }
};
