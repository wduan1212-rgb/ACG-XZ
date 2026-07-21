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
        self.assertIn("未把 ${sourceCount", delivery)

    def test_voice_gender_is_preserved_end_to_end(self):
        providers = self.read("js/api/providers.js")
        backend = self.read("server/main.py")
        self.assertIn('gender = /女声|女生|女性|少女', providers)
        self.assertIn("JSON.stringify({ prompt: cleanPrompt, previewText: cleanPreview, name: sanitizeXhsText(name), gender })", providers)
        self.assertIn('gender: str = ""', backend)
        self.assertIn("必须生成女性声线", backend)
        self.assertIn("anchored_prompt", backend)

    def test_custom_publish_accounts_are_scoped_and_marked(self):
        publishing = self.read("js/views/customPublish.js")
        accounts = self.read("js/domain/accounts.js")
        cards = self.read("js/agent/cards.js")
        studio = self.read("js/views/studio.js")
        self.assertIn('kind !== "video" || groupOf(account) === "素材"', publishing)
        self.assertIn("accountCreatedToday(account.id)", publishing)
        self.assertIn("export function accountCreatedToday", accounts)
        self.assertIn("accountCreatedToday(a.id)", cards)
        self.assertIn("accountCreatedToday(acc.id)", studio)

    def test_infinite_canvas_interactions_reuse_existing_selection_store(self):
        workspace = self.read("apps/infinite-canvas-source/src/components/workspace/Workspace.tsx")
        canvas = self.read("apps/infinite-canvas-source/src/components/workspace/Canvas.tsx")
        overlays = self.read("apps/infinite-canvas-source/src/components/workspace/overlays.tsx")
        topbar = self.read("apps/infinite-canvas-source/src/components/workspace/TopBar.tsx")
        self.assertIn('e.key.toLowerCase() === "c"', workspace)
        self.assertIn('window.addEventListener("paste", onPaste)', workspace)
        self.assertIn('e.key === "ArrowLeft" || e.key === "ArrowRight"', workspace)
        self.assertIn("batchExportSelection", workspace)
        self.assertIn('type GestureMode = "idle" | "pan" | "drag" | "resize" | "select"', canvas)
        self.assertIn("setSelection([...new Set([...current, ...picked])])", canvas)
        self.assertIn("ratioLocked", overlays)
        self.assertIn("<Lock", overlays)
        self.assertIn("批量导出", topbar)


if __name__ == "__main__":
    unittest.main()
