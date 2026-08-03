"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Map, Maximize, Minus, Plus } from "lucide-react";
import { CanvasItemView, cardChrome, type CardCallbacks } from "./cards";
import { contentBounds } from "@/lib/geometry";
import { useStore } from "@/lib/store";
import { clamp, cn } from "@/lib/util";
import { isImageItem, type CanvasItem, type Vec2 } from "@/lib/types";
import { canvasContextPortalFromBootstrap } from "@/lib/platformBridge";
import { IS_PLATFORM_EMBED } from "@/lib/runtime";

/** Edge/center lines of a rect used for snap matching. */
interface SnapEdges {
  xs: number[]; // left, centerX, right
  ys: number[]; // top, centerY, bottom
}

interface DragData {
  pointerStart: Vec2;
  startPositions: Record<string, Vec2>;
  primary: { start: Vec2; w: number; h: number };
  others: SnapEdges[];
}

const SNAP_PX = 6; // screen-px snap threshold

type GestureMode = "idle" | "pan" | "drag" | "resize" | "select";
type Corner = "nw" | "ne" | "sw" | "se";
/** Resize handles: corners, side stretch (text), and the rotate knob. */
type Handle = Corner | "e" | "w" | "rot";

interface ResizeData {
  id: string;
  corner: Handle;
  start: { x: number; y: number };
  pos: { x: number; y: number };
  size: { width: number; height: number };
  font?: number; // text marks scale proportionally with their font
  center?: { x: number; y: number }; // for rotation
  startRotation?: number;
  startDeg?: number;
}
interface Gesture {
  mode: GestureMode;
  lastX: number;
  lastY: number;
  startX: number;
  startY: number;
  moved: boolean;
  additive?: boolean;
}

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 4;

function useCanvasContextPortal() {
  const [state, setState] = useState<{
    expectsPortal: boolean;
    target: HTMLElement | null;
  }>({
    // The embed build starts without right-side controls so the old floating
    // minimap cannot flash before the parent workspace target is discovered.
    expectsPortal: IS_PLATFORM_EMBED,
    target: null,
  });

  useEffect(() => {
    const config = canvasContextPortalFromBootstrap();
    let frame = 0;
    if (!IS_PLATFORM_EMBED || !config || window.parent === window) {
      // Keep the effect subscription-only: defer the post-hydration fallback
      // instead of synchronously setting React state inside the effect body.
      frame = window.requestAnimationFrame(() => {
        setState({ expectsPortal: false, target: null });
      });
      return () => window.cancelAnimationFrame(frame);
    }
    let attempts = 0;
    const findTarget = () => {
      try {
        const target = window.parent.document.getElementById(config.id);
        if (
          target
          && target.dataset.canvasContextPortal === config.nonce
        ) {
          setState({ expectsPortal: true, target });
          return;
        }
      } catch {
        setState({ expectsPortal: false, target: null });
        return;
      }
      attempts += 1;
      if (attempts < 180) frame = window.requestAnimationFrame(findTarget);
    };
    frame = window.requestAnimationFrame(findTarget);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return state;
}

export function Canvas({
  projectId,
  onMenu,
  onPreview,
}: {
  projectId: string;
  onMenu: (item: CanvasItem, pos: { x: number; y: number }) => void;
  onPreview: (item: CanvasItem) => void;
}) {
  const items = useStore((s) => s.itemsByProject[projectId] ?? EMPTY);
  const viewport = useStore((s) => s.viewportByProject[projectId]);
  const selection = useStore((s) => s.selection);
  const references = useStore((s) => s.references);
  const activeTool = useStore((s) => s.activeTool);
  const setViewport = useStore((s) => s.setViewport);
  const setSelection = useStore((s) => s.setSelection);
  const clearSelection = useStore((s) => s.clearSelection);
  const toggleSelection = useStore((s) => s.toggleSelection);
  const bringToFront = useStore((s) => s.bringToFront);
  const addReference = useStore((s) => s.addReference);
  const contextPortal = useCanvasContextPortal();

  const containerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture>({
    mode: "idle",
    lastX: 0,
    lastY: 0,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const spaceDown = useRef(false);
  const userAdjusted = useRef(false);
  const dragData = useRef<DragData | null>(null);
  const [spaceActive, setSpaceActive] = useState(false);
  const [hostSize, setHostSize] = useState({ width: 1000, height: 700 });
  const [guides, setGuides] = useState<{ v: number | null; h: number | null }>({
    v: null,
    h: null,
  });
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const updateItem = useStore((s) => s.updateItem);
  const resizeData = useRef<ResizeData | null>(null);
  const moveItemsTo = useStore((s) => s.moveItemsTo);

  const vp = viewport ?? { x: 0, y: 0, zoom: 1 };
  const refSet = useMemo(() => new Set(references.map((r) => r.itemId)), [references]);
  const visibleItems = useMemo(() => items.filter((item) => !item.hidden), [items]);
  const sorted = useMemo(() => [...visibleItems].sort((a, b) => a.z - b.z), [visibleItems]);

  const fitToContent = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    const b = contentBounds((useStore.getState().itemsByProject[projectId] ?? []).filter((item) => !item.hidden));
    if (b && b.width > 0) {
      const pad = 160;
      const zoom = clamp(
        Math.min((r.width - pad) / b.width, (r.height - pad) / b.height),
        MIN_ZOOM,
        1.3,
      );
      setViewport(projectId, {
        zoom,
        x: r.width / 2 - (b.x + b.width / 2) * zoom,
        y: r.height / 2 - (b.y + b.height / 2) * zoom,
      });
    } else {
      setViewport(projectId, { x: r.width / 2, y: r.height / 2, zoom: 1 });
    }
  }, [projectId, setViewport]);

  const zoomAt = useCallback(
    (factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cur = useStore.getState().viewportByProject[projectId] ?? { x: 0, y: 0, zoom: 1 };
      const z = clamp(cur.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const cx = r.width / 2;
      const cy = r.height / 2;
      const wx = (cx - cur.x) / cur.zoom;
      const wy = (cy - cur.y) / cur.zoom;
      userAdjusted.current = true;
      setViewport(projectId, { zoom: z, x: cx - wx * z, y: cy - wy * z });
    },
    [projectId, setViewport],
  );

  useLayoutEffect(() => {
    if (!useStore.getState().viewportByProject[projectId]) fitToContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const syncSize = () => {
      const r = el.getBoundingClientRect();
      setHostSize({ width: r.width || 1000, height: r.height || 700 });
    };
    syncSize();
    const ro = new ResizeObserver(() => {
      syncSize();
      if (!userAdjusted.current) fitToContent();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitToContent]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userAdjusted.current = true;
      const cur = useStore.getState().viewportByProject[projectId] ?? { x: 0, y: 0, zoom: 1 };
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0016);
        const z = clamp(cur.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const cx = e.clientX - r.left;
        const cy = e.clientY - r.top;
        const wx = (cx - cur.x) / cur.zoom;
        const wy = (cy - cur.y) / cur.zoom;
        setViewport(projectId, { zoom: z, x: cx - wx * z, y: cy - wy * z });
      } else {
        setViewport(projectId, { ...cur, x: cur.x - e.deltaX, y: cur.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [projectId, setViewport]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (
        e.code === "Space" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        spaceDown.current = true;
        setSpaceActive(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDown.current = false;
        setSpaceActive(false);
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (g.mode === "idle") return;
      const dx = e.clientX - g.lastX;
      const dy = e.clientY - g.lastY;
      if (Math.abs(e.clientX - g.startX) + Math.abs(e.clientY - g.startY) > 3) g.moved = true;
      g.lastX = e.clientX;
      g.lastY = e.clientY;
      if (g.mode === "pan") {
        const cur = useStore.getState().viewportByProject[projectId]!;
        setViewport(projectId, { ...cur, x: cur.x + dx, y: cur.y + dy });
      } else if (g.mode === "select") {
        const host = containerRef.current?.getBoundingClientRect();
        if (!host) return;
        const left = Math.min(g.startX, e.clientX) - host.left;
        const top = Math.min(g.startY, e.clientY) - host.top;
        setSelectionBox({ left, top, width: Math.abs(e.clientX - g.startX), height: Math.abs(e.clientY - g.startY) });
      } else if (g.mode === "resize") {
        const rd = resizeData.current;
        if (!rd) return;
        const vpNow = useStore.getState().viewportByProject[projectId] ?? { x: 0, y: 0, zoom: 1 };
        if (rd.corner === "rot") {
          const el = containerRef.current;
          if (!el || !rd.center) return;
          const r = el.getBoundingClientRect();
          const wx = (e.clientX - r.left - vpNow.x) / vpNow.zoom;
          const wy = (e.clientY - r.top - vpNow.y) / vpNow.zoom;
          const deg = (Math.atan2(wy - rd.center.y, wx - rd.center.x) * 180) / Math.PI;
          let rot = (rd.startRotation ?? 0) + deg - (rd.startDeg ?? 0);
          if (e.shiftKey) rot = Math.round(rot / 15) * 15;
          rot = ((Math.round(rot) % 360) + 360) % 360;
          updateItem(projectId, rd.id, { rotation: rot } as Partial<CanvasItem>);
          return;
        }
        const z = vpNow.zoom;
        const dx = (e.clientX - rd.start.x) / z;
        const dy = (e.clientY - rd.start.y) / z;
        const horizOnly = rd.corner === "e" || rd.corner === "w";
        const w = Math.max(24, rd.size.width + (rd.corner.includes("e") ? dx : -dx));
        let h: number;
        if (horizOnly) {
          h = rd.size.height; // side stretch: reflow text, keep font
        } else if (rd.font !== undefined) {
          // Corner on text: proportional — the font follows the box.
          h = Math.max(16, rd.size.height * (w / rd.size.width));
        } else {
          h = Math.max(16, rd.size.height + (rd.corner.includes("s") ? dy : -dy));
        }
        const x = rd.pos.x + (rd.corner.includes("w") ? rd.size.width - w : 0);
        const y = rd.pos.y + (rd.corner.includes("n") ? rd.size.height - h : 0);
        const patch: Record<string, unknown> = {
          position: { x, y },
          size: { width: Math.round(w), height: Math.round(h) },
        };
        if (!horizOnly && rd.font !== undefined)
          patch.fontSize = Math.max(8, Math.round(rd.font * (w / rd.size.width)));
        updateItem(projectId, rd.id, patch as Partial<CanvasItem>);
      } else if (g.mode === "drag") {
        const dd = dragData.current;
        if (!dd) return;
        const z = useStore.getState().viewportByProject[projectId]?.zoom ?? 1;
        const rawX = (e.clientX - dd.pointerStart.x) / z;
        const rawY = (e.clientY - dd.pointerStart.y) / z;
        const th = SNAP_PX / z;

        // Candidate edges of the primary card at the raw position.
        const L = dd.primary.start.x + rawX;
        const T = dd.primary.start.y + rawY;
        const candX = [L, L + dd.primary.w / 2, L + dd.primary.w];
        const candY = [T, T + dd.primary.h / 2, T + dd.primary.h];

        let bestX: { diff: number; at: number } | null = null;
        let bestY: { diff: number; at: number } | null = null;
        for (const o of dd.others) {
          for (const c of candX)
            for (const t of o.xs) {
              const diff = t - c;
              if (Math.abs(diff) <= th && (!bestX || Math.abs(diff) < Math.abs(bestX.diff)))
                bestX = { diff, at: t };
            }
          for (const c of candY)
            for (const t of o.ys) {
              const diff = t - c;
              if (Math.abs(diff) <= th && (!bestY || Math.abs(diff) < Math.abs(bestY.diff)))
                bestY = { diff, at: t };
            }
        }

        const dxW = rawX + (bestX?.diff ?? 0);
        const dyW = rawY + (bestY?.diff ?? 0);
        const positions: Record<string, Vec2> = {};
        for (const [id, p] of Object.entries(dd.startPositions))
          positions[id] = { x: p.x + dxW, y: p.y + dyW };
        moveItemsTo(projectId, positions);
        setGuides({ v: bestX ? bestX.at : null, h: bestY ? bestY.at : null });
      }
    };
    const onUp = (e: PointerEvent) => {
      const g = gesture.current;
      if (g.mode === "pan" && !g.moved && !spaceDown.current) clearSelection();
      if (g.mode === "select") {
        const host = containerRef.current?.getBoundingClientRect();
        const vpNow = useStore.getState().viewportByProject[projectId] ?? { x: 0, y: 0, zoom: 1 };
        if (host && g.moved) {
          const x1 = (Math.min(g.startX, e.clientX) - host.left - vpNow.x) / vpNow.zoom;
          const y1 = (Math.min(g.startY, e.clientY) - host.top - vpNow.y) / vpNow.zoom;
          const x2 = (Math.max(g.startX, e.clientX) - host.left - vpNow.x) / vpNow.zoom;
          const y2 = (Math.max(g.startY, e.clientY) - host.top - vpNow.y) / vpNow.zoom;
          const picked = (useStore.getState().itemsByProject[projectId] ?? [])
            .filter((item) => !item.hidden && isImageItem(item))
            .filter((item) => item.position.x < x2 && item.position.x + item.size.width > x1 && item.position.y < y2 && item.position.y + item.size.height > y1)
            .map((item) => item.id);
          const current = g.additive ? useStore.getState().selection : [];
          setSelection([...new Set([...current, ...picked])]);
        } else if (!g.additive) {
          clearSelection();
        }
        setSelectionBox(null);
      }
      g.mode = "idle";
      g.moved = false;
      dragData.current = null;
      resizeData.current = null;
      setGuides({ v: null, h: null });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [projectId, setViewport, moveItemsTo, clearSelection, setSelection, updateItem]);

  function onContainerPointerDown(e: RPointerEvent) {
    userAdjusted.current = true;
    const selecting = activeTool === "select" && !spaceDown.current && e.button === 0;
    gesture.current = {
      mode: selecting ? "select" : "pan",
      lastX: e.clientX,
      lastY: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      additive: e.shiftKey,
    };
    if (selecting) {
      const host = containerRef.current?.getBoundingClientRect();
      setSelectionBox({ left: e.clientX - (host?.left || 0), top: e.clientY - (host?.top || 0), width: 0, height: 0 });
    }
  }

  function onItemPointerDown(e: RPointerEvent, item: CanvasItem) {
    e.stopPropagation();
    if (spaceDown.current || activeTool === "hand" || e.button === 1) {
      userAdjusted.current = true;
      gesture.current = { mode: "pan", lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
      return;
    }
    const sel = useStore.getState().selection;
    if (e.shiftKey) toggleSelection(item.id);
    else if (!sel.includes(item.id)) setSelection([item.id]);
    bringToFront(projectId, item.id);

    // Snapshot positions for snap-drag: selected items move, the rest are snap targets.
    const state = useStore.getState();
    const all = (state.itemsByProject[projectId] ?? []).filter((it) => !it.hidden);
    const selSet = new Set(state.selection);
    const startPositions: Record<string, Vec2> = {};
    const others: SnapEdges[] = [];
    for (const it of all) {
      if (selSet.has(it.id)) {
        startPositions[it.id] = { ...it.position };
      } else {
        const { x, y } = it.position;
        const { width: w, height: h } = it.size;
        others.push({ xs: [x, x + w / 2, x + w], ys: [y, y + h / 2, y + h] });
      }
    }
    dragData.current = {
      pointerStart: { x: e.clientX, y: e.clientY },
      startPositions,
      primary: { start: { ...item.position }, w: item.size.width, h: item.size.height },
      others,
    };
    gesture.current = { mode: "drag", lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
  }

  const startResize = useCallback(
    (e: RPointerEvent, item: CanvasItem, corner: Handle) => {
      e.stopPropagation();
      const center = {
        x: item.position.x + item.size.width / 2,
        y: item.position.y + item.size.height / 2,
      };
      let startDeg = 0;
      if (corner === "rot" && containerRef.current) {
        const r = containerRef.current.getBoundingClientRect();
        const vpNow = useStore.getState().viewportByProject[projectId] ?? { x: 0, y: 0, zoom: 1 };
        const wx = (e.clientX - r.left - vpNow.x) / vpNow.zoom;
        const wy = (e.clientY - r.top - vpNow.y) / vpNow.zoom;
        startDeg = (Math.atan2(wy - center.y, wx - center.x) * 180) / Math.PI;
      }
      resizeData.current = {
        id: item.id,
        corner,
        start: { x: e.clientX, y: e.clientY },
        pos: { ...item.position },
        size: { ...item.size },
        font: item.type === "text" ? item.fontSize : undefined,
        center,
        startRotation: item.rotation ?? 0,
        startDeg,
      };
      gesture.current = {
        mode: "resize",
        lastX: e.clientX,
        lastY: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      };
    },
    [projectId],
  );

  const cb: CardCallbacks = {
    onUseReference: (item) => {
      addReference(item.id, "style");
      setSelection([item.id]);
    },
    onPreview,
    onMenu,
  };

  return (
    <div
      ref={containerRef}
      data-canvas-host
      onPointerDown={onContainerPointerDown}
      className={cn(
        "relative h-full w-full select-none overflow-hidden canvas-dots",
        spaceActive || activeTool === "hand" ? "cursor-grab active:cursor-grabbing" : "cursor-default",
      )}
      style={{
        touchAction: "none",
        backgroundSize: `${24 * vp.zoom}px ${24 * vp.zoom}px`,
        backgroundPosition: `${vp.x}px ${vp.y}px`,
      }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` }}
      >
        {/* eslint-disable-next-line react-hooks/refs -- refs are written only inside pointer handlers (startResize), same as onItemPointerDown; compiler false-positive on handler-in-loop */}
        {sorted.map((item) => {
          const selected = selection.includes(item.id);
          return (
            <div
              key={item.id}
              onPointerDown={(e) => onItemPointerDown(e, item)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSelection([item.id]);
                onMenu(item, { x: e.clientX, y: e.clientY });
              }}
              className={cn("absolute", cardChrome(item) && "surface-card", selected && "z-10")}
              style={{
                left: item.position.x,
                top: item.position.y,
                width: item.size.width,
                height: item.size.height,
                // Images are square-cornered; only brief cards keep a radius.
                borderRadius: isImageItem(item) ? 0 : cardChrome(item) ? "var(--radius-md)" : 4,
                rotate: item.rotation ? `${item.rotation}deg` : undefined,
                outline: selected
                  ? item.type === "text" || item.type === "shape"
                    ? `1px solid rgba(0,107,255,0.45)`
                    : "2px solid var(--color-accent)"
                  : undefined,
                boxShadow:
                  selected && !(item.type === "text" || item.type === "shape")
                    ? "var(--shadow-select)"
                    : undefined,
                cursor: spaceActive ? "inherit" : "move",
              }}
            >
              {/* floating name label — constant screen size, click to rename */}
              {isImageItem(item) && (
                <div
                  className="absolute bottom-full left-0 origin-bottom-left pb-1"
                  style={{ transform: `scale(${1 / vp.zoom})` }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {editing?.id === item.id ? (
                    <input
                      autoFocus
                      value={editing.draft}
                      onChange={(e) => setEditing({ id: item.id, draft: e.target.value })}
                      onBlur={() => {
                        const v = editing.draft.trim();
                        if (v) updateItem(projectId, item.id, { label: v } as Partial<CanvasItem>);
                        setEditing(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setEditing(null);
                      }}
                      className="h-6 w-40 rounded-[var(--radius-sm)] border border-accent bg-white px-1.5 text-[11px] text-ink outline-none ring-2 ring-[var(--color-accent-weak)]"
                    />
                  ) : (
                    <button
                      onClick={() =>
                        setEditing({ id: item.id, draft: item.label ?? "参考图" })
                      }
                      title="点击重命名"
                      className="flex items-center gap-1.5 whitespace-nowrap rounded px-0.5 text-[11px] text-ink-2 hover:text-ink"
                    >
                      <span className="max-w-[180px] truncate font-medium">
                        {item.label ?? "参考图"}
                      </span>
                      <span className="font-mono text-[10px] text-ink-3">
                        {item.naturalWidth}×{item.naturalHeight}
                      </span>
                    </button>
                  )}
                </div>
              )}
              <CanvasItemView item={item} referenced={refSet.has(item.id)} cb={cb} />
              {selected &&
                selection.length === 1 &&
                (item.type === "text" || item.type === "shape") &&
                ((item.type === "text"
                  ? ["nw", "ne", "sw", "se", "e", "w", "rot"]
                  : ["nw", "ne", "sw", "se", "rot"]) as Handle[]).map((c) => {
                  const hs = (c === "rot" ? 11 : 9) / vp.zoom;
                  const w = item.size.width;
                  const h = item.size.height;
                  const pos =
                    c === "rot"
                      ? { left: w / 2 - hs / 2, top: -24 / vp.zoom - hs / 2 }
                      : c === "e"
                        ? { left: w - hs / 2, top: h / 2 - hs / 2 }
                        : c === "w"
                          ? { left: -hs / 2, top: h / 2 - hs / 2 }
                          : {
                              left: (c.includes("w") ? 0 : w) - hs / 2,
                              top: (c.includes("n") ? 0 : h) - hs / 2,
                            };
                  const cursor =
                    c === "rot"
                      ? "grab"
                      : c === "e" || c === "w"
                        ? "ew-resize"
                        : c === "nw" || c === "se"
                          ? "nwse-resize"
                          : "nesw-resize";
                  return (
                    <div
                      key={c}
                      onPointerDown={(e) => startResize(e, item, c)}
                      className={
                        "absolute z-20 bg-white " +
                        (c === "rot" ? "rounded-full" : "rounded-[2px]")
                      }
                      style={{
                        width: hs,
                        height: hs,
                        ...pos,
                        boxShadow: `0 0 0 ${1 / vp.zoom}px rgba(0,107,255,0.65)`,
                        cursor,
                      }}
                    />
                  );
                })}
            </div>
          );
        })}

        {/* snap alignment guides */}
        {guides.v !== null && (
          <div
            className="pointer-events-none absolute bg-accent"
            style={{ left: guides.v, top: -100000, width: 1 / vp.zoom, height: 200000 }}
          />
        )}
        {guides.h !== null && (
          <div
            className="pointer-events-none absolute bg-accent"
            style={{ top: guides.h, left: -100000, height: 1 / vp.zoom, width: 200000 }}
          />
        )}
      </div>

      {items.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-1.5 text-center">
            <div className="rounded-full border border-line bg-white/85 px-4 py-2 text-[13px] text-ink-2 shadow-[var(--shadow-card)] backdrop-blur-sm">
              画布还是空的 · 在右侧说一句需求，或直接拖入图片
            </div>
            <span className="text-[11px] text-ink-3">生成结果会自动出现在这里</span>
          </div>
        </div>
      )}

      {selectionBox && (
        <div
          className="pointer-events-none absolute z-30 border border-accent bg-[var(--color-accent-weak)]"
          style={selectionBox}
        />
      )}

      {(() => {
        const controls = <ViewportControls
        projectId={projectId}
        items={visibleItems}
        zoom={vp.zoom}
        viewport={vp}
        hostSize={hostSize}
        setViewport={setViewport}
        onZoomIn={() => zoomAt(1.2)}
        onZoomOut={() => zoomAt(1 / 1.2)}
        onFit={() => {
          userAdjusted.current = false;
          fitToContent();
        }}
        portaled={Boolean(contextPortal.target)}
      />;
        if (contextPortal.target) return createPortal(controls, contextPortal.target);
        return contextPortal.expectsPortal ? null : controls;
      })()}
    </div>
  );
}

function ViewportControls({
  projectId,
  items,
  zoom,
  viewport,
  hostSize,
  setViewport,
  onZoomIn,
  onZoomOut,
  onFit,
  portaled = false,
}: {
  projectId: string;
  items: CanvasItem[];
  zoom: number;
  viewport: { x: number; y: number; zoom: number };
  hostSize: { width: number; height: number };
  setViewport: (projectId: string, vp: { x: number; y: number; zoom: number }) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  portaled?: boolean;
}) {
  const [mapOpen, setMapOpen] = useState(true);
  const mapRef = useRef<HTMLDivElement>(null);
  const hostW = hostSize.width || 1000;
  const hostH = hostSize.height || 700;
  const viewWorld = useMemo(
    () => ({
      x: -viewport.x / viewport.zoom,
      y: -viewport.y / viewport.zoom,
      width: hostW / viewport.zoom,
      height: hostH / viewport.zoom,
    }),
    [hostH, hostW, viewport.x, viewport.y, viewport.zoom],
  );
  const bounds = useMemo(() => {
    const b = contentBounds(items);
    if (!b) return viewWorld;
    const minX = Math.min(b.x, viewWorld.x);
    const minY = Math.min(b.y, viewWorld.y);
    const maxX = Math.max(b.x + b.width, viewWorld.x + viewWorld.width);
    const maxY = Math.max(b.y + b.height, viewWorld.y + viewWorld.height);
    const pad = Math.max(120, Math.max(maxX - minX, maxY - minY) * 0.08);
    return {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }, [items, viewWorld]);
  const mapW = 196;
  const mapH = 116;
  const scale = Math.min((mapW - 20) / Math.max(bounds.width, 1), (mapH - 20) / Math.max(bounds.height, 1));
  const offsetX = (mapW - bounds.width * scale) / 2;
  const offsetY = (mapH - bounds.height * scale) / 2;
  const toMini = (r: { x: number; y: number; width: number; height: number }) => ({
    left: offsetX + (r.x - bounds.x) * scale,
    top: offsetY + (r.y - bounds.y) * scale,
    width: Math.max(2, r.width * scale),
    height: Math.max(2, r.height * scale),
  });
  const viewMini = toMini(viewWorld);

  function moveFromMini(clientX: number, clientY: number) {
    const el = mapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const wx = bounds.x + (clientX - r.left - offsetX) / scale;
    const wy = bounds.y + (clientY - r.top - offsetY) / scale;
    setViewport(projectId, {
      ...viewport,
      x: hostW / 2 - wx * viewport.zoom,
      y: hostH / 2 - wy * viewport.zoom,
    });
  }

  return (
    <div
      className={cn(
        "canvas-viewport-controls flex flex-col gap-2",
        portaled ? "canvas-viewport-controls--portal" : "absolute bottom-4 left-4",
      )}
      data-canvas-viewport-controls={portaled ? "context" : "canvas"}
    >
      {mapOpen && (
        <div
          ref={mapRef}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            moveFromMini(e.clientX, e.clientY);
          }}
          onPointerMove={(e) => {
            if (e.buttons !== 1) return;
            e.stopPropagation();
            moveFromMini(e.clientX, e.clientY);
          }}
          className="canvas-viewport-minimap surface-popover relative h-[116px] w-[196px] overflow-hidden bg-white/92 p-0"
          aria-label="画布小地图"
        >
          <div className="canvas-viewport-grid absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,0.035)_1px,transparent_1px),linear-gradient(0deg,rgba(0,0,0,0.035)_1px,transparent_1px)] bg-[length:20px_20px]" />
          {items.map((item) => {
            const r = toMini({ ...item.position, ...item.size });
            const kind = isImageItem(item)
              ? "image"
              : item.type === "text"
                ? "text"
                : item.type === "shape"
                  ? "shape"
                  : "other";
            return (
              <div
                key={item.id}
                className={cn(
                  "canvas-viewport-item absolute rounded-[2px]",
                  `is-${kind}`,
                  kind === "image"
                    ? "bg-ink/16"
                    : kind === "text"
                      ? "bg-accent/22"
                      : kind === "shape"
                        ? "border border-ink/24"
                        : "bg-ink/10",
                )}
                style={r}
              />
            );
          })}
          <div
            className="canvas-viewport-window absolute border border-ink/18 bg-white/20 shadow-[0_0_0_1px_rgba(255,255,255,0.6)_inset]"
            style={viewMini}
          />
        </div>
      )}
      <div className="canvas-viewport-toolbar surface-popover flex items-center gap-0.5 p-1">
        <button
          onClick={() => setMapOpen((v) => !v)}
          className={cn(
            "canvas-viewport-button flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-ink-2 hover:bg-fill hover:text-ink",
            mapOpen && "bg-fill text-ink",
          )}
          aria-label="小地图"
        >
          <Map size={14} />
        </button>
        <button
          onClick={onZoomOut}
          className="canvas-viewport-button flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-ink-2 hover:bg-fill hover:text-ink"
          aria-label="缩小"
        >
          <Minus size={15} />
        </button>
        <button
          onClick={onFit}
          className="canvas-viewport-button canvas-viewport-zoom min-w-[54px] rounded-[var(--radius-sm)] px-1.5 text-center font-mono text-[12px] text-ink-2 hover:bg-fill hover:text-ink"
          title="适应内容"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={onZoomIn}
          className="canvas-viewport-button flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-ink-2 hover:bg-fill hover:text-ink"
          aria-label="放大"
        >
          <Plus size={15} />
        </button>
        <div className="canvas-viewport-divider mx-0.5 h-4 w-px bg-line" />
        <button
          onClick={onFit}
          className="canvas-viewport-button flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-ink-2 hover:bg-fill hover:text-ink"
          aria-label="适应内容"
        >
          <Maximize size={14} />
        </button>
      </div>
    </div>
  );
}

const EMPTY: CanvasItem[] = [];
