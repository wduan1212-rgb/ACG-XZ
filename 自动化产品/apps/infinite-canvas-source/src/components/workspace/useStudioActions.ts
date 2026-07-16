"use client";

import { useCallback } from "react";
import { callAgent, callEnhance, callGenerate } from "@/lib/api";
import { bestAssetUrlFor } from "@/lib/assetCache";
import {
  downscaleDataUrl,
  estimateSharpnessDataUrl,
  faithfulSharpenDataUrl,
  upscaleDataUrl,
} from "@/lib/image";
import { ENHANCE_MODES, QUALITY_COST } from "@/lib/constants";
import { anchorFor, findFreeSpot, footprintFor } from "@/lib/geometry";
import { parseSize } from "@/lib/sizing";
import { useStore } from "@/lib/store";
import { uid } from "@/lib/util";
import { isImageItem } from "@/lib/types";
import { parseCount } from "@/lib/agent";
import type { PaletteKey } from "@/lib/agent";
import type {
  CanvasItem,
  EnhanceOp,
  EnhanceRunOptions,
  EnhancedItem,
  GenerationItem,
  Quality,
  QueueTask,
  Size,
} from "@/lib/types";

// "high"/"medium" can take 50–90s on this model; "low" keeps the loop snappy
// (~15–20s) and already looks good. Bump if you want more detail per poster.
const POSTER_QUALITY: Quality = "low";

function labelForItem(itemId: string, items: CanvasItem[]): string {
  const it = items.find((i) => i.id === itemId);
  if (it && isImageItem(it)) return it.label ?? "参考图";
  return "参考图";
}

function visibleAnchorFor(projectId: string, size: Size, items: CanvasItem[]): { x: number; y: number } {
  const host = document.querySelector<HTMLElement>("[data-canvas-host]");
  const vp = useStore.getState().viewportByProject[projectId];
  if (!host || !vp) return anchorFor(items);
  const centerX = (host.clientWidth / 2 - vp.x) / vp.zoom;
  const centerY = (host.clientHeight / 2 - vp.y) / vp.zoom;
  return { x: centerX - size.width / 2, y: centerY - size.height / 2 };
}

export function useStudioActions(projectId: string) {
  const addMessage = useStore((s) => s.addMessage);
  const updateMessage = useStore((s) => s.updateMessage);
  const addItem = useStore((s) => s.addItem);
  const updateItem = useStore((s) => s.updateItem);
  const removeItems = useStore((s) => s.removeItems);
  const setSelection = useStore((s) => s.setSelection);
  const addTask = useStore((s) => s.addTask);
  const updateTask = useStore((s) => s.updateTask);
  const recordGeneration = useStore((s) => s.recordGeneration);
  const recordFailure = useStore((s) => s.recordFailure);
  const reserveDrafts = useStore((s) => s.reserveDrafts);

  const startTask = useCallback(
    (kind: "generate" | "enhance" | "export", label: string) => {
      const id = uid("task");
      addTask(projectId, {
        id,
        projectId,
        kind,
        label,
        status: "running",
        progress: 0.08,
        createdAt: Date.now(),
      });
      let p = 0.08;
      const iv = setInterval(() => {
        p = Math.min(0.92, p + 0.06 + Math.random() * 0.05);
        updateTask(projectId, id, { progress: p });
      }, 300);
      return {
        id,
        stop: (patch: Partial<QueueTask>) => {
          clearInterval(iv);
          updateTask(projectId, id, patch);
        },
      };
    },
    [projectId, addTask, updateTask],
  );

  /** One-shot: request → LLM writes a complete-poster prompt → one image on the canvas. */
  const generate = useCallback(
    async (brief: string) => {
      const state = useStore.getState();
      const project = state.projects.find((p) => p.id === projectId);
      if (!project) return;
      const size = state.composerSize || project.targetSize;
      const items = state.itemsByProject[projectId] ?? [];

      // Effective references: explicit chips first; otherwise the selected image —
      // "select a picture then talk" should just work.
      let references = [...state.references];
      if (references.length === 0) {
        references = state.selection
          .map((sid) => items.find((i) => i.id === sid))
          .filter(
            (i): i is NonNullable<typeof i> =>
              !!i && isImageItem(i) && !!i.assetUrl && !("loading" in i && i.loading),
          )
          .slice(0, 6)
          .map((i) => ({ itemId: i.id, usage: "style" as const }));
      }

      // Downscale refs (≤1280) so multi-MB full-res posters don't break the edit API.
      // Also keep tiny copies (≤512) for a vision-capable LLM to actually see.
      const refUrls: string[] = [];
      const agentImages: string[] = [];
      for (const r of references) {
        const it = items.find((i) => i.id === r.itemId);
        if (!it || !isImageItem(it)) continue;
        const u = it.assetUrl;
        if (!u.startsWith("data:image/") || u.startsWith("data:image/svg")) continue;
        try {
          refUrls.push((await downscaleDataUrl(u, 1280, 0.85)).dataUrl);
          agentImages.push((await downscaleDataUrl(u, 512, 0.75)).dataUrl);
        } catch {
          refUrls.push(u);
        }
      }

      addMessage(projectId, {
        id: uid("msg"),
        role: "user",
        text: brief.trim() || "（生成一版默认海报）",
        createdAt: Date.now(),
        references,
      });
      const agentMsgId = uid("msg");
      addMessage(projectId, {
        id: agentMsgId,
        role: "agent",
        text: "",
        createdAt: Date.now(),
        status: "thinking",
      });

      // Placeholder cards so results "appear" on the canvas while generating.
      const target = parseSize(size) ?? { width: 1080, height: 1920 };
      const fp = footprintFor(target.width, target.height, 340);
      const makePlaceholder = (): string => {
        const cur = (useStore.getState().itemsByProject[projectId] ?? []).filter((item) => !item.hidden);
        const pos = findFreeSpot(cur, visibleAnchorFor(projectId, fp, cur), fp, 28);
        const phId = uid("item");
        const ph: GenerationItem = {
          id: phId,
          projectId,
          type: "generation",
          position: pos,
          size: fp,
          z: 40,
          createdAt: Date.now(),
          assetUrl: "",
          naturalWidth: target.width,
          naturalHeight: target.height,
          label: "生成中",
          mode: "final",
          quality: POSTER_QUALITY,
          jobId: phId,
          loading: true,
          provenance: { brief, references },
        };
        addItem(projectId, ph);
        return phId;
      };
      const agentOn = state.agentEnabled;
      const ids: string[] = [makePlaceholder()];
      setSelection([ids[0]]);

      const task = startTask("generate", `生成 · ${size}`);
      try {
        const refDesc = references.map((r) => ({ label: labelForItem(r.itemId, items) }));
        // Agent off → the user's words ARE the prompt (native mode).
        const ar = agentOn
          ? await callAgent({
              brief,
              scene: project.scene,
              size,
              references: refDesc,
              images: agentImages,
            })
          : {
              palette: "default" as const,
              prompt: brief.trim(),
              negativePrompt: "",
              caption: "已按你的原生提示词直出。",
              count: parseCount(brief),
            };
        const count = Math.max(1, Math.min(10, ar.count ?? 1));
        while (ids.length < count) ids.push(makePlaceholder());

        // Agent mode + no user-pinned style → each image takes its own direction.
        const variants =
          agentOn && Array.isArray(ar.variants)
            ? ar.variants
                .filter((v): v is string => typeof v === "string" && !!v.trim())
                .slice(0, count)
            : [];

        const common = {
          palette: ar.palette as PaletteKey,
          size,
          labelPrefix: "海报",
          mode: "final",
          negativePrompt: ar.negativePrompt,
          quality: POSTER_QUALITY,
          references: refUrls,
        };

        // Full resolution — the API result is the true selected size; no downscale.
        const done: string[] = [];
        const fill = (
          slot: number,
          img: { dataUrl: string; width: number; height: number; label: string },
          usedPrompt: string,
        ) => {
          updateItem(projectId, ids[slot], {
            assetUrl: img.dataUrl,
            naturalWidth: img.width,
            naturalHeight: img.height,
            label: img.label,
            loading: false,
            provenance: {
              brief,
              references,
              prompt: usedPrompt,
              negativePrompt: ar.negativePrompt,
              size,
              quality: POSTER_QUALITY,
            },
          } as Partial<CanvasItem>);
          done.push(ids[slot]);
        };

        if (variants.length > 1) {
          const startV = reserveDrafts(projectId, variants.length);
          // Parallel, progressive: each direction fills its placeholder on arrival.
          await Promise.allSettled(
            variants.map((vp, i) =>
              callGenerate({ ...common, count: 1, startVariant: startV + i, prompt: vp }).then(
                (r) => {
                  if (r[0]) fill(i, r[0], vp);
                },
              ),
            ),
          );
        } else if (count > 1) {
          // Same prompt × N — fire N single-image requests CONCURRENTLY so all
          // placeholders fill in parallel (the API's n>1 is one slow request).
          const startV = reserveDrafts(projectId, count);
          await Promise.allSettled(
            Array.from({ length: count }, (_, i) =>
              callGenerate({ ...common, count: 1, startVariant: startV + i, prompt: ar.prompt }).then(
                (r) => {
                  if (r[0]) fill(i, r[0], ar.prompt);
                },
              ),
            ),
          );
        } else {
          const imgs = await callGenerate({
            ...common,
            count: 1,
            startVariant: reserveDrafts(projectId, 1),
            prompt: ar.prompt,
          });
          imgs.slice(0, ids.length).forEach((img, i) => fill(i, img, ar.prompt));
        }
        if (done.length === 0) throw new Error("未返回图片");
        const doneSet = new Set(done);
        const leftover = ids.filter((x) => !doneSet.has(x));
        if (leftover.length) removeItems(projectId, leftover);

        updateMessage(projectId, agentMsgId, {
          text: ar.caption,
          status: "done",
          palette: ar.palette,
          plan: {
            prompt: ar.prompt,
            negativePrompt: ar.negativePrompt,
            referenceUsage: references.length ? `${references.length} 张参考图` : "",
            size,
            quality: POSTER_QUALITY,
          },
          resultItemIds: done,
        });

        const cost = +(QUALITY_COST[POSTER_QUALITY] * done.length).toFixed(4);
        recordGeneration(projectId, cost, done.length);
        task.stop({
          status: "completed",
          progress: 1,
          cost,
          resultItemIds: done,
          label: `已生成 ${done.length} 张 · ${size}`,
        });
      } catch (e) {
        removeItems(projectId, ids);
        updateMessage(projectId, agentMsgId, {
          status: "error",
          text: "生成失败，请重试。",
        });
        task.stop({
          status: "failed",
          progress: 1,
          error: e instanceof Error ? e.message : "生成失败",
        });
        recordFailure(projectId);
      }
    },
    [
      projectId,
      addMessage,
      updateMessage,
      addItem,
      updateItem,
      removeItems,
      setSelection,
      startTask,
      reserveDrafts,
      recordGeneration,
      recordFailure,
    ],
  );

  /** HD enhance: local faithful sharpen when selected, otherwise API edit enhancement. */
  const enhance = useCallback(
    async (itemId: string, op: EnhanceOp, options: EnhanceRunOptions = {}) => {
      const state = useStore.getState();
      const items = state.itemsByProject[projectId] ?? [];
      const visibleItems = items.filter((item) => !item.hidden);
      const src = items.find((i) => i.id === itemId);
      if (!src || !isImageItem(src)) return;
      const mode = ENHANCE_MODES.find((m) => m.id === op);
      if (!mode) return;

      const modeDefaultTarget: Size =
        op === "airport"
          ? {
              width: src.naturalWidth,
              height: src.naturalHeight,
            }
          : op === "deliver"
          ? parseSize(state.composerSize) ?? {
              width: src.naturalWidth,
              height: src.naturalHeight,
            }
          : {
              width: src.naturalWidth * (op === "4x" ? 4 : 2),
              height: src.naturalHeight * (op === "4x" ? 4 : 2),
            };
      const target: Size =
        options.targetMode === "custom" && options.targetSize
          ? options.targetSize
          : options.targetMode === "original"
            ? { width: src.naturalWidth, height: src.naturalHeight }
            : modeDefaultTarget;
      const targetStr = `${target.width}x${target.height}`;

      const targetAspect = target.width / target.height;
      const sourceAspect = src.size.width / src.size.height;
      const displaySize =
        Math.abs(targetAspect - sourceAspect) < 0.01
          ? { ...src.size }
          : footprintFor(target.width, target.height, 340);
      const anchor = { x: src.position.x + src.size.width + 40, y: src.position.y };
      const pos = findFreeSpot(visibleItems, anchor, displaySize, 28);
      const id = uid("item");
      const placeholder: EnhancedItem = {
        id,
        projectId,
        type: "enhanced",
        position: pos,
        size: displaySize,
        z: src.z + 1,
        createdAt: Date.now(),
        assetUrl: "",
        naturalWidth: target.width,
        naturalHeight: target.height,
        label: `${mode.label} · 生成中`,
        operation: op,
        parentItemId: itemId,
        loading: true,
        provenance: {
          enhancedFrom: itemId,
          size: options.targetLabel ? `${options.targetLabel} · ${targetStr}` : targetStr,
        },
      };
      addItem(projectId, placeholder);
      setSelection([id]);

      const task = startTask("enhance", `${mode.label} · ${target.width}×${target.height}`);
      try {
        const sourceUrl = bestAssetUrlFor(src);
        const enhanced =
          op === "local2x"
            ? await faithfulSharpenDataUrl(sourceUrl, target.width, target.height)
            : await callEnhance({
                image: sourceUrl,
                size: targetStr,
                quality: "high",
                mode: op,
              });
        if (!enhanced) throw new Error("增强失败");
        const normalized =
          op === "local2x"
            ? enhanced
            : await upscaleDataUrl(enhanced.dataUrl, target.width, target.height);
        const finalImg =
          op === "local2x"
            ? normalized
            : await faithfulSharpenDataUrl(normalized.dataUrl, normalized.width, normalized.height);
        const [sharpnessBefore, sharpnessAfter] = await Promise.all([
          estimateSharpnessDataUrl(sourceUrl),
          estimateSharpnessDataUrl(finalImg.dataUrl),
        ]);
        const sharpnessDeltaPct =
          sharpnessBefore > 0
            ? Math.round(((sharpnessAfter - sharpnessBefore) / sharpnessBefore) * 100)
            : 0;

        updateItem(projectId, id, {
          assetUrl: finalImg.dataUrl,
          naturalWidth: finalImg.width,
          naturalHeight: finalImg.height,
          size: displaySize,
          label: `${mode.label} · ${finalImg.width}×${finalImg.height}`,
          provenance: {
            enhancedFrom: itemId,
            size: `${finalImg.width}x${finalImg.height}`,
            enhanceMetrics: {
              sharpnessBefore,
              sharpnessAfter,
              sharpnessDeltaPct,
            },
          },
          loading: false,
        } as Partial<CanvasItem>);

        const cost = op === "local2x" ? 0 : op === "airport" ? 0.18 : op === "4x" ? 0.12 : 0.06;
        recordGeneration(projectId, cost, 0);
        task.stop({
          status: "completed",
          progress: 1,
          cost,
          resultItemIds: [id],
          label: `已高清 · ${finalImg.width}×${finalImg.height}`,
        });
      } catch (e) {
        removeItems(projectId, [id]);
        task.stop({
          status: "failed",
          progress: 1,
          error: e instanceof Error ? e.message : "增强失败",
        });
        recordFailure(projectId);
      }
    },
    [projectId, startTask, addItem, updateItem, removeItems, setSelection, recordGeneration, recordFailure],
  );

  return { generate, enhance };
}
