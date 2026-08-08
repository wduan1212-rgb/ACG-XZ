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
            state.productions = [
              { id:"empty", ownerId:"creator-one", mode:"图文", stage:"images", stageStatus:"running", artifacts:{ images:{ items:[] } } },
              { id:"prompted", ownerId:"creator-one", mode:"图文", stage:"images", stageStatus:"running", artifacts:{ images:{ items:[{ prompt:"图卡提示词", assetId:null }] } } },
              { id:"complete", ownerId:"creator-one", mode:"图文", stage:"images", stageStatus:"running", artifacts:{ images:{ items:[{ prompt:"已完成", assetId:"asset-1" }] } } },
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
        self.assertIn('persistRecoveredDocuments("productions", p)', source)
        self.assertIn(
            "await persistBatchProductionCheckpoint(p);\n      await runBatchImagesToReview",
            source,
        )
        loading = source.index('it.status = "loading";')
        submit = source.index("const req = await provider.submit", loading)
        checkpoint = source.index("await persistBatchProductionCheckpoint(p);", loading)
        self.assertLess(checkpoint, submit)
        asset = source.index("it.assetId = a.id;", submit)
        completed = source.index("await persistBatchProductionCheckpoint(p);", asset)
        self.assertGreater(completed, asset)
        recovery = source.index("async function runBatchImagesToReview")
        review = source.index('setStage(p, "review", "pending");', recovery)
        terminal_checkpoint = source.index(
            "await persistBatchProductionCheckpoint(p);", review
        )
        self.assertGreater(terminal_checkpoint, review)
        self.assertIn("const settledImages = hydration.settle;", source)
        self.assertIn(
            "runPool(settledImages, async p => {\n        setStage(p, \"review\", \"pending\");",
            source,
        )


if __name__ == "__main__":
    unittest.main()
