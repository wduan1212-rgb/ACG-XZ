import { itemRect, rectsOverlap } from "./geometry";
import { loadImage } from "./image";
import type { CanvasItem, ImageItem, ShapeItem, TextItem } from "./types";

export type CanvasMarkItem = TextItem | ShapeItem;

const MAX_SIDE = 8192;

export function overlappingMarksFor(
  imageItem: ImageItem,
  allItems: CanvasItem[],
): CanvasMarkItem[] {
  const imageRect = itemRect(imageItem);
  return allItems.filter(
    (item): item is CanvasMarkItem =>
      (item.type === "text" || item.type === "shape") &&
      rectsOverlap(itemRect(item), imageRect),
  );
}

function drawMarks(
  ctx: CanvasRenderingContext2D,
  marks: CanvasMarkItem[],
  imageRect: { x: number; y: number; width: number; height: number },
  scaleX: number,
  scaleY: number,
) {
  const lineWidth = (mark: ShapeItem) =>
    Math.max(1, mark.strokeWidth * ((scaleX + scaleY) / 2));

  for (const mark of marks) {
    const x = (mark.position.x - imageRect.x) * scaleX;
    const y = (mark.position.y - imageRect.y) * scaleY;
    const width = mark.size.width * scaleX;
    const height = mark.size.height * scaleY;
    ctx.save();
    if (mark.rotation) {
      const centerX = x + width / 2;
      const centerY = y + height / 2;
      ctx.translate(centerX, centerY);
      ctx.rotate((mark.rotation * Math.PI) / 180);
      ctx.translate(-centerX, -centerY);
    }
    if (mark.type === "text") {
      const fontSize = mark.fontSize * scaleX;
      ctx.font = `500 ${fontSize}px var(--font-geist-sans), 'PingFang SC', 'Microsoft YaHei', sans-serif`;
      ctx.fillStyle = mark.color;
      ctx.textBaseline = "top";
      const lineHeight = fontSize * 1.22;
      mark.text
        .split("\n")
        .forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight));
      ctx.restore();
      continue;
    }

    ctx.strokeStyle = mark.stroke;
    ctx.lineWidth = lineWidth(mark);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const hasFill =
      mark.fill && mark.fill !== "none" && mark.fill !== "transparent";
    ctx.beginPath();
    if (mark.shape === "rect") {
      const radius = Math.min(8 * scaleX, width / 3, height / 3);
      ctx.roundRect(x, y, width, height, radius);
    } else if (mark.shape === "ellipse") {
      ctx.ellipse(
        x + width / 2,
        y + height / 2,
        width / 2,
        height / 2,
        0,
        0,
        Math.PI * 2,
      );
    } else if (mark.shape === "line" || mark.shape === "arrow") {
      ctx.moveTo(x + 10 * scaleX, y + height - 10 * scaleY);
      ctx.lineTo(x + width - 10 * scaleX, y + 10 * scaleY);
    } else if (mark.shape === "triangle") {
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x + width, y + height);
      ctx.lineTo(x, y + height);
      ctx.closePath();
    } else if (mark.shape === "star") {
      const centerX = x + width / 2;
      const centerY = y + height / 2;
      const outer = Math.min(width, height) * 0.44;
      const inner = outer * 0.44;
      for (let index = 0; index < 10; index += 1) {
        const radius = index % 2 === 0 ? outer : inner;
        const angle = -Math.PI / 2 + (Math.PI * 2 * index) / 10;
        const pointX = centerX + Math.cos(angle) * radius;
        const pointY = centerY + Math.sin(angle) * radius;
        if (index === 0) ctx.moveTo(pointX, pointY);
        else ctx.lineTo(pointX, pointY);
      }
      ctx.closePath();
    }
    if (hasFill) {
      ctx.fillStyle = mark.fill;
      ctx.fill();
    }
    ctx.stroke();
    if (mark.shape === "arrow") {
      const endX = x + width - 10 * scaleX;
      const endY = y + 10 * scaleY;
      const angle = Math.atan2(
        endY - (y + height - 10 * scaleY),
        endX - (x + 10 * scaleX),
      );
      const length = Math.max(10, lineWidth(mark) * 3.2);
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(
        endX - length * Math.cos(angle - 0.42),
        endY - length * Math.sin(angle - 0.42),
      );
      ctx.moveTo(endX, endY);
      ctx.lineTo(
        endX - length * Math.cos(angle + 0.42),
        endY - length * Math.sin(angle + 0.42),
      );
      ctx.stroke();
    }
    ctx.restore();
  }
}

export async function renderCanvasOutput({
  imageItem,
  marks,
  targetWidth,
  targetHeight,
  mime,
  quality = 0.92,
}: {
  imageItem: ImageItem;
  marks: CanvasMarkItem[];
  targetWidth: number;
  targetHeight: number;
  mime: string;
  quality?: number;
}): Promise<{ blob: Blob; width: number; height: number }> {
  const image = await loadImage(imageItem.assetUrl);
  let width = targetWidth;
  let height = targetHeight;
  const longest = Math.max(width, height);
  if (longest > MAX_SIDE) {
    const factor = MAX_SIDE / longest;
    width = Math.round(width * factor);
    height = Math.round(height * factor);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");

  const imageRatio = image.width / image.height;
  const canvasRatio = width / height;
  let drawWidth: number;
  let drawHeight: number;
  if (imageRatio > canvasRatio) {
    drawHeight = height;
    drawWidth = height * imageRatio;
  } else {
    drawWidth = width;
    drawHeight = width / imageRatio;
  }
  ctx.drawImage(
    image,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  if (marks.length) {
    drawMarks(
      ctx,
      marks,
      itemRect(imageItem),
      width / imageItem.size.width,
      height / imageItem.size.height,
    );
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result) resolve(result);
        else reject(new Error("图片合成失败"));
      },
      mime,
      quality,
    );
  });
  return { blob, width, height };
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string" && reader.result) resolve(reader.result);
      else reject(new Error("图片编码失败"));
    });
    reader.addEventListener("error", () =>
      reject(reader.error || new Error("图片编码失败")),
    );
    reader.readAsDataURL(blob);
  });
}
