const PROJECT_STORAGE_KEY =
  window.__XINGZHEN_VIDEO_PROJECT_KEY__ || "xingzhen-video-project:standalone";
const START_ON_HOME =
  new URLSearchParams(window.location.search).get("start") === "home";
const state = {
  // 主平台每次重新进入“定制创作”都从新建首页开始；历史项目仍保留在
  // 当前成员的列表中，用户主动选择后会在这个 iframe 会话里正常保持。
  projectId: START_ON_HOME ? "" : localStorage.getItem(PROJECT_STORAGE_KEY) || "",
  project: null,
  attachments: [],
  ratio: "9:16",
  outputIndex: 0,
  busy: false,
  pollTimer: null,
  messageSignature: "",
  eventSignature: "",
  outputSignature: "",
  outputMediaSignature: "",
  historySignature: "",
  historyLoadedAt: 0,
  pendingThoughtTimer: null,
  pendingRequestToken: "",
  pendingScrollMessageId: "",
  deliveryProjectId: "",
  deliveryCollapsed: false,
  productionHeartbeatTimer: null,
  productionHeartbeatProjectId: "",
  productionHeartbeatStartedAt: 0,
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

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add("show");
  toastTimer = window.setTimeout(() => dom.toast.classList.remove("show"), 2800);
}

function showAttachmentError(error, fallback = "附件处理失败，请重试") {
  const detail = String(error?.message || "").trim();
  showToast(detail ? `${fallback}：${detail}` : fallback);
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
      const existingAssets = state.project?.assets || [];
      if (existingAssets.length + state.attachments.length >= 8) {
        showToast("每个项目最多添加 8 个附件");
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
      const sameTypeCount = [...existingAssets, ...state.attachments]
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

function enterStudio() {
  dom.startView.classList.add("is-hidden");
  dom.studioView.classList.remove("is-hidden");
}

function createMessage(message, isRetryTarget = false) {
  const article = document.createElement("article");
  article.className = `message ${message.role}${message.kind === "error" ? " error" : ""}${message.kind === "pending" ? " pending" : ""}`;
  article.dataset.messageId = message.id || "";

  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = message.role === "user" ? "YOU" : message.kind === "plan" ? "DIRECTOR" : "XINGZHEN";

  const content = document.createElement("div");
  content.className = "message-content";
  if (message.kind === "pending") {
    const ring = document.createElement("span");
    ring.className = "activity-ring";
    ring.setAttribute("aria-hidden", "true");
    const pendingText = document.createElement("span");
    pendingText.className = "pending-live-text";
    pendingText.textContent = assistantText(message.content);
    content.append(ring, pendingText);
  } else {
    content.textContent = message.role === "assistant"
      ? assistantText(message.content)
      : publicText(message.content);
  }
  article.append(label);

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

  article.append(content);

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

  if (isRetryTarget && ["safe_rewrite", "resume_missing"].includes(state.project?.retryable?.type)) {
    const sceneNumber = Number(state.project.retryable.sceneNumber || 0);
    const isResume = state.project.retryable.type === "resume_missing";
    const isCopyright = state.project.retryable.reason === "copyright";
    const actionLabel = isResume
      ? `继续缺失镜头 ${sceneNumber}`
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
  return article;
}

function createLiveProductionIndicator(project) {
  const article = document.createElement("article");
  article.className = "message assistant production-live";
  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = "XINGZHEN";
  const content = document.createElement("div");
  content.className = "message-content";
  const ring = document.createElement("span");
  ring.className = "activity-ring";
  ring.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "production-live-text";
  text.textContent = assistantText(project.events?.at(-1)?.title || "制作任务正在运行");
  content.append(ring, text);
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.className = "stop-production-button";
  stopButton.title = "立即停止当前执行；已完成文件会保留，但不伪装为可无损暂停";
  const stopIcon = document.createElement("i");
  stopIcon.dataset.lucide = "square";
  const stopLabel = document.createElement("span");
  stopLabel.textContent = "停止制作";
  stopButton.append(stopIcon, stopLabel);
  stopButton.addEventListener("click", () => stopProject(stopButton));
  actions.append(stopButton);
  article.append(label, content, actions);
  return article;
}

function renderConversation(project) {
  const errorMessages = (project.messages || []).filter((item) => item.kind === "error");
  const retryMessageId = project.retryable ? errorMessages.at(-1)?.id : "";
  const signature = JSON.stringify({
    messages: (project.messages || []).map((item) => [item.id, item.content, item.kind, item.attachments, item.suggestions]),
    thoughts: project.plan?.public_thoughts || null,
    assetAssignments: project.plan?.asset_assignments || null,
    retryable: project.retryable || null,
    status: project.status,
  });
  if (signature === state.messageSignature) return;
  state.messageSignature = signature;
  const previousCount = dom.conversation.children.length;
  const wasNearBottom = dom.conversationColumn.scrollHeight - dom.conversationColumn.scrollTop - dom.conversationColumn.clientHeight < 140;
  const messages = (project.messages || []).map((message) => createMessage(message, message.id === retryMessageId));
  if (project.status === "running") messages.push(createLiveProductionIndicator(project));
  dom.conversation.replaceChildren(...messages);
  const pendingScrollId = state.pendingScrollMessageId;
  if (pendingScrollId) {
    state.pendingScrollMessageId = "";
    window.requestAnimationFrame(() => {
      const target = [...dom.conversation.children]
        .find(item => item.dataset.messageId === pendingScrollId);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  } else if ((project.messages || []).length !== previousCount && wasNearBottom) {
    window.requestAnimationFrame(() => {
      dom.conversationColumn.scrollTo({ top: dom.conversationColumn.scrollHeight, behavior: "smooth" });
    });
  }
}

function renderEvents(project) {
  const events = [];
  const generationIndexes = new Map();
  (project.events || []).forEach((event) => {
    if (event.title.startsWith("Seedance 正在生成镜头")) {
      const existingIndex = generationIndexes.get(event.title);
      if (existingIndex !== undefined) {
        events.splice(existingIndex, 1);
        generationIndexes.forEach((value, key) => {
          if (value > existingIndex) generationIndexes.set(key, value - 1);
        });
      }
      generationIndexes.set(event.title, events.length);
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
  const liveText = document.querySelector(".production-live-text");
  if (liveText && events.length) liveText.textContent = assistantText(events.at(-1).title || "制作任务正在运行");
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
}

function selectedPublishPayload() {
  const project = state.project;
  const output = project?.outputs?.[state.outputIndex];
  const videoUrl = String(output?.url || output?.downloadUrl || "");
  if (project?.status !== "succeeded" || !project?.id || !videoUrl) return null;
  const title = String(
    (project.name && project.name !== "新会话" ? project.name : "")
    || project.plan?.title
    || "未命名视频"
  ).trim() || "未命名视频";
  return {
    kind: "video",
    projectId: String(project.id),
    title,
    videoUrl,
    url: videoUrl,
    downloadUrl: String(output.downloadUrl || videoUrl),
    aspectRatio: String(output.aspectRatio || project.plan?.aspect_ratio || "9:16"),
    plan: project.plan || null,
    project,
    status: String(project.status || ""),
    publishedCount: publishedCountFor(project),
  };
}

function requestSelectedOutputPublish() {
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

function renderDelivery(project) {
  const outputs = project.outputs || [];
  const publishedDeliveryId = String(project?._integration?.publishedDeliveryId || "");
  const publishedCount = publishedCountFor(project);
  if (state.deliveryProjectId !== project.id) {
    state.deliveryProjectId = project.id;
    state.deliveryCollapsed = false;
  }
  const mediaSignature = JSON.stringify({
    updatedAt: project.updatedAt || "",
    outputs: outputs.map((item) => [
      item.id || "",
      item.url,
      item.aspectRatio,
      item.probe?.duration,
      item.updatedAt || "",
    ]),
  });
  const mediaChanged = mediaSignature !== state.outputMediaSignature;
  const signature = JSON.stringify({
    status: project.status,
    embedded: document.documentElement.dataset.platformEmbedded === "true",
    publishedDeliveryId,
    publishedCount,
    deliveryCollapsed: state.deliveryCollapsed,
    mediaSignature,
  });
  if (signature === state.outputSignature) return;
  state.outputSignature = signature;
  state.outputMediaSignature = mediaSignature;
  if (!outputs.length) {
    dom.delivery.classList.add("is-hidden");
    dom.publishOutputButton.hidden = true;
    dom.publishedOutputBadge.hidden = true;
    return;
  }
  dom.delivery.classList.remove("is-hidden");
  dom.delivery.classList.toggle("is-collapsed", state.deliveryCollapsed);
  dom.deliveryToggleButton.setAttribute("aria-expanded", String(!state.deliveryCollapsed));
  dom.deliveryToggleButton.querySelector("span").textContent = state.deliveryCollapsed
    ? "展开成片"
    : "收起成片";
  dom.deliveryToggleButton.querySelector("svg, i")?.setAttribute(
    "data-lucide",
    state.deliveryCollapsed ? "chevron-down" : "chevron-up",
  );
  dom.publishedOutputBadge.hidden = publishedCount < 1;
  dom.publishedOutputBadgeText.textContent = publishedCount > 0
    ? `已发布 ${publishedCount}`
    : "已发布";
  dom.publishedOutputBadge.title = publishedCount > 0
    ? `当前会话已有 ${publishedCount} 条有效发布${publishedDeliveryId ? ` · 最近 ${publishedDeliveryId}` : ""}`
    : "";
  dom.publishOutputButton.hidden = !(
    project.status === "succeeded"
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

function stopProductionHeartbeat() {
  window.clearInterval(state.productionHeartbeatTimer);
  state.productionHeartbeatTimer = null;
  state.productionHeartbeatProjectId = "";
  state.productionHeartbeatStartedAt = 0;
}

function startProductionHeartbeat(project) {
  if (state.productionHeartbeatTimer && state.productionHeartbeatProjectId === project.id) return;
  stopProductionHeartbeat();
  state.productionHeartbeatProjectId = project.id;
  state.productionHeartbeatStartedAt = Date.now();
  let index = 0;
  state.productionHeartbeatTimer = window.setInterval(() => {
    if (state.project?.id !== project.id || state.project?.status !== "running") {
      stopProductionHeartbeat();
      return;
    }
    const liveText = document.querySelector(".production-live-text");
    if (!liveText) return;
    const latestTitle = assistantText(state.project.events?.at(-1)?.title || "制作任务正在运行");
    const elapsed = Math.max(1, Math.round((Date.now() - state.productionHeartbeatStartedAt) / 1000));
    liveText.textContent = `${latestTitle} · ${productionHeartbeatStages[index % productionHeartbeatStages.length]} ${elapsed} 秒`;
    index += 1;
  }, 3000);
}

function renderProject(project) {
  state.project = project;
  state.projectId = project.id;
  state.ratio = project.plan?.aspect_ratio || state.ratio;
  localStorage.setItem(PROJECT_STORAGE_KEY, project.id);
  enterStudio();
  dom.projectLabel.textContent = project.name && project.name !== "新会话"
    ? project.name
    : project.plan?.title || `项目 ${project.id.slice(0, 6)}`;
  renderConversation(project);
  renderEvents(project);
  renderDelivery(project);

  const running = project.status === "running";
  if (running) startProductionHeartbeat(project);
  else stopProductionHeartbeat();
  dom.chatInput.disabled = running;
  dom.chatForm.querySelector("button[type='submit']").disabled = running;
  refreshIcons();
  loadHistory();
  schedulePoll(running);
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
  refreshIcons();
}

async function loadHistory(force = false) {
  const now = Date.now();
  if (!force && now - state.historyLoadedAt < 4000) return;
  state.historyLoadedAt = now;
  try {
    const response = await fetch("/api/projects", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    renderHistory(data.items || []);
  } catch {
    // History is secondary to the active creation flow.
  }
}

async function loadProject(projectId, silent = false) {
  try {
    const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
    if (!response.ok) throw new Error("项目不存在");
    renderProject(await response.json());
  } catch (error) {
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

const pendingThoughtStages = [
  ["正在提取核心诉求", "从你的描述中识别主题、受众和最重要的表达目标"],
  ["正在识别附件用途", "判断图片、视频和音频分别承担参考、剪辑、口播或声音设计"],
  ["正在听取口播时间线", "口播音频会先转写，再按真实语义和时长组织镜头"],
  ["正在判断画幅与节奏", "根据描述确认画幅，并自主决定成片长度和镜头数量"],
  ["正在组织镜头关系", "为每个叙事节点选择连续、跳切或转场方式"],
  ["正在检查口播与画面", "避免视觉信息和旁白相互争抢，保留清晰字幕空间"],
  ["正在整理导演方案", "把创意转换成可执行的配音、画面和合成任务"],
];

function stopPendingThoughts() {
  window.clearInterval(state.pendingThoughtTimer);
  state.pendingThoughtTimer = null;
}

function startPendingThoughts(token, attachments) {
  stopPendingThoughts();
  state.pendingRequestToken = token;
  const startedAt = Date.now();
  const hasAssets = attachments.length > 0;
  const hasAudio = attachments.some((item) => String(item.mime || "").startsWith("audio/"));
  const stages = pendingThoughtStages.filter(([title]) => {
    if (title === "正在识别附件用途" && !hasAssets) return false;
    if (title === "正在听取口播时间线" && !hasAudio) return false;
    return true;
  });
  let index = 0;
  state.pendingThoughtTimer = window.setInterval(() => {
    if (!state.busy || state.pendingRequestToken !== token || !state.project) {
      stopPendingThoughts();
      return;
    }
    const pendingMessage = (state.project.messages || []).find((item) => item.id === `${token}-assistant`);
    if (!pendingMessage) {
      stopPendingThoughts();
      return;
    }
    const stage = stages[index % stages.length];
    const cycle = Math.floor(index / stages.length);
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const title = cycle > 0 ? `仍在完善方案 · ${elapsed} 秒` : stage[0];
    const detail = cycle > 0 ? `${stage[1]}，导演任务保持连接` : stage[1];
    pendingMessage.content = title;
    state.project.events = [
      ...(state.project.events || []),
      {
        id: `${token}-event-${index}`,
        title,
        detail,
        status: "running",
      },
    ];
    state.eventSignature = "";
    const pendingText = dom.conversation.querySelector(
      `[data-message-id="${pendingMessage.id}"] .pending-live-text`,
    );
    if (pendingText) pendingText.textContent = publicText(title);
    renderEvents(state.project);
    index += 1;
  }, 1800);
}

function renderPendingRequest(message, attachments) {
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
        content: "正在理解你的需求",
      },
    ],
    events: [
      ...(current.events || []),
      {
        id: `${pendingId}-event`,
        title: "导演正在理解你的需求",
        detail: "正在判断主题、受众、叙事结构和附件用途",
        status: "running",
      },
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
  startPendingThoughts(pendingId, attachments);
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
  const requestProjectId = state.projectId;
  let requestAttachments = [];
  let pendingToken = "";
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
    pendingToken = renderPendingRequest(cleanMessage, requestAttachments);
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: requestProjectId,
        message: cleanMessage,
        aspectRatio: state.ratio,
        attachments: requestAttachments.map(({ label, name, mime, dataUrl }) => ({ label, name, mime, dataUrl })),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "导演请求失败");
    requestAccepted = true;
    stopPendingThoughts();
    renderProject(data);
  } catch (error) {
    stopPendingThoughts();
    const errorMessage = String(error?.message || error || "请求失败");
    if (pendingToken) {
      try {
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
    }
    showToast(errorMessage);
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
  const isResume = retryType === "resume_missing";
  const isCopyright = state.project?.retryable?.reason === "copyright";
  state.busy = true;
  button.disabled = true;
  button.classList.add("is-loading");
  const label = button.querySelector("span");
  if (label) label.textContent = isResume ? "正在恢复缺失镜头" : `导演正在${isCopyright ? "原创" : "安全"}改写`;
  try {
    const response = await fetch(`/api/projects/${state.projectId}/retry`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || (isResume ? "恢复制作失败" : "安全改写失败"));
    state.messageSignature = "";
    state.eventSignature = "";
    state.historySignature = "";
    renderProject(data);
    showToast(isResume ? "已保留完成素材，正在恢复缺失镜头" : "已保留成功素材，正在重试失败镜头");
  } catch (error) {
    showToast(error.message || (isResume ? "恢复制作失败" : "安全改写失败"));
    button.disabled = false;
    button.classList.remove("is-loading");
    if (label) {
      label.textContent = isResume
        ? `继续缺失镜头 ${sceneNumber}`
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
  window.clearTimeout(state.pollTimer);
  stopPendingThoughts();
  stopProductionHeartbeat();
  state.projectId = "";
  state.project = null;
  state.attachments = [];
  state.outputIndex = 0;
  state.messageSignature = "";
  state.eventSignature = "";
  state.outputSignature = "";
  state.historySignature = "";
  state.pendingScrollMessageId = "";
  state.deliveryProjectId = "";
  state.deliveryCollapsed = false;
  localStorage.removeItem(PROJECT_STORAGE_KEY);
  renderAttachments();
  if (showStart) {
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
      await addFiles(files);
    } catch (error) {
      showAttachmentError(error);
    }
  });
  window.addEventListener("blur", resetDragging);
  window.addEventListener("dragend", resetDragging);
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
  sendMessage(dom.chatInput.value, false);
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
  if (message.type !== "custom-video:published") return;
  const projectId = String(message.projectId || "").trim();
  const deliveryId = String(message.deliveryId || "").trim();
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
  };
  state.outputSignature = "";
  renderDelivery(state.project);
  state.historySignature = "";
  loadHistory(true);
});

dom.publishOutputButton.addEventListener("click", requestSelectedOutputPublish);
dom.deliveryToggleButton.addEventListener("click", () => {
  if (!state.project?.outputs?.length) return;
  state.deliveryCollapsed = !state.deliveryCollapsed;
  state.outputSignature = "";
  renderDelivery(state.project);
  refreshIcons();
});
dom.backButton.addEventListener("click", () => resetProject(true));
dom.historyNewButton.addEventListener("click", () => resetProject(true));
dom.startHistoryNewButton.addEventListener("click", () => {
  dom.startView.classList.remove("history-open");
  resetProject(true);
});
dom.startHistoryToggleButton.addEventListener("click", () => {
  dom.startView.classList.toggle("history-open");
});
installGlobalDropZone();

refreshIcons();
typePlaceholder();
checkHealth();
loadHistory(true);
if (state.projectId) loadProject(state.projectId, true);
