import { community } from "../core/remote.js";
import { currentMember } from "../core/store.js";
import { esc } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { openModal, toast } from "../ui/components.js?v=20260812-v1428-canvas-batch-stability-1";

const CATEGORIES = ["视频灵感", "视觉设计"];
const SAFE_MEDIA_PREFIXES = [
  "/api/files/",
  "/api/custom-canvas/blobs/",
  "/api/video/composed/",
  "/custom-video/outputs/",
];

function platformUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return "";
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.origin !== window.location.origin) return "";
    if (parsed.hash || raw.includes("\\") || parsed.pathname.includes("%")) return "";
    if ([...parsed.searchParams.keys()].some(key => key !== "asset_rev")) return "";
    const relative = parsed.pathname;
    return SAFE_MEDIA_PREFIXES.some(prefix => relative.startsWith(prefix)) ? relative : "";
  } catch (_) {
    return "";
  }
}

export function communityMedia(items = []) {
  return items.map(item => {
    const source = typeof item === "string" ? { url: item } : (item || {});
    const url = platformUrl(source.url || source.videoUrl || source.fileUrl || source.downloadUrl);
    if (!url) return null;
    const type = String(source.type || source.kind || "").toLowerCase() === "video"
      || /\.(?:mp4|webm|mov)(?:\?|$)/i.test(url)
      ? "video"
      : "image";
    return {
      url,
      type,
      width: Number(source.width || 0) || 0,
      height: Number(source.height || 0) || 0,
      alt: String(source.alt || source.title || "").slice(0, 160),
    };
  }).filter(Boolean).slice(0, 20);
}

export function markCommunityShared(trigger, post = null) {
  if (!(trigger instanceof HTMLElement)) return;
  trigger.disabled = true;
  trigger.dataset.communityShared = String(post?.id || "shared");
  trigger.classList.add("is-shared");
  trigger.innerHTML = `${icon("check", 14)} 已分享`;
  trigger.setAttribute("aria-label", "已分享到灵感社区");
}

export async function syncCommunityShareStatus(trigger, payload = {}, { onShared } = {}) {
  if (!currentMember()?.id) return null;
  const media = communityMedia(payload.media || []);
  if (!media.length) return null;
  try {
    const result = await community.status({
      authorId: String(payload.authorId || ""),
      sourceKind: String(payload.sourceKind || "delivery"),
      sourceId: String(payload.sourceId || "").slice(0, 160),
      sourceProjectId: String(payload.sourceProjectId || "").slice(0, 180),
      sourceOutputId: String(payload.sourceOutputId || "").slice(0, 180),
      sourceItemIds: [...new Set((Array.isArray(payload.sourceItemIds) ? payload.sourceItemIds : [])
        .map(item => String(item || "").trim().slice(0, 180))
        .filter(Boolean))].slice(0, 20),
      media,
      cover: communityMedia(payload.cover ? [payload.cover] : [])[0] || {},
    });
    if (result?.shared) {
      if (trigger instanceof HTMLElement) markCommunityShared(trigger, result.post);
      onShared?.(result.post);
    }
    return result;
  } catch (_) {
    return null;
  }
}

export function openCommunityShare({
  authorId = "",
  sourceKind = "delivery",
  sourceId = "",
  sourceProjectId = "",
  sourceOutputId = "",
  sourceItemIds = [],
  title = "",
  copy = "",
  prompt = "",
  category = "视觉设计",
  media = [],
  cover = null,
  trigger = null,
  onShared = null,
} = {}) {
  if (trigger instanceof HTMLElement && trigger.dataset.communityShared) {
    toast("这份成果已经分享过，无需重复分享");
    return;
  }
  const member = currentMember();
  if (!member || member.role === "guest") {
    window.dispatchEvent(new CustomEvent("xingzhen:auth-required", { detail: { reason: "community-share" } }));
    return;
  }
  const cleanMedia = communityMedia(media);
  const cleanCover = communityMedia(cover ? [cover] : [])[0] || {};
  if (!cleanMedia.length) {
    toast("这份成果还没有可公开访问的平台媒体，请先等待成果保存完成", "error");
    return;
  }
  const preview = cleanMedia.slice(0, 4).map(item => item.type === "video"
    ? `<video src="${esc(item.url)}" muted playsinline preload="metadata"></video>`
    : `<img src="${esc(item.url)}" alt="" />`
  ).join("");
  openModal(`
    <form class="community-share-dialog" data-community-share-form>
      <header><span>${icon("spark", 18)}</span><div><h2>分享到灵感社区</h2><p>只有你主动分享的成果才会公开。</p></div></header>
      <div class="community-share-preview">${preview}</div>
      <label><span>分类</span><select name="category">${CATEGORIES.map(item => `<option value="${esc(item)}" ${item === category ? "selected" : ""}>${esc(item)}</option>`).join("")}</select></label>
      <label><span>标题</span><input name="title" maxlength="120" required value="${esc(title || "我的星阵灵感")}" /></label>
      <label><span>内容说明</span><textarea name="copy" rows="3" maxlength="6000" placeholder="补充这份创作的想法与故事…">${esc(copy)}</textarea></label>
      <label><span>参考提示词</span><textarea name="prompt" rows="3" maxlength="6000" placeholder="可选，帮助其他人沿用这个灵感">${esc(prompt)}</textarea></label>
      <footer><button type="button" class="btn ghost" data-close-modal>取消</button><button type="submit" class="btn primary">${icon("send", 14)} 确认分享</button></footer>
    </form>
  `, {
    onMount(panel, close) {
      panel.classList.add("community-share-panel");
      panel.querySelector("[data-close-modal]")?.addEventListener("click", close);
      const form = panel.querySelector("[data-community-share-form]");
      form?.addEventListener("submit", async event => {
        event.preventDefault();
        const submit = form.querySelector("[type=submit]");
        submit.disabled = true;
        submit.textContent = "正在分享…";
        const data = new FormData(form);
        try {
          const post = await community.create({
            authorId: String(authorId || ""),
            sourceKind,
            sourceId: String(sourceId || "").slice(0, 160),
            sourceProjectId: String(sourceProjectId || "").slice(0, 180),
            sourceOutputId: String(sourceOutputId || "").slice(0, 180),
            sourceItemIds: [...new Set((Array.isArray(sourceItemIds) ? sourceItemIds : [])
              .map(item => String(item || "").trim().slice(0, 180))
              .filter(Boolean))].slice(0, 20),
            title: String(data.get("title") || "").trim(),
            copy: String(data.get("copy") || "").trim(),
            prompt: String(data.get("prompt") || "").trim(),
            category: String(data.get("category") || "视觉设计"),
            media: cleanMedia,
            cover: cleanCover,
          });
          markCommunityShared(trigger, post);
          onShared?.(post);
          close();
          toast(post?.alreadyShared ? "这份成果已经分享过" : "已分享到首页灵感社区", "success");
          window.dispatchEvent(new CustomEvent("xingzhen:community-updated"));
        } catch (error) {
          console.warn("[community-share]", error);
          toast("分享失败：" + (error?.message || "请稍后重试"), "error");
          submit.disabled = false;
          submit.innerHTML = `${icon("send", 14)} 确认分享`;
        }
      });
    },
  });
}
