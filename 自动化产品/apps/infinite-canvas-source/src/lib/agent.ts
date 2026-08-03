import { SCENES } from "./constants";
import type { Scene } from "./types";

/* =========================================================================
   Design Agent — turns a natural-language request into ONE complete-poster
   image prompt (color / style / what's in the scene / what to avoid). This is
   a deterministic heuristic stand-in for the real LLM (api/agent/route.ts);
   the same { palette, prompt, negativePrompt, caption } shape is produced by
   the model when a key is configured.
   ========================================================================= */

export type PaletteKey =
  | "tech"
  | "business"
  | "finance"
  | "warm"
  | "luxury"
  | "default";

interface MoodProfile {
  palette: PaletteKey;
  mood: string; // zh
  style: string; // English style descriptors
  color: string; // zh color guidance
}

const MOOD_RULES: { keys: string[]; profile: MoodProfile }[] = [
  {
    keys: ["科技", "智能", "ai", "人工智能", "数字", "数据", "算力", "云", "未来", "创新", "智算", "大模型", "芯片"],
    profile: {
      palette: "tech",
      mood: "科技未来感",
      style: "futuristic high-tech poster, sleek glowing light, precise geometry, deep gradient",
      color: "深空蓝 + 青色辉光",
    },
  },
  {
    keys: ["金融", "银行", "投资", "资本", "理财", "证券", "保险", "稳健", "财富"],
    profile: {
      palette: "finance",
      mood: "可信稳重",
      style: "trustworthy premium finance poster, solid stable composition, refined gold accents",
      color: "深蓝 + 香槟金",
    },
  },
  {
    keys: ["高端", "奢华", "旗舰", "品质", "尊享", "臻", "大师", "高级"],
    profile: {
      palette: "luxury",
      mood: "高级质感",
      style: "luxury minimal poster, dramatic directional lighting, fine material texture, elegant restraint",
      color: "黑金 + 低饱和莫兰迪",
    },
  },
  {
    keys: ["温暖", "节日", "公益", "人文", "团聚", "陪伴", "关怀", "春节", "新年", "温情", "促销", "活动"],
    profile: {
      palette: "warm",
      mood: "温暖热闹",
      style: "warm inviting poster, soft golden light, cheerful tones",
      color: "暖橙 + 米白",
    },
  },
  {
    keys: ["商务", "企业", "峰会", "发布会", "论坛", "合作", "战略", "签约", "年会", "大会"],
    profile: {
      palette: "business",
      mood: "商务高级感",
      style: "premium corporate poster, restrained palette, soft studio lighting, confident and clean",
      color: "品牌蓝 + 中性深灰",
    },
  },
];

const DEFAULT_MOOD: MoodProfile = {
  palette: "default",
  mood: "现代专业",
  style: "modern professional poster, clean composition, soft volumetric lighting",
  color: "品牌蓝 + 黑白灰",
};

const SUBJECT_RULES: { keys: string[]; subject: string; prompt: string }[] = [
  {
    keys: ["产品", "手机", "设备", "硬件", "芯片", "终端", "汽车", "无人车"],
    subject: "以产品为主体",
    prompt: "a hero product as the centerpiece on a clean pedestal with rim light",
  },
  {
    keys: ["城市", "楼宇", "天际线", "机场", "空间", "园区", "建筑", "枢纽"],
    subject: "以城市/空间为主体",
    prompt: "a sweeping futuristic cityscape with depth and scale",
  },
  {
    keys: ["云", "数据", "算力", "网络", "连接", "数字", "流量", "智算"],
    subject: "以抽象光效与数据流为主体",
    prompt: "abstract flowing data streams and glowing particles as the centerpiece",
  },
  {
    keys: ["人物", "团队", "员工", "客户", "用户", "伙伴", "专家"],
    subject: "以人物为主体",
    prompt: "confident professional figures with cinematic depth of field",
  },
];

const DEFAULT_SUBJECT = {
  subject: "以抽象主视觉为主体",
  prompt: "an abstract premium key-visual centerpiece with volumetric glow",
};

const SCENE_LAYOUT: Record<Scene, string> = {
  airport_screen:
    "ultra-wide horizontal poster layout, subject offset to one side, generous clean space for a large headline, readable from a distance",
  banner:
    "wide banner poster layout, subject to one side, clear space for a headline and a short subhead",
  enterprise_poster:
    "vertical poster layout, strong headline at the top, clear hierarchy, tidy bottom area for logo and captions",
  brand_kv:
    "centered balanced poster layout, hero subject in the middle, refined typography",
};

function detectMood(b: string): MoodProfile {
  const s = b.toLowerCase();
  for (const r of MOOD_RULES) if (r.keys.some((k) => s.includes(k.toLowerCase()))) return r.profile;
  return DEFAULT_MOOD;
}
function detectSubject(b: string) {
  const s = b.toLowerCase();
  for (const r of SUBJECT_RULES) if (r.keys.some((k) => s.includes(k.toLowerCase()))) return r;
  return DEFAULT_SUBJECT;
}

export interface AgentRequest {
  brief: string;
  scene: Scene;
  size: string;
  references: { label: string }[];
  /** Stable message identity used to prevent a replayed upstream LLM call. */
  idempotencyKey: string;
  /** Small data URLs of the reference images, for a vision-capable LLM. */
  images?: string[];
}

export interface AgentResult {
  palette: PaletteKey;
  prompt: string; // complete finished-poster image prompt
  negativePrompt: string;
  caption: string; // short zh summary shown in chat
  /** How many images to generate (1-10), parsed from the request. */
  count?: number;
  /**
   * When count>1 and the user did NOT pin a style, one full prompt per image,
   * each taking a clearly different design direction.
   */
  variants?: string[];
}

const ZH_NUM: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

const SINGLE_IMAGE_GUARD = "单次只生成一张完整成图，禁止拼图、分屏或并排展示多个方案、版本或风格";

/** Parse explicit output-count requests; object counts like "两个 logo" stay as prompt content. */
export function parseCount(brief: string): number {
  const number = "(\\d+|[一两二三四五六七八九十])";
  const verb = "(?:请|同时|再)?(?:帮我|给我)?(?:生成|创作|制作|设计|做|出|来)";
  const asset = "(?:海报|图片|图像|设计|作品|成图|封面|主视觉)";
  const patterns = [
    // Without an output verb, require a concrete output noun. Bare scene
    // quantities such as “两张发票 / 两张参考图” are not generation counts.
    new RegExp(`${number}\\s*(?:张|幅|版)\\s*(?:${asset}|方案|方向)`, "i"),
    // With an output verb, natural shorthand “生成两张” is unambiguous.
    new RegExp(`${verb}\\s*${number}\\s*(?:张|幅|版)(?:\\s*${asset})?`, "i"),
    // “做三种 / 创作两个海报” requires an output verb, avoiding “三款产品”.
    new RegExp(`${verb}\\s*${number}\\s*(?:个\\s*${asset}|款(?:\\s*${asset})?|种(?:\\s*(?:风格|方向|方案|设计|${asset}))?|个方向|个方案|方向|方案)`, "i"),
    // Natural requests such as “创作两个不同风格的海报”.
    new RegExp(
      `${verb}\\s*${number}\\s*(?:个|种)?\\s*(?:(?:不同|不一样|各异|差异化)(?:的)?\\s*(?:风格|方向|版本|方案)|(?:风格|方向|版本|方案)\\s*(?:不同|不一样|各异|差异化)(?:的)?)\\s*(?:的)?\\s*${asset}`,
      "i",
    ),
  ];
  const m = patterns.map((pattern) => brief.match(pattern)).find(Boolean);
  if (!m) return 1;
  const n = /\d+/.test(m[1]) ? parseInt(m[1], 10) : ZH_NUM[m[1]] ?? 1;
  return Math.max(1, Math.min(10, n));
}

/**
 * Convert a multi-output instruction into the prompt for one upstream image
 * request. Only output-count phrases are changed; scene quantities such as
 * “两个产品 / 两个人 / 三个卖点” remain untouched.
 */
export function prepareSingleImagePrompt(prompt: string, outputCount: number): string {
  const original = prompt.trim();
  if (!original || outputCount <= 1) return original;

  let cleaned = original
    // Consume the complete modifier in both natural word orders so phrases
    // such as “生成2张不同风格的海报” never degrade into “生成一张风格的海报”.
    .replace(
      /((?:请|同时|再)?(?:帮我|给我)?(?:生成|创作|制作|设计|做|出|来))\s*(?:\d+|[一两二三四五六七八九十])\s*(?:张|幅|版|个|种)?\s*(?:(?:不同|不一样|各不相同|各异|差异化)(?:的)?\s*(?:风格|方向|版本|方案)|(?:风格|方向|版本|方案)\s*(?:不同|不一样|各不相同|各异|差异化))(?:的)?\s*(海报|图片|图像|设计|作品|成图|封面|主视觉)/gi,
      "$1一张$2",
    )
    // “创作两张风格不一样的海报” → “创作一张海报”.
    .replace(
      /((?:请|同时|再)?(?:帮我|给我)?(?:生成|创作|制作|设计|做|出|来))\s*(?:\d+|[一两二三四五六七八九十])\s*(?:张|幅|版|个方向|个方案|方向|方案|种(?:风格|方向|方案|设计)?)(?:\s*(?:风格|方向|版本|方案)?\s*(?:不同|不一样|各不相同|各异|差异化)(?:的)?)?/gi,
      "$1一张",
    )
    // “创作两个不同风格的海报” and “创作两个风格不同的海报”.
    .replace(
      /(?:\d+|[一两二三四五六七八九十])\s*(?:个|种)?\s*(?:不同|不一样|各不相同|各异|差异化)(?:的)?\s*(?:风格|方向|版本|方案)(?:的)?\s*(海报|图片|图像|设计|作品|成图|封面|主视觉)/gi,
      "一张$1",
    )
    .replace(
      /(?:\d+|[一两二三四五六七八九十])\s*(?:个|种)?\s*(?:风格|方向|版本|方案)\s*(?:不同|不一样|各不相同|各异|差异化)(?:的)?\s*(海报|图片|图像|设计|作品|成图|封面|主视觉)/gi,
      "一张$1",
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([，。；、])/g, "$1")
    .trim();

  // The server may already have attached this guard to both the base prompt
  // and a generated variant. Remove every copy first, then append one clean
  // canonical guard at the end of the single-image request.
  cleaned = cleaned
    .split(SINGLE_IMAGE_GUARD)
    .join("")
    .replace(/。(?:[ \t\r\n]*。)+/g, "。")
    .replace(/[。；;，,\s]+$/g, "")
    .trim();

  if (!cleaned) cleaned = "生成一张完整成图";
  return `${cleaned}。${SINGLE_IMAGE_GUARD}。`;
}

/** Quality-neutral negatives: keep intended text, kill garbage. */
export const BASE_NEGATIVE =
  "blurry, low resolution, jpeg artifacts, distorted proportions, extra limbs, messy cluttered layout, garbled text, misspelled words, gibberish letters, watermark logo overlay, ugly, deformed";

export function buildAgentResult(req: AgentRequest): AgentResult {
  const brief = req.brief.trim();
  const mood = detectMood(brief);
  const subject = detectSubject(brief);
  const layout = SCENE_LAYOUT[req.scene];
  const sceneMeta = SCENES[req.scene];

  // Default the whole prompt (and thus the poster text) to Chinese; English only
  // when the user asks — a Chinese prompt makes the model render Chinese text.
  const wantsEnglish = /英文|english/i.test(brief);
  const isEcom = /电商|产品图|主图|详情页|白底|带货|商品|sku|上架|促销价/i.test(brief);
  // The user's input is a REQUEST, not poster copy — never print it verbatim.
  // Fallback copywriting: a short slogan by mood (the LLM path writes real copy).
  const SLOGANS: Record<PaletteKey, string> = {
    tech: "智见未来",
    business: "共创新程",
    finance: "稳健致远",
    warm: "温暖同行",
    luxury: "臻于至美",
    default: "美好发生",
  };
  const title = SLOGANS[mood.palette];
  const hasRef = req.references.length > 0;

  const subjectZh = isEcom
    ? "白底或极简干净场景，产品作为绝对主体居中、材质与细节到位，配简洁卖点标签，构图聚焦"
    : `${subject.subject}，${sceneMeta.hint}`;
  const fontZh = "字体：中文用现代黑体、字重层级分明，中英文搭配得当，文字准确可读";

  const prompt = wantsEnglish
    ? [
        `A complete finished ${isEcom ? "e-commerce product" : sceneMeta.en.toLowerCase()} design`,
        brief ? `theme: ${brief}` : subject.prompt,
        mood.style,
        `color scheme: ${mood.color}`,
        isEcom ? "clean white or minimal background, product hero centered, crisp details" : layout,
        "a bold English main title and a subtitle, clear typographic hierarchy, well-chosen typeface",
        "professional commercial quality, sharp, high resolution" +
          (hasRef ? ", use the attached reference image(s) as visual guidance" : ""),
      ].join(", ")
    : [
        `一张完整的成品${isEcom ? "电商产品图" : sceneMeta.label}`,
        brief ? `主题：${brief}` : "",
        subjectZh,
        `风格：${mood.mood}`,
        `配色：${mood.color}`,
        fontZh,
        `排版规整、层级清晰、留白得当；主标题「${title}」放在视觉重心、字号最大，下方一行副标题`,
        "商业级品质，画面精致，构图讲究，高清" + (hasRef ? "，参考所给图片的风格与构图" : ""),
      ]
        .filter(Boolean)
        .join("，");

  const caption = brief
    ? `已按"${truncate(brief, 22)}"生成一张${sceneMeta.label}：气质「${mood.mood}」，配色 ${mood.color}。`
    : `已生成一张${sceneMeta.label}：气质「${mood.mood}」，配色 ${mood.color}。`;

  return {
    palette: mood.palette,
    prompt,
    negativePrompt: BASE_NEGATIVE,
    caption,
    count: parseCount(brief),
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
