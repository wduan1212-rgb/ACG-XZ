/**
 * Decide whether a chat prompt is a targeted edit of attached reference
 * pictures.  The regular generation path deliberately remains available for
 * broad creative briefs; this planner only claims instructions that name a
 * target picture or explicitly ask to edit every attached picture.
 */
export interface ReferenceEditPlan {
  targetIndexes: number[];
  mode: "single" | "parallel";
}

const EDIT_WORDS = /修改|编辑|调整|改(?:成|为)?|换(?:成|为)?|替换|变(?:成|为)?|统一|重绘|重做|优化|润色|重设|改造|美化|转换/;
const ALL_REFERENCE_WORDS = /(?:这|那)?(?:两|多|几|全)张(?:参考)?图|(?:这|那)?(?:两|多|几|全)个(?:参考)?图|全部(?:参考)?图|所有(?:参考)?图|每张(?:参考)?图|分别|一起|同时|都(?:改|换|调|编辑|修改|统一|变)/;

function chineseNumber(value: string): number | null {
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  const values: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  return values[normalized] ?? null;
}

function addIndex(targets: Set<number>, value: number | null, count: number) {
  if (value && value >= 1 && value <= count) targets.add(value - 1);
}

/**
 * Explicit targets take priority over "all" language. For example,
 * "将图 2 的背景调成图 1 的浅蓝色" edits only picture 2; picture 1 is a
 * style donor. "把这两个参考图都换成暖色" produces one edit per picture.
 */
export function planReferenceEdits(brief: string, referenceCount: number): ReferenceEditPlan | null {
  if (referenceCount < 1) return null;
  const text = String(brief ?? "").replace(/\s+/g, "").trim();
  if (!text || !EDIT_WORDS.test(text)) return null;

  const targets = new Set<number>();
  const donors = new Set<number>();
  const imagePatterns = [
    /(?:第)?(?:图|图片)\s*(\d+|[一二两三四五六七八九十])(?:张|幅)?/g,
    /第(\d+|[一二两三四五六七八九十])(?:个|张|幅)?(?:参考)?(?:图|图片)/g,
  ];
  for (const imagePattern of imagePatterns) for (const match of text.matchAll(imagePattern)) {
    const position = match.index ?? 0;
    const before = text.slice(Math.max(0, position - 10), position);
    const after = text.slice(position + match[0].length, position + match[0].length + 26);
    const isStyleDonor = /(?:以|按|按照|参考|参照|基于|像|同|类似|变成|改为|调整为|替换为|调成|换成)$/.test(before);
    const isTargetAfter = EDIT_WORDS.test(after);
    // "统一图2" is an imperative target; "调成图1" is a donor reference.
    const isTargetBefore = /(?:统一|修改|编辑|调整|改|换|替换|重绘|重做|优化|润色|转换)$/.test(before);
    const number = chineseNumber(match[1]);
    if (isStyleDonor) addIndex(donors, number, referenceCount);
    else if (isTargetAfter || isTargetBefore) addIndex(targets, number, referenceCount);
  }

  if (targets.size > 0) {
    const targetIndexes = [...targets].sort((a, b) => a - b);
    return { targetIndexes, mode: targetIndexes.length > 1 ? "parallel" : "single" };
  }

  // “把右上角图片换成第二个图片” names the donor but describes the
  // editable region inside the first attached picture.  Treat the sole
  // non-donor reference as the target instead of falling through to a new
  // multi-reference generation request.
  if (donors.size > 0) {
    const candidates = Array.from({ length: referenceCount }, (_, index) => index)
      .filter(index => !donors.has(index));
    if (candidates.length === 1) return { targetIndexes: candidates, mode: "single" };
  }

  if (referenceCount === 1) return { targetIndexes: [0], mode: "single" };
  if (ALL_REFERENCE_WORDS.test(text)) {
    return {
      targetIndexes: Array.from({ length: referenceCount }, (_, index) => index),
      mode: "parallel",
    };
  }
  return null;
}
