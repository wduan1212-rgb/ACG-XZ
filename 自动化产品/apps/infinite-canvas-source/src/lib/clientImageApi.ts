import { parseSize, planSize } from "./sizing";
import type { GeneratedImage, GenerateOptions } from "./imageProvider";
import type { EnhanceOp } from "./types";

const BASE = "https://tokenhub.tencentmaas.com";
const IMAGE_MODEL = "custom-textmodel-gt";

interface ClientImage {
  dataUrl?: string;
  url?: string;
}

function requestSignal(timeoutMs: number, upstream?: AbortSignal): AbortSignal | undefined {
  if (upstream) return upstream;
  return AbortSignal.timeout(timeoutMs);
}

async function callImage(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ClientImage[]> {
  body.model = IMAGE_MODEL;
  body.response_format = "b64_json";
  body.output_format = "jpeg";
  body.logo_add = 0;

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: requestSignal(180_000, signal),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throw new Error(data?.error?.message ?? `image request failed (${res.status})`);
  }
  if (data?.status === "failed") {
    throw new Error(data?.error_message ?? "image request failed");
  }

  const raw: unknown[] = data?.data ?? data?.result_images ?? [];
  const unescape = (u: string) => u.replace(/\\u0026/g, "&");
  return raw.map((it): ClientImage => {
    if (typeof it === "string") return { url: unescape(it) };
    const obj = it as { b64_json?: string; url?: string };
    return {
      dataUrl: obj.b64_json ? `data:image/jpeg;base64,${obj.b64_json}` : undefined,
      url: obj.url ? unescape(obj.url) : undefined,
    };
  });
}

async function generateImage(apiKey: string, opts: {
  prompt: string;
  size: string;
  n: number;
  quality: string;
}): Promise<ClientImage[]> {
  return callImage(apiKey, "/v1/aiart/gttext", opts);
}

async function editImage(apiKey: string, opts: {
  prompt: string;
  size: string;
  n: number;
  quality: string;
  images: string[];
  inputFidelity?: "high" | "low";
  mask?: string;
}, signal?: AbortSignal): Promise<ClientImage[]> {
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    size: opts.size,
    n: opts.n,
    quality: opts.quality,
    images: opts.images.map((image_url) => ({ image_url })),
  };
  if (opts.inputFidelity) body.input_fidelity = opts.inputFidelity;
  if (opts.mask) body.mask = { image_url: opts.mask };
  return callImage(apiKey, "/v1/aiart/gtimage", body, signal);
}

export async function generateImagesWithClientKey(
  apiKey: string,
  opts: GenerateOptions,
): Promise<GeneratedImage[]> {
  if (!opts.prompt?.trim()) return [];
  const target = parseSize(opts.size) ?? { width: 1920, height: 1080 };
  const master = planSize(target).master;
  const sizeStr = `${master.width}x${master.height}`;
  const neg = (opts.negativePrompt ?? "").split(",").slice(0, 6).join(",").trim();
  const prompt = neg ? `${opts.prompt}\n画面中不要出现：${neg}。` : opts.prompt;

  const refs = (opts.references ?? [])
    .filter((u) => u.startsWith("data:image/") && !u.startsWith("data:image/svg"))
    .slice(0, 6);
  const results =
    refs.length > 0
      ? await editImage(apiKey, {
          prompt,
          size: sizeStr,
          n: opts.count,
          quality: opts.quality ?? "low",
          images: refs,
          inputFidelity: "high",
        })
      : await generateImage(apiKey, {
          prompt,
          size: sizeStr,
          n: opts.count,
          quality: opts.quality ?? "low",
        });

  const prefix = opts.labelPrefix ?? "Draft";
  return results
    .map((r, i): GeneratedImage | null => {
      const src = r.dataUrl ?? r.url;
      if (!src) return null;
      return {
        dataUrl: src,
        width: master.width,
        height: master.height,
        label: `${prefix} ${String(opts.startVariant + i).padStart(2, "0")}`,
        variant: opts.startVariant + i,
      };
    })
    .filter((x): x is GeneratedImage => x !== null);
}

const ENHANCE_PROMPT =
  "在尽量保持原图构图、版式、文字内容与配色准确的前提下，显著提升清晰度与细节表现，锐化边缘、纹理和材质层次，去除噪点、模糊与压缩瑕疵，输出更干净、更锐利、更有质感的超高清成品。";

const AIRPORT_ENHANCE_PROMPT =
  "以原图为核心内容进行机场大屏超清交付：尽量保持原图尺寸、比例、构图、主体位置、品牌元素、文字与配色准确不变，显著提升清晰度、边缘锐度、材质纹理、画面层次和远距离可读性；主体不要被裁掉，画面干净、无噪点、无压缩瑕疵、无新增水印。";

function promptFor(mode?: EnhanceOp): string {
  return mode === "airport" ? AIRPORT_ENHANCE_PROMPT : ENHANCE_PROMPT;
}

export async function enhanceImageWithClientKey(
  apiKey: string,
  opts: { image: string; size: string; quality?: string; mode?: EnhanceOp },
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const master = planSize(parseSize(opts.size) ?? { width: 1920, height: 1080 }).master;
  const sizeStr = `${master.width}x${master.height}`;
  const res = await editImage(apiKey, {
    prompt: promptFor(opts.mode),
    size: sizeStr,
    n: 1,
    quality: opts.quality ?? "high",
    images: [opts.image],
    inputFidelity: "high",
  });
  const src = res[0]?.dataUrl ?? res[0]?.url;
  return src ? { dataUrl: src, width: master.width, height: master.height } : null;
}

export async function editRegionWithClientKey(
  apiKey: string,
  opts: {
    image: string;
    mask: string;
    instruction: string;
    width: number;
    height: number;
  },
  signal?: AbortSignal,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const master = planSize({ width: opts.width, height: opts.height }).master;
  const res = await editImage(
    apiKey,
    {
      prompt: `仅在遮罩指定的编辑区域内：${opts.instruction.trim() || "优化细节"}。编辑区域之外的所有内容必须与原图完全一致，不得改动。`,
      size: `${master.width}x${master.height}`,
      n: 1,
      quality: "low",
      images: [opts.image],
      mask: opts.mask,
      inputFidelity: "high",
    },
    signal,
  );
  const src = res[0]?.dataUrl ?? res[0]?.url;
  if (!src) throw new Error("未返回图片");
  return { dataUrl: src, width: master.width, height: master.height };
}
