import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import main, store


class LlmUsageStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "usage.sqlite"
        store._initialized = False

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def test_only_verified_usage_is_persisted_and_summarized(self):
        editor = store.add_member("创作者甲", "creator-a", "123456", "editor")
        self.assertFalse(store.record_llm_usage(editor[0], "创作者甲", "通用文案", "m3", {}))
        self.assertTrue(store.record_llm_usage(editor[0], "创作者甲", "通用文案", "m3", {
            "prompt_tokens": 120, "completion_tokens": 45, "total_tokens": 165,
        }))
        self.assertTrue(store.record_llm_usage(editor[0], "创作者甲", "成图文案", "vision", {
            "input_tokens": 30, "output_tokens": 20,
        }))

        row = next(item for item in store.llm_usage_summary() if item["memberId"] == editor[0])
        self.assertEqual(2, row["calls"])
        self.assertEqual(150, row["promptTokens"])
        self.assertEqual(65, row["completionTokens"])
        self.assertEqual(215, row["totalTokens"])

        details = store.llm_usage_details()
        by_api = {(item["feature"], item["model"]): item for item in details["apiRows"]}
        self.assertEqual(165, by_api[("通用文案", "m3")]["totalTokens"])
        self.assertEqual(50, by_api[("成图文案", "vision")]["totalTokens"])
        self.assertEqual(2, len(details["events"]))
        self.assertEqual("成图文案", details["events"][0]["feature"])

    def test_image_and_video_are_recorded_as_successful_calls_not_fake_tokens(self):
        editor = store.add_member("创作者乙", "creator-b", "123456", "editor")
        self.assertTrue(store.record_api_usage(editor[0], "创作者乙", "image", "图片生成", "image-model-a", 1, "张"))
        self.assertTrue(store.record_api_usage(editor[0], "创作者乙", "video", "视频生成", "video-model-b", 1, "任务"))
        self.assertFalse(store.record_api_usage(editor[0], "创作者乙", "image", "图片生成", "image-model-a", 0, "张"))

        row = next(item for item in store.model_usage_summary() if item["memberId"] == editor[0])
        self.assertEqual(0, row["totalTokens"])
        self.assertEqual(1, row["imageCalls"])
        self.assertEqual(1, row["imageOutputs"])
        self.assertEqual(1, row["videoCalls"])
        self.assertEqual(1, row["videoOutputs"])

        details = store.model_usage_details(member_id=editor[0])
        by_model = {(item["feature"], item["model"]): item for item in details["assetApiRows"]}
        self.assertEqual(1, by_model[("图片生成", "image-model-a")]["outputUnits"])
        self.assertEqual("张", by_model[("图片生成", "image-model-a")]["unitLabel"])
        self.assertEqual(1, by_model[("视频生成", "video-model-b")]["outputUnits"])
        self.assertEqual(2, len(details["assetEvents"]))

    def test_recording_failure_cannot_break_a_model_response(self):
        member = {"id": "editor-1", "name": "创作者甲"}
        with patch.object(main.store, "record_llm_usage", side_effect=RuntimeError("db busy")):
            main._record_llm_usage(member, {"model": "m3", "usage": {"total_tokens": 8}}, "通用文案")

    def test_reference_planner_never_turns_visual_attachment_into_long_prompt_copy(self):
        self.assertEqual({}, main._image_reference_plan_json("not json"))
        self.assertEqual("附件1放在右侧", main._clean_reference_instruction("  附件1放在右侧  "))
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn('/api/llm/image-reference-plan', source)
        self.assertIn("不要详细复述附件里的颜色、物体、人物或文字", source)
        self.assertIn('_record_model_api_usage(member, "image", "图片生成"', source)
        self.assertIn('_record_model_api_usage(_me, "video", "视频生成"', source)


if __name__ == "__main__":
    unittest.main()
