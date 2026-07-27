const mounted = new WeakMap();

function normalizedOutput(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const project = source.project && typeof source.project === "object" ? source.project : null;
  const plan = source.plan && typeof source.plan === "object"
    ? source.plan
    : (project?.plan && typeof project.plan === "object" ? project.plan : null);
  const projectId = String(source.projectId || project?.id || "").trim();
  const videoUrl = String(source.videoUrl || source.url || source.downloadUrl || "").trim();
  if (!projectId || !videoUrl) return null;
  const title = String(
    source.title
    || (project?.name && project.name !== "新会话" ? project.name : "")
    || plan?.title
    || "未命名视频"
  ).trim() || "未命名视频";
  const aspectRatio = String(
    source.aspectRatio
    || plan?.aspect_ratio
    || "9:16"
  ).trim() || "9:16";
  return {
    kind: "video",
    projectId,
    title,
    videoUrl,
    url: String(source.url || videoUrl),
    downloadUrl: String(source.downloadUrl || videoUrl),
    aspectRatio,
    sourceDeliveryId: String(source.sourceDeliveryId || "").trim(),
    sourceOutputId: String(source.sourceOutputId || "").trim(),
    plan,
    project,
    customProjectId: String(project?._integration?.customProjectId || source.customProjectId || ""),
    publishedDeliveryId: String(
      project?._integration?.publishedDeliveryId
      || source.publishedDeliveryId
      || ""
    ),
    publishedCount: Math.max(
      0,
      Math.floor(Number(
        project?._integration?.publishedCount
        ?? source.publishedCount
        ?? 0
      ) || 0),
    ),
  };
}

/**
 * 把独立运行的视频工坊挂到主平台容器。
 *
 * 返回对象：
 * - getLatestOutput(): 最近一次成功成片元数据
 * - onOutput(listener): 订阅成功成片/画幅切换，返回取消函数
 * - 子应用点击“发布成片”时通过 onPublishRequest 直接打开主平台发布弹窗
 * - getProject(): 最近一次视频工坊项目快照
 * - reload()/destroy()
 */
export function mountCustomVideo(host, { onOutput, onPublishRequest } = {}) {
  if (!(host instanceof Element)) {
    throw new TypeError("mountCustomVideo 需要有效的 DOM 挂载容器");
  }
  mounted.get(host)?.destroy?.();

  const mountOptions = arguments[1] && typeof arguments[1] === "object"
    ? arguments[1]
    : {};
  const initialProjectId = String(mountOptions.projectId || "")
    .trim()
    .slice(0, 180);
  const onProjects = typeof mountOptions.onProjects === "function"
    ? mountOptions.onProjects
    : null;
  const frame = document.createElement("iframe");
  const entryUrl = "/custom-video/?embed=1&start=home";
  frame.src = entryUrl;
  frame.title = "星阵视频工坊";
  frame.loading = "eager";
  frame.referrerPolicy = "same-origin";
  frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
  frame.setAttribute(
    "sandbox",
    "allow-same-origin allow-scripts allow-forms allow-downloads allow-modals allow-popups"
  );
  frame.style.cssText = [
    "display:block",
    "width:100%",
    "height:100%",
    "min-height:0",
    "border:0",
    "background:#050505",
  ].join(";");
  host.replaceChildren(frame);
  host.dataset.customVideoMounted = "true";
  host.dataset.customVideoWorkspace = "true";

  let latestOutput = null;
  let latestProject = null;
  let latestSignature = "";
  let currentProjectId = initialProjectId;
  let workspaceReady = false;
  let pendingCreate = false;
  let destroyed = false;
  const listeners = new Set();
  if (typeof onOutput === "function") listeners.add(onOutput);

  const postWorkspaceAction = (type, payload = {}) => {
    if (destroyed || !workspaceReady || !frame.contentWindow) return false;
    frame.contentWindow.postMessage({
      type,
      scope: "video",
      ...payload,
    }, window.location.origin);
    return true;
  };

  const openProject = projectId => {
    const nextProjectId = String(projectId || "").trim().slice(0, 180);
    if (!nextProjectId) return false;
    currentProjectId = nextProjectId;
    pendingCreate = false;
    if (!workspaceReady) return true;
    return postWorkspaceAction("workspace:open", { projectId: nextProjectId });
  };

  const emitOutput = raw => {
    const output = normalizedOutput(raw);
    if (!output) return;
    const signature = JSON.stringify([
      output.projectId,
      output.videoUrl,
      output.aspectRatio,
      output.title,
      output.sourceDeliveryId,
      output.sourceOutputId,
      output.publishedDeliveryId,
      output.publishedCount,
    ]);
    latestOutput = output;
    if (signature === latestSignature) return;
    latestSignature = signature;
    listeners.forEach(listener => {
      try {
        listener(output);
      } catch (error) {
        console.error("视频工坊 onOutput 回调失败", error);
      }
    });
  };

  const receive = event => {
    if (destroyed || event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
    const message = event.data && typeof event.data === "object" ? event.data : {};
    if (message.type === "custom-video:workspace-ready") {
      workspaceReady = true;
      if (pendingCreate) {
        pendingCreate = false;
        postWorkspaceAction("workspace:create");
      } else if (currentProjectId) {
        openProject(currentProjectId);
      }
      return;
    }
    if (message.type === "custom-video:workspace-projects") {
      const projects = Array.isArray(message.projects) ? message.projects : [];
      if (onProjects) {
        try {
          onProjects(projects);
        } catch (error) {
          console.error("视频工坊 onProjects 回调失败", error);
        }
      }
      window.dispatchEvent(new CustomEvent("xingzhen:video-projects", {
        detail: { projects },
      }));
      return;
    }
    if (message.type === "custom-video:project") {
      latestProject = message.project && typeof message.project === "object"
        ? message.project
        : (message.payload?.project || null);
      currentProjectId = String(latestProject?.id || currentProjectId || "").trim();
      if (message.payload?.videoUrl && latestProject?.status === "succeeded") {
        emitOutput(message.payload);
      }
      return;
    }
    if (message.type === "custom-video:output") {
      latestProject = message.payload?.project || latestProject;
      emitOutput(message.payload);
      return;
    }
    if (message.type === "custom-video:publish-request") {
      const output = normalizedOutput(message.payload);
      if (!output || typeof onPublishRequest !== "function") return;
      latestProject = message.payload?.project || latestProject;
      latestOutput = output;
      try {
        onPublishRequest(output);
      } catch (error) {
        console.error("视频工坊 onPublishRequest 回调失败", error);
      }
    }
  };
  window.addEventListener("message", receive);

  const integration = {
    frame,
    getLatestOutput: () => latestOutput,
    getProject: () => latestProject,
    getCurrentProjectId: () => currentProjectId,
    openProject,
    createProject() {
      currentProjectId = "";
      if (!workspaceReady) {
        pendingCreate = true;
        return true;
      }
      return postWorkspaceAction("workspace:create");
    },
    onOutput(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      if (latestOutput) queueMicrotask(() => {
        if (!destroyed && listeners.has(listener)) listener(latestOutput);
      });
      return () => listeners.delete(listener);
    },
    reload() {
      if (!destroyed) {
        workspaceReady = false;
        frame.src = entryUrl + "&ts=" + Date.now();
      }
    },
    markPublished({
      projectId,
      deliveryId,
      sourceDeliveryId = "",
      sourceOutputId = "",
      publishedAt = Date.now(),
      publishedCount = 0,
    } = {}) {
      const sourceProjectId = String(projectId || "").trim().slice(0, 180);
      const publishedDeliveryId = String(deliveryId || "").trim().slice(0, 160);
      if (
        destroyed
        || !frame.contentWindow
        || !sourceProjectId
        || !publishedDeliveryId
      ) {
        return false;
      }
      frame.contentWindow.postMessage({
        type: "custom-video:published",
        projectId: sourceProjectId,
        deliveryId: publishedDeliveryId,
        sourceDeliveryId: String(sourceDeliveryId || "").trim().slice(0, 180),
        sourceOutputId: String(sourceOutputId || "").trim().slice(0, 180),
        publishedAt: Number(publishedAt) || Date.now(),
        publishedCount: Math.max(0, Math.floor(Number(publishedCount) || 0)),
      }, window.location.origin);
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener("message", receive);
      listeners.clear();
      if (frame.isConnected) frame.remove();
      delete host.dataset.customVideoMounted;
      delete host.dataset.customVideoWorkspace;
      if (mounted.get(host) === integration) mounted.delete(host);
    },
  };
  integration.cleanup = integration.destroy;
  mounted.set(host, integration);
  return integration;
}

export function unmountCustomVideo(host) {
  mounted.get(host)?.destroy?.();
}
