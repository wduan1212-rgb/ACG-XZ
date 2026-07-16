import json
import subprocess
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class DigitalWorkflowTest(unittest.TestCase):
    def test_narration_is_replanned_near_thirty_seconds(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[] };
const m = await import('./js/views/chainWorkshop.js');
const shots = [55,55,80,70].map((n, i) => ({ line: String.fromCharCode(65 + i).repeat(n) + '。' }));
console.log(JSON.stringify(m.planDigitalNarrationSegments(shots).map(x => x.dur)));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        durations = json.loads(result.stdout.strip())
        self.assertEqual(durations, [22, 30])
        self.assertTrue(all(duration <= 30 for duration in durations))

    def test_cut_page_does_not_auto_compose_on_render(self):
        source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        self.assertNotIn("queueMicrotask(() => composeFinal", source)
        self.assertIn("audioTimingAttemptSig", source)
        self.assertIn("COMPOSE_TIMEOUT_MS", source)

    def test_creator_analytics_has_account_filter(self):
        source = (APP_DIR / "js/views/analyticsView.js").read_text(encoding="utf-8")
        self.assertIn('id="daAccountFilter"', source)
        self.assertIn("accountMatch", source)

    def test_material_subtitles_use_stable_recognition_and_manual_track_is_preserved(self):
        source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        self.assertIn('const usesEstimatedMaterialCaptions = () => !isDigitalHuman()', source)
        self.assertIn('mode: isDigitalHuman() ? "digital-human" : "info-flow"', source)
        self.assertIn("timedSpeechHintsForClip", source)
        self.assertIn("explicitSpeechLines", source)
        self.assertIn("strict: usesEstimatedMaterialCaptions()", source)
        self.assertIn('subTimingSource = "audio-analysis-v5"', source)
        self.assertIn('source.startsWith("audio-analysis-v5")', source)
        self.assertIn("没有在真实音轨中确认到提示词口播", source)
        self.assertNotIn('subTimingSource = "estimated-material-v2"', source)
        self.assertNotIn("estimateInfoFlowCaptions", source)
        self.assertIn('s.text = e.target.value;\n      p.artifacts.subTimingSource = "manual"', source)
        self.assertNotIn("script.shots?.[index]?.line", source)
        self.assertNotIn("任意引号", source)

    def test_old_account_classification_prompts_are_removed(self):
        active_paths = [
            APP_DIR / "js/api/prompts.js",
            APP_DIR / "js/api/ai.js",
            APP_DIR / "js/domain/accounts.js",
            APP_DIR / "js/agent/intent.js",
            APP_DIR / "js/agent/cards.js",
            APP_DIR / "js/agent/orchestrator.js",
            APP_DIR / "js/views/chainWorkshop.js",
        ]
        source = "\n".join(path.read_text(encoding="utf-8") for path in active_paths)
        for stale in ("宝妈", "宝爸", "职场效率", "家庭管理", "学生教培", "岗位垂类", "TAG_POOL", "tagsOf("):
            self.assertNotIn(stale, source)
        self.assertNotIn("qtags", (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8"))
        for path in (
            APP_DIR / "js/data/xhsAccountsSeed.js",
            APP_DIR / "js/data/accountProfilesSeed.js",
            APP_DIR / "js/core/migrate.js",
        ):
            self.assertNotIn("qtags", path.read_text(encoding="utf-8"), path)

    def test_final_compose_tracks_bgm_and_preserves_clip_voice(self):
        source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        backend = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        self.assertIn("finalVideoMixSig", source)
        self.assertIn("p.artifacts.finalVideoMixSig !== mixSignature()", source)
        self.assertIn("preserveClipAudio: isDigitalHuman()", source)
        self.assertIn("def _media_has_audio", backend)
        self.assertIn("amix=inputs=2:duration=longest", backend)
        self.assertIn('time.time_ns()', backend)

    def test_whisper_gibberish_guard_and_plain_dashboard_chat(self):
        backend = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        overview = (APP_DIR / "js/views/overview.js").read_text(encoding="utf-8")
        self.assertIn("def _usable_transcript_text", backend)
        self.assertIn("□■▢▣�", backend)
        self.assertIn("function plainAssistantText", overview)
        self.assertIn('data-overview-account=', overview)
        self.assertIn("逐条查看赞、藏、评与播放", overview)

    def test_cut_preview_has_digital_human_crossfade_layer(self):
        source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles/views.css").read_text(encoding="utf-8")
        self.assertIn('id="cpVideoNext"', source)
        self.assertIn('const transition = isDigitalHuman() && nextClip ? 0.35 : 0', source)
        self.assertIn('.cp-video-next', styles)

    def test_image_prompt_pipeline_has_no_fixed_office_fallback(self):
        source = (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8")
        self.assertNotIn("文件资料归档、字段提取、整理前后变化", source)
        self.assertNotIn("发布文案主题是", source)
        self.assertNotIn("生成小红书笔记风格3:4尺寸图片", source)
        self.assertIn("最终发布标题和正文是图片内容的唯一事实来源", source)
        self.assertIn("stripImagePlanningInstructions(stripPromptScaffold", source)

    def test_single_image_prompt_only_keeps_color_and_art_style(self):
        script = r"""
const m = await import('./js/core/util.js');
const result = m.singleImageGenerationPrompt(
  '一张百度搭子和codex的对比图',
  '暖白#FFF7ED底，橙色强调，简笔画火柴人，四格排版，人物坐在桌前，圆角卡片和大标题'
);
console.log(result);
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        self.assertTrue(result.startswith("一张百度搭子和codex的对比图\n视觉参考："))
        self.assertNotIn("四格排版", result)
        self.assertNotIn("人物坐在桌前", result)
        self.assertNotIn("圆角卡片", result)

    def test_batch_refine_and_creator_member_visibility_regressions(self):
        drawer = (APP_DIR / "js/views/prodDrawer.js").read_text(encoding="utf-8")
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        settings = (APP_DIR / "js/views/settings.js").read_text(encoding="utf-8")
        analytics = (APP_DIR / "js/views/analyticsView.js").read_text(encoding="utf-8")
        self.assertIn("本张参考图", drawer)
        self.assertIn("data-ref-replace", drawer)
        self.assertIn("data-ref-remove", drawer)
        self.assertIn('hasOwnProperty.call(item, "refAssetIds")', orchestrator)
        self.assertIn('member.role !== "supplier_child"', settings)
        self.assertIn("<th>账号</th><th>发布标题</th>", analytics)

    def test_v84_assets_delivery_and_stable_first_render(self):
        assets = (APP_DIR / "js/views/assetsView.js").read_text(encoding="utf-8")
        delivery = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        analytics = (APP_DIR / "js/views/analyticsView.js").read_text(encoding="utf-8")
        voice = (APP_DIR / "js/views/voiceLab.js").read_text(encoding="utf-8")
        self.assertIn('["图片", "视频"].includes(a.type)', assets)
        self.assertIn("exportAndPurgeAccountFiles", assets)
        self.assertIn("await removeAsset(a.id)", assets)
        self.assertNotIn("data-dtab", delivery)
        self.assertIn('data-creator-select="account"', delivery)
        self.assertNotIn("lastDeliveryRemotePullAt", delivery)
        self.assertNotIn("lastAnalyticsRemotePullAt", analytics)
        self.assertNotIn("ensureProviderStatus(stableRerender)", voice)

    def test_global_bgm_and_editing_material_library_contract(self):
        assets_view = (APP_DIR / "js/views/assetsView.js").read_text(encoding="utf-8")
        cut = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        accounts = (APP_DIR / "js/domain/accounts.js").read_text(encoding="utf-8")
        self.assertIn('const isGlobalLibrary = () => ["bgm", "material"].includes(libraryMode)', assets_view)
        self.assertIn('searchAssets({ accountId: isGlobalLibrary() ? "all" : fAcc', assets_view)
        self.assertIn('isGlobalLibrary() ? "" : `<label class="select-shell account-select">', assets_view)
        self.assertIn("if (isGlobalLibrary()) return `<div class=\"asset-grid\">", assets_view)
        self.assertIn("globalBgmAssets()", cut)
        self.assertIn('optgroup label="共享 BGM 库"', cut)
        self.assertIn("addAssetFromFile(null, file", cut)
        self.assertIn("preservedGlobalAssets", accounts)

        script = r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
const { state } = await import('./js/core/store.js');
const { globalBgmAssets, isEditingMaterialAsset } = await import('./js/domain/assets.js');
state.assets = [
  { id:'bgm-other', type:'音频', tags:['BGM'], name:'跨账号共享曲', accountId:'another-account', createdAt:1 },
  { id:'voice', type:'音频', tags:['口播音频'], name:'口播', accountId:'current-account', createdAt:2 },
  { id:'material-other', type:'视频', tags:['剪辑素材'], name:'共享镜头', accountId:'another-account', createdAt:3 }
];
console.log(JSON.stringify({
  bgm: globalBgmAssets().map(item => item.id),
  material: isEditingMaterialAsset(state.assets[2])
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        self.assertEqual('{"bgm":["bgm-other"],"material":true}', result)

    def test_v84_subtitle_editor_review_and_dashboard_contract(self):
        cut = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        review = (APP_DIR / "js/views/chainCopy.js").read_text(encoding="utf-8")
        overview = (APP_DIR / "js/views/overview.js").read_text(encoding="utf-8")
        assets = (APP_DIR / "js/views/assetsView.js").read_text(encoding="utf-8")
        studio = (APP_DIR / "js/views/studio.js").read_text(encoding="utf-8")
        agent = (APP_DIR / "js/agent/view.js").read_text(encoding="utf-8")
        self.assertIn("const totalDur = () => Math.max(1, clipsTotal())", cut)
        self.assertIn("function splitSubtitle", cut)
        self.assertIn("function pasteSubtitle", cut)
        self.assertIn('id="tlSubSplit"', cut)
        self.assertIn("video-review-grid", review)
        self.assertIn("封面图", review)
        self.assertIn("overview-integrated", overview)
        self.assertIn('data-overview-detail="links"', overview)
        self.assertIn("overview-donut", overview)
        self.assertIn("overview-trend-line", overview)
        self.assertNotIn("data-dashboard-mode", overview)
        self.assertNotIn("analyticsView.render(host, { embedded: true })", overview)
        self.assertIn('data-library="drafts"', assets)
        self.assertIn('libraryMode = "drafts"', assets)
        self.assertNotIn("去发布清单", assets)
        self.assertIn('const showRoleRef = acc.mode === "视频" && acc.subType === "数字人"', studio)
        self.assertIn('data-sh-ref="role"', studio)
        self.assertIn('data-sh-ref="style"', studio)
        self.assertIn('id="agwNewPanel"', agent)

    def test_v84_manual_account_style_survives_seed_sync(self):
        main = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        dialog = (APP_DIR / "js/views/accountDialog.js").read_text(encoding="utf-8")
        index = (APP_DIR / "index.html").read_text(encoding="utf-8")
        self.assertIn("const preserveManualStyle = Boolean(acc.styleEditedAt)", main)
        self.assertIn("if (!preserveManualStyle)", main)
        self.assertIn("styleEditedAt: Date.now()", dialog)
        self.assertIn('const APP_BUILD_ID = "20260716-v87-2"', main)
        self.assertIn('js/main.js?v=20260716-v87-2', index)


if __name__ == "__main__":
    unittest.main()
