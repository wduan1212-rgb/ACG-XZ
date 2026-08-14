import json
import subprocess
import textwrap
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class ImageReferenceReceiptFrontendTest(unittest.TestCase):
    def run_node(self, source):
        result = subprocess.run(
            ["node", "--input-type=module", "-e", textwrap.dedent(source)],
            cwd=APP_DIR.parent,
            text=True,
            capture_output=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_receipt_counts_local_and_server_skips(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            const { normalizeImageReferenceReceipt } = await import("./自动化产品/js/api/providers.js");
            const receipt = normalizeImageReferenceReceipt(
              { usedRefs: 1, skippedRefs: 0, mode: "gpt-maas", model: "image-model", ratio: "3:4" },
              [{ id: "asset-a" }],
              ["asset-a", "asset-b"]
            );
            console.log(JSON.stringify(receipt));
            """
        )
        self.assertEqual(result["intendedRefs"], 2)
        self.assertEqual(result["preparedRefs"], 1)
        self.assertEqual(result["usedRefs"], 1)
        self.assertEqual(result["skippedRefs"], 1)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["mode"], "gpt-maas")
        self.assertEqual(result["locallySkippedRefAssetIds"], ["asset-b"])

    def test_selected_but_unreadable_refs_fail_before_request(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            let fetchCalls = 0;
            globalThis.fetch = async () => { fetchCalls += 1; throw new Error("should not fetch"); };
            const { getProvider } = await import("./自动化产品/js/api/providers.js");
            const provider = getProvider("openai-image");
            let caught = null;
            try {
              await provider.submit({
                prompt: "test",
                refs: [],
                intendedRefAssetIds: ["missing-asset"],
                apiKey: "key",
                endpoint: "https://example.invalid/v1/images/generations"
              });
            } catch (error) {
              caught = {
                code: error.code,
                intendedRefs: error.referenceReceipt?.intendedRefs,
                usedRefs: error.referenceReceipt?.usedRefs
              };
            }
            console.log(JSON.stringify({ fetchCalls, caught }));
            """
        )
        self.assertEqual(result["fetchCalls"], 0)
        self.assertEqual(result["caught"]["code"], "IMAGE_REFERENCE_NOT_USED")
        self.assertEqual(result["caught"]["intendedRefs"], 1)
        self.assertEqual(result["caught"]["usedRefs"], 0)

    def test_server_zero_used_refs_fails_instead_of_text_to_image(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.fetch = async () => ({
              ok: true,
              status: 200,
              async text() {
                return JSON.stringify({
                  ok: true,
                  dataUrl: "data:image/png;base64,AA==",
                  usedRefs: 0,
                  skippedRefs: 1,
                  mode: "gpt-maas"
                });
              }
            });
            const { getProvider } = await import("./自动化产品/js/api/providers.js");
            const provider = getProvider("openai-image");
            let caught = null;
            try {
              await provider.submit({
                prompt: "test",
                refs: [{ id: "asset-a", dataUrl: "data:image/png;base64,AA==" }],
                intendedRefAssetIds: ["asset-a"],
                apiKey: "key",
                endpoint: "https://example.invalid/v1/images/generations"
              });
            } catch (error) {
              caught = {
                code: error.code,
                status: error.referenceReceipt?.status,
                usedRefs: error.referenceReceipt?.usedRefs,
                skippedRefs: error.referenceReceipt?.skippedRefs
              };
            }
            console.log(JSON.stringify(caught));
            """
        )
        self.assertEqual(result["code"], "IMAGE_REFERENCE_NOT_USED")
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["usedRefs"], 0)
        self.assertEqual(result["skippedRefs"], 1)

    def test_old_server_without_receipt_fails_with_version_message(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.fetch = async () => ({
              ok: true,
              status: 200,
              async text() {
                return JSON.stringify({
                  ok: true,
                  dataUrl: "data:image/png;base64,AA==",
                  mode: "gpt-maas"
                });
              }
            });
            const { getProvider } = await import("./自动化产品/js/api/providers.js");
            const provider = getProvider("openai-image");
            let caught = null;
            try {
              await provider.submit({
                prompt: "test",
                refs: [{ id: "asset-a", dataUrl: "data:image/png;base64,AA==" }],
                intendedRefAssetIds: ["asset-a"],
                apiKey: "key",
                endpoint: "https://example.invalid/v1/images/generations"
              });
            } catch (error) {
              caught = {
                code: error.code,
                message: error.message,
                receiptSupported: error.referenceReceipt?.receiptSupported
              };
            }
            console.log(JSON.stringify(caught));
            """
        )
        self.assertEqual(result["code"], "IMAGE_REFERENCE_RECEIPT_UNAVAILABLE")
        self.assertIn("服务版本未返回参考图使用回执", result["message"])
        self.assertFalse(result["receiptSupported"])

    def test_successful_receipt_survives_submit_and_poll(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.fetch = async () => ({
              ok: true,
              status: 200,
              async text() {
                return JSON.stringify({
                  ok: true,
                  dataUrl: "data:image/png;base64,AA==",
                  usedRefs: 1,
                  skippedRefs: 0,
                  mode: "gpt-maas",
                  model: "image-model",
                  ratio: "3:4"
                });
              }
            });
            const { getProvider } = await import("./自动化产品/js/api/providers.js");
            const provider = getProvider("openai-image");
            const submitted = await provider.submit({
              prompt: "test",
              refs: [{ id: "asset-a", dataUrl: "data:image/png;base64,AA==" }],
              intendedRefAssetIds: ["asset-a"],
              apiKey: "key",
              endpoint: "https://example.invalid/v1/images/generations"
            });
            const polled = await provider.poll(submitted.providerRef);
            console.log(JSON.stringify({
              submitReceipt: submitted.referenceReceipt,
              pollReceipt: polled.output.referenceReceipt
            }));
            """
        )
        self.assertEqual(result["submitReceipt"]["usedRefs"], 1)
        self.assertEqual(result["submitReceipt"]["status"], "used")
        self.assertEqual(result["pollReceipt"], result["submitReceipt"])

    def test_cover_can_lock_native_ratio_without_changing_normal_image_calls(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            const bodies = [];
            globalThis.fetch = async (_url, options = {}) => {
              bodies.push(JSON.parse(options.body));
              return {
                ok: true,
                status: 200,
                async text() {
                  return JSON.stringify({
                    ok: true,
                    dataUrl: "data:image/png;base64,AA==",
                    mode: "gpt-maas",
                    ratio: "3:4"
                  });
                }
              };
            };
            const { getProvider } = await import("./自动化产品/js/api/providers.js");
            const provider = getProvider("openai-image");
            await provider.submit({
              prompt: "视频封面，内容上下文仍包含 9:16 竖屏视频",
              ratio: "3:4",
              strictRatio: true,
              apiKey: "key",
              endpoint: "https://example.invalid/v1/images/generations"
            });
            await provider.submit({
              prompt: "普通图片创作",
              ratio: "3:4",
              apiKey: "key",
              endpoint: "https://example.invalid/v1/images/generations"
            });
            console.log(JSON.stringify(bodies));
            """
        )
        self.assertEqual(result[0]["ratio"], "3:4")
        self.assertTrue(result[0]["strictRatio"])
        self.assertEqual(result[1]["ratio"], "3:4")
        self.assertFalse(result[1]["strictRatio"])

    def test_digital_cover_no_longer_retries_without_references(self):
        source = (APP_DIR / "js/views/chainWorkshop.js").read_text(encoding="utf-8")
        self.assertNotIn("runCover([], false)", source)
        self.assertIn("intendedRefAssetIds: cover.refAssetIds || []", source)
        self.assertIn("cover.referenceReceipt = output.output?.referenceReceipt", source)

    def test_batch_and_single_image_results_persist_receipt(self):
        boards = (APP_DIR / "js/views/chainBoards.js").read_text(encoding="utf-8")
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        jobs = (APP_DIR / "js/api/jobs.js").read_text(encoding="utf-8")
        self.assertIn("fresh.referenceReceipt = out.output?.referenceReceipt", boards)
        self.assertIn("strictRatio: true", boards)
        self.assertIn("参考图实际使用 ${used}/${intended}", boards)
        self.assertIn("item.referenceReceipt = job.referenceReceipt || null", orchestrator)
        self.assertIn("j.referenceReceipt = r.referenceReceipt || r.output?.referenceReceipt", jobs)

    def test_single_and_batch_send_selected_asset_content_with_intent_ids(self):
        boards = (APP_DIR / "js/views/chainBoards.js").read_text(encoding="utf-8")
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        providers = (APP_DIR / "js/api/providers.js").read_text(encoding="utf-8")
        server = (APP_DIR / "server/main.py").read_text(encoding="utf-8")

        self.assertIn("const referencePlan = await planCustomReferencesForSlot(fresh, i)", boards)
        self.assertIn("const intendedRefAssetIds = referencePlan.ids", boards)
        self.assertIn("const refs = await providerRefsFor(A, intendedRefAssetIds)", boards)
        self.assertIn("dataUrl = await urlToDataUrl(u)", boards)
        self.assertIn("intendedRefAssetIds,", boards)

        self.assertIn("const refGroups = imageRefGroupsFor(acc, batch, p)", orchestrator)
        self.assertIn("await imageRefsForIds(refGroups.shared, \"shared\")", orchestrator)
        self.assertIn("await imageRefsForIds(refGroups.custom, \"custom\")", orchestrator)
        self.assertIn("if (blob) dataUrl = await fileToDataUrl(blob)", orchestrator)
        self.assertIn("intendedRefAssetIds,", orchestrator)

        self.assertIn("refs: preparedRefs.map", providers)
        self.assertIn('postJsonWithFallback("/api/image/generate", body)', providers)
        self.assertIn('body["images"] = [{"image_url": _image_ref_to_data_url', server)
        self.assertIn('content.append({"type": "input_image"', server)
        self.assertIn('{"type": "image_url"', server)
        self.assertIn('file_parts = [("image", (name, blob, mime))', server)


if __name__ == "__main__":
    unittest.main()
