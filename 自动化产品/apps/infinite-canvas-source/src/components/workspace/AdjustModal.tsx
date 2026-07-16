"use client";

import { useState } from "react";
import { Check, Eye, RotateCcw } from "lucide-react";
import { Button, Modal } from "@/components/ui";
import { adjustmentsToCssFilter, bakeAdjustments } from "@/lib/image";
import type { ImageItem } from "@/lib/types";

const DEFAULT = { brightness: 0, contrast: 0, saturation: 0 };

export function AdjustModal({
  item,
  onClose,
  onApplied,
}: {
  item: ImageItem;
  onClose: () => void;
  onApplied: (dataUrl: string, width: number, height: number) => void;
}) {
  const [adj, setAdj] = useState({ ...DEFAULT });
  const [holdOriginal, setHoldOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty =
    adj.brightness !== 0 || adj.contrast !== 0 || adj.saturation !== 0;

  async function apply() {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      const out = await bakeAdjustments(item.assetUrl, adj);
      onApplied(out.dataUrl, out.width, out.height);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const rows: { key: keyof typeof DEFAULT; label: string }[] = [
    { key: "brightness", label: "亮度" },
    { key: "contrast", label: "对比度" },
    { key: "saturation", label: "饱和度" },
  ];

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title="后期调整"
      subtitle="调整会以原始分辨率无损烘焙为一张新图。"
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={apply} disabled={!dirty || busy}>
            <Check size={15} /> {busy ? "处理中…" : "应用到画布"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="relative overflow-hidden rounded-[var(--radius-md)] border border-line bg-[#0c0f15]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.assetUrl}
            alt=""
            className="block max-h-[320px] w-full object-contain transition-[filter] duration-100"
            style={{ filter: holdOriginal ? "none" : adjustmentsToCssFilter(adj) }}
          />
          <button
            onPointerDown={() => setHoldOriginal(true)}
            onPointerUp={() => setHoldOriginal(false)}
            onPointerLeave={() => setHoldOriginal(false)}
            className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-white backdrop-blur-sm hover:bg-black/70"
          >
            <Eye size={12} /> 按住看原图
          </button>
        </div>

        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-3">
            <span className="w-12 shrink-0 text-[13px] text-ink-2">{r.label}</span>
            <input
              type="range"
              min={-50}
              max={50}
              value={adj[r.key]}
              onChange={(e) => setAdj({ ...adj, [r.key]: parseInt(e.target.value, 10) })}
              className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-fill-2 accent-[#171717]"
            />
            <span className="w-9 shrink-0 text-right font-mono text-[12px] text-ink-3">
              {adj[r.key] > 0 ? "+" : ""}
              {adj[r.key]}
            </span>
          </div>
        ))}

        <button
          onClick={() => setAdj({ ...DEFAULT })}
          disabled={!dirty}
          className="flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink disabled:opacity-40"
        >
          <RotateCcw size={12} /> 重置
        </button>
      </div>
    </Modal>
  );
}
