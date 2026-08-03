"use client";

import { useState } from "react";
import { CheckCircle2, KeyRound, Trash2 } from "lucide-react";
import { Button, Modal } from "@/components/ui";
import {
  getClientImageApiKey,
  hasClientImageApiKey,
  setClientImageApiKey,
} from "@/lib/clientKeys";
import { CLIENT_PROVIDER_ENABLED } from "@/lib/runtime";

export function ApiKeyButton() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);

  if (!CLIENT_PROVIDER_ENABLED) return null;

  function openModal() {
    setKey(getClientImageApiKey());
    setSaved(hasClientImageApiKey());
    setOpen(true);
  }

  function save() {
    setClientImageApiKey(key);
    setSaved(hasClientImageApiKey());
    setOpen(false);
  }

  function clear() {
    setKey("");
    setClientImageApiKey("");
    setSaved(false);
  }

  return (
    <>
      <button
        onClick={openModal}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-white/90 px-3 text-[12px] font-medium text-ink-2 shadow-[var(--shadow-card)] backdrop-blur hover:bg-fill hover:text-ink"
      >
        {saved ? <CheckCircle2 size={14} className="text-[#1f7d37]" /> : <KeyRound size={14} />}
        图片 API Key
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="图片 API Key"
        subtitle="仅保存在当前浏览器，用于 GitHub Pages 版本直连图片模型。"
        width={480}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            {saved && (
              <Button variant="danger" onClick={clear}>
                <Trash2 size={14} /> 清除
              </Button>
            )}
            <Button variant="primary" onClick={save} disabled={!key.trim()}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block text-[13px] font-medium text-ink">API Key</label>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            type="password"
            autoFocus
            placeholder="粘贴你的图片模型 API Key"
            className="h-10 w-full rounded-[var(--radius-sm)] border border-line bg-white px-3 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-[var(--color-accent-weak)]"
          />
          <p className="text-[12px] leading-5 text-ink-3">
            专供版默认调用 Tencent MaaS 图片模型 custom-textmodel-gt。Key 不会提交到仓库，也不会同步到其他浏览器。
          </p>
        </div>
      </Modal>
    </>
  );
}
