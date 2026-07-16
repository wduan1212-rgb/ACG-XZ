import { editImage, hasKey } from "@/lib/maas";
import { planSize } from "@/lib/sizing";

/**
 * Region edit (框选批注): image + mask (transparent = editable) + instruction.
 * Only the masked region changes — proven against the real API. Returns the
 * edited image at an API-legal size close to the source's natural size.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    image?: string; // working-size data URL
    mask?: string; // PNG data URL, same dims as image
    instruction?: string;
    width?: number; // source natural size (for output sizing)
    height?: number;
  };
  if (!hasKey()) return Response.json({ error: "未配置 API Key" }, { status: 400 });
  if (!body.image?.startsWith("data:image/") || !body.mask?.startsWith("data:image/png")) {
    return Response.json({ error: "参数无效" }, { status: 400 });
  }
  const master = planSize({
    width: body.width ?? 1920,
    height: body.height ?? 1080,
  }).master;

  try {
    const res = await editImage({
      prompt: `仅在遮罩指定的编辑区域内：${(body.instruction ?? "").trim() || "优化细节"}。编辑区域之外的所有内容必须与原图完全一致，不得改动。`,
      size: `${master.width}x${master.height}`,
      n: 1,
      // "high" took ~112s per edit; "low" is ~20s and visually fine for edits.
      quality: "low",
      images: [body.image],
      mask: body.mask,
      inputFidelity: "high",
    });
    const src = res[0]?.dataUrl ?? res[0]?.url;
    if (!src) throw new Error("未返回图片");
    return Response.json({
      image: { dataUrl: src, width: master.width, height: master.height },
    });
  } catch (e) {
    console.error("[edit-region] failed:", e);
    return Response.json(
      { error: e instanceof Error ? e.message : "编辑失败" },
      { status: 502 },
    );
  }
}
