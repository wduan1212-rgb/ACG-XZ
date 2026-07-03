/* ProviderAdapter：视频/图片生成服务的统一接入面
   接真实 API（即梦 / Seedance / 千帆）= 新增一个实现了 submit/poll/cancel 的对象并注册，
   其余代码（JobRunner / UI）零改动。

   接口约定：
   adapter = {
     id, kind: "video"|"image", label,
     capabilities: { ratios: [], maxDuration, refImages, characterLock },
     async submit(req)  -> { providerRef }            // req: {prompt, refs:[{name,role,blob,url}], ratio, duration, apiKey, endpoint}
     async poll(ref)    -> { status: "running"|"succeeded"|"failed", progress: 0-100, output?, error? }
     async cancel(ref)  -> void
   } */

import { state } from "../core/store.js";
import { ACCOUNT_PROFILE_SEED } from "../data/accountProfilesSeed.js";
import { XHS_ACCOUNT_SEED } from "../data/xhsAccountsSeed.js";

const registry = new Map();
const imageRuns = new Map();
const serverVideo = { checked: false, configured: false, reachable: true, provider: "", model: "", error: "" };
const serverImage = { checked: false, configured: false, reachable: true, provider: "", model: "", mode: "", error: "" };
const serverTts = { checked: false, configured: false, provider: "", model: "", voiceId: "", voices: [], error: "" };
export function registerProvider(adapter) { registry.set(adapter.id, adapter); }
export function getProvider(id) { return registry.get(id) || null; }

function fixedApiOrigin() {
  return "http://127.0.0.1:8787";
}

function sameApiOrigin() {
  try {
    const loc = window.location;
    if (loc && /^https?:$/.test(loc.protocol) && loc.port === "8787") return loc.origin;
  } catch (_) {}
  return fixedApiOrigin();
}

function apiUrl(path) {
  const p = String(path || "");
  if (/^https?:\/\//.test(p)) return p;
  if (p.startsWith("/")) return sameApiOrigin() + p;
  return p;
}

function apiCandidates(path) {
  const p = String(path || "");
  if (!p.startsWith("/") || /^https?:\/\//.test(p)) return [p];
  const out = [p];
  const same = sameApiOrigin() + p;
  const fixed = fixedApiOrigin() + p;
  if (!out.includes(same)) out.push(same);
  if (!out.includes(fixed)) out.push(fixed);
  return out;
}

async function readResponsePayload(res) {
  const raw = await res.text().catch(() => "");
  if (!raw) return { data: null, message: `HTTP ${res.status}` };
  try {
    const data = JSON.parse(raw);
    const detail = data?.detail;
    const message = (detail && typeof detail === "object"
      ? (detail.message || detail.msg || detail.raw || JSON.stringify(detail))
      : detail) || data?.error?.message || data?.message || data?.msg || raw.slice(0, 600);
    return { data, message: String(message || `HTTP ${res.status}`) };
  } catch (_) {
    return { data: null, message: raw.slice(0, 600) || `HTTP ${res.status}` };
  }
}

async function fetchJsonWithTimeout(url, timeoutMs = 3500) {
  let lastError = null;
  for (const candidate of apiCandidates(url)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(candidate, { cache: "no-store", signal: ctrl.signal });
      const payload = await readResponsePayload(res);
      if (!res.ok) throw new Error(payload.message || ("HTTP " + res.status));
      return payload.data || {};
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("API 请求失败");
}

async function postJsonWithFallback(url, body, timeoutMs = 240000) {
  let lastError = null;
  for (const candidate of apiCandidates(url)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(candidate, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      const payload = await readResponsePayload(res);
      if (res.ok) return { data: payload.data || {}, url: candidate };
      lastError = new Error(payload.message || `HTTP ${res.status}`);
      if (![404, 405].includes(res.status)) throw lastError;
    } catch (e) {
      const msg = e?.name === "AbortError"
        ? `API 请求超时：${candidate}`
        : (/failed to fetch/i.test(e?.message || "") ? `无法连接 API：${candidate}。请确认本地 8787 服务已启动、服务端路由可访问。` : (e?.message || String(e)));
      lastError = new Error(msg);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("API 请求失败");
}

export function providerKeyFor(kind, adapter = null) {
  const keys = [...state.apiKeys].reverse().filter(x => x.type === kind && x.secret);
  if (kind === "video" && adapter?.id === "seedance-video" && serverVideo.configured) {
    return keys[0] || { type: "video", name: "服务器 Seedance", provider: "/api/video", secret: "" };
  }
  if (kind === "image" && adapter?.id === "openai-image" && serverImage.configured) {
    return { type: "image", name: "服务器图片模型", provider: "", model: serverImage.model || "custom-imagemodel-gt", secret: "", server: true };
  }
  if (!adapter) return keys[0] || null;
  return keys.find(k => {
    const p = k.provider || "";
    return !p || p.includes(adapter.label) || p.includes(adapter.id) || /^https?:\/\//.test(p);
  }) || keys[0] || null;
}

/* 当前生效的 provider：配置了真实 Key 则优先（未来在此路由），否则 mock */
export function activeProviderFor(kind) {
  const k = providerKeyFor(kind);
  if (kind === "video" && serverVideo.configured && registry.has("seedance-video")) return registry.get("seedance-video");
  if (kind === "image" && serverImage.configured && registry.has("openai-image")) return registry.get("openai-image");
  // 真实 adapter 注册后在这里按 k.provider 匹配；当前阶段统一走 mock
  if (k) {
    const real = [...registry.values()].find(a => a.kind === kind && a.id !== `mock-${kind}` && (
      !(k.provider || "") || (k.provider || "").includes(a.label) || (k.provider || "").includes(a.id) || /^https?:\/\//.test(k.provider || "")
    ));
    if (real) return real;
  }
  return registry.get(`mock-${kind}`);
}

export function videoApiConfigured() {
  return serverVideo.configured || state.apiKeys.some(x => x.type === "video" && x.secret);
}
export function videoApiHealthy() {
  return videoApiConfigured() && serverVideo.reachable !== false;
}
export function imageApiConfigured() {
  return serverImage.configured || state.apiKeys.some(x => x.type === "image" && x.secret);
}

const DEFAULT_MAAS_IMAGE_ENDPOINT = "https://tokenhub.tencentmaas.com/v1/aiart/gtimage";

function normalizeImageEndpoint(provider = "") {
  const p = String(provider || "").trim();
  if (!p) return DEFAULT_MAAS_IMAGE_ENDPOINT;
  const base = p.replace(/\/+$/, "");
  if (/tokenhub\.tencentmaas\.com/i.test(base) || /custom-imagemodel/i.test(base) || /aiart/i.test(base)) {
    if (/\/v1\/images\/generations$/i.test(base)) return base.replace(/\/v1\/images\/generations$/i, "/v1/aiart/gtimage");
    if (/\/images\/generations$/i.test(base)) return base.replace(/\/images\/generations$/i, "/aiart/gtimage");
    if (/\/v1$/i.test(base)) return `${base}/aiart/gtimage`;
    if (/\/aiart\/gtimage$/i.test(base)) return base;
    return `${base}/v1/aiart/gtimage`;
  }
  if (/\/images\/generations$/i.test(base) || /\/aiart\/gtimage$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/images/generations`;
  return `${base}/v1/images/generations`;
}

function dataUrlFromImageResponse(data) {
  const item = data?.data?.[0] || data?.images?.[0] || data?.result?.data?.[0] || {};
  const b64 = item.b64_json || item.b64 || item.base64 || data?.b64_json;
  if (b64) return /^data:image\//.test(b64) ? b64 : `data:image/png;base64,${b64}`;
  return item.url || data?.url || "";
}

export function videoProviderLabel() {
  if (serverVideo.configured && serverVideo.reachable === false) return "Seedance · 上游未连通";
  if (serverVideo.configured) return `Seedance · ${serverVideo.model || "已配置"}`;
  return videoApiConfigured() ? "视频 API 已配置" : "模拟渲染引擎（视频 API 未接入）";
}
export function ttsProviderLabel() {
  if (serverTts.configured && serverTts.reachable === false) return `Minimax · 上游未连通`;
  if (serverTts.configured) return `Minimax · ${serverTts.model || "已配置"}`;
  return ttsApiConfigured() ? "TTS API 已配置" : "TTS API 未接入 · 按字数估时（4.2 字/秒）";
}
export function defaultTtsVoiceId() {
  return serverTts.voiceId || "";
}
export function ttsVoicePresets() {
  return Array.isArray(serverTts.voices) ? serverTts.voices : [];
}

function voiceSeedRows() {
  return [
    ...(Array.isArray(ACCOUNT_PROFILE_SEED) ? ACCOUNT_PROFILE_SEED : []),
    ...(Array.isArray(XHS_ACCOUNT_SEED) ? XHS_ACCOUNT_SEED : [])
  ];
}

export function findKnownTtsVoice(voiceId = "") {
  const id = String(voiceId || "").trim();
  if (!id) return null;
  const exactPreset = ttsVoicePresets().find(v => v.voiceId === id);
  const presetMatches = ttsVoicePresets()
    .filter(v => v.voiceId !== id && (String(v.voiceId || "").includes(id) || String(v.name || "").includes(id)))
    .slice(0, 8);
  const accountRows = (state.accounts || [])
    .filter(a => a.voiceId === id)
    .map(a => ({ name: a.voiceName || id, account: a.name, source: "当前账号" }));
  const seedRows = voiceSeedRows()
    .filter(a => a.voiceId === id)
    .map(a => ({ name: a.voiceName || id, account: a.name, source: a.seedCode || "账号画像" }));
  const first = exactPreset
    ? { name: exactPreset.name || id, source: "系统预设" }
    : (accountRows[0] || seedRows[0] || null);
  return {
    voiceId: id,
    name: first?.name || "",
    source: first?.source || "",
    known: !!first,
    preset: exactPreset || null,
    presetMatches,
    accounts: [...accountRows, ...seedRows]
  };
}

export async function lookupTtsVoice(voiceId = "", { test = true } = {}) {
  const id = String(voiceId || "").trim();
  if (!id) throw new Error("请先填写声线 ID");
  const local = findKnownTtsVoice(id);
  const result = {
    voiceId: id,
    name: local?.name || "",
    source: local?.source || "",
    known: !!local?.known,
    accounts: local?.accounts || [],
    presetMatches: local?.presetMatches || [],
    configured: !!serverTts.configured,
    valid: null,
    detail: ""
  };
  if (!serverTts.configured || !test) return result;
  let res;
  try {
    res = await fetch(`/api/tts/voice/lookup?voiceId=${encodeURIComponent(id)}&test=${test ? "true" : "false"}`, {
      cache: "no-store"
    });
  } catch (e) {
    result.detail = "连不上本地服务端 /api/tts/voice/lookup：" + (e.message || e);
    return result;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || `声线查询失败 (${res.status})`);
  result.name = result.name || data.name || "";
  result.known = result.known || !!data.known;
  result.configured = !!data.configured;
  result.valid = data.valid;
  result.detail = data.detail || "";
  result.durationMs = data.durationMs || 0;
  return result;
}

export async function refreshProviderStatus() {
  const load = async (url, target, unavailable) => {
    try {
      const data = await fetchJsonWithTimeout(url);
      target.checked = true;
      target.configured = !!data.configured;
      if ("reachable" in data) target.reachable = data.reachable !== false;
      target.provider = data.provider || "";
      target.model = data.model || "";
      target.mode = data.mode || target.mode || "";
      target.voiceId = data.voiceId || target.voiceId || "";
      target.voices = Array.isArray(data.voices) ? data.voices : target.voices || [];
      target.error = data.detail || "";
    } catch (e) {
      target.checked = true;
      target.configured = false;
      target.reachable = false;
      target.error = (e && e.name === "AbortError") ? unavailable + " timeout" : (e.message || String(e));
    }
  };
  await Promise.all([
    load("/api/video/config", serverVideo, "video config unavailable"),
    load("/api/image/config", serverImage, "image config unavailable"),
    load("/api/tts/config", serverTts, "tts config unavailable")
  ]);
  return { video: { ...serverVideo }, image: { ...serverImage }, tts: { ...serverTts } };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error("参考图读取失败"));
    fr.readAsDataURL(blob);
  });
}

async function refPayload(ref) {
  const dataUrl = ref.blob ? await blobToDataUrl(ref.blob) : (/^data:/.test(ref.url || "") ? ref.url : "");
  const rawUrl = ref.url || "";
  const publicUrl = /^https?:\/\//.test(rawUrl)
    ? rawUrl
    : (rawUrl.startsWith("/") ? apiUrl(rawUrl) : "");
  return {
    id: ref.id,
    name: ref.name,
    type: ref.type,
    mime: ref.mime || ref.blob?.type || "",
    tags: ref.tags || [],
    url: publicUrl,
    dataUrl: publicUrl ? "" : dataUrl
  };
}

/* ---------- Mock 视频 Provider：模拟真实异步生成的全部状态 ---------- */
const mockRuns = new Map(); // ref -> {startedAt, duration, willFail}

function hashOf(str) {
  return [...String(str)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
}

registerProvider({
  id: "mock-video",
  kind: "video",
  label: "模拟视频引擎",
  mock: true,
  capabilities: { ratios: ["9:16", "16:9"], maxDuration: 15, refImages: true, characterLock: true },
  async submit(req) {
    const ref = "mv_" + Math.random().toString(36).slice(2, 10);
    const h = hashOf(req.prompt || ref);
    mockRuns.set(ref, {
      startedAt: Date.now(),
      duration: 6000 + (h % 7000),               // 6-13s 模拟渲染
      clipDuration: req.duration || 15,
      willFail: (h % 100) < 8 && (req.attempt || 0) === 0  // 首次约 8% 失败率，重试必成功
    });
    return { providerRef: ref };
  },
  async poll(ref) {
    const run = mockRuns.get(ref);
    if (!run) return { status: "failed", progress: 0, error: "任务不存在（页面曾刷新），请重试" };
    const elapsed = Date.now() - run.startedAt;
    const progress = Math.min(100, Math.round(elapsed / run.duration * 100));
    if (progress >= 100) {
      mockRuns.delete(ref);
      if (run.willFail) return { status: "failed", progress: 92, error: "模拟引擎随机失败（演示重试链路）" };
      return { status: "succeeded", progress: 100, output: { kind: "mock", label: `${run.clipDuration || 15}s 片段已生成（模拟）` } };
    }
    return { status: "running", progress };
  },
  async cancel(ref) { mockRuns.delete(ref); }
});

/* ---------- Seedance 视频 Provider：浏览器 → 同源服务端代理 → Seedance ----------
   API key 只放在服务器 SEEDANCE_API_KEY / .env.local，前端永不直连远端。 */
registerProvider({
  id: "seedance-video",
  kind: "video",
  label: "Seedance",
  capabilities: { ratios: ["9:16", "16:9"], maxDuration: 15, refImages: true, characterLock: true },
  async submit({ prompt, refs, ratio, duration, generateAudio }) {
    const cleanRefs = [];
    for (const ref of refs || []) {
      if (cleanRefs.length >= 9) break;
      const isImage = !ref.type || ref.type === "图片" || /^image\//.test(ref.mime || ref.blob?.type || "");
      const isAudio = ref.type === "音频" || /^audio\//.test(ref.mime || ref.blob?.type || "");
      if (!isImage && !isAudio) continue;
      const item = await refPayload(ref);
      if (item.url || item.dataUrl) cleanRefs.push(item);
    }
    let res;
    try {
      res = await fetch("/api/video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, refs: cleanRefs, ratio, duration: duration || 15, generateAudio })
      });
    } catch (e) {
      throw new Error("连不上本地服务端 /api/video/submit —— 请确认用 start-shared.command（python 服务端）打开、且改完后已重启它（" + (e.message || e) + "）");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.providerRef) throw new Error(data.detail || data.error || `Seedance 提交失败 (${res.status})`);
    return { providerRef: data.providerRef };
  },
  async poll(ref) {
    const res = await fetch(`/api/video/poll/${encodeURIComponent(ref)}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || data.error || `Seedance 轮询失败 (${res.status})`);
    return {
      status: data.status || "running",
      progress: data.progress ?? (data.status === "succeeded" ? 100 : 50),
      output: data.output || null,
      error: data.error || null
    };
  },
  async cancel(ref) {
    await fetch(`/api/video/cancel/${encodeURIComponent(ref)}`, { method: "POST" }).catch(() => null);
  }
});

/* ---------- Mock 图片 Provider：仅在没有真实图片 Key / API 不可用时兜底 ---------- */
registerProvider({
  id: "mock-image",
  kind: "image",
  label: "模拟图片引擎",
  mock: true,
  capabilities: { ratios: ["3:4", "9:16", "1:1"], refImages: true },
  async submit(req) {
    const ref = "mi_" + Math.random().toString(36).slice(2, 10);
    mockRuns.set(ref, { startedAt: Date.now(), duration: 1500 + Math.random() * 1500, willFail: false });
    return { providerRef: ref };
  },
  async poll(ref) {
    const run = mockRuns.get(ref);
    if (!run) return { status: "failed", progress: 0, error: "任务不存在" };
    const elapsed = Date.now() - run.startedAt;
    if (elapsed >= run.duration) { mockRuns.delete(ref); return { status: "succeeded", progress: 100, output: { kind: "mock" } }; }
    return { status: "running", progress: Math.round(elapsed / run.duration * 100) };
  },
  async cancel(ref) { mockRuns.delete(ref); }
});

/* ---------- OpenAI-compatible 图片 Provider：设置页保存 type=image 的 Key 后启用 ----------
   本地默认走 Tencent MaaS custom-imagemodel-gt；其他兼容服务仍可填写完整 endpoint。 */
registerProvider({
  id: "openai-image",
  kind: "image",
  label: "OpenAI-compatible Image",
  capabilities: { ratios: ["3:4", "9:16", "1:1"], refImages: true },
  async submit({ prompt, refs = [], ratio = "3:4", apiKey, endpoint, model }) {
    const ref = "img_" + Math.random().toString(36).slice(2, 10);
    const useServer = serverImage.configured || endpoint === "/api/image" || !apiKey;
    const body = {
      model: model || serverImage.model || "custom-imagemodel-gt",
      prompt,
      refs: (refs || []).slice(0, 8).map(r => ({
        role: r.role || "shared",
        name: r.name || "",
        mime: r.mime || "",
        url: r.url || "",
        dataUrl: r.dataUrl || ""
      })),
      ratio,
      endpoint: useServer ? "" : endpoint,
      apiKey: useServer ? "" : apiKey
    };
    const { data } = await postJsonWithFallback("/api/image/generate", body);
    const output = data.dataUrl || dataUrlFromImageResponse(data);
    if (!output) throw new Error("图片 API 没有返回图片数据");
    imageRuns.set(ref, { output, ts: Date.now() });
    return { providerRef: ref };
  },
  async poll(ref) {
    const run = imageRuns.get(ref);
    if (!run) return { status: "failed", progress: 0, error: "图片任务结果不存在，请重试" };
    imageRuns.delete(ref);
    return { status: "succeeded", progress: 100, output: { dataUrl: run.output } };
  },
  async cancel(ref) { imageRuns.delete(ref); }
});

/* ---------- Mock TTS Provider：口播稿 → 音频（估时占位，真实 TTS 接入后换 adapter） ---------- */
registerProvider({
  id: "mock-tts",
  kind: "tts",
  label: "模拟配音引擎",
  mock: true,
  capabilities: { voices: ["默认女声", "默认男声"] },
  async submit(req) {
    const ref = "mt_" + Math.random().toString(36).slice(2, 10);
    mockRuns.set(ref, { startedAt: Date.now(), duration: 1200 + Math.random() * 1200, willFail: false, payload: req.payload || null });
    return { providerRef: ref };
  },
  async poll(ref) {
    const run = mockRuns.get(ref);
    if (!run) return { status: "failed", progress: 0, error: "任务不存在" };
    const elapsed = Date.now() - run.startedAt;
    if (elapsed >= run.duration) {
      mockRuns.delete(ref);
      return { status: "succeeded", progress: 100, output: { kind: "mock", ...((run.payload && { perShot: run.payload.perShot, duration: run.payload.duration }) || {}) } };
    }
    return { status: "running", progress: Math.round(elapsed / run.duration * 100) };
  },
  async cancel(ref) { mockRuns.delete(ref); }
});

export function ttsApiConfigured() {
  return (serverTts.configured && serverTts.reachable !== false) || state.apiKeys.some(x => x.type === "tts" && x.secret);
}

export async function synthesizeTts({ text, voiceId, speed = 1, vol = 1, pitch = 0 }) {
  if (!serverTts.configured) throw new Error("服务器未配置 Minimax TTS");
  let res;
  try {
    res = await fetch("/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voiceId, speed, vol, pitch })
    });
  } catch (e) {
    throw new Error("连不上本地服务端 /api/tts/generate —— 请确认用 start-shared.command（python 服务端）打开、且改完后已重启它（" + (e.message || e) + "）");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.detail || data.error || `Minimax TTS 失败 (${res.status})`);
  return data;
}

/* ---------- 真实 Provider 模板（接入时取消注释并填写映射） ----------
registerProvider({
  id: "jimeng-video",
  kind: "video",
  label: "即梦",
  capabilities: { ratios: ["9:16", "16:9"], maxDuration: 15, refImages: true, characterLock: true },
  async submit({ prompt, refs, ratio, duration, apiKey, endpoint }) {
    // 如果远端 API 不能读取浏览器 blob: URL，需要在这里先把 refs[].blob 上传到对象存储/后端，
    // 再把得到的公网 URL 填入 reference_images / first_frame_image。
    const body = {
      prompt, aspect_ratio: ratio, duration,
      reference_images: refs.map(r => r.url),      // 全部参考图
      first_frame_image: refs[0]?.url,             // 首帧
      character_image: refs.find(r => /角色|数字人/.test(r.name))?.url
    };
    const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, body: JSON.stringify(body) });
    const d = await res.json();
    return { providerRef: d.task_id };
  },
  async poll(ref) { ... 轮询 task 状态，映射到 {status, progress, output:{url}} ... },
  async cancel(ref) { ... }
});
------------------------------------------------------------------ */
