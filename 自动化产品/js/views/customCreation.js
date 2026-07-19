import { go } from "../core/router.js";
import { state } from "../core/store.js";
import { icon } from "../ui/icons.js";
import { toast } from "../ui/components.js";
import { voiceLabView } from "./voiceLab.js?v=20260718-v94-1";

const TOOLS = [
  { key: "video", label: "视频工坊", mountId: "customVideoMount" },
  { key: "canvas", label: "无限画布", mountId: "customCanvasMount" },
  { key: "voice", label: "语音生成", mountId: "customVoiceMount" }
];
const CUSTOM_PERF_KEY = "xingzhen.customCreation.performance.v1";

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
  render(root, { page } = {}) {
    const renderStarted = perfNow();
    const activePage = normalizedPage(page);
    const existing = root.__customCreationContext;
    if (existing?.shell?.isConnected) {
      existing.activate(activePage);
      return;
    }

    root.__viewCleanup?.();
    const controller = new AbortController();
    const { signal } = controller;
    let resizeObserver = null;
    const mountedTools = new Map();

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
      return host.__customLatestOutput;
    };
    const openPublishFor = async (key, payload = null) => {
      const host = root.querySelector(`[data-custom-tool-host="${key}"]`);
      const runtime = mountedTools.get(key);
      const mergedPayload = payload ? setLatestOutput(key, payload) : null;
      const output = mergedPayload || host?.__customLatestOutput || runtime?.getLatestOutput?.();
      if (!output) {
        toast(key === "canvas" ? "当前画布还没有可发布的图片" : "请先在视频工坊完成成片");
        return;
      }
      const { openCustomPublish } = await import("./customPublish.js?v=20260718-v94-1");
      openCustomPublish(
        { ...output, kind: key === "canvas" ? "canvas" : "video" },
        {
          onPublished(asset, { customProjectId, publishedCount } = {}) {
            const latest = host?.__customLatestOutput;
            if (latest && customProjectId) latest.customProjectId = customProjectId;
            if (latest && asset?.id) latest.publishedDeliveryId = asset.id;
            if (latest && Number(publishedCount) > 0) {
              latest.publishedCount = Math.floor(Number(publishedCount));
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
          ? await import("./customVideoIntegration.js?v=20260718-v94-1")
          : await import("./customCanvasIntegration.js?v=20260718-v94-1");
        const mount = key === "video" ? module.mountCustomVideo : module.mountCustomCanvas;
        if (typeof mount !== "function") throw new Error(`缺少 ${key} 挂载函数`);
        const mounted = await mount(mountRoot, {
          onOutput: payload => setLatestOutput(key, payload),
          onPublishRequest: payload => requestPublishFor(key, payload),
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
            : null
        });
        const latest = mounted?.latestOutput || mountedTools.get(key)?.getLatestOutput?.();
        if (latest) setLatestOutput(key, latest);
        recordCustomPerformance("tool-mount", mountStarted, { tool: key, ok: true });
      } catch (error) {
        mountedTools.delete(key);
        showMountError(host, error?.message || error);
        recordCustomPerformance("tool-mount", mountStarted, { tool: key, ok: false });
      }
    };
    const positionIndicator = tab => {
      if (!tab || !tabsHost || !indicator) return;
      const hostRect = tabsHost.getBoundingClientRect();
      const tabRect = tab.getBoundingClientRect();
      indicator.style.width = `${tabRect.width}px`;
      indicator.style.transform = `translate3d(${tabRect.left - hostRect.left}px, 0, 0)`;
    };
    const activate = nextPage => {
      const activateStarted = perfNow();
      const next = normalizedPage(nextPage);
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

    root.__customCreationContext = { shell, activate };
    activate(activePage);

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
