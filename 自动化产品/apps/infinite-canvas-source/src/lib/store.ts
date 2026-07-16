"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { StateStorage } from "zustand/middleware";
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

export interface Viewport {
  x: number; // canvas translate x (px)
  y: number; // canvas translate y (px)
  zoom: number; // scale factor
}

/* --- Storage that degrades gracefully (SSR + quota safe) --- */
const memory = new Map<string, string>();
function canvasStorageNamespace(): string {
  if (typeof window === "undefined") return "anonymous";
  try {
    const bootstrap = JSON.parse(window.name || "{}") as {
      kind?: string;
      storageNamespace?: string;
    };
    if (bootstrap.kind === "xingzhen-canvas-bootstrap") {
      const namespace = String(bootstrap.storageNamespace || "")
        .replace(/[^\w-]/g, "")
        .slice(0, 80);
      if (namespace) return namespace;
    }
  } catch {
    /* 非平台嵌入或 window.name 不是 JSON 时使用独立匿名分仓。 */
  }
  return "anonymous";
}
const canvasOwner =
  canvasStorageNamespace();
const CANVAS_STORAGE_KEY = `ai-design-canvas:v2:${canvasOwner}`;
const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return globalThis.localStorage?.getItem(name) ?? memory.get(name) ?? null;
    } catch {
      return memory.get(name) ?? null;
    }
  },
  setItem: (name, value) => {
    try {
      globalThis.localStorage?.setItem(name, value);
    } catch {
      // Quota exceeded or unavailable — keep in memory so the session still works.
      memory.set(name, value);
    }
  },
  removeItem: (name) => {
    try {
      globalThis.localStorage?.removeItem(name);
    } catch {
      memory.delete(name);
    }
  },
};

interface CreateProjectInput {
  name: string;
  scene: Scene;
  targetSize: string;
}

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
  enterProject: (id: string) => void;

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
      _hasHydrated: false,

      createProject: ({ name, scene, targetSize }) => {
        const id = uid("project");
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
        }));
        return id;
      },

      deleteProject: (id) =>
        set((s) => {
          const projects = s.projects.filter((p) => p.id !== id);
          const items = { ...s.itemsByProject };
          const msgs = { ...s.messagesByProject };
          const vps = { ...s.viewportByProject };
          delete items[id];
          delete msgs[id];
          delete vps[id];
          return {
            projects,
            itemsByProject: items,
            messagesByProject: msgs,
            viewportByProject: vps,
          };
        }),

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

      enterProject: (id) => {
        const project = get().projects.find((p) => p.id === id);
        set({
          selection: [],
          references: [],
          activeTool: "select",
          composerMode: "draft",
          composerSize: project?.targetSize ?? "1920x1080",
        });
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
      version: 2,
      migrate: (persisted, version) => {
        const s = persisted as Partial<AppState>;
        // v2: native mode became the default — reset the old opt-out once.
        if (version < 2) s.agentEnabled = false;
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
          for (const [pid, items] of Object.entries(state.itemsByProject)) {
            counters[pid] = items.filter(
              (i) => i.type === "generation" || i.type === "enhanced",
            ).length;
          }
          state.draftCounter = counters;
          state._hasHydrated = true;
        }
      },
    },
  ),
);

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
