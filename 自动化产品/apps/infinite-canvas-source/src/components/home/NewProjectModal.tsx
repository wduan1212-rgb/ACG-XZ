"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plane, Image as ImageIcon, Layout, Sparkles } from "lucide-react";
import { Button, Field, inputClass, Modal } from "@/components/ui";
import { SizePlanBadge } from "@/components/SizePlanBadge";
import { COMMON_SIZES, SCENES, SCENE_ORDER } from "@/lib/constants";
import { navigateToProject } from "@/lib/runtime";
import { parseSize } from "@/lib/sizing";
import { useStore } from "@/lib/store";
import type { Scene } from "@/lib/types";

const SCENE_ICON: Record<Scene, typeof Plane> = {
  enterprise_poster: ImageIcon,
  airport_screen: Plane,
  banner: Layout,
  brand_kv: Sparkles,
};

export function NewProjectModal({
  open,
  onClose,
  initialSize,
}: {
  open: boolean;
  onClose: () => void;
  initialSize?: string;
}) {
  const router = useRouter();
  const createProject = useStore((s) => s.createProject);

  const [name, setName] = useState("");
  const [scene, setScene] = useState<Scene>("airport_screen");
  const [size, setSize] = useState(initialSize ?? SCENES.airport_screen.defaultSize);

  // Reset the form each time the modal transitions to open (render-phase pattern).
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setName("");
      setScene("airport_screen");
      setSize(initialSize ?? SCENES.airport_screen.defaultSize);
    }
  }

  const valid = !!parseSize(size);

  function pickScene(s: Scene) {
    setScene(s);
    setSize(SCENES[s].defaultSize);
  }

  function handleCreate() {
    if (!valid) return;
    const id = createProject({
      name: name.trim() || `${SCENES[scene].label}项目`,
      scene,
      targetSize: size,
    });
    onClose();
    navigateToProject(router, id);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建项目"
      subtitle="选择场景与目标尺寸，进入画布开始生产。"
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={handleCreate} disabled={!valid}>
            新建并进入
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="项目名称" hint="可留空">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${SCENES[scene].label}项目`}
            className={inputClass}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid) handleCreate();
            }}
          />
        </Field>

        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink">项目场景</div>
          <div className="grid grid-cols-2 gap-2">
            {SCENE_ORDER.map((s) => {
              const meta = SCENES[s];
              const Icon = SCENE_ICON[s];
              const selected = scene === s;
              return (
                <button
                  key={s}
                  onClick={() => pickScene(s)}
                  className={
                    "flex items-start gap-3 rounded-[var(--radius-md)] border p-3 text-left transition-colors focus-ring " +
                    (selected
                      ? "border-accent bg-[var(--color-accent-weak)]"
                      : "border-line bg-white hover:bg-fill")
                  }
                >
                  <span
                    className={
                      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] " +
                      (selected
                        ? "bg-accent text-white"
                        : "bg-fill text-ink-2")
                    }
                  >
                    <Icon size={16} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-ink">
                      {meta.label}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-3">
                      {meta.defaultSize}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[12px] text-ink-3">{SCENES[scene].hint}</p>
        </div>

        <Field label="目标尺寸" hint="宽 × 高（像素）">
          <input
            value={size}
            onChange={(e) => setSize(e.target.value)}
            placeholder="1920x1080"
            className={inputClass + " font-mono"}
          />
        </Field>

        <div className="flex flex-wrap gap-1.5">
          {COMMON_SIZES.map((cs) => {
            const v = `${cs.w}x${cs.h}`;
            const active = size.replace(/\s/g, "").toLowerCase() === v;
            return (
              <button
                key={v}
                onClick={() => setSize(v)}
                className={
                  "rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors " +
                  (active
                    ? "border-accent bg-[var(--color-accent-weak)] text-accent"
                    : "border-line text-ink-2 hover:bg-fill")
                }
              >
                {cs.w}×{cs.h}
              </button>
            );
          })}
        </div>

        <div className="rounded-[var(--radius-md)] border border-line bg-[#fcfcfc] px-3 py-2.5">
          <SizePlanBadge size={size} />
        </div>
      </div>
    </Modal>
  );
}
