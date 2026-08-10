const PROJECT_STORAGE_KEY =
  window.__XINGZHEN_VIDEO_PROJECT_KEY__ || "xingzhen-video-project:standalone";
const SEARCH_PARAMS = new URLSearchParams(window.location.search);
const START_ON_HOME = SEARCH_PARAMS.get("start") === "home";
const INITIAL_PROJECT_ID = String(SEARCH_PARAMS.get("project") || "").trim().slice(0, 180);
const CAN_PUBLISH = SEARCH_PARAMS.get("canPublish") !== "0";
const resolvePublishableVideoOutput =
  window.VideoWorkshopPublishPolicy?.resolvePublishableVideoOutput
  || (() => null);
const WORKSPACE_MODE =
  typeof window.parent !== "undefined"
  && window.parent !== window
  && (
    SEARCH_PARAMS.get("workspace") === "1"
    || (
      typeof document !== "undefined"
      && document.documentElement?.dataset?.platformEmbedded === "true"
    )
  );
if (WORKSPACE_MODE && typeof document !== "undefined") {
  document.documentElement.dataset.platformWorkspace = "true";
}
const MAX_ATTACHMENTS_PER_MESSAGE = 8;
const HOME_PREFILL_IDS = new Set();
const EDITOR_AUTOLOAD_KEYS = new Set();
const VIDEO_VOICE_OPTIONS = (Array.isArray(window.__XINGZHEN_VIDEO_VOICES__)
  ? window.__XINGZHEN_VIDEO_VOICES__
  : [])
  .map(item => ({
    voiceId: String(item?.voiceId || "").trim(),
    name: String(item?.name || item?.voiceId || "").trim(),
    source: ["mine", "shared", "system"].includes(String(item?.source || ""))
      ? String(item.source)
      : "system",
    ownerId: String(item?.ownerId || "").trim(),
    previewAudioDataUrl: String(item?.previewAudioDataUrl || item?.audioDataUrl || "").trim(),
  }))
  .filter(item => item.voiceId);
const VIDEO_VOICE_MEMBER_ID = String(window.__XINGZHEN_VIDEO_MEMBER_ID__ || "standalone");
const VIDEO_VOICE_SETTINGS_KEY = `xingzhen-video-voice:${VIDEO_VOICE_MEMBER_ID}`;
const VIDEO_VOICE_RAIL_KEY = `xingzhen-video-voice-rail:${VIDEO_VOICE_MEMBER_ID}`;

function savedVideoVoiceSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(VIDEO_VOICE_SETTINGS_KEY) || "null");
    return value && typeof value === "object" ? value : {};
  } catch (_) {
    return {};
  }
}

const initialVideoVoiceSettings = savedVideoVoiceSettings();
const state = {
  // 统一工作区由外层路由决定当前会话，不读取子应用自己的最近项目，
  // 避免进入视频工坊时先闪出旧首页或错误的历史项目。
  projectId: WORKSPACE_MODE
    ? INITIAL_PROJECT_ID
    : (START_ON_HOME ? "" : localStorage.getItem(PROJECT_STORAGE_KEY) || ""),
  project: null,
  attachments: [],
  ratio: "9:16",
  creationMode: "video",
  outputIndex: 0,
  busy: false,
  pollTimer: null,
  messageSignature: "",
  conversationRenderProjectId: "",
  conversationBottomLockToken: 0,
  conversationBottomLockUntil: 0,
  conversationBottomLockProjectId: "",
  eventSignature: "",
  outputSignature: "",
  outputMediaSignature: "",
  historySignature: "",
  historyItems: [],
  historyLoadedAt: 0,
  historyLoadEpoch: 0,
  pendingThoughtTimer: null,
  pendingRequestToken: "",
  pendingScrollMessageId: "",
  deliveryProjectId: "",
  deliveryCollapsed: false,
  productionHeartbeatTimer: null,
  productionHeartbeatProjectId: "",
  productionHeartbeatStartedAt: 0,
  productionHeartbeatStageIndex: -1,
  projectLoadEpoch: 0,
  historyDeliveryCloseTimer: null,
  chatComposerResizeObserver: null,
  communitySharedOutputs: {},
  voiceMode: initialVideoVoiceSettings.mode === "fixed" ? "fixed" : "random",
  fixedVoiceId: String(initialVideoVoiceSettings.voiceId || "").trim(),
  generateVoiceId: String(initialVideoVoiceSettings.generateVoiceId || initialVideoVoiceSettings.voiceId || "").trim(),
  favoriteVoiceIds: new Set(),
  pendingDesignedVoice: null,
  voiceRailCollapsed: localStorage.getItem(VIDEO_VOICE_RAIL_KEY) === "1",
};

const dom = {
  startView: document.querySelector("#startView"),
  studioView: document.querySelector("#studioView"),
  startForm: document.querySelector("#startForm"),
  startInput: document.querySelector("#startInput"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  fileInput: document.querySelector("#fileInput"),
  conversation: document.querySelector("#conversation"),
  eventList: document.querySelector("#eventList"),
  progressNumber: document.querySelector("#progressNumber"),
  progressBar: document.querySelector("#progressBar"),
  projectLabel: document.querySelector("#projectLabel"),
  serviceState: document.querySelector("#serviceState"),
  serviceStateText: document.querySelector("#serviceStateText"),
  delivery: document.querySelector("#delivery"),
  outputTabs: document.querySelector("#outputTabs"),
  outputVideo: document.querySelector("#outputVideo"),
  outputMeta: document.querySelector("#outputMeta"),
  downloadButton: document.querySelector("#downloadButton"),
  publishOutputButton: document.querySelector("#publishOutputButton"),
  historyDeliveryButton: document.querySelector("#historyDeliveryButton"),
  historyDeliveryModal: document.querySelector("#historyDeliveryModal"),
  historyDeliveryFilter: document.querySelector("#historyDeliveryFilter"),
  historyDeliveryFilterMenu: document.querySelector("#historyDeliveryFilterMenu"),
  historyDeliveryFilterLabel: document.querySelector("#historyDeliveryFilterLabel"),
  historyDeliveryList: document.querySelector("#historyDeliveryList"),
  videoEditorModal: document.querySelector("#videoEditorModal"),
  videoEditorPreviewCanvas: document.querySelector("#videoEditorPreviewCanvas"),
  videoEditorPreview: document.querySelector("#videoEditorPreview"),
  videoEditorReplacementPreviewLayer: document.querySelector("#videoEditorReplacementPreviewLayer"),
  videoEditorOverlayPreviewLayer: document.querySelector("#videoEditorOverlayPreviewLayer"),
  videoEditorSubtitleReplaceMask: document.querySelector("#videoEditorSubtitleReplaceMask"),
  videoEditorSubtitlePreview: document.querySelector("#videoEditorSubtitlePreview"),
  videoEditorAssetList: document.querySelector("#videoEditorAssetList"),
  videoEditorAssetCount: document.querySelector("#videoEditorAssetCount"),
  videoEditorTimelineScroll: document.querySelector("#videoEditorTimelineScroll"),
  videoEditorTimelineCanvas: document.querySelector("#videoEditorTimelineCanvas"),
  videoEditorRuler: document.querySelector("#videoEditorRuler"),
  videoEditorVideoTrack: document.querySelector("#videoEditorVideoTrack"),
  videoEditorOverlayTrack: document.querySelector("#videoEditorOverlayTrack"),
  videoEditorSubtitleTrack: document.querySelector("#videoEditorSubtitleTrack"),
  videoEditorAudioTrack: document.querySelector("#videoEditorAudioTrack"),
  videoEditorBgmTrack: document.querySelector("#videoEditorBgmTrack"),
  videoEditorSfxTrack: document.querySelector("#videoEditorSfxTrack"),
  videoEditorPlayhead: document.querySelector("#videoEditorPlayhead"),
  videoEditorTimecode: document.querySelector("#videoEditorTimecode"),
  videoEditorPlay: document.querySelector("#videoEditorPlay"),
  videoEditorScrubber: document.querySelector("#videoEditorScrubber"),
  videoEditorUndo: document.querySelector("#videoEditorUndo"),
  videoEditorRedo: document.querySelector("#videoEditorRedo"),
  videoEditorSplit: document.querySelector("#videoEditorSplit"),
  videoEditorDelete: document.querySelector("#videoEditorDelete"),
  videoEditorZoom: document.querySelector("#videoEditorZoom"),
  videoEditorSelectionTitle: document.querySelector("#videoEditorSelectionTitle"),
  videoEditorClipInspector: document.querySelector("#videoEditorClipInspector"),
  videoEditorSubtitleInspector: document.querySelector("#videoEditorSubtitleInspector"),
  videoEditorSubtitleText: document.querySelector("#videoEditorSubtitleText"),
  videoEditorOverlayInspector: document.querySelector("#videoEditorOverlayInspector"),
  videoEditorOverlayEntry: document.querySelector("#videoEditorOverlayEntry"),
  videoEditorOverlayExit: document.querySelector("#videoEditorOverlayExit"),
  videoEditorAudioInspector: document.querySelector("#videoEditorAudioInspector"),
  videoEditorVolumeLabel: document.querySelector("#videoEditorVolumeLabel"),
  videoEditorTrackVolume: document.querySelector("#videoEditorTrackVolume"),
  videoEditorTrackVolumeValue: document.querySelector("#videoEditorTrackVolumeValue"),
  videoEditorBgm: document.querySelector("#videoEditorBgm"),
  videoEditorBgmDelete: document.querySelector("#videoEditorBgmDelete"),
  videoEditorSfx: document.querySelector("#videoEditorSfx"),
  videoEditorSfxPreview: document.querySelector("#videoEditorSfxPreview"),
  videoEditorSfxAdd: document.querySelector("#videoEditorSfxAdd"),
  videoEditorSubtitle: document.querySelector("#videoEditorSubtitle"),
  videoEditorSubmit: document.querySelector("#videoEditorSubmit"),
  projectAssetsButton: document.querySelector("#projectAssetsButton"),
  speedVersionControl: document.querySelector("#speedVersionControl"),
  speedVersionSelect: document.querySelector("#speedVersionSelect"),
  deliverySpeedMenu: document.querySelector("#deliverySpeedMenu"),
  speedVersionLabel: document.querySelector("#speedVersionLabel"),
  speedVersionButton: document.querySelector("#speedVersionButton"),
  publishedOutputBadge: document.querySelector("#publishedOutputBadge"),
  publishedOutputBadgeText: document.querySelector("#publishedOutputBadgeText"),
  deliveryToggleButton: document.querySelector("#deliveryToggleButton"),
  backButton: document.querySelector("#backButton"),
  startHistoryNewButton: document.querySelector("#startHistoryNewButton"),
  startHistoryToggleButton: document.querySelector("#startHistoryToggleButton"),
  startHistoryList: document.querySelector("#startHistoryList"),
  historyNewButton: document.querySelector("#historyNewButton"),
  historyList: document.querySelector("#historyList"),
  dropOverlay: document.querySelector("#dropOverlay"),
  toast: document.querySelector("#toast"),
  conversationColumn: document.querySelector(".conversation-column"),
  creationModeButtons: [...document.querySelectorAll("[data-creation-mode]")],
  voiceRailTabs: [...document.querySelectorAll("[data-voice-rail-tab]")],
  voiceRailPanels: [...document.querySelectorAll("[data-voice-rail-panel]")],
  voiceWorkbenchToggle: document.querySelector("#voiceWorkbenchToggle"),
  voiceModeButtons: [...document.querySelectorAll("[data-voice-mode]")],
  videoVoicePicker: document.querySelector("#videoVoicePicker"),
  videoVoicePickerButton: document.querySelector("#videoVoicePickerButton"),
  videoVoiceMenu: document.querySelector("#videoVoiceMenu"),
  videoVoiceSelectedName: document.querySelector("#videoVoiceSelectedName"),
  videoVoiceSelectedMeta: document.querySelector("#videoVoiceSelectedMeta"),
  videoGenerateVoicePicker: document.querySelector("#videoGenerateVoicePicker"),
  videoGenerateVoicePickerButton: document.querySelector("#videoGenerateVoicePickerButton"),
  videoGenerateVoiceMenu: document.querySelector("#videoGenerateVoiceMenu"),
  videoGenerateVoiceSelectedName: document.querySelector("#videoGenerateVoiceSelectedName"),
  videoGenerateVoiceSelectedMeta: document.querySelector("#videoGenerateVoiceSelectedMeta"),
  videoVoiceCurrent: document.querySelector("#videoVoiceCurrent"),
  videoVoiceHint: document.querySelector("#videoVoiceHint"),
  videoVoiceText: document.querySelector("#videoVoiceText"),
  videoVoiceGenerate: document.querySelector("#videoVoiceGenerate"),
  videoVoiceResult: document.querySelector("#videoVoiceResult"),
  videoVoiceDesignName: document.querySelector("#videoVoiceDesignName"),
  videoVoiceDesignPrompt: document.querySelector("#videoVoiceDesignPrompt"),
  videoVoiceDesignPreview: document.querySelector("#videoVoiceDesignPreview"),
  videoVoiceDesign: document.querySelector("#videoVoiceDesign"),
  videoVoiceDesignResult: document.querySelector("#videoVoiceDesignResult"),
  videoVoiceDesignSave: document.querySelector("#videoVoiceDesignSave"),
};

const rotatingPrompts = [
  "做一条有节奏的产品概念片",
  "把这个主题拍成有节奏的竖屏短片",
  "根据参考图设计完整的视觉叙事",
  "先问我关键问题，再开始创作",
];

const slashSkills = [
  {
    command: "/视频制作",
    title: "视频制作",
    detail: "用选题、口播文本或口播音频开始定制创作",
  },
];

let promptCycle = { index: 0, position: 0, deleting: false, timer: null, stopped: false };
let toastTimer = null;
let clientIdSequence = 0;
const compositionStates = new WeakMap();
const publicProgressTypingStates = new WeakMap();

const CONVERSATION_BOTTOM_THRESHOLD = 140;

function typePublicProgress(element, value) {
  if (!element) return;
  const target = String(value || "");
  const existing = publicProgressTypingStates.get(element);
  if (existing?.target === target) return;
  if (existing?.timer) window.clearTimeout(existing.timer);
  element.setAttribute("aria-label", target);
  if (!target || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    element.textContent = target;
    publicProgressTypingStates.set(element, { target, timer: null });
    return;
  }
  const characters = Array.from(target);
  let index = 1;
  element.textContent = characters[0] || "";
  const typingState = { target, timer: null };
  publicProgressTypingStates.set(element, typingState);
  const revealNext = () => {
    if (!element.isConnected || publicProgressTypingStates.get(element) !== typingState) return;
    index += 1;
    element.textContent = characters.slice(0, index).join("");
    if (index >= characters.length) {
      typingState.timer = null;
      return;
    }
    const previous = characters[index - 1];
    const delay = /[，。！？、,.!?]/.test(previous) ? 140 : 46;
    typingState.timer = window.setTimeout(revealNext, delay);
  };
  typingState.timer = window.setTimeout(revealNext, 46);
}

function captureConversationScroll(column) {
  if (!column) return { scrollTop: 0, wasNearBottom: true };
  const scrollTop = Math.max(0, Number(column.scrollTop) || 0);
  const scrollHeight = Math.max(0, Number(column.scrollHeight) || 0);
  const clientHeight = Math.max(0, Number(column.clientHeight) || 0);
  return {
    scrollTop,
    wasNearBottom: scrollHeight - scrollTop - clientHeight < CONVERSATION_BOTTOM_THRESHOLD,
  };
}

function scheduleConversationScroll(column, snapshot, { forceBottom = false, smooth = false } = {}) {
  if (!column) return;
  window.requestAnimationFrame(() => {
    if (forceBottom || snapshot.wasNearBottom) {
      const top = Math.max(0, Number(column.scrollHeight) || 0);
      if (typeof column.scrollTo === "function") {
        column.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
      } else {
        column.scrollTop = top;
      }
      return;
    }
    // Replacing the message DOM must not move a reader who has scrolled back
    // through history.  Directly changing this container cannot scroll an
    // embedded parent page, unlike scrolling a message element into view.
    column.scrollTop = snapshot.scrollTop;
  });
}

function stabilizeConversationBottom(column, content, projectId, durationMs = 900) {
  if (!column) return;
  const lockProjectId = String(projectId || "");
  const requestedUntil = Date.now() + Math.max(0, Number(durationMs) || 0);
  if (state.conversationBottomLockProjectId === lockProjectId) {
    state.conversationBottomLockUntil = Math.max(
      state.conversationBottomLockUntil,
      requestedUntil,
    );
  } else {
    state.conversationBottomLockProjectId = lockProjectId;
    state.conversationBottomLockUntil = requestedUntil;
  }
  const token = ++state.conversationBottomLockToken;
  const pin = () => {
    if (
      token !== state.conversationBottomLockToken
      || String(state.projectId || "") !== lockProjectId
      || state.conversationBottomLockProjectId !== lockProjectId
      || Date.now() > state.conversationBottomLockUntil
    ) return;
    const top = Math.max(0, Number(column.scrollHeight) || 0);
    if (typeof column.scrollTo === "function") {
      column.scrollTo({ top, behavior: "auto" });
    } else {
      column.scrollTop = top;
    }
  };
  // The workspace is still boot-hidden here. Pin synchronously, then cover
  // deferred image/video sizing without introducing a visible smooth-scroll
  // jump when a long conversation is first opened.
  pin();
  window.requestAnimationFrame(() => {
    pin();
    window.requestAnimationFrame(pin);
  });
  const observer = typeof ResizeObserver === "function"
    ? new ResizeObserver(pin)
    : null;
  observer?.observe(content || column);
  content?.addEventListener?.("load", pin, true);
  window.setTimeout(() => pin(), 90);
  window.setTimeout(() => {
    pin();
    observer?.disconnect();
    content?.removeEventListener?.("load", pin, true);
  }, Math.max(0, state.conversationBottomLockUntil - Date.now()));
}

function createClientId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    try {
      return cryptoApi.randomUUID.call(cryptoApi);
    } catch {
      // Some embedded or ordinary-HTTP browsers expose the method but reject it.
    }
  }
  if (typeof cryptoApi?.getRandomValues === "function") {
    try {
      const bytes = new Uint8Array(16);
      cryptoApi.getRandomValues.call(cryptoApi, bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
      return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
    } catch {
      // Continue to a collision-resistant non-crypto client-only fallback.
    }
  }
  clientIdSequence = (clientIdSequence + 1) % Number.MAX_SAFE_INTEGER;
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 12) || "0";
  return `${timestamp}-${clientIdSequence.toString(36)}-${random}`;
}

function trackComposition(input) {
  const current = compositionStates.get(input);
  if (current) return current;
  const composition = { active: false, justEnded: false };
  compositionStates.set(input, composition);
  input.addEventListener("compositionstart", () => {
    composition.active = true;
    composition.justEnded = false;
  });
  input.addEventListener("compositionend", () => {
    composition.active = false;
    composition.justEnded = true;
    window.setTimeout(() => {
      if (!composition.active) composition.justEnded = false;
    }, 0);
  });
  return composition;
}

function enterConfirmsComposition(event, input) {
  if (event.key !== "Enter") return false;
  const composition = compositionStates.get(input);
  return Boolean(
    event.isComposing
    || event.keyCode === 229
    || event.which === 229
    || composition?.active
    || composition?.justEnded
  );
}

function keepCompositionEnterLocal(event, input) {
  if (!enterConfirmsComposition(event, input)) return false;
  const composition = compositionStates.get(input);
  if (
    composition?.justEnded
    && !composition.active
    && !event.isComposing
    && event.keyCode !== 229
    && event.which !== 229
  ) {
    event.preventDefault();
  }
  return true;
}

function publicText(value) {
  let text = String(value || "").replace(/OpenMontage/gi, "成片质检");
  if (/sensitive information/i.test(text)) {
    const scene = text.match(/第\s*(\d+)\s*段/)?.[1] || "当前";
    return `制作在当前步骤停住了：镜头 ${scene} 未通过内容安全审核，可以安全改写后只重试这个镜头。`;
  }
  return text.replace(/Request id\s*:\s*[a-zA-Z0-9_-]+/gi, "").trim();
}

function assistantText(value) {
  return publicText(value)
    .replace(/\r\n?/g, "\n")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/!\[([^\]]*)\]\([^)\n]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)\n]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^(\s*)[-*+]\s+/gm, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\\([*_`~#[\]()])/g, "$1")
    .replace(/\*\*|__|~~/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function publishedCountFor(project) {
  const rawCount = Number(
    project?._integration?.publishedCount
    ?? project?.publishedCount
    ?? 0
  );
  if (Number.isFinite(rawCount) && rawCount > 0) {
    return Math.max(1, Math.floor(rawCount));
  }
  return project?._integration?.publishedDeliveryId ? 1 : 0;
}

function publishedOutputMap(project) {
  const value = project?._integration?.publishedVideoOutputs;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function publicationForOutput(project, output) {
  const outputId = String(output?.id || "").trim();
  if (!outputId) return null;
  const publication = publishedOutputMap(project)[outputId];
  return publication && typeof publication === "object" ? publication : null;
}

function deliveryRowsFor(project) {
  const rows = Array.isArray(project?.deliveries)
    ? project.deliveries.filter(item => item && typeof item === "object")
    : [];
  if (rows.length) return rows;
  const outputs = Array.isArray(project?.outputs) ? project.outputs : [];
  return outputs.length ? [{
    id: String(project?.activeDeliveryId || "legacy-current"),
    title: String(project?.plan?.title || project?.name || "历史成片"),
    createdAt: 0,
    plan: project?.plan || null,
    outputs,
  }] : [];
}

function deliveryForMessage(project, message) {
  const deliveries = deliveryRowsFor(project);
  const deliveryId = String(message?.deliveryId || "").trim();
  if (deliveryId) {
    return deliveries.find(item => String(item?.id || "") === deliveryId) || null;
  }
  const deliveryMessages = (project?.messages || []).filter(item => item?.kind === "delivery");
  const messageIndex = deliveryMessages.findIndex(item => item?.id === message?.id);
  return messageIndex >= 0 ? deliveries[messageIndex] || null : null;
}

function createSpeedPicker(output, compact = false) {
  const details = document.createElement("details");
  details.className = `delivery-speed-menu${compact ? " compact" : ""}`;
  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.textContent = `${Number(output?.speed || 1.2).toFixed(1)}x`;
  const icon = document.createElement("i");
  icon.dataset.lucide = "chevron-down";
  summary.append(label, icon);
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  [1.2, 1.3, 1.5, 1.8, 2].forEach(rate => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.speedValue = String(rate);
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", Math.abs(rate - Number(output?.speed || 1.2)) < 0.01 ? "true" : "false");
    const check = document.createElement("i");
    check.dataset.lucide = "check";
    const text = document.createElement("span");
    text.textContent = `${rate.toFixed(1)}x`;
    button.append(check, text);
    button.addEventListener("click", () => {
      label.textContent = `${rate.toFixed(1)}x`;
      details.dataset.value = String(rate);
      menu.querySelectorAll("[data-speed-value]").forEach(item => {
        item.setAttribute("aria-checked", item === button ? "true" : "false");
      });
      details.open = false;
    });
    menu.append(button);
  });
  details.dataset.value = String(Number(output?.speed || 1.2));
  details.append(summary, menu);
  details.addEventListener("toggle", () => {
    if (!details.open) {
      menu.classList.remove("is-floating");
      menu.style.removeProperty("left");
      menu.style.removeProperty("top");
      return;
    }
    window.requestAnimationFrame(() => {
      const anchor = summary.getBoundingClientRect();
      const box = menu.getBoundingClientRect();
      const left = Math.min(
        window.innerWidth - box.width - 12,
        Math.max(12, anchor.left + (anchor.width - box.width) / 2),
      );
      const canOpenAbove = anchor.top > box.height + 16;
      const top = canOpenAbove
        ? anchor.top - box.height - 9
        : anchor.bottom + 9;
      menu.classList.add("is-floating");
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(Math.max(12, top))}px`;
      const closeOnScroll = () => {
        details.open = false;
      };
      window.addEventListener("scroll", closeOnScroll, { capture: true, once: true });
      window.addEventListener("resize", closeOnScroll, { once: true });
    });
  });
  return details;
}

function createChatDeliveryCard(message) {
  const project = state.project;
  const delivery = deliveryForMessage(project, message);
  const output = delivery?.outputs?.[0];
  if (!delivery || !output) return null;
  const publication = publicationForOutput(project, output);
  const card = document.createElement("section");
  card.className = "chat-delivery-card";
  const stage = document.createElement("div");
  stage.className = "chat-delivery-stage";
  const video = document.createElement("video");
  video.src = String(output.url || output.downloadUrl || "");
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  const download = document.createElement("a");
  download.className = "chat-delivery-download";
  download.href = String(output.downloadUrl || output.url || "#");
  download.download = `xingzhen-${String(output.aspectRatio || "16:9").replace(":", "x")}.mp4`;
  download.title = "下载成片";
  const downloadIcon = document.createElement("i");
  downloadIcon.dataset.lucide = "download";
  const downloadText = document.createElement("span");
  downloadText.textContent = "下载成片";
  download.append(downloadIcon, downloadText);
  stage.append(video, download);
  const footer = document.createElement("div");
  footer.className = "chat-delivery-footer";
  const meta = document.createElement("span");
  meta.textContent = [
    String(output.aspectRatio || delivery.aspectRatio || "16:9"),
    `${Number(output.speed || 1).toFixed(1)}x`,
    publication ? "已发布" : "未发布",
  ].join(" · ");
  const actions = document.createElement("div");
  actions.className = "chat-delivery-actions";
  const speedPicker = createSpeedPicker(output, true);
  const speedButton = document.createElement("button");
  speedButton.type = "button";
  speedButton.textContent = "另存变速版";
  speedButton.addEventListener("click", () => createSpeedVersion(output, speedPicker.dataset.value, speedButton));
  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "剪辑台";
  edit.addEventListener("click", () => openVideoEditor(output, delivery));
  const publish = document.createElement("button");
  publish.type = "button";
  publish.textContent = publication ? "已发布" : "发布";
  publish.disabled = Boolean(publication);
  publish.addEventListener("click", () => requestOutputPublish(output, delivery));
  const share = document.createElement("button");
  share.type = "button";
  const shareKey = String(output.id || output.deliveryId || "").trim();
  const sharedPost = shareKey ? state.communitySharedOutputs[shareKey] : null;
  share.textContent = sharedPost ? "已分享" : "分享灵感";
  share.disabled = Boolean(sharedPost);
  share.classList.toggle("is-shared", Boolean(sharedPost));
  share.addEventListener("click", () => requestOutputCommunityShare(output, delivery));
  actions.append(edit, speedPicker, speedButton);
  if (CAN_PUBLISH) actions.append(publish);
  actions.append(share);
  footer.append(meta, actions);
  card.append(stage, footer);
  return card;
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add("show");
  toastTimer = window.setTimeout(() => dom.toast.classList.remove("show"), 2800);
}

function hideToast() {
  window.clearTimeout(toastTimer);
  dom.toast.classList.remove("show");
}

function apiErrorMessage(data, fallback) {
  const detail = data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail && typeof detail === "object") {
    const message = detail.message || detail.detail;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function videoVoiceName(voiceId) {
  const id = String(voiceId || "").trim();
  if (!id) return "平台默认音色";
  return VIDEO_VOICE_OPTIONS.find(item => item.voiceId === id)?.name || id;
}

function persistVideoVoiceSettings() {
  try {
    localStorage.setItem(VIDEO_VOICE_SETTINGS_KEY, JSON.stringify({
      mode: state.voiceMode,
      voiceId: state.fixedVoiceId,
      generateVoiceId: state.generateVoiceId,
    }));
  } catch (_) {}
}

function nextNarrationVoiceId() {
  if (state.voiceMode === "fixed" && state.fixedVoiceId) return state.fixedVoiceId;
  const designed = VIDEO_VOICE_OPTIONS.filter(item => item.source === "mine" || item.source === "shared");
  if (designed.length) {
    const randomIndex = globalThis.crypto?.getRandomValues
      ? (() => {
          const values = new Uint32Array(1);
          globalThis.crypto.getRandomValues(values);
          return values[0] % designed.length;
        })()
      : Math.floor(Math.random() * designed.length);
    return designed[randomIndex]?.voiceId || "";
  }
  return String(window.__XINGZHEN_VIDEO_PREFERRED_VOICE__?.voiceId || "").trim();
}

function videoVoiceSourceLabel(voice = {}) {
  if (state.favoriteVoiceIds.has(voice.voiceId)) return "已收藏";
  return ({ mine: "我的设计", shared: "团队设计", system: "MiniMax 系统音色" }[voice.source]) || "可用声线";
}

function preferredFixedVoiceId() {
  return VIDEO_VOICE_OPTIONS.find(item => state.favoriteVoiceIds.has(item.voiceId))?.voiceId
    || VIDEO_VOICE_OPTIONS.find(item => item.source === "mine")?.voiceId
    || VIDEO_VOICE_OPTIONS.find(item => item.source === "shared")?.voiceId
    || VIDEO_VOICE_OPTIONS[0]?.voiceId
    || "";
}

function videoVoiceGroups() {
  const favorites = VIDEO_VOICE_OPTIONS.filter(item => state.favoriteVoiceIds.has(item.voiceId));
  const favoriteIds = new Set(favorites.map(item => item.voiceId));
  const available = VIDEO_VOICE_OPTIONS.filter(item => !favoriteIds.has(item.voiceId));
  return [
    { title: "收藏音色", items: favorites },
    { title: "我的设计", items: available.filter(item => item.source === "mine") },
    { title: "团队设计", items: available.filter(item => item.source === "shared") },
    { title: "MiniMax 系统音色", items: available.filter(item => item.source === "system") },
  ].filter(group => group.items.length);
}

const voicePreviewCache = new Map();
let activeVoicePreviewAudio = null;
let activeVoicePreviewId = "";

function videoVoicePickerContext(target = "narration") {
  if (target === "generate") {
    return {
      target,
      picker: dom.videoGenerateVoicePicker,
      button: dom.videoGenerateVoicePickerButton,
      menu: dom.videoGenerateVoiceMenu,
      selectedName: dom.videoGenerateVoiceSelectedName,
      selectedMeta: dom.videoGenerateVoiceSelectedMeta,
      selectedId: state.generateVoiceId,
    };
  }
  return {
    target: "narration",
    picker: dom.videoVoicePicker,
    button: dom.videoVoicePickerButton,
    menu: dom.videoVoiceMenu,
    selectedName: dom.videoVoiceSelectedName,
    selectedMeta: dom.videoVoiceSelectedMeta,
    selectedId: state.fixedVoiceId,
  };
}

function setVideoVoiceMenuOpen(open, target = "narration") {
  const context = videoVoicePickerContext(target);
  if (!context.menu || !context.button) return;
  ["narration", "generate"].forEach(otherTarget => {
    const other = videoVoicePickerContext(otherTarget);
    const next = otherTarget === target && Boolean(open);
    if (other.menu) other.menu.hidden = !next;
    other.button?.setAttribute("aria-expanded", next ? "true" : "false");
    other.picker?.classList.toggle("is-open", next);
  });
}

function updateVoicePreviewButtons() {
  document.querySelectorAll("[data-video-voice-preview]").forEach(button => {
    const isPlaying = button.dataset.videoVoicePreview === activeVoicePreviewId
      && activeVoicePreviewAudio
      && !activeVoicePreviewAudio.paused;
    button.classList.toggle("is-playing", Boolean(isPlaying));
    button.setAttribute("aria-label", isPlaying ? "停止试听" : "试听音色");
    button.title = isPlaying ? "停止试听" : "试听音色";
    button.replaceChildren();
    const iconNode = document.createElement("i");
    iconNode.dataset.lucide = isPlaying ? "square" : "play";
    button.append(iconNode);
  });
  refreshIcons();
}

async function previewVideoVoice(voiceId, trigger) {
  const id = String(voiceId || "").trim();
  if (!id) return;
  if (activeVoicePreviewId === id && activeVoicePreviewAudio && !activeVoicePreviewAudio.paused) {
    activeVoicePreviewAudio.pause();
    activeVoicePreviewAudio.currentTime = 0;
    activeVoicePreviewId = "";
    updateVoicePreviewButtons();
    return;
  }
  if (activeVoicePreviewAudio) {
    activeVoicePreviewAudio.pause();
    activeVoicePreviewAudio.currentTime = 0;
  }
  const voice = VIDEO_VOICE_OPTIONS.find(item => item.voiceId === id) || {};
  let audioUrl = voice.previewAudioDataUrl || voicePreviewCache.get(id) || "";
  trigger.disabled = true;
  trigger.classList.add("is-loading");
  try {
    if (!audioUrl) {
      const token = String(window.__XINGZHEN_VIDEO_AUTH_TOKEN__ || "").trim();
      const mainFetch = window.__XINGZHEN_VIDEO_MAIN_FETCH__ || window.fetch.bind(window);
      const response = await mainFetch("/api/tts/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "Idempotency-Key": globalThis.crypto?.randomUUID?.() || `video-voice-preview-${Date.now()}`,
        },
        body: JSON.stringify({
          text: "你好，这是一段星阵音色试听。",
          voiceId: id,
          speed: 1,
          vol: 1,
          pitch: 0,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.audioDataUrl) {
        const detail = typeof data.detail === "string" ? data.detail : data.detail?.detail;
        throw new Error(detail || "音色试听失败");
      }
      audioUrl = data.audioDataUrl;
      voicePreviewCache.set(id, audioUrl);
    }
    const audio = new Audio(audioUrl);
    activeVoicePreviewAudio = audio;
    activeVoicePreviewId = id;
    audio.addEventListener("ended", () => {
      if (activeVoicePreviewAudio !== audio) return;
      activeVoicePreviewId = "";
      updateVoicePreviewButtons();
    }, { once: true });
    audio.addEventListener("error", () => {
      if (activeVoicePreviewAudio !== audio) return;
      activeVoicePreviewId = "";
      updateVoicePreviewButtons();
      showToast("音色试听加载失败");
    }, { once: true });
    await audio.play();
  } catch (error) {
    activeVoicePreviewId = "";
    showToast(error?.message || "音色试听失败");
  } finally {
    trigger.disabled = false;
    trigger.classList.remove("is-loading");
    updateVoicePreviewButtons();
  }
}

function renderVideoVoiceMenu(target = "narration") {
  const context = videoVoicePickerContext(target);
  if (!context.menu) return;
  const { menu } = context;
  menu.replaceChildren();
  const searchWrap = document.createElement("label");
  searchWrap.className = "video-voice-search";
  const searchIcon = document.createElement("i");
  searchIcon.dataset.lucide = "search";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "搜索音色名称或 ID";
  search.setAttribute("aria-label", "搜索音色");
  searchWrap.append(searchIcon, search);
  menu.append(searchWrap);
  videoVoiceGroups().forEach(group => {
    const section = document.createElement("section");
    section.className = "video-voice-menu-group";
    const heading = document.createElement("div");
    heading.className = "video-voice-menu-title";
    heading.textContent = group.title;
    section.append(heading);
    group.items.forEach(voice => {
      const option = document.createElement("div");
      const active = voice.voiceId === context.selectedId
        && (target === "generate" || state.voiceMode === "fixed");
      option.className = `video-voice-option${active ? " is-active" : ""}${state.favoriteVoiceIds.has(voice.voiceId) ? " is-favorite" : ""}`;
      option.dataset.videoVoiceOption = voice.voiceId;
      option.dataset.videoVoiceTarget = target;
      option.dataset.videoVoiceSearch = `${voice.name} ${voice.voiceId} ${videoVoiceSourceLabel(voice)}`.toLocaleLowerCase("zh-Hans-CN");
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", active ? "true" : "false");
      const select = document.createElement("button");
      select.type = "button";
      select.className = "video-voice-option-select";
      const marker = document.createElement("i");
      marker.dataset.lucide = state.favoriteVoiceIds.has(voice.voiceId) ? "star" : (active ? "check" : "mic");
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = voice.name;
      const meta = document.createElement("small");
      meta.textContent = `${videoVoiceSourceLabel(voice)} · ${voice.voiceId}`;
      copy.append(name, meta);
      select.append(marker, copy);
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "video-voice-preview-button";
      preview.dataset.videoVoicePreview = voice.voiceId;
      preview.setAttribute("aria-label", "试听音色");
      preview.title = "试听音色";
      const previewIcon = document.createElement("i");
      previewIcon.dataset.lucide = "play";
      preview.append(previewIcon);
      option.append(select, preview);
      section.append(option);
    });
    menu.append(section);
  });
  search.addEventListener("input", () => {
    const keyword = search.value.trim().toLocaleLowerCase("zh-Hans-CN");
    menu.querySelectorAll(".video-voice-menu-group").forEach(section => {
      let visible = 0;
      section.querySelectorAll(".video-voice-option").forEach(option => {
        const matches = !keyword || String(option.dataset.videoVoiceSearch || "").includes(keyword);
        option.hidden = !matches;
        if (matches) visible += 1;
      });
      section.hidden = visible === 0;
    });
  });
  if (!VIDEO_VOICE_OPTIONS.length) {
    const empty = document.createElement("p");
    empty.className = "video-voice-menu-empty";
    empty.textContent = "暂无可用音色";
    menu.append(empty);
  }
  updateVoicePreviewButtons();
}

function syncVideoVoiceUi() {
  dom.voiceModeButtons.forEach(button => {
    const active = button.dataset.voiceMode === state.voiceMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const selected = VIDEO_VOICE_OPTIONS.find(item => item.voiceId === state.fixedVoiceId);
  if (dom.videoVoiceSelectedName) {
    dom.videoVoiceSelectedName.textContent = selected?.name || "平台自动选择";
  }
  if (dom.videoVoiceSelectedMeta) {
    dom.videoVoiceSelectedMeta.textContent = selected
      ? `${videoVoiceSourceLabel(selected)} · ${selected.voiceId}`
      : "优先从可用的定制音色中随机";
  }
  const generated = VIDEO_VOICE_OPTIONS.find(item => item.voiceId === state.generateVoiceId);
  if (dom.videoGenerateVoiceSelectedName) {
    dom.videoGenerateVoiceSelectedName.textContent = generated?.name || "平台默认音色";
  }
  if (dom.videoGenerateVoiceSelectedMeta) {
    dom.videoGenerateVoiceSelectedMeta.textContent = generated
      ? `${videoVoiceSourceLabel(generated)} · ${generated.voiceId}`
      : "可直接选择并试听";
  }
  dom.videoVoicePicker?.classList.toggle("is-random", state.voiceMode !== "fixed");
  if (dom.videoVoiceHint) {
    const designedCount = VIDEO_VOICE_OPTIONS.filter(item => item.source === "mine" || item.source === "shared").length;
    dom.videoVoiceHint.textContent = state.voiceMode === "fixed"
      ? `下一次将固定使用：${videoVoiceName(state.fixedVoiceId)}`
      : (designedCount
          ? `下一次将从 ${designedCount} 条定制音色中随机选择`
          : "未找到定制音色，将使用平台默认音色");
  }
  renderVideoVoiceMenu("narration");
  renderVideoVoiceMenu("generate");
}

function wireVideoVoicePicker(target = "narration") {
  const context = videoVoicePickerContext(target);
  if (!context.button || !context.menu) return;
  context.button.addEventListener("click", event => {
    event.stopPropagation();
    setVideoVoiceMenuOpen(context.menu.hidden, target);
  });
  context.menu.addEventListener("click", async event => {
    const preview = event.target.closest?.("[data-video-voice-preview]");
    if (preview) {
      event.preventDefault();
      event.stopPropagation();
      await previewVideoVoice(preview.dataset.videoVoicePreview, preview);
      return;
    }
    const option = event.target.closest?.("[data-video-voice-option]");
    if (!option) return;
    const voiceId = String(option.dataset.videoVoiceOption || "");
    if (target === "generate") {
      state.generateVoiceId = voiceId;
    } else {
      state.fixedVoiceId = voiceId;
      state.voiceMode = voiceId ? "fixed" : "random";
    }
    persistVideoVoiceSettings();
    setVideoVoiceMenuOpen(false, target);
    syncVideoVoiceUi();
  });
}

function resetVideoVoiceDesignResult() {
  state.pendingDesignedVoice = null;
  if (dom.videoVoiceDesignResult) dom.videoVoiceDesignResult.hidden = true;
  const audio = dom.videoVoiceDesignResult?.querySelector("audio");
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
  }
}

async function saveDesignedVideoVoice() {
  const candidate = state.pendingDesignedVoice;
  if (!candidate?.voiceId) return;
  const token = String(window.__XINGZHEN_VIDEO_AUTH_TOKEN__ || "").trim();
  const now = Date.now();
  const item = {
    id: `video-voice-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    voiceId: candidate.voiceId,
    name: candidate.name || candidate.voiceId,
    description: candidate.description || "",
    source: "mine",
    ownerId: VIDEO_VOICE_MEMBER_ID,
    createdAt: now,
    updatedAt: now,
    previewAudioDataUrl: candidate.audioDataUrl || "",
  };
  const mainFetch = window.__XINGZHEN_VIDEO_MAIN_FETCH__ || window.fetch.bind(window);
  const response = await mainFetch("/api/db/voicePresets", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ items: [item] }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? data.detail : data.detail?.detail;
    throw new Error(detail || "音色保存失败");
  }
  const existing = VIDEO_VOICE_OPTIONS.find(entry => entry.voiceId === item.voiceId);
  if (existing) Object.assign(existing, item);
  else VIDEO_VOICE_OPTIONS.unshift(item);
  voicePreviewCache.set(item.voiceId, item.previewAudioDataUrl);
  state.generateVoiceId = item.voiceId;
  persistVideoVoiceSettings();
  resetVideoVoiceDesignResult();
  syncVideoVoiceUi();
  window.parent?.postMessage?.({
    type: "custom-video:voice-presets-changed",
    scope: "video",
    voice: item,
  }, window.location.origin);
  showToast(`已保存音色“${item.name}”，并选为语音生成声线`);
}

function initializeVideoVoiceWorkbench() {
  if (!dom.videoVoicePickerButton || !dom.videoVoiceMenu) return;
  const syncVoiceRail = () => {
    dom.studioView?.classList.toggle("voice-rail-collapsed", state.voiceRailCollapsed);
    if (dom.voiceWorkbenchToggle) {
      dom.voiceWorkbenchToggle.setAttribute("aria-expanded", state.voiceRailCollapsed ? "false" : "true");
      dom.voiceWorkbenchToggle.setAttribute("aria-label", state.voiceRailCollapsed ? "展开声音工作台" : "收起声音工作台");
      dom.voiceWorkbenchToggle.title = state.voiceRailCollapsed ? "展开声音工作台" : "收起声音工作台";
      const label = dom.voiceWorkbenchToggle.querySelector("span");
      if (label) label.textContent = state.voiceRailCollapsed ? "展开" : "收起";
    }
  };
  syncVoiceRail();
  dom.voiceWorkbenchToggle?.addEventListener("click", () => {
    state.voiceRailCollapsed = !state.voiceRailCollapsed;
    localStorage.setItem(VIDEO_VOICE_RAIL_KEY, state.voiceRailCollapsed ? "1" : "0");
    syncVoiceRail();
  });
  if (state.fixedVoiceId && !VIDEO_VOICE_OPTIONS.some(item => item.voiceId === state.fixedVoiceId)) {
    state.fixedVoiceId = "";
    state.voiceMode = "random";
  }
  if (!state.generateVoiceId || !VIDEO_VOICE_OPTIONS.some(item => item.voiceId === state.generateVoiceId)) {
    state.generateVoiceId = preferredFixedVoiceId();
  }
  dom.voiceRailTabs.forEach(button => button.addEventListener("click", () => {
    const tab = button.dataset.voiceRailTab;
    dom.voiceRailTabs.forEach(item => item.classList.toggle("active", item === button));
    dom.voiceRailPanels.forEach(panel => {
      const active = panel.dataset.voiceRailPanel === tab;
      panel.hidden = !active;
      panel.classList.toggle("active", active);
    });
    setVideoVoiceMenuOpen(false, "narration");
  }));
  dom.voiceModeButtons.forEach(button => button.addEventListener("click", () => {
    state.voiceMode = button.dataset.voiceMode === "fixed" ? "fixed" : "random";
    if (state.voiceMode === "fixed" && !state.fixedVoiceId) {
      state.fixedVoiceId = preferredFixedVoiceId();
    }
    persistVideoVoiceSettings();
    syncVideoVoiceUi();
  }));
  wireVideoVoicePicker("narration");
  wireVideoVoicePicker("generate");
  document.addEventListener("click", event => {
    if (!dom.videoVoicePicker?.contains(event.target) && !dom.videoGenerateVoicePicker?.contains(event.target)) {
      setVideoVoiceMenuOpen(false, "narration");
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") setVideoVoiceMenuOpen(false, "narration");
  });
  dom.videoVoiceGenerate?.addEventListener("click", async () => {
    const text = String(dom.videoVoiceText?.value || "").trim();
    if (!text) {
      showToast("请先输入要生成的口播文本");
      return;
    }
    const token = String(window.__XINGZHEN_VIDEO_AUTH_TOKEN__ || "").trim();
    const original = dom.videoVoiceGenerate.querySelector("span")?.textContent || "生成音频";
    dom.videoVoiceGenerate.disabled = true;
    if (dom.videoVoiceGenerate.querySelector("span")) dom.videoVoiceGenerate.querySelector("span").textContent = "生成中…";
    try {
      const mainFetch = window.__XINGZHEN_VIDEO_MAIN_FETCH__ || window.fetch.bind(window);
      const response = await mainFetch("/api/tts/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "Idempotency-Key": globalThis.crypto?.randomUUID?.() || `video-voice-${Date.now()}`,
        },
        body: JSON.stringify({ text, voiceId: state.generateVoiceId || nextNarrationVoiceId(), speed: 1.2, vol: 1, pitch: 0 }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.audioDataUrl) throw new Error(data.detail || "语音生成失败");
      const audio = dom.videoVoiceResult?.querySelector("audio");
      const download = dom.videoVoiceResult?.querySelector("a");
      if (audio) audio.src = data.audioDataUrl;
      if (download) download.href = data.audioDataUrl;
      if (dom.videoVoiceResult) dom.videoVoiceResult.hidden = false;
      showToast(`已使用“${videoVoiceName(data.voiceId)}”生成音频`);
    } catch (error) {
      showToast(error?.message || "语音生成失败");
    } finally {
      dom.videoVoiceGenerate.disabled = false;
      if (dom.videoVoiceGenerate.querySelector("span")) dom.videoVoiceGenerate.querySelector("span").textContent = original;
    }
  });
  dom.videoVoiceDesign?.addEventListener("click", async () => {
    const name = String(dom.videoVoiceDesignName?.value || "").trim();
    const prompt = String(dom.videoVoiceDesignPrompt?.value || "").trim();
    const previewText = String(dom.videoVoiceDesignPreview?.value || "").trim()
      || "这是一段用于试听新音色的中文口播。";
    if (!prompt) {
      showToast("请先填写音色描述");
      return;
    }
    const token = String(window.__XINGZHEN_VIDEO_AUTH_TOKEN__ || "").trim();
    const original = dom.videoVoiceDesign.querySelector("span")?.textContent || "生成试听音色";
    dom.videoVoiceDesign.disabled = true;
    if (dom.videoVoiceDesign.querySelector("span")) dom.videoVoiceDesign.querySelector("span").textContent = "设计中…";
    try {
      const mainFetch = window.__XINGZHEN_VIDEO_MAIN_FETCH__ || window.fetch.bind(window);
      const response = await mainFetch("/api/tts/voice/design", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "Idempotency-Key": globalThis.crypto?.randomUUID?.() || `video-voice-design-${Date.now()}`,
        },
        body: JSON.stringify({ prompt, previewText, name }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.voiceId) {
        const detail = typeof data.detail === "string" ? data.detail : data.detail?.detail;
        throw new Error(detail || "音色设计失败");
      }
      state.pendingDesignedVoice = {
        voiceId: String(data.voiceId || "").trim(),
        name: name || data.name || data.voiceId,
        description: prompt,
        audioDataUrl: String(data.audioDataUrl || "").trim(),
      };
      const audio = dom.videoVoiceDesignResult?.querySelector("audio");
      if (audio) audio.src = state.pendingDesignedVoice.audioDataUrl;
      if (dom.videoVoiceDesignResult) dom.videoVoiceDesignResult.hidden = false;
      showToast("音色候选已生成，试听后可保存");
    } catch (error) {
      showToast(error?.message || "音色设计失败");
    } finally {
      dom.videoVoiceDesign.disabled = false;
      if (dom.videoVoiceDesign.querySelector("span")) dom.videoVoiceDesign.querySelector("span").textContent = original;
    }
  });
  dom.videoVoiceDesignSave?.addEventListener("click", async () => {
    dom.videoVoiceDesignSave.disabled = true;
    try {
      await saveDesignedVideoVoice();
    } catch (error) {
      showToast(error?.message || "音色保存失败");
    } finally {
      dom.videoVoiceDesignSave.disabled = false;
    }
  });
  dom.videoVoiceDesignResult?.querySelector("[data-video-voice-design-discard]")?.addEventListener("click", resetVideoVoiceDesignResult);
  syncVideoVoiceUi();
}

async function copyText(value) {
  const text = String(value || "");
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    // 同源 iframe 也可能因浏览器权限策略拒绝 Clipboard API，继续走兼容回退。
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;inset:-9999px auto auto -9999px;opacity:0;pointer-events:none";
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try {
    copied = Boolean(document.execCommand?.("copy"));
  } catch (_) {
    copied = false;
  } finally {
    textarea.remove();
  }
  return copied;
}

function showAttachmentError(error, fallback = "附件处理失败，请重试") {
  const detail = String(error?.message || "").trim();
  showToast(detail ? `${fallback}：${detail}` : fallback);
}

function selectSpeedVersion(value) {
  const normalized = String(value || "1.2");
  const option = [...dom.speedVersionSelect.options].find(item => item.value === normalized);
  if (!option) return;
  dom.speedVersionSelect.value = normalized;
  dom.speedVersionLabel.textContent = option.textContent;
  dom.deliverySpeedMenu?.querySelectorAll("[data-speed-value]").forEach(button => {
    button.setAttribute("aria-checked", String(button.dataset.speedValue === normalized));
  });
}

function selectHistoryDeliveryFilter(value) {
  const normalized = ["published", "unpublished"].includes(String(value)) ? String(value) : "all";
  const option = [...dom.historyDeliveryFilter.options].find(item => item.value === normalized);
  if (!option) return;
  dom.historyDeliveryFilter.value = normalized;
  if (dom.historyDeliveryFilterLabel) dom.historyDeliveryFilterLabel.textContent = option.textContent;
  dom.historyDeliveryFilterMenu?.querySelectorAll("[data-history-filter-value]").forEach(button => {
    button.setAttribute("aria-checked", String(button.dataset.historyFilterValue === normalized));
  });
}

function typePlaceholder() {
  if (promptCycle.stopped) return;
  const phrase = rotatingPrompts[promptCycle.index];
  if (!promptCycle.deleting) {
    promptCycle.position += 1;
    dom.startInput.placeholder = phrase.slice(0, promptCycle.position);
    if (promptCycle.position >= phrase.length) {
      promptCycle.deleting = true;
      promptCycle.timer = window.setTimeout(typePlaceholder, 1500);
      return;
    }
  } else {
    promptCycle.position -= 1;
    dom.startInput.placeholder = phrase.slice(0, promptCycle.position);
    if (promptCycle.position <= 0) {
      promptCycle.deleting = false;
      promptCycle.index = (promptCycle.index + 1) % rotatingPrompts.length;
    }
  }
  promptCycle.timer = window.setTimeout(typePlaceholder, promptCycle.deleting ? 34 : 68);
}

function stopPlaceholderCycle() {
  if (promptCycle.stopped) return;
  promptCycle.stopped = true;
  window.clearTimeout(promptCycle.timer);
  promptCycle.timer = null;
  dom.startInput.placeholder = "";
}

function autoSize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 168)}px`;
  if (textarea === dom.chatInput) window.requestAnimationFrame(syncChatComposerSafeSpace);
}

function syncChatComposerSafeSpace() {
  const composer = dom.chatForm;
  const column = dom.conversationColumn;
  const pane = column?.closest?.(".conversation-pane");
  if (!composer || !column || !pane || typeof composer.getBoundingClientRect !== "function") return;
  const wasNearBottom = column.scrollHeight - column.scrollTop - column.clientHeight < 160;
  const composerHeight = Math.ceil(composer.getBoundingClientRect().height || 0);
  const safeSpace = Math.max(126, composerHeight - 24);
  pane.style.setProperty("--chat-composer-safe-space", `${safeSpace}px`);
  if (wasNearBottom) {
    window.requestAnimationFrame(() => column.scrollTo({ top: column.scrollHeight }));
  }
}

function installChatComposerSafeSpace() {
  syncChatComposerSafeSpace();
  if (!dom.chatForm || typeof ResizeObserver !== "function") return;
  state.chatComposerResizeObserver?.disconnect?.();
  state.chatComposerResizeObserver = new ResizeObserver(syncChatComposerSafeSpace);
  state.chatComposerResizeObserver.observe(dom.chatForm);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  try {
    const files = [...(fileList || [])].filter((file) => /^(?:image\/(?:png|jpeg|webp)|video\/(?:mp4|quicktime|webm)|audio\/(?:mpeg|mp3|wav|x-wav|mp4|x-m4a|m4a))$/.test(file.type));
    if (!files.length) {
      showToast("仅支持图片、MP4/MOV/WebM 与 MP3/WAV/M4A");
      return 0;
    }
    const previousCount = state.attachments.length;
    for (const file of files) {
      if (state.attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        showToast("每条消息最多添加 8 个附件");
        break;
      }
      const isVideo = file.type.startsWith("video/");
      const isAudio = file.type.startsWith("audio/");
      const kind = isVideo ? "video/" : isAudio ? "audio/" : "image/";
      const sizeLimit = isVideo || isAudio ? 40 * 1024 * 1024 : 6 * 1024 * 1024;
      if (file.size > sizeLimit) {
        showToast(`${file.name} 超过 ${isVideo || isAudio ? "40MB" : "6MB"}`);
        continue;
      }
      const sameTypeCount = state.attachments
        .filter((item) => String(item.mime || "").startsWith(kind))
        .length;
      let dataUrl = "";
      try {
        dataUrl = await fileToDataUrl(file);
      } catch (error) {
        showAttachmentError(error, `${file.name || "附件"} 读取失败，请重试`);
        continue;
      }
      state.attachments.push({
        id: createClientId(),
        label: `${isVideo ? "视频" : isAudio ? "音频" : "图"}${sameTypeCount + 1}`,
        name: file.name,
        mime: file.type,
        dataUrl,
      });
    }
    renderAttachments();
    const addedCount = state.attachments.length - previousCount;
    if (addedCount > 0) {
      stopPlaceholderCycle();
      showToast(`已添加 ${addedCount} 个创作素材`);
    }
    return addedCount;
  } catch (error) {
    showAttachmentError(error);
    return 0;
  }
}

function renderAttachments() {
  document.querySelectorAll("[data-attachment-strip]").forEach((strip) => {
    strip.replaceChildren();
    state.attachments.forEach((attachment) => {
      const chip = document.createElement("div");
      chip.className = "attachment-chip";
      const isVideo = attachment.mime.startsWith("video/");
      const isAudio = attachment.mime.startsWith("audio/");
      const media = document.createElement(isAudio ? "div" : isVideo ? "video" : "img");
      if (isAudio) {
        media.className = "audio-thumbnail";
        const icon = document.createElement("i");
        icon.dataset.lucide = "audio-lines";
        media.append(icon);
      } else {
        media.src = attachment.dataUrl;
      }
      if (media instanceof HTMLVideoElement) {
        media.muted = true;
        media.playsInline = true;
        media.preload = "metadata";
      } else {
        media.alt = attachment.name;
      }
      const label = document.createElement("span");
      label.className = "attachment-label";
      label.textContent = attachment.label;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `移除 ${attachment.name}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        state.attachments = state.attachments.filter((item) => item.id !== attachment.id);
        renderAttachments();
      });
      chip.append(media, label, remove);
      strip.append(chip);
    });
  });
  const startLine = document.querySelector(".start-input-line");
  if (startLine) {
    const attachmentWidth = Math.min(Math.max(0, state.attachments.length * 60 - 8), 360);
    startLine.style.setProperty("--start-attachment-width", `${attachmentWidth}px`);
    startLine.classList.toggle("has-attachments", state.attachments.length > 0);
  }
  refreshIcons();
}

function isolatePendingAttachments(nextProjectId) {
  const currentProjectId = String(state.projectId || "");
  const targetProjectId = String(nextProjectId || "");
  if (currentProjectId === targetProjectId || !state.attachments.length) return 0;
  const removedCount = state.attachments.length;
  state.attachments = [];
  renderAttachments();
  showToast(`已切换会话，${removedCount} 个未发送附件未带入新会话`);
  return removedCount;
}

function enterStudio() {
  dom.startView.classList.add("is-hidden");
  dom.studioView.classList.remove("is-hidden");
}

function createMessageIdentity(message) {
  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = message.role === "user" ? "YOU" : message.kind === "plan" ? "DIRECTOR" : "XINGZHEN";
  if (message.role === "user") return label;

  const identity = document.createElement("div");
  identity.className = "message-identity";
  const avatar = document.createElement("span");
  avatar.className = `message-agent-avatar${message.kind === "pending" ? " is-working" : ""}${message.kind === "plan" ? " is-director" : ""}`;
  avatar.setAttribute("aria-hidden", "true");
  const image = document.createElement("img");
  image.src = "/assets/brand/starmatrix-mascot-transparent.png";
  image.addEventListener("error", () => {
    image.src = "assets/xingzhen-logo-white.png";
  }, { once: true });
  image.alt = "";
  avatar.append(image);
  identity.append(avatar, label);
  return identity;
}

function liveThinkingDetails(content) {
  const details = document.createElement("details");
  details.className = "live-thinking-summary";
  details.open = true;
  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.className = "live-thinking-label";
  label.textContent = "思考中";
  summary.append(label, content);
  const progress = document.createElement("b");
  progress.className = "live-thinking-progress";
  progress.textContent = `${Number(state.project?.progress || 0)}%`;
  summary.append(progress);
  const events = document.createElement("div");
  events.className = "live-thinking-events";
  const placeholder = document.createElement("div");
  placeholder.className = "live-thinking-placeholder";
  const placeholderTitle = document.createElement("strong");
  placeholderTitle.textContent = "正在梳理执行步骤";
  const placeholderDetail = document.createElement("span");
  placeholderDetail.textContent = "这里会持续显示已确认的制作判断与当前进度。";
  placeholder.append(placeholderTitle, placeholderDetail);
  events.append(placeholder);
  details.append(summary, events);
  return details;
}

function createMessage(message, isRetryTarget = false) {
  const article = document.createElement("article");
  article.className = `message ${message.role}${message.kind === "error" ? " error" : ""}${message.kind === "pending" ? " pending" : ""}`;
  article.dataset.messageId = message.id || "";

  const content = document.createElement("div");
  content.className = "message-content";
  if (message.kind === "pending") {
    const ring = document.createElement("span");
    ring.className = "activity-ring";
    ring.setAttribute("aria-hidden", "true");
    const pendingText = document.createElement("span");
    pendingText.className = "pending-live-text";
    typePublicProgress(pendingText, assistantText(message.content));
    content.append(ring, pendingText);
  } else {
    content.textContent = message.role === "assistant"
      ? assistantText(message.content)
      : publicText(message.content);
  }
  article.append(createMessageIdentity(message));

  if (message.kind === "plan" && state.project?.plan) {
    const plan = state.project.plan;
    const thoughts = Array.isArray(plan.public_thoughts) && plan.public_thoughts.length
      ? plan.public_thoughts
      : [
          {
            title: "先锁定表达对象",
            detail: `面向${plan.audience || "目标观众"}，先让语气和信息密度匹配观看场景。`,
          },
          {
            title: "按内容组织镜头",
            detail: `使用 ${plan.scenes?.length || 1} 个镜头承接完整表达，让画面节奏跟随口播而不是固定模板。`,
          },
          {
            title: "把文字交给后期",
            detail: "画面生成阶段不承担可读文字，字幕在合成时统一控制清晰度、描边和安全区。",
          },
        ];
    const details = document.createElement("details");
    details.className = "thinking-summary";
    details.open = true;
    const summary = document.createElement("summary");
    const icon = document.createElement("i");
    icon.dataset.lucide = "brain";
    const summaryText = document.createElement("span");
    summaryText.textContent = "思考过程";
    summary.append(icon, summaryText);
    const steps = document.createElement("div");
    steps.className = "thinking-steps";
    thoughts.slice(0, 4).forEach((thought) => {
      const step = document.createElement("div");
      step.className = "thinking-step";
      const title = document.createElement("strong");
      title.textContent = assistantText(thought.title || "导演判断");
      const detail = document.createElement("p");
      detail.textContent = assistantText(thought.detail || "");
      step.append(title, detail);
      steps.append(step);
    });
    details.append(summary, steps);
    article.append(details);
  }

  article.append(message.kind === "pending" ? liveThinkingDetails(content) : content);

  if (message.kind === "question" && Array.isArray(message.suggestions) && message.suggestions.length) {
    const suggestions = document.createElement("div");
    suggestions.className = "suggestion-actions";
    message.suggestions.slice(0, 3).forEach((suggestion) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = assistantText(suggestion);
      button.addEventListener("click", () => sendMessage(suggestion, false));
      suggestions.append(button);
    });
    article.append(suggestions);
  }

  if (isRetryTarget && ["safe_rewrite", "resume_missing", "resume_plan"].includes(state.project?.retryable?.type)) {
    const sceneNumber = Number(state.project.retryable.sceneNumber || 0);
    const isResume = ["resume_missing", "resume_plan"].includes(state.project.retryable.type);
    const isCopyright = state.project.retryable.reason === "copyright";
    const actionLabel = isResume
      ? `继续原任务 · 镜头 ${sceneNumber}`
      : `${isCopyright ? "原创" : "安全"}改写并重试镜头 ${sceneNumber}`;
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "retry-button";
    retryButton.setAttribute("aria-label", actionLabel);
    const icon = document.createElement("i");
    icon.dataset.lucide = "rotate-ccw";
    const text = document.createElement("span");
    text.textContent = actionLabel;
    retryButton.append(icon, text);
    retryButton.addEventListener("click", () => retryProject(retryButton));
    actions.append(retryButton);
    article.append(actions);
  }

  if (Array.isArray(message.attachments) && message.attachments.length) {
    const images = document.createElement("div");
    images.className = "message-attachments";
    message.attachments.forEach((attachment) => {
      const item = document.createElement("div");
      item.className = "message-attachment";
      const isVideo = String(attachment.mime || "").startsWith("video/");
      const isAudio = String(attachment.mime || "").startsWith("audio/");
      if (isAudio) item.classList.add("audio");
      const media = document.createElement(isAudio ? "audio" : isVideo ? "video" : "img");
      media.src = isVideo ? (attachment.previewUrl || attachment.url) : attachment.url;
      if (media instanceof HTMLVideoElement) {
        media.muted = true;
        media.playsInline = true;
        media.preload = "metadata";
      } else if (media instanceof HTMLAudioElement) {
        media.controls = true;
        media.preload = "metadata";
      } else {
        media.alt = attachment.name || "创作素材";
      }
      const badge = document.createElement("span");
      badge.textContent = attachment.label || (isVideo ? "视频" : isAudio ? "音频" : "图片");
      item.append(media, badge);
      images.append(item);
    });
    article.append(images);
  }

  if (message.kind === "delivery") {
    const deliveryCard = createChatDeliveryCard(message);
    if (deliveryCard) article.append(deliveryCard);
  }

  if (message.kind === "plan" && state.project?.plan) {
    const plan = state.project.plan;
    const planLine = document.createElement("div");
    planLine.className = "output-meta";
    const scenes = (plan.scenes || []).map((scene, index) => `${index + 1}. ${scene.title}`).join(" / ");
    const plannedDuration = (plan.scenes || []).reduce((total, scene) => total + Number(scene.duration_sec || 0), 0);
    const scenePlan = `${plan.scenes?.length || 1} 个镜头${plannedDuration ? ` · 约 ${plannedDuration} 秒画面计划` : ""}`;
    [plan.aspect_ratio, scenePlan, plan.tone, scenes].filter(Boolean).forEach((value) => {
      const span = document.createElement("span");
      span.textContent = value;
      planLine.append(span);
    });
    article.append(planLine);
    if (Array.isArray(plan.asset_assignments) && plan.asset_assignments.length) {
      const roleText = {
        reference: "生成参考",
        material: "剪辑素材",
        both: "参考并剪辑",
        narration: "口播主音轨",
        bgm: "背景音乐",
        sfx: "局部音效",
        unused: "暂不使用",
      };
      const presentationText = {
        overlay: "透明叠加",
        pip: "画中画叠加",
        cutaway: "全屏切入",
      };
      const assetPlan = document.createElement("div");
      assetPlan.className = "asset-plan-summary";
      assetPlan.textContent = plan.asset_assignments
        .map((item) => {
          const treatment = ["material", "both"].includes(item.role)
            ? presentationText[item.presentation]
            : "";
          return `${item.label} ${roleText[item.role] || "自动分配"}${treatment ? ` · ${treatment}` : ""}`;
        })
        .join(" · ");
      article.append(assetPlan);
    }
  }
  const copyValue = message.role === "assistant"
    ? assistantText(message.content)
    : publicText(message.content);
  if (message.kind !== "pending" && String(copyValue || "").trim()) {
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "message-copy";
    copyButton.setAttribute("aria-label", "复制这条消息");
    copyButton.title = "复制";
    const copyIcon = document.createElement("i");
    copyIcon.dataset.lucide = "copy";
    copyButton.append(copyIcon);
    copyButton.addEventListener("click", async () => {
      if (await copyText(copyValue)) {
        copyButton.title = "已复制";
        showToast("已复制消息");
      } else {
        showToast("复制失败，请手动选择文字");
      }
    });
    article.append(copyButton);
  }
  return article;
}

function isLegacyGenericPublicEvent(event) {
  const title = assistantText(event?.title || "");
  const detail = assistantText(event?.detail || "");
  return (
    title === "正在思考"
    && detail === "正在理解这条消息，并判断应当回答、追问还是开始制作。"
  ) || (
    title === "等待补充关键信息"
    && detail === "导演只保留了一个会显著影响成片的问题。"
  );
}

function uniqueLivePublicEvents(events, limit = 3) {
  const unique = [];
  const seen = new Set();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (isLegacyGenericPublicEvent(event)) continue;
    const key = `${assistantText(event?.title || "")}\n${assistantText(event?.detail || "")}`;
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    unique.unshift(event);
    if (unique.length >= limit) break;
  }
  return unique;
}

function currentRunPublicEvents(project, events = project?.events || []) {
  const startedAt = Date.parse(String(project?.runStartedAt || ""));
  if (!Number.isFinite(startedAt)) return events;
  return events.filter(event => {
    const eventAt = Date.parse(String(event?.at || event?.createdAt || ""));
    return Number.isFinite(eventAt) && eventAt >= startedAt;
  });
}

function latestProjectUserSubject(project) {
  const message = [...(project?.messages || [])]
    .reverse()
    .find(item => item?.role === "user" && String(item?.content || "").trim());
  return publicProgressSubject(message?.content || "");
}

function liveProductionTitle(project, events = project?.events || []) {
  const latestVisibleEvent = uniqueLivePublicEvents(currentRunPublicEvents(project, events), 1).at(-1);
  if (latestVisibleEvent) return assistantText(latestVisibleEvent.title || "制作任务正在运行");
  const subject = latestProjectUserSubject(project);
  return subject ? `正在处理“${subject}”` : "制作任务正在运行";
}

function createLiveProductionIndicator(project) {
  const article = document.createElement("article");
  article.className = "message assistant production-live";
  const content = document.createElement("div");
  content.className = "message-content";
  const ring = document.createElement("span");
  ring.className = "activity-ring";
  ring.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "production-live-text";
  const title = document.createElement("span");
  title.className = "production-live-title";
  title.textContent = liveProductionTitle(project);
  const detail = document.createElement("span");
  detail.className = "production-live-detail";
  const separator = document.createElement("span");
  separator.className = "production-live-separator";
  separator.textContent = "·";
  const stageWindow = document.createElement("span");
  stageWindow.className = "production-live-stage-window";
  stageWindow.dataset.stage = productionHeartbeatStages[0];
  stageWindow.setAttribute("aria-live", "polite");
  const stage = document.createElement("span");
  stage.className = "production-live-stage is-current";
  stage.textContent = productionHeartbeatStages[0];
  stageWindow.append(stage);
  const elapsed = document.createElement("span");
  elapsed.className = "production-live-elapsed";
  elapsed.textContent = "1秒";
  detail.append(separator, stageWindow, elapsed);
  text.append(title, detail);
  content.append(ring, text);
  article.append(
    createMessageIdentity({ role: "assistant", kind: "pending" }),
    liveThinkingDetails(content),
  );
  return article;
}

function renderConversation(project) {
  const errorMessages = (project.messages || []).filter((item) => item.kind === "error");
  const retryMessageId = project.retryable ? errorMessages.at(-1)?.id : "";
  const signature = JSON.stringify({
    messages: (project.messages || []).map((item) => [item.id, item.content, item.kind, item.deliveryId, item.attachments, item.suggestions]),
    thoughts: project.plan?.public_thoughts || null,
    assetAssignments: project.plan?.asset_assignments || null,
    deliveries: deliveryRowsFor(project).map(item => [
      item.id,
      (item.outputs || []).map(output => [output.id, output.url, output.aspectRatio, output.speed]),
    ]),
    publishedVideoOutputs: publishedOutputMap(project),
    retryable: project.retryable || null,
    status: project.status,
  });
  if (signature === state.messageSignature) return;
  state.messageSignature = signature;
  const openingProject = state.conversationRenderProjectId !== project.id;
  state.conversationRenderProjectId = project.id;
  const scrollSnapshot = captureConversationScroll(dom.conversationColumn);
  const messages = (project.messages || []).map((message) => createMessage(message, message.id === retryMessageId));
  if (project.status === "running") messages.push(createLiveProductionIndicator(project));
  dom.conversation.replaceChildren(...messages);
  const pendingScrollId = state.pendingScrollMessageId;
  state.pendingScrollMessageId = "";
  const hasActiveBottomLock = (
    state.conversationBottomLockProjectId === String(project.id || "")
    && Date.now() < state.conversationBottomLockUntil
  );
  if (openingProject) {
    stabilizeConversationBottom(dom.conversationColumn, dom.conversation, project.id);
    return;
  }
  if (pendingScrollId || hasActiveBottomLock) {
    // A send can grow more than once: the optimistic user row, public progress
    // rows, and the final director reply all change the scroll height. Keep the
    // active send pinned for a bounded interval instead of restoring a stale
    // pre-send offset after every re-render.
    stabilizeConversationBottom(
      dom.conversationColumn,
      dom.conversation,
      project.id,
      pendingScrollId
        ? 12000
        : Math.max(0, state.conversationBottomLockUntil - Date.now()),
    );
    return;
  }
  state.conversationBottomLockToken += 1;
  state.conversationBottomLockUntil = 0;
  state.conversationBottomLockProjectId = "";
  scheduleConversationScroll(dom.conversationColumn, scrollSnapshot, {
    forceBottom: false,
    smooth: false,
  });
}

function renderEvents(project) {
  const events = [];
  const generationGroups = new Map();
  (project.events || []).forEach((event) => {
    const title = String(event.title || "");
    const seedanceMatch = title.match(/^Seedance 正在生成镜头\s*(\d+)/);
    const staticMatch = title.match(/^正在生成静态分镜\s*(\d+)/);
    const match = seedanceMatch || staticMatch;
    if (match) {
      const groupKey = seedanceMatch ? "seedance" : "static";
      const sceneNumber = Number(match[1] || 0);
      const existing = generationGroups.get(groupKey);
      if (existing) {
        existing.numbers.add(sceneNumber);
        existing.event.id = event.id || existing.event.id;
        existing.event.status = event.status || existing.event.status;
        const numbers = [...existing.numbers].filter(Boolean).sort((a, b) => a - b);
        const range = numbers.length > 1 ? `${numbers[0]}–${numbers.at(-1)}` : String(numbers[0] || 1);
        existing.event.title = groupKey === "seedance"
          ? `提交 Seedance 分镜 ${range}`
          : `提交静态图片分镜 ${range}`;
        existing.event.detail = groupKey === "seedance"
          ? `${numbers.length} 个视频分镜已统一提交，等待模型返回。`
          : `${numbers.length} 张图片分镜已并行提交，等待画面返回。`;
      } else {
        const numbers = new Set([sceneNumber]);
        const summaryEvent = {
          ...event,
          title: groupKey === "seedance"
            ? `提交 Seedance 分镜 ${sceneNumber || 1}`
            : `提交静态图片分镜 ${sceneNumber || 1}`,
          detail: groupKey === "seedance"
            ? "视频分镜已统一提交，等待模型返回。"
            : "图片分镜已并行提交，等待画面返回。",
        };
        generationGroups.set(groupKey, { numbers, event: summaryEvent });
        events.push(summaryEvent);
      }
      return;
    }
    events.push(event);
  });
  const signature = JSON.stringify(events.map((event) => [event.id, event.title, event.detail, event.status]));
  if (signature !== state.eventSignature) {
    state.eventSignature = signature;
    dom.eventList.replaceChildren();
    events.forEach((event, index) => {
      const item = document.createElement("div");
      const isLatest = index === events.length - 1;
      const status = event.status === "error" ? "error" : event.status === "done" ? "done" : isLatest ? "running" : "done";
      item.className = `event-item ${status}`;
      const title = document.createElement("strong");
      title.textContent = assistantText(event.title);
      const detail = document.createElement("p");
      detail.textContent = assistantText(event.detail);
      item.append(title, detail);
      dom.eventList.append(item);
    });
  }
  const progress = Number(project.progress || 0);
  dom.progressNumber.textContent = `${progress}%`;
  dom.progressBar.style.width = `${progress}%`;
  document.querySelectorAll(".live-thinking-summary").forEach(details => {
    const progressLabel = details.querySelector(".live-thinking-progress");
    if (progressLabel) progressLabel.textContent = `${progress}%`;
    const list = details.querySelector(".live-thinking-events");
    if (!list) return;
    const pendingMessageId = String(details.closest(".message")?.dataset.messageId || "");
    const pendingToken = pendingMessageId.endsWith("-assistant")
      ? pendingMessageId.slice(0, -"-assistant".length)
      : "";
    const isPendingMessage = details.closest(".message")?.classList.contains("pending");
    const scopedEvents = pendingToken
      ? events.filter(event => String(event.id || "").startsWith(`${pendingToken}-event`))
      : isPendingMessage
        ? []
        : events;
    const nextEvents = isPendingMessage
      ? scopedEvents.slice(-1)
      : uniqueLivePublicEvents(currentRunPublicEvents(project, scopedEvents));
    const existingItems = new Map(
      [...list.children]
        .filter(item => item.dataset.eventId)
        .map(item => [item.dataset.eventId, item]),
    );
    const retainedIds = new Set();
    nextEvents.forEach(event => {
      const eventId = String(event.id || `${event.title || ""}:${event.detail || ""}`);
      retainedIds.add(eventId);
      const item = existingItems.get(eventId) || document.createElement("div");
      item.dataset.eventId = eventId;
      let title = item.querySelector("strong");
      if (isPendingMessage) {
        title?.remove();
      } else {
        if (!title) {
          title = document.createElement("strong");
          item.append(title);
        }
        typePublicProgress(title, assistantText(event.title || "导演处理中"));
      }
      let detail = item.querySelector("span");
      if (!detail) {
        detail = document.createElement("span");
        item.append(detail);
      }
      typePublicProgress(detail, assistantText(event.detail || ""));
      list.append(item);
    });
    [...list.children].forEach(item => {
      if (!retainedIds.has(String(item.dataset.eventId || ""))) item.remove();
    });
  });
  const liveTitle = document.querySelector(".production-live-title");
  if (liveTitle) {
    liveTitle.textContent = liveProductionTitle(project, events);
  }
}

function selectOutput(index, { forceReload = false } = {}) {
  const output = state.project?.outputs?.[index];
  if (!output) return;
  const nextUrl = String(output.url || "");
  const currentUrl = String(
    dom.outputVideo.dataset.outputUrl
    || dom.outputVideo.getAttribute("src")
    || ""
  );
  const sourceChanged = forceReload || currentUrl !== nextUrl;
  state.outputIndex = index;
  dom.outputTabs.querySelectorAll("button").forEach((button, buttonIndex) => {
    button.classList.toggle("active", buttonIndex === index);
  });
  if (sourceChanged) {
    dom.outputVideo.dataset.outputUrl = nextUrl;
    dom.outputVideo.src = nextUrl;
    dom.outputVideo.load();
  }
  dom.downloadButton.href = output.downloadUrl || output.url;
  dom.downloadButton.download = `xingzhen-${output.aspectRatio.replace(":", "x")}.mp4`;
  dom.outputMeta.replaceChildren();
  const probe = output.probe || {};
  const values = [
    output.aspectRatio,
    `${Number(output.speed || 1).toFixed(1)}x`,
    `${probe.width || "-"} × ${probe.height || "-"}`,
    `${probe.duration || "-"}s`,
    `${output.captionCueCount || 0} 组动效字幕`,
    output.materialCueCount ? `${output.materialCueCount} 段用户素材` : "无外部剪辑素材",
    output.sfxCueCount ? `${output.sfxCueCount} 段音效素材` : "无额外音效",
    output.bgm?.name ? `BGM · ${output.bgm.name}` : "未使用 BGM",
    probe.hasAudio ? "音频已验证" : "无音频",
  ];
  values.forEach((value) => {
    const span = document.createElement("span");
    span.textContent = value;
    dom.outputMeta.append(span);
  });
  const outputId = String(output.id || "").trim();
  const publication = outputId
    ? state.project?._integration?.publishedVideoOutputs?.[outputId]
    : null;
  if (dom.publishedOutputBadge && dom.publishedOutputBadgeText) {
    dom.publishedOutputBadge.hidden = !publication;
    dom.publishedOutputBadgeText.textContent = "已发布";
    dom.publishedOutputBadge.title = publication
      ? `该成片已发布${publication.deliveryId ? ` · ${publication.deliveryId}` : ""}`
      : "";
  }
}

function publishPayloadForOutput(output, delivery = null) {
  const project = state.project;
  const resolved = resolvePublishableVideoOutput(project, output, delivery);
  if (!resolved) return null;
  const canonicalOutput = resolved.output;
  const canonicalDelivery = resolved.delivery;
  const videoUrl = resolved.videoUrl;
  const title = String(
    canonicalDelivery?.title
    || (project.name && project.name !== "新会话" ? project.name : "")
    || project.plan?.title
    || "未命名视频"
  ).trim() || "未命名视频";
  return {
    kind: "video",
    projectId: String(project.id),
    title,
    videoUrl,
    url: videoUrl,
    downloadUrl: String(canonicalOutput.downloadUrl || videoUrl),
    aspectRatio: String(canonicalOutput.aspectRatio || project.plan?.aspect_ratio || "9:16"),
    sourceDeliveryId: String(canonicalOutput.deliveryId || canonicalDelivery?.id || ""),
    sourceOutputId: String(canonicalOutput.id || ""),
    plan: canonicalDelivery?.plan || project.plan || null,
    project,
    status: "succeeded",
    publishedCount: publishedCountFor(project),
  };
}

function selectedPublishPayload() {
  const project = state.project;
  const output = project?.outputs?.[state.outputIndex];
  const delivery = deliveryRowsFor(project).find(item =>
    String(item?.id || "") === String(output?.deliveryId || project?.activeDeliveryId || "")
  ) || null;
  return publishPayloadForOutput(output, delivery);
}

function requestSelectedOutputPublish() {
  if (!CAN_PUBLISH) {
    showToast("当前版本不包含发布能力");
    return;
  }
  const payload = selectedPublishPayload();
  if (!payload) {
    showToast("成片尚未完成，暂时不能发布");
    return;
  }
  const embedded = (
    document.documentElement.dataset.platformEmbedded === "true"
    && window.parent !== window
  );
  if (!embedded) {
    showToast("请在主平台的定制创作中发布成片");
    return;
  }
  window.parent.postMessage(
    { type: "custom-video:publish-request", payload },
    window.location.origin,
  );
}

function requestOutputPublish(output, delivery) {
  if (!CAN_PUBLISH) {
    showToast("当前版本不包含发布能力");
    return;
  }
  const payload = publishPayloadForOutput(output, delivery);
  if (!payload) {
    showToast("成片尚未完成，暂时不能发布");
    return;
  }
  if (document.documentElement.dataset.platformEmbedded !== "true" || window.parent === window) {
    showToast("请在主平台的定制创作中发布成片");
    return;
  }
  window.parent.postMessage(
    { type: "custom-video:publish-request", payload },
    window.location.origin,
  );
}

function requestOutputCommunityShare(output, delivery) {
  const payload = publishPayloadForOutput(output, delivery);
  if (!payload) {
    showToast("成片尚未完成，暂时不能分享");
    return;
  }
  if (document.documentElement.dataset.platformEmbedded !== "true" || window.parent === window) {
    showToast("请在星阵主平台中分享灵感");
    return;
  }
  window.parent.postMessage(
    { type: "custom-video:community-share-request", payload },
    window.location.origin,
  );
}

async function createSpeedVersion(output, speed, trigger) {
  if (!state.projectId || !output?.id) return;
  const previousText = trigger?.textContent || "";
  if (trigger) {
    trigger.disabled = true;
    trigger.textContent = "处理中…";
  }
  try {
    const response = await fetch(`/api/projects/${state.projectId}/speed-version`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outputId: output.id, speed: Number(speed) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(apiErrorMessage(data, "生成变速版本失败"));
    closeHistoryDeliveryModal();
    state.outputSignature = "";
    state.outputMediaSignature = "";
    await loadProject(state.projectId, true);
    showToast(`新的 ${Number(speed).toFixed(1)} 倍速成片已生成`);
  } catch (error) {
    showToast(error.message || "生成变速版本失败");
  } finally {
    if (trigger) {
      trigger.disabled = false;
      trigger.textContent = previousText;
    }
  }
}

function closeHistoryDeliveryModal() {
  window.clearTimeout(state.historyDeliveryCloseTimer);
  dom.historyDeliveryModal.classList.remove("is-open");
  dom.historyDeliveryModal.classList.add("is-closing");
  state.historyDeliveryCloseTimer = window.setTimeout(() => {
    dom.historyDeliveryModal.hidden = true;
    dom.historyDeliveryModal.classList.remove("is-closing");
  }, 220);
  document.body.classList.remove("history-delivery-open");
}

function renderHistoryDeliveryModal() {
  const project = state.project;
  const filter = String(dom.historyDeliveryFilter.value || "all");
  const entries = deliveryRowsFor(project)
    .flatMap(delivery => (delivery.outputs || []).map(output => ({ delivery, output })))
    .filter(({ output }) => {
      const published = Boolean(publicationForOutput(project, output));
      return filter === "all" || (filter === "published" ? published : !published);
    });
  dom.historyDeliveryList.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "history-delivery-empty";
    empty.textContent = filter === "all" ? "当前还没有历史成片" : "没有符合筛选条件的成片";
    dom.historyDeliveryList.append(empty);
    return;
  }
  entries.forEach(({ delivery, output }) => {
    const publication = publicationForOutput(project, output);
    const card = document.createElement("article");
    card.className = "history-delivery-card";
    const video = document.createElement("video");
    video.src = String(output.url || output.downloadUrl || "");
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = String(delivery.title || project?.plan?.title || "历史成片");
    const meta = document.createElement("span");
    const createdAt = Number(delivery.createdAt || 0);
    meta.textContent = [
      String(output.aspectRatio || delivery.aspectRatio || "9:16"),
      `${Number(output.speed || 1).toFixed(1)}x`,
      createdAt ? new Date(createdAt).toLocaleString("zh-CN", { hour12: false }) : "历史版本",
      publication ? "已发布" : "未发布",
    ].join(" · ");
    const actions = document.createElement("div");
    actions.className = "history-delivery-card-actions";
    const download = document.createElement("a");
    download.href = String(output.downloadUrl || output.url || "#");
    download.download = `xingzhen-history-${String(output.aspectRatio || "9:16").replace(":", "x")}.mp4`;
    download.className = "history-download-action";
    const downloadIcon = document.createElement("i");
    downloadIcon.dataset.lucide = "download";
    const downloadLabel = document.createElement("span");
    downloadLabel.textContent = "下载";
    download.append(downloadIcon, downloadLabel);
    const publish = document.createElement("button");
    publish.type = "button";
    publish.textContent = publication ? "已发布" : "发布";
    publish.disabled = Boolean(publication);
    publish.addEventListener("click", () => requestOutputPublish(output, delivery));
    const speedSelect = createSpeedPicker(output, true);
    const speedButton = document.createElement("button");
    speedButton.type = "button";
    speedButton.textContent = "另存变速版";
    speedButton.addEventListener("click", () => createSpeedVersion(output, speedSelect.dataset.value, speedButton));
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "剪辑台";
    edit.addEventListener("click", () => openVideoEditor(output, delivery));
    actions.append(download, edit, speedSelect, speedButton);
    if (CAN_PUBLISH) actions.append(publish);
    content.append(title, meta, actions);
    card.append(video, content);
    dom.historyDeliveryList.append(card);
  });
}

function openHistoryDeliveryModal() {
  if (!deliveryRowsFor(state.project).length) return;
  window.clearTimeout(state.historyDeliveryCloseTimer);
  selectHistoryDeliveryFilter("all");
  renderHistoryDeliveryModal();
  dom.historyDeliveryModal.hidden = false;
  dom.historyDeliveryModal.classList.remove("is-closing");
  window.requestAnimationFrame(() => {
    dom.historyDeliveryModal.classList.add("is-open");
  });
  document.body.classList.add("history-delivery-open");
  refreshIcons();
}

function projectEditorAssets(project) {
  return (Array.isArray(project?.assets) ? project.assets : [])
    .filter(item => item && !String(item.mime || "").startsWith("audio/"))
    .map(item => ({
      id: String(item.id || item.asset_id || item.url || item.name || ""),
      label: String(item.label || item.name || "未命名素材"),
      name: String(item.name || item.label || "未命名素材"),
      mime: String(item.mime || ""),
      url: String(item.url || ""),
      duration: Math.max(0.1, Number(item.duration) || 0.6),
    }))
    .filter(item => item.id);
}

function projectEditorAudioAssets(project) {
  return (Array.isArray(project?.assets) ? project.assets : [])
    .filter(item => item && String(item.mime || "").startsWith("audio/"))
    .map(item => ({
      id: String(item.id || item.asset_id || item.url || item.name || ""),
      label: String(item.label || item.name || "未命名音频"),
      name: String(item.name || item.label || "未命名音频"),
      mime: String(item.mime || ""),
      url: String(item.url || ""),
      duration: Math.max(0.1, Number(item.duration) || 0.6),
    }))
    .filter(item => item.id);
}

function editorExternalFiles(dataTransfer) {
  if (![...(dataTransfer?.types || [])].includes("Files")) return [];
  return [...(dataTransfer?.files || [])].filter(file => /^(?:image\/(?:png|jpeg|webp)|video\/(?:mp4|quicktime|webm)|audio\/(?:mpeg|mp3|wav|x-wav|mp4|x-m4a|m4a))$/.test(file.type));
}

async function uploadEditorFiles(fileList) {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft || !state.project?.id) return { visual: [], audio: [] };
  const files = [...(fileList || [])].filter(file => /^(?:image\/(?:png|jpeg|webp)|video\/(?:mp4|quicktime|webm)|audio\/(?:mpeg|mp3|wav|x-wav|mp4|x-m4a|m4a))$/.test(file.type)).slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  if (!files.length) {
    showToast("剪辑台支持 PNG/JPG/WebP、MP4/MOV/WebM 与 MP3/WAV/M4A");
    return { visual: [], audio: [] };
  }
  const attachments = [];
  for (const file of files) {
    const isImage = file.type.startsWith("image/");
    const sizeLimit = isImage ? 6 * 1024 * 1024 : 40 * 1024 * 1024;
    if (file.size > sizeLimit) {
      showToast(`${file.name} 超过 ${isImage ? "6MB" : "40MB"}`);
      continue;
    }
    attachments.push({
      label: file.name,
      name: file.name,
      mime: file.type,
      dataUrl: await fileToDataUrl(file),
    });
  }
  if (!attachments.length) return { visual: [], audio: [] };
  const response = await fetch(`/api/projects/${state.project.id}/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attachments }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "外部素材导入失败");
  const items = Array.isArray(data.items) ? data.items : [];
  state.project.assets = [...(state.project.assets || []), ...items];
  const visual = projectEditorAssets({ assets: items });
  const audio = projectEditorAudioAssets({ assets: items });
  const appendUnique = (current, incoming) => {
    const seen = new Set(current.map(item => item.id));
    return [...current, ...incoming.filter(item => !seen.has(item.id))];
  };
  draft.assets = appendUnique(draft.assets, visual);
  draft.audioAssets = appendUnique(draft.audioAssets, audio);
  renderVideoEditor();
  return { visual, audio };
}

async function importEditorFiles(fileList, { target = "overlay", clipId = "", time = null } = {}) {
  try {
    const draft = dom.videoEditorModal?.__editorDraft;
    if (!draft) return;
    const { visual, audio } = await uploadEditorFiles(fileList);
    const dropTime = Number(time ?? draft.playhead);
    if (target === "overlay") {
      visual.forEach((asset, index) => addEditorOverlay(asset.id, dropTime + index * 0.15));
      audio.forEach((asset, index) => addEditorSoundEffect("asset", asset.id, dropTime + index * 0.15));
      const total = visual.length + audio.length;
      if (total) showToast(`已导入 ${visual.length ? `${visual.length} 个画中画` : ""}${visual.length && audio.length ? "和" : ""}${audio.length ? `${audio.length} 个音效` : ""}`);
      return;
    }
    if (target === "clip" && clipId && visual.length) {
      replaceEditorClipAsset(clipId, visual[0].id, { announce: false });
      showToast(`已导入并替换「${visual[0].label}」`);
      return;
    }
    if (target === "bgm" && audio.length) {
      commitEditorMutation(current => { current.bgmSelection = `asset:${audio[0].id}`; });
      showToast(`已导入并使用配乐「${audio[0].label}」`);
      return;
    }
    if (target === "sfx" && audio.length) {
      audio.forEach((asset, index) => addEditorSoundEffect("asset", asset.id, dropTime + index * 0.15));
      showToast(`已导入并添加 ${audio.length} 个音效`);
      return;
    }
    showToast(`已导入 ${visual.length + audio.length} 个项目素材`);
  } catch (error) {
    showAttachmentError(error, "外部素材导入失败，请重试");
  }
}

function formatEditorTime(value) {
  const safe = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(safe / 60);
  const seconds = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function editorSnapshot(draft) {
  return JSON.stringify({
    clips: draft.clips,
    overlays: draft.overlays,
    subtitleEffect: draft.subtitleEffect,
    bgmSelection: draft.bgmSelection,
    narrationVolume: draft.narrationVolume,
    bgmVolume: draft.bgmVolume,
    soundEffects: draft.soundEffects,
    selected: draft.selected,
    playhead: draft.playhead,
  });
}

function restoreEditorSnapshot(draft, snapshot) {
  const parsed = JSON.parse(snapshot);
  draft.clips = parsed.clips || [];
  draft.overlays = parsed.overlays || [];
  draft.subtitleEffect = String(parsed.subtitleEffect || "");
  draft.bgmSelection = String(parsed.bgmSelection || "keep");
  draft.narrationVolume = Math.max(0, Math.min(2, Number(parsed.narrationVolume ?? 1)));
  draft.bgmVolume = Math.max(0, Math.min(1, Number(parsed.bgmVolume ?? 0.12)));
  draft.soundEffects = Array.isArray(parsed.soundEffects) ? parsed.soundEffects : [];
  draft.selected = parsed.selected || null;
  draft.playhead = Math.max(0, Number(parsed.playhead) || 0);
}

function commitEditorMutation(callback) {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft) return;
  draft.history.push(editorSnapshot(draft));
  draft.history = draft.history.slice(-80);
  draft.future = [];
  callback(draft);
  renderVideoEditor();
}

function editorClipLayout(draft) {
  let start = 0;
  const rows = draft.clips.map((clip, index) => {
    const duration = Math.max(0.25, Number(clip.duration) || 0.25);
    const row = { clip, index, start, end: start + duration, duration };
    start += duration;
    return row;
  });
  return { rows, total: Math.max(0.25, start) };
}

function selectedEditorEntity(draft) {
  if (!draft?.selected) return null;
  if (["narration", "bgm"].includes(draft.selected.type)) {
    return { type: draft.selected.type, item: null };
  }
  if (draft.selected.type === "sound-effect") {
    const item = draft.soundEffects.find(row => row.id === draft.selected.id);
    return item ? { type: draft.selected.type, item } : null;
  }
  if (draft.selected.type === "subtitle") {
    const item = draft.clips.find(row => row.id === draft.selected.id);
    return item ? { type: draft.selected.type, item } : null;
  }
  const rows = draft.selected.type === "clip" ? draft.clips : draft.overlays;
  const item = rows.find(row => row.id === draft.selected.id);
  return item ? { type: draft.selected.type, item } : null;
}

function editorClipSeekTime(draft, clipId) {
  const row = editorClipLayout(draft).rows.find(item => item.clip.id === clipId);
  return row ? row.start + Math.min(0.08, row.duration / 2) : draft.playhead;
}

function selectEditorClip(clipId, { seek = true } = {}) {
  const draft = dom.videoEditorModal?.__editorDraft;
  const clip = draft?.clips.find(item => item.id === clipId);
  if (!draft || !clip) return;
  draft.selected = { type: "clip", id: clipId };
  if (seek) draft.playhead = editorClipSeekTime(draft, clipId);
  renderVideoEditor();
  if (seek) setEditorPlayhead(draft.playhead);
}

function replaceEditorClipAsset(clipId, assetId, { announce = true } = {}) {
  const draft = dom.videoEditorModal?.__editorDraft;
  const clip = draft?.clips.find(item => item.id === clipId);
  const asset = assetId ? draft?.assets.find(item => item.id === assetId) : null;
  if (!draft || !clip || (assetId && !asset)) return;
  commitEditorMutation(current => {
    const currentClip = current.clips.find(item => item.id === clipId);
    if (!currentClip) return;
    currentClip.replacementAssetId = assetId;
    current.selected = { type: "clip", id: clipId };
    current.playhead = editorClipSeekTime(current, clipId);
  });
  setEditorPlayhead(draft.playhead);
  if (announce) {
    showToast(asset ? `已用「${asset.label}」替换当前片段` : "已恢复当前片段的原镜头");
  }
}

function renderEditorAssets(draft) {
  dom.videoEditorAssetList.replaceChildren();
  dom.videoEditorAssetCount.textContent = `${draft.assets.length} 项`;
  if (!draft.assets.length) {
    const empty = document.createElement("p");
    empty.className = "video-editor-empty-assets";
    empty.textContent = "当前项目还没有图片或视频素材";
    dom.videoEditorAssetList.append(empty);
    return;
  }
  draft.assets.forEach(asset => {
    const card = document.createElement("article");
    card.className = "video-editor-asset-card";
    card.draggable = true;
    card.dataset.assetId = asset.id;
    card.title = "拖到主轨片段可替换画面，拖到 V2 可添加画中画";
    card.addEventListener("dragstart", event => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-xingzhen-asset", asset.id);
      card.classList.add("is-dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
    const preview = document.createElement(asset.mime.startsWith("video/") ? "video" : "img");
    preview.src = asset.url;
    preview.alt = asset.label;
    if (preview.tagName === "VIDEO") {
      preview.muted = true;
      preview.preload = "metadata";
    }
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = asset.label;
    const meta = document.createElement("span");
    meta.textContent = asset.mime.startsWith("video/") ? "视频素材" : "图片素材";
    info.append(name, meta);
    const actions = document.createElement("div");
    const replace = document.createElement("button");
    replace.type = "button";
    replace.textContent = "替换片段";
    replace.addEventListener("click", () => {
      const selected = selectedEditorEntity(draft);
      if (!selected || selected.type !== "clip") {
        showToast("请先在主轨选择一个片段");
        return;
      }
      replaceEditorClipAsset(selected.item.id, asset.id);
    });
    const overlay = document.createElement("button");
    overlay.type = "button";
    overlay.textContent = "画中画";
    overlay.addEventListener("click", () => addEditorOverlay(asset.id, draft.playhead));
    actions.append(replace, overlay);
    card.append(preview, info, actions);
    dom.videoEditorAssetList.append(card);
  });
}

function addEditorOverlay(assetId, start) {
  const draft = dom.videoEditorModal?.__editorDraft;
  const asset = draft?.assets.find(item => item.id === assetId);
  if (!draft || !asset) return;
  const total = editorClipLayout(draft).total;
  commitEditorMutation(current => {
    const overlay = {
      id: `overlay-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      assetId,
      label: asset.label,
      start: Math.max(0, Math.min(total - 0.5, Number(start) || 0)),
      duration: Math.min(4, total),
      position: "top-right",
      positionX: 1,
      positionY: 0,
      scale: 0.32,
      entryEffect: "fade",
      exitEffect: "fade",
    };
    current.overlays.push(overlay);
    current.selected = { type: "overlay", id: overlay.id };
  });
}

function addEditorSoundEffect(sourceType, sourceId, start) {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft) return;
  const source = sourceType === "catalog"
    ? draft.soundEffectCatalog.find(item => item.id === sourceId)
    : draft.audioAssets.find(item => item.id === sourceId);
  if (!source) return;
  const total = editorClipLayout(draft).total;
  commitEditorMutation(current => {
    const effect = {
      id: `sfx-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      sourceType,
      sourceId,
      label: String(source.name || source.label || "音效"),
      start: Math.max(0, Math.min(total - 0.1, Number(start) || 0)),
      duration: Math.max(0.1, Math.min(total, Number(source.duration) || 0.6)),
      volume: 0.72,
    };
    current.soundEffects.push(effect);
    current.selected = { type: "sound-effect", id: effect.id };
  });
}

function editorSubtitleText(clip) {
  return String(clip?.subtitle || clip?.narrationExcerpt || clip?.title || "").trim();
}

function editorSubtitleEffectClass(value) {
  if (value === "逐字高亮") return "is-word-highlight";
  if (value === "简洁淡入") return "is-fade";
  if (value === "关键词放大") return "is-keyword-pop";
  return "";
}

function editorTransitionLabel(value) {
  return ({
    fade: "淡化",
    dissolve: "溶解",
    slideleft: "左滑",
    wipeleft: "擦除",
    circleopen: "圆形",
  })[value] || "淡化";
}

function editorBgmLabel(draft) {
  const value = String(draft.bgmSelection || "keep");
  if (value === "none") return "无配乐";
  if (value === "keep") return `原配乐 · ${draft.currentBgm?.name || "保持现状"}`;
  if (value.startsWith("catalog:")) {
    const id = value.slice("catalog:".length);
    return draft.bgmCatalog.find(item => item.id === id)?.name || "配乐库音乐";
  }
  if (value.startsWith("asset:")) {
    const id = value.slice("asset:".length);
    return draft.audioAssets.find(item => item.id === id)?.label || "项目音频";
  }
  return "保持原配乐";
}

function renderEditorBgmOptions(draft) {
  if (!dom.videoEditorBgm) return;
  dom.videoEditorBgm.replaceChildren();
  const keep = document.createElement("option");
  keep.value = "keep";
  keep.textContent = `保持原配乐${draft.currentBgm?.name ? ` · ${draft.currentBgm.name}` : ""}`;
  const none = document.createElement("option");
  none.value = "none";
  none.textContent = "不使用 BGM";
  dom.videoEditorBgm.append(keep, none);
  if (draft.bgmCatalog.length) {
    const catalogGroup = document.createElement("optgroup");
    catalogGroup.label = "平台配乐库";
    draft.bgmCatalog.forEach(track => {
      const option = document.createElement("option");
      option.value = `catalog:${track.id}`;
      option.textContent = track.name;
      catalogGroup.append(option);
    });
    dom.videoEditorBgm.append(catalogGroup);
  }
  if (draft.audioAssets.length) {
    const assetGroup = document.createElement("optgroup");
    assetGroup.label = "项目音频";
    draft.audioAssets.forEach(asset => {
      const option = document.createElement("option");
      option.value = `asset:${asset.id}`;
      option.textContent = asset.label;
      assetGroup.append(option);
    });
    dom.videoEditorBgm.append(assetGroup);
  }
  dom.videoEditorBgm.value = draft.bgmSelection || "keep";
  if (dom.videoEditorBgm.value !== (draft.bgmSelection || "keep")) dom.videoEditorBgm.value = "keep";
}

function renderEditorSfxOptions(draft) {
  if (!dom.videoEditorSfx) return;
  const previous = dom.videoEditorSfx.value;
  dom.videoEditorSfx.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "选择一个音效";
  dom.videoEditorSfx.append(placeholder);
  if (draft.soundEffectCatalog.length) {
    const catalogGroup = document.createElement("optgroup");
    catalogGroup.label = "平台基础音效 · CC0";
    draft.soundEffectCatalog.forEach(effect => {
      const option = document.createElement("option");
      option.value = `catalog:${effect.id}`;
      option.textContent = effect.name;
      catalogGroup.append(option);
    });
    dom.videoEditorSfx.append(catalogGroup);
  }
  if (draft.audioAssets.length) {
    const projectGroup = document.createElement("optgroup");
    projectGroup.label = "项目音频";
    draft.audioAssets.forEach(asset => {
      const option = document.createElement("option");
      option.value = `asset:${asset.id}`;
      option.textContent = asset.label;
      projectGroup.append(option);
    });
    dom.videoEditorSfx.append(projectGroup);
  }
  dom.videoEditorSfx.value = [...dom.videoEditorSfx.options].some(item => item.value === previous)
    ? previous
    : (dom.videoEditorSfx.options[1]?.value || "");
  dom.videoEditorSfxPreview.disabled = !dom.videoEditorSfx.value;
  dom.videoEditorSfxAdd.disabled = !dom.videoEditorSfx.value;
}

function selectedEditorSfxSource(draft) {
  const [sourceType, ...idParts] = String(dom.videoEditorSfx?.value || "").split(":");
  const sourceId = idParts.join(":");
  if (!sourceId || !["catalog", "asset"].includes(sourceType)) return null;
  const source = sourceType === "catalog"
    ? draft.soundEffectCatalog.find(item => item.id === sourceId)
    : draft.audioAssets.find(item => item.id === sourceId);
  return source ? { sourceType, sourceId, source } : null;
}

function previewEditorSoundEffect() {
  const draft = dom.videoEditorModal?.__editorDraft;
  const selected = selectedEditorSfxSource(draft);
  if (!draft || !selected) return;
  const url = String(selected.source.url || "");
  if (!url) {
    showToast("当前音效没有可试听文件");
    return;
  }
  const player = new Audio(url);
  player.volume = 0.78;
  void player.play().catch(() => showToast("浏览器暂时无法播放该音效"));
}

function applyEditorPipPreviewEffect(item, overlay, playhead) {
  const duration = Math.max(0.5, Number(overlay.duration) || 0.5);
  const elapsed = Math.max(0, playhead - Number(overlay.start || 0));
  const remaining = Math.max(0, duration - elapsed);
  const windowSize = Math.min(0.35, duration / 3);
  const showPausedBoundary = Boolean(dom.videoEditorPreview?.paused) && elapsed <= 0.01;
  let opacity = 1;
  let transform = "translate(0, 0)";
  if (!showPausedBoundary && elapsed < windowSize) {
    const progress = Math.max(0, Math.min(1, elapsed / windowSize));
    if (overlay.entryEffect === "fade") opacity = progress;
    if (overlay.entryEffect === "slide-left") transform = `translateX(${(1 - progress) * 120}%)`;
    if (overlay.entryEffect === "slide-up") transform = `translateY(${(1 - progress) * 120}%)`;
  }
  if (remaining < windowSize) {
    const progress = Math.max(0, Math.min(1, 1 - remaining / windowSize));
    if (overlay.exitEffect === "fade") opacity = Math.min(opacity, 1 - progress);
    if (overlay.exitEffect === "slide-left") transform = `translateX(${-progress * 120}%)`;
    if (overlay.exitEffect === "slide-up") transform = `translateY(${-progress * 120}%)`;
  }
  item.style.opacity = String(opacity);
  item.style.setProperty("--pip-effect-transform", transform);
}

function syncEditorOverlayVideo(media, overlay, draft) {
  if (!(media instanceof HTMLVideoElement)) return;
  const offset = Math.max(0, draft.playhead - Number(overlay.start || 0));
  if (Number.isFinite(media.duration) && media.duration > 0) {
    const target = Math.min(media.duration - 0.05, offset % media.duration);
    if (Math.abs((media.currentTime || 0) - target) > 0.35) media.currentTime = target;
  }
  if (dom.videoEditorPreview?.paused) {
    media.pause();
  } else {
    void media.play().catch(() => {});
  }
}

function syncEditorReplacementPreview(media, row, draft) {
  if (!(media instanceof HTMLVideoElement) || !row) return;
  const offset = Math.max(0, draft.playhead - row.start + Number(row.clip.trimStart || 0));
  if (Number.isFinite(media.duration) && media.duration > 0) {
    const target = Math.min(Math.max(0, media.duration - 0.05), offset % media.duration);
    if (Math.abs((media.currentTime || 0) - target) > 0.35) media.currentTime = target;
  }
  if (dom.videoEditorPreview?.paused) media.pause();
  else void media.play().catch(() => {});
}

function positionEditorPipPreview(item, overlay) {
  if (!item || overlay.position !== "custom") return;
  const canvas = dom.videoEditorPreviewCanvas;
  const availableX = Math.max(0, (canvas?.clientWidth || 0) - item.offsetWidth);
  const availableY = Math.max(0, (canvas?.clientHeight || 0) - item.offsetHeight);
  item.style.left = `${Math.max(0, Math.min(1, Number(overlay.positionX) || 0)) * availableX}px`;
  item.style.top = `${Math.max(0, Math.min(1, Number(overlay.positionY) || 0)) * availableY}px`;
  item.style.right = "auto";
  item.style.bottom = "auto";
  item.style.setProperty("--pip-position-transform", "translate(0, 0)");
}

function startEditorPipCanvasDrag(event, overlayId, item) {
  if (event.button !== 0 || event.target.closest(".video-editor-pip-resize-handle")) return;
  event.preventDefault();
  event.stopPropagation();
  const draft = dom.videoEditorModal?.__editorDraft;
  const overlay = draft?.overlays.find(entry => entry.id === overlayId);
  if (!draft || !overlay || !dom.videoEditorPreviewCanvas) return;
  const before = editorSnapshot(draft);
  const canvasRect = dom.videoEditorPreviewCanvas.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const pointerOffsetX = event.clientX - itemRect.left;
  const pointerOffsetY = event.clientY - itemRect.top;
  draft.selected = { type: "overlay", id: overlayId };
  item.classList.add("is-selected", "is-dragging");
  item.setPointerCapture?.(event.pointerId);
  const onMove = moveEvent => {
    const availableX = Math.max(1, canvasRect.width - item.offsetWidth);
    const availableY = Math.max(1, canvasRect.height - item.offsetHeight);
    const left = Math.max(0, Math.min(availableX, moveEvent.clientX - canvasRect.left - pointerOffsetX));
    const top = Math.max(0, Math.min(availableY, moveEvent.clientY - canvasRect.top - pointerOffsetY));
    overlay.position = "custom";
    overlay.positionX = left / availableX;
    overlay.positionY = top / availableY;
    item.dataset.position = "custom";
    item.style.left = `${left}px`;
    item.style.top = `${top}px`;
    item.style.right = "auto";
    item.style.bottom = "auto";
    item.style.setProperty("--pip-position-transform", "translate(0, 0)");
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    item.classList.remove("is-dragging");
    if (editorSnapshot(draft) !== before) {
      draft.history.push(before);
      draft.history = draft.history.slice(-80);
      draft.future = [];
    }
    renderVideoEditor();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
  renderVideoEditorInspector();
}

function startEditorPipCanvasResize(event, overlayId, item) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const draft = dom.videoEditorModal?.__editorDraft;
  const overlay = draft?.overlays.find(entry => entry.id === overlayId);
  if (!draft || !overlay || !dom.videoEditorPreviewCanvas) return;
  const before = editorSnapshot(draft);
  const canvasRect = dom.videoEditorPreviewCanvas.getBoundingClientRect();
  const startX = event.clientX;
  const originalScale = Number(overlay.scale) || 0.32;
  draft.selected = { type: "overlay", id: overlayId };
  item.classList.add("is-selected", "is-resizing");
  item.setPointerCapture?.(event.pointerId);
  const onMove = moveEvent => {
    overlay.scale = Math.max(0.1, Math.min(0.65, originalScale + (moveEvent.clientX - startX) / canvasRect.width));
    item.style.width = `${overlay.scale * 100}%`;
    if (overlay.position === "custom") {
      positionEditorPipPreview(item, overlay);
    }
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    item.classList.remove("is-resizing");
    if (editorSnapshot(draft) !== before) {
      draft.history.push(before);
      draft.history = draft.history.slice(-80);
      draft.future = [];
    }
    renderVideoEditor();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
  renderVideoEditorInspector();
}

function renderVideoEditorPreviewLayers() {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft || !dom.videoEditorOverlayPreviewLayer || !dom.videoEditorSubtitlePreview || !dom.videoEditorReplacementPreviewLayer) return;
  const layout = editorClipLayout(draft);
  const activeRow = layout.rows.find(row => (
    draft.playhead >= row.start
    && (draft.playhead < row.end || (row === layout.rows.at(-1) && draft.playhead === row.end))
  ));
  const replacementAsset = activeRow?.clip.replacementAssetId
    ? draft.assets.find(item => item.id === activeRow.clip.replacementAssetId)
    : null;
  const replacementSignature = replacementAsset
    ? `${activeRow.clip.id}:${replacementAsset.id}:${replacementAsset.url}`
    : "";
  if (dom.videoEditorReplacementPreviewLayer.dataset.signature !== replacementSignature) {
    dom.videoEditorReplacementPreviewLayer.dataset.signature = replacementSignature;
    dom.videoEditorReplacementPreviewLayer.replaceChildren();
    if (replacementAsset?.url) {
      const media = document.createElement(String(replacementAsset.mime || "").startsWith("video/") ? "video" : "img");
      media.src = replacementAsset.url;
      media.setAttribute("aria-label", `替换画面：${replacementAsset.label || "项目素材"}`);
      if (media instanceof HTMLVideoElement) {
        media.muted = true;
        media.loop = true;
        media.playsInline = true;
        media.preload = "metadata";
        media.addEventListener("loadedmetadata", () => syncEditorReplacementPreview(media, activeRow, draft), { once: true });
      } else {
        media.alt = replacementAsset.label || "替换画面";
      }
      dom.videoEditorReplacementPreviewLayer.append(media);
    }
  }
  const replacementMedia = dom.videoEditorReplacementPreviewLayer.querySelector("video");
  if (replacementMedia) syncEditorReplacementPreview(replacementMedia, activeRow, draft);
  const activeOverlays = draft.overlays.filter(overlay => (
    draft.playhead >= Number(overlay.start || 0)
    && draft.playhead < Number(overlay.start || 0) + Number(overlay.duration || 0)
  ));
  const overlaySignature = JSON.stringify(activeOverlays.map(overlay => [
    overlay.id,
    overlay.assetId,
    overlay.position,
    Number(overlay.positionX ?? 1),
    Number(overlay.positionY ?? 0),
    Number(overlay.scale || 0.32),
    overlay.entryEffect,
    overlay.exitEffect,
  ]));
  if (dom.videoEditorOverlayPreviewLayer.dataset.signature !== overlaySignature) {
    dom.videoEditorOverlayPreviewLayer.dataset.signature = overlaySignature;
    dom.videoEditorOverlayPreviewLayer.replaceChildren();
    activeOverlays.forEach(overlay => {
      const asset = draft.assets.find(item => item.id === overlay.assetId);
      if (!asset?.url) return;
      const item = document.createElement("div");
      item.className = "video-editor-pip-preview";
      item.dataset.overlayId = overlay.id;
      item.dataset.position = overlay.position || "top-right";
      const scale = Math.max(0.1, Math.min(0.65, Number(overlay.scale) || 0.32));
      item.style.width = `${scale * 100}%`;
      item.title = "拖动画中画；拖右下角缩放";
      item.addEventListener("pointerdown", event => startEditorPipCanvasDrag(event, overlay.id, item));
      const media = document.createElement(String(asset.mime || "").startsWith("video/") ? "video" : "img");
      media.src = asset.url;
      media.setAttribute("aria-label", overlay.label || asset.label || "画中画素材");
      if (media instanceof HTMLVideoElement) {
        media.muted = true;
        media.loop = true;
        media.playsInline = true;
        media.preload = "metadata";
        media.addEventListener("loadedmetadata", () => syncEditorOverlayVideo(media, overlay, draft), { once: true });
      } else {
        media.alt = overlay.label || asset.label || "画中画素材";
      }
      const resizeHandle = document.createElement("button");
      resizeHandle.type = "button";
      resizeHandle.className = "video-editor-pip-resize-handle";
      resizeHandle.setAttribute("aria-label", "缩放画中画");
      resizeHandle.addEventListener("pointerdown", event => startEditorPipCanvasResize(event, overlay.id, item));
      item.append(media, resizeHandle);
      dom.videoEditorOverlayPreviewLayer.append(item);
      positionEditorPipPreview(item, overlay);
    });
  }
  activeOverlays.forEach(overlay => {
    const item = [...dom.videoEditorOverlayPreviewLayer.children]
      .find(candidate => candidate.dataset.overlayId === overlay.id);
    if (item) {
      item.classList.toggle("is-selected", draft.selected?.type === "overlay" && draft.selected.id === overlay.id);
      positionEditorPipPreview(item, overlay);
      applyEditorPipPreviewEffect(item, overlay, draft.playhead);
    }
    const media = item?.querySelector("video");
    if (media) syncEditorOverlayVideo(media, overlay, draft);
  });
  const subtitleText = draft.subtitleEffect === "去掉字幕" ? "" : editorSubtitleText(activeRow?.clip);
  if (dom.videoEditorSubtitleReplaceMask) dom.videoEditorSubtitleReplaceMask.hidden = !subtitleText;
  dom.videoEditorSubtitlePreview.hidden = !subtitleText;
  dom.videoEditorSubtitlePreview.textContent = subtitleText;
  dom.videoEditorSubtitlePreview.className = `video-editor-subtitle-preview ${editorSubtitleEffectClass(draft.subtitleEffect)}`.trim();
}

function startEditorResize(event, type, id, edge) {
  event.preventDefault();
  event.stopPropagation();
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft) return;
  const rows = type === "clip"
    ? draft.clips
    : (type === "overlay" ? draft.overlays : draft.soundEffects);
  const item = rows.find(row => row.id === id);
  if (!item) return;
  const before = editorSnapshot(draft);
  const startX = event.clientX;
  const originalDuration = Number(item.duration) || 0.25;
  const originalStart = Number(item.start) || 0;
  const originalTrim = Number(item.trimStart) || 0;
  const onMove = moveEvent => {
    const delta = (moveEvent.clientX - startX) / draft.zoom;
    if (type === "clip" && edge === "start") {
      const nextTrim = Math.max(0, originalTrim + delta);
      const actualDelta = nextTrim - originalTrim;
      item.trimStart = nextTrim;
      item.duration = Math.max(0.25, originalDuration - actualDelta);
    } else if (["overlay", "sound-effect"].includes(type) && edge === "start") {
      const nextStart = Math.max(0, originalStart + delta);
      const actualDelta = nextStart - originalStart;
      item.start = nextStart;
      item.duration = Math.max(type === "sound-effect" ? 0.1 : 0.5, originalDuration - actualDelta);
    } else {
      item.duration = Math.max(type === "clip" ? 0.25 : (type === "sound-effect" ? 0.1 : 0.5), originalDuration + delta);
    }
    renderVideoEditorTimeline();
    renderVideoEditorInspector();
    renderVideoEditorPreviewLayers();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (editorSnapshot(draft) !== before) {
      draft.history.push(before);
      draft.history = draft.history.slice(-80);
      draft.future = [];
    }
    renderVideoEditor();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

function renderVideoEditorTimeline() {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft) return;
  const { rows, total } = editorClipLayout(draft);
  const canvasWidth = Math.max(880, Math.ceil(total * draft.zoom) + 32);
  dom.videoEditorTimelineCanvas.style.width = `${canvasWidth}px`;
  dom.videoEditorRuler.replaceChildren();
  for (let second = 0; second <= Math.ceil(total); second += 1) {
    const tick = document.createElement("span");
    tick.className = second % 5 === 0 ? "is-major" : "";
    tick.style.left = `${second * draft.zoom}px`;
    tick.textContent = second % 5 === 0 ? formatEditorTime(second) : "";
    dom.videoEditorRuler.append(tick);
  }
  dom.videoEditorVideoTrack.replaceChildren();
  rows.forEach(({ clip, start, duration }, index) => {
    const block = document.createElement("article");
    block.className = "video-editor-timeline-clip";
    if (draft.selected?.type === "clip" && draft.selected.id === clip.id) block.classList.add("is-selected");
    if (clip.replacementAssetId) block.classList.add("has-replacement");
    block.style.left = `${start * draft.zoom}px`;
    block.style.width = `${Math.max(28, duration * draft.zoom)}px`;
    block.draggable = true;
    block.tabIndex = 0;
    block.dataset.clipId = clip.id;
    block.addEventListener("click", () => selectEditorClip(clip.id));
    block.addEventListener("dragover", event => {
      const types = [...(event.dataTransfer?.types || [])];
      if (!types.includes("application/x-xingzhen-asset") && !types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      block.classList.add("is-drop-target");
    });
    block.addEventListener("dragleave", () => block.classList.remove("is-drop-target"));
    block.addEventListener("drop", async event => {
      const assetId = event.dataTransfer?.getData("application/x-xingzhen-asset");
      const files = editorExternalFiles(event.dataTransfer);
      if (!assetId && !files.length) return;
      event.preventDefault();
      event.stopPropagation();
      block.classList.remove("is-drop-target");
      if (files.length) await importEditorFiles(files, { target: "clip", clipId: clip.id });
      else replaceEditorClipAsset(clip.id, assetId);
    });
    block.addEventListener("dragstart", event => {
      if (event.target.closest(".video-editor-trim-handle")) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-xingzhen-clip", clip.id);
    });
    const startHandle = document.createElement("span");
    startHandle.className = "video-editor-trim-handle is-start";
    startHandle.addEventListener("pointerdown", event => startEditorResize(event, "clip", clip.id, "start"));
    const body = document.createElement("div");
    const number = document.createElement("i");
    number.textContent = String(index + 1).padStart(2, "0");
    const title = document.createElement("strong");
    title.textContent = clip.title || `镜头 ${clip.sourceSceneNumber}`;
    const meta = document.createElement("span");
    meta.textContent = `${duration.toFixed(1)}s · ${editorTransitionLabel(clip.transition)}${clip.replacementAssetId ? " · 已替换" : ""}`;
    body.append(number, title, meta);
    const endHandle = document.createElement("span");
    endHandle.className = "video-editor-trim-handle is-end";
    endHandle.addEventListener("pointerdown", event => startEditorResize(event, "clip", clip.id, "end"));
    block.append(startHandle, body, endHandle);
    dom.videoEditorVideoTrack.append(block);
  });
  dom.videoEditorOverlayTrack.replaceChildren();
  draft.overlays.forEach(overlay => {
    const block = document.createElement("article");
    block.className = "video-editor-timeline-overlay";
    if (draft.selected?.type === "overlay" && draft.selected.id === overlay.id) block.classList.add("is-selected");
    block.style.left = `${overlay.start * draft.zoom}px`;
    block.style.width = `${Math.max(36, overlay.duration * draft.zoom)}px`;
    block.draggable = true;
    block.addEventListener("dragstart", event => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-xingzhen-overlay", overlay.id);
    });
    block.addEventListener("click", () => {
      draft.selected = { type: "overlay", id: overlay.id };
      renderVideoEditor();
    });
    const startHandle = document.createElement("span");
    startHandle.className = "video-editor-trim-handle is-start";
    startHandle.addEventListener("pointerdown", event => startEditorResize(event, "overlay", overlay.id, "start"));
    const label = document.createElement("strong");
    label.textContent = overlay.label || "画中画";
    const endHandle = document.createElement("span");
    endHandle.className = "video-editor-trim-handle is-end";
    endHandle.addEventListener("pointerdown", event => startEditorResize(event, "overlay", overlay.id, "end"));
    block.append(startHandle, label, endHandle);
    dom.videoEditorOverlayTrack.append(block);
  });
  dom.videoEditorSubtitleTrack.replaceChildren();
  if (draft.subtitleEffect !== "去掉字幕") {
    rows.forEach(({ clip, start, duration }) => {
      const text = editorSubtitleText(clip);
      if (!text) return;
      const subtitle = document.createElement("button");
      subtitle.type = "button";
      subtitle.className = `video-editor-caption-track-block ${editorSubtitleEffectClass(draft.subtitleEffect)}`.trim();
      if (draft.selected?.type === "subtitle" && draft.selected.id === clip.id) subtitle.classList.add("is-selected");
      subtitle.style.left = `${start * draft.zoom}px`;
      subtitle.style.width = `${Math.max(28, duration * draft.zoom)}px`;
      subtitle.title = text;
      const label = document.createElement("span");
      label.textContent = text;
      subtitle.append(label);
      subtitle.tabIndex = 0;
      subtitle.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        draft.selected = { type: "subtitle", id: clip.id };
        draft.playhead = editorClipSeekTime(draft, clip.id);
        renderVideoEditor();
        setEditorPlayhead(draft.playhead);
      });
      dom.videoEditorSubtitleTrack.append(subtitle);
    });
  }
  dom.videoEditorAudioTrack.replaceChildren();
  const narration = document.createElement("div");
  narration.className = "video-editor-static-track-block is-audio";
  narration.classList.toggle("is-selected", draft.selected?.type === "narration");
  narration.style.width = `${Math.max(40, total * draft.zoom)}px`;
  narration.innerHTML = `<i data-lucide="audio-waveform"></i><span>口播 · ${Math.round(draft.narrationVolume * 100)}%</span>`;
  narration.tabIndex = 0;
  narration.addEventListener("click", () => {
    draft.selected = { type: "narration", id: "narration" };
    renderVideoEditor();
  });
  dom.videoEditorAudioTrack.append(narration);
  dom.videoEditorBgmTrack.replaceChildren();
  const bgm = document.createElement("div");
  bgm.className = "video-editor-static-track-block is-bgm";
  bgm.classList.toggle("is-selected", draft.selected?.type === "bgm");
  bgm.style.width = `${Math.max(40, total * draft.zoom)}px`;
  bgm.innerHTML = `<i data-lucide="music-2"></i><span>${editorBgmLabel(draft)} · ${Math.round(draft.bgmVolume * 100)}%</span>`;
  bgm.tabIndex = 0;
  bgm.addEventListener("click", () => {
    draft.selected = { type: "bgm", id: "bgm" };
    renderVideoEditor();
  });
  dom.videoEditorBgmTrack.append(bgm);
  dom.videoEditorSfxTrack.replaceChildren();
  draft.soundEffects.forEach(effect => {
    const block = document.createElement("article");
    block.className = "video-editor-sfx-track-block";
    block.classList.toggle("is-selected", draft.selected?.type === "sound-effect" && draft.selected.id === effect.id);
    block.style.left = `${effect.start * draft.zoom}px`;
    block.style.width = `${Math.max(24, effect.duration * draft.zoom)}px`;
    block.draggable = true;
    block.dataset.soundEffectId = effect.id;
    block.addEventListener("dragstart", event => {
      if (event.target.closest(".video-editor-trim-handle")) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-xingzhen-sfx", effect.id);
    });
    block.addEventListener("click", () => {
      draft.selected = { type: "sound-effect", id: effect.id };
      draft.playhead = effect.start;
      renderVideoEditor();
      setEditorPlayhead(effect.start);
    });
    const startHandle = document.createElement("span");
    startHandle.className = "video-editor-trim-handle is-start";
    startHandle.addEventListener("pointerdown", event => startEditorResize(event, "sound-effect", effect.id, "start"));
    const label = document.createElement("strong");
    label.textContent = `${effect.label} · ${Math.round(effect.volume * 100)}%`;
    const endHandle = document.createElement("span");
    endHandle.className = "video-editor-trim-handle is-end";
    endHandle.addEventListener("pointerdown", event => startEditorResize(event, "sound-effect", effect.id, "end"));
    block.append(startHandle, label, endHandle);
    dom.videoEditorSfxTrack.append(block);
  });
  draft.playhead = Math.max(0, Math.min(total, draft.playhead));
  dom.videoEditorPlayhead.style.left = `${draft.playhead * draft.zoom}px`;
  dom.videoEditorTimecode.textContent = `${formatEditorTime(draft.playhead)} / ${formatEditorTime(total)}`;
  dom.videoEditorScrubber.max = String(total);
  dom.videoEditorScrubber.value = String(draft.playhead);
  refreshIcons();
}

function renderVideoEditorInspector() {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft) return;
  const selected = selectedEditorEntity(draft);
  dom.videoEditorClipInspector.hidden = selected?.type !== "clip";
  dom.videoEditorSubtitleInspector.hidden = selected?.type !== "subtitle";
  dom.videoEditorOverlayInspector.hidden = selected?.type !== "overlay";
  dom.videoEditorAudioInspector.hidden = !["narration", "bgm", "sound-effect"].includes(selected?.type);
  if (!selected) {
    dom.videoEditorSelectionTitle.textContent = "音频与字幕";
  } else if (selected.type === "clip") {
    const clip = selected.item;
    dom.videoEditorSelectionTitle.textContent = clip.title || `镜头 ${clip.sourceSceneNumber}`;
  } else if (selected.type === "subtitle") {
    const clip = selected.item;
    dom.videoEditorSelectionTitle.textContent = `字幕 · ${clip.title || `镜头 ${clip.sourceSceneNumber}`}`;
    dom.videoEditorSubtitleText.value = String(clip.subtitle || "");
  } else if (selected.type === "overlay") {
    const overlay = selected.item;
    dom.videoEditorSelectionTitle.textContent = overlay.label || "画中画";
    dom.videoEditorOverlayEntry.value = overlay.entryEffect || "fade";
    dom.videoEditorOverlayExit.value = overlay.exitEffect || "fade";
  } else if (selected.type === "narration") {
    dom.videoEditorSelectionTitle.textContent = "口播音轨";
    dom.videoEditorVolumeLabel.textContent = "口播音量";
    dom.videoEditorTrackVolume.max = "200";
    dom.videoEditorTrackVolume.value = String(Math.round(draft.narrationVolume * 100));
  } else if (selected.type === "bgm") {
    dom.videoEditorSelectionTitle.textContent = "BGM 配乐";
    dom.videoEditorVolumeLabel.textContent = "BGM 音量";
    dom.videoEditorTrackVolume.max = "100";
    dom.videoEditorTrackVolume.value = String(Math.round(draft.bgmVolume * 100));
  } else if (selected.type === "sound-effect") {
    dom.videoEditorSelectionTitle.textContent = selected.item.label || "音效";
    dom.videoEditorVolumeLabel.textContent = "音效音量";
    dom.videoEditorTrackVolume.max = "150";
    dom.videoEditorTrackVolume.value = String(Math.round(selected.item.volume * 100));
  }
  dom.videoEditorTrackVolumeValue.textContent = `${dom.videoEditorTrackVolume.value}%`;
  dom.videoEditorSubtitle.value = draft.subtitleEffect;
  renderEditorBgmOptions(draft);
  renderEditorSfxOptions(draft);
  dom.videoEditorBgmDelete.disabled = draft.bgmSelection === "none";
  dom.videoEditorUndo.disabled = !draft.history.length;
  dom.videoEditorRedo.disabled = !draft.future.length;
  dom.videoEditorDelete.disabled = !selected || ["narration", "subtitle"].includes(selected.type);
  dom.videoEditorSplit.disabled = selected?.type !== "clip";
}

function renderVideoEditor() {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft) return;
  renderEditorAssets(draft);
  renderVideoEditorTimeline();
  renderVideoEditorInspector();
  renderVideoEditorPreviewLayers();
}

function editorUndo() {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft?.history.length) return;
  draft.future.push(editorSnapshot(draft));
  restoreEditorSnapshot(draft, draft.history.pop());
  renderVideoEditor();
}

function editorRedo() {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft?.future.length) return;
  draft.history.push(editorSnapshot(draft));
  restoreEditorSnapshot(draft, draft.future.pop());
  renderVideoEditor();
}

function splitEditorClip() {
  const draft = dom.videoEditorModal?.__editorDraft;
  const selected = selectedEditorEntity(draft);
  if (!draft || selected?.type !== "clip") return;
  const { rows } = editorClipLayout(draft);
  const row = rows.find(item => item.clip.id === selected.item.id);
  const local = draft.playhead - row.start;
  if (local < 0.25 || row.duration - local < 0.25) {
    showToast("请把播放头移到片段内部再分割");
    return;
  }
  commitEditorMutation(current => {
    const index = current.clips.findIndex(item => item.id === selected.item.id);
    const original = current.clips[index];
    const second = {
      ...original,
      id: `${original.id}-split-${Date.now()}`,
      duration: original.duration - local,
      trimStart: Number(original.trimStart || 0) + local,
      title: `${original.title} · 下半段`,
    };
    original.duration = local;
    current.clips.splice(index + 1, 0, second);
    current.selected = { type: "clip", id: second.id };
  });
}

function deleteEditorSelection() {
  const draft = dom.videoEditorModal?.__editorDraft;
  const selected = selectedEditorEntity(draft);
  if (!draft || !selected) return;
  if (selected.type === "clip" && draft.clips.length <= 1) {
    showToast("主轨至少需要保留一个片段");
    return;
  }
  commitEditorMutation(current => {
    if (selected.type === "clip") current.clips = current.clips.filter(item => item.id !== selected.item.id);
    else if (selected.type === "overlay") current.overlays = current.overlays.filter(item => item.id !== selected.item.id);
    else if (selected.type === "sound-effect") current.soundEffects = current.soundEffects.filter(item => item.id !== selected.item.id);
    else if (selected.type === "bgm") current.bgmSelection = "none";
    current.selected = null;
  });
}

let videoEditorPlaybackFrame = 0;

function stopVideoEditorPlaybackClock() {
  if (!videoEditorPlaybackFrame) return;
  window.cancelAnimationFrame(videoEditorPlaybackFrame);
  videoEditorPlaybackFrame = 0;
}

function syncVideoEditorPlaybackClock() {
  const draft = dom.videoEditorModal?.__editorDraft;
  const preview = dom.videoEditorPreview;
  const duration = Number(preview?.duration || 0);
  if (!draft || !preview || !Number.isFinite(duration) || duration <= 0) return;
  setEditorPlayhead(preview.currentTime / duration * editorClipLayout(draft).total, false);
}

function startVideoEditorPlaybackClock() {
  stopVideoEditorPlaybackClock();
  const tick = () => {
    const preview = dom.videoEditorPreview;
    if (!preview || preview.paused || preview.ended || dom.videoEditorModal?.hidden) {
      videoEditorPlaybackFrame = 0;
      syncVideoEditorPlaybackClock();
      return;
    }
    syncVideoEditorPlaybackClock();
    videoEditorPlaybackFrame = window.requestAnimationFrame(tick);
  };
  videoEditorPlaybackFrame = window.requestAnimationFrame(tick);
}

function closeVideoEditor() {
  if (!dom.videoEditorModal) return;
  stopVideoEditorPlaybackClock();
  dom.videoEditorModal.classList.remove("is-open", "is-file-target");
  window.setTimeout(() => {
    dom.videoEditorModal.hidden = true;
    dom.videoEditorPreview?.pause();
  }, 180);
  document.body.classList.remove("video-editor-open");
}

async function openVideoEditor(output, delivery) {
  if (!dom.videoEditorModal || !output || !state.project) return;
  dom.videoEditorModal.hidden = false;
  dom.videoEditorModal.classList.add("is-loading");
  window.requestAnimationFrame(() => dom.videoEditorModal.classList.add("is-open"));
  document.body.classList.add("video-editor-open");
  try {
    const response = await fetch(`/api/projects/${state.project.id}/video-editor?outputId=${encodeURIComponent(output.id)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "剪辑时间线加载失败");
    const clips = (data.clips || []).map(clip => ({ ...clip, duration: Number(clip.duration), trimStart: Number(clip.trimStart || 0), transition: String(clip.transition || "fade") }));
    const assets = (data.assets || projectEditorAssets(state.project)).map(asset => ({ ...asset, id: String(asset.id) }));
    dom.videoEditorModal.__editorDraft = {
      output,
      delivery,
      clips,
      assets,
      audioAssets: (data.audioAssets || projectEditorAudioAssets(state.project)).map(asset => ({ ...asset, id: String(asset.id) })),
      bgmCatalog: (data.bgmCatalog || []).map(track => ({ id: String(track.id), name: String(track.name || "未命名配乐"), source: String(track.source || "") })),
      soundEffectCatalog: (data.soundEffectCatalog || []).map(effect => ({
        id: String(effect.id),
        name: String(effect.name || "未命名音效"),
        url: String(effect.url || ""),
        duration: Math.max(0.1, Number(effect.duration) || 0.6),
        license: String(effect.license || ""),
      })),
      currentBgm: data.currentBgm || output.bgm || null,
      bgmSelection: String(data.bgmSelection || "keep"),
      narrationVolume: Math.max(0, Math.min(2, Number(data.narrationVolume ?? 1))),
      bgmVolume: Math.max(0, Math.min(1, Number(data.bgmVolume ?? 0.12))),
      soundEffects: (data.soundEffects || []).map((item, index) => ({
        id: String(item.id || `sfx-${index}-${Date.now()}`),
        sourceType: String(item.source_type || item.sourceType || "catalog"),
        sourceId: String(item.source_id || item.sourceId || ""),
        label: String(item.label || "音效"),
        start: Math.max(0, Number(item.start || 0)),
        duration: Math.max(0.1, Number(item.duration || 0.6)),
        volume: Math.max(0, Math.min(1.5, Number(item.volume ?? 0.72))),
      })).filter(item => item.sourceId),
      overlays: (data.overlays || []).map((item, index) => ({
        id: String(item.id || `overlay-${index}-${Date.now()}`),
        assetId: String(item.asset_id || item.assetId || ""),
        label: assets.find(asset => asset.id === String(item.asset_id || item.assetId || ""))?.label || "画中画",
        start: Number(item.start || 0),
        duration: Number(item.duration || 3.6),
        position: String(item.position || "top-right"),
        positionX: Math.max(0, Math.min(1, Number(item.position_x ?? item.positionX ?? 1))),
        positionY: Math.max(0, Math.min(1, Number(item.position_y ?? item.positionY ?? 0))),
        scale: Number(item.scale || 0.32),
        entryEffect: String(item.entry_effect || item.entryEffect || "fade"),
        exitEffect: String(item.exit_effect || item.exitEffect || "fade"),
      })).filter(item => item.assetId),
      subtitleEffect: String(data.subtitleEffect || ""),
      selected: clips[0] ? { type: "clip", id: clips[0].id } : null,
      playhead: 0,
      zoom: Number(dom.videoEditorZoom.value || 56),
      history: [],
      future: [],
    };
    if (!clips.length) throw new Error("当前成片没有可编辑的镜头源文件");
  } catch (error) {
    closeVideoEditor();
    showToast(error.message || "剪辑台加载失败");
    return;
  } finally {
    dom.videoEditorModal.classList.remove("is-loading");
  }
  dom.videoEditorPreview.src = String(output.url || output.downloadUrl || "");
  const aspect = String(output.aspectRatio || state.project?.plan?.aspect_ratio || "16:9").split(":").map(Number);
  if (aspect.length === 2 && aspect.every(value => Number.isFinite(value) && value > 0)) {
    dom.videoEditorPreviewCanvas.style.aspectRatio = `${aspect[0]} / ${aspect[1]}`;
  }
  renderVideoEditor();
  refreshIcons();
}

async function submitVideoEditorDraft() {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft || state.busy) return;
  if (!draft.history.length) {
    showToast("请先调整一项剪辑设置");
    return;
  }
  dom.videoEditorSubmit.disabled = true;
  dom.videoEditorSubmit.classList.add("is-busy");
  try {
    const response = await fetch(`/api/projects/${state.project.id}/timeline-revision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outputId: draft.output.id,
        clips: draft.clips.map(clip => ({
          id: clip.id,
          sourceFile: clip.sourceFile,
          sourceSceneNumber: clip.sourceSceneNumber,
          segmentNumber: clip.segmentNumber || 1,
          segmentCount: clip.segmentCount || 1,
          duration: Number(clip.duration),
          trimStart: Number(clip.trimStart || 0),
          subtitle: String(clip.subtitle || ""),
          replacementAssetId: String(clip.replacementAssetId || ""),
          transition: String(clip.transition || "fade"),
        })),
        overlays: draft.overlays.map(item => ({
          assetId: item.assetId,
          start: Number(item.start),
          duration: Number(item.duration),
          position: item.position,
          positionX: Number(item.positionX ?? 1),
          positionY: Number(item.positionY ?? 0),
          scale: Number(item.scale),
          entryEffect: String(item.entryEffect || "fade"),
          exitEffect: String(item.exitEffect || "fade"),
        })),
        soundEffects: draft.soundEffects.map(item => ({
          id: item.id,
          sourceType: item.sourceType,
          sourceId: item.sourceId,
          label: item.label,
          start: Number(item.start),
          duration: Number(item.duration),
          volume: Number(item.volume),
        })),
        bgmSelection: String(draft.bgmSelection || "keep"),
        narrationVolume: Number(draft.narrationVolume),
        bgmVolume: Number(draft.bgmVolume),
        subtitleEffect: draft.subtitleEffect,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "剪辑修改提交失败");
    closeVideoEditor();
    if (data.project) {
      state.project = data.project;
      renderProject(data.project);
    }
    showToast("已保存剪辑，正在复用原素材生成新版");
  } catch (error) {
    showToast(error.message || "剪辑修改提交失败");
  } finally {
    dom.videoEditorSubmit.disabled = false;
    dom.videoEditorSubmit.classList.remove("is-busy");
  }
}

function renderDelivery(project) {
  const outputs = project.outputs || [];
  const publishedDeliveryId = String(project?._integration?.publishedDeliveryId || "");
  const publishedCount = publishedCountFor(project);
  const deliveries = deliveryRowsFor(project);
  if (state.deliveryProjectId !== project.id) {
    state.deliveryProjectId = project.id;
    state.deliveryCollapsed = false;
  }
  // Project progress updates change project.updatedAt on every poll. Reload the
  // player only when an output itself changes, otherwise an active task makes
  // an already rendered video repeatedly blank and restart.
  const mediaSignature = JSON.stringify(
    outputs.map((item) => [
      item.id || "",
      item.url,
      item.aspectRatio,
      item.probe?.duration,
      item.updatedAt || "",
    ]),
  );
  const mediaChanged = mediaSignature !== state.outputMediaSignature;
  const signature = JSON.stringify({
    status: project.status,
    embedded: document.documentElement.dataset.platformEmbedded === "true",
    publishedDeliveryId,
    publishedCount,
    publishedVideoOutputs: publishedOutputMap(project),
    deliveryCount: deliveries.length,
    deliveryCollapsed: state.deliveryCollapsed,
    mediaSignature,
  });
  if (signature === state.outputSignature) return;
  state.outputSignature = signature;
  state.outputMediaSignature = mediaSignature;
  dom.delivery.classList.add("is-hidden");
  dom.projectAssetsButton.hidden = !deliveries.length;
  if (!outputs.length) return;
  // 成片改为随助手消息交付；旧的独立成片区只保留内部兼容状态，不再展示。
  dom.delivery.classList.toggle("is-collapsed", state.deliveryCollapsed);
  dom.deliveryToggleButton.setAttribute("aria-expanded", String(!state.deliveryCollapsed));
  dom.deliveryToggleButton.querySelector("span").textContent = state.deliveryCollapsed
    ? "展开成片"
    : "收起成片";
  dom.deliveryToggleButton.querySelector("svg, i")?.setAttribute(
    "data-lucide",
    state.deliveryCollapsed ? "chevron-down" : "chevron-up",
  );
  dom.historyDeliveryButton.hidden = !deliveries.length;
  dom.speedVersionControl.hidden = project.status !== "succeeded";
  const selectedOutput = outputs[state.outputIndex] || null;
  const selectedDelivery = deliveries.find(item =>
    String(item?.id || "") === String(selectedOutput?.deliveryId || project?.activeDeliveryId || "")
  ) || null;
  const selectedPublishable = Boolean(
    resolvePublishableVideoOutput(project, selectedOutput, selectedDelivery)
  );
  dom.publishOutputButton.hidden = !(
    CAN_PUBLISH
    && selectedPublishable
    && document.documentElement.dataset.platformEmbedded === "true"
    && window.parent !== window
  );
  dom.outputTabs.replaceChildren();
  outputs.forEach((output, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = output.aspectRatio;
    button.addEventListener("click", () => selectOutput(index));
    dom.outputTabs.append(button);
  });
  const preferred = Math.max(0, outputs.findIndex((output) => output.aspectRatio === state.ratio));
  selectOutput(
    state.outputIndex < outputs.length ? state.outputIndex : preferred,
    { forceReload: mediaChanged },
  );
}

const productionHeartbeatStages = [
  "正在等待当前媒体任务返回",
  "已保留当前制作进度",
  "正在核对下一步所需素材",
  "任务连接正常",
];

function rotateProductionHeartbeatStage(nextText) {
  const stageWindow = document.querySelector(".production-live-stage-window");
  if (!stageWindow || stageWindow.dataset.stage === nextText) return;
  stageWindow.dataset.stage = nextText;
  const current = stageWindow.querySelector(".production-live-stage.is-current");
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (!current || reducedMotion) {
    stageWindow.replaceChildren();
    const replacement = document.createElement("span");
    replacement.className = "production-live-stage is-current";
    replacement.textContent = nextText;
    stageWindow.append(replacement);
    return;
  }
  const next = document.createElement("span");
  next.className = "production-live-stage is-next";
  next.textContent = nextText;
  stageWindow.append(next);
  window.requestAnimationFrame(() => {
    current.classList.remove("is-current");
    current.classList.add("is-leaving");
    next.classList.remove("is-next");
    next.classList.add("is-current");
  });
  const cleanup = () => current.remove();
  next.addEventListener("transitionend", cleanup, { once: true });
  window.setTimeout(cleanup, 520);
}

function stopProductionHeartbeat() {
  window.clearInterval(state.productionHeartbeatTimer);
  state.productionHeartbeatTimer = null;
  state.productionHeartbeatProjectId = "";
  state.productionHeartbeatStartedAt = 0;
  state.productionHeartbeatStageIndex = -1;
}

function productionRunClockKey(projectId) {
  return `xingzhen-video-run-clock:${VIDEO_VOICE_MEMBER_ID}:${String(projectId || "")}`;
}

function productionRunStartedAt(project) {
  const key = productionRunClockKey(project?.id);
  const serverStartedAt = Date.parse(String(project?.runStartedAt || ""));
  let storedStartedAt = 0;
  try {
    storedStartedAt = Number(localStorage.getItem(key) || 0);
  } catch (_) {
    storedStartedAt = 0;
  }
  const startedAt = Number.isFinite(serverStartedAt) && serverStartedAt > 0
    ? serverStartedAt
    : storedStartedAt > 0 ? storedStartedAt : Date.now();
  try {
    localStorage.setItem(key, String(startedAt));
  } catch (_) {
    // Private browsing or a blocked storage layer must not stop production UI.
  }
  return startedAt;
}

function clearProductionRunClock(projectId) {
  try {
    localStorage.removeItem(productionRunClockKey(projectId));
  } catch (_) {
    // The durable server timestamp remains authoritative when storage is blocked.
  }
}

function productionElapsedLabel(seconds) {
  const value = Math.max(1, Math.floor(Number(seconds) || 1));
  if (value < 60) return `${value}秒`;
  if (value < 3600) return `${Math.floor(value / 60)}分${String(value % 60).padStart(2, "0")}秒`;
  return `${Math.floor(value / 3600)}小时${String(Math.floor(value % 3600 / 60)).padStart(2, "0")}分`;
}

function startProductionHeartbeat(project) {
  if (state.productionHeartbeatTimer && state.productionHeartbeatProjectId === project.id) return;
  stopProductionHeartbeat();
  state.productionHeartbeatProjectId = project.id;
  state.productionHeartbeatStartedAt = productionRunStartedAt(project);
  state.productionHeartbeatStageIndex = -1;
  const tick = () => {
    if (state.project?.id !== project.id || state.project?.status !== "running") {
      stopProductionHeartbeat();
      return;
    }
    const elapsed = Math.max(1, Math.round((Date.now() - state.productionHeartbeatStartedAt) / 1000));
    const elapsedText = document.querySelector(".production-live-elapsed");
    if (elapsedText) elapsedText.textContent = productionElapsedLabel(elapsed);
    const stageIndex = Math.floor((elapsed - 1) / 6) % productionHeartbeatStages.length;
    if (stageIndex !== state.productionHeartbeatStageIndex) {
      state.productionHeartbeatStageIndex = stageIndex;
      rotateProductionHeartbeatStage(productionHeartbeatStages[stageIndex]);
    }
  };
  tick();
  state.productionHeartbeatTimer = window.setInterval(tick, 1000);
}

function normalizeCreationMode(value) {
  return String(value || "").trim().toLowerCase() === "static" ? "static" : "video";
}

function syncCreationMode(value, { announce = false } = {}) {
  const mode = normalizeCreationMode(value);
  const modeChanged = state.creationMode !== mode;
  state.creationMode = mode;
  if (modeChanged) {
    state.ratio = mode === "static" ? "16:9" : "9:16";
  }
  dom.creationModeButtons.forEach((button) => {
    const active = button.dataset.creationMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  dom.chatInput.placeholder = mode === "static"
    ? "告诉小星想制作的静态视频"
    : "告诉小星你的想法";
  if (announce) {
    showToast(
      mode === "static"
        ? "已切换为静态视频：图片分镜、轻推近、字幕、口播与 BGM"
        : "已切换为动态视频",
    );
  }
}

function renderProject(project) {
  state.project = project;
  state.projectId = project.id;
  state.ratio = project.plan?.aspect_ratio || state.ratio;
  syncCreationMode(
    project.creationMode
      || project.plan?.creation_mode
      || state.creationMode,
  );
  localStorage.setItem(PROJECT_STORAGE_KEY, project.id);
  enterStudio();
  dom.projectLabel.textContent = project.name && project.name !== "新会话"
    ? project.name
    : project.plan?.title || `项目 ${project.id.slice(0, 6)}`;
  if (dom.videoVoiceCurrent) {
    dom.videoVoiceCurrent.textContent = project.voiceId
      ? videoVoiceName(project.voiceId)
      : "尚未生成口播";
  }
  renderConversation(project);
  renderEvents(project);
  renderDelivery(project);
  const editorOutputId = String(project.editorAutoloadOutputId || "").trim();
  const editorAutoloadKey = `${project.id}:${editorOutputId}`;
  if (editorOutputId && !EDITOR_AUTOLOAD_KEYS.has(editorAutoloadKey)) {
    const editorOutput = (project.outputs || []).find(
      item => String(item?.id || "") === editorOutputId,
    );
    if (editorOutput) {
      EDITOR_AUTOLOAD_KEYS.add(editorAutoloadKey);
      window.setTimeout(() => {
        if (state.project?.id === project.id) void openVideoEditor(editorOutput, null);
      }, 120);
    }
  }

  const running = project.status === "running";
  if (running) startProductionHeartbeat(project);
  else {
    clearProductionRunClock(project.id);
    stopProductionHeartbeat();
  }
  dom.chatInput.disabled = running;
  const chatSubmitButton = dom.chatForm.querySelector("button[type='submit']");
  if (chatSubmitButton) {
    chatSubmitButton.disabled = false;
    chatSubmitButton.dataset.runningStop = running ? "true" : "false";
    chatSubmitButton.classList.toggle("is-stop", running);
    chatSubmitButton.setAttribute("aria-label", running ? "停止当前制作" : "发送");
    chatSubmitButton.title = running
      ? "停止当前制作；已完成的本地素材会保留"
      : "发送";
    const chatSubmitIcon = document.createElement("i");
    chatSubmitIcon.dataset.lucide = running ? "square" : "arrow-up";
    chatSubmitButton.replaceChildren(chatSubmitIcon);
  }
  const chatAttachmentButton = dom.chatForm.querySelector("[data-file-trigger]");
  if (chatAttachmentButton) {
    delete chatAttachmentButton.dataset.runningStop;
    chatAttachmentButton.classList.remove("is-stop");
    chatAttachmentButton.disabled = running;
    chatAttachmentButton.setAttribute("aria-label", "添加图片、视频或音频");
    chatAttachmentButton.title = running
      ? "制作进行中，停止后可继续添加附件"
      : "添加图片、视频或音频";
    const chatAttachmentIcon = document.createElement("i");
    chatAttachmentIcon.dataset.lucide = "plus";
    chatAttachmentButton.replaceChildren(chatAttachmentIcon);
  }
  dom.creationModeButtons.forEach((button) => {
    button.disabled = running;
  });
  refreshIcons();
  loadHistory();
  schedulePoll(running);
  if (WORKSPACE_MODE && window.parent !== window) {
    window.parent.postMessage({
      type: "custom-video:project",
      project,
    }, window.location.origin);
  }
}

function historyItemName(project) {
  return publicText(project.name || "新会话");
}

async function renameHistoryProject(projectId, name) {
  const clean = name.trim();
  if (!clean) return;
  const response = await fetch(`/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: clean }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "重命名失败");
  if (state.project?.id === projectId) {
    state.project.name = data.name;
    dom.projectLabel.textContent = data.name;
  }
  await loadHistory(true);
}

function beginHistoryRename(row, project) {
  const select = row.querySelector(".history-select");
  const input = document.createElement("input");
  input.className = "history-name-input";
  input.value = historyItemName(project);
  select.replaceWith(input);
  trackComposition(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    if (save && input.value.trim() && input.value.trim() !== historyItemName(project)) {
      try {
        await renameHistoryProject(project.id, input.value);
      } catch (error) {
        showToast(error.message);
        state.historySignature = "";
        await loadHistory(true);
      }
    } else {
      state.historySignature = "";
      await loadHistory(true);
    }
  };
  input.addEventListener("keydown", (event) => {
    if (keepCompositionEnterLocal(event, input)) return;
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function populateHistoryList(list, items) {
  list.replaceChildren();
  items.forEach((project) => {
    const row = document.createElement("div");
    row.className = `history-item${project.id === state.projectId ? " active" : ""}`;
    const select = document.createElement("button");
    select.type = "button";
    select.className = "history-select";
    const label = document.createElement("span");
    label.className = "history-select-label";
    label.textContent = historyItemName(project);
    select.append(label);
    const publishedCount = publishedCountFor(project);
    if (publishedCount > 0) {
      const badge = document.createElement("span");
      badge.className = "history-published-badge";
      badge.textContent = `已发布 ${publishedCount}`;
      badge.title = `当前会话已有 ${publishedCount} 条有效发布`;
      select.append(badge);
    }
    select.title = historyItemName(project);
    select.addEventListener("click", () => {
      state.messageSignature = "";
      state.eventSignature = "";
      state.outputSignature = "";
      state.historyLoadedAt = 0;
      state.outputIndex = 0;
      dom.startView.classList.remove("history-open");
      dom.studioView.classList.remove("history-open");
      loadProject(project.id);
    });
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "history-rename";
    rename.setAttribute("aria-label", `重命名 ${historyItemName(project)}`);
    rename.title = "重命名";
    const icon = document.createElement("i");
    icon.dataset.lucide = "pencil";
    rename.append(icon);
    rename.addEventListener("click", (event) => {
      event.stopPropagation();
      beginHistoryRename(row, project);
    });
    row.append(select, rename);
    list.append(row);
  });
}

function renderHistory(items) {
  const incoming = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach(project => {
    const id = String(project?.id || "");
    if (!id || seen.has(id)) return;
    seen.add(id);
    incoming.push(project);
  });
  if (!state.historyItems.length) {
    state.historyItems = incoming;
  } else {
    const previousIds = new Set(state.historyItems.map(project => String(project?.id || "")));
    const incomingById = new Map(incoming.map(project => [String(project.id), project]));
    const added = incoming.filter(project => !previousIds.has(String(project.id)));
    const retained = state.historyItems
      .filter(project => incomingById.has(String(project?.id || "")))
      .map(project => incomingById.get(String(project.id)));
    state.historyItems = [...added, ...retained];
  }
  items = state.historyItems;
  const signature = JSON.stringify({
    activeProjectId: state.projectId,
    items: items.map((project) => [
      project.id,
      project.name,
      project.status,
      project.updatedAt,
      project?._integration?.publishedDeliveryId || "",
      publishedCountFor(project),
    ]),
  });
  if (signature === state.historySignature) return;
  state.historySignature = signature;

  [dom.startHistoryList, dom.historyList].forEach((list) => populateHistoryList(list, items));
  if (WORKSPACE_MODE) {
    window.parent.postMessage({
      type: "custom-video:workspace-projects",
      projects: state.historyItems.map(project => ({
        id: String(project?.id || ""),
        name: historyItemName(project),
        status: String(project?.status || "conversation"),
        updatedAt: project?.updatedAt || project?.createdAt || "",
        publishedCount: publishedCountFor(project),
      })).filter(project => project.id),
    }, window.location.origin);
  }
  refreshIcons();
}

function upsertHistoryProject(project) {
  if (!project?.id) return;
  const summary = {
    id: project.id,
    name: project.name || "新会话",
    status: project.status || "conversation",
    updatedAt: project.updatedAt || project.createdAt || new Date().toISOString(),
    _integration: project._integration || {},
  };
  const existingIndex = state.historyItems.findIndex((item) => item.id === summary.id);
  const items = existingIndex >= 0
    ? state.historyItems.map((item, index) => index === existingIndex ? summary : item)
    : [summary, ...state.historyItems];
  state.historySignature = "";
  renderHistory(items);
}

async function loadHistory(force = false) {
  const now = Date.now();
  if (!force && now - state.historyLoadedAt < 4000) return;
  state.historyLoadedAt = now;
  const requestEpoch = ++state.historyLoadEpoch;
  try {
    const response = await fetch("/api/projects?page=1&pageSize=60", { cache: "no-store" });
    if (!response.ok) return [];
    const data = await response.json();
    if (requestEpoch !== state.historyLoadEpoch) return [];
    const items = data.items || [];
    renderHistory(items);
    return items;
  } catch {
    // History is secondary to the active creation flow.
    return [];
  }
}

async function createNewConversation() {
  if (state.busy) return;
  resetProject(false);
  state.busy = true;
  try {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const project = await response.json().catch(() => ({}));
    if (!response.ok || !project?.id) {
      throw new Error(project.detail || "新建会话失败");
    }
    renderProject(project);
    upsertHistoryProject(project);
    void loadHistory(true);
    dom.chatInput.focus();
  } catch (error) {
    resetProject(true);
    showToast(error?.message || "新建会话失败");
  } finally {
    state.busy = false;
  }
}

async function loadProject(projectId, silent = false) {
  if (String(projectId || "") !== String(state.projectId || "")) hideToast();
  const requestEpoch = ++state.projectLoadEpoch;
  try {
    const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
    if (!response.ok) throw new Error("项目不存在");
    const project = await response.json();
    if (requestEpoch !== state.projectLoadEpoch) return;
    isolatePendingAttachments(project.id);
    renderProject(project);
    const reconciliation = project?._usageReconciliation;
    if (
      dom.toast.textContent.includes("安全收口")
      && Number(reconciliation?.pending || 0) === 0
      && Number(reconciliation?.conflicts || 0) === 0
    ) {
      hideToast();
    }
    return project;
  } catch (error) {
    if (requestEpoch !== state.projectLoadEpoch) return;
    if (!silent) showToast(error.message);
    if (responseIsMissing(error)) resetProject(false);
  }
}

function responseIsMissing(error) {
  return String(error?.message || "").includes("不存在");
}

function schedulePoll(active) {
  window.clearTimeout(state.pollTimer);
  if (!active || !state.projectId) return;
  state.pollTimer = window.setTimeout(async () => {
    await loadProject(state.projectId, true);
  }, 1300);
}

const simpleGreetingPattern = /^(?:你好|您好|嗨|哈喽|在吗|早上好|上午好|中午好|下午好|晚上好|hi|hello|hey)[\s！!。.?？]*$/i;
const productionRequestPattern = /(?:帮我|请|开始|继续|重新|直接)?(?:做|制作|生成|创作|合成|剪辑|渲染|配音|配乐|出片|成片|拍)(?:一下|一个|一条|一段|这条|这个|视频|图片|图文|口播|分镜|字幕|音频|声音)?/;
const contextualContinuationPattern = /(?:继续(?:上一|上个|刚才|之前|原来|原有|这个|这条|那个|那条)?|上一条|上一个|上次|刚才|之前|原任务|原视频|原方案|按(?:刚才|之前|上一条|上一个|这个|那个)|沿用|接着|续做|重做)/;
const contextualEditPattern = /(?:修改|调整|改成|换成|替换|删掉|删除|去掉|增加|添加|补上|缩短|加长|放大|缩小|挪动|移动|保留|不要|只要|字幕|转场|画中画|配乐|口播|声线|镜头|片段)/;

function publicProgressSubject(message) {
  const compact = assistantText(String(message || ""))
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(compact);
  return characters.length > 28
    ? `${characters.slice(0, 28).join("")}…`
    : compact;
}

function previousConversationSubject(message) {
  const current = assistantText(String(message || "")).replace(/\s+/g, " ").trim();
  const messages = Array.isArray(state.project?.messages) ? state.project.messages : [];
  let skippedCurrent = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item?.role !== "user") continue;
    const content = assistantText(String(item.content || "")).replace(/\s+/g, " ").trim();
    if (!content) continue;
    if (!skippedCurrent && current && content === current) {
      skippedCurrent = true;
      continue;
    }
    if (simpleGreetingPattern.test(content)) continue;
    const compact = content.replace(/[\s，。！？、,.!?]+/g, "");
    if (/^(?:请)?(?:继续|接着|按这个做|按那个做|执行吧|开始吧|确认继续)$/.test(compact)) continue;
    return publicProgressSubject(content);
  }
  const planTitle = String(state.project?.plan?.title || "").trim();
  if (planTitle) return publicProgressSubject(planTitle);
  const projectName = String(state.project?.name || "").trim();
  return projectName && projectName !== "新会话"
    ? publicProgressSubject(projectName)
    : "";
}

function contextualRequestFor(message) {
  const cleanMessage = assistantText(String(message || "")).replace(/\s+/g, " ").trim();
  const previousSubject = previousConversationSubject(cleanMessage);
  if (!previousSubject || simpleGreetingPattern.test(cleanMessage)) return null;
  const referencesEarlierTurn = contextualContinuationPattern.test(cleanMessage);
  const editsExistingResult = contextualEditPattern.test(cleanMessage)
    && !/^(?:请)?(?:做|制作|生成|创作)(?:一个|一条|一段)?/.test(cleanMessage);
  if (!referencesEarlierTurn && !editsExistingResult) return null;
  return {
    previousSubject,
    editsExistingResult,
  };
}

function pendingThoughtStagesFor(message, attachments = []) {
  const cleanMessage = String(message || "").trim();
  const subject = publicProgressSubject(cleanMessage);
  const hasAssets = attachments.length > 0;
  const hasAudio = attachments.some((item) => String(item.mime || "").startsWith("audio/"));
  if (simpleGreetingPattern.test(cleanMessage)) {
    return [
      ["识别问候意图", `已识别为普通问候“${subject}”，本轮不会沿用之前的视频制作状态`],
      ["组织本轮回应", `正在直接回应“${subject}”，不会启动图片、视频或语音任务`],
    ];
  }
  const contextualRequest = contextualRequestFor(cleanMessage);
  if (contextualRequest) {
    const { previousSubject, editsExistingResult } = contextualRequest;
    return [
      ["识别为承接请求", `正在承接当前会话中的“${previousSubject}”，本轮要求是“${subject}”`],
      [
        editsExistingResult ? "定位本轮修改范围" : "恢复上一任务上下文",
        editsExistingResult
          ? `保留“${previousSubject}”的有效内容，只处理“${subject}”提出的修改`
          : `沿用“${previousSubject}”已经确认的内容，按“${subject}”继续推进`,
      ],
      ...(hasAssets
        ? [["识别本轮新增素材", "把这次上传的素材作为当前续作的新增输入，不混入其他会话附件"]]
        : []),
      ["确认续作路径", "复用当前会话中仍然有效的计划与素材，只从本轮指定的位置继续"],
    ];
  }
  if (!hasAssets && !productionRequestPattern.test(cleanMessage)) {
    return [
      ["聚焦当前问题", `正在围绕“${subject}”判断这是咨询、反馈还是修改请求`],
      ["整理回答重点", `只回答“${subject}”相关内容，不沿用上一轮制作步骤`],
    ];
  }
  return [
    ["提取本轮制作要求", `正在从“${subject || "本轮附件"}”识别主题、受众和表达目标`],
    ...(hasAssets
      ? [["识别本轮附件用途", "判断这次提交的图片、视频和音频分别承担参考、剪辑、口播或声音设计"]]
      : []),
    ...(hasAudio
      ? [["读取本轮口播时间线", "这次提交的口播音频会先转写，再按真实语义和时长组织镜头"]]
      : []),
    ["确认本轮制作路径", "根据当前要求判断补问关键条件或进入对应制作流程"],
    ["整理公开执行步骤", "把本轮已确认的要求组织成后续可执行的导演任务"],
  ];
}

function stopPendingThoughts() {
  window.clearInterval(state.pendingThoughtTimer);
  state.pendingThoughtTimer = null;
}

function startPendingThoughts(token, attachments, message) {
  stopPendingThoughts();
  state.pendingRequestToken = token;
  const startedAt = Date.now();
  const stages = pendingThoughtStagesFor(message, attachments);
  let index = 0;
  const advancePublicThoughts = () => {
    if (!state.busy || state.pendingRequestToken !== token || !state.project) {
      stopPendingThoughts();
      return;
    }
    const pendingMessage = (state.project.messages || []).find((item) => item.id === `${token}-assistant`);
    if (!pendingMessage) {
      stopPendingThoughts();
      return;
    }
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const stage = stages[index];
    const waitingId = `${token}-event-waiting`;
    const title = stage ? stage[0] : "等待导演返回";
    const detail = stage
      ? stage[1]
      : `公开执行步骤已整理完成，本轮请求仍在处理中 · ${elapsed} 秒`;
    pendingMessage.content = title;
    const currentEvents = [...(state.project.events || [])];
    if (stage) {
      const stageId = `${token}-event-${index}`;
      const stageEvent = currentEvents.find(event => event.id === stageId);
      if (stageEvent) {
        stageEvent.title = title;
        stageEvent.detail = detail;
        stageEvent.status = "running";
      } else {
        currentEvents.push({ id: stageId, title, detail, status: "running" });
      }
      index += 1;
    } else {
      const waitingEvent = currentEvents.find(event => event.id === waitingId);
      if (waitingEvent) {
        waitingEvent.title = title;
        waitingEvent.detail = detail;
        waitingEvent.status = "running";
      } else {
        currentEvents.push({ id: waitingId, title, detail, status: "running" });
      }
    }
    state.project.events = currentEvents;
    state.eventSignature = "";
    const pendingText = dom.conversation.querySelector(
      `[data-message-id="${pendingMessage.id}"] .pending-live-text`,
    );
    if (pendingText) typePublicProgress(pendingText, publicText(title));
    renderEvents(state.project);
  };
  advancePublicThoughts();
  state.pendingThoughtTimer = window.setInterval(advancePublicThoughts, 1800);
}

function isDirectContinuation(message) {
  const compact = String(message || "")
    .toLowerCase()
    .replace(/[\s，。！？、,.!?]+/g, "");
  return /^(?:没关系|不用管|无所谓|这个误差没关系)?(?:请)?继续(?:制作|生成|合成|执行|完成)?$/.test(compact)
    || ["确认继续", "按这个做", "执行吧", "开始吧"].includes(compact);
}

function renderPendingRequest(message, attachments, { resuming = false } = {}) {
  const current = state.project && state.project.id === state.projectId ? state.project : {};
  const pendingId = createClientId();
  const optimisticProject = {
    ...current,
    id: state.projectId,
    name: current.name && current.name !== "新会话" ? current.name : message.replace(/\s+/g, " ").slice(0, 28),
    status: "thinking",
    progress: Math.max(2, Number(current.progress || 0)),
    messages: [
      ...(current.messages || []),
      {
        id: `${pendingId}-user`,
        role: "user",
        kind: "message",
        content: message,
        attachments: attachments.map((attachment) => ({
          label: attachment.label,
          name: attachment.name,
          mime: attachment.mime,
          url: attachment.dataUrl,
        })),
      },
      {
        id: `${pendingId}-assistant`,
        role: "assistant",
        kind: "pending",
        content: resuming
          ? "正在继续上一轮创作"
          : pendingThoughtStagesFor(message, attachments)[0]?.[0] || "正在思考",
      },
    ],
    events: [
      ...(current.events || []),
      ...(resuming
        ? [{
          id: `${pendingId}-event-resume`,
          title: "正在继续原任务",
          detail: "正在复用上一轮导演计划与已完成素材，从缺失步骤接着执行",
          status: "running",
        }]
        : []),
    ],
    outputs: current.outputs || [],
  };
  state.project = optimisticProject;
  state.pendingScrollMessageId = `${pendingId}-user`;
  state.messageSignature = "";
  state.eventSignature = "";
  enterStudio();
  dom.projectLabel.textContent = optimisticProject.name || "新项目";
  renderConversation(optimisticProject);
  renderEvents(optimisticProject);
  dom.chatInput.disabled = true;
  dom.chatForm.querySelector("button[type='submit']").disabled = true;
  dom.startForm.querySelector("button[type='submit']").disabled = true;
  refreshIcons();
  if (resuming) stopPendingThoughts();
  else startPendingThoughts(pendingId, attachments, message);
  return pendingId;
}

function renderPendingFailure(message, token) {
  if (!state.project) return;
  const failedProject = {
    ...state.project,
    status: "failed",
    messages: (state.project.messages || []).map((item) =>
      item.kind === "pending"
        ? { ...item, kind: "error", content: `请求没有完成：${message}` }
        : item,
    ),
    events: [
      ...(state.project.events || []).filter((item) => !String(item.id || "").startsWith(token)),
      {
        id: `${token}-failure`,
        title: "导演请求未完成",
        detail: message,
        status: "error",
      },
    ],
  };
  state.project = failedProject;
  state.messageSignature = "";
  state.eventSignature = "";
  renderConversation(failedProject);
  renderEvents(failedProject);
}

async function sendMessage(message, fromStart = false) {
  const cleanMessage = String(message || "").trim();
  if (state.busy || !cleanMessage) return;
  let requestProjectId = state.projectId;
  let requestAttachments = [];
  let pendingToken = "";
  let pendingVisibleStartedAt = 0;
  let requestAccepted = false;
  state.busy = true;
  try {
    requestAttachments = [...state.attachments];
    state.attachments = [];
    renderAttachments();
    dom.startInput.value = "";
    dom.chatInput.value = "";
    autoSize(dom.startInput);
    autoSize(dom.chatInput);
    const resumableTypes = new Set(["resume_missing", "resume_plan", "recompose"]);
    const resuming = (
      isDirectContinuation(cleanMessage)
      && resumableTypes.has(String(state.project?.retryable?.type || ""))
    );
    pendingToken = renderPendingRequest(cleanMessage, requestAttachments, { resuming });
    pendingVisibleStartedAt = Date.now();
    const idempotencyKey = globalThis.crypto?.randomUUID?.()
      || `static-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const requestChat = (projectId) => fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey,
        projectId,
        message: cleanMessage,
        aspectRatio: state.ratio,
        creationMode: state.creationMode,
        voiceId: nextNarrationVoiceId(),
        attachments: requestAttachments.map(({ label, name, mime, dataUrl }) => ({ label, name, mime, dataUrl })),
      }),
    });
    const response = await requestChat(requestProjectId);
    const data = await response.json().catch(() => ({}));
    if (
      response.status === 409
      && data?.detail?.code === "video_workshop_usage_pending"
    ) {
      const pendingError = new Error(apiErrorMessage(data, "历史用量待处理"));
      pendingError.code = "video_workshop_usage_pending";
      throw pendingError;
    }
    if (!response.ok) throw new Error(apiErrorMessage(data, "导演请求失败"));
    requestAccepted = true;
    const minimumPendingMs = simpleGreetingPattern.test(cleanMessage) ? 760 : 520;
    const pendingRemainingMs = minimumPendingMs - (Date.now() - pendingVisibleStartedAt);
    if (pendingRemainingMs > 0) {
      await new Promise(resolve => window.setTimeout(resolve, pendingRemainingMs));
    }
    stopPendingThoughts();
    hideToast();
    state.pendingScrollMessageId = pendingToken
      ? `${pendingToken}-assistant`
      : "";
    renderProject(data);
  } catch (error) {
    stopPendingThoughts();
    const errorMessage = String(error?.message || error || "请求失败");
    const keepCurrentConversation = error?.code === "video_workshop_usage_pending";
    if (pendingToken && !keepCurrentConversation) {
      try {
        state.pendingScrollMessageId = `${pendingToken}-assistant`;
        renderPendingFailure(errorMessage, pendingToken);
      } catch {
        // The original failure still needs to unlock the composer and remain retryable.
      }
    }
    if (!requestAccepted) {
      const existingIds = new Set(state.attachments.map((item) => item.id));
      state.attachments = [
        ...requestAttachments.filter((item) => !existingIds.has(item.id)),
        ...state.attachments,
      ];
      try {
        renderAttachments();
      } catch {
        // A preview rendering failure must never keep the request lock active.
      }
      const retryInput = fromStart ? dom.startInput : dom.chatInput;
      if (retryInput && !retryInput.value.trim()) {
        retryInput.value = cleanMessage;
        try {
          autoSize(retryInput);
        } catch {
          // Text restoration is best effort; busy recovery is handled below.
        }
      }
      if (keepCurrentConversation && requestProjectId) {
        state.messageSignature = "";
        state.eventSignature = "";
        await loadProject(requestProjectId, true).catch(() => {});
      }
    }
    showToast(keepCurrentConversation
      ? "该旧会话仍在安全收口；已保留输入，可切换其他会话正常使用"
      : errorMessage);
  } finally {
    state.busy = false;
    const startSubmit = dom.startForm?.querySelector("button[type='submit']");
    if (startSubmit) startSubmit.disabled = false;
    if (state.project?.status !== "running") {
      dom.chatInput.disabled = false;
      const chatSubmit = dom.chatForm?.querySelector("button[type='submit']");
      if (chatSubmit) chatSubmit.disabled = false;
    }
  }
}

async function retryProject(button) {
  if (state.busy || !state.projectId) return;
  const retryType = state.project?.retryable?.type;
  const sceneNumber = state.project?.retryable?.sceneNumber || "";
  const isResume = ["resume_missing", "resume_plan"].includes(retryType);
  const isCopyright = state.project?.retryable?.reason === "copyright";
  state.busy = true;
  button.disabled = true;
  button.classList.add("is-loading");
  const label = button.querySelector("span");
  if (label) label.textContent = isResume ? "正在继续原任务" : `导演正在${isCopyright ? "原创" : "安全"}改写`;
  try {
    const response = await fetch(`/api/projects/${state.projectId}/retry`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(apiErrorMessage(data, isResume ? "恢复制作失败" : "安全改写失败"));
    }
    state.messageSignature = "";
    state.eventSignature = "";
    state.historySignature = "";
    renderProject(data);
    showToast(isResume ? "已保留原计划和完成素材，正在继续任务" : "已保留成功素材，正在重试失败镜头");
  } catch (error) {
    showToast(error.message || (isResume ? "恢复制作失败" : "安全改写失败"));
    button.disabled = false;
    button.classList.remove("is-loading");
    if (label) {
      label.textContent = isResume
        ? `继续原任务 · 镜头 ${sceneNumber}`
        : `${isCopyright ? "原创" : "安全"}改写并重试镜头 ${sceneNumber}`;
    }
  } finally {
    state.busy = false;
  }
}

async function stopProject(button) {
  if (state.busy || !state.projectId || state.project?.status !== "running") return;
  state.busy = true;
  button.disabled = true;
  const label = button.querySelector("span");
  if (label) label.textContent = "正在停止";
  try {
    const response = await fetch(`/api/projects/${state.projectId}/cancel`, {
      method: "POST",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "停止制作失败");
    state.messageSignature = "";
    state.eventSignature = "";
    state.historySignature = "";
    renderProject(data);
    showToast(
      data?.retryable?.type === "resume_missing"
        ? "制作已停止，完成素材已保留，可继续缺失镜头"
        : "制作已停止，可以补充方向后重新生成",
    );
  } catch (error) {
    showToast(error.message || "停止制作失败");
    button.disabled = false;
    if (label) label.textContent = "停止制作";
  } finally {
    state.busy = false;
  }
}

function resetProject(showStart = true) {
  hideToast();
  state.projectLoadEpoch += 1;
  window.clearTimeout(state.pollTimer);
  stopPendingThoughts();
  stopProductionHeartbeat();
  state.projectId = "";
  state.project = null;
  state.busy = false;
  state.attachments = [];
  syncCreationMode("video");
  state.outputIndex = 0;
  state.messageSignature = "";
  state.conversationRenderProjectId = "";
  state.conversationBottomLockToken += 1;
  state.eventSignature = "";
  state.outputSignature = "";
  state.historySignature = "";
  state.pendingScrollMessageId = "";
  state.deliveryProjectId = "";
  state.deliveryCollapsed = false;
  localStorage.removeItem(PROJECT_STORAGE_KEY);
  renderAttachments();
  dom.conversation.replaceChildren();
  dom.eventList.replaceChildren();
  dom.delivery.classList.add("is-hidden");
  dom.projectLabel.textContent = "新项目";
  dom.chatInput.disabled = false;
  const chatSubmitButton = dom.chatForm.querySelector("button[type='submit']");
  if (chatSubmitButton) {
    chatSubmitButton.disabled = false;
    delete chatSubmitButton.dataset.runningStop;
    chatSubmitButton.classList.remove("is-stop");
    chatSubmitButton.setAttribute("aria-label", "发送");
    chatSubmitButton.title = "发送";
    const chatSubmitIcon = document.createElement("i");
    chatSubmitIcon.dataset.lucide = "arrow-up";
    chatSubmitButton.replaceChildren(chatSubmitIcon);
  }
  const chatAttachmentButton = dom.chatForm.querySelector("[data-file-trigger]");
  if (chatAttachmentButton) {
    chatAttachmentButton.disabled = false;
    delete chatAttachmentButton.dataset.runningStop;
    chatAttachmentButton.classList.remove("is-stop");
  }
  dom.creationModeButtons.forEach((button) => {
    button.disabled = false;
  });
  if (WORKSPACE_MODE) {
    enterStudio();
    dom.chatInput.focus();
  } else if (showStart) {
    dom.studioView.classList.add("is-hidden");
    dom.startView.classList.remove("is-hidden");
    dom.startInput.focus();
  }
  loadHistory(true);
}

function installGlobalDropZone() {
  let dragDepth = 0;
  const isFileDrag = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  const setDragging = (active) => {
    document.body.classList.toggle("is-file-dragging", active);
    dom.dropOverlay.setAttribute("aria-hidden", String(!active));
    const editorOpen = Boolean(dom.videoEditorModal && !dom.videoEditorModal.hidden);
    const title = dom.dropOverlay.querySelector("strong");
    const detail = dom.dropOverlay.querySelector("span");
    if (title) title.textContent = editorOpen ? "松开导入剪辑素材" : "松开添加创作素材";
    if (detail) detail.textContent = editorOpen ? "拖到 V2 添加画中画，拖到 V1 替换片段" : "图片 / 视频 / MP3 / WAV / M4A";
  };
  const resetDragging = () => {
    dragDepth = 0;
    setDragging(false);
  };

  document.addEventListener("dragenter", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  });
  document.addEventListener("dragover", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  });
  document.addEventListener("dragleave", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
  });
  document.addEventListener("drop", async (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    const files = event.dataTransfer.files;
    resetDragging();
    try {
      if (dom.videoEditorModal && !dom.videoEditorModal.hidden) {
        await importEditorFiles(files, { target: "overlay" });
        return;
      }
      await addFiles(files);
    } catch (error) {
      showAttachmentError(error);
    }
  });
  window.addEventListener("blur", resetDragging);
  window.addEventListener("dragend", resetDragging);
}

function installVideoEditorDropZone() {
  if (!dom.videoEditorModal) return;
  const isFileDrag = event => [...(event.dataTransfer?.types || [])].includes("Files");
  ["dragenter", "dragover"].forEach(type => {
    dom.videoEditorModal.addEventListener(type, event => {
      if (!isFileDrag(event) || dom.videoEditorModal.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      dom.videoEditorModal.classList.add("is-file-target");
    });
  });
  dom.videoEditorModal.addEventListener("dragleave", event => {
    if (!isFileDrag(event)) return;
    if (!dom.videoEditorModal.contains(event.relatedTarget)) {
      dom.videoEditorModal.classList.remove("is-file-target");
    }
  });
  dom.videoEditorModal.addEventListener("drop", async event => {
    if (!isFileDrag(event) || dom.videoEditorModal.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    dom.videoEditorModal.classList.remove("is-file-target");
    await importEditorFiles(event.dataTransfer.files, { target: "overlay" });
  });
}

function updateSkillMenu(textarea) {
  const menu = textarea.closest("form")?.querySelector("[data-skill-menu]");
  if (!menu) return;
  const value = textarea.value.trimStart();
  const matches = value.startsWith("/") && !value.includes(" ")
    ? slashSkills.filter((skill) => skill.command.startsWith(value))
    : [];
  menu.replaceChildren();
  menu.classList.toggle("is-hidden", !matches.length);
  matches.forEach((skill) => {
    const button = document.createElement("button");
    button.type = "button";
    const title = document.createElement("strong");
    title.textContent = skill.command;
    const detail = document.createElement("span");
    detail.textContent = skill.detail;
    button.append(title, detail);
    button.addEventListener("click", () => {
      textarea.value = `${skill.command} `;
      autoSize(textarea);
      menu.classList.add("is-hidden");
      textarea.focus();
    });
    menu.append(button);
  });
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await response.json();
    const serviceEntries = Object.entries(data.services || {});
    const fallbackLabels = {
      director: "导演语言模型",
      video: "视频生成",
      voice: "语音生成",
      mediaTools: "本地视频合成",
      qualityCheck: "成片质检",
      transcription: "口播音频转写",
      bgm: "共享 BGM",
    };
    const serviceLabel = ([key, item]) => item?.label || fallbackLabels[key] || key || "服务";
    const legacyOptional = new Set(["transcription", "bgm"]);
    const missingRequired = Array.isArray(data.missingRequired)
      ? data.missingRequired
      : serviceEntries
        .filter(([key, item]) => (
          item?.configured === false
          && (item.required === true || (item.required == null && !legacyOptional.has(key)))
        ))
        .map(serviceLabel);
    const optionalUnavailable = Array.isArray(data.optionalUnavailable)
      ? data.optionalUnavailable
      : serviceEntries
        .filter(([key, item]) => (
          item?.configured === false
          && (item.required === false || (item.required == null && legacyOptional.has(key)))
        ))
        .map(serviceLabel);
    const status = missingRequired.length
      ? "incomplete"
      : optionalUnavailable.length
        ? "degraded"
        : "ready";
    dom.serviceState.className = `service-state ${status === "incomplete" ? "error" : status}`;
    dom.serviceStateText.textContent = status === "incomplete"
      ? `缺少：${missingRequired.join("、")}`
      : status === "degraded"
        ? "核心服务已就绪"
        : "服务已就绪";
    dom.serviceState.title = optionalUnavailable.length
      ? `可选能力未启用：${optionalUnavailable.join("、")}`
      : dom.serviceStateText.textContent;
  } catch {
    dom.serviceState.className = "service-state error";
    dom.serviceStateText.textContent = "服务不可用";
    dom.serviceState.title = "无法连接视频工坊 sidecar";
  }
}

dom.startForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(dom.startInput.value, true);
});

dom.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const submitButton = event.submitter || dom.chatForm.querySelector("button[type='submit']");
  if (submitButton?.dataset.runningStop === "true") {
    void stopProject(submitButton);
    return;
  }
  sendMessage(dom.chatInput.value, false);
});

dom.creationModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (state.busy || button.disabled) return;
    syncCreationMode(button.dataset.creationMode, { announce: true });
  });
});

[dom.startInput, dom.chatInput].forEach((textarea) => {
  trackComposition(textarea);
  if (textarea === dom.startInput) {
    textarea.addEventListener("focus", stopPlaceholderCycle, { once: true });
    textarea.addEventListener("pointerdown", stopPlaceholderCycle, { once: true });
  }
  textarea.addEventListener("input", () => {
    if (textarea === dom.startInput) stopPlaceholderCycle();
    autoSize(textarea);
    updateSkillMenu(textarea);
  });
  textarea.addEventListener("keydown", (event) => {
    if (keepCompositionEnterLocal(event, textarea)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const form = textarea.closest("form");
      form.requestSubmit();
    }
  });
  textarea.addEventListener("paste", async (event) => {
    try {
      const mediaFiles = [...(event.clipboardData?.items || [])]
        .filter((item) => item.kind === "file" && /^(?:image|video|audio)\//.test(item.type))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (mediaFiles.length) await addFiles(mediaFiles);
    } catch (error) {
      showAttachmentError(error);
    }
  });
  textarea.addEventListener("blur", () => {
    window.setTimeout(() => textarea.closest("form")?.querySelector("[data-skill-menu]")?.classList.add("is-hidden"), 120);
  });
});

document.querySelectorAll("[data-file-trigger]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.closest("#startForm")) stopPlaceholderCycle();
    dom.fileInput.click();
  });
});

dom.fileInput.addEventListener("change", async () => {
  try {
    await addFiles(dom.fileInput.files);
  } catch (error) {
    showAttachmentError(error);
  } finally {
    dom.fileInput.value = "";
  }
});

window.addEventListener("message", (event) => {
  if (
    window.parent === window
    || event.source !== window.parent
    || event.origin !== window.location.origin
  ) {
    return;
  }
  const message = event.data && typeof event.data === "object" ? event.data : {};
  if (
    WORKSPACE_MODE
    && message.scope === "video"
    && message.type === "workspace:voice-preferences"
  ) {
    state.favoriteVoiceIds = new Set(
      (Array.isArray(message.favoriteVoiceIds) ? message.favoriteVoiceIds : [])
        .map(item => String(item || "").trim())
        .filter(Boolean)
    );
    syncVideoVoiceUi();
    return;
  }
  if (
    WORKSPACE_MODE
    && message.scope === "video"
    && message.type === "workspace:prefill"
  ) {
    const launchId = String(message.launchId || "").trim().slice(0, 180);
    if (launchId && HOME_PREFILL_IDS.has(launchId)) return;
    if (launchId) HOME_PREFILL_IDS.add(launchId);
    syncCreationMode(message.creationMode === "static" ? "static" : "video");
    const incoming = Array.isArray(message.attachments) ? message.attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE) : [];
    state.attachments = incoming
      .filter(item => /^(?:image|video|audio)\//.test(String(item?.type || item?.mime || "")) && /^data:/.test(String(item?.dataUrl || "")))
      .map((item, index) => {
        const mime = String(item.type || item.mime || "");
        const kind = mime.startsWith("video/") ? "视频" : mime.startsWith("audio/") ? "音频" : "图";
        return {
          id: createClientId(),
          label: `${kind}${index + 1}`,
          name: String(item.name || `${kind}${index + 1}`).slice(0, 180),
          mime,
          dataUrl: String(item.dataUrl || ""),
        };
      });
    renderAttachments();
    stopPlaceholderCycle();
    const prompt = String(message.prompt || "").trim().slice(0, 12000);
    dom.startInput.value = prompt;
    dom.chatInput.value = prompt;
    autoSize(dom.startInput);
    autoSize(dom.chatInput);
    if (prompt || state.attachments.length) {
      window.setTimeout(() => {
        const fromStart = !dom.startView.classList.contains("is-hidden");
        void sendMessage(prompt, fromStart);
      }, 80);
    }
    return;
  }
  if (
    WORKSPACE_MODE
    && message.scope === "video"
    && message.type === "workspace:open"
  ) {
    const projectId = String(message.projectId || "").trim().slice(0, 180);
    // 只有当前项目已经完整渲染时才忽略重复打开。若此前请求中断、
    // ready 消息发生竞态或项目只写入了 ID，允许同一 ID 再次触发加载。
    if (
      !projectId
      || (
        projectId === state.projectId
        && state.project?.id === projectId
      )
    ) return;
    state.messageSignature = "";
    state.eventSignature = "";
    state.outputSignature = "";
    state.outputMediaSignature = "";
    state.historyLoadedAt = 0;
    state.outputIndex = 0;
    void loadProject(projectId);
    return;
  }
  if (
    WORKSPACE_MODE
    && message.scope === "video"
    && message.type === "workspace:create"
  ) {
    void createNewConversation();
    return;
  }
  if (
    WORKSPACE_MODE
    && message.scope === "video"
    && message.type === "workspace:rename"
  ) {
    const projectId = String(message.projectId || "").trim().slice(0, 180);
    const name = String(message.name || "").trim().slice(0, 180);
    if (!projectId || !name) return;
    void (async () => {
      try {
        await renameHistoryProject(projectId, name);
        if (state.project?.id === projectId) {
          state.project.name = name;
          upsertHistoryProject(state.project);
        }
        state.historySignature = "";
        await loadHistory(true);
      } catch (error) {
        showToast(error?.message || "会话重命名失败");
      }
    })();
    return;
  }
  if (message.type === "custom-video:community-shared") {
    const projectId = String(message.projectId || "").trim();
    const sourceOutputId = String(message.sourceOutputId || "").trim();
    if (!projectId || !sourceOutputId || state.project?.id !== projectId) return;
    state.communitySharedOutputs[sourceOutputId] = {
      postId: String(message.postId || "shared"),
      sharedAt: Number(message.sharedAt) || Date.now(),
    };
    state.messageSignature = "";
    renderConversation(state.project);
    return;
  }
  if (message.type !== "custom-video:published") return;
  const projectId = String(message.projectId || "").trim();
  const deliveryId = String(message.deliveryId || "").trim();
  const sourceOutputId = String(message.sourceOutputId || "").trim();
  const sourceDeliveryId = String(message.sourceDeliveryId || "").trim();
  if (!projectId || !deliveryId || state.project?.id !== projectId) return;
  const receivedCount = Number(message.publishedCount || 0);
  const publishedCount = Number.isFinite(receivedCount) && receivedCount > 0
    ? Math.floor(receivedCount)
    : (
        String(state.project?._integration?.publishedDeliveryId || "") === deliveryId
          ? Math.max(1, publishedCountFor(state.project))
          : publishedCountFor(state.project) + 1
      );
  state.project._integration = {
    ...(state.project._integration || {}),
    kind: "video",
    workshopProjectId: projectId,
    publishedDeliveryId: deliveryId,
    publishedAt: Number(message.publishedAt) || Date.now(),
    publishedCount,
    publishedVideoOutputs: {
      ...publishedOutputMap(state.project),
      ...(sourceOutputId ? {
        [sourceOutputId]: {
          deliveryId,
          sourceDeliveryId,
          publishedAt: Number(message.publishedAt) || Date.now(),
          publishedCount: 1,
        },
      } : {}),
    },
  };
  state.outputSignature = "";
  state.messageSignature = "";
  renderDelivery(state.project);
  renderConversation(state.project);
  if (!dom.historyDeliveryModal.hidden) renderHistoryDeliveryModal();
  state.historySignature = "";
  loadHistory(true);
});

dom.publishOutputButton.addEventListener("click", requestSelectedOutputPublish);
dom.historyDeliveryButton.addEventListener("click", openHistoryDeliveryModal);
dom.projectAssetsButton?.addEventListener("click", openHistoryDeliveryModal);
dom.videoEditorModal?.querySelectorAll("[data-video-editor-close]").forEach(button => {
  button.addEventListener("click", closeVideoEditor);
});
dom.videoEditorSubmit?.addEventListener("click", submitVideoEditorDraft);
dom.videoEditorUndo?.addEventListener("click", editorUndo);
dom.videoEditorRedo?.addEventListener("click", editorRedo);
dom.videoEditorSplit?.addEventListener("click", splitEditorClip);
dom.videoEditorDelete?.addEventListener("click", deleteEditorSelection);
dom.videoEditorPlay?.addEventListener("click", () => {
  if (!dom.videoEditorPreview) return;
  if (dom.videoEditorPreview.paused) void dom.videoEditorPreview.play();
  else dom.videoEditorPreview.pause();
});
dom.videoEditorZoom?.addEventListener("input", () => {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft) return;
  draft.zoom = Number(dom.videoEditorZoom.value || 56);
  renderVideoEditorTimeline();
});
dom.videoEditorSubtitleText?.addEventListener("focus", () => {
  const draft = dom.videoEditorModal?.__editorDraft;
  const selected = selectedEditorEntity(draft);
  if (selected?.type === "subtitle") dom.videoEditorSubtitleText.dataset.originalValue = String(selected.item.subtitle || "");
});
dom.videoEditorSubtitleText?.addEventListener("input", () => {
  const draft = dom.videoEditorModal?.__editorDraft;
  const selected = selectedEditorEntity(draft);
  if (selected?.type !== "subtitle") return;
  selected.item.subtitle = dom.videoEditorSubtitleText.value;
  renderVideoEditorTimeline();
  renderVideoEditorPreviewLayers();
});
dom.videoEditorSubtitleText?.addEventListener("change", () => {
  const draft = dom.videoEditorModal?.__editorDraft;
  const selected = selectedEditorEntity(draft);
  if (selected?.type !== "subtitle") return;
  const nextValue = dom.videoEditorSubtitleText.value.trim();
  const originalValue = String(dom.videoEditorSubtitleText.dataset.originalValue ?? selected.item.subtitle ?? "");
  selected.item.subtitle = originalValue;
  draft.history.push(editorSnapshot(draft));
  draft.history = draft.history.slice(-80);
  draft.future = [];
  selected.item.subtitle = nextValue;
  delete dom.videoEditorSubtitleText.dataset.originalValue;
  renderVideoEditor();
});
[dom.videoEditorOverlayEntry, dom.videoEditorOverlayExit].forEach((control, index) => {
  control?.addEventListener("change", () => {
    const draft = dom.videoEditorModal?.__editorDraft;
    const selected = selectedEditorEntity(draft);
    if (selected?.type !== "overlay") return;
    commitEditorMutation(current => {
      const overlay = current.overlays.find(item => item.id === selected.item.id);
      overlay[index === 0 ? "entryEffect" : "exitEffect"] = control.value;
    });
  });
});
dom.videoEditorSubtitle?.addEventListener("change", () => {
  commitEditorMutation(draft => { draft.subtitleEffect = dom.videoEditorSubtitle.value; });
});
dom.videoEditorBgm?.addEventListener("change", () => {
  commitEditorMutation(draft => {
    draft.bgmSelection = dom.videoEditorBgm.value;
    draft.selected = { type: "bgm", id: "bgm" };
  });
});
dom.videoEditorBgmDelete?.addEventListener("click", () => {
  commitEditorMutation(draft => {
    draft.bgmSelection = "none";
    draft.selected = { type: "bgm", id: "bgm" };
  });
});
dom.videoEditorTrackVolume?.addEventListener("input", () => {
  dom.videoEditorTrackVolumeValue.textContent = `${dom.videoEditorTrackVolume.value}%`;
});
dom.videoEditorTrackVolume?.addEventListener("change", () => {
  const draft = dom.videoEditorModal?.__editorDraft;
  const selected = selectedEditorEntity(draft);
  if (!draft || !["narration", "bgm", "sound-effect"].includes(selected?.type)) return;
  const volume = Math.max(0, Math.min(2, Number(dom.videoEditorTrackVolume.value) / 100));
  commitEditorMutation(current => {
    if (selected.type === "narration") current.narrationVolume = volume;
    else if (selected.type === "bgm") current.bgmVolume = Math.min(1, volume);
    else current.soundEffects.find(item => item.id === selected.item.id).volume = Math.min(1.5, volume);
  });
});
dom.videoEditorSfx?.addEventListener("change", () => {
  const active = Boolean(dom.videoEditorSfx.value);
  dom.videoEditorSfxPreview.disabled = !active;
  dom.videoEditorSfxAdd.disabled = !active;
});
dom.videoEditorSfxPreview?.addEventListener("click", previewEditorSoundEffect);
dom.videoEditorSfxAdd?.addEventListener("click", () => {
  const draft = dom.videoEditorModal?.__editorDraft;
  const selected = selectedEditorSfxSource(draft);
  if (!draft || !selected) return;
  addEditorSoundEffect(selected.sourceType, selected.sourceId, draft.playhead);
});

function editorTimeAtPointer(event) {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft) return 0;
  const rect = dom.videoEditorTimelineCanvas.getBoundingClientRect();
  return Math.max(0, (event.clientX - rect.left) / draft.zoom);
}

function setEditorPlayhead(time, syncVideo = true) {
  const draft = dom.videoEditorModal?.__editorDraft;
  if (!draft) return;
  const total = editorClipLayout(draft).total;
  draft.playhead = Math.max(0, Math.min(total, Number(time) || 0));
  dom.videoEditorPlayhead.style.left = `${draft.playhead * draft.zoom}px`;
  dom.videoEditorTimecode.textContent = `${formatEditorTime(draft.playhead)} / ${formatEditorTime(total)}`;
  dom.videoEditorScrubber.max = String(total);
  dom.videoEditorScrubber.value = String(draft.playhead);
  if (syncVideo && Number.isFinite(dom.videoEditorPreview.duration) && dom.videoEditorPreview.duration > 0) {
    dom.videoEditorPreview.currentTime = draft.playhead / total * dom.videoEditorPreview.duration;
  }
  renderVideoEditorPreviewLayers();
}

[dom.videoEditorRuler, dom.videoEditorVideoTrack, dom.videoEditorOverlayTrack].forEach(track => {
  track?.addEventListener("click", event => {
    if (event.target.closest("article")) return;
    setEditorPlayhead(editorTimeAtPointer(event));
  });
});

dom.videoEditorPlayhead?.addEventListener("pointerdown", event => {
  event.preventDefault();
  const onMove = moveEvent => setEditorPlayhead(editorTimeAtPointer(moveEvent));
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
});

dom.videoEditorPreview?.addEventListener("timeupdate", () => {
  if (!videoEditorPlaybackFrame) syncVideoEditorPlaybackClock();
});
dom.videoEditorPreview?.addEventListener("play", () => {
  renderVideoEditorPreviewLayers();
  startVideoEditorPlaybackClock();
});
dom.videoEditorPreview?.addEventListener("pause", () => {
  stopVideoEditorPlaybackClock();
  syncVideoEditorPlaybackClock();
  renderVideoEditorPreviewLayers();
});
dom.videoEditorPreview?.addEventListener("ended", () => {
  stopVideoEditorPlaybackClock();
  syncVideoEditorPlaybackClock();
});
dom.videoEditorScrubber?.addEventListener("input", () => {
  setEditorPlayhead(Number(dom.videoEditorScrubber.value));
});

[dom.videoEditorVideoTrack, dom.videoEditorOverlayTrack, dom.videoEditorBgmTrack, dom.videoEditorSfxTrack].forEach(track => {
  track?.addEventListener("dragover", event => {
    const types = [...(event.dataTransfer?.types || [])];
    if (types.includes("Files") || types.some(type => type.startsWith("application/x-xingzhen-"))) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = types.includes("Files") || types.includes("application/x-xingzhen-asset") ? "copy" : "move";
    }
  });
  track?.addEventListener("drop", async event => {
    const draft = dom.videoEditorModal?.__editorDraft;
    if (!draft) return;
    const time = editorTimeAtPointer(event);
    const files = editorExternalFiles(event.dataTransfer);
    if (files.length) {
      event.preventDefault();
      event.stopPropagation();
      if (track === dom.videoEditorOverlayTrack) {
        await importEditorFiles(files, { target: "overlay", time });
      } else if (track === dom.videoEditorBgmTrack) {
        await importEditorFiles(files, { target: "bgm", time });
      } else if (track === dom.videoEditorSfxTrack) {
        await importEditorFiles(files, { target: "sfx", time });
      } else {
        const row = editorClipLayout(draft).rows.find(item => time >= item.start && time <= item.end);
        if (row) await importEditorFiles(files, { target: "clip", clipId: row.clip.id, time });
        else await importEditorFiles(files, { target: "overlay", time });
      }
      return;
    }
    const assetId = event.dataTransfer.getData("application/x-xingzhen-asset");
    const clipId = event.dataTransfer.getData("application/x-xingzhen-clip");
    const overlayId = event.dataTransfer.getData("application/x-xingzhen-overlay");
    if (assetId) {
      event.preventDefault();
      if (track === dom.videoEditorOverlayTrack) {
        addEditorOverlay(assetId, time);
      } else {
        const row = editorClipLayout(draft).rows.find(item => time >= item.start && time <= item.end);
        if (row) replaceEditorClipAsset(row.clip.id, assetId);
        else addEditorOverlay(assetId, time);
      }
      return;
    }
    if (clipId && track === dom.videoEditorVideoTrack) {
      event.preventDefault();
      commitEditorMutation(current => {
        const from = current.clips.findIndex(item => item.id === clipId);
        if (from < 0) return;
        const [clip] = current.clips.splice(from, 1);
        const layout = editorClipLayout(current).rows;
        const to = Math.max(0, layout.findIndex(item => time < item.start + item.duration / 2));
        current.clips.splice(to < 0 ? current.clips.length : to, 0, clip);
        current.selected = { type: "clip", id: clipId };
      });
      return;
    }
    if (overlayId && track === dom.videoEditorOverlayTrack) {
      event.preventDefault();
      commitEditorMutation(current => {
        const overlay = current.overlays.find(item => item.id === overlayId);
        if (overlay) overlay.start = Math.max(0, time - overlay.duration / 2);
        current.selected = { type: "overlay", id: overlayId };
      });
      return;
    }
    const soundEffectId = event.dataTransfer.getData("application/x-xingzhen-sfx");
    if (soundEffectId && track === dom.videoEditorSfxTrack) {
      event.preventDefault();
      event.stopPropagation();
      commitEditorMutation(current => {
        const effect = current.soundEffects.find(item => item.id === soundEffectId);
        if (effect) effect.start = Math.max(0, time - effect.duration / 2);
        current.selected = { type: "sound-effect", id: soundEffectId };
      });
    }
  });
});

document.addEventListener("keydown", event => {
  if (dom.videoEditorModal?.hidden) return;
  const inputActive = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) editorRedo(); else editorUndo();
    return;
  }
  if (!inputActive && ["Delete", "Backspace"].includes(event.key)) {
    event.preventDefault();
    deleteEditorSelection();
  }
});
dom.historyDeliveryFilter.addEventListener("change", renderHistoryDeliveryModal);
document.querySelectorAll("[data-history-delivery-close]").forEach(button => {
  button.addEventListener("click", closeHistoryDeliveryModal);
});
dom.speedVersionButton.addEventListener("click", () => {
  const output = state.project?.outputs?.[state.outputIndex] || state.project?.outputs?.[0];
  if (output) createSpeedVersion(output, dom.speedVersionSelect.value, dom.speedVersionButton);
});
dom.deliverySpeedMenu?.querySelectorAll("[data-speed-value]").forEach(button => {
  button.addEventListener("click", () => {
    selectSpeedVersion(button.dataset.speedValue);
    dom.deliverySpeedMenu.open = false;
  });
});
dom.historyDeliveryFilterMenu?.querySelectorAll("[data-history-filter-value]").forEach(button => {
  button.addEventListener("click", () => {
    selectHistoryDeliveryFilter(button.dataset.historyFilterValue);
    dom.historyDeliveryFilterMenu.open = false;
    renderHistoryDeliveryModal();
  });
});
document.addEventListener("click", event => {
  if (!event.target.closest("#deliverySpeedMenu") && dom.deliverySpeedMenu) dom.deliverySpeedMenu.open = false;
  if (!event.target.closest("#historyDeliveryFilterMenu") && dom.historyDeliveryFilterMenu) {
    dom.historyDeliveryFilterMenu.open = false;
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && dom.deliverySpeedMenu) dom.deliverySpeedMenu.open = false;
  if (event.key === "Escape" && dom.historyDeliveryFilterMenu) dom.historyDeliveryFilterMenu.open = false;
  if (event.key === "Escape" && !dom.historyDeliveryModal.hidden) closeHistoryDeliveryModal();
  if (event.key === "Escape" && !dom.videoEditorModal?.hidden) closeVideoEditor();
});
dom.deliveryToggleButton.addEventListener("click", () => {
  if (!state.project?.outputs?.length) return;
  state.deliveryCollapsed = !state.deliveryCollapsed;
  state.outputSignature = "";
  renderDelivery(state.project);
  refreshIcons();
});
dom.backButton.addEventListener("click", () => resetProject(true));
dom.historyNewButton.addEventListener("click", createNewConversation);
dom.startHistoryNewButton.addEventListener("click", () => {
  dom.startView.classList.remove("history-open");
  createNewConversation();
});
dom.startHistoryToggleButton.addEventListener("click", () => {
  dom.startView.classList.toggle("history-open");
});
installGlobalDropZone();
installVideoEditorDropZone();

async function bootstrapApplication() {
  refreshIcons();
  initializeVideoVoiceWorkbench();
  installChatComposerSafeSpace();
  typePlaceholder();
  checkHealth();
  const historyItems = await loadHistory(true);
  if (WORKSPACE_MODE) enterStudio();
  if (state.projectId) {
    await loadProject(state.projectId, true);
  } else if (WORKSPACE_MODE && !historyItems.length) {
    await createNewConversation();
  }
  if (WORKSPACE_MODE) {
    window.parent.postMessage({
      type: "custom-video:workspace-ready",
      projectId: state.projectId,
    }, window.location.origin);
  }
  window.requestAnimationFrame(() => {
    document.documentElement.classList.remove("app-booting");
  });
}

void bootstrapApplication();
