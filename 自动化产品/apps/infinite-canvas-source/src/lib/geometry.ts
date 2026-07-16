import type { CanvasItem, Size, Vec2 } from "./types";

/** A card footprint on the canvas: longest side clamped to `max` world px. */
export function footprintFor(
  naturalW: number,
  naturalH: number,
  max = 320,
): Size {
  const longest = Math.max(naturalW, naturalH) || 1;
  const scale = max / longest;
  return {
    width: Math.max(40, Math.round(naturalW * scale)),
    height: Math.max(40, Math.round(naturalH * scale)),
  };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function itemRect(it: CanvasItem): Rect {
  return {
    x: it.position.x,
    y: it.position.y,
    width: it.size.width,
    height: it.size.height,
  };
}

export function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return !(
    a.x + a.width + pad <= b.x ||
    b.x + b.width + pad <= a.x ||
    a.y + a.height + pad <= b.y ||
    b.y + b.height + pad <= a.y
  );
}

/** Bounding box of all items (world space), or null when empty. */
export function contentBounds(items: CanvasItem[]): Rect | null {
  if (items.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.position.x);
    minY = Math.min(minY, it.position.y);
    maxX = Math.max(maxX, it.position.x + it.size.width);
    maxY = Math.max(maxY, it.position.y + it.size.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** A spot to drop new results: to the right of existing content, or the origin. */
export function anchorFor(items: CanvasItem[]): Vec2 {
  const b = contentBounds(items);
  if (b) return { x: b.x + b.width + 60, y: b.y };
  return { x: 40, y: 40 };
}

/**
 * Find a non-overlapping position for a new card near `anchor`, scanning in a
 * widening spiral-ish grid so generated results land tidily beside existing work.
 */
export function findFreeSpot(
  items: CanvasItem[],
  anchor: Vec2,
  size: Size,
  gap = 32,
): Vec2 {
  const rects = items.map(itemRect);
  const stepX = size.width + gap;
  const stepY = size.height + gap;
  const candidate = (col: number, row: number): Rect => ({
    x: anchor.x + col * stepX,
    y: anchor.y + row * stepY,
    width: size.width,
    height: size.height,
  });
  for (let ring = 0; ring < 12; ring++) {
    for (let col = -ring; col <= ring; col++) {
      for (let row = -ring; row <= ring; row++) {
        if (Math.max(Math.abs(col), Math.abs(row)) !== ring) continue;
        const c = candidate(col, row);
        if (!rects.some((r) => rectsOverlap(r, c, gap / 2))) {
          return { x: c.x, y: c.y };
        }
      }
    }
  }
  return { x: anchor.x, y: anchor.y };
}
