import { buildAgentResult, parseCount, type AgentRequest, type AgentResult } from "@/lib/agent";
import { chatComplete, hasKey, VISION_MODEL } from "@/lib/maas";
import type { PaletteKey } from "@/lib/agent";

const PALETTES: PaletteKey[] = ["tech", "business", "finance", "warm", "luxury", "default"];

/**
 * Design Agent — turns a request into ONE complete-poster prompt. Uses the real
 * LLM (deepseek-v4-pro) when configured, else the heuristic. Returns
 * { palette, prompt, negativePrompt, caption }.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as AgentRequest;
  const req: AgentRequest = {
    brief: body.brief ?? "",
    scene: body.scene ?? "brand_kv",
    size: body.size ?? "1080x1920",
    references: Array.isArray(body.references) ? body.references : [],
    images: Array.isArray(body.images)
      ? body.images.filter((u) => typeof u === "string" && u.startsWith("data:image/")).slice(0, 4)
      : undefined,
  };

  if (hasKey()) {
    try {
      return Response.json(await viaLLM(req));
    } catch (e) {
      console.error("[agent] LLM failed, using heuristic:", e);
    }
  }
  return Response.json(buildAgentResult(req));
}

async function viaLLM(req: AgentRequest): Promise<AgentResult> {
  const canSee = !!VISION_MODEL && (req.images?.length ?? 0) > 0;
  const refNote =
    req.references.length > 0
      ? canSee
        ? `\n用户提供了 ${req.references.length} 张输入图（已附在消息里，你可以直接看到）。准确利用你看到的内容，忠实用户原话，并写明「画面中的产品/Logo 直接使用输入图片中的，保持原样」。`
        : `\n用户提供了 ${req.references.length} 张输入图（名称：${req.references
            .map((r) => `「${r.label}」`)
            .join("、")}），图像模型能直接看到它们，但你看不到。忠实用户原话稍作润色、补上标题文案即可，并写明「画面中的产品/Logo 直接使用输入图片中的，保持原样」；严禁自行虚构图里的产品、物体或场景细节。`
      : "";

  const system = [
    "你是星阵的资深商业设计师。用户说需求，你写一条能直接出图的提示词。只返回一个 JSON 对象，不要 markdown：",
    `{"palette":"tech|business|finance|warm|luxury|default","prompt":"提示词","negativePrompt":"英文负向词","caption":"一句话设计思路","count":1}`,
    "提示词按这个骨架写，自然语言、简洁精准（一般不超过 150 字）：",
    "「（有参考图时开头：参考图片中的【产品/Logo/风格】，）生成一张【宽×高】的图片，这是一张【类型与风格】，配色【可选】，画面中【有什么】，【位置】写着「文字内容」，整体质感【高级 / 超级真实 / 强透视冲击…】，不要出现【…】」",
    "· 不用描述字体风格，文字只给内容和位置，字体交给图像模型自己适配画面。",
    "· count：只有用户明确要求输出数量才填多张，如「生成6张」「出3版」「来10个方向」；「两个logo / 三个产品 / 5个卖点」是画面内容数量，不是输出张数。没说就是 1，最大 10。",
    "· 多张时（count>1）：总是返回 \"variants\"（长度=count 的数组，每项是一条完整独立提示词，同一主题与文案）。用户明确给了风格/方向时，全部 variants 严格保持用户的方向，只在构图与布局上做区分；用户没给方向时，各 variant 的设计方向要明显不同（如极简留白/写实摄影/3D渐变/国潮/黑金各选其一）。",
    "· 【类型与风格】完全由用户需求决定：成品海报 / 极其真实、iPhone 随手拍质感的写实照片 / 小红书图文封面 / 电商产品图 / 3D 渐变海报 / 极简大留白海报……不要被「品牌KV」「企业海报」这类项目场景词绑架。",
    "· 文案：用户没给就替他拟简短有力的主标题（2~8 字）+ 一句副标题，写明位置；绝不把用户指令原话当标题。",
    "· 修改参考图时写精确指令：「将输入图片中的『原内容』改为『新内容』，其余保持不变」。",
    "· 默认全中文（画面文字也中文），用户明确要英文才用英文。",
    "· negativePrompt：英文，最多 6 个词组，只写真正要避免的；禁止出现 text / title / words 之类（会把画面标题也去掉）。",
  ].join("\n");

  const wantsEnglish = /英文|english|(?:^|[^一-龥])en\b/i.test(req.brief);
  const langNote = wantsEnglish
    ? "\n用户要英文：整条提示词用英文书写，画面文字用英文。"
    : "\n默认：整条提示词用中文书写，画面文字用中文。";
  const user = `需求：${req.brief || "（未填写，拟一版有品质感的默认海报，含合适的中文标题）"}\n目标尺寸：${req.size}${refNote}${langNote}`;

  const messages: Parameters<typeof chatComplete>[0] = canSee
    ? [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: user },
            ...req.images!.map((u) => ({
              type: "image_url" as const,
              image_url: { url: u },
            })),
          ],
        },
      ]
    : [
        { role: "system", content: system },
        { role: "user", content: user },
      ];

  let raw: string;
  try {
    raw = await chatComplete(messages, {
      temperature: 0.7,
      model: canSee ? VISION_MODEL : undefined,
    });
  } catch (e) {
    if (!canSee) throw e;
    // Vision model unavailable → degrade to text-only transparently.
    raw = await chatComplete(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.7 },
    );
  }

  const parsed = JSON.parse(extractJson(raw));
  const palette: PaletteKey = PALETTES.includes(parsed.palette) ? parsed.palette : "default";
  const requestedCount = parseCount(req.brief);
  const count =
    requestedCount > 1
      ? requestedCount
      : typeof parsed.count === "number" && Number.isFinite(parsed.count) && parsed.count <= 1
        ? 1
        : 1;
  const variants = Array.isArray(parsed.variants)
    ? (parsed.variants as unknown[])
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter(Boolean)
        .slice(0, count)
    : undefined;
  return {
    palette,
    prompt: str(parsed.prompt) || buildAgentResult(req).prompt,
    negativePrompt:
      str(parsed.negativePrompt) ||
      "blurry, low resolution, distorted, watermark, gibberish text",
    caption: str(parsed.caption) || "已生成一张海报。",
    count,
    variants: variants && variants.length > 1 ? variants : undefined,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function extractJson(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) return s.slice(a, b + 1);
  return s.trim();
}
