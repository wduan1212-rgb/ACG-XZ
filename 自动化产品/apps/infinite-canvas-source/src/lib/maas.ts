/* =========================================================================
   Tencent MaaS (tokenhub) server client — SERVER ONLY.
   Import this only from route handlers; the API key must never reach the client.
   ========================================================================= */

const BASE = process.env.MAAS_BASE_URL ?? "https://tokenhub.tencentmaas.com";
const KEY = process.env.MAAS_API_KEY ?? "";
// Chat can point at a different provider (e.g. MiniMax) than the image API.
const CHAT_BASE = process.env.MAAS_CHAT_BASE_URL ?? BASE;
const CHAT_KEY = process.env.MAAS_CHAT_API_KEY ?? KEY;
export const TEXT_MODEL = process.env.MAAS_TEXT_MODEL ?? "deepseek-v4-pro-202606";
export const IMAGE_MODEL = process.env.MAAS_IMAGE_MODEL ?? "custom-textmodel-gt";

export function hasKey(): boolean {
  return KEY.trim().length > 0;
}

type ChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatPart[];
}

/** Optional vision-capable chat model (set MAAS_VISION_MODEL to enable). */
export const VISION_MODEL = process.env.MAAS_VISION_MODEL ?? "";

/** Call the chat-completions endpoint and return the assistant text. */
export async function chatComplete(
  messages: ChatMessage[],
  opts: { temperature?: number; timeoutMs?: number; model?: string } = {},
): Promise<string> {
  try {
    return await chatOnce(messages, opts);
  } catch {
    // Upstream 502s are transient — one retry avoids falling back to the heuristic.
    return await chatOnce(messages, opts);
  }
}

async function chatOnce(
  messages: ChatMessage[],
  opts: { temperature?: number; timeoutMs?: number; model?: string } = {},
): Promise<string> {
  const res = await fetch(`${CHAT_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CHAT_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model || TEXT_MODEL,
      messages,
      stream: false,
      temperature: opts.temperature ?? 0.7,
    }),
    // Reasoning models (MiniMax-M3) think before answering — allow more time.
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throw new Error(
      `chat ${res.status}: ${data?.error?.message ?? "request failed"}`,
    );
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("chat: empty content");
  // Reasoning models (MiniMax-M3) prepend <think>…</think> — strip it.
  const clean = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!clean) throw new Error("chat: empty content after reasoning");
  return clean;
}

export interface MaasImage {
  /** Inline data URL when response_format=b64_json. */
  dataUrl?: string;
  /** COS URL when response_format=url (expires in ~1h). */
  url?: string;
}

async function callImage(
  path: string,
  body: Record<string, unknown>,
): Promise<MaasImage[]> {
  body.model = IMAGE_MODEL;
  body.response_format = "b64_json";
  body.output_format = "jpeg";
  if (process.env.MAAS_IMAGE_LOGO_ADD === "0") body.logo_add = 0;

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throw new Error(`image ${res.status}: ${data?.error?.message ?? "request failed"}`);
  }
  if (data?.status === "failed") {
    throw new Error(`image failed: ${data?.error_message ?? "unknown"}`);
  }

  const raw: unknown[] = data?.data ?? data?.result_images ?? [];
  const unescape = (u: string) => u.replace(/\\u0026/g, "&");
  return raw.map((it): MaasImage => {
    if (typeof it === "string") return { url: unescape(it) };
    const obj = it as { b64_json?: string; url?: string };
    return {
      dataUrl: obj.b64_json ? `data:image/jpeg;base64,${obj.b64_json}` : undefined,
      url: obj.url ? unescape(obj.url) : undefined,
    };
  });
}

/** Text-to-image (/v1/aiart/gttext). */
export async function generateImage(opts: {
  prompt: string;
  size: string; // "1536x1024" or custom WxH (must satisfy API constraints)
  n: number;
  quality: string; // auto|high|medium|low
}): Promise<MaasImage[]> {
  return callImage("/v1/aiart/gttext", {
    prompt: opts.prompt,
    size: opts.size,
    n: opts.n,
    quality: opts.quality,
  });
}

/** Image edit with reference image(s) (/v1/aiart/gtimage). `images` = data URLs or URLs. */
export async function editImage(opts: {
  prompt: string;
  size: string;
  n: number;
  quality: string;
  images: string[];
  inputFidelity?: "high" | "low"; // high = stay faithful to input (for HD enhance)
  /** PNG data URL, transparent area = editable region (must match image dims). */
  mask?: string;
}): Promise<MaasImage[]> {
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    size: opts.size,
    n: opts.n,
    quality: opts.quality,
    images: opts.images.map((image_url) => ({ image_url })),
  };
  if (opts.inputFidelity) body.input_fidelity = opts.inputFidelity;
  if (opts.mask) body.mask = { image_url: opts.mask };
  return callImage("/v1/aiart/gtimage", body);
}
