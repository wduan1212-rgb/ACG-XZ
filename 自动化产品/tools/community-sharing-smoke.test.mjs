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

  assert.match(home, /HOME_INSPIRATION_PAGE_SIZE = 16/);
  assert.match(home, /limit: HOME_INSPIRATION_PAGE_SIZE/);
  assert.match(home, /beforeId: append \? inspirationBeforeId : ""/);
  assert.match(home, /data-community-more/);
  assert.match(home, /data-home-video-src/);
  assert.match(home, /preload="none"/);
  assert.match(home, /IntersectionObserver/);
  assert.match(home, /muted loop playsinline/);
  assert.match(home, /mouseenter[\s\S]*?video\.play\(\)/);
  assert.match(home, /mouseleave[\s\S]*?video\.pause\(\)/);
  assert.match(home, /item\.cover\?\.url \|\| media\.poster/);
  assert.match(home, /\$\{esc\(item\.authorName \|\| "星阵用户"\)\}\$\{item\.teamName/);
  assert.match(home, /const canRequestTeam = member\.role === "user" && !team/);
  assert.match(home, /data-home-team-join/);
  assert.match(home, /home-inspiration-card-author/);
  assert.match(home, /item\.authorName \|\| "星阵用户"/);
  assert.match(styles, /\.product-home-miaoda \.home-inspiration-grid[\s\S]*?grid-template-columns:\s*repeat\(4,[\s\S]*?grid-auto-flow:\s*row dense !important/);
  assert.match(home, /function mountInspirationGrid\(grid\)/);
  assert.match(home, /card\.style\.gridRowEnd = `span/);
  assert.doesNotMatch(home, /const INSPIRATIONS\s*=/);
  assert.match(remote, /export const community =/);
  assert.match(remote, /\/api\/community\/posts/);
  assert.match(remote, /beforeId/);
});

test("all product surfaces expose only output-targeted share actions", async () => {
  const [creation, delivery, video, videoBridge, canvasBridge, canvasTop, canvasWorkspace] = await Promise.all([
    read("js/views/customCreation.js"),
    read("js/views/deliveryView.js"),
    read("apps/video-workshop/web/assets/app.js"),
    read("js/views/customVideoIntegration.js"),
    read("apps/infinite-canvas-source/src/lib/platformBridge.ts"),
    read("apps/infinite-canvas-source/src/components/workspace/TopBar.tsx"),
    read("apps/infinite-canvas-source/src/components/workspace/Workspace.tsx"),
  ]);

  assert.doesNotMatch(creation, /data-custom-community-share=/);
  assert.match(creation, /onCommunityShareRequest: payload =>/);
  assert.match(creation, /openCommunityShare\(\{/);
  assert.match(creation, /syncCommunityShareStatus/);
  assert.match(creation, /sourceProjectId/);
  assert.match(creation, /sourceOutputId: key === "video"/);
  assert.match(creation, /sourceItemIds/);
  assert.match(delivery, /data-dvact="community"/);
  assert.match(delivery, /openCommunityShare\(\{/);
  assert.match(delivery, /function deliveryCommunitySource\(asset\)/);
  assert.match(delivery, /\.\.\.deliveryCommunitySource\(asset\)/);
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
  assert.match(share, /trigger\.dataset\.communityShared/);
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

test("community media strips safe asset revisions and keeps twenty delivery images", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: "https://platform.example" } };
  try {
    const moduleUrl = new URL("js/views/communityShare.js", root);
    moduleUrl.searchParams.set("community-test", String(Date.now()));
    const { communityMedia } = await import(moduleUrl.href);
    const media = communityMedia(Array.from({ length: 20 }, (_, index) => ({
      url: `/api/files/member-a--gallery-${index}.png?asset_rev=revision-${index}`,
      type: "image",
    })));
    assert.equal(media.length, 20);
    assert.equal(media[0].url, "/api/files/member-a--gallery-0.png");
    assert.equal(media[19].url, "/api/files/member-a--gallery-19.png");
    assert.deepEqual(
      communityMedia([{ url: "/api/files/member-a--private.png?token=secret" }]),
      [],
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("delivery preview renders every image, scrollable copy, and video controls", async () => {
  const [delivery, styles] = await Promise.all([
    read("js/views/deliveryView.js"),
    read("styles/views.css"),
  ]);

  assert.match(delivery, /\(asset\.packAssetIds \|\| \[\]\)\.map/);
  assert.match(delivery, /delivery-preview-media/);
  assert.match(delivery, /<video src="\$\{esc\(item\.url\)\}" \$\{cover\?\.url \? `poster=[\s\S]*?data-delivery-media/);
  assert.match(delivery, /data-delivery-preview-image/);
  assert.match(delivery, /bindDeliveryMediaFallback/);
  assert.match(delivery, /图片暂时无法读取/);
  assert.match(delivery, /colspan="10"/);
  assert.match(styles, /\.delivery-preview-copy pre[\s\S]*?overflow:\s*auto/);
  assert.match(styles, /\.delivery-preview-media\.is-gallery/);
  assert.match(styles, /\.sup-detail\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(200px, 280px\)/);
});

test("delivery community share keeps title, full copy, all media and the saved cover", async () => {
  const delivery = await read("js/views/deliveryView.js");

  assert.match(delivery, /function deliveryCover\(asset\)/);
  assert.match(delivery, /asset\?\.coverAssetId \|\| \(asset\?\.type === "图集"/);
  assert.match(delivery, /title: asset\.title \|\| asset\.name \|\| "星阵灵感"/);
  assert.match(delivery, /copy: asset\.copy \|\| ""/);
  assert.match(delivery, /media: deliveryMedia\(asset\)/);
  assert.match(delivery, /cover: deliveryCover\(asset\)/);
  assert.match(delivery, /sourceProjectId: String\(asset\?\.customProjectId/);
  assert.match(delivery, /sourceOutputId: String\(asset\?\.sourceOutputId/);
  assert.match(delivery, /sourceItemIds/);
  assert.match(delivery, /asset\.byMemberId \|\| asset\.ownerId \|\| productionById/);
});

test("community detail keeps media fixed, copy scrollable, and manual video playback audible", async () => {
  const [home, styles] = await Promise.all([
    read("js/views/home.js"),
    read("styles/views.css"),
  ]);
  const detailSource = home.slice(
    home.indexOf("function inspirationDetail"),
    home.indexOf("function openHomeTeamJoinDialog"),
  );

  assert.match(home, /home-inspiration-detail-stage/);
  assert.match(home, /data-home-detail-thumb/);
  assert.match(home, /poster="\$\{esc\(entry\.poster \|\| cover\)\}"/);
  assert.match(home, /function inspirationCard[\s\S]*?<video[^>]*\bmuted\b[^>]*\bplaysinline\b/);
  assert.match(home, /data-home-detail-media="\$\{index\}"[\s\S]{0,300}?controls playsinline preload="metadata"/);
  assert.doesNotMatch(home, /data-home-detail-media="\$\{index\}"[^>]*\bmuted\b/);
  assert.doesNotMatch(detailSource, /video\.addEventListener\("mouseenter"/);
  assert.doesNotMatch(detailSource, /\bautoplay\b/);
  assert.match(home, /video\.defaultMuted = false;[\s\S]*?video\.muted = false/);
  assert.match(home, /data-home-reaction="\$\{field\}"[\s\S]{0,180}?aria-pressed=/);
  assert.match(home, /aria-label="\$\{label\}" title="\$\{label\}"/);
  assert.match(home, /community-detail-head[\s\S]*?community-detail-actions[\s\S]*?detailReactionButton\(\{ field: "liked"[\s\S]*?detailReactionButton\(\{ field: "favorited"/);
  assert.match(home, /data-home-detail-download/);
  assert.match(home, /downloadBlob\(/);
  assert.match(home, /openLightbox\(image, image\.src/);
  assert.match(home, /target\.origin !== window\.location\.origin/);
  assert.match(home, /\$\{icon\(isLike \? "heart" : "bookmark", 18\)\}<\/button>/);
  assert.match(styles, /\.home-inspiration-detail-stage[\s\S]*?place-items:\s*center/);
  assert.match(styles, /\.home-inspiration-panel\s*\{[^}]*overflow:\s*hidden/);
  assert.match(styles, /\.home-inspiration-detail-media\s*\{[^}]*overflow:\s*hidden/);
  assert.match(styles, /\.home-inspiration-detail-copy\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /\.community-detail-head\s*\{[^}]*position:\s*static;[^}]*background:\s*transparent/);
  assert.doesNotMatch(styles, /\.community-detail-head\s*\{[^}]*position:\s*sticky/);
  assert.doesNotMatch(styles, /\.community-detail-head\s*\{[^}]*linear-gradient/);
  assert.match(styles, /\.community-detail-action\.is-like\[aria-pressed="true"\]/);
  assert.match(styles, /\.community-detail-action\.is-favorite\[aria-pressed="true"\]/);
  assert.match(styles, /\.home-prompt-preview\s*\{[^}]*max-height:\s*none;\s*overflow:\s*visible/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.home-inspiration-detail\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible[\s\S]*?\.home-inspiration-detail-copy\s*\{[^}]*overflow:\s*visible/);
});

test("favorite detail matches audible playback, fixed media, and icon-only reactions", async () => {
  const [assets, styles] = await Promise.all([
    read("js/views/assetsView.js"),
    read("styles/views.css"),
  ]);

  assert.match(assets, /function renderFavorites[\s\S]*?<video[^>]*\bmuted\b[^>]*\bplaysinline\b/);
  assert.match(assets, /data-favorite-detail-media="\$\{index\}"[\s\S]{0,300}?controls playsinline preload="metadata"/);
  assert.doesNotMatch(assets, /data-favorite-detail-media="\$\{index\}"[^>]*\bmuted\b/);
  assert.match(assets, /video\.defaultMuted = false;[\s\S]*?video\.muted = false/);
  assert.match(assets, /data-favorite-reaction="\$\{field\}"[\s\S]{0,180}?aria-pressed=/);
  assert.match(assets, /\$\{icon\(isLike \? "heart" : "bookmark", 18\)\}<\/button>/);
  assert.match(assets, /reactionButton\("liked", Boolean\(post\.viewerLiked\)\)/);
  assert.match(assets, /reactionButton\("favorited", Boolean\(post\.viewerFavorited\)\)/);
  assert.match(assets, /const index = Number\(button\.dataset\.favoriteImage\);[\s\S]*?entries\[index\]\?\.url/);
  assert.match(assets, /if \(!active && mediaItem\.tagName === "VIDEO"\) mediaItem\.pause\(\)/);
  assert.match(assets, /field === "favorited" && !active[\s\S]*?favoritePosts = favoritePosts\.filter[\s\S]*?close\(\);[\s\S]*?draw\(\);/);
  assert.match(styles, /\.asset-favorite-dialog-media\s*\{[^}]*overflow:\s*hidden/);
  assert.match(styles, /\.asset-favorite-dialog-copy\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.asset-favorite-dialog\s*\{[^}]*height:\s*auto;[^}]*display:\s*block;[^}]*overflow:\s*visible/);
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
