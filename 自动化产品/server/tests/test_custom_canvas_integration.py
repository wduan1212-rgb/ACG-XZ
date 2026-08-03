import importlib
import base64
import io
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


def png_data_url(width=32, height=32):
    if not main.Image:
        raise unittest.SkipTest("Pillow is required for custom-canvas image output tests")
    image = main.Image.new("RGB", (width, height), "#3b82f6")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def image_data_url(image_format, width=160, height=90):
    if not main.Image:
        raise unittest.SkipTest("Pillow is required for custom-canvas image output tests")
    normalized = str(image_format or "").strip().upper()
    mime = {
        "PNG": "image/png",
        "JPEG": "image/jpeg",
        "WEBP": "image/webp",
    }[normalized]
    image = main.Image.new("RGB", (width, height), "#3b82f6")
    output = io.BytesIO()
    image.save(output, format=normalized)
    return f"data:{mime};base64," + base64.b64encode(output.getvalue()).decode("ascii")


def png_size(data_url):
    encoded = data_url.split(",", 1)[1]
    with main.Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
        return image.size


def striped_png_data_url(width=160, height=90):
    if not main.Image:
        raise unittest.SkipTest("Pillow is required for custom-canvas image output tests")
    image = main.Image.new("RGB", (width, height), "#22a06b")
    band = height // 3
    image.paste("#e53935", (0, 0, width, band))
    image.paste("#2764d8", (0, height - band, width, height))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


class CustomCanvasStaticIntegrationTest(unittest.TestCase):
    def test_platform_creates_one_real_canvas_project_for_a_first_time_user(self):
        source = (APP_DIR / "js/views/customCanvasIntegration.js").read_text(encoding="utf-8")
        self.assertIn("currentProjectId = await loadRecentProjectId(token, controller.signal)", source)
        self.assertIn("createProjectWhenReady = !currentProjectId", source)
        self.assertIn('{ type: "custom-canvas:create-project" }', source)

    def test_embed_root_never_renders_home_before_project_hash_resolves(self):
        source = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "GithubPagesApp.tsx"
        ).read_text(encoding="utf-8")

        self.assertNotIn("HomeView", source)
        self.assertIn("if (!projectId)", source)
        self.assertIn("data-canvas-project-opening", source)
        self.assertIn("正在打开画布", source)
        self.assertIn("bg-white", source)
        vendored_index = (
            APP_DIR / "vendor" / "infinite-canvas" / "index.html"
        ).read_text(encoding="utf-8")
        self.assertIn("正在打开画布", vendored_index)
        self.assertNotIn("欢迎使用星阵无限画布", vendored_index)

    def test_embed_workspace_uses_an_overlay_action_bar_without_reserved_height(self):
        workspace = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "workspace"
            / "Workspace.tsx"
        ).read_text(encoding="utf-8")
        topbar = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "workspace"
            / "TopBar.tsx"
        ).read_text(encoding="utf-8")
        project_client = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "workspace"
            / "ProjectClient.tsx"
        ).read_text(encoding="utf-8")

        self.assertIn("homeHref, IS_PLATFORM_EMBED", workspace)
        self.assertIn("<TopBar", workspace)
        self.assertIn("embedded={IS_PLATFORM_EMBED}", workspace)
        self.assertIn("if (embedded)", topbar)
        self.assertIn("absolute right-4 top-4", topbar)
        self.assertIn("showPublish && (", topbar)
        self.assertIn(
            '!IS_PLATFORM_EMBED && <div className="h-14 shrink-0 border-b border-line bg-page" />',
            project_client,
        )

    def test_canvas_home_launch_waits_for_hydration_and_executes_once(self):
        app = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "GithubPagesApp.tsx"
        ).read_text(encoding="utf-8")
        workspace = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "workspace"
            / "Workspace.tsx"
        ).read_text(encoding="utf-8")
        integration = (APP_DIR / "js/views/customCanvasIntegration.js").read_text(encoding="utf-8")

        self.assertIn('type: "workspace-ready"', app)
        self.assertIn('type: "home-launch-consumed"', app)
        self.assertIn("handledLaunches.current.has(launchId)", app)
        self.assertIn("const targetProjectId = createProject({", app)
        self.assertNotIn("const targetProjectId = currentProjectId() || createProject({", app)
        self.assertIn("sessionStorage.setItem(`aidc:brief:${targetProjectId}`", app)
        self.assertIn("sessionStorage.setItem(`aidc:refs:${targetProjectId}`", app)
        self.assertIn("generate(pending, { size: project?.targetSize })", workspace)
        self.assertIn("let canvasAppReady = false", integration)
        self.assertIn("flushPendingWorkspaceCommands", integration)
        self.assertIn("if (pendingLaunchPayload)", integration)
        self.assertIn("waitForCanvasProjectIndex", integration)
        self.assertIn("indexed: true", integration)
        self.assertIn("const announceCreatedProject = createdProjectId =>", integration)
        self.assertIn("if (launchProjectId) announceCreatedProject(launchProjectId)", integration)

    def test_canvas_embed_ui_keeps_entitlements_preview_and_collapsible_minimap(self):
        source_dir = APP_DIR / "apps" / "infinite-canvas-source" / "src"
        workspace = (source_dir / "components/workspace/Workspace.tsx").read_text(encoding="utf-8")
        panel = (source_dir / "components/workspace/AgentPanel.tsx").read_text(encoding="utf-8")
        messages = (source_dir / "components/workspace/AgentMessages.tsx").read_text(encoding="utf-8")
        bridge = (source_dir / "lib/platformBridge.ts").read_text(encoding="utf-8")
        integration = (APP_DIR / "js/views/customCanvasIntegration.js").read_text(encoding="utf-8")

        self.assertIn("canvasPlatformCapabilitiesFromBootstrap", workspace)
        self.assertIn("showPublish={allowPublish}", workspace)
        self.assertIn("allowPublish={allowPublish}", workspace)
        self.assertIn("bootstrap.canPublish === true", bridge)
        self.assertIn('return { canPublish: false }', bridge)
        self.assertIn("canPublish: Boolean(canPublish)", integration)
        self.assertIn('e.key === "Enter" && !e.shiftKey', panel)
        self.assertIn("e.nativeEvent.isComposing", panel)
        self.assertIn("starmatrix-mascot-transparent.png", messages)
        self.assertIn("CanvasMascotAvatar thinking", messages)
        self.assertIn("object-contain", messages)
        self.assertIn("onPreviewItem", workspace)
        self.assertIn("flex-nowrap", workspace)
        self.assertIn("whitespace-nowrap", workspace)
        self.assertIn("canvas-context-collapsed", integration)
        self.assertIn("canvasContextTools.classList.add(\"is-detached\")", integration)
        self.assertIn("bottom: 12px", integration)
        self.assertIn('child.classList.contains("workspace-account-footer")', integration)
        self.assertIn('activeShell.classList.add("has-canvas-context-tools")', integration)
        self.assertIn('window.addEventListener("view:rendered", onCanvasViewRendered)', integration)
        self.assertIn('window.removeEventListener("view:rendered", onCanvasViewRendered)', integration)

    def test_homepage_first_generation_uses_the_new_project_size(self):
        workspace = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "workspace"
            / "Workspace.tsx"
        ).read_text(encoding="utf-8")
        actions = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "workspace"
            / "useStudioActions.ts"
        ).read_text(encoding="utf-8")

        self.assertIn("generate(pending, { size: project?.targetSize })", workspace)
        self.assertIn('async (brief: string, options: { size?: string } = {})', actions)
        self.assertIn(
            "const size = options.size || state.composerSize || project.targetSize",
            actions,
        )
        self.assertNotIn("generate(pending);", workspace)

    def test_homepage_size_picker_explains_ratio_reference_and_pixel_units(self):
        source = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "home"
            / "HomeView.tsx"
        ).read_text(encoding="utf-8")
        self.assertIn("function aspectRatioLabel", source)
        self.assertIn("[3, 4]", source)
        self.assertIn("[9, 16]", source)
        self.assertIn("按参考图尺寸", source)
        self.assertIn("refs.map((reference, index)", source)
        self.assertIn("setSize(`${reference.width}x${reference.height}`)", source)
        self.assertNotIn("useEffect(() => setSize(`${reference.width}x${reference.height}`)", source)
        self.assertIn("自定义尺寸（单位：像素 px）", source)
        self.assertIn("自定义宽度（像素）", source)
        self.assertIn("自定义高度（像素）", source)
        self.assertIn("readClipboardImageFiles", source)
        self.assertIn("粘贴参考图", source)
        self.assertIn('e.key === "Enter" && !e.shiftKey', source)

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
        self.assertIn("正在准备发布", chunks)
        self.assertIn("ai-design-canvas:v2:", chunks)
        self.assertIn("xingzhen-canvas:", chunks)
        self.assertIn("project-state", chunks)
        self.assertIn("单次只生成一张完整成图", chunks)
        self.assertIn("禁止拼图、分屏或并排展示多个方案", chunks)

    def test_multi_reference_chat_edits_use_a_targeted_transform_contract(self):
        planner = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "lib"
            / "referenceEditPlan.ts"
        ).read_text(encoding="utf-8")
        actions = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "workspace"
            / "useStudioActions.ts"
        ).read_text(encoding="utf-8")
        api = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "lib"
            / "api.ts"
        ).read_text(encoding="utf-8")

        self.assertIn("planReferenceEdits", planner)
        self.assertIn("Explicit targets take priority", planner)
        self.assertIn("ALL_REFERENCE_WORDS", planner)
        self.assertIn("planReferenceEdits(brief, references.length)", actions)
        self.assertIn("Promise.all(", actions)
        self.assertIn("callTransform({", actions)
        self.assertIn("targetedReferenceIndex", actions)
        self.assertIn("references: styleReferences", actions)
        self.assertIn("const targetSize = `${target.width}x${target.height}`", actions)
        self.assertIn("size: targetSize", actions)
        self.assertIn("prompt: brief.trim()", actions)
        self.assertNotIn("这是对已选图 ${job.index + 1} 的定向编辑", actions)
        self.assertNotIn("size: `${job.source.naturalWidth}x${job.source.naturalHeight}`", actions)
        self.assertIn("export async function callTransform", api)

    def test_canvas_composer_accepts_clipboard_images_without_blocking_text_paste(self):
        panel = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "workspace"
            / "AgentPanel.tsx"
        ).read_text(encoding="utf-8")
        self.assertIn("onPaste={(e) => {", panel)
        self.assertIn("e.clipboardData.files", panel)
        self.assertIn("onAttachFiles(images)", panel)
        self.assertIn("e.stopPropagation()", panel)

    def test_multi_reference_planner_recognizes_fifty_edit_rounds_before_dispatch(self):
        """Fifty deterministic rounds cover target-only and parallel tasks.

        This test intentionally exercises the exact source planner but never
        sends a model request or writes canvas state.  It protects the handoff
        boundary: classification/task dispatch can be verified locally without
        creating user-facing images.
        """
        source = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "lib"
            / "referenceEditPlan.ts"
        ).read_text(encoding="utf-8")
        runnable = re.sub(
            r"export interface ReferenceEditPlan\s*\{.*?\n\}\n\n",
            "",
            source,
            flags=re.S,
        )
        runnable = runnable.replace("export function", "function")
        runnable = runnable.replace(
            "function chineseNumber(value: string): number | null {",
            "function chineseNumber(value) {",
        )
        runnable = runnable.replace(
            "const values: Record<string, number> = {", "const values = {"
        )
        runnable = runnable.replace(
            "function addIndex(targets: Set<number>, value: number | null, count: number) {",
            "function addIndex(targets, value, count) {",
        )
        runnable = runnable.replace("new Set<number>()", "new Set()")
        runnable = runnable.replace(
            "function planReferenceEdits(brief: string, referenceCount: number): ReferenceEditPlan | null {",
            "function planReferenceEdits(brief, referenceCount) {",
        )
        base_cases = [
            {"brief": "图2修改为暖色纸感，其他不变", "count": 2, "targets": [1]},
            {"brief": "将图2的背景调整为图1的浅蓝色，其余不变", "count": 2, "targets": [1]},
            {"brief": "以图1的浅蓝背景统一图2的视觉底色，保留原主体与文字", "count": 2, "targets": [1]},
            {"brief": "把这两个参考图都换成暖色纸感", "count": 2, "targets": [0, 1]},
            {"brief": "两个参考图分别优化质感", "count": 2, "targets": [0, 1]},
            {"brief": "所有参考图同时调整成商务蓝", "count": 3, "targets": [0, 1, 2]},
            {"brief": "每张参考图都换成极简风", "count": 3, "targets": [0, 1, 2]},
            {"brief": "图1和图3都编辑成黑金风格", "count": 3, "targets": [0, 2]},
            {"brief": "统一图2的配色为蓝色", "count": 2, "targets": [1]},
            {"brief": "把图1、图2都改为胶片风格", "count": 2, "targets": [0, 1]},
        ]
        cases = [
            {**case, "brief": f"{case['brief']}，第{round_index + 1}轮检查"}
            for round_index in range(5)
            for case in base_cases
        ]
        script = (
            runnable
            + "\nconst cases = "
            + json.dumps(cases, ensure_ascii=False)
            + ";\nconsole.log(JSON.stringify(cases.map(item => ({ ...item, plan: planReferenceEdits(item.brief, item.count) }))));\n"
        )
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        rounds = json.loads(result.stdout)
        self.assertEqual(len(rounds), 50)
        for round_ in rounds:
            self.assertIsNotNone(round_["plan"], round_["brief"])
            self.assertEqual(round_["plan"]["targetIndexes"], round_["targets"], round_["brief"])
            expected_mode = "parallel" if len(round_["targets"]) > 1 else "single"
            self.assertEqual(round_["plan"]["mode"], expected_mode, round_["brief"])

    def test_static_canvas_links_keep_base_path_and_embed_query(self):
        runtime = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "lib"
            / "runtime.ts"
        ).read_text(encoding="utf-8")
        project_card = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "home"
            / "ProjectCard.tsx"
        ).read_text(encoding="utf-8")

        self.assertIn('const query = IS_PLATFORM_EMBED ? "?embed=1" : "";', runtime)
        self.assertIn('return `${basePath}/${query}#${route}`;', runtime)
        self.assertIn('staticHashHref(`/project/${id}`)', runtime)
        self.assertIn('staticHashHref("/")', runtime)
        self.assertNotIn('IS_GITHUB_PAGES ? `/#/project/${id}`', runtime)
        self.assertNotIn('IS_GITHUB_PAGES ? "/#/"', runtime)
        self.assertEqual(project_card.count("href={projectHref(project.id)}"), 2)
        self.assertEqual(project_card.count("onClick={openProject}"), 2)

    def test_project_detail_selectors_keep_stable_empty_snapshots(self):
        project_client = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "workspace"
            / "ProjectClient.tsx"
        ).read_text(encoding="utf-8")
        overlays = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "workspace"
            / "overlays.tsx"
        ).read_text(encoding="utf-8")

        self.assertIn("useStore(selectItems(projectId))", project_client)
        self.assertIn("useStore(selectMessages(projectId))", project_client)
        self.assertNotIn("state.itemsByProject[projectId] || []", project_client)
        self.assertNotIn("state.messagesByProject[projectId] || []", project_client)
        self.assertIn("useStore(selectItems(item.projectId))", overlays)

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

        tracked_files = subprocess.run(
            [
                "git",
                "-c",
                "core.quotepath=false",
                "ls-files",
                "-z",
                "--",
                "自动化产品/apps/infinite-canvas-source",
            ],
            cwd=APP_DIR.parent,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.split("\0")
        tracked_files = [path for path in tracked_files if path]
        forbidden_names = {".env.local", ".next", "node_modules", ".cache", "out"}
        tracked_parts = {part for path in tracked_files for part in Path(path).parts}
        self.assertTrue(forbidden_names.isdisjoint(tracked_parts))
        self.assertFalse(any((APP_DIR.parent / path).is_symlink() for path in tracked_files))

        source_text = "\n".join(
            (APP_DIR.parent / path).read_text(encoding="utf-8", errors="ignore")
            for path in tracked_files
            if (APP_DIR.parent / path).suffix
            in {".ts", ".tsx", ".js", ".json", ".md", ".mjs", ".example"}
        )
        self.assertNotIn("/Users/", source_text)
        self.assertNotIn("Desktop/百度/图片生产平台", source_text)
        self.assertIn("/api/custom-canvas", source_text)
        self.assertIn("xingzhen-canvas", source_text)
        self.assertIn("splitCanvasPersistence", source_text)
        self.assertIn("readCanvasProject", source_text)
        self.assertIn('const CANVAS_DB_STORE = "project-state"', source_text)
        self.assertIn('type: "performance"', source_text)
        self.assertIn('stage: "hydration"', source_text)
        self.assertIn('type: "publish-request"', source_text)
        self.assertIn("items: [{ ...item }]", source_text)
        self.assertIn("disabled={!canPublish || publishing}", source_text)
        self.assertIn("renderCanvasOutput", source_text)
        self.assertIn("overlappingMarksFor(selectedImage, reactiveItems)", source_text)
        self.assertIn("onPublish={requestPublish}", source_text)
        self.assertIn('aria-label={publishing ? "正在准备发布" : "发布"}', source_text)
        self.assertIn("navigateToProject(router, project.id)", source_text)
        self.assertIn("publishedItemIds?.includes(item.id)", source_text)
        self.assertIn("publishedItemIds.includes(results[0].id)", source_text)
        self.assertIn("publishedItemIds.includes(r.id)", source_text)
        self.assertIn("该图片已提交发布", source_text)
        env_example = (source_dir / ".env.example").read_text(encoding="utf-8")
        for line in env_example.splitlines():
            if line.startswith(("MAAS_API_KEY=", "MAAS_CHAT_API_KEY=")):
                self.assertEqual(line.split("=", 1)[1], "")

    def test_canvas_language_model_retries_only_transient_failures(self):
        source = (APP_DIR / "apps/infinite-canvas-source/src/lib/maas.ts").read_text(encoding="utf-8")
        self.assertIn("class ChatProviderError", source)
        self.assertIn("!isPermanentLimit(message)", source)
        self.assertIn("if (!(error instanceof ChatProviderError) || !error.retryable) throw error", source)
        self.assertNotIn("catch {\n    // Upstream 502s are transient", source)

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
            "{ onOutput, onPublishRequest, onCommunityShareRequest, projectId = \"\", canPublish = false, launchPayload = null } = {}",
            integration,
        )
        self.assertIn(
            'let currentProjectId = safeText(projectId, "", 180)',
            integration,
        )
        self.assertIn('fetch("/api/custom-canvas/projects"', integration)
        self.assertIn("currentProjectId = await loadRecentProjectId(token, controller.signal)", integration)
        self.assertIn('childDocument.documentElement.dataset.platformWorkspace = "true"', integration)
        self.assertIn('style.id = "xingzhenCanvasEmbedStyle"', integration)
        self.assertIn('button[aria-label="返回"]', integration)
        self.assertIn('a[href$="#/"]', integration)
        self.assertIn('dock.dataset.canvasContextTools = "true"', integration)
        self.assertIn('class="canvas-context-portal"', integration)
        self.assertIn('data-canvas-context-portal="${canvasContextPortalNonce}"', integration)
        self.assertIn("contextPortalId: canvasContextPortalId", integration)
        self.assertIn("contextPortalNonce: canvasContextPortalNonce", integration)
        self.assertNotIn("data-canvas-control=", integration)
        self.assertNotIn("dataset.platformCanvasControls", integration)
        self.assertLess(
            integration.index("installCanvasContextTools();\n    iframe ="),
            integration.index('iframe.name = JSON.stringify(canvasBootstrap)'),
        )
        self.assertIn('childWindow.addEventListener("hashchange", keepProjectRoute)', integration)
        self.assertIn("childWindow.location.replace(projectHash(currentProjectId))", integration)
        self.assertIn("removeCanvasRouteGuard()", integration)
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
        self.assertIn('fetch("/api/custom-canvas/session"', integration)
        self.assertIn('method: "POST"', integration)
        self.assertIn('credentials: "same-origin"', integration)
        self.assertLess(
            integration.index('fetch("/api/custom-canvas/session"'),
            integration.index('fetch("/api/custom-canvas/config"'),
        )
        self.assertIn("width:100%;height:100%;min-height:0", integration)
        self.assertNotIn("min-height:640px", integration)
        self.assertIn("background:#fff", integration)
        self.assertIn("data-custom-canvas-loading", integration)
        self.assertIn("if (!currentProjectId) {", integration)
        self.assertIn(
            "currentProjectId = await loadRecentProjectId(token, controller.signal)",
            integration,
        )
        self.assertIn("if (!iframe) return mountCanvasFrame()", integration)
        self.assertIn('{ type: "custom-canvas:create-project" }', integration)
        self.assertRegex(
            integration,
            r"iframe\.src = `/XZ-Design/\?embed=1&v=[^`$]+\$\{projectHash\(currentProjectId\)\}`",
        )
        self.assertIn('return value ? `#/project/${encodeURIComponent(value)}` : "#/"', integration)
        self.assertNotRegex(
            integration,
            r'iframe\.src = "/XZ-Design/\?embed=1&v=[^"]+#/"',
        )
        source = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "components"
            / "workspace"
            / "Canvas.tsx"
        ).read_text(encoding="utf-8")
        bridge = (
            APP_DIR
            / "apps"
            / "infinite-canvas-source"
            / "src"
            / "lib"
            / "platformBridge.ts"
        ).read_text(encoding="utf-8")
        self.assertIn("createPortal(controls, contextPortal.target)", source)
        self.assertIn('data-canvas-viewport-controls={portaled ? "context" : "canvas"}', source)
        self.assertIn('className="canvas-viewport-minimap', source)
        self.assertIn("setViewport(projectId", source)
        self.assertIn("canvasContextPortalFromBootstrap", bridge)
        self.assertIn("contextPortalNonce", bridge)

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

    async def test_generation_returns_exact_selected_pixels_and_requires_reference_receipt(self):
        captured = []

        async def fake_generate(req):
            captured.append(req)
            return {
                "dataUrl": png_data_url(1152, 1536),
                "usedRefs": 1,
                "skippedRefs": 0,
                "ratio": "3:4",
                "model": "test-image",
                "mode": "gpt-maas",
            }

        refs = [main.ImageRef(role="custom", dataUrl=png_data_url())]
        with patch.object(main, "image_generate", new=AsyncMock(side_effect=fake_generate)):
            result = await main._custom_canvas_generated_image("真实产品海报", "1242x1660", refs)

        self.assertEqual(result["width"], 1242)
        self.assertEqual(result["height"], 1660)
        self.assertEqual(png_size(result["dataUrl"]), (1242, 1660))
        self.assertEqual(result["usedRefs"], 1)
        self.assertTrue(captured[0].strictRatio)
        self.assertEqual(captured[0].ratio, "3:4")
        self.assertEqual(captured[0].size, "1248x1664")
        self.assertTrue(captured[0].exactPrompt)
        self.assertEqual(captured[0].prompt, "真实产品海报")
        self.assertEqual(len(captured[0].refs), 1)

        with patch.object(main, "image_generate", new=AsyncMock(return_value={
            "dataUrl": png_data_url(),
            "usedRefs": 0,
            "skippedRefs": 1,
            "ratio": "3:4",
        })):
            with self.assertRaises(HTTPException) as raised:
                await main._custom_canvas_generated_image("真实产品海报", "1242x1660", refs)
        self.assertEqual(raised.exception.status_code, 502)
        self.assertIn("参考图未完整送达", raised.exception.detail)

    async def test_twenty_wide_edits_keep_exact_prompt_pixels_and_full_frame(self):
        prompt = (
            "将海报二级文案调整为【“芯云模体”全栈能力持续升级，服务大规模智能体应用】；"
            "将左下角文案改为【新一代全栈AI云｜芯片·云·模型·智能体】；"
            "海报其他元素全部保持不变"
        )
        captured = []

        async def fake_generate(req):
            captured.append(req)
            return {
                "dataUrl": striped_png_data_url(3504, 1168),
                "usedRefs": 1,
                "skippedRefs": 0,
                "ratio": "16:9",
                "model": "test-image",
            }

        source = main.ImageRef(role="custom", dataUrl=striped_png_data_url(3496, 1022))
        with patch.object(main, "image_generate", new=AsyncMock(side_effect=fake_generate)):
            results = [
                await main._custom_canvas_generated_image(
                    prompt,
                    "3496x1022",
                    [source],
                    adapt_primary_reference=True,
                )
                for _ in range(20)
            ]

        self.assertEqual(len(captured), 20)
        for request, result in zip(captured, results):
            self.assertEqual(request.prompt, prompt)
            self.assertNotIn("比例", request.prompt)
            self.assertNotIn("最终交付像素", request.prompt)
            self.assertEqual(request.size, "3504x1168")
            self.assertTrue(request.exactPrompt)
            self.assertEqual(png_size(request.refs[0].dataUrl), (3504, 1168))
            self.assertEqual((result["width"], result["height"]), (3496, 1022))
            self.assertEqual(png_size(result["dataUrl"]), (3496, 1022))

    def test_exact_resize_keeps_all_edges_without_blurred_fill_or_crop(self):
        output = main._custom_canvas_resize_exact_pixels(
            striped_png_data_url(),
            342,
            100,
        )
        encoded = output.split(",", 1)[1]
        with main.Image.open(io.BytesIO(base64.b64decode(encoded))) as rendered:
            top = rendered.getpixel((171, 1))
            bottom = rendered.getpixel((171, 98))
            self.assertEqual(rendered.size, (342, 100))
        self.assertGreater(top[0], 180)
        self.assertLess(top[2], 100)
        self.assertGreater(bottom[2], 160)
        self.assertLess(bottom[0], 100)
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertNotIn("GaussianBlur", source)
        self.assertNotIn("ImageOps.fit(", source[source.index("def _custom_canvas_resize_exact_pixels"):source.index("def _custom_canvas_data_url")])

    def test_primary_reference_adaptation_accepts_common_upload_formats(self):
        if not main.Image:
            self.skipTest("Pillow is required for custom-canvas image output tests")
        formats = ["PNG", "JPEG"]
        if "WEBP" in set(main.Image.registered_extensions().values()):
            formats.append("WEBP")
        for image_format in formats:
            with self.subTest(image_format=image_format):
                refs = [
                    main.ImageRef(
                        role="custom",
                        dataUrl=image_data_url(image_format, 320, 180),
                    )
                ]
                adapted = main._custom_canvas_adapt_primary_reference(refs, 336, 192)
                self.assertEqual(png_size(adapted[0].dataUrl), (336, 192))
                self.assertEqual(adapted[0].mime, "image/png")

    def test_custom_canvas_master_uses_structured_size_without_prompt_ratio(self):
        self.assertEqual(main._custom_canvas_master_size(3496, 1022), (3504, 1168))
        self.assertEqual(main._validated_maas_image_size("3504x1168"), "3504x1168")
        self.assertEqual(main._validated_maas_image_size("3496x1022"), "")
        body = main._maas_image_body(
            "只修改副标题，其他保持不变",
            "custom-imagemodel-gt",
            "16:9",
            [],
            size="3504x1168",
        )
        self.assertEqual(body["prompt"], "只修改副标题，其他保持不变")
        self.assertEqual(body["size"], "3504x1168")

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
            image=png_data_url(1242, 1660),
            mask=png_data_url(1242, 1660),
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
                new=AsyncMock(return_value=png_data_url(1152, 1536)),
            ))
            stack.enter_context(patch.object(main.httpx, "AsyncClient", return_value=DummyClient()))
            result = await main._custom_canvas_mask_edit(request)

        self.assertEqual(result["width"], 1242)
        self.assertEqual(result["height"], 1660)
        self.assertEqual(png_size(result["dataUrl"]), (1242, 1660))
        self.assertEqual(png_size(captured["body"]["mask"]["image_url"]), (1248, 1664))
        self.assertEqual(captured["body"]["size"], "1248x1664")
        self.assertEqual(captured["body"]["input_fidelity"], "high")
        self.assertEqual(len(captured["body"]["images"]), 1)
        self.assertTrue(captured["endpoint"].endswith("/aiart/gtimage"))

    async def test_targeted_transform_keeps_target_first_and_style_donors_after_it(self):
        target = "data:image/png;base64,TARGET"
        donor = "data:image/png;base64,DONOR"
        request = main.CustomCanvasTransformReq(
            image=target,
            references=[donor],
            prompt="将图2的背景调整为图1的浅蓝色",
            size="1242x1660",
        )
        with patch.object(
            main,
            "_custom_canvas_generated_image",
            new=AsyncMock(return_value={"dataUrl": "data:image/png;base64,RESULT", "width": 1152, "height": 1536}),
        ) as generate, patch.object(
            main,
            "_quota_begin",
            return_value={"bypassed": True, "status": "bypassed", "points": 0},
        ), patch.object(
            main.store,
            "issue_custom_canvas_generation_receipt",
            return_value={"token": "receipt-targeted-transform"},
        ):
            result = await main.custom_canvas_transform(request, me={"id": "creator", "role": "editor"})

        self.assertEqual(result["image"]["dataUrl"], "data:image/png;base64,RESULT")
        self.assertEqual(result["image"]["generationReceipt"], "receipt-targeted-transform")
        prompt, _size, refs = generate.await_args.args
        self.assertEqual([ref.dataUrl for ref in refs], [target, donor])
        self.assertTrue(prompt.startswith(request.prompt))
        self.assertIn("第一张输入图是唯一待编辑原图", prompt)
        self.assertIn("后续图片只作为视觉参考", prompt)
        self.assertTrue(generate.await_args.kwargs["adapt_primary_reference"])

    async def test_single_target_transform_preserves_user_prompt_verbatim(self):
        prompt = "仅将副标题改为「服务大规模智能体应用」，其他元素全部保持不变"
        request = main.CustomCanvasTransformReq(
            image=png_data_url(3496, 1022),
            prompt=prompt,
            size="3496x1022",
        )
        with patch.object(
            main,
            "_custom_canvas_generated_image",
            new=AsyncMock(return_value={"dataUrl": png_data_url(), "width": 3496, "height": 1022}),
        ) as generate, patch.object(
            main,
            "_quota_begin",
            return_value={"bypassed": True, "status": "bypassed", "points": 0},
        ), patch.object(
            main.store,
            "issue_custom_canvas_generation_receipt",
            return_value={"token": "receipt-single-transform"},
        ):
            await main.custom_canvas_transform(request, me={"id": "creator", "role": "editor"})

        self.assertEqual(generate.await_args.args[0], prompt)
        self.assertEqual(generate.await_args.args[1], "3496x1022")
        self.assertEqual(len(generate.await_args.args[2]), 1)
        self.assertTrue(generate.await_args.kwargs["adapt_primary_reference"])

    def test_config_is_creator_only_and_reports_export_bridge(self):
        result = main.custom_canvas_config(me={"id": "creator", "role": "editor"})
        self.assertTrue(result["available"])
        self.assertIn("export-bridge", result["features"])
        with self.assertRaises(HTTPException) as raised:
            main.custom_canvas_config(me={"id": "supplier", "role": "supplier_parent"})
        self.assertEqual(raised.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
