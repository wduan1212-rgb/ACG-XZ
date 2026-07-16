"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button, Modal } from "@/components/ui";
import { cn } from "@/lib/util";
import type { ImageItem } from "@/lib/types";

const STYLES: { id: string; label: string; prompt: string }[] = [
  { id: "ghibli", label: "吉卜力手绘", prompt: "把这张图整体转换为吉卜力动画手绘风格：柔和水彩质感、温暖光线、干净线条，保持构图、主体与文字内容不变" },
  { id: "cyber", label: "赛博霓虹", prompt: "把这张图整体转换为赛博朋克霓虹风格：夜色基调、霓虹蓝紫粉光效、科技感，保持构图与主体不变" },
  { id: "water", label: "水彩插画", prompt: "把这张图整体转换为清透水彩插画风格：纸纹质感、颜料晕染、留白呼吸感，保持构图与主体不变" },
  { id: "bw", label: "黑白胶片", prompt: "把这张图转换为黑白胶片摄影风格：细腻颗粒、高级灰阶、经典对比，保持构图与主体不变" },
  { id: "clay", label: "3D 黏土", prompt: "把这张图整体转换为可爱的 3D 黏土定格动画风格：圆润造型、软质材质、影棚柔光，保持构图与主体不变" },
  { id: "retro", label: "复古海报", prompt: "把这张图转换为上世纪复古印刷海报风格：做旧纸张、丝网印刷质感、复古配色，保持构图与主体不变" },
];

/**
 * Style picker only — clicking a style immediately spawns a generating card on
 * the canvas (via onPick) so nothing blocks here. Several styles can be fired
 * in one visit; each style dispatches at most once.
 */
export function StyleModal({
  item,
  onClose,
  onPick,
}: {
  item: ImageItem;
  onClose: () => void;
  onPick: (styleLabel: string, stylePrompt: string) => void;
}) {
  const [fired, setFired] = useState<string[]>([]);

  return (
    <Modal
      open
      onClose={onClose}
      title="风格转换"
      subtitle="点击一个风格，画布上会出现一张生成中的新图，不用在这里等；可同时试多种。"
      width={480}
      footer={
        <Button variant="primary" onClick={onClose}>
          完成
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2.5">
          <span className="h-12 w-12 shrink-0 overflow-hidden rounded-[var(--radius-sm)] border border-line bg-fill">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.assetUrl} alt="" className="h-full w-full object-cover" />
          </span>
          <span className="text-[12px] text-ink-3">
            基于「{item.label ?? "当前图片"}」生成，原图保留不动
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {STYLES.map((s) => {
            const done = fired.includes(s.id);
            return (
              <button
                key={s.id}
                disabled={done}
                onClick={() => {
                  setFired((f) => [...f, s.id]);
                  onPick(s.label, s.prompt);
                }}
                className={cn(
                  "rounded-full border px-3.5 py-2 text-[13px] transition-colors",
                  done
                    ? "border-ink bg-ink text-white"
                    : "border-line text-ink-2 hover:bg-fill hover:text-ink",
                )}
              >
                {done && <Check size={12} className="mr-1 inline" />}
                {s.label}
                {done && <span className="opacity-70"> · 生成中</span>}
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
