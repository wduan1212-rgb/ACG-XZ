"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Circle,
  Copy,
  Crosshair,
  Download,
  Eye,
  Hand,
  MessageSquare,
  Minus,
  MousePointer2,
  Layers,
  Palette,
  Scan,
  Send,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  Trash2,
  Triangle,
  Type,
  Wand2,
} from "lucide-react";
import { IconButton, Tooltip } from "@/components/ui";
import { TopBar } from "./TopBar";
import { Canvas } from "./Canvas";
import { AgentPanel } from "./AgentPanel";
import { ContextMenu, EnhanceMenu, Lightbox, type MenuEntry } from "./overlays";
import { ExportModal } from "./ExportModal";
import { RegionEditor } from "./RegionEditor";
import { StyleModal } from "./StyleModal";
import { AdjustModal } from "./AdjustModal";
import { useStudioActions } from "./useStudioActions";
import { persistCanvasBlob, platformFetch } from "@/lib/api";
import { rememberAssetSource } from "@/lib/assetCache";
import {
  blobToDataUrl,
  overlappingMarksFor,
  renderCanvasOutput,
} from "@/lib/canvasOutput";
import { anchorFor, findFreeSpot, footprintFor } from "@/lib/geometry";
import { downscaleDataUrl, fileToDownscaledDataUrl, upscaleDataUrl } from "@/lib/image";
import { homeHref, IS_PLATFORM_EMBED } from "@/lib/runtime";
import { buildStoreZip } from "@/lib/storeZip";
import {
  buildCanvasPublishRequest,
  buildCanvasCommunityShareRequest,
  canvasPlatformCapabilitiesFromBootstrap,
  postCanvasCommunityShareRequest,
  postCanvasPublishRequest,
} from "@/lib/platformBridge";
import { useStore, type Viewport } from "@/lib/store";
import { uid } from "@/lib/util";
import { isImageItem } from "@/lib/types";
import type {
  ArtboardItem,
  CanvasItem,
  GenerationItem,
  ImageItem,
  ReferenceItem,
  ShapeItem,
  ShapeKind,
  TextItem,
  ToolId,
  Vec2,
} from "@/lib/types";

export function Workspace({ projectId }: { projectId: string }) {
  const platformCapabilities = canvasPlatformCapabilitiesFromBootstrap();
  const allowPublish = !IS_PLATFORM_EMBED || platformCapabilities.canPublish;
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const addItem = useStore((s) => s.addItem);
  const updateItem = useStore((s) => s.updateItem);
  const removeItems = useStore((s) => s.removeItems);
  const setSelection = useStore((s) => s.setSelection);
  const clearSelection = useStore((s) => s.clearSelection);
  const addReference = useStore((s) => s.addReference);
  const clearReferences = useStore((s) => s.clearReferences);
  const activeTool = useStore((s) => s.activeTool);
  const setTool = useStore((s) => s.setTool);
  const { generate, enhance } = useStudioActions(projectId);

  const selection = useStore((s) => s.selection);
  const viewport = useStore((s) => s.viewportByProject[projectId]);
  const reactiveItems = useStore((s) => s.itemsByProject[projectId] ?? EMPTY_ITEMS);
  const selectedImage =
    selection.length === 1
      ? reactiveItems.find(
          (i): i is ImageItem => i.id === selection[0] && isImageItem(i),
        )
      : undefined;
  const selectedImageReady =
    !!selectedImage &&
    !!selectedImage.assetUrl &&
    !selectedImage.hidden &&
    !("loading" in selectedImage && selectedImage.loading);
  const selectedImages = selection
    .map((id) => reactiveItems.find((item) => item.id === id))
    .filter((item): item is ImageItem => !!item && isImageItem(item) && !!item.assetUrl && !item.hidden && !("loading" in item && item.loading));
  const selectedMark =
    selection.length === 1
      ? reactiveItems.find(
          (i): i is TextItem | ShapeItem =>
            i.id === selection[0] && (i.type === "text" || i.type === "shape"),
        )
      : undefined;

  const [menu, setMenu] = useState<{ item: CanvasItem; pos: Vec2 } | null>(null);
  const [enhanceMenu, setEnhanceMenu] = useState<{ item: ImageItem; pos: Vec2 } | null>(null);
  const [lightbox, setLightbox] = useState<CanvasItem | null>(null);
  const [exportItem, setExportItem] = useState<CanvasItem | null>(null);
  const [regionItem, setRegionItem] = useState<ImageItem | null>(null);
  const [styleItem, setStyleItem] = useState<ImageItem | null>(null);
  const [adjustItem, setAdjustItem] = useState<ImageItem | null>(null);
  const [publishNotice, setPublishNotice] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [sharedItemIds, setSharedItemIds] = useState<Set<string>>(() => new Set());
  const publishNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageClipboard = useRef<ImageItem[]>([]);

  const showPublishNotice = useCallback((message: string) => {
    setPublishNotice(message);
    if (publishNoticeTimer.current) clearTimeout(publishNoticeTimer.current);
    publishNoticeTimer.current = setTimeout(() => {
      setPublishNotice("");
      publishNoticeTimer.current = null;
    }, 4200);
  }, []);

  useEffect(
    () => () => {
      if (publishNoticeTimer.current) clearTimeout(publishNoticeTimer.current);
    },
    [],
  );

  useEffect(() => {
    const receiveCommunityStatus = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      const message = event.data && typeof event.data === "object" ? event.data : {};
      if (message.type !== "custom-canvas:community-shared") return;
      if (String(message.projectId || "") !== projectId) return;
      const itemId = String(message.sourceItemId || "").trim();
      if (!itemId) return;
      setSharedItemIds((current) => new Set([...current, itemId]));
    };
    window.addEventListener("message", receiveCommunityStatus);
    return () => window.removeEventListener("message", receiveCommunityStatus);
  }, [projectId]);

  useEffect(() => {
    // ProjectClient mounts Workspace only after the owner-scoped project state
    // has been independently read back and verified.
    // Brief + reference images handed off from the homepage hero.
    const refsKey = `aidc:refs:${projectId}`;
    const refsRaw = sessionStorage.getItem(refsKey);
    if (refsRaw) {
      sessionStorage.removeItem(refsKey);
      try {
        for (const rid of JSON.parse(refsRaw) as string[]) addReference(rid, "style");
      } catch {
        /* ignore bad payload */
      }
    }
    const key = `aidc:brief:${projectId}`;
    const pending = sessionStorage.getItem(key);
    if (pending !== null) {
      sessionStorage.removeItem(key);
      generate(pending, { size: project?.targetSize });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    for (const item of reactiveItems) {
      if (item.type !== "enhanced") continue;
      const parent = reactiveItems.find((it) => it.id === item.parentItemId);
      if (!parent || !isImageItem(parent)) continue;
      const itemAspect = item.naturalWidth / item.naturalHeight;
      const parentAspect = parent.naturalWidth / parent.naturalHeight;
      const displayDiff =
        Math.abs(item.size.width - parent.size.width) > 1 ||
        Math.abs(item.size.height - parent.size.height) > 1;
      if (Math.abs(itemAspect - parentAspect) < 0.01 && displayDiff) {
        updateItem(projectId, item.id, {
          size: { ...parent.size },
        } as Partial<CanvasItem>);
      }
    }
  }, [projectId, reactiveItems, updateItem]);

  /** Region-edit result → new card beside the source, upscaled to source resolution. */
  const applyRegionEdit = useCallback(
    async (src: ImageItem, dataUrl: string, w: number, h: number, note: string) => {
      let finalUrl = dataUrl;
      let W = w;
      let H = h;
      try {
        const up = await upscaleDataUrl(dataUrl, src.naturalWidth, src.naturalHeight);
        finalUrl = up.dataUrl;
        W = up.width;
        H = up.height;
      } catch {
        /* keep master size */
      }
      const items = (useStore.getState().itemsByProject[projectId] ?? []).filter((it) => !it.hidden);
      const fp = footprintFor(W, H, 340);
      const pos = findFreeSpot(
        items,
        { x: src.position.x + src.size.width + 40, y: src.position.y },
        fp,
        28,
      );
      const item: ReferenceItem | ImageItem = {
        id: uid("item"),
        projectId,
        type: "generation",
        position: pos,
        size: fp,
        z: src.z + 1,
        createdAt: Date.now(),
        assetUrl: finalUrl,
        naturalWidth: W,
        naturalHeight: H,
        label: `区域修改 · ${note.slice(0, 10)}`,
        mode: "final",
        quality: "high",
        jobId: uid("job"),
        provenance: { fromItemId: src.id, brief: note },
      };
      addItem(projectId, item);
      setSelection([item.id]);
    },
    [projectId, addItem, setSelection],
  );

  /** Drop a derived image beside its source card. */
  const addDerived = useCallback(
    (src: ImageItem, dataUrl: string, W: number, H: number, label: string) => {
      const items = (useStore.getState().itemsByProject[projectId] ?? []).filter((it) => !it.hidden);
      const fp = footprintFor(W, H, 340);
      const pos = findFreeSpot(
        items,
        { x: src.position.x + src.size.width + 40, y: src.position.y },
        fp,
        28,
      );
      const item: GenerationItem = {
        id: uid("item"),
        projectId,
        type: "generation",
        position: pos,
        size: fp,
        z: src.z + 1,
        createdAt: Date.now(),
        assetUrl: dataUrl,
        naturalWidth: W,
        naturalHeight: H,
        label,
        mode: "final",
        quality: "high",
        jobId: uid("job"),
        provenance: { fromItemId: src.id },
      };
      addItem(projectId, item);
      setSelection([item.id]);
    },
    [projectId, addItem, setSelection],
  );

  /** Spawn a loading card beside `src` on the canvas. */
  const mkJobCard = useCallback(
    (src: ImageItem, label: string): string => {
      const cur = (useStore.getState().itemsByProject[projectId] ?? []).filter((it) => !it.hidden);
      const fp = footprintFor(src.naturalWidth, src.naturalHeight, 300);
      const pos = findFreeSpot(
        cur,
        { x: src.position.x + src.size.width + 40, y: src.position.y },
        fp,
        28,
      );
      const id = uid("item");
      addItem(projectId, {
        id,
        projectId,
        type: "generation",
        position: pos,
        size: fp,
        z: src.z + 1,
        createdAt: Date.now(),
        assetUrl: "",
        naturalWidth: src.naturalWidth,
        naturalHeight: src.naturalHeight,
        label,
        mode: "final",
        quality: "high",
        jobId: id,
        loading: true,
        provenance: { fromItemId: src.id },
      } as GenerationItem);
      return id;
    },
    [projectId, addItem],
  );

  /** Run one /api/transform edit and fill card `id` with the result. */
  const runTransformJob = useCallback(
    async (src: ImageItem, id: string, prompt: string, doneLabel?: string) => {
      try {
        const small = await downscaleDataUrl(src.assetUrl, 1280, 0.9);
        const res = await platformFetch("/transform", {
          method: "POST",
          body: JSON.stringify({
            image: small.dataUrl,
            prompt,
            size: `${src.naturalWidth}x${src.naturalHeight}`,
            fidelity: "high",
            quality: "low",
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.image) throw new Error(data.error || "处理失败");
        updateItem(projectId, id, {
          assetUrl: data.image.dataUrl,
          naturalWidth: data.image.width,
          naturalHeight: data.image.height,
          ...(doneLabel ? { label: doneLabel } : {}),
          loading: false,
        } as Partial<CanvasItem>);
      } catch {
        removeItems(projectId, [id]);
      }
    },
    [projectId, updateItem, removeItems],
  );

  /**
   * 元素分层: the image model itself does the seeing — pass A redraws every
   * element laid out separately on a pure white background (no chroma key, no
   * auto-crop: keying green destroyed green-heavy artwork); pass B removes the
   * foreground and rebuilds a clean background plate. Both run in parallel.
   */
  const layerSplit = useCallback(
    async (src: ImageItem) => {
      const elemsId = mkJobCard(src, "拆解元素中");
      const bgId = mkJobCard(src, "补全背景中");
      setSelection([elemsId]);
      await Promise.allSettled([
        runTransformJob(
          src,
          elemsId,
          "把画面中的每一个元素（人物、角色、物件、文字标题、装饰）分别完整地拆解出来，平铺排列在纯白色背景上：元素之间留出空隙、互不重叠、不互相遮挡；每个元素保持原图中的外观、比例、细节与文字内容完全不变，不要新增或遗漏元素",
          "元素拆解 · 白底",
        ),
        runTransformJob(
          src,
          bgId,
          "去掉画面中所有前景元素（人物、角色、物件、装饰与文字），只保留纯背景场景，把被遮挡的区域按原有风格自然补全，背景其余部分保持原样不变",
          "背景层",
        ),
      ]);
    },
    [mkJobCard, runTransformJob, setSelection],
  );

  /** 风格转换: fire-and-forget — the result lands on the canvas as a new card. */
  const styleRemix = useCallback(
    (src: ImageItem, styleLabel: string, stylePrompt: string) => {
      const id = mkJobCard(src, `风格 · ${styleLabel}`);
      setSelection([id]);
      void runTransformJob(src, id, stylePrompt);
    },
    [mkJobCard, runTransformJob, setSelection],
  );

  const centerWorld = useCallback((): Vec2 => {
    const host = document.querySelector<HTMLElement>("[data-canvas-host]");
    const vp = useStore.getState().viewportByProject[projectId] ?? { x: 0, y: 0, zoom: 1 };
    const w = host?.clientWidth ?? 900;
    const h = host?.clientHeight ?? 640;
    return { x: (w / 2 - vp.x) / vp.zoom, y: (h / 2 - vp.y) / vp.zoom };
  }, [projectId]);

  const addUploadedFiles = useCallback(
    async (files: FileList | File[], asReference: boolean) => {
      const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
      for (const file of list) {
        try {
          const { dataUrl, originalDataUrl, width, height } = await fileToDownscaledDataUrl(file);
          const fp = footprintFor(width, height, 320);
          const items = (useStore.getState().itemsByProject[projectId] ?? []).filter((it) => !it.hidden);
          // Imported and clipboard images join the same deterministic strip as
          // generated results. Re-read the store for every file so a multi-file
          // drop advances one card at a time instead of reusing one viewport
          // anchor and producing a spiral that looks random.
          const pos = findFreeSpot(items, anchorFor(items), fp, 28);
          const name = file.name.replace(/\.[^.]+$/, "").slice(0, 18) || "参考图";
          const item: ReferenceItem = {
            id: uid("item"),
            projectId,
            type: "reference",
            position: pos,
            size: fp,
            z: 30,
            createdAt: Date.now(),
            assetUrl: dataUrl,
            naturalWidth: width,
            naturalHeight: height,
            source: "upload",
            label: name,
            hidden: asReference,
          };
          addItem(projectId, item);
          rememberAssetSource(item.id, originalDataUrl);
          if (asReference) addReference(item.id, "style");
          else setSelection([item.id]);
        } catch {
          /* skip bad file */
        }
      }
    },
    [projectId, addItem, setSelection, addReference],
  );

  const pasteCopiedImages = useCallback(() => {
    if (!imageClipboard.current.length) return false;
    const ids: string[] = [];
    imageClipboard.current.forEach((source, index) => {
      const item: ImageItem = {
        ...source,
        id: uid("item"),
        projectId,
        position: { x: source.position.x + 32 + index * 10, y: source.position.y + 32 + index * 10 },
        z: source.z + 1 + index,
        createdAt: Date.now() + index,
        label: `${source.label || "图片"} 副本`,
      };
      addItem(projectId, item);
      ids.push(item.id);
    });
    setSelection(ids);
    return true;
  }, [addItem, projectId, setSelection]);

  const batchExportSelection = useCallback(async () => {
    if (!selectedImages.length) return;
    showPublishNotice(`正在导出 ${selectedImages.length} 张图片…`);
    try {
      const entries = await Promise.all(
        selectedImages.map(async (item, index) => {
          const rendered = await renderCanvasOutput({
            imageItem: item,
            marks: overlappingMarksFor(item, reactiveItems),
            targetWidth: item.naturalWidth,
            targetHeight: item.naturalHeight,
            mime: "image/png",
          });
          const baseName = (item.label || project?.name || "无限画布作品")
            .replace(/[\\/:*?"<>|]+/g, "-")
            .slice(0, 80);
          return { name: `${baseName}-${index + 1}.png`, blob: rendered.blob };
        }),
      );
      const zip = await buildStoreZip(entries);
      const href = URL.createObjectURL(zip);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${(project?.name || "无限画布作品").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80)}-${selectedImages.length}张.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 4000);
      showPublishNotice(`已导出 ${selectedImages.length} 张选中图片。`);
    } catch (error) {
      showPublishNotice(error instanceof Error ? `批量导出失败：${error.message}` : "批量导出失败，请重试。");
    }
  }, [project, reactiveItems, selectedImages, showPublishNotice]);

  const addTextMark = useCallback(() => {
    const c = centerWorld();
    const size = { width: 220, height: 90 };
    const items = (useStore.getState().itemsByProject[projectId] ?? []).filter((it) => !it.hidden);
    const item: TextItem = {
      id: uid("item"),
      projectId,
      type: "text",
      position: findFreeSpot(items, { x: c.x - size.width / 2, y: c.y - size.height / 2 }, size, 24),
      size,
      z: 50,
      createdAt: Date.now(),
      text: "双击编辑文字",
      color: "#111827",
      fontSize: 18,
    };
    addItem(projectId, item);
    setSelection([item.id]);
  }, [projectId, addItem, setSelection, centerWorld]);

  const addShapeMark = useCallback(
    (shape: ShapeKind) => {
      const c = centerWorld();
      const size =
        shape === "line" || shape === "arrow"
          ? { width: 180, height: 110 }
          : shape === "ellipse" || shape === "star"
            ? { width: 120, height: 120 }
            : { width: 150, height: 110 };
      const items = (useStore.getState().itemsByProject[projectId] ?? []).filter((it) => !it.hidden);
      const item: ShapeItem = {
        id: uid("item"),
        projectId,
        type: "shape",
        position: findFreeSpot(items, { x: c.x - size.width / 2, y: c.y - size.height / 2 }, size, 24),
        size,
        z: 50,
        createdAt: Date.now(),
        shape,
        stroke: "#0b6bff",
        fill: shape === "line" || shape === "arrow" ? "none" : "rgba(11,107,255,0.08)",
        strokeWidth: 4,
      };
      addItem(projectId, item);
      setSelection([item.id]);
    },
    [projectId, addItem, setSelection, centerWorld],
  );

  const generateSimilar = useCallback(
    (item: ImageItem) => {
      addReference(item.id, "style");
      generate("参考这张图，生成相似风格与构图的一版海报");
    },
    [addReference, generate],
  );

  const duplicateArtboard = useCallback(
    (src: ArtboardItem) => {
      const item: ArtboardItem = {
        ...src,
        id: uid("item"),
        position: { x: src.position.x + 40, y: src.position.y + 40 },
        createdAt: Date.now(),
      };
      addItem(projectId, item);
      setSelection([item.id]);
    },
    [projectId, addItem, setSelection],
  );

  async function requestPublish() {
    if (!allowPublish) {
      showPublishNotice("当前账号不包含发布能力。");
      return;
    }
    if (!selectedImageReady || !selectedImage) {
      showPublishNotice("当前项目还没有可发布图片，请先生成或上传图片。");
      return;
    }
    setPublishing(true);
    try {
      const rendered = await renderCanvasOutput({
        imageItem: selectedImage,
        marks: overlappingMarksFor(selectedImage, reactiveItems),
        targetWidth: selectedImage.naturalWidth,
        targetHeight: selectedImage.naturalHeight,
        mime: "image/png",
      });
      const dataUrl = await blobToDataUrl(rendered.blob);
      const baseName = (selectedImage.label || project?.name || "无限画布作品")
        .trim()
        .replace(/\.[a-z0-9]{2,5}$/i, "")
        .slice(0, 120);
      const request = buildCanvasPublishRequest({
        projectId,
        title: project?.name || "无限画布作品",
        item: {
          url: "",
          dataUrl,
          name: `${baseName || "无限画布作品"}.png`,
          mime: "image/png",
          sourceItemId: selectedImage.id,
        },
      });
      if (!request) throw new Error("图片合成结果无效");
      if (!postCanvasPublishRequest(request)) {
        showPublishNotice("发布功能仅在星阵主平台的“定制创作”中可用。");
        return;
      }
      showPublishNotice("已发送选中图片，正在打开发布设置…");
    } catch (error) {
      showPublishNotice(
        error instanceof Error ? `发布准备失败：${error.message}` : "发布准备失败，请重试。",
      );
    } finally {
      setPublishing(false);
    }
  }

  async function requestCommunityShare() {
    if (!selectedImageReady || !selectedImage || sharedItemIds.has(selectedImage.id)) return;
    setSharing(true);
    try {
      const rendered = await renderCanvasOutput({
        imageItem: selectedImage,
        marks: overlappingMarksFor(selectedImage, reactiveItems),
        targetWidth: selectedImage.naturalWidth,
        targetHeight: selectedImage.naturalHeight,
        mime: "image/png",
      });
      const dataUrl = await blobToDataUrl(rendered.blob);
      // Community posts must reference a stable owner-scoped URL. Persisting
      // the flattened result also keeps annotations without embedding a large
      // Base64 payload in the post or project draft.
      const persisted = await persistCanvasBlob(dataUrl, selectedImage.id);
      const baseName = (selectedImage.label || project?.name || "无限画布作品").trim().replace(/\.[a-z0-9]{2,5}$/i, "").slice(0, 120);
      const request = buildCanvasCommunityShareRequest({
        projectId,
        title: project?.name || "无限画布作品",
        item: {
          url: persisted.assetUrl,
          dataUrl: persisted.assetUrl.startsWith("data:image/") ? persisted.assetUrl : "",
          name: `${baseName || "无限画布作品"}.png`,
          mime: "image/png",
          sourceItemId: selectedImage.id,
        },
      });
      if (!request || !postCanvasCommunityShareRequest(request)) {
        showPublishNotice("分享灵感仅在星阵主平台中可用。");
      }
    } catch (error) {
      showPublishNotice(error instanceof Error ? `分享准备失败：${error.message}` : "分享准备失败，请重试。");
    } finally {
      setSharing(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable)
        return;
      // The lightbox owns Escape and arrow navigation while it is open. Letting
      // the canvas handler update selection at the same time creates two active
      // image states and can leave the enlarged picture visually unchanged.
      if (lightbox) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "c") {
        const images = useStore.getState().selection
          .map((id) => (useStore.getState().itemsByProject[projectId] ?? []).find((item) => item.id === id))
          .filter((item): item is ImageItem => !!item && isImageItem(item));
        if (images.length) {
          e.preventDefault();
          imageClipboard.current = images.map((item) => ({ ...item, position: { ...item.position }, size: { ...item.size } }));
          showPublishNotice(`已复制 ${images.length} 张图片，可按 Command+V 粘贴。`);
          const firstUrl = images[0]?.assetUrl;
          if (firstUrl && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
            void fetch(firstUrl).then((response) => response.blob()).then((blob) => navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })])).catch(() => {});
          }
        }
        return;
      }
      if (meta && e.key.toLowerCase() === "v") return;
      if (meta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelection((useStore.getState().itemsByProject[projectId] ?? []).map((i) => i.id));
        return;
      }
      if (meta) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = useStore.getState().selection;
        if (sel.length) removeItems(projectId, sel);
      } else if (e.key === "Escape") {
        clearSelection();
        setMenu(null);
        setEnhanceMenu(null);
      } else if (e.key.toLowerCase() === "v") {
        setTool("select");
      } else if (e.key.toLowerCase() === "h") {
        setTool("hand");
      } else if (e.key.toLowerCase() === "t") {
        addTextMark();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const images = (useStore.getState().itemsByProject[projectId] ?? []).filter((item): item is ImageItem => !item.hidden && isImageItem(item));
        if (!images.length) return;
        e.preventDefault();
        const currentId = useStore.getState().selection.find((id) => images.some((item) => item.id === id));
        const currentIndex = Math.max(0, images.findIndex((item) => item.id === currentId));
        const offset = e.key === "ArrowRight" ? 1 : -1;
        setSelection([images[(currentIndex + offset + images.length) % images.length].id]);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return;
      const imageFiles = Array.from(e.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length) {
        e.preventDefault();
        void addUploadedFiles(imageFiles, false);
      } else if (pasteCopiedImages()) {
        e.preventDefault();
        showPublishNotice(`已粘贴 ${imageClipboard.current.length} 张图片。`);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, [projectId, setSelection, clearSelection, removeItems, setTool, addTextMark, addUploadedFiles, pasteCopiedImages, showPublishNotice, lightbox]);

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-2">
        项目不存在或已删除。
        <Link href={homeHref()} className="ml-2 text-accent hover:underline">
          返回首页
        </Link>
      </div>
    );
  }

  function buildEntries(item: CanvasItem, pos: Vec2): MenuEntry[] {
    if (isImageItem(item)) {
      return [
        {
          type: "item",
          label: "区域修改 · 框选批注",
          icon: <Scan size={14} />,
          onClick: () => setRegionItem(item),
        },
        {
          type: "item",
          label: "对话修改",
          icon: <MessageSquare size={14} />,
          onClick: () => {
            clearReferences();
            addReference(item.id, "style");
            setSelection([item.id]);
            window.dispatchEvent(new CustomEvent("focus-composer"));
          },
        },
        { type: "item", label: "作为参考", icon: <Crosshair size={14} />, onClick: () => addReference(item.id, "style") },
        { type: "item", label: "生成相似", icon: <Wand2 size={14} />, onClick: () => generateSimilar(item) },
        { type: "item", label: "风格转换", icon: <Palette size={14} />, onClick: () => setStyleItem(item) },
        { type: "item", label: "元素分层", icon: <Layers size={14} />, onClick: () => layerSplit(item) },
        { type: "item", label: "后期调整", icon: <SlidersHorizontal size={14} />, onClick: () => setAdjustItem(item) },
        { type: "item", label: "高清增强", icon: <Sparkles size={14} />, onClick: () => setEnhanceMenu({ item, pos }) },
        { type: "sep" },
        { type: "item", label: "预览大图", icon: <Eye size={14} />, onClick: () => setLightbox(item) },
        { type: "item", label: "导出", icon: <Download size={14} />, onClick: () => setExportItem(item) },
        { type: "sep" },
        { type: "item", label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => removeItems(projectId, [item.id]) },
      ];
    }
    if (item.type === "artboard") {
      return [
        { type: "item", label: "复制", icon: <Copy size={14} />, onClick: () => duplicateArtboard(item) },
        { type: "sep" },
        { type: "item", label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => removeItems(projectId, [item.id]) },
      ];
    }
    return [
      { type: "item", label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => removeItems(projectId, [item.id]) },
    ];
  }

  return (
    <div className="relative flex h-full w-full flex-col">
      <TopBar
        projectId={projectId}
        onExport={() => selectedImages.length === 1 ? setExportItem(selectedImages[0]) : void batchExportSelection()}
        onPublish={requestPublish}
        onShare={requestCommunityShare}
        canExport={selectedImages.length > 0}
        exportCount={selectedImages.length}
        canPublish={allowPublish && selectedImageReady}
        canShare={selectedImageReady}
        showPublish={allowPublish}
        embedded={IS_PLATFORM_EMBED}
        publishing={publishing}
        sharing={sharing}
        shared={Boolean(selectedImage && sharedItemIds.has(selectedImage.id))}
        publishNotice={publishNotice}
      />
      <div className="flex min-h-0 flex-1">
        <div
          className="relative min-w-0 flex-1"
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length) addUploadedFiles(e.dataTransfer.files, false);
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          <Canvas
            projectId={projectId}
            onMenu={(item, pos) => setMenu({ item, pos })}
            onPreview={(item) => setLightbox(item)}
          />
          <CanvasTools
            activeTool={activeTool}
            canMarkImage={!!selectedImage}
            onTool={(tool) => setTool(tool)}
            onMarkImage={() => selectedImage && setRegionItem(selectedImage)}
            onAddText={addTextMark}
            onAddShape={addShapeMark}
          />
          {selectedImage &&
            selection.length === 1 &&
            !("loading" in selectedImage && selectedImage.loading) && (
              <SelectionQuickBar
                item={selectedImage}
                viewport={viewport}
                onEnhance={(pos) => setEnhanceMenu({ item: selectedImage, pos })}
                onRegion={() => setRegionItem(selectedImage)}
                onTalk={() => {
                  clearReferences();
                  addReference(selectedImage.id, "style");
                  window.dispatchEvent(new CustomEvent("focus-composer"));
                }}
                onSimilar={() => generateSimilar(selectedImage)}
                onPreview={() => setLightbox(selectedImage)}
                onExport={() => setExportItem(selectedImage)}
                onPublish={requestPublish}
                onShare={requestCommunityShare}
                allowPublish={allowPublish}
                publishing={publishing}
                sharing={sharing}
                shared={sharedItemIds.has(selectedImage.id)}
                onDelete={() => removeItems(projectId, [selectedImage.id])}
              />
            )}
          {selectedMark && (
            <MarkQuickBar
              item={selectedMark}
              viewport={viewport}
              onPatch={(patch) => updateItem(projectId, selectedMark.id, patch)}
              onDelete={() => removeItems(projectId, [selectedMark.id])}
            />
          )}
        </div>
        <div className="w-[380px] shrink-0 border-l border-line">
          <AgentPanel
            projectId={projectId}
            onAttachFiles={(files) => addUploadedFiles(files, true)}
            onPreviewItem={(id) => {
              const item = reactiveItems.find((candidate) => candidate.id === id);
              if (!item || !isImageItem(item)) return;
              setSelection([id]);
              setLightbox(item);
            }}
          />
        </div>
      </div>

      {menu && (
        <ContextMenu pos={menu.pos} entries={buildEntries(menu.item, menu.pos)} onClose={() => setMenu(null)} />
      )}
      {enhanceMenu && (
        <EnhanceMenu
          pos={enhanceMenu.pos}
          item={enhanceMenu.item}
          onPick={(op, options) => enhance(enhanceMenu.item.id, op, options)}
          onClose={() => setEnhanceMenu(null)}
        />
      )}
      {lightbox && (
        <Lightbox
          item={lightbox}
          onClose={() => setLightbox(null)}
          onActiveChange={(nextItem) => {
            setSelection([nextItem.id]);
          }}
        />
      )}
      {styleItem && (
        <StyleModal
          item={styleItem}
          onClose={() => setStyleItem(null)}
          onPick={(label, prompt) => styleRemix(styleItem, label, prompt)}
        />
      )}
      {adjustItem && (
        <AdjustModal
          item={adjustItem}
          onClose={() => setAdjustItem(null)}
          onApplied={(d, w, h) => addDerived(adjustItem, d, w, h, `${adjustItem.label ?? "图片"} · 调整`)}
        />
      )}
      {regionItem && (
        <RegionEditor
          item={regionItem}
          onClose={() => setRegionItem(null)}
          onApplied={(dataUrl, w, h, note) =>
            applyRegionEdit(regionItem, dataUrl, w, h, note)
          }
        />
      )}
      <ExportModal item={exportItem} projectId={projectId} onClose={() => setExportItem(null)} />
    </div>
  );
}

function CanvasTools({
  activeTool,
  canMarkImage,
  onTool,
  onMarkImage,
  onAddText,
  onAddShape,
}: {
  activeTool: ToolId;
  canMarkImage: boolean;
  onTool: (tool: ToolId) => void;
  onMarkImage: () => void;
  onAddText: () => void;
  onAddShape: (shape: ShapeKind) => void;
}) {
  const [shapeOpen, setShapeOpen] = useState(false);
  const toolClass =
    "h-10 w-10 rounded-[var(--radius-sm)] transition-transform hover:-translate-y-0.5";
  const shapes: { kind: ShapeKind; label: string; icon: ReactNode }[] = [
    { kind: "rect", label: "矩形", icon: <Square size={15} /> },
    { kind: "ellipse", label: "椭圆", icon: <Circle size={15} /> },
    { kind: "line", label: "线条", icon: <Minus size={15} /> },
    { kind: "arrow", label: "箭头", icon: <ArrowUpRight size={15} /> },
    { kind: "triangle", label: "三角形", icon: <Triangle size={15} /> },
    { kind: "star", label: "星形", icon: <Star size={15} /> },
  ];
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
      <div className="surface-popover pointer-events-auto flex items-center gap-1 rounded-[18px] bg-white/92 p-1.5 backdrop-blur-md">
        <Tooltip label="选择" side="top" kbd="V">
          <IconButton
            active={activeTool === "select"}
            onClick={() => onTool("select")}
            className={toolClass}
            aria-label="选择"
          >
            <MousePointer2 size={20} />
          </IconButton>
        </Tooltip>
        <Tooltip label="手型移动画布" side="top" kbd="H">
          <IconButton
            active={activeTool === "hand"}
            onClick={() => onTool("hand")}
            className={toolClass}
            aria-label="手型移动画布"
          >
            <Hand size={19} />
          </IconButton>
        </Tooltip>
        <Tooltip label={canMarkImage ? "框选修改选中图片" : "选中图片后可框选修改"} side="top">
          <IconButton
            onClick={onMarkImage}
            disabled={!canMarkImage}
            className={toolClass}
            aria-label="框选修改"
          >
            <Scan size={19} />
          </IconButton>
        </Tooltip>
        <div className="mx-1 h-5 w-px bg-line" />
        <Tooltip label="添加文字到画布" side="top" kbd="T">
          <IconButton onClick={onAddText} className={toolClass} aria-label="添加文字">
            <Type size={21} />
          </IconButton>
        </Tooltip>
        <div className="relative">
          {shapeOpen && (
            <div className="surface-popover absolute bottom-12 left-1/2 z-50 w-36 -translate-x-1/2 p-1 animate-pop">
              {shapes.map((shape) => (
                <button
                  key={shape.kind}
                  onClick={() => {
                    onAddShape(shape.kind);
                    setShapeOpen(false);
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[13px] text-ink-2 hover:bg-fill hover:text-ink"
                >
                  {shape.icon}
                  {shape.label}
                </button>
              ))}
            </div>
          )}
          <Tooltip label="添加图形到画布" side="top">
            <IconButton
              onClick={() => setShapeOpen((v) => !v)}
              className={toolClass}
              aria-label="添加图形"
            >
              <Square size={19} />
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

/** Lovart-style quick-action bar floating above the selected image. */
function SelectionQuickBar({
  item,
  viewport,
  onEnhance,
  onRegion,
  onTalk,
  onSimilar,
  onPreview,
  onExport,
  onPublish,
  onShare,
  allowPublish,
  publishing,
  sharing,
  shared,
  onDelete,
}: {
  item: ImageItem;
  viewport?: Viewport;
  onEnhance: (pos: Vec2) => void;
  onRegion: () => void;
  onTalk: () => void;
  onSimilar: () => void;
  onPreview: () => void;
  onExport: () => void;
  onPublish: () => void;
  onShare: () => void;
  allowPublish: boolean;
  publishing: boolean;
  sharing: boolean;
  shared: boolean;
  onDelete: () => void;
}) {
  const vp = viewport ?? { x: 0, y: 0, zoom: 1 };
  const left = vp.x + (item.position.x + item.size.width / 2) * vp.zoom;
  const top = Math.max(56, vp.y + item.position.y * vp.zoom - 34);
  const btn =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-ink-2 hover:bg-fill hover:text-ink";
  return (
    <div
      className="surface-popover absolute z-30 flex flex-nowrap -translate-x-1/2 -translate-y-full items-center gap-0.5 p-1 animate-pop"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        onClick={(e) => onEnhance({ x: e.clientX, y: e.clientY })}
        className="flex h-7 min-w-[58px] shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[var(--radius-sm)] px-2 text-[12px] font-medium leading-none text-ink hover:bg-fill"
        title="高清增强 / 超清放大"
      >
        <Sparkles size={14} className="text-accent" /> 高清
      </button>
      <div className="mx-0.5 h-4 w-px bg-line" />
      <button title="区域修改 · 框选批注" onClick={onRegion} className={btn}>
        <Scan size={14} />
      </button>
      <button title="对话修改" onClick={onTalk} className={btn}>
        <MessageSquare size={14} />
      </button>
      <button title="生成相似" onClick={onSimilar} className={btn}>
        <Wand2 size={14} />
      </button>
      <div className="mx-0.5 h-4 w-px bg-line" />
      <button title="放大预览" onClick={onPreview} className={btn}>
        <Eye size={14} />
      </button>
      <button title="导出" onClick={onExport} className={btn}>
        <Download size={14} />
      </button>
      {allowPublish && (
        <button
          type="button"
          title={publishing ? "正在准备发布…" : "发布"}
          aria-label={publishing ? "正在准备发布" : "发布"}
          onClick={onPublish}
          disabled={publishing}
          className={`${btn} disabled:cursor-wait disabled:opacity-45`}
        >
          <Send size={14} />
        </button>
      )}
      <button
        type="button"
        title={shared ? "已分享" : "分享灵感"}
        aria-label={shared ? "已分享" : "分享灵感"}
        onClick={onShare}
        disabled={sharing || shared}
        className={`${btn} disabled:cursor-default disabled:opacity-45`}
      >
        {shared ? <Star size={14} fill="currentColor" /> : <Send size={14} />}
      </button>
      <div className="mx-0.5 h-4 w-px bg-line" />
      <button
        title="删除"
        onClick={onDelete}
        className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-danger hover:bg-[var(--color-danger-weak)]"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

const MARK_COLORS = ["#171717", "#ffffff", "#006bff", "#ea001d"];

/** Style bar for a selected text/shape mark: color, size, delete. */
function MarkQuickBar({
  item,
  viewport,
  onPatch,
  onDelete,
}: {
  item: TextItem | ShapeItem;
  viewport?: Viewport;
  onPatch: (patch: Partial<CanvasItem>) => void;
  onDelete: () => void;
}) {
  const vp = viewport ?? { x: 0, y: 0, zoom: 1 };
  const left = vp.x + (item.position.x + item.size.width / 2) * vp.zoom;
  const top = Math.max(56, vp.y + item.position.y * vp.zoom - 34);
  const isText = item.type === "text";
  const current = isText ? item.color : item.stroke;
  const btn =
    "flex h-7 min-w-7 items-center justify-center rounded-[var(--radius-sm)] px-1 text-[12px] font-medium text-ink-2 hover:bg-fill hover:text-ink";

  const setFont = (f: number) => {
    if (item.type !== "text") return;
    // Scale the bounding box with the font so the selection stays snug.
    const factor = f / item.fontSize;
    onPatch({
      fontSize: f,
      size: {
        width: Math.max(60, Math.round(item.size.width * factor)),
        height: Math.max(28, Math.round(item.size.height * factor)),
      },
    } as Partial<CanvasItem>);
  };

  return (
    <div
      className="surface-popover absolute z-30 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 p-1 animate-pop"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {MARK_COLORS.map((c) => (
        <button
          key={c}
          title="颜色"
          onClick={() =>
            onPatch((isText ? { color: c } : { stroke: c }) as Partial<CanvasItem>)
          }
          className="flex h-6 w-6 items-center justify-center"
        >
          <span
            className={
              "h-4 w-4 rounded-full " +
              (current === c ? "ring-2 ring-accent ring-offset-1" : "")
            }
            style={{
              background: c,
              boxShadow: c === "#ffffff" ? "inset 0 0 0 1px rgba(0,0,0,0.18)" : undefined,
            }}
          />
        </button>
      ))}
      <div className="mx-0.5 h-4 w-px bg-line" />
      {isText ? (
        <>
          <button
            className={btn}
            title="减小字号"
            onClick={() => setFont(Math.max(8, item.fontSize - 2))}
          >
            A−
          </button>
          <input
            type="number"
            min={8}
            max={200}
            value={item.fontSize}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v)) setFont(Math.max(8, Math.min(200, v)));
            }}
            onPointerDown={(e) => e.stopPropagation()}
            title="字号"
            className="h-7 w-12 rounded-[var(--radius-sm)] border border-line bg-white px-1 text-center font-mono text-[12px] text-ink outline-none focus:border-accent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <button
            className={btn}
            title="增大字号"
            onClick={() => setFont(Math.min(200, item.fontSize + 2))}
          >
            A+
          </button>
        </>
      ) : (
        <>
          <button
            className={btn}
            title="线条细一点"
            onClick={() =>
              onPatch({ strokeWidth: Math.max(1, item.strokeWidth - 1) } as Partial<CanvasItem>)
            }
          >
            −
          </button>
          <button
            className={btn}
            title="线条粗一点"
            onClick={() =>
              onPatch({ strokeWidth: Math.min(16, item.strokeWidth + 1) } as Partial<CanvasItem>)
            }
          >
            ＋
          </button>
        </>
      )}
      <div className="mx-0.5 h-4 w-px bg-line" />
      <button
        title="删除"
        onClick={onDelete}
        className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-danger hover:bg-[var(--color-danger-weak)]"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

const EMPTY_ITEMS: CanvasItem[] = [];
