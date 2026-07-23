"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Clock3,
  FolderOpen,
  Home,
  ImagePlus,
  Lock,
  Plus,
  Unlock,
  X,
} from "lucide-react";
import { useHydrated } from "@/components/Hydrated";
import { ApiKeyButton } from "./ApiKeyButton";
import { ProjectCard } from "./ProjectCard";
import { rememberAssetSource } from "@/lib/assetCache";
import { selectCanvasThumbnailUrl } from "@/lib/canvasPersistence";
import { SIZE_GROUPS } from "@/lib/constants";
import { footprintFor } from "@/lib/geometry";
import { fileToDownscaledDataUrl } from "@/lib/image";
import { IS_GITHUB_PAGES, navigateToProject, publicAsset } from "@/lib/runtime";
import { parseSize } from "@/lib/sizing";
import { useStore } from "@/lib/store";
import { cn, uid } from "@/lib/util";
import {
  type Project,
  type ReferenceItem,
} from "@/lib/types";

interface RefImg {
  dataUrl: string;
  originalDataUrl?: string;
  width: number;
  height: number;
  name: string;
}

function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.items || [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
  if (files.length) return files;
  return Array.from(data.files || []).filter((file) => file.type.startsWith("image/"));
}

const WELCOME = "欢迎使用星阵无限画布，开始设计！";

function aspectRatioLabel(width: number, height: number): string {
  const ratio = Math.max(1, width) / Math.max(1, height);
  const common = [
    [1, 1], [3, 4], [4, 3], [9, 16], [16, 9], [16, 10], [32, 9],
  ] as const;
  const matched = common.find(([w, h]) => Math.abs(ratio - w / h) / (w / h) < 0.015);
  if (matched) return `${matched[0]}:${matched[1]}`;
  const longSideRatio = ratio >= 1 ? ratio : 1 / ratio;
  return ratio >= 1 ? `约 ${longSideRatio.toFixed(2)}:1` : `约 1:${longSideRatio.toFixed(2)}`;
}

/** Rotating example prompts, typed & deleted like a live cursor. */
const PH_PHRASES = [
  "做一张小红书封面：秋日咖啡上新，暖棕色调，标题「秋天第一杯」",
  "把我的产品图放进清晨客厅，生活化、看起来非常真实",
  "发布会 KV：深空蓝，大留白，主标题「智启未来」",
  "国潮新年海报：朱砂红配金，书法标题「福启新岁」",
];

function useTypewriter(): string {
  const [text, setText] = useState("");
  useEffect(() => {
    let alive = true;
    let i = 0;
    let pos = 0;
    let dir: 1 | -1 = 1;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (!alive) return;
      const s = PH_PHRASES[i];
      pos += dir;
      setText(s.slice(0, Math.max(0, pos)));
      let delay = dir > 0 ? 70 : 24;
      if (dir > 0 && pos >= s.length) {
        dir = -1;
        delay = 1800;
      } else if (dir < 0 && pos <= 0) {
        dir = 1;
        i = (i + 1) % PH_PHRASES.length;
        delay = 500;
      }
      t = setTimeout(tick, delay);
    };
    t = setTimeout(tick, 800);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);
  return text;
}

export function HomeView() {
  const hydrated = useHydrated();
  const router = useRouter();
  const projects = useStore((s) => s.projects);
  const itemsByProject = useStore((s) => s.itemsByProject);
  const createProject = useStore((s) => s.createProject);
  const addItem = useStore((s) => s.addItem);

  const [brief, setBrief] = useState("");
  const [size, setSize] = useState("1080x1920");
  const [sizeOpen, setSizeOpen] = useState(false);
  const [refs, setRefs] = useState<RefImg[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const sizeRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typed = useTypewriter();

  useEffect(() => {
    if (!sizeOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (sizeRef.current && !sizeRef.current.contains(e.target as Node)) setSizeOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [sizeOpen]);

  async function attachFiles(files: FileList | File[]) {
    const list = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, 6 - refs.length);
    for (const f of list) {
      try {
        const { dataUrl, originalDataUrl, width, height } = await fileToDownscaledDataUrl(f);
        setRefs((rs) =>
          rs.length >= 6
            ? rs
            : [
                ...rs,
                {
                  dataUrl,
                  originalDataUrl,
                  width,
                  height,
                  name: f.name.replace(/\.[^.]+$/, "").slice(0, 18) || "参考图",
                },
              ],
        );
      } catch {
        /* skip */
      }
    }
  }

  function thumbFor(id: string): string | undefined {
    const hasLoadedItems = Object.prototype.hasOwnProperty.call(itemsByProject, id);
    return selectCanvasThumbnailUrl(
      itemsByProject[id] ?? [],
      hasLoadedItems ? undefined : projects.find((project) => project.id === id)?.thumbnailUrl,
    );
  }

  function start(withBrief: boolean) {
    const b = brief.trim();
    if (withBrief && !b && refs.length === 0) return;
    const id = createProject({
      name: b ? b.slice(0, 16) : "未命名创作",
      scene: "brand_kv",
      targetSize: size,
    });
    // Drop attached reference images onto the new project's canvas, in a row.
    const refIds: string[] = [];
    let x = 0;
    for (const r of refs) {
      const fp = footprintFor(r.width, r.height, 300);
      const item: ReferenceItem = {
        id: uid("item"),
        projectId: id,
        type: "reference",
        position: { x, y: 0 },
        size: fp,
        z: 30,
        createdAt: Date.now(),
        assetUrl: r.dataUrl,
        naturalWidth: r.width,
        naturalHeight: r.height,
        source: "upload",
        label: r.name,
        hidden: true,
      };
      addItem(id, item);
      rememberAssetSource(item.id, r.originalDataUrl);
      refIds.push(item.id);
      x += fp.width + 28;
    }
    if (withBrief && b) sessionStorage.setItem(`aidc:brief:${id}`, b);
    if (refIds.length) sessionStorage.setItem(`aidc:refs:${id}`, JSON.stringify(refIds));
    navigateToProject(router, id);
  }

  const sizeLabel = (() => {
    for (const g of SIZE_GROUPS)
      for (const s of g.sizes) if (`${s.w}x${s.h}` === size) return `${s.label} ${s.w}×${s.h} · ${aspectRatioLabel(s.w, s.h)}`;
    const parsed = parseSize(size);
    return parsed
      ? `${parsed.width}×${parsed.height} · ${aspectRatioLabel(parsed.width, parsed.height)}`
      : size.replace("x", "×");
  })();
  const primaryReference = refs[0];

  return (
    <div
      className="relative flex h-full overflow-hidden bg-page"
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) attachFiles(e.dataTransfer.files);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
    >
      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,107,255,0.06)]">
          <div className="rounded-full border border-accent bg-white px-4 py-2 text-[13px] font-medium text-accent shadow-[var(--shadow-popover)]">
            松手，图片将作为参考进入对话框
          </div>
        </div>
      )}

      <HomeSidebar
        onNew={() => start(false)}
        onLibrary={() => setLibraryOpen(true)}
      />

      <main className="relative min-w-0 flex-1 overflow-hidden">
        {IS_GITHUB_PAGES && (
          <div className="absolute right-8 top-5 z-30">
            <ApiKeyButton />
          </div>
        )}
        <div className="mx-auto flex h-full w-full max-w-[1240px] flex-col px-8 pb-6 pt-5">
          <div className="h-10" />

          <section className="flex min-h-0 flex-1 flex-col items-center justify-center pb-2">
            <div className="flex w-full max-w-2xl flex-col items-center">
              <StarLogo size={54} />
              <h1 className="mt-5 text-center text-[32px] font-semibold leading-10 tracking-tight text-ink">
                {WELCOME.split("").map((ch, i) => (
                  <span
                    key={i}
                    className="inline-block animate-rise"
                    style={{ animationDelay: `${i * 0.028}s` }}
                  >
                    {ch}
                  </span>
                ))}
              </h1>
              <p className="mt-3 text-[14px] text-ink-3">
                描述目标、拖入参考图，然后在画布里继续标记和修改。
              </p>

              <div className="mt-7 w-full rounded-[20px] border border-line bg-white p-2 shadow-[0_1px_2px_rgba(0,0,0,0.03),0_18px_44px_-22px_rgba(0,0,0,0.22)] transition-shadow focus-within:border-accent focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.03),0_18px_44px_-18px_rgba(0,107,255,0.2)] focus-within:ring-2 focus-within:ring-[var(--color-accent-weak)]">
                {refs.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                    {refs.map((r, i) => (
                      <span
                        key={i}
                        className="group relative h-12 w-12 overflow-hidden rounded-[var(--radius-sm)] border border-line"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={r.dataUrl} alt={r.name} className="h-full w-full object-cover" />
                        <button
                          onClick={() => setRefs((rs) => rs.filter((_, j) => j !== i))}
                          className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                          aria-label="移除"
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <textarea
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  onPaste={(e) => {
                    const images = clipboardImageFiles(e.clipboardData);
                    if (!images.length) return;
                    e.preventDefault();
                    void attachFiles(images);
                  }}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      start(true);
                    }
                  }}
                  rows={3}
                  autoFocus
                  placeholder={typed || "描述你的画面…"}
                  className="block w-full resize-none bg-transparent px-3 py-2.5 text-[14px] leading-6 text-ink placeholder:text-ink-3 outline-none"
                />
                <div className="flex items-center justify-between px-1.5 pb-1.5">
                  <div className="flex items-center gap-1">
                    <div ref={sizeRef} className="relative">
                      <button
                        onClick={() => setSizeOpen((o) => !o)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-white px-3 text-[12px] text-ink-2 hover:bg-fill hover:text-ink"
                      >
                        {sizeLabel}
                        <ChevronDown size={13} className="text-ink-3" />
                      </button>
                      {sizeOpen && (
                        <div className="surface-popover absolute bottom-10 left-0 z-40 w-[340px] p-3 animate-pop">
                          <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
                            <div>
                              <div className="mb-1.5 text-[11px] font-medium text-ink-3">参考图</div>
                              <button
                                type="button"
                                disabled={!primaryReference}
                                onClick={() => {
                                  if (!primaryReference) return;
                                  setSize(`${primaryReference.width}x${primaryReference.height}`);
                                  setSizeOpen(false);
                                }}
                                title={primaryReference
                                  ? `采用第 1 张参考图的原始尺寸：${primaryReference.width}×${primaryReference.height}`
                                  : "请先添加参考图"}
                                className="flex w-full items-center justify-between rounded-[var(--radius-sm)] border border-line px-2.5 py-2 text-left text-[11px] transition-colors enabled:hover:bg-fill disabled:cursor-not-allowed disabled:opacity-45"
                              >
                                <span className="inline-flex items-center gap-1.5 font-medium text-ink-2">
                                  <ImagePlus size={13} /> 按参考图尺寸
                                </span>
                                <span className="font-mono text-[10px] text-ink-3">
                                  {primaryReference
                                    ? `${primaryReference.width}×${primaryReference.height} · ${aspectRatioLabel(primaryReference.width, primaryReference.height)}`
                                    : "先添加参考图"}
                                </span>
                              </button>
                            </div>
                            {SIZE_GROUPS.map((g) => (
                              <div key={g.group}>
                                <div className="mb-1.5 text-[11px] font-medium text-ink-3">{g.group}</div>
                                <div className="flex flex-wrap gap-1">
                                  {g.sizes.map((s) => {
                                    const v = `${s.w}x${s.h}`;
                                    const active = v === size;
                                    return (
                                      <button
                                        key={g.group + v}
                                        onClick={() => {
                                          setSize(v);
                                          setSizeOpen(false);
                                        }}
                                        className={cn(
                                          "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                                          active
                                            ? "border-accent bg-[var(--color-accent-weak)] text-accent"
                                            : "border-line text-ink-2 hover:bg-fill",
                                        )}
                                      >
                                        {s.label}{" "}
                                        <span className="font-mono text-[10px] opacity-70">
                                          {s.w}×{s.h} · {aspectRatioLabel(s.w, s.h)}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                            <div>
                              <div className="mb-1.5 text-[11px] font-medium text-ink-3">自定义尺寸（单位：像素 px）</div>
                              <CustomSizeInput
                                baseSize={size}
                                onCommit={(v) => {
                                  setSize(v);
                                  setSizeOpen(false);
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => fileRef.current?.click()}
                      className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-2 hover:bg-fill hover:text-ink"
                      title="添加参考图（也可直接拖拽到页面任意位置）"
                    >
                      <ImagePlus size={14} /> 参考图
                    </button>
                  </div>

                  <button
                    onClick={() => start(true)}
                    disabled={!brief.trim() && refs.length === 0}
                    className="flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-medium text-white transition-colors hover:bg-black disabled:opacity-40"
                  >
                    开始创作 <ArrowUp size={15} />
                  </button>
                </div>
              </div>
            </div>
          </section>

          <RecentProjects
            hydrated={hydrated}
            projects={projects}
            thumbFor={thumbFor}
            onNew={() => start(false)}
            onOpenLibrary={() => setLibraryOpen(true)}
          />
        </div>

        {libraryOpen && (
          <ProjectLibrary
            projects={projects}
            hydrated={hydrated}
            thumbFor={thumbFor}
            onClose={() => setLibraryOpen(false)}
            onNew={() => start(false)}
          />
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) attachFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </main>
    </div>
  );
}

function HomeSidebar({
  onNew,
  onLibrary,
}: {
  onNew: () => void;
  onLibrary: () => void;
}) {
  return (
    <aside className="z-20 flex h-full w-[72px] shrink-0 flex-col items-center border-r border-line bg-white/90 py-4 backdrop-blur-md">
      <button
        className="mb-7 flex h-10 w-10 items-center justify-center rounded-[12px] bg-transparent transition-transform hover:scale-105 hover:bg-fill"
        aria-label="星阵无限画布"
      >
        <StarLogo size={40} />
      </button>
      <nav className="flex flex-1 flex-col items-center gap-2">
        <SidebarButton label="首页" active icon={<Home size={20} />} />
        <SidebarButton label="新建" icon={<Plus size={21} />} onClick={onNew} />
        <SidebarButton label="项目库" icon={<FolderOpen size={20} />} onClick={onLibrary} />
      </nav>
    </aside>
  );
}

function SidebarButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <span className="group relative inline-flex">
      <button
        onClick={onClick}
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-[12px] text-ink-2 transition-all duration-200 hover:-translate-y-0.5 hover:bg-fill hover:text-ink",
          active && "bg-fill text-ink shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)]",
        )}
        aria-label={label}
      >
        {icon}
      </button>
      <span className="pointer-events-none absolute left-full top-1/2 z-40 ml-3 -translate-y-1/2 translate-x-[-4px] whitespace-nowrap rounded-full bg-ink px-2.5 py-1 text-[12px] font-medium text-white opacity-0 shadow-[var(--shadow-popover)] transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100">
        {label}
      </span>
    </span>
  );
}

function RecentProjects({
  hydrated,
  projects,
  thumbFor,
  onNew,
  onOpenLibrary,
}: {
  hydrated: boolean;
  projects: Project[];
  thumbFor: (id: string) => string | undefined;
  onNew: () => void;
  onOpenLibrary: () => void;
}) {
  const recent = projects.slice(0, 8);
  return (
    <section className="shrink-0 pb-1">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
          <Clock3 size={15} />
          最近项目
          {hydrated && projects.length > 0 && (
            <span className="font-normal text-ink-3">{projects.length}</span>
          )}
        </h2>
        <button
          onClick={onOpenLibrary}
          className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] text-ink-3 hover:bg-fill hover:text-ink"
        >
          查看全部 <ChevronRight size={14} />
        </button>
      </div>
      <div className="mt-3 flex gap-4 overflow-x-auto scroll-smooth pb-2">
        <NewProjectTile onClick={onNew} />
        {!hydrated
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="surface-card h-[214px] w-[240px] shrink-0 animate-pulse bg-fill" />
            ))
          : recent.length === 0
            ? (
                <div className="flex h-[166px] min-w-[280px] items-center rounded-[var(--radius-md)] border border-dashed border-line px-5 text-[13px] text-ink-3">
                  还没有项目，在上面说一句话马上开始。
                </div>
              )
            : recent.map((p) => (
                <div key={p.id} className="w-[240px] shrink-0 self-stretch">
                  <ProjectCard project={p} thumbnailUrl={thumbFor(p.id)} />
                </div>
              ))}
      </div>
    </section>
  );
}

function NewProjectTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex w-[240px] shrink-0 self-stretch flex-col rounded-[var(--radius-md)] border border-dashed border-line-2 bg-white text-left transition-all hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_12px_28px_-22px_rgba(0,107,255,0.5)]"
    >
      <div className="flex aspect-[16/10] items-center justify-center">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-fill text-ink-3 transition-colors group-hover:bg-[var(--color-accent-weak)] group-hover:text-accent">
          <Plus size={19} />
        </span>
      </div>
      <div className="flex min-h-[84px] flex-1 flex-col px-3.5 py-3">
        <div className="text-sm font-semibold text-ink">新建项目</div>
        <div className="mt-auto pt-2 text-[11px] text-ink-3">空白无限画布</div>
      </div>
    </button>
  );
}

function ProjectLibrary({
  projects,
  hydrated,
  thumbFor,
  onClose,
  onNew,
}: {
  projects: Project[];
  hydrated: boolean;
  thumbFor: (id: string) => string | undefined;
  onClose: () => void;
  onNew: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button className="absolute inset-0 bg-black/20 animate-fade" aria-label="关闭项目库" onClick={onClose} />
      <div className="surface-popover relative z-10 flex max-h-[82vh] w-full max-w-5xl flex-col overflow-hidden rounded-[18px] animate-pop">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">全部项目</h2>
            <p className="mt-0.5 text-[12px] text-ink-3">从最近创作继续，或新建一张空白画布。</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onNew}
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] bg-ink px-3 text-[13px] font-medium text-white hover:bg-black"
            >
              <Plus size={14} /> 新建
            </button>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-ink-2 hover:bg-fill hover:text-ink"
              aria-label="关闭"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto p-5">
          {!hydrated ? (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="surface-card aspect-[16/10] animate-pulse bg-fill" />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="flex h-44 items-center justify-center rounded-[var(--radius-md)] border border-dashed border-line text-[13px] text-ink-3">
              还没有项目。
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {projects.map((p) => (
                <ProjectCard key={p.id} project={p} thumbnailUrl={thumbFor(p.id)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StarLogo({ size = 44 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={publicAsset("/star-logo.png")}
      alt=""
      width={size}
      height={size}
      className="block object-contain"
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}

function CustomSizeInput({
  baseSize,
  onCommit,
}: {
  baseSize: string;
  onCommit: (v: string) => void;
}) {
  const initial = parseSize(baseSize) || { width: 1080, height: 1920 };
  const ratio = initial.width / initial.height;
  const [width, setWidth] = useState(String(initial.width));
  const [height, setHeight] = useState(String(initial.height));
  const [locked, setLocked] = useState(true);
  const value = `${width}x${height}`;
  const valid = !!parseSize(value);

  function changeWidth(next: string) {
    const clean = next.replace(/\D/g, "").slice(0, 5);
    setWidth(clean);
    const numeric = Number(clean);
    if (locked && numeric > 0) setHeight(String(Math.max(1, Math.round(numeric / ratio))));
  }

  function changeHeight(next: string) {
    const clean = next.replace(/\D/g, "").slice(0, 5);
    setHeight(clean);
    const numeric = Number(clean);
    if (locked && numeric > 0) setWidth(String(Math.max(1, Math.round(numeric * ratio))));
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-1.5">
      <label className="flex h-8 min-w-0 items-center rounded-[var(--radius-sm)] border border-line bg-white focus-within:border-accent">
        <input
          value={width}
          onChange={(e) => changeWidth(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && onCommit(value)}
          aria-label="自定义宽度（像素）"
          placeholder="宽"
          inputMode="numeric"
          className="min-w-0 flex-1 bg-transparent px-2 font-mono text-[12px] text-ink outline-none"
        />
        <span className="pr-1.5 font-mono text-[10px] text-ink-3">px</span>
      </label>
      <button
        type="button"
        onClick={() => setLocked((current) => !current)}
        aria-label={locked ? "解除自定义尺寸比例锁定" : "锁定自定义尺寸比例"}
        title={locked ? "已按当前画幅锁定比例" : "点击锁定当前画幅比例"}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full transition-colors",
          locked ? "bg-ink text-white" : "bg-fill text-ink-3 hover:bg-line",
        )}
      >
        {locked ? <Lock size={12} /> : <Unlock size={12} />}
      </button>
      <label className="flex h-8 min-w-0 items-center rounded-[var(--radius-sm)] border border-line bg-white focus-within:border-accent">
        <input
          value={height}
          onChange={(e) => changeHeight(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && onCommit(value)}
          aria-label="自定义高度（像素）"
          placeholder="高"
          inputMode="numeric"
          className="min-w-0 flex-1 bg-transparent px-2 font-mono text-[12px] text-ink outline-none"
        />
        <span className="pr-1.5 font-mono text-[10px] text-ink-3">px</span>
      </label>
      <button
        onClick={() => valid && onCommit(value)}
        disabled={!valid}
        className="h-8 rounded-[var(--radius-sm)] border border-line px-2 text-[12px] text-ink-2 hover:bg-fill disabled:opacity-40"
      >
        使用
      </button>
    </div>
  );
}
