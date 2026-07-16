"use client";

import { isImageItem } from "./types";
import type { CanvasItem, ImageItem } from "./types";

const sourceByItemId = new Map<string, string>();

export function rememberAssetSource(itemId: string, dataUrl?: string) {
  if (dataUrl?.startsWith("data:image/")) sourceByItemId.set(itemId, dataUrl);
}

export function forgetAssetSource(itemId: string) {
  sourceByItemId.delete(itemId);
}

export function bestAssetUrlFor(item: ImageItem): string {
  return sourceByItemId.get(item.id) ?? item.assetUrl;
}

export function bestAssetUrlForId(itemId: string, items: CanvasItem[]): string | null {
  const item = items.find((it): it is ImageItem => it.id === itemId && isImageItem(it));
  return item ? bestAssetUrlFor(item) : null;
}
