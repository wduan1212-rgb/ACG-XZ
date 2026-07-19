"use client";

import { useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, MoreHorizontal, Pencil, Trash2 } from "lucide-react";

import { Button, Modal } from "@/components/ui";
import { useStore } from "@/lib/store";
import { navigateToProject, projectHref } from "@/lib/runtime";
import { timeAgo } from "@/lib/util";
import type { Project, Scene } from "@/lib/types";

const SCENE_GRADIENT: Record<Scene, string> = {
  airport_screen: "linear-gradient(135deg,#06101f,#0b2350)",
  enterprise_poster: "linear-gradient(135deg,#0e1320,#20283a)",
  banner: "linear-gradient(135deg,#0c0f15,#1a2230)",
  brand_kv: "linear-gradient(135deg,#0a0a0c,#1b1813)",
};

export function ProjectCard({
  project,
  thumbnailUrl,
}: {
  project: Project;
  thumbnailUrl?: string;
}) {
  const renameProject = useStore((s) => s.renameProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [failedThumbnail, setFailedThumbnail] = useState("");
  const visibleThumbnail = thumbnailUrl && failedThumbnail !== thumbnailUrl
    ? thumbnailUrl
    : undefined;

  function commitRename() {
    const v = draft.trim();
    if (v) renameProject(project.id, v);
    else setDraft(project.name);
    setRenaming(false);
  }

  function openProject(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigateToProject(router, project.id);
  }

  return (
    <div className="group surface-card relative flex h-full flex-col overflow-hidden transition-all hover:border-line-2 hover:shadow-[0_4px_16px_-6px_rgba(0,0,0,0.12)]">
      <a href={projectHref(project.id)} onClick={openProject} className="block">
        <div
          className="relative aspect-[16/10] w-full overflow-hidden"
          style={{
            background: visibleThumbnail
              ? SCENE_GRADIENT[project.scene]
              : "linear-gradient(135deg,#f6f7f9,#e9edf2)",
          }}
        >
          {visibleThumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={visibleThumbnail}
              alt=""
              onError={() => setFailedThumbnail(visibleThumbnail)}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <span className="font-mono text-[11px] tracking-wide text-ink-3">
                {project.targetSize}
              </span>
            </div>
          )}
          {!!project.publishedDeliveryId && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-[#111]/82 px-2 py-1 text-[10px] font-semibold text-white shadow-sm backdrop-blur-sm">
              <Check size={11} strokeWidth={2.4} /> 已发布
            </span>
          )}
        </div>
      </a>

      <div className="flex min-h-[84px] flex-1 flex-col px-3.5 py-3">
        <div className="min-h-10">
          {renaming ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setDraft(project.name);
                  setRenaming(false);
                }
              }}
              className="h-7 w-full rounded-[var(--radius-sm)] border border-accent bg-white px-2 text-sm font-medium text-ink outline-none ring-2 ring-[var(--color-accent-weak)]"
            />
          ) : (
            <a href={projectHref(project.id)} onClick={openProject}>
              <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-ink hover:text-accent">
                {project.name}
              </h3>
            </a>
          )}
        </div>

        <div className="mt-auto flex items-center justify-between pt-2">
          <span className="font-mono text-[11px] text-ink-3">
            {project.targetSize}
          </span>
          <span className="text-[11px] text-ink-3">
            {timeAgo(project.updatedAt)}
          </span>
        </div>
      </div>

      {/* kebab menu */}
      <div className="absolute right-2 top-2">
        <button
          onClick={(e) => {
            e.preventDefault();
            setMenuOpen((v) => !v);
          }}
          className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] bg-black/30 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/45 group-hover:opacity-100"
          aria-label="更多"
        >
          <MoreHorizontal size={16} />
        </button>
        {menuOpen && (
          <>
            <div
              className="fixed inset-0 z-20"
              onClick={(e) => {
                e.preventDefault();
                setMenuOpen(false);
              }}
            />
            <div className="surface-popover absolute right-0 top-8 z-30 w-32 overflow-hidden p-1 animate-pop">
              <button
                onClick={(e) => {
                  e.preventDefault();
                  setMenuOpen(false);
                  setRenaming(true);
                }}
                className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[13px] text-ink hover:bg-fill"
              >
                <Pencil size={13} /> 重命名
              </button>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  setMenuOpen(false);
                  setDeleteOpen(true);
                }}
                className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[13px] text-danger hover:bg-[var(--color-danger-weak)]"
              >
                <Trash2 size={13} /> 删除
              </button>
            </div>
          </>
        )}
      </div>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="删除项目"
        subtitle="此操作不可恢复。"
        width={420}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              className="bg-danger text-white hover:bg-[#c90018]"
              onClick={() => {
                deleteProject(project.id);
                setDeleteOpen(false);
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-danger-weak)] text-danger">
            <Trash2 size={18} />
          </div>
          <div>
            <p className="text-sm font-medium text-ink">
              确认删除「{project.name}」？
            </p>
            <p className="mt-1.5 text-[13px] leading-5 text-ink-2">
              项目里的画布、对话记录和生成图片都会从本地列表移除。
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
