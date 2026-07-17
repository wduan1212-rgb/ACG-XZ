/* 意图路由：正则快通道（离线可用） + LLM 路由（带上下文，多轮可懂） */

import { llm } from "../api/llm.js?v=20260717-v92-1";
import { parseJSONLoose } from "../core/util.js";

export const INTENTS = ["plan_batch", "run_generation", "approve_all", "deliver_all", "retry_failed", "status_query"];

/* 离线兜底：从指令里抠 主题/标签/范围/风格（自 v4 移植增强） */
/* 中文数字 → 整数（一~九十九 + 阿拉伯数字），用于"选十个/选20个"这类数量解析 */
function zhNum(s) {
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  const d = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === "十") return 10;
  let m;
  if ((m = s.match(/^十([一二三四五六七八九])$/))) return 10 + d[m[1]];
  if ((m = s.match(/^([一二三四五六七八九])十([一二三四五六七八九])?$/))) return d[m[1]] * 10 + (m[2] ? d[m[2]] : 0);
  return d[s] != null ? d[s] : null;
}

function isPureAccountSelectionText(text) {
  const s = text.trim();
  if (/[「"]/.test(s) || /主题|关于|围绕|做一?期|出一?期|发一?条/.test(s)) return false;
  return /^(随机)?(选择|选|挑|找|找出|匹配|帮我选|帮我找|给我挑|给我找|选出|安排|来|创作|做|量产)\s*([0-9两一二三四五六七八九十]+|一些|几个|几|一批|若干)?\s*(个|条|只|家|篇|张|支)?\s*(小红书|视频号)?\s*(账号|号|图文|图文号|图文账号|素材视频|素材号|素材账号|真人号|真人账号|数字人号|数字人账号)/.test(s);
}

function isBatchPlanText(text) {
  const s = text.trim();
  return /(批量|量产|创作|做|出|生成|写|安排|挑|选择|选|找|匹配|给我).{0,36}([0-9两一二三四五六七八九十]+|一些|几个|几|一批|若干)?.{0,16}(图文|笔记|素材视频|素材号|真人|数字人|视频|账号|号)|([0-9两一二三四五六七八九十]+)\s*(篇|张|条|支).{0,12}(图文|笔记|视频|内容)/.test(s);
}

function firstNum(re, text) {
  const m = String(text || "").match(re);
  return m ? zhNum(m[1]) : null;
}

function selectionRange(goal = "") {
  const n = firstNum(/(?:最后|后|倒数|末尾)\s*([0-9]+|[两一二三四五六七八九十]+)\s*(个|只|家)?\s*(账号|号|图文|图文号|图文账号|素材号|真人号|数字人号)?/, goal);
  if (n) return { pickFrom: "end", accountCount: n };
  const first = firstNum(/(?:前|最前|开头|开始)\s*([0-9]+|[两一二三四五六七八九十]+)\s*(个|只|家)?\s*(账号|号|图文|图文号|图文账号|素材号|真人号|数字人号)?/, goal);
  if (first) return { pickFrom: "start", accountCount: first };
  return { pickFrom: "" };
}

export function parseGoalFallback(goal) {
  const group = /图文|笔记|小红书图/.test(goal) ? "图文组"
    : (goal.includes("真人") || goal.includes("数字人")) ? "真人"
    : (goal.includes("素材") || goal.includes("无数字人")) ? "素材" : "all";
  const styleM = goal.match(/[，,。]\s*(偏[^，,。]+|风格[^，,。]+)/);
  // 数量单位避开"一期/三步"，但覆盖图文常见的篇/张、视频的条/支。
  const accountCount = firstNum(/([0-9]+|[两一二三四五六七八九十]+)\s*(个|只|家)?[^，,。；;]{0,18}(账号|号|图文账号|图文号|素材账号|素材号|真人账号|真人号|数字人账号|数字人号)/, goal);
  const perAccountCount = firstNum(/每(?:一个|个|一?个账号|个号|号|个账号|个图文号|个图文账号)[^0-9一二两三四五六七八九十]{0,10}([0-9]+|[两一二三四五六七八九十]+)\s*(条|篇|张|支|个)?/, goal)
    || firstNum(/各(?:自)?(?:做|创作|出|写|生成)?\s*([0-9]+|[两一二三四五六七八九十]+)\s*(条|篇|张|支|个)?/, goal)
    || firstNum(/([0-9]+|[两一二三四五六七八九十]+)\s*(条|篇|张|支)\s*(内容|图文|笔记|视频)/, goal);
  const genericCount = firstNum(/([0-9]+|[两一二三四五六七八九十]+)\s*(个|条|只|家|篇|张|支)\s*(账号|号|图文|笔记|视频|素材|真人|数字人)?/, goal);
  const count = accountCount || genericCount;
  const range = selectionRange(goal);
  const sort = /很久没(发|发布|更新)|长期没(发|发布|更新)|久未(发|发布|更新)|最近没(发|发布|更新)|沉默|低活跃|冷启动/.test(goal) ? "stale" : "";
  // 只在明确给了主题时才取主题（引号 / 主题是X / 关于X / 围绕X / 做一期X）；否则留空 → 每号随机主题。
  // "选择N个图文号" 这类纯选号指令不要把整句当成主题。
  let topic = "";
  const qm = goal.match(/[「"]([^」"]+)[」"]/);
  if (qm) topic = qm[1];
  else { const dm = goal.match(/(?:主题|关于|围绕|做一?期|出一?期|发一?条)\s*[是为：:]?\s*([^，,。、\d]{2,16})/); if (dm) topic = dm[1].trim(); }
  if (isPureAccountSelectionText(goal) && !qm) topic = "";
  return {
    topic: topic.slice(0, 30), tags: [], group, style: styleM ? styleM[1] : "",
    count: range.accountCount || count, accountCount: range.accountCount || accountCount || count || null,
    perAccountCount: Math.max(1, perAccountCount || 1),
    sort, pickFrom: range.pickFrom || ""
  };
}

/* 快通道正则：明确动作不必走模型 */
function fastRoute(text) {
  if (isPureAccountSelectionText(text)) return { intent: "plan_batch", params: parseGoalFallback(text) };
  if (isBatchPlanText(text)) return { intent: "plan_batch", params: parseGoalFallback(text) };
  if (/(开始|继续)?(全部|批量)?生成/.test(text) && !/账号|号|图文|素材|真人|数字人|内容|日报|主题|脚本|方案/.test(text)) return { intent: "run_generation", params: {} };
  if (/(全部|都|所有).{0,6}(通过|过审)/.test(text)) return { intent: "approve_all", params: {} };
  if (/(全部|都|所有).{0,6}(交付|定稿|入库)/.test(text) || /(交付|定稿).{0,4}(全部|所有)/.test(text)) return { intent: "deliver_all", params: {} };
  if (/重试|再试/.test(text) && /失败|错误/.test(text)) return { intent: "retry_failed", params: {} };
  if (/^(状态|进度|怎么样了|到哪了|情况)[?？。!！]*$/.test(text.trim()) || /(现在|当前|批次).{0,6}(状态|进度|情况)/.test(text)) return { intent: "status_query", params: {} };
  return null;
}

export async function routeIntent(text, contextSummary = "") {
  const fast = fastRoute(text);
  if (fast) return fast;
  try {
    const r = await llm([
      { role: "system", content: `你是内容生产工作台的指令路由器。把用户输入归类为一个 intent 并提取参数，只输出 JSON。
可选 intent：
- plan_batch：发起一批内容量产（提到主题/选号/做一期/量产/批量创作等）。params: {"topic":"创作主题","group":"图文组|真人|素材|all","style":"风格策略，可空","count":数字或null}
- run_generation：开始/继续生成已就绪的任务。params:{}
- approve_all：批量通过审核。params:{}
- deliver_all：批量交付/定稿入库。params:{}
- retry_failed：重试失败任务。params:{}
- status_query：询问进度/状态。params:{}
不支持闲聊和建号；无法归入状态/生成/交付/重试时，一律当作 plan_batch 生成量产任务板。
输出格式：{"intent":"...","params":{...}}
当前工作台上下文（供判断指代）：${contextSummary || "无进行中的批次"}` },
      { role: "user", content: text }
    ], { json: true, temperature: 0.1 });
    const d = parseJSONLoose(r);
    if (!INTENTS.includes(d.intent)) throw new Error("未知意图");
    if (d.intent === "plan_batch") {
      d.params = d.params || {};
      d.params.tags = [];
      if (!d.params.topic) d.params = { ...parseGoalFallback(text), ...d.params, topic: parseGoalFallback(text).topic };
    }
    return d;
  } catch (e) {
    // 离线：批量创作只产出任务板，不进入聊天问答。
    if (text.length >= 6 && /做|出|来|生成|写|期|条|批/.test(text)) {
      return { intent: "plan_batch", params: parseGoalFallback(text), offline: true };
    }
    return { intent: "plan_batch", params: parseGoalFallback(text), offline: true };
  }
}
