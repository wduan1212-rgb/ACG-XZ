const CANVAS_SOURCE = "xingzhen-canvas";
const CANVAS_OUTPUT_EVENT = "custom-canvas-output-ready";
const TOKEN_KEY = "dumate.token";
const MAX_CANVAS_DATA_URL_BYTES = 48 * 1024 * 1024;
const subscribers = new Set();
let latestOutput = null;

function cloneOutput(value) {
  if (!value) return null;
  return {
    ...value,
    items: value.items.map(item => ({ ...item }))
  };
}

function safeText(value, fallback = "", max = 180) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, max);
}

function safeOutputItem(value) {
  if (!value || typeof value !== "object") return null;
  const rawDataUrl = typeof value.dataUrl === "string" ? value.dataUrl.trim() : "";
  const dataUrl = rawDataUrl.length <= MAX_CANVAS_DATA_URL_BYTES ? rawDataUrl : "";
  const url = safeText(value.url, "", 4096);
  const validData = /^data:image\/(?:png|jpe?g|webp);base64,/i.test(dataUrl);
  const validUrl = /^(?:https?:\/\/|\/)/i.test(url);
  if (!validData && !validUrl) return null;
  return {
    url: validUrl ? url : "",
    dataUrl: validData ? dataUrl : "",
    name: safeText(value.name, "无限画布导出", 180),
    mime: safeText(value.mime, validData ? dataUrl.slice(5, dataUrl.indexOf(";")) : "image/png", 80),
    sourceItemId: safeText(value.sourceItemId, "", 180)
  };
}

function normalizeOutput(message) {
  if (
    !message
    || message.source !== CANVAS_SOURCE
    || !["output-ready", "publish-request", "community-share-request"].includes(message.type)
  ) return null;
  const items = Array.isArray(message.items)
    ? message.items.map(safeOutputItem).filter(Boolean).slice(0, 20)
    : [];
  if (!items.length) return null;
  return {
    source: CANVAS_SOURCE,
    type: message.type,
    projectId: safeText(message.projectId, "", 180),
    title: safeText(message.title, "无限画布导出", 180),
    items,
    receivedAt: Date.now()
  };
}

function publishOutput(output) {
  latestOutput = output;
  subscribers.forEach(listener => {
    try { listener(cloneOutput(output)); } catch (error) { console.error("[custom-canvas] output subscriber", error); }
  });
  window.dispatchEvent(new CustomEvent(CANVAS_OUTPUT_EVENT, { detail: cloneOutput(output) }));
}

function messageHtml(title, body, tone = "loading") {
  const colors = tone === "error"
    ? { bg: "#fff7f7", border: "#f0c9c9", title: "#a92626", body: "#7c4545" }
    : { bg: "#f8fafc", border: "#e5e9ef", title: "#202631", body: "#667085" };
  return `
    <div role="${tone === "error" ? "alert" : "status"}" style="
      box-sizing:border-box;display:flex;min-height:220px;height:100%;align-items:center;justify-content:center;
      padding:32px;background:${colors.bg};border:1px solid ${colors.border};border-radius:18px;text-align:center;">
      <div style="max-width:520px">
        <strong style="display:block;color:${colors.title};font-size:16px;line-height:1.5">${title}</strong>
        <span style="display:block;margin-top:8px;color:${colors.body};font-size:13px;line-height:1.7">${body}</span>
      </div>
    </div>
  `;
}

function emptyCanvasHtml() {
  return `
    <div data-custom-canvas-empty role="status" style="
      box-sizing:border-box;display:flex;min-height:220px;height:100%;align-items:center;justify-content:center;
      padding:32px;background:#fff;text-align:center;">
      <div style="max-width:460px">
        <strong style="display:block;color:#252523;font-size:16px;font-weight:560;line-height:1.5">暂无画布项目</strong>
        <span style="display:block;margin-top:7px;color:#85857f;font-size:13px;line-height:1.7">请从左侧项目列表新建或打开画布。</span>
      </div>
    </div>
  `;
}

async function checkAvailability(token, signal) {
  // 画布图片使用同源 <img>/canvas 加载，浏览器不会为这些请求附加
  // localStorage 中的平台 Bearer。先建立仅限画布私有图片路径的 HttpOnly
  // 成员会话，历史图片的稳定 URL 才能在不暴露 token 的前提下正常显示。
  const sessionResponse = await fetch("/api/custom-canvas/session", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { Authorization: `Bearer ${token}` },
    signal
  });
  if (!sessionResponse.ok) {
    let sessionData = {};
    try { sessionData = await sessionResponse.json(); } catch (_) {}
    const detail = typeof sessionData.detail === "string"
      ? sessionData.detail
      : `HTTP ${sessionResponse.status}`;
    throw new Error(detail);
  }
  const response = await fetch("/api/custom-canvas/config", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Authorization: `Bearer ${token}` },
    signal
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? data.detail : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (!data.available) throw new Error("无限画布静态应用尚未安装");
  return data;
}

async function loadRecentProjectId(token, signal) {
  const response = await fetch("/api/custom-canvas/projects", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Authorization: `Bearer ${token}` },
    signal
  });
  if (!response.ok) return "";
  let data = {};
  try { data = await response.json(); } catch (_) {}
  const projects = Array.isArray(data.items) ? data.items : [];
  const timeValue = raw => {
    const numeric = Number(raw || 0);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    return Date.parse(String(raw || "")) || 0;
  };
  const timestamp = item => {
    const project = item?.project && typeof item.project === "object" ? item.project : {};
    return Math.max(
      timeValue(item?.serverUpdatedAt),
      timeValue(item?.clientUpdatedAt),
      timeValue(item?.updatedAt),
      timeValue(project.updatedAt)
    );
  };
  const projectId = item => safeText(
    item?.sourceId
    || item?.sourceProjectId
    || item?.project?.id
    || item?.id,
    "",
    180
  );
  return projects
    .filter(item => projectId(item))
    .sort((left, right) => timestamp(right) - timestamp(left))
    .map(projectId)[0] || "";
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForCanvasProjectIndex(token, projectId, signal) {
  const expectedId = safeText(projectId, "", 180);
  if (!expectedId) return false;
  for (const delayMs of [120, 300, 600, 1200, 2400, 4800, 8000]) {
    await abortableDelay(delayMs, signal);
    let response;
    try {
      response = await fetch("/api/custom-canvas/projects", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Authorization: `Bearer ${token}` },
        signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      continue;
    }
    if (!response.ok) continue;
    let data = {};
    try { data = await response.json(); } catch (_) {}
    const projects = Array.isArray(data.items) ? data.items : [];
    if (projects.some(item => safeText(
      item?.sourceId
      || item?.sourceProjectId
      || item?.project?.id
      || item?.id,
      "",
      180
    ) === expectedId)) return true;
  }
  return false;
}

export function getLatestOutput() {
  return cloneOutput(latestOutput);
}

export function subscribeCanvasOutput(listener, { immediate = false } = {}) {
  if (typeof listener !== "function") return () => {};
  subscribers.add(listener);
  if (immediate && latestOutput) listener(cloneOutput(latestOutput));
  return () => subscribers.delete(listener);
}

export async function mountCustomCanvas(
  host,
  { onOutput, onPublishRequest, onCommunityShareRequest, projectId = "", canPublish = false, launchPayload = null } = {}
) {
  if (!(host instanceof HTMLElement)) throw new TypeError("无限画布挂载点无效");
  host.__customCanvasCleanup?.();

  let currentProjectId = safeText(projectId, "", 180);
  const controller = new AbortController();
  latestOutput = null;
  const token = localStorage.getItem(TOKEN_KEY)?.trim() || "";
  const unsubscribeOutput = typeof onOutput === "function" ? subscribeCanvasOutput(onOutput) : () => {};
  let iframe = null;
  let disposed = false;
  let iframeReady = false;
  let canvasAppReady = false;
  let canvasBootstrap = null;
  let canvasContextTools = null;
  let canvasContextPortal = null;
  let canvasContextShell = null;
  let canvasContextInstallFrame = 0;
  let canvasContextInstallAttempts = 0;
  let messageListenerInstalled = false;
  let createProjectWhenReady = false;
  let pendingLaunchPayload = launchPayload && typeof launchPayload === "object" ? launchPayload : null;
  let pendingLaunchSent = false;
  let canvasContextCollapseButton = null;
  let canvasContextRestoreButton = null;
  let canvasContextCollapseStyle = null;
  let canvasContextCollapsed = false;
  let canvasContextRouteActive = true;
  let canvasRouteListenerInstalled = false;
  const projectIndexWaits = new Set();
  const announcedProjectIds = new Set();
  let removeCanvasRouteGuard = () => {};
  const canvasContextToken = (
    globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  ).replace(/[^A-Za-z0-9_-]/g, "");
  const canvasContextPortalId = `canvasContextPortal_${canvasContextToken}`.slice(0, 80);
  const canvasContextPortalNonce = `canvasPortal_${canvasContextToken}`.slice(0, 96);
  const normalizedLaunchPayload = payload => {
    if (!payload || typeof payload !== "object") return null;
    return {
      ...payload,
      bridgeLaunchId: safeText(
        payload.bridgeLaunchId,
        `canvas-launch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        180
      )
    };
  };
  pendingLaunchPayload = normalizedLaunchPayload(pendingLaunchPayload);

  const projectHash = projectId => {
    const value = safeText(projectId, "", 180);
    return value ? `#/project/${encodeURIComponent(value)}` : "#/";
  };

  const projectIdFromHash = value => {
    let decoded = "";
    try {
      decoded = decodeURIComponent(String(value || "").replace(/^#/, ""));
    } catch (_) {
      return "";
    }
    return safeText(decoded.match(/^\/project\/([^/?#]+)/)?.[1], "", 180);
  };

  const installCanvasRouteGuard = () => {
    removeCanvasRouteGuard();
    removeCanvasRouteGuard = () => {};
    if (!iframe?.contentWindow) return;
    const childWindow = iframe.contentWindow;
    let childDocument = null;
    try {
      childDocument = childWindow.document;
      childDocument.documentElement.dataset.platformWorkspace = "true";
      if (!childDocument.querySelector("#xingzhenCanvasEmbedStyle")) {
        const style = childDocument.createElement("style");
        style.id = "xingzhenCanvasEmbedStyle";
        style.textContent = `
          button[aria-label="返回"],
          a[aria-label="返回"],
          a[href$="#/"],
          [data-home-action] {
            display: none !important;
          }
          header:has(button[aria-label="返回"]) > div:last-child {
            padding-right: 58px !important;
          }
          ${canPublish ? "" : `
          button[aria-label*="发布"],
          button[title*="发布"],
          [data-action="publish"] {
            display: none !important;
          }`}
        `;
        childDocument.head.appendChild(style);
      }
    } catch (_) {
      return;
    }
    let restoring = false;
    const keepProjectRoute = () => {
      if (disposed || restoring) return;
      const visibleProjectId = projectIdFromHash(childWindow.location.hash);
      if (visibleProjectId) {
        currentProjectId = visibleProjectId;
        return;
      }
      if (!currentProjectId) return;
      restoring = true;
      childWindow.location.replace(projectHash(currentProjectId));
      queueMicrotask(() => { restoring = false; });
    };
    childWindow.addEventListener("hashchange", keepProjectRoute);
    keepProjectRoute();
    removeCanvasRouteGuard = () => {
      childWindow.removeEventListener("hashchange", keepProjectRoute);
    };
  };

  const flushPendingWorkspaceCommands = () => {
    if (!iframeReady || !canvasAppReady || !iframe?.contentWindow) return false;
    // A homepage launch always owns a fresh project. Never create a blank
    // placeholder first and then start the homepage task in a second project.
    if (pendingLaunchPayload && !pendingLaunchSent) {
      pendingLaunchSent = true;
      try {
        iframe.contentWindow.sessionStorage.setItem(
          "starmatrix.canvasHomeLaunch.v1",
          JSON.stringify(pendingLaunchPayload),
        );
      } catch (_) {}
      iframe.contentWindow.postMessage(
        { type: "custom-canvas:home-launch", payload: pendingLaunchPayload },
        window.location.origin,
      );
      createProjectWhenReady = false;
      return true;
    }
    if (createProjectWhenReady && !pendingLaunchPayload) {
      createProjectWhenReady = false;
      iframe.contentWindow.postMessage(
        { type: "custom-canvas:create-project" },
        window.location.origin,
      );
      return true;
    }
    return false;
  };

  const setCanvasContextCollapsed = collapsed => {
    canvasContextCollapsed = Boolean(collapsed);
    document.body.classList.toggle(
      "canvas-context-collapsed",
      canvasContextRouteActive && canvasContextCollapsed,
    );
    canvasContextCollapseButton?.setAttribute("aria-expanded", canvasContextCollapsed ? "false" : "true");
    canvasContextCollapseButton?.setAttribute(
      "aria-label",
      canvasContextCollapsed ? "展开画布项目栏" : "折叠画布项目栏",
    );
    if (canvasContextCollapseButton) canvasContextCollapseButton.hidden = !canvasContextRouteActive;
    if (canvasContextRestoreButton) {
      canvasContextRestoreButton.hidden = !canvasContextRouteActive || !canvasContextCollapsed;
    }
    if (canvasContextTools) canvasContextTools.hidden = !canvasContextRouteActive;
    if (!canvasContextRouteActive) return;
    if (canvasContextTools?.isConnected) {
      if (canvasContextCollapsed) {
        canvasContextTools.classList.add("is-detached");
        document.body.append(canvasContextTools);
      } else {
        canvasContextTools.classList.remove("is-detached");
        const activeShell = canvasContextShell?.isConnected
          ? canvasContextShell
          : document.querySelector("#ctxPanel .workspace-context-shell");
        if (activeShell) canvasContextShell = activeShell;
        const footer = activeShell
          ? Array.from(activeShell.children).find(child => child.classList.contains("workspace-account-footer"))
          : null;
        if (activeShell && footer?.parentElement === activeShell) {
          activeShell.insertBefore(canvasContextTools, footer);
          activeShell.classList.add("has-canvas-context-tools");
        }
      }
    }
    try {
      sessionStorage.setItem("xingzhen.canvasContextCollapsed.v1", canvasContextCollapsed ? "1" : "0");
    } catch (_) {}
  };

  const syncCanvasContextRoute = detail => {
    const routeIsCanvas = detail && typeof detail === "object"
      ? detail.zone === "custom" && detail.page === "canvas"
      : /^#\/custom\/canvas(?:\/|$)/.test(window.location.hash || "");
    canvasContextRouteActive = Boolean(routeIsCanvas);
    if (!canvasContextRouteActive) {
      document.body.classList.remove("canvas-context-collapsed");
      canvasContextShell?.classList.remove("has-canvas-context-tools");
      if (canvasContextCollapseButton) canvasContextCollapseButton.hidden = true;
      if (canvasContextRestoreButton) canvasContextRestoreButton.hidden = true;
      if (canvasContextTools) canvasContextTools.hidden = true;
      return;
    }
    let storedCollapsed = canvasContextCollapsed;
    try { storedCollapsed = sessionStorage.getItem("xingzhen.canvasContextCollapsed.v1") === "1"; } catch (_) {}
    setCanvasContextCollapsed(storedCollapsed);
  };

  const onCanvasViewRendered = event => syncCanvasContextRoute(event?.detail);
  window.addEventListener("view:rendered", onCanvasViewRendered);
  canvasRouteListenerInstalled = true;

  const removeCanvasContextCollapseControls = () => {
    document.body.classList.remove("canvas-context-collapsed");
    canvasContextCollapseButton?.remove();
    canvasContextCollapseButton = null;
    canvasContextRestoreButton?.remove();
    canvasContextRestoreButton = null;
    canvasContextCollapseStyle?.remove();
    canvasContextCollapseStyle = null;
    canvasContextCollapsed = false;
  };

  const installCanvasContextCollapseControls = () => {
    const shell = canvasContextShell?.isConnected
      ? canvasContextShell
      : document.querySelector("#ctxPanel .workspace-context-shell");
    const header = shell?.querySelector(".workspace-context-brand");
    if (!shell || !header) return false;
    if (!canvasContextCollapseStyle) {
      const style = document.createElement("style");
      style.dataset.canvasContextCollapseStyle = canvasContextToken;
      style.textContent = `
        .canvas-context-collapse-toggle,
        .canvas-context-collapse-restore {
          width: 30px;
          height: 30px;
          display: grid;
          place-items: center;
          border: 0;
          border-radius: 9px;
          color: #696963;
          background: transparent;
          cursor: pointer;
          transition: color 160ms ease, background 160ms ease, transform 160ms ease;
        }
        .canvas-context-collapse-toggle:hover,
        .canvas-context-collapse-toggle:focus-visible,
        .canvas-context-collapse-restore:hover,
        .canvas-context-collapse-restore:focus-visible {
          outline: 0;
          color: #1769d2;
          background: #edf5ff;
          transform: translateY(-1px);
        }
        .canvas-context-collapse-restore {
          position: fixed;
          left: 14px;
          top: 14px;
          z-index: 96;
          border: 1px solid rgba(32, 91, 169, .16);
          background: rgba(255,255,255,.94);
          box-shadow: 0 8px 24px rgba(24, 62, 112, .12);
          backdrop-filter: blur(12px);
        }
        body.workspace-shell-v2.canvas-context-collapsed .app-shell,
        body.workspace-shell-v2.canvas-context-collapsed.has-panel .app-shell {
          grid-template-columns: 0 minmax(0, 1fr) !important;
        }
        body.workspace-shell-v2.canvas-context-collapsed #ctxPanel {
          width: 0 !important;
          min-width: 0 !important;
          border-right: 0 !important;
          overflow: visible !important;
        }
        body.workspace-shell-v2.canvas-context-collapsed #ctxPanel > .workspace-context-shell {
          display: none !important;
        }
        .canvas-context-tools.is-detached {
          position: fixed;
          left: 12px;
          bottom: 12px;
          z-index: 94;
          width: 224px;
          margin: 0;
          padding: 10px;
          border: 1px solid rgba(28, 79, 145, .13);
          border-radius: 14px;
          background: rgba(255,255,255,.94);
          box-shadow: 0 14px 34px rgba(20, 55, 105, .14);
          backdrop-filter: blur(14px);
        }
        .canvas-context-tools.is-detached > span { display: none; }
        .canvas-context-tools.is-detached .canvas-context-portal { min-height: 154px; }
      `;
      document.head.append(style);
      canvasContextCollapseStyle = style;
    }
    if (!canvasContextCollapseButton?.isConnected) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "canvas-context-collapse-toggle";
      button.setAttribute("aria-expanded", "true");
      button.setAttribute("aria-label", "折叠画布项目栏");
      button.title = "折叠画布项目栏";
      button.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M14.5 6.5 9 12l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      button.addEventListener("click", () => setCanvasContextCollapsed(true));
      header.append(button);
      canvasContextCollapseButton = button;
    }
    if (!canvasContextRestoreButton?.isConnected) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "canvas-context-collapse-restore";
      button.setAttribute("aria-label", "展开画布项目栏");
      button.title = "展开画布项目栏";
      button.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m9.5 6.5 5.5 5.5-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      button.hidden = true;
      button.addEventListener("click", () => setCanvasContextCollapsed(false));
      document.body.append(button);
      canvasContextRestoreButton = button;
    }
    let storedCollapsed = false;
    try { storedCollapsed = sessionStorage.getItem("xingzhen.canvasContextCollapsed.v1") === "1"; } catch (_) {}
    setCanvasContextCollapsed(storedCollapsed);
    return true;
  };

  const removeCanvasContextTools = () => {
    window.cancelAnimationFrame(canvasContextInstallFrame);
    canvasContextInstallFrame = 0;
    canvasContextInstallAttempts = 0;
    canvasContextPortal?.replaceChildren();
    canvasContextPortal = null;
    canvasContextTools?.remove();
    canvasContextTools = null;
    canvasContextShell?.classList.remove("has-canvas-context-tools");
    canvasContextShell = null;
  };

  const installCanvasContextTools = () => {
    if (
      canvasContextTools?.isConnected
      && canvasContextPortal?.isConnected
      && canvasContextPortal.id === canvasContextPortalId
    ) {
      syncCanvasContextRoute();
      installCanvasContextCollapseControls();
      return true;
    }
    if (!document.body.classList.contains("workspace-shell-v2")) return false;
    const shell = document.querySelector("#ctxPanel .workspace-context-shell");
    const footer = shell
      ? Array.from(shell.children).find(child => child.classList.contains("workspace-account-footer"))
      : null;
    if (!shell || !footer || footer.parentElement !== shell) {
      canvasContextInstallAttempts += 1;
      if (!disposed && canvasContextInstallAttempts < 180) {
        canvasContextInstallFrame = window.requestAnimationFrame(installCanvasContextTools);
      }
      return false;
    }
    removeCanvasContextTools();
    const dock = document.createElement("section");
    dock.className = "canvas-context-tools";
    dock.dataset.canvasContextTools = "true";
    dock.setAttribute("aria-label", "画布小地图与视图控制");
    dock.innerHTML = `
      <span>画布小地图</span>
      <div
        class="canvas-context-portal"
        id="${canvasContextPortalId}"
        data-canvas-context-portal="${canvasContextPortalNonce}"
        aria-label="当前画布小地图"
      ></div>
    `;
    shell.insertBefore(dock, footer);
    const isCanvasRoute = /^#\/custom\/canvas(?:\/|$)/.test(window.location.hash || "");
    dock.hidden = !isCanvasRoute;
    shell.classList.toggle("has-canvas-context-tools", isCanvasRoute);
    canvasContextTools = dock;
    canvasContextPortal = dock.querySelector(".canvas-context-portal");
    canvasContextShell = shell;
    canvasContextInstallAttempts = 0;
    syncCanvasContextRoute();
    installCanvasContextCollapseControls();
    return true;
  };

  const mountCanvasFrame = () => {
    if (disposed || !canvasBootstrap) return false;
    iframeReady = false;
    canvasAppReady = false;
    pendingLaunchSent = false;
    installCanvasContextTools();
    iframe = document.createElement("iframe");
    iframe.title = "星阵无限画布";
    iframe.name = JSON.stringify(canvasBootstrap);
    // Cache-bust the iframe entry alongside the main application build. The
    // canvas itself continues to own hashed chunk URLs; this only prevents a
    // browser from reusing an old entry document after a safe static rebuild.
    iframe.src = `/XZ-Design/?embed=1&v=20260803-v137-architecture-isolation-1${projectHash(currentProjectId)}`;
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-downloads allow-forms allow-modals");
    iframe.setAttribute("allow", "clipboard-read; clipboard-write");
    iframe.referrerPolicy = "same-origin";
    iframe.style.cssText = "display:block;width:100%;height:100%;min-height:0;border:0;border-radius:0;background:#fff;";
    iframe.addEventListener("load", () => {
      iframeReady = true;
      installCanvasRouteGuard();
      installCanvasContextTools();
      if (pendingLaunchPayload) {
        try {
          iframe.contentWindow?.sessionStorage?.setItem(
            "starmatrix.canvasHomeLaunch.v1",
            JSON.stringify(pendingLaunchPayload),
          );
        } catch (_) {}
      }
      host.dispatchEvent(new CustomEvent("custom-canvas:workspace-ready", {
        detail: { projectId: currentProjectId },
      }));
    });
    if (!messageListenerInstalled) {
      window.addEventListener("message", onMessage);
      messageListenerInstalled = true;
    }
    host.replaceChildren(iframe);
    host.dataset.customCanvasWorkspace = "true";
    return true;
  };

  const openProject = projectId => {
    const nextProjectId = safeText(projectId, "", 180);
    if (!nextProjectId || disposed) return false;
    currentProjectId = nextProjectId;
    if (!iframe) return mountCanvasFrame();
    const nextHash = projectHash(nextProjectId);
    if (!iframeReady) {
      iframe.src = `/XZ-Design/?embed=1&v=20260803-v137-architecture-isolation-1${nextHash}`;
      return true;
    }
    try {
      iframe.contentWindow.location.hash = nextHash.slice(1);
    } catch (_) {
      iframe.src = `/XZ-Design/?embed=1&v=20260803-v137-architecture-isolation-1${nextHash}`;
    }
    return true;
  };

  const createProject = () => {
    if (disposed) return false;
    if (!iframe) {
      createProjectWhenReady = true;
      return mountCanvasFrame();
    }
    if (!iframeReady || !canvasAppReady) {
      createProjectWhenReady = true;
      return true;
    }
    createProjectWhenReady = true;
    return flushPendingWorkspaceCommands();
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    unsubscribeOutput();
    if (messageListenerInstalled) window.removeEventListener("message", onMessage);
    if (canvasRouteListenerInstalled) window.removeEventListener("view:rendered", onCanvasViewRendered);
    canvasRouteListenerInstalled = false;
    removeCanvasRouteGuard();
    removeCanvasContextCollapseControls();
    removeCanvasContextTools();
    iframe?.remove();
    delete host.dataset.customCanvasWorkspace;
    if (host.__customCanvasCleanup === cleanup) delete host.__customCanvasCleanup;
  };

  const integration = {
    cleanup,
    destroy: cleanup,
    getLatestOutput: () => cloneOutput(latestOutput),
    getCurrentProjectId: () => currentProjectId,
    openProject,
    createProject,
    markCommunityShared({ projectId, sourceOutputId, sourceItemId, postId = "", sharedAt = Date.now() } = {}) {
      const targetProjectId = safeText(projectId || currentProjectId, "", 180);
      const targetItemId = safeText(sourceItemId || sourceOutputId, "", 180);
      if (disposed || !iframe?.contentWindow || !targetProjectId || !targetItemId) return false;
      iframe.contentWindow.postMessage({
        type: "custom-canvas:community-shared",
        projectId: targetProjectId,
        sourceItemId: targetItemId,
        postId: safeText(postId, "", 180),
        sharedAt: Number(sharedAt) || Date.now(),
      }, window.location.origin);
      return true;
    },
    prefill(payload) {
      if (!payload || typeof payload !== "object") return false;
      pendingLaunchPayload = normalizedLaunchPayload(payload);
      pendingLaunchSent = false;
      createProjectWhenReady = false;
      if (!iframeReady || !canvasAppReady || !iframe?.contentWindow) return true;
      try {
        iframe.contentWindow.sessionStorage.setItem(
          "starmatrix.canvasHomeLaunch.v1",
          JSON.stringify(pendingLaunchPayload),
        );
      } catch (_) {}
      return flushPendingWorkspaceCommands();
    },
    reload() {
      if (disposed || !iframe) return false;
      iframeReady = false;
      canvasAppReady = false;
      pendingLaunchSent = false;
      iframe.src = `/XZ-Design/?embed=1&v=20260803-v137-architecture-isolation-1${projectHash(currentProjectId)}`;
      return true;
    },
    markPublished({
      projectId,
      deliveryId,
      publishedAt = Date.now(),
      itemIds = []
    } = {}) {
      const sourceProjectId = safeText(projectId, "", 180);
      const publishedDeliveryId = safeText(deliveryId, "", 160);
      if (
        disposed
        || !iframe?.contentWindow
        || !sourceProjectId
        || !publishedDeliveryId
      ) {
        return false;
      }
      iframe.contentWindow.postMessage({
        type: "custom-canvas:published",
        projectId: sourceProjectId,
        deliveryId: publishedDeliveryId,
        publishedAt: Number(publishedAt) || Date.now(),
        itemIds: [...new Set(
          (Array.isArray(itemIds) ? itemIds : [])
            .map(item => safeText(item, "", 180))
            .filter(Boolean)
        )].slice(0, 20)
      }, window.location.origin);
      return true;
    }
  };

  const announceCreatedProject = createdProjectId => {
    const nextProjectId = safeText(createdProjectId, "", 180);
    if (!nextProjectId) return;
    currentProjectId = nextProjectId;
    if (announcedProjectIds.has(nextProjectId)) return;
    announcedProjectIds.add(nextProjectId);
    host.dispatchEvent(new CustomEvent("custom-canvas:project-created", {
      detail: { projectId: nextProjectId, indexed: false },
      bubbles: true,
    }));
    if (projectIndexWaits.has(nextProjectId)) return;
    projectIndexWaits.add(nextProjectId);
    void waitForCanvasProjectIndex(token, nextProjectId, controller.signal)
      .then(indexed => {
        if (!indexed || disposed) return;
        host.dispatchEvent(new CustomEvent("custom-canvas:project-created", {
          detail: { projectId: nextProjectId, indexed: true },
          bubbles: true,
        }));
      })
      .catch(error => {
        if (error?.name !== "AbortError") {
          console.warn("[custom-canvas] project index confirmation", error);
        }
      })
      .finally(() => projectIndexWaits.delete(nextProjectId));
  };

  const onMessage = event => {
    if (!iframe || event.source !== iframe.contentWindow || event.origin !== window.location.origin) return;
    if (
      event.data?.source === CANVAS_SOURCE
      && event.data?.type === "workspace-ready"
    ) {
      canvasAppReady = true;
      const readyProjectId = safeText(event.data.projectId, "", 180);
      if (readyProjectId) currentProjectId = readyProjectId;
      flushPendingWorkspaceCommands();
      return;
    }
    if (
      event.data?.source === CANVAS_SOURCE
      && event.data?.type === "home-launch-consumed"
    ) {
      const launchId = safeText(event.data.launchId, "", 180);
      const pendingId = safeText(pendingLaunchPayload?.bridgeLaunchId, "", 180);
      if (!pendingId || !launchId || launchId === pendingId) {
        pendingLaunchPayload = null;
        pendingLaunchSent = false;
        createProjectWhenReady = false;
        try { iframe.contentWindow?.sessionStorage?.removeItem("starmatrix.canvasHomeLaunch.v1"); } catch (_) {}
      }
      const launchProjectId = safeText(event.data.projectId, "", 180);
      if (launchProjectId) announceCreatedProject(launchProjectId);
      return;
    }
    if (
      event.data?.source === CANVAS_SOURCE
      && event.data?.type === "performance"
      && event.data?.stage === "hydration"
    ) {
      window.dispatchEvent(new CustomEvent("xingzhen:canvas-hydrated", {
        detail: {
          durationMs: Math.max(0, Number(event.data.durationMs || 0)),
          projectCount: Math.max(0, Number(event.data.projectCount || 0))
        }
      }));
      return;
    }
    const output = normalizeOutput(event.data);
    if (
      event.data?.source === CANVAS_SOURCE
      && event.data?.type === "project-created"
    ) {
      const createdProjectId = safeText(event.data.projectId, "", 180);
      if (createdProjectId) announceCreatedProject(createdProjectId);
      return;
    }
    if (!output) return;
    publishOutput(output);
    if (output.type === "publish-request" && typeof onPublishRequest === "function") {
      try {
        onPublishRequest(cloneOutput(output));
      } catch (error) {
        console.error("[custom-canvas] publish request", error);
      }
    }
    if (output.type === "community-share-request" && typeof onCommunityShareRequest === "function") {
      try {
        onCommunityShareRequest(cloneOutput(output));
      } catch (error) {
        console.error("[custom-canvas] community share request", error);
      }
    }
  };

  host.__customCanvasCleanup = cleanup;
  host.innerHTML = '<div data-custom-canvas-loading role="status" aria-label="正在打开最近画布" style="height:100%;background:#fff"></div>';

  if (!token) {
    host.innerHTML = messageHtml("无限画布需要登录", "请重新登录主平台后再进入定制创作。", "error");
    return integration;
  }

  try {
    const config = await checkAvailability(token, controller.signal);
    if (disposed) return integration;
    const storageNamespace = safeText(config.storageNamespace, "", 80).replace(/[^\w-]/g, "");
    if (!storageNamespace) throw new Error("服务端没有返回当前成员的画布分仓");
    if (!currentProjectId) {
      if (pendingLaunchPayload) {
        // 首页发起的创作必须在新画布中执行，不能偷用上一次打开的项目。
        createProjectWhenReady = false;
      } else {
        currentProjectId = await loadRecentProjectId(token, controller.signal);
        // 新成员第一次进入时直接落在一个真实的新画布中；创建动作仍由
        // 画布应用自己完成，主平台只在服务端确认“当前成员没有项目”后触发一次。
        createProjectWhenReady = !currentProjectId;
      }
    }
    if (disposed) return integration;

    canvasBootstrap = {
      kind: "xingzhen-canvas-bootstrap",
      storageNamespace,
      canPublish: Boolean(canPublish),
      contextPortalId: canvasContextPortalId,
      contextPortalNonce: canvasContextPortalNonce,
      publishedProjects: Array.isArray(config.publishedProjects)
        ? config.publishedProjects
        : []
    };
    mountCanvasFrame();
  } catch (error) {
    if (disposed || error?.name === "AbortError") return integration;
    host.innerHTML = messageHtml(
      "无限画布启动失败",
      safeText(error?.message, "请确认本地服务正常后重试。", 240),
      "error"
    );
  }
  return integration;
}
