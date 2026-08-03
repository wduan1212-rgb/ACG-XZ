"use client";

import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { Button, Spinner } from "@/components/ui";
import { callEditRegion } from "@/lib/api";
import { loadImage } from "@/lib/image";
import type { ImageItem } from "@/lib/types";

/** Rect in image-fraction coordinates (0..1). */
interface FracRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const WORK_MAX = 1536; // working resolution sent to the API

export function RegionEditor({
  item,
  onClose,
  onApplied,
}: {
  item: ImageItem;
  onClose: () => void;
  onApplied: (dataUrl: string, width: number, height: number, instruction: string) => void;
}) {
  const [rects, setRects] = useState<FracRect[]>([]);
  const [draft, setDraft] = useState<FracRect | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Closing is ALWAYS allowed — mid-edit close aborts the request.
  const close = () => {
    abortRef.current?.abort();
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toFrac = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  function onDown(e: React.PointerEvent) {
    if (busy) return;
    e.preventDefault();
    start.current = toFrac(e);
    setDraft({ ...start.current, w: 0, h: 0 });
  }
  function onMove(e: React.PointerEvent) {
    if (!start.current) return;
    const p = toFrac(e);
    const s = start.current;
    setDraft({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    });
  }
  function onUp() {
    if (draft && draft.w > 0.02 && draft.h > 0.02) setRects((rs) => [...rs, draft]);
    setDraft(null);
    start.current = null;
  }

  async function apply() {
    if (rects.length === 0 || !instruction.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      // Working image + mask at the same dims (mask transparent = editable).
      const img = await loadImage(item.assetUrl);
      const w0 = img.naturalWidth || img.width;
      const h0 = img.naturalHeight || img.height;
      const scale = Math.min(1, WORK_MAX / Math.max(w0, h0));
      const W = Math.max(16, Math.round(w0 * scale));
      const H = Math.max(16, Math.round(h0 * scale));

      const work = document.createElement("canvas");
      work.width = W;
      work.height = H;
      work.getContext("2d")!.drawImage(img, 0, 0, W, H);

      const mask = document.createElement("canvas");
      mask.width = W;
      mask.height = H;
      const mctx = mask.getContext("2d")!;
      mctx.fillStyle = "#000";
      mctx.fillRect(0, 0, W, H);
      for (const r of rects) {
        mctx.clearRect(r.x * W, r.y * H, r.w * W, r.h * H);
      }

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const timer = setTimeout(() => ctrl.abort(), 150_000);
      const data = await callEditRegion(
        {
          image: work.toDataURL("image/jpeg", 0.9),
          mask: mask.toDataURL("image/png"),
          instruction: instruction.trim(),
          width: item.naturalWidth,
          height: item.naturalHeight,
          idempotencyKey: `region-${item.id}-${Date.now()}`,
        },
        ctrl.signal,
      );
      clearTimeout(timer);
      onApplied(data.dataUrl, data.width, data.height, instruction.trim());
      onClose();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return; // user closed
      setError(e instanceof Error ? e.message : "编辑失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-black/85 p-6 animate-fade">
      <div className="mb-3 flex w-full max-w-4xl items-center justify-between">
        <div className="text-sm font-medium text-white">
          框选要修改的区域
          <span className="ml-2 text-[12px] text-white/50">拖拽画框，可框多处 · 只有框内会被修改</span>
        </div>
        <button
          onClick={close}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          aria-label="关闭"
        >
          <X size={16} />
        </button>
      </div>

      <div
        ref={boxRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className="relative max-h-[64vh] max-w-4xl cursor-crosshair select-none touch-none"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.assetUrl}
          alt=""
          draggable={false}
          className="max-h-[64vh] w-auto max-w-full"
        />
        {[...rects, ...(draft ? [draft] : [])].map((r, i) => (
          <div
            key={i}
            className="absolute border-2 border-accent bg-[rgba(0,107,255,0.15)]"
            style={{
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
            }}
          >
            {i < rects.length && (
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setRects((rs) => rs.filter((_, j) => j !== i))}
                className="absolute -right-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white hover:bg-[var(--color-accent-hover)]"
                aria-label="删除此框"
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
        {busy && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55">
            <Spinner className="h-6 w-6 text-white" />
            <span className="text-[13px] text-white/80">正在修改框选区域…约 20 秒</span>
            <button
              onClick={close}
              className="mt-1 rounded-full border border-white/25 px-3 py-1 text-[12px] text-white/80 hover:bg-white/10"
            >
              取消
            </button>
          </div>
        )}
      </div>

      <div className="mt-4 flex w-full max-w-4xl items-center gap-2">
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
          placeholder='批注：这个区域要怎么改？如「把标题改成 双十一狂欢」「换成一杯咖啡」'
          disabled={busy}
          className="h-11 flex-1 rounded-[var(--radius-md)] border border-white/15 bg-white/10 px-4 text-sm text-white placeholder:text-white/40 outline-none focus:border-accent"
        />
        <Button
          variant="primary"
          onClick={apply}
          disabled={busy || rects.length === 0 || !instruction.trim()}
          className="h-11 px-5"
        >
          <Check size={16} /> {busy ? "修改中…" : "应用修改"}
        </Button>
      </div>
      {error && <div className="mt-2 text-[13px] text-[#ff8a8a]">{error}</div>}
      {rects.length === 0 && !busy && (
        <div className="mt-2 text-[12px] text-white/40">先在图上拖一个框</div>
      )}
    </div>
  );
}
