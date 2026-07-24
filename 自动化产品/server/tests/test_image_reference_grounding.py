import asyncio
import importlib
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch


SERVER_DIR = Path(__file__).resolve().parents[1]
APP_DIR = SERVER_DIR.parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

main = importlib.import_module("main")


class JsonLlmResponse:
    status_code = 200

    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return {
            "model": "MiniMax-M3",
            "usage": {"prompt_tokens": 10, "completion_tokens": 6, "total_tokens": 16},
            "choices": [{"message": {"content": json.dumps(self.payload, ensure_ascii=False)}}],
        }


class ImageReferenceGroundingTest(unittest.TestCase):
    member = {"id": "creator-a", "name": "创作者", "role": "editor"}

    def _refs(self):
        # The server file-read and compacting boundaries are mocked below.  The
        # data URL still exercises the client/server request contract without
        # sending a real attachment or model request.
        return [
            main.ImageRef(id="logo", name="logo百度搭子", role="shared", dataUrl="data:image/png;base64,cG5n"),
            main.ImageRef(id="suite", name="自媒体套件", role="shared", dataUrl="data:image/png;base64,cG5n"),
            main.ImageRef(id="video", name="视频生成思考过程", role="shared", dataUrl="data:image/png;base64,cG5n"),
            main.ImageRef(id="home", name="主界面", role="shared", dataUrl="data:image/png;base64,cG5n"),
        ]

    def _collect_patch(self):
        async def collect(_client, refs):
            ref = refs[0]
            return [(f"{ref.name}.png", b"mock-png", "image/png")]
        return collect

    def test_ten_title_reference_copy_and_card_routing_rounds_use_m3_vision_fallback(self):
        cases = [
            ("这个桌面智能体我必须安利给所有人！都去试试！", "百度搭子的自媒体套件把主界面、视频生成思考和内容生产放在同一工作流里"),
            ("终于找到能把内容生产串起来的工具", "自媒体套件覆盖从创意梳理到视频生成的连续流程"),
            ("这套工作流让我少走很多弯路", "围绕百度搭子主界面中的自媒体套件说明真实使用路径"),
            ("做内容的人真的该看看这个", "用视频生成思考过程作为内容规划证据，再展示套件的衔接"),
            ("原来内容创作可以这样连起来", "百度搭子品牌下的自媒体套件串联图文与视频创作"),
            ("这不是又一个空泛的效率工具", "重点是自媒体套件中可见的内容生产与视频生成流程"),
            ("我的内容工作流终于顺了", "以百度搭子自媒体套件的主界面和创作流程为宣传主线"),
            ("想做自媒体的先把这条收好", "先讲套件如何把内容构思、界面操作和视频生成连成闭环"),
            ("一个套件把我常用的创作步骤收住了", "以自媒体套件及其视频生成思考过程解释核心价值"),
            ("这次安利的不是泛泛的桌面工具", "明确宣传百度搭子的自媒体套件及其真实创作流程"),
        ]
        refs = self._refs()
        cards = [
            main.ImageReferencePlanCard(index=index, title=f"图{index + 1}", prompt=f"围绕第{index + 1}个信息点展开")
            for index in range(4)
        ]
        with patch.object(main, "LLM_API_KEY", "test-key"), patch.object(main, "LLM_MODEL", "MiniMax-M3"), patch.object(main, "LLM_VISION_MODEL", ""), patch.object(main, "_collect_image_ref_files", new=self._collect_patch()), patch.object(main, "_compact_image_ref_files", side_effect=lambda files: (files, 0)), patch.object(main, "_record_llm_usage", Mock()):
            for round_index, (title, anchor) in enumerate(cases):
                with self.subTest(round=round_index + 1, stage="copy"):
                    with patch.object(main, "_call_llm", new=AsyncMock(return_value=JsonLlmResponse({"brief": anchor}))) as call_llm:
                        brief = asyncio.run(main.llm_image_copy_reference_brief(
                            main.ImageCopyReferenceBriefReq(title=title, refs=refs), self.member
                        ))
                    self.assertEqual("vision", brief["source"])
                    self.assertEqual("MiniMax-M3", brief["model"])
                    self.assertEqual(anchor, brief["brief"])
                    request_body = call_llm.await_args.args[0]
                    self.assertEqual("MiniMax-M3", request_body["model"])
                    self.assertEqual(5, len(request_body["messages"][1]["content"]))
                    self.assertIn("自媒体套件", request_body["messages"][1]["content"][0]["text"])

                assignments = [refs[(round_index + index) % len(refs)] for index in range(4)]
                plan_payload = {
                    "cards": [
                        {
                            "index": index,
                            "referenceIds": [ref.id],
                            "instruction": f"参考图「{ref.name}」完整放在本页中心主体区，旁侧保留本页文字层级。",
                        }
                        for index, ref in enumerate(assignments)
                    ]
                }
                with self.subTest(round=round_index + 1, stage="routing"):
                    with patch.object(main, "_call_llm", new=AsyncMock(return_value=JsonLlmResponse(plan_payload))) as call_llm:
                        plan = asyncio.run(main.llm_image_reference_plan(
                            main.ImageReferencePlanReq(title=title, body=f"正文主题锚点：{anchor}", cards=cards, refs=refs), self.member
                        ))
                    self.assertEqual("vision", plan["source"])
                    self.assertEqual(4, len(plan["cards"]))
                    for index, card in enumerate(plan["cards"]):
                        self.assertEqual([assignments[index].id], card["referenceIds"])
                        self.assertIn(assignments[index].name, card["instruction"])
                        self.assertRegex(card["instruction"], r"中心|上半部|右侧|左侧|主体")
                    request_body = call_llm.await_args.args[0]
                    self.assertEqual("MiniMax-M3", request_body["model"])
                    self.assertEqual(5, len(request_body["messages"][1]["content"]))

    def test_client_sequence_requires_real_reference_grounding_before_prompts(self):
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        ai = (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8")
        server = (SERVER_DIR / "main.py").read_text(encoding="utf-8")
        start = orchestrator.index("/* 图文的顺序必须固定为")
        end = orchestrator.index("    const sres = material", start)
        image_pipeline = orchestrator[start:end]
        self.assertLess(image_pipeline.index("prepareBatchImageCopyReferenceContext"), image_pipeline.index("AI.generateImageCopyFromTitle"))
        self.assertLess(image_pipeline.index("AI.generateImageCopyFromTitle"), image_pipeline.index("buildBatchCustomCopyShots"))
        self.assertLess(image_pipeline.index("buildBatchCustomCopyShots"), image_pipeline.index("prepareBatchImageReferencePlan"))
        self.assertLess(image_pipeline.index("prepareBatchImageReferencePlan"), image_pipeline.index("AI.generateImagePrompts"))
        self.assertIn("referencePlans: imageReferencePlan.cards", image_pipeline)
        self.assertIn("requireLlm: true", image_pipeline)
        self.assertNotIn("AI.generateScript", image_pipeline)
        self.assertIn("参考图未完成视觉识别，已停止生成", ai)
        self.assertIn("统一参考图未完成内容识别，已停止按标题生成泛化文案", ai)
        self.assertIn("if re.fullmatch(r\"minimax[\\s_-]*m3\"", server)
        self.assertIn("非 Logo 的截图、产品图、海报或文件图通常只应作为一张图的", server)


if __name__ == "__main__":
    unittest.main()
