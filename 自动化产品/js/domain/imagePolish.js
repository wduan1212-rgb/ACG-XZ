/* 发布前图片精修：同尺寸 canvas 重绘，剥离元数据并做轻量像素重写。
   不裁剪、不扩图、不叠加装饰，避免破坏中文文字边缘。 */

function hashSeed(str = "") {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp255(v) {
  return Math.max(0, Math.min(255, v));
}

function polishPixels(ctx, w, h, seedText) {
  let imgData;
  try {
    imgData = ctx.getImageData(0, 0, w, h);
  } catch (_) {
    return;
  }
  const data = imgData.data;
  const rnd = seeded(hashSeed(`${seedText}:${w}x${h}`));
  const contrast = 1.012;
  const saturation = 1.010;
  const brightness = 1.003;
  const noiseScale = 0.65;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) continue;
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    const gray = r * 0.299 + g * 0.587 + b * 0.114;
    const microNoise = (rnd() - 0.5) * noiseScale;
    r = ((r - gray) * saturation + gray - 128) * contrast + 128;
    g = ((g - gray) * saturation + gray - 128) * contrast + 128;
    b = ((b - gray) * saturation + gray - 128) * contrast + 128;
    data[i] = clamp255(r * brightness + microNoise);
    data[i + 1] = clamp255(g * brightness + microNoise);
    data[i + 2] = clamp255(b * brightness + microNoise);
  }
  ctx.putImageData(imgData, 0, 0);
}

export function polishImageForPublish(dataUrl, seedText = "") {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) return resolve(dataUrl);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
      if (!ctx) return resolve(dataUrl);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.filter = "saturate(1.006) contrast(1.006) brightness(1.002)";
      ctx.drawImage(img, 0, 0, w, h);
      ctx.filter = "none";
      polishPixels(ctx, w, h, seedText);
      const mime = dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg";
      resolve(canvas.toDataURL(mime, mime === "image/jpeg" ? 0.95 : undefined));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
