"use client";

import { useEffect, useState } from "react";
import { ProjectClient } from "@/components/workspace/ProjectClient";
import { canvasPublishedProjectsFromBootstrap } from "@/lib/platformBridge";
import { useStore } from "@/lib/store";

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
        if (!hydrated) return;
        const createdId = createProject({
          name: "未命名创作",
          scene: "brand_kv",
          targetSize: "1080x1920",
        });
        window.location.hash = `#/project/${encodeURIComponent(createdId)}`;
        window.parent.postMessage({
          source: "xingzhen-canvas",
          type: "project-created",
          projectId: createdId,
        }, window.location.origin);
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
  }, [createProject, hydrated, markProjectPublished, syncCanvasProjectIndex]);

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
