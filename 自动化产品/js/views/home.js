import { esc } from "../core/util.js";
import { state, save, hasEntitlement } from "../core/store.js";
import { go } from "../core/router.js";
import { toast } from "../ui/components.js?v=20260729-v122-team-3";

const SKILLS = [
  {
    id: "brand-motion",
    eyebrow: "品牌视觉",
    title: "流光品牌短片",
    summary: "用品牌图与一句主题快速形成动态视觉提案。",
    route: ["custom", "video"],
    tone: "violet",
  },
  {
    id: "poster-remix",
    eyebrow: "视觉模板",
    title: "海报风格迁移",
    summary: "保留信息结构，快速尝试不同版式与视觉方向。",
    route: ["custom", "canvas"],
    tone: "blue",
  },
  {
    id: "voice-studio",
    eyebrow: "声音工作流",
    title: "文本转品牌声音",
    summary: "选择声线、调整语速，并生成可复用的口播素材。",
    route: ["custom", "voice"],
    tone: "orange",
  },
  {
    id: "campaign-batch",
    eyebrow: "团队 Skill",
    title: "批量内容生产",
    summary: "从账号与选题开始，批量组织内容生产任务。",
    route: ["agent", null],
    entitlement: "batch",
    tone: "green",
  },
];

function savedSkillIds() {
  return new Set(Array.isArray(state.ui.skillLibrary) ? state.ui.skillLibrary : []);
}

function skillCard(skill, saved) {
  return `<article class="home-skill-card tone-${esc(skill.tone)}" data-home-skill="${esc(skill.id)}">
    <div class="home-skill-media">
      <video muted loop playsinline preload="metadata" poster="./assets/brand/main-login-fallback.png">
        <source src="./assets/brand/main-login-bg.mp4" type="video/mp4" />
      </video>
      <span class="home-skill-play" aria-hidden="true">▶</span>
      ${skill.entitlement && !hasEntitlement(skill.entitlement) ? `<span class="home-skill-lock">团队版</span>` : ""}
    </div>
    <div class="home-skill-copy">
      <span>${esc(skill.eyebrow)}</span>
      <h3>${esc(skill.title)}</h3>
      <p>${esc(skill.summary)}</p>
      <div class="home-skill-actions">
        <button type="button" data-home-open="${esc(skill.id)}">打开</button>
        <button type="button" class="${saved ? "is-saved" : ""}" data-home-save="${esc(skill.id)}">${saved ? "已加入技能库" : "加入技能库"}</button>
      </div>
    </div>
  </article>`;
}

export const homeView = {
  title: "首页",
  render(root) {
    const saved = savedSkillIds();
    root.innerHTML = `<section class="product-home">
      <header class="product-home-hero">
        <div>
          <span class="product-home-kicker">XINGZHEN CREATIVE OS</span>
          <h1>今天想创造什么？</h1>
          <p>从一个 Skill 开始，也可以直接进入画布、视频工坊或语音生成。</p>
        </div>
        <div class="product-home-quick">
          <button type="button" data-home-route="custom/canvas"><b>无限画布</b><em>生成与编辑视觉</em></button>
          <button type="button" data-home-route="custom/video"><b>视频工坊</b><em>导演式视频创作</em></button>
          <button type="button" data-home-route="custom/voice"><b>语音生成</b><em>文本转自然声音</em></button>
        </div>
      </header>

      <section class="home-events" aria-label="新事件与更新">
        <div class="home-section-heading"><div><span>NEW & NOTEWORTHY</span><h2>最近上新</h2></div></div>
        <div class="home-event-strip">
          <article><span>新功能</span><b>统一工作区现已上线</b><p>视频、画布与声音创作都可以从同一工作区进入。</p></article>
          <article><span>团队协作</span><b>团队成员与共享额度</b><p>团队管理员可以创建成员，并集中管理工作区能力。</p></article>
          <article><span>Skill 预告</span><b>官方模板正在扩充</b><p>后续会持续加入可预览、可收藏、可复用的创作 Skill。</p></article>
        </div>
      </section>

      <section class="home-skills">
        <div class="home-section-heading">
          <div><span>OFFICIAL SKILLS</span><h2>从灵感到作品</h2></div>
          <p>悬停预览，加入自己的技能库后随时复用。</p>
        </div>
        <div class="home-skill-grid">${SKILLS.map(skill => skillCard(skill, saved.has(skill.id))).join("")}</div>
      </section>
    </section>`;

    root.querySelectorAll(".home-skill-card").forEach(card => {
      const video = card.querySelector("video");
      card.addEventListener("pointerenter", () => video?.play?.().catch(() => {}));
      card.addEventListener("pointerleave", () => { if (video) { video.pause(); video.currentTime = 0; } });
    });
    root.querySelectorAll("[data-home-route]").forEach(button => {
      button.addEventListener("click", () => {
        const [zone, page] = button.dataset.homeRoute.split("/");
        go(zone, page || null);
      });
    });
    root.querySelectorAll("[data-home-open]").forEach(button => {
      button.addEventListener("click", () => {
        const skill = SKILLS.find(item => item.id === button.dataset.homeOpen);
        if (!skill) return;
        if (skill.entitlement && !hasEntitlement(skill.entitlement)) {
          toast("这是团队功能。加入团队后即可使用。");
          go("settings", "team");
          return;
        }
        go(skill.route[0], skill.route[1]);
      });
    });
    root.querySelectorAll("[data-home-save]").forEach(button => {
      button.addEventListener("click", () => {
        const id = button.dataset.homeSave;
        const ids = savedSkillIds();
        if (ids.has(id)) ids.delete(id); else ids.add(id);
        state.ui.skillLibrary = [...ids];
        save("meta");
        button.classList.toggle("is-saved", ids.has(id));
        button.textContent = ids.has(id) ? "已加入技能库" : "加入技能库";
        toast(ids.has(id) ? "已加入你的技能库" : "已从技能库移除");
      });
    });
  },
};
