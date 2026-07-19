"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { StateStorage } from "zustand/middleware";
import {
  canInstallCanvasCanonical,
  CANVAS_STORAGE_KEY,
  decideCanvasServerReconciliation,
  deleteCanvasProjectState,
  getCanvasPersistenceWarning,
  isCanvasProjectEmpty,
  localCanvasGet,
  localCanvasRemove,
  markLegacyProjectServerSynced,
  migrateLegacyCanvasEnvelope,
  pendingLegacyServerMigrationIds,
  readCanvasProject,
  readLegacyCanvasProject,
  selectCanvasThumbnailUrl,
  storeCanvasSummary,
  writeCanvasProjectVerified,
  type CanvasProjectState,
  type Viewport,
} from "./canvasPersistence";
import {
  cancelCanvasProjectPut,
  flushPendingCanvasProjectDeletes,
  getCanvasProject,
  getCanvasProjectIndex,
  putCanvasProject,
  queueCanvasProjectDelete,
  scheduleCanvasProjectPut,
  CanvasSyncError,
  type CanvasProjectPutPayload,
} from "./canvasSync";
import { parseSize } from "./sizing";
import { uid } from "./util";
import type {
  ActiveReference,
  CanvasItem,
  ChatMessage,
  GenMode,
  Project,
  QueueTask,
  ReferenceUsage,
  Scene,
  ToolId,
  Vec2,
} from "./types";

export type { Viewport } from "./canvasPersistence";

/* --- Storage that degrades gracefully (SSR + quota safe) --- */
const canvasBootStarted = typeof performance !== "undefined" ? performance.now() : 0;

const loadedCanvasProjects = new Set<string>();
const loadingCanvasProjects = new Map<string, Promise<boolean>>();
const canvasWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const canvasMutationGeneration = new Map<string, number>();
const suppressedCanvasProjects = new Set<string>();
const serverTombstonedProjects = new Set<string>();
const explicitlyEmptyCanvasProjects = new Set<string>();
const serverRefreshRequiredProjects = new Set<string>();
const conflictedCanvasProjects = new Set<string>();
// Compatibility name retained for the deployment snapshot audit. The new
// implementation performs backup + verified per-project readback before split.
const splitCanvasPersistence = migrateLegacyCanvasEnvelope;

const safeStorage: StateStorage = {
  getItem: (name) => {
    const value = localCanvasGet(name);
    if (!value) return null;
    return splitCanvasPersistence(name, value);
  },
  setItem: (name, value) => {
    storeCanvasSummary(name, value);
  },
  removeItem: (name) => {
    localCanvasRemove(name);
  },
};

interface CreateProjectInput {
  name: string;
  scene: Scene;
  targetSize: string;
}

export type CanvasProjectLoadState = "idle" | "loading" | "recovering" | "ready" | "error";

export interface PublishedProjectState {
  projectId: string;
  deliveryId: string;
  publishedAt?: number;
  itemIds?: string[];
}

interface AppState {
  /* ---- persisted ---- */
  projects: Project[];
  itemsByProject: Record<string, CanvasItem[]>;
  messagesByProject: Record<string, ChatMessage[]>;
  viewportByProject: Record<string, Viewport>;
  customSizes: string[];
  /** When false, the user's text goes straight to the image model (no LLM). */
  agentEnabled: boolean;

  /* ---- ephemeral (per current workspace) ---- */
  tasksByProject: Record<string, QueueTask[]>;
  selection: string[];
  activeTool: ToolId;
  references: ActiveReference[];
  composerMode: GenMode;
  composerSize: string;
  draftCounter: Record<string, number>;
  projectLoadState: Record<string, CanvasProjectLoadState>;
  projectLoadError: Record<string, string>;
  serverRevisionByProject: Record<string, number>;
  projectDirtyByProject: Record<string, boolean>;
  localUpdatedAtByProject: Record<string, number>;
  projectSyncError: Record<string, string>;
  projectIndexState: "idle" | "loading" | "ready";
  persistenceWarning: string;
  _hasHydrated: boolean;

  /* ---- projects ---- */
  createProject: (input: CreateProjectInput) => string;
  deleteProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  setProjectSize: (id: string, size: string) => void;
  touchProject: (id: string) => void;
  recordGeneration: (id: string, cost: number, n: number) => void;
  recordFailure: (id: string) => void;
  syncPublishedProjects: (items: PublishedProjectState[]) => void;
  markProjectPublished: (
    projectId: string,
    deliveryId: string,
    publishedAt?: number,
    itemIds?: string[],
  ) => void;

  /* ---- workspace lifecycle ---- */
  enterProject: (id: string, options?: { retry?: boolean }) => Promise<boolean>;
  adoptServerProject: (id: string) => Promise<boolean>;
  syncCanvasProjectIndex: () => Promise<void>;

  /* ---- canvas items ---- */
  addItem: (projectId: string, item: CanvasItem) => void;
  addItems: (projectId: string, items: CanvasItem[]) => void;
  updateItem: (
    projectId: string,
    id: string,
    patch: Partial<CanvasItem>,
  ) => void;
  moveItems: (projectId: string, ids: string[], delta: Vec2) => void;
  /** Set absolute positions for several items at once (snap-drag). */
  moveItemsTo: (projectId: string, positions: Record<string, Vec2>) => void;
  removeItems: (projectId: string, ids: string[]) => void;
  bringToFront: (projectId: string, id: string) => void;
  /** Reserve `count` sequential draft numbers, returning the first. */
  reserveDrafts: (projectId: string, count: number) => number;

  /* ---- viewport ---- */
  setViewport: (projectId: string, vp: Viewport) => void;

  /* ---- selection / tool ---- */
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  selectOnly: (id: string) => void;
  clearSelection: () => void;
  setTool: (tool: ToolId) => void;

  /* ---- composer references ---- */
  addReference: (itemId: string, usage?: ReferenceUsage) => void;
  setReferenceUsage: (itemId: string, usage: ReferenceUsage) => void;
  removeReference: (itemId: string) => void;
  clearReferences: () => void;
  setComposerMode: (mode: GenMode) => void;
  setComposerSize: (size: string) => void;

  /* ---- custom size presets ---- */
  addCustomSize: (size: string) => void;
  removeCustomSize: (size: string) => void;
  setAgentEnabled: (on: boolean) => void;

  /* ---- chat ---- */
  addMessage: (projectId: string, msg: ChatMessage) => void;
  updateMessage: (
    projectId: string,
    id: string,
    patch: Partial<ChatMessage>,
  ) => void;

  /* ---- task queue ---- */
  addTask: (projectId: string, task: QueueTask) => void;
  updateTask: (
    projectId: string,
    id: string,
    patch: Partial<QueueTask>,
  ) => void;
  clearFinishedTasks: (projectId: string) => void;
}

function canvasProjectSnapshot(
  state: AppState,
  projectId: string,
  clientUpdatedAt?: number,
): CanvasProjectPutPayload | null {
  if (serverTombstonedProjects.has(projectId) || state.projectLoadState[projectId] !== "ready") return null;
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return null;
  if (
    !Object.prototype.hasOwnProperty.call(state.itemsByProject, projectId)
    || !Object.prototype.hasOwnProperty.call(state.messagesByProject, projectId)
  ) return null;
  return {
    project: {
      ...project,
      thumbnailUrl: selectCanvasThumbnailUrl(state.itemsByProject[projectId] || []),
    },
    items: state.itemsByProject[projectId] || [],
    messages: state.messagesByProject[projectId] || [],
    viewport: state.viewportByProject[projectId],
    clientUpdatedAt: Number(
      clientUpdatedAt
      || state.localUpdatedAtByProject[projectId]
      || project.updatedAt
      || Date.now(),
    ),
    baseRevision: state.serverRevisionByProject[projectId],
  };
}

async function getCanvasProjectWithTimeout(
  projectId: string,
  timeoutMs = 8000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await getCanvasProject(projectId, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleCanvasProjectPersistence(
  projectId: string,
  get: () => AppState,
  delayMs = 180,
): void {
  const existing = canvasWriteTimers.get(projectId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    canvasWriteTimers.delete(projectId);
    if (serverTombstonedProjects.has(projectId)) return;
    const generation = canvasMutationGeneration.get(projectId) || 0;
    const currentBeforeSave = get();
    const projectUpdatedAt = Number(
      currentBeforeSave.projects.find((project) => project.id === projectId)?.updatedAt || 0,
    );
    const clientUpdatedAt = Math.max(
      Date.now(),
      Number(currentBeforeSave.localUpdatedAtByProject[projectId] || 0) + 1,
      projectUpdatedAt + 1,
    );
    const snapshot = canvasProjectSnapshot(currentBeforeSave, projectId, clientUpdatedAt);
    if (!snapshot) return;
    const state: CanvasProjectState = {
      items: snapshot.items,
      messages: snapshot.messages,
      viewport: snapshot.viewport,
    };
    if (!isCanvasProjectEmpty(state)) explicitlyEmptyCanvasProjects.delete(projectId);
    const confirmEmpty = explicitlyEmptyCanvasProjects.has(projectId);
    void writeCanvasProjectVerified(projectId, state, {
      allowEmpty: true,
      confirmEmpty,
      source: "local",
      dirty: true,
      conflicted: conflictedCanvasProjects.has(projectId),
      clientUpdatedAt,
      serverRevision: snapshot.baseRevision,
    })
      .then(() => {
        useStore.setState((current) => ({
          projectDirtyByProject: { ...current.projectDirtyByProject, [projectId]: true },
          localUpdatedAtByProject: { ...current.localUpdatedAtByProject, [projectId]: clientUpdatedAt },
          projectSyncError: { ...current.projectSyncError, [projectId]: "" },
        }));
        if (isCanvasProjectEmpty(state) && !confirmEmpty) {
          useStore.setState((current) => ({
            projectSyncError: {
              ...current.projectSyncError,
              [projectId]: "检测到未确认的空画布，已保留本地恢复点并阻止覆盖服务器。",
            },
          }));
          return;
        }
        if (conflictedCanvasProjects.has(projectId)) {
          useStore.setState((current) => ({
            projectSyncError: {
              ...current.projectSyncError,
              [projectId]: "服务器与本地都出现了新编辑，本地内容已保留并暂停自动同步。",
            },
          }));
          return;
        }
        // A legacy project must complete the idempotent migration handshake;
        // never downgrade it to a normal PUT merely because startup was offline.
        if (pendingLegacyServerMigrationIds().includes(projectId)) {
          void get().syncCanvasProjectIndex();
          return;
        }
        scheduleCanvasProjectPut(projectId, () => {
          if ((canvasMutationGeneration.get(projectId) || 0) !== generation) return null;
          return canvasProjectSnapshot(get(), projectId, clientUpdatedAt);
        }, {
          onSuccess: (result, sent) => {
            const revision = result.project.revision;
            if (!Number.isFinite(revision) || serverTombstonedProjects.has(projectId)) return;
            // Advance the revision even when a newer local mutation appeared
            // while this request was in flight. The serialized next PUT then
            // reads the new baseRevision instead of conflicting with this
            // already-committed response.
            useStore.setState((latest) => ({
              serverRevisionByProject: {
                ...latest.serverRevisionByProject,
                [projectId]: Number(revision),
              },
            }));
            if ((canvasMutationGeneration.get(projectId) || 0) !== generation) return;
            const current = canvasProjectSnapshot(get(), projectId, sent.clientUpdatedAt);
            if (!current) return;
            void writeCanvasProjectVerified(projectId, result.state, {
              allowEmpty: true,
              confirmEmpty,
              source: "server",
              dirty: false,
              conflicted: false,
              clientUpdatedAt: sent.clientUpdatedAt,
              serverRevision: Number(revision),
            }).then(() => {
              if ((canvasMutationGeneration.get(projectId) || 0) !== generation) return;
              suppressedCanvasProjects.add(projectId);
              try {
                useStore.setState((latest) => ({
                  projects: latest.projects.map((project) =>
                    project.id === projectId ? mergeServerProject(project, result.project) : project,
                  ),
                  serverRevisionByProject: {
                    ...latest.serverRevisionByProject,
                    [projectId]: Number(revision),
                  },
                  projectDirtyByProject: { ...latest.projectDirtyByProject, [projectId]: false },
                  localUpdatedAtByProject: {
                    ...latest.localUpdatedAtByProject,
                    [projectId]: sent.clientUpdatedAt,
                  },
                  projectSyncError: { ...latest.projectSyncError, [projectId]: "" },
                }));
              } finally {
                suppressedCanvasProjects.delete(projectId);
              }
            }).catch((error) => {
              console.warn("[canvas-persistence] clean checkpoint failed:", error);
            });
          },
          onError: (error, sent) => {
            if (error instanceof CanvasSyncError && error.status === 410) {
              removeServerTombstonedProject(projectId);
              return;
            }
            const message = error instanceof CanvasSyncError && error.status === 409
              ? `${error.message}。本地未同步内容已保留，不会覆盖服务器。`
              : "服务器同步暂时失败，本地内容已保留。";
            if (error instanceof CanvasSyncError && error.status === 409) {
              conflictedCanvasProjects.add(projectId);
              void writeCanvasProjectVerified(projectId, {
                items: sent.items,
                messages: sent.messages,
                viewport: sent.viewport,
              }, {
                allowEmpty: true,
                confirmEmpty,
                source: "local",
                dirty: true,
                conflicted: true,
                clientUpdatedAt: sent.clientUpdatedAt,
                serverRevision: sent.baseRevision,
              }).catch(() => undefined);
            }
            useStore.setState((current) => ({
              projectSyncError: { ...current.projectSyncError, [projectId]: message },
            }));
          },
        });
      })
      .catch((error) => {
        console.warn("[canvas-persistence] verified save failed:", error);
      });
  }, delayMs);
  canvasWriteTimers.set(projectId, timer);
}

function installRecoveredProject(
  projectId: string,
  payload: CanvasProjectState,
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  metadata: {
    dirty?: boolean;
    conflicted?: boolean;
    clientUpdatedAt?: number;
    serverRevision?: number;
  } = {},
): void {
  if (!isCanvasProjectEmpty(payload)) explicitlyEmptyCanvasProjects.delete(projectId);
  if (metadata.conflicted) conflictedCanvasProjects.add(projectId);
  else conflictedCanvasProjects.delete(projectId);
  loadedCanvasProjects.add(projectId);
  const alreadySuppressed = suppressedCanvasProjects.has(projectId);
  suppressedCanvasProjects.add(projectId);
  try {
    set((state) => ({
      itemsByProject: { ...state.itemsByProject, [projectId]: payload.items },
      messagesByProject: { ...state.messagesByProject, [projectId]: payload.messages },
      viewportByProject: (() => {
        const viewports = { ...state.viewportByProject };
        if (payload.viewport) viewports[projectId] = payload.viewport;
        else delete viewports[projectId];
        return viewports;
      })(),
      draftCounter: {
        ...state.draftCounter,
        [projectId]: payload.items.filter(
          (item) => item.type === "generation" || item.type === "enhanced",
        ).length,
      },
      projectLoadState: { ...state.projectLoadState, [projectId]: "ready" },
      projectLoadError: { ...state.projectLoadError, [projectId]: "" },
      projectDirtyByProject: {
        ...state.projectDirtyByProject,
        [projectId]: metadata.dirty === true,
      },
      localUpdatedAtByProject: {
        ...state.localUpdatedAtByProject,
        [projectId]: Number(metadata.clientUpdatedAt || 0),
      },
      serverRevisionByProject: Number.isFinite(metadata.serverRevision)
        ? {
            ...state.serverRevisionByProject,
            [projectId]: Number(metadata.serverRevision),
          }
        : state.serverRevisionByProject,
      projectSyncError: {
        ...state.projectSyncError,
        [projectId]: metadata.conflicted
          ? "服务器与本地都出现了新编辑，本地内容已保留并暂停自动同步。"
          : "",
      },
    }));
  } finally {
    if (!alreadySuppressed) suppressedCanvasProjects.delete(projectId);
  }
}

function removeServerTombstonedProject(projectId: string): void {
  serverTombstonedProjects.add(projectId);
  cancelCanvasProjectPut(projectId);
  const writeTimer = canvasWriteTimers.get(projectId);
  if (writeTimer) clearTimeout(writeTimer);
  canvasWriteTimers.delete(projectId);
  loadingCanvasProjects.delete(projectId);
  loadedCanvasProjects.delete(projectId);
  canvasMutationGeneration.delete(projectId);
  explicitlyEmptyCanvasProjects.delete(projectId);
  serverRefreshRequiredProjects.delete(projectId);
  conflictedCanvasProjects.delete(projectId);
  void deleteCanvasProjectState(projectId).catch(() => undefined);
  useStore.setState((state) => {
    const without = <T,>(record: Record<string, T>): Record<string, T> => {
      const next = { ...record };
      delete next[projectId];
      return next;
    };
    return {
      projects: state.projects.filter((project) => project.id !== projectId),
      itemsByProject: without(state.itemsByProject),
      messagesByProject: without(state.messagesByProject),
      viewportByProject: without(state.viewportByProject),
      projectLoadState: without(state.projectLoadState),
      projectLoadError: without(state.projectLoadError),
      serverRevisionByProject: without(state.serverRevisionByProject),
      projectDirtyByProject: without(state.projectDirtyByProject),
      localUpdatedAtByProject: without(state.localUpdatedAtByProject),
      projectSyncError: without(state.projectSyncError),
    };
  });
}

function mergeServerProject(local: Project, server: Project): Project {
  return {
    ...local,
    ...server,
    publishedDeliveryId: local.publishedDeliveryId || server.publishedDeliveryId,
    publishedAt: local.publishedAt || server.publishedAt,
    publishedItemIds: local.publishedItemIds?.length
      ? [...new Set([...(server.publishedItemIds || []), ...local.publishedItemIds])]
      : server.publishedItemIds,
  };
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      projects: [],
      itemsByProject: {},
      messagesByProject: {},
      viewportByProject: {},
      customSizes: [],
      // Native mode by default — raw prompts straight to the image model
      // (the user found it beats the agent middleman); Agent is opt-in.
      agentEnabled: false,

      tasksByProject: {},
      selection: [],
      activeTool: "select",
      references: [],
      composerMode: "draft",
      composerSize: "1920x1080",
      draftCounter: {},
      projectLoadState: {},
      projectLoadError: {},
      serverRevisionByProject: {},
      projectDirtyByProject: {},
      localUpdatedAtByProject: {},
      projectSyncError: {},
      projectIndexState: "idle",
      persistenceWarning: "",
      _hasHydrated: false,

      createProject: ({ name, scene, targetSize }) => {
        const id = uid("project");
        loadedCanvasProjects.add(id);
        explicitlyEmptyCanvasProjects.add(id);
        const now = Date.now();
        const project: Project = {
          id,
          name: name.trim() || "未命名项目",
          scene,
          targetSize,
          createdAt: now,
          updatedAt: now,
          cost: 0,
          generations: 0,
          failures: 0,
        };
        set((s) => ({
          projects: [project, ...s.projects],
          itemsByProject: { ...s.itemsByProject, [id]: [] },
          messagesByProject: { ...s.messagesByProject, [id]: [] },
          projectLoadState: { ...s.projectLoadState, [id]: "ready" },
          projectLoadError: { ...s.projectLoadError, [id]: "" },
        }));
        scheduleCanvasProjectPersistence(id, get, 0);
        return id;
      },

      deleteProject: (id) => {
        if (!queueCanvasProjectDelete(id)) {
          set((state) => ({
            projectSyncError: {
              ...state.projectSyncError,
              [id]: "浏览器空间不足，删除进度无法安全保存；项目暂未删除，请释放空间后重试。",
            },
          }));
          return;
        }
        serverTombstonedProjects.add(id);
        cancelCanvasProjectPut(id);
        loadedCanvasProjects.delete(id);
        loadingCanvasProjects.delete(id);
        const writeTimer = canvasWriteTimers.get(id);
        if (writeTimer) clearTimeout(writeTimer);
        canvasWriteTimers.delete(id);
        canvasMutationGeneration.delete(id);
        explicitlyEmptyCanvasProjects.delete(id);
        serverRefreshRequiredProjects.delete(id);
        conflictedCanvasProjects.delete(id);
        void deleteCanvasProjectState(id).catch(() => undefined);
        void flushPendingCanvasProjectDeletes();
        set((s) => {
          const projects = s.projects.filter((p) => p.id !== id);
          const items = { ...s.itemsByProject };
          const msgs = { ...s.messagesByProject };
          const vps = { ...s.viewportByProject };
          const loadStates = { ...s.projectLoadState };
          const loadErrors = { ...s.projectLoadError };
          const revisions = { ...s.serverRevisionByProject };
          const dirty = { ...s.projectDirtyByProject };
          const localUpdated = { ...s.localUpdatedAtByProject };
          const syncErrors = { ...s.projectSyncError };
          delete items[id];
          delete msgs[id];
          delete vps[id];
          delete loadStates[id];
          delete loadErrors[id];
          delete revisions[id];
          delete dirty[id];
          delete localUpdated[id];
          delete syncErrors[id];
          return {
            projects,
            itemsByProject: items,
            messagesByProject: msgs,
            viewportByProject: vps,
            projectLoadState: loadStates,
            projectLoadError: loadErrors,
            serverRevisionByProject: revisions,
            projectDirtyByProject: dirty,
            localUpdatedAtByProject: localUpdated,
            projectSyncError: syncErrors,
          };
        });
      },

      renameProject: (id, name) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, name, updatedAt: Date.now() } : p,
          ),
        })),

      setProjectSize: (id, size) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, targetSize: size, updatedAt: Date.now() } : p,
          ),
        })),

      touchProject: (id) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, updatedAt: Date.now() } : p,
          ),
        })),

      recordGeneration: (id, cost, n) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? {
                  ...p,
                  cost: +(p.cost + cost).toFixed(4),
                  generations: p.generations + n,
                  updatedAt: Date.now(),
                }
              : p,
          ),
        })),

      recordFailure: (id) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, failures: p.failures + 1 } : p,
          ),
        })),

      syncPublishedProjects: (items) => {
        const published = new Map(
          items
            .filter((item) => item.projectId && item.deliveryId)
            .map((item) => [item.projectId, item]),
        );
        set((s) => ({
          projects: s.projects.map((project) => {
            const item = published.get(project.id);
            if (item) {
              return {
                ...project,
                publishedDeliveryId: item.deliveryId,
                publishedAt: item.publishedAt || project.publishedAt || Date.now(),
                publishedItemIds: [...new Set(item.itemIds || [])],
              };
            }
            if (
              !project.publishedDeliveryId
              && !project.publishedAt
              && !project.publishedItemIds?.length
            ) return project;
            return {
              ...project,
              publishedDeliveryId: undefined,
              publishedAt: undefined,
              publishedItemIds: undefined,
            };
          }),
        }));
      },

      markProjectPublished: (
        projectId,
        deliveryId,
        publishedAt = Date.now(),
        itemIds = [],
      ) =>
        set((s) => ({
          projects: s.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  publishedDeliveryId: deliveryId,
                  publishedAt,
                  publishedItemIds: [...new Set([
                    ...(project.publishedItemIds || []),
                    ...itemIds.filter(Boolean),
                  ])],
                }
              : project,
          ),
        })),

      enterProject: async (id, options = {}) => {
        if (serverTombstonedProjects.has(id)) return false;
        const project = get().projects.find((p) => p.id === id);
        set({
          selection: [],
          references: [],
          activeTool: "select",
          composerMode: "draft",
          composerSize: project?.targetSize ?? "1920x1080",
        });
        if (!project) {
          set((state) => ({
            projectLoadState: { ...state.projectLoadState, [id]: "error" },
            projectLoadError: { ...state.projectLoadError, [id]: "项目不存在或已被删除" },
          }));
          return false;
        }
        const current = get();
        if (
          !options.retry
          && current.projectLoadState[id] === "ready"
          && Object.prototype.hasOwnProperty.call(current.itemsByProject, id)
          && Object.prototype.hasOwnProperty.call(current.messagesByProject, id)
        ) return true;
        if (options.retry) loadingCanvasProjects.delete(id);
        const existingLoad = loadingCanvasProjects.get(id);
        if (existingLoad) return existingLoad;

        set((state) => ({
          projectLoadState: { ...state.projectLoadState, [id]: "loading" },
          projectLoadError: { ...state.projectLoadError, [id]: "" },
        }));
        const pending = (async () => {
          try {
            if (serverRefreshRequiredProjects.has(id)) {
              set((state) => ({
                projectLoadState: { ...state.projectLoadState, [id]: "recovering" },
              }));
              const canonical = await getCanvasProjectWithTimeout(id);
              if (!canonical) throw new Error("服务器项目不存在或已被删除");
              await writeCanvasProjectVerified(id, canonical.state, {
                allowEmpty: true,
                confirmEmpty: true,
                source: "server",
                dirty: false,
                clientUpdatedAt: canonical.project.updatedAt,
                serverRevision: canonical.project.revision,
              });
              serverRefreshRequiredProjects.delete(id);
              if (isCanvasProjectEmpty(canonical.state)) explicitlyEmptyCanvasProjects.add(id);
              else explicitlyEmptyCanvasProjects.delete(id);
              set((state) => ({
                projects: state.projects.map((item) =>
                  item.id === id ? mergeServerProject(item, canonical.project) : item,
                ),
              }));
              installRecoveredProject(id, canonical.state, set, {
                dirty: false,
                clientUpdatedAt: canonical.project.updatedAt,
                serverRevision: canonical.project.revision,
              });
              return true;
            }
            const local = await readCanvasProject(id).catch(() => null);
            if (local && (!isCanvasProjectEmpty(local.state) || local.confirmedEmpty)) {
              if (!get().projects.some((item) => item.id === id)) return false;
              if (local.confirmedEmpty) explicitlyEmptyCanvasProjects.add(id);
              installRecoveredProject(id, local.state, set, {
                dirty: local.dirty,
                conflicted: local.conflicted,
                clientUpdatedAt: local.clientUpdatedAt,
                serverRevision: local.serverRevision,
              });
              if (local.dirty && !local.conflicted) scheduleCanvasProjectPersistence(id, get, 0);
              return true;
            }

            set((state) => ({
              projectLoadState: { ...state.projectLoadState, [id]: "recovering" },
            }));
            const legacy = readLegacyCanvasProject(id);
            if (legacy && !isCanvasProjectEmpty(legacy)) {
              await writeCanvasProjectVerified(id, legacy, {
                allowEmpty: false,
                source: "legacy",
                dirty: true,
                clientUpdatedAt: project.updatedAt,
              });
              if (!get().projects.some((item) => item.id === id)) return false;
              installRecoveredProject(id, legacy, set, {
                dirty: true,
                clientUpdatedAt: project.updatedAt,
              });
              return true;
            }

            const remote = await getCanvasProjectWithTimeout(id).catch(() => null);
            if (remote) {
              await writeCanvasProjectVerified(id, remote.state, {
                allowEmpty: true,
                confirmEmpty: true,
                source: "server",
                dirty: false,
                clientUpdatedAt: remote.project.updatedAt,
                serverRevision: remote.project.revision,
              });
              if (!get().projects.some((item) => item.id === id)) return false;
              set((state) => ({
                projects: state.projects.map((item) =>
                  item.id === id && remote.project.updatedAt > item.updatedAt
                    ? mergeServerProject(item, remote.project)
                    : item,
                ),
                serverRevisionByProject: Number.isFinite(remote.project.revision)
                  ? {
                      ...state.serverRevisionByProject,
                      [id]: Number(remote.project.revision),
                    }
                  : state.serverRevisionByProject,
              }));
              installRecoveredProject(id, remote.state, set, {
                dirty: false,
                clientUpdatedAt: remote.project.updatedAt,
                serverRevision: remote.project.revision,
              });
              if (isCanvasProjectEmpty(remote.state)) explicitlyEmptyCanvasProjects.add(id);
              return true;
            }
            throw new Error("本地画布为空，且历史备份与服务器均未找到可恢复数据");
          } catch (error) {
            const message = error instanceof Error ? error.message : "画布恢复失败";
            set((state) => ({
              projectLoadState: { ...state.projectLoadState, [id]: "error" },
              projectLoadError: {
                ...state.projectLoadError,
                [id]: `${message}。已阻止空画布写入，请重试。`,
              },
            }));
            return false;
          } finally {
            loadingCanvasProjects.delete(id);
          }
        })();
        loadingCanvasProjects.set(id, pending);
        return pending;
      },

      adoptServerProject: async (id) => {
        try {
          const canonical = await getCanvasProjectWithTimeout(id);
          if (!canonical || serverTombstonedProjects.has(id)) {
            throw new Error("服务器项目不存在或已被删除");
          }
          await writeCanvasProjectVerified(id, canonical.state, {
            allowEmpty: true,
            confirmEmpty: true,
            source: "server",
            dirty: false,
            conflicted: false,
            clientUpdatedAt: canonical.project.updatedAt,
            serverRevision: canonical.project.revision,
          });
          serverRefreshRequiredProjects.delete(id);
          conflictedCanvasProjects.delete(id);
          if (isCanvasProjectEmpty(canonical.state)) explicitlyEmptyCanvasProjects.add(id);
          else explicitlyEmptyCanvasProjects.delete(id);
          suppressedCanvasProjects.add(id);
          try {
            set((state) => ({
              projects: state.projects.map((project) =>
                project.id === id ? mergeServerProject(project, canonical.project) : project,
              ),
            }));
            installRecoveredProject(id, canonical.state, set, {
              dirty: false,
              conflicted: false,
              clientUpdatedAt: canonical.project.updatedAt,
              serverRevision: canonical.project.revision,
            });
          } finally {
            suppressedCanvasProjects.delete(id);
          }
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : "服务器版本恢复失败";
          set((state) => ({
            projectSyncError: {
              ...state.projectSyncError,
              [id]: `${message}，本地内容仍已保留。`,
            },
          }));
          return false;
        }
      },

      syncCanvasProjectIndex: async () => {
        if (get().projectIndexState === "loading") return;
        set({ projectIndexState: "loading" });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          await flushPendingCanvasProjectDeletes();
          const remote = await getCanvasProjectIndex(controller.signal);
          const remoteById = new Map(remote.items.map((project) => [project.id, project]));
          const remoteTombstones = new Set(remote.tombstones.map((item) => item.sourceId));
          const originalLocalIds = new Set(get().projects.map((project) => project.id));
          for (const projectId of remoteTombstones) {
            removeServerTombstonedProject(projectId);
            if (pendingLegacyServerMigrationIds().includes(projectId)) {
              markLegacyProjectServerSynced(projectId);
            }
          }

          const applyCanonical = async (
            projectId: string,
            canonical: Awaited<ReturnType<typeof getCanvasProject>>,
            options: {
              expectedGeneration?: number;
              expectedClientUpdatedAt?: number;
              advanceRevisionOnMutation?: boolean;
            } = {},
          ) => {
            if (!canonical || serverTombstonedProjects.has(projectId)) return;
            const revision = Number(canonical.project.revision || 0) || undefined;
            let concurrentCheckpoint: Awaited<ReturnType<typeof readCanvasProject>> = null;
            const generationChanged = () => Number.isFinite(options.expectedGeneration)
              && (canvasMutationGeneration.get(projectId) || 0) !== options.expectedGeneration;
            const checkpointChanged = async () => {
              const latest = await readCanvasProject(projectId).catch(() => null);
              const changed = !canInstallCanvasCanonical(
                options.expectedGeneration,
                canvasMutationGeneration.get(projectId) || 0,
                options.expectedClientUpdatedAt,
                latest,
              );
              if (changed) concurrentCheckpoint = latest;
              return changed;
            };
            const preserveConcurrentMutation = async () => {
              conflictedCanvasProjects.add(projectId);
              const current = canvasProjectSnapshot(get(), projectId);
              if (revision) {
                set((state) => ({
                  serverRevisionByProject: {
                    ...state.serverRevisionByProject,
                    [projectId]: revision,
                  },
                  projectDirtyByProject: {
                    ...state.projectDirtyByProject,
                    [projectId]: true,
                  },
                }));
              }
              if (current) {
                await writeCanvasProjectVerified(projectId, {
                  items: current.items,
                  messages: current.messages,
                  viewport: current.viewport,
                }, {
                  allowEmpty: true,
                  confirmEmpty: explicitlyEmptyCanvasProjects.has(projectId),
                  source: "local",
                  dirty: true,
                  conflicted: true,
                  clientUpdatedAt: current.clientUpdatedAt,
                  serverRevision: options.advanceRevisionOnMutation
                    ? revision
                    : current.baseRevision,
                });
              } else if (concurrentCheckpoint) {
                await writeCanvasProjectVerified(projectId, concurrentCheckpoint.state, {
                  allowEmpty: true,
                  confirmEmpty: concurrentCheckpoint.confirmedEmpty,
                  source: "local",
                  dirty: true,
                  conflicted: true,
                  clientUpdatedAt: concurrentCheckpoint.clientUpdatedAt,
                  serverRevision: options.advanceRevisionOnMutation
                    ? revision
                    : concurrentCheckpoint.serverRevision,
                });
              }
              set((state) => ({
                projectSyncError: {
                  ...state.projectSyncError,
                  [projectId]: "服务器同步期间检测到新的本地编辑，已保留本地内容并停止自动覆盖。",
                },
              }));
            };
            if (await checkpointChanged()) {
              await preserveConcurrentMutation();
              return;
            }
            await writeCanvasProjectVerified(projectId, canonical.state, {
              allowEmpty: true,
              confirmEmpty: true,
              source: "server",
              dirty: false,
              conflicted: false,
              clientUpdatedAt: canonical.project.updatedAt,
              serverRevision: revision,
            });
            if (generationChanged()) {
              await preserveConcurrentMutation();
              return;
            }
            serverRefreshRequiredProjects.delete(projectId);
            conflictedCanvasProjects.delete(projectId);
            if (isCanvasProjectEmpty(canonical.state)) explicitlyEmptyCanvasProjects.add(projectId);
            else explicitlyEmptyCanvasProjects.delete(projectId);
            const wasReady = get().projectLoadState[projectId] === "ready";
            suppressedCanvasProjects.add(projectId);
            try {
              set((state) => {
                const existing = state.projects.find((project) => project.id === projectId);
                return {
                  projects: existing
                    ? state.projects.map((project) =>
                        project.id === projectId
                          ? mergeServerProject(project, canonical.project)
                          : project,
                      )
                    : [...state.projects, canonical.project],
                  serverRevisionByProject: revision
                    ? { ...state.serverRevisionByProject, [projectId]: revision }
                    : state.serverRevisionByProject,
                  projectDirtyByProject: {
                    ...state.projectDirtyByProject,
                    [projectId]: false,
                  },
                  localUpdatedAtByProject: {
                    ...state.localUpdatedAtByProject,
                    [projectId]: canonical.project.updatedAt,
                  },
                  projectSyncError: { ...state.projectSyncError, [projectId]: "" },
                };
              });
              if (wasReady) {
                installRecoveredProject(projectId, canonical.state, set, {
                  dirty: false,
                  clientUpdatedAt: canonical.project.updatedAt,
                  serverRevision: revision,
                });
              }
            } finally {
              suppressedCanvasProjects.delete(projectId);
            }
          };

          const stageServerSummary = (
            serverProject: Project & { revision?: number },
            options: { requiresRefresh?: boolean; updateRevision?: boolean } = {},
          ) => {
            const projectId = serverProject.id;
            if (options.requiresRefresh !== false) serverRefreshRequiredProjects.add(projectId);
            else serverRefreshRequiredProjects.delete(projectId);
            suppressedCanvasProjects.add(projectId);
            try {
              set((state) => {
                const existing = state.projects.find((project) => project.id === projectId);
                return {
                  projects: existing
                    ? state.projects.map((project) =>
                        project.id === projectId
                          ? mergeServerProject(project, serverProject)
                          : project,
                      )
                    : [...state.projects, serverProject],
                  serverRevisionByProject: options.updateRevision !== false
                    && Number.isFinite(serverProject.revision)
                    ? {
                        ...state.serverRevisionByProject,
                        [projectId]: Number(serverProject.revision),
                      }
                    : state.serverRevisionByProject,
                };
              });
            } finally {
              suppressedCanvasProjects.delete(projectId);
            }
          };

          // Complete every legacy migration through the idempotent server
          // handshake before normal index reconciliation. A matching server ID
          // may only be an empty shell; GET+install here would destroy the
          // verified local image set and bypass the server's migration-fill
          // rule.
          const migratedProjectIds = new Set<string>();
          for (const projectId of pendingLegacyServerMigrationIds()) {
            const expectedGeneration = canvasMutationGeneration.get(projectId) || 0;
            if (remoteTombstones.has(projectId)) {
              markLegacyProjectServerSynced(projectId);
              migratedProjectIds.add(projectId);
              continue;
            }
            const migrationProject = get().projects.find((item) => item.id === projectId);
            const local = await readCanvasProject(projectId).catch(() => null);
            if (!migrationProject || !local) {
              if (remoteById.has(projectId)) {
                await applyCanonical(
                  projectId,
                  await getCanvasProject(projectId, controller.signal),
                  { expectedGeneration },
                );
                markLegacyProjectServerSynced(projectId);
                migratedProjectIds.add(projectId);
              }
              continue;
            }
            if (isCanvasProjectEmpty(local.state) && !local.confirmedEmpty) {
              if (remoteById.has(projectId)) {
                await applyCanonical(
                  projectId,
                  await getCanvasProject(projectId, controller.signal),
                  { expectedGeneration },
                );
                markLegacyProjectServerSynced(projectId);
                migratedProjectIds.add(projectId);
              }
              continue;
            }
            const result = await putCanvasProject(projectId, {
              project: migrationProject,
              items: local.state.items,
              messages: local.state.messages,
              viewport: local.state.viewport,
              clientUpdatedAt: local.clientUpdatedAt || migrationProject.updatedAt || Date.now(),
              migration: true,
            }, controller.signal);
            await applyCanonical(projectId, result, {
              expectedGeneration,
              expectedClientUpdatedAt: local.clientUpdatedAt,
              advanceRevisionOnMutation: result.outcome !== "server-newer",
            });
            markLegacyProjectServerSynced(projectId);
            migratedProjectIds.add(projectId);
          }

          for (const serverProject of remote.items) {
            const projectId = serverProject.id;
            if (remoteTombstones.has(projectId)) continue;
            if (migratedProjectIds.has(projectId)) continue;
            const local = await readCanvasProject(projectId).catch(() => null);
            if (!local) {
              if (get().projectDirtyByProject[projectId]) {
                set((state) => ({
                  projectSyncError: {
                    ...state.projectSyncError,
                    [projectId]: "本地完整画布尚未迁移，已保留并停止服务器覆盖。",
                  },
                }));
                continue;
              }
              stageServerSummary(serverProject);
              continue;
            }
            const decision = decideCanvasServerReconciliation(
              local,
              Number(serverProject.revision || 0),
              Number(serverProject.updatedAt || 0),
            );
            if (decision === "keep-local-dirty") {
              if (!originalLocalIds.has(projectId)) {
                // Restore only the missing home-page metadata. The verified
                // dirty IDB state remains authoritative and must not be marked
                // for a canonical GET.
                stageServerSummary(serverProject, {
                  requiresRefresh: false,
                  updateRevision: false,
                });
              }
              const localRevision = local.serverRevision;
              const remoteIsNewer = Number(serverProject.revision || 0) > Number(localRevision || 0)
                || Number(serverProject.updatedAt || 0) > Number(local.clientUpdatedAt || 0);
              const hasConflict = local.conflicted || remoteIsNewer;
              if (hasConflict) {
                conflictedCanvasProjects.add(projectId);
                if (!local.conflicted) {
                  void writeCanvasProjectVerified(projectId, local.state, {
                    allowEmpty: true,
                    confirmEmpty: local.confirmedEmpty,
                    source: "local",
                    dirty: true,
                    conflicted: true,
                    clientUpdatedAt: local.clientUpdatedAt,
                    serverRevision: local.serverRevision,
                  }).catch(() => undefined);
                }
              }
              set((state) => ({
                serverRevisionByProject: Number.isFinite(localRevision)
                  ? { ...state.serverRevisionByProject, [projectId]: Number(localRevision) }
                  : state.serverRevisionByProject,
                projectDirtyByProject: { ...state.projectDirtyByProject, [projectId]: true },
                localUpdatedAtByProject: {
                  ...state.localUpdatedAtByProject,
                  [projectId]: local.clientUpdatedAt,
                },
                projectSyncError: hasConflict
                  ? {
                      ...state.projectSyncError,
                      [projectId]: "服务器已有更新内容，本地未同步编辑已保留并暂停自动同步。",
                    }
                  : state.projectSyncError,
              }));
              if (!hasConflict && get().projectLoadState[projectId] === "ready") {
                scheduleCanvasProjectPersistence(projectId, get, 0);
              }
              continue;
            }
            if (!originalLocalIds.has(projectId)) {
              stageServerSummary(serverProject, {
                requiresRefresh: decision === "install-server",
              });
              continue;
            }
            if (decision === "install-server") {
              if (get().projectLoadState[projectId] === "ready") {
                const expectedGeneration = canvasMutationGeneration.get(projectId) || 0;
                await applyCanonical(
                  projectId,
                  await getCanvasProject(projectId, controller.signal),
                  {
                    expectedGeneration,
                    expectedClientUpdatedAt: local.clientUpdatedAt,
                  },
                );
              } else {
                stageServerSummary(serverProject);
              }
            } else if (Number.isFinite(serverProject.revision)) {
              // Even when the IndexedDB draft is already current, the server
              // index can carry newer lightweight metadata (notably the stable
              // owner-scoped thumbnail URL added after older summaries were
              // persisted). Merge that summary without reloading or replacing
              // the verified canvas state.
              stageServerSummary(serverProject, {
                requiresRefresh: false,
              });
              set((state) => ({
                serverRevisionByProject: {
                  ...state.serverRevisionByProject,
                  [projectId]: Number(serverProject.revision),
                },
                projectDirtyByProject: { ...state.projectDirtyByProject, [projectId]: false },
                localUpdatedAtByProject: {
                  ...state.localUpdatedAtByProject,
                  [projectId]: local.clientUpdatedAt,
                },
              }));
            }
          }
        } catch (error) {
          console.warn("[canvas-sync] index sync deferred:", error);
        } finally {
          clearTimeout(timeout);
          set({ projectIndexState: "ready" });
        }
      },

      addItem: (projectId, item) =>
        set((s) => ({
          itemsByProject: {
            ...s.itemsByProject,
            [projectId]: [...(s.itemsByProject[projectId] ?? []), item],
          },
        })),

      addItems: (projectId, items) =>
        set((s) => ({
          itemsByProject: {
            ...s.itemsByProject,
            [projectId]: [...(s.itemsByProject[projectId] ?? []), ...items],
          },
        })),

      updateItem: (projectId, id, patch) =>
        set((s) => ({
          itemsByProject: {
            ...s.itemsByProject,
            [projectId]: (s.itemsByProject[projectId] ?? []).map((it) =>
              it.id === id ? ({ ...it, ...patch } as CanvasItem) : it,
            ),
          },
        })),

      moveItems: (projectId, ids, delta) =>
        set((s) => {
          const idset = new Set(ids);
          return {
            itemsByProject: {
              ...s.itemsByProject,
              [projectId]: (s.itemsByProject[projectId] ?? []).map((it) =>
                idset.has(it.id)
                  ? {
                      ...it,
                      position: {
                        x: it.position.x + delta.x,
                        y: it.position.y + delta.y,
                      },
                    }
                  : it,
              ),
            },
          };
        }),

      moveItemsTo: (projectId, positions) =>
        set((s) => ({
          itemsByProject: {
            ...s.itemsByProject,
            [projectId]: (s.itemsByProject[projectId] ?? []).map((it) =>
              positions[it.id] ? { ...it, position: positions[it.id] } : it,
            ),
          },
        })),

      removeItems: (projectId, ids) =>
        set((s) => {
          const idset = new Set(ids);
          return {
            itemsByProject: {
              ...s.itemsByProject,
              [projectId]: (s.itemsByProject[projectId] ?? []).filter(
                (it) => !idset.has(it.id),
              ),
            },
            selection: s.selection.filter((sid) => !idset.has(sid)),
            references: s.references.filter((r) => !idset.has(r.itemId)),
          };
        }),

      bringToFront: (projectId, id) =>
        set((s) => {
          const items = s.itemsByProject[projectId] ?? [];
          const maxZ = items.reduce((m, it) => Math.max(m, it.z), 0);
          return {
            itemsByProject: {
              ...s.itemsByProject,
              [projectId]: items.map((it) =>
                it.id === id ? { ...it, z: maxZ + 1 } : it,
              ),
            },
          };
        }),

      reserveDrafts: (projectId, count) => {
        const start = (get().draftCounter[projectId] ?? 0) + 1;
        set((s) => ({
          draftCounter: {
            ...s.draftCounter,
            [projectId]: start + count - 1,
          },
        }));
        return start;
      },

      setViewport: (projectId, vp) =>
        set((s) => ({
          viewportByProject: { ...s.viewportByProject, [projectId]: vp },
        })),

      setSelection: (ids) => set({ selection: ids }),
      toggleSelection: (id) =>
        set((s) => ({
          selection: s.selection.includes(id)
            ? s.selection.filter((x) => x !== id)
            : [...s.selection, id],
        })),
      selectOnly: (id) => set({ selection: [id] }),
      clearSelection: () => set({ selection: [] }),
      setTool: (tool) => set({ activeTool: tool }),

      addReference: (itemId, usage = "style") =>
        set((s) => {
          if (s.references.some((r) => r.itemId === itemId)) return s;
          return { references: [...s.references, { itemId, usage }] };
        }),
      setReferenceUsage: (itemId, usage) =>
        set((s) => ({
          references: s.references.map((r) =>
            r.itemId === itemId ? { ...r, usage } : r,
          ),
        })),
      removeReference: (itemId) =>
        set((s) => ({
          references: s.references.filter((r) => r.itemId !== itemId),
        })),
      clearReferences: () => set({ references: [] }),
      setComposerMode: (mode) => set({ composerMode: mode }),
      setComposerSize: (size) => set({ composerSize: size }),

      addCustomSize: (size) => {
        const p = parseSize(size);
        if (!p) return;
        const norm = `${p.width}x${p.height}`;
        set((s) =>
          s.customSizes.includes(norm)
            ? s
            : { customSizes: [norm, ...s.customSizes].slice(0, 12) },
        );
      },
      removeCustomSize: (size) =>
        set((s) => ({
          customSizes: s.customSizes.filter((x) => x !== size),
        })),
      setAgentEnabled: (on) => set({ agentEnabled: on }),

      addMessage: (projectId, msg) =>
        set((s) => ({
          messagesByProject: {
            ...s.messagesByProject,
            [projectId]: [...(s.messagesByProject[projectId] ?? []), msg],
          },
        })),
      updateMessage: (projectId, id, patch) =>
        set((s) => ({
          messagesByProject: {
            ...s.messagesByProject,
            [projectId]: (s.messagesByProject[projectId] ?? []).map((m) =>
              m.id === id ? { ...m, ...patch } : m,
            ),
          },
        })),

      addTask: (projectId, task) =>
        set((s) => ({
          tasksByProject: {
            ...s.tasksByProject,
            [projectId]: [...(s.tasksByProject[projectId] ?? []), task],
          },
        })),
      updateTask: (projectId, id, patch) =>
        set((s) => ({
          tasksByProject: {
            ...s.tasksByProject,
            [projectId]: (s.tasksByProject[projectId] ?? []).map((t) =>
              t.id === id ? { ...t, ...patch } : t,
            ),
          },
        })),
      clearFinishedTasks: (projectId) =>
        set((s) => ({
          tasksByProject: {
            ...s.tasksByProject,
            [projectId]: (s.tasksByProject[projectId] ?? []).filter(
              (t) => t.status === "running" || t.status === "queued",
            ),
          },
        })),
    }),
    {
      name: CANVAS_STORAGE_KEY,
      version: 3,
      migrate: (persisted, version) => {
        const s = persisted as Partial<AppState>;
        // v2: native mode became the default — reset the old opt-out once.
        if (version < 2) s.agentEnabled = false;
        // v3 moves full project payloads to IndexedDB. The custom storage
        // performs the actual split before Zustand hydrates this summary.
        return s as AppState;
      },
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({
        projects: s.projects,
        itemsByProject: s.itemsByProject,
        messagesByProject: s.messagesByProject,
        viewportByProject: s.viewportByProject,
        customSizes: s.customSizes,
        agentEnabled: s.agentEnabled,
      }),
      onRehydrateStorage: () => (state) => {
        // Default draft counters from existing generations so labels don't collide.
        if (state) {
          const counters: Record<string, number> = {};
          const loadStates = { ...state.projectLoadState };
          const dirtyStates = { ...state.projectDirtyByProject };
          const localUpdated = { ...state.localUpdatedAtByProject };
          for (const [pid, items] of Object.entries(state.itemsByProject)) {
            loadedCanvasProjects.add(pid);
            loadStates[pid] = "ready";
            dirtyStates[pid] = true;
            localUpdated[pid] = Number(
              state.projects.find((project) => project.id === pid)?.updatedAt || Date.now(),
            );
            counters[pid] = items.filter(
              (i) => i.type === "generation" || i.type === "enhanced",
            ).length;
          }
          state.draftCounter = counters;
          state.projectLoadState = loadStates;
          state.projectDirtyByProject = dirtyStates;
          state.localUpdatedAtByProject = localUpdated;
          state.persistenceWarning = getCanvasPersistenceWarning();
          state._hasHydrated = true;
          if (typeof window !== "undefined") {
            const elapsed = canvasBootStarted ? performance.now() - canvasBootStarted : 0;
            const detail = { durationMs: Math.round(elapsed), projectCount: state.projects.length };
            window.dispatchEvent(new CustomEvent("xingzhen:canvas-hydrated", { detail }));
            if (window.parent !== window) {
              window.parent.postMessage({
                source: "xingzhen-canvas",
                type: "performance",
                stage: "hydration",
                ...detail,
              }, window.location.origin);
            }
          }
        }
      },
    },
  ),
);

useStore.subscribe((state, previous) => {
  if (!state._hasHydrated) return;
  const previousProjects = new Map(previous.projects.map((project) => [project.id, project]));
  for (const project of state.projects) {
    if (state.projectLoadState[project.id] !== "ready") continue;
    if (suppressedCanvasProjects.has(project.id) || serverTombstonedProjects.has(project.id)) continue;
    const changed = previousProjects.get(project.id) !== project
      || previous.itemsByProject[project.id] !== state.itemsByProject[project.id]
      || previous.messagesByProject[project.id] !== state.messagesByProject[project.id]
      || previous.viewportByProject[project.id] !== state.viewportByProject[project.id];
    if (changed) {
      canvasMutationGeneration.set(
        project.id,
        (canvasMutationGeneration.get(project.id) || 0) + 1,
      );
      cancelCanvasProjectPut(project.id);
      scheduleCanvasProjectPersistence(project.id, useStore.getState);
    }
  }
});

/* --- Convenience selectors (stable references avoided; call inside components) --- */
export const selectProject = (id: string) => (s: AppState) =>
  s.projects.find((p) => p.id === id);
export const selectItems = (id: string) => (s: AppState) =>
  s.itemsByProject[id] ?? EMPTY_ITEMS;
export const selectMessages = (id: string) => (s: AppState) =>
  s.messagesByProject[id] ?? EMPTY_MESSAGES;
export const selectTasks = (id: string) => (s: AppState) =>
  s.tasksByProject[id] ?? EMPTY_TASKS;

// Shared empty constants keep selectors referentially stable (avoids re-render loops).
const EMPTY_ITEMS: CanvasItem[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_TASKS: QueueTask[] = [];
