(function installVideoWorkshopPublishPolicy(root) {
  "use strict";

  const SUCCESS_OUTPUT_STATES = new Set(["succeeded", "success", "completed", "complete", "done", "ready"]);

  function deliveryRows(project) {
    const saved = Array.isArray(project?.deliveries)
      ? project.deliveries.filter(item => item && typeof item === "object")
      : [];
    if (saved.length) return saved;
    const outputs = Array.isArray(project?.outputs)
      ? project.outputs.filter(item => item && typeof item === "object")
      : [];
    return outputs.length ? [{
      id: String(project?.activeDeliveryId || "legacy-current"),
      outputs,
      legacyCurrent: true,
    }] : [];
  }

  function localOutputUrlForProject(value, projectId) {
    const raw = String(value || "").trim();
    if (!raw || !projectId || raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return "";
    const path = raw.split(/[?#]/, 1)[0];
    let relative = "";
    for (const prefix of ["/outputs/", "/custom-video/outputs/"]) {
      if (path.startsWith(prefix)) {
        relative = path.slice(prefix.length);
        break;
      }
    }
    if (!relative) return "";
    const parts = relative.split("/");
    if (parts.length !== 2 || parts.some(part => !part || part === "." || part === "..")) return "";
    let owner = "";
    try {
      owner = decodeURIComponent(parts[0]);
    } catch {
      return "";
    }
    if (owner !== String(projectId)) return "";
    if (!/\.(?:mp4|webm|mov)$/i.test(parts[1])) return "";
    return raw;
  }

  function resolvePublishableVideoOutput(project, requestedOutput, requestedDelivery = null) {
    const projectId = String(project?.id || "").trim();
    const requestedOutputId = String(requestedOutput?.id || "").trim();
    if (!projectId || !requestedOutputId) return null;

    const rows = deliveryRows(project);
    const requestedDeliveryId = String(requestedDelivery?.id || "").trim();
    let delivery = null;
    if (requestedDeliveryId) {
      delivery = rows.find(item => String(item?.id || "") === requestedDeliveryId) || null;
    } else {
      delivery = rows.find(item => (item?.outputs || []).some(output =>
        String(output?.id || "") === requestedOutputId
      )) || null;
    }
    if (!delivery) return null;

    const output = (delivery.outputs || []).find(item =>
      item && typeof item === "object" && String(item.id || "") === requestedOutputId
    ) || null;
    if (!output) return null;
    const outputDeliveryId = String(output.deliveryId || "").trim();
    const canonicalDeliveryId = String(delivery.id || "").trim();
    if (outputDeliveryId && canonicalDeliveryId && outputDeliveryId !== canonicalDeliveryId) return null;

    const outputStatus = String(output.status || "").trim().toLowerCase();
    if (outputStatus && !SUCCESS_OUTPUT_STATES.has(outputStatus)) return null;
    const videoUrl = localOutputUrlForProject(
      output.url || output.downloadUrl,
      projectId,
    );
    if (!videoUrl) return null;
    return { output, delivery, videoUrl };
  }

  root.VideoWorkshopPublishPolicy = Object.freeze({
    deliveryRows,
    localOutputUrlForProject,
    resolvePublishableVideoOutput,
  });
})(globalThis);
