/* 语言模型客户端：默认浏览器直连（内部调试用），设置页可覆盖 endpoint / key / model。
   Provider 可填绝对地址，或同源相对路径 /api/chat/completions（走服务端代理，免 CORS + 藏 Key）；
   本地直连受 CORS 阻时也可起 proxy.py 并把 Provider 填成 http://localhost:8787/chat */

export const LLM_CONFIG = {
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-chat",
  apiKey: "",
  serverManaged: false
};
window.DumateConfig = LLM_CONFIG; // 控制台可调试覆盖

/* 部署模式：服务器配置了 LLM_API_KEY 时，前端默认走同源代理。
   Authorization 里的占位值会被后端忽略，真实 Key 只在服务器环境变量中。 */
export async function enableServerProxyIfConfigured() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data.llm_configured) return false;
    LLM_CONFIG.endpoint = "/api/chat/completions";
    LLM_CONFIG.apiKey = "server-managed";
    LLM_CONFIG.serverManaged = true;
    if (data.llm_model) LLM_CONFIG.model = data.llm_model;
    return true;
  } catch {
    return false;
  }
}

/* 设置页保存的语言类 Key 覆盖默认配置 */
export function applyKeyOverrides(apiKeys) {
  const k = [...(apiKeys || [])].reverse().find(x => x.type === "language" && x.secret);
  if (k) {
    LLM_CONFIG.apiKey = k.secret;
    LLM_CONFIG.serverManaged = false;
    if (/^https?:\/\//.test(k.provider || "") || (k.provider || "").startsWith("/")) LLM_CONFIG.endpoint = k.provider;
    if (k.model) LLM_CONFIG.model = k.model;
  }
}

export async function llm(messages, { json = false, temperature = 0.7, signal, timeoutMs = 45000 } = {}) {
  if (!LLM_CONFIG.apiKey) throw new Error("未配置语言模型 Key");
  const ep = LLM_CONFIG.endpoint || "";
  // MiniMax 的 chatcompletion 不支持 OpenAI 的 response_format，发了会直接参数报错；靠提示词约束 JSON 输出即可
  const supportsJsonFormat = !/minimax/i.test(ep);
  const body = { model: LLM_CONFIG.model, temperature, messages };
  if (json && supportsJsonFormat) body.response_format = { type: "json_object" };
  const ctrl = signal ? null : new AbortController();
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(ep, {
      method: "POST",
      signal: signal || ctrl.signal,
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LLM_CONFIG.apiKey },
      body: JSON.stringify(body)
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error(`语言模型请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) throw new Error("HTTP " + res.status + "：" + (await res.text()).slice(0, 220));
  const d = await res.json();
  // MiniMax / 部分国产模型：HTTP 200 但错误码藏在 base_resp 里（被吞掉就表现为"一直失败"，这里显式抛出真实原因）
  if (d.base_resp && Number(d.base_resp.status_code) !== 0) {
    throw new Error(`模型返回错误 ${d.base_resp.status_code}：${d.base_resp.status_msg || "调用失败"}`);
  }
  const content = d.choices?.[0]?.message?.content;
  if (content == null || content === "") throw new Error("模型无有效返回：" + JSON.stringify(d).slice(0, 200));
  return content;
}
