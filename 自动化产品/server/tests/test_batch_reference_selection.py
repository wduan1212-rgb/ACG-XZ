import json
import subprocess
import textwrap
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class BatchReferenceSelectionTest(unittest.TestCase):
    def run_node(self, source):
        result = subprocess.run(
            ["node", "--input-type=module", "-e", textwrap.dedent(source)],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_new_plans_are_empty_and_batch_keeps_an_independent_reference_snapshot(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };

            const { state } = await import("./js/core/store.js");
            const {
              defaultPlan, createBatch, prunePlanReferences
            } = await import("./js/agent/orchestrator.js");

            state.accounts = [
              { id: "image-a", name: "图文号", mode: "图文", subType: "", group: "图文组" },
              { id: "image-b", name: "另一个图文号", mode: "图文", subType: "", group: "图文组" },
              { id: "video-a", name: "素材号", mode: "视频", subType: "无数字人", group: "素材" }
            ];
            state.batches = [];
            state.ui.currentMemberId = "tester";

            const oldPlan = defaultPlan("旧计划");
            oldPlan.accountIds = ["image-a"];
            oldPlan.sharedRefAssetIds = ["shared-current"];
            oldPlan.sharedRefAssetId = "shared-current";
            oldPlan.accountRefAssetIds = {
              "image-a": ["custom-current"],
              "image-b": ["custom-from-removed-account"]
            };
            prunePlanReferences(oldPlan);
            const batch = createBatch(oldPlan, "session-a");

            oldPlan.sharedRefAssetIds.push("mutated-after-start");
            oldPlan.accountRefAssetIds["image-a"].push("mutated-custom-after-start");

            const freshPlan = defaultPlan("新计划");
            const videoPlan = defaultPlan("视频计划");
            videoPlan.contentKind = "material";
            videoPlan.group = "素材";
            videoPlan.accountIds = ["video-a"];
            videoPlan.sharedRefAssetIds = ["stale-image-ref"];
            videoPlan.coverRefAssetIds = ["current-video-ref"];
            videoPlan.accountRefAssetIds = {
              "image-a": ["stale-other-account-ref"],
              "video-a": ["current-video-custom-ref"]
            };
            prunePlanReferences(videoPlan);

            console.log(JSON.stringify({
              fresh: {
                selectionId: freshPlan.referenceSelectionId,
                shared: freshPlan.sharedRefAssetIds,
                cover: freshPlan.coverRefAssetIds,
                custom: freshPlan.accountRefAssetIds
              },
              selectionIdsDiffer: freshPlan.referenceSelectionId !== oldPlan.referenceSelectionId,
              batch: {
                shared: batch.sharedRefAssetIds,
                custom: batch.accountRefAssetIds
              },
              video: {
                shared: videoPlan.sharedRefAssetIds,
                cover: videoPlan.coverRefAssetIds,
                custom: videoPlan.accountRefAssetIds
              }
            }));
            """
        )
        self.assertTrue(result["fresh"]["selectionId"])
        self.assertEqual(result["fresh"]["shared"], [])
        self.assertEqual(result["fresh"]["cover"], [])
        self.assertEqual(result["fresh"]["custom"], {})
        self.assertTrue(result["selectionIdsDiffer"])
        self.assertEqual(result["batch"]["shared"], ["shared-current"])
        self.assertEqual(result["batch"]["custom"], {"image-a": ["custom-current"]})
        self.assertEqual(result["video"]["shared"], [])
        self.assertEqual(result["video"]["cover"], ["current-video-ref"])
        self.assertEqual(result["video"]["custom"], {"video-a": ["current-video-custom-ref"]})

    def test_legacy_aggregate_refs_are_not_silently_reused_by_image_refine(self):
        drawer = (APP_DIR / "js/views/prodDrawer.js").read_text(encoding="utf-8")
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")

        self.assertIn('const hasItemReferences = Object.prototype.hasOwnProperty.call(item, "refAssetIds")', drawer)
        self.assertIn("检测到历史任务级引用，但不会自动带入本次微调", drawer)
        self.assertIn("let refIds = [...new Set((hasItemReferences ? item.refAssetIds : [])", drawer)
        self.assertNotIn(
            '? item.refAssetIds\n    : imageArtifacts.usedRefAssetIds || imageArtifacts.usedSharedRefAssetIds || []',
            drawer,
        )
        self.assertIn('it.referenceSource = "batch-plan"', orchestrator)
        self.assertIn("it.referenceSelectionId = batch.referenceSelectionId", orchestrator)

    def test_only_digital_role_board_remains_as_long_term_image_reference(self):
        cards = (APP_DIR / "js/agent/cards.js").read_text(encoding="utf-8")
        view = (APP_DIR / "js/agent/view.js").read_text(encoding="utf-8")
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")

        self.assertNotIn("账号长期风格图", cards)
        self.assertNotIn("账号长期角色图", cards)
        self.assertIn("数字人角色版", cards)
        self.assertIn("锁定角色身份", cards)
        self.assertIn("prunePlanReferences(m.payload)", view)
        self.assertNotIn("accountDefaultRefIds", orchestrator)
        self.assertNotIn("if (!A.omniRefAssetIds.length && !p.batchId)", orchestrator)
        self.assertIn("!p.batchId ? A.sharedRefAssetId : null", orchestrator)

    def test_creator_reference_delete_ui_matches_protected_asset_semantics(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };

            const { state } = await import("./js/core/store.js");
            const { canDeleteReferenceAsset } = await import("./js/domain/assets.js");
            state.role = "editor";
            state.ui.currentMemberId = "creator-b";
            state.accounts = [{
              id: "digital-a", mode: "视频", subType: "数字人",
              charBoardAssetId: "role-board", imageStyleAssetId: "legacy-style"
            }];
            state.assets = [
              { id: "own-ref", ownerId: "creator-b", type: "图片", tags: [] },
              { id: "legacy-style", ownerId: "admin-a", type: "图片", tags: ["旧风格参考"] },
              { id: "role-board", ownerId: "admin-a", type: "图片", tags: ["角色版"] },
              { id: "published-image", ownerId: "creator-b", type: "图片", tags: ["已发布生成图"] },
              { id: "delivery-cover", ownerId: "creator-b", type: "图片", tags: [] },
              { id: "delivery", ownerId: "creator-b", delivered: true, coverAssetId: "delivery-cover", packAssetIds: [] }
            ];
            console.log(JSON.stringify({
              own: canDeleteReferenceAsset(state.assets[0]),
              legacy: canDeleteReferenceAsset(state.assets[1]),
              role: canDeleteReferenceAsset(state.assets[2]),
              published: canDeleteReferenceAsset(state.assets[3]),
              dependency: canDeleteReferenceAsset(state.assets[4])
            }));
            """
        )
        self.assertEqual(result, {
            "own": True,
            "legacy": True,
            "role": False,
            "published": False,
            "dependency": False,
        })

    def test_new_single_infoflow_does_not_inherit_account_asset_history(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };

            const { state } = await import("./js/core/store.js");
            const { createProduction, buildMaterialUnits } = await import("./js/domain/productions.js");
            const { createUnitVideoJobs } = await import("./js/agent/orchestrator.js?v=20260718-v94-1");

            state.accounts = [
              { id:"material-a", name:"素材号", mode:"视频", subType:"无数字人", platform:"视频号" },
              { id:"digital-a", name:"数字人号", mode:"视频", subType:"数字人", platform:"视频号", charBoardAssetId:"role-board" }
            ];
            state.assets = [
              { id:"old-logo", accountId:"material-a", type:"图片", name:"旧 logo", tags:["全能参考","logo"] },
              { id:"old-ui", accountId:"material-a", type:"图片", name:"旧界面图", tags:["统一参考","界面"] },
              { id:"role-board", accountId:"digital-a", type:"图片", name:"角色板", tags:["角色板"] }
            ];
            state.productions = [];
            state.jobs = [];
            state.ui.currentMemberId = "tester";

            const infoflow = createProduction({ accountId:"material-a", topic:"新任务" });
            infoflow.artifacts.script.shots = [{ scene:1, idea:"开场", visual:"办公场景", line:"测试", ui:false }];
            infoflow.artifacts.audio.perShot = [{ dur:5 }];
            const units = buildMaterialUnits(infoflow);
            units[0].videoPrompt = "9:16竖屏，办公场景。";
            createUnitVideoJobs(infoflow);

            const digital = createProduction({ accountId:"digital-a", topic:"数字人新任务" });
            createUnitVideoJobs(digital);

            console.log(JSON.stringify({
              infoflowRefs: state.jobs.filter(job => job.productionId === infoflow.id).map(job => job.refAssetIds),
              infoflowOmni: infoflow.artifacts.boards.omniRefAssetIds,
              infoflowScene: infoflow.artifacts.boards.sceneRefAssetIds,
              digitalRole: digital.artifacts.boards.characterRefAssetId
            }));
            """
        )
        self.assertEqual(result["infoflowRefs"], [[]])
        self.assertEqual(result["infoflowOmni"], [])
        self.assertEqual(result["infoflowScene"], [])
        self.assertEqual(result["digitalRole"], "role-board")

    def test_browser_title_and_batch_reference_layout_are_unambiguous(self):
        index = (APP_DIR / "index.html").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles/ui-motion.css").read_text(encoding="utf-8")

        self.assertIn("<title>星阵</title>", index)
        self.assertNotIn("星阵 · 内容生产工作台", index)
        self.assertIn(".agc-mini-ref {\n  grid-area: refs;\n  display: grid;", styles)
        self.assertIn('"refs refs refs refs"', styles)
        self.assertIn(".agc-mini-ref .agc-mini-head::before { display: none; }", styles)

    def test_batch_video_reference_contract_separates_cover_and_scene_inputs(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };

            const { batchCoverRefIds, batchSceneRefIds } = await import("./js/agent/orchestrator.js");
            const base = {
              coverRefAssetIds: ["shared-cover"],
              accountRefAssetIds: { "account-a": ["custom-cover"] }
            };
            console.log(JSON.stringify({
              digitalCover: batchCoverRefIds({ ...base, contentKind: "real" }, "account-a"),
              digitalScene: batchSceneRefIds({ ...base, contentKind: "real" }, "account-a"),
              infoCover: batchCoverRefIds({ ...base, contentKind: "material" }, "account-a"),
              infoScene: batchSceneRefIds({ ...base, contentKind: "material" }, "account-a")
            }));
            """
        )
        self.assertEqual(result["digitalCover"], ["shared-cover", "custom-cover"])
        self.assertEqual(result["digitalScene"], [])
        self.assertEqual(result["infoCover"], ["shared-cover", "custom-cover"])
        self.assertEqual(result["infoScene"], ["shared-cover", "custom-cover"])

    def test_each_digital_human_cover_uses_only_its_own_locked_character_board(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };

            const { state } = await import("./js/core/store.js");
            const { applyBatchCoverRefs, batchSceneRefIds } = await import("./js/agent/orchestrator.js");
            state.accounts = [
              { id: "digital-a", mode: "视频", subType: "数字人", charBoardAssetId: "role-a" },
              { id: "digital-b", mode: "视频", subType: "数字人", charBoardAssetId: "role-b" }
            ];
            const batch = {
              contentKind: "real",
              coverRefAssetIds: ["shared-cover"],
              accountRefAssetIds: {
                "digital-a": ["custom-a"],
                "digital-b": ["custom-b"]
              }
            };
            const make = id => ({
              mode: "视频", subType: "数字人", accountId: id,
              artifacts: { boards: { cover: { refAssetIds: [] } } }
            });
            const a = make("digital-a");
            const b = make("digital-b");
            applyBatchCoverRefs(a, batch);
            applyBatchCoverRefs(b, batch);
            console.log(JSON.stringify({
              coverA: a.artifacts.boards.cover.refAssetIds,
              coverB: b.artifacts.boards.cover.refAssetIds,
              videoA: batchSceneRefIds(batch, "digital-a"),
              videoB: batchSceneRefIds(batch, "digital-b")
            }));
            """
        )
        self.assertEqual(result["coverA"], ["shared-cover", "custom-a", "role-a"])
        self.assertEqual(result["coverB"], ["shared-cover", "custom-b", "role-b"])
        self.assertEqual(result["videoA"], [])
        self.assertEqual(result["videoB"], [])

    def test_batch_video_board_exposes_cover_refine_and_video_regeneration(self):
        cards = (APP_DIR / "js/agent/cards.js").read_text(encoding="utf-8")
        view = (APP_DIR / "js/agent/view.js").read_text(encoding="utf-8")
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")

        self.assertIn('p.artifacts.boards?.cover?.assetId', cards)
        self.assertIn('data-act="batch-cover-edit"', cards)
        self.assertIn('data-act="batch-video-regenerate"', cards)
        self.assertIn('case "batch-cover-edit"', view)
        self.assertIn('case "batch-video-regenerate"', view)
        self.assertIn("export async function regenerateBatchVideoCover", orchestrator)
        self.assertIn("export async function regenerateBatchVideo", orchestrator)
        self.assertIn("await regenerateBatchVideo(p)", view)
        self.assertIn('id="batchCoverRefAdd"', view)
        self.assertIn('data-cover-ref-remove', view)
        self.assertIn("regenerateBatchVideoCover(p, prompt, refIds)", view)
        self.assertIn("await draftOne(p, batch)", orchestrator)
        self.assertIn('p.subType === "数字人" ? account?.charBoardAssetId : null', orchestrator)

    def test_batch_confirm_has_visible_busy_state_and_sync_error_recovery(self):
        view = (APP_DIR / "js/agent/view.js").read_text(encoding="utf-8")
        self.assertIn('act.setAttribute("aria-busy", "true")', view)
        self.assertIn('act.innerHTML = `${icon("loader", 14)} 正在启动…`', view)
        self.assertIn('toast(err?.message ? `批量任务启动失败：${err.message}`', view)
        self.assertIn('act.removeAttribute("aria-busy")', view)

    def test_video_review_prefers_composed_output_and_uses_larger_preview(self):
        drawer = (APP_DIR / "js/views/prodDrawer.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles/views.css").read_text(encoding="utf-8")
        self.assertIn('const composedUrl = String(p.artifacts?.finalVideoUrl || "").trim()', drawer)
        self.assertIn("已剪辑完整成片", drawer)
        self.assertIn("pd-workshop-preview is-composed", drawer)
        self.assertIn(".pd-review .rv-preview.vid .rvp-screen { width: 184px; }", styles)


if __name__ == "__main__":
    unittest.main()
