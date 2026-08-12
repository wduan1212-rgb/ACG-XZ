import type { CanvasItem, ChatMessage, ImageItem, Project } from "./types";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasProjectState {
  items: CanvasItem[];
  messages: ChatMessage[];
  viewport?: Viewport;
}

interface StoredCanvasProject {
  schema: 1 | 2;
  state: CanvasProjectState;
  verifiedAt: number;
  confirmedEmpty: boolean;
  source: "local" | "legacy" | "server";
  dirty?: boolean;
  conflicted?: boolean;
  clientUpdatedAt?: number;
  serverRevision?: number;
}

interface PersistedCanvasEnvelope {
  state?: {
    projects?: Project[];
    itemsByProject?: Record<string, CanvasItem[]>;
    messagesByProject?: Record<string, ChatMessage[]>;
    viewportByProject?: Record<string, Viewport>;
    [key: string]: unknown;
  };
  version?: number;
  [key: string]: unknown;
}

export interface CanvasProjectReadResult {
  state: CanvasProjectState;
  confirmedEmpty: boolean;
  source: StoredCanvasProject["source"] | "unversioned";
  dirty: boolean;
  conflicted: boolean;
  clientUpdatedAt: number;
  serverRevision?: number;
}

export const CANVAS_INTERRUPTED_TASK_TIMEOUT_MS = 5 * 60 * 1000;
export const CANVAS_INTERRUPTED_TASK_TEXT = "任务已中断，可重试";

/**
 * A persisted async marker has no executable promise behind it after reload.
 * Repair only stale markers, preserve completed mixed results, and never call
 * a generation API from hydration.
 */
export function recoverInterruptedCanvasState(
  state: CanvasProjectState,
  now = Date.now(),
  timeoutMs = CANVAS_INTERRUPTED_TASK_TIMEOUT_MS,
): { state: CanvasProjectState; changed: boolean } {
  let changed = false;
  const stale = (createdAt: number | undefined) =>
    !Number.isFinite(createdAt) || now - Number(createdAt || 0) >= timeoutMs;
  const recoverableBackgroundJobs = new Set(
    state.items
      .filter((item) =>
        item.type === "generation"
        && item.loading
        && item.provenance?.backgroundJob === true
        && !!item.jobId,
      )
      .map((item) => item.id),
  );
  const items = state.items.map((item) => {
    // Historical recovery could successfully attach a durable server blob and
    // then fail while saving the local checkpoint. Never let that secondary
    // failure override the authoritative media result on the card.
    if (
      (item.type === "generation" || item.type === "enhanced")
      && !!item.assetUrl
      && (
        item.generationStatus === "failed"
        || item.generationStatus === "interrupted"
        || /(?:生成|编辑)失败|任务已中断/.test(String(item.label || ""))
      )
    ) {
      changed = true;
      return {
        ...item,
        loading: false,
        generationStatus: "done" as const,
        label: item.type === "generation"
          ? `海报 ${String(item.queuePosition || 1).padStart(2, "0")}`
          : "高清结果",
        error: undefined,
      };
    }
    if (
      (item.type !== "generation" && item.type !== "enhanced")
      || !item.loading
      || !stale(item.createdAt)
    ) return item;
    // Embedded image jobs continue on the server after this page is gone.
    // Their dedicated status endpoint, not a local age heuristic, owns the
    // terminal state and prevents a refresh from discarding a paid result.
    if (
      item.type === "generation"
      && item.provenance?.backgroundJob === true
      && item.jobId
    ) return item;
    changed = true;
    if (item.assetUrl) {
      return { ...item, loading: false, generationStatus: "done" as const };
    }
    return {
      ...item,
      loading: false,
      generationStatus: "interrupted" as const,
      label: CANVAS_INTERRUPTED_TASK_TEXT,
      error: CANVAS_INTERRUPTED_TASK_TEXT,
    };
  });
  const messages = state.messages.map((message) => {
    if (message.status !== "thinking" || !stale(message.createdAt)) return message;
    if (message.resultItemIds?.some((id) => recoverableBackgroundJobs.has(id))) {
      return message;
    }
    changed = true;
    return {
      ...message,
      status: message.resultItemIds?.length ? "partial" as const : "error" as const,
      text: CANVAS_INTERRUPTED_TASK_TEXT,
    };
  });
  return changed
    ? { state: { ...state, items, messages }, changed: true }
    : { state, changed: false };
}

export function decideCanvasServerReconciliation(
  local: CanvasProjectReadResult | null,
  serverRevision: number,
  serverUpdatedAt: number,
): "install-server" | "keep-local-dirty" | "keep-local-clean" {
  if (!local) return "install-server";
  if (local.dirty) return "keep-local-dirty";
  if (
    Number(serverRevision || 0) > Number(local.serverRevision || 0)
    || Number(serverUpdatedAt || 0) > Number(local.clientUpdatedAt || 0)
  ) return "install-server";
  return "keep-local-clean";
}

export function canInstallCanvasCanonical(
  expectedGeneration: number | undefined,
  currentGeneration: number,
  expectedClientUpdatedAt: number | undefined,
  latestLocal: CanvasProjectReadResult | null,
): boolean {
  if (
    Number.isFinite(expectedGeneration)
    && currentGeneration !== Number(expectedGeneration)
  ) return false;
  if (
    Number.isFinite(expectedClientUpdatedAt)
    && latestLocal?.dirty
    && latestLocal.clientUpdatedAt > Number(expectedClientUpdatedAt)
  ) return false;
  return true;
}

interface CanvasMigrationManifest {
  version: 1;
  migratedAt: number;
  projectIds: string[];
  serverSyncedProjectIds?: string[];
}

const memory = new Map<string, string>();

export function canvasStorageNamespace(): string {
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
    // Standalone mode receives an isolated anonymous namespace.
  }
  return "anonymous";
}

export const CANVAS_OWNER = canvasStorageNamespace();
export const CANVAS_STORAGE_KEY = `ai-design-canvas:v2:${CANVAS_OWNER}`;
export const CANVAS_LEGACY_BACKUP_KEY = `${CANVAS_STORAGE_KEY}:legacy-backup`;
export const CANVAS_MIGRATION_KEY = `${CANVAS_STORAGE_KEY}:migration-v1`;
const OWNER_SCOPED_LEGACY_KEYS = [
  CANVAS_LEGACY_BACKUP_KEY,
  CANVAS_STORAGE_KEY,
  `ai-design-canvas:v1:${CANVAS_OWNER}`,
  `ai-design-canvas:${CANVAS_OWNER}`,
];
const CANVAS_DB_NAME = `xingzhen-canvas:${CANVAS_OWNER}`;
const CANVAS_DB_STORE = "project-state";

let localStorageFallbackMode = false;
let persistenceWarning = "";

export function getCanvasPersistenceWarning(): string {
  return persistenceWarning;
}

export function localCanvasGet(name: string): string | null {
  try {
    return globalThis.localStorage?.getItem(name) ?? memory.get(name) ?? null;
  } catch {
    return memory.get(name) ?? null;
  }
}

export function localCanvasSet(name: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(name, value);
  } catch {
    memory.set(name, value);
  }
}

export function localCanvasRemove(name: string): void {
  try {
    globalThis.localStorage?.removeItem(name);
  } catch {
    memory.delete(name);
  }
}

function durableLocalStorageValue(name: string): string | null {
  try {
    return globalThis.localStorage?.getItem(name) ?? null;
  } catch {
    return null;
  }
}

function writeDurableLocalExact(name: string, value: string): boolean {
  const existing = durableLocalStorageValue(name);
  if (existing === value) return true;
  try {
    globalThis.localStorage?.setItem(name, value);
    return globalThis.localStorage?.getItem(name) === value;
  } catch {
    return false;
  }
}

/** Small coordination records (migration progress and delete tombstones) must
 * survive reload; callers may not treat the in-memory quota fallback as a
 * completed durable write. */
export function writeDurableCanvasValue(name: string, value: string): boolean {
  return writeDurableLocalExact(name, value);
}

function writeDurableBackup(raw: string): boolean {
  return writeDurableLocalExact(CANVAS_LEGACY_BACKUP_KEY, raw);
}

function openCanvasDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(CANVAS_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CANVAS_DB_STORE)) {
        request.result.createObjectStore(CANVAS_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function isCanvasProjectState(value: unknown): value is CanvasProjectState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<CanvasProjectState>;
  return Array.isArray(state.items) && Array.isArray(state.messages)
    && (!state.viewport || (
      Number.isFinite(state.viewport.x)
      && Number.isFinite(state.viewport.y)
      && Number.isFinite(state.viewport.zoom)
    ));
}

export function isCanvasProjectEmpty(state: CanvasProjectState): boolean {
  // A viewport is only a UI shell. Treating it as user content allowed an old
  // browser tab to turn an otherwise empty placeholder into an authoritative
  // draft and overwrite a richer server copy.
  return state.items.length === 0 && state.messages.length === 0;
}

function stateFingerprint(state: CanvasProjectState): string {
  // IndexedDB uses structured clone and preserves JSON-safe application data.
  // Comparing a separately-read value catches aborted/quota-limited writes.
  return JSON.stringify(state);
}

export async function readCanvasProject(
  projectId: string,
  options: { recoverInterrupted?: boolean | "all" } = {},
): Promise<CanvasProjectReadResult | null> {
  const db = await openCanvasDatabase();
  try {
    const transaction = db.transaction(CANVAS_DB_STORE, "readonly");
    const completed = waitForTransaction(transaction);
    const request = transaction.objectStore(CANVAS_DB_STORE).get(projectId);
    const raw = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
    });
    await completed;
    if (!raw) return null;
    const record = raw as Partial<StoredCanvasProject>;
    if ((record.schema === 1 || record.schema === 2) && isCanvasProjectState(record.state)) {
      const recovered = options.recoverInterrupted === false
        ? { state: record.state, changed: false }
        : recoverInterruptedCanvasState(
            record.state,
            Date.now(),
            options.recoverInterrupted === "all" ? 0 : CANVAS_INTERRUPTED_TASK_TIMEOUT_MS,
          );
      return {
        state: recovered.state,
        confirmedEmpty: record.confirmedEmpty === true,
        source: record.source || "local",
        dirty: recovered.changed
          || (typeof record.dirty === "boolean" ? record.dirty : record.source !== "server"),
        conflicted: record.conflicted === true,
        clientUpdatedAt: Number(record.clientUpdatedAt || record.verifiedAt || 0),
        serverRevision: Number.isFinite(record.serverRevision)
          ? Number(record.serverRevision)
          : undefined,
      };
    }
    if (isCanvasProjectState(raw)) {
      const recovered = options.recoverInterrupted === false
        ? { state: raw, changed: false }
        : recoverInterruptedCanvasState(
            raw,
            Date.now(),
            options.recoverInterrupted === "all" ? 0 : CANVAS_INTERRUPTED_TASK_TIMEOUT_MS,
          );
      return {
        state: recovered.state,
        // Old unversioned empty records are ambiguous and must go through recovery.
        confirmedEmpty: !isCanvasProjectEmpty(raw),
        source: "unversioned",
        dirty: true,
        conflicted: false,
        clientUpdatedAt: 0,
        serverRevision: undefined,
      };
    }
    throw new Error("IndexedDB project payload is invalid");
  } finally {
    db.close();
  }
}

export async function writeCanvasProjectVerified(
  projectId: string,
  state: CanvasProjectState,
  options: {
    allowEmpty: boolean;
    /** Only an explicit new draft or a server-authoritative empty draft may
     * become a trusted empty checkpoint. Ambiguous legacy shells stay
     * recoverable even when a viewport has already been persisted. */
    confirmEmpty?: boolean;
    source?: StoredCanvasProject["source"];
    dirty?: boolean;
    conflicted?: boolean;
    clientUpdatedAt?: number;
    serverRevision?: number;
  },
): Promise<void> {
  if (!projectId || !isCanvasProjectState(state)) {
    throw new Error("画布数据格式无效");
  }
  if (isCanvasProjectEmpty(state) && !options.allowEmpty) {
    throw new Error("画布尚未恢复，已阻止空数据覆盖");
  }
  // Active jobs may legitimately live longer than the stale-marker threshold.
  // Repair belongs to hydration/read, not to an in-flight checkpoint write.
  const safeState = state;
  const record: StoredCanvasProject = {
    schema: 2,
    state: safeState,
    verifiedAt: Date.now(),
    confirmedEmpty: isCanvasProjectEmpty(safeState) && options.confirmEmpty === true,
    source: options.source || "local",
    dirty: options.dirty ?? options.source !== "server",
    conflicted: options.conflicted === true,
    clientUpdatedAt: Number(options.clientUpdatedAt || Date.now()),
    serverRevision: Number.isFinite(options.serverRevision)
      ? Number(options.serverRevision)
      : undefined,
  };
  const db = await openCanvasDatabase();
  try {
    const transaction = db.transaction(CANVAS_DB_STORE, "readwrite");
    const completed = waitForTransaction(transaction);
    transaction.objectStore(CANVAS_DB_STORE).put(record, projectId);
    await completed;
  } finally {
    db.close();
  }

  // Deliberately reopen the database: validation must be independent from the
  // write transaction and its in-memory value.
  const readback = await readCanvasProject(projectId, { recoverInterrupted: false });
  if (
    !readback
    || stateFingerprint(readback.state) !== stateFingerprint(safeState)
    || readback.confirmedEmpty !== record.confirmedEmpty
    || readback.dirty !== record.dirty
    || readback.conflicted !== record.conflicted
    || readback.clientUpdatedAt !== record.clientUpdatedAt
    || readback.serverRevision !== record.serverRevision
  ) {
    throw new Error("IndexedDB 写入校验失败");
  }
}

export async function deleteCanvasProjectState(projectId: string): Promise<void> {
  const db = await openCanvasDatabase();
  try {
    const transaction = db.transaction(CANVAS_DB_STORE, "readwrite");
    const completed = waitForTransaction(transaction);
    transaction.objectStore(CANVAS_DB_STORE).delete(projectId);
    await completed;
  } finally {
    db.close();
  }
}

function parseEnvelope(raw: string | null): PersistedCanvasEnvelope | null {
  if (!raw) return null;
  try {
    const envelope = JSON.parse(raw) as PersistedCanvasEnvelope;
    return envelope && typeof envelope === "object" ? envelope : null;
  } catch {
    return null;
  }
}

function stateFromEnvelope(
  envelope: PersistedCanvasEnvelope | null,
  projectId: string,
): CanvasProjectState | null {
  const state = envelope?.state;
  if (!state) return null;
  const items = state.itemsByProject || {};
  const messages = state.messagesByProject || {};
  const viewports = state.viewportByProject || {};
  const hasAny = Object.prototype.hasOwnProperty.call(items, projectId)
    || Object.prototype.hasOwnProperty.call(messages, projectId)
    || Object.prototype.hasOwnProperty.call(viewports, projectId);
  if (!hasAny) return null;
  return {
    items: items[projectId] || [],
    messages: messages[projectId] || [],
    viewport: viewports[projectId],
  };
}

export function readLegacyCanvasProject(projectId: string): CanvasProjectState | null {
  for (const key of OWNER_SCOPED_LEGACY_KEYS) {
    const payload = stateFromEnvelope(parseEnvelope(localCanvasGet(key)), projectId);
    if (payload) return payload;
  }
  return null;
}

export function selectCanvasThumbnailUrl(
  items: CanvasItem[],
  fallback?: string,
): string | undefined {
  const usable = (item?: CanvasItem): string | undefined => {
    if (!item || !["reference", "generation", "enhanced"].includes(item.type)) {
      return undefined;
    }
    const imageItem = item as ImageItem;
    if (!imageItem.assetUrl) return undefined;
    if ("loading" in imageItem && imageItem.loading) return undefined;
    return imageItem.assetUrl;
  };
  const visibleItems = items.filter((item) => !item.hidden);
  const visibleResult = visibleItems.find(
    (item) => (item.type === "generation" || item.type === "enhanced") && usable(item),
  );
  const visibleImage = visibleItems.find((item) => usable(item));
  const hiddenReference = items.find(
    (item) => item.type === "reference" && item.hidden && usable(item),
  );
  const anyImage = items.find((item) => usable(item));
  return usable(visibleResult ?? visibleImage ?? hiddenReference ?? anyImage) ?? fallback;
}

export function selectPersistentCanvasThumbnailUrl(
  items: CanvasItem[],
  fallback?: string,
): string | undefined {
  const url = selectCanvasThumbnailUrl(items, fallback);
  return url && /^(?:https?:|\/)/.test(url) ? url : undefined;
}

export function mergeCanvasDisplayThumbnail(
  localProject: Project,
  serverThumbnailUrl?: string,
): Project {
  const thumbnailUrl = selectPersistentCanvasThumbnailUrl([], serverThumbnailUrl);
  if (!thumbnailUrl || localProject.thumbnailUrl === thumbnailUrl) return localProject;
  // Conflict reconciliation may use this helper only for presentation data.
  // Spreading the local summary first preserves every local field and never
  // advances revision, dirty state, or any full canvas payload.
  return { ...localProject, thumbnailUrl };
}

function summaryEnvelope(envelope: PersistedCanvasEnvelope): string {
  const state = envelope.state;
  if (!state || !Array.isArray(state.projects)) return JSON.stringify(envelope);
  const itemsByProject = state.itemsByProject || {};
  const projects = state.projects.map((project) => {
    const hasLoadedItems = Object.prototype.hasOwnProperty.call(itemsByProject, project.id);
    return {
      ...project,
      thumbnailUrl: selectPersistentCanvasThumbnailUrl(
        itemsByProject[project.id] || [],
        hasLoadedItems ? undefined : project.thumbnailUrl,
      ),
    };
  });
  return JSON.stringify({
    ...envelope,
    state: {
      ...state,
      projects,
      itemsByProject: {},
      messagesByProject: {},
      viewportByProject: {},
    },
  });
}

function readMigrationManifest(): CanvasMigrationManifest | null {
  try {
    const parsed = JSON.parse(localCanvasGet(CANVAS_MIGRATION_KEY) || "null") as CanvasMigrationManifest;
    return parsed?.version === 1 && Array.isArray(parsed.projectIds) ? parsed : null;
  } catch {
    return null;
  }
}

export function legacyMigrationProjectIds(): string[] {
  return readMigrationManifest()?.projectIds || [];
}

export function markLegacyProjectServerSynced(projectId: string): void {
  const manifest = readMigrationManifest();
  if (!manifest || !manifest.projectIds.includes(projectId)) return;
  const synced = new Set(manifest.serverSyncedProjectIds || []);
  synced.add(projectId);
  const next = JSON.stringify({
    ...manifest,
    serverSyncedProjectIds: [...synced],
  });
  if (!writeDurableLocalExact(CANVAS_MIGRATION_KEY, next)) {
    localStorageFallbackMode = true;
    persistenceWarning = "画布迁移进度未能持久保存，原始数据仍保留；释放浏览器空间后会继续同步。";
  }
}

export function pendingLegacyServerMigrationIds(): string[] {
  const manifest = readMigrationManifest();
  if (!manifest) return [];
  const synced = new Set(manifest.serverSyncedProjectIds || []);
  return manifest.projectIds.filter((id) => !synced.has(id));
}

export async function migrateLegacyCanvasEnvelope(name: string, raw: string): Promise<string> {
  const envelope = parseEnvelope(raw);
  const state = envelope?.state;
  if (!envelope || !state || !Array.isArray(state.projects)) {
    localCanvasSet(name, raw);
    return raw;
  }
  const projectStates = new Map<string, CanvasProjectState>();
  for (const project of state.projects) {
    const payload = stateFromEnvelope(envelope, project.id);
    if (payload) projectStates.set(project.id, payload);
  }
  if (!projectStates.size) {
    localCanvasSet(name, raw);
    return raw;
  }

  // The exact owner-scoped legacy envelope is immutable recovery material.
  // A volatile memory fallback is not enough here: only a durable, read-back
  // verified backup permits the original full key to be summarized.
  if (!writeDurableBackup(raw)) {
    localStorageFallbackMode = true;
    persistenceWarning = "本地存储空间不足，旧画布仍保留在原存储中，暂未迁移。清理浏览器空间后可重试。";
    // Never rewrite/delete the original full key while backup verification fails.
    return raw;
  }
  try {
    for (const [projectId, payload] of projectStates) {
      const existing = await readCanvasProject(projectId).catch(() => null);
      const incomingIsEmpty = isCanvasProjectEmpty(payload);
      const existingIsUseful = !!existing && !isCanvasProjectEmpty(existing.state);
      const incomingUpdatedAt = Number(
        state.projects.find((project) => project.id === projectId)?.updatedAt || 0,
      );
      if (existing?.source === "server") continue;
      // Re-running migration never replaces a richer verified record with an
      // empty legacy shell or an equal/newer per-project dirty checkpoint.
      if (existingIsUseful && incomingIsEmpty) continue;
      if (
        existingIsUseful
        && existing?.dirty
        && Number(existing.clientUpdatedAt || 0) >= incomingUpdatedAt
      ) continue;
      await writeCanvasProjectVerified(projectId, payload, {
        allowEmpty: true,
        source: "legacy",
        dirty: true,
        clientUpdatedAt: incomingUpdatedAt || Date.now(),
      });
    }
    const previous = readMigrationManifest();
    const ids = new Set([...(previous?.projectIds || []), ...projectStates.keys()]);
    const manifestRaw = JSON.stringify({
      version: 1,
      migratedAt: previous?.migratedAt || Date.now(),
      projectIds: [...ids],
      serverSyncedProjectIds: previous?.serverSyncedProjectIds || [],
    } satisfies CanvasMigrationManifest);
    if (!writeDurableLocalExact(CANVAS_MIGRATION_KEY, manifestRaw)) {
      localStorageFallbackMode = true;
      persistenceWarning = "画布迁移进度未能持久保存，原始数据仍保留；释放浏览器空间后可重试。";
      return raw;
    }
    const summary = summaryEnvelope(envelope);
    if (!writeDurableLocalExact(name, summary)) {
      localStorageFallbackMode = true;
      persistenceWarning = "画布摘要未能持久保存，原始数据仍保留；释放浏览器空间后可重试。";
      return raw;
    }
    return summary;
  } catch {
    // Private browsing / quota errors keep the complete envelope in place.
    localStorageFallbackMode = true;
    localCanvasSet(name, raw);
    return raw;
  }
}

export function storeCanvasSummary(name: string, raw: string): void {
  if (localStorageFallbackMode) {
    localCanvasSet(name, raw);
    return;
  }
  const envelope = parseEnvelope(raw);
  if (!envelope) {
    localCanvasSet(name, raw);
    return;
  }
  localCanvasSet(name, summaryEnvelope(envelope));
}
