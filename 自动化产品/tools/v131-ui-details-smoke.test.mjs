import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

const accountDialog = read("../js/views/accountDialog.js");
const componentsCss = read("../styles/components.css");
const baseCss = read("../styles/base.css");
const motionCss = read("../styles/ui-motion.css");
const viewsCss = read("../styles/views.css");
const workshopHtml = read("../apps/video-workshop/web/index.html");
const workshopJs = read("../apps/video-workshop/web/assets/app.js");
const workshopCss = read("../apps/video-workshop/web/assets/styles.css");
const agentCards = read("../js/agent/cards.js");

test("account avatar picker exposes real selected and drag feedback", () => {
  assert.match(accountDialog, /ad-image-drop avatar \$\{avatarUrl \? "has-image" : ""\}/);
  assert.match(accountDialog, /class="ad-avatar-ready"/);
  assert.match(accountDialog, /has-selection-feedback/);
  assert.match(accountDialog, /if \(!file\.type\.startsWith\("image\/"\)\)/);
  assert.match(componentsCss, /#adAvatarDrop\.drag-over::after[\s\S]*?松开即可更换头像/);
  assert.match(componentsCss, /@keyframes accountAvatarSelected/);
});

test("video workshop uses compact branded mode controls and a restrained assistant identity", () => {
  assert.equal((workshopHtml.match(/data-creation-mode="video"[^>]*>动态<\/button>/g) || []).length, 2);
  assert.equal((workshopHtml.match(/data-creation-mode="static"[^>]*>静态<\/button>/g) || []).length, 2);
  assert.doesNotMatch(workshopHtml, />动态视频<\/button>|>静态视频<\/button>/);
  assert.match(workshopJs, /function createMessageIdentity\(message\)/);
  assert.match(workshopJs, /className = `message-agent-avatar/);
  assert.match(workshopJs, /starmatrix-mascot-transparent\.png/);
  assert.doesNotMatch(workshopJs, /starmatrix-mascot-wink\.webp/);
  assert.match(workshopCss, /\.message-agent-avatar\.is-working/);
  assert.match(workshopCss, /html\[data-platform-workspace="true"\] \.creation-mode-switch button\.active[\s\S]*?#c9e3fb/);
});

test("canvas current row drops only its leading bar", () => {
  assert.match(baseCss, /\.wsctx-canvas-project-shell\.is-active::before\s*\{[^}]*content:\s*none;[^}]*display:\s*none;/s);
  assert.match(baseCss, /\.wsctx-video-project-shell\.is-working::after\s*\{/);
});

test("batch image row and voice action keep the v131 responsive polish", () => {
  assert.match(motionCss, /v131: keep the batch image controls[\s\S]*?grid-template-columns:\s*82px minmax\(150px, 1fr\) minmax\(104px, max-content\) 78px/);
  assert.match(motionCss, /v132:[\s\S]*?@media \(min-width: 981px\)[\s\S]*?\.agc-account-copy\.has-mode-switch\.has-image-count\s*\{[\s\S]*?display:\s*flex\s*!important;[\s\S]*?flex-flow:\s*row nowrap\s*!important/);
  assert.match(motionCss, /\.agc-account-copy\.has-mode-switch\.has-image-count\s+\.agc-mini-count\.img-count\s*\{[\s\S]*?grid-area:\s*auto\s*!important;[\s\S]*?flex:\s*0 0 78px/);
  assert.match(motionCss, /@media \(min-width: 521px\) and \(max-width: 620px\)[\s\S]*?grid-template-columns:\s*72px minmax\(96px, 1fr\) minmax\(88px, 108px\) 70px/);
  assert.match(motionCss, /v131: the primary voice action[\s\S]*?background:\s*linear-gradient\(135deg, #eaf5ff 0%, #cfe8ff 52%, #bcdcff 100%\)/);
  assert.match(motionCss, /clip-path:\s*inset\(0 round 14px\)/);
  assert.equal((agentCards.match(/class="agc-account-asset-btn"/g) || []).length, 1);
});

test("home media selector uses the tightened dynamic/static control", () => {
  assert.match(viewsCss, /v130 · 个人首页入口：[\s\S]*?\.product-home-miaoda \.home-video-mode\s*\{[\s\S]*?width:\s*60px;[\s\S]*?min-width:\s*60px;[\s\S]*?max-width:\s*60px;[\s\S]*?height:\s*32px;[\s\S]*?flex:\s*0 0 60px/);
  assert.match(viewsCss, /\.home-video-mode-wheel\s*\{\s*width:\s*26px;/);
});
