"use client";

import { useEffect, useState } from "react";
import { HomeView } from "@/components/home/HomeView";
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
  }, [markProjectPublished]);

  return projectId ? <ProjectClient projectId={projectId} /> : <HomeView />;
}
