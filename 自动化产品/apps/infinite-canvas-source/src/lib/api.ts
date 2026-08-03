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
import {
  canvasHttpError,
  runAbortableRequest,
  type AbortableRequestOptions,
} from "./request";
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

async function responseDetail(response: Response): Promise<string> {
  try {
    const payload = await response.clone().json() as {
      detail?: unknown;
      error?: unknown;
      message?: unknown;
    };
    return String(payload.detail || payload.error || payload.message || "").trim();
  } catch {
    return "";
  }
}

export async function callAgent(
  req: AgentRequest,
  requestOptions: AbortableRequestOptions = {},
): Promise<AgentResult> {
  return runAbortableRequest(async (signal) => {
    if (IS_GITHUB_PAGES && !IS_PLATFORM_EMBED) return buildAgentResult(req);
    const res = await platformFetch("/agent", {
      method: "POST",
      signal,
      body: JSON.stringify(req),
    });
    if (!res.ok) throw canvasHttpError(res.status, await responseDetail(res), "导演理解");
    return (await res.json()) as AgentResult;
  }, { timeoutMs: 90_000, label: "导演理解", ...requestOptions });
}

export async function callGenerate(
  opts: GenerateOptions & { mode?: string },
  requestOptions: AbortableRequestOptions = {},
): Promise<GeneratedImage[]> {
  return runAbortableRequest(async (signal) => {
    if (IS_GITHUB_PAGES && !IS_PLATFORM_EMBED) {
      const key = getClientImageApiKey();
      if (key && opts.prompt) {
        try {
          const images = await generateImagesWithClientKey(key, opts, signal);
          if (images.length > 0) return images;
        } catch (e) {
          if (signal.aborted) throw e;
          console.warn("[pages-generate] image API failed, SVG fallback:", e);
        }
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, opts.mode === "final" ? 1200 : 600);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
      return generateImages(opts);
    }
    const res = await platformFetch("/generate", {
      method: "POST",
      signal,
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw canvasHttpError(res.status, await responseDetail(res), "图片生成");
    const data = (await res.json()) as { images: GeneratedImage[] };
    return data.images;
  }, { timeoutMs: 5 * 60_000, label: "图片生成", ...requestOptions });
}

export interface CanvasBlobResult {
  assetUrl: string;
  outputId: string;
  contentHash: string;
  dailyQuota?: {
    limit: number;
    used: number;
    remaining: number;
    resetAt: number;
  } | null;
}

interface PersistCanvasBlobOptions extends AbortableRequestOptions {
  generationReceipt?: string;
}

/** Persist a generated data URL before it can enter the project draft JSON. */
export async function persistCanvasBlob(
  dataUrl: string,
  outputId = "",
  requestOptions: PersistCanvasBlobOptions = {},
): Promise<CanvasBlobResult> {
  if (!IS_PLATFORM_EMBED || !dataUrl.startsWith("data:image/")) {
    return { assetUrl: dataUrl, outputId, contentHash: "" };
  }
  return runAbortableRequest(async (signal) => {
    const res = await platformFetch("/blobs", {
      method: "POST",
      signal,
      body: JSON.stringify({
        dataUrl,
        outputId,
        generationReceipt: requestOptions.generationReceipt || "",
      }),
    });
    if (!res.ok) throw canvasHttpError(res.status, await responseDetail(res), "图片持久化");
    const body = await res.json() as {
      url?: unknown;
      outputId?: unknown;
      contentHash?: unknown;
      dailyQuota?: CanvasBlobResult["dailyQuota"];
    };
    const assetUrl = String(body.url || "");
    const contentHash = String(body.contentHash || "");
    if (!assetUrl || !contentHash) throw new Error("图片持久化回包不完整");
    return {
      assetUrl,
      outputId: String(body.outputId || outputId || contentHash),
      contentHash,
      dailyQuota: body.dailyQuota ?? null,
    };
  }, { timeoutMs: 90_000, label: "图片持久化", ...requestOptions });
}

/** Materialize an owner-scoped lightweight blob URL for a later reference edit. */
export async function materializeCanvasAsset(
  assetUrl: string,
  requestOptions: AbortableRequestOptions = {},
): Promise<string> {
  if (assetUrl.startsWith("data:image/")) return assetUrl;
  const match = assetUrl.match(/^\/api\/custom-canvas\/blobs\/([a-f0-9]{64})$/);
  if (!match) return assetUrl;
  return runAbortableRequest(async (signal) => {
    const res = await platformFetch(`/blobs/${match[1]}`, { method: "GET", signal });
    if (!res.ok) throw canvasHttpError(res.status, "", "参考图读取");
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("参考图读取失败"));
      reader.readAsDataURL(blob);
    });
  }, { timeoutMs: 30_000, label: "参考图读取", ...requestOptions });
}

/**
 * One reference image is the edit target; optional remaining images are only
 * style/context donors. Keeping this separate from callGenerate prevents an
 * editing request from being reinterpreted as a fresh multi-reference image.
 */
export async function callTransform(opts: {
  image: string;
  prompt: string;
  size: string;
  fidelity?: "high" | "low";
  quality?: string;
  references?: string[];
  idempotencyKey?: string;
}, requestOptions: AbortableRequestOptions = {}): Promise<{
  dataUrl: string;
  width: number;
  height: number;
  generationReceipt?: string;
}> {
  if (IS_GITHUB_PAGES && !IS_PLATFORM_EMBED) {
    const images = await callGenerate({
      palette: "default",
      size: opts.size,
      count: 1,
      startVariant: 1,
      labelPrefix: "编辑",
      prompt: opts.prompt,
      quality: opts.quality ?? "low",
      references: [opts.image, ...(opts.references ?? [])],
    }, requestOptions);
    const image = images[0];
    if (!image) throw new Error("编辑未返回图片");
    return image;
  }
  return runAbortableRequest(async (signal) => {
    const res = await platformFetch("/transform", {
      method: "POST",
      signal,
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw canvasHttpError(res.status, await responseDetail(res), "图片编辑");
    const data = await res.json() as { image?: unknown };
    if (!data.image) throw new Error("编辑未返图片");
    return data.image as {
      dataUrl: string;
      width: number;
      height: number;
      generationReceipt?: string;
    };
  }, { timeoutMs: 5 * 60_000, label: "图片编辑", ...requestOptions });
}

export async function callEnhance(opts: {
  image: string;
  size: string;
  quality?: string;
  mode?: EnhanceOp;
  idempotencyKey?: string;
}, requestOptions: AbortableRequestOptions = {}): Promise<{
  dataUrl: string;
  width: number;
  height: number;
} | null> {
  if (IS_GITHUB_PAGES && !IS_PLATFORM_EMBED) {
    return runAbortableRequest(async (signal) => {
      const master = planSize(parseSize(opts.size) ?? { width: 1920, height: 1080 }).master;
      const key = getClientImageApiKey();
      if (key && opts.image.startsWith("data:image/") && !opts.image.startsWith("data:image/svg")) {
        try {
          return await enhanceImageWithClientKey(key, opts, signal);
        } catch (e) {
          if (signal.aborted) throw e;
          console.warn("[pages-enhance] image API failed, passthrough:", e);
        }
      }
      return { dataUrl: opts.image, width: master.width, height: master.height };
    }, { timeoutMs: 5 * 60_000, label: "图片高清", ...requestOptions });
  }
  return runAbortableRequest(async (signal) => {
    const res = await platformFetch("/enhance", {
      method: "POST",
      signal,
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw canvasHttpError(res.status, await responseDetail(res), "图片高清");
    const data = (await res.json()) as {
      images: { dataUrl: string; width: number; height: number }[];
    };
    return data.images[0] ?? null;
  }, { timeoutMs: 5 * 60_000, label: "图片高清", ...requestOptions });
}

export async function callEditRegion(
  opts: {
    image: string;
    mask: string;
    instruction: string;
    width: number;
    height: number;
    idempotencyKey?: string;
  },
  signal?: AbortSignal,
): Promise<{ dataUrl: string; width: number; height: number }> {
  if (IS_GITHUB_PAGES && !IS_PLATFORM_EMBED) {
    const key = getClientImageApiKey();
    if (!key) throw new Error("请先回到首页添加图片 API Key");
    return editRegionWithClientKey(key, opts, signal);
  }
  return runAbortableRequest(async (requestSignal) => {
    const res = await platformFetch("/edit-region", {
      method: "POST",
      signal: requestSignal,
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw canvasHttpError(res.status, await responseDetail(res), "局部编辑");
    const data = await res.json() as { image?: unknown };
    if (!data.image) throw new Error("局部编辑未返图片");
    return data.image as { dataUrl: string; width: number; height: number };
  }, { signal, timeoutMs: 5 * 60_000, label: "局部编辑" });
}
