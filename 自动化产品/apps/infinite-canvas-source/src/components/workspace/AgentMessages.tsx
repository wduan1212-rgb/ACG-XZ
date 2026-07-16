"use client";

import { Check, Sparkles } from "lucide-react";
import { Spinner } from "@/components/ui";
import { useStore } from "@/lib/store";
import { isImageItem } from "@/lib/types";
import type { ChatMessage } from "@/lib/types";

export function AgentMessages({
  projectId,
  onSelectItem,
}: {
  projectId: string;
  onSelectItem: (id: string) => void;
}) {
  const messages = useStore((s) => s.messagesByProject[projectId] ?? EMPTY);

  if (messages.length === 0) return <EmptyPrompt />;

  return (
    <div className="space-y-4">
      {messages.map((m) =>
        m.role === "user" ? (
          <UserBubble key={m.id} msg={m} projectId={projectId} />
        ) : (
          <AgentBubble
            key={m.id}
            msg={m}
            projectId={projectId}
            onSelectItem={onSelectItem}
          />
        ),
      )}
    </div>
  );
}

function EmptyPrompt() {
  return (
    <div className="flex flex-col items-center px-4 py-12 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent-weak)] text-accent">
        <Sparkles size={20} />
      </div>
      <p className="mt-3 text-sm font-medium text-ink">描述你想要的海报</p>
      <p className="mt-1 max-w-[260px] text-[13px] leading-5 text-ink-2">
        写清配色、风格、画面里有什么、不要出现什么，直接出一张成品海报。可拖入参考图。
      </p>
    </div>
  );
}

function refThumbs(projectId: string, msg: ChatMessage) {
  const items = useStore.getState().itemsByProject[projectId] ?? [];
  return (msg.references ?? [])
    .map((r) => items.find((i) => i.id === r.itemId))
    .filter((i): i is NonNullable<typeof i> => !!i && isImageItem(i));
}

function UserBubble({ msg, projectId }: { msg: ChatMessage; projectId: string }) {
  const refs = refThumbs(projectId, msg);
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-[var(--radius-md)] rounded-tr-sm bg-[var(--color-accent-weak)] px-3 py-2 text-[13px] leading-5 text-ink">
        {msg.text}
        {refs.length > 0 && (
          <div className="mt-1.5 flex gap-1">
            {refs.map((it) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={it.id}
                src={isImageItem(it) ? it.assetUrl : ""}
                alt=""
                className="h-8 w-8 rounded object-cover"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentBubble({
  msg,
  projectId,
  onSelectItem,
}: {
  msg: ChatMessage;
  projectId: string;
  onSelectItem: (id: string) => void;
}) {
  const items = useStore((s) => s.itemsByProject[projectId] ?? EMPTY_ITEMS);
  const publishedItemIds = useStore(
    (s) => s.projects.find((project) => project.id === projectId)?.publishedItemIds
      ?? EMPTY_PUBLISHED_ITEM_IDS,
  );

  if (msg.status === "thinking") {
    return (
      <div className="flex items-center gap-2 text-[13px] text-ink-2">
        <Spinner className="h-3.5 w-3.5 text-accent" />
        正在写提示词并生成海报…
      </div>
    );
  }
  if (msg.status === "error") {
    return (
      <div className="rounded-[var(--radius-md)] bg-[var(--color-danger-weak)] px-3 py-2 text-[13px] text-danger">
        {msg.text}
      </div>
    );
  }

  const results = (msg.resultItemIds ?? [])
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is NonNullable<typeof i> => !!i && isImageItem(i));

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-white">
          <Sparkles size={13} />
        </div>
        <div className="flex-1 text-[13px] leading-5 text-ink">{msg.text}</div>
      </div>

      {results.length === 1 && isImageItem(results[0]) && (
        <button
          onClick={() => onSelectItem(results[0].id)}
          className="relative block w-full overflow-hidden rounded-[var(--radius-md)] border border-line hover:border-accent"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={results[0].assetUrl}
            alt={results[0].label}
            className="max-h-[220px] w-full object-cover"
          />
          {publishedItemIds.includes(results[0].id) && <PublishedImageBadge />}
        </button>
      )}
      {results.length > 1 && (
        <div className="grid grid-cols-3 gap-1.5">
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => onSelectItem(r.id)}
              className="relative aspect-square overflow-hidden rounded-[var(--radius-sm)] border border-line hover:border-accent"
              title={isImageItem(r) ? r.label : ""}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={isImageItem(r) ? r.assetUrl : ""}
                alt=""
                className="h-full w-full object-cover"
              />
              {publishedItemIds.includes(r.id) && <PublishedImageBadge compact />}
            </button>
          ))}
        </div>
      )}

      {msg.plan?.prompt && (
        <details className="rounded-[var(--radius-sm)] border border-line bg-[#fcfcfc]">
          <summary className="cursor-pointer list-none px-2.5 py-1.5 text-[12px] text-ink-2 hover:text-ink">
            查看提示词
          </summary>
          <p className="px-2.5 pb-2.5 font-mono text-[11px] leading-4 text-ink-2">
            {msg.plan.prompt}
          </p>
        </details>
      )}
    </div>
  );
}

function PublishedImageBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={
        "pointer-events-none absolute bottom-1.5 right-1.5 z-10 inline-flex items-center gap-1 rounded-full border border-white/45 bg-[#247a3d]/94 font-semibold text-white shadow-[0_2px_8px_rgba(0,0,0,0.24)] backdrop-blur-sm "
        + (compact ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-1 text-[10px]")
      }
      role="status"
      aria-label="该图片已提交发布"
      title="该图片已提交发布"
    >
      <Check size={compact ? 9 : 10} strokeWidth={2.4} /> 已发布
    </span>
  );
}

const EMPTY: ChatMessage[] = [];
const EMPTY_ITEMS: never[] = [];
const EMPTY_PUBLISHED_ITEM_IDS: string[] = [];
