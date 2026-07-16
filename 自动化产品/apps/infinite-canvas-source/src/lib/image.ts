"use client";

import type { Size } from "./types";

export interface LoadedImage {
  dataUrl: string;
  originalDataUrl?: string;
  width: number; // original natural width
  height: number; // original natural height
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("无法加载图片"));
    img.src = src;
  });
}

const MAX_DELIVERY_SIDE = 12000;
const MAX_DELIVERY_PIXELS = 90_000_000;

function deliveryCanvasSize(targetW: number, targetH: number): Size {
  const w = Math.max(1, Math.round(targetW));
  const h = Math.max(1, Math.round(targetH));
  const scale = Math.min(
    1,
    MAX_DELIVERY_SIDE / Math.max(w, h),
    Math.sqrt(MAX_DELIVERY_PIXELS / (w * h)),
  );
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * Downscale a raster data URL for canvas display + localStorage. SVG and remote
 * URLs are returned untouched. Returns the data URL plus original pixel size.
 */
export async function downscaleDataUrl(
  src: string,
  maxSide = 1536,
  quality = 0.85,
): Promise<{ dataUrl: string; width: number; height: number }> {
  // Vector or remote (cross-origin) sources: leave as-is.
  if (src.startsWith("data:image/svg") || !src.startsWith("data:")) {
    return { dataUrl: src, width: 0, height: 0 };
  }
  const img = await loadImage(src);
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  if (scale >= 1) return { dataUrl: src, width: w0, height: h0 };
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { dataUrl: src, width: w0, height: h0 };
  ctx.drawImage(img, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL("image/jpeg", quality), width: w0, height: h0 };
}

/**
 * Upscale (cover-fit) a data URL to an exact target resolution so delivery is
 * truly the selected size. Returns the source unchanged only when already exact.
 */
export async function upscaleDataUrl(
  src: string,
  targetW: number,
  targetH: number,
  quality = 0.92,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadImage(src);
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (w0 === targetW && h0 === targetH) return { dataUrl: src, width: w0, height: h0 };

  const delivery = deliveryCanvasSize(targetW, targetH);
  const W = delivery.width;
  const H = delivery.height;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { dataUrl: src, width: w0, height: h0 };
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const ir = w0 / h0;
  const cr = W / H;
  let dw: number;
  let dh: number;
  if (ir > cr) {
    dh = H;
    dw = H * ir;
  } else {
    dw = W;
    dh = W / ir;
  }
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return { dataUrl: canvas.toDataURL("image/jpeg", quality), width: W, height: H };
}

/**
 * Deterministic local enhancement: high-quality resize plus luminance-only
 * unsharp mask. It cannot hallucinate new detail, but it keeps color/composition
 * stable and gives exports a real larger pixel grid.
 */
export async function faithfulSharpenDataUrl(
  src: string,
  targetW: number,
  targetH: number,
  quality = 0.95,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadImage(src);
  const delivery = deliveryCanvasSize(targetW, targetH);
  const W = delivery.width;
  const H = delivery.height;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { dataUrl: src, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  drawCover(ctx, img, W, H);

  const imageData = ctx.getImageData(0, 0, W, H);
  const data = imageData.data;
  const lum = new Float32Array(W * H);
  const blurred = new Float32Array(W * H);
  let hasAlpha = false;

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    lum[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    if (data[i + 3] < 250) hasAlpha = true;
  }

  for (let y = 0; y < H; y += 1) {
    const y0 = Math.max(0, y - 1);
    const y1 = y;
    const y2 = Math.min(H - 1, y + 1);
    for (let x = 0; x < W; x += 1) {
      const x0 = Math.max(0, x - 1);
      const x1 = x;
      const x2 = Math.min(W - 1, x + 1);
      blurred[y * W + x] =
        (lum[y0 * W + x0] +
          lum[y0 * W + x1] +
          lum[y0 * W + x2] +
          lum[y1 * W + x0] +
          lum[y1 * W + x1] +
          lum[y1 * W + x2] +
          lum[y2 * W + x0] +
          lum[y2 * W + x1] +
          lum[y2 * W + x2]) /
        9;
    }
  }

  const amount = 1.08;
  const threshold = 2.5;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const delta = lum[p] - blurred[p];
    if (Math.abs(delta) < threshold) continue;
    const lift = delta * amount;
    data[i] = clampByte(data[i] + lift);
    data[i + 1] = clampByte(data[i + 1] + lift);
    data[i + 2] = clampByte(data[i + 2] + lift);
  }
  ctx.putImageData(imageData, 0, 0);
  return {
    dataUrl: canvas.toDataURL(hasAlpha ? "image/png" : "image/jpeg", quality),
    width: W,
    height: H,
  };
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  width: number,
  height: number,
) {
  const ir = (img.naturalWidth || img.width) / (img.naturalHeight || img.height);
  const cr = width / height;
  let dw: number;
  let dh: number;
  if (ir > cr) {
    dh = height;
    dw = height * ir;
  } else {
    dw = width;
    dh = width / ir;
  }
  ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

function rgbStats(data: Uint8ClampedArray): {
  mean: [number, number, number];
  std: [number, number, number];
} {
  const sum = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue;
    sum[0] += data[i];
    sum[1] += data[i + 1];
    sum[2] += data[i + 2];
    count += 1;
  }
  if (!count) return { mean: [0, 0, 0], std: [1, 1, 1] };
  const mean: [number, number, number] = [
    sum[0] / count,
    sum[1] / count,
    sum[2] / count,
  ];
  const variance = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue;
    variance[0] += (data[i] - mean[0]) ** 2;
    variance[1] += (data[i + 1] - mean[1]) ** 2;
    variance[2] += (data[i + 2] - mean[2]) ** 2;
  }
  return {
    mean,
    std: [
      Math.sqrt(variance[0] / count) || 1,
      Math.sqrt(variance[1] / count) || 1,
      Math.sqrt(variance[2] / count) || 1,
    ],
  };
}

const clampByte = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/**
 * Pull the enhanced result back toward the source image's color statistics.
 * Image-edit models often "beautify" saturation/contrast; this keeps the
 * output feeling like the same artwork while preserving the new detail.
 */
export async function matchToneDataUrl(
  sourceSrc: string,
  targetSrc: string,
  quality = 0.94,
): Promise<string> {
  if (
    sourceSrc.startsWith("data:image/svg") ||
    targetSrc.startsWith("data:image/svg")
  ) {
    return targetSrc;
  }
  try {
    const [sourceImg, targetImg] = await Promise.all([
      loadImage(sourceSrc),
      loadImage(targetSrc),
    ]);
    const targetW = targetImg.naturalWidth || targetImg.width;
    const targetH = targetImg.naturalHeight || targetImg.height;
    const sampleLong = 256;
    const scale = sampleLong / Math.max(targetW, targetH);
    const sampleW = Math.max(1, Math.round(targetW * scale));
    const sampleH = Math.max(1, Math.round(targetH * scale));
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = sampleW;
    sampleCanvas.height = sampleH;
    const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleCtx) return targetSrc;
    sampleCtx.imageSmoothingEnabled = true;
    sampleCtx.imageSmoothingQuality = "high";
    drawCover(sampleCtx, sourceImg, sampleW, sampleH);
    const sourceStats = rgbStats(
      sampleCtx.getImageData(0, 0, sampleW, sampleH).data,
    );
    sampleCtx.clearRect(0, 0, sampleW, sampleH);
    drawCover(sampleCtx, targetImg, sampleW, sampleH);
    const targetStats = rgbStats(
      sampleCtx.getImageData(0, 0, sampleW, sampleH).data,
    );

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return targetSrc;
    ctx.drawImage(targetImg, 0, 0, targetW, targetH);
    const imageData = ctx.getImageData(0, 0, targetW, targetH);
    const data = imageData.data;
    const strength = 0.82;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 16) continue;
      for (let c = 0; c < 3; c += 1) {
        const matched =
          ((data[i + c] - targetStats.mean[c]) / targetStats.std[c]) *
            sourceStats.std[c] +
          sourceStats.mean[c];
        data[i + c] = clampByte(data[i + c] * (1 - strength) + matched * strength);
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return targetSrc;
  }
}

/**
 * Fast, local sharpness estimate using average luminance gradient on a downsampled
 * image. Higher usually means crisper edges/textures; it is a QA hint, not a
 * replacement for visual review.
 */
export async function estimateSharpnessDataUrl(src: string): Promise<number> {
  if (src.startsWith("data:image/svg")) return 0;
  try {
    const img = await loadImage(src);
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    const sampleLong = 384;
    const scale = Math.min(1, sampleLong / Math.max(w0, h0));
    const w = Math.max(2, Math.round(w0 * scale));
    const h = Math.max(2, Math.round(h0 * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 0;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      lum[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }
    let sum = 0;
    let count = 0;
    for (let y = 1; y < h; y += 1) {
      for (let x = 1; x < w; x += 1) {
        const p = y * w + x;
        sum += Math.abs(lum[p] - lum[p - 1]) + Math.abs(lum[p] - lum[p - w]);
        count += 2;
      }
    }
    return count ? +(sum / count).toFixed(2) : 0;
  } catch {
    return 0;
  }
}

/**
 * Chroma-key pure-green background to transparency (element layering).
 * Green dominance → alpha 0, with a soft edge band + despill.
 */
export async function chromaKeyGreen(
  src: string,
): Promise<{ dataUrl: string; width: number; height: number; removedFrac: number }> {
  const img = await loadImage(src);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  let removed = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    // How much green exceeds the other channels.
    const dom = g - Math.max(r, b);
    if (dom > 60 && g > 90) {
      px[i + 3] = 0; // solid green → fully transparent
      removed++;
    } else if (dom > 25 && g > 70) {
      px[i + 3] = Math.max(0, 255 - dom * 6); // edge band → feathered
      px[i + 1] = Math.max(r, b); // despill the green cast
    }
  }
  ctx.putImageData(data, 0, 0);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: w,
    height: h,
    removedFrac: removed / (w * h),
  };
}

export interface AlphaIsland {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Split a transparent PNG into独立图层: find connected islands of opaque
 * pixels (with slight dilation so text strokes group together) and crop each
 * into its own PNG. Powers 元素分层 — one green-screen call → N layers.
 */
export async function splitAlphaIslands(
  src: string,
  opts: { minAreaFrac?: number; pad?: number; maxIslands?: number } = {},
): Promise<AlphaIsland[]> {
  const { minAreaFrac = 0.0025, pad = 10, maxIslands = 8 } = opts;
  const img = await loadImage(src);
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  const full = document.createElement("canvas");
  full.width = W;
  full.height = H;
  full.getContext("2d")!.drawImage(img, 0, 0);

  // Label islands on a downscaled alpha mask (fast, resolution-independent).
  const scale = Math.min(1, 420 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const smallC = document.createElement("canvas");
  smallC.width = w;
  smallC.height = h;
  const sctx = smallC.getContext("2d")!;
  sctx.drawImage(img, 0, 0, w, h);
  const a = sctx.getImageData(0, 0, w, h).data;
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = a[i * 4 + 3] > 40 ? 1 : 0;

  // Dilate so nearby fragments (e.g. text strokes) merge into one island.
  const dil = new Uint8Array(solid);
  const R = 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid[y * w + x]) continue;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) dil[ny * w + nx] = 1;
        }
      }
    }
  }

  const seen = new Uint8Array(w * h);
  const boxes: { x0: number; y0: number; x1: number; y1: number; area: number }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!dil[s] || seen[s]) continue;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    let area = 0;
    stack.length = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p / w) | 0;
      if (solid[p]) area++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      if (px > 0 && dil[p - 1] && !seen[p - 1]) {
        seen[p - 1] = 1;
        stack.push(p - 1);
      }
      if (px < w - 1 && dil[p + 1] && !seen[p + 1]) {
        seen[p + 1] = 1;
        stack.push(p + 1);
      }
      if (py > 0 && dil[p - w] && !seen[p - w]) {
        seen[p - w] = 1;
        stack.push(p - w);
      }
      if (py < h - 1 && dil[p + w] && !seen[p + w]) {
        seen[p + w] = 1;
        stack.push(p + w);
      }
    }
    if (area / (w * h) >= minAreaFrac) boxes.push({ x0, y0, x1, y1, area });
  }
  boxes.sort((m, n) => n.area - m.area);

  const out: AlphaIsland[] = [];
  for (const b of boxes.slice(0, maxIslands)) {
    const X0 = Math.max(0, Math.round(b.x0 / scale) - pad);
    const Y0 = Math.max(0, Math.round(b.y0 / scale) - pad);
    const X1 = Math.min(W, Math.round((b.x1 + 1) / scale) + pad);
    const Y1 = Math.min(H, Math.round((b.y1 + 1) / scale) + pad);
    const cw = X1 - X0;
    const ch = Y1 - Y0;
    if (cw < 12 || ch < 12) continue;
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    c.getContext("2d")!.drawImage(full, X0, Y0, cw, ch, 0, 0, cw, ch);
    out.push({ dataUrl: c.toDataURL("image/png"), width: cw, height: ch });
  }
  return out;
}

/** Bake brightness/contrast/saturation (each -50..50) into a new image. */
export async function bakeAdjustments(
  src: string,
  adj: { brightness: number; contrast: number; saturation: number },
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadImage(src);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.filter = adjustmentsToCssFilter(adj);
  ctx.drawImage(img, 0, 0);
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.93), width: w, height: h };
}

/** The same mapping used for live CSS preview and the canvas bake. */
export function adjustmentsToCssFilter(adj: {
  brightness: number;
  contrast: number;
  saturation: number;
}): string {
  const b = 1 + adj.brightness / 100;
  const c = 1 + adj.contrast / 100;
  const s = 1 + adj.saturation / 100;
  return `brightness(${b}) contrast(${c}) saturate(${s})`;
}

/**
 * Read a File, downscale it (so it fits comfortably in localStorage) and return
 * a data URL plus the ORIGINAL natural dimensions for display/metadata.
 */
export async function fileToDownscaledDataUrl(
  file: File,
  maxSide = 1280,
  quality = 0.85,
): Promise<LoadedImage> {
  const original = await readFileAsDataURL(file);
  const img = await loadImage(original);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  const scale = Math.min(1, maxSide / Math.max(width, height));
  // Keep small files (and SVGs) as-is.
  if ((scale >= 1 && file.size < 400_000) || file.type === "image/svg+xml") {
    return { dataUrl: original, originalDataUrl: original, width, height };
  }

  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { dataUrl: original, width, height };
  ctx.drawImage(img, 0, 0, w, h);
  // Preserve transparency for PNG/WebP; JPEG otherwise (smaller).
  const hasAlpha = file.type === "image/png" || file.type === "image/webp";
  const dataUrl = canvas.toDataURL(
    hasAlpha ? "image/webp" : "image/jpeg",
    quality,
  );
  return { dataUrl, originalDataUrl: original, width, height };
}
