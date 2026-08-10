"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Download, Send, Share2 } from "lucide-react";
import { Button } from "@/components/ui";
import { navigateHome } from "@/lib/runtime";
import { useStore } from "@/lib/store";

export function TopBar({
  projectId,
  onExport,
  onPublish,
  onShare,
  canExport,
  exportCount,
  canPublish,
  publishCount,
  canShare,
  showPublish = true,
  embedded = false,
  publishing,
  sharing,
  shared,
  publishNotice,
}: {
  projectId: string;
  onExport: () => void;
  onPublish: () => void;
  onShare: () => void;
  canExport: boolean;
  exportCount: number;
  canPublish: boolean;
  publishCount: number;
  canShare: boolean;
  showPublish?: boolean;
  embedded?: boolean;
  publishing: boolean;
  sharing: boolean;
  shared: boolean;
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

  if (embedded) {
    return (
      <div
        data-canvas-embed-actions
        className="surface-popover pointer-events-auto absolute right-4 top-4 z-40 flex items-center gap-2 rounded-[14px] p-1.5"
        role="toolbar"
        aria-label="画布导出与发布"
      >
        {publishNotice && (
          <span
            className="max-w-[280px] truncate px-1.5 text-[12px] text-ink-3"
            role="status"
            aria-live="polite"
            title={publishNotice}
          >
            {publishNotice}
          </span>
        )}
        <Button variant="secondary" onClick={onExport} disabled={!canExport}>
          <Download size={15} /> {exportCount > 1 ? `导出 ${exportCount} 张` : "导出"}
        </Button>
        <Button variant="secondary" onClick={onShare} disabled={!canShare || sharing || shared}>
          {shared ? <Check size={15} /> : <Share2 size={15} />} {shared ? "已分享" : (sharing ? "分享中…" : "分享灵感")}
        </Button>
        {showPublish && (
          <Button
            variant="primary"
            onClick={onPublish}
            disabled={!canPublish || publishing}
          >
            <Send size={15} /> {publishing ? "合成中…" : (publishCount > 1 ? `发布 ${publishCount} 张` : "发布")}
          </Button>
        )}
      </div>
    );
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
          {publishNotice || (!canPublish ? "请选择图片；Mac 按 Command、Windows 按 Ctrl/Shift，或拖框多选" : (publishCount > 1 ? `将按选择顺序发布 ${publishCount} 张图片` : ""))}
        </span>
        <Button variant="secondary" onClick={onExport} disabled={!canExport}>
          <Download size={15} /> {exportCount > 1 ? `批量导出 ${exportCount} 张` : "导出"}
        </Button>
        <Button variant="secondary" onClick={onShare} disabled={!canShare || sharing || shared}>
          {shared ? <Check size={15} /> : <Share2 size={15} />} {shared ? "已分享" : (sharing ? "分享中…" : "分享灵感")}
        </Button>
        {showPublish && (
          <Button
            variant="primary"
            onClick={onPublish}
            disabled={!canPublish || publishing}
          >
            <Send size={15} /> {publishing ? "合成中…" : (publishCount > 1 ? `发布 ${publishCount} 张` : "发布")}
          </Button>
        )}
      </div>
    </header>
  );
}
