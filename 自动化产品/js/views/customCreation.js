import { go } from "../core/router.js";
import { state, canDeliver, save } from "../core/store.js";
import { uid } from "../core/util.js";
import { addAssetFromDataUrl } from "../domain/assets.js";
import { icon } from "../ui/icons.js";
import { toast } from "../ui/components.js?v=20260809-v140-production-recovery-1";
import { voiceLabView } from "./voiceLab.js?v=20260809-v140-production-recovery-1";
import { openCommunityShare, syncCommunityShareStatus } from "./communityShare.js";

const TOOLS = [
  { key: "video", label: "视频工坊", mountId: "customVideoMount" },
  { key: "canvas", label: "无限画布", mountId: "customCanvasMount" },
  { key: "voice", label: "语音生成", mountId: "customVoiceMount" }
];
const CUSTOM_PERF_KEY = "xingzhen.customCreation.performance.v1";
const HOME_LAUNCH_KEY = "starmatrix.homeLaunch.v1";
const HOME_LAUNCH_REGISTRY_KEY = "__starmatrixHomeLaunchRegistry";
const HOME_LAUNCH_TTL_MS = 10 * 60 * 1000;
const personalOutputInflight = new Set();

function dataUrlForBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取生成图片失败"));
    reader.readAsDataURL(blob);
  });
}

async function storePersonalCanvasItem(payload, item, index) {
  const projectId = String(payload?.projectId || "canvas").trim() || "canvas";
  const itemId = String(item?.sourceItemId || index + 1).trim();
  const sourceKey = `canvas:${projectId}:${itemId}`;
  if (state.assets.some(asset => asset?.sourceOutputKey === sourceKey) || personalOutputInflight.has(sourceKey)) return;
  personalOutputInflight.add(sourceKey);
  try {
    let dataUrl = String(item?.dataUrl || "").trim();
    if (!dataUrl && item?.url) {
      const response = await fetch(String(item.url), { credentials: "same-origin" });
      if (!response.ok) throw new Error(`读取画布成品失败 (${response.status})`);
      dataUrl = await dataUrlForBlob(await response.blob());
    }
    if (!/^data:image\/(?:png|jpe?g|webp);base64,/i.test(dataUrl)) return;
    const asset = await addAssetFromDataUrl(null, {
      name: item?.name || `${payload?.title || "无限画布作品"}_${String(index + 1).padStart(2, "0")}`,
      type: "图片",
      tags: ["个人资产", "无限画布", "生成图片"],
      dataUrl,
      processImage: false,
    });
    if (!asset) return;
    asset.sourceOutputKey = sourceKey;
    asset.sourceProjectId = projectId;
    asset.updatedAt = Date.now();
    save("assets", "meta");
  } catch (error) {
    console.warn("[personal-assets] canvas output", error);
  } finally {
    personalOutputInflight.delete(sourceKey);
  }
}

function storePersonalOutput(kind, payload) {
  if (state.role !== "user" || !payload || typeof payload !== "object") return;
  if (kind === "canvas") {
    (Array.isArray(payload.items) ? payload.items : []).forEach((item, index) => {
      void storePersonalCanvasItem(payload, item, index);
    });
    return;
  }
  const projectId = String(payload.projectId || "video").trim() || "video";
  const url = String(payload.videoUrl || payload.downloadUrl || payload.url || "").trim();
  if (!url) return;
  const sourceKey = `video:${projectId}:${url}`;
  if (state.assets.some(asset => asset?.sourceOutputKey === sourceKey)) return;
  const now = Date.now();
  state.assets.push({
    id: uid(),
    accountId: null,
    ownerId: state.ui.currentMemberId || null,
    name: payload.title || "视频工坊成片",
    type: "视频",
    tags: ["个人资产", "视频工坊", "生成成片"],
    createdAt: now,
    updatedAt: now,
    url,
    fileUrl: url,
    mime: "video/mp4",
    sourceOutputKey: sourceKey,
    sourceProjectId: projectId,
    aspectRatio: payload.aspectRatio || "",
  });
  save("assets", "meta");
}

function consumeHomeLaunch(mode, resourceId) {
  if (resourceId !== "__new__") return null;
  let value = null;
  try {
    value = JSON.parse(sessionStorage.getItem(HOME_LAUNCH_KEY) || "null");
    sessionStorage.removeItem(HOME_LAUNCH_KEY);
  } catch (_) {
    try { sessionStorage.removeItem(HOME_LAUNCH_KEY); } catch (_) {}
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const launchToken = String(value.launchToken || "").trim();
  const registry = window[HOME_LAUNCH_REGISTRY_KEY];
  const entry = launchToken && registry instanceof Map ? registry.get(launchToken) : null;
  if (launchToken && registry instanceof Map) registry.delete(launchToken);
  const stagedPayload = entry?.payload && typeof entry.payload === "object"
    ? entry.payload
    : null;
  const createdAt = Number(stagedPayload?.createdAt || value.createdAt || 0);
  const expired = !createdAt || Date.now() - createdAt > HOME_LAUNCH_TTL_MS;
  if (value.mode !== mode || (stagedPayload?.mode && stagedPayload.mode !== mode) || expired) return null;
  if (launchToken && !stagedPayload && Number(value.attachmentCount || 0) > 0) {
    toast("首页附件暂存已失效，请返回首页重新添加", "error");
  }
  return {
    ...value,
    ...(stagedPayload || {}),
    attachments: Array.isArray(stagedPayload?.attachments)
      ? stagedPayload.attachments
      : Array.isArray(value.attachments) ? value.attachments : [],
  };
}

function perfNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function recordCustomPerformance(stage, startedAt, detail = {}) {
  const entry = {
    stage,
    durationMs: Math.max(0, Math.round(perfNow() - Number(startedAt || 0))),
    at: Date.now(),
    ...detail
  };
  try {
    const previous = JSON.parse(sessionStorage.getItem(CUSTOM_PERF_KEY) || "[]");
    const items = Array.isArray(previous) ? previous.slice(-59) : [];
    items.push(entry);
    sessionStorage.setItem(CUSTOM_PERF_KEY, JSON.stringify(items));
  } catch (_) {}
  window.__xingzhenCustomPerformance = [
    ...(Array.isArray(window.__xingzhenCustomPerformance) ? window.__xingzhenCustomPerformance.slice(-59) : []),
    entry
  ];
  console.debug("[custom-performance]", entry);
  return entry;
}

function normalizedPage(page) {
  return TOOLS.some(tool => tool.key === page) ? page : "video";
}

function appLoadingHtml(tool) {
  return `
    <div class="custom-app-loading" data-custom-loading>
      <span class="spin-dot"></span>
      <b>正在打开${tool.label}</b>
      <em>首次加载会初始化独立运行环境</em>
    </div>
  `;
}

function tabsHtml(activePage) {
  return TOOLS.map(tool => {
    return `<button
      class="custom-creation-tab ${tool.key === activePage ? "is-active" : ""}"
      type="button"
      role="tab"
      id="customTab-${tool.key}"
      aria-controls="${tool.mountId}"
      aria-selected="${tool.key === activePage ? "true" : "false"}"
      tabindex="${tool.key === activePage ? "0" : "-1"}"
      data-custom-tab="${tool.key}"
    ><span>${tool.label}</span></button>`;
  }).join("");
}

function hostsHtml(activePage) {
  return TOOLS.map(tool => {
    const active = tool.key === activePage;
    return `
      <div
        class="custom-tool-host ${tool.key === "voice" ? "is-voice" : ""} ${active ? "is-active" : ""}"
        id="${tool.mountId}"
        role="tabpanel"
        aria-labelledby="customTab-${tool.key}"
        aria-hidden="${active ? "false" : "true"}"
        data-custom-tool-host="${tool.key}"
        ${active ? "" : "hidden"}
      >
        ${tool.key === "voice" ? "" : `<div class="custom-app-mount" data-custom-app-mount="${tool.key}">${appLoadingHtml(tool)}</div>`}
      </div>
    `;
  }).join("");
}

export const customCreationView = {
  render(root, { page, resourceId } = {}) {
    const renderStarted = perfNow();
    const activePage = normalizedPage(page);
    const homeLaunch = consumeHomeLaunch(activePage, resourceId);
    const existing = root.__customCreationContext;
    if (existing?.shell?.isConnected) {
      existing.activate(activePage, resourceId);
      if (homeLaunch) existing.prefill?.(activePage, homeLaunch);
      return;
    }

    root.__viewCleanup?.();
    const controller = new AbortController();
    const { signal } = controller;
    let resizeObserver = null;
    const mountedTools = new Map();
    const pendingProjectIds = new Map();
    if (resourceId && ["video", "canvas"].includes(activePage)) {
      pendingProjectIds.set(activePage, String(resourceId));
    }

    root.innerHTML = `
      <div class="custom-creation-shell" data-custom-page="${activePage}">
        <header class="custom-creation-header">
          <button class="custom-creation-back" type="button" data-custom-back>
            ${icon("arrowLeft", 15)}<span>返回首页</span>
          </button>
          <nav class="custom-creation-tabs" role="tablist" aria-label="定制创作工具">
            ${tabsHtml(activePage)}
            <i class="custom-creation-indicator" aria-hidden="true"></i>
          </nav>
          <span class="custom-creation-header-spacer" aria-hidden="true"></span>
        </header>
        <section class="custom-creation-stage" data-custom-stage="${activePage}">
          ${hostsHtml(activePage)}
        </section>
      </div>
    `;
    recordCustomPerformance("shell-render", renderStarted, { tool: activePage });

    const shell = root.querySelector(".custom-creation-shell");
    const stage = root.querySelector(".custom-creation-stage");
    const tabs = [...root.querySelectorAll("[data-custom-tab]")];
    const tabsHost = root.querySelector(".custom-creation-tabs");
    const indicator = root.querySelector(".custom-creation-indicator");
    const activeTab = () => root.querySelector(`[data-custom-tab="${shell?.dataset.customPage || "video"}"]`);
    const setLatestOutput = (key, payload) => {
      const host = root.querySelector(`[data-custom-tool-host="${key}"]`);
      if (!host || !payload) return null;
      const previous = host.__customLatestOutput;
      const sameProject = (
        previous
        && payload.projectId
        && previous.projectId === payload.projectId
      );
      host.__customLatestOutput = {
        ...(sameProject ? previous : {}),
        ...payload,
        kind: key === "canvas" ? "canvas" : "video"
      };
      storePersonalOutput(key, host.__customLatestOutput);
      return host.__customLatestOutput;
    };
    const communityPayloadFor = (key, output) => {
      if (!output) return null;
      const sourceOutputId = String(output.sourceOutputId || output.items?.[0]?.sourceItemId || "").trim();
      const sourceProjectId = String(output.projectId || "").trim();
      const sourceItemIds = key === "canvas"
        ? [...new Set((output.items || [])
            .map(item => String(item?.sourceItemId || "").trim())
            .filter(Boolean))]
        : [];
      const media = key === "canvas"
        ? (output.items || []).map(item => ({ ...item, type: "image" }))
        : [{ type: "video", url: output.videoUrl || output.downloadUrl || output.url || "" }];
      return {
        authorId: String(output.ownerId || ""),
        sourceKind: key === "canvas" ? "canvas" : "video",
        sourceId: sourceProjectId,
        sourceProjectId,
        sourceOutputId: key === "video" ? sourceOutputId : "",
        sourceItemIds,
        title: output.title || (key === "canvas" ? "无限画布灵感" : "视频工坊灵感"),
        copy: output.copy || output.description || "",
        prompt: output.prompt || output.promptText || "",
        category: key === "canvas" ? "视觉设计" : "视频灵感",
        media,
      };
    };
    const markRuntimeCommunityShared = (key, output, post) => {
      mountedTools.get(key)?.markCommunityShared?.({
        projectId: output?.projectId || "",
        sourceOutputId: output?.sourceOutputId || output?.items?.[0]?.sourceItemId || "",
        postId: post?.id || "",
        sharedAt: post?.createdAt || Date.now(),
      });
    };
    const openCommunityFor = (key, output, trigger = null) => {
      const payload = communityPayloadFor(key, output);
      if (!payload) return;
      openCommunityShare({
        ...payload,
        trigger,
        onShared: post => markRuntimeCommunityShared(key, output, post),
      });
    };
    const syncCommunityFor = (key, output, trigger = null) => {
      const payload = communityPayloadFor(key, output);
      if (!payload) return;
      void syncCommunityShareStatus(trigger, payload, {
        onShared: post => markRuntimeCommunityShared(key, output, post),
      });
    };
    const openPublishFor = async (key, payload = null) => {
      if (!canDeliver()) {
        toast("当前账号不包含发布能力，请升级专业版或加入团队。");
        return;
      }
      const host = root.querySelector(`[data-custom-tool-host="${key}"]`);
      const runtime = mountedTools.get(key);
      const mergedPayload = payload ? setLatestOutput(key, payload) : null;
      const output = mergedPayload || host?.__customLatestOutput || runtime?.getLatestOutput?.();
      if (!output) {
        toast(key === "canvas" ? "当前画布还没有可发布的图片" : "请先在视频工坊完成成片");
        return;
      }
      const { openCustomPublish } = await import("./customPublish.js?v=20260809-v140-production-recovery-1");
      output.kind = key === "canvas" ? "canvas" : "video";
      openCustomPublish(
        output,
        {
          onPublished(asset, { customProjectId, publishedCount } = {}) {
            const latest = host?.__customLatestOutput;
            if (latest && customProjectId) latest.customProjectId = customProjectId;
            if (latest && asset?.id) latest.publishedDeliveryId = asset.id;
            if (latest && Number(publishedCount) > 0) {
              latest.publishedCount = Math.floor(Number(publishedCount));
            }
            if (key === "video" && Number(publishedCount) > 0) {
              window.dispatchEvent(new CustomEvent("xingzhen:video-published", {
                detail: {
                  projectId: output.projectId || latest?.projectId || "",
                  publishedCount: Math.floor(Number(publishedCount)),
                },
              }));
            }
            runtime?.markPublished?.({
              projectId: output.projectId || latest?.projectId || "",
              deliveryId: asset?.id || "",
              sourceDeliveryId: output.sourceDeliveryId || "",
              sourceOutputId: output.sourceOutputId || "",
              publishedAt: Date.now(),
              publishedCount,
              itemIds: (output.items || [])
                .map(item => item?.sourceItemId || "")
                .filter(Boolean)
            });
          }
        }
      );
    };
    const requestPublishFor = (key, payload = null) => {
      void openPublishFor(key, payload).catch(error => {
        console.error("[custom-publish-open]", error);
        toast(error?.message || "发布面板打开失败", "error");
      });
    };
    const showMountError = (host, message) => {
      const loading = host?.querySelector("[data-custom-loading]");
      if (!loading) return;
      loading.classList.add("is-error");
      loading.innerHTML = `${icon("alert", 18)}<b>子应用加载失败</b><em>${String(message || "请刷新后重试")}</em>`;
    };
    const mountTool = async key => {
      if (key === "voice" || mountedTools.has(key)) return;
      const mountStarted = perfNow();
      const host = root.querySelector(`[data-custom-tool-host="${key}"]`);
      const mountRoot = host?.querySelector(`[data-custom-app-mount="${key}"]`);
      if (!host || !mountRoot) return;
      mountedTools.set(key, { loading: true });
      try {
        const module = key === "video"
          ? await import("./customVideoIntegration.js?v=20260809-v140-production-recovery-1")
          : await import("./customCanvasIntegration.js?v=20260809-v140-production-recovery-1");
        const mount = key === "video" ? module.mountCustomVideo : module.mountCustomCanvas;
        if (typeof mount !== "function") throw new Error(`缺少 ${key} 挂载函数`);
        const initialProjectId = pendingProjectIds.get(key);
        const routedProjectId = initialProjectId && initialProjectId !== "__new__"
          ? initialProjectId
          : "";
        if (routedProjectId) pendingProjectIds.delete(key);
        const mounted = await mount(mountRoot, {
          projectId: routedProjectId,
          launchPayload: key === activePage ? homeLaunch : null,
          canPublish: canDeliver(),
          onOutput: payload => {
            const output = setLatestOutput(key, payload);
            if (output) queueMicrotask(() => syncCommunityFor(key, output));
          },
          onPublishRequest: payload => requestPublishFor(key, payload),
          onCommunityShareRequest: payload => {
            const output = setLatestOutput(key, payload);
            if (output) openCommunityFor(key, output);
          },
          ownerId: state.ui.currentMemberId || ""
        });
        mountedTools.set(key, {
          cleanup: () => {
            if (typeof mounted === "function") mounted();
            else (mounted?.cleanup || mounted?.destroy)?.call(mounted);
          },
          getLatestOutput: typeof mounted?.getLatestOutput === "function"
            ? mounted.getLatestOutput
            : null,
          markPublished: typeof mounted?.markPublished === "function"
            ? payload => mounted.markPublished(payload)
            : null,
          markCommunityShared: typeof mounted?.markCommunityShared === "function"
            ? payload => mounted.markCommunityShared(payload)
            : null,
          openProject: typeof mounted?.openProject === "function"
            ? projectId => mounted.openProject(projectId)
            : null,
          createProject: typeof mounted?.createProject === "function"
            ? () => mounted.createProject()
            : null,
          prefill: typeof mounted?.prefill === "function"
            ? payload => mounted.prefill(payload)
            : null,
        });
        const pendingProjectId = pendingProjectIds.get(key);
        if (
          pendingProjectId === "__new__"
          && mountedTools.get(key)?.createProject
        ) {
          pendingProjectIds.delete(key);
          mountedTools.get(key).createProject();
        } else if (pendingProjectId && mountedTools.get(key)?.openProject) {
          pendingProjectIds.delete(key);
          mountedTools.get(key).openProject(pendingProjectId);
        }
        const latest = mounted?.latestOutput || mountedTools.get(key)?.getLatestOutput?.();
        if (latest) {
          const output = setLatestOutput(key, latest);
          syncCommunityFor(key, output);
        }
        recordCustomPerformance("tool-mount", mountStarted, { tool: key, ok: true });
      } catch (error) {
        mountedTools.delete(key);
        showMountError(host, error?.message || error);
        recordCustomPerformance("tool-mount", mountStarted, { tool: key, ok: false });
      }
    };
    const prefill = (key, payload) => {
      if (!payload) return false;
      const runtime = mountedTools.get(key);
      if (runtime?.prefill) return runtime.prefill(payload);
      return false;
    };
    const positionIndicator = tab => {
      if (!tab || !tabsHost || !indicator) return;
      const hostRect = tabsHost.getBoundingClientRect();
      const tabRect = tab.getBoundingClientRect();
      indicator.style.width = `${tabRect.width}px`;
      indicator.style.transform = `translate3d(${tabRect.left - hostRect.left}px, 0, 0)`;
    };
    const activate = (nextPage, nextResourceId = null) => {
      const activateStarted = perfNow();
      const next = normalizedPage(nextPage);
      if (nextResourceId && ["video", "canvas"].includes(next)) {
        const projectId = String(nextResourceId);
        const runtime = mountedTools.get(next);
        if (projectId === "__new__" && runtime?.createProject) runtime.createProject();
        else if (runtime?.openProject) runtime.openProject(projectId);
        else pendingProjectIds.set(next, projectId);
      }
      if (shell) shell.dataset.customPage = next;
      if (stage) {
        stage.dataset.customStage = next;
      }
      tabs.forEach(tab => {
        const selected = tab.dataset.customTab === next;
        tab.classList.toggle("is-active", selected);
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        tab.tabIndex = selected ? 0 : -1;
      });
      root.querySelectorAll("[data-custom-tool-host]").forEach(host => {
        const selected = host.dataset.customToolHost === next;
        host.hidden = !selected;
        host.classList.toggle("is-active", selected);
        host.setAttribute("aria-hidden", selected ? "false" : "true");
        if (!selected && host.dataset.customToolHost === "voice") {
          host.querySelectorAll("audio, video").forEach(media => {
            try { media.pause(); } catch (_) {}
          });
        }
      });
      const voiceHost = root.querySelector('[data-custom-tool-host="voice"]');
      if (next === "voice" && voiceHost && voiceHost.dataset.customMounted !== "true") {
        const voiceStarted = perfNow();
        voiceLabView.render(voiceHost, { embedded: true });
        voiceHost.dataset.customMounted = "true";
        recordCustomPerformance("tool-mount", voiceStarted, { tool: "voice", ok: true });
      }
      if (next !== "voice") mountTool(next);
      requestAnimationFrame(() => {
        positionIndicator(activeTab());
        recordCustomPerformance("tab-activate", activateStarted, { tool: next });
      });
    };

    root.querySelector("[data-custom-back]")?.addEventListener("click", () => go("overview"), { signal });
    tabs.forEach(tab => {
      tab.addEventListener("pointerenter", () => positionIndicator(tab), { signal });
      tab.addEventListener("click", () => {
        const next = tab.dataset.customTab || "video";
        if (next !== shell?.dataset.customPage) go("custom", next);
      }, { signal });
    });
    tabsHost?.addEventListener("pointerleave", () => positionIndicator(activeTab()), { signal });
    tabsHost?.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = Math.max(0, tabs.indexOf(document.activeElement));
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[nextIndex]?.focus();
    }, { signal });
    window.addEventListener("xingzhen:canvas-hydrated", event => {
      const detail = event?.detail || {};
      recordCustomPerformance("canvas-hydration", perfNow() - Number(detail.durationMs || 0), {
        tool: "canvas",
        projectCount: Number(detail.projectCount || 0)
      });
    }, { signal });
    requestAnimationFrame(() => positionIndicator(activeTab()));
    if ("ResizeObserver" in window && tabsHost) {
      resizeObserver = new ResizeObserver(() => positionIndicator(activeTab()));
      resizeObserver.observe(tabsHost);
    }

    root.__customCreationContext = { shell, activate, prefill };
    activate(activePage, resourceId);

    root.__viewCleanup = () => {
      controller.abort();
      resizeObserver?.disconnect();
      root.querySelectorAll("[data-custom-tool-host] audio, [data-custom-tool-host] video").forEach(media => {
        try { media.pause(); } catch (e) {}
      });
      mountedTools.forEach(runtime => {
        try { runtime?.cleanup?.(); } catch (error) { console.warn("[custom-tool-cleanup]", error); }
      });
      mountedTools.clear();
      root.__customCreationContext = null;
    };
  }
};
