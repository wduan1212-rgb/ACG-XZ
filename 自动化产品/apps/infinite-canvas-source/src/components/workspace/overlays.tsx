"use client";

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { bestAssetUrlFor } from "@/lib/assetCache";
import { ENHANCE_MODES } from "@/lib/constants";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/util";
import {
  isImageItem,
  type CanvasItem,
  type EnhanceOp,
  type EnhanceRunOptions,
  type EnhanceTargetMode,
  type ImageItem,
  type Size,
} from "@/lib/types";

export type MenuEntry =
  | {
      type: "item";
      label: string;
      icon?: ReactNode;
      onClick: () => void;
      danger?: boolean;
      disabled?: boolean;
    }
  | { type: "sep" };

function clampX(x: number, width: number) {
  if (typeof window === "undefined") return x;
  return Math.min(x, window.innerWidth - width - 8);
}
function clampY(y: number, height: number) {
  if (typeof window === "undefined") return y;
  return Math.min(y, window.innerHeight - height - 8);
}

export function ContextMenu({
  pos,
  entries,
  onClose,
}: {
  pos: { x: number; y: number };
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const itemCount = entries.filter((e) => e.type === "item").length;
  return (
    <>
      <div className="fixed inset-0 z-[60]" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="surface-popover fixed z-[61] w-56 p-1 animate-pop"
        style={{ left: clampX(pos.x, 224), top: clampY(pos.y, itemCount * 32 + 16) }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {entries.map((e, i) =>
          e.type === "sep" ? (
            <div key={i} className="my-1 h-px bg-line" />
          ) : (
            <button
              key={i}
              disabled={e.disabled}
              onClick={() => {
                e.onClick();
                onClose();
              }}
              className={cn(
                "flex w-full items-center gap-2.5 whitespace-nowrap rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[13px] transition-colors disabled:opacity-40",
                e.danger
                  ? "text-danger hover:bg-[var(--color-danger-weak)]"
                  : "text-ink hover:bg-fill",
              )}
            >
              {e.icon}
              {e.label}
            </button>
          ),
        )}
      </div>
    </>
  );
}

export function EnhanceMenu({
  pos,
  item,
  onPick,
  onClose,
}: {
  pos: { x: number; y: number };
  item: ImageItem;
  onPick: (op: EnhanceOp, options?: EnhanceRunOptions) => void;
  onClose: () => void;
}) {
  const [targetMode, setTargetMode] = useState<EnhanceTargetMode>("mode");
  const [unit, setUnit] = useState<"px" | "mm">("px");
  const [width, setWidth] = useState(String(item.naturalWidth));
  const [height, setHeight] = useState(String(item.naturalHeight));
  const [dpi, setDpi] = useState("72");
  const customSize = parseCustomSize(width, height, unit, dpi);
  const customValid = !!customSize && customSize.width >= 64 && customSize.height >= 64;
  const sourceAspect = item.naturalWidth / item.naturalHeight;
  const customAspect = customSize ? customSize.width / customSize.height : sourceAspect;
  const aspectChanged = targetMode === "custom" && Math.abs(sourceAspect - customAspect) > 0.02;
  const targetLabel =
    targetMode === "custom" && customSize
      ? unit === "mm"
        ? `${width}×${height}mm @${dpi || "72"}dpi`
        : `${customSize.width}×${customSize.height}px`
      : targetMode === "original"
        ? "原图修复"
        : "模式默认";

  function pick(op: EnhanceOp) {
    if (targetMode === "custom") {
      if (!customSize) return;
      onPick(op, {
        targetMode,
        targetSize: customSize,
        targetLabel,
      });
    } else {
      onPick(op, { targetMode, targetLabel });
    }
    onClose();
  }

  return (
    <>
      <div className="fixed inset-0 z-[60]" onMouseDown={onClose} />
      <div
        className="surface-popover fixed z-[61] w-[320px] p-1 animate-pop"
        style={{ left: clampX(pos.x, 320), top: clampY(pos.y, 560) }}
      >
        <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          高清增强
        </div>
        <div className="px-2.5 pb-2">
          <div className="grid grid-cols-3 rounded-[var(--radius-sm)] bg-fill p-0.5 text-[11px] font-medium text-ink-2">
            {[
              ["mode", "模式默认"],
              ["original", "原图修复"],
              ["custom", "自定义尺寸"],
            ].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTargetMode(id as EnhanceTargetMode)}
                className={cn(
                  "rounded-[calc(var(--radius-sm)-2px)] px-2 py-1.5 transition-colors",
                  targetMode === id
                    ? "bg-white text-ink shadow-[var(--shadow-card)]"
                    : "hover:bg-white/60",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {targetMode === "custom" && (
            <div className="mt-2 rounded-[var(--radius-sm)] border border-line bg-white p-2">
              <div className="mb-2 flex items-center gap-1">
                {(["px", "mm"] as const).map((u) => (
                  <button
                    key={u}
                    onClick={() => setUnit(u)}
                    className={cn(
                      "rounded-full px-2 py-1 text-[11px] font-medium transition-colors",
                      unit === u ? "bg-ink text-white" : "bg-fill text-ink-2 hover:bg-line",
                    )}
                  >
                    {u}
                  </button>
                ))}
                {unit === "mm" && (
                  <label className="ml-auto flex items-center gap-1 text-[11px] text-ink-3">
                    DPI
                    <input
                      value={dpi}
                      onChange={(e) => setDpi(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
                      className="h-7 w-12 rounded-[var(--radius-sm)] border border-line bg-white px-1.5 text-center text-[12px] text-ink outline-none focus:border-accent"
                      inputMode="numeric"
                    />
                  </label>
                )}
              </div>
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1">
                <input
                  value={width}
                  onChange={(e) => setWidth(e.target.value.replace(/[^\d.]/g, "").slice(0, 7))}
                  className="h-8 min-w-0 w-full rounded-[var(--radius-sm)] border border-line bg-white px-2 text-[13px] text-ink outline-none focus:border-accent"
                  inputMode="decimal"
                  aria-label="目标宽度"
                />
                <span className="text-[12px] text-ink-3">×</span>
                <input
                  value={height}
                  onChange={(e) => setHeight(e.target.value.replace(/[^\d.]/g, "").slice(0, 7))}
                  className="h-8 min-w-0 w-full rounded-[var(--radius-sm)] border border-line bg-white px-2 text-[13px] text-ink outline-none focus:border-accent"
                  inputMode="decimal"
                  aria-label="目标高度"
                />
              </div>
              <div className="mt-1.5 text-[11px] leading-4 text-ink-3">
                {customSize ? (
                  <>
                    预计输出 {customSize.width}×{customSize.height}px
                    {aspectChanged ? " · 比例不同会裁切到目标尺寸" : ""}
                  </>
                ) : (
                  "请输入有效尺寸"
                )}
              </div>
            </div>
          )}
          {targetMode === "original" && (
            <div className="mt-2 rounded-[var(--radius-sm)] bg-fill px-2 py-1.5 text-[11px] text-ink-3">
              输出保持原图 {item.naturalWidth}×{item.naturalHeight}px，只修复细节。
            </div>
          )}
        </div>
        {ENHANCE_MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => pick(m.id)}
            disabled={targetMode === "custom" && !customValid}
            className="flex w-full items-start gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left hover:bg-fill disabled:cursor-not-allowed disabled:opacity-40"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-ink">{m.label}</div>
              <div className="text-[11px] text-ink-3">{m.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

function parseCustomSize(
  width: string,
  height: string,
  unit: "px" | "mm",
  dpi: string,
): Size | null {
  const w = Number(width);
  const h = Number(height);
  const d = Math.max(1, Number(dpi) || 72);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  if (unit === "px") return { width: Math.round(w), height: Math.round(h) };
  return {
    width: Math.round((w / 25.4) * d),
    height: Math.round((h / 25.4) * d),
  };
}

export function Lightbox({
  item,
  onClose,
}: {
  item: CanvasItem;
  onClose: () => void;
}) {
  const items = useStore((s) => s.itemsByProject[item.projectId] ?? []);
  const [compare, setCompare] = useState(58);
  const compareRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!isImageItem(item)) return null;
  const beforeItem =
    item.type === "enhanced"
      ? items.find((it) => it.id === item.parentItemId)
      : undefined;
  const beforeUrl =
    beforeItem && isImageItem(beforeItem) ? bestAssetUrlFor(beforeItem) : undefined;
  const metrics =
    item.type === "enhanced" ? item.provenance.enhanceMetrics : undefined;
  const delta = metrics?.sharpnessDeltaPct ?? 0;

  function moveDivider(e: PointerEvent<HTMLDivElement>) {
    const rect = compareRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    setCompare(Math.max(0, Math.min(100, x)));
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-10 animate-fade"
      onClick={onClose}
    >
      <button
        className="absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        onClick={onClose}
        aria-label="关闭"
      >
        <X size={18} />
      </button>
      <div className="flex max-h-full max-w-full flex-col items-center gap-3">
        {beforeUrl ? (
          <div
            ref={compareRef}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              moveDivider(e);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1) moveDivider(e);
            }}
            className="relative max-h-[80vh] max-w-full cursor-ew-resize overflow-hidden rounded-[var(--radius-md)] shadow-2xl"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={beforeUrl}
              alt="增强前"
              draggable={false}
              className="block max-h-[80vh] max-w-full select-none object-contain"
            />
            <div
              className="absolute inset-0 overflow-hidden"
              style={{ clipPath: `inset(0 ${100 - compare}% 0 0)` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.assetUrl}
                alt={item.label}
                draggable={false}
                className="h-full w-full select-none object-cover"
              />
            </div>
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.32)]"
              style={{ left: `${compare}%` }}
            />
            <div
              className="pointer-events-none absolute top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/85 bg-black/55 text-sm font-semibold text-white shadow-[var(--shadow-popover)] backdrop-blur"
              style={{ left: `${compare}%` }}
            >
              ↔
            </div>
            <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/55 px-3 py-1 text-[12px] font-medium text-white backdrop-blur">
              左侧：增强后
            </div>
            <div className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/45 px-3 py-1 text-[12px] font-medium text-white backdrop-blur">
              右侧：增强前
            </div>
            {metrics && (
              <div className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-white/90 px-3 py-1 text-[12px] font-medium text-ink shadow-[var(--shadow-card)] backdrop-blur">
                锐度 {delta >= 0 ? "+" : ""}
                {delta}%
              </div>
            )}
            <div
              className="pointer-events-none absolute bottom-3 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-medium text-white shadow-[var(--shadow-popover)] backdrop-blur"
              style={{ left: `${compare}%`, transform: "translateX(-50%)" }}
            >
              拖动分割线对比
            </div>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.assetUrl}
            alt={item.label}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] max-w-full rounded-[var(--radius-md)] object-contain shadow-2xl"
          />
        )}
        <div className="flex items-center gap-3 text-[13px] text-white/80">
          <span className="font-medium text-white">{item.label}</span>
          <span className="font-mono text-white/60">
            {item.naturalWidth}×{item.naturalHeight}
          </span>
        </div>
      </div>
    </div>
  );
}
