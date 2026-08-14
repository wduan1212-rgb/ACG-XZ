import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class FrontendPerformanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.remote = (APP_DIR / "js/core/remote.js").read_text(encoding="utf-8")
        cls.store = (APP_DIR / "js/core/store.js").read_text(encoding="utf-8")
        cls.main = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        cls.drafts = (APP_DIR / "js/views/draftsView.js").read_text(encoding="utf-8")
        cls.custom = (APP_DIR / "js/views/customCreation.js").read_text(encoding="utf-8")

    def test_login_bootstrap_excludes_heavy_collections_and_enters_before_hydration(self):
        self.assertIn(
            'REMOTE_BOOTSTRAP_COLLECTIONS = ["accounts", "products", "voicePresets"]',
            self.store,
        )
        bootstrap = self.store.split("export async function pullRemoteBootstrap()", 1)[1].split(
            "export function hydrateRemoteInBackground", 1
        )[0]
        self.assertIn("const bootstrapCollections = remoteBootstrapCollectionsForRole();", bootstrap)
        self.assertIn('remote.getState(["members", ...bootstrapCollections])', bootstrap)
        self.assertNotIn('remote.getState(["assets"', bootstrap)
        self.assertNotIn('remote.getState(["productions"', bootstrap)

        entry = self.main.split("async function enterRemote(member)", 1)[1].split(
            "function shakeCard()", 1
        )[0]
        self.assertLess(entry.index("enterMember(member);"), entry.index("continueRemoteHydration("))

    def test_supplier_enters_before_assets_and_delivery_uses_hydration_gate(self):
        self.assertIn(
            'REMOTE_SUPPLIER_BOOTSTRAP_COLLECTIONS = ["accounts", "products"]',
            self.store,
        )
        role_picker = self.store.split("export function remoteBootstrapCollectionsForRole", 1)[1].split(
            "function cloneRemoteRows", 1
        )[0]
        for role in ("supplier", "supplier_parent", "supplier_child"):
            self.assertIn(role, role_picker)
        self.assertIn("REMOTE_SUPPLIER_BOOTSTRAP_COLLECTIONS", role_picker)
        self.assertIn('if (zone === "assets" || zone === "delivery") return ["assets"]', self.main)
        self.assertIn('registerView("delivery", hydrationAwareView("delivery"', self.main)

    def test_deferred_state_is_split_and_old_unfiltered_server_is_consumed_once(self):
        self.assertIn('["sessions", "batches"]', self.store)
        self.assertIn('["productions"]', self.store)
        self.assertIn('["jobs"]', self.store)
        self.assertIn('["assets"]', self.store)
        self.assertIn('["analyticsLinks", "metricSnapshots", "insightReports", "creativeMemory"]', self.store)
        hydration = self.store.split("export function hydrateRemoteInBackground", 1)[1].split(
            "/* 登录后从服务端拉全量", 1
        )[0]
        self.assertIn("const serverReturnedExtra = returned.some", hydration)
        self.assertIn("const serverReturnedAllRemaining = remainingBeforeApply.every", hydration)
        self.assertIn("if (serverReturnedAllRemaining) break;", hydration)
        self.assertIn("await idleTurn();", self.store)
        self.assertIn("async function fetchRemoteStateGroup", self.store)
        self.assertIn("attempt <= 2", self.store)
        self.assertIn('emit("remote:hydration-error"', hydration)
        self.assertIn("本地空态不会回写服务器", self.main)
        self.assertIn('phase: "background"', hydration)
        self.assertIn('void cacheRemoteSnapshot(snap, applied, "background", isCurrent)', hydration)
        self.assertNotIn('await cacheRemoteSnapshot(snap, applied, "background", isCurrent)', hydration)

    def test_bootstrap_and_deferred_groups_cover_every_remote_collection(self):
        synced = {
            "accounts", "productions", "assets", "sessions", "batches", "jobs",
            "analyticsLinks", "metricSnapshots", "insightReports", "creativeMemory",
            "products", "voicePresets",
        }
        bootstrap = {"accounts", "products", "voicePresets"}
        deferred = {
            "productions", "sessions", "batches", "jobs", "assets",
            "analyticsLinks", "metricSnapshots", "insightReports", "creativeMemory",
        }
        self.assertEqual(bootstrap | deferred, synced)
        for name in synced:
            self.assertIn(f'"{name}"', self.remote)
            self.assertIn(f'"{name}"', self.store)

    def test_unhydrated_pages_show_retryable_sync_gate_not_false_empty_state(self):
        self.assertIn("export function remoteCollectionHydrationState", self.store)
        self.assertIn("export function retryRemoteHydration", self.store)
        self.assertIn("let keepContextForRetry = false;", self.store)
        self.assertIn("keepContextForRetry = true;", self.store)
        self.assertIn('data-remote-hydration-gate', self.main)
        self.assertIn("没有把未加载的数据伪装成空内容", self.main)
        self.assertIn("服务器数据没有被本地空状态覆盖", self.main)
        self.assertIn("data-remote-hydration-retry", self.main)
        for zone in ("overview", "agent", "studio", "assets", "drafts", "delivery", "analytics"):
            self.assertIn(f'registerView("{zone}", hydrationAwareView("{zone}"', self.main)

    def test_batch_workspace_opens_after_core_state_while_assets_continue_in_background(self):
        picker = self.main.split("function hydrationCollectionsForView", 1)[1].split(
            "function hydrationAwareView", 1
        )[0]
        self.assertIn(
            'if (zone === "agent") return ["productions", "sessions", "batches"]',
            picker,
        )
        self.assertNotIn(
            'if (zone === "agent") return ["productions", "sessions", "batches", "jobs", "assets"]',
            picker,
        )
        self.assertNotIn(
            'if (zone === "agent") return ["productions", "sessions", "batches", "jobs"]',
            picker,
        )
        self.assertIn('["assets"]', self.store)
        self.assertLess(
            self.store.index('["sessions", "batches"]'),
            self.store.index('["productions"]'),
        )
        self.assertLess(
            self.store.index('["productions"]'),
            self.store.index('["jobs"]'),
        )
        self.assertLess(
            self.store.index('["jobs"]'),
            self.store.index('["assets"]'),
        )

    def test_batch_resume_waits_for_cumulative_split_collections(self):
        hydration = self.main.split("function continueRemoteHydration", 1)[1].split(
            "/* 共享后端登录", 1
        )[0]
        self.assertIn("const batchCollectionsReady = new Set();", hydration)
        self.assertIn("collections.forEach(name => batchCollectionsReady.add(name));", hydration)
        self.assertIn(
            '["productions", "sessions", "batches", "jobs"].every(name => batchCollectionsReady.has(name))',
            hydration,
        )

    def test_batch_sessions_have_accessible_more_menu_and_visual_current_feedback(self):
        agent = (APP_DIR / "js/agent/view.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles/agent.css").read_text(encoding="utf-8")
        self.assertIn('data-session-menu-toggle="${s.id}"', agent)
        self.assertIn('aria-haspopup="menu"', agent)
        self.assertIn('aria-expanded="false"', agent)
        self.assertIn('role="menuitem" data-srename="${s.id}"', agent)
        self.assertIn('role="menuitem" class="is-danger" data-sdel="${s.id}"', agent)
        self.assertIn('aria-current="page"', agent)
        self.assertNotIn('agw-current-badge">当前', agent)
        self.assertIn('e.key === "Escape"', agent)
        self.assertIn('e.key === "ArrowDown"', agent)
        self.assertIn('.agw-sitem.is-menu-open .agw-session-menu', styles)
        self.assertIn("animation: batch-session-lightflow 3.4s ease-in-out infinite", styles)

        shell_styles = (APP_DIR / "styles/base.css").read_text(encoding="utf-8")
        shell_row = self.main.split("function batchSessionContextRow", 1)[1].split(
            "function workspaceCanvasProjectMenu", 1
        )[0]
        self.assertNotIn('tag: active ? "当前" : ""', shell_row)
        self.assertIn("wsctx-batch-session-shell", shell_row)
        self.assertIn('aria-current="page"', self.main)
        self.assertIn(
            ".wsctx-batch-session-shell .wsctx-row-more",
            shell_styles,
        )
        self.assertIn(
            ".wsctx-batch-session-shell .wsctx-row-more",
            styles,
        )

    def test_account_switch_cancels_old_hydration_and_guards_cache_writes(self):
        self.assertIn("let remoteSyncGeneration = 0;", self.store)
        self.assertIn("export function cancelRemoteHydration()", self.store)
        self.assertIn("generation === remoteSyncGeneration", self.store)
        self.assertIn("if (!isCurrent()) return false;", self.store)
        self.assertIn("cancelRemoteHydration();\n  remote.logout();", self.main)
        hydration = self.store.split("export function hydrateRemoteInBackground", 1)[1].split(
            "/* 登录后从服务端拉全量", 1
        )[0]
        self.assertIn("pushRemote: false", hydration)
        self.assertNotIn("pushRemote: true", hydration)

    def test_explicit_pull_remote_keeps_full_refresh_semantics(self):
        explicit = self.store.split("export async function pullRemote()", 1)[1].split(
            "/* ---- 通知中心", 1
        )[0]
        self.assertIn("snap = await remote.getState();", explicit)
        self.assertIn('cacheRemoteSnapshot(snap, applied, "explicit")', explicit)

    def test_state_query_and_metrics_do_not_capture_business_payload(self):
        self.assertIn("export function getState(collections = [])", self.remote)
        self.assertIn('?collections=${encodeURIComponent(names.join(","))}', self.remote)
        for metric in ('metric: "auth"', 'metric: "auth-resume"', 'metric: "state"'):
            self.assertIn(metric, self.remote)
        for field in ("ttfbMs", "bodyMs", "parseMs", "bodyChars"):
            self.assertIn(field, self.remote)
        self.assertIn("不记录用户名、token、请求体或业务数据", self.remote)
        self.assertIn('typeof CustomEvent === "function"', self.remote)
        metric_keys = self.remote.split("const PERFORMANCE_DETAIL_KEYS", 1)[1].split("]);", 1)[0]
        self.assertNotIn("token", metric_keys)
        self.assertNotIn("username", metric_keys)
        self.assertNotIn("itemCount", metric_keys)

    def test_startup_indexeddb_reads_are_parallel_and_measured(self):
        load = self.store.split("export async function loadAll()", 1)[1].split(
            "export function saveMembers", 1
        )[0]
        self.assertIn("await Promise.all([", load)
        self.assertIn("Promise.all(db.collections.map", load)
        self.assertIn('remote.recordPerformance("local-idb-load"', load)

    def test_server_startup_loads_only_identity_before_remote_detection(self):
        self.assertIn("export async function loadIdentityCache()", self.store)
        identity = self.store.split("export async function loadIdentityCache()", 1)[1].split(
            "export async function loadAll()", 1
        )[0]
        self.assertIn('db.metaGet("members")', identity)
        self.assertIn('db.metaGet("ui")', identity)
        self.assertIn('db.getAll("notifications")', identity)
        self.assertNotIn("db.collections.map", identity)
        self.assertIn('remote.recordPerformance("local-identity-load"', identity)
        boot = self.main.split("async function boot()", 1)[1].split("// Provider 状态只影响", 1)[0]
        self.assertLess(boot.index("await loadIdentityCache();"), boot.index("await remote.init();"))
        self.assertIn("if (!remote.isOn()) await loadAll();", boot)
        self.assertNotIn("await loadAll();\n    await remote.init();", boot)

    def test_hydration_never_forces_editor_or_subapp_remount(self):
        render_progress = self.main.split("function renderHydrationProgress()", 1)[1].split(
            "function hydrationCollectionsForView", 1
        )[0]
        self.assertIn('["overview", "assets", "drafts", "delivery", "analytics"]', render_progress)
        self.assertNotIn('"studio"', render_progress)
        self.assertNotIn('"agent"', render_progress)
        self.assertNotIn('"custom"', render_progress)

    def test_drafts_render_in_batches_and_images_are_lazy(self):
        self.assertIn("const DRAFT_RENDER_BATCH = 24;", self.drafts)
        self.assertIn("const visibleDrafts = drafts.slice(0, visibleLimit);", self.drafts)
        self.assertIn("visibleLimit += DRAFT_RENDER_BATCH;", self.drafts)
        self.assertIn('loading="lazy"', self.drafts)
        self.assertIn('decoding="async"', self.drafts)
        self.assertIn('fetchpriority="low"', self.drafts)

    def test_drafts_tolerate_partial_artifacts_from_background_jobs(self):
        self.assertIn("const artifacts = p?.artifacts || {};", self.drafts)
        self.assertIn("artifacts.images?.items", self.drafts)
        self.assertIn("artifacts.boards?.items", self.drafts)
        self.assertIn("artifacts.copy?.title", self.drafts)
        self.assertIn("p.artifacts?.copy?.title", self.drafts)
        self.assertIn('p.stage || "待处理"', self.drafts)

    def test_custom_tools_mount_only_when_activated(self):
        activate = self.custom.split("const activate = (nextPage, nextResourceId = null) =>", 1)[1].split(
            "root.querySelector(\"[data-custom-back]\")", 1
        )[0]
        self.assertIn("mountTool(next);", activate)
        self.assertNotIn('mountTool("video")', self.custom.split("root.__customCreationContext", 1)[0])
        self.assertNotIn('mountTool("canvas")', self.custom.split("root.__customCreationContext", 1)[0])


if __name__ == "__main__":
    unittest.main()
