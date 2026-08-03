"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, ImagePlus, Sparkles, X } from "lucide-react";
import { AgentMessages } from "./AgentMessages";
import { SizeField } from "./SizeField";
import { useStudioActions } from "./useStudioActions";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/util";
import { isImageItem } from "@/lib/types";

export function AgentPanel({
  projectId,
  onAttachFiles,
  onPreviewItem,
}: {
  projectId: string;
  onAttachFiles: (files: FileList | File[]) => void;
  onPreviewItem?: (id: string) => void;
}) {
  const items = useStore((s) => s.itemsByProject[projectId] ?? EMPTY);
  const references = useStore((s) => s.references);
  const agentEnabled = useStore((s) => s.agentEnabled);
  const composerSize = useStore((s) => s.composerSize);
  const setComposerSize = useStore((s) => s.setComposerSize);
  const setProjectSize = useStore((s) => s.setProjectSize);
  const setAgentEnabled = useStore((s) => s.setAgentEnabled);
  const removeReference = useStore((s) => s.removeReference);
  const setSelection = useStore((s) => s.setSelection);
  const { generate } = useStudioActions(projectId);

  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hasManualSizeSelection = useRef(false);

  const firstRefItem = references.length > 0 ? items.find((i) => i.id === references[0].itemId) : undefined;
  const firstRef =
    firstRefItem && isImageItem(firstRefItem) && firstRefItem.naturalWidth ? firstRefItem : undefined;

  // Attaching the first reference defaults the output size to match it.
  const firstRefId = firstRef?.id ?? null;
  useEffect(() => {
    if (!firstRefId || !firstRef || hasManualSizeSelection.current) return;
    setComposerSize(`${firstRef.naturalWidth}x${firstRef.naturalHeight}`);
    setProjectSize(projectId, `${firstRef.naturalWidth}x${firstRef.naturalHeight}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstRefId]);

  // "对话修改" from the canvas context menu focuses the composer.
  useEffect(() => {
    const onFocus = () => taRef.current?.focus();
    window.addEventListener("focus-composer", onFocus);
    return () => window.removeEventListener("focus-composer", onFocus);
  }, []);

  function send() {
    const t = text.trim();
    if (!t && references.length === 0) return;
    setText("");
    generate(t);
  }

  return (
    <aside className="flex h-full w-full flex-col bg-page">
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <AgentMessages
          projectId={projectId}
          onSelectItem={(id) => {
            setSelection([id]);
            onPreviewItem?.(id);
          }}
        />
      </div>

      {/* composer */}
      <div
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) onAttachFiles(e.dataTransfer.files);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onPaste={(e) => {
          const images = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith("image/"));
          if (!images.length) return;
          // Let normal text paste stay in the prompt; image paste becomes a
          // reference image without bubbling into the canvas duplicate-paste handler.
          e.preventDefault();
          e.stopPropagation();
          onAttachFiles(images);
        }}
        className={cn(
          "shrink-0 border-t p-3 transition-colors",
          dragOver ? "border-accent bg-[var(--color-accent-weak)]" : "border-line bg-[#fcfcfc]",
        )}
      >
        <div className="rounded-[var(--radius-md)] border border-line bg-white focus-within:border-accent focus-within:ring-2 focus-within:ring-[var(--color-accent-weak)]">
          {references.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {references.map((r) => {
                const it = items.find((i) => i.id === r.itemId);
                const url = it && isImageItem(it) ? it.assetUrl : "";
                return (
                  <span
                    key={r.itemId}
                    className="group relative h-11 w-11 overflow-hidden rounded-[var(--radius-sm)] border border-line bg-fill"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt="" className="h-full w-full object-cover" />
                    <button
                      onClick={() => removeReference(r.itemId)}
                      className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label="移除参考"
                    >
                      <X size={10} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // IME composition Enter (confirming candidates) must not send.
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={3}
            placeholder={
              agentEnabled
                ? "描述画面，可说数量（如来3张）…  ⏎ 生成"
                : "原生模式：这里的文字将原样作为图像提示词  ⏎ 生成"
            }
            className="block w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-5 text-ink placeholder:text-ink-3 outline-none"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
              <button
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-1 text-[12px] text-ink-2 hover:bg-fill hover:text-ink"
                title="添加参考图（也可拖拽到此）"
              >
                <ImagePlus size={15} /> 参考图
              </button>
              <SizeField
                value={composerSize}
                placement="top"
                align="right"
                referenceSize={
                  firstRef ? { width: firstRef.naturalWidth, height: firstRef.naturalHeight } : undefined
                }
                onChange={(v) => {
                  hasManualSizeSelection.current = true;
                  setComposerSize(v);
                  setProjectSize(projectId, v);
                }}
              />
              <button
                onClick={() => setAgentEnabled(!agentEnabled)}
                title={agentEnabled ? "Agent 开：帮你写提示词" : "原生模式：你的文字原样发给图像模型"}
                className={cn(
                  "flex items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-[12px] transition-colors",
                  agentEnabled
                    ? "bg-[var(--color-accent-weak)] text-accent"
                    : "text-ink-2 hover:bg-fill hover:text-ink",
                )}
              >
                <Sparkles size={14} />
                {agentEnabled ? "Agent" : "原生"}
                <span
                  className={cn(
                    "relative h-[16px] w-[28px] rounded-full transition-colors",
                    agentEnabled ? "bg-ink" : "bg-fill-2",
                  )}
                >
                  <span
                    className="absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-[var(--shadow-card)] transition-all"
                    style={{ left: agentEnabled ? 14 : 2 }}
                  />
                </span>
              </button>
            </div>
            <button
              onClick={send}
              disabled={!text.trim() && references.length === 0}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-white transition-colors hover:bg-black disabled:opacity-40"
              aria-label="生成"
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onAttachFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    </aside>
  );
}

const EMPTY: never[] = [];
