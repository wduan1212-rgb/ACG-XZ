"use client";

import type { ReactNode } from "react";
import { useStore } from "@/lib/store";

export function useHydrated(): boolean {
  return useStore((s) => s._hasHydrated);
}

/** Renders children only once the persisted store has hydrated (avoids SSR mismatch). */
export function Hydrated({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return <>{fallback}</>;
  return <>{children}</>;
}
