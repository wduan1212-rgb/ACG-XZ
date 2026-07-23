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
    || !["output-ready", "publish-request"].includes(message.type)
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

export function getLatestOutput() {
  return cloneOutput(latestOutput);
}

export function subscribeCanvasOutput(listener, { immediate = false } = {}) {
  if (typeof listener !== "function") return () => {};
  subscribers.add(listener);
  if (immediate && latestOutput) listener(cloneOutput(latestOutput));
  return () => subscribers.delete(listener);
}

export async function mountCustomCanvas(host, { onOutput, onPublishRequest } = {}) {
  if (!(host instanceof HTMLElement)) throw new TypeError("无限画布挂载点无效");
  host.__customCanvasCleanup?.();

  const controller = new AbortController();
  latestOutput = null;
  const token = localStorage.getItem(TOKEN_KEY)?.trim() || "";
  const unsubscribeOutput = typeof onOutput === "function" ? subscribeCanvasOutput(onOutput) : () => {};
  let iframe = null;
  let disposed = false;

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    unsubscribeOutput();
    window.removeEventListener("message", onMessage);
    iframe?.remove();
    if (host.__customCanvasCleanup === cleanup) delete host.__customCanvasCleanup;
  };

  const integration = {
    cleanup,
    destroy: cleanup,
    getLatestOutput: () => cloneOutput(latestOutput),
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

  const onMessage = event => {
    if (!iframe || event.source !== iframe.contentWindow || event.origin !== window.location.origin) return;
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
    if (!output) return;
    publishOutput(output);
    if (output.type === "publish-request" && typeof onPublishRequest === "function") {
      try {
        onPublishRequest(cloneOutput(output));
      } catch (error) {
        console.error("[custom-canvas] publish request", error);
      }
    }
  };

  host.__customCanvasCleanup = cleanup;
  host.innerHTML = messageHtml("正在启动无限画布", "加载隔离运行时和当前账号的本地项目…");

  if (!token) {
    host.innerHTML = messageHtml("无限画布需要登录", "请重新登录主平台后再进入定制创作。", "error");
    return integration;
  }

  try {
    const config = await checkAvailability(token, controller.signal);
    if (disposed) return integration;
    const storageNamespace = safeText(config.storageNamespace, "", 80).replace(/[^\w-]/g, "");
    if (!storageNamespace) throw new Error("服务端没有返回当前成员的画布分仓");

    iframe = document.createElement("iframe");
    iframe.title = "星阵无限画布";
    iframe.name = JSON.stringify({
      kind: "xingzhen-canvas-bootstrap",
      storageNamespace,
      publishedProjects: Array.isArray(config.publishedProjects)
        ? config.publishedProjects
        : []
    });
    // Cache-bust the iframe entry alongside the main application build. The
    // canvas itself continues to own hashed chunk URLs; this only prevents a
    // browser from reusing an old entry document after a safe static rebuild.
    iframe.src = "/XZ-Design/?embed=1&v=20260723-v117-8#/";
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-downloads allow-forms allow-modals");
    iframe.setAttribute("allow", "clipboard-read; clipboard-write");
    iframe.referrerPolicy = "same-origin";
    iframe.style.cssText = "display:block;width:100%;height:100%;min-height:0;border:0;border-radius:0;background:#f7f7f5;";
    window.addEventListener("message", onMessage);
    host.replaceChildren(iframe);
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
