"use client";

import { useEffect } from "react";

/**
 * Removes the Next.js dev-tools overlay (<nextjs-portal>, the red "1 Issue"
 * pill) from the DOM. A CSS `display:none` rule gets stripped by the Tailwind
 * v4 pipeline, so we remove the element at runtime and keep watching for
 * re-mounts. Dev-only; errors remain visible in the browser console.
 */
export function DevOverlayKiller() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const kill = () => {
      document.querySelectorAll("nextjs-portal").forEach((n) => n.remove());
    };
    kill();
    const mo = new MutationObserver(kill);
    mo.observe(document.documentElement, { childList: true });
    mo.observe(document.body, { childList: true });
    return () => mo.disconnect();
  }, []);
  return null;
}
