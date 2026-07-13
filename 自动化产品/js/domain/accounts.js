/* 账号领域：分组 / 标签 / 命名规则 / 增删改 */

import { state, save, notify, removeRemote } from "../core/store.js";
import { uid, todayStamp, esc } from "../core/util.js";

export const TAG_POOL = ["产品功能", "家庭管理", "职场效率", "创作者", "岗位垂类", "测评中立", "学生教培"];
export const PLATFORM_CODE = { "小红书": "XHS", "视频号": "SPH", "抖音": "DY", "公众号": "GZH" };
export const platformCode = p => PLATFORM_CODE[p] || "XHS";

export const groupOf = a => a.mode === "图文" ? "图文组" : (a.subType === "数字人" ? "真人" : "素材");
export const tagsOf = a => (a.qtags && a.qtags.length) ? a.qtags
  : TAG_POOL.filter(t => ((a.styleProfile || "") + (a.name || "")).includes(t.slice(0, 2)));
export const modeLabel = a => a.mode === "视频" ? (a.subType || "视频") : "图文";
export function normalizeHomepageUrl(value = "") {
  let raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("主页链接格式不正确"); }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) throw new Error("主页链接仅支持 http:// 或 https://");
  return parsed.href;
}
export function appearanceAnchorFor(account = {}) {
  const key = `${account.id || ""}${account.name || ""}`;
  const n = [...key].reduce((a, c) => a + c.charCodeAt(0), 0) % 2;
  return n === 0
    ? "同一位中国年轻职场女性数字人，26-30岁，气质干净专业但有亲和力；鹅蛋脸偏小，下颌线柔和清晰，额头饱满，发际线自然；自然平直眉，眉尾略收，杏眼偏圆，双眼皮自然，眼神专注但不锐利；鼻梁中等偏挺，鼻头圆润不过分尖；嘴唇厚薄适中，微笑时嘴角轻微上扬；肤色自然白皙偏暖，妆容清淡，唇色豆沙或浅玫瑰；黑棕色中长发，锁骨到肩下长度，三七分或自然中分，发尾微内扣；身形中等偏瘦，肩颈舒展，穿浅米色针织衫或白色衬衫，搭配深色简洁下装。"
    : "同一位中国年轻职场男性数字人，27-32岁，气质理性松弛、像懂技术的同事；脸型为偏长的清瘦椭圆脸，下颌线利落但不锋利，额头开阔；眉毛自然偏浓，眼型细长偏内双，眼神稳定专注；鼻梁中等偏高，鼻翼自然；嘴唇偏薄，讲话时表情克制，有轻微吐槽感和理性幽默；肤色自然偏暖，皮肤质感真实不过度磨皮；黑色短发，侧分或自然蓬松，发际线自然；身形中等偏瘦，肩背挺直，穿浅蓝或白色衬衫、深色休闲外套或针织开衫。";
}

export function platChip(p, sm = false) {
  return `<span class="plat-chip ${platformCode(p).toLowerCase()}${sm ? " sm" : ""}">${esc(p)}</span>`;
}

/* 月度产量小条：刻度全账号统一，取整十 */
export function monthlyBarHtml(a, withText = false) {
  const done = a.monthlyDone || 0;
  const peak = Math.max(...state.accounts.map(x => x.monthlyDone || 0), 0);
  const scale = Math.max(20, Math.ceil((peak + 1) / 10) * 10);
  const pct = Math.min(100, Math.round(done / scale * 100));
  return `<span class="month-progress" title="本月已交付 ${done} 条（刻度 ${scale}）">
    <span class="mp-track"><i style="width:${pct}%"></i></span><em>${withText ? `本月 ${done} 条` : done}</em>
  </span>`;
}

/* 交付命名：平台码-账号名-内容形式-序号-日期 */
export function buildDeliveryName(acc, seq) {
  const nm = (acc.name || "账号").replace(/\s+/g, "");
  return `${platformCode(acc.platform)}-${nm}-${modeLabel(acc)}-${String(seq).padStart(3, "0")}-${todayStamp()}`;
}

export function createAccount(data) {
  const a = {
    id: uid(),
    name: data.name,
    platform: ["小红书", "视频号", "抖音", "公众号"].includes(data.platform) ? data.platform : "小红书",
    mode: data.mode === "图文" ? "图文" : "视频",
    subType: data.mode === "图文" ? "" : (data.subType === "无数字人" ? "无数字人" : "数字人"),
    position: "",
    styleProfile: data.styleProfile || "",
    tone: data.tone || "教程感",
    qtags: (data.qtags || []).filter(t => TAG_POOL.includes(t)),
    monthlyDone: 0, exportSeq: 0,
    charBoardAssetId: data.charBoardAssetId || null,
    voiceRefAssetId: data.voiceRefAssetId || null,
    voiceId: data.voiceId || "",
    voiceName: data.voiceName || "",
    avatarAssetId: data.avatarAssetId || null,
    imageStyleAssetId: data.imageStyleAssetId || null,
    imagePromptTemplate: data.imagePromptTemplate || "",
    homepageUrl: normalizeHomepageUrl(data.homepageUrl || ""),
    appearanceAnchor: data.appearanceAnchor || (data.mode === "视频" && data.subType !== "无数字人" ? appearanceAnchorFor(data) : ""),
    lockedStyle: null, customStyleChips: [],
    createdAt: Date.now(), updatedAt: Date.now()
  };
  state.accounts.push(a);
  save("accounts");
  return a;
}

export function updateAccount(id, patch) {
  const a = state.accounts.find(x => x.id === id);
  if (!a) return null;
  Object.assign(a, patch, { updatedAt: Date.now() });
  save("accounts");
  return a;
}

export function deleteAccount(id) {
  const a = state.accounts.find(x => x.id === id);
  if (!a) return false;
  const prodIds = state.productions.filter(p => p.accountId === id).map(p => p.id);
  const assetIds = state.assets.filter(x => x.accountId === id).map(x => x.id);
  state.accounts = state.accounts.filter(x => x.id !== id);
  state.productions = state.productions.filter(p => p.accountId !== id);
  state.assets = state.assets.filter(x => x.accountId !== id);
  if (state.ui.activeAccountId === id) state.ui.activeAccountId = state.accounts[0]?.id || null;
  save("accounts", "productions", "assets", "meta");
  removeRemote("accounts", id);
  removeRemote("productions", ...prodIds);
  removeRemote("assets", ...assetIds);
  notify("account", `账号「${a.name}」已删除`, "其任务与资产已一并移除");
  return true;
}

export function isAvatarAsset(asset) {
  const text = `${asset?.name || ""} ${(asset?.tags || []).join(" ")}`;
  return /账号头像|头像素材|(^|[\s_-])头像([\s_-]|$)/i.test(text);
}

export function accountAssets(accId) {
  return state.assets.filter(x => x.accountId === accId && !isAvatarAsset(x));
}

export function productionAssets(accId) {
  return state.assets.filter(x => !isAvatarAsset(x)
    && (!x.accountId || x.accountId === accId)
    && !x.delivered);
}

export const charBoardOf = a => a && a.charBoardAssetId ? state.assets.find(x => x.id === a.charBoardAssetId) : null;
