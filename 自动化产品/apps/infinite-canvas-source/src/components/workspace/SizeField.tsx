"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { SizePlanBadge } from "@/components/SizePlanBadge";
import { inputClass } from "@/components/ui";
import { SIZE_GROUPS } from "@/lib/constants";
import { parseSize } from "@/lib/sizing";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/util";

export function SizeField({
  value,
  onChange,
  className,
  align = "left",
  placement = "bottom",
  referenceSize,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  align?: "left" | "right";
  placement?: "top" | "bottom";
  /** First reference image's natural size — offered as a one-tap option. */
  referenceSize?: { width: number; height: number };
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  const customSizes = useStore((s) => s.customSizes);
  const addCustomSize = useStore((s) => s.addCustomSize);
  const removeCustomSize = useStore((s) => s.removeCustomSize);

  if (value !== prevValue) {
    setPrevValue(value);
    setDraft(value);
  }

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

  function commit(v: string) {
    if (parseSize(v)) onChange(v);
  }

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] border border-line bg-white px-2.5 font-mono text-[12px] text-ink hover:bg-fill"
      >
        {value}
        <ChevronDown size={13} className="text-ink-3" />
      </button>
      {open && (
        <div
          className={cn(
            "surface-popover absolute z-40 w-[260px] p-2.5 animate-pop",
            placement === "top" ? "bottom-9" : "top-9",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[12px] font-medium text-ink">选择尺寸</span>
            <span className="text-[11px] text-ink-3">单位：像素 px</span>
          </div>
          {referenceSize && (
            <button
              onClick={() => {
                const v = `${referenceSize.width}x${referenceSize.height}`;
                setDraft(v);
                onChange(v);
                setOpen(false);
              }}
              className={cn(
                "mb-2 flex w-full items-center justify-between rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[12px] transition-colors",
                value === `${referenceSize.width}x${referenceSize.height}`
                  ? "border-ink bg-ink text-white"
                  : "border-line text-ink hover:bg-fill",
              )}
            >
              <span>同参考图尺寸</span>
              <span className="font-mono text-[11px] opacity-80">
                {referenceSize.width}×{referenceSize.height}
              </span>
            </button>
          )}
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit(draft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commit(draft);
                  setOpen(false);
                }
              }}
              className={inputClass + " h-8 font-mono text-[12px]"}
              placeholder="宽x高（px），如 1920x1080"
            />
            <button
              onClick={() => {
                if (parseSize(draft)) {
                  addCustomSize(draft);
                  onChange(draft);
                }
              }}
              disabled={!parseSize(draft)}
              title="保存为常用尺寸"
              className="flex h-8 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-line px-2 text-[12px] text-ink-2 hover:bg-fill disabled:opacity-40"
            >
              <Plus size={13} /> 常用
            </button>
          </div>

          {customSizes.length > 0 && (
            <div className="mt-2.5">
              <div className="mb-1 text-[11px] text-ink-3">自定义</div>
              <div className="flex flex-wrap gap-1">
                {customSizes.map((cs) => (
                  <span
                    key={cs}
                    className="inline-flex items-center rounded-full border border-line py-0.5 pl-2 pr-1 text-[10px]"
                  >
                    <button
                      onClick={() => {
                        setDraft(cs);
                        onChange(cs);
                      }}
                      className="font-mono text-ink-2 hover:text-ink"
                    >
                      {cs.replace("x", "×")}
                    </button>
                    <button
                      onClick={() => removeCustomSize(cs)}
                      className="ml-1 flex h-3.5 w-3.5 items-center justify-center rounded-full text-ink-3 hover:bg-fill hover:text-danger"
                      aria-label="删除"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mt-2.5 max-h-44 space-y-2 overflow-y-auto pr-1">
            {SIZE_GROUPS.map((g) => (
              <div key={g.group}>
                <div className="mb-1 text-[11px] text-ink-3">{g.group}</div>
                <div className="flex flex-wrap gap-1">
                  {g.sizes.map((cs) => {
                    const v = `${cs.w}x${cs.h}`;
                    return (
                      <button
                        key={g.group + v}
                        onClick={() => {
                          setDraft(v);
                          onChange(v);
                          setOpen(false);
                        }}
                        title={`${cs.w}×${cs.h}`}
                        className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-2 hover:bg-fill"
                      >
                        {cs.label} <span className="font-mono text-ink-3">{cs.w}×{cs.h}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2.5 border-t border-line pt-2">
            <SizePlanBadge size={draft} />
          </div>
        </div>
      )}
    </div>
  );
}
