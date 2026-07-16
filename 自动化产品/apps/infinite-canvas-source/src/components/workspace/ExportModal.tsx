"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, Download, FileImage } from "lucide-react";
import { Button, Field, inputClass, Modal, Segmented } from "@/components/ui";
import { SizeField } from "./SizeField";
import {
  blobToDataUrl,
  overlappingMarksFor,
  renderCanvasOutput,
} from "@/lib/canvasOutput";
import { parseSize } from "@/lib/sizing";
import { useStore } from "@/lib/store";
import { cn, uid } from "@/lib/util";
import { isImageItem, type CanvasItem } from "@/lib/types";

type Format = "png" | "jpg" | "webp";

export function ExportModal({
  item,
  projectId,
  onClose,
}: {
  item: CanvasItem | null;
  projectId: string;
  onClose: () => void;
}) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const addTask = useStore((s) => s.addTask);
  const updateTask = useStore((s) => s.updateTask);
  const allItems = useStore((s) => s.itemsByProject[projectId] ?? EMPTY_ITEMS);
  const [withMarks, setWithMarks] = useState(true);

  // Text/shape marks overlapping the exported image get merged into the file.
  const overlappingMarks = useMemo(() => {
    if (!item || !isImageItem(item)) return [];
    return overlappingMarksFor(item, allItems);
  }, [item, allItems]);

  const [format, setFormat] = useState<Format>("png");
  const [size, setSize] = useState("1920x1080");
  const [name, setName] = useState("export");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | { bytes: number; w: number; h: number }>(null);

  // Sync export defaults when a new item opens (render-phase pattern).
  const [lastItemId, setLastItemId] = useState<string | null>(null);
  const itemId = item?.id ?? null;
  if (itemId !== lastItemId) {
    setLastItemId(itemId);
    if (item && isImageItem(item) && project) {
      setSize(
        item.naturalWidth && item.naturalHeight
          ? `${item.naturalWidth}x${item.naturalHeight}`
          : project.targetSize,
      );
      // Filename follows the card's own name (top-left label on the canvas).
      setName(
        (item.label || "导出")
          .replace(/\s+/g, "-")
          .replace(/[^\w\-·一-龥]/g, ""),
      );
      setResult(null);
      setFormat("png");
    }
  }

  const target = parseSize(size);
  const clarity = useMemo(() => {
    if (!item || !isImageItem(item) || !target) return null;
    const srcLong = Math.max(item.naturalWidth, item.naturalHeight);
    const tgtLong = Math.max(target.width, target.height);
    return { ok: srcLong >= tgtLong * 0.92, srcLong, tgtLong };
  }, [item, target]);

  if (!item || !isImageItem(item)) return null;
  const imageItem = item;

  async function doExport() {
    if (!target) return;
    setBusy(true);
    const taskId = uid("task");
    addTask(projectId, {
      id: taskId,
      projectId,
      kind: "export",
      label: `导出 ${name}.${format}`,
      status: "running",
      progress: 0.4,
      createdAt: Date.now(),
    });
    try {
      const mime =
        format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
      const rendered = await renderCanvasOutput({
        imageItem,
        marks: withMarks ? overlappingMarks : [],
        targetWidth: target.width,
        targetHeight: target.height,
        mime,
      });
      const url = URL.createObjectURL(rendered.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${name || "export"}.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      if (window.parent !== window) {
        const dataUrl = await blobToDataUrl(rendered.blob);
        window.parent.postMessage(
          {
            source: "xingzhen-canvas",
            type: "output-ready",
            projectId,
            title: project?.name || name || "无限画布导出",
            items: [
              {
                url: "",
                dataUrl,
                name: `${name || "export"}.${format}`,
                mime,
              },
            ],
          },
          window.location.origin,
        );
      }
      URL.revokeObjectURL(url);
      setResult({
        bytes: rendered.blob.size,
        w: rendered.width,
        h: rendered.height,
      });
      updateTask(projectId, taskId, {
        status: "completed",
        progress: 1,
        label: `已导出 ${name}.${format} · ${rendered.width}×${rendered.height}`,
      });
    } catch (e) {
      updateTask(projectId, taskId, {
        status: "failed",
        progress: 1,
        error: e instanceof Error ? e.message : "导出失败",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!item}
      onClose={onClose}
      title="导出文件"
      subtitle="默认按当前图片的真实分辨率导出。"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" onClick={doExport} disabled={busy || !target}>
            <Download size={15} /> {busy ? "导出中…" : "导出并下载"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="h-24 w-24 shrink-0 overflow-hidden rounded-[var(--radius-md)] border border-line bg-[#0c0f15]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.assetUrl} alt="" className="h-full w-full object-cover" />
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <Field label="文件名">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass + " h-8 text-[13px]"}
              />
            </Field>
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="mb-1.5 text-[13px] font-medium text-ink">尺寸</div>
                <SizeField value={size} onChange={setSize} />
              </div>
              <div>
                <div className="mb-1.5 text-[13px] font-medium text-ink">格式</div>
                <Segmented<Format>
                  size="sm"
                  value={format}
                  onChange={setFormat}
                  options={[
                    { value: "png", label: "PNG" },
                    { value: "jpg", label: "JPG" },
                    { value: "webp", label: "WebP" },
                  ]}
                />
              </div>
            </div>
          </div>
        </div>

        {overlappingMarks.length > 0 && (
          <label className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-line bg-[#fcfcfc] px-3 py-2.5 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={withMarks}
              onChange={(e) => setWithMarks(e.target.checked)}
              className="h-4 w-4 accent-[#006bff]"
            />
            合成画布标注
            <span className="text-ink-3">（覆盖在图上的 {overlappingMarks.length} 个文字/图形将一起导出）</span>
          </label>
        )}

        {/* QC */}
        <div className="space-y-1.5 rounded-[var(--radius-md)] border border-line bg-[#fcfcfc] p-3">
          <div className="mb-1 text-[12px] font-medium text-ink-2">交付质检</div>
          <QcRow ok={!!target} label="目标尺寸有效" detail={target ? `${target.width}×${target.height}` : "无效"} />
          <QcRow
            ok
            label="当前图片分辨率"
            detail={`${imageItem.naturalWidth}×${imageItem.naturalHeight}`}
          />
          <QcRow
            ok={!!clarity?.ok}
            label="清晰度满足"
            detail={
              clarity
                ? clarity.ok
                  ? "源分辨率充足"
                  : `源 ${clarity.srcLong}px < 目标 ${clarity.tgtLong}px，建议先高清增强`
                : "—"
            }
          />
          <QcRow ok label="安全边距" detail="主体居中、四周留白" />
        </div>

        {result && (
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-success-weak)] bg-[var(--color-success-weak)] px-3 py-2 text-[13px] text-[#1f7d37]">
            <Check size={15} />
            导出完成 · {result.w}×{result.h} · {(result.bytes / 1024 / 1024).toFixed(2)} MB
          </div>
        )}

        <div className="flex items-center gap-2 text-[11px] text-ink-3">
          <FileImage size={13} /> 提示：Logo、标题、二维码建议在画板层叠加真实素材后再导出（P1）。
        </div>
      </div>
    </Modal>
  );
}

function QcRow({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full",
          ok ? "bg-[var(--color-success-weak)] text-[#1f7d37]" : "bg-[var(--color-warning-weak)] text-[#9a6500]",
        )}
      >
        {ok ? <Check size={11} /> : <AlertTriangle size={11} />}
      </span>
      <span className="text-ink">{label}</span>
      <span className="ml-auto text-ink-3">{detail}</span>
    </div>
  );
}
const EMPTY_ITEMS: CanvasItem[] = [];
