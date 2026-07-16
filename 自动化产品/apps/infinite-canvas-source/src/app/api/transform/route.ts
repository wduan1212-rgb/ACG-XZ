import { editImage, hasKey } from "@/lib/maas";
import { parseSize, planSize } from "@/lib/sizing";

/**
 * Generic image transform on top of the edit endpoint — powers style remix
 * (fidelity low, style may change everything) and element extraction
 * (fidelity high, subject must survive verbatim).
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    image?: string;
    prompt?: string;
    size?: string;
    fidelity?: "high" | "low";
    quality?: string;
  };
  if (!hasKey()) return Response.json({ error: "未配置 API Key" }, { status: 400 });
  const image = body.image;
  if (!image?.startsWith("data:image/") || image.startsWith("data:image/svg")) {
    return Response.json({ error: "参数无效" }, { status: 400 });
  }
  const master = planSize(
    parseSize(body.size ?? "1024x1024") ?? { width: 1024, height: 1024 },
  ).master;

  try {
    const res = await editImage({
      prompt: (body.prompt ?? "").trim() || "优化这张图",
      size: `${master.width}x${master.height}`,
      n: 1,
      quality: body.quality ?? "low",
      images: [image],
      inputFidelity: body.fidelity ?? "high",
    });
    const src = res[0]?.dataUrl ?? res[0]?.url;
    if (!src) throw new Error("未返回图片");
    return Response.json({
      image: { dataUrl: src, width: master.width, height: master.height },
    });
  } catch (e) {
    console.error("[transform] failed:", e);
    return Response.json(
      { error: e instanceof Error ? e.message : "处理失败" },
      { status: 502 },
    );
  }
}
