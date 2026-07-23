"use client";

import { AlertTriangle, Check, Info } from "lucide-react";
import { parseSize, planSize, type RiskLevel } from "@/lib/sizing";
import { cn } from "@/lib/util";

const TONE: Record<RiskLevel, { box: string; icon: typeof Check }> = {
  ok: { box: "bg-[var(--color-success-weak)] text-[#1f7d37]", icon: Check },
  warn: { box: "bg-[var(--color-warning-weak)] text-[#9a6500]", icon: Info },
  risk: { box: "bg-[var(--color-danger-weak)] text-danger", icon: AlertTriangle },
};

export function SizePlanBadge({
  size,
  className,
  showSummary = true,
}: {
  size: string;
  className?: string;
  showSummary?: boolean;
}) {
  const parsed = parseSize(size);
  if (!parsed) {
    return (
      <span className={cn("text-[12px] text-ink-3", className)}>
        请输入有效尺寸，如 1920x1080
      </span>
    );
  }
  const plan = planSize(parsed);
  const tone = TONE[plan.level];
  const Icon = tone.icon;
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <span
        className={cn(
          "mt-0.5 inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium",
          tone.box,
        )}
      >
        <Icon size={12} />
        {plan.direct ? "可直接生成" : plan.tile ? "需分块超分" : "自动适配"}
      </span>
      {showSummary && (
        <span className="text-[12px] leading-5 text-ink-2">{plan.summary}</span>
      )}
    </div>
  );
}
