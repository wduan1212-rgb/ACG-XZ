import {
  generateImages,
  type GeneratedImage,
  type GenerateOptions,
} from "@/lib/imageProvider";
import { parseSize, planSize } from "@/lib/sizing";
import { editImage, generateImage, hasKey } from "@/lib/maas";

/**
 * Image generation endpoint. Uses the real image model (custom-textmodel-gt)
 * when a key is configured and a prompt is supplied; otherwise renders SVG
 * "design directions". Returns { images: [{ dataUrl, width, height, label }] }.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as GenerateOptions & { mode?: string };
  const opts: GenerateOptions = {
    palette: body.palette ?? "default",
    size: body.size ?? "1920x1080",
    count: Math.max(1, Math.min(10, body.count ?? 1)),
    startVariant: body.startVariant ?? 1,
    labelPrefix: body.labelPrefix ?? "Draft",
    prompt: body.prompt,
    negativePrompt: body.negativePrompt,
    quality: body.quality,
    references: Array.isArray(body.references) ? body.references : undefined,
  };

  if (hasKey() && opts.prompt) {
    try {
      const images = await viaImageModel(opts);
      if (images.length > 0) return Response.json({ images, source: "maas" });
    } catch (e) {
      console.error("[generate] image API failed, SVG fallback:", e);
    }
  }

  // Fallback: SVG placeholder directions (offline / before billing is enabled).
  const delay = body.mode === "final" ? 1200 : 600;
  await new Promise((r) => setTimeout(r, delay));
  return Response.json({ images: generateImages(opts), source: "mock" });
}

async function viaImageModel(opts: GenerateOptions): Promise<GeneratedImage[]> {
  const target = parseSize(opts.size) ?? { width: 1920, height: 1080 };
  const master = planSize(target).master;
  const sizeStr = `${master.width}x${master.height}`;
  const neg = (opts.negativePrompt ?? "").split(",").slice(0, 6).join(",").trim();
  const prompt = neg
    ? `${opts.prompt}\n画面中不要出现：${neg}。`
    : (opts.prompt as string);

  // Real reference images (raster data URLs) → use the edit endpoint.
  const refs = (opts.references ?? [])
    .filter((u) => u.startsWith("data:image/") && !u.startsWith("data:image/svg"))
    .slice(0, 6);
  const results =
    refs.length > 0
      ? await editImage({
          prompt,
          size: sizeStr,
          n: opts.count,
          quality: opts.quality ?? "low",
          images: refs,
          // Keep the reference actually visible in the result.
          inputFidelity: "high",
        })
      : await generateImage({ prompt, size: sizeStr, n: opts.count, quality: opts.quality ?? "low" });

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
