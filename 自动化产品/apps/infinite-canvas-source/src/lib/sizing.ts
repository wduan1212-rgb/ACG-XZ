import type { Size } from "./types";

/* =========================================================================
   Size translation engine (PRD §9.3)
   Turns an arbitrary target size into a generatable master + post steps.
   ========================================================================= */

// Tencent MaaS image API (custom-*-gt) constraints: single side ≤ 3840px,
// width/height multiples of 16, long:short ratio ≤ 3:1, total pixels
// 655360–8294400. The size planner targets exactly these.
export const GEN_MULTIPLE = 16; // generation dims must be multiples of this
export const GEN_MAX_SIDE = 3840; // max longest side for direct generation
export const MAX_RATIO = 3; // long:short ratio before master+full-frame adaptation is required
export const TILE_SIDE = 7680; // beyond this longest side ⇒ tile upscale
export const MIN_PIXELS = 655360; // API minimum total pixels for a master
export const MAX_PIXELS = 8294400; // API maximum total pixels for a master

const ceilUnit = (n: number) => Math.ceil(n / GEN_MULTIPLE) * GEN_MULTIPLE;
const roundUnit = (n: number) => Math.round(n / GEN_MULTIPLE) * GEN_MULTIPLE;
const floorUnit = (n: number) => Math.floor(n / GEN_MULTIPLE) * GEN_MULTIPLE;

/** Scale a 16-aligned size so its pixel count lands within the API budget. */
function clampPixels(s: Size): Size {
  const px = s.width * s.height;
  if (px >= MIN_PIXELS && px <= MAX_PIXELS) return s;
  const f = Math.sqrt((px < MIN_PIXELS ? MIN_PIXELS : MAX_PIXELS) / px);
  const round = px < MIN_PIXELS ? ceilUnit : floorUnit;
  return {
    width: Math.min(GEN_MAX_SIDE, Math.max(GEN_MULTIPLE, round(s.width * f))),
    height: Math.min(GEN_MAX_SIDE, Math.max(GEN_MULTIPLE, round(s.height * f))),
  };
}

export type RiskLevel = "ok" | "warn" | "risk";

export interface SizeWarning {
  level: RiskLevel;
  text: string;
}

export interface SizePlan {
  target: Size;
  aspect: number;
  ratioLabel: string; // "32:9" / "3.41:1"
  /** Size we actually ask the image model to generate. */
  master: Size;
  direct: boolean; // target can be generated directly
  upscale: number; // 1 | 2 | 4 post-upscale factor
  adapt: boolean; // resize the complete master to the exact target without crop/fill
  tile: boolean; // use tile / block super-resolution
  level: RiskLevel;
  warnings: SizeWarning[];
  /** Ordered, human-readable plan steps (zh). */
  steps: string[];
  /** One-line summary, mirrors PRD §9.3 right column. */
  summary: string;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function ratioLabel(w: number, h: number): string {
  const g = gcd(w, h) || 1;
  const a = w / g;
  const b = h / g;
  if (Math.max(a, b) <= 64) return `${a}:${b}`;
  const long = Math.max(w, h) / Math.min(w, h);
  return `${long.toFixed(2)}:1`;
}

export function parseSize(s: string): Size | null {
  const m = s.trim().toLowerCase().match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/);
  if (!m) return null;
  const width = parseInt(m[1], 10);
  const height = parseInt(m[2], 10);
  if (!width || !height) return null;
  return { width, height };
}

export function formatSize(s: Size): string {
  return `${s.width}×${s.height}`;
}

export function megapixels(s: Size): number {
  return (s.width * s.height) / 1_000_000;
}

/**
 * Plan how to produce `target` with the image model.
 * Reproduces the PRD §9.3 reference table.
 */
export function planSize(target: Size): SizePlan {
  const W = Math.round(target.width);
  const H = Math.round(target.height);
  const landscape = W >= H;
  const longest = Math.max(W, H);
  const shortest = Math.min(W, H);
  const aspect = longest / shortest;

  const oversized = longest > GEN_MAX_SIDE;
  const tooWide = aspect > MAX_RATIO + 1e-6;
  const aligned = W % GEN_MULTIPLE === 0 && H % GEN_MULTIPLE === 0;

  const warnings: SizeWarning[] = [];
  const steps: string[] = [];

  let masterLong: number;
  let masterShort: number;
  let upscale = 1;
  let adapt = false;
  let tile = false;

  if (oversized) {
    // Master fits within the generation ceiling; upscale back up afterwards.
    const scale = GEN_MAX_SIDE / longest;
    masterLong = roundUnit(GEN_MAX_SIDE);
    // Keep the true aspect, but never exceed the API's 3:1 short-side floor.
    masterShort = Math.max(
      roundUnit(shortest * scale),
      ceilUnit(masterLong / MAX_RATIO),
    );

    const factor = longest / masterLong;
    upscale = factor <= 2 + 1e-6 ? 2 : 4;
    tile = longest > TILE_SIDE;

    warnings.push({
      level: tile ? "risk" : "warn",
      text: `最长边 ${longest}px 超过 ${GEN_MAX_SIDE}px 直生成上限，需先生成母版再放大。`,
    });
    if (tooWide) {
      warnings.push({
        level: "warn",
        text: `比例 ${ratioLabel(W, H)} 超过 3:1，将完整画面放入 ${MAX_RATIO}:1 合规母版，返回后完整适配到目标像素。`,
      });
    }

    // The transport master differs from the requested pixels, so the full
    // returned frame is resized to the exact target without crop or fill.
    adapt = masterLong * upscale !== longest || masterShort * upscale !== shortest;
  } else if (tooWide) {
    // Within size limits but too wide: use a legal 3:1 transport master, then
    // resize the complete returned frame to the requested pixels.
    masterLong = ceilUnit(longest);
    masterShort = ceilUnit(masterLong / MAX_RATIO);
    adapt = true;
    warnings.push({
      level: "warn",
      text: `比例 ${ratioLabel(W, H)} 超过 3:1，将完整画面放入 ${MAX_RATIO}:1 合规母版，返回后完整适配到目标像素。`,
    });
  } else if (!aligned) {
    // The model requires an 8px grid.  This is a tiny centered output
    // adaptation, not a creative crop or a change of the user's composition.
    masterLong = ceilUnit(longest);
    masterShort = ceilUnit(shortest);
    adapt = true;
    warnings.push({
      level: "warn",
      text: `模型按 8 像素网格生成，将从合规母版居中精确适配；保持主体构图并按目标尺寸输出。`,
    });
  } else {
    // Direct generation.
    masterLong = longest;
    masterShort = shortest;
  }

  const master = clampPixels(sizeFromOrientation(landscape, masterLong, masterShort));
  const direct = !oversized && !tooWide && aligned;

  // ---- Build readable plan ----
  if (direct) {
    steps.push(`可直接以 ${W}×${H} 生成`);
  } else {
    steps.push(`生成母版 ${formatSize(master)}`);
    if (upscale > 1) steps.push(tile ? `分块 ${upscale}x 超分` : `${upscale}x 超分`);
    if (adapt) steps.push(`完整适配为 ${W}×${H}`);
  }

  let level: RiskLevel = "ok";
  if (tile || upscale >= 4) level = "risk";
  else if (!direct) level = "warn";

  const summary = direct
    ? `可直接作为 ${ratioLabel(W, H)} 生成`
    : steps.join(" → ");

  return {
    target: { width: W, height: H },
    aspect,
    ratioLabel: ratioLabel(W, H),
    master,
    direct,
    upscale,
    adapt,
    tile,
    level,
    warnings,
    steps,
    summary,
  };
}

function sizeFromOrientation(
  landscape: boolean,
  long: number,
  short: number,
): Size {
  return landscape
    ? { width: long, height: short }
    : { width: short, height: long };
}
