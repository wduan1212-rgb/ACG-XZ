/* 链路 · 分镜（视频）/ 图片工坊（图文）：站内图片 API 优先，站外上传仅作备用 */

import { $, $$, esc, gradFor, copyText, fileToDataUrl, wireDropZone } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, accountById, productById, primaryProducts, primaryProductById } from "../core/store.js";
import { AI } from "../api/ai.js";
import { buildSbExternalPrompt, buildImgExternalPrompt } from "../api/prompts.js";
import { setStage, shotsToText } from "../domain/productions.js";
import { accountAssets } from "../domain/accounts.js";
import { urlFor, thumbHtml, addAssetFromDataUrl, replaceAssetBlob, removeAsset } from "../domain/assets.js";
import { activeProviderFor, imageApiConfigured, providerKeyFor } from "../api/providers.js";
import { maybeAdvanceAfterInput } from "../agent/orchestrator.js";
import { toast, withLoading, openLightbox, confirmModal } from "../ui/components.js";
import { currentRoute, go } from "../core/router.js";
import { stepperHtml, wireStepper } from "./studio.js";

const modeBySlot = new Map(); // productionId -> "in" | "out"
const MAX_IMAGE_REFS = 5;
const DEFAULT_XHS_IMAGE_COUNT = 4;
const IMAGE_NEGATIVE_PROMPT = "负面约束：不出现页码，不出现二维码，图片右上角和左上角不要加入logo，其他位置可以正常出现logo。";

function hashSeed(str = "") {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seeded(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
export function polishImageForPublish(dataUrl, seedText = "") {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) return resolve(dataUrl);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      const rnd = seeded(hashSeed(seedText + ":" + w + "x" + h));
      const filterPresets = [
        { sat: 1.045, contrast: 1.035, bright: 1.012, tintA: "rgba(255,255,255,.09)", tintB: "rgba(74,144,226,.035)" },
        { sat: 1.070, contrast: 1.022, bright: 1.018, tintA: "rgba(255,248,240,.075)", tintB: "rgba(255,91,141,.026)" },
        { sat: 0.985, contrast: 1.060, bright: 1.020, tintA: "rgba(240,250,255,.075)", tintB: "rgba(36,180,166,.032)" },
        { sat: 1.025, contrast: 1.045, bright: 1.028, tintA: "rgba(255,255,255,.065)", tintB: "rgba(116,88,255,.032)" },
        { sat: 1.090, contrast: 1.018, bright: 1.008, tintA: "rgba(255,250,232,.060)", tintB: "rgba(245,158,11,.024)" },
        { sat: 1.000, contrast: 1.072, bright: 1.014, tintA: "rgba(246,249,255,.070)", tintB: "rgba(59,130,246,.026)" },
        { sat: 1.055, contrast: 1.030, bright: 1.034, tintA: "rgba(255,252,246,.055)", tintB: "rgba(236,72,153,.022)" },
        { sat: 0.970, contrast: 1.082, bright: 1.024, tintA: "rgba(245,255,252,.060)", tintB: "rgba(16,185,129,.025)" },
      ];
      const preset = filterPresets[Math.floor(rnd() * filterPresets.length)] || filterPresets[0];
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.filter = `saturate(${preset.sat.toFixed(3)}) contrast(${preset.contrast.toFixed(3)}) brightness(${preset.bright.toFixed(3)})`;
      ctx.drawImage(img, 0, 0, w, h);
      ctx.filter = "none";

      const light = ctx.createLinearGradient(0, 0, w, h);
      light.addColorStop(0, preset.tintA);
      light.addColorStop(0.42, "rgba(255,255,255,.020)");
      light.addColorStop(1, preset.tintB);
      ctx.globalCompositeOperation = "soft-light";
      ctx.fillStyle = light;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";

      // 可见的轻量版式精修元素：不遮挡主体、不裁剪；角标随机出现，不能固定四角都有。
      const pad = Math.max(18, Math.round(Math.min(w, h) * 0.025));
      const minSide = Math.min(w, h);
      const len = Math.max(42, Math.round(minSide * (0.052 + rnd() * 0.032)));
      const colors = [
        "rgba(63,107,255,.22)", "rgba(154,69,255,.18)", "rgba(255,77,141,.17)",
        "rgba(20,184,166,.17)", "rgba(245,158,11,.15)", "rgba(56,189,248,.17)",
        "rgba(14,165,233,.15)", "rgba(99,102,241,.16)", "rgba(244,114,182,.14)",
      ];
      const corners = [
        { key: "tl", x: pad, y: pad, sx: 1, sy: 1 },
        { key: "tr", x: w - pad, y: pad, sx: -1, sy: 1 },
        { key: "bl", x: pad, y: h - pad, sx: 1, sy: -1 },
        { key: "br", x: w - pad, y: h - pad, sx: -1, sy: -1 },
      ].sort(() => rnd() - 0.5).slice(0, Math.floor(rnd() * 3));
      const pickColor = (shift = 0) => colors[(Math.floor(rnd() * colors.length) + shift) % colors.length];
      const withAlpha = (color, alpha) => color.replace(/rgba\(([^)]+),\s*[\d.]+\)/, `rgba($1,${alpha})`);
      const lineW = Math.max(2, Math.round(minSide * (0.0026 + rnd() * 0.0018)));
      const veilMode = Math.floor(rnd() * 5);
      if (veilMode === 0) {
        const veil = ctx.createLinearGradient(w * 0.18, 0, w * 0.82, h);
        veil.addColorStop(0, "rgba(255,255,255,.035)");
        veil.addColorStop(1, "rgba(59,130,246,.020)");
        ctx.fillStyle = veil;
        ctx.fillRect(0, 0, w, h);
      } else if (veilMode === 1) {
        const veil = ctx.createRadialGradient(w * (0.18 + rnd() * 0.64), h * (0.16 + rnd() * 0.68), 1, w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
        veil.addColorStop(0, "rgba(255,255,255,.045)");
        veil.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = veil;
        ctx.fillRect(0, 0, w, h);
      } else if (veilMode === 2) {
        ctx.globalAlpha = 0.032 + rnd() * 0.018;
        ctx.fillStyle = pickColor();
        const step = Math.max(26, Math.round(minSide * (0.036 + rnd() * 0.018)));
        for (let yy = -step; yy < h + step; yy += step * (1.7 + rnd() * 0.8)) {
          ctx.fillRect(0, yy, w, Math.max(1, Math.round(step * (0.045 + rnd() * 0.045))));
        }
        ctx.globalAlpha = 1;
      } else if (veilMode === 3) {
        ctx.globalAlpha = 0.022 + rnd() * 0.012;
        ctx.strokeStyle = pickColor(3);
        ctx.lineWidth = Math.max(1, Math.round(lineW * 0.55));
        const step = Math.max(32, Math.round(minSide * (0.050 + rnd() * 0.018)));
        for (let xx = -step; xx < w + step; xx += step) {
          ctx.beginPath();
          ctx.moveTo(xx, 0);
          ctx.lineTo(xx + h * 0.12, h);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = lineW;
      const drawArc = ({ x, y, sx, sy }) => {
        ctx.strokeStyle = pickColor();
        ctx.beginPath();
        ctx.moveTo(x, y + sy * len);
        ctx.quadraticCurveTo(x + sx * len * 0.12, y + sy * len * 0.12, x + sx * len, y);
        ctx.stroke();
      };
      const drawCornerTicks = ({ x, y, sx, sy }) => {
        ctx.strokeStyle = pickColor(1);
        const gap = len * (0.18 + rnd() * 0.10);
        const a = len * (0.25 + rnd() * 0.12);
        ctx.beginPath();
        ctx.moveTo(x + sx * gap, y);
        ctx.lineTo(x + sx * (gap + a), y);
        ctx.moveTo(x, y + sy * gap);
        ctx.lineTo(x, y + sy * (gap + a));
        ctx.stroke();
      };
      const drawDots = ({ x, y, sx, sy }) => {
        ctx.fillStyle = pickColor(2);
        const count = 3 + Math.floor(rnd() * 4);
        for (let n = 0; n < count; n += 1) {
          const r = Math.max(2, Math.round(minSide * (0.002 + rnd() * 0.0025)));
          ctx.beginPath();
          ctx.arc(x + sx * len * (0.25 + n * 0.13), y + sy * len * (0.78 + (rnd() - 0.5) * 0.22), r, 0, Math.PI * 2);
          ctx.fill();
        }
      };
      const drawSpark = ({ x, y, sx, sy }) => {
        const cx = x + sx * len * (0.64 + rnd() * 0.16);
        const cy = y + sy * len * (0.30 + rnd() * 0.28);
        const r = Math.max(5, Math.round(len * (0.075 + rnd() * 0.035)));
        ctx.strokeStyle = pickColor(3);
        ctx.beginPath();
        ctx.moveTo(cx - r, cy);
        ctx.lineTo(cx + r, cy);
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx, cy + r);
        if (rnd() > 0.45) {
          ctx.moveTo(cx - r * 0.55, cy - r * 0.55);
          ctx.lineTo(cx + r * 0.55, cy + r * 0.55);
          ctx.moveTo(cx + r * 0.55, cy - r * 0.55);
          ctx.lineTo(cx - r * 0.55, cy + r * 0.55);
        }
        ctx.stroke();
      };
      const drawMiniGrid = ({ x, y, sx, sy }) => {
        ctx.strokeStyle = pickColor(4);
        ctx.globalAlpha = 0.55;
        const step = Math.max(7, Math.round(len * 0.13));
        const rows = 2 + Math.floor(rnd() * 2);
        const cols = 2 + Math.floor(rnd() * 3);
        const ox = x + sx * len * (0.35 + rnd() * 0.16);
        const oy = y + sy * len * (0.36 + rnd() * 0.16);
        for (let a = 0; a < cols; a += 1) {
          for (let b = 0; b < rows; b += 1) {
            ctx.strokeRect(ox + sx * a * step, oy + sy * b * step, sx * step * 0.45, sy * step * 0.45);
          }
        }
        ctx.globalAlpha = 1;
      };
      const drawSoftBlob = ({ x, y, sx, sy }) => {
        const r = len * (0.18 + rnd() * 0.12);
        const g = ctx.createRadialGradient(x + sx * len * 0.68, y + sy * len * 0.65, 1, x + sx * len * 0.68, y + sy * len * 0.65, r);
        g.addColorStop(0, withAlpha(pickColor(), 0.12));
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x + sx * len * 0.68, y + sy * len * 0.65, r, 0, Math.PI * 2);
        ctx.fill();
      };
      const drawChevron = ({ x, y, sx, sy }) => {
        ctx.strokeStyle = pickColor(5);
        const cx = x + sx * len * (0.35 + rnd() * 0.24);
        const cy = y + sy * len * (0.48 + rnd() * 0.18);
        const s = len * (0.13 + rnd() * 0.06);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + sx * s, cy + sy * s * 0.62);
        ctx.lineTo(cx + sx * s * 2, cy);
        if (rnd() > 0.52) {
          ctx.moveTo(cx + sx * s * 0.45, cy + sy * s * 0.82);
          ctx.lineTo(cx + sx * s * 1.45, cy + sy * s * 1.42);
          ctx.lineTo(cx + sx * s * 2.45, cy + sy * s * 0.82);
        }
        ctx.stroke();
      };
      const drawWave = ({ x, y, sx, sy }) => {
        ctx.strokeStyle = withAlpha(pickColor(6), 0.18);
        const ox = x + sx * len * (0.12 + rnd() * 0.22);
        const oy = y + sy * len * (0.62 + rnd() * 0.18);
        const amp = len * (0.055 + rnd() * 0.025);
        const seg = len * (0.14 + rnd() * 0.04);
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        for (let n = 1; n <= 4; n += 1) {
          ctx.quadraticCurveTo(ox + sx * seg * (n - 0.5), oy + sy * amp * (n % 2 ? -1 : 1), ox + sx * seg * n, oy);
        }
        ctx.stroke();
      };
      const drawTinyCards = ({ x, y, sx, sy }) => {
        ctx.strokeStyle = withAlpha(pickColor(7), 0.20);
        ctx.fillStyle = "rgba(255,255,255,.22)";
        const baseX = x + sx * len * (0.42 + rnd() * 0.16);
        const baseY = y + sy * len * (0.18 + rnd() * 0.18);
        for (let n = 0; n < 2 + Math.floor(rnd() * 2); n += 1) {
          const ww = sx * len * (0.13 + rnd() * 0.035);
          const hh = sy * len * (0.08 + rnd() * 0.030);
          const xx = baseX + sx * n * len * 0.105;
          const yy = baseY + sy * n * len * 0.070;
          const rx = Math.min(xx, xx + ww);
          const ry = Math.min(yy, yy + hh);
          const rw = Math.abs(ww);
          const rh = Math.abs(hh);
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(rx, ry, rw, rh, Math.max(3, lineW * 1.4));
          else ctx.rect(rx, ry, rw, rh);
          ctx.fill();
          ctx.stroke();
        }
      };
      const drawBracketRail = ({ x, y, sx, sy }) => {
        ctx.strokeStyle = withAlpha(pickColor(8), 0.16 + rnd() * 0.06);
        const ox = x + sx * len * (0.18 + rnd() * 0.18);
        const oy = y + sy * len * (0.20 + rnd() * 0.20);
        const long = len * (0.45 + rnd() * 0.22);
        const short = len * (0.10 + rnd() * 0.05);
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ox + sx * long, oy);
        ctx.lineTo(ox + sx * long, oy + sy * short);
        ctx.moveTo(ox, oy + sy * short * 1.9);
        ctx.lineTo(ox, oy + sy * (short * 1.9 + long * 0.42));
        ctx.stroke();
      };
      const drawOrbitMarks = ({ x, y, sx, sy }) => {
        ctx.strokeStyle = withAlpha(pickColor(2), 0.13 + rnd() * 0.05);
        ctx.fillStyle = withAlpha(pickColor(5), 0.16);
        const cx = x + sx * len * (0.55 + rnd() * 0.20);
        const cy = y + sy * len * (0.55 + rnd() * 0.20);
        ctx.beginPath();
        ctx.ellipse(cx, cy, len * (0.16 + rnd() * 0.04), len * (0.07 + rnd() * 0.03), (rnd() - 0.5) * 0.8, 0, Math.PI * 2);
        ctx.stroke();
        for (let n = 0; n < 2 + Math.floor(rnd() * 3); n += 1) {
          ctx.beginPath();
          ctx.arc(cx + sx * len * (0.08 + n * 0.07), cy + sy * len * ((rnd() - 0.5) * 0.16), Math.max(2, lineW * (0.75 + rnd())), 0, Math.PI * 2);
          ctx.fill();
        }
      };
      const motifs = [drawArc, drawCornerTicks, drawDots, drawSpark, drawMiniGrid, drawSoftBlob, drawChevron, drawWave, drawTinyCards, drawBracketRail, drawOrbitMarks];
      corners.forEach((corner, i) => {
        const local = motifs.slice().sort(() => rnd() - 0.5).slice(0, 2 + ((i + Math.floor(rnd() * 2)) % 2));
        local.forEach(fn => fn(corner));
      });
      const mime = dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg";
      resolve(canvas.toDataURL(mime, mime === "image/jpeg" ? 0.94 : undefined));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export async function urlToDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("图片 URL 下载失败：" + res.status);
  const blob = await res.blob();
  return await fileToDataUrl(blob);
}

function refIdsOf(A) {
  const ids = Array.isArray(A.sharedRefAssetIds) ? A.sharedRefAssetIds.filter(Boolean) : [];
  if (A.sharedRefAssetId && !ids.includes(A.sharedRefAssetId)) ids.unshift(A.sharedRefAssetId);
  return [...new Set(ids)].slice(0, MAX_IMAGE_REFS);
}

function refAssetsOf(A) {
  return refIdsOf(A).map(id => state.assets.find(x => x.id === id)).filter(Boolean);
}

function setRefIds(A, ids) {
  const clean = [...new Set((ids || []).filter(Boolean))].slice(0, MAX_IMAGE_REFS);
  A.sharedRefAssetIds = clean;
  A.sharedRefAssetId = clean[0] || null; // 兼容旧字段/旧部署
}

function appendRefId(A, id) {
  if (!id) return;
  setRefIds(A, [...refIdsOf(A), id]);
}

export async function providerRefsFor(A) {
  const refs = [];
  for (const a of refAssetsOf(A)) {
    const u = urlFor(a);
    let dataUrl = "";
    let publicUrl = "";
    if (/^data:/.test(u || "")) dataUrl = u;
    else if (u) {
      try {
        dataUrl = await urlToDataUrl(u);
      } catch (_) {
        if (/^https?:\/\//.test(u)) publicUrl = u;
      }
    }
    if (dataUrl || publicUrl) {
      refs.push({
        id: a.id,
        name: a.name || "参考图",
        type: a.type,
        mime: a.mime || "image/png",
        url: publicUrl,
        dataUrl
      });
    }
  }
  return refs;
}

function refNamesOf(A, extra = []) {
  return [...refAssetsOf(A).map(a => a.name), ...extra].filter(Boolean).slice(0, MAX_IMAGE_REFS);
}

export function enrichPromptWithRefs(prompt, A) {
  const names = refNamesOf(A);
  if (!names.length) return prompt || "";
  const body = String(prompt || "").replace(/负面约束\s*[:：][\s\S]*$/g, "").trim();
  const refNote = `统一参考图：本次提供 ${names.length} 张参考图（${names.join("、")}），请综合参考它们的产品界面、配色、信息密度、图标形态和真实截图质感；不要只参考第一张。若参考图之间功能不同，按当前画面主题选择最匹配的一张作为主参考，其余作为品牌与风格辅助参考。参考图里的旧标题、页名、示例文案一律视为占位，不要照抄；画面文字只使用本提示词指定的大标题/副标题。`;
  return `${body}\n\n${refNote}\n\n${IMAGE_NEGATIVE_PROMPT}`.trim();
}

function normalizeImageWorkshopText(text = "") {
  return String(text || "")
    .replace(/小红书竖版3:4（1080×1440）\s*[，,。；;]?\s*（1080×1440）/g, "小红书竖版3:4（1080×1440）")
    .replace(/小红书竖版3:4（1080×1440）\s*[，,。；;]?\s*画面以小红书竖版3:4（1080×1440）为主/g, "小红书竖版3:4（1080×1440）")
    .replace(/画面以小红书竖版3:4（1080×1440）为主/g, "画面按小红书竖版3:4（1080×1440）出图")
    .replace(/\s+/g, " ")
    .trim();
}

function ratioFromImagePrompt(text = "", fallback = "3:4") {
  const s = String(text || "");
  if (/9\s*[:：]\s*16|1080\s*[x×]\s*1920|竖屏\s*9\s*[:：]\s*16/.test(s)) return "9:16";
  if (/16\s*[:：]\s*9|1920\s*[x×]\s*1080|横屏\s*16\s*[:：]\s*9/.test(s)) return "16:9";
  if (/4\s*[:：]\s*3|1440\s*[x×]\s*1080/.test(s)) return "4:3";
  if (/1\s*[:：]\s*1|1024\s*[x×]\s*1024|1080\s*[x×]\s*1080|正方形(?:画布|尺寸|图片|配图)|方形(?:画布|图片|配图)/.test(s)) return "1:1";
  if (/3\s*[:：]\s*4|1080\s*[x×]\s*1440|小红书竖版|小红书笔记/.test(s)) return "3:4";
  return fallback;
}

function promptForImageModel(text = "") {
  const bannedLabels = "种草|痛点|共鸣|构图|封面|首图|痛点引入|问题引入|关键步骤|结果对比|总结收束|图\\d+|第\\d+张|步骤一|步骤二|步骤三";
  const cleaned = normalizeImageWorkshopText(text)
    .replace(new RegExp(`图上文字[：:]\\s*[「“"]?(?:${bannedLabels})[」”"]?`, "g"), "图上文字按本页标题与副标题生成")
    .replace(new RegExp(`图片任务[：:]\\s*(?:${bannedLabels})[，,。；;]?`, "g"), "图片任务：")
    .replace(new RegExp(`\\b(?:${bannedLabels})[：:]`, "g"), "")
    .replace(/负面约束\s*[:：][\s\S]*$/g, IMAGE_NEGATIVE_PROMPT);
  return /负面约束\s*[:：]/.test(cleaned)
    ? cleaned
    : `${cleaned}\n\n${IMAGE_NEGATIVE_PROMPT}`;
}

export function renderSlotsPage(root, p, isImg) {
  const acc = accountById(p.accountId);
  const A = isImg ? p.artifacts.images : p.artifacts.boards;
  const page = isImg ? "images" : "boards";
  let genMode = modeBySlot.get(p.id) || (isImg ? "in" : "out");
  const S = p.artifacts.script;
  const products = primaryProducts();
  if (isImg) {
    S.productId = primaryProductById(S.productId || "dumate")?.id || "dumate";
    S.imageCount = S.imageCount || DEFAULT_XHS_IMAGE_COUNT;
    S.direction = S.direction || "";
    S.useOnlineTrends = !!S.useOnlineTrends;
    if (p.stage === "script") p.stage = "images";
  }

  // 槽位缺失时按脚本初始化
  if (!(A.items || []).length && (p.artifacts.script.shots || []).length) {
    A.items = p.artifacts.script.shots.map((s, i) => ({ title: s.idea || `${isImg ? "图" : "分镜"}${i + 1}`, visual: s.visual || "", prompt: "", assetId: null, status: "idle" }));
    save("productions");
  }

  function syncImageFactoryDraft() {
    if (!isImg) return;
    const brief = $("#imgBrief", root);
    const count = $("#imgCount", root);
    const product = $("#imgProduct", root);
    const onlineTrends = $("#imgOnlineTrends", root);
    if (brief) {
      S.direction = brief.value.trim();
      if (S.direction) p.topic = S.direction.slice(0, 80);
    }
    if (count) S.imageCount = Math.max(3, Math.min(12, parseInt(count.value, 10) || S.imageCount || DEFAULT_XHS_IMAGE_COUNT));
    if (product) S.productId = product.value || S.productId || "dumate";
    if (onlineTrends) S.useOnlineTrends = !!onlineTrends.checked;
  }

  const draw = () => {
    syncImageFactoryDraft();
    const items = A.items || [];
    const got = items.filter(x => x.assetId).length;
    const refs = refAssetsOf(A);
    const flowTitle = isImg
      ? (genMode === "in" ? "创作内容 → 图卡结构 → 站内生成" : "创作内容 → 图卡结构 → 站外上传")
      : "按脚本逐镜头出分镜图";
    root.innerHTML = `
      ${stepperHtml(p, page)}
      <div class="chain-page solo">
        <div class="chain-main">
          <div class="page-head">
            <div><div class="eyebrow">${isImg ? "图文链路 · 图片工坊" : "视频链路 · 分镜图"}</div>
            <h2>${flowTitle} <span class="head-count">${got}/${items.length}</span></h2></div>
            <div class="head-actions">
              ${isImg ? "" : `<button class="btn ghost" id="cbSkip">跳过此步 ${icon("arrowRight", 13)}</button>`}
              <button class="btn primary" id="cbNext">下一步：${isImg ? "文案" : "提示词"} ${icon("arrowRight", 14)}</button>
            </div>
          </div>

          ${isImg ? `
          <div class="img-factory card">
            <div class="imgf-head">
              <div><b>${icon("image", 14)} 图片工坊</b><em>直接在这里填创作内容、选择产品和张数；不再单独走脚本节点</em></div>
              <button class="btn gen" id="imgFactoryGen">${icon("spark", 15)} 生成图卡结构与提示词</button>
            </div>
            <div class="imgf-grid">
              <label class="field">宣传产品
                <select class="input" id="imgProduct">
                  ${products.map(x => `<option value="${esc(x.id)}" ${S.productId === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}
                </select>
              </label>
              <label class="field">生成张数
                <input class="input" id="imgCount" type="number" min="3" max="12" value="${esc(S.imageCount || DEFAULT_XHS_IMAGE_COUNT)}" />
              </label>
              <label class="field imgf-trend-field">热门参考
                <span class="trend-switch"><input id="imgOnlineTrends" type="checkbox" ${S.useOnlineTrends ? "checked" : ""} /><b>联网参考小红书</b></span>
              </label>
              <label class="field full">创作内容
                <textarea class="input" id="imgBrief" rows="4" placeholder="写得具体一点：这篇笔记想讲什么、面向谁、希望每张图大概覆盖哪些点。留空则按产品功能和账号创作风格生成。">${esc(S.direction || p.topic || "")}</textarea>
              </label>
            </div>
            ${acc.imagePromptTemplate ? `<div class="imgf-note">${icon("checkCircle", 13)} 已启用该账号固定图文模板，张数、产品和本次内容会自动替换。</div>` : `<div class="imgf-note muted">未配置固定模板时，按产品功能、本次内容和账号创作风格生成。</div>`}
          </div>` : ""}

          <div class="refbar card" id="cbRefbar">
            <div class="refbar-left">
              <b>${icon("star", 13)} 统一参考图</b>
              <em>每张图生成 / 站外出图都带上它（最多 5 张：logo / 角色版 / 界面截图）· 可拖图到此</em>
            </div>
            <div class="refbar-chip">${refs.length
              ? refs.map(a => `<span class="ref-chip">${thumbHtml(a)}<span>${esc(a.name)}</span><button class="ref-x" data-ref-rm="${a.id}">${icon("x", 11)}</button></span>`).join("")
              : `<span class="muted">未设置（建议）</span>`}</div>
            <div class="refbar-actions">
              <button class="btn ghost sm" id="cbRefPick">从资产选择</button>
              <label class="btn ghost sm">上传<input type="file" accept="image/*" multiple hidden id="cbRefUp" /></label>
            </div>
          </div>
          <div id="cbRefChooser" class="ref-chooser card" hidden></div>

          ${isImg ? `
          <div class="generation-toolbar card">
            <div class="mode-tabs image-mode-tabs" data-active="${genMode}">
              <button class="mode-tab ${genMode === "in" ? "is-active" : ""}" data-mode="in">站内生成<span>${imageApiConfigured() ? "已接图片 API" : "图片 API 未接"}</span></button>
              <button class="mode-tab ${genMode === "out" ? "is-active" : ""}" data-mode="out">站外上传<span>整段提示词 · 第三方生成后上传</span></button>
            </div>
            <div class="generation-actions">
              ${genMode === "in"
                ? `<button class="btn gen" id="cbGenAllImages">${icon("spark", 15)} 一键生成全部图片</button>`
                : `<span class="muted">复制整段提示词后上传成图</span>`}
            </div>
          </div>` : `
          <div class="mode-tabs" data-active="${genMode}">
            <button class="mode-tab ${genMode === "in" ? "is-active" : ""}" data-mode="in">站内生成<span>${imageApiConfigured() ? "已接图片 API" : "图片 API 未接"}</span></button>
            <button class="mode-tab ${genMode === "out" ? "is-active" : ""}" data-mode="out">站外出图<span>整段提示词 · 第三方生成上传</span></button>
          </div>`}

          ${genMode === "out" ? `
          <div class="external-panel card">
            <div class="ep-head">
            <div><b>一整段可复制提示词</b><em class="muted">复制后配合参考图粘贴到第三方图片模型，生成后上传到下方槽位</em></div>
              <div class="head-actions">
                <button class="btn ghost sm" id="cbEpRefresh">${icon("refresh", 13)} ${isImg ? "按图卡结构重组" : "按脚本重组"}</button>
                <button class="btn primary sm" id="cbEpCopy">${icon("copy", 13)} 复制整段</button>
              </div>
            </div>
            <div class="ep-prompt" id="cbEpText" contenteditable="true">${esc(A.externalPrompt || "")}</div>
            <div class="ep-return" id="cbDrop">
              <div class="epd-core">${icon("upload", 20)}</div>
              <div class="epd-text"><b>等待上传<i class="dots"><i>.</i><i>.</i><i>.</i></i></b><em>把生成的图拖进来或点击选择（多选）· 按顺序对应${isImg ? "图" : "分镜"} 1、2、3…并自动入库</em></div>
              <input type="file" accept="image/*" multiple hidden id="cbDropInput" />
            </div>
          </div>` : `
          ${isImg ? "" : `<div class="inhouse-controls">
            <button class="btn gen" id="cbGenPrompts">${icon("spark", 15)} 按脚本生成分镜图提示词</button>
            <span class="muted">${imageApiConfigured() ? "" : "图片 API 未接入"}</span>
          </div>`}`}

          <div class="slot-cards" id="cbCards">${items.map((it, i) => slotCard(it, i, isImg)).join("") ||
            `<div class="empty-state slim">${icon("image", 22)}<b>${isImg ? "先在上方图片工坊生成图卡结构" : "先回脚本页生成脚本"}</b><p>每${isImg ? "张图" : "个镜头"}会在这里生成一个出图槽位</p></div>`}</div>
        </div>
      </div>`;
    wireStepper(root);
    wire();
  };

  function slotCard(it, i, img) {
    const u = it.assetId ? urlFor(it.assetId) : null;
    const refined = img && it.assetId;
    const loading = it.status === "loading";
    const shownPrompt = img ? normalizeImageWorkshopText(it.prompt || "") : (it.prompt || "");
    const shownVisual = img ? normalizeImageWorkshopText(it.visual || "") : (it.visual || "");
    return `<div class="slot-card card ${img ? "is-image-slot" : ""} ${loading ? "is-generating" : ""}" data-slot="${i}">
      <span class="sc-num">${i + 1}</span>
      <div class="sc-text">
        <div class="sc-line">${esc(it.title || "")}<em>${esc(shownVisual.slice(0, 60))}</em></div>
        <div class="sc-prompt" contenteditable="true" data-prompt="${i}" data-ph="${genMode === "in" ? "点右侧按钮生成图片，或手写提示词" : "（站外模式以整段提示词为准，可单独补充）"}">${esc(shownPrompt)}</div>
        ${it.error ? `<div class="sc-error">${esc(it.error)}</div>` : ""}
      </div>
      <div class="sc-thumb" data-thumb="${i}">
        ${u ? `<img src="${u}"/>` : it.status === "loading"
          ? `<div class="sc-loading"><span class="spin-dot"></span></div>`
          : it.status === "done" ? `<div class="sc-empty">待图片</div>`
          : `<div class="sc-empty"><span>3:4</span><em>待生成</em></div>`}
        ${refined ? `<span class="sc-badge">已精修</span>` : ""}
      </div>
      <div class="sc-side">
        ${genMode === "in" ? `<button class="btn ghost sm" data-gen="${i}">${u || it.status === "done" ? "重新生成" : "生成此图"}</button>` : ""}
        <label class="btn ghost sm">上传<input type="file" accept="image/*" hidden data-up="${i}" /></label>
      </div>
    </div>`;
  }

  const routePage = isImg ? "images" : "boards";
  const canRedrawCurrent = () => {
    const r = currentRoute();
    return root.isConnected && r.zone === "studio" && r.page === routePage && state.ui.activeProductionId === p.id;
  };

  function startImageRun(mode, index = null) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    A.imageRun = { token, mode, index, startedAt: Date.now() };
    return token;
  }

  function imageRunActive(token, mode = "") {
    if (!token) return true;
    return A.imageRun?.token === token && (!mode || A.imageRun.mode === mode);
  }

  function clearOtherLoadingSlots(index) {
    (A.items || []).forEach((x, j) => {
      if (j !== index && x.status === "loading" && !x.assetId) {
        x.status = "idle";
        x.error = "";
      }
    });
  }

  function wire() {
    if (isImg) {
      $("#imgProduct", root)?.addEventListener("change", e => { S.productId = e.target.value || "dumate"; save("productions"); });
      $("#imgCount", root)?.addEventListener("input", e => {
        S.imageCount = Math.max(3, Math.min(12, parseInt(e.target.value, 10) || DEFAULT_XHS_IMAGE_COUNT));
        save("productions");
      });
      $("#imgBrief", root)?.addEventListener("input", e => { S.direction = e.target.value; if (S.direction.trim()) p.topic = S.direction.trim().slice(0, 80); save("productions"); });
      $("#imgBrief", root)?.addEventListener("blur", e => { S.direction = e.target.value.trim(); if (S.direction) p.topic = S.direction.slice(0, 80); save("productions"); });
      $("#imgOnlineTrends", root)?.addEventListener("change", e => { S.useOnlineTrends = !!e.target.checked; save("productions"); });
      $("#imgFactoryGen", root)?.addEventListener("click", e => withLoading(e.currentTarget, generateImageWorkshop, "生成中…"));
    }

    // 模式切换
    $$(".mode-tab", root).forEach(t => t.addEventListener("click", () => {
      syncImageFactoryDraft();
      genMode = t.dataset.mode; modeBySlot.set(p.id, genMode);
      if (genMode === "out" && !A.externalPrompt) rebuildExternal();
      draw();
    }));

    // 统一参考
    const refbar = $("#cbRefbar", root);
    wireDropZone(refbar, async files => { await setRefsFromFiles(files); });
    $$("[data-ref-rm]", root).forEach(btn => btn.addEventListener("click", () => {
      syncImageFactoryDraft();
      setRefIds(A, refIdsOf(A).filter(id => id !== btn.dataset.refRm));
      save("productions"); draw();
    }));
    $("#cbRefUp", root).addEventListener("change", async e => { syncImageFactoryDraft(); await setRefsFromFiles(e.target.files); e.target.value = ""; });
    $("#cbRefPick", root).addEventListener("click", () => {
      const box = $("#cbRefChooser", root);
      if (!box.hidden) { box.hidden = true; return; }
      const assets = accountAssets(acc.id).filter(a => a.type === "图片");
      box.innerHTML = assets.length ? `<div class="ref-grid">${assets.map(a => `
        <div class="ref-item ${refIdsOf(A).includes(a.id) ? "is-picked" : ""}" data-ref="${a.id}" role="button" tabindex="0">${thumbHtml(a)}<span>${esc(a.name)}</span>${/(已发布生成图|站内生成|笔记图)/.test((a.tags || []).join(" ")) ? "" : `<button class="ref-del" data-ref-del="${a.id}" title="删除参考图">${icon("trash", 11)}</button>`}</div>`).join("")}</div>`
        : `<div class="muted" style="padding:10px">该账号还没有图片资产，先上传一张</div>`;
      box.hidden = false;
      box.querySelectorAll("[data-ref-del]").forEach(b => b.addEventListener("click", async e => {
        e.stopPropagation();
        const a = state.assets.find(x => x.id === b.dataset.refDel);
        const ok = await confirmModal({ title: `删除参考图「${a?.name || "未命名图片"}」？`, body: "会从资产库移除，并从当前参考图选择中摘掉。", danger: true, okText: "删除" });
        if (!ok) return;
        syncImageFactoryDraft();
        setRefIds(A, refIdsOf(A).filter(id => id !== b.dataset.refDel));
        await removeAsset(b.dataset.refDel);
        save("productions");
        draw();
      }));
      box.querySelectorAll("[data-ref]").forEach(b => b.addEventListener("click", () => {
        syncImageFactoryDraft();
        appendRefId(A, b.dataset.ref); save("productions"); draw();
      }));
    });

    async function setRefsFromFiles(files) {
      syncImageFactoryDraft();
      const imgs = Array.from(files || []).filter(f => f && f.type.startsWith("image/"));
      if (!imgs.length) return;
      for (const f of imgs.slice(0, MAX_IMAGE_REFS)) {
        if (refIdsOf(A).length >= MAX_IMAGE_REFS) break;
        const dataUrl = await fileToDataUrl(f);
        const a = await addAssetFromDataUrl(acc.id, { name: f.name.replace(/\.[^.]+$/, ""), tags: ["参考图"], dataUrl });
        appendRefId(A, a.id);
      }
      save("productions");
      toast(`已添加 ${refIdsOf(A).length}/${MAX_IMAGE_REFS} 张统一参考图`);
      draw();
    }

    // 站外面板
    if (genMode === "out") {
      $("#cbEpRefresh", root).addEventListener("click", () => { rebuildExternal(); draw(); toast("已按当前脚本重新组装"); });
      $("#cbEpCopy", root).addEventListener("click", () => copyText($("#cbEpText", root).textContent, "已复制整段提示词，去第三方模型粘贴即可"));
      $("#cbEpText", root).addEventListener("blur", () => { A.externalPrompt = $("#cbEpText", root).textContent; save("productions"); });
      const dz = $("#cbDrop", root);
      wireDropZone(dz, files => handleReturn(files));
      dz.addEventListener("click", () => $("#cbDropInput", root).click());
      $("#cbDropInput", root).addEventListener("change", e => { handleReturn(e.target.files); e.target.value = ""; });
    } else {
      $("#cbGenAllImages", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
        const runToken = startImageRun("all");
        const items = A.items || [];
        if (!items.length) {
          await generateImageWorkshop();
        }
        const fresh = A.items || [];
        if (!fresh.length) { toast("还没有可生成的图卡"); return; }
        if (!imageApiConfigured()) { toast("图片 API 未接入，请先配置站内图片服务，或切到站外上传", "error"); return; }
        fresh.forEach(x => {
          if (imageRunActive(runToken, "all") && x.prompt && !x.assetId) {
            x.status = "loading";
            x.error = "";
          }
        });
        save("productions");
        if (canRedrawCurrent()) draw();
        let ok = 0;
        for (let i = 0; i < fresh.length; i++) {
          if (!imageRunActive(runToken, "all")) {
            toast("已切换为单张生成，停止全量队列");
            return;
          }
          if (!fresh[i].prompt) continue;
          await generateOneImage(i, { redraw: true, silent: true, runToken, runMode: "all" });
          if (fresh[i].assetId) ok++;
        }
        if (!imageRunActive(runToken, "all")) return;
        save("productions");
        if (canRedrawCurrent()) draw();
        toast(ok ? `已生成 ${ok}/${fresh.length} 张图片` : "没有图片生成成功，请检查错误提示", ok ? "" : "error");
      }, "生成图片中…"));

      $("#cbGenPrompts", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
        const shots = p.artifacts.script.shots || [];
        if (!shots.length) { toast(isImg ? "先在图片工坊生成图卡结构" : "先回脚本页生成脚本"); return; }
        const sharedRefs = refAssetsOf(A);
        if (isImg) {
          const styleRef = acc.imageStyleAssetId ? state.assets.find(x => x.id === acc.imageStyleAssetId) : null;
          const res = await AI.generateImagePrompts({
            script: shotsToText(shots, true),
            account: acc,
            style: p.artifacts.script.style,
            imageTemplate: acc.imagePromptTemplate || "",
            styleRefName: refNamesOf(A, [styleRef?.name]).join("、"),
            imageCount: p.artifacts.script.imageCount || (A.items || []).length || shots.length || DEFAULT_XHS_IMAGE_COUNT,
            product: productById(p.artifacts.script.productId),
            topic: p.topic
          });
          A.items = (res.shots || []).map((s, i) => ({
            title: s.title || `图${i + 1}`, visual: (shots[i] || {}).visual || "", prompt: s.prompt || "", ui: !!s.ui,
            assetId: (A.items[i] || {}).assetId || null, status: (A.items[i] || {}).assetId ? "done" : "idle"
          }));
        } else {
          const res = await AI.generateStoryboardPrompts({ shots, account: acc, style: p.artifacts.script.style, sharedRefName: sharedRefs.map(x => x.name).join("、"), product: productById(p.artifacts.script.productId || "dumate") });
          A.items = shots.map((s, i) => ({
            title: s.idea || `分镜${i + 1}`, visual: s.visual || "",
            prompt: (res.shots[i] || {}).prompt || AI.fallbackStoryboardPrompt(s, acc, p.artifacts.script.style, sharedRefs.map(x => x.name).join("、")),
            assetId: (A.items[i] || {}).assetId || null, status: (A.items[i] || {}).assetId ? "done" : "idle"
          }));
        }
        save("productions");
        draw();
        toast(AI.sourceNote(`已生成 ${A.items.length} 条提示词`));
      }, "生成中…"));
    }

    // 槽位编辑/上传/站内生成
    $$("[data-prompt]", root).forEach(el => el.addEventListener("blur", () => {
      const it = A.items[+el.dataset.prompt];
      if (it) { it.prompt = el.textContent.trim(); save("productions"); }
    }));
    $$("[data-up]", root).forEach(inp => inp.addEventListener("change", async e => {
      const f = e.target.files[0]; if (!f) return;
      await fillSlot(+inp.dataset.up, f);
      draw();
    }));
    $$("[data-gen]", root).forEach(b => b.addEventListener("click", async e => {
      e.preventDefault();
      e.stopPropagation();
      const index = +b.dataset.gen;
      const runToken = startImageRun("single", index);
      clearOtherLoadingSlots(index);
      save("productions");
      if (canRedrawCurrent()) draw();
      await generateOneImage(index, { single: true, runToken, runMode: "single" });
    }));
    $$(".sc-thumb img", root).forEach(im => im.addEventListener("click", () => openLightbox(im, im.src, "")));

    // 下一步
    $("#cbNext", root).addEventListener("click", () => {
      const items = A.items || [];
      const got = items.filter(x => x.assetId).length;
      if (isImg) {
        if (!got) { toast("还没有上传任何成图（至少上传 1 张）"); return; }
        if (p.stage === "images") setStage(p, "copy", "pending");
        go("studio", "copy");
      } else {
        if (p.stage === "boards" && got === items.length && items.length) maybeAdvanceAfterInput(p);
        else if (p.stage === "boards") setStage(p, "prompts", (p.artifacts.prompts || []).length ? "done" : "pending");
        go("studio", "prompts");
      }
    });
    const skip = $("#cbSkip", root);
    if (skip) skip.addEventListener("click", () => {
      if (p.stage === "boards") setStage(p, "prompts", "pending");
      go("studio", "prompts");
    });
  }

  async function fillSlot(i, file) {
    const it = A.items[i]; if (!it) return;
    let dataUrl = await fileToDataUrl(file);
    if (isImg) dataUrl = await polishImageForPublish(dataUrl, `${p.id}-${i}-${it.title || ""}-${p.topic || ""}`);
    if (it.assetId) {
      await replaceAssetBlob(it.assetId, dataUrl);
      if (isImg) {
        const asset = state.assets.find(a => a.id === it.assetId);
        if (asset) asset.tags = Array.from(new Set([...(asset.tags || []), "笔记图", "发布前精修"]));
        save("assets");
      }
    } else {
      const a = await addAssetFromDataUrl(acc.id, {
        name: `${isImg ? "笔记图" : "分镜图"}${String(i + 1).padStart(2, "0")}_${(p.title || p.topic || "").slice(0, 6)}`,
        tags: isImg ? ["笔记图", "发布前精修"] : ["分镜图"], dataUrl
      });
      it.assetId = a.id;
    }
    it.status = "done";
    save("productions");
    const complete = (A.items || []).every(x => x.assetId);
    if (complete && p.stageStatus === "needs_input") maybeAdvanceAfterInput(p);
    toast(`${isImg ? "已上传并完成发布前精修" : "已上传"} ${i + 1}/${A.items.length}${complete ? " ✓ 全部就位" : ""}`);
  }

  async function generateOneImage(i, opts = {}) {
    const { redraw = true, silent = false, single = false, runToken = "", runMode = "" } = opts;
    if (!imageRunActive(runToken, runMode)) return;
    const it = A.items[i];
    if (!it) return;
    if (!it.prompt && isImg) {
      if (single) {
        toast("这张图还没有提示词，先点「生成图卡结构与提示词」");
        return;
      }
      await generateImageWorkshop();
    }
    const fresh = A.items[i];
    if (!fresh || !fresh.prompt) { toast("这张图还没有提示词，先生成图卡结构"); return; }
    if (!imageRunActive(runToken, runMode)) return;
    if (runMode === "single") clearOtherLoadingSlots(i);
    fresh.status = "loading";
    fresh.error = "";
    if (redraw && canRedrawCurrent()) draw();
    try {
      const provider = activeProviderFor("image");
      const key = providerKeyFor("image", provider);
      if (!imageApiConfigured() || provider?.mock) {
        throw new Error("图片 API 未接入：请配置服务端 IMAGE_API_KEY/IMAGE_BASE_URL，或切换到站外上传");
      } else {
        const finalPrompt = enrichPromptWithRefs(promptForImageModel(fresh.prompt), A);
        const r = await provider.submit({
          prompt: finalPrompt,
          refs: await providerRefsFor(A),
          ratio: ratioFromImagePrompt(finalPrompt, "3:4"),
          apiKey: key?.secret,
          endpoint: key?.provider,
          model: key?.model || "custom-imagemodel-gt"
        });
        const out = await provider.poll(r.providerRef);
        if (!imageRunActive(runToken, runMode)) return;
        if (out.status !== "succeeded" || !out.output?.dataUrl) throw new Error(out.error || "图片生成未返回结果");
        const dataUrl = out.output.dataUrl.startsWith("data:")
          ? out.output.dataUrl
          : await urlToDataUrl(out.output.dataUrl);
        const polished = isImg ? await polishImageForPublish(dataUrl, `${p.id}-inhouse-${i}-${p.topic || ""}`) : dataUrl;
        const a = await addAssetFromDataUrl(acc.id, {
          name: `站内笔记图${String(i + 1).padStart(2, "0")}_${(fresh.title || p.title || "").slice(0, 10)}`,
          tags: ["笔记图", "站内生成", "发布前精修"],
          dataUrl: polished
        });
        fresh.assetId = a.id;
        fresh.status = "done";
        if (!silent) toast(`第 ${i + 1} 张已生成并精修入库`);
      }
    } catch (e) {
      if (!imageRunActive(runToken, runMode)) return;
      fresh.status = "failed";
      fresh.error = e.message || String(e);
      toast("图片生成失败：" + fresh.error, "error");
    }
    save("productions");
    if (redraw && canRedrawCurrent()) draw();
  }

  async function handleReturn(files) {
    const imgs = Array.from(files).filter(f => f.type.startsWith("image/"));
    if (!imgs.length) return;
    for (const f of imgs) {
      const slot = (A.items || []).findIndex(x => !x.assetId);
      if (slot < 0) {
        let dataUrl = await fileToDataUrl(f);
        if (isImg) dataUrl = await polishImageForPublish(dataUrl, `${p.id}-extra-${f.name}-${p.topic || ""}`);
        await addAssetFromDataUrl(acc.id, { name: `站外${isImg ? "笔记图" : "分镜"}_${f.name.replace(/\.[^.]+$/, "").slice(0, 10)}`, tags: isImg ? ["笔记图", "站外生成", "发布前精修"] : ["分镜图", "站外生成"], dataUrl });
      } else {
        await fillSlot(slot, f);
      }
    }
    if (canRedrawCurrent()) draw();
  }

  function rebuildExternal() {
    const shots = p.artifacts.script.shots || [];
    const sharedRefs = refAssetsOf(A);
    const styleRef = isImg && acc.imageStyleAssetId ? state.assets.find(x => x.id === acc.imageStyleAssetId) : null;
    const product = productById(p.artifacts.script.productId);
    const refNames = refNamesOf(A, [styleRef?.name]);
    A.externalPrompt = isImg
      ? buildImgExternalPrompt({
        topic: p.topic,
        position: acc.position,
        shots,
        items: (A.items || []).filter(x => x.prompt),
        style: p.artifacts.script.style,
        refNames,
        template: acc.imagePromptTemplate || "",
        productName: product?.name || product?.shortName || "",
        imageCount: p.artifacts.script.imageCount || (A.items || []).length || shots.length || DEFAULT_XHS_IMAGE_COUNT
      })
      : buildSbExternalPrompt({ shots, boards: (A.items || []).filter(x => x.prompt), style: p.artifacts.script.style, sharedRefName: sharedRefs.map(x => x.name).join("、") });
    save("productions");
  }

  async function generateImageWorkshop() {
    let brief = ($("#imgBrief", root)?.value || "").trim();
    const count = Math.max(3, Math.min(12, parseInt($("#imgCount", root)?.value, 10) || S.imageCount || DEFAULT_XHS_IMAGE_COUNT));
    S.imageCount = count;
    S.productId = $("#imgProduct", root)?.value || S.productId || "dumate";
    S.productId = primaryProductById(S.productId)?.id || "dumate";
    S.useOnlineTrends = !!$("#imgOnlineTrends", root)?.checked;
    const selectedProduct = productById(S.productId);
    if (!brief) {
      brief = await AI.generateCreativeBrief({ account: acc, product: selectedProduct, imageCount: count, kind: "image", useOnlineTrends: S.useOnlineTrends });
      const input = $("#imgBrief", root); if (input) input.value = brief;
      toast(AI.sourceNote("已随机生成详细创作内容"));
    }
    S.direction = brief;
    const topic = brief || p.topic || `${selectedProduct?.shortName || selectedProduct?.name || "产品"} 图文笔记`;
    p.topic = topic.slice(0, 80);
    const styleRef = acc.imageStyleAssetId ? state.assets.find(x => x.id === acc.imageStyleAssetId) : null;
    const style = acc.styleProfile || S.style || "";
    const trendGuide = await AI.trendGuide({ topic, account: acc, product: selectedProduct, useOnlineTrends: S.useOnlineTrends, kind: "image" });
    const res = await AI.generateScript({
      topic, duration: 0, account: acc, image: true,
      direction: brief || topic,
      style, imageCount: count, product: selectedProduct,
      imageTemplate: acc.imagePromptTemplate || "",
      styleRefName: refNamesOf(A, [styleRef?.name]).join("、"),
      useOnlineTrends: S.useOnlineTrends,
      trendGuide
    });
    S.shots = res.shots || [];
    S.title = res.title || topic;
    S.source = AI.lastSource;
    S.style = style;
    p.title = res.title || topic;
    const promptRes = await AI.generateImagePrompts({
      script: shotsToText(S.shots, true),
      account: acc,
      style,
      imageTemplate: acc.imagePromptTemplate || "",
      styleRefName: refNamesOf(A, [styleRef?.name]).join("、"),
      imageCount: count,
      product: selectedProduct,
      topic,
      useOnlineTrends: S.useOnlineTrends,
      trendGuide
    });
    S.trendGuide = trendGuide;
    const promptRows = promptRes.shots || [];
    A.items = S.shots.map((s, i) => ({
      title: promptRows[i]?.title || `图片${i + 1}`,
      visual: s.visual || "",
      prompt: promptRows[i]?.prompt || "",
      assetId: (A.items[i] || {}).assetId || null,
      status: (A.items[i] || {}).assetId ? "done" : "idle"
    }));
    A.externalPrompt = "";
    rebuildExternal();
    p.stage = "images";
    p.stageStatus = "pending";
    save("productions");
    if (canRedrawCurrent()) draw();
    toast(AI.sourceNote("已生成"));
  }

  if (!A.externalPrompt && (p.artifacts.script.shots || []).length) rebuildExternal();
  draw();
}
