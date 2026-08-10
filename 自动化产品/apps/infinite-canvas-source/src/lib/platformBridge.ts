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

export interface CanvasCommunityShareRequest extends Omit<CanvasPublishRequest, "type"> {
  type: "community-share-request";
}

export interface CanvasPublishedProject {
  projectId: string;
  deliveryId: string;
  publishedAt?: number;
  itemIds?: string[];
}

export interface CanvasPlatformCapabilities {
  canPublish: boolean;
}

export function canvasPlatformCapabilitiesFromBootstrap(): CanvasPlatformCapabilities {
  if (typeof window === "undefined") return { canPublish: false };
  try {
    const bootstrap = JSON.parse(window.name || "{}") as {
      kind?: string;
      canPublish?: unknown;
    };
    if (bootstrap.kind !== "xingzhen-canvas-bootstrap") return { canPublish: false };
    return { canPublish: bootstrap.canPublish === true };
  } catch {
    // Standalone canvas keeps its complete toolset. Embedded canvases must
    // receive an explicit capability from the owner platform.
    return { canPublish: false };
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
  items,
}: {
  projectId: string;
  title: string;
  item?: CanvasPublishItem | null;
  items?: CanvasPublishItem[] | null;
}): CanvasPublishRequest | null {
  const candidates = Array.isArray(items) && items.length
    ? items
    : item
      ? [item]
      : [];
  if (!candidates.length || candidates.length > 20) return null;
  const validItems = candidates.filter((candidate) => {
    const validData = /^data:image\/(?:png|jpe?g|webp);base64,/i.test(candidate.dataUrl);
    const validUrl = /^(?:https?:\/\/|\/)/i.test(candidate.url);
    return validData || validUrl;
  });
  if (validItems.length !== candidates.length) return null;
  return {
    source: "xingzhen-canvas",
    type: "publish-request",
    projectId,
    title: title.trim() || "无限画布作品",
    // The bridge keeps the selection array order intact. The host uses this
    // exact order as the final image-pack order and polishes every row.
    items: validItems.map((candidate) => ({ ...candidate })),
  };
}

export function postCanvasPublishRequest(request: CanvasPublishRequest): boolean {
  if (typeof window === "undefined" || window.parent === window) return false;
  window.parent.postMessage(request, window.location.origin);
  return true;
}

export function buildCanvasCommunityShareRequest(input: Parameters<typeof buildCanvasPublishRequest>[0]): CanvasCommunityShareRequest | null {
  const request = buildCanvasPublishRequest(input);
  return request ? { ...request, type: "community-share-request" } : null;
}

export function postCanvasCommunityShareRequest(request: CanvasCommunityShareRequest): boolean {
  if (typeof window === "undefined" || window.parent === window) return false;
  window.parent.postMessage(request, window.location.origin);
  return true;
}
