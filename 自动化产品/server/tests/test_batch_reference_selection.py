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

    def test_account_level_long_term_references_are_visible_and_distinct(self):
        cards = (APP_DIR / "js/agent/cards.js").read_text(encoding="utf-8")
        view = (APP_DIR / "js/agent/view.js").read_text(encoding="utf-8")
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")

        self.assertIn("账号长期风格图", cards)
        self.assertIn("只控制视觉风格，不并入本次任务参考图", cards)
        self.assertIn("账号长期角色图", cards)
        self.assertIn("真人/数字人生成时自动用于角色身份", cards)
        self.assertIn("prunePlanReferences(m.payload)", view)
        self.assertIn("if (!A.omniRefAssetIds.length && !p.batchId)", orchestrator)
        self.assertIn("!p.batchId ? A.sharedRefAssetId : null", orchestrator)


if __name__ == "__main__":
    unittest.main()
