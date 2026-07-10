import { $, $$, esc, copyText } from "../core/util.js";
import { state, save } from "../core/store.js";
import { icon } from "../ui/icons.js";
import { promptModal, toast, withLoading } from "../ui/components.js";
import { designTtsVoice, refreshProviderStatus, synthesizeTts, ttsProviderLabel } from "../api/providers.js";
import { favoriteVoiceIds, findVoiceOption, isFavoriteVoice, rememberCustomVoice, renameCustomVoice, setFavoriteVoice, toggleFavoriteVoice, voiceListByTab, voiceMeta } from "../domain/voices.js";

let runtimeAudio = null;
let runtimeDesignAudio = null;
let previewingVoiceId = "";
const voicePreviewCache = new Map();
let providerStatusLoaded = false;
let providerRefreshPromise = null;
const VOICE_PREVIEW_TEXT = "这是当前音色试听，语气自然，适合口播内容。";

function labState() {
  const ui = voiceMeta();
  ui.voiceLab = {
    tab: "system",
    mode: "tts",
    text: "",
    voiceId: "",
    speed: 1,
    vol: 1,
    pitch: 0,
    designName: "",
    designPrompt: "自然中文女声，清晰、温和、有一点真实内容博主的松弛感，适合讲 AI 办公教程，不要播音腔。",
    designPreview: "大家可以先把需求说清楚，再让工具帮你一步一步跑起来。",
    ...(ui.voiceLab || {})
  };
  return ui.voiceLab;
}

function modeTabs(mode) {
  const idx = Math.max(0, [["tts"], ["design"], ["library"]].findIndex(([key]) => key === mode));
  return [["tts", "语音合成"], ["design", "音色设计"], ["library", "音色管理"]].map(([key, label]) =>
    `<button class="${mode === key ? "is-active" : ""}" type="button" data-vl-mode="${key}">${label}</button>`
  ).join("") + `<i class="vl-mode-liquid" style="--i:${idx}"></i>`;
}

function mountVoiceTopbar(mode, rerender) {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  topbar.classList.add("voice-topbar-active");
  let dock = document.getElementById("voiceTopDock");
  if (!dock) {
    dock = document.createElement("div");
    dock.id = "voiceTopDock";
    dock.className = "vl-topbar topbar-voice-dock";
    const actions = document.querySelector(".top-actions");
    topbar.insertBefore(dock, actions || null);
  }
  dock.innerHTML = `
    <div class="vl-mode-tabs">${modeTabs(mode)}</div>
    <div class="vl-mini-status"><span>Minimax</span><b>${esc(ttsProviderLabel().replace(/^Minimax ·\s*/, ""))}</b><em>voice_design / t2a_v2</em></div>
  `;
  $$("[data-vl-mode]", dock).forEach(b => b.addEventListener("click", () => {
    saveLabPatch({ mode: b.dataset.vlMode || "tts" });
    rerender?.();
  }));
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
      ${audioPlayerHtml(runtimeDesignAudio, "design")}
    </aside>`;
  }
  if (mode === "library") {
    return `<aside class="vl-side-panel vl-console glass-panel">
      <div class="vl-section-head compact">
        <div><b>${icon("archive", 16)} 音色管理</b><em>当前音色会同步到数字人口播和账号固定声线选择里</em></div>
      </div>
      <div class="vl-current-voice is-large">
        <b>${esc(selected.name || "默认/手动声线")}</b>
        <em>${selected.voiceId ? esc(selected.voiceId) : "平台默认 / 手动输入"}</em>
        <i>${esc(sourceLabel(selected.source))}</i>
        <div>
          <button class="btn ghost sm" id="vlFavCurrent">${icon("star", 13)} ${selected.voiceId && isFavoriteVoice(selected.voiceId) ? "已收藏" : "收藏"}</button>
          <button class="btn ghost sm" id="vlCopyCurrent">${icon("copy", 13)} 复制 ID</button>
        </div>
      </div>
      <div class="vl-tool-note">
        <b>部署存储</b>
        <span>设计音色会写入服务器同步集合 voicePresets，并按账号隔离；运行时生成的试听音频只在当前页面保留。</span>
      </div>
    </aside>`;
  }
  return `<aside class="vl-side-panel vl-console glass-panel">
    <div class="vl-section-head compact">
      <div><b>${icon("mic", 16)} 调试台</b><em>当前：${esc(selected.name || "默认/手动声线")}</em></div>
    </div>
    <div class="vl-current-voice">
      <b>${esc(selected.name || "默认/手动声线")}</b>
      <em>${selected.voiceId ? esc(selected.voiceId) : "平台默认 / 手动输入"}</em>
      <div>
        <button class="btn ghost sm" id="vlFavCurrent">${icon("star", 13)} ${selected.voiceId && isFavoriteVoice(selected.voiceId) ? "已收藏" : "收藏"}</button>
        <button class="btn ghost sm" id="vlCopyCurrent">${icon("copy", 13)} 复制 ID</button>
      </div>
    </div>
    <div class="vl-sliders">
      <label>语速 <span>${Number(s.speed || 1).toFixed(1)}</span><input id="vlSpeed" type="range" min="0.5" max="2" step="0.1" value="${esc(s.speed || 1)}" /></label>
      <label>音量 <span>${Number(s.vol || 1).toFixed(1)}</span><input id="vlVol" type="range" min="0.5" max="2" step="0.1" value="${esc(s.vol || 1)}" /></label>
      <label>声调 <span>${Number(s.pitch || 0)}</span><input id="vlPitch" type="range" min="-12" max="12" step="1" value="${esc(s.pitch || 0)}" /></label>
    </div>
    ${audioPlayerHtml(runtimeAudio, "main") || `<div class="vl-tool-note"><b>生成结果</b><span>点击左侧生成音频后，播放器会出现在这里。</span></div>`}
  </aside>`;
}

function sourceLabel(source = "") {
  if (source === "mine") return "我的音色";
  if (source === "favorite") return "收藏音色";
  if (source === "system") return "系统音色";
  if (source === "default") return "平台默认";
  return source || "自定义";
}

function voiceCard(v, selectedId) {
  const fav = isFavoriteVoice(v.voiceId);
  const active = v.voiceId === selectedId;
  const previewing = previewingVoiceId === v.voiceId;
  return `<div class="vl-voice-card ${active ? "is-active" : ""} ${fav ? "is-fav" : ""} ${previewing ? "is-previewing" : ""}" role="button" tabindex="0" data-vl-voice="${esc(v.voiceId)}" title="点击选择并试听">
    <span class="vl-voice-core">${icon(active ? "check" : "mic", 15)}<b>${esc(v.name || v.voiceId)}</b></span>
    <em>${esc(v.voiceId)}</em>
    <i>${esc(sourceLabel(v.source))}</i>
    <span class="vl-voice-actions">
      <button class="icon-btn tiny" type="button" title="试听音色" data-vl-preview="${esc(v.voiceId)}">${icon(previewing ? "pause" : "play", 13)}</button>
      <button class="icon-btn tiny" type="button" title="${fav ? "取消收藏" : "收藏音色"}" data-vl-fav="${esc(v.voiceId)}">${icon("star", 13)}</button>
      ${v.source === "mine" ? `<button class="icon-btn tiny" type="button" title="重命名音色" data-vl-rename="${esc(v.voiceId)}">${icon("edit", 13)}</button>` : ""}
      <button class="icon-btn tiny" type="button" title="复制 voice_id" data-vl-copy="${esc(v.voiceId)}">${icon("copy", 13)}</button>
    </span>
  </div>`;
}

function voiceListHtml(tab, selectedId) {
  const list = voiceListByTab(tab);
  if (!list.length) {
    return `<div class="vl-empty">${tab === "mine" ? "还没有设计音色。右侧输入描述后生成，就会出现在这里。" : tab === "favorite" ? "还没有收藏音色。常用声线点星标后会集中在这里。" : "系统音色还在加载，稍后刷新或检查 TTS 配置。"}</div>`;
  }
  return list.map(v => voiceCard(v, selectedId)).join("");
}

function audioPlayerHtml(audio, key = "main") {
  if (!audio?.url) return "";
  return `<div class="vl-player">
    <div>${icon("music", 16)}<b>${esc(audio.name || "生成音频")}</b><em>${esc(audio.voiceName || audio.voiceId || "")}</em></div>
    <audio src="${esc(audio.url)}" controls preload="metadata"></audio>
    <div class="vl-player-actions">
      <button class="btn ghost sm" data-vl-copy-audio="${esc(key)}">${icon("copy", 13)} 复制 voice_id</button>
      <a class="btn ghost sm" href="${esc(audio.url)}" download="${esc((audio.name || "voice-lab") + ".mp3")}">${icon("download", 13)} 下载</a>
    </div>
  </div>`;
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
  let out = voice.previewAudioDataUrl ? { audioDataUrl: voice.previewAudioDataUrl, voiceId: id } : voicePreviewCache.get(cacheKey);
  if (!out) {
    out = await synthesizeTts({ text: sample, voiceId: id, speed: Number(s.speed || 1), vol: Number(s.vol || 1), pitch: Number(s.pitch || 0) });
    voicePreviewCache.set(cacheKey, out);
  }
  runtimeAudio = {
    url: out.audioDataUrl,
    voiceId: out.voiceId || id,
    voiceName: voice.name || out.voiceId || id,
    name: `${voice.name || "音色"}_试听`
  };
}

function ensureProviderStatus(renderAgain) {
  if (providerStatusLoaded || providerRefreshPromise) return;
  providerRefreshPromise = refreshProviderStatus()
    .catch(() => null)
    .finally(() => {
      providerStatusLoaded = true;
      providerRefreshPromise = null;
      renderAgain?.();
    });
}

export const voiceLabView = {
  render(root) {
    ensureProviderStatus(() => this.render(root));
    const s = labState();
    const selected = findVoiceOption(s.voiceId || "");
    const favCount = favoriteVoiceIds().size;
    const currentList = voiceListHtml(s.tab || "system", selected.voiceId);
    const mode = s.mode || "tts";
    mountVoiceTopbar(mode, () => this.render(root));
    root.innerHTML = `<div class="voice-lab-page">
      <section class="vl-workbench" data-vl-view="${esc(mode)}">
        <div class="vl-library glass-panel">
          <div class="vl-section-head">
            <div><b>${icon("archive", 16)} 音色库</b><em>我的音色 ${voiceListByTab("mine").length} · 收藏 ${favCount} · 系统 ${voiceListByTab("system").length}</em></div>
          </div>
          <div class="vl-tabs">
            ${[["mine", "我的音色"], ["favorite", "收藏音色"], ["system", "系统音色"]].map(([key, label]) => `<button class="${(s.tab || "system") === key ? "is-active" : ""}" data-vl-tab="${key}">${label}</button>`).join("")}
          </div>
          <div class="vl-voice-list">${currentList}</div>
        </div>

        <div class="vl-editor glass-panel">
          <div class="vl-section-head">
            <div><b>${icon("type", 16)} 文本转语音</b><em>中间写口播，右侧调参数，左侧选音色</em></div>
            <button class="btn primary" id="vlGenerate">${icon("spark", 15)} 生成音频</button>
          </div>
          <div class="vl-textbox-wrap ${s.text ? "has-value" : ""}">
            <textarea class="vl-textarea" id="vlText" maxlength="5000" placeholder=" ">${esc(s.text || "")}</textarea>
            <div class="vl-typewriter"><span>输入要生成的口播文本</span></div>
          </div>
          <div class="vl-editor-foot">
            <span id="vlTextCount">${(s.text || "").length} / 5000 字</span>
          </div>
        </div>

        ${toolPanelHtml(mode, s, selected)}
      </section>
    </div>`;

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
    ["Speed", "Vol", "Pitch"].forEach(key => {
      const el = $(`#vl${key}`, root);
      if (!el) return;
      el.addEventListener("input", e => {
        const map = { Speed: "speed", Vol: "vol", Pitch: "pitch" };
        saveLabPatch({ [map[key]]: Number(e.currentTarget.value) });
        this.render(root);
      });
    });

    $$("[data-vl-tab]", root).forEach(b => b.addEventListener("click", () => {
      saveLabPatch({ tab: b.dataset.vlTab || "system" });
      this.render(root);
    }));
    const selectAndPreview = async (voiceId) => {
      const id = String(voiceId || "").trim();
      saveLabPatch({ voiceId: id, mode: "tts" });
      if (!id) {
        toast("已切换默认声线");
        this.render(root);
        return;
      }
      previewingVoiceId = id;
      this.render(root);
      try {
        await previewVoice(id, labState());
        toast("已生成试听");
      } catch (err) {
        toast(`试听失败：${err?.message || err}`);
      } finally {
        previewingVoiceId = "";
        this.render(root);
      }
    };
    $$("[data-vl-voice]", root).forEach(b => b.addEventListener("click", () => {
      selectAndPreview(b.dataset.vlVoice || "");
    }));
    $$("[data-vl-voice]", root).forEach(b => b.addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      b.click();
    }));
    $$("[data-vl-preview]", root).forEach(b => b.addEventListener("click", e => {
      e.stopPropagation();
      selectAndPreview(b.dataset.vlPreview || "");
    }));
    $$("[data-vl-fav]", root).forEach(b => b.addEventListener("click", e => {
      e.stopPropagation();
      const id = b.dataset.vlFav || "";
      const next = toggleFavoriteVoice(id);
      toast(next ? "已收藏音色" : "已取消收藏");
      this.render(root);
    }));
    $$("[data-vl-rename]", root).forEach(b => b.addEventListener("click", async e => {
      e.stopPropagation();
      const voice = findVoiceOption(b.dataset.vlRename || "");
      const name = await promptModal({ title: "重命名自定义声线", placeholder: "输入声线名称", value: voice.name || "", okText: "保存名称" });
      if (name == null) return;
      const saved = renameCustomVoice(voice.voiceId, name);
      if (!saved) { toast("名称不能为空，或该音色不属于当前账号", "error"); return; }
      toast(`已重命名为：${saved.name}`);
      this.render(root);
    }));
    $$("[data-vl-copy]", root).forEach(b => b.addEventListener("click", e => {
      e.stopPropagation();
      copyText(b.dataset.vlCopy || "");
      toast("已复制 voice_id");
    }));
    $("#vlFavCurrent", root)?.addEventListener("click", () => {
      if (!selected.voiceId) { toast("默认声线无需收藏"); return; }
      const next = toggleFavoriteVoice(selected.voiceId);
      toast(next ? "已收藏当前音色" : "已取消收藏当前音色");
      this.render(root);
    });
    $("#vlCopyCurrent", root)?.addEventListener("click", () => {
      if (!selected.voiceId) { toast("当前为默认声线"); return; }
      copyText(selected.voiceId);
      toast("已复制 voice_id");
    });
    $$("[data-vl-copy-audio]", root).forEach(b => b.addEventListener("click", () => {
      const audio = b.dataset.vlCopyAudio === "design" ? runtimeDesignAudio : runtimeAudio;
      if (!audio?.voiceId) return;
      copyText(audio.voiceId);
      toast("已复制 voice_id");
    }));
    $("#vlGenerate", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      const text = ($("#vlText", root)?.value || "").trim();
      if (!text) { toast("请先输入口播文本"); return; }
      saveLabPatch({ text, mode: "tts" });
      const out = await synthesizeTts({ text, voiceId: s.voiceId || "", speed: Number(s.speed || 1), vol: Number(s.vol || 1), pitch: Number(s.pitch || 0) });
      const voice = findVoiceOption(out.voiceId || s.voiceId || "");
      runtimeAudio = {
        url: out.audioDataUrl,
        voiceId: out.voiceId || s.voiceId || "",
        voiceName: voice.name || out.voiceId || "生成音频",
        name: `语音_${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`
      };
      toast("音频已生成");
      this.render(root);
    }, "生成中…"));
    $("#vlDesign", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
      const name = ($("#vlDesignName", root)?.value || "").trim();
      const prompt = ($("#vlDesignPrompt", root)?.value || "").trim();
      const previewText = ($("#vlDesignPreview", root)?.value || "").trim();
      saveLabPatch({ designName: name, designPrompt: prompt, designPreview: previewText });
      const out = await designTtsVoice({ prompt, previewText, name });
      const saved = rememberCustomVoice({ voiceId: out.voiceId, name: name || out.name || "新设计音色", description: prompt, previewAudioDataUrl: out.audioDataUrl || "" });
      setFavoriteVoice(out.voiceId, true);
      runtimeDesignAudio = out.audioDataUrl ? {
        url: out.audioDataUrl,
        voiceId: out.voiceId,
        voiceName: saved.name,
        name: `${saved.name}_试听`
      } : null;
      saveLabPatch({ voiceId: out.voiceId, tab: "mine", mode: "design", designName: "" });
      toast(`音色已加入我的音色：${saved.name}`);
      this.render(root);
    }, "设计中…"));
  }
};
