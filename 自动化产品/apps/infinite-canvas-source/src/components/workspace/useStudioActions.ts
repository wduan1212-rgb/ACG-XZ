"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  callAgent,
  callEnhance,
  callGenerate,
  callTransform,
  materializeCanvasAsset,
  persistCanvasBlob,
} from "@/lib/api";
import { bestAssetUrlFor, rememberAssetSource } from "@/lib/assetCache";
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
import { parseCount, prepareSingleImagePrompt } from "@/lib/agent";
import { planReferenceEdits } from "@/lib/referenceEditPlan";
import { runConcurrentQueue } from "@/lib/concurrencyQueue";
import {
  canvasRequestUserMessage,
  isCanvasRequestCancelled,
  throwIfCanvasRequestAborted,
} from "@/lib/request";
import {
  CanvasRequestLifecycle,
  bindCanvasPageLifecycle,
} from "@/lib/requestLifecycle";
import { CANVAS_INTERRUPTED_TASK_TEXT } from "@/lib/canvasPersistence";
import type { PaletteKey } from "@/lib/agent";
import type {
  CanvasItem,
  EnhanceOp,
  EnhanceRunOptions,
  EnhancedItem,
  GenerationItem,
  ImageItem,
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

export function useStudioActions(projectId: string) {
  const addMessage = useStore((s) => s.addMessage);
  const updateMessage = useStore((s) => s.updateMessage);
  const addItem = useStore((s) => s.addItem);
  const updateItem = useStore((s) => s.updateItem);
  const setSelection = useStore((s) => s.setSelection);
  const addTask = useStore((s) => s.addTask);
  const updateTask = useStore((s) => s.updateTask);
  const recordGeneration = useStore((s) => s.recordGeneration);
  const recordFailure = useStore((s) => s.recordFailure);
  const reserveDrafts = useStore((s) => s.reserveDrafts);
  const flushCanvasProjectLocal = useStore((s) => s.flushCanvasProjectLocal);
  const requestLifecycle = useMemo(
    () => new CanvasRequestLifecycle(projectId),
    [projectId],
  );

  useEffect(() => {
    // React Strict Mode intentionally runs setup/cleanup twice in development.
    // Resume with a fresh signal while every previously captured batch signal
    // remains aborted and therefore cannot restart paid work.
    requestLifecycle.resume();
    const unbind = bindCanvasPageLifecycle(requestLifecycle, window);
    return () => {
      unbind();
      requestLifecycle.dispose();
    };
  }, [requestLifecycle]);

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
    async (brief: string, options: { size?: string } = {}) => {
      const state = useStore.getState();
      const project = state.projects.find((p) => p.id === projectId);
      if (!project) return;
      const requestSignal = requestLifecycle.signal;
      if (requestSignal.aborted) return;
      // Homepage handoff may reach this callback before ProjectClient's
      // enterProject effect has copied targetSize into the shared composer.
      // An explicit handoff size is authoritative only for that first request;
      // normal in-workspace requests continue to use the live composer value.
      const size = options.size || state.composerSize || project.targetSize;
      const target = parseSize(size) ?? { width: 1080, height: 1920 };
      const targetSize = `${target.width}x${target.height}`;
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
      const referenceImageById = new Map<string, string>();
      for (const r of references) {
        const it = items.find((i) => i.id === r.itemId);
        if (!it || !isImageItem(it)) continue;
        let u = bestAssetUrlFor(it);
        try {
          u = await materializeCanvasAsset(u, { signal: requestSignal });
        } catch (error) {
          if (isCanvasRequestCancelled(error)) return;
          // A missing private blob is isolated to this reference. The user can
          // still generate from the remaining prompt and healthy references.
          continue;
        }
        if (!u.startsWith("data:image/") || u.startsWith("data:image/svg")) continue;
        try {
          const image = (await downscaleDataUrl(u, 1280, 0.85)).dataUrl;
          refUrls.push(image);
          referenceImageById.set(r.itemId, image);
          agentImages.push((await downscaleDataUrl(u, 512, 0.75)).dataUrl);
        } catch {
          refUrls.push(u);
          referenceImageById.set(r.itemId, u);
        }
      }
      const referenceEditPlan = planReferenceEdits(brief, references.length);

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

      const editTargets = (referenceEditPlan?.targetIndexes ?? [])
        .map((index) => ({ index, reference: references[index] }))
        .map(({ index, reference }) => ({
          index,
          source: reference ? items.find((item) => item.id === reference.itemId) : undefined,
        }))
        .filter((target): target is { index: number; source: ImageItem } => !!target.source && isImageItem(target.source));

      if (referenceEditPlan && editTargets.length > 0) {
        const targetNames = editTargets.map(({ index }) => `图 ${index + 1}`).join("、");
        const isParallel = editTargets.length > 1;
        const makeEditPlaceholder = (source: ImageItem, index: number) => {
          const cur = (useStore.getState().itemsByProject[projectId] ?? []).filter((item) => !item.hidden);
          const fp = footprintFor(target.width, target.height, 340);
          const position = findFreeSpot(
            cur,
            { x: source.position.x + source.size.width + 40, y: source.position.y },
            fp,
            28,
          );
          const id = uid("item");
          addItem(projectId, {
            id,
            projectId,
            type: "generation",
            position,
            size: fp,
            z: source.z + 1,
            createdAt: Date.now(),
            assetUrl: "",
            naturalWidth: target.width,
            naturalHeight: target.height,
            label: `图 ${index + 1} · 编辑中`,
            mode: "final",
            quality: POSTER_QUALITY,
            jobId: id,
            loading: true,
            generationStatus: "queued",
            queuePosition: index + 1,
            queueTotal: editTargets.length,
            provenance: {
              brief,
              references,
              fromItemId: source.id,
              targetedReferenceIndex: index + 1,
            },
          } as GenerationItem);
          return id;
        };

        const jobs = editTargets.map(({ source, index }) => ({
          source,
          index,
          id: makeEditPlaceholder(source, index),
          task: startTask("generate", `编辑图 ${index + 1}`),
        }));
        setSelection(jobs.map((job) => job.id));
        updateMessage(projectId, agentMsgId, {
          text: isParallel
            ? `已识别为同时编辑 ${targetNames}：会为每张图建立独立并发任务，并保留未指定的内容。`
            : `已识别为只编辑 ${targetNames}：其余已选图片仅作为视觉参照，不会单独生成。`,
          status: "thinking",
        });

        const results = await runConcurrentQueue(
          jobs.map((job) => async () => {
              const sourceImage =
                referenceImageById.get(job.source.id) ??
                (await downscaleDataUrl(bestAssetUrlFor(job.source), 1280, 0.85)).dataUrl;
              const styleReferences = [...referenceImageById.entries()]
                .filter(([itemId]) => itemId !== job.source.id)
                .map(([, image]) => image)
                .slice(0, 7);
              throwIfCanvasRequestAborted(requestSignal, "图片编辑");
              const image = await callTransform({
                image: sourceImage,
                references: styleReferences,
                // A single-image edit is already unambiguous from the selected
                // reference. Preserve the user's wording exactly; multi-image
                // role separation is handled by the transform endpoint.
                prompt: brief.trim(),
                size: targetSize,
                fidelity: "high",
                quality: POSTER_QUALITY,
                idempotencyKey: job.id,
              }, { signal: requestSignal });
              throwIfCanvasRequestAborted(requestSignal, "图片持久化");
              const persisted = await persistCanvasBlob(image.dataUrl, job.id, {
                generationReceipt: image.generationReceipt,
                signal: requestSignal,
              });
              rememberAssetSource(job.id, image.dataUrl);
              updateItem(projectId, job.id, {
                assetUrl: persisted.assetUrl,
                outputId: persisted.outputId,
                naturalWidth: image.width,
                naturalHeight: image.height,
                label: `图 ${job.index + 1} · 已按指令编辑`,
                loading: false,
                generationStatus: "done",
                error: undefined,
              } as Partial<CanvasItem>);
              await flushCanvasProjectLocal(projectId);
              job.task.stop({
                status: "completed",
                progress: 1,
                cost: QUALITY_COST[POSTER_QUALITY],
                resultItemIds: [job.id],
                label: `图 ${job.index + 1} · 已完成`,
              });
              return job.id;
          }),
          {
            limit: 3,
            onStart: (index) => {
              const job = jobs[index];
              updateItem(projectId, job.id, {
                label: `图 ${job.index + 1} · 编辑中`,
                generationStatus: "running",
              } as Partial<CanvasItem>);
            },
          },
        );

        const completed = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const failed: number[] = [];
        const interrupted: number[] = [];
        results.forEach((result, index) => {
          if (result.status !== "rejected") return;
          const job = jobs[index];
          const cancelled = isCanvasRequestCancelled(result.reason);
          const error = cancelled
            ? CANVAS_INTERRUPTED_TASK_TEXT
            : canvasRequestUserMessage(result.reason);
          (cancelled ? interrupted : failed).push(job.index);
          updateItem(projectId, job.id, {
            loading: false,
            generationStatus: cancelled ? "interrupted" : "failed",
            label: cancelled ? CANVAS_INTERRUPTED_TASK_TEXT : "编辑失败，可重试",
            error,
          } as Partial<CanvasItem>);
          job.task.stop({
            status: "failed",
            progress: 1,
            error,
            label: cancelled
              ? `图 ${job.index + 1} · 已中断`
              : `图 ${job.index + 1} · 编辑失败`,
          });
        });
        if (failed.length || interrupted.length) await flushCanvasProjectLocal(projectId);

        if (completed.length > 0) {
          const cost = +(QUALITY_COST[POSTER_QUALITY] * completed.length).toFixed(4);
          recordGeneration(projectId, cost, completed.length);
          setSelection(completed);
          updateMessage(projectId, agentMsgId, {
            text:
              failed.length > 0 || interrupted.length > 0
                ? `${targetNames} 已完成 ${completed.length} 张；其余任务${interrupted.length ? "已中断" : "未完成"}，可单独重试。`
                : `${targetNames} 已分别完成定向编辑。每张结果都以自身原图为编辑源，未输出无关新图。`,
            status: failed.length > 0 || interrupted.length > 0 ? "partial" : "done",
            resultItemIds: completed,
          });
        } else {
          setSelection([]);
          updateMessage(projectId, agentMsgId, {
            text: interrupted.length && !failed.length
              ? CANVAS_INTERRUPTED_TASK_TEXT
              : "定向编辑未完成，已保留原参考图且没有产出无关新图，请稍后重试。",
            status: "error",
          });
          if (failed.length) recordFailure(projectId);
        }
        return;
      }

      // Placeholder cards so results "appear" on the canvas while generating.
      const fp = footprintFor(target.width, target.height, 340);
      const makePlaceholder = (position = 1, total = 1): string => {
        const cur = (useStore.getState().itemsByProject[projectId] ?? []).filter((item) => !item.hidden);
        // A new task follows the current content, independent of pan/zoom.
        // Each additional result then advances from the newly enlarged bounds,
        // producing a stable left-to-right sequence instead of a viewport-based
        // spiral that appears random after the user moves the canvas.
        const pos = findFreeSpot(cur, anchorFor(cur), fp, 28);
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
          label: "正在思考",
          mode: "final",
          quality: POSTER_QUALITY,
          jobId: phId,
          loading: true,
          generationStatus: "running",
          queuePosition: position,
          queueTotal: total,
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
              idempotencyKey: agentMsgId,
            }, { signal: requestSignal })
          : {
              palette: "default" as const,
              prompt: brief.trim(),
              negativePrompt: "",
              caption: "已按你的原生提示词直出。",
              count: parseCount(brief),
            };
        const count = Math.max(1, Math.min(10, ar.count ?? 1));
        while (ids.length < count) ids.push(makePlaceholder(ids.length + 1, count));
        ids.forEach((id, index) => {
          updateItem(projectId, id, {
            label: `排队中 ${index + 1}/${count}`,
            loading: true,
            generationStatus: "queued",
            queuePosition: index + 1,
            queueTotal: count,
            error: undefined,
          } as Partial<CanvasItem>);
        });
        setSelection(ids);
        updateMessage(projectId, agentMsgId, {
          text: ar.caption,
          status: "thinking",
          palette: ar.palette,
          genCount: count,
        });

        // Output quantity controls concurrency only. Every upstream image call
        // must describe one complete canvas, otherwise models often interpret
        // “two posters / two styles” as a diptych inside each returned image.
        const singlePrompt = prepareSingleImagePrompt(ar.prompt, count);

        // Agent mode + no user-pinned style → each image takes its own direction.
        const variants =
          agentOn && Array.isArray(ar.variants)
            ? ar.variants
                .filter((v): v is string => typeof v === "string" && !!v.trim())
                .map((v) => prepareSingleImagePrompt(v, count))
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

        // The output count is a queue length, never an upstream burst. Each
        // worker requests exactly one complete image and commits it immediately.
        const startVariant = reserveDrafts(projectId, count);
        const prompts = Array.from(
          { length: count },
          (_, index) => variants[index] || singlePrompt,
        );
        let settledCount = 0;
        const results = await runConcurrentQueue(
          ids.map((id, index) => async () => {
            const usedPrompt = prompts[index];
            throwIfCanvasRequestAborted(requestSignal, "图片生成");
            const images = await callGenerate({
              ...common,
              count: 1,
              startVariant: startVariant + index,
              prompt: usedPrompt,
              idempotencyKey: id,
            }, { signal: requestSignal });
            const image = images[0];
            if (!image?.dataUrl) throw new Error("图片生成未返回结果");
            throwIfCanvasRequestAborted(requestSignal, "图片持久化");
            const persisted = await persistCanvasBlob(image.dataUrl, id, {
              generationReceipt: image.generationReceipt,
              signal: requestSignal,
            });
            rememberAssetSource(id, image.dataUrl);
            updateItem(projectId, id, {
              assetUrl: persisted.assetUrl,
              outputId: persisted.outputId,
              naturalWidth: image.width,
              naturalHeight: image.height,
              label: image.label,
              loading: false,
              generationStatus: "done",
              error: undefined,
              provenance: {
                brief,
                references,
                prompt: usedPrompt,
                negativePrompt: ar.negativePrompt,
                size,
                quality: POSTER_QUALITY,
              },
            } as Partial<CanvasItem>);
            await flushCanvasProjectLocal(projectId);
            return id;
          }),
          {
            limit: 3,
            onStart: (index) => {
              updateItem(projectId, ids[index], {
                label: `生成中 ${index + 1}/${count}`,
                generationStatus: "running",
              } as Partial<CanvasItem>);
            },
            onSettled: () => {
              settledCount += 1;
              updateTask(projectId, task.id, {
                progress: Math.max(0.08, settledCount / count),
              });
            },
          },
        );
        const done = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const failures: string[] = [];
        const interrupted: string[] = [];
        results.forEach((result, index) => {
          if (result.status !== "rejected") return;
          const cancelled = isCanvasRequestCancelled(result.reason);
          const message = cancelled
            ? CANVAS_INTERRUPTED_TASK_TEXT
            : canvasRequestUserMessage(result.reason);
          (cancelled ? interrupted : failures).push(message);
          updateItem(projectId, ids[index], {
            loading: false,
            generationStatus: cancelled ? "interrupted" : "failed",
            label: cancelled ? CANVAS_INTERRUPTED_TASK_TEXT : "生成失败，可重试",
            error: message,
          } as Partial<CanvasItem>);
        });
        if (failures.length || interrupted.length) await flushCanvasProjectLocal(projectId);

        updateMessage(projectId, agentMsgId, {
          text: done.length === count
            ? ar.caption
            : done.length > 0
              ? `${ar.caption}\n已完成 ${done.length}/${count} 张，其余可单独重试。`
              : interrupted.length && !failures.length
                ? CANVAS_INTERRUPTED_TASK_TEXT
                : `本轮 ${count} 张均未完成：${failures[0] || "请稍后重试"}`,
          status: done.length === count ? "done" : done.length > 0 ? "partial" : "error",
          palette: ar.palette,
          plan: {
            prompt: singlePrompt,
            negativePrompt: ar.negativePrompt,
            referenceUsage: references.length ? `${references.length} 张参考图` : "",
            size,
            quality: POSTER_QUALITY,
          },
          resultItemIds: done,
        });

        if (done.length > 0) {
          const cost = +(QUALITY_COST[POSTER_QUALITY] * done.length).toFixed(4);
          recordGeneration(projectId, cost, done.length);
          setSelection(done);
          task.stop({
            status: done.length === count ? "completed" : "partial",
            progress: 1,
            cost,
            error: failures[0] || (interrupted.length ? CANVAS_INTERRUPTED_TASK_TEXT : undefined),
            resultItemIds: done,
            label: done.length === count
              ? `已生成 ${done.length} 张 · ${size}`
              : `部分完成 ${done.length}/${count} 张 · ${size}`,
          });
          if (failures.length) recordFailure(projectId);
        } else {
          setSelection(ids);
          task.stop({
            status: "failed",
            progress: 1,
            error: failures[0] || (interrupted.length ? CANVAS_INTERRUPTED_TASK_TEXT : "未返回图片"),
            resultItemIds: [],
            label: interrupted.length && !failures.length
              ? `生成已中断 · ${size}`
              : `生成失败 · ${size}`,
          });
          if (failures.length) recordFailure(projectId);
        }
      } catch (e) {
        const cancelled = isCanvasRequestCancelled(e);
        const message = cancelled
          ? CANVAS_INTERRUPTED_TASK_TEXT
          : canvasRequestUserMessage(e);
        ids.forEach((id) => updateItem(projectId, id, {
          loading: false,
          generationStatus: cancelled ? "interrupted" : "failed",
          label: cancelled ? CANVAS_INTERRUPTED_TASK_TEXT : "生成失败，可重试",
          error: message,
        } as Partial<CanvasItem>));
        await flushCanvasProjectLocal(projectId).catch(() => undefined);
        updateMessage(projectId, agentMsgId, {
          status: "error",
          text: message,
        });
        task.stop({
          status: "failed",
          progress: 1,
          error: message,
          label: cancelled ? `生成已中断 · ${size}` : `生成失败 · ${size}`,
        });
        if (!cancelled) recordFailure(projectId);
      }
    },
    [
      projectId,
      addMessage,
      updateMessage,
      addItem,
      updateItem,
      setSelection,
      startTask,
      reserveDrafts,
      recordGeneration,
      recordFailure,
      flushCanvasProjectLocal,
      updateTask,
      requestLifecycle,
    ],
  );

  /** HD enhance: local faithful sharpen when selected, otherwise API edit enhancement. */
  const enhance = useCallback(
    async (itemId: string, op: EnhanceOp, options: EnhanceRunOptions = {}) => {
      const state = useStore.getState();
      const requestSignal = requestLifecycle.signal;
      if (requestSignal.aborted) return;
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
        generationStatus: "running",
        provenance: {
          enhancedFrom: itemId,
          size: options.targetLabel ? `${options.targetLabel} · ${targetStr}` : targetStr,
        },
      };
      addItem(projectId, placeholder);
      setSelection([id]);

      const task = startTask("enhance", `${mode.label} · ${target.width}×${target.height}`);
      try {
        const sourceUrl = await materializeCanvasAsset(bestAssetUrlFor(src), {
          signal: requestSignal,
        });
        throwIfCanvasRequestAborted(requestSignal, "图片高清");
        const enhanced =
          op === "local2x"
            ? await faithfulSharpenDataUrl(sourceUrl, target.width, target.height)
            : await callEnhance({
                image: sourceUrl,
                size: targetStr,
                quality: "high",
                mode: op,
                idempotencyKey: id,
              }, { signal: requestSignal });
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

        throwIfCanvasRequestAborted(requestSignal, "图片高清");
        const persisted = await persistCanvasBlob(finalImg.dataUrl, id, {
          signal: requestSignal,
        });
        rememberAssetSource(id, finalImg.dataUrl);
        updateItem(projectId, id, {
          assetUrl: persisted.assetUrl,
          outputId: persisted.outputId,
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
          generationStatus: "done",
          error: undefined,
        } as Partial<CanvasItem>);
        await flushCanvasProjectLocal(projectId);

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
        const cancelled = isCanvasRequestCancelled(e);
        const message = cancelled
          ? CANVAS_INTERRUPTED_TASK_TEXT
          : canvasRequestUserMessage(e);
        updateItem(projectId, id, {
          loading: false,
          generationStatus: cancelled ? "interrupted" : "failed",
          label: cancelled ? CANVAS_INTERRUPTED_TASK_TEXT : "高清失败，可重试",
          error: message,
        } as Partial<CanvasItem>);
        await flushCanvasProjectLocal(projectId).catch(() => undefined);
        task.stop({
          status: "failed",
          progress: 1,
          error: message,
          label: cancelled ? "高清已中断" : "高清失败",
        });
        if (!cancelled) recordFailure(projectId);
      }
    },
    [
      projectId,
      startTask,
      addItem,
      updateItem,
      setSelection,
      recordGeneration,
      recordFailure,
      flushCanvasProjectLocal,
      requestLifecycle,
    ],
  );

  return { generate, enhance };
}
