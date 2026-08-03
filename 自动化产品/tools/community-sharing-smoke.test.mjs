import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("home inspiration is populated from the public community API", async () => {
  const [home, remote, styles] = await Promise.all([
    read("js/views/home.js"),
    read("js/core/remote.js"),
    read("styles/views.css"),
  ]);

  assert.match(home, /await community\.list\(\{ category, limit: 48 \}\)/);
  assert.match(home, /muted loop playsinline/);
  assert.match(home, /mouseenter[\s\S]*?video\.play\(\)/);
  assert.match(home, /mouseleave[\s\S]*?video\.pause\(\)/);
  assert.match(home, /item\.cover\?\.url \|\| media\.poster/);
  assert.match(home, /\$\{esc\(item\.authorName \|\| "星阵用户"\)\}\$\{item\.teamName/);
  assert.match(home, /const canRequestTeam = member\.role === "user" && !team/);
  assert.match(home, /data-home-team-join/);
  assert.match(styles, /\.product-home-miaoda \.home-inspiration-grid[\s\S]*?columns:\s*4 !important/);
  assert.match(styles, /break-inside:\s*avoid !important/);
  assert.doesNotMatch(home, /const INSPIRATIONS\s*=/);
  assert.match(remote, /export const community =/);
  assert.match(remote, /\/api\/community\/posts/);
});

test("all product surfaces expose a persistent share action", async () => {
  const [creation, delivery, video, videoBridge, canvasBridge, canvasTop, canvasWorkspace] = await Promise.all([
    read("js/views/customCreation.js"),
    read("js/views/deliveryView.js"),
    read("apps/video-workshop/web/assets/app.js"),
    read("js/views/customVideoIntegration.js"),
    read("apps/infinite-canvas-source/src/lib/platformBridge.ts"),
    read("apps/infinite-canvas-source/src/components/workspace/TopBar.tsx"),
    read("apps/infinite-canvas-source/src/components/workspace/Workspace.tsx"),
  ]);

  assert.match(creation, /data-custom-community-share=/);
  assert.match(creation, /openCommunityShare\(\{/);
  assert.match(creation, /syncCommunityShareStatus/);
  assert.match(delivery, /data-dvact="community"/);
  assert.match(delivery, /openCommunityShare\(\{/);
  assert.match(video, /custom-video:community-share-request/);
  assert.match(videoBridge, /custom-video:community-shared/);
  assert.match(canvasBridge, /community-share-request/);
  assert.match(canvasTop, /分享灵感/);
  assert.match(canvasWorkspace, /persistCanvasBlob\(dataUrl, selectedImage\.id\)/);
  assert.match(canvasWorkspace, /requestCommunityShare/);
});

test("shared actions are disabled and labelled after persistent status recovery", async () => {
  const [share, delivery, video] = await Promise.all([
    read("js/views/communityShare.js"),
    read("js/views/deliveryView.js"),
    read("apps/video-workshop/web/assets/app.js"),
  ]);

  assert.match(share, /trigger\.disabled = true/);
  assert.match(share, /trigger\.innerHTML = `\$\{icon\("check", 14\)\} 已分享`/);
  assert.match(share, /await community\.status\(/);
  assert.match(delivery, /asset\.communityPostId \? "disabled"/);
  assert.match(video, /share\.disabled = Boolean\(sharedPost\)/);
  assert.match(video, /share\.textContent = sharedPost \? "已分享" : "分享灵感"/);
});

test("community sharing only accepts persistent same-origin media", async () => {
  const source = await read("js/views/communityShare.js");

  assert.match(source, /parsed\.origin !== window\.location\.origin/);
  assert.match(source, /raw\.startsWith\("data:"\)/);
  assert.match(source, /raw\.startsWith\("blob:"\)/);
  assert.match(source, /!member \|\| member\.role === "guest"/);
  assert.match(source, /只有你主动分享的成果才会公开/);
});

test("delivery preview renders every image, scrollable copy, and video controls", async () => {
  const [delivery, styles] = await Promise.all([
    read("js/views/deliveryView.js"),
    read("styles/views.css"),
  ]);

  assert.match(delivery, /\(asset\.packAssetIds \|\| \[\]\)\.map/);
  assert.match(delivery, /delivery-preview-media/);
  assert.match(delivery, /<video src="\$\{esc\(item\.url\)\}" controls/);
  assert.match(delivery, /data-delivery-preview-image/);
  assert.match(styles, /\.delivery-preview-copy pre[\s\S]*?overflow:\s*auto/);
  assert.match(styles, /\.delivery-preview-media\.is-gallery/);
});

test("overall assets use the new hierarchy and hide account filters from ordinary personal users", async () => {
  const source = await read("js/views/assetsView.js");

  const drafts = source.indexOf('{ key: "drafts"');
  const shared = source.indexOf('{ key: "shared"');
  const favorites = source.indexOf('{ key: "favorites"');
  const backend = source.indexOf('{ key: "backend"');
  assert.ok(drafts >= 0 && drafts < shared && shared < favorites && favorites < backend);
  assert.match(source, /后台素材分类/);
  assert.match(source, />BGM<\/button>/);
  assert.match(source, />剪辑素材<\/button>/);
  assert.match(source, /<option value="audio"[\s\S]*?>语音<\/option>/);
  assert.match(source, /isPersonalLibrary\(\) && hasProfessionalAssetFilters\(\) && libraryMode === "shared"/);
  assert.doesNotMatch(source, /参考音频/);
});

test("supplier duplicate platform toolbar is not mounted", async () => {
  const source = await read("js/main.js");
  assert.match(source, /const supplierToolbarZone = false/);
  assert.match(source, /supplierTools\.hidden = !supplierToolbarZone/);
});
