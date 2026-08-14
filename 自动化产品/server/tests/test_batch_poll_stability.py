import json
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path
import sys


APP_DIR = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
if str(TEST_DIR) not in sys.path:
    sys.path.insert(0, str(TEST_DIR))

from test_store_tombstone import load_isolated_store


class BatchPollStabilityTest(unittest.TestCase):
    def run_node(self, source):
        result = subprocess.run(
            ["node", "--input-type=module", "-e", textwrap.dedent(source)],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_twelve_productions_and_one_hundred_polls_keep_rows_and_thumbnails(self):
        result = self.run_node(
            """
            const { boardStructureKey, patchBoardRow } = await import("./js/agent/boardRuntime.js");

            class Node {
              constructor(name, values={}) {
                this.name = name;
                this.className = values.className || "";
                this.textContent = values.textContent || "";
                this.title = values.title || "";
                this.attrs = { ...(values.attrs || {}) };
                this.map = new Map();
                this.lists = new Map();
                this.innerHTML = values.innerHTML || "";
                this.removed = false;
                this.firstChild = null;
              }
              querySelector(selector) { return this.map.get(selector) || null; }
              querySelectorAll(selector) { return this.lists.get(selector) || []; }
              getAttribute(key) { return this.attrs[key] || ""; }
              setAttribute(key, value) { this.attrs[key] = value; }
              cloneNode() { return new Node(this.name, { className:this.className, textContent:this.textContent, attrs:this.attrs }); }
              appendChild(node) { this.map.set(".mb-sub", node); }
              insertBefore(node) { this.map.set(".mb-preview", node); }
              remove() { this.removed = true; }
            }

            const build = progress => {
              const row = new Node("row", { className:"mb-row is-running" });
              const preview = new Node("preview");
              const img = new Node("img", { attrs:{ src:"/stable-cover.png", alt:"视频封面" } });
              preview.map.set("img", img);
              const type = new Node("type", { className:"mb-type mat", textContent:"素材" });
              const account = new Node("account", { textContent:"信息流账号" });
              const status = new Node("status", { className:"status-pill running", textContent:"生成中" });
              const title = new Node("title", { textContent:"稳定任务" });
              const dots = new Node("dots");
              const dotNodes = Array.from({ length:4 }, (_, i) => new Node("dot", { className:`mb-dot ${i === 2 ? "run" : "done"}`, title:`阶段${i}` }));
              const sub = new Node("sub", { className:"mb-sub", textContent:`渲染 0/4 · ${progress}%` });
              dots.lists.set(".mb-dot", dotNodes);
              dots.map.set(".mb-sub", sub);
              row.map.set(".mb-preview", preview);
              row.map.set(".mb-type", type);
              row.map.set(".mb-top > b", account);
              row.map.set(".status-pill", status);
              row.map.set(".mb-title", title);
              row.map.set(".mb-dots", dots);
              return { row, img };
            };

            const productions = Array.from({ length:12 }, (_, i) => `p${i + 1}`);
            const segmentJobs = productions.flatMap((productionId, index) =>
              Array.from({ length:index % 2 ? 4 : 3 }, (_, segment) => ({
                id:`${productionId}-s${segment + 1}`,
                productionId,
                status:index < 3 && segment < 3 ? "running" : "queued"
              }))
            );
            segmentJobs[10].status = "running";
            const groups = [{ id:"batch-heavy", productionIds:productions }];
            let key = "";
            let fullRenders = 0;
            let rowPatches = 0;
            const rows = productions.map(() => build(0));
            const rowIdentities = rows.map(item => item.row);
            const imageIdentities = rows.map(item => item.img);
            for (let poll = 0; poll < 100; poll++) {
              const nextKey = boardStructureKey(groups);
              if (nextKey !== key) { key = nextKey; fullRenders++; }
              rows.forEach(initial => {
                const fresh = build((poll + 1) % 100);
                patchBoardRow(initial.row, fresh.row);
                rowPatches++;
              });
            }
            console.log(JSON.stringify({
              fullRenders,
              rowPatches,
              productionCount:productions.length,
              segmentCount:segmentJobs.length,
              activeCount:segmentJobs.filter(job => job.status === "running").length,
              sameRows: rows.every((item, index) => item.row === rowIdentities[index]),
              sameImages: rows.every((item, index) => item.row.querySelector(".mb-preview").querySelector("img") === imageIdentities[index]),
              stableSources: imageIdentities.every(image => image.getAttribute("src") === "/stable-cover.png")
            }));
            """
        )
        self.assertEqual(result["fullRenders"], 1)
        self.assertEqual(result["rowPatches"], 1200)
        self.assertEqual(result["productionCount"], 12)
        self.assertEqual(result["segmentCount"], 42)
        self.assertEqual(result["activeCount"], 10)
        self.assertTrue(result["sameRows"])
        self.assertTrue(result["sameImages"])
        self.assertTrue(result["stableSources"])

    def test_infoflow_and_digital_human_share_incremental_queue_path(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin:"http://127.0.0.1:8787", hash:"" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const { selectQueuedJobs } = await import("./js/api/jobs.js");
            const make = (owner, type, index) => ({
              id:`${owner}-${type}-${index}`,
              ownerId:owner,
              kind:"video",
              model:type === "digital" ? "__digital_human__" : "",
              createdAt:index
            });
            const heavy = [
              ...Array.from({ length:40 }, (_, i) => make("heavy", "info", i + 1)),
              ...Array.from({ length:40 }, (_, i) => make("heavy", "digital", i + 41))
            ];
            const light = Array.from({ length:4 }, (_, i) => make("light", "info", i + 1));
            let heavyMax = 0;
            let digitalMax = 0;
            let standardMax = 0;
            let lightMax = 0;
            for (let poll = 0; poll < 100; poll++) {
              heavyMax = Math.max(heavyMax, selectQueuedJobs([], heavy).length);
              digitalMax = Math.max(digitalMax, selectQueuedJobs([], heavy.filter((job) => job.model === "__digital_human__")).length);
              standardMax = Math.max(standardMax, selectQueuedJobs([], heavy.filter((job) => job.model !== "__digital_human__")).length);
              lightMax = Math.max(lightMax, selectQueuedJobs([], light).length);
            }
            console.log(JSON.stringify({ heavyMax, digitalMax, standardMax, lightMax, lightUnaffected:light.length }));
            """
        )
        self.assertEqual(result["heavyMax"], 10)
        self.assertEqual(result["digitalMax"], 10)
        self.assertEqual(result["standardMax"], 3)
        self.assertEqual(result["lightMax"], 3)
        self.assertEqual(result["lightUnaffected"], 4)

    def test_heavy_member_jobs_do_not_enter_another_member_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            heavy_jobs = [{
                "id": f"heavy-{index}",
                "ownerId": "creator-heavy",
                "productionId": f"heavy-production-{index // 4}",
                "kind": "video",
                "status": "running" if index < 10 else "queued",
            } for index in range(48)]
            light_jobs = [{
                "id": f"light-{index}",
                "ownerId": "creator-light",
                "productionId": "light-production",
                "kind": "video",
                "status": "queued",
            } for index in range(4)]
            store.upsert_docs("productions", [{
                "id": f"heavy-production-{index}",
                "ownerId": "creator-heavy",
                "mode": "视频",
            } for index in range(12)] + [{
                "id": "light-production",
                "ownerId": "creator-light",
                "mode": "视频",
            }])
            store.upsert_docs("jobs", [*heavy_jobs, *light_jobs])
            heavy = store.state_for("creator-heavy", "editor", collections=["jobs"])["jobs"]
            light = store.state_for("creator-light", "editor", collections=["jobs"])["jobs"]
            self.assertEqual(len(heavy), 48)
            self.assertEqual(len(light), 4)
            self.assertTrue(all(item["ownerId"] == "creator-light" for item in light))

    def test_missing_batch_session_is_rebuilt_without_touching_tasks(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin:"http://127.0.0.1:8787", hash:"" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const { state } = await import("./js/core/store.js");
            const { restoreMissingBatchSessions } = await import("./js/agent/orchestrator.js");
            state.ui.currentMemberId = "creator-one";
            state.ui.activeSessionId = "missing-session";
            state.sessions = [{ id:"other-session", ownerId:"creator-two", title:"其他成员", messages:[] }];
            state.batches = [{
              id:"batch-preserved",
              sessionId:"missing-session",
              ownerId:"creator-one",
              topic:"刷新后恢复的批次",
              createdAt:100,
              updatedAt:200,
              phase:"generating",
              productionIds:["production-preserved"]
            }];
            state.productions = [{ id:"production-preserved", ownerId:"creator-one", stage:"images", stageStatus:"running" }];
            state.jobs = [{ id:"job-preserved", ownerId:"creator-one", productionId:"production-preserved", status:"running" }];
            const before = JSON.stringify({ batches:state.batches, productions:state.productions, jobs:state.jobs });
            const first = restoreMissingBatchSessions({ persist:false });
            const second = restoreMissingBatchSessions({ persist:false });
            const session = state.sessions.find(item => item.id === "missing-session");
            console.log(JSON.stringify({
              first:first.length,
              second:second.length,
              activeSessionId:state.ui.activeSessionId,
              title:session?.title,
              batchId:session?.messages?.[0]?.payload?.batchId,
              tasksUntouched:before === JSON.stringify({ batches:state.batches, productions:state.productions, jobs:state.jobs })
            }));
            """
        )
        self.assertEqual(result["first"], 1)
        self.assertEqual(result["second"], 0)
        self.assertEqual(result["activeSessionId"], "missing-session")
        self.assertEqual(result["title"], "刷新后恢复的批次")
        self.assertEqual(result["batchId"], "batch-preserved")
        self.assertTrue(result["tasksUntouched"])

    def test_recent_orphan_productions_rebuild_one_paused_batch_before_provider_resume(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin:"http://127.0.0.1:8787", hash:"" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const { state } = await import("./js/core/store.js");
            const { restoreMissingBatchesFromProductions, restoreMissingBatchSessions } = await import("./js/agent/orchestrator.js");
            const now = Date.now();
            state.ui.currentMemberId = "creator-one";
            state.ui.activeSessionId = null;
            state.sessions = [];
            state.batches = [];
            state.productions = [{
              id:"orphan-a", batchId:"missing-batch", ownerId:"creator-one", accountId:"account-a",
              mode:"图文", stage:"images", stageStatus:"pending", title:"保留的任务板",
              createdAt:now - 2000, updatedAt:now - 1000, batchItemIndex:1,
              artifacts:{ script:{ productId:"dumate", imageCount:3 }, images:{ items:[
                { prompt:"a", assetId:"asset-a", status:"done" },
                { prompt:"b", assetId:null, status:"pending" },
                { prompt:"c", assetId:null, status:"idle" }
              ] } }
            }, {
              id:"orphan-b", batchId:"missing-batch", ownerId:"creator-one", accountId:"account-b",
              mode:"图文", stage:"images", stageStatus:"pending", title:"第二条",
              createdAt:now - 1900, updatedAt:now - 900, batchItemIndex:1,
              artifacts:{ script:{ productId:"dumate", imageCount:3 }, images:{ items:[] } }
            }, {
              id:"other-owner", batchId:"foreign-batch", ownerId:"creator-two", accountId:"account-x",
              mode:"图文", stage:"images", stageStatus:"pending", createdAt:now, updatedAt:now, artifacts:{}
            }, {
              id:"delivered-orphan", batchId:"delivered-batch", ownerId:"creator-one", accountId:"account-a",
              mode:"图文", stage:"delivered", stageStatus:"done", createdAt:now, updatedAt:now, artifacts:{}
            }];
            const first = restoreMissingBatchesFromProductions({ persist:false });
            const second = restoreMissingBatchesFromProductions({ persist:false });
            const batch = state.batches.find(item => item.id === "missing-batch");
            const sessions = restoreMissingBatchSessions({ persist:false });
            console.log(JSON.stringify({
              first:first.length,
              second:second.length,
              batch,
              session:sessions[0],
              foreign:Boolean(state.batches.find(item => item.id === "foreign-batch")),
              delivered:Boolean(state.batches.find(item => item.id === "delivered-batch"))
            }));
            """
        )
        self.assertEqual(result["first"], 1)
        self.assertEqual(result["second"], 0)
        self.assertEqual(result["batch"]["productionIds"], ["orphan-a", "orphan-b"])
        self.assertEqual(result["batch"]["accountIds"], ["account-a", "account-b"])
        self.assertEqual(result["batch"]["imageCount"], 3)
        self.assertEqual(result["batch"]["phase"], "generating")
        self.assertEqual(result["session"]["messages"][0]["payload"]["batchId"], "missing-batch")
        self.assertFalse(result["foreign"])
        self.assertFalse(result["delivered"])

    def test_deleted_batch_session_marker_is_never_rebuilt(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin:"http://127.0.0.1:8787", hash:"" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const { state } = await import("./js/core/store.js");
            const { restoreMissingBatchSessions } = await import("./js/agent/orchestrator.js");
            state.ui.currentMemberId = "creator-one";
            state.ui.activeSessionId = null;
            state.sessions = [];
            state.batches = [{
              id:"batch-kept", sessionId:"", archivedSessionId:"deleted-session",
              sessionDeletedAt:500, ownerId:"creator-one", productionIds:["production-kept"]
            }];
            const recovered = restoreMissingBatchSessions({ persist:false });
            console.log(JSON.stringify({ recovered:recovered.length, sessions:state.sessions.length, batch:state.batches[0] }));
            """
        )
        self.assertEqual(result["recovered"], 0)
        self.assertEqual(result["sessions"], 0)
        self.assertEqual(result["batch"]["archivedSessionId"], "deleted-session")

    def test_refresh_classifies_empty_image_shell_for_redraft_and_restores_thinking(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin:"http://127.0.0.1:8787", hash:"" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const { state } = await import("./js/core/store.js");
            const { classifyHydratedBatchRecovery, hydratedBatchThinkingState } = await import("./js/agent/orchestrator.js");
            state.ui.currentMemberId = "creator-one";
            state.ui.activeSessionId = "session-refresh";
            state.sessions = [{ id:"session-refresh", ownerId:"creator-one", messages:[] }];
            state.batches = [{
              id:"batch-refresh", sessionId:"session-refresh", ownerId:"creator-one",
              phase:"generating", createdAt:Date.now(),
              productionIds:["empty", "prompted", "complete", "provider"]
            }, {
              id:"batch-history", sessionId:"session-refresh", ownerId:"creator-one",
              phase:"review", createdAt:Date.now() - 60_000,
              productionIds:["history-review", "history-failed"]
            }];
            state.assets = [{
              id:"asset-1", accountId:"account-one", type:"图片", delivered:false, fileMissing:false
            }];
            state.productions = [
              { id:"empty", accountId:"account-one", ownerId:"creator-one", mode:"图文", stage:"images", stageStatus:"running", artifacts:{ images:{ items:[] } } },
              { id:"prompted", accountId:"account-one", ownerId:"creator-one", mode:"图文", stage:"images", stageStatus:"running", artifacts:{ images:{ items:[{ prompt:"图卡提示词", assetId:null }] } } },
              { id:"complete", accountId:"account-one", ownerId:"creator-one", mode:"图文", stage:"images", stageStatus:"running", artifacts:{ images:{ items:[{ prompt:"已完成", assetId:"asset-1" }] } } },
              { id:"provider", ownerId:"creator-one", mode:"视频", stage:"workshop", stageStatus:"running", artifacts:{} },
              { id:"stale", ownerId:"creator-one", mode:"图文", stage:"images", stageStatus:"running", artifacts:{ images:{ items:[] } } },
              { id:"history-review", ownerId:"creator-one", mode:"图文", stage:"review", stageStatus:"pending", artifacts:{} },
              { id:"history-failed", ownerId:"creator-one", mode:"图文", stage:"script", stageStatus:"failed", artifacts:{} },
            ];
            state.jobs = [{ id:"job-provider", productionId:"provider", status:"submitted", providerRef:"remote-task" }];
            const batch = state.batches[0];
            const classified = classifyHydratedBatchRecovery(batch);
            const stale = classifyHydratedBatchRecovery({
              id:"batch-stale", createdAt:Date.now() - 7 * 60 * 60 * 1000,
              productionIds:["stale"]
            });
            const thinking = hydratedBatchThinkingState("session-refresh");
            console.log(JSON.stringify({
              draft:classified.draft.map(item => item.id),
              images:classified.images.map(item => item.id),
              settle:classified.settle.map(item => item.id),
              waiting:classified.waiting.map(item => item.id),
              stale:stale.stale.map(item => item.id),
              thinking,
            }));
            """
        )
        self.assertEqual(result["draft"], ["empty"])
        self.assertEqual(result["images"], ["prompted"])
        self.assertEqual(result["settle"], ["complete"])
        self.assertEqual(result["waiting"], ["provider"])
        self.assertEqual(result["stale"], ["stale"])
        self.assertTrue(result["thinking"]["active"])
        self.assertIn("刷新后正在接续起草", result["thinking"]["step"])
        self.assertEqual(result["thinking"]["total"], 4)
        self.assertEqual(result["thinking"]["batchIds"], ["batch-refresh"])

    def test_batch_media_validation_rejects_cross_account_assets_before_publish(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin:"http://127.0.0.1:8787", hash:"" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const { state } = await import("./js/core/store.js");
            const { productionImageAssetIssues } = await import("./js/domain/delivery.js");
            state.assets = [
              { id:"asset-right", accountId:"account-a", type:"图片", delivered:false, fileMissing:false },
              { id:"asset-other", accountId:"account-b", type:"图片", delivered:false, fileMissing:false },
            ];
            const base = { mode:"图文", accountId:"account-a", artifacts:{ images:{ items:[] } } };
            const valid = productionImageAssetIssues({
              ...base, artifacts:{ images:{ items:[{ assetId:"asset-right" }] } }
            });
            const invalid = productionImageAssetIssues({
              ...base, artifacts:{ images:{ items:[{ assetId:"asset-right" }, { assetId:"asset-other" }] } }
            });
            console.log(JSON.stringify({ valid, invalid }));
            """
        )
        self.assertEqual(result["valid"], [])
        self.assertEqual(result["invalid"], [
            {"index": 1, "assetId": "asset-other", "reason": "wrong-account"}
        ])

    def test_batch_hydration_waits_for_assets_without_redrafting_completed_images(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin:"http://127.0.0.1:8787", hash:"" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const { state } = await import("./js/core/store.js");
            const { classifyHydratedBatchRecovery } = await import("./js/agent/orchestrator.js");
            state.assets = [];
            state.productions = [{
              id:"complete-before-assets", accountId:"account-a", mode:"图文",
              stage:"images", stageStatus:"running",
              artifacts:{ images:{ items:[{ prompt:"已生成", assetId:"asset-later" }] } }
            }];
            const batch = { id:"batch", createdAt:Date.now(), productionIds:["complete-before-assets"] };
            const before = classifyHydratedBatchRecovery(batch);
            state.assets = [{
              id:"asset-later", accountId:"account-b", type:"图片", delivered:false, fileMissing:false
            }];
            const after = classifyHydratedBatchRecovery(batch);
            console.log(JSON.stringify({
              beforeSettle:before.settle.map(item => item.id),
              beforeDraft:before.draft.map(item => item.id),
              afterInvalid:after.invalid.map(item => item.id),
            }));
            """
        )
        self.assertEqual(result["beforeSettle"], ["complete-before-assets"])
        self.assertEqual(result["beforeDraft"], [])
        self.assertEqual(result["afterInvalid"], ["complete-before-assets"])

    def test_batch_generated_assets_are_unique_and_hash_dedup_is_account_scoped(self):
        assets = (APP_DIR / "js/domain/assets.js").read_text(encoding="utf-8")
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        server_store = (APP_DIR / "server/store.py").read_text(encoding="utf-8")
        self.assertIn('String(a.accountId || "") === String(accountId || "")', assets)
        self.assertIn("assetName: `站内笔记图${String(i + 1).padStart", orchestrator)
        self.assertIn('f"{owner}:{request[\'jobId\']}:asset"', server_store)
        self.assertIn('canonical_asset["accountId"] = str(item.get("accountId")', server_store)

    def test_polling_sources_do_not_full_save_or_full_render(self):
        jobs = (APP_DIR / "js/api/jobs.js").read_text(encoding="utf-8")
        view = (APP_DIR / "js/agent/view.js").read_text(encoding="utf-8")
        store = (APP_DIR / "js/core/store.js").read_text(encoding="utf-8")
        remote = (APP_DIR / "js/core/remote.js").read_text(encoding="utf-8")
        self.assertNotIn('save("jobs")', jobs)
        self.assertNotIn('save("productions")', jobs)
        self.assertIn('saveIncremental("jobs", job)', jobs)
        self.assertIn('saveIncremental("productions", production)', jobs)
        self.assertIn('on("job:update", job => schedule({ productionId:', view)
        self.assertIn("patchBoardRow(row, freshBoardRow(production))", view)
        self.assertIn("putMany(collection, items)", store)
        self.assertIn("remote.putDocuments(collection, items)", store)
        self.assertIn("return putCollection(name, items);", remote)

    def test_batch_image_recovery_persists_plan_and_each_output_before_continuing(self):
        source = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        jobs = (APP_DIR / "js/api/batchImageJobs.js").read_text(encoding="utf-8")
        server = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        self.assertIn('persistRecoveredDocuments("productions", p)', source)
        planner = source.index("async function planAndPersistBatchImageCards")
        card_call = source.index("const result = await AI.generateImagePromptCard", planner)
        before_card = source.rindex("await persistBatchProductionCheckpoint(p);", planner, card_call)
        after_card = source.index("await persistBatchProductionCheckpoint(p);", card_call)
        self.assertLess(before_card, card_call)
        self.assertGreater(after_card, card_call)
        queued = source.index('it.status = "queued";')
        checkpoint = source.index("await persistBatchProductionCheckpoint(p);", queued)
        registration = source.index("await registerBatchImageJobs(jobs);", checkpoint)
        polling = source.index("await Promise.all(jobs.map", registration)
        self.assertLess(checkpoint, registration)
        self.assertLess(registration, polling)
        self.assertIn("waitForBatchImageJob", jobs)
        self.assertNotIn("/api/image/generate", jobs)
        self.assertIn("store.finish_batch_image_generation_job", server)
        recovery = source.index("async function runBatchImagesToReview")
        review = source.index('setStage(p, "review", "pending");', recovery)
        terminal_checkpoint = source.index(
            "await persistBatchProductionCheckpoint(p);", review
        )
        self.assertGreater(terminal_checkpoint, review)
        self.assertIn("const settledImages = hydration.settle;", source)
        self.assertIn(
            "runPool(settledImages, async p => {\n        clearCompletedBatchImageErrors(p);\n        setStage(p, \"review\", \"pending\");",
            source,
        )

    def test_generation_timeout_contracts_and_retry_topologies(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin:"http://127.0.0.1:8787", hash:"" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const { effectiveLlmTimeoutMs } = await import("./js/api/llm.js");
            const { IMAGE_GENERATION_TIMEOUT_MS } = await import("./js/api/providers.js");
            const { RECOVERY_SYNC_TIMEOUT_MS } = await import("./js/core/remote.js");
            const { batchImageRetryAction } = await import("./js/agent/orchestrator.js");
            console.log(JSON.stringify({
              llm45:effectiveLlmTimeoutMs(true, 45000),
              llm90:effectiveLlmTimeoutMs(true, 90000),
              direct45:effectiveLlmTimeoutMs(false, 45000),
              image:IMAGE_GENERATION_TIMEOUT_MS,
              checkpoint:RECOVERY_SYNC_TIMEOUT_MS,
              resume:batchImageRetryAction([
                {assetId:"asset-1",prompt:"完成"},
                {assetId:"asset-2",prompt:"完成"},
                {assetId:null,prompt:"缺失图片"}
              ]),
              redraft:batchImageRetryAction([]),
              confirm:batchImageRetryAction([{assetId:null,prompt:"不可盲重试",status:"confirming"}]),
            }));
            """
        )
        self.assertEqual(result["llm45"], 270000)
        self.assertEqual(result["llm90"], 270000)
        self.assertEqual(result["direct45"], 45000)
        self.assertGreater(result["image"], 240000)
        self.assertEqual(result["checkpoint"], 20000)
        self.assertEqual(result["resume"], "resume")
        self.assertEqual(result["redraft"], "redraft")
        self.assertEqual(result["confirm"], "confirm")

    def test_partial_image_settlement_keeps_account_retryable_without_red_failure(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin:"http://127.0.0.1:8787", hash:"" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const { state } = await import("./js/core/store.js");
            const { batchImageSettlement, batchImageRetryAction, classifyHydratedBatchRecovery } = await import("./js/agent/orchestrator.js");
            const { statusPill } = await import("./js/domain/productions.js");
            state.assets = [
              { id:"a1", accountId:"account-a", type:"图片", delivered:false, fileMissing:false },
              { id:"a4", accountId:"account-a", type:"图片", delivered:false, fileMissing:false },
            ];
            const production = {
              id:"partial", mode:"图文", accountId:"account-a", stage:"images", stageStatus:"pending",
              artifacts:{ images:{ recovery:{ status:"result-confirming" }, items:[
                { assetId:"a1", prompt:"第一张", status:"done" },
                { assetId:null, prompt:"第二张", status:"confirming" },
                { assetId:null, prompt:"第三张", status:"failed" },
                { assetId:"a4", prompt:"第四张", status:"done" },
              ] } }
            };
            const settlement = batchImageSettlement(production);
            state.productions = [production];
            const hydrated = classifyHydratedBatchRecovery({ id:"batch", createdAt:Date.now(), productionIds:[production.id] });
            console.log(JSON.stringify({
              settlement,
              retryAction:batchImageRetryAction(production.artifacts.images.items),
              pill:statusPill(production),
              attention:hydrated.attention.map(item => item.id),
              waiting:hydrated.waiting.map(item => item.id),
            }));
            """
        )
        self.assertFalse(result["settlement"]["complete"])
        self.assertEqual(result["settlement"]["confirmingIndexes"], [1])
        self.assertEqual(result["settlement"]["failedIndexes"], [2])
        self.assertEqual(result["retryAction"], "confirm")
        self.assertEqual(result["pill"], ["结果待确认", "need-input"])
        self.assertEqual(result["attention"], ["partial"])
        self.assertEqual(result["waiting"], [])

    def test_unknown_image_outcome_is_not_terminal_failure_or_duplicate_submit(self):
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        jobs = (APP_DIR / "js/api/batchImageJobs.js").read_text(encoding="utf-8")
        server = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        self.assertIn('item.status = "confirming";', orchestrator)
        self.assertIn("clientJobId: operationKey", orchestrator)
        self.assertIn('batchImageRetryAction(imageItems)', orchestrator)
        self.assertIn('retryAction === "confirm"', orchestrator)
        self.assertIn('"IMAGE_PROVIDER_RESULT_UNKNOWN"', server)
        self.assertIn('status="confirming" if confirming else "failed"', server)
        self.assertNotIn("crypto.subtle", jobs)
        self.assertNotIn("requestFingerprint", jobs)
        self.assertIn("waitForBatchImageJob", jobs)
        self.assertIn('status: generated?.confirmingIndexes?.length ? "result-confirming" : "missing-images"', orchestrator)
        self.assertIn('if (!it.assetId && it.status === "confirming")', orchestrator)
        self.assertIn('prepareExplicitBatchImageRetry(p)', orchestrator)
        self.assertIn('RESETTABLE_BATCH_MEDIA_ISSUES.has(issue.reason)', orchestrator)
        cards = (APP_DIR / "js/agent/cards.js").read_text(encoding="utf-8")
        self.assertIn("重试缺失图片", cards)

    def test_batch_registration_works_without_secure_context_webcrypto(self):
        result = self.run_node(
            """
            Object.defineProperty(globalThis, "crypto", { value:{}, configurable:true });
            globalThis.localStorage = { getItem(){ return "test-token"; }, setItem(){}, removeItem(){} };
            let request = null;
            globalThis.fetch = async (path, options) => {
              request = { path, options, body:JSON.parse(options.body) };
              return { ok:true, status:200, async json(){ return { ok:true, jobs:[{ status:"queued" }] }; } };
            };
            const { registerBatchImageJobs } = await import("./js/api/batchImageJobs.js");
            const response = await registerBatchImageJobs([{
              clientJobId:"job-one", productionId:"production-one", accountId:"account-one",
              itemIndex:0, operationKey:"operation-one", prompt:"真实提交", refs:[], ratio:"3:4",
              assetName:"结果一"
            }]);
            console.log(JSON.stringify({
              status:response.jobs[0].status,
              path:request.path,
              hasFingerprint:Object.hasOwn(request.body.jobs[0], "requestFingerprint"),
              prompt:request.body.jobs[0].prompt,
            }));
            """
        )
        self.assertEqual(result["status"], "queued")
        self.assertEqual(result["path"], "/api/batch-image/generation-jobs")
        self.assertFalse(result["hasFingerprint"])
        self.assertEqual(result["prompt"], "真实提交")

    def test_explicit_failed_image_retry_reaches_durable_registration_and_settles(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return ""; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin:"http://192.0.2.1:8787", hash:"" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            let registered = [];
            globalThis.fetch = async (path, options = {}) => {
              if (path === "/api/batch-image/generation-jobs" && options.method === "POST") {
                registered.push(...JSON.parse(options.body).jobs);
                return { ok:true, status:200, async json(){ return { ok:true, jobs:[] }; } };
              }
              if (String(path).startsWith("/api/batch-image/generation-jobs/")) {
                const jobId = decodeURIComponent(String(path).split("/").pop());
                return { ok:true, status:200, async json(){ return { job:{
                  jobId, operationKey:jobId, status:"succeeded", updatedAt:Date.now(),
                  asset:{ id:"asset-retried", type:"图片", accountId:"account-one", name:"重试成图" }
                } }; } };
              }
              return { ok:true, status:200, async json(){ return {}; }, async text(){ return "{}"; } };
            };
            const { state } = await import("./js/core/store.js");
            const { retryFailedIn } = await import("./js/agent/orchestrator.js");
            state.apiKeys = [{ type:"image", provider:"https://example.invalid/v1", secret:"test-only" }];
            state.accounts = [{ id:"account-one", name:"测试账号", mode:"图文", platform:"小红书" }];
            state.assets = [{ id:"asset-existing", type:"图片", accountId:"account-one", name:"已成功图" }];
            const production = {
              id:"production-one", batchId:"batch-one", accountId:"account-one", mode:"图文",
              stage:"images", stageStatus:"failed", error:"上次生成失败", title:"重试验证",
              artifacts:{ copy:{ title:"重试验证", body:"正文已就绪" }, images:{ items:[
                { prompt:"重试这一张", status:"failed", error:"旧错误", generationRevision:0 },
                { prompt:"保留这一张", status:"done", assetId:"asset-existing" },
              ] } }, review:{ state:"pending" },
            };
            const batch = { id:"batch-one", topic:"重试测试", phase:"review", productionIds:[production.id], accountIds:["account-one"] };
            state.productions = [production];
            state.batches = [batch];
            const accepted = retryFailedIn(batch);
            const deadline = Date.now() + 3000;
            while (production.stage !== "review" && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            console.log(JSON.stringify({
              accepted,
              registrations:registered.length,
              clientJobId:registered[0]?.clientJobId || "",
              submittedIndexes:registered.map(job => job.itemIndex),
              assetIds:production.artifacts.images.items.map(item => item.assetId || ""),
              stage:production.stage,
              stageStatus:production.stageStatus,
              error:production.error || "",
            }));
            """
        )
        self.assertEqual(result["accepted"], 1)
        self.assertEqual(result["registrations"], 1)
        self.assertIn("revision-1", result["clientJobId"])
        self.assertEqual(result["submittedIndexes"], [0])
        self.assertEqual(result["assetIds"], ["asset-retried", "asset-existing"])
        self.assertEqual(result["stage"], "review")
        self.assertEqual(result["stageStatus"], "pending")
        self.assertEqual(result["error"], "")

    def test_running_image_workshop_completion_advances_directly_to_review(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin:"http://127.0.0.1:8787", hash:"" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const { maybeAdvanceAfterInput } = await import("./js/agent/orchestrator.js");
            const production = {
              id:"micro-adjusted", mode:"图文", stage:"images", stageStatus:"running",
              artifacts:{ copy:{ title:"标题", body:"正文" }, images:{ items:[
                { assetId:"asset-one", status:"done" },
                { assetId:"asset-two", status:"done" },
              ] } },
            };
            const advanced = maybeAdvanceAfterInput(production);
            console.log(JSON.stringify({ advanced, stage:production.stage, stageStatus:production.stageStatus }));
            """
        )
        self.assertTrue(result["advanced"])
        self.assertEqual(result["stage"], "review")
        self.assertEqual(result["stageStatus"], "pending")

    def test_batch_and_refinement_share_one_durable_completion_settlement(self):
        source = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        helper = source.index("async function persistBatchImageSettlement")
        regenerate = source.index("export async function regenerateBatchImage")
        runner = source.index("async function runBatchImagesToReview")
        self.assertGreater(source.index("await persistBatchImageSettlement(p, generated);", regenerate), regenerate)
        self.assertGreater(source.index("return await persistBatchImageSettlement(p, generated);", runner), runner)
        self.assertIn('setStage(p, "review", "pending");', source[helper:regenerate])

        boards = (APP_DIR / "js/views/chainBoards.js").read_text(encoding="utf-8")
        drawer = (APP_DIR / "js/views/prodDrawer.js").read_text(encoding="utf-8")
        self.assertNotIn('complete && ["failed", "pending"].includes(p.stageStatus)', boards)
        self.assertNotIn('complete && ["failed", "pending"].includes(p.stageStatus)', drawer)

    def test_review_transition_clears_stale_production_and_item_errors(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin:"http://127.0.0.1:8787", hash:"" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){} };
            const { setStage } = await import("./js/domain/productions.js");
            const production = { id:"p", stage:"images", stageStatus:"failed", error:"old timeout" };
            setStage(production, "review", "pending");
            console.log(JSON.stringify(production));
            """
        )
        self.assertEqual(result["stage"], "review")
        self.assertEqual(result["stageStatus"], "pending")
        self.assertIsNone(result["error"])


if __name__ == "__main__":
    unittest.main()
