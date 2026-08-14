import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = relativePath => readFileSync(resolve(appRoot, relativePath), "utf8");

const indexHtml = read("index.html");
const baseCss = read("styles/base.css");
const componentsCss = read("styles/components.css");
const viewsCss = read("styles/views.css");
const uiMotionCss = read("styles/ui-motion.css");
const agentCss = read("styles/agent.css");
const customCreationCss = read("styles/custom-creation.css");
const mainJs = read("js/main.js");
const remoteJs = read("js/core/remote.js");
const loginBeamsJs = read("js/ui/loginBeams.js");
const componentsJs = read("js/ui/components.js");
const agentViewJs = read("js/agent/view.js");
const agentCardsJs = read("js/agent/cards.js");
const agentOrchestratorJs = read("js/agent/orchestrator.js");
const chainBoardsJs = read("js/views/chainBoards.js");
const iconsJs = read("js/ui/icons.js");
const voiceLabJs = read("js/views/voiceLab.js");
const prodDrawerJs = read("js/views/prodDrawer.js");
const studioJs = read("js/views/studio.js");
const canvasIntegrationJs = read("js/views/customCanvasIntegration.js");
const canvasSourceTsx = read("apps/infinite-canvas-source/src/components/workspace/Canvas.tsx");
const canvasBridgeTs = read("apps/infinite-canvas-source/src/lib/platformBridge.ts");
const canvasRootTsx = read("apps/infinite-canvas-source/src/components/GithubPagesApp.tsx");
const canvasWorkspaceTsx = read("apps/infinite-canvas-source/src/components/workspace/Workspace.tsx");
const canvasTopBarTsx = read("apps/infinite-canvas-source/src/components/workspace/TopBar.tsx");
const canvasProjectClientTsx = read("apps/infinite-canvas-source/src/components/workspace/ProjectClient.tsx");
const videoWorkshopHtml = read("apps/video-workshop/web/index.html");
const videoWorkshopJs = read("apps/video-workshop/web/assets/app.js");
const videoWorkshopCss = read("apps/video-workshop/web/assets/styles.css");
const customVideoIntegrationJs = read("js/views/customVideoIntegration.js");
const customCreationJs = read("js/views/customCreation.js");
const customPublishJs = read("js/views/customPublish.js");
const chainWorkshopJs = read("js/views/chainWorkshop.js");
const settingsJs = read("js/views/settings.js");
const supplierViewsJs = read("js/views/supplierViews.js");
const deliveryViewJs = read("js/views/deliveryView.js");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section start: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing section end: ${endMarker}`);
  return source.slice(start, end);
}

test("login gate uses the original grainient split visual and keeps alternate auth actions honest", () => {
  assert.match(indexHtml, /class="lg-auth-shell"/);
  assert.match(indexHtml, /class="lg-visual"/);
  assert.match(indexHtml, /id="lgGoogle"[^>]*>[\s\S]*google-g-mark\.png[\s\S]*使用 Google 快速登录[\s\S]*<\/button>/);
  assert.match(indexHtml, /id="lgPhone"[^>]*>[\s\S]*phone-mark\.svg[\s\S]*使用手机验证[\s\S]*<\/button>/);
  assert.ok(indexHtml.indexOf('id="lgPhone"') < indexHtml.indexOf('id="lgGoogle"'));
  assert.match(indexHtml, /id="lgForgot"[^>]*>忘记密码/);
  assert.match(indexHtml, /id="lgApply"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(indexHtml, /class="lg-login-logo"/);
  assert.match(uiMotionCss, /Auth 2 full-screen split gate/);
  assert.match(uiMotionCss, /grid-template-columns:\s*minmax\(0,\s*1\.12fr\)\s+minmax\(460px,\s*\.88fr\)/);
  assert.match(uiMotionCss, /\.lg-auth-shell\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*border-radius:\s*0;/s);
  assert.match(uiMotionCss, /\.lg-provider-actions\s*\{[^}]*grid-template-columns:\s*1fr;/s);
  assert.match(loginBeamsJs, /原创的依赖无关 WebGL 颗粒渐变/);
  assert.match(loginBeamsJs, /float fbm\(vec2 p\)/);
  assert.match(loginBeamsJs, /uniform float uNoiseIntensity/);

  const wireGate = section(mainJs, "function wireGate()", "function logout()");
  assert.match(wireGate, /remote\.passwordReset\.request\(name\)/);
  assert.match(wireGate, /暂不支持，等待功能上线/);
  assert.match(mainJs, /async function syncAdminPasswordResetNotifications\(\)/);
  assert.match(mainJs, /收到密码重置申请/);
  assert.match(remoteJs, /\/api\/password-reset-requests/);
});

test("left context list scrolls while its scrollbar remains hidden", () => {
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\s+\.wsctx-groups\s*\{[^}]*overflow-y\s*:\s*auto\s*;[^}]*overflow-x\s*:\s*hidden\s*;/s,
  );
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\s+\.wsctx-groups\s*\{[^}]*scrollbar-width\s*:\s*none\s*;[^}]*-ms-overflow-style\s*:\s*none\s*;/s,
  );
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\s+\.wsctx-groups::-(?:webkit|Webkit)-scrollbar\s*\{[^}]*display\s*:\s*none\s*;[^}]*width\s*:\s*0\s*;/s,
  );
});

test("workspace v2 removes the legacy black primary navigation rail", () => {
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\s+\.nav-rail\s*\{[^}]*display\s*:\s*none\s*!important\s*;/s,
  );
});

test("workspace sidebar collapses to a white reversible icon rail with home and account data separated", () => {
  assert.match(mainJs, /WORKSPACE_CONTEXT_COLLAPSED_KEY/);
  assert.match(mainJs, /function setWorkspaceContextCollapsed\(collapsed\)/);
  assert.match(mainJs, /id="workspaceContextCollapse"/);
  assert.match(indexHtml, /id="workspaceContextExpand"/);
  assert.match(indexHtml, /data-nav="home"[^>]*title="首页"/);
  assert.match(indexHtml, /data-nav="overview"[^>]*title="账号数据"/);
  assert.match(indexHtml, /data-nav="custom"[^>]*data-page="video"[^>]*data-nav-key="custom-video"[^>]*title="视频工坊"/);
  assert.match(indexHtml, /data-nav="custom"[^>]*data-page="canvas"[^>]*data-nav-key="custom-canvas"[^>]*title="无限画布"/);
  assert.match(indexHtml, /data-nav="studio"[^>]*data-nav-key="studio"[^>]*title="单号创作"/);
  const collapsedRail = indexHtml.slice(indexHtml.indexOf('id="collapsedRailItems"'), indexHtml.indexOf('<div class="rail-bottom">'));
  const collapsedKeys = ["home", "custom-video", "custom-canvas", "studio", "agent", "assets", "delivery", "overview"];
  let collapsedCursor = -1;
  for (const key of collapsedKeys) {
    const next = collapsedRail.indexOf(`data-nav-key="${key}"`, collapsedCursor + 1);
    assert.ok(next > collapsedCursor, `${key} should preserve the workspace switcher order`);
    collapsedCursor = next;
  }
  assert.match(mainJs, /function syncCollapsedRailNavigation\(\)/);
  assert.match(mainJs, /const items = workspaceNavItems\(\)/);
  assert.match(mainJs, /button\.style\.order = String\(index\)/);
  assert.match(mainJs, /openWorkspaceItem\(item\)/);
  assert.match(indexHtml, /id="railProfile"[^>]*data-nav="settings"/);
  assert.match(mainJs, /starmatrix-original-star\.png/);
  assert.match(mainJs, /workspaceContextExpand[\s\S]*?setWorkspaceContextCollapsed\(false\)/);
  assert.match(baseCss, /workspace-context-collapsed\s+\.nav-rail\s*\{[^}]*display:\s*flex\s*!important/s);
  assert.match(baseCss, /workspace-context-collapsed\s+\.nav-rail\s*\{[^}]*background:\s*#fff\s*!important/s);
  assert.match(baseCss, /workspace-context-collapsed[\s\S]*?grid-template-columns:\s*56px\s+minmax\(0,\s*1fr\)/);
  assert.match(baseCss, /workspace-context-collapsed\s+\.rail-bottom\s*>\s*\.client-rail-entry[\s\S]*?display:\s*none\s*!important/);
  assert.match(baseCss, /workspace-context-collapsed\s+\.rail-profile\s*\{[^}]*display:\s*grid/s);
  assert.match(videoWorkshopHtml, /id="voiceWorkbenchToggle"/);
  assert.match(videoWorkshopJs, /VIDEO_VOICE_RAIL_KEY/);
  assert.match(videoWorkshopCss, /voice-rail-collapsed[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+48px/);
});

test("batch AI topics preserve partial results, fill successes, and retry only missing accounts", () => {
  assert.match(agentCardsJs, /data-act="plan-ai-topic"/);
  assert.match(agentViewJs, /qianfanTopicIdeas\(/);
  assert.match(agentViewJs, /填入空白行/);
  assert.match(agentViewJs, /逐账号保存生成结果/);
  assert.match(agentViewJs, /先填入已生成的/);
  assert.match(agentViewJs, /aiTopicAccountIdsToGenerate/);
  assert.match(agentViewJs, /m\.payload\.aiTopicDraft = preview/);
  assert.match(agentViewJs, /accounts\.filter\(account => requestedSet\.has/);
  assert.doesNotMatch(agentViewJs, /按账号风格生成候选内容/);
  assert.doesNotMatch(agentViewJs, /系统不会只填部分账号/);
  assert.match(agentViewJs, /data-batchpause/);
  assert.match(agentViewJs, /再次确认永久删除/);
  assert.match(agentOrchestratorJs, /export function setBatchPaused/);
  assert.match(agentOrchestratorJs, /if \(!batch \|\| batch\.paused\) return 0/);
  assert.match(remoteJs, /\/api\/qianfan\/topic-ideas/);
  assert.doesNotMatch(settingsJs, /全部创作端账号/);
  assert.match(settingsJs, /data-usage-days="7"/);
  assert.match(settingsJs, /data-usage-days="30"/);
});

test("v120 is the only workspace shell and uses the release-list label", () => {
  const items = section(mainJs, "function workspaceNavItems()", "function workspaceCurrentItem()");
  assert.match(mainJs, /function workspaceShellEnabled\(\)\s*\{\s*return true;\s*\}/s);
  assert.match(items, /label:\s*"发布清单"/);
  assert.doesNotMatch(items, /发布与数据/);
  assert.doesNotMatch(mainJs, /使用旧版界面/);
  assert.doesNotMatch(mainJs, /data-account-action="legacy"/);
  assert.doesNotMatch(mainJs, /workspace=legacy/);
});

test("workspace brand keeps the blue lockup and current feature on one line", () => {
  assert.match(
    baseCss,
    /\.workspace-switch-copy\s*\{[^}]*display\s*:\s*flex\s*;[^}]*align-items\s*:\s*center\s*;/s,
  );
  assert.match(
    baseCss,
    /\.workspace-switch-copy\s+em\s*\{[^}]*color\s*:\s*#92928d\s*;/s,
  );
});

test("supplier and creator settings share the centered symmetric gear icon", () => {
  assert.match(iconsJs, /gear:\s*'M9\.594 3\.94[^']*\|M15 12a3 3 0 11-6 0 3 3 0 016 0z'/s);
  assert.match(mainJs, /data-account-action="settings"[^`]*icon\("gear",\s*16\)/s);
  assert.match(mainJs, /label:\s*"设置"[^}]*icon:\s*"gear"/s);
});

test("single-account workspace lists all publishing accounts without subtype groups or a 40-account cap", () => {
  const studioRows = section(mainJs, 'if (zone === "studio") {', 'if (zone === "agent") {');
  assert.doesNotMatch(studioRows, /\.slice\(\s*0\s*,\s*40\s*\)/);
  assert.match(studioRows, /title:\s*"图文组"/);
  assert.match(studioRows, /title:\s*"视频号"/);
  assert.doesNotMatch(studioRows, /title:\s*"真人数字人"/);
  assert.doesNotMatch(studioRows, /title:\s*"素材无数字人"/);
  assert.match(studioRows, /title:\s*"已停用账号"/);
  assert.match(studioRows, /\.filter\(isAccountDisabled\)/);
});

test("batch-session context rows open the selected real session", () => {
  const routeHandler = section(
    mainJs,
    'const routeButton = event.target.closest("[data-ws-go]");',
    'panel.addEventListener("keydown"',
  );
  assert.match(routeHandler, /targetZone\s*===\s*"agent"/);
  assert.match(routeHandler, /openAgentSession\s*\(\s*targetId\s*\)/);
});

test("batch refinement uses the canonical router and keeps a visible return path", () => {
  assert.match(mainJs, /from\s+"\.\/core\/router\.js"/);
  assert.doesNotMatch(mainJs, /core\/router\.js\?v=/);
  assert.match(prodDrawerJs, /from\s+"\.\.\/core\/router\.js"/);
  const workbenchRoute = section(
    prodDrawerJs,
    "rootEl.querySelectorAll('[data-pd=\"workbench\"]')",
    "// 脚本编辑",
  );
  assert.match(workbenchRoute, /allowStudioFromAgent\(\)/);
  assert.match(workbenchRoute, /state\.ui\.returnTo\s*=\s*\{/);
  assert.match(workbenchRoute, /go\("studio",\s*targetPage\)/);
  assert.ok(
    workbenchRoute.indexOf("allowStudioFromAgent()") < workbenchRoute.indexOf('go("studio", targetPage)'),
    "explicit batch-to-studio permission must be established before navigation",
  );
  assert.match(studioJs, /agent:\s*"返回批量生产"/);
  assert.match(studioJs, /rt\?\.zone\s*===\s*"agent"[\s\S]*?<span class="cs-label">批量生产<\/span>/);
  assert.match(studioJs, /\$\$\("\[data-cs-back\]",\s*root\)\.forEach/);
  assert.match(studioJs, /if\s*\(rt\s*&&\s*rt\.zone\)\s*go\(rt\.zone,\s*rt\.page,\s*rt\.resourceId\)/);
  assert.match(mainJs, /title:\s*"上一步"[\s\S]*?title:\s*"返回批量生产"[\s\S]*?data-ws-return-batch="true"/);
  assert.match(mainJs, /routeButton\.dataset\.wsReturnBatch\s*===\s*"true"/);
  assert.match(
    viewsCss,
    /body\.workspace-shell-v2\[data-zone="studio"\]\s+\.view-root\s*>\s*\.chain-stepper\s*\{[^}]*position\s*:\s*sticky\s*;[^}]*display\s*:\s*flex\s*!important\s*;/s,
  );
});

test("batch panels keep scrolling while hiding rails and omit the covered session label", () => {
  assert.doesNotMatch(agentViewJs, /本会话/);
  assert.match(
    agentCss,
    /\.agw-msgs,[\s\S]*?\.agw-sessions,[\s\S]*?\.agc-accs\s*\{[^}]*scrollbar-width\s*:\s*none\s*;/s,
  );
  assert.match(
    viewsCss,
    /\.pd-body\s*\{[^}]*overflow-y\s*:\s*auto\s*;[^}]*scrollbar-width\s*:\s*none\s*;/s,
  );
  assert.match(viewsCss, /\.pd-body::-(?:webkit|Webkit)-scrollbar\s*\{[^}]*display\s*:\s*none\s*;/s);
});

test("failed batch image jobs keep a real retry action while manual-input jobs stay distinct", () => {
  assert.match(
    agentCardsJs,
    /failed\.length\s*\?\s*`<div class="agc-p fail">[\s\S]*data-act="batch-retry"[\s\S]*重试失败项/,
  );
  assert.match(
    agentCardsJs,
    /<button class="btn primary sm" data-act="batch-retry"[\s\S]*重试失败项<\/button>/,
  );
  assert.match(
    agentViewJs,
    /case "batch-retry":\s*if \(batch\)\s*\{\s*const n = retryFailedIn\(batch\)/,
  );
  const retryFailed = section(
    agentOrchestratorJs,
    "export function retryFailedIn(batch)",
    "export function",
  );
  assert.match(retryFailed, /p\.stageStatus !== "failed"/);
  assert.match(retryFailed, /p\.mode === "图文"/);
  assert.match(retryFailed, /runBatchImagesToReview\(p,\s*batch\)/);
  assert.doesNotMatch(retryFailed, /stageStatus === "needs_input"/);
});

test("unified reference drop zone has visible hover and drop motion", () => {
  assert.match(chainBoardsJs, /class="refbar-drop-cue"/);
  assert.match(chainBoardsJs, /拖入统一参考图/);
  assert.match(viewsCss, /\.refbar\.img-ref-generation:hover\s*\{[^}]*transform\s*:\s*translateY\(-1px\)/s);
  assert.match(viewsCss, /\.refbar\.drag-over\s*\{[^}]*scale\(1\.006\)/s);
  assert.match(viewsCss, /@keyframes\s+refbarDropBounce/);
});

test("topbar business actions render inside the nested action dock while the legacy stepper stays outside it", () => {
  const renderTopbar = section(mainJs, "function renderTopbar()", "function paletteCommands()");
  assert.match(renderTopbar, /const actionDock\s*=\s*\$\("\.top-actions"\)/);
  assert.match(renderTopbar, /const actions\s*=\s*\$\("#topActionsPanel"\)\s*\|\|\s*actionDock/);
  assert.match(renderTopbar, /actions\.appendChild\(newAccBtn\)/);

  const legacyGuard = renderTopbar.indexOf("if (!workspaceShellEnabled())");
  const insertion = renderTopbar.indexOf("topbar.insertBefore(studioStepper, actionDock)");
  assert.ok(legacyGuard >= 0, "chain-stepper relocation must be guarded by legacy-shell mode");
  assert.ok(insertion > legacyGuard, "chain-stepper relocation escaped the legacy-shell guard");
  assert.match(
    renderTopbar.slice(insertion),
    /else\s*\{\s*topbar\?\.classList\.remove\("studio-topbar-active"\)/s,
  );
});

test("workspace switcher folds voice generation into video workshop without gray item hints", () => {
  const items = section(mainJs, "function workspaceNavItems()", "function workspaceCurrentItem()");
  assert.doesNotMatch(items, /key:\s*"custom-voice"/);
  assert.match(items, /key:\s*"custom-video"[\s\S]*label:\s*"视频工坊"/);

  const switcher = section(mainJs, "function renderWorkspaceSwitcher()", "function normalizeWorkspaceProject");
  assert.match(switcher, /<span><b>\$\{esc\(item\.label\)\}<\/b><\/span>/);
  assert.doesNotMatch(switcher, /workspaceItemHint\(item\)/);
  assert.doesNotMatch(switcher, /workspace-menu-kicker/);
  assert.match(baseCss, /\.workspace-menu button > span\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(baseCss, /\.workspace-menu b\s*\{[^}]*white-space:\s*nowrap/s);

  const commands = section(mainJs, "function paletteCommands()", "async function boot()");
  assert.match(commands, /\{\s*label:\s*"视频工坊 · 语音生成"[^}]*go\("custom",\s*"video"\)/s);
  assert.match(videoWorkshopHtml, /data-voice-rail-tab="narration"/);
  assert.match(videoWorkshopHtml, /data-voice-rail-tab="generate"/);
});

test("voice generation moves the real voice library into the unified left context column", () => {
  const contextShell = section(
    mainJs,
    "function ensureWorkspaceContextShell(panel)",
    "function scheduleWorkspaceContextRender()",
  );
  assert.match(contextShell, /id="workspaceContextToolHost"\s+hidden/);
  const contextRender = section(mainJs, "function renderWorkspaceContextPanel()", "function renderContextPanel()");
  assert.match(contextRender, /activeContextTool\s*=\s*zone\s*===\s*"custom"\s*&&\s*page\s*===\s*"voice"/s);
  assert.match(contextRender, /contextList\.hidden\s*=\s*activeContextTool\s*===\s*"voice"/);
  assert.match(contextRender, /contextToolHost\.hidden\s*=\s*activeContextTool\s*!==\s*"voice"/);
  assert.match(voiceLabJs, /document\.getElementById\("workspaceContextToolHost"\)/);
  assert.match(voiceLabJs, /workspaceLibraryHost\.replaceChildren\(renderedLibrary\)/);
  assert.match(voiceLabJs, /workspaceLibraryHost\.dataset\.voiceMemberId\s*=\s*activeMemberId/);
  assert.match(voiceLabJs, /const stableLibrary\s*=\s*nextMode\s*\?\s*libraryNode\(\)\s*:\s*null/);
  assert.match(voiceLabJs, /nextLibrary\.replaceWith\(stableLibrary\)/);
  assert.match(voiceLabJs, /await stableRerender\("tts"/);
  assert.match(voiceLabJs, /ensureProviderStatus\(refreshVoiceList\)/);
  assert.equal(
    [...voiceLabJs.matchAll(/voiceQueryAll\("\[data-vl-tab\]"\)\.forEach/g)].length,
    2,
  );
  assert.doesNotMatch(customCreationCss, /\.vl-library\s*\{[^}]*position\s*:\s*fixed/s);
  assert.match(
    customCreationCss,
    /body\.workspace-shell-v2\s+\.custom-tool-host\.is-voice\s+\.vl-workbench\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1\.25fr\)\s+minmax\(280px,\s*\.68fr\)\s*;[^}]*background\s*:\s*#fff\s*;/s,
  );
  assert.match(
    customCreationCss,
    /body\.workspace-shell-v2\s+\.workspace-context-tool-host\.is-voice-library\s*>\s*\.vl-library\s*\{[^}]*height\s*:\s*100%\s*;[^}]*background\s*:\s*#fff\s*;[^}]*display\s*:\s*flex\s*;[^}]*overflow\s*:\s*hidden\s*;/s,
  );
  assert.match(
    customCreationCss,
    /body\.workspace-shell-v2\s+\.custom-tool-host\.is-voice\.is-active\s*\{[^}]*animation\s*:\s*none\s*;[^}]*transform\s*:\s*none\s*;/s,
  );
  assert.match(
    customCreationCss,
    /body\.workspace-shell-v2\s+\.workspace-context-tool-host\s+\.vl-voice-list\s*\{[^}]*flex\s*:\s*1\s*;[^}]*overflow-y\s*:\s*auto\s*;[^}]*scrollbar-width\s*:\s*none\s*;/s,
  );
  assert.match(
    customCreationCss,
    /body\.workspace-shell-v2\s+\.workspace-context-tool-host\s+\.vl-voice-filters\s*\{[^}]*grid-template-columns\s*:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/s,
  );
  assert.match(
    customCreationCss,
    /body\.workspace-shell-v2\s+\.workspace-context-tool-host\s+\.vl-voice-card\s*\{[^}]*min-height\s*:\s*40px\s*;[^}]*padding\s*:\s*4px\s+5px\s+4px\s+7px\s*;/s,
  );
  assert.match(
    customCreationCss,
    /body\.workspace-shell-v2\s+\.workspace-context-tool-host\s+\.vl-voice-menu-toggle\.icon-btn\.tiny\s*\{[^}]*background\s*:\s*transparent\s*;[^}]*transform\s*:\s*none\s*;/s,
  );
  assert.match(voiceLabJs, /data-vl-menu-toggle=/);
  assert.match(voiceLabJs, /class="vl-voice-menu-popover"/);
  assert.doesNotMatch(voiceLabJs, /class="vl-voice-actions"/);
  assert.doesNotMatch(customCreationCss, /\.workspace-context-tool-host[^}]*padding-right\s*:\s*(?:80|128)px/s);
  assert.match(voiceLabJs, /class="vl-sliders vl-voice-parameters"/);
  assert.match(
    customCreationCss,
    /\.custom-tool-host\.is-voice\s+\.vl-console\s+\.vl-output-slot\s*\{[^}]*min-height\s*:\s*clamp\(270px,\s*42vh,\s*410px\)\s*;[^}]*flex\s*:\s*1\s+1\s+auto\s*;/s,
  );
  assert.match(
    customCreationCss,
    /\.custom-tool-host\.is-voice\s+\.vl-console\s+\.vl-voice-parameters\s*\{[^}]*margin-top\s*:\s*auto\s*;[^}]*padding-top\s*:\s*14px\s*;/s,
  );
  assert.match(customCreationCss, /@keyframes\s+vlOutputAmbient/);
  assert.match(customCreationCss, /@keyframes\s+vlOutputWaiting/);
  assert.match(
    customCreationCss,
    /body\.workspace-shell-v2\s+\.custom-tool-host\.is-voice\s+\.vl-side-panel\s*>\s*\.vl-section-head:first-child\s*\{[^}]*padding-right\s*:\s*58px\s*;/s,
  );
  assert.match(
    customCreationCss,
    /body\.workspace-shell-v2\s+\.custom-tool-host\.is-voice\s+\.vl-editor\s*\{[^}]*background\s*:\s*#fff\s*;/s,
  );
  assert.match(
    customCreationCss,
    /body\.workspace-shell-v2\s+\.custom-tool-host\.is-voice\s+\.vl-side-panel\s*\{[^}]*background\s*:\s*#fff\s*;/s,
  );
});

test("canvas embed avoids the legacy home and keeps one platform rail with bottom-left view controls", () => {
  assert.doesNotMatch(canvasRootTsx, /HomeView/);
  assert.match(canvasRootTsx, /data-canvas-project-opening/);
  assert.match(canvasRootTsx, /正在打开画布/);
  assert.match(canvasWorkspaceTsx, /import\s*\{\s*homeHref,\s*IS_PLATFORM_EMBED\s*\}\s*from\s*"@\/lib\/runtime"/);
  assert.match(canvasWorkspaceTsx, /<TopBar/);
  assert.match(canvasWorkspaceTsx, /embedded=\{IS_PLATFORM_EMBED\}/);
  assert.match(canvasWorkspaceTsx, /showPublish=\{allowPublish\}/);
  assert.match(canvasTopBarTsx, /if\s*\(embedded\)/);
  assert.match(canvasTopBarTsx, /absolute right-4 top-4/);
  assert.match(
    canvasProjectClientTsx,
    /\{!IS_PLATFORM_EMBED\s*&&\s*<div className="h-14 shrink-0 border-b border-line bg-page"\s*\/>\}/,
  );
  assert.match(canvasIntegrationJs, /currentProjectId\s*=\s*await loadRecentProjectId\(token,\s*controller\.signal\)/);
  assert.match(canvasIntegrationJs, /createProjectWhenReady\s*=\s*!currentProjectId/);
  assert.match(canvasIntegrationJs, /canPublish\s*=\s*false/);
  assert.match(canvasIntegrationJs, /if\s*\(!iframe\)\s*return\s+mountCanvasFrame\(\)/);
  assert.match(canvasIntegrationJs, /\{\s*type:\s*"custom-canvas:create-project"\s*\}/);
  assert.match(canvasIntegrationJs, /a\[href\$="#\/"\]/);
  assert.doesNotMatch(canvasIntegrationJs, /contextPortalId/);
  assert.doesNotMatch(canvasIntegrationJs, /contextPortalNonce/);
  assert.doesNotMatch(canvasIntegrationJs, /class="canvas-context-portal"/);
  assert.doesNotMatch(canvasIntegrationJs, /data-canvas-control=/);
  assert.doesNotMatch(canvasIntegrationJs, /dataset\.platformCanvasControls/);
  assert.match(canvasIntegrationJs, /background:#fff/);
  assert.doesNotMatch(canvasSourceTsx, /createPortal/);
  assert.match(canvasSourceTsx, /data-canvas-viewport-controls="canvas"/);
  assert.match(canvasSourceTsx, /"absolute bottom-4 left-4"/);
  assert.match(canvasSourceTsx, /className="canvas-viewport-minimap/);
  assert.doesNotMatch(canvasBridgeTs, /contextPortalId/);
  assert.doesNotMatch(canvasBridgeTs, /contextPortalNonce/);
  assert.match(canvasBridgeTs, /bootstrap\.canPublish\s*===\s*true/);
  assert.match(canvasBridgeTs, /return\s*\{\s*canPublish:\s*false\s*\}/);
  assert.doesNotMatch(customCreationCss, /has-canvas-context-tools/);
  assert.doesNotMatch(customCreationCss, /canvas-context-portal/);
  const ownerSwitch = section(mainJs, "function renderWorkspaceContextPanel()", "if (zone === \"studio\"");
  assert.match(ownerSwitch, /canvasContextTools\.hidden\s*=\s*activeContextTool\s*!==\s*"canvas"/);
});

test("video workshop is white, has no duplicate history rail, and exposes published counts", () => {
  assert.match(videoWorkshopHtml, /document\.documentElement\.dataset\.platformWorkspace\s*=\s*"true"/);
  assert.match(videoWorkshopHtml, /20260815-v1435-ai-topic-partial-1/);
  assert.doesNotMatch(videoWorkshopHtml, /20260727-v120-shell-3/);
  assert.match(
    videoWorkshopHtml,
    /html\[data-platform-workspace="true"\]\s+\.start-history,[\s\S]*?html\[data-platform-workspace="true"\]\s+\.history-sidebar\s*\{[^}]*display\s*:\s*none\s*!important\s*;/s,
  );
  assert.match(videoWorkshopHtml, /--bg:\s*#ffffff/);
  assert.match(videoWorkshopHtml, /--surface:\s*#ffffff/);
  assert.match(customVideoIntegrationJs, /"background:#fff"/);
  assert.ok(
    customVideoIntegrationJs.indexOf('window.addEventListener("message", receive)')
      < customVideoIntegrationJs.indexOf("frame.src = entryUrl"),
    "video iframe must start after the workspace message bridge is installed",
  );
  assert.match(customCreationJs, /const routedProjectId\s*=\s*initialProjectId\s*&&\s*initialProjectId\s*!==\s*"__new__"/);
  assert.match(customCreationJs, /projectId:\s*routedProjectId/);
  const normalizer = section(mainJs, "function normalizeWorkspaceProject", "function setWorkspaceProjects");
  assert.match(normalizer, /source\.id/);
  const videoRows = section(mainJs, 'if (page === "video") {', 'if (page === "canvas") {');
  assert.match(videoRows, /title:[^,\n]*"历史会话"/);
  assert.match(videoRows, /collapsible:\s*false/);
  assert.match(videoRows, /class="wsctx-title-add"[\s\S]*?data-ws-id="__new__"/);
  assert.doesNotMatch(videoRows, /title:\s*"新建视频会话"/);
  assert.match(videoRows, /videoProjectContextRow\(project,\s*resourceId\)/);
  assert.match(mainJs, /tag:\s*`已发布\s+\$\{project\.publishedCount\s*\|\|\s*0\}`/);
  assert.match(mainJs, /data-session-menu-toggle/);
  assert.match(mainJs, /data-session-action="rename"/);
  assert.match(mainJs, /data-session-action="favorite"/);
  assert.match(mainJs, /data-session-action="move"/);
  assert.match(mainJs, /data-session-action="delete"/);
  assert.match(mainJs, /data-session-create-group="video"/);
  assert.match(mainJs, /data-session-create-group="batch"/);
  assert.match(mainJs, /data-session-group-action="rename"/);
  assert.match(mainJs, /data-session-group-action="delete"/);
  assert.match(mainJs, /function renameWorkspaceSessionGroup/);
  assert.match(mainJs, /function deleteWorkspaceSessionGroup/);
  assert.match(mainJs, /groups\.forEach\(group\s*=>\s*append\([^;]*keepEmpty:\s*true/s);
  assert.match(mainJs, /postVideoWorkspaceAction\("workspace:rename"/);
  assert.match(mainJs, /hideWorkspaceVideoProject\(id\)/);
  assert.match(baseCss, /\.wsctx-row-more\s*\{[^}]*opacity:\s*0\s*;[^}]*pointer-events:\s*none\s*;/s);
  assert.match(baseCss, /\.wsctx-row-shell:hover\s+\.wsctx-row-more,[\s\S]*?opacity:\s*1\s*;[^}]*pointer-events:\s*auto\s*;/s);
  assert.match(baseCss, /\.wsctx-batch-session-shell\s+\.wsctx-row-more\s*\{[^}]*opacity:\s*1\s*;[^}]*pointer-events:\s*auto\s*;/s);
  const batchSessionRow = section(mainJs, "function batchSessionContextRow", "function workspaceCanvasProjectMenu");
  assert.match(batchSessionRow, /wsctx-batch-session-shell\$\{active\s*\?\s*" is-active"/);
  assert.doesNotMatch(batchSessionRow, /tag:\s*active\s*\?\s*"当前"/);
  assert.match(agentCss, /\.wsctx-batch-session-shell\s+\.wsctx-row-more\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*opacity:\s*1;/s);
  assert.match(agentCss, /\.wsctx-batch-session-shell\.is-active\s*\{[^}]*background:\s*#eef0f3;[^}]*box-shadow:\s*0\s+8px\s+20px/s);
  assert.match(agentCss, /\.wsctx-batch-session-shell\.is-active::after\s*\{[^}]*animation:\s*batch-session-lightflow\s+3\.4s\s+ease-in-out\s+infinite;/s);
  assert.match(agentCss, /\.wsctx-batch-session-shell\s+\.wsctx-row-menu\s*\{[^}]*position:\s*absolute;[^}]*width:\s*176px;/s);
  assert.doesNotMatch(agentCss, /\.wsctx-batch-session-shell\.is-active\s*>\s*\*\s*\{/);
  assert.match(baseCss, /\.wsctx-row-menu\s*\{[^}]*display:\s*none\s*;/s);
  assert.match(baseCss, /\.wsctx-row-shell\.is-menu-open\s+\.wsctx-row-menu\s*\{[^}]*display:\s*grid\s*;/s);
  assert.match(
    baseCss,
    /\.wsctx-canvas-project-shell\.is-active,[\s\S]*?\.wsctx-video-project-shell\.is-active,[\s\S]*?\.wsctx-batch-session-shell\.is-active\s*\{[^}]*background:\s*#e8e8e5\s*;/s,
  );
  assert.match(
    baseCss,
    /\.wsctx-canvas-project-shell\.is-active::before\s*\{[^}]*content:\s*none\s*;[^}]*display:\s*none\s*;/s,
  );
  assert.doesNotMatch(baseCss, /\.wsctx-video-project-shell\.is-active::before/);
  assert.match(
    baseCss,
    /\.wsctx-video-project-shell\.is-working::after\s*\{[^}]*animation:\s*workspace-video-heatwave\s+2\.7s\s+ease-in-out\s+infinite\s*;/s,
  );
  assert.doesNotMatch(baseCss, /\.wsctx-video-project-shell\.is-working\s*>\s*\*\s*\{/);
  assert.match(
    baseCss,
    /\.wsctx-video-project-shell\.is-working\s*>\s*\.wsctx-row,[\s\S]*?\.wsctx-video-project-shell\.is-working\s*>\s*\.wsctx-row-more\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;/s,
  );
  assert.match(baseCss, /\.wsctx-row-menu\s*\{[^}]*position:\s*absolute;/s);
  const projectSetter = section(mainJs, "function setWorkspaceProjects", "async function loadWorkspaceProjects");
  assert.match(projectSetter, /const retainedItems\s*=\s*target\.items/);
  assert.match(projectSetter, /target\.items\s*=\s*\[\.\.\.newItems,\s*\.\.\.retainedItems\]/);
  assert.doesNotMatch(projectSetter, /updatedAt.*sort|sort\(.*updatedAt/s);
  const groupedRows = section(mainJs, "function groupedWorkspaceRows", "function accountContextRow");
  assert.doesNotMatch(groupedRows, /updatedAt/);
  assert.match(videoWorkshopJs, /const retained\s*=\s*state\.historyItems/);
  assert.match(videoWorkshopJs, /state\.historyItems\s*=\s*\[\.\.\.added,\s*\.\.\.retained\]/);
  assert.match(videoWorkshopJs, /existingIndex\s*>=\s*0[\s\S]*?state\.historyItems\.map/s);
  assert.match(baseCss, /\.wsctx-row-shell:hover,[\s\S]*?background:\s*#efefec\s*;/s);
  assert.match(videoWorkshopHtml, /\.submit-button\s*\{[^}]*background:\s*#242422;[^}]*color:\s*#ffffff;/s);
  assert.match(videoWorkshopHtml, /\.submit-button\s+svg\s*\{[^}]*stroke:\s*#ffffff\s*!important\s*;/s);
  assert.match(videoWorkshopHtml, /class="chat-composer-actions"/);
  assert.match(videoWorkshopHtml, /class="attachment-strip"\s+data-attachment-strip/);
  assert.match(videoWorkshopJs, /className\s*=\s*"message-copy"/);
  assert.match(videoWorkshopJs, /message\.type\s*===\s*"workspace:rename"/);
  assert.match(videoWorkshopHtml, /id="projectAssetsButton"/);
  assert.match(videoWorkshopHtml, /项目资产/);
  assert.match(videoWorkshopJs, /projectAssetsButton\?\.addEventListener\("click",\s*openHistoryDeliveryModal\)/);
  assert.match(videoWorkshopJs, /function createChatDeliveryCard\(/);
  assert.match(mainJs, /"xingzhen:video-published"/);
  const canvasRows = section(mainJs, 'if (page === "canvas") {', 'if (zone === "assets") {');
  assert.match(canvasRows, /title:[^,\n]*"画布项目"/);
  assert.match(canvasRows, /collapsible:\s*false/);
  assert.match(canvasRows, /canvasProjectContextRow\(project,\s*resourceId\)/);
  assert.match(mainJs, /data-session-kind="canvas"/);
  assert.match(mainJs, /function renameWorkspaceCanvasProject/);
  assert.match(mainJs, /customCanvasProjects\.remove\(id\)/);
  assert.match(remoteJs, /customCanvasProjects[\s\S]*?get:\s*\(id\)[\s\S]*?update:\s*\(id,\s*payload\)[\s\S]*?remove:\s*\(id\)/);
  assert.match(canvasRootTsx, /message\.type\s*===\s*"custom-canvas:workspace-index-changed"/);
  assert.match(canvasRootTsx, /void syncCanvasProjectIndex\(\)/);
});

test("video workshop uses a full-workspace drop glow and unified white delivery controls", () => {
  assert.ok(
    videoWorkshopHtml.indexOf('id="outputTabs"') < videoWorkshopHtml.indexOf('id="deliveryToggleButton"'),
    "the aspect-ratio control should be the first item in the delivery toolbar",
  );
  assert.match(videoWorkshopHtml, /id="speedVersionSelect"[^>]*hidden/);
  assert.match(videoWorkshopHtml, /class="delivery-speed-menu"\s+id="deliverySpeedMenu"/);
  assert.match(videoWorkshopHtml, /id="historyDeliveryFilter"[^>]*hidden/);
  assert.match(videoWorkshopHtml, /class="delivery-speed-menu history-filter-menu"\s+id="historyDeliveryFilterMenu"/);
  assert.match(videoWorkshopHtml, /\.toast\s*\{[^}]*background:\s*#ffffff;[^}]*color:\s*#242422;/s);
  assert.match(videoWorkshopCss, /\.delivery-actions\s*\{[^}]*border-radius:\s*999px;[^}]*background:\s*#0d0d0c;/s);
  assert.match(videoWorkshopCss, /\.drop-overlay::before\s*\{[^}]*inset:\s*18px;[^}]*border-radius:\s*26px;/s);
  assert.match(videoWorkshopCss, /body\.is-file-dragging\s+\.app-shell\s*\{[^}]*opacity:\s*1;[^}]*filter:\s*none;/s);
  assert.match(videoWorkshopCss, /\.delivery-speed-menu\s*>\s*div\s*\{[^}]*background:\s*#ffffff;/s);
  assert.match(videoWorkshopCss, /\.delivery-actions\s*\{[^}]*font-family:\s*Inter,[^}]*font-size:\s*12px;[^}]*font-weight:\s*540;/s);
  assert.match(videoWorkshopCss, /\.chat-composer\s*\{[^}]*padding:\s*76px[^;]*;[^}]*backdrop-filter:\s*none;/s);
  assert.match(videoWorkshopJs, /function selectSpeedVersion\(value\)/);
  assert.match(videoWorkshopJs, /function selectHistoryDeliveryFilter\(value\)/);
});

test("batch history uses the same non-collapsible grouped session controls", () => {
  const batchRows = section(mainJs, 'if (zone === "agent") {', 'if (zone === "custom") {');
  assert.match(batchRows, /title:\s*"历史会话"/);
  assert.match(batchRows, /collapsible:\s*false/);
  assert.match(batchRows, /data-batch-session-create/);
  assert.match(batchRows, /data-session-create-group="batch"/);
  assert.doesNotMatch(batchRows, /title:\s*"生产会话"/);
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\[data-zone="agent"\]\s+\.wsctx-row-shell:hover,[\s\S]*?background:\s*rgba\(255,255,255,\.055\);/s,
  );
});

test("reference targets animate subtly and custom copy aligns with the cover editor", () => {
  assert.match(chainWorkshopJs, /class="refbar card reference-attention"\s+id="wsRefbar"/);
  assert.match(chainWorkshopJs, /class="infoflow-ref-row reference-attention"\s+id="wsInfoFlowRefs"/);
  assert.match(viewsCss, /\.reference-attention\s*\{[^}]*animation:\s*referenceAttentionBreath/s);
  assert.match(viewsCss, /#wsBriefbar\.no-narration\s+\.ws-brief-fields\s*\{[^}]*grid-template-rows:\s*auto\s+356px/s);
  assert.match(viewsCss, /#wsBriefbar\.no-narration\s+\.ws-copy-fields\s*\{[^}]*height:\s*356px/s);
  assert.match(viewsCss, /#wsBriefbar\.no-narration\s+\.ws-cover-inline\s*\{[^}]*height:\s*356px/s);
});

test("custom publishing retains unfinished cover work and exposes varied cover directions", () => {
  assert.match(customPublishJs, /CUSTOM_PUBLISH_DRAFT_PREFIX/);
  assert.match(customPublishJs, /localStorage\.setItem\(publishDraftKey\(output,\s*kind\)/);
  assert.match(customPublishJs, /if \(!published\)\s*\{\s*persistDraft\(\);\s*return;/s);
  assert.match(customPublishJs, /coverReferenceAssetIds:\s*coverReferenceAssetIds\.slice\(\)/);
  assert.match(customPublishJs, /coverStyle:\s*coverStyleInput\?\.value/);
  assert.match(customPublishJs, /coverPalette:\s*coverPaletteInput\?\.value/);
  assert.match(customPublishJs, /\["cinematic",\s*"电影海报"/);
  assert.match(customPublishJs, /\["bold-type",\s*"强字效海报"/);
  assert.match(customPublishJs, /\["random",\s*"随机灵感"/);
  assert.match(customPublishJs, /id="customPublishRandomPalette"/);
  assert.match(customCreationJs, /const previous = host\.__customLatestOutput/);
  assert.match(customCreationJs, /sameProject \? previous : \{\}/);
});

test("asset and publishing workspaces adapt their controls into the context sidebar", () => {
  const sidebarRows = section(mainJs, 'if (zone === "assets") {', 'if (zone === "settings") {');
  assert.match(sidebarRows, /assetsView\.getLibraryModel\?\.\(\)/);
  assert.match(sidebarRows, /data-ws-library=/);
  assert.match(sidebarRows, /deliveryView\.getFilterModel\?\.\(\)/);
  assert.match(sidebarRows, /deliveryFilterControls\(model\)/);
  const deliveryRows = section(mainJs, 'if (zone === "delivery") {', 'if (zone === "settings") {');
  assert.doesNotMatch(deliveryRows, /title:\s*"发布项目"/);
  assert.doesNotMatch(deliveryRows, /deliveredAssets/);

  const shellHandlers = section(
    mainJs,
    "function ensureWorkspaceContextShell(panel)",
    "function scheduleWorkspaceContextRender()",
  );
  assert.match(shellHandlers, /assetsView\.setLibraryMode\?\.\(library\)/);
  assert.match(shellHandlers, /deliveryView\.setFilter\?\.\(/);
  assert.match(shellHandlers, /deliveryView\.resetFilters\?\.\(\)/);
  assert.match(shellHandlers, /data-ws-delivery-select/);
  assert.match(shellHandlers, /data-ws-delivery-date/);
  assert.match(mainJs, /class="wsctx-filter-range"/);
  assert.match(deliveryViewJs, /回传链接时间/);
  assert.match(deliveryViewJs, /创作时间/);

  assert.match(
    baseCss,
    /body\.workspace-shell-v2\[data-zone="assets"\]\s+#assetsTopDock,[^{]*body\.workspace-shell-v2\[data-zone="delivery"\]\s+\.creator-delivery-filters[^{]*\{[^}]*display\s*:\s*none\s*!important\s*;/s,
  );
});

test("unified workspace visual hierarchy stays flat without hiding functional controls", () => {
  assert.match(
    baseCss,
    /body\.workspace-shell-v2:not\(\[data-zone="agent"\]\)\s+\.main-col,[^{]*body\.workspace-shell-v2:not\(\[data-zone="agent"\]\)\s+\.view-root\s*\{[^}]*background\s*:\s*#fff\s*;/s,
  );
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\[data-zone="studio"\]\s+\.studio-home\s*>\s*\.card,[^{]*\.chain-main\s*>\s*\.card:not\(\.dark\),[^{]*\.chain-side\s*>\s*\.card\s*\{[^}]*border-color\s*:\s*transparent\s*;[^}]*border-radius\s*:\s*0\s*;[^}]*background\s*:\s*#fff\s*;[^}]*box-shadow\s*:\s*none\s*;/s,
  );
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\[data-zone="studio"\]\s+\.studio-home\s*>\s*\.card\s*\+\s*\.card\s*\{[^}]*border-top\s*:\s*1px solid #ececea\s*;/s,
  );
  assert.doesNotMatch(
    baseCss,
    /body\.workspace-shell-v2\[data-zone="studio"\][^{]*\{[^}]*(?:display\s*:\s*none|visibility\s*:\s*hidden|pointer-events\s*:\s*none)/s,
  );
});

test("batch divider is removed and the asset draft timeline uses a fine gray gradient", () => {
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\[data-zone="agent"\]\s+\.ctx-panel,[^{]*body\.workspace-shell-v2\[data-zone="agent"\]\.has-panel\s+\.ctx-panel\s*\{[^}]*border-right-color\s*:\s*transparent\s*;[^}]*box-shadow\s*:\s*none\s*;/s,
  );
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\[data-zone="assets"\]\s+\.draft-timeline::before\s*\{[^}]*width\s*:\s*1px\s*;[^}]*background\s*:\s*linear-gradient\([^}]*rgba\(126,\s*126,\s*121,\s*\.48\)[^}]*\)\s*;[^}]*box-shadow\s*:\s*none\s*;/s,
  );
});

test("workspace brand owns compact search and notification actions without a hamburger", () => {
  const topbar = section(indexHtml, '<header class="topbar">', "</header>");
  const dockStart = topbar.indexOf('<div class="top-actions" id="workspaceUtilityDock">');
  const panelStart = topbar.indexOf('<div class="top-actions-panel" id="topActionsPanel">');
  const searchStart = topbar.indexOf('id="topSearch"');
  assert.ok(dockStart >= 0, "missing utility dock");
  assert.ok(panelStart > dockStart, "action panel must remain in the utility dock");
  assert.ok(searchStart > panelStart, "top actions must be nested in the action panel");
  assert.doesNotMatch(topbar, /id="topActionsToggle"/);
  const contextShell = section(mainJs, "function ensureWorkspaceContextShell", "function renderWorkspaceContextPanel");
  assert.match(contextShell, /id="workspaceContextActions"/);
  assert.match(contextShell, /id="workspaceAccountNotify"/);
  assert.match(contextShell, /if \(topSearch && contextActions\) contextActions\.append\(topSearch\)/);
  assert.match(contextShell, /if \(topBell && accountNotify\) accountNotify\.append\(topBell\)/);

  assert.match(baseCss, /\.workspace-utility-toggle\s*\{[^}]*display\s*:\s*none\s*;/s);
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\s+\.workspace-utility-toggle\s*\{[^}]*display\s*:\s*none\s*!important\s*;/s,
  );
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\s+\.top-actions-panel\s*\{[^}]*position\s*:\s*static\s*;[^}]*opacity\s*:\s*1\s*;[^}]*visibility\s*:\s*visible\s*;[^}]*pointer-events\s*:\s*auto\s*;/s,
  );
  assert.match(
    baseCss,
    /\.workspace-context-actions #topSearch span,[^{]*\.workspace-context-actions #topSearch kbd\s*\{[^}]*display\s*:\s*none\s*;/s,
  );
});

test("workspace menu and context groups stay compact and collapsible", () => {
  assert.match(
    baseCss,
    /\.workspace-context-brand\s+\.workspace-menu\s*\{[^}]*width\s*:\s*100%\s*;[^}]*padding\s*:\s*6px\s*;/s,
  );
  assert.match(
    baseCss,
    /\.workspace-context-brand\s+\.workspace-menu button\s*\{[^}]*min-height\s*:\s*36px\s*;[^}]*padding\s*:\s*5px 8px\s*;/s,
  );
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\s+\.wsctx-title\s*\{[^}]*height\s*:\s*24px\s*;[^}]*font-size\s*:\s*10\.5px\s*;/s,
  );
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\s+\.wsctx-row\s*\{[^}]*min-height\s*:\s*35px\s*;[^}]*padding\s*:\s*5px 8px\s*;/s,
  );

  const contextRender = section(mainJs, "function renderWorkspaceContextPanel()", "function renderContextPanel()");
  assert.match(contextRender, /const collapsible\s*=\s*group\.collapsible\s*!==\s*false/);
  assert.match(contextRender, /const collapsed\s*=\s*collapsible\s*&&\s*collapsedGroups\.has\(groupKey\)/);
  assert.match(contextRender, /data-ws-group=/);
  assert.match(contextRender, /aria-expanded=/);
  assert.match(contextRender, /wsctx-title-chevron/);
  assert.match(contextRender, /wsctx-title-static/);
});

test("administrator settings use four isolated context routes while profile stays separate", () => {
  const settingsContext = section(
    mainJs,
    'if (zone === "settings") {\n      const me = currentMember();',
    'return [{ title: "上下文", rows: [] }];',
  );
  assert.match(settingsContext, /page === "profile"\s*\|\|\s*\(!canManageTeam\s*&&\s*\["editor",\s*"user"\]\.includes\(state\.role\)\)/);
  assert.match(settingsContext, /title:\s*"个人资料"/);
  assert.match(settingsContext, /state\.role === "admin"\s*\|\|\s*canManageTeam/);
  for (const [title, page] of [
    ["成员账号", "members"],
    ["产品库", "products"],
    ["模型用量", "usage"],
    ["团队申请", "requests"],
  ]) {
    assert.match(settingsContext, new RegExp(`title:\\s*"${title}"[\\s\\S]*?page:\\s*"${page}"`));
  }
  const settingsDraw = section(settingsJs, "const draw = () => {", "async function loadRequests()");
  assert.match(settingsDraw, /managementPage === "members"/);
  assert.match(settingsDraw, /managementPage === "products"/);
  assert.match(settingsDraw, /managementPage === "usage"/);
  assert.match(settingsDraw, /managementPage === "requests"/);
  assert.match(settingsJs, /if \(managementPage === "requests"\) loadRequests\(\)/);
  assert.match(settingsJs, /if \(managementPage === "usage"\) loadApiUsage\(\)/);
  assert.match(
    viewsCss,
    /body\.workspace-shell-v2\[data-zone="settings"\]\s+\.view-root\[data-settings-view="profile"\]\s*\{[^}]*display:\s*grid\s*;/s,
  );
  assert.match(
    viewsCss,
    /\.creator-profile-page\s*\{[^}]*align-items:\s*center\s*;[^}]*min-height:\s*100%\s*;[^}]*margin:\s*0 auto\s*;/s,
  );
});

test("administrator overview removes the legacy manual sync action", () => {
  const renderTopbar = section(mainJs, "function renderTopbar()", "function paletteCommands()");
  assert.match(renderTopbar, /const syncDataBtn\s*=\s*\$\("#topSyncAnalytics"\)/);
  assert.match(renderTopbar, /syncDataBtn\?\.remove\(\)/);
  assert.doesNotMatch(renderTopbar, /syncHomepageAnalytics|refreshAllAnalytics/);
});

test("creator and administrator account menus expose the lightweight feedback dialog", () => {
  const accountMarkup = section(mainJs, "function workspaceAccountMarkup()", "function openWorkspaceFeedbackModal()");
  assert.match(accountMarkup, /const canSendFeedback\s*=\s*\["admin",\s*"editor",\s*"user"\]\.includes\(state\.role\)/);
  assert.match(accountMarkup, /data-account-action="feedback"/);
  assert.match(accountMarkup, />意见反馈</);

  const feedback = section(mainJs, "function openWorkspaceFeedbackModal()", "function ensureWorkspaceContextShell");
  assert.match(feedback, /wduan1212@gmail\.com/);
  assert.match(feedback, />欢迎反馈意见</);
  assert.match(feedback, /mailto:\$\{email\}/);
  assert.match(feedback, /workspace-feedback-panel/);

  assert.match(
    baseCss,
    /\.modal-panel\.workspace-feedback-panel\s*\{[^}]*width\s*:\s*min\(430px,[^}]*border-radius\s*:\s*20px\s*;/s,
  );
});

test("supplier and narrow-screen shells keep the unified context layout", () => {
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\.role-supplier\s+\.app-shell,[^{]*body\.workspace-shell-v2\.role-supplier-child\.has-panel\s+\.app-shell\s*\{[^}]*grid-template-columns\s*:\s*var\(--workspace-context-width\)\s+minmax\(0,\s*1fr\)\s*;[^}]*padding-bottom\s*:\s*0\s*;/s,
  );
  assert.match(
    baseCss,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.workspace-context-brand\s+\.workspace-menu\s*\{[^}]*position\s*:\s*absolute\s*;[^}]*top\s*:\s*calc\(100%\s*\+\s*4px\)\s*;/s,
  );
});

test("supplier workspaces move account and delivery tools into the left context", () => {
  const contextRows = section(mainJs, "function renderWorkspaceContextPanel()", "function renderContextPanel()");
  assert.match(contextRows, /supplierContextSearch\("accounts",\s*"搜索账号"\)/);
  assert.match(contextRows, /data-ws-supplier-account-create/);
  assert.match(mainJs, /data-ws-supplier-favorite/);
  assert.match(contextRows, /supplierAccountCollator\.compare/);
  assert.match(contextRows, /supplierContextSearch\("delivery",\s*"搜索账号或素材"\)/);
  assert.match(contextRows, /data-ws-supplier-batch-download/);
  assert.match(contextRows, /wsctx-supplier-delivery-tools/);
  assert.match(mainJs, /buildSupplierSearchResults\(\{/);
  assert.match(mainJs, /delivered:\s*deliveredAssets\(\)/);
  assert.match(mainJs, /group:\s*"相关素材"/);
  assert.match(mainJs, /group:\s*"账号"/);
  assert.match(mainJs, /import\s*\{\s*buildSupplierSearchResults\s*\}/);
  assert.match(mainJs, /deliveryView\.focusAsset\?\.\(asset\.id/);
  assert.match(mainJs, /openPalette\(paletteCommands,\s*\{/);
  assert.match(mainJs, /event\.target\.closest\?\.\("\[data-ws-supplier-search\]"\)/);
  assert.match(mainJs, /let transientSupplierDeliveryQuery = ""/);
  assert.match(mainJs, /if \(scope === "delivery"\) return transientSupplierDeliveryQuery/);
  assert.match(mainJs, /if \(scope === "delivery"\) \{[\s\S]*?transientSupplierDeliveryQuery = String\(value \|\| ""\);[\s\S]*?return;/);
  assert.match(contextRows, /title:\s*"账号申请"/);
  assert.match(contextRows, /title:\s*"全部账号"/);
  assert.doesNotMatch(mainJs, /id="topSupplierOverviewSearch"/);

  assert.match(supplierViewsJs, /const activePage\s*=\s*page === "accounts"\s*\?\s*"accounts"\s*:\s*"requests"/);
  assert.match(supplierViewsJs, /supplier-dashboard-stats/);
  assert.match(deliveryViewJs, /new Intl\.Collator\("zh-CN-u-co-pinyin"/);
  assert.match(deliveryViewJs, /setSupplierDeliveryQuery/);
  assert.match(deliveryViewJs, /batchDownloadSupplierDelivery/);
  assert.match(deliveryViewJs, /matchesDateRange\(creationDay\(x\.asset\),\s*supFilters\.createdFrom,\s*supFilters\.createdTo\)/);
  assert.match(deliveryViewJs, /matchesDateRange\(supplierReturnDay\(x\.asset\),\s*supFilters\.returnedFrom,\s*supFilters\.returnedTo\)/);
  assert.match(deliveryViewJs, /data-supexposure=/);
  assert.match(deliveryViewJs, /remote\.supplier\.updateExposure/);
  assert.match(deliveryViewJs, /value:\s*currentExposure\s*>\s*0\s*\?\s*String\(currentExposure\)\s*:\s*""/);
  assert.doesNotMatch(deliveryViewJs, /id="dvBatchDl"/);
  assert.match(supplierViewsJs, /const SUPPLIER_ACTIVITY_PAGE_SIZE = 4;/);
  assert.doesNotMatch(supplierViewsJs, /data-content-account-views=/);
  assert.match(supplierViewsJs, /由该账号全部交付内容的观看量自动汇总/);

  assert.match(viewsCss, /\.supplier-dashboard-stats\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(viewsCss, /\.supplier-dashboard-visuals\s*\{[^}]*grid-template-columns:\s*minmax\(220px,\s*1fr\)\s+minmax\(440px,\s*2fr\)/s);
  assert.match(viewsCss, /\.supplier-account-platform-tabs\s*\{[^}]*display:\s*inline-flex;[^}]*border-radius:\s*12px/s);
  assert.match(viewsCss, /\.supplier-account-platform-tabs button\.is-active\s*\{[^}]*background:\s*#fff;[^}]*box-shadow:/s);
  assert.match(viewsCss, /\.supplier-account-grid\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);[^}]*border:\s*0/s);
  assert.match(viewsCss, /\.supplier-dashboard-main\s*\{[^}]*grid-template-rows:\s*auto\s+repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(baseCss, /\.wsctx-supplier-search\s*\{[^}]*display:\s*flex;[^}]*border-radius:\s*12px/s);
  assert.match(baseCss, /\.wsctx-supplier-delivery-tools\s*\{[^}]*display:\s*grid;[^}]*gap:\s*8px/s);
  assert.match(baseCss, /role-supplier\s+\.palette-ov\s+\.pal-item[\s\S]*animation:\s*none/s);
  assert.match(componentsJs, /typeof commandSource === "function"/);
  assert.match(componentsJs, /data-pal-more/);
  assert.match(componentsCss, /\.pal-more\s*\{[^}]*min-height:\s*38px/s);
  assert.match(componentsJs, /const preferredLeft = r\.right \+ gap/);
  assert.match(componentsJs, /panel\.style\.left = `\$\{left\}px`/);
  assert.match(componentsJs, /window\.innerWidth - panelWidth - margin/);
  assert.match(indexHtml, /id="topBell"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/);
  assert.match(componentsJs, /anchorBtn\?\.setAttribute\("aria-expanded", "true"\)/);
  assert.match(componentsJs, /anchorBtn\?\.setAttribute\("aria-expanded", "false"\)/);
  assert.match(componentsCss, /@media \(max-width: 720px\)[\s\S]*?\.notify-panel\s*\{[\s\S]*?left:\s*12px !important; right:\s*12px !important;/);
  assert.match(supplierViewsJs, /focusAccount\(state\.ui\.supplierSelectedAccountId\)/);
  assert.match(deliveryViewJs, /focusSupplierDeliveryAsset/);
  assert.match(supplierViewsJs, /data-supplier-platform-filter/);
  assert.match(supplierViewsJs, /accountPlatformCounts/);
  assert.match(supplierViewsJs, /applyAccountFilters\(\{\s*animate:\s*true\s*\}\)/);
  assert.match(viewsCss, /\.supplier-account\s*\{[^}]*grid-template-columns:\s*auto\s+34px\s+minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(viewsCss, /\.supplier-account-controls\s*\{[^}]*min-width:\s*max-content;[^}]*display:\s*flex/s);
  assert.match(uiMotionCss, /\.supplier-account\s*\{[^}]*grid-template-columns:\s*auto\s+34px\s+minmax\(0,\s*1fr\)\s+auto;[^}]*grid-template-rows:\s*auto/s);
  assert.match(uiMotionCss, /\.supplier-account-sequence\s*\{[^}]*position:\s*static;[^}]*justify-self:\s*start/s);
  assert.match(uiMotionCss, /\.supplier-account-controls\s*\{[^}]*grid-column:\s*auto;[^}]*align-items:\s*center/s);
  assert.match(viewsCss, /\.supplier-platform-chart\s+\.supplier-donut\s*\{[^}]*margin-top:\s*64px/s);
  assert.match(viewsCss, /\.supplier-trend-chart\s+\.supplier-trend-scroll\s*\{[^}]*padding-top:\s*18px/s);
  assert.match(supplierViewsJs, /supplier-trend-labels[^`]*days\.map\(\(item,\s*index\)\s*=>\s*`<i style="--x:\$\{points\[index\]\.x\}%"/s);
  assert.match(viewsCss, /\.supplier-trend-labels i\s*\{[^}]*position:\s*absolute;[^}]*left:\s*var\(--x\);[^}]*transform:\s*translateX\(-50%\)/s);
  assert.match(viewsCss, /\.sup-actions-inner\s*\{[^}]*border-radius:\s*999px/s);
  assert.match(viewsCss, /\.sup-col-actions\s*\{\s*width:\s*390px;\s*\}/);
  assert.match(uiMotionCss, /\.sup-col-actions\s*\{\s*width:\s*390px;\s*\}/);
  assert.match(uiMotionCss, /\.sup-actions-inner\s*\{\s*gap:\s*0;\s*\}/);
  assert.match(viewsCss, /\.sup-acts\s+\.sup-actions-inner\s+\.btn\s*\{[^}]*padding-inline:\s*5px/s);
  assert.match(viewsCss, /\.sup-acts\s+\.sup-actions-inner\s+\.btn\.primary\s*\{[^}]*color:\s*#fff;[^}]*background:\s*#171b22/s);
});

test("canvas and video switches wait for the real latest project before routing", () => {
  const opener = section(mainJs, "function openWorkspaceItem(item)", "function renderWorkspaceSwitcher()");
  assert.match(opener, /loadWorkspaceProjects\(item\.page,\s*\{\s*force:\s*true\s*\}\)\.then\(items\s*=>/);
  assert.match(opener, /const project\s*=\s*items\?\.\[0\]\s*\|\|/);
  assert.match(opener, /go\(item\.zone,\s*item\.page,\s*project\?\.id\s*\|\|\s*null\)/);
  const load = section(mainJs, "async function loadWorkspaceProjects", "if (typeof window !==");
  assert.match(load, /if\s*\(target\.pending\)\s*\{\s*if\s*\(!force\)\s*return target\.pending/);
  assert.match(load, /if\s*\(target\.forcedPending\)\s*return target\.forcedPending/);
  assert.match(load, /await activePending/);
  assert.match(load, /return loadWorkspaceProjects\(kind,\s*\{\s*force:\s*true\s*\}\)/);
  assert.match(load, /target\.pending\s*=\s*pending/);
});

test("all modified workspace-shell resources use the v141 cache marker", () => {
  assert.doesNotMatch(indexHtml, /v120-shell-3/);
  assert.doesNotMatch(mainJs, /v120-shell-3/);
  assert.match(indexHtml, /styles\/base\.css\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(indexHtml, /styles\/components\.css\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(indexHtml, /styles\/views\.css\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(indexHtml, /styles\/agent\.css\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(indexHtml, /styles\/ui-motion\.css\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(indexHtml, /styles\/custom-creation\.css\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(indexHtml, /js\/main\.js\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(mainJs, /from\s+"\.\/views\/overview\.js\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(mainJs, /from\s+"\.\/views\/assetsView\.js\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(mainJs, /from\s+"\.\/views\/deliveryView\.js\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(mainJs, /from\s+"\.\/views\/customCreation\.js\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(mainJs, /ui\/components\.js\?v=20260815-v1435-ai-topic-partial-1/);
  assert.match(mainJs, /from\s+"\.\/agent\/view\.js\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(mainJs, /from\s+"\.\/ui\/icons\.js"/);
  assert.doesNotMatch(mainJs, /ui\/icons\.js\?v=/);
  assert.match(mainJs, /from\s+"\.\/domain\/delivery\.js\?v=20260815-v1435-ai-topic-partial-1"/);
  assert.match(mainJs, /from\s+"\.\/core\/remote\.js"/);
  assert.doesNotMatch(mainJs, /core\/remote\.js\?v=/);
  assert.match(mainJs, /ui\/loginBeams\.js\?v=20260815-v1435-ai-topic-partial-1/);
  assert.match(mainJs, /const APP_BUILD_ID\s*=\s*"20260815-v1435-ai-topic-partial-1"/);
  assert.doesNotMatch(mainJs, /core\/router\.js\?v=/);
});

test("workspace switcher uses the transparent blue brand lockup", () => {
  const switcher = section(mainJs, "function renderWorkspaceSwitcher()", "function normalizeWorkspaceProject");
  assert.match(switcher, /starmatrix-wordmark-blue-transparent\.png/);
  assert.match(switcher, /class="workspace-brand-lockup"/);
  assert.doesNotMatch(switcher, /workspaceBrandGlyph\s*\(/);
  assert.match(baseCss, /\.workspace-brand-lockup img\s*\{/);
});

test("batch workspace uses a light task-board shell with one create button", () => {
  assert.match(agentViewJs, /class="agw-new-board-button"[^>]*>[\s\S]*?新建任务板<\/button>/);
  assert.match(agentViewJs, /<textarea id="agwInput" hidden>/);
  assert.match(agentCss, /body\.workspace-shell-v2\[data-zone="agent"\]\s+\.agw-composer[\s\S]*?background:\s*rgba\(250,251,252,.94\)/);
  assert.match(agentCss, /\.agw-new-board-button[\s\S]*?background:\s*#ffffff/);
  assert.match(uiMotionCss, /body\.workspace-shell-v2\[data-zone="agent"\]\s+\.agc-seg\.is-active[\s\S]*?color:\s*#fff/);
  assert.match(uiMotionCss, /body\.workspace-shell-v2\[data-zone="agent"\]\s+\.agc-acc\.is-video\s+\.agc-idx[\s\S]*?color:\s*#2f64a9/);
  assert.match(agentCardsJs, /class="agc-account-copy \$\{imgAcc \? "has-mode-switch has-image-count" : ""\}"/);
  assert.match(agentCardsJs, /class="agc-copy-title-input"[^>]*data-pacc-copy-title/);
  assert.match(agentCardsJs, /data-mode="copy"[^>]*>\u591a\u56fe<\/button>/);
  assert.match(agentCardsJs, /data-mode="single"[^>]*>\u5355\u56fe<\/button>/);
  assert.match(agentCardsJs, /function accountDisplayName\(account,[\s\S]*?tail === head\.repeat/);
  assert.match(agentCardsJs, /class="agc-override-name"><b>\$\{esc\(accountDisplayName\(a\)\)\}/);
  assert.match(agentCardsJs, /class="agc-acc[\s\S]*?<b>\$\{esc\(accountDisplayName\(a\)\)\}/);
  assert.match(agentViewJs, /accountDisplayName\(state\.accounts\.find\(a => a\.id === accountId\), "当前账号"\)/);
  assert.match(agentCardsJs, /<div class="agc-mini-ref">[\s\S]*?<div class="agc-override-actions">[\s\S]*?\u4ece\u8d44\u4ea7\u9009\u62e9[\s\S]*?\u53d6\u6d88\u9009\u62e9/);
  assert.match(uiMotionCss, /\.agc-override\.is-custom-plan\s+\.agc-account-copy\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content/);
  assert.match(uiMotionCss, /\.agc-account-copy\.has-mode-switch[\s\S]*?grid-template-columns:\s*86px\s+minmax\(0,\s*1fr\)\s+max-content/);
  assert.match(uiMotionCss, /\.agc-override\.is-custom-plan\s+\.agc-copy-editor-btn[\s\S]*?max-width:\s*124px/);
  assert.match(uiMotionCss, /grid-template-areas:\s*\n\s*"name content imgcount"\s*\n\s*"refs refs refs"/);
  assert.match(agentViewJs, /class="asset-picker-upload" data-ap-upload-zone/);
  assert.match(agentViewJs, /wireDropZone\(uploadZone,\s*addUploadedImages,\s*\{ filesOnly:\s*true \}\)/);
  assert.match(agentViewJs, /const \{ addAssetFromDataUrl \} = await import\("\.\.\/domain\/assets\.js"\);[\s\S]*?addAssetFromDataUrl\(kind === "custom" \? accountId : null/);
  assert.match(agentCardsJs, /class="static-agent-board-mark/);
  assert.doesNotMatch(agentCardsJs, /class="static-agent-board-status/);
  assert.match(uiMotionCss, /\.agc-head\s*>\s*b[\s\S]*?color:\s*#252a33\s*!important/);
  assert.match(uiMotionCss, /\.static-agent-progress\s*\{\s*display:\s*none/);
  assert.doesNotMatch(agentCardsJs, /<div class="static-agent-progress">/);
});

test("batch account selection stays spatially stable and shows shared daily quota", () => {
  const planCard = section(agentCardsJs, "  plan(m) {", "  /* 进度卡：活卡片，从 store 实时取数 */");

  assert.match(planCard, /aria-pressed="\$\{on \? "true" : "false"\}"/);
  assert.match(planCard, /class="agc-select-mark \$\{on \? "is-visible" : ""\}"/);
  assert.match(planCard, /const publishQuota = accountPublishQuota\(a\.id\)/);
  assert.match(planCard, /class="agc-account-meta"[\s\S]*?class="agc-account-type"[\s\S]*?今日发布 \$\{quota\.used\}\/\$\{quota\.limit\}/);
  assert.match(planCard, /quotaFull && !on/);
  assert.doesNotMatch(planCard, /\$\{on \? icon\("check"/);
  assert.match(uiMotionCss, /v130 batch interaction:[\s\S]*?\.agc-acc\s*\{[\s\S]*?grid-template-columns:\s*48px\s+minmax\(0,\s*1fr\)\s+minmax\(104px,\s*max-content\)\s+24px/);
  assert.match(uiMotionCss, /\.agc-select-mark\.is-visible\s*\{[\s\S]*?background:\s*linear-gradient/);
  assert.match(uiMotionCss, /@keyframes agcAccountSelectIn/);
});

test("image batch keeps per-item image count in the copy row and reference pickers accept drops", () => {
  const planCard = section(agentCardsJs, "  plan(m) {", "  /* 进度卡：活卡片，从 store 实时取数 */");
  const imageCopyRow = section(planCard, 'class="agc-account-copy ${imgAcc ? "has-mode-switch has-image-count" : ""}"', "</div>`}\n        </div>`;");

  assert.match(planCard, /const imageCountControl\s*=\s*imgAcc\s*&&\s*imageCreationMode\s*!==\s*"single"/);
  assert.match(planCard, /统一每条图数[\s\S]*?data-pf="imageCount"/);
  assert.match(planCard, /data-act="plan-apply-image-count"[\s\S]*?应用到全部图文/);
  assert.match(imageCopyRow, /\$\{imageModeSwitch\}[\s\S]*?data-pacc-copy-title[\s\S]*?data-act="plan-edit-copy"[\s\S]*?\$\{imageCountControl\}/);
  assert.match(uiMotionCss, /v132:[\s\S]*?@media \(min-width:\s*981px\)[\s\S]*?\.agc-account-copy\.has-mode-switch\.has-image-count\s*\{[\s\S]*?display:\s*flex\s*!important;[\s\S]*?flex-flow:\s*row nowrap\s*!important/);
  assert.match(uiMotionCss, /\.agc-account-copy\.has-mode-switch\.has-image-count\s+\.agc-mini-count\.img-count\s*\{[\s\S]*?grid-area:\s*auto\s*!important[\s\S]*?position:\s*static\s*!important[\s\S]*?flex:\s*0 0 78px/);
  assert.match(planCard, /class="agc-ref-picked \$\{editable \? "is-dropzone" : ""\}"/);
  assert.match(planCard, /data-plan-custom-refdrop="\$\{m\.id\}" data-ref-account="\$\{a\.id\}"/);
  assert.match(agentViewJs, /kind === "custom" \? "选择定制参考图"/);
  assert.match(agentViewJs, /const pickerSurface = panel\.querySelector\("\.asset-picker"\);[\s\S]*?wireDropZone\(pickerSurface,\s*addUploadedImages,\s*\{ filesOnly:\s*true \}\)/);
  assert.match(agentViewJs, /wireDropZone\(uploadZone,\s*addUploadedImages,\s*\{ filesOnly:\s*true \}\)/);
  assert.match(agentViewJs, /wireDropZone\(z,\s*files\s*=>\s*setPlanCustomRefs\(z\.dataset\.planCustomRefdrop/);
  assert.match(uiMotionCss, /\.asset-picker-upload\.drag-over[\s\S]*?\.agc-override\[data-plan-custom-refdrop\]\.drag-over/);
});

test("static-video plans keep image accounts on the video copy editor", () => {
  const planCard = section(agentCardsJs, "  plan(m) {", "  /* 进度卡：活卡片，从 store 实时取数 */");
  const imageAccountMatcher = planCard.match(/const isImageAcc\s*=\s*(a\s*=>[^;]+);/);
  assert.ok(imageAccountMatcher, "plan card must define the image-only account gate");

  const makeImageAccountMatcher = Function(
    "isImageKind",
    "groupOf",
    `return (${imageAccountMatcher[1]});`,
  );
  const xhsImageAccount = { platform: "小红书", mode: "图文" };
  const staticContentKind = "static";
  assert.equal(makeImageAccountMatcher(true, () => "图文组")(xhsImageAccount), true);
  assert.equal(
    makeImageAccountMatcher(staticContentKind === "image", () => "图文组")(xhsImageAccount),
    false,
  );

  assert.match(planCard, /const imageModeSwitch\s*=\s*imgAcc\s*\?\s*`<div class="agc-image-mode-switch"/);
  assert.match(planCard, /imgAcc && imageCreationMode !== "single"\s*\?\s*`<label class="agc-mini-count img-count">每条图数/);
  assert.match(planCard, /<input class="agc-copy-title-input"[^>]*data-pacc-copy-title/);
  assert.match(planCard, /data-act="plan-edit-copy"[^>]*>[\s\S]*?填写文案/);
});
