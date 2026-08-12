/* 资产领域：共享模式下二进制上传到服务端，离线模式保留 IndexedDB Blob 缓存 */

import { db } from "../core/db.js";
import { state, save, assetById, accountById, ownedBy, persistRecoveredDocuments } from "../core/store.js";
import * as remote from "../core/remote.js";
import { uid, esc, gradFor, dataUrlToBlob, extOfMime } from "../core/util.js";

const urlCache = new Map(); // assetId -> objectURL
const IMAGE_PROCESS_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const FILE_MIME_BY_EXTENSION = Object.freeze({
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  avif: "image/avif",
  heic: "image/heic",
  svg: "image/svg+xml",
});
const GENERIC_BINARY_MIMES = new Set([
  "application/octet-stream",
  "application/binary",
  "binary/octet-stream",
]);
const CANONICAL_MIME_ALIASES = Object.freeze({
  "audio/mp3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mpeg-3": "audio/mpeg",
  "audio/mpg": "audio/mpeg",
});

function validAssetMime(value) {
  const mime = String(value || "").trim().toLowerCase().split(";", 1)[0];
  if (!mime || GENERIC_BINARY_MIMES.has(mime)) return "";
  return CANONICAL_MIME_ALIASES[mime] || mime;
}

function assetMimeFromFilename(name = "") {
  const extension = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  return FILE_MIME_BY_EXTENSION[extension] || "";
}

export function inferAssetFileMime(file) {
  return validAssetMime(file?.type)
    || assetMimeFromFilename(file?.name)
    || "application/octet-stream";
}

function resolvedAssetBlobMime(blob, fallbackMime = "", filename = "") {
  return validAssetMime(blob?.type)
    || validAssetMime(fallbackMime)
    || assetMimeFromFilename(filename)
    || "application/octet-stream";
}

export function normalizeAssetBlobMime(blob, fallbackMime = "", filename = "") {
  if (!(blob instanceof Blob)) return blob;
  const declared = String(blob.type || "").trim().toLowerCase().split(";", 1)[0];
  const current = validAssetMime(blob.type);
  const resolved = resolvedAssetBlobMime(blob, fallbackMime, filename);
  if ((current && current === declared) || resolved === "application/octet-stream") return blob;
  return blob.slice(0, blob.size, resolved);
}

export function assetTypeForFile(file) {
  const mime = inferAssetFileMime(file);
  if (mime.startsWith("video/")) return "视频";
  if (mime.startsWith("audio/")) return "音频";
  return "图片";
}

export function inferAssetFileMeta(file) {
  return {
    mime: inferAssetFileMime(file),
    type: assetTypeForFile(file),
  };
}

const assetTagText = asset => (asset?.tags || []).map(tag => String(tag || "").trim()).join(" ");
export function isBgmAsset(asset) {
  if (asset?.type !== "音频") return false;
  const tags = assetTagText(asset);
  const explicitBgm = /BGM|音乐库|配乐/i.test(tags);
  const explicitVoice = /口播|语音|参考音频库|TTS|数字人|声线参考/i.test(tags);
  if (explicitBgm) return !explicitVoice;
  const name = String(asset?.name || "");
  return /BGM|音乐库|配乐/i.test(name) && !/口播|语音|TTS|数字人|声线参考/i.test(`${tags} ${name}`);
}

export function isEditingMaterialAsset(asset) {
  if (!["图片", "视频"].includes(asset?.type)) return false;
  return /剪辑素材|共享剪辑素材|图片素材|视频素材|素材库/.test(assetTagText(asset));
}

export const isGlobalEditingAsset = asset => isBgmAsset(asset) || isEditingMaterialAsset(asset);

const assetIsDeliveryDependency = assetId => state.assets.some(item => item?.delivered && (
  item.coverAssetId === assetId || (item.packAssetIds || []).includes(assetId)
));

export function isProtectedReferenceAsset(asset) {
  if (!asset?.id) return true;
  const text = `${asset.name || ""} ${assetTagText(asset)}`;
  if (asset.delivered || asset.shared || /已发布生成图|站内生成|笔记图|共享素材/.test(text)) return true;
  if (assetIsDeliveryDependency(asset.id)) return true;
  if (state.accounts.some(account => account?.avatarAssetId === asset.id)) return true;
  return state.accounts.some(account =>
    account?.mode === "视频"
    && account?.charBoardAssetId === asset.id
  );
}

/* 普通成员可删除自己上传的参考图，也可清理旧版管理员绑定的图文风格图。
   数字人角色版、账号头像与任何已发布/交付依赖始终走受保护的管理链路。 */
export function canDeleteReferenceAsset(asset) {
  if (!asset?.id) return false;
  const protectedAsset = isProtectedReferenceAsset(asset);
  const isDigitalRoleBoard = state.accounts.some(account =>
    account?.mode === "视频"
    && account?.charBoardAssetId === asset.id
  );
  if (protectedAsset) return state.role === "admin" && isDigitalRoleBoard;
  if (state.role === "admin" || ownedBy(asset)) return true;
  return state.role === "editor" && state.accounts.some(account => account?.imageStyleAssetId === asset.id);
}

export function globalBgmAssets() {
  return state.assets
    .filter(asset => isBgmAsset(asset) && !asset.delivered)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

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

function managedServerFileUrl(a, url = "") {
  const raw = String(url || "");
  if (!raw) return false;
  let pathname = "";
  try {
    const origin = globalThis.location?.origin || "http://local.invalid";
    pathname = new URL(raw, origin).pathname;
  } catch {
    pathname = raw.split(/[?#]/, 1)[0];
  }
  return pathname.startsWith("/api/files/")
    && (a?.storage === "server" || !!a?.serverFileName || raw.startsWith("/api/files/"));
}

function assetFileRevision(a) {
  const at = Number(a?.blobUpdatedAt || a?.createdAt || 0);
  const hash = String(a?.contentHash || "").replace(/[^a-zA-Z0-9._~-]/g, "").slice(0, 64);
  return [at > 0 ? Math.trunc(at).toString(36) : "", hash].filter(Boolean).join("-");
}

function versionedServerFileUrl(a, url = "") {
  if (!managedServerFileUrl(a, url)) return url;
  const revision = assetFileRevision(a);
  if (!revision) return url;
  const hashAt = url.indexOf("#");
  const fragment = hashAt >= 0 ? url.slice(hashAt) : "";
  const withoutHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = withoutHash.indexOf("?");
  const path = queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash;
  const params = new URLSearchParams(queryAt >= 0 ? withoutHash.slice(queryAt + 1) : "");
  params.set("asset_rev", revision);
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}${fragment}`;
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

function incomingAssetLibraryRole(tags = []) {
  const text = (tags || []).map(tag => String(tag || "")).join(" ");
  if (/参考音频库|声线参考/i.test(text)) return "reference-audio";
  if (/语音素材库|口播|TTS/i.test(text)) return "voice-audio";
  if (/BGM|音乐库|配乐/i.test(text)) return "bgm";
  if (/剪辑素材|共享剪辑素材|图片素材|视频素材|素材库/.test(text)) return "editing-material";
  return "";
}

function assetMatchesLibraryRole(asset, role) {
  if (!role) return true;
  const tags = assetTagText(asset);
  if (role === "bgm") return isBgmAsset(asset);
  if (role === "editing-material") return isEditingMaterialAsset(asset);
  if (role === "reference-audio") return /参考音频库|声线参考/i.test(tags);
  if (role === "voice-audio") return /语音素材库|口播|TTS/i.test(tags) && !/参考音频库|声线参考/i.test(tags);
  return true;
}

function duplicateAssetByHash(hash, type = "图片", tags = [], accountId = null) {
  if (!hash) return null;
  const role = incomingAssetLibraryRole(tags);
  return state.assets.find(a =>
    a.type === type
    && a.contentHash === hash
    && String(a.accountId || "") === String(accountId || "")
    && assetMatchesLibraryRole(a, role)
  ) || null;
}

function normalizedAssetLibraryName(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function duplicateAssetByName(name, tags = []) {
  const normalizedName = normalizedAssetLibraryName(name);
  if (!normalizedName) return null;
  const role = incomingAssetLibraryRole(tags);
  return state.assets.find(asset =>
    normalizedAssetLibraryName(asset?.name) === normalizedName
    && assetMatchesLibraryRole(asset, role)
  ) || null;
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
  const mime = resolvedAssetBlobMime(blob, a.mime, filename || a.serverFileName || a.name);
  const uploadBlob = normalizeAssetBlobMime(blob, mime, filename || a.serverFileName || a.name);
  a.mime = mime;
  const qs = new URLSearchParams({ filename: fileNameFor(a, filename), mime });
  const res = await fetch(`/api/files/${encodeURIComponent(a.id)}?${qs.toString()}`, {
    method: "PUT",
    headers: {
      "Content-Type": mime,
      "Authorization": "Bearer " + remote.getToken()
    },
    body: uploadBlob
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.fileUrl) throw new Error(data.detail || data.error || `文件上传服务器失败 (${res.status})`);
  a.fileUrl = data.fileUrl;
  a.url = data.fileUrl;
  a.mime = validAssetMime(data.mime) || mime;
  a.size = data.size || uploadBlob.size || a.size || 0;
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
  const remoteUrl = serverFileUrl(a);
  if (remoteUrl && (remote.isOn() || !urlCache.has(a.id))) return versionedServerFileUrl(a, remoteUrl);
  if (urlCache.has(a.id)) return urlCache.get(a.id);
  if (remoteUrl) return versionedServerFileUrl(a, remoteUrl);
  if (a.dataUrl) return a.dataUrl; // 兼容遗留小数据
  return null;
}

/* 新增资产（dataUrl 形式进来 → 转 Blob 落库） */
export async function addAssetFromDataUrl(accountId, { name, type = "图片", tags = [], dataUrl, forceNew = false, processImage = true }) {
  const contentHash = dataUrl ? assetHashFromDataUrl(dataUrl) : "";
  const dup = forceNew ? null : duplicateAssetByHash(contentHash, type, tags, accountId);
  if (dup) return mergeAssetMeta(dup, { accountId, tags, name });
  const a = { id: uid(), accountId, seq: nextSeq(), ownerId: state.ui.currentMemberId || null, name: name || "未命名素材", type, tags, createdAt: Date.now(), hasBlob: !!dataUrl, contentHash };
  if (dataUrl) {
    try {
      const raw = dataUrlToBlob(dataUrl);
      const sourceBlob = normalizeAssetBlobMime(
        raw,
        inferAssetFileMime({ name: name || a.name, type: raw.type }),
        name || a.name
      );
      const blob = type === "图片" && processImage ? await lightlyProcessImageBlob(sourceBlob, name || a.name) : sourceBlob;
      a.mime = resolvedAssetBlobMime(blob, sourceBlob.type, name || a.name);
      await db.putBlob(a.id, blob);
      urlCache.set(a.id, URL.createObjectURL(blob));
      if (blob !== sourceBlob) a.processed = "clarity-filter-v2";
      await uploadServerFile(a, blob, name || a.name);
    } catch (e) {
      if (remote.isOn() && remote.hasToken()) throw e;
      a.dataUrl = dataUrl; a.hasBlob = false;
    }
  }
  state.assets.push(a);
  await persistRecoveredDocuments("assets", a);
  save("meta");
  return a;
}

export async function addAssetFromFile(accountId, file, {
  tags = [],
  name,
  forceNew = false,
  rejectDuplicateName = false,
  libraryLabel = "当前素材库",
  processImage = true,
} = {}) {
  const { mime, type } = inferAssetFileMeta(file);
  const assetName = name || file.name.replace(/\.[^.]+$/, "");
  if (rejectDuplicateName && duplicateAssetByName(assetName, tags)) {
    throw new Error(`“${String(assetName).trim()}”已存在于${String(libraryLabel || "当前素材库")}，请重命名文件后再添加`);
  }
  const sourceBlob = normalizeAssetBlobMime(file, mime, file.name || assetName);
  const blob = type === "图片" && processImage ? await lightlyProcessImageBlob(sourceBlob, file.name || assetName) : sourceBlob;
  const contentHash = await assetHashFromBlob(blob);
  const dup = forceNew ? null : duplicateAssetByHash(contentHash, type, tags, accountId);
  if (dup) return mergeAssetMeta(dup, { accountId, tags, name: assetName });
  const a = {
    id: uid(),
    accountId,
    seq: nextSeq(),
    ownerId: state.ui.currentMemberId || null,
    name: assetName,
    type,
    tags,
    createdAt: Date.now(),
    hasBlob: true,
    mime: resolvedAssetBlobMime(blob, mime, file.name || assetName),
    contentHash
  };
  if (blob !== sourceBlob) {
    a.processed = "clarity-filter-v2";
  }
  await db.putBlob(a.id, blob);
  urlCache.set(a.id, URL.createObjectURL(blob));
  await uploadServerFile(a, blob, file.name);
  state.assets.push(a);
  await persistRecoveredDocuments("assets", a);
  save("meta");
  return a;
}

/* 覆盖资产二进制（如重新回传同槽位） */
export async function replaceAssetBlob(assetId, dataUrl) {
  const a = assetById(assetId); if (!a) return;
  const raw = dataUrlToBlob(dataUrl);
  const sourceBlob = normalizeAssetBlobMime(raw, a.mime, a.serverFileName || a.name);
  const blob = a.type === "图片" ? await lightlyProcessImageBlob(sourceBlob, a.name) : sourceBlob;
  a.mime = resolvedAssetBlobMime(blob, a.mime, a.serverFileName || a.name);
  const contentHash = await assetHashFromBlob(blob);
  await db.putBlob(a.id, blob);
  const old = urlCache.get(a.id);
  if (old) URL.revokeObjectURL(old);
  urlCache.set(a.id, URL.createObjectURL(blob));
  if (blob !== sourceBlob) a.processed = "clarity-filter-v2";
  await uploadServerFile(a, blob, a.name);
  const previousRevision = Number(a.blobUpdatedAt || a.updatedAt || a.createdAt || 0);
  const revisionAt = Math.max(Date.now(), previousRevision + 1);
  a.contentHash = contentHash;
  a.blobUpdatedAt = revisionAt;
  a.updatedAt = revisionAt;
  a.hasBlob = true; delete a.dataUrl;
  await persistRecoveredDocuments("assets", a);
}

export async function removeAsset(id) {
  const a = assetById(id); if (!a) return;
  // 先让服务端在同一事务内完成租户权限与业务引用保护检查。
  // 只有文档删除获准后才清理物理文件，避免“文件 200、文档 403”
  // 留下不可恢复的悬空业务引用。
  const remoteActive = remote.isOn() && remote.hasToken();
  if (remoteActive) await remote.deleteDoc("assets", id);
  if (a.serverFileName && remote.isOn() && remote.hasToken()) {
    const response = await fetch(`/api/files/${encodeURIComponent(a.serverFileName)}`, {
      method: "DELETE",
      headers: { "Authorization": "Bearer " + remote.getToken() }
    });
    if (!response.ok && response.status !== 404) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || data.error || `服务器文件删除失败 (${response.status})`);
    }
  }
  const scrub = value => {
    if (Array.isArray(value)) return value.filter(item => item !== id).map(scrub);
    if (!value || typeof value !== "object") return value === id ? null : value;
    Object.keys(value).forEach(key => {
      if (value[key] === id) value[key] = null;
      else value[key] = scrub(value[key]);
    });
    return value;
  };
  state.accounts.forEach(scrub);
  state.productions.forEach(scrub);
  state.jobs.forEach(scrub);
  state.assets = state.assets.filter(x => x.id !== id);
  await db.delBlob(id);
  const u = urlCache.get(id);
  if (u) { URL.revokeObjectURL(u); urlCache.delete(id); }
  save("assets", "accounts", "productions", "jobs");
}

export async function assetBlob(id, { deliveryId = "", required = false, label = "素材" } = {}) {
  const scopedRemoteRead = Boolean(String(deliveryId || "").trim() && remote.isOn());
  const local = scopedRemoteRead ? null : await db.getBlob(id);
  if (local) return local;
  const a = assetById(id);
  let u = serverFileUrl(a);
  if (!u) {
    if (required) throw new Error(`${label}缺少可下载的媒体地址`);
    return null;
  }
  try {
    if (deliveryId) {
      const scoped = new URL(u, globalThis.location?.origin || "http://local.invalid");
      scoped.searchParams.set("deliveryId", String(deliveryId));
      u = u.startsWith("http://") || u.startsWith("https://")
        ? scoped.href
        : `${scoped.pathname}${scoped.search}${scoped.hash}`;
    }
    const token = remote.getToken();
    const res = await fetch(u, {
      cache: "no-store",
      credentials: "same-origin",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const reason = (typeof body.detail === "string" ? body.detail : body.detail?.message)
        || body.error || `HTTP ${res.status}`;
      if (required) throw new Error(`${label}下载失败：${reason}`);
      return null;
    }
    const fetchedBlob = await res.blob();
    const blob = normalizeAssetBlobMime(
      fetchedBlob,
      a?.mime,
      a?.serverFileName || a?.name || ""
    );
    await db.putBlob(id, blob).catch(() => null);
    if (!urlCache.has(id)) urlCache.set(id, URL.createObjectURL(blob));
    return blob;
  } catch (e) {
    if (required) {
      if (String(e?.message || "").startsWith(`${label}下载失败`)) throw e;
      throw new Error(`${label}下载失败：${e?.message || "网络异常"}`);
    }
    return null;
  }
}

export async function assetU8(id, options = {}) {
  const b = await assetBlob(id, options);
  if (!b) {
    if (options.required) throw new Error(`${options.label || "素材"}下载失败`);
    return null;
  }
  const a = assetById(id);
  const mime = resolvedAssetBlobMime(b, a?.mime, a?.serverFileName || a?.name || "");
  return {
    u8: new Uint8Array(await b.arrayBuffer()),
    ext: extOfMime(mime)
  };
}

/* 缩略 html：没有可视帧时使用统一黑白媒体占位。 */
const TYPE_ICON = { "图片": "▧", "视频": "▶", "音频": "♪", "图集": "▦" };
export function thumbHtml(a, cls = "") {
  const u = urlFor(a);
  if (u && a.type !== "音频") return `<img class="${cls}" src="${u}" alt="" loading="lazy"/>`;
  return `<div class="ph media-placeholder ${cls}" data-kind="${esc(a.type || "素材")}"><span>${TYPE_ICON[a.type] || "·"}</span><em>${esc(a.type || "素材")}</em></div>`;
}

export function searchAssets({ accountId = "all", tag = "all", q = "", includeDelivered = false } = {}) {
  const kw = q.trim().toLowerCase();
  return state.assets.filter(a => {
    if (!a.delivered && !a.shared && !ownedBy(a) && !isGlobalEditingAsset(a)) return false;
    if (!includeDelivered && a.delivered) return false;
    if (accountId !== "all" && a.accountId !== accountId) return false;
    if (tag !== "all" && !(a.tags || []).includes(tag)) return false;
    const acc = a.accountId ? accountById(a.accountId) : null;
    const accountText = [acc?.name, acc?.platform, acc?.subType, acc?.mode].filter(Boolean).join(" ").toLowerCase();
    if (kw && !a.name.toLowerCase().includes(kw) && !accountText.includes(kw) && !(a.tags || []).some(t => t.toLowerCase().includes(kw))) return false;
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
