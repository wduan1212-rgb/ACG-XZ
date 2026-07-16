import type { AgentRequest, AgentResult } from "./agent";
import { buildAgentResult } from "./agent";
import {
  editRegionWithClientKey,
  enhanceImageWithClientKey,
  generateImagesWithClientKey,
} from "./clientImageApi";
import { getClientImageApiKey } from "./clientKeys";
import { generateImages, type GenerateOptions, type GeneratedImage } from "./imageProvider";
import { IS_GITHUB_PAGES, IS_PLATFORM_EMBED } from "./runtime";
import { parseSize, planSize } from "./sizing";
import type { EnhanceOp } from "./types";

/** Client-side wrappers around the route handlers. */

export function platformFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (IS_PLATFORM_EMBED && typeof window !== "undefined") {
    const token = window.localStorage.getItem("dumate.token")?.trim();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const target = IS_PLATFORM_EMBED ? `/api/custom-canvas${path}` : `/api${path}`;
  return fetch(target, { ...init, headers });
}

export async function callAgent(req: AgentRequest): Promise<AgentResult> {
  if (IS_GITHUB_PAGES && !IS_PLATFORM_EMBED) return buildAgentResult(req);
  const res = await platformFetch("/agent", {
    method: "POST",
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Agent request failed (${res.status})`);
  return (await res.json()) as AgentResult;
}

export async function callGenerate(
  opts: GenerateOptions & { mode?: string },
): Promise<GeneratedImage[]> {
  if (IS_GITHUB_PAGES && !IS_PLATFORM_EMBED) {
    const key = getClientImageApiKey();
    if (key && opts.prompt) {
      try {
        const images = await generateImagesWithClientKey(key, opts);
        if (images.length > 0) return images;
      } catch (e) {
        console.warn("[pages-generate] image API failed, SVG fallback:", e);
      }
    }
    await new Promise((r) => setTimeout(r, opts.mode === "final" ? 1200 : 600));
    return generateImages(opts);
  }
  const res = await platformFetch("/generate", {
    method: "POST",
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(`Generation failed (${res.status})`);
  const data = (await res.json()) as { images: GeneratedImage[] };
  return data.images;
}

export async function callEnhance(opts: {
  image: string;
  size: string;
  quality?: string;
  mode?: EnhanceOp;
}): Promise<{ dataUrl: string; width: number; height: number } | null> {
  if (IS_GITHUB_PAGES && !IS_PLATFORM_EMBED) {
    const master = planSize(parseSize(opts.size) ?? { width: 1920, height: 1080 }).master;
    const key = getClientImageApiKey();
    if (key && opts.image.startsWith("data:image/") && !opts.image.startsWith("data:image/svg")) {
      try {
        return await enhanceImageWithClientKey(key, opts);
      } catch (e) {
        console.warn("[pages-enhance] image API failed, passthrough:", e);
      }
    }
    return { dataUrl: opts.image, width: master.width, height: master.height };
  }
  const res = await platformFetch("/enhance", {
    method: "POST",
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(`Enhance failed (${res.status})`);
  const data = (await res.json()) as {
    images: { dataUrl: string; width: number; height: number }[];
  };
  return data.images[0] ?? null;
}

export async function callEditRegion(
  opts: {
    image: string;
    mask: string;
    instruction: string;
    width: number;
    height: number;
  },
  signal?: AbortSignal,
): Promise<{ dataUrl: string; width: number; height: number }> {
  if (IS_GITHUB_PAGES && !IS_PLATFORM_EMBED) {
    const key = getClientImageApiKey();
    if (!key) throw new Error("请先回到首页添加图片 API Key");
    return editRegionWithClientKey(key, opts, signal);
  }
  const res = await platformFetch("/edit-region", {
    method: "POST",
    signal,
    body: JSON.stringify(opts),
  });
  const data = await res.json();
  if (!res.ok || !data.image) throw new Error(data.error || "编辑失败");
  return data.image as { dataUrl: string; width: number; height: number };
}
