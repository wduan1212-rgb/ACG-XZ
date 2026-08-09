import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class V105DetailFixesTest(unittest.TestCase):
    def read(self, relative):
        return (APP_DIR / relative).read_text(encoding="utf-8")

    def test_recent_delivery_uses_image_first_frame_and_video_cover(self):
        studio = self.read("js/views/studio.js")
        self.assertIn("p.artifacts?.images?.items", studio)
        self.assertIn("p.artifacts?.boards?.cover?.assetId", studio)
        self.assertIn("deliveryAsset?.coverAssetId", studio)
        self.assertIn('loading="lazy" decoding="async"', studio)

    def test_completed_batch_prefers_video_cover_then_first_frame(self):
        cards = self.read("js/agent/cards.js")
        styles = self.read("styles/agent.css")
        results = cards.split("results(m)", 1)[1].split("/* 错误卡 */", 1)[0]
        self.assertIn("p.artifacts?.boards?.cover?.assetId", results)
        self.assertIn("deliveryAsset?.coverAssetId", results)
        self.assertIn("p.artifacts?.finalVideoUrl", results)
        self.assertIn('aria-label="视频首帧"', results)
        self.assertLess(
            results.index("coverUrl"),
            results.index("finalVideoUrl"),
        )
        self.assertIn(".agres-item video", styles)

    def test_digital_human_edit_does_not_reuse_old_audio(self):
        workshop = self.read("js/views/chainWorkshop.js")
        segment_merge = workshop.split("function digitalSegmentsFromShots", 1)[1].split(
            "function digitalSegmentsForDisplay", 1
        )[0]
        self.assertIn("const matchedByLine = oldIndex >= 0", segment_merge)
        self.assertIn("if (matchedByLine)", segment_merge)
        self.assertLess(segment_merge.index("if (matchedByLine)"), segment_merge.index("oldSeg?.audioAssetId"))
        self.assertIn('$("#wsDhVideoAll"', workshop)
        self.assertIn("syncNarrationFromEditor({ silent: true });", workshop)

    def test_short_subtitle_blocks_do_not_overlap_visually(self):
        cut = self.read("js/views/chainCut.js")
        styles = self.read("styles/views.css")
        self.assertIn("const cueWidth = Math.max(6", cut)
        self.assertNotIn("Math.max(24, ((s.end", cut)
        self.assertIn('cueWidth < 28 ? "is-compact"', cut)
        self.assertIn(".tl-sub.is-compact", styles)

    def test_cover_and_info_flow_retry_are_single_click_resilient(self):
        workshop = self.read("js/views/chainWorkshop.js")
        ai = self.read("js/api/ai.js")
        self.assertIn("ensureVideoCover(p, { force = false, onStatus = null } = {})", workshop)
        self.assertIn("ensureVideoCover(p, { force: true, onStatus: draw })", workshop)
        self.assertNotIn("draw();\n        await ensureVideoCover(p);", workshop)
        draft = ai.split("async generateCustomVideoDraft", 1)[1].split(
            "async generateInfoFlowCreativePlan", 1
        )[0]
        self.assertIn("for (let attempt = 0; attempt < 2; attempt++)", draft)
        self.assertIn("上一版没有通过完整性校验", draft)
        self.assertIn("ensureFirstPersonNarration", draft)
        self.assertNotIn("模型口播缺少第一人称视角", draft)
        self.assertNotIn("_mockCopy", draft)

    def test_info_flow_defaults_to_no_subtitles_and_video_delivery_requires_composite(self):
        productions = self.read("js/domain/productions.js")
        cut = self.read("js/views/chainCut.js")
        delivery = self.read("js/domain/delivery.js")
        self.assertIn("p.artifacts.subs = isInfoFlow ? [] : subs", productions)
        self.assertIn('p.artifacts.subTimingSource !== "manual"', productions)
        self.assertIn("legacyInfoFlowCaptions", cut)
        self.assertIn('prompt-speech-timeline-v3-manual', cut)
        self.assertIn("if (needsCompose())", cut)
        self.assertNotIn("if (videoJobsComplete() && needsCompose())", cut)
        self.assertIn("完整成片尚未合成", delivery)
        self.assertIn("视频交付缺少完整成片，已停止生成不完整 ZIP", delivery)
        self.assertNotIn("视频说明.txt", delivery)

    def test_voice_gender_is_preserved_end_to_end(self):
        providers = self.read("js/api/providers.js")
        backend = self.read("server/main.py")
        self.assertIn('gender = /女声|女生|女性|少女', providers)
        self.assertIn("body: JSON.stringify({", providers)
        self.assertIn("prompt: cleanPrompt", providers)
        self.assertIn("previewText: cleanPreview", providers)
        self.assertIn("name: sanitizeXhsText(name)", providers)
        self.assertIn("gender,", providers)
        self.assertIn("idempotencyKey: requestKey", providers)
        self.assertIn('gender: str = ""', backend)
        self.assertIn("必须生成女性声线", backend)
        self.assertIn("anchored_prompt", backend)
        self.assertIn("情绪、生活化程度、音色质感、语速与使用场景", backend)
        self.assertIn("用户音色描述：{prompt}", backend)

    def test_video_history_uses_compact_glass_dialog_and_speed_versions(self):
        app = self.read("apps/video-workshop/web/assets/app.js")
        styles = self.read("apps/video-workshop/web/assets/styles.css")
        backend = self.read("apps/video-workshop/app/main.py")
        pipeline = self.read("apps/video-workshop/app/pipeline.py")
        self.assertIn("backdrop-filter: blur(28px) saturate(120%)", styles)
        self.assertIn("height: clamp(230px, 34vh, 420px)", styles)
        self.assertIn("history-download-action", app)
        self.assertIn("bottom: calc(100% + 9px)", styles)
        self.assertIn("createSpeedVersion", app)
        self.assertIn("/speed-version", app)
        self.assertIn('@app.post("/api/projects/{project_id}/speed-version")', backend)
        self.assertIn("DEFAULT_DELIVERY_SPEED = 1.2", pipeline)

    def test_custom_publish_accounts_are_scoped_and_marked(self):
        publishing = self.read("js/views/customPublish.js")
        accounts = self.read("js/domain/accounts.js")
        cards = self.read("js/agent/cards.js")
        studio = self.read("js/views/studio.js")
        self.assertIn('kind !== "video" || groupOf(account) === "素材"', publishing)
        self.assertIn("accountCreationQuota(account.id)", publishing)
        self.assertIn("export function accountCreatedToday", accounts)
        self.assertIn("accountCreationQuota(a.id)", cards)
        self.assertIn("accountCreationQuota(acc.id)", studio)

    def test_infinite_canvas_interactions_reuse_existing_selection_store(self):
        home = self.read("apps/infinite-canvas-source/src/components/home/HomeView.tsx")
        workspace = self.read("apps/infinite-canvas-source/src/components/workspace/Workspace.tsx")
        studio_actions = self.read("apps/infinite-canvas-source/src/components/workspace/useStudioActions.ts")
        canvas = self.read("apps/infinite-canvas-source/src/components/workspace/Canvas.tsx")
        overlays = self.read("apps/infinite-canvas-source/src/components/workspace/overlays.tsx")
        globals_css = self.read("apps/infinite-canvas-source/src/app/globals.css")
        store_zip = self.read("apps/infinite-canvas-source/src/lib/storeZip.ts")
        topbar = self.read("apps/infinite-canvas-source/src/components/workspace/TopBar.tsx")
        sizing = self.read("apps/infinite-canvas-source/src/lib/sizing.ts")
        constants = self.read("apps/infinite-canvas-source/src/lib/constants.ts")
        badge = self.read("apps/infinite-canvas-source/src/components/SizePlanBadge.tsx")
        self.assertIn("function clipboardImageFiles", home)
        self.assertIn("onPaste={(e) =>", home)
        self.assertIn("attachFiles(images)", home)
        self.assertIn("解除自定义尺寸比例锁定", home)
        self.assertIn("<Lock size={12}", home)
        self.assertIn('e.key.toLowerCase() === "c"', workspace)
        self.assertIn('window.addEventListener("paste", onPaste)', workspace)
        self.assertIn('e.key === "ArrowLeft" || e.key === "ArrowRight"', workspace)
        self.assertIn("if (lightbox) return;", workspace)
        self.assertIn("onActiveChange={(nextItem) =>", workspace)
        self.assertIn("batchExportSelection", workspace)
        self.assertIn("buildStoreZip(entries)", workspace)
        self.assertIn('type: "application/zip"', store_zip)
        self.assertIn("findFreeSpot(cur, anchorFor(cur), fp, 28)", studio_actions)
        self.assertIn("findFreeSpot(items, anchorFor(items), fp, 28)", workspace)
        self.assertNotIn("visibleAnchorFor", studio_actions)
        self.assertIn('type GestureMode = "idle" | "pan" | "drag" | "resize" | "select"', canvas)
        self.assertIn("setSelection([...new Set([...current, ...picked])])", canvas)
        self.assertIn("ratioLocked", overlays)
        self.assertIn("<Lock", overlays)
        self.assertIn('e.key === "ArrowLeft" || e.key === "ArrowRight"', overlays)
        self.assertIn("左右键切换", overlays)
        self.assertIn("onActiveChange?.(nextItem)", overlays)
        self.assertIn("lightbox-switch-next", globals_css)
        self.assertIn("lightbox-switch-previous", globals_css)
        self.assertIn("批量导出", topbar)
        self.assertIn("完整适配为 ${W}×${H}", sizing)
        self.assertIn("保持主体构图并按目标尺寸输出", sizing)
        self.assertNotIn("裁切为 ${W}×${H}", sizing)
        self.assertNotIn("生成后裁切", sizing)
        self.assertNotIn("保持原比例与主体构图", sizing)
        self.assertIn("不裁切、不补模糊背景", constants)
        self.assertNotIn("尺寸转译与裁切建议", constants)
        self.assertIn("比例不同会完整适配到目标尺寸", overlays)
        self.assertNotIn("比例不同会裁切到目标尺寸", overlays)
        self.assertIn('"自动适配"', badge)


if __name__ == "__main__":
    unittest.main()
