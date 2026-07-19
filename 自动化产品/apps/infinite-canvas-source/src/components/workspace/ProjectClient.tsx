"use client";

import { useEffect } from "react";
import { Hydrated } from "@/components/Hydrated";
import { Button, Spinner } from "@/components/ui";
import { useStore } from "@/lib/store";
import { Workspace } from "./Workspace";

export function ProjectClient({ projectId }: { projectId: string }) {
  return (
    <Hydrated fallback={<WorkspaceSkeleton />}>
      <ProjectGate projectId={projectId} />
    </Hydrated>
  );
}

function ProjectGate({ projectId }: { projectId: string }) {
  const project = useStore((state) => state.projects.find((item) => item.id === projectId));
  const projectExists = !!project;
  const items = useStore((state) => state.itemsByProject[projectId] || []);
  const messages = useStore((state) => state.messagesByProject[projectId] || []);
  const viewport = useStore((state) => state.viewportByProject[projectId]);
  const loadState = useStore((state) => state.projectLoadState[projectId] || "idle");
  const loadError = useStore((state) => state.projectLoadError[projectId] || "");
  const indexState = useStore((state) => state.projectIndexState);
  const persistenceWarning = useStore((state) => state.persistenceWarning);
  const syncError = useStore((state) => state.projectSyncError[projectId] || "");
  const enterProject = useStore((state) => state.enterProject);
  const adoptServerProject = useStore((state) => state.adoptServerProject);
  const syncCanvasProjectIndex = useStore((state) => state.syncCanvasProjectIndex);

  const downloadLocalRecovery = () => {
    const blob = new Blob([JSON.stringify({ project, items, messages, viewport }, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `无限画布-本地恢复-${projectId}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  useEffect(() => {
    if (indexState === "ready" && projectExists) void enterProject(projectId);
  }, [enterProject, indexState, projectExists, projectId]);

  if (indexState !== "ready") return <WorkspaceSkeleton label="正在同步项目索引…" />;
  if (!projectExists) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-page px-6">
        <div className="surface-card max-w-md p-6 text-center">
          <h2 className="text-base font-semibold text-ink">未找到这个项目</h2>
          <p className="mt-2 text-[13px] leading-5 text-ink-2">
            项目可能尚未同步或已删除，可重新同步后再试。
          </p>
          <Button className="mt-5" onClick={() => void syncCanvasProjectIndex()}>重新同步</Button>
        </div>
      </div>
    );
  }
  if (loadState === "ready") {
    return (
      <div className="relative h-full w-full">
        <Workspace projectId={projectId} />
        {(persistenceWarning || syncError) && (
          <div className="absolute left-1/2 top-16 z-50 flex max-w-2xl -translate-x-1/2 items-center gap-3 rounded-[var(--radius-md)] border border-amber-300 bg-amber-50 px-4 py-2 text-[12px] text-amber-900 shadow-sm">
            <span>{syncError || persistenceWarning}</span>
            {syncError && (
              <span className="flex shrink-0 gap-1.5">
                <Button size="sm" variant="secondary" onClick={downloadLocalRecovery}>
                  导出本地恢复包
                </Button>
                <Button size="sm" variant="primary" onClick={() => void adoptServerProject(projectId)}>
                  采用服务器版本
                </Button>
              </span>
            )}
          </div>
        )}
      </div>
    );
  }
  if (loadState === "error") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-page px-6">
        <div className="surface-card max-w-md p-6 text-center">
          <h2 className="text-base font-semibold text-ink">画布未能安全恢复</h2>
          <p className="mt-2 text-[13px] leading-5 text-ink-2">
            {loadError || "未找到可验证的项目数据，已阻止空画布覆盖。"}
          </p>
          <Button className="mt-5" onClick={() => void enterProject(projectId, { retry: true })}>
            重试恢复
          </Button>
        </div>
      </div>
    );
  }
  return (
    <WorkspaceSkeleton
      label={loadState === "recovering" ? "正在从备份或服务器恢复画布…" : "正在验证画布数据…"}
    />
  );
}

function WorkspaceSkeleton({ label = "" }: { label?: string }) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="h-14 shrink-0 border-b border-line bg-page" />
      <div className="flex min-h-0 flex-1">
        <div className="w-14 shrink-0 border-r border-line bg-page" />
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 canvas-dots">
          <Spinner className="h-5 w-5 text-ink-3" />
          {label && <p className="text-[12px] text-ink-3">{label}</p>}
        </div>
        <div className="w-[380px] shrink-0 border-l border-line bg-page" />
      </div>
    </div>
  );
}
