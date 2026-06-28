/* 零依赖静态服务器：node tools/serve.mjs [port]（ES Modules 需要 http 环境，file:// 打不开） */
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import dns from "node:dns/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = normalize(join(fileURLToPath(import.meta.url), "..", ".."));
loadEnvLocal();

const PORT = Number(process.env.PORT || process.argv[2] || 8787);
const JSON_LIMIT = Number(process.env.JSON_LIMIT || 80 * 1024 * 1024);
const SEEDANCE_API_KEY = process.env.SEEDANCE_API_KEY || process.env.SEEDANCE_KEY || "";
const SEEDANCE_BASE_URL = (process.env.SEEDANCE_BASE_URL || process.env.LLMONE_BASE_URL || "https://api.llmone.ai").replace(/\/+$/, "");
const SEEDANCE_MODEL = process.env.SEEDANCE_MODEL || "doubao-seedance-2-0-fast-260128";
const SEEDANCE_RESOLUTION = process.env.SEEDANCE_RESOLUTION || "720p";
const SEEDANCE_GENERATE_AUDIO = /^(1|true|yes)$/i.test(process.env.SEEDANCE_GENERATE_AUDIO || "");
const SEEDANCE_WATERMARK = /^(1|true|yes)$/i.test(process.env.SEEDANCE_WATERMARK || "");
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || "";
const MINIMAX_BASE_URL = (process.env.MINIMAX_BASE_URL || "https://api.minimax.io").replace(/\/+$/, "");
const MINIMAX_TTS_MODEL = process.env.MINIMAX_TTS_MODEL || "speech-2.8-hd";
const MINIMAX_VOICE_ID = process.env.MINIMAX_VOICE_ID || "Chinese (Mandarin)_News_Anchor";
const MINIMAX_VOICE_PRESETS = parseVoicePresets(process.env.MINIMAX_VOICE_PRESETS || "");
const refStore = new Map();
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8"
};

function loadEnvLocal() {
  for (const name of [".env.local", ".env"]) {
    try {
      const raw = readFileSync(join(ROOT, name), "utf8");
      raw.split(/\r?\n/).forEach(line => {
        const s = line.trim();
        if (!s || s.startsWith("#") || !s.includes("=")) return;
        const [key, ...rest] = s.split("=");
        if (!key || process.env[key]) return;
        let value = rest.join("=").trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        process.env[key.trim()] = value;
      });
    } catch (e) { /* optional */ }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > JSON_LIMIT) reject(new Error("请求体过大：参考图请压缩后再试"));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function hashNum(text) {
  return Number.parseInt(crypto.createHash("sha1").update(String(text || "")).digest("hex").slice(0, 10), 16);
}

function noteId(url) {
  const s = String(url || "");
  for (const mark of ["/explore/", "/discovery/item/", "/item/"]) {
    if (s.includes(mark)) return s.split(mark)[1].split("?")[0].split("/")[0] || "note_unknown";
  }
  return "note_" + crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function readableError(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return value.message || value.msg || value.status_msg || value.detail || JSON.stringify(value).slice(0, 800);
  }
  return String(value);
}

function normalizeProviderError(text) {
  const s = String(text || "");
  if (!s) return "";
  if (/InputImageSensitiveContent/i.test(s)) return "参考图未通过 Seedance 图片安全检测。请换一张更清晰、无敏感元素的参考图，或先移除参考图后重试。";
  if (/model_not_found/i.test(s)) return s.replace(/^.*?message["']?\s*:\s*["']?/, "");
  return s;
}

function statusOf(data) {
  const s = String(data?.status || data?.data?.status || data?.data?.data?.task_status || data?.data?.data?.taskStatus || "").toLowerCase();
  if (["succeeded", "completed", "success", "done", "succeed", "success"].includes(s)) return "succeeded";
  if (["failed", "fail", "failure", "error", "expired"].includes(s)) return "failed";
  return "running";
}

function progressOf(data, status) {
  if (status === "succeeded") return 100;
  if (status === "failed") return 0;
  const raw = data?.progress || data?.data?.progress || data?.data?.data?.progress;
  const n = Number(String(raw || "").replace("%", ""));
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(99, Math.round(n))) : 55;
}

function errorOf(data) {
  const direct = readableError(data?.error) || readableError(data?.detail) || readableError(data?.message);
  const d1 = data?.data && typeof data.data === "object" ? data.data : {};
  const d2 = d1?.data && typeof d1.data === "object" ? d1.data : {};
  const nested = readableError(d1.error) || readableError(d1.fail_reason) || readableError(d1.message) ||
    readableError(d2.error) || readableError(d2.fail_reason) || readableError(d2.task_status_msg) || readableError(d2.message);
  return normalizeProviderError(direct || nested || "Seedance 生成失败");
}

function deepFindUrl(obj) {
  if (!obj) return "";
  if (typeof obj === "string") return /^https?:\/\//.test(obj) ? obj : "";
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFindUrl(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof obj === "object") {
    for (const key of ["video_url", "videoUrl", "result_url", "url"]) {
      const v = obj[key];
      if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
    }
    for (const value of Object.values(obj)) {
      const found = deepFindUrl(value);
      if (found) return found;
    }
  }
  return "";
}

function refUrl(ref) {
  const src = ref?.dataUrl || ref?.url || "";
  if (!src || /^blob:/.test(src)) return "";
  if (/^data:/.test(src) && PUBLIC_BASE_URL) {
    const m = src.match(/^data:([^;,]+);base64,(.+)$/);
    if (!m) return src;
    const id = crypto.randomUUID();
    refStore.set(id, { mime: m[1], data: Buffer.from(m[2], "base64"), at: Date.now() });
    return `${PUBLIC_BASE_URL}/api/video/ref/${id}`;
  }
  return src;
}

function refRole(ref, index) {
  const tags = Array.isArray(ref?.tags) ? ref.tags.join(" ") : "";
  const text = `${ref?.name || ""} ${tags}`;
  if (/last|尾帧|末帧/.test(text)) return "last_frame";
  if (/first|首帧/.test(text)) return "first_frame";
  return "reference_image";
}

async function upstreamJson(url, options, label = "Upstream") {
  let r;
  try {
    r = await fetch(url, options);
  } catch (e) {
    let origin = url;
    try { origin = new URL(url).origin; } catch {}
    const cause = e?.cause?.code || e?.cause?.message || e.message || "fetch failed";
    throw new Error(`${label} 网络连接失败：无法连接 ${origin}。请检查服务商 Base URL、代理/DNS 或网络连通性。原始错误：${cause}`);
  }
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = typeof data === "object" ? normalizeProviderError(data.message || readableError(data.error) || readableError(data.detail) || JSON.stringify(data).slice(0, 800)) : normalizeProviderError(text.slice(0, 800));
    throw new Error(`${label} HTTP ${r.status}: ${msg}`);
  }
  return data;
}

function publicBase(url) {
  return url.replace(/^(https?:)\/\/([^/@]+).*$/, "$1//$2/***");
}

function parseVoicePresets(raw) {
  return String(raw || "").split(",").map(item => {
    const [name, ...rest] = item.split(":");
    const voiceId = rest.join(":").trim();
    return name && voiceId ? { name: name.trim(), voiceId } : null;
  }).filter(Boolean);
}

function providerRefOf(data) {
  return data?.id || data?.task_id || data?.taskId || data?.data?.id || data?.data?.task_id || data?.data?.taskId || data?.data?.data?.id || data?.data?.data?.task_id || "";
}

async function resolveBase(url) {
  try {
    const host = new URL(url).hostname;
    await Promise.race([
      dns.lookup(host),
      new Promise((_, reject) => setTimeout(() => reject(new Error("DNS_TIMEOUT")), 900))
    ]);
    return { reachable: true, detail: "" };
  } catch (e) {
    return { reachable: false, detail: e.code || e.message || "DNS_FAILED" };
  }
}

async function handleVideoApi(req, res) {
  if (req.method === "GET" && req.url === "/api/video/config") {
    const base = await resolveBase(SEEDANCE_BASE_URL);
    return sendJson(res, {
      ok: true,
      provider: "seedance",
      configured: !!SEEDANCE_API_KEY,
      reachable: base.reachable,
      detail: base.detail,
      model: SEEDANCE_MODEL,
      baseUrl: publicBase(SEEDANCE_BASE_URL)
    });
  }
  if (req.method === "GET" && req.url?.startsWith("/api/video/ref/")) {
    const id = req.url.split("/").pop();
    const item = refStore.get(id);
    if (!item) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": item.mime, "Cache-Control": "no-store" });
    return res.end(item.data);
  }
  if (!SEEDANCE_API_KEY) return sendJson(res, { ok: false, detail: "服务器未配置 SEEDANCE_API_KEY" }, 500);
  if (req.method === "POST" && req.url === "/api/video/submit") {
    const body = await readBody(req);
    const refs = Array.isArray(body.refs) ? body.refs.slice(0, 9) : [];
    const refHint = refs.length ? `请参考${refs.map((_, i) => `[图${i + 1}]`).join("、")}，并保持主体/界面/构图信息一致。\n` : "";
    const content = [{ type: "text", text: refHint + String(body.prompt || "").trim() }];
    refs.forEach((ref, index) => {
      const url = refUrl(ref);
      if (!url) return;
      content.push({ type: "image_url", image_url: { url }, role: refRole(ref, index) });
    });
    const payload = {
      model: process.env.SEEDANCE_MODEL || body.model || SEEDANCE_MODEL,
      prompt: "",
      metadata: {
        content,
        ratio: body.ratio || "9:16",
        duration: Math.max(4, Math.min(15, Number(body.duration || 15))),
        resolution: body.resolution || SEEDANCE_RESOLUTION,
        watermark: SEEDANCE_WATERMARK,
        generate_audio: body.generateAudio ?? SEEDANCE_GENERATE_AUDIO,
        return_last_frame: true,
        seed: -1
      }
    };
    const data = await upstreamJson(`${SEEDANCE_BASE_URL}/v1/video/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        "Authorization": `Bearer ${SEEDANCE_API_KEY}`
      },
      body: JSON.stringify(payload)
    }, "Seedance");
    const providerRef = providerRefOf(data);
    if (!providerRef) return sendJson(res, { ok: false, detail: "Seedance 已返回结果，但没有任务 ID；请检查模型/接口返回结构。", raw: data }, 502);
    return sendJson(res, { ok: true, providerRef, raw: data });
  }
  if (req.method === "GET" && req.url?.startsWith("/api/video/poll/")) {
    const id = decodeURIComponent(req.url.split("/").pop());
    const data = await upstreamJson(`${SEEDANCE_BASE_URL}/v1/video/generations/${encodeURIComponent(id)}`, {
      headers: { "Accept": "application/json", "Accept-Encoding": "identity", "Authorization": `Bearer ${SEEDANCE_API_KEY}` }
    }, "Seedance");
    const status = statusOf(data);
    const videoUrl = deepFindUrl(data);
    return sendJson(res, {
      ok: true,
      status,
      progress: progressOf(data, status),
      output: videoUrl ? { url: videoUrl, label: "Seedance 片段已生成" } : null,
      error: status === "failed" ? errorOf(data) : null,
      raw: data
    });
  }
  if (req.method === "POST" && req.url?.startsWith("/api/video/cancel/")) {
    const id = decodeURIComponent(req.url.split("/").pop());
    await fetch(`${SEEDANCE_BASE_URL}/v1/video/generations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${SEEDANCE_API_KEY}` }
    }).catch(() => null);
    return sendJson(res, { ok: true });
  }
  return false;
}

function audioDataUrlFromMiniMax(data) {
  const audio = data?.data?.audio || data?.audio || "";
  if (!audio) return "";
  const mime = `audio/${data?.extra_info?.audio_format || "mp3"}`;
  if (/^data:audio\//.test(audio)) return audio;
  if (/^[0-9a-f]+$/i.test(audio)) return `data:${mime};base64,${Buffer.from(audio, "hex").toString("base64")}`;
  return `data:${mime};base64,${audio}`;
}

async function handleTtsApi(req, res) {
  if (req.method === "GET" && req.url === "/api/tts/config") {
    return sendJson(res, {
      ok: true,
      provider: "minimax",
      configured: !!MINIMAX_API_KEY,
      model: MINIMAX_TTS_MODEL,
      voiceId: MINIMAX_VOICE_ID,
      voices: MINIMAX_VOICE_PRESETS,
      baseUrl: publicBase(MINIMAX_BASE_URL)
    });
  }
  if (!MINIMAX_API_KEY) return sendJson(res, { ok: false, detail: "服务器未配置 MINIMAX_API_KEY" }, 500);
  if (req.method === "POST" && req.url === "/api/tts/generate") {
    const body = await readBody(req);
    const text = String(body.text || "").trim();
    if (!text) return sendJson(res, { ok: false, detail: "口播文本为空" }, 400);
    const voiceId = String(body.voiceId || MINIMAX_VOICE_ID || "").trim();
    if (!voiceId) return sendJson(res, { ok: false, detail: "请填写 Minimax voice_id" }, 400);
    const payload = {
      model: body.model || MINIMAX_TTS_MODEL,
      text: text.slice(0, 9999),
      stream: false,
      language_boost: body.languageBoost || "auto",
      output_format: "hex",
      voice_setting: {
        voice_id: voiceId,
        speed: Number(body.speed || 1),
        vol: Number(body.vol || 1),
        pitch: Number(body.pitch || 0)
      },
      audio_setting: {
        sample_rate: Number(body.sampleRate || 32000),
        bitrate: Number(body.bitrate || 128000),
        format: body.format || "mp3",
        channel: Number(body.channel || 1)
      }
    };
    const data = await upstreamJson(`${MINIMAX_BASE_URL}/v1/t2a_v2`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${MINIMAX_API_KEY}` },
      body: JSON.stringify(payload)
    }, "Minimax");
    const code = data?.base_resp?.status_code ?? 0;
    if (code !== 0) return sendJson(res, { ok: false, detail: data?.base_resp?.status_msg || "Minimax TTS 生成失败", raw: data }, 502);
    const audioDataUrl = audioDataUrlFromMiniMax(data);
    if (!audioDataUrl) return sendJson(res, { ok: false, detail: "Minimax 已返回结果，但没有 audio 字段", raw: data }, 502);
    const durationMs = Number(data?.extra_info?.audio_length || 0);
    return sendJson(res, {
      ok: true,
      audioDataUrl,
      voiceId,
      model: payload.model,
      durationMs,
      duration: durationMs ? Math.round(durationMs / 100) / 10 : 0,
      traceId: data?.trace_id || ""
    });
  }
  return false;
}

http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/video/")) {
      let handled;
      try { handled = await handleVideoApi(req, res); }
      catch (e) { return sendJson(res, { ok: false, detail: e.message || "Seedance 调用失败" }, 502); }
      if (handled !== false) return;
    }
    if (req.url?.startsWith("/api/tts/")) {
      let handled;
      try { handled = await handleTtsApi(req, res); }
      catch (e) { return sendJson(res, { ok: false, detail: e.message || "Minimax 调用失败" }, 502); }
      if (handled !== false) return;
    }
    if (req.method === "POST" && req.url?.startsWith("/api/analytics/")) {
      const body = await readBody(req);
      if (req.url.startsWith("/api/analytics/resolve")) {
        return sendJson(res, { ok: true, provider: "serve-mock", noteId: noteId(body.url), canonicalUrl: body.url, resolvedAt: Date.now() });
      }
      if (req.url.startsWith("/api/analytics/fetch")) {
        const seed = hashNum(body.url || body.noteId || "");
        const ageH = Math.max(1, (seed % 96) + 1);
        const base = 300 + seed % 1400;
        const views = Math.round(base * (1 + Math.min(9, Math.sqrt(ageH))) + ageH * (seed % 19));
        const likes = Math.round(views * (0.035 + ((seed >> 8) % 55) / 1000));
        const collects = Math.round(views * (0.014 + ((seed >> 13) % 38) / 1000));
        const comments = Math.round(views * (0.004 + ((seed >> 18) % 18) / 1000));
        const shares = Math.round(views * (0.003 + ((seed >> 22) % 12) / 1000));
        const engagementRate = views ? (likes + collects + comments + shares) / views : 0;
        const qualityScore = Math.max(35, Math.min(96, Math.round(engagementRate * 520 + String(views).length * 10)));
        return sendJson(res, {
          provider: "serve-mock",
          noteId: body.noteId || noteId(body.url),
          fetchedAt: Date.now(),
          metrics: { views, likes, collects, comments, shares, engagementRate, qualityScore },
          commentsSample: ["能不能出一个具体步骤版", "标题如果更直接会想点进去", "封面信息少一点可能更清楚"],
          raw: { mock: true, seed }
        });
      }
    }
    let path = decodeURIComponent((req.url || "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const s = await stat(file).catch(() => null);
    const target = s && s.isDirectory() ? join(file, "index.html") : file;
    const data = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch (e) {
    const path = decodeURIComponent((req.url || "/").split("?")[0]);
    if (path.startsWith("/api/")) return sendJson(res, { ok: false, detail: e.message || "本地服务异常" }, 500);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
  }
}).listen(PORT, () => console.log(`Dumate Studio → http://localhost:${PORT}`));
