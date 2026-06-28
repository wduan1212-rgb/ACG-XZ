/* production：统一内容生产任务模型 + 阶段状态机
   图文：images(图片工坊：创作内容/模板/成图一体) → copy → review → delivered
   视频（真人/素材）：workshop(选题/口播/分镜一体节点) → cut(智能混剪+BGM) → copy → review */

import { state, save, emit, accountById, ownedBy, removeRemote } from "../core/store.js";
import { uid, spreadCaption } from "../core/util.js";
import { BGM_POOL } from "../api/prompts.js";

export const STAGES = {
  script: { label: "脚本", icon: "fileText" },
  boards: { label: "分镜", icon: "image" },
  images: { label: "图片工坊", icon: "image" },
  prompts: { label: "提示词", icon: "list" },
  workshop: { label: "分镜工坊", icon: "layers" },
  render: { label: "生成", icon: "film" },
  cut: { label: "剪辑", icon: "scissors" },
  copy: { label: "文案", icon: "type" },
  review: { label: "审核", icon: "eye" },
  delivered: { label: "已交付", icon: "package" }
};

export const isMaterial = p => p && p.mode === "视频" && p.subType === "无数字人";
export const isVideoWorkshop = p => p && p.mode === "视频";

/* flowOf 接受 production / account（含 mode + subType）或 (mode, subType) */
export const flowOf = (p, subType) => {
  const mode = typeof p === "object" && p ? p.mode : p;
  if (mode === "图文") return ["images", "copy", "review"];
  return ["workshop", "cut", "copy", "review"];
};

/* 旧数据兜底：阶段不在当前链路里时映射到最近的合法阶段 */
export function normalizeStage(p) {
  if (p.stage === "delivered") return "delivered";
  const flow = flowOf(p);
  if (p.mode === "图文" && p.stage === "script") return "images";
  if (isVideoWorkshop(p) && p.stage === "script") return "workshop";
  if (flow.includes(p.stage)) return p.stage;
  if (isVideoWorkshop(p) && ["boards", "prompts", "render"].includes(p.stage)) return "workshop";
  return p.mode === "图文" ? "images" : "script";
}

export const STATUS_LABEL = {
  pending: "待开始", running: "进行中", needs_input: "等待上传", failed: "失败", done: "已完成"
};

export function blankArtifacts() {
  return {
    script: { title: "", shots: [], source: "", style: "", imageCount: 6, direction: "", productId: "dumate" },
    boards: { items: [], units: [], sharedRefAssetId: null, externalPrompt: "", externalGroups: [], generationMode: null, digitalHuman: { provider: "", model: "", segments: [] } },
    images: { items: [], sharedRefAssetId: null, externalPrompt: "" },
    prompts: [],
    audio: { assetId: null, duration: 0, perShot: [], source: "", voiceId: "", voiceRefAssetId: null, voiceRefDisabled: false },  // 口播/声线（视频号）
    bgm: null,              // {name, volume, auto}（素材号智能混剪选配）
    renders: [],            // jobId 列表
    timeline: [],           // [{id, jobId, name, dur, trimIn}]
    subs: [],
    subStyle: { size: 13, stroke: 2, bottom: 12 },
    copy: { title: "", body: "" }
  };
}

/* 口播时长估算：中文按自然短视频口播约 4.2 字/秒，单句至少 3 秒，避免字幕和口播挤在一起。 */
export function estimateAudio(shots) {
  const perShot = (shots || []).map(s => {
    const n = String(s.line || "").replace(/[\s，。、！？!?,.]/g, "").length;
    return { dur: Math.max(3, Math.round(n / 4.2 * 10) / 10) };
  });
  const duration = Math.round(perShot.reduce((a, x) => a + x.dur, 0) * 10) / 10;
  return { perShot, duration };
}

/* 素材号：按 scene 把连贯镜头合并成「分镜单元」（一个单元 = 一条多镜头视频）
   needsImage = 单元内任一镜头含产品界面/logo/真实中文（必须先出分镜图再图生视频）；
   否则 t2v 直接文生视频（可选加参考图）。保留已有单元的提示词/图。 */
export const UNIT_MAX_SEC = 15;   // 单镜头视频上限（当前视频模型不支持超过 15s）
export const UNIT_TARGET_MIN_SEC = 10; // 尽量合成 10-15s 的连贯多镜头，避免 5s 碎片导致口播过赶
export function buildMaterialUnits(p) {
  const shots = p.artifacts.script.shots || [];
  const per = p.artifacts.audio.perShot || [];
  const old = p.artifacts.boards.units || [];
  const units = [];
  let cur = null;
  shots.forEach((s, i) => {
    const scene = s.scene != null ? s.scene : i + 1;
    const d = (per[i] && per[i].dur) || 4;
    // 优先按 10-15s 合并成一条多镜头提示词；scene 只作为内容标签，不再硬切，避免口播和画面被拆得太碎。
    if (!cur || (cur.shotIndexes.length && cur.dur + d > UNIT_MAX_SEC)) {
      cur = { id: uid(), scene, scenes: [], shotIndexes: [], needsImage: false, mode: "t2v",
        imagePrompt: "", videoPrompt: "", imageAssetId: null, refAssetId: null, refAssetIds: [], dur: 0, status: "idle" };
      units.push(cur);
    }
    if (!cur.scenes.includes(scene)) cur.scenes.push(scene);
    cur.shotIndexes.push(i);
    if (s.ui || (p.subType === "数字人" && i === 0)) cur.needsImage = true;
    cur.dur += d;
  });
  // 如果最后一段过短，且和前一段合并不超过上限，则合并回去。
  for (let i = units.length - 1; i > 0; i--) {
    const u = units[i], prev = units[i - 1];
    if (u.dur < UNIT_TARGET_MIN_SEC && prev.dur + u.dur <= UNIT_MAX_SEC) {
      prev.shotIndexes.push(...u.shotIndexes);
      prev.scenes = [...new Set([...(prev.scenes || [prev.scene]), ...(u.scenes || [u.scene])])];
      prev.needsImage = prev.needsImage || u.needsImage;
      prev.dur += u.dur;
      units.splice(i, 1);
    }
  }
  // 同场景内的分段序号（用于显示 S03·2/3）
  const sceneTotal = {};
  units.forEach(u => { sceneTotal[u.scene] = (sceneTotal[u.scene] || 0) + 1; });
  const sceneSeq = {};
  units.forEach(u => {
    u.mode = u.needsImage ? "i2v" : "t2v";
    u.dur = Math.min(UNIT_MAX_SEC, Math.round(u.dur * 10) / 10);
    sceneSeq[u.scene] = (sceneSeq[u.scene] || 0) + 1;
    u.part = sceneSeq[u.scene];
    u.sceneParts = sceneTotal[u.scene];
    // 按"首镜索引"匹配旧单元，脚本未变时稳定保留提示词/图（拆分后也对得上）
    const o = old.find(x => (x.shotIndexes || []).includes(u.shotIndexes[0]));
    if (o) { u.id = o.id; u.imagePrompt = o.imagePrompt || ""; u.videoPrompt = o.videoPrompt || ""; u.imageAssetId = o.imageAssetId || null; u.refAssetId = o.refAssetId || null; u.refAssetIds = (o.refAssetIds && o.refAssetIds.length ? o.refAssetIds : (o.refAssetId ? [o.refAssetId] : [])).slice(0, 4); if (o.mode) u.mode = o.mode; }
  });
  p.artifacts.boards.units = units;
  return units;
}
export const materialUnits = p => p.artifacts.boards.units || [];
export const unitShots = (p, u) => (u.shotIndexes || []).map(i => p.artifacts.script.shots[i]).filter(Boolean);

/* 按账号定位智能选一条 BGM（搞笑→活泼，知识→沉稳，默认轻快） */
export function pickBgm(position = "", seed = "") {
  const pos = String(position);
  let mood = "轻快";
  if (/搞笑|幽默|段子|梗/.test(pos)) mood = "活泼";
  else if (/深度|知识|科普|测评|专业/.test(pos)) mood = "沉稳";
  else if (/治愈|温暖|生活/.test(pos)) mood = "温暖";
  const pool = BGM_POOL.filter(b => b.mood === mood);
  const list = pool.length ? pool : BGM_POOL;
  const h = [...String(seed || pos)].reduce((a, c) => a + c.charCodeAt(0), 0);
  return list[h % list.length];
}

export function createProduction({ accountId, topic = "", origin = "manual", batchId = null, style = "", productId = "dumate" }) {
  const acc = accountById(accountId);
  if (!acc) return null;
  const p = {
    id: uid(), accountId, origin, batchId,
    ownerId: state.ui.currentMemberId || null,   // 创作互不干扰
    mode: acc.mode, subType: acc.subType || "",
    topic, title: topic, style,
    stage: acc.mode === "视频" ? "workshop" : "images", stageStatus: "pending",
    artifacts: blankArtifacts(),
    review: { state: "pending", notes: "", returnTo: null, at: null },
    delivery: null,
    error: null,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  if (style) p.artifacts.script.style = style;
  p.artifacts.script.productId = productId || "dumate";
  if (acc.mode === "视频") {
    p.artifacts.boards.generationMode = acc.subType === "数字人" ? "digitalHuman" : "seedance";
    p.artifacts.boards.digitalHuman = { provider: "", model: "", segments: [] };
  }
  state.productions.push(p);
  save("productions");
  return p;
}

export function touch(p) { p.updatedAt = Date.now(); }

export function setStage(p, stage, status = "pending") {
  p.stage = stage; p.stageStatus = status; touch(p);
  save("productions");
  emit("production:update", p);
}

export function setStatus(p, status, error = null) {
  p.stageStatus = status;
  p.error = status === "failed" ? (error || "未知错误") : null;
  touch(p);
  save("productions");
  emit("production:update", p);
}

/* 当前阶段完成 → 推进到下一阶段 */
export function advance(p, nextStatus = "pending") {
  const flow = flowOf(p);
  const i = flow.indexOf(p.stage);
  if (i < 0 || i >= flow.length - 1) return;
  setStage(p, flow[i + 1], nextStatus);
}

export function stageIndex(p) {
  return flowOf(p).indexOf(normalizeStage(p));
}

/* 阶段完成度判断（用于 stepper 已完成态与看板圆点） */
export function stageDone(p, stage) {
  const A = p.artifacts;
  switch (stage) {
    case "script": return (A.script.shots || []).length > 0;
    case "boards": { const it = A.boards.items || []; return it.length > 0 && it.every(x => x.assetId); }
    case "images": { const it = A.images.items || []; return it.length > 0 && it.every(x => x.assetId); }
    case "prompts": return (A.prompts || []).length > 0;
    case "workshop": {
      const units = A.boards.units || [];
      if (!units.length) return false;
      const jobs = jobsOf(p);
      return units.every((u, i) => jobs.some(j => j.segIndex === i && j.status === "succeeded"));
    }
    case "render": { const jobs = jobsOf(p); return jobs.length > 0 && jobs.every(j => j.status === "succeeded"); }
    case "cut": return (A.timeline || []).length > 0;
    case "copy": return !!(A.copy.title && A.copy.body);
    case "review": return p.review.state === "approved";
    default: return p.stage === "delivered";
  }
}

export function jobsOf(p) {
  return state.jobs.filter(j => j.productionId === p.id && !j.superseded);
}

/* 状态徽章数据：[label, css 类] */
export function statusPill(p) {
  if (p.stage === "delivered") return ["已交付", "delivered"];
  if (p.stageStatus === "failed") return ["失败", "failed"];
  const stage = normalizeStage(p);
  if (p.stageStatus === "running") return [stage === "workshop" ? "全自动生成中" : STAGES[stage].label + "中", "running"];
  if (p.stageStatus === "needs_input") return ["等待上传", "need-input"];
  if (stage === "review") {
    if (p.review.state === "approved") return ["审核通过", "approved"];
    if (p.review.state === "submitted") return ["已提交待审", "review"];
    if (p.review.state === "rejected") return ["已驳回", "need-input"];
    return ["待提交审核", "pending"];
  }
  return [(STAGES[stage] || STAGES.images).label + " · 待处理", "pending"];
}

export function deleteProduction(id) {
  const jobIds = state.jobs.filter(j => j.productionId === id).map(j => j.id);
  state.productions = state.productions.filter(p => p.id !== id);
  state.jobs = state.jobs.filter(j => j.productionId !== id);
  if (state.ui.activeProductionId === id) state.ui.activeProductionId = null;
  save("productions", "jobs", "meta");
  removeRemote("productions", id);
  removeRemote("jobs", ...jobIds);
}

export function productionsOf(accountId) {
  return state.productions.filter(p => p.accountId === accountId && ownedBy(p)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function inFlightOf(accountId) {
  return productionsOf(accountId).filter(p => p.stage !== "delivered");
}

/* 当前成员名下的全部任务（创作互不干扰；admin 全看） */
export function myProductions() {
  return state.productions.filter(ownedBy);
}

/* 脚本镜头序列化（给模型） */
export function shotsToText(shots, img) {
  if (!shots || !shots.length) return "";
  return shots.map((s, i) => img
    ? `图${i + 1}｜核心思想：${s.idea || ""}｜画面：${s.visual || ""}｜文案：${s.line || ""}`
    : `镜头${i + 1}｜${s.time || ""}｜核心思想：${s.idea || ""}｜画面：${s.visual || ""}｜口播：${s.line || ""}`
  ).join("\n");
}

/* 视频脚本时间归一化：覆盖 0-30s，15s 处可拆前后段 */
export function normalizeVideoTimes(shots) {
  const n = shots.length || 1;
  const half = Math.max(1, Math.ceil(n / 2));
  const back = Math.max(1, n - half);
  shots.forEach((s, i) => {
    let start, end;
    if (i < half) { start = Math.round(i * 15 / half); end = Math.round((i + 1) * 15 / half); }
    else { const k = i - half; start = 15 + Math.round(k * 15 / back); end = 15 + Math.round((k + 1) * 15 / back); }
    s.time = `${start}-${end}s`;
  });
  if (shots.length) shots[shots.length - 1].time = shots[shots.length - 1].time.replace(/-\d+s$/, "-30s");
}

/* 生成台片段视图：每场景拆 前/后 两个独立 15s 段 */
export function segmentsForGen(p) {
  const prompts = p.artifacts.prompts || [];
  if (!prompts.length) return [];
  const segs = [];
  prompts.forEach((sc, pi) => {
    const base = sc.name || `场景 ${String(pi + 1).padStart(2, "0")}`;
    segs.push({ scene: pi, part: "front", sceneName: base, name: `${base} · 第一段`, prompt: sc.front || "" });
    if (sc.back) segs.push({ scene: pi, part: "back", sceneName: base, name: `${base} · 第二段`, prompt: sc.back || "" });
  });
  return segs;
}

/* 智能剪辑：用已成功的 job 自动拼时间轴 + 从口播铺字幕
   素材号额外：片段时长跟随口播音频估时、自动选配 BGM（音量低于口播） */
export function autoAssemble(p) {
  if (isVideoWorkshop(p) && (p.artifacts.boards.units || []).length) return autoMixMaterial(p);
  const segs = segmentsForGen(p);
  const okJobs = segs.map((s, i) => {
    const list = state.jobs.filter(j => j.productionId === p.id && j.segIndex === i && j.status === "succeeded");
    return list[list.length - 1] || null;
  }).filter(Boolean);
  if (okJobs.length) {
    p.artifacts.timeline = okJobs.map(j => ({ id: uid(), jobId: j.id, name: j.segName || `Segment ${j.segIndex + 1}`, dur: 15, trimIn: 0 }));
  }
  const rows = (p.artifacts.script.shots || []).filter(s => (s.line || "").trim());
  if (rows.length && !(p.artifacts.subs || []).length) {
    let t = 0; const subs = [];
    rows.forEach(s => {
      let st = t, en; const m = String(s.time || "").match(/(\d+)\s*-\s*(\d+)/);
      if (m) { st = +m[1]; en = +m[2]; } else { en = st + 3; } t = en;
      subs.push(...spreadCaption(s.line.trim(), st, en));
    });
    p.artifacts.subs = subs;
  }
  touch(p);
  save("productions");
  return { clips: p.artifacts.timeline.length, subs: (p.artifacts.subs || []).length };
}

export function autoMixMaterial(p) {
  const acc = accountById(p.accountId);
  const shots = p.artifacts.script.shots || [];
  if (!(p.artifacts.audio.perShot || []).length && shots.length) {
    Object.assign(p.artifacts.audio, estimateAudio(shots), { source: p.artifacts.audio.source || "estimate" });
  }
  const units = materialUnits(p);
  // 按单元（多镜头片段）拼接，时长 = 该单元所有镜头口播时长之和
  const clips = [];
  units.forEach((u, ui) => {
    const list = state.jobs.filter(j => j.productionId === p.id && j.segIndex === ui && j.status === "succeeded" && (!u.videoPrompt || j.prompt === u.videoPrompt));
    const job = list[list.length - 1];
    if (job) clips.push({ id: uid(), jobId: job.id, unitId: u.id, name: `场景${String(u.scene).padStart(2, "0")}${u.sceneParts > 1 ? `·${u.part}` : ""}`, dur: Math.min(UNIT_MAX_SEC, Math.max(1.5, Math.round(u.dur * 2) / 2)), trimIn: 0 });
  });
  if (clips.length) p.artifacts.timeline = clips;
  // 字幕按口播时长顺排（逐镜头），长句智能拆成 ≤18 字多条，避免一屏多行
  const per = p.artifacts.audio.perShot || [];
  const subs = [];
  let t = 0;
  shots.forEach((s, i) => {
    const d = (per[i] && per[i].dur) || 3;
    const line = (s.line || "").trim();
    if (line) subs.push(...spreadCaption(line, t, t + d));
    t += d;
  });
  p.artifacts.subs = subs;
  const hasExternalVoice = !!p.artifacts.audio.assetId && ["tts", "upload"].includes(p.artifacts.audio.source);
  if (hasExternalVoice && !p.artifacts.bgm) {
    const b = pickBgm(acc?.position, p.topic);
    p.artifacts.bgm = { name: b.name, mood: b.mood, volume: 0.25, auto: true };
  } else if (!hasExternalVoice && p.artifacts.bgm?.auto) {
    p.artifacts.bgm = null;
  }
  touch(p);
  save("productions");
  return { clips: p.artifacts.timeline.length, subs: (p.artifacts.subs || []).length, bgm: p.artifacts.bgm?.name };
}

/* 素材号：重生成某单元后，时间轴对应片段自动换绑到新 job */
export function rebindUnitClip(p, unitIndex, job) {
  const units = materialUnits(p);
  const u = units[unitIndex]; if (!u || !job) return;
  const clip = (p.artifacts.timeline || []).find(c => c.unitId === u.id);
  if (clip) { clip.jobId = job.id; clip.trimIn = 0; touch(p); save("productions"); }
}
