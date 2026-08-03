import { esc } from "../core/util.js";
import { currentMember, currentTeam } from "../core/store.js";
import { community, teams } from "../core/remote.js";
import { go } from "../core/router.js";
import { icon } from "../ui/icons.js";
import { openModal, toast } from "../ui/components.js?v=20260802-v134-static-community-1";
import { mountHomeLightfall } from "../effects/homeLightfall.js?v=20260802-v134-static-community-1";

const HOME_LAUNCH_KEY = "starmatrix.homeLaunch.v1";
const HOME_LAUNCH_REGISTRY_KEY = "__starmatrixHomeLaunchRegistry";
const HOME_LAUNCH_TTL_MS = 10 * 60 * 1000;
const MAX_HOME_ATTACHMENTS = 8;
const HOME_TYPEWRITER_PHRASES = [
  "做一支节奏轻快的品牌解释短片",
  "把这些参考图变成连贯的静态视频",
  "围绕新产品设计一组统一风格的视觉",
  "用一段口播讲清楚这个故事",
];
const CATEGORIES = ["视频灵感", "视觉设计"];
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function homeLaunchRegistry() {
  const existing = window[HOME_LAUNCH_REGISTRY_KEY];
  if (existing instanceof Map) return existing;
  const registry = new Map();
  window[HOME_LAUNCH_REGISTRY_KEY] = registry;
  return registry;
}

function createHomeLaunchToken() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `home-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function stageHomeLaunch({ mode, creationMode, prompt, attachments }) {
  const createdAt = Date.now();
  const launchToken = createHomeLaunchToken();
  const registry = homeLaunchRegistry();
  const payload = { mode, creationMode, prompt, attachments, createdAt };
  const entry = { payload, expiresAt: createdAt + HOME_LAUNCH_TTL_MS };
  registry.set(launchToken, entry);
  const expiresAt = entry.expiresAt;
  window.setTimeout(() => {
    // Do not close over `entry`: it owns the Base64 payload and would otherwise
    // keep consumed attachments alive until the TTL timer fires.
    if (registry.get(launchToken)?.expiresAt === expiresAt) registry.delete(launchToken);
  }, HOME_LAUNCH_TTL_MS);
  try {
    sessionStorage.setItem(HOME_LAUNCH_KEY, JSON.stringify({
      mode,
      creationMode,
      prompt,
      launchToken,
      attachmentMeta: attachments.map(({ id, name, type }) => ({ id, name, type })),
      attachmentCount: attachments.length,
      createdAt,
    }));
  } catch (error) {
    registry.delete(launchToken);
    try { sessionStorage.removeItem(HOME_LAUNCH_KEY); } catch (_) {}
    throw error;
  }
  return launchToken;
}

function startTypewriter(input) {
  let phraseIndex = 0;
  let characterIndex = 0;
  let deleting = false;
  let timer = 0;
  let stopped = false;

  const schedule = delay => {
    clearTimeout(timer);
    timer = window.setTimeout(tick, delay);
  };
  const tick = () => {
    if (stopped || !input.isConnected) return;
    if (input.value) {
      input.placeholder = "";
      schedule(500);
      return;
    }
    const phrase = HOME_TYPEWRITER_PHRASES[phraseIndex % HOME_TYPEWRITER_PHRASES.length];
    if (!deleting) {
      characterIndex = Math.min(phrase.length, characterIndex + 1);
      input.placeholder = phrase.slice(0, characterIndex);
      if (characterIndex >= phrase.length) {
        deleting = true;
        schedule(1500);
        return;
      }
      schedule(62 + (characterIndex % 4) * 13);
      return;
    }
    characterIndex = Math.max(0, characterIndex - 1);
    input.placeholder = phrase.slice(0, characterIndex);
    if (!characterIndex) {
      deleting = false;
      phraseIndex = (phraseIndex + 1) % HOME_TYPEWRITER_PHRASES.length;
      schedule(440);
      return;
    }
    schedule(34);
  };
  schedule(480);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function inspirationCard(item) {
  const media = (item.media || [])[0] || {};
  const ratio = media.width && media.height ? `${media.width} / ${media.height}` : "auto";
  const poster = item.cover?.url || media.poster || "";
  const content = media.type === "video"
    ? `<video src="${esc(media.url)}" ${poster ? `poster="${esc(poster)}"` : ""} muted loop playsinline preload="metadata" aria-label="${esc(item.title)}"></video>`
    : `<img src="${esc(media.url)}" alt="${esc(item.title)}" loading="lazy" />`;
  return `<button class="home-inspiration-card" style="--community-ratio:${esc(ratio)}" type="button" data-home-inspiration="${esc(item.id)}" aria-label="${esc(item.title)}">
    <span class="home-inspiration-media">${content}</span>
  </button>`;
}

function homePetMarkup() {
  return `<span class="home-pet" aria-label="小星">
    <span class="home-pet-trail" aria-hidden="true"></span>
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcset="./assets/brand/starmatrix-mascot-transparent.png" />
      <img src="./assets/brand/starmatrix-mascot-wink.webp" alt="" draggable="false" decoding="async" />
    </picture>
  </span>`;
}

function inspirationDetail(item) {
  const media = (item.media || []).map(entry => entry.type === "video"
    ? `<video src="${esc(entry.url)}" controls muted playsinline preload="metadata"></video>`
    : `<img src="${esc(entry.url)}" alt="${esc(entry.alt || item.title)}" />`
  ).join("");
  openModal(`
    <article class="home-inspiration-detail">
      <div class="home-inspiration-detail-media">${media}</div>
      <div class="home-inspiration-detail-copy">
        <span>${esc(item.category)}</span>
        <h2>${esc(item.title)}</h2>
        <small>${esc(item.authorName || "星阵用户")}${item.teamName ? ` · ${esc(item.teamName)}` : ""}</small>
        ${item.copy ? `<p>${esc(item.copy)}</p>` : ""}
        ${item.prompt ? `<label>参考提示词</label><div class="home-prompt-preview">${esc(item.prompt)}</div>` : ""}
        <div class="home-inspiration-reactions">
          <button class="btn ghost" type="button" data-home-reaction="liked" aria-pressed="${item.viewerLiked ? "true" : "false"}">${icon("heart", 14)} <span>${item.viewerLiked ? "已点赞" : "点赞"}</span><em>${Number(item.likeCount || 0)}</em></button>
          <button class="btn ghost" type="button" data-home-reaction="favorited" aria-pressed="${item.viewerFavorited ? "true" : "false"}">${icon("bookmark", 14)} <span>${item.viewerFavorited ? "已收藏" : "收藏"}</span><em>${Number(item.favoriteCount || 0)}</em></button>
        </div>
      </div>
    </article>
  `, {
    onMount(panel, close) {
      panel.classList.add("home-inspiration-panel");
      panel.querySelectorAll("[data-home-reaction]").forEach(button => button.addEventListener("click", async event => {
        event.preventDefault();
        const field = button.dataset.homeReaction;
        const next = button.getAttribute("aria-pressed") !== "true";
        button.disabled = true;
        try {
          const result = await community.react(item.id, { [field]: next });
          Object.assign(item, result);
          button.setAttribute("aria-pressed", next ? "true" : "false");
          button.querySelector("span").textContent = next
            ? (field === "liked" ? "已点赞" : "已收藏")
            : (field === "liked" ? "点赞" : "收藏");
          button.querySelector("em").textContent = String(field === "liked" ? result.likeCount : result.favoriteCount);
        } catch (error) {
          if (/登录|401|未登录/.test(String(error?.message || ""))) {
            window.dispatchEvent(new CustomEvent("xingzhen:auth-required", { detail: { reason: "community-reaction" } }));
          } else toast(error?.message || "操作失败，请稍后重试", "error");
        } finally { button.disabled = false; }
      }));
    },
  });
}

function openHomeTeamJoinDialog() {
  openModal(`
    <section class="home-team-join-dialog" aria-labelledby="homeTeamJoinTitle">
      <span class="team-join-icon">${icon("users", 20)}</span>
      <div class="team-join-heading">
        <b id="homeTeamJoinTitle">申请加入团队</b>
        <em>搜索平台内已建立的团队，选择后提交申请。团队所有者和管理员会收到消息。</em>
      </div>
      <label class="field home-team-search">搜索团队
        <input class="input" type="search" data-home-team-search autocomplete="organization" placeholder="输入团队名称" />
      </label>
      <div class="home-team-results" data-home-team-results aria-live="polite"><span>正在读取团队…</span></div>
      <label class="field">申请说明（可选）
        <textarea class="input" data-home-team-message rows="3" maxlength="240" placeholder="简单说明你的身份，方便管理员确认"></textarea>
      </label>
      <div class="team-join-actions">
        <span data-home-team-status>请选择要申请加入的团队。</span>
        <button class="btn primary" type="button" data-home-team-submit disabled>${icon("send", 14)} 提交申请</button>
      </div>
    </section>
  `, {
    onMount(panel, close) {
      const search = panel.querySelector("[data-home-team-search]");
      const results = panel.querySelector("[data-home-team-results]");
      const submit = panel.querySelector("[data-home-team-submit]");
      const status = panel.querySelector("[data-home-team-status]");
      let items = [];
      let selected = null;
      const draw = () => {
        const query = String(search?.value || "").trim().toLowerCase();
        const filtered = items.filter(item => !query || String(item.name || "").toLowerCase().includes(query));
        results.innerHTML = filtered.length ? filtered.map(item => `
          <button class="home-team-result${selected?.id === item.id ? " is-selected" : ""}" type="button" data-home-team-id="${esc(item.id)}">
            <span><b>${esc(item.name)}</b><em>${item.kind === "internal" ? "内部团队 · 不限席位" : `${Number(item.seatsAvailable || 0)} 个可用席位`}</em></span>
            ${selected?.id === item.id ? icon("check", 15) : ""}
          </button>
        `).join("") : `<span>${query ? "没有找到匹配团队" : "目前没有可加入团队"}</span>`;
        submit.disabled = !selected;
        status.textContent = selected ? `将向「${selected.name}」提交加入申请。` : "请选择要申请加入的团队。";
      };
      search?.addEventListener("input", draw);
      results?.addEventListener("click", event => {
        const button = event.target.closest("[data-home-team-id]");
        if (!button) return;
        selected = items.find(item => String(item.id) === button.dataset.homeTeamId) || null;
        draw();
      });
      submit?.addEventListener("click", async () => {
        if (!selected) return;
        submit.disabled = true;
        status.textContent = "正在提交申请…";
        try {
          await teams.requestJoin(selected.name, panel.querySelector("[data-home-team-message]")?.value.trim() || "");
          close();
          toast(`已向「${selected.name}」提交加入申请`);
        } catch (error) {
          status.textContent = error?.message || "提交失败，请稍后重试";
          submit.disabled = false;
        }
      });
      teams.list().then(result => {
        items = Array.isArray(result) ? result : (result?.items || []);
        draw();
        search?.focus();
      }).catch(error => {
        results.innerHTML = `<span>${esc(error?.message || "团队列表读取失败")}</span>`;
      });
    },
  });
}

export const homeView = {
  title: "首页",
  render(root) {
    root.__viewCleanup?.();
    root.__viewCleanup = null;
    const member = currentMember() || {};
    const team = currentTeam();
    const unlimited = team?.name === "ACG市场部" || team?.kind === "internal";
    const canRequestTeam = member.role === "user" && !team;
    const pointLabel = unlimited ? "∞" : String(member.points ?? 70);
    let mode = "video";
    let creationMode = "video";
    let category = "";
    let attachments = [];
    let inspirations = [];
    let inspirationRequest = 0;

    root.innerHTML = `<section class="product-home product-home-lovart product-home-miaoda">
      <header class="home-topline">
        <div class="home-account-tools">
          ${canRequestTeam ? `<button class="home-team-join-button" type="button" data-home-team-join>${icon("users", 14)}<span>加入团队</span></button>` : ""}
          <div class="home-points-wrap">
            <button class="home-points-button" type="button" data-subscription-open aria-label="查看积分与订阅方案">
              ${icon("spark", 14)} <b>${esc(pointLabel)}</b><i></i><span>升级</span>
            </button>
            <div class="home-points-popover">
              <header><b>${unlimited ? "ACG 团队版" : "Free"}</b><button type="button" data-subscription-open>订阅管理</button></header>
              <p><span>${icon("spark", 16)} 积分</span><b>${esc(pointLabel)}</b></p>
              <p><span>${icon("gift", 16)} 每日免费积分</span><b>${unlimited ? "无限" : "70"}</b></p>
              <small>${unlimited ? "内部团队默认使用无限积分" : "每天重置为 70 免费积分"}</small>
            </div>
          </div>
        </div>
      </header>

      <main class="home-main">
        <section class="home-hero-composer">
          <div class="home-hero-wordmark" aria-hidden="true">STARMATRIX</div>
          <div class="home-hero-title">
            <div class="home-mascot-hero">${homePetMarkup()}</div>
            <span class="home-hero-title-art" role="img" aria-label="和小星一起创作！">
              <img src="./assets/brand/starmatrix-hero-title-transparent.png" alt="" draggable="false" />
            </span>
          </div>
          <p>懂你的素材助理，一句话唤醒！</p>
          <div class="home-composer-stage">
            <div class="home-lightfall" id="homeLightfall" aria-hidden="true"></div>
            <form class="home-composer" id="homeComposer">
              <div class="home-drop-feedback" aria-hidden="true">${icon("upload", 20)}<span>松开即可把素材带进创作</span></div>
              <div class="home-attachment-strip" id="homeAttachments" hidden></div>
              <textarea id="homePrompt" rows="3" aria-label="描述你想创作的内容"></textarea>
              <footer>
                <div class="home-composer-left">
                  <label class="home-add-file" title="上传素材" aria-label="上传素材">${icon("upload", 18)}<input id="homeFiles" type="file" multiple hidden accept="image/*,video/*,audio/*" /></label>
                </div>
                <div class="home-composer-tools">
                  <div class="home-mode-switch" role="tablist" aria-label="创作工具">
                    <i aria-hidden="true"></i>
                    <button class="is-active" type="button" data-home-mode="video" role="tab" aria-selected="true" aria-label="视频工坊">
                      ${icon("film", 13)}<span>视频</span><em>理解脚本与附件，创建导演式视频任务</em>
                    </button>
                    <button type="button" data-home-mode="canvas" role="tab" aria-selected="false" aria-label="无限画布">
                      ${icon("layers", 13)}<span>图片</span><em>把图片与想法带入自由视觉画布</em>
                    </button>
                  </div>
                  <button class="home-video-mode" id="homeVideoMode" type="button" data-mode="video" aria-label="当前为动态视频，点击切换为静态视频" title="点击切换动态视频 / 静态视频">
                    <span class="home-video-mode-wheel" aria-hidden="true"><b>动态</b><b>静态</b></span>
                    ${icon("refresh", 12)}
                    <span class="home-video-mode-hint" role="tooltip"><b>动态视频</b>调用视频模型生成连续镜头；<b>静态视频</b>使用图片分镜、口播与字幕渲染成片。</span>
                  </button>
                </div>
                <button class="home-submit" type="submit" aria-label="开始创作" title="开始创作">${icon("arrowUp", 19)}</button>
              </footer>
            </form>
          </div>
        </section>

        <section class="home-discovery">
          <header><div><span>DISCOVER</span><h2>灵感发现</h2></div></header>
          <nav class="home-category-tabs" aria-label="灵感分类">
            <button class="is-active" type="button" aria-pressed="true" data-home-category="">全部</button>
            ${CATEGORIES.map(item => `<button type="button" aria-pressed="false" data-home-category="${esc(item)}">${esc(item)}</button>`).join("")}
          </nav>
          <div class="home-inspiration-grid" id="homeInspirationGrid" aria-live="polite"><div class="home-community-empty">正在读取社区灵感…</div></div>
        </section>
      </main>
    </section>`;

    const composer = root.querySelector("#homeComposer");
    const input = root.querySelector("#homePrompt");
    const fileInput = root.querySelector("#homeFiles");
    const strip = root.querySelector("#homeAttachments");
    const videoModeToggle = root.querySelector("#homeVideoMode");
    const videoModeWrap = root.querySelector(".home-video-mode");
    const inspirationGrid = root.querySelector("#homeInspirationGrid");
    const lightfall = root.querySelector("#homeLightfall");
    const homeSection = root.querySelector(".product-home");
    const eventController = new AbortController();
    const lightfallController = mountHomeLightfall(lightfall, {
      interactionTarget: root.querySelector(".home-composer-stage"),
    });
    const stopTypewriter = startTypewriter(input);
    root.__viewCleanup = () => {
      eventController.abort();
      stopTypewriter();
      lightfallController.destroy();
    };

    const bindCommunityPreview = () => {
      inspirationGrid.querySelectorAll("video").forEach(video => {
        video.addEventListener("mouseenter", () => video.play().catch(() => {}), { signal: eventController.signal });
        video.addEventListener("mouseleave", () => {
          video.pause();
          try { video.currentTime = 0; } catch (_) {}
        }, { signal: eventController.signal });
      });
    };
    const loadInspirations = async () => {
      const requestId = ++inspirationRequest;
      inspirationGrid.setAttribute("aria-busy", "true");
      inspirationGrid.innerHTML = `<div class="home-community-empty">正在读取社区灵感…</div>`;
      try {
        const page = await community.list({ category, limit: 48 });
        if (requestId !== inspirationRequest || !inspirationGrid.isConnected) return;
        inspirations = Array.isArray(page?.items) ? page.items : [];
        inspirationGrid.innerHTML = inspirations.length
          ? inspirations.map(inspirationCard).join("")
          : `<div class="home-community-empty"><b>这个分类还没有人分享</b><span>在视频工坊、无限画布或发布清单中将成果分享到社区。</span></div>`;
        bindCommunityPreview();
      } catch (error) {
        if (requestId !== inspirationRequest || !inspirationGrid.isConnected) return;
        inspirations = [];
        inspirationGrid.innerHTML = `<button class="home-community-empty is-error" type="button" data-community-retry><b>社区灵感暂时没有读取成功</b><span>点击重试</span></button>`;
      } finally {
        if (requestId === inspirationRequest) inspirationGrid.removeAttribute("aria-busy");
      }
    };
    void loadInspirations();

    const renderAttachments = () => {
      strip.hidden = !attachments.length;
      strip.innerHTML = attachments.map(item => `<span class="home-attachment-chip">
        ${item.type.startsWith("image/") ? `<img src="${esc(item.dataUrl)}" alt="" />` : icon(item.type.startsWith("video/") ? "video" : "music", 14)}
        <b>${esc(item.name)}</b><button type="button" data-home-remove="${esc(item.id)}" aria-label="移除 ${esc(item.name)}">×</button>
      </span>`).join("");
    };
    const addFiles = async fileList => {
      const accepted = [...(fileList || [])].filter(file => (
        mode === "canvas" ? file.type.startsWith("image/") : /^(image|video|audio)\//.test(file.type)
      ));
      if (!accepted.length) {
        toast(mode === "canvas" ? "无限画布仅支持图片素材" : "请添加图片、视频或音频");
        return;
      }
      for (const file of accepted.slice(0, Math.max(0, MAX_HOME_ATTACHMENTS - attachments.length))) {
        if (file.size > 12 * 1024 * 1024) {
          toast(`${file.name} 超过首页传递上限 12MB`, "error");
          continue;
        }
        try {
          const dataUrl = await fileToDataUrl(file);
          if (!dataUrl) throw new Error("读取结果为空");
          attachments.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: file.name,
            type: file.type,
            dataUrl,
          });
        } catch (error) {
          console.warn("[home-attachment-read]", file.name, error);
          toast(`${file.name} 读取失败，请重新添加`, "error");
        }
      }
      renderAttachments();
    };

    root.querySelectorAll("[data-home-mode]").forEach(button => {
      button.addEventListener("click", () => {
        mode = button.dataset.homeMode === "canvas" ? "canvas" : "video";
        composer.dataset.mode = mode;
        root.querySelectorAll("[data-home-mode]").forEach(item => {
          const active = item === button;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-selected", active ? "true" : "false");
        });
        if (mode === "canvas") {
          const removed = attachments.filter(item => !item.type.startsWith("image/")).length;
          attachments = attachments.filter(item => item.type.startsWith("image/"));
          if (removed) toast(`已移除 ${removed} 个无限画布不支持的非图片素材`);
        }
        fileInput.accept = mode === "canvas" ? "image/*" : "image/*,video/*,audio/*";
        videoModeWrap.hidden = mode !== "video";
        renderAttachments();
      });
    });
    root.querySelectorAll("[data-subscription-open]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        go("subscription");
      });
    });
    root.querySelector("[data-home-team-join]")?.addEventListener("click", openHomeTeamJoinDialog);
    videoModeToggle.addEventListener("click", () => {
      creationMode = creationMode === "static" ? "video" : "static";
      videoModeToggle.dataset.mode = creationMode;
      videoModeToggle.setAttribute(
        "aria-label",
        creationMode === "static"
          ? "当前为静态视频，点击切换为动态视频"
          : "当前为动态视频，点击切换为静态视频",
      );
    });
    fileInput.addEventListener("change", async () => {
      await addFiles(fileInput.files);
      fileInput.value = "";
    });
    input.addEventListener("paste", event => {
      const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean);
      if (files.length) void addFiles(files);
    });
    let dragDepth = 0;
    composer.addEventListener("dragenter", event => {
      event.preventDefault();
      dragDepth += 1;
      composer.classList.add("is-dragging");
    });
    composer.addEventListener("dragover", event => {
      event.preventDefault();
      composer.classList.add("is-dragging");
    });
    composer.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) composer.classList.remove("is-dragging");
    });
    composer.addEventListener("drop", event => {
      event.preventDefault();
      dragDepth = 0;
      composer.classList.remove("is-dragging");
      void addFiles(event.dataTransfer?.files);
    });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      composer.requestSubmit();
    });
    strip.addEventListener("click", event => {
      const remove = event.target.closest("[data-home-remove]");
      if (!remove) return;
      attachments = attachments.filter(item => item.id !== remove.dataset.homeRemove);
      renderAttachments();
    });
    composer.addEventListener("submit", event => {
      event.preventDefault();
      const prompt = input.value.trim();
      if (!prompt && !attachments.length) {
        toast("先说一句想做什么，或添加一个素材");
        input.focus();
        return;
      }
      if (currentMember()?.role === "guest") {
        window.dispatchEvent(new CustomEvent("xingzhen:auth-required", {
          detail: { reason: "create", target: { zone: "custom", page: mode } }
        }));
        return;
      }
      try {
        stageHomeLaunch({ mode, creationMode, prompt, attachments });
      } catch (error) {
        console.warn("[home-launch-stage]", error);
        toast("素材暂存失败，请重试或减少附件", "error");
        return;
      }
      go("custom", mode, "__new__");
    });
    homeSection?.addEventListener("pointermove", event => {
      const bounds = homeSection.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
      const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height)));
      homeSection.style.setProperty("--home-pointer-x", `${(x * 100).toFixed(2)}%`);
      homeSection.style.setProperty("--home-pointer-y", `${(y * 100).toFixed(2)}%`);
    }, { signal: eventController.signal, passive: true });
    homeSection?.addEventListener("pointerleave", () => {
      homeSection.style.setProperty("--home-pointer-x", "50%");
      homeSection.style.setProperty("--home-pointer-y", "20%");
    }, { signal: eventController.signal });
    root.querySelectorAll("[data-home-category]").forEach(button => {
      button.addEventListener("click", () => {
        const nextCategory = button.dataset.homeCategory || "";
        category = category === nextCategory ? "" : nextCategory;
        root.querySelectorAll("[data-home-category]").forEach(item => {
          const active = item.dataset.homeCategory === category;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-pressed", active ? "true" : "false");
        });
        void loadInspirations();
      });
    });
    root.addEventListener("click", event => {
      if (event.target.closest("[data-community-retry]")) {
        void loadInspirations();
        return;
      }
      const card = event.target.closest("[data-home-inspiration]");
      if (!card) return;
      const item = inspirations.find(entry => entry.id === card.dataset.homeInspiration);
      if (item) inspirationDetail(item);
    }, { signal: eventController.signal });
  },
};
