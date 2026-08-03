import type { GenerateOptions, GeneratedImage } from "./imageProvider";
import type { EnhanceOp } from "./types";

const DISABLED_MESSAGE = "平台嵌入构建已禁用客户端图片模型直连";

function clientProviderDisabled(): never {
  throw new Error(DISABLED_MESSAGE);
}

export async function generateImagesWithClientKey(
  _apiKey: string,
  _opts: GenerateOptions,
  _signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  void _apiKey;
  void _opts;
  void _signal;
  return clientProviderDisabled();
}

export async function enhanceImageWithClientKey(
  _apiKey: string,
  _opts: { image: string; size: string; quality?: string; mode?: EnhanceOp },
  _signal?: AbortSignal,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  void _apiKey;
  void _opts;
  void _signal;
  return clientProviderDisabled();
}

export async function editRegionWithClientKey(
  _apiKey: string,
  _opts: {
    image: string;
    mask: string;
    instruction: string;
    width: number;
    height: number;
  },
  _signal?: AbortSignal,
): Promise<{ dataUrl: string; width: number; height: number }> {
  void _apiKey;
  void _opts;
  void _signal;
  return clientProviderDisabled();
}
