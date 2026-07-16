import json
import subprocess
import textwrap
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class SingleImageSlotIsolationTest(unittest.TestCase):
    def run_node(self, source):
        result = subprocess.run(
            ["node", "--input-type=module", "-e", textwrap.dedent(source)],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_sequential_generation_only_commits_the_requested_slot(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };

            const { commitGeneratedImageToSlot } = await import(
              "./js/views/chainBoards.js?v=single-slot-isolation"
            );
            const items = [
              { title: "图1", prompt: "prompt-1", assetId: "asset-existing", status: "done" },
              { title: "图2", prompt: "prompt-2", assetId: "asset-two-old", status: "done" },
              { title: "图3", prompt: "prompt-3", assetId: null, status: "idle" }
            ];

            const slotTwo = items[1];
            const firstCommit = commitGeneratedImageToSlot(items, 1, slotTwo, {
              assetId: "asset-two",
              referenceReceipt: { usedRefs: 1 }
            });
            const afterFirst = structuredClone(items);

            const slotThree = items[2];
            const secondCommit = commitGeneratedImageToSlot(items, 2, slotThree, {
              assetId: "asset-three",
              referenceReceipt: { usedRefs: 0 }
            });

            console.log(JSON.stringify({ firstCommit, secondCommit, afterFirst, final: items }));
            """
        )

        self.assertTrue(result["firstCommit"])
        self.assertTrue(result["secondCommit"])
        self.assertEqual(result["afterFirst"][0]["assetId"], "asset-existing")
        self.assertEqual(result["afterFirst"][1]["assetId"], "asset-two")
        self.assertIsNone(result["afterFirst"][2]["assetId"])
        self.assertEqual(result["final"][0]["assetId"], "asset-existing")
        self.assertEqual(result["final"][1]["assetId"], "asset-two")
        self.assertEqual(result["final"][2]["assetId"], "asset-three")
        self.assertEqual(result["final"][1]["referenceReceipt"]["usedRefs"], 1)
        self.assertEqual(result["final"][2]["referenceReceipt"]["usedRefs"], 0)

    def test_stale_result_cannot_land_in_a_rebuilt_slot(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };

            const { commitGeneratedImageToSlot } = await import(
              "./js/views/chainBoards.js?v=stale-slot-isolation"
            );
            const oldSlot = { title: "旧图2", prompt: "old", assetId: null, status: "loading" };
            const items = [
              { title: "图1", assetId: "asset-one", status: "done" },
              oldSlot
            ];
            items[1] = { title: "新图2", prompt: "new", assetId: null, status: "idle" };

            const committed = commitGeneratedImageToSlot(items, 1, oldSlot, {
              assetId: "stale-generated-asset"
            });
            console.log(JSON.stringify({ committed, activeSlot: items[1], oldSlot }));
            """
        )

        self.assertFalse(result["committed"])
        self.assertIsNone(result["activeSlot"]["assetId"])
        self.assertIsNone(result["oldSlot"]["assetId"])

    def test_generation_uses_the_requested_prompt_and_guarded_slot_commit(self):
        source = (APP_DIR / "js/views/chainBoards.js").read_text(encoding="utf-8")
        self.assertIn("const fresh = A.items[i]", source)
        self.assertIn("promptForImageModel(fresh.prompt)", source)
        self.assertIn("commitGeneratedImageToSlot(A.items, i, fresh", source)
        self.assertIn("await removeAsset(a.id)", source)


if __name__ == "__main__":
    unittest.main()
