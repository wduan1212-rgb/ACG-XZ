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

    def test_info_flow_subtitles_use_estimation_and_preserve_manual_track(self):
        source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        self.assertIn('if (isInfoFlow()) return estimateInfoFlowCaptions', source)
        self.assertIn('subTimingSource = "estimated-info-flow-v1"', source)
        self.assertIn('if (p.artifacts.subTimingSource === "manual") normalizeCaptionTrack()', source)
        self.assertIn('s.text = e.target.value;\n      p.artifacts.subTimingSource = "manual"', source)
        self.assertIn('只有明确标注为', source)
        self.assertNotIn('const promptLine = cleanEstimatedCaption(captionTextForClip', source)
        self.assertNotIn('const segmentLine = cleanEstimatedCaption(segment.caption', source)

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


if __name__ == "__main__":
    unittest.main()
