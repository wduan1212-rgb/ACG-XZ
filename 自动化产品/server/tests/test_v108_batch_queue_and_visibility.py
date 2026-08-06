import asyncio
import importlib
import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
SERVER_DIR = APP_DIR / "server"
TEST_DIR = Path(__file__).resolve().parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))
if str(TEST_DIR) not in sys.path:
    sys.path.insert(0, str(TEST_DIR))

from test_store_tombstone import load_isolated_store


main = importlib.import_module("main")


class VideoTaskGateTest(unittest.IsolatedAsyncioTestCase):
    async def test_global_gate_is_fifo_and_never_exceeds_capacity(self):
        gate = main.VideoTaskGate(2, 300)
        first = await gate.acquire()
        second = await gate.acquire()
        third_waiter = asyncio.create_task(gate.acquire())
        fourth_waiter = asyncio.create_task(gate.acquire())
        await asyncio.sleep(0)

        self.assertEqual(await gate.snapshot(), {"active": 2, "limit": 2, "waiting": 2})
        self.assertFalse(third_waiter.done())
        self.assertFalse(fourth_waiter.done())

        await gate.release_token(first)
        third = await asyncio.wait_for(third_waiter, 1)
        self.assertFalse(fourth_waiter.done())
        self.assertEqual((await gate.snapshot())["active"], 2)

        await gate.release_token(second)
        fourth = await asyncio.wait_for(fourth_waiter, 1)
        self.assertEqual((await gate.snapshot())["active"], 2)
        await gate.release_token(third)
        await gate.release_token(fourth)

    async def test_cancelled_waiter_does_not_block_later_members(self):
        gate = main.VideoTaskGate(1, 300)
        first = await gate.acquire()
        cancelled = asyncio.create_task(gate.acquire())
        following = asyncio.create_task(gate.acquire())
        await asyncio.sleep(0)
        cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled
        await gate.release_token(first)
        token = await asyncio.wait_for(following, 1)
        self.assertTrue(token)
        await gate.release_token(token)


class CreatorDeliveryVisibilityTest(unittest.TestCase):
    def test_editor_sees_team_deliveries_and_only_referenced_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("assets", [{
                "id": "team-delivery",
                "ownerId": "creator-a",
                "byMemberId": "creator-a",
                "byMemberName": "创作者 A",
                "accountId": "account-a",
                "delivered": True,
                "coverAssetId": "team-cover",
                "packAssetIds": ["team-pack-image"],
                "type": "压缩包",
            }, {
                "id": "team-cover",
                "ownerId": "creator-a",
                "type": "图片",
            }, {
                "id": "team-pack-image",
                "ownerId": "creator-a",
                "type": "图片",
            }, {
                "id": "team-private-draft",
                "ownerId": "creator-a",
                "type": "图片",
            }])

            snapshot = store.state_for("creator-b", "editor")
            visible = {item["id"] for item in snapshot["assets"]}
            self.assertIn("team-delivery", visible)
            self.assertIn("team-cover", visible)
            self.assertIn("team-pack-image", visible)
            self.assertNotIn("team-private-draft", visible)


class BatchFrontendRegressionTest(unittest.TestCase):
    def run_node(self, source):
        result = subprocess.run(
            ["node", "--input-type=module", "-e", textwrap.dedent(source)],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_browser_queue_keeps_ten_digital_human_slots_with_fifo_overflow(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const { selectQueuedJobs } = await import("./js/api/jobs.js");
            const make = (id, model="") => ({ id, kind:"video", model, createdAt:Number(id.replace(/\\D/g, "")) || 0 });
            const info = Array.from({ length: 12 }, (_, i) => make(`i${i + 1}`));
            const digital = Array.from({ length: 12 }, (_, i) => make(`d${i + 1}`, "__digital_human__"));
            const mixed = selectQueuedJobs([], [...info.slice(0, 8), ...digital]);
            const digitalOnly = selectQueuedJobs([], digital);
            const withTwoInfo = selectQueuedJobs(info.slice(0, 2), digital);
            const withFourDigital = selectQueuedJobs(digital.slice(0, 4), digital.slice(4));
            console.log(JSON.stringify({
              mixed: mixed.map(x => x.id),
              digitalOnly: digitalOnly.map(x => x.id),
              withTwoInfo: withTwoInfo.map(x => x.id),
              withFourDigital: withFourDigital.map(x => x.id)
            }));
            """
        )
        self.assertEqual(result["mixed"], ["i1", "i2", "i3", *[f"d{i}" for i in range(1, 8)]])
        self.assertEqual(result["digitalOnly"], [f"d{i}" for i in range(1, 11)])
        self.assertEqual(result["withTwoInfo"], [f"d{i}" for i in range(1, 9)])
        self.assertEqual(result["withFourDigital"], [f"d{i}" for i in range(5, 11)])

    def test_digital_human_dispatch_uses_shared_ten_slot_queue_across_productions(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const { state } = await import("./js/core/store.js");
            const { createProduction } = await import("./js/domain/productions.js");
            const { createUnitVideoJobs } = await import("./js/agent/orchestrator.js");

            state.ui.currentMemberId = "creator-a";
            state.accounts = [
              { id:"digital-a", name:"数字人 A", mode:"视频", subType:"数字人", platform:"视频号", charBoardAssetId:"char-a" },
              { id:"digital-b", name:"数字人 B", mode:"视频", subType:"数字人", platform:"视频号", charBoardAssetId:"char-b" }
            ];
            state.assets = [
              { id:"char-a", ownerId:"creator-a", accountId:"digital-a", type:"图片", dataUrl:"data:image/png;base64,QQ==" },
              { id:"char-b", ownerId:"creator-a", accountId:"digital-b", type:"图片", dataUrl:"data:image/png;base64,Qg==" },
              { id:"audio-a", ownerId:"creator-a", accountId:"digital-a", type:"音频", dataUrl:"data:audio/wav;base64,QQ==" },
              { id:"audio-b", ownerId:"creator-a", accountId:"digital-b", type:"音频", dataUrl:"data:audio/wav;base64,Qg==" }
            ];
            state.productions = [];
            state.jobs = [];

            const makeDigital = (accountId, charId, audioId) => {
              const p = createProduction({ accountId, topic:`${accountId} 测试`, batchId:"batch-digital" });
              p.subType = "数字人";
              p.artifacts.boards.generationMode = "digitalHuman";
              p.artifacts.boards.characterRefAssetId = charId;
              p.artifacts.boards.digitalHuman = { segments:[{
                id:`${accountId}-seg-1`, characterRefAssetId:charId,
                audioAssetId:audioId, audioDuration:8,
                videoPrompt:"人物正脸自然口播，动作稳定。"
              }] };
              return p;
            };
            const first = makeDigital("digital-a", "char-a", "audio-a");
            const second = makeDigital("digital-b", "char-b", "audio-b");

            const firstQueued = createUnitVideoJobs(first);
            const secondQueued = createUnitVideoJobs(second);
            state.jobs[0].status = "succeeded";
            state.jobs[0].output = { url:"/api/video/composed/first.mp4" };
            const duplicateSecond = createUnitVideoJobs(second);

            console.log(JSON.stringify({
              firstQueued,
              secondQueued,
              duplicateSecond,
              jobs:state.jobs.map(job => ({ productionId:job.productionId, status:job.status }))
            }));
            """
        )
        self.assertEqual(result["firstQueued"], 1)
        self.assertEqual(result["secondQueued"], 1)
        self.assertEqual(result["duplicateSecond"], 0)
        self.assertEqual(len(result["jobs"]), 2)
        self.assertEqual(result["jobs"][0]["status"], "succeeded")
        self.assertNotEqual(result["jobs"][0]["productionId"], result["jobs"][1]["productionId"])

    def test_infoflow_and_digital_batch_compose_one_final_video(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
            const requests = [];
            globalThis.fetch = async (_url, options) => {
              requests.push(JSON.parse(options.body));
              return { ok:true, status:200, async json(){ return { ok:true, url:`/composed/final-${requests.length}.mp4`, name:`final-${requests.length}.mp4` }; } };
            };
            const { state } = await import("./js/core/store.js");
            const { composeBatchFinalVideo } = await import("./js/agent/orchestrator.js");
            state.jobs = [
              { id:"if-1", output:{ url:"/generated/if-1.mp4" }, duration:15 },
              { id:"if-2", output:{ url:"/generated/if-2.mp4" }, duration:15 },
              { id:"dh-1", output:{ url:"/generated/dh-1.mp4" }, duration:8 },
              { id:"dh-2", output:{ url:"/generated/dh-2.mp4" }, duration:9 }
            ];
            const info = { id:"p-info", mode:"视频", title:"信息流", artifacts:{
              timeline:[{ jobId:"if-1", dur:15 }, { jobId:"if-2", dur:15 }], subs:[]
            }};
            const digital = { id:"p-dh", mode:"视频", title:"数字人", artifacts:{
              timeline:[{ jobId:"dh-1", dur:8 }, { jobId:"dh-2", dur:9 }],
              subs:[{ start:0, end:3, text:"第一段口播" }, { start:8, end:11, text:"第二段口播" }],
              subStyle:{ size:15, stroke:1, bottom:22 }
            }};
            state.productions = [info, digital];
            const infoOk = await composeBatchFinalVideo(info);
            const digitalOk = await composeBatchFinalVideo(digital);
            console.log(JSON.stringify({ infoOk, digitalOk, requests, infoUrl:info.artifacts.finalVideoUrl, digitalUrl:digital.artifacts.finalVideoUrl }));
            """
        )
        self.assertTrue(result["infoOk"])
        self.assertTrue(result["digitalOk"])
        self.assertEqual(len(result["requests"][0]["clips"]), 2)
        self.assertEqual(result["requests"][0]["subtitles"], [])
        self.assertTrue(result["requests"][0]["preserveClipAudio"])
        self.assertEqual(len(result["requests"][1]["clips"]), 2)
        self.assertEqual(len(result["requests"][1]["subtitles"]), 2)
        self.assertEqual(result["requests"][1]["subtitleStyle"]["size"], 15)
        self.assertTrue(result["infoUrl"].endswith("final-1.mp4"))
        self.assertTrue(result["digitalUrl"].endswith("final-2.mp4"))

    def test_overview_delivery_default_and_new_video_session_contracts(self):
        overview = (APP_DIR / "js/views/overview.js").read_text(encoding="utf-8")
        delivery = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        supplier = (APP_DIR / "js/views/supplierViews.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles/views.css").read_text(encoding="utf-8")
        workshop = (APP_DIR / "apps/video-workshop/web/assets/app.js").read_text(encoding="utf-8")
        self.assertNotIn('data-overview-detail="published"><span>发布数量</span>', overview)
        self.assertIn('data-overview-detail="publishedPlatforms"', overview)
        self.assertIn('filterButton("week"', overview)
        self.assertIn('filterButton("day"', overview)
        self.assertIn('supFilters.publisher = currentMember()?.name || "all"', delivery)
        self.assertIn('["admin", "editor"].includes(state.role)', delivery)
        self.assertIn('state.members.find(member => member.id === memberId)?.name', delivery)
        self.assertIn('asset?.publishedUpdatedAt || asset?.publishedAt', delivery)
        self.assertIn('class="ovc-link"', overview)
        self.assertIn('target="_blank" rel="noopener noreferrer"', overview)
        self.assertIn('class="supplier-data-link"', supplier)
        self.assertIn('supplier-dashboard-grid', supplier)
        self.assertIn('overflow-wrap: anywhere', styles)
        self.assertIn("projectLoadEpoch", workshop)
        self.assertIn("dom.conversation.replaceChildren()", workshop)
        self.assertIn('dom.projectLabel.textContent = "新项目"', workshop)

    def test_batch_confirm_imports_account_group_and_keeps_setup_inside_error_boundary(self):
        view = (APP_DIR / "js/agent/view.js").read_text(encoding="utf-8")
        self.assertIn(
            'import { groupOf, isAvatarAsset } from "../domain/accounts.js";',
            view,
        )
        case_start = view.index('case "plan-confirm":')
        case_end = view.index('case "plan-cancel":', case_start)
        block = view[case_start:case_end]
        try_index = block.index("try {")
        normalize_index = block.index("m.payload.contentKind = normalizePlanKind")
        self.assertLess(try_index, normalize_index)
        self.assertIn("await new Promise(resolve => requestAnimationFrame(resolve));", block)
        self.assertNotIn("save(\"sessions\", \"meta\");\n          renderMsgs(true);", block)
        self.assertIn('throw new Error("没有成功创建批量内容任务")', block)


if __name__ == "__main__":
    unittest.main()
