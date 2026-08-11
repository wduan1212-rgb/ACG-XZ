/* 语言模型客户端：默认浏览器直连（内部调试用），设置页可覆盖 endpoint / key / model。
   Provider 可填绝对地址，或同源相对路径 /api/chat/completions（走服务端代理，免 CORS + 藏 Key）；
   本地直连受 CORS 阻时也可起 proxy.py 并把 Provider 填成 http://localhost:8787/chat */

import * as remote from "../core/remote.js";

export const LLM_CONFIG = {
  endpoint: "https://api.minimaxi.com/v1/chat/completions",
  model: "MiniMax-M3",
  apiKey: "",
  serverManaged: false
};
window.XingzhenConfig = LLM_CONFIG; // 控制台可调试覆盖
window.DumateConfig = LLM_CONFIG; // 兼容旧调试入口

let serverProxyProbe = null;

/* 部署模式：服务器配置了 LLM_API_KEY 时，前端默认走同源代理。
   Authorization 只传平台登录 token；上游真实 Key 始终只在服务器环境变量中。 */
export async function enableServerProxyIfConfigured() {
  const candidates = ["/api/health"];
  try {
    const loc = window.location;
    const localPreview = /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(String(loc?.hostname || ""));
    if (loc?.protocol === "http:" && localPreview && loc.port !== "8787") {
      candidates.push("http://127.0.0.1:8787/api/health");
    }
  } catch (_) {}
  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.llm_configured) continue;
      const origin = /^https?:\/\//.test(url) ? new URL(url).origin : "";
      LLM_CONFIG.endpoint = `${origin}/api/chat/completions`;
      LLM_CONFIG.apiKey = "server-managed";
      LLM_CONFIG.serverManaged = true;
      if (data.llm_model) LLM_CONFIG.model = data.llm_model;
      return true;
    } catch {
      // Try the next local backend candidate. This keeps localhost:4173 usable
      // while the shared FastAPI backend runs on 8787.
    }
  }
  return false;
}

async function ensureServerProxyForRequest() {
  if (LLM_CONFIG.apiKey || LLM_CONFIG.serverManaged) return !!LLM_CONFIG.apiKey;
  // 子应用可能晚于主应用加载，且旧的版本化模块会拥有独立的 ESM 状态。
  // 在真正报“未配置”前自行探测一次同源服务，避免初始化顺序造成假失败。
  if (!serverProxyProbe) {
    serverProxyProbe = enableServerProxyIfConfigured().finally(() => {
      serverProxyProbe = null;
    });
  }
  await serverProxyProbe;
  return !!LLM_CONFIG.apiKey;
}

/* 设置页保存的语言类 Key 覆盖默认配置 */
export function applyKeyOverrides(apiKeys) {
  // 生产环境探测到服务端托管配置后，以服务端为唯一语言模型入口。
  // 否则浏览器里遗留的旧 key/provider 会把已经接通的同源代理重新覆盖掉，
  // 表现为部分生成流程突然回退本地模板。
  if (LLM_CONFIG.serverManaged) return false;
  const k = [...(apiKeys || [])].reverse().find(x => x.type === "language" && x.secret);
  if (k) {
    LLM_CONFIG.apiKey = k.secret;
    LLM_CONFIG.serverManaged = false;
    if (/^https?:\/\//.test(k.provider || "") || (k.provider || "").startsWith("/")) LLM_CONFIG.endpoint = k.provider;
    if (k.model) LLM_CONFIG.model = k.model;
    return true;
  }
  return false;
}

function cleanModelText(text = "") {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*思考[:：][\s\S]*?(?=\n\s*(?:答复|回答|输出|正文)[:：]|\s*$)/, "")
    .replace(/^\s*(?:答复|回答|输出|正文)[:：]\s*/, "")
    .trim();
}

const TRANSIENT_LLM_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
// The deployed proxy can spend up to two 120s provider attempts plus its
// bounded retry delay. A caller-provided 45/90s UI budget must not abort that
// same request while the server is still legitimately working.
export const SERVER_MANAGED_LLM_TIMEOUT_MS = 270000;

export function effectiveLlmTimeoutMs(serverManaged, timeoutMs = 45000) {
  const requested = Math.max(1000, Number(timeoutMs) || 45000);
  return serverManaged ? Math.max(requested, SERVER_MANAGED_LLM_TIMEOUT_MS) : requested;
}

function jsonModelTextIsValid(text = "") {
  let source = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) source = source.slice(start, end + 1);
  try {
    const value = JSON.parse(source);
    return !!value && typeof value === "object" && !Array.isArray(value);
  } catch (_) {
    return false;
  }
}

function jsonRepairWasRejected(text = "") {
  let source = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) source = source.slice(start, end + 1);
  try {
    return JSON.parse(source)?.__json_repair_failed__ === true;
  } catch (_) {
    return false;
  }
}

function buildJsonRepairMessages(originalMessages = [], invalidText = "") {
  const contract = (originalMessages || [])
    .filter(message => ["system", "user"].includes(String(message?.role || "")))
    .map(message => `${message.role}: ${String(message?.content || "")}`)
    .join("\n\n")
    .slice(-12000);
  return [
    {
      role: "system",
      content: "你是严格 JSON 格式修复器。只允许修复代码围栏、引号、转义、逗号和括号等 JSON 语法；必须保持原输出的字段名、字段值、数组元素、数量和顺序不变。不得新增、删除、改写或猜测任何业务内容。若原输出不完整到无法只靠格式修复，输出 {\"__json_repair_failed__\":true}。只输出一个严格 JSON 对象。"
    },
    {
      role: "user",
      content: `原请求约束仅用于核对结构，禁止据此补写内容：\n${contract}\n\n待修复原始输出：\n${String(invalidText || "").slice(0, 24000)}`
    }
  ];
}

function jsonRepairPreservesSourceContent(originalText = "", repairedText = "") {
  const original = String(originalText || "");
  let repairedSource = String(repairedText || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = repairedSource.indexOf("{");
  const end = repairedSource.lastIndexOf("}");
  if (start >= 0 && end > start) repairedSource = repairedSource.slice(start, end + 1);
  let repaired;
  try {
    repaired = JSON.parse(repairedSource);
  } catch (_) {
    return false;
  }
  const originalKeys = [...original.matchAll(/(?:["']([^"']+)["']|([A-Za-z_][\w-]*))\s*:/g)]
    .map(match => match[1] || match[2])
    .filter(Boolean);
  const repairedKeys = [...repairedSource.matchAll(/"([^"\\]+)"\s*:/g)].map(match => match[1]);
  const keyCounts = values => values.reduce((counts, value) => counts.set(value, (counts.get(value) || 0) + 1), new Map());
  const sourceKeyCounts = keyCounts(originalKeys);
  const repairedKeyCounts = keyCounts(repairedKeys);
  for (const [key, count] of sourceKeyCounts) {
    if (repairedKeyCounts.get(key) !== count) return false;
  }
  for (const [key, count] of repairedKeyCounts) {
    if (sourceKeyCounts.get(key) !== count) return false;
  }
  const scalars = [];
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value && typeof value === "object") return Object.values(value).forEach(visit);
    if (value !== null && value !== undefined) scalars.push(value);
  };
  visit(repaired);
  return scalars.every(value => {
    if (typeof value === "string") {
      const escaped = JSON.stringify(value).slice(1, -1);
      return original.includes(value) || original.includes(escaped);
    }
    return original.includes(String(value));
  });
}

function retryDelayMs(response = null) {
  const retryAfter = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(1600, retryAfter * 1000);
  return 320;
}

export async function llm(messages, { json = false, temperature = 0.7, signal, timeoutMs = 45000, thinking = "", maxTokens = 0 } = {}) {
  await ensureServerProxyForRequest();
  if (!LLM_CONFIG.apiKey) throw new Error("未配置语言模型 Key");
  const ep = LLM_CONFIG.endpoint || "";
  // In deployed mode the server owns model, thinking, and output limits.
  // Keeping these client-side settings out of the request prevents an old
  // browser bundle from silently overriding the server's production policy.
  const serverManaged = LLM_CONFIG.serverManaged || /(?:^|\/)api\/chat\/completions(?:\?|$)/.test(ep);
  // MiniMax 的 chatcompletion 不支持 OpenAI 的 response_format，发了会直接参数报错；靠提示词约束 JSON 输出即可
  const supportsJsonFormat = !/minimax/i.test(ep);
  const body = { model: LLM_CONFIG.model, temperature, messages };
  if (json && supportsJsonFormat) body.response_format = { type: "json_object" };
  if (!serverManaged && ["adaptive", "enabled", "disabled"].includes(thinking)) {
    body.thinking = { type: thinking === "enabled" ? "adaptive" : thinking };
  }
  if (!serverManaged && Number(maxTokens) > 0) body.max_tokens = Number(maxTokens);
  const authKey = serverManaged ? remote.getToken() : LLM_CONFIG.apiKey;
  if (!serverManaged && !authKey) throw new Error("未配置语言模型 Key");
  const headers = { "Content-Type": "application/json" };
  if (authKey) headers.Authorization = "Bearer " + authKey;
  let lastError = null;
  let jsonRepairSource = "";
  const requestTimeoutMs = effectiveLlmTimeoutMs(serverManaged, timeoutMs);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = signal ? null : new AbortController();
    const timer = ctrl ? setTimeout(() => ctrl.abort(), requestTimeoutMs) : null;
    let res = null;
    try {
      res = await fetch(ep, {
        method: "POST",
        signal: signal || ctrl.signal,
        headers,
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 220);
        const error = new Error("HTTP " + res.status + "：" + detail);
        // 同源代理已经在服务端重试临时上游错误；浏览器不再叠加提交。
        const permanentLimit = /余额|额度|insufficient|quota|credit/i.test(detail);
        const canRetryHttp = !serverManaged && !permanentLimit && TRANSIENT_LLM_STATUS.has(res.status) && attempt === 0;
        if (!canRetryHttp) throw error;
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, retryDelayMs(res)));
        continue;
      }
      const d = await res.json();
      // MiniMax / 部分国产模型：HTTP 200 但错误码藏在 base_resp 里（被吞掉就表现为"一直失败"，这里显式抛出真实原因）
      if (d.base_resp && Number(d.base_resp.status_code) !== 0) {
        const providerMessage = String(d.base_resp.status_msg || "调用失败");
        const providerError = new Error(`模型返回错误 ${d.base_resp.status_code}：${providerMessage}`);
        const transientProviderError = /繁忙|稍后|限流|频率|timeout|timed out|rate limit|too many/i.test(providerMessage)
          && !/余额|额度|insufficient|quota|credit/i.test(providerMessage);
        if (attempt === 0 && transientProviderError) {
          lastError = providerError;
          await new Promise(resolve => setTimeout(resolve, 320));
          continue;
        }
        throw providerError;
      }
      const content = cleanModelText(d.choices?.[0]?.message?.content);
      if (content == null || content === "") {
        lastError = new Error("模型无有效返回：" + JSON.stringify(d).slice(0, 200));
        if (attempt === 0) {
          await new Promise(resolve => setTimeout(resolve, 240));
          continue;
        }
        throw lastError;
      }
      if (json && !jsonModelTextIsValid(content)) {
        lastError = new SyntaxError("模型返回了无法解析的 JSON");
        if (attempt === 0) {
          // A second identical creative request tends to reproduce the same
          // formatting drift under concurrent boards. Keep the first answer
          // in this request scope and spend the single retry on syntax-only
          // repair. Domain validation still owns fields, counts and meaning.
          jsonRepairSource = content;
          body.messages = buildJsonRepairMessages(messages, content);
          body.temperature = 0;
          await new Promise(resolve => setTimeout(resolve, 240));
          continue;
        }
        throw new SyntaxError("模型 JSON 经一次格式修复后仍无法解析");
      }
      if (json && jsonRepairWasRejected(content)) {
        throw new SyntaxError("模型输出不完整，无法在不补写业务内容的前提下修复 JSON");
      }
      if (json && jsonRepairSource && !jsonRepairPreservesSourceContent(jsonRepairSource, content)) {
        throw new SyntaxError("模型 JSON 修复结果改写了业务内容，已拒绝继续生成");
      }
      return content;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(serverManaged
          ? "语言模型服务仍在处理，当前结果待确认；请勿重复提交"
          : `语言模型请求超时（${Math.round(requestTimeoutMs / 1000)} 秒）`);
        timeoutError.code = serverManaged ? "LLM_RESULT_UNKNOWN" : "LLM_TIMEOUT";
        timeoutError.outcomeUnknown = serverManaged;
        throw timeoutError;
      }
      lastError = error;
      const retryableClientFailure = !serverManaged && !signal && attempt === 0
        && (!res || (res.ok && error instanceof SyntaxError));
      if (retryableClientFailure) {
        await new Promise(resolve => setTimeout(resolve, 320));
        continue;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || new Error("语言模型调用失败");
}

export async function visionCopy(imageDataUrl, accountStyle = "", { timeoutMs = 90000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("/api/llm/vision-copy", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(remote.getToken() ? { Authorization: `Bearer ${remote.getToken()}` } : {})
      },
      body: JSON.stringify({ imageDataUrl, accountStyle })
    });
    if (!res.ok) throw new Error("HTTP " + res.status + "：" + (await res.text()).slice(0, 240));
    const data = await res.json();
    if (!data?.content) throw new Error("视觉模型没有返回文案");
    return cleanModelText(data.content);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("视觉文案生成超时，请重试");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
