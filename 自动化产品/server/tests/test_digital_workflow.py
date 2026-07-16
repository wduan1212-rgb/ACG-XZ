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
        workshop = (APP_DIR / "js/views/chainWorkshop.js").read_text(encoding="utf-8")
        productions = (APP_DIR / "js/domain/productions.js").read_text(encoding="utf-8")
        self.assertIn('const usesEstimatedMaterialCaptions = () => !isDigitalHuman()', source)
        self.assertIn('mode: isDigitalHuman() ? "digital-human" : "info-flow"', source)
        self.assertIn("timedSpeechHintsForClip", source)
        self.assertIn("extractStructuredSpokenCues", source)
        self.assertIn("strict: usesEstimatedMaterialCaptions()", source)
        self.assertIn('subTimingSource = "audio-analysis-v6"', source)
        self.assertIn('subTimingSource = "prompt-timeline-v1"', source)
        self.assertIn('audioTimingSource = "prompt-timeline-fallback"', source)
        self.assertIn("promptTimelineCaptions", source)
        self.assertIn('source.startsWith("audio-analysis-")', source)
        self.assertIn("真实音轨未通过字幕校验", source)
        self.assertIn("audioDataUrl: audio.dataUrl", source)
        self.assertIn("audioTimingRevision", source)
        self.assertIn("timingAttemptIsCurrent", source)
        self.assertIn("clip.videoDuration = actual", source)
        self.assertNotIn("seg.audioDuration = actual", source)
        self.assertIn("invalidateDerivedMediaAfterDigitalAudioChange", workshop)
        self.assertIn("const audioSignature =", workshop)
        self.assertIn("audioAssetId: seg.audioAssetId", productions)
        self.assertIn("videoDuration:", productions)
        self.assertNotIn('subTimingSource = "estimated-material-v2"', source)
        self.assertNotIn("estimateInfoFlowCaptions", source)
        self.assertIn('s.text = e.target.value;\n      markCaptionTimingManual()', source)
        self.assertNotIn("script.shots?.[index]?.line", source)
        self.assertNotIn("任意引号", source)

    def test_infoflow_caption_hints_only_accept_explicit_spoken_source(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };
const m = await import('./js/views/chainCut.js');
const input = `0-3s 声音/台词：镜头快速推进，必须高级。
口播原话：“真正应该出现的口播”
3-6s 台词：这是导演占位文本
角色A说：“第二句真实对白”
3-6s 台词：字幕跟随口播精准出现
3-6s 声音/台词：不要使用机械播报感
3-6s 旁白：无字幕，不生成花字
随便引用“不要入字幕”`;
console.log(JSON.stringify(m.extractStructuredSpokenCues(input, 6)));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertEqual(json.loads(result.stdout.strip()), [
            {"text": "真正应该出现的口播", "start": 0, "end": 3},
            {"text": "第二句真实对白", "start": 3, "end": 6},
        ])

    def test_infoflow_caption_hints_accept_natural_quoted_speech_without_ui_copy(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };
const m = await import('./js/views/chainCut.js');
const input = `0-2s：输入框显示：“三个版本，下班前”，这里只是界面文字。
2-5s：他侧身躲闪，嘴角又急又无奈地说：“又压过来一摞，我还没理完上一摞。”
5-9s：角色扒开文件，喘了一口气说：“资料要看，步骤要拆，结果还要能交。”
9-12s：他皱着眉说：“三个版本，下班前。”
12-15s：角色把头靠在文件上，闷声说：“先别理了，让它先跑一版。”
禁止角色说：“这句是导演限制，不能成为字幕。”`;
console.log(JSON.stringify(m.extractStructuredSpokenCues(input, 15)));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertEqual(json.loads(result.stdout.strip()), [
            {"text": "又压过来一摞 我还没理完上一摞", "start": 2, "end": 5},
            {"text": "资料要看 步骤要拆 结果还要能交", "start": 5, "end": 9},
            {"text": "三个版本 下班前", "start": 9, "end": 12},
            {"text": "先别理了 让它先跑一版", "start": 12, "end": 15},
        ])

    def test_infoflow_prompt_timeline_accepts_local_or_global_segment_ranges(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };
const m = await import('./js/views/chainCut.js');
const local = `0-3s：台词：“今天就把这件事做完。”
3-7s：旁：“然后检查最终结果。”`;
const global = `15-18秒：台词：“今天就把这件事做完。”
18-22秒：旁：“然后检查最终结果。”`;
console.log(JSON.stringify({
  local: m.extractStructuredSpokenCues(local, 15),
  global: m.extractStructuredSpokenCues(global, 15)
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        data = json.loads(result.stdout.strip())
        expected = [
            {"text": "今天就把这件事做完", "start": 0, "end": 3},
            {"text": "然后检查最终结果", "start": 3, "end": 7},
        ]
        self.assertEqual(data["local"], expected)
        self.assertEqual(data["global"], expected)

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
        self.assertFalse((APP_DIR / "js/data/xhsAccountsSeed.js").exists())
        for path in (
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

    def test_cut_preview_disables_digital_human_audio_crossfade(self):
        source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles/views.css").read_text(encoding="utf-8")
        self.assertIn('id="cpVideoNext"', source)
        self.assertIn("const transition = 0", source)
        self.assertIn("transitionDuration: 0", source)
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

    def test_account_profile_seed_only_bootstraps_an_empty_account_store(self):
        main = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        dialog = (APP_DIR / "js/views/accountDialog.js").read_text(encoding="utf-8")
        index = (APP_DIR / "index.html").read_text(encoding="utf-8")
        self.assertIn("async function bootstrapAccountProfilesIfEmpty", main)
        self.assertIn("if ((state.accounts || []).length || state.ui.accountProfileVersion) return 0;", main)
        self.assertNotIn("cleanupNonSeedAccounts", main)
        self.assertNotIn("applyAccountProfileSeed", main)
        self.assertNotIn("preserveManualStyle", main)
        self.assertNotIn('remote.deleteDoc("accounts"', main)
        self.assertIn("styleEditedAt: Date.now()", dialog)
        self.assertIn('const APP_BUILD_ID = "20260717-v91-2"', main)
        self.assertIn('js/main.js?v=20260717-v91-2', index)

    def test_batch_reference_images_are_explicit_and_title_changes_refresh_copy(self):
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        view = (APP_DIR / "js/agent/view.js").read_text(encoding="utf-8")
        boards = (APP_DIR / "js/views/chainBoards.js").read_text(encoding="utf-8")

        image_refs = orchestrator.split("function imageRefGroupsFor", 1)[1].split("async function imageRefsForIds", 1)[0]
        self.assertNotIn("accountDefaultRefIds", image_refs)
        self.assertNotIn("imageStyleAssetId", image_refs)
        self.assertIn("it.refAssetIds = [...refGroups.all]", orchestrator)
        self.assertIn("function batchVideoRefIds", orchestrator)
        self.assertIn("if (!A.omniRefAssetIds.length && !p.batchId)", orchestrator)
        self.assertIn("!p.batchId ? A.sharedRefAssetId : null", orchestrator)
        self.assertIn("resetPlanReferences(payload)", view)
        self.assertIn("plan.sharedRefAssetIds = []", orchestrator)
        self.assertIn("plan.coverRefAssetIds = []", orchestrator)
        self.assertIn("plan.accountRefAssetIds = {}", orchestrator)

        self.assertIn("按标题生成正文与图卡提示词", boards)
        self.assertIn("const titleChanged = Boolean(previousGeneratedTitle && previousGeneratedTitle !== title)", boards)
        self.assertIn("const shouldGenerateBody = !body || titleChanged", boards)
        self.assertIn("if (shouldGenerateBody)", boards)
        self.assertIn("A.copyGeneratedForTitle = title", boards)

        script = r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
const { state } = await import('./js/core/store.js');
const { createProduction, buildMaterialUnits } = await import('./js/domain/productions.js');
const { createUnitVideoJobs } = await import('./js/agent/orchestrator.js?v=20260717-v91-2');
state.accounts = [{ id:'material-account', name:'素材号', mode:'视频', subType:'无数字人', platform:'视频号' }];
state.assets = [{ id:'old-hidden-ref', accountId:'material-account', type:'图片', name:'旧产品统一参考', tags:['统一参考','产品'] }];
state.productions = [];
state.jobs = [];
state.ui.currentMemberId = 'tester';
const p = createProduction({ accountId:'material-account', topic:'测试', batchId:'batch-1' });
p.artifacts.script.shots = [{ scene:1, idea:'演示', visual:'产品界面演示', line:'测试旁白', ui:true }];
p.artifacts.audio.perShot = [{ dur:5 }];
p.artifacts.audio.duration = 5;
const units = buildMaterialUnits(p);
units[0].videoPrompt = '9:16竖屏，5秒，展示产品界面。';
p.artifacts.boards.omniRefAssetIds = [];
p.artifacts.boards.sceneRefAssetIds = [];
createUnitVideoJobs(p);
console.log(JSON.stringify(state.jobs.map(job => job.refAssetIds)));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        self.assertEqual("[[]]", result)

    def test_placeholder_bgm_style_and_topic_pools_are_removed(self):
        prompts = (APP_DIR / "js/api/prompts.js").read_text(encoding="utf-8")
        ai = (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8")
        for stale in (
            "BGM_POOL",
            "STYLE_CHIP_BASE",
            "STYLE_POOL",
            "TOPIC_POOL",
            "轻快办公节拍",
            "一句话整理一周工作记录",
            "小红书种草风",
        ):
            self.assertNotIn(stale, prompts + ai)
        self.assertIn("PRODUCT_CATALOG_SEED", ai)
        self.assertIn("relatedProducts", ai)
        self.assertIn("account?.styleProfile || account?.lockedStyle", ai)


if __name__ == "__main__":
    unittest.main()
