import { editImage, hasKey } from "@/lib/maas";
import { parseSize, planSize } from "@/lib/sizing";
import type { EnhanceOp } from "@/lib/types";

const ENHANCE_PROMPT =
  "在尽量保持原图构图、版式、文字内容与配色准确的前提下，显著提升清晰度与细节表现，锐化边缘、纹理和材质层次，去除噪点、模糊与压缩瑕疵，输出更干净、更锐利、更有质感的超高清成品。";

const AIRPORT_ENHANCE_PROMPT =
  "以原图为核心内容进行机场大屏超清交付：尽量保持原图尺寸、比例、构图、主体位置、品牌元素、文字与配色准确不变，显著提升清晰度、边缘锐度、材质纹理、画面层次和远距离可读性；主体不要被裁掉，画面干净、无噪点、无压缩瑕疵、无新增水印。";

function promptFor(mode?: EnhanceOp): string {
  return mode === "airport" ? AIRPORT_ENHANCE_PROMPT : ENHANCE_PROMPT;
}

/**
 * Real HD enhance via the edit endpoint with input_fidelity=high (stays faithful
 * to the source while sharpening/adding detail). Returns the enhanced image at
 * the API master size; the client upscales it to the exact target resolution.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    image?: string;
    size?: string;
    quality?: string;
    mode?: EnhanceOp;
  };
  const image = body.image;
  if (!image || !image.startsWith("data:image/") || image.startsWith("data:image/svg")) {
    return Response.json({ images: [], source: "invalid" });
  }
  const master = planSize(parseSize(body.size ?? "1920x1080") ?? { width: 1920, height: 1080 }).master;
  const sizeStr = `${master.width}x${master.height}`;

  if (hasKey()) {
    try {
      const res = await editImage({
        prompt: promptFor(body.mode),
        size: sizeStr,
        n: 1,
        quality: body.quality ?? "high",
        images: [image],
        inputFidelity: "high",
      });
      const src = res[0]?.dataUrl ?? res[0]?.url;
      if (src) {
        return Response.json({
          images: [{ dataUrl: src, width: master.width, height: master.height }],
          source: "maas",
        });
      }
    } catch (e) {
      console.error("[enhance] failed:", e);
    }
  }
  // Fallback: return the source unchanged at master dims (client still upscales).
  return Response.json({
    images: [{ dataUrl: image, width: master.width, height: master.height }],
    source: "passthrough",
  });
}
