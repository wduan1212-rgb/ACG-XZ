"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ProjectClient } from "@/components/workspace/ProjectClient";
import { rememberAssetSource } from "@/lib/assetCache";
import { footprintFor } from "@/lib/geometry";
import { canvasPublishedProjectsFromBootstrap } from "@/lib/platformBridge";
import { useStore } from "@/lib/store";
import type { ReferenceItem } from "@/lib/types";
import { uid } from "@/lib/util";

const HOME_LAUNCH_KEY = "starmatrix.canvasHomeLaunch.v1";
const HOME_LAUNCH_CONSUMED_KEY = "starmatrix.canvasHomeLaunchConsumed.v1";

function currentProjectId(): string | null {
  const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
  const match = hash.match(/^\/project\/([^/?#]+)/);
  return match?.[1] ?? null;
}

export function GithubPagesApp() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const hydrated = useStore((state) => state._hasHydrated);
  const syncPublishedProjects = useStore((state) => state.syncPublishedProjects);
  const syncCanvasProjectIndex = useStore((state) => state.syncCanvasProjectIndex);
  const markProjectPublished = useStore((state) => state.markProjectPublished);
  const createProject = useStore((state) => state.createProject);
  const addItem = useStore((state) => state.addItem);
  const pendingCreateProject = useRef(false);
  const handledLaunches = useRef(new Set<string>());

  const announceProject = useCallback((createdId: string) => {
    if (window.parent === window) return;
    window.parent.postMessage({
      source: "xingzhen-canvas",
      type: "project-created",
      projectId: createdId,
    }, window.location.origin);
  }, []);

  const acknowledgeHomeLaunch = useCallback((launchId: string, createdId: string) => {
    if (window.parent === window) return;
    window.parent.postMessage({
      source: "xingzhen-canvas",
      type: "home-launch-consumed",
      launchId,
      projectId: createdId,
    }, window.location.origin);
  }, []);

  const createBlankProject = useCallback((name = "未命名创作") => {
    const createdId = createProject({
      name,
      scene: "brand_kv",
      targetSize: "1080x1920",
    });
    window.location.hash = `#/project/${encodeURIComponent(createdId)}`;
    announceProject(createdId);
    return createdId;
  }, [announceProject, createProject]);

  const consumeHomeLaunch = useCallback((rawPayload: unknown): boolean => {
    if (!hydrated || !rawPayload || typeof rawPayload !== "object") return false;
    const payload = rawPayload as Record<string, unknown>;
    const launchId = String(
      payload.bridgeLaunchId
      || payload.launchToken
      || payload.createdAt
      || "",
    ).trim().slice(0, 180);
    const alreadyConsumed = Boolean(
      launchId
      && (
        handledLaunches.current.has(launchId)
        || sessionStorage.getItem(HOME_LAUNCH_CONSUMED_KEY) === launchId
      )
    );
    if (alreadyConsumed) {
      acknowledgeHomeLaunch(launchId, currentProjectId() || "");
      return true;
    }

    const brief = String(payload.prompt || "").trim().slice(0, 12000);
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .filter((item) => String(item.type || "").startsWith("image/") && String(item.dataUrl || "").startsWith("data:image/"))
          .slice(0, 8)
      : [];
    // A launch from the platform homepage always owns a new conversation/project.
    // Reusing the currently open hash would leave Workspace mounted with the same
    // projectId, so its one-shot brief queue would never run again.
    const targetProjectId = createProject({
      name: brief ? brief.slice(0, 16) : "未命名创作",
      scene: "brand_kv",
      targetSize: "1080x1920",
    });
    const referenceIds: string[] = [];
    attachments.forEach((attachment, index) => {
      const source = String(attachment.dataUrl || "");
      const item: ReferenceItem = {
        id: uid("item"),
        projectId: targetProjectId,
        type: "reference",
        position: { x: index * 328, y: 0 },
        size: footprintFor(300, 300, 300),
        z: 30,
        createdAt: Date.now(),
        assetUrl: source,
        naturalWidth: 300,
        naturalHeight: 300,
        source: "upload",
        label: String(attachment.name || `参考图 ${index + 1}`).slice(0, 40),
        hidden: true,
      };
      addItem(targetProjectId, item);
      rememberAssetSource(item.id, source);
      referenceIds.push(item.id);
    });
    if (brief) sessionStorage.setItem(`aidc:brief:${targetProjectId}`, brief);
    if (referenceIds.length) {
      sessionStorage.setItem(`aidc:refs:${targetProjectId}`, JSON.stringify(referenceIds));
    }
    if (launchId) {
      handledLaunches.current.add(launchId);
      sessionStorage.setItem(HOME_LAUNCH_CONSUMED_KEY, launchId);
    }
    sessionStorage.removeItem(HOME_LAUNCH_KEY);
    window.location.hash = `#/project/${encodeURIComponent(targetProjectId)}`;
    announceProject(targetProjectId);
    acknowledgeHomeLaunch(launchId, targetProjectId);
    return true;
  }, [acknowledgeHomeLaunch, addItem, announceProject, createProject, hydrated]);

  useEffect(() => {
    const sync = () => setProjectId(currentProjectId());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    syncPublishedProjects(canvasPublishedProjectsFromBootstrap());
    void syncCanvasProjectIndex();
  }, [hydrated, syncCanvasProjectIndex, syncPublishedProjects]);

  useEffect(() => {
    if (!hydrated || window.parent === window) return;
    window.parent.postMessage({
      source: "xingzhen-canvas",
      type: "workspace-ready",
      projectId: currentProjectId() || "",
    }, window.location.origin);
    if (pendingCreateProject.current) {
      pendingCreateProject.current = false;
      createBlankProject();
      return;
    }
    try {
      const staged = JSON.parse(sessionStorage.getItem(HOME_LAUNCH_KEY) || "null");
      if (staged) consumeHomeLaunch(staged);
    } catch {
      sessionStorage.removeItem(HOME_LAUNCH_KEY);
    }
  }, [consumeHomeLaunch, createBlankProject, hydrated]);

  useEffect(() => {
    const receivePublishedState = (event: MessageEvent) => {
      if (
        window.parent === window
        || event.source !== window.parent
        || event.origin !== window.location.origin
      ) {
        return;
      }
      const message = event.data && typeof event.data === "object"
        ? event.data as Record<string, unknown>
        : {};
      if (message.type === "custom-canvas:workspace-index-changed") {
        void syncCanvasProjectIndex();
        return;
      }
      if (message.type === "custom-canvas:create-project") {
        if (!hydrated) {
          pendingCreateProject.current = true;
          return;
        }
        createBlankProject();
        return;
      }
      if (message.type === "custom-canvas:home-launch") {
        if (!consumeHomeLaunch(message.payload)) {
          try {
            sessionStorage.setItem(HOME_LAUNCH_KEY, JSON.stringify(message.payload || {}));
          } catch {
            /* parent will retry after workspace-ready */
          }
        }
        return;
      }
      if (message.type !== "custom-canvas:published") return;
      const sourceProjectId = String(message.projectId || "").trim().slice(0, 180);
      const deliveryId = String(message.deliveryId || "").trim().slice(0, 160);
      const publishedAt = Number(message.publishedAt || Date.now());
      const itemIds = Array.isArray(message.itemIds)
        ? [...new Set(message.itemIds.map((item) => String(item || "").trim()).filter(Boolean))]
            .slice(0, 20)
        : [];
      if (!sourceProjectId || !deliveryId) return;
      markProjectPublished(
        sourceProjectId,
        deliveryId,
        Number.isFinite(publishedAt) ? publishedAt : Date.now(),
        itemIds,
      );
    };
    window.addEventListener("message", receivePublishedState);
    return () => window.removeEventListener("message", receivePublishedState);
  }, [consumeHomeLaunch, createBlankProject, hydrated, markProjectPublished, syncCanvasProjectIndex]);

  if (!projectId) {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-white text-[13px] text-ink-3"
        role="status"
        data-canvas-project-opening
      >
        正在打开画布…
      </div>
    );
  }

  return <ProjectClient projectId={projectId} />;
}
