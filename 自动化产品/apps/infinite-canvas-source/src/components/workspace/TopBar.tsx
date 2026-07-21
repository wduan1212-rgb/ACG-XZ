"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, Send } from "lucide-react";
import { Button } from "@/components/ui";
import { navigateHome } from "@/lib/runtime";
import { useStore } from "@/lib/store";

export function TopBar({
  projectId,
  onExport,
  onPublish,
  canExport,
  exportCount,
  canPublish,
  publishing,
  publishNotice,
}: {
  projectId: string;
  onExport: () => void;
  onPublish: () => void;
  canExport: boolean;
  exportCount: number;
  canPublish: boolean;
  publishing: boolean;
  publishNotice: string;
}) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const renameProject = useStore((s) => s.renameProject);
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!project) return null;

  function commitName() {
    const v = draft.trim();
    if (v) renameProject(projectId, v);
    setEditing(false);
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-page px-3">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => navigateHome(router)}
          className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-ink-2 hover:bg-fill hover:text-ink"
          aria-label="返回"
        >
          <ArrowLeft size={17} />
        </button>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") setEditing(false);
            }}
            className="h-7 w-52 rounded-[var(--radius-sm)] border border-accent bg-white px-2 text-sm font-semibold text-ink outline-none ring-2 ring-[var(--color-accent-weak)]"
          />
        ) : (
          <button
            onClick={() => {
              setDraft(project.name);
              setEditing(true);
            }}
            className="truncate text-sm font-semibold text-ink hover:text-accent"
            title="点击重命名"
          >
            {project.name}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span
          className="max-w-[360px] truncate text-[12px] text-ink-3"
          role="status"
          aria-live="polite"
          title={publishNotice}
        >
          {publishNotice || (!canPublish ? "请先选中一张图片后发布" : "")}
        </span>
        <Button variant="secondary" onClick={onExport} disabled={!canExport}>
          <Download size={15} /> {exportCount > 1 ? `批量导出 ${exportCount} 张` : "导出"}
        </Button>
        <Button
          variant="primary"
          onClick={onPublish}
          disabled={!canPublish || publishing}
        >
          <Send size={15} /> {publishing ? "合成中…" : "发布"}
        </Button>
      </div>
    </header>
  );
}
