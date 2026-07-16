"use client";

import { Hydrated } from "@/components/Hydrated";
import { Spinner } from "@/components/ui";
import { Workspace } from "./Workspace";

export function ProjectClient({ projectId }: { projectId: string }) {
  return (
    <Hydrated fallback={<WorkspaceSkeleton />}>
      <Workspace projectId={projectId} />
    </Hydrated>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="h-14 shrink-0 border-b border-line bg-page" />
      <div className="flex min-h-0 flex-1">
        <div className="w-14 shrink-0 border-r border-line bg-page" />
        <div className="flex min-w-0 flex-1 items-center justify-center canvas-dots">
          <Spinner className="h-5 w-5 text-ink-3" />
        </div>
        <div className="w-[380px] shrink-0 border-l border-line bg-page" />
      </div>
    </div>
  );
}
