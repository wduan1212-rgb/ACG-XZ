"use client";

import { useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/util";

/* ---------------- Button ---------------- */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type SizeT = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-ink text-white shadow-[var(--shadow-card)] hover:bg-black hover:shadow-[0_4px_14px_rgba(0,0,0,0.18)] disabled:hover:bg-ink",
  secondary:
    "bg-white text-ink border border-line hover:bg-fill disabled:hover:bg-white",
  ghost: "text-ink-2 hover:bg-fill hover:text-ink",
  danger: "text-danger hover:bg-[var(--color-danger-weak)]",
  subtle: "bg-fill text-ink hover:bg-fill-2",
};

const SIZES: Record<SizeT, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...props
}: {
  variant?: Variant;
  size?: SizeT;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-sm)] font-medium transition-colors focus-ring disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* ---------------- IconButton ---------------- */

export function IconButton({
  active,
  size = "md",
  className,
  children,
  ...props
}: {
  active?: boolean;
  size?: SizeT;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-sm)] transition-colors focus-ring disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "h-7 w-7" : "h-9 w-9",
        active
          ? "bg-[var(--color-accent-weak)] text-accent"
          : "text-ink-2 hover:bg-fill hover:text-ink",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* ---------------- Tooltip (CSS-only) ---------------- */

export function Tooltip({
  label,
  side = "right",
  children,
  kbd,
}: {
  label: ReactNode;
  side?: "right" | "left" | "top" | "bottom";
  children: ReactNode;
  kbd?: string;
}) {
  const pos = {
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  }[side];
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        className={cn(
          "pointer-events-none absolute z-50 flex items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] bg-ink px-2 py-1 text-xs font-medium text-white opacity-0 shadow-[var(--shadow-popover)] transition-opacity duration-100 group-hover/tt:opacity-100",
          pos,
        )}
      >
        {label}
        {kbd && (
          <kbd className="rounded bg-white/20 px-1 font-mono text-[10px]">
            {kbd}
          </kbd>
        )}
      </span>
    </span>
  );
}

/* ---------------- Pill / Badge ---------------- */

export function Pill({
  tone = "neutral",
  className,
  children,
}: {
  tone?: "neutral" | "accent" | "warning" | "danger" | "success";
  className?: string;
  children: ReactNode;
}) {
  const tones = {
    neutral: "bg-fill text-ink-2",
    accent: "bg-[var(--color-accent-weak)] text-accent",
    warning: "bg-[var(--color-warning-weak)] text-[#9a6500]",
    danger: "bg-[var(--color-danger-weak)] text-danger",
    success: "bg-[var(--color-success-weak)] text-[#1f7d37]",
  }[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        tones,
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ---------------- Spinner ---------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-current border-t-transparent",
        className ?? "h-4 w-4",
      )}
      style={{ borderTopColor: "transparent" }}
      aria-hidden
    />
  );
}

/* ---------------- Segmented control ---------------- */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
}: {
  options: { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: SizeT;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-[var(--radius-sm)] bg-fill p-0.5",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[5px] font-medium transition-colors focus-ring",
            size === "sm" ? "h-6 px-2 text-[12px]" : "h-7 px-3 text-[13px]",
            value === o.value
              ? "bg-white text-ink shadow-[var(--shadow-card)]"
              : "text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Modal ---------------- */

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 460,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={onClose}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px] animate-fade" />
      <div
        className="surface-popover relative z-10 max-h-[88vh] w-full overflow-hidden rounded-[var(--radius-lg)] animate-pop"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {(title || subtitle) && (
          <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
            <div>
              {title && (
                <h2 className="text-base font-semibold text-ink">{title}</h2>
              )}
              {subtitle && (
                <p className="mt-0.5 text-[13px] text-ink-2">{subtitle}</p>
              )}
            </div>
            <IconButton size="sm" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </IconButton>
          </div>
        )}
        <div className="max-h-[68vh] overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line bg-[#fcfcfc] px-6 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Field label ---------------- */

export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        {hint && <span className="text-[12px] text-ink-3">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

export const inputClass =
  "h-9 w-full rounded-[var(--radius-sm)] border border-line bg-white px-3 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-[var(--color-accent-weak)]";
