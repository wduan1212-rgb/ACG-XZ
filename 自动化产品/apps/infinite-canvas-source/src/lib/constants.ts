import type {
  EnhanceOp,
  GenMode,
  Quality,
  ReferenceUsage,
  Scene,
} from "./types";

/* ---- Scenes (PRD §6.2, §7.1) ---- */
export const SCENES: Record<
  Scene,
  { label: string; en: string; defaultSize: string; hint: string }
> = {
  enterprise_poster: {
    label: "企业海报",
    en: "Enterprise Poster",
    defaultSize: "1080x1920",
    hint: "竖版主视觉，留出标题与文案区",
  },
  airport_screen: {
    label: "机场大屏",
    en: "Airport Screen",
    defaultSize: "7680x2160",
    hint: "超宽横版，大留白、远距离可读",
  },
  banner: {
    label: "官网 Banner",
    en: "Website Banner",
    defaultSize: "1536x451",
    hint: "横版横幅，左文右图或大留白",
  },
  brand_kv: {
    label: "品牌 KV",
    en: "Brand KV",
    defaultSize: "1920x1080",
    hint: "品牌主视觉，强调气质与一致性",
  },
};

export const SCENE_ORDER: Scene[] = [
  "enterprise_poster",
  "airport_screen",
  "banner",
  "brand_kv",
];

/* ---- Reference usage (PRD §6.5) ---- */
export const REFERENCE_USAGES: Record<
  ReferenceUsage,
  { label: string; en: string; dot: string; desc: string }
> = {
  style: {
    label: "风格",
    en: "Style",
    dot: "#006bff",
    desc: "参考整体风格",
  },
  composition: {
    label: "构图",
    en: "Composition",
    dot: "#171717",
    desc: "参考构图布局",
  },
  color: { label: "色彩", en: "Color", dot: "#ffa600", desc: "参考配色" },
  subject: {
    label: "主体",
    en: "Subject",
    dot: "#28a948",
    desc: "参考主体对象",
  },
  material: {
    label: "材质",
    en: "Material",
    dot: "#8f8f8f",
    desc: "参考材质质感",
  },
  negative: {
    label: "反向",
    en: "Negative",
    dot: "#ea001d",
    desc: "反向参考，不要这样",
  },
};

export const REFERENCE_USAGE_ORDER: ReferenceUsage[] = [
  "style",
  "composition",
  "color",
  "subject",
  "material",
  "negative",
];

/* ---- Generation tiers (PRD §9.1) ---- */
export const GEN_MODES: Record<
  GenMode,
  { label: string; en: string; quality: Quality; count: number; desc: string }
> = {
  draft: {
    label: "草稿",
    en: "Draft",
    quality: "low",
    count: 4,
    desc: "快速找方向",
  },
  review: {
    label: "评审",
    en: "Review",
    quality: "medium",
    count: 2,
    desc: "内部评审",
  },
  final: {
    label: "终稿",
    en: "Final",
    quality: "high",
    count: 1,
    desc: "最终交付",
  },
};

export const QUALITY_LABEL: Record<Quality, string> = {
  low: "low",
  medium: "medium",
  high: "high",
};

/* Indicative per-image cost in USD by quality (PRD §16.3, §17.2) */
export const QUALITY_COST: Record<Quality, number> = {
  low: 0.011,
  medium: 0.041,
  high: 0.167,
};

/* ---- Enhance modes (real AI HD via edit endpoint) ---- */
export const ENHANCE_MODES: {
  id: EnhanceOp;
  label: string;
  en: string;
  desc: string;
}[] = [
  {
    id: "airport",
    label: "机场大屏超清（推荐）",
    en: "Airport Ultra HD",
    desc: "效果最明显，保持原图尺寸",
  },
  {
    id: "local2x",
    label: "本地保真放大 2x",
    en: "Local Faithful 2x",
    desc: "变化轻微，不重绘不调色",
  },
  {
    id: "deliver",
    label: "高清交付",
    en: "HD Delivery",
    desc: "按对话框目标尺寸增强",
  },
  {
    id: "2x",
    label: "2x 强增强",
    en: "2x Upscale",
    desc: "API 增强，真实 2 倍像素",
  },
  {
    id: "4x",
    label: "4x 强增强",
    en: "4x Upscale",
    desc: "API 增强，真实 4 倍像素",
  },
];

/* ---- Size presets, grouped (常用 / 社交平台 / 印刷) ---- */
export interface SizePreset {
  label: string;
  w: number;
  h: number;
}
export const SIZE_GROUPS: { group: string; sizes: SizePreset[] }[] = [
  {
    group: "常用",
    sizes: [
      { label: "竖版海报", w: 1080, h: 1920 },
      { label: "全高清", w: 1920, h: 1080 },
      { label: "方形", w: 1080, h: 1080 },
      { label: "4K 横版", w: 3840, h: 2160 },
      { label: "机场大屏", w: 7680, h: 2160 },
      { label: "官网 Banner", w: 1536, h: 451 },
    ],
  },
  {
    group: "社交平台",
    sizes: [
      { label: "小红书 3:4", w: 1242, h: 1660 },
      { label: "抖音/视频号", w: 1080, h: 1920 },
      { label: "B站封面", w: 1146, h: 717 },
      { label: "公众号头图", w: 900, h: 383 },
      { label: "微博配图", w: 1080, h: 1080 },
      { label: "淘宝主图", w: 800, h: 800 },
    ],
  },
  {
    group: "印刷 A 系列 (300dpi)",
    sizes: [
      { label: "A5", w: 1748, h: 2480 },
      { label: "A4", w: 2480, h: 3508 },
      { label: "A3", w: 3508, h: 4961 },
    ],
  },
];

/** Flat list kept for compatibility with older pickers. */
export const COMMON_SIZES: { label: string; w: number; h: number; tag: string }[] =
  SIZE_GROUPS[0].sizes.map((s) => ({ ...s, tag: "" }));

/* ---- Quick actions (PRD §8.4) ---- */
export interface QuickAction {
  id: string;
  label: string;
  en: string;
  /** Instruction injected into the agent when triggered. */
  instruction: string;
  /** Whether it kicks off a generation directly. */
  generates?: boolean;
  needsSelection?: boolean;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: "gen4",
    label: "生成 4 个方向",
    en: "Generate 4 Directions",
    instruction: "基于当前需求与参考图，生成 4 个不同的主视觉方向。",
    generates: true,
  },
  {
    id: "premium",
    label: "提升高级感",
    en: "Make It More Premium",
    instruction: "在保持主体的前提下提升画面高级感：更克制的配色、更精致的光影与材质。",
    needsSelection: true,
  },
  {
    id: "space",
    label: "增加留白",
    en: "Add More Negative Space",
    instruction: "增加画面留白，为标题与文案预留干净的安全区。",
    needsSelection: true,
  },
  {
    id: "airport",
    label: "适配机场大屏",
    en: "Make It Suitable for Airport Screen",
    instruction: "调整为超宽横版构图，主体居中偏侧，强化远距离可读性与大留白。",
    needsSelection: true,
  },
  {
    id: "removetext",
    label: "去除伪文字",
    en: "Remove Fake Text",
    instruction: "去除画面中所有伪文字、乱码字母与不可读的标识，仅保留纯净主视觉。",
    needsSelection: true,
  },
  {
    id: "details",
    label: "增强细节",
    en: "Enhance Details",
    instruction: "强化材质纹理、光影层次与边缘清晰度，提升交付质感。",
    needsSelection: true,
  },
  {
    id: "variations",
    label: "生成相似版本",
    en: "Create Similar Variations",
    instruction: "基于选中图生成多个相似方向，保持构图与气质一致。",
    generates: true,
    needsSelection: true,
  },
  {
    id: "resize",
    label: "适配新尺寸",
    en: "Adapt to New Size",
    instruction: "将当前方向适配到新的目标尺寸，给出尺寸转译与裁切建议。",
    needsSelection: true,
  },
];
