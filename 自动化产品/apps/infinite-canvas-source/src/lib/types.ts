/* =========================================================================
   Domain types — AI Design Canvas (PRD §11, §16)
   ========================================================================= */

export type Scene = "enterprise_poster" | "airport_screen" | "banner" | "brand_kv";

export type WorkspaceMode = "lite" | "pro";

/** Generation tiers (PRD §9.1) */
export type GenMode = "draft" | "review" | "final";
export type Quality = "low" | "medium" | "high";

/** Reference usage (PRD §6.5) */
export type ReferenceUsage =
  | "style"
  | "composition"
  | "color"
  | "subject"
  | "material"
  | "negative";

/** Enhance operations */
export type EnhanceOp = "deliver" | "airport" | "local2x" | "2x" | "4x";

export type EnhanceTargetMode = "mode" | "original" | "custom";

export interface EnhanceRunOptions {
  targetMode?: EnhanceTargetMode;
  targetSize?: Size;
  targetLabel?: string;
}

export type CanvasItemType =
  | "brief"
  | "reference"
  | "generation"
  | "artboard"
  | "enhanced"
  | "text"
  | "shape";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Where a generated asset came from — internal provenance (PRD §11.4) */
export interface Provenance {
  /** The paid request runs on the platform and can be recovered after navigation. */
  backgroundJob?: boolean;
  brief?: string;
  references?: ActiveReference[];
  prompt?: string;
  negativePrompt?: string;
  size?: string; // "1536x1024"
  quality?: Quality;
  fromItemId?: string; // produced as a "similar" variation of this item
  /** 1-based attached-reference position used by a targeted chat edit. */
  targetedReferenceIndex?: number;
  enhancedFrom?: string; // produced by enhancing this item
  enhanceMetrics?: {
    sharpnessBefore: number;
    sharpnessAfter: number;
    sharpnessDeltaPct: number;
  };
}

interface BaseItem {
  id: string;
  projectId: string;
  type: CanvasItemType;
  /** World coordinates of the top-left corner. */
  position: Vec2;
  /** Rendered card footprint on the canvas, in world units. */
  size: Size;
  z: number;
  createdAt: number;
  /** Reference-only attachments can stay in chat without rendering on canvas. */
  hidden?: boolean;
  /** Rotation in degrees around the item center. */
  rotation?: number;
}

export interface BriefItem extends BaseItem {
  type: "brief";
  text: string;
}

export interface ReferenceItem extends BaseItem {
  type: "reference";
  assetUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  source: "upload" | "generated" | "imported";
  label?: string;
}

export interface GenerationItem extends BaseItem {
  type: "generation";
  assetUrl: string; // empty while loading
  naturalWidth: number;
  naturalHeight: number;
  label: string;
  mode: GenMode;
  quality: Quality;
  jobId: string;
  provenance: Provenance;
  loading?: boolean; // true while the image is being generated
  generationStatus?: "queued" | "running" | "done" | "failed" | "interrupted";
  queuePosition?: number;
  queueTotal?: number;
  error?: string;
  /** Stable owner-scoped server output identifier when the image is persisted. */
  outputId?: string;
}

export interface EnhancedItem extends BaseItem {
  type: "enhanced";
  assetUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  label: string;
  operation: EnhanceOp;
  parentItemId: string;
  provenance: Provenance;
  loading?: boolean; // true while the HD result is being generated
  generationStatus?: "running" | "done" | "failed" | "interrupted";
  error?: string;
  outputId?: string;
}

export interface ArtboardItem extends BaseItem {
  type: "artboard";
  label: string;
  targetSize: Size; // real output pixel size
  scene: Scene;
  safeArea: boolean;
}

export interface TextItem extends BaseItem {
  type: "text";
  text: string;
  color: string;
  fontSize: number;
}

export type ShapeKind = "rect" | "line" | "arrow" | "ellipse" | "triangle" | "star";

export interface ShapeItem extends BaseItem {
  type: "shape";
  shape: ShapeKind;
  stroke: string;
  fill: string;
  strokeWidth: number;
}

export type CanvasItem =
  | BriefItem
  | ReferenceItem
  | GenerationItem
  | EnhancedItem
  | ArtboardItem
  | TextItem
  | ShapeItem;

/** A picture-bearing item that can be referenced or enhanced. */
export type ImageItem = ReferenceItem | GenerationItem | EnhancedItem;

export function isImageItem(item: CanvasItem): item is ImageItem {
  return (
    item.type === "reference" ||
    item.type === "generation" ||
    item.type === "enhanced"
  );
}

/** A reference attached to the composer with its chosen usage. */
export interface ActiveReference {
  itemId: string;
  usage: ReferenceUsage;
}

/* ---- Design Agent structured output (PRD §8.2) ---- */

export interface DesignStrategy {
  scene: string; // 场景判断
  audience: string; // 目标人群
  mood: string; // 画面气质
  keyVisual: string; // 主视觉建议
  composition: string; // 构图建议
  color: string; // 色彩建议
  negativeSpace: string; // 留白建议
  avoid: string[]; // 不建议出现的元素
}

export interface PromptPlan {
  prompt: string; // 正向提示词
  negativePrompt: string; // 负向约束
  referenceUsage: string; // 参考图用途摘要
  size: string; // 输出尺寸
  quality: Quality; // 质量档位
}

export type NextActionKind = "generate" | "refine" | "resize";

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  createdAt: number;
  references?: ActiveReference[];
  strategy?: DesignStrategy;
  plan?: PromptPlan;
  /** Palette key chosen by the agent, used when generating from this message. */
  palette?: string;
  /** Number of directions this message will generate. */
  genCount?: number;
  resultItemIds?: string[];
  status?: "thinking" | "done" | "partial" | "error";
}

/* ---- Background task queue (PRD §6.1 bottom bar) ---- */

export type TaskKind = "generate" | "enhance" | "export";
export type TaskStatus = "queued" | "running" | "completed" | "partial" | "failed";

export interface QueueTask {
  id: string;
  projectId: string;
  kind: TaskKind;
  label: string;
  status: TaskStatus;
  progress: number; // 0..1
  createdAt: number;
  cost?: number;
  error?: string;
  resultItemIds?: string[];
}

/* ---- Project (PRD §16.1) ---- */

export interface Project {
  id: string;
  name: string;
  scene: Scene;
  targetSize: string; // "7680x2160"
  createdAt: number;
  updatedAt: number;
  cost: number; // accumulated generation cost
  generations: number; // generation count
  failures: number;
  thumbnailUrl?: string;
  /** Owner-scoped delivery marker restored from the main platform. */
  publishedDeliveryId?: string;
  publishedAt?: number;
  publishedItemIds?: string[];
}

/* ---- Left toolbar (PRD §6.3) ---- */

export type ToolId =
  | "select"
  | "hand"
  | "upload"
  | "brief"
  | "artboard"
  | "text"
  | "logo"
  | "enhance"
  | "export"
  | "history";
