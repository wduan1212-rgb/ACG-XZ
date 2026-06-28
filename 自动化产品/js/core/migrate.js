/* v4(acgVideoTool 整包快照) → v5(分仓) 数据迁移
   原则：旧库只读不动（天然回滚备份）；逐实体 try/catch，宁可漏一条不可崩整体 */

import { db, openLegacyState } from "./db.js";
import { state } from "./store.js";
import { uid, dataUrlToBlob } from "./util.js";
import { blankArtifacts, normalizeVideoTimes } from "../domain/productions.js";

async function dataUrlToAsset(accountId, { name, type = "图片", tags = [], dataUrl, extra = {} }) {
  const a = { id: uid(), accountId, name: name || "素材", type, tags, createdAt: Date.now(), hasBlob: false, ...extra };
  if (dataUrl && /^data:/.test(dataUrl)) {
    try {
      await db.putBlob(a.id, dataUrlToBlob(dataUrl));
      a.hasBlob = true;
    } catch (e) { a.dataUrl = dataUrl; }
  }
  state.assets.push(a);
  return a;
}

export async function migrateFromV4() {
  const done = await db.metaGet("migratedV4");
  if (done) return { migrated: false };
  const snap = await openLegacyState();
  if (!snap || !snap.accounts || !snap.accounts.length) {
    await db.metaSet("migratedV4", { at: Date.now(), empty: true });
    return { migrated: false };
  }

  const counts = { accounts: 0, assets: 0, productions: 0 };
  const oldAssetIdMap = new Map(); // 旧 asset.id -> 新 asset.id

  for (const oa of snap.accounts) {
    try {
      const acc = {
        id: oa.id || uid(), name: oa.name, platform: oa.platform || "小红书",
        mode: oa.mode === "图文" ? "图文" : "视频",
        subType: oa.mode === "图文" ? "" : (oa.subType || "数字人"),
        position: oa.position || "（待补充定位）", tone: oa.tone || "教程感",
        qtags: oa.qtags || [], monthlyDone: oa.monthlyDone || 0, exportSeq: oa.exportSeq || 0,
        charBoardAssetId: null, lockedStyle: oa.lockedStyle || null,
        customStyleChips: oa.customStyleChips || [], createdAt: Date.now()
      };
      state.accounts.push(acc); counts.accounts++;

      // 角色身份版
      if (oa.charBoard) {
        const ca = await dataUrlToAsset(acc.id, { name: acc.name + " 角色身份版", tags: ["角色版"], dataUrl: oa.charBoard });
        acc.charBoardAssetId = ca.id; counts.assets++;
      }

      // 普通资产 + 已交付成片
      for (const x of (oa.assets || [])) {
        try {
          const delivered = !!x.exported || (x.tags || []).includes("成片");
          const rec = await dataUrlToAsset(acc.id, {
            name: x.name, type: ["图片", "视频", "音频", "图集"].includes(x.type) ? x.type : "图片",
            tags: x.tags || [], dataUrl: x.dataUrl,
            extra: delivered ? { delivered: true, status: x.status || "未下载", title: x.title || "", copy: x.copy || "", clips: x.clips || 0 } : {}
          });
          oldAssetIdMap.set(x.id, rec.id);
          counts.assets++;
          // 图集成员展开为独立资产
          if (delivered && x.pack && (x.images || []).length) {
            rec.packAssetIds = [];
            for (let i = 0; i < x.images.length; i++) {
              const im = x.images[i];
              const child = await dataUrlToAsset(acc.id, { name: `${x.name}_${String(i + 1).padStart(2, "0")}`, tags: ["成片图"], dataUrl: im.dataUrl });
              rec.packAssetIds.push(child.id); counts.assets++;
            }
          }
        } catch (e) { /* 单个资产失败跳过 */ }
      }

      // 历史发布 → 已交付 production
      for (const pub of (oa.publications || [])) {
        try {
          const isVideo = pub.kind === "video";
          const p = {
            id: uid(), accountId: acc.id, origin: "manual", batchId: null,
            mode: isVideo ? "视频" : "图文", subType: acc.subType || "",
            topic: (pub.review && pub.review.topic) || pub.title || "", title: pub.title || "",
            stage: "delivered", stageStatus: "done",
            artifacts: blankArtifacts(),
            review: { state: "approved", notes: "", returnTo: null, at: pub.ts || Date.now() },
            delivery: { assetId: oldAssetIdMap.get(pub.assetId) || null, name: pub.name, at: pub.ts || Date.now() },
            error: null, createdAt: pub.ts || Date.now(), updatedAt: pub.ts || Date.now()
          };
          p.artifacts.copy = { title: pub.title || "", body: pub.copy || "" };
          if (isVideo && pub.review) {
            p.artifacts.script.shots = pub.review.shots || [];
            p.artifacts.timeline = (pub.review.clips || []).map(c => ({ id: uid(), jobId: null, name: c.name, dur: c.dur || 15, trimIn: c.trimIn || 0 }));
          }
          // 关联交付资产 productionId
          const da = state.assets.find(x => x.id === p.delivery.assetId);
          if (da) da.productionId = p.id;
          state.productions.push(p); counts.productions++;
        } catch (e) { /* 跳过 */ }
      }
    } catch (e) { /* 整账号失败跳过 */ }
  }

  // 快速批量任务 → 在制 production（已发布的跳过，publications 已覆盖）
  const QMAP = { drafting: ["script", "pending"], awaiting: ["needs"], ready: ["ready"], failed: ["script", "failed"], check: ["review", "pending"], publish: ["review", "approved"] };
  for (const t of ((snap.quick && snap.quick.tasks) || [])) {
    try {
      if (t.status === "published" || !QMAP[t.status]) continue;
      const acc = state.accounts.find(a => a.id === t.accId);
      if (!acc) continue;
      const isImg = (t.mode || acc.mode) === "图文";
      const p = {
        id: uid(), accountId: acc.id, origin: "agent", batchId: null,
        mode: isImg ? "图文" : "视频", subType: acc.subType || "",
        topic: snap.quick.topic || "", title: t.title || snap.quick.topic || "",
        stage: "script", stageStatus: "pending",
        artifacts: blankArtifacts(),
        review: { state: "pending", notes: "", returnTo: null, at: null },
        delivery: null, error: t.err || null,
        createdAt: Date.now(), updatedAt: Date.now()
      };
      p.artifacts.script.shots = t.shots || [];
      p.artifacts.script.title = t.title || "";
      p.artifacts.prompts = t.prompts || [];
      p.artifacts.copy = { title: t.title || "", body: t.copy || "" };
      if (isImg) p.artifacts.images.externalPrompt = t.sbPrompt || "";
      else p.artifacts.boards.externalPrompt = t.sbPrompt || "";
      // 回传的分镜图 → 资产 + 槽位
      const slotKey = isImg ? "images" : "boards";
      const items = (t.shots || []).map((s, i) => ({ title: s.idea || "", visual: s.visual || "", prompt: "", assetId: null, status: "idle" }));
      for (let i = 0; i < (t.boards || []).length && i < items.length; i++) {
        const a = await dataUrlToAsset(acc.id, { name: `分镜${i + 1}_${(t.title || "").slice(0, 6)}`, tags: [isImg ? "笔记图" : "分镜图"], dataUrl: t.boards[i] });
        items[i].assetId = a.id; items[i].status = "done"; counts.assets++;
      }
      p.artifacts[slotKey].items = items;
      // 阶段推断
      const allBoards = items.length > 0 && items.every(x => x.assetId);
      if (t.status === "check") { p.stage = "review"; p.stageStatus = "pending"; }
      else if (t.status === "publish") { p.stage = "review"; p.stageStatus = "pending"; p.review.state = "approved"; }
      else if (t.status === "failed") { p.stage = "script"; p.stageStatus = "failed"; }
      else if (!p.artifacts.script.shots.length) { p.stage = "script"; p.stageStatus = "pending"; }
      else if (!allBoards) { p.stage = isImg ? "images" : "boards"; p.stageStatus = "needs_input"; }
      else { p.stage = isImg ? "copy" : "render"; p.stageStatus = "pending"; }
      state.productions.push(p); counts.productions++;
    } catch (e) { /* 跳过 */ }
  }

  // 手动链路在制草稿（workByAccount + 顶层 draft）→ 在制 production
  const workMap = Object.assign({}, snap.workByAccount || {});
  if (snap.activeAccountId && snap.draft) {
    workMap[snap.activeAccountId] = workMap[snap.activeAccountId] || { draft: snap.draft, timeline: snap.timeline || [] };
  }
  for (const [accId, w] of Object.entries(workMap)) {
    try {
      const acc = state.accounts.find(a => a.id === accId);
      const d = w && w.draft;
      if (!acc || !d || !(d.topic || (d.shots || []).length)) continue;
      const isImg = acc.mode === "图文";
      const p = {
        id: uid(), accountId: acc.id, origin: "manual", batchId: null,
        mode: acc.mode, subType: acc.subType || "",
        topic: d.topic || "", title: d.title || d.topic || "",
        stage: "script", stageStatus: "pending",
        artifacts: blankArtifacts(),
        review: { state: "pending", notes: "", returnTo: null, at: null },
        delivery: null, error: null, createdAt: Date.now(), updatedAt: Date.now()
      };
      p.artifacts.script = { title: d.title || "", shots: d.shots || [], source: "", style: d.imageStyle || "", imageCount: d.imageCount || 6, direction: d.direction || "" };
      if (!isImg && (d.shots || []).length) normalizeVideoTimes(p.artifacts.script.shots);
      p.artifacts.prompts = d.prompts || [];
      p.artifacts.subs = d.subs || [];
      p.artifacts.copy = { title: d.xhsTitle || "", body: d.xhsCopy || "" };
      p.artifacts.timeline = (w.timeline || []).map(c => ({ id: uid(), jobId: null, name: c.name, dur: c.dur || 15, trimIn: c.trimIn || 0 }));
      const mapItems = (arr, tagName) => (arr || []).map(x => ({
        title: x.title || "", visual: x.visual || "", prompt: x.prompt || "",
        assetId: (x.assetId && oldAssetIdMap.get(x.assetId)) || null,
        status: x.assetId ? "done" : "idle"
      }));
      if (isImg) p.artifacts.images.items = mapItems(d.imagePrompts);
      else p.artifacts.boards.items = mapItems(d.storyboard);
      // 阶段推断：取已有产物的最远阶段
      if (p.artifacts.timeline.length) { p.stage = "cut"; p.stageStatus = "pending"; }
      else if (!isImg && p.artifacts.prompts.length) { p.stage = "render"; p.stageStatus = "pending"; }
      else if ((isImg ? p.artifacts.images.items : p.artifacts.boards.items).some(x => x.assetId)) { p.stage = isImg ? "images" : "boards"; p.stageStatus = "needs_input"; }
      else if ((d.shots || []).length) { p.stage = isImg ? "images" : "boards"; p.stageStatus = "pending"; }
      state.productions.push(p); counts.productions++;
    } catch (e) { /* 跳过 */ }
  }

  state.apiKeys = (snap.apiKeys || []).map(k => ({ ...k }));
  state.ui.activeAccountId = snap.activeAccountId || state.accounts[0]?.id || null;

  await db.metaSet("migratedV4", { at: Date.now(), counts });
  return { migrated: true, counts };
}
