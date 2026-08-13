/* 基础工具：DOM / 文本 / 文件 / 压缩 / 并发 */

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
export const uid = () => Math.random().toString(36).slice(2, 10);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const GRADS = [
  "linear-gradient(135deg,#3D5BFF,#22B8CF)",
  "linear-gradient(135deg,#7A4DFF,#3D5BFF)",
  "linear-gradient(135deg,#F08C00,#E8590C)",
  "linear-gradient(135deg,#0CA678,#22B8CF)",
  "linear-gradient(135deg,#E64980,#7A4DFF)",
  "linear-gradient(135deg,#1C7ED6,#4263EB)"
];
export const gradFor = (str) => GRADS[[...String(str || "x")].reduce((a, c) => a + c.charCodeAt(0), 0) % GRADS.length];

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* 限并发任务池 */
export async function runPool(items, worker, conc = 2) {
  let i = 0;
  const lane = async () => { while (i < items.length) { const it = items[i++]; await worker(it); } };
  await Promise.all(Array.from({ length: Math.min(conc, Math.max(1, items.length)) }, lane));
}

export const delay = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- 时间 ---------- */
export function todayStamp() {
  const d = new Date(); const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
export function timeAgo(ts) {
  if (!ts) return "";
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  if (s < 86400 * 7) return Math.floor(s / 86400) + " 天前";
  const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`;
}
export const fmtTC = s => { const p = n => String(Math.floor(Math.max(0, n))).padStart(2, "0"); return `${p(s / 60)}:${p(s % 60)}`; };

/* ---------- 文本清洗（移植自 v4） ---------- */
export function stripEmoji(str) {
  return String(str || "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu, "").replace(/[ \t]{2,}/g, " ");
}
export function sanitizeProduct(str) {
  let s = String(str || "");
  s = s.replace(/\bDuMate\b/gi, "百度搭子").replace(/\bDumate\b/gi, "百度搭子");
  s = s.replace(/百度搭子/g, "@@DMZ@@");
  s = s.replace(/(微信|抖音|快手|淘宝|支付宝|百度)\s*(App|APP|app|应用|网盘|智能云|文库|地图|输入法)?\s*(logo|Logo|图标|标志)/g, "产品 logo");
  s = s.replace(/(微信|抖音|快手|淘宝|支付宝|百度)\s*(App|APP|app|应用|主页|首页|界面)/g, "产品界面");
  s = s.replace(/百度\s*(App|APP|app|应用|网盘|智能云|文库|地图|输入法)/g, "产品");
  s = s.replace(/@@DMZ@@/g, "百度搭子");
  return s;
}
export const cleanText = s => sanitizeProduct(stripEmoji(s));

/* 单图创作只继承账号的颜色与画风，不继承布局、人物、文案或内容指令。 */
export function compactSingleImageVisualStyle(source = "") {
  const raw = String(source || "").replace(/\s+/g, " ");
  const colors = [];
  const add = value => { if (value && !colors.includes(value)) colors.push(value); };
  (raw.match(/#[0-9A-Fa-f]{6}\b/g) || []).slice(0, 3).forEach(add);
  const colorTerms = raw.match(/暖白|米白|纯白|黑白|深灰|浅灰|灰蓝|藏蓝|深蓝|浅蓝|天蓝|橙色|橘色|明黄|金色|绿色|青色|紫色|粉色|红色|黑色|白色/g) || [];
  colorTerms.forEach(add);
  const styles = [];
  const styleTerms = [
    "简笔画火柴人", "扁平插画", "手绘插画", "国风插画", "日系插画", "复古插画",
    "摄影写实", "超写实", "赛博朋克", "像素画", "水彩", "油画", "漫画", "卡通",
    "黏土", "2.5D", "3D", "波普", "线稿", "简笔画", "写实"
  ];
  styleTerms.forEach(term => {
    if (raw.includes(term) && !styles.some(value => value.includes(term) || term.includes(value))) styles.push(term);
  });
  const parts = [];
  if (colors.length) parts.push(`${colors.slice(0, 3).join("、")}配色`);
  if (styles.length) parts.push(`${styles.slice(0, 2).join("、")}画风`);
  return parts.length ? `${parts.join("，")}。` : "沿用账号的配色与画风。";
}

export function singleImageGenerationPrompt(content, styleSource = "") {
  const body = String(content || "").trim();
  if (!body) return "";
  return `${body}\n视觉参考：${compactSingleImageVisualStyle(styleSource)}`;
}

/* 去掉口播里的引导式结尾（关注/点赞/三连/下期见…），利他向 */
export function stripCTA(s) {
  let t = String(s || "");
  // 去掉句尾的引导短句
  t = t.replace(/[，,。.！!～~\s]*(记得|别忘了|快|赶紧|一定要|不妨)?\s*(点赞|关注|收藏|转发|分享|三连|一键三连|点个赞|加个关注|右下角|小红心|评论区(扣|留|聊|告诉|见)?|私信我|关注我|关注账号|蹲一下|码住|码一下|下期见|下期不见不散|我们下期再见|记得回来)([^。.！!～~\n]{0,12})?[。.！!～~]?\s*$/g, "");
  return t.trim();
}

export function parseJSONLoose(str) {
  let s = String(str).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

/* ---------- 剪贴板 / 下载 ---------- */
export function copyText(str, doneMsg) {
  const done = () => window.__toast && window.__toast(doneMsg || "已复制到剪贴板");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(str).then(done).catch(() => fallbackCopy(str, done));
  } else fallbackCopy(str, done);
}
function fallbackCopy(str, done) {
  const ta = document.createElement("textarea");
  ta.value = str; ta.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { /* 忽略 */ }
  ta.remove();
}
export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------- 文件读取 ---------- */
export function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
export function dataUrlToBlob(dataUrl) {
  const [meta, b64] = String(dataUrl).split(",");
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || "image/png";
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: mime });
}
export const extOfMime = m => /png/.test(m) ? "png" : /jpe?g/.test(m) ? "jpg" : /webp/.test(m) ? "webp" : /gif/.test(m) ? "gif" : /mp4/.test(m) ? "mp4" : /webm/.test(m) ? "webm" : /audio/.test(m) ? "mp3" : "bin";

/* ---------- zip（store 模式，移植自 v4） ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
export function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export function buildZipBlob(entries, type = "application/zip") { // entries: [{name, u8}]
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  entries.forEach(e => {
    const nm = enc.encode(e.name), crc = crc32(e.u8), sz = e.u8.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 filename flag for Windows unzip tools
    lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true);
    lh.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(lh.buffer), nm, e.u8);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
    ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nm);
    offset += 30 + nm.length + sz;
  });
  const centralSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type });
}
export async function blobToU8(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/* ---------- SRT ---------- */
const srtFmt = sec => { const p = n => String(n).padStart(2, "0"); const ms = String(Math.round((sec % 1) * 1000)).padStart(3, "0"); return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec % 3600 / 60))}:${p(Math.floor(sec % 60))},${ms}`; };
export function buildSRT(subs) {
  const list = (subs || []).filter(x => (x.text || "").trim());
  if (!list.length) return "";
  return list.map((x, i) => `${i + 1}\n${srtFmt(x.start || 0)} --> ${srtFmt(x.end || 0)}\n${cleanCaptionText(x.text)}\n`).join("\n");
}

export function cleanCaptionText(text) {
  return String(text || "")
    .replace(/[，。、；：！？!?.,;:…—"'“”‘’（）()【】《》<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* 字幕智能断句：一句口播拆成每段 ≤maxLen 字的多条，优先在标点处断，超长再硬切，
   避免一屏出现一大段多行字幕。返回纯文本数组。 */
export function splitCaption(text, maxLen = 18) {
  const t = cleanCaptionText(text);
  if (!t) return [];
  if (t.length <= maxLen) return [t];
  // 在标点后断句（标点保留在前段尾）
  const segs = t.split(/\s+/).map(s => s.trim()).filter(Boolean);
  const chunks = [];
  for (let seg of segs) {
    while (seg.length > maxLen) { chunks.push(seg.slice(0, maxLen)); seg = seg.slice(maxLen); }
    if (seg) chunks.push(seg);
  }
  // 贪心合并相邻短块，使每条尽量接近但不超过 maxLen
  const out = [];
  for (const c of chunks) {
    if (out.length && (out[out.length - 1] + c).length <= maxLen) out[out.length - 1] += c;
    else out.push(c);
  }
  // 避免最后一条只剩 1 个字/词，预览和导出字幕都会显得很别扭。
  if (out.length > 1 && out[out.length - 1].length < 2 && out[out.length - 2].length > 3) {
    const tail = out.pop();
    const prev = out.pop();
    out.push(prev.slice(0, -1), prev.slice(-1) + tail);
  }
  return out.length ? out : [t];
}

/* 把一句口播按时间区间 [start,end] 拆成多条字幕（每条 ≤maxLen 字），时长按字数比例分配 */
export function spreadCaption(text, start, end, maxLen = 18) {
  const chunks = splitCaption(text, maxLen);
  const r = v => Math.round(v * 10) / 10;
  if (chunks.length <= 1) return [{ start: r(start), end: r(Math.max(start + 0.5, end)), text: chunks[0] || cleanCaptionText(text) }];
  const total = chunks.reduce((a, c) => a + c.length, 0) || 1;
  const span = Math.max(0.5, end - start);
  let t = start;
  return chunks.map((c, i) => {
    const left = chunks.length - i;
    const maxEnd = end - (left - 1) * 0.2;
    const raw = i === chunks.length - 1 ? Math.max(0.2, end - t) : span * c.length / total;
    const d = Math.max(0.2, Math.min(raw, maxEnd - t));
    const cue = { start: r(t), end: r(i === chunks.length - 1 ? Math.max(t + 0.2, end) : t + d), text: c };
    t += d;
    return cue;
  });
}

/* ---------- 通用拖拽热区 ---------- */
export function wireDropZone(zone, handler, opts = {}) {
  if (!zone) return;
  const listenerOptions = opts.signal ? { signal: opts.signal } : undefined;
  ["dragenter", "dragover"].forEach(ev => zone.addEventListener(ev, e => {
    if (opts.filesOnly && !(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"))) return;
    e.preventDefault(); e.stopPropagation(); zone.classList.add("drag-over");
  }, listenerOptions));
  ["dragleave", "drop"].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation();
    if (ev === "dragleave" && zone.contains(e.relatedTarget)) return;
    zone.classList.remove("drag-over");
  }, listenerOptions));
  zone.addEventListener("drop", e => { if (e.dataTransfer.files.length) handler(e.dataTransfer.files, e); }, listenerOptions);
}
