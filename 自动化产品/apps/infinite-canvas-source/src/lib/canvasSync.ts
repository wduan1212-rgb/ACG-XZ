import { platformFetch } from "./api";
import {
  CANVAS_OWNER,
  type CanvasProjectState,
  localCanvasGet,
  writeDurableCanvasValue,
} from "./canvasPersistence";
import { IS_PLATFORM_EMBED } from "./runtime";
import type { Project } from "./types";

export interface CanvasProjectPutPayload extends CanvasProjectState {
  project: Project;
  clientUpdatedAt: number;
  baseRevision?: number;
  migration?: true;
}

export interface CanvasServerProjectResponse {
  project: Project & { revision?: number; sourceId?: string };
  state: CanvasProjectState;
}

export interface CanvasProjectPutResult extends CanvasServerProjectResponse {
  outcome: "created" | "updated" | "unchanged" | "server-newer";
}

export interface CanvasServerProjectIndex {
  items: Array<Project & { revision?: number; sourceId?: string }>;
  tombstones: Array<{ sourceId: string; deletedAt?: number }>;
}

interface PendingDelete {
  sourceId: string;
  deletedAt: number;
  attempts: number;
}

const TOMBSTONE_KEY = `ai-design-canvas:v2:${CANVAS_OWNER}:pending-deletes`;
const putTimers = new Map<string, ReturnType<typeof setTimeout>>();
const putChains = new Map<string, Promise<void>>();
const putEpochs = new Map<string, number>();
let deleteFlush: Promise<void> | null = null;

export class CanvasSyncError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CanvasSyncError";
  }
}

async function readableResponseError(response: Response, fallback: string): Promise<CanvasSyncError> {
  try {
    const payload = await response.json() as { error?: unknown; message?: unknown; detail?: unknown };
    const detail = typeof payload.detail === "string"
      ? payload.detail
      : payload.detail && typeof payload.detail === "object"
        ? JSON.stringify(payload.detail)
        : "";
    return new CanvasSyncError(
      String(payload.error || payload.message || detail || fallback),
      response.status,
    );
  } catch {
    return new CanvasSyncError(fallback, response.status);
  }
}

function normalizeProject(value: unknown): (Project & { revision?: number; sourceId?: string }) | null {
  if (!value || typeof value !== "object") return null;
  const project = value as Partial<Project> & { revision?: unknown; sourceId?: unknown };
  const sourceId = String(project.sourceId || project.id || "").trim();
  if (!sourceId || typeof project.name !== "string" || !Number.isFinite(project.updatedAt)) return null;
  return {
    ...project,
    id: sourceId,
    sourceId,
    revision: Number.isFinite(Number(project.revision)) ? Number(project.revision) : undefined,
  } as Project & { revision?: number; sourceId?: string };
}

function normalizeState(value: unknown): CanvasProjectState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<CanvasProjectState>;
  if (!Array.isArray(state.items) || !Array.isArray(state.messages)) return null;
  let viewport = state.viewport;
  if (viewport && Object.keys(viewport).length === 0) viewport = undefined;
  if (viewport && (
    !Number.isFinite(viewport.x)
    || !Number.isFinite(viewport.y)
    || !Number.isFinite(viewport.zoom)
  )) return null;
  return { items: state.items, messages: state.messages, viewport };
}

export async function getCanvasProjectIndex(
  signal?: AbortSignal,
): Promise<CanvasServerProjectIndex> {
  const response = await platformFetch("/projects", { method: "GET", signal });
  if (!response.ok) throw await readableResponseError(response, `项目列表同步失败 (${response.status})`);
  const payload = await response.json() as { items?: unknown[]; tombstones?: unknown[] };
  const items = (Array.isArray(payload.items) ? payload.items : [])
    .map(normalizeProject)
    .filter((item): item is Project & { revision?: number; sourceId?: string } => !!item);
  const tombstones = (Array.isArray(payload.tombstones) ? payload.tombstones : [])
    .map((item) => {
      const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const sourceId = String(value.sourceId || value.id || "").trim();
      return sourceId ? { sourceId, deletedAt: Number(value.deletedAt || 0) || undefined } : null;
    })
    .filter((item): item is { sourceId: string; deletedAt: number | undefined } => !!item);
  return { items, tombstones };
}

export async function getCanvasProject(
  sourceId: string,
  signal?: AbortSignal,
): Promise<CanvasServerProjectResponse | null> {
  const response = await platformFetch(`/projects/${encodeURIComponent(sourceId)}`, {
    method: "GET",
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await readableResponseError(response, `项目恢复失败 (${response.status})`);
  const payload = await response.json() as { project?: unknown; state?: unknown };
  const state = normalizeState(payload.state);
  const project = normalizeProject(payload.project);
  if (!project || !state) throw new Error("服务器项目数据不完整");
  return { project, state };
}

export async function putCanvasProject(
  sourceId: string,
  payload: CanvasProjectPutPayload,
  signal?: AbortSignal,
): Promise<CanvasProjectPutResult> {
  const response = await platformFetch(`/projects/${encodeURIComponent(sourceId)}`, {
    method: "PUT",
    signal,
    body: JSON.stringify({
      project: payload.project,
      items: payload.items,
      messages: payload.messages,
      viewport: payload.viewport,
      clientUpdatedAt: payload.clientUpdatedAt,
      baseRevision: payload.baseRevision,
      migration: payload.migration,
    }),
  });
  if (!response.ok) throw await readableResponseError(response, `项目保存失败 (${response.status})`);
  const body = await response.json() as { project?: unknown; state?: unknown; outcome?: unknown };
  const project = normalizeProject(body.project);
  const state = normalizeState(body.state);
  const outcome = String(body.outcome || "") as CanvasProjectPutResult["outcome"];
  if (!project || !state || !["created", "updated", "unchanged", "server-newer"].includes(outcome)) {
    throw new Error("服务器保存回包不完整");
  }
  return { project, state, outcome };
}

export async function deleteCanvasProject(
  sourceId: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await platformFetch(`/projects/${encodeURIComponent(sourceId)}`, {
    method: "DELETE",
    signal,
  });
  if (!response.ok && response.status !== 404) {
    throw await readableResponseError(response, `项目删除同步失败 (${response.status})`);
  }
}

function readPendingDeletes(): PendingDelete[] {
  try {
    const parsed = JSON.parse(localCanvasGet(TOMBSTONE_KEY) || "[]") as PendingDelete[];
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.sourceId === "string" && item.sourceId)
      : [];
  } catch {
    return [];
  }
}

function writePendingDeletes(items: PendingDelete[]): boolean {
  return writeDurableCanvasValue(TOMBSTONE_KEY, JSON.stringify(items));
}

export function queueCanvasProjectDelete(sourceId: string): boolean {
  const pending = readPendingDeletes();
  if (pending.some((item) => item.sourceId === sourceId)) return true;
  pending.push({ sourceId, deletedAt: Date.now(), attempts: 0 });
  return writePendingDeletes(pending);
}

export function flushPendingCanvasProjectDeletes(): Promise<void> {
  if (!IS_PLATFORM_EMBED) return Promise.resolve();
  if (deleteFlush) return deleteFlush;
  deleteFlush = (async () => {
    const pending = readPendingDeletes();
    if (!pending.length) return;
    const attemptedIds = new Set(pending.map((item) => item.sourceId));
    const remaining: PendingDelete[] = [];
    for (const item of pending) {
      try {
        await deleteCanvasProject(item.sourceId);
      } catch {
        remaining.push({ ...item, attempts: item.attempts + 1 });
      }
    }
    // A delete queued while requests were in flight must survive this flush;
    // merge it with failed attempts instead of overwriting from a stale read.
    const concurrentlyQueued = readPendingDeletes().filter(
      (item) => !attemptedIds.has(item.sourceId),
    );
    writePendingDeletes([...concurrentlyQueued, ...remaining]);
  })().finally(() => {
    deleteFlush = null;
  });
  return deleteFlush;
}

export function cancelCanvasProjectPut(sourceId: string): void {
  const timer = putTimers.get(sourceId);
  if (timer) clearTimeout(timer);
  putTimers.delete(sourceId);
  // Already-running requests cannot be safely aborted after the server may
  // have committed them. The epoch invalidates only timers/queued providers;
  // the active response still reaches its callback so the caller can advance
  // baseRevision before sending the newest pending snapshot.
  putEpochs.set(sourceId, (putEpochs.get(sourceId) || 0) + 1);
}

export function scheduleCanvasProjectPut(
  sourceId: string,
  payload: () => CanvasProjectPutPayload | null,
  options: {
    delayMs?: number;
    onSuccess?: (result: CanvasProjectPutResult, sent: CanvasProjectPutPayload) => void;
    onError?: (error: unknown, sent: CanvasProjectPutPayload) => void;
  } = {},
): void {
  if (!IS_PLATFORM_EMBED) return;
  cancelCanvasProjectPut(sourceId);
  const epoch = putEpochs.get(sourceId) || 0;
  const timer = setTimeout(() => {
    putTimers.delete(sourceId);
    const previous = putChains.get(sourceId) || Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        // Evaluate lazily after the preceding request settles. This guarantees
        // that the provider sees the revision returned by that request and
        // prevents two PUTs carrying the same baseRevision.
        if ((putEpochs.get(sourceId) || 0) !== epoch) return;
        const next = payload();
        if (!next) return;
        try {
          const result = await putCanvasProject(sourceId, next);
          options.onSuccess?.(result, next);
        } catch (error) {
          // Local verified data remains authoritative while the server is offline.
          console.warn("[canvas-sync] project save deferred:", error);
          options.onError?.(error, next);
        }
      })
      .finally(() => {
        if (putChains.get(sourceId) === run) putChains.delete(sourceId);
      });
    putChains.set(sourceId, run);
  }, options.delayMs ?? 900);
  putTimers.set(sourceId, timer);
}
