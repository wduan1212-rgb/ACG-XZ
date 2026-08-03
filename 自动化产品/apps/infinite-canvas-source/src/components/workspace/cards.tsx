"use client";

import { useState, type PointerEvent as RPointerEvent } from "react";
import { Check, Crosshair, Maximize2, MoreHorizontal, ShieldCheck, Sparkles } from "lucide-react";
import { Spinner } from "@/components/ui";
import { useStore } from "@/lib/store";
import type { CanvasItem, ImageItem } from "@/lib/types";

export interface CardCallbacks {
  onUseReference: (item: CanvasItem) => void;
  onPreview: (item: CanvasItem) => void;
  onMenu: (item: CanvasItem, pos: { x: number; y: number }) => void;
}

const stop = (e: RPointerEvent) => e.stopPropagation();

function HoverBar({ item, cb }: { item: CanvasItem; cb: CardCallbacks }) {
  const isImage =
    item.type === "reference" || item.type === "generation" || item.type === "enhanced";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-1.5 opacity-0 transition-opacity group-hover/card:opacity-100">
      {isImage ? (
        <button
          onPointerDown={stop}
          onClick={(e) => {
            e.stopPropagation();
            cb.onUseReference(item);
          }}
          className="pointer-events-auto inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-sm hover:bg-black/70"
        >
          <Crosshair size={12} /> 作为参考
        </button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-1">
        <button
          onPointerDown={stop}
          onClick={(e) => {
            e.stopPropagation();
            cb.onPreview(item);
          }}
          className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm hover:bg-black/70"
          aria-label="放大预览"
        >
          <Maximize2 size={13} />
        </button>
        <button
          onPointerDown={stop}
          onClick={(e) => {
            e.stopPropagation();
            cb.onMenu(item, { x: e.clientX, y: e.clientY });
          }}
          className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm hover:bg-black/70"
          aria-label="更多操作"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    </div>
  );
}

function ImageCardView({
  item,
  cb,
  referenced,
}: {
  item: ImageItem;
  cb: CardCallbacks;
  referenced?: boolean;
}) {
  const publishedItemIds = useStore(
    (state) => state.projects.find((project) => project.id === item.projectId)?.publishedItemIds,
  );
  const isPublished = !!publishedItemIds?.includes(item.id);
  const loading =
    (item.type === "generation" || item.type === "enhanced") && item.loading;
  const generationStatus = item.type === "generation" || item.type === "enhanced"
    ? item.generationStatus
    : undefined;
  const generationError = item.type === "generation" || item.type === "enhanced"
    ? item.error
    : undefined;
  const unavailable = !loading && !item.assetUrl
    && (generationStatus === "failed" || generationStatus === "interrupted");
  const label =
    item.type === "reference" ? item.label ?? "参考图" : item.label;
  const metrics =
    item.type === "enhanced" ? item.provenance.enhanceMetrics : undefined;
  const delta = metrics?.sharpnessDeltaPct ?? 0;

  return (
    <div
      className="group/card relative h-full w-full overflow-hidden bg-transparent"
      onDoubleClick={() => !loading && !!item.assetUrl && cb.onPreview(item)}
    >
      {loading ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[linear-gradient(110deg,#0c0f15,45%,#182338,55%,#0c0f15)] bg-[length:200%_100%] [animation:shimmer_1.6s_infinite]">
          {generationStatus === "queued" ? (
            <span className="h-2 w-2 rounded-full bg-white/60 shadow-[0_0_14px_rgba(255,255,255,0.45)]" />
          ) : (
            <Spinner className="h-5 w-5 text-white/70" />
          )}
          <span className="text-[11px] text-white/70">{label || "生成中"}</span>
        </div>
      ) : unavailable ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[#f7f8fa] px-6 text-center">
          <Sparkles size={18} className="text-ink-3" />
          <span className="text-[12px] font-medium text-ink-2">
            {generationStatus === "interrupted" ? "任务已中断，可重试" : "生成失败，可重试"}
          </span>
          {generationError && (
            <span className="line-clamp-2 text-[10px] text-ink-3">{generationError}</span>
          )}
        </div>
      ) : (
        <>
          {item.assetUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.assetUrl}
              alt={label}
              draggable={false}
              className={
                item.type === "reference"
                  ? "h-full w-full select-none object-cover"
                  : "h-full w-full select-none bg-[#f6f8fb] object-contain"
              }
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[#f7f8fa] text-[11px] text-ink-3">
              暂无图片
            </div>
          )}
          {metrics && (
            <div className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-full bg-white/88 px-2 py-0.5 text-[10px] font-medium text-ink shadow-[var(--shadow-card)] backdrop-blur">
              锐度 {delta >= 0 ? "+" : ""}
              {delta}%
            </div>
          )}
          {referenced && (
            <div className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-ink/85 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
              <Crosshair size={10} /> 参考
            </div>
          )}
          {isPublished && (
            <div
              className="pointer-events-none absolute bottom-1.5 right-1.5 z-10 inline-flex items-center gap-1 rounded-full border border-white/45 bg-[#247a3d]/94 px-2 py-0.5 text-[10px] font-semibold text-white shadow-[0_2px_8px_rgba(0,0,0,0.24)] backdrop-blur-sm"
              role="status"
              aria-label="该图片已提交发布"
              title="该图片已提交发布"
            >
              <Check size={10} strokeWidth={2.4} /> 已发布
            </div>
          )}
          {item.assetUrl && <HoverBar item={item} cb={cb} />}
        </>
      )}
    </div>
  );
}

function BriefCardView({ item }: { item: Extract<CanvasItem, { type: "brief" }> }) {
  const updateItem = useStore((s) => s.updateItem);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  return (
    <div
      className="group/card flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-md)] border-l-2 border-l-accent bg-white"
      onDoubleClick={() => setEditing(true)}
    >
      <div className="px-2.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-accent">
        Brief 需求
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={() => {
            updateItem(item.projectId, item.id, { text } as Partial<CanvasItem>);
            setEditing(false);
          }}
          className="flex-1 resize-none bg-transparent px-2.5 py-1.5 text-[13px] leading-5 text-ink outline-none"
        />
      ) : (
        <div className="flex-1 overflow-hidden px-2.5 py-1.5 text-[13px] leading-5 text-ink-2">
          {item.text || <span className="text-ink-3">双击编辑需求…</span>}
        </div>
      )}
    </div>
  );
}

function ArtboardCardView({ item }: { item: Extract<CanvasItem, { type: "artboard" }> }) {
  return (
    <div className="group/card flex h-full w-full flex-col">
      <div className="flex items-center gap-2 pb-1">
        <span className="text-[11px] font-semibold text-ink">{item.label}</span>
        <span className="font-mono text-[10px] text-ink-3">
          {item.targetSize.width}×{item.targetSize.height}
        </span>
        {item.safeArea && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-ink-3">
            <ShieldCheck size={11} /> 安全区
          </span>
        )}
      </div>
      <div className="relative flex-1 overflow-hidden rounded-[var(--radius-sm)] border border-line-2 bg-[repeating-linear-gradient(45deg,#fafafa,#fafafa_10px,#f4f4f4_10px,#f4f4f4_20px)]">
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-2.5 py-1 text-[11px] text-ink-3 backdrop-blur-sm">
            <Sparkles size={12} /> 画板
          </span>
        </div>
      </div>
    </div>
  );
}

function TextCardView({ item }: { item: Extract<CanvasItem, { type: "text" }> }) {
  const updateItem = useStore((s) => s.updateItem);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  return (
    // Bare text on the canvas (Figma-style) — no box, no background; the
    // wrapper's selection outline is the only chrome.
    <div className="group/card relative h-full w-full" onDoubleClick={() => setEditing(true)}>
      {!editing && (
        <span className="pointer-events-none absolute -top-7 left-0 whitespace-nowrap rounded-full bg-ink px-2 py-0.5 text-[11px] font-medium text-white opacity-0 transition-opacity duration-150 group-hover/card:opacity-90">
          双击编辑
        </span>
      )}
      {editing ? (
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={() => {
            updateItem(item.projectId, item.id, { text } as Partial<CanvasItem>);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
              (e.target as HTMLTextAreaElement).blur();
          }}
          className="h-full w-full resize-none bg-transparent font-normal outline-none"
          style={{ color: item.color, fontSize: item.fontSize, lineHeight: 1.22 }}
        />
      ) : (
        <div
          className="w-full whitespace-pre-wrap font-normal"
          style={{
            color: item.text ? item.color : "rgba(143,143,143,0.75)",
            fontSize: item.fontSize,
            lineHeight: 1.22,
          }}
        >
          {item.text || "双击输入文字"}
        </div>
      )}
    </div>
  );
}

function starPath(w: number, h: number) {
  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.min(w, h) * 0.44;
  const inner = outer * 0.44;
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (Math.PI * 2 * i) / 10;
    pts.push(`${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`);
  }
  return pts.join(" ");
}

function ShapeCardView({ item }: { item: Extract<CanvasItem, { type: "shape" }> }) {
  const w = item.size.width;
  const h = item.size.height;
  const sw = item.strokeWidth;
  const markerId = `arrow-${item.id}`;
  const common = {
    stroke: item.stroke,
    strokeWidth: sw,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: item.fill,
  };
  return (
    <svg
      className="h-full w-full overflow-visible"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-label="图形标注"
    >
      <defs>
        <marker
          id={markerId}
          markerWidth="10"
          markerHeight="10"
          refX="8"
          refY="5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={item.stroke} />
        </marker>
      </defs>
      {item.shape === "rect" && (
        <rect x={sw / 2} y={sw / 2} width={w - sw} height={h - sw} rx={8} {...common} />
      )}
      {item.shape === "ellipse" && (
        <ellipse cx={w / 2} cy={h / 2} rx={(w - sw) / 2} ry={(h - sw) / 2} {...common} />
      )}
      {item.shape === "line" && (
        <line x1={10} y1={h - 10} x2={w - 10} y2={10} {...common} fill="none" />
      )}
      {item.shape === "arrow" && (
        <line
          x1={10}
          y1={h - 10}
          x2={w - 12}
          y2={12}
          {...common}
          fill="none"
          markerEnd={`url(#${markerId})`}
        />
      )}
      {item.shape === "triangle" && (
        <polygon points={`${w / 2},${sw} ${w - sw},${h - sw} ${sw},${h - sw}`} {...common} />
      )}
      {item.shape === "star" && <polygon points={starPath(w, h)} {...common} />}
    </svg>
  );
}

export function CanvasItemView({
  item,
  referenced,
  cb,
}: {
  item: CanvasItem;
  referenced?: boolean;
  cb: CardCallbacks;
}) {
  switch (item.type) {
    case "brief":
      return <BriefCardView item={item} />;
    case "artboard":
      return <ArtboardCardView item={item} />;
    case "text":
      return <TextCardView item={item} />;
    case "shape":
      return <ShapeCardView item={item} />;
    default:
      return <ImageCardView item={item} cb={cb} referenced={referenced} />;
  }
}

/** Artboards render as frames (no card chrome); everything else gets the surface. */
export function cardChrome(item: CanvasItem): boolean {
  return item.type !== "artboard" && item.type !== "text" && item.type !== "shape";
}
