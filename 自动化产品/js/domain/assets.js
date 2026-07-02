/* 资产领域：共享模式下二进制上传到服务端，离线模式保留 IndexedDB Blob 缓存 */

import { db } from "../core/db.js";
import { state, save, assetById, removeRemote, ownedBy } from "../core/store.js";
import * as remote from "../core/remote.js";
import { uid, esc, gradFor, dataUrlToBlob, extOfMime } from "../core/util.js";

const urlCache = new Map(); // assetId -> objectURL
const IMAGE_PROCESS_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/* 全局上传编号：按上传先后顺序递增（资产库全员共享，统一编号排序） */
function nextSeq() {
  state.ui.assetSeq = (state.ui.assetSeq || 0) + 1;
  return state.ui.assetSeq;
}
/* 资产展示编号，如 M0007 */
export const assetCode = a => a && a.seq ? `M${String(a.seq).padStart(4, "0")}` : "";

export async function preloadBlobUrls() {
  const entries = await db.getAllBlobEntries();
  entries.forEach(({ id, blob }) => {
    if (blob instanceof Blob && !urlCache.has(id)) urlCache.set(id, URL.createObjectURL(blob));
  });
}

function serverFileUrl(a) {
  const u = a && (a.fileUrl || a.url || "");
  if (!u || u.startsWith("blob:") || u.startsWith("data:")) return "";
  return u;
}

function fileNameFor(a, fallback = "") {
  const base = String(fallback || a.name || a.id || "asset");
  return base.includes(".") ? base : `${base}.${extOfMime(a.mime || "application/octet-stream")}`;
}

function hashText(text = "") {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function assetHashFromDataUrl(dataUrl = "") {
  if (!dataUrl) return "";
  const body = String(dataUrl).replace(/^data:[^,]*,/, "");
  return `du-${hashText(body || dataUrl).toString(36)}`;
}

async function assetHashFromBlob(blob) {
  if (!(blob instanceof Blob)) return "";
  const buf = await blob.arrayBuffer();
  let h = 2166136261;
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return `bl-${(h >>> 0).toString(36)}-${blob.size}`;
}

function mergeAssetMeta(existing, { accountId, tags = [], name = "" } = {}) {
  existing.tags = [...new Set([...(existing.tags || []), ...(tags || [])])];
  if (!existing.accountId && accountId) existing.accountId = accountId;
  if (!existing.name && name) existing.name = name;
  existing.updatedAt = Date.now();
  save("assets");
  return existing;
}

function duplicateAssetByHash(hash, type = "图片") {
  if (!hash) return null;
  return state.assets.find(a => a.type === type && a.contentHash === hash) || null;
}

function seededRand(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function lightlyProcessImageBlob(blob, seed = "") {
  if (!(blob instanceof Blob) || !IMAGE_PROCESS_TYPES.has(blob.type)) return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageFromUrl(url);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return blob;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return blob;
    const rand = seededRand(hashText(`${seed}:${blob.size}:${w}x${h}`));
    const saturate = 1.055;
    const contrast = 1.045;
    const brightness = 1.018;
    ctx.filter = `saturate(${saturate}) contrast(${contrast}) brightness(${brightness})`;
    ctx.drawImage(img, 0, 0, w, h);
    ctx.filter = "none";

    const light = ctx.createLinearGradient(0, 0, w, h);
    light.addColorStop(0, "rgba(255,255,255,.10)");
    light.addColorStop(0.42, "rgba(255,255,255,.025)");
    light.addColorStop(1, "rgba(36,76,180,.035)");
    ctx.globalCompositeOperation = "soft-light";
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";

    const palette = [
      [61, 91, 255],
      [12, 166, 120],
      [255, 139, 38],
      [230, 73, 128],
      [34, 139, 230]
    ];
    const corners = [
      [w * 0.035, h * 0.035, 1, 1],
      [w * 0.965, h * 0.035, -1, 1],
      [w * 0.035, h * 0.965, 1, -1],
      [w * 0.965, h * 0.965, -1, -1]
    ];
    const accentCount = Math.floor(rand() * 3); // 0-2 个角点，避免每张图四角都有装饰。
    const selectedCorners = corners
      .map((corner, i) => ({ corner, i, order: rand() }))
      .sort((a, b) => a.order - b.order)
      .slice(0, accentCount);
    selectedCorners.forEach(({ corner: [x, y, sx, sy], i }) => {
      const c = palette[(i + Math.floor(rand() * palette.length)) % palette.length];
      const size = Math.max(8, Math.min(w, h) * (0.008 + rand() * 0.012));
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((rand() - 0.5) * 0.55);
      ctx.globalAlpha = 0.08 + rand() * 0.08;
      ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.lineWidth = Math.max(1, size * 0.12);
      if (rand() > 0.5) {
        ctx.beginPath();
        ctx.arc(sx * size * 0.6, sy * size * 0.6, size * 0.65, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(0, sy * size);
        ctx.lineTo(sx * size * 1.7, 0);
        ctx.lineTo(sx * size * 0.7, sy * size * 1.8);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    });

    const outType = blob.type === "image/png" ? "image/png" : "image/jpeg";
    return await new Promise(resolve => {
      canvas.toBlob(next => resolve(next || blob), outType, 0.96);
    });
  } catch (e) {
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadServerFile(a, blob, filename = "") {
  if (!remote.isOn() || !remote.hasToken() || !(blob instanceof Blob)) return null;
  const mime = blob.type || a.mime || "application/octet-stream";
  const qs = new URLSearchParams({ filename: fileNameFor(a, filename), mime });
  const res = await fetch(`/api/files/${encodeURIComponent(a.id)}?${qs.toString()}`, {
    method: "PUT",
    headers: {
      "Content-Type": mime,
      "Authorization": "Bearer " + remote.getToken()
    },
    body: blob
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.fileUrl) throw new Error(data.detail || data.error || `文件上传服务器失败 (${res.status})`);
  a.fileUrl = data.fileUrl;
  a.url = data.fileUrl;
  a.mime = data.mime || mime;
  a.size = data.size || blob.size || a.size || 0;
  a.serverFileName = data.name || "";
  a.hasBlob = true;
  a.storage = "server";
  a.fileMissing = false;
  delete a.uploadError;
  delete a.dataUrl;
  return data;
}

export function urlFor(idOrAsset) {
  const a = typeof idOrAsset === "string" ? assetById(idOrAsset) : idOrAsset;
  if (!a) return null;
  if (urlCache.has(a.id)) return urlCache.get(a.id);
  const remoteUrl = serverFileUrl(a);
  if (remoteUrl) return remoteUrl;
  if (a.dataUrl) return a.dataUrl; // 兼容遗留小数据
  return null;
}

/* 新增资产（dataUrl 形式进来 → 转 Blob 落库） */
export async function addAssetFromDataUrl(accountId, { name, type = "图片", tags = [], dataUrl }) {
  const contentHash = dataUrl ? assetHashFromDataUrl(dataUrl) : "";
  const dup = duplicateAssetByHash(contentHash, type);
  if (dup) return mergeAssetMeta(dup, { accountId, tags, name });
  const a = { id: uid(), accountId, seq: nextSeq(), ownerId: state.ui.currentMemberId || null, name: name || "未命名素材", type, tags, createdAt: Date.now(), hasBlob: !!dataUrl, contentHash };
  if (dataUrl) {
    try {
      const raw = dataUrlToBlob(dataUrl);
      const blob = type === "图片" ? await lightlyProcessImageBlob(raw, name || a.name) : raw;
      await db.putBlob(a.id, blob);
      urlCache.set(a.id, URL.createObjectURL(blob));
      if (blob !== raw) a.processed = "clarity-filter-v2";
      await uploadServerFile(a, blob, name || a.name);
    } catch (e) {
      if (remote.isOn() && remote.hasToken()) throw e;
      a.dataUrl = dataUrl; a.hasBlob = false;
    }
  }
  state.assets.push(a);
  save("assets", "meta");
  return a;
}

export async function addAssetFromFile(accountId, file, { tags = [], name } = {}) {
  const type = file.type.startsWith("video/") ? "视频" : file.type.startsWith("audio/") ? "音频" : "图片";
  const assetName = name || file.name.replace(/\.[^.]+$/, "");
  const blob = type === "图片" ? await lightlyProcessImageBlob(file, file.name || assetName) : file;
  const contentHash = await assetHashFromBlob(blob);
  const dup = duplicateAssetByHash(contentHash, type);
  if (dup) return mergeAssetMeta(dup, { accountId, tags, name: assetName });
  const a = { id: uid(), accountId, seq: nextSeq(), ownerId: state.ui.currentMemberId || null, name: assetName, type, tags, createdAt: Date.now(), hasBlob: true, mime: file.type, contentHash };
  if (blob !== file) {
    a.processed = "clarity-filter-v2";
    a.mime = blob.type || a.mime;
  }
  await db.putBlob(a.id, blob);
  urlCache.set(a.id, URL.createObjectURL(blob));
  await uploadServerFile(a, blob, file.name);
  state.assets.push(a);
  save("assets", "meta");
  return a;
}

/* 覆盖资产二进制（如重新回传同槽位） */
export async function replaceAssetBlob(assetId, dataUrl) {
  const a = assetById(assetId); if (!a) return;
  const raw = dataUrlToBlob(dataUrl);
  const blob = a.type === "图片" ? await lightlyProcessImageBlob(raw, a.name) : raw;
  await db.putBlob(a.id, blob);
  const old = urlCache.get(a.id);
  if (old) URL.revokeObjectURL(old);
  urlCache.set(a.id, URL.createObjectURL(blob));
  if (blob !== raw) a.processed = "clarity-filter-v2";
  await uploadServerFile(a, blob, a.name);
  a.hasBlob = true; delete a.dataUrl;
  save("assets");
}

export async function removeAsset(id) {
  const a = assetById(id); if (!a) return;
  state.assets = state.assets.filter(x => x.id !== id);
  await db.delBlob(id);
  const u = urlCache.get(id);
  if (u) { URL.revokeObjectURL(u); urlCache.delete(id); }
  if (a.serverFileName && remote.isOn() && remote.hasToken()) {
    fetch(`/api/files/${encodeURIComponent(a.serverFileName)}`, {
      method: "DELETE",
      headers: { "Authorization": "Bearer " + remote.getToken() }
    }).catch(() => null);
  }
  save("assets");
  removeRemote("assets", id);
}

export async function assetBlob(id) {
  const local = await db.getBlob(id);
  if (local) return local;
  const a = assetById(id);
  const u = serverFileUrl(a);
  if (!u) return null;
  try {
    const res = await fetch(u, { cache: "no-store" });
    if (!res.ok) return null;
    const blob = await res.blob();
    await db.putBlob(id, blob).catch(() => null);
    if (!urlCache.has(id)) urlCache.set(id, URL.createObjectURL(blob));
    return blob;
  } catch (e) {
    return null;
  }
}

export async function assetU8(id) {
  const b = await assetBlob(id);
  if (!b) return null;
  return { u8: new Uint8Array(await b.arrayBuffer()), ext: extOfMime(b.type || "image/png") };
}

/* 缩略 html：有图用图，无图用渐变占位 */
const TYPE_HUE = { "图片": "linear-gradient(135deg,#3D5BFF,#4b8dff)", "视频": "linear-gradient(135deg,#7A4DFF,#3D5BFF)", "音频": "linear-gradient(135deg,#0CA678,#22B8CF)", "图集": "linear-gradient(135deg,#E64980,#7A4DFF)" };
export function thumbHtml(a, cls = "") {
  const u = urlFor(a);
  if (u && a.type !== "音频") return `<img class="${cls}" src="${u}" alt="" loading="lazy"/>`;
  return `<div class="ph ${cls}" style="background:${TYPE_HUE[a.type] || gradFor(a.name)}"><span>${esc((a.type || a.name || "素")[0])}</span></div>`;
}

export function searchAssets({ accountId = "all", tag = "all", q = "", includeDelivered = false } = {}) {
  const kw = q.trim().toLowerCase();
  return state.assets.filter(a => {
    if (!a.delivered && !a.shared && !ownedBy(a)) return false;
    if (!includeDelivered && a.delivered) return false;
    if (accountId !== "all" && a.accountId !== accountId) return false;
    if (tag !== "all" && !(a.tags || []).includes(tag)) return false;
    if (kw && !a.name.toLowerCase().includes(kw) && !(a.tags || []).some(t => t.toLowerCase().includes(kw))) return false;
    return true;
  });
}

export function allTags(accountId = "all") {
  const set = new Set();
  state.assets.forEach(a => {
    if (!a.delivered && !a.shared && !ownedBy(a)) return;
    if (a.delivered) return;
    if (accountId !== "all" && a.accountId !== accountId) return;
    (a.tags || []).forEach(t => set.add(t));
  });
  return [...set];
}
