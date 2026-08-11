import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = async path => readFile(new URL(path, root), "utf8");

test("registration creates and signs into a unique personal account directly", async () => {
  const [indexHtml, mainJs, remoteJs] = await Promise.all([
    read("index.html"),
    read("js/main.js"),
    read("js/core/remote.js"),
  ]);
  assert.match(indexHtml, /注册账号/);
  assert.match(mainJs, /roleField\.hidden = true/);
  assert.match(mainJs, /remote\.register\(\{ name, username, pin \}\)/);
  assert.match(mainJs, /注册成功，今天的 70 点体验积分已到账/);
  assert.match(remoteJs, /req\("\/api\/auth\/register"/);
  assert.doesNotMatch(mainJs, /等待 ACG 市场部管理员审批/);
});

test("first visit opens the guest home and creative routes require the login modal", async () => {
  const [mainJs, routerJs, homeJs, indexHtml] = await Promise.all([
    read("js/main.js"),
    read("js/core/router.js"),
    read("js/views/home.js"),
    read("index.html"),
  ]);
  assert.match(mainJs, /const GUEST_MEMBER_ID/);
  assert.match(mainJs, /if \(!entered\) \{ enterGuest\(\); entered = true; \}/);
  assert.match(mainJs, /showGate\(\{ modal: true \}\)/);
  assert.match(mainJs, /state\.role !== "guest"/);
  assert.match(routerJs, /state\.role === "guest"/);
  assert.match(routerJs, /\["home", "subscription", "assets"\]/);
  assert.match(indexHtml, /<body data-zone="home">/);
  assert.match(homeJs, /xingzhen:auth-required/);
  assert.match(indexHtml, /id="lgModalClose"/);
});

test("personal entry routes to the new home while suppliers retain their current home", async () => {
  const [mainJs, routerJs] = await Promise.all([
    read("js/main.js"),
    read("js/core/router.js"),
  ]);
  assert.match(routerJs, /location\.hash \|\| "#\/home"/);
  assert.match(mainJs, /supplierRole \? "overview" : "home"/);
  assert.match(mainJs, /parent \? "首页" : "账号数据"/);
  assert.match(mainJs, /zone === "home" && !supplier/);
});

test("home exposes the two creation entrances, multimodal handoff, and inspiration discovery", async () => {
  const [homeJs, routerJs] = await Promise.all([
    read("js/views/home.js"),
    read("js/core/router.js"),
  ]);
  assert.match(homeJs, /无限画布/);
  assert.match(homeJs, /视频工坊/);
  assert.match(homeJs, /STARMATRIX/);
  assert.match(homeJs, /和小星一起创作！/);
  assert.match(homeJs, /starmatrix-mascot-wink\.webp/);
  assert.match(homeJs, /HOME_TYPEWRITER_PHRASES/);
  assert.match(homeJs, /动态视频/);
  assert.match(homeJs, /静态视频/);
  assert.match(homeJs, /<span>视频<\/span>/);
  assert.match(homeJs, /<span>图片<\/span>/);
  assert.match(homeJs, /<b>动态<\/b><b>静态<\/b>/);
  assert.match(homeJs, /creationMode/);
  assert.match(homeJs, /灵感发现/);
  assert.match(homeJs, /starmatrix\.homeLaunch\.v1/);
  assert.match(homeJs, /mode === "canvas" \? file\.type\.startsWith\("image\/"\)/);
  const petStart = homeJs.indexOf("function homePetMarkup");
  const petEnd = homeJs.indexOf("\nfunction inspirationDetail", petStart);
  const petMarkup = homeJs.slice(petStart, petEnd);
  assert.equal((petMarkup.match(/<img\b/g) || []).length, 1);
  assert.doesNotMatch(petMarkup, /home-pet-(?:normal|idle|hover|working)/);
  assert.match(homeJs, /const eventController = new AbortController\(\)/);
  assert.match(homeJs, /root\.__viewCleanup = \(\) =>/);
  assert.match(routerJs, /root\.__viewCleanup\?\.\(\)/);
  assert.doesNotMatch(homeJs, /最近项目/);
  assert.match(homeJs, /member\.pointsRemaining \?\? member\.dailyPointsRemaining/);
  assert.match(homeJs, /memberProfile\.get\(\)/);
  assert.match(homeJs, /data-home-points-value/);
});

test("team removal preserves the account as Free and ACG managers can disable creator logins", async () => {
  const [settingsJs, remoteJs, mainPy, storePy] = await Promise.all([
    read("js/views/settings.js"),
    read("js/core/remote.js"),
    read("server/main.py"),
    read("server/store.py"),
  ]);
  assert.match(settingsJs, /踢出团队/);
  assert.match(settingsJs, /账号和创作记录会完整保留/);
  assert.match(settingsJs, /账号已转为 Free/);
  assert.match(remoteJs, /kick: \(id\) => req\("\/api\/members\/"/);
  assert.match(storePy, /def kick_team_member/);
  assert.match(storePy, /SET status='removed'/);
  assert.match(storePy, /UPDATE members SET role='user'/);
  assert.match(mainPy, /\/api\/platform\/accounts\/\{mid\}\/status/);
  assert.match(mainPy, /member_account_disabled/);
  assert.doesNotMatch(settingsJs, /全部创作端账号/);
  assert.match(settingsJs, /停用账号/);
});

test("free language and canvas agent operations use the same reserve-settle point ledger", async () => {
  const mainPy = await read("server/main.py");
  assert.match(mainPy, /LLM_GENERATION_POINTS/);
  assert.match(mainPy, /namespace="llm\.proxy"/);
  assert.match(mainPy, /namespace="llm\.chat-completions"/);
  assert.match(mainPy, /namespace="canvas\.agent"/);
  assert.match(mainPy, /custom-video\.dialogue/);
  assert.match(mainPy, /_run_personal_billable/);
});

test("delivery metrics converge through one lightweight server-authoritative projection", async () => {
  const [storeJs, supplierViews, deliveryView, overview, remoteJs, mainPy, storePy] = await Promise.all([
    read("js/core/store.js"),
    read("js/views/supplierViews.js"),
    read("js/views/deliveryView.js"),
    read("js/views/overview.js"),
    read("js/core/remote.js"),
    read("server/main.py"),
    read("server/store.py"),
  ]);
  assert.match(mainPy, /@app\.get\("\/api\/deliveries\/metrics"\)/);
  assert.match(remoteJs, /deliveryMetrics = \(\) => req\("\/api\/deliveries\/metrics"\)/);
  assert.match(storeJs, /export async function refreshDeliveryMetrics/);
  assert.match(storeJs, /applyDeliveryMetricProjection/);
  assert.match(storeJs, /incomingUpdatedAt < currentUpdatedAt/);
  assert.match(storeJs, /db\.putMany\("assets", changedAssets\)/);
  const metricRefreshStart = storeJs.indexOf("export async function refreshDeliveryMetrics");
  const metricRefreshEnd = storeJs.indexOf("/* ---- 通知中心 ---- */", metricRefreshStart);
  assert.ok(metricRefreshStart >= 0 && metricRefreshEnd > metricRefreshStart);
  assert.doesNotMatch(storeJs.slice(metricRefreshStart, metricRefreshEnd), /remote\.putCollection/);
  assert.match(deliveryView, /refreshDeliveryMetrics/);
  assert.match(deliveryView, /setInterval/);
  assert.match(overview, /refreshDeliveryMetrics/);
  assert.match(supplierViews, /refreshDeliveryMetrics\(\{ force: true \}\)/);
  assert.match(supplierViews, /refreshRemoteCollections\(\["assets", "accounts"\]\)/);
  assert.ok(
    supplierViews.indexOf('refreshRemoteCollections(["assets", "accounts"])')
      < supplierViews.indexOf('refreshDeliveryMetrics({ force: true })'),
    "supplier delivery metrics must be projected after the collection snapshot",
  );
  assert.match(supplierViews, /addEventListener\("focus"/);
  assert.match(supplierViews, /xingzhen:supplier-authority-refreshed/);
  assert.match(supplierViews, /SUPPLIER_AUTHORITY_POLL_MS = 15000/);
  assert.match(supplierViews, /setInterval\(/);
  assert.match(deliveryView, /syncAuthority/);
  assert.match(deliveryView, /观看量更新失败", "error"/);
  assert.match(remoteJs, /timeoutMs: 20000/);
  assert.match(remoteJs, /transientRetries: 1/);
  assert.match(storePy, /def list_delivery_asset_metrics/);
  assert.match(storePy, /SUPPLIER_ASSET_SERVER_METRIC_FIELDS/);
  assert.match(storePy, /_preserve_supplier_asset_server_metrics/);
});

test("join-team dialog stays inside the modal content box", async () => {
  const styles = await read("styles/views.css");
  const start = styles.indexOf(".home-team-join-dialog {");
  const end = styles.indexOf("}", start);
  const block = styles.slice(start, end + 1);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /box-sizing:\s*border-box/);
  assert.match(block, /width:\s*100%/);
  assert.doesNotMatch(block, /calc\(100vw/);
});

test("creator metrics modals expose per-content exposure, views, and interaction columns", async () => {
  const [overview, styles] = await Promise.all([
    read("js/views/overview.js"),
    read("styles/views.css"),
  ]);
  assert.match(overview, /overview-view-account/);
  assert.match(overview, /overview-view-delivery/);
  assert.match(overview, /item\.asset\?\.title \|\| item\.asset\?\.name/);
  assert.match(overview, /item\.sourceLabel/);
  assert.match(overview, /item\.exposure/);
  assert.match(overview, /row\.rows\.filter\(item => contentMatchesPeriod\(item\)/);
  assert.match(overview, /data-view-number="minViews"/);
  assert.match(overview, /data-view-number="maxViews"/);
  assert.match(overview, /创作人/);
  assert.match(overview, /曝光量/);
  assert.match(overview, /播放量/);
  assert.match(overview, /overview-view-filterbar/);
  assert.match(overview, /overview-interaction-row/);
  assert.match(overview, /overview-interaction-content/);
  assert.match(overview, /overview-interaction-value/);
  assert.match(styles, /\.overview-views-panel/);
  assert.match(styles, /\.overview-interactions-panel/);
  assert.match(styles, /\.overview-view-deliveries/);
  assert.match(styles, /\.overview-view-filterbar/);
  assert.match(styles, /\.overview-interaction-columns/);
});

test("home launch keeps binary attachments in a short-lived token registry", async () => {
  const [homeJs, customCreationJs] = await Promise.all([
    read("js/views/home.js"),
    read("js/views/customCreation.js"),
  ]);
  const stageStart = homeJs.indexOf("function stageHomeLaunch");
  const stageEnd = homeJs.indexOf("\nfunction startTypewriter", stageStart);
  const stageBlock = homeJs.slice(stageStart, stageEnd);
  const storageStart = stageBlock.indexOf("sessionStorage.setItem(HOME_LAUNCH_KEY");
  const storageEnd = stageBlock.indexOf("} catch (error)", storageStart);
  const storedMetadata = stageBlock.slice(storageStart, storageEnd);
  assert.ok(stageStart >= 0 && stageEnd > stageStart);
  assert.match(homeJs, /const HOME_LAUNCH_REGISTRY_KEY = "__starmatrixHomeLaunchRegistry"/);
  assert.match(stageBlock, /homeLaunchRegistry\(\)/);
  assert.match(storedMetadata, /launchToken/);
  assert.match(storedMetadata, /attachmentMeta/);
  assert.doesNotMatch(storedMetadata, /dataUrl/);
  assert.match(homeJs, /素材暂存失败，请重试或减少附件/);
  assert.match(homeJs, /读取失败，请重新添加/);
  assert.match(customCreationJs, /registry\.get\(launchToken\)/);
  assert.match(customCreationJs, /registry\.delete\(launchToken\)/);
  assert.match(customCreationJs, /stagedPayload\.attachments/);
});

test("personal workspace keeps voice inside video while team studio moves to the home action", async () => {
  const [mainJs, storePy, routerJs] = await Promise.all([
    read("js/main.js"),
    read("server/store.py"),
    read("js/core/router.js"),
  ]);
  const personalStart = mainJs.indexOf("const personalOrder = [");
  const personalEnd = mainJs.indexOf("];", personalStart);
  const personalOrder = mainJs.slice(personalStart, personalEnd);
  const orderedKeys = [
    "home", "custom-video", "custom-canvas", "assets",
    "studio", "agent", "delivery", "overview",
  ];
  let cursor = -1;
  for (const key of orderedKeys) {
    const next = personalOrder.indexOf(`"${key}"`, cursor + 1);
    assert.ok(next > cursor, `${key} should follow the requested personal navigation order`);
    cursor = next;
  }
  assert.doesNotMatch(personalOrder, /custom-voice/);
  assert.match(mainJs, /if \(currentTeam\(\)\) return items/);
  const sharedStart = mainJs.indexOf('item({ key: "home"');
  const sharedEnd = mainJs.indexOf("];", sharedStart);
  const sharedItems = mainJs.slice(sharedStart, sharedEnd);
  assert.ok(sharedItems.indexOf('key: "studio"') < sharedItems.indexOf('key: "assets"'), "team navigation order must stay unchanged");
  assert.match(mainJs, /items\.filter\(entry => entry\.key !== "studio"\)/);
  assert.match(await read("js/views/home.js"), /data-home-all-accounts[\s\S]*账号数据/);
  assert.match(storePy, /PERSONAL_FEATURES = \([\s\S]*"home", "video_workshop", "canvas", "voice", "assets", "profile", "team_join"[\s\S]*\)/);
  assert.match(routerJs, /if \(zone === "voice"\)[\s\S]*page = "video"/);
  assert.match(routerJs, /if \(page === "voice"\) page = "video"/);
});

test("overall assets keeps the new hierarchy and gates personal source filters by plan", async () => {
  const [assetsView, creationView] = await Promise.all([
    read("js/views/assetsView.js"),
    read("js/views/customCreation.js"),
  ]);
  assert.match(assetsView, /key: "drafts", label: "草稿箱"/);
  assert.match(assetsView, /key: "shared", label: "账号资产"/);
  assert.match(assetsView, /key: "favorites", label: "收藏夹"/);
  assert.match(assetsView, /key: "backend", label: "后台素材"/);
  assert.match(assetsView, /const hasProfessionalAssetFilters = \(\) =>/);
  assert.match(assetsView, /isPersonalLibrary\(\) && hasProfessionalAssetFilters\(\) && libraryMode === "shared"/);
  assert.match(assetsView, /个人资产\|视频工坊\|无限画布/);
  assert.match(assetsView, /data-personal-source="video">视频工坊/);
  assert.match(assetsView, /data-personal-source="canvas">无限画布/);
  assert.match(assetsView, /fSource === "video" \? \/视频工坊\//);
  assert.match(assetsView, /无限画布和视频工坊的生成结果会自动收纳到这里/);
  assert.match(creationView, /storePersonalOutput\(key, host\.__customLatestOutput\)/);
  assert.match(creationView, /tags: \["个人资产", "视频工坊", "生成成片"\]/);
  assert.match(creationView, /tags: \["个人资产", "无限画布", "生成图片"\]/);
  assert.match(creationView, /processImage: false/);
});

test("home sidebar shows locked VIP functions while keeping assets available and merges only video and canvas history", async () => {
  const [mainJs, baseCss] = await Promise.all([
    read("js/main.js"),
    read("styles/base.css"),
  ]);
  assert.match(mainJs, /const availableFunctions = workspaceNavItems\(\)[\s\S]*\.filter\(item => item\.zone !== "home"\)/);
  assert.match(mainJs, /tag: item\.locked && item\.key !== "assets" \? "VIP" : ""/);
  assert.match(mainJs, /attrs: item\.locked \? `data-ws-locked="true"/);
  assert.match(mainJs, /className: `wsctx-home-function\$\{item\.locked && item\.key !== "assets" \? " is-vip" : ""\}`/);
  assert.match(mainJs, /"video_workshop"\)/);
  assert.match(mainJs, /"canvas"\)/);
  assert.match(mainJs, /loadWorkspaceProjects\("video"\)/);
  assert.match(mainJs, /loadWorkspaceProjects\("canvas"\)/);
  assert.match(mainJs, /const history = \[\.\.\.videoHistory, \.\.\.canvasHistory\]/);
  assert.doesNotMatch(mainJs.slice(mainJs.indexOf('if \(zone === "home"'), mainJs.indexOf('if \(zone === "overview"')), /state\.sessions/);
  assert.match(baseCss, /data-zone="home"\][^{]*\.app-shell[^{]*\{[^}]*grid-template-columns:\s*var\(--workspace-context-width\)\s+minmax\(0,\s*1fr\)/s);
  assert.match(baseCss, /@media \(max-width: 900px\)[\s\S]*data-zone="home"[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(baseCss, /data-zone="home"\][^{]*\.wsctx-home-function\.is-vip/);
});

test("home brand is static while other workspaces retain the switch menu", async () => {
  const [mainJs, baseCss] = await Promise.all([
    read("js/main.js"),
    read("styles/base.css"),
  ]);
  assert.match(mainJs, /const homeWorkspace = parseHash\(\)\.zone === "home"/);
  assert.match(mainJs, /wrap\.classList\.toggle\("is-static", homeWorkspace\)/);
  assert.match(mainJs, /homeWorkspace\s*\? `<div class="workspace-switch-button workspace-switch-static"/);
  assert.match(mainJs, /: `[\s\S]*id="workspaceSwitchMenu"/);
  assert.match(mainJs, /if \(!homeWorkspace\) button\?\.addEventListener\("click"/);
  assert.match(baseCss, /\.workspace-switcher\.is-static \.workspace-switch-static/);
});

test("forced workspace refresh queues a real owner-scoped request after an active load", async () => {
  const mainJs = await read("js/main.js");
  assert.match(mainJs, /forcedPending: null/);
  assert.match(mainJs, /if \(!force\) return target\.pending/);
  assert.match(mainJs, /if \(target\.forcedPending\) return target\.forcedPending/);
  assert.match(mainJs, /await activePending/);
  assert.match(mainJs, /workspaceProjectRequestIsCurrent\(requestIdentity\.ownerKey, requestIdentity\.generation\)/);
  assert.match(mainJs, /return loadWorkspaceProjects\(kind, \{ force: true \}\)/);
});

test("locked team routes redirect to the join-team page", async () => {
  const [mainJs, routerJs, settingsJs] = await Promise.all([
    read("js/main.js"),
    read("js/core/router.js"),
    read("js/views/settings.js"),
  ]);
  assert.match(mainJs, /go\("settings", "team"\)/);
  assert.match(routerJs, /entitlementByRoute/);
  assert.match(routerJs, /!hasEntitlement\(entitlementByRoute\[zone\]\)/);
  assert.match(settingsJs, /申请会发送给该团队的所有者和管理员/);
  assert.match(settingsJs, /requestJoin/);
});

test("guest login, team search requests, owner rename, and login bootstrap errors stay explicit", async () => {
  const [mainJs, homeJs, settingsJs, remoteJs, mainPy, storePy] = await Promise.all([
    read("js/main.js"),
    read("js/views/home.js"),
    read("js/views/settings.js"),
    read("js/core/remote.js"),
    read("server/main.py"),
    read("server/store.py"),
  ]);
  assert.match(mainJs, /const isGuest = state\.role === "guest"/);
  assert.match(mainJs, /data-account-action="login"/);
  assert.match(mainJs, /accountAction === "login"\) showGate\(\{ modal: true \}\)/);
  assert.match(mainJs, /账号已验证，但工作区同步失败/);
  assert.match(mainJs, /登录请求超时/);
  assert.match(homeJs, /openHomeTeamJoinDialog/);
  assert.match(homeJs, /data-home-team-search/);
  assert.match(homeJs, /teams\.requestJoin\(selected\.name/);
  assert.match(settingsJs, /id="teamRenameForm"/);
  assert.match(settingsJs, /remote\.teams\.rename\(name\)/);
  assert.match(remoteJs, /rename: name => req\("\/api\/teams\/current"/);
  assert.match(mainPy, /@app\.put\("\/api\/teams\/current"\)/);
  assert.match(storePy, /def activate_customer_team_plan/);
  assert.match(storePy, /def team_member_ids/);
  assert.doesNotMatch(storePy, /team_id\s+and team_id != INTERNAL_TEAM_ID\s+and owner != member_id/);
  assert.match(mainJs, /async function syncTeamJoinNotifications/);
  assert.match(mainJs, /\["owner", "admin"\]\.includes\(member\?\.teamRole/);
  assert.match(mainJs, /priority: "urgent"/);
});

test("internal team settings keep products and usage while profile remains a separate account action", async () => {
  const [mainJs, settingsJs] = await Promise.all([
    read("js/main.js"),
    read("js/views/settings.js"),
  ]);
  assert.match(mainJs, /contextRow\(\{ title: "产品库"[^}]*page: "products"/);
  assert.match(mainJs, /contextRow\(\{ title: "模型用量"[^}]*page: "usage"/);
  assert.match(mainJs, /data-account-action="profile"/);
  const managementStart = mainJs.indexOf('key: "management"');
  const managementEnd = mainJs.indexOf("const supplierSettingsPage", managementStart);
  assert.ok(managementStart >= 0 && managementEnd > managementStart);
  assert.doesNotMatch(mainJs.slice(managementStart, managementEnd), /title: "个人资料"/);
  assert.match(settingsJs, /managementPages = new Set\(\["members", "products", "usage", "requests"\]\)/);
  assert.match(settingsJs, /平台账号概览/);
  assert.match(settingsJs, /无主个人账号/);
  assert.match(settingsJs, /团队版账号/);
  assert.match(settingsJs, /remote\.admin\.platformAccounts\(\)/);
});

test("member requests raise a red priority notification and publish tags stay readable", async () => {
  const [mainJs, componentsJs, baseCss, componentsCss] = await Promise.all([
    read("js/main.js"),
    read("js/ui/components.js"),
    read("styles/base.css"),
    read("styles/components.css"),
  ]);
  assert.match(mainJs, /priority: "urgent"/);
  assert.match(mainJs, /pendingIds\.has\(String\(item\.teamJoinRequestId\)\)/);
  assert.match(mainJs, /item\.priority = ""/);
  assert.match(componentsJs, /has-priority-notification/);
  assert.match(componentsJs, /n\.priority === "urgent" \? "priority" : ""/);
  assert.match(baseCss, /\.publish-tag-picker \[data-publish-tag-add\]/);
  assert.match(baseCss, /#topBell\.has-priority-notification/);
  assert.match(componentsCss, /\.np-item\.priority/);
});

test("all runtime modules share the v141 cache identity", async () => {
  const [indexHtml, mainJs] = await Promise.all([
    read("index.html"),
    read("js/main.js"),
  ]);
  assert.match(indexHtml, /20260811-v1424-creative-reference-1/);
  assert.match(mainJs, /APP_BUILD_ID = "20260811-v1424-creative-reference-1"/);
  assert.doesNotMatch(indexHtml + mainJs, /20260729-v121-shell-22|20260729-v122-shell-1/);
});
