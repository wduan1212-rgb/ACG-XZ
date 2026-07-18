import importlib
import json
import re
import subprocess
import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException


SERVER_DIR = Path(__file__).resolve().parents[1]
APP_DIR = SERVER_DIR.parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

main = importlib.import_module("main")


class CustomCanvasStaticIntegrationTest(unittest.TestCase):
    def test_canvas_source_keeps_one_single_image_guard_per_request(self):
        source_path = APP_DIR / "apps" / "infinite-canvas-source" / "src" / "lib" / "agent.ts"
        source = source_path.read_text(encoding="utf-8")
        constant_start = source.index("const SINGLE_IMAGE_GUARD")
        constant_end = source.index("\n", constant_start) + 1
        function_start = source.index("export function prepareSingleImagePrompt", constant_start)
        function_end = source.index("\n}\n\n/** Quality-neutral", function_start) + 2
        runnable = source[constant_start:constant_end] + source[function_start:function_end]
        runnable = runnable.replace("export function", "function")
        runnable = runnable.replace("prompt: string", "prompt")
        runnable = runnable.replace("outputCount: number", "outputCount")
        runnable = runnable.replace("): string {", ") {")
        script = f"""
{runnable}
const duplicated = `生成一张海报。${{SINGLE_IMAGE_GUARD}}。\n${{SINGLE_IMAGE_GUARD}}。\n第 2 版：保持主题与文案不变。`;
const guardOnly = `${{SINGLE_IMAGE_GUARD}}。${{SINGLE_IMAGE_GUARD}}。`;
const normalized = prepareSingleImagePrompt(duplicated, 2);
const fallback = prepareSingleImagePrompt(guardOnly, 2);
console.log(JSON.stringify({{
  normalized,
  normalizedGuardCount: normalized.split(SINGLE_IMAGE_GUARD).length - 1,
  fallback,
  fallbackGuardCount: fallback.split(SINGLE_IMAGE_GUARD).length - 1
}}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["normalizedGuardCount"], 1)
        self.assertIn("第 2 版：保持主题与文案不变", payload["normalized"])
        self.assertNotIn("。。", payload["normalized"])
        self.assertEqual(payload["fallbackGuardCount"], 1)
        self.assertTrue(payload["fallback"].startswith("生成一张完整成图。"))

    def test_current_canvas_build_is_vendored_with_platform_bridge(self):
        canvas_dir = APP_DIR / "vendor" / "infinite-canvas"
        self.assertTrue((canvas_dir / "index.html").is_file())
        chunks = "\n".join(
            path.read_text(encoding="utf-8", errors="ignore")
            for path in sorted((canvas_dir / "_next" / "static" / "chunks").rglob("*.js"))
        )
        self.assertIn("/api/custom-canvas", chunks)
        self.assertIn("xingzhen-canvas", chunks)
        self.assertIn("output-ready", chunks)
        self.assertIn("publish-request", chunks)
        self.assertIn("custom-canvas:published", chunks)
        self.assertIn("publishedItemIds", chunks)
        self.assertIn("该图片已提交发布", chunks)
        self.assertIn("ai-design-canvas:v2:", chunks)
        self.assertIn("单次只生成一张完整成图", chunks)
        self.assertIn("禁止拼图、分屏或并排展示多个方案", chunks)

    def test_vendored_build_is_self_contained_and_all_index_assets_exist(self):
        canvas_dir = APP_DIR / "vendor" / "infinite-canvas"
        index = (canvas_dir / "index.html").read_text(encoding="utf-8")
        asset_paths = set(re.findall(r'(?:src|href)="(/XZ-Design/[^"]+)"', index))
        self.assertGreater(len(asset_paths), 2)
        for asset_path in asset_paths:
            relative = asset_path.split("?", 1)[0].removeprefix("/XZ-Design/")
            self.assertTrue((canvas_dir / relative).is_file(), asset_path)

        deployment_text = "\n".join(
            path.read_text(encoding="utf-8", errors="ignore")
            for path in canvas_dir.rglob("*")
            if path.is_file() and path.suffix in {".html", ".js", ".css", ".txt"}
        )
        self.assertNotIn("/Users/", deployment_text)
        self.assertNotIn("Desktop/百度/图片生产平台", deployment_text)

    def test_minimal_source_snapshot_is_internal_rebuildable_and_secret_free(self):
        source_dir = APP_DIR / "apps" / "infinite-canvas-source"
        self.assertTrue((source_dir / "src" / "lib" / "api.ts").is_file())
        self.assertTrue((source_dir / "public" / "star-logo.png").is_file())
        self.assertTrue((source_dir / "package-lock.json").is_file())
        package = (source_dir / "package.json").read_text(encoding="utf-8")
        self.assertIn('"build:embed"', package)
        self.assertIn("NEXT_PUBLIC_PLATFORM_EMBED=1", package)
        self.assertIn("next build --webpack", package)

        forbidden_names = {".env.local", ".next", "node_modules", ".cache", "out"}
        present = {path.name for path in source_dir.rglob("*")}
        self.assertTrue(forbidden_names.isdisjoint(present))
        self.assertFalse(any(path.is_symlink() for path in source_dir.rglob("*")))

        source_text = "\n".join(
            path.read_text(encoding="utf-8", errors="ignore")
            for path in source_dir.rglob("*")
            if path.is_file() and path.suffix in {".ts", ".tsx", ".js", ".json", ".md", ".mjs", ".example"}
        )
        self.assertNotIn("/Users/", source_text)
        self.assertNotIn("Desktop/百度/图片生产平台", source_text)
        self.assertIn("/api/custom-canvas", source_text)
        self.assertIn("xingzhen-canvas", source_text)
        self.assertIn('type: "publish-request"', source_text)
        self.assertIn("items: [{ ...item }]", source_text)
        self.assertIn("disabled={!canPublish || publishing}", source_text)
        self.assertIn("renderCanvasOutput", source_text)
        self.assertIn("overlappingMarksFor(selectedImage, reactiveItems)", source_text)
        self.assertIn("navigateToProject(router, project.id)", source_text)
        self.assertIn("publishedItemIds?.includes(item.id)", source_text)
        self.assertIn("publishedItemIds.includes(results[0].id)", source_text)
        self.assertIn("publishedItemIds.includes(r.id)", source_text)
        self.assertIn("该图片已提交发布", source_text)
        env_example = (source_dir / ".env.example").read_text(encoding="utf-8")
        for line in env_example.splitlines():
            if line.startswith(("MAAS_API_KEY=", "MAAS_CHAT_API_KEY=")):
                self.assertEqual(line.split("=", 1)[1], "")

    def test_source_provenance_and_dependency_licenses_are_mapped(self):
        source_dir = APP_DIR / "apps" / "infinite-canvas-source"
        provenance = (source_dir / "SOURCE_PROVENANCE.md").read_text(encoding="utf-8")
        licenses = (source_dir / "THIRD_PARTY_LICENSES.md").read_text(encoding="utf-8")
        self.assertIn("345319e180eb1370e2b5e7b2d165a50f235e19e9", provenance)
        self.assertIn("后续构建、测试和部署均不应再读取上游工作区", provenance)
        for filename in (
            "next-MIT.md",
            "react-MIT.txt",
            "zustand-MIT.txt",
            "lucide-react-ISC.txt",
            "geist-OFL-1.1.txt",
            "typescript-Apache-2.0.txt",
        ):
            self.assertTrue((source_dir / "licenses" / filename).is_file(), filename)
            self.assertIn(f"`licenses/{filename}`", licenses)

    def test_host_module_is_isolated_and_exposes_output_bridge(self):
        integration = (APP_DIR / "js" / "views" / "customCanvasIntegration.js").read_text(encoding="utf-8")
        self.assertIn(
            "export async function mountCustomCanvas(host, { onOutput, onPublishRequest } = {})",
            integration,
        )
        self.assertIn("export function getLatestOutput()", integration)
        self.assertIn("export function subscribeCanvasOutput", integration)
        self.assertIn("subscribeCanvasOutput(onOutput)", integration)
        self.assertIn('output.type === "publish-request"', integration)
        self.assertIn("onPublishRequest(cloneOutput(output))", integration)
        self.assertIn('type: "custom-canvas:published"', integration)
        self.assertIn("publishedProjects", integration)
        self.assertIn("sourceItemId", integration)
        self.assertIn(
            "rawDataUrl.length <= MAX_CANVAS_DATA_URL_BYTES ? rawDataUrl : \"\"",
            integration,
        )
        self.assertNotIn("safeText(value.dataUrl", integration)
        self.assertIn('event.source !== iframe.contentWindow', integration)
        self.assertIn('event.origin !== window.location.origin', integration)
        self.assertIn("width:100%;height:100%;min-height:0", integration)
        self.assertNotIn("min-height:640px", integration)

    def test_canvas_publish_reuses_image_polish_without_changing_direct_export(self):
        publish = (APP_DIR / "js" / "views" / "customPublish.js").read_text(encoding="utf-8")
        export = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "workspace"
            / "ExportModal.tsx"
        ).read_text(encoding="utf-8")

        self.assertIn(
            'import { polishImageForPublish } from "../domain/imagePolish.js";',
            publish,
        )
        self.assertIn("const polishedDataUrl = await polishImageForPublish(", publish)
        self.assertIn('"发布前精修"', publish)
        self.assertIn("直接导出保持原图", publish)
        self.assertIn("正在精修画布成品并准备原子提交", publish)
        self.assertNotIn("polishImageForPublish", export)
        self.assertNotIn("发布前精修", export)

    def test_canvas_config_returns_only_current_owner_published_sources(self):
        projects = [{
            "id": "canvas-a",
            "ownerId": "creator-a",
            "kind": "canvas",
            "status": "published",
            "publishedDeliveryId": "delivery-a",
            "publishedAt": 123,
            "projectState": {
                "sourceProjectId": "local-canvas-a",
                "publishedItemIds": ["item-a"],
            },
        }, {
            "id": "canvas-draft",
            "ownerId": "creator-a",
            "kind": "canvas",
            "status": "draft",
            "publishedDeliveryId": "",
            "projectState": {"sourceProjectId": "local-draft"},
        }]
        with patch.object(
            main.store,
            "list_custom_projects",
            return_value=projects,
        ) as listed:
            result = main.custom_canvas_config(
                me={"id": "creator-a", "role": "editor"},
            )
        listed.assert_called_once_with("creator-a", "canvas")
        self.assertEqual(result["publishedProjects"], [{
            "projectId": "local-canvas-a",
            "deliveryId": "delivery-a",
            "publishedAt": 123,
            "itemIds": ["item-a"],
        }])
        self.assertIn("published-state", result["features"])

    def test_fastapi_mounts_canvas_without_exposing_external_source_tree(self):
        mounts = [getattr(route, "path", "") for route in main.app.routes]
        self.assertIn("/XZ-Design", mounts)
        self.assertEqual(main.CUSTOM_CANVAS_DIR, APP_DIR / "vendor" / "infinite-canvas")
        self.assertNotIn("图片生产平台", str(main.CUSTOM_CANVAS_DIR))


class CustomCanvasBackendTest(unittest.IsolatedAsyncioTestCase):
    def test_canvas_size_maps_to_legal_native_ratio(self):
        self.assertEqual(main._custom_canvas_parse_size("1242x1660"), (1242, 1660))
        self.assertEqual(main._custom_canvas_ratio("1242x1660"), "3:4")
        self.assertEqual(main._custom_canvas_ratio("1080x1920"), "9:16")
        self.assertEqual(main._custom_canvas_ratio("1920x1080"), "16:9")
        self.assertEqual(main._custom_canvas_native_size("3:4"), (1152, 1536))

    def test_agent_fallback_respects_explicit_output_count(self):
        result = main._custom_canvas_agent_fallback(main.CustomCanvasAgentReq(
            brief="生成三张科技发布会海报",
            scene="enterprise_poster",
            size="1080x1920",
            references=[{"label": "产品参考"}],
        ))
        self.assertEqual(result["palette"], "tech")
        self.assertEqual(result["count"], 3)
        self.assertEqual(len(result["variants"]), 3)
        self.assertIn("保持其外观与文字原样", result["prompt"])

    def test_parallel_output_count_is_not_sent_to_each_single_image(self):
        result = main._custom_canvas_agent_fallback(main.CustomCanvasAgentReq(
            brief="为这个logo创作两张风格不一样的海报",
            scene="enterprise_poster",
            size="1024x1024",
            references=[{"label": "logo.png"}],
        ))

        self.assertEqual(result["count"], 2)
        self.assertEqual(len(result["variants"]), 2)
        for prompt in [result["prompt"], *result["variants"]]:
            self.assertNotIn("两张", prompt)
            self.assertNotIn("风格不一样", prompt)
            self.assertIn("单次只生成一张完整成图", prompt)
            self.assertIn("禁止拼图", prompt)

    def test_parallel_prompt_cleanup_preserves_scene_object_counts(self):
        brief = "生成两张海报，画面展示两个产品、两个人和三个卖点"
        self.assertEqual(main._custom_canvas_explicit_count(brief), 2)
        cleaned = main._custom_canvas_single_image_prompt(brief, 2)
        self.assertIn("生成一张海报", cleaned)
        self.assertIn("两个产品", cleaned)
        self.assertIn("两个人", cleaned)
        self.assertIn("三个卖点", cleaned)
        self.assertEqual(main._custom_canvas_explicit_count("海报展示三款产品和两个 logo"), 1)
        self.assertEqual(main._custom_canvas_explicit_count("创作两个不同风格的海报"), 2)

    def test_parallel_style_word_orders_clean_to_natural_single_image_requests(self):
        cases = (
            "生成2张不同风格的海报",
            "帮我创作两张不同风格的海报",
            "为这个logo创作两张风格不一样的海报",
        )
        for brief in cases:
            with self.subTest(brief=brief):
                self.assertEqual(main._custom_canvas_explicit_count(brief), 2)
                cleaned = main._custom_canvas_single_image_prompt(brief, 2)
                self.assertIn("一张海报", cleaned)
                self.assertNotIn("一张风格", cleaned)
                self.assertNotIn("不同风格", cleaned)
                self.assertNotIn("风格不一样", cleaned)

        preserved = main._custom_canvas_single_image_prompt(
            "生成两张海报，画面有两个产品、两个人和三个卖点",
            2,
        )
        self.assertIn("两个产品", preserved)
        self.assertIn("两个人", preserved)
        self.assertIn("三个卖点", preserved)

    def test_scene_and_reference_quantities_are_not_parallel_output_counts(self):
        single_output_briefs = (
            "帮我生成海报，画面展示两张照片和三张卡片",
            "设计封面，桌上放两张发票",
            "用两张参考图生成海报",
            "生成一张海报，画面中有两张照片",
        )
        for brief in single_output_briefs:
            with self.subTest(brief=brief):
                self.assertEqual(main._custom_canvas_explicit_count(brief), 1)

        self.assertEqual(main._custom_canvas_explicit_count("生成两张"), 2)
        self.assertEqual(main._custom_canvas_explicit_count("生成两张海报"), 2)
        self.assertEqual(main._custom_canvas_explicit_count("三版方案"), 3)

    async def test_generation_forces_requested_ratio_and_requires_reference_receipt(self):
        captured = []

        async def fake_generate(req):
            captured.append(req)
            return {
                "dataUrl": "data:image/png;base64,AA==",
                "usedRefs": 1,
                "skippedRefs": 0,
                "ratio": "3:4",
                "model": "test-image",
                "mode": "gpt-maas",
            }

        refs = [main.ImageRef(role="custom", dataUrl="data:image/png;base64,AA==")]
        with patch.object(main, "image_generate", new=AsyncMock(side_effect=fake_generate)):
            result = await main._custom_canvas_generated_image("真实产品海报", "1242x1660", refs)

        self.assertEqual(result["width"], 1152)
        self.assertEqual(result["height"], 1536)
        self.assertEqual(result["usedRefs"], 1)
        self.assertTrue(captured[0].strictRatio)
        self.assertEqual(captured[0].ratio, "3:4")
        self.assertEqual(len(captured[0].refs), 1)

        with patch.object(main, "image_generate", new=AsyncMock(return_value={
            "dataUrl": "data:image/png;base64,AA==",
            "usedRefs": 0,
            "skippedRefs": 1,
            "ratio": "3:4",
        })):
            with self.assertRaises(HTTPException) as raised:
                await main._custom_canvas_generated_image("真实产品海报", "1242x1660", refs)
        self.assertEqual(raised.exception.status_code, 502)
        self.assertIn("参考图未完整送达", raised.exception.detail)

    async def test_region_edit_sends_real_mask_to_maas(self):
        captured = {}

        class DummyClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

        class DummyResponse:
            status_code = 200

        async def fake_post(_client, endpoint, body, headers):
            captured.update({"endpoint": endpoint, "body": body, "headers": headers})
            return DummyResponse(), {"data": [{"b64_json": "AA=="}]}

        request = main.CustomCanvasEditRegionReq(
            image="data:image/png;base64,AA==",
            mask="data:image/png;base64,AA==",
            instruction="把按钮改成蓝色",
            width=1242,
            height=1660,
        )
        with ExitStack() as stack:
            stack.enter_context(patch.object(main, "IMAGE_API_KEY", "test-key"))
            stack.enter_context(patch.object(main, "_image_endpoint", return_value="https://maas.example/v1/aiart/gtimage"))
            stack.enter_context(patch.object(main, "_post_json_with_retry", new=AsyncMock(side_effect=fake_post)))
            stack.enter_context(patch.object(
                main,
                "_generated_image_to_data_url",
                new=AsyncMock(return_value="data:image/jpeg;base64,AA=="),
            ))
            stack.enter_context(patch.object(main.httpx, "AsyncClient", return_value=DummyClient()))
            result = await main._custom_canvas_mask_edit(request)

        self.assertEqual(result["width"], 1152)
        self.assertEqual(result["height"], 1536)
        self.assertEqual(captured["body"]["mask"]["image_url"], request.mask)
        self.assertEqual(captured["body"]["input_fidelity"], "high")
        self.assertEqual(len(captured["body"]["images"]), 1)
        self.assertTrue(captured["endpoint"].endswith("/aiart/gtimage"))

    def test_config_is_creator_only_and_reports_export_bridge(self):
        result = main.custom_canvas_config(me={"id": "creator", "role": "editor"})
        self.assertTrue(result["available"])
        self.assertIn("export-bridge", result["features"])
        with self.assertRaises(HTTPException) as raised:
            main.custom_canvas_config(me={"id": "supplier", "role": "supplier_parent"})
        self.assertEqual(raised.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
