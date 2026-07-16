import { planSize } from "./sizing";
import type { PaletteKey } from "./agent";
import type { Size } from "./types";

/* =========================================================================
   Image provider — generates abstract "design direction" key-visuals as SVG.
   This is a deterministic stand-in for image-2; swap `generateImages` for a
   real API call (same return shape) when wiring the model in.
   ========================================================================= */

interface Palette {
  deep: string;
  mid: string;
  accent: string;
  glow: string;
  ink: string;
}

const PALETTES: Record<PaletteKey, Palette> = {
  tech: { deep: "#06101f", mid: "#0b2350", accent: "#2f8bff", glow: "#38e1ff", ink: "#eaf4ff" },
  business: { deep: "#0e1320", mid: "#20283a", accent: "#4d8bff", glow: "#9bc0ff", ink: "#eef3ff" },
  finance: { deep: "#07142e", mid: "#122a52", accent: "#2a6bff", glow: "#d8b25e", ink: "#f0f4ff" },
  warm: { deep: "#1c0d04", mid: "#45200d", accent: "#ff8a3d", glow: "#ffd49a", ink: "#fff4e6" },
  luxury: { deep: "#0a0a0c", mid: "#1b1813", accent: "#c9a24a", glow: "#efe0bf", ink: "#f6efe0" },
  default: { deep: "#0c0f15", mid: "#1a2230", accent: "#2f7bff", glow: "#7fd0ff", ink: "#eef2f8" },
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const MOTIFS = ["ribbons", "rings", "grid", "particles", "arc"] as const;

/** Render one design direction as an SVG string. */
function renderDesignSVG(opts: {
  palette: PaletteKey;
  variant: number;
  aspect: number;
}): string {
  const pal = PALETTES[opts.palette] ?? PALETTES.default;
  const rnd = mulberry32(hashStr(`${opts.palette}-${opts.variant}`));
  const W = 1200;
  const H = Math.max(280, Math.round(W / opts.aspect));

  // Composition: glow anchor varies by variant for clear direction-to-direction difference.
  const anchors = [
    { x: 0.72, y: 0.42 },
    { x: 0.3, y: 0.5 },
    { x: 0.5, y: 0.38 },
    { x: 0.8, y: 0.62 },
  ];
  const a = anchors[opts.variant % anchors.length];
  const gx = Math.round(W * a.x);
  const gy = Math.round(H * a.y);
  const motif = MOTIFS[opts.variant % MOTIFS.length];
  const angle = 90 + (opts.variant % 4) * 30;

  const layers: string[] = [];

  // Motif layer
  if (motif === "ribbons") {
    for (let i = 0; i < 4; i++) {
      const y0 = H * (0.2 + i * 0.18) + (rnd() - 0.5) * 80;
      const cx1 = W * 0.3;
      const cx2 = W * 0.7;
      const k = 60 + rnd() * 120;
      layers.push(
        `<path d="M ${-50} ${y0} C ${cx1} ${y0 - k}, ${cx2} ${y0 + k}, ${W + 50} ${y0 - k * 0.4}" fill="none" stroke="${pal.glow}" stroke-width="${1.5 + rnd() * 2}" opacity="${0.12 + rnd() * 0.18}" />`,
      );
    }
  } else if (motif === "rings") {
    for (let i = 5; i >= 1; i--) {
      const r = (Math.min(W, H) * 0.12 * i) / 1.2;
      layers.push(
        `<circle cx="${gx}" cy="${gy}" r="${r}" fill="none" stroke="${pal.accent}" stroke-width="1.4" opacity="${0.05 + i * 0.03}" />`,
      );
    }
  } else if (motif === "grid") {
    const lines: string[] = [];
    for (let i = 0; i <= 12; i++) {
      const x = (W / 12) * i;
      lines.push(`<line x1="${x}" y1="0" x2="${gx}" y2="${gy}" stroke="${pal.accent}" stroke-width="0.8" opacity="0.06"/>`);
    }
    layers.push(lines.join(""));
  } else if (motif === "particles") {
    const dots: string[] = [];
    for (let i = 0; i < 70; i++) {
      const x = rnd() * W;
      const y = rnd() * H;
      const d = Math.hypot(x - gx, y - gy) / W;
      dots.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(rnd() * 2.4).toFixed(1)}" fill="${pal.glow}" opacity="${Math.max(0.05, 0.5 - d).toFixed(2)}"/>`);
    }
    layers.push(dots.join(""));
  } else {
    // arc
    for (let i = 0; i < 3; i++) {
      const r = Math.min(W, H) * (0.45 + i * 0.16);
      layers.push(
        `<path d="M ${gx - r} ${gy} A ${r} ${r} 0 0 1 ${gx + r} ${gy}" fill="none" stroke="${pal.glow}" stroke-width="${2 - i * 0.5}" opacity="${0.2 - i * 0.05}"/>`,
      );
    }
  }

  // A single bright focal core for a "subject" hint
  const coreR = Math.min(W, H) * (0.06 + (opts.variant % 3) * 0.015);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="bg" gradientTransform="rotate(${angle} 0.5 0.5)">
      <stop offset="0" stop-color="${pal.deep}"/>
      <stop offset="1" stop-color="${pal.mid}"/>
    </linearGradient>
    <radialGradient id="glow" cx="${(a.x * 100).toFixed(1)}%" cy="${(a.y * 100).toFixed(1)}%" r="65%">
      <stop offset="0" stop-color="${pal.glow}" stop-opacity="0.55"/>
      <stop offset="0.35" stop-color="${pal.accent}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${pal.accent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="core" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="${pal.ink}" stop-opacity="0.95"/>
      <stop offset="0.4" stop-color="${pal.glow}" stop-opacity="0.6"/>
      <stop offset="1" stop-color="${pal.glow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="50%" cy="50%" r="75%">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.45"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  ${layers.join("\n  ")}
  <circle cx="${gx}" cy="${gy}" r="${coreR.toFixed(0)}" fill="url(#core)"/>
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>
</svg>`;
}

export function svgToDataUri(svg: string): string {
  const compact = svg.replace(/\n\s*/g, " ").trim();
  return `data:image/svg+xml,${encodeURIComponent(compact)}`;
}

export interface GeneratedImage {
  dataUrl: string;
  width: number; // actual generated (master) pixels
  height: number;
  label: string;
  variant: number;
}

export interface GenerateOptions {
  palette: PaletteKey;
  size: string; // target size string "1920x1080"
  count: number;
  startVariant: number; // for direction labeling / seed offset
  labelPrefix?: string; // e.g. "Draft"
  prompt?: string; // real image prompt (from the agent's plan)
  negativePrompt?: string;
  quality?: string; // auto|high|medium|low
  references?: string[]; // reference image data URLs (edit endpoint)
}

/**
 * Generate `count` design directions. Returns the master size (true generated
 * pixels) per the size planner, plus the SVG data URI.
 */
export function generateImages(opts: GenerateOptions): GeneratedImage[] {
  const target: Size = parseSizeLoose(opts.size);
  const plan = planSize(target);
  const master = plan.master;
  const aspect = master.width / master.height;
  const prefix = opts.labelPrefix ?? "Draft";

  const out: GeneratedImage[] = [];
  for (let i = 0; i < opts.count; i++) {
    const variant = opts.startVariant + i;
    const svg = renderDesignSVG({ palette: opts.palette, variant, aspect });
    out.push({
      dataUrl: svgToDataUri(svg),
      width: master.width,
      height: master.height,
      label: `${prefix} ${String(variant).padStart(2, "0")}`,
      variant,
    });
  }
  return out;
}

function parseSizeLoose(s: string): Size {
  const m = s.trim().toLowerCase().match(/(\d{2,5})\s*[x×*]\s*(\d{2,5})/);
  if (m) return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
  return { width: 1920, height: 1080 };
}
