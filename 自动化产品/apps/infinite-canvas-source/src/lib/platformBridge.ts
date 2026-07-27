export interface CanvasPublishItem {
  url: string;
  dataUrl: string;
  name: string;
  mime: string;
  sourceItemId?: string;
}

export interface CanvasPublishRequest {
  source: "xingzhen-canvas";
  type: "publish-request";
  projectId: string;
  title: string;
  items: CanvasPublishItem[];
}

export interface CanvasPublishedProject {
  projectId: string;
  deliveryId: string;
  publishedAt?: number;
  itemIds?: string[];
}

export interface CanvasContextPortal {
  id: string;
  nonce: string;
}

export function canvasContextPortalFromBootstrap(): CanvasContextPortal | null {
  if (typeof window === "undefined") return null;
  try {
    const bootstrap = JSON.parse(window.name || "{}") as {
      kind?: string;
      contextPortalId?: unknown;
      contextPortalNonce?: unknown;
    };
    if (bootstrap.kind !== "xingzhen-canvas-bootstrap") return null;
    const id = String(bootstrap.contextPortalId || "").trim();
    const nonce = String(bootstrap.contextPortalNonce || "").trim();
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id)
      || !/^[A-Za-z0-9_-]{12,96}$/.test(nonce)
    ) {
      return null;
    }
    return { id, nonce };
  } catch {
    return null;
  }
}

export function canvasPublishedProjectsFromBootstrap(): CanvasPublishedProject[] {
  if (typeof window === "undefined") return [];
  try {
    const bootstrap = JSON.parse(window.name || "{}") as {
      kind?: string;
      publishedProjects?: unknown[];
    };
    if (
      bootstrap.kind !== "xingzhen-canvas-bootstrap"
      || !Array.isArray(bootstrap.publishedProjects)
    ) {
      return [];
    }
    return bootstrap.publishedProjects.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      const projectId = String(row.projectId || "").trim().slice(0, 180);
      const deliveryId = String(row.deliveryId || "").trim().slice(0, 160);
      if (!projectId || !deliveryId) return [];
      const publishedAt = Number(row.publishedAt || 0);
      const itemIds = Array.isArray(row.itemIds)
        ? [...new Set(row.itemIds.map((item) => String(item || "").trim()).filter(Boolean))]
            .slice(0, 20)
        : [];
      return [{
        projectId,
        deliveryId,
        publishedAt: Number.isFinite(publishedAt) && publishedAt > 0
          ? publishedAt
          : undefined,
        itemIds,
      }];
    });
  } catch {
    return [];
  }
}

export function buildCanvasPublishRequest({
  projectId,
  title,
  item,
}: {
  projectId: string;
  title: string;
  item: CanvasPublishItem | null | undefined;
}): CanvasPublishRequest | null {
  if (!item) return null;
  const validData = /^data:image\/(?:png|jpe?g|webp);base64,/i.test(item.dataUrl);
  const validUrl = /^(?:https?:\/\/|\/)/i.test(item.url);
  if (!validData && !validUrl) return null;
  return {
    source: "xingzhen-canvas",
    type: "publish-request",
    projectId,
    title: title.trim() || "无限画布作品",
    items: [{ ...item }],
  };
}

export function postCanvasPublishRequest(request: CanvasPublishRequest): boolean {
  if (typeof window === "undefined" || window.parent === window) return false;
  window.parent.postMessage(request, window.location.origin);
  return true;
}
